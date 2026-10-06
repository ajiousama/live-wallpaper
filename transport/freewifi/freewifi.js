(() => {
  const pages = [
    {id:'panel-rail', label:'01 / 04　JR 松山駅'},
    {id:'panel-air',  label:'02 / 04　松山空港'},
    {id:'panel-bus',  label:'03 / 04　高速・中距離バス'},
    {id:'panel-port', label:'04 / 04　フェリー'}
  ];

  // One mode for 10 seconds. Pages with two modes therefore stay 20 seconds.
  // phase 0 = departure / south, phase 1 = arrival / north.
  const MODE_MS = 10000;
  const PAGE_MS = MODE_MS * 2;

  const status = document.getElementById('freewifi-page-status');
  let pageIndex = 0;
  let phase = 0;
  let nextPhaseAt = Date.now() + MODE_MS;
  let nextPageAt = Date.now() + PAGE_MS;
  let phaseTimer = null;

  function ui(){
    return window.MATSUYAMA_TRANSPORT_UI || null;
  }

  function applyMode(){
    const controller = ui();
    if(controller && typeof controller.setMode === 'function'){
      controller.setMode(phase, MODE_MS);
    }
  }

  function showPage(index, resetMode = true){
    pageIndex = (index + pages.length) % pages.length;
    pages.forEach((p,i)=>{
      const el = document.getElementById(p.id);
      if(el) el.classList.toggle('freewifi-active', i === pageIndex);
    });

    if(resetMode){
      phase = 0;
      applyMode();
    }

    const now = Date.now();
    nextPhaseAt = now + MODE_MS;
    nextPageAt = now + (phase === 0 ? PAGE_MS : MODE_MS);
    updatePageCountdown();
  }

  function advancePhase(){
    if(phase === 0){
      // Stay on the same page and show the second mode.
      phase = 1;
      applyMode();
      nextPhaseAt = Date.now() + MODE_MS;
      nextPageAt = nextPhaseAt;
    } else {
      // Both modes were shown. Move to the next page and always start with departures/south.
      showPage(pageIndex + 1, true);
    }
    scheduleNextPhase();
  }

  function scheduleNextPhase(){
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(advancePhase, Math.max(0, nextPhaseAt - Date.now()));
  }

  function updatePageCountdown(){
    if(!status) return;
    const left = Math.max(0, Math.ceil((nextPageAt - Date.now()) / 1000));
    status.textContent = `${pages[pageIndex].label}　｜　次画面まで ${left}秒`;
  }

  showPage(0, true);
  scheduleNextPhase();
  setInterval(updatePageCountdown, 1000);
})();