from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "data" / "transport.json"
JST = ZoneInfo("Asia/Tokyo")

EMPTY = {
    "schema_version": 2,
    "generated_at_utc": None,
    "generated_at_jst": None,
    "source_state": {
        "jr": "pending",
        "airport": "pending",
        "airport_bus": "pending",
        "highway_bus": "pending",
        "ferry": "pending",
    },
    "jr_matsuyama": [],
    "ichitsubo": [],
    "airport": {"departures": [], "arrivals": []},
    "airport_bus": [],
    "highway_bus": [],
    "ferry": [],
    "now": {"trains": [], "buses": [], "aircraft": [], "vessels": []},
}


def load() -> dict:
    if not TARGET.exists():
        return json.loads(json.dumps(EMPTY))
    try:
        data = json.loads(TARGET.read_text(encoding="utf-8"))
    except Exception:
        return json.loads(json.dumps(EMPTY))

    for key, value in EMPTY.items():
        if key not in data:
            data[key] = json.loads(json.dumps(value))
    if not isinstance(data.get("airport"), dict):
        data["airport"] = {"departures": [], "arrivals": []}
    data["airport"].setdefault("departures", [])
    data["airport"].setdefault("arrivals", [])
    if not isinstance(data.get("now"), dict):
        data["now"] = {}
    for key in ("trains", "buses", "aircraft", "vessels"):
        data["now"].setdefault(key, [])
    if not isinstance(data.get("source_state"), dict):
        data["source_state"] = {}
    for key in ("jr", "airport", "airport_bus", "highway_bus", "ferry"):
        data["source_state"].setdefault(key, "pending")
    return data


def main() -> None:
    data = load()
    now_utc = datetime.now(timezone.utc)
    now_jst = now_utc.astimezone(JST)
    data["schema_version"] = 2
    data["generated_at_utc"] = now_utc.isoformat(timespec="seconds")
    data["generated_at_jst"] = now_jst.strftime("%Y-%m-%d %H:%M:%S JST")

    # 各取得アダプターはこの共通JSONへ統一形式で流し込む。
    # 取得失敗時は直前の正常値を残して表示側を空にしない。

    TARGET.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
