# `data` is already loaded for you — a list of dicts from the grid
import pandas as pd
import json
import html
import os
import tempfile
import webbrowser
from collections import OrderedDict
from datetime import datetime
from pathlib import Path


# ------------------------------------------------------------
# 0. Load data from Excel
# ------------------------------------------------------------
def script_dir():
    """Folder containing this script; falls back to the current
    working directory when run from an interactive editor."""
    try:
        return Path(__file__).resolve().parent
    except NameError:
        return Path.cwd()


HERE = script_dir()

df = pd.DataFrame(data)
#print(df.head())

df = df.astype(object).where(pd.notnull(df), None)
data = [r for r in df.to_dict("records") if any(v is not None for v in r.values())]


def safe_num(value):
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (ValueError, TypeError):
        return None


def date_epoch_ms(value):
    """Convert a date-like grid value to epoch milliseconds, so the sort
    metadata can be serialized to plain JSON numbers for the browser."""
    if value is None or value == "":
        return None
    # Numeric grid values are treated as Excel serial dates (e.g. 45900).
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            ts = pd.to_datetime(value, unit="D", origin="1899-12-30")
        except Exception:  # noqa: BLE001
            return None
    else:
        try:
            ts = pd.to_datetime(value, errors="coerce")
        except Exception:  # noqa: BLE001
            return None
    if ts is None or pd.isna(ts):
        return None
    return int(ts.timestamp() * 1000)


# ------------------------------------------------------------
# 1. Group rows by MAIN_GROUP_DESCRIPTION
# ------------------------------------------------------------
groups = OrderedDict()
for row in data:
    desc = row.get("MAIN_GROUP_DESCRIPTION")
    if not desc:
        continue
    groups.setdefault(desc, []).append(row)

if not groups:
    print("No data available.")
    raise SystemExit

# ------------------------------------------------------------
# 2. Compute chart data and statistics
# ------------------------------------------------------------
chart_data = {}
stats = {}

for desc, rows in groups.items():
    # ---- Chart data -------------------------------------------------
    rows_sorted = sorted(
        rows,
        key=lambda r: (
            safe_num(r.get("JDE_WO_NUMBER")) is None,
            safe_num(r.get("JDE_WO_NUMBER")) or 0
        )
    )

    labels = []
    issued_list = []
    allocated_list = []
    fmi_total_list = []
    planned_yield_list = []
    true_yield_list = []
    overall_yield_list = []
    sort_meta = []  # per-point [WO, FMI_TOTAL, FMI_DATE ms] for the sort setting

    for r in rows_sorted:
        wo = safe_num(r.get("JDE_WO_NUMBER"))
        if wo is not None and wo.is_integer():
            labels.append(str(int(wo)))
        elif wo is not None:
            labels.append(str(wo))
        else:
            labels.append("")

        allocated = safe_num(r.get("ALLOCATED_NET"))
        issued = safe_num(r.get("ISSUED_NET"))
        fmi_total = safe_num(r.get("FMI_TOTAL"))
        planned = safe_num(r.get("PLANNED_YIELD"))
        fmi_good = safe_num(r.get("FMI_GOOD")) or 0.0
        overrun = safe_num(r.get("OVERRUN")) or 0.0
        good_qty = fmi_good + overrun

        issued_list.append(issued)
        allocated_list.append(allocated)
        fmi_total_list.append(fmi_total)

        planned_yield_list.append((planned / 100.0) if planned is not None else None)

        if allocated:
            true_yield_list.append(round(good_qty / allocated, 6))
        else:
            true_yield_list.append(None)

        if issued:
            overall_yield_list.append(round(good_qty / issued, 6))
        else:
            overall_yield_list.append(None)

        sort_meta.append([wo, fmi_total, date_epoch_ms(r.get("FMI_DATE"))])

    chart_data[desc] = {
        "labels": labels,
        "issued": issued_list,
        "allocated": allocated_list,
        "fmi_total": fmi_total_list,
        "planned_yield": planned_yield_list,
        "true_yield": true_yield_list,
        "overall_yield": overall_yield_list,
        "sort_meta": sort_meta
    }

    # ---- Statistics -------------------------------------------------
    main_group = ""
    distinct_wos = set()
    allocated_sum = 0.0
    issued_sum = 0.0
    fmi_total_sum = 0.0
    good_sum_issued = 0.0
    planned_vals = []
    wtd_allocated_sum = 0.0
    wtd_good_sum = 0.0
    ge_count = 0
    lt_count = 0

    for r in rows:
        if not main_group:
            main_group = r.get("MAIN_GROUP") or ""
        wo = r.get("JDE_WO_NUMBER")
        if wo is not None:
            distinct_wos.add(wo)

        allocated = safe_num(r.get("ALLOCATED_NET"))
        issued = safe_num(r.get("ISSUED_NET"))
        fmi_total = safe_num(r.get("FMI_TOTAL"))
        planned = safe_num(r.get("PLANNED_YIELD"))
        fmi_good = safe_num(r.get("FMI_GOOD")) or 0.0
        overrun = safe_num(r.get("OVERRUN")) or 0.0
        good_qty = fmi_good + overrun

        if allocated is not None:
            allocated_sum += allocated
        if issued is not None:
            issued_sum += issued
            good_sum_issued += good_qty
        if fmi_total is not None:
            fmi_total_sum += fmi_total
        if planned is not None:
            planned_vals.append(planned / 100.0)
        if allocated:
            wtd_allocated_sum += allocated
            wtd_good_sum += good_qty
            if planned is not None:
                planned_val = planned / 100.0
                true_val = good_qty / allocated
                if true_val >= planned_val:
                    ge_count += 1
                else:
                    lt_count += 1

    wo_count = len(distinct_wos)
    cmp_total = ge_count + lt_count
    ge_pct = (ge_count / cmp_total * 100.0) if cmp_total else None
    lt_pct = (lt_count / cmp_total * 100.0) if cmp_total else None

    wtd_true = (wtd_good_sum / wtd_allocated_sum) if wtd_allocated_sum else None
    planned_avg = (sum(planned_vals) / len(planned_vals)) if planned_vals else None
    var_avg = (wtd_true - planned_avg) if (wtd_true is not None and planned_avg is not None) else None

    stats[desc] = {
        "main_group": main_group,
        "wo_count": wo_count,
        "allocated_net": allocated_sum,
        "issued_net": issued_sum,
        "fmi_total": fmi_total_sum,
        "avg_order_size": (issued_sum / wo_count) if wo_count else None,
        "planned_yield": planned_avg,
        "overall_yield": (good_sum_issued / issued_sum) if issued_sum else None,
        "true_yield_wtd": wtd_true,
        "ge_pct": ge_pct,
        "lt_pct": lt_pct,
        "var_avg": var_avg,
        "loss_qty": (var_avg * allocated_sum * -1) if (var_avg is not None and allocated_sum) else 0.0
    }

# ------------------------------------------------------------
# 3. Build HTML
# ------------------------------------------------------------
YIELD_LABELS = ("Planned Yield", "True Yield", "Overall Yield")
BAR_LABELS = ("Issued Net", "Allocated Net", "FMI Total")


def build_global_controls():
    """One toolbar above all charts: a single Settings dropdown that applies
    to EVERY chart (show/hide for yield lines & bars, dedicated marker
    show/style/size per yield line, manual min/max for both y-axes —
    empty input = chart.js auto scale — and client-side sorting of every
    chart by WO / FMI total / FMI date, ascending or descending)."""

    # Full-width sort bar above the three setting columns. Reorders every
    # chart by one of the yield query's key fields (applies to all charts).
    sort_items = (
        f'<div class="set-sort">'
        f'<div class="set-title">Sort charts by</div>'
        f'<div class="set-sort-row">'
        f'<select id="sortKey" onchange="applySort()">'
        f'<option value="JDE_WO_NUMBER" selected>JDE_WO_NUMBER</option>'
        f'<option value="FMI_TOTAL">FMI_TOTAL</option>'
        f'<option value="FMI_DATE">FMI_DATE</option>'
        f'</select>'
        f'<select id="sortDir" onchange="applySort()">'
        f'<option value="asc" selected>Ascending</option>'
        f'<option value="desc">Descending</option>'
        f'</select>'
        f'</div>'
        f'</div>'
    )

    def series_items(labels):
        return "".join(
            f'<label><input type="checkbox" id="ds_{label.replace(" ", "_")}" checked '
            f'onchange="toggleDataset(\'{label}\')"> {label}</label>'
            for label in labels
        )

    yield_items = series_items(YIELD_LABELS)
    bar_items = series_items(BAR_LABELS)

    marker_styles = (
        ("circle", "Circle"), ("triangle", "Triangle"), ("rect", "Square"),
        ("rectRounded", "Rounded square"), ("cross", "Cross"),
        ("crossRot", "Cross rotated"), ("star", "Star"), ("line", "Dash"),
    )

    def style_options(default):
        return "".join(
            f'<option value="{v}"{" selected" if v == default else ""}>{label}</option>'
            for v, label in marker_styles
        )

    # Dedicated marker block per yield line: show / style / size.
    # Defaults differ per line so the lines are distinguishable out of the box.
    def marker_block(key, label, default_style):
        return (
            f'<div class="set-title">{label}</div>'
            f'<label><input type="checkbox" id="mk_{key}_show" checked '
            f'onchange="applyMarkers()"> Show markers</label>'
            f'<div class="set-row"><span>Style</span>'
            f'<select id="mk_{key}_style" onchange="applyMarkers()">'
            f'{style_options(default_style)}</select></div>'
            f'<div class="set-row"><span>Size</span>'
            f'<input type="number" id="mk_{key}_size" min="0" max="12" step="1" '
            f'value="4" onchange="applyMarkers()"></div>'
        )

    # Three columns: series show/hide | per-line markers | y-axes + reset.
    settings_items = (
        sort_items +
        f'<div class="set-cols">'
        f'<div class="set-col">'
        f'<div class="set-title">Yield Lines</div>'
        f'{yield_items}'
        f'<div class="set-title">Bars</div>'
        f'{bar_items}'
        f'</div>'
        f'<div class="set-col">'
        + marker_block("planned", "Planned Yield &mdash; markers", "circle")
        + marker_block("true", "True Yield &mdash; markers", "triangle")
        + marker_block("overall", "Overall Yield &mdash; markers", "rect")
        + f'</div>'
        f'<div class="set-col">'
        f'<div class="set-title">Left Y axis &mdash; Net Quantity</div>'
        f'<label><input type="checkbox" id="yauto" checked '
        f'onchange="applyAxis()"> Auto scale</label>'
        f'<div class="set-row"><span>Min</span>'
        f'<input type="number" id="ymin" '
        f'onchange="axisManual(this.id, \'yauto\')"></div>'
        f'<div class="set-row"><span>Max</span>'
        f'<input type="number" id="ymax" '
        f'onchange="axisManual(this.id, \'yauto\')"></div>'
        f'<div class="set-title">Right Y axis &mdash; Yield</div>'
        f'<label><input type="checkbox" id="y1auto" '
        f'onchange="applyAxis()"> Auto scale</label>'
        f'<div class="set-row"><span>Min</span>'
        f'<input type="number" id="y1min" step="0.05" value="0" '
        f'onchange="axisManual(this.id, \'y1auto\')"></div>'
        f'<div class="set-row"><span>Max</span>'
        f'<input type="number" id="y1max" step="0.05" '
        f'onchange="axisManual(this.id, \'y1auto\')"></div>'
        f'<button type="button" class="btn-reset" '
        f'onclick="resetSettings()">Reset defaults</button>'
        f'</div>'
        f'</div>'
    )

    return (
        f'<div class="global-controls" id="global-controls">'
        f'<div class="chart-controls">'
        f'<div class="dropdown">'
        f'<button type="button" class="dropdown-btn" onclick="toggleDropdown(\'dd_set\')">Settings &#9662;</button>'
        f'<div class="dropdown-menu menu-settings" id="dd_set">{settings_items}</div>'
        f'</div>'
        f'</div>'
        f'</div>'
    )


def make_chart_block(idx, desc, d):
    chart_id = f"chart_{idx}"

    datasets = [
        {"type": "bar", "label": "Issued Net", "data": d["issued"], "yAxisID": "y",
         "backgroundColor": "rgba(54,162,235,0.5)", "borderColor": "rgba(54,162,235,1)", "borderWidth": 1},
        {"type": "bar", "label": "Allocated Net", "data": d["allocated"], "yAxisID": "y",
         "backgroundColor": "rgba(153,102,255,0.5)", "borderColor": "rgba(153,102,255,1)", "borderWidth": 1},
        {"type": "bar", "label": "FMI Total", "data": d["fmi_total"], "yAxisID": "y",
         "backgroundColor": "rgba(255,99,132,0.5)", "borderColor": "rgba(255,99,132,1)", "borderWidth": 1},
        {"type": "line", "label": "Planned Yield", "data": d["planned_yield"], "yAxisID": "y1",
         "borderColor": "rgba(220,20,20,1)", "backgroundColor": "rgba(220,20,20,0.1)",
         "borderDash": [6, 4], "tension": 0.2, "pointRadius": 4, "pointStyle": "circle"},
        {"type": "line", "label": "True Yield", "data": d["true_yield"], "yAxisID": "y1",
         "borderColor": "rgba(75,192,192,1)", "backgroundColor": "rgba(75,192,192,0.2)",
         "tension": 0.2, "pointRadius": 4, "pointStyle": "triangle"},
        {"type": "line", "label": "Overall Yield", "data": d["overall_yield"], "yAxisID": "y1",
         "borderColor": "rgba(255,159,64,1)", "backgroundColor": "rgba(255,159,64,0.2)",
         "tension": 0.2, "pointRadius": 4, "pointStyle": "rect"},
    ]

    chart_config = {
        "data": {"labels": d["labels"], "datasets": datasets},
        "options": {
            "responsive": True,
            "maintainAspectRatio": False,
            "interaction": {"mode": "index", "intersect": False},
            "plugins": {
                "title": {"display": True, "text": "Net Quantity (bars) vs Yields (lines)"},
                "legend": {"position": "top"}
            },
            "scales": {
                "x": {"title": {"display": True, "text": "WO Number"}},
                "y": {"type": "linear", "position": "left", "title": {"display": True, "text": "Net Quantity"}},
                "y1": {"type": "linear", "position": "right", "title": {"display": True, "text": "Yield"},
                       "min": 0, "grid": {"drawOnChartArea": False}}
            }
        }
    }
    config_js = json.dumps(chart_config)

    # Every statement must sit on its own physical line: the leading `//`
    # line comment would otherwise swallow the rest of a one-line script
    # block and abort parsing with "Unexpected end of input" (blank charts).
    lines = [
        "(function() {",
        "  // Per-point [WO, FMI_TOTAL, FMI_DATE ms] used by the Settings sort.",
        f"  window['{chart_id}_sort'] = {json.dumps(d.get('sort_meta') or [])};",
        f"  var ctx = document.getElementById('{chart_id}').getContext('2d');",
        f"  window['{chart_id}'] = new Chart(ctx, {config_js});",
        f"  window['{chart_id}']._baseLabels = window['{chart_id}'].data.labels.slice();",
        f"  window['{chart_id}']._baseData = window['{chart_id}'].data.datasets.map(function (ds) {{ return ds.data.slice(); }});",
        f"  (window.CHARTS = window.CHARTS || []).push(window['{chart_id}']);",
        "})();",
    ]
    script_js = "\n".join(lines)

    return (
        f'<div class="chart-card">'
        f'<h3>{html.escape(desc)}</h3>'
        f'<div class="chart-wrap"><canvas id="{chart_id}"></canvas></div>'
        f'</div>'
        f'<script>'
        f'{script_js}'
        f'</script>'
    )


chart_blocks = [make_chart_block(i, desc, d) for i, (desc, d) in enumerate(chart_data.items())]
charts_html = "".join(chart_blocks)
global_controls_html = build_global_controls()


def fmt_number(v, digits=1):
    return "" if v is None else f"{v:,.{digits}f}"


def fmt_yield(v):
    return "" if v is None else f"{v * 100:.2f}%"


def fmt_pct(v):
    return "" if v is None else f"{v:.1f}%"


COLUMNS = [
    "Main Group Description",
    "Main Group",
    "WO Count",
    "Allocated Net",
    "Issued Net",
    "FMI Total",
    "Avg Order Size",
    "Planned Yield",
    "Overall Yield",
    "True Yield (Weighted)",
    "True \u2265 Planned (%)",
    "True < Planned (%)",
    "Yield Variance (true-planned)",
    "Loss Qty",
]

header = (
    "<tr>"
    + "".join(
        f"<th><div class='th-sort'>{html.escape(label)}</div></th>"
        for label in COLUMNS
    )
    + "</tr>"
)

rows_html = ""
for desc, s in stats.items():
    rows_html += (
        "<tr>"
        f"<td>{html.escape(desc)}</td>"
        f"<td>{html.escape(s['main_group'])}</td>"
        f"<td style='text-align:right;'>{s['wo_count']}</td>"
        f"<td style='text-align:right;'>{fmt_number(s['allocated_net'])}</td>"
        f"<td style='text-align:right;'>{fmt_number(s['issued_net'])}</td>"
        f"<td style='text-align:right;'>{fmt_number(s['fmi_total'])}</td>"
        f"<td style='text-align:right;'>{fmt_number(s['avg_order_size'])}</td>"
        f"<td style='text-align:right;'>{fmt_yield(s['planned_yield'])}</td>"
        f"<td style='text-align:right;'>{fmt_yield(s['overall_yield'])}</td>"
        f"<td style='text-align:right;'>{fmt_yield(s['true_yield_wtd'])}</td>"
        f"<td style='text-align:right;'>{fmt_pct(s['ge_pct'])}</td>"
        f"<td style='text-align:right;'>{fmt_pct(s['lt_pct'])}</td>"
        f"<td style='text-align:right;'>{fmt_yield(s['var_avg'])}</td>"
        f"<td style='text-align:right;'>{fmt_number(s['loss_qty'])}</td>"
        "</tr>"
    )

table_html = (
    "<div class='table-toolbar'>"
    "<span class='table-hint'>Click a column header to sort</span>"
    "<button type='button' class='btn-download' onclick='downloadStatsExcel()'>Download to Excel</button>"
    "</div>"
    "<div style='overflow-x:auto;'>"
    "<table id='stats-table' border='1' cellpadding='6' cellspacing='0' style='border-collapse:collapse; font-family:Lora, Georgia, serif; font-size:11px; background:#fff;'>"
    "<thead style='background:#eee;'>" + header + "</thead>"
    "<tbody id='stats-tbody'>" + rows_html + "</tbody>"
    "</table>"
    "</div>"
)

charts_display = charts_html or "<p>No chart data.</p>"
table_display = table_html if rows_html else "<p>No statistics available.</p>"

html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Yield Trend & Statistics</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<style>
body {{ background:#f4f6f9; padding:20px; font-family:"Lora", Georgia, "Times New Roman", serif; }}
h1 {{ font-family:inherit; }}
.tab-buttons {{ display:flex; flex-wrap:wrap; gap:8px; }}
.tab-buttons button {{
  padding:10px 24px;
  font-size:15px;
  border:none;
  border-radius:4px;
  background:#007bff;
  color:#fff;
  cursor:pointer;
  min-height:48px;
}}
.tab-buttons button.active {{ background:#0056b3; }}
.tab-content {{ display:none; }}
.tab-content.active {{ display:block; }}
table th, table td {{ white-space:nowrap; }}

/* Chart cards & controls */
.chart-card {{
  margin-bottom:50px;
  background:#fff;
  border:1px solid #ddd;
  border-radius:8px;
  padding:16px;
  box-sizing:border-box;
}}
.chart-card h3 {{ margin:0 0 10px; }}
.chart-controls {{ display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px; }}
/* One sticky row: tab switcher + global chart settings.
   Settings are hidden (but keep their width) while the stats tab is active. */
.top-row {{
  position:sticky;
  top:10px;
  z-index:90;
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:10px;
  background:#fff;
  border:1px solid #ddd;
  border-radius:8px;
  padding:10px 12px;
  margin-bottom:20px;
  box-shadow:0 2px 8px rgba(0,0,0,0.08);
}}
.global-controls {{ display:flex; align-items:center; }}
.top-row .chart-controls {{ margin-bottom:0; }}
body.tab-stats .global-controls {{ visibility:hidden; }}
@media (max-width: 640px) {{
  .top-row {{ position:static; }}
}}
.dropdown {{ position:relative; }}
.dropdown-btn {{
  padding:8px 16px;
  min-height:44px;
  font-size:13px;
  border:1px solid #ccc;
  border-radius:4px;
  background:#fff;
  cursor:pointer;
}}
.dropdown-btn:hover {{ background:#f0f4ff; }}
.dropdown-menu {{
  display:none;
  position:absolute;
  top:calc(100% + 4px);
  left:0;
  z-index:100;
  min-width:190px;
  max-width:min(260px, calc(100vw - 40px));
  background:#fff;
  border:1px solid #ccc;
  border-radius:6px;
  padding:8px;
  box-shadow:0 4px 12px rgba(0,0,0,0.15);
}}
.dropdown-menu.open {{ display:block; }}
.dropdown-menu label {{
  display:flex;
  align-items:center;
  gap:8px;
  padding:8px;
  font-size:13px;
  cursor:pointer;
  border-radius:4px;
  white-space:nowrap;
}}
.dropdown-menu label:hover {{ background:#f0f4ff; }}
.dropdown-menu input {{ width:18px; height:18px; cursor:pointer; }}
/* Settings menu: three columns (series | markers | y-axes) -> wider, less
   tall. Opens rightward from the button; on narrow screens it spans the
   sticky toolbar so it can never clip off-screen. */
.menu-settings {{
  left:0;
  right:auto;
  width:min(720px, calc(100vw - 40px));
  max-width:none;
  box-sizing:border-box;
  max-height:min(72vh, 420px);
  overflow-y:auto;
  padding:8px;
}}
.set-cols {{
  display:grid;
  grid-template-columns:repeat(3, 1fr);
  gap:2px 20px;
}}
.set-col {{ min-width:0; }}
@media (max-width: 960px) {{
  .set-cols {{ grid-template-columns:1fr 1fr; }}
}}
@media (max-width: 640px) {{
  .set-cols {{ grid-template-columns:1fr; }}
}}
/* Narrow screens: anchor the menu to the sticky top row (full width) so the
   wide menu always fits between the viewport edges. */
@media (max-width: 1024px) {{
  .global-controls .dropdown {{ position:static; }}
  .global-controls .menu-settings {{
    left:12px;
    right:12px;
    width:auto;
  }}
}}
.set-title {{
  font-size:11px;
  font-weight:700;
  color:#1f3a5f;
  padding:4px 6px 1px;
  margin-top:1px;
  border-top:1px solid #eee;
  white-space:nowrap;
}}
.dropdown-menu .set-title:first-child {{ border-top:none; margin-top:0; }}
.set-row {{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
  padding:2px 6px;
  font-size:12px;
  white-space:nowrap;
}}
.set-row span {{ flex:none; }}
.menu-settings select,
.menu-settings input[type="number"] {{
  min-height:24px;
  padding:2px 6px;
  font-size:12px;
  border:1px solid #ccc;
  border-radius:3px;
  background:#fff;
  cursor:pointer;
}}
.menu-settings input[type="number"] {{ width:96px; cursor:text; }}
/* Sort bar: sits above the three setting columns, spans the full menu. */
.set-sort {{
  padding:4px 0 8px;
  margin-bottom:6px;
  border-bottom:1px solid #eee;
}}
.set-sort .set-title {{ border-top:none; margin-top:0; }}
.set-sort-row {{
  display:flex;
  gap:8px;
  padding:2px 6px;
}}
.set-sort-row select {{ flex:1; min-width:0; }}
.btn-reset {{
  display:block;
  width:calc(100% - 16px);
  margin:4px 8px 8px;
  padding:6px 12px;
  min-height:32px;
  font-size:12px;
  border:1px solid #ccc;
  border-radius:4px;
  background:#f4f6f9;
  cursor:pointer;
}}
.btn-reset:hover {{ background:#e2e9f2; }}
.chart-wrap {{
  position:relative;
  width:100%;
  max-width:1100px;
  height:320px;
  margin:0 auto;
}}
.chart-wrap canvas {{ width:100% !important; height:100% !important; }}
@media (min-width: 768px) {{
  .chart-wrap {{ height:450px; }}
}}

/* Stats table: sort */
.table-toolbar {{ margin-bottom:12px; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; }}
.table-hint {{ font-size:12px; color:#666; }}
.btn-download {{
  padding:10px 20px;
  min-height:48px;
  font-size:14px;
  border:none;
  border-radius:4px;
  background:#28a745;
  color:#fff;
  cursor:pointer;
  white-space:nowrap;
}}
.btn-download:hover {{ background:#218838; }}
.btn-download:active {{ background:#1e7e34; }}
#stats-table thead th {{
  cursor:pointer;
  user-select:none;
  -webkit-user-select:none;
}}
#stats-table thead th:hover {{ background:#dde6f5; }}
#stats-table .th-sort {{ white-space:nowrap; }}
</style>
</head>
<body>

<h1>Yield Analysis by Main Group Description</h1>

<div class="top-row">
  <div class="tab-buttons">
    <button class="active" onclick="showTab('charts', this)">Trend Charts</button>
    <button onclick="showTab('stats', this)">Statistics Table</button>
  </div>
  {global_controls_html}
</div>

<div id="charts" class="tab-content active">
  {charts_display}
</div>

<div id="stats" class="tab-content">
  {table_display}
</div>

<script>
function downloadStatsExcel() {{
  var table = document.getElementById('stats-table');
  if (!table) return;
  var wb = XLSX.utils.table_to_book(table, {{sheet: "Statistics"}});
  // Remove the sort markers (▲/▼) that sorting appends to header cells
  var ws = wb.Sheets["Statistics"];
  if (ws && ws['!ref']) {{
    var range = XLSX.utils.decode_range(ws['!ref']);
    for (var c = range.s.c; c <= range.e.c; c++) {{
      var addr = XLSX.utils.encode_cell({{r: range.s.r, c: c}});
      if (ws[addr]) ws[addr].v = String(ws[addr].v).replace(/[▲▼]\\s*$/, '');
    }}
  }}
  XLSX.writeFile(wb, "yield_statistics.xlsx");
}}

function showTab(tabId, btn) {{
  var contents = document.getElementsByClassName('tab-content');
  for (var i = 0; i < contents.length; i++) {{
    contents[i].classList.remove('active');
  }}
  var buttons = document.getElementsByClassName('tab-buttons')[0].getElementsByTagName('button');
  for (var j = 0; j < buttons.length; j++) {{
    buttons[j].classList.remove('active');
  }}
  document.getElementById(tabId).classList.add('active');
  btn.classList.add('active');
  // Hide the chart settings while the statistics table is shown.
  document.body.classList.toggle('tab-stats', tabId === 'stats');
}}

function toggleDropdown(menuId) {{
  var menus = document.querySelectorAll('.dropdown-menu');
  for (var i = 0; i < menus.length; i++) {{
    if (menus[i].id !== menuId) menus[i].classList.remove('open');
  }}
  document.getElementById(menuId).classList.toggle('open');
}}

document.addEventListener('click', function (e) {{
  var node = e.target;
  while (node) {{
    if (node.classList && node.classList.contains('dropdown')) return;
    node = node.parentNode;
  }}
  var menus = document.querySelectorAll('.dropdown-menu');
  for (var i = 0; i < menus.length; i++) menus[i].classList.remove('open');
}});

function allCharts() {{
  return window.CHARTS || [];
}}

function toggleDataset(label) {{
  allCharts().forEach(function (chart) {{
    chart.data.datasets.forEach(function (ds) {{
      if (ds.label === label) ds.hidden = !ds.hidden;
    }});
    chart.update();
  }});
}}

// Per-line marker settings: each yield line has its own show/style/size.
var LINE_DEFS = [
  {{label: 'Planned Yield', show: 'mk_planned_show', style: 'mk_planned_style',
    size: 'mk_planned_size', defStyle: 'circle'}},
  {{label: 'True Yield', show: 'mk_true_show', style: 'mk_true_style',
    size: 'mk_true_size', defStyle: 'triangle'}},
  {{label: 'Overall Yield', show: 'mk_overall_show', style: 'mk_overall_style',
    size: 'mk_overall_size', defStyle: 'rect'}}
];

function lineDef(label) {{
  for (var i = 0; i < LINE_DEFS.length; i++) {{
    if (LINE_DEFS[i].label === label) return LINE_DEFS[i];
  }}
  return null;
}}

function applyMarkers() {{
  allCharts().forEach(function (chart) {{
    chart.data.datasets.forEach(function (ds) {{
      if (ds.type !== 'line') return;
      var def = lineDef(ds.label);
      if (!def) return;
      var show = document.getElementById(def.show).checked;
      var style = document.getElementById(def.style).value;
      var size = parseFloat(document.getElementById(def.size).value);
      if (isNaN(size) || size < 0) size = 0;
      ds.pointRadius = show ? size : 0;
      ds.pointHoverRadius = show ? Math.max(size + 2, 5) : 0;
      ds.pointStyle = style;
    }});
    chart.update();
  }});
}}

function applyAxis() {{
  [['y', 'yauto', 'ymin', 'ymax'], ['y1', 'y1auto', 'y1min', 'y1max']].forEach(function (c) {{
    var auto = document.getElementById(c[1]).checked;
    var mn = parseFloat(document.getElementById(c[2]).value);
    var mx = parseFloat(document.getElementById(c[3]).value);
    allCharts().forEach(function (chart) {{
      if (auto) {{
        delete chart.options.scales[c[0]].min;
        delete chart.options.scales[c[0]].max;
      }} else {{
        chart.options.scales[c[0]].min = isNaN(mn) ? undefined : mn;
        chart.options.scales[c[0]].max = isNaN(mx) ? undefined : mx;
      }}
      chart.update();
    }});
  }});
}}

// Typing a min/max while Auto is checked switches that axis to manual.
function axisManual(inputId, autoId) {{
  if (document.getElementById(inputId).value !== '') {{
    document.getElementById(autoId).checked = false;
  }}
  applyAxis();
}}

// Client-side sort for every chart (Settings -> Sort charts by). Each
// per-chart sort_meta window[] point is an array [WO, FMI_TOTAL,
// FMI_DATE ms], so the keys below are indexes into that array.
var SORT_KEYS = {{JDE_WO_NUMBER: 0, FMI_TOTAL: 1, FMI_DATE: 2}};

function sortKeyValue(meta, key) {{
  var v = meta[key];
  return (v == null || v === '') ? null : v;
}}

function applySort() {{
  var key = SORT_KEYS[document.getElementById('sortKey').value];
  if (key == null) return;
  var dir = document.getElementById('sortDir').value === 'desc' ? -1 : 1;
  allCharts().forEach(function (chart) {{
    var meta = window[chart.canvas.id + '_sort'];
    // Rebuild from the pristine arrays captured at chart creation; re-sorting
    // after previous re-sorts would otherwise double-permute the data.
    if (!meta || !meta.length || !chart._baseLabels) return;
    var order = [];
    for (var i = 0; i < meta.length; i++) order.push(i);
    order.sort(function (a, b) {{
      var va = sortKeyValue(meta[a], key);
      var vb = sortKeyValue(meta[b], key);
      var na = va == null, nb = vb == null;
      if (na || nb) return na && nb ? a - b : (na ? 1 : -1);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a - b;
    }});
    chart.data.labels = order.map(function (i) {{ return chart._baseLabels[i]; }});
    chart.data.datasets.forEach(function (ds, di) {{
      ds.data = order.map(function (i) {{ return chart._baseData[di][i]; }});
    }});
    chart.update();
  }});
}}

function resetSettings() {{
  // Series checkboxes (Yield Lines / Bars): back to all visible.
  document.querySelectorAll('input[id^="ds_"]').forEach(function (cb) {{
    cb.checked = true;
  }});
  allCharts().forEach(function (chart) {{
    chart.data.datasets.forEach(function (ds) {{ ds.hidden = false; }});
    chart.update();
  }});
  LINE_DEFS.forEach(function (d) {{
    document.getElementById(d.show).checked = true;
    document.getElementById(d.style).value = d.defStyle;
    document.getElementById(d.size).value = 4;
  }});
  document.getElementById('yauto').checked = true;
  document.getElementById('ymin').value = '';
  document.getElementById('ymax').value = '';
  document.getElementById('y1auto').checked = false;
  document.getElementById('y1min').value = 0;
  document.getElementById('y1max').value = '';
  // Sorting: back to the generated order (ascending by JDE_WO_NUMBER).
  document.getElementById('sortKey').value = 'JDE_WO_NUMBER';
  document.getElementById('sortDir').value = 'asc';
  applySort();
  applyMarkers();
  applyAxis();
}}

(function () {{
  var table = document.getElementById('stats-table');
  if (!table) return;
  var tbody = document.getElementById('stats-tbody');
  var rows = Array.prototype.slice.call(tbody.rows);
  var headers = table.querySelectorAll('thead th');
  var SORT_MARK = /[▲▼]\s*$/;

  function parseCell(text) {{
    var s = text.replace(/,/g, '').replace(/%/g, '');
    var n = parseFloat(s);
    return (s !== '' && !isNaN(n)) ? n : text;
  }}

  function sortRows(col, dir) {{
    rows.sort(function (a, b) {{
      var va = parseCell(a.cells[col].textContent);
      var vb = parseCell(b.cells[col].textContent);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), undefined, {{numeric: true}}) * dir;
    }});
    rows.forEach(function (r) {{ tbody.appendChild(r); }});
  }}

  for (var i = 0; i < headers.length; i++) {{
    (function (col, th) {{
      var sortEl = th.querySelector('.th-sort');
      th.addEventListener('click', function () {{
        for (var j = 0; j < headers.length; j++) {{
          var se = headers[j].querySelector('.th-sort');
          if (se) se.textContent = se.textContent.replace(SORT_MARK, '');
        }}
        var asc = th.getAttribute('data-dir') !== 'asc';
        th.setAttribute('data-dir', asc ? 'asc' : 'desc');
        sortRows(col, asc ? 1 : -1);
        sortEl.textContent += asc ? ' ▲' : ' ▼';
      }});
    }})(i, headers[i]);
  }}
}})();
</script>

</body>
</html>
"""

# Save the report to the user's Downloads folder (create it if needed); the OS
# temp folder is used only as a fallback when Downloads cannot be written.
output_name = f"yield_trend_charts_{datetime.now():%Y%m%d_%H%M%S}.html"
candidates = [
    Path.home() / "Downloads",                               # standard Downloads (default)
    Path(tempfile.gettempdir()) / "yield_trend",             # temp folder fallback only
]
output_path = None
for folder in candidates:
    try:
        folder.mkdir(parents=True, exist_ok=True)
        candidate = folder / output_name
        with open(candidate, "w", encoding="utf-8") as f:
            f.write(html_content)
        output_path = candidate
        break
    except OSError:
        continue
if output_path is None:
    raise OSError("Could not write the report to any known folder (permission denied).")

print(f"Charts generated: {output_path}")
webbrowser.open(output_path.as_uri())