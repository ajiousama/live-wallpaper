(() => {
  const data = window.MATSUYAMA_DATA;
  const $ = (id) => document.getElementById(id);

  const state = {
    modeIndex: 0, // 0 departure / south, 1 arrival / north
    noteIndex: { rail: 0, air: 0, bus: 0, port: 0 }
  };

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
    return String(name||'').replace(/（.*?）/g,'').replace(/予告窓/g,'').replace(/方$/g,'').trim();
  }

  function japanNow() {
    const now = new Date();
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
  function boardDisplayIso(board, now) {
    if (board !== 'rail' && board !== 'air') return now.iso;
    const todayIso = now.iso;
    const prevIso = shiftIso(todayIso, -1);
    const firstMinute = board === 'rail'
      ? firstServiceMinuteFor('rail', todayIso, r => r.direction === currentRailDir())
      : firstServiceMinuteFor('air', todayIso, r => r.direction === currentDirection());
    if (Number.isFinite(firstMinute) && now.minutes < Math.max(0, firstMinute - 120)) return prevIso;
    return todayIso;
  }
  function recordsForDay(board, iso) {
    const ctx=dayContext(iso);
    return data.records.filter(r=>r.board===board && validRecord(r,iso)).map(r=>({...r,time:effectiveTime(r,ctx)}));
  }
  function currentDirection() { return state.modeIndex % 2 === 0 ? 'departure' : 'arrival'; }
  function currentRailDir() { return state.modeIndex % 2 === 0 ? 'south' : 'north'; }

  function parseAirService(service) {
    const m = String(service).match(/^(.+?)\s+(\d+)$/);
    if (!m) return { airline: service, number: '' };
    const airlineMap = {
      JAL: '日本航空', ANA: '全日本空輸', IBX: 'IBEXエアラインズ', IBEX: 'IBEXエアラインズ', JJP: 'ジェットスター', GK: 'ジェットスター', '7C': 'チェジュ航空', JJA: 'チェジュ航空', BR: 'エバー航空', EVA: 'エバー航空', BX: 'エアプサン', MH: 'マレーシア航空'
    };
    return { airline: airlineMap[m[1]] || m[1], number: m[2] };
  }



  function padTime(t) {
    const m=String(t||'').match(/^(\d{1,2}):(\d{2})$/); return m ? `${String(Number(m[1])).padStart(2,'0')}:${m[2]}` : String(t||'');
  }
  function liveFlightRows(now) {
    const dep=currentDirection()==='departure';
    if (boardDisplayIso('air', now) !== now.iso) return null;
    const live=dep ? slowLive.airport?.departures : slowLive.airport?.arrivals;
    if (!slowLive.airport?.ok || !Array.isArray(live)) return null;

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
    live.forEach(x=>{
      const nums=Array.isArray(x.numbers)?x.numbers.map(String):[];
      let r=staticRows.find(s=>nums.includes(String(parseAirService(s.service).number)) && padTime(s.time)===padTime(x.scheduled));
      if (!r) r=staticRows.find(s=>nums.includes(String(parseAirService(s.service).number)));
      if (!r) return;
      const eventTime=padTime(x.changed||x.scheduled);
      const diff=toMinutes(eventTime)-now.minutes;
      const status=String(x.status||'');
      // Airport live pages sometimes keep stale completion labels on future rows.
      // For departures/arrivals that are already completed, drop them quickly.
      // If a future flight is incorrectly tagged as completed, ignore that label.
      if (dep && /出発済み/.test(status)) {
        if (diff <= 1) return;
      }
      if (!dep && /到着済み|ただいま到着/.test(status)) {
        if (diff <= 1) return;
      }
      if (diff < -20) return;
      let liveStatus=status || (Number(x.deltaMinutes)===0?'定刻':'');
      if (dep && /出発済み/.test(liveStatus) && diff > 1) liveStatus='';
      if (!dep && /到着済み|ただいま到着/.test(liveStatus) && diff > 1) liveStatus='';
      const delta=Number(x.deltaMinutes);
      if (Number.isFinite(delta) && delta>0 && (!liveStatus || /定刻/.test(liveStatus))) liveStatus=`遅れ +${delta}分`;
      if (Number.isFinite(delta) && delta<0 && (!liveStatus || /定刻/.test(liveStatus))) liveStatus=dep?`変更 ${Math.abs(delta)}分前`:`早着予定 ${Math.abs(delta)}分`;
      out.push({...r,time:padTime(x.changed),liveScheduled:padTime(x.scheduled),liveChangedTime:padTime(x.changed),liveStatus,liveDelta:delta,liveRaw:x,isFinal:Number.isFinite(lastStaticMinute)&&toMinutes(effectiveTime(r,now))===lastStaticMinute,isNextDayStart:false});
    });
    out.sort((a,b)=>toMinutes(a.liveChangedTime)-toMinutes(b.liveChangedTime));
    // LIVE取得に成功して0件なら「本日終了」。誤った静的データへ戻さない。
    return out;
  }

  // Airport access times verified against the official September 2026 limousine timetable
  // and the 2026-04-01 ordinary Matsuyama Airport Line timetable.
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
  const LIMO_AIRPORT_TO_CITY = ['08:05','08:30','08:45','08:55','09:00','09:40','09:55','10:25','10:50','10:55','11:00','11:35','11:50','13:45','13:50','14:20','15:05','16:00','16:05','16:10','16:50','17:05','17:10','17:25','17:35','18:10','18:30','18:35','19:05','19:10','19:15','19:55','20:00','21:20','21:25'];

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

  function railDestLabel(record) {
    return String(record.dest || '');
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
    const finalMinute=full.length?Math.max(...full.map(r=>r.minutes)):null;
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
    return { ...record, actualOperator: record.arrivalActualOperator || '', syntheticArrival: true, direction: 'arrival', time: seq[0].time, origin: record.dest, originDepartureTime: record.time, arrivalSequence: seq, arrivalTerminal: terminal.name, arrivalTerminalTime: terminal.time, estimatedArrival: true, _arrivalNextDay:arrivalNextDay };
  }
  function synthPortArrival(record) {
    const originTime = record.reverseTime || record.time;
    const t = record.reverseArrivalTime || addMinutes(record.time, portTravelMinutes(record));
    const arrivalNextDay=toMinutes(t)<toMinutes(originTime);
    return { ...record, direction: 'arrival', time: t, origin: record.dest, originDepartureTime: originTime, arrivalPort: record.port, estimatedArrival: !record.reverseArrivalTime, _arrivalNextDay:arrivalNextDay };
  }

  function getBoardRecords(board, now) {
    const displayIso = boardDisplayIso(board, now);
    const rows = recordsForDay(board, (board === 'rail' || board === 'air') ? displayIso : now.iso);
    if (board === 'rail') {
      return rows.map(r => ({ ...r, minutes: toMinutes(r.time), displayIso }))
        .filter(r => r.direction === currentRailDir())
        .sort((a, b) => rMinutes(a) - rMinutes(b));
    }
    if (board === 'air') {
      return rows.map(r => ({ ...r, minutes: toMinutes(r.time), displayIso }))
        .filter(r => r.direction === currentDirection())
        .sort((a, b) => rMinutes(a) - rMinutes(b));
    }
    if (board === 'bus') {
      const explicitArrivals = rows.filter(r => r.direction === 'arrival').map(r => ({
        ...r,
        arrivalTerminalTime: r.arrivalTerminalTime || r.time,
        minutes: toMinutes(r.arrivalTerminalTime || r.time)
      }));
      const depSource = rows.filter(r => r.direction !== 'arrival');
      const deps = normalizeBusDepartures(depSource).map(r => ({ ...r, direction: 'departure', minutes: toMinutes(r.time) }));
      if (currentDirection() === 'departure') return deps.sort((a,b)=>rMinutes(a)-rMinutes(b));

      // 到着は「今日発の同日着」＋「前日発の翌日着」。
      // 今日の夜行便を0時台の到着便として先取り表示しない。
      const prevIso=shiftIso(now.iso,-1);
      const prevRows=recordsForDay('bus',prevIso).filter(r=>r.direction!=='arrival');
      const prevDeps=normalizeBusDepartures(prevRows).map(r=>({...r,direction:'departure',minutes:toMinutes(r.time)}));
      const sameDay=deps.filter(r=>!r.noSyntheticArrival).map(synthBusArrival).filter(r=>!r._arrivalNextDay);
      const overnight=prevDeps.filter(r=>!r.noSyntheticArrival).map(synthBusArrival).filter(r=>r._arrivalNextDay).map(r=>({...r,originDepartureDay:'前日'}));
      return [...explicitArrivals, ...sameDay, ...overnight].map(r=>({...r,minutes:toMinutes(r.arrivalTerminalTime||r.time)})).sort((a,b)=>rMinutes(a)-rMinutes(b));
    }
    if (board === 'port') {
      const deps = rows.map(r => ({ ...r, direction: 'departure', minutes: toMinutes(r.time) }));
      if (currentDirection() === 'departure') return deps.sort((a,b)=>rMinutes(a)-rMinutes(b));
      const prevIso=shiftIso(now.iso,-1);
      const prevDeps=recordsForDay('port',prevIso).map(r=>({...r,direction:'departure',minutes:toMinutes(r.time)}));
      const sameDay=deps.filter(r=>!r.noSyntheticArrival).map(synthPortArrival).filter(r=>!r._arrivalNextDay);
      const overnight=prevDeps.filter(r=>!r.noSyntheticArrival).map(synthPortArrival).filter(r=>r._arrivalNextDay).map(r=>({...r,originDepartureDay:'前日'}));
      return [...sameDay,...overnight].map(r=>({...r,minutes:toMinutes(r.time)})).sort((a,b)=>rMinutes(a)-rMinutes(b));
    }
    return [];
  }
  function rMinutes(r){return typeof r.minutes==='number'?r.minutes:toMinutes(r.time)}
  function finalGroupKey(board,r) {
    if (board==='bus') return `${r.kind||'bus'}|${String(busDisplayDestination(r)||r.dest||'').replace(/（.*?）/g,'')}`;
    if (board==='port') return `${r.port||''}|${r.dest||''}|${r.service||''}`;
    return board;
  }
  function nextRows(board, now) {
    const list = getBoardRecords(board, now);
    const finalTimes=new Map();
    const groupCounts=new Map();
    list.forEach(r=>{
      const key=finalGroupKey(board,r);
      const m=rMinutes(r);
      groupCounts.set(key,(groupCounts.get(key)||0)+1);
      if(!finalTimes.has(key)||m>finalTimes.get(key)) finalTimes.set(key,m);
    });
    const shouldMarkFinal = (key, minute) => {
      // JR/airport keep normal final-service marking. For express buses and
      // ferries, sparse routes (1-3 services/day) do not get a "final" badge.
      if ((board === 'bus' || board === 'port') && (groupCounts.get(key)||0) <= 3) return false;
      return finalTimes.get(key) === minute;
    };
    const upcoming = list.filter(r => rMinutes(r) >= now.minutes).map(r => {
      const key=finalGroupKey(board,r);
      return {
        ...r,
        isFinal: shouldMarkFinal(key,rMinutes(r)),
        isNextDayStart: false
      };
    });
    if (board !== 'port') return upcoming;

    // Ferry board is always-on. Keep up to four visible rows populated by
    // appending the next day's earliest sailings/arrivals before today is empty.
    // This also lets late-night users see overnight arrivals and the first boats
    // after midnight without an end-of-day blank period.
    if (upcoming.length >= 4) return upcoming;
    const nextIso = shiftIso(now.iso, 1);
    const nextCtx = dayContext(nextIso);
    const nextNow = { ...now, iso: nextIso, dow: nextCtx.dow, minutes: 0 };
    const nextList = getBoardRecords('port', nextNow);
    const nextFinalTimes = new Map();
    const nextGroupCounts = new Map();
    nextList.forEach(r=>{
      const key=finalGroupKey('port',r);
      const m=rMinutes(r);
      nextGroupCounts.set(key,(nextGroupCounts.get(key)||0)+1);
      if(!nextFinalTimes.has(key)||m>nextFinalTimes.get(key)) nextFinalTimes.set(key,m);
    });
    const need = Math.max(0, 4 - upcoming.length);
    const nextRows = nextList.slice(0, need).map((r,i) => {
      const key=finalGroupKey('port',r);
      return {
        ...r,
        isFinal: (nextGroupCounts.get(key)||0) > 3 && nextFinalTimes.get(key)===rMinutes(r),
        isNextDayStart: i === 0
      };
    });
    return [...upcoming, ...nextRows];
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
  function railTerminalArrivals(record) {
    const dep = padTime(record.time||'');
    const info = String(record.info||'');
    const dest = String(record.dest||'');
    const svc = String(record.service||'');
    const out = [];
    if (/宇和海/.test(svc)) {
      out.push(['宇和島', addClock(dep, 136)]);
      return out;
    }
    if (/しおかぜ|いしづち/.test(svc) && /岡山・高松/.test(dest)) {
      out.push(['高松', addClock(dep, 159)]);
      out.push(['岡山', addClock(dep, 185)]);
      return out;
    }
    const northLocal = {
      '今治': 37,
      '伊予西条': 76,
      '観音寺': 121,
      '高松': 170,
      '岡山': 210
    };
    const southLocal = {
      '伊予市': 19,
      '伊予大洲': /伊予長浜経由/.test(info) ? 102 : 83,
      '八幡浜': /伊予長浜経由/.test(info) ? 150 : 127,
      '宇和島': /伊予長浜経由/.test(info) ? 198 : 176,
      '内子': 49
    };
    const table = /^(松山|伊予北条|今治|伊予西条|観音寺|高松|岡山)$/.test(dest) ? northLocal : southLocal;
    const mins = table[dest];
    if (Number.isFinite(mins)) out.push([dest, addClock(dep, mins)]);
    return out;
  }
  function railTerminalArrivalText(record) {
    const arrs = railTerminalArrivals(record).filter(x=>x && x[1]);
    if (!arrs.length) return '';
    return arrs.map(([name,t])=>`${name} ${t}`).join(' / ');
  }
  function railTimedStops(record) {
    const dep = padTime(record.time||'');
    const svc = String(record.service||'');
    if (/宇和海/.test(svc)) {
      const defs = [['伊予市',14],['内子',43],['八幡浜',80],['卯之町',107],['宇和島',136]];
      return defs.map(([n,m])=>`${n}(${addClock(dep,m)})`);
    }
    if (/しおかぜ|いしづち/.test(svc)) {
      const defs = [['今治',37],['壬生川',58],['伊予西条',79],['新居浜',98],['丸亀',132],['高松',159],['岡山',185]];
      return defs.map(([n,m])=>`${n}(${addClock(dep,m)})`);
    }
    return [];
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
  function portOperator(record) {
    const svc = String(record.service || '');
    if (/芸予汽船/.test(svc)) return { name:'芸予汽船', type:'高速船' };
    if (/第二せきぜん/.test(svc)) return { name:'今治市営', type:'フェリー 第二せきぜん' };
    if (/とびしま/.test(svc)) return { name:'今治市営', type:'旅客船 とびしま' };
    if (/大三島ブルーライン/.test(svc)) return { name:'大三島ブルーライン', type:'フェリー' };
    if (/青島海運|あおしま/.test(svc)) return { name:'青島海運', type:'旅客船 あおしま' };
    if (/新居浜市営/.test(svc)) return { name:'新居浜市営', type:'渡海船' };
    if (/クルーズフェリー/.test(svc)) return { name:'瀬戸内海汽船・石崎汽船', type:'フェリー' };
    if (/^高速船$/.test(svc)) return { name:'瀬戸内海汽船・石崎汽船', type:'高速船' };
    if (/中島/.test(svc)) return { name:'中島汽船', type:/西線/.test(svc)?'フェリー 西線':'フェリー' };
    if (/防予フェリー/.test(svc)) return { name:'防予フェリー', type:'フェリー' };
    if (/国道九四フェリー/.test(svc)) return { name:'国道九四フェリー', type:'フェリー' };
    if (/宇和島運輸/.test(svc)) return { name:'宇和島運輸', type:'フェリー' };
    if (/オレンジフェリー/.test(svc)) return { name:'四国開発フェリー', type:'フェリー' };
    if (/ジャンボフェリー/.test(svc)) return { name:'ジャンボフェリー', type:'京阪神連絡・参考' };
    return { name: svc || '運航会社', type:'船便' };
  }


  const PORT_WARNING = '⚠ 乗り場注意：松山観光港・三津浜港・高浜港・今治港・長浜港・黒島港・東予港・新居浜東港・高松東港・八幡浜港・三崎港は、それぞれ乗り場が違います';
  const EHIME_PORTS = new Set(['松山観光港','三津浜港','高浜港','今治港','長浜港','黒島港','東予港','新居浜東港','八幡浜港','三崎港']);
  function ehimePortHtml(name) {
    const n = String(name || '');
    if (!EHIME_PORTS.has(n)) return n || '—';
    return `<span class="ehime-port"><span class="ehime-badge">愛媛</span>${n}</span>`;
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
    return portRouteParts(record, direction).map(x => EHIME_PORTS.has(x) ? ehimePortHtml(x) : `<span class="route-port">${x}</span>`).join('<span class="route-arrow"> → </span>');
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
    const calls=portDepartureCalls(record);
    const terminal=(calls.length ? calls[calls.length-1][0] : portDestinationName(record.dest)) || portDestinationName(record.dest);
    const via=calls.slice(0,-1).map(x=>x[0]);
    const displayTerminal=/中島/.test(String(record.service||'')) && /大浦/.test(String(record.dest||'')) ? '中島（大浦）' : terminal;
    const start=record.port || '出発港';
    const startHtml=EHIME_PORTS.has(start)?ehimePortHtml(start):`<span class="route-port">${start}</span>`;
    const terminalHtml=EHIME_PORTS.has(displayTerminal)?ehimePortHtml(displayTerminal):`<span class="route-port">${displayTerminal}</span>`;
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
    const finalBus=isFinalAuxTime('stadium',null,now,liveTime);
    const prefix=finalBus?'最終バス ':'';
    const text=departing?`まもなく${prefix}松山市駅行きのバスが発車します。`:`まもなく${prefix}松山市駅行きのバスが到着します。`;
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
    if (!items.length) items.push('WILLER EXPRESS｜松山市駅・JR松山駅には停車しません｜松山一番町をご利用ください');
    const live=approachLive.madonna;
    if (approachLive.ok&&live?.ok&&live.predictedDeparture&&isKnownStadiumScheduledTime(live.scheduledDeparture,now)) {
      const localDiff=minutesUntil(live.predictedDeparture,now.minutes);
      const diff=Number.isFinite(localDiff)?`｜約${localDiff}分後`:'';
      const finalBus=isFinalAuxTime('stadium',null,now,live.predictedDeparture||live.scheduledDeparture);
      items.push(`マドンナスタジアム｜51系統 松山市駅行｜発車予測 ${padTime(live.predictedDeparture)}${diff}${finalBus?' '+badgeHtml('final','最終バス'):''}`);
    } else {
      const stadium=nextAux('stadium',null,now);
      const finalBus=stadium&&isFinalAuxTime('stadium',null,now,stadium.time);
      items.push(stadium?`マドンナスタジアム｜51系統 松山市駅行｜次便 ${stadium.time}発${finalBus?' '+badgeHtml('final','最終バス'):''}`:'マドンナスタジアム｜運行終了');
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

  function railRowDetailItems(record) {
    const items = [];
    const stops = railStops(record).filter(Boolean);
    const timedStops = railTimedStops(record).filter(Boolean);
    const terminalArrival = railTerminalArrivalText(record);
    if (record.kind === 'limited' || record.kind === 'sightseeing') {
      if (timedStops.length) items.push(`停車駅：${timedStops.join(' → ')}`);
      else if (stops.length) items.push(`停車駅：${stops.join(' → ')}`);
      if (terminalArrival) items.push(`終点着 ${terminalArrival}`);
      const info = String(record.info || '');
      const coupled = info.match(/(いしづち\d+号)/);
      if (coupled) items.push(`${coupled[1]}を併結`);
      if (/岡山/.test(String(record.dest || ''))) items.push('岡山で山陽新幹線に乗換');
      if (/岡山・高松/.test(String(record.dest || ''))) items.push('宇多津で岡山方面・高松方面に分割');
    } else {
      items.push('各駅停車');
      const info = String(record.info || '');
      if (/伊予長浜経由/.test(info)) items.push('愛ある伊予灘線経由');
      else if (/内子経由/.test(info)) items.push('内子経由');
      if (record.dest) items.push(`終点 ${record.dest}`);
      if (terminalArrival) items.push(`終点着 ${terminalArrival}`);
    }
    if (record.isFinal) items.push('この方面の最終列車です');
    if (record.isNextDayStart) items.push('翌日始発列車');
    return items.length ? items : ['運行案内'];
  }

  function ichitsuboDirection(x) {
    return /^(松山|伊予北条)$/.test(String(x.destination||''))?'north':'south';
  }
  function ichitsuboIsFinal(x,now) {
    const dir=ichitsuboDirection(x); const rows=auxRows('ichitsubo',dir,now); const last=rows[rows.length-1];
    const scheduled=padTime(x.scheduledIchitsubo||'');
    return !!(last && scheduled && padTime(last.time)===scheduled);
  }
  function ichitsuboTakeover(now) {
    const list=Array.isArray(approachLive.ichitsubo?.approaching)?approachLive.ichitsubo.approaching:[];
    if (!list.length) return null;
    const alerts=list.map(x=>{
      const kind=String(x.kind||''); const mins=Number(x.minutesToIchitsubo); const strong=Number.isFinite(mins)&&mins<=1;
      let text=''; let mode='stop';
      const dir = ichitsuboDirection(x)==='north' ? '松山方面' : '宇和島方面';
      if (kind==='deadhead') { text=`まもなく市坪駅を${dir}へ回送列車が通過します。`; mode='pass'; }
      else if (kind==='pass') { text=`まもなく市坪駅を${dir}へ列車が通過します。`; mode='pass'; }
      else {
        const finalTrain=ichitsuboIsFinal(x,now); const prefix=finalTrain?'最終列車 ':'';
        text=(Number.isFinite(mins)&&mins<=2)
          ?`まもなく市坪駅から${dir}へ${prefix}${x.destination||''}行が発車します。`
          :`まもなく市坪駅 ${dir}に${prefix}${x.destination||''}行がまいります。`;
      }
      return {text,mode,strong};
    });
    return {items:alerts.map(a=>liveAlertSpan(a.text,a.mode==='pass'?'rail-pass-alert':'rail-stop-alert',a.strong)),className:'live-takeover stop-live fast-scroll'};
  }
  function renderTopLiveAlert(now) {
    const el=$('top-live-alert');
    if(!el)return;
    let cls='hero-alert top-live-alert';
    let html='';
    const city=ichitsuboTakeover(now);
    const bus=madonnaTakeover(now);
    // Top-center large ticker is reserved only for live approach alerts.
    // Do not keep showing generic next-train/next-bus guidance here.
    if(city){
      cls='hero-alert top-live-alert active stop-live fast-scroll';
      html=tickerHtml(city.items);
    } else if(bus){
      cls='hero-alert top-live-alert active fast-scroll';
      html=tickerHtml(bus.items);
    }
    // Keep the marquee running smoothly. Do not rebuild the top ticker when the
    // departure/arrival panels switch mode if the visible text has not changed.
    if (el.dataset.alertClass === cls && el.dataset.alertHtml === html) return;
    el.className = cls;
    el.innerHTML = html;
    el.dataset.alertClass = cls;
    el.dataset.alertHtml = html;
  }

  function railTickerItems(now) {
    const takeover=ichitsuboTakeover(now); if(takeover) return takeover.items;
    const north=auxUpcoming('ichitsubo','north',now,1)[0]||null;
    const south=auxUpcoming('ichitsubo','south',now,1)[0]||null;
    const items=[];
    if(north){const badges=`${north.isNextDayStart?badgeHtml('first'):''}${north.isFinal?badgeHtml('final','最終列車'):''}`;items.push(`JR市坪駅 松山方面　次列車 ${north.time}　普通 ${railDestLabel(north)}行 ${badges}`);} else items.push('JR市坪駅 松山方面｜運行終了');
    if(south){const badges=`${south.isNextDayStart?badgeHtml('first'):''}${south.isFinal?badgeHtml('final','最終列車'):''}`;items.push(`JR市坪駅 宇和島方面　次列車 ${south.time}　普通 ${railDestLabel(south)}行 ${badges}`);} else items.push('JR市坪駅 宇和島方面｜運行終了');
    return items;
  }


  function airportBusTakeover(now) {
    const weekend=now.dow===0||now.dow===6;
    const ordinary=weekend?ORDINARY_WEEKEND_AIRPORT_TO_CITY:ORDINARY_WEEKDAY_AIRPORT_TO_CITY;
    const alerts=[];
    LIMO_AIRPORT_TO_CITY.forEach((t,i)=>{
      const d=toMinutes(t)-now.minutes; if(d>=-1&&d<=4){
        const final=i===LIMO_AIRPORT_TO_CITY.length-1; const action=d<=2?'発車します':'まもなく乗車できます';
        alerts.push({time:t,text:final?`まもなく最終バス 道後温泉方面行きリムジンバスが${action}。`:`まもなく道後温泉方面行きリムジンバスが${action}。`,diff:d});
      }
    });
    ordinary.forEach((pair,i)=>{
      const d=toMinutes(pair[0])-now.minutes; if(d>=-1&&d<=4){
        const final=i===ordinary.length-1; const action=d<=2?'発車します':'まもなく乗車できます';
        alerts.push({time:pair[0],text:final?`まもなく最終バス 松山市駅行き普通便が${action}。`:`まもなく松山市駅行き普通便が${action}。`,diff:d});
      }
    });
    if(!alerts.length)return null; alerts.sort((a,b)=>a.diff-b.diff);
    const pick=chooseAlert(alerts,now); const strong=pick.diff<=1;
    return {items:[liveAlertSpan(pick.text,'airport-bus-alert',strong)],className:`live-takeover airbus-live${strong?' strong-live':''}${pick.text.length>23?' fast-scroll':''}`};
  }
  function airportAccessTickerItems(now) {
    const takeover=airportBusTakeover(now); if(takeover)return takeover.items;
    const weekend=now.dow===0||now.dow===6;
    const ordinary=weekend?ORDINARY_WEEKEND_AIRPORT_TO_CITY:ORDINARY_WEEKDAY_AIRPORT_TO_CITY;
    const services=[];
    LIMO_AIRPORT_TO_CITY.forEach((t,i)=>services.push({time:t,minutes:toMinutes(t),kind:'リムジン',text:`松山空港 ${t}発 → JR松山駅前・松山市駅・大街道/道後方面`,isFinal:i===LIMO_AIRPORT_TO_CITY.length-1}));
    ordinary.forEach((pair,i)=>services.push({time:pair[0],minutes:toMinutes(pair[0]),kind:'普通便',text:`松山空港 ${pair[0]}発 → 松山市駅 ${pair[1]}着`,isFinal:i===ordinary.length-1}));
    services.sort((a,b)=>a.minutes-b.minutes||a.kind.localeCompare(b.kind,'ja'));
    const upcoming=services.filter(x=>x.minutes>=now.minutes).slice(0,6);
    if(!upcoming.length)return ['松山空港発 リムジン｜運行終了','松山空港発 普通便｜運行終了'];
    return upcoming.map(x=>`${x.kind}　${x.text}${x.isFinal?' '+badgeHtml('final','最終バス'):''}`);
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
  function renderRail(rows) {
    const root = $('rail-rows'); root.innerHTML = '';
    root.classList.remove('rail-end');
    const visible = rows.slice(0, 2);
    if (!visible.length) {
      const now = japanNow();
      const last = lastRailMovement(now);
      const mode = currentRailDir() === 'north' ? 'NORTHBOUND — 今治方面 —' : 'SOUTHBOUND — 宇和島方面 —';
      const serviceLabel = last ? (last.kind === 'local' ? '普通' : (last.kind === 'sightseeing' ? `観光 ${last.service}` : `特急 ${last.service}`)) : '—';
      const detail = last ? `最終列車：${last.time}　${serviceLabel}　${last.dest}行　発車済み` : '';
      root.classList.add('rail-end');
      root.innerHTML = `<div class="rail-end-state"><div class="rail-end-mode">🚆 ${mode}</div><div class="rail-end-message">本日の列車は終了しました</div>${detail ? `<div class="rail-end-detail">${detail}</div>` : ''}</div>`;
    } else {
      visible.forEach(r => {
        const row = document.createElement('div'); row.className = `row rail-row${r.isFinal ? ' is-final' : ''}${isDepartSoon(r, japanNow()) ? ' depart-soon' : ''}`;
        const kind = r.kind === 'limited' ? 'limited' : r.kind === 'sightseeing' ? 'tourist' : 'local';
        const label = kind === 'limited' ? `特急 ${r.service}` : kind === 'tourist' ? `観光 ${r.service}` : '普通電車';
        const badges = `${r.isNextDayStart ? badgeHtml('first') : ''}${r.isFinal ? badgeHtml('final','最終列車') : ''}`;
        row.innerHTML = `
          <div class="rail-primary">
            <div class="cell rail-service ${kind}"><span class="kindtxt">${label}</span></div>
            <div class="cell time">${r.time}</div>
            <div class="cell main">${railDestLabel(r)}行 ${badges}</div>
          </div>
          <div class="rail-detail">${tickerHtml(railRowDetailItems(r))}</div>`;
        root.appendChild(row);
      });
      while (root.children.length < 2) {
        const row=document.createElement('div'); row.className='row rail-row placeholder blank';
        row.innerHTML=`<div class="rail-primary"><div class="cell"></div><div class="cell time"></div><div class="cell"></div></div><div class="rail-detail"></div>`;
        root.appendChild(row);
      }
    }
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
    const direction = currentRailDir();
    const displayIso = boardDisplayIso('rail', now);
    const displayCtx = dayContext(displayIso);
    const rows = data.records
      .filter(r => r.board === 'rail' && r.direction === direction && validRecord(r, displayIso))
      .map(r => ({ ...r, _time: effectiveTime(r, displayCtx) }))
      .sort((a,b)=>toMinutes(a._time)-toMinutes(b._time));
    if (!rows.length) return null;
    const last = rows[rows.length-1];
    return { time: last._time, dest: String(last.dest || '').trim() || '—', service: String(last.service || '').trim() || '', kind: String(last.kind || ''), displayIso };
  }

  function renderAir(rows) {
    const root=$('air-rows'); root.innerHTML=''; const dep=currentDirection()==='departure';
    root.classList.remove('air-end');
    if(!rows.length){
      const now=japanNow(); const last=lastAirMovement(now,dep);
      root.classList.add('air-end');
      const mode=dep?'DEPARTURES — 出発便 —':'ARRIVALS — 到着便 —';
      const msg=dep?'本日の出発便は終了しました':'本日の到着便は終了しました';
      const detail=last ? (dep?`最終出発便：${last.place}行　${last.time}　出発済み`:`最終到着便：${last.place}発　${last.time}　到着済み`) : '';
      root.innerHTML=`<div class="air-end-state"><div class="air-end-mode">✈ ${mode}</div><div class="air-end-message">${msg}</div>${detail?`<div class="air-end-detail">${detail}</div>`:''}</div>`;
    } else rows.forEach(r=>{
      const row=document.createElement('div');row.className=`row${r.isFinal?' is-final':''}${dep&&isDepartSoon(r,japanNow())?' depart-soon':''}`;
      const p=parseAirService(r.service); const finalBadge=r.isFinal?badgeHtml('final','最終便'):''; const place=dep?`→ ${r.dest}`:`${r.dest} →`; const firstBadge=r.isNextDayStart?badgeHtml('first',dep?'始発':'初便'):'';
      const status=String(r.liveStatus||r.info||''); const statusClass=`cell sub air-status${status.length>10?' long-status':''}${/まもなく到着|ただいま到着/.test(status)?' arriving':''}`;
      const changed=r.liveChangedTime||r.time; const scheduled=r.liveScheduled||r.time; const delta=Number(r.liveDelta);
      const deltaHtml=Number.isFinite(delta)&&delta!==0?`<span class="air-delay${delta<0?' air-early':''}">${delta>0?'+':''}${delta}分</span>`:'';
      const timeHtml=`<div class="air-time-wrap"><span class="live-time">${changed}${deltaHtml}</span>${changed!==scheduled?`<span class="scheduled-time">定刻 ${scheduled}</span>`:''}</div>`;
      if(dep){row.innerHTML=`<div class="cell time">${timeHtml}</div><div class="cell main">${place} ${firstBadge}${finalBadge}</div><div class="cell service"><div class="service-wrap"><span class="name">${p.airline}</span><span class="code">便名 ${p.number||'—'}</span></div></div><div class="${statusClass}">${status}</div>`;}
      else{row.innerHTML=`<div class="cell main">${place} ${firstBadge}${finalBadge}</div><div class="cell service"><div class="service-wrap"><span class="name">${p.airline}</span><span class="code">便名 ${p.number||'—'}</span></div></div><div class="${statusClass}">${status}</div><div class="cell time">${timeHtml}</div>`;}
      root.appendChild(row);
    }); restoreScroll('air'); attachScrollMemory('air');
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
  function busOperatorLabel(r) {
    if (r.actualOperator) return r.actualOperator;
    if (r.syntheticArrival && BUS_JOINT_OPERATORS[r.source]) return BUS_JOINT_OPERATORS[r.source];
    return r.service || '';
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
  function busOperatorHtml(r) {
    const parts=busOperatorParts(r);
    const lines=[];
    const limit=13;
    for (const part of parts) {
      const last=lines[lines.length-1];
      if (last && `${last}・${part}`.length<=limit && lines.length<=2) lines[lines.length-1]=`${last}・${part}`;
      else if (lines.length<3) lines.push(part);
      else lines[2]=`${lines[2]}・${part}`;
    }
    return `<div class="operator-wrap lines-${Math.min(lines.length,3)}">${lines.map(x=>`<span>${x}</span>`).join('')}</div>`;
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
    return `<span class="overflow-scroll ${extraClass}"><span class="overflow-scroll-track">${text||'—'}</span></span>`;
  }
  function activateOverflowScroll(root=document) {
    root.querySelectorAll('.overflow-scroll').forEach(box => {
      const track=box.querySelector('.overflow-scroll-track');
      if(!track) return;
      const over=track.scrollWidth > box.clientWidth + 2;
      box.classList.toggle('is-overflow', over);
      if(over) box.style.setProperty('--overflow-distance', `${track.scrollWidth-box.clientWidth+36}px`);
      else box.style.removeProperty('--overflow-distance');
    });
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

  function renderBus(rows) {
    const root = $('bus-rows'); root.innerHTML = '';
    const dep = currentDirection() === 'departure';
    root.classList.remove('bus-end');
    if (!rows.length) {
      const now = japanNow();
      const last = lastBusMovement(now, dep);
      root.classList.add('bus-end');
      const mode = dep ? 'DEPARTURES — 出発バス —' : 'ARRIVALS — 到着バス —';
      const msg = dep ? '本日のバスは終了しました' : '本日の到着バスは終了しました';
      const detail = last
        ? (dep
          ? `最終バス：${last.time}　${last.place}行　出発済み`
          : `最終到着バス：${last.place}発　${last.time}　${last.terminal}到着済み`)
        : '';
      root.innerHTML = `<div class="bus-end-state"><div class="bus-end-mode">🚌 ${mode}</div><div class="bus-end-message">${msg}</div>${detail?`<div class="bus-end-detail">${detail}</div>`:''}</div>`;
    } else rows.forEach(r => {
      const row = document.createElement('div'); row.className = `row${r.isFinal?' is-final':''}${dep && isDepartSoon(r, japanNow()) ? ' depart-soon' : ''}`;
      const firstBadge = r.isNextDayStart ? badgeHtml('first', dep ? '始発' : '初便') : '';
      const finalBadge = r.isFinal ? badgeHtml('final','最終バス') : '';
      if (dep) {
        const rightTop = r.stopText || r.stop || '松山市駅発';
        const rightBottom = r.viaStop || (r.kind==='midbus' ? '中距離バス' : '');
        const terminal = busTerminalArrivalLabel(r);
        const ferryExtra = r.kind === 'ferrybus' ? '<span class="route-sub">フェリー連絡</span>' : '';
        row.innerHTML = `
          <div class="cell main bus-dest-cell"><span class="bus-dest-main">${busDestinationHtml(r,`${firstBadge}${finalBadge}`)}</span>${r.kind==='midbus'?'<span class="route-sub">中距離</span>':''}${ferryExtra}</div>
          <div class="cell sub"><div class="service-wrap"><span class="name bus-place-scroll">${overflowScrollHtml(rightTop)}</span><span class="code">${rightBottom}</span></div></div>
          <div class="cell service">${busOperatorHtml(r)}</div>
          <div class="cell time bus-time-stack"><span class="primary-time">${r.time}</span>${terminal?`<span class="bus-terminal-time">${terminal}</span>`:''}</div>`;
      } else {
        const depDay = r.originDepartureDay ? `${r.originDepartureDay}` : '';
        row.innerHTML = `
          <div class="cell main arrival-origin"><span class="arrival-place">${overflowScrollHtml(r.origin,'bus-origin-scroll')} ${firstBadge}${finalBadge}</span><span class="arrival-departure-time">${depDay}${r.originDepartureTime || '—'}出発</span></div>
          <div class="cell sub arrival-terminal-wrap"><span class="arrival-terminal">${r.arrivalTerminal}</span><span class="arrival-continuation">${busArrivalContinuationLabel(r)}</span></div>
          <div class="cell service">${busOperatorHtml(r)}</div>
          <div class="cell time">${r.arrivalTerminalTime}頃予定</div>`;
      }
      root.appendChild(row);
    });
    activateOverflowScroll(root);
    restoreScroll('bus'); attachScrollMemory('bus');
  }
  function renderPort(rows) {
    const root = $('port-rows'); root.innerHTML = '';
    const dep = currentDirection() === 'departure';
    if (!rows.length) {
      const row=document.createElement('div'); row.className='row placeholder'; row.innerHTML=emptyRow('port'); root.appendChild(row);
    } else rows.forEach(r => {
      const row = document.createElement('div');
      row.className = `row${r.isFinal?' is-final':''}${dep && isDepartSoon(r, japanNow()) ? ' depart-soon' : ''}`;
      const op = portOperator(r);
      const firstBadge = r.isNextDayStart ? badgeHtml('first', dep ? '始発' : '初便') : '';
      const finalBadge = r.isFinal ? badgeHtml('final','最終便') : '';
      const route = portRouteHtml(r, dep ? 'departure' : 'arrival');
      const service = `<div class="service-wrap"><span class="name">${op.name}</span><span class="code">${op.type}</span></div>`;
      if (dep) {
        row.innerHTML = `
          <div class="cell time port-time-stack">${portTimeStackHtml(r)}</div>
          <div class="cell main port-route">${portDepartureDestinationHtml(r,`${firstBadge}${finalBadge}`)}</div>
          <div class="cell service">${service}</div>`;
      } else {
        row.innerHTML = `
          <div class="cell main port-route">${route} ${firstBadge}${finalBadge}</div>
          <div class="cell service">${service}</div>
          <div class="cell time">${r.time}頃予定</div>`;
      }
      root.appendChild(row);
    });
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
    airHead.innerHTML = dep
      ? '<span>時刻</span><span>行先</span><span>航空会社 / 便名</span><span>区分</span>'
      : '<span>出発地</span><span>航空会社 / 便名</span><span>区分</span><span>到着時刻</span>';
    busHead.innerHTML = dep
      ? '<span>行先 / 経由地</span><span>乗車場所</span><span>運行会社</span><span>時刻 / 終着</span>'
      : '<span>出発地</span><span>到着場所</span><span>運行会社</span><span>到着時刻</span>';
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
    if(key==='air') return airportBusTakeover(now)?.className||'';
    return '';
  }
  function ferryTickerItems() {
    const rows=slowLive.ferry?.items; const items=[];
    if(Array.isArray(rows)&&rows.length){rows.forEach(x=>{const st=String(x.status||'');const cls=/欠航|休航/.test(st)?'ferry-cancel':/減便|一部/.test(st)?'ferry-reduced':'ferry-normal';items.push(`<span class="${cls}">フェリーLIVE｜${x.name}｜${st}</span>`);});}
    if(!items.length)items.push('フェリーLIVE｜公式運航情報を取得中');
    items.push(PORT_WARNING); return items;
  }
  function parseJstClient(s) {
    const t=String(s||'').trim(); if(!t)return NaN; return Date.parse(t.replace(/\//g,'-').replace(' ','T')+(t.includes('+')?'':'+09:00'));
  }
  function disasterTestData() {
    return {eew:{active:true,serial:'第3報',issuedAt:'2026/09/27 15:10:00',hypocenter:'豊後水道',magnitude:6.1,depth:40,local:{area:'愛媛県中予',scaleTo:'4',arrivalTime:new Date(Date.now()+18000).toISOString()}},recentEarthquake:{active:true,time:'2026/09/27 15:09:40',hypocenter:'豊後水道',magnitude:6.1,depth:40,maxScale:'5弱',distanceKm:70,ehimeScale:'4',tsunami:'None'},weather:{active:[{name:'レベル4土砂災害危険警報',status:'発表'}],headlineText:'松山市 土砂災害の危険度が高まっています',reportDatetime:'2026-09-27T15:05:00+09:00'},tsunami:{active:true,issuedAt:'2026/09/27 15:10:10',areas:[{name:'愛媛県瀬戸内海沿岸',grade:'Warning',arrivalTime:'まもなく',maxHeight:'3m'}]}};
  }
  function renderDisaster(now) {
    const test=new URLSearchParams(location.search).get('disasterTest')==='1'; const d=test?disasterTestData():(disasterLive.data||{});
    const recent=d.recentEarthquake; const recentMs=parseJstClient(recent?.time); const recentActive=!!recent && Number.isFinite(recentMs) && Date.now()-recentMs<20*60*1000;
    const weatherActive=Array.isArray(d.weather?.active)&&d.weather.active.length>0; const eewActive=!!(d.eew?.active&&d.eew?.local); const tsunamiActive=!!d.tsunami?.active;
    const active=test||eewActive||tsunamiActive||weatherActive||recentActive; const overlay=$('disaster-overlay'); overlay.hidden=!active; if(!active)return;
    overlay.classList.toggle('eew-active',eewActive||test); overlay.classList.toggle('tsunami-active',tsunamiActive||test);
    $('disaster-time').textContent=now.time;
    $('disaster-mainline').textContent=eewActive||test?'緊急地震速報を受信しています':tsunamiActive?'津波情報が発表されています':weatherActive?'松山市に気象警報・注意報が発表されています':'近隣で地震が発生しました';
    $('quake-summary').textContent=recent?`震源 ${recent.hypocenter}　M${recent.magnitude}　深さ ${recent.depth}km　最大震度 ${recent.maxScale}${recent.ehimeScale?`　愛媛 ${recent.ehimeScale}`:''}`:'地震情報を確認中';
    const e=d.eew; $('eew-serial').textContent=e?.serial?`第${String(e.serial).replace(/[^0-9]/g,'')}報`:'—'; $('eew-scale').textContent=e?.local?.scaleTo||e?.local?.scaleFrom||'—';
    let sec=null; const arr=parseJstClient(e?.local?.arrivalTime); if(Number.isFinite(arr))sec=Math.round((arr-Date.now())/1000); $('eew-countdown').textContent=sec==null?'—':sec>0?`あと ${sec} 秒`:'到達予想時刻';
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
    const busRows = nextRows('bus', now);
    const portRows = nextRows('port', now);
    renderRail(railRows); renderAir(airRows); renderBus(busRows); renderPort(portRows);
    cachedNotes = {
      rail: railTickerItems(now),
      air: airportAccessTickerItems(now),
      bus: busTickerItems(now),
      port: ferryTickerItems()
    };
    updateNotes();
  }

  const tickerSignature={rail:'',air:'',bus:'',port:''};
  function updatePersistentTicker(id,key,items) {
    const safeItems=items&&items.length?items:['案内を準備中です']; const now=japanNow(); const cls=currentTakeoverClass(key,now); const sig=`${cls}::${safeItems.join('||')}`;
    if(tickerSignature[key]===sig)return; tickerSignature[key]=sig; const el=$(id); el.className=`note${cls?' '+cls:''}`; el.innerHTML=tickerHtml(safeItems);
  }
  function updateNotes() {
    updatePersistentTicker('rail-note','rail',railTickerItems(japanNow()));
    updatePersistentTicker('air-note','air',airportAccessTickerItems(japanNow()));
    updatePersistentTicker('bus-note','bus',busTickerItems(japanNow()));
    updatePersistentTicker('port-note','port',ferryTickerItems());
  }

  function scale() {
    const wall = $('wall');
    const iconSpace = window.innerWidth >= 900 ? 300 : 12;
    const edge = 16;
    const usableW = Math.max(320, window.innerWidth - iconSpace - edge);
    const usableH = window.innerHeight - 32;
    const baseH = wall.offsetHeight || 724;
    const ratio = Math.min(0.88, usableW / 1180, usableH / baseH);
    wall.style.left = 'auto';
    wall.style.right = `${edge}px`;
    wall.style.top = '50%';
    wall.style.transformOrigin = 'right center';
    wall.style.transform = `translateY(-50%) scale(${ratio})`;
  }

  window.addEventListener('resize', scale);
  scale();
  // FINAL polling: fast approach 15s / disaster 10s / slower service status 60s.
  Promise.all([loadApproach(),loadSlowLive(),loadDisasterLive()]).then(()=>renderAll());
  setInterval(()=>{loadApproach().then(()=>{cachedNotes.rail=railTickerItems(japanNow());cachedNotes.bus=busTickerItems(japanNow());updateNotes();});},15000);
  setInterval(()=>{loadSlowLive().then(()=>renderAll());},60000);
  setInterval(()=>{loadDisasterLive().then(()=>renderDisaster(japanNow()));},10000);
  renderAll(); setupMonthlyUpdatePrompt();
  setInterval(()=>{const now=japanNow();$('date-label').textContent=now.date;$('clock-label').innerHTML=`${now.time}<span>:${now.sec}</span>`;renderDisaster(now);renderTopLiveAlert(now);cachedNotes.rail=railTickerItems(now);cachedNotes.air=airportAccessTickerItems(now);cachedNotes.bus=busTickerItems(now);updateNotes();},1000);
  setInterval(()=>{['rail','air','bus','port'].forEach(rememberScroll);state.modeIndex=(state.modeIndex+1)%2;renderAll();},10000);
})();