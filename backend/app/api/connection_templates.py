"""API for connection-specific GUI query templates (e.g. FabLIMS quick-search).

A static JSON config (``backend/app/data/connection_templates.json``) defines,
per connection *name*, a set of options (e.g. Tautona / Package / Lot
genealogy). Each option lists its input fields and a parameterized SELECT
template that uses ``:name`` placeholders.

Field values are bound as ODBC parameters — never concatenated into SQL — so
arbitrary user input cannot inject statements.
"""
import datetime
import json
import os
import re
import time
from collections import OrderedDict
from typing import Any

import pyodbc
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app import logging_utils, storage
from app.api import history as history_api
from app.db import odbc
from app.db.sql_builder import detect_dbms, resolve_dbms

router = APIRouter()


def _base_dir() -> str:
    """The backend root that holds ``app/`` and ``sql/`` (the repo backend dir)."""
    # backend/app/api/<file>.py -> backend
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# Repo-adjacent static config (version-controlled, editable by a developer).
_TEMPLATES_PATH = os.path.join(_base_dir(), "app", "data", "connection_templates.json")

# Saved named component sets for the Tautona "Test Components" picker. Stored
# in the app data dir — like channel_sets.json — so they survive browser
# sessions and are shared across browsers/machines.
_COMPONENT_SETS_FILE = "component_sets.json"


class ComponentSetSave(BaseModel):
    """Body for POST /connection-templates/component-sets."""

    name: str
    result_names: list[str] = []


# Registered before the generic '/connection-templates/{template_key}' route
# so this literal path is matched first.
@router.get("/connection-templates/component-sets")
def get_component_sets():
    """Return the saved test-component sets (named RESULT_NAME selections)."""
    data = storage.load_json(_COMPONENT_SETS_FILE, {"sets": []})
    return {"sets": data.get("sets", [])}


@router.post("/connection-templates/component-sets")
def save_component_set(payload: ComponentSetSave):
    """Persist a named component set (replaces an existing set of the same name)."""
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="A component set name is required")
    # De-duplicate while keeping the user's order.
    names: list[str] = []
    for raw in payload.result_names:
        value = str(raw).strip()
        if value and value not in names:
            names.append(value)
    if not names:
        raise HTTPException(status_code=400, detail="Select at least one component to save")

    data = storage.load_json(_COMPONENT_SETS_FILE, {"sets": []})
    sets = [s for s in data.get("sets", []) if (s.get("name") or "") != name]
    sets.append({"name": name, "result_names": names})
    storage.save_json(_COMPONENT_SETS_FILE, {"sets": sets})
    logging_utils.log_info(
        "template.component-set.save",
        f"name={name} components={len(names)}",
    )
    return {"ok": True}


@router.delete("/connection-templates/component-sets")
def delete_component_set(name: str):
    """Delete a saved component set by name."""
    target = (name or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="A component set name is required")
    data = storage.load_json(_COMPONENT_SETS_FILE, {"sets": []})
    kept = [s for s in data.get("sets", []) if (s.get("name") or "") != target]
    removed = len(data.get("sets", [])) - len(kept)
    storage.save_json(_COMPONENT_SETS_FILE, {"sets": kept})
    logging_utils.log_info(
        "template.component-set.delete",
        f"name={target} removed={removed}",
    )
    return {"ok": True, "removed_count": removed}


# ---- DL_ChannelMaster "Select Channels" picker ------------------------------

# Named, pre-defined channel sets persisted per operation. Stored in the app
# data dir (like saved_content.json) so they survive browser sessions.
_CHANNEL_SETS_FILE = "channel_sets.json"

# Display column keys returned to the front end. These preserve the casing the
# user specified in the channel query (operation / group_name / description are
# lowercase; DEVICE_NBR / CHAN_NBR are uppercase).
_CHANNEL_COLUMNS = [
    {"name": "operation", "type": "str"},
    {"name": "group_name", "type": "str"},
    {"name": "description", "type": "str"},
    {"name": "DEVICE_NBR", "type": "str"},
    {"name": "CHAN_NBR", "type": "str"},
]


class ChannelSetItem(BaseModel):
    """One selected channel row inside a named channel set.

    The DL_ChannelMaster display columns are capitalized (DEVICE_NBR /
    CHAN_NBR), which is what the front end sends when a row is saved. Without
    aliases those keys were silently dropped by Pydantic, so saved sets lost
    the device/chan identity. Accept both the display keys (aliases) and the
    snake_case field names.
    """

    operation: str = ""
    group_name: str = ""
    description: str = ""
    device_nbr: str = Field(default="", alias="DEVICE_NBR")
    chan_nbr: str = Field(default="", alias="CHAN_NBR")

    model_config = ConfigDict(populate_by_name=True)


class ChannelSetSave(BaseModel):
    """Body for POST /connection-templates/channel-sets."""

    name: str
    operation: str
    channels: list[ChannelSetItem] = []


def _row_value(row: dict, key: str):
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


def _template_key(conn: dict) -> str:
    """The stable key that ties a connection to its templates & predefined scripts.

    For ODBC DSN connections this is the DSN name, which is immutable once the
    connection is created — so the user-facing display name can be edited freely
    without breaking the template / script / channel links. Non-DSN connections
    (connection string, Access file) fall back to the display name.
    """
    return str(conn.get("dsn") or conn.get("name") or "")


def _require_connection_by_template_key(template_key: str) -> dict:
    """Look up a stored connection by its template key (DSN, else name), 404 otherwise."""
    connections = storage.load_json("connections.json", [])
    conn = next(
        (c for c in connections if (c.get("dsn") or c.get("name") or "") == template_key),
        None,
    )
    if conn is None:
        raise HTTPException(status_code=404, detail=f"Connection '{template_key}' not found")
    return conn


@router.get("/connection-templates/channel-sets")
def get_channel_sets(operation: str | None = None):
    """Return the saved channel sets, optionally filtered by operation name.

    Operation names are compared on a trimmed basis because legacy sets were
    persisted with trailing spaces; the front end always sends a trimmed value.
    """
    data = storage.load_json(_CHANNEL_SETS_FILE, {"sets": []})
    sets = list(data.get("sets", []))
    if operation is not None and str(operation).strip():
        target = str(operation).strip()
        sets = [s for s in sets if (s.get("operation") or "").strip() == target]
    return {"sets": sets}


@router.post("/connection-templates/channel-sets")
def save_channel_set(payload: ChannelSetSave):
    """Persist a named channel set and associate it with its operation."""
    name = (payload.name or "").strip()
    operation = (payload.operation or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="A channel set name is required")
    if not operation:
        raise HTTPException(status_code=400, detail="An operation is required")
    if not payload.channels:
        raise HTTPException(status_code=400, detail="Select at least one channel to save")

    data = storage.load_json(_CHANNEL_SETS_FILE, {"sets": []})
    sets = list(data.get("sets", []))
    # Reuse an existing set of the same name+operation (single dropdown entry).
    sets = [
        s
        for s in sets
        if not ((s.get("name") or "") == name and (s.get("operation") or "").strip() == operation)
    ]
    sets.append(
        {
            "name": name,
            "operation": operation,
            "channels": [c.model_dump() for c in payload.channels],
        }
    )
    storage.save_json(_CHANNEL_SETS_FILE, {"sets": sets})
    logging_utils.log_info(
        "template.channel-set.save",
        f"operation={operation} name={name} channels={len(payload.channels)}",
    )
    return {"ok": True}


@router.delete("/connection-templates/channel-sets")
def delete_channel_set(name: str, operation: str | None = None):
    """Delete a saved channel set by name (optionally scoped to an operation)."""
    target = (name or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="A channel set name is required")
    op = (operation or "").strip()
    data = storage.load_json(_CHANNEL_SETS_FILE, {"sets": []})
    kept = []
    removed = 0
    for s in data.get("sets", []):
        same_name = (s.get("name") or "") == target
        same_op = (not op) or (s.get("operation") or "").strip() == op
        if same_name and same_op:
            removed += 1
        else:
            kept.append(s)
    storage.save_json(_CHANNEL_SETS_FILE, {"sets": kept})
    logging_utils.log_info(
        "template.channel-set.delete",
        f"name={target} operation={op or '(any)'} removed={removed}",
    )
    return {"ok": True, "removed_count": removed}


@router.get("/connection-templates/{template_key}/channel-operations")
def get_channel_operations(template_key: str):
    """Distinct operations available in DL_ChannelMaster (single-select feed)."""
    conn = _require_connection_by_template_key(template_key)
    sql = "SELECT DISTINCT operation FROM DL_ChannelMaster ORDER BY operation ASC"
    try:
        rows, _ = odbc.run_query(conn, sql)
    except pyodbc.Error as exc:
        logging_utils.log_error(
            "template.channel-operations",
            f"connection={template_key} failed",
            details=str(exc),
        )
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc

    operations = []
    for row in rows:
        value = _row_value(row, "operation")
        text = str(value or "").strip()
        if text:
            operations.append(text)
    logging_utils.log_info(
        "template.channel-operations",
        f"connection={template_key} returned {len(operations)} operations",
    )
    return {"connection_name": template_key, "operations": operations}


@router.get("/connection-templates/{template_key}/channels")
def get_channels(template_key: str, operation: str):
    """Channel rows for one operation, normalized to the display column keys."""
    conn = _require_connection_by_template_key(template_key)
    op = (operation or "").strip()
    if not op:
        raise HTTPException(status_code=400, detail="An operation is required")
    sql = (
        "SELECT operation as Operation, group_name as Group_Name, description as Description, DEVICE_NBR as 'DEVICE_NUM', CHAN_NBR as 'DATA_CHAN_' "
        "FROM DL_ChannelMaster WHERE operation = ? "
        "ORDER BY group_name, description, DEVICE_NBR, CHAN_NBR"
    )
    try:
        rows, _ = odbc.run_query(conn, sql, [op])
    except pyodbc.Error as exc:
        logging_utils.log_error(
            "template.channels",
            f"connection={template_key} operation={op} failed",
            details=str(exc),
        )
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc

    normalized_rows = []
    for row in rows:
        normalized_rows.append(
            {
                "operation": str(_row_value(row, "operation") or ""),
                "group_name": str(_row_value(row, "group_name") or ""),
                "description": str(_row_value(row, "description") or ""),
                "DEVICE_NBR": str(_row_value(row, "DEVICE_NBR") or ""),
                "CHAN_NBR": str(_row_value(row, "CHAN_NBR") or ""),
            }
        )
    logging_utils.log_info(
        "template.channels",
        f"connection={template_key} operation={op} returned {len(normalized_rows)} rows",
    )
    return {
        "connection_name": template_key,
        "operation": op,
        "columns": _CHANNEL_COLUMNS,
        "rows": normalized_rows,
    }


# ---- Process_Data "Transform": wide-table pivot ------------------------------

# Fixed columns carried through from the queried raw data, in order.
_TRANSFORM_FIXED_NAMES = [
    "WOL",
    "Prefix",
    "Suffix",
    "Date_Time",
    "WCenter",
    "Operation",
    "Product",
]


class TransformChannel(BaseModel):
    """One selected channel row from a pre-defined channel set.

    The set rows define the devices + data channels to keep (the SELECTED
    mapping in the reference transform script). DEVICE_NBR / CHAN_NBR are
    accepted as aliases because saved sets persist the snake_case field names.
    """

    operation: str = ""
    group_name: str = ""
    description: str = ""
    device_nbr: str = Field(default="", alias="DEVICE_NBR")
    chan_nbr: str = Field(default="", alias="CHAN_NBR")

    model_config = ConfigDict(populate_by_name=True)


class TransformRequest(BaseModel):
    """Body for POST /connection-templates/transform."""

    connection_id: str
    operation: str
    rows: list[dict[str, Any]] = []
    channels: list[TransformChannel] = []
    sql: str = ""


def _present_columns(rows: list[dict], names: list[str]) -> list[str]:
    """Return the subset of ``names`` present in the raw row dicts (case-insensitive)."""
    if not rows:
        return list(names)
    keys = set()
    for row in rows:
        for key in row.keys():
            keys.add(str(key).lower())
    return [name for name in names if name.lower() in keys]


def _typed_columns(header: list[str], out_rows: list[list[Any]]) -> list[dict]:
    """Build the wide-table column metadata by inferring the value type."""
    columns = []
    for i, name in enumerate(header):
        ctype = "str"
        for row in out_rows:
            if i >= len(row) or row[i] is None:
                continue
            value = row[i]
            if isinstance(value, (datetime.datetime, datetime.date)):
                ctype = "datetime"
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                ctype = "number"
            break
        columns.append({"name": name, "type": ctype})
    return columns


@router.post("/connection-templates/transform")
def transform_connection_template(payload: TransformRequest):
    """Pivot Process_Data raw rows + DL_ChannelMaster into a Wide table.

    Inputs (all from the front end):
      - ``rows``: the queried raw data already in the grid (columns such as
        WOL, Prefix, Suffix, Date_Time, WCenter, Operation, Product, DEVICE_NUM,
        DATA_CHAN_n …) — this is the "execute the editor SQL" part already run.
      - ``channels``: the selected pre-defined channel set rows, which define
        the devices + data channels to keep (the SELECTED mapping).
      - ``operation``: drives the DL_ChannelMaster lookup for the column
        descriptions.

    DL_ChannelMaster is re-queried here (operation, device_num, data_chan_num,
    description, group_name) to supply the descriptions referenced by the
    reference transform script. Devices are merged side-by-side on Date_Time.
    """
    conn = _get_connection(payload.connection_id)
    if _template_key(conn).upper() != "SZMFGACTIVE":
        raise HTTPException(
            status_code=400,
            detail="Transform is only available for the SZMFGACTIVE connection.",
        )
    op = str(payload.operation or "").strip()
    if not op:
        raise HTTPException(status_code=400, detail="An operation is required")
    rows = payload.rows or []
    if not rows:
        raise HTTPException(status_code=400, detail="No queried rows to transform — run the query first.")
    channels = payload.channels or []
    if not channels:
        raise HTTPException(status_code=400, detail="Select at least one channel to transform.")

    start = time.perf_counter()

    # 1. DL_ChannelMaster: (operation, device, channel) -> description.
    # NOTE: the real column names are DEVICE_NBR / CHAN_NBR (see get_channels).
    master_sql = (
        "SELECT operation, DEVICE_NBR, CHAN_NBR, description, group_name "
        "FROM DL_ChannelMaster WHERE operation = ?"
    )
    odbc.assert_read_only(master_sql)
    try:
        master_rows, _ = odbc.run_query(conn, master_sql, [op])
    except pyodbc.Error as exc:
        logging_utils.log_error(
            "template.channels",
            f"connection={_template_key(conn)} operation={op} failed",
            details=str(exc),
        )
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc
    ref_map = {}
    desc_to_dc: dict[str, list[tuple[int, int]]] = {}
    for row in master_rows:
        dev = _row_value(row, "device_num")
        if dev is None:
            dev = _row_value(row, "DEVICE_NBR")
        chan = _row_value(row, "data_chan_num")
        if chan is None:
            chan = _row_value(row, "CHAN_NBR")
        if dev is None or chan is None:
            continue
        try:
            dev = int(dev)
            chan = int(chan)
        except (TypeError, ValueError):
            continue
        desc = str(_row_value(row, "description") or "").strip()
        ref_map[(op, dev, chan)] = desc
        if desc:
            desc_to_dc.setdefault(desc, [])
            if (dev, chan) not in desc_to_dc[desc]:
                desc_to_dc[desc].append((dev, chan))

    # 2. SELECTED: device -> [data channel numbers], ordered as selected.
    #    Older saved channel sets may have empty device/chan numbers; fall back
    #    to resolving them from DL_ChannelMaster by description.
    selected: OrderedDict[int, list[int]] = OrderedDict()
    resolved_by_desc = 0

    def _add(dev_i: int, chan_i: int) -> None:
        if chan_i not in selected.setdefault(dev_i, []):
            selected[dev_i].append(chan_i)

    for ch in channels:
        dev_i = chan_i = None
        try:
            dev_i = int(ch.device_nbr)
            chan_i = int(ch.chan_nbr)
        except (TypeError, ValueError):
            dev_i = chan_i = None
        if dev_i is not None and chan_i is not None:
            _add(dev_i, chan_i)
            continue
        # Empty/invalid device/chan -> resolve the channel by its description.
        matches = desc_to_dc.get((ch.description or "").strip(), [])
        if not matches:
            continue
        resolved_by_desc += 1
        for (d, c) in matches:
            _add(d, c)

    # 3. Fixed columns actually present in the raw data.
    present_fixed = _present_columns(rows, _TRANSFORM_FIXED_NAMES)

    # 4. Fixed fields (per Date_Time) + channel values (per device + date).
    fixed_by_date: OrderedDict[Any, list[Any]] = OrderedDict()
    chan_by_dev_date: dict[int, dict[Any, list[Any]]] = {}
    for row in rows:
        dn = _row_value(row, "DEVICE_NUM")
        if dn is None:
            continue
        try:
            dn = int(dn)
        except (TypeError, ValueError):
            continue
        if dn not in selected:
            continue
        date = _row_value(row, "Date_Time")
        if date not in fixed_by_date:
            fixed_by_date[date] = [_row_value(row, n) for n in present_fixed]
        vals = [_row_value(row, f"DATA_CHAN_{n}") for n in selected[dn]]
        chan_by_dev_date.setdefault(dn, {}).setdefault(date, vals)

    # 5. Header: fixed fields + one column per selected channel (description).
    # ---- Diagnostics for "0 rows" ----
    seen_devs = OrderedDict()
    if rows:
        first_keys = sorted(str(k) for k in rows[0].keys())
        for r in rows:
            d = _row_value(r, "DEVICE_NUM")
            if d is not None:
                seen_devs[str(d)] = seen_devs.get(str(d), 0) + 1
    else:
        first_keys = []
    logging_utils.log_info(
        "template.transform.diag",
        f"operation={op!r} input_rows={len(rows)} channels={len(channels)} "
        f"master_rows={len(master_rows)} selected={dict(selected)} "
        f"resolved_by_desc={resolved_by_desc}",
        details=", ".join(
            [
                f"raw_cols={first_keys}",
                f"raw_devices={dict(seen_devs)}",
                f"fixed_cols={present_fixed}",
                f"date_rows={len(fixed_by_date)}",
            ]
        ),
    )

    header = list(present_fixed)
    for dn in selected:
        for n in selected[dn]:
            header.append(ref_map.get((op, dn, n)) or f"DATA_CHAN_{n}")

    # 6. Merge all devices side-by-side on Date_Time.
    out_rows: list[list[Any]] = []
    for date in fixed_by_date:
        out_row = list(fixed_by_date[date])
        for dn in selected:
            vals = chan_by_dev_date.get(dn, {}).get(date)
            out_row.extend(vals if vals is not None else [None] * len(selected[dn]))
        out_rows.append(out_row)

    if not out_rows:
        raw_devices = dict(seen_devs)
        raise HTTPException(
            status_code=400,
            detail=(
                f"Transform produced no rows. operation={op!r} "
                f"selected_devices={list(selected)} "
                f"devices_in_data={raw_devices} "
                f"master_rows={len(master_rows)}. "
                "Select channels whose device numbers appear in the queried data "
                "and verify the operation value."
            ),
        )

    columns = _typed_columns(header, out_rows)
    result_rows = [dict(zip(header, row)) for row in out_rows]
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    logging_utils.log_info(
        "template.transform",
        f"connection={_template_key(conn)} operation={op} devices={len(selected)} "
        f"rows={len(result_rows)}",
        details=f"input_rows={len(rows)}, elapsed_ms={elapsed_ms}",
    )
    return {
        "rows": result_rows,
        "columns": columns,
        "row_count": len(result_rows),
        "elapsed_ms": elapsed_ms,
        "sql": payload.sql or "",
    }


# Supported per-field operators. Each returns (sql_fragment, bound_params).
# 'is null' / 'is not null' take no value; 'between' consumes the field value
# plus a second value under "<key>__to".
_OPERATORS = {
    "=",
    "<>",
    "like",
    "not like",
    "in",
    "not in",
    "is null",
    "is not null",
    ">",
    "<",
    ">=",
    "<=",
    "between",
}

# Operators that do not need a value input.
_NO_VALUE_OPERATORS = {"is null", "is not null"}

# For SZMFGACTIVE's Process_Data template, the '<>' FROM placeholder is
# substituted with the physical table name derived from the operation value
# rather than the operation itself. Unknown operations fall back to the raw
# operation value (legacy behaviour) so other '<>'-bearing templates are safe.
_OPERATION_TABLE_MAP = {
    "180COT": "L08_Mfg_Data",
    "180D10C": "L10c_Mfg_Data",
    "180D16C": "L16c_Mfg_Data",
    "180L07A": "L07_Mfg_Data",
    "180L07B": "L07_Mfg_Data",
    "180L07C": "L07_Mfg_Data",
    "180L11C": "L11c_Mfg_Data",
    "180L26C": "L26c_Mfg_Data",
    "180L88C": "L88c_Mfg_Data",
}

# Operation values occasionally arrive with the line number missing its leading
# zero — either the operation code itself ('180L7A' instead of '180L07A') or a
# literal table name ('L7_Mfg_Data' instead of 'L07_Mfg_Data'). Resolve those
# to the same physical table before falling back to the raw value.
_SINGLE_DIGIT_RE = re.compile(r"(?<!\d)(\d)(?!\d)")


def _resolve_process_table(op_value: str) -> str:
    """Return the physical '<>' FROM table for a Process_Data operation value.

    Tries, in order: the exact operation-code mapping, the value re-interpreted
    as a table-like name with a zero-padded line number, the operation code with
    a zero-padded line number, then the raw value (legacy fallback).

    Only single-digit runs are zero-padded, so multi-digit numbers ('180',
    'L88c') are never touched.
    """
    value = (op_value or "").strip()
    if value in _OPERATION_TABLE_MAP:
        return _OPERATION_TABLE_MAP[value]

    def pad_single_digits(text: str) -> str:
        return _SINGLE_DIGIT_RE.sub(lambda m: "0" + m.group(1), text)

    lowered = value.lower()
    if lowered.startswith("l") and lowered.endswith("_mfg_data"):
        padded = pad_single_digits(value)
        canonical = next(
            (t for t in _OPERATION_TABLE_MAP.values() if t.lower() == padded.lower()),
            None,
        )
        if canonical:
            return canonical
    padded_op = pad_single_digits(value)
    if padded_op in _OPERATION_TABLE_MAP:
        return _OPERATION_TABLE_MAP[padded_op]
    return value


def _load_templates() -> dict:
    """Return {connection_name: {options: [...]}} from the JSON config."""
    if not os.path.exists(_TEMPLATES_PATH):
        return {}
    try:
        with open(_TEMPLATES_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _template_entry(template_key: str) -> dict | None:
    """Case-insensitive lookup of a connection's template entry.

    Access-file connections key off their display name, which the user may
    have cased differently from the JSON config ('colorDB' vs 'ColorDB').
    JSON keys are case-sensitive while the base SQL folder lookup is not — on
    Windows the folder still resolves, so the option appears in the UI with
    empty fields. Matching on case keeps the criteria and derived columns.
    """
    templates = _load_templates()
    if template_key in templates:
        return templates[template_key]
    lowered = str(template_key).lower()
    for key, entry in templates.items():
        if str(key).lower() == lowered:
            return entry
    return None


# Base SQL files live in backend/sql/<template_key>/*.sql and replace the
# hardcoded 'sql' templates: the file is the source of the SQL, while the JSON
# config stays the source of the input fields.
_BASE_SQL_DIR = os.path.join(_base_dir(), "sql")


def _load_base_sql_options(template_key: str) -> dict[str, str]:
    """Return {option_name: sql} for backend/sql/<template_key>/*.sql."""
    base_dir = os.path.join(_BASE_SQL_DIR, template_key)
    if not os.path.isdir(base_dir):
        return {}
    options: dict[str, str] = {}
    try:
        for fname in sorted(os.listdir(base_dir)):
            if not fname.lower().endswith(".sql"):
                continue
            stem = fname[: -len(".sql")]
            with open(os.path.join(base_dir, fname), "r", encoding="utf-8") as fh:
                options[stem] = fh.read()
    except OSError:
        return {}
    return options


def _json_options_by_name(template_key: str) -> dict[str, dict]:
    """Return {option_name: option} from the JSON config for a template key.

    The JSON config remains the source of the per-option metadata (input
    fields, derived ``computed_columns``) even when the SQL itself is loaded
    from backend/sql/<template_key>/*.sql.
    """
    entry = _template_entry(template_key) or {}
    return {
        str(o.get("name")): o
        for o in entry.get("options", [])
        if o.get("name")
    }


def _effective_options(template_key: str) -> list[dict] | None:
    """Return the template options for a template key (DSN, else name).

    When base SQL files exist for the key (backend/sql/<key>/), one option is
    created per file, named after the file, with the SQL loaded from it and the
    input fields matched from the JSON config by name. Falls back to the JSON
    config alone when no base SQL folder is present. Returns None when the key
    has no templates at all.
    """
    json_entry = _template_entry(template_key)
    base_options = _load_base_sql_options(template_key)
    if base_options:
        options_by_name = _json_options_by_name(template_key)
        merged: list[dict] = []
        for stem, sql in base_options.items():
            cfg = options_by_name.get(stem, {})
            merged.append(
                {
                    "name": stem,
                    "fields": cfg.get("fields", []),
                    # Per-row derived columns evaluated by the app after the
                    # query (see frontend/src/utils/formula.ts).
                    "computed_columns": cfg.get("computed_columns", []),
                    "sql": sql,
                }
            )
        return merged
    if json_entry is None:
        return None
    return json_entry.get("options", [])


def _get_connection(connection_id: str) -> dict:
    """Look up a stored connection, raising 404 when it does not exist."""
    from app.main import get_stored_connection  # deferred to avoid import cycle

    return get_stored_connection(connection_id)


@router.get("/connection-templates/{template_key}")
def list_connection_templates(template_key: str):
    """Return the GUI options (with their fields) defined for a template key.

    Connections without templates return an empty ``options`` list (the SQL
    tab then simply shows no template UI) instead of a 404.
    """
    options = _effective_options(template_key) or []
    # Expose the fields + SQL base the form needs for its live preview.
    def public_fields(fields):
        return [
            {
                "key": f.get("key"),
                # 'alias' is the friendly display name (the base SQL SELECT
                # alias, e.g. 'WOL' for gm_batch.TO_LOT); 'label' stays the
                # table.column reference used to build the WHERE clause.
                "label": f.get("alias") or f.get("label") or f.get("key"),
                "alias": f.get("alias"),
                "type": f.get("type") or "varchar",
                "operator": f.get("operator") or "=",
                # Optional fields may be left blank (the condition is then
                # omitted); 'column' overrides the SQL column expression used
                # at run time (e.g. "(GM_WOL.G_MAN_DATE + 0.5)").
                "optional": bool(f.get("optional")),
                # Pre-filled value for the field (e.g. a default branch plant).
                "default": f.get("default"),
                # Greyed-out example value shown when the field is empty. It is
                # a hint only and never becomes a condition.
                "placeholder": f.get("placeholder"),
                "column": f.get("column") or f.get("label") or f.get("key"),
            }
            for f in fields
        ]

    return {
        "connection_name": template_key,
        "options": [
            {
                "name": o.get("name"),
                "fields": public_fields(o.get("fields", [])),
                # Derived columns applied to every result this option returns.
                "computed_columns": o.get("computed_columns", []),
                "sql": o.get("sql") or "",
            }
            for o in options
        ],
    }


@router.get("/connection-templates/{template_key}/test-components")
def get_test_components(template_key: str):
    """Distinct test components (ANALYSIS + DESCRIPTION) with their RESULT_NAMEs.

    Feeds the "Test Components" picker for the Tautona quick-search: each
    component (an ANALYSIS row) maps to the COMPONENT names it produces for
    its latest version, which serve as the RESULT_NAME filter values.
    """
    conn = _require_connection_by_template_key(template_key)
    sql = (
        "SELECT COMPONENT.analysis AS 'ANALYSIS', analysis.reported_name AS 'DESCRIPTION', "
        "COMPONENT.name AS 'COMPONENT' "
        "FROM COMPONENT "
        "LEFT JOIN analysis ON analysis.name = COMPONENT.analysis "
        "AND analysis.version = COMPONENT.version "
        "WHERE COMPONENT.ANALYSIS IN ( "
        "SELECT DISTINCT t.ANALYSIS FROM TEST t WHERE t.ANALYSIS LIKE 'FABLA%' ) "
        "AND COMPONENT.VERSION = (SELECT MAX(comp1.VERSION) FROM COMPONENT comp1 "
        "WHERE comp1.ANALYSIS = COMPONENT.ANALYSIS) "
        "ORDER BY COMPONENT.ANALYSIS"
    )
    try:
        rows, _ = odbc.run_query(conn, sql)
    except pyodbc.Error as exc:
        logging_utils.log_error(
            "template.test-components",
            f"connection={template_key} failed",
            details=str(exc),
        )
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc

    grouped: dict[str, dict] = {}
    for row in rows:
        analysis = str(row.get("ANALYSIS") or "").strip()
        if not analysis:
            continue
        item = grouped.setdefault(
            analysis,
            {"name": analysis, "description": str(row.get("DESCRIPTION") or ""), "result_names": []},
        )
        component = str(row.get("COMPONENT") or "").strip()
        if component and component not in item["result_names"]:
            item["result_names"].append(component)
    components = sorted(
        grouped.values(),
        key=lambda item: (item["name"].lower(), item["description"].lower()),
    )
    logging_utils.log_info(
        "template.test-components",
        f"connection={template_key} returned {len(components)} components",
    )
    return {"connection_name": template_key, "components": components}


# Column names for user-added parameters must be plain identifiers (optionally
# table-qualified). Values are always bound as ODBC parameters.
_EXTRA_COLUMN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$#]*(\.[A-Za-z_][A-Za-z0-9_$#]*)?$")

# Oracle DATE columns must be compared through TO_DATE() — a bare string
# literal triggers ORA-01861. Inputs come from the date / datetime-local pickers
# as 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'.
_TO_DATE_MASK = "YYYY-MM-DD HH24:MI:SS"


def _to_date_bind() -> str:
    """A bound parameter wrapped in Oracle TO_DATE(), for the fixed mask."""
    return f"TO_DATE(?, '{_TO_DATE_MASK}')"


def _date_ts(raw: str) -> str:
    """Normalise a date/datetime input to a full timestamp for TO_DATE()."""
    text = str(raw).strip().replace("T", " ")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text + " 00:00:00"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", text):
        return text + ":00"
    return text


class ExtraFilter(BaseModel):
    """One user-added parameter: a column from the base SQL plus a filter."""

    column: str
    operator: str = "="
    value: str = ""
    value_to: str = ""  # second bound for BETWEEN


class TemplateRunRequest(BaseModel):
    """Body for POST /connection-templates/run."""

    connection_id: str
    option_name: str
    values: dict[str, str] = {}
    operators: dict[str, str] = {}
    extra_filters: list[ExtraFilter] = []


def _render_field_fragment(
    field: dict, operators: dict, values: dict, params: list, use_to_date: bool = False
) -> str | None:
    """Render one configured field as an ``AND <column> <op> ?`` fragment.

    The column expression comes from the field config; the fragment is injected
    at the '{}' anchor of the base SQL together with the user-added parameters.
    Blank optional fields are omitted (None returned) — no '1 = 1' filler is
    needed because the fragment is not pinned to a placeholder position.

    ``use_to_date`` is True only for Oracle connections: date/datetime columns
    must be compared via TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS') (see _to_date_bind).
    Other DBMSs bind the value as a plain parameter.
    """
    key = field.get("key")
    label = field.get("label") or key
    column = field.get("column") or label
    raw = str(values.get(key, "")).strip()
    operator = (operators.get(key) or field.get("operator") or "=").lower()
    is_date = field.get("type") in ("datetime", "date")
    # Oracle DATE columns use TO_DATE(); other servers keep the raw bind.
    use_odate = is_date and use_to_date

    if operator in ("is null", "is not null"):
        return f"AND {column} {operator.upper()}"
    if not raw:
        # Blank optional field: omit the condition. Required fields are
        # validated before rendering, so a blank here is always optional.
        return None
    if operator == "between":
        raw_to = str(values.get(key + "__to", "")).strip()
        if not raw_to:
            raise HTTPException(status_code=400, detail=f"Field '{label}' needs a 'to' value for BETWEEN")
        params.extend([_date_ts(raw) if use_odate else raw, _date_ts(raw_to) if use_odate else raw_to])
        bind = " BETWEEN " + (_to_date_bind() if use_odate else "?")
        return f"AND {column}{bind} AND " + (_to_date_bind() if use_odate else "?")
    if operator in ("like", "not like"):
        params.append(f"%{raw}%")
        return f"AND {column} {'NOT LIKE' if operator == 'not like' else 'LIKE'} ?"
    if operator in ("in", "not in") or ";" in raw:
        # Any field's value may be a list: ';'-separated (values may contain
        # commas), rendered as an IN clause.
        parts = [part.strip() for part in raw.split(";") if part.strip()]
        if not parts:
            detail = (
                f"Field '{label}' needs ';'-separated values for {operator.upper()}"
                if operator in ("in", "not in")
                else f"Field '{label}' is required"
            )
            raise HTTPException(status_code=400, detail=detail)
        params.extend([_date_ts(part) if use_odate else part for part in parts])
        placeholders = ", ".join(_to_date_bind() if use_odate else "?" for _ in parts)
        return f"AND {column} {'NOT IN' if operator == 'not in' else 'IN'} ({placeholders})"
    params.append(_date_ts(raw) if use_odate else raw)
    return f"AND {column} {operator} " + (_to_date_bind() if use_odate else "?")


@router.post("/connection-templates/run")
def run_connection_template(payload: TemplateRunRequest):
    """Run a template option with the submitted field values (parameterized)."""
    conn = _get_connection(payload.connection_id)
    # Oracle DATE columns need TO_DATE() wrapping; other servers bind plainly.
    dbms = resolve_dbms(conn, detect_dbms(conn))
    use_to_date = bool(dbms and "oracle" in str(dbms).lower())
    conn_key = _template_key(conn)
    options = _effective_options(conn_key)
    if not options:
        raise HTTPException(
            status_code=400,
            detail=f"No templates configured for connection '{conn_key}'",
        )
    option = next(
        (o for o in options if o.get("name") == payload.option_name),
        None,
    )
    if option is None:
        raise HTTPException(
            status_code=400,
            detail=f"Option '{payload.option_name}' not found for connection '{conn_key}'",
        )
    template_sql = (option.get("sql") or "").strip()
    if not template_sql:
        raise HTTPException(
            status_code=400,
            detail=f"Option '{payload.option_name}' has no SQL template configured yet",
        )

    # Validate the submitted operators (fall back to config defaults).
    fields_by_key = {}
    for field in option.get("fields", []):
        key = field.get("key")
        if key:
            fields_by_key[key] = field
    operators = {key: op for key, op in (payload.operators or {}).items() if key in fields_by_key}
    for key, op in operators.items():
        if op.lower() not in _OPERATORS:
            raise HTTPException(status_code=400, detail=f"Unsupported operator '{op}' for field '{key}'")

    # Every configured field must be filled in — except IS NULL / IS NOT NULL
    # (no value), BETWEEN (needs the second '<key>__to' value too) and optional
    # fields (may be left blank, the condition is then omitted).
    for field in option.get("fields", []):
        key = field.get("key")
        if not key:
            continue
        if field.get("optional"):
            continue
        label = field.get("label") or key
        operator = (operators.get(key) or field.get("operator") or "=").lower()
        if operator in _NO_VALUE_OPERATORS:
            continue
        if not str(payload.values.get(key, "")).strip():
            raise HTTPException(status_code=400, detail=f"Field '{label}' is required")
        if operator == "between" and not str(payload.values.get(key + "__to", "")).strip():
            raise HTTPException(status_code=400, detail=f"Field '{label}' needs a 'to' value for BETWEEN")

    # Templates may carry a '<>' FROM placeholder (Process_Data). When present,
    # the selected operation value substitutes that placeholder and therefore
    # must not also become a WHERE condition. Only a template that declares an
    # 'operation' field uses the placeholder — in any other template '<>' is a
    # plain not-equal comparison and must be left alone.
    has_from_placeholder = "<>" in template_sql and any(
        f.get("key") == "operation" for f in option.get("fields", [])
    )
    if has_from_placeholder and not str(payload.values.get("operation", "")).strip():
        raise HTTPException(status_code=400, detail="Field 'operation' is required")

    # Render every configured field (in config order) into an 'AND <col> <op> ?'
    # fragment, with values bound as positional '?' ODBC params. Blank optional
    # fields are omitted.
    params: list[Any] = []
    fragments: list[str] = []
    for field in option.get("fields", []):
        key = field.get("key")
        if not key:
            continue
        # The 'operation' field feeds the '<>' FROM placeholder, not a WHERE
        # condition, so it is skipped here when the template uses '<>'.
        if has_from_placeholder and key == "operation":
            continue
        fragment = _render_field_fragment(field, operators, payload.values, params, use_to_date)
        if fragment:
            fragments.append(fragment)

    # User-added parameters (columns picked from the base SQL). Each becomes an
    # 'AND <col> <op> ?' fragment; column names are validated as plain
    # identifiers and all values are bound as ODBC parameters. When the base
    # SQL contains a '{}' anchor all criteria (fields + user-added) are
    # injected there — so a tail (ORDER BY, GROUP BY, subqueries, …) is never
    # disturbed. Without an anchor they are appended at the end (legacy
    # behaviour).
    extra_fragments: list[str] = []
    for ef in payload.extra_filters or []:
        col = (ef.column or "").strip()
        if not _EXTRA_COLUMN_RE.match(col):
            raise HTTPException(status_code=400, detail=f"Invalid column name '{col}'")
        op = (ef.operator or "=").lower()
        if op not in _OPERATORS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported operator '{ef.operator}' for column '{col}'",
            )
        if op in _NO_VALUE_OPERATORS:
            extra_fragments.append(f"AND {col} {op.upper()}")
        elif op == "between":
            raw_to = str(ef.value_to or "").strip()
            if not raw_to:
                raise HTTPException(
                    status_code=400,
                    detail=f"Column '{col}' needs a 'to' value for BETWEEN",
                )
            extra_fragments.append(f"AND {col} BETWEEN ? AND ?")
            params.extend([ef.value, raw_to])
        elif op in ("like", "not like"):
            extra_fragments.append(f"AND {col} {'NOT LIKE' if op == 'not like' else 'LIKE'} ?")
            params.append(f"%{ef.value}%")
        elif op in ("in", "not in") or ";" in str(ef.value or ""):
            # Any column's value may be a list: ';'-separated (values may
            # contain commas), rendered as an IN clause.
            parts = [p.strip() for p in str(ef.value or "").split(";") if p.strip()]
            if not parts:
                detail = (
                    f"Column '{col}' needs ';'-separated values for {op.upper()}"
                    if op in ("in", "not in")
                    else f"Column '{col}' needs a value"
                )
                raise HTTPException(status_code=400, detail=detail)
            placeholders = ", ".join("?" for _ in parts)
            extra_fragments.append(f"AND {col} {'NOT IN' if op == 'not in' else 'IN'} ({placeholders})")
            params.extend(parts)
        else:
            extra_fragments.append(f"AND {col} {op} ?")
            params.append(ef.value)

    fragments.extend(extra_fragments)
    sql = template_sql
    # Substitute the selected operation value into the '<>' FROM placeholder
    # (Process_Data) before injecting the WHERE criteria at '{}'.
    op_value = str(payload.values.get("operation", "")).strip()
    if has_from_placeholder and op_value:
        from_value = _resolve_process_table(op_value)
        sql = sql.replace("<>", from_value)
    if "{}" in sql:
        injection = ("\n  " + "\n  ".join(fragments)) if fragments else ""
        sql = sql.replace("{}", injection)
    elif fragments:
        sql = sql.rstrip() + "\n  " + "\n  ".join(fragments)

    try:
        odbc.assert_read_only(sql)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    start = time.perf_counter()
    try:
        rows, col_types = odbc.run_query(conn, sql, params)
    except pyodbc.Error as exc:
        logging_utils.log_error(
            "template.run",
            f"connection={conn_key} option={payload.option_name} failed",
            details=str(exc),
        )
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    columns = [{"name": name, "type": str(type_code)} for name, type_code in col_types]

    logging_utils.log_info(
        "template.run",
        f"connection={conn_key} option={payload.option_name} returned {len(rows)} rows",
        details=f"rows={len(rows)}, elapsed_ms={elapsed_ms}",
    )
    history_api.add_history_entry(
        connection_id=payload.connection_id,
        kind="builder",
        sql=sql,
        query=payload.model_dump(),
        row_count=len(rows),
        elapsed_ms=elapsed_ms,
    )
    return {
        "rows": rows,
        "columns": columns,
        "row_count": len(rows),
        "elapsed_ms": elapsed_ms,
        "sql": sql,
    }
