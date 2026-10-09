"""API routes for managing saved ODBC connections."""
import threading
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import keystore, logging_utils, storage
from app.db import odbc
from app.db.sql_builder import dbms_from_hints, resolve_dbms

router = APIRouter()

_CONNECTIONS_FILE = "connections.json"


class ConnectionCreate(BaseModel):
    """Body shared by POST /connections and POST /connections/test."""

    name: str = Field(min_length=1)
    # Test-only: when set, the test may fall back to the stored connection's
    # keyring password (the API never sends passwords back to the client).
    id: Optional[str] = None
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


def load_stored_connections() -> list:
    """Load connections from disk with passwords supplied from the OS keyring.

    Passwords are never kept in ``connections.json``: plaintext entries saved
    by older builds are migrated into the OS credential store on first load and
    scrubbed from the file. The returned dicts *do* carry the password so the
    query routers can open ODBC connections — HTTP responses must go through
    :func:`public_connection`, which strips it again.
    """
    connections = storage.load_json(_CONNECTIONS_FILE, [])
    migrated = False
    for conn in connections:
        connection_id = conn.get("id")
        if not connection_id:
            continue
        account = keystore.connection_account(str(connection_id))
        plaintext = conn.pop("password", None)
        if plaintext:
            # One-time migration from builds that stored the password in JSON.
            keystore.set_secret(account, str(plaintext))
            migrated = True
        conn["password"] = keystore.get_secret(account) or ""
    if migrated:
        _save_connections(connections)
        logging_utils.log_info(
            "connections", "migrated stored passwords into the OS keyring"
        )
    return connections


def _save_connections(connections: list) -> None:
    """Write connections to disk, always stripping injected passwords.

    The in-memory dicts produced by :func:`load_stored_connections` carry the
    password; this is the single choke point that keeps it off disk.
    """
    storage.save_json(
        _CONNECTIONS_FILE,
        [{k: v for k, v in c.items() if k != "password"} for c in connections],
    )


def public_connection(conn: dict) -> dict:
    """Return a copy of a connection dict that is safe to send over HTTP.

    Drops the password and reports whether one is stored instead.
    """
    from app.api.connection_templates import connection_template_key  # deferred: avoid import cycle

    public = {k: v for k, v in conn.items() if k != "password"}
    public["has_password"] = keystore.has_secret(
        keystore.connection_account(str(conn.get("id") or ""))
    )
    # The stable key that ties this connection to its GUI templates, predefined
    # scripts and channel operations: the DSN, or the Access database file name
    # (ColorDB.mdb -> "ColorDB"). Exposed so the client loads the right template
    # set instead of deriving the key from the (editable) display name itself.
    public["template_key"] = connection_template_key(conn)
    return public


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
    detected = dbms_from_hints(conn)
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
    connections = load_stored_connections()
    for conn in connections:
        db_type = (conn.get("database_type") or "auto").lower()
        # Only detect for unset / auto / other connections; explicit types
        # (sqlserver, oracle, …) resolve straight from the slug map.
        detected = _resolved_dbms(conn) if db_type in ("", "auto", "other") else None
        dbms = resolve_dbms(conn, detected)
        conn["resolved_dbms"] = str(dbms) if dbms else None
    return [public_connection(conn) for conn in connections]


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
            for c in load_stored_connections()
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
    connections = load_stored_connections()
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
    # The password goes to the OS keyring, never to connections.json.
    password = obj.pop("password", None)
    if password:
        keystore.set_secret(keystore.connection_account(obj["id"]), str(password))
    connections.append(obj)
    _save_connections(connections)
    logging_utils.log_info("connections", f"created '{obj.get('name')}'")
    return public_connection(obj)


@router.put("/connections/{connection_id}")
def update_connection(connection_id: str, payload: ConnectionUpdate):
    """Update fields of an existing connection.

    The display name is a free label and may be edited freely (it stays
    unique), but the ODBC DSN (and the connection type) is the immutable key
    that GUI templates, predefined scripts and channel operations are linked
    to — so it cannot change after creation.
    """
    connections = load_stored_connections()
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
    # The password is never written to the JSON file: store it in the OS
    # keyring (an absent/empty password keeps the previously stored one).
    password = updates.pop("password", None)
    if password:
        keystore.set_secret(keystore.connection_account(connection_id), str(password))
    obj.update(updates)
    try:
        _resolve_access_file(obj)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _save_connections(connections)
    logging_utils.log_info("connections", f"updated '{obj.get('name')}'")
    return public_connection(obj)


@router.delete("/connections/{connection_id}")
def delete_connection(connection_id: str):
    """Delete a saved connection."""
    connections = load_stored_connections()
    obj = _find_connection(connections, connection_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"Connection '{connection_id}' not found")
    connections.remove(obj)
    _save_connections(connections)
    keystore.delete_secret(keystore.connection_account(connection_id))
    logging_utils.log_info("connections", f"deleted '{obj.get('name')}'")
    return {"ok": True}


@router.post("/connections/test")
def test_connection(payload: ConnectionCreate):
    """Try to connect with the supplied parameters (nothing is saved).

    The client cannot echo a stored password back (the API strips passwords
    from every response), so when ``id`` references a saved connection and the
    payload carries no password, the stored keyring password is used. Any
    fields the caller did edit in the form still win over the stored ones.
    """
    obj = payload.model_dump(exclude_unset=True)
    connection_id = obj.pop("id", None)
    if connection_id and not obj.get("password"):
        stored = _find_connection(load_stored_connections(), str(connection_id))
        if stored and stored.get("password"):
            obj["password"] = stored["password"]
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
