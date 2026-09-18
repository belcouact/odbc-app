"""Persistent JSON application logging.

All application activity is recorded into ``logs.json`` under APP_DATA_DIR so
users can browse and delete log entries by date range via ``/api/logs``.

Two independent paths write entries:

* :func:`log_info` / :func:`log_warning` / :func:`log_error` build a dict and
  call :func:`append_log` directly (used by the request middleware and API
  endpoints — most reliable).
* :func:`setup_logging` wires the standard :mod:`logging` module so any code
  calling ``logging.getLogger("app...").info/warning/error`` is also captured.
"""
import logging
import re
import threading
import traceback
import uuid
from datetime import datetime, time, timezone

from app import storage

LOGS_FILE = "logs.json"
MAX_ENTRIES = 5000

_LOCK = threading.Lock()
_APP_HANDLER = None
_STREAM_HANDLER = None

_DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _make_entry(source: str, message: str, level: str, details=None, **extra) -> dict:
    """Build a single log entry dict with all standard fields."""
    entry = {
        "id": uuid.uuid4().hex,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "source": str(source or ""),
        "message": str(message or ""),
        "details": details if details is not None else None,
        "method": None,
        "path": None,
        "status": None,
        "duration_ms": None,
    }
    for key in ("method", "path", "status", "duration_ms"):
        if key in extra:
            entry[key] = extra[key]
    return entry


def append_log(entry: dict) -> None:
    """Append one entry to logs.json (thread-safe), capped at MAX_ENTRIES.

    Never raises: persistence failures are swallowed so logging can never
    break application flow.
    """
    if not isinstance(entry, dict):
        return
    with _LOCK:
        try:
            entries = storage.load_json(LOGS_FILE, [])
            if not isinstance(entries, list):
                entries = []
            entries.append(entry)
            if len(entries) > MAX_ENTRIES:
                entries = entries[-MAX_ENTRIES:]
            storage.save_json(LOGS_FILE, entries)
        except Exception:
            pass


def log_info(source: str, message: str, **extra) -> None:
    append_log(_make_entry(source, message, "INFO", **extra))


def log_warning(source: str, message: str, **extra) -> None:
    append_log(_make_entry(source, message, "WARNING", **extra))


def log_error(source: str, message: str, **extra) -> None:
    append_log(_make_entry(source, message, "ERROR", **extra))


def _local_tz():
    """Return the local timezone (DST-aware for the current date)."""
    return datetime.now().astimezone().tzinfo


def _parse_bound(value, is_start: bool) -> datetime | None:
    """Parse a from/to query bound into an aware UTC datetime, or None.

    * ``YYYY-MM-DD``            -> local start-of-day / end-of-day
    * full ISO datetime (naive) -> treated as local time
    * full ISO datetime (aware) -> converted to UTC
    """
    if value is None:
        return None
    raw = str(value).strip()
    if raw == "":
        return None
    try:
        if _DATE_ONLY_RE.match(raw):
            dt = datetime.strptime(raw, "%Y-%m-%d")
            dt = dt.replace(
                hour=0, minute=0, second=0, microsecond=0
            ) if is_start else dt.replace(
                hour=23, minute=59, second=59, microsecond=999999
            )
        else:
            dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_local_tz())
    return dt.astimezone(timezone.utc)


def _entry_timestamp(entry: dict) -> datetime:
    """Parse an entry timestamp to an aware UTC datetime (UTC if naive)."""
    try:
        dt = datetime.fromisoformat(str(entry.get("timestamp") or ""))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def list_logs(frm=None, to=None, level=None, limit=200, offset=0) -> tuple[list, int]:
    """Return (page, total) of log entries.

    Filters by optional [frm, to] timestamp range and exact upper-cased level.
    Page is sorted newest-first; total is the filtered count before pagination.
    """
    entries = storage.load_json(LOGS_FILE, [])
    if not isinstance(entries, list):
        entries = []
    frm_ts = _parse_bound(frm, is_start=True)
    to_ts = _parse_bound(to, is_start=False)
    level_filter = str(level or "").strip().upper() or None

    filtered = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        ts = _entry_timestamp(entry)
        if frm_ts is not None and ts < frm_ts:
            continue
        if to_ts is not None and ts > to_ts:
            continue
        if level_filter is not None and str(entry.get("level") or "").upper() != level_filter:
            continue
        filtered.append(entry)

    total = len(filtered)
    filtered.sort(key=_entry_timestamp, reverse=True)
    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))
    return filtered[offset:offset + limit], total


def delete_logs(frm=None, to=None) -> int:
    """Delete entries within [frm, to]; with both bounds absent, delete all.

    Returns the number of entries deleted.
    """
    entries = storage.load_json(LOGS_FILE, [])
    if not isinstance(entries, list):
        entries = []
    frm_empty = frm is None or str(frm).strip() == ""
    to_empty = to is None or str(to).strip() == ""
    if frm_empty and to_empty:
        count = len(entries)
        storage.save_json(LOGS_FILE, [])
        return count

    frm_ts = _parse_bound(frm, is_start=True)
    to_ts = _parse_bound(to, is_start=False)
    kept = []
    deleted = 0
    for entry in entries:
        if not isinstance(entry, dict):
            kept.append(entry)
            continue
        ts = _entry_timestamp(entry)
        in_range = True
        if frm_ts is not None and ts < frm_ts:
            in_range = False
        if to_ts is not None and ts > to_ts:
            in_range = False
        if in_range:
            deleted += 1
        else:
            kept.append(entry)
    storage.save_json(LOGS_FILE, kept)
    return deleted


class _JsonLogHandler(logging.Handler):
    """logging.Handler that persists records into logs.json via append_log."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            details = traceback.format_exc() if record.exc_info else None
            append_log(
                _make_entry(
                    record.name,
                    record.getMessage(),
                    record.levelname,
                    details=details,
                )
            )
        except Exception:
            pass


def setup_logging() -> None:
    """Wire the standard logging module for the "app" logger hierarchy.

    Idempotent: safe to call multiple times (e.g. under uvicorn --reload).
    Also prints INFO+ to the console so dev output is preserved.
    """
    global _APP_HANDLER, _STREAM_HANDLER
    logger = logging.getLogger("app")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if _APP_HANDLER is None:
        _APP_HANDLER = _JsonLogHandler()
        logger.addHandler(_APP_HANDLER)
    if _STREAM_HANDLER is None:
        _STREAM_HANDLER = logging.StreamHandler()
        _STREAM_HANDLER.setLevel(logging.INFO)
        logger.addHandler(_STREAM_HANDLER)
