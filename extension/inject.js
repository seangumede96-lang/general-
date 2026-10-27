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
  // Huge libraries take a long time (X allows about 500 requests per 15
  // minutes), so the place reached is remembered: if the tab is closed or
  // reloaded, the next visit carries on from there instead of starting over.
  const RESUME_KEY = "xbg_resume";
  const RESUME_MAX_AGE = 24 * 3600000;

  function readResume(key) {
    try {
      const r = JSON.parse(localStorage.getItem(RESUME_KEY) || "null");
      return r && r.key === key && typeof r.cursor === "string" && Date.now() - r.at < RESUME_MAX_AGE ? r : null;
    } catch (e) {
      return null;
    }
  }

  function writeResume(r) {
    try {
      if (r) localStorage.setItem(RESUME_KEY, JSON.stringify({ ...r, at: Date.now() }));
      else localStorage.removeItem(RESUME_KEY);
    } catch (e) {
      /* private mode etc. */
    }
  }
  const origFetch = window.fetch;

  let template = null; // the page's own first bookmarks request: { key, url, method, headers, body, first }
  let pagingKey = null;
  let pagingQuick = false; // the load running now is only a quick top-up
  let restartFull = false; // asked to reload everything while a top-up was running
  const doneKeys = new Set(); // bookmark lists already fully loaded in this visit
  let lastStatus = null;
  // For the gallery's "Check the connection to X".
  let lastOk = 0; // when X last sent a page of bookmarks
  let lastError = null; // { at, status } of the last refused request
  const noteError = (status) => (lastError = { at: Date.now(), status: Number(status) || 0 });
  let paused = false; // "Pause" in the gallery: the full load waits until "Continue"
  let resumeWaiters = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (msg) => window.postMessage({ __xbg: true, ...msg }, location.origin);
  // `main`: the load is of your main bookmarks (not a bookmark folder), so
  // content.js may save it even if you've moved to another page meanwhile.
  const status = (s) => {
    lastStatus = { ...s, main: !!template && template.key.startsWith("Bookmarks|") };
    post({ status: lastStatus });
  };

  // content.js says how to load: "quick" (only fetch until we reach posts it
  // already has saved) or "full". It answers within a moment of the page
  // loading; without an answer we do a full load.
  let plan = null;
  let planWaiters = [];
  const getPlan = () =>
    plan ? Promise.resolve(plan) : new Promise((r) => {
      planWaiters.push(r);
      setTimeout(() => r(plan || { mode: "full" }), 30000);
    });

  // Where each page of the current load started, so a later visit can carry on
  // from the last point content.js actually saved (it says so with "saved").
  let checkpoints = []; // [{ key, posts, pages, cursor }]

  // content.js may load after the first status was sent; it can ask again.
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__xbgAsk === "status" && lastStatus) post({ status: lastStatus });
    if (e.data.__xbgAsk === "check") post({ check: { sawRequest: !!template, lastOk, lastError, state: lastStatus && lastStatus.state } });
    if (e.data.__xbgAsk === "pause") paused = true;
    if (e.data.__xbgAsk === "resume") {
      paused = false;
      resumeWaiters.forEach((r) => r());
      resumeWaiters = [];
    }
    if (e.data.__xbgPlan && typeof e.data.__xbgPlan.mode === "string") {
      plan = { mode: e.data.__xbgPlan.mode, known: new Set(e.data.__xbgPlan.known || []) };
      planWaiters.forEach((r) => r(plan));
      planWaiters = [];
    }
    if (e.data.__xbgAsk === "saved" && Number.isFinite(e.data.posts)) {
      const cp = checkpoints.filter((c) => c.posts <= e.data.posts).pop();
      if (cp) writeResume(cp);
    }
    // "Reload all bookmarks": from now on load everything, and if we're on the
    // bookmarks already, start again from the first page without a page load.
    if (e.data.__xbgAsk === "reload") {
      plan = { mode: "full", known: new Set() };
      planWaiters.forEach((r) => r(plan));
      planWaiters = [];
      doneKeys.clear();
      if (!e.data.now || !template || !template.first) return;
      if (pagingKey === template.key) restartFull = pagingQuick;
      else startFromFirst(template);
    }
  });

  function startFromFirst(tpl) {
    const f = tpl.first;
    if (f.cursor && f.posts) loadAll(tpl, f.cursor, f.posts, readResume(tpl.key), f.items);
    else status({ state: "done", pages: 1, posts: f.posts });
  }

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

  // What the post says (long posts keep their full text elsewhere), without t.co links.
  function postText(tweet) {
    const long = tweet.note_tweet && tweet.note_tweet.note_tweet_results && tweet.note_tweet.note_tweet_results.result;
    const text = (long && long.text) || (tweet.legacy && tweet.legacy.full_text) || "";
    return text.replace(/https:\/\/t\.co\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  }

  // The best quality up to 720p (the short side), which looks sharp on a phone
  // and loads far faster than 1080p. Falls back to the best there is.
  function pickVideo(mp4s) {
    if (!mp4s.length) return null;
    const shortSide = (v) => {
      const m = /\/(\d+)x(\d+)\//.exec(v.url);
      return m ? Math.min(+m[1], +m[2]) : null;
    };
    const fits = mp4s.filter((v) => { const s = shortSide(v); return s && s <= 720; });
    return (fits.length ? fits[fits.length - 1] : mp4s[mp4s.length - 1]).url;
  }

  function toItem(media, tweet, sortIndex) {
    const thumb = media.media_url_https;
    if (!thumb) return null;
    const posted = parseTwitterDate(tweet.legacy && tweet.legacy.created_at);
    const base = {
      key: keyOf(thumb),
      tweet: tweetUrl(media, tweet),
      thumb: sized(thumb, "360x360"),
      posted,
      saved: sortIndex ? bookmarkTime(sortIndex, posted) : null,
      text: postText(tweet),
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
      video: pickVideo(mp4s),
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

  async function loadAll(tpl, cursor, firstPosts, resumeFrom, firstItems) {
    if (pagingKey === tpl.key) return;
    pagingKey = tpl.key;
    const p = await getPlan();
    const quick = p.mode === "quick" && !resumeFrom;
    pagingQuick = quick;
    if (quick) {
      // Top up only: stop once two pages in a row bring nothing new.
      // Only posts with pictures or videos matter to the gallery: compare those.
      const newIn = (items) => items.filter((it) => { const m = /\/status\/(\d+)/.exec(it.tweet || ""); return m && !p.known.has(m[1]); }).length;
      let fresh = newIn(firstItems || []);
      let quiet = fresh ? 0 : 1;
      let posts = firstPosts || 0;
      let pages = 1;
      let big = true;
      status({ state: "checking", pages, posts, fresh });
      try {
        while (cursor && quiet < 2 && template === tpl && pages < 400 && !restartFull) {
          const req = withCursor(tpl, cursor, big ? BIG_PAGE : 0);
          const res = await origFetch(req.url, { method: tpl.method, headers: tpl.headers, body: tpl.method === "GET" ? undefined : req.body, credentials: "include" });
          if (!res.ok && big && res.status >= 400 && res.status < 500 && res.status !== 429) {
            // X didn't like the bigger page: ask again at the page's own size.
            big = false;
            continue;
          }
          if (!res.ok) {
            noteError(res.status);
            break;
          }
          const page = publish(await res.json());
          lastOk = Date.now();
          pages++;
          posts += page.posts;
          const n = newIn(page.items);
          fresh += n;
          quiet = n ? 0 : quiet + 1;
          status({ state: "checking", pages, posts, fresh });
          if (!page.posts) break;
          cursor = page.cursor;
          await sleep(nextDelay(res));
        }
      } catch (e) {
        /* the saved copy still stands */
      }
      if (pagingKey === tpl.key) pagingKey = null;
      if (restartFull) {
        restartFull = false;
        if (template === tpl) startFromFirst(tpl);
        return;
      }
      if (template === tpl) {
        doneKeys.add(tpl.key);
        status({ state: "done", quick: true, pages, posts, fresh });
      }
      return;
    }
    const used = new Set();
    const resumed = !!resumeFrom;
    let pages = resumed ? resumeFrom.pages : 1;
    let posts = resumed ? resumeFrom.posts : firstPosts || 0;
    if (resumed) cursor = resumeFrom.cursor;
    checkpoints = [];
    let retries = 0;
    let big = true; // using BIG_PAGE until X refuses it
    status({ state: "loading", pages, posts, resumed });
    try {
      while (cursor && !used.has(cursor) && template === tpl) {
        if (paused) {
          status({ state: "paused", pages, posts, resumed });
          await new Promise((r) => resumeWaiters.push(r));
          if (template !== tpl) break;
          status({ state: "loading", pages, posts, resumed });
        }
        used.add(cursor);
        const req = withCursor(tpl, cursor, big ? BIG_PAGE : 0);
        const res = await origFetch(req.url, {
          method: tpl.method,
          headers: tpl.headers,
          body: tpl.method === "GET" ? undefined : req.body,
          credentials: "include",
        });
        if (!res.ok) noteError(res.status);
        if (res.status === 429 && retries < 8) {
          // Too many requests: wait until X's limit resets (up to ~16 minutes), then carry on.
          retries++;
          used.delete(cursor);
          const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
          const wait = reset ? Math.min(Math.max(reset - Date.now() + 2000, 5000), 16 * 60000) : 60000;
          const until = Date.now() + wait;
          while (Date.now() < until && template === tpl) {
            status({ state: "waiting", pages, posts, resumed, seconds: Math.round((until - Date.now()) / 1000) });
            await sleep(Math.min(5000, until - Date.now()));
          }
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
        lastOk = Date.now();
        pages++;
        posts += page.posts;
        retries = 0;
        status({ state: "loading", pages, posts, resumed });
        if (!page.posts) break;
        cursor = page.cursor;
        if (cursor) checkpoints.push({ key: tpl.key, cursor, posts, pages });
        await sleep(nextDelay(res));
      }
      if (template === tpl) {
        doneKeys.add(tpl.key);
        writeResume(null);
        status({ state: "done", pages, posts, resumed });
      }
    } catch (e) {
      status({ state: "failed", posts, resumed, error: String((e && e.message) || e) });
    } finally {
      if (pagingKey === tpl.key) pagingKey = null;
    }
  }

  // Called for every bookmarks response the page itself receives.
  function onPageResponse(json, req) {
    lastOk = Date.now();
    const page = publish(json);
    const key = requestKey(req.url);
    const isFirstPage = !/"cursor":/.test(new URL(req.url, location.origin).searchParams.get("variables") || req.body || "");
    if (!isFirstPage || pagingKey === key || doneKeys.has(key)) return;
    template = { ...req, key, first: { cursor: page.cursor, posts: page.posts, items: page.items } };
    startFromFirst(template);
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
        if (!res.ok) noteError(res.status);
        else res.clone().json().then((json) => onPageResponse(json, req), () => noteError(0));
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
          if (this.status !== 200) return void noteError(this.status);
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
