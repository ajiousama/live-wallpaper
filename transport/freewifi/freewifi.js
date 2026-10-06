(() => {
  // Eight independent 10-second screens.
  // No nested mode timer: each logical screen explicitly selects its own mode.
  const pages = [
    {id:'panel-rail', mode:0, label:'01 / 08　JR 松山駅　宇和島方面'},
    {id:'panel-rail', mode:1, label:'02 / 08　JR 松山駅　今治方面'},
    {id:'panel-air',  mode:0, label:'03 / 08　松山空港　出発'},
    {id:'panel-air',  mode:1, label:'04 / 08　松山空港　到着'},
    {id:'panel-bus',  mode:0, label:'05 / 08　高速・中距離バス　出発'},
    {id:'panel-bus',  mode:1, label:'06 / 08　高速・中距離バス　到着'},
    {id:'panel-port', mode:0, label:'07 / 08　フェリー　出航'},
    {id:'panel-port', mode:1, label:'08 / 08　フェリー　到着'}
  ];

  const PANEL_IDS = ['panel-rail','panel-air','panel-bus','panel-port'];
  const PAGE_MS = 10000;
  const status = document.getElementById('freewifi-page-status');

  let pageIndex = 0;
  let nextPageAt = Date.now() + PAGE_MS;
  let pageTimer = null;

  function ui(){
    return window.MATSUYAMA_TRANSPORT_UI || null;
  }

  function showPage(index){
    pageIndex = (index + pages.length) % pages.length;
    const page = pages[pageIndex];

    PANEL_IDS.forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.classList.toggle('freewifi-active', id === page.id);
    });

    const controller = ui();
    if(controller && typeof controller.setMode === 'function'){
      controller.setMode(page.mode, PAGE_MS);
    }

    nextPageAt = Date.now() + PAGE_MS;
    updatePageCountdown();
    scheduleNextPage();
  }

  function scheduleNextPage(){
    clearTimeout(pageTimer);
    pageTimer = setTimeout(
      ()=>showPage(pageIndex + 1),
      Math.max(0, nextPageAt - Date.now())
    );
  }

  function updatePageCountdown(){
    if(!status) return;
    const left = Math.max(0, Math.ceil((nextPageAt - Date.now()) / 1000));
    status.textContent = `${pages[pageIndex].label}　｜　次画面まで ${left}秒`;
  }

  showPage(0);
  setInterval(updatePageCountdown, 1000);
})();