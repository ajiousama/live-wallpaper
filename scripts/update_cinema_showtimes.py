#!/usr/bin/env python3
"""Generate factual, date-scoped Matsuyama cinema showtimes from public listings.

No fabricated rows: on a missing or stale source, exit nonzero without replacing
the last verified snapshot. The browser independently rejects old snapshots.
"""
import argparse
import datetime as dt
import json
import pathlib
import re
import sys
import urllib.request
from bs4 import BeautifulSoup

JST = dt.timezone(dt.timedelta(hours=9))
THEATERS = {
    "shigenobu": ("重信", "70088", "https://www.cinemasunshine.co.jp/theater/shigenobu/"),
    "masaki": ("エミフルMASAKI", "70115", "https://www.cinemasunshine.co.jp/theater/masaki/"),
    "kinuyama": ("衣山", "70073", "https://www.cinemasunshine.co.jp/theater/kinuyama/"),
}
SOURCE = "https://www.crank-in.net/theater/search/all/38/"
RELEASE = re.compile(r"^20\d{2}年\d{1,2}月\d{1,2}日.+公開")
DURATION = re.compile(r"^上映時間[:：]\s*(\d+)\s*分")
DATE = re.compile(r"^(\d{1,2})月(\d{1,2})日(?:\s*[（(][月火水木金土日][）)])?$")
TIMES = re.compile(r"(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)")


def listing(url):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; MatsuyamaCinemaBoard/1.0)",
                 "Accept": "text/html"},
    )
    with urllib.request.urlopen(request, timeout=18) as response:
        html = response.read(2_500_000).decode("utf-8", "replace")
    if len(html) < 3500:
        raise ValueError("Listing HTML unexpectedly short")
    return html


def parse_listing(html, theater_name, today):
    soup = BeautifulSoup(html, "html.parser")
    for el in soup(["script", "style", "noscript", "svg"]):
        el.decompose()
    lines = [re.sub(r"\s+", " ", x).strip()
             for x in soup.stripped_strings]
    lines = [x for x in lines if x]
    # Reject site-level errors and other theater responses, even if they contain times.
    if theater_name not in " ".join(lines[:90]):
        raise ValueError(f"Theater identity not verified: {theater_name}")
    try:
        start = next(i for i, x in enumerate(lines) if "上映作品・スケジュール" in x)
    except StopIteration:
        raise ValueError("Schedule section unavailable") from None
    lines = lines[start + 1:]
    end = next((i for i,x in enumerate(lines)
                if "※記載の上映スケジュール" in x or "最新情報は劇場の公式" in x),
               len(lines))
    lines = lines[:end]
    shows = []
    valid_titles = 0
    # A movie appears as title, '2026年...公開', '上映時間：...分', then date/time rows.
    releases = [i for i,line in enumerate(lines) if RELEASE.match(line)]
    for k, release_i in enumerate(releases):
        title = lines[release_i-1].strip(" #") if release_i >= 1 else ""
        stop = releases[k+1]-1 if k+1 < len(releases) else len(lines)
        if not title or len(title)>180 or "アクセス" in title:
            continue
        duration = next((int(m.group(1)) for x in lines[release_i+1:min(release_i+6, stop)]
                         if (m:=DURATION.match(x))), None)
        if duration is None:
            continue
        valid_titles += 1
        target_date = None
        for line in lines[release_i+1:stop]:
            dm = DATE.match(line)
            if dm:
                mo,day = map(int, dm.groups())
                year = today.year + (1 if today.month == 12 and mo == 1 else 0)
                try:
                    target_date = dt.date(year,mo,day)
                except ValueError:
                    target_date = None
                continue
            if target_date is None or not today <= target_date <= today+4*dt.timedelta(days=1):
                continue
            if line.startswith(("上映時間","作品詳細","映画館","公式","アクセス")):
                continue
            # Reject unrelated prose containing arbitrary times; schedule entries are
            # just time tokens and separators on the listing.
            if re.sub(TIMES, "", line).strip(" 　,、-/～〜－") not in ("", "（字幕）", "（吹替）"):
                continue
            for h,minute in TIMES.findall(line):
                time = f"{int(h):02d}:{minute}"
                shows.append({"date": target_date.isoformat(), "time": time,
                              "title": title, "durationMinutes": duration})
    unique = {(x["date"],x["time"],x["title"]):x for x in shows}
    sorted_rows = sorted(unique.values(), key=lambda x:(x["date"],x["time"],x["title"]))
    if valid_titles < 2 or len(sorted_rows) < 3:
        raise ValueError(f"Insufficient verified showtimes: films={valid_titles}, sessions={len(sorted_rows)}")
    return sorted_rows


def build(today, fetch=listing):
    result = {"generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "timezone": "Asia/Tokyo", "date": today.isoformat(),
              "source": "crank-in.net (third-party listing; verify with the theater)",
              "theaters": {}}
    for slug,(name,number,official) in THEATERS.items():
        url = SOURCE + number
        records = parse_listing(fetch(url), name, today)
        result["theaters"][slug] = {
            "name": name, "officialUrl": official, "listingUrl": url, "shows": records
        }
        print(f"{name}: {len(records)} sessions / {len(set(x['title'] for x in records))} films",
              file=sys.stderr)
    return result


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--output",default="transport/cinema/showtimes.json")
    ap.add_argument("--date",help="Local date YYYY-MM-DD for tests")
    args=ap.parse_args()
    today=dt.date.fromisoformat(args.date) if args.date else dt.datetime.now(JST).date()
    result=build(today)
    path=pathlib.Path(args.output)
    path.parent.mkdir(parents=True,exist_ok=True)
    content=json.dumps(result,ensure_ascii=False,indent=2)+"\n"
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return
    path.write_text(content,encoding="utf-8")

if __name__ == "__main__":
    main()
