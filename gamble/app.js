const DATA_URL="./data.json";
const JRA_URL="../jra/data.json";
const PHASES=["モーニング","デイ","ナイター","ミッドナイト"];
const PAYOUT_TYPES=["単勝","複勝","枠連","馬連","馬単","ワイド","3連複","3連単"];
let data=null,jra=null,currentPageIndex=0,screenShownAt=performance.now();

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
function buildPages(){
  const pages=[];
  for(const phase of PHASES){
    const items=phaseItems(phase);
    for(let i=0;i<items.length;i+=4){
      const chunk=items.slice(i,i+4);
      pages.push({
        key:"phase:"+phase+":"+Math.floor(i/4),
        type:"phase",
        phase,
        page:Math.floor(i/4)+1,
        total:Math.ceil(items.length/4),
        items:chunk
      });
    }
  }

  const specials=data?.featured_races||[];
  for(let i=0;i<specials.length;i+=4){
    pages.push({
      key:"special:"+Math.floor(i/4),
      type:"special",
      page:Math.floor(i/4)+1,
      total:Math.ceil(specials.length/4),
      items:specials.slice(i,i+4)
    });
  }

  const jraVenues=jra?.venues||[];
  if(jraVenues.length){
    pages.push({
      key:"jra:all",
      type:"jra",
      venues:jraVenues
    });
  }
  return pages.length?pages:[{key:"phase:デイ:0",type:"phase",phase:"デイ",page:1,total:1,items:[]}];
}
function renderPhasePage(page){
  const items=page.items||[];
  const host=document.getElementById("phase-grid");
  host.className="phase-grid count-"+Math.max(1,items.length);
  host.innerHTML=items.length?items.map(phaseCard).join(""):'<div class="empty-card">'+esc(page.phase)+'開催なし</div>';
  document.getElementById("screen-title").textContent=page.phase;
  const pageText=page.total>1?(" "+page.page+"/"+page.total):"";
  document.getElementById("screen-sub").textContent=(items.length?("競輪・ボート・地方 "+items.length+"場"):"開催なし")+pageText;
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
function renderSpecialPage(page){
  const host=document.getElementById("phase-grid");
  const items=page.items||[];
  host.className="special-grid count-"+Math.max(1,items.length);
  host.innerHTML=items.length?items.map(x=>{
    const where=[x.venue,x.race].filter(Boolean).join(" ");
    const horses=Array.isArray(x.horses)&&x.horses.length?x.horses.join("・"):"情報取得中";
    return '<article class="special-card">'+
      '<div class="special-head"><span>'+esc(x.source||"特別")+'</span><strong>'+esc(where||"特別競走")+'</strong><time>'+esc(x.time?x.time+" 発走予定":"")+'</time></div>'+
      '<div class="special-name">'+esc(x.name||"---")+'</div>'+
      '<div class="special-horses"><b>有力馬</b> '+esc(horses)+'</div>'+
    '</article>';
  }).join(""):'<div class="empty-card">本日の特別レース情報なし</div>';
  document.getElementById("screen-title").textContent="特別レース";
  document.getElementById("screen-sub").textContent=page.total>1?("注目競走 "+page.page+"/"+page.total):"注目競走";
}
function renderJraPage(page){
  const venues=page.venues||[];
  const host=document.getElementById("jra-grid");
  host.className="jra-dedicated-grid all-jra-venues sync-vscroll";
  host.innerHTML=venues.length?venues.map(jraVenueCard).join(""):'<div class="empty-card">JRA開催なし</div>';
  document.getElementById("screen-title").textContent="JRA";
  document.getElementById("screen-sub").textContent=(venues.map(v=>v.name).join("・")||"開催なし")+" / 1〜3着＋騎手 / 全掛式払戻";
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
}
function syncScrollPosition(){
  const pages=buildPages();
  const page=pages[currentPageIndex]||pages[0];
  if(page?.type==="jra"){
    const elapsed=(performance.now()-screenShownAt)%20000;
    let pos=0;
    if(elapsed<1200) pos=0;
    else if(elapsed<8800) pos=(elapsed-1200)/7600;
    else if(elapsed<10400) pos=1;
    else if(elapsed<18000) pos=1-(elapsed-10400)/7600;
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
function rotate(){
  const pages=buildPages();
  showPage((currentPageIndex+1)%pages.length);
}
function tick(){document.getElementById("clock").textContent=jstNow()}
setInterval(tick,1000);tick();
load();setInterval(load,30000);
requestAnimationFrame(syncScrollPosition);
setInterval(rotate,20000);
