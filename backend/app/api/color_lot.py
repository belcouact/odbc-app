"""Auto-enrich Color_Data query results with the FabLIMS lot genealogy.

After a Color_Data query returns, the grid only holds what the ColorDB Access
database knows (``DATE`` / ``NAME`` / ``L`` / ``a`` / ``b``). This module adds
the genealogy columns an analyst needs, in one streaming call:

* ``WOL`` / ``Batch`` / ``Sample_type`` — derived from ``NAME`` with the same
  rules as the Color_Data template's computed columns. They are only appended
  when the caller did not already bake them in.
* ``Product``     — ``sample.G_ITEM`` matched on the WOL (``gm_batch.TO_LOT``).
* ``Description`` — ``sample.DESCRIPTION`` matched on the same WOL.
* ``Raw_item``    — ``g_lsn.G_ITEM`` matched on the Batch (``g_lsn.G_BATCH``).

The color query's row count is preserved: the genealogy behaves like a LEFT
join where the FIRST match wins and unmatched rows keep an empty value.

The whole genealogy window (the last ``_GENEALOGY_LOOKBACK_DAYS``) is fetched at
most once per TTL and cached in memory. Pushing the queried WOL/Batch values
down as an ``IN (...)`` list is not an option here — a single list can exceed
100k entries.
"""
import datetime
import json
import re
import threading
import time
from typing import Any, Optional

import pyodbc
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import logging_utils, storage
from app.db import odbc

router = APIRouter()

STREAM_MEDIA_TYPE = "application/x-ndjson"

# The genealogy is small enough to pull once and join in memory, but it still
# takes a while to fetch — keep it for a few hours so repeated Color_Data runs
# are instant.
_CACHE_TTL_S = 6 * 3600

# The genealogy window: every g_lsn row manufactured within the last N days.
# The cutoff is resolved per run so a long-lived process never serves a stale
# window.
_GENEALOGY_LOOKBACK_DAYS = 3000


def _genealogy_sql() -> str:
    """The lot-genealogy extract, windowed to the last ``_GENEALOGY_LOOKBACK_DAYS``."""
    since = (
        datetime.date.today() - datetime.timedelta(days=_GENEALOGY_LOOKBACK_DAYS)
    ).strftime("%Y/%m/%d")
    return (
        "SELECT DISTINCT g_lsn.G_BATCH AS G_Batch, "
        "gm_batch.TO_LOT AS 'WOL', "
        "g_lsn.G_ITEM AS 'Raw_item', "
        "sample.DESCRIPTION, "
        "sample.G_ITEM AS 'Product' "
        "FROM g_lsn "
        "LEFT JOIN gm_batch ON g_lsn.G_BATCH = gm_batch.G_BATCH "
        "AND gm_batch.FROM_LOT = g_lsn.NAME "
        "LEFT JOIN sample ON sample.G_WOL = gm_batch.TO_LOT "
        f"WHERE g_lsn.G_MAN_DATE > '{since}' "
        "AND g_lsn.G_BATCH IS NOT NULL "
        "AND (gm_batch.EVENT_REASON = 'WFACE' OR gm_batch.EVENT_REASON IS NULL)"
    )


# Same derivation rules as the Color_Data template's computed columns.
_WOL_RE = re.compile(r"(\d{8}[A-Za-z]{2})", re.IGNORECASE)
_BATCH_RE = re.compile(
    r"(?<![A-Za-z0-9])([A-Za-z][0-9]{5}|[0-9]{6})(?![A-Za-z0-9])", re.IGNORECASE
)
_LD_RE = re.compile(r"^(.*?)[-_](?:LD|Master)", re.IGNORECASE)

# Logical column order of the appended genealogy block.
_ENRICH_ORDER = ("WOL", "Batch", "Sample_type", "Product", "Raw_item", "Description")

_cache: dict[str, Any] = {
    "fetched_at": 0.0,
    "connection": "",
    "rows": 0,
    "wol_to_product": {},
    "wol_to_description": {},
    "batch_to_item": {},
}
_cache_lock = threading.Lock()


class ColorEnrichRequest(BaseModel):
    """Body for POST /color-lot/enrich."""

    rows: list[dict[str, Any]] = []
    columns: list[dict[str, Any]] = []
    # Force a genealogy refetch instead of reusing the cached copy.
    refresh: bool = False


def _ndjson(payload: dict) -> str:
    """Serialize one streaming event as a single line of newline-delimited JSON."""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


def _step(step: str, status: str, label: str, detail: str = "") -> str:
    """Serialize one progress step event (``status`` is ``running`` or ``done``)."""
    payload: dict[str, Any] = {"type": "step", "step": step, "status": status, "label": label}
    if detail:
        payload["detail"] = detail
    return _ndjson(payload)


def _text(value: Any) -> str:
    """Normalize a cell/column value to a trimmed string (``None`` -> ``""``)."""
    if value is None:
        return ""
    return str(value).strip()


def _row_value(row: dict, key: str) -> Any:
    """Read a value from a result row by column name (case-insensitive)."""
    if not isinstance(row, dict):
        return None
    if key in row:
        return row.get(key)
    low = str(key).lower()
    for col, value in row.items():
        if str(col).lower() == low:
            return value
    return None


def _key_for(names: list[str], logical: str) -> Optional[str]:
    """The actual column key in ``names`` matching ``logical`` (case-insensitive)."""
    low = logical.lower()
    for name in names:
        if str(name).lower() == low:
            return name
    return None


def _derive_wol(name: str) -> str:
    match = _WOL_RE.search(name or "")
    return match.group(1).upper() if match else ""


def _derive_batch(name: str) -> str:
    match = _BATCH_RE.search(name or "")
    return match.group(1).upper() if match else ""


def _sample_type(name: str, wol: str, batch: str) -> str:
    """LD / Laminate / Raw / Null — mirrors the Color_Data template formula."""
    if _LD_RE.search(name or ""):
        return "LD"
    if wol:
        return "Laminate"
    if batch:
        return "Raw"
    return "Null"


def _find_fablims_connection() -> dict:
    """Look up the stored FabLIMS connection (by DSN, else display name)."""
    connections = storage.load_json("connections.json", [])
    for conn in connections:
        key = _text(conn.get("dsn") or conn.get("name")).upper()
        if key == "FABLIMS":
            return conn
    raise HTTPException(
        status_code=400,
        detail="The FabLIMS connection is not configured — add it in ODBC Setup to load the lot genealogy.",
    )


def _load_genealogy(conn: dict, refresh: bool) -> tuple[dict, dict, dict, int, bool]:
    """Return ``(wol_to_product, wol_to_description, batch_to_item, row_count, cached)``.

    The genealogy is read in full the first time (or when the cached copy is
    older than ``_CACHE_TTL_S`` / ``refresh`` is set) and then served from
    memory. Lookups keep only the FIRST match per key, exactly like the
    reference script. Rows are consumed in batches so a very large extract
    (100k+ WOL/Batch rows) never has to be held in memory at once.
    """
    with _cache_lock:
        fresh = (
            _cache["fetched_at"] > 0
            and (time.time() - _cache["fetched_at"]) < _CACHE_TTL_S
            and _cache["connection"] == _text(conn.get("dsn") or conn.get("name"))
        )
        if fresh and not refresh:
            return (
                _cache["wol_to_product"],
                _cache["wol_to_description"],
                _cache["batch_to_item"],
                _cache["rows"],
                True,
            )

        genealogy_sql = _genealogy_sql()
        odbc.assert_read_only(genealogy_sql)
        start = time.perf_counter()
        wol_to_product: dict[str, str] = {}
        wol_to_description: dict[str, str] = {}
        batch_to_item: dict[str, str] = {}
        rows = 0
        cnxn = odbc.open_connection(conn)
        try:
            cursor = cnxn.cursor()
            cursor.execute(genealogy_sql)
            header = [str(desc[0]).upper() for desc in cursor.description or []]
            i_wol = header.index("WOL")
            i_product = header.index("PRODUCT")
            i_description = header.index("DESCRIPTION")
            i_batch = header.index("G_BATCH")
            i_item = header.index("RAW_ITEM")
            while True:
                batch_rows = cursor.fetchmany(2000)
                if not batch_rows:
                    break
                rows += len(batch_rows)
                for record in batch_rows:
                    wol = _text(record[i_wol]).upper()
                    if wol and wol not in wol_to_product:
                        wol_to_product[wol] = _text(record[i_product])
                        wol_to_description[wol] = _text(record[i_description])
                    gore_batch = _text(record[i_batch]).upper()
                    if gore_batch and gore_batch not in batch_to_item:
                        batch_to_item[gore_batch] = _text(record[i_item])
        finally:
            cnxn.close()
        _cache.update(
            {
                "fetched_at": time.time(),
                "connection": _text(conn.get("dsn") or conn.get("name")),
                "rows": rows,
                "wol_to_product": wol_to_product,
                "wol_to_description": wol_to_description,
                "batch_to_item": batch_to_item,
            }
        )
        logging_utils.log_info(
            "color-lot.genealogy",
            f"loaded {rows} genealogy rows",
            details=(
                f"wol_keys={len(wol_to_product)}, batch_keys={len(batch_to_item)}, "
                f"elapsed_ms={int((time.perf_counter() - start) * 1000)}"
            ),
        )
        return wol_to_product, wol_to_description, batch_to_item, rows, False


@router.post("/color-lot/enrich")
def enrich_color_lot(payload: ColorEnrichRequest):
    """Stream the Color_Data → lot-genealogy enrichment steps and the final grid.

    The response is a newline-delimited stream: one ``{"type":"step",...}`` event
    pair (``running`` then ``done``) per stage — derive keys, load genealogy,
    match Product/Description by WOL, fill Raw_item by Batch — followed by a
    ``{"type":"result",...}`` event carrying the enriched rows plus a
    ``summary`` of the match counts. ``{"type":"error","detail":...}`` is
    emitted when the FabLIMS lookup fails.
    """
    rows = payload.rows or []
    if not rows:
        raise HTTPException(status_code=400, detail="No color rows to enrich — run the query first.")
    fab_conn = _find_fablims_connection()

    columns = payload.columns or [
        {"name": str(key), "type": ""} for key in rows[0].keys()
    ]
    base_names = [str(col.get("name")) for col in columns]

    def generate():
        start = time.perf_counter()
        try:
            # 1. WOL / Batch / Sample_type — reuse baked-in values, else derive.
            yield _step("keys", "running", "Deriving WOL and Batch from NAME")
            derived: list[dict[str, str]] = []
            for row in rows:
                name = _text(_row_value(row, "NAME"))
                wol = _text(_row_value(row, "WOL")).upper() or _derive_wol(name)
                batch = _text(_row_value(row, "Batch")).upper() or _derive_batch(name)
                sample_type = _text(_row_value(row, "Sample_type")) or _sample_type(
                    name, wol, batch
                )
                derived.append({"WOL": wol, "Batch": batch, "Sample_type": sample_type})
            wol_count = sum(1 for d in derived if d["WOL"])
            batch_count = sum(1 for d in derived if d["Batch"])
            yield _step(
                "keys",
                "done",
                "Derived WOL and Batch from NAME",
                f"{len(rows):,} rows · {wol_count:,} WOL · {batch_count:,} Batch",
            )

            # 2. Lot genealogy (cached; refetched at most once per TTL).
            yield _step("genealogy", "running", "Loading FabLIMS lot genealogy")
            wol_to_product, wol_to_description, batch_to_item, genealogy_rows, cached = (
                _load_genealogy(fab_conn, payload.refresh)
            )
            yield _step(
                "genealogy",
                "done",
                "Loaded FabLIMS lot genealogy",
                f"{genealogy_rows:,} rows {'(cached)' if cached else '(fresh)'}",
            )

            # 3. Product and Description by WOL (first match only).
            yield _step("product", "running", "Matching Product and Description by WOL")
            products = [
                wol_to_product.get(d["WOL"], "") if d["WOL"] else "" for d in derived
            ]
            descriptions = [
                wol_to_description.get(d["WOL"], "") if d["WOL"] else "" for d in derived
            ]
            product_hits = sum(1 for value in products if value)
            description_hits = sum(1 for value in descriptions if value)
            yield _step(
                "product",
                "done",
                "Matched Product and Description by WOL",
                f"{product_hits:,} of {wol_count:,} WOL rows · "
                f"{description_hits:,} Description",
            )

            # 4. Raw_item by Batch (first match only).
            yield _step("raw_item", "running", "Filling Raw_item by Batch")
            items = [batch_to_item.get(d["Batch"], "") if d["Batch"] else "" for d in derived]
            item_hits = sum(1 for value in items if value)
            yield _step(
                "raw_item",
                "done",
                "Filled Raw_item by Batch",
                f"{item_hits:,} of {batch_count:,} Batch rows",
            )

            # Column layout: keep the queried columns as they are, then append the
            # genealogy block (skipping logical names already present).
            appended = [name for name in _ENRICH_ORDER if _key_for(base_names, name) is None]
            out_columns = [dict(col) for col in columns]
            out_columns.extend({"name": name, "type": ""} for name in appended)
            targets = {name: _key_for(base_names, name) or name for name in _ENRICH_ORDER}

            out_rows = []
            for row, derived_row in zip(rows, derived):
                out = {name: _row_value(row, name) for name in base_names}
                out[targets["WOL"]] = derived_row["WOL"]
                out[targets["Batch"]] = derived_row["Batch"]
                out[targets["Sample_type"]] = derived_row["Sample_type"]
                out[targets["Product"]] = products[len(out_rows)]
                out[targets["Raw_item"]] = items[len(out_rows)]
                out[targets["Description"]] = descriptions[len(out_rows)]
                out_rows.append(out)

            elapsed_ms = int((time.perf_counter() - start) * 1000)
            logging_utils.log_info(
                "color-lot.enrich",
                f"enriched {len(out_rows)} color rows",
                details=(
                    f"wol={product_hits}/{wol_count}, batch={item_hits}/{batch_count}, "
                    f"genealogy_rows={genealogy_rows}, cached={cached}, elapsed_ms={elapsed_ms}"
                ),
            )
            yield _ndjson(
                {
                    "type": "result",
                    "rows": out_rows,
                    "columns": out_columns,
                    "row_count": len(out_rows),
                    "elapsed_ms": elapsed_ms,
                    "sql": _genealogy_sql(),
                    "summary": {
                        "rows": len(out_rows),
                        "wol_total": wol_count,
                        "wol_matched": product_hits,
                        "batch_total": batch_count,
                        "batch_matched": item_hits,
                        "genealogy_rows": genealogy_rows,
                        "cached": cached,
                    },
                }
            )
        except pyodbc.Error as exc:
            logging_utils.log_error(
                "color-lot.enrich",
                "FabLIMS lot genealogy lookup failed",
                details=str(exc),
            )
            yield _ndjson(
                {"type": "error", "detail": f"Database error: {odbc.format_db_error(exc)}"}
            )
        except Exception as exc:
            # An unexpected failure must still reach the client as an error event:
            # letting it escape would truncate the stream and the UI would only
            # report an unreadable network error.
            logging_utils.log_error(
                "color-lot.enrich",
                "FabLIMS lot genealogy enrichment failed",
                details=repr(exc),
            )
            yield _ndjson({"type": "error", "detail": f"Lot genealogy failed: {exc}"})

    return StreamingResponse(generate(), media_type=STREAM_MEDIA_TYPE)