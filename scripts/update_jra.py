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
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "jra" / "data.json"
JST = ZoneInfo("Asia/Tokyo")

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


def discover_result_landing() -> BeautifulSoup:
    # This menu parameter has been stable for years. If JRA changes it,
    # fall back to discovering the current "レース結果" action from the top page.
    try:
        soup = soup_action("/JRADB/accessS.html", "pw01sli00/AF")
        if extract_links(soup, "pw01srl"):
            return soup
    except Exception as exc:
        print(f"[JRA] stable result-menu action failed: {exc}", file=sys.stderr)

    top = soup_get(BASE + "/")
    candidates: list[dict] = []
    seen: set[str] = set()
    for a in top.find_all("a"):
        if "レース結果" not in a.get_text(" ", strip=True):
            continue
        onclick = a.get("onclick") or a.get("onClick") or ""
        m = ACTION_RE.search(onclick)
        if m and "accessS" in m.group(1):
            key = m.group(1) + "|" + m.group(2)
            if key not in seen:
                seen.add(key)
                candidates.append({"kind": "post", "path": m.group(1), "cname": m.group(2)})

    for candidate in candidates:
        soup = fetch_link(candidate)
        if extract_links(soup, "pw01srl"):
            return soup

    raise RuntimeError("JRAのレース結果開催選択ページを取得できませんでした")


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


def winner_from_result_page(soup: BeautifulSoup) -> tuple[str, str, str | None] | None:
    if "パラメータエラー" in page_title(soup):
        return None

    for table in soup.find_all("table"):
        header_text = table.get_text(" ", strip=True)
        if "着順" not in header_text or "騎手名" not in header_text or "馬名" not in header_text:
            continue

        tbody = table.find("tbody")
        first = tbody.find("tr") if tbody else None
        if not first:
            continue
        cells = first.find_all("td")
        if len(cells) < 7:
            continue

        rank = cells[0].get_text(" ", strip=True)
        if rank != "1":
            continue

        horse_link = cells[3].find("a")
        horse = (horse_link.get_text(" ", strip=True) if horse_link else cells[3].get_text(" ", strip=True))
        jockey_link = cells[6].find("a")
        jockey = (jockey_link.get_text(" ", strip=True) if jockey_link else cells[6].get_text(" ", strip=True))

        horse = re.sub(r"\s+", " ", horse).strip()
        jockey = re.sub(r"\s+", " ", jockey).strip()
        if horse and jockey:
            win_payout = None

            # JRA payout DOM: .payout dl > dt("単勝") + dd .line .yen
            for dl in soup.select(".payout dl"):
                dt = dl.find("dt")
                if not dt or dt.get_text(" ", strip=True) != "単勝":
                    continue
                yen = dl.select_one("dd .line .yen")
                if yen:
                    amount = re.sub(r"\s+", "", yen.get_text("", strip=True))
                    if re.fullmatch(r"[0-9,]+円", amount):
                        win_payout = amount
                        break

                # DOM class may change slightly; stay inside the 単勝 block.
                dd = dl.find("dd")
                if dd:
                    m = re.search(r"([0-9,]+\s*円)", dd.get_text(" ", strip=True))
                    if m:
                        win_payout = re.sub(r"\s+", "", m.group(1))
                        break

            return jockey, horse, win_payout

    return None


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
            if (
                race_no in venue_results
                and venue_results[race_no].get("jockey")
                and venue_results[race_no].get("win_payout")
            ):
                continue

            try:
                race_soup = fetch_link(race_meta["link"])
                winner = winner_from_result_page(race_soup)
            except Exception as exc:
                print(f"[JRA] {meet['venue']} {race_no}R fetch failed: {exc}", file=sys.stderr)
                continue

            if not winner:
                continue

            jockey, horse, win_payout = winner
            venue_results[race_no] = {
                "race": race_no,
                "jockey": jockey,
                "horse": horse,
                "win_payout": win_payout,
            }
            changed = True
            payout_log = f" / 単勝 {win_payout}" if win_payout else ""
            print(f"[JRA] {meet['venue']} {race_no}R: {horse} / {jockey}{payout_log}")

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
