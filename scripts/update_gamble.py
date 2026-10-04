from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "gamble" / "data.json"
JST = ZoneInfo("Asia/Tokyo")
EPG_URL = "https://raw.githubusercontent.com/ajiousama/himitsu/main/ganble/epg.xml"
BOAT_TODAY_URL = "https://raw.githubusercontent.com/ajiousama/himitsu/main/ganble/boatrace_today.json"

KEIRIN_CODES = {
    "函館":"11","青森":"12","いわき平":"13","弥彦":"21","前橋":"22","取手":"23","宇都宮":"24",
    "大宮":"25","西武園":"26","京王閣":"27","立川":"28","松戸":"31","川崎":"34","平塚":"35",
    "小田原":"36","伊東":"37","静岡":"38","名古屋":"42","岐阜":"43","大垣":"44","豊橋":"45",
    "富山":"46","松阪":"47","四日市":"48","福井":"51","奈良":"53","向日町":"54","和歌山":"55",
    "岸和田":"56","玉野":"61","広島":"62","防府":"63","高松":"71","小松島":"73","高知":"74",
    "松山":"75","小倉":"81","久留米":"83","武雄":"84","佐世保":"85","別府":"86","熊本":"87",
}
NAR_CODES = {
    "帯広":"03","盛岡":"10","水沢":"11","浦和":"18","船橋":"19","大井":"20","川崎":"21",
    "金沢":"22","笠松":"23","名古屋":"24","園田":"27","姫路":"28","高知":"31","佐賀":"32","門別":"36",
}
PHASE_ORDER = ["モーニング","デイ","ナイター","ミッドナイト","オーバーミッドナイト"]

session = requests.Session()
session.headers.update({
    "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
    "Accept-Language":"ja-JP,ja;q=0.9,en;q=0.5",
    "Cache-Control":"no-cache",
})

def fetch(url: str, timeout: int = 18) -> str:
    r = session.get(url, timeout=timeout)
    r.raise_for_status()
    if not r.encoding or r.encoding.lower() == "iso-8859-1":
        r.encoding = r.apparent_encoding or "utf-8"
    return r.text

def clean(v) -> str:
    if v is None:
        return ""
    if hasattr(v, "get_text"):
        v = v.get_text(" ", strip=True)
    return re.sub(r"\s+", " ", str(v)).strip()

def hhmm_minutes(value: str, rollover: bool = False) -> int | None:
    m = re.search(r"(\d{1,2}):(\d{2})", str(value))
    if not m:
        return None
    n = int(m.group(1)) * 60 + int(m.group(2))
    if rollover and n < 6 * 60:
        n += 1440
    return n

def epg_today(ymd: str):
    xml = fetch(EPG_URL)
    root = ET.fromstring(xml)
    channel_names = {
        c.attrib.get("id",""): clean(c.findtext("display-name"))
        for c in root.findall("channel")
    }
    keirin: dict[str, dict] = {}
    local: dict[str, dict] = {}

    for p in root.findall("programme"):
        start = p.attrib.get("start","")
        if not start.startswith(ymd):
            continue
        ch = p.attrib.get("channel","")
        title = clean(p.findtext("title"))
        desc = clean(p.findtext("desc"))
        joined = f"{title} {desc}"

        if ch.startswith("keirin."):
            mt = re.search(r"(オーバーミッドナイト|ミッドナイト|モーニング|ナイター|デイ)", joined)
            if not mt or "終了" in title:
                continue
            venue = re.sub(r"(けいりん|競輪).*$", "", channel_names.get(ch,ch)).strip()
            mg = re.search(r"【(G\d|F\d)】|開催種別:\s*(G\d|F\d)", joined)
            grade = next((x for x in (mg.groups() if mg else ()) if x), "")
            item = {
                "channel":ch, "venue":venue, "type":mt.group(1), "grade":grade,
                "epg_start":start[:12], "epg_stop":p.attrib.get("stop","")[:12],
            }
            old = keirin.get(venue)
            if old is None or item["epg_start"] > old["epg_start"]:
                keirin[venue] = item

        if ch.startswith("chihou."):
            rn = re.search(r"【\s*(\d{1,2})\s*[RＲ]\s*】", title)
            if not rn:
                rn = re.search(r"\b(\d{1,2})R\b", title)
            if not rn:
                continue
            venue = re.sub(r"(けいば|競馬).*$", "", channel_names.get(ch,ch)).strip()
            t = start[8:12]
            race = {
                "race":int(rn.group(1)),
                "time":f"{t[:2]}:{t[2:]}",
                "title":title,
            }
            local.setdefault(venue, {"channel":ch,"venue":venue,"races":[]})["races"].append(race)

    for v in local.values():
        uniq = {r["race"]:r for r in v["races"]}
        v["races"] = [uniq[k] for k in sorted(uniq)]

    return list(keirin.values()), list(local.values())

def keirin_event_name(venue: str, html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    title = clean(soup.title)
    m = re.search(rf"^{re.escape(venue)}競輪\s+(.+?)\s+(?:GIII|GII|GI|FI|FII)\s+\d{{4}}年", title)
    if m:
        return m.group(1).strip()
    return ""

def parse_keirin_result(html: str, race_no: int):
    soup = BeautifulSoup(html, "html.parser")
    text = clean(soup)
    start_m = re.search(r"発走\s*(\d{1,2}:\d{2})", text)
    start = start_m.group(1) if start_m else ""
    m = re.search(
        r"３連単\s*([1-9])\s*[>→\-]\s*([1-9])\s*[>→\-]\s*([1-9])\s*([0-9,]+)円",
        text,
    )
    if not m:
        m = re.search(
            r"3連単\s*([1-9])\s*[>→\-]\s*([1-9])\s*[>→\-]\s*([1-9])\s*([0-9,]+)円",
            text,
        )
    if m:
        return {
            "race":race_no,
            "time":start,
            "status":"確定",
            "order":[int(m.group(1)),int(m.group(2)),int(m.group(3))],
            "payout":f"{int(m.group(4).replace(',','')):,}円",
        }
    return {"race":race_no,"time":start,"status":"未確定","order":[],"payout":""}

def keirin_meta(ymd: str, sched: dict):
    venue = sched["venue"]
    code = KEIRIN_CODES.get(venue)
    if not code:
        return {**sched, "race_ids":[], "event_name":"", "last_time":"", "last_confirmed":False}
    first_id = f"{ymd}{code}01"
    try:
        first = fetch(f"https://keirin.netkeiba.com/race/entry/?race_id={first_id}")
    except Exception:
        return {**sched, "race_ids":[first_id], "event_name":"", "last_time":"", "last_confirmed":False}
    nums = sorted({
        int(x) for x in re.findall(rf"race_id={ymd}{code}(\d{{2}})", first)
        if 1 <= int(x) <= 12
    })
    if not nums:
        nums = list(range(1,13))
    race_ids = [f"{ymd}{code}{n:02d}" for n in nums]
    last_id = race_ids[-1]
    last_time = ""
    try:
        last_entry = fetch(f"https://keirin.netkeiba.com/race/entry/?race_id={last_id}")
        m = re.search(r"発走\s*(\d{1,2}:\d{2})", clean(BeautifulSoup(last_entry,"html.parser")))
        last_time = m.group(1) if m else ""
    except Exception:
        pass
    last_confirmed = False
    try:
        last_result = fetch(f"https://keirin.netkeiba.com/race/result/?race_id={last_id}")
        last_confirmed = bool(parse_keirin_result(last_result, nums[-1]).get("order"))
    except Exception:
        pass
    return {
        **sched, "code":code, "race_ids":race_ids,
        "event_name":keirin_event_name(venue, first),
        "last_time":last_time, "last_confirmed":last_confirmed,
    }

def keirin_venue_end_minutes(v: dict, typ: str) -> int | None:
    lm = hhmm_minutes(v.get("last_time",""), rollover="ミッドナイト" in typ)
    if lm is not None:
        return lm
    stop = v.get("epg_stop","")
    if len(stop) >= 12:
        lm = int(stop[8:10]) * 60 + int(stop[10:12])
        if "ミッドナイト" in typ and lm < 6 * 60:
            lm += 1440
        return lm
    return None

def keirin_venue_expired(v: dict, typ: str, now_minutes: int) -> bool:
    end = keirin_venue_end_minutes(v, typ)
    return bool(v.get("last_confirmed") and end is not None and now_minutes > end + 60)

def choose_keirin_venues(metas: list[dict], now_minutes: int):
    # 全場表示なので終了後1時間の入替は行わない。
    # 本日開催場をモーニング→デイ→ナイター→ミッドナイト順に当日中ずっと残す。
    venues = [
        v for v in metas
        if v.get("type","") in PHASE_ORDER
    ]

    def sort_key(v):
        typ = v.get("type","")
        phase_idx = PHASE_ORDER.index(typ) if typ in PHASE_ORDER else 99
        end = keirin_venue_end_minutes(v, typ)
        return (phase_idx, end if end is not None else 9999, v.get("venue",""))

    venues.sort(key=sort_key)
    end_values = [
        x for x in (keirin_venue_end_minutes(v, v.get("type","")) for v in venues)
        if x is not None
    ]
    group_end = max(end_values) if end_values else None
    return f"本日開催 {len(venues)}場", venues, group_end

def fill_keirin_results(ymd: str, venues: list[dict], now_minutes: int):
    for venue in venues:
        ids = venue.get("race_ids") or []
        jobs = {}
        races = []
        with ThreadPoolExecutor(max_workers=8) as ex:
            for rid in ids:
                no = int(rid[-2:])
                jobs[ex.submit(fetch, f"https://keirin.netkeiba.com/race/result/?race_id={rid}")] = no
            for fut in as_completed(jobs):
                no = jobs[fut]
                try:
                    race = parse_keirin_result(fut.result(), no)
                except Exception:
                    race = {"race":no,"time":"","status":"未確定","order":[],"payout":""}
                rm = hhmm_minutes(race.get("time",""), rollover="ミッドナイト" in venue.get("type",""))
                if not race["order"]:
                    race["status"] = "結果待ち" if rm is not None and now_minutes >= rm else "発走前"
                races.append(race)
        venue["races"] = sorted(races, key=lambda x:x["race"])
        venue["display_name"] = venue["venue"]
    return venues

def boat_targets_today():
    try:
        raw = json.loads(fetch(BOAT_TODAY_URL))
    except Exception:
        return []
    out = []
    for label, info in raw.items():
        if not isinstance(info, dict) or not info.get("held"):
            continue
        m = re.match(r"(\d{2})\s+(.+)", str(label))
        if not m:
            continue
        races = info.get("races") or []
        last_time = clean(races[-1].get("time","")) if races else ""
        out.append({
            "name":m.group(2).strip(),
            "code":m.group(1),
            "fallback_event":"",
            "last_time":last_time,
            "day_type":clean(info.get("day_type","")),
        })
    out.sort(key=lambda x:int(x["code"]))
    return out

def boat_event_name(soup: BeautifulSoup, fallback: str) -> str:
    for h in soup.find_all(["h1","h2","h3"]):
        t = clean(h)
        if t and not re.search(r"結果一覧|勝式|払戻|レース一覧", t):
            if len(t) >= 4:
                return t
    return fallback

def boat_last_time(ymd: str, code: str) -> str:
    try:
        html = fetch(f"https://www.boatrace.jp/owpc/pc/race/raceresult?hd={ymd}&jcd={code}&rno=12")
        soup = BeautifulSoup(html,"html.parser")
        for tr in soup.find_all("tr"):
            t = clean(tr)
            if "締切予定時刻" in t:
                times = re.findall(r"\b\d{1,2}:\d{2}\b", t)
                if times:
                    return times[-1]
    except Exception:
        pass
    return ""

def boat_results(ymd: str, target: dict, now_minutes: int):
    code = target["code"]
    try:
        html = fetch(f"https://www.boatrace.jp/owpc/pc/race/resultlist?hd={ymd}&jcd={code}")
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return {**target,"event_name":target["fallback_event"],"races":[],"last_time":"","active":True}
    found = {}
    for tr in soup.find_all("tr"):
        cells = [clean(x) for x in tr.find_all(["th","td"])]
        if not cells or not re.fullmatch(r"\d{1,2}R", cells[0]):
            continue
        no = int(cells[0][:-1])
        joined = " | ".join(cells[1:4])
        combo = re.search(r"([1-6])\s*[-－]\s*([1-6])\s*[-－]\s*([1-6])", joined)
        yen = re.search(r"[¥￥]?\s*([0-9,]+)\s*円?", joined)
        if combo and yen:
            found[no] = {
                "race":no,"status":"確定",
                "order":[int(combo.group(1)),int(combo.group(2)),int(combo.group(3))],
                "payout":f"{int(yen.group(1).replace(',','')):,}円",
            }
    last = target.get("last_time","") or boat_last_time(ymd,code)
    final_done = 12 in found
    active = True
    races = []
    for no in range(1,13):
        if no in found:
            races.append(found[no])
        else:
            races.append({"race":no,"status":"結果待ち" if final_done else "発走前","order":[],"payout":""})
    return {
        "name":target["name"],"code":code,
        "event_name":boat_event_name(soup,target["fallback_event"]),
        "last_time":last,"active":active,"day_type":target.get("day_type",""),"races":races,
    }

def parse_nar_result(html: str, race_no: int):
    soup = BeautifulSoup(html,"html.parser")
    winner = jockey = ""
    for table in soup.find_all("table"):
        header = clean(table)
        if "着順" not in header or "馬名" not in header or "騎手" not in header:
            continue
        for tr in table.find_all("tr"):
            cells = [clean(x) for x in tr.find_all("td", recursive=False)]
            if len(cells) >= 8 and re.fullmatch(r"1", cells[0]):
                winner = cells[3]
                jockey = re.sub(r"\s*（.*?）\s*$","",cells[7]).strip()
                break
        if winner:
            break
    payout = ""
    order = []
    for tr in soup.find_all("tr"):
        cells = [clean(x) for x in tr.find_all(["th","td"], recursive=False)]
        if not cells:
            continue
        if re.search(r"(三連単|3連単|三連勝単式)", cells[0]):
            text = " ".join(cells[1:])
            c = re.search(r"([0-9]+)\s*[-→－]\s*([0-9]+)\s*[-→－]\s*([0-9]+)", text)
            y = re.search(r"([0-9,]+)\s*円", text)
            if c:
                order=[int(c.group(1)),int(c.group(2)),int(c.group(3))]
            if y:
                payout=f"{int(y.group(1).replace(',','')):,}円"
            break
    if winner:
        return {"race":race_no,"winner":winner,"jockey":jockey,"trifecta":payout,"order":order,"status":"確定"}
    return None

def local_results_for_names(ymd: str, local_epg: list[dict], names: list[str], now_minutes: int):
    by_name = {v["venue"]:v for v in local_epg}
    out = []
    for name in names:
        venue = by_name.get(name)
        if not venue or name not in NAR_CODES:
            continue
        code = NAR_CODES[name]
        races = []
        for r in venue["races"]:
            no = r["race"]
            startm = hhmm_minutes(r["time"])
            result = None
            if now_minutes >= (startm or 9999):
                try:
                    url = (
                        "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable"
                        f"?k_babaCode={code}&k_raceDate={ymd[:4]}%2F{ymd[4:6]}%2F{ymd[6:]}&k_raceNo={no}"
                    )
                    result = parse_nar_result(fetch(url), no)
                except Exception:
                    result = None
            races.append(result or {
                "race":no,"winner":"","jockey":"","trifecta":"",
                "status":"結果待ち" if startm is not None and now_minutes >= startm else "発走前"
            })
        out.append({"name":name,"code":code,"races":races})
    return out

def local_night_results(ymd: str, local_epg: list[dict], now_minutes: int):
    candidates = []
    for venue in local_epg:
        starts = [hhmm_minutes(r.get("time","")) for r in venue["races"]]
        starts = [x for x in starts if x is not None]
        if not starts or max(starts) < 17*60:
            continue
        if venue["venue"] not in NAR_CODES:
            continue
        candidates.append(venue)
    candidates.sort(key=lambda v:max(hhmm_minutes(r["time"]) or 0 for r in v["races"]), reverse=True)
    out = []
    for venue in candidates[:3]:
        code = NAR_CODES[venue["venue"]]
        races=[]
        for r in venue["races"]:
            no=r["race"]
            startm=hhmm_minutes(r["time"])
            result=None
            if now_minutes >= (startm or 9999):
                try:
                    url=(
                        "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable"
                        f"?k_babaCode={code}&k_raceDate={ymd[:4]}%2F{ymd[4:6]}%2F{ymd[6:]}&k_raceNo={no}"
                    )
                    result=parse_nar_result(fetch(url),no)
                except Exception:
                    result=None
            races.append(result or {
                "race":no,"winner":"","jockey":"","trifecta":"",
                "status":"結果待ち" if startm is not None and now_minutes >= startm else "発走前"
            })
        out.append({"name":venue["venue"],"code":code,"races":races})
    return out

def main():
    now = datetime.now(JST)
    ymd = now.strftime("%Y%m%d")
    now_minutes = now.hour*60+now.minute
    if now.hour < 5:
        now_minutes += 1440

    try:
        keirin_sched, local_epg = epg_today(ymd)
    except Exception as exc:
        print(f"[GAMBLE] EPG failed: {exc}")
        keirin_sched, local_epg = [], []

    metas=[]
    with ThreadPoolExecutor(max_workers=8) as ex:
        jobs={ex.submit(keirin_meta,ymd,x):x for x in keirin_sched}
        for fut in as_completed(jobs):
            try:
                metas.append(fut.result())
            except Exception:
                metas.append(jobs[fut])

    phase, phase_venues, phase_end = choose_keirin_venues(metas,now_minutes)
    phase_venues = fill_keirin_results(ymd, phase_venues, now_minutes) if phase_venues else []

    boats=[]
    boat_targets = boat_targets_today()
    with ThreadPoolExecutor(max_workers=min(8,max(1,len(boat_targets)))) as ex:
        jobs=[ex.submit(boat_results,ymd,x,now_minutes) for x in boat_targets]
        for fut in jobs:
            try:
                boats.append(fut.result())
            except Exception:
                pass

    local_names = [v["venue"] for v in local_epg if v.get("venue") in NAR_CODES]
    local_all = local_results_for_names(ymd, local_epg, local_names, now_minutes)

    payload = {
        "date":now.strftime("%Y-%m-%d"),
        "date_label":now.strftime("%Y年%m月%d日"),
        "updated_at":now.strftime("%H:%M:%S"),
        "updated_at_iso":now.isoformat(),
        "jra_switch_time":"17:00",
        "keirin":{
            "phase":phase,
            "phase_end_minutes":phase_end,
            "venues":phase_venues,
        },
        "boats":boats,
        "local_all":{"venues":local_all},
        "source":{
            "schedule":"Free WiFi EPG",
            "keirin":"netkeirin / EPG",
            "boat":"BOAT RACE公式",
            "local":"地方競馬全国協会",
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(
        f"[GAMBLE] {ymd} phase={phase or '-'} "
        f"keirin={len(phase_venues)} boat={len(boats)} local={len(local_night)}"
    )

if __name__ == "__main__":
    main()
