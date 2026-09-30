"""
Standalone lab-results analysis for laminates.

Before the analysis runs, a native Windows dialog lists every test component
(ANALYSIS + RESULT_NAME) found in the data and lets the user uncheck the ones
to leave out; only the checked components are analyzed. Set the environment
variable LAMINATE_SKIP_PICKER=1 to skip the dialog and analyze everything
(used by automated runs; also the fallback when PowerShell/native UI is not
available).

Grouping (hierarchy ignored): (MG_DESC, ANALYSIS, RESULT_NAME)
  #1  Profiling          - per-group stats + out-of-spec overview
  #2  Capability         - Cp/Cpk/Ppk + histograms       [numeric results]
  #3  SPC I-MR charts    - control limits                [numeric results]
  #4  Categorical Pareto - category counts               [categorical results]

Spec rules (SPEC_RULE column):
  'Result >= Min'          -> lower-side spec only: LSL used, USL ignored
                              (a raw USL of 0 on these rows is a sentinel).
  'Result <= Max'          -> upper-side spec only: USL used, LSL ignored.
  mentions both MIN & MAX  -> two-sided spec.
The non-applicable limit is excluded from Cp/Cpk/Ppk and is NOT drawn on the
capability chart. Cp/Pp are reported only for two-sided specs.

Output: ONE self-contained HTML (Laminate_Analysis.html) - a statistical &
capability summary page whose rows are searchable/filterable; clicking a
laminate (MG_DESC) opens its capability / SPC / Pareto charts in pop-up
modals. The file is saved to the user's Downloads folder, falling back to
the OS temp folder when Downloads is not writable.

Performance notes: numeric/date/out-of-spec flags are computed ONCE on the
whole frame; per-group metadata comes from a single vectorized groupby
aggregation; SPC uses precomputed columns (no per-group re-parsing).
"""
import os
import json
import time
import shutil
import tempfile
import subprocess
import webbrowser
from pathlib import Path
import numpy as np
import pandas as pd
from app.resources.echarts import get_echarts_js

# ----------------------------------------------------------------------------
# CONFIG
# ----------------------------------------------------------------------------
# Input comes from the grid/query rows (the `data` variable) supplied by the
# script editor; output HTML is written to Downloads (temp folder fallback).
NUM_THRESHOLD = 0.90
MIN_CAP_POINTS = 5        # capability / stats require at least 5 data points
MIN_SPC_POINTS = 5        # I-MR chart requires at least 5 WOL subgroups
CPK_GOOD = 1.33
CPK_MARGINAL = 1.00

GROUP_COLS = ["MG_DESC", "ANALYSIS", "RESULT_NAME"]

# Optional overrides for any RESULT_NAME that auto-detections get wrong.
MANUAL_CATEGORICAL = []
MANUAL_NUMERIC = []


# ----------------------------------------------------------------------------
# HELPERS
# ----------------------------------------------------------------------------
def resolve_output_dir() -> str:
    """Downloads folder first; OS temp folder as fallback."""
    downloads = os.path.join(os.path.expanduser("~"), "Downloads")
    fallback = os.path.join(tempfile.gettempdir(), "laminate_analysis")
    for cand in (downloads, fallback):
        try:
            os.makedirs(cand, exist_ok=True)
            probe = os.path.join(cand, ".lam_write_probe")
            with open(probe, "w", encoding="utf-8") as f:
                f.write("ok")
            os.remove(probe)
            return cand
        except OSError:
            continue
    return fallback


def spec_side(rule, lsl, usl) -> str:
    """Classify the applicable spec side.

    Returns 'lower' (LSL only), 'upper' (USL only), 'both', or 'none'.
    """
    r = str(rule or "").strip().lower()
    has_min, has_max = "min" in r, "max" in r
    if has_min and has_max:
        side = "both"
    elif has_min:
        side = "lower"
    elif has_max:
        side = "upper"
    else:
        side = "none"
    if side == "none":
        # No usable rule: infer from the limits themselves.
        l_ok, u_ok = pd.notna(lsl), pd.notna(usl)
        if l_ok and u_ok and usl > lsl:
            side = "both"
        elif l_ok:
            side = "lower"
        elif u_ok and usl != 0:   # USL==0 with no rule/LSL is a sentinel
            side = "upper"
    if side == "lower" and pd.isna(lsl):
        side = "none"
    if side == "upper" and pd.isna(usl):
        side = "none"
    if side == "both" and (pd.isna(lsl) or pd.isna(usl) or not usl > lsl):
        side = "none"
    return side


def axis_rotate(labels, default: int = 0) -> int:
    """Rotate category x-axis labels 90° when any label is long, else ``default``."""
    if any(len(str(s)) > 8 for s in labels):
        return 90
    return default


def _key_eq(a, b) -> bool:
    """NaN-aware equality for group key tuples."""
    for p, q in zip(a, b):
        if pd.isna(p) and pd.isna(q):
            continue
        try:
            if p != q:
                return False
        except (TypeError, ValueError):
            return False
    return True


# ----------------------------------------------------------------------------
# SINGLE-FILE DASHBOARD (summary page + modal pop-ups)
# ----------------------------------------------------------------------------
def _str(v):
    if v is None:
        return ""
    try:
        if pd.isna(v):
            return ""
    except (TypeError, ValueError):
        pass
    return v


def _norm(v):
    if isinstance(v, np.floating):
        return float(v)
    if isinstance(v, np.integer):
        return int(v)
    return v


def _num_or_blank(v):
    """Numeric value for JSON, or '' when null/NaN (JSON has no NaN)."""
    try:
        if v is None or pd.isna(v):
            return ""
    except (TypeError, ValueError):
        pass
    return _norm(v)


def write_single_html(master, charts, echarts_js, out_path):
    """One self-contained page: searchable summary table, with each laminate's
    charts (capability / SPC / Pareto) opened in pop-up modals."""
    by_mg = {}
    for kind in ("cap", "spc", "par"):
        for c in charts[kind]:
            by_mg.setdefault(c["MG_DESC"], []).append(c)

    def _kind_ord(c):
        # Group by chart type in the modal: all Capability, then SPC, then
        # Pareto — so each type forms a predictable block (Pareto is no
        # longer interleaved between dozens of SPC cards).
        h = c["header"]
        if h.startswith("Capability"):
            return 0
        if h.startswith("SPC"):
            return 1
        return 2

    for items in by_mg.values():
        items.sort(key=lambda c: (_kind_ord(c), c["ANALYSIS"], c["RESULT_NAME"]))

    fig_payload = {mg: [{"h": it["header"], "ht": it["height"], "o": it["option"]}
                        for it in items] for mg, items in by_mg.items()}

    rows = []
    for _, r in master.iterrows():
        # All rows are listed: numeric rows carry stats, categorical rows show
        # their Pareto breakdown via the laminate modal (filter chips there).
        rows.append({
            "mg": _str(r.get("MG_DESC")), "mgrp": _str(r.get("MAIN_GROUP")),
            "an": _str(r.get("ANALYSIS")),
            "rn": _str(r.get("RESULT_NAME")), "type": _str(r.get("TYPE")),
            "n": _num_or_blank(r.get("N")),
            "mean": _num_or_blank(r.get("MEAN")),
            "std": _num_or_blank(r.get("STD")),
            "lsl": _num_or_blank(r.get("LSL")),
            "usl": _num_or_blank(r.get("USL")),
            "cp": _num_or_blank(r.get("Cp")),
            "cpk": _num_or_blank(r.get("Cpk")),
            "verdict": _str(r.get("VERDICT")),
            "nwol": _num_or_blank(r.get("N_WOL")),
            "nooc": _num_or_blank(r.get("N_OOC")),
            "oos": _num_or_blank(r.get("OUT_OF_SPEC_PCT")),
        })

    rows_js = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    fig_js = json.dumps(fig_payload, ensure_ascii=False, separators=(",", ":"))

    tpl = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Laminate Analysis — Statistical &amp; Capability Summary</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f4f6f8;color:#222}
header{background:#1f3a5f;color:#fff;padding:14px 24px;position:sticky;top:0;z-index:5}
.hdr{display:flex;justify-content:space-between;align-items:center;gap:12px;max-width:1500px;margin:0 auto}
h1{margin:0;font-size:20px}h2{margin:0;font-size:16px}
.xbtn{background:#fff;color:#1f3a5f;border:none;border-radius:6px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;min-height:48px;white-space:nowrap}
.xbtn:hover{background:#e2e9f2}
.wrap{max-width:1500px;margin:0 auto;padding:16px}
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
input,select{font-size:14px;padding:8px 10px;border:1px solid #ccc;border-radius:6px;min-height:40px}
.controls input{flex:1;min-width:160px}
.count{color:#666;font-size:13px;margin-left:auto}
.card-title{font-weight:600;font-size:14px;margin-bottom:8px;color:#1f3a5f}
.chart{width:100%;max-width:100%;overflow:hidden;position:relative}
.table-wrap{overflow:auto}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border:1px solid #ddd;padding:5px 6px;text-align:center;white-space:nowrap;vertical-align:middle}
thead th{background:#eef2f7}
thead th.sortable{cursor:pointer;user-select:none}
thead th.sortable:hover{background:#dce4ee}
.arrow{display:inline-block;margin-left:4px;font-size:11px;color:#1f3a5f}
.mg-link{color:#1f3a5f;font-weight:600;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;padding:4px;min-height:48px}
.mg-link:hover{text-decoration:underline;color:#294d7c}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:50;overflow:auto}
.modal-box{background:#f4f6f8;min-height:100%;width:100%;max-width:none;margin:0;border-radius:0;box-shadow:none}
.modal-head{position:sticky;top:0;background:#1f3a5f;color:#fff;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;z-index:2}
.close{background:none;border:none;color:#fff;font-size:28px;cursor:pointer;line-height:1;min-width:48px;min-height:48px}
.modal-body{padding:16px}
.mchips{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px 0}
.chip{background:#fff;border:1px solid #c6d2e0;border-radius:18px;padding:8px 16px;font-size:12px;font-weight:600;color:#1f3a5f;cursor:pointer;min-height:40px}
.chip:hover{background:#e2e9f2}
.chip.active{background:#1f3a5f;color:#fff;border-color:#1f3a5f}
.charts{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.card{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);padding:12px;min-width:0;overflow:hidden}
@media(max-width:1024px){ .charts{grid-template-columns:repeat(2,1fr)} }
@media(max-width:900px){
 .charts{grid-template-columns:1fr}.modal-body{padding:10px}
}
@media(max-width:640px){
 .wrap{padding:8px}.controls{gap:6px}.charts{grid-template-columns:1fr}
 h1{font-size:16px}.card-title{font-size:12px}
}
</style>
<script>@@ECHARTS@@</script></head>
<body>
<header><div class="hdr"><h1>Laminate Test Analysis — Statistical &amp; Capability Summary</h1>
    <button id="excel" class="xbtn">Export to Excel</button></div></header>
<div class="wrap">
  <div class="controls">
    <input id="qm" type="search" placeholder="Search laminate / main group...">
    <input id="qa" type="search" placeholder="Search analysis...">
    <select id="vf">
      <option value="all">All verdicts</option>
      <option value="Capable">Capable</option>
      <option value="Marginal">Marginal</option>
      <option value="Not Capable">Not Capable</option>
    </select>
    <span id="count" class="count"></span>
  </div>
  <div class="table-wrap">
    <table id="t"><thead><tr>
      <th class="sortable" data-i="0">Laminate (MG_DESC)<span class="arrow"></span></th>
      <th class="sortable" data-i="1">MAIN_GROUP<span class="arrow"></span></th>
      <th class="sortable" data-i="2">Analysis<span class="arrow"></span></th>
      <th class="sortable" data-i="3">Result<span class="arrow"></span></th>
      <th class="sortable" data-i="4">Type<span class="arrow"></span></th>
      <th class="sortable" data-i="5">N<span class="arrow"></span></th>
      <th class="sortable" data-i="6">Mean<span class="arrow"></span></th>
      <th class="sortable" data-i="7">Std<span class="arrow"></span></th>
      <th class="sortable" data-i="8">LSL<span class="arrow"></span></th>
      <th class="sortable" data-i="9">USL<span class="arrow"></span></th>
      <th class="sortable" data-i="10">Cp<span class="arrow"></span></th>
      <th class="sortable" data-i="11">Cpk<span class="arrow"></span></th>
      <th class="sortable" data-i="12">Verdict<span class="arrow"></span></th>
      <th class="sortable" data-i="13">N_WOL<span class="arrow"></span></th>
      <th class="sortable" data-i="14">OOC<span class="arrow"></span></th>
      <th class="sortable" data-i="15">OOS<span class="arrow"></span></th>
    </tr></thead>
      <tbody id="tbl-body"></tbody></table>
  </div>
</div>

<div class="modal" id="modal">
  <div class="modal-box">
    <div class="modal-head"><h2 id="modal-title"></h2>
      <button class="close" onclick="closeModal()" aria-label="Close">&times;</button></div>
    <div id="mchips" class="mchips"></div>
    <div class="modal-body"><div id="modal-content" class="charts"></div></div>
  </div>
</div>

<script>
var ROWS = @@ROWS@@;
var FIG = @@FIG@@;
function fmt(v,d){ if(v===""||v===null||typeof v==="undefined") return "\\u2013";
  if(typeof v!=="number") return v; return v.toFixed(d); }
function oosVal(v){ if(v===""||v===null||typeof v==="undefined") return ""; return Number(v).toFixed(1)+"%"; }
function oosStr(v){ var s=oosVal(v); return s===""?"\\u2013":s; }
function filterRows(){
  var qm=(document.getElementById("qm").value||"").trim().toLowerCase();
  var qa=(document.getElementById("qa").value||"").trim().toLowerCase();
  var vf=document.getElementById("vf").value, out=[];
  ROWS.forEach(function(r){
    if(vf!=="all" && r.verdict!==vf) return;
    if(qm && (String(r.mg)+" "+String(r.mgrp)).toLowerCase().indexOf(qm)===-1) return;
    if(qa && String(r.an).toLowerCase().indexOf(qa)===-1) return;
    out.push(r);
  });
  return out;
}
var SORT_KEY=["mg","mgrp","an","rn","type","n","mean","std","lsl","usl","cp","cpk","verdict","nwol","nooc","oos"];
var sortCol=-1, sortDir=1;
function sortFn(){
  var k=SORT_KEY[sortCol], d=sortDir;
  return function(a,b){
    var va=a[k], vb=b[k];
    var na=(va==null||va===""||(typeof va==="number"&&isNaN(va)));
    var nb=(vb==null||vb===""||(typeof vb==="number"&&isNaN(vb)));
    if(na&&nb) return 0;
    if(na) return 1;
    if(nb) return -1;
    if(typeof va==="number"&&typeof vb==="number") return d*(va-vb);
    return d*String(va).localeCompare(String(vb));
  };
}
function render(){
  var tb=document.getElementById("tbl-body"); tb.innerHTML="";
  var rows=filterRows();
  if(sortCol>=0){ rows.sort(sortFn()); }
  rows.forEach(function(r){
    var tr=document.createElement("tr");
    var td0=document.createElement("td");
    var a=document.createElement("a"); a.className="mg-link"; a.href="#"; a.textContent=r.mg;
    a.onclick=(function(m){return function(e){e.preventDefault(); openModal(m);};})(r.mg); td0.appendChild(a); tr.appendChild(td0);
    [r.mgrp||"\\u2013",r.an,r.rn,r.type,fmt(r.n,0),fmt(r.mean,3),fmt(r.std,3),fmt(r.lsl,3),fmt(r.usl,3),
     fmt(r.cp,2),fmt(r.cpk,2),r.verdict||"\\u2013",fmt(r.nwol,0),fmt(r.nooc,0),oosStr(r.oos)]
      .forEach(function(v){ var td=document.createElement("td"); td.textContent=v; tr.appendChild(td); });
    tb.appendChild(tr);
  });
  document.getElementById("count").textContent=rows.length+" of "+ROWS.length+" test components";
}
function exportExcel(){
  var rows=filterRows();
  var cols=["MG_DESC","MAIN_GROUP","Analysis","Result","Type","N","Mean","Std","LSL","USL","Cp","Cpk","Verdict","N_WOL","OOC","OOS"];
  var lines=[cols].concat(rows.map(function(r){ return [r.mg,r.mgrp,r.an,r.rn,r.type,fmt(r.n,0),fmt(r.mean,3),fmt(r.std,3),fmt(r.lsl,3),fmt(r.usl,3),fmt(r.cp,2),fmt(r.cpk,2),r.verdict||"",fmt(r.nwol,0),fmt(r.nooc,0),oosVal(r.oos)]; }));
  var csv=lines.map(function(row){ return row.map(function(v){ v=String(v==null?"":v); return /[",\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(","); }).join("\\r\\n");
  var blob=new Blob(["\\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
  var a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="laminate_summary.csv"; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
var CHART_INSTANCES={};
var CUR_MG=null, CUR_KIND='all';
function kindOf(h){
  if(h.indexOf('Capability')===0) return 'cap';
  if(h.indexOf('SPC')===0) return 'spc';
  if(h.indexOf('Pareto')===0) return 'par';
  return 'other';
}
var KINDS=[['all','All'],['cap','Capability'],['spc','SPC'],['par','Pareto']];
function renderModal(){
  var wrap=document.getElementById("modal-content"); wrap.innerHTML="";
  Object.keys(CHART_INSTANCES).forEach(function(k){ CHART_INSTANCES[k].dispose(); });
  CHART_INSTANCES={};
  var all=FIG[CUR_MG]||[];
  var items=all.filter(function(it){ return CUR_KIND==='all'||kindOf(it.h)===CUR_KIND; });
  items.forEach(function(item,i){
    var card=document.createElement("div"); card.className="card";
    var t=document.createElement("div"); t.className="card-title"; t.textContent=item.h; card.appendChild(t);
    var c=document.createElement("div"); c.className="chart"; c.id="m"+i;
    c.style.height=(item.ht||420)+"px"; card.appendChild(c);
    wrap.appendChild(card);
    var inst=echarts.init(c); inst.setOption(item.o);
    CHART_INSTANCES["m"+i]=inst;
  });
  var bar=document.getElementById("mchips"); bar.innerHTML="";
  KINDS.forEach(function(kd){
    var n=(kd[0]==='all')?all.length:all.filter(function(it){ return kindOf(it.h)===kd[0]; }).length;
    if(kd[0]!=='all' && n===0) return;
    var b=document.createElement("button");
    b.className="chip"+(CUR_KIND===kd[0]?" active":"");
    b.textContent=kd[1]+" ("+n+")";
    b.onclick=(function(k){ return function(){ CUR_KIND=k; renderModal(); }; })(kd[0]);
    bar.appendChild(b);
  });
  requestAnimationFrame(function(){ Object.keys(CHART_INSTANCES).forEach(function(k){ CHART_INSTANCES[k].resize(); }); });
}
function openModal(mg){
  CUR_MG=mg; CUR_KIND='all';
  document.getElementById("modal-title").textContent=mg+" \\u2014 Analysis Dashboard";
  document.getElementById("modal").style.display="block"; document.body.style.overflow="hidden";
  renderModal();
}
function closeModal(){
  Object.keys(CHART_INSTANCES).forEach(function(k){ CHART_INSTANCES[k].dispose(); });
  CHART_INSTANCES={};
  document.getElementById("modal").style.display="none";
  document.getElementById("modal-content").innerHTML=""; document.body.style.overflow="";
  document.getElementById("mchips").innerHTML="";
}
document.getElementById("modal").addEventListener("click",function(e){ if(e.target.id==="modal") closeModal(); });
window.addEventListener("resize",function(){ Object.keys(CHART_INSTANCES).forEach(function(k){ CHART_INSTANCES[k].resize(); }); });
function setSort(i){
  if(sortCol===i){ sortDir=-sortDir; } else { sortCol=i; sortDir=1; }
  updateArrows();
  render();
}
function updateArrows(){
  document.querySelectorAll("thead th.sortable").forEach(function(th){
    var i=+th.getAttribute("data-i");
    var sp=th.querySelector(".arrow");
    if(!sp){ sp=document.createElement("span"); sp.className="arrow"; th.appendChild(sp); }
    sp.textContent=(i===sortCol)?(sortDir===1?"\\u25B2":"\\u25BC"):"";
  });
}
document.addEventListener("DOMContentLoaded",function(){
  document.getElementById("qm").addEventListener("input",render);
  document.getElementById("qa").addEventListener("input",render);
  document.getElementById("vf").addEventListener("change",render);
  document.getElementById("excel").addEventListener("click",exportExcel);
  document.querySelectorAll("thead th.sortable").forEach(function(th){
    th.addEventListener("click",function(){ setSort(+th.getAttribute("data-i")); });
  });
  render();
});
</script>
</body></html>"""
    tpl = (tpl.replace("@@ROWS@@", rows_js)
              .replace("@@FIG@@", fig_js)
              .replace("@@ECHARTS@@", echarts_js))
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(tpl)


# ----------------------------------------------------------------------------
# CHART OPTION BUILDERS
# ----------------------------------------------------------------------------
def _cap_option(x, mean, sd, lsl, usl, side, cp, cpl, cpu, cpk, dppm, verdict,
                rn, units):
    """Capability histogram + normal fit + applicable spec/mean lines only."""
    lo_c = [float(x.min()), mean - 3 * sd]
    hi_c = [float(x.max()), mean + 3 * sd]
    if side in ("lower", "both"):
        lo_c.append(float(lsl)); hi_c.append(float(lsl))
    if side in ("upper", "both"):
        lo_c.append(float(usl)); hi_c.append(float(usl))
    lo, hi = min(lo_c), max(hi_c)
    if hi <= lo:
        hi = lo + 1.0
    xs = np.linspace(lo, hi, 200)
    ys = np.exp(-0.5 * ((xs - mean) / sd) ** 2) / (sd * np.sqrt(2 * np.pi))
    counts, bin_edges = np.histogram(
        x, bins=min(40, max(10, int(np.sqrt(len(x))))), density=True)
    centers = (bin_edges[:-1] + bin_edges[1:]) / 2
    bar_data = [[float(c), float(d)] for c, d in zip(centers, counts)]
    line_data = [[float(a), float(b)] for a, b in zip(xs, ys)]

    # Stagger the three line labels vertically (distance along the vertical
    # line from its top end): they all sit above the grid and would otherwise
    # collide when two lines are close (e.g. "LSL=15" vs "USL=225").
    mark_data = []
    if side in ("lower", "both"):
        mark_data.append({
            "xAxis": float(lsl),
            "lineStyle": {"color": "#d64541", "type": "dashed", "width": 1.5},
            "label": {"formatter": f"LSL={lsl:.4g}", "fontSize": 10,
                      "color": "#d64541", "position": "end", "distance": 24}})
    if side in ("upper", "both"):
        mark_data.append({
            "xAxis": float(usl),
            "lineStyle": {"color": "#d64541", "type": "dashed", "width": 1.5},
            "label": {"formatter": f"USL={usl:.4g}", "fontSize": 10,
                      "color": "#d64541", "position": "end", "distance": 6}})
    mark_data.append({
        "xAxis": float(mean),
        "lineStyle": {"color": "#2e8b57", "width": 1.5},
        "label": {"formatter": f"Mean={mean:.4g}", "fontSize": 10,
                  "color": "#2e8b57", "position": "end", "distance": -8}})

    head = f"Cpk={cpk:.3f}"
    if side == "both":            # Cp/Pp are only defined for two-sided specs
        head = f"Cp={cp:.3f} · {head}"
    title = f"{head} · DPM={dppm:.0f} · {verdict}"
    x_name = f"{rn} ({units})" if units else str(rn)
    return {
        "animation": False,
        "title": {"text": title, "left": "left",
                  "textStyle": {"fontSize": 13, "fontWeight": "bold"}},
        "tooltip": {"trigger": "axis"},
        "legend": {"data": ["Observed", "Normal fit"], "top": "bottom",
                   "textStyle": {"fontSize": 11}},
        # bottom 74: room for the x-axis name AND the bottom legend without
        # overlapping.
        "grid": {"left": 60, "right": 30, "top": 56, "bottom": 74},
        "xAxis": {"type": "value", "name": x_name, "nameLocation": "middle",
                  "nameGap": 28, "nameTextStyle": {"fontSize": 11},
                  "axisLabel": {"fontSize": 10}, "scale": True},
        "yAxis": {"type": "value", "name": "Density",
                  "nameTextStyle": {"fontSize": 11},
                  "axisLabel": {"fontSize": 10}},
        "series": [
            {"type": "bar", "name": "Observed", "data": bar_data,
             "barWidth": "70%", "barMaxWidth": 40,
             "itemStyle": {"color": "#4e79a7", "borderRadius": [3, 3, 0, 0]},
             "markLine": {"symbol": "none", "silent": True, "data": mark_data}},
            {"type": "line", "name": "Normal fit", "data": line_data,
             "symbol": "none",
             "lineStyle": {"width": 2, "color": "#e07b39"},
             "itemStyle": {"color": "#e07b39"}},
        ],
    }


def _spc_option(labels, x_list, ooc_data, mr_list, lcl, cl, ucl, mrbar, ucl_mr,
                use_builtin):
    """I-MR chart with linked dataZoom; MR grid has no x-axis labels (they are
    already shown by the I chart above it)."""
    rot = axis_rotate(labels)

    def _mark(items):
        return {"symbol": "none", "silent": True,
                "data": [{"yAxis": float(v),
                          "lineStyle": {"color": c, "width": 1.2},
                          "label": {"formatter": f"{nm}={v:.4g}",
                                    "fontSize": 10, "color": c}}
                         for nm, v, c in items]}

    n_ooc = sum(1 for v in ooc_data if v is not None)
    return {
        "animation": False,
        # Title and legend on SEPARATE rows: on narrow charts (~430px, e.g.
        # 2-column modal grid on a 1024-1100px window / scaled display) a
        # shared row made them overlap.
        "title": {"text": f"limits: {'spec' if use_builtin else 'mean ± 3σ'} · OOC={n_ooc}",
                  "left": 8, "top": 2,
                  "textStyle": {"fontSize": 12, "fontWeight": "normal"}},
        "tooltip": {"trigger": "axis"},
        "legend": {"data": ["Individual", "Out-of-control", "MR"],
                   "top": 24, "right": 8, "itemWidth": 14, "itemHeight": 8,
                   "textStyle": {"fontSize": 11}},
        # top 50: clears the two header rows; right 72: room for the
        # UCL/CL/LCL value labels at the line ends (56 clipped "UCL=277.02").
        "grid": [
            {"left": 60, "right": 72, "top": 50, "height": "44%"},
            {"left": 60, "right": 72, "top": "64%", "height": "22%"},
        ],
        "dataZoom": [
            {"type": "inside", "xAxisIndex": [0, 1]},
            {"type": "slider", "xAxisIndex": [0, 1], "bottom": 4,
             "height": 16},
        ],
        "xAxis": [
            {"type": "category", "data": labels, "gridIndex": 0,
             "axisLabel": {"rotate": rot, "fontSize": 10}},
            {"type": "category", "data": labels, "gridIndex": 1,
             "axisLabel": {"show": False}, "axisTick": {"show": False}},
        ],
        "yAxis": [
            # No axis names: the legend already labels the series, and axis
            # names at the top of each grid overlapped the chart title.
            {"type": "value", "gridIndex": 0, "scale": True,
             "axisLabel": {"fontSize": 10}},
            {"type": "value", "gridIndex": 1, "scale": True,
             "axisLabel": {"fontSize": 10}},
        ],
        "series": [
            {"type": "line", "name": "Individual", "data": x_list,
             "xAxisIndex": 0, "yAxisIndex": 0, "symbol": "circle",
             "symbolSize": 5, "itemStyle": {"color": "#4e79a7"},
             "lineStyle": {"width": 1.5, "color": "#4e79a7"},
             "markLine": _mark([("UCL", ucl, "#d64541"),
                                ("CL", cl, "#2e8b57"),
                                ("LCL", lcl, "#d64541")])},
            {"type": "scatter", "name": "Out-of-control", "data": ooc_data,
             "xAxisIndex": 0, "yAxisIndex": 0, "symbolSize": 8,
             "itemStyle": {"color": "#d64541"}},
            {"type": "line", "name": "MR", "data": mr_list,
             "xAxisIndex": 1, "yAxisIndex": 1, "symbol": "circle",
             "symbolSize": 4, "itemStyle": {"color": "#e07b39"},
             "lineStyle": {"width": 1.2, "color": "#e07b39"},
             "markLine": _mark([("UCL", ucl_mr, "#d64541"),
                                ("MRbar", mrbar, "#2e8b57")])},
        ],
    }


def _pareto_option(idx, count_data, cum_data):
    """Pareto: sorted bars + cumulative % line; zoom slider for many categories."""
    n_cat = len(idx)
    rot = axis_rotate(idx, 30)
    has_zoom = n_cat > 20
    return {
        "animation": False,
        "tooltip": {"trigger": "axis"},
        "legend": {"data": ["Count", "Cumulative %"], "top": 2, "right": 8,
                   "textStyle": {"fontSize": 11}},
        "grid": {"left": 60, "right": 60, "top": 34,
                 "bottom": 66 if has_zoom else 54},
        "xAxis": {"type": "category", "data": idx,
                  "axisLabel": {"rotate": rot, "fontSize": 10,
                                "interval": 0 if n_cat <= 15 else "auto"}},
        "yAxis": [
            # No axis names: the legend already shows the same labels and the
            # names could clash with the top-right legend.
            {"type": "value", "axisLabel": {"fontSize": 10}},
            {"type": "value", "max": 105, "axisLabel": {"fontSize": 10}},
        ],
        "dataZoom": ([
            {"type": "inside", "xAxisIndex": [0]},
            {"type": "slider", "xAxisIndex": [0], "bottom": 4, "height": 16},
        ] if has_zoom else []),
        "series": [
            {"type": "bar", "name": "Count", "data": count_data,
             "barMaxWidth": 40,
             "itemStyle": {"color": "#4e79a7", "borderRadius": [3, 3, 0, 0]}},
            {"type": "line", "name": "Cumulative %", "data": cum_data,
             "yAxisIndex": 1, "symbol": "circle", "symbolSize": 5,
             "lineStyle": {"color": "#f28e2b", "width": 2},
             "itemStyle": {"color": "#f28e2b"}},
        ],
    }


# ----------------------------------------------------------------------------
# COMPONENT PICKER (native Windows dialog)
# ----------------------------------------------------------------------------
# The script editor runs scripts non-interactively (no stdin), and tkinter is
# not bundled with the packaged app, so the picker is a PowerShell/WinForms
# dialog launched as a child process: it reads the component list from a JSON
# file and writes the checked indices back to another JSON file.
PICKER_SKIP_ENV = "LAMINATE_SKIP_PICKER"
PICKER_TIMEOUT = 1800          # seconds to wait for the user's OK/Cancel

PICKER_PS = r"""
param([Parameter(Mandatory=$true)][string]$InPath,
      [Parameter(Mandatory=$true)][string]$OutPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$items = Get-Content -LiteralPath $InPath -Raw -Encoding UTF8 | ConvertFrom-Json

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Select test components to analyze'
$form.ClientSize = New-Object System.Drawing.Size(600, 560)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = 'Uncheck the components you do NOT want in the report:'
$lbl.SetBounds(12, 12, 576, 20)
$form.Controls.Add($lbl)

$list = New-Object System.Windows.Forms.CheckedListBox
$list.SetBounds(12, 36, 576, 460)
$list.CheckOnClick = $true
$list.IntegralHeight = $false
$list.Anchor = 'Top,Left,Right,Bottom'
$form.Controls.Add($list)

foreach ($it in $items) { [void]$list.Items.Add([string]$it.text, [bool]$it.checked) }

$btnAll = New-Object System.Windows.Forms.Button
$btnAll.Text = 'Select all'
$btnAll.SetBounds(12, 508, 100, 32)
$btnAll.Anchor = 'Bottom,Left'
$form.Controls.Add($btnAll)

$btnNone = New-Object System.Windows.Forms.Button
$btnNone.Text = 'Select none'
$btnNone.SetBounds(120, 508, 100, 32)
$btnNone.Anchor = 'Bottom,Left'
$form.Controls.Add($btnNone)

$btnOK = New-Object System.Windows.Forms.Button
$btnOK.Text = 'OK'
$btnOK.SetBounds(488, 508, 100, 32)
$btnOK.Anchor = 'Bottom,Right'
$form.Controls.Add($btnOK)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = 'Cancel'
$btnCancel.SetBounds(380, 508, 100, 32)
$btnCancel.Anchor = 'Bottom,Right'
$form.Controls.Add($btnCancel)

$form.AcceptButton = $btnOK
$form.CancelButton = $btnCancel
$form.Add_Shown({ $list.Focus() })

$script:ok = $false
$btnAll.Add_Click({
    for ($i = 0; $i -lt $list.Items.Count; $i++) { $list.SetItemChecked($i, $true) }
})
$btnNone.Add_Click({
    for ($i = 0; $i -lt $list.Items.Count; $i++) { $list.SetItemChecked($i, $false) }
})
$btnOK.Add_Click({ $script:ok = $true; $form.Close() })
$btnCancel.Add_Click({ $form.Close() })

[void]$form.ShowDialog()

if ($script:ok) {
    $sel = @()
    for ($i = 0; $i -lt $list.Items.Count; $i++) {
        if ($list.GetItemChecked($i)) { $sel += $i }
    }
    $out = '{"ok":true,"selected":[' + ($sel -join ',') + ']}'
} else {
    $out = '{"ok":false,"selected":[]}'
}
[System.IO.File]::WriteAllText($OutPath, $out, (New-Object System.Text.UTF8Encoding($false)))
"""


def component_pairs(df):
    """Distinct (ANALYSIS, RESULT_NAME) components in the frame, sorted."""
    seen = set()
    for an, rn in zip(df["ANALYSIS"].astype(str), df["RESULT_NAME"].astype(str)):
        seen.add((an, rn))
    return sorted(seen, key=lambda k: (k[0], k[1]))


def pick_components(df):
    """Ask which test components to analyze.

    Returns the selected (ANALYSIS, RESULT_NAME) pairs, or None meaning
    'analyze everything' (picker skipped, unavailable, or nothing checked).
    Raises when the user cancels the dialog.
    """
    if os.environ.get(PICKER_SKIP_ENV):
        print(f"Component picker skipped ({PICKER_SKIP_ENV} set) - analyzing all components.")
        return None
    if os.name != "nt":
        print("Component picker needs Windows - analyzing all components.")
        return None

    pairs = component_pairs(df)
    if len(pairs) <= 1:
        return None

    exe = shutil.which("powershell") or shutil.which("pwsh")
    if not exe:
        print("PowerShell not found - analyzing all components.")
        return None

    tmpdir = tempfile.mkdtemp(prefix="lam_pick_")
    ps_path = os.path.join(tmpdir, "picker.ps1")
    in_path = os.path.join(tmpdir, "items.json")
    out_path = os.path.join(tmpdir, "selection.json")
    try:
        with open(ps_path, "w", encoding="utf-8") as f:
            f.write(PICKER_PS)
        with open(in_path, "w", encoding="utf-8") as f:
            json.dump([{"text": f"{an} \u00b7 {rn}", "checked": True}
                       for an, rn in pairs], f, ensure_ascii=False)
        print(f"Waiting for the component selection dialog "
              f"({len(pairs)} components)...")
        subprocess.run(
            [exe, "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
             "-File", ps_path, in_path, out_path],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=PICKER_TIMEOUT)
        with open(out_path, encoding="utf-8-sig") as f:
            res = json.load(f)
    except subprocess.TimeoutExpired:
        print("Component selection timed out - analyzing all components.")
        return None
    except (OSError, ValueError) as exc:
        print(f"Component picker unavailable ({exc}) - analyzing all components.")
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not res.get("ok"):
        raise RuntimeError("Component selection cancelled - analysis aborted.")

    idx = res.get("selected") or []
    if isinstance(idx, int):
        idx = [idx]
    sel = [pairs[i] for i in idx
           if isinstance(i, int) and 0 <= i < len(pairs)]
    if not sel:
        print("No components selected - analyzing all components.")
        return None
    print(f"Selected {len(sel)} of {len(pairs)} components.")
    return sel


# ----------------------------------------------------------------------------
# MAIN
# ----------------------------------------------------------------------------
def main():
    t0 = time.perf_counter()
    out_dir = resolve_output_dir()
    rows = globals().get("data")
    if not rows:
        raise RuntimeError(
            "No data supplied. Run this script from the grid/query editor so the "
            "selected rows are passed in as `data`."
        )
    df = pd.DataFrame(rows)
    print(f"Loaded {df.shape[0]} rows x {df.shape[1]} cols")
    if df.empty:
        raise RuntimeError("Input data is empty.")
    missing = [c for c in GROUP_COLS + ["RESPONSE2"] if c not in df.columns]
    if missing:
        raise RuntimeError(f"Missing required columns: {missing}")

    # ---- Let the user choose which test components to analyze ----
    chosen = pick_components(df)
    if chosen is not None:
        keep_comp = set(chosen)
        mask = pd.Series(
            [(a, r) in keep_comp for a, r in
             zip(df["ANALYSIS"].astype(str), df["RESULT_NAME"].astype(str))],
            index=df.index)
        df = df[mask].copy()
        if df.empty:
            raise RuntimeError("No rows left after component selection.")
        print(f"Analyzing {df.shape[0]} rows for the selected components")

    # ---- Precompute once on the whole frame (replaces per-group parsing) ----
    df["_num"] = pd.to_numeric(df["RESPONSE2"], errors="coerce")
    if "LAM_DATE" in df.columns:
        df["_date"] = pd.to_datetime(df["LAM_DATE"], errors="coerce", utc=True)
    else:
        df["_date"] = pd.NaT
    if "IN_SPEC" in df.columns:
        df["_oos"] = df["IN_SPEC"].eq("F")
    else:
        df["_oos"] = False
    if "WOL" not in df.columns:
        df["WOL"] = ""
    df["_wol"] = df["WOL"].astype(str)
    for c in ("LSL", "USL", "LCL", "UCL"):
        df[c] = pd.to_numeric(df[c], errors="coerce") if c in df.columns else np.nan
    for c in ("MAIN_GROUP", "DESCRIPTION", "UNITS"):
        if c not in df.columns:
            df[c] = ""
    if "SPEC_RULE" not in df.columns:
        df["SPEC_RULE"] = ""

    keep = list(dict.fromkeys(
        GROUP_COLS + ["RESPONSE2", "_num", "_date", "_oos", "_wol", "WOL",
                      "MAIN_GROUP", "DESCRIPTION", "UNITS", "LSL", "USL",
                      "SPEC_RULE", "LCL", "UCL"]))
    d2 = df[keep]
    gb = d2.groupby(GROUP_COLS, sort=False, dropna=False)

    # Vectorized per-group metadata (single pass; replaces 27k+ lambda calls).
    meta = gb.agg(
        SIZE=("RESPONSE2", "size"),
        N=("RESPONSE2", "count"),
        N_NUM=("_num", "count"),
        N_WOL=("WOL", "nunique"),
        OOS_N=("_oos", "sum"),
        MAIN_GROUP=("MAIN_GROUP", "first"),
        DESCRIPTION=("DESCRIPTION", "first"),
        UNITS=("UNITS", "first"),
        LSL=("LSL", "first"),
        USL=("USL", "first"),
        SPEC_RULE=("SPEC_RULE", "first"),
    )
    meta_records = meta.to_dict("records")
    has_builtin_limits = bool(df["LCL"].notna().any() or df["UCL"].notna().any())

    charts = {"cap": [], "spc": [], "par": []}
    prof_rows, cap_rows, spc_rows = [], [], []
    numeric_ov, categorical_ov = set(MANUAL_NUMERIC), set(MANUAL_CATEGORICAL)

    # NOTE: with sort=False the groupby iteration order matches the `meta`
    # aggregation index order (verified); alignment is asserted below.
    i = 0
    iter_keys = []
    for (md, an, rn), sub in gb:
        iter_keys.append((md, an, rn))
        m = meta_records[i]
        i += 1

        n = int(m["N"])
        size = int(m["SIZE"])
        if rn in numeric_ov:
            typ = "numeric"
        elif rn in categorical_ov:
            typ = "categorical"
        else:
            typ = ("numeric" if n and int(m["N_NUM"]) / n >= NUM_THRESHOLD
                   else "categorical")
        rule = m["SPEC_RULE"] if pd.notna(m["SPEC_RULE"]) else ""
        lsl = float(m["LSL"]) if pd.notna(m["LSL"]) else np.nan
        usl = float(m["USL"]) if pd.notna(m["USL"]) else np.nan
        oos_n = int(m["OOS_N"])

        row = {"MG_DESC": md, "MAIN_GROUP": m["MAIN_GROUP"] or "",
               "DESCRIPTION": m["DESCRIPTION"] or "",
               "ANALYSIS": an, "RESULT_NAME": rn, "TYPE": typ,
               "N": n, "MISSING": size - n, "N_WOL": int(m["N_WOL"]),
               "UNITS": m["UNITS"] or "", "LSL": lsl, "USL": usl,
               "SPEC_RULE": rule,
               "OUT_OF_SPEC_N": oos_n,
               "OUT_OF_SPEC_PCT": round(100 * oos_n / size, 2) if size else np.nan}

        if typ == "numeric":
            x_all = sub["_num"].to_numpy(dtype=float)
            x = x_all[~np.isnan(x_all)]
            side = spec_side(rule, lsl, usl)
            row["SPEC_SIDE"] = side
            if len(x):
                row["MEAN"] = round(float(x.mean()), 4)
                row["MEDIAN"] = round(float(np.median(x)), 4)
                row["STD"] = (round(float(x.std(ddof=1)), 4)
                              if len(x) > 1 else np.nan)
                row["MIN"] = round(float(x.min()), 4)
                row["MAX"] = round(float(x.max()), 4)

            # ---- Capability (N >= MIN_CAP_POINTS, >=2 distinct values, has spec)
            if (len(x) >= MIN_CAP_POINTS and np.unique(x).size >= 2
                    and side != "none"):
                mean = float(x.mean())
                sd = float(x.std(ddof=1))
                sd0 = float(x.std(ddof=0))
                cp = cpl = cpu = cpk = pp = ppk = np.nan
                if side == "both":
                    cp = (usl - lsl) / (6 * sd)
                    cpl = (mean - lsl) / (3 * sd)
                    cpu = (usl - mean) / (3 * sd)
                    cpk = min(cpl, cpu)
                    pp = (usl - lsl) / (6 * sd0)
                    ppk = min((mean - lsl) / (3 * sd0),
                              (usl - mean) / (3 * sd0))
                elif side == "lower":      # LSL only; USL not considered
                    cpl = cpk = (mean - lsl) / (3 * sd)
                    ppk = (mean - lsl) / (3 * sd0)
                else:                      # 'upper': USL only; LSL not considered
                    cpu = cpk = (usl - mean) / (3 * sd)
                    ppk = (usl - mean) / (3 * sd0)
                below = (x < lsl) if side in ("lower", "both") else np.zeros(len(x), bool)
                above = (x > usl) if side in ("upper", "both") else np.zeros(len(x), bool)
                dppm = float((below | above).mean()) * 1e6
                verdict = ("Capable" if cpk >= CPK_GOOD
                           else "Marginal" if cpk >= CPK_MARGINAL
                           else "Not Capable")
                cap_rows.append({
                    "MG_DESC": md, "ANALYSIS": an, "RESULT_NAME": rn,
                    "N": len(x), "LSL": (lsl if side in ("lower", "both") else np.nan),
                    "USL": (usl if side in ("upper", "both") else np.nan),
                    "SPEC_RULE": rule, "SPEC_SIDE": side, "UNITS": m["UNITS"] or "",
                    "MEAN": round(mean, 4), "STD": round(sd, 4),
                    "Cp": round(cp, 3), "Cpl": round(cpl, 3),
                    "Cpu": round(cpu, 3), "Cpk": round(cpk, 3),
                    "Pp": round(pp, 3), "Ppk": round(ppk, 3),
                    "DPM": round(dppm, 0), "VERDICT": verdict,
                })
                option = _cap_option(x, mean, sd, lsl, usl, side, cp, cpl, cpu,
                                     cpk, dppm, verdict, rn, m["UNITS"] or "")
                charts["cap"].append({
                    "MG_DESC": md, "ANALYSIS": an, "RESULT_NAME": rn,
                    "option": option, "height": 420,
                    "header": f"Capability — {an} · {rn}"})

            # ---- SPC I-MR (>= MIN_SPC_POINTS WOL subgroups)
            if int(m["N_WOL"]) >= MIN_SPC_POINTS:
                tmp = sub[["_num", "_date", "_wol"]]
                tmp = tmp[tmp["_num"].notna()]
                if not tmp.empty:
                    agg = tmp.groupby("_wol", sort=False).agg(
                        v=("_num", "mean"), d=("_date", "min"))
                    agg = agg.sort_values(["d", "_wol"])
                    if agg["d"].isna().all():
                        agg = agg.sort_index()
                    xv = agg["v"].to_numpy(dtype=float)
                    if len(xv) >= MIN_SPC_POINTS:
                        mean_i = float(xv.mean())
                        sd_i = float(xv.std(ddof=1))
                        if has_builtin_limits:
                            lcl_u = sub["LCL"].mode()
                            lcl_u = float(lcl_u.iat[0]) if len(lcl_u) else np.nan
                            ucl_u = sub["UCL"].mode()
                            ucl_u = float(ucl_u.iat[0]) if len(ucl_u) else np.nan
                        else:
                            lcl_u = ucl_u = np.nan
                        use_builtin = not (np.isnan(lcl_u) and np.isnan(ucl_u))
                        if use_builtin:
                            cl = ((lcl_u + ucl_u) / 2
                                  if not (np.isnan(lcl_u) or np.isnan(ucl_u))
                                  else mean_i)
                            lcl, ucl = lcl_u, ucl_u
                        else:
                            cl = mean_i
                            lcl = mean_i - 3 * sd_i if sd_i > 0 else mean_i
                            ucl = mean_i + 3 * sd_i if sd_i > 0 else mean_i
                        labels = [str(w) for w in agg.index]
                        x_list = [float(v) for v in xv]
                        ooc_idx = [j for j, v in enumerate(xv)
                                   if v < lcl or v > ucl]
                        ooc_data = [None] * len(xv)
                        for j in ooc_idx:
                            ooc_data[j] = x_list[j]
                        mr = np.abs(np.diff(xv))
                        mrbar = float(mr.mean())
                        ucl_mr = 3.267 * mrbar
                        mr_list = [None] + [float(v) for v in mr]
                        option = _spc_option(labels, x_list, ooc_data, mr_list,
                                             lcl, cl, ucl, mrbar, ucl_mr,
                                             use_builtin)
                        charts["spc"].append({
                            "MG_DESC": md, "ANALYSIS": an, "RESULT_NAME": rn,
                            "option": option, "height": 560,
                            "header": f"SPC (I-MR) — {an} · {rn}"})
                        spc_rows.append({
                            "MG_DESC": md, "ANALYSIS": an, "RESULT_NAME": rn,
                            "N_WOL": len(xv), "MEAN": round(mean_i, 4),
                            "LCL": round(lcl, 4), "UCL": round(ucl, 4),
                            "N_OOC": len(ooc_idx),
                            "LIMITS": "SPEC" if use_builtin else "computed"})
        else:
            row["SPEC_SIDE"] = ""
            vc = sub["RESPONSE2"].dropna().value_counts()
            if not vc.empty:
                row["TOP_CATEGORY"] = vc.index[0]
                row["TOP_CATEGORY_PCT"] = (round(100 * vc.iloc[0] / n, 2)
                                           if n else np.nan)
                cum = vc.cumsum() / vc.sum() * 100
                idx = [str(s) for s in vc.index]
                option = _pareto_option(
                    idx,
                    [float(v) for v in vc.values],
                    [float(v) for v in cum.values])
                charts["par"].append({
                    "MG_DESC": md, "ANALYSIS": an, "RESULT_NAME": rn,
                    "option": option, "height": 420,
                    "header": f"Pareto — {an} · {rn}"})
        prof_rows.append(row)

    # Sanity: iteration order must match the aggregated metadata order.
    if i != len(meta_records) or not all(
            _key_eq(k, mk) for k, mk in zip(iter_keys, meta.index)):
        raise RuntimeError(
            "Internal alignment error: groupby iteration order does not match "
            "the aggregated metadata. Please report this bug.")

    print(f"Built {len(prof_rows)} groups "
          f"({sum(1 for r in prof_rows if r['TYPE'] == 'numeric')} numeric, "
          f"{sum(1 for r in prof_rows if r['TYPE'] != 'numeric')} categorical) "
          f"in {time.perf_counter() - t0:.1f}s")

    prof = pd.DataFrame(prof_rows).sort_values(
        ["MG_DESC", "ANALYSIS", "RESULT_NAME"], na_position="last")
    cap = pd.DataFrame(cap_rows)
    spc = pd.DataFrame(spc_rows)
    master = master_summary(prof, cap, spc)
    # Exposed for testing/harness introspection.
    globals()["master"] = master

    print(f"Capability figures: {len(cap)}; SPC figures: {len(spc)}; "
          f"Pareto figures: {len(charts['par'])}")

    print("Building single-file dashboard...")
    echarts_js = get_echarts_js()
    out_path = os.path.join(out_dir, "Laminate_Analysis.html")
    write_single_html(master, charts, echarts_js, out_path)
    print(f"Done in {time.perf_counter() - t0:.1f}s. Output: {out_path}")
    # Clickable file link (Windows file URI) so you can open the HTML directly.
    print(f"Open file: {out_path.replace(os.sep, '/')}")
    # Remind the user where the report was saved, then open it in the browser.
    print(f"Charts generated: {out_path}")
    webbrowser.open(Path(out_path).as_uri())


# ----------------------------------------------------------------------------
# MASTER SUMMARY
# ----------------------------------------------------------------------------
def master_summary(prof, cap, spc):
    """Summary frame. Mean/Std/limits come from profiling (so every numeric
    row with N>=MIN_CAP_POINTS has stats); Cp/Cpk/verdict come from the
    capability pass; N_OOC from SPC. Non-applicable limits of one-sided
    specs are blanked (e.g. the USL=0 sentinel of 'Result >= Min' rows)."""
    cols = ["MAIN_GROUP", "MG_DESC", "ANALYSIS", "RESULT_NAME", "TYPE", "N",
            "N_WOL", "UNITS", "LSL", "USL", "SPEC_RULE", "SPEC_SIDE",
            "MEAN", "STD", "OUT_OF_SPEC_PCT"]
    m = prof[cols].copy()
    m.loc[m["SPEC_SIDE"] == "lower", "USL"] = np.nan
    m.loc[m["SPEC_SIDE"] == "upper", "LSL"] = np.nan
    keys = ["MG_DESC", "ANALYSIS", "RESULT_NAME"]
    if cap is not None and not cap.empty:
        m = m.merge(cap[keys + ["Cp", "Cpk", "Pp", "Ppk", "DPM", "VERDICT"]],
                    on=keys, how="left")
    else:
        for c in ("Cp", "Cpk", "Pp", "Ppk", "DPM", "VERDICT"):
            m[c] = np.nan
    if spc is not None and not spc.empty:
        m = m.merge(spc[keys + ["N_OOC"]], on=keys, how="left")
    else:
        m["N_OOC"] = np.nan
    return m


if __name__ == "__main__":
    main()
