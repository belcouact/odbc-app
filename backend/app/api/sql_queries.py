"""API routes for saved custom SQL queries and running raw SQL."""
from __future__ import annotations

import io
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

import pyodbc
from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app import logging_utils, storage
from app.api import history as history_api
from app.db import odbc
from app.db.sql_builder import MAX_LIMIT
from app.lazy import lazy_module
from app.xpt_export import XPT_MEDIA_TYPE, dataframe_to_xpt

# pandas loads on first use (deferred so the app window appears faster).
pd = lazy_module("pandas")

router = APIRouter()

_SQL_QUERIES_FILE = "sql_queries.json"
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
STREAM_MEDIA_TYPE = "application/x-ndjson"


def _ndjson(payload: dict) -> str:
    """Serialize one streaming event as a single line of newline-delimited JSON."""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


class SqlQueryCreate(BaseModel):
    """Body for POST /sql-queries."""

    name: str = Field(min_length=1)
    description: Optional[str] = None
    sql: str = Field(min_length=1)
    connection_id: Optional[str] = None


class SqlQueryUpdate(BaseModel):
    """Body for PUT /sql-queries/{query_id}."""

    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    sql: Optional[str] = Field(default=None, min_length=1)
    connection_id: Optional[str] = None


class SqlRunRequest(BaseModel):
    """Body for POST /sql/run. Connection may be omitted (first available is used)."""

    connection_id: Optional[str] = None
    sql: str = Field(min_length=1)
    limit: Optional[int] = None


class SqlExportRequest(BaseModel):
    """Body for POST /sql/export."""

    connection_id: Optional[str] = None
    sql: str = Field(min_length=1)
    format: Literal["xlsx", "csv", "xpt"] = "xlsx"


class SqlColumnsRequest(BaseModel):
    """Body for POST /sql/columns."""

    connection_id: Optional[str] = None
    sql: str = Field(min_length=1)


def _load_queries() -> list:
    return storage.load_json(_SQL_QUERIES_FILE, [])


def _save_queries(queries: list) -> None:
    storage.save_json(_SQL_QUERIES_FILE, queries)


def _find_query(queries: list, query_id: str) -> dict | None:
    return next((q for q in queries if q.get("id") == query_id), None)


def _get_connection(connection_id: str) -> dict:
    """Look up a stored connection, raising 404 when it does not exist."""
    from app.main import get_stored_connection  # deferred to avoid import cycle

    return get_stored_connection(connection_id)


def _resolve_connection(connection_id: Optional[str]) -> dict:
    """Return the requested connection, or the first available one when omitted."""
    if connection_id:
        return _get_connection(connection_id)
    from app.api.connections import load_stored_connections  # deferred: avoid import cycle

    connections_list = load_stored_connections()
    if not connections_list:
        raise HTTPException(
            status_code=400,
            detail="No connections configured. Add one in ODBC Setup first.",
        )
    return connections_list[0]


@router.get("/sql-queries")
def list_sql_queries():
    """Return all saved custom SQL queries."""
    return _load_queries()


@router.post("/sql-queries", status_code=201)
def create_sql_query(payload: SqlQueryCreate):
    """Save a new custom SQL query."""
    queries = _load_queries()
    now = datetime.now(timezone.utc).isoformat()
    obj = {
        "id": uuid.uuid4().hex,
        "name": payload.name,
        "description": payload.description or "",
        "sql": payload.sql,
        "connection_id": payload.connection_id,
        "created_at": now,
        "updated_at": now,
    }
    queries.append(obj)
    _save_queries(queries)
    return obj


@router.put("/sql-queries/{query_id}")
def update_sql_query(query_id: str, payload: SqlQueryUpdate):
    """Update a saved custom SQL query's name and/or SQL text."""
    queries = _load_queries()
    obj = _find_query(queries, query_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"SQL query '{query_id}' not found")
    obj.update(payload.model_dump(exclude_unset=True))
    obj["updated_at"] = datetime.now(timezone.utc).isoformat()
    _save_queries(queries)
    return obj


@router.delete("/sql-queries/{query_id}")
def delete_sql_query(query_id: str):
    """Delete a saved custom SQL query."""
    queries = _load_queries()
    obj = _find_query(queries, query_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"SQL query '{query_id}' not found")
    queries.remove(obj)
    _save_queries(queries)
    return {"ok": True}


@router.post("/sql/run")
def run_raw_sql(payload: SqlRunRequest):
    """Run an arbitrary read-only SQL statement and stream NDJSON progress + result.

    The response is a newline-delimited stream: one or more
    ``{"type":"progress","rows":N}`` events are emitted while rows are fetched,
    then a ``{"type":"result","rows":[...],...}`` event carrying the full result.
    A ``{"type":"error","detail":...}`` event is emitted if the database fails.
    """
    conn = _resolve_connection(payload.connection_id)
    conn_id = conn.get("id") or ""
    try:
        odbc.assert_read_only(payload.sql)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    run_id = uuid.uuid4().hex

    def generate():
        start = time.perf_counter()
        try:
            rows: list[dict] = []
            col_types = []
            for phase, first, second in odbc.iter_query(conn, payload.sql, row_cap=payload.limit, run_id=run_id):
                if phase == "progress":
                    yield _ndjson({"type": "progress", "rows": first})
                else:
                    rows, col_types = first, second
        except pyodbc.Error as exc:
            logging_utils.log_error(
                "query.run",
                f"connection={conn.get('name') or conn_id} failed",
                details=str(exc),
            )
            if odbc.is_cancellation(exc):
                yield _ndjson({"type": "canceled"})
                return
            yield _ndjson({"type": "error", "detail": f"Database error: {odbc.format_db_error(exc)}"})
            return
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        columns = [{"name": name, "type": str(type_code)} for name, type_code in col_types]
        logging_utils.log_info(
            "sql.run",
            f"connection={conn.get('name') or conn_id} returned {len(rows)} rows",
            details=f"rows={len(rows)}, elapsed_ms={elapsed_ms}",
        )
        history_api.add_history_entry(
            connection_id=conn_id,
            kind="sql",
            sql=payload.sql,
            query=None,
            row_count=len(rows),
            elapsed_ms=elapsed_ms,
        )
        yield _ndjson(
            {
                "type": "result",
                "rows": rows,
                "columns": columns,
                "row_count": len(rows),
                "elapsed_ms": elapsed_ms,
                "sql": payload.sql,
            }
        )

    return StreamingResponse(
        generate(),
        media_type=STREAM_MEDIA_TYPE,
        headers={"X-Run-Id": run_id},
    )


@router.post("/sql/columns")
def sql_columns(payload: SqlColumnsRequest):
    """Return the result column metadata for a read-only SQL statement.

    Used by the dashboard tile editor to let the user pick X/Y columns without
    fetching any rows or adding a history entry.
    """
    conn = _resolve_connection(payload.connection_id)
    try:
        odbc.assert_read_only(payload.sql)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    start = time.perf_counter()
    try:
        rows, col_types = odbc.run_query(conn, payload.sql, row_cap=0)
    except pyodbc.Error as exc:
        logging_utils.log_error(
            "sql.columns",
            f"connection={conn.get('name') or payload.connection_id} failed",
            details=str(exc),
        )
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    columns = [{"name": name, "type": str(type_code)} for name, type_code in col_types]
    return {
        "columns": columns,
        "row_count": len(rows),
        "elapsed_ms": elapsed_ms,
    }


@router.post("/sql/export")
def export_sql(payload: SqlExportRequest):
    """Run raw SQL and download the result as CSV or XLSX (capped at MAX_LIMIT rows)."""
    conn = _resolve_connection(payload.connection_id)
    try:
        odbc.assert_read_only(payload.sql)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    start = time.perf_counter()
    try:
        rows, _ = odbc.run_query(conn, payload.sql, row_cap=MAX_LIMIT)
    except pyodbc.Error as exc:
        logging_utils.log_error(
            "sql.export",
            f"connection={conn.get('name') or payload.connection_id} failed",
            details=str(exc),
        )
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    df = pd.DataFrame(rows)
    if payload.format == "csv":
        buffer = io.StringIO()
        df.to_csv(buffer, index=False)
        content = buffer.getvalue().encode("utf-8-sig")
        media_type = "text/csv"
        filename = "sql_export.csv"
    elif payload.format == "xpt":
        # SAS Transport — opens natively in JMP (the "JMP export").
        content = dataframe_to_xpt(df)
        media_type = XPT_MEDIA_TYPE
        filename = "sql_export.xpt"
    else:
        buffer = io.BytesIO()
        df.to_excel(buffer, index=False)
        content = buffer.getvalue()
        media_type = XLSX_MEDIA_TYPE
        filename = "sql_export.xlsx"

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Query-Elapsed-Ms": str(elapsed_ms),
        "X-Row-Count": str(len(rows)),
    }
    logging_utils.log_info(
        "sql.export",
        f"connection={conn.get('name') or payload.connection_id} exported {len(rows)} rows as {payload.format}",
        details=f"format={payload.format}, rows={len(rows)}, elapsed_ms={elapsed_ms}, bytes={len(content)}",
    )
    return Response(content=content, media_type=media_type, headers=headers)
