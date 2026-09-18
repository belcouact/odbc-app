"""API routes for saving and loading saved queries."""
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import storage

router = APIRouter()

_SAVED_FILE = "saved_queries.json"


class SavedQueryCreate(BaseModel):
    """Body for POST /saved-queries."""

    name: str = Field(min_length=1)
    description: Optional[str] = None
    query: dict[str, Any]
    parameters: list[dict[str, Any]] = []


class SavedQueryUpdate(BaseModel):
    """Body for PUT /saved-queries/{id}."""

    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    query: Optional[dict[str, Any]] = None
    parameters: Optional[list[dict[str, Any]]] = None


def _load_saved() -> list:
    return storage.load_json(_SAVED_FILE, [])


def _save_saved(saved: list) -> None:
    storage.save_json(_SAVED_FILE, saved)


def _find_saved(saved: list, query_id: str) -> dict | None:
    return next((q for q in saved if q.get("id") == query_id), None)


@router.get("/saved-queries")
def list_saved_queries():
    """Return all saved queries."""
    return _load_saved()


@router.post("/saved-queries", status_code=201)
def create_saved_query(payload: SavedQueryCreate):
    """Save a new query definition."""
    saved = _load_saved()
    obj = {
        "id": uuid.uuid4().hex,
        "name": payload.name,
        "description": payload.description or "",
        "query": payload.query,
        "parameters": payload.parameters,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    saved.append(obj)
    _save_saved(saved)
    return obj


@router.put("/saved-queries/{query_id}")
def update_saved_query(query_id: str, payload: SavedQueryUpdate):
    """Update a saved query's name and/or definition."""
    saved = _load_saved()
    obj = _find_saved(saved, query_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"Saved query '{query_id}' not found")
    updates = payload.model_dump(exclude_unset=True)
    obj.update(updates)
    _save_saved(saved)
    return obj


@router.delete("/saved-queries/{query_id}")
def delete_saved_query(query_id: str):
    """Delete a saved query."""
    saved = _load_saved()
    obj = _find_saved(saved, query_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"Saved query '{query_id}' not found")
    saved.remove(obj)
    _save_saved(saved)
    return {"ok": True}
