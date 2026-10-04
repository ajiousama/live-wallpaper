from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

BASE = "https://www.jra.go.jp"
MOBILE_BASE = "https://sp.jra.jp"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "jra" / "data.json"
JST = ZoneInfo("Asia/Tokyo")

VENUES = {
    "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
    "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
}
VENUE_ORDER = ["中山", "阪神", "東京", "京都", "中京", "新潟", "福島", "小倉", "札幌", "函館"]
WEEKDAY = ["月曜", "火曜", "水曜", "木曜", "金曜", "土曜", "日曜"]
PAYOUT_ORDER = ["単勝", "複勝", "枠連", "馬連", "馬単", "ワイド", "3連複", "3連単"]

ACTION_RE = re.compile(
    r"doAction\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]",
    re.I,
)
SRL_RE = re.compile(
    r"pw01srl10(?P<venue>\d{2})(?P<year>\d{4})(?P<meet>\d{2})(?P<day>\d{2})(?P<ymd>\d{8})/(?P<cd>[0-9A-Fa-f]{2})"
)
SDE_RE = re.compile(
    r"pw01sde(?:10|01)(?P<venue>\d{2})(?P<year>\d{4})(?P<meet>\d{2})(?P<day>\d{2})(?P<race>\d{2})(?P<ymd>\d{8})/(?P<cd>[0-9A-Fa-f]{2})"
)
DDE_PUBLIC_RE = re.compile(
    r"pw01dde01(?P<venue>\d{2})(?P<year>\d{4})(?P<meet>\d{2})(?P<day>\d{2})(?P<race>\d{2})(?P<ymd>\d{8})/(?P<cd>[0-9A-Fa-f]{2})"
)
HDE_PUBLIC_RE = re.compile(
    r"pw01hde01(?P<venue>\d{2})(?P<year>\d{4})(?P<meet>\d{2})(?P<day>\d{2})(?P<ymd>\d{8})/(?P<cd>[0-9A-Fa-f]{2})"
)


session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; MatsuyamaLiveWallpaper/1.0; +https://github.com/ajiousama/live-wallpaper)",
    "Accept-Language": "ja,en;q=0.7",
    "Cache-Control": "no-cache",
})


def request(method: str, url: str, **kwargs) -> requests.Response:
    last = None
    for attempt in range(3):
        try:
            r = session.request(method, url, timeout=20, **kwargs)
            r.raise_for_status()
            return r
        except requests.RequestException as exc:
            last = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"JRA request failed: {url}: {last}")


def soup_get(url: str) -> BeautifulSoup:
    return BeautifulSoup(request("GET", url).content, "html.parser")


def soup_action(path: str, cname: str) -> BeautifulSoup:
    r = request(
        "POST",
        urljoin(BASE, path),
        data={"cname": cname},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    return BeautifulSoup(r.content, "html.parser")


def soup_cname_get(path: str, cname: str) -> BeautifulSoup:
    r = request("GET", urljoin(BASE, path), params={"CNAME": cname})
    return BeautifulSoup(r.content, "html.parser")


def page_title(soup: BeautifulSoup) -> str:
    return soup.title.get_text(" ", strip=True) if soup.title else ""


def extract_links(soup: BeautifulSoup, token: str) -> list[dict]:
    found: list[dict] = []
    seen: set[str] = set()

    for a in soup.find_all("a"):
        raw = str(a)
        if token not in raw:
            continue

        onclick = a.get("onclick") or a.get("onClick") or ""
        m = ACTION_RE.search(onclick)
        if m and token in m.group(2):
            key = "POST|" + m.group(1) + "|" + m.group(2)
            if key not in seen:
                seen.add(key)
                found.append({"kind": "post", "path": m.group(1), "cname": m.group(2)})
            continue

        href = a.get("href") or ""
        if token in href:
            absolute = urljoin(BASE, href)
            key = "GET|" + absolute
            if key not in seen:
                seen.add(key)
                found.append({"kind": "get", "url": absolute})

    return found


def link_cname(link: dict) -> str:
    if link["kind"] in ("post", "cname_get"):
        return link["cname"]
    query = parse_qs(urlparse(link["url"]).query)
    return query.get("CNAME", query.get("cname", [""]))[0]


def fetch_link(link: dict) -> BeautifulSoup:
    if link["kind"] == "post":
        return soup_action(link["path"], link["cname"])
    if link["kind"] == "cname_get":
        return soup_cname_get(link["path"], link["cname"])
    return soup_get(link["url"])


def cname_hits(html: str, prefix: str) -> list[str]:
    pattern = re.compile(re.escape(prefix) + r"[^'\"<>\s)]+")
    return sorted(set(pattern.findall(html)))


def parse_srl(link: dict) -> dict | None:
    cname = link_cname(link)
    m = SRL_RE.search(cname)
    if not m:
        return None
    g = m.groupdict()
    return {
        "link": link,
        "cname": cname,
        "venue_code": g["venue"],
        "venue": VENUES.get(g["venue"], g["venue"]),
        "ymd": g["ymd"],
    }


def parse_sde(link: dict) -> dict | None:
    cname = link_cname(link)
    m = SDE_RE.search(cname)
    if not m:
        return None
    g = m.groupdict()
    return {
        "link": link,
        "cname": cname,
        "venue_code": g["venue"],
        "venue": VENUES.get(g["venue"], g["venue"]),
        "year": g["year"],
        "meet": g["meet"],
        "day": g["day"],
        "race": int(g["race"]),
        "ymd": g["ymd"],
    }


def parse_dde(cname: str) -> dict | None:
    m = DDE_PUBLIC_RE.search(cname)
    if not m:
        return None
    g = m.groupdict()
    return {
        "cname": cname,
        "venue_code": g["venue"],
        "venue": VENUES.get(g["venue"], g["venue"]),
        "year": g["year"],
        "meet": g["meet"],
        "day": g["day"],
        "race": int(g["race"]),
        "ymd": g["ymd"],
    }


def mobile_result_cname(link: dict) -> str | None:
    cname = link_cname(link)
    m = re.fullmatch(r"pw01sde10(.+)/([0-9A-Fa-f]{2})", cname)
    if not m:
        return None
    body, cd = m.groups()
    mobile_cd = (int(cd, 16) + 0xAE) & 0xFF
    return f"sw01sde01{body}/{mobile_cd:02X}"


def soup_mobile_result(link: dict) -> BeautifulSoup | None:
    cname = mobile_result_cname(link)
    if not cname:
        return None
    r = request("GET", MOBILE_BASE + "/JRADB/accessS.html", params={"CNAME": cname})
    soup = BeautifulSoup(r.content, "html.parser")
    if "param_error" in soup.get_text(" ", strip=True):
        return None
    return soup


def discover_today_meetings(today: str) -> list[dict]:
    """
    Discover today's live race pages from official JRA pages.

    The JRA top page can stop exposing the current day's race links after the
    final race. Therefore, use the date-specific official programme page first
    and the top page only as an additional source. This prevents a Sunday
    evening refresh from falling back to Saturday's completed results.
    """
    year, mm, dd = today[:4], today[4:6], today[6:8]
    seed_html: list[str] = []

    calendar_url = (
        f"{BASE}/keiba/calendar{year}/{year}/{mm}/{mm}{dd}.html"
    )
    try:
        seed_html.append(request("GET", calendar_url).text)
    except Exception as exc:
        print(f"[JRA] current-day calendar fetch failed: {exc}", file=sys.stderr)

    try:
        seed_html.append(request("GET", BASE + "/").text)
    except Exception as exc:
        print(f"[JRA] current-day top fetch failed: {exc}", file=sys.stderr)

    seeds: set[str] = set()
    for html in seed_html:
        seeds.update(cname_hits(html, "pw01dde01"))

    first_hop: set[str] = set(seeds)
    for cname in list(seeds)[:12]:
        meta = parse_dde(cname)
        if meta and meta["ymd"] != today:
            continue
        try:
            html = request(
                "GET",
                BASE + "/JRADB/accessD.html",
                params={"CNAME": cname},
            ).text
            first_hop.update(cname_hits(html, "pw01dde01"))
        except Exception:
            continue

    today_seed_meta = [
        x for x in (parse_dde(c) for c in first_hop)
        if x and x["ymd"] == today
    ]
    if not today_seed_meta:
        print(
            f"[JRA] no current-day race links found for {today}; "
            "do not silently treat yesterday as today",
            file=sys.stderr,
        )
        return []

    # Pick one valid current-day page per venue, then use its race selector
    # to discover all 12 race pages for that venue.
    by_venue: dict[str, dict] = {}
    for meta in today_seed_meta:
        old = by_venue.get(meta["venue_code"])
        if old is None or meta["race"] == 11:
            by_venue[meta["venue_code"]] = meta

    meetings: list[dict] = []
    for venue_code, seed in by_venue.items():
        race_pages: dict[int, dict] = {}
        try:
            html = request(
                "GET",
                BASE + "/JRADB/accessD.html",
                params={"CNAME": seed["cname"]},
            ).text
            hits = cname_hits(html, "pw01dde01")
        except Exception as exc:
            print(f"[JRA] {seed['venue']} current race menu failed: {exc}", file=sys.stderr)
            hits = [seed["cname"]]

        for cname in hits + [seed["cname"]]:
            meta = parse_dde(cname)
            if not meta:
                continue
            if (
                meta["ymd"] != today
                or meta["venue_code"] != venue_code
                or meta["meet"] != seed["meet"]
                or meta["day"] != seed["day"]
            ):
                continue
            race_pages[meta["race"]] = meta

        meetings.append({
            "venue_code": venue_code,
            "venue": seed["venue"],
            "ymd": today,
            "race_pages": [race_pages[r] for r in sorted(race_pages)],
        })

    meetings.sort(
        key=lambda m: VENUE_ORDER.index(m["venue"]) if m["venue"] in VENUE_ORDER else 999
    )
    if meetings:
        print(
            "[JRA] current-day race menus: "
            + ", ".join(f"{m['venue']}({len(m['race_pages'])}R)" for m in meetings)
        )
    return meetings


def current_result_link(race_page: dict) -> dict | None:
    """Return the public accessS result link only after this race is confirmed."""
    try:
        html = request(
            "GET",
            BASE + "/JRADB/accessD.html",
            params={"CNAME": race_page["cname"]},
        ).text
    except Exception:
        return None

    candidates: list[tuple[int, str]] = []
    for cname in cname_hits(html, "pw01sde"):
        m = SDE_RE.search(cname)
        if not m:
            continue
        g = m.groupdict()
        if (
            g["venue"] == race_page["venue_code"]
            and g["year"] == race_page["year"]
            and g["meet"] == race_page["meet"]
            and g["day"] == race_page["day"]
            and int(g["race"]) == race_page["race"]
            and g["ymd"] == race_page["ymd"]
        ):
            # Prefer the public pw01sde01 form because it includes payouts.
            candidates.append((0 if cname.startswith("pw01sde01") else 1, cname))

    if not candidates:
        return None
    cname = sorted(candidates)[0][1]
    return {"kind": "cname_get", "path": "/JRADB/accessS.html", "cname": cname}


def normalize_course_text(text: str) -> str:
    if not text:
        return ""
    # JRA標準: コース：1,800メートル（ダート・右）
    m = re.search(r"([0-9,]{3,5})\s*(?:m|メートル).*?[（(](芝|ダート|ダ|障害)", text)
    if m:
        surface = "ダート" if m.group(2) == "ダ" else m.group(2)
        return f"{surface}{m.group(1).replace(',','')}m"
    # 念のため逆順表記にも対応
    m = re.search(r"(芝|ダート|ダ|障害)[^0-9]{0,16}([0-9,]{3,5})\s*(?:m|メートル)", text)
    if m:
        surface = "ダート" if m.group(1) == "ダ" else m.group(1)
        return f"{surface}{m.group(2).replace(',','')}m"
    return ""


def _clean_prerace_name(value: str) -> str:
    value = re.sub(r"\s+", " ", value or "").strip()
    value = re.sub(r"^\d{1,2}R\s*", "", value)
    value = re.sub(r"\s*(?:出馬表|オッズ|予想|結果).*$", "", value).strip()
    if len(value) > 60:
        return ""
    if value in {"", "出馬表", "レース情報", "JRA", "netkeiba"}:
        return ""
    return value


def _race_name_from_soup(soup: BeautifulSoup) -> str:
    for tag in soup.find_all(class_=re.compile(r"(?:RaceName|race[_-]?name)", re.I)):
        name = _clean_prerace_name(clean_text(tag))
        if name:
            return name
    for tag in soup.find_all(["h1","h2","h3"]):
        name = _clean_prerace_name(clean_text(tag))
        if name and not re.search(r"(開催|出馬表|レース一覧|競馬場|本日の)", name):
            return name
    title = page_title(soup)
    if title:
        name = _clean_prerace_name(re.split(r"[｜|]", title)[0])
        if name and not re.search(r"(JRA|netkeiba|出馬表)", name):
            return name
    return ""


def netkeiba_race_meta(race_page: dict) -> dict:
    race_id = (
        f'{race_page.get("year","")}{race_page.get("venue_code","")}'
        f'{race_page.get("meet","")}{race_page.get("day","")}'
        f'{int(race_page.get("race",0)):02d}'
    )
    if len(race_id) != 12:
        return {"race_name":"","course":""}
    try:
        soup = soup_get(
            "https://race.netkeiba.com/race/shutuba.html?race_id=" + race_id
        )
    except Exception:
        return {"race_name":"","course":""}
    text = clean_text(soup)
    course = normalize_course_text(text)
    if not course:
        m = re.search(r"(芝|ダート|ダ|障害)\s*([0-9,]{3,5})\s*m", text)
        if m:
            surface = "ダート" if m.group(1) == "ダ" else m.group(1)
            course = f"{surface}{m.group(2).replace(',','')}m"
    return {"race_name":_race_name_from_soup(soup),"course":course}


def current_race_meta(race_page: dict) -> dict:
    name = course = ""
    try:
        soup = soup_cname_get("/JRADB/accessD.html", race_page["cname"])
        text = clean_text(soup)
        course = normalize_course_text(text)
        name = _race_name_from_soup(soup)
    except Exception:
        pass

    if not name or not course:
        fallback = netkeiba_race_meta(race_page)
        name = name or fallback.get("race_name","")
        course = course or fallback.get("course","")
    return {"race_name":name,"course":course}


def discover_historical_landing() -> BeautifulSoup:
    try:
        soup = soup_action("/JRADB/accessS.html", "pw01sli00/AF")
        if extract_links(soup, "pw01srl"):
            return soup
    except Exception as exc:
        print(f"[JRA] historical result menu failed: {exc}", file=sys.stderr)
    raise RuntimeError("JRAのレース結果開催選択ページを取得できませんでした")



def payout_items_from_dl(dl) -> list[dict]:
    # accessH may render the yen unit in a separate span, so parse the
    # visible DL text instead of relying on individual <p> boundaries.
    text = clean_text(dl)
    label_node = dl.find("strong") or dl.find("dt")
    label = clean_text(label_node)
    if label and text.startswith(label):
        text = text[len(label):].strip()

    pairs = re.findall(
        r"(?<![0-9])([0-9]+(?:[-→][0-9]+)*)\s+([0-9,]+)\s*円",
        text,
    )
    return [
        {"combo": combo, "amount": amount + "円"}
        for combo, amount in pairs
    ]


def discover_today_payouts(today: str) -> dict[str, dict[int, dict[str, list[dict]]]]:
    """
    JRA's accessH payout page is the reliable current-day payout source.
    One current hde page exists per venue/day and contains completed races
    in race order, each with the standard eight bet types.
    """
    result: dict[str, dict[int, dict[str, list[dict]]]] = {}

    try:
        menu = soup_action("/JRADB/accessH.html", "pw01hli00/03")
    except Exception as exc:
        print(f"[JRA] payout menu failed: {exc}", file=sys.stderr)
        return result

    hits = cname_hits(str(menu), "pw01hde01")
    current: list[tuple[dict, str]] = []
    for cname in hits:
        m = HDE_PUBLIC_RE.search(cname)
        if not m:
            continue
        g = m.groupdict()
        if g["ymd"] != today:
            continue
        current.append((g, cname))

    for meta, cname in current:
        venue = VENUES.get(meta["venue"], meta["venue"])
        try:
            detail = soup_action("/JRADB/accessH.html", cname)
        except Exception as exc:
            print(f"[JRA] {venue} payout detail failed: {exc}", file=sys.stderr)
            continue

        race_map: dict[int, dict[str, list[dict]]] = {}
        race_no = 0
        current_race: dict[str, list[dict]] | None = None

        for dl in detail.find_all("dl"):
            label_node = dl.find("strong") or dl.find("dt")
            label = clean_text(label_node)
            if label not in PAYOUT_ORDER:
                continue

            if label == "単勝":
                race_no += 1
                current_race = {k: [] for k in PAYOUT_ORDER}
                race_map[race_no] = current_race

            if current_race is None:
                continue

            current_race[label] = payout_items_from_dl(dl)

        if race_map:
            result[venue] = race_map
            print(
                f"[JRA] {venue} payouts: "
                + ", ".join(
                    f"{r}R" for r, p in race_map.items()
                    if p.get("単勝") and p.get("3連単")
                )
            )

    return result

def clean_text(node) -> str:
    if not node:
        return ""
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()


def cell_frame(cell) -> str:
    text = clean_text(cell)
    if text:
        return text
    img = cell.find("img") if cell else None
    if img:
        return (img.get("alt") or img.get("title") or "").strip()
    return ""


def payout_items(soup: BeautifulSoup, label: str) -> list[dict]:
    for tag in soup.find_all(["strong", "dt", "th", "td"]):
        if clean_text(tag) != label:
            continue
        dl = tag.find_parent("dl")
        if not dl:
            continue

        dd = dl.find("dd") or dl
        tokens = [clean_text(p) for p in dd.find_all("p")]
        tokens = [t for t in tokens if t and "人気" not in t]
        items: list[dict] = []
        pending_combo = None
        for raw in tokens:
            token = re.sub(r"\\s+", "", raw)
            if "番人気" in token:
                continue
            if re.fullmatch(r"[0-9,]+円", token):
                if pending_combo is not None:
                    items.append({"combo": pending_combo, "amount": token})
                    pending_combo = None
                continue
            if re.fullmatch(r"[0-9]+(?:[-→][0-9]+)*", token):
                pending_combo = token
        if items:
            return items

    text = clean_text(soup)
    payout_pos = text.find("払戻金")
    if payout_pos >= 0:
        text = text[payout_pos:]
    label_pos = text.find(label)
    if label_pos < 0:
        return []

    segment = text[label_pos + len(label):]
    later_labels = PAYOUT_ORDER[PAYOUT_ORDER.index(label) + 1:]
    end_positions = [segment.find(x) for x in later_labels if segment.find(x) >= 0]
    for stop_word in ("勝馬の紹介", "競走中の出来事", "・勝馬投票"):
        p = segment.find(stop_word)
        if p >= 0:
            end_positions.append(p)
    if end_positions:
        segment = segment[:min(end_positions)]

    pairs = re.findall(
        r"(?<![0-9])([0-9]+(?:[-→][0-9]+)*)\s+([0-9,]+円)",
        segment,
    )
    return [{"combo": combo, "amount": amount} for combo, amount in pairs]


def result_from_result_page(soup: BeautifulSoup) -> dict | None:
    if "パラメータエラー" in page_title(soup):
        return None

    result_table = None
    for table in soup.find_all("table"):
        header_text = clean_text(table)
        if "着順" in header_text and "騎手名" in header_text and "馬名" in header_text:
            result_table = table
            break
    if not result_table:
        return None

    top3: list[dict] = []
    tbody = result_table.find("tbody")
    for row in (tbody.find_all("tr", recursive=False) if tbody else []):
        cells = row.find_all("td", recursive=False)
        if len(cells) < 9:
            continue
        rank_text = clean_text(cells[0])
        m = re.match(r"([123])", rank_text)
        if not m:
            continue

        horse_link = cells[3].find("a")
        jockey_link = cells[6].find("a")
        top3.append({
            "position": int(m.group(1)),
            "frame": cell_frame(cells[1]),
            "number": clean_text(cells[2]),
            "horse": clean_text(horse_link or cells[3]),
            "jockey": clean_text(jockey_link or cells[6]),
            "time": clean_text(cells[7]),
            "margin": clean_text(cells[8]),
        })
        if len(top3) >= 3:
            break

    if len(top3) < 3:
        return None

    caption = result_table.find("caption")
    race_name = ""
    course = ""
    if caption:
        h2 = caption.find("h2")
        race_name = clean_text(h2)
        for node in caption.find_all(["p", "li", "span"]):
            t = clean_text(node)
            if "コース：" in t or "コース:" in t:
                raw_course = re.sub(r"^.*?コース[:：]\s*", "", t).strip()
                course = normalize_course_text(raw_course)
                break

    if not course:
        course = normalize_course_text(clean_text(soup))

    payouts = {label: payout_items(soup, label) for label in PAYOUT_ORDER}
    winner = top3[0]
    return {
        "race_name": race_name,
        "course": course,
        "top3": top3,
        "payouts": payouts,
        "jockey": winner.get("jockey", ""),
        "horse": winner.get("horse", ""),
        "win_payout": (payouts["単勝"][0]["amount"] if payouts["単勝"] else None),
    }


def load_existing() -> dict:
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return {}


def normalize_existing(existing: dict, ymd: str, venue_names: list[str]) -> dict:
    if existing.get("source_date") != ymd:
        return {
            "source": "JRA公式",
            "source_date": ymd,
            "date_label": "",
            "updated_at": "",
            "venues": [{"name": name, "results": []} for name in venue_names],
        }

    by_name = {v.get("name"): v for v in existing.get("venues", [])}
    venues = []
    for name in venue_names:
        old = by_name.get(name, {"name": name, "results": []})
        old_results = sorted(old.get("results", []), key=lambda x: int(x.get("race", 0)))
        venues.append({"name": name, "results": old_results})

    existing["venues"] = venues
    existing["source"] = "JRA公式"
    existing["source_date"] = ymd
    return existing


def race_is_complete(race: dict) -> bool:
    payouts = race.get("payouts", {})
    return (
        len(race.get("top3", [])) >= 3
        and all(k in payouts for k in PAYOUT_ORDER)
        and all(payouts.get(k) for k in ("単勝", "複勝", "3連単"))
    )


def main() -> None:
    now = datetime.now(JST)
    today = now.strftime("%Y%m%d")

    current_payouts = discover_today_payouts(today)
    current_meetings = discover_today_meetings(today)
    mode = "current" if current_meetings else "historical"

    if current_meetings:
        selected_ymd = today
        selected = current_meetings
    else:
        landing = discover_historical_landing()
        srl_meta = [x for x in (parse_srl(l) for l in extract_links(landing, "pw01srl")) if x]
        if not srl_meta:
            raise RuntimeError("JRA開催リンク(pw01srl)が見つかりません")

        available_dates = sorted({x["ymd"] for x in srl_meta if x["ymd"] <= today})
        if not available_dates:
            available_dates = sorted({x["ymd"] for x in srl_meta})
        selected_ymd = available_dates[-1]

        # A historical fallback is allowed for genuine non-racing days only.
        # If today's official programme page exists and names a JRA venue,
        # refusing yesterday's date is safer than displaying stale results.
        if selected_ymd != today:
            try:
                y, m, d = today[:4], today[4:6], today[6:8]
                cal = clean_text(
                    soup_get(f"{BASE}/keiba/calendar{y}/{y}/{m}/{m}{d}.html")
                )
                if re.search(
                    r"(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\d*日",
                    cal,
                ):
                    raise RuntimeError(
                        f"JRA当日開催({today})を確認したため、"
                        f"前日データ({selected_ymd})へのフォールバックを停止"
                    )
            except RuntimeError:
                raise
            except Exception:
                pass

        selected = []
        seen_venue = set()
        for x in srl_meta:
            if x["ymd"] != selected_ymd or x["venue_code"] in seen_venue:
                continue
            seen_venue.add(x["venue_code"])
            selected.append(x)

    selected.sort(
        key=lambda m: VENUE_ORDER.index(m["venue"]) if m["venue"] in VENUE_ORDER else 999
    )
    selected = selected[:3]
    venue_names = [x["venue"] for x in selected]

    existing = load_existing()
    data = normalize_existing(existing, selected_ymd, venue_names)

    d = datetime.strptime(selected_ymd, "%Y%m%d").date()
    data["date_label"] = f"{d.month}月{d.day}日 {WEEKDAY[d.weekday()]}"

    result_map = {
        v["name"]: {int(r["race"]): r for r in v.get("results", [])}
        for v in data["venues"]
    }
    changed = (
        existing.get("source_date") != selected_ymd
        or [v.get("name") for v in existing.get("venues", [])] != venue_names
    )

    for meet in selected:
        venue_results = result_map.setdefault(meet["venue"], {})

        if mode == "current":
            race_candidates = meet.get("race_pages", [])
        else:
            meet_soup = fetch_link(meet["link"])
            race_candidates = [
                x for x in (parse_sde(l) for l in extract_links(meet_soup, "pw01sde")) if x
            ]
            race_candidates = [
                x for x in race_candidates
                if x["ymd"] == selected_ymd and x["venue_code"] == meet["venue_code"]
            ]

        for race_meta in sorted(race_candidates, key=lambda x: x["race"]):
            race_no = race_meta["race"]
            existing_race = venue_results.get(race_no, {})

            if mode == "current" and (
                not existing_race.get("course") or not existing_race.get("race_name")
            ):
                prerace = current_race_meta(race_meta)
                seeded = {**existing_race, "race": race_no}
                if not seeded.get("course") and prerace.get("course"):
                    seeded["course"] = prerace["course"]
                if not seeded.get("race_name") and prerace.get("race_name"):
                    seeded["race_name"] = prerace["race_name"]
                if seeded != existing_race:
                    existing_race = seeded
                    venue_results[race_no] = existing_race
                    changed = True

            if race_is_complete(existing_race):
                continue

            live_payouts = (
                current_payouts.get(meet["venue"], {}).get(race_no)
                if mode == "current"
                else None
            )

            # If result/top-3 is already cached, accessH can complete the race
            # without re-fetching the result page.
            if (
                mode == "current"
                and len(existing_race.get("top3", [])) >= 3
                and live_payouts
                and live_payouts.get("単勝")
                and live_payouts.get("3連単")
            ):
                existing_race["payouts"] = live_payouts
                existing_race["win_payout"] = live_payouts["単勝"][0]["amount"]
                venue_results[race_no] = existing_race
                changed = True
                print(f"[JRA] {meet['venue']} {race_no}R payout merged")
                continue

            if mode == "current":
                result_link = current_result_link(race_meta)
                if not result_link:
                    continue
            else:
                result_link = race_meta["link"]

            try:
                cname = link_cname(result_link)
                # Public current-day result links (pw01sde01) include payouts.
                # Historical internal links (pw01sde10) may need mobile payout fallback.
                race_soup = soup_cname_get("/JRADB/accessS.html", cname)
                race_result = result_from_result_page(race_soup)

                if race_result and mode == "current" and live_payouts:
                    race_result["payouts"] = live_payouts
                    win_items = live_payouts.get("単勝", [])
                    race_result["win_payout"] = (
                        win_items[0]["amount"] if win_items else None
                    )

                if race_result and cname.startswith("pw01sde10"):
                    try:
                        mobile_soup = soup_mobile_result(result_link)
                        if mobile_soup:
                            race_result["payouts"] = {
                                label: payout_items(mobile_soup, label)
                                for label in PAYOUT_ORDER
                            }
                            win_items = race_result["payouts"]["単勝"]
                            race_result["win_payout"] = (
                                win_items[0]["amount"] if win_items else None
                            )
                    except Exception as payout_exc:
                        print(
                            f"[JRA] {meet['venue']} {race_no}R mobile payout failed: {payout_exc}",
                            file=sys.stderr,
                        )
            except Exception as exc:
                print(f"[JRA] {meet['venue']} {race_no}R fetch failed: {exc}", file=sys.stderr)
                continue

            if not race_result:
                continue

            venue_results[race_no] = {"race": race_no, **race_result}
            changed = True
            winner = race_result["top3"][0]
            win_items = race_result.get("payouts", {}).get("単勝", [])
            win_log = f" / 単勝 {win_items[0]['amount']}" if win_items else ""
            print(
                f"[JRA] {meet['venue']} {race_no}R: "
                f"{winner.get('horse','')} / {winner.get('jockey','')}{win_log}"
            )

    data["venues"] = [
        {
            "name": name,
            "results": [result_map[name][r] for r in sorted(result_map.get(name, {}))],
        }
        for name in venue_names
    ]

    if changed or not data.get("updated_at"):
        data["updated_at"] = now.strftime("%Y-%m-%d %H:%M JST")

    new_text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    old_text = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
    if new_text != old_text:
        OUT.write_text(new_text, encoding="utf-8")
        print(f"[JRA] data updated: {selected_ymd} / {', '.join(venue_names)}")
    else:
        print("[JRA] no result changes")


if __name__ == "__main__":
    main()
