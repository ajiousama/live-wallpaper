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
import urllib.error
import unicodedata
from bs4 import BeautifulSoup

JST = dt.timezone(dt.timedelta(hours=9))
THEATERS = {
    "shigenobu": ("重信", "70088", "https://www.cinemasunshine.co.jp/theater/shigenobu/"),
    "masaki": ("エミフルMASAKI", "70115", "https://www.cinemasunshine.co.jp/theater/masaki/"),
    "kinuyama": ("衣山", "70073", "https://www.cinemasunshine.co.jp/theater/kinuyama/"),
    "lunatic": ("シネマルナティック", "70097", "https://cinemalunatic.sx3.jp/"),
    "imabari": ("イオンシネマ今治新都市", "70121", "https://theater.aeoncinema.com/theaters/imabari/"),
    "niihama": ("TOHOシネマズ 新居浜", "70086", "https://www.tohotheater.jp/theater/048/"),
}
LUNATIC_LAST_DAY = dt.date(2026, 11, 24)
CORE_THEATERS = frozenset(("shigenobu", "masaki", "kinuyama"))
SOURCE = "https://www.crank-in.net/theater/search/all/38/"
LUNATIC_SUPPLEMENT = "https://eiga.com/theater/38/380101/6058/"
EIGA_DATE = re.compile(r"(?<!\d)(\d{1,2})/(\d{1,2})\s*[（(][月火水木金土日][）)]")
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
        # Use only the verified release date printed next to this work.
        # Do not infer a premiere from the first day available in the listing.
        release_date = None
        release_match = re.match(r"^(20\d{2})年(\d{1,2})月(\d{1,2})日", lines[release_i])
        if release_match:
            try:
                release_date = dt.date(*map(int, release_match.groups())).isoformat()
            except ValueError:
                pass
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
                              "title": title, "durationMinutes": duration,
                              "releaseDate": release_date})
    unique = {(x["date"],x["time"],x["title"]):x for x in shows}
    sorted_rows = sorted(unique.values(), key=lambda x:(x["date"],x["time"],x["title"]))
    if valid_titles < 2 or len(sorted_rows) < 3:
        raise ValueError(f"Insufficient verified showtimes: films={valid_titles}, sessions={len(sorted_rows)}")
    return sorted_rows


def parse_lunatic_supplement(html, today):
    """Parse the second, cinema-specific listing only where a film and date
    are explicitly present. Missing source data never creates fake screenings.
    Each work on eiga.com is a separate section with an h2 title and daily cells.
    """
    soup = BeautifulSoup(html, "html.parser")
    if "シネマルナティック" not in soup.get_text(" ", strip=True):
        raise ValueError("Alternative theater identity missing")
    shows = []
    for heading in soup.find_all("h2"):
        section = heading.parent
        if section.name != "section":
            continue
        title = heading.get_text(" ", strip=True)
        if not title or len(title) > 180:
            continue
        text = section.get_text(" ", strip=True)
        day_marks = list(EIGA_DATE.finditer(text))
        if len(day_marks) < 3:
            continue
        # A release date is usable as a premiere marker ONLY if its year is shown.
        details = text[:day_marks[0].start()]
        release = re.search(r"(20\d{2})年(\d{1,2})月(\d{1,2})日公開", details)
        release_date = None
        if release:
            try:
                release_date = dt.date(*map(int, release.groups())).isoformat()
            except ValueError:
                pass
        duration = re.search(r"(?<!\d)(\d{2,3})\s*分", details)
        minutes = int(duration.group(1)) if duration else None
        for i,mark in enumerate(day_marks):
            month,day = map(int, mark.groups())
            year = today.year + (1 if today.month == 12 and month == 1 else 0)
            try:
                screening_date = dt.date(year,month,day)
            except ValueError:
                continue
            if not today <= screening_date <= today + dt.timedelta(days=4):
                continue
            if screening_date > LUNATIC_LAST_DAY:
                continue
            end = day_marks[i+1].start() if i+1 < len(day_marks) else len(text)
            block = text[mark.end():end]
            for hour,minute in TIMES.findall(block):
                shows.append({
                    "date": screening_date.isoformat(),
                    "time": f"{int(hour):02d}:{minute}",
                    "title": title,
                    "durationMinutes": minutes,
                    "releaseDate": release_date
                })
    if not shows:
        raise ValueError("No dated sessions verified in alternative theater listing")
    return shows


def cinema_title_key(title):
    # Resolve presentation-only differences in the two source listings.
    title = re.sub(r"《(?:字幕|吹替)版》", "", str(title))
    title = unicodedata.normalize("NFKC", title)
    return re.sub(r"[\s・!！、,.。/／:：]+", "", title).casefold()


def merge_cinema_sessions(primary, supplement):
    titles = {}
    for r in primary:
        titles.setdefault(cinema_title_key(r["title"]), r["title"])
    merged = {}
    for r in primary + supplement:
        canon = cinema_title_key(r["title"])
        label = titles.setdefault(canon, r["title"])
        row = dict(r, title=label)
        key = (row["date"], row["time"], canon)
        if key not in merged:
            merged[key] = row
        elif row.get("releaseDate") and not merged[key].get("releaseDate"):
            merged[key]["releaseDate"] = row["releaseDate"]
        if key in merged and row.get("durationMinutes") and not merged[key].get("durationMinutes"):
            merged[key]["durationMinutes"] = row["durationMinutes"]
    return sorted(merged.values(), key=lambda r:(r["date"],r["time"],r["title"]))


def build(today, fetch=listing):
    result = {"generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "timezone": "Asia/Tokyo", "date": today.isoformat(),
              "source": "crank-in.net (third-party listing; verify with the theater)",
              "theaters": {}}
    for slug,(name,number,official) in THEATERS.items():
        # Official venue notice: the last day is 2026-11-24.
        # Do not request or publish any post-closure screenings.
        if slug == "lunatic" and today > LUNATIC_LAST_DAY:
            continue
        url = SOURCE + number
        try:
            records = parse_listing(fetch(url), name, today)
        except (OSError, ValueError, TimeoutError, urllib.error.URLError) as exc:
            if slug in CORE_THEATERS:
                # Preserve the existing strict validation for the original
                # three theaters: a partial failure must not overwrite them.
                raise
            # A temporary failure in either newly adopted theater must not
            # suspend refreshes of the already-working cinemas.
            print(f"{name}: first source unavailable ({exc})", file=sys.stderr)
            records = []

        secondary_url = None
        if slug == "lunatic":
            secondary_url = LUNATIC_SUPPLEMENT
            try:
                extra = parse_lunatic_supplement(fetch(secondary_url), today)
                records = merge_cinema_sessions(records, extra)
                print(f"{name}: verified +{len(extra)} secondary sessions", file=sys.stderr)
            except (OSError, ValueError, TimeoutError, urllib.error.URLError) as exc:
                print(f"{name}: secondary source unavailable ({exc})", file=sys.stderr)
            records = [x for x in records
                       if x["date"] <= LUNATIC_LAST_DAY.isoformat()]
        result["theaters"][slug] = {
            "name": name, "officialUrl": official, "listingUrl": url,
            **({"secondaryListingUrl": secondary_url} if secondary_url else {}),
            "shows": records, "status": "ok" if records else "unavailable"
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
