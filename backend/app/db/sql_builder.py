"""SQL query builder: translate QueryDef into parameterized SQL.

All user-supplied values are bound via ``?`` placeholders (never string
interpolated). Identifiers that are not plain alphanumeric names are
double-quoted (bracket-quoted for Jet/ACE-family drivers) and internal
quotes are escaped.
"""
import re

import pyodbc

DEFAULT_LIMIT = 1000
MAX_LIMIT = 100000

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$#]*$")

_COMPARISON_OPS = {
    "eq": "=",
    "ne": "<>",
    "gt": ">",
    "ge": ">=",
    "lt": "<",
    "le": "<=",
    # The UI sends symbol operators directly.
    "=": "=",
    "!=": "<>",
    "<>": "<>",
    ">": ">",
    ">=": ">=",
    "<": "<",
    "<=": "<=",
}

# DBMS names (SQLGetInfo SQL_DBMS_NAME) whose drivers are Jet/ACE-like and
# require "SELECT TOP n" + bracket quoting: Access, Excel, Text, dBASE.
_JET_DBMS_MARKERS = ("text", "access", "excel", "dbase", "xbase")


def _is_jet_like(dbms: str | None) -> bool:
    return any(m in (dbms or "").lower() for m in _JET_DBMS_MARKERS)


_DBMS_TYPE_MAP = {
    "sqlserver": "Microsoft SQL Server",
    "oracle": "Oracle",
    "mysql": "MySQL",
    "postgresql": "PostgreSQL",
    "jet": "Microsoft Access",
}


def resolve_dbms(connection: dict, detected: str | None = None) -> str | None:
    """Resolve the effective DBMS name for SQL generation.

    ``connection["database_type"]`` (a user-selected slug such as ``"oracle"``)
    takes precedence over the driver-reported name. When unset / ``"auto"`` /
    ``"other"`` (or an unknown slug), the detected name is returned as-is.
    """
    db_type = (connection.get("database_type") or "auto").lower()
    if db_type in ("", "auto", "other"):
        return detected
    return _DBMS_TYPE_MAP.get(db_type)


def _quote_identifier(name: str, bracket: bool = False) -> str:
    """Quote an identifier only when it is not a plain SQL name.

    ``bracket`` selects ``[name]`` quoting for Jet/ACE-family drivers; plain
    ANSI double quotes are used everywhere else.
    """
    if _IDENTIFIER_RE.match(name):
        return name
    if bracket:
        return "[" + name.replace("]", "]]") + "]"
    return '"' + name.replace('"', '""') + '"'


def build_select(query: dict, dbms: str | None = None) -> tuple[str, list]:
    """Build a parameterized SELECT statement from a query definition.

    Returns ``(sql, params)``. The query dict supports:
      - table (required)
      - columns: list of column names, or empty/omitted for ``*``
      - derived_columns: [{name, expression}] appended as ``expression AS name``
      - filters: [{column, operator, value}]
      - date_column / date_from / date_to: optional date-range filter
      - limit: row cap (default DEFAULT_LIMIT, capped at MAX_LIMIT)
    """
    jet_like = _is_jet_like(dbms)
    quote = lambda name: _quote_identifier(name, bracket=jet_like)  # noqa: E731

    table = quote(str(query.get("table") or ""))

    columns = query.get("columns") or []
    if columns:
        col_sql = ", ".join(quote(str(c)) for c in columns)
    else:
        col_sql = "*"

    # Derived/calculated columns: append ``expression AS alias`` to the SELECT
    # list. The expression is raw SQL (evaluated by the database), while the
    # alias is quoted like any other identifier.
    derived_sql = []
    for dc in query.get("derived_columns") or []:
        if isinstance(dc, dict):
            dname = str(dc.get("name") or "").strip()
            dexpr = str(dc.get("expression") or "").strip()
        else:
            dname = str(getattr(dc, "name", "") or "").strip()
            dexpr = str(getattr(dc, "expression", "") or "").strip()
        if dname and dexpr:
            derived_sql.append(f"{dexpr} AS {quote(dname)}")
    if derived_sql:
        col_sql = (col_sql + ", " if col_sql != "*" else "* , ") + ", ".join(derived_sql)

    where_clauses: list[str] = []
    params: list = []

    for f in query.get("filters") or []:
        col = str(f.get("column") or "")
        op = str(f.get("operator") or "")
        value = f.get("value")
        qcol = quote(col)
        if op in _COMPARISON_OPS:
            where_clauses.append(f"{qcol} {_COMPARISON_OPS[op]} ?")
            params.append(value)
        elif op in ("contains",):
            where_clauses.append(f"{qcol} LIKE ?")
            params.append(f"%{value}%")
        elif op in ("starts", "starts_with"):
            where_clauses.append(f"{qcol} LIKE ?")
            params.append(f"{value}%")
        elif op in ("ends", "ends_with"):
            where_clauses.append(f"{qcol} LIKE ?")
            params.append(f"%{value}")
        elif op == "in":
            if isinstance(value, (list, tuple)):
                parts = [str(p) for p in value]
            else:
                parts = [p.strip() for p in str(value or "").split(",") if p.strip()]
            if not parts:
                raise ValueError(f"Filter 'in' for column '{col}' needs at least one value")
            placeholders = ", ".join("?" for _ in parts)
            where_clauses.append(f"{qcol} IN ({placeholders})")
            params.extend(parts)
        elif op in ("null", "is null"):
            where_clauses.append(f"{qcol} IS NULL")
        elif op in ("notnull", "is not null"):
            where_clauses.append(f"{qcol} IS NOT NULL")
        else:
            raise ValueError(f"Unsupported filter operator: '{op}'")

    date_column = query.get("date_column")
    date_from = query.get("date_from")
    date_to = query.get("date_to")
    if date_column and (date_from is not None or date_to is not None):
        qcol = quote(str(date_column))
        if date_from is not None and date_to is not None:
            where_clauses.append(f"{qcol} BETWEEN ? AND ?")
            params.extend([date_from, date_to])
        elif date_from is not None:
            where_clauses.append(f"{qcol} >= ?")
            params.append(date_from)
        else:
            where_clauses.append(f"{qcol} <= ?")
            params.append(date_to)

    sql = f"SELECT {col_sql} FROM {table}"
    if where_clauses:
        sql += " WHERE " + " AND ".join(where_clauses)

    limit = query.get("limit")
    if limit is None:
        limit = DEFAULT_LIMIT
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    limit = max(1, min(limit, MAX_LIMIT))

    db = (dbms or "").lower()
    if "sql server" in db or "sqlserver" in db.replace(" ", ""):
        # TOP must immediately follow SELECT.
        sql = sql.replace("SELECT ", f"SELECT TOP {limit} ", 1)
    elif "oracle" in db:
        sql += f" FETCH FIRST {limit} ROWS ONLY"
    elif jet_like:
        # Jet/ACE drivers (Access, Excel, Text, dBASE) support TOP, not LIMIT.
        sql = sql.replace("SELECT ", f"SELECT TOP {limit} ", 1)
    else:
        sql += f" LIMIT {limit}"

    return sql, params


def detect_dbms(conn: dict) -> str | None:
    """Return the DBMS product name reported by the driver, if reachable.

    Uses ``Connection.getinfo(pyodbc.SQL_DBMS_NAME)`` — the ``getinfo`` method
    lives on the connection, not the cursor. The connection probe is bounded by
    a short timeout so a page refresh never hangs on an unreachable server.
    """
    try:
        from app.db.odbc import open_connection

        cnxn = open_connection(conn, timeout=3)
        try:
            return str(cnxn.getinfo(pyodbc.SQL_DBMS_NAME))
        finally:
            cnxn.close()
    except Exception:
        return None
