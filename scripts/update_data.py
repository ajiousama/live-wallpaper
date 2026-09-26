from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
STATUS = ROOT / "data" / "status.json"
TRANSPORT = ROOT / "data" / "transport.json"
JRA = ROOT / "jra" / "data.json"
JST = ZoneInfo("Asia/Tokyo")


def read_json(path: Path, fallback: dict) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def state(ok: bool, ok_text: str, wait_text: str) -> dict:
    return {"status": "ok" if ok else "waiting", "detail": ok_text if ok else wait_text}


def main() -> None:
    transport = read_json(TRANSPORT, {})
    jra = read_json(JRA, {})
    now_utc = datetime.now(timezone.utc)
    now_jst = now_utc.astimezone(JST)
    airport = transport.get("airport") or {}

    data = {
        "schema_version": 2,
        "generated_at_utc": now_utc.isoformat(timespec="seconds"),
        "generated_at_jst": now_jst.strftime("%Y-%m-%d %H:%M:%S JST"),
        "modules": {
            "jr_matsuyama": state(bool(transport.get("jr_matsuyama")), "GitHubデータ更新中", "取得アダプター接続待ち"),
            "ichitsubo": state(bool(transport.get("ichitsubo")), "GitHubデータ更新中", "取得アダプター接続待ち"),
            "airport": state(bool((airport.get("departures") or []) + (airport.get("arrivals") or [])), "GitHubデータ更新中", "取得アダプター接続待ち"),
            "airport_bus": state(bool(transport.get("airport_bus")), "GitHubデータ更新中", "取得アダプター接続待ち"),
            "highway_bus": state(bool(transport.get("highway_bus")), "GitHubデータ更新中", "取得アダプター接続待ち"),
            "ferry": state(bool(transport.get("ferry")), "GitHubデータ更新中", "取得アダプター接続待ち"),
            "jra": state(bool(jra.get("venues")), "JRA公式結果をGitHub側で更新", "開催結果待ち"),
        },
    }

    STATUS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
