"""SQL query builder: translate QueryDef into parameterized SQL.

User-supplied values are bound via ``?`` placeholders (never string
interpolated); the only exception is the Jet/ACE date literal (``#...#``,
see ``jet_date_literal``), where the inlined value is strictly re-validated
against a fixed timestamp pattern. Identifiers that are not plain
alphanumeric names are double-quoted (bracket-quoted for Jet/ACE-family
drivers) and internal quotes are escaped.
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


# Canonical DBMS product names keyed by driver-name / DLL markers (checked in
# order). Windows ODBC DSNs store the driver as a DLL path (e.g. SQLSRV32.dll),
# so both the friendly name and the common DLL name are matched. Markers are
# lowercase because they are matched against a lowercased driver string.
_DRIVER_DBMS_MARKERS = (
    ("sql server", "Microsoft SQL Server"),
    ("sqlsrv32", "Microsoft SQL Server"),
    ("sqlncli", "Microsoft SQL Server"),
    ("msodbcsql", "Microsoft SQL Server"),
    ("oracle", "Oracle"),
    ("sqora", "Oracle"),
    ("msorcl", "Oracle"),
    ("mysql", "MySQL"),
    ("myodbc", "MySQL"),
    ("postgresql", "PostgreSQL"),
    ("psqlodbc", "PostgreSQL"),
    ("podbc", "PostgreSQL"),
)
_JET_MARKERS = ("access", "excel", "dbase", "xbase", "text")


_DBMS_TYPE_MAP = {
    "sqlserver": "Microsoft SQL Server",
    "oracle": "Oracle",
    "mysql": "MySQL",
    "postgresql": "PostgreSQL",
    "jet": "Microsoft Access",
    "databricks": "Databricks",
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


# Date/datetime columns cannot be compared to a bare string bind on every
# server, so the WHERE clause differs per DBMS family:
#   - Oracle: DATE/TIMESTAMP columns need TO_DATE(); the ODBC driver hands
#     Oracle a VARCHAR which it implicitly casts using NLS_DATE_FORMAT, so a
#     bare 'YYYY-MM-DD' string raises ORA-01861.
#   - Jet/ACE (Access): a text bind against a Date/Time column raises
#     "Data type mismatch in criteria expression" (-3030); the accepted form
#     is the '#YYYY-MM-DD HH:MM:SS#' date literal.
#   - Everything else binds the value as-is.
# Inputs arrive from the date / datetime-local pickers as 'YYYY-MM-DD' or
# 'YYYY-MM-DDTHH:MM', so a fixed timestamp mask is used.
ORACLE_DATE_MASK = "YYYY-MM-DD HH24:MI:SS"

# A fully normalised timestamp is the only value allowed to be inlined as a
# Jet date literal (guards against SQL injection through the date field).
_JET_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")


def date_dialect_for(dbms: str | None) -> str:
    """Map a DBMS name to its date-literal dialect: 'oracle' | 'jet' | 'plain'."""
    db = (dbms or "").lower()
    if "oracle" in db:
        return "oracle"
    if _is_jet_like(dbms):
        return "jet"
    return "plain"


def normalize_date_value(raw: object) -> str:
    """Normalise a date/datetime input to a full 'YYYY-MM-DD HH:MM:SS' value."""
    text = str(raw).strip().replace("T", " ")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text + " 00:00:00"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", text):
        return text + ":00"
    return text


def oracle_to_date_bind() -> str:
    """A bound parameter wrapped in Oracle TO_DATE(), for the fixed mask."""
    return f"TO_DATE(?, '{ORACLE_DATE_MASK}')"


def jet_date_literal(raw: object) -> str | None:
    """A Jet '#YYYY-MM-DD HH:MM:SS#' literal, or None when not safely inlinable.

    Only a strictly normalised timestamp is accepted, so the inlined value
    cannot carry any extra SQL.
    """
    norm = normalize_date_value(raw)
    return f"#{norm}#" if _JET_TIMESTAMP_RE.match(norm) else None


def date_value_fragment(dialect: str, raw: object) -> tuple[str, object | None]:
    """Return ``(sql_fragment, bound_value)`` for one date criterion.

    ``bound_value`` is None when the value was inlined (Jet literal) and must
    therefore not be added to the parameter list.
    """
    if dialect == "oracle":
        return oracle_to_date_bind(), normalize_date_value(raw)
    if dialect == "jet":
        literal = jet_date_literal(raw)
        if literal is not None:
            return literal, None
        # Unrecognised input: fall back to a plain bind rather than inlining.
        return "?", raw
    return "?", raw


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
        # Oracle needs TO_DATE(), Access/Jet needs a '#...#' literal; other
        # servers bind the value plainly. See date_value_fragment().
        dialect = date_dialect_for(dbms)
        # A None bound_value means the value was inlined, so no parameter is
        # bound for that fragment.
        if date_from is not None and date_to is not None:
            from_frag, from_val = date_value_fragment(dialect, date_from)
            to_frag, to_val = date_value_fragment(dialect, date_to)
            params.extend(v for v in (from_val, to_val) if v is not None)
            where_clauses.append(f"{qcol} BETWEEN {from_frag} AND {to_frag}")
        elif date_from is not None:
            frag, val = date_value_fragment(dialect, date_from)
            if val is not None:
                params.append(val)
            where_clauses.append(f"{qcol} >= {frag}")
        else:
            frag, val = date_value_fragment(dialect, date_to)
            if val is not None:
                params.append(val)
            where_clauses.append(f"{qcol} <= {frag}")

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


def _registry_dsn_driver(dsn: str) -> str | None:
    """Look up the ODBC driver a DSN is registered with (fast, no connection)."""
    if not dsn:
        return None
    try:
        import winreg  # noqa: PLC0415 - Windows-only module
    except ImportError:
        return None
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for base in (r"SOFTWARE\ODBC\ODBC.INI", r"SOFTWARE\WOW6432Node\ODBC\ODBC.INI"):
            try:
                with winreg.OpenKey(hive, base + "\\" + dsn) as key:
                    value, _ = winreg.QueryValueEx(key, "Driver")
                    return str(value)
            except OSError:
                continue
    return None


def _dbms_from_driver(driver: str | None) -> str | None:
    """Map an ODBC driver name or registered DLL path to a DBMS product name."""
    if not driver:
        return None
    text = driver.lower()
    if any(m in text for m in _JET_MARKERS):
        return "Microsoft Access"
    for marker, dbms in _DRIVER_DBMS_MARKERS:
        if marker in text:
            return dbms
    return None


def dbms_from_hints(conn: dict) -> str | None:
    """Resolve the DBMS from connection metadata without opening a connection.

    Tries the stored driver, then the DSN's registered Windows driver, then the
    connection string. Returns ``None`` when the driver is not recognised.
    """
    if conn.get("type") == "access":
        # Access-file connections always target the Microsoft Access/ACE engine.
        return "Microsoft Access"
    if conn.get("type") == "databricks":
        # Databricks connections are not ODBC; the product is known from the type.
        return "Databricks"
    hint = _dbms_from_driver(conn.get("driver"))
    if hint:
        return hint
    if conn.get("type") == "dsn":
        hint = _dbms_from_driver(_registry_dsn_driver(conn.get("dsn")))
        if hint:
            return hint
    return _dbms_from_driver(conn.get("connection_string"))


def detect_dbms(conn: dict) -> str | None:
    """Return the DBMS product name for a connection.

    Prefers the driver-reported ``SQL_DBMS_NAME``, but falls back to the offline
    driver / DSN hints when the server is unreachable or slow. The live probe is
    bounded by a short timeout and must never be the only source of truth:
    returning ``None`` for a reachable Oracle connection silently downgrades its
    date handling to a bare string bind, which raises ORA-01861.
    """
    if conn.get("type") == "databricks":
        # Not ODBC: SQL_DBMS_NAME is unavailable, and the product is known.
        return dbms_from_hints(conn)
    try:
        from app.db.odbc import open_connection

        cnxn = open_connection(conn, timeout=3)
        try:
            name = str(cnxn.getinfo(pyodbc.SQL_DBMS_NAME))
        finally:
            cnxn.close()
        if name:
            return name
    except Exception:
        pass
    return dbms_from_hints(conn)
