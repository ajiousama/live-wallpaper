const DATA_URL="./data.json";
const JRA_URL="../jra/data.json";
let data=null,jra=null,screenMode="keirin";

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
  const tags=kind==="keirin"?[v.type,v.grade].filter(Boolean).join(" / "):"";
  const grade=tags?' <small>'+esc(tags)+'</small>':"";
  const raceCount=kind==="keirin"
    ?((v.race_ids||[]).length||(v.races||[]).reduce(function(m,x){return Math.max(m,Number(x.race)||0)},0)||12)
    :12;
  const klass=kind==="keirin"?"result-card keirin-card":"result-card";
  return '<article class="'+klass+'"><div class="card-head"><div class="card-title">'+esc(title)+grade+'</div><div class="event">'+esc(event)+'</div></div><table class="compact-table"><thead><tr><th>R</th><th>3連単</th><th>払戻金</th></tr></thead><tbody>'+raceRows(v.races,raceCount)+'</tbody></table></article>';
}
function renderKeirin(){
  const host=document.getElementById("keirin-grid");
  const venues=data?.keirin?.venues||[];
  document.getElementById("keirin-phase").textContent=venues.length?("本日開催 "+venues.length+"場"):"開催なし";
  if(!venues.length){
    host.className="all-venue-grid keirin-all";
    host.innerHTML='<div class="empty-card">本日の競輪開催はありません</div>';
    return;
  }
  host.className="all-venue-grid keirin-all";
  host.innerHTML=venues.map(function(v){return compactCard(v,"keirin")}).join("");
}
function showScreen(mode){
  screenMode=["keirin","race","boat"].includes(mode)?mode:"keirin";
  const main=document.querySelector(".main-grid");
  main?.classList.remove("screen-keirin","screen-race","screen-boat");
  main?.classList.add("screen-"+screenMode);
  document.querySelector(".keirin-block")?.classList.toggle("active",screenMode==="keirin");
  document.querySelector(".boat-block")?.classList.toggle("active",screenMode==="boat");
}
function renderBoats(){
  const host=document.getElementById("boat-grid");
  const boats=data?.boats||[];
  host.className="all-venue-grid boat-all";
  if(!boats.length){
    host.innerHTML='<div class="empty-card">本日のボート開催情報を取得中</div>';
    return;
  }
  host.innerHTML=boats.map(function(v){return compactCard(v,"boat")}).join("");
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
  const host=document.getElementById("right-grid");
  document.getElementById("right-mini").textContent="JRA + LOCAL / ALL VENUES";
  document.getElementById("right-title").textContent="本日の競馬 全開催場";
  const central=(jra?.venues||[]).map(function(v){return {kind:"jra",venue:v}});
  const local=(data?.local_all?.venues||[]).map(function(v){return {kind:"local",venue:v}});
  const cards=central.concat(local);
  document.getElementById("right-note").textContent="JRA・地方競馬を全場表示";
  host.className="race-all-grid";
  host.innerHTML=cards.length?cards.map(function(x){
    return x.kind==="jra"?jraVenueCard(x.venue):localVenueCard(x.venue);
  }).join(""):'<div class="empty-card">本日の競馬開催情報を取得中</div>';
  updateMarquees();
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
const SCREEN_ORDER=["keirin","race","boat"];
setInterval(function(){
  const i=SCREEN_ORDER.indexOf(screenMode);
  showScreen(SCREEN_ORDER[(i+1)%SCREEN_ORDER.length]);
},20000);
showScreen("keirin");
