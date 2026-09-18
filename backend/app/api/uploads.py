"""API routes for manually uploaded data (CSV / Excel) and grid-based exports."""
import io
import json
import math
import threading
import time
import uuid
from typing import Literal, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import logging_utils
from app.xpt_export import XPT_MEDIA_TYPE, dataframe_to_xpt

router = APIRouter()

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _json_safe(value):
    """Convert a pandas/numpy value to a JSON-serializable Python value."""
    if value is None:
        return None
    if isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, (float, np.floating)):
        f = float(value)
        # NaN / Infinity are not JSON-compliant (Starlette uses allow_nan=False).
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (pd.Timestamp, np.datetime64)):
        return pd.Timestamp(value).isoformat()
    if isinstance(value, np.bool_):
        return bool(value)
    return str(value)


def _rows_json_safe(df: pd.DataFrame) -> list[dict]:
    """Serialize a DataFrame to a list of row dicts with JSON-safe values."""
    return [
        {str(col): _json_safe(row[col]) for col in df.columns}
        for row in df.to_dict("records")
    ]


def _parse_upload(raw: bytes, filename: str) -> pd.DataFrame:
    """Blocking CSV/Excel parse — must run off the event loop."""
    if filename.endswith(".csv"):
        return pd.read_csv(io.BytesIO(raw))
    if filename.endswith((".xlsx", ".xls")):
        # The calamine engine (python-calamine, if installed) parses xlsx
        # ~10x faster than openpyxl, which matters for big uploads.
        try:
            import python_calamine  # noqa: F401

            return pd.read_excel(io.BytesIO(raw), engine="calamine")
        except ImportError:
            return pd.read_excel(io.BytesIO(raw))
    raise ValueError("Unsupported file type — upload a .csv, .xlsx or .xls file.")


@router.post("/upload/parse")
async def upload_parse(file: UploadFile = File(...)):
    """Parse an uploaded CSV/Excel file into grid rows + column metadata."""
    start = time.perf_counter()
    filename = (file.filename or "").lower()
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    try:
        # Heavy work runs in a worker thread so the event loop stays free:
        # browser heartbeats (server auto-shutdown watchdog) keep flowing even
        # while a big Excel file takes minutes to parse.
        df = await run_in_threadpool(_parse_upload, raw, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface the parse failure to the UI
        raise HTTPException(status_code=400, detail=f"Could not parse the file: {exc}") from exc

    if df.empty:
        raise HTTPException(status_code=400, detail="The file contains no rows.")
    # No row cap: all uploaded rows are passed through to the grid.
    truncated = False
    rows = await run_in_threadpool(_rows_json_safe, df)
    columns = [{"name": str(col), "type": str(df[col].dtype)} for col in df.columns]
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    logging_utils.log_info(
        "upload.parse",
        f"parsed {len(rows)} rows from {file.filename}",
        details=(
            f"rows={len(rows)}, columns={len(columns)}, truncated={truncated}, "
            f"elapsed_ms={elapsed_ms}"
        ),
    )
    payload = {
        "rows": rows,
        "columns": columns,
        "row_count": len(rows),
        "elapsed_ms": elapsed_ms,
        "truncated": truncated,
    }
    # Serialize manually (values are already JSON-safe): skips FastAPI's
    # jsonable_encoder pass, which is very slow for hundreds of thousands of
    # rows and a major part of the upload latency.
    content = await run_in_threadpool(
        lambda: json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    )
    return Response(content=content, media_type="application/json")


# ---- Streaming upload parse -------------------------------------------------
#
# The one-shot /upload/parse above cannot report progress: the browser has no
# way to both show multipart upload progress (needs XHR/axios) and consume a
# streaming response (needs fetch). Splitting the flow fixes that:
#   1. POST /upload/file         — spool the raw bytes, return an id (axios
#                                  gives reliable byte-level progress here).
#   2. POST /upload/parse/stream — NDJSON event stream with live row counts
#                                  while the file is read and rows are shipped
#                                  to the grid in batches.

_UPLOAD_SPOOL_TTL_S = 30 * 60
# Raw bytes of spooled uploads: {id: (raw, filename, inserted_at)}. The raw
# bytes are held in memory either way during parsing, so this adds no new
# ceiling — entries are dropped when parsing starts (plus a TTL sweep).
_UPLOAD_SPOOL: dict[str, tuple[bytes, str, float]] = {}
_UPLOAD_SPOOL_LOCK = threading.Lock()

_CSV_CHUNK_ROWS = 50_000
_RESULT_ROWS_PER_EVENT = 10_000
_XLSX_PROGRESS_ROWS = 5_000


def _spool_put(raw: bytes, filename: str) -> str:
    now = time.time()
    with _UPLOAD_SPOOL_LOCK:
        # Opportunistic cleanup of stale entries (e.g. a tab closed between
        # upload and parse) so the spool cannot grow unbounded.
        stale = [k for k, (_, _, ts) in _UPLOAD_SPOOL.items() if now - ts > _UPLOAD_SPOOL_TTL_S]
        for key in stale:
            del _UPLOAD_SPOOL[key]
        upload_id = uuid.uuid4().hex
        _UPLOAD_SPOOL[upload_id] = (raw, filename, now)
        return upload_id


def _spool_pop(upload_id: str) -> tuple[bytes, str]:
    with _UPLOAD_SPOOL_LOCK:
        entry = _UPLOAD_SPOOL.pop(upload_id, None)
    if entry is None:
        raise HTTPException(
            status_code=404,
            detail="Upload session not found or expired — please upload the file again.",
        )
    raw, filename, _ = entry
    return raw, filename


class UploadParseStreamRequest(BaseModel):
    """Body for POST /upload/parse/stream — the id returned by /upload/file."""

    id: str


def _ndjson(event: dict) -> str:
    """Serialize one NDJSON event line (values are already JSON-safe)."""
    return json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n"


def _iter_parse_events(raw: bytes, filename: str):
    """Yield NDJSON parse events for a spooled upload.

    Starlette iterates this sync generator via the threadpool, so blocking
    pandas work stays off the event loop (browser heartbeats keep flowing)
    while progress events are flushed to the client as they are produced.
    """
    start = time.perf_counter()
    try:
        if filename.endswith(".csv"):
            # Chunked read: emit a row-count progress event per chunk so the
            # user sees the file being ingested row by row.
            chunks: list[pd.DataFrame] = []
            rows_so_far = 0
            for chunk in pd.read_csv(io.BytesIO(raw), chunksize=_CSV_CHUNK_ROWS):
                chunks.append(chunk)
                rows_so_far += len(chunk)
                yield _ndjson({"type": "progress", "stage": "read", "rows": rows_so_far})
            df = pd.concat(chunks, ignore_index=True) if chunks else pd.DataFrame()
        elif filename.endswith(".xlsx"):
            # openpyxl in read-only mode streams the sheet row by row, so we
            # can emit live row counts while reading (like the CSV path)
            # instead of waiting on one monolithic pd.read_excel call.
            from openpyxl import load_workbook

            col_names: list[str] = []
            data_rows: list[tuple] = []
            header: tuple | None = None
            rows_so_far = 0
            last_emitted = 0
            wb = load_workbook(
                io.BytesIO(raw), read_only=True, data_only=True, keep_links=False
            )
            try:
                ws = wb.active
                for row in ws.iter_rows(values_only=True):
                    if header is None:
                        # Skip fully blank leading rows instead of turning
                        # them into a sheet of "Unnamed" columns.
                        if all(c is None or str(c) == "" for c in row):
                            continue
                        header = row
                        seen: dict[str, int] = {}
                        for i, c in enumerate(row):
                            name = (
                                str(c)
                                if c is not None and str(c) != ""
                                else f"Unnamed: {i}"
                            )
                            if name in seen:
                                seen[name] += 1
                                name = f"{name}.{seen[name]}"
                            else:
                                seen[name] = 0
                            col_names.append(name)
                        continue
                    # Normalize width: pad short rows, trim long ones.
                    if len(row) < len(col_names):
                        row = row + (None,) * (len(col_names) - len(row))
                    elif len(row) > len(col_names):
                        row = row[: len(col_names)]
                    data_rows.append(row)
                    rows_so_far += 1
                    if rows_so_far - last_emitted >= _XLSX_PROGRESS_ROWS:
                        last_emitted = rows_so_far
                        yield _ndjson(
                            {"type": "progress", "stage": "read", "rows": rows_so_far}
                        )
            finally:
                wb.close()
            if rows_so_far != last_emitted:
                yield _ndjson({"type": "progress", "stage": "read", "rows": rows_so_far})
            df = pd.DataFrame(data_rows, columns=col_names)
        elif filename.endswith(".xls"):
            # Legacy format needs xlrd, which loads the whole workbook at
            # once — report the phase only; live counts resume below.
            yield _ndjson({"type": "progress", "stage": "read"})
            df = pd.read_excel(io.BytesIO(raw))
        else:
            raise ValueError("Unsupported file type — upload a .csv, .xlsx or .xls file.")

        if df.empty:
            raise ValueError("The file contains no rows.")

        columns = [{"name": str(col), "type": str(df[col].dtype)} for col in df.columns]
        row_count = int(len(df))
        yield _ndjson(
            {
                "type": "result_begin",
                "columns": columns,
                "row_count": row_count,
                "truncated": False,
            }
        )
        # Ship the grid rows in batches: the client counts them as they arrive
        # for a live "imported N / total" counter, and no single giant JSON
        # blob has to be buffered anywhere.
        imported = 0
        for i in range(0, row_count, _RESULT_ROWS_PER_EVENT):
            batch = _rows_json_safe(df.iloc[i : i + _RESULT_ROWS_PER_EVENT])
            imported += len(batch)
            yield _ndjson({"type": "result_rows", "rows": batch})
            yield _ndjson({"type": "progress", "stage": "import", "rows": imported})
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        yield _ndjson({"type": "result_end", "elapsed_ms": elapsed_ms})
        logging_utils.log_info(
            "upload.parse",
            f"parsed {row_count} rows from {filename}",
            details=(
                f"rows={row_count}, columns={len(columns)}, "
                f"elapsed_ms={elapsed_ms}, streamed=true"
            ),
        )
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI as an error event
        yield _ndjson({"type": "error", "detail": f"Could not parse the file: {exc}"})


@router.post("/upload/file")
async def upload_file(file: UploadFile = File(...)):
    """Spool the raw uploaded bytes and return an id for the parse step."""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    filename = (file.filename or "").lower()
    if not filename.endswith((".csv", ".xlsx", ".xls")):
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type — upload a .csv, .xlsx or .xls file.",
        )
    upload_id = _spool_put(raw, filename)
    return {"id": upload_id, "bytes": len(raw)}


@router.post("/upload/parse/stream")
async def upload_parse_stream(payload: UploadParseStreamRequest):
    """Stream-parse a spooled upload as NDJSON.

    Event order: ``progress`` (stage=read rows / stage=import rows) →
    ``result_begin`` (columns, row_count) → ``result_rows`` batches →
    ``result_end`` (elapsed_ms). Parse failures arrive as
    ``{"type":"error","detail":...}`` so the client can display them.
    """
    raw, filename = _spool_pop(payload.id)
    return StreamingResponse(
        _iter_parse_events(raw, filename),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store"},
    )


class GridExportRequest(BaseModel):
    """Body for POST /export/grid — export the rows already loaded in the grid."""

    rows: list[dict]
    columns: list = []
    format: Literal["xlsx", "csv", "xpt"] = "xlsx"


@router.post("/export/grid")
def export_grid(payload: GridExportRequest):
    """Export the supplied grid rows as CSV or XLSX without re-running a query."""
    if not payload.rows:
        raise HTTPException(status_code=400, detail="No rows to export.")
    start = time.perf_counter()
    df = pd.DataFrame(payload.rows)
    if payload.format == "csv":
        buffer = io.StringIO()
        df.to_csv(buffer, index=False)
        content = buffer.getvalue().encode("utf-8-sig")
        media_type = "text/csv"
        filename = "grid_export.csv"
    elif payload.format == "xpt":
        # SAS Transport — opens natively in JMP (the "JMP export").
        content = dataframe_to_xpt(df)
        media_type = XPT_MEDIA_TYPE
        filename = "grid_export.xpt"
    else:
        buffer = io.BytesIO()
        df.to_excel(buffer, index=False)
        content = buffer.getvalue()
        media_type = XLSX_MEDIA_TYPE
        filename = "grid_export.xlsx"
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    logging_utils.log_info(
        "grid.export",
        f"exported {len(payload.rows)} rows as {payload.format}",
        details=(
            f"format={payload.format}, rows={len(payload.rows)}, "
            f"elapsed_ms={elapsed_ms}, bytes={len(content)}"
        ),
    )
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Row-Count": str(len(payload.rows)),
        },
    )
