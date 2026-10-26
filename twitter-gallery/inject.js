// Runs inside the x.com page itself. When the bookmarks page loads its first
// batch of bookmarks, this remembers that request and then asks X for every
// following page the same way the page would (using your logged-in session),
// so all bookmarks load without scrolling. Media found in each page, including
// playable .mp4 links, is handed to content.js.
(() => {
  if (window.__xbgHooked) return;
  window.__xbgHooked = true;

  const BOOKMARK_API = /\/graphql\/[^/?]+\/(Bookmarks|BookmarkFolderTimeline|BookmarkSearchTimeline)\b/;
  // Ask for 100 bookmarks per request instead of the page's usual 20 (falls
  // back to the page's own size if X refuses), and pace requests by X's own
  // rate-limit headers instead of a fixed wait.
  const BIG_PAGE = 100;
  const MIN_DELAY_MS = 120;
  const origFetch = window.fetch;

  let template = null; // the page's own first bookmarks request: { key, url, method, headers, body }
  let pagingKey = null;
  const doneKeys = new Set(); // bookmark lists already fully loaded in this visit
  let lastStatus = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (msg) => window.postMessage({ __xbg: true, ...msg }, location.origin);
  const status = (s) => {
    lastStatus = s;
    post({ status: s });
  };

  // content.js may load after the first status was sent; it can ask again.
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__xbgAsk === "status" && lastStatus) post({ status: lastStatus });
  });

  // --- Reading media out of X's responses ---------------------------------

  function sized(url, name) {
    const m = url.match(/^(.*)\.(jpg|jpeg|png|webp)$/i);
    return m ? `${m[1]}?format=${m[2].toLowerCase()}&name=${name}` : url;
  }

  function keyOf(url) {
    return url.split("?")[0].replace(/^https?:\/\/[^/]+\//, "").replace(/\.[a-z0-9]+$/i, "");
  }

  function tweetUrl(media, tweet) {
    const m = (media.expanded_url || "").match(/^https:\/\/(?:x|twitter)\.com\/([^/]+\/status\/\d+)/);
    return m ? `https://x.com/${m[1]}` : `https://x.com/i/status/${tweet.rest_id}`;
  }

  // Bookmark entries carry a sortIndex that is a Twitter-style ID, which encodes
  // the moment the post was bookmarked. Only trust it if the result is sensible.
  function bookmarkTime(sortIndex, posted) {
    try {
      const t = Number((BigInt(sortIndex) >> 22n) + 1288834974657n);
      if (t > Date.now() + 86400000 || t < Date.UTC(2006, 0, 1)) return null;
      if (posted && t < posted - 60000) return null;
      return t;
    } catch (e) {
      return null;
    }
  }

  // X dates look like "Wed Oct 10 20:19:24 +0000 2018"; not every browser parses that.
  function parseTwitterDate(text) {
    if (typeof text !== "string") return null;
    const direct = Date.parse(text);
    if (!Number.isNaN(direct)) return direct;
    const m = text.match(/^\w+ (\w+) (\d+) (\d+:\d+:\d+) \+0000 (\d+)$/);
    return m ? Date.parse(`${m[1]} ${m[2]}, ${m[4]} ${m[3]} UTC`) || null : null;
  }

  function toItem(media, tweet, sortIndex) {
    const thumb = media.media_url_https;
    if (!thumb) return null;
    const posted = parseTwitterDate(tweet.legacy && tweet.legacy.created_at);
    const base = {
      key: keyOf(thumb),
      tweet: tweetUrl(media, tweet),
      thumb: sized(thumb, "small"),
      posted,
      saved: sortIndex ? bookmarkTime(sortIndex, posted) : null,
      w: (media.original_info && media.original_info.width) || null,
      h: (media.original_info && media.original_info.height) || null,
    };
    if (media.type === "photo") return { ...base, type: "photo", full: sized(thumb, "large") };
    const mp4s = ((media.video_info && media.video_info.variants) || [])
      .filter((v) => v.content_type === "video/mp4" && v.url)
      .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
    return {
      ...base,
      type: media.type === "animated_gif" ? "gif" : "video",
      full: sized(thumb, "large"),
      video: mp4s.length ? mp4s[mp4s.length - 1].url : null,
    };
  }

  // Walk the whole response rather than one fixed path, so small changes to
  // X's response layout don't break the extension.
  function parse(root) {
    const items = [];
    const seen = new Set();
    let cursor = null;
    let posts = 0;
    const walk = (node, depth, sortIndex) => {
      if (!node || typeof node !== "object" || depth > 80) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1, sortIndex);
        return;
      }
      if (typeof node.entryId === "string" && node.entryId.startsWith("tweet-")) {
        posts++;
        if (typeof node.sortIndex === "string") sortIndex = node.sortIndex;
      }
      if (node.cursorType === "Bottom" && typeof node.value === "string") cursor = node.value;
      const media = node.legacy && node.legacy.extended_entities && node.legacy.extended_entities.media;
      if (node.rest_id && Array.isArray(media)) {
        for (const m of media) {
          const item = toItem(m, node, sortIndex);
          if (item && !seen.has(item.key)) {
            seen.add(item.key);
            items.push(item);
          }
        }
      }
      for (const k in node) walk(node[k], depth + 1, sortIndex);
    };
    walk(root, 0, null);
    return { items, cursor, posts };
  }

  function publish(json) {
    const page = parse(json);
    if (page.items.length) post({ items: page.items });
    return page;
  }

  // --- Loading every page -------------------------------------------------

  function plainHeaders(h) {
    const out = {};
    if (!h) return out;
    if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k] = v));
    else Object.assign(out, h);
    return out;
  }

  function requestKey(url) {
    const u = new URL(url, location.origin);
    return u.pathname.split("/").pop() + "|" + (u.searchParams.get("variables") || "").replace(/"cursor":"[^"]*",?/, "");
  }

  function withCursor(tpl, cursor, count) {
    const u = new URL(tpl.url, location.origin);
    let body = tpl.body;
    const set = (vars) => {
      vars.cursor = cursor;
      if (count) vars.count = count;
      return vars;
    };
    if (u.searchParams.has("variables")) {
      u.searchParams.set("variables", JSON.stringify(set(JSON.parse(u.searchParams.get("variables")))));
    } else if (typeof body === "string") {
      const parsed = JSON.parse(body);
      parsed.variables = set({ ...(parsed.variables || {}) });
      body = JSON.stringify(parsed);
    }
    return { url: u.toString(), body };
  }

  // How long to wait before the next request, from X's rate-limit headers:
  // quick while plenty of requests are left, spread out as they run low.
  function nextDelay(res) {
    const left = Number(res.headers.get("x-rate-limit-remaining"));
    const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
    if (!Number.isFinite(left) || !reset || res.headers.get("x-rate-limit-remaining") === null) return 400;
    if (left > 20) return MIN_DELAY_MS;
    const untilReset = Math.max(reset - Date.now(), 0);
    return Math.min(Math.max(untilReset / Math.max(left, 1), MIN_DELAY_MS), 60000);
  }

  async function loadAll(tpl, cursor, firstPosts) {
    if (pagingKey === tpl.key) return;
    pagingKey = tpl.key;
    const used = new Set();
    let pages = 1;
    let posts = firstPosts || 0;
    let retries = 0;
    let big = true; // using BIG_PAGE until X refuses it
    status({ state: "loading", pages, posts });
    try {
      while (cursor && !used.has(cursor) && template === tpl) {
        used.add(cursor);
        const req = withCursor(tpl, cursor, big ? BIG_PAGE : 0);
        const res = await origFetch(req.url, {
          method: tpl.method,
          headers: tpl.headers,
          body: tpl.method === "GET" ? undefined : req.body,
          credentials: "include",
        });
        if (res.status === 429 && retries < 3) {
          // Too many requests: wait for X's rate limit to reset, then retry.
          retries++;
          used.delete(cursor);
          const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
          const wait = reset ? Math.min(Math.max(reset - Date.now(), 5000), 120000) : 30000;
          status({ state: "waiting", pages, posts, seconds: Math.round(wait / 1000) });
          await sleep(wait);
          continue;
        }
        if (!res.ok && big && res.status >= 400 && res.status < 500) {
          // X didn't like the bigger page: carry on at the page's own size.
          big = false;
          used.delete(cursor);
          continue;
        }
        if (!res.ok) throw new Error(`X answered ${res.status}`);
        const page = publish(await res.json());
        pages++;
        posts += page.posts;
        retries = 0;
        status({ state: "loading", pages, posts });
        if (!page.posts) break;
        cursor = page.cursor;
        await sleep(nextDelay(res));
      }
      if (template === tpl) {
        doneKeys.add(tpl.key);
        status({ state: "done", pages, posts });
      }
    } catch (e) {
      status({ state: "failed", posts, error: String((e && e.message) || e) });
    } finally {
      if (pagingKey === tpl.key) pagingKey = null;
    }
  }

  // Called for every bookmarks response the page itself receives.
  function onPageResponse(json, req) {
    const page = publish(json);
    const key = requestKey(req.url);
    const isFirstPage = !/"cursor":/.test(new URL(req.url, location.origin).searchParams.get("variables") || req.body || "");
    if (!isFirstPage || pagingKey === key || doneKeys.has(key)) return;
    template = { ...req, key };
    if (page.cursor && page.posts) loadAll(template, page.cursor, page.posts);
    else status({ state: "done", pages: 1, posts: page.posts });
  }

  // --- Hooks on the page's network calls ----------------------------------

  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const [input, init = {}] = args;
      const url = String(input instanceof Request ? input.url : input);
      if (BOOKMARK_API.test(url)) {
        const req = {
          url,
          method: (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase(),
          headers: { ...plainHeaders(input instanceof Request ? input.headers : null), ...plainHeaders(init.headers) },
          body: typeof init.body === "string" ? init.body : null,
        };
        res.clone().json().then((json) => onPageResponse(json, req), () => {});
      }
    } catch (e) {
      /* never break the page */
    }
    return res;
  };

  const xhr = XMLHttpRequest.prototype;
  const origOpen = xhr.open;
  const origSetHeader = xhr.setRequestHeader;
  const origSend = xhr.send;
  xhr.open = function (method, url, ...rest) {
    this.__xbg = { method: String(method).toUpperCase(), url: String(url), headers: {} };
    return origOpen.call(this, method, url, ...rest);
  };
  xhr.setRequestHeader = function (name, value) {
    if (this.__xbg) this.__xbg.headers[name] = value;
    return origSetHeader.call(this, name, value);
  };
  xhr.send = function (body) {
    const req = this.__xbg;
    if (req && BOOKMARK_API.test(req.url)) {
      req.body = typeof body === "string" ? body : null;
      this.addEventListener("load", () => {
        try {
          if (this.status !== 200) return;
          const json = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          onPageResponse(json, req);
        } catch (e) {
          /* ignore */
        }
      });
    }
    return origSend.call(this, body);
  };
})();
