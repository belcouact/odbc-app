#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze-process-params.py

Generate ONE self-contained HTML dashboard that overlays every parameter column
on a single ECharts line chart, with Date_Time on the x-axis. There are no top
bar controllers (no search box, no datetime pickers, no Apply button) — just the
chart, zoomable with ECharts built-in slider + inside dataZoom.

Built with Apache ECharts (canvas).

Two ways to run it:
  * In the app's script editor — the grid rows are injected automatically as a
    module-level ``data`` variable (a list of dicts); no flags needed, and the
    HTML is written to the Downloads folder (OS temp folder as a fallback only).
  * Standalone:
        python analyze-process-params.py                        # uses the sql_*.xlsx in this folder
        python analyze-process-params.py --input file.xlsx
        python analyze-process-params.py --output out.html
"""

import argparse
import json
import os
import sys
import tempfile
import urllib.request
import webbrowser
from pathlib import Path

import pandas as pd

# Columns that are NOT parameters (metadata / context) - never charted.
EXCLUDE_COLUMNS = {"WOL", "Prefix", "Suffix", "Date_Time", "WCenter", "Operation", "Product"}

# Extra metadata used only for grouping / hover - never charted.
META_COLUMNS = {"DEVICE_NUM", "EVENT_ID"}

ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"


def find_default_input():
    folder = Path(__file__).resolve().parent
    for pattern in ("sql_*.xlsx", "*.xlsx", "*.csv"):
        matches = sorted(folder.glob(pattern))
        if matches:
            return matches[-1]
    return None


def resolve_output_dir() -> Path:
    """User's Downloads folder first; OS temp folder as a fallback only."""
    fallback = Path(tempfile.gettempdir()) / "param_trend"
    for cand in (Path.home() / "Downloads", fallback):
        try:
            cand.mkdir(parents=True, exist_ok=True)
            probe = cand / ".pp_write_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
            return cand
        except OSError:
            continue
    return fallback


def load_frame(path):
    suffix = path.suffix.lower()
    if suffix == ".csv":
        df = pd.read_csv(path)
    else:
        df = pd.read_excel(path)
    df.columns = [str(c).strip() for c in df.columns]
    return df


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parameter Trend Dashboard</title>
<style>
  :root { --bg:#f6f8fb; --text:#1f2933; }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); }
  /* single full-height chart; no top bar controllers */
  .chart { height:100vh; width:100%; padding:8px; }
</style>
</head>
<body>
<div id="chart" class="chart"></div>

__ECHARTS__
<script>
const rows = __DATA__;
const parameterColumns = __PARAM_COLS__;

const rowsSorted = rows.slice().sort((a, b) => new Date(a['Date_Time']) - new Date(b['Date_Time']));

const chart = echarts.init(document.getElementById('chart'), null, { renderer:'canvas' });

const option = {
  color: ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452',
          '#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452'],
  title: {
    text: 'Multi-Parameter Trend Over Time',
    left: 'center'
  },
  tooltip: {
    trigger: 'axis',
    formatter: function (params) {
      if (!params || !params.length) return '';
      var row = rowsSorted[params[0].dataIndex] || {};
      var esc = function (s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      };
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      var d = new Date(params[0].value[0]);
      // WOL sits at the top of the hint so you can see the wafer lot first.
      var head =
        '<div style="margin-bottom:4px;"><b>WOL:</b> ' +
        (row['WOL'] == null || row['WOL'] === '' ? '&mdash;' : esc(row['WOL'])) + '</div>' +
        '<div style="margin-bottom:4px;">' + d.getFullYear() + '-' +
        pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '</div>';
      var rows = [];
      for (var i = 0; i < params.length; i++) {
        var v = params[i].value[1];
        var txt = (v == null) ? '&mdash;' : String(Math.round(v * 1000000) / 1000000);
        rows.push(params[i].marker + ' ' + params[i].seriesName + ': ' + txt);
      }
      return head + rows.join('<br/>');
    }
  },
  legend: {
    type: 'scroll',
    top: 30,
    left: 'center',
    data: parameterColumns
  },
  grid: {
    left: 70,
    right: 30,
    top: 70,
    bottom: 80
  },
  xAxis: {
    type: 'time',
    name: 'Date_Time',
    axisLabel: {
      hideOverlap: true
    }
  },
  yAxis: {
    type: 'value',
    name: 'Value',
    scale: true
  },
  dataZoom: [
    {
      type: 'slider',
      xAxisIndex: 0,
      height: 20,
      bottom: 20,
      start: 0,
      end: 100,
      brushSelect: true,
      zoomLock: false
    },
    {
      type: 'inside',
      xAxisIndex: 0,
      start: 0,
      end: 100
    }
  ],
  series: parameterColumns.map(param => ({
    name: param,
    type: 'line',
    showSymbol: false,
    smooth: false,
    data: rowsSorted.map(r => [new Date(r['Date_Time']).getTime(), r[param]])
  }))
};

chart.setOption(option);
window.addEventListener('resize', () => chart.resize());
</script>
</body>
</html>
"""


def embed_echarts():
    """Inline ECharts so the html is fully standalone.

    Prefer the library bundled with the app (works offline in the script editor
    and in the packaged EXE); fall back to the CDN when it is not importable.
    """
    try:
        from app.resources.echarts import get_echarts_js
        js = get_echarts_js()
    except Exception as exc:  # noqa: BLE001 - app modules not importable standalone
        print(f"Warning: could not use bundled ECharts ({exc}); trying CDN.")
        try:
            with urllib.request.urlopen(ECHARTS_CDN, timeout=25) as r:
                js = r.read().decode("utf-8")
        except Exception as exc2:  # noqa: BLE001
            print(f"Warning: could not embed ECharts ({exc2}); using CDN reference instead.")
            return f'<script src="{ECHARTS_CDN}"></script>'
    js = js.replace("</script", "<\\/script")
    return "<script>" + js + "</script>"


def main():
    parser = argparse.ArgumentParser(description="Generate a single-chart parameter trend HTML dashboard with ECharts.")
    parser.add_argument("--input", help="Input .xlsx / .csv. Defaults to the sql_*.xlsx in this folder.")
    parser.add_argument("--output", help="Output HTML path. Defaults to ~/Downloads/param_trend_<timestamp>.html.")
    args = parser.parse_args()

    # Running inside the app's script editor: the selected grid rows are injected
    # as a module-level `data` variable (a list of dicts).
    rows = globals().get("data")
    if rows is not None:
        if not rows:
            sys.exit("No data supplied — select at least one grid row in the script editor.")
        df = pd.DataFrame(list(rows))
        input_path = None
    else:
        input_path = Path(args.input) if args.input else find_default_input()
        if not input_path or not input_path.exists():
            sys.exit(f"Input file not found. Provide --input <file>. Looked in: {Path('.').resolve()}")
        df = load_frame(input_path)

    # Default save folder is the user's Downloads folder; the OS temp folder is
    # only used as a fallback when Downloads cannot be written.
    output_path = Path(args.output) if args.output else resolve_output_dir()

    if "Date_Time" not in df.columns:
        sys.exit("Column 'Date_Time' not found in the input data.")

    # Normalise the time axis and drop rows without a valid timestamp.
    df = df.copy()
    df["Date_Time"] = pd.to_datetime(df["Date_Time"], errors="coerce")
    df = df.dropna(subset=["Date_Time"]).sort_values("Date_Time").reset_index(drop=True)
    if df.empty:
        sys.exit("No rows with a valid 'Date_Time' value.")

    param_cols = [c for c in df.columns if c not in EXCLUDE_COLUMNS and c not in META_COLUMNS]
    if not param_cols:
        sys.exit("No parameter columns found to chart.")

    # Ship the rows to the browser as plain JSON (timestamps as ISO strings, NaN -> null).
    df["Date_Time"] = df["Date_Time"].dt.strftime("%Y-%m-%dT%H:%M:%S")
    rows_json = df.where(pd.notna(df), None).to_dict(orient="records")

    html = (HTML_TEMPLATE
            .replace("__ECHARTS__", embed_echarts())
            .replace("__DATA__", json.dumps(rows_json, ensure_ascii=False, separators=(",", ":")))
            .replace("__PARAM_COLS__", json.dumps(param_cols, ensure_ascii=False, separators=(",", ":"))))

    if output_path.is_dir():
        output_path = output_path / f"param_trend_{pd.Timestamp.now():%Y%m%d_%H%M%S}.html"
    else:
        output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding="utf-8")

    print(f"Input : {input_path if input_path else 'grid data'}")
    print(f"Rows  : {df.shape[0]} x {df.shape[1]}")
    print(f"Charts: 1 (all {len(param_cols)} parameter(s) overlaid)")
    print(f"Size  : {output_path.stat().st_size / 1024 / 1024:.1f} MB")
    # Remind the user where the report was saved, then open it in the browser.
    print(f"Charts generated: {output_path}")
    webbrowser.open(output_path.as_uri())


if __name__ == "__main__":
    main()
