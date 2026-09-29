#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze-color-data.py

Lab colour explorer for Color_Data: one self-contained HTML page with five tabs.

  1. Stats          - overview charts: sample-type mix (pie), LD_item count
                      per textile, distinct Raw batches per Raw_item, measurements
                      per month and a ΔE histogram of matched Raw samples vs
                      their LD_item mean (0.8 target line).
  2. Raw            - one row per LD_item in a searchable, sortable table
                      (100 rows per page), coloured by the mean colour of its
                      LD samples. The NAME column lists the item's distinct LD
                      sample NAMEs; the Matched Raw column counts the Raw samples
                      referencing the item; the LD_item link opens a detail
                      view with the item's ΔE per batch # (CMC(2:1) of every
                      matched Raw sample vs a selectable reference LD_item's
                      mean colour — only items with matched Raw samples are
                      listed — 0.8 target line, outliers beyond the
                      Q3+1.5×IQR fence in red, zoomable x-axis) above a
                      searchable, sortable table of those samples. An Unmatched
                      Raw button beside the search field opens the Unmatched Raw
                      dialog (see below).
  3. Laminate       - one row per laminate-master Product, coloured by the mean
                      colour of that Product's master plates, with the count of
                      distinct WOLs and laminate samples under it. The NAME
                      column lists the Product's master-plate NAMEs. The Product
                      link opens a detail view mirroring the Raw tab: the
                      Product's laminate samples scored with CMC(2:1) against
                      the Product's master-plate mean colour (1.0 target line
                      and QC ring). An Unmatched Laminate button beside the
                      search field lists the laminate rows that carry no Product.
  4. LD Redundancy  - flags duplicate LD samples: the LD_items sharing a prefix
                      (the first 4 characters, i.e. one textile) are clustered
                      by CMC(2:1) against a Group ΔE input, and every cluster of
                      n members leaves n−1 redundant. Four sub-views: Overall (a
                      sortable per-textile table ending in the redundancy %),
                      Groups (the clustered samples, paged), Matrix (the
                      pairwise ΔE heat map) and Color (a colour grid). An Export
                      redundant CSV button writes the flagged samples, and an ⓘ
                      button explains the grouping.
  5. Match Pantone  - pick a Pantone TCX colour (the 2,310-colour library is
                      embedded in this script), optionally narrow the search
                      to a face textile — the first 4 characters of an
                      LD_item (Gore item) or of a Raw_item (supplier textile)
                      — and the tab reports the nearest item by CMC(2:1):
                      the nearest LD_item when the chosen textile has one,
                      otherwise the nearest unmatched Raw_item.

The LD Redundancy tab gathers the LD samples of one LD_item prefix that sit
within the Group ΔE of each other into a group by complete linkage and keeps
the group's medoid as the representative; the leftover members are redundant.
Clicking a group's row shows the representative's colour against the member's.

The Unmatched Raw dialog (also opened from the Raw tab) tables the
Raw_items that match no LD_item, coloured by the mean colour of their own Raw
samples; the Raw_item link opens that item's detail view.

Every tab shows the colour as a large swatch in its own column.

Built with Apache ECharts (canvas). The colour swatches reuse the Hex column
computed by the grid, and the ΔE is CMC(2:1) (l:c = 2:1).

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
LAMINATE_MASTER = "Laminate Master"
LAMINATE_SAMPLE = "Laminate Sample"
# The Laminate tab holds both: a B##-prefixed NAME is a master plate, the other
# WOL-named rows are the samples measured on it.
LAMINATE_TYPES = (LAMINATE_MASTER, LAMINATE_SAMPLE)

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
              (matched-Raw count filled at runtime), LD sample NAMEs]
    ld:      {LD_item: [[date, name, L, a, b, hex, Batch], ...]}  (every LD sample)
    raw:     {LD_item: [[date, name, L, a, b, hex, Batch], ...]}  (matched only)
    unitems: [Raw_item, n_raw, mean_L, mean_a, mean_b, hex]       (no matching LD_item)
    unraw:   {Raw_item: [[date, name, L, a, b, hex, Batch], ...]}
    rawbatch: {Raw_item: distinct non-empty Batch count}  (matched + unmatched)
    lam:     [[date, name, L, a, b, hex, WOL, Batch, Product, Description,
               Raw_item, Sample_type], ...]
    lamprod: [Product, WOL count, mean_L, mean_a, mean_b, hex,
              laminate samples, master plates, master plate NAMEs]
              (one per master Product)
    export_cols / export: the LD and Raw measurement rows verbatim, in source
              order, for the Raw tab's Excel export.
    lam_export_cols / lam_export: the same, for the Laminate tab — every row
              whose Sample_type is Laminate Master or Laminate Sample.
    """
    ld_acc = defaultdict(lambda: [0, 0.0, 0.0, 0.0])   # item -> n, sum L, a, b
    ld_samples = defaultdict(list)   # item -> every LD sample row (for NAME refs)
    raw_rows = []
    lam_rows = []
    # Per-Product accumulator for the Laminate tab: the distinct WOLs and
    # laminate samples measured under a Product, plus the running sums used for
    # the master-plate mean (the reference the samples are scored against) and
    # the sample-mean fallback when a Product has no master plate with Lab.
    lamprod_acc = defaultdict(lambda: {"wol": set(), "samples": 0, "masters": 0,
                                       "names": set(),
                                       "ml": 0.0, "ma": 0.0, "mb": 0.0, "mn": 0,
                                       "sl": 0.0, "sa": 0.0, "sb": 0.0, "sn": 0})
    counts = defaultdict(int)
    ld_rows = 0
    export_rows = []

    for record in records:
        sample_type = _text(record.get("Sample_type"))
        counts[sample_type or "(blank)"] += 1
        l, a, b = (_num(record.get("L")), _num(record.get("a")),
                   _num(record.get("b")))
        hex_value = _text(record.get("Hex"))
        date = _iso_date(record.get("DATE"))
        name = _text(record.get("NAME"))

        # Each LD / Raw measurement row is also kept verbatim for the Raw tab's
        # Excel export — the tab's own heat maps only summarise these rows.
        if sample_type in (LD, RAW):
            export_rows.append([
                date, name, _r(l), _r(a), _r(b),
                hex_value or (lab_to_hex(l, a, b) if None not in (l, a, b) else ""),
                _text(record.get("Batch")), _text(record.get("LD_item")),
                _text(record.get("Raw_item")), _text(record.get("WOL")),
                _text(record.get("Product")), _text(record.get("Description")),
                sample_type,
            ])

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

        if sample_type in LAMINATE_TYPES:
            wol = _text(record.get("WOL"))
            product = _text(record.get("Product"))
            lam_rows.append([
                date, name, _r(l), _r(a), _r(b), hex_value,
                wol, _text(record.get("Batch")),
                product, _text(record.get("Description")),
                _text(record.get("Raw_item")), sample_type,
            ])
            if product:
                acc = lamprod_acc[product]
                if sample_type == LAMINATE_MASTER:
                    # The master plate feeds the Product's reference colour.
                    acc["masters"] += 1
                    if name:
                        acc["names"].add(name)
                    if None not in (l, a, b):
                        acc["ml"] += l
                        acc["ma"] += a
                        acc["mb"] += b
                        acc["mn"] += 1
                else:
                    # Only the samples are scored (and counted) in the tab.
                    acc["samples"] += 1
                    if wol:
                        acc["wol"].add(wol)
                    if None not in (l, a, b):
                        acc["sl"] += l
                        acc["sa"] += a
                        acc["sb"] += b
                        acc["sn"] += 1

    # LD_item reference colours (mean of the item's LD replicates).
    items = []
    for item in sorted(ld_acc):
        n, sum_l, sum_a, sum_b = ld_acc[item]
        mean_l, mean_a, mean_b = (round(sum_l / n, ROUND_DP),
                                  round(sum_a / n, ROUND_DP),
                                  round(sum_b / n, ROUND_DP))
        # index 6 is a placeholder — the page fills it with the matched-Raw
        # count at runtime; index 7 lists the item's distinct LD sample NAMEs.
        ld_names = sorted({r[1] for r in ld_samples[item] if r[1]})
        items.append([item, n, mean_l, mean_a, mean_b,
                      lab_to_hex(mean_l, mean_a, mean_b), 0,
                      ", ".join(ld_names)])

    # Raw rows join to LD_items on the item code. The join is case-insensitive
    # (codes are uppercase, but one stray lowercase letter must not silently
    # drop a whole item from the analysis); rows group under the LD_item's
    # own spelling. Anything that matches no LD_item feeds the "Unmatched
    # Raw" heat map instead of being thrown away.
    known_map = {}
    for it in items:
        known_map.setdefault(it[0].upper(), it[0])

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

    # One row per Product seen on a laminate master plate. The reference colour
    # is the mean of that Product's master plates; a Product with no master Lab
    # falls back to the mean of its own samples (hex '' when neither exists).
    lamprod = []
    for product in sorted(lamprod_acc):
        acc = lamprod_acc[product]
        n, sum_l, sum_a, sum_b = (acc["mn"], acc["ml"], acc["ma"], acc["mb"])
        if not n:
            n, sum_l, sum_a, sum_b = (acc["sn"], acc["sl"], acc["sa"], acc["sb"])
        if n:
            mean_l = round(sum_l / n, ROUND_DP)
            mean_a = round(sum_a / n, ROUND_DP)
            mean_b = round(sum_b / n, ROUND_DP)
            hex_out = lab_to_hex(mean_l, mean_a, mean_b)
        else:
            mean_l = mean_a = mean_b = None
            hex_out = ""
        lamprod.append([product, len(acc["wol"]), mean_l, mean_a, mean_b,
                        hex_out, acc["samples"], acc["masters"],
                        ", ".join(sorted(acc["names"]))])

    # Laminate rows that name no Product cannot be grouped under one, so they
    # are listed separately by the page's "Unmatched Laminate" dialog.
    unmatched_lam = sum(1 for r in lam_rows if not r[8])

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
            "lamprod": len(lamprod),
            "unmatched_lam": unmatched_lam,
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
        "lamprod": lamprod,
        "export_cols": ["DATE", "NAME", "L", "a", "b", "Hex", "Batch",
                        "LD_item", "Raw_item", "WOL", "Product",
                        "Description", "Sample_type"],
        "export": export_rows,
        "lam_export_cols": ["DATE", "NAME", "L", "a", "b", "Hex", "WOL",
                            "Batch", "Product", "Description", "Raw_item",
                            "Sample_type"],
        "lam_export": lam_rows,
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
.ctlbtn{flex:0 0 auto;min-height:48px;padding:9px 14px;border:1px solid var(--line);
        border-radius:8px;background:#fff;color:var(--brand);font-size:13px;
        font-weight:600;cursor:pointer}
.ctlbtn:hover{background:#eef2f7}
.sw-lg{display:inline-block;width:48px;height:28px;border-radius:6px;
       vertical-align:middle}
.itemlink{color:var(--brand);font-weight:600;text-decoration:underline;cursor:pointer;
          display:inline-block;padding:16px 8px;margin:-16px -8px}
.inl{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
/* Reference dropdown: long LD_item / Product labels must not blow out the
   control row on narrow screens. */
#refWrap{max-width:100%;min-width:0}
#refSel{flex:0 1 auto;min-width:0;max-width:100%}
#cmpBaseline{width:92px}
#cmpTable td.de,#cmpTable td.red{font-family:ui-monospace,Consolas,monospace}
#cmpTable td.gid{font-family:ui-monospace,Consolas,monospace;color:var(--brand);
                 font-weight:600}
#cmpTable td.gitems{white-space:normal;max-width:380px}
#cmpTable tbody tr{cursor:pointer}
#cmpTable tbody tr:hover{background:#eef2f7}
#cmpTable tbody tr.gdet,#cmpTable tbody tr.gdet:hover{background:#f7f9fc;
                                                      cursor:default}
/* Expanded member list: one tappable chip per redundant LD_item — the
   representative is named in the hint instead of repeating itself at ΔE 0.00 —
   each chip showing its ΔE CMC(2:1) to the group representative. */
.gdet .ghint{color:var(--muted);font-size:12px;margin:2px 0 8px}
.gmembers{display:flex;flex-wrap:wrap;gap:6px}
.gmem{display:inline-flex;align-items:center;gap:6px;min-height:48px;
      padding:6px 12px;border:1px solid var(--line);border-radius:999px;
      background:#fff;font:inherit;font-size:12px;color:inherit;cursor:pointer}
.gmem:hover,.gmem:active{background:#eef2f7}
.gmem .sw{width:16px;height:16px;border-radius:4px}
.gmemid{font-family:ui-monospace,Consolas,monospace;font-weight:600}
.gmemde{color:var(--muted);font-size:11px}
.gmore{color:var(--muted);font-size:11px}
/* Overall: one row per textile — its LD_item count, its groups of repeated
   colour and how many of those items are redundant. */
#cmpOverallTable td.tl{font-family:ui-monospace,Consolas,monospace;
                       color:var(--brand);font-weight:600}
#cmpOverallTable td.red{font-family:ui-monospace,Consolas,monospace}
#cmpOverallTable td.pct{font-family:ui-monospace,Consolas,monospace;color:var(--muted)}
/* "About this view" button in the LD Redundancy control row — opens the help
   popup that replaced the long explanatory paragraph. */
.infobtn{display:inline-flex;align-items:center;gap:8px;min-height:48px;
         padding:9px 14px;border:1px solid var(--line);border-radius:8px;
         background:#fff;color:var(--brand);font:inherit;font-size:13px;
         font-weight:600;cursor:pointer}
.infobtn:hover,.infobtn:active{background:#eef2f7}
.infobtn-i{display:inline-flex;align-items:center;justify-content:center;
           width:20px;height:20px;border-radius:50%;background:var(--brand);
           color:#fff;font:italic 700 12px/1 Georgia,serif}
@media(max-width:767px){
  .infobtn{padding:0;width:48px;justify-content:center}
  .infobtn .infobtn-txt{display:none}
}
.helpbody{max-width:780px;font-size:13px;line-height:1.65;color:#3c4653}
.helpbody h3{font-size:13px;color:var(--brand);margin:18px 0 4px}
.helpbody h3:first-child{margin-top:0}
.helpbody p{margin:0 0 8px}
.helpbody ul{margin:0 0 8px;padding-left:20px}
.helpbody li{margin:0 0 5px}
.helpbody b{color:#26313f}
.helpbody code{font-family:ui-monospace,Consolas,monospace;background:#eef2f7;
               border-radius:4px;padding:1px 5px}
/* The help sheet is a centred popup, not the usual full-screen sheet. */
#cmpHelpModal{z-index:65;align-items:center;justify-content:center;padding:16px}
#cmpHelpModal .modal-box{min-height:0;width:min(720px,100%);max-height:100%;
                         overflow:auto;border-radius:12px;
                         scrollbar-width:none}
#cmpHelpModal .modal-box::-webkit-scrollbar{display:none}
/* Overall | Groups | Matrix | Color segmented toggle in the LD Redundancy tab. */
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;
     overflow:hidden}
.segbtn{min-height:48px;padding:0 16px;border:0;background:#fff;font:inherit;
        font-size:13px;color:inherit;cursor:pointer}
.segbtn+.segbtn{border-left:1px solid var(--line)}
.segbtn:hover{background:#eef2f7}
.segbtn.on{background:var(--brand);color:#fff;font-weight:600}
/* Redundancy matrix: a real table, the LD_item across the top and down the
   side and the pair's Delta E printed in the cells below the diagonal — the
   half above it is left as a pale blank, since it would only repeat the half
   below. The header row and the LD_item column are sticky, so the labels stay
   put while the grid scrolls either way. Row height is fixed at 20px of line
   box plus the 1px rule below it — the window maths in mxWindow() assumes
   exactly that. */
.mxwrap{overflow:auto;max-width:100%;max-height:min(72vh,720px);
        border:1px solid var(--line);border-radius:10px;background:var(--card)}
.mxtb{border-collapse:separate;border-spacing:0;
      font:11px/20px ui-monospace,Consolas,monospace;color:#3c4653}
.mxtb th,.mxtb td{padding:0 6px;border-right:1px solid var(--line);
                  border-bottom:1px solid var(--line);white-space:nowrap;
                  font-weight:400;text-align:left}
.mxtb thead th{position:sticky;top:0;z-index:2;background:#eef2f7;
               font-weight:600}
.mxtb thead th:first-child{left:0;z-index:3;background:#e3e9f0}
.mxtb tbody th{position:sticky;left:0;z-index:1;background:#eef2f7;
               font-weight:600}
.mxtb td.hot{background:#c0392b;color:#fff}
.mxtb td.self{background:#cfe2f3}
.mxtb td.up{background:#f6f8fb}
.mxtb tr.sp td{padding:0;border:0}
.mxtip{position:fixed;z-index:60;pointer-events:none;background:#1f2937;color:#fff;
       font-size:12px;line-height:1.4;padding:6px 9px;border-radius:6px;
       max-width:280px;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.mxtip .tmono{font-family:ui-monospace,Consolas,monospace;color:#9ecbff}
.mxlegend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;
          color:var(--muted);font-size:12px;margin:10px 0 0}
.mxsw{display:inline-block;width:14px;height:14px;border-radius:3px;
      border:1px solid var(--line);vertical-align:-2px;margin-right:5px}
.mxsw-on{background:#c0392b}
.mxsw-off{background:#fff}
.mxsw-self{background:#cfe2f3}
.mxsw-up{background:#f6f8fb}
/* Colour picker: one card per LD_item of the textile, in a grid that reflows
   with the viewport. auto-fill keeps the cards a comfortable thumb size on a
   phone (never below the 48px touch target) and lets them grow on a desktop. */
.cgwrap{overflow:auto;max-width:100%;max-height:min(72vh,720px);
        border:1px solid var(--line);border-radius:10px;background:var(--card);
        padding:10px}
.cggrid{display:grid;gap:8px;
        grid-template-columns:repeat(auto-fill,minmax(91px,1fr))}
.cgcard{display:flex;flex-direction:column;gap:4px;min-height:58px;padding:6px;
        border:1px solid var(--line);border-radius:8px;background:#fff;
        font:inherit;cursor:pointer;text-align:center}
.cgcard:hover,.cgcard:active{background:#eef2f7}
.cgcard .cgchip{display:block;width:100%;min-height:53px;border-radius:6px;
                border:1px solid rgba(0,0,0,.08)}
.cgcard .cgid{font:11px/1.3 ui-monospace,Consolas,monospace;color:#3c4653;
              word-break:break-all}
.cgcard .cgflag{font-size:10px;font-weight:700;min-height:12px;color:var(--muted)}
.cgcard.ref{border-color:var(--brand);box-shadow:0 0 0 2px var(--brand);
            background:#e8f0fa}
.cgcard.ref .cgid,.cgcard.ref .cgflag{color:var(--brand)}
.cgcard.pick{border-color:#c0392b;box-shadow:0 0 0 2px #c0392b}
.cgcard.pick .cgflag{color:#c0392b}
.cgsw{display:inline-block;width:14px;height:14px;border-radius:3px;
      border:1px solid var(--line);vertical-align:-2px;margin-right:5px}
.cgsw-ref{background:#fff;box-shadow:0 0 0 2px var(--brand)}
.cgsw-pick{background:#fff;box-shadow:0 0 0 2px #c0392b}
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
.paircard .big{display:block;width:100%;aspect-ratio:1/1;border-radius:8px}
.paircard .pname{font-weight:600;margin:8px 0 0;word-break:break-all}
.pairdelta{font-size:14px;font-weight:600;margin:8px 0}
.pairdelta.lo{color:#1d7a34}
.pairdelta.hi{color:#c0392b}
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
    vertical-align:middle}
.hex{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#334}
.ptid{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#334;
      white-space:nowrap;cursor:help}
.ptid .ptde{color:#8891a5;font-size:10px}
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
.stat .s{font-size:12px;color:var(--muted);margin-top:2px}
/* Stats-tab headline cards read as a KPI strip, so they run taller and larger
   than the same .stat cards reused inside the item-detail modal. */
#statsTop .stat{padding:12px 14px;min-height:110px;display:flex;flex-direction:column;
                justify-content:center}
#statsTop .stat .k{font-size:13px}
#statsTop .stat .v{font-size:28px;line-height:1.15}
#statsTop .stat .s{font-size:13px;margin-top:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px;margin-bottom:10px}
.card-title{font-size:13px;font-weight:600;color:var(--brand);margin:2px 4px 6px}
#itemChart{width:100%;height:300px}
/* Square container: symmetric Δa/Δb axes + square box keep the tolerance
   circle round on every screen width. The per-channel distribution chart sits
   beside it and wraps below on narrow screens. */
.ab-row{display:flex;gap:14px;align-items:flex-start;justify-content:center;flex-wrap:wrap}
#abChart{flex:0 1 420px;width:100%;max-width:420px;aspect-ratio:1/1}
#distChart{flex:0 1 420px;width:100%;max-width:420px;height:420px}
#abToggles{display:flex;gap:8px;margin:0 4px 8px}
#abToggles button{flex:1;min-height:48px;padding:8px 10px;border:1px solid #d0d5dd;
  border-radius:7px;background:#fff;font-weight:600;font-size:13px;color:#344054;cursor:pointer}
#abToggles button.active{background:#344054;color:#fff;border-color:#344054}
.chart-grid{display:grid;gap:10px;grid-template-columns:1fr}
.chart{width:100%;height:300px}
.card-title .tnote{font-weight:400;color:var(--muted);font-size:11px;margin-left:6px}
@media(min-width:1024px){
  .chart-grid{grid-template-columns:1fr 1fr}
  .chart-grid .wide{grid-column:1/-1}
}
.modal{display:none;position:fixed;inset:0;z-index:50;overflow:auto;background:rgba(10,18,28,.55)}
/* The item detail modal sits above the list dialogs it can be opened from. */
#modal{z-index:60}
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
  .tabs .ctlbtn{min-height:40px}
  .sub{font-size:12px}
  main{padding:14px}
  #itemChart{height:360px}
  #abChart,#distChart{flex-basis:480px;max-width:480px}
  #distChart{height:480px}
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
    <button class="tab" data-view="map" role="tab">Raw</button>
    <button class="tab" data-view="lam" role="tab">Laminate</button>
    <button class="tab" data-view="cmp" role="tab">LD Redundancy</button>
    <button class="tab" data-view="pt" role="tab">Match Pantone</button>
  </div>
</header>

<main>
  <section id="v-stats" class="view active">
    <div class="stats" id="statsTop"></div>
    <p class="hint">Overview of the loaded Color_Data extract. The category
      charts show the top 50 only, with a cumulative-% line measured against
      the whole population; wheel or pinch inside a chart to zoom its x-axis.</p>
    <div class="chart-grid">
      <div class="card">
        <div class="card-title">Samples by Sample_type<span class="tnote" id="tNoteType"></span></div>
        <div id="chType" class="chart"></div>
      </div>
      <div class="card">
        <div class="card-title">LD_item count by textile<span class="tnote" id="tNoteLd"></span></div>
        <div id="chLd" class="chart"></div>
      </div>
      <div class="card">
        <div class="card-title">Raw batches by Raw_item<span class="tnote" id="tNoteBatch"></span></div>
        <div id="chBatch" class="chart"></div>
      </div>
      <div class="card">
        <div class="card-title">Laminate samples by Product<span class="tnote" id="tNoteLp"></span></div>
        <div id="chLamProd" class="chart"></div>
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
      <input id="mSearch" type="search" placeholder="Search LD_item or Pantone ID…">
      <button id="mUN" type="button" class="ctlbtn">Unmatched Raw</button>
      <button id="mXLS" type="button" class="ctlbtn"
        title="Download every LD and Raw sample row as an Excel workbook">Export LD/Raw</button>
      <span class="count" id="mCount"></span>
    </div>
    <div class="table-wrap">
      <table id="mTable">
        <thead><tr>
          <th>Colour</th>
          <th class="sortable" data-c="0">LD_item</th>
          <th class="sortable" data-c="7">NAME</th>
          <th class="sortable" data-c="1">LD samples</th>
          <th class="sortable" data-c="6">Matched Raw</th>
          <th class="sortable" data-c="2">L*</th>
          <th class="sortable" data-c="3">a*</th>
          <th class="sortable" data-c="4">b*</th>
          <th class="sortable" data-c="5">Nearest Pantone</th>
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

  <section id="v-lam" class="view">
    <p class="hint">One row per laminate-master Product (Sample_type='Laminate
      Master', a B##-prefixed NAME), coloured by the mean colour of that
      Product's master plates. WOL counts the distinct WOLs measured under the
      Product, Laminate samples the sample rows. Select a Product to score its
      laminate samples against the master-plate mean colour (spec 1.0).</p>
    <div class="controls">
      <input id="lSearch" type="search" placeholder="Search Product or Pantone ID…">
      <button id="lUN" type="button" class="ctlbtn">Unmatched Laminate</button>
      <button id="lXL" type="button" class="ctlbtn"
        title="Download every Laminate Master and Laminate Sample row as an Excel workbook">Export Laminate</button>
      <span class="count" id="lCount"></span>
    </div>
    <div class="table-wrap">
      <table id="lTable">
        <thead><tr>
          <th>Colour</th>
          <th class="sortable" data-c="0">Product</th>
          <th class="sortable" data-c="8">NAME</th>
          <th class="sortable" data-c="1">WOL</th>
          <th class="sortable" data-c="6">Laminate samples</th>
          <th class="sortable" data-c="2">L*</th>
          <th class="sortable" data-c="3">a*</th>
          <th class="sortable" data-c="4">b*</th>
          <th class="sortable" data-c="5">Nearest Pantone</th>
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
    <div class="controls">
      <div class="seg" id="cmpViews" role="tablist" aria-label="View">
        <button type="button" class="segbtn on" data-v="o" role="tab">Overall</button>
        <button type="button" class="segbtn" data-v="g" role="tab">Groups</button>
        <button type="button" class="segbtn" data-v="m" role="tab">Matrix</button>
        <button type="button" class="segbtn" data-v="c" role="tab">Color</button>
      </div>
      <select id="cmpTextile" aria-label="Textile"></select>
      <label class="inl">Group &#916;E
        <input id="cmpBaseline" type="number" step="0.1" min="0" value="1.0"></label>
      <button id="cmpExport" type="button" class="ctlbtn">Export redundant CSV</button>
      <button type="button" class="infobtn" id="cmpHelp"
              aria-haspopup="dialog"
              title="About LD Redundancy and how grouping works">
        <span class="infobtn-i" aria-hidden="true">i</span><span class="infobtn-txt">About this view</span>
      </button>
    </div>
    <div id="cmpOverallPane">
      <p class="count" id="cmpOverallSummary"></p>
      <div class="table-wrap">
        <table id="cmpOverallTable">
          <thead><tr>
            <th class="sortable" data-c="0">Textile</th>
            <th class="sortable" data-c="1">LD_items</th>
            <th class="sortable" data-c="2">Groups</th>
            <th class="sortable" data-c="3">Redundant</th>
            <th class="sortable" data-c="4">Redundancy %</th>
          </tr></thead>
          <tbody id="cmpOverallBody"></tbody>
        </table>
      </div>
    </div>
    <div id="cmpGroupsPane" hidden>
      <p class="count" id="cmpSummary"></p>
      <div class="table-wrap">
        <table id="cmpTable">
          <thead><tr>
            <th>Colour</th>
            <th class="sortable" data-c="0">Group</th>
            <th class="sortable" data-c="1">Items</th>
            <th>LD_items</th>
            <th class="sortable" data-c="3">Intra-group &#916;E</th>
            <th class="sortable" data-c="2">Redundant</th>
          </tr></thead>
          <tbody id="cmpBody"></tbody>
        </table>
      </div>
      <div class="pager">
        <button id="cmpPrev">&#8592; Prev</button>
        <button id="cmpNext">Next &#8594;</button>
        <span class="pinfo" id="cmpInfo"></span>
      </div>
    </div>
    <div id="cmpMatrixPane" hidden>
      <p class="count" id="cmpMatrixSummary"></p>
      <div class="mxwrap" id="mxWrap">
        <table class="mxtb" id="mxTable">
          <thead><tr id="mxHead"></tr></thead>
          <tbody id="mxBody"></tbody>
        </table>
      </div>
      <p class="empty" id="cmpMatrixEmpty" hidden></p>
      <p class="mxlegend">
        <span><span class="mxsw mxsw-on"></span>redundant (&#916;E &#8804; threshold)</span>
        <span><span class="mxsw mxsw-off"></span>above threshold</span>
        <span><span class="mxsw mxsw-self"></span>same item</span>
        <span><span class="mxsw mxsw-up"></span>not measured &#8212; mirror of the half below</span>
      </p>
    </div>
    <div id="cmpColorPane" hidden>
      <p class="count" id="cmpColorSummary"></p>
      <div class="cgwrap" id="cmpColorWrap">
        <div class="cggrid" id="cmpColorGrid"></div>
      </div>
      <p class="mxlegend">
        <span><span class="cgsw cgsw-ref"></span>reference &#8212; the first card you pick</span>
        <span><span class="cgsw cgsw-pick"></span>second card &#8212; compared against the reference</span>
      </p>
    </div>
    <div class="mxtip" id="cmpTip" hidden></div>
  </section>

  <section id="v-pt" class="view">
    <p class="hint">Match a Pantone TCX colour to your measured textiles. Pick a
      colour in Step&nbsp;1 (filter by lightness group, search by ID/name, or
      page through 100 colours at a time), narrow Step&nbsp;2 to a face textile
      (Gore item is the first 4 characters of the LD_item), and set a
      &Delta;E CMC(2:1) threshold limit in Step&nbsp;3 (default 1.0). The output
      reports the nearest item by CMC(2:1): the nearest LD_item when the
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
          <label class="pt-label" for="ptThr">&Delta;E CMC(2:1) threshold</label>
          <input id="ptThr" type="number" min="0" step="0.1" value="1.0" inputmode="decimal">
          <p class="pt-note">Nearest item wins when its &Delta;E CMC(2:1) is within this limit.</p>
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
        <div class="ab-row">
          <div id="abChart"></div>
          <div id="distChart"></div>
        </div>
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

<div class="modal" id="cmpHelpModal">
  <div class="modal-box">
    <div class="modal-head">
      <h2>LD Redundancy Check &mdash; how grouping works</h2>
      <button class="close" id="cmpHelpClose" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <div class="helpbody">
        <p>This tool finds <b>redundant colour specifications</b>: LD_items inside
          one textile whose mean measured colour is the same &mdash; within a
          tolerance you set &mdash; so a colour is specified more than once.</p>

        <h3>What is an LD_item?</h3>
        <p>An <b>LD_item</b> is a colour specification, identified by the first
          four characters of the LD_item code. Many <i>samples</i> can be
          measured for one LD_item; each LD_item is reduced to a single mean
          L*a*b* colour before comparison. <b>Items, not individual samples, are
          compared</b>, so two samples of the same item are never counted as a
          group.</p>

        <h3>What &ldquo;grouping&rdquo; means</h3>
        <p>Grouping clusters the LD_items of one textile so that items of the
          same colour fall into the same group. It uses <b>complete-linkage</b>
          clustering on the &#916;E CMC(2:1) colour difference:</p>
        <ul>
          <li>A group only forms when <b>every cross-pair</b> between its members
            stays within the group &#916;E threshold &mdash; not merely
            neighbours in a chain.</li>
          <li>So a group is a set of items that are <b>all mutually alike</b>.
            Two distinct colours cannot be chained together through a run of
            small steps, so a group is never a false merge.</li>
          <li>Each group has one <b>representative</b> &mdash; its medoid, the
            member closest to all the others. Every other member is a
            <b>redundant</b> repeat of that colour.</li>
        </ul>
        <p>A group of <code>n</code> items therefore contributes
          <code>n&minus;1</code> redundant items: one specification is needed,
          and the other <code>n&minus;1</code> repeat a colour already specified.</p>

        <h3>The group &#916;E threshold</h3>
        <p>The <b>Group &#916;E</b> box sets the tolerance. Raising it pulls more
          items into a group (more redundant); lowering it splits groups apart.
          Changing it only re-clusters &mdash; the cached pairwise distances are
          reused.</p>

        <h3>The colour difference &#916;E CMC(2:1)</h3>
        <p>Every comparison uses the CMC(2:1) colour-difference formula on the
          items' mean L*a*b* values. Its default weights
          (<code>l=2, c=1</code>) count lightness differences less than chroma,
          matching how textile colours are usually judged.</p>

        <h3>The Overall table</h3>
        <p>One row per textile: its LD_item count, the number of groups of
          repeated colour at the current threshold, and how many of its items are
          redundant. <b>Redundancy %</b> is the redundant items as a share of
          that textile's LD_items &mdash; higher means more duplicated
          specification. Click any column heading to sort; the table opens sorted
          by redundant count, highest first. Pick a textile name to jump to its
          Groups view.</p>

        <h3>The four views</h3>
        <ul>
          <li><b>Overall</b> &mdash; every textile in one sortable table, with the
            totals across the whole dataset above it. The view the modal opens on.</li>
          <li><b>Groups</b> &mdash; one row per group of repeated colour for the
            selected textile. Click a row to list its members and compare any of
            them against the group representative.</li>
          <li><b>Matrix</b> &mdash; the same groups as a square table: LD_item
            across the top and down the side, the pair's &#916;E printed below the
            diagonal (red when the pair is redundant), so each group shows up as
            a solid block on the diagonal. The half above the diagonal is blank,
            since it would only repeat the half below.</li>
          <li><b>Color</b> &mdash; every LD_item of the textile as a colour card;
            tap one to set the reference, then a second to open the side-by-side
            comparison.</li>
        </ul>
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

<div class="modal" id="unModal">
  <div class="modal-box">
    <div class="modal-head">
      <h2>Unmatched Raw</h2>
      <button class="close" id="unClose" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
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
    </div>
  </div>
</div>

<div class="modal" id="unlamModal">
  <div class="modal-box">
    <div class="modal-head">
      <h2>Unmatched Laminate</h2>
      <button class="close" id="unlamClose" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <p class="hint">Laminate rows that carry no Product, so the Laminate grid
        has no Product to group them under. Listed newest first.</p>
      <div class="controls">
        <input id="nlSearch" type="search" placeholder="Search NAME, WOL, batch, Raw_item…">
        <span class="count" id="nlCount"></span>
      </div>
      <div class="table-wrap">
        <table id="nlTable">
          <thead><tr>
            <th>Colour</th>
            <th class="sortable" data-c="0">Date</th>
            <th class="sortable" data-c="1">NAME</th>
            <th class="sortable" data-c="6">WOL</th>
            <th class="sortable" data-c="7">Batch</th>
            <th class="sortable" data-c="11">Sample_type</th>
            <th class="sortable" data-c="9">Description</th>
            <th class="sortable" data-c="10">Raw_item</th>
            <th class="sortable" data-c="2">L*</th>
            <th class="sortable" data-c="3">a*</th>
            <th class="sortable" data-c="4">b*</th>
            <th class="sortable" data-c="5">Hex</th>
          </tr></thead>
          <tbody id="nlBody"></tbody>
        </table>
      </div>
      <div class="pager">
        <button id="nlPrev">&#8592; Prev</button>
        <button id="nlNext">Next &#8594;</button>
        <span class="pinfo" id="nlInfo"></span>
      </div>
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
var LAMPROD = DATA.lamprod || [];
var LD = DATA.ld || {};
var META = DATA.meta;
var RAWBATCH = DATA.rawbatch || {};
var PANTONE = @@PANTONE@@;   /* TCX library rows: [id, name, zh, hex, L, a, b] */

var PAGE = 100;

/* QC specs: a Raw sample must sit within 0.8 of its LD_item mean, a laminate
   sample within 1.0 of its Product's master-plate mean. */
var SPEC_RAW = 0.8, SPEC_LAM = 1.0;
function specFor(mode){ return mode === 'lam' ? SPEC_LAM : SPEC_RAW; }

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function hexOf(v){ var h=String(v||'').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(h) ? h : ''; }
function swatch(v){ var h=hexOf(v);
  return '<span class="sw" style="background:'+(h||'repeating-linear-gradient(45deg,#ddd,#ddd 4px,#fff 4px,#fff 8px)')+'"></span>'; }
function swatchLg(v){ var h=hexOf(v);
  return '<span class="sw-lg" style="background:'+(h||'repeating-linear-gradient(45deg,#ddd,#ddd 4px,#fff 4px,#fff 8px)')+'"></span>'; }
function num(v,d){ if(v===''||v==null||isNaN(v)) return '\u2013'; return Number(v).toFixed(d==null?2:d); }
/* Signed 2-dp value for the delta-L / delta-a / delta-b table cells ('+0.35'). */
function dnum(v){ if(v===''||v==null||isNaN(v)) return '\u2013';
  var n=Number(v); return (n>0?'+':'')+n.toFixed(2); }
function day(v){ return String(v||'').slice(0,10) || '\u2013'; }
function clock(v){ return String(v||'').slice(11,19); }

/* Delta E CMC(l:c) — default CMC(2:1). The formula is asymmetric: the first
   triplet (L1,a1,b1) is the reference / standard and the second (L2,a2,b2) is
   the sample / batch, so every caller must pass the reference colour first. */
function deltaECMC(L1,a1,b1,L2,a2,b2,l,c){
  if(l==null) l=2;   /* lightness weighting */
  if(c==null) c=1;   /* chroma weighting */

  /* Chroma of the reference and of the sample. */
  var C1=Math.sqrt(a1*a1+b1*b1), C2=Math.sqrt(a2*a2+b2*b2);

  /* Lightness and chroma weighting functions (both reference-driven). */
  var SL=L1<16 ? 0.511 : (0.040975*L1)/(1+0.01765*L1);
  var SC=(0.0638*C1)/(1+0.0131*C1)+0.638;

  /* Hue angle of the reference, in degrees. */
  var h1=Math.atan2(b1,a1)*180/Math.PI;
  if(h1<0) h1+=360;

  /* Hue-dependent T factor. */
  var T;
  if(h1>=164 && h1<=345){
    T=0.56+Math.abs(0.2*Math.cos((h1+168)*Math.PI/180));
  } else {
    T=0.36+Math.abs(0.4*Math.cos((h1+35)*Math.PI/180));
  }

  /* Chroma-dependent F factor and the hue weighting function. */
  var C1_4=Math.pow(C1,4);
  var F=Math.sqrt(C1_4/(C1_4+1900));
  var SH=SC*(F*T+1-F);

  /* Component differences. */
  var deltaL=L1-L2, deltaC=C1-C2, deltaA=a1-a2, deltaB=b1-b2;

  /* Squared hue difference; clamp tiny negatives from float rounding. */
  var deltaH2=deltaA*deltaA+deltaB*deltaB-deltaC*deltaC;
  if(deltaH2<0 && deltaH2>-1e-12) deltaH2=0;

  var termL=deltaL/(l*SL), termC=deltaC/(c*SC);
  var termH=Math.sqrt(Math.max(0,deltaH2))/SH;

  return Math.sqrt(termL*termL+termC*termC+termH*termH);
}

/* ---- nearest Pantone TCX -------------------------------------------------
   The Raw and Laminate tables name a colour by its closest Pantone TCX rather
   than its raw hex, so a mean Lab is matched against the whole library with
   Delta E CMC(2:1). The library is ~2,600 colours and both the sort comparator
   and the search filter revisit the same rows, so results are memoised per
   rounded Lab triplet: only the first visit to a given colour pays for the
   library scan, every later one is a lookup. */
var PT_CACHE = {};
function nearestPantone(L,a,b){
  /* A blank cell arrives as '' (as well as null / NaN), and Number('') is 0 —
     which would silently match near-black, so screen the blanks out first. */
  if(!PANTONE.length || L==null||a==null||b==null||L===''||a===''||b==='')
    return null;
  L=Number(L); a=Number(a); b=Number(b);
  if(!isFinite(L)||!isFinite(a)||!isFinite(b)) return null;
  var key = L.toFixed(2)+'|'+a.toFixed(2)+'|'+b.toFixed(2);
  if(PT_CACHE[key] !== undefined) return PT_CACHE[key];
  var best=null, bd=Infinity;
  for(var i=0;i<PANTONE.length;i++){
    var r=PANTONE[i];
    /* CMC is asymmetric: the Pantone standard is the reference, the measured
       mean Lab the sample, so the library colour is passed first. */
    var d=deltaECMC(Number(r[4]),Number(r[5]),Number(r[6]),L,a,b);
    if(d<bd){ bd=d;
      best={id:String(r[0]),name:String(r[1]),zh:String(r[2]),
            hex:String(r[3]),de:d}; }
  }
  PT_CACHE[key]=best;
  return best;
}
function pantoneId(L,a,b){
  var p=nearestPantone(L,a,b);
  return p ? p.id : '';
}
/* Last-column cell: the closest Pantone TCX ID followed by the ΔE CMC(2:1)
   between it and the measured colour — "18-1030 (2.13)". The Pantone library
   colour is the reference in that calculation (see nearestPantone above). The
   tooltip carries the colour's own name. Falls back to the raw hex when there
   is no Lab to match (or when the Pantone library was unavailable). */
function pantoneTd(L,a,b,rawHex){
  var hex=hexOf(rawHex);
  var p=nearestPantone(L,a,b);
  if(!p) return '<td class="hex">'+esc(hex||'\u2013')+'</td>';
  return '<td class="ptid" title="'
    +esc(p.id+' \u00b7 '+p.name+(p.zh?' / '+p.zh:'')
        +' \u00b7 \u0394E CMC(2:1) '+p.de.toFixed(2))+'">'
    +esc(p.id)+' <span class="ptde">('+p.de.toFixed(2)+')</span></td>';
}

/* ---- item indexes + ΔE for every matched Raw row (one pass) ---- */
var ITEM_BY={}, UN_BY={};
ITEMS.forEach(function(it){
  ITEM_BY[it[0]]={item:it[0],n:it[1],L:it[2],a:it[3],b:it[4],hex:it[5],rows:[]};
});
/* Case-insensitive LD_item lookup: a Product's Raw_item may differ in case
   from the LD_item code, and the laminate modal's reference dropdown resolves
   the choice back to the item's mean colour through this map. */
var LD_CI={};
ITEMS.forEach(function(it){ LD_CI[it[0].toUpperCase()]=ITEM_BY[it[0]]; });
UNITEMS.forEach(function(it){
  UN_BY[it[0]]={item:it[0],n:it[1],L:it[2],a:it[3],b:it[4],hex:it[5],rows:[]};
});
Object.keys(RAW).forEach(function(item){
  var ref=ITEM_BY[item]; if(!ref) return;
  RAW[item].forEach(function(r){
    ref.rows.push(r);            // listed by the item's detail modal
    if(r[2]===''||r[3]===''||r[4]===''){ r[7]=''; return; }
    r[7]=Math.round(deltaECMC(ref.L,ref.a,ref.b,r[2],r[3],r[4])*1000)/1000;
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

/* ---- laminate Products ----
   Payload row: [Product, WOL count, mean L*, a*, b*, hex, laminate samples,
   master plates] — the LD-heat-map index convention (0 name, 1 count, 2/3/4
   Lab, 5 hex, 6 count) so the shared table factory works unchanged. The
   reference colour is the Product's master-plate mean; LAM rows carry the
   Product at index 8 and the Sample_type at index 11, so the modal lists
   exactly the product's laminate sample rows (index 12 stays free for the
   client-side ΔE). */
var LAMPROD_BY={};
LAMPROD.forEach(function(it){
  LAMPROD_BY[it[0]]={item:it[0],name:it[0],wol:it[1],L:it[2],a:it[3],b:it[4],
    hex:it[5],n:it[6],masters:it[7],rows:[],raw:[]};
});
LAM.forEach(function(r){
  var ref=LAMPROD_BY[r[8]];
  if(!ref) return;
  /* The Product's Raw_item(s) — on both master and sample rows — feed the
     modal's "Raw" reference choices. */
  if(r[10] && ref.raw.indexOf(r[10])<0) ref.raw.push(r[10]);
  if(r[11]==='Laminate Sample') ref.rows.push(r);
});
/* Laminate rows with no Product: no master plate or sample can be grouped, so
   the Laminate grid drops them. The Unmatched Laminate dialog lists them. */
var UNLAM=LAM.filter(function(r){ return !r[8]; });

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
  /* The matrix sizes its row window to the scroll frame, which has no height
     while the view is hidden — re-measure once the LD Redundancy tab is up. */
  if(name==='cmp'&&cmpView==='m') mxWindow(true);
}
Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){
  b.addEventListener('click',function(){ showView(b.getAttribute('data-view')); });
});

/* ---- tabs 1 & 2: LD item and unmatched Raw item tables ----
   Same searchable / sortable / paginated table pattern as the Laminate tab.
   Item row layout (LD): 0 LD_item, 7 NAME, 1 LD samples, 6 Matched Raw,
                         2 L*, 3 a*, 4 b*, 5 Pantone (closest TCX to 2/3/4),
                         rendered as "18-1030 (2.13)".
   Item row layout (Un): 0 Raw_item, 1 Raw samples, 2 L*, 3 a*, 4 b*, 5 Hex. */
function ldRowHtml(it){
  var hex=hexOf(it[5]);
  return '<tr>'
    +'<td>'+swatchLg(hex)+'</td>'
    +'<td><a href="#" class="itemlink" data-mode="ld" data-item="'+esc(it[0])+'">'+esc(it[0])+'</a></td>'
    +'<td class="wrapcell">'+esc(it[7]||'\u2013')+'</td>'
    +'<td>'+it[1].toLocaleString()+'</td>'
    +'<td>'+it[6].toLocaleString()+'</td>'
    +'<td>'+num(it[2])+'</td><td>'+num(it[3])+'</td><td>'+num(it[4])+'</td>'
    +pantoneTd(it[2],it[3],it[4],it[5])
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
  /* An optional initial sort ({col, dir}) so a table can open on its most
     interesting column instead of the payload's arbitrary order. */
  if(o.sort){ col=o.sort.col; dir=o.sort.dir||1; }
  function applyFilter(){
    var q=(document.getElementById(o.search).value||'').trim().toLowerCase();
    var hexQuery=/^#?[0-9a-f]{6}$/.test(q) ? (q.charAt(0)==='#'?q:'#'+q) : '';
    rows=o.items.filter(function(it){
      if(!q) return true;
      if(hexQuery && hexOf(it[5])===hexQuery) return true;
      /* The trailing column shows a Pantone ID, not the hex, so a Pantone ID
         query has to be matched against the nearest-TCX lookup. */
      if(o.pantone && pantoneId(it[2],it[3],it[4]).toLowerCase().indexOf(q)!==-1)
        return true;
      var key=o.searchKey ? String(o.searchKey(it)) : it[0];
      return key.toLowerCase().indexOf(q)!==-1;
    });
    if(col>=0){
      var c=col,d=dir;
      rows=rows.slice().sort(function(x,y){
        /* o.sortVal lets a column sort on something other than the raw payload
           cell — used by the Pantone column, which is derived, not stored. */
        var va=o.sortVal?o.sortVal(x,c):x[c], vb=o.sortVal?o.sortVal(y,c):y[c];
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
  /* Reflect the initial sort on its header so the default ordering is visible
     and the next click on that header still just toggles the direction. */
  if(col>=0){
    var th0=document.querySelector('#'+o.table+' th.sortable[data-c="'+col+'"]');
    if(th0){
      var sp0=document.createElement('span'); sp0.className='arrow';
      sp0.textContent=(dir===1?'\u25B2':'\u25BC'); th0.appendChild(sp0);
    }
  }
  refresh();
}
/* Column 5 is a derived Pantone ID rather than a stored payload cell, so the
   sortable column 5 needs an accessor that resolves it the same way the cell
   renders it (mean Lab at 2/3/4). */
function ptSortVal(row,c){ return c===5 ? pantoneId(row[2],row[3],row[4]) : row[c]; }
setupItemTable({mode:'ld',items:ITEMS,plural:'LD items',table:'mTable',body:'mBody',
  search:'mSearch',count:'mCount',prev:'mPrev',next:'mNext',info:'mInfo',
  rowHtml:ldRowHtml,sort:{col:6,dir:-1},pantone:true,sortVal:ptSortVal});
setupItemTable({mode:'un',items:UNITEMS,plural:'unmatched Raw items',table:'uTable',body:'uBody',
  search:'uSearch',count:'uCount',prev:'uPrev',next:'uNext',info:'uInfo',
  rowHtml:unRowHtml});

/* ---- tab 3: laminate Products ----
   One row per laminate-master Product, mirroring the Raw tab: the Product
   link opens the detail modal (mode 'lam') that scores the Product's laminate
   samples against the mean colour of its master plates (spec 1.0). Item row
   layout: 0 Product, 8 NAME (the master plates), 1 WOL, 6 Laminate samples,
   2 L*, 3 a*, 4 b*, 5 Pantone (closest TCX to 2/3/4), as "18-1030 (2.13)". */
function lamRowHtml(it){
  var hex=hexOf(it[5]);
  return '<tr>'
    +'<td>'+swatchLg(hex)+'</td>'
    +'<td><a href="#" class="itemlink" data-mode="lam" data-item="'+esc(it[0])
    +'">'+esc(it[0])+'</a></td>'
    +'<td class="wrapcell">'+esc(it[8]||'\u2013')+'</td>'
    +'<td>'+it[1].toLocaleString()+'</td>'
    +'<td>'+it[6].toLocaleString()+'</td>'
    +'<td>'+num(it[2])+'</td><td>'+num(it[3])+'</td><td>'+num(it[4])+'</td>'
    +pantoneTd(it[2],it[3],it[4],it[5])
    +'</tr>';
}
setupItemTable({mode:'lam',items:LAMPROD,plural:'laminate Products',
  table:'lTable',body:'lBody',search:'lSearch',count:'lCount',prev:'lPrev',
  next:'lNext',info:'lInfo',rowHtml:lamRowHtml,sort:{col:6,dir:-1},
  pantone:true,sortVal:ptSortVal});

/* Unmatched Laminate: laminate rows carrying no Product, shown as flat sample
   rows (there is no Product to group them under). Row layout matches LAM:
   0 date, 1 NAME, 2/3/4 Lab, 5 hex, 6 WOL, 7 Batch, 9 Description,
   10 Raw_item, 11 Sample_type. */
function unlamRowHtml(r){
  var hex=hexOf(r[5]);
  return '<tr>'
    +'<td>'+swatchLg(hex)+'</td>'
    +'<td>'+esc(day(r[0]))+'</td>'
    +'<td class="wrapcell">'+esc(r[1]||'\u2013')+'</td>'
    +'<td>'+esc(r[6]||'\u2013')+'</td>'
    +'<td>'+esc(r[7]||'\u2013')+'</td>'
    +'<td>'+esc(r[11]||'\u2013')+'</td>'
    +'<td class="wrapcell">'+esc(r[9]||'\u2013')+'</td>'
    +'<td>'+esc(r[10]||'\u2013')+'</td>'
    +'<td>'+num(r[2])+'</td><td>'+num(r[3])+'</td><td>'+num(r[4])+'</td>'
    +'<td class="hex">'+esc(hex||'\u2013')+'</td>'
    +'</tr>';
}
setupItemTable({mode:'unlam',items:UNLAM,plural:'unmatched laminate rows',
  table:'nlTable',body:'nlBody',search:'nlSearch',count:'nlCount',
  prev:'nlPrev',next:'nlNext',info:'nlInfo',rowHtml:unlamRowHtml,
  searchKey:function(r){
    return [r[0],r[1],r[6],r[7],r[9],r[10],r[11]].join(' ');
  }});

/* ---- tab 4: redundant LD_items within a textile ----
   A textile = the first 4 characters of the LD_item, and one textile can carry
   a thousand LD_items, many of which repeat a colour already specified. So
   this tab groups items instead of listing pairs: every LD_item is represented
   by its mean Lab (one point per item, not one per sample), all item-to-item
   Delta E CMC(2:1) distances are computed once per textile and cached, and the
   items are then clustered by complete linkage — a group only forms when EVERY
   cross-pair stays within the group threshold, so A≈B and B≈C can never chain
   A and C into one bogus group. Only groups of two or more items are listed:
   a group of 12 means 11 items repeat an existing colour. Each row names a
   representative item (the medoid — the member with the smallest worst-case
   distance to its peers) and expands to the member chips, where any member can
   be compared with the representative in the side-by-side popup. */
var CMP_BY={};   /* LD_item means by textile — also drives the detail modal's peer list */
ITEMS.forEach(function(it){
  var key=it[0].slice(0,4).toUpperCase();
  (CMP_BY[key]=CMP_BY[key]||[]).push(it);
});
function cmpDeltaE(a,b){   /* both sides are item means; a is the reference side */
  return deltaECMC(a.L,a.a,a.b,b.L,b.a,b.b);
}
/* CMC(2:1) is a tolerance metric, not a distance: the weights SL and SC come from
   the reference colour, so swapping the two sides can change the result. Every
   pair is therefore evaluated exactly once, always with the lower LD_item as the
   reference — item #8 is never re-measured against item #1 — and the grouping,
   the member chips, the CSV and the pair popup all quote that same number. */
function cmpPair(a,b){
  return a.item<=b.item ? cmpDeltaE(a,b) : cmpDeltaE(b,a);
}
function cmpBaseline(){
  var base=Number(document.getElementById('cmpBaseline').value);
  return (isNaN(base)||base<0) ? 1.0 : base;
}
function cmpRef(it){
  var names=String(it[7]==null?'':it[7]);
  return {item:it[0], names:names, name:names.split(', ')[0]||it[0],
          L:Number(it[2]), a:Number(it[3]), b:Number(it[4]), hex:it[5], n:it[1]};
}

var cmpSel=document.getElementById('cmpTextile');
Object.keys(CMP_BY).filter(function(k){ return (CMP_BY[k]||[]).length>1; })
 .sort().forEach(function(k){
  var o=document.createElement('option');
  o.value=k; o.textContent=k+' \u00b7 '+CMP_BY[k].length+' LD_items';
  cmpSel.appendChild(o);
});

/* Every candidate pair of one textile, measured once and cached. CMC(2:1) puts a
   hard floor under two colours that differ in lightness or chroma: because
       deltaE^2 = (dL/(l*SL))^2 + (dC/(c*SC))^2 + dH^2/SH^2
   and SL/SC only grow with L/C, every pair satisfies
       deltaE >= sqrt( (dL/(l*SLmax))^2 + (dC/(c*SCmax))^2 )
   where SLmax/SCmax are the widest weights this textile can produce. That bound
   is a plain Euclidean metric on the scaled coordinates u = L/(l*SLmax) and
   v = C/(c*SCmax), so bucketing the items on a grid one threshold wide and
   testing only the 3x3 neighbourhood gives a guaranteed superset of every pair
   at or below that threshold: white and black are never bucketed together, so no
   deltaE is ever spent on them, yet nothing within the threshold can be missed.
   Pairs left out are provably further apart than the cell size, which is exactly
   what lets the cluster walk still stop at the first pair above the threshold.
   n items give n(n-1)/2 pairs, never both orders of the same pair. */
var CMP_DIST={}, CMP_DIST_KEYS=[];
function cmpDist(key,t){
  var c=CMP_DIST[key];
  if(c && c.cap>=t) return c;      /* cached table is at least as fine as needed */
  var items=(CMP_BY[key]||[]).map(cmpRef);
  var n=items.length, i, j, k, C;

  /* Widest CMC weights this textile can reach -> the prefilter's scale. */
  var Lmax=0, Cmax=0;
  for(i=0;i<n;i++){
    if(items[i].L>Lmax) Lmax=items[i].L;
    C=Math.sqrt(items[i].a*items[i].a+items[i].b*items[i].b);
    if(C>Cmax) Cmax=C;
  }
  var SLmax=Math.max(0.511,(0.040975*Lmax)/(1+0.01765*Lmax));
  var SCmax=(0.0638*Cmax)/(1+0.0131*Cmax)+0.638;
  var su=1/(2*SLmax), sv=1/SCmax;  /* l=2, c=1 — deltaECMC's defaults */
  var g=Math.max(t,0.25);          /* cell width = the threshold it must serve */

  var bx=new Int32Array(n), by=new Int32Array(n);
  var cells={}, kk, bucket;
  for(i=0;i<n;i++){
    C=Math.sqrt(items[i].a*items[i].a+items[i].b*items[i].b);
    bx[i]=Math.floor(items[i].L*su/g);
    by[i]=Math.floor(C*sv/g);
    kk=bx[i]+':'+by[i];
    (cells[kk]=cells[kk]||[]).push(i);
  }

  var ei=[], ej=[], ed=[];
  for(i=0;i<n;i++){
    for(var ox=-1;ox<=1;ox++){
      for(var oy=-1;oy<=1;oy++){
        bucket=cells[(bx[i]+ox)+':'+(by[i]+oy)];
        if(!bucket) continue;
        for(k=0;k<bucket.length;k++){
          j=bucket[k];
          if(j<=i) continue;                  /* each pair once, lower index first */
          ei.push(i); ej.push(j); ed.push(cmpPair(items[i],items[j]));
        }
      }
    }
  }
  var m=ei.length;
  var tei=new Uint16Array(m), tej=new Uint16Array(m), ted=new Float32Array(m);
  for(k=0;k<m;k++){ tei[k]=ei[k]; tej[k]=ej[k]; ted[k]=ed[k]; }
  var ord=new Uint32Array(m);
  for(k=0;k<m;k++) ord[k]=k;
  ord.sort(function(x,y){ return ted[x]-ted[y]; });
  c={items:items,n:n,m:m,ei:tei,ej:tej,ed:ted,ord:ord,cap:g};
  CMP_DIST[key]=c;
  CMP_DIST_KEYS.push(key);
  while(CMP_DIST_KEYS.length>4) delete CMP_DIST[CMP_DIST_KEYS.shift()];
  return c;
}

/* Complete-linkage greedy clustering: walk the pairs from the closest
   outwards and merge two clusters only when the edge itself is within the
   threshold AND so is every cross-pair between them. */
function cmpCluster(key,t){
  var d=cmpDist(key,t), items=d.items, n=d.n, m=d.m, k, i, j;
  var cl=[], owner=new Int32Array(n);
  for(i=0;i<n;i++){ cl.push([i]); owner[i]=i; }
  for(k=0;k<m;k++){
    var e=d.ord[k];
    if(d.ed[e]>t) break;              /* ascending: nothing closer is left */
    var A=owner[d.ei[e]], B=owner[d.ej[e]];
    if(A===B) continue;
    var la=cl[A], lb=cl[B], ok=true;
    for(i=0;i<la.length&&ok;i++){
      for(j=0;j<lb.length;j++){
        if(cmpPair(items[la[i]],items[lb[j]])>t){ ok=false; break; }
      }
    }
    if(!ok) continue;                 /* merging would chain two distinct colours */
    for(j=0;j<lb.length;j++){ la.push(lb[j]); owner[lb[j]]=A; }
    cl[B]=[];
  }
  return cl;
}

/* One entry per group of 2+ items: the members, the group's worst cross-pair
   ΔE, and a representative (medoid) item. Largest groups first, then by code. */
function cmpGroups(key,t){
  var d=cmpDist(key,t), items=d.items, out=[];
  cmpCluster(key,t).forEach(function(mem){
    if(mem.length<2) return;
    var worst=0, rep=mem[0], repMax=Infinity, x, y;
    for(x=0;x<mem.length;x++){
      var mx=0;
      for(y=0;y<mem.length;y++){
        if(x===y) continue;
        var dv=cmpPair(items[mem[x]],items[mem[y]]);
        if(dv>mx) mx=dv;
      }
      if(mx>worst) worst=mx;
      if(mx<repMax || (mx===repMax && items[mem[x]].n>items[rep].n)){
        repMax=mx; rep=mem[x];
      }
    }
    out.push({refs:mem.map(function(ix){ return items[ix]; }),
              repRef:items[rep], size:mem.length, worst:worst});
  });
  out.sort(function(p,q){
    if(q.size!==p.size) return q.size-p.size;
    return p.repRef.item<q.repRef.item?-1:(p.repRef.item>q.repRef.item?1:0);
  });
  out.forEach(function(g,i){
    g.label='G-'+(i+1<10?'0':'')+(i+1);
  });
  return out;
}

var cmpGroupsArr=[], cmpPage=0, cmpCol=1, cmpDir=-1, cmpOpen={};

function sortGroups(){
  var c=cmpCol, d=cmpDir;
  cmpGroupsArr.sort(function(p,q){
    if(c===0) return d*p.label.localeCompare(q.label);
    if(c===1) return d*(p.size-q.size);
    if(c===2) return d*((p.size-1)-(q.size-1));
    return d*(p.worst-q.worst);
  });
}
function cmpGroupByLabel(label){
  for(var i=0;i<cmpGroupsArr.length;i++){
    if(cmpGroupsArr[i].label===label) return cmpGroupsArr[i];
  }
  return null;
}
function cmpRowHtml(g){
  var codes=g.refs.map(function(r){ return r.item; }).sort();
  var shown=codes.slice(0,4).join(', ')+(codes.length>4?', \u2026':'');
  return '<tr class="grow" data-g="'+esc(g.label)+'">'
    +'<td>'+swatch(g.repRef.hex)+' '+esc(g.repRef.item)+'</td>'
    +'<td class="gid">'+esc(g.label)+'</td>'
    +'<td>'+g.size+'</td>'
    +'<td class="gitems">'+esc(shown)
      +(codes.length>4?' <span class="gmore">('+codes.length+' items)</span>':'')
      +'</td>'
    +'<td class="de">'+num(g.worst,2)+'</td>'
    +'<td class="red">'+(g.size-1)+'</td>'
    +'</tr>'
    +(cmpOpen[g.label] ? cmpDetailHtml(g) : '');
}
function cmpDetailHtml(g){
  var rep=g.repRef;
  /* Only the redundant members get a chip: the representative is already named
     in the hint above, and its zero distance to itself is noise. Chips in
     LD_item order so a long group can be scanned top-to-bottom. */
  var chips=g.refs.filter(function(r){ return r!==rep; })
    .sort(function(x,y){
      return x.item<y.item?-1:(x.item>y.item?1:0);
    }).map(function(r){
    return '<button type="button" class="gmem" data-i="'+esc(r.item)+'"'
      +'><span class="sw" style="background:'+(hexOf(r.hex)||'#eee')+'"></span>'
      +'<span class="gmemid">'+esc(r.item)+'</span>'
      +'<span class="gmemde">\u0394E '+num(cmpPair(rep,r),2)+'</span></button>';
  }).join('');
  return '<tr class="gdet" data-gd="'+esc(g.label)+'"><td colspan="6">'
    +'<p class="ghint">Representative <b>'+esc(rep.item)+'</b> \u00b7 '+g.size
    +' items \u00b7 worst pair \u0394E '+num(g.worst,2)
    +' \u00b7 click an item to compare it with the representative</p>'
    +'<div class="gmembers">'+chips+'</div></td></tr>';
}
function renderCmp(){
  var base=cmpBaseline();
  cmpGroupsArr=cmpGroups(cmpSel.value,base);
  sortGroups();
  var total=cmpGroupsArr.length;
  var from=cmpPage*PAGE, to=Math.min(from+PAGE,total);
  var html=[];
  for(var i=from;i<to;i++) html.push(cmpRowHtml(cmpGroupsArr[i]));
  document.getElementById('cmpBody').innerHTML=html.length ? html.join('')
    : '<tr><td class="empty" colspan="6">No group of repeated items at \u0394E \u2264 '
      +num(base,1)+'.</td></tr>';
  var d=cmpDist(cmpSel.value,base), flagged=0, redundant=0, worst=0;
  cmpGroupsArr.forEach(function(g){
    flagged+=g.size; redundant+=g.size-1;
    if(g.worst>worst) worst=g.worst;
  });
  document.getElementById('cmpSummary').textContent=
    d.n.toLocaleString()+' LD_items \u00b7 '
    +total.toLocaleString()+' groups of repeated colour \u00b7 '
    +flagged.toLocaleString()+' items in a group ('+redundant.toLocaleString()
    +' redundant) \u00b7 '+(d.n-flagged).toLocaleString()+' unique'
    +(total?' \u00b7 worst intra-group \u0394E '+num(worst,2):'');
  document.getElementById('cmpInfo').textContent=total
    ? 'Groups '+(from+1)+'\u2013'+to+' of '+total.toLocaleString() : '';
  document.getElementById('cmpPrev').disabled=cmpPage<=0;
  document.getElementById('cmpNext').disabled=to>=total;
}
function refreshCmp(){
  cmpPage=0; cmpOpen={}; renderCmp();
  if(cmpView==='m') renderMatrix();
  else if(cmpView==='c') renderColor();
  else if(cmpView==='o') renderOverall();
}

/* ---- Overall (Overall | Groups | Matrix | Color) ------------------------
   Every textile in the data on one row: how many LD_items it carries, how
   many groups of repeated colour they fall into at the current threshold,
   how many of those items are redundant — each group of n contributes n-1 —
   and that redundant count as a share of the LD_items. The line above the
   table totals the same numbers over all textiles. This is the view the modal
   opens on, and it opens sorted by redundant count, highest first (cmpOvDir
   below); the headings are sortable like the Groups table. A textile the
   Groups view can also show — one with more than one LD_item, so it made it
   into the dropdown — is a link: picking it selects that textile and switches
   to Groups. */
var cmpOvCol=3, cmpOvDir=-1;   /* default: Redundant column, descending */
/* Redundancy summed over every textile at the threshold renderOverall just
   used — the Stats tab's "Redundant LD items" card reads these instead of
   clustering the whole dataset a second time. */
var CMP_TOT=null;
function renderOverall(){
  var base=cmpBaseline(), keys=Object.keys(CMP_BY).sort();
  var rows=[], totItems=0, totRed=0;
  keys.forEach(function(k){
    var n=(CMP_BY[k]||[]).length, gs=cmpGroups(k,base), red=0;
    gs.forEach(function(g){ red+=g.size-1; });
    totItems+=n; totRed+=red;
    rows.push({key:k,n:n,groups:gs.length,red:red,pct:n?100*red/n:0});
  });
  rows.sort(function(a,b){
    var va,vb;
    if(cmpOvCol===0){ va=a.key; vb=b.key; }
    else if(cmpOvCol===1){ va=a.n; vb=b.n; }
    else if(cmpOvCol===2){ va=a.groups; vb=b.groups; }
    else if(cmpOvCol===3){ va=a.red; vb=b.red; }
    else { va=a.pct; vb=b.pct; }
    var r=(typeof va==='string') ? (va<vb?-1:(va>vb?1:0)) : (va-vb);
    if(r===0) r=a.key<b.key?-1:(a.key>b.key?1:0);   /* stable: textile A–Z */
    return cmpOvDir*r;
  });
  var html=[];
  rows.forEach(function(row){
    html.push('<tr><td class="tl">'+(row.n>1
        ? '<a href="#" class="itemlink" data-t="'+esc(row.key)+'">'+esc(row.key)+'</a>'
        : esc(row.key))+'</td>'
      +'<td>'+row.n.toLocaleString()+'</td>'
      +'<td>'+row.groups.toLocaleString()+'</td>'
      +'<td class="red">'+row.red.toLocaleString()+'</td>'
      +'<td class="pct">'+row.pct.toFixed(1)+'%</td></tr>');
  });
  document.getElementById('cmpOverallBody').innerHTML=html.length?html.join('')
    :'<tr><td class="empty" colspan="5">No LD_items to compare.</td></tr>';
  cmpOvArrow();
  document.getElementById('cmpOverallSummary').textContent=
    keys.length.toLocaleString()+' textiles \u00b7 '
    +totItems.toLocaleString()+' LD_items \u00b7 '
    +totRed.toLocaleString()+' redundant'
    +(totItems?' ('+(100*totRed/totItems).toFixed(1)+'% of LD_items)':'');
  CMP_TOT={textiles:keys.length,items:totItems,red:totRed};
  renderStatsTop();
}
/* Sort arrow for the Overall table, mirroring cmpArrow() for the Groups one. */
function cmpOvArrow(){
  Array.prototype.forEach.call(
    document.querySelectorAll('#cmpOverallTable th.sortable .arrow'),
    function(a){ a.remove(); });
  var th=document.querySelector(
    '#cmpOverallTable th.sortable[data-c="'+cmpOvCol+'"]');
  if(!th) return;
  var sp=document.createElement('span'); sp.className='arrow';
  sp.textContent=(cmpOvDir===1?'\u25B2':'\u25BC'); th.appendChild(sp);
}

/* ---- Redundancy matrix (Groups | Matrix) --------------------------------
   The same groups, drawn as one square table over the flagged LD_items: the
   LD_item across the top and down the side in one shared order — group by
   group, LD_item inside the group — so every group lands as a block of red
   straddling the diagonal. The header row and the leading column are sticky,
   so the labels stay in view while the grid scrolls either way.
   Only the lower triangle is drawn: the pair's Delta E CMC(2:1) is printed
   below the diagonal, a redundant pair (deltaE <= threshold) is filled red on
   top of its number, and the diagonal is filled pale blue. The upper triangle
   is left blank — a pair is the same pair whichever way round you read it, so
   the cell above the diagonal would only repeat the number below it.
   A 1,000-item textile would be a million cells, so only the rows in view
   are in the DOM: blank spacer rows above and below keep the scrollbar
   proportional, and each measured pair is remembered for the life of the
   square, so scrolling back up costs nothing. */
var cmpView='o';

function setCmpView(v){
  cmpView=v;
  Array.prototype.forEach.call(
    document.querySelectorAll('#cmpViews .segbtn'),function(b){
      if(b.getAttribute('data-v')===v) b.classList.add('on');
      else b.classList.remove('on');
    });
  document.getElementById('cmpOverallPane').hidden=(v!=='o');
  document.getElementById('cmpGroupsPane').hidden=(v!=='g');
  document.getElementById('cmpMatrixPane').hidden=(v!=='m');
  document.getElementById('cmpColorPane').hidden=(v!=='c');
  document.getElementById('cmpTip').hidden=true;
  if(v==='m') renderMatrix();
  else if(v==='c') renderColor();
  else if(v==='o') renderOverall();
}

/* Flagged items in block order: group label first, LD_item inside the group. */
function cmpMatrixItems(key,t){
  var gs=cmpGroups(key,t).slice().sort(function(a,b){
    return a.label<b.label?-1:(a.label>b.label?1:0);
  });
  var out=[];
  gs.forEach(function(g){
    g.refs.slice().sort(function(x,y){
      return x.item<y.item?-1:(x.item>y.item?1:0);
    }).forEach(function(r){ out.push(r); });
  });
  return out;
}

var CMP_MX=null;   /* the drawn matrix: refs, threshold, row memo */
var MX_ROW=21;     /* one row: 20px line box + 1px rule, fixed by the CSS */
var MX_PAD=6;      /* rows kept in the DOM beyond the visible window */

/* The Delta E of one pair of flagged items, memoised. cmpPair fixes the CMC
   reference to the lower LD_item, so it is symmetric — the (8,1) cell and the
   (1,8) cell hold the same number. Only the lower triangle is drawn, so the
   matrix only ever asks for the (lo,hi) side; keying the memo that way means
   the pair is measured the first time any cell needs it and read back from
   then on. Half the square is never touched, which is what keeps a 1,000-item
   textile at ~500k numbers instead of a million cells.
   The memo lives as long as the matrix does — it is emptied when a textile,
   threshold or filter changes the square, which is the only time the numbers
   can differ. The printed number still matches the groups table, the member
   chips, the CSV and the pair popup exactly. */
function mxDe(v,u){
  var M=CMP_MX;
  if(v===u) return 0;
  var lo=v<u?v:u, hi=v<u?u:v;
  var row=M.rows[lo];
  if(!row) row=M.rows[lo]=[];
  var de=row[hi];
  if(de==null){ de=cmpPair(M.refs[lo],M.refs[hi]); row[hi]=de; }
  return de;
}

/* Draw the rows in (and just around) the viewport. Spacer rows above and
   below carry the pixel heights of the rows they stand in for, so the
   scrollbar still measures the whole square. */
function mxWindow(force){
  var M=CMP_MX; if(!M) return;
  var wrap=document.getElementById('mxWrap');
  var table=document.getElementById('mxTable');
  var hh=table.tHead?table.tHead.offsetHeight:MX_ROW;
  var vis=Math.ceil((wrap.clientHeight||600)/MX_ROW)+1;
  var v0=Math.max(0,Math.floor(Math.max(0,wrap.scrollTop-hh)/MX_ROW)-MX_PAD);
  var v1=Math.min(M.n-1,v0+vis+2*MX_PAD);
  if(!force&&v0===M.v0&&v1===M.v1) return;
  M.v0=v0; M.v1=v1;
  var h=[], u, v, de;
  if(v0>0) h.push('<tr class="sp"><td colspan="'+(M.n+1)+'" style="height:'
    +(v0*MX_ROW)+'px"></td></tr>');
  for(v=v0;v<=v1;v++){
    h.push('<tr data-v="'+v+'"><th>'+esc(M.refs[v].item)+'</th>');
    for(u=0;u<M.n;u++){
      if(u===v){ h.push('<td class="self" data-u="'+u+'">0.00</td>'); continue; }
      /* the upper triangle repeats the lower one, so leave it out of the
         DOM altogether: no number, no hit target, nothing to measure */
      if(u>v){ h.push('<td class="up"></td>'); continue; }
      de=mxDe(v,u);
      h.push('<td'+(de<=M.t?' class="hot"':'')+' data-u="'+u+'">'
        +de.toFixed(2)+'</td>');
    }
    h.push('</tr>');
  }
  if(v1<M.n-1) h.push('<tr class="sp"><td colspan="'+(M.n+1)+'" style="height:'
    +((M.n-1-v1)*MX_ROW)+'px"></td></tr>');
  document.getElementById('mxBody').innerHTML=h.join('');
}

function renderMatrix(){
  var key=cmpSel.value, t=cmpBaseline();
  var refs=cmpMatrixItems(key,t), n=refs.length;
  var wrap=document.getElementById('mxWrap');
  var empty=document.getElementById('cmpMatrixEmpty');
  var sum=document.getElementById('cmpMatrixSummary');

  if(n<1){
    wrap.hidden=true;
    wrap.style.height='';
    empty.hidden=false;
    empty.textContent='No group of repeated items at \u0394E \u2264 '+num(t,1)
      +' \u2014 nothing to plot.';
    document.getElementById('mxHead').innerHTML='';
    document.getElementById('mxBody').innerHTML='';
    sum.textContent='';
    CMP_MX=null;
    return;
  }
  wrap.hidden=false;
  empty.hidden=true;

  var i, k, head=['<th>LD_item</th>'];
  for(i=0;i<n;i++) head.push('<th>'+esc(refs[i].item)+'</th>');
  document.getElementById('mxHead').innerHTML=head.join('');

  CMP_MX={refs:refs,n:n,t:t,rows:{},v0:-1,v1:-1};
  /* The scroll frame sizes itself to its content, so give it the height the
     whole square would take — the CSS caps it at 72vh — before measuring it,
     or the first paint would see only the header row and fill one screenful
     of a two-row window. */
  wrap.style.height=Math.min((n+1)*MX_ROW,720)+'px';
  wrap.scrollTop=0; wrap.scrollLeft=0;
  mxWindow(true);

  /* How many flagged pairs are redundant? The prefilter's candidate table is
     a guaranteed superset of every pair at or below the threshold, so counting
     the candidates at \u0394E <= t is exact — and costs no n\u00b2 sweep. */
  var d=cmpDist(key,t), pos={}, red=0;
  for(i=0;i<n;i++) pos[refs[i].item]=i;
  for(k=0;k<d.m;k++){
    if(d.ed[k]>t) continue;
    if(pos[d.items[d.ei[k]].item]==null) continue;
    if(pos[d.items[d.ej[k]].item]==null) continue;
    red++;
  }
  var pairs=n*(n-1)/2;
  sum.textContent=n.toLocaleString()+' flagged LD_items \u00b7 '
    +red.toLocaleString()+' redundant pairs at \u0394E \u2264 '+num(t,1)+' \u00b7 '
    +(pairs-red).toLocaleString()+' of '+pairs.toLocaleString()+' pairs above';
}

/* Delegated hit test: the cell itself carries its column, its row carries the
   row index, so no geometry has to be recomputed. */
function cmpMatrixHit(ev){
  if(!CMP_MX) return null;
  var td=ev.target;
  if(!td||td.tagName!=='TD') return null;
  var us=td.getAttribute('data-u');
  if(us==null) return null;
  var tr=td.parentNode;
  var vs=tr?tr.getAttribute('data-v'):null;
  if(vs==null) return null;
  var u=Number(us), v=Number(vs);
  if(!(u>=0&&u<CMP_MX.n&&v>=0&&v<CMP_MX.n)) return null;
  return {u:u,v:v,ra:CMP_MX.refs[u],rb:CMP_MX.refs[v]};
}
function cmpMatrixTip(ev){
  var tip=document.getElementById('cmpTip'), h=cmpMatrixHit(ev);
  if(!h){ tip.hidden=true; return; }
  if(h.u===h.v){
    tip.innerHTML='<span class="tmono">'+esc(h.ra.item)+'</span> \u00b7 same item';
  } else {
    var de=mxDe(h.v,h.u);
    tip.innerHTML='<span class="tmono">'+esc(h.ra.item)+'</span> vs '
      +'<span class="tmono">'+esc(h.rb.item)+'</span><br>'
      +'\u0394E '+num(de,2)+' \u2014 '
      +(de<=CMP_MX.t?'redundant':'not redundant');
  }
  tip.hidden=false;
  var x=ev.clientX+14, y=ev.clientY+14;
  if(x+tip.offsetWidth>window.innerWidth-8)
    x=Math.max(8,ev.clientX-tip.offsetWidth-14);
  if(y+tip.offsetHeight>window.innerHeight-8)
    y=Math.max(8,ev.clientY-tip.offsetHeight-14);
  tip.style.left=x+'px'; tip.style.top=y+'px';
}
Array.prototype.forEach.call(
  document.querySelectorAll('#cmpViews .segbtn'),function(b){
  b.addEventListener('click',function(){ setCmpView(b.getAttribute('data-v')); });
});
document.getElementById('mxBody').addEventListener('mousemove',cmpMatrixTip);
document.getElementById('mxBody').addEventListener('mouseleave',function(){
  document.getElementById('cmpTip').hidden=true; });
document.getElementById('mxBody').addEventListener('click',function(ev){
  var h=cmpMatrixHit(ev);
  if(!h||h.u===h.v) return;
  document.getElementById('cmpTip').hidden=true;
  openPair(h.ra,h.rb);
});
document.getElementById('mxWrap').addEventListener('scroll',function(){
  document.getElementById('cmpTip').hidden=true;
  mxWindow(false);
});
window.addEventListener('resize',function(){
  if(cmpView==='m') mxWindow(true);
});

/* ---- Colour picker (Groups | Matrix | Color) ----------------------------
   Every LD_item of the textile as one colour card, in LD_item order. Two taps
   open the same pair popup the matrix opens: the first card picked is the
   reference (side A), the second the one it is measured against (side B).
   The cards carry the LD_item's mean colour — the same mean the grouping and
   the matrix use — so what is picked by eye is what gets compared. */
var CMP_CG=null;      /* {refs, key} for the grid on screen */
var cgSel=[];         /* indices into CMP_CG.refs, never more than one pending */

function renderColor(){
  var key=cmpSel.value;
  var refs=(CMP_BY[key]||[]).map(cmpRef);
  var grid=document.getElementById('cmpColorGrid');
  var sum=document.getElementById('cmpColorSummary');
  refs.sort(function(x,y){
    return x.item<y.item?-1:(x.item>y.item?1:0);
  });
  cgSel=[];
  if(!refs.length){
    grid.innerHTML='';
    sum.textContent='No LD_items for '+key+'.';
    CMP_CG=null;
    return;
  }
  var h=[], i, ok;
  for(i=0;i<refs.length;i++){
    ok=hexOf(refs[i].hex);
    h.push('<button type="button" class="cgcard" data-i="'+i+'">'
      +'<span class="cgchip" style="background:'+(ok||'repeating-linear-gradient('
        +'45deg,#ddd,#ddd 4px,#fff 4px,#fff 8px)')+'"></span>'
      +'<span class="cgid">'+esc(refs[i].item)+'</span>'
      +'<span class="cgflag"></span></button>');
  }
  grid.innerHTML=h.join('');
  CMP_CG={refs:refs,key:key};
  sum.textContent=refs.length.toLocaleString()+' LD_items in '+key
    +' \u00b7 tap one card for the reference, then a second to compare';
}

function cgPaint(){
  Array.prototype.forEach.call(
    document.querySelectorAll('#cmpColorGrid .cgcard'),function(c){
      var pos=cgSel.indexOf(Number(c.getAttribute('data-i')));
      c.className='cgcard'+(pos===0?' ref':(pos===1?' pick':''));
      var f=c.querySelector('.cgflag');
      if(f) f.textContent=(pos===0?'A \u00b7 REF':(pos===1?'B':''));
    });
}
document.getElementById('cmpColorGrid').addEventListener('click',function(ev){
  var card=ev.target.closest?ev.target.closest('.cgcard'):null;
  if(!card||!CMP_CG) return;
  var i=Number(card.getAttribute('data-i'));
  if(!(i>=0&&i<CMP_CG.refs.length)) return;
  var at=cgSel.indexOf(i);
  if(at>=0) cgSel.splice(at,1); else cgSel.push(i);
  cgPaint();
  if(cgSel.length<2) return;
  openPair(CMP_CG.refs[cgSel[0]],CMP_CG.refs[cgSel[1]]);
  cgSel=[];
  cgPaint();
});

function cmpArrow(th){
  Array.prototype.forEach.call(
    document.querySelectorAll('#cmpTable th.sortable .arrow'),
    function(a){ a.remove(); });
  var sp=document.createElement('span'); sp.className='arrow';
  sp.textContent=(cmpDir===1?'\u25B2':'\u25BC'); th.appendChild(sp);
}
/* A textile picked in the Overall table selects it in the dropdown and hands
   over to the Groups view, where its groups are laid out. */
document.getElementById('cmpOverallBody').addEventListener('click',function(e){
  var a=e.target.closest('a.itemlink');
  if(!a) return;
  e.preventDefault();
  cmpSel.value=a.getAttribute('data-t');
  setCmpView('g');
  refreshCmp();
});
/* Overall headings sort the table in place — same click-to-toggle behaviour
   as the Groups table, but on its own sort state (cmpOvCol / cmpOvDir). */
Array.prototype.forEach.call(
  document.querySelectorAll('#cmpOverallTable th.sortable'),function(th){
  th.addEventListener('click',function(){
    var c=Number(th.getAttribute('data-c'));
    if(cmpOvCol===c){ cmpOvDir=-cmpOvDir; }
    else { cmpOvCol=c; cmpOvDir=(c===0?1:-1); }   /* numbers: biggest first */
    renderOverall();
  });
});
cmpSel.addEventListener('change',refreshCmp);
/* The threshold only re-clusters — the cached distances are reused. */
document.getElementById('cmpBaseline').addEventListener('input',refreshCmp);
Array.prototype.forEach.call(
  document.querySelectorAll('#cmpTable th.sortable'),function(th){
  th.addEventListener('click',function(){
    var c=Number(th.getAttribute('data-c'));
    if(cmpCol===c){ cmpDir=-cmpDir; }
    else { cmpCol=c; cmpDir=(c===0?1:-1); }   /* numbers: biggest first */
    cmpArrow(th); cmpPage=0; renderCmp();
  });
});
document.getElementById('cmpPrev').addEventListener('click',function(){
  if(cmpPage>0){ cmpPage--; renderCmp(); }});
document.getElementById('cmpNext').addEventListener('click',function(){
  if((cmpPage+1)*PAGE<cmpGroupsArr.length){ cmpPage++; renderCmp(); }});
document.getElementById('cmpBody').addEventListener('click',function(e){
  var mem=e.target.closest('.gmem');
  if(mem){
    var gd=cmpGroupByLabel(mem.closest('tr.gdet').getAttribute('data-gd'));
    if(!gd) return;
    var r=null;
    gd.refs.forEach(function(x){ if(x.item===mem.getAttribute('data-i')) r=x; });
    if(r) openPair(gd.repRef,r);
    return;
  }
  var tr=e.target.closest('tr.grow');
  if(tr){
    var lb=tr.getAttribute('data-g');
    if(cmpOpen[lb]) delete cmpOpen[lb]; else cmpOpen[lb]=1;
    renderCmp();
  }
});
/* Retire candidates as CSV: one row per LD_item, grouped, with its ΔE to the
   group representative — the list a colour engineer needs to act on. */
function cmpCsv(v){
  return '"'+String(v==null?'':v).replace(/"/g,'""')+'"';
}
function exportCmp(){
  var key=cmpSel.value, gs=cmpGroups(key,cmpBaseline());
  var rows=[['Textile','Group','Group_size','Group_max_deltaE','Role','LD_item',
             'NAME(s)','L*','a*','b*','Hex','Samples',
             'deltaE_to_representative','Representative_LD_item']];
  gs.forEach(function(g){
    var rep=g.repRef;
    g.refs.slice().sort(function(x,y){
      return x.item<y.item?-1:(x.item>y.item?1:0);
    }).forEach(function(r){
      rows.push([key,g.label,g.size,g.worst.toFixed(2),
                 r===rep?'representative':'redundant', r.item, r.names,
                 r.L.toFixed(2), r.a.toFixed(2), r.b.toFixed(2),
                 hexOf(r.hex)||'', r.n, cmpPair(rep,r).toFixed(2), rep.item]);
    });
  });
  var csv=rows.map(function(r){ return r.map(cmpCsv).join(','); }).join('\r\n');
  var blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url; a.download='Redundant-LD-items'+(key?'-'+key:'')+'.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); },0);
}
document.getElementById('cmpExport').addEventListener('click',exportCmp);
/* Default sort: group size descending, with the arrow to prove it. */
cmpArrow(document.querySelector('#cmpTable th.sortable[data-c="1"]'));
refreshCmp();

/* LD Redundancy is a tab view, shown under the top bar like Match Pantone. */
/* The ⓘ button opens the help popup (centred) that replaced the old wall of text. */
document.getElementById('cmpHelp').addEventListener('click',function(){
  document.getElementById('cmpHelpModal').style.display='flex';
});
document.getElementById('cmpHelpClose').addEventListener('click',function(){
  document.getElementById('cmpHelpModal').style.display='none';
});
document.getElementById('cmpHelpModal').addEventListener('click',function(e){
  if(e.target.id==='cmpHelpModal') e.currentTarget.style.display='none';
});

/* Pair popup: two colours side by side — big square swatch cards on top, a
   details table (LD_item / NAME / hex / Lab) below. Opened from a group in the
   LD Redundancy tab with its representative mean against one of its members. */
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
function openPair(pa,pb){
  if(!pa||!pb) return;
  var base=cmpBaseline();
  document.getElementById('pairTitle').textContent=pa.name+'  vs  '+pb.name;
  document.getElementById('pairCardA').innerHTML=pairCard(pa);
  document.getElementById('pairCardB').innerHTML=pairCard(pb);
  document.getElementById('pairDetail').innerHTML=pairTable(pa,pb);
  var de=cmpPair(pa,pb);
  var pd=document.getElementById('pairDelta');
  pd.textContent='\u0394E '+num(de,2)+' \u2014 '+(de<base?'below':'above')
    +' baseline '+num(base,1);
  pd.className='pairdelta'+(de<base?' lo':' hi');
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

/* Unmatched Raw: the Raw_items that match no LD_item. Same dialog pattern as
   the pair popup — opened from the Raw tab's Unmatched Raw button. */
function openUn(){
  document.getElementById('unModal').style.display='block';
  document.body.style.overflow='hidden';
}
function closeUn(){
  document.getElementById('unModal').style.display='none';
  document.body.style.overflow='';
}
document.getElementById('mUN').addEventListener('click',openUn);
document.getElementById('unClose').addEventListener('click',closeUn);
document.getElementById('unModal').addEventListener('click',function(e){
  if(e.target.id==='unModal') closeUn(); });

/* Export LD / Raw to Excel. Every LD and Raw measurement row (captured
   verbatim by the generator) is written as a real .xlsx. An .xlsx is a ZIP of
   XML parts, so the sheet is packed with STORE (uncompressed) entries here —
   no library, and Excel opens the file without the format-mismatch prompt a
   CSV or an HTML "xls" would raise. The Laminate tab's export reuses the same
   writer over its own row set. */
var EX_COLS = DATA.export_cols || [];
var EX_ROWS = DATA.export || [];
var LAM_COLS = DATA.lam_export_cols || [];
var LAM_ROWS = DATA.lam_export || [];

var CRC_TABLE=(function(){
  var t=new Uint32Array(256), c, n, k;
  for(n=0;n<256;n++){ c=n;
    for(k=0;k<8;k++){ c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); }
    t[n]=c>>>0; }
  return t; })();
function crc32(u8){
  var c=0xFFFFFFFF;
  for(var i=0;i<u8.length;i++){ c=CRC_TABLE[(c^u8[i])&0xFF]^(c>>>8); }
  return (c^0xFFFFFFFF)>>>0; }
function utf8(s){ return new TextEncoder().encode(s); }
function le16(n){ return [n&255,(n>>>8)&255]; }
function le32(n){ return [n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]; }
/* files: [{name, data:Uint8Array}] -> the bytes of a ZIP archive. */
function zipStore(files){
  var body=[], dir=[], i, off=0, nm, dt, crc, lh;
  for(i=0;i<files.length;i++){
    nm=utf8(files[i].name); dt=files[i].data; crc=crc32(dt);
    lh=[].concat([80,75,3,4], le16(20), le16(0), le16(0), le16(0), le16(0),
      le32(crc), le32(dt.length), le32(dt.length), le16(nm.length), le16(0));
    body.push(new Uint8Array(lh), nm, dt);
    dir.push({nm:nm, crc:crc, len:dt.length, off:off});
    off += lh.length + nm.length + dt.length;
  }
  var cdStart=off, cdLen=0, ch, d;
  for(i=0;i<dir.length;i++){
    d=dir[i];
    ch=[].concat([80,75,1,2], le16(20), le16(20), le16(0), le16(0), le16(0),
      le16(0), le32(d.crc), le32(d.len), le32(d.len), le16(d.nm.length),
      le16(0), le16(0), le16(0), le16(0), le32(0), le32(d.off));
    body.push(new Uint8Array(ch), d.nm);
    cdLen += ch.length + d.nm.length;
  }
  body.push(new Uint8Array([].concat([80,75,5,6], le16(0), le16(0),
    le16(dir.length), le16(dir.length), le32(cdLen), le32(cdStart), le16(0))));
  var total=0;
  for(i=0;i<body.length;i++) total += body[i].length;
  var out=new Uint8Array(total), pos=0;
  for(i=0;i<body.length;i++){ out.set(body[i],pos); pos += body[i].length; }
  return out;
}
/* XML 1.0 forbids the C0 controls other than tab/newline/CR, and the two
   non-characters FFFE/FFFF. Free-text columns (NAME, Description) pick stray
   control bytes up from the source rows, and one of them is enough to make the
   worksheet part ill-formed — Excel then refuses the file and offers a repair.
   Drop them before escaping. */
function xclean(s){
  return String(s==null?'':s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'');
}
function xesc(s){ return xclean(s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]; }); }
function colRef(i){
  var s=''; i++;
  while(i>0){ s=String.fromCharCode(65+((i-1)%26))+s; i=Math.floor((i-1)/26); }
  return s; }
function xcell(ref,v){
  if(typeof v==='number'&&isFinite(v)) return '<c r="'+ref+'"><v>'+v+'</v></c>';
  var s=xclean(v);
  return s==='' ? '<c r="'+ref+'"/>'
    : '<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+xesc(s)
      +'</t></is></c>'; }
function sheetXml(cols,rows){
  var all=[cols].concat(rows), xml=['<?xml version="1.0" encoding="UTF-8"'
    +' standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/'
    +'spreadsheetml/2006/main"><sheetData>'], r, c, cells;
  for(r=0;r<all.length;r++){
    cells=[];
    for(c=0;c<all[r].length;c++) cells.push(xcell(colRef(c)+(r+1), all[r][c]));
    xml.push('<row r="'+(r+1)+'">'+cells.join('')+'</row>');
  }
  xml.push('</sheetData></worksheet>');
  return xml.join('');
}
/* cols/rows -> a one-sheet .xlsx download named fileName, the worksheet
   labelled sheetName. */
function writeXlsx(cols, rows, sheetName, fileName){
  var head='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  var files=[
    {name:'[Content_Types].xml', data:utf8(head
      +'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      +'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      +'<Default Extension="xml" ContentType="application/xml"/>'
      +'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      +'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      +'</Types>')},
    {name:'_rels/.rels', data:utf8(head
      +'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      +'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      +'</Relationships>')},
    {name:'xl/workbook.xml', data:utf8(head
      +'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      +' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      +'<sheets><sheet name="'+xesc(sheetName)+'" sheetId="1" r:id="rId1"/></sheets></workbook>')},
    {name:'xl/_rels/workbook.xml.rels', data:utf8(head
      +'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      +'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      +'</Relationships>')},
    {name:'xl/worksheets/sheet1.xml', data:utf8(sheetXml(cols, rows))}
  ];
  var blob=new Blob([zipStore(files)],
    {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url; a.download=fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 0);
}
function exportLdRaw(){
  if(!EX_ROWS.length) return;
  writeXlsx(EX_COLS, EX_ROWS, 'LD and Raw', 'LD-Raw-data.xlsx');
}
function exportLaminate(){
  if(!LAM_ROWS.length) return;
  writeXlsx(LAM_COLS, LAM_ROWS, 'Laminate', 'Laminate-data.xlsx');
}
document.getElementById('mXLS').addEventListener('click',exportLdRaw);
document.getElementById('lXL').addEventListener('click',exportLaminate);

/* Unmatched Laminate: laminate rows carrying no Product, listed as flat
   sample rows because there is no Product to group them under. */
function openUnLam(){
  document.getElementById('unlamModal').style.display='block';
  document.body.style.overflow='hidden';
}
function closeUnLam(){
  document.getElementById('unlamModal').style.display='none';
  document.body.style.overflow='';
}
document.getElementById('lUN').addEventListener('click',openUnLam);
document.getElementById('unlamClose').addEventListener('click',closeUnLam);
document.getElementById('unlamModal').addEventListener('click',function(e){
  if(e.target.id==='unlamModal') closeUnLam(); });

/* ---- Stats tab ----
   Stats is the default view, so the charts are built immediately on load
   (ECharts can't measure hidden nodes — if the default ever changes back,
   revert to lazy building on the tab click). The guard also lets the tab's
   click listener call buildStats() harmlessly. */
var STATS={built:false,charts:[]};
/* Headline KPI strip. Every count is derived from what the other tabs list:
   a textile is an LD_item's first 4 characters (the key the LD Redundancy tab
   groups by), the redundancy totals come from the last Overall render — so the
   card never re-clusters the dataset — and the laminate counts come off the
   flattened laminate rows so they match the Laminate tab. Called both by
   buildStats() and, once the threshold settles, by renderOverall(). */
function renderStatsTop(){
  var nMasters=0, nSamples=0;
  LAM.forEach(function(r){
    if(r[11]==='Laminate Master') nMasters++;
    else if(r[11]==='Laminate Sample') nSamples++;
  });
  var rawTot=(META.raw||0)+(META.unmatched_raw||0);
  var red=CMP_TOT?CMP_TOT.red:0;
  function card(k,v,s){
    return '<div class="stat"><div class="k">'+k+'</div>'
      +'<div class="v">'+Number(v||0).toLocaleString()+'</div>'
      +(s?'<div class="s">'+s+'</div>':'')+'</div>';
  }
  document.getElementById('statsTop').innerHTML=
    card('Textiles', Object.keys(CMP_BY).length, 'first 4 chars of LD_item')
    +card('LD items', ITEMS.length)
    +card('Redundant LD items', red,
          (META.items?100*red/META.items:0).toFixed(1)+'% of LD items')
    +card('Raw samples', rawTot,
          (rawTot?100*(META.raw||0)/rawTot:0).toFixed(1)+'% matched')
    +card('Laminate masters', nMasters,
          nSamples.toLocaleString()+' laminate samples');
}
/* Vertical Pareto bars for the categorical Stats cards: counts on the left
   axis, a cumulative-% line on the right one. The cards list only the top 50
   categories, but the running total is divided by the *whole* population, so
   the last visible bar reads the real coverage of the top 50 (it stays below
   100% whenever a tail exists). Zooming happens on the x-axis through an
   inside dataZoom — the wheel or a pinch — so the card never scrolls and
   therefore has no scrollbar. Returns the cumulative % at the last bar. */
function vBar(el,labels,vals,total,color){
  el.style.height='340px';
  var cum=0;
  var cumPct=vals.map(function(v){
    cum+=Number(v)||0;
    return total ? +(cum/total*100).toFixed(1) : 0;
  });
  STATS.charts.push(echarts.init(el).setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},
      formatter:function(ps){
        if(!ps||!ps.length) return '';
        var i=ps[0].dataIndex;
        return '<b>'+esc(labels[i])+'</b><br/>'
          +Number(vals[i]).toLocaleString()
          +'<br/>cumulative '+cumPct[i].toFixed(1)+'%';
      }},
    grid:{left:8,right:46,top:26,bottom:8,containLabel:true},
    xAxis:{type:'category',data:labels,
           axisLabel:{fontSize:9,rotate:labels.length>8?45:0,interval:0,
                      hideOverlap:true}},
    yAxis:[
      {type:'value',axisLabel:{fontSize:9},splitLine:{lineStyle:{color:'#eef1f5'}}},
      {type:'value',min:0,max:100,axisLabel:{fontSize:9,formatter:'{value}%'},
       splitLine:{show:false}}
    ],
    dataZoom:[{type:'inside',xAxisIndex:0,start:0,end:100,
               zoomOnMouseWheel:true,moveOnMouseMove:false,moveOnMouseWheel:false}],
    series:[
      {name:'count',type:'bar',data:vals,itemStyle:{color:color},
       label:{show:true,position:'top',fontSize:9},labelLayout:{hideOverlap:true}},
      {name:'cumulative %',type:'line',yAxisIndex:1,data:cumPct,
       symbol:'circle',symbolSize:3,lineStyle:{width:1.3,type:'dashed',color:'#8a94a6'},
       itemStyle:{color:'#8a94a6'}}
    ]
  }));
  return cumPct.length ? cumPct[cumPct.length-1] : 0;
}
function buildStats(){
  if(STATS.built) return;
  STATS.built=true;

  /* 0. Headline counts — a five-card KPI strip. */
  renderStatsTop();

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

  /* 2. LD_item count per textile (first 4 chars of LD_item). The chart draws
     the top 50 textiles only, but coverage runs against every LD item. */
  (function(){
    var groups={};
    ITEMS.forEach(function(it){
      var t=String(it[0]).slice(0,4);
      groups[t]=(groups[t]||0)+1;
    });
    var total=ITEMS.length;
    var keys=Object.keys(groups).sort(function(a,b){ return groups[b]-groups[a]; });
    var top=keys.slice(0,50);
    var cover=vBar(document.getElementById('chLd'),
         top, top.map(function(k){ return groups[k]; }), total, '#4e79a7');
    document.getElementById('tNoteLd').textContent=' top '+top.length
      +' of '+keys.length+' textiles \u00b7 '+cover.toFixed(1)+'% of all items';
  })();

  /* 3. Distinct Raw batches per Raw_item (top 50) */
  (function(){
    var keys=Object.keys(RAWBATCH);
    var total=keys.reduce(function(s,k){ return s+RAWBATCH[k]; },0);
    keys.sort(function(a,b){ return RAWBATCH[b]-RAWBATCH[a]; });
    var top=keys.slice(0,50);
    var cover=vBar(document.getElementById('chBatch'),
         top, top.map(function(k){ return RAWBATCH[k]; }), total, '#f28e2b');
    document.getElementById('tNoteBatch').textContent=' top '+top.length
      +' of '+keys.length+' items \u00b7 '+cover.toFixed(1)+'% of all batches';
  })();

  /* 4. Laminate samples tested per Product (top 50) */
  (function(){
    var counts={};
    LAMPROD.forEach(function(it){ counts[it[0]]=(counts[it[0]]||0)+(it[6]||0); });
    var keys=Object.keys(counts);
    var total=keys.reduce(function(s,k){ return s+counts[k]; },0);
    keys.sort(function(a,b){ return counts[b]-counts[a]; });
    var top=keys.slice(0,50);
    var cover=vBar(document.getElementById('chLamProd'),
         top, top.map(function(k){ return counts[k]; }), total, '#76b7b2');
    document.getElementById('tNoteLp').textContent=' top '+top.length
      +' of '+keys.length+' Products \u00b7 '+cover.toFixed(1)+'% of all samples';
  })();

  /* 5. Measurements per month, stacked by sample type */
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

  /* 6. ΔE histogram of matched Raw samples vs their LD_item mean */
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
        cap=3.0,   /* x-axis stops at 2.9-3.0; larger ΔE values fold into '>3.0' */
        bins=[], over=0, i, v;
    for(i=0;i*step<cap-1e-9;i++) bins.push(0);
    for(i=0;i<all.length;i++){
      v=all[i];
      if(v>=cap){ over++; continue; }
      bins[Math.min(bins.length-1,Math.floor(v/step))]++;
    }
    var mi=Math.floor(SPEC_RAW/step);      // bin holding the 0.8 target
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
               markLine:SPEC_RAW<cap?{silent:true,symbol:'none',data:[{xAxis:mi,
                 lineStyle:{color:'#d64541',type:'dashed',width:1.2},
                 label:{formatter:'Target '+SPEC_RAW,fontSize:10,color:'#d64541',
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
var curMode='ld', itemPage=0, ITEM_CHART=null, AB_CHART=null, DIST_CHART=null,
    ITEM_REF=null,
    ITEM_WORK=[], ITEM_VIEW=[], ITEM_FENCE=Infinity,
    AB_QC=SPEC_RAW, AB_FULL=false, AB_R=7.5, AB_HUE=0, AB_RREF=null,
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
  if(curMode==='ld'||curMode==='lam')
    ITEM_WORK.forEach(function(r){ if(r[7]!=='') des.push(r[7]); });
  des.sort(function(x,y){ return x-y; });
  if(des.length<4){ ITEM_FENCE=Infinity; return; }
  var q1=pct(des,0.25), q3=pct(des,0.75), iqr=q3-q1;
  ITEM_FENCE = iqr>0 ? q3+1.5*iqr : des[des.length-1];
}
/* ΔE cell highlight: the laminate modal flags every sample past the 1.0
   laminate spec, the LD modal keeps the boxplot outlier fence. */
function hlThreshold(){ return curMode==='lam' ? SPEC_LAM : ITEM_FENCE; }
/* The modal's active ΔE reference: the dropdown pick while the selector is
   visible, otherwise the opened item's own reference colour (the LD item mean,
   or the Product's master-plate mean). A hidden selector keeps the previously
   opened item's value, so visibility decides. */
function activeRef(){
  var wrap=document.getElementById('refWrap'),
      sel=document.getElementById('refSel');
  if(!wrap||wrap.style.display==='none'||!sel) return ITEM_REF;
  if(curMode==='ld') return LDREFS[sel.value]||ITEM_REF;
  if(curMode==='lam')
    return sel.value==='lam'
      ? ITEM_REF : (LD_CI[String(sel.value).toUpperCase()]||ITEM_REF);
  return ITEM_REF;
}
/* ΔE of every Raw sample vs the selected reference LD sample. */
function recomputeDE(){
  var rref=activeRef();
  if(!rref) return;
  var ok=rref.L!=null&&rref.L!==''&&rref.a!==''&&rref.b!=='';
  ITEM_WORK.forEach(function(r){
    var has=ok&&r[2]!==''&&r[3]!==''&&r[4]!=='';
    r[7]=has?Math.round(deltaECMC(rref.L,rref.a,rref.b,r[2],r[3],r[4])*100)/100:'';
    /* Per-channel offsets vs the same reference, shown at the table's end. */
    r[8]=has?Math.round((r[2]-rref.L)*100)/100:'';
    r[9]=has?Math.round((r[3]-rref.a)*100)/100:'';
    r[10]=has?Math.round((r[4]-rref.b)*100)/100:'';
  });
}
function renderChips(){
  var chips=document.getElementById('itemChips');
  if(curMode==='lam'){
    var lr=activeRef(), self=(lr===ITEM_REF);
    chips.innerHTML=
      '<span class="cchip">\u0394E reference '+swatch(lr.hex)
      +' <span class="hex">'+esc(lr.name||lr.item)+(self?' mean':'')+'</span></span>'
      +'<span class="cchip">L* '+num(lr.L)+'</span>'
      +'<span class="cchip">a* '+num(lr.a)+'</span>'
      +'<span class="cchip">b* '+num(lr.b)+'</span>'
      +(self
        ? '<span class="cchip">'+(lr.masters
            ? lr.masters.toLocaleString()+' master plate'+(lr.masters===1?'':'s')
            : 'no master plate \u2014 sample mean')+'</span>'
          +'<span class="cchip">'+lr.wol.toLocaleString()+' WOL</span>'
        : '<span class="cchip">LD_item reference</span>');
    return;
  }
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
  if(curMode==='un'){
    box.innerHTML=stat('Raw samples', ITEM_WORK.length.toLocaleString());
    return;
  }
  var deVals=[];
  ITEM_WORK.forEach(function(r){ if(r[7]!=='') deVals.push(r[7]); });
  deVals.sort(function(x,y){ return x-y; });
  var nOut=deVals.filter(function(v){ return v>ITEM_FENCE; }).length;
  var lbl=curMode==='lam'?'Laminate samples':'Matching Raw samples';
  box.innerHTML=deVals.length
    ? stat(lbl, ITEM_WORK.length.toLocaleString())
      +stat('Median \u0394E', num(pct(deVals,0.5),2))
      +stat('P95 \u0394E', num(pct(deVals,0.95),2))
      +stat('Worst \u0394E', num(deVals[deVals.length-1],2))
      +stat('Outliers', nOut.toLocaleString())
    : stat(lbl,'0');
}
function openDetail(mode,item){
  var ref = mode==='ld' ? ITEM_BY[item]
          : mode==='lam' ? LAMPROD_BY[item] : UN_BY[item];
  if(!ref) return;
  var scored=(mode==='ld'||mode==='lam');   // modes that carry a ΔE column
  curMode=mode; ITEM_REF=ref; itemQ='';
  AB_QC=specFor(mode);                      // QC ring: raw 0.8, laminate 1.0
  document.getElementById('iSearch').value='';
  document.getElementById('iSearch').placeholder=
    mode==='lam' ? 'Search laminate sample or WOL' : 'Search Raw sample or batch';
  /* Laminate sample rows carry WOL at 6, Batch at 7 and Sample_type at 11;
     collapse them onto the Raw-sample layout (…, hex, WOL, ΔE) so the shared
     table, chart and stats code works unchanged. */
  ITEM_WORK=ref.rows.map(function(r){
    return mode==='lam' ? [r[0],r[1],r[2],r[3],r[4],r[5],r[6],''] : r.slice();
  });
  document.getElementById('itemHead').innerHTML=
    '<th class="sortable" data-c="0">Date</th>'
    +'<th class="sortable" data-c="1">'
    +(mode==='lam'?'Laminate sample':'Raw sample')+'</th>'
    +'<th>'+(mode==='lam'?'Product':'Item')+'</th>'
    +'<th>Swatch</th>'
    /* Scored modes drop Hex and WOL/Batch and add per-channel ΔL/Δa/Δb. */
    +(scored?'':'<th class="sortable" data-c="5">Hex</th>')
    +(scored?'<th class="sortable" data-c="7">&#916;E</th>':'')
    +(scored?'':'<th class="sortable" data-c="6">'+(mode==='lam'?'WOL':'Batch')+'</th>')
    +'<th class="sortable" data-c="2">L*</th>'
    +'<th class="sortable" data-c="3">a*</th>'
    +'<th class="sortable" data-c="4">b*</th>'
    +(scored?'<th class="sortable" data-c="8">&#916;L</th>'
            +'<th class="sortable" data-c="9">&#916;a</th>'
            +'<th class="sortable" data-c="10">&#916;b</th>':'');
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
    itemCol=7; itemDir=-1;
  } else if(mode==='lam'){
    /* Reference choices, grouped: the Product's own master-plate mean (the
       default), or any LD_item that matches one of the Product's Raw_items.
       Nothing to compare against when no Raw_item resolves to an LD_item, so
       the selector stays hidden and the master mean is used. */
    var ritems=[], seen={};
    (ref.raw||[]).forEach(function(code){
      var it=LD_CI[String(code).toUpperCase()];
      if(it && !seen[it.item]){ seen[it.item]=1; ritems.push(it); }
    });
    ritems.sort(function(x,y){ return x.item<y.item?-1:x.item>y.item?1:0; });
    if(ritems.length){
      wrap.style.display='';
      var lsel=document.getElementById('refSel');
      lsel.innerHTML='<optgroup label="Laminate"><option value="lam">'
        +esc(ref.name)+' (master mean)</option></optgroup>'
        +'<optgroup label="Raw">'+ritems.map(function(it){
          return '<option value="'+esc(it.item)+'">'+esc(it.item)+'</option>';
        }).join('')+'</optgroup>';
      lsel.value='lam';
    } else wrap.style.display='none';
    itemCol=7; itemDir=-1;
  } else {
    wrap.style.display='none';
    itemCol=0; itemDir=-1;
  }
  if(scored) recomputeDE();
  itemArrow();
  document.getElementById('modalTitle').textContent=item;
  computeFence();
  renderChips();
  renderStats();
  document.getElementById('modal').style.display='block';
  document.body.style.overflow='hidden';
  itemPage=0; renderItem();
  if(scored){
    document.getElementById('deCard').style.display='block';
    buildItemChart();
    document.getElementById('abCard').style.display='block';
    buildAbChart();
    buildDistChart();
  } else {
    if(ITEM_CHART){ ITEM_CHART.dispose(); ITEM_CHART=null; }
    if(AB_CHART){ AB_CHART.dispose(); AB_CHART=null; }
    if(DIST_CHART){ DIST_CHART.dispose(); DIST_CHART=null; }
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
  if(curMode!=='ld'&&curMode!=='lam') return;
  var SPEC=specFor(curMode), byLabel=curMode==='lam'?'WOL':'batch';
  var raw=[];
  ITEM_WORK.forEach(function(r){
    if(r[7]===''||r[6]==='') return;         // needs a WOL/batch # and a ΔE
    raw.push([r[6], r[7], r[1]]);            // [WOL/batch, ΔE, sample]
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
    '\u0394E vs '+refName+' by '+byLabel+' \u2014 '+pts.length.toLocaleString()
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
          +'<br>'+(byLabel==='WOL'?'WOL ':'Batch ')+esc(p.value[0])
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
      {name:curMode==='lam'?'Laminate sample':'Raw sample',
       type:'scatter',data:pts,symbolSize:6,clip:false,
       itemStyle:{opacity:0.6,color:function(p){
         return p.value[1]>ITEM_FENCE ? '#d64541' : '#4e79a7'; }},
       markLine:{silent:true,symbol:'none',data:[{yAxis:SPEC,
         lineStyle:{color:'#d64541',type:'dashed',width:1.2},
         label:{formatter:'Target \u0394E '+SPEC,fontSize:10,color:'#d64541',
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
        +(p.data.batch?'<br>'+(curMode==='lam'?'WOL ':'Batch ')+esc(p.data.batch):'')
        +'<br>\u0394a*: '+num(v[0],2)+'<br>\u0394b*: '+num(v[1],2)
        +'<br>\u0394E CMC: '+num(v[2],2);
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
  if(curMode!=='ld'&&curMode!=='lam') return;
  var rref=activeRef();
  if(rref.L==null||rref.L===''){ document.getElementById('abCard').style.display='none'; return; }
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
    '\u0394a*/\u0394b* map & \u0394L*/\u0394a*/\u0394b* spread vs '
    +(rref.name||rref.item)+' \u2014 '
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
/* ---- per-channel distribution ----
   Three stacked histograms of the ΔL / Δa / Δb offsets against the active ΔE
   reference, beside the dCIELab map. Each bar is tinted by the deviation it
   stands for (dark/light for L, green/red for a, blue/yellow for b) rather
   than by a pass/fail threshold, so the shape of the spread is readable at a
   glance. */
var DIST_METRICS=[
  {key:8,label:'\u0394L*',axis:'\u0394L*, dark \u2194 light',
   stops:[[-1,'#1e293b'],[0,'#94a3b8'],[1,'#e2e8f0']]},
  {key:9,label:'\u0394a*',axis:'\u0394a*, green \u2194 red',
   stops:[[-1,'#16a34a'],[0,'#94a3b8'],[1,'#dc2626']]},
  {key:10,label:'\u0394b*',axis:'\u0394b*, blue \u2194 yellow',
   stops:[[-1,'#2563eb'],[0,'#94a3b8'],[1,'#eab308']]}
];
/* Linear blend between two #rrggbb colours, u in [0,1]. */
function mixHex(a,b,u){
  var A=parseInt(a.slice(1),16), B=parseInt(b.slice(1),16);
  function c(sh){ return Math.round(((A>>sh)&255)+(((B>>sh)&255)-((A>>sh)&255))*u); }
  return 'rgb('+c(16)+','+c(8)+','+c(0)+')';
}
/* Colour for a normalised deviation t (-1 green/blue/dark .. +1 red/yellow/light). */
function rampColor(stops,t){
  t=Math.max(-1,Math.min(1,t));
  for(var i=0;i<stops.length-1;i++){
    var x=stops[i][0], y=stops[i+1][0];
    if(t>=x&&t<=y)
      return mixHex(stops[i][1],stops[i+1][1],y===x?0:(t-x)/(y-x));
  }
  return stops[stops.length-1][1];
}
/* Coarsest step from a fixed ladder that keeps the span near ~20 bins. */
function binStepFor(half){
  var s=[0.05,0.1,0.2,0.25,0.5,1,2,2.5,5,10];
  for(var i=0;i<s.length;i++) if((2*half)/s[i]<=24) return s[i];
  return 20*half/24;
}
function buildDistChart(){
  var box=document.getElementById('distChart');
  if(DIST_CHART){ DIST_CHART.dispose(); DIST_CHART=null; }
  if(!box) return;
  box.style.display='';
  /* buildAbChart hides the whole card when the item has no comparable Lab
     values; skip then, so a zero-width canvas is never initialised. */
  var card=document.getElementById('abCard');
  if(!card||card.style.display==='none'){ box.style.display='none'; return; }
  if(curMode!=='ld'&&curMode!=='lam'){ box.style.display='none'; return; }
  var rref=activeRef();
  if(!rref||rref.L==null||rref.L===''){ box.style.display='none'; return; }
  var vals=[[],[],[]], half=0, i, k, any=false;
  ITEM_WORK.forEach(function(r){
    for(k=0;k<3;k++){
      var v=r[DIST_METRICS[k].key];
      if(v===''||v==null||isNaN(v)) continue;
      v=Number(v); vals[k].push(v); any=true;
      if(Math.abs(v)>half) half=Math.abs(v);
    }
  });
  if(!any){ box.style.display='none'; return; }
  half=Math.max(0.5,abNice(half*1.02));
  var step=binStepFor(half);
  /* Force an odd bin count and re-fit the half-range: 0 then sits exactly on
     the centre of the middle bin, so the zero separator can be placed with an
     integer category index instead of a fractional one (ECharts rounds those). */
  var nb=Math.max(1,2*Math.round(half/step)+1);
  half=nb*step/2;
  /* Decimals read off the step, so half-unit steps are not rounded into
     misleading tick labels. */
  var dec=Math.min(2,(String(step).split('.')[1]||'').length);
  var centres=[], labels=[];
  for(i=0;i<nb;i++){
    var c=-half+step*(i+0.5);
    centres.push(c); labels.push(c.toFixed(dec));
  }
  var series=[];
  DIST_METRICS.forEach(function(m,mi){
    var counts=[];
    for(i=0;i<nb;i++) counts.push(0);
    vals[mi].forEach(function(v){
      var idx=Math.floor((v+half)/step);
      if(idx<0) idx=0; else if(idx>=nb) idx=nb-1;
      counts[idx]++;
    });
    series.push({name:m.label,type:'bar',barCategoryGap:0,
      xAxisIndex:mi,yAxisIndex:mi,data:counts,
      itemStyle:{color:function(p){
                   return rampColor(m.stops,centres[p.dataIndex]/half); },
                 borderColor:'rgba(15,23,42,.14)',borderWidth:1},
      /* Odd bin count puts the middle category centre on 0, so this integer
         index draws the zero separator exactly on the negative/positive split. */
      markLine:{silent:true,symbol:'none',
        lineStyle:{color:'rgba(15,23,42,.55)',width:1},
        label:{show:false},
        data:[{xAxis:(nb-1)/2}]}});
  });
  var grids=[],xAxes=[],yAxes=[],titles=[];
  for(i=0;i<3;i++){
    var top=6+i*31;
    grids.push({left:46,right:12,top:top+'%',height:'22%'});
    xAxes.push({type:'category',gridIndex:i,data:labels,
      name:DIST_METRICS[i].axis,nameLocation:'middle',nameGap:20,
      nameTextStyle:{fontSize:9,fontWeight:700,color:'#475467'},
      axisTick:{show:false},axisLine:{lineStyle:{color:'#cbd5e1'}},
      axisLabel:{fontSize:9,hideOverlap:true,interval:'auto',color:'#667085'}});
    yAxes.push({type:'value',gridIndex:i,minInterval:1,
      splitLine:{lineStyle:{color:'#eef2f7'}},
      axisLabel:{fontSize:9,color:'#667085'}});
    titles.push({text:DIST_METRICS[i].label,left:6,top:(top-4)+'%',
      textStyle:{fontSize:11,fontWeight:700,color:'#344054'}});
  }
  DIST_CHART=echarts.init(box,null,{renderer:'canvas'});
  DIST_CHART.setOption({animation:false,
    tooltip:{trigger:'item',confine:true,formatter:function(p){
      var lo=-half+step*p.dataIndex;
      return '<b>'+esc(p.seriesName)+'</b><br>'+lo.toFixed(dec)
        +' \u2192 '+(lo+step).toFixed(dec)
        +'<br>'+p.value+' sample'+(p.value===1?'':'s');
    }},
    title:titles,grid:grids,xAxis:xAxes,yAxis:yAxes,series:series});
}
function renderItem(){
  ITEM_VIEW=itemFiltered();
  var from=itemPage*PAGE, to=Math.min(from+PAGE,ITEM_VIEW.length);
  var scored=(curMode==='ld'||curMode==='lam');
  var lbl=curMode==='lam'?'Laminate sample':'Raw sample';
  var html=[];
  for(var i=from;i<to;i++){
    var r=ITEM_VIEW[i], hex=hexOf(r[5]);
    html.push('<tr><td>'+esc(day(r[0]))+'</td><td>'+esc(r[1])+'</td>'
      +'<td>'+esc(ITEM_REF.item)+'</td>'
      +'<td>'+swatchLg(r[5])+'</td>'
      +(scored
        ? '<td class="'+(r[7]!==''&&r[7]>hlThreshold()?'out':'')
            +'">'+(r[7]===''?'\u2013':num(r[7],2))+'</td>'
        : '<td class="hex">'+esc(hex||'\u2013')+'</td>')
      +(scored?'':'<td>'+esc(r[6]||'\u2013')+'</td>')
      +'<td>'+esc(num(r[2]))+'</td><td>'+esc(num(r[3]))+'</td><td>'+esc(num(r[4]))+'</td>'
      +(scored?'<td>'+dnum(r[8])+'</td>'
                       +'<td>'+dnum(r[9])+'</td>'
                       +'<td>'+dnum(r[10])+'</td>':'')
      +'</tr>');
  }
  document.getElementById('itemBody').innerHTML=html.length?html.join('')
    : '<tr><td colspan="11" class="empty">No '+lbl.toLowerCase()+'s.</td></tr>';
  document.getElementById('iInfo').textContent=ITEM_VIEW.length
    ? 'Rows '+(from+1)+'\u2013'+to+' of '+ITEM_VIEW.length.toLocaleString()
      +(itemQ?' (filtered)':'')
    : 'No matching '+lbl.toLowerCase()+'s';
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
  buildItemChart(); buildAbChart(); buildDistChart(); });
document.getElementById('iPrev').addEventListener('click',function(){
  if(itemPage>0){ itemPage--; renderItem(); }});
document.getElementById('iNext').addEventListener('click',function(){
  if((itemPage+1)*PAGE<ITEM_VIEW.length){ itemPage++; renderItem(); }});
function closeItem(){
  if(ITEM_CHART){ ITEM_CHART.dispose(); ITEM_CHART=null; }
  if(AB_CHART){ AB_CHART.dispose(); AB_CHART=null; }
  if(DIST_CHART){ DIST_CHART.dispose(); DIST_CHART=null; }
  document.getElementById('modal').style.display='none';
  document.body.style.overflow='';
}
document.getElementById('modalClose').addEventListener('click',closeItem);
document.getElementById('modal').addEventListener('click',function(e){
  if(e.target.id==='modal') closeItem(); });
document.addEventListener('keydown',function(e){
  if(e.key!=='Escape') return;
  if(document.getElementById('pairModal').style.display!=='none'){ closePair(); return; }
  if(document.getElementById('cmpHelpModal').style.display!=='none'){
    document.getElementById('cmpHelpModal').style.display='none'; return; }
  if(document.getElementById('modal').style.display==='block'){ closeItem(); return; }
  if(document.getElementById('unModal').style.display==='block'){ closeUn(); return; }
  if(document.getElementById('unlamModal').style.display==='block') closeUnLam(); });

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
    var it=row[1], d=deltaECMC(c.L,c.a,c.b,it[2],it[3],it[4]);
    if(row[0]==='ld'){ if(!bestLD || d<bestLD.de) bestLD={mode:'ld',it:it,de:d}; }
    else if(!bestUN || d<bestUN.de) bestUN={mode:'un',it:it,de:d};
  });
  var best=(bestLD && bestLD.de<=thr) ? bestLD
          : (bestUN && bestUN.de<=thr) ? bestUN : null;
  if(!best){
    var near=!bestLD ? bestUN : (!bestUN || bestLD.de<bestUN.de) ? bestLD : bestUN;
    PT_OUT.innerHTML='<div class="pt-hint2"><span class="pt-x">\u2297</span>'
      +'No match within \u0394E CMC(2:1) \u2264 '+thr.toFixed(2)+' for '+esc(c.id)+' '
      +esc(c.name)+'. Nearest candidate: '+esc(near.it[0])+' at \u0394E CMC(2:1) '
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
    +'<p class="pt-note">\u0394E CMC(2:1) = <b>'+best.de.toFixed(2)
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
  if(DIST_CHART) DIST_CHART.resize();
});

document.getElementById('meta').textContent=
  META.items.toLocaleString()+' LD items \u00b7 '+META.raw.toLocaleString()
  +' Raw samples matched \u00b7 '+META.unmatched_items.toLocaleString()
  +' unmatched Raw items ('+META.unmatched_raw.toLocaleString()+' rows) \u00b7 '
  +META.lam.toLocaleString()+' Laminate rows'
  +(META.date_min?' \u00b7 '+META.date_min+' to '+META.date_max:'')
  +(META.skipped?' \u00b7 '+META.skipped.toLocaleString()
    +' rows skipped (Sample_type \'Null\' or Raw without Raw_item)':'');
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

    # LD_item sometimes arrives with a trailing "-"; drop it so the item joins
    # its Raw samples and matches the rest of the table's spellings.
    for record in records:
        item = _text(record.get("LD_item"))
        if item.endswith("-"):
            record["LD_item"] = item.rstrip("-").rstrip()

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
          f"({meta['unmatched_raw']} rows) | Laminate: {meta['lam']} "
          f"({meta['lamprod']} Products, {meta['unmatched_lam']} unmatched rows)")
    print(f"Tabs  : 5 (Stats, Raw, Laminate, LD Redundancy, Match Pantone) "
          f"+ Unmatched Raw / Unmatched Laminate dialogs")
    print(f"Size  : {out_path.stat().st_size / 1024 / 1024:.1f} MB "
          f"in {time.perf_counter() - started:.1f}s")
    # Remind the user where the report was saved, then open it in the browser.
    print(f"Charts generated: {out_path}")
    webbrowser.open(out_path.resolve().as_uri())


if __name__ == "__main__":
    main()