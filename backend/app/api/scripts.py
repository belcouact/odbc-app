"""API for running and managing pre-defined scripts (Python / JavaScript).

A script can own a data source: when it is executed, the associated query
(builder QueryDef or raw SQL) runs first and its rows are passed to the script
as a Python list of dicts bound to the name ``data`` (for JavaScript the same
list is available as ``data``). The script's stdout is captured and returned.

Scripts execute locally on the user's machine with the user's own privileges —
treat script content like code you trust (the same model as a Jupyter notebook).
"""
import asyncio
import base64
import io
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import uuid
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, Optional
from urllib.parse import quote

import pyodbc
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app import logging_utils, storage, update
from app.api import queries as queries_api
from app.db import odbc
from app.db.sql_builder import DEFAULT_LIMIT

router = APIRouter()

_SCRIPTS_FILE = "scripts.json"
# Default timeout raised so large datasets (many rows / many chart builds) can
# finish; oversized runs can request a higher value up to SCRIPT_MAX_TIMEOUT.
SCRIPT_TIMEOUT_SECONDS = 600
SCRIPT_MAX_TIMEOUT = 7200
# Cap rows handed to a script so output stays predictable on huge tables.
SCRIPT_ROW_CAP = 1000

# Folder holding the "template" scripts offered in the script editor.  Used as
# the fallback when the published catalog cannot be read (offline, or an update
# source that is a file share rather than the Supabase bucket).
# backend/app/api/scripts.py -> backend/app/api -> backend/app -> backend/custom script
def _templates_dir() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "custom script"


TEMPLATES_DIR = _templates_dir()

# Published templates live in the ``templates/`` folder of the same public
# bucket that serves app updates (see app/update.py).  A storage URL cannot
# list a folder, so ``publish_templates.py`` also uploads a catalog the app
# reads here; the scripts themselves are fetched straight from the bucket, so a
# corrected template reaches the editor without a new build.
TEMPLATE_PREFIX = "templates"
CATALOG_NAME = f"{TEMPLATE_PREFIX}/templates.json"
CATALOG_TTL_SECONDS = 300
REMOTE_TIMEOUT_SECONDS = 8

# Guards both the catalog and the "is the bucket readable?" answer, which is
# negative-cached too: a machine with no route to the bucket must not stall the
# picker once per click.
_catalog_lock = threading.Lock()
_catalog_cache: dict = {"at": float("-inf"), "items": None}


def _public_base() -> str | None:
    """``.../object/public/<bucket>`` for the configured update source, or None.

    The update manifest is the single place the app learns which bucket serves
    it, so templates resolve against the same location and follow a custom
    update source automatically.
    """
    source = (update.manifest_source() or "").strip()
    if not source.lower().startswith(("http://", "https://")):
        return None
    return source.rsplit("/", 1)[0]


def _fetch_text(url: str) -> str | None:
    """Body of a public object, or None when it cannot be fetched."""
    request = urllib.request.Request(url, headers={"User-Agent": "ODBCQueryApp"})
    try:
        with urllib.request.urlopen(request, timeout=REMOTE_TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8", "replace")
    except (OSError, ValueError):
        return None


def _string_list(value: object) -> list[str]:
    """A JSON list of strings, with blanks dropped; [] for anything else."""
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _example_entry(entry: dict, base: str) -> dict | None:
    """The sample dashboard a template produces, or None when it publishes none.

    Only the object key travels in the catalog; the public URL is built here so
    the catalog stays correct if the bucket ever moves (the base comes from the
    update manifest, exactly like the template sources).
    """
    raw = entry.get("example")
    if not isinstance(raw, dict):
        return None
    obj = str(raw.get("object") or "").strip().lstrip("/")
    if not obj:
        return None
    return {
        "url": f"{base}/{quote(obj, safe='/')}",
        "label": str(raw.get("label") or "").strip(),
    }


def _catalog_item(entry: dict, base: str) -> dict | None:
    """One published template as the picker needs it; None for a malformed entry."""
    filename = str(entry.get("name") or "").strip()
    stem = Path(str(entry.get("stem") or filename).strip()).name
    if not stem or stem == "templates.json":
        return None
    raw_details = entry.get("details")
    details = raw_details if isinstance(raw_details, dict) else {}
    return {
        "name": stem,
        "filename": filename or f"{stem}.py",
        "title": str(entry.get("title") or "").strip(),
        "appliesTo": str(entry.get("applies_to") or "").strip(),
        "description": str(entry.get("description") or "").strip(),
        "details": {
            "requires": _string_list(details.get("requires")),
            "optional": _string_list(details.get("optional")),
            "outputs": _string_list(details.get("outputs")),
        },
        "size": str(entry.get("size") or "").strip(),
        "updated": str(entry.get("updated") or "").strip(),
        "example": _example_entry(entry, base),
    }


def _remote_catalog() -> list[dict] | None:
    """The published templates, or None when the catalog cannot be read."""
    base = _public_base()
    if base is None:
        return None
    now = time.monotonic()
    with _catalog_lock:
        if now - _catalog_cache["at"] < CATALOG_TTL_SECONDS:
            return _catalog_cache["items"]

    items: list[dict] | None = None
    raw = _fetch_text(f"{base}/{CATALOG_NAME}")
    if raw is not None:
        try:
            listed = [
                item
                for item in (_catalog_item(entry, base) for entry in json.loads(raw)["templates"])
                if item is not None
            ]
            items = listed or None
        except (ValueError, KeyError, TypeError):
            items = None

    with _catalog_lock:
        _catalog_cache["at"] = now
        _catalog_cache["items"] = items
    return items


def _remote_template_text(stem: str) -> str | None:
    """A published template's source, or None to fall back to the bundled copy."""
    catalog = _remote_catalog()
    if not catalog or stem not in {item["name"] for item in catalog}:
        return None
    base = _public_base()
    return _fetch_text(f"{base}/{TEMPLATE_PREFIX}/{quote(f'{stem}.py')}")


@router.get("/scripts/templates")
def list_script_templates() -> list[dict]:
    """List the template scripts offered in the Script tab's picker.

    Published templates win over the ones bundled with the app, so a template
    fix reaches every user as soon as it is published; the ``custom script``
    folder is the fallback when the bucket cannot be read.
    """
    published = _remote_catalog()
    if published is not None:
        return published
    if not TEMPLATES_DIR.is_dir():
        return []
    return [
        {"name": file.stem, "filename": file.name}
        for file in sorted(TEMPLATES_DIR.glob("*.py"))
    ]


@router.get("/scripts/templates/{name}")
def get_script_template(name: str) -> dict:
    """Return a template script's content by its file stem (auto-load into editor).

    Only a path-safe basename is used so ``../`` cannot escape the folder.
    """
    safe_name = Path(name).name
    content = _remote_template_text(safe_name)
    if content is not None:
        return {"name": safe_name, "filename": f"{safe_name}.py", "content": content}
    if not TEMPLATES_DIR.is_dir():
        raise HTTPException(status_code=404, detail="No template folder found")
    path = TEMPLATES_DIR / f"{safe_name}.py"
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Template '{safe_name}' not found")
    return {"name": safe_name, "filename": path.name, "content": path.read_text(encoding="utf-8")}


class ScriptRunRequest(BaseModel):
    """Body for POST /scripts/run."""

    language: str = Field(pattern="^(python|javascript)$")
    script: str = Field(min_length=1)
    query: Optional[queries_api.QueryDef] = None
    sql: Optional[str] = None
    connection_id: Optional[str] = None
    timeout_seconds: int = Field(default=SCRIPT_TIMEOUT_SECONDS, ge=1, le=SCRIPT_MAX_TIMEOUT)
    # When set, the script receives exactly these rows (the current grid data);
    # query/sql are ignored in that case.
    rows: Optional[list] = None


class ScriptCreate(BaseModel):
    """Body for POST /scripts."""

    name: str = Field(min_length=1)
    description: Optional[str] = None
    language: str = Field(pattern="^(python|javascript)$")
    script: str = Field(min_length=1)
    connection_id: Optional[str] = None
    query: Optional[queries_api.QueryDef] = None
    sql: Optional[str] = None


class ScriptUpdate(BaseModel):
    """Body for PUT /scripts/{script_id} (all fields optional)."""

    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    language: Optional[str] = Field(default=None, pattern="^(python|javascript)$")
    script: Optional[str] = Field(default=None, min_length=1)
    connection_id: Optional[str] = None
    query: Optional[queries_api.QueryDef] = None
    sql: Optional[str] = None


def _load_scripts() -> list:
    return storage.load_json(_SCRIPTS_FILE, [])


def _save_scripts(scripts: list) -> None:
    storage.save_json(_SCRIPTS_FILE, scripts)


def _find_script(scripts: list, script_id: str) -> dict | None:
    return next((s for s in scripts if s.get("id") == script_id), None)


def _fetch_data(payload: ScriptRunRequest) -> tuple[list, int]:
    """Run the script's data source and return (rows, row_count)."""
    if payload.rows is not None:
        # Grid data is passed directly — do not re-query the database.
        # No row cap: the user explicitly selected these grid rows and expects
        # the script to see all of them.
        return payload.rows, len(payload.rows)
    if payload.query is not None:
        rows, _, _ = queries_api._run_query(payload.query)
        return rows[:SCRIPT_ROW_CAP], len(rows)
    if payload.sql:
        if not payload.connection_id:
            raise HTTPException(
                status_code=400, detail="connection_id is required to run raw SQL"
            )
        conn = queries_api._get_connection(payload.connection_id)
        try:
            odbc.assert_read_only(payload.sql)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            rows, _ = odbc.run_query(conn, payload.sql, row_cap=DEFAULT_LIMIT)
        except pyodbc.Error as exc:
            logging_utils.log_error(
                "script.run",
                f"connection={conn.get('name') or payload.connection_id} failed",
                details=str(exc),
            )
            raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc
        return rows[:SCRIPT_ROW_CAP], len(rows)
    return [], 0


def _downloads_folder() -> str:
    """Best-effort path to the user's Downloads folder.

    Uses the Windows known-folder API so OneDrive-redirected folders are
    respected; falls back to ``~/Downloads`` on non-Windows or on failure.
    """
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            # ctypes.wintypes has no GUID type on this Python; define it.
            class _GUID(ctypes.Structure):
                _fields_ = [
                    ("Data1", wintypes.DWORD),
                    ("Data2", wintypes.WORD),
                    ("Data3", wintypes.WORD),
                    ("Data4", wintypes.BYTE * 8),
                ]

            # FOLDERID_Downloads {374DE290-123F-4565-9164-39C4925E467B}
            folder_id = _GUID(
                0x374DE290, 0x123F, 0x4565, (0x91, 0x64, 0x39, 0xC4, 0x92, 0x5E, 0x46, 0x7B)
            )
            get_folder = ctypes.windll.shell32.SHGetKnownFolderPath
            # REFKNOWNFOLDERID is a pointer to the GUID (first parameter).
            get_folder.argtypes = [
                ctypes.POINTER(_GUID),
                wintypes.DWORD,
                wintypes.HANDLE,
                ctypes.POINTER(ctypes.c_wchar_p),
            ]
            get_folder.restype = ctypes.HRESULT
            folder = ctypes.c_wchar_p()
            if get_folder(ctypes.byref(folder_id), 0, None, ctypes.byref(folder)) == 0:
                path = folder.value
                ctypes.windll.ole32.CoTaskMemFree(folder)
                if path:
                    return path
        except Exception:  # noqa: BLE001 - fall back to the home folder
            pass
    return str(Path.home() / "Downloads")


def _run_python(
    script: str,
    data: list,
    timeout: int,
    cwd: Optional[str] = None,
    emit: Optional[callable] = None,
) -> tuple[str, str, bool]:
    """Execute Python in-process; return (stdout, stderr, timed_out).

    Runs on a daemon thread so a hung script cannot block the API. A script
    that exceeds the timeout is reported as timed out (the thread keeps running
    in the background and is eventually killed with the process).

    When ``cwd`` is given the script runs with that working directory (so any
    relative-path files it writes land there, e.g. the user's Downloads folder);
    the previous working directory is restored afterwards.

    When ``emit`` is provided, every chunk the script writes to stdout is also
    forwarded to ``emit(chunk)`` in real time (used to stream progress/log lines
    to the frontend).
    """
    stdout = io.StringIO()
    stderr = io.StringIO()
    # __name__ must be "__main__" so the standard `if __name__ == "__main__"`
    # guard runs user scripts the same way they run from a file.
    namespace = {"data": data, "__name__": "__main__"}
    state = {"timed_out": False}

    class StreamWriter(io.StringIO):
        """StringIO that forwards every write to ``emit`` as it happens."""

        def write(self, s) -> int:
            if emit is not None:
                emit(s)
            return super().write(s)

    active_stdout = StreamWriter() if emit is not None else stdout

    def target() -> None:
        previous_cwd = os.getcwd()
        if cwd:
            try:
                os.chdir(cwd)
            except OSError:
                pass  # keep the current directory if the target is unavailable
        # The script runs in-process, so it would otherwise see the server's own
        # CLI args (uvicorn ... --host --port --reload). Temporarily swap argv
        # to a bare script name so argparse-based templates don't choke on them.
        original_argv = sys.argv
        sys.argv = ["<script>"]
        try:
            with redirect_stdout(active_stdout), redirect_stderr(stderr):
                exec(compile(script, "<script>", "exec"), namespace)  # noqa: S102 - user-authored script
        except BaseException:  # noqa: BLE001 - report any script failure
            stderr.write(traceback.format_exc())
        finally:
            sys.argv = original_argv
            if cwd:
                try:
                    os.chdir(previous_cwd)
                except OSError:
                    pass

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        state["timed_out"] = True
        stderr.write(f"\n[Timeout] script did not finish within {timeout} seconds\n")
    return active_stdout.getvalue() if emit is not None else stdout.getvalue(), stderr.getvalue(), state["timed_out"]


def _run_javascript(script: str, data: list, timeout: int, cwd: Optional[str] = None) -> tuple[str, str, bool]:
    """Execute JavaScript through a local Node.js; return (stdout, stderr, timed_out)."""
    node = shutil.which("node")
    if not node:
        return (
            "",
            "Node.js was not found on PATH. Install Node.js to run JavaScript scripts.",
            False,
        )
    with tempfile.TemporaryDirectory() as tmp_dir:
        data_file = os.path.join(tmp_dir, "data.json")
        with open(data_file, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        runner = (
            "const data = JSON.parse(require('fs').readFileSync("
            + json.dumps(data_file)
            + ", 'utf8'));\n"
            + script
        )
        try:
            proc = subprocess.run(
                [node, "-e", runner],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                cwd=cwd,
            )
            return proc.stdout or "", proc.stderr or "", False
        except subprocess.TimeoutExpired:
            return "", f"\n[Timeout] script did not finish within {timeout} seconds\n", True
        except OSError as exc:
            return "", f"Failed to start Node.js: {exc}", False


def _collect_output_files(folder: Path) -> list[dict]:
    """Read every file the script wrote into ``folder`` (the staging dir).

    Scripts run with ``cwd`` set to a freshly-created staging folder so
    relative-path output files are always writable, even when the user's
    Downloads folder is locked. Each file is listed with its bytes
    base64-encoded so the frontend can route it through the save bridge
    (silent Downloads save -> native Save-As fallback).
    """
    files = []
    if not folder.is_dir():
        return files
    for path in sorted(folder.rglob("*")):
        if not path.is_file():
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        files.append(
            {
                "filename": path.name,
                "path": str(path),
                "size": len(raw),
                "data_base64": base64.b64encode(raw).decode("ascii"),
            }
        )
    return files


@router.post("/scripts/run")
def run_script(payload: ScriptRunRequest):
    """Run the script with its queried data passed in as ``data``."""
    start = time.perf_counter()
    rows, row_count = _fetch_data(payload)
    # Output files written by user scripts (relative paths) always land in
    # the user's Downloads folder.
    downloads = _downloads_folder()
    if payload.language == "python":
        stdout, stderr, timed_out = _run_python(
            payload.script, rows, payload.timeout_seconds, cwd=downloads
        )
    else:
        stdout, stderr, timed_out = _run_javascript(
            payload.script, rows, payload.timeout_seconds, cwd=downloads
        )
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    ok = not timed_out and not stderr.strip()
    logging_utils.log_info(
        "script.run",
        f"{payload.language} script finished in {elapsed_ms}ms (data rows: {row_count})",
        details=("timed out" if timed_out else "finished"),
    )
    return {
        "ok": ok,
        "stdout": stdout,
        "stderr": stderr,
        "elapsed_ms": elapsed_ms,
        "row_count": row_count,
        "timed_out": timed_out,
        "message": "" if not timed_out else f"Timed out after {payload.timeout_seconds}s",
    }


class GridTransformRequest(BaseModel):
    """Body for POST /scripts/grid-transform (AI grid edit execution)."""

    script: str = Field(min_length=1)
    rows: list = Field(default_factory=list)
    timeout_seconds: int = Field(default=300, ge=1, le=SCRIPT_MAX_TIMEOUT)


@router.post("/scripts/grid-transform")
def grid_transform(payload: GridTransformRequest):
    """Run a Python transform script against the current grid rows.

    The script receives the rows in the variable ``data`` (list of dicts) and
    may modify them in place or reassign ``data``. The resulting rows are read
    back from the script's namespace and returned together with a derived
    column list (original column order first, new keys appended in
    first-seen order) and the script's stdout/stderr as a log.
    """
    start = time.perf_counter()
    rows_in = payload.rows
    stdout, stderr, timed_out, namespace = _run_python_transform(
        payload.script, rows_in, payload.timeout_seconds
    )
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    if timed_out:
        raise HTTPException(status_code=408, detail=f"Script timed out after {payload.timeout_seconds}s")
    stderr_text = stderr.strip()
    if stderr_text:
        raise HTTPException(status_code=400, detail=f"Script error: {stderr_text}")

    rows_out = namespace.get("data")
    if not isinstance(rows_out, list):
        raise HTTPException(
            status_code=400,
            detail="The script must leave `data` as a list of rows (it can modify it in place or reassign it).",
        )
    rows_out = [row for row in rows_out if isinstance(row, dict)]
    columns = _derive_columns(payload.columns or [], rows_out)
    logging_utils.log_info(
        "script.grid_transform",
        f"transformed {len(rows_in)} rows -> {len(rows_out)} rows in {elapsed_ms}ms",
    )
    return {
        "rows": rows_out,
        "columns": [{"name": name, "type": ""} for name in columns],
        "row_count": len(rows_out),
        "stdout": stdout,
        "elapsed_ms": elapsed_ms,
    }


def _run_python_transform(
    script: str, data: list, timeout: int, filename: str = "<grid-transform>"
) -> tuple[str, str, bool, dict]:
    """Execute a grid-transform script in-process and return (stdout, stderr, timed_out, namespace).

    Like :func:`_run_python` but also returns the script's global namespace so
    the caller can read back the (possibly reassigned) ``data`` variable.
    ``filename`` only shows up in tracebacks, so pass the caller's own name.
    """
    stdout = io.StringIO()
    stderr = io.StringIO()
    namespace = {"data": data, "__name__": "__main__"}
    state = {"timed_out": False}

    def target() -> None:
        original_argv = sys.argv
        sys.argv = ["<script>"]
        try:
            with redirect_stdout(stdout), redirect_stderr(stderr):
                exec(compile(script, filename, "exec"), namespace)  # noqa: S102 - user-authored script
        except BaseException:  # noqa: BLE001 - report any script failure
            stderr.write(traceback.format_exc())
        finally:
            sys.argv = original_argv

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        state["timed_out"] = True
        stderr.write(f"\n[Timeout] script did not finish within {timeout} seconds\n")
    return stdout.getvalue(), stderr.getvalue(), state["timed_out"], namespace


def _derive_columns(original: list, rows_out: list[dict]) -> list[str]:
    """Derive the result column order: original names first, new keys appended.

    ``original`` may contain dicts ({"name": ...}) or plain strings. Columns
    dropped by the script disappear; keys added by the script are appended in
    first-seen order across the first rows.
    """
    original_names = [
        item.get("name") if isinstance(item, dict) else str(item) for item in original
    ]
    original_names = [name for name in original_names if name]
    seen: set[str] = set()
    columns: list[str] = []
    if rows_out:
        first_keys = list(rows_out[0].keys())
        for name in original_names:
            if name in first_keys and name not in seen:
                columns.append(name)
                seen.add(name)
        for key in first_keys:
            if key not in seen:
                columns.append(key)
                seen.add(key)
        # Heterogeneous rows: pick up keys the first row didn't have.
        for row in rows_out[1:200]:
            for key in row.keys():
                if key not in seen:
                    columns.append(key)
                    seen.add(key)
    return columns


@router.post("/scripts/run-stream")
async def run_script_stream(payload: ScriptRunRequest):
    """Run the script and stream its stdout/stderr to the browser as it happens.

    The response is a newline-delimited JSON (NDJSON) stream::

        {"type": "stdout", "chunk": "..."}
        {"type": "stderr", "chunk": "..."}
        {"type": "result", "ok": ..., "stdout": ..., "stderr": ...,
         "elapsed_ms": ..., "row_count": ..., "timed_out": ..., "message": ...,
         "output_files": [{"filename": ..., "path": ..., "size": ...,
                           "data_base64": ...}, ...]}

    Scripts run with ``cwd`` set to a fresh staging folder, so files they
    write by relative path always succeed; those files are then returned in
    ``output_files`` so the frontend can save them through the bridge
    (silently to Downloads, or a native Save-As dialog when Downloads is
    not writable).
    """
    rows, row_count = _fetch_data(payload)
    timeout = payload.timeout_seconds

    # Fresh staging dir (not Downloads) so the script always has a writable
    # working directory; generated files are collected and re-saved below.
    staging = Path(tempfile.mkdtemp(prefix="odbc_script_"))

    events: "queue.Queue[dict]" = queue.Queue()
    start = time.perf_counter()

    def emit(chunk: str) -> None:
        events.put({"type": "stdout", "chunk": chunk})

    def worker() -> None:
        try:
            if payload.language == "python":
                stdout, stderr, timed_out = _run_python(
                    payload.script, rows, timeout, cwd=str(staging), emit=emit
                )
            else:
                stdout, stderr, timed_out = _run_javascript(
                    payload.script, rows, timeout, cwd=str(staging)
                )
                if stdout:
                    events.put({"type": "stdout", "chunk": stdout})
        except BaseException as exc:  # noqa: BLE001 - report any runner failure
            stdout, stderr, timed_out = "", traceback.format_exc(), False
        if stderr:
            events.put({"type": "stderr", "chunk": stderr})
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        ok = not timed_out and not stderr.strip()
        output_files = _collect_output_files(staging)
        # The encoded copies are now held in memory; drop the staging folder so
        # repeated runs do not accumulate temp directories.
        shutil.rmtree(staging, ignore_errors=True)
        events.put(
            {
                "type": "result",
                "ok": ok,
                "stdout": stdout,
                "stderr": stderr,
                "elapsed_ms": elapsed_ms,
                "row_count": row_count,
                "timed_out": timed_out,
                "message": "" if not timed_out else f"Timed out after {timeout}s",
                "output_files": output_files,
            }
        )

    threading.Thread(target=worker, daemon=True).start()

    async def event_generator() -> AsyncGenerator[str, None]:
        loop = asyncio.get_running_loop()
        while True:
            # Run the blocking queue.get in a worker thread so the event loop
            # stays responsive; each event is emitted on its own NDJSON line.
            event = await loop.run_in_executor(None, events.get)
            yield json.dumps(event) + "\n"
            if event.get("type") == "result":
                break

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")


@router.get("/scripts")
def list_scripts():
    """Return all saved pre-defined scripts."""
    return _load_scripts()


@router.post("/scripts", status_code=201)
def create_script(payload: ScriptCreate):
    """Save a new pre-defined script (with its data source)."""
    scripts = _load_scripts()
    now = datetime.now(timezone.utc).isoformat()
    obj = {
        "id": uuid.uuid4().hex,
        "name": payload.name,
        "description": payload.description or "",
        "language": payload.language,
        "script": payload.script,
        "connection_id": payload.connection_id,
        "query": payload.query.model_dump() if payload.query is not None else None,
        "sql": payload.sql,
        "created_at": now,
        "updated_at": now,
    }
    scripts.append(obj)
    _save_scripts(scripts)
    return obj


@router.put("/scripts/{script_id}")
def update_script(script_id: str, payload: ScriptUpdate):
    """Update a saved pre-defined script."""
    scripts = _load_scripts()
    obj = _find_script(scripts, script_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"Script '{script_id}' not found")
    updates = payload.model_dump(exclude_unset=True)
    if "query" in updates:
        updates["query"] = updates["query"].model_dump() if updates["query"] else None
    obj.update(updates)
    obj["updated_at"] = datetime.now(timezone.utc).isoformat()
    _save_scripts(scripts)
    return obj


@router.delete("/scripts/{script_id}")
def delete_script(script_id: str):
    """Delete a saved pre-defined script."""
    scripts = _load_scripts()
    obj = _find_script(scripts, script_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"Script '{script_id}' not found")
    scripts.remove(obj)
    _save_scripts(scripts)
    return {"ok": True}
