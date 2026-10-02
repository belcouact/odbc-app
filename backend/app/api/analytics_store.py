"""API routes for the local BI warehouse.

Snapshots are query results the user chose to keep, stored in a per-machine
SQLite file (see :mod:`app.warehouse`) so they can be charted and reported on
long after the source connection is gone.
"""
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import warehouse

router = APIRouter()


class SnapshotCreate(BaseModel):
    """Body for POST /analytics/snapshots."""

    name: str = Field(min_length=1)
    # Where the rows came from: 'builder' | 'sql' | 'upload' | 'template'.
    source: str = "grid"
    connection_id: Optional[str] = None
    sql_text: Optional[str] = None
    columns: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []


class SnapshotRename(BaseModel):
    """Body for PUT /analytics/snapshots/{id}."""

    name: str = Field(min_length=1)


class SnapshotData(BaseModel):
    """Body for PUT /analytics/snapshots/{id}/data — replace the stored rows."""

    # Where the rows came from: 'builder' | 'sql' | 'upload' | 'template'.
    source: str = "grid"
    connection_id: Optional[str] = None
    sql_text: Optional[str] = None
    columns: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []


class DashboardSave(BaseModel):
    """Body for PUT /analytics/snapshots/{id}/dashboard.

    The visual shape is owned by the frontend (chart type + field / aggregation
    config), so the payload is passed through as opaque JSON.
    """

    visuals: list[dict[str, Any]] = []


class RelationshipSave(BaseModel):
    """Body for POST /analytics/relationships and PUT .../relationships/{id}.

    Links two warehouse snapshots on one column pair so the BI page can drill
    across tables. ``join_type`` is 'left' (keep unmatched left rows) or
    'inner' (drop them); the preview endpoint honors it.
    """

    name: str = Field(default="")
    left_snapshot_id: str = Field(min_length=1)
    left_column: str = Field(min_length=1)
    join_type: str = Field(default="left", pattern="^(left|inner)$")
    right_snapshot_id: str = Field(min_length=1)
    right_column: str = Field(min_length=1)


@router.get("/analytics/warehouse")
def get_warehouse_info():
    """Location and size of the local warehouse database."""
    return warehouse.warehouse_info()


@router.get("/analytics/snapshots")
def list_snapshots():
    """All stored snapshots, newest first (row payloads excluded)."""
    return warehouse.list_snapshots()


@router.post("/analytics/snapshots", status_code=201)
def create_snapshot(payload: SnapshotCreate):
    """Store a query result as a new snapshot."""
    return warehouse.create_snapshot(
        name=payload.name,
        source=payload.source,
        connection_id=payload.connection_id,
        sql_text=payload.sql_text,
        columns=payload.columns,
        rows=payload.rows,
    )


@router.get("/analytics/snapshots/{snapshot_id}")
def get_snapshot(snapshot_id: str):
    """A snapshot with all of its rows."""
    snapshot = warehouse.get_snapshot(snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail=f"Snapshot '{snapshot_id}' not found")
    return snapshot


@router.put("/analytics/snapshots/{snapshot_id}")
def rename_snapshot(snapshot_id: str, payload: SnapshotRename):
    """Rename a snapshot."""
    updated = warehouse.rename_snapshot(snapshot_id, payload.name)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Snapshot '{snapshot_id}' not found")
    return updated


@router.put("/analytics/snapshots/{snapshot_id}/data")
def update_snapshot_data(snapshot_id: str, payload: SnapshotData):
    """Replace a snapshot's stored rows with a fresh result set.

    The snapshot id, name and dashboard are kept, so its charts survive the
    refresh.
    """
    updated = warehouse.update_snapshot_data(
        snapshot_id,
        source=payload.source,
        connection_id=payload.connection_id,
        sql_text=payload.sql_text,
        columns=payload.columns,
        rows=payload.rows,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Snapshot '{snapshot_id}' not found")
    return updated


@router.delete("/analytics/snapshots/{snapshot_id}")
def delete_snapshot(snapshot_id: str):
    """Delete a snapshot and all of its rows."""
    if not warehouse.delete_snapshot(snapshot_id):
        raise HTTPException(status_code=404, detail=f"Snapshot '{snapshot_id}' not found")
    return {"ok": True}


@router.get("/analytics/snapshots/{snapshot_id}/dashboard")
def get_dashboard(snapshot_id: str):
    """The snapshot's dashboard visuals (empty list when none were pinned yet)."""
    dashboard = warehouse.get_dashboard(snapshot_id)
    if dashboard is None:
        raise HTTPException(status_code=404, detail=f"Snapshot '{snapshot_id}' not found")
    return dashboard


@router.put("/analytics/snapshots/{snapshot_id}/dashboard")
def save_dashboard(snapshot_id: str, payload: DashboardSave):
    """Replace the snapshot's dashboard visuals."""
    dashboard = warehouse.save_dashboard(snapshot_id, payload.visuals)
    if dashboard is None:
        raise HTTPException(status_code=404, detail=f"Snapshot '{snapshot_id}' not found")
    return dashboard


# ---- Relationships between warehouse snapshots ----


@router.get("/analytics/relationships")
def list_relationships():
    """All stored relationships (with both tables' display names)."""
    return warehouse.list_relationships()


@router.post("/analytics/relationships", status_code=201)
def create_relationship(payload: RelationshipSave):
    """Store a new relationship between two snapshots."""
    return warehouse.create_relationship(
        name=payload.name,
        left_snapshot_id=payload.left_snapshot_id,
        left_column=payload.left_column,
        join_type=payload.join_type,
        right_snapshot_id=payload.right_snapshot_id,
        right_column=payload.right_column,
    )


@router.put("/analytics/relationships/{relationship_id}")
def update_relationship(relationship_id: str, payload: RelationshipSave):
    """Replace a relationship's definition."""
    updated = warehouse.update_relationship(
        relationship_id,
        name=payload.name,
        left_snapshot_id=payload.left_snapshot_id,
        left_column=payload.left_column,
        join_type=payload.join_type,
        right_snapshot_id=payload.right_snapshot_id,
        right_column=payload.right_column,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Relationship '{relationship_id}' not found")
    return updated


@router.delete("/analytics/relationships/{relationship_id}")
def delete_relationship(relationship_id: str):
    """Delete a relationship (the snapshots themselves are untouched)."""
    if not warehouse.delete_relationship(relationship_id):
        raise HTTPException(status_code=404, detail=f"Relationship '{relationship_id}' not found")
    return {"ok": True}


@router.get("/analytics/relationships/{relationship_id}/preview")
def preview_relationship(relationship_id: str, limit: int = 500):
    """Flat join preview of the two snapshots (client-side drill uses get_snapshot)."""
    limit = max(1, min(limit, 5000))
    preview = warehouse.preview_relationship_join(relationship_id, limit=limit)
    if preview is None:
        raise HTTPException(status_code=404, detail=f"Relationship '{relationship_id}' not found")
    return preview
