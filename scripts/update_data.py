from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
STATUS = ROOT / "data" / "status.json"
JST = ZoneInfo("Asia/Tokyo")


def main() -> None:
    data = json.loads(STATUS.read_text(encoding="utf-8"))
    now_utc = datetime.now(timezone.utc)
    now_jst = now_utc.astimezone(JST)

    data["generated_at_utc"] = now_utc.isoformat(timespec="seconds")
    data["generated_at_jst"] = now_jst.strftime("%Y-%m-%d %H:%M:%S JST")

    STATUS.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
