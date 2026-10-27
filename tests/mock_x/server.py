"""A stand-in for x.com and X's image/video servers, for testing the extension.

Firefox is told (network.dns.localDomains) that x.com, twitter.com,
pbs.twimg.com and video.twimg.com all live on 127.0.0.1, and this server
answers for all of them on port 443:

- x.com/<anything>            a tiny single-page app that behaves like X: the
                              bookmarks page asks the GraphQL "Bookmarks" API
                              for its first page and renders <article>s.
- x.com/i/api/graphql/...     made-up bookmark pages in X's response shape.
- pbs.twimg.com/...           generated PNG thumbnails.
- video.twimg.com/...         a 2-second test video.
- x.com/__ctl?...             test control: set how many bookmarks there are,
                              make requests fail, rate-limit, be slow, etc.
- x.com/__log                 every API request made so far (JSON).

Run directly for manual poking:  sudo python3 server.py
"""

import io
import json
import os
import ssl
import sys
import threading
import time
import urllib.parse
import zlib
import struct
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TWITTER_EPOCH = 1288834974657
DAY = 86400000

USERS = ["alice", "bob_photos", "carol", "dave_vids", "eve", "frank99"]
TEXTS = [
    "Sunset over the bay 🌅 #photography",
    "New recipe: spicy noodles 🍜🔥",
    "Thread 🧵 about design systems — part 1",
    "<script>alert('xss')</script> look at this",
    "日本語のテキスト と emoji 🎌",
    "Plain text with a link https://t.co/abc123",
    "Ünïcödé çhàráctérs & \"quotes\" 'single'",
    "A very long post " + "lorem ipsum dolor sit amet " * 30,
]

DEFAULTS = {
    "total": 60,          # how many bookmarked posts exist
    "added": 0,           # extra newer bookmarks put on top (for the "top up" check)
    "fail": 0,            # HTTP status to answer every API call with (0 = fine)
    "fail_after": -1,     # answer `fail` only for requests after this many pages
    "reject_big": 0,      # answer 400 when count > 20
    "delay_ms": 0,        # wait before each API answer
    "page_delay_ms": 0,   # wait before serving the HTML page
    "transport": "xhr",   # how the fake page asks the API: "xhr" or "fetch"
    "rl_remaining": 450,  # x-rate-limit-remaining header
    "rate_limit_once": 0, # answer the first paged request with 429 once
    "bad_json": 0,        # answer with broken JSON
    "no_media_every": 6,  # every Nth post is text only
    "years_span_days": 5, # days between consecutive bookmarks
}

state = {"cfg": dict(DEFAULTS), "log": [], "rl_done": False, "t0": int(time.time() * 1000) - 2 * DAY}
lock = threading.Lock()


def cfg(k):
    return state["cfg"][k]


# --- made-up data -------------------------------------------------------------

def post_for(g):
    """Bookmark number g (0 = newest of the original set; negative = added later)."""
    pid = str(1790000000000000000 + (g + 1000) * 7919)
    saved = state["t0"] - g * cfg("years_span_days") * DAY
    posted = saved - (g % 9 + 1) * 3600000
    user = USERS[g % len(USERS)]
    text = TEXTS[g % len(TEXTS)] + f" #{g}"
    media = []
    n = cfg("no_media_every")
    if not (n and g % n == n - 1):
        if g % 7 == 3:
            vid = f"16{abs(g):08d}"
            media.append({
                "type": "video",
                "media_url_https": f"https://pbs.twimg.com/ext_tw_video_thumb/{vid}/pu/img/v{g}x.jpg",
                "expanded_url": f"https://x.com/{user}/status/{pid}/video/1",
                "original_info": {"width": 1280, "height": 720},
                "video_info": {"duration_millis": 2000, "variants": [
                    {"content_type": "application/x-mpegURL", "url": f"https://video.twimg.com/ext_tw_video/{vid}/pu/pl/x.m3u8"},
                    {"bitrate": 256000, "content_type": "video/mp4", "url": f"https://video.twimg.com/ext_tw_video/{vid}/pu/vid/480x270/a.mp4"},
                    {"bitrate": 832000, "content_type": "video/mp4", "url": f"https://video.twimg.com/ext_tw_video/{vid}/pu/vid/1280x720/b.mp4"},
                ]},
            })
        elif g % 11 == 4:
            media.append({
                "type": "animated_gif",
                "media_url_https": f"https://pbs.twimg.com/tweet_video_thumb/G{g}gif.jpg",
                "expanded_url": f"https://x.com/{user}/status/{pid}/photo/1",
                "original_info": {"width": 400, "height": 300},
                "video_info": {"variants": [{"bitrate": 0, "content_type": "video/mp4", "url": f"https://video.twimg.com/tweet_video/G{g}gif.mp4"}]},
            })
        else:
            for k in range(2 if g % 5 == 0 else 1):
                media.append({
                    "type": "photo",
                    "media_url_https": f"https://pbs.twimg.com/media/P{g}m{k}x.jpg",
                    "expanded_url": f"https://x.com/{user}/status/{pid}/photo/{k + 1}",
                    "original_info": {"width": 1200, "height": 800 if g % 2 else 1500},
                })
    legacy = {
        "created_at": time.strftime("%a %b %d %H:%M:%S +0000 %Y", time.gmtime(posted / 1000)),
        "full_text": text,
    }
    if media:
        legacy["extended_entities"] = {"media": media}
    return {
        "entryId": f"tweet-{pid}",
        "sortIndex": str((saved - TWITTER_EPOCH) << 22),
        "content": {"entryType": "TimelineTimelineItem", "itemContent": {"itemType": "TimelineTweet", "tweet_results": {"result": {
            "__typename": "Tweet", "rest_id": pid,
            "core": {"user_results": {"result": {"legacy": {"screen_name": user}}}},
            "legacy": legacy,
        }}}},
    }


def bookmarks_page(offset, count):
    first = -cfg("added")
    last = cfg("total") - 1
    start = first + offset
    entries = [post_for(g) for g in range(start, min(start + count, last + 1))]
    nxt = offset + len(entries)
    entries.append({"entryId": f"cursor-top-{offset}", "content": {"entryType": "TimelineTimelineCursor", "value": f"top{offset}", "cursorType": "Top"}})
    entries.append({"entryId": f"cursor-bottom-{nxt}", "content": {"entryType": "TimelineTimelineCursor", "value": f"cur{nxt}", "cursorType": "Bottom"}})
    return {"data": {"bookmark_timeline_v2": {"timeline": {"instructions": [{"type": "TimelineAddEntries", "entries": entries}]}}}}


# --- generated images -----------------------------------------------------------

_png_cache = {}


def png(seed, w=64, h=64):
    key = (seed, w, h)
    if key in _png_cache:
        return _png_cache[key]
    hv = zlib.crc32(seed.encode())
    r, g, b = hv & 255, (hv >> 8) & 255, (hv >> 16) & 255
    row = b"\x00" + bytes([r, g, b]) * w
    raw = row * h
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    _png_cache[key] = data
    return data


with open(os.path.join(HERE, "sample.mp4"), "rb") as f:
    MP4 = f.read()
with open(os.path.join(HERE, "app.html"), "rb") as f:
    APP_HTML = f.read()


# --- HTTP -------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="text/plain", headers=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.body = self.rfile.read(n).decode() if n else ""
        self.do_GET()

    def do_GET(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        u = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(u.query)
        if host == "pbs.twimg.com":
            if "missing" in u.path:
                return self.send(404, "no")
            return self.send(200, png(u.path), "image/png")
        if host == "video.twimg.com":
            return self.send(200, MP4, "video/mp4")
        if host not in ("x.com", "twitter.com"):
            return self.send(404, "unknown host")

        if u.path == "/__ctl":
            with lock:
                if "reset" in q:
                    state["cfg"] = dict(DEFAULTS)
                    state["log"] = []
                    state["rl_done"] = False
                    state["t0"] = int(time.time() * 1000) - 5 * DAY
                for k, v in q.items():
                    if k in DEFAULTS:
                        state["cfg"][k] = type(DEFAULTS[k])(v[0])
                if "clearlog" in q:
                    state["log"] = []
            return self.send(200, json.dumps(state["cfg"]), "application/json")
        if u.path == "/__log":
            return self.send(200, json.dumps(state["log"]), "application/json")

        if "/i/api/graphql/" in u.path:
            return self.api(u, q)

        if cfg("page_delay_ms"):
            time.sleep(cfg("page_delay_ms") / 1000)
        html = APP_HTML.replace(b"__TRANSPORT__", cfg("transport").encode())
        return self.send(200, html, "text/html; charset=utf-8")

    def api(self, u, q):
        variables = json.loads((q.get("variables") or ["{}"])[0])
        cursor = variables.get("cursor")
        count = int(variables.get("count") or 20)
        offset = int(cursor[3:]) if cursor and cursor.startswith("cur") else 0
        with lock:
            n = len(state["log"])
            state["log"].append({"path": u.path, "cursor": cursor, "count": count, "auth": self.headers.get("authorization"), "t": time.time()})
        if cfg("delay_ms"):
            time.sleep(cfg("delay_ms") / 1000)
        hdrs = {"x-rate-limit-remaining": str(cfg("rl_remaining")), "x-rate-limit-reset": str(int(time.time()) + 900)}
        if cfg("fail") and (cfg("fail_after") < 0 or n >= cfg("fail_after")):
            return self.send(cfg("fail"), json.dumps({"errors": [{"message": "fail"}]}), "application/json", hdrs)
        if cursor and cfg("rate_limit_once") and not state["rl_done"]:
            state["rl_done"] = True
            hdrs["x-rate-limit-reset"] = str(int(time.time()) + 1)
            return self.send(429, "{}", "application/json", hdrs)
        if cfg("reject_big") and count > 20:
            return self.send(400, json.dumps({"errors": [{"message": "count too big"}]}), "application/json", hdrs)
        if cfg("bad_json"):
            return self.send(200, "{not json", "application/json", hdrs)
        return self.send(200, json.dumps(bookmarks_page(offset, count)), "application/json", hdrs)


def make_server(port=443):
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.path.join(HERE, "certs/cert.pem"), os.path.join(HERE, "certs/key.pem"))
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    return srv


if __name__ == "__main__":
    s = make_server(int(sys.argv[1]) if len(sys.argv) > 1 else 443)
    print("mock X on", s.server_address)
    s.serve_forever()
