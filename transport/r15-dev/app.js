(() => {
  // Compatibility path for the original Matsuyama_Transport_R15 Lively
  // wallpaper. If a cached legacy R15 HTML loads this newer app.js, exit
  // that old 4-screen UI and open the maintained workplace display directly.
  if (/\/transport\/r15-dev\/(?:index\.html|departures\.html)?$/.test(location.pathname)
      && !document.body.classList.contains('freewifi-tv')) {
    const target=new URL('../freewifi/',location.href);
    target.searchParams.set('pc','1');
    target.searchParams.set('lively','1');
    target.searchParams.set('_legacy_refresh',String(Date.now()));
    location.replace(target.href);
    return;
  }
  const data = window.MATSUYAMA_DATA;
  const $ = (id) => document.getElementById(id);
  const FREEWIFI_TV = document.body.classList.contains('freewifi-tv');

  // A per-view virtual clock. Only enabled by explicit workplace ?test=1.
  // No system clock, live feeds, browser storage, or normal-wallpaper state is altered.
  const workplaceTestEnabled = FREEWIFI_TV &&
    document.documentElement.classList.contains('company-pc') &&
    new URLSearchParams(location.search).get('test') === '1';
  const clockQuery = new URLSearchParams(location.search);
  const realClockNow = () => Date.now();
  const clockPad = value => String(value).padStart(2,'0');
  const clockInputFromMs = ms => {
    const date=new Date(ms+9*3600000);
    return date.getUTCFullYear()+'-'+clockPad(date.getUTCMonth()+1)+'-'+
      clockPad(date.getUTCDate())+'T'+clockPad(date.getUTCHours())+':'+
      clockPad(date.getUTCMinutes());
  };
  function parseTestClockInput(raw) {
    const str=String(raw||'').trim();
    if(!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(str))return null;
    const ms=Date.parse(str+':00+09:00');
    return Number.isFinite(ms) && clockInputFromMs(ms)===str ? ms : null;
  }
  const testClockSpeeds = new Set([0,1,60,3600]);
  let testClockAnchor = workplaceTestEnabled ? parseTestClockInput(clockQuery.get('testAt')) : null;
  let testClockRealAnchor = realClockNow();
  let testClockSpeed = testClockAnchor!==null && testClockSpeeds.has(Number(clockQuery.get('testSpeed')))
    ? Number(clockQuery.get('testSpeed')) : 0;
  function effectiveClockMs() {
    return workplaceTestEnabled && testClockAnchor!==null
      ? testClockAnchor+(realClockNow()-testClockRealAnchor)*testClockSpeed
      : realClockNow();
  }
  const testClockChanged=()=>window.dispatchEvent(new Event('matsuyama-test-clock-changed'));
  const workplaceTestClock = Object.freeze({
    enabled:workplaceTestEnabled,
    nowMs:effectiveClockMs,
    hasOverride:()=>workplaceTestEnabled && testClockAnchor!==null,
    input:()=>clockInputFromMs(effectiveClockMs()),
    speed:()=>testClockAnchor===null?1:testClockSpeed,
    set(raw,speed=0){
      if(!workplaceTestEnabled)return false;
      const ms=parseTestClockInput(raw),rate=Number(speed);
      if(ms===null||!testClockSpeeds.has(rate))return false;
      testClockAnchor=ms;testClockRealAnchor=realClockNow();testClockSpeed=rate;
      testClockChanged();return true;
    },
    step(minutes){
      if(!workplaceTestEnabled||!Number.isFinite(minutes)||Math.abs(minutes)>525600)return false;
      testClockAnchor=effectiveClockMs()+Math.round(minutes)*60000;
      testClockRealAnchor=realClockNow();
      testClockChanged();return true;
    },
    rate(speed){
      if(!workplaceTestEnabled||!testClockSpeeds.has(Number(speed)))return false;
      testClockAnchor=effectiveClockMs();
      testClockRealAnchor=realClockNow();testClockSpeed=Number(speed);
      testClockChanged();return true;
    },
    reset(){
      if(!workplaceTestEnabled)return false;
      testClockAnchor=null;testClockRealAnchor=realClockNow();testClockSpeed=0;
      testClockChanged();return true;
    }
  });
  window.MATSUYAMA_TEST_CLOCK=workplaceTestClock;
  let testDisasterKind = workplaceTestEnabled && clockQuery.get('disasterTest')==='1' ? 'eew' : '';
  let testDisasterArrivalMs = effectiveClockMs()+18000;
  const CURRENT_BUILD = document.documentElement.dataset.build || '';
  const DEPLOY_CHECK_MS = document.documentElement.classList.contains('company-pc') ? 10000 : 60000;

  async function checkDeployment() {
    try {
      const r = await fetch('../../deploy-version.json?t=' + Date.now(), { cache:'no-store' });
      if (!r.ok) return;
      const x = await r.json();
      const next = String(x.build || '');
      if (next && CURRENT_BUILD && CURRENT_BUILD !== '__BUILD_ID__' && next !== CURRENT_BUILD) {
        const u = new URL(location.href);
        u.searchParams.set('v', next);
        if(document.documentElement.classList.contains('company-pc')){
          u.searchParams.set('pc','1');
          u.searchParams.set('_reload',String(Date.now()));
        }
        location.replace(u.toString());
      }
    } catch(e) {}
  }

  const state = {
    modeIndex: 0, // 0 departure / south, 1 arrival / north
    noteIndex: { rail: 0, air: 0, bus: 0, port: 0 }
  };

  const MODE_SWITCH_MS = 15000;
  let nextModeSwitchAt = Date.now() + MODE_SWITCH_MS;

  function updateModeCountdown() {
    const el=$('mode-countdown');
    if(!el) return;
    const left=Math.max(0,Math.ceil((nextModeSwitchAt-Date.now())/1000));
    el.textContent=`表示切替まで あと${left}秒`;
  }

  // FINAL: workplace PC performs only lightweight JSON reads.
  // Heavy parsing (JR positions, Iyotetsu bus-location HTML, airport/ferry/highway status,
  // and disaster feeds) is done by the Supabase Edge Function.
  const APPROACH_API_URL = 'https://ihhiymkepuydykrhmzwo.supabase.co/functions/v1/approach';
  const approachLive = { ok:false, ichitsubo:null, madonna:null, generatedAtJst:'', lastError:'' };
  const slowLive = { ok:false, airport:null, ferry:null, highway:null, generatedAtJst:'', lastError:'' };
  const disasterLive = { ok:false, data:null, generatedAtJst:'', lastError:'' };

  function fetchLiveScope(scope) {
    return fetch(`${APPROACH_API_URL}?scope=${scope}&t=${Date.now()}`, { cache:'no-store' })
      .then(r => { if (!r.ok) throw new Error(`${scope} HTTP ${r.status}`); return r.json(); });
  }
  function loadApproach() {
    return fetchLiveScope('fast').then(json => {
      approachLive.ok=!!json?.ok; approachLive.ichitsubo=json?.ichitsubo||null; approachLive.madonna=json?.madonna||null;
      approachLive.generatedAtJst=String(json?.generatedAtJst||''); approachLive.lastError=''; return json;
    }).catch(err => { approachLive.ok=false; approachLive.ichitsubo=null; approachLive.madonna=null; approachLive.lastError=String(err); return null; });
  }
  function loadSlowLive() {
    return fetchLiveScope('slow').then(json => {
      slowLive.ok=!!json?.ok; slowLive.airport=json?.airport||null; slowLive.ferry=json?.ferry||null; slowLive.highway=json?.highway||null;
      slowLive.generatedAtJst=String(json?.generatedAtJst||''); slowLive.lastError=''; return json;
    }).catch(err => { slowLive.ok=false; slowLive.lastError=String(err); return null; });
  }
  function loadDisasterLive() {
    return fetchLiveScope('disaster').then(json => {
      disasterLive.ok=!!json?.ok; disasterLive.data=json?.disaster||null; disasterLive.generatedAtJst=String(json?.generatedAtJst||''); disasterLive.lastError=''; return json;
    }).catch(err => { disasterLive.ok=false; disasterLive.lastError=String(err); return null; });
  }

  function cleanStation(name) {
    const station=String(name||'').replace(/（.*?）/g,'').replace(/予告窓/g,'').trim();
    // 波方 is a station name, not the generic directional suffix 「方」.
    return station==='波方'?station:station.replace(/方$/g,'').trim();
  }

  function japanNow() {
    const now = new Date(effectiveClockMs());
    const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const y = jst.getFullYear();
    const m = String(jst.getMonth() + 1).padStart(2, '0');
    const d = String(jst.getDate()).padStart(2, '0');
    const hh = String(jst.getHours()).padStart(2, '0');
    const mm = String(jst.getMinutes()).padStart(2, '0');
    const ss = String(jst.getSeconds()).padStart(2, '0');
    const wd = '日月火水木金土'[jst.getDay()];
    return { date: `${y}.${m}.${d} ${wd}`, time: `${hh}:${mm}`, sec: ss, iso: `${y}-${m}-${d}`, month: `${y}-${m}`, minutes: Number(hh) * 60 + Number(mm), dow: jst.getDay() };
  }

  function toMinutes(t) {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  }
  function addMinutes(t, delta) {
    const total = (toMinutes(t) + delta + 1440 * 10) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  function minutesUntil(time, nowMinutes) { return toMinutes(time) - nowMinutes; }
  function isDepartSoon(record, now) {
    const d = minutesUntil(record.time, now.minutes);
    return d >= 0 && d <= 3;
  }
  function validRecord(r, iso) {
    // If the monthly aviation data has expired, keep the last verified recurring
    // timetable visible as a clearly dated fallback until the user updates it.
    const verifiedMonth = data.verifiedMonth || String(data.checked || '').slice(0,7);
    const staleAirFallback = r.board === 'air' && verifiedMonth && iso.slice(0,7) > verifiedMonth && !Array.isArray(r.dates);
    if (r.start && iso < r.start) return false;
    if (r.end && iso > r.end && !staleAirFallback) return false;
    if (Array.isArray(r.exclude) && r.exclude.includes(iso)) return false;
    if (Array.isArray(r.dates) && !r.dates.includes(iso)) return false;
    if (Array.isArray(r.days)) {
      const dow = new Date(`${iso}T12:00:00+09:00`).getDay();
      if (!r.days.includes(dow)) return false;
    }
    return true;
  }
  function effectiveTime(r, now) {
    if (r.timeByDow && Object.prototype.hasOwnProperty.call(r.timeByDow, String(now.dow))) return r.timeByDow[String(now.dow)];
    return r.time;
  }
  function shiftIso(iso, deltaDays) {
    const [y,m,d]=String(iso).split('-').map(Number);
    const dt=new Date(Date.UTC(y,m-1,d+deltaDays));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
  }
  function dayContext(iso) {
    return { iso, dow:new Date(`${iso}T12:00:00+09:00`).getDay() };
  }
  function firstServiceMinuteFor(board, iso, predicate) {
    const ctx = dayContext(iso);
    const rows = data.records
      .filter(r => r.board === board && validRecord(r, iso))
      .map(r => ({ ...r, time: effectiveTime(r, ctx) }))
      .filter(r => !predicate || predicate(r));
    if (!rows.length) return null;
    return Math.min(...rows.map(r => toMinutes(r.time)));
  }
  // JR, buses and aviation roll over at 04:30 JST, never at midnight.
  // Do not preview the next operating day's services overnight.
  const TRANSPORT_DAY_START_MINUTE = 4 * 60 + 30;
  function boardDisplayIso(board, now) {
    if (board !== 'rail' && board !== 'air' && board !== 'bus') return now.iso;
    return now.minutes < TRANSPORT_DAY_START_MINUTE ? shiftIso(now.iso,-1) : now.iso;
  }
  function recordsForDay(board, iso) {
    const ctx=dayContext(iso);
    return data.records.filter(r=>r.board===board && validRecord(r,iso)).map(r=>({...r,time:effectiveTime(r,ctx)}));
  }
  // Position data is authoritative; a diagram or timetable by itself is not.
  function jrPositionUsable(pos) {
    const p=cleanStation(pos);
    return !!p && !/^(?:-|—|不明|未取得|取得中|確認中|データなし|位置情報なし)$/.test(p);
  }
  function jrPositionFeedFresh() {
    const ts=Date.parse(String(approachLive.generatedAtJst||''));
    const age=Date.now()-ts;
    return approachLive.ok && approachLive.ichitsubo?.ok === true &&
      Number.isFinite(ts) && age>=-15000 && age<=45000;
  }
  function liveRailPassengerRows(rows,now) {
    if(workplaceTestClock.hasOverride())return []; // Never label a virtual departure as live.
    if(!jrPositionFeedFresh() || boardDisplayIso('rail',now)!==now.iso) return [];
    const specialNums=new Set((approachLive.ichitsubo?.matsuyamaSpecialTrains||[]).map(x=>String(x.trainNum||'')));
    const active=Array.isArray(approachLive.ichitsubo?.matsuyamaActiveTrains)
      ? approachLive.ichitsubo.matsuyamaActiveTrains.filter(x=>
          x && String(x.trainNum||'').trim() && !specialNums.has(String(x.trainNum||'')) && jrPositionUsable(x.position))
      : [];
    const taken=new Set();
    return rows.flatMap(r=>{
      const matched=active.filter(x=>{
        if(String(x.direction||'')!==String(r.direction||''))return false;
        if(padTime(x.departure||'')!==padTime(r.time||''))return false;
        const limited=String(x.trainClass||'')==='limited';
        if((r.kind==='limited')!==limited)return false;
        if(limited){
          const label=railLiveTrainLabel(x);
          if(label.kind!=='limited'||label.service!==r.service)return false;
        }
        return true;
      });
      // If multiple live trains share a time/class, do not guess their identity.
      if(matched.length!==1)return [];
      const train=matched[0],number=String(train.trainNum);
      if(taken.has(number))return [];
      taken.add(number);
      return [{...r,liveTrainNum:number,livePosition:cleanStation(train.position),
        liveDelayMinutes:Number(train.delayMinutes)||0,
        vehicleImageNorth:String(train.vehicleImageNorth||r.vehicleImageNorth||''),
        vehicleImageSouth:String(train.vehicleImageSouth||r.vehicleImageSouth||''),
        vehicleImageSource:String(train.vehicleImageSource||r.vehicleImageSource||'')}];
    });
  }
  function currentDirection() { return state.modeIndex % 2 === 0 ? 'departure' : 'arrival'; }
  function currentRailDir() { return state.modeIndex % 2 === 0 ? 'south' : 'north'; }

  function parseAirService(service) {
    const m = String(service).match(/^(.+?)\s+(\d+)$/);
    if (!m) return { airline: service, number: '' };
    const airlineMap = {
      JAL: 'JAL', ANA: 'ANA', IBX: 'IBEXエアラインズ', IBEX: 'IBEXエアラインズ', JJP: 'Jetstar', GK: 'Jetstar', '7C': 'チェジュ航空', JJA: 'チェジュ航空', BR: 'エバー航空', EVA: 'エバー航空', BX: 'エアプサン', MH: 'マレーシア航空'
    };
    return { airline: airlineMap[m[1]] || m[1], number: m[2] };
  }

  // These are immutable, user-approved logo originals committed in this repo.
  // The per-image Git blob version prevents browsers from reusing a stale image
  // after the old external-download build. Do not rename, restyle or replace.
  const AIR_LOGO_BASE=new URL('../assets/airlines/', document.currentScript?.src || location.href).href;
  const APPROVED_AIR_LOGO_VERSIONS=Object.freeze({
    'ana.svg':'f094ed18d5b0',
    'jal.png':'29be9bc653fb',
    'ibex.png':'ea370c058a3e',
    'jetstar.svg':'af2327e0cb3c',
    'jeju.svg':'9bbf717d0fc0',
    'air-busan.svg':'9d19b10577f5',
    'asiana.svg':'b0fe336c87c0',
    'eva.svg':'44b644a6646f'
  });
  const airLogoAsset=(name)=>{
    const version=APPROVED_AIR_LOGO_VERSIONS[name];
    if(!version) throw new Error('Unapproved airline logo: '+name);
    return AIR_LOGO_BASE+name+'?original='+version;
  };

  function airlineMiniLogo(airline) {
    const raw=String(airline||'').trim();
    const a=raw.toUpperCase();

    const logo=(cls,label,src,fallback)=>`<span class="air-mini-logo ${cls}" aria-label="${label}"><span class="air-logo-fallback">${fallback}</span><img src="${src}" alt="${label}" loading="eager" referrerpolicy="no-referrer" onerror="this.remove()"></span>`;

    // Use the same logo artwork that Matsuyama Airport publishes on its flight page
    // whenever that artwork is available.
    if(a==='ANA') return logo('air-mini-logo-ana','ANA',
      airLogoAsset('ana.svg'),'ANA');
    if(a==='JAL') return logo('air-mini-logo-jal','JAL',
      airLogoAsset('jal.png'),'JAL');
    if(/IBEX/.test(a)) return logo('air-mini-logo-ibex','IBEXエアラインズ',
      airLogoAsset('ibex.png'),'IBEX');
    if(/ジェットスター|JETSTAR/.test(a)) return logo('air-mini-logo-jetstar','ジェットスター・ジャパン',
      airLogoAsset('jetstar.svg'),'Jetstar');
    if(/チェジュ|JEJU/.test(raw)) return logo('air-mini-logo-jeju','チェジュ航空',
      airLogoAsset('jeju.svg'),'JEJUair');
    if(/エアプサン|AIR BUSAN/.test(raw)) return logo('air-mini-logo-busan','エアプサン',
      airLogoAsset('air-busan.svg'),'AIR BUSAN');
    if(/アシアナ|ASIANA/.test(raw)) return logo('air-mini-logo-asiana','アシアナ航空',
      airLogoAsset('asiana.svg'),'ASIANA');
    if(/エバー|EVA/.test(raw)) return logo('air-mini-logo-eva','エバー航空',
      airLogoAsset('eva.svg'),'EVA AIR');
    return '';
  }

  const JETSTAR_JAL_CODESHARE = {
    '400':'6110','401':'6111','404':'6114','405':'6115','408':'6112','409':'6119'
  };

  function airServiceItems(r,p) {
    let nums=Array.isArray(r?.liveRaw?.numbers) ? r.liveRaw.numbers.map(String).filter(Boolean) : [];
    if(!nums.length) nums=[String(p.number||'')].filter(Boolean);

    // Preserve known codeshares only for static fallback. When the official live
    // endpoint supplies flight numbers, display exactly what it publishes.
    const hasLiveNumbers=Array.isArray(r?.liveRaw?.numbers);
    if(!hasLiveNumbers && nums.length===1){
      const n=nums[0];
      if(/IBEX/i.test(p.airline) && /^3[3-8]$/.test(n)) nums.push(`31${n}`);
      if(/Jetstar/i.test(p.airline) && JETSTAR_JAL_CODESHARE[n]) nums.push(JETSTAR_JAL_CODESHARE[n]);
      if(/エアプサン|AIR BUSAN/i.test(p.airline) && n==='133') nums.push('9593');
      if(/エアプサン|AIR BUSAN/i.test(p.airline) && n==='134') nums.push('9594');
    }

    return nums.map((number,index)=>{
      let airline=p.airline;
      if(index>0){
        if(/^313[3-8]$/.test(number)) airline='ANA';
        else if(/^611\d$/.test(number)) airline='JAL';
        else if(/^959[34]$/.test(number)) airline='アシアナ航空';
      }
      return {airline,number};
    });
  }

  function airServiceHtml(r,p) {
    // Keep the board readable: show the operating flight + at most one codeshare.
    const items=airServiceItems(r,p).slice(0,2);
    return items.map((item,index)=>{
      const logo=airlineMiniLogo(item.airline) || `<span class="airline-text-logo">${item.airline}</span>`;
      return `<span class="air-service-brand${index?' codeshare-brand':''}">${logo}<span class="air-flight-no">${item.number||'—'}</span></span>`;
    }).join('<span class="air-codeshare-sep">/</span>');
  }


  function padTime(t) {
    const m=String(t||'').match(/^(\d{1,2}):(\d{2})$/); return m ? `${String(Number(m[1])).padStart(2,'0')}:${m[2]}` : String(t||'');
  }
  function arrivalOriginDeparted(item,now) {
    // Arrival times and changed times are schedules, not evidence of departure.
    const status=String(item?.status||'').trim();
    if(/欠航|運休|取消|キャンセル/.test(status) || /欠航/.test(String(item?.originDepartureStatus||''))) return false;
    // Ground-truth departure status from the origin airport's official board.
    // Accept only a fresh, date-matched independent report.
    const originObserved=Date.parse(String(item?.originDepartedObservedAt||''));
    const originAge=Date.now()-originObserved;
    const trustedOfficialSources=new Set([
      '大阪国際空港公式出発案内',
      '鹿児島空港公式出発案内',
      '那覇空港公式出発案内',
      '中部国際空港公式出発案内',
      '福岡空港公式出発案内',
      '桃園国際空港公式出発案内',
      '金海国際空港公式出発案内'
    ]);
    const verifiedAirportDeparted=item?.originDepartureVerified===true &&
      item?.originDepartureStatus==='出発済み' &&
      trustedOfficialSources.has(String(item?.originDepartureSource||'')) &&
      Number.isFinite(originObserved) && originAge>=-15000 && originAge<=150000;
    if(verifiedAirportDeparted)return true;
    // Matsuyama Airport's own confirmed approach/landing statuses also
    // prove that the flight has already departed its origin.
    // '定刻', '遅れ' and future arrival times do not.
    if(/まもなく到着|ただいま到着|着陸済み|到着済み/.test(status)) {
      const arr=padTime(item?.changed||item?.scheduled||'');
      const minutesToArrival=/^\d{2}:\d{2}$/.test(arr)?toMinutes(arr)-now.minutes:Infinity;
      // An old completion tag mistakenly attached to a future flight is not proof.
      if(minutesToArrival<=15 && minutesToArrival>=-180) return true;
    }
    const statusConfirmed=/(?:出発済み|離陸済み|出発地から出発|出発地を出発|出発空港を出発)/.test(status);
    const actual=padTime(item?.originDepartureActual||'');
    const actualConfirmed=item?.originDepartureConfirmed===true && /^\d{2}:\d{2}$/.test(actual);
    // ADS-B is direct position evidence, including an aircraft waiting on
    // the origin airport's ground. This does not assert it has departed.
    const phase=String(item?.aircraftFlightPhase||'');
    const observation=Date.parse(String(item?.aircraftObservedAt||''));
    const age=Date.now()-observation;
    const positionFresh=item?.aircraftPositionConfirmed===true &&
      /^[A-Z]{3}[0-9]+[A-Z]?$/.test(String(item?.aircraftCallsign||'')) &&
      Number.isFinite(observation) && age>=-15000 && age<=105000;
    if(positionFresh && phase==='waiting')return false;
    if(positionFresh && /^(airborne|approaching)$/.test(phase))return true;
    if(/出発前|搭乗中|搭乗手続|出発待/.test(status))return false;
    if(!statusConfirmed && !actualConfirmed) return false;
    if(actualConfirmed && toMinutes(actual)>now.minutes+1) return false;
    return true;
  }
  // Remember when an official arrival-complete state was first observed.
  // The public airport feed often lacks an actual block-in timestamp.
  const arrivedFlightObservedAt=new Map();
  function arrivalCompletionTime(item,key,now) {
    const clock=padTime(item.actualArrivalTime||item.actualArrival||item.arrivedAt||'');
    const complete=/到着済み|ただいま到着|到着完了/.test(String(item.status||''));
    if(!complete) { arrivedFlightObservedAt.delete(key); return null; }
    if(/^([01]\\d|2[0-3]):[0-5]\\d$/.test(clock))return toMinutes(clock);
    if(!arrivedFlightObservedAt.has(key))arrivedFlightObservedAt.set(key,now.minutes);
    return arrivedFlightObservedAt.get(key);
  }
  // Public Matsuyama flight rows do not normally include a tail number.
  // Explicit aircraft/turnaround IDs win. Otherwise accept a *confirmed*
  // outbound airport-board departure only for a uniquely adjacent
  // same-carrier/same-route flight pair from the published daily timetable.
  // This is an arrival-board cleanup rule, not proof of identical airframes.
  function completedTurnaroundDeparted(arrival, departures, now) {
    if(!Array.isArray(departures)||!departures.length)return false;
    const flightClock=t=>/^\d{2}:\d{2}$/.test(t)?toMinutes(t):NaN;
    const arrivalClock=flightClock(padTime(arrival.actualArrivalTime||arrival.actualArrival||
      arrival.arrivedAt||arrival.changed||arrival.scheduled||''));
    if(!Number.isFinite(arrivalClock)||arrivalClock>now.minutes+1)return false;
    const departed=departures.filter(dep=>/出発済み|離陸済み|出発完了|離陸完了/.test(
      [dep?.status,dep?.changeText].map(v=>String(v||'')).join(' ')));
    if(!departed.length)return false;
    const arrId=String(arrival.aircraftHex||arrival.aircraftRegistration||'').trim().toUpperCase();
    const explicit=Array.isArray(arrival.turnaroundDepartureNumbers)
      ? arrival.turnaroundDepartureNumbers.map(String)
      : [arrival.turnaroundDepartureNumber].filter(Boolean).map(String);
    // Explicit linkage also works if the live page has lost the arrival-complete label.
    for(const dep of departed){
      const depId=String(dep.aircraftHex||dep.aircraftRegistration||'').trim().toUpperCase();
      const sameId=!!(arrId&&depId&&arrId===depId);
      const explicitLink=explicit.length>0 && Array.isArray(dep.numbers) &&
        explicit.some(n=>dep.numbers.map(String).includes(n));
      if(!sameId&&!explicitLink)continue;
      const depClock=flightClock(padTime(dep.actualDepartureTime||dep.actualDeparture||
        dep.changed||dep.scheduled||''));
      if(Number.isFinite(depClock)&&depClock>=arrivalClock&&depClock<=now.minutes+1)return true;
    }
    const flightRecords=data.records.filter(row=>row.board==='air' &&
      validRecord(row,now.iso));
    const matchingStatic=(item,dir)=>{
      const nums=(Array.isArray(item?.numbers)?item.numbers:[]).map(String);
      const at=padTime(item?.scheduled||'');
      const possible=flightRecords.filter(row=>row.direction===dir &&
        nums.includes(String(parseAirService(row.service).number)));
      const exact=possible.filter(row=>padTime(effectiveTime(row,now))===at);
      return exact.length===1?exact[0]:null;
    };
    const a=matchingStatic(arrival,'arrival');
    if(!a)return false;
    const signature=row=>{
      const x=String(row.service||'').trim().split(/\s+/)[0];
      const destination=String(row.dest||'').replace(/[\s（）()・]/g,'');
      return x+'|'+destination;
    };
    const route=signature(a),aMin=flightClock(padTime(effectiveTime(a,now)));
    const sameRoute=flightRecords.filter(x=>signature(x)===route);
    const inbound=sameRoute.filter(x=>x.direction==='arrival');
    const outbound=sameRoute.filter(x=>x.direction==='departure');
    const turnbackCandidate=outbound
      .filter(x=>{
        const t=flightClock(padTime(effectiveTime(x,now)));
        return t-aMin>=12&&t-aMin<=150;
      }).sort((x,y)=>flightClock(padTime(effectiveTime(x,now)))-
        flightClock(padTime(effectiveTime(y,now))))[0];
    if(!turnbackCandidate)return false;
    const depScheduled=flightClock(padTime(effectiveTime(turnbackCandidate,now)));
    // A closer arrival of this carrier/route belongs to the later departure;
    // never clear a preceding unrelated inbound flight.
    if(inbound.some(x=>{
      if(x===a)return false;
      const t=flightClock(padTime(effectiveTime(x,now)));
      return t>aMin&&t<depScheduled;
    }))return false;
    return departed.some(dep=>{
      const d=matchingStatic(dep,'departure');
      if(!d||d!==turnbackCandidate)return false;
      const depClock=flightClock(padTime(dep.actualDepartureTime||dep.actualDeparture||
        dep.changed||dep.scheduled||''));
      return Number.isFinite(depClock)&&depClock>=arrivalClock &&
        depClock<=now.minutes+1;
    });
  }
  const AIRPORT_ARRIVAL_CURFEW_MINUTES=22*60;

  function isDelayedAirportArrival(item) {
    // The official flight board must indicate a delayed arrival.
    // Mere lateness of the current clock is not evidence of delay.
    const explicit=Number(item?.deltaMinutes);
    if(Number.isFinite(explicit) && explicit>0) return true;
    const scheduled=padTime(item?.scheduled||'');
    const revised=padTime(item?.changed||'');
    if(/^\d{2}:\d{2}$/.test(scheduled) &&
       /^\d{2}:\d{2}$/.test(revised) &&
       toMinutes(revised)>toMinutes(scheduled)) return true;
    return /(?:遅延|遅れ|到着時刻変更|到着予定時刻変更)/.test(
      [item?.status,item?.changeText].map(x=>String(x||'')).join(' ')
    );
  }

  function arrivalDelayElapsedMinutes(item, now) {
    // Delay age is counted from the latest reported arrival ETA, not from
    // the original schedule. A future delayed arrival remains active.
    if(!isDelayedAirportArrival(item))return null;
    const eta=padTime(item?.changed||item?.scheduled||'');
    if(!/^\d{2}:\d{2}$/.test(eta))return null;
    let etaMinutes=toMinutes(eta);
    const scheduled=padTime(item?.scheduled||'');
    if(/^\d{2}:\d{2}$/.test(scheduled)){
      const schedMinutes=toMinutes(scheduled);
      const delta=Number(item?.deltaMinutes);
      // If the board reports delay minutes but has no distinct changed
      // clock, its effective ETA is scheduled time + reported delay.
      if(Number.isFinite(delta) && delta>0 &&
         (!item?.changed || etaMinutes===schedMinutes)){
        etaMinutes=schedMinutes+delta;
      }else if(schedMinutes>=18*60 && etaMinutes<6*60 &&
               etaMinutes<schedMinutes){
        etaMinutes+=1440;
      }
    }
    return now.minutes-etaMinutes;
  }
  function delayedArrivalNoticeExpired(item, now) {
    const elapsed=arrivalDelayElapsedMinutes(item,now);
    return elapsed!==null && elapsed>=60;
  }
  // Official same-day arrival records take priority over the 22:00 cutoff.
  function airportOfficialArrivalState(item,now) {
    const status=String(item?.status||'').trim();
    const cancelled=/欠航|運休|取消|キャンセル/.test(status+' '+String(item?.changeText||''));
    const completed=/到着済み|ただいま到着|着陸済み|到着完了/.test(status);
    const time=padTime(item?.changed||item?.scheduled||'');
    const minute=/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)?toMinutes(time):NaN;
    const since=Number.isFinite(minute)?now.minutes-minute:Infinity;
    const pendingText=/遅れ|遅延|到着予定|まもなく到着|飛行中|接近中/.test(status);
    const unfinished=!cancelled&&!completed&&Number.isFinite(since)&&since>=-240&&
      (since<=90||(pendingText&&since<=240));
    const recentlyCompleted=completed&&Number.isFinite(since)&&since>=-15&&since<=30;
    return {unfinished,recentlyCompleted,completed,cancelled};
  }
  // A freshly downloaded airport page can still contain the PREVIOUS day's
  // completed statuses during the morning rollover. Detect contradictions.
  function airportLiveHasPreviousDayStatuses(now) {
    if(boardDisplayIso('air',now)!==now.iso)return false;
    const ap=slowLive.airport;
    if(!ap?.ok)return false;
    const dm=String(ap.updatedAt||'').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if(dm){
      const officialDay=dm[1]+'-'+String(Number(dm[2])).padStart(2,'0')+'-'+String(Number(dm[3])).padStart(2,'0');
      if(officialDay!==now.iso)return true;
    }
    const flights=[
      ...(Array.isArray(ap.arrivals)?ap.arrivals.map(x=>({...x,_arr:true})):[]),
      ...(Array.isArray(ap.departures)?ap.departures.map(x=>({...x,_arr:false})):[])
    ];
    let futureCompleted=0,futureApproach=0;
    for(const item of flights){
      const t=padTime(item.scheduled||'');
      if(!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(t))continue;
      const until=toMinutes(t)-now.minutes;
      const st=String(item.status||'');
      if(until>=60&&(item._arr
        ?/到着済み|ただいま到着|着陸済み|到着完了/.test(st)
        :/出発済み|離陸済み|出発完了/.test(st)))futureCompleted++;
      if(item._arr&&until>=90&&/まもなく到着|接近中|着陸態勢/.test(st))futureApproach++;
      if(futureCompleted>=3||(futureCompleted>=1&&futureApproach>=1))return true;
    }
    return false;
  }
  function airportArrivalBoardState(now) {
    const ap=slowLive.airport;
    if(!slowLive.ok||!ap?.ok||!Array.isArray(ap.arrivals)||boardDisplayIso('air',now)!==now.iso||airportLiveHasPreviousDayStatuses(now))return 'unverified';
    const age=Date.now()-Date.parse(String(slowLive.generatedAtJst||''));
    if(!Number.isFinite(age)||age< -15000||age>150000)return 'unverified';
    const dm=String(ap.updatedAt||'').match(/([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日/);
    const day=dm?dm[1]+'-'+String(Number(dm[2])).padStart(2,'0')+'-'+String(Number(dm[3])).padStart(2,'0'):'';
    if(day&&day!==now.iso)return 'unverified';
    return ap.arrivals.some(x=>airportOfficialArrivalState(x,now).unfinished)?'pending':'complete';
  }
  function liveFlightRows(now) {
    if(workplaceTestClock.hasOverride())return null; // Simulated clock uses the published timetable.
    const dep=currentDirection()==='departure';
    if (boardDisplayIso('air', now) !== now.iso) return dep?null:[];
    const live=dep ? slowLive.airport?.departures : slowLive.airport?.arrivals;
    if (!slowLive.airport?.ok || !Array.isArray(live)) return null;
    // Until the airport source switches operational days, use today's
    // published timetable without importing yesterday's status badges.
    if(airportLiveHasPreviousDayStatuses(now))return null;
    // A stale successful fetch must never keep a historical inbound flight visible.
    const fetchAge=Date.now()-Date.parse(String(slowLive.generatedAtJst||''));
    if(!dep && (!slowLive.ok || !Number.isFinite(fetchAge) || fetchAge<-15000 || fetchAge>150000))return null;

    // LIVE側の日付が今日と一致しない時だけ静的時刻表へ戻す。
    // 「時刻だけ」で前日便を翌日扱いしないことが重要。
    const upd=String(slowLive.airport?.updatedAt||'');
    const dm=upd.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (dm) {
      const liveIso=`${dm[1]}-${String(Number(dm[2])).padStart(2,'0')}-${String(Number(dm[3])).padStart(2,'0')}`;
      if (liveIso!==now.iso) return null;
    }

    const displayIso = boardDisplayIso('air', now);
    const displayCtx = dayContext(displayIso);
    const staticRows=data.records
      .filter(r=>r.board==='air' && r.direction===(dep?'departure':'arrival') && validRecord(r,displayIso))
      .sort((a,b)=>toMinutes(effectiveTime(a,displayCtx))-toMinutes(effectiveTime(b,displayCtx)));
    const lastStaticMinute=staticRows.length?Math.max(...staticRows.map(r=>toMinutes(effectiveTime(r,displayCtx)))):null;
    const out=[];
    live.forEach(source=>{
      let x=source;
      // Guard even isolated leftovers during partial source-day rollover:
      // a 18:00 arrival cannot be 'about to arrive' at 05:06.
      if(!dep){
        const clock=padTime(x.changed||x.scheduled||'');
        const until=/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(clock)
          ?toMinutes(clock)-now.minutes:NaN;
        if(Number.isFinite(until)&&until>75 &&
           /到着済み|ただいま到着|着陸済み|まもなく到着|接近中/.test(String(x.status||'')))
          x={...x,status:'',sourceStatusUnverified:true};
      }
      // At Matsuyama Airport's 22:00 curfew, remove normal inbound flights
      // from the arrival board. Only officially delayed flights can remain.
      // The departure board is intentionally unchanged.
      const officialArrival=!dep?airportOfficialArrivalState(x,now):null;
      if(!dep && now.minutes>=AIRPORT_ARRIVAL_CURFEW_MINUTES &&
         !officialArrival.unfinished&&!officialArrival.recentlyCompleted)return;
      // A delayed arrival ceases to be an active problem once its revised
      // expected arrival time is one hour in the past.
      if(!dep && delayedArrivalNoticeExpired(x,now) &&
         !officialArrival.unfinished&&!officialArrival.recentlyCompleted)return;
      // An officially departed, uniquely matched later outbound service
      // means the earlier arrival no longer belongs on this board.
      if(!dep && completedTurnaroundDeparted(x,slowLive.airport?.departures,now))return;
      // Official Matsuyama arrivals remain visible as a FORECAST even when
      // we have not yet verified departure at the origin airport.
      // Only explicitly verified evidence can assert departure or location.
      if(!dep && /欠航|運休|取消|キャンセル/.test(
        [x.status,x.changeText,x.originDepartureStatus].map(v=>String(v||'')).join(' ')
      )) return;
      const departureVerified=!dep && arrivalOriginDeparted(x,now);
      const forecastOnly=!dep && !departureVerified;
      const nums=Array.isArray(x.numbers)?x.numbers.map(String):[];
      let r=staticRows.find(s=>nums.includes(String(parseAirService(s.service).number)) && padTime(s.time)===padTime(x.scheduled));
      if (!r) r=staticRows.find(s=>nums.includes(String(parseAirService(s.service).number)));
      if (!r) return;
      const eventTime=padTime(x.changed||x.scheduled);
      // Delayed flights can move to after midnight; use the same effective
      // revised ETA for row visibility and the one-hour expiration timer.
      const elapsedDelay=!dep?arrivalDelayElapsedMinutes(x,now):null;
      const diff=elapsedDelay!==null?-elapsedDelay:toMinutes(eventTime)-now.minutes;
      const status=String(x.status||'');
      // Airport live pages sometimes keep stale completion labels on future rows.
      // For departures/arrivals that are already completed, drop them quickly.
      // If a future flight is incorrectly tagged as completed, ignore that label.
      if (dep && /出発済み/.test(status)) {
        if (diff <= 1) return;
      }
      let arrivalAge=null;
      let arrivalCompleted=false;
      if(!dep){
        const key=`${now.iso}|${nums.join('/')}|${padTime(x.scheduled)}`;
        const completion=arrivalCompletionTime(x,key,now);
        arrivalCompleted=completion!==null;

        if(arrivalCompleted){
          arrivalAge=(now.minutes-completion+1440)%1440;
          // A stale completed state must not survive a new page load all day.
          const scheduledAge=(now.minutes-toMinutes(padTime(x.changed||x.scheduled))+1440)%1440;
          if(arrivalAge>=20 || scheduledAge>120)return;
        }
      }
      if(!arrivalCompleted && diff < (!dep && isDelayedAirportArrival(x) ? -60 : -20)) return;
      let liveStatus=status || (Number(x.deltaMinutes)===0?'定刻':'');
      if (dep && /出発済み/.test(liveStatus) && diff > 1) liveStatus='';
      if (!dep && /到着済み|ただいま到着/.test(liveStatus) && diff > 1 && !officialArrival.recentlyCompleted) liveStatus='';
      const delta=Number(x.deltaMinutes);
      if (Number.isFinite(delta) && delta>0 && (!liveStatus || /定刻/.test(liveStatus))) liveStatus=`遅れ +${delta}分`;
      if (Number.isFinite(delta) && delta<0 && (!liveStatus || /定刻/.test(liveStatus))) liveStatus=dep?`変更 ${Math.abs(delta)}分前`:`早着予定 ${Math.abs(delta)}分`;
      if(arrivalCompleted){
        liveStatus='到着済み';
      }
      if (forecastOnly && !arrivalCompleted) {
        // An adjusted airport-board arrival time is still a forecast, never
        // evidence of takeoff or a live aircraft location.
        const originalStatus=String(x.status||'').trim();
        const info=originalStatus && !/^(定刻|通常運航|通常運行)$/.test(originalStatus)
          ? `　｜　${originalStatus}` : '';
        const obsAge=Date.now()-Date.parse(String(x.aircraftObservedAt||''));
        const confirmedWaiting=x.aircraftPositionConfirmed===true &&
          x.aircraftFlightPhase==='waiting' &&
          Number.isFinite(obsAge)&&obsAge>=-15000&&obsAge<=105000;
        liveStatus=confirmedWaiting
          ? `空港地上（離陸未確認）${info}`
          : `到着見込（出発未確認）${info}`;
      }
      out.push({...r,time:padTime(x.changed),liveScheduled:padTime(x.scheduled),liveChangedTime:padTime(x.changed),liveStatus,liveDelta:delta,liveRaw:x,
        destinationArrivalScheduled:dep?padTime(x.destinationArrivalScheduled||''):'',
        arrivalForecastOnly:forecastOnly,isFinal:dep&&Number.isFinite(lastStaticMinute)&&toMinutes(effectiveTime(r,now))===lastStaticMinute,isNextDayStart:false});
    });
    out.sort((a,b)=>toMinutes(a.liveChangedTime)-toMinutes(b.liveChangedTime));
    // LIVE取得に成功して0件なら「本日終了」。誤った静的データへ戻さない。
    return out;
  }

  // Airport access times verified against the official 2026-10-01 to 2026-10-24 limousine timetable
  // and the 2026-10-01 ordinary Matsuyama Airport Line timetable.
  const LIMO_CITY_TO_AIRPORT = [
    ['06:41','07:01'],['08:25','08:45'],['08:55','09:15'],['09:25','09:45'],['09:55','10:15'],
    ['10:25','10:45'],['10:55','11:15'],['11:25','11:45'],['11:55','12:15'],['12:25','12:45'],
    ['12:55','13:15'],['13:25','13:45'],['13:55','14:15'],['14:25','14:45'],['14:55','15:15'],
    ['15:25','15:45'],['15:55','16:15'],['16:25','16:45'],['16:55','17:15'],['17:25','17:45'],
    ['17:55','18:15'],['18:25','18:45']
  ];
  const LIMO_JR_TO_AIRPORT = [
    ['06:17','06:40'],['06:25','06:40'],['07:05','07:20'],['07:17','07:40'],['07:57','08:20'],
    ['08:07','08:30'],['08:37','09:00'],['09:07','09:30'],['09:55','10:10'],['10:02','10:25'],
    ['10:12','10:35'],['10:37','11:00'],['11:17','11:40'],['11:42','12:05'],['12:12','12:35'],
    ['12:47','13:10'],['13:22','13:45'],['14:17','14:40'],['14:52','15:15'],['15:22','15:45'],
    ['15:32','15:55'],['15:47','16:10'],['16:22','16:45'],['16:47','17:10'],['17:07','17:30'],
    ['17:22','17:45'],['17:52','18:15'],['18:12','18:35'],['18:37','19:00']
  ];
  const LIMO_AIRPORT_TO_CITY = ['08:10','08:30','08:45','09:00','09:05','09:40','10:00','10:45','10:55','11:00','11:05','11:35','11:50','13:50','13:55','14:20','15:05','16:05','16:10','16:50','17:10','17:15','17:25','17:35','18:10','18:35','18:40','19:05','19:15','19:20','20:00','21:20','21:25','21:30'];

  const ORDINARY_WEEKDAY_CITY_TO_AIRPORT = [
    ['07:10','07:42'],['07:20','07:52'],['07:35','08:07'],['07:45','08:17'],['08:00','08:32'],['08:15','08:47'],['08:30','09:02'],['08:45','09:17'],['09:00','09:32'],['09:15','09:47'],['09:30','10:02'],['09:45','10:17'],['10:00','10:32'],['10:15','10:47'],['10:30','11:02'],['10:45','11:17'],['11:00','11:32'],['11:15','11:47'],['11:30','12:02'],
    ['11:45','12:17'],['12:00','12:32'],['12:15','12:47'],['12:30','13:02'],['12:45','13:17'],['13:00','13:32'],['13:15','13:47'],['13:30','14:02'],['13:45','14:17'],['14:00','14:32'],['14:15','14:47'],['14:30','15:02'],['14:45','15:17'],['15:00','15:32'],['15:15','15:47'],['15:30','16:02'],['15:45','16:17'],['16:00','16:32'],['16:15','16:47'],
    ['16:30','17:02'],['16:45','17:17'],['17:00','17:32'],['17:15','17:51'],['17:30','18:06'],['17:45','18:21'],['18:00','18:36'],['18:15','18:51'],['18:30','19:06'],['18:45','19:21'],['19:00','19:35'],['19:20','19:55'],['19:40','20:12'],['20:05','20:34'],['20:35','21:04'],['21:00','21:29'],['21:30','21:59']
  ];
  const ORDINARY_WEEKEND_CITY_TO_AIRPORT = [
    ['07:10','07:42'],['07:35','08:07'],['07:45','08:17'],['08:00','08:32'],['08:15','08:47'],['08:30','09:02'],['08:45','09:17'],['09:00','09:32'],['09:15','09:47'],['09:30','10:02'],['09:45','10:17'],['10:00','10:32'],['10:15','10:47'],['10:30','11:02'],['10:45','11:17'],['11:00','11:32'],['11:15','11:47'],['11:30','12:02'],
    ['11:45','12:17'],['12:00','12:32'],['12:15','12:47'],['12:30','13:02'],['12:45','13:17'],['13:00','13:32'],['13:15','13:47'],['13:30','14:02'],['13:45','14:17'],['14:00','14:32'],['14:15','14:47'],['14:30','15:02'],['14:45','15:17'],['15:00','15:32'],['15:15','15:47'],['15:30','16:02'],['15:45','16:17'],['16:00','16:32'],
    ['16:15','16:47'],['16:30','17:02'],['16:45','17:17'],['17:00','17:32'],['17:15','17:51'],['17:30','18:06'],['17:45','18:21'],['18:00','18:36'],['18:15','18:51'],['18:30','19:06'],['18:45','19:21'],['19:00','19:36'],['19:20','19:55'],['19:40','20:12'],['20:05','20:34'],['20:35','21:04'],['21:00','21:29'],['21:30','21:59']
  ];
  const ORDINARY_WEEKDAY_AIRPORT_TO_CITY = [
    ['06:54','07:26'],['07:09','07:48'],['07:19','07:55'],['07:24','08:03'],['07:39','08:18'],['07:54','08:33'],['08:09','08:48'],['08:24','09:03'],['08:40','09:12'],['08:50','09:22'],['09:05','09:35'],['09:20','09:52'],['09:35','10:05'],['09:50','10:22'],['10:05','10:35'],['10:20','10:52'],['10:35','11:05'],['10:50','11:22'],
    ['11:05','11:35'],['11:20','11:52'],['11:35','12:05'],['11:50','12:22'],['12:05','12:35'],['12:20','12:52'],['12:35','13:05'],['12:50','13:22'],['13:05','13:35'],['13:20','13:52'],['13:35','14:05'],['13:50','14:22'],['14:05','14:35'],['14:20','14:52'],['14:35','15:05'],['14:50','15:22'],['15:05','15:35'],['15:20','15:52'],
    ['15:35','16:05'],['15:50','16:22'],['16:05','16:35'],['16:20','16:56'],['16:35','17:09'],['16:50','17:26'],['17:05','17:39'],['17:20','17:56'],['17:35','18:11'],['17:50','18:26'],['18:05','18:39'],['18:20','18:56'],['18:35','19:09'],['18:55','19:28'],['19:15','19:46'],['19:40','20:13'],['20:10','20:39']
  ];
  const ORDINARY_WEEKEND_AIRPORT_TO_CITY = [
    ['07:10','07:39'],['07:25','07:52'],['07:40','08:09'],['07:55','08:24'],['08:10','08:39'],['08:25','08:54'],['08:40','09:09'],['08:50','09:19'],['09:05','09:32'],['09:20','09:49'],['09:35','10:02'],['09:50','10:19'],['10:05','10:32'],['10:20','10:49'],['10:35','11:02'],['10:50','11:19'],['11:05','11:32'],['11:20','11:49'],
    ['11:35','12:02'],['11:50','12:19'],['12:05','12:32'],['12:20','12:49'],['12:35','13:02'],['12:50','13:19'],['13:05','13:32'],['13:20','13:49'],['13:35','14:02'],['13:50','14:19'],['14:05','14:32'],['14:20','14:49'],['14:35','15:02'],['14:50','15:19'],['15:05','15:32'],['15:20','15:49'],['15:35','16:02'],['15:50','16:19'],
    ['16:05','16:32'],['16:20','16:49'],['16:35','17:02'],['16:50','17:19'],['17:05','17:32'],['17:20','17:49'],['17:35','18:02'],['17:50','18:19'],['18:05','18:32'],['18:20','18:49'],['18:35','19:02'],['18:55','19:22'],['19:15','19:40'],['19:40','20:07'],['20:20','20:45']
  ];

  function nextPair(list, nowMinutes) {
    const hit = list.find(([t]) => toMinutes(t) >= nowMinutes);
    return hit || null;
  }
  function nextTime(list, nowMinutes) {
    return list.find(t => toMinutes(t) >= nowMinutes) || null;
  }
  function airportAccessNotes(now, direction) {
    const weekend = now.dow === 0 || now.dow === 6;
    if (direction === 'departure') {
      const limoCity = nextPair(LIMO_CITY_TO_AIRPORT, now.minutes);
      const limoJr = nextPair(LIMO_JR_TO_AIRPORT, now.minutes);
      const ordinary = nextPair(weekend ? ORDINARY_WEEKEND_CITY_TO_AIRPORT : ORDINARY_WEEKDAY_CITY_TO_AIRPORT, now.minutes);
      return [
        limoCity ? `空港リムジン　松山市駅 ${limoCity[0]}発 → 松山空港 ${limoCity[1]}着` : '空港リムジン（松山市駅発）　運行終了',
        limoJr ? `空港リムジン　JR松山駅前 ${limoJr[0]}発 → 松山空港 ${limoJr[1]}着` : '空港リムジン（JR松山駅前発）　運行終了',
        ordinary ? `普通便　松山市駅 ${ordinary[0]}発 → JR松山駅前 → 空港通り → 松山空港 ${ordinary[1]}着` : '普通便（松山市駅→松山空港）　運行終了'
      ];
    }
    const limo = nextTime(LIMO_AIRPORT_TO_CITY, now.minutes);
    const ordinary = nextPair(weekend ? ORDINARY_WEEKEND_AIRPORT_TO_CITY : ORDINARY_WEEKDAY_AIRPORT_TO_CITY, now.minutes);
    return [
      limo ? `空港リムジン　松山空港 ${limo}発 → JR松山駅前 → 松山市駅 → 大街道・道後方面` : '空港リムジン（松山空港発）　運行終了',
      ordinary ? `普通便　松山空港 ${ordinary[0]}発 → 空港通り → JR松山駅前 → 松山市駅 ${ordinary[1]}着` : '普通便（松山空港→松山市駅）　運行終了'
    ];
  }

  function railSouthRoute(record) {
    const dest=String(record.dest||''), info=String(record.info||''),service=String(record.service||'');
    if(record.direction!=='south' || !/伊予大洲|八幡浜|卯之町|宇和島/.test(dest)) return '';
    if(/伊予長浜経由|愛ある伊予灘|海回り/.test(info)) return '愛ある伊予灘線経由';
    // 通常の内子経由（山回り）は注記しない。
    return '';
  }
  function railDestLabel(record) {
    const dest=String(record.dest || ''),route=railSouthRoute(record);
    return route ? dest+'［'+route+'］' : dest;
  }

  function auxRows(board, direction, now) {
    return data.records.filter(r => r.board === board && (!direction || r.direction === direction) && validRecord(r, now.iso))
      .map(r => ({...r, time: effectiveTime(r, now), minutes: toMinutes(effectiveTime(r, now))}))
      .sort((a,b)=>a.minutes-b.minutes);
  }
  function nextAux(board, direction, now) {
    return auxRows(board, direction, now).find(r => r.minutes >= now.minutes) || null;
  }
  function auxUpcoming(board, direction, now, limit=6) {
    const full = auxRows(board, direction, now);
    // "Final" means the last departure from this place today, regardless of direction.
    const allFromPlace = direction ? auxRows(board, null, now) : full;
    const finalMinute=allFromPlace.length?Math.max(...allFromPlace.map(r=>r.minutes)):null;
    return full.filter(r => r.minutes >= now.minutes).slice(0, limit).map(r => ({
      ...r,
      isFinal: Number.isFinite(finalMinute)&&r.minutes===finalMinute,
      isNextDayStart: false
    }));
  }

  function busTravelMinutes(dest) {
    const d = String(dest || '');
    if (/大阪|京都|USJ/.test(d)) return 300;
    if (/神戸/.test(d)) return 255;
    if (/高松/.test(d)) return 160;
    if (/徳島/.test(d)) return 185;
    if (/高知/.test(d)) return 160;
    if (/岡山/.test(d)) return 200;
    if (/新尾道|福山/.test(d)) return 180;
    if (/名古屋/.test(d)) return 480;
    if (/横浜|東京/.test(d)) return 690;
    if (/福岡/.test(d)) return 520;
    if (/鳴門/.test(d)) return 180;
    if (/新居浜/.test(d)) return 140;
    if (/今治/.test(d)) return 80;
    if (/宮浦港/.test(d)) return 145;
    if (/三崎/.test(d)) return 185;
    if (/宇和島/.test(d)) return 125;
    if (/城辺/.test(d)) return 210;
    return 240;
  }
  function portTravelMinutes(record) {
    if (Number(record.travelMinutes) > 0) return Number(record.travelMinutes);
    const svc = String(record.service || '');
    const dest = String(record.dest || '');
    const port = String(record.port || '');
    if (/高速船/.test(svc)) return 70;
    if (/クルーズフェリー/.test(svc)) return /広島/.test(dest) ? 165 : 150;
    if (/中島/.test(svc)) return /大浦|神浦/.test(dest) ? 85 : 60;
    if (/防予フェリー/.test(svc)) return 150;
    if (/国道九四フェリー/.test(svc)) return 70;
    if (/宇和島運輸/.test(svc)) return /臼杵/.test(dest) ? 150 : 170;
    if (/オレンジフェリー/.test(svc)) return /新居浜/.test(port) ? 420 : 480;
    if (/ジャンボフェリー/.test(svc)) return 285;
    return 120;
  }
  function busLocalStopSequence(stop) {
    const s = String(stop || '').trim();
    if (s === 'JR松山駅→松山市駅') return ['JR松山駅', '松山市駅'];
    if (s === '松山市駅→JR松山駅') return ['松山市駅', 'JR松山駅'];
    if (s.includes('→')) return s.split('→').map(x => x.trim()).filter(Boolean);
    return [s || '松山市駅'];
  }
  function busArrivalTail(record) {
    const info = String(record.info || '');
    if (/八幡浜/.test(info)) return { name: '八幡浜', extra: 52 };
    if (/宇和島/.test(info)) return { name: '宇和島', extra: 120 };
    if (/大洲/.test(info)) return { name: '大洲', extra: 60 };
    return null;
  }

  function normalizeBusDepartures(rows) {
    const src = rows.slice().sort((a,b)=>toMinutes(a.time)-toMinutes(b.time));
    const used = new Set();
    const out = [];
    const canonDest = d => String(d || '').replace(/・はりまや橋/g,'').replace(/（梅田）/g,'').trim();

    for (let i = 0; i < src.length; i++) {
      if (used.has(i)) continue;
      const r = src[i];
      const rt = toMinutes(r.time);
      let merged = { ...r, direction:'departure', originName: r.stop || '松山市駅' };

      if ((r.stop || '') === 'JR松山駅') {
        let best = -1, bestDiff = 99;
        for (let j = i + 1; j < src.length; j++) {
          if (used.has(j)) continue;
          const c = src[j];
          const diff = toMinutes(c.time) - rt;
          if (diff < 4 || diff > 12) continue;
          if ((c.stop || '') !== '松山市駅') continue;
          if (String(c.service || '') !== String(r.service || '')) continue;
          if (canonDest(c.dest) !== canonDest(r.dest)) continue;
          if (diff < bestDiff) { best = j; bestDiff = diff; }
        }
        if (best >= 0) {
          const c = src[best]; used.add(best);
          merged.stopText = `JR松山駅発`;
          merged.viaStop = `松山市駅 ${c.time}`;
          merged.originName = 'JR松山駅';
        } else if (/新居浜/.test(String(r.dest || ''))) {
          merged.stopText = 'JR松山駅発';
          merged.viaStop = `松山市駅 ${addMinutes(r.time, 8)}`;
        } else {
          merged.stopText = 'JR松山駅発';
        }
      } else if ((r.stop || '') === '松山市駅') {
        merged.stopText = '松山市駅発';
        merged.originName = '松山市駅';
      } else {
        merged.stopText = `${r.stop || '松山市駅'}発`;
      }
      if (r.originStartName && r.originStartTime && r.originStartName !== (r.stop || '')) {
        merged.viaStop = `始発 ${r.originStartName} ${r.originStartTime}`;
      }
      out.push(merged);
    }
    return out.sort((a,b)=>toMinutes(a.time)-toMinutes(b.time) || String(a.id).localeCompare(String(b.id)));
  }
  function synthBusArrival(record) {
    const localStops = [];
    if (record.originName === 'JR松山駅' && String(record.viaStop || '').startsWith('松山市駅')) {
      localStops.push('松山市駅', 'JR松山駅');
    } else if (record.originName === 'JR松山駅') {
      localStops.push('JR松山駅');
    } else {
      localStops.push('松山市駅');
    }
    const seq = [];
    let current = addMinutes(record.time, busTravelMinutes(record.dest));
    for (const s of localStops) {
      seq.push({ name: s, time: current });
      current = addMinutes(current, 8);
    }
    const terminal = seq[seq.length - 1];
    const arrivalNextDay=toMinutes(seq[0].time)<toMinutes(record.time);
    return { ...record, actualOperator: record.arrivalActualOperator || record.actualOperator || '', syntheticArrival: true, direction: 'arrival', time: seq[0].time, origin: record.dest, originDepartureTime: record.time, arrivalSequence: seq, arrivalTerminal: terminal.name, arrivalTerminalTime: terminal.time, estimatedArrival: true, _arrivalNextDay:arrivalNextDay };
  }
  function synthPortArrival(record) {
    const originTime = record.reverseTime || record.time;
    const t = record.reverseArrivalTime || addMinutes(record.time, portTravelMinutes(record));
    const arrivalNextDay=toMinutes(t)<toMinutes(originTime);
    return { ...record, direction: 'arrival', time: t, origin: record.dest, originDepartureTime: originTime, arrivalPort: record.port, estimatedArrival: !record.reverseArrivalTime, _arrivalNextDay:arrivalNextDay };
  }


  function estimatedJourneyProgress(departureTime, arrivalTime, now, departureDay='') {
    const depText=padTime(departureTime||'');
    const arrText=padTime(arrivalTime||'');
    if(!/^\d{2}:\d{2}$/.test(depText) || !/^\d{2}:\d{2}$/.test(arrText)) return null;

    let dep=toMinutes(depText);
    let arr=toMinutes(arrText);
    const cur=now.minutes;

    if(String(departureDay||'').includes('前日')) {
      dep-=1440;
    } else if(arr<dep) {
      arr+=1440;
    }

    if(!Number.isFinite(dep) || !Number.isFinite(arr) || arr<=dep) return null;
    if(cur<dep || cur>arr) return null;
    return Math.max(0,Math.min(1,(cur-dep)/(arr-dep)));
  }

  function estimatedWaypoint(points, progress) {
    if(!Array.isArray(points) || !points.length || !Number.isFinite(progress)) return '';
    const index=Math.max(0,Math.min(points.length-1,Math.round(progress*(points.length-1))));
    return String(points[index]||'').trim();
  }

  function busEstimatedRoutePoints(record) {
    const origin=String(record.origin||record.dest||'').trim();
    const key=`${origin} ${record.source||''} ${record.service||''}`;
    const terminal=String(record.arrivalTerminal||record.stop||'松山市駅').trim()||'松山市駅';

    if(/東京|横浜/.test(key)) return ['首都圏','東名高速','名古屋周辺','京阪神','淡路島','徳島道','川内IC','松山IC',terminal];
    if(/名古屋/.test(key)) return ['名古屋駅','松茂','徳島駅','高松中央インターBT','高松駅高速BT','三島川之江インター','川内インター','松山インター口','大街道','松山市駅',terminal];
    if(/大阪|京都|USJ/.test(key)) return ['大阪・京都','神戸周辺','淡路島','徳島道','川之江JCT','川内IC','松山IC',terminal];
    if(/神戸/.test(key)) return ['神戸三宮','高速舞子','淡路島','徳島道','川内インター','松山インター口',terminal];
    if(/高松/.test(key)) return ['高松駅高速BT','ゆめタウン高松','高速丸亀','高速善通寺','三島川之江インター','川内インター','松山インター口',terminal];
    if(/徳島|鳴門/.test(key)) return ['徳島駅周辺','脇町BS','三好BS','三島川之江インター','川内インター','松山インター口','大街道','松山市駅',terminal];
    if(/高知/.test(key)) return ['高知駅','一宮バスターミナル','三島川之江インター','川内インター','松山インター口','松山市駅',terminal];
    if(/岡山/.test(key)) return ['岡山駅西口','津高','有城南','鷲羽山北','瀬戸大橋','川内インター','松山インター口','大街道','松山市駅',terminal];
    // Setouchi Matsuyama–Imabari services use Route 317 via Tamagawa,
    // not the old Hojo/Kikuma coast road.
    if(/setouchi_omishima/.test(key) || /今治|宮浦/.test(key))
      return ['今治周辺','玉川','奥道後','松山市内',terminal];
    // The Shimanami express routes must not inherit the obsolete coastal path.
    if(/福山|新尾道/.test(key))
      return ['福山・新尾道','しまなみ海道','大島BS','来島海峡BS','川内インター','松山インター口',terminal];
    if(/福岡/.test(key))
      return ['福岡','小倉','しまなみ海道','今治駅前','今治桟橋','川内インター','松山インター口','余戸南インター',terminal];
    if(/新居浜/.test(key)) return ['新居浜駅前','西条駅前','石鎚神社','川内','横河原','愛大病院前','四国がんセンター','新久米','大街道','松山市駅',terminal];
    if(/三崎|iyotetsu_misaki/.test(key)) return ['三崎港口','伊方町役場前','八幡浜駅前','大洲','内子','中山','伊予市','保免','松山市駅',terminal];
    if(/久万高原|jrshikoku_kumakogen/.test(key)) return ['久万高原','大平','岩谷口','砥部','麻生','森松本町','天山橋','大街道','大手町',terminal];
    if(/宇和島|城辺/.test(key)) return ['宇和島方面','吉田営業所','卯之町営業所','大洲方面','エミフル松前','松山市駅',terminal];

    const label=origin.replace(/[（(].*?[）)]/g,'').trim()||'出発地';
    return [label,'高速道路上','愛媛県内','松山IC',terminal];
  }

  function busEstimatedPosition(record, now) {
    const arrival=padTime(record.arrivalTerminalTime||record.time||'');
    let departure=padTime(record.originDepartureTime||'');
    let departureDay=String(record.originDepartureDay||'');

    if(!departure && /^\d{2}:\d{2}$/.test(arrival)) {
      const origin=String(record.origin||record.dest||'');
      departure=addMinutes(arrival,-busTravelMinutes(origin));
      if(toMinutes(departure)>toMinutes(arrival)) departureDay='前日';
    }

    const progress=estimatedJourneyProgress(departure,arrival,now,departureDay);
    return progress===null ? '' : estimatedWaypoint(busEstimatedRoutePoints(record),progress);
  }

  function ferryEstimatedRoutePoints(record) {
    const origin=String(record.origin||record.dest||'').trim();
    const arrival=String(record.arrivalPort||record.port||'').trim();
    const key=`${origin} ${arrival} ${record.service||''} ${record.source||''}`;

    if(/広島/.test(origin)) return ['広島港沖','似島沖','呉沖','安芸灘','斎灘',arrival?arrival+'沖':'松山沖'];
    if(/呉/.test(origin)) return ['呉港沖','倉橋島沖','安芸灘','斎灘',arrival?arrival+'沖':'松山沖'];
    if(/大浦|中島|睦月|野忽那/.test(origin)) return ['中島沖','睦月島沖','野忽那島沖','興居島沖','高浜沖',arrival?arrival+'沖':'松山沖'];
    if(/別府/.test(origin)) return ['別府湾','国東半島沖','豊後水道','佐田岬沖','伊予灘',arrival?arrival+'沖':'八幡浜沖'];
    if(/臼杵/.test(origin)) return ['臼杵湾','豊後水道','佐田岬沖','伊予灘',arrival?arrival+'沖':'八幡浜沖'];
    if(/佐賀関/.test(origin)) return ['佐賀関沖','豊予海峡','佐田岬沖',arrival?arrival+'沖':'三崎港沖'];
    if(/神戸/.test(origin)) return ['神戸港沖','大阪湾','明石海峡','播磨灘','小豆島沖','備讃瀬戸',arrival?arrival+'沖':'高松港沖'];
    if(/大阪/.test(origin)) return ['大阪湾','明石海峡','播磨灘','燧灘',arrival?arrival+'沖':'東予港沖'];
    if(/高松/.test(origin)) return ['高松港沖','備讃瀬戸','燧灘',arrival?arrival+'沖':'新居浜港沖'];
    if(/今治|大三島|宮浦/.test(key)) return [origin?origin+'沖':'しまなみ海道','しまなみ海道','来島海峡',arrival?arrival+'沖':'今治沖'];

    const from=origin?origin.replace(/港$/,'')+'沖':'出発港沖';
    const to=arrival?arrival.replace(/港$/,'')+'沖':'到着港沖';
    return [from,'航路中間',to];
  }

  function ferryEstimatedPosition(record, now) {
    const departure=padTime(record.originDepartureTime||record.reverseTime||'');
    const arrival=padTime(record.time||record.arrivalTime||'');
    const departureDay=String(record.originDepartureDay||'');
    const progress=estimatedJourneyProgress(departure,arrival,now,departureDay);
    return progress===null ? '' : estimatedWaypoint(ferryEstimatedRoutePoints(record),progress);
  }

  // Timetable interpolation, not AIS: show a PROVISIONAL last waypoint/time.
  // Checkpoints are modelled with equal fractions of the advertised voyage.
  function ferryEstimatedLastPass(record, now) {
    const departure=padTime(record.originDepartureTime||record.reverseTime||'');
    const arrival=padTime(record.time||record.arrivalTime||'');
    if(!/^[0-9]{2}:[0-9]{2}$/.test(departure)||!/^[0-9]{2}:[0-9]{2}$/.test(arrival))return '';
    const departureDay=String(record.originDepartureDay||'');
    let clock=now;
    // When tomorrow's early arrival belongs to today's late departure,
    // reinterpret tonight on the following-day arrival time axis.
    if(departureDay.includes('前日') && record._serviceIso &&
       record._serviceIso!==now.iso && toMinutes(departure)>toMinutes(arrival) &&
       now.minutes>=toMinutes(departure)) {
      clock={...now,minutes:now.minutes-1440};
    }
    const progress=estimatedJourneyProgress(departure,arrival,clock,departureDay);
    if(progress===null)return '';
    const waypoints=ferryEstimatedRoutePoints(record);
    if(!Array.isArray(waypoints)||waypoints.length<2)return '';
    const segments=waypoints.length-1;
    const last=Math.max(0,Math.min(segments,Math.floor(progress*segments+1e-8)));
    const duration=(toMinutes(arrival)-toMinutes(departure)+1440)%1440;
    if(!duration)return '';
    const checkpoint=addMinutes(departure,Math.floor(duration*last/segments));
    return `最終通過見込：${waypoints[last]} ${checkpoint}（仮）`;
  }

  function ferryDeparturePosition(record, now) {
    // Keep an outbound sailing on the departures board after its timetable
    // departure until its estimated destination arrival. Not an AIS fix.
    if(record.sailingInProgress){
      const left=Number(record.estimatedDestinationMinute)-now.minutes;
      const eta=addMinutes(record.time,portTravelMinutes(record));
      const waypoint=ferryEstimatedLastPass({
        ...record,origin:String(record.port||'出発港'),
        originDepartureTime:record.time,originDepartureDay:'',
        arrivalPort:portDestinationName(record.dest),time:eta,arrivalTime:eta
      },now);
      return [waypoint||'出航時刻経過（推定）',
        `${String(record.dest||'目的港')}へ航行中（推定）`,
        `${eta}頃到着予定${left>0?`・あと約${Math.ceil(left)}分`:''}`].join(' ｜ ');
    }
    const port=String(record.port||'出発港').trim()||'出発港';
    const departure=padTime(record.time||'');
    if(!/^\d{2}:\d{2}$/.test(departure)) return '';
    // A future departure is not evidence that a vessel is already berthed.
    // Keep the estimate only shortly before today's departure.
    if(record.isNextDayStart) return '';
    const untilDeparture=toMinutes(departure)-now.minutes;
    return untilDeparture>=0 && untilDeparture<=20 ? `${port} 停泊中（見込）` : '';
  }

  function ferryRouteGuidance(record, direction, now) {
    const via=record._gogoshimaDock
      ? '10/14〜20 ドック臨時ダイヤ・由良⇔泊 無料送迎バス'
      : portViaLabel(record);
    const position=direction==='departure'
      ? ferryDeparturePosition(record,now)
      : ferryEstimatedLastPass(record,now);
    return [via,position].filter(Boolean).join(' ｜ ') || '—';
  }

  // Verified inbound services only: JR Shikoku Bus 2026-06-01 Kochi -> Matsuyama timetable.
  // Do not derive inbound journeys from outbound departures.
  function confirmedHighwayInboundRows(iso) {
    const out=[];
    const add=(route,source,company,departs,arrives,reference)=>{
      departs.forEach((departure,i)=>{
        out.push({id:`verified-${source}-in-${i}`,board:'bus',kind:'bus',
          source,service:company[i]||'高速バス',direction:'arrival',origin:route,
          dest:'JR松山駅',time:arrives[i],originDepartureTime:departure,
          arrivalTerminal:'JR松山駅',arrivalTerminalTime:arrives[i],
          noSyntheticArrival:true,info:'公式時刻表・松山着',timetableReference:reference});
      });
    };
    // 2026-10-01: 坊っちゃんエクスプレス（高松 -> 松山）
    add('高松駅高速BT','takamatsu_official_in',
      ['伊予鉄バス','JR四国バス','四国高速バス','JR四国バス','伊予鉄バス','JR四国バス','四国高速バス','四国高速バス','伊予鉄バス','JR四国バス','四国高速バス','伊予鉄バス'],
      ['07:45','08:45','09:45','11:05','12:40','13:15','14:45','16:05','17:05','18:20','19:20','20:20'],
      ['10:35','11:35','12:35','13:55','15:05','16:05','17:35','18:55','19:30','21:10','22:10','23:10'],
      'https://www.jr-shikokubus.co.jp/businfo/bocchan_ex/matsuyama.html');
    // 2026-05-19 JR official operating schedule: Kansai -> JR Matsuyama.
    // Friday/Saturday only: first Osaka 06:30 service (△ in operator PDF).
    // Overnight 00:00 and 05:40 arrivals depart Kansai the previous day.
    const kansaiJr=[
      ['JR大阪駅','06:30','12:31','西日本JRバス','fri_sat'],
      ['JR大阪駅','08:00','14:01','西日本JRバス'],
      ['JR大阪駅','10:10','16:08','JR四国バス'],
      ['JR大阪駅','11:40','17:38','JR四国バス'],
      ['JR大阪駅','13:20','19:27','西日本JRバス'],
      ['京都駅中央口','12:50','20:08','JR四国バス'],
      ['JR大阪駅','15:20','21:20','西日本JRバス'],
      ['JR大阪駅','16:25','22:33','JR四国バス'],
      ['JR大阪駅','17:55','00:00','西日本JRバス','previous'],
      ['京都駅中央口','21:20','05:40','JR四国バス','previous']
    ];
    const serviceWeekday=new Date(iso+'T12:00:00+09:00').getDay();
    kansaiJr.forEach(([origin,depart,arrive,operator,condition],i)=>{
      if(condition==='fri_sat' && ![5,6].includes(serviceWeekday))return;
      out.push({id:'verified-jr-kansai-in-'+iso+'-'+i,
        board:'bus',kind:'bus',direction:'arrival',
        source:'jr_kansai_official_in',service:operator,
        origin,dest:'JR松山駅',time:arrive,
        originDepartureTime:depart,
        originDepartureDay:condition==='previous'?'前日':'',
        arrivalTerminal:'JR松山駅',arrivalTerminalTime:arrive,
        noSyntheticArrival:true,
        info:'松山エクスプレス／京阪神ドリーム松山・2026年5月19日減便ダイヤ',
        timetableReference:'https://www.jr-shikokubus.co.jp/news/2026/05/82d2a07ba7df0e45584aa4eaa4845505f79ebfd5.pdf'});
    });
    // Kirara Express Fukuyama -> Matsuyama: 2 daily trains, NOT
    // the currently suspended 08:30 and 14:20 departures.
    // All buses are suspended for Cycling Shimanami on 2026-10-25.
    if(iso!=='2026-10-25'){
      [['10:30','13:10','中国バス／本四バス'],
       ['16:40','19:25','しまなみバス／伊予鉄バス']]
        .forEach(([depart,arrive,operator],i)=>{
          out.push({id:'verified-kirara-in-'+iso+'-'+i,
            board:'bus',kind:'bus',direction:'arrival',
            source:'kirara_official_in',service:operator,
            origin:'福山駅前',dest:'松山市駅',time:arrive,
            originDepartureTime:depart,arrivalTerminal:'松山市駅',
            arrivalTerminalTime:arrive,noSyntheticArrival:true,
            info:'キララエクスプレス・運行便のみ',
            timetableReference:'https://www.iyotetsu.co.jp/kousoku/hiroshima.html'});
        });
    }
    // マドンナエクスプレス（岡山 -> 松山）
    add('岡山駅西口','okayama_official_in',
      ['両備バス','下津井電鉄','JR四国バス','伊予鉄バス'],
      ['08:00','11:10','14:50','17:20'],
      ['11:37','14:37','18:17','20:47'],
      'https://www.iyotetsu.co.jp/kousoku/okayama.html');
    // 吉野川エクスプレス（徳島 -> 松山）公式時刻表
    add('徳島駅前','tokushima_official_in',
      ['JR四国バス','徳島バス','徳島バス','JR四国バス','伊予鉄バス','伊予鉄バス'],
      ['08:00','09:40','12:20','15:20','17:00','18:40'],
      ['11:28','13:08','15:48','18:48','20:28','22:08'],
      'https://www.iyotetsu.co.jp/kousoku/tokushima.html');
    // ホエールエクスプレス（高知 -> 松山）2026-04-01～
    add('高知駅バスターミナル','kochi_official_in',
      ['とさでん交通','伊予鉄バス','とさでん交通','伊予鉄バス'],
      ['07:30','11:45','15:30','19:30'],
      ['10:11','14:20','18:05','22:11'],
      'https://www.iyotetsu.co.jp/kousoku/kochi.html');
    // 神戸三宮発・ハーバーライナー：運休中の便は含めない。
    const dow=new Date(iso+'T12:00:00+09:00').getDay();
    const weekend=dow===0||dow===6;
    const kobe=[
      ['07:20','11:32','神姫バス',true],
      ['08:15','12:27','神姫バス',false],
      ['10:20','14:32','神姫バス',false],
      ['14:20','18:32','伊予鉄バス',true],
      ['16:20','20:32','伊予鉄バス',false],
      ['18:20','22:32','伊予鉄バス',false]
    ];
    kobe.filter(x=>!x[3]||weekend).forEach(([departure,arrival,operator],i)=>{
      out.push({id:`verified-kobe-in-${i}`,board:'bus',kind:'bus',
        source:'iyotetsu_kobe_official_in',service:operator,direction:'arrival',
        origin:'神戸三宮',dest:'松山市駅',time:arrival,
        originDepartureTime:departure,arrivalTerminal:'松山市駅',
        arrivalTerminalTime:arrival,noSyntheticArrival:true,
        info:'ハーバーライナー・公式時刻表',
        timetableReference:'https://www.iyotetsu.co.jp/kousoku/kobe.html'});
    });
    // 名古屋・福岡は出発日の翌朝に松山へ到着する夜行便。
    const nightly=[
      ['名古屋駅（新幹線口）','nagoya_official_in','伊予鉄バス／名鉄バス／JRバス','23:10','09:03','JR松山駅','https://www.iyotetsu.co.jp/kousoku/nagoya.html'],
      ['西鉄天神高速BT','fukuoka_official_in','伊予鉄南予バス／瀬戸内運輸','21:10','07:25','松山市駅','https://www.iyotetsu.co.jp/kousoku/fukuoka.html']
    ];
    nightly.forEach(([origin,source,service,departure,arrival,terminal,reference])=>{
      out.push({id:`verified-${source}-${iso}`,board:'bus',kind:'bus',
        source,service,direction:'arrival',origin,dest:terminal,
        time:arrival,originDepartureTime:departure,originDepartureDay:'前日',
        arrivalTerminal:terminal,arrivalTerminalTime:arrival,
        noSyntheticArrival:true,info:'夜行・前日出発／公式時刻表',
        timetableReference:reference});
    });
    return out;
  }
  // Official inbound medium-distance services. Never reverse a Matsuyama
  // outbound service and call it an actual inbound timetable.
  // Source: https://www.uwajima-bus.co.jp/matsuyama (2026-04-01)
  // https://www.setouchibus.co.jp/rosen/niihama.html (2025-10-01)
  // https://www.setouchibus.co.jp/rosen/omishima.html (2026-04-01)
  function confirmedRegionalInboundRows(iso) {
    const rows=[];
    const add=(source,operator,origin,terminal,dep,arr,reference)=>{
      if(!/^\d{2}:\d{2}$/.test(dep)||!/^\d{2}:\d{2}$/.test(arr))return;
      rows.push({id:'verified-'+source+'-'+iso+'-'+arr+'-'+dep,
        board:'bus',kind:'midbus',source,direction:'arrival',
        origin,dest:terminal,service:operator,time:arr,
        originDepartureTime:dep,arrivalTerminal:terminal,
        arrivalTerminalTime:arr,noSyntheticArrival:true,
        info:'事業者公式時刻表・松山到着',timetableReference:reference});
    };
    // 宇和島バスセンター -> 松山市駅前 (some services originate in 城辺).
    const uwajimaDep=['06:20','07:00','07:30','08:30','10:00','11:00','12:30','14:00','16:00','18:20'];
    const uwajimaArr=['08:14','09:09','09:39','10:24','11:54','13:09','14:24','16:09','18:09','20:14'];
    uwajimaDep.forEach((t,i)=>add('uwajima_bus_official_in','宇和島自動車',
      '宇和島','松山市駅',t,uwajimaArr[i],
      'https://www.uwajima-bus.co.jp/matsuyama'));
    // 新居浜駅 -> JR松山駅前. The two early arrivals 08:25 are alternate
    // operating-day slots at the same time; show them as one display event.
    const niihamaWeekend=[0,6].includes(new Date(iso+'T12:00:00+09:00').getDay());
    const niihamaDep=[niihamaWeekend?'06:10':'06:00','07:30','09:00','10:30','12:30','14:00','16:00'];
    const niihamaArr=['08:25','09:45','11:15','12:45','14:45','16:15','18:15'];
    niihamaDep.forEach((t,i)=>add('setouchi_niihama_official_in',
      i===4?'伊予鉄バス':'せとうちバス','新居浜駅','JR松山駅',
      t,niihamaArr[i],'https://www.setouchibus.co.jp/rosen/niihama.html'));
    // 2026-04-01 current official through-running 特急. Some services
    // originate at 宮浦港 and run through 今治桟橋; do not mislabel origins.
    const imabariTrips=[
      ['今治桟橋','06:38','07:57'],
      ['宮浦港','06:28','08:49'],
      ['今治桟橋','08:53','10:12'],
      ['今治桟橋','12:33','13:52'],
      ['今治桟橋','14:33','15:52'],
      ['宮浦港','15:00','17:21']
    ];
    imabariTrips.forEach(([origin,dep,arr])=>add('setouchi_omishima_official_in',
      'せとうちバス',origin,'松山市駅',dep,arr,
      'https://www.setouchibus.co.jp/rosen/omishima.html'));
    // 三崎港口 -> 松山市駅: the through service departing 06:42.
    // The later 15:30 service ends at 八幡浜; do not invent a Matsuyama arrival.
    add('iyotetsu_misaki_official_in','伊予鉄南予バス','三崎港口',
      '松山市駅','06:42','09:46',
      'https://www.iyotetsu.co.jp/rosen/bus/time202604/all.pdf');
    return rows;
  }

  // Single direction rule for both the published JR timetable and
  // independently observed live-only trains. Unknown destinations do not
  // override a verified route direction.
  function railDirectionByDestination(dest) {
    const text=cleanStation(dest||'');
    const north=/岡山|高松|観音寺|丸亀|坂出|多度津|今治|新居浜|伊予西条|壬生川|伊予北条|菊間|浅海|大西|波止浜|堀江|伊予和気|三津浜/.test(text);
    const south=/宇和島|八幡浜|伊予大洲|卯之町|伊予市|伊予長浜|内子|市坪|北伊予|南伊予|伊予横田|鳥ノ木|向井原|伊予中山|伊予立川|五十崎|喜多山/.test(text);
    return north===south?'':north?'north':'south';
  }

  function getBoardRecords(board, now) {
    const displayIso = boardDisplayIso(board, now);
    const rows = recordsForDay(board, (board === 'rail' || board === 'air') ? displayIso : now.iso);
    if (board === 'rail') {
      // Images from the day's operation logs remain available before the
      // physical train is observed. They must not imply a confirmed location.
      const withIcons=Array.isArray(approachLive.ichitsubo?.matsuyamaSchedule)
        ? approachLive.ichitsubo.matsuyamaSchedule : [];
      return rows.map(r => {
          const destText = String(r.dest || '');
          // 方面は列車名ではなく行先で照合。データ側の誤設定を表示時に防止する。
          const correctedDirection = railDirectionByDestination(destText) || r.direction;
          const iconMatches=withIcons.filter(x=>{
            if(String(x.direction||'')!==correctedDirection ||
               padTime(x.departure||'')!==padTime(r.time||''))return false;
            const named=railLiveTrainLabel(x);
            if(r.kind==='limited')return named.kind==='limited' && named.service===String(r.service||'');
            return r.kind==='local' && named.kind==='local';
          });
          const iconMatch=iconMatches.length===1?iconMatches[0]:null;
          return { ...r, direction: correctedDirection, minutes: toMinutes(r.time), displayIso,
            // Image-only evidence: retain the existing timetable-only flag
            // unless the independent live-position matcher confirms position.
            vehicleImageNorth:String(iconMatch?.vehicleImageNorth||''),
            vehicleImageSouth:String(iconMatch?.vehicleImageSouth||''),
            vehicleImageSource:String(iconMatch?.vehicleImageSource||'')
          };
        }).filter(r => r.direction === currentRailDir())
        .sort((a, b) => rMinutes(a) - rMinutes(b));
    }
    if (board === 'air') {
      return rows.map(r => ({ ...r, minutes: toMinutes(r.time), displayIso }))
        .filter(r => r.direction === currentDirection())
        .sort((a, b) => rMinutes(a) - rMinutes(b));
    }
    if (board === 'bus') {
      const explicitArrivals = [...rows.filter(r => r.direction === 'arrival'), ...confirmedHighwayInboundRows(now.iso), ...confirmedRegionalInboundRows(now.iso)].map(r => {
        const terminal = String(r.arrivalTerminal || r.stop || '松山市駅').trim() || '松山市駅';
        const terminalTime = padTime(r.arrivalTerminalTime || r.time || '');
        return {
          ...r,
          origin: String(r.origin || r.dest || '—').trim() || '—',
          arrivalTerminal: terminal,
          arrivalTerminalTime: terminalTime || '—',
          minutes: toMinutes(terminalTime || r.time)
        };
      });
      const depSource = rows.filter(r => r.direction !== 'arrival');
      const deps = normalizeBusDepartures(depSource).map(r => ({ ...r, direction: 'departure', minutes: toMinutes(r.time) }));
      if (currentDirection() === 'departure') return deps.sort((a,b)=>rMinutes(a)-rMinutes(b));

      // 到着は「今日発の同日着」＋「前日発の翌日着」。
      // 今日の夜行便を0時台の到着便として先取り表示しない。
      const prevIso=shiftIso(now.iso,-1);
      const prevRows=recordsForDay('bus',prevIso).filter(r=>r.direction!=='arrival');
      const prevDeps=normalizeBusDepartures(prevRows).map(r=>({...r,direction:'departure',minutes:toMinutes(r.time)}));
      // Outbound timetables do not establish the opposite inbound service.
      // Show arrivals only when an actual inbound schedule record exists.
      // In particular, never manufacture high-speed-bus arrivals by adding
      // estimated travel time to a Matsuyama departure.
      return explicitArrivals.sort((a,b)=>rMinutes(a)-rMinutes(b));
    }
    if (board === 'port') {
      const deps = rows.map(r => ({ ...r, direction: 'departure', minutes: toMinutes(r.time) }));
      if (currentDirection() === 'departure') return deps.sort((a,b)=>rMinutes(a)-rMinutes(b));

      // Ferry arrival board is rolling 24-hour information.
      // Keep departures from today even when they arrive after midnight,
      // and also include previous-day overnight sailings that arrive today.
      const prevIso=shiftIso(now.iso,-1);
      const prevDeps=recordsForDay('port',prevIso).map(r=>({...r,direction:'departure',minutes:toMinutes(r.time)}));

      const sameDay=deps
        .filter(r=>!r.noSyntheticArrival)
        .map(synthPortArrival)
        .map(r=>({
          ...r,
          minutes:toMinutes(r.time)+(r._arrivalNextDay?1440:0)
        }));

      const overnight=prevDeps
        .filter(r=>!r.noSyntheticArrival)
        .map(synthPortArrival)
        .filter(r=>r._arrivalNextDay)
        .map(r=>({
          ...r,
          originDepartureDay:'前日',
          minutes:toMinutes(r.time)
        }));

      return [...overnight,...sameDay].sort((a,b)=>rMinutes(a)-rMinutes(b));
    }
    return [];
  }
  // Takahama - Gogoshima published timetable (Yura and Tomari).
  // https://gogoshima-ferry.com/timetable_faretable/
  function gogoshimaPortRecords(iso) {
    const holidayClosure=/-(?:12-31|01-0[1-3])$/.test(iso);
    // 2026-10-14–20: しとらす dry-dock; only ミソラ operates.
    // Read directly from operator's dated temporary ferry timetable:
    // https://gogoshima-ferry.com/wp-content/uploads/rinji_daiya.pdf
    const dock=iso>='2026-10-14' && iso<='2026-10-20';
    const routes=dock ? [
      {name:'由良港',ship:'フェリーミソラ',travel:13,
       outward:['06:15','07:25','08:08','08:55','09:55','10:55','11:55','13:15','14:40','16:00','17:10','18:10'],
       inward:['05:55','07:08','07:44','08:35','09:35','10:35','11:35','12:55','14:20','15:35','16:40','17:50']}
    ] : [
      {name:'由良港',ship:'フェリーミソラ',travel:13,
       outward:['06:15','07:25','08:08','08:55','09:55','10:55','11:55','13:15','14:40','16:00','17:10','18:10','19:10','20:10'],
       inward:['05:55','07:08','07:44','08:35','09:35','10:35','11:35','12:55','14:20','15:35','16:40','17:50','18:50','19:50']},
      {name:'泊港',ship:'フェリーしとらす',travel:10,
       outward:['06:45','07:17','07:52','09:25','10:25','11:25','12:25','13:55','15:25','16:40','17:40','18:40','19:40','20:25'],
       inward:['06:25','07:00','07:35','08:55','10:05','11:05','12:10','13:35','15:00','16:10','17:20','18:20','19:20','20:10']}
    ];
    const out=[];
    for(const route of routes){
      for(const [direction,times] of [['departure',route.outward],['arrival',route.inward]]){
        times.forEach((time,i)=>{
          if(holidayClosure && i===times.length-1)return;
          const landing=route.name;
          out.push({id:`gogoshima-${landing}-${direction}-${i}`,
            board:'port',kind:'ferry',source:'gogoshima_official',port:'高浜港',
            arrivalPort:direction==='arrival'?'高浜港':landing,
            service:'株式会社ごごしま',shipName:route.ship,
            dest:direction==='departure'?landing:'高浜港',
            origin:direction==='arrival'?landing:'高浜港',
            info:`${route.ship}・${landing}航路${dock?'・ドック臨時便':''}`,
            time:direction==='arrival'?addMinutes(time,route.travel):time,
            originDepartureTime:direction==='arrival'?time:undefined,
            // Operator's published approximate sailing times: Yura ~13 min,
            // Tomari ~10 min. Otherwise portTravelMinutes() defaults to 120.
            travelMinutes:route.travel,
            direction,noSyntheticArrival:true,
            estimatedArrival:true,
            _gogoshima:true,_gogoshimaDock:dock});
        });
      }
    }
    return out;
  }
  // Extract only published high-port calls from Nakajima services.
  // Calling times are used as high-port arrival estimates; they do not
  // independently establish a separate departure minute.
  function nakajimaTakahamaCalls(iso) {
    // Prefecture-published High-Port boarding times: East/West ferry and fast boats.
    // Use the published High-Port time, not the departure at Mitsuhama.
    const highPortDepartures=[
      ['07:10','大浦港','中島汽船フェリー（東線）'],
      ['13:15','大浦港','中島汽船フェリー（東線）'],
      ['16:05','大浦港','中島汽船フェリー（東線）'],
      ['16:55','西中港','中島汽船フェリー（西線）'],
      ['07:40','神浦港','中島汽船高速船（西線）'],
      ['11:40','神浦港','中島汽船高速船（西線）'],
      ['15:15','神浦港','中島汽船高速船（西線）'],
      ['17:25','大浦港','中島汽船高速船（東線）'],
      ['19:25','大浦港','中島汽船高速船（東線）']
    ].map(([time,dest,service],i)=>({
      id:'nakajima-takahama-dep-'+i,board:'port',kind:'ferry',
      source:'nakajima_takahama_departure',port:'高浜港',direction:'departure',
      time,dest,service,info:'高浜港発・中島方面',
      noSyntheticArrival:true
    }));
    const highPortArrivals=recordsForDay('port',iso).flatMap(r=>{
      if(!/nakajima/.test(String(r.source||''))) return [];
      const calls=Array.isArray(r.calls)?r.calls:[];
      return calls.filter(call=>Array.isArray(call) &&
        String(call[0])==='高浜港' && /^\d{1,2}:\d{2}$/.test(String(call[1]||'')))
        .map((call,index)=>({
          ...r,id:`takahama-nakajima-${r.id||r.time}-${index}`,
          source:'nakajima_takahama_call',port:'高浜港',arrivalPort:'高浜港',
          direction:'arrival',time:padTime(call[1]),origin:'三津浜港',
          originDepartureTime:r.time,dest:'高浜港',noSyntheticArrival:true,
          info:`中島汽船・高浜港寄港（${r.dest||'中島方面'}）`,
          _nakajimaTakahama:true
        }));
    });
    return [...highPortDepartures,...highPortArrivals];
  }
  // Actual inbound Jumbo Ferry sailings from Kobe to Takamatsu.
  // Timetable: https://ferry.co.jp/home/kobe-takamatsu/
  function jumboInboundPortRows(iso) {
    const dow=new Date(iso+'T12:00:00+09:00').getDay();
    const weekend=dow===0||dow===6;
    const runs=weekend
      ? [['01:00','05:15','直行'],['08:15','13:00','小豆島経由'],['11:20','16:05','小豆島経由']]
      : [['01:00','05:15','直行'],['08:15','13:00','小豆島経由'],['13:00','17:45','小豆島経由']];
    // The last Kobe departure of the previous day reaches Takamatsu
    // just after midnight of this arrival-board day.
    const prev=shiftIso(iso,-1);
    const prevDow=new Date(prev+'T12:00:00+09:00').getDay();
    const prevWeekend=prevDow===0||prevDow===6;
    runs.unshift(prevWeekend?['19:20','00:05','小豆島経由']:['19:45','00:00','直行']);
    return runs.map(([departure,arrival,via],i)=>({
      id:`jumbo-kobe-arrival-${iso}-${i}`,board:'port',kind:'ferry',
      source:'jumbo_ferry_official_arrival',service:'ジャンボフェリー',
      port:'高松東港',arrivalPort:'高松東港',direction:'arrival',
      origin:'神戸港',dest:'高松東港',time:arrival,originDepartureTime:departure,
      ...(i===0?{originDepartureDay:'前日'}:{}),
      info:via,noSyntheticArrival:true,reference:false
    }));
  }
  // Saga-no-seki -> Misaki, 70 minutes: official scheduled arrivals.
  // 12:00 from Saga-no-seki is EXTRA only on the announced dates.
  // The 23:00 departure reaches Misaki at 00:10 on the FOLLOWING date,
  // so today's 00:10 arrival belongs to yesterday's 23:00 departure.
  function koku94InboundPortRows(iso) {
    const extraDates=['2026-09-19','2026-09-20','2026-09-21','2026-09-22','2026-09-23',
      '2026-10-10','2026-10-12','2026-11-21','2026-11-23'];
    const extra=extraDates.includes(iso);
    const stamp=x=>String(Math.floor(x/60)%24).padStart(2,'0')+':'+String(x%60).padStart(2,'0');
    const make=(id,departure,arrival,previousDay=false)=>({
      id:`koku94-in-${iso}-${id}`,board:'port',kind:'ferry',
      source:'koku94_verified_arrival',service:'国道九四フェリー',
      port:'三崎港',arrivalPort:'三崎港',direction:'arrival',
      origin:'佐賀関港',dest:'三崎港',time:arrival,
      originDepartureTime:departure,
      ...(previousDay?{originDepartureDay:'前日'}:{}),
      noSyntheticArrival:true,info:'佐賀関発の公式到着時刻'
    });
    const today=[make('previous-night','23:00','00:10',true)];
    for(let hour=7;hour<=22;hour++){
      if(hour===12&&!extra)continue;
      const departure=hour*60;
      today.push(make(String(hour),stamp(departure),stamp(departure+70)));
    }
    return today;
  }
  // Geiyo Kisen published Hab u -> Imabari inbound timetable,
  // 2024-04-01 revision: weekdays and weekends have different morning services.
  function geiyoInboundPortRows(iso) {
    const date=new Date(iso+'T12:00:00+09:00');
    const weekend=date.getDay()===0||date.getDay()===6 ||
      /-(?:08-(?:1[2-6])|12-(?:29|30|31)|01-0[1-4])$/.test(iso);
    const runs=weekend
      ? [['07:45','09:05'],['12:20','13:40'],['16:00','17:15'],['18:40','19:55']]
      : [['06:22','07:38'],['12:20','13:40'],['16:00','17:15'],['18:40','19:55']];
    return runs.map(([departure,arrival],i)=>({
      id:`geiyo-habu-imabari-${iso}-${i}`,board:'port',kind:'ferry',
      source:'imabari_geiyo_official_arrival',service:'芸予汽船 高速船',
      port:'今治港',arrivalPort:'今治港',direction:'arrival',
      origin:'土生港（因島）',dest:'今治港',time:arrival,
      originDepartureTime:departure,noSyntheticArrival:true,
      info:'土生・生名・弓削・佐島・岩城・木浦・友浦経由'
    }));
  }
  function portRolling24Rows(now) {
    const dep=currentDirection()==='departure';
    const prevIso=shiftIso(now.iso,-1);
    const nextIso=shiftIso(now.iso,1);
    const today=[...recordsForDay('port',now.iso),...gogoshimaPortRecords(now.iso),...nakajimaTakahamaCalls(now.iso),...jumboInboundPortRows(now.iso),...koku94InboundPortRows(now.iso),...geiyoInboundPortRows(now.iso)];
    const tomorrow=[...recordsForDay('port',nextIso),...gogoshimaPortRecords(nextIso),...nakajimaTakahamaCalls(nextIso),...jumboInboundPortRows(nextIso),...koku94InboundPortRows(nextIso),...geiyoInboundPortRows(nextIso)];
    const out=[];

    if(dep){
      // The departure board shows scheduled departures only until departure.
      // Once sailed, the service belongs to the arrival board instead.
      const appendDeparture=(r,serviceIso,offset,nextDay=false)=>{
        const departure=offset+toMinutes(r.time);
        if(!Number.isFinite(departure) ||
           departure<now.minutes || departure>now.minutes+1440)return;
        out.push({...r,direction:'departure',minutes:departure,_serviceIso:serviceIso,
          isNextDayStart:nextDay,sailingInProgress:false});
      };
      today.filter(r=>r.direction!=='arrival').forEach(r=>appendDeparture(r,now.iso,0));
      tomorrow.filter(r=>r.direction!=='arrival').forEach(r=>appendDeparture(r,nextIso,1440,true));
    }else{
      const pushArrival=(src,baseIso,baseOffset)=>{
        src.filter(r=>r.direction==='arrival').forEach(r=>{
          const m=toMinutes(r.time)+baseOffset;
          if(m>=now.minutes && m<=now.minutes+1440)out.push({...r,minutes:m,_serviceIso:baseIso});
        });
        src.filter(r=>false && r.direction!=='arrival' && !r.noSyntheticArrival && r.source!=='jumbo_ferry_reference' && r.source!=='koku94' && r.source!=='imabari_geiyo' && r.source!=='orange_niihama' && r.source!=='boyo' && r.source!=='port_highspeed' && r.source!=='port').map(synthPortArrival).forEach(r=>{
          let m=toMinutes(r.time);
          if(r._arrivalNextDay) m+=1440;
          m+=baseOffset;
          if(m>=now.minutes && m<=now.minutes+1440){
            out.push({...r,minutes:m,_serviceIso:baseIso});
          }
        });
      };

      const prev=recordsForDay('port',prevIso);
      // Previous-day sailings that cross midnight arrive on the current day.
      prev.filter(r=>false && r.direction!=='arrival' && !r.noSyntheticArrival && r.source!=='jumbo_ferry_reference' && r.source!=='koku94' && r.source!=='imabari_geiyo' && r.source!=='orange_niihama' && r.source!=='boyo' && r.source!=='port_highspeed' && r.source!=='port').map(synthPortArrival).filter(r=>r._arrivalNextDay).forEach(r=>{
        const m=toMinutes(r.time);
        if(m>=now.minutes && m<=now.minutes+1440){
          out.push({...r,originDepartureDay:'前日',minutes:m,_serviceIso:prevIso});
        }
      });

      pushArrival(today,now.iso,0);
      pushArrival(tomorrow,nextIso,1440);
    }

    const seen=new Set();
    return out
      .sort((x,y)=>rMinutes(x)-rMinutes(y))
      .filter(r=>{
        const key=`${r.id||''}|${r._serviceIso||''}|${r.direction||''}|${r.time||''}|${r.origin||''}`;
        if(seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function rMinutes(r){return typeof r.minutes==='number'?r.minutes:toMinutes(r.time)}
  function finalDepartureKey(board,r) {
    if (board==='rail') return 'JR松山駅';
    if (board==='air') return '松山空港';
    if (board==='port') return String(r.port||'').trim() || '出発港不明';
    return '';
  }

  function finalDepartureRows(board, now) {
    if (board==='bus') return [];
    if (board==='air') {
      if (currentDirection()!=='departure') return [];
      const iso=boardDisplayIso('air',now);
      const ctx=dayContext(iso);
      return data.records
        .filter(r=>r.board==='air' && r.direction==='departure' && validRecord(r,iso))
        .map(r=>({...r,time:effectiveTime(r,ctx),minutes:toMinutes(effectiveTime(r,ctx))}));
    }
    if (board==='rail') {
      const iso=boardDisplayIso('rail',now);
      const ctx=dayContext(iso);
      return data.records
        .filter(r=>r.board==='rail' && validRecord(r,iso))
        .map(r=>({...r,time:effectiveTime(r,ctx),minutes:toMinutes(effectiveTime(r,ctx))}));
    }
    if (board==='port') {
      if (currentDirection()!=='departure') return [];
      return recordsForDay('port',now.iso).map(r=>({...r,minutes:toMinutes(r.time)}));
    }
    return [];
  }

  function nextRows(board, now) {
    // 00:00–04:29: do not show the following day's early JR/bus/air departures.
    // Overnight operational exceptions require their own verified-day handling.
    if (now.minutes < TRANSPORT_DAY_START_MINUTE) {
      if (board==='rail') {
        // Exception: explicitly dated EXTRA passenger trains actually running
        // between midnight and 04:29 remain visible. Do not preload 04:30+
        // regular service or an early train from the next timetable day.
        return recordsForDay('rail',now.iso)
          .filter(r=>r.kind==='extra' && r.direction===currentRailDir() &&
            toMinutes(r.time)>=now.minutes &&
            toMinutes(r.time)<TRANSPORT_DAY_START_MINUTE)
          .map(r=>({...r,minutes:toMinutes(r.time),railTimetableOnly:true,
            displayIso:now.iso}));
      }
      if(board==='bus' || board==='air')return [];
    }
    // Ferries are a rolling 24-hour board, not a calendar-day board.
    // Keep overnight sailings visible until arrival, including next-day arrivals.
    if(board==='port'){
      const list=portRolling24Rows(now);
      const finalTimes=new Map();
      const departureCounts=new Map();
      finalDepartureRows(board,now).forEach(r=>{
        const key=finalDepartureKey(board,r);
        const m=rMinutes(r);
        departureCounts.set(key,(departureCounts.get(key)||0)+1);
        if(!finalTimes.has(key)||m>finalTimes.get(key)) finalTimes.set(key,m);
      });
      return list.map(r=>{
        const key=finalDepartureKey(board,r);
        const enoughServices=(departureCounts.get(key)||0)>=2;
        const sameDayDeparture=currentDirection()==='departure' && !r.isNextDayStart && r._serviceIso===now.iso;
        const isFinal=sameDayDeparture && enoughServices && finalTimes.has(key) && finalTimes.get(key)===toMinutes(r.time);
        return {...r,isFinal};
      });
    }

    // Keep the full published JR timetable visible. Only live-confirmed
    // services may claim a train's actual position; the others say "時刻表".
    const list=board==='rail'
      ? (() => {
          const scheduled=getBoardRecords(board,now);
          const verified=liveRailPassengerRows(scheduled,now);
          const base=scheduled.map(r=>{
            const live=verified.find(x=>x.direction===r.direction &&
              padTime(x.time)===padTime(r.time) && x.kind===r.kind &&
              x.service===r.service && x.dest===r.dest);
            return live ? {...live,railPositionConfirmed:true}
              : {...r,railTimetableOnly:true};
          });
          // Display an additional, actually observed service even when the
          // monthly published timetable does not contain it. The diagram alone
          // never establishes that a train is running.
          if(!jrPositionFeedFresh() || boardDisplayIso('rail',now)!==now.iso) return base;
          const active=Array.isArray(approachLive.ichitsubo?.matsuyamaActiveTrains)
            ? approachLive.ichitsubo.matsuyamaActiveTrains : [];
          const known=new Set(verified.map(v=>String(v.liveTrainNum||'')));
          const specialNums=new Set((approachLive.ichitsubo?.matsuyamaSpecialTrains||[]).map(x=>String(x.trainNum||'')));
          const extras=[];
          const displayedRailDirection=currentRailDir();
          for(const x of active){
            const num=String(x.trainNum||'').trim(),time=padTime(x.departure||'');
            const sourceDirection=String(x.direction||'');
            const destination=cleanStation(x.destination||'');
            const destinationDirection=railDirectionByDestination(destination);
            if(!num || specialNums.has(num) || !(/^[0-9]{2}:[0-9]{2}$/.test(time)) ||
                !['north','south'].includes(sourceDirection) ||
                // Live-only extra services must NEVER leak into the opposite page.
                sourceDirection!==displayedRailDirection ||
                // A contradictory direction/destination is not reliable departure data.
                (destinationDirection && sourceDirection!==destinationDirection) ||
                !jrPositionUsable(x.position) || toMinutes(time)<now.minutes ||
                known.has(num)) continue;
            const duplicate=base.some(r=>r.direction===sourceDirection && padTime(r.time)===time &&
              ((r.kind==='limited')===(x.trainClass==='limited')));
            if(duplicate) continue; // no ambiguous extra identity on the board
            known.add(num);
            const named=railLiveTrainLabel(x);
            const limited=x.trainClass==='limited' && named.kind==='limited';
            extras.push({
              board:'rail',direction:sourceDirection,time,kind:limited?'limited':'local',
              service:limited?named.service:'当日運行列車',
              dest:destination||'行先確認中',
              info:'非公式列車運行情報・当日位置確認／列車番号 '+num,
              id:'live-extra-'+num,source:'jr_unofficial_live',
              liveTrainNum:num,livePosition:cleanStation(x.position),
              liveDelayMinutes:Number(x.delayMinutes)||0,railPositionConfirmed:true,
              vehicleImageNorth:String(x.vehicleImageNorth||''),
              vehicleImageSouth:String(x.vehicleImageSouth||''),
              vehicleImageSource:String(x.vehicleImageSource||''),
              isExtraRunning:true
            });
          }
          return [...base,...extras];

        })()
      : getBoardRecords(board,now);

    // Unified definition:
    // FINAL = the last service that DEPARTS from that place on that day.
    // Bus board intentionally has no "final bus" badge.
    // Arrival boards intentionally have no "final" badge.
    const finalTimes=new Map();
    const departureCounts=new Map();
    finalDepartureRows(board,now).forEach(r=>{
      const key=finalDepartureKey(board,r);
      const m=rMinutes(r);
      departureCounts.set(key,(departureCounts.get(key)||0)+1);
      if(!finalTimes.has(key)||m>finalTimes.get(key)) finalTimes.set(key,m);
    });

    const upcoming = list.filter(r => rMinutes(r) >= now.minutes).map(r => {
      const key=finalDepartureKey(board,r);
      const enoughServices = board!=='port' || (departureCounts.get(key)||0) >= 2;
      const isFinal=board!=='bus' && enoughServices && finalTimes.has(key) && finalTimes.get(key)===rMinutes(r);
      return {
        ...r,
        isFinal,
        isNextDayStart: false
      };
    });
    return upcoming;
  }

  function railStops(record) {
    const s = String(record.service || '');
    if (/宇和海/.test(s)) return ['伊予市','内子','八幡浜','卯之町','宇和島'];
    if (/しおかぜ|いしづち/.test(s)) return ['今治','壬生川','伊予西条','新居浜','丸亀','岡山'];
    return [record.dest];
  }
  function addClock(time, offset) {
    const base = toMinutes(padTime(time||''));
    if (!Number.isFinite(base) || !Number.isFinite(offset)) return '';
    const total = base + offset;
    const hh = Math.floor(((total % 1440) + 1440) % 1440 / 60);
    const mm = ((total % 60) + 60) % 60;
    return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  }
  function railExactTimings(record) {
    const raw=Array.isArray(approachLive.ichitsubo?.matsuyamaSchedule)
      ? approachLive.ichitsubo.matsuyamaSchedule
      : [];
    const departure=padTime(record.time||'');
    const direction=String(record.direction||'');
    const matches=raw.filter(x=>padTime(x?.departure||'')===departure && String(x?.direction||'')===direction);
    if(!matches.length) return null;

    const stops=[];
    const seen=new Set();
    matches.forEach(x=>{
      (Array.isArray(x?.stops)?x.stops:[]).forEach(s=>{
        const station=cleanStation(s?.station||'');
        const time=padTime(s?.time||'');
        const key=`${station}|${time}`;
        if(station&&time&&!seen.has(key)){seen.add(key);stops.push({station,time});}
      });
    });
    stops.sort((a,b)=>{
      let am=toMinutes(a.time), bm=toMinutes(b.time);
      if(am<toMinutes(departure)) am+=1440;
      if(bm<toMinutes(departure)) bm+=1440;
      return am-bm;
    });

    const terminals=matches.map(x=>{
      const t=x?.terminal;
      return t ? {station:cleanStation(t.station||''),time:padTime(t.time||'')} : null;
    }).filter(x=>x?.station&&x?.time);
    const terminalSeen=new Set();
    const uniqueTerminals=terminals.filter(x=>{
      const k=`${x.station}|${x.time}`;
      if(terminalSeen.has(k)) return false;
      terminalSeen.add(k);
      return true;
    });
    return {stops,terminals:uniqueTerminals};
  }
  function railTerminalArrivalText(record) {
    const exact=railExactTimings(record);
    if(!exact?.terminals?.length) return '';
    return exact.terminals.map(x=>`${x.station} ${x.time}`).join(' / ');
  }
  function railTimedStops(record) {
    const exact=railExactTimings(record);
    if(!exact?.stops?.length) return [];
    const destText=String(record.dest||'');
    // Coupled Shiokaze/Ishizuchi services can have two branches. Keep all exact
    // timed stops returned by the daily diagram; duplicates were removed above.
    return exact.stops.map(x=>`${x.station}(${x.time})`);
  }
  function busVia(record) {
    const d = String(record.dest || record.origin || '');
    if (/高松/.test(d)) return '松山インター口 → 川内インター → 高速善通寺 → 高松中央';
    if (/徳島/.test(d)) return '松山インター口 → 川内インター → 三島川之江IC → 徳島駅';
    if (/高知/.test(d)) return '松山インター口 → 川内インター → 高知 → はりまや橋';
    if (/岡山/.test(d)) return '松山インター口 → 川内インター → 瀬戸大橋 → 岡山';
    if (/大阪|神戸|京都|USJ/.test(d)) return '松山インター口 → 川内インター → 高速舞子 → 神戸三宮 → 大阪方面';
    if (/福山|新尾道/.test(d)) return '川内インター → 来島海峡BS → 瀬戸田 → 新尾道 → 福山';
    if (/東京|横浜/.test(d)) return '余戸南インター → 松山インター口 → 川内インター → 横浜 → 東京';
    if (/福岡/.test(d)) return '余戸南インター → 松山インター口 → 川内インター → 今治 → 小倉 → 博多';
    return record.info || '主要経由地の案内はありません';
  }
  // Published ferry ship roster. Add a new month only after checking its
  // official dated roster; never carry October's alternating pattern forward.
  // Source: https://setonaikaikisen.co.jp/wp-content/uploads/2026/06/202610seapaseo.pdf
  // Timings below are lookup keys, not a substitute for the operator timetable.
  const HIROSHIMA_FERRY_SHIPS={
    '2026-10':{
      fromHiroshima:{
        times:['05:45','06:45','08:05','09:15','11:20','12:35','13:40','15:05','17:15','19:30'],
        odd: ['P','P2','S','A','P','P2','S','A','P','S'],
        even:['P2','P','A','S','P2','P','A','S','P2','A']
      },
      fromMatsuyama:{
        times:['06:20','08:25','09:40','11:00','12:10','14:15','15:30','16:35','18:00','20:10'],
        odd: ['A','P','P2','S','A','P','P2','S','A','P'],
        even:['S','P2','P','A','S','P2','P','A','S','P2']
      }
    }
  };
  const HIROSHIMA_FERRY_SHIP_NAMES={
    P:'シーパセオ',P2:'シーパセオ2',S:'翔洋丸',A:'旭洋丸'
  };
  function hiroshimaFerryScheduledVessel(record) {
    if(!/クルーズフェリー/.test(String(record.service||'')))return '';
    // Use the service date rather than the display's current date: the port
    // board includes tomorrow's departures and arrivals in a 24-hour window.
    const iso=String(record._serviceIso||record.displayIso||japanNow().iso);
    const match=/^(\d{4}-\d{2})-(\d{2})$/.exec(iso);
    if(!match)return '';
    const roster=HIROSHIMA_FERRY_SHIPS[match[1]];
    const day=Number(match[2]);
    if(!roster || day<1 || day>31)return '';
    const inbound=record.direction==='arrival';
    if(inbound && record.source!=='port_cruise_official_in')return '';
    if(!inbound && record.source!=='port')return '';
    const series=inbound?roster.fromHiroshima:roster.fromMatsuyama;
    const departure=padTime(inbound?record.originDepartureTime:record.time);
    const slot=series.times.indexOf(departure);
    if(slot<0)return '';
    const shipCode=(day%2?series.odd:series.even)[slot];
    return HIROSHIMA_FERRY_SHIP_NAMES[shipCode]||'';
  }

  // Linear-jet coloured sailing assignment on the operator's normal timetable:
  // https://www.setonaikaikisen.co.jp/kouro/jet/
  // Inbound blue rows are services 1/3/5/7; outbound blue rows are 2/4/6/8.
  // The regular assignment is only applied to the verified October dates
  // before the announced 2026-10-31 docking timetable begins.
  function hiroshimaJetScheduledVessel(record) {
    if(record.source!=='port_highspeed' || String(record.service||'')!=='高速船')return '';
    const iso=String(record._serviceIso||record.displayIso||japanNow().iso);
    if(!/^2026-10-(?:0[1-9]|[12]\d|30)$/.test(iso))return '';
    const inbound=record.direction==='arrival';
    const times=['07:30','09:05','10:50','12:25','15:15','16:45','18:30','20:00'];
    const departure=padTime(inbound?record.originDepartureTime:record.time);
    const index=times.indexOf(departure);
    if(index<0)return '';
    const aivint=inbound ? index%2===0 : index%2===1;
    return aivint?'アイヴィント':'シーマックス';
  }

  // Hiroshima/Kure–Matsuyama is shared by two companies.
  // An individual operator must come from an explicitly identified vessel or
  // operator field; the departure clock alone cannot establish the vessel,
  // because published rosters change by day and operational substitutions occur.
  function hiroshimaPortOperator(record, type) {
    const scheduled=type==='高速船' ? hiroshimaJetScheduledVessel(record) : hiroshimaFerryScheduledVessel(record);
    const explicitlyNamed=record.confirmedShipName||record.shipName||record.vesselName||record.vessel||'';
    const vessel=String(explicitlyNamed||scheduled).trim();
    const stated=String(record.confirmedOperator||record.operatingCompany||'').trim();
    const byVessel=/^(?:シーパセオ(?:2|２)?|SEA\s*PASEO(?:\s*2)?|AIVINT|アイヴィント)$/i.test(vessel)
      ? '瀬戸内海汽船'
      : /^(?:旭洋丸|翔洋丸|シーマックス|SEA\s*MAX)$/i.test(vessel)
      ? '石崎汽船' : '';
    const byOperator=/^(?:瀬戸内海汽船|石崎汽船)$/.test(stated)?stated:'';
    if ((byVessel&&byOperator&&byVessel!==byOperator) || (!byVessel&&!byOperator))
      return {name:'船社未確認',type:type+'・共同運航'};
    return {name:byVessel||byOperator,
      type:vessel?vessel+(scheduled&&!explicitlyNamed?'（予定）':''):type};
  }

  function portOperator(record) {
    const svc = String(record.service || '');
    if (record.source==='matsuyama_city_cruise') return { name:svc, type:'大型クルーズ船' };
    if (/芸予汽船/.test(svc)) return { name:'芸予汽船', type:'高速船' };
    if (/第二せきぜん/.test(svc)) return { name:'今治市営', type:'フェリー 第二せきぜん' };
    if (/とびしま/.test(svc)) return { name:'今治市営', type:'旅客船 とびしま' };
    if (/大三島ブルーライン/.test(svc)) return { name:'大三島ブルーライン', type:'フェリー' };
    if (/青島海運|あおしま/.test(svc)) return { name:'青島海運', type:'旅客船 あおしま' };
    if (/新居浜市営/.test(svc)) return { name:'新居浜市営', type:'渡海船' };
    if (/クルーズフェリー/.test(svc)) return hiroshimaPortOperator(record,'フェリー');
    if (/^高速船$/.test(svc) && record.source==='port_highspeed') return hiroshimaPortOperator(record,'高速船');
    if (/中島/.test(svc)) return { name:'中島汽船', type:/西線/.test(svc)?'フェリー 西線':'フェリー' };
    if (/防予フェリー/.test(svc)) return { name:'防予フェリー', type:'フェリー' };
    if (/国道九四フェリー/.test(svc)) return { name:'国道九四フェリー', type:'フェリー' };
    if (/宇和島運輸/.test(svc)) return { name:'宇和島運輸', type:'フェリー' };
    if (/オレンジフェリー/.test(svc)) return { name:'四国開発フェリー', type:'フェリー' };
    if (/ジャンボフェリー/.test(svc)) return { name:'ジャンボフェリー', type:'京阪神連絡・参考' };
    return { name: svc || '運航会社', type:'船便' };
  }

  function ferryMiniLogo(name) {
    const n=String(name||'').trim();

    // Keep the established company colors, but use plain readable operator names
    // instead of forcing each operator into a pseudo-logo treatment.
    if(n==='四国開発フェリー') return '<span class="ferry-mini-logo ferry-logo-orange">四国開発フェリー</span>';
    if(n==='中島汽船') return '<span class="ferry-mini-logo ferry-logo-nakajima">中島汽船</span>';
    if(n==='防予フェリー') return '<span class="ferry-mini-logo ferry-logo-boyo">防予フェリー</span>';
    if(n==='国道九四フェリー') return '<span class="ferry-mini-logo ferry-logo-94">国道九四フェリー</span>';
    if(n==='宇和島運輸') return '<span class="ferry-mini-logo ferry-logo-uwajima">宇和島運輸</span>';
    if(n==='ジャンボフェリー') return '<span class="ferry-mini-logo ferry-logo-jumbo">ジャンボフェリー</span>';
    if(n==='今治市営') return '<span class="ferry-mini-logo ferry-logo-imabari">今治市営</span>';
    if(n==='大三島ブルーライン') return '<span class="ferry-mini-logo ferry-logo-blue">大三島ブルーライン</span>';
    if(n==='芸予汽船') return '<span class="ferry-mini-logo ferry-logo-geiyo">芸予汽船</span>';
    if(n==='瀬戸内海汽船') return '<span class="ferry-mini-logo ferry-logo-setouchi">瀬戸内海汽船</span>';
    if(n==='石崎汽船') return '<span class="ferry-mini-logo ferry-logo-ishizaki">石崎汽船</span>';
    if(n==='船社未確認') return '<span class="ferry-mini-logo ferry-logo-unknown">船社未確認</span>';
    if(n==='青島海運') return '<span class="ferry-mini-logo ferry-logo-aoshima">青島海運</span>';
    if(n==='新居浜市営') return '<span class="ferry-mini-logo ferry-logo-niihama">新居浜市営</span>';
    return '';
  }

  const PORT_WARNING = '⚠ 乗り場注意：松山観光港・三津浜港・高浜港・今治港・東予港・新居浜東港・高松東港・八幡浜港・三崎港は、それぞれ乗り場が違います';
  const EHIME_PORTS = new Set(['松山観光港','三津浜港','高浜港','今治港','東予港','新居浜東港','八幡浜港','三崎港']);
  function ehimePortHtml(name) {
    const n = String(name || '');
    return n ? `<span class="route-port">${n}</span>` : '—';
  }
  function jumboPortHtml(name) {
    const n=String(name||'');
    if (/高松/.test(n)) return `<span class="kagawa-port"><span class="kagawa-badge">香川</span>${n}</span>`;
    return `<span class="route-port">${n}</span>`;
  }

  function portDestinationName(dest) {
    const d = String(dest || '').replace(/（.*?）/g, '').trim();
    const names = {
      '広島': '広島港', '呉': '呉港', '柳井': '柳井港', '大阪南港': '大阪南港',
      '別府': '別府港', '臼杵': '臼杵港', '佐賀関': '佐賀関港', '神戸': '神戸港',
      '中島・大浦': '中島（大浦）', '中島': '中島', '西中':'西中港', '岡村':'岡村港', '木江':'木江港', '青島':'青島', '大島':'大島', '神戸六甲港':'神戸六甲港'
    };
    return names[d] || d;
  }

  function portViaLabel(record) {
    const text = `${record.service || ''} ${record.dest || ''} ${record.info || ''}`;
    if (/呉経由/.test(text)) return '呉経由';
    if (/観光港経由/.test(text)) return '松山観光港経由';
    if (/小豆島|坂手/.test(text)) return '小豆島（坂手）経由・参考';
    if (/京阪神連絡/.test(text)) return '京阪神連絡・参考';
    if (/直行/.test(text)) return '直行';
    return '';
  }

  function isHiroshimaKureVia(record) {
    const svc=String(record.service||'');
    const text=`${record.dest||''} ${record.info||''}`;
    return /広島/.test(String(record.dest||'')) &&
      /呉経由/.test(text) &&
      (/クルーズフェリー/.test(svc) || /^高速船$/.test(svc));
  }

  function portKureUnifiedHtml(record, direction='departure', badges='') {
    const localPort=record.port || '松山観光港';
    const from=direction==='arrival' ? '広島港' : localPort;
    const to=direction==='arrival' ? localPort : '広島港';
    const main=`<span class="route-port">${from}</span><span class="route-arrow"> → </span><span class="route-port">${to}</span>${badges?' '+badges:''}`;
    return `<span class="port-dest-main port-kure-unified no-auto-scroll">${main}</span>`;
  }

  function portRoute(record, direction = 'departure') {
    const svc = String(record.service || '');
    const text = `${record.dest || ''} ${record.info || ''}`;
    const start = record.port || '出発港';
    let route;

    if (/クルーズフェリー/.test(svc) && /広島/.test(record.dest || '')) {
      route = /呉経由/.test(text)
        ? [start, '呉港', '広島港']
        : [start, '広島港'];
    } else if (/中島/.test(svc)) {
      const end = portDestinationName(record.dest || '中島・大浦');
      route = /観光港経由/.test(text)
        ? [start, '松山観光港', end]
        : [start, end];
    } else {
      route = [start, portDestinationName(record.dest)];
    }

    const clean = route.filter((x, i, a) => x && (i === 0 || x !== a[i - 1]));
    if (direction === 'arrival') clean.reverse();
    return clean.join(' → ');
  }

  function portRouteParts(record, direction = 'departure') {
    // Explicit Takahama inbound calls already contain their actual origin.
    // Do not reverse a destination of Takahama back into "Takahama → Takahama".
    if(direction==='arrival' && record.source==='koku94_verified_arrival') return ['佐賀関港','三崎港'];
    if(direction==='arrival' && record.source==='imabari_geiyo_official_arrival') return ['土生港（因島）','今治港'];
    if(direction==='arrival' && record.source==='jumbo_ferry_official_arrival') return ['神戸港', ...(String(record.info||'').includes('小豆島')?['小豆島（坂手）']:[]), '高松東港'];
    if(direction==='arrival' && (record.source==='gogoshima_official' || record.source==='nakajima_takahama_call')) {
      const origin=String(record.origin||'').trim();
      return [origin && origin!=='高浜港' ? origin : '出発港未確認','高浜港'];
    }
    const svc = String(record.service || '');
    const text = `${record.dest || ''} ${record.info || ''}`;
    const start = record.port || '出発港';
    let route;
    if (/クルーズフェリー/.test(svc) && /広島/.test(record.dest || '')) {
      route = /呉経由/.test(text) ? [start, '呉港', '広島港'] : [start, '広島港'];
    } else if (/中島/.test(svc)) {
      const end = portDestinationName(record.dest || '中島・大浦');
      route = /観光港経由/.test(text) ? [start, '松山観光港', end] : [start, end];
    } else if (/ジャンボフェリー/.test(svc) && /小豆島|坂手/.test(text)) {
      route = [start, '小豆島（坂手）', portDestinationName(record.dest)];
    } else {
      route = [start, portDestinationName(record.dest)];
    }
    const clean = route.filter((x, i, a) => x && (i === 0 || x !== a[i - 1]));
    return direction === 'arrival' ? clean.reverse() : clean;
  }
  function portRouteHtml(record, direction = 'departure') {
    const jumbo=/ジャンボフェリー/.test(String(record.service||''));
    return portRouteParts(record, direction).map(x => jumbo ? jumboPortHtml(x) : `<span class="route-port">${x}</span>`).join('<span class="route-arrow"> → </span>');
  }

  const CRUISE_DEPARTURE_CALLS = {
    '06:20': [['呉港','08:17'],['広島港','09:02']],
    '08:25': [['呉港','10:22'],['広島港','11:07']],
    '09:40': [['呉港','11:37'],['広島港','12:22']],
    '11:00': [['広島港','13:27']],
    '12:10': [['呉港','14:07'],['広島港','14:52']],
    '14:15': [['呉港','16:12'],['広島港','16:57']],
    '15:30': [['呉港','17:27'],['広島港','18:12']],
    '16:35': [['呉港','18:32'],['広島港','19:17']],
    '18:00': [['呉港','19:57'],['広島港','20:42']],
    '20:10': [['呉港','22:07'],['広島港','22:52']]
  };
  const HIGHSPEED_DEPARTURE_CALLS = {
    '07:30': [['広島港','08:50']],
    '09:05': [['呉港','10:10'],['広島港','10:35']],
    '10:50': [['広島港','12:10']],
    '12:25': [['呉港','13:30'],['広島港','13:55']],
    '15:15': [['広島港','16:35']],
    '16:45': [['呉港','17:50'],['広島港','18:15']],
    '18:30': [['広島港','19:50']],
    '20:00': [['広島港','21:20']]
  };
  const NAKAJIMA_DEPARTURE_CALLS = {
    '06:55': [['高浜港','07:10'],['大浦港','08:15']],
    '10:10': [['松山観光港','10:30'],['睦月港','10:55'],['野忽那港','11:12'],['大浦港','11:30']],
    '13:00': [['高浜港','13:15'],['大浦港','13:55']],
    '15:50': [['高浜港','16:05'],['睦月港','16:35'],['野忽那港','16:52'],['大浦港','17:10']],
    '19:05': [['松山観光港','19:30'],['睦月港','19:55'],['大浦港','20:14']]
  };
  function portDepartureCalls(record) {
    if(record.source==='matsuyama_city_cruise') return []; // The next port's arrival time is not published here.
    if (Array.isArray(record.calls) && record.calls.length) return record.calls;
    if (record.arrivalTime) return [[portDestinationName(record.dest), record.arrivalTime]];
    const svc=String(record.service||'');
    if (/クルーズフェリー/.test(svc) && /広島/.test(record.dest||'')) return CRUISE_DEPARTURE_CALLS[record.time] || [];
    if (/高速船/.test(svc) && /広島/.test(record.dest||'')) return HIGHSPEED_DEPARTURE_CALLS[record.time] || [];
    if (/中島/.test(svc) && /大浦/.test(record.dest||'')) return NAKAJIMA_DEPARTURE_CALLS[record.time] || [];
    const t=addMinutes(record.time, portTravelMinutes(record));
    const next=toMinutes(t)<toMinutes(record.time);
    return [[portDestinationName(record.dest), `${next?'翌':''}${t}`]];
  }
  function compactPortName(name) {
    const n=String(name||'');
    if (n==='松山観光港') return '観光港';
    return n.replace(/港$/,'');
  }
  function portTimeStackHtml(record) {
    const calls=portDepartureCalls(record);
    if (!calls.length) return `<span class="primary-time">${record.time}</span>`;
    const chunks=calls.map(([name,time],i)=>`${compactPortName(name)} ${time}${i===calls.length-1?'予定':''}`);
    let lines=[];
    if (chunks.length<=2) lines=chunks;
    else if (chunks.length===3) lines=[chunks.slice(0,2).join('・'),chunks[2]];
    else {
      const first=calls[0], last=calls[calls.length-1];
      lines=[`${compactPortName(first[0])} ${first[1]}ほか`,`${compactPortName(last[0])} ${last[1]}予定`];
    }
    return `<span class="primary-time">${record.time}</span>${lines.map(x=>`<span class="port-arrival-line">${x}</span>`).join('')}`;
  }
  function portDepartureDestinationHtml(record, badges='') {
    if (isHiroshimaKureVia(record)) return portKureUnifiedHtml(record,'departure',badges);
    const calls=portDepartureCalls(record);
    const terminal=(calls.length ? calls[calls.length-1][0] : portDestinationName(record.dest)) || portDestinationName(record.dest);
    const via=calls.slice(0,-1).map(x=>x[0]);
    const displayTerminal=/中島/.test(String(record.service||'')) && /大浦/.test(String(record.dest||'')) ? '中島（大浦）' : terminal;
    const start=record.port || '出発港';
    const jumbo=/ジャンボフェリー/.test(String(record.service||''));
    const startHtml=jumbo?jumboPortHtml(start):`<span class="route-port">${start}</span>`;
    const terminalHtml=jumbo?jumboPortHtml(displayTerminal):`<span class="route-port">${displayTerminal}</span>`;
    const viaNames=via.map(compactPortName);
    const viaLines=[];
    if (viaNames.length===1) viaLines.push(`${viaNames[0]}寄港`);
    else if (viaNames.length===2) viaLines.push(`${viaNames.join('・')}寄港`);
    else if (viaNames.length>=3) {
      const split=Math.ceil(viaNames.length/2);
      viaLines.push(`${viaNames.slice(0,split).join('・')}寄港`);
      viaLines.push(`${viaNames.slice(split).join('・')}寄港`);
    }
    return `<div class="port-dest-wrap"><span class="port-dest-main">${startHtml}<span class="route-arrow"> → </span>${terminalHtml} ${badges}</span>${viaLines.map(x=>`<span class="port-via-line">${x}</span>`).join('')}</div>`;
  }

  function liveAlertSpan(text, cls, strong=false) {
    const fast=String(text).length>23;
    return `<span class="${cls}${strong?' strong-text':''}${fast?' fast-scroll-text':''}">${text}</span>`;
  }
  function chooseAlert(items, now) {
    if (!items.length) return null;
    return items[Math.floor(Number(now.sec)/4)%items.length];
  }
  function isFinalAuxTime(board,direction,now,time) {
    const rows=auxRows(board,direction,now);
    const last=rows[rows.length-1];
    return !!(last && padTime(last.time)===padTime(time));
  }
  function isKnownStadiumScheduledTime(time, now) {
    const t=padTime(time||'');
    if(!/^\d{2}:\d{2}$/.test(t)) return false;
    return auxRows('stadium',null,now).some(r=>padTime(r.time)===t);
  }
  function madonnaTakeover(now) {
    const live=approachLive.madonna;
    if (!approachLive.ok || !live?.ok) return null;

    // Do not trust a stale "約0分" value from the bus-location page.
    // Recalculate against the predicted/scheduled departure on every render.
    const scheduledTime=live.scheduledDeparture||'';
    // Hard guard: the bus-location page sometimes exposes another stop's time.
    // Only a departure that exists in today's official Madonna Stadium timetable
    // is allowed to trigger the large Matsuyama-shi Station alert.
    if(!isKnownStadiumScheduledTime(scheduledTime,now)) return null;
    const liveTime=live.predictedDeparture||scheduledTime;
    const clockMins=/^\d{1,2}:\d{2}$/.test(String(liveTime)) ? minutesUntil(liveTime,now.minutes) : NaN;
    const serverMins=Number(live.minutesUntilDeparture);
    const stops=Number(live.stopsAway);
    const mins=Number.isFinite(clockMins)?clockMins:serverMins;

    // A failed/old API response must never leave the takeover stuck on screen.
    const generatedAt=Date.parse(String(approachLive.generatedAtJst||''));
    const fresh=!Number.isFinite(generatedAt) || (Date.now()-generatedAt)<=90000;
    if (!fresh) return null;

    const active=Number.isFinite(mins)?(mins>=-1&&mins<=4):(Number.isFinite(stops)&&stops<=2);
    if (!active) return null;
    const departing=Number.isFinite(mins)&&mins<=2;
    const strong=Number.isFinite(mins)&&mins<=1;
    const text=departing?'まもなく松山市駅行きのバスが発車します。':'まもなく松山市駅行きのバスが到着します。';
    return {items:[liveAlertSpan(text,'bus-alert',strong)],className:`live-takeover bus-live${strong?' strong-live':''}${text.length>23?' fast-scroll':''}`};
  }
  function highwayLiveItems() {
    const rows=slowLive.highway?.items;
    if (!Array.isArray(rows)||!rows.length) return [];
    return rows.map(x=>`高速バスLIVE｜${x.operator} ${x.route}｜${x.status}`);
  }
  function busTickerItems(now) {
    const takeover=madonnaTakeover(now);
    if (takeover) return takeover.items;
    const items=highwayLiveItems();

    // Airport-bound buses belong with the city-side bus information:
    // show the next limousine / ordinary services from Matsuyama City Station
    // and JR Matsuyama Station in the BUS ticker, not as labels on the airport board.
    const airportTo=airportAccessNotes(now,'departure');
    airportTo.forEach(x=>items.push(`空港アクセス｜${x}`));

    if (!items.length) items.push('WILLER EXPRESS｜松山市駅・JR松山駅には停車しません｜松山一番町をご利用ください');
    const live=approachLive.madonna;
    if (approachLive.ok&&live?.ok&&live.predictedDeparture&&isKnownStadiumScheduledTime(live.scheduledDeparture,now)) {
      const localDiff=minutesUntil(live.predictedDeparture,now.minutes);
      const diff=Number.isFinite(localDiff)?`｜約${localDiff}分後`:'';
      items.push(`マドンナスタジアム｜51系統 松山市駅行｜発車予測 ${padTime(live.predictedDeparture)}${diff}`);
    } else {
      const stadium=nextAux('stadium',null,now);
      items.push(stadium?`マドンナスタジアム｜51系統 松山市駅行｜次便 ${stadium.time}発`:'マドンナスタジアム｜運行終了');
    }
    return items;
  }

  function panelNotes(board, rows) {
    const first = rows[0];
    if (board === 'rail' || board === 'air') return [''];
    if (board === 'bus') return busTickerItems(japanNow());
    if (!first) return board === 'port' ? [PORT_WARNING] : ['運行終了'];
    if (board === 'port') return [PORT_WARNING];
    return ['案内なし'];
  }

  function badgeHtml(kind, label) {
    if (kind === 'final') return `<span class="final-badge">${label || '最終'}</span>`;
    return `<span class="first-badge">${label || '翌日始発'}</span>`;
  }

  function tickerHtml(items) {
    const content=items.join('<span class="ticker-sep">◆</span>');
    const plainLen=items.join(' ◆ ').replace(/<[^>]+>/g,'').length;
    const fast=items.some(x=>/fast-scroll-text/.test(String(x)))||plainLen>88;
    const dur=fast?Math.max(9,Math.min(18,Math.round(plainLen*.15))):Math.max(22,Math.min(60,Math.round(plainLen*.34)));
    return `<div class="marquee"><div class="marquee-track" style="--ticker-duration:${dur}s"><span>${content}</span><span aria-hidden="true">${content}</span></div></div>`;
  }

  // Live-feed diagram connections. Never claim a platform, guaranteed
  // connecting hold, or "same-platform change" from timetable data alone.
  function railLocalConnectionItems(record) {
    if(!record||!['limited','local'].includes(String(record.kind||'')))return [];
    const feed=approachLive.ichitsubo;
    if(!feed?.ok||!Array.isArray(feed.matsuyamaSchedule))return [];
    const fetched=Date.parse(String(approachLive.generatedAtJst||''));
    const now=japanNow();
    if(!Number.isFinite(fetched)||Date.now()-fetched>120000 ||
       Date.now()-fetched < -15000 || record.displayIso && record.displayIso!==now.iso)return [];
    const departure=padTime(record.time||'');
    const matches=feed.matsuyamaSchedule.filter(x=>
      padTime(x?.departure||'')===departure &&
      x?.direction===record.direction &&
      x?.trainClass===record.kind
    );
    const numbered=String(record.liveTrainNum||'');
    let selected=numbered
      ? matches.filter(x=>String(x.trainNum||'')===numbered)
      : [];
    if(selected.length!==1 && record.kind==='limited') {
      selected=matches.filter(x=>railLiveTrainLabel(x).service===
        String(record.service||''));
    }
    if(selected.length!==1 && matches.length===1)selected=matches;
    if(selected.length!==1)return []; // Avoid ambiguous same-minute services.
    const transfers=Array.isArray(selected[0].transfers)?selected[0].transfers:[];
    const seen=new Set();
    return transfers.filter(t=>{
      const station=cleanStation(t?.station||'');
      const arrival=padTime(t?.arrival||'');
      const departure2=padTime(t?.departure||'');
      const transferMinutes=Number(t?.minutes);
      const key=station+'|'+departure2+'|'+String(t?.trainNum||'');
      if(t?.source!=='today_diagram'||
         !station||!/^\d{2}:\d{2}$/.test(arrival)||
         !/^\d{2}:\d{2}$/.test(departure2)||
         !Number.isFinite(transferMinutes)||
         transferMinutes<4||transferMinutes>40||seen.has(key))return false;
      seen.add(key);return true;
    }).slice(0,3).map(t=>{
      const station=railSpecialText(cleanStation(t.station||''));
      const dest=railSpecialText(cleanStation(t.destination||'')||'行先確認中');
      const arrival=padTime(t.arrival);
      const departure2=padTime(t.departure);
      const waiting=t.localArrivesFirst===true &&
        /^\d{2}:\d{2}$/.test(padTime(t.scheduledLocalArrival||''))
        ? '・普通は'+padTime(t.scheduledLocalArrival)+'着予定' : '';
      // "先着" describes the diagram, not a live platform/dispatch check.
      return '当日運行図の乗換案内：'+station+' '+arrival+
        '着 → 普通 '+dest+'行 '+departure2+'発（乗換時間'+
        Math.round(Number(t.minutes))+'分'+waiting+'）';
    });
  }

  // Explain a diagram-confirmed encounter in passenger-facing terms.
  // The diagram proves that two trains share a station/time; it does NOT
  // prove that dispatch will hold a train or guarantee a passenger transfer.
  // Never expose raw operational IDs (e.g. 23M) or speculative "connection?"
  // messages to passengers. Counter-train destinations come from the same
  // day's actual route in the approach feed, not from timetable guesswork.
  function railLocalWaitAndMeetItems(record) {
    if(record?.kind!=='local')return [];
    const source=approachLive.ichitsubo;
    if(!source?.ok||!Array.isArray(source.matsuyamaSchedule))return [];
    const fetched=Date.parse(String(approachLive.generatedAtJst||''));
    const now=japanNow();
    if(!Number.isFinite(fetched)||Date.now()-fetched>120000 ||
       Date.now()-fetched < -15000 ||
       (record.displayIso&&record.displayIso!==now.iso))return [];
    const matching=source.matsuyamaSchedule.filter(x=>
      x?.trainClass==='local'&&x?.direction===record.direction&&
      padTime(x?.departure||'')===padTime(record.time||''));
    const liveNum=String(record.liveTrainNum||'');
    const selected=liveNum?
      matching.filter(x=>String(x.trainNum||'')===liveNum):matching;
    if(selected.length!==1)return []; // Do not guess ambiguous trains.
    const list=Array.isArray(selected[0].meets)?selected[0].meets:[];
    const seen=new Set();
    return list.filter(x=>{
      const station=cleanStation(x?.station||'');
      const mins=Number(x?.dwellMinutes);
      const key=station+'|'+padTime(x?.arrival||'')+'|'+padTime(x?.departure||'');
      if(x?.source!=='today_diagram'||!station||seen.has(key)||
         !Number.isFinite(mins)||mins<2||mins>45 ||
         !/^\d{2}:\d{2}$/.test(padTime(x.arrival||''))||
         !/^\d{2}:\d{2}$/.test(padTime(x.departure||''))||
         !['same','opposing'].includes(x.movement))return false;
      seen.add(key);return true;
    }).slice(0,3).map(x=>{
      const station=railSpecialText(cleanStation(x.station));
      const stopTime=padTime(x.arrival)+'着→'+padTime(x.departure)+'発';
      const mins=Math.round(Number(x.dwellMinutes));
      const simple=station+'駅で'+mins+'分停車（'+stopTime+'）';
      const rawNum=String(x.counterTrainNum||'').trim();
      const trainClass=String(x.counterTrainClass||'');
      const labelled=railLiveTrainLabel({trainNum:rawNum,trainClass});
      let service='';
      if(trainClass==='limited' && labelled.kind==='limited' &&
         labelled.service && labelled.service!=='特急')
        service='特急'+labelled.service;
      else if(trainClass==='local')service='普通列車';
      else if(trainClass==='freight')service='貨物列車';
      // Include "行" only for an actual destination supplied by the diagram,
      // never a guessed direction or an unknown/placeholder destination.
      const dest=cleanStation(x.counterDestination||'');
      if(!service||!dest||/^(?:不明|未確認|未取得|—|-|0+)$/.test(dest))return simple;
      const other=railSpecialText(service)+' '+railSpecialText(dest)+'行';
      const counterTime=padTime(x.counterTime||'');
      const when=/^\d{2}:\d{2}$/.test(counterTime)
        ? '（'+counterTime+'・当日運行図）':'（当日運行図）';
      if(x.actualHoldConfirmed===true && x.movement==='same')
        return station+'駅で'+other+'の接続待ち｜'+simple+' '+when;
      if(x.movement==='same' && x.counterEvent==='pass')
        return station+'駅で'+other+'の通過待ち｜'+simple+' '+when;
      if(x.movement==='opposing')
        return station+'駅で'+other+'と列車交換｜'+simple+' '+when;
      // A same-direction train sharing a station does not itself establish
      // a hold for passenger connection. Give the known dwell only.
      return simple;
    });
  }

  function railRowDetailItems(record) {
    const items = [];
    const route=railSouthRoute(record);
    if(route) items.push('運転経路：'+route);
    if(record.railTimetableOnly) items.push('時刻表予定・現在位置未確認');
    else if(record.railPositionConfirmed && record.livePosition)
      items.push('現在位置 '+record.livePosition);
    const stops = railStops(record).filter(Boolean);
    const timedStops = railTimedStops(record).filter(Boolean);
    const terminalArrival = railTerminalArrivalText(record);
    if (record.kind === 'limited' || record.kind === 'sightseeing') {
      if (timedStops.length) items.push(`停車駅：${timedStops.join(' → ')}`);
      else if (stops.length) items.push(`停車駅：${stops.join(' → ')}`);
      if (terminalArrival) items.push(`終点着 ${terminalArrival}`);
      const info = String(record.info || '');
      const coupled = info.match(/(いしづち\d+号)/);
      if (coupled) items.push(`${coupled[1]}を併結予定（当日の分離運転は未確認）`);
      const service = String(record.service || '');
      const time = padTime(record.time || '');
      if (service === 'しおかぜ30号' && time === '18:39') {
        items.push('新幹線 最終連絡：岡山で山陽新幹線に乗換');
      } else if (/岡山/.test(String(record.dest || ''))) {
        items.push('岡山で山陽新幹線に乗換');
      }
      if (record.direction==='north' && /しおかぜ/.test(service)) {
        if (coupled) items.push('高松方面：通常はいしづちに乗ったまま（乗換不要）｜分離運転日は宇多津で乗換・当日の変更は未確認');
        else items.push('高松方面：併結情報未確認・宇多津での乗換案内を確認');
      } else if (/岡山・高松/.test(String(record.dest || ''))) items.push('宇多津で岡山方面・高松方面に分割');
      if (service === '宇和海27号' && time === '19:30') {
        items.push('予土線 最終連絡：宇和島21:06着 → 予土線21:11発');
      }
      if (service === 'いしづち102号' && time === '19:32') {
        items.push('高知方面 最終連絡：多度津 → 南風27号');
        items.push('徳島方面 最終連絡：高松 → うずしお33号');
        items.push('サンライズ瀬戸 最終連絡：坂出で乗換');
      }
    } else {
      items.push('各駅停車');
      const info = String(record.info || '');
      if (/伊予長浜経由/.test(info)) items.push('愛ある伊予灘線経由');
      
      if (record.dest) items.push(`終点 ${record.dest}`);
      if (terminalArrival) items.push(`終点着 ${terminalArrival}`);
    }
    // Each of the six JR detail tickers can show connections without
    // moving the fixed service name, time, or destination columns.
    items.push(...railLocalConnectionItems(record));
    items.push(...railLocalWaitAndMeetItems(record));
    if (record.isFinal) items.push('この方面の最終列車です');
    if (record.isNextDayStart) items.push('翌日始発列車');
    return items.length ? items : ['運行案内'];
  }

  function ichitsuboDirection(x) {
    if(x.direction==='north'||x.direction==='south') return x.direction;
    return /^(松山|伊予北条)$/.test(String(x.destination||''))?'north':'south';
  }
  function ichitsuboIsFinal(x,now) {
    const dir=ichitsuboDirection(x); const rows=auxRows('ichitsubo',dir,now); const last=rows[rows.length-1];
    const scheduled=padTime(x.scheduledIchitsubo||'');
    return !!(last && scheduled && padTime(last.time)===scheduled);
  }
  function ichitsuboTakeover(now) {
    const generatedAt=Date.parse(String(approachLive.generatedAtJst||''));
    if(!jrPositionFeedFresh()) return null;
    const rawList=Array.isArray(approachLive.ichitsubo?.approaching)?approachLive.ichitsubo.approaching:[];
    const list=rawList.filter(x=>{
      if(!jrPositionUsable(x?.position))return false;
      const mins=Number(x.minutesToIchitsubo);
      if (Number.isFinite(mins) && mins<0) return false;
      const scheduled=padTime(x.scheduledIchitsubo||'');
      const delay=Number(x.delayMinutes)||0;
      if (/^\d{2}:\d{2}$/.test(scheduled)) {
        let diff=toMinutes(scheduled)+delay-now.minutes;
        if (diff<-720) diff+=1440;
        if (diff>720) diff-=1440;
        if (diff<0) return false;
      }
      return true;
    });
    if (!list.length) return null;
    const alerts=list.map(x=>{
      const kind=String(x.kind||''); const mins=Number(x.minutesToIchitsubo); const strong=Number.isFinite(mins)&&mins<=1;
      let text=''; let mode='stop';
      const dir = ichitsuboDirection(x)==='north' ? '松山方面' : '宇和島方面';
      const serviceLogo=railApproachBadgeHtml(x);
      if (kind==='deadhead') { text=`${serviceLogo} まもなく市坪駅を${dir}へ回送列車が通過します。`; mode='pass'; }
      else if (kind==='freight') { text=`${serviceLogo} まもなく市坪駅を${dir}へ貨物列車が通過します。`; mode='pass'; }
      else if (kind==='unknown') { const num=String(x.trainNum||'').trim(); text=`${serviceLogo} ${num?'列車番号 '+num+'｜':''}市坪駅付近を走行中（運行種別は未判定）。`; mode='pass'; }
      else if (kind==='pass') { text=`${serviceLogo} まもなく市坪駅を${dir}へ列車が通過します。`; mode='pass'; }
      else {
        const finalTrain=ichitsuboIsFinal(x,now); const prefix=finalTrain?'最終列車 ':'';
        text=(Number.isFinite(mins)&&mins<=2)
          ?`${serviceLogo} まもなく市坪駅から${dir}へ${prefix}${x.destination||''}行が発車します。`
          :`${serviceLogo} まもなく市坪駅 ${dir}に${prefix}${x.destination||''}行がまいります。`;
      }
      return {text,mode,strong};
    });
    return {items:alerts.map(a=>liveAlertSpan(a.text,a.mode==='pass'?'rail-pass-alert':'rail-stop-alert',a.strong)),className:'live-takeover stop-live fast-scroll'};
  }
  function madonnaTopInfo(now) {
    const live=approachLive.madonna;
    const generatedAt=Date.parse(String(approachLive.generatedAtJst||''));
    const fresh=!Number.isFinite(generatedAt) || (Date.now()-generatedAt)<=90000;

    if(approachLive.ok && live?.ok && fresh && isKnownStadiumScheduledTime(live.scheduledDeparture,now)) {
      const t=padTime(live.predictedDeparture||live.scheduledDeparture);
      if(t){
        const diff=minutesUntil(t,now.minutes);
        if(Number.isFinite(diff) && diff>=0){
          return `マドンナスタジアム｜51系統 松山市駅行｜${t}発${diff<=59?`｜あと${diff}分`:''}`;
        }
      }
    }

    const next=nextAux('stadium',null,now);
    return next
      ? `マドンナスタジアム｜51系統 松山市駅行｜次便 ${next.time}発`
      : '';
  }

  function renderTopLiveAlert(now) {
    const el=$('top-live-alert');
    if(!el)return;
    if(workplaceTestClock.hasOverride()){
      el.className='hero-alert top-live-alert';
      el.replaceChildren();
      el.dataset.alertClass='';el.dataset.alertHtml='';
      return;
    }

    let cls='hero-alert top-live-alert';
    let html='';
    const city=ichitsuboTakeover(now);
    const bus=madonnaTakeover(now);

    // Return to the original behavior: the top marquee only runs for live approach
    // / imminent-departure alerts. Routine next-service information stays out.
    if(city){
      cls='hero-alert top-live-alert active stop-live fast-scroll';
      html=tickerHtml(city.items);
    } else if(bus){
      cls='hero-alert top-live-alert active bus-live fast-scroll';
      html=tickerHtml(bus.items);
    }

    if(el.dataset.alertClass===cls && el.dataset.alertHtml===html) return;
    el.className=cls;
    el.innerHTML=html;
    el.dataset.alertClass=cls;
    el.dataset.alertHtml=html;
  }

  function railReachText(r) {
    return [
      String(r.dest||''),
      String(r.info||''),
      String(r.connectsTo||''),
      String(r.connection||'')
    ].join(' ');
  }

  function railSpecialFinals(now) {
    const displayIso=boardDisplayIso('rail',now);
    const ctx=dayContext(displayIso);
    const rows=data.records
      .filter(r=>r.board==='rail' && validRecord(r,displayIso))
      .map(r=>({...r,time:effectiveTime(r,ctx),minutes:toMinutes(effectiveTime(r,ctx))}))
      .sort((a,b)=>a.minutes-b.minutes);

    // "Reach" can be direct or a same-day connection recorded in connectsTo/connection.
    const northFinal=rows.filter(r=>r.direction==='north').at(-1)||null;
    const southFinal=rows.filter(r=>r.direction==='south').at(-1)||null;

    // Last Matsuyama departure that can still reach Imabari (directly or beyond).
    const imabariFinal=rows.filter(r=>{
      if(r.direction!=='north') return false;
      return /今治|伊予西条|新居浜|観音寺|高松|岡山/.test(railReachText(r));
    }).at(-1)||null;

    const outside=rows.filter(r=>{
      if(r.direction!=='north') return false;
      return /観音寺|高松|岡山/.test(railReachText(r));
    }).at(-1)||null;

    const southwest=rows.filter(r=>{
      if(r.direction!=='south') return false;
      return /八幡浜|宇和島/.test(railReachText(r));
    }).at(-1)||null;

    // Five "last connection" notices for the October 2026 timetable.
    // These are the last Matsuyama departures that still make the listed same-day connection.
    const findService=(time,re)=>rows.find(r=>padTime(r.time)===time && re.test(String(r.service||'')))||null;
    const yodo=findService('19:30',/宇和海27号/);
    const kochi=findService('19:32',/いしづち102号/);
    const tokushima=kochi;
    const shinkansen=findService('18:39',/しおかぜ30号/);
    const sunrise=findService('19:32',/いしづち102号/);

    return {northFinal,southFinal,imabariFinal,outside,southwest,yodo,kochi,tokushima,shinkansen,sunrise};
  }

  function sameRailService(a,b) {
    return !!a && !!b
      && String(a.direction||'')===String(b.direction||'')
      && padTime(a.time)===padTime(b.time)
      && String(a.service||'')===String(b.service||'')
      && String(a.dest||'')===String(b.dest||'');
  }

  function railSpecialFinalBadge(r,now) {
    const s=railSpecialFinals(now);
    const badges=[];
    if(sameRailService(r,s.imabariFinal)) badges.push(badgeHtml('final','今治方面 最終'));
    if(sameRailService(r,s.northFinal)) badges.push(badgeHtml('final','最終'));
    if(sameRailService(r,s.outside)) badges.push(badgeHtml('final','県外最終'));
    if(sameRailService(r,s.southwest)) badges.push(badgeHtml('final','宇和島方面 最終'));
    if(sameRailService(r,s.southFinal)) badges.push(badgeHtml('final','最終'));
    return badges.join('');
  }

  function railVisiblePassengerRows(now) {
    const passenger=nextRows('rail',now).map(r=>({
      type:'passenger',
      sort:(()=>{
        const t=padTime(r.time||'');
        let d=toMinutes(t)-now.minutes;
        if(d < -720) d += 1440;
        return now.minutes+d;
      })(),
      row:r
    }));
    const deadheads=matsuyamaDeadheadArrivals(now).map(x=>({
      type:'deadhead',
      sort:(()=>{
        let d=toMinutes(x.arrival)-now.minutes;
        if(d < -720) d += 1440;
        return now.minutes+d;
      })()
    }));
    const freights=matsuyamaFreightPasses(now).map(x=>({
      type:'freight',
      sort:(()=>{
        let d=toMinutes(x.passTime)-now.minutes;
        if(d < -720) d += 1440;
        return now.minutes+d;
      })()
    }));
    return [...passenger,...deadheads,...freights]
      .sort((a,b)=>a.sort-b.sort)
      .slice(0,3)
      .filter(x=>x.type==='passenger')
      .map(x=>x.row);
  }

  function railTickerServiceHtml(kind,service='',info='') {
    return `<span class="rail-ticker-service">${railServiceBadgeHtml(kind,service,info)}</span>`;
  }

  function railApproachBadgeHtml(x) {
    const kind=String(x?.kind||'');
    if(kind==='deadhead') return railTickerServiceHtml('deadhead');
    if(kind==='freight') return railTickerServiceHtml('freight');
    if(kind==='unknown') return railVehicleIconHtml(x);
    if(kind==='stop' || kind==='pass'){
      const info=railLiveTrainLabel(x);
      if(info.kind==='limited') return railTickerServiceHtml('limited',info.service);
      if(kind==='stop') return railTickerServiceHtml('local');
      return '<span class="rail-ticker-service"><span class="rail-kind-badge rail-kind-pass">通過</span></span>';
    }
    return '';
  }

  function railSpecialFinalTickerItems(now) {
    const s=railSpecialFinals(now);
    const visible=railVisiblePassengerRows(now);
    const isVisible=(r)=>visible.some(v=>sameRailService(v,r));
    const out=[];
    const label=(r)=>{
      const kind=r.kind==='local'?'local':r.kind==='sightseeing'?'tourist':'limited';
      const service=kind==='local'?'':String(r.service||'');
      return `${railTickerServiceHtml(kind,service,r.info)} <span class="rail-ticker-dest">${r.dest}行</span>`;
    };

    if(s.imabariFinal && isVisible(s.imabariFinal)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-direction-final">🚆 今治方面 最終｜松山 ${s.imabariFinal.time}発｜${label(s.imabariFinal)}</span>`);
    }
    if(s.northFinal && isVisible(s.northFinal)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-direction-final">🚆 最終｜松山 ${s.northFinal.time}発｜${label(s.northFinal)}</span>`);
    }
    if(s.southwest && isVisible(s.southwest)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-southwest-final">🚆 宇和島方面 最終｜松山 ${s.southwest.time}発｜${label(s.southwest)}</span>`);
    }
    if(s.southFinal && isVisible(s.southFinal)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-direction-final">🚆 最終｜松山 ${s.southFinal.time}発｜${label(s.southFinal)}</span>`);
    }

    if(s.outside && isVisible(s.outside)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-outside-final">⚠ 県外へ行ける最終｜松山 ${s.outside.time}発｜${label(s.outside)}</span>`);
    }
    // "最終連絡" is reserved for exactly these five notices.
    if(s.yodo && isVisible(s.yodo)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-southwest-final">🚆 予土線 最終連絡｜松山 ${s.yodo.time}発｜${label(s.yodo)} → 宇和島21:06着 → 予土線21:11発</span>`);
    }
    if(s.kochi && isVisible(s.kochi)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-outside-final">🚆 高知方面 最終連絡｜松山 ${s.kochi.time}発｜${label(s.kochi)} → 多度津 → 南風27号</span>`);
    }
    if(s.tokushima && isVisible(s.tokushima)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-outside-final">🚆 徳島方面 最終連絡｜松山 ${s.tokushima.time}発｜${label(s.tokushima)} → 高松 → うずしお33号</span>`);
    }
    if(s.shinkansen && isVisible(s.shinkansen)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-shinkansen-final">🚄 新幹線 最終連絡｜松山 ${s.shinkansen.time}発｜${label(s.shinkansen)} → 岡山で新幹線</span>`);
    }
    if(s.sunrise && isVisible(s.sunrise)){
      out.push(`<span class="rail-special-final fast-scroll-text rail-sunrise-final">🌅 サンライズ瀬戸 最終連絡｜松山 ${s.sunrise.time}発｜${label(s.sunrise)} → 坂出でサンライズ瀬戸</span>`);
    }
    return out;
  }

  function railKnownPositionTickerItems(now) {
    const generatedAt=Date.parse(String(approachLive.generatedAtJst||''));
    if(!jrPositionFeedFresh()) return [];

    const side=currentRailDir();
    const seen=new Set();
    const out=[];
    const push=(x, kindOverride='')=>{
      const position=cleanStation(x?.position||'');
      if(!jrPositionUsable(position)) return;
      const isMatsuyamaFreight=kindOverride==='freight' && /^(3072|3073)$/.test(String(x?.trainNum||''));
      const dir=ichitsuboDirection(x);
      if(dir!==side) return;

      const key=`${String(x?.trainNum||'')}|${position}|${dir}`;
      if(seen.has(key)) return;
      seen.add(key);

      const kind=kindOverride||String(x?.kind||'');
      const badge=railApproachBadgeHtml({...x,kind});
      const dest=cleanStation(x?.destination||'');
      const delay=Number(x?.delayMinutes)||0;
      const delayText=delay>0?`｜${delay}分遅れ`:'';
      const destText=dest?`｜${dest}行`:'';
      out.push(`<span class="rail-position-live">📍 現在位置 ${position}｜${badge}${destText}${delayText}</span>`);
    };

    for(const x of matsuyamaObservedSpecialRows(now)){
      const badge=railServiceBadgeHtml(x.kind);
      const destination=x.destination?'｜'+railSpecialText(x.destination)+'方面':'';
      const vehicle=x.vehicleSeries?'｜車両形式 '+railSpecialText(x.vehicleSeries)+'（非公式で確認）':'';
      const event=x.stationConfirmed?'｜松山駅 当日ダイヤ照合':'｜松山駅発着未確認';
      out.push('<span class="rail-position-live">📍'+badge+' '+railSpecialText(x.trainNum)+
        '｜現在位置 '+railSpecialText(x.position)+vehicle+destination+event+'</span>');
    }

    const approaching=Array.isArray(approachLive.ichitsubo?.approaching)
      ? approachLive.ichitsubo.approaching
      : [];
    approaching.forEach(x=>push(x));

    const deadheads=Array.isArray(approachLive.ichitsubo?.matsuyamaDeadheads)
      ? approachLive.ichitsubo.matsuyamaDeadheads
      : [];
    deadheads.forEach(x=>push({...x,kind:'deadhead'},'deadhead'));

    const freights=Array.isArray(approachLive.ichitsubo?.matsuyamaFreights)
      ? approachLive.ichitsubo.matsuyamaFreights
      : [];
    freights.forEach(x=>push({...x,kind:'freight'},'freight'));

    return out;
  }

  function railTickerItems(now) {
    // The lower JR ticker is position-based only; no static "next train".
    const positions=railKnownPositionTickerItems(now);
    const specials=railSpecialFinalTickerItems(now);
    const takeover=ichitsuboTakeover(now);
    if(takeover)return [...takeover.items,...positions,...specials];
    const items=[];
    const deadhead=matsuyamaDeadheadArrivals(now)[0];
    if(deadhead){
      items.push(`JR松山駅｜${railTickerServiceHtml('deadhead')} ${deadhead.arrival} 到着予定｜現在位置 ${deadhead.position}`);
    }
    const freight=matsuyamaFreightPasses(now)[0];
    if(freight){
      items.push(freight.timetableOnly
        ? `JR松山駅｜${railTickerServiceHtml('freight')} ${freight.trainNum}レ｜${freight.passTime||'時刻未確認'} 通過予定（当日ダイヤ・運行未確認）${freight.scheduledIchitsubo?'｜市坪 '+freight.scheduledIchitsubo+' 通過予定':''}`
        : `JR松山駅｜${railTickerServiceHtml('freight')} ${freight.trainNum}レ ${freight.passTime||'時刻確認中'} 通過予定｜現在位置 ${freight.position}`);

    }
    const verified=[...positions,...items,...specials];
    return verified.length?verified:['JR列車位置情報を確認中'];
  }

  function airportBusTakeover(now) {
    const weekend=now.dow===0||now.dow===6;
    const ordinary=weekend?ORDINARY_WEEKEND_AIRPORT_TO_CITY:ORDINARY_WEEKDAY_AIRPORT_TO_CITY;
    const alerts=[];
    LIMO_AIRPORT_TO_CITY.forEach((t,i)=>{
      const d=toMinutes(t)-now.minutes; if(d>=-1&&d<=4){
        const final=i===LIMO_AIRPORT_TO_CITY.length-1; const action=d<=2?'発車します':'まもなく乗車できます';
        alerts.push({time:t,text:final?`まもなく道後温泉方面行きのバスが${action}。`:`まもなく道後温泉方面行きのバスが${action}。`,diff:d});
      }
    });
    ordinary.forEach((pair,i)=>{
      const d=toMinutes(pair[0])-now.minutes; if(d>=-1&&d<=4){
        const final=i===ordinary.length-1; const action=d<=2?'発車します':'まもなく乗車できます';
        alerts.push({time:pair[0],text:final?`まもなく松山市駅行きのバスが${action}。`:`まもなく松山市駅行きのバスが${action}。`,diff:d});
      }
    });
    if(!alerts.length)return null; alerts.sort((a,b)=>a.diff-b.diff);
    const pick=chooseAlert(alerts,now); const strong=pick.diff<=1;
    return {items:[liveAlertSpan(pick.text,'airport-bus-alert',strong)],className:`live-takeover airbus-live${strong?' strong-live':''}${pick.text.length>23?' fast-scroll':''}`};
  }
  function airportAccessTickerItems(now) {
    // Airport lower ticker: delay notices only for the direction currently shown.
    // Once that side has no more active flights, clear the ticker completely.
    const airport=slowLive.airport;
    if(!airport?.ok||airportLiveHasPreviousDayStatuses(now)) return [''];

    const dep=currentDirection()==='departure';
    const activeRows=liveFlightRows(now) || nextRows('air',now);
    if(!Array.isArray(activeRows) || !activeRows.length) return [''];

    const items=[];
    const addDelayed=(rows,direction)=>{
      if(!Array.isArray(rows)) return;
      rows.forEach(x=>{
        if(direction==='arrival' && delayedArrivalNoticeExpired(x,now))return;
        if(direction==='arrival' && completedTurnaroundDeparted(x,airport.departures,now))return;
        const delta=Number(x?.deltaMinutes);
        const status=String(x?.status||'');
        if(!(Number.isFinite(delta) && delta>0) && !/遅延|遅れ/.test(status)) return;

        const scheduled=padTime(x?.scheduled||'');
        const changed=padTime(x?.changed||x?.scheduled||'');
        if(!scheduled || !changed) return;

        const nums=Array.isArray(x?.numbers)?x.numbers.map(String).filter(Boolean):[];
        const flight=nums.length?nums.join(' / '):'便名不明';
        const matchedAirline=nums.map(n=>{
          const row=data.records.find(r=>r.board==='air' && String(parseAirService(r.service).number)===String(n));
          return row?parseAirService(row.service).airline:'';
        }).find(Boolean)||'';
        const miniLogo=airlineMiniLogo(matchedAirline);
        const airlineLabel=miniLogo ? `${miniLogo} ` : (matchedAirline ? `${matchedAirline} ` : '');
        const place=String(x?.place||'').trim();
        const late=Number.isFinite(delta)&&delta>0
          ? `+${delta}分`
          : (status.match(/(?:遅延|遅れ)[^0-9]*([0-9]+)分/)?.[1] ? `+${status.match(/(?:遅延|遅れ)[^0-9]*([0-9]+)分/)?.[1]}分` : '遅延');
        const dirLabel=direction==='departure'?'出発':'到着';
        const route=place ? `｜${place}${direction==='departure'?'行':'発'}` : '';
        items.push(`✈ 遅延｜${dirLabel} ${airlineLabel}${flight}${route}｜定刻 ${scheduled} → ${changed}（${late}）`);
      });
    };

    if(dep) addDelayed(airport.departures,'departure');
    else addDelayed(airport.arrivals,'arrival');
    return items.length?items:[''];
  }


  function airportDisruptionItems(now, direction) {
    const airport=slowLive.airport;
    if(!airport?.ok) return [{type:'loading',text:'運航情報取得中'}];
    if(airportLiveHasPreviousDayStatuses(now))
      return [{type:'loading',text:'公式サイトの当日運航情報切替待ち｜時刻表を表示中'}];

    const arrival=direction==='arrival';
    const activeRows=liveFlightRows(now) || nextRows('air',now);
    if(!Array.isArray(activeRows) || !activeRows.length){
      if(arrival && airportArrivalBoardState(now)!=='complete')
        return [{type:'loading',text:'公式到着情報を確認中（終了未確定）'}];
      return [{type:'ended',text:arrival?'本日の到着便は終了しました':'本日の出発便は終了しました'}];
    }
    const rows=arrival
      ? (Array.isArray(airport.arrivals)?airport.arrivals:[])
      : (Array.isArray(airport.departures)?airport.departures:[]);
    const items=[];
    rows.forEach(x=>{
      if(arrival && delayedArrivalNoticeExpired(x,now))return;
      if(arrival && completedTurnaroundDeparted(x,airport.departures,now))return;
      const status=String(x?.status||'').trim();
      const delta=Number(x?.deltaMinutes);
      const isCancel=!arrival && /欠航|運休/.test(status);
      const isDelay=(Number.isFinite(delta)&&delta>0)||/遅延|遅れ/.test(status);
      const isArrivalChange=arrival && /変更|到着予定/.test(status);
      if(!isCancel&&!isDelay&&!isArrivalChange) return;

      const nums=Array.isArray(x?.numbers)?x.numbers.map(String).filter(Boolean):[];
      const flight=nums[0]||'便名不明';
      const staticRow=data.records.find(r=>r.board==='air' && String(parseAirService(r.service).number)===flight);
      const airline=staticRow?parseAirService(staticRow.service).airline:'';
      const carrier=airline?airline.replace('エアラインズ',''):'';
      const place=String(x?.place||'').replace(/[（(].*?[）)]/g,'').trim();
      let detail=status;
      if(isDelay && Number.isFinite(delta)&&delta>0 && !/[0-9]+分/.test(detail)) detail=`遅れ +${delta}分`;
      if(!detail) detail=isCancel?'欠航':(arrival?'到着遅延':'遅延');
      items.push({
        type:isCancel?'cancel':'delay',
        text:`${carrier?carrier+' ':''}${flight}${place?' '+place:''}　${detail}`
      });
    });
    const clearText=arrival?'現在、到着便の遅延情報なし':'現在、出発便の欠航・遅延情報なし';
    return items.length?items.slice(0,3):[{type:'ok',text:clearText}];
  }

  function airportNextTimes(now) {
    const weekend=now.dow===0||now.dow===6;
    const limo=LIMO_AIRPORT_TO_CITY.filter(t=>toMinutes(t)>=now.minutes).slice(0,2);
    const ordinaryList=weekend?ORDINARY_WEEKEND_AIRPORT_TO_CITY:ORDINARY_WEEKDAY_AIRPORT_TO_CITY;
    const ordinary=ordinaryList.filter(([t])=>toMinutes(t)>=now.minutes).slice(0,2);
    return {
      limo,
      ordinary,
      ordinaryStops:'南吉田口 → 富久口 → 空港通り → JR松山駅前 → 愛媛新聞社前 → 松山市駅'
    };
  }

  let airportBottomSignature='';
  function renderAirportBottomInfo(now) {
    const el=$('air-note');
    if(!el) return;
    const direction=currentDirection();
    const arrival=direction==='arrival';
    const disruption=airportDisruptionItems(now,direction);
    const bus=airportNextTimes(now);
    const ended=disruption.length===1 && disruption[0]?.type==='ended';
    const disruptionHtml=disruption.map(x=>`<span class="air-bottom-alert air-bottom-${x.type}">${x.text}</span>`).join('<span class="air-bottom-dot">・</span>');
    const twoDepartureText=(times)=>{
      if(!times.length) return '本日運行終了';
      const first=times[0];
      const next=times[1];
      return next
        ? `先発 ${first}発　｜　次発 ${next}発`
        : `先発 ${first}発　｜　次発なし`;
    };
    const limoText=twoDepartureText(bus.limo);
    const ordinaryText=twoDepartureText(bus.ordinary.map(x=>x[0]));
    const directionMark=arrival?'⭐到着⭐':'💎出発💎';
    const disruptionLabel=arrival?'遅延・到着変更':'欠航・遅延';

    const busHtml=`
      <span class="air-bottom-bus air-bottom-limo"><b>リムジン</b><span>松山空港発　${limoText}</span></span>
      <span class="air-bottom-sep">◆</span>
      <span class="air-bottom-bus air-bottom-ordinary"><b>普通便</b><span>松山空港発　${ordinaryText}</span></span>
      <span class="air-bottom-sep">◆</span>
      <span class="air-bottom-stops"><b>普通便 主な停留所</b><span>${bus.ordinaryStops}</span></span>`;

    const sig=[directionMark,disruptionLabel,disruptionHtml,limoText,ordinaryText,bus.ordinaryStops].join('||');
    if(airportBottomSignature===sig && el.classList.contains('air-bottom-info')) return;
    airportBottomSignature=sig;

    el.className='note air-bottom-info';
    el.innerHTML=`
      <div class="air-bottom-disruption">
        <div class="air-bottom-scroll"><div class="air-bottom-scroll-track air-bottom-scroll-alert${ended?' air-bottom-ended':''}">
          <span class="air-bottom-scroll-set"><b class="air-bottom-direction">${directionMark} ${disruptionLabel}</b><span class="air-bottom-sep">◆</span>${disruptionHtml}</span>
          ${ended?'':`<span class="air-bottom-scroll-set" aria-hidden="true"><b class="air-bottom-direction">${directionMark} ${disruptionLabel}</b><span class="air-bottom-sep">◆</span>${disruptionHtml}</span>`}
        </div></div>
      </div>
      <div class="air-bottom-buses">
        <div class="air-bottom-scroll"><div class="air-bottom-scroll-track air-bottom-scroll-bus">
          <span class="air-bottom-scroll-set">${busHtml}</span>
          <span class="air-bottom-scroll-set" aria-hidden="true">${busHtml}</span>
        </div></div>
      </div>`;
  }

  const scrollState = {};
  function modeKey(board) {
    if (board === 'rail') return `${board}-${currentRailDir()}`;
    return `${board}-${currentDirection()}`;
  }
  function rememberScroll(board) {
    const el = $(`${board}-rows`);
    if (el) scrollState[modeKey(board)] = el.scrollTop;
  }
  function restoreScroll(board) {
    const el = $(`${board}-rows`);
    if (!el) return;
    el.scrollTop = scrollState[modeKey(board)] || 0;
  }
  function attachScrollMemory(board) {
    const el = $(`${board}-rows`);
    if (!el || el.dataset.scrollMemory === '1') return;
    el.dataset.scrollMemory = '1';
    el.addEventListener('scroll', () => { scrollState[modeKey(board)] = el.scrollTop; }, { passive:true });
  }
  function emptyRow(type='') {
    const dep = currentDirection() === 'departure';
    if (type === 'rail') return `<div class="cell"></div><div class="cell time"></div><div class="cell main end-message">本日の列車は終了しました</div>`;
    if (type === 'air') {
      const msg=dep?'本日の出発便は終了しました':'本日の到着便は終了しました';      if (dep) return `<div class="cell time"></div><div class="cell main end-message">${msg}</div><div class="cell service"></div><div class="cell sub"></div>`;
      return `<div class="cell main end-message">${msg}</div><div class="cell service"></div><div class="cell sub"></div><div class="cell time"></div>`;
    }
    if (type === 'port') {
      const msg=dep?'本日の出航便は終了しました':'本日の到着便は終了しました';
      if (dep) return `<div class="cell time"></div><div class="cell main port-route end-message">${msg}</div><div class="cell service"></div>`;
      return `<div class="cell main port-route end-message">${msg}</div><div class="cell service"></div><div class="cell time"></div>`;
    }
    const msg=dep?'本日のバスは終了しました':'本日の到着バスは終了しました';
    if (dep) return `<div class="cell time"></div><div class="cell service"></div><div class="cell main end-message">${msg}</div><div class="cell sub"></div>`;
    return `<div class="cell main end-message">${msg}</div><div class="cell service"></div><div class="cell sub"></div><div class="cell time"></div>`;
  }
  function matsuyamaDeadheadArrivals(now) {
    const generatedAt=Date.parse(String(approachLive.generatedAtJst||''));
    if(!jrPositionFeedFresh()) return [];
    const raw=Array.isArray(approachLive.ichitsubo?.matsuyamaDeadheads)
      ? approachLive.ichitsubo.matsuyamaDeadheads
      : [];
    return raw.map(x=>{
      const scheduled=padTime(x.scheduledMatsuyama||'');
      const delay=Number(x.delayMinutes)||0;
      return {
        ...x,
        scheduled,
        arrival: scheduled ? addMinutes(scheduled,delay) : '',
        origin: cleanStation(x.origin||''),
        position: cleanStation(x.position||''),
        delay
      };
    // Do not put scheduled-only deadheads on the Matsuyama timetable.
    // A deadhead is shown only while JR live data provides a current position.
    }).filter(x=>x.arrival && jrPositionUsable(x.position) &&
      // If the live feed already places the train AT Matsuyama, it is NOT
      // still inbound to Matsuyama. Do not show a phantom arrival.
      !/^(?:松山|松山駅)$/.test(x.position) &&
      // Do not roll a completed morning arrival over to tomorrow.
      toMinutes(x.arrival)>=now.minutes);
  }

  function matsuyamaFreightPasses(now) {
    // The day's operating diagram is enough to show "scheduled passage".
    // Live position is optional FOR FREIGHT ONLY, never invent a passage time.
    const ts=Date.parse(String(approachLive.generatedAtJst||''));
    const age=Date.now()-ts;
    if(!approachLive.ok || approachLive.ichitsubo?.ok!==true ||
      !Number.isFinite(age) || age < -15000 || age > 60000 ||
      String(approachLive.generatedAtJst||'').slice(0,10)!==now.iso) return [];

    const scheduled=Array.isArray(approachLive.ichitsubo?.matsuyamaFreightSchedules)
      ? approachLive.ichitsubo.matsuyamaFreightSchedules : [];
    const confirmed=Array.isArray(approachLive.ichitsubo?.matsuyamaFreights)
      ? approachLive.ichitsubo.matsuyamaFreights : [];
    const byTrain=new Map();
    const directionFor=x=>String(x.trainNum)==='3072'?'north':'south';

    scheduled.forEach(x=>{
      const num=String(x.trainNum||'').trim();
      if(!/^(3072|3073)$/.test(num))return;
      const stationTime=padTime(x.scheduledMatsuyama||'');
      const cityTime=padTime(x.scheduledIchitsubo||'');
      if(!/^\d{2}:\d{2}$/.test(stationTime) &&
        !/^\d{2}:\d{2}$/.test(cityTime)) return;
      // A train from this morning must not be presented as tonight's service.
      const upcoming=stationTime||cityTime;
      if(toMinutes(upcoming)<now.minutes)return;
      byTrain.set(num,{
        ...x,trainNum:num,kind:'freight',direction:directionFor(x),
        scheduled:stationTime,passTime:stationTime,
        displayTime:stationTime||'時刻確認中',
        scheduledIchitsubo:cityTime,
        origin:cleanStation(x.origin||''),
        destination:cleanStation(x.destination||''),
        position:'',delay:0,timetableOnly:true,
      });
    });

    confirmed.forEach(x=>{
      const num=String(x.trainNum||'').trim();
      if(!/^(3072|3073)$/.test(num) ||
        !jrPositionFeedFresh() || !jrPositionUsable(x.position))return;
      const previous=byTrain.get(num);
      const scheduled=padTime(x.scheduledMatsuyama||previous?.scheduled||'');
      const delay=Number(x.delayMinutes)||0;
      const passTime=scheduled ? addMinutes(scheduled,delay) : '';
      if(passTime && toMinutes(passTime)<now.minutes) return;
      byTrain.set(num,{
        ...previous,...x,trainNum:num,kind:'freight',direction:directionFor(x),
        scheduled,passTime,displayTime:passTime||'時刻確認中',
        scheduledIchitsubo:padTime(previous?.scheduledIchitsubo||''),
        origin:cleanStation(x.origin||previous?.origin||''),
        destination:cleanStation(x.destination||previous?.destination||''),
        position:cleanStation(x.position),delay,timetableOnly:false,
      });
    });
    return [...byTrain.values()];
  }


  // Original generic train-front illustration. This is NOT a claim about the
  // vehicle series: train number (M/D) does not uniquely identify rolling stock.
  function railVehicleIconHtml(record={}) {
    // Use ONLY vehicle graphics from the unofficial train-operation service
    // or its train-number database. No locally invented SVG substitutes.
    const dir=record.side==='south'?'north':
      record.side==='north'?'south':
      record.direction==='north'||record.direction==='south' ? record.direction : currentRailDir();
    const raw=String((dir==='north'?record.vehicleImageNorth:record.vehicleImageSouth)||'');
    let imageUrl='';
    try {
      const u=new URL(raw);
      if(u.protocol==='https:' && /(^|\.)haruk\.in$/i.test(u.hostname) &&
        (/\.(?:png|webp|gif|jpe?g)(?:$|\?)/i.test(u.href) ||
         /\/webhook\/anpanman-pictures(?:-hub)?\.png/i.test(u.pathname))){
        imageUrl=u.href.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
      }
    } catch(e){}
    if(!imageUrl) return '';
    const label='JR四国非公式データの車両画像（当日運用または列車番号別情報）';
    return '<span class="rail-train-illustration" title="'+label+'" aria-label="'+label+'">'+
      '<img class="rail-vehicle-live-image" alt="" loading="eager" referrerpolicy="no-referrer" src="'+imageUrl+'" onerror="this.parentElement.remove()"/>'+
      '</span>';
  }

  function railPassengerServiceName(service,info=''){
    const svc=String(service||'').trim();
    const match=svc.match(/^しおかぜ(\d+)号$/);
    const partner=String(info||'').match(/いしづち(\d+)号/);
    return match && partner && match[1]===partner[1]
      ? svc+'・いしづち'+partner[1]+'号' : svc;
  }
  function railServiceBadgeHtml(kind, service='', info='') {
    const svc=railPassengerServiceName(service,info);
    if(kind==='limited'){
      const name=svc||'特急';
      return `<span class="rail-kind-badge rail-kind-limited">特急</span><span class="rail-name-badge">${name}</span>`;
    }
    if(kind==='tourist'){
      const name=svc||'観光列車';
      return `<span class="rail-kind-badge rail-kind-tourist">観光</span><span class="rail-name-badge rail-name-tourist">${name}</span>`;
    }
    if(kind==='deadhead') return '<span class="rail-kind-badge rail-kind-deadhead">回送</span>';
    if(kind==='freight') return '<span class="rail-kind-badge rail-kind-freight">貨物</span>';
    if(kind==='test') return '<span class="rail-kind-badge rail-kind-test">試運転</span>';
    if(kind==='extra') return '<span class="rail-kind-badge rail-kind-extra rail-event-extra">臨時列車</span>';
    if(kind==='unknown') return ''; // Unresolved service: show a neutral train illustration instead.
    return '<span class="rail-kind-badge rail-kind-local">普通</span>';
  }

  function railLiveTrainLabel(x) {
    const num=String(x?.trainNum||'').trim();
    const m=num.match(/^(\d+)([A-Z]+)$/i);
    const inferredLimited=!!(m && (
      (String(m[2]||'').toUpperCase()==='M' && ((Number(m[1])>=1&&Number(m[1])<=40)||(Number(m[1])>=1000&&Number(m[1])<=1199))) ||
      (String(m[2]||'').toUpperCase()==='D' && Number(m[1])>=1051&&Number(m[1])<=1099)
    ));
    if ((String(x?.trainClass||'')==='limited' || inferredLimited) && m) {
      const n=Number(m[1]);
      const suffix=String(m[2]||'').toUpperCase();
      if (suffix==='M' && n>=1 && n<=40) {
        const name=`しおかぜ${n}号`;
        const joined=Array.isArray(data.records) && data.records.some(r=>
          r.board==='rail' && r.service===name &&
          String(r.info||'').includes(`いしづち${n}号`));
        return {kind:'limited',service:joined?name+`・いしづち${n}号`:name};
      }
      if (suffix==='D' && n>=1051 && n<=1099) return {kind:'limited',service:`宇和海${n-1050}号`};
      // Matsuyama-originating Ishizuchi 102/104/106 have 1042M/1044M/1046M
      // in the actual operating diagram, not 1102M/1104M/1106M.
      if (suffix==='M' && [1042,1044,1046].includes(n))
        return {kind:'limited',service:`いしづち${n-940}号`};
      if (suffix==='M' && n>=1000 && n<=1199) return {kind:'limited',service:`いしづち${n-1000}号`};
      return {kind:'limited',service:'特急'};
    }
    return {kind:'local',service:'普通'};
  }

  function railTurnbackLabel(turnback,now) {
    if(!turnback) return '';
    const dep=padTime(turnback.departure||'');
    const dir=String(turnback.direction||'');
    const dest=cleanStation(turnback.destination||'');
    // In the live feed, 00:00 and 00 can be unset placeholders.
    // Never announce a turnback unless its departure and destination
    // are corroborated by an actual scheduled service.
    if(!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(dep) ||
       !['north','south'].includes(dir) ||
       !dest || /^(?:0+|不明|未定|未取得|—|-)$/.test(dest)) return '';
    const matches=data.records.filter(r=>
      r.board==='rail' &&
      r.direction===dir &&
      padTime(r.time||'')===dep &&
      cleanStation(r.dest||'')===dest &&
      validRecord(r,now.iso)
    );
    const liveSchedule=Array.isArray(approachLive.ichitsubo?.matsuyamaSchedule)
      ? approachLive.ichitsubo.matsuyamaSchedule : [];
    const diagramMatch=liveSchedule.find(r=>
      String(r.trainNum||'')===String(turnback.trainNum||'') &&
      padTime(r.departure||'')===dep &&
      String(r.direction||'')===dir &&
      cleanStation(r.destination||'')===dest
    );
    const r=matches[0];
    if(!r && diagramMatch){
      const trainLabel=railLiveTrainLabel({trainNum:diagramMatch.trainNum,trainClass:diagramMatch.trainClass});
      const service=trainLabel.kind==='limited'?'特急 '+trainLabel.service:'普通';
      return `折り返し ${dep}発 ${service} ${dest}行となります（運行図表照合）`;
    }
    if(r){
      const kind=r.kind==='limited'?'特急 ':r.kind==='sightseeing'?'観光 ':'';
      const service=r.kind==='local'?'普通':`${kind}${r.service||''}`.trim();
      return `折り返し ${dep}発 ${service} ${r.dest||dest}行となります`;
    }
    // Unmatched feed data is not a verified turnback. Omit the claim.
    return '';
  }

  function matsuyamaTerminatingArrivals(now) {
    const generatedAt=Date.parse(String(approachLive.generatedAtJst||''));
    const raw=jrPositionFeedFresh() && Array.isArray(approachLive.ichitsubo?.matsuyamaTerminatingArrivals)
      ? approachLive.ichitsubo.matsuyamaTerminatingArrivals
      : [];
    const side=currentRailDir();
    const special=data.records.filter(r=>r.board==='rail_special_arrival' &&
      validRecord(r,now.iso) && r.direction===side).map(r=>({
        trainNum:'',trainClass:'sightseeing',serviceName:r.service,
        specialName:String(r.info||'').split('・')[0],
        side,origin:r.origin,route:r.info,arrival:padTime(r.time),
        position:'',delayMinutes:0,source:'official_timetable',
        isOfficialScheduled:true
      }));
    const observed=raw.map(x=>{
      const arrival=padTime(x.arrival||'');
      // Today-only arrival: never roll a train that already arrived today
      // into the next day. Midnight services require explicit dated records.
      const diff=arrival?toMinutes(arrival)-now.minutes:NaN;
      const position=cleanStation(x.position||'');
      const delay=Number(x.delayMinutes)||0;
      return {...x,arrival,diff,position,delay};
    }).filter(x=>x.arrival && x.side===side && Number.isFinite(x.diff) && x.diff>=0 && x.diff<=180 && (jrPositionUsable(x.position) || !!x.turnback));
    const scheduled=special.map(x=>({...x,diff:toMinutes(x.arrival)-now.minutes,delay:0}))
      .filter(x=>x.diff>=0 && x.diff<=180);
    // Never let a generic live arrival at the same minute overwrite the
    // officially named sightseeing train. The live feed has no positive
    // identity match for that train, so do not assign its position either.
    const otherObserved=observed.filter(v=>!scheduled.some(x=>v.arrival===x.arrival && v.side===x.side));
    return [...otherObserved,...scheduled].sort((a,b)=>a.diff-b.diff);
  }

  // 2026-03-14 JR Shikoku operating-diagram links (8000-series only).
  // Only entries visibly consecutive in the published 2026 operation table;
  // these are planned vehicle workings, not same-day rolling-stock confirmation.
  // Source: https://unyohub.2pd.jp/railroad_shikoku/operation_table/2026-03-14/
  const VERIFIED_SHIOKAZE_WORKINGS_2026={
    '1M':'14M', '3M':'16M', '5M':'18M', '9M':'22M',
    '13M':'26M', '15M':'28M', '17M':'30M'
  };
  // Consecutive Uwakai workings at Matsuyama from the published 2026 operating table.
  // Depot transfers, divides/joins and ambiguous multiple-unit formations are omitted.
  const VERIFIED_UWAKAI_WORKINGS_2026={
    '1054D':'1055D', '1058D':'1059D', '1060D':'1061D',
    '1062D':'1063D', '1064D':'1065D', '1066D':'1067D',
    '1070D':'1071D', '1072D':'1073D', '1076D':'1077D',
    '1080D':'1081D'
  };
  function publishedTrainTurnback(x){
    if(x.trainClass!=='limited') return '';
    const inbound=String(x.trainNum||'').trim().toUpperCase();
    const shiokaze=VERIFIED_SHIOKAZE_WORKINGS_2026[inbound];
    const uwakai=VERIFIED_UWAKAI_WORKINGS_2026[inbound];
    const outbound=shiokaze||uwakai;
    if(!outbound) return '';
    const services=Array.isArray(approachLive.ichitsubo?.matsuyamaSchedule)
      ? approachLive.ichitsubo.matsuyamaSchedule : [];
    const r=services.find(v=>
      String(v.trainNum||'').trim().toUpperCase()===outbound &&
      v.direction===(shiokaze?'north':'south') &&
      /^\d{1,2}:\d{2}$/.test(String(v.departure||''))
    );
    if(!r) return '';
    const arrive=toMinutes(x.arrival),depart=toMinutes(r.departure);
    const gap=(depart-arrive+1440)%1440;
    if(!Number.isFinite(gap) || gap<4 || gap>120) return '';
    const dest=cleanStation(r.destination||'');
    if(!dest || /^(不明|未定|未取得|—|-|0+)$/.test(dest)) return '';
    const n=shiokaze?Number(outbound.replace(/M$/,'')):Number(outbound.replace(/D$/,''))-1050;
    const name=shiokaze?'しおかぜ':'宇和海';
    return `通常運用では折り返し ${padTime(r.departure)}発 特急${name}${n}号 ${dest}行となります（当日車両変更未確認）`;
  }

  function appendMatsuyamaTerminalArrivalRow(root,x,now) {
    const row=document.createElement('div');
    row.className='row rail-row terminal-arrival-row';
    const info=railLiveTrainLabel(x);
    const serviceBadge=railVehicleIconHtml(x)+(x.isOfficialScheduled && /臨時列車/.test(String(x.serviceName||''))
      ? railServiceBadgeHtml('extra')
      : x.isOfficialScheduled
      ? '<span class="rail-kind-badge rail-kind-tourist">伊予灘ものがたり</span>'
      : railServiceBadgeHtml(info.kind,info.kind==='limited'?info.service:''));
    // Inbound trains from the Uwajima direction: distinguish the coastal and inland routes.
    const arrivalRoute=(()=>{
      if(x.side!=='south') return '';
      const infoText=[x.route,x.via,x.info,x.origin,x.position].map(v=>String(v||'')).join(' ');
      if(/伊予長浜|海回り|愛ある伊予灘/.test(infoText)) return '愛ある伊予灘線経由';
      // 通常の内子経由（山回り）は注記しない。
      return '';
    })();
    const details=['この列車は松山止まりです'];
    if(x.specialName) details.push(x.specialName+'｜'+x.origin+'発・松山着');
    if(arrivalRoute) details.push('運転経路：'+arrivalRoute);
    if(jrPositionUsable(x.position)) details.push(`📍現在位置 ${x.position}`);
    else details.push('位置情報未確認・到着は時刻表予定');
    if(x.delay>0) details.push(`${x.delay}分遅れ`);
    const published=x.isOfficialScheduled?'':publishedTrainTurnback(x);
    const turnback=railTurnbackLabel(x.turnback,now);
    if(published) details.push(published);
    else if(turnback) details.push(turnback.replace(/^折り返し /,'折り返し候補（同一車両未確認） '));
    else if(!x.isOfficialScheduled) {
      const departures=Array.isArray(approachLive.ichitsubo?.matsuyamaSchedule)
        ? approachLive.ichitsubo.matsuyamaSchedule : [];
      const arrivalMins=toMinutes(x.arrival);
      const candidates=departures.filter(d=>{
        if(d.direction!==x.side || d.trainClass!==x.trainClass) return false;
        const departureMins=toMinutes(padTime(d.departure||''));
        if(!Number.isFinite(departureMins) || !Number.isFinite(arrivalMins)) return false;
        const delta=(departureMins-arrivalMins+1440)%1440;
        return delta>=4 && delta<=(x.trainClass==='limited'?45:30);
      });
      if(candidates.length){
        const labels=candidates.slice(0,3).map(d=>{
          const label=railLiveTrainLabel({trainNum:d.trainNum,trainClass:d.trainClass});
          const service=label.kind==='limited'?'特急 '+label.service:'普通';
          return `${padTime(d.departure)}発 ${service} ${cleanStation(d.destination)}行`;
        });
        details.push(`折り返し候補（同一車両未確認）：${labels.join(' ／ ')}`);
      } else details.push('折り返し先：同一車両の運用情報を確認できません');
    }
    row.innerHTML=`
      <div class="rail-primary">
        <div class="cell rail-service ${info.kind}"><span class="kindtxt">${serviceBadge}</span></div>
        <div class="cell time">${x.arrival}</div>
        <div class="cell main"><span class="rail-terminal-label" title="松山駅止まり・ここから先へは発車しません">松山止</span>${x.isOfficialScheduled ? ( /臨時列車/.test(String(x.serviceName||'')) ? ` ${x.serviceName}` : ` 伊予灘ものがたり ${x.specialName}` ) : ''}${arrivalRoute?`［${arrivalRoute}］`:``}</div>
      </div>
      <div class="rail-detail">${tickerHtml(details)}</div>`;
    root.appendChild(row);
  }


  // Real-time exceptional movements, including unlisted test runs, are NOT
  // passenger departures. Never turn a position into a made-up station time.
  function matsuyamaObservedSpecialRows(now) {
    if (!jrPositionFeedFresh()) return [];
    const all=Array.isArray(approachLive.ichitsubo?.matsuyamaSpecialTrains)
      ? approachLive.ichitsubo.matsuyamaSpecialTrains : [];
    const alreadyShown=new Set([
      ...matsuyamaDeadheadArrivals(now).map(x=>String(x.trainNum||'')),
      ...matsuyamaFreightPasses(now).filter(x=>jrPositionUsable(x.position))
        .map(x=>String(x.trainNum||''))
    ]);
    const side=currentRailDir();
    return all.filter(x=>{
      if(!x||!jrPositionUsable(x.position)||
         alreadyShown.has(String(x.trainNum||'')))return false;
      const direction=['north','south'].includes(x.direction)?x.direction:
        railDirectionByDestination(x.destination);
      // A train at Matsuyama is not northbound AND southbound. Route direction
      // or confirmed destination wins; location is only a fallback away from
      // the station. Unknown-direction station movements stay in the global
      // ticker rather than appearing on the wrong directional page.
      return direction ? direction===side : x.corridor===side;
    });
  }
  function railSpecialText(value) {
    return String(value??'').replace(/[&<>"']/g, c=>({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    })[c]);
  }
  // A '松山' live position proves location only, not a moving train or
  // established depot storage. Avoid claiming a future Matsuyama arrival
  // for a train already there. Actual layover vs turnback is unverified.
  function railStationedStatus(x, now) {
    const here=cleanStation(x?.position||'');
    // The source confirms location with a yard-shunt label. The live position
    // can be e.g. 松山駅構内 as well as simply 松山.
    if(x?.stationEvent==='shunting' &&
      String(x?.operationLabel||'')==='松山駅構内入換' && /松山/.test(here))
      return '松山駅構内入換（非公式データ）';
    if(!/^(?:松山|松山駅|松山基地)$/.test(here))return '';
    const time=padTime(x?.stationTime||'');
    const depScheduled=x?.stationEvent==='departure' &&
      /^[0-9]{2}:[0-9]{2}$/.test(time) &&
      toMinutes(time)>=now.minutes;
    if(depScheduled)return here+'で発車待ち（位置情報・時刻表）';
    return here+'に在線（留置・折り返し未確認）';
  }

  function appendObservedSpecialTrainRow(root, x) {
    const row=document.createElement('div');
    row.className='row rail-row special-movement-row';
    const kind=['test','deadhead','freight','extra','unknown'].includes(x.kind)?x.kind:'unknown';
    const event=railStationedStatus(x,japanNow()) || ({
      pass:'松山 通過予定', arrival:'松山 到着予定',
      departure:'松山 発車予定',arrival_departure:'松山 発着予定'
    }[x.stationEvent] || '松山駅発着未確認');
    const time=/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(x.stationTime||''))
      ? x.stationTime : '時刻未確認';
    const details=[
      '列車番号 '+railSpecialText(x.trainNum),
      ...(x.eventName?['臨時列車 '+railSpecialText(x.eventName)]:[]),
      ...(x.vehicleSeries?['車両形式 '+railSpecialText(x.vehicleSeries)+'（非公式情報で確認）']:[]),
      '📍現在位置 '+railSpecialText(x.position),
      x.destination?'行先 '+railSpecialText(x.destination):'行先未確認',
      x.stationConfirmed?'松山駅の情報は当日ダイヤ照合':'松山駅の停車・通過は未確認'
    ];
    if(x.stationEvent==='shunting' && x.operationLabel==='松山駅構内入換')
      details.push('非公式運行情報：松山駅構内入換（留置・到着予定とは別）');
    else if(railStationedStatus(x,japanNow()))
      details.push('現在地は確認済み／留置・折返しの実態は未確認');
    if(x.delayMinutes>0)details.push(railSpecialText(x.delayMinutes)+'分遅れ');
    row.innerHTML='<div class="rail-primary">'+
      '<div class="cell rail-service '+kind+'"><span class="kindtxt">'+
      railVehicleIconHtml(x)+railServiceBadgeHtml(kind)+'<span class="rail-name-badge">'+railSpecialText(x.trainNum)+'</span></span></div>'+
      '<div class="cell time">'+railSpecialText(time)+'</div>'+
      '<div class="cell main">'+event+'</div></div>'+
      '<div class="rail-detail">'+tickerHtml(details)+'</div>';
    root.appendChild(row);
  }

  function appendMatsuyamaDeadheadRow(root, x) {
    const row=document.createElement('div');
    row.className='row rail-row deadhead-row';
    const origin=x.origin||'回送区間';
    const details=[`${origin}発の回送列車が松山駅に到着します`];
    if(x.position) details.push(`現在位置 ${x.position}`);
    if(x.delay>0) details.push(`${x.delay}分遅れ`);
    row.innerHTML=`
      <div class="rail-primary">
        <div class="cell rail-service deadhead"><span class="kindtxt">${railVehicleIconHtml(x)}${railServiceBadgeHtml('deadhead')}</span></div>
        <div class="cell time">${x.arrival}</div>
        <div class="cell main">松山　到着</div>
      </div>
      <div class="rail-detail">${tickerHtml(details)}</div>`;
    root.appendChild(row);
  }

  function appendMatsuyamaFreightRow(root, x) {
    const row=document.createElement('div');
    row.className='row rail-row freight-row';
    const routeText=x.origin&&x.destination
      ? `${x.origin} → ${x.destination}`
      : (x.destination ? `${x.destination}方面` : '貨物列車');
    const details=[`貨物列車 ${x.trainNum||''}レ｜${routeText}｜${x.direction==='north'?'今治方面':'宇和島方面'}`];
    if(x.timetableOnly) details.push('時刻表上の通過予定・位置未取得・運行未確認');
    else if(x.position) details.push(`現在位置 ${x.position}`);
    if(x.scheduledIchitsubo) details.push(`市坪駅 ${x.scheduledIchitsubo} 通過予定（当日ダイヤ）`);
    if(x.delay>0) details.push(`${x.delay}分遅れ`);
    row.innerHTML=`
      <div class="rail-primary">
        <div class="cell rail-service freight"><span class="kindtxt">${railVehicleIconHtml(x)}${railServiceBadgeHtml('freight')}<span class="rail-name-badge">${x.trainNum||''}レ</span></span></div>
        <div class="cell time">${x.displayTime||x.passTime||'時刻確認中'}</div>
        <div class="cell main">松山　${x.timetableOnly?'通過予定':'通過'}</div>
      </div>
      <div class="rail-detail">${tickerHtml(details)}</div>`;
    root.appendChild(row);
  }

  // Preserve the active six independent JR ticker DOMs between each
  // ten-second train-location poll. No whole-board innerHTML clearing.
  const railTickerPending = new WeakMap();
  function railRowIdentity(row) {
    if(!row?.classList?.contains('rail-row')) return '';
    if(row.classList.contains('placeholder'))return 'blank';
    const type=row.classList.contains('special-movement-row')?'special':
      row.classList.contains('terminal-arrival-row')?'arrival':
      row.classList.contains('deadhead-row')?'deadhead':
      row.classList.contains('freight-row')?'freight':'passenger';
    const time=row.querySelector('.rail-primary .cell.time')?.textContent?.trim()||'';
    const name=row.querySelector('.rail-primary .rail-service')?.textContent?.trim()||'';
    return type+'|'+time+'|'+name;
  }
  function updateRailTickerAtCycleEnd(oldRow,newRow) {
    const oldDetail=oldRow.querySelector(':scope > .rail-detail');
    const newDetail=newRow.querySelector(':scope > .rail-detail');
    if(!newDetail)return;
    if(!oldDetail){oldRow.appendChild(newDetail.cloneNode(true));return;}
    const desired=newDetail.innerHTML;
    // Animation duration is calibrated after mount and necessarily differs
    // from the temporary off-screen row. Compare CONTENT, not outer HTML:
    // otherwise every ten-second poll falsely treats the same text as new.
    const contentOf=element=>element.querySelector('.marquee-track > span:first-child')?.innerHTML ||
      element.textContent||'';
    if(contentOf(oldDetail)===contentOf(newDetail)){
      railTickerPending.delete(oldDetail);
      return;
    }
    railTickerPending.set(oldDetail,desired);
    const track=oldDetail.querySelector('.marquee-track');
    if(!track || !getComputedStyle(track).animationName.includes('ticker-scroll')){
      oldDetail.innerHTML=desired;
      railTickerPending.delete(oldDetail);
      return;
    }
    if(track.dataset.railDetailUpdateArmed==='1')return;
    track.dataset.railDetailUpdateArmed='1';
    track.addEventListener('animationiteration',e=>{
      if(e.animationName!=='ticker-scroll')return;
      delete track.dataset.railDetailUpdateArmed;
      const upcoming=railTickerPending.get(oldDetail);
      if(typeof upcoming==='string'){
        oldDetail.innerHTML=upcoming;
        calibrateRailTicker(oldRow);
      }
      railTickerPending.delete(oldDetail);
    },{once:true});
  }
  function calibrateRailTicker(row) {
    const track=row.querySelector('.rail-detail .marquee-track');
    const first=track?.firstElementChild;
    if(!first)return;
    // Width is measured in actual glyphs, not arbitrary text length. Long
    // station lists and transfers now get enough time for one complete loop.
    const distance=first.scrollWidth;
    if(distance<=32)return;
    const duration=Math.max(16,Math.min(240,distance/40)).toFixed(1)+'s';
    if(track.style.getPropertyValue('--ticker-duration')!==duration)
      track.style.setProperty('--ticker-duration',duration);
  }
  function reconcileRailRows(visibleRoot,renderedRoot) {
    visibleRoot.classList.toggle('rail-end',renderedRoot.classList.contains('rail-end'));
    const next=[...renderedRoot.children];
    for(let i=0;i<next.length;i++){
      const upcoming=next[i];
      const existing=visibleRoot.children[i];
      if(existing && railRowIdentity(existing) &&
         railRowIdentity(existing)===railRowIdentity(upcoming)){
        // A position or final-service badge may update, but never replace
        // its adjacent scrolling detail element.
        if(existing.className!==upcoming.className)
          existing.className=upcoming.className;
        const oldPrimary=existing.querySelector(':scope > .rail-primary');
        const newPrimary=upcoming.querySelector(':scope > .rail-primary');
        if(oldPrimary&&newPrimary&&oldPrimary.innerHTML!==newPrimary.innerHTML)
          oldPrimary.innerHTML=newPrimary.innerHTML;
        updateRailTickerAtCycleEnd(existing,upcoming);
      }else if(existing){
        visibleRoot.replaceChild(upcoming,existing);
      }else {
        visibleRoot.appendChild(upcoming);
      }
    }
    while(visibleRoot.children.length>next.length)visibleRoot.lastElementChild.remove();
    activatePanelOverflow(visibleRoot);
    [...visibleRoot.querySelectorAll(':scope > .rail-row')]
      .forEach(calibrateRailTicker);
  }

  function syncJrLedArrivals(now) {
    if(!FREEWIFI_TV)return;
    const frame=document.getElementById('jr-led-frame');
    if(!frame?.contentWindow)return;
    // Live position + the operating diagram are both required. Never trigger
    // an approach alert using today's theoretical arrivals by themselves.
    const fresh=jrPositionFeedFresh();
    const data=fresh && Array.isArray(approachLive.ichitsubo?.matsuyamaInboundArrivalAlerts)
      ? approachLive.ichitsubo.matsuyamaInboundArrivalAlerts : [];
    const arrivals=data.filter(x=>
      x?.confirmedApproach===true &&
      x.source==='live_position_and_today_diagram' &&
      ['south','north'].includes(x.side) &&
      /^\d{1,2}:\d{2}$/.test(String(x.arrival||'')) &&
      /^\d{1,5}[MD]$/i.test(String(x.trainNum||'')) &&
      jrPositionUsable(x.position)
    ).slice(0,24).map(x=>({
      side:x.side,arrival:x.arrival,trainNum:x.trainNum,
      confirmedApproach:true,
      // Prefer inbound sets scheduled to reverse at Matsuyama. This is
      // today's diagram, NOT proof of a vehicle's actual next assignment.
      plannedTurnback:x.plannedTurnback===true,
      delayMinutes:Number.isFinite(Number(x.delayMinutes)) &&
        Number(x.delayMinutes)>=0&&Number(x.delayMinutes)<=60
        ? Number(x.delayMinutes):0
    }));
    // Keep stop/connection diagrams separate from live train positioning:
    // timetable data is valid even when positioning is temporarily unavailable.
    const fetched=Date.parse(String(approachLive.generatedAtJst||''));
    const scheduleFresh=approachLive.ok && approachLive.ichitsubo?.ok===true &&
      boardDisplayIso('rail',now)===now.iso && Number.isFinite(fetched) &&
      Date.now()-fetched>=-15000 && Date.now()-fetched<=90000;
    const scheduled=scheduleFresh && Array.isArray(approachLive.ichitsubo?.matsuyamaSchedule)
      ? approachLive.ichitsubo.matsuyamaSchedule : [];
    const joined=scheduleFresh && Array.isArray(approachLive.ichitsubo?.matsuyamaJoinedPortions)
      ? approachLive.ichitsubo.matsuyamaJoinedPortions : [];
    const departures=[...scheduled,...joined].filter(x=>
      ['limited','local'].includes(x?.trainClass) &&
      ['south','north'].includes(x.direction) &&
      /^\d{1,2}:\d{2}$/.test(String(x.departure||'')) &&
      /^\d{1,5}[MD]$/i.test(String(x.trainNum||'')) &&
      Array.isArray(x.stops) && x.stops.length>0
    ).slice(0,160).map(x=>({
      direction:x.direction,departure:String(x.departure),trainNum:String(x.trainNum),
      trunkTrainNum:String(x.trunkTrainNum||''),
      trainClass:x.trainClass,destination:String(x.destination||'').trim(),
      junction:String(x.junction||'').trim(),
      stops:x.stops.filter(st=>st && typeof st.station==='string' &&
        /^\d{1,2}:\d{2}$/.test(String(st.time||''))).slice(0,80)
        .map(st=>({
          station:String(st.station).trim().slice(0,30),
          time:String(st.time),
          event:['arrival','departure'].includes(st.event)?st.event:'timetable'
        })),
      // These are diagram-matched transfer opportunities, NOT a promise to
      // hold a connecting train or a platform assignment.
      transfers:(Array.isArray(x.transfers)?x.transfers:[]).filter(t=>
        t?.source==='today_diagram' &&
        /^\d{1,2}:\d{2}$/.test(String(t.arrival||'')) &&
        /^\d{1,2}:\d{2}$/.test(String(t.departure||'')) &&
        typeof t.station==='string' && typeof t.destination==='string'
      ).slice(0,18).map(t=>({
        station:String(t.station).trim().slice(0,30),
        arrival:String(t.arrival),departure:String(t.departure),
        destination:String(t.destination).trim().slice(0,30),
        trainNum:String(t.trainNum||'').slice(0,12),source:'today_diagram'
      }))
    })).filter(x=>x.stops.length>0);
    try {
      frame.contentWindow.postMessage({
        type:'matsuyama-led-arrivals',
        iso:now.iso,arrivals,departures
      },location.origin);
    } catch(e) {console.warn('JR LED arrival notice unavailable',e);}
  }

  function renderRail(rows) {
    const visibleRoot = $('rail-rows');
    const root=document.createElement('div');
    const now = japanNow();
    syncJrLedArrivals(now);

    // Separate next-limited-express indicator for the currently shown direction.
    // Timetable entries remain valid even when live positioning is unavailable.
    if (FREEWIFI_TV) {
      const nextLimited=rows.filter(r=>r.kind==='limited')
        .sort((a,b)=>toMinutes(a.time)-toMinutes(b.time))[0];
      const nextCard=document.getElementById('rail-next-express');
      if(nextLimited){
        const confirmed=nextLimited.railPositionConfirmed && nextLimited.livePosition;
        const status=confirmed?'現在位置 '+nextLimited.livePosition:'時刻表予定・位置未確認';
        const details=railRowDetailItems(nextLimited);
        nextCard.innerHTML=`<div class="rail-next-main"><span class="rail-next-label">次の特急は？</span><span class="rail-next-service">${railVehicleIconHtml(nextLimited)}${railServiceBadgeHtml('limited',nextLimited.service,nextLimited.info)}</span><span class="rail-next-time">${nextLimited.time}発</span><span class="rail-next-dest">${railDestLabel(nextLimited)}行</span></div><div class="rail-next-details">${tickerHtml(details.length?details:[status])}</div>`;
      } else {
        nextCard.innerHTML='<span class="rail-next-label">次の特急は？</span><span class="rail-next-status">この方面の本日の特急は終了しました</span>';
      }
      // Details remain confined to their independent panel.

      // A separate ordinary-train summary, using the same existing detail ticker.
      const nextLocal=rows.filter(r=>r.kind==='local')
        .sort((a,b)=>toMinutes(a.time)-toMinutes(b.time))[0];
      const localCard=document.getElementById('rail-next-local');
      if(nextLocal){
        const details=railRowDetailItems(nextLocal);
        localCard.innerHTML=`<div class="rail-next-main"><span class="rail-next-label">次の普通列車は？</span><span class="rail-next-service">${railVehicleIconHtml(nextLocal)}${railServiceBadgeHtml('local',nextLocal.service)}</span><span class="rail-next-time">${nextLocal.time}発</span><span class="rail-next-dest">${railDestLabel(nextLocal)}行</span></div><div class="rail-next-details">${tickerHtml(details)}</div>`;
      } else {
        localCard.innerHTML='<span class="rail-next-label">次の普通列車は？</span><span class="rail-next-status">この方面の本日の普通列車は終了しました</span>';
      }
      // The featured card stays in its separate HTML container.
    }

    // Live deadhead arrivals are real train movements too. Show them all day,
    // mixed chronologically with the ordinary/limited-service rows.
    const deadheads = matsuyamaDeadheadArrivals(now).map(x => ({
      _deadhead: true,
      _freight: false,
      _terminalArrival: false,
      // Actual Matsuyama arrival time today, not a rolled-over next day.
      _sortMinutes:toMinutes(x.arrival),
      data: x
    }));
    const freights = matsuyamaFreightPasses(now).map(x => ({
      _deadhead: false,
      _freight: true,
      // No fabricated +15min position. When freight passage time is
      // unknown, mark it unscheduled and put it after timestamped trains.
      _sortMinutes:/^[0-9]{2}:[0-9]{2}$/.test(String(x.passTime||''))
        ? toMinutes(x.passTime) : Number.POSITIVE_INFINITY,
      data: x
    }));
    const observedSpecials=matsuyamaObservedSpecialRows(now).map(x=>({
      _special:true,
      // Only the actual Matsuyama station diagram gives a board time.
      // A live vehicle fix alone is NEVER an estimated Matsuyama stop time.
      _sortMinutes:x.stationConfirmed===true &&
        /^[0-9]{1,2}:[0-9]{2}$/.test(String(x.stationTime||''))
        ? toMinutes(padTime(x.stationTime))
        : Number.POSITIVE_INFINITY,
      data:x
    })).filter(x=>x._sortMinutes>=now.minutes);
    const terminalArrivals = matsuyamaTerminatingArrivals(now).map(x => ({
      _deadhead: false,
      _freight: false,
      _terminalArrival: true,
      _sortMinutes: now.minutes + x.diff,
      data: x
    }));
    // Featured next trains also remain visible in the chronological departures below.
    const services = rows.map(r => ({
      _deadhead: false,
      _freight: false,
      // These are TODAY'S services. Never roll an elapsed time into tomorrow.
      _sortMinutes: toMinutes(padTime(r.time||'')),
      data: r
    }));
    // Six visible rows below the authentic JR LED board, including deadheads/freight.
    const sixRowLedView=FREEWIFI_TV && !!document.getElementById('jr-led-embed');
    const limit=sixRowLedView ? 6 : (FREEWIFI_TV ? (document.documentElement.classList.contains('company-pc') ? 9 : 8) : 3);
    const candidates=[...services, ...terminalArrivals, ...deadheads, ...freights, ...observedSpecials]
      // Departures, arrivals and passes are removed as soon as their actual
      // displayed minute has elapsed. Stale live positions NEVER keep an
      // already-passed train on the six-row board. Unconfirmed times omitted.
      .filter(item=>Number.isFinite(item._sortMinutes) &&
                    item._sortMinutes >= now.minutes)
      .sort((a,b)=>a._sortMinutes-b._sortMinutes);
    // A live special train without a Matsuyama diagram time must NOT vanish.
    // Place it in a spare sixth-row slot AFTER time-ordered trains, with the
    // honest "時刻未確認" label. Do not displace known departures.
    const untimedLiveExtras=observedSpecials
      .filter(item=>!Number.isFinite(item._sortMinutes) &&
                    item.data?.kind==='extra' &&
                    jrPositionUsable(item.data?.position))
      .sort((a,b)=>String(a.data.trainNum||'').localeCompare(
        String(b.data.trainNum||''),'ja'));
    // The original LED iframe has the published passenger timetable already.
    // Share ONLY real, time-bearing pass-through movements verified by the
    // SAME live feed as this six-row list. No guessed freight passage times.
    if(FREEWIFI_TV){
      const frame=document.getElementById('jr-led-frame');
      if(frame?.contentWindow){
        const side=currentRailDir();
        const knownFreight=freights.filter(v=>
          v.data?.direction===side &&
          Number.isFinite(v._sortMinutes) &&
          v._sortMinutes>=now.minutes-2
        ).map(v=>({
          kind:'freight',time:v.data.passTime,trainNum:String(v.data.trainNum||''),
          direction:side, destination:String(v.data.destination||''),
          timetableOnly:!!v.data.timetableOnly, confirmed:!v.data.timetableOnly
        }));
        const observedPasses=observedSpecials.filter(v=>
          v.data?.stationEvent==='pass' &&
          v.data?.stationConfirmed===true &&
          Number.isFinite(v._sortMinutes) &&
          v._sortMinutes>=now.minutes-2 &&
          (v.data?.corridor===side || v.data?.corridor==='both')
        ).map(v=>({
          kind:'pass',time:padTime(v.data.stationTime),
          trainNum:String(v.data.trainNum||''),direction:side,
          destination:String(v.data.destination||''),
          timetableOnly:false,confirmed:true
        }));
        try{
          frame.contentWindow.postMessage({
            type:'matsuyama-led-movements',
            direction:side,iso:now.iso,
            movements:[...knownFreight,...observedPasses]
          },location.origin);
        }catch(e){console.warn('JR LED passage data unavailable',e);}
      }
    }
    // JR departures, arrivals, freight and deadheads use ONE timeline.
    // Never reserve priority slots by train category: earlier times always
    // come before later times, including specials/terminal arrivals.
    const visible=[...candidates,...untimedLiveExtras].slice(0,limit);
    // Departure order is independent of train type and the upper summary cards.
    // Use the full future passenger departure list, not just visible rows:
    // arrivals, freight and deadheads never receive departure-order marks.
    const departureRanks=new Map();
    services.slice().sort((a,b)=>a._sortMinutes-b._sortMinutes)
      .forEach((item,index)=>{if(index<2)departureRanks.set(item.data,index+1);});

    if (!visible.length) {
      // A missing live fix must never be described as an ended service.
      const mode=currentRailDir()==='north'?'NORTHBOUND — 今治方面 —':'SOUTHBOUND — 宇和島方面 —';
      root.classList.add('rail-end');
      root.insertAdjacentHTML('beforeend',`<div class="rail-end-state"><div class="rail-end-mode">🚆 ${mode}</div><div class="rail-end-message">現在表示できる列車はありません</div></div>`);
    } else {
      visible.forEach(item => {
        if(item._special){
          appendObservedSpecialTrainRow(root,item.data);
          return;
        }
        if(item._deadhead){
          appendMatsuyamaDeadheadRow(root,item.data);
          return;
        }
        if(item._freight){
          appendMatsuyamaFreightRow(root,item.data);
          return;
        }
        if(item._terminalArrival){
          appendMatsuyamaTerminalArrivalRow(root,item.data,now);
          return;
        }
        const r=item.data;
        const row = document.createElement('div'); row.className = `row rail-row${r.kind==='extra'?' rail-event-extra-row':''}${r.isFinal ? ' is-final' : ''}${isDepartSoon(r, now) ? ' depart-soon' : ''}`;
        const kind = r.kind === 'limited' ? 'limited' : r.kind === 'sightseeing' ? 'tourist' : r.kind === 'extra' ? 'extra' : 'local';
        const serviceBadge = railVehicleIconHtml(r)+railServiceBadgeHtml(kind,r.service,r.info);
        const departureRank=departureRanks.get(r);
        const departureMark=departureRank===1
          ? '<span class="rail-order-badge rail-order-next" aria-label="発車順一番目">次発</span>'
          : departureRank===2
            ? '<span class="rail-order-badge rail-order-second" aria-label="発車順二番目">次々発</span>'
            : '';
        const badges = `${r.isNextDayStart ? badgeHtml('first') : ''}${railSpecialFinalBadge(r,now)}`;
        row.innerHTML = `
          <div class="rail-primary">
            <div class="cell rail-service ${kind}"><span class="kindtxt">${serviceBadge}</span></div>
            <div class="cell time">${r.time}</div>
            <div class="cell main">${departureMark}${railDestLabel(r)}行 ${badges}</div>
          </div>
          <div class="rail-detail">${tickerHtml(railRowDetailItems(r))}</div>`;
        root.appendChild(row);
      });
      while (root.children.length < (sixRowLedView ? 6 : 3)) {
        const row=document.createElement('div'); row.className='row rail-row placeholder blank';
        row.innerHTML=`<div class="rail-primary"><div class="cell"></div><div class="cell time"></div><div class="cell"></div></div><div class="rail-detail"></div>`;
        root.appendChild(row);
      }
    }
    reconcileRailRows(visibleRoot,root);
  }

  function lastAirMovement(now, dep) {
    const direction=dep?'departure':'arrival';
    const displayIso = boardDisplayIso('air', now);
    const displayCtx = dayContext(displayIso);
    const rows=data.records
      .filter(r=>r.board==='air' && r.direction===direction && validRecord(r,displayIso))
      .map(r=>({...r,_time:effectiveTime(r,displayCtx)}))
      .sort((a,b)=>toMinutes(a._time)-toMinutes(b._time));
    if(!rows.length) return null;
    const lastMinute=toMinutes(rows[rows.length-1]._time);
    const tied=rows.filter(r=>toMinutes(r._time)===lastMinute);
    const places=[...new Set(tied.map(r=>String(r.dest||'').trim()).filter(Boolean))];
    return { time:rows[rows.length-1]._time, place:places.join('・')||'—', displayIso };
  }
  function lastRailMovement(now) {
    const displayIso = boardDisplayIso('rail', now);
    const displayCtx = dayContext(displayIso);
    const rows = data.records
      .filter(r => r.board === 'rail' && validRecord(r, displayIso))
      .map(r => ({ ...r, _time: effectiveTime(r, displayCtx) }))
      .sort((a,b)=>toMinutes(a._time)-toMinutes(b._time));
    if (!rows.length) return null;
    const last = rows[rows.length-1];
    return { time: last._time, dest: String(last.dest || '').trim() || '—', service: String(last.service || '').trim() || '', kind: String(last.kind || ''), direction:String(last.direction||''), displayIso };
  }

  // Approximate flight phase, not a tracked aircraft position.
  function airportApproximatePosition(r, departure, now) {
    const status=String(r.liveStatus||r.info||'');
    if(/欠航|運休|取消|キャンセル/.test(status)) return '';
    const arrivalOrDeparture=padTime(r.liveChangedTime||r.time||'');
    if(!/^\d{2}:\d{2}$/.test(arrivalOrDeparture) || r.isNextDayStart) return '';
    if(departure){
      const minutesLeft=toMinutes(arrivalOrDeparture)-now.minutes;
      // No gate or aircraft assignment is known, so do not assert an exact berth.
      return minutesLeft>=0 && minutesLeft<=25 ? '松山空港 出発準備中（見込）' : '';
    }
    const raw=r.liveRaw||{};
    // Direct ADS-B aircraft coordinates take priority over time-derived estimates.
    const observation=Date.parse(String(raw.aircraftObservedAt||''));
    if(raw.aircraftPositionConfirmed===true && Number.isFinite(observation) &&
      Date.now()-observation>=-15000 && Date.now()-observation<=105000 &&
      /^(waiting|airborne|approaching)$/.test(String(raw.aircraftFlightPhase||''))) {
      return String(raw.aircraftPositionText||'');
    }
    // No coordinate fix means no claim about the aircraft's current location.
    if(raw.originDepartureVerified===true)return '';
    const origin=String(raw.originAirport||r.dest||'出発地').trim();
    const dep=padTime(raw.originDepartureActual||'');
    if(!/^\d{2}:\d{2}$/.test(dep)) return '';
    const progress=estimatedJourneyProgress(dep,arrivalOrDeparture,now,'');
    if(progress===null || /到着済み|ただいま到着/.test(status)) return '';
    const label=progress<0.15 ? `${origin}周辺` : progress<0.8 ? '航路中間' : '松山空港接近';
    // An official departure timestamp, when supplied, is not an ADS-B fix.
    return `${label}（時刻表による見込）`;
  }

  function renderAir(rows) {
    const root=$('air-rows'); root.innerHTML=''; const dep=currentDirection()==='departure';
    root.classList.remove('air-end');
    if(!rows.length){
      const now=japanNow(); const last=dep?lastAirMovement(now,true):null;
      root.classList.add('air-end');
      const mode=dep?'DEPARTURES — 出発便 —':'ARRIVALS — 到着便 —';
      const arrivalBoardState=dep?'':airportArrivalBoardState(now);
      const msg=dep?'本日の出発便は終了しました'
        :arrivalBoardState==='unverified'?'公式到着情報を取得・確認中'
        :arrivalBoardState==='pending'?'公式到着情報を確認中（終了未確定）'
        :now.minutes>=AIRPORT_ARRIVAL_CURFEW_MINUTES?'本日の到着便は終了しました'
        :'現在表示できる到着予定便はありません';
      const detail=dep && last ? `最終出発便：${last.place}行　${last.time}　出発済み` : (dep?'':japanNow().minutes>=AIRPORT_ARRIVAL_CURFEW_MINUTES
        ?'22:00以降も公式案内が未完了の便は引き続き表示'
        :'公式の当日到着案内を取得できた便のみ表示');
      root.innerHTML=`<div class="air-end-state"><div class="air-end-mode">✈ ${mode}</div><div class="air-end-message">${msg}</div>${detail?`<div class="air-end-detail">${detail}</div>`:''}</div>`;
    } else {
      const companyPc=document.documentElement.classList.contains('company-pc');
      const visibleRows=FREEWIFI_TV ? rows.slice(0,companyPc?11:10) : rows;
      visibleRows.forEach(r=>{
      const row=document.createElement('div');row.className=`row air-board-row${r.isFinal?' is-final':''}${dep&&isDepartSoon(r,japanNow())?' depart-soon':''}`;
      const p=parseAirService(r.service);
      const finalBadge=dep&&r.isFinal?badgeHtml('final','最終便'):'';
      const place=String(r.dest||'—');
      const firstBadge=r.isNextDayStart?badgeHtml('first',dep?'始発':'初便'):'';
      const publishedDestinationArrival=dep?padTime(
        r.destinationArrivalScheduled||r.liveRaw?.destinationArrivalScheduled||''):'';
      // Exact-match official timetable only; never fabricate an estimated ETA.
      const arrivalForDisplay=/^([01]\d|2[0-3]):[0-5]\d$/.test(publishedDestinationArrival)
        ? publishedDestinationArrival : '';
      const arrivalTimeBasis=String(r.liveRaw?.destinationArrivalTimezone||'')==='現地時刻'
        ? '（現地）' : '';
      const placeHtml=arrivalForDisplay
        ? `<span class="air-place-primary">${place} ${firstBadge}${finalBadge}</span><span class="air-arrival-scheduled">到着予定 ${arrivalForDisplay}${arrivalTimeBasis}</span>`
        : `${place} ${firstBadge}${finalBadge}`;
      const airlineName=airServiceHtml(r,p);
      const airlineKey=/ANA/i.test(p.airline)?'ana':/JAL/i.test(p.airline)?'jal':/IBEX/i.test(p.airline)?'ibex':/Jetstar/i.test(p.airline)?'jetstar':/チェジュ/i.test(p.airline)?'jeju':/エアプサン/i.test(p.airline)?'busan':/エバー/i.test(p.airline)?'eva':'other';
      row.classList.add(`airline-${airlineKey}`);
      const status=r.liveRaw?String(r.liveStatus||r.info||'').trim()
        :(airportLiveHasPreviousDayStatuses(japanNow())
          ?'時刻表（当日運航情報の更新待ち）'
          :String(r.liveStatus||r.info||'').trim());
      const changed=r.liveChangedTime||r.time;
      const scheduled=r.liveScheduled||r.time;
      const delta=Number(r.liveDelta);
      const guidanceBase=status||'—';
      let guidance=(Number.isFinite(delta)&&delta!==0 && !new RegExp(`[+-]${Math.abs(delta)}分`).test(guidanceBase))
        ? `${guidanceBase}　${delta>0?'遅れ':'早着'} ${delta>0?'+':''}${delta}分`
        : guidanceBase;

      if(!dep){
        const raw=r.liveRaw||{};
        const originAirport=String(raw.originDepartureAirport||raw.originAirport||'').trim();
        const scheduledOrigin=padTime(raw.originDepartureScheduled||'');
        const actualOrigin=padTime(raw.originDepartureVerified || raw.originDepartureConfirmed ? raw.originDepartureActual : '');
        if(originAirport && actualOrigin){
          const prefix=scheduledOrigin && actualOrigin===scheduledOrigin ? '定刻通り ' : '';
          const originInfo=`${prefix}${actualOrigin}に${originAirport}を出発`;
          guidance = guidance && guidance!=='—' ? `${guidance}　｜　${originInfo}` : originInfo;
        } else if(raw.originDepartureVerified===true && raw.originDepartureStatus==='出発済み'){
          const originInfo=`${originAirport||'出発空港'}から出発済み（公式確認）`;
          guidance = guidance && guidance!=='—' ? `${guidance}　｜　${originInfo}` : originInfo;
        } else if(originAirport && scheduledOrigin){
          const originInfo=`${originAirport} ${scheduledOrigin}発（予定時刻）`;
          guidance = guidance && guidance!=='—' ? `${guidance}　｜　${originInfo}` : originInfo;
        }
      }
      const approx=airportApproximatePosition(r,dep,japanNow());
      if(approx) guidance=guidance && guidance!=='—' ? `${guidance}　｜　${approx}` : approx;
      const guidanceAlert=/遅|欠航|運休|変更|受付|保安|搭乗|まもなく|到着/.test(guidance);
      const statusClass=`cell air-guidance${guidanceAlert?' air-guidance-alert':''}${guidance.length>14?' long-status':''}`;
      const deltaHtml=Number.isFinite(delta)&&delta!==0?`<span class="air-delay-minutes ${delta<0?'air-early':''}">${delta>0?'+':''}${delta}分</span>`:'';
      const timeHtml=changed!==scheduled
        ?`<div class="air-time-wrap air-time-changed"><span class="scheduled-time-row"><span class="scheduled-label">定刻</span><span class="scheduled-time">${scheduled}</span><span class="air-time-arrow">→</span></span><span class="live-time changed">${changed}</span></div>`
        :`<div class="air-time-wrap"><span class="live-time">${changed}</span></div>`;
      row.innerHTML=`
        <div class="cell air-service-cell">
          <span class="airline-strip" aria-hidden="true"></span>
          <div class="service-wrap airline-service-wrap">${airlineName}</div>
        </div>
        <div class="cell main air-place">${placeHtml}</div>
        <div class="cell time air-board-time">${timeHtml}</div>
        <div class="${statusClass}">${overflowScrollHtml(guidance,'air-status-scroll')}</div>`;
      root.appendChild(row);
      });
    }
    activatePanelOverflow(root); restoreScroll('air'); attachScrollMemory('air');
  }

  const BUS_JOINT_OPERATORS = {
    jr_osaka: 'JR四国バス / 西日本JRバス',
    jr_takamatsu: 'JR四国バス / 伊予鉄バス / 四国高速バス',
    jr_takamatsu_new: 'JR四国バス / 伊予鉄バス / 四国高速バス',
    iyo_city_takamatsu_sep: 'JR四国バス / 伊予鉄バス / 四国高速バス',
    iyo_city_takamatsu_oct: 'JR四国バス / 伊予鉄バス / 四国高速バス',
    bus_tokushima: 'JR四国バス / 伊予鉄バス / 徳島バス',
    jr_tokushima_new: 'JR四国バス / 伊予鉄バス / 徳島バス',
    iyo_city_tokushima_sep: 'JR四国バス / 伊予鉄バス / 徳島バス',
    iyo_city_tokushima_oct: 'JR四国バス / 伊予鉄バス / 徳島バス',
    bus_okayama: '伊予鉄バス / 両備バス / 下電バス',
    bus_kochi: '伊予鉄バス / とさでん交通',
    iyo_city_osaka: '伊予鉄バス / 阪急観光バス',
    iyo_city_osaka_arrival: '伊予鉄バス / 阪急観光バス',
    nagoya: 'JR四国バス / JR東海バス / 伊予鉄バス / 名鉄バス',
    iyo_city_nagoya: 'JR四国バス / JR東海バス / 伊予鉄バス / 名鉄バス',
    iyo_city_fukuoka: '伊予鉄バス / 伊予鉄南予バス / せとうちバス',
    iyotetsu_tokyo_202609: '伊予鉄バス / 西東京バス'
  };
  const BUS_REPRESENTATIVE_OPERATOR = {
    jr_osaka: 'JR四国バス',
    jr_takamatsu: '伊予鉄バス',
    jr_takamatsu_new: '伊予鉄バス',
    iyo_city_takamatsu_sep: '伊予鉄バス',
    iyo_city_takamatsu_oct: '伊予鉄バス',
    bus_tokushima: '伊予鉄バス',
    jr_tokushima_new: '伊予鉄バス',
    iyo_city_tokushima_sep: '伊予鉄バス',
    iyo_city_tokushima_oct: '伊予鉄バス',
    bus_okayama: '伊予鉄バス',
    iyo_city_okayama: '伊予鉄バス',
    bus_kochi: '伊予鉄バス',
    iyo_city_osaka: '伊予鉄バス',
    iyo_city_osaka_arrival: '伊予鉄バス',
    nagoya: '伊予鉄バス',
    iyo_city_nagoya: '伊予鉄バス',
    iyo_city_fukuoka: '伊予鉄バス',
    iyotetsu_tokyo_202609: '伊予鉄バス'
  };
  function busOperatorLabel(r) {
    if (r.actualOperator) return r.actualOperator;
    const representative=BUS_REPRESENTATIVE_OPERATOR[r.source];
    if (representative) return representative;
    const raw=String(r.service||'').trim();
    // Operator badges show the company name only. The Imabari service name
    // includes its route description, which exceeds the fixed operator column.
    // Keep 今治桟橋 / 宮浦港 and the via-route in the destination cells.
    if (r.source==='setouchi_omishima' && raw==='せとうちバス（今治・松山特急）')
      return 'せとうちバス';
    // Last safety net: never render a row of multiple operator logos.
    if (/\s*\/\s*/.test(raw)) {
      const first=raw.split(/\s*\/\s*/).filter(Boolean)[0]||'';
      return BUS_OPERATOR_TOKEN[first]||first;
    }
    return raw;
  }
  const BUS_OPERATOR_TOKEN = {
    'JR四国':'JR四国バス','伊予鉄':'伊予鉄バス','四国高速':'四国高速バス','名鉄':'名鉄バス',
    'JR東海':'JR東海バス','南予':'伊予鉄南予バス','せとうち':'せとうちバス','西日本JR':'西日本JRバス',
    '阪急観光':'阪急観光バス'
  };
  function busOperatorParts(r) {
    const raw=String(busOperatorLabel(r)||'').trim();
    if (!raw) return ['—'];
    const parts=raw.split(/\s*\/\s*/).filter(Boolean).map(x=>BUS_OPERATOR_TOKEN[x]||x);
    return parts;
  }
  function operatorLogoImage(kind, cls, label, src, fallback) {
    return `<span class="${kind}-mini-logo ${cls} brand-logo-image no-auto-scroll" title="${label}">
      <span class="brand-logo-fallback">${fallback}</span>
      <img src="${src}" alt="${label}" loading="eager" referrerpolicy="no-referrer">
    </span>`;
  }

  function busMiniLogo(name) {
    // Bus operator badges use Japanese company names only: no English
    // wordmarks, Romanized taglines or separate Latin headings.
    // Keep each company's existing visual colour through the logo class.
    const raw=String(name||'').trim();
    const names={
      'WILLER EXPRESS':'ウィラーエクスプレス',
      'KOTOBUS':'琴平バス',
      'SHINKI BUS':'神姫バス',
      'TOKUBUS':'徳島バス',
      'SHIMODEN':'下電バス',
      'IYOTETSU':'伊予鉄バス'
    };
    const n=names[raw]||raw||'—';
    const styles={
      '伊予鉄バス':'iyo','伊予鉄南予バス':'nanyo',
      'JR四国バス':'jrshikoku','西日本JRバス':'jrwest',
      'JR東海バス':'jrtokai','四国高速バス':'shikoku',
      '徳島バス':'tokushima','下電バス':'shimoden',
      'とさでん交通':'tosaden','阪急観光バス':'hankyu',
      '名鉄バス':'meitetsu','せとうちバス':'setouchi',
      '西東京バス':'nishitokyo','ウィラーエクスプレス':'willer',
      '宇和島自動車':'uwajima','本四バス':'honshi',
      '琴平バス':'kotobus','神姫バス':'shinki',
      'しまなみバス':'shimanami','両備バス':'ryobi',
      '中国バス':'chugoku'
    };
    const theme=styles[n]||'generic';
    return `<span class="bus-mini-logo bus-logo-${theme} brand-logo-custom bus-logo-japanese no-auto-scroll" title="${n}"><span class="brand-word">${n}</span></span>`;
  }
  function busOperatorHtml(r) {
    const parts=busOperatorParts(r);
    return `<div class="operator-wrap bus-logo-group">${parts.map(busMiniLogo).join('')}</div>`;
  }
  function splitDestinationLines(text) {
    let s=String(text||'').replace(/（オレンジフェリー連絡）/g,'').replace(/\s+/g,' ').trim();
    if (!s) return ['—'];

    // 「○○経由 △△」は終着を先に大きく、経由を2段目に出す。
    const via=s.match(/^(.*?経由)\s+(.+)$/);
    if (via) return [via[2],via[1]];
    if (s.length<=11) return [s];

    const par=s.indexOf('（');
    if (par>3) return [s.slice(0,par),s.slice(par)];

    const parts=s.split('・').filter(Boolean);
    if (parts.length>=3) {
      const lines=[];
      for (const part of parts) {
        const last=lines[lines.length-1];
        if (last && `${last}・${part}`.length<=10 && lines.length<=2) lines[lines.length-1]=`${last}・${part}`;
        else if (lines.length<3) lines.push(part);
        else lines[2]=`${lines[2]}・${part}`;
      }
      return lines;
    }
    if (parts.length===2) return parts;
    return [s];
  }
  function overflowScrollHtml(text, extraClass='') {
    return `<span class="overflow-scroll ${extraClass}"><span class="overflow-scroll-track"><span class="overflow-scroll-copy">${text||'—'}</span></span></span>`;
  }
  const overflowObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(entries => {
        entries.forEach(entry => syncOverflowBox(entry.target));
      })
    : null;

  function syncOverflowBox(box) {
    if(!box || !box.isConnected) return;
    const track=box.querySelector(':scope > .overflow-scroll-track');
    if(!track) return;

    let copy=track.querySelector(':scope > .overflow-scroll-copy:not(.overflow-scroll-clone)');
    if(!copy){
      copy=document.createElement('span');
      copy.className='overflow-scroll-copy';
      while(track.firstChild) copy.appendChild(track.firstChild);
      track.appendChild(copy);
    }

    const clone=track.querySelector(':scope > .overflow-scroll-clone');
    const boxWidth=box.getBoundingClientRect().width;
    const copyWidth=Math.max(copy.scrollWidth,copy.getBoundingClientRect().width);
    if(!(boxWidth>0) || !(copyWidth>0)) return;

    const overflowPx=Math.max(0,copyWidth-boxWidth);
    const over=overflowPx>2;

    if(over){
      if(!clone){
        const dup=copy.cloneNode(true);
        dup.classList.add('overflow-scroll-clone');
        dup.setAttribute('aria-hidden','true');
        track.appendChild(dup);
      }
      const gap=32;
      const distance=Math.ceil(copyWidth+gap);
      const duration=Math.max(9,Math.min(22,distance/28));
      if(box.style.getPropertyValue('--overflow-distance')!==`${distance}px`) {
        box.style.setProperty('--overflow-distance',`${distance}px`);
      }
      if(box.style.getPropertyValue('--overflow-duration')!==`${duration.toFixed(1)}s`) {
        box.style.setProperty('--overflow-duration',`${duration.toFixed(1)}s`);
      }
      box.classList.add('is-overflow');
    } else {
      if(clone) clone.remove();
      box.classList.remove('is-overflow');
      box.style.removeProperty('--overflow-distance');
      box.style.removeProperty('--overflow-duration');
    }
  }

  function activateOverflowScroll(root=document) {
    const boxes=[...root.querySelectorAll('.overflow-scroll')];
    boxes.forEach(box => {
      syncOverflowBox(box);
      if(overflowObserver && !box.dataset.overflowObserved){
        overflowObserver.observe(box);
        box.dataset.overflowObserved='1';
      }
    });
    // Measure again after grid/flex/layout and webfont calculations settle.
    requestAnimationFrame(()=>boxes.forEach(syncOverflowBox));
    setTimeout(()=>boxes.filter(box=>box.isConnected).forEach(syncOverflowBox),120);
  }

  // Common rule: readable text stays still; only text that actually exceeds its box scrolls.
  function activatePanelOverflow(root=document) {
    const selector = [
      '.rail-primary .rail-service .kindtxt',
      '.rail-primary .cell.main',
      '.cell.main.air-place',
      '.service-wrap .name',
      '.service-wrap .code',
      '.bus-destination-line',
      '.bus-via-line',
      '.bus-place-scroll',
      '.bus-terminal-time',
      '.arrival-terminal',
      '.arrival-continuation',
      '.arrival-departure-time',
      '.bus-estimated-position',
      '.port-dest-main',
      '.port-via-line',
      '.port-arrival-line',
      '.port-route',
      '.port-estimated-position',
      '.air-status'
    ].join(',');

    root.querySelectorAll(selector).forEach(el => {
      if (el.closest('.marquee')) return;
      if (el.classList.contains('overflow-scroll')) return;
      if (el.querySelector(':scope > .overflow-scroll')) return;
      if (el.classList.contains('port-route') && el.querySelector('.port-dest-wrap')) return;
      // Ferry destinations and via-port labels are short: keep the whole left column stationary.
      if (el.closest('.panel-port .port-route-main')) return;
      if (el.classList.contains('air-status') && el.querySelector('.overflow-scroll')) return;
      if (el.classList.contains('no-auto-scroll')) return;
      // The JR limited-express service name must stay fixed. Widen its first
      // grid column rather than turning the name into a moving ticker.
      if (el.matches('.rail-primary .rail-service.limited .kindtxt')) return;
      if (el.closest('.bus-mini-logo')) return;

      const wrap=document.createElement('span');
      wrap.className='overflow-scroll auto-overflow';
      const track=document.createElement('span');
      track.className='overflow-scroll-track';
      const copy=document.createElement('span');
      copy.className='overflow-scroll-copy';
      while(el.firstChild) copy.appendChild(el.firstChild);
      track.appendChild(copy);
      wrap.appendChild(track);
      el.appendChild(wrap);
    });

    activateOverflowScroll(root);
  }

  function busDestinationParts(r) {
    const raw=String(busDisplayDestination(r)||'').replace(/\s+/g,' ').trim();
    let destination=raw || '—';
    let via='';
    const viaDest=raw.match(/^(.*?経由)\s+(.+)$/);
    if(viaDest){ via=viaDest[1].trim(); destination=viaDest[2].trim(); }
    const info=String(r.info||'').replace(/\s+/g,' ').trim();
    if(/経由/.test(info)) via=info;
    destination=destination.replace(/\s*行$/,'');
    return {destination,via};
  }
  function busDestinationHtml(r,badges='') {
    const p=busDestinationParts(r);
    const first='<span class="dest-line bus-destination-line">'+p.destination+' 行'+(badges?' '+badges:'')+'</span>';
    const second=p.via
      ? '<span class="bus-via-line">'+overflowScrollHtml(p.via,'bus-via-scroll')+'</span>'
      : '';
    return first+second;
  }
  function busArrivalContinuationLabel(r) {
    if (!r.continueTo) return '';
    const time = r.continueArrival ? ` ${r.continueNextDay ? '翌' : ''}${r.continueArrival}頃予定` : '';
    return `終着 ${r.continueTo}${time}`;
  }
  function busDisplayDestination(r) {
    return r.displayDest || r.dest || '';
  }
  function busTerminalName(r) {
    const d=String(busDisplayDestination(r)||r.dest||'').replace(/（.*?）/g,'').trim();
    const via=d.match(/経由\s+(.+)$/);
    if (via) return via[1].trim();
    const parts=d.split('・').map(x=>x.trim()).filter(Boolean);
    return parts[parts.length-1] || d || '終着';
  }
  function busTerminalArrivalLabel(r) {
    if (r.terminalNote) return `終着 ${r.terminalNote.replace(/着$/, '着予定')}`;
    const terminal=busTerminalName(r);
    if (r.terminalArrival) return `終着 ${terminal} ${r.terminalArrivalNextDay ? '翌' : ''}${r.terminalArrival}予定`;
    const t = addMinutes(r.time, busTravelMinutes(r.dest));
    const nextDay = toMinutes(t) < toMinutes(r.time);
    return `終着 ${terminal} ${nextDay ? '翌' : ''}${t}頃予定`;
  }

  function lastBusMovement(now, dep) {
    const list = getBoardRecords('bus', now).slice().sort((a,b)=>rMinutes(a)-rMinutes(b));
    if (!list.length) return null;
    const last = list[list.length-1];
    if (dep) {
      return {
        time: last.time,
        place: busDisplayDestination(last) || last.dest || '—',
        operator: busOperatorParts(last).join('・')
      };
    }
    return {
      time: last.arrivalTerminalTime || last.time,
      place: last.origin || last.dest || '—',
      terminal: last.arrivalTerminal || '松山',
      operator: busOperatorParts(last).join('・')
    };
  }

  function busBoardingPlaceHtml(r) {
    const raw=String(r.stopText||r.stop||'松山市駅').replace(/発$/,'').trim();
    const stop=raw || '松山市駅';
    return `<span class="bus-place-text">${stop}</span>`;
  }

  function busEhimeRoute(r) {
    const src=String(r.source||'');
    const dest=String(r.dest||'');
    const info=String(r.info||'');
    const stop=String(r.stop||'');
    const start=String(r.originStartName||'').trim();
    const startTime=String(r.originStartTime||'').trim();
    const parts=[];

    if (start && startTime && start!==stop) {
      parts.push(`始発 ${start} ${startTime}`);
    }

    if (/jr_osaka/.test(src)) {
      parts.push('大街道','松山インター口','川内インター');
      if(info) parts.push(...info.split('・').filter(Boolean));
    } else if (/orange_ferry_shuttle/.test(src)) {
      const timed=[...info.matchAll(/(松山市駅|松山IC口|川内IC)(\d{1,2}:\d{2})/g)]
        .map(m=>`${m[1]} ${m[2]}`);
      if (timed.length) parts.push(...timed);
    } else if (/koto/.test(src)) {
      parts.push('三島川之江IC','コトバスステーション鳴門IC（乗換）');
    } else if (/willer_202609/.test(src)) {
      parts.push('神戸三宮','USJ','大阪梅田');
    } else if (/iyotetsu_misaki/.test(src)) {
      parts.push('伊予市','中山','内子','大洲','八幡浜駅前','八幡浜港','伊方');
    } else if (/uwajima_bus_matsuyama/.test(src)) {
      if (/大洲/.test(info)) parts.push('大洲');
      if (/卯之町/.test(info)) parts.push('卯之町');
      if (/吉田/.test(info)) parts.push('吉田');
      if (/城辺/.test(dest) || /宇和島経由/.test(info)) parts.push('宇和島');
    } else if (/setouchi_omishima/.test(src)) {
      parts.push('奥道後','玉川','今治');
    } else if (/iyotetsu_niihama/.test(src)) {
      if (stop==='JR松山駅') parts.push('松山市駅');
      parts.push('大街道','新久米','四国がんセンター','横河原','川内','西条駅前');
    } else if (/iyotetsu_tokyo|iyo_city_fukuoka/.test(src) || /東京|横浜|福岡/.test(dest)) {
      parts.push('余戸南インター','松山インター口','川内インター');
      if (/福岡/.test(dest)) parts.push('今治桟橋','今治駅前');
    } else if (/jr_osaka|takamatsu|tokushima|kochi|okayama|nagoya|iyo_city_(?:osaka|takamatsu|tokushima|kochi|okayama|nagoya)/.test(src)
      || /大阪|京都|神戸|高松|徳島|高知|岡山|名古屋/.test(dest)) {
      if (stop==='JR松山駅') parts.push('松山市駅');
      parts.push('松山インター口','川内インター');
    } else if (/新尾道|福山/.test(dest)) {
      parts.push('松山インター口','川内インター','来島海峡BS','大島BS');
    }

    const seen=new Set();
    const cleaned=parts.filter(x=>{
      const k=String(x).replace(/\s+/g,' ').trim();
      if(!k || seen.has(k)) return false;
      seen.add(k); return true;
    });
    return cleaned.join(' → ');
  }

  function busBoardingSubline(r) {
    return busEhimeRoute(r);
  }

  // Stops and times from published operator timetables. Neither
  // scheduled passage nor a time between stops confirms actual position.
  const BUS_INBOUND_CHECKPOINTS={"iyo_city_osaka_arrival":{"names":["京都駅八条口","名神大山崎","名神高槻","大阪梅田（阪急三番街）","新大阪","千里ニュータウン","千里中央","宝塚インター","有馬温泉","西宮北インター","川内インター","松山インター口","余戸南インター","松山市駅","大街道","松山室町営業所"],"times":{"08:50":["","","","08:50","","","","","","","13:30","13:40","13:46","14:00","","14:05"],"12:00":["","","","12:00","","","","","","","17:02","17:12","17:18","17:32","17:37","17:47"],"13:50":["","","","13:50","14:00","14:11","","14:30","14:46","","18:49","18:59","19:05","19:20","19:25","19:35"],"14:10":["14:10","14:30","14:39","16:00","","","","","","","20:40","20:50","20:56","21:10","21:15","21:25"],"17:10":["","","","17:10","","","","","","","21:50","22:00","22:05","22:15","22:20","22:30"],"21:00":["21:00","21:20","21:29","22:40","22:50","23:01","23:11","23:30","","23:41","04:55","05:10","05:15","05:25","05:30","05:40"],"23:10":["","","","23:10","23:20","23:31","23:41","00:00","","00:11","05:46","05:56","06:01","06:15","06:20","06:40"]}},"iyotetsu_kobe_official_in":{"names":["高速舞子","川内インター","松山インター口","松山市駅"],"times":{"07:20":["07:50","11:07","11:17","11:32"],"08:15":["08:45","12:02","12:12","12:27"],"10:20":["10:50","14:07","14:17","14:32"],"14:20":["14:50","18:07","18:17","18:32"],"16:20":["16:50","20:07","20:17","20:32"],"18:20":["18:50","22:07","22:17","22:32"]}},"tokushima_official_in":{"names":["三好BS（吉野川SA）","三島川之江IC","川内インター","松山インター口","大街道","松山市駅","JR松山駅"],"times":{"08:00":["09:24","09:53","10:42","10:52","11:12","11:20","11:28"],"09:40":["11:04","11:33","12:22","12:32","12:52","13:00","13:08"],"12:20":["13:44","14:13","15:02","15:12","15:32","15:40","15:48"],"15:20":["16:44","17:13","18:02","18:12","18:32","18:40","18:48"],"17:00":["18:24","18:53","19:42","19:52","20:12","20:20","20:28"],"18:40":["20:04","20:33","21:22","21:32","21:52","22:00","22:08"]}},"takamatsu_official_in":{"names":["高速観音寺","川内インター","松山インター口","松山市駅","JR松山駅"],"times":{"07:45":["08:39","09:49","09:59","10:27","10:35"],"08:45":["09:39","10:49","10:59","11:27","11:35"],"09:45":["10:39","11:49","11:59","12:27","12:35"],"11:05":["11:59","13:09","13:19","13:47","13:55"],"12:40":["","","14:42","14:57","15:05"],"13:15":["14:09","15:19","15:29","15:57","16:05"],"14:45":["15:39","16:49","16:59","17:27","17:35"],"16:05":["16:59","18:09","18:19","18:47","18:55"],"17:05":["","","19:07","19:22","19:30"],"18:20":["19:14","20:24","20:34","21:02","21:10"],"19:20":["20:14","21:24","21:34","22:02","22:10"],"20:20":["21:14","22:24","22:34","23:02","23:10"]}}};
  // Official Matsuyama Express / Keihanshin Dream inbound timetable.
  // Stops not called at by a particular service are intentionally blank.
  // Source: https://www.jr-shikokubus.co.jp/businfo/matsuyama_ex/osaka.html
  // These are scheduled stop/departure times, not live vehicle sightings.
  BUS_INBOUND_CHECKPOINTS.jr_kansai_official_in={
    names:['JR大阪駅','JRなんば駅','三宮バスターミナル','高速観音寺',
      '三島川之江インター','川内インター','松山インター口','天山橋',
      '大街道','JR松山駅'],
    times:{"06:30":["","06:45","07:35","","11:01","11:54","12:06","12:10","12:23","12:31"],"08:00":["","08:15","09:05","","12:31","13:24","13:36","13:40","13:53","14:01"],"10:10":["","10:25","11:14","","14:40","15:29","15:39","15:45","15:59","16:08"],"11:40":["","11:55","12:44","","16:10","16:59","17:09","17:15","17:29","17:38"],"13:20":["","13:35","14:24","","17:57","18:50","19:02","19:06","19:19","19:27"],"12:50":["14:20","14:35","15:24","18:15","18:40","19:29","19:39","19:45","19:59","20:08"],"15:20":["","15:35","16:24","","19:50","20:43","20:55","20:59","21:12","21:20"],"16:25":["","16:40","17:29","","21:04","21:54","22:04","22:10","22:24","22:33"],"17:55":["","18:10","18:59","","22:30","23:23","23:35","23:39","23:52","00:00"],"21:20":["22:40","22:55","23:44","","","05:05","05:15","05:19","05:32","05:40"]}
  };
  // Official inbound stop timetable extensions (IYOTETSU, checked 2026-10-11).
  // Blank times mean the bus does NOT serve the stop. Not live vehicle fixes.
  // Sources: https://www.iyotetsu.co.jp/kousoku/kochi.html
  // https://www.iyotetsu.co.jp/kousoku/okayama.html
  // https://www.iyotetsu.co.jp/kousoku/hiroshima.html
  // https://www.iyotetsu.co.jp/kousoku/nagoya.html
  // https://www.iyotetsu.co.jp/kousoku/fukuoka.html
  // https://www.iyotetsu.co.jp/kousoku/tokushima.html
  Object.assign(BUS_INBOUND_CHECKPOINTS,{
    "kochi_official_in": {
      "names": [
        "はりまや橋",
        "一宮バスターミナル",
        "三島川之江インター",
        "川内インター",
        "松山インター口",
        "松山市駅",
        "大街道",
        "JR松山駅"
      ],
      "times": {
        "07:30": [
          "07:35",
          "07:48",
          "08:37",
          "09:27",
          "09:37",
          "09:52",
          "10:04",
          "10:11"
        ],
        "11:45": [
          "11:50",
          "12:02",
          "",
          "",
          "13:46",
          "14:01",
          "14:13",
          "14:20"
        ],
        "15:30": [
          "15:35",
          "15:47",
          "",
          "",
          "17:31",
          "17:46",
          "17:58",
          "18:05"
        ],
        "19:30": [
          "19:35",
          "19:48",
          "20:37",
          "21:27",
          "21:37",
          "21:52",
          "22:04",
          "22:11"
        ]
      }
    },
    "okayama_official_in": {
      "names": [
        "津高",
        "有城南",
        "鷲羽山北",
        "川内インター",
        "松山インター口",
        "大街道",
        "松山市駅",
        "JR松山駅"
      ],
      "times": {
        "08:00": [
          "08:15",
          "08:32",
          "08:44",
          "10:51",
          "11:01",
          "11:21",
          "11:29",
          "11:37"
        ],
        "11:10": [
          "11:25",
          "11:42",
          "11:54",
          "13:51",
          "14:01",
          "14:21",
          "14:29",
          "14:37"
        ],
        "14:50": [
          "15:05",
          "15:22",
          "15:34",
          "17:31",
          "17:41",
          "18:01",
          "18:09",
          "18:17"
        ],
        "17:20": [
          "17:35",
          "17:52",
          "18:04",
          "20:01",
          "20:11",
          "20:31",
          "20:39",
          "20:47"
        ]
      }
    },
    "kirara_official_in": {
      "names": [
        "新尾道駅",
        "向東BS",
        "向島BS",
        "因島大橋",
        "因島重井BS",
        "瀬戸田BS",
        "瀬戸田PA",
        "大島BS",
        "来島海峡BS",
        "川内インター",
        "松山インター口",
        "松山市駅"
      ],
      "times": {
        "10:30": [
          "11:00",
          "11:12",
          "11:15",
          "11:19",
          "11:22",
          "11:28",
          "11:33",
          "11:47",
          "11:58",
          "12:45",
          "12:55",
          "13:10"
        ],
        "16:40": [
          "17:15",
          "17:27",
          "17:30",
          "17:34",
          "17:37",
          "17:43",
          "17:48",
          "18:02",
          "18:13",
          "19:00",
          "19:10",
          "19:25"
        ]
      }
    },
    "nagoya_official_in": {
      "names": [
        "松茂（徳島とくとくターミナル）",
        "徳島駅",
        "高松中央インターBT",
        "高松駅高速BT",
        "三島川之江インター",
        "川内インター",
        "松山インター口",
        "大街道",
        "松山市駅",
        "JR松山駅"
      ],
      "times": {
        "23:10": [
          "04:35",
          "04:50",
          "05:57",
          "06:17",
          "07:26",
          "08:18",
          "08:29",
          "08:47",
          "08:55",
          "09:03"
        ]
      }
    },
    "fukuoka_official_in": {
      "names": [
        "博多バスターミナル",
        "小倉駅前",
        "今治駅前",
        "今治桟橋",
        "川内インター",
        "松山インター口",
        "余戸南インター",
        "松山市駅"
      ],
      "times": {
        "21:10": [
          "21:30",
          "22:45",
          "05:50",
          "05:55",
          "06:55",
          "07:05",
          "07:10",
          "07:25"
        ]
      }
    },
    "tokushima_official_in": {
      "names": [
        "徳島大学前",
        "鈴江",
        "土成BS",
        "脇町BS",
        "三好BS（吉野川SA）",
        "三島川之江インター",
        "川内インター",
        "松山インター口",
        "大街道",
        "松山市駅",
        "JR松山駅"
      ],
      "times": {
        "08:00": [
          "08:03",
          "08:06",
          "08:30",
          "08:48",
          "09:24",
          "09:53",
          "10:42",
          "10:52",
          "11:12",
          "11:20",
          "11:28"
        ],
        "09:40": [
          "09:43",
          "09:46",
          "10:10",
          "10:28",
          "11:04",
          "11:33",
          "12:22",
          "12:32",
          "12:52",
          "13:00",
          "13:08"
        ],
        "12:20": [
          "12:23",
          "12:26",
          "12:50",
          "13:08",
          "13:44",
          "14:13",
          "15:02",
          "15:12",
          "15:32",
          "15:40",
          "15:48"
        ],
        "15:20": [
          "15:23",
          "15:26",
          "15:50",
          "16:08",
          "16:44",
          "17:13",
          "18:02",
          "18:12",
          "18:32",
          "18:40",
          "18:48"
        ],
        "17:00": [
          "17:03",
          "17:06",
          "17:30",
          "17:48",
          "18:24",
          "18:53",
          "19:42",
          "19:52",
          "20:12",
          "20:20",
          "20:28"
        ],
        "18:40": [
          "18:43",
          "18:46",
          "19:10",
          "19:28",
          "20:04",
          "20:33",
          "21:22",
          "21:32",
          "21:52",
          "22:00",
          "22:08"
        ]
      }
    }
  });

  // Supplement Takamatsu inbound with early city stops and exact
  // operator-specific stop skipping; earlier table covered only the highway.
  // https://www.iyotetsu.co.jp/kousoku/takamatsu.html (2026-10-01 timetable)
  BUS_INBOUND_CHECKPOINTS.takamatsu_official_in={
    "names": [
      "県庁通り",
      "ゆめタウン高松",
      "高松西インター北",
      "高速観音寺",
      "三島川之江インター",
      "川内インター",
      "松山インター口",
      "松山市駅",
      "JR松山駅"
    ],
    "times": {
      "07:45": [
        "07:49",
        "07:56",
        "08:06",
        "08:39",
        "08:53",
        "09:49",
        "09:59",
        "10:27",
        "10:35"
      ],
      "08:45": [
        "08:49",
        "08:56",
        "09:06",
        "09:39",
        "",
        "10:49",
        "10:59",
        "11:27",
        "11:35"
      ],
      "09:45": [
        "09:49",
        "09:56",
        "10:06",
        "10:39",
        "",
        "11:49",
        "11:59",
        "12:27",
        "12:35"
      ],
      "11:05": [
        "11:09",
        "11:16",
        "11:26",
        "11:59",
        "",
        "13:09",
        "13:19",
        "13:47",
        "13:55"
      ],
      "12:40": [
        "12:44",
        "12:51",
        "13:01",
        "",
        "",
        "",
        "14:42",
        "14:57",
        "15:05"
      ],
      "13:15": [
        "13:19",
        "13:26",
        "13:36",
        "14:09",
        "",
        "15:19",
        "15:29",
        "15:57",
        "16:05"
      ],
      "14:45": [
        "14:49",
        "14:56",
        "15:06",
        "15:39",
        "",
        "16:49",
        "16:59",
        "17:27",
        "17:35"
      ],
      "16:05": [
        "16:09",
        "16:16",
        "16:26",
        "16:59",
        "",
        "18:09",
        "18:19",
        "18:47",
        "18:55"
      ],
      "17:05": [
        "17:09",
        "17:16",
        "17:26",
        "",
        "",
        "",
        "19:07",
        "19:22",
        "19:30"
      ],
      "18:20": [
        "18:24",
        "18:31",
        "18:41",
        "19:14",
        "",
        "20:24",
        "20:34",
        "21:02",
        "21:10"
      ],
      "19:20": [
        "19:24",
        "19:31",
        "19:41",
        "20:14",
        "",
        "21:24",
        "21:34",
        "22:02",
        "22:10"
      ],
      "20:20": [
        "20:24",
        "20:31",
        "20:41",
        "21:14",
        "21:28",
        "22:24",
        "22:34",
        "23:02",
        "23:10"
      ]
    }
  };

  const KOBE_MUROMACHI_STARTS={"06:00":"05:40","08:10":"07:50","09:00":"08:40","10:00":"09:40","14:20":"14:00","15:20":"15:00","16:30":"16:10","17:50":"17:30"};
  const OSAKA_YAWATAHAMA_STOPS={"06:40":[["八幡浜","06:40"],["西大洲","06:55"],["大洲本町","07:05"],["内子","07:20"],["松山室町営業所","08:15"],["松山市駅","08:30"]],"10:20":[["八幡浜","10:20"],["西大洲","10:35"],["大洲本町","10:45"],["内子","11:00"],["松山室町営業所","11:55"],["松山市駅","12:10"]]};
  function timetableBusInterval(points,now,previousDay=false,originDepart='') {
    const valid=points.map(p=>({name:String(p[0]),time:padTime(p[1])}))
      .filter(x=>/^\d{2}:\d{2}$/.test(x.time));
    if(valid.length<2)return '';
    const orig=toMinutes(originDepart||valid[0].time);
    const convert=t=>{
      let v=toMinutes(t);
      if(previousDay && v>=orig)v-=1440;
      return v;
    };
    for(let i=1;i<valid.length;i++){
      const a=valid[i-1],b=valid[i];
      if(convert(a.time)<=now.minutes && now.minutes<convert(b.time)){
        return '時刻表：'+a.name+'→'+b.name+' '+b.time+'予定';
      }
    }
    return '';
  }
  function busDeparturePosition(r, now) {
    const departure=padTime(r.time||'');
    if(!/^[0-9]{2}:[0-9]{2}$/.test(departure) || r.isNextDayStart)
      return '翌日出発予定（位置未確認）';
    const remaining=toMinutes(departure)-now.minutes;
    if(remaining<0)return '発車時刻経過（位置未確認）';
    const boarding=String(r.stop||r.originName||r.originStartName||'乗車場所')
      .replace(/発$/,'').trim()||'乗車場所';

    // Five minutes before departure the bus is *expected* at the boarding
    // stop. No position data: never describe this as an observed arrival.
    if(remaining<=5) {
      return `${boarding}で待機中（仮・発車${remaining}分前）`;
    }

    // Prefer known prior stops/depot DEPARTURE schedules when present.
    // Their positions are timetable-based and not confirmed by GPS.
    const kobe=String(r.source||'')==='iyotetsu_kobe_202609' &&
      String(r.stop||'')==='松山市駅';
    const startName=kobe?'松山室町営業所':String(r.originStartName||'').trim();
    const startTime=padTime((kobe?KOBE_MUROMACHI_STARTS[departure]:r.originStartTime)||'');
    if(startName && startName!==String(r.stop||'').trim() &&
      /^[0-9]{2}:[0-9]{2}$/.test(startTime)){
      const yawata=String(r.source||'')==='iyo_city_osaka' &&
        String(startName).includes('八幡浜');
      const timeline=yawata
        ? (OSAKA_YAWATAHAMA_STOPS[startTime]||[])
        : [[startName,startTime],[String(r.stop||'松山市駅'),departure]];
      const segment=timetableBusInterval(timeline,now,false,startTime);
      if(segment)return segment;
      if(now.minutes<toMinutes(startTime)) {
        return /営業所|車庫/.test(startName)
          ? `${startName}で出発準備中（仮）`
          : `${startName} ${startTime}発予定（時刻表・位置未確認）`;
      }
    }

    // No vehicle-location feed or known depot: don't invent a specific
    // operator garage. Use provisional operational phases, not live status.
    if(remaining<=15)return `${boarding}へ向かう・乗車準備中（仮）`;
    return '営業所・車庫等で出発準備中（推定）';
  }
  function busArrivalStatus(r, now) {
    // Bus GPS is not provided. These are scheduled/provisional last-waypoint
    // estimates, NOT records of vehicles having actually passed a stop.
    // Prefer published route stop TIMES; interpolate only if none are available.
    const arrival=padTime(r.arrivalTerminalTime||r.time||'');
    if(!/^[0-9]{2}:[0-9]{2}$/.test(arrival))return '位置未確認';
    const arrivalMinutes=toMinutes(arrival);
    const announcedDeparture=padTime(r.originDepartureTime||'');
    const hasPublishedDeparture=/^[0-9]{2}:[0-9]{2}$/.test(announcedDeparture);
    // If the first departure is missing, use a *provisional* route duration.
    const routeName=String(r.origin||r.dest||'');
    const guessedDuration=busTravelMinutes(routeName);
    const departure=hasPublishedDeparture
      ? announcedDeparture : addMinutes(arrival,-guessedDuration);
    const departureClock=toMinutes(departure);
    const previousDay=String(r.originDepartureDay||'').includes('前日')
      || departureClock>arrivalMinutes;
    const departureMinutes=hasPublishedDeparture
      ? departureClock-(previousDay?1440:0)
      : arrivalMinutes-guessedDuration;

    // The two-hour window can include TOMORROW's arrivals before midnight.
    // Work on the arrival date's clock, even while viewing the previous day.
    const serviceDate=String(r._serviceIso||now.iso||'');
    const currentDate=String(now.iso||'');
    const clock=serviceDate>currentDate ? now.minutes-1440
      : serviceDate<currentDate ? now.minutes+1440 : now.minutes;
    if(clock<departureMinutes)return '出発前（時刻表）｜位置未確認';
    if(clock>arrivalMinutes)return '到着時刻経過（位置未確認）';
    if(arrivalMinutes<=departureMinutes)return '位置未確認';

    const stamp=m=>addMinutes('00:00',m);
    const makeEstimate=(where,minute)=>{
      const location=String(where||'').trim();
      return location ? `最終通過見込：${location} ${stamp(minute)}（仮）` : '';
    };
    const official=hasPublishedDeparture
      ? BUS_INBOUND_CHECKPOINTS[String(r.source||'')] : null;
    const stopTimes=official&&official.times[announcedDeparture];
    if(official&&Array.isArray(stopTimes)&&stopTimes.length===official.names.length){
      // Roadworks: do not imply the temporarily skipped Miyoshi checkpoint.
      const dow=serviceDate?new Date(serviceDate+'T12:00:00+09:00').getDay():-1;
      const stopClosureDate=(serviceDate==='2026-10-08' ||
        (serviceDate>='2026-10-13' && serviceDate<='2026-10-16') ||
        (serviceDate>='2026-10-19' && serviceDate<='2026-10-30'));
      const closed=String(r.source||'')==='tokushima_official_in' &&
        announcedDeparture==='18:40' && stopClosureDate && dow!==0 && dow!==6;
      // The origin is NOT a passed checkpoint. A bus starting from Kyoto
      // cannot report Kyoto as its last passed stop solely because it left.
      const stops=[];
      stopTimes.forEach((t,i)=>{
        const formatted=padTime(t||'');
        if(closed && /^(土成BS|脇町BS|三好BS（吉野川SA）)$/.test(String(official.names[i]||'')))return;
        if(!/^[0-9]{2}:[0-9]{2}$/.test(formatted))return;
        let minute=toMinutes(formatted);
        if(previousDay && minute>=departureClock)minute-=1440;
        // A departure time at the origin (Kyoto 14:10, for example)
        // is not evidence of a later checkpoint being passed.
        if(minute>departureMinutes && minute<=arrivalMinutes){
          stops.push([official.names[i],minute]);
        }
      });
      const passed=stops.filter(([name,minute])=>name && minute<=clock)
        .sort((a,b)=>a[1]-b[1]);
      if(passed.length){
        const latest=passed[passed.length-1];
        return makeEstimate(latest[0],latest[1]);
      }
      // Known official route, but it has not reached its first documented stop.
      // No GPS fix exists: do not invent a passed checkpoint.
      return `始発 ${String(r.origin||'出発地')} ${departure}発（時刻表）｜通過地点未確認`;
    }

    // No stop-by-stop timetable: estimate a waypoint and its time by
    // dividing the scheduled (or explicitly provisional) running time.
    const waypoints=busEstimatedRoutePoints(r);
    if(Array.isArray(waypoints)&&waypoints.length>1){
      const segments=waypoints.length-1;
      const progress=(clock-departureMinutes)/(arrivalMinutes-departureMinutes);
      const index=Math.min(segments,Math.max(0,Math.floor(progress*segments+1e-8)));
      const checkpoint=departureMinutes+
        Math.floor((arrivalMinutes-departureMinutes)*index/segments);
      // Index 0 is always a city/origin label, not a location passed later.
      if(index===0){
        return `始発 ${String(r.origin||'出発地')} ${departure}発（時刻表）｜通過地点未確認`;
      }
      // Not a recorded passage; both waypoint AND time are crude estimates.
      if(index<segments && String(waypoints[index]||'').trim())
        return `経路推定：${waypoints[index]}付近 ${stamp(checkpoint)}頃（仮）`;
    }
    return '位置未確認';
  }
  // Keep a separate scroll position for inbound/outbound bus departures.
  // The service list is redrawn after each live-data refresh.
  // Keep only the services that fit on the fixed-size workplace board.
  // No automatic or manual scrolling is needed; every page refresh moves
  // the two-hour timetable window forward and picks the next upcoming buses.
  function visibleBusSlots(available, expressCount, regionalCount) {
    // The board shows all services that physically fit, with no scrolling.
    // Each group has one 24px heading; bus rows are 62px + 2px gaps.
    const total=Number(available)>160 ? Number(available) : 480;
    const header=24, pitch=64, gapBetweenGroups=5;
    const capacity=Math.max(1,Math.floor((total-2*header-gapBetweenGroups)/pitch));
    const reserve=Math.max(1,Math.ceil(capacity*.55));
    let express=Math.min(expressCount,reserve);
    let regional=Math.min(regionalCount,Math.max(0,capacity-express));
    if(expressCount && regionalCount && regional===0) {
      regional=1; express=Math.min(expressCount,capacity-1);
    }
    let remaining=capacity-express-regional;
    const moreExpress=Math.min(remaining,Math.max(0,expressCount-express));
    express+=moreExpress; remaining-=moreExpress;
    regional+=Math.min(remaining,Math.max(0,regionalCount-regional));
    return {express,regional,regionalHeight:header+regional*pitch,capacity};
  }
  function renderBus(rows) {
    const now=japanNow();
    const root = $('bus-rows');
    root.innerHTML = '';
    const dep = currentDirection() === 'departure';
    root.classList.remove('bus-end');
    if (!rows.length) {
      root.classList.add('bus-end');
      const mode = dep ? 'DEPARTURES — 出発バス —' : 'ARRIVALS — 到着バス —';
      const msg = dep ? '今後2時間以内の出発便はありません' : '今後2時間以内の到着便はありません';
      root.innerHTML = `<div class="bus-end-state"><div class="bus-end-mode">🚌 ${mode}</div><div class="bus-end-message">${msg}</div></div>`;
    } else {
      // Ferry-shuttle buses bound for/from Toyo Port are REGIONAL buses.
      // They are bus services (not the ferry itself), on both directions.
      const isRegional=r=>r.kind==='midbus' || (r.kind==='ferrybus' && /東予港|orange_ferry_shuttle/.test(String(r.dest||'')+' '+String(r.origin||'')+' '+String(r.source||''))) || /kumakogen|misaki|uwajima_bus|setouchi_omishima|iyotetsu_niihama|orange_ferry_shuttle/.test(String(r.source||'')) || /久万高原|三崎港口|宇和島|城辺|大三島|宮浦港|新居浜|東予港/.test(String(r.origin||r.dest||''));
      const regional=rows.filter(isRegional);
      const longDistance=rows.filter(r=>!isRegional(r));
      const grouped=FREEWIFI_TV;
      const adaptiveBusLayout=grouped &&
        document.documentElement.classList.contains('company-pc');
      const availableSlots=adaptiveBusLayout
        ? (() => {
            // clientHeight includes the board's own padding, which cannot
            // hold rows. Do not count padded space as a visible service slot.
            const computed=getComputedStyle(root);
            const verticalPad=(parseFloat(computed.paddingTop)||0)+(parseFloat(computed.paddingBottom)||0);
            const usable=Math.max(0,root.clientHeight-verticalPad);
            return visibleBusSlots(usable,longDistance.length,regional.length);
          })()
        : null;
      if(availableSlots) {
        root.style.setProperty('--company-bus-regional-height',availableSlots.regionalHeight+'px');
      }else{
        root.style.removeProperty('--company-bus-regional-height');
      }
      const longRoot=grouped?document.createElement('section'):root;
      const regionalRoot=grouped?document.createElement('section'):root;
      if(grouped) {
        root.classList.add('freewifi-bus-grouped');
        longRoot.className='freewifi-bus-group freewifi-bus-long';
        regionalRoot.className='freewifi-bus-group freewifi-bus-regional';
        for(const [group,label] of [[longRoot,'長距離・高速バス'],[regionalRoot,'中距離バス']]) {
          const head=document.createElement('div');head.className='freewifi-bus-group-head';head.textContent=label;group.appendChild(head);
          root.appendChild(group);
        }
      } else root.classList.remove('freewifi-bus-grouped');
      // Display the first services by actual clock time, never one per route.
      // Overflow is omitted until later departures/arrivals fall into view.
      // Never choose records before sorting: record files are not guaranteed
      // to list the earliest departure/arrival first.
      const byTime=(a,b)=>rMinutes(a)-rMinutes(b);
      const visible=availableSlots
        ? new Set([...longDistance.slice().sort(byTime).slice(0,availableSlots.express),
                   ...regional.slice().sort(byTime).slice(0,availableSlots.regional)])
        : null;
      const selected=rows.filter(r=>!visible||visible.has(r))
        .sort((a,b)=>rMinutes(a)-rMinutes(b));
      selected.forEach(r => {
      const row = document.createElement('div'); row.className = `row${r.isFinal?' is-final':''}${dep && isDepartSoon(r, japanNow()) ? ' depart-soon' : ''}`;
      const firstBadge = r.isNextDayStart ? badgeHtml('first','翌日') : '';
      const finalBadge = r.isFinal ? badgeHtml('final','最終バス') : '';
      if (dep) {
        const rightTop = busBoardingPlaceHtml(r);
        const rightBottom = busBoardingSubline(r);
        const terminal = busTerminalArrivalLabel(r);
        const ferryExtra = r.kind === 'ferrybus' ? '<span class="route-sub">フェリー連絡</span>' : '';
        const departurePosition=busDeparturePosition(r,japanNow());
        row.innerHTML = `
          <div class="cell time bus-time-stack"><span class="primary-time">${r.time}</span>${terminal?`<span class="bus-terminal-time">${terminal}</span>`:''}</div>
          <div class="cell main bus-dest-cell"><span class="bus-dest-main">${busDestinationHtml(r,`${firstBadge}${finalBadge}`)}</span>${ferryExtra}</div>
          <div class="cell sub bus-departure-position-cell"><span class="bus-departure-position">${departurePosition||'—'}</span></div>
          <div class="cell sub bus-boarding-cell"><div class="service-wrap"><span class="name bus-place-logo">${rightTop}</span><span class="code bus-ehime-route">${rightBottom?overflowScrollHtml(rightBottom,'bus-ehime-route-scroll'):''}</span></div></div>
          <div class="cell service">${busOperatorHtml(r)}</div>`;
      } else {
        row.classList.add('bus-arrival-row');
        const depDay = r.originDepartureDay ? `${r.originDepartureDay}` : '';
        const origin = String(r.origin || r.dest || '—').trim() || '—';
        const terminal = String(r.arrivalTerminal || r.stop || '松山市駅').trim() || '松山市駅';
        const terminalTime = padTime(r.arrivalTerminalTime || r.time || '') || '—';
        const operator = busOperatorHtml(r);
        const estimatedPosition = busArrivalStatus(r,japanNow());
        row.innerHTML = `
          <div class="cell main arrival-origin">
            <span class="arrival-place">${overflowScrollHtml(origin,'bus-origin-scroll')} ${firstBadge}${finalBadge}</span>
            <span class="arrival-departure-time">${depDay}${r.originDepartureTime || '—'}出発</span>
          </div>
          <div class="cell sub bus-estimated-position-cell">
            <span class="bus-estimated-position">${estimatedPosition}</span>
          </div>
          <div class="cell sub arrival-terminal-wrap">
            <span class="arrival-terminal">${overflowScrollHtml(terminal,'bus-terminal-scroll')}</span>
          </div>
          <div class="cell service bus-arrival-operator">${operator}</div>
          <div class="cell time bus-arrival-time">${terminalTime}頃予定</div>`;
      }
      (grouped?(isRegional(r)?regionalRoot:longRoot):root).appendChild(row);
      });
      if(grouped){
        if(!longDistance.length)longRoot.querySelector('.freewifi-bus-group-head').textContent+='（該当便なし）';
        if(!regional.length)regionalRoot.querySelector('.freewifi-bus-group-head').textContent+='（該当便なし）';
      }
    }
    activatePanelOverflow(root);
  }
  function renderPort(rows) {
    const root = $('port-rows');
    // Preserve the persistent ticker when the ferry rows are redrawn.
    for(const id of ['port-note','port-limousine-note']) {
      const ticker=$(id);
      if(ticker && root.contains(ticker)) $('panel-port').appendChild(ticker);
    }
    root.innerHTML = '';
    const dep = currentDirection() === 'departure';
    // Most ferry groups use a five-hour near-term window. The "other"
    // ARRIVAL group uses the full already-computed rolling 24-hour arrival
    // timetable: a distant next arrival is not "today's service ended".
    const FIVE_HOURS_MINUTES=300;
    const now=japanNow();
    const nearPortRows=rows.filter(r=>{
      const until=rMinutes(r)-now.minutes;
      return Number.isFinite(until) && until>=0 && until<FIVE_HOURS_MINUTES;
    });

    const makePortRow=(r)=>{
      const row = document.createElement('div');
      row.className = `row${r.isFinal?' is-final':''}${dep && isDepartSoon(r, japanNow()) ? ' depart-soon' : ''}`;
      const op = portOperator(r);
      const firstBadge = '';
      const finalBadge = dep && r.isFinal ? badgeHtml('final','最終便') : '';
      const route = portRouteHtml(r, dep ? 'departure' : 'arrival');
      const ferryLogo=ferryMiniLogo(op.name);
      const operatorHtml=ferryLogo||`<span class="name">${op.name}</span>`;
      const service = `<div class="service-wrap ferry-service-wrap">${operatorHtml}<span class="code">${op.type}</span></div>`;
      if (dep) {
        const routeGuidance=ferryRouteGuidance(r,'departure',japanNow());
        const departureCalls=portDepartureCalls(r);
        const lastCall=departureCalls.length?departureCalls[departureCalls.length-1]:null;
        const scheduledArrival=padTime(r.terminalArrivalTime||r.arrivalTime||(lastCall&&lastCall[1])||'');
        const arrivalClock=/^\d{2}:\d{2}$/.test(scheduledArrival)
          ? scheduledArrival : addMinutes(r.time,portTravelMinutes(r));
        const arrivalIsEstimate=r.source==='gogoshima_official' || !/^\d{2}:\d{2}$/.test(scheduledArrival);
        const arrivalDay=toMinutes(arrivalClock)<toMinutes(r.time)?'翌日':'';
        const arrivalPort=String(lastCall?.[0]||r.dest||'目的港').trim();
        const arrivalGuide=`${arrivalPort} ${arrivalDay}${arrivalClock}${arrivalIsEstimate?'頃着（見込）':'着予定'}`;
        const departureGuidance=r.source==='matsuyama_city_cruise'
          ? `大型クルーズ船 ${r.shipName}｜${r.info||'松山市公式の出港予定'}`
          : [routeGuidance==='—'?'':routeGuidance,arrivalGuide].filter(Boolean).join(' ｜ ');
        row.innerHTML = `
          <div class="cell main port-route port-route-main">${portDepartureDestinationHtml(r,`${firstBadge}${finalBadge}`)}</div>
          <div class="cell sub port-route-guidance">${overflowScrollHtml(departureGuidance,'port-guidance-scroll')}</div>
          <div class="cell service">${service}</div>
          <div class="cell time port-departure-time">${r.time}発</div>`;
      } else {
        const arrivalRoute = isHiroshimaKureVia(r)
          ? portKureUnifiedHtml(r,'arrival',`${firstBadge}${finalBadge}`)
          : `${route} ${firstBadge}${finalBadge}`;
        const departureTime=padTime(r.originDepartureTime||r.reverseTime||'');
        const arrivalDepartureLabel=/^\d{2}:\d{2}$/.test(departureTime)
          ? `${String(r.origin||'出発港')} ${departureTime}発` : '';
        const baseGuidance=ferryRouteGuidance(r,'arrival',japanNow());
        const routeGuidance=[arrivalDepartureLabel,baseGuidance==='—'?'':baseGuidance].filter(Boolean).join(' ｜ ')||'—';
        row.innerHTML = `
          <div class="cell main port-route port-route-main"><span class="port-arrival-route-line">${arrivalRoute}</span></div>
          <div class="cell sub port-route-guidance">${overflowScrollHtml(routeGuidance,'port-guidance-scroll')}</div>
          <div class="cell service">${service}</div>
          <div class="cell time port-arrival-time">${rMinutes(r)>=1440 ? '翌日 ' : ''}${r.time}頃予定</div>`;
      }
      return row;
    };

    if (FREEWIFI_TV) {
      root.classList.add('freewifi-port-groups');
      const kyushu=(r)=>/^(uwajima_beppu|uwajima_usuki|koku94|koku94_verified_arrival)$/.test(String(r.source||'')) || /別府|臼杵|佐賀関|三崎港/.test([r.dest,r.origin,r.port,r.arrivalPort].map(v=>String(v||'')).join(' '));
      const matsuyamaPorts=(r)=>/三津浜港|松山観光港|松山港外港/.test(String(r.port||r.arrivalPort||''));
      const gogoshima=r=>r.source==='gogoshima_official' || r.source==='nakajima_takahama_call' || r.source==='nakajima_takahama_departure';
      const isOtherRoute=r=>!kyushu(r)&&!matsuyamaPorts(r)&&!gogoshima(r);
      const otherArrivalRows=rows.filter(isOtherRoute).slice(0,2);
      const groups=[
        {key:'matsuyama',title:'三津浜港・松山観光港 発着',rows:nearPortRows.filter(r=>!kyushu(r)&&matsuyamaPorts(r)).slice(0,3)},
        {key:'gogoshima',title:'高浜港・興居島・中島航路',rows:nearPortRows.filter(gogoshima).slice(0,1)},
        {key:'kyushu',title:'九州航路',rows:nearPortRows.filter(kyushu).slice(0,3)},
        {key:'other',title:'その他の航路',rows:dep
          ? nearPortRows.filter(isOtherRoute).slice(0,2)
          : otherArrivalRows}
      ];
      groups.forEach(g=>{
        const section=document.createElement('section');
        section.className=`freewifi-port-group freewifi-port-${g.key}`;
        section.style.setProperty('--freewifi-port-row-count', String(Math.max(1,g.rows.length)));
        const head=document.createElement('div');
        head.className='freewifi-port-group-head';
        head.textContent=g.title;
        section.appendChild(head);
        if(g.rows.length){
          g.rows.forEach(r=>section.appendChild(makePortRow(r)));
        } else {
          const empty=document.createElement('div');
          empty.className='row placeholder';
          const noNext= g.key==='other' && !dep;
          empty.innerHTML='<div class="cell main">'+
            (noNext?'24時間以内の到着予定なし':
              dep?'5時間以内の出航予定なし':'5時間以内の到着予定なし')+
            '</div>';
          section.appendChild(empty);
        }
        root.appendChild(section);
        if(g.key==='matsuyama') {
          const limousine=$('port-limousine-note');
          if(limousine) root.appendChild(limousine);
        }
        if(g.key==='other') {
          const note=$('port-note');
          if(note) root.appendChild(note);
        }
      });
    } else {
      root.classList.remove('freewifi-port-groups');
      if (!nearPortRows.length) {
        const row=document.createElement('div'); row.className='row placeholder';
        row.innerHTML='<div class="cell main">'+
          (dep?'5時間以内の出航予定なし':'5時間以内の到着予定なし')+
          '</div>';
        root.appendChild(row);
      } else nearPortRows.forEach(r => root.appendChild(makePortRow(r)));
    }
    activatePanelOverflow(root);
    restoreScroll('port'); attachScrollMemory('port');
  }

  function applyModes() {
    const dep = currentDirection() === 'departure';
    $('air-badge').textContent = dep ? '出発案内' : '到着案内';
    $('bus-badge').textContent = dep ? '出発案内' : '到着案内';
    $('port-badge').textContent = dep ? '出航案内' : '到着案内';
    $('rail-badge').textContent = currentRailDir() === 'south' ? '宇和島方面' : '今治方面';

    const airHead = document.querySelector('#panel-air .table-head');
    const busHead = document.querySelector('#panel-bus .table-head');
    const portHead = document.querySelector('#panel-port .table-head');
    airHead.innerHTML = FREEWIFI_TV
      ? (dep
          ? '<span>航空会社・便名</span><span>行先</span><span>出発時刻</span><span>ご案内</span>'
          : '<span>航空会社・便名</span><span>出発地</span><span>到着時刻</span><span>ご案内</span>')
      : (dep
          ? '<span>時刻</span><span>行先</span><span>航空会社</span><span>便名</span><span>区分</span>'
          : '<span>出発地</span><span>航空会社</span><span>便名</span><span>区分</span><span>到着時刻</span>');
    busHead.innerHTML = dep
      ? '<span>時刻 / 終着</span><span>行先 / 経由地</span><span>運行状況（予定）</span><span>乗車場所</span><span>運行会社</span>'
      : '<span>出発地</span><span>運行状況（予定）</span><span>到着場所</span><span>運行会社</span><span>到着時刻</span>';
    portHead.innerHTML = dep
      ? '<span>時刻 / 到着</span><span>出発港 → 行先 / 寄港</span><span>運航会社 / 船種</span>'
      : '<span>出発港 → 到着港</span><span>運航会社 / 船種</span><span>到着時刻</span>';

    [['panel-air', dep], ['panel-bus', dep], ['panel-port', dep]].forEach(([id, isDep]) => {
      const el = $(id);
      el.classList.toggle('dep-mode', isDep);
      el.classList.toggle('arr-mode', !isDep);
      el.classList.toggle('arrival-columns', !isDep);
    });
    const railEl = $('panel-rail');
    railEl.classList.toggle('south-mode', currentRailDir()==='south');
    railEl.classList.toggle('north-mode', currentRailDir()==='north');
  }

  function currentTakeoverClass(key, now) {
    if(key==='rail') return ichitsuboTakeover(now)?.className||'';
    if(key==='bus') return madonnaTakeover(now)?.className||'';
    if(key==='air') return '';
    return '';
  }
  function berthedCruiseNotices(now=japanNow()) {
    // Scheduled berth interval, not live vessel-position confirmation.
    const clock=now.iso+'T'+now.time;
    const ships=data.records.filter(r=>r.board==='port' &&
      r.source==='matsuyama_city_cruise' && r.direction==='arrival');
    return ships.flatMap(arrival=>{
      const arrivalDate=Array.isArray(arrival.dates)?arrival.dates[0]:'';
      const departure=data.records.find(r=>r.board==='port' &&
        r.source==='matsuyama_city_cruise' && r.direction==='departure' &&
        r.shipName===arrival.shipName);
      const departureDate=Array.isArray(departure?.dates)?departure.dates[0]:'';
      if(!arrivalDate || !departureDate || !departure ||
         clock<arrivalDate+'T'+arrival.time ||
         clock>=departureDate+'T'+departure.time)return [];
      const nextDay=departureDate!==now.iso?departureDate.slice(5).replace('-','/')+' ':'';
      const ship=String(arrival.shipName||'クルーズ船').replace(/[&<>"']/g,'');
      return [`<span class="cruise-berth-alert">松山外港にクルーズ船${ship}が停泊中（予定）　${nextDay}${departure.time}出航予定</span>`];
    });
  }
  function specialVesselEventNotices(now=japanNow()) {
    // Public ship-viewing events belong in the port ticker, not ferry arrivals.
    // Only show a notice on the published event day, and stop at its end time.
    const events=[
      {date:'2026-10-17',start:'11:00',end:'16:00',
       text:'海上保安庁 巡視船「いよ」一般公開｜松山港外港第2ふ頭｜11:00〜12:00／13:30〜16:00（受付15:30まで）'},
      {date:'2026-11-15',start:'09:30',end:'16:00',
       text:'海上保安庁 巡視艇「はまぎく」体験航海イベント｜マリンパーク新居浜｜9:30〜16:00（乗船条件は主催者案内を確認）'}
    ];
    return events.filter(e=>now.iso===e.date && now.minutes>=toMinutes(e.start)
        && now.minutes<toMinutes(e.end))
      .map(e=>'<span class="special-vessel-event">'+e.text+'</span>');
  }
  function ferryTickerItems(now=japanNow()) {
    const rows=slowLive.ferry?.items; const items=[];
    if(Array.isArray(rows)&&rows.length){rows.forEach(x=>{const st=String(x.status||'');const cls=/欠航|休航/.test(st)?'ferry-cancel':/減便|一部/.test(st)?'ferry-reduced':'ferry-normal';items.push(`<span class="${cls}">フェリーLIVE｜${x.name}｜${st}</span>`);});}
    items.unshift(...specialVesselEventNotices(now));
    items.unshift(...berthedCruiseNotices(now));
    if(!items.length)items.push('フェリーLIVE｜公式運航情報を取得中');
    items.push(PORT_WARNING); return items;
  }
  // 伊予鉄バス：観光港連絡バス（2026-04-01公式時刻表、平日／土日祝）。
  // Daytime transfers are port -> Takahama Station -> Iyotetsu Railway.
  // Only publish paired train times shown by the official timetable.
  function portLimousineTickerItems(now=japanNow()) {
    const mins=now.minutes;
    const weekend=now.dow===0||now.dow===6;
    const paired=[
      ['07:06','07:08','07:10','07:31'],
      ['07:26','07:28','07:36','07:57'],
      ['07:49','07:51','07:59','08:20'],
      ['08:15','08:17','08:27','08:48'],
      ['08:52','08:54','08:58','09:19'],
      ['09:03','09:05','09:13','09:34']
    ];
    // Weekday-only extra connections, omitted from weekend board.
    if(!weekend)paired.push(
      ['07:13','07:15','07:24','07:45'],
      ['07:40','07:42','07:47','08:08'],
      ['08:01','08:03','08:13','08:34'],
      ['08:30','08:32','08:40','09:01']
    );
    for(let t=9*60+30;t<=20*60+30;t+=15){
      const hhmm=x=>String(Math.floor(x/60)).padStart(2,'0')+':'+String(x%60).padStart(2,'0');
      paired.push([hhmm(t),hhmm(t+2),hhmm(t+13),hhmm(t+34)]);
    }
    paired.push(['20:48','20:50','21:05','21:26'],
      ['21:18','21:20','21:35','21:56']);
    if(weekend)paired.push(['21:28','21:30','22:00','22:21']);
    const incoming=paired.filter(x=>toMinutes(x[0])>=mins)
      .sort((a,b)=>toMinutes(a[0])-toMinutes(b[0]))[0];
    // Official timetable: city-station train at :00/:15/:30/:45,
    // connecting bus from Takahama Station at :22/:37/:52/:07.
    const towardPort=[];
    for(let t=10*60;t<=20*60+30;t+=15){
      const toClock=x=>String(Math.floor(x/60)).padStart(2,'0')+':'+String(x%60).padStart(2,'0');
      towardPort.push([toClock(t),toClock(t+21),toClock(t+22),toClock(t+24)]);
    }
    const outgoing=towardPort.find(x=>toMinutes(x[0])>=mins);
    const items=[];
    if(outgoing)items.push(`🚃 伊予鉄電車⇒伊予鉄バス｜松山市駅${outgoing[0]}発 ⇒ 高浜${outgoing[1]}着 ⇒ 松山観光港${outgoing[3]}着（時刻表予定）`);
    if(incoming)items.push(`🚌 伊予鉄バス→伊予鉄電車｜松山観光港 ${incoming[0]}発 → 高浜駅前 ${incoming[1]}着 → 電車 ${incoming[2]}発 → 松山市駅 ${incoming[3]}着（時刻表予定）`);
    if(items.length)return items;
    if(mins<=22*60+22){
      return ['🚌 伊予鉄バス・松山観光港リムジン｜広島フェリー22:12着に接続｜観光港22:22発 → JR松山駅前22:42 → 愛媛新聞社前22:44 → 松山市駅22:50着（時刻表予定）'];
    }
    return ['伊予鉄バス｜観光港連絡便・リムジンの本日分は終了しました'];
  }
  function parseJstClient(s) {
    const t=String(s||'').trim(); if(!t)return NaN; return Date.parse(t.replace(/\//g,'-').replace(' ','T')+(t.includes('+')?'':'+09:00'));
  }
  function disasterTestData() {
    return {eew:{active:true,serial:'第3報',issuedAt:'2026/09/27 15:10:00',hypocenter:'豊後水道',magnitude:6.1,depth:40,local:{area:'愛媛県中予',scaleTo:'4',arrivalTime:new Date(testDisasterArrivalMs).toISOString()}},recentEarthquake:{active:true,time:'2026/09/27 15:09:40',hypocenter:'豊後水道',magnitude:6.1,depth:40,maxScale:'5弱',distanceKm:70,ehimeScale:'4',tsunami:'None'},weather:{active:[{name:'レベル4土砂災害危険警報',status:'発表'}],headlineText:'松山市 土砂災害の危険度が高まっています',reportDatetime:'2026-09-27T15:05:00+09:00'},tsunami:{active:true,issuedAt:'2026/09/27 15:10:10',areas:[{name:'愛媛県瀬戸内海沿岸',grade:'Warning',arrivalTime:'まもなく',maxHeight:'3m'}]}};
  }


  // The user-supplied Docomo Area Mail audio files are served from the site's
  // own static assets. No synthesized substitution and no audio scraping.
  const DISASTER_AUDIO_URLS=Object.freeze({
    eew:new URL('../disaster-audio/areamail-earthquake.mp3',location.href).href,
    chime:new URL('../disaster-audio/areamail-evacuation.mp3',location.href).href
  });
  let lastDisasterSoundKey='';
  let disasterAudioPlayer=null;

  // P2P Earthquake Info (code 556) is JMA's EEW warning feed. Its "local"
  // record describes an alert region in Ehime. Category 10/11/19 is a
  // public EEW warning for that region, not a generic earthquake notice.
  // P2P code 552 uses grade Warning / MajorWarning / Watch. Only the former
  // two are Area Mail tsunami alerts, and only the Seto Inland Sea coast
  // warning region concerns Matsuyama. Advisory "Watch" is deliberately mute.
  function qualifyingDisasterSound(d,test,nowMs=Date.now()) {
    if(test||!d)return null;
    const e=d.eew;
    const local=e?.local;
    const issue=local ? parseJstClient(e.issuedAt) : NaN;
    const eewAge=nowMs-issue;
    if(e?.active&&local&&['10','11','19'].includes(String(local.kindCode||'')) &&
       Number.isFinite(issue)&&eewAge>=-60000&&eewAge<=5*60*1000) {
      return {kind:'eew',key:'eew|'+(e.originTime||e.issuedAt||'')+'|'+(e.hypocenter||'')};
    }
    const t=d.tsunami;
    const coast=Array.isArray(t?.areas) ? t.areas.some(a=>
      ['Warning','MajorWarning'].includes(String(a?.grade||'')) &&
      /愛媛/.test(String(a?.name||'')) &&
      /瀬戸内海|松山/.test(String(a?.name||''))) : false;
    const issued=coast ? parseJstClient(t?.issuedAt) : NaN;
    const age=nowMs-issued;
    if(t?.active&&coast&&Number.isFinite(issued)&&age>=-60000&&age<=30*60*1000) {
      return {kind:'chime',key:'tsunami|'+String(t.issuedAt||'')};
    }
    // A JMA weather warning is NOT proof that any municipality transmitted
    // an Area Mail evacuation notice. Do not trigger the alarm from weather.
    return null;
  }

  function disasterSoundStatusButton() {
    const overlay=$('disaster-overlay');
    if(!overlay)return null;
    let btn=$('disaster-sound-enable');
    if(btn)return btn;
    btn=document.createElement('button');
    btn.id='disaster-sound-enable';
    btn.type='button';
    btn.textContent='🔊 警報音を有効にする';
    btn.style.cssText='position:absolute;right:16px;top:18px;z-index:400;cursor:pointer;border:3px solid #ffe17a;border-radius:8px;background:#971b1b;color:#fff;padding:12px 18px;font:900 18px sans-serif;box-shadow:0 0 20px #000';
    overlay.appendChild(btn);
    return btn;
  }

  async function playUrgentDisasterAlarm(kind,key) {
    if(!DISASTER_AUDIO_URLS[kind])return;
    try{
      if(disasterAudioPlayer){
        disasterAudioPlayer.pause();
        disasterAudioPlayer.currentTime=0;
      }
      const player=new Audio(DISASTER_AUDIO_URLS[kind]);
      disasterAudioPlayer=player;
      player.volume=1;
      player.preload='auto';
      await player.play();
      try{
        localStorage.setItem('matsuyama.areaMailPlayed.'+kind,key);
      }catch(e){}
      const btn=$('disaster-sound-enable');
      if(btn)btn.remove();
    }catch(err){
      // Desktop browsers may block sound until an actual click. A visible
      // emergency-screen button lets the user explicitly start exact audio.
      const btn=disasterSoundStatusButton();
      if(btn){
        btn.textContent='🔊 警報音を鳴らす（クリック）';
        btn.onclick=()=>{playUrgentDisasterAlarm(kind,key);};
      }
      console.warn('Emergency sound playback prevented:',err);
    }
  }

  function maybePlayDisasterAlarm(d,test) {
    if(test||!disasterLive.ok)return;
    // Do not trust a retained stale feed (e.g. after losing connectivity).
    const fetched=Date.parse(String(disasterLive.generatedAtJst||''));
    if(!Number.isFinite(fetched)||Math.abs(Date.now()-fetched)>120000)return;
    const alert=qualifyingDisasterSound(d,false);
    if(!alert||lastDisasterSoundKey===alert.key)return;
    lastDisasterSoundKey=alert.key;
    try{
      if(localStorage.getItem('matsuyama.areaMailPlayed.'+alert.kind)===alert.key)
        return;
    }catch(e){}
    playUrgentDisasterAlarm(alert.kind,alert.key);
  }

  // TEST mode: user clicks to hear the actual embedded alert MP3s.
  // No fake/synthesized notes and no automatic test playback.
  function installDisasterPreviewAudioControl(overlay) {
    if($('disaster-preview-audio-control'))return;
    const bar=document.createElement('div');
    bar.id='disaster-preview-audio-control';
    bar.style.cssText='position:absolute;right:12px;top:9px;z-index:350;display:flex;align-items:center;gap:7px;flex-wrap:wrap;max-width:97%;padding:8px;background:#121b22;border:2px solid #ffe075;border-radius:8px;color:#ffe075;font:900 14px sans-serif';
    const note=document.createElement('span');
    note.textContent='訓練・テスト（実際の災害ではありません）';
    const result=document.createElement('span');
    result.id='disaster-preview-sound-result';
    result.textContent='ドコモの実音2種類を内蔵';
    result.style.cssText='font:700 12px sans-serif;color:#f7e4a5';
    let playing=null;
    function stop(){
      if(playing){playing.pause();playing.currentTime=0;playing=null;}
    }
    function makeButton(label,kind) {
      const b=document.createElement('button');
      b.type='button';b.textContent=label;
      b.style.cssText='cursor:pointer;background:#ffe075;color:#211700;padding:8px 10px;border:0;border-radius:5px;font:900 13px sans-serif';
      b.onclick=async()=>{
        stop();
        if(!kind){
          result.textContent='津波注意報ではエリアメール音を鳴らしません';
          return;
        }
        const player=new Audio(DISASTER_AUDIO_URLS[kind]);
        playing=player;player.volume=1;
        try{
          await player.play();
          result.textContent=(kind==='eew'?'緊急地震速報':'津波警報・避難情報')+'の実音を再生中';
        }catch(err){
          result.textContent='再生できません。ブラウザの音声・スピーカー設定を確認してください';
          console.warn('Disaster test sound:',err);
        }
      };
      return b;
    }
    const stopButton=document.createElement('button');
    stopButton.type='button';stopButton.textContent='■ 停止';
    stopButton.style.cssText='cursor:pointer;background:#692d31;color:#fff;border:1px solid #ffa5a5;border-radius:5px;padding:8px 10px;font:900 13px sans-serif';
    stopButton.onclick=()=>{stop();result.textContent='停止しました';};
    bar.append(note,
      makeButton('🔊 地震速報', 'eew'),
      makeButton('🔊 津波警報', 'chime'),
      makeButton('🔊 避難情報', 'chime'),
      makeButton('🔇 津波注意報（無音）', null),
      stopButton,result);
    overlay.appendChild(bar);
  }

  const DISASTER_ROTATE_MS=20000;
  let disasterRotationSignature='';
  let disasterRotationStartedAt=0;

  function currentDisasterFocus(eewActive,tsunamiActive,weatherActive,recentActive) {
    const types=[];
    if(eewActive) types.push('eew');
    if(tsunamiActive) types.push('tsunami');
    if(weatherActive) types.push('weather');
    // Do not duplicate the same earthquake as a separate summary while EEW is active.
    if(recentActive && !eewActive) types.push('summary');

    const signature=types.join('|');
    if(signature!==disasterRotationSignature){
      disasterRotationSignature=signature;
      disasterRotationStartedAt=Date.now();
    }
    if(!types.length) return {type:'summary',count:0,index:0};
    const index=types.length>1
      ? Math.floor((Date.now()-disasterRotationStartedAt)/DISASTER_ROTATE_MS)%types.length
      : 0;
    return {type:types[index],count:types.length,index};
  }

  function applyDisasterFocus(overlay,focus) {
    overlay.classList.add('single-focus');
    ['summary','eew','weather','tsunami'].forEach(type=>{
      overlay.classList.toggle(`focus-${type}`,focus.type===type);
    });
    overlay.dataset.focusCount=String(focus.count);
    overlay.dataset.focusIndex=String(focus.index);
  }
  function earthquakeNoticeKey(recent) {
    if(!recent) return '';
    return [
      String(recent.time||''),
      String(recent.hypocenter||''),
      String(recent.magnitude??''),
      String(recent.maxScale??'')
    ].join('|');
  }

  function acknowledgedEarthquakeKey() {
    try { return localStorage.getItem('matsuyama.ackEarthquake') || ''; }
    catch(e) { return ''; }
  }

  function acknowledgeEarthquake(recent) {
    const key=earthquakeNoticeKey(recent);
    if(!key) return;
    try { localStorage.setItem('matsuyama.ackEarthquake',key); } catch(e) {}
    disasterRotationSignature='';
    renderDisaster(japanNow());
  }

  function renderDisaster(now) {
    const test=workplaceTestEnabled && !!testDisasterKind;
    const d=test?disasterTestData():(disasterLive.data||{});
    if(test && testDisasterKind!=='all'){
      if(testDisasterKind!=='eew')d.eew=null;
      if(testDisasterKind!=='tsunami')d.tsunami=null;
      if(testDisasterKind!=='weather')d.weather=null;
      if(testDisasterKind!=='summary')d.recentEarthquake=null;
    }
    const recent=d.recentEarthquake; const recentMs=parseJstClient(recent?.time);
    const recentKey=earthquakeNoticeKey(recent);
    const recentAcknowledged=!test && recentKey && acknowledgedEarthquakeKey()===recentKey;
    const recentActive=test ? testDisasterKind==='summary' : !!recent && !recentAcknowledged && Number.isFinite(recentMs) && Date.now()-recentMs<20*60*1000;
    const weatherActive=Array.isArray(d.weather?.active)&&d.weather.active.length>0; const eewActive=!!(d.eew?.active&&d.eew?.local); const tsunamiActive=!!d.tsunami?.active;
    const active=test||eewActive||tsunamiActive||weatherActive||recentActive; const overlay=$('disaster-overlay'); overlay.hidden=!active;
    if(test) installDisasterPreviewAudioControl(overlay);
    maybePlayDisasterAlarm(d,test);
    if(!active){
      disasterRotationSignature='';
      overlay.classList.remove('single-focus','focus-summary','focus-eew','focus-weather','focus-tsunami');
      return;
    }
    const focus=currentDisasterFocus(eewActive,tsunamiActive,weatherActive,recentActive);
    applyDisasterFocus(overlay,focus);
    overlay.classList.toggle('eew-active',focus.type==='eew');
    overlay.classList.toggle('tsunami-active',focus.type==='tsunami');
    const confirmWrap=$('quake-confirm-wrap');
    const confirmBtn=$('quake-confirm');
    if(confirmWrap) confirmWrap.hidden=focus.type!=='summary' || !recentActive;
    if(confirmBtn){
      confirmBtn.onclick=()=>{
        if(focus.type!=='summary' || !recentActive) return;
        acknowledgeEarthquake(recent);
      };
    }
    $('disaster-time').textContent=now.time;
    $('disaster-mainline').textContent=test?'【訓練】表示確認中（実際の災害情報ではありません）':eewActive?'緊急地震速報を受信しています':tsunamiActive?'津波情報が発表されています':weatherActive?'松山市に気象警報・注意報が発表されています':'近隣で地震が発生しました';
    $('quake-summary').textContent=recent?`震源 ${recent.hypocenter}　M${recent.magnitude}　深さ ${recent.depth}km　最大震度 ${recent.maxScale}${recent.ehimeScale?`　愛媛 ${recent.ehimeScale}`:''}`:'地震情報を確認中';
    const e=d.eew; $('eew-serial').textContent=e?.serial?`第${String(e.serial).replace(/[^0-9]/g,'')}報`:'—'; $('eew-scale').textContent=e?.local?.scaleTo||e?.local?.scaleFrom||'—';
    let sec=null; const arr=parseJstClient(e?.local?.arrivalTime); if(Number.isFinite(arr))sec=Math.round((arr-(test?effectiveClockMs():Date.now()))/1000); $('eew-countdown').textContent=sec==null?'—':sec>0?`あと ${sec} 秒`:'到達予想時刻';
    $('eew-detail').textContent=e?`震源地 ${e.hypocenter||'—'}　M${e.magnitude??'—'}　深さ ${e.depth??'—'}km　${e.local?.area||''}`:'現在、緊急地震速報はありません';
    const w=d.weather; $('weather-title').textContent=weatherActive?(w.headlineText||'松山市に警報・注意報発表'):'発表中の警報・注意報はありません'; $('weather-list').textContent=weatherActive?w.active.map(x=>`${x.name||x.code} ${x.status||''}`).join('　'):'—'; $('weather-issued').textContent=`${w?.reportDatetime||''}　松山地方気象台`;
    const t=d.tsunami; const areas=Array.isArray(t?.areas)?t.areas:[]; $('tsunami-grade').textContent=areas[0]?.grade||'—'; $('tsunami-main').textContent=tsunamiActive||test?'愛媛県沿岸の津波情報に注意してください':'現在、愛媛県沿岸への津波警報等はありません'; $('tsunami-detail').textContent=areas.length?areas.map(a=>`${a.name}　${a.maxHeight||''}　${a.arrivalTime||a.condition||''}`).join(' ／ '):'—';
  }

  function verifiedMonthLabel(now = japanNow()) {
    const vm = data.verifiedMonth || String(data.checked || '').slice(0,7) || '未確認';
    const formatted = vm === '未確認' ? vm : `${vm.replace('-', '年')}月`;
    if (vm === now.month) return `ダイヤ確認 ${formatted}`;
    const continuing = localStorage.getItem('matsuyama.skipMonth') === now.month;
    return `ダイヤ確認 ${formatted}${continuing ? '（継続使用）' : '（要更新）'}`;
  }
  function setupMonthlyUpdatePrompt() {
    if(workplaceTestEnabled)return; // Never modify real monthly acknowledgement in tests.
    const now = japanNow();
    $('data-status').textContent = verifiedMonthLabel(now);
    const modal = $('update-modal');
    const verified = data.verifiedMonth || String(data.checked || '').slice(0,7);
    const skipMonth = localStorage.getItem('matsuyama.skipMonth') || '';
    const snoozeUntil = localStorage.getItem('matsuyama.snoozeUntil') || '';
    const needs = verified !== now.month && skipMonth !== now.month && (!snoozeUntil || now.iso >= snoozeUntil);
    if (!needs) return;
    $('update-message').textContent = `現在のダイヤ確認は ${verified || '未確認'} です。${now.month} の航空便・空港バス・高速バス・フェリー等を確認しますか？`;
    modal.hidden = false;
    $('update-now').onclick = async () => {
      const request = `松山交通総合発着案内 FINAL の交通ダイヤを ${now.month} 版へ更新してください。航空便、空港リムジン・普通便、高速/中距離バス、フェリー、JRの変更有無を公式情報で確認し、verifiedMonthも更新してください。`;
      let copied = true;
      try { await navigator.clipboard.writeText(request); } catch(e) { copied = false; }
      $('update-help').textContent = copied
        ? '更新依頼文をコピーしました。このFINAL版ZIPと一緒にChatGPTへ渡してください。明日また確認します。'
        : `このFINAL版ZIPと一緒にChatGPTへ依頼してください：${request}`;
      const d = new Date(`${now.iso}T12:00:00+09:00`); d.setDate(d.getDate()+1);
      const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
      localStorage.setItem('matsuyama.snoozeUntil', `${y}-${m}-${day}`);
      setTimeout(()=>{ modal.hidden=true; }, 4200);
    };
    $('update-keep').onclick = () => {
      localStorage.setItem('matsuyama.skipMonth', now.month);
      localStorage.removeItem('matsuyama.snoozeUntil');
      $('data-status').textContent = verifiedMonthLabel(now);
      modal.hidden = true;
    };
    $('update-later').onclick = () => {
      const d = new Date(`${now.iso}T12:00:00+09:00`); d.setDate(d.getDate()+1);
      const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
      localStorage.setItem('matsuyama.snoozeUntil', `${y}-${m}-${day}`);
      modal.hidden = true;
    };
  }

  let cachedNotes = { rail:[''], air:[''], bus:[''], port:[''] };
  function renderAll() {
    const now = japanNow();
    $('date-label').textContent = now.date;
    $('clock-label').innerHTML = `${now.time}<span>:${now.sec}</span>`;
    renderDisaster(now);
    renderTopLiveAlert(now);

    applyModes();
    const railRows = nextRows('rail', now);
    const airRows = liveFlightRows(now) || nextRows('air', now);
    // Bus departures and arrivals are TODAY ONLY. When departures are sparse,
    // fill from later tonight (up to four rows), but NEVER include tomorrow's
    // first buses just to fill an empty screen. Day changes at local midnight.
    // Arrivals retain the rolling 2-hour window, clipped to today's 23:59.
    const BUS_LOOKAHEAD_MINUTES=120;
    const BUS_MIN_DEPARTURES=4;
    const BUS_SPARSE_EXTENSION_MINUTES=720;
    const showingBusDepartures=currentDirection()==='departure';
    const busLimit=Math.min(1439,now.minutes+BUS_LOOKAHEAD_MINUTES);
    const busFutureLimit=Math.min(1439,now.minutes+(showingBusDepartures
      ? BUS_SPARSE_EXTENSION_MINUTES : BUS_LOOKAHEAD_MINUTES));
    const futureBus=nextRows('bus',now).filter(r=>{
      const m=rMinutes(r);
      return Number.isFinite(m) && m>=now.minutes && m<=busFutureLimit;
    }).sort((a,b)=>rMinutes(a)-rMinutes(b));
    const primaryBus=futureBus.filter(r=>rMinutes(r)<=busLimit);
    const busRows=showingBusDepartures && primaryBus.length<BUS_MIN_DEPARTURES
      ? futureBus.slice(0,BUS_MIN_DEPARTURES) : primaryBus;
    const portRows = nextRows('port', now);
    renderRail(railRows); renderAir(airRows); renderBus(busRows); renderPort(portRows);
    cachedNotes = {
      rail: railTickerItems(now),
      air: airportAccessTickerItems(now),
      bus: busTickerItems(now),
      port: ferryTickerItems(now)
    };
    updateNotes();
  }

  const tickerSignature={rail:'',air:'',bus:'',port:''};
  function updatePersistentTicker(id,key,items) {
    const safeItems=items&&items.length?items:['案内を準備中です']; const now=japanNow(); const cls=currentTakeoverClass(key,now); const sig=`${cls}::${safeItems.join('||')}`;
    if(tickerSignature[key]===sig)return; tickerSignature[key]=sig; const el=$(id); el.className=`note${cls?' '+cls:''}`; el.innerHTML=tickerHtml(safeItems);
  }
  function updateNotes() {
    const now=japanNow();
    updatePersistentTicker('rail-note','rail',railTickerItems(now));
    renderAirportBottomInfo(now);
    updatePersistentTicker('bus-note','bus',busTickerItems(now));
    updatePersistentTicker('port-note','port',ferryTickerItems(now));
    updatePersistentTicker('port-limousine-note','port-limousine',portLimousineTickerItems(now));
  }

  function scale() {
    const wall = $('wall');
    const freeWifiTv = FREEWIFI_TV || new URLSearchParams(location.search).get('freewifi') === '1';
    const companyPc = document.documentElement.classList.contains('company-pc');

    // Company PC keeps the former workplace geometry:
    // leave the desktop/icon area on the left and anchor the board to the right.
    const workplaceGeometry = companyPc || !freeWifiTv;
    const iconSpace = workplaceGeometry ? (window.innerWidth >= 900 ? 300 : 12) : 0;
    const edge = workplaceGeometry ? 16 : 8;
    const usableW = Math.max(320, window.innerWidth - iconSpace - edge * 2);
    const usableH = window.innerHeight - (workplaceGeometry ? 32 : 16);
    const baseH = wall.offsetHeight || 724;
    const ratio = workplaceGeometry
      ? Math.min(0.82, usableW / 1180, usableH / baseH)
      : Math.min(usableW / 1220, usableH / baseH);
    if(companyPc) wall.style.setProperty('--company-wall-scale', String(ratio));

    if (!workplaceGeometry) {
      wall.style.left = '50%';
      wall.style.right = 'auto';
      wall.style.top = '50%';
      wall.style.transformOrigin = 'center center';
      wall.style.transform = `translate(-50%,-50%) scale(${ratio})`;
    } else {
      wall.style.left = 'auto';
      wall.style.right = `${edge}px`;
      wall.style.top = '50%';
      wall.style.transformOrigin = 'right center';
      // Chromium CSS zoom rerenders glyphs and graphics at the final size.
      // Avoid compositor scale() on Windows wallpaper: it blurs the whole board.
      // Keep the same right-hand position and the 300px icon space.
      wall.style.transform = companyPc
        ? 'translateY(-50%)'
        : `translateY(-50%) scale(${ratio})`;
    }
  }

  window.addEventListener('resize', scale);
  window.addEventListener('resize', ()=>activateOverflowScroll(document));
  scale();

  // FreeWiFi/company-PC controller: keep page and departure/arrival timing in lockstep.
  window.MATSUYAMA_TRANSPORT_UI = {
    setMode(index, durationMs) {
      ['rail','air','bus','port'].forEach(rememberScroll);
      state.modeIndex = Number(index) % 2;
      const duration = Number(durationMs) > 0 ? Number(durationMs) : MODE_SWITCH_MS;
      nextModeSwitchAt = Date.now() + duration;
      renderAll();
      updateModeCountdown();
    },
    getMode() {
      return state.modeIndex % 2;
    },
    setTestDisaster(kind){
      if(!workplaceTestEnabled)return false;
      if(!['','eew','tsunami','weather','summary','all'].includes(kind))return false;
      testDisasterKind=kind;
      if(kind==='eew'||kind==='all')testDisasterArrivalMs=effectiveClockMs()+18000;
      disasterRotationSignature='';
      renderDisaster(japanNow());
      return true;
    },
    getTestDisaster(){return workplaceTestEnabled?testDisasterKind:'';}
  };
  if(workplaceTestEnabled){
    window.addEventListener('matsuyama-test-clock-changed',()=>renderAll());
  }

  // FINAL polling: fast approach 15s / disaster 10s / slower service status 60s.
  Promise.all([loadApproach(),loadSlowLive(),loadDisasterLive()]).then(()=>renderAll());
  // Fast unofficial-train detection: visible boards refresh on every live
  // result (roughly 10s). Source/CDN latency may add further delay.
  setInterval(()=>{loadApproach().then(()=>{
    // Refresh visible JR rows on every success/failure, not just the ticker.
    const now=japanNow();
    renderRail(nextRows('rail',now));
    cachedNotes.rail=railTickerItems(now);
    cachedNotes.bus=busTickerItems(now);
    updateNotes();
  });},10000);
  setInterval(()=>{loadSlowLive().then(()=>renderAll());},60000);
  setInterval(()=>{loadDisasterLive().then(()=>renderDisaster(japanNow()));},10000);
  renderAll(); setupMonthlyUpdatePrompt();
  checkDeployment();
  setInterval(checkDeployment,DEPLOY_CHECK_MS);
  updateModeCountdown();
  // Re-evaluate the arrival board right at 22:00, rather than waiting
  // for the next slow airport fetch or normal mode rotation.
  let lastArrivalCurfewWindow=japanNow().minutes>=AIRPORT_ARRIVAL_CURFEW_MINUTES;
  let lastAirportArrivalMinute=japanNow().minutes;
  let lastRailBoardMinute=japanNow().time;
  let lastSimulatedMinute=japanNow().iso+'|'+japanNow().time;
  setInterval(()=>{const now=japanNow();
    if(workplaceTestClock.hasOverride()){
      const virtualMinute=now.iso+'|'+now.time;
      if(virtualMinute!==lastSimulatedMinute){
        lastSimulatedMinute=virtualMinute;
        renderAll();
      }
    }$('date-label').textContent=now.date;$('clock-label').innerHTML=`${now.time}<span>:${now.sec}</span>`;renderDisaster(now);renderTopLiveAlert(now);
    const curfewWindow=now.minutes>=AIRPORT_ARRIVAL_CURFEW_MINUTES;
    const arrivalMinuteChanged=now.minutes!==lastAirportArrivalMinute;
    lastAirportArrivalMinute=now.minutes;
    // The JR departure/passage board must roll over at the clock minute,
    // not wait for a possibly failing live feed request.
    if(now.time!==lastRailBoardMinute){
      lastRailBoardMinute=now.time;
      renderRail(nextRows('rail',now));
    }
    if(curfewWindow!==lastArrivalCurfewWindow || arrivalMinuteChanged){
      lastArrivalCurfewWindow=curfewWindow;
      if(currentDirection()==='arrival'){
        renderAir(liveFlightRows(now)||nextRows('air',now));
        renderAirportBottomInfo(now);
      }
    }
    cachedNotes.rail=railTickerItems(now);cachedNotes.air=airportAccessTickerItems(now);cachedNotes.bus=busTickerItems(now);updateNotes();updateModeCountdown();},1000);
  if (!FREEWIFI_TV) {
    setInterval(()=>{
      ['rail','air','bus','port'].forEach(rememberScroll);
      state.modeIndex=(state.modeIndex+1)%2;
      nextModeSwitchAt=Date.now()+MODE_SWITCH_MS;
      renderAll();
      updateModeCountdown();
    },MODE_SWITCH_MS);
  }
})();
