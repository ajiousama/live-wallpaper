const demo={
  date_label:"2026年9月26日（土曜）",
  venues:[
    {
      name:"中山",
      races:Array.from({length:12},(_,i)=>({
        r:i+1,
        payouts:{
          "単勝":[[String([6,8,3,2,11,5,7,4,10,9,2,6][i]),["420円","560円","290円","380円","740円","340円","210円","310円","260円","480円","340円","520円"][i]]],
          "複勝":[["6","170円"],["3","220円"],["10","180円"]],
          "枠連":[["3-5","1,150円"]],
          "ワイド":[["6-10","510円"],["3-6","680円"],["3-10","740円"]],
          "馬連":[["6-10","1,320円"]],
          "馬単":[["6→10","2,530円"]],
          "3連複":[["3-6-10","3,480円"]],
          "3連単":[["6→10→3","16,920円"]]
        }
      }))
    },
    {
      name:"阪神",
      races:Array.from({length:12},(_,i)=>({
        r:i+1,
        payouts:{
          "単勝":[[String([3,7,5,9,4,8,2,6,11,1,7,5][i]),["310円","460円","280円","620円","350円","410円","290円","530円","680円","260円","470円","390円"][i]]],
          "複勝":[["3","150円"],["8","190円"],["12","240円"]],
          "枠連":[["2-5","720円"]],
          "ワイド":[["3-8","410円"],["3-12","590円"],["8-12","760円"]],
          "馬連":[["3-8","980円"]],
          "馬単":[["3→8","1,780円"]],
          "3連複":[["3-8-12","2,960円"]],
          "3連単":[["3→8→12","14,520円"]]
        }
      }))
    }
  ]
};

let venueIndex=0;
const order=["単勝","複勝","枠連","ワイド","馬連","馬単","3連複","3連単"];

function payoutBlock(payouts){
  return '<div class="payout">'+order.map(type=>{
    const items=payouts?.[type]||[];
    const html=items.length
      ? '<div class="line">'+items.map(x=>'<span class="item"><span class="num">'+x[0]+'</span><span class="yen">'+x[1]+'</span></span>').join('')+'</div>'
      : '<span class="empty">—</span>';
    return '<dl><dt>'+type+'</dt><dd>'+html+'</dd></dl>';
  }).join('')+'</div>';
}

function render(){
  document.getElementById("date-label").textContent=demo.date_label;

  const tabs=document.getElementById("venue-tabs");
  tabs.replaceChildren();
  demo.venues.forEach((v,i)=>{
    const b=document.createElement("button");
    b.className="venue-tab"+(i===venueIndex?" active":"");
    b.textContent=v.name;
    b.onclick=()=>{venueIndex=i;render()};
    tabs.appendChild(b);
  });

  const venue=demo.venues[venueIndex];
  document.getElementById("race-list").innerHTML=venue.races.map(r=>`
    <article class="race-block">
      <div class="race-head">
        <strong>${venue.name} ${r.r}R</strong>
        <span>払戻金</span>
      </div>
      ${payoutBlock(r.payouts)}
    </article>
  `).join("");
}

render();
