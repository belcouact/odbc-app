"""Azure Databricks connectivity via the ``databricks-sql-connector`` package.

The rest of the app reaches databases through :mod:`app.db.odbc`, which uses
pyodbc. Databricks speaks its own HTTP/Thrift protocol rather than ODBC, so
:mod:`app.db.odbc` routes ``databricks``-type connections here. Every public
function mirrors its ODBC counterpart so the two modules are interchangeable.

The connector raises its own exception hierarchy, but the API layer catches
``pyodbc.Error`` and turns it into a friendly HTTP 400. Those exceptions are
therefore translated into :class:`pyodbc.Error` so a failed Databricks
connection reports "Connection failed" instead of an HTTP 500.
"""
import json
import pyodbc

from app import keystore
from app.db import odbc

CONNECT_TIMEOUT = odbc.CONNECT_TIMEOUT

_INSTALL_HINT = (
    "databricks-sql-connector is not installed. "
    "Run: pip install databricks-sql-connector"
)

_OAUTH_CLOSE_PAGE_PATCHED = False


def _auto_close_oauth_tab() -> None:
    """Make the connector's OAuth callback tab close itself.

    After the browser redirects back to the local callback, the connector
    serves a static "Please close this tab." page. That tab was opened by the
    OS browser and has a single history entry (the auth URL is one navigation
    that only HTTP-redirects), so it is script-closable — overriding the page
    with a self-closing script removes both the page and the manual step.
    Best-effort: if the connector's internals change we keep its default page.
    """
    global _OAUTH_CLOSE_PAGE_PATCHED
    if _OAUTH_CLOSE_PAGE_PATCHED:
        return
    _OAUTH_CLOSE_PAGE_PATCHED = True
    try:
        from databricks.sql.auth.oauth_http_handler import (  # noqa: PLC0415
            OAuthHttpSingleRequestHandler,
        )

        OAuthHttpSingleRequestHandler.RESPONSE_BODY_TEMPLATE = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<title>Signed in</title></head><body>"
            "<p>Signed in — you can close this tab.</p>"
            "<script>window.close();</script>"
            "</body></html>"
        )
    except Exception:  # noqa: BLE001 - cosmetic; keep the default page on failure
        pass


class _KeyringOAuthPersistence:
    """Persist Databricks OAuth tokens in the OS keyring, keyed by host.

    The connector keeps U2M OAuth tokens in memory only unless a persistence
    store is supplied, so every new connection (each test, each page refresh)
    re-opened the browser for interactive sign-in. Persisting the refresh token
    means the browser window only appears for the first sign-in — or later,
    once the refresh token itself expires — while still using OAuth. Secrets go
    to the OS credential store, never to a plaintext file.
    """

    @staticmethod
    def _account(hostname: str) -> str:
        return f"databricks-oauth:{hostname}"

    def read(self, hostname: str):
        raw = keystore.get_secret(self._account(hostname))
        if not raw:
            return None
        try:
            data = json.loads(raw)
            access_token = data.get("access_token")
            refresh_token = data.get("refresh_token")
        except (ValueError, AttributeError):
            return None
        if not access_token:
            return None
        from databricks.sql.experimental.oauth_persistence import OAuthToken  # noqa: PLC0415

        return OAuthToken(access_token, refresh_token)

    def persist(self, hostname: str, oauth_token) -> None:
        try:
            keystore.set_secret(
                self._account(hostname),
                json.dumps(
                    {
                        "access_token": oauth_token.access_token,
                        "refresh_token": oauth_token.refresh_token,
                    }
                ),
            )
        except Exception:  # noqa: BLE001 - best-effort: a miss just means re-login
            pass


_OAUTH_PERSISTENCE = _KeyringOAuthPersistence()


def _load_driver():
    """Import the connector lazily so the app works without it installed."""
    try:
        from databricks import sql  # noqa: PLC0415 - lazy import
    except ImportError as exc:
        raise pyodbc.Error("databricks", _INSTALL_HINT) from exc
    _auto_close_oauth_tab()
    return sql


def _parse_query_tags(raw) -> dict:
    """Parse ``"tag1:value1,tag2:value2"`` into a ``{tag: value}`` dict."""
    if not raw:
        return {}
    if isinstance(raw, dict):
        return {str(key): str(value) for key, value in raw.items()}
    tags: dict[str, str] = {}
    for pair in str(raw).split(","):
        if ":" not in pair:
            continue
        key, _, value = pair.partition(":")
        key = key.strip()
        if key:
            tags[key] = value.strip()
    return tags


def _error_message(exc: BaseException) -> str:
    """Return a readable one-line message for a connector error."""
    return str(exc) or exc.__class__.__name__


def _as_pyodbc_error(exc: BaseException) -> pyodbc.Error:
    """Wrap a connector error so the API layer still returns HTTP 400."""
    return pyodbc.Error("databricks", _error_message(exc))


def _params(params: list | None):
    """Normalize query parameters for ``cursor.execute`` (None when empty)."""
    if not params:
        return None
    return list(params)


def _connect(conn: dict, timeout: int | None = None):
    """Open a Databricks SQL connection from a stored connection dict.

    ``timeout`` exists only to match :func:`app.db.odbc.open_connection`'s
    signature; the connector's socket timeout is left at its default so long
    queries are not cut off.
    """
    sql = _load_driver()
    host = (conn.get("server_hostname") or "").strip()
    http_path = (conn.get("http_path") or "").strip()
    token = (conn.get("password") or "").strip()
    if not host:
        raise pyodbc.Error("databricks", "Server Hostname is required.")
    if not http_path:
        raise pyodbc.Error("databricks", "HTTP Path is required.")
    kwargs = {
        "server_hostname": host,
        "http_path": http_path,
        "access_token": token or None,
    }
    if not token:
        # No personal access token: the connector falls back to interactive
        # (browser) OAuth. Hand it a persistent token store so the login window
        # is only shown when there is no cached token, not on every connect.
        kwargs["experimental_oauth_persistence"] = _OAUTH_PERSISTENCE
    catalog = (conn.get("default_catalog") or "").strip()
    if catalog:
        kwargs["catalog"] = catalog
    schema = (conn.get("database") or "").strip()
    if schema:
        kwargs["schema"] = schema
    tags = _parse_query_tags(conn.get("query_tags"))
    if tags:
        kwargs["query_tags"] = tags
    try:
        return sql.connect(**kwargs)
    except Exception as exc:  # noqa: BLE001 - reported as a pyodbc error
        raise _as_pyodbc_error(exc) from exc


def open_connection(conn: dict, timeout: int | None = None):
    """Open a Databricks connection (caller is responsible for closing it)."""
    return _connect(conn, timeout)


def test_connection(conn: dict) -> tuple[bool, str]:
    """Try to connect and run a trivial probe query; return ``(ok, message)``."""
    try:
        cnxn = _connect(conn)
        try:
            cursor = cnxn.cursor()
            cursor.execute("SELECT 1")
            cursor.fetchone()
        finally:
            cnxn.close()
        return True, "Connection successful"
    except Exception as exc:  # noqa: BLE001 - any failure is reported as a message
        return False, odbc._clean_error_message(_error_message(exc))


def _name_column_index(description, kind: str) -> int:
    """Locate the name column in a ``SHOW TABLES`` / ``SHOW VIEWS`` result."""
    if not description:
        return 1
    wanted = {"tablename", "table_name", "viewname", "view_name", "name", kind}
    for index, column in enumerate(description):
        label = str(column[0]).strip().lower().replace(" ", "_")
        if label in wanted:
            return index
    # SHOW TABLES / SHOW VIEWS return (database, tableName/viewName, isTemporary).
    return 1 if len(description) > 1 else 0


def list_tables(conn: dict) -> list[dict]:
    """List tables and views in the connection's current catalog/schema."""
    tables: list[dict] = []
    cnxn = _connect(conn)
    try:
        cursor = cnxn.cursor()
        for statement, kind in (("SHOW TABLES", "table"), ("SHOW VIEWS", "view")):
            try:
                cursor.execute(statement)
            except Exception:  # noqa: BLE001 - e.g. views unsupported: skip
                continue
            index = _name_column_index(cursor.description, kind)
            for row in cursor.fetchall():
                if not row:
                    continue
                name = row[index] if len(row) > index else row[-1]
                if name:
                    tables.append({"name": str(name), "type": kind})
    except pyodbc.Error:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _as_pyodbc_error(exc) from exc
    finally:
        cnxn.close()

    seen = set()
    unique = []
    for table in tables:
        key = (table["name"], table["type"])
        if key not in seen:
            seen.add(key)
            unique.append(table)
    unique.sort(key=lambda t: t["name"].lower())
    return unique


def _quote_identifier(name: str) -> str:
    """Backtick-quote a Databricks identifier (escaping embedded backticks)."""
    return "`" + name.replace("`", "``") + "`"


def _describe_indices(description) -> tuple[int, int]:
    """Locate the ``col_name`` / ``data_type`` columns of a ``DESCRIBE TABLE``."""
    name_index, type_index = 0, 1
    if description:
        for index, column in enumerate(description):
            label = str(column[0]).strip().lower().replace(" ", "_")
            if label in ("col_name", "column_name", "name"):
                name_index = index
            elif label in ("data_type", "datatype", "type"):
                type_index = index
    return name_index, type_index


def list_columns(conn: dict, table: str) -> list[dict]:
    """List columns for a table (if the name is qualified, use the last segment)."""
    table_name = table.split(".")[-1] if "." in table else table
    columns: list[dict] = []
    cnxn = _connect(conn)
    try:
        cursor = cnxn.cursor()
        cursor.execute(f"DESCRIBE TABLE {_quote_identifier(table_name)}")
        name_index, type_index = _describe_indices(cursor.description)
        for row in cursor.fetchall():
            name = str(row[name_index]).strip() if row[name_index] is not None else ""
            # DESCRIBE lists partition metadata after a blank row / "# ..." header.
            if not name or name.startswith("#"):
                break
            data_type = ""
            if len(row) > type_index and row[type_index] is not None:
                data_type = str(row[type_index]).strip()
            columns.append({"name": name, "data_type": data_type, "nullable": True})
    except pyodbc.Error:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _as_pyodbc_error(exc) from exc
    finally:
        cnxn.close()
    return columns


def run_query(
    conn: dict,
    sql: str,
    params: list | None = None,
    row_cap: int | None = None,
) -> tuple[list[dict], list[tuple]]:
    """Execute ``sql`` and return ``(rows, col_types)`` (see :mod:`app.db.odbc`)."""
    cnxn = _connect(conn)
    try:
        cursor = cnxn.cursor()
        cursor.execute(sql, _params(params))
        if cursor.description is None:
            return [], []
        columns = [(d[0], d[1]) for d in cursor.description]
        rows = []
        if row_cap is None:
            for record in cursor.fetchall():
                rows.append(
                    {col[0]: odbc._normalize_value(value) for col, value in zip(columns, record)}
                )
        else:
            while len(rows) < row_cap:
                batch = cursor.fetchmany(500)
                if not batch:
                    break
                for record in batch:
                    rows.append(
                        {col[0]: odbc._normalize_value(value) for col, value in zip(columns, record)}
                    )
                    if len(rows) >= row_cap:
                        break
        return rows, columns
    except pyodbc.Error:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _as_pyodbc_error(exc) from exc
    finally:
        cnxn.close()


def iter_query(
    conn: dict,
    sql: str,
    params: list | None = None,
    row_cap: int | None = None,
    batch_size: int = 1000,
    run_id: str | None = None,
):
    """Stream query results, mirroring :func:`app.db.odbc.iter_query`.

    Yields ``("progress", rows_fetched_so_far, col_types)`` after each batch,
    then ``("done", rows, col_types)``.
    """
    cnxn = _connect(conn)
    try:
        cursor = cnxn.cursor()
        if run_id:
            odbc.register_run(run_id, cursor)
        cursor.execute(sql, _params(params))
        if cursor.description is None:
            yield "done", [], []
            return
        columns = [(d[0], d[1]) for d in cursor.description]
        rows = []
        cap = row_cap
        while cap is None or len(rows) < cap:
            batch = cursor.fetchmany(cap - len(rows) if cap is not None else batch_size)
            if not batch:
                break
            for record in batch:
                rows.append(
                    {col[0]: odbc._normalize_value(value) for col, value in zip(columns, record)}
                )
                if cap is not None and len(rows) >= cap:
                    break
            yield "progress", len(rows), columns
        yield "done", rows, columns
    except pyodbc.Error:
        raise
    except Exception as exc:  # noqa: BLE001 - GeneratorExit is BaseException, not caught
        raise _as_pyodbc_error(exc) from exc
    finally:
        if run_id:
            odbc.unregister_run(run_id)
        cnxn.close()


def iter_query_batches(
    conn: dict,
    sql: str,
    params: list | None = None,
    row_cap: int | None = None,
    batch_size: int = 5000,
    run_id: str | None = None,
):
    """Stream query results as row batches, mirroring :func:`app.db.odbc.iter_query_batches`.

    Yields ``("batch", rows, col_types)`` per fetched batch, then
    ``("done", total_rows, col_types)``.
    """
    cnxn = _connect(conn)
    try:
        cursor = cnxn.cursor()
        try:
            cursor.arraysize = batch_size
        except Exception:  # noqa: BLE001 - optional driver tuning
            pass
        if run_id:
            odbc.register_run(run_id, cursor)
        cursor.execute(sql, _params(params))
        if cursor.description is None:
            yield "done", 0, []
            return
        columns = [(d[0], d[1]) for d in cursor.description]
        total = 0
        cap = row_cap
        while cap is None or total < cap:
            size = batch_size if cap is None else min(batch_size, cap - total)
            batch = cursor.fetchmany(size)
            if not batch:
                break
            rows = []
            for record in batch:
                rows.append(
                    {col[0]: odbc._normalize_value(value) for col, value in zip(columns, record)}
                )
                total += 1
                if cap is not None and total >= cap:
                    break
            yield "batch", rows, columns
        yield "done", total, columns
    except pyodbc.Error:
        raise
    except Exception as exc:  # noqa: BLE001 - GeneratorExit is BaseException, not caught
        raise _as_pyodbc_error(exc) from exc
    finally:
        if run_id:
            odbc.unregister_run(run_id)
        cnxn.close()
