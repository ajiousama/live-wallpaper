const demo={
  date_label:"9月26日 土曜",
  venues:[
    {
      name:"中山",
      races:[
        {r:1,tan:"6  420円",fuku:["6 170円","3 220円","10 180円"],waku:"3-5 1,150円",umaren:"6-10 1,320円",wide:["6-10 510円","3-6 680円","3-10 740円"],umatan:"6→10 2,530円",sanpuku:"3-6-10 3,480円",santan:"6→10→3 16,920円"},
        {r:2,tan:"8  560円",fuku:["8 210円","12 150円","5 320円"],waku:"4-6 890円",umaren:"8-12 1,020円",wide:["8-12 430円","5-8 1,260円","5-12 780円"],umatan:"8→12 2,460円",sanpuku:"5-8-12 5,720円",santan:"8→12→5 29,410円"},
        {r:3,tan:"3  290円",fuku:["3 130円","7 180円","11 240円"],waku:"2-4 520円",umaren:"3-7 760円",wide:["3-7 340円","3-11 560円","7-11 710円"],umatan:"3→7 1,220円",sanpuku:"3-7-11 2,140円",santan:"3→7→11 8,630円"},
        {r:4,tan:"2  380円",fuku:["2 160円","9 250円","4 190円"],waku:"2-7 1,040円",umaren:"2-9 1,560円",wide:["2-9 620円","2-4 480円","4-9 930円"],umatan:"2→9 2,970円",sanpuku:"2-4-9 3,860円",santan:"2→9→4 18,550円"},
        {r:5,tan:"11  740円",fuku:["11 270円","1 180円","6 210円"],waku:"1-7 1,420円",umaren:"1-11 2,310円",wide:["1-11 840円","6-11 990円","1-6 610円"],umatan:"11→1 5,060円",sanpuku:"1-6-11 4,380円",santan:"11→1→6 31,620円"},
        {r:6,tan:"5  340円",fuku:["5 150円","2 190円","9 280円"],waku:"2-4 680円",umaren:"2-5 910円",wide:["2-5 390円","5-9 740円","2-9 960円"],umatan:"5→2 1,650円",sanpuku:"2-5-9 3,070円",santan:"5→2→9 12,840円"},
        {r:7,tan:"7  210円",fuku:["7 120円","1 170円","10 260円"],waku:"1-5 430円",umaren:"1-7 620円",wide:["1-7 280円","7-10 530円","1-10 810円"],umatan:"7→1 930円",sanpuku:"1-7-10 1,760円",santan:"7→1→10 5,990円"},
        {r:8,tan:"4  310円",fuku:["4 140円","8 180円","12 220円"],waku:"3-6 610円",umaren:"4-8 790円",wide:["4-8 350円","4-12 510円","8-12 690円"],umatan:"4→8 1,330円",sanpuku:"4-8-12 2,020円",santan:"4→8→12 7,880円"},
        {r:9,tan:"10  260円",fuku:["10 130円","6 160円","2 290円"],waku:"5-6 470円",umaren:"6-10 650円",wide:["6-10 300円","2-10 610円","2-6 880円"],umatan:"10→6 1,020円",sanpuku:"2-6-10 2,410円",santan:"10→6→2 8,960円"},
        {r:10,tan:"9  480円",fuku:["9 190円","3 150円","13 310円"],waku:"2-6 760円",umaren:"3-9 980円",wide:["3-9 420円","9-13 1,120円","3-13 850円"],umatan:"9→3 2,090円",sanpuku:"3-9-13 4,970円",santan:"9→3→13 24,180円"},
        {r:11,tan:"2  340円",fuku:["2 140円","3 180円","8 160円"],waku:"2-3 580円",umaren:"2-3 830円",wide:["2-3 380円","2-8 370円","3-8 620円"],umatan:"2→3 1,420円",sanpuku:"2-3-8 1,770円",santan:"2→3→8 9,860円"},
        {r:12,tan:"6  520円",fuku:["6 200円","1 170円","9 240円"],waku:"1-5 990円",umaren:"1-6 1,260円",wide:["1-6 500円","6-9 820円","1-9 690円"],umatan:"6→1 2,780円",sanpuku:"1-6-9 3,540円",santan:"6→1→9 17,630円"}
      ]
    },
    {
      name:"阪神",
      races:Array.from({length:12},(_,i)=>({
        r:i+1,
        tan:["3 310円","7 460円","5 280円","9 620円"][i%4],
        fuku:["3 150円","8 190円","12 240円"],
        waku:"2-5 720円",umaren:"3-8 980円",
        wide:["3-8 410円","3-12 590円","8-12 760円"],
        umatan:"3→8 1,780円",sanpuku:"3-8-12 2,960円",santan:"3→8→12 14,520円"
      }))
    }
  ]
};

let venueIndex=0;

function clock(){
  document.getElementById("clock").textContent=new Intl.DateTimeFormat("ja-JP",{hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date());
}

function moneyCell(text){
  if(!text) return '<span class="empty">—</span>';
  const parts=String(text).match(/^(.*?)([0-9,]+円)$/);
  if(!parts) return text;
  return '<span class="num">'+parts[1].trim()+'</span> <span class="yen">'+parts[2]+'</span>';
}

function multiCell(items){
  if(!items?.length) return '<span class="empty">—</span>';
  return '<div class="multi">'+items.map(x=>'<span>'+moneyCell(x)+'</span>').join('')+'</div>';
}

function render(){
  document.getElementById("title").textContent=demo.date_label+" 払戻一覧";
  const tabs=document.getElementById("venue-tabs");
  tabs.replaceChildren();
  demo.venues.forEach((v,i)=>{
    const b=document.createElement("div");
    b.className="venue-tab"+(i===venueIndex?" active":"");
    b.textContent=v.name;
    b.onclick=()=>{venueIndex=i;render()};
    tabs.appendChild(b);
  });

  const venue=demo.venues[venueIndex];
  document.getElementById("venue-label").textContent=venue.name+"競馬";
  const tbody=document.querySelector("#payout-board tbody");
  tbody.replaceChildren();

  venue.races.forEach(x=>{
    const tr=document.createElement("tr");
    const cells=[
      x.r+"R",moneyCell(x.tan),multiCell(x.fuku),moneyCell(x.waku),
      moneyCell(x.umaren),multiCell(x.wide),moneyCell(x.umatan),
      moneyCell(x.sanpuku),moneyCell(x.santan)
    ];
    cells.forEach((html,i)=>{
      const td=document.createElement("td");
      if(i===0) td.textContent=html;
      else td.innerHTML=html;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

clock();setInterval(clock,1000);render();
