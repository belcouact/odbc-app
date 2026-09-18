"""API routes for query execution history.

Entries are stored newest-first in ``history.json`` (capped at 200) and are
appended automatically after every successful run of POST /query/run and
POST /sql/run via :func:`add_history_entry`.
"""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app import storage

router = APIRouter()

_HISTORY_FILE = "history.json"
_HISTORY_CAP = 200


def _load_history() -> list:
    return storage.load_json(_HISTORY_FILE, [])


def _save_history(entries: list) -> None:
    storage.save_json(_HISTORY_FILE, entries)


def add_history_entry(
    connection_id: str,
    kind: str,
    sql: str,
    query: dict | None,
    row_count: int,
    elapsed_ms: int,
) -> None:
    """Append a history entry for a successful query run (newest first)."""
    connections = storage.load_json("connections.json", [])
    name = next(
        (c.get("name", "") for c in connections if c.get("id") == connection_id),
        "",
    )
    entries = _load_history()
    entries.insert(
        0,
        {
            "id": uuid.uuid4().hex,
            "connection_id": connection_id,
            "connection_name": name,
            "kind": kind,
            "sql": sql,
            "query": query,
            "row_count": row_count,
            "elapsed_ms": elapsed_ms,
            "executed_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    _save_history(entries[:_HISTORY_CAP])


@router.get("/history")
def list_history(limit: Optional[int] = Query(default=50, ge=1, le=500)):
    """Return the most recent ``limit`` history entries (newest first)."""
    return _load_history()[:limit]


@router.delete("/history/{history_id}")
def delete_history_entry(history_id: str):
    """Delete a single history entry."""
    entries = _load_history()
    obj = next((e for e in entries if e.get("id") == history_id), None)
    if obj is None:
        raise HTTPException(
            status_code=404, detail=f"History entry '{history_id}' not found"
        )
    entries.remove(obj)
    _save_history(entries)
    return {"ok": True}


@router.delete("/history")
def clear_history():
    """Clear all history entries."""
    _save_history([])
    return {"ok": True}
