"""API routes for managing saved ODBC connections."""
import threading
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import logging_utils, storage
from app.db import odbc
from app.db.sql_builder import resolve_dbms

router = APIRouter()

_CONNECTIONS_FILE = "connections.json"


class ConnectionCreate(BaseModel):
    """Body shared by POST /connections and POST /connections/test."""

    name: str = Field(min_length=1)
    type: Literal["dsn", "string", "access"]
    dsn: Optional[str] = None
    connection_string: Optional[str] = None
    driver: Optional[str] = None
    server: Optional[str] = None
    database: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    trusted_connection: Optional[bool] = None
    database_type: Optional[str] = None
    # Access-file connections (SharePoint link and/or local path).
    url: Optional[str] = None
    local_path: Optional[str] = None


class ConnectionUpdate(BaseModel):
    """Partial update body for PUT /connections/{id}."""

    name: Optional[str] = Field(default=None, min_length=1)
    type: Optional[Literal["dsn", "string", "access"]] = None
    dsn: Optional[str] = None
    connection_string: Optional[str] = None
    driver: Optional[str] = None
    server: Optional[str] = None
    database: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    trusted_connection: Optional[bool] = None
    database_type: Optional[str] = None
    url: Optional[str] = None
    local_path: Optional[str] = None


def _load_connections() -> list:
    return storage.load_json(_CONNECTIONS_FILE, [])


def _save_connections(connections: list) -> None:
    storage.save_json(_CONNECTIONS_FILE, connections)


def _find_connection(connections: list, connection_id: str) -> dict | None:
    return next((c for c in connections if c.get("id") == connection_id), None)


def _name_exists(connections: list, name: str, exclude_id: str | None = None) -> bool:
    """Return True when a connection already uses ``name`` (case-insensitive)."""
    target = (name or "").strip().lower()
    return any(
        c.get("id") != exclude_id and (c.get("name") or "").strip().lower() == target
        for c in connections
    )


def _dsn_exists(connections: list, dsn: str, exclude_id: str | None = None) -> bool:
    """Return True when another connection already uses this DSN (case-insensitive).

    The DSN is the immutable key that templates, scripts and channel operations
    are linked to, so it must stay unambiguous across saved connections.
    """
    target = (dsn or "").strip().lower()
    return any(
        c.get("id") != exclude_id and (c.get("dsn") or "").strip().lower() == target
        for c in connections
    )


def _resolve_access_file(obj: dict) -> None:
    """Resolve an access-type connection's local file path in place.

    Prefers the local path; falls back to downloading from the SharePoint URL.
    Raises RuntimeError with a user-friendly message when neither works.
    """
    if obj.get("type") != "access":
        return
    from app.db import access_file

    file_path = access_file.resolve_access_file(obj.get("url"), obj.get("local_path"))
    obj["file_path"] = file_path


# Cached resolved server type, keyed by a connection-target signature, so a
# page refresh does not re-open an ODBC connection to every untyped DSN.
_DBMS_CACHE: "dict[str, str | None]" = {}
_DBMS_CACHE_LOCK = threading.Lock()

# Canonical DBMS product names keyed by driver-name / DLL markers (checked in
# order). Windows ODBC DSNs store the driver as a DLL path (e.g. SQLSRV32.dll),
# so both the friendly name and the common DLL name are matched.
_DRIVER_DBMS_MARKERS = (
    ("SQL Server", "Microsoft SQL Server"),
    ("sqlsrv32", "Microsoft SQL Server"),
    ("sqlncli", "Microsoft SQL Server"),
    ("msodbcsql", "Microsoft SQL Server"),
    ("Oracle", "Oracle"),
    ("msorcl", "Oracle"),
    ("MySQL", "MySQL"),
    ("myodbc", "MySQL"),
    ("PostgreSQL", "PostgreSQL"),
    ("psqlodbc", "PostgreSQL"),
    ("podbc", "PostgreSQL"),
)
_JET_MARKERS = ("access", "excel", "dbase", "xbase", "text")


def _connection_signature(conn: dict) -> str:
    """Stable key for a connection's detection target (what it connects to).

    Any change to the address / driver / auth makes it point at a different
    server or driver, so the cached detection no longer applies and the
    server type is re-detected.
    """
    parts = (
        conn.get("type") or "",
        conn.get("dsn") or "",
        conn.get("server") or "",
        conn.get("database") or "",
        conn.get("driver") or "",
        conn.get("connection_string") or "",
        conn.get("url") or "",
        conn.get("local_path") or "",
    )
    return "|".join(parts).lower()


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


def _fast_dbms_hint(conn: dict) -> str | None:
    """Resolve the DBMS from connection metadata without opening a connection.

    Tries the stored driver, then the DSN's registered Windows driver, then the
    connection string. Returns ``None`` when the driver is not recognised.
    """
    if conn.get("type") == "access":
        # Access-file connections always target the Microsoft Access/ACE engine.
        return "Microsoft Access"
    hint = _dbms_from_driver(conn.get("driver"))
    if hint:
        return hint
    if conn.get("type") == "dsn":
        hint = _dbms_from_driver(_registry_dsn_driver(conn.get("dsn")))
        if hint:
            return hint
    return _dbms_from_driver(conn.get("connection_string"))


def _resolved_dbms(conn: dict) -> str | None:
    """Resolve the DBMS product name for an untyped connection (cached).

    Only uses fast metadata/driver hints (stored driver, the DSN's registered
    Windows driver, or the connection string) — it never opens a live ODBC
    connection. Live detection can hang for seconds on unreachable DSNs, so a
    page refresh must not depend on it. The result is cached so repeated loads
    are instant.
    """
    key = _connection_signature(conn)
    with _DBMS_CACHE_LOCK:
        if key in _DBMS_CACHE:
            return _DBMS_CACHE[key]
    detected = _fast_dbms_hint(conn)
    with _DBMS_CACHE_LOCK:
        _DBMS_CACHE[key] = detected
    return detected


@router.get("/connections")
def list_connections():
    """Return all saved connections, each annotated with a resolved server type.

    ``resolved_dbms`` is the driver-reported / configured DBMS product name
    (e.g. ``Microsoft SQL Server``, ``Oracle``). It is resolved from the
    connection's explicit ``database_type`` when set; otherwise the driver is
    detected (fast metadata hint first, live probe only as a fallback) and the
    result is cached so page refreshes stay fast.
    """
    connections = _load_connections()
    for conn in connections:
        db_type = (conn.get("database_type") or "auto").lower()
        # Only detect for unset / auto / other connections; explicit types
        # (sqlserver, oracle, …) resolve straight from the slug map.
        detected = _resolved_dbms(conn) if db_type in ("", "auto", "other") else None
        dbms = resolve_dbms(conn, detected)
        conn["resolved_dbms"] = str(dbms) if dbms else None
    return connections


@router.get("/connections/detect")
def detect_dsn_connections():
    """List ODBC DSNs registered in the local Windows registry.

    Returns ``[{dsn, driver, scope, bits, already_saved}]`` deduped by
    ``(dsn, scope, bits)`` and sorted by name. Never raises: on non-Windows
    (or when the registry is unreadable) an empty list is returned.
    """
    try:
        import winreg  # noqa: PLC0415 - Windows-only module
    except ImportError:
        return []

    try:
        saved_names = {
            str(c.get("dsn", "")).lower()
            for c in _load_connections()
            if c.get("type") == "dsn" and c.get("dsn")
        }
        locations = [
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\ODBC\ODBC.INI\ODBC Data Sources", "system", 64),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\ODBC\ODBC.INI\ODBC Data Sources", "user", 64),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\ODBC\ODBC.INI\ODBC Data Sources", "system", 32),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\WOW6432Node\ODBC\ODBC.INI\ODBC Data Sources", "user", 32),
        ]
        found: list[dict] = []
        seen: set[tuple[str, str, int]] = set()
        for hive, path, scope, bits in locations:
            try:
                with winreg.OpenKey(hive, path) as key:
                    index = 0
                    while True:
                        try:
                            dsn_name, driver, _ = winreg.EnumValue(key, index)
                        except OSError:
                            break  # no more values under this key
                        index += 1
                        name = str(dsn_name)
                        dedupe_key = (name, scope, bits)
                        if dedupe_key in seen:
                            continue
                        seen.add(dedupe_key)
                        found.append(
                            {
                                "dsn": name,
                                "driver": str(driver or ""),
                                "scope": scope,
                                "bits": bits,
                                "already_saved": name.lower() in saved_names,
                            }
                        )
            except OSError:
                continue  # key missing (e.g. WOW6432Node on 32-bit systems)
        found.sort(key=lambda d: d["dsn"].lower())
        return found
    except OSError:
        return []


@router.post("/connections", status_code=201)
def create_connection(payload: ConnectionCreate):
    """Create a new connection (server assigns id and created_at)."""
    connections = _load_connections()
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="The connection name cannot be empty.")
    if _name_exists(connections, name):
        raise HTTPException(
            status_code=400,
            detail=f"A connection named '{name}' already exists.",
        )
    if payload.type == "dsn" and payload.dsn and _dsn_exists(connections, payload.dsn):
        raise HTTPException(
            status_code=400,
            detail=f"A connection with DSN '{payload.dsn}' already exists.",
        )
    obj = payload.model_dump(exclude_unset=True)
    obj["name"] = name
    try:
        _resolve_access_file(obj)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    obj["id"] = uuid.uuid4().hex
    obj["created_at"] = datetime.now(timezone.utc).isoformat()
    connections.append(obj)
    _save_connections(connections)
    logging_utils.log_info("connections", f"created '{obj.get('name')}'")
    return obj


@router.put("/connections/{connection_id}")
def update_connection(connection_id: str, payload: ConnectionUpdate):
    """Update fields of an existing connection.

    The display name is a free label and may be edited freely (it stays
    unique), but the ODBC DSN (and the connection type) is the immutable key
    that GUI templates, predefined scripts and channel operations are linked
    to — so it cannot change after creation.
    """
    connections = _load_connections()
    obj = _find_connection(connections, connection_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"Connection '{connection_id}' not found")
    updates = payload.model_dump(exclude_unset=True)
    # Name: editable, but must stay non-empty and unique.
    if "name" in updates:
        new_name = (updates["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="The connection name cannot be empty.")
        if _name_exists(connections, new_name, exclude_id=connection_id):
            raise HTTPException(
                status_code=400,
                detail=f"A connection named '{new_name}' already exists.",
            )
        updates["name"] = new_name
    # DSN: immutable key for templates/scripts/channels.
    if "dsn" in updates and updates["dsn"] != obj.get("dsn"):
        raise HTTPException(
            status_code=400,
            detail="The DSN name is the key for templates & predefined scripts, so it can't be changed after creation. Delete and re-add the connection to use a different DSN.",
        )
    # Changing the type would change (or drop) the key.
    if "type" in updates and updates["type"] != obj.get("type"):
        raise HTTPException(
            status_code=400,
            detail="The connection type can't be changed after creation. Delete and re-add the connection to switch type.",
        )
    obj.update(updates)
    try:
        _resolve_access_file(obj)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _save_connections(connections)
    logging_utils.log_info("connections", f"updated '{obj.get('name')}'")
    return obj


@router.delete("/connections/{connection_id}")
def delete_connection(connection_id: str):
    """Delete a saved connection."""
    connections = _load_connections()
    obj = _find_connection(connections, connection_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"Connection '{connection_id}' not found")
    connections.remove(obj)
    _save_connections(connections)
    logging_utils.log_info("connections", f"deleted '{obj.get('name')}'")
    return {"ok": True}


@router.post("/connections/test")
def test_connection(payload: ConnectionCreate):
    """Try to connect with the supplied parameters (nothing is saved)."""
    obj = payload.model_dump(exclude_unset=True)
    try:
        _resolve_access_file(obj)
    except RuntimeError as exc:
        return {"ok": False, "message": "File resolution failed", "details": str(exc)}
    ok, message = odbc.test_connection(obj)
    logging_utils.log_info(
        "connections.test",
        f"Connection '{payload.name}' test {'ok' if ok else 'failed'}",
        details=message if not ok else None,
    )
    if ok:
        return {"ok": True, "message": message}
    return {"ok": False, "message": "Connection failed", "details": message}
