from __future__ import annotations

import base64
import json
import math
import re
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any

# data must be supplied directly by the calling environment as either:
#   1. pandas.DataFrame
#   2. list[dict]
#   3. another object exposing to_dict(orient="records")

MAX_ROWS_TO_EXPORT = 0
OUTPUT_FILENAME = "aoi_defect_map.html"
SVG_WIDTH = 1200
SVG_HEIGHT = 760
MIN_POINT_RADIUS = 1.5
MAX_POINT_RADIUS = 9.0

COLUMN_MAP = {
    "defectid": "defectid",
    "defectindex": "defectindex",
    "pieceid": "pieceid",
    "piece_name": "piece_name",
    "start_time": "start_time",
    "cd_mm": "cd_mm",
    "md_m": "md_m",
    "class_name": "class_name",
    "job_name": "job_name",
    "job_recipe": "job_recipe",
    "severity_name": "severity_name",
    "layer_name": "layer_name",
    "defect_flag": "defect_flag",
    "cd_loc": "Cd_loc (mm)",
    "md_loc": "Md_loc (m)",
    "defect_width": "width (mm)",
    "defect_length": "Length (mm)",
    "defect_area": "Area (mm2)",
    "rrdd_raw": "rrdd_image",
    "rrdh_raw": "rrdh_image",
    "rrcd_raw": "rrcd_image",
}

REQUIRED_COLUMNS = [
    "defectid", "piece_name", "cd_mm", "md_m", "class_name",
    "severity_name", "Cd_loc (mm)", "Md_loc (m)", "Area (mm2)",
]


def is_missing(value: Any) -> bool:
    if value is None:
        return True
    try:
        return bool(math.isnan(value))
    except (TypeError, ValueError):
        return False


def as_text(value: Any) -> str:
    return "" if is_missing(value) else str(value)


def to_records(source: Any) -> list[dict[str, Any]]:
    if source is None:
        raise ValueError("data is None")
    if hasattr(source, "to_dict"):
        try:
            rows = source.to_dict(orient="records")
        except TypeError:
            rows = source.to_dict("records")
    else:
        rows = list(source)
    if rows and not isinstance(rows[0], dict):
        raise TypeError("data must contain dictionary-like records")
    return [dict(row) for row in rows]


def clean_image(value: Any) -> tuple[str, str]:
    if is_missing(value):
        return "", "image/png"
    if isinstance(value, memoryview):
        value = value.tobytes()
    if isinstance(value, (bytes, bytearray)):
        text = base64.b64encode(bytes(value)).decode("ascii")
    else:
        text = str(value).strip()
        if "base64," in text.lower():
            text = re.split(r"base64,", text, maxsplit=1, flags=re.I)[1]
        text = re.sub(r"\s+", "", text)

    mime = None
    if len(text) >= 40:
        if text.startswith("iVBOR"):
            mime = "image/png"
        elif text.startswith("/9j/"):
            mime = "image/jpeg"
        elif text.startswith("R0lGOD"):
            mime = "image/gif"
        elif text.startswith("Qk"):
            mime = "image/bmp"
        elif text.startswith(("SUkq", "TU0A")):
            mime = "image/tiff"
    return (text, mime) if mime else ("", "image/png")


def prepare_rows(source: Any) -> tuple[list[dict[str, str]], int]:
    records = to_records(source)
    columns = set().union(*(row.keys() for row in records)) if records else set()
    missing = [name for name in REQUIRED_COLUMNS if name not in columns]
    if missing:
        raise ValueError("Missing required columns: " + ", ".join(missing))
    if MAX_ROWS_TO_EXPORT > 0:
        records = records[:MAX_ROWS_TO_EXPORT]

    output = []
    image_count = 0
    image_keys = ("rrdd_raw", "rrdh_raw", "rrcd_raw")
    for source_row in records:
        row = {
            key: as_text(source_row.get(column, ""))
            for key, column in COLUMN_MAP.items()
            if key not in image_keys
        }
        for key in image_keys:
            raw, mime = clean_image(source_row.get(COLUMN_MAP[key], ""))
            row[key] = raw
            row[key.replace("_raw", "_mime")] = mime
            image_count += int(bool(raw))
        output.append(row)
    return output, image_count


HTML_TEMPLATE = r'''<!doctype html>
<html><head><meta charset="utf-8"><title>AOI Defect Map</title><style>
*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#f4f6f8;color:#1f2933}.page{display:grid;grid-template-columns:320px 1fr;height:100vh;transition:grid-template-columns .25s}.page.closed{grid-template-columns:0 1fr}.side{background:#fff;border-right:1px solid #d9e2ec;padding:18px;overflow:auto}.closed .side{padding:0;opacity:0;overflow:hidden}.row,.head{display:flex;justify-content:space-between;align-items:center;gap:8px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:18px 0 8px}label{display:block;font-size:12px;color:#52606d;margin:9px 0 4px}select,input{width:100%;padding:7px;border:1px solid #bcccdc;border-radius:7px}button{padding:8px 10px;border:0;border-radius:7px;background:#2563eb;color:#fff;cursor:pointer}.orange{background:#d97706}.green{background:#0d9488}.icon{background:#eef2f7;color:#334155}.stat{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #edf2f7;font-size:13px}.main{background:#fff;overflow:hidden;display:flex;flex-direction:column}.head{padding:10px 14px;border-bottom:1px solid #e2e8f0}.title{font-size:18px;font-weight:650}.muted{font-size:12px;color:#64748b}.map{overflow:auto;flex:1}svg{background:linear-gradient(#fff,#f8fafc)}.grid{stroke:#e2e8f0}.axis{fill:#52606d;font-size:12px}.point{stroke:#111827;stroke-width:.7;fill-opacity:.78;cursor:pointer}.point:hover{stroke-width:2;fill-opacity:1}.legend{display:flex;flex-wrap:wrap;gap:8px;font-size:12px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px}.tip{display:none;position:fixed;z-index:20;width:auto;max-width:96vw;max-height:85vh;overflow:auto;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 20px 50px #0f172a40;padding:10px;pointer-events:none}.meta{display:grid;grid-template-columns:95px 1fr;gap:3px 8px;font-size:11px}.imgs{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.ibox{border:1px solid #e2e8f0;border-radius:7px;padding:4px}.tip .ibox{width:172px;padding:0;border:0;overflow:hidden;background:transparent}.tip .ibox img{display:block;width:172px;height:auto;max-width:none;object-fit:contain;margin:0;border-radius:10px}.tip .none{width:172px;height:120px;min-height:0;margin:0}.none{height:100px;display:flex;align-items:center;justify-content:center;color:#94a3b8}.modal{display:none;position:fixed;inset:0;background:#0f172a80;z-index:30}.dialog{width:100vw;height:100vh;max-width:none;margin:0;background:#fff;display:flex;flex-direction:column}.modalbody{padding:12px;overflow:auto}.gallery{border-collapse:collapse;font-size:12px;min-width:1000px}.gallery th,.gallery td{border:1px solid #e2e8f0;padding:6px;vertical-align:top}.gallery th{position:sticky;top:0;background:#f1f5f9}.gallery th:nth-child(9),.gallery th:nth-child(10),.gallery th:nth-child(11),.gallery td:nth-child(9),.gallery td:nth-child(10),.gallery td:nth-child(11){width:180px;min-width:180px;max-width:180px;padding:4px}.gallery td:nth-child(9) .ibox,.gallery td:nth-child(10) .ibox,.gallery td:nth-child(11) .ibox{width:172px;height:auto;min-height:0;padding:0;border:0;background:transparent}.gallery td:nth-child(9) .ibox b,.gallery td:nth-child(10) .ibox b,.gallery td:nth-child(11) .ibox b{display:none}.gallery td:nth-child(9) .ibox img,.gallery td:nth-child(10) .ibox img,.gallery td:nth-child(11) .ibox img{display:block;width:172px;height:auto;max-width:none;object-fit:contain;margin:0;border-radius:10px}.gallery td:nth-child(9) .none,.gallery td:nth-child(10) .none,.gallery td:nth-child(11) .none{width:172px;height:120px;margin:0}.gallery input,.gallery select{margin-top:5px;padding:3px}
</style></head><body>
<div class="page" id="page"><aside class="side"><div class="row"><h1>AOI Defect Map</h1><button class="icon" onclick="page.classList.add('closed')">X</button></div><p class="muted">X = Cd_loc (mm)<br>Y = Md_loc (m)<br>Width = cd_mm<br>Length = md_m<br>Images are embedded from Base64.</p><h2>Filters</h2><div id="filters"></div><label>Search defect / piece / job</label><input id="search" placeholder="Type to search..."><p><button class="orange" onclick="resetAll()">Reset</button> <button class="green" onclick="openGallery()">View All Images</button></p><h2>Appearance</h2><label>Dot size <b id="scaleLabel">1.00x</b></label><input type="range" id="scale" min=".5" max="2" step=".05" value="1"><h2>Summary</h2><div id="stats"></div><h2>Legend</h2><div id="legend" class="legend"></div></aside><main class="main"><div class="head"><div><div class="title">Defect Coordinate Map</div><div class="muted">Color = class_name, Size = Severity</div></div><div class="row"><button class="icon" onclick="page.classList.toggle('closed')">Menu</button><span id="dimensions" class="muted"></span></div></div><div class="map"><svg id="svg"></svg></div></main></div><div id="tip" class="tip"></div>
<div id="modal" class="modal"><div class="dialog"><div class="head"><h3>Defect Image Gallery</h3><div><span id="gcount" class="muted"></span> <button class="icon" onclick="closeGallery()">X</button></div></div><div class="modalbody"><table class="gallery"><thead><tr id="ghead"></tr></thead><tbody id="gbody"></tbody></table></div></div></div>
<script>
const DATA=__DATA__,IMAGE_COUNT=__COUNT__,W=__W__,H=__H__,MIN_R=__MINR__,MAX_R=__MAXR__;
const M={l:75,r:35,t:40,b:65},PW=W-M.l-M.r,PH=H-M.t-M.b,C=['#2563eb','#dc2626','#16a34a','#9333ea','#ea580c','#0891b2','#be123c','#4f46e5','#65a30d','#ca8a04','#0f766e','#7c3aed'];
const $=id=>document.getElementById(id),num=v=>Number.isFinite(+v)?+v:0,uniq=(a,k)=>[...new Set(a.map(x=>x[k]).filter(x=>String(x||'').trim()))].sort(),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defs=[['Piece','piece_name'],['Class','class_name'],['Severity','severity_name'],['Layer','layer_name'],['Job Recipe','job_recipe']];
function init(){$('filters').innerHTML=defs.map(([a,k],i)=>`<label>${a}</label><select id="f${i}"><option value="">All ${a.toLowerCase()}s</option>${uniq(DATA,k).map(v=>`<option>${esc(v)}</option>`).join('')}</select>`).join('');defs.forEach((x,i)=>$('f'+i).onchange=draw);$('search').oninput=draw;$('scale').oninput=draw;buildHead();draw()}
function filtered(){const q=$('search').value.toLowerCase();return DATA.filter(d=>defs.every((x,i)=>!$('f'+i).value||d[x[1]]===$('f'+i).value)&&(!q||['defectid','defectindex','pieceid','piece_name','class_name','job_name','job_recipe','severity_name','layer_name','defect_flag'].map(k=>d[k]).join(' ').toLowerCase().includes(q)))}
function rank(s){const a=['critical','severe','high','major','medium','moderate','minor','low','info','ok','none'],i=a.findIndex(x=>String(s).toLowerCase().includes(x));return i<0?a.length:i}
function img(t,r,m){return `<div class="ibox"><b>${t}</b>${r&&r.length>=40?`<img src="data:${m};base64,${r}">`:'<div class="none">No image</div>'}</div>`}
function tipHtml(d){const r=[['Defect Index','defectindex'],['Piece','piece_name'],['CD Location','cd_loc'],['MD Location','md_loc'],['Width','defect_width'],['Length','defect_length'],['Layer','layer_name']];return `<h3>${esc(d.class_name)} | ${esc(d.severity_name)}</h3><div class="meta">${r.map(x=>`<span class="muted">${x[0]}</span><span>${esc(d[x[1]])}</span>`).join('')}</div><div class="imgs">${img('RRDD',d.rrdd_raw,d.rrdd_mime)}${img('RRDH',d.rrdh_raw,d.rrdh_mime)}${img('RRCD',d.rrcd_raw,d.rrcd_mime)}</div>`}
function positionTip(e,d){const t=$('tip');t.innerHTML=tipHtml(d);t.style.display='block';const gap=18,tw=t.offsetWidth,th=t.offsetHeight;let left=e.clientX>window.innerWidth/2?e.clientX-tw-gap:e.clientX+gap;let top=e.clientY-th/2;left=Math.max(10,Math.min(left,window.innerWidth-tw-10));top=Math.max(10,Math.min(top,window.innerHeight-th-10));t.style.left=left+'px';t.style.top=top+'px'}
function draw(){const rows=filtered(),s=$('svg');s.setAttribute('width',W);s.setAttribute('height',H);s.innerHTML='';const maxW=Math.max(...DATA.map(d=>num(d.cd_mm)),1),maxL=Math.max(...DATA.map(d=>num(d.md_m)),1),classes=uniq(DATA,'class_name'),cm=Object.fromEntries(classes.map((x,i)=>[x,C[i%C.length]])),sevs=uniq(DATA,'severity_name').sort((a,b)=>rank(a)-rank(b)),lv=Object.fromEntries(sevs.map((x,i)=>[x,i])),NS='http://www.w3.org/2000/svg';$('dimensions').textContent=`Width: ${maxW.toFixed(2)} mm | Length: ${maxL.toFixed(2)} m`;$('legend').innerHTML=classes.map(x=>`<span><i class="dot" style="background:${cm[x]}"></i>${esc(x)}</span>`).join('');const el=(tag,a,t)=>{const e=document.createElementNS(NS,tag);Object.entries(a).forEach(x=>e.setAttribute(x[0],x[1]));if(t!==undefined)e.textContent=t;s.appendChild(e);return e};for(let v=0;v<=maxW;v+=100){let x=M.l+v/maxW*PW;el('line',{x1:x,y1:M.t,x2:x,y2:M.t+PH,class:'grid'});el('text',{x,y:M.t+PH+22,class:'axis','text-anchor':'middle'},v)}for(let v=0;v<=maxL;v+=100){let y=M.t+PH-v/maxL*PH;el('line',{x1:M.l,y1:y,x2:M.l+PW,y2:y,class:'grid'});el('text',{x:M.l-12,y:y+4,class:'axis','text-anchor':'end'},v)}el('text',{x:M.l+PW/2,y:H-22,class:'axis','text-anchor':'middle'},'CD Location (mm)');el('text',{x:16,y:M.t+PH/2,class:'axis','text-anchor':'middle',transform:`rotate(-90 16 ${M.t+PH/2})`},'MD Location (m)');const scale=+$('scale').value;$('scaleLabel').textContent=scale.toFixed(2)+'x';rows.forEach(d=>{let x=num(d.cd_loc),y=num(d.md_loc);if(x<0||y<0)return;let i=lv[d.severity_name]??sevs.length-1,r=Math.min(MAX_R,MIN_R*Math.pow(1.5,sevs.length-1-i))*scale,c=el('circle',{cx:M.l+x/maxW*PW,cy:M.t+PH-y/maxL*PH,r,class:'point',fill:cm[d.class_name]||'#64748b'});c.onmousemove=e=>positionTip(e,d);c.onmouseleave=()=>$('tip').style.display='none'});$('stats').innerHTML=[['Total exported rows',DATA.length],['Visible defects',rows.length],['Classes',uniq(rows,'class_name').length],['Severities',uniq(rows,'severity_name').length],['Embedded images',IMAGE_COUNT]].map(x=>`<div class="stat"><span>${x[0]}</span><b>${x[1]}</b></div>`).join('')}
const gc=[['Piece','piece_name'],['Layer','layer_name'],['Defect ID','defectid'],['CD (mm)','cd_loc'],['MD (m)','md_loc'],['Class','class_name'],['Area','defect_area'],['Severity','severity_name'],['RRDD','rrdd_raw'],['RRDH','rrdh_raw'],['RRCD','rrcd_raw']];
function buildHead(){$('ghead').innerHTML=gc.map(x=>`<th>${x[0]}${x[1].endsWith('_raw')?`<select data-k="${x[1]}"><option value="">All</option><option value="1">With image</option><option value="0">No image</option></select>`:`<input data-k="${x[1]}" placeholder="Filter">`}</th>`).join('');document.querySelectorAll('#ghead input,#ghead select').forEach(e=>e.oninput=gallery)}
function gallery(){let fs=[...document.querySelectorAll('#ghead input,#ghead select')],rows=filtered().filter(d=>fs.every(e=>!e.value||(e.dataset.k.endsWith('_raw')?((d[e.dataset.k]?.length>=40?'1':'0')===e.value):String(d[e.dataset.k]||'').toLowerCase().includes(e.value.toLowerCase()))));$('gbody').innerHTML=rows.map(d=>`<tr><td>${esc(d.piece_name)}</td><td>${esc(d.layer_name)}</td><td>${esc(d.defectid)}</td><td>${num(d.cd_loc).toFixed(2)}</td><td>${num(d.md_loc).toFixed(2)}</td><td>${esc(d.class_name)}</td><td>${esc(d.defect_area)}</td><td>${esc(d.severity_name)}</td><td>${img('',d.rrdd_raw,d.rrdd_mime)}</td><td>${img('',d.rrdh_raw,d.rrdh_mime)}</td><td>${img('',d.rrcd_raw,d.rrcd_mime)}</td></tr>`).join('');$('gcount').textContent=rows.length+' defects'}
function openGallery(){$('modal').style.display='block';gallery()}function closeGallery(){$('modal').style.display='none'}function resetAll(){defs.forEach((x,i)=>$('f'+i).value='');$('search').value='';draw()}document.addEventListener('keydown',e=>{if(e.key==='Escape')closeGallery()});init();
</script></body></html>'''


def export_aoi_defect_map(data: Any, output_path=None, open_browser=True) -> Path:
    rows, image_count = prepare_rows(data)
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = (
        HTML_TEMPLATE.replace("__DATA__", payload)
        .replace("__COUNT__", str(image_count))
        .replace("__W__", str(SVG_WIDTH))
        .replace("__H__", str(SVG_HEIGHT))
        .replace("__MINR__", str(MIN_POINT_RADIUS))
        .replace("__MAXR__", str(MAX_POINT_RADIUS))
    )
    if output_path is None:
        downloads = Path.home() / "Downloads"
        downloads.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = Path(OUTPUT_FILENAME).stem
        suffix = Path(OUTPUT_FILENAME).suffix
        output = downloads / f"{stem}_{timestamp}{suffix}"
    else:
        output = Path(output_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")
    if open_browser:
        webbrowser.open(output.as_uri())
    print(f"Saved: {output}")
    print(f"Rows exported: {len(rows)}")
    print(f"Embedded images: {image_count}")
    return output


if __name__ == "__main__":
    if "data" not in globals():
        raise NameError("Define data before running this script")
    export_aoi_defect_map(data)
