#!/usr/bin/env python3
"""Read public EBC YouTube live chat and store special-livery leads (not confirmed flights).
Requires YOUTUBE_API_KEY; does not scrape YouTube or claim chat is available when it isn't.
"""
import json, os, re, sys, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

VIDEO_ID = "L9OqeSJgzKA"
OUT = Path("data/ebc_aircraft_chat_leads.json")
PATTERN = re.compile(r"ちいかわ|ポケモン|特別塗装|JA609A|JA819A|JA923A|NH\s*593|NH\s*599|飛来|ステイ", re.I)

def api(path, params):
    params["key"] = os.environ["YOUTUBE_API_KEY"]
    url = "https://www.googleapis.com/youtube/v3/" + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Matsuyama-aircraft-chat-watch/1.0"})
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)

def main():
    if not os.getenv("YOUTUBE_API_KEY"):
        print("NOT_CONFIGURED: YOUTUBE_API_KEY is missing", file=sys.stderr)
        return 2
    try:
        info = api("videos", {"part":"liveStreamingDetails", "id":VIDEO_ID})
        items = info.get("items", [])
        chat_id = items[0].get("liveStreamingDetails", {}).get("activeLiveChatId") if items else None
        if not chat_id:
            print("UNAVAILABLE: activeLiveChatId not provided (offline, restricted, or chat disabled)")
            return 3
        messages = api("liveChat/messages", {"part":"snippet,authorDetails", "liveChatId":chat_id, "maxResults":200})
        previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"leads":[]}
        leads = {item["message_id"]:item for item in previous.get("leads", [])}
        for item in messages.get("items", []):
            snippet = item.get("snippet", {})
            body = snippet.get("displayMessage", "")
            if not PATTERN.search(body): continue
            leads[item["id"]] = {
                "message_id":item["id"], "published_at":snippet.get("publishedAt"),
                "author":item.get("authorDetails",{}).get("displayName",""),
                "text":body, "video_id":VIDEO_ID,
                "status":"unverified_chat_lead", "verified_flight":False
            }
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({
            "source":"EBC Matsuyama Airport YouTube live chat",
            "video_url":"https://www.youtube.com/watch?v="+VIDEO_ID,
            "checked_at":datetime.now(timezone.utc).isoformat(),
            "status":"retrieved", "leads":list(leads.values())[-300:]
        }, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        print("OK: matching messages", len(leads))
        return 0
    except Exception as exc:
        print("UNAVAILABLE: chat retrieval failed:",str(exc),file=sys.stderr)
        return 1

if __name__=="__main__": sys.exit(main())
