function tickClock(){
  const now=new Date();
  document.getElementById("clock").textContent=
    new Intl.DateTimeFormat("ja-JP",{hour:"2-digit",minute:"2-digit",hour12:false}).format(now);
}

function setVenueHeader(index,venue){
  const th=document.getElementById("venue-"+(index+1));
  const name=th.querySelector(".venue-name");
  const count=th.querySelector(".venue-count");
  if(!venue){
    th.classList.add("is-empty");
    name.textContent="---";
    count.textContent="";
    return;
  }
  th.classList.remove("is-empty");
  name.textContent=venue.name||"---";
  const finished=(venue.results||[]).filter(x=>x.jockey).length;
  count.textContent=finished+"/12";
}

async function loadData(){
  const tbody=document.querySelector("#board tbody");
  try{
    const r=await fetch("data.json?t="+Date.now(),{cache:"no-store"});
    if(!r.ok) throw new Error(r.status);
    const data=await r.json();
    const venues=data.venues||[];

    document.getElementById("date-title").textContent=(data.date_label||"JRA")+" 勝利騎手一覧";
    document.getElementById("meeting-title").textContent=venues.length?venues.map(v=>v.name).join("・"):"開催情報取得中";
    document.getElementById("updated").textContent="更新 "+(data.updated_at||"--");

    const completed=venues.reduce((n,v)=>n+(v.results||[]).filter(x=>x.jockey).length,0);
    const total=Math.max(venues.length,1)*12;
    document.getElementById("progress-label").textContent="CONFIRMED "+completed+" / "+total;

    for(let i=0;i<3;i++) setVenueHeader(i,venues[i]);

    tbody.replaceChildren();
    for(let race=1;race<=12;race++){
      const tr=document.createElement("tr");
      const rcell=document.createElement("td");
      rcell.textContent=String(race).padStart(2,"0")+"R";
      tr.appendChild(rcell);

      for(let i=0;i<3;i++){
        const td=document.createElement("td");
        const venue=venues[i];
        if(!venue){
          td.className="is-empty";
          tr.appendChild(td);
          continue;
        }

        const item=(venue.results||[]).find(x=>x.race===race);
        if(item?.jockey){
          td.className="done";

          const jockey=document.createElement("div");
          jockey.className="jockey";
          jockey.textContent=item.jockey;
          td.appendChild(jockey);

          const horse=document.createElement("span");
          horse.className="horse";
          horse.textContent=item.horse||"";
          td.appendChild(horse);
        }else{
          td.className="pending";
          td.textContent="----";
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }catch(e){
    document.getElementById("meeting-title").textContent="データ取得エラー";
    document.getElementById("progress-label").textContent="OFFLINE";
  }
}

tickClock();
setInterval(tickClock,1000);
loadData();
setInterval(loadData,60000);
