"""API routes for running queries against ODBC connections and exporting results."""
from __future__ import annotations

import io
import json
import time
import uuid
from typing import Any, Literal, Optional

import pyodbc
from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import logging_utils, storage
from app.api import history as history_api
from app.db import odbc
from app.db.sql_builder import MAX_LIMIT, build_select, detect_dbms, resolve_dbms
from app.lazy import lazy_module
from app.xpt_export import XPT_MEDIA_TYPE, dataframe_to_xpt

# pandas is imported on first use (deferred so the app window appears faster);
# typed as a module so editors/Pyright still see the real pandas API.
pd = lazy_module("pandas")

router = APIRouter()

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
STREAM_MEDIA_TYPE = "application/x-ndjson"


def _ndjson(payload: dict) -> str:
    """Serialize one streaming event as a single line of newline-delimited JSON."""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


class FilterDef(BaseModel):
    """A single WHERE clause condition."""

    column: str
    operator: str
    value: Any = None


class DerivedColumnDef(BaseModel):
    """A calculated column appended to the SELECT list: ``expression AS name``.

    ``expression`` is a SQL snippet (e.g. ``"AFTER - BEFORE"``) evaluated by the
    database — it may reference other selected columns or aggregate functions.
    """

    name: str
    expression: str


class QueryDef(BaseModel):
    """Definition of a SELECT query against a stored connection."""

    connection_id: str
    table: str
    columns: list[str] = []
    filters: list[FilterDef] = []
    derived_columns: list[DerivedColumnDef] = []
    date_column: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    limit: Optional[int] = None


class ExportRequest(BaseModel):
    """Body for POST /query/export."""

    query: QueryDef
    format: Literal["xlsx", "csv", "xpt"] = "xlsx"


def _get_connection(connection_id: str) -> dict:
    """Look up a stored connection, raising 404 when it does not exist."""
    from app.main import get_stored_connection  # deferred to avoid import cycle

    return get_stored_connection(connection_id)


def _run_query(query: QueryDef) -> tuple[list[dict], list[dict], str]:
    """Run a QueryDef and return (rows, columns, sql)."""
    conn = _get_connection(query.connection_id)
    dbms = resolve_dbms(conn, detect_dbms(conn))
    try:
        sql, params = build_select(query.model_dump(), dbms)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        odbc.assert_read_only(sql)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        rows, col_types = odbc.run_query(conn, sql, params)
    except pyodbc.Error as exc:
        logging_utils.log_error(
            "query.run",
            f"connection={conn.get('name') or query.connection_id} failed",
            details=str(exc),
        )
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc
    columns = [{"name": name, "type": str(type_code)} for name, type_code in col_types]
    return rows, columns, sql


class RunQueryRequest(BaseModel):
    """Body for POST /query/run."""

    query: QueryDef


@router.post("/query/run")
def run_query_endpoint(payload: RunQueryRequest):
    """Run a SELECT query and stream NDJSON progress events + the final result.

    The response is a newline-delimited stream: one or more
    ``{"type":"progress","rows":N}`` events are emitted while rows are fetched,
    then a ``{"type":"result","rows":[...],...}`` event carrying the full result.
    A ``{"type":"error","detail":...}`` event is emitted if the database fails,
    and a ``{"type":"canceled"}`` event when the run is cancelled via
    ``POST /query/cancel/{run_id}`` (the run id is returned in the
    ``X-Run-Id`` response header).
    """
    query = payload.query
    conn = _get_connection(query.connection_id)
    dbms = resolve_dbms(conn, detect_dbms(conn))
    try:
        sql, params = build_select(query.model_dump(), dbms)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        odbc.assert_read_only(sql)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    run_id = uuid.uuid4().hex

    def generate():
        start = time.perf_counter()
        try:
            rows: list[dict] = []
            col_types = []
            for phase, first, second in odbc.iter_query(conn, sql, params, run_id=run_id):
                if phase == "progress":
                    yield _ndjson({"type": "progress", "rows": first})
                else:
                    rows, col_types = first, second
        except pyodbc.Error as exc:
            logging_utils.log_error(
                "query.run",
                f"connection={conn.get('name') or query.connection_id} failed",
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
            "query.run",
            f"table={query.table} returned {len(rows)} rows",
            details=f"connection_id={query.connection_id}, rows={len(rows)}, elapsed_ms={elapsed_ms}",
        )
        history_api.add_history_entry(
            connection_id=query.connection_id,
            kind="builder",
            sql=sql,
            query=query.model_dump(),
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
                "sql": sql,
            }
        )

    return StreamingResponse(
        generate(),
        media_type=STREAM_MEDIA_TYPE,
        headers={"X-Run-Id": run_id},
    )


@router.post("/query/cancel/{run_id}")
def cancel_query(run_id: str):
    """Cancel the in-flight query run identified by ``run_id``.

    Always returns 200 with ``{ok: bool}`` — ``ok`` is ``False`` only when the
    run is unknown (already finished or never registered). A run is registered
    before its connection opens, so a cancel also lands while the connection is
    still opening: it is remembered and applied once the driver is responsive.
    """
    ok = odbc.cancel_run(run_id)
    logging_utils.log_info(
        "query.cancel",
        f"run_id={run_id} ok={ok}",
    )
    return {"ok": ok}


@router.post("/query/export")
def export_query(payload: ExportRequest):
    """Run a query and download the result as CSV or XLSX."""
    query = payload.query
    # Exports may pull more rows than interactive runs (capped at MAX_LIMIT).
    export_query_def = query.model_copy(update={"limit": query.limit or MAX_LIMIT})
    start = time.perf_counter()
    rows, _, sql = _run_query(export_query_def)
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    df = pd.DataFrame(rows)
    if payload.format == "csv":
        buffer = io.StringIO()
        df.to_csv(buffer, index=False)
        content = buffer.getvalue().encode("utf-8-sig")
        media_type = "text/csv"
        filename = "query_export.csv"
    elif payload.format == "xpt":
        # SAS Transport — opens natively in JMP (the "JMP export").
        content = dataframe_to_xpt(df)
        media_type = XPT_MEDIA_TYPE
        filename = "query_export.xpt"
    else:
        buffer = io.BytesIO()
        df.to_excel(buffer, index=False)
        content = buffer.getvalue()
        media_type = XLSX_MEDIA_TYPE
        filename = "query_export.xlsx"

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Query-Elapsed-Ms": str(elapsed_ms),
        "X-Row-Count": str(len(rows)),
    }
    logging_utils.log_info(
        "query.export",
        f"table={query.table} exported {len(rows)} rows as {payload.format}",
        details=f"format={payload.format}, rows={len(rows)}, elapsed_ms={elapsed_ms}, bytes={len(content)}",
    )
    return Response(content=content, media_type=media_type, headers=headers)


def _resolve_connection_or_first(connection_id: Optional[str]) -> dict:
    """Look up a connection by id, or fall back to the first configured one."""
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


def fetch_rows(
    query: Optional[QueryDef] = None,
    connection_id: Optional[str] = None,
    sql: Optional[str] = None,
    limit: Optional[int] = None,
) -> tuple[list[dict], list[dict], str]:
    """Run either a builder QueryDef or raw SQL; return (rows, columns, sql).

    Used by charts / analysis / profile so they work with both the visual
    builder and the free-form SQL editor (no connection selection required —
    the first configured connection is used when none is given).
    """
    if query is not None:
        return _run_query(query)
    if not sql or not sql.strip():
        raise HTTPException(status_code=400, detail="SQL text is required.")
    conn = _resolve_connection_or_first(connection_id)
    try:
        odbc.assert_read_only(sql)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        rows, col_types = odbc.run_query(conn, sql, row_cap=limit)
    except pyodbc.Error as exc:
        logging_utils.log_error(
            "query.run",
            f"connection={conn.get('name') or connection_id} failed",
            details=str(exc),
        )
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc
    columns = [{"name": name, "type": str(type_code)} for name, type_code in col_types]
    return rows, columns, sql
