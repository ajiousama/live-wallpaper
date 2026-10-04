from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin
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
            mg = re.search(r"【(G\d|F\d)】|開催種別:\s*(G\d|F\d)|グレード:\s*(G\d|F\d)", joined)
            grade = next((x for x in (mg.groups() if mg else ()) if x), "")
            old = keirin.get(venue)
            race_meta = dict((old or {}).get("race_meta", {}))
            rn = re.search(r"【\s*(\d{1,2})\s*[RＲ]\s*】", title)
            if not rn:
                rn = re.search(r"\b(\d{1,2})R\b", title)
            if rn:
                race_no = int(rn.group(1))
                rt = re.search(r"🏷️\s*(.+?)(?:\s*🏆|\s*📢|\s*📅|$)", desc)
                if not rt:
                    pieces = re.findall(r"【([^】]+)】", title)
                    race_type = clean(pieces[1]).replace("🚲","").replace("🏆","").strip() if len(pieces) > 1 else ""
                else:
                    race_type = clean(rt.group(1))
                tm = re.search(r"発走予定:\s*(\d{1,2}:\d{2})", desc)
                race_meta[str(race_no)] = {
                    "name":race_type,
                    "time":tm.group(1) if tm else "",
                }
            em = re.search(r"開催名:\s*(.+?)(?:\s*📅|$)", desc)
            item = {
                "channel":ch, "venue":venue, "type":mt.group(1), "grade":grade,
                "epg_start":start[:12], "epg_stop":p.attrib.get("stop","")[:12],
                "race_meta":race_meta,
                "event_name_epg":clean(em.group(1)) if em else (old or {}).get("event_name_epg",""),
            }
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
            pieces = re.findall(r"【([^】]+)】", title)
            race_name = clean(pieces[1]).replace("🏇","").replace("🏆","").strip() if len(pieces) > 1 else ""
            race = {
                "race":int(rn.group(1)),
                "time":f"{t[:2]}:{t[2:]}",
                "title":title,
                "race_name":race_name,
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

    winner = origin = ""
    for table in soup.find_all("table"):
        if "選手名" not in clean(table):
            continue
        for tr in table.find_all("tr"):
            cells = [clean(x) for x in tr.find_all(["th","td"], recursive=False)]
            if len(cells) < 4 or not re.fullmatch(r"1着", cells[0]):
                continue
            info = cells[3]
            pm = re.search(r"^(.+?)\s+([^\s]+)\s+\d+歳(?:\s+\d+期)?", info)
            if pm:
                winner = pm.group(1).strip()
                origin = pm.group(2).strip()
            else:
                winner = info
            break
        if winner:
            break

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
            "winner":winner,
            "origin":origin,
        }
    return {
        "race":race_no,"time":start,"status":"未確定","order":[],"payout":"",
        "winner":winner,"origin":origin,
    }

def keirin_meta(ymd: str, sched: dict):
    venue = sched["venue"]
    code = KEIRIN_CODES.get(venue)
    if not code:
        return {**sched, "race_ids":[], "event_name":sched.get("event_name_epg",""), "last_time":"", "last_confirmed":False}
    first_id = f"{ymd}{code}01"
    try:
        first = fetch(f"https://keirin.netkeiba.com/race/entry/?race_id={first_id}")
    except Exception:
        return {**sched, "race_ids":[first_id], "event_name":sched.get("event_name_epg",""), "last_time":"", "last_confirmed":False}
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
        "event_name":keirin_event_name(venue, first) or sched.get("event_name_epg",""),
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
                meta = (venue.get("race_meta") or {}).get(str(no), {})
                race["race_name"] = meta.get("name","")
                race["scheduled_time"] = meta.get("time","")
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
        first_time = clean(races[0].get("time","")) if races else ""
        last_time = clean(races[-1].get("time","")) if races else ""
        first_min = hhmm_minutes(first_time)
        last_min = hhmm_minutes(last_time)
        raw_type = clean(info.get("day_type",""))
        if "ミッド" in raw_type or (last_min is not None and last_min >= 23 * 60):
            day_type = "ミッドナイト"
        elif first_min is not None and first_min < 10 * 60:
            day_type = "モーニング"
        elif last_min is not None and last_min >= 18 * 60:
            day_type = "ナイター"
        else:
            day_type = "デイ"
        race_meta = {
            str(int(r.get("rno"))): {
                "name":clean(r.get("race_name","")),
                "time":clean(r.get("time","")),
            }
            for r in races if r.get("rno") is not None
        }
        out.append({
            "name":m.group(2).strip(),
            "code":m.group(1),
            "fallback_event":"",
            "last_time":last_time,
            "day_type":day_type,
            "race_meta":race_meta,
        })
    boat_phase_order = {"モーニング":0,"デイ":1,"ナイター":2,"ミッドナイト":3}
    out.sort(key=lambda x:(boat_phase_order.get(x.get("day_type",""),99), int(x["code"])))
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

def boat_winner_racer(ymd: str, code: str, race_no: int) -> str:
    try:
        soup = BeautifulSoup(
            fetch(f"https://www.boatrace.jp/owpc/pc/race/raceresult?hd={ymd}&jcd={code}&rno={race_no}"),
            "html.parser",
        )
    except Exception:
        return ""
    for tr in soup.find_all("tr"):
        cells = [clean(x) for x in tr.find_all(["th","td"], recursive=False)]
        if len(cells) < 3:
            continue
        if cells[0] not in {"1","１"}:
            continue
        racer = cells[2]
        racer = re.sub(r"^\d{4}\s*", "", racer)
        racer = re.sub(r"\s+", "", racer)
        return racer
    return ""


def boat_results(ymd: str, target: dict, now_minutes: int):
    code = target["code"]
    try:
        html = fetch(f"https://www.boatrace.jp/owpc/pc/race/resultlist?hd={ymd}&jcd={code}")
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return {**target,"event_name":target["fallback_event"],"races":[],"last_time":"","active":True}
    race_types = {}
    for tr in soup.find_all("tr"):
        cells = [clean(x) for x in tr.find_all(["th","td"])]
        if not cells or not re.fullmatch(r"\d{1,2}R", cells[0]):
            continue
        no = int(cells[0][:-1])
        if len(cells) >= 4 and "着" in " ".join(cells[2:]) and not re.search(r"[1-6]\s*[-－]\s*[1-6]", cells[1]):
            race_types[no] = cells[1]

    found = {}
    for tr in soup.find_all("tr"):
        cells = [clean(x) for x in tr.find_all(["th","td"])]
        if len(cells) < 3 or not re.fullmatch(r"\d{1,2}R", cells[0]):
            continue
        no = int(cells[0][:-1])
        combo = re.search(r"([1-6])\s*[-－]\s*([1-6])\s*[-－]\s*([1-6])", cells[1])
        yen = re.search(r"[¥￥]\s*([0-9,]+)", cells[2])
        if not yen:
            yen = re.search(r"([0-9,]+)\s*円", cells[2])
        if combo and yen:
            meta = (target.get("race_meta") or {}).get(str(no), {})
            race_name = race_types.get(no) or meta.get("name","")
            winner = ""
            if "優勝戦" in race_name and "準優勝" not in race_name:
                winner = boat_winner_racer(ymd, code, no)
            found[no] = {
                "race":no,"status":"確定",
                "order":[int(combo.group(1)),int(combo.group(2)),int(combo.group(3))],
                "payout":f"{int(yen.group(1).replace(',','')):,}円",
                "race_name":race_name,
                "scheduled_time":meta.get("time",""),
                "winner":winner,
            }
    last = target.get("last_time","") or boat_last_time(ymd,code)
    final_done = 12 in found
    active = True
    races = []
    for no in range(1,13):
        if no in found:
            races.append(found[no])
        else:
            meta = (target.get("race_meta") or {}).get(str(no), {})
            races.append({
                "race":no,
                "status":"結果待ち" if final_done else "発走前",
                "order":[],
                "payout":"",
                "race_name":race_types.get(no) or meta.get("name",""),
                "scheduled_time":meta.get("time",""),
            })
    return {
        "name":target["name"],"code":code,
        "event_name":boat_event_name(soup,target["fallback_event"]),
        "last_time":last,"active":active,"day_type":target.get("day_type",""),"races":races,
    }

def normalize_nar_course(text: str, venue: str = "") -> str:
    text = clean(text)
    if not text:
        return ""
    m = re.search(r"(芝|ダート|ダ|直)[^0-9]{0,12}([0-9,]{3,5})\s*m", text)
    if m:
        surface = "ダート" if m.group(1) == "ダ" else m.group(1)
        return f"{surface}{m.group(2).replace(',','')}m"
    m = re.search(r"(?:左|右)?\s*([0-9,]{3,5})\s*m", text)
    if m:
        surface = "直" if venue == "帯広" else "ダート"
        return f"{surface}{m.group(1).replace(',','')}m"
    return ""


def nar_course_from_html(html: str, venue: str = "") -> str:
    if not html:
        return ""
    return normalize_nar_course(clean(BeautifulSoup(html, "html.parser")), venue)


def nar_race_meta_map(ymd: str, code: str, venue: str) -> dict[int, dict]:
    url = (
        "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceList"
        f"?k_babaCode={code}&k_raceDate={ymd[:4]}%2F{ymd[4:6]}%2F{ymd[6:]}"
    )
    try:
        soup = BeautifulSoup(fetch(url), "html.parser")
    except Exception:
        return {}
    out: dict[int, dict] = {}
    for tr in soup.find_all("tr"):
        raw_cells = tr.find_all(["th","td"], recursive=False)
        cells = [clean(x) for x in raw_cells]
        if not cells:
            continue
        rm = re.fullmatch(r"(\d{1,2})R", cells[0])
        if not rm:
            continue
        no = int(rm.group(1))
        course = next((normalize_nar_course(x, venue) for x in cells[1:] if normalize_nar_course(x, venue)), "")

        race_name = ""
        race_type = ""
        for a in tr.find_all("a"):
            href = a.get("href","")
            label = clean(a)
            if "RaceMarkTable" in href and label and label not in {"オッズ","映像","成績"}:
                race_name = label
                break
        if len(cells) >= 5:
            race_type = cells[3] if cells[3] not in {"", "変更"} else ""
            race_name = race_name or cells[4]
        full_name = " ".join(x for x in [race_type, race_name] if x).strip()

        # 出走取消・疾病・騎手変更などの変更情報行をレース本体として扱わない。
        notice = bool(re.search(
            r"(出走取消|競走除外|疾病|馬体故障|騎手変更|発走時刻変更|取消|変更)",
            full_name,
        ))
        time_text = "" if notice else next(
            (x for x in cells[1:] if re.fullmatch(r"\d{1,2}:\d{2}", x)),
            "",
        )
        if notice:
            full_name = ""

        current = out.get(no, {})
        # 同じRが複数行ある場合、変更情報よりレース本体の情報を優先してマージ。
        out[no] = {
            "race":no,
            "time":current.get("time") or time_text,
            "race_name":current.get("race_name") or full_name,
            "course":current.get("course") or course,
        }
    return out


def parse_nar_result(html: str, race_no: int):
    soup = BeautifulSoup(html,"html.parser")
    winner = jockey = ""
    full_text = clean(soup)
    course = ""
    cm = re.search(r"(芝|ダート|ダ|直)\s*([0-9,]{3,5})\s*m", full_text)
    if cm:
        surface = "ダート" if cm.group(1) == "ダ" else cm.group(1)
        course = f"{surface}{cm.group(2).replace(',','')}m"
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
        return {"race":race_no,"winner":winner,"jockey":jockey,"trifecta":payout,"order":order,"course":course,"status":"確定"}
    return None

def local_results_for_names(ymd: str, local_epg: list[dict], names: list[str], now_minutes: int):
    by_name = {v["venue"]:v for v in local_epg}
    out = []
    for name in names:
        venue = by_name.get(name)
        if not venue or name not in NAR_CODES:
            continue
        code = NAR_CODES[name]
        nar_meta = nar_race_meta_map(ymd, code, name)
        epg_by_no = {int(r["race"]):r for r in venue.get("races", [])}
        race_nos = sorted(set(epg_by_no) | set(nar_meta))
        races = []
        for no in race_nos:
            r = epg_by_no.get(no, {"race":no,"time":"","race_name":""})
            meta = nar_meta.get(no, {})
            start_time = r.get("time","") or meta.get("time","")
            startm = hhmm_minutes(start_time)
            result = None
            page_html = ""
            try:
                url = (
                    "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable"
                    f"?k_babaCode={code}&k_raceDate={ymd[:4]}%2F{ymd[4:6]}%2F{ymd[6:]}&k_raceNo={no}"
                )
                page_html = fetch(url)
            except Exception:
                page_html = ""
            if now_minutes >= (startm or 9999) and page_html:
                try:
                    result = parse_nar_result(page_html, no)
                except Exception:
                    result = None
            page_course = nar_course_from_html(page_html, name)
            fallback_name = r.get("race_name","") or meta.get("race_name","")
            fallback_course = meta.get("course","")
            fm = re.search(r"(芝|ダート|ダ|直)\s*([0-9,]{3,5})\s*m", fallback_name)
            if fm:
                surface = "ダート" if fm.group(1) == "ダ" else fm.group(1)
                fallback_course = f"{surface}{fm.group(2).replace(',','')}m"
                fallback_name = (fallback_name[:fm.start()] + fallback_name[fm.end():]).strip()
            course_value = fallback_course or page_course
            if result:
                result["race_name"] = fallback_name
                result["scheduled_time"] = start_time
                if not result.get("course"):
                    result["course"] = course_value
                races.append(result)
            else:
                races.append({
                    "race":no,"winner":"","jockey":"","trifecta":"",
                    "race_name":fallback_name,"course":course_value,
                    "scheduled_time":start_time,
                    "status":"結果待ち" if startm is not None and now_minutes >= startm else "発走前"
                })

        times = [hhmm_minutes(x.get("scheduled_time","")) for x in races]
        times = [x for x in times if x is not None]
        first_min = min(times) if times else None
        last_min = max(times) if times else None
        if last_min is not None and last_min >= 23 * 60:
            day_type = "ミッドナイト"
        elif first_min is not None and first_min < 10 * 60:
            day_type = "モーニング"
        elif last_min is not None and last_min >= 18 * 60:
            day_type = "ナイター"
        else:
            day_type = "デイ"
        out.append({"name":name,"code":code,"day_type":day_type,"races":races})
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


def _featured_horses_from_page(url: str, limit: int = 3) -> list[str]:
    try:
        soup = BeautifulSoup(fetch(url), "html.parser")
    except Exception:
        return []
    bad = {
        "出走馬情報","レーストップ","出馬表","調教動画ほか","データ分析",
        "発売情報","レース情報","海外競馬発売","馬券購入情報",
        "血統","主な成績","インタビュー動画","プロフィール","参考レース",
        "関係者情報","調教情報","レース映像","過去の成績",
    }
    out = []
    for h in soup.find_all(["h3","h4"]):
        t = clean(h)
        if not t or t in bad or len(t) > 28:
            continue
        if re.search(r"(情報|メニュー|ポイント|プロフィール|データ)", t):
            continue
        if t not in out:
            out.append(t)
        if len(out) >= limit:
            break
    return out


def win5_today(ymd: str) -> dict:
    targets = []
    mm = str(int(ymd[4:6]))
    dd = str(int(ymd[6:8]))
    try:
        soup = BeautifulSoup(
            fetch("https://www.jra.go.jp/kouza/win5/info/racelist.html"),
            "html.parser",
        )
        for tr in soup.find_all("tr"):
            cells = [clean(x) for x in tr.find_all(["th","td"], recursive=False)]
            if len(cells) < 6:
                continue
            if not re.search(rf"{re.escape(mm)}月\s*{re.escape(dd)}日", cells[0]):
                continue
            for cell in cells[1:]:
                m = re.search(
                    r"(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\s*(\d{1,2})R",
                    cell,
                )
                if m:
                    targets.append({"venue":m.group(1),"race":int(m.group(2))})
            if len(targets) >= 5:
                targets = targets[:5]
                break
    except Exception as exc:
        print(f"[GAMBLE] WIN5 official target failed: {exc}")

    payout = ""
    payout_kind = ""
    try:
        soup = BeautifulSoup(
            fetch(f"https://race.netkeiba.com/top/win5.html?date={ymd}"),
            "html.parser",
        )
        text = clean(soup)
        m = re.search(r"想定払い戻し\s*([0-9,万億]+円)", text)
        if m:
            payout = m.group(1)
            payout_kind = "想定"
        m2 = re.search(r"(?:払戻金|払い戻し)\s*([0-9,万億]+円)", text)
        if m2 and "想定" not in text[max(0,m2.start()-8):m2.start()+4]:
            payout = m2.group(1)
            payout_kind = "確定"
    except Exception as exc:
        print(f"[GAMBLE] WIN5 payout fallback failed: {exc}")

    return {"targets":targets,"payout":payout,"payout_kind":payout_kind}


def featured_races_today(ymd: str, local_epg: list[dict]) -> list[dict]:
    featured: list[dict] = []
    year, mm, dd = ymd[:4], ymd[4:6], ymd[6:8]

    # JRA: each venue's 11R from the official daily programme.
    try:
        cal_url = f"https://www.jra.go.jp/keiba/calendar{year}/{year}/{mm}/{mm}{dd}.html"
        soup = BeautifulSoup(fetch(cal_url), "html.parser")
        for table in soup.find_all("table"):
            head = table.find_previous(["h2","h3"])
            heading = clean(head)
            vm = re.search(r"(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)", heading)
            if not vm:
                continue
            venue = vm.group(1)
            for tr in table.find_all("tr"):
                cells = tr.find_all(["th","td"], recursive=False)
                vals = [clean(x) for x in cells]
                if len(vals) < 3 or not re.search(r"^11(?:レース|R)", vals[0]):
                    continue
                name_cell = cells[1]
                a = name_cell.find("a")
                race_name = clean(a) if a else vals[1]
                race_name = re.sub(r"^第\d+回\s*", "", race_name)
                race_name = re.sub(r"^農林水産省賞典", "", race_name).strip()
                tm = re.search(r"(\d{1,2})時(\d{2})分", vals[-1])
                time_text = f"{int(tm.group(1)):02d}:{tm.group(2)}" if tm else vals[-1]
                horses = []
                if a and a.get("href"):
                    race_url = urljoin(cal_url, a.get("href"))
                    base = race_url.rsplit("/", 1)[0] + "/"
                    horses = _featured_horses_from_page(urljoin(base, "horse.html"))
                featured.append({
                    "source":"JRA","venue":venue,"race":"11R","name":race_name,
                    "time":time_text,"horses":horses,
                })
                break
    except Exception as exc:
        print(f"[GAMBLE] JRA featured failed: {exc}")

    # JRA overseas sales: add today's overseas headline race when present.
    try:
        overseas_url = "https://www.jra.go.jp/keiba/overseas/"
        soup = BeautifulSoup(fetch(overseas_url), "html.parser")
        text = clean(soup)
        date_pat = rf"{int(mm)}月\s*{int(dd)}日"
        if re.search(date_pat, text):
            name = ""
            nm = re.search(r"([^\s]+?)(?:G1|GⅠ)", text)
            if nm:
                name = nm.group(1)
                name = re.sub(r"^\d{4}", "", name)
                name = name.strip("（(【[「『・:：- ")
            tm = re.search(
                rf"発走予定時刻.*?{date_pat}.*?(\d{{1,2}})時(\d{{2}})分",
                text,
            )
            time_text = f"{int(tm.group(1)):02d}:{tm.group(2)}" if tm else ""
            race_link = None
            for a in soup.find_all("a", href=True):
                href = a.get("href","")
                if "/keiba/overseas/race/" in href and href.endswith(("index.html","horse.html")):
                    race_link = urljoin(overseas_url, href)
                    break
            horses = []
            if race_link:
                base = race_link.rsplit("/", 1)[0] + "/"
                horses = _featured_horses_from_page(urljoin(base, "horse.html"))
            if name:
                featured.append({
                    "source":"海外競馬","venue":"海外","race":"",
                    "name":name,"time":time_text,"horses":horses,
                })
    except Exception as exc:
        print(f"[GAMBLE] overseas featured failed: {exc}")

    # Local races: only races explicitly named in Green Channel's local-racing broadcast.
    try:
        gc_url = "https://www.greenchannel.jp/program/racing-chihoukeiba-chukei.html"
        gc_text = clean(BeautifulSoup(fetch(gc_url), "html.parser"))
        gm = re.search(r"《([^》]+)》", gc_text)
        gc_names = []
        if gm:
            gc_names = [clean(x) for x in re.split(r"[、,，]", gm.group(1)) if clean(x)]
        for target in gc_names:
            key = re.sub(r"^[ＪJ]認\s*", "", target).replace(" ", "")
            matched = None
            for venue in local_epg:
                for r in venue.get("races", []):
                    rn = re.sub(r"^[ＪJ]認\s*", "", r.get("race_name","")).replace(" ", "")
                    if key and (key in rn or rn in key):
                        matched = (venue, r)
                        break
                if matched:
                    break
            if not matched:
                continue
            venue, r = matched
            featured.append({
                "source":"GCH地方","venue":venue.get("venue",""),
                "race":f'{r.get("race","")}R',
                "name":target,"time":r.get("time",""),
                "horses":[],
            })
    except Exception as exc:
        print(f"[GAMBLE] GCH featured failed: {exc}")

    # Keep order: JRA domestic -> overseas -> GCH local.
    return featured

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
    featured_races = featured_races_today(ymd, local_epg)
    win5 = win5_today(ymd)

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
        "featured_races":featured_races,
        "win5":win5,
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
        f"keirin={len(phase_venues)} boat={len(boats)} local={len(local_all)}"
    )

if __name__ == "__main__":
    main()
