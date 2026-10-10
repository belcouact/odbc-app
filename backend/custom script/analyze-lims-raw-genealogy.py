from __future__ import annotations

import json
import statistics
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

ECHARTS_URL = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def _quartiles(values: list[float]) -> tuple[float, float, float]:
    s = pd.Series(values, dtype="float64")
    return tuple(float(x) for x in s.quantile([0.25, 0.50, 0.75]).tolist())


def generate_report(
    data: Any,
    output_file: str | Path | None = None,
    auto_open: bool = True,
) -> Path:
    """Create an interactive HTML report from the in-memory variable `data`."""
    df = data.copy() if isinstance(data, pd.DataFrame) else pd.DataFrame(data)
    df.columns = [str(c).strip().lower() for c in df.columns]

    required = ["raw_item", "raw_lot", "raw_quantity"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")

    df = df[required].copy()
    df["raw_item"] = df["raw_item"].astype("string").str.strip()
    df["raw_lot"] = df["raw_lot"].astype("string").str.strip()
    df["raw_quantity"] = pd.to_numeric(df["raw_quantity"], errors="coerce")
    df = df.dropna(subset=required)
    df = df[(df["raw_item"] != "") & (df["raw_lot"] != "")]

    if df.empty:
        raise ValueError("No valid rows remain after cleaning the required fields.")

    lot_sum = (
        df.groupby(["raw_item", "raw_lot"], as_index=False, sort=True)["raw_quantity"]
        .sum()
        .rename(columns={"raw_quantity": "summed_raw_lot_qty"})
    )

    payload: list[dict[str, Any]] = []
    for item, group in lot_sum.groupby("raw_item", sort=True):
        group = group.sort_values(
            ["summed_raw_lot_qty", "raw_lot"],
            ascending=[False, True],
            kind="stable",
        )
        values = [float(v) for v in group["summed_raw_lot_qty"].tolist()]
        q1, median, q3 = _quartiles(values)
        iqr = q3 - q1
        inliers = [v for v in values if q1 - 1.5 * iqr <= v <= q3 + 1.5 * iqr] or values

        payload.append(
            {
                "raw_item": str(item),
                "unique_raw_lot": len(values),
                "total_qty": sum(values),
                "min": min(values),
                "max": max(values),
                "average": statistics.fmean(values),
                "median": median,
                "q1": q1,
                "q3": q3,
                "box_low": min(inliers),
                "box_high": max(inliers),
                "values": values,
                "details": [
                    {
                        "raw_lot": str(row.raw_lot),
                        "summed_raw_lot_qty": float(row.summed_raw_lot_qty),
                    }
                    for row in group.itertuples(index=False)
                ],
            }
        )

    output_file = Path(
        output_file
        or Path.home() / "Downloads"
        / f"raw_item_statistical_report_{datetime.now():%Y%m%d_%H%M%S}.html"
    ).expanduser().resolve()
    output_file.parent.mkdir(parents=True, exist_ok=True)

    html = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Raw Item Statistical Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="{ECHARTS_URL}"></script>
<style>
:root{{--navy:#17324d;--blue:#1677ff;--ink:#17202a;--muted:#64748b;--line:#dbe4ee;--bg:#f4f7fb}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font-family:"Lora",Georgia,"Times New Roman",serif}}
header{{background:linear-gradient(120deg,var(--navy),#24577d);color:#fff;padding:28px 34px 24px}}
header h1{{margin:0 0 7px;font-size:26px}}
header p{{margin:0;color:#d8e6f2}}
main{{max-width:1500px;margin:auto;padding:24px}}
.kpis{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px}}
.kpi,.panel{{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 5px 18px rgba(23,50,77,.06)}}
.kpi{{padding:16px 18px}}
.kpi small{{color:var(--muted);font-weight:600}}
.kpi strong{{display:block;font-size:25px;color:var(--navy);margin-top:4px}}
.panel{{overflow:hidden;margin-bottom:18px}}
.toolbar{{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line)}}
.search{{width:min(420px,100%);padding:10px 12px;border:1px solid #c9d5e2;border-radius:8px}}
.note{{color:var(--muted);font-size:13px}}
.table-wrap{{overflow:auto;max-height:62vh}}
table{{border-collapse:separate;border-spacing:0;width:100%;font-variant-numeric:tabular-nums}}
th,td{{padding:11px 14px;border-bottom:1px solid #e8eef4;white-space:nowrap}}
th{{position:sticky;top:0;z-index:1;background:#edf3f8;color:#35516b;text-align:right;font-size:12px;text-transform:uppercase;cursor:pointer}}
th:first-child,td:first-child{{text-align:left}}
td{{text-align:right}}
tbody tr:hover{{background:#f3f8ff}}
a.item{{color:#075db8;font-weight:650;text-decoration:none}}
a.item:hover{{text-decoration:underline}}
footer{{display:flex;justify-content:space-between;padding:13px 16px;color:var(--muted);font-size:13px}}
button{{border:1px solid #c9d5e2;background:#fff;border-radius:7px;padding:7px 11px;cursor:pointer}}
button:disabled{{opacity:.45}}
.chart-title{{padding:18px 20px 0;margin:0;font-size:19px}}
#boxplot{{height:580px}}
.chart-help{{padding:0 20px 14px;color:var(--muted);font-size:13px}}
.modal{{display:none;position:fixed;inset:0;z-index:9999;background:#f4f7fb;overflow:auto}}
.modal.open{{display:block}}
.modal-bar{{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;align-items:center;padding:12px 18px;background:#17324d;color:#fff}}
.modal-bar h2{{margin:0;font-size:18px}}
.modal-close{{background:transparent;color:#fff;border-color:#ffffff80}}
.modal-content{{padding:18px}}
.modal-card{{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px}}
body.modal-open{{overflow:hidden}}
.controls{{display:grid;grid-template-columns:minmax(220px,1fr) minmax(420px,2fr);gap:22px;padding:14px 16px;margin:10px 0 6px;background:#f6f9fc;border:1px solid #e2eaf2;border-radius:10px}}
.control label{{display:flex;justify-content:space-between;font-size:13px;font-weight:650;color:#35516b;margin-bottom:9px}}
.control input[type=range]{{width:100%;accent-color:#1677ff}}
.dual{{position:relative;height:28px}}
.dual input{{position:absolute;left:0;top:0;width:100%;pointer-events:none;background:none}}
.dual input::-webkit-slider-thumb{{pointer-events:auto}}
.dual input::-moz-range-thumb{{pointer-events:auto}}
#histogramChart{{height:50vh;min-height:390px}}
.modal-stats{{display:grid;grid-template-columns:repeat(7,minmax(110px,1fr));gap:10px}}
.modal-stat{{background:#f6f9fc;border-radius:8px;padding:10px}}
.modal-stat small{{color:#64748b}}
.modal-stat strong{{display:block;margin-top:3px}}
.detail-head{{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:26px}}
.detail-search{{padding:9px 11px;border:1px solid #c9d5e2;border-radius:8px}}
.detail-wrap{{overflow:auto;max-height:40vh;border:1px solid var(--line);border-radius:9px}}
.detail-wrap th{{text-align:left}}
.detail-wrap th:last-child,.detail-wrap td:last-child{{text-align:right}}
#detailStatus{{margin-top:8px;color:var(--muted);font-size:13px}}
@media(max-width:900px){{.controls{{grid-template-columns:1fr}}.modal-stats{{grid-template-columns:repeat(2,1fr)}}}}
@media(max-width:700px){{main{{padding:14px}}.kpis{{grid-template-columns:1fr}}.toolbar,footer,.detail-head{{align-items:stretch;flex-direction:column}}}}
</style>
</head>
<body>
<header><h1>Raw Item Statistical Report</h1><p>Statistics use summed raw_quantity for each unique raw_lot within each raw_item.</p></header>
<main>
<section class="kpis">
<div class="kpi"><small>Valid source rows</small><strong>{len(df):,}</strong></div>
<div class="kpi"><small>Unique item-lot groups</small><strong>{len(lot_sum):,}</strong></div>
<div class="kpi"><small>Raw items</small><strong>{len(payload):,}</strong></div>
</section>
<section class="panel">
<div class="toolbar"><input id="search" class="search" placeholder="Search raw_item..."><span class="note">Click a raw_item for histogram and lot details.</span></div>
<div class="table-wrap"><table><thead><tr>
<th data-key="raw_item">raw_item</th><th data-key="unique_raw_lot"># unique raw_lot</th><th data-key="total_qty">total qty</th><th data-key="min">min</th><th data-key="max">max</th><th data-key="average">average</th><th data-key="median">median</th>
</tr></thead><tbody id="tableBody"></tbody></table></div>
<footer><span id="status"></span><div><button id="prev">Previous</button> <span id="pageText"></span> <button id="next">Next</button></div></footer>
</section>
<section class="panel"><h2 class="chart-title">Distribution by Raw Item</h2><p class="chart-help">ECharts boxplot of summed raw_quantity by raw_lot.</p><div id="boxplot"></div></section>
</main>
<div id="histogramModal" class="modal">
<div class="modal-bar"><h2 id="modalTitle">Histogram</h2><button id="modalClose" class="modal-close">Close</button></div>
<div class="modal-content"><div class="modal-card">
<div class="controls">
<div class="control"><label><span>Bin size</span><strong id="binSizeValue">1</strong></label><input id="binSizeSlider" type="range" min="1" max="1" value="1" step="1"></div>
<div class="control"><label><span>Lot quantity range</span><strong id="rangeValue"></strong></label><div class="dual"><input id="rangeMin" type="range"><input id="rangeMax" type="range"></div></div>
</div>
<div id="histogramChart"></div>
<div id="modalStats" class="modal-stats"></div>
<div class="detail-head"><h2>Raw Lot Details</h2><input id="detailSearch" class="detail-search" placeholder="Search raw_lot..."></div>
<div class="detail-wrap"><table><thead><tr><th id="lotHeader">raw_lot</th><th id="qtyHeader">summed quantity</th></tr></thead><tbody id="detailBody"></tbody></table></div>
<div id="detailStatus"></div>
</div></div>
</div>
<script>
const DATA={_json(payload)};
const PAGE_SIZE=100;
let filtered=[...DATA],page=1,sortKey='raw_item',sortDir=1;
const nf=new Intl.NumberFormat(undefined,{{maximumFractionDigits:2}});
const tableBody=document.getElementById('tableBody');
const statusText=document.getElementById('status');
const pageText=document.getElementById('pageText');
const prevButton=document.getElementById('prev');
const nextButton=document.getElementById('next');
const searchInput=document.getElementById('search');
const boxplotElement=document.getElementById('boxplot');
const histogramModal=document.getElementById('histogramModal');
const modalTitle=document.getElementById('modalTitle');
const modalClose=document.getElementById('modalClose');
const modalStats=document.getElementById('modalStats');
const histogramChartElement=document.getElementById('histogramChart');
const binSizeSlider=document.getElementById('binSizeSlider');
const binSizeValue=document.getElementById('binSizeValue');
const rangeMin=document.getElementById('rangeMin');
const rangeMax=document.getElementById('rangeMax');
const rangeValue=document.getElementById('rangeValue');
const detailSearch=document.getElementById('detailSearch');
const detailBody=document.getElementById('detailBody');
const detailStatus=document.getElementById('detailStatus');
const lotHeader=document.getElementById('lotHeader');
const qtyHeader=document.getElementById('qtyHeader');

function esc(value){{
 const element=document.createElement('div');
 element.textContent=String(value);
 return element.innerHTML;
}}

function render(){{
 filtered.sort((a,b)=>(typeof a[sortKey]==='string' ? a[sortKey].localeCompare(b[sortKey],undefined,{{numeric:true}}) : a[sortKey]-b[sortKey])*sortDir);
 const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));
 page=Math.min(page,pages);
 const start=(page-1)*PAGE_SIZE;
 tableBody.innerHTML=filtered.slice(start,start+PAGE_SIZE).map(r=>`<tr><td><a href="#" class="item" data-item="${{esc(r.raw_item)}}">${{esc(r.raw_item)}}</a></td><td>${{nf.format(r.unique_raw_lot)}}</td><td>${{nf.format(r.total_qty)}}</td><td>${{nf.format(r.min)}}</td><td>${{nf.format(r.max)}}</td><td>${{nf.format(r.average)}}</td><td>${{nf.format(r.median)}}</td></tr>`).join('');
 statusText.textContent=`Showing ${{filtered.length ? start+1 : 0}}-${{Math.min(start+PAGE_SIZE,filtered.length)}} of ${{filtered.length}} raw items`;
 pageText.textContent=`Page ${{page}} of ${{pages}}`;
 prevButton.disabled=page<=1;
 nextButton.disabled=page>=pages;
 renderBoxplot();
}}

const boxChart=echarts.init(boxplotElement);
function renderBoxplot(){{
 const d=filtered;
 boxChart.setOption({{
  animation:false,
  tooltip:{{trigger:'item'}},
  grid:{{left:75,right:30,top:25,bottom:125}},
  xAxis:{{type:'category',data:d.map(x=>x.raw_item),axisLabel:{{rotate:55,fontSize:10}}}},
  yAxis:{{type:'value',name:'Summed raw_quantity'}},
  dataZoom:[{{type:'inside'}},{{type:'slider',bottom:35}}],
  series:[{{type:'boxplot',data:d.map(x=>[x.box_low,x.q1,x.median,x.q3,x.box_high])}}]
 }},true);
}}

let current=null;
let histogramChart=null;
let activeDetails=[];
let detailRows=[];
let detailSortKey='summed_raw_lot_qty';
let detailSortDir=-1;

function integerBounds(values){{
 return [Math.floor(Math.min(...values)),Math.ceil(Math.max(...values))];
}}

function renderHistogram(){{
 if(!current)return;
 let rangeLow=Number(rangeMin.value);
 let rangeHigh=Number(rangeMax.value);
 if(rangeLow>rangeHigh){{
  if(document.activeElement===rangeMin)rangeLow=rangeHigh;
  else rangeHigh=rangeLow;
  rangeMin.value=rangeLow;
  rangeMax.value=rangeHigh;
 }}

 const selected=current.values.filter(v=>v>=rangeLow && v<=rangeHigh);
 const width=Math.max(1,Number(binSizeSlider.value));
 binSizeValue.textContent=nf.format(width);
 rangeValue.textContent=nf.format(rangeLow)+' - '+nf.format(rangeHigh);

 if(!selected.length){{
  histogramChart.setOption({{
   tooltip:{{show:false}},
   graphic:[{{type:'text',left:'center',top:'middle',style:{{text:'No lot quantities in the selected range',fill:'#64748b',font:'16px Segoe UI'}}}}],
   xAxis:{{type:'category',data:[]}},
   yAxis:{{type:'value'}},
   series:[{{type:'bar',data:[]}}]
  }},true);
  return;
 }}

 const actualMin=Math.floor(Math.min(...selected));
 const actualMax=Math.ceil(Math.max(...selected));
 const span=Math.max(1,actualMax-actualMin+1);
 const count=Math.max(1,Math.ceil(span/width));
 const counts=Array(count).fill(0);

 selected.forEach(v=>{{
  const index=Math.min(count-1,Math.max(0,Math.floor((v-actualMin)/width)));
  counts[index]++;
 }});

 const labels=counts.map((_,i)=>{{
  const start=actualMin+i*width;
  const end=Math.min(actualMax,start+width-1);
  return start===end ? String(start) : start+' - '+end;
 }});

 histogramChart.setOption({{
  graphic:[],
  tooltip:{{trigger:'axis'}},
  grid:{{left:70,right:30,top:35,bottom:115}},
  xAxis:{{type:'category',name:'Summed quantity range',data:labels,axisLabel:{{rotate:45,fontSize:10}}}},
  yAxis:{{type:'value',name:'Raw lot count',minInterval:1}},
  dataZoom:[{{type:'inside'}},{{type:'slider',bottom:25}}],
  series:[{{type:'bar',name:'Raw lots',data:counts,itemStyle:{{color:'#1677ff'}}}}]
 }},true);
}}

function renderDetails(){{
 detailRows.sort((a,b)=>detailSortKey==='raw_lot' ? a.raw_lot.localeCompare(b.raw_lot,undefined,{{numeric:true}})*detailSortDir : (a.summed_raw_lot_qty-b.summed_raw_lot_qty)*detailSortDir);
 detailBody.innerHTML=detailRows.map(d=>`<tr><td>${{esc(d.raw_lot)}}</td><td>${{nf.format(d.summed_raw_lot_qty)}}</td></tr>`).join('');
 detailStatus.textContent=`Showing ${{detailRows.length}} of ${{activeDetails.length}} unique raw_lot records`;
}}

function openHistogram(item){{
 current=DATA.find(x=>x.raw_item===item);
 if(!current)return;
 modalTitle.textContent='Histogram: '+current.raw_item;
 modalStats.innerHTML=[['Unique lots',current.unique_raw_lot],['Total qty',current.total_qty],['Min',current.min],['Max',current.max],['Average',current.average],['Median',current.median],['Raw item',current.raw_item]].map(x=>`<div class="modal-stat"><small>${{esc(x[0])}}</small><strong>${{esc(typeof x[1]==='number' ? nf.format(x[1]) : x[1])}}</strong></div>`).join('');

 const [low,high]=integerBounds(current.values);
 rangeMin.min=rangeMax.min=low;
 rangeMin.max=rangeMax.max=high;
 rangeMin.step=rangeMax.step=1;
 rangeMin.value=low;
 rangeMax.value=high;

 const fullSpan=Math.max(1,high-low+1);
 const defaultBinSize=Math.max(1,Math.round(fullSpan/10));
 binSizeSlider.min=1;
 binSizeSlider.max=fullSpan;
 binSizeSlider.step=1;
 binSizeSlider.value=defaultBinSize;

 activeDetails=[...current.details];
 detailRows=[...activeDetails];
 detailSearch.value='';
 renderDetails();
 histogramModal.classList.add('open');
 document.body.classList.add('modal-open');
 requestAnimationFrame(()=>{{
  if(!histogramChart)histogramChart=echarts.init(histogramChartElement);
  renderHistogram();
  histogramChart.resize();
 }});
}}

function closeModal(){{
 histogramModal.classList.remove('open');
 document.body.classList.remove('modal-open');
}}

modalClose.onclick=closeModal;
histogramModal.onclick=e=>{{if(e.target===histogramModal)closeModal();}};
document.addEventListener('keydown',e=>{{if(e.key==='Escape' && histogramModal.classList.contains('open'))closeModal();}});
binSizeSlider.oninput=renderHistogram;
rangeMin.oninput=renderHistogram;
rangeMax.oninput=renderHistogram;
detailSearch.oninput=e=>{{
 const query=e.target.value.trim().toLowerCase();
 detailRows=activeDetails.filter(d=>d.raw_lot.toLowerCase().includes(query));
 renderDetails();
}};
lotHeader.onclick=()=>{{
 if(detailSortKey==='raw_lot')detailSortDir*=-1;
 else{{detailSortKey='raw_lot';detailSortDir=1;}}
 renderDetails();
}};
qtyHeader.onclick=()=>{{
 if(detailSortKey==='summed_raw_lot_qty')detailSortDir*=-1;
 else{{detailSortKey='summed_raw_lot_qty';detailSortDir=-1;}}
 renderDetails();
}};
searchInput.oninput=e=>{{
 const query=e.target.value.trim().toLowerCase();
 filtered=DATA.filter(r=>r.raw_item.toLowerCase().includes(query));
 page=1;
 render();
}};
document.querySelector('thead').onclick=e=>{{
 const key=e.target.dataset.key;
 if(!key)return;
 if(sortKey===key)sortDir*=-1;
 else{{sortKey=key;sortDir=1;}}
 page=1;
 render();
}};
tableBody.onclick=e=>{{
 const anchor=e.target.closest('a.item');
 if(anchor){{e.preventDefault();openHistogram(anchor.dataset.item);}}
}};
prevButton.onclick=()=>{{page--;render();}};
nextButton.onclick=()=>{{page++;render();}};
window.onresize=()=>{{boxChart.resize();if(histogramChart)histogramChart.resize();}};
render();
</script>
</body>
</html>'''

    output_file.write_text(html, encoding="utf-8")
    if auto_open:
        webbrowser.open(output_file.as_uri())
    return output_file


report_path = generate_report(data)
print(f"Saved: {report_path}")
