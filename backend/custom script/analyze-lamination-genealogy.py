"""Lamination genealogy report.

Queries two datasets and builds one interactive ECharts dashboard:

  1. lot_genealogy (FabLIMS: GM_BATCH / G_LSN / GM_WOL) — the raw materials
     issued to each work order lot (WOL).
  2. FMI events (FAB_MESA10: MESA_EVENT_HISTORY) — the packaged lots produced
     for each WOL, plus the defects / allowances recorded against them.

Both statements carry a ``WOL in ('')`` criterion (see ``WOLS`` below): the
empty list keeps the literal placeholder exactly as written, and adding lots
turns it into ``WOL in ('WOL1','WOL2')``.

The layout and analysis mirror ``backend/tests/lamination_genealogy_echarts.py``
(raw usage -> finished goods stacked bars, per-WOL dropdown, KPI cards,
normalize/label toggles and a search box). The packaged-lots row is drawn on the
FMI roll axis: the lots are contiguous, so each one spans from its own X_Position
to the next lot's X_Position (the final lot spans its X_Position + Gross_Mtr). The
defect / allowance events (Event_reason + Scrap_quantity / Allowance_quantity) are
overlaid on that row at the same X_Position, and two pie charts below split the
scrap / allowance quantity by event reason.

The script runs in-process inside the app, so it opens each source's connection
through the app's own connection store (passwords come from the OS keyring).
Run standalone from a shell it falls back to a direct DSN connection.
"""
import json
import webbrowser
from datetime import datetime
from pathlib import Path

import pandas as pd

# Connections to use: matched against a stored connection's name, DSN or id.
FABLIMS_CONNECTION = "FabLIMS"      # raw-material genealogy (GM_BATCH / G_LSN / GM_WOL)
MESA_CONNECTION = "FAB_MESA10"      # FMI events (MESA_EVENT_HISTORY): packages + defects

# WOL filter. Leave empty to keep the literal ``WOL in ('')`` criterion, or add
# work-order lots (e.g. ["WOL123", "WOL456"]) to restrict both queries.
WOLS: list[str] = ["02613743AA", "02652964AA", "02652964AB", "02714246AA", "02809491AA"]

ECHARTS_URL = "https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js"
COLORS = {"WFACE": "#2f80ed", "WFILM": "#9b51e0", "WBACK": "#27ae60"}
LABELS = {"WFACE": "Face", "WFILM": "Film", "WBACK": "Backer"}

def _wol_in_clause(column: str) -> str:
    """A ``<column> in (...)`` clause; empty WOLS -> the literal ``('')``."""
    values = ",".join(f"'{str(w).strip()}'" for w in WOLS if str(w).strip()) or "''"
    return f"{column} in ({values})"


GENEALOGY_SQL = f"""
SELECT DISTINCT
    gm_batch.TO_LOT AS 'WOL',
    gm_wol.PRODUCT AS 'PRODUCT',
    gm_batch.EVENT_REASON AS 'BOM',
    gm_batch.ITEM_NUMBER AS 'RAW_ITEM',
    gm_batch.G_BATCH AS 'GORE_BATCH',
    gm_batch.FROM_LOT AS 'RAW_LOT',
    ROUND(gm_batch.PRIMARY_QTY, 1) AS 'RAW_QUANTITY',
    gm_batch.GM_OPERATION AS 'RAW_ISSUE_STEP',
    gm_batch.CHANGED_ON AS 'RAW_ISSUE_DATE',
    g_lsn.G_SUPPLIER_BATCH AS 'SUPPLIER_BATCH',
    g_lsn.G_SUPPLIER_PIECE AS 'SUPPLIER_PIECE',
    g_lsn.G_PURCHASE_ORDER_NO AS 'SUPPLIER_PO'
FROM GM_BATCH gm_batch
LEFT JOIN G_LSN g_lsn ON gm_batch.FROM_LOT = g_lsn.NAME
LEFT JOIN GM_WOL gm_wol ON gm_wol.G_WOL = gm_batch.TO_LOT
WHERE 1 = 1
    AND gm_batch.EVENT_REASON IN ('WFACE','WFILM','WBACK')
    AND {_wol_in_clause('gm_batch.TO_LOT')}
ORDER BY gm_batch.TO_LOT, gm_batch.EVENT_REASON, gm_batch.CHANGED_ON ASC
"""

# FMI events for the listed WOLs: one row per packaged lot (LSN + Gross_Mtr at
# X_Position) and one row per defect / allowance (Event_reason at X_Position,
# with Scrap_quantity or Allowance_quantity). Runs against FAB_MESA10.
LSN_SQL = f"""
SELECT
    event_type AS Event_type,
    event_reason AS Event_reason,
    plant AS Plant,
    operation AS Operation,
    x_position AS X_position,
    x_length AS X_length,
    lot_number AS WOL,
    to_lot AS LSN,
    CASE
        WHEN transaction_year IS NOT NULL
         AND transaction_month IS NOT NULL
         AND transaction_day IS NOT NULL
         AND transaction_time IS NOT NULL
        THEN TO_DATE(
            LPAD(TO_CHAR(transaction_year), 4, '0') ||
            LPAD(TO_CHAR(transaction_month), 2, '0') ||
            LPAD(TO_CHAR(transaction_day), 2, '0') ||
            LPAD(TO_CHAR(transaction_time), 6, '0'),
            'YYYYMMDDHH24MISS'
        )
        ELSE NULL
    END AS Transaction_datetime,
    quantity AS Gross_Mtr,
    secondary_quantity AS Net_Mtr,
    resource1 AS MES_resource,
    employee AS Employee,
    package_number AS Package,
    scrap_quantity AS Scrap_quantity,
    allowance_quantity AS Allowance_quantity,
    record_status AS Record_status
FROM MESA_EVENT_HISTORY
WHERE {_wol_in_clause('lot_number')}
    AND operation = 'FMI'
"""


def _open_connection(connection: str = FABLIMS_CONNECTION):
    """Return a pyodbc connection to ``connection`` (app store first, DSN fallback)."""
    try:
        from app.api.connections import load_stored_connections
        from app.db import odbc
    except Exception:  # noqa: BLE001 - standalone execution: use the DSN directly
        import pyodbc

        return pyodbc.connect(
            f"DSN={connection};Trusted_Connection=yes;", autocommit=True
        )
    wanted = connection.lower()
    for conn in load_stored_connections():
        keys = {
            str(conn.get("name", "")).lower(),
            str(conn.get("dsn", "")).lower(),
            str(conn.get("id", "")).lower(),
        }
        if wanted in keys:
            return odbc.open_connection(conn)
    raise RuntimeError(
        f"No stored connection named/DSN '{connection}' was found. "
        "Add it in the app or set the connection constants at the top of this script."
    )


def _fetch(sql: str, label: str, connection: str = FABLIMS_CONNECTION) -> list:
    """Run a read-only query and return its rows as a list of dicts."""
    cnxn = _open_connection(connection)
    try:
        cursor = cnxn.cursor()
        cursor.execute(sql)
        if cursor.description is None:
            print(f"    -> {label} query returned no result set.", flush=True)
            return []
        columns = [d[0] for d in cursor.description]
        rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
        print(f"    -> {label} query returned {len(rows):,} rows.", flush=True)
        return rows
    finally:
        cnxn.close()


def _prepare(genealogy_rows: list, lsn_rows: list):
    """Turn the two query results into the clean frames the analysis expects."""
    g = pd.DataFrame(genealogy_rows)
    l = pd.DataFrame(lsn_rows)
    g.columns = [str(c).strip().upper() for c in g.columns]
    l.columns = [str(c).strip().upper() for c in l.columns]
    for c in [
        "WOL", "BOM", "GORE_BATCH", "RAW_LOT", "RAW_ITEM", "RAW_ISSUE_STEP",
        "SUPPLIER_BATCH", "SUPPLIER_PIECE", "SUPPLIER_PO",
    ]:
        if c in g.columns:
            g[c] = g[c].fillna("").astype(str).str.strip()
    for c in ["WOL", "LSN", "EVENT_REASON", "PACKAGE", "MES_RESOURCE", "EMPLOYEE", "EVENT_TYPE"]:
        if c in l.columns:
            l[c] = l[c].fillna("").astype(str).str.strip()
    g["RAW_QUANTITY"] = pd.to_numeric(g["RAW_QUANTITY"], errors="coerce").fillna(0) \
        if "RAW_QUANTITY" in g else 0
    for c in ["GROSS_MTR", "NET_MTR", "X_POSITION", "X_LENGTH", "SCRAP_QUANTITY", "ALLOWANCE_QUANTITY"]:
        if c in l.columns:
            l[c] = pd.to_numeric(l[c], errors="coerce").fillna(0)
    g["_D"] = pd.to_datetime(g["RAW_ISSUE_DATE"], errors="coerce") if "RAW_ISSUE_DATE" in g else pd.NaT
    l["_D"] = pd.to_datetime(l["TRANSACTION_DATETIME"], errors="coerce") if "TRANSACTION_DATETIME" in l else pd.NaT
    return g, l


def make_data(g, l):
    out = {}
    has_lsn = not l.empty and "WOL" in l.columns
    # Include every WOL in genealogy. If no LSN match exists it still appears, with raw genealogy only.
    for w in sorted(x for x in g["WOL"].unique() if x):
        packages, defects = [], []
        if has_lsn:
            # Packaged lots: a finished lot (LSN) with a gross length, placed on
            # the roll at its start position X_POSITION.
            p = l[(l["WOL"] == w) & (l["LSN"] != "") & (l["GROSS_MTR"] > 0)].sort_values(
                ["X_POSITION", "_D", "LSN"], kind="stable"
            )
            packages = [
                {
                    "name": r["LSN"],
                    "qty": float(r["GROSS_MTR"]),
                    "pos": float(r["X_POSITION"]),
                    "net": float(r["NET_MTR"]),
                    "package": r.get("PACKAGE", ""),
                    "resource": r.get("MES_RESOURCE", ""),
                    "employee": r.get("EMPLOYEE", ""),
                    "date": "" if pd.isna(r["_D"]) else r["_D"].strftime("%Y-%m-%d %H:%M"),
                }
                for _, r in p.iterrows()
            ]
            # Lots are contiguous on the roll: each one ends where the next one
            # starts, and the final lot ends at its own start + gross length.
            for i, pk in enumerate(packages):
                nxt = packages[i + 1]["pos"] if i + 1 < len(packages) else None
                pk["end"] = nxt if (nxt is not None and nxt > pk["pos"]) else pk["pos"] + pk["qty"]
            # Defects / allowances: an event with a reason label and a scrap or
            # allowance quantity, recorded at the same X_POSITION axis.
            d = l[
                (l["WOL"] == w)
                & ((l["SCRAP_QUANTITY"] > 0) | (l["ALLOWANCE_QUANTITY"] > 0))
            ].sort_values(["X_POSITION", "_D"], kind="stable")
            defects = [
                {
                    "label": r.get("EVENT_REASON", ""),
                    "pos": float(r["X_POSITION"]),
                    "scrap": float(r["SCRAP_QUANTITY"]),
                    "allowance": float(r["ALLOWANCE_QUANTITY"]),
                    "event": r.get("EVENT_TYPE", ""),
                    "resource": r.get("MES_RESOURCE", ""),
                    "employee": r.get("EMPLOYEE", ""),
                    "package": r.get("PACKAGE", ""),
                    "date": "" if pd.isna(r["_D"]) else r["_D"].strftime("%Y-%m-%d %H:%M"),
                }
                for _, r in d.iterrows()
            ]
        boms = {}
        order = ["WFACE", "WFILM", "WBACK"] + sorted(
            set(g.loc[g["WOL"] == w, "BOM"]) - {"WFACE", "WFILM", "WBACK"}
        )
        for b in order:
            x = g[(g["WOL"] == w) & (g["BOM"] == b) & (g["RAW_QUANTITY"] > 0)].sort_values(
                ["_D", "GORE_BATCH", "RAW_LOT"], kind="stable"
            )
            if len(x):
                boms[b] = [
                    {
                        "batch": r["GORE_BATCH"],
                        "lot": r["RAW_LOT"],
                        "qty": float(r["RAW_QUANTITY"]),
                        "item": r.get("RAW_ITEM", ""),
                        "step": r.get("RAW_ISSUE_STEP", ""),
                        "sbatch": r.get("SUPPLIER_BATCH", ""),
                        "spiece": r.get("SUPPLIER_PIECE", ""),
                        "spo": r.get("SUPPLIER_PO", ""),
                    }
                    for _, r in x.iterrows()
                ]
        if boms:
            out[w] = {"packages": packages, "defects": defects, "boms": boms}
    return out


def write_html(data, out):
    opts = "".join(f'<option value="{w}">{w}</option>' for w in data)
    js = json.dumps(data, separators=(",", ":"))
    html = '''<!doctype html><meta charset="utf-8"><title>Genealogy - All WOL</title><script src="''' + ECHARTS_URL + '''"></script><style>body{margin:0;background:#eef2f7;font:14px Arial;color:#1f2937}header{padding:15px 20px;background:#17365d;color:#fff}.bar{padding:10px 18px;background:#fff;display:flex;gap:9px;align-items:center;flex-wrap:wrap}.bar select,.bar input,.bar button{padding:8px;border:1px solid #cbd5e1;border-radius:7px;background:#fff}.active{background:#6d28d9!important;color:white}.k{display:flex;gap:10px;padding:12px 16px;flex-wrap:wrap}.k div{background:#fff;padding:9px 13px;border-radius:8px}#chart{height:620px;margin:0 16px;background:#fff;border-radius:10px}.pies{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 16px 48px}#pieScrap,#pieAllow{height:340px;background:#fff;border-radius:10px}@media(max-width:768px){.pies{grid-template-columns:1fr}}</style><header><h2 style="margin:0">Raw Usage \u2192 Finished Goods Genealogy</h2></header><div class="bar"><label>WOL <select id="wol">__OPTS__</select></label><span id="rot"></span><button id="norm">Normalize: Off</button><button id="lab" class="active">Labels: On</button><input id="find" placeholder="Search batch, lot, package, comment" size="32"><b id="count"></b></div><div class="k" id="kpis"></div><div id="chart"></div><div class="pies"><div id="pieScrap"></div><div id="pieAllow"></div></div><script>
const DATA=__DATA__,C=__C__,L=__L__,S={rev:{},norm:false,labels:true,q:''};const $=x=>document.getElementById(x),wol=$('wol'),rot=$('rot'),norm=$('norm'),lab=$('lab'),find=$('find'),kpis=$('kpis'),count=$('count');count.textContent=Object.keys(DATA).length+' WOLs';const chart=echarts.init($('chart')),pieScrap=echarts.init($('pieScrap')),pieAllow=echarts.init($('pieAllow')),sum=(a,k)=>a.reduce((s,x)=>s+(+x[k]||0),0);function ints(a){let t=sum(a,'qty'),c=0;return a.map(x=>{let q=+x.qty||0,z={...x,start:S.norm?(t?c/t*100:0):c,end:S.norm?(t?(c+q)/t*100:0):(c+q)};c+=q;return z})}function buttons(){let bs=Object.keys(DATA[wol.value].boms);rot.innerHTML=bs.map(b=>`<button data-b="${b}" class="${S.rev[b]?'active':''}">\u2194 ${L[b]||b}</button>`).join(' ');rot.querySelectorAll('button').forEach(b=>b.onclick=()=>{S.rev[b.dataset.b]=!S.rev[b.dataset.b];buttons();draw()})}function draw(){let d=DATA[wol.value],bs=Object.keys(d.boms),defs=d.defects||[],hasPkg=d.packages.length>0,hasRow=hasPkg||defs.length>0,pkgY=bs.length,rollEnd=Math.max(d.packages.reduce((m,p)=>Math.max(m,p.end),0),defs.reduce((m,x)=>Math.max(m,x.pos),0),1),tx=v=>S.norm?v/rollEnd*100:v,cats=bs.map(b=>(L[b]||b)+' raw').concat(hasRow?['Packaged lots']:[]),items=[],maxQ=0;bs.forEach((b,y)=>{let a=[...d.boms[b]];if(S.rev[b])a.reverse();maxQ=Math.max(maxQ,sum(a,'qty'));ints(a).forEach(x=>items.push({...x,bom:b,kind:'raw',color:C[b]||'#64748b',value:[x.start,x.end,y]}))});if(hasPkg){maxQ=Math.max(maxQ,rollEnd);d.packages.forEach(x=>items.push({...x,kind:'pkg',color:'#f2994a',value:[tx(x.pos),tx(x.end),pkgY]}))}defs.forEach(x=>items.push({...x,kind:'defect',value:[tx(x.pos),tx(x.pos),pkgY]}));let fg=sum(d.packages,'qty'),scrapT=sum(defs,'scrap'),allowT=sum(defs,'allowance');kpis.innerHTML=`<div><b>WOL</b><br>${wol.value}</div><div><b>Packaged lots</b><br>${d.packages.length}</div><div><b>Gross m</b><br>${fg.toFixed(1)}</div><div><b>Scrap qty</b><br>${scrapT.toFixed(1)}</div><div><b>Allowance qty</b><br>${allowT.toFixed(1)}</div><div><b>Events</b><br>${defs.length}</div>`+bs.map(b=>`<div><b>${L[b]||b} raw</b><br>${sum(d.boms[b],'qty').toFixed(1)}</div>`).join('');let needle=S.q.toLowerCase();chart.setOption({animation:false,title:{text:'Work order '+wol.value+(hasPkg?'':' (no packaged lots found)'),left:18,top:10},toolbox:{right:18,feature:{dataZoom:{},restore:{},saveAsImage:{}}},grid:{left:130,right:35,top:60,bottom:80},xAxis:{type:'value',min:0,max:S.norm?100:(maxQ||1),axisLabel:{formatter:v=>S.norm?v+'%':Math.round(v).toLocaleString()}},yAxis:{type:'category',data:cats,inverse:true},dataZoom:[{type:'inside',filterMode:'none'},{type:'slider',filterMode:'none',bottom:12,height:20}],tooltip:{formatter:p=>{let x=p.data;if(x.kind==='defect')return `<b>${x.label}</b><br>Position: ${x.pos}<br>Scrap qty: ${x.scrap}<br>Allowance qty: ${x.allowance}<br>Event: ${x.event||'-'}<br>Resource: ${x.resource||'-'}<br>Employee: ${x.employee||'-'}<br>Package: ${x.package||'-'}<br>Date: ${x.date||'-'}`;return x.kind==='pkg'?`<b>${x.name}</b><br>Start pos: ${x.pos}<br>End pos: ${x.end}<br>Gross m: ${x.qty}<br>Net m: ${x.net}<br>Package: ${x.package||'-'}<br>Resource: ${x.resource||'-'}<br>Employee: ${x.employee||'-'}<br>Date: ${x.date||'-'}`:`<b>${L[x.bom]||x.bom}</b><br>Batch: ${x.batch}<br>Lot: ${x.lot}<br>Qty: ${x.qty}<br>Raw item: ${x.item||'-'}<br>Issue step: ${x.step||'-'}<br>Supplier batch: ${x.sbatch||'-'}<br>Supplier piece: ${x.spiece||'-'}<br>Supplier PO: ${x.spo||'-'}`}},series:[{type:'custom',encode:{x:[0,1],y:2},renderItem:(p,a)=>{let x=items[p.dataIndex],hit=!needle||JSON.stringify(x).toLowerCase().includes(needle);if(x.kind==='defect'){let cx=a.coord([a.value(0),a.value(2)])[0],cy=a.coord([0,a.value(2)])[1],rh=Math.abs(a.size([0,1])[1]),u=4,ym=cy-rh*.29-u-2,scrap=x.scrap>0,color=scrap?'#e11d48':'#e0a800',ch=[{type:'rect',shape:{x:cx-u*3,y:ym-u*3,width:u*6,height:u*6},style:{fill:'rgba(0,0,0,0.001)'}}].concat(scrap?[{type:'line',shape:{x1:cx-u,y1:ym-u,x2:cx+u,y2:ym+u},style:{stroke:color,lineWidth:2,opacity:hit?1:.15}},{type:'line',shape:{x1:cx-u,y1:ym+u,x2:cx+u,y2:ym-u},style:{stroke:color,lineWidth:2,opacity:hit?1:.15}}]:[{type:'polygon',shape:{points:[[cx,ym-u],[cx+u,ym],[cx,ym+u],[cx-u,ym]]},style:{fill:color,stroke:'#fff',lineWidth:1,opacity:hit?1:.15}}]);if(S.labels)ch.push({type:'text',style:{x:cx,y:ym-u-2,text:x.label,fill:color,font:'10px Arial',align:'center',verticalAlign:'bottom',opacity:hit?1:.15,stroke:'#fff',lineWidth:2}});return {type:'group',children:ch}}let p0=a.coord([a.value(0),a.value(2)]),p1=a.coord([a.value(1),a.value(2)]),h=Math.abs(a.size([0,1])[1])*.58,w=Math.max(1,p1[0]-p0[0]),ch=[{type:'rect',shape:{x:p0[0],y:p0[1]-h/2,width:w,height:h,r:4},style:{fill:x.color,stroke:'#fff',opacity:hit?1:.12}}];if(S.labels&&w>55)ch.push({type:'text',style:{x:p0[0]+w/2,y:p0[1],text:x.kind==='pkg'?x.name:x.lot,fill:'#fff',font:'11px Arial',align:'center',verticalAlign:'middle',opacity:hit?1:.12}});return {type:'group',children:ch}},data:items}]},true);const gs={},ga={};defs.forEach(x=>{if(needle&&!JSON.stringify(x).toLowerCase().includes(needle))return;const k=x.label||'(none)';if(x.scrap>0)gs[k]=(gs[k]||0)+x.scrap;if(x.allowance>0)ga[k]=(ga[k]||0)+x.allowance});const pie=(t,o,c)=>({animation:false,color:c,title:{text:t,left:'center',top:8,textStyle:{fontSize:13,fontWeight:600}},tooltip:{trigger:'item',formatter:p=>p.name+'<br>'+p.value.toFixed(2)+' ('+p.percent+'%)'},legend:{bottom:10,type:'scroll',icon:'circle',itemWidth:9,itemHeight:9,textStyle:{fontSize:11}},series:[{type:'pie',radius:['32%','54%'],center:['50%','48%'],data:Object.keys(o).map(k=>({name:k,value:+o[k].toFixed(2)})).sort((a,b)=>b.value-a.value),label:{formatter:p=>p.name+' '+p.value.toFixed(2),fontSize:10},labelLine:{length:6,length2:6},itemStyle:{borderColor:'#fff',borderWidth:1}}]});pieScrap.setOption(pie('Scrap quantity by event reason',gs,['#e11d48','#fb7185','#fda4af','#fecdd3','#f9a8d4']),true);pieAllow.setOption(pie('Allowance quantity by event reason',ga,['#e0a800','#fbbf24','#fcd34d','#fde68a','#fef3c7']),true)}wol.onchange=()=>{S.rev={};buttons();draw()};norm.onclick=()=>{S.norm=!S.norm;norm.textContent='Normalize: '+(S.norm?'On':'Off');norm.classList.toggle('active',S.norm);draw()};lab.onclick=()=>{S.labels=!S.labels;lab.textContent='Labels: '+(S.labels?'On':'Off');lab.classList.toggle('active',S.labels);draw()};find.oninput=e=>{S.q=e.target.value;draw()};window.onresize=()=>{chart.resize();pieScrap.resize();pieAllow.resize()};buttons();draw();</script>'''.replace('__OPTS__', opts).replace('__DATA__', js).replace('__C__', json.dumps(COLORS)).replace('__L__', json.dumps(LABELS))
    Path(out).write_text(html, encoding="utf-8")


def main() -> None:
    print("=== Lamination genealogy report ===", flush=True)
    print(f"Genealogy connection: {FABLIMS_CONNECTION}", flush=True)
    print(f"FMI events connection: {MESA_CONNECTION}", flush=True)
    wol_filter = WOLS if WOLS else "(all - literal WOL in ('') )"
    print(f"WOL filter: {wol_filter}", flush=True)

    print("[1/6] Querying lot_genealogy ...", flush=True)
    genealogy_rows = _fetch(GENEALOGY_SQL, "genealogy", FABLIMS_CONNECTION)
    print("[2/6] Querying FMI events ...", flush=True)
    lsn_rows = _fetch(LSN_SQL, "FMI events", MESA_CONNECTION)

    print("[3/6] Preparing data ...", flush=True)
    g, l = _prepare(genealogy_rows, lsn_rows)
    if g.empty or "WOL" not in g.columns:
        print("No genealogy rows returned — check the WOL filter (WOLS) or the query.", flush=True)
        return
    print(f"    -> genealogy {len(g):,} rows | FMI events {len(l):,} rows after cleaning.", flush=True)

    print("[4/6] Building chart data ...", flush=True)
    report = make_data(g, l)
    if not report:
        print("No WOL with raw usage found — nothing to chart.", flush=True)
        return
    print(f"    -> {len(report)} WOL(s): {', '.join(list(report)[:10])}"
          f"{' ...' if len(report) > 10 else ''}", flush=True)

    print("[5/6] Writing chart HTML ...", flush=True)
    out = Path.home() / "Downloads" / f"lamination_genealogy_echarts_{datetime.now():%Y%m%d_%H%M%S}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    write_html(report, out)
    print(f"    -> saved: {out}", flush=True)

    print("[6/6] Opening chart in browser ...", flush=True)
    try:
        webbrowser.open(out.as_uri())
        print("    -> done.", flush=True)
    except Exception as exc:  # noqa: BLE001 - opening the browser is best-effort
        print(f"    -> could not open browser automatically: {exc}", flush=True)
    print("=== Finished ===", flush=True)


if __name__ == "__main__":
    main()
