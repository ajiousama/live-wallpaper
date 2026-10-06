from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import update_gamble

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "gamble" / "data.json"
PORT = int(os.environ.get("PORT", "10000"))
TARGET_INTERVAL = 60.0

lock = threading.Lock()
cached = b"{}"
last_ok = 0.0
last_error = ""


def refresh_cache_from_disk() -> None:
    global cached
    try:
        raw = DATA.read_bytes()
        json.loads(raw)
    except Exception:
        return
    with lock:
        cached = raw


def updater() -> None:
    global last_ok, last_error
    while True:
        started = time.monotonic()
        try:
            update_gamble.main()
            refresh_cache_from_disk()
            last_ok = time.time()
            last_error = ""
        except Exception as exc:
            last_error = str(exc)
            print(f"[GAMBLE-LIVE] update failed: {exc}", flush=True)
        elapsed = time.monotonic() - started
        time.sleep(max(2.0, TARGET_INTERVAL - elapsed))


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send(204, b"", "text/plain; charset=utf-8")

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] in {"/", "/health"}:
            age = None if not last_ok else max(0, int(time.time() - last_ok))
            body = json.dumps(
                {"ok": True, "last_update_age_sec": age, "last_error": last_error},
                ensure_ascii=False,
            ).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
            return

        if self.path.split("?", 1)[0] in {"/data.json", "/gamble/data.json"}:
            with lock:
                body = cached
            self._send(200, body, "application/json; charset=utf-8")
            return

        self._send(404, b'{"error":"not found"}', "application/json; charset=utf-8")

    def log_message(self, fmt: str, *args) -> None:
        return


def main() -> None:
    refresh_cache_from_disk()
    threading.Thread(target=updater, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[GAMBLE-LIVE] listening on :{PORT}, target interval={TARGET_INTERVAL:.0f}s", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
