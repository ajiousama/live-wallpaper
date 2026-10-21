// Verify complete arrival chains, calendars, overnight rollover and duplicate
// sailings. Uses the production helpers, without network or a simulated DOM.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const path=require('node:path'),root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'transport/r15-dev/app.js'),'utf8');
const data=JSON.parse(fs.readFileSync(path.join(root,'transport/r15-dev/schedule.json'),'utf8'));
const context={data,Date,Set,console,direction:'arrival',currentDirection(){return this.direction;}};
context.currentDirection=()=>context.direction;
context.synthPortArrival=()=>{throw Error('Synthetic arrival must not be called');};
vm.createContext(context);
const names=['toMinutes','padTime','addMinutes','shiftIso','dayContext','validRecord','effectiveTime',
 'ferryHoliday','ferryWeekend','ferryCalendarAllows','recordsForDay','gogoshimaPortRecords','nakajimaTakahamaCalls',
 'jumboHoliday','jumboDeparturePortRows','jumboInboundPortRows','geiyoInboundPortRows','koku94InboundPortRows',
 'rMinutes','portRolling24Rows','ferryDetailTimetable'];
for(const name of names){
 const start=source.indexOf('  function '+name+'(');
 assert(start>=0,name);
 const end=source.indexOf('\n  }',start)+5;
 vm.runInContext(source.slice(start,end),context);
}
const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'transport/r15-dev/schedule.js'),'utf8'),sandbox);
assert.equal(JSON.stringify(sandbox.window.MATSUYAMA_DATA),JSON.stringify(data),'JSON/JS must remain identical');
const port=data.records.filter(r=>r.board==='port');
let checked=0;
for(const r of port.filter(r=>r.direction==='arrival')){
 const detail=context.ferryDetailTimetable(r);
 if(r.source==='matsuyama_city_cruise')continue;
 assert(detail.includes(r.time+'着予定'),JSON.stringify(r));
 if(r.calls?.length)assert.equal(r.calls.at(-1)[1],r.time,r.id);
 checked++;
}
const tob=port.find(r=>r.source==='imabari_tobishima_official_in'&&r.time==='07:18');
const text=context.ferryDetailTimetable(tob);
for(const expected of ['小大下 06:27','大下 06:34','宗方 06:44','今治 07:18'])assert(text.includes(expected),expected);
assert(!text.includes('09:18'));
const cruise=port.find(r=>r.source==='port_cruise_official_in'&&r.time==='10:47');
assert(context.ferryDetailTimetable(cruise).includes('呉 08:50'));
assert(!context.ferryDetailTimetable(cruise).includes('13:17'));
const overnight=port.find(r=>r.source==='orange_toyo'&&r.direction==='arrival');
assert(!context.ferryDetailTimetable(overnight).includes('翌日 06:00'));
const west=port.find(r=>r.source==='nakajima_west'&&r.time==='16:40');
assert(context.ferryDetailTimetable(west).includes('高浜 16:55'));
assert(context.ferryDetailTimetable(west).includes('西中 19:22'));
const east=port.find(r=>r.source==='nakajima_mitsuhama'&&r.time==='06:55');
assert(context.ferryDetailTimetable(east).includes('睦月 07:40'));
assert(context.ferryDetailTimetable(east).includes('野忽那 07:57'));
const unresolved=port.find(r=>r.departureTimeUnconfirmed);
assert(context.ferryDetailTimetable(unresolved).includes('19:05／19:10'));
const jet=port.find(r=>r.source==='port_highspeed'&&r.time==='07:30');
assert(context.validRecord(jet,'2026-10-31'),'Dock entry-day exception');
assert(!context.validRecord(jet,'2026-11-01'),'Dock cancellation');
assert(context.validRecord(jet,'2026-11-14'),'Normal schedule restored');
const decemberCruise=port.find(r=>r.source==='port'&&r.time==='11:00');
assert(!context.validRecord(decemberCruise,'2026-12-01'));
assert(context.validRecord(decemberCruise,'2026-12-05'));
const lateUsuki=port.find(r=>r.source==='uwajima_usuki'&&r.direction!=='arrival'&&r.time==='22:00');
assert(context.validRecord(lateUsuki,'2026-10-21'));
assert(!context.validRecord(lateUsuki,'2026-11-30'));
const oldBlue=port.filter(r=>r.source==='imabari_blue_official_in');
assert(!oldBlue.some(r=>r.originDepartureTime==='07:40'));
assert(oldBlue.some(r=>r.originDepartureTime==='10:50'&&r.time==='12:05'));
for(const iso of ['2026-10-21','2026-10-22','2026-10-24','2026-10-25','2026-11-03','2026-11-23']){
 for(const direction of ['arrival','departure']){
  context.direction=direction;
  const now={iso,minutes:0,time:'00:00'};
  const rows=context.portRolling24Rows(now),keys=new Set();
  for(const r of rows){
   // Same physical sailing cannot occupy two rows via static and dynamic data.
   const key=[r._serviceIso,r.source,r.port,r.origin||'',r.time,r.originDepartureTime||''].join('|');
   assert(!keys.has(key),'Duplicate '+key);keys.add(key);
   if(direction==='arrival'&&r.source!=='matsuyama_city_cruise')
    assert(context.ferryDetailTimetable(r).includes(r.time+'着予定'),r.id);
  }
  if(iso==='2026-10-22')assert(!rows.some(r=>/imabari_sekizen/.test(r.source)&&r._serviceIso===iso));
  if(iso==='2026-10-21'&&direction==='arrival')assert(!rows.some(r=>r.source==='orange_toyo'));
  if(iso==='2026-11-03'&&direction==='departure'){
   assert(rows.some(r=>r.source==='imabari_geiyo'&&r.time==='09:15'));
   assert(!rows.some(r=>r.source==='imabari_geiyo'&&r.time==='08:00'));
   assert(rows.some(r=>r.source==='jumbo_ferry_reference'&&r.time==='06:00'));
  }
 }
}
// Missing intermediate clocks must remain missing, not be evenly interpolated.
const missing={board:'port',direction:'arrival',service:'試験船',port:'今治港',origin:'岡村港',time:'07:18',originDepartureTime:'06:20',info:'宗方経由'};
assert(context.ferryDetailTimetable(missing).includes('途中寄港時刻は未確認'));
assert(!context.ferryDetailTimetable(missing).includes('宗方 06:49'));
console.log(`PASS: ${checked} static arrivals, 12 full-day boards, exact endpoints, no duplicates, holidays and overnight handling`);
