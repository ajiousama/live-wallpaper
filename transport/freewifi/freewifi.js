(() => {
  const companyPc = document.documentElement.classList.contains('company-pc');
  // Isolated workplace preview: only enabled with the explicit ?test=1 flag.
  const testMode = companyPc && new URLSearchParams(location.search).get('test') === '1';
  // Temporary pause requested for the workplace R15 wallpaper only.
  // Flip to false to restore automatic page rotation later.
  const PAUSE_WORKPLACE_PAGE_ROTATION = true;
  const autoRotationPaused = companyPc && (PAUSE_WORKPLACE_PAGE_ROTATION || testMode);
  const pausedPageKey = testMode ? 'matsuyama-workplace-test-page' : 'matsuyama-workplace-paused-page';

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
  const cinemaPage = {id:'cinema-screen', cinema:true, duration:30000, title:'映画・プラネタリウム（映画6館＋2施設）'};
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
  const jrLedFrame = document.getElementById('jr-led-frame');



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
  let testPagePicker = null;

  function ui(){
    return window.MATSUYAMA_TRANSPORT_UI || null;
  }

  // Direction is owned by the existing two JR pages, not by the LED itself.
  // Message-based switching keeps both original board engines alive without
  // reloading the simulator every 15 seconds.
  function syncJrLed(page){
    if(!jrLedFrame || page?.id!=='panel-rail')return;
    const dir=page.mode===1?'north':'south';
    try {
      jrLedFrame.contentWindow?.postMessage(
        {type:'matsuyama-led-direction',dir},location.origin
      );
    } catch(e) { console.warn('JR LED direction sync failed',e); }
  }
  if(jrLedFrame)jrLedFrame.addEventListener('load',()=>{
    syncJrLed(pages[pageIndex]);
  });

  function showPage(index){
    pageIndex = (index + pages.length) % pages.length;
    const page = pages[pageIndex];
    if(testPagePicker) testPagePicker.value = String(pageIndex);
    if(autoRotationPaused && !testMode){
      try { sessionStorage.setItem(pausedPageKey, String(pageIndex)); } catch(e) {}
    }

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

    syncJrLed(page);
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

    // A far-future deadline also prevents legacy R15 / Lively watchdogs
    // from interpreting an intentional pause as a stalled page.
    nextPageAt = autoRotationPaused ? Number.MAX_SAFE_INTEGER : Date.now() + page.duration;
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
    if(autoRotationPaused) return;
    pageTimer = setTimeout(
      ()=>showPage(pageIndex + 1),
      Math.max(0, nextPageAt - Date.now())
    );
  }

  function updatePageCountdown(){
    if(!status) return;
    const page = pages[pageIndex];
    if(autoRotationPaused){
      status.textContent = testMode ? `${page.label}　｜　TEST MODE・手動切替` : `${page.label}　｜　自動切替停止中`;
      return;
    }
    const left = Math.max(0, Math.ceil((nextPageAt - Date.now()) / 1000));
    status.textContent = `${page.label}　｜　次画面まで ${left}秒`;
  }

  // One shared pager: inside the cinema, browse its movie pages first.
  // On the first/last movie page, the same button moves to the adjacent main screen.
  function sharedPageStep(delta){
    if(pages[pageIndex]?.cinema && cinemaFrame?.contentWindow){
      cinemaFrame.contentWindow.postMessage({type:'cinema-page-step',delta},location.origin);
      // Give a manually selected movie page a full rotation interval.
      nextPageAt=autoRotationPaused ? Number.MAX_SAFE_INTEGER : Date.now()+pages[pageIndex].duration;
      document.documentElement.dataset.companyPageDue=String(nextPageAt);
      updatePageCountdown();
      scheduleNextPage();
      return;
    }
    showPage(pageIndex+delta);
  }
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin ||
       event.source!==cinemaFrame?.contentWindow ||
       event.data?.type!=='cinema-page-boundary')return;
    if(!pages[pageIndex]?.cinema)return;
    showPage(pageIndex+(event.data.delta===-1?-1:1));
  });
  if(webPrev) webPrev.addEventListener('click', ()=>sharedPageStep(-1));
  if(webNext) webNext.addEventListener('click', ()=>sharedPageStep(1));

  let initialPage = 0;
  if(testMode){
    const requested = Number(new URLSearchParams(location.search).get('testPage'));
    if(Number.isInteger(requested) && requested >= 0 && requested < pages.length){
      initialPage = requested;
    }
  } else if(autoRotationPaused){
    try {
      const saved = Number(sessionStorage.getItem(pausedPageKey));
      if(Number.isInteger(saved) && saved >= 0 && saved < pages.length) initialPage = saved;
    } catch(e) {}
  }
  // Embedded dedicated test dashboard provides its own toolbar; do not duplicate it.
  // This compact control remains available when ?pc=1&test=1 is opened directly.
  // Only the dedicated test dashboard has its own outer toolbar.
  // Lively can embed the workplace wallpaper in an iframe, too; its controls
  // must still appear when test=1 is selected from the actual wallpaper.
  const dedicatedTestShell = new URLSearchParams(location.search).get('testShell') === '1';
  if(testMode && !dedicatedTestShell){
    const wall=document.getElementById('wall');
    const panel=document.createElement('aside');
    panel.id='workplace-test-panel';
    panel.setAttribute('aria-label','職場壁紙テスト操作');
    // The original position:fixed on <body> landed OVER desktop icons in Lively.
    // Position the tools relative to the real zoomed #wall, not the desktop.
    panel.style.cssText='position:absolute;z-index:1002000;left:14px;top:90px;width:350px;max-width:calc(100% - 28px);max-height:calc(100% - 112px);overflow:auto;background:#071923;color:white;padding:12px;border:2px solid #ffcf55;border-radius:10px;font:14px sans-serif;box-shadow:0 5px 30px #000b;pointer-events:auto';
    const heading=document.createElement('strong');
    heading.textContent='職場壁紙 TEST MODE（本番データ変更なし）';
    panel.append(heading,document.createElement('hr'));
    const picker=document.createElement('select');
    picker.setAttribute('aria-label','表示する画面');
    picker.style.cssText='width:100%;padding:8px;background:#fff;color:#111';
    pages.forEach((p,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=p.title;picker.append(o);});
    picker.value=String(initialPage);
    testPagePicker=picker;
    picker.addEventListener('change',()=>showPage(Number(picker.value)));
    panel.append(picker);
    const makeButton=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='margin:7px 4px 0 0;padding:7px;cursor:pointer';b.addEventListener('click',fn);panel.append(b);return b;};
    makeButton('前の画面',()=>showPage(pageIndex-1));
    makeButton('次の画面',()=>showPage(pageIndex+1));
    makeButton('本番へ戻る',()=>{
      const u=new URL(location.href);
      u.searchParams.delete('test');
      u.searchParams.delete('testPage');
      u.searchParams.delete('disasterTest');
      u.searchParams.delete('testShell');
      location.assign(u.href);
    });
    const reveal=document.createElement('button');
    reveal.type='button';
    reveal.id='workplace-test-panel-reveal';
    reveal.textContent='☰ テスト操作を表示';
    reveal.setAttribute('aria-label','テスト操作パネルを再表示');
    reveal.style.cssText='position:absolute;top:90px;left:14px;z-index:1002000;padding:10px 15px;background:#19384e;color:#fff;border:2px solid #ffcf55;border-radius:8px;display:none;cursor:pointer;pointer-events:auto;font:bold 15px sans-serif';
    makeButton('操作パネルを隠す',()=>{
      panel.style.display='none';
      reveal.style.display='block';
    });
    reveal.addEventListener('click',()=>{
      panel.style.display='block';
      reveal.style.display='none';
    });
    const note=document.createElement('div');
    note.style.cssText='margin-top:8px;font-size:12px;color:#ffdf92';
    note.textContent='テスト中は手動切替。実際の緊急速報は発信しません。';
    panel.append(note);
    // Both surfaces belong to #wall, not the OS desktop background.
    (wall || document.body).append(panel,reveal);
    document.documentElement.dataset.workplaceTestMode='1';
  }
  // Make the live build ID the entry/exit point, without a separate site.
  const versionToggle = document.getElementById('company-pc-test-toggle');
  if(companyPc && versionToggle){
    versionToggle.textContent = testMode ? '↩ 通常表示へ' : '🧪 テストモード';
    versionToggle.setAttribute('aria-label',
      testMode ? 'テストモードを終了して職場壁紙へ戻る' : '職場壁紙のテストモードを起動');
    versionToggle.title = testMode ? '通常の職場壁紙へ戻る' : 'この職場壁紙でテストモードを開始';
    if(!dedicatedTestShell){
      versionToggle.addEventListener('click',()=>{
        const url = new URL(location.href);
        if(testMode){
          url.searchParams.delete('test');
          url.searchParams.delete('testPage');
          url.searchParams.delete('disasterTest');
        }else{
          url.searchParams.set('pc','1');
          url.searchParams.set('test','1');
          url.searchParams.set('testPage',String(pageIndex));
          url.searchParams.delete('testShell');
        }
        // A fresh navigation also works through the legacy R15 Lively wrapper.
        url.searchParams.set('_mode_switch',String(Date.now()));
        location.replace(url.href);
      });
    }else{
      // The dedicated test dashboard already owns the control panel.
      versionToggle.hidden = true;
      versionToggle.style.setProperty('display','none','important');
    }
  }
  showPage(initialPage);
  setInterval(updatePageCountdown, 1000);
  // Lively's WebView may throttle or drop a long setTimeout after sleeping.
  // This independent clock check restores page switching, even when the
  // queued timeout was lost. A hidden/resumed WebView advances one page.
  setInterval(()=>{
    if(!autoRotationPaused && Date.now() > nextPageAt + 1250) showPage(pageIndex + 1);
  }, 1000);
  window.addEventListener('pageshow',()=>{
    if(!autoRotationPaused && Date.now() > nextPageAt + 1250) showPage(pageIndex + 1);
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