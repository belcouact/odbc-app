"""API routes for the in-app scheduler.

Every mutation is delegated to :mod:`app.scheduler`, which owns the on-disk
``schedules.json`` under a single lock — this router never writes that file
directly, so the API and the runner thread cannot corrupt each other's writes.
"""
from __future__ import annotations

import copy
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app import scheduler, storage
from app.schedule_model import ScheduleCreate, ScheduleUpdate

router = APIRouter()

_SAVED_QUERIES_FILE = "saved_queries.json"
_SQL_QUERIES_FILE = "sql_queries.json"
_SCRIPTS_FILE = "scripts.json"


def _view(item: dict) -> dict:
    """The schedule as the board needs it (already stored in this shape)."""
    return copy.deepcopy(item)


def _get_or_404(schedule_id: str) -> dict:
    for item in scheduler.load_schedules():
        if item.get("id") == schedule_id:
            return item
    raise HTTPException(status_code=404, detail=f"Schedule '{schedule_id}' not found")


@router.get("/schedules/meta/sources")
def list_schedule_sources() -> dict:
    """The pickers' contents for the editor: connections and runnable sources.

    Reads the existing stores directly so a schedule can point at anything the
    user already saved, without duplicating those definitions.
    """
    from app.api import scripts as scripts_api  # deferred: import cycle
    from app.api.connections import load_stored_connections  # deferred: import cycle

    return {
        "connections": [
            {"id": conn.get("id"), "name": conn.get("name") or conn.get("id")}
            for conn in load_stored_connections()
        ],
        "saved_queries": [
            {"id": q.get("id"), "name": q.get("name") or q.get("id")}
            for q in storage.load_json(_SAVED_QUERIES_FILE, [])
        ],
        "sql_queries": [
            {"id": q.get("id"), "name": q.get("name") or (q.get("sql") or "")[:40]}
            for q in storage.load_json(_SQL_QUERIES_FILE, [])
        ],
        "scripts": [
            {
                "id": s.get("id"),
                "name": s.get("name") or s.get("id"),
                "language": s.get("language") or "python",
            }
            for s in storage.load_json(_SCRIPTS_FILE, [])
        ],
        "templates": [
            {"name": item.get("name"), "title": item.get("title") or item.get("name")}
            for item in scripts_api.list_script_templates()
        ],
    }


@router.get("/schedules/runs")
def list_all_runs(limit: int = Query(default=50, ge=1, le=500)) -> list[dict]:
    """Run history across every schedule, newest first."""
    return scheduler.list_runs(limit=limit)


@router.get("/schedules")
def list_schedules() -> list[dict]:
    """Every schedule, newest-created last."""
    return [_view(item) for item in scheduler.load_schedules()]


@router.post("/schedules", status_code=201)
def create_schedule(payload: ScheduleCreate) -> dict:
    """Create a schedule and compute its first fire time."""
    return _view(scheduler.create_schedule(payload))


@router.get("/schedules/{schedule_id}")
def get_schedule(schedule_id: str) -> dict:
    """One schedule by id."""
    return _view(_get_or_404(schedule_id))


@router.put("/schedules/{schedule_id}")
def update_schedule(schedule_id: str, payload: ScheduleUpdate) -> dict:
    """Edit a schedule (partial update; the next fire time follows the trigger)."""
    try:
        return _view(scheduler.update_schedule(schedule_id, payload))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Schedule '{schedule_id}' not found") from exc


@router.delete("/schedules/{schedule_id}")
def delete_schedule(schedule_id: str) -> dict:
    """Delete a schedule and its run history."""
    try:
        scheduler.delete_schedule(schedule_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Schedule '{schedule_id}' not found") from exc
    return {"ok": True}


@router.post("/schedules/{schedule_id}/run")
def run_schedule_now(schedule_id: str) -> dict:
    """Queue an immediate manual run, even when the schedule is disabled."""
    try:
        return scheduler.run_now(schedule_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Schedule '{schedule_id}' not found") from exc


@router.get("/schedules/{schedule_id}/runs")
def list_schedule_runs(
    schedule_id: str, limit: int = Query(default=50, ge=1, le=500)
) -> list[dict]:
    """Run history for one schedule, newest first."""
    _get_or_404(schedule_id)
    return scheduler.list_runs(schedule_id=schedule_id, limit=limit)
