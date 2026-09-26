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
  if (!city.length) return null;

  const passengerStop = city.some((p) => !/通/.test(p.event) && /着|発/.test(p.event));
  const cityTimePoint =
    city.find((p) => /通|着|発/.test(p.event) && /^\d{1,2}:\d{2}$/.test(p.time)) ?? city[0];
  const terminal =
    [...points].reverse().find((p) => p.station && p.station !== "松山基地") ?? points[points.length - 1];

  return {
    trainNum: String(trainNum),
    points,
    cityIndex: points.findIndex((p) => normalizeStationName(p.station) === "市坪"),
    passOnly: !passengerStop,
    cityTime: cityTimePoint?.time ?? "",
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
    scheduledSoon = diff >= -2 && diff <= 5;
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
    const threshold = deadhead ? 2 : passing ? 1 : 3;

    if (Number.isFinite(diff) && !(diff >= -1 && diff <= threshold)) return null;

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
    };
  }).filter(Boolean).sort((a: any, b: any) => (a.minutesToIchitsubo ?? 999) - (b.minutesToIchitsubo ?? 999));

  return {
    ok: true,
    source: "JR四国非公式アプリ系公開データ",
    fetchedAt: pjson?.fetchedAt ?? null,
    approaching,
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

  const route = (text.match(/系統\s*[:：]?\s*([0-9]+)/) ?? [])[1] ?? "51";
  const destination =
    ((text.match(/行き先\s*[:：]?\s*([^\n]+)/) ?? [])[1] ?? "松山市駅")
      .replace(/所要時間.*$/, "")
      .trim();

  const depBlock = text.match(
    /発\s*マドンナスタジアム[\s\S]{0,500}?予定時刻\s*(\d{1,2}:\d{2})[\s\S]{0,160}?発車予測\s*(\d{1,2}:\d{2})/
  );
  const scheduled =
    depBlock?.[1] ?? (text.match(/予定時刻\s*(\d{1,2}:\d{2})/) ?? [])[1] ?? null;
  const predicted =
    depBlock?.[2] ?? (text.match(/発車予測\s*(\d{1,2}:\d{2})/) ?? [])[1] ?? scheduled;

  const stopMatches = [...text.matchAll(/([0-9]+)\s*個前の停留所/g)]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
  const stopsAway = stopMatches.length ? Math.min(...stopMatches) : null;

  const pageMinutes = (text.match(/約\s*([0-9]+)\s*分で発車/) ?? [])[1];
  const minutes =
    pageMinutes != null ? Number(pageMinutes) : minutesFromNow(predicted, now.minutes);

  const alert =
    (Number.isFinite(stopsAway) && (stopsAway as number) <= 2) ||
    (Number.isFinite(minutes) && (minutes as number) >= -1 && (minutes as number) <= 3);

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "GET only" }), {
      status: 405,
      headers: corsHeaders(),
    });
  }

  const now = jstNow();
  const [jr, bus] = await Promise.allSettled([getIchitsubo(now), getMadonna(now)]);

  const body = {
    ok: jr.status === "fulfilled" || bus.status === "fulfilled",
    generatedAtJst: now.iso,
    pollAfterSeconds: 15,
    ichitsubo:
      jr.status === "fulfilled"
        ? jr.value
        : { ok: false, alert: false, message: "", error: String(jr.reason) },
    madonna:
      bus.status === "fulfilled"
        ? bus.value
        : { ok: false, alert: false, message: "", error: String(bus.reason) },
  };

  return new Response(JSON.stringify(body), {
    status: body.ok ? 200 : 502,
    headers: corsHeaders(),
  });
});
