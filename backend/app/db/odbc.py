"""ODBC connection handling: connect, execute queries, and fetch schema.

Connections are always opened with ``autocommit=False`` and closed in a
``finally`` block. All values returned by :func:`run_query` are normalized to
plain JSON-friendly Python types.
"""
import datetime
import decimal
import os
import re
import sys
import threading
from typing import Iterator

import pyodbc

CONNECT_TIMEOUT = 10

# ---- Running-query registry (for cancellation) -------------------------------
# Maps a run id to the live cursor executing it so a cancel request from
# another thread can issue ODBC SQLCancel against the in-flight statement.
# Note: pyodbc's cancel API lives on Cursor (Connection has no cancel()).
_ACTIVE_RUNS: dict[str, "pyodbc.Cursor"] = {}
_ACTIVE_RUNS_LOCK = threading.Lock()


def register_run(run_id: str, cursor: "pyodbc.Cursor") -> None:
    """Track a cursor under ``run_id`` so it can be cancelled."""
    with _ACTIVE_RUNS_LOCK:
        _ACTIVE_RUNS[run_id] = cursor


def unregister_run(run_id: str) -> None:
    """Forget the cursor registered under ``run_id`` (run finished)."""
    with _ACTIVE_RUNS_LOCK:
        _ACTIVE_RUNS.pop(run_id, None)


def cancel_run(run_id: str) -> bool:
    """Cancel the in-flight statement of the run registered under ``run_id``.

    Returns ``False`` when the run is unknown (already finished or not yet
    started) or the driver rejects the cancel.
    """
    with _ACTIVE_RUNS_LOCK:
        cursor = _ACTIVE_RUNS.get(run_id)
    if cursor is None:
        return False
    try:
        cursor.cancel()
    except Exception:  # noqa: BLE001 - driver-specific cancel failures
        return False
    return True


def is_cancellation(exc: BaseException) -> bool:
    """True when ``exc`` is an ODBC HY008 "operation canceled" diagnostic."""
    text = str(exc).upper()
    return "HY008" in text or "CANCE" in text


_READ_ONLY_KEYWORDS = {"SELECT", "WITH"}
_COMMENT_RE = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)
_ODBC_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_ODBC_DIAGNOSTIC_RE = re.compile(r"\((\d+)\)\s*\(([^()]+)\)\s*$")


def format_db_error(exc: BaseException) -> str:
    """Return a readable one-line message for a pyodbc/DBAPI error.

    Some drivers (notably Oracle's ODBC driver) append uninitialized buffer
    bytes — NULs and mojibake — after the real message. Keep the meaningful
    first line plus any trailing ``(native_error) (function)`` diagnostics.
    """
    args = getattr(exc, "args", ())
    raw = args[-1] if args and isinstance(args[-1], str) else str(exc)
    text = _ODBC_CONTROL_CHARS.sub("", str(raw)).replace("\r", "")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return str(exc)
    message = lines[0]
    if len(lines) > 1:
        match = _ODBC_DIAGNOSTIC_RE.search(lines[-1])
        if match and not _ODBC_DIAGNOSTIC_RE.search(message):
            message = f"{message} ({match.group(1)}) ({match.group(2)})"
    return message


def build_connection_string(conn: dict) -> str:
    """Assemble a pyodbc connection string from a stored connection dict."""
    conn_type = conn.get("type")
    if conn_type == "dsn":
        parts = [f"DSN={conn.get('dsn') or ''};"]
        if conn.get("trusted_connection") is True:
            # Windows integrated security: no UID/PWD may be sent.
            parts.append("Trusted_Connection=yes;")
        else:
            if conn.get("username"):
                parts.append(f"UID={conn['username']};")
            if conn.get("password"):
                parts.append(f"PWD={conn['password']};")
        return "".join(parts)
    if conn_type == "access":
        # Local Microsoft Access database (resolved from a SharePoint link or
        # a local path by the connections API).
        from app.db import access_file  # local import to avoid cycle

        file_path = conn.get("file_path") or conn.get("local_path") or ""
        return access_file.build_access_connection_string(file_path)
    if conn_type == "string":
        if conn.get("connection_string"):
            return conn.get("connection_string")
    parts = []
    if conn.get("driver"):
        parts.append(f"DRIVER={{{conn['driver']}}};")
    if conn.get("server"):
        parts.append(f"SERVER={conn['server']};")
    if conn.get("database"):
        parts.append(f"DATABASE={conn['database']};")
    if conn.get("username"):
        parts.append(f"UID={conn['username']};")
    if conn.get("password"):
        parts.append(f"PWD={conn['password']};")
    if conn.get("trusted_connection"):
        parts.append("Trusted_Connection=yes;")
    return "".join(parts)


# --- ODBC driver dependency resolution -------------------------------------
#
# When the app is packaged as a PyInstaller one-file exe, the loader search
# path is restricted, so an ODBC driver loaded by absolute path may fail to
# find the co-located dependency DLLs it needs — e.g. Oracle Instant Client's
# ``oci.dll`` sitting next to ``SQORA32.dll``. That surfaces at connect time as
# "system error 1114: A dynamic link library (DLL) initialization routine
# failed" (IM003), even though the same connection succeeds from a console.
# Before connecting we add the driver's own directory to the process DLL
# search path so those dependencies resolve no matter how the app was launched.

_DRIVER_DIRS_ADDED: set[str] = set()

_ODBC_LOADER_STATE_READY = False


def _registry_driver(dsn: str) -> str | None:
    """Return the ODBC driver DLL path registered for a DSN (or None)."""
    if not dsn:
        return None
    try:
        import winreg  # noqa: PLC0415 - Windows-only module
    except ImportError:
        return None
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        # Check the 64-bit and 32-bit (WOW6432Node) views of the registry.
        for base in (r"SOFTWARE\ODBC\ODBC.INI", r"SOFTWARE\WOW6432Node\ODBC\ODBC.INI"):
            try:
                with winreg.OpenKey(hive, base + "\\" + dsn) as key:
                    value, _ = winreg.QueryValueEx(key, "Driver")
                    return str(value)
            except OSError:
                continue
    return None


def _connection_string_driver(connection_string: str) -> str | None:
    """Return the ``DRIVER={...}`` value from a connection string when it is a path."""
    match = re.search(r"DRIVER=\{(.*?)\}", connection_string or "", re.IGNORECASE)
    if not match:
        return None
    driver = match.group(1).strip()
    return driver if driver.lower().endswith(".dll") else None


def _driver_dir(conn: dict) -> str | None:
    """Return the directory holding the connection's ODBC driver DLL, if findable."""
    if not sys.platform.startswith("win"):
        return None
    if conn.get("type") == "dsn":
        driver = _registry_driver(conn.get("dsn"))
    else:
        driver = _connection_string_driver(conn.get("connection_string"))
    if not driver or not driver.lower().endswith(".dll") or os.sep not in driver:
        return None
    directory = os.path.dirname(driver)
    return directory if os.path.isdir(directory) else None


def _ensure_driver_dir_on_dll_search(conn: dict) -> None:
    """Add the ODBC driver's directory to the process DLL search path (once)."""
    if not sys.platform.startswith("win"):
        return
    directory = _driver_dir(conn)
    if not directory or directory in _DRIVER_DIRS_ADDED:
        return
    _DRIVER_DIRS_ADDED.add(directory)
    try:
        add_dll_directory = getattr(os, "add_dll_directory", None)
        if add_dll_directory is not None:
            add_dll_directory(directory)
        else:
            # Python < 3.8: fall back to prepending the directory to PATH.
            path_entries = os.environ.get("PATH", "").split(os.pathsep)
            if directory not in path_entries:
                os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
    except OSError:
        # Directory vanished or a stale handle; nothing fatal — connection
        # attempts will surface the real ODBC error if the driver still fails.
        pass


def _ensure_odbc_loader_state() -> None:
    """Undo PyInstaller's ``SetDllDirectory(_MEIPASS)`` override (once, frozen only).

    The one-file bootloader points the process DLL directory at the extraction
    temp dir. With that override active, Oracle's ODBC driver (SQORA32.dll)
    fails to initialize — ``SQLDriverConnect`` returns IM003 / system error
    1114 ("A dynamic link library (DLL) initialization routine failed") — even
    though the driver loads fine once the override is cleared (verified: after
    ``SetDllDirectoryW(None)`` the driver pulls in its companions sqresus.dll,
    oraociei12.dll and oraons.dll and connects). Bundled extension modules are
    unaffected because CPython loads them with LOAD_WITH_ALTERED_SEARCH_PATH
    (their own directory first), so clearing the override is safe.
    """
    global _ODBC_LOADER_STATE_READY
    if _ODBC_LOADER_STATE_READY or not sys.platform.startswith("win"):
        return
    if not getattr(sys, "frozen", False):
        _ODBC_LOADER_STATE_READY = True  # nothing to undo outside PyInstaller
        return
    _ODBC_LOADER_STATE_READY = True
    try:
        import ctypes  # noqa: PLC0415

        ctypes.WinDLL("kernel32").SetDllDirectoryW(None)
    except Exception:  # noqa: BLE001 - never block connecting over this
        pass


def open_connection(conn: dict, timeout: int | None = None):
    """Open a pyodbc connection (caller is responsible for closing it).

    ``timeout`` overrides :data:`CONNECT_TIMEOUT` when supplied (used by the
    short server-type detection probe). Tries ``autocommit=False`` first; some
    drivers (Jet/ACE family: Access, Excel, Text/dBASE) do not implement
    ``SQL_ATTR_AUTOCOMMIT`` and reject it, so we fall back to the driver default. Read-only safety is still enforced by :func:`assert_read_only`.
    """
    # Undo PyInstaller's DLL-directory override so packaged exes can load
    # native ODBC drivers (Oracle SQORA32: error 1114 otherwise), then make
    # sure the driver's own co-located dependency DLLs (e.g. Oracle's oci.dll)
    # resolve (see _DRIVER_DIRS_ADDED).
    _ensure_odbc_loader_state()
    _ensure_driver_dir_on_dll_search(conn)
    connection_string = build_connection_string(conn)
    connect_timeout = CONNECT_TIMEOUT if timeout is None else timeout
    try:
        return pyodbc.connect(
            connection_string, timeout=connect_timeout, autocommit=False
        )
    except pyodbc.Error as exc:
        if "HYC00" not in str(exc):
            raise
        # Jet/ACE-family drivers (Access, Excel, Text/dBASE) only support
        # autocommit mode; fall back to autocommit=True. Read-only safety is
        # still enforced by assert_read_only at the API layer.
        return pyodbc.connect(connection_string, timeout=connect_timeout, autocommit=True)


def test_connection(conn: dict) -> tuple[bool, str]:
    """Try to connect and run a trivial probe query; return ``(ok, message)``.

    Oracle rejects bare ``SELECT 1`` (ORA-00923: FROM keyword not found where
    expected) and requires ``SELECT 1 FROM DUAL``, so the probe query is chosen
    from the driver-reported DBMS name. Raw ODBC error text is sanitized before
    being returned to the caller.
    """
    try:
        cnxn = open_connection(conn)
        try:
            cursor = cnxn.cursor()
            try:
                dbms = str(cnxn.getinfo(pyodbc.SQL_DBMS_NAME) or "").lower()
            except Exception:
                dbms = ""
            probe = "SELECT 1 FROM DUAL" if "oracle" in dbms else "SELECT 1"
            cursor.execute(probe)
            cursor.fetchone()
        finally:
            cnxn.close()
        return True, "Connection successful"
    except Exception as exc:  # noqa: BLE001 - any failure is reported as a message
        return False, _clean_error_message(str(exc))


def list_tables(conn: dict) -> list[dict]:
    """List tables and views reachable through the connection."""
    tables: list[dict] = []
    cnxn = open_connection(conn)
    try:
        cursor = cnxn.cursor()
        for row in cursor.tables():
            table_type = str(row.table_type or "").upper()
            if table_type in ("TABLE", "VIEW"):
                tables.append({"name": str(row.table_name), "type": table_type.lower()})
    finally:
        cnxn.close()

    # Deduplicate (some drivers return each table once per catalog/schema).
    seen = set()
    unique = []
    for t in tables:
        key = (t["name"], t["type"])
        if key not in seen:
            seen.add(key)
            unique.append(t)
    unique.sort(key=lambda t: t["name"].lower())
    return unique


def _oracle_catalog_columns(cursor, table_name: str) -> list[dict]:
    """Read column metadata straight from the Oracle catalog.

    Some Oracle ODBC driver builds crash inside ``SQLColumns`` with
    ``[22003] Numeric value out of range`` while the driver resolves
    synonyms / db links. Querying ``USER_TAB_COLUMNS`` / ``ALL_TAB_COLUMNS``
    sidesteps that broken code path and returns the same metadata.
    """
    cursor.execute(
        "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM USER_TAB_COLUMNS "
        "WHERE TABLE_NAME = ? ORDER BY COLUMN_ID",
        (table_name,),
    )
    rows = cursor.fetchall()
    if not rows:
        # Not owned by the session user (e.g. reached via a synonym): fall
        # back to ALL_TAB_COLUMNS, deduplicating same-named tables per owner.
        cursor.execute(
            "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM ALL_TAB_COLUMNS "
            "WHERE TABLE_NAME = ? ORDER BY OWNER, COLUMN_ID",
            (table_name,),
        )
        seen: set[str] = set()
        rows = []
        for name, data_type, nullable in cursor.fetchall():
            if name in seen:
                continue
            seen.add(name)
            rows.append((name, data_type, nullable))
    return [
        {
            "name": str(name),
            "data_type": str(data_type or ""),
            "nullable": str(nullable or "Y").strip().upper() == "Y",
        }
        for name, data_type, nullable in rows
    ]


def list_columns(conn: dict, table: str) -> list[dict]:
    """List columns for a table (if the name is qualified, use the last segment)."""
    table_name = table.split(".")[-1] if "." in table else table
    columns: list[dict] = []
    cnxn = open_connection(conn)
    try:
        cursor = cnxn.cursor()
        try:
            dbms = str(cnxn.getinfo(pyodbc.SQL_DBMS_NAME) or "").lower()
        except Exception:
            dbms = ""
        try:
            for row in cursor.columns(table=table_name):
                nullable = int(row.nullable) == 1 if row.nullable is not None else True
                columns.append(
                    {
                        "name": str(row.column_name),
                        "data_type": str(row.type_name or ""),
                        "nullable": nullable,
                    }
                )
        except pyodbc.Error:
            # Only Oracle gets the catalog fallback; other drivers keep the
            # original error so real problems are still reported.
            if "oracle" not in dbms:
                raise
            columns = _oracle_catalog_columns(cursor, table_name)
    finally:
        cnxn.close()
    return columns


def run_query(
    conn: dict,
    sql: str,
    params: list | None = None,
    row_cap: int | None = None,
) -> tuple[list[dict], list[tuple]]:
    """Execute ``sql`` and return ``(rows, col_types)``.

    ``rows`` is a list of dicts keyed by column name with values normalized to
    JSON-friendly types. ``col_types`` is a list of ``(name, type_code)`` where
    ``type_code`` is the ODBC SQL type code (or a friendly name when known).

    When ``row_cap`` is set, rows are fetched in batches and at most ``row_cap``
    rows are returned (the ``(row_cap + 1)``-th row is never fetched).
    """
    cnxn = open_connection(conn)
    try:
        cursor = cnxn.cursor()
        cursor.execute(sql, params or [])
        if cursor.description is None:
            return [], []
        columns = [(d[0], d[1]) for d in cursor.description]
        rows = []
        if row_cap is None:
            for record in cursor.fetchall():
                rows.append({col[0]: _normalize_value(value) for col, value in zip(columns, record)})
        else:
            while len(rows) < row_cap:
                batch = cursor.fetchmany(500)
                if not batch:
                    break
                for record in batch:
                    rows.append({col[0]: _normalize_value(value) for col, value in zip(columns, record)})
                    if len(rows) >= row_cap:
                        break
        return rows, columns
    finally:
        cnxn.close()


def iter_query(
    conn: dict,
    sql: str,
    params: list | None = None,
    row_cap: int | None = None,
    batch_size: int = 1000,
    run_id: str | None = None,
) -> Iterator[tuple[str, list, list]]:
    """Generator that streams query results without buffering them all at once.

    Yields ``("progress", rows_fetched_so_far, col_types)`` after each batch is
    pulled, then finally ``("done", rows, col_types)``. This lets the streaming
    run endpoints report row-fetch progress to the UI while a large result is
    still being retrieved. The connection stays open across yields and is closed
    when the generator is exhausted.

    When ``run_id`` is given, the cursor is registered under it for the
    duration of the run so :func:`cancel_run` can cancel the in-flight
    statement from another request.
    """
    cnxn = open_connection(conn)
    try:
        cursor = cnxn.cursor()
        if run_id:
            register_run(run_id, cursor)
        cursor.execute(sql, params or [])
        if cursor.description is None:
            yield "done", [], []
            return
        columns = [(d[0], d[1]) for d in cursor.description]
        rows = []
        cap = row_cap
        while cap is None or len(rows) < cap:
            remaining = (cap - len(rows)) if cap is not None else batch_size
            batch = cursor.fetchmany(remaining if cap is not None else batch_size)
            if not batch:
                break
            for record in batch:
                rows.append({col[0]: _normalize_value(value) for col, value in zip(columns, record)})
                if cap is not None and len(rows) >= cap:
                    break
            yield "progress", len(rows), columns
        yield "done", rows, columns
    finally:
        if run_id:
            unregister_run(run_id)
        cnxn.close()


def assert_read_only(sql: str) -> None:
    """Raise ValueError unless ``sql`` starts with SELECT or WITH."""
    stripped = _COMMENT_RE.sub(" ", sql or "")
    tokens = stripped.split()
    if not tokens:
        raise ValueError("Empty SQL statement")
    keyword = tokens[0].upper()
    if keyword not in _READ_ONLY_KEYWORDS:
        raise ValueError(f"Only SELECT/WITH statements are allowed (got '{keyword}')")


# --- value normalization ---------------------------------------------------

_NUMPY = None

_ERR_TRUNCATE = 300


def _clean_error_message(message: str, limit: int = _ERR_TRUNCATE) -> str:
    """Sanitize a raw ODBC error string for display.

    Some drivers (notably Oracle) pad messages with NUL bytes and newlines;
    collapse runs of whitespace and truncate so the text is UI-friendly.
    """
    cleaned = (message or "").replace("\x00", " ").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:limit]


def _numpy():
    global _NUMPY
    if _NUMPY is None:
        try:
            import numpy as np  # noqa: PLC0415

            _NUMPY = np
        except ImportError:
            _NUMPY = False
    return _NUMPY or None


def _normalize_value(value):
    """Convert DB values into plain JSON-serializable Python types."""
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, datetime.time):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    np = _numpy()
    if np is not None:
        if isinstance(value, np.datetime64):
            return str(value)
        if isinstance(value, np.bool_):
            return bool(value)
        if isinstance(value, np.integer):
            return int(value)
        if isinstance(value, np.floating):
            return float(value)
        if isinstance(value, np.str_):
            return str(value)
    return value
