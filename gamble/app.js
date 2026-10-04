const DATA_URL="./data.json";
const JRA_URL="../jra/data.json";
const PHASES=["モーニング","デイ","ナイター","ミッドナイト"];
const PAYOUT_TYPES=["単勝","複勝","枠連","馬連","馬単","ワイド","3連複","3連単"];
let data=null,jra=null,currentPageIndex=0,screenShownAt=performance.now(),rotateTimer=null;

function esc(v){
  return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function jstNow(){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value||"";
  return get("hour")+":"+get("minute");
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
      '<td class="winner">'+esc(x.winner||"---")+'</td>'+
      '<td class="origin">'+esc(x.origin||"---")+'</td>'+
      '<td class="combo">'+orderHtml(x.order,"keirin")+'</td>'+
      '<td class="pay">'+esc(x.payout||x.status||"発走前")+'</td>'+
    '</tr>';
  }
  return '<table class="phase-table keirin-table"><thead><tr><th>R</th><th>級</th><th>レース</th><th>勝者</th><th>出身</th><th>3連単</th><th>払戻</th></tr></thead><tbody>'+rows+'</tbody></table>';
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
function localRows(v){
  const races=v.races||[];
  let rows="";
  for(const x of races){
    rows+='<tr>'+
      '<td class="r">'+esc(x.race)+'R</td>'+
      '<td class="local-info"><div>'+raceNameMarquee(x.race_name||"—")+'</div><b>'+esc(horseCourse(x))+'</b></td>'+
      '<td class="winner">'+esc(x.winner||x.status||"発走前")+'</td>'+
      '<td class="jockey">'+esc(x.jockey||"")+'</td>'+
      '<td class="combo">'+orderHtml(x.order,"local")+'</td>'+
      '<td class="pay">'+esc(x.trifecta||"")+'</td>'+
    '</tr>';
  }
  return '<table class="phase-table local-table"><thead><tr><th>R</th><th>レース/馬場距離</th><th>勝ち馬</th><th>騎手</th><th>3連単</th><th>払戻</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function phaseCard(item){
  const body=item.kind==="keirin"?keirinRows(item.venue):item.kind==="boat"?boatRows(item.venue):localRows(item.venue);
  return '<article class="phase-card '+item.kind+'-card">'+phaseCardHead(item)+'<div class="card-table-wrap">'+body+'</div></article>';
}
function jraRaceResult(venueName,raceNo){
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

  // JRA: 当日の各場メイン。勝ち馬＋勝利騎手が最優先。
  for(const v of jra?.venues||[]){
    const r=(v.results||[]).find(x=>Number(x.race)===11)||{};
    if(!r.race_name) continue;
    const first=Array.isArray(r.top3)?(r.top3.find(x=>Number(x.position)===1)||{}):{};
    const tri=Array.isArray(r?.payouts?.["3連単"])?r.payouts["3連単"][0]:null;
    out.push({
      kind:"jra",source:"JRA",venue:v.name||"",race:"11R",name:r.race_name||"",
      time:r.time||"",winner:first.horse||"",sub:first.jockey?("騎手 "+first.jockey):"",
      order:tri?.combo?String(tri.combo).split(/[-－]/).map(Number):[],
      payout:tri?.amount||"",status:first.horse?"確定":"発走前"
    });
  }

  // 海外発売対象の大レース。
  for(const x of data?.featured_races||[]){
    if(x.source!=="海外競馬") continue;
    out.push({
      kind:"overseas",source:"海外G1",venue:x.venue||"海外",race:x.race||"",
      name:x.name||"",time:x.time||"",winner:x.winner||"",
      sub:x.jockey?("騎手 "+x.jockey):"",order:x.order||[],payout:x.payout||"",
      status:x.winner?"確定":"発走前",horses:x.horses||[]
    });
  }

  // WIN5: 対象5Rの勝ち馬をJRA結果から順次埋める。
  const targets=data?.win5?.targets||[];
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
function buildPages(){
  const pages=[];
  const sportGroups=[
    {kind:"keirin",label:"競輪"},
    {kind:"boat",label:"ボート"},
    {kind:"local",label:"地方競馬"}
  ];
  for(const phase of PHASES){
    const phaseAll=phaseItems(phase);

    if(phase==="モーニング"){
      const morningMain=phaseAll.filter(x=>x.kind==="keirin"||x.kind==="boat");
      for(let i=0;i<morningMain.length;i+=6){
        const chunk=morningMain.slice(i,i+6);
        pages.push({
          key:"phase:モーニング:mixed:"+Math.floor(i/6),
          type:"phase",
          phase:"モーニング",
          sportKind:"mixed",
          sportLabel:"",
          page:Math.floor(i/6)+1,
          total:Math.ceil(morningMain.length/6),
          items:chunk
        });
      }
      const morningLocal=phaseAll.filter(x=>x.kind==="local");
      for(let i=0;i<morningLocal.length;i+=6){
        const chunk=morningLocal.slice(i,i+6);
        pages.push({
          key:"phase:モーニング:local:"+Math.floor(i/6),
          type:"phase",
          phase:"モーニング",
          sportKind:"local",
          sportLabel:"地方競馬",
          page:Math.floor(i/6)+1,
          total:Math.ceil(morningLocal.length/6),
          items:chunk
        });
      }
      continue;
    }

    for(const group of sportGroups){
      const items=phaseAll.filter(x=>x.kind===group.kind);
      for(let i=0;i<items.length;i+=6){
        const chunk=items.slice(i,i+6);
        pages.push({
          key:"phase:"+phase+":"+group.kind+":"+Math.floor(i/6),
          type:"phase",
          phase,
          sportKind:group.kind,
          sportLabel:group.label,
          page:Math.floor(i/6)+1,
          total:Math.ceil(items.length/6),
          items:chunk
        });
      }
    }
  }

  const specials=specialItems();
  if(specials.length){
    pages.push({
      key:"special:all",
      type:"special",
      page:1,
      total:1,
      items:specials
    });
  }

  const jraVenues=jra?.venues||[];
  for(let i=0;i<jraVenues.length;i+=2){
    pages.push({
      key:"jra:"+Math.floor(i/2),
      type:"jra",
      page:Math.floor(i/2)+1,
      total:Math.ceil(jraVenues.length/2),
      venues:jraVenues.slice(i,i+2)
    });
  }
  return pages.length?pages:[{key:"phase:デイ:0",type:"phase",phase:"デイ",page:1,total:1,items:[]}];
}
function renderPhasePage(page){
  const items=page.items||[];
  const host=document.getElementById("phase-grid");
  host.className="phase-grid count-"+Math.max(1,items.length);
  host.innerHTML=items.length?items.map(phaseCard).join(""):'<div class="empty-card">'+esc(page.phase+" "+(page.sportLabel||""))+'開催なし</div>';
  document.getElementById("screen-title").textContent=page.sportLabel?(page.phase+"・"+page.sportLabel):page.phase;
  const pageText=page.total>1?(" "+page.page+"/"+page.total):"";
  if(page.sportKind==="mixed"){
    const kc=items.filter(x=>x.kind==="keirin").length;
    const bc=items.filter(x=>x.kind==="boat").length;
    document.getElementById("screen-sub").textContent="競輪 "+kc+"場 / ボート "+bc+"場"+pageText;
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
  const result=hasWinner
    ?'<div class="special-winner"><span>'+winnerLabel+'</span><strong>'+esc(x.winner)+'</strong><em>'+esc(x.sub||"")+'</em></div>'
    :'<div class="special-winner waiting"><span>結果</span><strong>'+esc(x.status||"発走前")+'</strong><em>'+esc(x.time?x.time+" 発走予定":"")+'</em></div>';
  const combo=(Array.isArray(x.order)&&x.order.length>=3)?orderHtml(x.order,(x.kind==="local"||x.kind==="jra"||x.kind==="overseas")?"local":(x.kind==="boat"?"boat":"keirin")):'<span class="muted">---</span>';
  const meta=(x.kind==="overseas"&&!hasWinner&&Array.isArray(x.horses)&&x.horses.length)
    ?'<div class="special-detail"><b>注目馬</b><span>'+esc(x.horses.join("・"))+'</span></div>'
    :'<div class="special-detail"><b>3連単</b><span>'+combo+'</span><b>払戻</b><strong>'+esc(x.payout||"---")+'</strong></div>';
  return '<article class="special-card '+esc(x.kind||"")+'-special">'+
    '<div class="special-head"><span>'+esc(x.source||"特別")+'</span><strong>'+esc(where||"特別競走")+'</strong><time>'+esc(x.time?x.time+" 発走":"")+'</time></div>'+
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
async function getJson(url){
  const r=await fetch(url+"?t="+Date.now(),{cache:"no-store"});
  if(!r.ok) throw new Error(url+" "+r.status);
  return r.json();
}
async function load(){
  try{
    const hadData=!!data||!!jra;
    const oldPages=buildPages();
    const oldKey=oldPages[currentPageIndex]?.key||"";
    const [d,j]=await Promise.all([getJson(DATA_URL),getJson(JRA_URL)]);
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
load();setInterval(load,30000);
requestAnimationFrame(syncScrollPosition);
