"""FabLIMS lamination genealogy report.

Queries two FabLIMS datasets and builds one interactive ECharts dashboard:

  1. lot_genealogy  (GM_BATCH / G_LSN / GM_WOL) — the raw materials issued to
     each work order lot (WOL).
  2. LSN            (G_LSN / GM_SAMPLES)        — the packaged lots produced for
     each WOL.

Both statements carry a ``WOL in ('')`` criterion (see ``WOLS`` below): the
empty list keeps the literal placeholder exactly as written, and adding lots
turns it into ``WOL in ('WOL1','WOL2')``.

The layout and analysis mirror ``backend/tests/lamination_genealogy_echarts.py``
(raw usage -> finished goods stacked bars, per-WOL dropdown, KPI cards,
normalize/label toggles and a search box).

The script runs in-process inside the app, so it opens the FabLIMS connection
through the app's own connection store (passwords come from the OS keyring).
Run standalone from a shell it falls back to a direct DSN connection.
"""
import json
import webbrowser
from datetime import datetime
from pathlib import Path

import pandas as pd

# Connection to use: matched against a stored connection's name, DSN or id.
FABLIMS_CONNECTION = "FabLIMS"

# WOL filter. Leave empty to keep the literal ``WOL in ('')`` criterion, or add
# work-order lots (e.g. ["WOL123", "WOL456"]) to restrict both queries.
WOLS: list[str] = ["02613743AA", "02652964AA", "02652964AB", "02714246AA"]

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

LSN_SQL = f"""
SELECT *
FROM (
    SELECT
        g.G_WOL,
        g.G_ITEM,
        s.DESCRIPTION,
        s.G_WOL_BOR,
        g.NAME,
        g.G_ROLL_INDEX,
        g.G_FACE_BATCH,
        g.G_LINER_BATCH,
        g.G_MAN_DATE,
        ROUND(g.G_LSN_QTY,2) AS G_LSN_QTY,
        g.DESCRIPTION AS Comment,
        gm.changed_by
    FROM G_LSN g
    JOIN GM_LSN gm
        ON g.NAME = gm.G_LSN
       AND gm.GM_OPERATION = 'FMI'
    LEFT JOIN SAMPLE s
        ON g.SAMPLE_NUMBER = s.SAMPLE_NUMBER

    UNION ALL

    SELECT
        gs.G_WOL,
        gs.PRODUCT,
        gi.DESCRIPTION,
        '',
        gs.G_LSN_SAMPLE,
        gs.G_ROLL_INDEX,
        '',
        '',
        gs.G_MAN_DATE,
        ROUND(gs.G_LSN_QTY,2),
        gs.G_LIMS_SAMPLE,
        ''
    FROM GM_SAMPLES gs
    LEFT JOIN G_ITEM gi
        ON gs.PRODUCT = gi.NAME
) x
WHERE G_WOL not like 'F%'
    AND {_wol_in_clause('G_WOL')}
ORDER BY G_WOL, G_MAN_DATE ASC
"""


def _open_connection():
    """Return a pyodbc connection to FabLIMS (app store first, DSN fallback)."""
    try:
        from app.api.connections import load_stored_connections
        from app.db import odbc
    except Exception:  # noqa: BLE001 - standalone execution: use the DSN directly
        import pyodbc

        return pyodbc.connect(
            f"DSN={FABLIMS_CONNECTION};Trusted_Connection=yes;", autocommit=True
        )
    wanted = FABLIMS_CONNECTION.lower()
    for conn in load_stored_connections():
        keys = {
            str(conn.get("name", "")).lower(),
            str(conn.get("dsn", "")).lower(),
            str(conn.get("id", "")).lower(),
        }
        if wanted in keys:
            return odbc.open_connection(conn)
    raise RuntimeError(
        f"No stored connection named/DSN '{FABLIMS_CONNECTION}' was found. "
        "Add it in the app or set FABLIMS_CONNECTION at the top of this script."
    )


def _fetch(sql: str, label: str) -> list:
    """Run a read-only query and return its rows as a list of dicts."""
    cnxn = _open_connection()
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
    for c in ["G_WOL", "NAME", "COMMENT"]:
        l[c] = l[c].fillna("").astype(str).str.strip()
    g["RAW_QUANTITY"] = pd.to_numeric(g["RAW_QUANTITY"], errors="coerce").fillna(0)
    l["G_LSN_QTY"] = pd.to_numeric(l["G_LSN_QTY"], errors="coerce").fillna(0)
    g["_D"] = pd.to_datetime(g["RAW_ISSUE_DATE"], errors="coerce") if "RAW_ISSUE_DATE" in g else pd.NaT
    l["_D"] = pd.to_datetime(l["G_MAN_DATE"], errors="coerce") if "G_MAN_DATE" in l else pd.NaT
    l["_R"] = pd.to_numeric(l["G_ROLL_INDEX"], errors="coerce") if "G_ROLL_INDEX" in l else range(len(l))
    return g, l


def make_data(g, l):
    out = {}
    # Include every WOL in genealogy. If no LSN match exists it still appears, with raw genealogy only.
    for w in sorted(x for x in g["WOL"].unique() if x):
        p = l[(l["G_WOL"] == w) & (l["G_LSN_QTY"] > 0) & (l["NAME"] != "")].sort_values(
            ["_R", "_D", "NAME"], kind="stable"
        )
        packages = [
            {
                "name": r["NAME"],
                "qty": float(r["G_LSN_QTY"]),
                "comment": r["COMMENT"],
                "roll": None if pd.isna(r["_R"]) else float(r["_R"]),
            }
            for _, r in p.iterrows()
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
            out[w] = {"packages": packages, "boms": boms}
    return out


def write_html(data, out):
    opts = "".join(f'<option value="{w}">{w}</option>' for w in data)
    js = json.dumps(data, separators=(",", ":"))
    html = '''<!doctype html><meta charset="utf-8"><title>Genealogy - All WOL</title><script src="''' + ECHARTS_URL + '''"></script><style>body{margin:0;background:#eef2f7;font:14px Arial;color:#1f2937}header{padding:15px 20px;background:#17365d;color:#fff}.bar{padding:10px 18px;background:#fff;display:flex;gap:9px;align-items:center;flex-wrap:wrap}.bar select,.bar input,.bar button{padding:8px;border:1px solid #cbd5e1;border-radius:7px;background:#fff}.active{background:#6d28d9!important;color:white}.k{display:flex;gap:10px;padding:12px 16px;flex-wrap:wrap}.k div{background:#fff;padding:9px 13px;border-radius:8px}#chart{height:620px;margin:0 16px;background:#fff;border-radius:10px}</style><header><h2 style="margin:0">Raw Usage \u2192 Finished Goods Genealogy</h2></header><div class="bar"><label>WOL <select id="wol">__OPTS__</select></label><span id="rot"></span><button id="norm" class="active">Normalize: On</button><button id="lab" class="active">Labels: On</button><input id="find" placeholder="Search batch, lot, package, comment" size="32"><b id="count"></b></div><div class="k" id="kpis"></div><div id="chart"></div><script>
const DATA=__DATA__,C=__C__,L=__L__,S={rev:{},norm:true,labels:true,q:''};const $=x=>document.getElementById(x),wol=$('wol'),rot=$('rot'),norm=$('norm'),lab=$('lab'),find=$('find'),kpis=$('kpis'),count=$('count');count.textContent=Object.keys(DATA).length+' WOLs';const chart=echarts.init($('chart')),sum=(a,k)=>a.reduce((s,x)=>s+(+x[k]||0),0);function ints(a){let t=sum(a,'qty'),c=0;return a.map(x=>{let q=+x.qty||0,z={...x,start:S.norm?(t?c/t*100:0):c,end:S.norm?(t?(c+q)/t*100:0):(c+q)};c+=q;return z})}function buttons(){let bs=Object.keys(DATA[wol.value].boms);rot.innerHTML=bs.map(b=>`<button data-b="${b}" class="${S.rev[b]?'active':''}">\u2194 ${L[b]||b}</button>`).join(' ');rot.querySelectorAll('button').forEach(b=>b.onclick=()=>{S.rev[b.dataset.b]=!S.rev[b.dataset.b];buttons();draw()})}function draw(){let d=DATA[wol.value],bs=Object.keys(d.boms),hasPkg=d.packages.length>0,cats=bs.map(b=>(L[b]||b)+' raw').concat(hasPkg?['Packaged lots']:[]),items=[],maxQ=0;bs.forEach((b,y)=>{let a=[...d.boms[b]];if(S.rev[b])a.reverse();maxQ=Math.max(maxQ,sum(a,'qty'));ints(a).forEach(x=>items.push({...x,bom:b,kind:'raw',color:C[b]||'#64748b',value:[x.start,x.end,y]}))});if(hasPkg){maxQ=Math.max(maxQ,sum(d.packages,'qty'));ints(d.packages).forEach(x=>items.push({...x,kind:'pkg',color:'#f2994a',value:[x.start,x.end,bs.length]}))}let fg=sum(d.packages,'qty');kpis.innerHTML=`<div><b>WOL</b><br>${wol.value}</div><div><b>Package lots</b><br>${d.packages.length}</div><div><b>Finished qty</b><br>${fg.toFixed(1)}</div>`+bs.map(b=>`<div><b>${L[b]||b} raw</b><br>${sum(d.boms[b],'qty').toFixed(1)}</div>`).join('');let needle=S.q.toLowerCase();chart.setOption({animation:false,title:{text:'Work order '+wol.value+(hasPkg?'':' (no packaged lots found in LSN)'),left:18,top:10},toolbox:{right:18,feature:{dataZoom:{},restore:{},saveAsImage:{}}},grid:{left:130,right:35,top:60,bottom:80},xAxis:{type:'value',min:0,max:S.norm?100:(maxQ||1),axisLabel:{formatter:v=>S.norm?v+'%':Math.round(v)}},yAxis:{type:'category',data:cats,inverse:true},dataZoom:[{type:'inside',filterMode:'none'},{type:'slider',filterMode:'none',bottom:12,height:20}],tooltip:{formatter:p=>{let x=p.data;return x.kind==='pkg'?`<b>${x.name}</b><br>Qty: ${x.qty}<br>Comment: ${x.comment||'-'}`:`<b>${L[x.bom]||x.bom}</b><br>Batch: ${x.batch}<br>Lot: ${x.lot}<br>Qty: ${x.qty}<br>Raw item: ${x.item||'-'}<br>Issue step: ${x.step||'-'}<br>Supplier batch: ${x.sbatch||'-'}<br>Supplier piece: ${x.spiece||'-'}<br>Supplier PO: ${x.spo||'-'}`}},series:[{type:'custom',encode:{x:[0,1],y:2},renderItem:(p,a)=>{let x=items[p.dataIndex],p0=a.coord([a.value(0),a.value(2)]),p1=a.coord([a.value(1),a.value(2)]),h=Math.abs(a.size([0,1])[1])*.58,w=Math.max(1,p1[0]-p0[0]),hit=!needle||JSON.stringify(x).toLowerCase().includes(needle),ch=[{type:'rect',shape:{x:p0[0],y:p0[1]-h/2,width:w,height:h,r:4},style:{fill:x.color,stroke:'#fff',opacity:hit?1:.12}}];if(S.labels&&w>55)ch.push({type:'text',style:{x:p0[0]+w/2,y:p0[1],text:x.kind==='pkg'?x.name:x.lot,fill:'#fff',font:'11px Arial',align:'center',verticalAlign:'middle',opacity:hit?1:.12}});return {type:'group',children:ch}},data:items}]},true)}wol.onchange=()=>{S.rev={};buttons();draw()};norm.onclick=()=>{S.norm=!S.norm;norm.textContent='Normalize: '+(S.norm?'On':'Off');norm.classList.toggle('active',S.norm);draw()};lab.onclick=()=>{S.labels=!S.labels;lab.textContent='Labels: '+(S.labels?'On':'Off');lab.classList.toggle('active',S.labels);draw()};find.oninput=e=>{S.q=e.target.value;draw()};window.onresize=()=>chart.resize();buttons();draw();</script>'''.replace('__OPTS__', opts).replace('__DATA__', js).replace('__C__', json.dumps(COLORS)).replace('__L__', json.dumps(LABELS))
    Path(out).write_text(html, encoding="utf-8")


def main() -> None:
    print("=== FabLIMS lamination genealogy report ===", flush=True)
    print(f"Connection: {FABLIMS_CONNECTION}", flush=True)
    wol_filter = WOLS if WOLS else "(all - literal WOL in ('') )"
    print(f"WOL filter: {wol_filter}", flush=True)

    print("[1/6] Querying lot_genealogy ...", flush=True)
    genealogy_rows = _fetch(GENEALOGY_SQL, "genealogy")
    print("[2/6] Querying LSN ...", flush=True)
    lsn_rows = _fetch(LSN_SQL, "LSN")

    print("[3/6] Preparing data ...", flush=True)
    g, l = _prepare(genealogy_rows, lsn_rows)
    if g.empty or "WOL" not in g.columns:
        print("No genealogy rows returned — check the WOL filter (WOLS) or the query.", flush=True)
        return
    print(f"    -> genealogy {len(g):,} rows | LSN {len(l):,} rows after cleaning.", flush=True)

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
