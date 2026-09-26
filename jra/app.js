async function loadData(){
  const tbody=document.querySelector("#board tbody");
  try{
    const r=await fetch("data.json?t="+Date.now(),{cache:"no-store"});
    if(!r.ok) throw new Error(r.status);
    const data=await r.json();

    document.getElementById("date-title").textContent=(data.date_label||"JRA")+" 勝利騎手一覧";
    document.getElementById("meeting-title").textContent=(data.venues||[]).map(v=>v.name).join("　");
    document.getElementById("updated").textContent="更新: "+(data.updated_at||"--");

    for(let i=0;i<3;i++){
      document.getElementById("venue-"+(i+1)).textContent=data.venues?.[i]?.name||"---";
    }

    tbody.replaceChildren();
    for(let race=1;race<=12;race++){
      const tr=document.createElement("tr");
      const rcell=document.createElement("td");
      rcell.textContent=race+"R";
      tr.appendChild(rcell);

      for(let i=0;i<3;i++){
        const td=document.createElement("td");
        const venue=data.venues?.[i];
        const item=venue?.results?.find(x=>x.race===race);
        if(item?.jockey){
          td.className="done";
          const jockey=document.createElement("div");
          jockey.textContent=item.jockey;
          td.appendChild(jockey);
          if(item.horse){
            const horse=document.createElement("span");
            horse.className="horse";
            horse.textContent=item.horse;
            td.appendChild(horse);
          }
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
  }
}
loadData();
setInterval(loadData,60000);
