(() => {
  const pages = [
    {id:'panel-rail', label:'01 / 04　JR 松山駅'},
    {id:'panel-air',  label:'02 / 04　松山空港'},
    {id:'panel-bus',  label:'03 / 04　高速・中距離バス'},
    {id:'panel-port', label:'04 / 04　フェリー'}
  ];
  const PAGE_MS = 10000;
  const status=document.getElementById('freewifi-page-status');
  let pageIndex=0;
  let nextPageAt=Date.now()+PAGE_MS;

  function showPage(index){
    pageIndex=(index+pages.length)%pages.length;
    pages.forEach((p,i)=>{
      const el=document.getElementById(p.id);
      if(el) el.classList.toggle('freewifi-active',i===pageIndex);
    });
    if(status) status.textContent=pages[pageIndex].label;
    nextPageAt=Date.now()+PAGE_MS;
  }

  function updatePageCountdown(){
    if(!status) return;
    const left=Math.max(0,Math.ceil((nextPageAt-Date.now())/1000));
    status.textContent=`${pages[pageIndex].label}　｜　次画面まで ${left}秒`;
  }

  showPage(0);
  setInterval(()=>showPage(pageIndex+1),PAGE_MS);
  setInterval(updatePageCountdown,1000);
})();