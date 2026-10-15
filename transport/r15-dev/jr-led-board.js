/*
 * Matsuyama JR 16-dot LED departure board — independently implemented renderer.
 * Preview only: active with ?jrled=1 on transport/freewifi/.
 * Do not reuse third-party simulator images, scripts or fonts.
 */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('jrled') !== '1') return;
  const panel = document.getElementById('panel-rail');
  const note = document.getElementById('rail-note');
  if (!panel || !note) return;

  const frame = document.createElement('div');
  frame.className = 'jr-led-reproduction';
  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', '松山駅 発車標表示');
  const canvas = document.createElement('canvas');
  canvas.className = 'jr-led-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  frame.appendChild(canvas);
  panel.insertBefore(frame, note);

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) { frame.remove(); return; }
  const W = 1120, H = 488;
  const DOT_SCALE = 2.45;
  const rgb = {
    red: '#ff4844', yellow: '#ffe72d', white: '#edf4fc',
    cyan: '#45beef', green: '#40e797', orange: '#ff8c30'
  };
  const glyphCache = new Map();
  let records = [], direction = 'south', updatedAt = 0;
  let initialFrame = true, lastWidth = 0, lastHeight = 0;
  let lastPair = -1;

  const destinationEnglish = {
    '宇和島':'Uwajima','八幡浜':'Yawatahama','伊予大洲':'Iyo-Ozu',
    '伊予市':'Iyo-shi','伊予北条':'Iyo-Hojo','内子':'Uchiko',
    '今治':'Imabari','伊予西条':'Iyo-Saijo','新居浜':'Niihama',
    '観音寺':'Kan-onji','多度津':'Tadotsu','高松':'Takamatsu',
    '岡山':'Okayama','松山':'Matsuyama','市坪':'Ichitsubo',
    '伊予長浜':'Iyo-Nagahama','卯之町':'Unomachi',
    '高知':'Kochi','徳島':'Tokushima','丸亀':'Marugame',
    '琴平':'Kotohira','児島':'Kojima'
  };

  function clean(value, max=70) {
    return String(value ?? '').replace(/<[^>]*>/g, '').replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0,max);
  }
  function latinDestination(src) {
    const name=clean(src,50).replace(/行$/, '');
    return name.split(/[・／/,]/).map(s=>destinationEnglish[s.trim()]||s.trim()).join(' / ');
  }
  function normalized(raw) {
    const source=raw || {};
    const kind=clean(source.kind||'local');
    const service=clean(source.service||source.serviceName||'',30);
    let label;
    if (kind==='limited') label = '特急' + (service ? service : '');
    else if(kind==='sightseeing'||kind==='tourist') label=service||'観光列車';
    else if(kind==='freight') label='貨物列車 '+clean(source.trainNum||'',12);
    else if(kind==='deadhead') label='回送列車 '+clean(source.trainNum||'',12);
    else if(kind==='arrival') label=service||'松山止';
    else if(kind==='extra'||kind==='test') label=service||'臨時列車';
    else label='普通'+(service && service!=='普通'?service:'');
    const rawTime=source.time||source.displayTime||source.passTime||source.arrival||source.stationTime||'';
    const time=/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(String(rawTime))?String(rawTime).padStart(5,'0'):'';
    const dest=clean(source.dest||source.destination||(kind==='arrival'?'松山':''),36);
    const platform=clean(source.platform||source.platformNo||source.track||'',2);
    const delay=Number(source.liveDelayMinutes||source.delayMinutes||source.delay||0);
    const positionConfirmed=source.railPositionConfirmed===true || source.positionConfirmed===true;
    const position=positionConfirmed?clean(source.livePosition||source.position||'',30):'';
    let info='';
    if (delay > 0) info='おくれ約'+Math.round(delay)+'分';
    else if (position) info='現在位置　'+position;
    else if (source.info) info=clean(source.info,65);
    else if (kind==='freight') info='貨物列車の通過予定をご案内しています';
    else if (kind==='deadhead') info='回送列車の情報をご案内しています';
    else info='時刻表による発車予定をご案内しています';
    let english;
    if (kind==='limited') english='Ltd. Exp. '+(service||'');
    else if (kind==='local') english='Local Train';
    else if (kind==='freight') english='Freight Train';
    else if (kind==='deadhead') english='Out of Service';
    else if (kind==='arrival') english='Terminates Here';
    else if (kind==='sightseeing') english='Sightseeing Train';
    else if (kind==='extra'||kind==='test') english='Special Train';
    else english=label;
    return {kind,label,english,time,dest,engDest:latinDestination(dest),
      platform:/^[1-9]\d?$/.test(platform)?platform:'',info,delay};
  }

  /* Text is rasterized to a 16-ish-pixel bitmap then displayed as distinct
     LED emitters. No font smoothing is used on the finished LED display. */
  function ledSprite(value, color) {
    const text=clean(value,120);
    const key=color+'::'+text;
    if(glyphCache.has(key))return glyphCache.get(key);
    const bitmap=document.createElement('canvas');
    const b=bitmap.getContext('2d',{willReadFrequently:true});
    b.font='bold 19px "MS Gothic","Osaka-Mono","Yu Gothic",monospace';
    const wide=Math.max(1,Math.min(1800,Math.ceil(b.measureText(text).width)+3));
    bitmap.width=wide; bitmap.height=25;
    b.font='bold 19px "MS Gothic","Osaka-Mono","Yu Gothic",monospace';
    b.textBaseline='alphabetic'; b.fillStyle='white'; b.fillText(text,0,20);
    const data=b.getImageData(0,0,wide,25).data;
    const sprite=document.createElement('canvas');
    sprite.width=Math.ceil(wide*DOT_SCALE); sprite.height=Math.ceil(25*DOT_SCALE);
    const out=sprite.getContext('2d');
    out.fillStyle=rgb[color]||color;
    for(let y=1;y<25;y++){
      for(let x=0;x<wide;x++){
        if(data[(y*wide+x)*4+3] < 115) continue;
        const dx=x*DOT_SCALE,dy=y*DOT_SCALE;
        out.fillRect(Math.round(dx),Math.round(dy),1.9,1.9);
      }
    }
    const result={canvas:sprite,width:sprite.width,height:sprite.height};
    if(glyphCache.size>150)glyphCache.clear();
    glyphCache.set(key,result);
    return result;
  }

  function ledText(text,color,x,y,width,elapsed=0) {
    if(!width || !text)return;
    const sprite=ledSprite(text,color);
    ctx.save(); ctx.beginPath(); ctx.rect(x,y,width,67); ctx.clip();
    const moving=sprite.width>width;
    if(!moving)ctx.drawImage(sprite,x,y);
    else{
      const gap=70,cycle=sprite.width+gap,offset=(elapsed/37)%cycle;
      ctx.drawImage(sprite,x-offset,y);
      ctx.drawImage(sprite,x-offset+cycle,y);
    }
    ctx.restore();
  }

  function drawBoardBorder(headerPlatform){
    ctx.fillStyle='#212124';ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='#4a4d50';ctx.lineWidth=4;ctx.strokeRect(2,2,W-4,H-4);
    ctx.fillStyle='#2b2d30';ctx.fillRect(12,12,W-24,142);
    ctx.fillStyle='#b6bac0';
    ctx.font='bold 80px Arial,sans-serif';ctx.fillText('←',48,115);
    ctx.fillStyle='#bbbfc3';ctx.fillRect(156,42,86,89);
    ctx.fillStyle='#17181a';ctx.font='bold 76px Arial,sans-serif';ctx.fillText(headerPlatform||'―',176,115);
    ctx.fillStyle='#bbbfc3';ctx.font='bold 49px "Yu Gothic","Meiryo",sans-serif';
    ctx.fillText('今度の発車は',316,83);
    ctx.font='bold 34px Arial,sans-serif';ctx.fillText('Next Train',316,129);
    ctx.fillStyle='#a9aaac';ctx.font='20px "Yu Gothic",sans-serif';
    ctx.fillText('のりば',1021,151);
    [166,271,376].forEach(y=>{
      ctx.fillStyle='#050505';ctx.fillRect(34,y,1052,91);
      ctx.strokeStyle='#333336';ctx.lineWidth=1;ctx.strokeRect(34.5,y+.5,1051,90);
    });
    // Real sign screws and edge highlights, not a station-photo backdrop.
    ctx.fillStyle='#66676b';[[16,18],[1104,18],[16,470],[1104,470]].forEach(([x,y])=>{
      ctx.beginPath();ctx.arc(x,y,2.5,0,Math.PI*2);ctx.fill();
    });
  }

  function typeColor(r) {
    return r.kind==='limited'?'red':r.kind==='freight'?'yellow':
      r.kind==='deadhead'?'white':r.kind==='sightseeing'?'green':
      r.kind==='extra'?'orange':'cyan';
  }
  function row(r,y,english,elapsed){
    if(!r)return;
    ledText(english?r.english:r.label,typeColor(r),44,y,454,elapsed);
    ledText(r.time||'--:--','white',526,y,208,elapsed);
    ledText((english?r.engDest:r.dest)||'—','yellow',762,y,262,elapsed);
    ledText(r.platform||'―','white',1052,y,28,0);
  }
  function render() {
    if(!panel.classList.contains('freewifi-active'))return;
    const sw=frame.clientWidth, sh=frame.clientHeight;
    if(sw<10||sh<10)return;
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const bw=Math.round(sw*dpr),bh=Math.round(sh*dpr);
    if(initialFrame||bw!==lastWidth||bh!==lastHeight){
      canvas.width=bw;canvas.height=bh;
      lastWidth=bw;lastHeight=bh;initialFrame=false;
    }
    ctx.setTransform(bw/W,0,0,bh/H,0,0);
    const t=Date.now(),elapsed=t%1000000;
    const english=(t%9200)>=6100;
    const pages=Math.max(1,Math.ceil(records.length/2));
    const page=Math.floor(t/10500)%pages;
    if(page!==lastPair)lastPair=page;
    const first=records[page*2],second=records[page*2+1];
    drawBoardBorder(first?.platform||'―');
    if(first){
      row(first,185,english,elapsed);
      const middle=english
        ? (first.delay>0?'Delay approx. '+first.delay+' min':'Service information')
        : first.info;
      ledText(middle,first.delay>0?'orange':'yellow',43,290,1033,elapsed);
      row(second,394,english,elapsed);
    }else{
      ledText('現在表示できる列車情報はありません','yellow',55,196,980,elapsed);
      ledText('JR四国　松山駅','cyan',55,290,950,elapsed);
    }
  }
  function update(items,context={}){
    records=Array.isArray(items)?items.map(normalized):[];
    direction=context.direction==='north'?'north':'south';
    updatedAt=Date.now();
    frame.setAttribute('aria-label',
      '松山駅 '+(direction==='north'?'今治方面':'宇和島方面')+
      '　'+records.slice(0,2).map(r=>[r.label,r.time,r.dest].join(' ')).join('、'));
    render();
  }
  window.MATSUYAMA_JR_LED={update,enabled:true};
  panel.classList.add('jr-led-enabled');
  document.documentElement.classList.add('jr-led-preview-active');
  window.addEventListener('resize',render);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)render();});
  setInterval(render,180);
})();