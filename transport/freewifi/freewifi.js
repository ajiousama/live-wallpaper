(() => {
  const companyPc = document.documentElement.classList.contains('company-pc');

  // Web/FreeWiFi: eight transport screens + cinema + gamble.
  // Workplace PC: transport and cinema only; do not load or rotate into gamble.
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
  const cinemaPage = {id:'cinema-screen', cinema:true, duration:30000, title:'映画上映案内（5館）'};
  const shiftPage = {id:'shift-screen', shift:true, duration:30000, title:'勤務予定・本日／翌日'};
  const rawPages = companyPc
    ? [...transportPages,cinemaPage,shiftPage]
    : [...transportPages,cinemaPage,{id:'gamble-screen', gamble:true, duration:20000, title:'ギャンブル'}];
  const pages = rawPages.map((p,i)=>({...p,label:`${String(i+1).padStart(2,'0')} / ${String(rawPages.length).padStart(2,'0')}　${p.title}`}));

  const TRANSPORT_IDS = ['panel-rail','panel-air','panel-bus','panel-port'];
  const gambleScreen = document.getElementById('gamble-screen');
  const gambleFrame = document.getElementById('gamble-frame');
  const shiftScreen = document.getElementById('shift-screen');
  const cinemaScreen = document.getElementById('cinema-screen');
  const cinemaFrame = document.getElementById('cinema-frame');
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

    // The large hero title must follow the ACTUAL visible board, not the
    // initial HTML placeholder. JR north/south are both departures.
    const heroDirection = document.querySelector('.transport-hero-title h1 span');
    if(heroDirection && !page.cinema && !page.gamble){
      const inbound = page.id !== 'panel-rail' && page.mode === 1;
      heroDirection.textContent = inbound ? 'ARRIVALS' : 'DEPARTURES';
    }

    TRANSPORT_IDS.forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.classList.toggle('freewifi-active', !page.gamble && id === page.id);
    });

    if(cinemaScreen){
      cinemaScreen.hidden = !page.cinema;
      cinemaScreen.classList.toggle('freewifi-active', !!page.cinema);
      if(page.cinema && cinemaFrame){
        try { cinemaFrame.contentWindow?.postMessage({type:'cinema-page-active'},location.origin); } catch(e) {}
      }
    }
    if(shiftScreen){
      shiftScreen.hidden = !page.shift;
      shiftScreen.classList.toggle('freewifi-active', !!page.shift);
    }
    if(gambleScreen){
      gambleScreen.hidden = !page.gamble;
      gambleScreen.classList.toggle('freewifi-active', !!page.gamble);
    }

    const isAir = page.id === 'panel-air' && !page.gamble;
    document.body.classList.toggle('air-board-page', isAir);
    document.body.classList.toggle('air-board-arrival', isAir && page.mode === 1);

    if(!page.gamble && !page.cinema && !page.shift){
      const controller = ui();
      if(controller && typeof controller.setMode === 'function'){
        // The transport renderer may fail on one record. Never allow that
        // exception to cancel the workplace wallpaper's page rotation.
        try {
          controller.setMode(page.mode, page.duration);
        } catch (error) {
          console.warn('Transport renderer failed; rotation continues', error);
        }
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
    // Expose a separate heartbeat for the inline watchdog: cinema lasts 30s,
    // so do not use a fixed 20-second "stuck" threshold.
    document.documentElement.dataset.companyPageIndex = String(pageIndex);
    document.documentElement.dataset.companyPageDue = String(nextPageAt);
    document.documentElement.dataset.companyPageChanged = String(Date.now());
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
  // Lively's WebView may throttle or drop a long setTimeout after sleeping.
  // This independent clock check restores page switching, even when the
  // queued timeout was lost. A hidden/resumed WebView advances one page.
  setInterval(()=>{
    if(Date.now() > nextPageAt + 1250) showPage(pageIndex + 1);
  }, 1000);
  window.addEventListener('pageshow',()=>{
    if(Date.now() > nextPageAt + 1250) showPage(pageIndex + 1);
  });

  // Optional Lively ZIP shell heartbeat. A local wrapper can reload only a
  // genuinely stalled embedded page without relying on WebView navigation.
  if(companyPc && window.parent !== window){
    const pulse=()=>{
      try{
        window.parent.postMessage({
          source:'matsuyama-lively-workplace',
          type:'page-heartbeat',
          index:pageIndex,
          deadline:nextPageAt,
          timestamp:Date.now()
        },'*');
      }catch(e){}
    };
    pulse();
    setInterval(pulse,5000);
  }
})();