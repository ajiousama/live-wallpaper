#!/usr/bin/env python3
"""Collect public EBC Matsuyama airport chat leads without a personal API key.

Uses the unofficial pytchat client. Failure is explicit, never treated as an empty chat.
Messages are unverified leads, not confirmed aircraft assignments.
"""
import json, re, sys, time
from datetime import datetime, timezone
from pathlib import Path
import pytchat

VIDEO_ID = "L9OqeSJgzKA"
OUT = Path("data/ebc_aircraft_chat_leads.json")
PATTERN = re.compile(r"ちいかわ|ポケモン|特別塗装|JA609A|JA819A|JA923A|NH\\s*593|NH\\s*599|飛来|ステイ", re.I)

def main():
    try:
        chat = pytchat.create(video_id=VIDEO_ID, interruptable=False)
        found = []
        deadline = time.monotonic() + 22
        while time.monotonic() < deadline and chat.is_alive():
            for item in chat.get().sync_items():
                body = getattr(item, "message", "")
                if not PATTERN.search(body):
                    continue
                found.append({
                    "message_id": getattr(item, "id", ""),
                    "published_at": getattr(item, "datetime", ""),
                    "author": getattr(getattr(item, "author", None), "name", ""),
                    "text": body, "video_id": VIDEO_ID,
                    "status": "unverified_chat_lead", "verified_flight": False,
                })
            time.sleep(1)
        chat.terminate()
        if not found:
            print("NO_MATCH: no matching messages observed in short polling window; chat availability not guaranteed")
            return 0
        previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"leads": []}
        leads = {x["message_id"]: x for x in previous.get("leads", []) if x.get("message_id")}
        for x in found:
            if x["message_id"]: leads[x["message_id"]] = x
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({
            "source": "EBC Matsuyama Airport YouTube live chat",
            "video_url": "https://www.youtube.com/watch?v=" + VIDEO_ID,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "status": "unverified_leads_only", "leads": list(leads.values())[-300:]
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("OK: matched", len(found), "messages")
        return 0
    except Exception as exc:
        print("UNAVAILABLE: live chat retrieval failed:", repr(exc), file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
