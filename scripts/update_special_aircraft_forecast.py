#!/usr/bin/env python3
"""Check published special-livery aircraft plans ahead of Matsuyama flights.

JAL articles are unofficial aircraft plans, NEVER verified actual assignments.
ANA operations are a type-based prediction, NEVER a tail-number assignment.
The on-arrival ADS-B watcher remains separately authoritative for candidate /
confirmed states. This tool does not invent them.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
REGISTRY_FILE = ROOT / "transport/r15-dev/app.js"
OUTPUT = ROOT / "data/special_aircraft_forecast.json"
JST = timezone(timedelta(hours=9))
JAL_ARCHIVE = "https://oyaji-photo.club/category/jal/"
ANA_OPERATIONS = "https://www.tsuitachimochi.net/flights/operations?airline=ANA"
ANA_LOCATIONS = "https://www.tsuitachimochi.net/flights/aircraft-locations"
REG = re.compile(r"\b(JA[A-Z0-9]{4,6})\b")
DATE_IN_TITLE = re.compile(r"(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日")
ARTICLE_PATH = re.compile(r"^/(20\d{6})jl/?$")
FLIGHT = re.compile(r"\b(?:JAL|JL|JTA|NU)\s*(\d{1,4})\b", re.I)
CLOCK = re.compile(r"^(?:[01]?\d|2[0-3]):[0-5]\d$")


def registry(source):
    block = re.search(r"const SPECIAL_AIRCRAFT_LIVERIES=Object.freeze\(\{(.*?)\}\);",
                      source, re.S)
    if not block:
        raise ValueError("SPECIAL_AIRCRAFT_LIVERIES not found")
    found = re.findall(r"^\s*(JA[A-Z0-9]{4,6}):'([^']+)'[,]?\s*$",
                       block.group(1), re.M)
    if not found:
        raise ValueError("Empty special-livery registry")
    return dict(found)


def fetch_html(url):
    req = Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; MatsuyamaAircraftForecast/1.0)",
        "Accept": "text/html,application/xhtml+xml",
    })
    with urlopen(req, timeout=22) as response:
        if response.status != 200:
            raise ValueError("HTTP " + str(response.status))
        return response.read(2_000_000).decode("utf-8", "replace")


def article_urls(html, from_day, last_day):
    soup = BeautifulSoup(html, "html.parser")
    found = {}
    for a in soup.select("a[href]"):
        url = urljoin(JAL_ARCHIVE, a.get("href", ""))
        parsed = urlparse(url)
        if parsed.hostname != "oyaji-photo.club":
            continue
        match = ARTICLE_PATH.fullmatch(parsed.path)
        if not match:
            continue
        try:
            day = datetime.strptime(match.group(1), "%Y%m%d").date()
        except ValueError:
            continue
        if from_day <= day <= last_day:
            found[day.isoformat()] = url
    return found


def parse_jal_article(html, url, expected_day, liveries):
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.find("h1")
    if not h1:
        raise ValueError("Article heading missing")
    title = h1.get_text(" ", strip=True)
    date_match = DATE_IN_TITLE.search(title)
    if not date_match:
        raise ValueError("Article title has no calendar date")
    day = "%s-%02d-%02d" % (date_match.group(1), int(date_match.group(2)),
                             int(date_match.group(3)))
    if day != expected_day:
        raise ValueError("Article date mismatch: " + day)
    if "特別塗装機" not in title:
        raise ValueError("Article does not list special liveries")
    events = []
    for table in soup.find_all("table"):
        # The aircraft registration immediately PRECEDING this flight table
        # is the only attribution allowed. Multiple tails (e.g. JTA) are
        # deliberately ambiguous and cannot create an aircraft prediction.
        marker = table.find_previous(string=REG)
        if not marker:
            continue
        regs = set(REG.findall(str(marker)))
        if len(regs) != 1:
            continue
        registration = next(iter(regs))
        if registration not in liveries:
            continue
        for tr in table.find_all("tr"):
            td = tr.find_all("td")
            if len(td) < 4:
                continue
            flight_text = td[0].get_text(" ", strip=True)
            m = FLIGHT.search(flight_text)
            route = td[1].get_text(" ", strip=True)
            dep = td[2].get_text(" ", strip=True)
            arr = td[3].get_text(" ", strip=True)
            if not (m and "→" in route and CLOCK.fullmatch(dep) and CLOCK.fullmatch(arr)):
                continue
            origin, destination = [p.strip() for p in route.split("→", 1)]
            if "松山" in destination:
                direction = "arrival"
            elif "松山" in origin:
                direction = "departure"
            else:
                continue
            carrier = "JAL" if flight_text.upper().startswith(("JAL","JL")) else "JTA"
            events.append({
                "date": day,
                "direction": direction,
                "airline": carrier,
                "flightNumber": m.group(1),
                "flightDisplay": ("JL" if carrier == "JAL" else "NU") + m.group(1),
                "registration": registration,
                "livery": liveries[registration],
                "origin": origin,
                "destination": destination,
                "departureScheduled": dep.zfill(5),
                "arrivalScheduled": arr.zfill(5),
                "evidence": "unofficial_aircraft_plan",
                "sourceUrl": url,
            })
    return events


def summarize_ana_operations(html):
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True)
    updated = re.search(r"更新:\s*(20\d{2}-\d\d-\d\dT[0-9:.+]+)", text)
    if not updated:
        raise ValueError("ANA operations update time missing")
    # Do not infer JA609A from a 76P lane or JA819A from a 78P lane.
    return {"status": "checked_type_only_not_tail_assignment",
            "sourceUrl": ANA_OPERATIONS,
            "siteUpdatedAt": updated.group(1),
            "note": "機種別棒ダイヤは機体記号の確定割当ではない"}


def summarize_ana_locations(html, registrations):
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True)
    updated = re.search(r"最終更新:\s*(20\d{2}-\d\d-\d\d\s+\d\d:\d\d:\d\d)", text)
    if not updated:
        raise ValueError("ANA aircraft-locations update time missing")
    found = sorted(reg for reg in registrations if reg in text)
    return {"status": "checked" if found else "no_monitored_aircraft_listed",
            "sourceUrl": ANA_LOCATIONS,
            "siteUpdatedAt": updated.group(1),
            "registrationsSeen": found,
            "nextVerified": False,
            "note": "Nextはレジ番と便名が同一レコードで照合できる場合のみ採用"}


def self_test():
    liveries = {"JA344J": "トゥンクトゥンクJET", "JA07RK": "結ジンベエ"}
    page = """<h1>2026年11月13日JAL特別塗装機運航情報</h1>
    <p>機番：JA344J</p><table>
    <tr><th>便名</th><th>区間</th><th>出発</th><th>到着</th></tr>
    <tr><td>JAL123</td><td>東京(羽田)→松山</td><td>7:05</td><td>8:35</td></tr>
    <tr><td>JAL124</td><td>松山→東京(羽田)</td><td>9:10</td><td>10:25</td></tr>
    </table>
    <p>機番：JA05RK・JA06RK・JA07RK</p><table>
    <tr><td>JTA300</td><td>松山→那覇</td><td>10:00</td><td>11:50</td></tr>
    </table>"""
    result = parse_jal_article(page, "https://oyaji-photo.club/20261113jl/",
                               "2026-11-13", liveries)
    assert len(result) == 2, result
    assert result[0]["direction"] == "arrival"
    assert result[1]["direction"] == "departure"
    assert result[0]["arrivalScheduled"] == "08:35"
    try:
        parse_jal_article(page, "https://oyaji-photo.club/20261113jl/",
                          "2026-11-12", liveries)
        raise AssertionError("Incorrect article date accepted")
    except ValueError:
        pass
    archive = """<a href="/20261113jl/">11/13</a><a href="/20261120jl/">11/20</a>"""
    assert len(article_urls(archive, datetime(2026,11,13).date(),
                            datetime(2026,11,19).date())) == 1
    print("PASS: article discovery/date, two Matsuyama directions, no ambiguous tails")


def main():
    argp = argparse.ArgumentParser()
    argp.add_argument("--self-test", action="store_true")
    args = argp.parse_args()
    if args.self_test:
        self_test()
        return
    now = datetime.now(JST)
    start = now.date()
    end = start + timedelta(days=7)
    liveries = registry(REGISTRY_FILE.read_text(encoding="utf-8"))
    old = json.loads(OUTPUT.read_text(encoding="utf-8")) if OUTPUT.exists() else {}
    checks = {}
    events = []
    found_dates = []
    failed_articles = []
    try:
        archive_html = fetch_html(JAL_ARCHIVE)
        articles = article_urls(archive_html, start, end)
        found_dates = sorted(articles)
        for day, url in sorted(articles.items()):
            try:
                events.extend(parse_jal_article(fetch_html(url), url, day, liveries))
            except Exception as e:
                failed_articles.append({"date": day, "error": str(e)[:180]})
        checks["jal"] = {"status": "checked" if not failed_articles else "partial",
                         "sourceUrl": JAL_ARCHIVE,
                         "publishedDates": found_dates,
                         "articleErrors": failed_articles,
                         "nextDayPublished": (start+timedelta(days=1)).isoformat() in articles}
    except Exception as e:
        checks["jal"] = {"status": "unavailable", "sourceUrl": JAL_ARCHIVE,
                         "error": str(e)[:200]}
    for key, url, parser in [
        ("anaOperations", ANA_OPERATIONS, summarize_ana_operations),
        ("anaLocations", ANA_LOCATIONS,
         lambda html: summarize_ana_locations(html, liveries)),
    ]:
        try:
            checks[key] = parser(fetch_html(url))
        except Exception as e:
            checks[key] = {"status": "unavailable", "sourceUrl": url,
                           "error": str(e)[:200]}

    # Retain only recently verified events during a temporary source outage.
    # Any event older than 24h without a refresh is NOT displayed by the UI.
    if checks["jal"]["status"] in ("partial", "unavailable"):
        missing = set(x["date"] for x in failed_articles)
        old_time = old.get("generatedAtJst","")
        try:
            age = (now-datetime.fromisoformat(old_time)).total_seconds()
        except (ValueError, TypeError):
            age = float("inf")
        for event in old.get("events", []):
            if not isinstance(event, dict) or event.get("date", "") < start.isoformat():
                continue
            if age <= 86400 and (checks["jal"]["status"] == "unavailable"
                                   or event.get("date") in missing):
                events.append(event)

    events = list({(e["date"],e["direction"],e["flightNumber"],e["registration"]):
                   e for e in events}.values())
    events.sort(key=lambda e:(e["date"],e["arrivalScheduled"],
                              e["flightNumber"],e["registration"]))
    result = {
        "schemaVersion": 1,
        "generatedAtJst": now.isoformat(timespec="seconds"),
        "lookaheadDays": 7,
        "sourceChecks": checks,
        "events": events,
        "note": ("JAL日別記事は非公式な機材予定。ANA機種予測から特定の機体番号を推測しない。"
                 "機体番号付きADS-B照合は別の監視システムで確認する。"),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n",encoding="utf-8")
    print("JAL article days:", found_dates, "Matsuyama events:", len(events))
    print("Source statuses:", {k:v["status"] for k,v in checks.items()})
    if all(v["status"] == "unavailable" for v in checks.values()):
        # Preserve checked failure state but signal that today's survey failed.
        raise RuntimeError("All public sources unavailable; no schedules verified")


if __name__ == "__main__":
    main()
