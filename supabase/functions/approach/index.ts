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
  matsuyamaDepartureIndex: number;
  matsuyamaDepartureTime: string;
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
  const matsuyamaDepartureIndex = points.findIndex((p) =>
    normalizeStationName(p.station) === "松山" &&
    /発/.test(p.event) &&
    /^\d{1,2}:\d{2}$/.test(p.time)
  );
  const matsuyamaDepartureTime = matsuyamaDepartureIndex >= 0
    ? String(points[matsuyamaDepartureIndex]?.time ?? "")
    : "";
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
    matsuyamaDepartureIndex,
    matsuyamaDepartureTime,
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

function matsuyamaRouteDirection(route: Route) {
  const idx = route.matsuyamaDepartureIndex;
  if (idx < 0) return "";
  const here = normalizeStationName(route.points[idx]?.station);
  const next = route.points.slice(idx + 1)
    .map((p) => normalizeStationName(p.station))
    .find((s) => s && s !== here) ?? "";
  if (/^(市坪|北伊予|南伊予|伊予横田|鳥ノ木|伊予市|向井原|内子|伊予大洲|八幡浜|宇和島)$/.test(next)) return "south";
  if (/^(三津浜|伊予和気|堀江|光洋台|粟井|柳原|伊予北条|今治|伊予西条|新居浜|観音寺|高松|岡山)$/.test(next)) return "north";
  return "";
}

function matsuyamaInboundSide(route: Route) {
  const idx = route.matsuyamaIndex;
  if (idx < 0) return "";
  const here = normalizeStationName(route.points[idx]?.station);
  const prev = route.points.slice(0, idx).reverse()
    .map((p) => normalizeStationName(p.station))
    .find((s) => s && s !== here && s !== "松山基地") ?? "";
  if (/^(三津浜|伊予和気|堀江|光洋台|粟井|柳原|伊予北条|今治|伊予西条|新居浜|観音寺|高松|岡山)$/.test(prev)) return "north";
  if (/^(市坪|北伊予|南伊予|伊予横田|鳥ノ木|伊予市|向井原|内子|伊予大洲|八幡浜|宇和島)$/.test(prev)) return "south";
  return "";
}

function matsuyamaTrainClass(trainNum: string) {
  const m = String(trainNum || "").trim().match(/^(\d+)([A-Z]+)$/i);
  if (!m) return "local";
  const n = Number(m[1]);
  const suffix = String(m[2] || "").toUpperCase();
  if (suffix === "M" && ((n >= 1 && n <= 40) || (n >= 1000 && n <= 1199))) return "limited";
  if (suffix === "D" && n >= 1051 && n <= 1099) return "limited";
  return "local";
}

function routeTerminatesAtMatsuyama(route: Route) {
  if (route.matsuyamaIndex < 0 || !/^\d{1,2}:\d{2}$/.test(route.matsuyamaTime)) return false;
  if (normalizeStationName(route.destination) !== "松山") return false;
  const after = route.points.slice(route.matsuyamaIndex + 1)
    .map((p) => normalizeStationName(p.station))
    .filter((s) => s && s !== "松山" && s !== "松山基地");
  return after.length === 0;
}

function exactStopsAfterMatsuyama(route: Route) {
  const idx = route.matsuyamaDepartureIndex;
  if (idx < 0) return [];
  const out: { station: string; time: string }[] = [];
  const seen = new Set<string>();
  for (const p of route.points.slice(idx + 1)) {
    const station = normalizeStationName(p.station);
    if (!station || station === "松山基地" || seen.has(station)) continue;
    if (/通/.test(p.event) || !/着|発/.test(p.event) || !/^\d{1,2}:\d{2}$/.test(p.time)) continue;
    // Prefer the arrival event when both arrival/departure points exist.
    const same = route.points.slice(idx + 1).filter((q) =>
      normalizeStationName(q.station) === station &&
      !/通/.test(q.event) &&
      /着/.test(q.event) &&
      /^\d{1,2}:\d{2}$/.test(q.time)
    );
    const t = same[0]?.time || p.time;
    out.push({ station, time: String(t) });
    seen.add(station);
  }
  return out;
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

function isFreight(pos: Record<string, unknown>, route: Route) {
  const num = String(pos.TrainNum ?? route.trainNum ?? "").trim();
  // Current Matsuyama freight pair: Takamatsu Freight Terminal <-> Matsuyama Freight.
  return /^(?:3072|3073)$/.test(num);
}

function displayName(pos: Record<string, unknown>, route: Route) {
  if (isDeadhead(pos, route)) return "回送列車";
  if (isFreight(pos, route)) return "貨物列車";
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
  const positionByTrain = new Map(
    positions.map((x) => [String(x.TrainNum), x] as const)
  );

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
    const freight = isFreight(pos, route);
    const passing = deadhead || freight || route.passOnly;
    const threshold = deadhead || freight ? 2 : passing ? 1 : 4;

    if (Number.isFinite(diff) && !(diff >= 0 && diff <= threshold)) return null;

    let message = "";
    if (deadhead) message = "まもなく　市坪駅を　回送列車が通過します";
    else if (freight) message = "まもなく　市坪駅を　貨物列車が通過します";
    else if (route.passOnly) message = `まもなく　市坪駅を　${displayName(pos, route)}が通過します`;
    else message = `まもなく　市坪駅に　${route.destination}行がまいります`;

    return {
      alert: true,
      message,
      trainNum: String(pos.TrainNum),
      kind: deadhead ? "deadhead" : freight ? "freight" : route.passOnly ? "pass" : "stop",
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

  const matsuyamaFreights = positions.map((pos) => {
    const route = diagram.get(String(pos.TrainNum));
    if (!route || !isFreight(pos, route) || route.matsuyamaIndex < 0) return null;
    if (!/^\d{1,2}:\d{2}$/.test(route.matsuyamaTime)) return null;

    const delay = Number(pos.delay ?? 0) || 0;
    let diff = toMinutes(route.matsuyamaTime) + delay - now.minutes;
    if (diff < -720) diff += 1440;
    if (diff > 720) diff -= 1440;
    if (!Number.isFinite(diff) || diff < -2 || diff > 240) return null;

    return {
      trainNum: String(pos.TrainNum),
      kind: "freight",
      origin: route.origin || "",
      destination: route.destination || "",
      position: String(pos.Pos ?? ""),
      delayMinutes: delay,
      scheduledMatsuyama: route.matsuyamaTime,
      minutesToMatsuyama: diff,
    };
  }).filter(Boolean).sort((a: any, b: any) => (a.minutesToMatsuyama ?? 999) - (b.minutesToMatsuyama ?? 999));

  const matsuyamaSchedule = [...diagram.values()].map((route) => {
    if (route.matsuyamaDepartureIndex < 0 || !/^\d{1,2}:\d{2}$/.test(route.matsuyamaDepartureTime)) return null;
    const num = String(route.trainNum || "").trim();
    if (/^[0-9]{1,4}[AER]$/i.test(num) || /^(?:3072|3073)$/.test(num)) return null;
    const direction = matsuyamaRouteDirection(route);
    if (!direction) return null;

    const stops = exactStopsAfterMatsuyama(route);
    const terminal = stops.length ? stops[stops.length - 1] : null;
    return {
      trainNum: num,
      trainClass: matsuyamaTrainClass(num),
      departure: route.matsuyamaDepartureTime,
      direction,
      destination: route.destination || terminal?.station || "",
      stops,
      terminal,
    };
  }).filter(Boolean).sort((a: any, b: any) => toMinutes(a.departure) - toMinutes(b.departure));

  // Position-confirmed Matsuyama departures only. The diagram gives the
  // schedule, but never makes a train live unless currentPositions contains
  // a matching train number with a real position.
  const matsuyamaActiveTrains = matsuyamaSchedule.map((scheduled) => {
    const pos = positionByTrain.get(String(scheduled.trainNum));
    if (!pos) return null;
    const position = normalizeStationName(pos.Pos ?? "");
    if (!position || /^(?:-|—|不明|未取得|取得中|確認中|データなし)$/.test(position)) return null;
    const rawDelay = Number(pos.delay);
    return {
      trainNum: scheduled.trainNum,
      direction: scheduled.direction,
      departure: scheduled.departure,
      destination: scheduled.destination,
      trainClass: scheduled.trainClass,
      position,
      delayMinutes: Number.isFinite(rawDelay) ? rawDelay : 0,
    };
  }).filter(Boolean);

  const matsuyamaTerminatingArrivals = [...diagram.values()].map((route) => {
    const num = String(route.trainNum || "").trim();
    if (!routeTerminatesAtMatsuyama(route)) return null;
    if (/^[0-9]{1,4}[AER]$/i.test(num) || /^(?:3072|3073)$/.test(num)) return null;
    const side = matsuyamaInboundSide(route);
    if (!side) return null;

    const arrival = String(route.matsuyamaTime || "");
    const trainClass = matsuyamaTrainClass(num);
    const maxGap = trainClass === "limited" ? 45 : 30;
    const candidates = matsuyamaSchedule.filter((x: any) => {
      if (!x || x.direction !== side || x.trainClass !== trainClass) return false;
      let gap = toMinutes(x.departure) - toMinutes(arrival);
      if (gap < -720) gap += 1440;
      return gap >= 4 && gap <= maxGap;
    });

    // Only claim "turnback" when today's diagram produces one unambiguous
    // same-corridor/same-class departure in a short turn-around window.
    const turnback = candidates.length === 1
      ? {
          trainNum: candidates[0].trainNum,
          departure: candidates[0].departure,
          direction: candidates[0].direction,
          destination: candidates[0].destination,
        }
      : null;

    const livePos = positionByTrain.get(num);
    const rawDelay = livePos?.delay;
    const numericDelay = Number(rawDelay);
    return {
      trainNum: num,
      trainClass,
      arrival,
      side,
      origin: route.origin || "",
      position: String(livePos?.Pos ?? ""),
      delayMinutes: Number.isFinite(numericDelay) ? numericDelay : 0,
      liveState: typeof rawDelay === "string" && rawDelay ? rawDelay : "",
      turnback,
    };
  }).filter(Boolean).sort((a: any, b: any) => toMinutes(a.arrival) - toMinutes(b.arrival));

  return {
    ok: true,
    source: "JR四国非公式アプリ系公開データ",
    fetchedAt: pjson?.fetchedAt ?? null,
    approaching,
    matsuyamaDeadheads,
    matsuyamaFreights,
    matsuyamaSchedule,
    matsuyamaActiveTrains,
    matsuyamaTerminatingArrivals,
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
const AIRPORT_ROUTE_URLS: Record<string, string> = {
  "東京(羽田)": "https://www.matsuyama-airport.co.jp/flight/haneda/",
  "大阪(伊丹)": "https://www.matsuyama-airport.co.jp/flight/itami/",
  "名古屋(中部)": "https://www.matsuyama-airport.co.jp/flight/chubu/",
  "成田": "https://www.matsuyama-airport.co.jp/flight/narita/",
  "福岡": "https://www.matsuyama-airport.co.jp/flight/fukuoka/",
  "沖縄(那覇)": "https://www.matsuyama-airport.co.jp/flight/okinawa/",
  "鹿児島": "https://www.matsuyama-airport.co.jp/flight/kagoshima/",
};
const AIRPORT_ORIGIN_LABELS: Record<string, string> = {
  "東京(羽田)": "羽田空港",
  "大阪(伊丹)": "伊丹空港",
  "名古屋(中部)": "中部国際空港",
  "成田": "成田空港",
  "福岡": "福岡空港",
  "沖縄(那覇)": "那覇空港",
  "鹿児島": "鹿児島空港",
};
const airportRouteScheduleCache: {
  at: number;
  map: Map<string, { departure: string; arrival: string; place: string }>;
} = { at: 0, map: new Map() };
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

function parseAirportRouteSchedule(html: string, place: string) {
  const text = flatText(html);
  const out: { number: string; departure: string; arrival: string; place: string }[] = [];
  const re = /出発時刻\s*(\d{1,2}:\d{2})\s*到着時刻\s*(\d{1,2}:\d{2}).{0,100}?便名\s*(?:[A-Z]{2,4}\s*)?(\d{1,4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      departure: m[1],
      arrival: m[2],
      number: m[3],
      place,
    });
  }
  return out;
}

async function loadAirportRouteSchedules() {
  const now = Date.now();
  if (airportRouteScheduleCache.map.size && now - airportRouteScheduleCache.at < 6 * 60 * 60 * 1000) {
    return airportRouteScheduleCache.map;
  }

  const entries = Object.entries(AIRPORT_ROUTE_URLS);
  const settled = await Promise.allSettled(
    entries.map(async ([place, url]) => {
      const html = await fetchTimeout(url, true, 6500) as string;
      return parseAirportRouteSchedule(html, place);
    })
  );

  const map = new Map<string, { departure: string; arrival: string; place: string }>();
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const [place] = entries[index];
    for (const row of result.value) {
      const key = `${place}|${row.number}|${row.arrival}`;
      map.set(key, { departure: row.departure, arrival: row.arrival, place });
    }
  });

  if (map.size) {
    airportRouteScheduleCache.map = map;
    airportRouteScheduleCache.at = now;
  }
  return airportRouteScheduleCache.map;
}


// A single free 250 NM ADS-B query for aircraft potentially approaching RJOM.
// Never infer an origin departure from the published flight schedule.
const MATSUGYAMA_ADSB_URLS = [
  "https://api.adsb.lol/v2/point/33.8272/132.6997/250",
  "https://api.airplanes.live/v2/point/33.8272/132.6997/250",
];
const matsuyamaAdsbCache: {at:number; result:any} = {at:0,result:null};
async function loadMatsuyamaAdsbAircraft() {
  const now=Date.now();
  if(matsuyamaAdsbCache.result && now-matsuyamaAdsbCache.at<40000) return matsuyamaAdsbCache.result;
  for(const [index,url] of MATSUGYAMA_ADSB_URLS.entries()) {
    try {
      const input:any=await fetchTimeout(url,false,5200);
      if(!Array.isArray(input?.ac)) throw Error("ADS-B missing aircraft array");
      const source=index===0?"ADSB.lol":"Airplanes.live";
      const observedAt=new Date().toISOString();
      const aircraft=input.ac.filter((a:any)=>{
        const flight=String(a?.flight||"").trim().toUpperCase().replace(/\s+/g,"");
        const seen=Number(a?.seen),seenPos=Number(a?.seen_pos);
        const altitude=Number(a?.alt_baro);
        return /^(?:JAL|ANA|IBX|JJP|JJA|ABL|EVA|JTA|RAC|FDA|ADO|SFJ)\d+[A-Z]?$/.test(flight)
          && Number.isFinite(Number(a.lat))&&Number.isFinite(Number(a.lon))
          && Number.isFinite(Number(a.track))&&Number.isFinite(Number(a.gs))
          && a.alt_baro!=="ground" && Number.isFinite(altitude) && altitude>350
          && Number(a.gs)>75 && Number.isFinite(seen)&&seen>=0&&seen<=30
          && Number.isFinite(seenPos)&&seenPos>=0&&seenPos<=30;
      }).map((a:any)=>({
        flight:String(a.flight).trim().toUpperCase().replace(/\s+/g,""),
        hex:String(a.hex||"").slice(0,12),
        lat:Number(a.lat),lon:Number(a.lon),
        track:Number(a.track),groundSpeedKt:Number(a.gs),
        altitudeFt:Number(a.alt_baro),seenPosSeconds:Number(a.seen_pos)
      })).slice(0,140);
      if(aircraft.length===0)continue;
      const result={ok:true,source,observedAt,aircraft};
      matsuyamaAdsbCache.at=now;
      matsuyamaAdsbCache.result=result;
      return result;
    }catch(_){/* Free ADS-B endpoint may be unreachable or rate-limited. */}
  }
  const result={ok:false,source:"ADS-B unavailable",observedAt:new Date().toISOString(),aircraft:[]};
  matsuyamaAdsbCache.at=now;
  matsuyamaAdsbCache.result=result;
  return result;
}


const MATSUGYAMA_ARRIVAL_FLIGHT_SPECS = [{"number":"431","place":"東京（羽田）","callsign":"JAL431","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"583","place":"東京（羽田）","callsign":"ANA583","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"585","place":"東京（羽田）","callsign":"ANA585","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"433","place":"東京（羽田）","callsign":"JAL433","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"589","place":"東京（羽田）","callsign":"ANA589","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"435","place":"東京（羽田）","callsign":"JAL435","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"593","place":"東京（羽田）","callsign":"ANA593","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"437","place":"東京（羽田）","callsign":"JAL437","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"439","place":"東京（羽田）","callsign":"JAL439","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"595","place":"東京（羽田）","callsign":"ANA595","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"599","place":"東京（羽田）","callsign":"ANA599","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"443","place":"東京（羽田）","callsign":"JAL443","name":"羽田空港","lat":35.5494,"lon":139.7798},{"number":"401","place":"東京（成田）","callsign":"JJP401","name":"成田空港","lat":35.7719,"lon":140.3929},{"number":"405","place":"東京（成田）","callsign":"JJP405","name":"成田空港","lat":35.7719,"lon":140.3929},{"number":"409","place":"東京（成田）","callsign":"JJP409","name":"成田空港","lat":35.7719,"lon":140.3929},{"number":"1633","place":"大阪（伊丹）","callsign":"ANA1633","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"1635","place":"大阪（伊丹）","callsign":"ANA1635","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"2301","place":"大阪（伊丹）","callsign":"JAL2301","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"1639","place":"大阪（伊丹）","callsign":"ANA1639","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"1641","place":"大阪（伊丹）","callsign":"ANA1641","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"1643","place":"大阪（伊丹）","callsign":"ANA1643","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"2309","place":"大阪（伊丹）","callsign":"JAL2309","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"1645","place":"大阪（伊丹）","callsign":"ANA1645","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"1647","place":"大阪（伊丹）","callsign":"ANA1647","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"1649","place":"大阪（伊丹）","callsign":"ANA1649","name":"伊丹空港","lat":34.7855,"lon":135.4382},{"number":"33","place":"名古屋（中部）","callsign":"IBX33","name":"中部国際空港","lat":34.8584,"lon":136.8054},{"number":"35","place":"名古屋（中部）","callsign":"IBX35","name":"中部国際空港","lat":34.8584,"lon":136.8054},{"number":"37","place":"名古屋（中部）","callsign":"IBX37","name":"中部国際空港","lat":34.8584,"lon":136.8054},{"number":"3591","place":"福岡","callsign":"JAL3591","name":"福岡空港","lat":33.5859,"lon":130.4507},{"number":"3595","place":"福岡","callsign":"JAL3595","name":"福岡空港","lat":33.5859,"lon":130.4507},{"number":"3601","place":"福岡","callsign":"JAL3601","name":"福岡空港","lat":33.5859,"lon":130.4507},{"number":"3607","place":"福岡","callsign":"JAL3607","name":"福岡空港","lat":33.5859,"lon":130.4507},{"number":"3687","place":"鹿児島","callsign":"JAL3687","name":"鹿児島空港","lat":31.8034,"lon":130.7194},{"number":"1884","place":"沖縄（那覇）","callsign":"ANA1884","name":"那覇空港","lat":26.1958,"lon":127.6459},{"number":"1701","place":"ソウル（仁川）","callsign":"JJA1701","name":"仁川国際空港","lat":37.4602,"lon":126.4407},{"number":"1771","place":"ソウル（仁川）","callsign":"JJA1771","name":"仁川国際空港","lat":37.4602,"lon":126.4407},{"number":"110","place":"台北（桃園）","callsign":"EVA110","name":"桃園国際空港","lat":25.0797,"lon":121.2342},{"number":"1703","place":"ソウル（仁川）","callsign":"JJA1703","name":"仁川国際空港","lat":37.4602,"lon":126.4407},{"number":"134","place":"釜山","callsign":"ABL134","name":"金海国際空港","lat":35.1795,"lon":128.9382}];
function airportPlaceKey(p:unknown) {
  return String(p||"").normalize("NFKC").replace(/[\s()（）\-・]/g,"");
}
function flightKm(lat1:number,lon1:number,lat2:number,lon2:number) {
  const rad=Math.PI/180,dLat=(lat2-lat1)*rad,dLon=(lon2-lon1)*rad;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
}
function flightBearing(lat1:number,lon1:number,lat2:number,lon2:number) {
  const a=lat1*Math.PI/180,b=lat2*Math.PI/180,dl=(lon2-lon1)*Math.PI/180;
  return (Math.atan2(Math.sin(dl)*Math.cos(b),Math.cos(a)*Math.sin(b)-Math.sin(a)*Math.cos(b)*Math.cos(dl))*180/Math.PI+360)%360;
}
function compassFromAirport(bearing:number) {
  return ["北","北東","東","南東","南","南西","西","北西"][Math.round(bearing/45)%8];
}
const MATSUGYAMA_LAT=33.8272,MATSUGYAMA_LON=132.6997;
const arrivalAdsbCache:{at:number;key:string;aircraft:any[];source:string}={at:0,key:"",aircraft:[],source:""};
async function fetchMatsuyamaArrivalsByCallsign(callsigns:string[]) {
  const key=callsigns.slice().sort().join(",");
  if(arrivalAdsbCache.at && arrivalAdsbCache.key===key && Date.now()-arrivalAdsbCache.at<45000)
    return {ok:true,source:arrivalAdsbCache.source,aircraft:arrivalAdsbCache.aircraft,observedAt:new Date(arrivalAdsbCache.at).toISOString()};
  const bases=["https://api.adsb.lol/v2/callsign/","https://api.airplanes.live/v2/callsign/"];
  // Keep the query small and avoid per-flight API calls.
  const path=encodeURIComponent(key).replace(/%2C/gi,",");
  for(const base of bases){
    try{
      const raw:any=await fetchTimeout(base+path,false,6000);
      if(!Array.isArray(raw?.ac))throw Error("Missing ADS-B aircraft list");
      const unique=new Map<string,any>();
      for(const a of raw.ac){
        const callsign=String(a?.flight||"").trim().toUpperCase().replace(/\s+/g,"");
        if(!callsigns.includes(callsign))continue;
        const lat=Number(a?.lat),lon=Number(a?.lon),seen=Number(a?.seen_pos);
        if(!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(seen)||seen<0||seen>35)continue;
        const flight={flight:callsign,hex:String(a?.hex||""),lat,lon,seenPosSeconds:seen,
          altBaro:a?.alt_baro,gs:Number(a?.gs),track:Number(a?.track)};
        const previous=unique.get(callsign);
        if(!previous||seen<previous.seenPosSeconds)unique.set(callsign,flight);
      }
      const aircraft=[...unique.values()];
      if(aircraft.length===0) continue; // Try the second ADS-B network on an empty result.
      const at=Date.now();
      arrivalAdsbCache.at=at;arrivalAdsbCache.key=key;
      arrivalAdsbCache.aircraft=aircraft;arrivalAdsbCache.source=base.includes("adsb.lol")?"ADSB.lol":"Airplanes.live";
      return {ok:true,source:arrivalAdsbCache.source,aircraft,observedAt:new Date(at).toISOString()};
    }catch(_){/* Public API can time out or reject repeated requests. */}
  }
  // Callsign-list lookups may be empty even while an approaching plane is
  // visible in the regional ADS-B feed. Try the existing 250 NM area query.
  const nearby=await loadMatsuyamaAdsbAircraft();
  const matches=(nearby.aircraft||[]).filter((x:any)=>callsigns.includes(x.flight))
    .map((x:any)=>({
      flight:x.flight,hex:x.hex,lat:x.lat,lon:x.lon,
      seenPosSeconds:x.seenPosSeconds,altBaro:x.altitudeFt,
      gs:x.groundSpeedKt,track:x.track
    }));
  console.info("MATS_ADSB_REGIONAL",nearby.source,(nearby.aircraft||[]).length,matches.length);
  if(Date.now()<Date.parse("2026-10-10T02:40:00Z")) console.info("MATS_ADSB_SAMPLE",JSON.stringify((nearby.aircraft||[]).slice(0,24).map((a:any)=>({id:a.flight,distance:Math.round(flightKm(a.lat,a.lon,MATSUGYAMA_LAT,MATSUGYAMA_LON)),direction:Math.round(a.track)}))));
  if(matches.length>0){
    return {ok:true,source:nearby.source+" regional",aircraft:matches,observedAt:nearby.observedAt};
  }
  return {ok:false,source:"ADS-B aircraft not verified",aircraft:[],observedAt:new Date().toISOString()};
}
async function enrichArrivalsWithAdsb(arrivals:any[]) {
  const keys=new Map<string,{callsign:string;number:string;place:string;name:string;lat:number;lon:number}>();
  for(const s of MATSUGYAMA_ARRIVAL_FLIGHT_SPECS){
    keys.set(airportPlaceKey(s.place)+"|"+s.number,s);
  }
  const matchSpecs=arrivals.map(item=>{
    const nums=(Array.isArray(item?.numbers)?item.numbers:[]).map(String);
    const matches=nums.map(n=>keys.get(airportPlaceKey(item?.place)+"|"+n)).filter(Boolean);
    // Only one distinct operator/flight can be used as an exact identity.
    const unique=[...new Set(matches.map(m=>m!.callsign))];
    return unique.length===1 ? matches[0] : null;
  });
  const callsigns=[...new Set(matchSpecs.filter(Boolean).map(s=>s!.callsign))];
  if(!callsigns.length)return {arrivals,adsb:{ok:false,source:"No matched flight callsigns",aircraft:[]}};
  const adsb=await fetchMatsuyamaArrivalsByCallsign(callsigns);
  console.info('MATS_DIAG_COUNTS',callsigns.length,(adsb.aircraft||[]).length,adsb.source);
  const seen=new Map<string,any>();
  for(const a of adsb.aircraft||[]){
    if(!seen.has(a.flight))seen.set(a.flight,a);
    else { // Ambiguous aircraft for a callsign: fail closed rather than guess.
      seen.set(a.flight,null);
    }
  }
  const now=jstNow().minutes;
  const output=arrivals.map((item,index)=>{
    const spec=matchSpecs[index],a=spec?seen.get(spec.callsign):null;
    if(!spec||!a)return item;
    const arrMinute=toMinutes(item.changed||item.scheduled);
    let before=arrMinute-now;
    if(before< -720)before+=1440;
    if(before>720)before-=1440;
    if(!Number.isFinite(before)||before< -20||before>260)return item;
    const atOrigin=flightKm(a.lat,a.lon,spec.lat,spec.lon);
    const atMatsuyama=flightKm(a.lat,a.lon,MATSUGYAMA_LAT,MATSUGYAMA_LON);
    const speed=Number(a.gs),alt=Number(a.altBaro);
    const onGround=a.altBaro==="ground" ||
      (Number.isFinite(alt)&&alt<1800&&Number.isFinite(speed)&&speed<45);
    const sourceText=(adsb.source||"ADS-B")+" 機体位置";
    // Waiting only when the plane is physically at its named origin airport.
    if(atOrigin<=5 && onGround && before>=0){
      return {...item,aircraftFlightPhase:"waiting",aircraftPositionConfirmed:true,
        aircraftObservedAt:adsb.observedAt,aircraftCallsign:spec.callsign,
        aircraftPositionText:spec.name+"にて出発待ち",aircraftDataSource:sourceText};
    }
    if(!Number.isFinite(alt)||alt<500||!Number.isFinite(speed)||speed<85||atMatsuyama>1650)return item;
    if(!Number.isFinite(a.track))return item;
    const bearingToMatsuyama=flightBearing(a.lat,a.lon,MATSUGYAMA_LAT,MATSUGYAMA_LON);
    const deviation=Math.abs(((a.track-bearingToMatsuyama+540)%360)-180);
    if(atMatsuyama>30&&deviation>85)return item;
    const direction=compassFromAirport(flightBearing(MATSUGYAMA_LAT,MATSUGYAMA_LON,a.lat,a.lon));
    const distance=Math.max(5,Math.round(atMatsuyama/5)*5);
    const place=atMatsuyama<55
      ? "松山空港へ接近中（約"+distance+"km）"
      : "現在 松山空港の"+direction+" 約"+distance+"kmを航行中";
    return {...item,originDepartureConfirmed:true,aircraftFlightPhase:atMatsuyama<55?"approaching":"airborne",
      aircraftPositionConfirmed:true,aircraftObservedAt:adsb.observedAt,
      aircraftCallsign:spec.callsign,aircraftPositionText:place,aircraftDataSource:sourceText};
  });
  // Only metadata from confirmed position matches; never claim real takeoff clock time.
  return {arrivals:output,adsb:{ok:adsb.ok,source:adsb.source,observedAt:adsb.observedAt,matchedFlights:output.filter(x=>x.aircraftPositionConfirmed).length}};
}


const ITAMI_DEPARTURE_BOARD_URL="https://www.osaka-airport.co.jp/flight/search?direction=DEP&duration=all";
async function getItamiDepartures() {
  try {
    const html=await fetchTimeout(ITAMI_DEPARTURE_BOARD_URL,true,8500) as string;
    const text=flatText(html);
    const today=String(jstNow().iso).slice(0,10);
    const m=today.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m||!new RegExp("本日\\s*"+Number(m[2])+"月"+Number(m[3])+"日").test(text))
      throw Error("Itami board date not verified for "+today);
    const results=new Map<string,any>();
    const exp=/松山\s+(NH|JL)\s*(\d{3,4})\s*\/\s*[^]{0,75}?ターミナル:\s*(?:北|南)\s*(?:ゲート:\s*[0-9A-Z]+\s*)?(\d{1,2}:\d{2})(?:\s+(\d{1,2}:\d{2}))?(?:\s+(出発済み?|欠航|搭乗中|搭乗口誘導中|搭乗ご案内|出発準備中|搭乗手続中|遅延))?/g;
    for(const match of text.matchAll(exp)) {
      const carrier=match[1]==="NH"?"ANA":"JAL";
      const key=carrier+match[2];
      const time=match[3],actual=match[4]||"";
      const status=String(match[5]||"").trim();
      if(results.has(key)){results.delete(key);continue;}
      results.set(key,{status,scheduled:time,actual:actual||null,origin:"伊丹空港"});
    }
    console.info("ITAMI_STATUS_DIAG",JSON.stringify({date:today,rows:results.size,
      departed:[...results.entries()].filter(x=>/出発済/.test(x[1].status)).map(x=>x[0]),
      sample:[...results.entries()].slice(0,7).map(x=>({id:x[0],status:x[1].status}))}));
    return results;
  }catch(e){
    console.info("ITAMI_STATUS_ERROR",String(e));
    return new Map<string,any>();
  }
}



const KAGOSHIMA_DEPARTURES_URL="https://www.koj-ab.co.jp/flight/today-dom-departure.html";
async function getKagoshimaDepartures() {
  const map=new Map<string,any>();
  try{
    const html=await fetchTimeout(KAGOSHIMA_DEPARTURES_URL,true,7400) as string;
    const text=flatText(html);
    const iso=String(jstNow().iso).slice(0,10);
    const date=(text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+\d{1,2}:\d{2}\s+現在/)||[]);
    const parsedDate=date.length?date[1]+"-"+String(Number(date[2])).padStart(2,"0")+"-"+String(Number(date[3])).padStart(2,"0"):"";
    if(parsedDate!==iso)throw Error("Kagoshima timetable date differs from today");
    if(!/本日のフライト（国内線出発）/.test(text))throw Error("Not domestic departures page");
    const matches=[...text.matchAll(/(?:^|\s)(\d{3,4})\s+松山\s+(\d{1,2}:\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*(出発済み?|欠航|搭乗ご案内中|搭乗手続き受付中|遅延|搭乗中)?/g)];
    for(const m of matches){
      const number=m[1],status=String(m[4]||"");
      if(map.has("JAL"+number)){map.delete("JAL"+number);continue;}
      map.set("JAL"+number,{status,scheduled:m[2],actual:null,origin:"鹿児島空港"});
    }
    console.info("KAGOSHIMA_STATUS_DIAG",JSON.stringify([...map.entries()].map(x=>({flight:x[0],status:x[1].status}))));
  }catch(e){console.info("KAGOSHIMA_STATUS_ERROR",String(e))}
  return map;
}






// Date-matched, exact flight-number departure evidence from airport-run feeds.
// Never substitute a scheduled time, changed time, or other airport's route.
const additionalOriginCache=new Map<string,{at:number,rows:Map<string,any>}>();
async function airportSourceCache(key:string,fn:()=>Promise<Map<string,any>>) {
  // Per-local-day cache: never reuse yesterday's flight-status evidence.
  const dateKey=key+"|"+String(jstNow().iso).slice(0,10);
  const hit=additionalOriginCache.get(dateKey);
  if(hit && Date.now()-hit.at<125000)return hit.rows;
  const rows=await fn();
  // Cache only successful nonempty airport feeds; failures may recover quickly.
  if(rows.size)additionalOriginCache.set(dateKey,{at:Date.now(),rows});
  return rows;
}
function officialOriginPut(dest:Map<string,any>,bad:Set<string>,key:string,entry:any){
  if(bad.has(key))return;
  if(dest.has(key)){dest.delete(key);bad.add(key);return}
  dest.set(key,entry);
}
function originDateParts(){
  const iso=String(jstNow().iso).slice(0,10);
  return {iso,compact:iso.replace(/-/g,"")};
}
function reportedActual(dateTime:unknown,compact:string){
  const t=String(dateTime||"");
  return t.startsWith(compact)&&/^\d{12,14}$/.test(t)?t.slice(8,10)+":"+t.slice(10,12):null;
}
async function getNahaDepartures(){
  return airportSourceCache("naha",async()=>{
    const rows=new Map<string,any>(),bad=new Set<string>();
    try{
      const data:any=await fetchTimeout("https://www.naha-airport.co.jp/fis/fis_national.json",false,7500);
      const {iso,compact}=originDateParts();
      if(String(data?.created_at||"").slice(0,10)!==iso.replace(/-/g,"/"))
        throw Error("Naha report date mismatch");
      if(!Array.isArray(data?.data))throw Error("Naha flights absent");
      for(const x of data.data){
        if(!Array.isArray(x)||String(x[10])!=="D"||String(x[4]||"").slice(0,8)!==compact)continue;
        if(String(x[3]||"").toUpperCase().trim()!=="MATSUYAMA")continue;
        const carrier=String(x[0]||"").replace(/^\uFEFF/,"").trim();
        if(carrier!=="NH")continue; // ANA1884; no unverified codeshares.
        const num=String(Number(x[1]));
        if(!/^\d{2,5}$/.test(num))continue;
        const status=String(x[7]||"").trim();
        officialOriginPut(rows,bad,"ANA"+num,{
          status,origin:"那覇空港",actual:/出発済/.test(status)?reportedActual(x[6],compact):null
        });
      }
    }catch(e){console.info("NAHA_ORIGIN_ERROR",String(e))}
    console.info("NAHA_ORIGIN_COUNT",rows.size,[...rows.entries()].map(x=>({no:x[0],status:x[1].status})));
    return rows;
  });
}
async function getCentrairDepartures(){
  return airportSourceCache("centrair",async()=>{
    const rows=new Map<string,any>(),bad=new Set<string>();
    try{
      const data:any=await fetchTimeout("https://www.centrair.jp/sys-assets/flight/search/flight_list_ja.json",false,7700);
      const {iso,compact}=originDateParts();
      if(!String(data?.data_update||"").startsWith(Number(iso.slice(0,4))+"年"+Number(iso.slice(5,7))+"月"+Number(iso.slice(8,10))+"日"))
        throw Error("Centrair report date mismatch");
      const current=Array.isArray(data?.dateList)
        ?data.dateList.filter((d:any)=>String(d.date||"")===compact):[];
      if(current.length!==1||!Array.isArray(current[0].list))throw Error("Centrair flights for today missing");
      for(const item of current[0].list){
        if(String(item?.final)!=="MYJ"||String(item?.extArrId)!=="D"||
          String(item?.airDate)!==compact||String(item?.designator)!=="IBX")continue;
        const match=String(item.designatorNo||"").match(/^IBX\s*(\d+)$/);
        if(!match)continue;
        const status=String(item.status?.infoInfo||item.infoTypeInfo||"").trim();
        const actual=/出発済/.test(status)&&String(item.extActDate||"")===compact&&/^\d{4}$/.test(String(item.extActTime||""))
          ?String(item.extActTime).slice(0,2)+":"+String(item.extActTime).slice(2):null;
        officialOriginPut(rows,bad,"IBX"+match[1],{status,actual,origin:"中部国際空港"});
      }
    }catch(e){console.info("CENTRAIR_ORIGIN_ERROR",String(e))}
    console.info("CENTRAIR_ORIGIN_COUNT",rows.size,[...rows.entries()].map(x=>({no:x[0],status:x[1].status})));
    return rows;
  });
}
async function getFukuokaDepartures(){
  return airportSourceCache("fukuoka",async()=>{
    const rows=new Map<string,any>(),bad=new Set<string>();
    try{
      const data:any=await fetchTimeout("https://www.fukuoka-airport.jp/api/flight_schedule/flight_schedule.json",false,8000);
      const {iso,compact}=originDateParts();
      if(!data||typeof data!=="object"||Array.isArray(data))throw Error("Fukuoka schedule JSON absent");
      for(const item of Object.values(data) as any[]){
        if(!item||String(item.flt_ymd)!==iso||String(item.deparv_div)!=="D"||
          String(item.tofrom_cd)!=="MYJ"||String(item.airline_cd)!=="JAL")continue;
        const num=String(Number(item.flt_num_no));
        if(!/^\d{2,5}$/.test(num))continue;
        const status=String(item.remarks||"").trim();
        officialOriginPut(rows,bad,"JAL"+num,{
          status,origin:"福岡空港",
          actual:/出発済/.test(status)?reportedActual(item.true_ymdhm,compact):null
        });
      }
    }catch(e){console.info("FUKUOKA_ORIGIN_ERROR",String(e))}
    console.info("FUKUOKA_ORIGIN_COUNT",rows.size,[...rows.entries()].map(x=>({no:x[0],status:x[1].status})));
    return rows;
  });
}






// Taoyuan Airport official government CSV (V2). Exact 2026 local date,
// airline BR, destination MYJ and '已飛'/'Flew' are all mandatory.
function parseAirportCsv(src:string){
  const rows:string[][]=[];let record:string[]=[],field="",quoted=false;
  for(let i=0;i<src.length;i++){
    const c=src[i];
    if(c==='"'){
      if(quoted && src[i+1]==='"'){field+='"';i++}else quoted=!quoted;
    }else if(c===','&&!quoted){record.push(field);field="";}
    else if((c==='\r'||c==='\n')&&!quoted){
      if(c==='\r'&&src[i+1]==='\n')i++;
      record.push(field);field="";
      if(record.some(v=>v.trim()))rows.push(record);
      record=[];
    }else field+=c;
  }
  if(field||record.length){record.push(field);rows.push(record)}
  return rows;
}
async function getTaoyuanDepartures() {
  return airportSourceCache("taoyuan",async()=>{
    const rows=new Map<string,any>(),bad=new Set<string>();
    try{
      const csv=await fetchTimeout("https://odp.taoyuan-airport.com/dataset/2025102001?format=csv",true,7400) as string;
      const data=parseAirportCsv(csv);
      if(!Array.isArray(data)||data.length<20||
        String(data[0]?.[0]||"").replace(/^\uFEFF/,"")!=="航廈"||data[0]?.[1]!=="方向")
        throw Error("Taoyuan V2 CSV header mismatch");
      const localDay=String(jstNow().iso).slice(0,10);
      for(const r of data.slice(1)){
        if(r.length<18||r[1]!=="D"||r[2]!=="BR"||r[10]!=="MYJ"||
          String(r[6]||"").slice(0,10)!==localDay)continue;
        const num=String(Number(r[4]));
        if(!/^\d{2,5}$/.test(num))continue;
        const movement=String(r[16]||"").trim();
        const movementEn=String(r[17]||"").trim();
        const airportStatus=String(r[13]||"").trim();
        const departed=movement==="已飛"||/^flew$/i.test(movementEn);
        const canceled=/取消|停飛|欠航|cancel/i.test(movement+" "+movementEn+" "+airportStatus);
        officialOriginPut(rows,bad,"EVA"+num,{
          status:canceled?"欠航":departed?"出発済み":movement||airportStatus||"出発未確認",
          actual:null,origin:"桃園国際空港"
        });
      }
    }catch(e){console.info("TAOYUAN_ORIGIN_ERROR",String(e))}
    console.info("TAOYUAN_ORIGIN_COUNT",rows.size,
      [...rows.entries()].slice(0,6).map(([id,x])=>({flight:id,status:x.status})));
    return rows;
  });
}



async function getGimhaeDepartures(){
  return airportSourceCache("gimhae",async()=>{
    const rows=new Map<string,any>(),bad=new Set<string>();
    try{
      const date=String(jstNow().iso).slice(0,10);
      const query=new URLSearchParams({
        pInoutGbn:"O",pAirport:"PUS",pGbn:"I",pActDate:date,
        pSthourMin:"00:00",pEnhourMin:"23:59",pCity:"MYJ",
        pAirline:"",pFlight:"",p0:"web"
      }).toString();
      const raw:any=await fetchTimeout(
        "https://www.airport.co.kr/gimhae/ajaxf/frPryInfoSvc/getPryInfoList.do?"+query,
        false,7100);
      const flights=raw?.data?.list;
      if(!Array.isArray(flights))throw Error("Gimhae official flights unavailable");
      const compact=date.replace(/-/g,"");
      for(const item of flights){
        if(String(item?.AIRPORT)!=="PUS" || String(item?.ACT_C_DATE)!==compact ||
          String(item?.ARRIVED_ENG||"").toUpperCase()!=="MATSUYAMA"||
          String(item?.AIR_FLN||"").trim()!=="BX134")continue;
        const korean=String(item.RMK_KOR||"").trim();
        const english=String(item.RMK_ENG||"").trim();
        const canceled=/^(결항|사전결항)$/.test(korean)||/cancel/i.test(english);
        const departed=korean==="출발"||/^departed$/i.test(english);
        const status=canceled?"欠航":departed?"出発済み":korean||"出発未確認";
        officialOriginPut(rows,bad,"ABL134",{status,origin:"金海国際空港",actual:null});
      }
    }catch(e){console.info("GIMHAE_ORIGIN_ERROR",String(e))}
    console.info("GIMHAE_ORIGIN_COUNT",rows.size,
      [...rows.entries()].slice(0,3).map(([no,r])=>({flight:no,status:r.status})));
    return rows;
  });
}

async function getAirportLive() {
  const itamiPromise=airportSourceCache("itami",getItamiDepartures);



  const kagoshimaPromise=airportSourceCache("kagoshima",getKagoshimaDepartures);
  const nahaPromise=getNahaDepartures();
  const centrairPromise=getCentrairDepartures();
  const fukuokaPromise=getFukuokaDepartures();
  // Match official arrivals to their specific ADS-B callsigns after parsing.
  const html = await fetchTimeout(AIRPORT_LIVE_URL, true, 9000) as string;
  const parsed = parseAirportFlights(html);
  // No reason to download a large Taiwanese feed on days with no Taoyuan arrival.
  const taoyuanPromise=parsed.arrivals.some((r:any)=>/^(台北|台湾)/.test(airportPlaceKey(r?.place)))
    ? getTaoyuanDepartures():Promise.resolve(new Map<string,any>());
  const gimhaePromise=parsed.arrivals.some((r:any)=>airportPlaceKey(r?.place)===airportPlaceKey("釜山"))
    ? getGimhaeDepartures():Promise.resolve(new Map<string,any>());
  try {
    const schedules = await loadAirportRouteSchedules();
    parsed.arrivals = parsed.arrivals.map((item: any) => {
      const place = String(item?.place || "").trim();
      const scheduled = String(item?.scheduled || "");
      const numbers = Array.isArray(item?.numbers) ? item.numbers.map(String) : [];
      let match: { departure: string; arrival: string; place: string } | undefined;
      for (const n of numbers) {
        match = schedules.get(`${place}|${n}|${scheduled}`);
        if (match) break;
      }
      if (!match) return item;
      return {
        ...item,
        originAirport: AIRPORT_ORIGIN_LABELS[place] || `${place}空港`,
        originDepartureScheduled: match.departure,
        originDepartureSource: "松山空港公式月間時刻表",
      };
    });
  } catch (_) {
    // Live arrival board remains usable even when route timetable enrichment fails.
  }

  const linked=await enrichArrivalsWithAdsb(parsed.arrivals);
  const itami=await itamiPromise;
  const kagoshima=await kagoshimaPromise;
  const naha=await nahaPromise;
  const centrair=await centrairPromise;
  const fukuoka=await fukuokaPromise;
  const taoyuan=await taoyuanPromise;
  const gimhae=await gimhaePromise;
  const officialOriginFeeds=[
    {place:"大阪(伊丹)",name:"伊丹空港",source:"大阪国際空港公式出発案内",map:itami,prefixes:["ANA","JAL"]},
    {place:"鹿児島",name:"鹿児島空港",source:"鹿児島空港公式出発案内",map:kagoshima,prefixes:["JAL"]},
    {place:"沖縄(那覇)",name:"那覇空港",source:"那覇空港公式出発案内",map:naha,prefixes:["ANA"]},
    {place:"名古屋(中部)",name:"中部国際空港",source:"中部国際空港公式出発案内",map:centrair,prefixes:["IBX"]},
    {place:"福岡",name:"福岡空港",source:"福岡空港公式出発案内",map:fukuoka,prefixes:["JAL"]},
    {place:"台北(桃園)",name:"桃園国際空港",source:"桃園国際空港公式出発案内",map:taoyuan,prefixes:["EVA"],aliases:["台北","台湾(桃園)"]},
    {place:"釜山",name:"金海国際空港",source:"金海国際空港公式出発案内",map:gimhae,prefixes:["ABL"],aliases:["プサン"]}
  ];
  const sourceCounts:Record<string,number>={};
  linked.arrivals=linked.arrivals.map((item:any)=>{
    const feed=officialOriginFeeds.find(x=>[x.place,...(x.aliases||[])].some(k=>airportPlaceKey(item?.place)===airportPlaceKey(k)));
    if(!feed)return item;
    const numbers=(Array.isArray(item?.numbers)?item.numbers:[]).map(String);
    const evidence=[...new Set(numbers.flatMap(n=>feed.prefixes.map(p=>feed.map.get(p+n)).filter(Boolean)))];
    if(evidence.length!==1)return item;
    const e=evidence[0];
    if(/欠航/.test(e.status))return {...item,originDepartureStatus:"欠航"};
    if(/出発済/.test(e.status)){
      sourceCounts[feed.name]=(sourceCounts[feed.name]||0)+1;
      return {...item,originDepartureVerified:true,originDepartureConfirmed:true,
        originDepartedObservedAt:new Date().toISOString(),
        originDepartureStatus:"出発済み",originDepartureAirport:feed.name,
        originDepartureActual:e.actual||null,
        originDepartureSource:feed.source};
    }
    if(/搭乗中|搭乗口誘導中|搭乗ご案内|出発準備中|搭乗手続中/.test(e.status)){
      return {...item,originDepartureStatus:e.status,
        originDepartureAirport:feed.name,originDepartureSource:feed.source};
    }
    return item;
  });
  console.info("ORIGIN_MATCH_COUNTS",JSON.stringify(sourceCounts));
  // Short-lived diagnostic: official rows vs actual ADS-B correlated rows.
  if(Date.now()<Date.parse("2026-10-10T03:00:00Z")) {
    console.info("MATSUYAMA_AIRPORT_DIAG",JSON.stringify({
      parsedOk:parsed.ok,officialDepartures:parsed.departures.length,officialArrivals:parsed.arrivals.length,
      adsbOk:linked.adsb.ok,source:linked.adsb.source,matched:linked.adsb.matchedFlights??0,
      sample:linked.arrivals.filter((x:any)=>x.aircraftPositionConfirmed).slice(0,5)
        .map((x:any)=>({numbers:x.numbers,place:x.place,phase:x.aircraftFlightPhase}))
    }));
  }
  parsed.arrivals=linked.arrivals;
  return {
    source: "松山空港公式",
    ...parsed,
    adsb: linked.adsb,
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

