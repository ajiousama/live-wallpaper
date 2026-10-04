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
function raceRows(races,count,kind){
  const map=new Map((races||[]).map(function(r){return [Number(r.race),r]}));
  let out="";
  const rows=Math.max(1,Math.min(12,Number(count)||12));
  for(let r=1;r<=rows;r++){
    const x=map.get(r)||{race:r,status:"発走前",order:[],payout:""};
    const rawRaceName=x.race_name||x.race_type||"—";
    const classMatch=kind==="keirin"?rawRaceName.match(/^[ＡAＳSＬL]級/):null;
    const classLabel=classMatch?classMatch[0].replace("A","Ａ").replace("S","Ｓ").replace("L","Ｌ"):"";
    const raceName=classMatch?rawRaceName.slice(classMatch[0].length).trim():rawRaceName;
    const classCell=kind==="keirin"?'<td class="class-col '+(classLabel?"":"pending")+'">'+esc(classLabel||"---")+'</td>':"";
    const winnerCell=kind==="keirin"?'<td class="winner-name '+(x.winner?"":"pending")+'">'+esc(x.winner||"---")+'</td><td class="winner-origin '+(x.origin?"":"pending")+'">'+esc(x.origin||"---")+'</td>':"";
    out+='<tr><td class="rcol">'+r+'R</td>'+classCell+'<td class="race-label marquee-check" title="'+esc(raceName)+'"><div class="marquee-track"><span class="marquee-text">'+esc(raceName)+'</span><span class="marquee-copy" aria-hidden="true">'+esc(raceName)+'</span></div></td>'+winnerCell+'<td class="ocol">'+orderHtml(x.order)+'</td><td class="pcol '+(x.payout?"":"pending")+'">'+esc(x.payout||x.status||"発走前")+'</td></tr>';
  }
  return out;
}
function compactCard(v,kind){
  const title=v.display_name||v.name||v.venue||"---";
  const event=v.event_name||"";
  const tags=kind==="keirin"?[v.type,v.grade].filter(Boolean).join(" / "):(kind==="boat"?[v.day_type].filter(Boolean).join(" / "):"");
  const grade=tags?' <small>'+esc(tags)+'</small>':"";
  const raceCount=kind==="keirin"
    ?((v.race_ids||[]).length||(v.races||[]).reduce(function(m,x){return Math.max(m,Number(x.race)||0)},0)||12)
    :12;
  const klass=kind==="keirin"?"result-card keirin-card":"result-card";
  const classHead=kind==="keirin"?'<th class="class-col">級</th>':"";
  const winnerHead=kind==="keirin"?'<th class="winner-name">勝者</th><th class="winner-origin">出身</th>':"";
  const table='<table class="compact-table"><thead><tr><th class="rcol">R</th>'+classHead+'<th class="race-label">レース名</th>'+winnerHead+'<th class="ocol">3連単</th><th class="pcol">払戻金</th></tr></thead><tbody>'+raceRows(v.races,raceCount,kind)+'</tbody></table>';
  const body='<div class="result-table-viewport auto-vscroll">'+table+'</div>';
  return '<article class="'+klass+'"><div class="card-head"><div class="card-title">'+esc(title)+grade+'</div><div class="event">'+esc(event)+'</div></div>'+body+'</article>';
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
  setupAllVerticalScrolls(true);
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
  setupAllVerticalScrolls(true);
}
function cleanJockey(s){return String(s||"").replace(/(?<=[\u3040-\u30ff\u3400-\u9fff])\s+(?=[\u3040-\u30ff\u3400-\u9fff])/g,"")}
function trifectaJra(r){
  const a=r?.payouts?.["3連単"];
  if(!Array.isArray(a)||!a[0]) return {combo:"",amount:""};
  return {combo:a[0].combo||"",amount:a[0].amount||""};
}
function raceInfoText(x){
  if(!x) return "レース情報待ち";
  return x.race_name||"レース情報待ち";
}
function horseRaceInfoCell(x){
  const name=raceInfoText(x);
  const rawCourse=String(x?.course||"");
  let cm=rawCourse.match(/(芝|ダート|障害|直)[^0-9]{0,12}([0-9,]{3,5})\s*m?/);
  if(!cm){
    const rev=rawCourse.match(/([0-9,]{3,5})\s*(?:m|メートル).*?[（(](芝|ダート|障害|直)/);
    cm=rev?[rev[0],rev[2],rev[1]]:null;
  }
  const course=cm?(cm[1]+cm[2].replace(/,/g,"")+"m"):"馬場・距離取得中";
  return '<td class="race-label race-info-two" title="'+esc([name,course].filter(Boolean).join(" "))+'">'+
    '<div class="race-name-line marquee-check"><div class="marquee-track"><span class="marquee-text">'+esc(name)+'</span><span class="marquee-copy" aria-hidden="true">'+esc(name)+'</span></div></div>'+
    '<div class="race-course-line">'+esc(course)+'</div>'+
  '</td>';
}
function jraVenueCard(v){
  const map=new Map((v.results||[]).map(function(x){return [Number(x.race),x]}));
  let rows="";
  for(let r=1;r<=12;r++){
    const x=map.get(r)||{};
    const horse=x.horse||x.top3?.[0]?.horse||"";
    const jockey=cleanJockey(x.jockey||x.top3?.[0]?.jockey||"");
    const tri=trifectaJra(x);
    rows+='<tr><td class="jr">'+r+'R</td>'+horseRaceInfoCell(x)+'<td class="horse '+(horse?"":"pending")+'">'+esc(horse||"発走前")+'</td><td class="jockey">'+esc(jockey)+'</td><td class="tri-combo-cell '+(tri.combo?"":"pending")+'">'+esc(tri.combo||"---")+'</td><td class="pay '+(tri.amount?"":"pending")+'">'+esc(tri.amount||"")+'</td></tr>';
  }
  const table='<table class="jra-table"><thead><tr><th class="jr">R</th><th class="race-label">レース名 / 馬場・距離</th><th>勝ち馬</th><th class="jockey">騎手</th><th class="tri-combo-cell">3連単</th><th class="pay">払戻</th></tr></thead><tbody>'+rows+'</tbody></table>';
  return '<article class="jra-card unified-race-card"><div class="card-head"><div class="card-title">'+esc(v.name||"---")+'</div><div class="event">JRA</div></div><div class="horse-table-viewport auto-vscroll">'+table+'</div></article>';
}
function localVenueCard(v){
  const map=new Map((v.races||[]).map(function(x){return [Number(x.race),x]}));
  let rows="";
  for(let r=1;r<=12;r++){
    const x=map.get(r)||{};
    const combo=Array.isArray(x.order)&&x.order.length>=3?x.order.join("-"):"";
    rows+='<tr><td class="jr">'+r+'R</td>'+horseRaceInfoCell(x)+'<td class="horse '+(x.winner?"":"pending")+'">'+esc(x.winner||x.status||"発走前")+'</td><td class="jockey">'+esc(x.jockey||"")+'</td><td class="tri-combo-cell '+(combo?"":"pending")+'">'+esc(combo||"---")+'</td><td class="pay '+(x.trifecta?"":"pending")+'">'+esc(x.trifecta||"")+'</td></tr>';
  }
  const table='<table class="jra-table"><thead><tr><th class="jr">R</th><th class="race-label">レース名 / 馬場・距離</th><th>勝ち馬</th><th class="jockey">騎手</th><th class="tri-combo-cell">3連単</th><th class="pay">払戻</th></tr></thead><tbody>'+rows+'</tbody></table>';
  return '<article class="jra-card unified-race-card"><div class="card-head"><div class="card-title">'+esc(v.name||"---")+'</div><div class="event">地方</div></div><div class="horse-table-viewport auto-vscroll">'+table+'</div></article>';
}
function featuredRaceCard(items){
  const rows=(items||[]).map(function(x){
    const where=[x.venue,x.race].filter(Boolean).join(" ");
    const horses=Array.isArray(x.horses)&&x.horses.length?x.horses.join("・"):"情報取得中";
    return '<div class="featured-race-item">'+
      '<div class="featured-meta"><span class="featured-source">'+esc(x.source||"MAIN")+'</span><span>'+esc(where)+'</span><span class="featured-time">'+esc(x.time?x.time+" 発走予定":"")+'</span></div>'+
      '<div class="featured-name">'+esc(x.name||"---")+'</div>'+
      '<div class="featured-horses"><span>有力馬</span> '+esc(horses)+'</div>'+
    '</div>';
  }).join("");
  return '<article class="jra-card featured-race-card">'+
    '<div class="card-head"><div class="card-title">本日のメイン競走</div><div class="event">自動更新</div></div>'+
    '<div class="featured-race-viewport auto-vscroll"><div class="featured-race-track">'+rows+'</div></div>'+
  '</article>';
}
function setupAllVerticalScrolls(reset){
  requestAnimationFrame(function(){
    document.querySelectorAll(".auto-vscroll").forEach(function(box){
      const max=Math.max(0,box.scrollHeight-box.clientHeight);
      const needs=box.clientHeight>0&&max>2;
      box.classList.toggle("needs-vscroll",needs);
      if(reset||!needs){
        box.scrollTop=0;
        box.dataset.dir="1";
        box.dataset.hold=needs?"20":"0";
      }
    });
  });
}
function stepAllVerticalScrolls(){
  document.querySelectorAll(".auto-vscroll.needs-vscroll").forEach(function(box){
    if(box.clientHeight<=0) return;
    const max=Math.max(0,box.scrollHeight-box.clientHeight);
    if(max<=2) return;
    let hold=Number(box.dataset.hold||0);
    if(hold>0){
      box.dataset.hold=String(hold-1);
      return;
    }
    const dir=Number(box.dataset.dir||1);
    box.scrollTop+=dir;
    if(box.scrollTop>=max-1){
      box.scrollTop=max;
      box.dataset.dir="-1";
      box.dataset.hold="20";
    }else if(box.scrollTop<=1){
      box.scrollTop=0;
      box.dataset.dir="1";
      box.dataset.hold="20";
    }
  });
}
function setupFeaturedRaceScroll(reset){
  requestAnimationFrame(function(){
    document.querySelectorAll(".featured-race-viewport").forEach(function(box){
      const max=Math.max(0,box.scrollHeight-box.clientHeight);
      box.classList.toggle("needs-vscroll",max>2);
      if(reset){
        box.scrollTop=0;
        box.dataset.dir="1";
        box.dataset.hold="25";
      }
    });
  });
}
function stepFeaturedRaceScroll(){
  if(screenMode!=="race") return;
  document.querySelectorAll(".featured-race-viewport.needs-vscroll").forEach(function(box){
    const max=Math.max(0,box.scrollHeight-box.clientHeight);
    if(max<=2) return;
    let hold=Number(box.dataset.hold||0);
    if(hold>0){
      box.dataset.hold=String(hold-1);
      return;
    }
    const dir=Number(box.dataset.dir||1);
    box.scrollTop+=dir;
    if(box.scrollTop>=max-1){
      box.scrollTop=max;
      box.dataset.dir="-1";
      box.dataset.hold="25";
    }else if(box.scrollTop<=1){
      box.scrollTop=0;
      box.dataset.dir="1";
      box.dataset.hold="25";
    }
  });
}
function setupBoatVerticalScrolls(reset){
  requestAnimationFrame(function(){
    document.querySelectorAll(".boat-table-viewport").forEach(function(box){
      const max=Math.max(0,box.scrollHeight-box.clientHeight);
      const needs=max>2;
      box.classList.toggle("needs-vscroll",needs);
      if(reset || !needs){
        box.scrollTop=0;
        box.dataset.dir="1";
        box.dataset.hold=needs?"18":"0";
      }
    });
  });
}
function stepBoatVerticalScrolls(){
  if(screenMode!=="boat") return;
  document.querySelectorAll(".boat-table-viewport.needs-vscroll").forEach(function(box){
    const max=Math.max(0,box.scrollHeight-box.clientHeight);
    if(max<=2) return;
    let hold=Number(box.dataset.hold||0);
    if(hold>0){
      box.dataset.hold=String(hold-1);
      return;
    }
    let dir=Number(box.dataset.dir||1);
    box.scrollTop+=dir;
    if(box.scrollTop>=max-1){
      box.scrollTop=max;
      box.dataset.dir="-1";
      box.dataset.hold="18";
    }else if(box.scrollTop<=1){
      box.scrollTop=0;
      box.dataset.dir="1";
      box.dataset.hold="18";
    }
  });
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
  const featured=data?.featured_races||[];
  document.getElementById("right-note").textContent="JRA・地方競馬を全場表示";
  host.className="race-all-grid";
  if(!cards.length){
    host.innerHTML='<div class="empty-card">本日の競馬開催情報を取得中</div>';
  }else{
    let html=cards.map(function(x){
      return x.kind==="jra"?jraVenueCard(x.venue):localVenueCard(x.venue);
    }).join("");
    const hasSpare=(cards.length%4)!==0;
    if(hasSpare&&featured.length) html+=featuredRaceCard(featured);
    host.innerHTML=html;
  }
  updateMarquees();
  setupFeaturedRaceScroll(true);
  setupAllVerticalScrolls(true);
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
setInterval(stepAllVerticalScrolls,80);
const SCREEN_ORDER=["keirin","race","boat"];
setInterval(function(){
  const i=SCREEN_ORDER.indexOf(screenMode);
  showScreen(SCREEN_ORDER[(i+1)%SCREEN_ORDER.length]);
},20000);
showScreen("keirin");
