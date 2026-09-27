from __future__ import annotations

import json
import re
import sys
import time
from datetime import date, datetime
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
DEBUG_PAYOUT_PRINTED = False

VENUES = {
    "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
    "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
}
WEEKDAY = ["月曜", "火曜", "水曜", "木曜", "金曜", "土曜", "日曜"]

ACTION_RE = re.compile(
    r"doAction\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]",
    re.I,
)
SRL_RE = re.compile(
    r"pw01srl10(?P<venue>\d{2})(?P<year>\d{4})(?P<meet>\d{2})(?P<day>\d{2})(?P<ymd>\d{8})/(?P<cd>[0-9A-Fa-f]{2})"
)
SDE_RE = re.compile(
    r"pw01sde10(?P<venue>\d{2})(?P<year>\d{4})(?P<meet>\d{2})(?P<day>\d{2})(?P<race>\d{2})(?P<ymd>\d{8})/(?P<cd>[0-9A-Fa-f]{2})"
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
    # Public browser-facing JRADB URL. Unlike the internal POST response,
    # this variant includes the payout section on race-result pages.
    r = request(
        "GET",
        urljoin(BASE, path),
        params={"CNAME": cname},
    )
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
    if link["kind"] == "post":
        return link["cname"]
    query = parse_qs(urlparse(link["url"]).query)
    return query.get("CNAME", query.get("cname", [""]))[0]


def fetch_link(link: dict) -> BeautifulSoup:
    if link["kind"] == "post":
        return soup_action(link["path"], link["cname"])
    return soup_get(link["url"])


def mobile_result_cname(link: dict) -> str | None:
    # Race-selection links use pw01sde10... with a 2-digit check value.
    # JRA mobile result pages use sw01sde01... and the check value is
    # consistently +0xAE (mod 256) from the selection-link value.
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
    r = request(
        "GET",
        MOBILE_BASE + "/JRADB/accessS.html",
        params={"CNAME": cname},
    )
    soup = BeautifulSoup(r.content, "html.parser")
    if "param_error" in soup.get_text(" ", strip=True):
        return None
    return soup


def discover_result_landing() -> BeautifulSoup:
    # JRA exposes more than one result menu (completed/past vs current-day).
    # Inspect both the stable DB menu and current top-page actions, then choose
    # the page that contains today's meeting links when available.
    candidates: list[BeautifulSoup] = []

    try:
        stable = soup_action("/JRADB/accessS.html", "pw01sli00/AF")
        if extract_links(stable, "pw01srl"):
            candidates.append(stable)
    except Exception as exc:
        print(f"[JRA] stable result-menu action failed: {exc}", file=sys.stderr)

    try:
        top = soup_get(BASE + "/")
        top_html = str(top)
        dde_hits = sorted(set(re.findall(r"pw01dde[^'\\\"<>\\s)]+", top_html)))
        if dde_hits:
            print(f"[JRA DEBUG] top dde count={len(dde_hits)} first={dde_hits[:8]}")
        seen: set[str] = set()
        actions: list[dict] = []

        # Current-day result entry points are usually attached to visible
        # "レース結果" links on the JRA top page.
        for a in top.find_all("a"):
            text = a.get_text(" ", strip=True)
            onclick = a.get("onclick") or a.get("onClick") or ""
            m = ACTION_RE.search(onclick)
            if not m or "accessS" not in m.group(1):
                continue
            if "レース結果" not in text and "結果" not in text:
                continue
            key = m.group(1) + "|" + m.group(2)
            if key in seen:
                continue
            seen.add(key)
            actions.append({"kind": "post", "path": m.group(1), "cname": m.group(2)})

        # Some JRA layouts hide the label inside nested elements. If the
        # labelled pass found nothing, inspect all accessS actions cautiously.
        if not actions:
            for a in top.find_all("a"):
                onclick = a.get("onclick") or a.get("onClick") or ""
                m = ACTION_RE.search(onclick)
                if not m or "accessS" not in m.group(1):
                    continue
                key = m.group(1) + "|" + m.group(2)
                if key in seen:
                    continue
                seen.add(key)
                actions.append({"kind": "post", "path": m.group(1), "cname": m.group(2)})

        for action in actions[:40]:
            try:
                page = fetch_link(action)
            except Exception:
                continue
            if extract_links(page, "pw01srl"):
                candidates.append(page)
    except Exception as exc:
        print(f"[JRA] top-page result discovery failed: {exc}", file=sys.stderr)

    if not candidates:
        raise RuntimeError("JRAのレース結果開催選択ページを取得できませんでした")

    today = datetime.now(JST).strftime("%Y%m%d")

    def page_score(soup: BeautifulSoup) -> tuple[int, str]:
        dates: list[str] = []
        for link in extract_links(soup, "pw01srl"):
            m = SRL_RE.search(link_cname(link))
            if m:
                dates.append(m.group("ymd"))
        return (1 if today in dates else 0, max(dates) if dates else "")

    best = max(candidates, key=page_score)
    score = page_score(best)
    print(f"[JRA] result menu selected: today={bool(score[0])} latest={score[1]}")
    return best

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
        "venue_code": g["venue"],
        "venue": VENUES.get(g["venue"], g["venue"]),
        "race": int(g["race"]),
        "ymd": g["ymd"],
    }


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


PAYOUT_ORDER = ["単勝", "複勝", "枠連", "馬連", "馬単", "ワイド", "3連複", "3連単"]


def payout_items(soup: BeautifulSoup, label: str) -> list[dict]:
    # First try the structured dl blocks used by desktop/mobile result pages.
    for tag in soup.find_all(["strong", "dt", "th", "td"]):
        if clean_text(tag) != label:
            continue

        dl = tag.find_parent("dl")
        if dl:
            dd = dl.find("dd") or dl
            tokens = [clean_text(p) for p in dd.find_all("p")]
            tokens = [t for t in tokens if t and "人気" not in t]
            items: list[dict] = []
            pending_combo = None
            for token in tokens:
                if re.fullmatch(r"[0-9,]+円", token):
                    if pending_combo is not None:
                        items.append({"combo": pending_combo, "amount": token})
                        pending_combo = None
                    continue
                if re.fullmatch(r"[0-9]+(?:[-→][0-9]+)*", token):
                    pending_combo = token
            if items:
                return items

    # Robust fallback: parse the visible payout text between bet-type labels.
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

    if not top3:
        return None

    caption = result_table.find("caption")
    race_name = ""
    if caption:
        h2 = caption.find("h2")
        race_name = clean_text(h2)

    course = ""
    if caption:
        for node in caption.find_all(["p", "li", "span"]):
            t = clean_text(node)
            if "コース：" in t or "コース:" in t:
                course = re.sub(r"^.*?コース[:：]\s*", "", t).strip()
                break

    payouts = {label: payout_items(soup, label) for label in PAYOUT_ORDER}

    winner = top3[0]
    return {
        "race_name": race_name,
        "course": course,
        "top3": top3,
        "payouts": payouts,
        # Keep legacy fields for the WP2 winning-jockey board.
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


def main() -> None:
    now = datetime.now(JST)
    today = now.strftime("%Y%m%d")

    landing = discover_result_landing()
    srl_meta = [x for x in (parse_srl(l) for l in extract_links(landing, "pw01srl")) if x]
    if not srl_meta:
        raise RuntimeError("JRA開催リンク(pw01srl)が見つかりません")

    available_dates = sorted({x["ymd"] for x in srl_meta if x["ymd"] <= today})
    if not available_dates:
        available_dates = sorted({x["ymd"] for x in srl_meta})
    selected_ymd = today if today in available_dates else available_dates[-1]

    selected = []
    seen_venue = set()
    for x in srl_meta:
        if x["ymd"] != selected_ymd or x["venue_code"] in seen_venue:
            continue
        seen_venue.add(x["venue_code"])
        selected.append(x)
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

    changed = existing.get("source_date") != selected_ymd or [v.get("name") for v in existing.get("venues", [])] != venue_names

    for meet in selected:
        meet_soup = fetch_link(meet["link"])
        race_links = [x for x in (parse_sde(l) for l in extract_links(meet_soup, "pw01sde")) if x]
        race_links = [x for x in race_links if x["ymd"] == selected_ymd and x["venue_code"] == meet["venue_code"]]

        venue_results = result_map.setdefault(meet["venue"], {})
        for race_meta in sorted(race_links, key=lambda x: x["race"]):
            race_no = race_meta["race"]
            existing_race = venue_results.get(race_no, {})
            existing_payouts = existing_race.get("payouts", {})
            if (
                len(existing_race.get("top3", [])) >= 3
                and all(k in existing_payouts for k in PAYOUT_ORDER)
                and all(existing_payouts.get(k) for k in ("単勝", "複勝", "3連単"))
            ):
                continue

            try:
                race_soup = soup_cname_get(
                    "/JRADB/accessS.html",
                    link_cname(race_meta["link"]),
                )
                race_result = result_from_result_page(race_soup)

                # Payout markup is more consistently present on JRA's
                # smartphone result page. Read every standard bet type there.
                if race_result:
                    try:
                        mobile_soup = soup_mobile_result(race_meta["link"])
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
                            f"[JRA] {meet['venue']} {race_no}R mobile payout failed: "
                            f"{payout_exc}",
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
