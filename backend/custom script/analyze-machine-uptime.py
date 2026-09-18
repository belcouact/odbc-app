import json
import webbrowser
from pathlib import Path
import pandas as pd

# `data` must already exist. No Excel/CSV file is read.
df = pd.DataFrame(data)
DOWNLOADS_DIR = Path.home() / "Downloads"
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_HTML = DOWNLOADS_DIR / "machine_up_down_timeline.html"
AUTO_OPEN = True
MACHINE_COLUMN = None
GRAVURE_DESCRIPTION = "Gravure Change (planned)"
CLEANING_DESCRIPTION = "Cleaning Line (Specify)"
COLORS = {"planu": "#16a34a", "plan": "#f59e0b", "unplan": "#dc2626"}
LABELS = {"planu": "Running", "plan": "Planned downtime", "unplan": "Unplanned downtime"}
ALIASES = {
    "start": ["event_start_date", "EVENT_START_DATE"],
    "status": ["status", "STATUS"],
    "description": ["description", "DESCRIPTION"],
    "minutes": ["dt_mins", "DT_MINS"],
}
MACHINE_CANDIDATES = [
    "machine", "MACHINE", "machine_id", "MACHINE_ID", "machine_name", "MACHINE_NAME",
    "mes_resource", "MES_RESOURCE", "resource", "RESOURCE", "equipment", "EQUIPMENT",
]


def find_col(names, label):
    col = next((x for x in names if x in df.columns), None)
    if col is None:
        raise ValueError(f"Missing {label}. Expected {names}. Available: {list(df.columns)}")
    return col


cols = {k: find_col(v, k) for k, v in ALIASES.items()}
if MACHINE_COLUMN:
    if MACHINE_COLUMN not in df.columns:
        raise ValueError(f"MACHINE_COLUMN '{MACHINE_COLUMN}' not found")
    machine_col = MACHINE_COLUMN
else:
    machine_col = next((x for x in MACHINE_CANDIDATES if x in df.columns), None)
if machine_col is None:
    df["__machine__"] = "Machine"
    machine_col = "__machine__"

work = pd.DataFrame({
    "machine": df[machine_col].astype("string").fillna("Unknown machine").str.strip(),
    "start": pd.to_datetime(df[cols["start"]], errors="coerce"),
    "status": df[cols["status"]].astype("string").str.strip().str.lower(),
    "description": df[cols["description"]].astype("string").fillna("").str.strip(),
    "minutes": pd.to_numeric(df[cols["minutes"]], errors="coerce"),
})
work.loc[work.machine.eq(""), "machine"] = "Unknown machine"
work = work.dropna(subset=["start", "minutes"])
work = work[(work.minutes >= 0) & work.status.isin(COLORS)].copy()
if work.empty:
    raise ValueError("No valid events. Status must be plan, planu, or unplan.")
work["description_key"] = work.description.str.casefold()
work["stop"] = work.start + pd.to_timedelta(work.minutes, unit="m")
work = work.sort_values(["machine", "start", "stop"]).reset_index(drop=True)

events = [
    {
        "machine": str(r.machine), "start": r.start.isoformat(), "end": r.stop.isoformat(),
        "status": str(r.status), "statusLabel": LABELS[str(r.status)],
        "description": str(r.description), "minutes": float(r.minutes),
        "color": COLORS[str(r.status)],
    }
    for r in work.itertuples(index=False)
]

# Gravure duration in hours:
# next boundary start - previous gravure stop,
# where previous gravure stop = event_start_date + dt_mins.
gravure = []
for machine, machine_data in work.groupby("machine", sort=False):
    machine_data = machine_data.sort_values("start").reset_index(drop=True)
    gravure_data = machine_data[
        (machine_data.status == "plan")
        & (machine_data.description_key == GRAVURE_DESCRIPTION.casefold())
    ].sort_values("start")
    cleaning_data = machine_data[
        machine_data.description_key == CLEANING_DESCRIPTION.casefold()
    ].sort_values("start")

    gravure_rows = list(gravure_data.itertuples(index=False))
    for index, previous in enumerate(gravure_rows):
        next_gravure = gravure_rows[index + 1] if index + 1 < len(gravure_rows) else None
        later_cleaning = cleaning_data[cleaning_data.start > previous.stop]
        next_cleaning = later_cleaning.iloc[0] if not later_cleaning.empty else None

        if next_cleaning is not None and (
            next_gravure is None or next_cleaning.start <= next_gravure.start
        ):
            next_start = next_cleaning.start
            next_stop = next_cleaning.stop
            next_event = str(next_cleaning.description)
            next_is_cleaning = True
            interval_type = "Gravure to Cleaning"
        elif next_gravure is not None:
            next_start = next_gravure.start
            next_stop = next_gravure.stop
            next_event = str(next_gravure.description)
            next_is_cleaning = False
            interval_type = "Gravure to Gravure"
        else:
            continue

        hours = (next_start - previous.stop).total_seconds() / 3600.0
        if hours >= 0:
            gravure.append({
                "machine": str(machine),
                "day": previous.start.date().isoformat(),
                "type": interval_type,
                "hours": float(hours),
                "previousStart": previous.start.isoformat(),
                "previousStop": previous.stop.isoformat(),
                "nextEvent": next_event,
                "nextStart": next_start.isoformat(),
                "nextStop": next_stop.isoformat(),
                "nextIsCleaning": next_is_cleaning,
            })

E = json.dumps(events, ensure_ascii=False).replace("</", "<\\/")
G = json.dumps(gravure, ensure_ascii=False).replace("</", "<\\/")

html = r'''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Machine Event Analysis</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f6fb;color:#14213d;font-family:Inter,Segoe UI,Arial}.app{max-width:1650px;margin:auto;padding:22px}.header,.controls,.filters{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.header{justify-content:space-between;align-items:end;margin-bottom:14px}h1{margin:0 0 5px;font-size:26px}h2{margin:0;font-size:18px}.sub,.note{font-size:12px;color:#667085}.card{background:#fff;border:1px solid #e5eaf1;border-radius:14px;box-shadow:0 6px 20px #14213d0e;margin-bottom:14px}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}.metric{padding:15px}.ml{font-size:12px;color:#667085}.mv{font-size:24px;font-weight:760;margin-top:4px}.title{padding:15px 16px 9px;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.filters{padding:10px 16px;background:#f8fafc;border-block:1px solid #edf1f6}.filters label,.controls label{font-size:12px;color:#475467}select,button,input{height:36px;border:1px solid #d8e0eb;border-radius:8px;background:#fff;padding:0 10px}input[type=number]{width:108px}button{cursor:pointer;font-weight:650}.primary{background:#2563eb;color:#fff;border-color:#2563eb}.timeline{height:520px}.chart{height:410px}.empty{display:none;text-align:center;padding:45px;color:#667085}.modal{display:none;position:fixed;inset:0;z-index:1000;background:#f3f6fb;overflow:auto}.modal.open{display:block}.modal-head{position:sticky;top:0;z-index:4;background:#fff;border-bottom:1px solid #e5eaf1;padding:14px 22px;display:flex;justify-content:space-between;align-items:center}.modal-body{padding:18px 22px}.modal .chart{height:47vh;min-height:360px}.gravure-kpis{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;margin-bottom:14px}.gravure-kpi{padding:14px 16px}.gravure-kpi .value{font-size:23px;font-weight:760;margin-top:4px}.table-wrap{overflow:auto;max-height:46vh;border:1px solid #e5eaf1;border-radius:10px;background:#fff}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{padding:10px 12px;border-bottom:1px solid #edf1f6;text-align:left;font-size:12px}th{position:sticky;top:0;background:#f8fafc;z-index:1}.cleaning{color:#b45309;font-weight:750}.type-cleaning,.type-gravure{border-radius:12px;padding:3px 8px;font-weight:700}.type-cleaning{background:#fff7ed;color:#c2410c}.type-gravure{background:#f3e8ff;color:#6d28d9}@media(max-width:950px){.summary,.gravure-kpis{grid-template-columns:1fr 1fr}.chart{height:360px}}
</style>
</head>
<body>
<div class="app">
<div class="header"><div><h1>Machine Event Analysis</h1><div class="sub">Status timeline and event-duration analysis</div></div><div class="controls"><label>Machine</label><select id="machine"></select><label>From</label><input id="dateFrom" type="date"><label>To</label><input id="dateTo" type="date"><button id="allDates">All dates</button><button id="gravureButton" class="primary">Gravure change analysis</button><button id="reset">Reset timeline zoom</button><button id="full">Full screen</button></div></div>
<div class="summary"><div class="card metric"><div class="ml">Uptime %</div><div class="mv" id="uptime">0.00%</div></div><div class="card metric"><div class="ml">Planned downtime %</div><div class="mv" id="plannedPct">0.00%</div></div><div class="card metric"><div class="ml">Unplanned downtime %</div><div class="mv" id="unplannedPct">0.00%</div></div></div>
<div class="card"><div class="title"><h2>Machine status timeline</h2><span class="note">Date range applies to the entire app and Gravure modal</span></div><div id="timeline" class="timeline"></div></div>
<div class="card"><div class="title"><h2>Event duration histogram</h2><span class="note">Duration unit: minutes</span></div><div class="filters"><label>Group</label><select id="group"><option value="plan">Planned</option><option value="unplan">Unplanned</option></select><label>Event</label><select id="event"></select><label>Bin size</label><input id="binsize" type="number" min="0.0001" step="any" value="5"><label>Data min</label><input id="rmin" type="number" step="any"><label>Data max</label><input id="rmax" type="number" step="any"></div><div id="hist" class="chart"></div><div id="eventEmpty" class="empty">No matching event data.</div></div>
<div class="card"><div class="title"><h2>Selected event trend</h2><span class="note">event_start_date vs dt_mins</span></div><div id="trend" class="chart"></div></div>
</div>
<div id="gravureModal" class="modal"><div class="modal-head"><div><h2>Gravure change analysis</h2><span id="modalRange" class="note"></span></div><button id="closeGravure">Close</button></div><div class="modal-body">
<div class="gravure-kpis"><div class="card gravure-kpi"><div class="ml">Total changeovers</div><div class="value" id="gravTotal">0</div></div><div class="card gravure-kpi"><div class="ml">Gravure to Gravure</div><div class="value" id="gravGG">0</div></div><div class="card gravure-kpi"><div class="ml">Gravure to Cleaning</div><div class="value" id="gravGC">0</div></div><div class="card gravure-kpi"><div class="ml">Cleaning ratio</div><div class="value" id="gravRatio">0.0%</div></div></div>
<div class="card"><div class="filters"><label>Bin size (hours)</label><input id="gbinsize" type="number" min="0.0001" step="any" value="1"><label>Data min (hours)</label><input id="grmin" type="number" step="any"><label>Data max (hours)</label><input id="grmax" type="number" step="any"></div><div id="gravhist" class="chart"></div><div id="gravEmpty" class="empty">No complete gravure intervals for this machine and date range.</div></div>
<div class="card"><div class="title"><h2>Gravure change duration details</h2><span id="gravCount" class="note"></span></div><div class="table-wrap"><table><thead><tr><th>Day</th><th>Type</th><th>Previous start</th><th>Previous stop</th><th>Next event</th><th>Next start</th><th>Next stop</th><th>Duration (hours)</th></tr></thead><tbody id="gravTable"></tbody></table></div></div>
</div></div>
<script>
const all=__EVENTS__,grav=__GRAVURE__,$=id=>document.getElementById(id),M=$('machine');
const C={timeline:echarts.init($('timeline')),hist:echarts.init($('hist')),trend:echarts.init($('trend')),grav:echarts.init($('gravhist'))};
[...new Set(all.map(x=>x.machine))].sort().forEach(x=>M.add(new Option(x,x)));
const pct=(n,d)=>d>0?(100*n/d).toFixed(2)+'%':'0.00%',dt=x=>String(x).replace('T',' '),dateOnly=x=>new Date(x).toISOString().slice(0,10);
const globalMin=dateOnly(Math.min(...all.map(x=>+new Date(x.start)))),globalMax=dateOnly(Math.max(...all.map(x=>+new Date(x.start))));$('dateFrom').value=globalMin;$('dateTo').value=globalMax;
function dateBounds(){const from=$('dateFrom').value?new Date($('dateFrom').value+'T00:00:00'):null,to=$('dateTo').value?new Date($('dateTo').value+'T00:00:00'):null;if(to)to.setDate(to.getDate()+1);return{from,to}}
function inRange(value){const t=new Date(value),b=dateBounds();return(!b.from||t>=b.from)&&(!b.to||t<b.to)}
function filteredMachineEvents(){return all.filter(x=>x.machine===M.value&&inRange(x.start))}
function filteredGravure(){return grav.filter(x=>x.machine===M.value&&inRange(x.previousStart))}
function render(p,a){const s=a.coord([a.value(1),0]),e=a.coord([a.value(2),0]),band=a.size([0,1])[1],h=Math.max(42,Math.min(96,band*.82)),q=echarts.graphic.clipRectByRect({x:s[0],y:s[1]-h/2,width:Math.max(e[0]-s[0],2),height:h,r:10},{x:p.coordSys.x,y:p.coordSys.y,width:p.coordSys.width,height:p.coordSys.height});return q&&{type:'rect',shape:q,style:a.style({stroke:'#fff',lineWidth:1})}}
function drawTimeline(){const rows=filteredMachineEvents(),sum=s=>rows.filter(x=>x.status===s).reduce((a,b)=>a+b.minutes,0),up=sum('planu'),pl=sum('plan'),un=sum('unplan'),total=up+pl+un;$('uptime').textContent=pct(up,total);$('plannedPct').textContent=pct(pl,total);$('unplannedPct').textContent=pct(un,total);C.timeline.clear();C.timeline.setOption({animation:false,grid:{left:105,right:25,top:25,bottom:85},tooltip:{formatter:p=>`${p.data.e.description||'No description'}<br>${p.data.e.statusLabel} | ${p.data.e.minutes.toFixed(1)} min<br>${dt(p.data.e.start)} → ${dt(p.data.e.end)}`},xAxis:{type:'time',scale:true},yAxis:{type:'category',data:[''],name:'Machine Timeline',nameLocation:'middle',nameRotate:90,nameGap:75,axisTick:{show:false},axisLine:{show:false},axisLabel:{show:false},nameTextStyle:{fontSize:14,fontWeight:'bold',color:'#475467'}},dataZoom:[{type:'inside',filterMode:'weakFilter'},{type:'slider',bottom:20,height:28,filterMode:'weakFilter'}],series:[{type:'custom',renderItem:render,encode:{x:[1,2],y:0},data:rows.map(x=>({value:[0,+new Date(x.start),+new Date(x.end)],itemStyle:{color:x.color},e:x}))}]},true)}
function histogram(vals,size,min,max){if(!vals.length||!Number.isFinite(size)||size<=0||!Number.isFinite(min)||!Number.isFinite(max)||max<min)return{labels:[],counts:[]};const first=min+size,n=Math.max(1,Math.ceil((max-min)/size)),counts=Array(n).fill(0),labels=Array.from({length:n},(_,i)=>+(first+i*size).toFixed(3));vals.forEach(v=>{if(v>=min&&v<=max)counts[Math.min(n-1,Math.floor((v-min)/size))]++});return{labels,counts}}
function eventRows(){return filteredMachineEvents().filter(x=>x.status===$('group').value&&(x.description||'(blank)')===$('event').value)}
function resetEvent(){const v=eventRows().map(x=>x.minutes);$('rmin').value=v.length?Math.min(...v):0;$('rmax').value=v.length?Math.max(...v):0;drawEvent()}
function eventOptions(){const names=[...new Set(filteredMachineEvents().filter(x=>x.status===$('group').value).map(x=>x.description||'(blank)'))].sort();$('event').innerHTML='';names.forEach(x=>$('event').add(new Option(x,x)));resetEvent()}
function drawEvent(){const lo=Number($('rmin').value),hi=Number($('rmax').value),size=Number($('binsize').value);if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo>hi)return;const rows=eventRows().filter(x=>x.minutes>=lo&&x.minutes<=hi),h=histogram(rows.map(x=>x.minutes),size,lo,hi);$('hist').style.display=rows.length?'block':'none';$('eventEmpty').style.display=rows.length?'none':'block';C.hist.setOption({grid:{left:65,right:25,top:35,bottom:75},tooltip:{trigger:'axis'},xAxis:{type:'category',name:'Upper bin boundary (min)',data:h.labels},yAxis:{type:'value',name:'Event count',minInterval:1},dataZoom:[{type:'inside'},{type:'slider',bottom:12,height:22}],series:[{type:'bar',data:h.counts,itemStyle:{color:$('group').value==='plan'?'#f59e0b':'#dc2626'}}]},true);C.trend.setOption({grid:{left:65,right:25,top:35,bottom:70},tooltip:{trigger:'axis'},xAxis:{type:'time'},yAxis:{type:'value',name:'Minutes'},dataZoom:[{type:'inside'},{type:'slider',bottom:12,height:22}],series:[{type:'line',smooth:true,showSymbol:true,data:rows.map(x=>[x.start,x.minutes]),lineStyle:{width:3,color:'#2563eb'},itemStyle:{color:'#2563eb'}}]},true)}
function renderGravureTable(rows){$('gravCount').textContent=`${rows.length} intervals`;$('gravTable').innerHTML=rows.map(x=>`<tr><td>${x.day}</td><td><span class="${x.nextIsCleaning?'type-cleaning':'type-gravure'}">${x.type}</span></td><td>${dt(x.previousStart)}</td><td>${dt(x.previousStop)}</td><td class="${x.nextIsCleaning?'cleaning':''}">${x.nextIsCleaning?'CLEANING: ':''}${x.nextEvent}</td><td>${dt(x.nextStart)}</td><td>${dt(x.nextStop)}</td><td>${x.hours.toFixed(3)}</td></tr>`).join('')}
function resetGrav(){const v=filteredGravure().map(x=>x.hours);$('grmin').value=v.length?Math.min(...v):0;$('grmax').value=v.length?Math.max(...v):0;drawGrav()}
function drawGrav(){const lo=Number($('grmin').value),hi=Number($('grmax').value),size=Number($('gbinsize').value);if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo>hi||!Number.isFinite(size)||size<=0)return;const rows=filteredGravure().filter(x=>x.hours>=lo&&x.hours<=hi),ggRows=rows.filter(x=>!x.nextIsCleaning),gcRows=rows.filter(x=>x.nextIsCleaning),gg=histogram(ggRows.map(x=>x.hours),size,lo,hi),gc=histogram(gcRows.map(x=>x.hours),size,lo,hi);$('modalRange').textContent=`${M.value} | ${$('dateFrom').value||'First'} to ${$('dateTo').value||'Last'} | hours`;$('gravTotal').textContent=rows.length;$('gravGG').textContent=ggRows.length;$('gravGC').textContent=gcRows.length;$('gravRatio').textContent=rows.length?(100*gcRows.length/rows.length).toFixed(1)+'%':'0.0%';$('gravhist').style.display=rows.length?'block':'none';$('gravEmpty').style.display=rows.length?'none':'block';C.grav.clear();C.grav.setOption({grid:{left:65,right:25,top:65,bottom:75},legend:{top:10,data:['Gravure to Gravure','Gravure to Cleaning']},tooltip:{trigger:'axis',formatter:params=>{const g=params.find(x=>x.seriesName==='Gravure to Gravure')?.value||0,c=params.find(x=>x.seriesName==='Gravure to Cleaning')?.value||0;return `Upper boundary: ${params[0]?.axisValue||''} h<br>Gravure to Gravure: ${g}<br>Gravure to Cleaning: ${c}<br><b>Total: ${g+c}</b>`}},xAxis:{type:'category',name:'Upper bin boundary (hours)',data:gg.labels.length?gg.labels:gc.labels},yAxis:{type:'value',name:'Changeover count',minInterval:1},dataZoom:[{type:'inside'},{type:'slider',bottom:12,height:22}],series:[{name:'Gravure to Gravure',type:'bar',stack:'changeovers',data:gg.counts,itemStyle:{color:'#7c3aed'}},{name:'Gravure to Cleaning',type:'bar',stack:'changeovers',data:gc.counts,itemStyle:{color:'#f97316'}}]},true);renderGravureTable(rows)}
function refresh(){drawTimeline();eventOptions();resetGrav()}M.onchange=refresh;$('dateFrom').onchange=$('dateTo').onchange=refresh;$('allDates').onclick=()=>{$('dateFrom').value=globalMin;$('dateTo').value=globalMax;refresh()};$('group').onchange=eventOptions;$('event').onchange=resetEvent;['binsize','rmin','rmax'].forEach(id=>$(id).oninput=drawEvent);['gbinsize','grmin','grmax'].forEach(id=>$(id).oninput=drawGrav);$('reset').onclick=()=>C.timeline.dispatchAction({type:'dataZoom',start:0,end:100});$('full').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();$('gravureButton').onclick=()=>{$('gravureModal').classList.add('open');document.body.style.overflow='hidden';resetGrav();setTimeout(()=>C.grav.resize(),50)};$('closeGravure').onclick=()=>{$('gravureModal').classList.remove('open');document.body.style.overflow=''};document.addEventListener('keydown',e=>{if(e.key==='Escape')$('closeGravure').click()});addEventListener('resize',()=>Object.values(C).forEach(x=>x.resize()));if(M.options.length){M.selectedIndex=0;refresh()}
</script>
</body>
</html>'''.replace('__EVENTS__', E).replace('__GRAVURE__', G)

OUTPUT_HTML.write_text(html, encoding='utf-8')
print(f"Created: {OUTPUT_HTML.resolve()} | events={len(work):,} | gravure intervals={len(gravure):,}")
if AUTO_OPEN:
    webbrowser.open(OUTPUT_HTML.resolve().as_uri())
