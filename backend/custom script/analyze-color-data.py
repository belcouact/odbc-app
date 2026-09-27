#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze-color-data.py

Lab colour explorer for Color_Data: one self-contained HTML page with six tabs.

  1. Stats          - overview charts: sample-type mix (pie), LD_item count
                      per textile, distinct Raw batches per Raw_item, measurements
                      per month and a ΔE histogram of matched Raw samples vs
                      their LD_item mean (0.7 target line).
  2. LD heat map    - one row per LD_item in a searchable, sortable table
                      (100 rows per page), coloured by the mean colour of its
                      LD samples. The Matched Raw column counts the Raw samples
                      referencing the item; the LD_item link opens a detail
                      view with the item's ΔE per batch # (CIEDE2000 of every
                      matched Raw sample vs a selectable reference LD_item's
                      mean colour — only items with matched Raw samples are
                      listed — 0.7 target line, outliers beyond the
                      Q3+1.5×IQR fence in red, zoomable x-axis) above a
                      searchable, sortable table of those samples.
  3. Unmatched Raw  - table of Raw_items that do NOT match any LD_item,
                      coloured by the mean colour of their own Raw samples;
                      the Raw_item link lists those samples.
  4. Laminate       - every Sample_type='Laminate' row in a searchable table
                      with its Raw_item column; a ΔE reference dropdown lists
                      the LD samples (by NAME) reachable through the rows'
                      Raw_item and scores every laminate colour against the
                      selected sample (CIEDE2000, last column).
  5. ΔE Compare     - like-colour pairs within a textile (the LD_item prefix),
                      pairing individual LD samples by NAME: only pairs whose
                      straight Lab distance is within the like-colour cutoff
                      are scored with CIEDE2000. A baseline input highlights
                      pairs below it; clicking a row shows the two samples'
                      colours.
  6. Match Pantone  - pick a Pantone TCX colour (the 2,310-colour library is
                      embedded in this script), optionally narrow the search
                      to a face textile — the first 4 characters of an
                      LD_item (Gore item) or of a Raw_item (supplier textile)
                      — and the tab reports the nearest item by CIEDE2000:
                      the nearest LD_item when the chosen textile has one,
                      otherwise the nearest unmatched Raw_item.

Every tab shows the colour as a large swatch in its own column.

Built with Apache ECharts (canvas). The colour swatches reuse the Hex column
computed by the grid, and the ΔE is CIEDE2000 (kL=kC=kH=1).

Two ways to run it:
  * In the app's script editor — the grid rows are injected automatically as a
    module-level ``data`` variable (a list of dicts); no flags needed, and the
    HTML is written to the Downloads folder (OS temp folder as a fallback only).
  * Standalone:
        python analyze-color-data.py --input color_data.xlsx
        python analyze-color-data.py --input color_data.csv --output out.html
"""

import argparse
import io
import json
import math
import os
import sys
import tempfile
import time
import urllib.request
import webbrowser
from collections import defaultdict
from pathlib import Path

ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"

# Columns this page needs. Anything missing is treated as an empty column so a
# query that drops, say, Description still produces a usable page.
STR_COLUMNS = ("DATE", "NAME", "LD_item", "WOL", "Batch", "Sample_type",
               "Hex", "Product", "Raw_item", "Description")
NUM_COLUMNS = ("L", "a", "b")

LD = "LD"
RAW = "Raw"
LAMINATE = "Laminate"

# Payload sizes reported at the end (helps spot a query that returned the wrong
# table long before the page is opened).
ROUND_DP = 2

# Pantone TCX colour library for the Match Pantone tab.  The colour values
# are NOT stored in this script: they live in backend/templates/Pantone_TCX.xlsx,
# which is uploaded to the app's public Supabase bucket.  load_pantone() lazily
# downloads the workbook once, extracts the rows and caches them as JSON beside
# the app's other local files; later runs reuse that cache and never touch the
# network.  Row layout: [Pantone, Name, Chinese, Hex, L, a, b].
PANTONE_XLSX_URL = ("https://llbxyhphblhplfpgyjht.supabase.co/storage/v1/object/"
                    "public/odbc-app/pantone/Pantone_TCX.xlsx")
_pantone_cache = None


# ---------------------------------------------------------------------------
# input / output helpers
# ---------------------------------------------------------------------------
def find_default_input():
    folder = Path(__file__).resolve().parent
    for pattern in ("color_*.xlsx", "*.xlsx", "*.csv"):
        matches = sorted(folder.glob(pattern))
        if matches:
            return matches[-1]
    return None


def resolve_output_dir() -> Path:
    """User's Downloads folder first; OS temp folder as a fallback only."""
    fallback = Path(tempfile.gettempdir()) / "color_data"
    for cand in (Path.home() / "Downloads", fallback):
        try:
            cand.mkdir(parents=True, exist_ok=True)
            probe = cand / ".cd_write_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
            return cand
        except OSError:
            continue
    return fallback


def load_frame(path):
    import pandas as pd

    if path.suffix.lower() == ".csv":
        df = pd.read_csv(path)
    else:
        df = pd.read_excel(path)
    df.columns = [str(c).strip() for c in df.columns]
    return df


def _text(value) -> str:
    """Trimmed string; NaN / NaT artifacts collapse to an empty string.

    'Null' is a real Sample_type in this table, so it is kept as-is.
    """
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    text = str(value).strip()
    return "" if text.lower() in ("nan", "nat", "<na>") else text


def _num(value):
    """float, or None when the cell is blank / not numeric."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return None if math.isnan(number) else number
    text = _text(value).replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _r(value, digits: int = ROUND_DP):
    """Rounded number for JSON, or '' when there is nothing to show."""
    return "" if value is None else round(value, digits)


def _iso_date(value) -> str:
    """'2024-08-27 13:59:04' / ISO input -> '2024-08-27T13:59:04'."""
    text = _text(value)
    return text.replace(" ", "T", 1) if text else ""


def lab_to_hex(l, a, b) -> str:
    """Mirror of the grid's LABTOHEX so the page matches the Hex column.

    LAB -> XYZ -> linear sRGB -> gamma-encoded, D65 (95.047 / 100 / 108.883).
    """
    if l is None or a is None or b is None:
        return ""
    py = (l + 16) / 116

    def inverse_pivot(v):
        cube = v ** 3
        return cube if cube > 0.008856 else (v - 16 / 116) / 7.787

    x = 95.047 * inverse_pivot(a / 500 + py) / 100
    y = 100.0 * inverse_pivot(py) / 100
    z = 108.883 * inverse_pivot(py - b / 200) / 100

    def channel(v):
        lin = 1.055 * v ** (1 / 2.4) - 0.055 if v > 0.0031308 else 12.92 * v
        return min(255, max(0, round(255 * lin)))

    r = channel(3.2406 * x - 1.5372 * y - 0.4986 * z)
    g = channel(-0.9689 * x + 1.8758 * y + 0.0415 * z)
    bl = channel(0.0557 * x - 0.204 * y + 1.057 * z)
    return "#%02x%02x%02x" % (r, g, bl)


# ---------------------------------------------------------------------------
# payload
# ---------------------------------------------------------------------------
def build_payload(records) -> dict:
    """Turn the grid rows into the compact payload the page consumes.

    items:   [LD_item, n_ld, mean_L, mean_a, mean_b, hex,
              (matched-Raw count filled at runtime)]
    ld:      {LD_item: [[date, name, L, a, b, hex, Batch], ...]}  (every LD sample)
    raw:     {LD_item: [[date, name, L, a, b, hex, Batch], ...]}  (matched only)
    unitems: [Raw_item, n_raw, mean_L, mean_a, mean_b, hex]       (no matching LD_item)
    unraw:   {Raw_item: [[date, name, L, a, b, hex, Batch], ...]}
    rawbatch: {Raw_item: distinct non-empty Batch count}  (matched + unmatched)
    lam:     [[date, name, L, a, b, hex, WOL, Batch, Product, Description,
               Raw_item, matched LD_item], ...]
    """
    ld_acc = defaultdict(lambda: [0, 0.0, 0.0, 0.0])   # item -> n, sum L, a, b
    ld_samples = defaultdict(list)   # item -> every LD sample row (for NAME refs)
    raw_rows = []
    lam_rows = []
    counts = defaultdict(int)
    ld_rows = 0

    for record in records:
        sample_type = _text(record.get("Sample_type"))
        counts[sample_type or "(blank)"] += 1
        l, a, b = (_num(record.get("L")), _num(record.get("a")),
                   _num(record.get("b")))
        hex_value = _text(record.get("Hex"))
        date = _iso_date(record.get("DATE"))
        name = _text(record.get("NAME"))

        if sample_type == LD:
            ld_rows += 1
            item = _text(record.get("LD_item"))
            if item:
                hex_out = hex_value
                if not hex_out and None not in (l, a, b):
                    hex_out = lab_to_hex(l, a, b)
                ld_samples[item].append([
                    date, name, _r(l), _r(a), _r(b), hex_out,
                    _text(record.get("Batch")),
                ])
            if item and None not in (l, a, b):
                acc = ld_acc[item]
                acc[0] += 1
                acc[1] += l
                acc[2] += a
                acc[3] += b
            continue

        if sample_type == RAW:
            item = _text(record.get("Raw_item"))
            if not item:
                continue
            raw_rows.append((item, [
                date, name, _r(l), _r(a), _r(b), hex_value,
                _text(record.get("Batch")),
            ]))
            continue

        if sample_type == LAMINATE:
            lam_rows.append([
                date, name, _r(l), _r(a), _r(b), hex_value,
                _text(record.get("WOL")), _text(record.get("Batch")),
                _text(record.get("Product")), _text(record.get("Description")),
                _text(record.get("Raw_item")),
            ])

    # LD_item reference colours (mean of the item's LD replicates).
    items = []
    for item in sorted(ld_acc):
        n, sum_l, sum_a, sum_b = ld_acc[item]
        mean_l, mean_a, mean_b = (round(sum_l / n, ROUND_DP),
                                  round(sum_a / n, ROUND_DP),
                                  round(sum_b / n, ROUND_DP))
        # index 6 is a placeholder — the page fills it with the matched-Raw
        # count at runtime.
        items.append([item, n, mean_l, mean_a, mean_b,
                      lab_to_hex(mean_l, mean_a, mean_b), 0])

    # Raw rows join to LD_items on the item code. The join is case-insensitive
    # (codes are uppercase, but one stray lowercase letter must not silently
    # drop a whole item from the analysis); rows group under the LD_item's
    # own spelling. Anything that matches no LD_item feeds the "Unmatched
    # Raw" heat map instead of being thrown away.
    known_map = {}
    for it in items:
        known_map.setdefault(it[0].upper(), it[0])

    # Laminate rows carry the Raw_item they were measured on; resolve it to
    # the matching LD_item (canonical spelling, '' when nothing matches) so
    # the page's ΔE reference dropdown can list the LD samples (grouped by
    # LD_item) that are reachable through the laminate data.
    for row in lam_rows:
        row.append(known_map.get(row[10].upper(), ""))

    raw_by_item = defaultdict(list)
    un_by_item = defaultdict(list)
    unmatched_raw = 0
    for item, row in raw_rows:
        canon = known_map.get(item.upper())
        if canon is not None:
            raw_by_item[canon].append(row)
        else:
            unmatched_raw += 1
            un_by_item[item].append(row)
    for rows in raw_by_item.values():
        rows.sort(key=lambda r: r[0])
    for rows in un_by_item.values():
        rows.sort(key=lambda r: r[0])

    # Distinct non-empty Batch count per Raw_item, keyed by the ORIGINAL
    # Raw_item spelling (raw_rows keeps it; raw_by_item regroups matched rows
    # under the canonical LD_item, which would lose the raw code). Feeds the
    # Stats tab's "Raw batches by Raw_item" chart.
    rawbatch = defaultdict(set)
    for item, row in raw_rows:
        if row[6]:
            rawbatch[item].add(row[6])

    # Unmatched Raw_items get their own heat map, tinted with the mean colour
    # of the item's own Raw samples.
    unitems = []
    for item in sorted(un_by_item):
        rows_ = un_by_item[item]
        vals = [(r[2], r[3], r[4]) for r in rows_
                if r[2] != "" and r[3] != "" and r[4] != ""]
        if vals:
            n = len(vals)
            mean_l = round(sum(v[0] for v in vals) / n, ROUND_DP)
            mean_a = round(sum(v[1] for v in vals) / n, ROUND_DP)
            mean_b = round(sum(v[2] for v in vals) / n, ROUND_DP)
            unitems.append([item, len(rows_), mean_l, mean_a, mean_b,
                            lab_to_hex(mean_l, mean_a, mean_b)])
        else:
            unitems.append([item, len(rows_), None, None, None, ""])

    # Newest laminate first: the table opens on the most recent measurements.
    lam_rows.sort(key=lambda r: r[0], reverse=True)

    dates = ([r[0] for r in lam_rows]
             + [r[0] for rows in raw_by_item.values() for r in rows]
             + [r[0] for rows in un_by_item.values() for r in rows])
    dates = [d for d in dates if d]
    return {
        "meta": {
            "items": len(items),
            "raw": sum(len(v) for v in raw_by_item.values()),
            "unmatched_items": len(unitems),
            "unmatched_raw": unmatched_raw,
            "lam": len(lam_rows),
            "skipped": len(records) - ld_rows - len(raw_rows) - len(lam_rows),
            "total": len(records),
            "sample_types": dict(sorted(counts.items())),
            "date_min": min(dates)[:10] if dates else "",
            "date_max": max(dates)[:10] if dates else "",
        },
        "items": items,
        "ld": dict(sorted(ld_samples.items())),
        "raw": raw_by_item,
        "unitems": unitems,
        "unraw": dict(un_by_item),
        "rawbatch": {k: len(v) for k, v in sorted(rawbatch.items())},
        "lam": lam_rows,
    }


# ---------------------------------------------------------------------------
# page
# ---------------------------------------------------------------------------
HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Color Data — Lab Colour Explorer</title>
<style>
:root{--bg:#f4f6f8;--card:#fff;--ink:#1f2933;--brand:#1f3a5f;--line:#d7dee8;--muted:#6b7785}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);overflow-x:hidden;
     font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px}
header{position:sticky;top:0;z-index:20;background:var(--brand);color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)}
.hdr{max-width:1600px;margin:0 auto;padding:5px 12px 2px}
h1{margin:0;font-size:15px;font-weight:650}
.sub{margin-top:1px;font-size:11px;opacity:.85;line-height:1.3}
.tabs{display:flex;gap:6px;max-width:1600px;margin:0 auto;padding:3px 12px 8px;overflow-x:auto}
.tab{flex:0 0 auto;min-height:40px;padding:6px 14px;border-radius:18px;cursor:pointer;
     border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;font-size:13px;font-weight:600}
.tab.active{background:#fff;color:var(--brand);border-color:#fff}
main{max-width:1600px;margin:0 auto;padding:10px}
.view{display:none}
.view.active{display:block}
.hint{color:var(--muted);font-size:12px;margin:0 0 10px}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px}
input,select{font-size:14px;min-height:48px;padding:9px 10px;border-radius:8px;
             border:1px solid var(--line);background:#fff;color:inherit}
.controls input[type=search]{flex:1 1 200px;min-width:0}
.count{color:var(--muted);font-size:12px;margin-left:auto}
.sw-lg{display:inline-block;width:48px;height:28px;border-radius:6px;
       border:1px solid rgba(0,0,0,.25);vertical-align:middle}
.itemlink{color:var(--brand);font-weight:600;text-decoration:underline;cursor:pointer;
          display:inline-block;padding:16px 8px;margin:-16px -8px}
.inl{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
#cmpBaseline,#cmpCutoff{width:92px}
#cmpTable td.de{font-family:ui-monospace,Consolas,monospace}
#cmpTable td.lo{background:#c9ead1}
#cmpTable tbody tr{cursor:pointer}
#cmpTable tbody tr:hover{background:#eef2f7}
/* Pair popup: centred overlay, square colour cards, details table. */
#pairModal{align-items:center;justify-content:center;padding:16px}
#pairModal .modal-box{min-height:0;width:min(560px,100%);max-height:100%;
                      overflow:auto;border-radius:12px;
                      scrollbar-width:none}
#pairModal .modal-box::-webkit-scrollbar{display:none}
.out{color:#d64541;font-weight:600}
.pairgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}
.paircard{background:var(--card);border:1px solid var(--line);border-radius:10px;
          padding:12px;text-align:center}
.paircard .big{display:block;width:100%;aspect-ratio:1/1;border-radius:8px;
          border:1px solid rgba(0,0,0,.25)}
.paircard .pname{font-weight:600;margin:8px 0 0;word-break:break-all}
.pairdelta{font-size:14px;font-weight:600;margin:8px 0}
.pairdelta.lo{color:#1d7a34}
.pairtable{width:100%;border-collapse:collapse;font-size:13px;margin:0 0 8px}
.pairtable th,.pairtable td{border:1px solid var(--line);padding:7px 10px;
                            text-align:left;vertical-align:top}
.pairtable thead th{background:#eef2f7}
.pairtable td.k{color:var(--muted);white-space:nowrap}
.pairtable td.mono{font-family:ui-monospace,Consolas,monospace}
.table-wrap{overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{padding:6px 8px;border-bottom:1px solid #e6ebf1;text-align:left;white-space:nowrap;vertical-align:middle}
thead th{position:sticky;top:0;z-index:1;background:#eef2f7}
th.sortable{cursor:pointer;user-select:none}
th.sortable:hover{background:#e2e9f2}
.arrow{color:var(--brand);font-size:10px}
.sw{display:inline-block;width:22px;height:22px;border-radius:5px;
    border:1px solid rgba(0,0,0,.25);vertical-align:middle}
.hex{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#334}
.wrapcell{white-space:normal;max-width:280px}
.pager{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 2px}
.pager button{min-width:48px;min-height:48px;border:1px solid var(--line);border-radius:8px;
              background:#fff;cursor:pointer;font-size:13px}
.pager button:disabled{opacity:.45;cursor:default}
.pager .pinfo{color:var(--muted);font-size:12px}
.stats{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin-bottom:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.stat .k{font-size:11px;color:var(--muted)}
.stat .v{font-size:17px;font-weight:700}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px;margin-bottom:10px}
.card-title{font-size:13px;font-weight:600;color:var(--brand);margin:2px 4px 6px}
#itemChart{width:100%;height:300px}
/* Square container: symmetric Δa/Δb axes + square box keep the tolerance
   circle round on every screen width. */
#abChart{width:min(100%,420px);aspect-ratio:1/1;margin:0 auto}
#abToggles{display:flex;gap:8px;margin:0 4px 8px}
#abToggles button{flex:1;min-height:48px;padding:8px 10px;border:1px solid #d0d5dd;
  border-radius:7px;background:#fff;font-weight:600;font-size:13px;color:#344054;cursor:pointer}
#abToggles button.active{background:#344054;color:#fff;border-color:#344054}
.chart-grid{display:grid;gap:10px;grid-template-columns:1fr}
.chart{width:100%;height:300px}
.chart-scroll{max-height:480px;overflow:auto}
.card-title .tnote{font-weight:400;color:var(--muted);font-size:11px;margin-left:6px}
@media(min-width:1024px){
  .chart-grid{grid-template-columns:1fr 1fr}
  .chart-grid .wide{grid-column:1/-1}
}
.modal{display:none;position:fixed;inset:0;z-index:50;overflow:auto;background:rgba(10,18,28,.55)}
.modal-box{min-height:100%;background:var(--bg)}
.modal-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;
            justify-content:space-between;padding:10px 12px;background:var(--brand);color:#fff}
.modal-head h2{margin:0;font-size:15px;word-break:break-all}
.close{min-width:48px;min-height:48px;border:none;background:none;color:#fff;font-size:26px;
       line-height:1;cursor:pointer}
.modal-body{padding:10px}
.chiprow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.cchip{display:inline-flex;align-items:center;gap:6px;background:var(--card);
       border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:12px}
.empty{color:var(--muted);font-size:13px;padding:12px}
/* ---- Match Pantone ---- */
.pt-layout{display:grid;gap:12px;grid-template-columns:1fr;align-items:start}
.pt-layout>*{min-width:0}
.pt-rail,.pt-panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}
.pt-label{display:block;font-size:12px;font-weight:600;color:var(--brand);margin:12px 0 4px}
.pt-rail .pt-label:first-child,.pt-panel .pt-step{margin-top:0}
.pt-step{font-size:14px;font-weight:700;color:var(--brand);text-decoration:underline;margin:0 0 8px}
.pt-radios{display:flex;flex-wrap:wrap;gap:4px}
.pt-radios label{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);
                 border-radius:8px;padding:8px 10px;min-height:48px;cursor:pointer;font-size:13px}
.pt-radios label:has(input:checked){border-color:var(--brand);background:#eef2f7}
.pt-rail input[type=search]{width:100%}
.pt-panel select{width:100%}
.pt-grid{display:grid;gap:6px;grid-template-columns:repeat(auto-fill,minmax(48px,1fr))}
.pt-sw{aspect-ratio:1/1;min-width:48px;border:none;border-radius:6px;
       cursor:pointer;padding:0;position:relative}
.pt-sw.sel::after{content:'\2713';position:absolute;right:3px;bottom:1px;font-size:13px;
                  color:#fff;text-shadow:0 0 3px rgba(0,0,0,.85)}
.pt-out{border:1px solid var(--line);border-radius:8px;padding:10px;min-height:120px;background:#fff}
.pt-out .table-wrap{margin:0}
.pt-hint2{color:var(--muted);font-size:13px;display:flex;align-items:center;gap:8px}
.pt-x{font-size:18px}
.pt-note{font-size:12px;color:var(--muted);margin:8px 0 0}
.pt-note a{min-height:48px;display:inline-flex;align-items:center}
.pt-bottom{display:grid;gap:12px;grid-template-columns:1fr;margin-top:12px}
.pt-bottom>*{min-width:0}
.pt-ctrl{display:grid;gap:12px;grid-template-columns:1fr}
.pt-ctrl>*{min-width:0}
.pt-panel input[type=number]{width:100%;max-width:160px}
@media(min-width:1024px){
  .pt-layout{grid-template-columns:215px minmax(0,1fr)}
  .pt-ctrl{grid-template-columns:minmax(0,1fr) 230px}
}
@media(min-width:768px){
  h1{font-size:18px}
  .sub{font-size:12px}
  main{padding:14px}
  #itemChart{height:360px}
  #abChart{width:min(100%,480px)}
  .chart{height:340px}
}
</style>
<script>@@ECHARTS@@</script>
</head>
<body>
<header>
  <div class="hdr">
    <h1>Color Data — Lab Colour Explorer</h1>
    <div class="sub" id="meta"></div>
  </div>
  <div class="tabs" role="tablist">
    <button class="tab active" data-view="stats" role="tab">Stats</button>
    <button class="tab" data-view="map" role="tab">LD heat map</button>
    <button class="tab" data-view="un" role="tab">Unmatched Raw</button>
    <button class="tab" data-view="lam" role="tab">Laminate</button>
    <button class="tab" data-view="cmp" role="tab">&#916;E Compare</button>
    <button class="tab" data-view="pt" role="tab">Match Pantone</button>
  </div>
</header>

<main>
  <section id="v-stats" class="view active">
    <p class="hint">Overview of the loaded Color_Data extract. Bars show the
      top items only; swipe or scroll inside a chart card to see the rest.</p>
    <div class="chart-grid">
      <div class="card">
        <div class="card-title">Samples by Sample_type<span class="tnote" id="tNoteType"></span></div>
        <div id="chType" class="chart"></div>
      </div>
      <div class="card">
        <div class="card-title">LD_item count by textile<span class="tnote" id="tNoteLd"></span></div>
        <div id="chLd" class="chart chart-scroll"></div>
      </div>
      <div class="card">
        <div class="card-title">Raw batches by Raw_item<span class="tnote" id="tNoteBatch"></span></div>
        <div id="chBatch" class="chart chart-scroll"></div>
      </div>
      <div class="card wide">
        <div class="card-title">Measurements per month<span class="tnote" id="tNoteTime"></span></div>
        <div id="chTime" class="chart"></div>
      </div>
      <div class="card wide">
        <div class="card-title">&#916;E distribution — matched Raw vs item mean<span class="tnote" id="tNoteDe"></span></div>
        <div id="chDe" class="chart"></div>
      </div>
    </div>
  </section>

  <section id="v-map" class="view">
    <p class="hint">One row per LD_item, coloured by the mean colour of its LD
      samples. Select an LD_item for the Raw samples measured against that item
      and their &#916;E trend against the item's mean colour.</p>
    <div class="controls">
      <input id="mSearch" type="search" placeholder="Search LD_item or #hex…">
      <span class="count" id="mCount"></span>
    </div>
    <div class="table-wrap">
      <table id="mTable">
        <thead><tr>
          <th>Colour</th>
          <th class="sortable" data-c="0">LD_item</th>
          <th class="sortable" data-c="1">LD samples</th>
          <th class="sortable" data-c="6">Matched Raw</th>
          <th class="sortable" data-c="2">L*</th>
          <th class="sortable" data-c="3">a*</th>
          <th class="sortable" data-c="4">b*</th>
          <th class="sortable" data-c="5">Hex</th>
        </tr></thead>
        <tbody id="mBody"></tbody>
      </table>
    </div>
    <div class="pager">
      <button id="mPrev">&#8592; Prev</button>
      <button id="mNext">Next &#8594;</button>
      <span class="pinfo" id="mInfo"></span>
    </div>
  </section>

  <section id="v-un" class="view">
    <p class="hint">Raw_items whose Raw_item matches no LD_item, coloured by the
      mean colour of their own Raw samples. Select a Raw_item to list those
      samples.</p>
    <div class="controls">
      <input id="uSearch" type="search" placeholder="Search Raw_item or #hex…">
      <span class="count" id="uCount"></span>
    </div>
    <div class="table-wrap">
      <table id="uTable">
        <thead><tr>
          <th>Colour</th>
          <th class="sortable" data-c="0">Raw_item</th>
          <th class="sortable" data-c="1">Raw samples</th>
          <th class="sortable" data-c="2">L*</th>
          <th class="sortable" data-c="3">a*</th>
          <th class="sortable" data-c="4">b*</th>
          <th class="sortable" data-c="5">Hex</th>
        </tr></thead>
        <tbody id="uBody"></tbody>
      </table>
    </div>
    <div class="pager">
      <button id="uPrev">&#8592; Prev</button>
      <button id="uNext">Next &#8594;</button>
      <span class="pinfo" id="uInfo"></span>
    </div>
  </section>

  <section id="v-lam" class="view">
    <p class="hint">Every Sample_type='Laminate' record, with the swatch from its
      Hex column. Pick a &#916;E reference to score every row against that
      LD_item's mean colour &mdash; the dropdown lists the LD_items reachable
      through the rows' Raw_item.</p>
    <div class="controls">
      <input id="lSearch" type="search" placeholder="Search name, WOL, batch, product, description or #hex…">
      <label class="inl">&#916;E reference
        <select id="lamSel" aria-label="Delta E reference">
          <option value="" disabled selected>Select LD_item</option>
        </select></label>
      <span class="count" id="lCount"></span>
    </div>
    <div class="table-wrap">
      <table id="lTable">
        <thead><tr>
          <th class="sortable" data-c="0">Date</th>
          <th class="sortable" data-c="1">Name</th>
          <th class="sortable" data-c="5">Colour</th>
          <th class="sortable" data-c="6">WOL</th>
          <th class="sortable" data-c="7">Batch</th>
          <th class="sortable" data-c="10">Raw item</th>
          <th class="sortable" data-c="8">Product</th>
          <th class="sortable" data-c="9">Description</th>
          <th class="sortable" data-c="2">L*</th>
          <th class="sortable" data-c="3">a*</th>
          <th class="sortable" data-c="4">b*</th>
          <th class="sortable" data-c="12" id="lamDETh" style="display:none">&#916;E</th>
        </tr></thead>
        <tbody id="lBody"></tbody>
      </table>
    </div>
    <div class="pager">
      <button id="lPrev">&#8592; Prev</button>
      <button id="lNext">Next &#8594;</button>
      <span class="pinfo" id="lInfo"></span>
    </div>
  </section>

  <section id="v-cmp" class="view">
    <p class="hint">Like-colour pairs within a textile (the first 4 characters
      of the LD_item). Each pair is two individual LD samples, labelled by
      NAME &mdash; one LD_item can carry several NAMEs. Pairs whose straight
      Lab distance is within the like-colour cutoff are scored with CIEDE2000
      &mdash; distant colours are never compared, which keeps big textiles
      fast. Set a baseline: pairs below it are highlighted green. Click a row
      to compare the two samples' colours side by side.</p>
    <div class="controls">
      <select id="cmpTextile" aria-label="Textile"></select>
      <label class="inl">Like-colour cutoff
        <input id="cmpCutoff" type="number" step="1" min="0" value="10"></label>
      <label class="inl">Baseline &#916;E
        <input id="cmpBaseline" type="number" step="0.1" min="0" value="1.0"></label>
      <span class="count" id="cmpCount"></span>
    </div>
    <div class="table-wrap">
      <table id="cmpTable">
        <thead><tr>
          <th>Colour A</th>
          <th class="sortable" data-c="0">NAME A</th>
          <th>Colour B</th>
          <th class="sortable" data-c="1">NAME B</th>
          <th class="sortable" data-c="2">&#916;E</th>
        </tr></thead>
        <tbody id="cmpBody"></tbody>
      </table>
    </div>
    <div class="pager">
      <button id="cmpPrev">&#8592; Prev</button>
      <button id="cmpNext">Next &#8594;</button>
      <span class="pinfo" id="cmpInfo"></span>
    </div>
  </section>

  <section id="v-pt" class="view">
    <p class="hint">Match a Pantone TCX colour to your measured textiles. Pick a
      colour in Step&nbsp;1 (filter by lightness group, search by ID/name, or
      page through 100 colours at a time), narrow Step&nbsp;2 to a face textile
      (Gore item is the first 4 characters of the LD_item), and set a
      &Delta;E00 threshold limit in Step&nbsp;3 (default 1.0). The output
      reports the nearest item by CIEDE2000: the nearest LD_item when the
      chosen textile has one, otherwise the nearest unmatched Raw_item &mdash;
      or no match when nothing falls within the threshold.</p>
    <div class="pt-layout">
      <div class="pt-rail">
        <span class="pt-label">Colour lightness</span>
        <div class="pt-radios" id="ptLight">
          <label><input type="radio" name="ptL" value="" checked>All</label>
          <label><input type="radio" name="ptL" value="11">11</label>
          <label><input type="radio" name="ptL" value="12">12</label>
          <label><input type="radio" name="ptL" value="13">13</label>
          <label><input type="radio" name="ptL" value="14">14</label>
          <label><input type="radio" name="ptL" value="15">15</label>
          <label><input type="radio" name="ptL" value="16">16</label>
          <label><input type="radio" name="ptL" value="17">17</label>
          <label><input type="radio" name="ptL" value="18">18</label>
          <label><input type="radio" name="ptL" value="19">19</label>
        </div>
        <label class="pt-label" for="ptSearch">Pantone ID</label>
        <input id="ptSearch" type="search" placeholder="e.g. 13-1106 or butter">
      </div>
      <div class="pt-panel">
        <p class="pt-step">Step 1: specify a Pantone color</p>
        <div class="pt-note" id="ptSelInfo">No colour selected</div>
        <div class="pt-grid" id="ptGrid"></div>
        <div class="pager">
          <button type="button" id="ptPrev">&#8592; Prev</button>
          <button type="button" id="ptNext">Next &#8594;</button>
          <span class="pinfo" id="ptPageInfo"></span>
        </div>
      </div>
    </div>
    <div class="pt-bottom">
      <div class="pt-ctrl">
        <div class="pt-panel">
          <p class="pt-step">Step 2: select an item</p>
          <label class="pt-label" for="ptGore">Gore item (textile)</label>
          <select id="ptGore"></select>
        </div>
        <div class="pt-panel">
          <p class="pt-step">Step 3: threshold limit</p>
          <label class="pt-label" for="ptThr">&Delta;E00 threshold</label>
          <input id="ptThr" type="number" min="0" step="0.1" value="1.0" inputmode="decimal">
          <p class="pt-note">Nearest item wins when its &Delta;E00 is within this limit.</p>
        </div>
      </div>
      <div class="pt-panel">
        <p class="pt-step">Output</p>
        <div class="pt-out" id="ptOut"></div>
      </div>
    </div>
  </section>
</main>

<div class="modal" id="modal">
  <div class="modal-box">
    <div class="modal-head">
      <h2 id="modalTitle"></h2>
      <button class="close" id="modalClose" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <div class="chiprow" id="itemChips"></div>
      <div class="stats" id="itemStats"></div>
      <div class="card" id="abCard" style="display:none">
        <div class="card-title" id="abCardTitle">&#916;a*/&#916;b* vs reference</div>
        <div id="abToggles">
          <button id="abQc" type="button">QC View &#177;1.5</button>
          <button id="abFull" type="button">Full Range</button>
        </div>
        <div id="abChart"></div>
      </div>
      <div class="card" id="deCard">
        <div class="card-title" id="deCardTitle">&#916;E vs LD mean over time</div>
        <div id="itemChart"></div>
      </div>
      <div class="controls">
        <label class="inl" id="refWrap" style="display:none">&#916;E reference
          <select id="refSel" aria-label="Delta E reference"></select></label>
        <input type="search" id="iSearch" placeholder="Search Raw sample or batch">
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr id="itemHead"></tr></thead>
          <tbody id="itemBody"></tbody>
        </table>
      </div>
      <div class="pager">
        <button id="iPrev">&#8592; Prev</button>
        <button id="iNext">Next &#8594;</button>
        <span class="pinfo" id="iInfo"></span>
      </div>
    </div>
  </div>
</div>

<div class="modal" id="pairModal">
  <div class="modal-box">
    <div class="modal-head">
      <h2 id="pairTitle"></h2>
      <button class="close" id="pairClose" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <div class="pairgrid">
        <div class="paircard" id="pairCardA"></div>
        <div class="paircard" id="pairCardB"></div>
      </div>
      <p class="pairdelta" id="pairDelta"></p>
      <div id="pairDetail"></div>
    </div>
  </div>
</div>

<script>
var DATA = @@DATA@@;
var ITEMS = DATA.items;
var RAW = DATA.raw;
var UNITEMS = DATA.unitems;
var UNRAW = DATA.unraw;
var LAM = DATA.lam;
var LD = DATA.ld || {};
var META = DATA.meta;
var RAWBATCH = DATA.rawbatch || {};
var PANTONE = @@PANTONE@@;   /* TCX library rows: [id, name, zh, hex, L, a, b] */

var PAGE = 100;

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function hexOf(v){ var h=String(v||'').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(h) ? h : ''; }
function swatch(v){ var h=hexOf(v);
  return '<span class="sw" style="background:'+(h||'repeating-linear-gradient(45deg,#ddd,#ddd 4px,#fff 4px,#fff 8px)')+'"></span>'; }
function swatchLg(v){ var h=hexOf(v);
  return '<span class="sw-lg" style="background:'+(h||'repeating-linear-gradient(45deg,#ddd,#ddd 4px,#fff 4px,#fff 8px)')+'"></span>'; }
function num(v,d){ if(v===''||v==null||isNaN(v)) return '\u2013'; return Number(v).toFixed(d==null?2:d); }
function day(v){ return String(v||'').slice(0,10) || '\u2013'; }
function clock(v){ return String(v||'').slice(11,19); }

/* CIEDE2000 (kL = kC = kH = 1) — the standard formula. */
function deltaE00(l1,a1,b1,l2,a2,b2){
  var RAD=Math.PI/180, p25=Math.pow(25,7);
  var C1=Math.sqrt(a1*a1+b1*b1), C2=Math.sqrt(a2*a2+b2*b2), Cb=(C1+C2)/2;
  var G=0.5*(1-Math.sqrt(Math.pow(Cb,7)/(Math.pow(Cb,7)+p25)));
  var a1p=(1+G)*a1, a2p=(1+G)*a2;
  var C1p=Math.sqrt(a1p*a1p+b1*b1), C2p=Math.sqrt(a2p*a2p+b2*b2);
  var h1=Math.atan2(b1,a1p)/RAD, h2=Math.atan2(b2,a2p)/RAD;
  if(h1<0) h1+=360; if(h2<0) h2+=360;
  var dLp=l2-l1, dCp=C2p-C1p, dhp=0;
  if(C1p*C2p!==0){ dhp=h2-h1; if(dhp>180) dhp-=360; else if(dhp<-180) dhp+=360; }
  var dHp=2*Math.sqrt(C1p*C2p)*Math.sin(dhp/2*RAD);
  var Lb=(l1+l2)/2, Cb2=(C1p+C2p)/2, hb;
  if(C1p*C2p===0){ hb=h1+h2; }
  else if(Math.abs(h1-h2)<=180){ hb=(h1+h2)/2; }
  else if(h1+h2<360){ hb=(h1+h2+360)/2; }
  else { hb=(h1+h2-360)/2; }
  var T=1-0.17*Math.cos((hb-30)*RAD)+0.24*Math.cos(2*hb*RAD)
        +0.32*Math.cos((3*hb+6)*RAD)-0.20*Math.cos((4*hb-63)*RAD);
  var dTh=30*Math.exp(-Math.pow((hb-275)/25,2));
  var Rc=2*Math.sqrt(Math.pow(Cb2,7)/(Math.pow(Cb2,7)+p25));
  var Sl=1+(0.015*Math.pow(Lb-50,2))/Math.sqrt(20+Math.pow(Lb-50,2));
  var Sc=1+0.045*Cb2, Sh=1+0.015*Cb2*T, Rt=-Math.sin(2*dTh*RAD)*Rc;
  return Math.sqrt(Math.pow(dLp/Sl,2)+Math.pow(dCp/Sc,2)+Math.pow(dHp/Sh,2)
                   +Rt*(dCp/Sc)*(dHp/Sh));
}

/* ---- item indexes + ΔE for every matched Raw row (one pass) ---- */
var ITEM_BY={}, UN_BY={};
ITEMS.forEach(function(it){
  ITEM_BY[it[0]]={item:it[0],n:it[1],L:it[2],a:it[3],b:it[4],hex:it[5],rows:[]};
});
UNITEMS.forEach(function(it){
  UN_BY[it[0]]={item:it[0],n:it[1],L:it[2],a:it[3],b:it[4],hex:it[5],rows:[]};
});
Object.keys(RAW).forEach(function(item){
  var ref=ITEM_BY[item]; if(!ref) return;
  RAW[item].forEach(function(r){
    ref.rows.push(r);            // listed by the item's detail modal
    if(r[2]===''||r[3]===''||r[4]===''){ r[7]=''; return; }
    r[7]=Math.round(deltaE00(ref.L,ref.a,ref.b,r[2],r[3],r[4])*1000)/1000;
  });
});
Object.keys(UNRAW).forEach(function(item){
  var ref=UN_BY[item]; if(!ref) return;
  UNRAW[item].forEach(function(r){ ref.rows.push(r); });
});
/* Matched-Raw count shown in the LD table (index 6 on every item row). */
ITEMS.forEach(function(it){
  it[6]=ITEM_BY[it[0]] ? ITEM_BY[it[0]].rows.length : 0;
});

/* ---- per-sample ΔE references ----
   One entry per Lab-valid LD sample, so the reference dropdowns can offer
   individual samples (by NAME) instead of only the item mean. */
var LDREFS=[], LD_BY={};
Object.keys(LD).forEach(function(item){
  (LD[item]||[]).forEach(function(s){
    if(s[2]===''||s[3]===''||s[4]==='') return;   // needs L,a,b
    var o={item:item,name:s[1]||item,L:s[2],a:s[3],b:s[4],hex:s[5]};
    o.key=String(LDREFS.length);
    LDREFS.push(o);
    (LD_BY[item]=LD_BY[item]||[]).push(o);
  });
});
Object.keys(LD_BY).forEach(function(item){
  LD_BY[item].sort(function(x,y){ return x.name<y.name?-1:x.name>y.name?1:0; });
});

function pct(sorted,p){
  if(!sorted.length) return null;
  var i=(sorted.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i);
  return lo===hi ? sorted[lo] : sorted[lo]+(sorted[hi]-sorted[lo])*(i-lo);
}

/* ---- tabs ---- */
var current='stats';
function showView(name){
  current=name;
  Array.prototype.forEach.call(document.querySelectorAll('.view'),function(v){
    v.classList.toggle('active', v.id==='v-'+name);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){
    b.classList.toggle('active', b.getAttribute('data-view')===name);
  });
}
Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){
  b.addEventListener('click',function(){ showView(b.getAttribute('data-view')); });
});

/* ---- tabs 1 & 2: LD item and unmatched Raw item tables ----
   Same searchable / sortable / paginated table pattern as the Laminate tab.
   Item row layout (LD): 0 LD_item, 1 LD samples, 6 Matched Raw,
                         2 L*, 3 a*, 4 b*, 5 Hex.
   Item row layout (Un): 0 Raw_item, 1 Raw samples, 2 L*, 3 a*, 4 b*, 5 Hex. */
function ldRowHtml(it){
  var hex=hexOf(it[5]);
  return '<tr>'
    +'<td>'+swatchLg(hex)+'</td>'
    +'<td><a href="#" class="itemlink" data-mode="ld" data-item="'+esc(it[0])+'">'+esc(it[0])+'</a></td>'
    +'<td>'+it[1].toLocaleString()+'</td>'
    +'<td>'+it[6].toLocaleString()+'</td>'
    +'<td>'+num(it[2])+'</td><td>'+num(it[3])+'</td><td>'+num(it[4])+'</td>'
    +'<td class="hex">'+esc(hex||'\u2013')+'</td>'
    +'</tr>';
}
function unRowHtml(it){
  var hex=hexOf(it[5]);
  return '<tr>'
    +'<td>'+swatchLg(hex)+'</td>'
    +'<td><a href="#" class="itemlink" data-mode="un" data-item="'+esc(it[0])+'">'+esc(it[0])+'</a></td>'
    +'<td>'+it[1].toLocaleString()+'</td>'
    +'<td>'+num(it[2])+'</td><td>'+num(it[3])+'</td><td>'+num(it[4])+'</td>'
    +'<td class="hex">'+esc(hex||'\u2013')+'</td>'
    +'</tr>';
}
function setupItemTable(o){
  var rows=o.items.slice(), page=0, col=-1, dir=1;
  function applyFilter(){
    var q=(document.getElementById(o.search).value||'').trim().toLowerCase();
    var hexQuery=/^#?[0-9a-f]{6}$/.test(q) ? (q.charAt(0)==='#'?q:'#'+q) : '';
    rows=o.items.filter(function(it){
      if(!q) return true;
      if(hexQuery && hexOf(it[5])===hexQuery) return true;
      return it[0].toLowerCase().indexOf(q)!==-1;
    });
    if(col>=0){
      var c=col,d=dir;
      rows=rows.slice().sort(function(x,y){
        var va=x[c], vb=y[c];
        if(va==null||va==='') return 1;
        if(vb==null||vb==='') return -1;
        if(typeof va==='number'&&typeof vb==='number') return d*(va-vb);
        return d*String(va).localeCompare(String(vb));
      });
    }
    page=0;
  }
  function render(){
    var from=page*PAGE, to=Math.min(from+PAGE, rows.length);
    var html=[];
    for(var i=from;i<to;i++){ html.push(o.rowHtml(rows[i])); }
    document.getElementById(o.body).innerHTML=html.join('');
    document.getElementById(o.count).textContent=rows.length.toLocaleString()
      +' of '+o.items.length.toLocaleString()+' '+o.plural;
    document.getElementById(o.info).textContent=rows.length
      ? 'Rows '+(from+1)+'\u2013'+to+' of '+rows.length.toLocaleString()
      : 'No matching items';
    document.getElementById(o.prev).disabled=page<=0;
    document.getElementById(o.next).disabled=to>=rows.length;
  }
  function refresh(){ applyFilter(); render(); }
  document.getElementById(o.search).addEventListener('input',refresh);
  document.getElementById(o.prev).addEventListener('click',function(){
    if(page>0){ page--; render(); }});
  document.getElementById(o.next).addEventListener('click',function(){
    if((page+1)*PAGE<rows.length){ page++; render(); }});
  Array.prototype.forEach.call(
    document.querySelectorAll('#'+o.table+' th.sortable'),function(th){
    th.addEventListener('click',function(){
      var c=Number(th.getAttribute('data-c'));
      if(col===c){ dir=-dir; } else { col=c; dir=1; }
      Array.prototype.forEach.call(
        document.querySelectorAll('#'+o.table+' th.sortable .arrow'),
        function(a){ a.remove(); });
      var sp=document.createElement('span'); sp.className='arrow';
      sp.textContent=(dir===1?'\u25B2':'\u25BC'); th.appendChild(sp);
      refresh();
    });
  });
  /* LD_item / Raw_item link opens the detail view (delegated so pagination
     and re-renders need no rebinding). */
  document.getElementById(o.body).addEventListener('click',function(e){
    var a=e.target.closest('a.itemlink');
    if(!a) return;
    e.preventDefault();
    openDetail(a.getAttribute('data-mode'), a.getAttribute('data-item'));
  });
  refresh();
}
setupItemTable({mode:'ld',items:ITEMS,plural:'LD items',table:'mTable',body:'mBody',
  search:'mSearch',count:'mCount',prev:'mPrev',next:'mNext',info:'mInfo',
  rowHtml:ldRowHtml});
setupItemTable({mode:'un',items:UNITEMS,plural:'unmatched Raw items',table:'uTable',body:'uBody',
  search:'uSearch',count:'uCount',prev:'uPrev',next:'uNext',info:'uInfo',
  rowHtml:unRowHtml});

/* ---- tab 3: laminate table ----
   Row layout: 0 date, 1 name, 2 L*, 3 a*, 4 b*, 5 hex, 6 WOL, 7 batch,
   8 product, 9 description, 10 Raw_item, 11 matched LD_item,
   12 ΔE vs the selected reference (filled when one is picked). */
var lamRows=LAM.slice(), lamPage=0, lamCol=-1, lamDir=1, lamRef='';
function lamCell(r,c){
  switch(Number(c)){
    case 0: return day(r[0])+(clock(r[0])?' '+clock(r[0]):'');
    case 1: return r[1];
    case 2: return num(r[2],2);
    case 3: return num(r[3],2);
    case 4: return num(r[4],2);
    case 5: return r[5];
    case 6: return r[6];
    case 7: return r[7];
    case 8: return r[8];
    case 10: return r[10];
    default: return r[9];
  }
}
function lamSearch(){
  var q=(document.getElementById('lSearch').value||'').trim().toLowerCase();
  if(!q){ lamRows=LAM.slice(); }
  else {
    lamRows=LAM.filter(function(r){
      for(var i=0;i<11;i++){ if(String(r[i]).toLowerCase().indexOf(q)!==-1) return true; }
      return false;
    });
  }
  if(lamCol>=0){
    var c=lamCol,d=lamDir;
    lamRows.sort(function(x,y){
      var va=x[c], vb=y[c];
      if(va===''||va==null) return 1;
      if(vb===''||vb==null) return -1;
      if(typeof va==='number'&&typeof vb==='number') return d*(va-vb);
      return d*String(va).localeCompare(String(vb));
    });
  }
  lamPage=0; renderLam();
}
function renderLam(){
  var from=lamPage*PAGE, to=Math.min(from+PAGE, lamRows.length);
  var html=[];
  for(var i=from;i<to;i++){
    var r=lamRows[i];
    html.push('<tr>'
      +'<td>'+esc(lamCell(r,0))+'</td>'
      +'<td>'+esc(lamCell(r,1))+'</td>'
      +'<td>'+swatchLg(r[5])+'</td>'
      +'<td>'+esc(lamCell(r,6)||'\u2013')+'</td>'
      +'<td>'+esc(lamCell(r,7)||'\u2013')+'</td>'
      +'<td>'+esc(lamCell(r,10)||'\u2013')+'</td>'
      +'<td>'+esc(lamCell(r,8)||'\u2013')+'</td>'
      +'<td class="wrapcell">'+esc(lamCell(r,9)||'\u2013')+'</td>'
      +'<td>'+esc(lamCell(r,2))+'</td><td>'+esc(lamCell(r,3))+'</td><td>'+esc(lamCell(r,4))+'</td>'
      +(lamRef?'<td>'+(r[12]===''||r[12]==null?'\u2013':num(r[12],2))+'</td>':'')
      +'</tr>');
  }
  document.getElementById('lBody').innerHTML=html.join('');
  document.getElementById('lCount').textContent=lamRows.length.toLocaleString()
    +' of '+LAM.length.toLocaleString()+' laminate rows';
  document.getElementById('lInfo').textContent=lamRows.length
    ? 'Rows '+(from+1)+'\u2013'+to+' of '+lamRows.length.toLocaleString()
    : 'No matching rows';
  document.getElementById('lPrev').disabled=lamPage<=0;
  document.getElementById('lNext').disabled=to>=lamRows.length;
}
document.getElementById('lSearch').addEventListener('input',lamSearch);
document.getElementById('lPrev').addEventListener('click',function(){
  if(lamPage>0){ lamPage--; renderLam(); }});
document.getElementById('lNext').addEventListener('click',function(){
  if((lamPage+1)*PAGE<lamRows.length){ lamPage++; renderLam(); }});
Array.prototype.forEach.call(document.querySelectorAll('#lTable th.sortable'),function(th){
  th.addEventListener('click',function(){
    var c=Number(th.getAttribute('data-c'));
    if(lamCol===c){ lamDir=-lamDir; } else { lamCol=c; lamDir=1; }
    Array.prototype.forEach.call(document.querySelectorAll('#lTable th.sortable .arrow'),
      function(a){ a.remove(); });
    var sp=document.createElement('span'); sp.className='arrow';
    sp.textContent=(lamDir===1?'\u25B2':'\u25BC'); th.appendChild(sp);
    lamSearch();
  });
});

/* ΔE reference dropdown: grouped by the LD_items actually reachable through
   the laminate rows' Raw_item (index 11, resolved in the payload); every
   option is an individual LD sample labelled by its NAME. Nothing is selected
   by default, so the ΔE column stays hidden until a pick. */
(function(){
  var seen={}, opts=[];
  LAM.forEach(function(r){
    if(r[11] && !seen[r[11]]){ seen[r[11]]=1; opts.push(r[11]); }
  });
  opts.sort();
  var sel=document.getElementById('lamSel');
  opts.forEach(function(n){
    var grp=(LD_BY[n]||[]); if(!grp.length) return;
    var og=document.createElement('optgroup'); og.label=n;
    grp.forEach(function(o){
      var el=document.createElement('option');
      el.value=o.key; el.textContent=o.name;
      og.appendChild(el);
    });
    sel.appendChild(og);
  });
  sel.addEventListener('change',function(){
    lamRef=this.value;
    var ref=LDREFS[lamRef];
    document.getElementById('lamDETh').style.display=lamRef?'':'none';
    if(ref){
      LAM.forEach(function(r){
        r[12]=(r[2]===''||r[3]===''||r[4]==='')
          ? '' : Math.round(deltaE00(r[2],r[3],r[4],ref.L,ref.a,ref.b)*100)/100;
      });
    }
    lamPage=0;
    lamSearch();
  });
})();

/* ---- tab 4: like-colour pairs within a textile ----
   A textile = the first 4 characters of the LD_item. Pairs are formed between
   individual LD samples (by NAME) — one LD_item can carry several NAMEs — and
   pre-filtered with a cheap straight Lab distance: only pairs within the
   like-colour cutoff get the full CIEDE2000 score, so a 1,000-sample textile
   stays fast. Pairs below the baseline are highlighted; clicking a row shows
   the two colours side by side. */
var CMP_BY={};   /* LD_item means — drives the detail modal's peer list */
ITEMS.forEach(function(it){
  var key=it[0].slice(0,4).toUpperCase();
  (CMP_BY[key]=CMP_BY[key]||[]).push(it);
});
var CMP_SAMP={}; /* individual LD samples — this tab */
LDREFS.forEach(function(o){
  var key=o.item.slice(0,4).toUpperCase();
  (CMP_SAMP[key]=CMP_SAMP[key]||[]).push(o);
});
var cmpSel=document.getElementById('cmpTextile');
Object.keys(CMP_SAMP).filter(function(k){ return CMP_SAMP[k].length>1; })
 .sort().forEach(function(k){
  var o=document.createElement('option');
  o.value=k; o.textContent=k+' \u00b7 '+CMP_SAMP[k].length+' samples';
  cmpSel.appendChild(o);
});
function cmpDeltaE(a,b){   /* LDREFS entries are always Lab-valid */
  return Math.round(deltaE00(a.L,a.a,a.b,b.L,b.a,b.b)*100)/100;
}
function cmpBaseline(){
  var base=Number(document.getElementById('cmpBaseline').value);
  return (isNaN(base)||base<0) ? 1.0 : base;
}
function cmpCutoff(){
  var c=Number(document.getElementById('cmpCutoff').value);
  return (isNaN(c)||c<0) ? 10 : c;
}

var cmpPairs=[], cmpPage=0, cmpCol=2, cmpDir=1;

function buildPairs(){
  cmpPairs=[];
  var key=cmpSel.value;
  if(!key) return;
  var samp=CMP_SAMP[key], cutoff=cmpCutoff();
  for(var i=0;i<samp.length;i++){
    var a=samp[i];
    for(var j=i+1;j<samp.length;j++){
      var b=samp[j];
      /* Cheap straight Lab distance first: CIEDE2000 only for like colours. */
      if(Math.hypot(a.L-b.L,a.a-b.a,a.b-b.b)>cutoff) continue;
      cmpPairs.push({a:a, b:b, de:cmpDeltaE(a,b)});
    }
  }
}
function sortPairs(){
  var c=cmpCol, d=cmpDir;
  cmpPairs.sort(function(p,q){
    if(c===2) return d*(p.de-q.de);
    var va=c===0 ? p.a.name : p.b.name, vb=c===0 ? q.a.name : q.b.name;
    return d*va.localeCompare(vb);
  });
}
function cmpRowHtml(p){
  var base=cmpBaseline();
  return '<tr data-a="'+esc(p.a.key)+'" data-b="'+esc(p.b.key)+'">'
    +'<td>'+swatchLg(hexOf(p.a.hex))+'</td>'
    +'<td>'+esc(p.a.name)+'</td>'
    +'<td>'+swatchLg(hexOf(p.b.hex))+'</td>'
    +'<td>'+esc(p.b.name)+'</td>'
    +'<td class="de'+(p.de<base?' lo':'')+'">'+num(p.de,2)+'</td>'
    +'</tr>';
}
function renderCmp(){
  var from=cmpPage*PAGE, to=Math.min(from+PAGE, cmpPairs.length);
  var html=[];
  for(var i=from;i<to;i++) html.push(cmpRowHtml(cmpPairs[i]));
  document.getElementById('cmpBody').innerHTML=html.length ? html.join('')
    : '<tr><td class="empty" colspan="5">No like-colour pairs within the cutoff.</td></tr>';
  var base=cmpBaseline(), below=0;
  cmpPairs.forEach(function(p){ if(p.de<base) below++; });
  document.getElementById('cmpCount').textContent=cmpPairs.length.toLocaleString()
    +' like-colour pairs \u00b7 '+below.toLocaleString()+' below baseline '
    +num(base,1);
  document.getElementById('cmpInfo').textContent=cmpPairs.length
    ? 'Rows '+(from+1)+'\u2013'+to+' of '+cmpPairs.length.toLocaleString() : '';
  document.getElementById('cmpPrev').disabled=cmpPage<=0;
  document.getElementById('cmpNext').disabled=to>=cmpPairs.length;
}
function refreshCmp(){ cmpPage=0; buildPairs(); sortPairs(); renderCmp(); }

function cmpArrow(th){
  Array.prototype.forEach.call(
    document.querySelectorAll('#cmpTable th.sortable .arrow'),
    function(a){ a.remove(); });
  var sp=document.createElement('span'); sp.className='arrow';
  sp.textContent=(cmpDir===1?'\u25B2':'\u25BC'); th.appendChild(sp);
}
cmpSel.addEventListener('change',refreshCmp);
document.getElementById('cmpCutoff').addEventListener('input',refreshCmp);
/* Baseline only changes highlighting and the count — no need to rescan pairs. */
document.getElementById('cmpBaseline').addEventListener('input',renderCmp);
Array.prototype.forEach.call(
  document.querySelectorAll('#cmpTable th.sortable'),function(th){
  th.addEventListener('click',function(){
    var c=Number(th.getAttribute('data-c'));
    if(cmpCol===c){ cmpDir=-cmpDir; } else { cmpCol=c; cmpDir=1; }
    cmpArrow(th);
    sortPairs(); cmpPage=0; renderCmp();
  });
});
document.getElementById('cmpPrev').addEventListener('click',function(){
  if(cmpPage>0){ cmpPage--; renderCmp(); }});
document.getElementById('cmpNext').addEventListener('click',function(){
  if((cmpPage+1)*PAGE<cmpPairs.length){ cmpPage++; renderCmp(); }});
document.getElementById('cmpBody').addEventListener('click',function(e){
  var tr=e.target.closest('tr[data-a]');
  if(tr) openPair(tr.getAttribute('data-a'), tr.getAttribute('data-b'));
});
/* Default sort: ΔE ascending, with the arrow to prove it. */
cmpArrow(document.querySelector('#cmpTable th.sortable[data-c="2"]'));
refreshCmp();

/* Pair popup: the two LD samples' colours side by side — big square swatch
   cards on top, a details table (LD_item / NAME / hex / Lab) below. */
function pairCard(ref){
  var h=hexOf(ref.hex);
  return '<div class="big" style="background:'+(h
    ||'repeating-linear-gradient(45deg,#ddd,#ddd 4px,#fff 4px,#fff 8px)')+'"></div>'
    +'<div class="pname">'+esc(ref.name)+'</div>';
}
function pairTable(pa,pb){
  function row(k,va,vb){
    return '<tr><td class="k">'+k+'</td>'
      +'<td class="mono">'+va+'</td><td class="mono">'+vb+'</td></tr>';
  }
  return '<table class="pairtable"><thead><tr><th></th><th>A</th><th>B</th>'
    +'</tr></thead><tbody>'
    +row('LD_item',esc(pa.item),esc(pb.item))
    +row('NAME',esc(pa.name),esc(pb.name))
    +row('Hex',hexOf(pa.hex)||'\u2013',hexOf(pb.hex)||'\u2013')
    +row('L*',num(pa.L),num(pb.L))
    +row('a*',num(pa.a),num(pb.a))
    +row('b*',num(pa.b),num(pb.b))
    +'</tbody></table>';
}
function openPair(a,b){
  var pa=LDREFS[a], pb=LDREFS[b];
  if(!pa||!pb) return;
  var base=cmpBaseline();
  document.getElementById('pairTitle').textContent=pa.name+'  vs  '+pb.name;
  document.getElementById('pairCardA').innerHTML=pairCard(pa);
  document.getElementById('pairCardB').innerHTML=pairCard(pb);
  document.getElementById('pairDetail').innerHTML=pairTable(pa,pb);
  var de=cmpDeltaE(pa,pb);
  var pd=document.getElementById('pairDelta');
  pd.textContent='\u0394E '+num(de,2)+' \u2014 '+(de<base?'below':'above')
    +' baseline '+num(base,1);
  pd.className='pairdelta'+(de<base?' lo':'');
  document.getElementById('pairModal').style.display='flex';
  document.body.style.overflow='hidden';
}
function closePair(){
  document.getElementById('pairModal').style.display='none';
  document.body.style.overflow='';
}
document.getElementById('pairClose').addEventListener('click',closePair);
document.getElementById('pairModal').addEventListener('click',function(e){
  if(e.target.id==='pairModal') closePair(); });

/* ---- Stats tab ----
   Stats is the default view, so the charts are built immediately on load
   (ECharts can't measure hidden nodes — if the default ever changes back,
   revert to lazy building on the tab click). The guard also lets the tab's
   click listener call buildStats() harmlessly. */
var STATS={built:false,charts:[]};
function hBar(el,labels,vals,color){
  el.style.height=Math.max(240,labels.length*20+40)+'px';
  STATS.charts.push(echarts.init(el).setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
    grid:{left:8,right:34,top:8,bottom:8,containLabel:true},
    xAxis:{type:'value'},
    yAxis:{type:'category',data:labels,axisLabel:{fontSize:10,width:110,overflow:'truncate'}},
    series:[{type:'bar',data:vals,itemStyle:{color:color},
             label:{show:true,position:'right',fontSize:10}}]
  }));
}
function buildStats(){
  if(STATS.built) return;
  STATS.built=true;

  /* 1. Sample_type mix (donut) */
  (function(){
    var st=META.sample_types||{}, ks=Object.keys(st);
    var el=document.getElementById('chType');
    if(ks.length) STATS.charts.push(echarts.init(el).setOption({
      color:['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948',
             '#b07aa1','#ff9da7','#9c755f','#bab0ac'],
      tooltip:{trigger:'item',formatter:'{b}: {c} ({d}%)'},
      legend:{bottom:0,type:'scroll',textStyle:{fontSize:11}},
      series:[{type:'pie',radius:['38%','62%'],center:['50%','44%'],
               label:{fontSize:11,formatter:'{b}\n{d}%'},
               data:ks.map(function(k){ return {name:k,value:st[k]}; })}]
    }));
    document.getElementById('tNoteType').textContent=' '
      +ks.length+' types, '+META.total+' rows';
  })();

  /* 2. LD_item count per textile (first 4 chars of LD_item) */
  (function(){
    var groups={};
    ITEMS.forEach(function(it){
      var t=String(it[0]).slice(0,4);
      groups[t]=(groups[t]||0)+1;
    });
    var n=Object.keys(groups).length;
    var top=Object.keys(groups)
      .sort(function(a,b){ return groups[b]-groups[a]; })
      .slice(0,50).reverse()
      .map(function(k){ return [k,groups[k]]; });
    hBar(document.getElementById('chLd'),
         top.map(function(p){ return p[0]; }),
         top.map(function(p){ return p[1]; }), '#4e79a7');
    document.getElementById('tNoteLd').textContent=' top '+top.length
      +' of '+n+' textiles';
  })();

  /* 3. Distinct Raw batches per Raw_item (top 50) */
  (function(){
    var n=Object.keys(RAWBATCH).length;
    var top=Object.keys(RAWBATCH)
      .sort(function(a,b){ return RAWBATCH[b]-RAWBATCH[a]; })
      .slice(0,50).reverse()
      .map(function(k){ return [k,RAWBATCH[k]]; });
    hBar(document.getElementById('chBatch'),
         top.map(function(p){ return p[0]; }),
         top.map(function(p){ return p[1]; }), '#f28e2b');
    document.getElementById('tNoteBatch').textContent=' top '+top.length
      +' of '+n+' items';
  })();

  /* 4. Measurements per month, stacked by sample type */
  (function(){
    var buckets={};
    function bump(m,t){ if(!m) return; m=String(m).slice(0,7);
      (buckets[m]=buckets[m]||{})[t]=(buckets[m][t]||0)+1; }
    Object.keys(LD).forEach(function(k){
      LD[k].forEach(function(r){ bump(r[0],'LD'); }); });
    Object.keys(RAW).forEach(function(k){
      RAW[k].forEach(function(r){ bump(r[0],'Raw (matched)'); }); });
    Object.keys(UNRAW).forEach(function(k){
      UNRAW[k].forEach(function(r){ bump(r[0],'Raw (unmatched)'); }); });
    LAM.forEach(function(r){ bump(r[0],'Laminate'); });
    var months=Object.keys(buckets).sort();
    var types=['LD','Raw (matched)','Raw (unmatched)','Laminate'];
    STATS.charts.push(echarts.init(document.getElementById('chTime')).setOption({
      color:['#4e79a7','#f28e2b','#e15759','#76b7b2'],
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
      legend:{bottom:0,textStyle:{fontSize:11}},
      grid:{left:8,right:16,top:16,bottom:44,containLabel:true},
      xAxis:{type:'category',data:months,
             axisLabel:{fontSize:10,rotate:months.length>14?45:0}},
      yAxis:{type:'value'},
      series:types.map(function(t){
        return {name:t,type:'bar',stack:'m',
                data:months.map(function(m){ return buckets[m][t]||0; })};
      })
    }));
    var total=months.reduce(function(s,m){ var b=buckets[m];
      return s+types.reduce(function(s2,t){ return s2+(b[t]||0); },0); },0);
    document.getElementById('tNoteTime').textContent=' '+total
      +' dated rows over '+months.length+' months';
  })();

  /* 5. ΔE histogram of matched Raw samples vs their LD_item mean */
  (function(){
    var all=[];
    Object.keys(ITEM_BY).forEach(function(k){
      ITEM_BY[k].rows.forEach(function(r){
        if(r[7]!==''&&r[7]!=null) all.push(r[7]); });
    });
    var el=document.getElementById('chDe');
    if(!all.length){
      el.innerHTML='<div class="empty">No matched Raw samples with Lab values.</div>';
      return;
    }
    all.sort(function(a,b){ return a-b; });
    var step=0.1,
        cap=Math.max(step,Math.ceil(Math.min(all[all.length-1],
                    pct(all,0.99))/step)*step),
        bins=[], over=0, i, v;
    for(i=0;i*step<cap-1e-9;i++) bins.push(0);
    for(i=0;i<all.length;i++){
      v=all[i];
      if(v>=cap){ over++; continue; }
      bins[Math.min(bins.length-1,Math.floor(v/step))]++;
    }
    var mi=Math.floor(0.7/step);          // bin holding the 0.7 target
    var labels=bins.map(function(_,j){
      return (j*step).toFixed(1)+'\u2013'+((j+1)*step).toFixed(1); });
    labels.push('>'+cap.toFixed(1));
    STATS.charts.push(echarts.init(el).setOption({
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
      grid:{left:8,right:16,top:16,bottom:8,containLabel:true},
      xAxis:{type:'category',data:labels,
             axisLabel:{fontSize:9,rotate:45,interval:0}},
      yAxis:{type:'value',name:'samples'},
      series:[{type:'bar',barCategoryGap:0,
               data:bins.concat([over]),
               itemStyle:{color:function(p){
                 return p.dataIndex<mi?'#4e79a7':'#e15759'; }},
               markLine:0.7<cap?{silent:true,symbol:'none',data:[{xAxis:mi,
                 lineStyle:{color:'#d64541',type:'dashed',width:1.2},
                 label:{formatter:'Target 0.7',fontSize:10,color:'#d64541',
                        position:'insideEndTop'}}]}:undefined}
      ]
    }));
    document.getElementById('tNoteDe').textContent=' '+all.length
      +' samples \u00b7 median '+pct(all,0.5).toFixed(2)
      +' \u00b7 P95 '+pct(all,0.95).toFixed(2);
  })();
}
document.querySelector('[data-view="stats"]').addEventListener('click',buildStats);
window.addEventListener('resize',function(){
  STATS.charts.forEach(function(c){ c.resize(); });
});
buildStats();

/* ---- item detail modal ----
   mode 'ld'  : ΔE trend chart above the table of the matched Raw samples.
                The ΔE reference (any LD_item of the same textile) is selectable;
                ΔE is recomputed client-side against the chosen item's mean.
   mode 'un'  : table of an unmatched Raw_item's own samples (no reference). */
var curMode='ld', itemPage=0, ITEM_CHART=null, AB_CHART=null, ITEM_REF=null,
    ITEM_WORK=[], ITEM_VIEW=[], ITEM_FENCE=Infinity,
    AB_QC=0.7, AB_FULL=false, AB_R=7.5, AB_HUE=0, AB_RREF=null,
    AB_PTS=[], AB_BAD=[],
    itemCol=0, itemDir=1, itemQ='';

function itemFiltered(){
  var rows=ITEM_WORK.filter(function(r){
    if(!itemQ) return true;
    return String(r[1]).toLowerCase().indexOf(itemQ)!==-1
        || String(r[6]||'').toLowerCase().indexOf(itemQ)!==-1;
  });
  if(itemCol>=0){
    var c=itemCol, d=itemDir;
    rows=rows.slice().sort(function(x,y){
      var va=x[c], vb=y[c];
      if(va==null||va==='') return 1;
      if(vb==null||vb==='') return -1;
      if(typeof va==='number'&&typeof vb==='number') return d*(va-vb);
      return d*String(va).localeCompare(String(vb));
    });
  }
  return rows;
}
/* Outliers: boxplot upper fence Q3 + 1.5×IQR over all ΔE values. */
function computeFence(){
  var des=[];
  if(curMode==='ld') ITEM_WORK.forEach(function(r){ if(r[7]!=='') des.push(r[7]); });
  des.sort(function(x,y){ return x-y; });
  if(des.length<4){ ITEM_FENCE=Infinity; return; }
  var q1=pct(des,0.25), q3=pct(des,0.75), iqr=q3-q1;
  ITEM_FENCE = iqr>0 ? q3+1.5*iqr : des[des.length-1];
}
/* The modal's active ΔE reference: the dropdown pick while the peer selector
   is visible, otherwise the opened item's own mean LD colour. A hidden
   selector keeps the previously opened item's value, so visibility decides. */
function activeRef(){
  var wrap=document.getElementById('refWrap'),
      sel=document.getElementById('refSel');
  return (curMode==='ld'&&wrap&&wrap.style.display!=='none'
          &&LDREFS[sel.value])||ITEM_REF;
}
/* ΔE of every Raw sample vs the selected reference LD sample. */
function recomputeDE(){
  var rref=activeRef();
  if(!rref) return;
  ITEM_WORK.forEach(function(r){
    r[7]=(r[2]===''||r[3]===''||r[4]==='')
      ? '' : Math.round(deltaE00(r[2],r[3],r[4],rref.L,rref.a,rref.b)*100)/100;
  });
}
function renderChips(){
  var chips=document.getElementById('itemChips');
  if(curMode!=='ld'){
    chips.innerHTML=
      '<span class="cchip">Mean of Raw samples '+swatch(ITEM_REF.hex)
      +' <span class="hex">'+esc(hexOf(ITEM_REF.hex)||'\u2013')+'</span></span>'
      +'<span class="cchip">L* '+num(ITEM_REF.L)+'</span>'
      +'<span class="cchip">a* '+num(ITEM_REF.a)+'</span>'
      +'<span class="cchip">b* '+num(ITEM_REF.b)+'</span>'
      +'<span class="cchip">No matching LD_item</span>';
    return;
  }
  var rref=activeRef();
  chips.innerHTML=
    '<span class="cchip">\u0394E reference '+swatch(rref.hex)
    +' <span class="hex">'+esc(rref.name||rref.item)+'</span></span>'
    +'<span class="cchip">L* '+num(rref.L)+'</span>'
    +'<span class="cchip">a* '+num(rref.a)+'</span>'
    +'<span class="cchip">b* '+num(rref.b)+'</span>'
    +'<span class="cchip">'+ITEM_REF.n+' LD sample'+(ITEM_REF.n===1?'':'s')+'</span>';
}
function renderStats(){
  var box=document.getElementById('itemStats');
  function stat(k,v){ return '<div class="stat"><div class="k">'+k
    +'</div><div class="v">'+v+'</div></div>'; }
  if(curMode!=='ld'){
    box.innerHTML=stat('Raw samples', ITEM_WORK.length.toLocaleString());
    return;
  }
  var deVals=[];
  ITEM_WORK.forEach(function(r){ if(r[7]!=='') deVals.push(r[7]); });
  deVals.sort(function(x,y){ return x-y; });
  var nOut=deVals.filter(function(v){ return v>ITEM_FENCE; }).length;
  box.innerHTML=deVals.length
    ? stat('Matching Raw samples', ITEM_WORK.length.toLocaleString())
      +stat('Median \u0394E', num(pct(deVals,0.5),2))
      +stat('P95 \u0394E', num(pct(deVals,0.95),2))
      +stat('Worst \u0394E', num(deVals[deVals.length-1],2))
      +stat('Outliers', nOut.toLocaleString())
    : stat('Matching Raw samples','0');
}
function openDetail(mode,item){
  var ref = mode==='ld' ? ITEM_BY[item] : UN_BY[item];
  if(!ref) return;
  curMode=mode; ITEM_REF=ref; itemQ='';
  document.getElementById('iSearch').value='';
  ITEM_WORK=ref.rows.map(function(r){ return r.slice(); });
  document.getElementById('itemHead').innerHTML=
    '<th class="sortable" data-c="0">Date</th>'
    +'<th class="sortable" data-c="1">Raw sample</th>'
    +'<th>Item</th>'
    +'<th>Swatch</th>'
    +'<th class="sortable" data-c="5">Hex</th>'
    +(mode==='ld'?'<th class="sortable" data-c="7">&#916;E</th>':'')
    +'<th class="sortable" data-c="6">Batch</th>'
    +'<th class="sortable" data-c="2">L*</th>'
    +'<th class="sortable" data-c="3">a*</th>'
    +'<th class="sortable" data-c="4">b*</th>';
  var wrap=document.getElementById('refWrap');
  if(mode==='ld'){
    var pre=item.slice(0,4).toUpperCase();
    /* Only LD_items that actually have matched Raw samples ("available"). */
    var peers=(CMP_BY[pre]||[]).filter(function(it){ return it[6]>0; })
      .map(function(it){ return it[0]; }).sort();
    if(peers.length>1){
      wrap.style.display='';
      /* Grouped by LD_item; every option is one LD sample labelled by its
         NAME (e.g. "…-LD-2", "…-Master-4", "…-Master-4-Rejected by Ming").
         The value is the LDREFS index that drives the ΔE math; the default
         is the current item's first sample by NAME. */
      var sel=document.getElementById('refSel');
      sel.innerHTML=peers.map(function(n){
        var grp=LD_BY[n]||[];
        if(!grp.length) return '';
        return '<optgroup label="'+esc(n)+'">'+grp.map(function(o){
          return '<option value="'+o.key+'">'+esc(o.name)+'</option>';
        }).join('')+'</optgroup>';
      }).join('');
      var def=(LD_BY[item]||[])[0];
      sel.value=def?def.key:(sel.options.length?sel.options[0].value:'');
    } else wrap.style.display='none';
    recomputeDE();
    itemCol=7; itemDir=-1;
  } else {
    wrap.style.display='none';
    itemCol=0; itemDir=-1;
  }
  itemArrow();
  document.getElementById('modalTitle').textContent=item;
  computeFence();
  renderChips();
  renderStats();
  document.getElementById('modal').style.display='block';
  document.body.style.overflow='hidden';
  itemPage=0; renderItem();
  if(mode==='ld'){
    document.getElementById('deCard').style.display='block';
    buildItemChart();
    document.getElementById('abCard').style.display='block';
    buildAbChart();
  } else {
    if(ITEM_CHART){ ITEM_CHART.dispose(); ITEM_CHART=null; }
    if(AB_CHART){ AB_CHART.dispose(); AB_CHART=null; }
    document.getElementById('deCard').style.display='none';
    document.getElementById('abCard').style.display='none';
  }
}
function itemArrow(){
  Array.prototype.forEach.call(
    document.querySelectorAll('#itemHead th.sortable .arrow'),
    function(a){ a.remove(); });
  var th=document.querySelector('#itemHead th.sortable[data-c="'+itemCol+'"]');
  if(th){ var sp=document.createElement('span'); sp.className='arrow';
          sp.textContent=(itemDir===1?'\u25B2':'\u25BC'); th.appendChild(sp); }
}
/* Per-item ΔE by batch #: one point per matched Raw sample, batches sorted
   ascending. Points above the outlier fence (Q3+1.5×IQR) are red. Y is capped
   so a few outliers cannot flatten the band where the samples live; the x-axis
   zooms (wheel / pinch inside, slider below). */
function buildItemChart(){
  var box=document.getElementById('itemChart');
  if(ITEM_CHART){ ITEM_CHART.dispose(); ITEM_CHART=null; }
  if(curMode!=='ld') return;
  var raw=[];
  ITEM_WORK.forEach(function(r){
    if(r[7]===''||r[6]==='') return;         // needs a batch # and a ΔE
    raw.push([r[6], r[7], r[1]]);            // [batch, ΔE, Raw sample]
  });
  if(!raw.length){
    document.getElementById('deCard').style.display='none';
    return;
  }
  raw.sort(function(x,y){
    return String(x[0]).localeCompare(String(y[0]),undefined,{numeric:true}); });
  var batches=raw.map(function(p){ return p[0]; });
  var des=raw.map(function(p){ return p[1]; }).sort(function(x,y){ return x-y; });
  var p95=pct(des,0.95)||1, p995=pct(des,0.995)||1;
  /* On small items one huge outlier inflates the percentiles, so the median
     also bounds the cap (median*8+1 keeps the normal band readable). */
  var med=pct(des,0.5)||1;
  var clipMax=Math.ceil(Math.max(1,Math.min(p995,p95*2,med*8+1))*10)/10;
  var clipped=des.filter(function(v){ return v>clipMax; }).length;
  /* Points beyond the cap are pinned to the top edge (red) so outliers stay
     visible instead of being clipped away; value[3] keeps the real ΔE. */
  var pts=raw.map(function(p){
    return [p[0], Math.min(p[1],clipMax), p[2], p[1]];
  });
  var nOut=des.filter(function(v){ return v>ITEM_FENCE; }).length;
  var rr=activeRef();
  var refName=(rr.name||rr.item)+(rr===ITEM_REF?' mean':'');
  document.getElementById('deCardTitle').textContent=
    '\u0394E vs '+refName+' by batch \u2014 '+pts.length.toLocaleString()
    +' sample'+(pts.length===1?'':'s')
    +(nOut?' \u00b7 '+nOut.toLocaleString()+' outlier'+(nOut===1?'':'s')
           +' in red':'')
    +(clipped?', Y capped at '+clipMax+' ('+clipped.toLocaleString()
              +' higher point'+(clipped===1?'':'s')+' pinned at the top)':'');
  ITEM_CHART=echarts.init(box,null,{renderer:'canvas'});
  ITEM_CHART.setOption({
    animation:false,
    tooltip:{
      trigger:'item',
      formatter:function(p){
        return '<b>\u0394E '+num(p.value[3],2)+'</b><br>'+esc(p.value[2]||'')
          +'<br>Batch '+esc(p.value[0])
          +(p.value[1]>ITEM_FENCE?'<br><b style="color:#d64541">Outlier</b>':'');
      }
    },
    grid:{left:48,right:14,top:26,bottom:64},
    xAxis:{type:'category',data:batches,
           axisLabel:{fontSize:10,rotate:45,hideOverlap:true}},
    yAxis:{type:'value',name:'\u0394E',min:0,max:clipMax,nameTextStyle:{fontSize:11},
           axisLabel:{fontSize:10}},
    dataZoom:[{type:'inside',xAxisIndex:0},
              {type:'slider',xAxisIndex:0,height:16,bottom:10}],
    series:[
      {name:'Raw sample',type:'scatter',data:pts,symbolSize:6,clip:false,
       itemStyle:{opacity:0.6,color:function(p){
         return p.value[1]>ITEM_FENCE ? '#d64541' : '#4e79a7'; }},
       markLine:{silent:true,symbol:'none',data:[{yAxis:0.7,
         lineStyle:{color:'#d64541',type:'dashed',width:1.2},
         label:{formatter:'Target \u0394E 0.7',fontSize:10,color:'#d64541',
                position:'insideEndTop'}}]}}
    ]
  });
}
/* dCIELab map, a faithful port of templates/professional_dcielab_echart_v3.html:
   diagonal CIELAB sector shading (yellow toward +b, red toward +a, blue toward
   -b, green toward -a), a cross drawn along the reference hue direction, a
   solid blue QC ring and a QC / full-range view toggle. Quality control sits
   at 0.7: samples past the ring are red, the rest blue. The centre marker is
   the selected ΔE reference sample. */
function abCircle(r){
  var a=[];
  for(var i=0;i<=240;i++){
    var t=2*Math.PI*i/240;
    a.push([r*Math.cos(t),r*Math.sin(t)]);
  }
  return a;
}
/* Smallest "nice" tick value covering v, so the full-range view adapts to the
   data spread instead of a hardcoded +/-7.5. */
function abNice(v){
  var s=[.5,1,1.5,2,2.5,3,3.5,4,4.5,5,6,7,8,9,10,12,15,20,25,30,40,50,
         60,80,100];
  for(var i=0;i<s.length;i++) if(s[i]>=v) return s[i];
  return Math.ceil(v/100)*100;
}
/* Four 90-degree wedges clipped by the square plotting range, each centred on
   a cardinal Lab direction and bounded by the 45-degree diagonals. */
function abShade(params,api){
  var R=api.value(0);
  function P(x,y){ return api.coord([x,y]); }
  function poly(points,fill){ return {type:'polygon',
    shape:{points:points.map(function(q){ return P(q[0],q[1]); })},
    style:{fill:fill,stroke:null}}; }
  return {type:'group',children:[
    poly([[0,0],[-R,R],[R,R]],'rgba(250,204,21,.22)'),
    poly([[0,0],[R,R],[R,-R]],'rgba(239,68,68,.16)'),
    poly([[0,0],[R,-R],[-R,-R]],'rgba(59,130,246,.17)'),
    poly([[0,0],[-R,-R],[-R,R]],'rgba(34,197,94,.17)')]};
}
/* Cross through the origin along the reference hue direction. */
function abCross(params,api){
  var o=api.coord([0,0]), px=api.coord([1,0]), py=api.coord([0,1]);
  var sx=Math.abs(px[0]-o[0]), sy=Math.abs(py[1]-o[1]);
  var vx=sx*Math.cos(AB_HUE), vy=-sy*Math.sin(AB_HUE);
  var m=Math.sqrt(vx*vx+vy*vy); vx/=m; vy/=m;
  var wx=-vy, wy=vx,
      L=Math.min(params.coordSys.width,params.coordSys.height)*.40;
  function ln(x,y){ return {type:'line',
    shape:{x1:o[0]-x*L,y1:o[1]-y*L,x2:o[0]+x*L,y2:o[1]+y*L},
    style:{stroke:'#111827',lineWidth:2}}; }
  return {type:'group',children:[ln(vx,vy),ln(wx,wy)]};
}
function abOpt(full){
  var R=full?AB_R:1.5, I=full?null:.5;
  var boxEl=document.getElementById('abChart');
  var wide=boxEl&&boxEl.clientWidth>=380;
  var xn=wide?'\u0394a*    GREEN  \u2190                              \u2192  RED'
             :'\u0394a*  GREEN \u2190      \u2192  RED';
  var yn=wide?'\u0394b*    BLUE  \u2190                              \u2192  YELLOW'
             :'\u0394b*  BLUE \u2190      \u2192  YELLOW';
  return {animation:false,
    tooltip:{confine:true,trigger:'item',formatter:function(p){
      if(p.seriesName==='Reference')
        return '<b>Reference</b><br>'+esc(AB_RREF.name||AB_RREF.item)
          +'<br>L* '+num(AB_RREF.L)+' \u00b7 a* '+num(AB_RREF.a)
          +' \u00b7 b* '+num(AB_RREF.b);
      var v=p.value;
      return '<b>'+esc(p.data.name||'')+'</b>'
        +(p.data.batch?'<br>Batch '+esc(p.data.batch):'')
        +'<br>\u0394a*: '+num(v[0],2)+'<br>\u0394b*: '+num(v[1],2)
        +'<br>\u0394E00: '+num(v[2],2);
    }},
    grid:{left:78,right:42,top:42,bottom:78},
    xAxis:{type:'value',min:-R,max:R,interval:I,name:xn,
      nameLocation:'middle',nameGap:46,
      nameTextStyle:{fontSize:13,fontWeight:700,color:'#344054'},
      axisLine:{onZero:true,lineStyle:{color:'#667085',width:1.4}},
      axisLabel:{color:'#667085'},
      splitLine:{lineStyle:{color:'#cbd5e1',width:1,type:'dashed'}}},
    yAxis:{type:'value',min:-R,max:R,interval:I,name:yn,
      nameLocation:'middle',nameRotate:90,nameGap:50,
      nameTextStyle:{fontSize:13,fontWeight:700,color:'#344054'},
      axisLine:{onZero:true,lineStyle:{color:'#667085',width:1.4}},
      axisLabel:{color:'#667085'},
      splitLine:{lineStyle:{color:'#cbd5e1',width:1,type:'dashed'}}},
    series:[
      {type:'custom',coordinateSystem:'cartesian2d',data:[[R]],silent:true,
       z:0,renderItem:abShade},
      {type:'line',data:abCircle(AB_QC),showSymbol:false,silent:true,z:4,
       lineStyle:{color:'#2563eb',width:2}},
      {type:'custom',coordinateSystem:'cartesian2d',data:[[0]],silent:true,
       z:6,renderItem:abCross},
      {name:'Reference',type:'scatter',data:[[0,0]],symbolSize:11,z:12,
       itemStyle:{color:'#fff',borderColor:'#475467',borderWidth:2}},
      {name:'Pass',type:'scatter',data:AB_PTS,symbolSize:5,z:10,
       itemStyle:{color:'#1570ef',borderColor:'#fff',borderWidth:1}},
      {name:'Fail',type:'scatter',data:AB_BAD,symbolSize:6,z:10,
       itemStyle:{color:'#d92d20',borderColor:'#fff',borderWidth:1}}
    ]};
}
function abSet(full){
  AB_FULL=full;
  if(AB_CHART) AB_CHART.setOption(abOpt(full),true);
  abButtons();
}
function abButtons(){
  var q=document.getElementById('abQc'), f=document.getElementById('abFull');
  if(!q||!f) return;
  q.className=AB_FULL?'':'active';
  f.className=AB_FULL?'active':'';
}
function buildAbChart(){
  var box=document.getElementById('abChart');
  if(AB_CHART){ AB_CHART.dispose(); AB_CHART=null; }
  if(curMode!=='ld') return;
  var rref=activeRef();
  var pts=[], bad=[];
  ITEM_WORK.forEach(function(r){
    if(r[3]===''||r[4]==='') return;         // needs a* and b*
    var da=r[3]-rref.a, db=r[4]-rref.b;
    var d={name:r[1],
           value:[Math.round(da*100)/100,Math.round(db*100)/100,r[7]],
           batch:r[6]||''};
    (r[7]!==''&&r[7]>AB_QC?bad:pts).push(d);
  });
  var card=document.getElementById('abCard');
  if(!pts.length&&!bad.length){ card.style.display='none'; return; }
  /* Full-range view adapts to the data spread: cover QC ring and all dots,
     rounded up to a nice tick, instead of a fixed +/-7.5. */
  var m=AB_QC;
  pts.concat(bad).forEach(function(d){
    m=Math.max(m,Math.abs(d.value[0]),Math.abs(d.value[1]));
  });
  AB_R=Math.max(1.5,abNice(m*1.05));
  document.getElementById('abFull').textContent='Full Range \u00b1'+AB_R;
  card.style.display='block';
  var tot=pts.length+bad.length;
  document.getElementById('abCardTitle').textContent=
    '\u0394a*/\u0394b* vs '+(rref.name||rref.item)+' \u2014 '
    +tot.toLocaleString()+' sample'+(tot===1?'':'s')
    +(bad.length?' \u00b7 '+bad.length.toLocaleString()
                +' over QC '+AB_QC+' in red':'')
    +' \u00b7 blue ring = QC '+AB_QC;
  AB_HUE=Math.atan2(rref.b,rref.a);
  AB_RREF=rref; AB_PTS=pts; AB_BAD=bad;
  AB_CHART=echarts.init(box,null,{renderer:'canvas'});
  AB_CHART.setOption(abOpt(AB_FULL),true);
  document.getElementById('abQc').onclick=function(){ abSet(false); };
  document.getElementById('abFull').onclick=function(){ abSet(true); };
  abButtons();
}
function renderItem(){
  ITEM_VIEW=itemFiltered();
  var from=itemPage*PAGE, to=Math.min(from+PAGE,ITEM_VIEW.length);
  var html=[];
  for(var i=from;i<to;i++){
    var r=ITEM_VIEW[i], hex=hexOf(r[5]);
    html.push('<tr><td>'+esc(day(r[0]))+'</td><td>'+esc(r[1])+'</td>'
      +'<td>'+esc(ITEM_REF.item)+'</td>'
      +'<td>'+swatchLg(r[5])+'</td><td class="hex">'+esc(hex||'\u2013')+'</td>'
      +(curMode==='ld'?'<td class="'+(r[7]!==''&&r[7]>ITEM_FENCE?'out':'')
                       +'">'+(r[7]===''?'\u2013':num(r[7],2))+'</td>':'')
      +'<td>'+esc(r[6]||'\u2013')+'</td>'
      +'<td>'+esc(num(r[2]))+'</td><td>'+esc(num(r[3]))+'</td><td>'+esc(num(r[4]))+'</td></tr>');
  }
  document.getElementById('itemBody').innerHTML=html.length?html.join('')
    : '<tr><td colspan="10" class="empty">No Raw samples.</td></tr>';
  document.getElementById('iInfo').textContent=ITEM_VIEW.length
    ? 'Rows '+(from+1)+'\u2013'+to+' of '+ITEM_VIEW.length.toLocaleString()
      +(itemQ?' (filtered)':'')
    : 'No matching Raw samples';
  document.getElementById('iPrev').disabled=itemPage<=0;
  document.getElementById('iNext').disabled=to>=ITEM_VIEW.length;
}
document.getElementById('iSearch').addEventListener('input',function(){
  itemQ=this.value.trim().toLowerCase(); itemPage=0; renderItem(); });
document.getElementById('itemHead').addEventListener('click',function(e){
  var th=e.target.closest('th.sortable');
  if(!th) return;
  var c=Number(th.getAttribute('data-c'));
  if(itemCol===c){ itemDir=-itemDir; } else { itemCol=c; itemDir=1; }
  itemArrow();
  itemPage=0; renderItem(); });
document.getElementById('refSel').addEventListener('change',function(){
  recomputeDE(); computeFence();
  itemCol=7; itemDir=-1; itemPage=0;
  itemArrow(); renderChips(); renderStats(); renderItem();
  buildItemChart(); buildAbChart(); });
document.getElementById('iPrev').addEventListener('click',function(){
  if(itemPage>0){ itemPage--; renderItem(); }});
document.getElementById('iNext').addEventListener('click',function(){
  if((itemPage+1)*PAGE<ITEM_VIEW.length){ itemPage++; renderItem(); }});
function closeItem(){
  if(ITEM_CHART){ ITEM_CHART.dispose(); ITEM_CHART=null; }
  if(AB_CHART){ AB_CHART.dispose(); AB_CHART=null; }
  document.getElementById('modal').style.display='none';
  document.body.style.overflow='';
}
document.getElementById('modalClose').addEventListener('click',closeItem);
document.getElementById('modal').addEventListener('click',function(e){
  if(e.target.id==='modal') closeItem(); });
document.addEventListener('keydown',function(e){
  if(e.key!=='Escape') return;
  if(document.getElementById('pairModal').style.display!=='none'){ closePair(); return; }
  if(document.getElementById('modal').style.display==='block') closeItem(); });

/* ---- Match Pantone tab ---- */
var PT_LIST=PANTONE.map(function(r,i){
  return {i:i,id:String(r[0]),name:String(r[1]),zh:String(r[2]),
          hex:String(r[3]),L:Number(r[4]),a:Number(r[5]),b:Number(r[6])};
});
var PT_GORE=document.getElementById('ptGore'),
    PT_THR=document.getElementById('ptThr'),
    PT_OUT=document.getElementById('ptOut'),
    PT_INFO=document.getElementById('ptSelInfo'),
    PT_SEL=-1, PT_PAGE=0, PT_PER=100;

function ptFillSelects(){
  function prefixes(list){
    var m={};
    list.forEach(function(it){
      var p=String(it[0]).slice(0,4).toUpperCase();
      if(!m[p]) m[p]={p:p,c:0};
      m[p].c++;
    });
    return Object.keys(m).map(function(k){ return m[k]; })
      .sort(function(x,y){ return x.p<y.p?-1:1; });
  }
  PT_GORE.innerHTML='<option value="">All textiles</option>'
    +prefixes(ITEMS).map(function(o){
      return '<option value="'+esc(o.p)+'">'+esc(o.p)
        +' ('+o.c+' LD item'+(o.c===1?'':'s')+')</option>';
    }).join('');
  /* Form-state restoration (F5) can leave a select with selectedIndex -1. */
  PT_GORE.selectedIndex=0;
}
function ptFiltered(){
  var lg=document.querySelector('input[name="ptL"]:checked').value,
      q=document.getElementById('ptSearch').value.trim().toLowerCase();
  return PT_LIST.filter(function(c){
    if(lg && c.id.slice(0,2)!==lg) return false;
    if(q && (c.id+' '+c.name+' '+c.zh).toLowerCase().indexOf(q)<0) return false;
    return true;
  });
}
function ptRenderGrid(){
  var list=ptFiltered(), pages=Math.max(1,Math.ceil(list.length/PT_PER));
  if(PT_PAGE>=pages) PT_PAGE=pages-1;
  if(PT_PAGE<0) PT_PAGE=0;
  PT_INFO.textContent=list.length
    ? list.length.toLocaleString()+' colours \u00b7 '
      +(PT_SEL<0?'none selected':PT_LIST[PT_SEL].id+' '+PT_LIST[PT_SEL].name)
    : 'No colours match the filter';
  document.getElementById('ptGrid').innerHTML=list
    .slice(PT_PAGE*PT_PER,PT_PAGE*PT_PER+PT_PER)
    .map(function(c){
      return '<button type="button" class="pt-sw'+(c.i===PT_SEL?' sel':'')
        +'" data-i="'+c.i+'" style="background:'+hexOf(c.hex)
        +'" title="'+esc(c.id+' '+c.name)+'" aria-label="'+esc(c.id)+'"></button>';
    }).join('');
  document.getElementById('ptPageInfo').textContent=list.length
    ? 'Page '+(PT_PAGE+1)+' of '+pages
    : '0 colours';
  document.getElementById('ptPrev').disabled=PT_PAGE<=0;
  document.getElementById('ptNext').disabled=PT_PAGE>=pages-1;
}
function ptCandidates(){
  var g=PT_GORE.value, out=[];
  function pre(v){ return String(v).slice(0,4).toUpperCase(); }
  function add(mode,list){ list.forEach(function(it){ out.push([mode,it]); }); }
  if(g){
    add('ld',ITEMS.filter(function(it){ return pre(it[0])===g; }));
    if(!out.length) add('un',UNITEMS.filter(function(it){ return pre(it[0])===g; }));
  } else {
    add('ld',ITEMS); add('un',UNITEMS);
  }
  return out;
}
function ptOutput(){
  if(PT_SEL<0){
    PT_OUT.innerHTML='<div class="pt-hint2"><span class="pt-x">\u2297</span>'
      +'Select a Pantone colour to see the nearest item.</div>';
    return;
  }
  var c=PT_LIST[PT_SEL];
  var cands=ptCandidates().filter(function(row){
    var it=row[1]; return it[2]!=='' && it[3]!=='' && it[4]!=='';
  });
  if(!cands.length){
    PT_OUT.innerHTML='<div class="pt-hint2"><span class="pt-x">\u2297</span>'
      +'No items with Lab data for this textile selection.</div>';
    return;
  }
  var thr=parseFloat(PT_THR.value);
  if(!(thr>=0)) thr=1.0; /* blank or invalid -> default */
  var bestLD=null, bestUN=null;
  cands.forEach(function(row){
    var it=row[1], d=deltaE00(c.L,c.a,c.b,it[2],it[3],it[4]);
    if(row[0]==='ld'){ if(!bestLD || d<bestLD.de) bestLD={mode:'ld',it:it,de:d}; }
    else if(!bestUN || d<bestUN.de) bestUN={mode:'un',it:it,de:d};
  });
  var best=(bestLD && bestLD.de<=thr) ? bestLD
          : (bestUN && bestUN.de<=thr) ? bestUN : null;
  if(!best){
    var near=!bestLD ? bestUN : (!bestUN || bestLD.de<bestUN.de) ? bestLD : bestUN;
    PT_OUT.innerHTML='<div class="pt-hint2"><span class="pt-x">\u2297</span>'
      +'No match within \u0394E00 \u2264 '+thr.toFixed(2)+' for '+esc(c.id)+' '
      +esc(c.name)+'. Nearest candidate: '+esc(near.it[0])+' at \u0394E00 '
      +near.de.toFixed(2)+'.</div>';
    return;
  }
  var ld=best.mode==='ld', it=best.it;
  PT_OUT.innerHTML=
    '<div class="table-wrap"><table class="pt-table"><thead><tr>'
    +'<th></th><th>Item</th><th>Swatch</th><th>Hex</th>'
    +'<th>L*</th><th>a*</th><th>b*</th>'
    +'</tr></thead><tbody>'
    +'<tr><th>Pantone</th><td>'+esc(c.id)+' '+esc(c.name)+'</td>'
    +'<td>'+swatchLg(c.hex)+'</td><td>'+esc(c.hex)+'</td>'
    +'<td>'+num(c.L)+'</td><td>'+num(c.a)+'</td><td>'+num(c.b)+'</td></tr>'
    +'<tr><th>Nearest '+(ld?'LD_item':'Raw_item')+'</th><td>'+esc(it[0])+'</td>'
    +'<td>'+swatchLg(it[5])+'</td><td>'+esc(it[5])+'</td>'
    +'<td>'+num(it[2])+'</td><td>'+num(it[3])+'</td><td>'+num(it[4])+'</td></tr>'
    +'</tbody></table></div>'
    +'<p class="pt-note">\u0394E00 (CIEDE2000) = <b>'+best.de.toFixed(2)
    +'</b> (threshold '+thr.toFixed(2)+') \u00b7 '
    +(ld ? Number(it[6]).toLocaleString()+' matched Raw samples'
         : 'no LD_item within the threshold \u00b7 '
           +Number(it[1]).toLocaleString()+' Raw samples')
    +' \u00b7 <a href="#" class="pt-see" data-mode="'+best.mode
    +'" data-item="'+esc(it[0])+'">See details</a></p>';
}
function ptSetSel(i){
  PT_SEL=Number(i);
  ptRenderGrid(); ptOutput();
}
ptFillSelects();
ptRenderGrid(); ptOutput();
document.getElementById('ptLight').addEventListener('change',function(){
  PT_PAGE=0; ptRenderGrid(); });
document.getElementById('ptSearch').addEventListener('input',function(){
  PT_PAGE=0; ptRenderGrid(); });
document.getElementById('ptPrev').addEventListener('click',function(){
  PT_PAGE-=1; ptRenderGrid(); });
document.getElementById('ptNext').addEventListener('click',function(){
  PT_PAGE+=1; ptRenderGrid(); });
document.getElementById('ptGrid').addEventListener('click',function(e){
  var b=e.target.closest('.pt-sw');
  if(b) ptSetSel(b.getAttribute('data-i')); });
PT_GORE.addEventListener('change',function(){
  ptOutput(); });
PT_THR.addEventListener('input',function(){
  ptOutput(); });
PT_OUT.addEventListener('click',function(e){
  var a=e.target.closest('a.pt-see');
  if(!a) return;
  e.preventDefault();
  openDetail(a.getAttribute('data-mode'),a.getAttribute('data-item')); });

window.addEventListener('resize',function(){
  if(ITEM_CHART) ITEM_CHART.resize();
  if(AB_CHART) AB_CHART.resize();
});

document.getElementById('meta').textContent=
  META.items.toLocaleString()+' LD items \u00b7 '+META.raw.toLocaleString()
  +' Raw samples matched \u00b7 '+META.unmatched_items.toLocaleString()
  +' unmatched Raw items ('+META.unmatched_raw.toLocaleString()+' rows) \u00b7 '
  +META.lam.toLocaleString()+' Laminate rows'
  +(META.date_min?' \u00b7 '+META.date_min+' to '+META.date_max:'')
  +(META.skipped?' \u00b7 '+META.skipped.toLocaleString()
    +' rows skipped (Sample_type \'Null\' or Raw without Raw_item)':'');
renderLam();
</script>
</body>
</html>
"""


def echarts_source() -> str:
    """ECharts inlined in a <script> tag so the html is fully standalone.

    Prefer the library bundled with the app (works offline in the script editor
    and in the packaged EXE); fall back to downloading it when not importable.
    """
    try:
        from app.resources.echarts import get_echarts_js
        js = get_echarts_js()
    except Exception as exc:  # noqa: BLE001 - app modules not importable standalone
        print(f"Warning: could not use bundled ECharts ({exc}); trying CDN.")
        try:
            with urllib.request.urlopen(ECHARTS_CDN, timeout=25) as response:
                js = response.read().decode("utf-8")
        except Exception as exc2:  # noqa: BLE001
            print(f"Warning: could not embed ECharts ({exc2}); using a CDN reference instead.")
            return f'<script src="{ECHARTS_CDN}"></script>'
    return "<script>" + js.replace("</script", "<\\/script") + "</script>"


def _pantone_cache_path() -> Path:
    """JSON cache location for the extracted Pantone TCX rows."""
    root = os.environ.get("APPDATA") or tempfile.gettempdir()
    return Path(root) / "ODBCQueryApp" / "pantone_tcx_cache.json"


def _urlopen_resilient(request, timeout):
    """app.update's retry/proxy-fallback opener when importable (rides out the
    corporate network's flaky direct egress); plain urlopen otherwise."""
    try:
        from app.update import _urlopen_with_fallback
        return _urlopen_with_fallback(request, timeout=timeout)
    except Exception:  # noqa: BLE001 - standalone CLI: app package not importable
        return urllib.request.urlopen(request, timeout=timeout)


def _parse_pantone_xlsx(data: bytes) -> list:
    """Pantone_TCX.xlsx bytes -> [[id, name, zh, hex, L, a, b], ...] rows."""
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    rows = []
    for row in wb.active.iter_rows(min_row=2, values_only=True):
        cells = (list(row) + [None] * 7)[:7]
        pid = _text(cells[0])
        lab = (_num(cells[4]), _num(cells[5]), _num(cells[6]))
        if not pid or any(v is None for v in lab):
            continue
        hexv = _text(cells[3])
        rows.append([pid, _text(cells[1]), _text(cells[2]),
                     hexv if hexv.startswith("#") else "#" + hexv,
                     round(lab[0], 2), round(lab[1], 2), round(lab[2], 2)])
    return rows


def load_pantone() -> list:
    """Rows for the Match Pantone tab — lazy loaded: reuse the local JSON
    cache when present, otherwise download Pantone_TCX.xlsx from the public
    Supabase bucket once, extract the values and cache them.

    Returns [] (with a warning) when the library cannot be loaded, so the
    rest of the report still generates.
    """
    global _pantone_cache
    if _pantone_cache is not None:
        return _pantone_cache

    cache = _pantone_cache_path()
    if cache.is_file():
        try:
            rows = json.loads(cache.read_text(encoding="utf-8"))
            if isinstance(rows, list) and len(rows) > 1000:
                return rows
        except (OSError, ValueError):
            print("Warning: the Pantone cache is unreadable — downloading again.")

    print("Downloading the Pantone TCX library from Supabase (first run only)…")
    rows = []
    try:
        request = urllib.request.Request(
            PANTONE_XLSX_URL, headers={"Cache-Control": "no-cache"})
        with _urlopen_resilient(request, timeout=120) as response:
            data = response.read()
        rows = _parse_pantone_xlsx(data)
        print(f"  loaded {len(rows)} Pantone TCX colours.")
    except Exception as exc:  # noqa: BLE001 - never block the whole report
        print(f"Warning: could not load the Pantone TCX library ({exc}); "
              f"the Match Pantone tab will be empty.")

    if rows:
        try:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(rows, ensure_ascii=False),
                             encoding="utf-8")
        except OSError:
            pass  # the cache is only an optimisation — re-download next time
    _pantone_cache = rows
    return rows


def main():
    started = time.perf_counter()
    rows = globals().get("data")
    input_path = None
    output_arg = None
    if rows is not None:
        if not rows:
            sys.exit("No data supplied — select the Color_Data rows in the grid first.")
        records = list(rows)
    else:
        parser = argparse.ArgumentParser(
            description="Build a self-contained Lab colour explorer from Color_Data rows.")
        parser.add_argument("--input", help="Input .xlsx / .csv. Defaults to color_*.xlsx in this folder.")
        parser.add_argument("--output", help="Output HTML path. Defaults to ~/Downloads/color_data_<timestamp>.html.")
        args = parser.parse_args()
        input_path = Path(args.input) if args.input else find_default_input()
        output_arg = args.output
        if not input_path or not input_path.exists():
            sys.exit(f"Input file not found. Provide --input <file>. Looked in: {Path('.').resolve()}")
        records = load_frame(input_path).to_dict("records")

    if not records:
        sys.exit("Input data is empty.")

    payload = build_payload(records)
    meta = payload["meta"]
    if not meta["items"]:
        sys.exit("No LD rows found — the page needs rows with Sample_type='LD' and an LD_item.")

    data_js = json.dumps(payload, ensure_ascii=False,
                         separators=(",", ":")).replace("</", "<\\/")
    pantone_js = json.dumps(load_pantone(), ensure_ascii=False,
                            separators=(",", ":")).replace("</", "<\\/")
    html = (HTML_TEMPLATE
            .replace("<script>@@ECHARTS@@</script>", echarts_source())
            .replace("@@DATA@@", data_js)
            .replace("@@PANTONE@@", pantone_js))

    out_path = Path(output_arg) if output_arg else resolve_output_dir()
    if out_path.is_dir() or not out_path.suffix:
        out_path = out_path / f"color_data_{time.strftime('%Y%m%d_%H%M%S')}.html"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")

    print(f"Input : {input_path if input_path else 'grid data'}")
    print(f"Rows  : {meta['total']} ({meta['sample_types']})")
    print(f"LD items: {meta['items']} | Raw matched: {meta['raw']} | "
          f"Unmatched Raw items: {meta['unmatched_items']} "
          f"({meta['unmatched_raw']} rows) | Laminate: {meta['lam']}")
    print(f"Tabs  : 5 (LD heat map, Unmatched Raw, Laminate, DE Compare, Match Pantone)")
    print(f"Size  : {out_path.stat().st_size / 1024 / 1024:.1f} MB "
          f"in {time.perf_counter() - started:.1f}s")
    # Remind the user where the report was saved, then open it in the browser.
    print(f"Charts generated: {out_path}")
    webbrowser.open(out_path.resolve().as_uri())


if __name__ == "__main__":
    main()