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
  let pageStartedAt = Date.now();
  let pageTimer = null;
  let testPagePicker = null;

  function ui(){
    return window.MATSUYAMA_TRANSPORT_UI || null;
  }

  // Direction is owned by the existing two JR pages, not by the LED itself.
  // Message-based switching keeps both original board engines alive without
  // reloading the simulator every 15 seconds.
  const jrArrivalFrame=document.getElementById('jr-led-frame-arr');
  function syncJrLed(page){
    if(page?.id!=='panel-rail')return;
    const dir=page.mode===1?'north':'south';
    for(const frame of [jrLedFrame,jrArrivalFrame]){
      try {
        frame?.contentWindow?.postMessage(
          {type:'matsuyama-led-direction',dir},location.origin
        );
      } catch(e) { console.warn('JR LED direction sync failed',e); }
    }
  }
  for(const frame of [jrLedFrame,jrArrivalFrame]){
    frame?.addEventListener('load',()=>syncJrLed(pages[pageIndex]));
  }

  // Measure rendered text rather than the character count. A 15-second
  // display is a minimum, not a deadline that cuts off longer itineraries.
  // Keep the scroll speed stable and extend the CURRENT page when necessary.
  let observedScrolls = new WeakMap();
  let scrollPageToken = 0;

  function scanFullTickerCycles() {
    const page=pages[pageIndex];
    if(!page || page.cinema || page.shift || page.gamble) return;
    const panel=document.getElementById(page.id);
    if(!panel || !panel.classList.contains('freewifi-active')) return;
    const activeRoot=[panel];
    const globalAlert=document.getElementById('top-live-alert');
    if(globalAlert && globalAlert.classList.contains('active'))activeRoot.push(globalAlert);
    let extensionNeeded=false;

    function checkTrack(track,signature,durationSeconds,property,value,restart) {
      if(!(durationSeconds>0) || !Number.isFinite(durationSeconds))return;
      const previous=observedScrolls.get(track);
      if(property && track.style.getPropertyValue(property)!==value)
        track.style.setProperty(property,value);
      // Re-entering a transport screen must NOT restart an existing ticker.
      // Only changed text in a previously observed DOM node may restart.
      if(previous===signature)return;
      observedScrolls.set(track,signature);
      if(restart && previous!==undefined){
        track.style.setProperty('animation','none','important');
        void track.offsetWidth;
        track.style.removeProperty('animation');
      }
      if(!autoRotationPaused){
        // A JR train list can have several cyclic six-row pages. Each new
        // set has new animation nodes: without a cap, every 12s page flip
        // adds another 60s and traps the entire wallpaper on JR forever.
        // Give ample time to read, but guarantee the NEXT transport page.
        const railPages=page.id==='panel-rail'
          ?Math.min(40,Math.max(1,Number(panel.dataset.railLoopPages)||1)):1;
        const limit=pageStartedAt+Math.max(180000,railPages*12000+30000);
        const minimumEnd=Math.min(limit,Date.now()+Math.ceil(durationSeconds*1000)+400);
        if(minimumEnd>nextPageAt){
          nextPageAt=minimumEnd;
          extensionNeeded=true;
        }
      }
    }
    for(const root of activeRoot){
      root.querySelectorAll('.marquee-track').forEach(track=>{
        const first=track.firstElementChild;
        const box=track.closest('.marquee');
        if(!first || !box || box.clientWidth<1)return;
        const width=Math.ceil(first.scrollWidth);
        if(width<=0)return;
        // The first entire copy travels left, including its trailing margin.
        const seconds=Math.max(12,width/40);
        const duration=seconds.toFixed(2)+'s';
        const signature=first.textContent+'|'+width+'|'+box.clientWidth;
        // The top live alert is shared between screens; do not reset it
        // when the lower board changes.
        checkTrack(track,signature,seconds,'--ticker-duration',duration,
                   !track.closest('#top-live-alert'));
      });
      root.querySelectorAll('.overflow-scroll.is-overflow > .overflow-scroll-track').forEach(track=>{
        const box=track.closest('.overflow-scroll');
        const copy=track.querySelector('.overflow-scroll-copy:not(.overflow-scroll-clone)');
        if(!copy || !box || box.clientWidth<1)return;
        const distance=Math.ceil(copy.scrollWidth+32);
        const seconds=Math.max(box.classList.contains('port-guidance-scroll')?12:9,distance/28);
        const duration=seconds.toFixed(1)+'s';
        const signature=copy.textContent+'|'+distance+'|'+box.clientWidth;
        if(box.style.getPropertyValue('--overflow-duration')!==duration)
          box.style.setProperty('--overflow-duration',duration);
        checkTrack(track,signature,seconds,null,null,true);
      });
      root.querySelectorAll('.air-bottom-scroll-track:not(.air-bottom-ended)').forEach(track=>{
        const first=track.querySelector('.air-bottom-scroll-set');
        const box=track.closest('.air-bottom-scroll');
        if(!first || !box || box.clientWidth<1)return;
        const distance=Math.ceil(first.scrollWidth);
        const seconds=Math.max(12,distance/32);
        const duration=seconds.toFixed(2)+'s';
        const signature=first.textContent+'|'+distance+'|'+box.clientWidth;
        checkTrack(track,signature,seconds,'--airport-scroll-duration',duration,true);
      });
    }
    // Include all JR six-row pages in the visible direction before leaving
    // Matsuyama. A 15s page otherwise shows page two for ~3s and drops every
    // subsequent train even though their ticker animations are looped.
    if(page.id==='panel-rail'){
      const total=Math.min(40,Math.max(1,Number(panel.dataset.railLoopPages)||1));
      const end=pageStartedAt+Math.max(page.duration,total*12000+750);
      if(!autoRotationPaused && end>nextPageAt){
        nextPageAt=end;
        extensionNeeded=true;
      }
    }
    if(extensionNeeded){
      document.documentElement.dataset.companyPageDue=String(nextPageAt);
      updatePageCountdown();
      scheduleNextPage();
    }
  }
  function watchVisibleScrolls(){
    // Wait for the transport renderer, image logos and layout to settle.
    const token=scrollPageToken;
    requestAnimationFrame(()=>{
      if(token!==scrollPageToken)return;
      scanFullTickerCycles();
      setTimeout(()=>{if(token===scrollPageToken)scanFullTickerCycles();},220);
    });
  }

  function showPage(index){
    pageStartedAt=Date.now();
    pageIndex = (index + pages.length) % pages.length;
    scrollPageToken++;
    observedScrolls = new WeakMap();
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
    watchVisibleScrolls();
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
    // Primary earthquake control stays at the top; users should not need to
    // scroll the 350px-wide panel before reaching the emergency test.
    const emergencyQuick=document.createElement('button');
    emergencyQuick.id='workplace-test-emergency-quick';
    emergencyQuick.type='button';
    emergencyQuick.textContent='🚨 緊急地震速報の訓練を表示';
    emergencyQuick.style.cssText='display:block;width:100%;margin:4px 0 8px;padding:12px 8px;background:#a52b31;color:#fff;border:2px solid #ffda87;border-radius:7px;font:bold 15px sans-serif;cursor:pointer';
    emergencyQuick.addEventListener('click',()=>{
      const current=ui()?.getTestDisaster?.();
      setDisaster(current?'':'eew');
      emergencyQuick.textContent=current?'🚨 緊急地震速報の訓練を表示':'■ 緊急訓練を終了';
    });
    panel.append(emergencyQuick);
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

    const section=(caption)=>{
      const h=document.createElement('div');
      h.textContent=caption;
      h.style.cssText='font-weight:900;border-top:1px solid #516a7b;padding-top:9px;margin-top:12px;color:#ffdf92';
      panel.append(h);
    };
    const testStatus=document.createElement('div');
    testStatus.style.cssText='font-size:12px;line-height:1.5;margin:5px 0;padding:5px;background:#173044;border-radius:5px;color:#b8edff';
    const testClock=window.MATSUYAMA_TEST_CLOCK;
    section('🕒 日付・時刻シミュレーション（日本時間）');
    const clockInput=document.createElement('input');
    clockInput.id='workplace-test-datetime';
    clockInput.type='datetime-local';
    clockInput.step='60';
    clockInput.setAttribute('aria-label','テスト用の日時（日本時間）');
    clockInput.style.cssText='display:block;width:100%;min-width:0;padding:8px;margin-top:8px;box-sizing:border-box;background:white;color:#141923;font:700 16px sans-serif';
    clockInput.value=testClock?.input?.()||'';
    panel.append(clockInput);
    const speedSelect=document.createElement('select');
    speedSelect.id='workplace-test-speed';
    speedSelect.style.cssText='width:100%;margin-top:7px;padding:7px;background:white;color:#141923;font:700 13px sans-serif';
    [[0,'時刻を固定（停止）'],[1,'実時間と同じ速さ'],[60,'60倍速（1秒で1分）'],[3600,'3600倍速（1秒で1時間）']].forEach(([value,label])=>{
      const option=document.createElement('option');option.value=String(value);option.textContent=label;speedSelect.append(option);
    });
    speedSelect.value=String(testClock?.speed?.()??0);
    panel.append(speedSelect);
    panel.append(testStatus);
    function showClockStatus(message){
      const current=testClock?.input?.()?.replace('T',' ')||'取得不可';
      const rate=testClock?.hasOverride?.() ? testClock.speed() : '現在';
      testStatus.textContent=(message?message+' ｜ ':'')+'模擬日時：'+current+'（'+rate+(rate==='現在'?'':'倍速')+'）';
    }
    function syncClockInput(message){
      if(testClock?.input) clockInput.value=testClock.input();
      showClockStatus(message);
    }
    makeButton('指定日時を反映',()=>{
      if(!testClock?.set?.(clockInput.value,Number(speedSelect.value))){
        showClockStatus('日時が正しくありません');return;
      }
      syncClockInput('適用済み');
    });
    for(const [label,mins] of [['−1日',-1440],['＋1日',1440],['−1時間',-60],['＋1時間',60],['−10分',-10],['＋10分',10],['−1分',-1],['＋1分',1]]){
      makeButton(label,()=>{
        if(testClock?.step?.(mins))syncClockInput('変更済み');
      });
    }
    speedSelect.addEventListener('change',()=>{
      if(testClock?.rate?.(Number(speedSelect.value)))syncClockInput('再生速度を変更');
    });
    makeButton('現在の日時に戻す',()=>{
      if(testClock?.reset?.()){
        speedSelect.value='1';
        syncClockInput('実際の現在時刻');
      }
    });
    showClockStatus();

    section('⚠ 緊急モード（訓練専用）');
    const disasterStatus=document.createElement('div');
    disasterStatus.style.cssText='font-size:12px;padding:5px;color:#ffe2a3';
    disasterStatus.textContent='下のボタンで訓練画面を直接表示';
    panel.append(disasterStatus);
    function setDisaster(kind){
      const currentController=ui();
      let changed=false;
      try{changed=!!currentController?.setTestDisaster?.(kind);}
      catch(err){console.error('Training emergency display failed',err);}
      const overlay=document.getElementById('disaster-overlay');
      if(changed && overlay){
        // Extra protection for embedded Lively and delayed CSS: a training
        // overlay may not remain behind other pages or hidden by old CSS.
        if(kind){
          overlay.hidden=false;
          overlay.style.setProperty('display','block','important');
          overlay.style.setProperty('z-index','1000','important');
        }else{
          overlay.style.removeProperty('display');
          overlay.style.removeProperty('z-index');
        }
      }
      emergencyQuick.textContent=kind?'■ 緊急訓練を終了':'🚨 緊急地震速報の訓練を表示';
      if(!changed||!overlay || (kind && (overlay.hidden || getComputedStyle(overlay).display==='none'))){
        disasterStatus.textContent='表示を確認できません。もう一度押すか再読み込みしてください。';
        return;
      }
      disasterStatus.textContent=kind ? '【訓練表示中】'+({eew:'緊急地震速報',tsunami:'津波警報',weather:'気象警報',summary:'地震情報',all:'全画面ローテーション'}[kind]||kind)
        +'／警報音は緊急画面内のボタンを押すと再生':'緊急訓練を終了';
    }
    makeButton('🚨 緊急地震速報を表示',()=>setDisaster('eew'));
    makeButton('🌊 津波警報を表示',()=>setDisaster('tsunami'));
    makeButton('☔ 気象警報を表示',()=>setDisaster('weather'));
    makeButton('⚠ 地震情報を表示',()=>setDisaster('summary'));
    makeButton('全種類を20秒ごとに切替',()=>setDisaster('all'));
    makeButton('緊急モードを終了',()=>setDisaster(''));
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
    note.textContent='日時変更はこのテスト画面のみ。警報表示は訓練で、本番の防災情報やPC時計を変更しません。';
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
  setInterval(()=>{
    scanFullTickerCycles();
    updatePageCountdown();
  }, 1000);
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