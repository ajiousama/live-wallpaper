const DATA_URL="https://live-wallpaper-gamble-fast.onrender.com/data.json";
const DATA_FALLBACK="https://raw.githubusercontent.com/ajiousama/live-wallpaper/main/gamble/data.json";
const JRA_URL="https://raw.githubusercontent.com/ajiousama/live-wallpaper/main/jra/data.json";
const PHASES=["モーニング","デイ","ナイター","ミッドナイト"];
const PAYOUT_TYPES=["単勝","複勝","枠連","馬連","馬単","ワイド","3連複","3連単"];
const BOAT_PAYOUT_TYPES=["3連単","3連複","2連単","2連複","拡連複","単勝","複勝"];
const COMPANY_MODE=new URLSearchParams(location.search).get("company")==="1";
document.documentElement.classList.toggle("company-mode",COMPANY_MODE);
function jstWeekday(){
  const wd=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Tokyo",weekday:"short"}).format(new Date());
  return !["Sat","Sun"].includes(wd);
}
const COMPANY_WEEKDAY=COMPANY_MODE && jstWeekday();
document.documentElement.classList.toggle("company-weekday",COMPANY_WEEKDAY);
let data=null,jra=null,currentPageIndex=0,screenShownAt=performance.now(),rotateTimer=null;

function esc(v){
  return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function jstNow(){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value||"";
  return get("hour")+":"+get("minute");
}
function jstYmd(){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value||"";
  return get("year")+get("month")+get("day");
}
function jraIsCurrentDay(){
  const src=String(jra?.source_date||"").replace(/\D/g,"").slice(0,8);
  return !!src&&src===jstYmd();
}
function raceStartIfUpcoming(time,status,hasResult=false){
  const t=String(time||"");
  if(!t||hasResult) return "";
  const st=String(status||"");
  if(/確定|結果待ち|終了/.test(st)) return "";
  const m=t.match(/(\d{1,2}):(\d{2})/);
  if(m){
    const nowParts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
    const get=k=>Number(nowParts.find(p=>p.type===k)?.value||0);
    const nowMin=get("hour")*60+get("minute");
    const raceMin=Number(m[1])*60+Number(m[2]);
    if(nowMin>=raceMin) return "";
  }
  return t;
}
function raceDisplayStatus(time,status,hasResult=false){
  const st=String(status||"発走前");
  if(hasResult||/確定|終了/.test(st)) return st;
  const t=String(time||"");
  const m=t.match(/(\d{1,2}):(\d{2})/);
  if(m){
    const nowParts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
    const get=k=>Number(nowParts.find(p=>p.type===k)?.value||0);
    const nowMin=get("hour")*60+get("minute");
    const raceMin=Number(m[1])*60+Number(m[2]);
    if(nowMin>=raceMin) return "結果待ち";
  }
  return st;
}
function normalizePhase(v){
  const s=String(v||"");
  if(s.includes("オーバーミッド")||s.includes("ミッド")) return "ミッドナイト";
  if(s.includes("モーニング")) return "モーニング";
  if(s.includes("ナイター")) return "ナイター";
  return "デイ";
}
function numBox(n){return '<span class="num n'+Number(n)+'">'+esc(n)+'</span>'}
function orderHtml(order,kind){
  if(!Array.isArray(order)||order.length<3) return '<span class="muted">---</span>';
  if(kind==="local"){
    return '<span class="order horse-order">'+order.slice(0,3).map(n=>'<span class="horse-no">'+esc(n)+'</span>').join("")+'</span>';
  }
  return '<span class="order '+esc(kind||"")+'-order">'+order.slice(0,3).map(numBox).join("")+'</span>';
}
function raceNameMarquee(name){
  const t=name||"—";
  return '<div class="marquee-check" title="'+esc(t)+'"><div class="marquee-track"><span class="marquee-text">'+esc(t)+'</span><span class="marquee-copy" aria-hidden="true">'+esc(t)+'</span></div></div>';
}
function horseCourse(x){
  const raw=String(x?.course||"");
  let m=raw.match(/(芝|ダート|障害|直)[^0-9]{0,12}([0-9,]{3,5})\s*m?/);
  if(!m){
    const rev=raw.match(/([0-9,]{3,5})\s*(?:m|メートル).*?[（(](芝|ダート|障害|直)/);
    m=rev?[rev[0],rev[2],rev[1]]:null;
  }
  return m?(m[1]+m[2].replace(/,/g,"")+"m"):"取得中";
}
function phaseItems(phase){
  const out=[];
  for(const v of data?.keirin?.venues||[]){
    if(normalizePhase(v.type)===phase) out.push({sport:"競輪",kind:"keirin",venue:v});
  }
  for(const v of data?.boats||[]){
    if(normalizePhase(v.day_type)===phase) out.push({sport:"ボート",kind:"boat",venue:v});
  }
  for(const v of data?.local_all?.venues||[]){
    if(normalizePhase(v.day_type)===phase) out.push({sport:"地方",kind:"local",venue:v});
  }
  const sportOrder={keirin:0,boat:1,local:2};
  out.sort((a,b)=>(sportOrder[a.kind]-sportOrder[b.kind])||String(a.venue.name||a.venue.venue||"").localeCompare(String(b.venue.name||b.venue.venue||""),"ja"));
  return out;
}
function phaseCardHead(item){
  const v=item.venue;
  const name=v.display_name||v.name||v.venue||"---";
  let extra="";
  if(item.kind==="keirin") extra=[v.grade].filter(Boolean).join(" ");
  if(item.kind==="boat") extra=v.event_name||"";
  return '<div class="card-head"><span class="sport-tag '+item.kind+'">'+item.sport+'</span><strong>'+esc(name)+'</strong><small>'+esc(extra)+'</small></div>';
}
function keirinRows(v){
  const races=v.races||[];
  let rows="";
  for(const x of races){
    const raw=x.race_name||"—";
    const cm=raw.match(/^[ＡAＳSＬL]級/);
    const cls=cm?cm[0].replace("A","Ａ").replace("S","Ｓ").replace("L","Ｌ"):"";
    const name=cm?raw.slice(cm[0].length).trim():raw;
    rows+='<tr>'+
      '<td class="r">'+esc(x.race)+'R</td>'+
      '<td class="class-col">'+esc(cls||"—")+'</td>'+
      '<td class="name">'+raceNameMarquee(name)+'</td>'+
      '<td class="winner-stack"><strong>'+esc(x.winner||"---")+'</strong><small>'+esc(x.origin||"")+'</small></td>'+
      '<td class="combo">'+orderHtml(x.order,"keirin")+'</td>'+
      '<td class="pay">'+esc(x.payout||x.status||"発走前")+'</td>'+
    '</tr>';
  }
  return '<table class="phase-table keirin-table"><thead><tr><th>R</th><th>級</th><th>レース</th><th>勝者/出身</th><th>3連単</th><th>払戻</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function keirinPayoutText(x,label){
  const arr=x?.payouts?.[label];
  if(!Array.isArray(arr)||!arr.length) return "---";
  return arr.map(y=>[y.combo,y.amount].filter(Boolean).join(" ")).join(" / ");
}
function keirinDetailCard(v){
  const races=v.races||[];
  const payoutCols=["枠複","枠単","2車複","2車単","ワイド","3連複","3連単"];
  let rows="";
  for(const x of races){
    const raw=x.race_name||"—";
    const cm=raw.match(/^[ＡAＳSＬL]級/);
    const cls=cm?cm[0].replace("A","Ａ").replace("S","Ｓ").replace("L","Ｌ"):"";
    const name=cm?raw.slice(cm[0].length).trim():raw;
    const isFinal=/決勝/.test(raw);
    const payoutCells=payoutCols.map(label=>{
      const value=keirinPayoutText(x,label);
      return '<td class="bet-cell bet-'+label.replace(/[0-9]/g,"")+'"><b>'+esc(label)+'</b><span>'+esc(value)+'</span></td>';
    }).join("");
    const startTime=raceStartIfUpcoming(x.scheduled_time||x.time,x.status,!!(x.winner||x.payout));
    rows+='<tr class="'+(isFinal?"final-row":"")+'">'+
      '<td class="r"><strong>'+esc(x.race)+'R</strong>'+(startTime?'<small>'+esc(startTime)+'</small>':'')+'</td>'+
      '<td class="class-col">'+esc(cls||"—")+'</td>'+
      '<td class="name">'+raceNameMarquee(name)+'</td>'+
      '<td class="winner-stack"><strong>'+esc(x.winner||"---")+'</strong><small>'+esc(x.origin||"")+'</small></td>'+
      payoutCells+
    '</tr>';
  }
  const venue=v.display_name||v.venue||v.name||"---";
  const event=v.event_name||v.event_name_epg||"";
  const grade=v.grade||"";
  return '<article class="keirin-detail-card">'+
    '<div class="keirin-detail-head"><span class="sport-tag keirin">競輪</span><strong>'+esc(venue)+'</strong><b>'+esc(grade)+'</b><em>'+esc(event)+'</em></div>'+
    '<div class="keirin-detail-table-wrap">'+
      '<table class="keirin-detail-table"><thead><tr><th>R</th><th>級</th><th>レース</th><th>勝者/出身</th><th>枠複</th><th>枠単</th><th>2車複</th><th>2車単</th><th>ワイド</th><th>3連複</th><th>3連単</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '</div>'+
  '</article>';
}
function boatRows(v){
  const map=new Map((v.races||[]).map(x=>[Number(x.race),x]));
  let rows="";
  for(let r=1;r<=12;r++){
    const x=map.get(r)||{race:r,status:"発走前",order:[],payout:""};
    rows+='<tr>'+
      '<td class="r">'+r+'R</td>'+
      '<td class="name">'+raceNameMarquee(x.race_name||"—")+'</td>'+
      '<td class="combo">'+orderHtml(x.order,"boat")+'</td>'+
      '<td class="pay">'+esc(x.payout||x.status||"発走前")+'</td>'+
    '</tr>';
  }
  return '<table class="phase-table boat-table"><thead><tr><th>R</th><th>レース</th><th>3連単</th><th>払戻</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function boatBoardCell(x){
  const decided=Array.isArray(x?.order)&&x.order.length>=3&&x?.payout;
  if(!decided){
    const status=String(x?.status||"発走前");
    const time=raceStartIfUpcoming(x?.scheduled_time,status,false);
    return '<div class="boat-pay-pending">'+(time?'<b>'+esc(time)+'</b>':'')+'<span>'+esc(status)+'</span></div>';
  }
  return '<div class="boat-pay-cell">'+
    '<div class="boat-pay-combo">'+orderHtml(x.order,"boat")+'</div>'+
    '<strong>'+esc(x.payout)+'</strong>'+
    '<em>'+esc(x.popularity?x.popularity+"人気":"—")+'</em>'+
  '</div>';
}
function boatPayBoard(items){
  const venues=items.map(x=>x.venue);
  const maps=venues.map(v=>new Map((v.races||[]).map(r=>[Number(r.race),r])));
  const head=venues.map(v=>
    '<th class="boat-pay-venue" colspan="3"><strong>'+esc(v.name||"---")+'</strong><small>'+esc(v.event_name||"")+'</small></th>'
  ).join("");
  const sub=venues.map(()=>'<th>組番</th><th>3連単</th><th>人気</th>').join("");
  let body="";
  for(let r=1;r<=12;r++){
    const cells=maps.map(m=>{
      const x=m.get(r)||{race:r,status:"発走前",order:[],payout:"",scheduled_time:""};
      if(!(Array.isArray(x.order)&&x.order.length>=3&&x.payout)){
        const status=String(x.status||"発走前");
        const time=raceStartIfUpcoming(x.scheduled_time,status,false);
        return '<td class="boat-pay-pending-cell" colspan="3"><div class="boat-pay-pending">'+(time?'<b>'+esc(time)+'</b>':'')+'<span>'+esc(status)+'</span></div></td>';
      }
      return '<td class="boat-pay-combo-cell">'+orderHtml(x.order,"boat")+'</td>'+
        '<td class="boat-pay-amount">'+esc(x.payout)+'</td>'+
        '<td class="boat-pay-pop">'+esc(x.popularity||"—")+'</td>';
    }).join("");
    body+='<tr><th class="boat-pay-race">'+r+'R</th>'+cells+'</tr>';
  }
  return '<div class="boat-pay-board-wrap"><table class="boat-pay-board">'+
    '<thead><tr><th class="boat-pay-corner" rowspan="2">R</th>'+head+'</tr><tr>'+sub+'</tr></thead>'+
    '<tbody>'+body+'</tbody></table></div>';
}
function isBoatSg(v){
  if(String(v?.grade||"").toUpperCase()==="SG") return true;
  const name=String(v?.event_name||"").normalize("NFKC");
  return /(^|[^A-Z])SG([^A-Z]|$)/i.test(name)
    ||/(ボートレースクラシック|ボートレースオールスター|グランドチャンピオン|オーシャンカップ|ボートレースメモリアル|ボートレースダービー|チャレンジカップ|グランプリ|グランプリシリーズ)/.test(name);
}
function boatPayoutHtml(x,label){
  const arr=x?.payouts?.[label];
  if(!Array.isArray(arr)||!arr.length) return '<span class="muted">---</span>';
  return arr.map(y=>'<span>'+esc([y.combo,y.amount].filter(Boolean).join(" "))+'</span>').join("");
}
function boatDetailCard(v){
  const map=new Map((v.races||[]).map(x=>[Number(x.race),x]));
  let rows="";
  for(let r=1;r<=12;r++){
    const x=map.get(r)||{race:r,status:"発走前",order:[],payout:"",payouts:{}};
    const isFinal=String(x.race_name||"").includes("優勝戦")&&!String(x.race_name||"").includes("準優勝");
    const payoutCells=BOAT_PAYOUT_TYPES.map(label=>
      '<td class="bet-cell bet-'+label.replace(/[0-9]/g,"")+'">'+boatPayoutHtml(x,label)+'</td>'
    ).join("");
    const startTime=raceStartIfUpcoming(x.scheduled_time,x.status,!!(x.payout||(x.order||[]).length));
    rows+='<tr class="'+(isFinal?"final-row":"")+'">'+
      '<td class="r"><strong>'+r+'R</strong>'+(startTime?'<small>'+esc(startTime)+'</small>':'')+'</td>'+
      '<td class="name">'+raceNameMarquee(x.race_name||"—")+'</td>'+
      payoutCells+
      '<td class="winner">'+esc(x.winner||"")+'</td>'+
    '</tr>';
  }
  return '<article class="boat-detail-card">'+
    '<div class="boat-detail-head"><span class="sport-tag boat">ボート</span><strong>'+esc(v.name||"---")+'</strong><b>SG</b><em>'+esc(v.event_name||"")+'</em></div>'+
    '<div class="boat-detail-table-wrap">'+
      '<table class="boat-detail-table"><thead><tr><th>R</th><th>レース</th><th>3連単</th><th>3連複</th><th>2連単</th><th>2連複</th><th>拡連複</th><th>単勝</th><th>複勝</th><th>優勝者</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '</div>'+
  '</article>';
}
function localRows(v){
  const races=v.races||[];
  let rows="";
  for(const x of races){
    rows+='<tr>'+
      '<td class="r">'+esc(x.race)+'R</td>'+
      '<td class="local-info"><div>'+raceNameMarquee(x.race_name||"—")+'</div><b>'+esc(horseCourse(x))+'</b></td>'+
      '<td class="winner-stack local-winner-stack"><strong>'+esc(x.winner||x.status||"発走前")+'</strong><small>'+esc(x.jockey||"")+'</small></td>'+
      '<td class="combo">'+orderHtml(x.order,"local")+'</td>'+
      '<td class="pay">'+esc(x.trifecta||"")+'</td>'+
    '</tr>';
  }
  return '<table class="phase-table local-table"><thead><tr><th>R</th><th>レース/馬場距離</th><th>勝ち馬/騎手</th><th>3連単</th><th>払戻</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function phaseCard(item){
  const body=item.kind==="keirin"?keirinRows(item.venue):item.kind==="boat"?boatRows(item.venue):localRows(item.venue);
  return '<article class="phase-card '+item.kind+'-card">'+phaseCardHead(item)+'<div class="card-table-wrap">'+body+'</div></article>';
}
function jraRaceResult(venueName,raceNo){
  if(!jraIsCurrentDay()) return {};
  const venue=(jra?.venues||[]).find(v=>v.name===venueName);
  return (venue?.results||[]).find(r=>Number(r.race)===Number(raceNo))||{};
}
function specialItems(){
  const out=[];

  // 競輪: GIII以上は決勝だけ。勝者を主役にする。
  for(const v of data?.keirin?.venues||[]){
    const grade=String(v.grade||"").toUpperCase();
    if(!/^(G1|G2|G3|GP)$/.test(grade)) continue;
    const final=(v.races||[]).find(r=>/決勝/.test(String(r.race_name||"")));
    if(!final) continue;
    out.push({
      kind:"keirin",source:"競輪 "+grade,venue:v.venue||v.name||"",race:(final.race||"")+"R",
      name:v.event_name||((v.venue||"")+" "+grade+"決勝"),time:final.scheduled_time||final.time||"",
      winner:final.winner||"",sub:final.origin?("出身 "+final.origin):"",
      order:final.order||[],payout:final.payout||"",status:final.status||"発走前"
    });
  }

  // ボート: 「準優勝戦」は除外し、優勝戦だけ。
  for(const v of data?.boats||[]){
    for(const r of v.races||[]){
      const rn=String(r.race_name||"");
      if(!rn.includes("優勝戦")||rn.includes("準優勝")) continue;
      out.push({
        kind:"boat",source:"ボート",venue:v.name||"",race:(r.race||"")+"R",
        name:rn,time:r.scheduled_time||"",winner:r.winner||"",
        sub:r.winner?"優勝レーサー":"",order:r.order||[],payout:r.payout||"",status:r.status||"発走前"
      });
    }
  }

  // 地方: GCH地方競馬中継で拾った当日の看板重賞。
  for(const x of data?.featured_races||[]){
    if(!String(x.source||"").includes("GCH地方")) continue;
    const raceNo=Number(String(x.race||"").replace(/\D/g,""));
    const venue=(data?.local_all?.venues||[]).find(v=>v.name===x.venue);
    const result=(venue?.races||[]).find(r=>Number(r.race)===raceNo)||{};
    out.push({
      kind:"local",source:"地方重賞",venue:x.venue||"",race:x.race||"",
      name:x.name||result.race_name||"",time:result.scheduled_time||x.time||"",
      winner:result.winner||"",sub:result.jockey?("騎手 "+result.jockey):"",
      order:result.order||[],payout:result.trifecta||"",status:result.status||"発走前"
    });
  }

  // JRA特別: 一覧そのものは gamble/data.json の当日 featured_races を正とする。
  // JRA通常データは、同じ日なら勝ち馬・騎手・払戻を上書きするだけ。
  for(const x of data?.featured_races||[]){
    if(x.source!=="JRA") continue;
    const raceNo=Number(String(x.race||"11R").replace(/\D/g,""))||11;
    const r=jraRaceResult(x.venue,raceNo);
    const first=Array.isArray(r.top3)?(r.top3.find(y=>Number(y.position)===1)||{}):{};
    const tri=Array.isArray(r?.payouts?.["3連単"])?r.payouts["3連単"][0]:null;
    out.push({
      kind:"jra",source:"JRA",venue:x.venue||"",race:x.race||raceNo+"R",
      name:x.name||r.race_name||"",time:x.time||r.time||"",
      winner:first.horse||"",sub:first.jockey?("騎手 "+first.jockey):"",
      order:tri?.combo?String(tri.combo).split(/[-－]/).map(Number):[],
      payout:tri?.amount||"",status:first.horse?"確定":"発走前",
      horses:x.horses||[]
    });
  }

  // 海外発売対象の大レース。
  // JRAの日本時間の発売日が当日と一致するものだけ表示する。
  for(const x of data?.featured_races||[]){
    if(x.source!=="海外競馬") continue;
    if(String(x.sale_date||"")!==String(data?.date||"")) continue;
    out.push({
      kind:"overseas",source:"海外G1",venue:x.venue||"海外",race:x.race||"",
      name:x.name||"",time:x.time||"",winner:x.winner||"",
      sub:x.jockey?("騎手 "+x.jockey):"",order:x.order||[],payout:x.payout||"",
      status:x.winner?"確定":"発走前",horses:x.horses||[]
    });
  }

  // WIN5: JRA当日データが有効な日にだけ結果を結合。
  const targets=jraIsCurrentDay()?(data?.win5?.targets||[]):[];
  if(targets.length){
    const legs=targets.map((t,i)=>{
      const r=jraRaceResult(t.venue,t.race);
      const first=Array.isArray(r.top3)?(r.top3.find(x=>Number(x.position)===1)||{}):{};
      return {
        no:i+1,venue:t.venue,race:t.race,race_name:r.race_name||"",
        horse:first.horse||"",horse_no:first.number||"",jockey:first.jockey||""
      };
    });
    out.push({
      kind:"win5",source:"WIN5",name:"WIN5 結果",legs,
      payout:data?.win5?.payout||"",payout_kind:data?.win5?.payout_kind||""
    });
  }
  return out;
}
function mainRaceItems(){
  const out=[];

  // 競輪: 「準決勝」は除外し、その日の本当の決勝だけ。
  for(const v of data?.keirin?.venues||[]){
    for(const r of v.races||[]){
      const rn=String(r.race_name||"");
      if(!rn.includes("決勝") || rn.includes("準決勝")) continue;
      out.push({
        kind:"keirin",
        source:"競輪 決勝",
        venue:v.venue||v.name||"",
        race:(r.race||"")+"R",
        name:rn,
        time:r.scheduled_time||r.time||"",
        winner:r.winner||"",
        sub:r.origin?("出身 "+r.origin):"",
        order:r.order||[],
        payout:r.payout||"",
        status:r.status||"発走前"
      });
    }
  }

  // ボート: 優勝戦だけ。準優勝戦は入れない。
  for(const v of data?.boats||[]){
    for(const r of v.races||[]){
      const rn=String(r.race_name||"");
      if(!rn.includes("優勝戦") || rn.includes("準優勝")) continue;
      out.push({
        kind:"boat",
        source:"ボート 優勝戦",
        venue:v.name||"",
        race:(r.race||"")+"R",
        name:[v.event_name,rn].filter(Boolean).join(" / "),
        time:r.scheduled_time||r.time||"",
        winner:r.winner||"",
        sub:r.winner?"優勝レーサー":"",
        order:r.order||[],
        payout:r.payout||"",
        status:r.status||"発走前"
      });
    }
  }

  // 地方競馬: 各場1レース。重賞を最優先し、なければ終盤の特別・賞、
  // それもなければ最終レースを「本日のメイン」とする。
  for(const v of data?.local_all?.venues||[]){
    const races=(v.races||[]).slice();
    if(!races.length) continue;
    const graded=races.filter(r=>/重賞|Jpn[123IⅤⅢⅡⅠ]+/i.test(String(r.race_name||"")));
    const lateFeature=races
      .filter(r=>Number(r.race)>=10 && /特別|賞|記念|杯|ドリーム|選抜/.test(String(r.race_name||"")))
      .sort((x,y)=>Number(y.race)-Number(x.race));
    const last=races.slice().sort((x,y)=>Number(y.race)-Number(x.race))[0];
    const r=graded.slice().sort((x,y)=>Number(y.race)-Number(x.race))[0] || lateFeature[0] || last;
    if(!r) continue;
    out.push({
      kind:"local",
      source:/重賞|Jpn/i.test(String(r.race_name||""))?"地方 重賞":"地方 メイン",
      venue:v.name||"",
      race:(r.race||"")+"R",
      name:String(r.race_name||"").replace(/^\s*(重賞|特別)\s*/,""),
      time:r.scheduled_time||r.time||"",
      winner:r.winner||"",
      sub:r.jockey?("騎手 "+r.jockey):"",
      order:r.order||[],
      payout:r.trifecta||r.payout||"",
      status:r.status||"発走前"
    });
  }

  // JRA開催日は featured_races の当日メインを追加。
  if(jraIsCurrentDay()){
    for(const x of data?.featured_races||[]){
      if(x.source!=="JRA") continue;
      const raceNo=Number(String(x.race||"11R").replace(/\D/g,""))||11;
      const r=jraRaceResult(x.venue,raceNo);
      const first=Array.isArray(r.top3)?(r.top3.find(y=>Number(y.position)===1)||{}):{};
      const tri=Array.isArray(r?.payouts?.["3連単"])?r.payouts["3連単"][0]:null;
      out.push({
        kind:"jra",
        source:"JRA メイン",
        venue:x.venue||"",
        race:x.race||raceNo+"R",
        name:x.name||r.race_name||"",
        time:x.time||r.time||"",
        winner:first.horse||"",
        sub:first.jockey?("騎手 "+first.jockey):"",
        order:tri?.combo?String(tri.combo).split(/[-－]/).map(Number):[],
        payout:tri?.amount||"",
        status:first.horse?"確定":"発走前",
        horses:x.horses||[]
      });
    }
  }

  const kindOrder={keirin:0,boat:1,local:2,jra:3};
  return out.sort((x,y)=>
    (kindOrder[x.kind]??9)-(kindOrder[y.kind]??9) ||
    String(x.venue||"").localeCompare(String(y.venue||""),"ja") ||
    Number(String(x.race||"").replace(/\D/g,""))-Number(String(y.race||"").replace(/\D/g,""))
  );
}

function buildPages(){
  const pages=[];
  for(const phase of PHASES){
    const phaseAll=phaseItems(phase).filter(x=>{
      if(!COMPANY_MODE) return true;
      if(COMPANY_WEEKDAY) return x.kind==="keirin";
      return x.kind==="keirin" || x.kind==="local";
    });

    const premiumKeirin=phaseAll.filter(x=>
      x.kind==="keirin" && /^(G1|G2|G3|GP)$/i.test(String(x.venue?.grade||""))
    );
    const premiumBoat=COMPANY_MODE ? [] : phaseAll.filter(x=>x.kind==="boat"&&isBoatSg(x.venue));

    // 競輪G3以上は1場ずつ全掛式の詳細ページ。
    for(const item of premiumKeirin){
      const v=item.venue||{};
      pages.push({
        key:"phase:"+phase+":keirin-premium:"+(v.venue||v.name||v.code||""),
        type:"phase",
        phase,
        sportKind:"keirin-detail",
        sportLabel:"競輪 "+String(v.grade||"").toUpperCase(),
        page:1,
        total:1,
        items:[item]
      });
    }

    // ボートSGも1場ずつ専用詳細ページ。
    for(const item of premiumBoat){
      const v=item.venue||{};
      pages.push({
        key:"phase:"+phase+":boat-sg:"+(v.name||v.code||""),
        type:"phase",
        phase,
        sportKind:"boat-detail",
        sportLabel:"ボート SG",
        page:1,
        total:1,
        items:[item]
      });
    }

    // それ以外。
    let rest=phaseAll.filter(x=>!premiumKeirin.includes(x)&&!premiumBoat.includes(x));

    // 会社PCは時間帯ごとに競輪 / 地方競馬を完全分離。
    // 例: モーニング・競輪 → モーニング・地方競馬 → デイ・競輪...
    if(COMPANY_MODE){
      const companyGroups=COMPANY_WEEKDAY
        ? [{kind:"keirin",label:"競輪"}]
        : [
            {kind:"keirin",label:"競輪"},
            {kind:"local",label:"地方競馬"}
          ];
      for(const group of companyGroups){
        const items=rest.filter(x=>x.kind===group.kind);
        for(let i=0;i<items.length;i+=4){
          const chunk=items.slice(i,i+4);
          pages.push({
            key:"phase:"+phase+":"+group.kind+":"+Math.floor(i/6),
            type:"phase",
            phase,
            sportKind:group.kind,
            sportLabel:group.label,
            page:Math.floor(i/4)+1,
            total:Math.ceil(items.length/4),
            items:chunk
          });
        }
      }
      continue;
    }

    // Free WiFi側は従来どおり。デイの通常ボートが7場以上なら3x3で集約。
    if(phase==="デイ"){
      const dayBoats=rest.filter(x=>x.kind==="boat");
      if(dayBoats.length>=7){
        for(let i=0;i<dayBoats.length;i+=9){
          const chunk=dayBoats.slice(i,i+9);
          pages.push({
            key:"phase:デイ:boat-dense:"+Math.floor(i/9),
            type:"phase",
            phase:"デイ",
            sportKind:"boat-dense",
            sportLabel:"ボート",
            page:Math.floor(i/9)+1,
            total:Math.ceil(dayBoats.length/9),
            items:chunk
          });
        }
        rest=rest.filter(x=>x.kind!=="boat");
      }
    }

    // Free WiFi側の残りは競輪→ボート→地方競馬の順で最大6場。
    for(let i=0;i<rest.length;i+=6){
      const chunk=rest.slice(i,i+6);
      pages.push({
        key:"phase:"+phase+":mixed:"+Math.floor(i/6),
        type:"phase",
        phase,
        sportKind:"mixed",
        sportLabel:"",
        page:Math.floor(i/6)+1,
        total:Math.ceil(rest.length/6),
        items:chunk
      });
    }
  }

  const mainRaces=mainRaceItems().filter(x=>{
    if(!COMPANY_MODE) return true;
    if(COMPANY_WEEKDAY) return x.kind==="keirin" || x.kind==="local";
    return x.kind==="keirin" || x.kind==="boat" || x.kind==="local" || x.kind==="jra";
  });
  if(mainRaces.length){
    pages.push({
      key:"main-races:summary",
      type:"main-races",
      page:1,
      total:1,
      items:mainRaces
    });
  }

  const specials=specialItems().filter(x=>{
    if(!COMPANY_MODE) return true;
    if(COMPANY_WEEKDAY) return x.kind==="keirin";
    return x.kind==="keirin" || x.kind==="local" || x.kind==="jra" || x.kind==="win5";
  });
  if(specials.length){
    if(COMPANY_MODE){
      for(let i=0;i<specials.length;i+=4){
        pages.push({
          key:"special:company:"+Math.floor(i/4),
          type:"special",
          page:Math.floor(i/4)+1,
          total:Math.ceil(specials.length/4),
          items:specials.slice(i,i+4)
        });
      }
    }else{
      pages.push({
        key:"special:all",
        type:"special",
        page:1,
        total:1,
        items:specials
      });
    }
  }

  if(!COMPANY_WEEKDAY){
    const jraVenues=jraIsCurrentDay()?(jra?.venues||[]):[];
    for(let i=0;i<jraVenues.length;i+=2){
      pages.push({
        key:"jra:"+Math.floor(i/2),
        type:"jra",
        page:Math.floor(i/2)+1,
        total:Math.ceil(jraVenues.length/2),
        venues:jraVenues.slice(i,i+2)
      });
    }
  }
  return pages.length?pages:[{key:"phase:デイ:0",type:"phase",phase:"デイ",page:1,total:1,items:[]}];
}
function renderPhasePage(page){
  const items=page.items||[];
  const host=document.getElementById("phase-grid");
  const singleKeirinDetail=page.sportKind==="keirin-detail"&&items.length===1;
  const singleBoatDetail=page.sportKind==="boat-detail"&&items.length===1;
  const denseBoat=page.sportKind==="boat-dense";
  host.className="phase-grid count-"+Math.max(1,items.length)
    +(singleKeirinDetail?" single-keirin-detail":"")
    +(singleBoatDetail?" single-boat-detail":"")
    +(denseBoat?" boat-dense":"");
  if(singleKeirinDetail){
    host.innerHTML=keirinDetailCard(items[0].venue);
  }else if(singleBoatDetail){
    host.innerHTML=boatDetailCard(items[0].venue);
  }else if(denseBoat){
    host.innerHTML=boatPayBoard(items);
  }else{
    host.innerHTML=items.length?items.map(phaseCard).join(""):'<div class="empty-card">'+esc(page.phase+" "+(page.sportLabel||""))+'開催なし</div>';
  }
  document.getElementById("screen-title").textContent=page.sportLabel?(page.phase+"・"+page.sportLabel):page.phase;
  const pageText=page.total>1?(" "+page.page+"/"+page.total):"";
  if(singleKeirinDetail){
    const v=items[0].venue;
    document.getElementById("screen-sub").textContent=[v.venue||v.name,v.grade,v.event_name||v.event_name_epg].filter(Boolean).join(" / ");
  }else if(singleBoatDetail){
    const v=items[0].venue;
    document.getElementById("screen-sub").textContent=[v.name,"SG",v.event_name].filter(Boolean).join(" / ");
  }else if(denseBoat){
    document.getElementById("screen-sub").textContent="ボート "+items.length+"場 / 12R一覧"+pageText;
  }else if(page.sportKind==="mixed"){
    const kc=items.filter(x=>x.kind==="keirin").length;
    const bc=items.filter(x=>x.kind==="boat").length;
    const lc=items.filter(x=>x.kind==="local").length;
    const parts=[];
    if(kc) parts.push("競輪 "+kc+"場");
    if(bc) parts.push("ボート "+bc+"場");
    if(lc) parts.push("地方 "+lc+"場");
    document.getElementById("screen-sub").textContent=(parts.join(" / ")||"開催なし")+pageText;
  }else{
    document.getElementById("screen-sub").textContent=(items.length?(items.length+"場"):"開催なし")+pageText;
  }
  updateMarquees();
}
function payoutItems(r,label){
  const arr=r?.payouts?.[label];
  if(!Array.isArray(arr)||!arr.length) return "---";
  return arr.map(x=>[x.combo,x.amount].filter(Boolean).join(" ")).join(" / ");
}
function jraRaceBlock(r,no){
  const top=Array.isArray(r?.top3)?r.top3:[];
  const places=[1,2,3].map(pos=>{
    const x=top.find(y=>Number(y.position)===pos)||{};
    const horse=x.horse||"---";
    const jockey=x.jockey||"";
    const num=x.number?x.number+" ":"";
    return '<span class="place p'+pos+'"><b>'+pos+'着</b><span class="place-horse">'+esc(num+horse)+'</span><em>'+esc(jockey)+'</em></span>';
  }).join("");
  const payoutClass={
    "単勝":"bet-tansho","複勝":"bet-fukusho","枠連":"bet-wakuren","馬連":"bet-umaren",
    "馬単":"bet-umatan","ワイド":"bet-wide","3連複":"bet-sanrenpuku","3連単":"bet-sanrentan"
  };
  const payouts=PAYOUT_TYPES.map(label=>
    '<div class="payout-item '+(payoutClass[label]||"")+'"><b>'+label+'</b><span>'+esc(payoutItems(r,label))+'</span></div>'
  ).join("");
  const name=r?.race_name||"レース情報取得中";
  const course=horseCourse(r);
  return '<div class="jra-race">'+
    '<div class="jra-race-main"><strong>'+no+'R</strong><span class="jra-race-name">'+raceNameMarquee(name)+'</span><em>'+esc(course)+'</em></div>'+
    '<div class="places">'+places+'</div>'+
    '<div class="payout-grid">'+payouts+'</div>'+
  '</div>';
}
function jraVenueCard(v){
  const map=new Map((v.results||[]).map(x=>[Number(x.race),x]));
  let races="";
  for(let no=1;no<=12;no++) races+=jraRaceBlock(map.get(no)||{},no);
  return '<article class="jra-venue-card"><div class="jra-venue-head"><strong>'+esc(v.name||"---")+'</strong><span>1〜3着＋騎手 / 全掛式払戻</span></div><div class="jra-venue-scroll sync-vscroll">'+races+'</div></article>';
}
function specialRaceCard(x){
  const where=[x.venue,x.race].filter(Boolean).join(" ");
  const winnerLabel=(x.kind==="jra"||x.kind==="local"||x.kind==="overseas")?"勝ち馬":"優勝";
  const hasWinner=!!x.winner;
  const hasResult=hasWinner||!!x.payout;
  const displayStatus=raceDisplayStatus(x.time,x.status,hasResult);
  const upcomingTime=raceStartIfUpcoming(x.time,displayStatus,hasResult);
  const result=hasWinner
    ?'<div class="special-winner"><span>'+winnerLabel+'</span><strong>'+esc(x.winner)+'</strong><em>'+esc(x.sub||"")+'</em></div>'
    :'<div class="special-winner waiting"><span>結果</span><strong>'+esc(displayStatus)+'</strong><em>'+esc(upcomingTime?upcomingTime+" 発走予定":"")+'</em></div>';
  const combo=(Array.isArray(x.order)&&x.order.length>=3)?orderHtml(x.order,(x.kind==="local"||x.kind==="jra"||x.kind==="overseas")?"local":(x.kind==="boat"?"boat":"keirin")):'<span class="muted">---</span>';
  const meta=(x.kind==="overseas"&&!hasWinner&&Array.isArray(x.horses)&&x.horses.length)
    ?'<div class="special-detail"><b>注目馬</b><span>'+esc(x.horses.join("・"))+'</span></div>'
    :'<div class="special-detail"><b>3連単</b><span>'+combo+'</span><b>払戻</b><strong>'+esc(x.payout||"---")+'</strong></div>';
  return '<article class="special-card '+esc(x.kind||"")+'-special">'+
    '<div class="special-head"><span>'+esc(x.source||"特別")+'</span><strong>'+esc(where||"特別競走")+'</strong><time>'+esc(upcomingTime?upcomingTime+" 発走":"")+'</time></div>'+
    '<div class="special-name">'+esc(x.name||"---")+'</div>'+
    result+meta+
  '</article>';
}
function win5Card(x){
  const rows=(x.legs||[]).map(leg=>{
    const winner=leg.horse?((leg.horse_no?leg.horse_no+" ":"")+leg.horse):"結果待ち";
    return '<div class="win5-leg"><b>WIN'+leg.no+'</b><span>'+esc(leg.venue+leg.race+"R "+(leg.race_name||""))+'</span><strong>'+esc(winner)+'</strong><em>'+esc(leg.jockey||"")+'</em></div>';
  }).join("");
  const hit=(x.legs||[]).filter(y=>y.horse_no).map(y=>y.horse_no).join(" → ");
  return '<article class="special-card win5-special">'+
    '<div class="special-head"><span>WIN5</span><strong>5レースの勝ち馬</strong><time></time></div>'+
    '<div class="win5-legs">'+rows+'</div>'+
    '<div class="win5-result"><span>的中馬番</span><strong>'+esc(hit||"結果待ち")+'</strong><span>'+(x.payout_kind?esc(x.payout_kind)+"払戻":"払戻")+'</span><b>'+esc(x.payout||"---")+'</b></div>'+
  '</article>';
}
function mainRaceCompactRow(x){
  const where=[x.venue,x.race].filter(Boolean).join(" ");
  const hasResult=!!x.winner||!!x.payout;
  const status=raceDisplayStatus(x.time,x.status,hasResult);
  const time=raceStartIfUpcoming(x.time,status,hasResult);
  const result=x.winner
    ? '<strong>'+esc(x.winner)+'</strong><small>'+esc(x.sub||"")+'</small>'
    : '<strong class="pending">'+esc(status||"発走前")+'</strong><small>'+esc(time?time+" 発走":"")+'</small>';
  const payout=x.payout?'<em>'+esc(x.payout)+'</em>':'';
  return '<div class="main-race-row '+esc(x.kind||"")+'">'+
    '<div class="main-race-place"><b>'+esc(where||"---")+'</b><span>'+esc(x.name||"---")+'</span></div>'+
    '<div class="main-race-result">'+result+payout+'</div>'+
  '</div>';
}
function renderMainRacePage(page){
  const host=document.getElementById("phase-grid");
  const items=page.items||[];
  const keirin=items.filter(x=>x.kind==="keirin");
  const boat=items.filter(x=>x.kind==="boat");
  const horse=items.filter(x=>x.kind==="local"||x.kind==="jra"||x.kind==="overseas");

  const section=(cls,label,list,emptyText)=>
    '<section class="main-race-section '+cls+'">'+
      '<div class="main-race-section-head"><span>'+label+'</span><b>'+list.length+'件</b></div>'+
      '<div class="main-race-list">'+
        (list.length?list.map(mainRaceCompactRow).join(""):'<div class="main-race-empty">'+emptyText+'</div>')+
      '</div>'+
    '</section>';

  host.className="main-race-summary";
  host.innerHTML=
    section("keirin","競輪　決勝",keirin,"本日の決勝なし")+
    section("boat","ボート　優勝戦",boat,"本日の優勝戦なし")+
    section("horse","競馬　メイン",horse,"本日のメインなし");

  document.getElementById("screen-title").textContent="本日の優勝戦・決勝戦・メインレース";
  document.getElementById("screen-sub").textContent="競輪 "+keirin.length+"件 / ボート "+boat.length+"件 / 競馬 "+horse.length+"件";
}
function renderSpecialPage(page){
  const host=document.getElementById("phase-grid");
  const items=page.items||[];
  host.className="special-grid count-"+Math.max(1,items.length);
  host.innerHTML=items.length?items.map(x=>x.kind==="win5"?win5Card(x):specialRaceCard(x)).join(""):'<div class="empty-card">本日の特別レース情報なし</div>';
  document.getElementById("screen-title").textContent="特別レース";
  document.getElementById("screen-sub").textContent="勝者・結果 "+items.length+"件";
}
function renderJraPage(page){
  const venues=page.venues||[];
  const host=document.getElementById("jra-grid");
  host.className="jra-dedicated-grid jra-two-col count-"+venues.length;
  host.innerHTML=venues.length?venues.map(jraVenueCard).join(""):'<div class="empty-card">JRA開催なし</div>';
  document.getElementById("screen-title").textContent="JRA";
  const pageText=page.total>1?(" "+page.page+"/"+page.total):"";
  document.getElementById("screen-sub").textContent=(venues.map(v=>v.name).join("・")||"開催なし")+" / 1〜3着＋騎手 / 全掛式払戻"+pageText;
  updateMarquees();
}
function showPage(index){
  const pages=buildPages();
  currentPageIndex=((index%pages.length)+pages.length)%pages.length;
  const page=pages[currentPageIndex];
  screenShownAt=performance.now();
  const isJra=page.type==="jra";
  document.getElementById("phase-screen").classList.toggle("active",!isJra);
  document.getElementById("jra-screen").classList.toggle("active",isJra);
  if(isJra) renderJraPage(page);
  else if(page.type==="main-races") renderMainRacePage(page);
  else if(page.type==="special") renderSpecialPage(page);
  else renderPhasePage(page);
  document.querySelectorAll(".sync-vscroll").forEach(x=>x.scrollTop=0);
  scheduleRotation();
}
function syncScrollPosition(){
  const pages=buildPages();
  const page=pages[currentPageIndex]||pages[0];
  if(page?.type==="jra"){
    const elapsed=(performance.now()-screenShownAt)%50000;
    let pos=0;
    if(elapsed<3000) pos=0;
    else if(elapsed<23000) pos=(elapsed-3000)/20000;
    else if(elapsed<27000) pos=1;
    else if(elapsed<47000) pos=1-(elapsed-27000)/20000;
    else pos=0;
    document.querySelectorAll("#jra-screen.active .sync-vscroll").forEach(box=>{
      const max=Math.max(0,box.scrollHeight-box.clientHeight);
      box.scrollTop=max*Math.max(0,Math.min(1,pos));
      box.classList.toggle("needs-vscroll",max>2);
    });
  }
  requestAnimationFrame(syncScrollPosition);
}
function updateMarquees(){
  requestAnimationFrame(()=>{
    document.querySelectorAll(".marquee-check").forEach(box=>{
      const text=box.querySelector(".marquee-text");
      if(!text) return;
      box.classList.toggle("is-marquee",text.scrollWidth>box.clientWidth+2);
    });
  });
}
async function getJson(url,fallback=""){
  try{
    const r=await fetch(url+(url.includes("?")?"&":"?")+"t="+Date.now(),{cache:"no-store"});
    if(!r.ok) throw new Error(url+" "+r.status);
    return r.json();
  }catch(err){
    if(!fallback) throw err;
    const r=await fetch(fallback+"?t="+Date.now(),{cache:"no-store"});
    if(!r.ok) throw err;
    return r.json();
  }
}
async function load(){
  try{
    const hadData=!!data||!!jra;
    const oldPages=buildPages();
    const oldKey=oldPages[currentPageIndex]?.key||"";
    const [d,j]=await Promise.all([getJson(DATA_URL,DATA_FALLBACK),getJson(JRA_URL)]);
    data=d;jra=j;
    document.getElementById("updated").textContent=data?.updated_at||jra?.updated_at||"--";
    const pages=buildPages();
    const found=pages.findIndex(p=>p.key===oldKey);
    currentPageIndex=found>=0?found:0;
    if(!hadData){
      showPage(currentPageIndex);
    }else{
      const page=pages[currentPageIndex];
      const isJra=page.type==="jra";
      document.getElementById("phase-screen").classList.toggle("active",!isJra);
      document.getElementById("jra-screen").classList.toggle("active",isJra);
      if(isJra) renderJraPage(page);
      else if(page.type==="main-races") renderMainRacePage(page);
      else if(page.type==="special") renderSpecialPage(page);
      else renderPhasePage(page);
    }
  }catch(e){
    console.error(e);
    document.getElementById("updated").textContent="再取得中";
  }
}
function currentPageDuration(){
  const pages=buildPages();
  const page=pages[currentPageIndex]||pages[0];
  return page?.type==="jra"?50000:20000;
}
function scheduleRotation(){
  if(rotateTimer) clearTimeout(rotateTimer);
  rotateTimer=setTimeout(rotate,currentPageDuration());
}
function rotate(){
  const pages=buildPages();
  showPage((currentPageIndex+1)%pages.length);
}
function tick(){
  document.getElementById("clock").textContent=jstNow();
  const el=document.getElementById("next-switch");
  if(el){
    const remain=Math.max(0,Math.ceil((currentPageDuration()-(performance.now()-screenShownAt))/1000));
    el.textContent="切替まで "+remain+"秒";
  }
}
setInterval(tick,1000);tick();

const pageNextButton=document.getElementById("page-next");
if(pageNextButton){
  pageNextButton.addEventListener("click",()=>{
    const pages=buildPages();
    if(!pages.length) return;
    showPage((currentPageIndex+1)%pages.length);
  });
}
document.addEventListener("keydown",e=>{
  if(e.key==="ArrowRight" || e.key==="PageDown"){
    const pages=buildPages();
    if(pages.length) showPage((currentPageIndex+1)%pages.length);
  }
});

load();setInterval(load,5000);
requestAnimationFrame(syncScrollPosition);
