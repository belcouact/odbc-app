"""SQLite warehouse for query snapshots.

Two very different kinds of SQLite data live in this app:

* the *reference* data (Pantone TCX) ships read-only inside the bundle and is
  identical on every machine;
* the *warehouse* below is the opposite: per-machine, writable, and expected to
  diverge between users.

They are therefore separate files with separate lifecycles. This module owns
the second one and lives under ``%APPDATA%`` so that installing an app update
(single-file exe) never touches the user's accumulated data.

A snapshot is deliberately append-only and schema-free: every row is stored as
a JSON object rather than into generated columns. Query results come from
arbitrary ODBC sources, so the column set changes from query to query, and
storing the payload as JSON keeps one snapshot of a 40-column LIMS extract and
one of a 3-column colour reading in the same table.

A dashboard is the second half of the BI story: the list of visuals (chart type
plus its field / aggregation config) the user pinned onto a snapshot. It is
stored per snapshot as one JSON document, so adding a visual property never
needs a schema migration -- the browser owns the visual shape.
"""
from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator, Optional

from app.config import APP_DATA_DIR

# Subdirectory rather than directly in APP_DATA_DIR: the JSON config files
# (connections, saved queries, ...) already live at the top level, and keeping
# the database files in one folder makes them easy to back up or delete.
WAREHOUSE_DIR = os.path.join(APP_DATA_DIR, "data")
WAREHOUSE_DB = os.path.join(WAREHOUSE_DIR, "warehouse.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS query_snapshots (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    source        TEXT NOT NULL,
    connection_id TEXT,
    sql_text      TEXT,
    row_count     INTEGER NOT NULL,
    columns_json  TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_rows (
    snapshot_id TEXT NOT NULL,
    row_index   INTEGER NOT NULL,
    data        TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, row_index),
    FOREIGN KEY (snapshot_id) REFERENCES query_snapshots (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshot_rows_snapshot
    ON snapshot_rows (snapshot_id, row_index);

CREATE TABLE IF NOT EXISTS dashboards (
    snapshot_id     TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES query_snapshots (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshot_relationships (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    left_snapshot_id  TEXT NOT NULL,
    left_column       TEXT NOT NULL,
    join_type         TEXT NOT NULL,
    right_snapshot_id TEXT NOT NULL,
    right_column      TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    FOREIGN KEY (left_snapshot_id) REFERENCES query_snapshots (id) ON DELETE CASCADE,
    FOREIGN KEY (right_snapshot_id) REFERENCES query_snapshots (id) ON DELETE CASCADE
);
"""

# Columns of a snapshot row payload must be valid JSON, but ODBC hands back
# things JSON cannot encode directly (datetime, Decimal, bytes). ``default=str``
# degrades those to their string form, which is what the grid shows anyway.
_JSON_KWARGS = {"ensure_ascii": False, "default": str}


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """Open the warehouse, creating the file and schema on first use."""
    os.makedirs(WAREHOUSE_DIR, exist_ok=True)
    conn = sqlite3.connect(WAREHOUSE_DB)
    try:
        conn.row_factory = sqlite3.Row
        # Snapshots cascade to their rows, so the pragma has to be on for every
        # connection -- it is not a persistent database setting.
        conn.execute("PRAGMA foreign_keys = ON")
        # WAL keeps a long snapshot insert from blocking the read that renders
        # the snapshot list.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(_SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _meta(row: sqlite3.Row | dict) -> dict[str, Any]:
    """Shape a query_snapshots row for the API (decoding the column list)."""
    item = dict(row)
    try:
        item["columns"] = json.loads(item.pop("columns_json"))
    except (KeyError, ValueError):
        item.setdefault("columns", [])
    return item


def create_snapshot(
    *,
    name: str,
    source: str,
    connection_id: Optional[str] = None,
    sql_text: Optional[str] = None,
    columns: Optional[list[dict[str, Any]]] = None,
    rows: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Persist a query result. Returns the stored snapshot's metadata."""
    columns = columns or []
    rows = rows or []
    snapshot_id = uuid.uuid4().hex
    created_at = _now()

    with connect() as conn:
        conn.execute(
            "INSERT INTO query_snapshots "
            "(id, name, source, connection_id, sql_text, row_count, columns_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                snapshot_id,
                name,
                source,
                connection_id,
                sql_text,
                len(rows),
                json.dumps(columns, **_JSON_KWARGS),
                created_at,
            ),
        )
        conn.executemany(
            "INSERT INTO snapshot_rows (snapshot_id, row_index, data) VALUES (?, ?, ?)",
            (
                (snapshot_id, index, json.dumps(row, **_JSON_KWARGS))
                for index, row in enumerate(rows)
            ),
        )

    return {
        "id": snapshot_id,
        "name": name,
        "source": source,
        "connection_id": connection_id,
        "sql_text": sql_text,
        "row_count": len(rows),
        "columns": columns,
        "created_at": created_at,
    }


def list_snapshots() -> list[dict[str, Any]]:
    """Newest first. Row payloads are excluded -- use get_snapshot for those."""
    with connect() as conn:
        cursor = conn.execute(
            "SELECT id, name, source, connection_id, sql_text, row_count, "
            "columns_json, created_at FROM query_snapshots ORDER BY created_at DESC"
        )
        return [_meta(row) for row in cursor.fetchall()]


def get_snapshot(snapshot_id: str) -> Optional[dict[str, Any]]:
    """A snapshot's metadata plus every stored row, or None when unknown."""
    with connect() as conn:
        row = conn.execute(
            "SELECT id, name, source, connection_id, sql_text, row_count, "
            "columns_json, created_at FROM query_snapshots WHERE id = ?",
            (snapshot_id,),
        ).fetchone()
        if row is None:
            return None

        snapshot = _meta(row)
        snapshot["rows"] = [
            json.loads(item["data"])
            for item in conn.execute(
                "SELECT data FROM snapshot_rows WHERE snapshot_id = ? ORDER BY row_index",
                (snapshot_id,),
            )
        ]
        return snapshot


def update_snapshot_data(
    snapshot_id: str,
    *,
    source: str,
    connection_id: Optional[str] = None,
    sql_text: Optional[str] = None,
    columns: Optional[list[dict[str, Any]]] = None,
    rows: Optional[list[dict[str, Any]]] = None,
) -> Optional[dict[str, Any]]:
    """Replace a snapshot's stored rows with a fresh result set.

    The snapshot keeps its id, name, creation time and dashboard, so a
    dashboard built on it survives a data refresh. Returns None when the id is
    unknown.
    """
    columns = columns or []
    rows = rows or []

    with connect() as conn:
        known = conn.execute(
            "SELECT created_at FROM query_snapshots WHERE id = ?", (snapshot_id,)
        ).fetchone()
        if known is None:
            return None

        conn.execute(
            "UPDATE query_snapshots SET source = ?, connection_id = ?, sql_text = ?, "
            "row_count = ?, columns_json = ? WHERE id = ?",
            (
                source,
                connection_id,
                sql_text,
                len(rows),
                json.dumps(columns, **_JSON_KWARGS),
                snapshot_id,
            ),
        )
        # Delete-then-insert rather than upsert: the old row count is unrelated
        # to the new one, so stale rows past the new end would otherwise linger.
        conn.execute("DELETE FROM snapshot_rows WHERE snapshot_id = ?", (snapshot_id,))
        conn.executemany(
            "INSERT INTO snapshot_rows (snapshot_id, row_index, data) VALUES (?, ?, ?)",
            (
                (snapshot_id, index, json.dumps(row, **_JSON_KWARGS))
                for index, row in enumerate(rows)
            ),
        )

        updated = conn.execute(
            "SELECT id, name, source, connection_id, sql_text, row_count, "
            "columns_json, created_at FROM query_snapshots WHERE id = ?",
            (snapshot_id,),
        ).fetchone()

    return _meta(updated)


def rename_snapshot(snapshot_id: str, name: str) -> Optional[dict[str, Any]]:
    """Rename a snapshot. Returns None when the id is unknown."""
    with connect() as conn:
        cursor = conn.execute(
            "UPDATE query_snapshots SET name = ? WHERE id = ?", (name, snapshot_id)
        )
        if cursor.rowcount == 0:
            return None
    return {"id": snapshot_id, "name": name}


def delete_snapshot(snapshot_id: str) -> bool:
    """Delete a snapshot and its rows. False when the id is unknown."""
    with connect() as conn:
        cursor = conn.execute("DELETE FROM query_snapshots WHERE id = ?", (snapshot_id,))
        return cursor.rowcount > 0


def get_dashboard(snapshot_id: str) -> Optional[dict[str, Any]]:
    """A snapshot's dashboard definition, or None when the snapshot is unknown.

    The definition is the list of visuals the user pinned from the chart
    builder. A snapshot that was never charted yet returns an empty list rather
    than an error, so "not configured" and "empty" look the same to the UI.
    """
    with connect() as conn:
        known = conn.execute(
            "SELECT 1 FROM query_snapshots WHERE id = ?", (snapshot_id,)
        ).fetchone()
        if known is None:
            return None
        row = conn.execute(
            "SELECT definition_json, updated_at FROM dashboards WHERE snapshot_id = ?",
            (snapshot_id,),
        ).fetchone()

    if row is None:
        return {"snapshot_id": snapshot_id, "visuals": [], "updated_at": None}
    try:
        visuals = json.loads(row["definition_json"])
    except ValueError:
        visuals = []
    return {
        "snapshot_id": snapshot_id,
        "visuals": visuals if isinstance(visuals, list) else [],
        "updated_at": row["updated_at"],
    }


def save_dashboard(
    snapshot_id: str, visuals: list[dict[str, Any]]
) -> Optional[dict[str, Any]]:
    """Replace a snapshot's dashboard definition. None when the snapshot is unknown."""
    updated_at = _now()
    with connect() as conn:
        known = conn.execute(
            "SELECT 1 FROM query_snapshots WHERE id = ?", (snapshot_id,)
        ).fetchone()
        if known is None:
            return None
        conn.execute(
            "INSERT INTO dashboards (snapshot_id, definition_json, updated_at) "
            "VALUES (?, ?, ?) ON CONFLICT (snapshot_id) DO UPDATE SET "
            "definition_json = excluded.definition_json, "
            "updated_at = excluded.updated_at",
            (snapshot_id, json.dumps(visuals, **_JSON_KWARGS), updated_at),
        )
    return {"snapshot_id": snapshot_id, "visuals": visuals, "updated_at": updated_at}


def warehouse_info() -> dict[str, Any]:
    """Where the warehouse is and how much is in it (shown in the BI tab)."""
    snapshots = list_snapshots()
    return {
        "path": WAREHOUSE_DB,
        "snapshot_count": len(snapshots),
        "row_count": sum(item["row_count"] for item in snapshots),
        "size_bytes": os.path.getsize(WAREHOUSE_DB) if os.path.exists(WAREHOUSE_DB) else 0,
    }


# ---- Relationships between warehouse snapshots ----
# A relationship links two snapshots on one column pair ("foreign key"), so the
# BI page can drill from a row in one table to its rows in another. It is pure
# metadata: matching happens at read time against the JSON row payloads.


def _relationship_row(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    # Snapshot names travel along for display; a deleted snapshot would leave
    # no relationship row (ON DELETE CASCADE), so the join always matches.
    return item


def list_relationships() -> list[dict[str, Any]]:
    """All relationships, newest first, with display names of both tables."""
    with connect() as conn:
        cursor = conn.execute(
            "SELECT r.id, r.name, r.left_snapshot_id, r.left_column, r.join_type, "
            "r.right_snapshot_id, r.right_column, r.created_at, "
            "l.name AS left_name, rt.name AS right_name "
            "FROM snapshot_relationships r "
            "JOIN query_snapshots l ON l.id = r.left_snapshot_id "
            "JOIN query_snapshots rt ON rt.id = r.right_snapshot_id "
            "ORDER BY r.created_at DESC"
        )
        return [_relationship_row(item) for item in cursor.fetchall()]


def create_relationship(
    *,
    name: str,
    left_snapshot_id: str,
    left_column: str,
    join_type: str,
    right_snapshot_id: str,
    right_column: str,
) -> dict[str, Any]:
    """Store a new relationship. Returns its full row (with table names)."""
    relationship_id = uuid.uuid4().hex
    created_at = _now()
    with connect() as conn:
        conn.execute(
            "INSERT INTO snapshot_relationships "
            "(id, name, left_snapshot_id, left_column, join_type, "
            "right_snapshot_id, right_column, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                relationship_id,
                name,
                left_snapshot_id,
                left_column,
                join_type,
                right_snapshot_id,
                right_column,
                created_at,
            ),
        )
    return get_relationship(relationship_id)  # type: ignore[return-value]


def get_relationship(relationship_id: str) -> Optional[dict[str, Any]]:
    """One relationship with display names, or None when unknown."""
    with connect() as conn:
        row = conn.execute(
            "SELECT r.id, r.name, r.left_snapshot_id, r.left_column, r.join_type, "
            "r.right_snapshot_id, r.right_column, r.created_at, "
            "l.name AS left_name, rt.name AS right_name "
            "FROM snapshot_relationships r "
            "JOIN query_snapshots l ON l.id = r.left_snapshot_id "
            "JOIN query_snapshots rt ON rt.id = r.right_snapshot_id "
            "WHERE r.id = ?",
            (relationship_id,),
        ).fetchone()
    return _relationship_row(row) if row is not None else None


def update_relationship(
    relationship_id: str,
    *,
    name: str,
    left_snapshot_id: str,
    left_column: str,
    join_type: str,
    right_snapshot_id: str,
    right_column: str,
) -> Optional[dict[str, Any]]:
    """Replace a relationship's definition. None when the id is unknown."""
    with connect() as conn:
        cursor = conn.execute(
            "UPDATE snapshot_relationships SET name = ?, left_snapshot_id = ?, "
            "left_column = ?, join_type = ?, right_snapshot_id = ?, right_column = ? "
            "WHERE id = ?",
            (
                name,
                left_snapshot_id,
                left_column,
                join_type,
                right_snapshot_id,
                right_column,
                relationship_id,
            ),
        )
        if cursor.rowcount == 0:
            return None
    return get_relationship(relationship_id)


def delete_relationship(relationship_id: str) -> bool:
    """Delete a relationship. False when the id is unknown."""
    with connect() as conn:
        cursor = conn.execute(
            "DELETE FROM snapshot_relationships WHERE id = ?", (relationship_id,)
        )
        return cursor.rowcount > 0


def preview_relationship_join(relationship_id: str, limit: int = 500) -> Optional[dict[str, Any]]:
    """Flat left/inner join of the two snapshots on the relationship's keys.

    Rows are JSON payloads, so the join runs in Python: index the right rows by
    the stringified key, then emit one row per match. Left rows without a match
    are kept (with nulls) for ``left`` joins and dropped for ``inner`` joins.
    Column name collisions are resolved by prefixing the right table's name.
    """
    relationship = get_relationship(relationship_id)
    if relationship is None:
        return None

    left = get_snapshot(relationship["left_snapshot_id"])
    right = get_snapshot(relationship["right_snapshot_id"])
    if left is None or right is None:
        return None

    left_column = relationship["left_column"]
    right_column = relationship["right_column"]
    right_name = relationship["right_name"]

    # Prefix right columns only when they would otherwise collide with a left
    # column, so typical key names (NAME, Batch, ...) stay readable.
    left_columns = [column["name"] for column in left["columns"]] or list(left["rows"][0].keys())
    right_columns = [column["name"] for column in right["columns"]] or list(right["rows"][0].keys())
    collisions = set(left_columns) & set(right_columns)
    right_label = {name: f"{right_name}.{name}" if name in collisions else name for name in right_columns}

    index: dict[str, list[dict[str, Any]]] = {}
    for row in right["rows"]:
        key = row.get(right_column)
        if key is None:
            continue
        index.setdefault(str(key), []).append(row)

    columns = list(left_columns)
    for name in right_columns:
        labelled = right_label[name]
        if labelled not in columns:
            columns.append(labelled)

    joined: list[dict[str, Any]] = []
    matched_left = 0
    truncated = False
    for row in left["rows"]:
        key = row.get(left_column)
        matches = index.get(str(key), []) if key is not None else []
        if matches:
            matched_left += 1
        elif relationship["join_type"] == "inner":
            continue
        if not matches:
            if len(joined) >= limit:
                truncated = True
                break
            merged = dict(row)
            for name in right_columns:
                merged[right_label[name]] = None
            joined.append(merged)
            continue
        for match in matches:
            if len(joined) >= limit:
                truncated = True
                break
            merged = dict(row)
            for name in right_columns:
                merged[right_label[name]] = match.get(name)
            joined.append(merged)
        if truncated:
            break

    return {
        "columns": columns,
        "rows": joined,
        "total": len(joined),
        "truncated": truncated,
        "matched_left": matched_left,
        "left_row_count": left["row_count"],
        "right_row_count": right["row_count"],
    }
