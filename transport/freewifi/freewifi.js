(() => {
  const companyPc = document.documentElement.classList.contains('company-pc');

  // Web/FreeWiFi: eight transport screens + gamble.
  // Workplace PC: transport only; do not load or rotate into gamble.
  const transportPages = [
    {id:'panel-rail', mode:0, duration:15000, title:'JR 松山駅　宇和島方面'},
    {id:'panel-rail', mode:1, duration:15000, title:'JR 松山駅　今治方面'},
    {id:'panel-air',  mode:0, duration:15000, title:'松山空港　出発'},
    {id:'panel-air',  mode:1, duration:15000, title:'松山空港　到着'},
    {id:'panel-bus',  mode:0, duration:15000, title:'高速・中距離バス　出発'},
    {id:'panel-bus',  mode:1, duration:15000, title:'高速・中距離バス　到着'},
    {id:'panel-port', mode:0, duration:15000, title:'フェリー　出航'},
    {id:'panel-port', mode:1, duration:15000, title:'フェリー　到着'}
  ];
  const rawPages = companyPc
    ? transportPages
    : [...transportPages,{id:'gamble-screen', gamble:true, duration:20000, title:'ギャンブル'}];
  const pages = rawPages.map((p,i)=>({...p,label:`${String(i+1).padStart(2,'0')} / ${String(rawPages.length).padStart(2,'0')}　${p.title}`}));

  const TRANSPORT_IDS = ['panel-rail','panel-air','panel-bus','panel-port'];
  const gambleScreen = document.getElementById('gamble-screen');
  const gambleFrame = document.getElementById('gamble-frame');
  const status = document.getElementById('freewifi-page-status');
  const webPrev = document.getElementById('web-page-prev');
  const webNext = document.getElementById('web-page-next');



  // Workplace PC does not use gamble at all; avoid loading the iframe.
  if(companyPc){
    if(gambleFrame){
      gambleFrame.removeAttribute('src');
      gambleFrame.src = 'about:blank';
    }
    if(gambleScreen) gambleScreen.hidden = true;
  }

  let pageIndex = 0;
  let nextPageAt = Date.now() + pages[0].duration;
  let pageTimer = null;

  function ui(){
    return window.MATSUYAMA_TRANSPORT_UI || null;
  }

  function showPage(index){
    pageIndex = (index + pages.length) % pages.length;
    const page = pages[pageIndex];

    TRANSPORT_IDS.forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.classList.toggle('freewifi-active', !page.gamble && id === page.id);
    });

    if(gambleScreen){
      gambleScreen.hidden = !page.gamble;
      gambleScreen.classList.toggle('freewifi-active', !!page.gamble);
    }

    const isAir = page.id === 'panel-air' && !page.gamble;
    document.body.classList.toggle('air-board-page', isAir);
    document.body.classList.toggle('air-board-arrival', isAir && page.mode === 1);

    if(!page.gamble){
      const controller = ui();
      if(controller && typeof controller.setMode === 'function'){
        controller.setMode(page.mode, page.duration);
      }
    }

    if(isAir){
      requestAnimationFrame(()=>{
        const rows=[...document.querySelectorAll('#air-rows .air-board-row')];
        rows.forEach((row,i)=>{
          row.classList.remove('air-flip-in');
          row.style.setProperty('--air-flip-delay', `${i*42}ms`);
          void row.offsetWidth;
          row.classList.add('air-flip-in');
        });
      });
    }

    nextPageAt = Date.now() + page.duration;
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
    const page = pages[pageIndex];
    const left = Math.max(0, Math.ceil((nextPageAt - Date.now()) / 1000));
    status.textContent = `${page.label}　｜　次画面まで ${left}秒`;
  }

  if(webPrev) webPrev.addEventListener('click', ()=>showPage(pageIndex - 1));
  if(webNext) webNext.addEventListener('click', ()=>showPage(pageIndex + 1));

  showPage(0);
  setInterval(updatePageCountdown, 1000);
})();