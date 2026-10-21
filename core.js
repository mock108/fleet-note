(function(root){
'use strict';
const norm=s=>s.replace(/[\s\uFEFF]/g,'').replace(/：/g,':');
const fields={meter:'支払い額:売り上げ:料金:メーター',cancel:'支払い額:売り上げ:料金:キャンセルに対する違約金',fare:'支払い額:売り上げ:料金:料金',adjust:'支払い額:売り上げ:料金:調整',promo:'支払い額:売り上げ:プロモーション',quest:'支払い額:売り上げ:プロモーション:クエスト',tax:'支払い額:売り上げ:税金:料金に対する税',tips:'支払い額:売り上げ:チップ',fee:'支払い額:売り上げ:サービス料',toll:'支払い額:乗車の残高:返金:通行料',cash:'支払い額:乗車の残高:支払い:受け取った現金',payout:'支払い額'};
const categories=[['fare','基本料金','配達・乗車料金とメーター料金'],['cancel','キャンセル料','キャンセルに対する違約金'],['adjust','料金調整','料金の調整額'],['tax','料金に対する税','CSV記載の税額'],['quest','クエスト','プロモーションの内訳'],['promo','その他プロモーション','プロモーション合計からクエストを除く'],['tips','チップ','お客様からのチップ'],['fee','サービス料','CSVの符号のまま加算'],['toll','通行料の返金','立替金の返金として初期設定では除外'],['other','その他・未分類','支払い額と既知の内訳の差額']];
function parseCSV(text){
 text=text.replace(/^\uFEFF/,''); const rows=[]; let row=[],cell='',quoted=false,closed=false;
 for(let i=0;i<text.length;i++){let c=text[i]; if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;}
 else if(c==='"'){if(cell||closed)throw Error('引用符の位置が正しくありません。');quoted=true;}
 else if(c===','){row.push(cell);cell='';closed=false;}
 else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x!==''))rows.push(row);row=[];cell='';closed=false;}
 else{if(closed&&!/\s/.test(c))throw Error('引用符の後に不正な文字があります。');if(!closed)cell+=c;}}
 if(quoted)throw Error('閉じていない引用符があります。'); row.push(cell);if(row.some(x=>x!==''))rows.push(row);
 if(rows.length<2)throw Error('見出しと明細があるCSVを選んでください。');
 const headers=rows.shift().map(x=>x.trim()); if(new Set(headers.map(norm)).size!==headers.length)throw Error('列名が重複しています。');
 return {headers,records:rows.map((r,i)=>{if(r.length!==headers.length)throw Error(`${i+2}行目の列数が見出しと一致しません。`);return Object.fromEntries(headers.map((h,j)=>[h,r[j]]));})};
}
function amount(value){let s=String(value??'').trim().replace(/[￥¥,\s]/g,'').replace(/^\((.*)\)$/,'-$1');if(s==='')return 0;if(!/^[+-]?\d+(\.\d{1,2})?$/.test(s))throw Error(`数値を読めません: ${String(value).slice(0,35)}`);let n=Math.round(Number(s)*100);if(!Number.isSafeInteger(n))throw Error('金額が大きすぎます。');return n;}
function importData(text,filename){
 const {headers,records}=parseCSV(text),map=Object.fromEntries(headers.map(h=>[norm(h),h]));
 for(const name of ['取引ID','決済時間','支払い額',fields.cash])if(!map[name])throw Error(`必要な列「${name}」がありません。Uberのpayments_order CSVを選んでください。`);
 const missing=Object.entries(fields).filter(([k,v])=>!map[v]&&!['meter','cancel','adjust'].includes(k)).map(([k])=>k);
 const extra=headers.filter(h=>norm(h).startsWith('支払い額:')&&!Object.values(fields).includes(norm(h)));
 const entries=records.map((raw,i)=>{
  const get=n=>raw[map[n]]??'',id=get('取引ID').trim(),dt=get('決済時間');
  if(!id)throw Error(`${i+2}行目の取引IDが空です。`);
  const d=dt.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);if(!d)throw Error(`${i+2}行目の決済時間を読めません。`);
  const day=d[0].slice(0,10),date=new Date(day+'T00:00:00Z');if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==day||+d[4]>23||+d[5]>59||+d[6]>59)throw Error(`${i+2}行目の日付・時刻が不正です。`);
  let a=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,amount(get(v))]));
  a.fare+=a.meter;let quest=a.quest;a.promo=map[fields.promo]?a.promo-quest:extra.filter(h=>norm(h).startsWith(fields.promo+':')&&norm(h)!==fields.quest).reduce((s,h)=>s+amount(raw[h]),0);
  a.other=a.payout-a.cash-categories.filter(([k])=>k!=='other').reduce((s,[k])=>s+a[k],0);
  const ride=get('乗車ID'),note=get('備考');return {id,day,time:dt,ride,note,a,raw,filename};
 });
 return {headers,entries,missing,extra};
}
function summarize(entries){const a=Object.fromEntries([...categories.map(([k])=>k),'cash','payout'].map(k=>[k,0]));entries.forEach(e=>Object.keys(a).forEach(k=>a[k]+=e.a[k]));return {...a,earned:a.payout-a.cash-a.toll-a.fee,cashReceived:-a.cash,economic:a.payout-a.cash,rides:new Set(entries.filter(e=>e.ride&&/completed/i.test(e.note)).map(e=>e.ride)).size,transactions:entries.length};}
function merge(existing,incoming){const map=new Map(existing.map(e=>[e.id,e]));let duplicates=0;for(const e of incoming){if(map.has(e.id)){if(JSON.stringify(map.get(e.id).raw)!==JSON.stringify(e.raw))throw Error(`同じ取引IDに異なる内容があります: ${e.id}。既存データを消して取り込み直してください。`);duplicates++;}else map.set(e.id,e);}return {entries:[...map.values()],duplicates};}
function transfer(summary,selected,settlement,already=0,reserve=0){let target=categories.reduce((s,[k])=>s+(selected[k]?summary[k]:0),0);return {target,settlement:settlement?summary.payout:0,amount:target-(settlement?summary.payout:0)-already-reserve};}
function csv(rows){return '\uFEFF'+rows.map(r=>r.map(v=>{let s=String(v??'');if(typeof v==='string'&&/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}).join(',')).join('\r\n');}
const api={fields,categories,parseCSV,importData,summarize,merge,transfer,csv};if(typeof module!=='undefined')module.exports=api;else root.FleetCore=api;
})(typeof window!=='undefined'?window:globalThis);
