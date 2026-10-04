const DATA_URL="./data.json";
const JRA_URL="../jra/data.json";
let data=null,jra=null,keirinPage=0;

function esc(v){return String(v??"").replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]})}
function jstNow(){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const get=function(t){return parts.find(function(p){return p.type===t})?.value||""};
  return {hour:+get("hour"),minute:+get("minute"),second:+get("second"),clock:get("hour")+":"+get("minute")};
}
function numBox(n){return '<span class="num n'+Number(n)+'">'+esc(n)+'</span>'}
function orderHtml(order){
  if(!Array.isArray(order)||order.length<3) return '<span class="pending">---</span>';
  return '<span class="order">'+order.slice(0,3).map(numBox).join("")+'</span>';
}
function raceRows(races,count){
  const map=new Map((races||[]).map(function(r){return [Number(r.race),r]}));
  let out="";
  const rows=Math.max(1,Math.min(12,Number(count)||12));
  for(let r=1;r<=rows;r++){
    const x=map.get(r)||{race:r,status:"発走前",order:[],payout:""};
    out+='<tr><td class="rcol">'+r+'R</td><td class="ocol">'+orderHtml(x.order)+'</td><td class="pcol '+(x.payout?"":"pending")+'">'+esc(x.payout||x.status||"発走前")+'</td></tr>';
  }
  return out;
}
function compactCard(v,kind){
  const title=v.display_name||v.name||v.venue||"---";
  const event=v.event_name||"";
  const grade=kind==="keirin"&&v.grade?' <small>'+esc(v.grade)+'</small>':"";
  const raceCount=kind==="keirin"
    ?((v.race_ids||[]).length||(v.races||[]).reduce(function(m,x){return Math.max(m,Number(x.race)||0)},0)||12)
    :12;
  const klass=kind==="keirin"?"result-card keirin-card":"result-card";
  return '<article class="'+klass+'"><div class="card-head"><div class="card-title">'+esc(title)+grade+'</div><div class="event">'+esc(event)+'</div></div><table class="compact-table"><thead><tr><th>R</th><th>3連単</th><th>払戻金</th></tr></thead><tbody>'+raceRows(v.races,raceCount)+'</tbody></table></article>';
}
function renderKeirin(){
  const host=document.getElementById("keirin-grid");
  const phase=data?.keirin?.phase||"";
  document.getElementById("keirin-phase").textContent=phase||"開催なし";
  const venues=data?.keirin?.venues||[];
  if(!venues.length){
    host.innerHTML='<div class="empty-card">現在表示する競輪開催はありません</div><div class="empty-card">次の時間帯を待っています</div>';
    return;
  }
  const pages=[];
  for(let i=0;i<venues.length;i+=3) pages.push(venues.slice(i,i+3));
  if(keirinPage>=pages.length) keirinPage=0;
  const current=pages[keirinPage]||[];
  host.classList.toggle("one",current.length===1);
  host.classList.toggle("three",current.length>=3);
  host.innerHTML=current.map(function(v){return compactCard(v,"keirin")}).join("");
}
function renderBoats(){
  const host=document.getElementById("boat-grid");
  const boats=(data?.boats||[]).filter(function(b){return b.active!==false}).slice(0,2);
  if(!boats.length){
    host.innerHTML='<div class="empty-card">注目ボート結果待ち</div><div class="empty-card">終了1時間後に表示終了</div>';
    return;
  }
  host.innerHTML=boats.map(function(v){return compactCard(v,"boat")}).join("")+(boats.length===1?'<div class="empty-card">もう1場は表示終了</div>':"");
}
function cleanJockey(s){return String(s||"").replace(/(?<=[\u3040-\u30ff\u3400-\u9fff])\s+(?=[\u3040-\u30ff\u3400-\u9fff])/g,"")}
function trifectaJra(r){
  const a=r?.payouts?.["3連単"];
  if(!Array.isArray(a)||!a[0]) return {combo:"",amount:""};
  return {combo:a[0].combo||"",amount:a[0].amount||""};
}
function raceInfoText(x){
  if(!x) return "レース情報待ち";
  return [x.race_name||"",x.course||""].filter(Boolean).join("　")||"レース情報待ち";
}
function jraVenueCard(v){
  const map=new Map((v.results||[]).map(function(x){return [Number(x.race),x]}));
  let rows="";
  for(let r=1;r<=12;r++){
    const x=map.get(r);
    const horse=x?.horse||x?.top3?.[0]?.horse||"";
    const jockey=cleanJockey(x?.jockey||x?.top3?.[0]?.jockey||"");
    const tri=trifectaJra(x);
    const status=(horse||jockey||tri.amount)?"":"発走前";
    rows+='<div class="horse-race">'+
      '<div class="horse-result-line">'+
        '<span class="race-no">'+r+'R</span>'+
        '<span class="winner '+(status?"pending":"")+'">'+esc(horse||status)+'</span>'+
        '<span class="winner-jockey">'+esc(jockey||"")+'</span>'+
        '<span class="tri-combo '+(tri.combo?"":"pending")+'">'+esc(tri.combo||"---")+'</span>'+
        '<span class="tri-pay '+(tri.amount?"":"pending")+'">'+esc(tri.amount||"")+'</span>'+
      '</div>'+
      '<div class="race-info marquee-check"><div class="marquee-track"><span class="marquee-text">'+esc(raceInfoText(x))+'</span><span class="marquee-copy" aria-hidden="true">'+esc(raceInfoText(x))+'</span></div></div>'+
    '</div>';
  }
  return '<article class="jra-card"><div class="card-head"><div class="card-title">'+esc(v.name||"---")+'</div><div class="event">1R〜12R</div></div><div class="horse-races">'+rows+'</div></article>';
}
function localVenueCard(v){
  const map=new Map((v.races||[]).map(function(x){return [Number(x.race),x]}));
  let rows="";
  for(let r=1;r<=12;r++){
    const x=map.get(r)||{};
    const combo=Array.isArray(x.order)&&x.order.length>=3?x.order.join("-"):"";
    rows+='<tr><td class="jr">'+r+'R</td><td class="horse '+(x.winner?"":"pending")+'">'+esc(x.winner||x.status||"発走前")+'</td><td class="jockey">'+esc(x.jockey||"")+'</td><td class="pay '+(x.trifecta?"":"pending")+'">'+esc((combo?combo+" ":"")+(x.trifecta||""))+'</td></tr>';
  }
  return '<article class="jra-card"><div class="card-head"><div class="card-title">'+esc(v.name||"---")+'</div><div class="event">地方ナイター</div></div><table class="jra-table"><thead><tr><th>R</th><th>勝ち馬</th><th>勝利騎手</th><th>3連単 組合せ・払戻</th></tr></thead><tbody>'+rows+'</tbody></table></article>';
}
function updateMarquees(){
  requestAnimationFrame(function(){
    document.querySelectorAll(".marquee-check").forEach(function(box){
      const text=box.querySelector(".marquee-text");
      if(!text) return;
      box.classList.toggle("is-marquee",text.scrollWidth>box.clientWidth+2);
    });
  });
}
function renderRight(){
  const now=jstNow();
  const night=now.hour>=17;
  const host=document.getElementById("right-grid");
  let venues=[];
  if(night){
    document.getElementById("right-mini").textContent="NAR NIGHT / WINNER・JOCKEY・3連単";
    document.getElementById("right-title").textContent="本日の地方競馬ナイター";
    document.getElementById("right-note").textContent="17:00から自動切替";
    venues=(data?.local_night?.venues||[]).slice(0,3);
    host.classList.toggle("three",venues.length>=3);
    host.innerHTML=venues.length?venues.map(localVenueCard).join(""):'<div class="empty-card">本日の地方ナイター情報を取得中</div>';
  }else{
    document.getElementById("right-mini").textContent="JRA / WINNER・JOCKEY・3連単";
    document.getElementById("right-title").textContent="JRA";
    document.getElementById("right-note").textContent="17:00に地方競馬ナイターへ切替";
    venues=(jra?.venues||[]).slice(0,3);
    host.classList.toggle("three",venues.length>=3);
    host.innerHTML=venues.length?venues.map(jraVenueCard).join(""):'<div class="empty-card">JRA開催情報を取得中</div>';
    updateMarquees();
  }
}
function render(){
  renderKeirin();renderBoats();renderRight();updateMarquees();
  document.getElementById("updated").textContent="最終取得 "+(data?.updated_at||jra?.updated_at||"--");
  const src=data?.source||{};
  document.getElementById("source").textContent="日程: "+(src.schedule||"Free WiFi EPG")+" / 競輪: "+(src.keirin||"-")+" / ボート: "+(src.boat||"-")+" / JRA: JRA公式";
}
async function getJson(url){
  const r=await fetch(url+"?t="+Date.now(),{cache:"no-store"});
  if(!r.ok) throw new Error(url+" "+r.status);
  return r.json();
}
async function load(){
  try{
    const values=await Promise.all([getJson(DATA_URL),getJson(JRA_URL)]);
    data=values[0];jra=values[1];render();
  }catch(e){
    console.error(e);
    document.getElementById("updated").textContent="取得再試行中";
  }
}
function tick(){
  document.getElementById("clock").textContent=jstNow().clock;
}
setInterval(tick,1000);tick();
load();setInterval(load,30000);
setInterval(function(){
  const n=Math.ceil((data?.keirin?.venues||[]).length/3);
  if(n>1){keirinPage=(keirinPage+1)%n;renderKeirin()}
},15000);
