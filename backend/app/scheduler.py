"""The in-app schedule runner.

The app's server lives and dies with its window (``launcher.py`` stops it on
close), so a scheduler cannot be a system service. Instead this module runs a
daemon thread inside the FastAPI process: it ticks every ``TICK_INTERVAL_SECONDS``
and fires whatever is due. A run missed while the app was closed is fired
**once** on the next launch, as long as it is still within
``STALENESS_WINDOW`` — otherwise it is recorded as ``missed`` and skipped.

Why a thread and not the HTTP endpoints: the streaming endpoints in
``api/queries.py`` / ``api/sql_queries.py`` are built for a browser reading a
NDJSON stream. The runner calls the plain synchronous helpers instead —
``queries.fetch_rows`` and ``scripts.run_script`` — which is safe off the event
loop and keeps results in-process.

Persistence: ``schedules.json`` holds the definitions, ``schedule_runs.json`` the
run history. Both are written through ``storage.save_json_atomic``; every read
and write goes through this module's ``_LOCK`` so the API router and the runner
thread never race. ``next_run_at`` is written forward *before* a run is
dispatched, so a crash mid-run cannot double-fire on the next launch.
"""
from __future__ import annotations

import copy
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Optional

from app import logging_utils, storage, warehouse
from app.api import queries as queries_api
from app.api import scripts as scripts_api
from app.schedule_model import (
    OutputSpec,
    ScheduleCreate,
    ScheduleUpdate,
    Target,
    Trigger,
    compute_next_run,
)

SCHEDULES_FILE = "schedules.json"
RUNS_FILE = "schedule_runs.json"

# Saved-query stores owned by other routers; read directly (read-only) here so
# the runner does not have to round-trip through HTTP.
_SAVED_QUERIES_FILE = "saved_queries.json"
_SQL_QUERIES_FILE = "sql_queries.json"
_SCRIPTS_FILE = "scripts.json"

TICK_INTERVAL_SECONDS = 30
# Let startup settle before the first sweep (mirrors update.start_background_checker).
FIRST_TICK_DELAY_SECONDS = 20
# A run older than this at launch is dropped rather than fired late.
STALENESS_WINDOW = timedelta(hours=24)
MAX_CONCURRENT_RUNS = 2
MAX_RETRIES = 3
RETRY_BASE_SECONDS = 60
RETRY_MAX_SECONDS = 900
# How long a due run may wait for the app to stop being busy before it gives up.
DEFER_CAP = timedelta(minutes=30)
# Ignore a fire that is already recorded as having just run (backward clock jump).
RECENCY_GUARD_SECONDS = 60
RUN_HISTORY_PER_SCHEDULE = 50

_LOCK = threading.Lock()
_RUN_LOCK = threading.Lock()

_items: list[dict] = []
_items_loaded = False
_runs: dict[str, list[dict]] = {}
_runs_loaded = False
_deferred_since: dict[str, datetime] = {}
_inflight: set[str] = set()

_executor: Optional[ThreadPoolExecutor] = None
_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def _now() -> datetime:
    """Naive local now — see the time convention note in ``schedule_model``."""
    return datetime.now()


def _parse_dt(value: object) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# persistence
# ---------------------------------------------------------------------------

def _ensure_items_loaded_locked() -> None:
    global _items, _items_loaded
    if _items_loaded:
        return
    raw = storage.load_json(SCHEDULES_FILE, [])
    _items = [item for item in raw if isinstance(item, dict)]
    _items_loaded = True


def _ensure_runs_loaded_locked() -> None:
    global _runs, _runs_loaded
    if _runs_loaded:
        return
    raw = storage.load_json(RUNS_FILE, {})
    _runs = {str(k): list(v) for k, v in raw.items() if isinstance(v, list)} if isinstance(raw, dict) else {}
    _runs_loaded = True


def _persist_items_locked() -> None:
    storage.save_json_atomic(SCHEDULES_FILE, _items)


def _persist_runs_locked() -> None:
    storage.save_json_atomic(RUNS_FILE, _runs)


def _find_locked(schedule_id: str) -> Optional[dict]:
    return next((item for item in _items if item.get("id") == schedule_id), None)


def _record_run_locked(
    schedule_id: str,
    *,
    run_id: str,
    started_at: datetime,
    finished_at: datetime,
    status: str,
    duration_ms: int,
    row_count: int = 0,
    error: str = "",
    message: str = "",
) -> None:
    _ensure_runs_loaded_locked()
    entry = {
        "id": run_id,
        "schedule_id": schedule_id,
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "status": status,
        "duration_ms": duration_ms,
        "row_count": row_count,
        "error": error,
        "message": message,
    }
    history = _runs.setdefault(schedule_id, [])
    history.insert(0, entry)
    del history[RUN_HISTORY_PER_SCHEDULE:]
    _persist_runs_locked()


# ---------------------------------------------------------------------------
# public read/write API used by the router
# ---------------------------------------------------------------------------

def load_schedules() -> list[dict]:
    """Every schedule definition, as stored."""
    with _LOCK:
        _ensure_items_loaded_locked()
        return copy.deepcopy(_items)


def create_schedule(data: ScheduleCreate) -> dict:
    """Append a new schedule and compute its first fire time."""
    with _LOCK:
        _ensure_items_loaded_locked()
        now = _now()
        item = {
            "id": uuid.uuid4().hex[:12],
            "name": data.name,
            "description": data.description or "",
            "enabled": data.enabled,
            "target": data.target.model_dump(),
            "trigger": data.trigger.model_dump(),
            "output": data.output.model_dump(),
            "created_at": now.isoformat(),
            "updated_at": now.isoformat(),
            "next_run_at": compute_next_run(data.trigger, now).isoformat(),
            "last_run_at": None,
            "last_status": None,
            "last_error": None,
            "last_duration_ms": None,
            "run_count": 0,
            "failure_count": 0,
            "consecutive_failures": 0,
        }
        _items.append(item)
        _persist_items_locked()
        return copy.deepcopy(item)


def update_schedule(schedule_id: str, data: ScheduleUpdate) -> dict:
    """Patch a schedule; recompute the next fire time when the trigger changes."""
    with _LOCK:
        _ensure_items_loaded_locked()
        item = _find_locked(schedule_id)
        if item is None:
            raise KeyError(schedule_id)
        updates = data.model_dump(exclude_unset=True)
        for key in ("name", "description", "enabled"):
            if key in updates:
                item[key] = updates[key]
        if "target" in updates:
            item["target"] = Target.model_validate(updates["target"]).model_dump()
        trigger_changed = False
        if "trigger" in updates:
            item["trigger"] = Trigger.model_validate(updates["trigger"]).model_dump()
            trigger_changed = True
        if "output" in updates:
            item["output"] = OutputSpec.model_validate(updates["output"]).model_dump()
        item["updated_at"] = _now().isoformat()
        if trigger_changed:
            item["next_run_at"] = compute_next_run(
                Trigger.model_validate(item["trigger"]), _now()
            ).isoformat()
        _persist_items_locked()
        return copy.deepcopy(item)


def delete_schedule(schedule_id: str) -> None:
    """Remove a schedule and its run history."""
    with _LOCK:
        _ensure_items_loaded_locked()
        item = _find_locked(schedule_id)
        if item is None:
            raise KeyError(schedule_id)
        _items.remove(item)
        _ensure_runs_loaded_locked()
        if _runs.pop(schedule_id, None) is not None:
            _persist_runs_locked()
        _deferred_since.pop(schedule_id, None)
        _persist_items_locked()


def run_now(schedule_id: str) -> dict:
    """Queue an immediate manual run (works even when the schedule is disabled)."""
    with _LOCK:
        _ensure_items_loaded_locked()
        item = _find_locked(schedule_id)
        if item is None:
            raise KeyError(schedule_id)
        snapshot = copy.deepcopy(item)
    _dispatch(snapshot, manual=True)
    return {"queued": True}


def list_runs(schedule_id: Optional[str] = None, limit: int = 50) -> list[dict]:
    """Run history, newest first, across all schedules or one of them."""
    with _LOCK:
        _ensure_runs_loaded_locked()
        if schedule_id is not None:
            return copy.deepcopy(_runs.get(schedule_id, [])[:limit])
        merged = [run for history in _runs.values() for run in history]
    merged.sort(key=lambda run: run.get("started_at") or "", reverse=True)
    return merged[:limit]


# ---------------------------------------------------------------------------
# execution
# ---------------------------------------------------------------------------

def _lookup(filename: str, entry_id: Optional[str], label: str) -> dict:
    entries = storage.load_json(filename, [])
    entry = next((e for e in entries if isinstance(e, dict) and e.get("id") == entry_id), None)
    if entry is None:
        raise RuntimeError(f"{label} '{entry_id}' no longer exists")
    return entry


def _execute(schedule: dict) -> tuple[int, str]:
    """Run one schedule once; return ``(row_count, message)`` or raise on failure."""
    target = Target.model_validate(schedule.get("target") or {})
    output = OutputSpec.model_validate(schedule.get("output") or {})

    columns: list[dict] = []
    rows: list[dict] = []
    sql_text: Optional[str] = None
    connection_id = target.connection_id
    message = ""

    if target.kind == "query":
        entry = _lookup(_SAVED_QUERIES_FILE, target.query_id, "Saved query")
        definition = queries_api.QueryDef.model_validate(entry.get("query") or {})
        rows, columns, sql_text = queries_api.fetch_rows(query=definition, limit=output.row_cap)
        connection_id = connection_id or definition.connection_id
    elif target.kind == "sql":
        rows, columns, sql_text = queries_api.fetch_rows(
            sql=target.sql or "", connection_id=connection_id, limit=output.row_cap
        )
    elif target.kind == "sql_saved":
        entry = _lookup(_SQL_QUERIES_FILE, target.sql_query_id, "SQL query")
        sql_text = str(entry.get("sql") or "")
        connection_id = connection_id or entry.get("connection_id")
        rows, columns, _ = queries_api.fetch_rows(
            sql=sql_text, connection_id=connection_id, limit=output.row_cap
        )
    elif target.kind == "script":
        entry = _lookup(_SCRIPTS_FILE, target.script_id, "Script")
        payload = scripts_api.ScriptRunRequest(
            language=entry.get("language") or "python",
            script=entry.get("script") or "",
            query=entry.get("query"),
            sql=entry.get("sql"),
            connection_id=connection_id or entry.get("connection_id"),
            timeout_seconds=target.timeout_seconds,
        )
        result = scripts_api.run_script(payload)
        if not result.get("ok"):
            detail = (result.get("stderr") or "").strip() or result.get("message") or "Script failed"
            raise RuntimeError(detail)
        rows = []
        message = (result.get("stdout") or "").strip()[:2000]
        return int(result.get("row_count") or 0), message
    elif target.kind == "script_template":
        # Templates are resolved by name at run time, so a published fix reaches
        # every schedule without editing it.
        try:
            template = scripts_api.get_script_template(target.template_name or "")
        except Exception as exc:
            raise RuntimeError(f"Template '{target.template_name}' is unavailable: {exc}") from exc
        payload = scripts_api.ScriptRunRequest(
            language="python",
            script=str(template.get("content") or ""),
            connection_id=connection_id,
            timeout_seconds=target.timeout_seconds,
        )
        result = scripts_api.run_script(payload)
        if not result.get("ok"):
            detail = (result.get("stderr") or "").strip() or result.get("message") or "Script failed"
            raise RuntimeError(detail)
        message = (result.get("stdout") or "").strip()[:2000]
        return int(result.get("row_count") or 0), message
    else:  # pragma: no cover - Target validates the literal set
        raise RuntimeError(f"Unsupported target kind {target.kind!r}")

    if output.mode == "snapshot":
        name = output.snapshot_name or schedule.get("name") or "Scheduled snapshot"
        warehouse.create_snapshot(
            name=name,
            source="schedule",
            connection_id=connection_id,
            sql_text=sql_text,
            columns=columns,
            rows=rows,
        )
        message = f"{len(rows)} rows saved to the warehouse"

    return len(rows), message


def _dispatch(schedule: dict, manual: bool = False) -> None:
    """Submit a run to the executor, enforcing single-flight per schedule."""
    schedule_id = schedule.get("id")
    if not schedule_id:
        return
    executor = _executor
    if executor is None:
        return
    with _RUN_LOCK:
        if schedule_id in _inflight:
            return
        _inflight.add(schedule_id)
    try:
        executor.submit(_run_and_record, schedule, manual)
    except RuntimeError:  # executor already shut down
        with _RUN_LOCK:
            _inflight.discard(schedule_id)


def _run_and_record(schedule: dict, manual: bool = False) -> None:
    """Execute a schedule, then fold the outcome back into its definition."""
    schedule_id = schedule["id"]
    started = _now()
    run_id = uuid.uuid4().hex[:12]
    status = "failed"
    error = ""
    message = ""
    row_count = 0
    try:
        row_count, message = _execute(schedule)
        status = "success"
    except Exception as exc:  # noqa: BLE001 - any failure becomes a run record
        error = str(exc) or exc.__class__.__name__
        logging_utils.log_error("schedule.run", f"schedule={schedule_id} failed", details=error)
    finished = _now()
    duration_ms = int((finished - started).total_seconds() * 1000)

    with _LOCK:
        _ensure_items_loaded_locked()
        item = _find_locked(schedule_id)
        if item is not None:
            item["last_run_at"] = started.isoformat()
            item["last_status"] = status
            item["last_error"] = error or None
            item["last_duration_ms"] = duration_ms
            item["run_count"] = int(item.get("run_count") or 0) + 1
            if status == "failed":
                item["failure_count"] = int(item.get("failure_count") or 0) + 1
                item["consecutive_failures"] = int(item.get("consecutive_failures") or 0) + 1
            else:
                item["consecutive_failures"] = 0
            item["updated_at"] = finished.isoformat()
            if not manual:
                trigger = Trigger.model_validate(item["trigger"])
                failures = int(item.get("consecutive_failures") or 0)
                if status == "failed" and failures <= MAX_RETRIES:
                    delay = min(RETRY_BASE_SECONDS * (2 ** (failures - 1)), RETRY_MAX_SECONDS)
                    item["next_run_at"] = (finished + timedelta(seconds=delay)).isoformat()
                else:
                    item["next_run_at"] = compute_next_run(trigger, finished).isoformat()
        _record_run_locked(
            schedule_id,
            run_id=run_id,
            started_at=started,
            finished_at=finished,
            status=status,
            duration_ms=duration_ms,
            row_count=row_count,
            error=error,
            message=message,
        )
    with _RUN_LOCK:
        _inflight.discard(schedule_id)


# ---------------------------------------------------------------------------
# the tick loop
# ---------------------------------------------------------------------------

def _system_busy() -> bool:
    """True while the app is serving a request or installing an update.

    A scheduled run must never cut into a user's in-flight query or an update
    in progress, so due work defers until the app is quiet again.
    """
    try:
        from app import main, update  # deferred: avoid an import cycle at startup

        return main.inflight_count() > 0 or update._busy()
    except Exception:  # noqa: BLE001 - never let a guard failure stop the tick
        return False


def _sweep_interrupted_locked() -> None:
    """Mark runs left ``running`` by a previous session as ``interrupted``."""
    _ensure_runs_loaded_locked()
    changed = False
    for history in _runs.values():
        for run in history:
            if run.get("status") == "running":
                run["status"] = "interrupted"
                run["error"] = run.get("error") or "The app closed while this run was in progress"
                changed = True
    if changed:
        _persist_runs_locked()


def _tick() -> None:
    now = _now()
    busy = _system_busy()
    ready: list[dict] = []

    with _LOCK:
        _ensure_items_loaded_locked()
        for item in _items:
            schedule_id = item.get("id")
            if not schedule_id:
                continue
            if not item.get("enabled"):
                _deferred_since.pop(schedule_id, None)
                continue

            next_run = _parse_dt(item.get("next_run_at"))
            if next_run is None:
                # Missing/corrupt timestamp: recompute rather than skip forever.
                item["next_run_at"] = compute_next_run(
                    Trigger.model_validate(item["trigger"]), now
                ).isoformat()
                continue
            if next_run > now:
                _deferred_since.pop(schedule_id, None)
                continue

            # Backward clock jump: a run already fired very recently.
            last_run = _parse_dt(item.get("last_run_at"))
            if last_run and (now - last_run).total_seconds() < RECENCY_GUARD_SECONDS:
                item["next_run_at"] = compute_next_run(
                    Trigger.model_validate(item["trigger"]), now
                ).isoformat()
                _deferred_since.pop(schedule_id, None)
                continue

            trigger = Trigger.model_validate(item["trigger"])

            if now - next_run > STALENESS_WINDOW:
                item["next_run_at"] = compute_next_run(trigger, now).isoformat()
                item["last_status"] = "missed"
                item["last_error"] = "Missed while the app was closed"
                item["updated_at"] = now.isoformat()
                _deferred_since.pop(schedule_id, None)
                _record_run_locked(
                    schedule_id,
                    run_id=uuid.uuid4().hex[:12],
                    started_at=next_run,
                    finished_at=now,
                    status="missed",
                    duration_ms=0,
                    error="Missed while the app was closed",
                )
                continue

            if busy:
                since = _deferred_since.setdefault(schedule_id, now)
                if now - since < DEFER_CAP:
                    continue  # leave next_run_at alone; retry on the next tick
                item["next_run_at"] = compute_next_run(trigger, now).isoformat()
                item["last_status"] = "missed"
                item["last_error"] = "Skipped: the app stayed busy past the deferral window"
                item["updated_at"] = now.isoformat()
                _deferred_since.pop(schedule_id, None)
                _record_run_locked(
                    schedule_id,
                    run_id=uuid.uuid4().hex[:12],
                    started_at=next_run,
                    finished_at=now,
                    status="missed",
                    duration_ms=0,
                    error="Skipped: the app stayed busy past the deferral window",
                )
                continue

            _deferred_since.pop(schedule_id, None)
            # Write the next fire time forward *before* dispatching so a crash
            # mid-run cannot make it fire twice on the next launch.
            item["next_run_at"] = compute_next_run(trigger, now).isoformat()
            ready.append(copy.deepcopy(item))
        _persist_items_locked()

    for item in ready:
        _dispatch(item)


def _loop() -> None:
    if _stop.wait(FIRST_TICK_DELAY_SECONDS):
        return
    while not _stop.is_set():
        try:
            _tick()
        except Exception as exc:  # noqa: BLE001 - a bad tick must not kill the loop
            logging_utils.log_error("schedule.tick", "scheduler tick failed", details=str(exc))
        if _stop.wait(TICK_INTERVAL_SECONDS):
            return


def start_scheduler() -> None:
    """Start the runner thread (idempotent)."""
    global _executor, _thread
    if _thread is not None and _thread.is_alive():
        return
    with _LOCK:
        _ensure_items_loaded_locked()
        _sweep_interrupted_locked()
    _stop.clear()
    if _executor is None:
        _executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_RUNS, thread_name_prefix="schedule-run")
    _thread = threading.Thread(target=_loop, daemon=True, name="schedule-runner")
    _thread.start()


def stop_scheduler() -> None:
    """Signal the runner to stop; the daemon thread and executor follow the process."""
    _stop.set()
