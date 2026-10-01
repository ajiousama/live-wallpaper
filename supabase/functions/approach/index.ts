const JR_POSITIONS_URL = "https://jr-shikoku-api-data-storage.haruk.in/tmp/currentPositions.json";
const JR_DIAGRAM_URL = "https://jr-shikoku-api-data-storage.haruk.in/tmp/diagram-today.json";
const IYOTETSU_MADONNA_URL =
  "https://iyotetsu.bus-navigation.jp/wgsys/wgs/bus.htm?tabName=signpoleTab&selectedLandmarkCatCd=&from=%E3%83%9E%E3%83%89%E3%83%B3%E3%83%8A%E3%82%B9%E3%82%BF%E3%82%B8%E3%82%A2%E3%83%A0&fromType=1&to=&toType=&locale=ja&fromlat=&fromlng=&tolat=&tolng=&fromSignpoleKey=9895&routeLayoutCd=&bsid=2&fromBusStopCd=&toBusStopCd=&mapFlag=false&existYn=N&routeKey=&nextDiagramFlag=&diaRevisedDate=&timeTableDirevtionCd=&searchDate=&searchTime=&fromBusStopKey=&toBusStopKey=&tramSearchFlg=";

type RoutePoint = { station: string; event: string; time: string };
type Route = {
  trainNum: string;
  points: RoutePoint[];
  cityIndex: number;
  passOnly: boolean;
  cityTime: string;
  matsuyamaIndex: number;
  matsuyamaTime: string;
  origin: string;
  destination: string;
};

const diagramCache: { at: number; map: Map<string, Route> } = {
  at: 0,
  map: new Map(),
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=0, s-maxage=10, stale-while-revalidate=20",
  };
}

function normalizeStationName(name: unknown) {
  return String(name ?? "")
    .replace(/（.*?）/g, "")
    .replace(/予告窓/g, "")
    .replace(/方$/g, "")
    .trim();
}

function toMinutes(t: unknown) {
  const m = String(t ?? "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function jstNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const h = Number(get("hour"));
  const m = Number(get("minute"));
  return {
    iso: `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`,
    minutes: h * 60 + m,
  };
}

async function fetchTimeout(url: string, asText = false, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 Matsuyama-Patapata/1.0",
        "accept-language": "ja,en;q=0.8",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return asText ? await r.text() : await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseDiagramRecord(trainNum: string, raw: unknown): Route | null {
  const points = String(raw ?? "")
    .split("#")
    .map((part) => {
      const cols = part.split(",");
      return {
        station: String(cols[0] ?? "").trim(),
        event: String(cols[1] ?? "").trim(),
        time: String(cols[2] ?? "").trim(),
      };
    })
    .filter((p) => p.station && p.station !== ".");

  if (!points.length) return null;
  const city = points.filter((p) => normalizeStationName(p.station) === "市坪");
  const passengerStop = city.some((p) => !/通/.test(p.event) && /着|発/.test(p.event));
  const cityTimePoint =
    city.find((p) => /通|着|発/.test(p.event) && /^\d{1,2}:\d{2}$/.test(p.time)) ?? city[0];

  const matsuyamaArrivalIndex = points.findIndex((p) =>
    normalizeStationName(p.station) === "松山" &&
    /着/.test(p.event) &&
    /^\d{1,2}:\d{2}$/.test(p.time)
  );
  const matsuyamaAnyIndex = points.findIndex((p) =>
    normalizeStationName(p.station) === "松山" &&
    /着|発|通/.test(p.event) &&
    /^\d{1,2}:\d{2}$/.test(p.time)
  );
  const matsuyamaIndex = matsuyamaArrivalIndex >= 0 ? matsuyamaArrivalIndex : matsuyamaAnyIndex;
  const matsuyamaTime = matsuyamaIndex >= 0 ? String(points[matsuyamaIndex]?.time ?? "") : "";
  const origin = points.find((p) => normalizeStationName(p.station));
  const terminal =
    [...points].reverse().find((p) => p.station && p.station !== "松山基地") ?? points[points.length - 1];

  return {
    trainNum: String(trainNum),
    points,
    cityIndex: points.findIndex((p) => normalizeStationName(p.station) === "市坪"),
    passOnly: !passengerStop,
    cityTime: cityTimePoint?.time ?? "",
    matsuyamaIndex,
    matsuyamaTime,
    origin: normalizeStationName(origin?.station ?? ""),
    destination: normalizeStationName(terminal?.station ?? ""),
  };
}

async function loadDiagram() {
  const now = Date.now();
  if (diagramCache.map.size && now - diagramCache.at < 30 * 60 * 1000) return diagramCache.map;

  const json = await fetchTimeout(JR_DIAGRAM_URL) as unknown[];
  const map = new Map<string, Route>();

  for (const obj of Array.isArray(json) ? json : []) {
    if (!obj || typeof obj !== "object") continue;
    for (const [num, raw] of Object.entries(obj as Record<string, unknown>)) {
      const parsed = parseDiagramRecord(num, raw);
      if (parsed) map.set(String(num), parsed);
    }
  }

  if (map.size) {
    diagramCache.map = map;
    diagramCache.at = now;
  }
  return map;
}

function stationIndexes(route: Route, station: string) {
  const out: number[] = [];
  route.points.forEach((p, i) => {
    if (normalizeStationName(p.station) === station) out.push(i);
  });
  return out;
}

function nextRouteIndex(route: Route, idx: number) {
  if (idx < 0) return -1;
  const here = normalizeStationName(route.points[idx]?.station);
  for (let i = idx + 1; i < route.points.length; i++) {
    if (normalizeStationName(route.points[i].station) !== here) return i;
  }
  return -1;
}

function isDeadhead(pos: Record<string, unknown>, route: Route) {
  const num = String(pos.TrainNum ?? route.trainNum ?? "").trim();
  return /^[0-9]{1,4}[AER]$/i.test(num);
}

function displayName(pos: Record<string, unknown>, route: Route) {
  if (isDeadhead(pos, route)) return "回送列車";
  const type = String(pos.Type ?? "").replace(/\r/g, "").trim();
  const named = type.match(/^(?:express|rapid):(.+)$/i);
  if (named?.[1]) return named[1].trim();
  return `列車 ${String(pos.TrainNum ?? route.trainNum).trim()}`;
}

function approachingIchitsubo(pos: Record<string, unknown>, route: Route, nowMinutes: number) {
  if (route.cityIndex < 0) return false;
  const clean = String(pos.Pos ?? "")
    .replace(/（.*?）/g, "")
    .replace(/予告窓/g, "")
    .trim();
  if (!clean) return false;

  const delay = Number(pos.delay ?? 0) || 0;
  let scheduledSoon = true;
  if (/^\d{1,2}:\d{2}$/.test(route.cityTime)) {
    let diff = toMinutes(route.cityTime) + delay - nowMinutes;
    if (diff < -720) diff += 1440;
    if (diff > 720) diff -= 1440;
    scheduledSoon = diff >= 0 && diff <= 5;
  }

  if (normalizeStationName(clean) === "市坪") return true;

  if (clean.includes("～")) {
    const [a0, b0] = clean.split("～");
    const a = normalizeStationName(a0);
    const b = normalizeStationName(b0);
    if (a !== "市坪" && b !== "市坪") return false;
    const aIdx = route.points.findIndex((p) => normalizeStationName(p.station) === a);
    const bIdx = route.points.findIndex((p, i) => i > aIdx && normalizeStationName(p.station) === b);
    if (aIdx >= 0 && bIdx >= 0) return b === "市坪" && bIdx === route.cityIndex;
    return scheduledSoon;
  }

  const station = normalizeStationName(clean);
  return stationIndexes(route, station).some((idx) => nextRouteIndex(route, idx) === route.cityIndex && scheduledSoon);
}

async function getIchitsubo(now: { minutes: number }) {
  const [diagram, positionsJson] = await Promise.all([
    loadDiagram(),
    fetchTimeout(JR_POSITIONS_URL),
  ]);

  const pjson = positionsJson as Record<string, unknown>;
  const positions = Array.isArray(pjson?.data)
    ? (pjson.data as Record<string, unknown>[]).filter((x) => x && x.TrainNum)
    : [];

  const approaching = positions.map((pos) => {
    const route = diagram.get(String(pos.TrainNum));
    if (!route || !approachingIchitsubo(pos, route, now.minutes)) return null;

    const delay = Number(pos.delay ?? 0) || 0;
    let diff = 999;
    if (/^\d{1,2}:\d{2}$/.test(route.cityTime)) {
      diff = toMinutes(route.cityTime) + delay - now.minutes;
      if (diff < -720) diff += 1440;
      if (diff > 720) diff -= 1440;
    }

    const deadhead = isDeadhead(pos, route);
    const passing = deadhead || route.passOnly;
    const threshold = passing ? 1 : 4;

    if (Number.isFinite(diff) && !(diff >= 0 && diff <= threshold)) return null;

    let message = "";
    if (deadhead) message = "まもなく　市坪駅を　回送列車が通過します";
    else if (route.passOnly) message = `まもなく　市坪駅を　${displayName(pos, route)}が通過します`;
    else message = `まもなく　市坪駅に　${route.destination}行がまいります`;

    return {
      alert: true,
      message,
      trainNum: String(pos.TrainNum),
      kind: deadhead ? "deadhead" : route.passOnly ? "pass" : "stop",
      destination: route.destination,
      position: String(pos.Pos ?? ""),
      delayMinutes: delay,
      minutesToIchitsubo: Number.isFinite(diff) ? diff : null,
      thresholdMinutes: threshold,
      scheduledIchitsubo: route.cityTime,
    };
  }).filter(Boolean).sort((a: any, b: any) => (a.minutesToIchitsubo ?? 999) - (b.minutesToIchitsubo ?? 999));

  const matsuyamaDeadheads = positions.map((pos) => {
    const route = diagram.get(String(pos.TrainNum));
    if (!route || !isDeadhead(pos, route) || route.matsuyamaIndex < 0) return null;
    const matsuyamaPoint = route.points[route.matsuyamaIndex];
    if (!matsuyamaPoint || !/着/.test(String(matsuyamaPoint.event || ""))) return null;
    if (!/^\d{1,2}:\d{2}$/.test(route.matsuyamaTime)) return null;

    const stations = [...new Set(route.points.map((p) => normalizeStationName(p.station)).filter(Boolean))];
    if (stations.length <= 1) return null;

    const delay = Number(pos.delay ?? 0) || 0;
    let diff = toMinutes(route.matsuyamaTime) + delay - now.minutes;
    if (diff < -720) diff += 1440;
    if (diff > 720) diff -= 1440;
    if (!Number.isFinite(diff) || diff < -2 || diff > 240) return null;

    return {
      trainNum: String(pos.TrainNum),
      kind: "deadhead",
      origin: route.origin || "",
      destination: "松山",
      position: String(pos.Pos ?? ""),
      delayMinutes: delay,
      scheduledMatsuyama: route.matsuyamaTime,
      minutesToMatsuyama: diff,
    };
  }).filter(Boolean).sort((a: any, b: any) => (a.minutesToMatsuyama ?? 999) - (b.minutesToMatsuyama ?? 999));

  return {
    ok: true,
    source: "JR四国非公式アプリ系公開データ",
    fetchedAt: pjson?.fetchedAt ?? null,
    approaching,
    matsuyamaDeadheads,
    alert: approaching.length > 0,
    message: (approaching[0] as any)?.message ?? "",
  };
}

function fullWidthToAscii(s: string) {
  return s.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xfee0));
}

function htmlToText(html: string) {
  return fullWidthToAscii(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/td>|<\/th>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  ).replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
}

function minutesFromNow(hhmm: string | null, nowMinutes: number) {
  const m = toMinutes(hhmm);
  if (!Number.isFinite(m)) return null;
  let diff = m - nowMinutes;
  if (diff < -720) diff += 1440;
  if (diff > 720) diff -= 1440;
  return diff;
}

async function getMadonna(now: { minutes: number }) {
  const html = await fetchTimeout(IYOTETSU_MADONNA_URL, true) as string;
  const text = htmlToText(html);

  // マドンナスタジアム発は伊予鉄51系統。ページ内の時刻数字を「系統」と誤認しないよう固定。
  const route = "51";
  const destination =
    ((text.match(/行き先\s*[:：]?\s*([^\n]+)/) ?? [])[1] ?? "松山市駅")
      .replace(/所要時間.*$/, "")
      .trim();

  const depBlock = text.match(
    /発\s*マドンナスタジアム[\s\S]{0,500}?予定時刻\s*(\d{1,2}:\d{2})[\s\S]{0,160}?発車予測\s*(\d{1,2}:\d{2})/
  );
  const scheduled = depBlock?.[1] ?? null;
  const predicted = depBlock?.[2] ?? scheduled;

  // If the page no longer contains a Madonna Stadium departure block,
  // do not borrow a time from another stop/route on the same page.
  if (!scheduled) {
    return {
      ok: true,
      source: "伊予鉄バスロケ",
      stop: "マドンナスタジアム",
      route,
      destination,
      scheduledDeparture: null,
      predictedDeparture: null,
      stopsAway: null,
      minutesUntilDeparture: null,
      alert: false,
      message: "",
    };
  }

  const stopMatches = [...text.matchAll(/([0-9]+)\s*個前の停留所/g)]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
  const stopsAway = stopMatches.length ? Math.min(...stopMatches) : null;

  const pageMinutes = (text.match(/約\s*([0-9]+)\s*分で発車/) ?? [])[1];
  const clockMinutes = minutesFromNow(predicted, now.minutes);
  const minutes =
    Number.isFinite(clockMinutes) ? clockMinutes :
    (pageMinutes != null ? Number(pageMinutes) : null);

  // Predicted clock time wins. Stale "約0分" / stop-count text must not
  // keep the alert alive after the bus has already departed.
  const alert =
    Number.isFinite(minutes)
      ? (minutes as number) >= -1 && (minutes as number) <= 4
      : (Number.isFinite(stopsAway) && (stopsAway as number) <= 2);

  const message = alert
    ? `まもなく　マドンナスタジアムに　${route}番 ${destination}行バスがまいります${Number.isFinite(stopsAway) ? `（${stopsAway}個前）` : ""}`
    : "";

  return {
    ok: true,
    source: "伊予鉄バスロケ",
    stop: "マドンナスタジアム",
    route,
    destination,
    scheduledDeparture: scheduled,
    predictedDeparture: predicted,
    stopsAway,
    minutesUntilDeparture: Number.isFinite(minutes) ? minutes : null,
    alert,
    message,
  };
}


const AIRPORT_LIVE_URL = "https://www.matsuyama-airport.co.jp/flight/timetable.html?arrival=1";
const ORANGE_FERRY_URL = "https://www.orange-ferry.co.jp/";
const BOYO_FERRY_URL = "https://www.boyoferry.co.jp/smp/status.html";
const KOKU94_URL = "https://www.koku94.jp/";
const IYOTETSU_HIGHWAY_URL = "https://www.iyotetsu.co.jp/topics/rinji/kousoku.html";
const JR_HIGHWAY_URL = "https://www.jr-shikokubus.co.jp/unkouinfo/";

function flatText(html: string) {
  return htmlToText(html).replace(/\s+/g, " ").trim();
}

function minuteDelta(from: string, to: string) {
  const a = toMinutes(from);
  const b = toMinutes(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let d = b - a;
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}

function parseAirportFlights(html: string) {
  const text = flatText(html);
  const updated =
    (text.match(/(\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}\s*現在)/) ?? [])[1] ?? "";
  const departures: any[] = [];
  const arrivals: any[] = [];

  const segments = text.split(/(?=定刻\s*\d{1,2}:\d{2})/);
  for (const seg of segments) {
    const head = seg.match(
      /^定刻\s*(\d{1,2}:\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*(行き先|出発地)\s*(.*?)\s*航空会社/
    );
    if (!head) continue;

    const scheduled = head[1];
    const changed = head[2] || scheduled;
    const direction = head[3] === "行き先" ? "departure" : "arrival";
    const place = String(head[4] || "").trim();
    const flightText = (seg.match(/便名\s*([0-9A-Z/]+)/i) ?? [])[1] ?? "";
    const numbers = flightText.split("/").map(x => x.trim()).filter(Boolean);
    if (!numbers.length) continue;

    const changeText = ((seg.match(/変更\s*(.*?)(?:備考|$)/) ?? [])[1] ?? "").trim();
    const status = ((seg.match(/備考\s*(.*?)(?:経路検索|$)/) ?? [])[1] ?? "").trim();
    const deltaMinutes = minuteDelta(scheduled, changed);
    const timing =
      deltaMinutes == null || deltaMinutes === 0
        ? ""
        : deltaMinutes > 0
          ? `+${deltaMinutes}分`
          : `${Math.abs(deltaMinutes)}分早`;

    const item = {
      scheduled,
      changed,
      place,
      numbers,
      status,
      changeText,
      deltaMinutes,
      timing,
    };
    (direction === "departure" ? departures : arrivals).push(item);
  }

  return { ok: departures.length > 0 || arrivals.length > 0, updatedAt: updated, departures, arrivals };
}

async function getAirportLive() {
  const html = await fetchTimeout(AIRPORT_LIVE_URL, true, 9000) as string;
  return {
    source: "松山空港公式",
    ...parseAirportFlights(html),
  };
}

function compactStatus(text: string) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (/通常運航|通常運行/.test(s)) return "通常運航";
  if (/週末減便/.test(s)) return "週末減便";
  if (/減便/.test(s)) return "減便";
  if (/全便運休/.test(s)) return "全便運休";
  if (/一部.*運休|一部の便を運休/.test(s)) return "一部便運休";
  if (/休航/.test(s)) return "休航";
  if (/欠航/.test(s)) return "欠航";
  if (/遅延/.test(s)) return "遅延";
  return s.slice(0, 32);
}

function statusAfter(text: string, marker: string) {
  const i = text.indexOf(marker);
  if (i < 0) return "";
  const s = text.slice(i + marker.length, i + marker.length + 220);
  const m = s.match(/([^。\n]{1,90}(?:。|$))/);
  return compactStatus(m?.[1] || s);
}

async function getFerryLive() {
  const [orangeR, boyoR, kokuR] = await Promise.allSettled([
    fetchTimeout(ORANGE_FERRY_URL, true, 9000),
    fetchTimeout(BOYO_FERRY_URL, true, 9000),
    fetchTimeout(KOKU94_URL, true, 9000),
  ]);

  const items: any[] = [];

  if (orangeR.status === "fulfilled") {
    const t = flatText(orangeR.value as string);
    const pairs = [
      ["東予―大阪", "東予-大阪"],
      ["八幡浜―臼杵（オレンジ）", "八幡浜-臼杵"],
      ["新居浜―神戸", "新居浜-神戸"],
    ];
    for (const [name, marker] of pairs) {
      const status = statusAfter(t, marker);
      if (status) items.push({ name, status, source: "オレンジフェリー" });
    }
  }

  if (boyoR.status === "fulfilled") {
    const t = flatText(boyoR.value as string);
    const status = compactStatus(
      ((t.match(/本日の運航状況\s*([^。]{1,90}。?)/) ?? [])[1] ?? "")
    );
    if (status) items.push({ name: "三津浜―柳井", status, source: "防予フェリー" });
  }

  if (kokuR.status === "fulfilled") {
    const t = flatText(kokuR.value as string);
    const status = compactStatus(
      ((t.match(/現在の運航状況\s*:?\s*([^。]{1,90})/) ?? [])[1] ?? "")
    );
    if (status) items.push({ name: "三崎―佐賀関", status, source: "国道九四フェリー" });
  }

  return {
    ok: items.length > 0,
    items,
    unavailable: ["松山観光港―広島・呉", "中島航路"],
  };
}

function routeSegment(text: string, marker: string) {
  const i = text.indexOf(marker);
  if (i < 0) return "";
  return text.slice(i, i + 240);
}

function iyotetsuRouteStatus(text: string, marker: string) {
  const s = routeSegment(text, marker);
  if (!s) return "";
  if (/通常運行/.test(s)) return "通常運行";
  if (/毎日運行/.test(s)) return "毎日運行";
  if (/特定日運行/.test(s)) return "特定日運行";
  if (/一部の便の運行を再開/.test(s)) return "一部運行";
  if (/一部の便を運休/.test(s)) return "一部便運休";
  return "";
}

function jrRouteStatus(text: string, marker: string) {
  const i = text.indexOf(marker);
  if (i < 0) return "";
  const before = text.slice(0, i);
  const sections = [
    ["全便運休中路線", "全便運休"],
    ["減便中路線", "減便"],
    ["通常運行している路線", "通常運行"],
  ] as const;
  let best = { pos: -1, status: "" };
  for (const [key, status] of sections) {
    const pos = before.lastIndexOf(key);
    if (pos > best.pos) best = { pos, status };
  }
  return best.status;
}

async function getHighwayLive() {
  const [iyoR, jrR] = await Promise.allSettled([
    fetchTimeout(IYOTETSU_HIGHWAY_URL, true, 9000),
    fetchTimeout(JR_HIGHWAY_URL, true, 9000),
  ]);
  const items: any[] = [];

  if (iyoR.status === "fulfilled") {
    const t = flatText(iyoR.value as string);
    const routes = [
      ["東京", "松山 - 東京線"],
      ["名古屋", "松山 - 名古屋線"],
      ["神戸", "松山 - 神戸線"],
      ["岡山", "松山 - 岡山線"],
      ["新尾道・福山", "松山 - 新尾道・福山線"],
      ["福岡", "松山・今治 – 福岡線"],
    ];
    for (const [name, marker] of routes) {
      const status = iyotetsuRouteStatus(t, marker);
      if (status) items.push({ operator: "伊予鉄", route: name, status });
    }
  }

  if (jrR.status === "fulfilled") {
    const t = flatText(jrR.value as string);
    const routes = [
      ["大阪・京都", "松山エクスプレス号"],
      ["高知", "なんごくエクスプレス号"],
      ["岡山", "マドンナエクスプレス号"],
      ["名古屋", "瀬戸内エクスプレス名古屋号"],
      ["高松", "坊っちゃんエクスプレス号"],
      ["徳島", "吉野川エクスプレス号"],
    ];
    for (const [name, marker] of routes) {
      const status = jrRouteStatus(t, marker);
      if (status) items.push({ operator: "JR四国バス", route: name, status });
    }
  }

  return { ok: items.length > 0, items };
}


const P2P_HISTORY_URL = "https://api.p2pquake.net/v2/history?codes=551&codes=552&codes=556&limit=30";
const JMA_EHIME_WARNING_URL = "https://www.jma.go.jp/bosai/warning/data/warning/380000.json";
const MATSUYAMA_LAT = 33.8392;
const MATSUYAMA_LON = 132.7657;

const warningNames: Record<string,string> = {
  "02":"暴風雪警報","03":"大雨警報","04":"洪水警報","05":"暴風警報","06":"大雪警報","07":"波浪警報","08":"高潮警報",
  "09":"レベル3土砂災害警報","10":"大雨注意報","12":"大雪注意報","13":"風雪注意報","14":"雷注意報","15":"強風注意報",
  "16":"波浪注意報","17":"融雪注意報","18":"洪水注意報","19":"高潮注意報","20":"濃霧注意報","21":"乾燥注意報",
  "22":"なだれ注意報","23":"低温注意報","24":"霜注意報","25":"着氷注意報","26":"着雪注意報","27":"その他の注意報",
  "29":"レベル2土砂災害注意報","32":"暴風雪特別警報","33":"レベル5大雨特別警報","35":"暴風特別警報","36":"大雪特別警報",
  "37":"波浪特別警報","38":"レベル5高潮特別警報","39":"レベル5土砂災害特別警報","43":"レベル4大雨危険警報",
  "48":"レベル4高潮危険警報","49":"レベル4土砂災害危険警報"
};

function scaleLabel(v: unknown) {
  const n = Number(v);
  const map: Record<number,string> = {
    0:"0",10:"1",20:"2",30:"3",40:"4",45:"5弱",46:"5弱以上",50:"5強",55:"6弱",60:"6強",70:"7",99:"程度以上"
  };
  return map[n] ?? (Number.isFinite(n) ? String(n) : "不明");
}

function parseJstSlash(s: unknown) {
  const t = String(s || "").trim();
  if (!t) return NaN;
  return Date.parse(t.replace(/\//g,"-").replace(" ","T") + "+09:00");
}

function haversineKm(lat1:number, lon1:number, lat2:number, lon2:number) {
  const r = 6371;
  const toRad = (x:number) => x * Math.PI / 180;
  const p1=toRad(lat1), p2=toRad(lat2);
  const dp=toRad(lat2-lat1), dl=toRad(lon2-lon1);
  const a=Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*r*Math.asin(Math.sqrt(a));
}

function latestByCode(items:any[], code:number) {
  return items.find((x:any)=>Number(x?.code)===code) || null;
}

function parseWeatherWarning(json:any) {
  const municipal = Array.isArray(json?.areaTypes)
    ? json.areaTypes.flatMap((x:any)=>Array.isArray(x?.areas)?x.areas:[])
        .find((x:any)=>String(x?.code)==="3820100")
    : null;
  const active = (Array.isArray(municipal?.warnings)?municipal.warnings:[])
    .filter((w:any)=>w?.code && !/解除|発表警報・注意報はなし/.test(String(w?.status||"")))
    .map((w:any)=>({
      code:String(w.code),
      name:warningNames[String(w.code)] || ("警報・注意報 "+String(w.code)),
      status:String(w.status||"")
    }));
  return {
    ok:true,
    area:"松山市",
    reportDatetime:String(json?.reportDatetime||""),
    headlineText:String(json?.headlineText||""),
    active
  };
}

function parseDisaster(history:any[], weather:any) {
  const nowMs=Date.now();

  const eew = latestByCode(history,556);
  let eewOut:any = null;
  if (eew && !eew.cancelled && !eew.test) {
    const issueMs=parseJstSlash(eew?.issue?.time);
    if (Number.isFinite(issueMs) && nowMs-issueMs <= 5*60*1000) {
      const areas=Array.isArray(eew.areas)?eew.areas:[];
      const local=areas.find((a:any)=>
        /愛媛/.test(String(a?.pref||"")) && /中予|愛媛/.test(String(a?.name||""))
      ) || areas.find((a:any)=>/愛媛/.test(String(a?.pref||"")));
      eewOut={
        active:true,
        source:"P2P地震情報（気象庁EEW）",
        issuedAt:String(eew?.issue?.time||""),
        serial:String(eew?.issue?.serial||""),
        hypocenter:String(eew?.earthquake?.hypocenter?.name||""),
        magnitude:Number(eew?.earthquake?.hypocenter?.magnitude),
        depth:Number(eew?.earthquake?.hypocenter?.depth),
        originTime:String(eew?.earthquake?.originTime||""),
        domesticTsunami:String(eew?.earthquake?.domesticTsunami||""),
        local: local ? {
          area:String(local.name||"愛媛県"),
          scaleFrom:scaleLabel(local.scaleFrom),
          scaleTo:scaleLabel(local.scaleTo),
          kindCode:String(local.kindCode||""),
          arrivalTime:local.arrivalTime || null
        } : null
      };
    }
  }

  const tsunami = latestByCode(history,552);
  let tsunamiOut:any = null;
  if (tsunami && !tsunami.cancelled) {
    const areas=(Array.isArray(tsunami.areas)?tsunami.areas:[])
      .filter((a:any)=>/愛媛/.test(String(a?.name||"")))
      .map((a:any)=>({
        name:String(a.name||""),
        grade:String(a.grade||""),
        immediate:!!a.immediate,
        arrivalTime:a?.firstHeight?.arrivalTime || null,
        condition:String(a?.firstHeight?.condition||""),
        maxHeight:String(a?.maxHeight?.description||"")
      }));
    if (areas.length) {
      tsunamiOut={
        active:true,
        source:"P2P地震情報（気象庁津波情報）",
        issuedAt:String(tsunami?.issue?.time||""),
        areas
      };
    }
  }

  const recent = history.find((x:any)=>{
    if (Number(x?.code)!==551) return false;
    const h=x?.earthquake?.hypocenter;
    if (!h || Number(h.latitude)<=-100 || Number(h.longitude)<=-100) return false;
    const t=parseJstSlash(x?.earthquake?.time);
    if (!Number.isFinite(t) || nowMs-t > 3*60*60*1000) return false;
    const dist=haversineKm(MATSUYAMA_LAT,MATSUYAMA_LON,Number(h.latitude),Number(h.longitude));
    return dist <= 450 && (Number(h.magnitude)>=3 || Number(x?.earthquake?.maxScale)>=30);
  }) || null;

  let recentOut:any=null;
  if (recent) {
    const h=recent.earthquake.hypocenter;
    const dist=Math.round(haversineKm(MATSUYAMA_LAT,MATSUYAMA_LON,Number(h.latitude),Number(h.longitude)));
    const localPoints=(Array.isArray(recent.points)?recent.points:[]).filter((p:any)=>/愛媛/.test(String(p?.pref||"")));
    const localMax=localPoints.length ? Math.max(...localPoints.map((p:any)=>Number(p.scale)||-1)) : -1;
    recentOut={
      active:true,
      source:"P2P地震情報（気象庁地震情報）",
      time:String(recent?.earthquake?.time||""),
      hypocenter:String(h?.name||""),
      magnitude:Number(h?.magnitude),
      depth:Number(h?.depth),
      maxScale:scaleLabel(recent?.earthquake?.maxScale),
      distanceKm:dist,
      ehimeScale:localMax>=0?scaleLabel(localMax):null,
      tsunami:String(recent?.earthquake?.domesticTsunami||"")
    };
  }

  return {
    ok:true,
    eew:eewOut,
    tsunami:tsunamiOut,
    recentEarthquake:recentOut,
    weather:parseWeatherWarning(weather)
  };
}

async function getDisasterLive() {
  const [history,weather]=await Promise.all([
    fetchTimeout(P2P_HISTORY_URL,false,7000),
    fetchTimeout(JMA_EHIME_WARNING_URL,false,7000)
  ]);
  return parseDisaster(Array.isArray(history)?history:[],weather);
}



Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "GET only" }), {
      status: 405,
      headers: corsHeaders(),
    });
  }

  const now = jstNow();
  const scope = new URL(req.url).searchParams.get("scope") || "all";
  const body: any = {
    ok: true,
    generatedAtJst: now.iso,
    pollAfterSeconds: scope === "disaster" ? 10 : (scope === "fast" ? 15 : 60),
  };

  if (scope === "fast" || scope === "all") {
    const [jr, bus] = await Promise.allSettled([getIchitsubo(now), getMadonna(now)]);
    body.ichitsubo =
      jr.status === "fulfilled"
        ? jr.value
        : { ok: false, alert: false, message: "", error: String(jr.reason) };
    body.madonna =
      bus.status === "fulfilled"
        ? bus.value
        : { ok: false, alert: false, message: "", error: String(bus.reason) };
    body.ok = body.ok && (jr.status === "fulfilled" || bus.status === "fulfilled");
  }

  if (scope === "disaster" || scope === "all") {
    const disaster = await Promise.allSettled([getDisasterLive()]);
    body.disaster = disaster[0].status === "fulfilled"
      ? disaster[0].value
      : { ok:false, eew:null, tsunami:null, recentEarthquake:null, weather:{ok:false,active:[]}, error:String(disaster[0].reason) };
    body.ok = body.ok && disaster[0].status === "fulfilled";
  }


  if (scope === "slow" || scope === "all") {
    const [airport, ferry, highway] = await Promise.allSettled([
      getAirportLive(),
      getFerryLive(),
      getHighwayLive(),
    ]);
    body.airport =
      airport.status === "fulfilled"
        ? airport.value
        : { ok: false, error: String(airport.reason) };
    body.ferry =
      ferry.status === "fulfilled"
        ? ferry.value
        : { ok: false, items: [], error: String(ferry.reason) };
    body.highway =
      highway.status === "fulfilled"
        ? highway.value
        : { ok: false, items: [], error: String(highway.reason) };
    body.ok = body.ok && (
      airport.status === "fulfilled" ||
      ferry.status === "fulfilled" ||
      highway.status === "fulfilled"
    );
  }

  return new Response(JSON.stringify(body), {
    status: body.ok ? 200 : 502,
    headers: corsHeaders(),
  });
});

