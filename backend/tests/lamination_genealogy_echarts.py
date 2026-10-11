from pathlib import Path
import argparse,json,webbrowser
import pandas as pd

COLORS={'WFACE':'#2f80ed','WFILM':'#9b51e0','WBACK':'#27ae60'}
LABELS={'WFACE':'Face','WFILM':'Film','WBACK':'Backer'}

def load(gf,lf):
 g=pd.read_excel(gf,engine='openpyxl');l=pd.read_excel(lf,engine='openpyxl')
 g.columns=[str(x).strip().upper() for x in g.columns];l.columns=[str(x).strip().upper() for x in l.columns]
 for c in ['WOL','BOM','GORE_BATCH','RAW_LOT']:g[c]=g[c].fillna('').astype(str).str.strip()
 for c in ['G_WOL','NAME','COMMENT']:l[c]=l[c].fillna('').astype(str).str.strip()
 g['RAW_QUANTITY']=pd.to_numeric(g['RAW_QUANTITY'],errors='coerce').fillna(0);l['G_LSN_QTY']=pd.to_numeric(l['G_LSN_QTY'],errors='coerce').fillna(0)
 g['_D']=pd.to_datetime(g['RAW_ISSUE_DATE'],errors='coerce') if 'RAW_ISSUE_DATE' in g else pd.NaT
 l['_D']=pd.to_datetime(l['G_MAN_DATE'],errors='coerce') if 'G_MAN_DATE' in l else pd.NaT
 l['_R']=pd.to_numeric(l['G_ROLL_INDEX'],errors='coerce') if 'G_ROLL_INDEX' in l else range(len(l))
 return g,l

def make_data(g,l):
 out={}
 # Include every WOL in genealogy. If no LSN match exists it still appears, with raw genealogy only.
 for w in sorted(x for x in g['WOL'].unique() if x):
  p=l[(l['G_WOL']==w)&(l['G_LSN_QTY']>0)&(l['NAME']!='')].sort_values(['_R','_D','NAME'],kind='stable')
  packages=[{'name':r['NAME'],'qty':float(r['G_LSN_QTY']),'comment':r['COMMENT'],'roll':None if pd.isna(r['_R']) else float(r['_R'])} for _,r in p.iterrows()]
  boms={}; order=['WFACE','WFILM','WBACK']+sorted(set(g.loc[g['WOL']==w,'BOM'])-{'WFACE','WFILM','WBACK'})
  for b in order:
   x=g[(g['WOL']==w)&(g['BOM']==b)&(g['RAW_QUANTITY']>0)].sort_values(['_D','GORE_BATCH','RAW_LOT'],kind='stable')
   if len(x):boms[b]=[{'batch':r['GORE_BATCH'],'lot':r['RAW_LOT'],'qty':float(r['RAW_QUANTITY'])} for _,r in x.iterrows()]
  if boms:out[w]={'packages':packages,'boms':boms}
 return out

def write_html(data,out):
 opts=''.join(f'<option value="{w}">{w}</option>' for w in data)
 js=json.dumps(data,separators=(',',':'))
 html='''<!doctype html><meta charset="utf-8"><title>Genealogy - All WOL</title><script src="https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js"></script><style>body{margin:0;background:#eef2f7;font:14px Arial;color:#1f2937}header{padding:15px 20px;background:#17365d;color:#fff}.bar{padding:10px 18px;background:#fff;display:flex;gap:9px;align-items:center;flex-wrap:wrap}.bar select,.bar input,.bar button{padding:8px;border:1px solid #cbd5e1;border-radius:7px;background:#fff}.active{background:#6d28d9!important;color:white}.k{display:flex;gap:10px;padding:12px 16px;flex-wrap:wrap}.k div{background:#fff;padding:9px 13px;border-radius:8px}#chart{height:620px;margin:0 16px;background:#fff;border-radius:10px}</style><header><h2 style="margin:0">Raw Usage → Finished Goods Genealogy</h2></header><div class="bar"><label>WOL <select id="wol">__OPTS__</select></label><span id="rot"></span><button id="norm" class="active">Normalize: On</button><button id="lab" class="active">Labels: On</button><input id="find" placeholder="Search batch, lot, package, comment" size="32"><b id="count"></b></div><div class="k" id="kpis"></div><div id="chart"></div><script>
const DATA=__DATA__,C=__C__,L=__L__,S={rev:{},norm:true,labels:true,q:''};const $=x=>document.getElementById(x),wol=$('wol'),rot=$('rot'),norm=$('norm'),lab=$('lab'),find=$('find'),kpis=$('kpis'),count=$('count');count.textContent=Object.keys(DATA).length+' WOLs';const chart=echarts.init($('chart')),sum=(a,k)=>a.reduce((s,x)=>s+(+x[k]||0),0);function ints(a){let t=sum(a,'qty'),c=0;return a.map(x=>{let q=+x.qty||0,z={...x,start:S.norm?(t?c/t*100:0):c,end:S.norm?(t?(c+q)/t*100:0):(c+q)};c+=q;return z})}function buttons(){let bs=Object.keys(DATA[wol.value].boms);rot.innerHTML=bs.map(b=>`<button data-b="${b}" class="${S.rev[b]?'active':''}">↔ ${L[b]||b}</button>`).join(' ');rot.querySelectorAll('button').forEach(b=>b.onclick=()=>{S.rev[b.dataset.b]=!S.rev[b.dataset.b];buttons();draw()})}function draw(){let d=DATA[wol.value],bs=Object.keys(d.boms),hasPkg=d.packages.length>0,cats=bs.map(b=>(L[b]||b)+' raw').concat(hasPkg?['Packaged lots']:[]),items=[],maxQ=0;bs.forEach((b,y)=>{let a=[...d.boms[b]];if(S.rev[b])a.reverse();maxQ=Math.max(maxQ,sum(a,'qty'));ints(a).forEach(x=>items.push({...x,bom:b,kind:'raw',color:C[b]||'#64748b',value:[x.start,x.end,y]}))});if(hasPkg){maxQ=Math.max(maxQ,sum(d.packages,'qty'));ints(d.packages).forEach(x=>items.push({...x,kind:'pkg',color:'#f2994a',value:[x.start,x.end,bs.length]}))}let fg=sum(d.packages,'qty');kpis.innerHTML=`<div><b>WOL</b><br>${wol.value}</div><div><b>Package lots</b><br>${d.packages.length}</div><div><b>Finished qty</b><br>${fg.toFixed(1)}</div>`+bs.map(b=>`<div><b>${L[b]||b} raw</b><br>${sum(d.boms[b],'qty').toFixed(1)}</div>`).join('');let needle=S.q.toLowerCase();chart.setOption({animation:false,title:{text:'Work order '+wol.value+(hasPkg?'':' (no packaged lots found in LSN)'),left:18,top:10},toolbox:{right:18,feature:{dataZoom:{},restore:{},saveAsImage:{}}},grid:{left:130,right:35,top:60,bottom:80},xAxis:{type:'value',min:0,max:S.norm?100:(maxQ||1),axisLabel:{formatter:v=>S.norm?v+'%':Math.round(v)}},yAxis:{type:'category',data:cats,inverse:true},dataZoom:[{type:'inside',filterMode:'none'},{type:'slider',filterMode:'none',bottom:12,height:20}],tooltip:{formatter:p=>{let x=p.data;return x.kind==='pkg'?`<b>${x.name}</b><br>Qty: ${x.qty}<br>Comment: ${x.comment||'-'}`:`<b>${L[x.bom]||x.bom}</b><br>Batch: ${x.batch}<br>Lot: ${x.lot}<br>Qty: ${x.qty}`}},series:[{type:'custom',encode:{x:[0,1],y:2},renderItem:(p,a)=>{let x=items[p.dataIndex],p0=a.coord([a.value(0),a.value(2)]),p1=a.coord([a.value(1),a.value(2)]),h=Math.abs(a.size([0,1])[1])*.58,w=Math.max(1,p1[0]-p0[0]),hit=!needle||JSON.stringify(x).toLowerCase().includes(needle),ch=[{type:'rect',shape:{x:p0[0],y:p0[1]-h/2,width:w,height:h,r:4},style:{fill:x.color,stroke:'#fff',opacity:hit?1:.12}}];if(S.labels&&w>55)ch.push({type:'text',style:{x:p0[0]+w/2,y:p0[1],text:x.kind==='pkg'?x.name:x.batch,fill:'#fff',font:'11px Arial',align:'center',verticalAlign:'middle',opacity:hit?1:.12}});return {type:'group',children:ch}},data:items}]},true)}wol.onchange=()=>{S.rev={};buttons();draw()};norm.onclick=()=>{S.norm=!S.norm;norm.textContent='Normalize: '+(S.norm?'On':'Off');norm.classList.toggle('active',S.norm);draw()};lab.onclick=()=>{S.labels=!S.labels;lab.textContent='Labels: '+(S.labels?'On':'Off');lab.classList.toggle('active',S.labels);draw()};find.oninput=e=>{S.q=e.target.value;draw()};window.onresize=()=>chart.resize();buttons();draw();</script>'''.replace('__OPTS__',opts).replace('__DATA__',js).replace('__C__',json.dumps(COLORS)).replace('__L__',json.dumps(LABELS))
 out.write_text(html,encoding='utf-8')

def main():
 p=argparse.ArgumentParser();p.add_argument('--genealogy',default='log_genealogy.xlsx');p.add_argument('--lsn',default='lsn.xlsx');p.add_argument('--output',default='lamination_genealogy_echarts_all_wol.html');p.add_argument('--no-open',action='store_true');a=p.parse_args();g,l=load(a.genealogy,a.lsn);d=make_data(g,l);out=Path(a.output).resolve();write_html(d,out);print('WOLs:',len(d));print(out);0 if a.no_open else webbrowser.open(out.as_uri())
if __name__=='__main__':main()
