#!/usr/bin/env python3
"""Monitor JR Shikoku official train announcements; never fabricate departures."""
from __future__ import annotations
import hashlib, json, re
from datetime import datetime, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/"data"/"jr_special_train_watch.json"
SOURCES={
 "jr_shikoku_press":"https://www.jr-shikoku.co.jp/03_news/press/info/",
 "jr_shikoku_home":"https://www.jr-shikoku.co.jp/",
 "iyonada_calendar":"https://iyonadamonogatari.com/timetable/",
}
KEYWORDS=("臨時列車","観光列車","サイクルトレイン","伊予灘ものがたり","松山","予讃線")
def main():
    old={}
    if OUT.exists():
        try: old=json.loads(OUT.read_text(encoding="utf-8"))
        except (ValueError,OSError): pass
    entries=[];failures=[]
    for key,url in SOURCES.items():
        try:
            response=requests.get(url,timeout=20,headers={"User-Agent":"Matsuyama-Wallpaper-Special-Train-Watch/1.0"})
            response.raise_for_status()
            soup=BeautifulSoup(response.content,"html.parser")
            for tag in soup(["script","style","nav","footer"]): tag.decompose()
            seen=set()
            for a in soup.find_all("a",href=True):
                title=" ".join(a.stripped_strings)
                if not (5<=len(title)<=180) or not any(w in title for w in KEYWORDS): continue
                href=requests.compat.urljoin(url,a["href"])
                if href in seen:continue
                seen.add(href)
                entries.append({"source":key,"title":title,"url":href})
        except (requests.RequestException,ValueError) as exc: failures.append({"source":key,"reason":str(exc)[:200]})
    if not entries:
        if failures: raise SystemExit("No official announcement information retrieved: "+str(failures))
        raise SystemExit("No matching official announcements (refusing to overwrite previous snapshot)")
    entries=sorted(entries,key=lambda e:(e["source"],e["url"]))
    old_urls={v.get("url") for v in old.get("announcements",[])}
    new=[v for v in entries if v["url"] not in old_urls]
    result={
      "checked_at_utc":datetime.now(timezone.utc).isoformat(),
      "source_urls":SOURCES,
      "announcements":entries,
      "new_announcements":new,
      "fetch_errors":failures,
      "note":"候補発見のみ。松山駅の発着時刻・運転日・経路を確認できるまで列車としては表示しない。"
    }
    OUT.parent.mkdir(parents=True,exist_ok=True)
    OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("Official announcement candidates:",len(entries),"new:",len(new),"errors:",len(failures))
    for x in new[:20]: print("NEW:",x["title"],x["url"])
if __name__=="__main__":main()
