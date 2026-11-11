#!/usr/bin/env python3
"""Archive confirmed special-livery aircraft seen on Matsuyama's live flight board.

A registered aircraft spotted at an origin airport is ONLY a candidate.
A Matsuyama arrival/departure is confirmed when the airport board subsequently
shows the corresponding flight as completed. Never infer a landing from schedule.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "transport/r15-dev/app.js"
OUT = ROOT / "data/special_aircraft_watch.json"
FEED = "https://ihhiymkepuydykrhmzwo.supabase.co/functions/v1/approach?scope=slow"
JST = timezone(timedelta(hours=9))
ARRIVED = re.compile(r"到着済み|ただいま到着|着陸済み|到着完了")
DEPARTED = re.compile(r"出発済み|離陸済み|出発完了|離陸完了")


def stamp(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        d = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        return d if d.tzinfo else None
    except ValueError:
        return None


def registry(source):
    """Read the exact livery whitelist used by the existing live wallpaper."""
    match = re.search(
        r"const SPECIAL_AIRCRAFT_LIVERIES=Object.freeze\(\{(.*?)\}\);",
        source, flags=re.S)
    if not match:
        raise ValueError("Wallpaper registry not found")
    entries = dict(re.findall(
        r"^\s*(JA[A-Z0-9]{4,6}):'([^']+)'[,]?\s*$", match.group(1), flags=re.M))
    if len(entries) < 2:
        raise ValueError("Unexpectedly empty special-aircraft registry")
    return entries


def numbers(row):
    raw = row.get("numbers", [])
    if not isinstance(raw, list):
        raw = []
    return sorted({str(n).strip() for n in raw if str(n).strip()})


def flight_date(generated_at, planned):
    """Handle previous-day late-night rows shortly after midnight."""
    local = generated_at.astimezone(JST)
    if re.fullmatch(r"\d\d:\d\d", planned):
        scheduled_minutes = int(planned[:2]) * 60 + int(planned[3:])
        now_minutes = local.hour * 60 + local.minute
        if now_minutes < 180 and scheduled_minutes >= 20 * 60:
            return (local - timedelta(days=1)).date().isoformat()
    return local.date().isoformat()


def row_near_current_time(generated_at, planned):
    if not re.fullmatch(r"\d\d:\d\d", planned):
        return False
    at = generated_at.astimezone(JST)
    at_minutes = at.hour * 60 + at.minute
    plan_minutes = int(planned[:2]) * 60 + int(planned[3:])
    difference = (at_minutes - plan_minutes + 720) % 1440 - 720
    return -240 <= difference <= 420


def update_archive(live, archive, livery, now=None):
    now = now or datetime.now(timezone.utc)
    if not live.get("ok") or not isinstance(live.get("airport"), dict):
        raise ValueError("Live airport feed is not healthy")
    airport = live["airport"]
    if not airport.get("ok"):
        raise ValueError("Official Matsuyama flight board is not verified")
    at = stamp(live.get("generatedAtJst"))
    if at is None or not timedelta(seconds=-60) <= (now-at) <= timedelta(minutes=20):
        raise ValueError("Refusing stale or undated airport feed")
    rows = list(archive.get("records", []))
    indexed = {r.get("key"): r for r in rows if isinstance(r, dict)}
    new_candidates, newly_confirmed = [], []
    for direction, name, complete in [
        ("arrival", "arrivals", ARRIVED),
        ("departure", "departures", DEPARTED),
    ]:
        feed_rows = airport.get(name)
        if not isinstance(feed_rows, list):
            raise ValueError(f"Missing {name} list")
        for row in feed_rows:
            if not isinstance(row, dict):
                continue
            nums = numbers(row)
            planned = str(row.get("scheduled") or "").strip()
            status = str(row.get("status") or "") + " " + str(row.get("changeText") or "")
            if not nums or not row_near_current_time(at, planned):
                continue
            day = flight_date(at, planned)
            reported_reg = str(row.get("aircraftRegistration") or "").strip().upper()
            observed = stamp(row.get("aircraftObservedAt"))
            source = str(row.get("aircraftRegistrationSource") or "")
            # A scheduled aircraft type/route does not prove any actual aircraft.
            # This is a fresh ADS-B callsign-to-registration match by the server.
            positive = (
                reported_reg in livery
                and observed is not None
                and timedelta(seconds=-60) <= at-observed <= timedelta(minutes=20)
                and ("ADS" in source.upper() or "AIRPLANES.LIVE" in source.upper())
            )
            if positive:
                reg = reported_reg
                key = "|".join((day, direction, ",".join(nums), planned, reg))
                current = indexed.get(key)
                if current is None:
                    current = {
                        "key": key, "date": day, "direction": direction,
                        "flightNumbers": nums, "scheduled": planned,
                        "registration": reg, "livery": livery[reg],
                        "firstObservedAtJst": at.isoformat(),
                        "registrationSource": source,
                        "state": "candidate",
                        "flightBoardSource": "松山空港公式"
                    }
                    indexed[key] = current
                    rows.append(current)
                    new_candidates.append(key)
                matches = [current]
            else:
                # When ADS-B is no longer reachable after landing, only promote
                # an unambiguous SAME-DAY, SAME-FLIGHT earlier verified match.
                matches = [
                    old for old in rows
                    if old.get("date") == day
                    and old.get("direction") == direction
                    and old.get("scheduled") == planned
                    and old.get("state") == "candidate"
                    and set(old.get("flightNumbers", [])) == set(nums)
                ]
                if len(matches) != 1:
                    matches = []
            if complete.search(status):
                for item in matches:
                    if item["state"] != "confirmed":
                        item["state"] = "confirmed"
                        item["confirmedAtJst"] = at.isoformat()
                        item["confirmedStatus"] = status.strip()[:100]
                        # Confirmation time is the time we checked the board,
                        # NOT an unverified actual landing/takeoff clock time.
                        newly_confirmed.append(item["key"])
    rows.sort(key=lambda x: (x.get("date", ""), x.get("key", "")))
    archive["records"] = rows[-1500:]
    archive["source"] = FEED
    archive["note"] = (
        "candidate=機体番号と当該便の照合済み（松山到着未確認）。"
        "confirmed=松山空港公式発着案内の完了表示と機体番号を照合。"
        "confirmedAtJstは確認時刻であり、実際の着陸/離陸時刻とは限らない。"
    )
    return archive, new_candidates, newly_confirmed


def self_test():
    t = datetime.fromisoformat("2026-11-11T10:02:00+09:00")
    livery = {"JA609A": "ちいかわジェット"}
    base = {
        "ok": True, "generatedAtJst": t.isoformat(),
        "airport": {"ok": True, "arrivals": [{
            "numbers": ["583"], "scheduled": "10:00", "status": "定刻",
            "aircraftRegistration": "JA609A", "aircraftObservedAt": t.isoformat(),
            "aircraftRegistrationSource": "ADSB.lol"
        }], "departures": []}
    }
    data, candidate, confirmed = update_archive(base, {}, livery, t)
    assert len(candidate) == 1 and not confirmed
    assert data["records"][0]["state"] == "candidate"
    base["airport"]["arrivals"][0].update(
        status="到着済み", aircraftRegistration="", aircraftObservedAt="")
    data, candidate, confirmed = update_archive(base, data, livery, t)
    assert not candidate and len(confirmed) == 1
    assert data["records"][0]["state"] == "confirmed"
    data, candidate, confirmed = update_archive(base, data, livery, t)
    assert not candidate and not confirmed
    bad = json.loads(json.dumps(base))
    bad["airport"]["arrivals"][0]["numbers"] = ["585"]
    bad["airport"]["arrivals"][0]["aircraftRegistration"] = "JA56AN"
    bad["airport"]["arrivals"][0]["aircraftObservedAt"] = t.isoformat()
    data, candidate, confirmed = update_archive(bad, data, livery, t)
    assert not candidate and not confirmed
    try:
        update_archive(base, data, livery, t + timedelta(hours=1))
        raise AssertionError("stale feed passed")
    except ValueError:
        pass
    print("PASS: candidate / official completion / no duplicates / excluded jets / stale feed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    liveries = registry(APP.read_text(encoding="utf-8"))
    request = Request(FEED, headers={
        "Accept": "application/json",
        "User-Agent": "Matsuyama-Live-Wallpaper-Special-Aircraft-Watch/1.0"
    })
    with urlopen(request, timeout=25) as response:
        live = json.load(response)
    archive = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    archive, candidates, confirmed = update_archive(live, archive, liveries)
    if candidates or confirmed:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(archive, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
    print("New registrations:", len(candidates), "new confirmed:", len(confirmed))
    for key in confirmed:
        print("CONFIRMED:", key)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Special-aircraft archive skipped (no fabricated data): {exc}", file=sys.stderr)
        raise
