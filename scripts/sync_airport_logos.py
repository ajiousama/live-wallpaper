#!/usr/bin/env python3
"""Save official Matsuyama Airport airline PNG logos as separate, immutable snapshots.

The eight previously approved airline logo originals in ../airlines are NEVER
read, rewritten, restyled or replaced by this script.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "transport" / "assets" / "airport-official"
ORIGIN = "https://www.matsuyama-airport.co.jp/img/logo/"
FILES = (
    "ANA.png", "JAL.png", "IBX.png", "JJA.png", "EVA.png",
    "6610.png", "4943.png", "6295.png", "9544.png",
    "FDA.png", "JJP.png", "EOK.png", "ABL.png",
    "9593.png", "ANZ.png", "THA.png", "AAR.png",
)
PNG = bytes.fromhex("89504e470d0a1a0a")
MAX_BYTES = 2_000_000


def get_png(name: str) -> bytes:
    url = ORIGIN + name
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; MatsuyamaStationBoard/1.0)",
        "Referer": "https://www.matsuyama-airport.co.jp/flight/timetable.html",
        "Accept": "image/png,image/*;q=0.8",
    }
    error = None
    for i in range(3):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=headers), timeout=22
            ) as response:
                data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES or len(data) < 80 or not data.startswith(PNG):
                raise ValueError(f"Invalid PNG or oversized asset {name} ({len(data)} bytes)")
            return data
        except (urllib.error.URLError, OSError, ValueError) as exc:
            error = exc
            if i < 2:
                time.sleep(i + 1)
    raise RuntimeError(f"Failed to mirror {name}: {error}")


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    results = {}
    failed = []
    for name in FILES:
        local = DEST / name
        try:
            if local.is_file():
                data = local.read_bytes()
                if not data.startswith(PNG):
                    raise ValueError(f"Existing file not PNG: {local}")
                print(f"KEEP {name} ({len(data)} bytes)")
            else:
                data = get_png(name)
                local.write_bytes(data)
                print(f"SAVED {name} ({len(data)} bytes)")
            results[name] = {
                "source": ORIGIN + name,
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
            }
        except Exception as exc:
            failed.append(f"{name}: {exc}")
            print(f"FAILED {name}: {exc}")
    if results:
        (DEST / "SOURCES.json").write_text(
            json.dumps(
                {"source_page": "https://www.matsuyama-airport.co.jp/flight/timetable.html",
                 "note": "Historical snapshot; the 8 approved originals in ../airlines remain unchanged.",
                 "logos": results}, ensure_ascii=False, indent=2
            ) + "\n", encoding="utf-8"
        )
    print(f"Valid PNG snapshots: {len(results)} / {len(FILES)}")
    if failed:
        # Existing valid files remain available, and missing files retain
        # their original official-URL fallback in the wallboard.
        print("Incomplete: " + " | ".join(failed))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
