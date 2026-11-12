#!/usr/bin/env python3
"""Observe special-livery aircraft nationwide without inventing next flights.

ADS-B is an observation, not a timetable. Do not claim Matsuyama arrival
unless a separately verified Matsuyama-bound flight is matched.
"""
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data/special_aircraft_positions.json"
REGISTRATIONS = {
    "JA609A": "ちいかわジェット",
    "JA819A": "ポケモンジェット（赤）",
    "JA923A": "ポケモンジェット（緑）",
    "JA339J": "JAL Jubilee Express",
    "JA344J": "JAL トゥンクトゥンクJET",
    "JA228J": "J-AIR創立30周年記念JET",
    "JA58AN": "ふるさとJET",
    "JA880A": "スターアライアンス塗装",
    "JA868J": "JAL CONTRAIL 特別塗装機",
    "JA869J": "JAL oneworld塗装",
    "JA07RK": "結ジンベエジェット",
    "JA10RJ": "ベガルタ仙台ジェット",
}
BASES = ("https://api.adsb.lol/v2/registration/",
         "https://api.airplanes.live/v2/registration/")

def extract(registration, payload, source):
    rows = payload.get("ac")
    if not isinstance(rows, list):
        return None
    matches = [a for a in rows if isinstance(a, dict)
               and str(a.get("r", "")).upper() == registration]
    if len(matches) != 1:
        return None
    a = matches[0]
    try:
        age = float(a["seen_pos"])
        lat, lon = float(a["lat"]), float(a["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if not 0 <= age <= 90 or not -90 <= lat <= 90 or not -180 <= lon <= 180:
        return None
    flight = str(a.get("flight") or "").strip().upper()
    if flight and not re.fullmatch(r"[A-Z0-9]{3,10}", flight):
        flight = ""
    return {"registration": registration, "livery": REGISTRATIONS[registration],
            "callsign": flight, "latitude": lat, "longitude": lon,
            "positionAgeSeconds": age, "source": source,
            "flightToMatsuyamaConfirmed": False}

def observe(registration):
    for base in BASES:
        try:
            req = urllib.request.Request(base + registration, headers={
                "Accept": "application/json", "User-Agent": "MatsuyamaSpecialAircraftWatch/1.0"})
            with urllib.request.urlopen(req, timeout=9) as response:
                payload = json.load(response)
            result = extract(registration, payload, base)
            if result:
                return result
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return None

def test():
    payload = {"ac": [{"r": "JA819A", "lat": 34.7, "lon": 135.2,
                        "seen_pos": 12, "flight": "ANA773 "}]}
    assert extract("JA819A", payload, "test")["callsign"] == "ANA773"
    assert extract("JA609A", payload, "test") is None
    payload["ac"][0]["seen_pos"] = 200
    assert extract("JA819A", payload, "test") is None
    print("PASS: exact registration / callsign / stale-position rejection")

def main():
    import sys
    if "--self-test" in sys.argv:
        test()
        return
    previous = {}
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    observed = [item for reg in REGISTRATIONS if (item := observe(reg))]
    now = datetime.now(timezone.utc).isoformat()
    # Missing aircraft are unknown, not grounded, and must not reuse old positions.
    data = {"schemaVersion": 1, "generatedAtUtc": now,
            "status": "observed" if observed else "no_fresh_positions",
            "aircraft": observed,
            "note": "全国ADS-Bの観測。便の目的地・次便・松山到着は未確認。欠測は飛行停止を意味しない。"}
    # Only write when positions/status change, to reduce pointless Git commits.
    signature = lambda d: [(a["registration"], a["callsign"],
                             round(a["latitude"], 2), round(a["longitude"], 2))
                            for a in d.get("aircraft", [])]
    if signature(data) != signature(previous) or data["status"] != previous.get("status"):
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Fresh aircraft:", len(observed))

if __name__ == "__main__":
    main()
