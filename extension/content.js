// Shows the media from your X bookmarks in a full-screen grid, with
// Instagram-style collections, sorting, and month/year views.
// inject.js loads every page of bookmarks in the background and sends the media
// here. If X refuses those requests, this falls back to scrolling the bookmarks
// page behind the gallery (and reading posts off the screen) while it is open.
// The last full load is kept as a saved copy, so the gallery opens instantly.
(() => {
  const ext = globalThis.browser || chrome;
  const store = ext.storage.local;

  const fresh = new Map(); // key -> item loaded during this visit, in bookmark order
  const cached = new Map(); // key -> item from the saved copy, shown until loading finishes
  const savedItems = new Map(); // key -> item, for every post in a collection
  let collections = []; // [{ id, name, keys: [newest first] }]
  let settings = { fab: true, ball: { side: "right", y: 0.6 }, sort: "newest", dateMode: "saved", layout: "grid", theme: "dark", headerHidden: false, filtersHidden: false, toggleBtn: { side: "right", y: 0.75 } };
  let cacheTime = 0;
  let lastTotal = 0; // how many bookmarks the last full load found, to show progress next time
  let partialInfo = null; // { posts, at } while an unfinished long load's progress is all that's saved

  let view = "all"; // "all" | "collections" | "collection"
  let openId = null; // collection shown when view === "collection"
  let filter = "all";
  let searchText = ""; // words to look for in the post text or the poster's @name
  let searchTerms = [];
  let periodYear = null; // Months view: only this year ("2026"), or all years when null
  let periodMonth = null; // Months view: only this month ("2026-01"), or the whole year when null
  let periods = { years: [], months: [] }; // what the period bar offers
  let entries = []; // what the grid shows: { item } or { header, label, count }
  let current = []; // the items in `entries`, in order (for the full-screen viewer)
  let totalCount = 0;
  const headerEls = new Map();
  let feedStart = 0; // the feed shows current[feedStart .. feedEnd)
  let feedEnd = 0;
  let ui = null;
  let ball = null;
  let gotData = false; // inject.js has delivered media during this visit
  let loadState = { state: "idle" };
  let scrollTimer = null;
  let selectMode = false;
  const selected = new Set();

  const SAFE_MEDIA = /^https:\/\/(pbs|video)\.twimg\.com\//;
  const SAFE_TWEET = /^https:\/\/x\.com\/[^\s"'<>]+$/;
  const K = { collections: "xbg_collections", items: "xbg_items", settings: "xbg_settings", cache: "xbg_cache" };

  const isBookmarks = () => location.pathname.startsWith("/i/bookmarks");
  const isMainBookmarks = () => location.pathname.replace(/\/$/, "") === "/i/bookmarks";
  const galleryOpen = () => ui && !ui.overlay.classList.contains("xbg-hidden");
  const getItem = (key) => fresh.get(key) || cached.get(key) || savedItems.get(key);
  const getCollection = (id) => collections.find((c) => c.id === id);
  let savedSet = null; // every key in any collection; rebuilt after changes
  const isSaved = (key) => (savedSet || (savedSet = new Set(collections.flatMap((c) => c.keys)))).has(key);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function keyOf(url) {
    return url.split("?")[0].replace(/^https?:\/\/[^/]+\//, "").replace(/\.[a-z0-9]+$/i, "");
  }

  function sized(url, name) {
    const [path, query = ""] = url.split("?");
    const params = new URLSearchParams(query);
    const ext = path.match(/\.(jpg|jpeg|png|webp)$/i);
    const format = params.get("format") || (ext ? ext[1].toLowerCase() : "jpg");
    return `${path.replace(/\.(jpg|jpeg|png|webp)$/i, "")}?format=${format}&name=${name}`;
  }

  function clean(item) {
    if (!item || typeof item.key !== "string" || !["photo", "video", "gif"].includes(item.type)) return null;
    const out = { key: item.key, type: item.type };
    out.tweet = SAFE_TWEET.test(item.tweet || "") ? item.tweet : null;
    for (const f of ["thumb", "full", "video"]) {
      out[f] = typeof item[f] === "string" && SAFE_MEDIA.test(item[f]) ? item[f] : null;
    }
    for (const f of ["saved", "posted", "w", "h"]) out[f] = Number.isFinite(item[f]) && item[f] > 0 ? item[f] : null;
    out.text = typeof item.text === "string" && item.text ? item.text.slice(0, 300) : null;
    // Grid tiles are ~300px wide on a phone: the 360px square is plenty
    // (older saved copies asked for the 680px "small" size).
    if (out.thumb) out.thumb = out.thumb.replace(/([?&]name=)small\b/, "$1360x360");
    return out.thumb ? out : null;
  }

  function fill(target, src) {
    for (const f in src) if (src[f] != null && target[f] == null) target[f] = src[f];
    return target;
  }

  function addItem(raw) {
    const item = clean(raw);
    if (!item) return;
    const old = fresh.get(item.key);
    if (old) fill(old, item);
    else fresh.set(item.key, fill(item, cached.get(item.key) || {}));
    const saved = savedItems.get(item.key);
    if (saved) fill(saved, item);
    scheduleRefresh();
  }

  // Everything to show in "All posts": this visit's items first, then anything
  // from the saved copy that hasn't been reloaded yet.
  function allItems() {
    const out = [...fresh.values()];
    for (const [k, it] of cached) if (!fresh.has(k)) out.push(it);
    return out;
  }

  // --- Storage -------------------------------------------------------------

  function cleanCollection(c) {
    if (!c || typeof c.name !== "string" || !Array.isArray(c.keys)) return null;
    return {
      id: typeof c.id === "string" && c.id ? c.id.slice(0, 40) : newId(),
      name: c.name.trim().slice(0, 60) || "Untitled",
      keys: [...new Set(c.keys.filter((k) => typeof k === "string"))],
    };
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  let storedReady = null; // set once start() begins reading storage
  const storedPostIds = new Set(); // every post in the saved copy, for the top-up check

  // Coming back to the bookmarks page with a complete saved copy only tops it
  // up with new bookmarks (a request or two) instead of reloading everything.
  // A full reload happens when asked for, or when the copy is a week old.
  const FULL_EVERY = 7 * 24 * 3600000;
  function sendPlan() {
    let forced = false;
    try {
      forced = sessionStorage.getItem("xbg_full") === "1";
      sessionStorage.removeItem("xbg_full");
    } catch (e) {
      /* ignore */
    }
    const complete = counts.main > 0 && !partialInfo && cached.size > 0;
    const quick = complete && !forced && Date.now() - cacheTime < FULL_EVERY;
    const known = quick ? [...storedPostIds] : [];
    window.postMessage({ __xbgPlan: { mode: quick ? "quick" : "full", known } }, location.origin);
  }

  // The plan was sent when the page loaded, and moving to the bookmarks
  // doesn't load the page again: tell inject.js directly (the flag covers a
  // real page load). On the bookmarks already, it starts over in place.
  function reloadEverything() {
    try {
      sessionStorage.setItem("xbg_full", "1");
    } catch (e) {
      /* ignore */
    }
    const here = isMainBookmarks();
    window.postMessage({ __xbgAsk: "reload", now: here }, location.origin);
    if (!here) return goToBookmarks();
    try {
      sessionStorage.removeItem("xbg_full");
    } catch (e) {
      /* ignore */
    }
    toast("Reloading all your bookmarks…");
  }

  async function loadStored() {
    try {
      const data = await store.get(Object.values(K));
      mergeSettings(data[K.settings]);
      collections = (data[K.collections] || []).map(cleanCollection).filter(Boolean);
      savedSet = null;
      for (const raw of Object.values(data[K.items] || {})) {
        const item = clean(raw);
        if (item) savedItems.set(item.key, item);
      }
      const cache = data[K.cache];
      if (!(gotData && loadState.state === "done")) {
        const meta = await store.get(PARTIAL);
        const partial = meta[PARTIAL] && Date.now() - meta[PARTIAL].at < 24 * 3600000 ? meta[PARTIAL] : null;
        const readChunks = async (prefix, n, which) => {
          if (!(n > 0)) return [];
          const keys = Array.from({ length: n }, (_, i) => prefix + i);
          const parts = await store.get(keys);
          // Remember what each stored piece holds, so unchanged pieces aren't rewritten.
          keys.forEach((k, i) => {
            const part = parts[k];
            if (which && Array.isArray(part) && part.length) sigs[which][i] = chunkSig(part);
          });
          return keys.flatMap((k) => (Array.isArray(parts[k]) ? parts[k] : []));
        };
        if (cache) {
          cacheTime = Number(cache.at) || 0;
          lastTotal = Number(cache.posts) || 0;
          counts.main = cache.chunks || 0;
        }
        if (partial) {
          counts.partial = partial.chunks || 0;
          // Only an unfinished load has been saved so far (or it's newer than the last full one).
          if (!cache || partial.at > cacheTime) partialInfo = { posts: Number(partial.posts) || 0, at: partial.at };
        }
        const list = [
          ...(partial ? await readChunks(PARTIAL + "_", partial.chunks, "partial") : []),
          ...(cache && Array.isArray(cache.items) ? cache.items : await readChunks(K.cache + "_", cache && cache.chunks, "main")),
        ];
        for (const raw of list) {
          const item = clean(raw);
          if (!item) continue;
          const m = /\/status\/(\d+)/.exec(item.tweet || "");
          if (m) storedPostIds.add(m[1]);
          if (!fresh.has(item.key) && !cached.has(item.key)) cached.set(item.key, item);
        }
      }
    } catch (e) {
      /* start empty */
    }
    applySettings(true);
  }

  function mergeSettings(s) {
    s = s && typeof s === "object" ? s : {};
    settings = { ...settings, ...s, ball: { ...settings.ball, ...(s.ball || {}) }, toggleBtn: { ...settings.toggleBtn, ...(s.toggleBtn || {}) } };
  }

  // Show the current settings (after reading them, or after another tab changed them).
  let applyingSettings = false;
  function applySettings(redraw) {
    applyingSettings = true; // only showing what's stored: nothing to save back
    try {
      updateBall();
      applyTheme();
      if (ui && ui.hbtn) {
        placeHeaderButton();
        if (settings.headerHidden !== ui.overlay.classList.contains("xbg-header-off")) setHeaderHidden(settings.headerHidden);
        ui.overlay.classList.toggle("xbg-filters-off", !!settings.filtersHidden);
        ui.hbtn.classList.toggle("xbg-half", !!settings.filtersHidden && !settings.headerHidden);
      }
      syncControls();
      if (redraw && galleryOpen()) rebuild(false);
    } finally {
      applyingSettings = false;
    }
  }

  function saveSettings() {
    if (applyingSettings) return;
    store.set({ [K.settings]: settings }).catch(() => {});
  }

  // The saved copy is written in pieces of CHUNK items, so even hundreds of
  // thousands of bookmarks never have to be written (or read) in one go, and
  // only pieces that changed are written again. While a long load runs, what
  // it has found so far is kept in a separate set of pieces that only grows,
  // so if the tab closes the next visit shows it and carries on from there.
  const CHUNK = 5000;
  const PARTIAL = K.cache + "_partial";
  const sigs = { main: [], partial: [] };
  const counts = { main: 0, partial: 0 };
  let lastPartialSave = 0;

  // A fingerprint of every key in a piece (not just its ends), so a change
  // anywhere inside it gets written.
  function chunkSig(part) {
    let h = 0x811c9dc5;
    for (const it of part) {
      const k = it && it.key ? it.key : "";
      for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
      h = Math.imul(h ^ 10, 16777619);
    }
    return part.length + ":" + (h >>> 0).toString(36);
  }

  // Resolves true once everything is stored.
  async function writeChunks(which, list, meta) {
    const prefix = which === "main" ? K.cache + "_" : PARTIAL + "_";
    const metaKey = which === "main" ? K.cache : PARTIAL;
    const chunks = Math.ceil(list.length / CHUNK);
    const out = {};
    for (let i = 0; i < chunks; i++) {
      const part = list.slice(i * CHUNK, (i + 1) * CHUNK);
      const sig = chunkSig(part);
      if (sigs[which][i] === sig) continue;
      out[prefix + i] = part;
    }
    out[metaKey] = { ...meta, at: Date.now(), chunks };
    try {
      await store.set(out);
      for (const k in out) if (k !== metaKey) sigs[which][+k.slice(prefix.length)] = chunkSig(out[k]);
      if (counts[which] > chunks) await store.remove(Array.from({ length: counts[which] - chunks }, (_, i) => prefix + (chunks + i)));
      sigs[which].length = chunks;
      counts[which] = chunks;
      return true;
    } catch (e) {
      /* storage full or unavailable: the gallery still works for this visit */
      return false;
    }
  }

  async function clearPartial() {
    const n = Math.max(counts.partial, 0);
    sigs.partial = [];
    counts.partial = 0;
    lastPartialSave = 0;
    try {
      await store.remove([PARTIAL, ...Array.from({ length: n }, (_, i) => PARTIAL + "_" + i)]);
    } catch (e) {
      /* ignore */
    }
  }

  // Is the current load of the main bookmarks list? inject.js says so; the
  // scroll fallback goes by the page. (A load carries on in the background
  // after you leave the bookmarks, and must still be saved when it finishes.)
  const loadingMain = () => (typeof loadState.main === "boolean" ? loadState.main : isMainBookmarks());

  // Keep the finished list as the saved copy for next time.
  function saveCache() {
    if (!fresh.size || !loadingMain()) return;
    if (loadState.posts && !loadState.quick) lastTotal = loadState.posts;
    // A load that carried on from an earlier visit only fetched the rest itself: keep the start too.
    const keepAll = loadState.resumed || loadState.quick;
    if (loadState.quick && !loadState.fresh) return scheduleRefresh(); // nothing new: nothing to write
    // After a top-up, new bookmarks go on the end so only the last piece is rewritten.
    const list = loadState.quick ? [...cached.values(), ...[...fresh.values()].filter((it) => !cached.has(it.key))] : keepAll ? allItems() : [...fresh.values()];
    if (loadState.quick) lastTotal = Math.max(lastTotal, 0) + (loadState.fresh || 0);
    cacheTime = Date.now();
    if (!keepAll) {
      // Posts that left your bookmarks but sit in a collection keep their own copy.
      let kept = false;
      for (const c of collections)
        for (const key of c.keys)
          if (!fresh.has(key) && cached.has(key) && !savedItems.has(key)) {
            savedItems.set(key, { ...cached.get(key) });
            kept = true;
          }
      cached.clear();
      if (kept) saveCollections();
    }
    partialInfo = null;
    // Keep the unfinished copy if the finished one couldn't be stored.
    writeChunks("main", list, { posts: lastTotal }).then((ok) => ok && clearPartial());
    scheduleRefresh();
  }

  // During a long load, keep what's been found about every 10,000 bookmarks.
  function savePartial() {
    if (!loadingMain() || loadState.state !== "loading" || !loadState.posts) return;
    if (loadState.posts - lastPartialSave < 10000) return;
    lastPartialSave = loadState.posts;
    const posts = loadState.posts;
    // Once it's stored, tell inject.js a later visit may carry on from here.
    writeChunks("partial", loadState.resumed ? allItems() : [...fresh.values()], { posts }).then((ok) => ok && window.postMessage({ __xbgAsk: "saved", posts }, location.origin));
  }

  // Collections keep their own copy only of posts that aren't in the saved
  // copy of your bookmarks, so even huge collections save in a moment.
  let collectionsTimer = null;
  function saveCollections() {
    savedSet = null;
    const used = new Set(collections.flatMap((c) => c.keys));
    for (const key of used) {
      if (fresh.has(key) || cached.has(key)) {
        savedItems.delete(key);
        continue;
      }
      const item = getItem(key);
      if (item) savedItems.set(key, { ...item });
    }
    for (const key of [...savedItems.keys()]) if (!used.has(key)) savedItems.delete(key);
    // Several quick changes in a row are written once.
    clearTimeout(collectionsTimer);
    collectionsTimer = setTimeout(writeCollections, 400);
  }
  // What this tab wrote lately, to tell its own saves from another tab's.
  const ownCollectionWrites = [];
  function writeCollections() {
    if (!collectionsTimer) return;
    clearTimeout(collectionsTimer);
    collectionsTimer = null;
    ownCollectionWrites.push(JSON.stringify(collections));
    if (ownCollectionWrites.length > 5) ownCollectionWrites.shift();
    store
      .set({ [K.collections]: collections, [K.items]: Object.fromEntries(savedItems) })
      .catch(() => toast("Couldn’t save your collections"));
  }

  // Another X tab changed the collections: take its list on, so this tab's
  // next save doesn't write its older list back over it.
  function adoptCollections(list, items) {
    if (!Array.isArray(list)) return;
    for (const raw of Object.values(items || {})) {
      const item = clean(raw);
      if (item && !savedItems.has(item.key)) savedItems.set(item.key, item);
    }
    collections = list.map(cleanCollection).filter(Boolean);
    savedSet = null;
    if (!ui) return;
    if (view === "collection" && !getCollection(openId)) return setView("collections");
    if (galleryOpen()) rebuild(false);
    for (const btn of ui.feed.querySelectorAll(".xbg-post .xbg-save-btn")) paintSave(btn, btn.closest(".xbg-post").dataset.key);
  }
  // Never lose a pending change when the tab is hidden or closed.
  document.addEventListener("visibilitychange", () => document.hidden && writeCollections());
  window.addEventListener("pagehide", writeCollections);

  // Settings changed in another tab (or the popup): take them all on, so a
  // later save from this tab doesn't put the old ones back.
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const cc = changes[K.collections];
    if (cc && Array.isArray(cc.newValue) && !ownCollectionWrites.includes(JSON.stringify(cc.newValue))) {
      adoptCollections(cc.newValue, changes[K.items] && changes[K.items].newValue);
    }
    if (!changes[K.settings] || !changes[K.settings].newValue) return;
    const nv = changes[K.settings].newValue;
    const order = (o) => [o.sort, o.dateMode, o.layout].join("|");
    const before = order(settings);
    mergeSettings(nv);
    settings.fab = nv.fab !== false;
    applySettings(order(settings) !== before);
  });

  function createCollection(name) {
    const c = { id: newId(), name: name.trim().slice(0, 60), keys: [] };
    collections.push(c);
    saveCollections();
    return c;
  }

  function setMembership(c, keys, add) {
    if (add) {
      const have = new Set(c.keys);
      const added = [...new Set(keys)].filter((k) => !have.has(k));
      if (added.length) c.keys = [...added, ...c.keys];
    } else {
      const drop = new Set(keys);
      c.keys = c.keys.filter((k) => !drop.has(k));
    }
    saveCollections();
  }

  function backup() {
    const data = JSON.stringify({ app: "x-bookmarks-gallery", version: 1, collections, items: Object.fromEntries(savedItems) });
    // In the Android app, the app saves the file to Downloads itself.
    if (window.XbgAndroid && window.XbgAndroid.saveFile) {
      toast(window.XbgAndroid.saveFile("bookmark-collections.json", data) ? "Backup saved to your Downloads" : "Couldn’t save the backup");
      return;
    }
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const a = el("a", { href: url, download: "bookmark-collections.json" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast("Backup saved to your downloads");
  }

  // Every bookmarked post, once, with who posted it and what it says, so the
  // posts can be sorted into folders elsewhere. Kept compact for huge
  // libraries: pictures stay in the gallery's saved copy, and the folders come
  // back as a file listing post links only.
  async function exportForSorting() {
    const items = allItems();
    if (!items.length) return toast("Open your bookmarks first so they can load");
    const byPost = new Map();
    for (const it of items) {
      const m = (it.tweet || "").match(/^https:\/\/x\.com\/([^/]+)\/status\/(\d+)/);
      const id = m ? m[2] : it.key;
      let p = byPost.get(id);
      if (!p) {
        p = { id, user: m ? m[1] : null, text: it.text || "", type: it.type, posted: it.posted, saved: it.saved, media: [] };
        byPost.set(id, p);
      }
      p.media.push(it.key);
    }
    const posts = [...byPost.values()];
    const data = JSON.stringify({ app: "x-bookmarks-gallery", kind: "all-bookmarks", version: 2, exported: Date.now(), posts });
    const name = `x-bookmarks-all-${new Date().toISOString().slice(0, 10)}.json`;
    toast("Preparing the export…");
    // Compressed (.json.gz) it's about a sixth of the size, small enough to upload.
    let blob = new Blob([data], { type: "application/json" });
    let file = name;
    try {
      if (typeof CompressionStream === "function") {
        blob = await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob();
        file = name + ".gz";
      }
    } catch (e) {
      blob = new Blob([data], { type: "application/json" });
      file = name;
    }
    const url = URL.createObjectURL(new Blob([blob], { type: file.endsWith(".gz") ? "application/gzip" : "application/json" }));
    const a = el("a", { href: url, download: file });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    const mb = (blob.size / 1048576).toFixed(1);
    toast(`Exported ${plural(posts.length, "post")} (${items.length.toLocaleString()} pictures and videos, ${mb} MB) to your downloads`);
  }

  function restore() {
    const input = el("input", { type: "file", accept: "application/json,.json" });
    input.addEventListener("change", async () => {
      try {
        const data = JSON.parse(await input.files[0].text());
        toast("Importing…");
        await storedReady; // the saved copy supplies the pictures for sorted folders
        for (const raw of Object.values(data.items || {})) {
          const item = clean(raw);
          if (item && !savedItems.has(item.key)) savedItems.set(item.key, item);
        }
        // Sorted folders can name posts by id: turn each into its media keys.
        const mediaOf = new Map();
        for (const it of allItems()) {
          const m = (it.tweet || "").match(/\/status\/(\d+)/);
          if (!m) continue;
          if (!mediaOf.has(m[1])) mediaOf.set(m[1], []);
          mediaOf.get(m[1]).push(it.key);
        }
        let added = 0;
        let updated = 0;
        let matched = 0;
        let named = 0;
        for (const raw of data.collections || []) {
          if (raw && Array.isArray(raw.posts)) {
            named += raw.posts.length;
            matched += raw.posts.filter((id) => mediaOf.has(String(id))).length;
          }
          if (raw && Array.isArray(raw.posts)) raw.keys = [...(raw.keys || []), ...raw.posts.flatMap((id) => mediaOf.get(String(id)) || [])];
          const c = cleanCollection(raw);
          if (!c) continue;
          const existing = getCollection(c.id);
          if (existing) {
            existing.keys = [...new Set([...existing.keys, ...c.keys])];
            updated++;
          } else {
            collections.push(c);
            added++;
          }
        }
        saveCollections();
        rebuild();
        // Say exactly what happened, including folders that already existed.
        const parts = [];
        if (added) parts.push(`added ${plural(added, "folder")}`);
        if (updated) parts.push(`${added ? "updated" : "Updated"} ${plural(updated, "folder")} you already had`);
        let msg = (parts.join(", ") || "Nothing to import").replace(/^a/, "A");
        if (named) msg += ` · ${matched.toLocaleString()} of ${named.toLocaleString()} posts found`;
        if (named && !matched) msg = "None of these posts are in your saved bookmarks yet. Open x.com/i/bookmarks, let it load, then import again.";
        toast(msg);
      } catch (e) {
        toast("That file isn’t a collections backup");
      }
    });
    input.click();
  }

  // --- Messages from inject.js ---------------------------------------------

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__xbg !== true) return;
    if (Array.isArray(e.data.items)) {
      gotData = true;
      e.data.items.forEach(addItem);
    }
    if (e.data.status && typeof e.data.status.state === "string") {
      loadState = e.data.status;
      if (loadState.state === "failed" && galleryOpen()) startScrollLoading();
      if (loadState.state === "done") {
        stopScrollLoading();
        saveCache();
      } else savePartial();
      updateHeader();
    }
  });
  window.postMessage({ __xbgAsk: "status" }, location.origin);

  // --- Fallback: read posts visible on screen ------------------------------

  function scanPage() {
    if (!isBookmarks()) return;
    for (const article of document.querySelectorAll("article")) {
      const time = article.querySelector('a[href*="/status/"] time');
      const link = time && time.closest("a");
      if (!link) continue;
      const tweet = new URL(link.getAttribute("href"), "https://x.com").href.replace(/\/(photo|video|analytics)(\/\d+)?$/, "");
      const posted = Date.parse(time.getAttribute("datetime") || "") || null;
      for (const img of article.querySelectorAll('img[src*="pbs.twimg.com/media/"]')) {
        addItem({ key: keyOf(img.src), type: "photo", tweet, posted, thumb: sized(img.src, "360x360"), full: sized(img.src, "large") });
      }
      for (const img of article.querySelectorAll('img[src*="video_thumb"]')) {
        const type = img.src.includes("tweet_video_thumb") ? "gif" : "video";
        addItem({ key: keyOf(img.src), type, tweet, posted, thumb: sized(img.src, "360x360"), full: sized(img.src, "large") });
      }
      for (const v of article.querySelectorAll("video[poster]")) {
        const src = v.currentSrc || v.src || "";
        const video = /^https:\/\/video\.twimg\.com\/.+\.mp4/.test(src) ? src : null;
        const type = v.poster.includes("tweet_video_thumb") ? "gif" : "video";
        addItem({ key: keyOf(v.poster), type, tweet, posted, thumb: sized(v.poster, "360x360"), full: sized(v.poster, "large"), video });
      }
    }
  }

  // The page is only watched on the bookmarks page, and only until the
  // background loader delivers (or while the scroll fallback runs).
  let pageObserver = null;
  let scanQueued = false;
  function watchPage() {
    const want = isBookmarks() && (!gotData || scrollTimer);
    if (want && !pageObserver && document.body) {
      pageObserver = new MutationObserver(queueScan);
      pageObserver.observe(document.body, { childList: true, subtree: true });
    } else if (!want && pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scanPage();
      watchPage();
    }, 800);
  }

  function startScrollLoading() {
    if (scrollTimer || !isBookmarks()) return;
    // If X refused the background loading, the page's own scrolling likely
    // stops early too: don't claim everything loaded when it runs dry.
    const afterFailure = loadState.state === "failed";
    let lastSize = fresh.size;
    let idle = 0;
    scrollTimer = setInterval(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      scanPage();
      if (fresh.size > lastSize) {
        lastSize = fresh.size;
        idle = 0;
      } else if (++idle >= 12) {
        stopScrollLoading();
        if (!fresh.size) {
          // X sent nothing at all: say so instead of "Loading…" forever.
          loadState = { state: "failed", nothing: true };
          updateEmpty();
        } else {
          // Scrolling may stop early, so add what it found to the saved copy
          // instead of replacing it ("resumed" keeps everything already saved).
          loadState = { state: "done", resumed: true, incomplete: afterFailure };
          saveCache();
        }
      }
      updateHeader();
    }, 1200);
    watchPage();
    updateHeader();
  }

  function stopScrollLoading() {
    if (!scrollTimer) return;
    clearInterval(scrollTimer);
    scrollTimer = null;
    watchPage();
    updateHeader();
  }

  // --- UI building blocks --------------------------------------------------

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) node.append(c);
    return node;
  }

  function mosaic(list, cls) {
    const thumbs = list.filter(Boolean).slice(0, 4);
    const box = el("div", { class: `${cls} xbg-mosaic`, "data-n": String(thumbs.length) });
    for (const it of thumbs) box.append(el("img", { src: it.thumb, loading: "lazy", decoding: "async", alt: "", referrerpolicy: "no-referrer" }));
    return box;
  }

  const cover = (c, cls) => mosaic(c.keys.slice(0, 4).map(getItem), cls);

  let toastTimer = null;
  function toast(text) {
    if (!ui) return;
    ui.toast.textContent = text;
    ui.toast.classList.remove("xbg-hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.add("xbg-hidden"), Math.min(8000, 2500 + text.length * 40));
  }

  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 2) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return plural(Math.round(h / 24), "day") + " ago";
  }

  // A bottom sheet, like Instagram's menus.
  function openSheet(title, body, onClose) {
    closeSheet(true);
    const sheet = el("div", { class: "xbg-sheet", role: "dialog" }, el("div", { class: "xbg-sheet-handle" }), el("div", { class: "xbg-sheet-title" }, title), body);
    const backdrop = el("div", { class: "xbg-backdrop" }, sheet);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeSheet();
    });
    backdrop.__onClose = onClose;
    ui.overlay.append(backdrop);
    ui.sheet = backdrop;
  }

  // `replacing` is set when another sheet takes this one's place, so the
  // first sheet's "done" action doesn't run early.
  function closeSheet(replacing = false) {
    if (!ui || !ui.sheet) return;
    const { __onClose } = ui.sheet;
    ui.sheet.remove();
    ui.sheet = null;
    if (__onClose && !replacing) __onClose();
  }

  function askName(title, initial, onSave) {
    const input = el("input", { class: "xbg-input", type: "text", maxlength: "60", placeholder: "Collection name", value: initial || "" });
    const save = () => {
      const name = input.value.trim();
      if (!name) return input.focus();
      closeSheet();
      onSave(name);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
    openSheet(title, el("div", { class: "xbg-sheet-body" }, input, el("button", { class: "xbg-primary", onclick: save }, "Save")));
    setTimeout(() => input.focus(), 50);
  }

  // An iPhone-style action sheet at the bottom: the message, then the red action, then Cancel.
  function confirmSheet(title, message, action, onConfirm) {
    // It takes the place of the menu it was asked from: left open underneath,
    // that menu showed through and stayed behind after deleting.
    closeSheet(true);
    const close = () => backdrop.remove();
    const box = el(
      "div",
      { class: "xbg-alert xbg-action-sheet", role: "alertdialog" },
      el("div", { class: "xbg-alert-text" }, el("div", { class: "xbg-alert-title" }, title), el("div", { class: "xbg-alert-message" }, message)),
      el("button", { class: "xbg-alert-action", onclick: () => { close(); onConfirm(); } }, action),
      el("button", { class: "xbg-alert-cancel", onclick: close }, "Cancel")
    );
    const backdrop = el("div", { class: "xbg-alert-backdrop xbg-sheet-style", onclick: (e) => e.target === backdrop && close() }, box);
    ui.overlay.append(backdrop);
    ui.alert = backdrop;
  }

  // ⋯ on the main pages: light or dark look.
  function settingsMenu() {
    const toggle = (label, note, on, flip) =>
      el(
        "button",
        { class: "xbg-pick xbg-setting", onclick: () => { flip(); saveSettings(); settingsMenu(); } },
        el("span", { class: "xbg-pick-name" }, label, note ? el("small", {}, note) : ""),
        el("span", { class: "xbg-switch" + (on ? " xbg-on" : "") })
      );
    openSheet(
      "Settings",
      el(
        "div",
        { class: "xbg-sheet-body" },
        toggle("Dark mode", "", settings.theme !== "light", () => {
          settings.theme = settings.theme === "light" ? "dark" : "light";
          applyTheme();
        }),
        el("button", { class: "xbg-secondary", onclick: () => { closeSheet(); reloadEverything(); } }, "Reload all bookmarks from X"),
        el("button", { class: "xbg-secondary", onclick: () => { closeSheet(); exportForSorting(); } }, "Export all bookmarks for sorting"),
        el("button", { class: "xbg-secondary", onclick: () => { closeSheet(); restore(); } }, "Import sorted folders"),
        el("button", { class: "xbg-primary", onclick: () => closeSheet() }, "Done")
      )
    );
  }

  function applyTheme() {
    if (ui) ui.overlay.classList.toggle("xbg-light", settings.theme === "light");
  }

  // "Save to collection" picker for one or more posts.
  function openPicker(keys, onDone) {
    const list = el("div", { class: "xbg-picker" });
    const draw = () => {
      list.replaceChildren();
      list.append(
        el(
          "button",
          { class: "xbg-pick", onclick: () => askName("New collection", "", (name) => { setMembership(createCollection(name), keys, true); openPicker(keys, onDone); }) },
          el("div", { class: "xbg-pick-cover xbg-plus" }, "＋"),
          el("span", { class: "xbg-pick-name" }, "New collection")
        )
      );
      for (const c of collections) {
        const inIt = keys.every((k) => c.keys.includes(k));
        list.append(
          el(
            "button",
            { class: "xbg-pick" + (inIt ? " xbg-on" : ""), onclick: () => { setMembership(c, keys, !inIt); draw(); } },
            cover(c, "xbg-pick-cover"),
            el("span", { class: "xbg-pick-name" }, c.name, el("small", {}, plural(c.keys.length, "post"))),
            el("span", { class: "xbg-pick-check" }, inIt ? "✓" : "")
          )
        );
      }
    };
    draw();
    const title = keys.length > 1 ? `Save ${keys.length} posts to…` : "Save to…";
    openSheet(title, el("div", { class: "xbg-sheet-body" }, list, el("button", { class: "xbg-primary", onclick: () => closeSheet() }, "Done")), onDone);
  }

  function sortMenu() {
    const option = (label, on, pick) =>
      el(
        "button",
        { class: "xbg-pick" + (on ? " xbg-on" : ""), onclick: () => { pick(); saveSettings(); closeSheet(); syncControls(); rebuild(); } },
        el("span", { class: "xbg-pick-name" }, label),
        el("span", { class: "xbg-pick-check" }, on ? "✓" : "")
      );
    openSheet(
      "Sort",
      el(
        "div",
        { class: "xbg-sheet-body" },
        el("div", { class: "xbg-sheet-label" }, "Order"),
        option("Newest first", settings.sort === "newest", () => (settings.sort = "newest")),
        option("Oldest first", settings.sort === "oldest", () => (settings.sort = "oldest")),
        el("div", { class: "xbg-sheet-label" }, "Use the date"),
        option("I bookmarked it", settings.dateMode === "saved", () => (settings.dateMode = "saved")),
        option("It was posted", settings.dateMode === "posted", () => (settings.dateMode = "posted"))
      )
    );
  }

  // --- Gallery UI ----------------------------------------------------------

  function buildUi() {
    if (ui || !document.body) return;
    const back = el("button", { class: "xbg-close", "aria-label": "Back", onclick: () => setView("collections") }, "‹");
    const close = el("button", { class: "xbg-close", "aria-label": "Close gallery", onclick: () => closeGallery() }, "✕");
    const titleName = el("span", {}, "Bookmarks");
    const count = el("span", { class: "xbg-count" }, "0");
    const statusText = el("span");
    const refreshBtn = el("button", { class: "xbg-link xbg-hidden", onclick: () => goToBookmarks() }, "Refresh");
    const status = el("div", { class: "xbg-status" }, statusText, refreshBtn);
    const selectBtn = el("button", { class: "xbg-text-btn", onclick: () => setSelectMode(!selectMode) }, "Select");
    const menuBtn = el("button", { class: "xbg-close", "aria-label": "Options", onclick: () => (view === "collection" ? collectionMenu() : settingsMenu()) }, "⋯");

    const tabs = el("div", { class: "xbg-tabs" });
    for (const [value, label] of [["all", "All posts"], ["collections", "Collections"]]) {
      tabs.append(el("button", { class: "xbg-tab", "data-view": value, onclick: () => setView(value) }, label));
    }
    const tabInk = el("span", { class: "xbg-tab-ink" });
    tabs.append(tabInk);
    const filters = el("div", { class: "xbg-chips" });
    for (const [value, label] of [["all", "All"], ["photo", "Photos"], ["video", "Videos"]]) {
      filters.append(el("button", { class: "xbg-chip", "data-filter": value, onclick: () => setFilter(value) }, label));
    }
    const sortBtn = el("button", { class: "xbg-chip xbg-sort", onclick: sortMenu });
    const layouts = el("div", { class: "xbg-seg" });
    for (const [value, label] of [["grid", ""], ["months", "Months"], ["years", "Years"]]) {
      const b = el("button", { "data-layout": value, "aria-label": value === "grid" ? "Grid" : label, onclick: () => setLayout(value) }, label);
      if (value === "grid") b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 3h5v5H3zm6.5 0h5v5h-5zM16 3h5v5h-5zM3 9.5h5v5H3zm6.5 0h5v5h-5zM16 9.5h5v5h-5zM3 16h5v5H3zm6.5 0h5v5h-5zM16 16h5v5h-5z"/></svg>';
      layouts.append(b);
    }
    const yearBar = el("div", { class: "xbg-period-row" });
    const monthBar = el("div", { class: "xbg-period-row" });
    const periodBar = el("div", { class: "xbg-periods xbg-hidden" }, yearBar, monthBar);
    const search = el("input", { class: "xbg-search-input", type: "search", placeholder: "Search posts or @name", "aria-label": "Search posts", autocomplete: "off", spellcheck: "false", enterkeyhint: "search" });
    const searchClear = el("button", { class: "xbg-search-clear xbg-hidden", "aria-label": "Clear search", onclick: () => { setSearch(""); search.focus(); } }, "✕");
    search.addEventListener("input", () => setSearch(search.value, true));
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") search.blur(); // tuck the phone keyboard away
    });
    const searchBox = el("label", { class: "xbg-search" }, el("span", { class: "xbg-search-icon", "aria-hidden": "true" }), search, searchClear);
    searchBox.firstChild.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16 16l5 5"/></svg>';
    const controls = el("div", { class: "xbg-controls" }, searchBox, el("div", { class: "xbg-row" }, filters, sortBtn), layouts, periodBar);

    const grid = el("div", { class: "xbg-grid" });
    const years = el("div", { class: "xbg-cards xbg-hidden" });
    const collGrid = el("div", { class: "xbg-cards xbg-hidden" });
    const empty = el("p", { class: "xbg-empty" });
    const sentinel = el("div", { class: "xbg-sentinel" });
    const scroller = el("div", { class: "xbg-scroll" }, grid, years, collGrid, empty, sentinel);

    const selectInfo = el("span", { class: "xbg-select-info" });
    const addBtn = el("button", { class: "xbg-primary", onclick: () => openPicker([...selected], () => { setSelectMode(false); rebuild(false); }) }, "Add to collection");
    const removeBtn = el("button", { class: "xbg-secondary", onclick: removeSelected }, "Remove");
    const selectBar = el("div", { class: "xbg-select-bar xbg-hidden" }, selectInfo, removeBtn, addBtn);

    // Tapping a post opens a feed you scroll freely, like Instagram.
    const feed = el("div", { class: "xbg-feed" });
    const lightbox = el(
      "div",
      { class: "xbg-lightbox xbg-hidden" },
      el(
        "header",
        { class: "xbg-feed-bar" },
        el("button", { class: "xbg-close", "aria-label": "Back to grid", onclick: () => closeLightbox() }, "‹"),
        el("div", { class: "xbg-title" }, "Posts")
      ),
      feed
    );

    const bar = el(
      "header",
      { class: "xbg-bar" },
      el("div", { class: "xbg-row" }, back, close, el("div", { class: "xbg-title" }, titleName, " ", count, status), selectBtn, menuBtn),
      tabs,
      controls
    );
    // Loading progress as a ring like the iPhone's App Store download circle.
    const svgEl = (tag, attrs) => {
      const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    const ring = svgEl("svg", { viewBox: "0 0 36 36", class: "xbg-ring" });
    const progressFill = svgEl("circle", { cx: 18, cy: 18, r: 15.5, class: "xbg-ring-fill", pathLength: 100 });
    ring.append(svgEl("circle", { cx: 18, cy: 18, r: 15.5, class: "xbg-ring-track" }), progressFill, svgEl("rect", { x: 13, y: 13, width: 10, height: 10, rx: 2, class: "xbg-ring-stop" }));
    const progressPct = el("span", { class: "xbg-ring-pct" });
    const progress = el("span", { class: "xbg-progress xbg-hidden", role: "progressbar" }, ring, progressPct);
    status.prepend(progress);
    const toastEl = el("div", { class: "xbg-toast xbg-hidden" });
    const overlay = el("div", { id: "xbg-overlay", class: "xbg-hidden" }, scroller, bar, selectBar, lightbox, toastEl);
    document.body.append(overlay);

    ui = {
      overlay, bar, back, close, titleName, count, statusText, refreshBtn, selectBtn, menuBtn, tabs, filters, sortBtn, search, searchClear,
      layouts, controls, periodBar, yearBar, monthBar, grid, years, collGrid, empty, sentinel, scroller, selectBar, selectInfo, addBtn, removeBtn,
      lightbox, feed, toast: toastEl, sheet: null, tabInk, progress, progressFill, progressPct,
    };

    wireGrid();
    wireScroller();
    wireLightbox();
    buildScrubber();
    buildHeaderButton();
    document.addEventListener("keydown", onKey);
    new ResizeObserver(() => (scroller.style.paddingTop = settings.headerHidden ? "0px" : bar.offsetHeight + "px")).observe(bar);
    applyTheme();
    if (settings.filtersHidden) ui.overlay.classList.add("xbg-filters-off");
    if (settings.headerHidden) setHeaderHidden(true);
    syncControls();
    updateHeader();
  }

  function onKey(e) {
    if (!galleryOpen()) return;
    const typing = e.target instanceof HTMLElement && (e.target.matches("input, textarea") || e.target.isContentEditable);
    if (e.key === "/" && !typing && !ui.sheet && !feedOpen() && view !== "collections") {
      e.preventDefault();
      return openSearch();
    }
    if (e.key !== "Escape" && !e.key.startsWith("Arrow")) return;
    if (typing && e.key !== "Escape") return;
    if (ui.alert && ui.alert.isConnected) {
      if (e.key === "Escape") ui.alert.remove();
    } else if (ui.sheet) {
      if (e.key === "Escape") closeSheet();
    } else if (reels) {
      // Full screen: up/down (or left/right) moves between posts, Esc goes back.
      if (e.key === "Escape") return closeReels(true);
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (!step || reels.anim) return;
      e.preventDefault();
      if (reels.cur + step >= 0 && reels.cur + step < current.length) settleReels(step, 0);
    } else if (typing && e.key === "Escape" && e.target === ui.search) {
      e.target.blur();
      if (searchText) setSearch("");
    } else if (!ui.lightbox.classList.contains("xbg-hidden")) {
      if (e.key === "Escape") closeLightbox();
    } else if (e.key === "Escape") {
      if (selectMode) setSelectMode(false);
      else if (view === "collection") setView("collections");
      else closeGallery();
    }
  }

  // Tap a tile to open it; long-press to start selecting (like Instagram).
  function wireGrid() {
    const { grid } = ui;
    let press = null;
    let swallowKey = null; // the tile whose long-press already selected it
    const cancel = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    grid.addEventListener("touchstart", (e) => {
      const tile = e.target.closest(".xbg-tile");
      if (!tile || e.touches.length !== 1) return cancel();
      const t = e.touches[0];
      press = {
        key: tile.dataset.key,
        x: t.clientX,
        y: t.clientY,
        timer: setTimeout(() => {
          if (!press) return;
          press.fired = true;
          if (navigator.vibrate) navigator.vibrate(25);
          if (!selectMode) setSelectMode(true);
          toggleSelect(tile.dataset.key, true);
        }, 450),
      };
    }, { passive: true });
    grid.addEventListener("touchmove", (e) => {
      if (!press) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - press.x) > 10 || Math.abs(t.clientY - press.y) > 10) cancel();
    }, { passive: true });
    grid.addEventListener("touchend", (e) => {
      if (press && press.fired) {
        e.preventDefault();
        swallowKey = press.key;
        setTimeout(() => (swallowKey = null), 600);
      }
      cancel();
    });
    grid.addEventListener("touchcancel", cancel);
    grid.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("resize", () => fillPage());
    grid.addEventListener("click", (e) => {
      const tile = e.target.closest(".xbg-tile");
      if (!tile || tile.dataset.key === swallowKey) return;
      if (selectMode) toggleSelect(tile.dataset.key);
      else openLightbox(tile.dataset.key);
    });
  }

  // Header hides while scrolling down and comes back when scrolling up;
  // swiping sideways switches between "All posts" and "Collections".
  function wireScroller() {
    const { scroller, bar } = ui;
    let lastY = 0;
    let ticking = false;
    scroller.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = scroller.scrollTop;
        if (ui.jumped) {
          // We scrolled on purpose (e.g. jumping to a year): keep the header showing.
          ui.jumped = false;
          lastY = y;
          fillPage();
          return;
        }
        const dy = y - lastY;
        if (settings.headerHidden) {
          lastY = y;
          fillPage();
          showScrubber();
          return;
        }
        if (y < bar.offsetHeight) bar.classList.remove("xbg-bar-hidden");
        else if (dy > 6) bar.classList.add("xbg-bar-hidden");
        else if (dy < -6) bar.classList.remove("xbg-bar-hidden");
        if (Math.abs(dy) > 6 || y < bar.offsetHeight) lastY = y;
        fillPage();
        showScrubber();
        saveSpot();
      });
    }, { passive: true });

    // Swiping sideways moves between All posts and Collections (and back out
    // of a collection). The drag is locked sideways; the page and the one
    // you're heading to move together under your finger, the destination
    // fading in, while the header steps aside (only the tabs and the white
    // line stay). Let go far enough, or flick, to finish; otherwise it
    // springs back.
    let swipe = null;
    let frame = 0;
    const targetFor = (dx) => (dx < 0 && view === "all" ? "collections" : dx > 0 && view === "collections" ? "all" : dx > 0 && view === "collection" ? "collections" : null);
    scroller.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      const fromEdge = t.clientX < 28 || t.clientX > window.innerWidth - 28; // Android's back gesture
      swipe = e.touches.length === 1 && !selectMode && !ui.sheet && !fromEdge && !ui.sliding ? { x: t.clientX, y: t.clientY, at: Date.now(), dx: 0, on: false } : null;
    }, { passive: true });
    scroller.addEventListener("touchmove", (e) => {
      if (!swipe) return;
      const t = e.touches[0];
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      if (!swipe.on) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.3) return (swipe = null);
        swipe.on = true;
        swipe.target = targetFor(dx); // none: there's nothing that way, it just stretches
        swipe.dir = dx < 0 ? -1 : 1;
        swipe.x = t.clientX; // start following from here, so nothing jumps
        swipe.track = [];
        if (swipe.target) foldFiltersNow(); // same as the header button's first tap, instantly
        startSlide(swipe.target, swipe.dir);
      }
      if (e.cancelable) e.preventDefault(); // sideways only: no drifting up and down
      const raw = t.clientX - swipe.x;
      const now = performance.now();
      swipe.track.push([now, raw]);
      while (swipe.track.length > 2 && now - swipe.track[0][0] > 100) swipe.track.shift();
      // Toward the other page the page sticks to your finger; the other way
      // (or where there's no page) it stretches with growing resistance.
      const toward = swipe.target && Math.sign(raw) === swipe.dir;
      swipe.dx = toward ? raw : rubberBand(raw, window.innerWidth);
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (swipe && swipe.on) moveSlide(swipe.dx);
      });
    }, { passive: false });
    const endSwipe = () => {
      const sw = swipe;
      swipe = null;
      if (!sw || !sw.on) return;
      const w = window.innerWidth;
      // Finger speed over the last moment (px per ms), and where that speed
      // would carry the page: a flick counts as much as a long drag.
      const [t0, x0] = sw.track[0] || [0, 0];
      const [t1, x1] = sw.track[sw.track.length - 1] || [0, 0];
      const v = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;
      const projected = sw.dx + v * 180;
      const go = !!sw.target && Math.sign(sw.dx) === sw.dir && Math.sign(projected) === sw.dir && Math.abs(projected) > w * 0.35;
      finishSlide(go, v);
    };
    scroller.addEventListener("touchend", endSwipe);
    scroller.addEventListener("touchcancel", endSwipe);
  }

  // --- Sliding between All posts and Collections ------------------------------
  // The page you're going to is shown beside the current one as a light copy
  // (a snapshot of the grid where you left it, or the collection cards), so
  // the two move together. When the slide finishes the real page takes over
  // at exactly the same spot.
  const PAGE_GAP = 36; // dark space between the two pages while they slide
  let gridSnapshot = null; // { node, top, gridTop } taken when leaving All posts
  let allSpot = null;
  let slide = null;

  function snapshotGrid() {
    if (!ui || view !== "all") return;
    gridSnapshot = { node: ui.grid.cloneNode(true), top: ui.scroller.scrollTop, gridTop: gridTop(), left: ui.grid.offsetLeft, width: ui.grid.offsetWidth };
  }

  function buildPeek(target) {
    const sc = ui.scroller;
    const peek = el("div", { class: "xbg-peek" });
    peek.style.top = sc.offsetTop + "px";
    peek.style.height = sc.clientHeight + "px";
    const inner = el("div", { class: "xbg-peek-inner" });
    peek.append(inner);
    if (target === "all" && gridSnapshot) {
      const g = gridSnapshot.node;
      g.classList.remove("xbg-hidden");
      Object.assign(g.style, { position: "absolute", top: gridSnapshot.gridTop + "px", left: gridSnapshot.left + "px", width: gridSnapshot.width + "px", margin: "0" });
      inner.append(g);
      inner.style.transform = `translateY(${-gridSnapshot.top}px)`;
    } else if (target === "collections") {
      // Room for the header as it will be on Collections (filters folded away).
      const folded = ui.controls.classList.contains("xbg-collapsed") || settings.filtersHidden;
      const pad = settings.headerHidden ? 0 : ui.bar.offsetHeight - (folded ? 0 : ui.controls.offsetHeight);
      inner.style.paddingTop = pad + "px";
      inner.append(el("div", { class: "xbg-cards" }, ...collectionCards()));
      const top = view === "collection" && collectionsSpot ? collectionsSpot.top : 0;
      inner.style.transform = `translateY(${-top}px)`;
    }
    ui.overlay.insertBefore(peek, ui.bar);
    return peek;
  }

  function startSlide(target, dir) {
    if (target && view === "all") snapshotGrid();
    const peek = target ? buildPeek(target) : null;
    slide = { target, dir, peek, w: window.innerWidth };
    ui.sliding = true;
    if (target) {
      // The header stays put through the whole swipe and after it: if
      // scrolling had tucked it away, bring it back now, without sliding.
      if (ui.bar.classList.contains("xbg-bar-hidden")) {
        ui.bar.style.transition = "none";
        ui.bar.classList.remove("xbg-bar-hidden");
        void ui.bar.offsetHeight;
        ui.bar.style.transition = "";
      }
      ui.bar.classList.add("xbg-swiping");
    }
    ui.scroller.style.transition = "none";
    if (peek) peek.style.transition = "none";
    if (ui.tabInk) ui.tabInk.style.transition = "none";
    moveSlide(0);
  }

  function moveSlide(dx) {
    if (!slide) return;
    const { w, dir, peek } = slide;
    const p = Math.min(Math.abs(dx) / w, 1);
    ui.scroller.style.transform = `translate3d(${dx}px, 0, 0)`;
    if (!peek) return; // just stretching
    peek.style.transform = `translate3d(${-dir * (w + PAGE_GAP) + dx}px, 0, 0)`;
    peek.style.opacity = String(0.25 + 0.75 * p);
    if (ui.tabInk && view !== "collection") {
      const base = view === "all" ? 0 : 1;
      ui.tabInk.style.transform = `translateX(${Math.min(1, Math.max(0, base - dx / w)) * 100}%)`;
    }
  }

  // Pull past the end: the further you go the harder it gets, like iOS.
  function rubberBand(x, d) {
    return Math.sign(x) * (1 - 1 / ((Math.abs(x) * 0.55) / d + 1)) * d;
  }

  // A spring-like ease that starts at the speed your finger let go with, so
  // the page carries on smoothly instead of jerking, then settles softly.
  function springEase(velocity, distance, seconds) {
    const slope = distance > 1 ? (Math.abs(velocity) * seconds * 1000) / distance : 0;
    const y1 = Math.min(Math.max(0.25 * slope, 0.3), 1.2);
    return `cubic-bezier(0.25, ${y1.toFixed(3)}, 0.3, 1)`;
  }

  function finishSlide(go, velocity = 0) {
    if (!slide) return;
    const { target, dir, peek, w } = slide;
    const at = new DOMMatrix(getComputedStyle(ui.scroller).transform).m41 || 0;
    const t = go ? 0.36 : 0.32;
    const ease = springEase(velocity, go ? Math.max(w + PAGE_GAP - Math.abs(at), 1) : Math.abs(at), t);
    ui.scroller.style.transition = `transform ${t}s ${ease}`;
    if (peek) peek.style.transition = `transform ${t}s ${ease}, opacity ${t}s ${ease}`;
    if (ui.tabInk) ui.tabInk.style.transition = `transform ${t}s ${ease}`;
    if (!go) {
      ui.scroller.style.transform = "";
      if (peek) {
        peek.style.transform = `translate3d(${-dir * (w + PAGE_GAP)}px, 0, 0)`;
        peek.style.opacity = "0";
      }
      if (ui.tabInk && view !== "collection") ui.tabInk.style.transform = `translateX(${view === "all" ? 0 : 100}%)`;
      setTimeout(() => endSlide(), t * 1000);
      return;
    }
    ui.scroller.style.transform = `translate3d(${dir * (w + PAGE_GAP)}px, 0, 0)`;
    peek.style.transform = "translate3d(0, 0, 0)";
    peek.style.opacity = "1";
    if (ui.tabInk && target !== "collection") ui.tabInk.style.transform = `translateX(${target === "all" ? 0 : 100}%)`;
    setTimeout(() => {
      // Swap in the real page under the copy, at the same spot, then drop the copy.
      ui.controls.style.transition = "none";
      setView(target, null, null, slide.fromHistory);
      ui.scroller.style.transition = "none";
      ui.scroller.style.transform = "";
      void ui.controls.offsetHeight;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        ui.controls.style.transition = "";
        endSlide(true);
      }));
    }, t * 1000);
  }

  // `handoff`: the real page has just been put under the copy. Keep the copy
  // on top until the pictures on screen have faded in, then let it go, so the
  // screen never flashes empty.
  function endSlide(handoff) {
    const peek = slide && slide.peek;
    if (peek && !handoff) peek.remove();
    if (peek && handoff) {
      const t0 = Date.now();
      const ready = () => {
        const r = ui.scroller.getBoundingClientRect();
        for (const img of ui.scroller.querySelectorAll("img")) {
          const b = img.getBoundingClientRect();
          if (b.bottom <= r.top || b.top >= r.bottom || !b.width) continue;
          if (!img.complete || Number(getComputedStyle(img).opacity) < 0.99) return false;
        }
        return true;
      };
      const check = () => {
        if (!ready() && Date.now() - t0 < 700) return setTimeout(check, 40);
        peek.style.transition = "opacity 0.12s ease";
        peek.style.opacity = "0";
        setTimeout(() => peek.remove(), 130);
      };
      check();
    }
    slide = null;
    ui.sliding = false;
    ui.scroller.style.transition = "";
    ui.scroller.style.transform = "";
    ui.bar.classList.remove("xbg-swiping"); // the header fades back in
  }

  // Back gesture / back button inside a collection uses the same slide.
  function slideTo(target, dir, fromHistory = false) {
    if (slide) return;
    startSlide(target, dir);
    slide.fromHistory = fromHistory;
    requestAnimationFrame(() => finishSlide(true));
  }

  // The feed adds posts above and below as you scroll, and plays videos
  // (muted) while they're on screen, like Instagram.
  function wireLightbox() {
    const { feed, lightbox } = ui;
    let ticking = false;
    feed.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        extendFeed();
        saveSpot();
      });
    }, { passive: true });
    ui.feedVideos = new IntersectionObserver(
      (list) => {
        for (const entry of list) {
          const v = entry.target;
          if (v.closest(".xbg-reels")) continue; // reels play their own videos
          if (entry.isIntersecting) v.play().catch(() => {});
          else v.pause();
        }
      },
      { root: feed, threshold: 0.6 }
    );

    // Swipe right to go back to the grid: the feed follows your finger and
    // slides away if you drag far enough. Swipes on a video's control bar are
    // left alone so seeking still works.
    let swipe = null;
    lightbox.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      const onControls = !!e.target.closest(".xbg-vbar") || !!document.fullscreenElement;
      // Swipes from the very edge are Android's own back gesture: leave them to it.
      const fromEdge = t.clientX < 28 || t.clientX > window.innerWidth - 28;
      swipe = e.touches.length === 1 && !onControls && !ui.sheet && !fromEdge ? { x: t.clientX, y: t.clientY, dx: 0, at: Date.now(), decided: false } : null;
    }, { passive: true });
    lightbox.addEventListener("touchmove", (e) => {
      if (!swipe) return;
      const t = e.touches[0];
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      if (!swipe.decided) {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        swipe.decided = true;
        if (!(dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.3)) return (swipe = null);
      }
      swipe.dx = Math.max(0, dx);
      lightbox.style.transition = "none";
      lightbox.style.transform = `translateX(${swipe.dx}px)`;
    }, { passive: true });
    const endSwipe = () => {
      if (!swipe || !swipe.decided) return (swipe = null);
      const speed = swipe.dx / Math.max(Date.now() - swipe.at, 1);
      const far = swipe.dx > window.innerWidth * 0.22 || (speed > 0.5 && swipe.dx > 40);
      swipe = null;
      lightbox.style.transition = far ? "transform 0.12s cubic-bezier(0.4, 0, 1, 1)" : "transform 0.18s ease-out";
      lightbox.style.transform = far ? "translateX(100%)" : "";
      if (far) {
        lightbox.classList.add("xbg-closing");
        setTimeout(() => {
          lightbox.classList.remove("xbg-closing");
          closeLightbox(false, false);
        }, 120);
      }
    };
    lightbox.addEventListener("touchend", endSwipe);
    lightbox.addEventListener("touchcancel", endSwipe);
  }

  // The phone's own back gesture/button undoes the last thing opened (the post
  // feed, or selecting posts) instead of leaving the page. Each of those adds
  // one step to the browser history while it's open; closing it another way
  // quietly removes that step again.
  const backSteps = { pushed: 0, ignore: 0, pending: 0 };

  function addBackStep() {
    if (backSteps.ignore) return void backSteps.pending++; // wait for our own step back to finish
    try {
      history.pushState(history.state, "", location.href);
      backSteps.pushed++;
    } catch (e) {
      /* the back gesture just won't be caught */
    }
  }

  function removeBackStep() {
    if (backSteps.pending) return void backSteps.pending--;
    if (!backSteps.pushed) return;
    backSteps.pushed--;
    backSteps.ignore++;
    history.back();
  }

  // Listened for from the start (not only once the gallery is built), so our
  // own nudge to X's router is always counted off and never eats a real back.
  window.addEventListener("popstate", onBack);

  function onBack() {
    if (quietPop) return void quietPop--; // our own nudge to X's page router
    if (!ui) return;
    if (backSteps.ignore) {
      // One of our own quiet steps back.
      if (--backSteps.ignore === 0) {
        const n = backSteps.pending;
        backSteps.pending = 0;
        for (let i = 0; i < n; i++) addBackStep();
      }
      return;
    }
    if (!backSteps.pushed) return;
    backSteps.pushed--;
    // Menus don't add a step of their own, so closing one used up the step of
    // whatever is under it: put that step back while the gallery stays open.
    if (ui.alert && ui.alert.isConnected) {
      // A confirmation was open: back just closes it.
      ui.alert.remove();
      if (galleryOpen()) addBackStep();
    } else if (ui.sheet) {
      // A menu was open: back just closes the menu. While selecting, keep the
      // selection (the menu's "done" step would otherwise end it).
      if (selectMode && !feedOpen()) {
        closeSheet(true);
        rebuild(false);
      } else {
        closeSheet();
      }
      if (galleryOpen()) addBackStep();
    } else if (reels) closeReels(false);
    else if (feedOpen()) closeLightbox(true);
    else if (selectMode) setSelectMode(false, true);
    else if (galleryOpen() && view === "collection") slideTo("collections", 1, true);
    else if (galleryOpen()) closeGallery(true);
  }

  function syncControls() {
    if (!ui) return;
    ui.filters.querySelectorAll(".xbg-chip").forEach((b) => b.classList.toggle("xbg-on", b.dataset.filter === filter));
    ui.layouts.querySelectorAll("button").forEach((b) => b.classList.toggle("xbg-on", b.dataset.layout === settings.layout));
    // Up and down arrows drawn apart (the ⇅ character squeezes them together).
    if (!ui.sortBtn.firstChild) {
      ui.sortBtn.innerHTML = '<svg class="xbg-sort-icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20V4M2.5 7.5 6 4l3.5 3.5"/><path d="M18 4v16M14.5 16.5 18 20l3.5-3.5"/></svg><span></span>';
    }
    ui.sortBtn.lastChild.textContent = settings.sort === "oldest" ? "Oldest" : "Newest";
  }

  function updateHeader() {
    if (!ui) return;
    const c = view === "collection" ? getCollection(openId) : null;
    ui.back.classList.toggle("xbg-hidden", !c);
    ui.close.classList.toggle("xbg-hidden", !!c);
    ui.tabs.classList.toggle("xbg-hidden", !!c);
    ui.controls.classList.toggle("xbg-collapsed", view === "collections");
    ui.selectBtn.classList.toggle("xbg-hidden", view === "collections" || settings.layout === "years");
    ui.selectBtn.textContent = selectMode ? "Cancel" : "Select";
    ui.titleName.textContent = c ? c.name : "Bookmarks";
    const searching = searchTerms.length && view !== "collections";
    ui.count.textContent = searching
      ? `${current.length.toLocaleString()} found`
      : (c ? c.keys.length : view === "collections" ? collections.length : totalCount || allItems().length).toLocaleString();
    ui.count.title = view === "collections" ? "collections" : searching ? "pictures and videos matching your search" : "pictures and videos (a post can have up to 4)";
    ui.tabs.querySelectorAll(".xbg-tab").forEach((t) => t.classList.toggle("xbg-on", t.dataset.view === view));
    if (ui.tabInk && view !== "collection") ui.tabInk.style.transform = `translateX(${view === "all" ? 0 : 100}%)`;

    let text = "";
    let canRefresh = false;
    if (view === "all") {
      const s = loadState;
      if (!isBookmarks()) {
        if (partialInfo) text = `Partly loaded (${partialInfo.posts.toLocaleString()} bookmarks) · open your bookmarks to finish`;
        else text = (cached.size || fresh.size) && cacheTime ? `Saved copy · ${ago(cacheTime)}` : cached.size || fresh.size ? "Saved copy" : "";
        canRefresh = true;
      } else if (scrollTimer) text = "Loading more…";
      else if (s.state === "checking") text = "Checking for new bookmarks…";
      else if (s.state === "loading") text = loadingText(s.posts);
      else if (s.state === "waiting") {
        const wait = s.seconds >= 90 ? `${Math.ceil(s.seconds / 60)} min` : `${s.seconds}s`;
        text = `X asked for a pause · continuing in ${wait}` + (s.posts ? ` · ${s.posts.toLocaleString()} so far` : "");
      }
      else if (s.state === "done" && s.quick) text = s.fresh ? `Up to date · ${s.fresh.toLocaleString()} new` : "Up to date";
      else if (s.state === "done" && s.incomplete) text = "Couldn’t load everything";
      else if (s.state === "done") text = s.posts ? `All ${s.posts.toLocaleString()} bookmarks loaded` : "All loaded";
      else if (s.state === "failed" && s.nothing) text = "X didn’t send your bookmarks";
      else if (s.state === "failed") text = "Couldn’t load everything";
    }
    ui.statusText.textContent = text;
    ui.refreshBtn.classList.toggle("xbg-hidden", !canRefresh);

    // The ring fills as bookmarks arrive, measured against how many the last
    // full load found; the first time, it spins with the live count instead.
    const loading = view === "all" && isBookmarks() && (loadState.state === "loading" || loadState.state === "waiting");
    ui.progress.classList.toggle("xbg-hidden", !loading);
    if (loading) {
      const n = loadState.posts || 0;
      const known = lastTotal > n;
      const pct = known ? Math.min(99, Math.max(1, Math.floor((n / lastTotal) * 100))) : 0;
      ui.progress.classList.toggle("xbg-progress-unknown", !known);
      ui.progressFill.style.strokeDasharray = known ? `${pct} 100` : "";
      ui.progressPct.textContent = known ? pct + "%" : "";
      ui.progress.setAttribute("aria-valuenow", String(pct));
    }
  }

  // X doesn't say how many bookmarks you have, so count them as they arrive
  // and compare with the total from the last full load.
  function loadingText(n) {
    if (!n) return cached.size ? "Updating…" : "Loading all bookmarks…";
    const done = n.toLocaleString();
    return lastTotal && lastTotal > n ? `${done} of ~${lastTotal.toLocaleString()}` : `Loading… ${done} so far`;
  }

  // Where you were on the Collections page and inside each collection, so going
  // back to either one returns you exactly there.
  let collectionsSpot = null;
  const collectionSpots = new Map(); // collection id -> spot

  function setView(value, id = null, slide = null, fromHistory = false) {
    saveSpot();
    const from = view;
    // Opening a collection is one step back, so Android's back gesture returns to Collections.
    if (value === "collection" && from !== "collection") addBackStep();
    else if (from === "collection" && value !== "collection" && !fromHistory) removeBackStep();
    const here = { top: ui.scroller.scrollTop, barHidden: ui.bar.classList.contains("xbg-bar-hidden") };
    if (from === "collections" && value !== "collections") collectionsSpot = here;
    if (from === "all" && value !== "all") allSpot = here;
    if (from === "collection") collectionSpots.set(openId, here);
    view = value;
    openId = id;
    if (selectMode) setSelectMode(false);
    rebuild();
    const spot = value === "collections" && from === "collection" ? collectionsSpot : value === "collection" ? collectionSpots.get(id) : value === "all" && from !== "all" ? allSpot : null;
    if (spot) {
      ui.jumped = true; // our own scroll: leave the header as it was
      ui.bar.classList.toggle("xbg-bar-hidden", spot.barHidden && spot.top > 0);
      // Room for the header now (it can be a different height here), not a frame later.
      ui.scroller.style.paddingTop = settings.headerHidden ? "0px" : ui.bar.offsetHeight + "px";
      ui.scroller.scrollTop = spot.top;
      fillPage();
    }
    if (slide) {
      ui.scroller.classList.remove("xbg-slide-left", "xbg-slide-right");
      void ui.scroller.offsetWidth;
      ui.scroller.classList.add(`xbg-slide-${slide}`);
    }
  }

  function setFilter(value) {
    filter = value;
    syncControls();
    rebuild();
  }

  // Typing redraws a moment after you pause, so big libraries stay responsive.
  let searchTimer = null;
  function setSearch(value, typed = false) {
    searchText = String(value || "").slice(0, 100);
    if (ui) {
      if (ui.search.value !== searchText) ui.search.value = searchText;
      ui.searchClear.classList.toggle("xbg-hidden", !searchText);
    }
    clearTimeout(searchTimer);
    const apply = () => {
      const terms = searchText.toLowerCase().split(/\s+/).filter((t) => t && t !== "@");
      if (terms.join(" ") === searchTerms.join(" ")) return;
      searchTerms = terms;
      if (galleryOpen() && view !== "collections") rebuild();
      saveSpot();
    };
    if (typed) searchTimer = setTimeout(apply, 220);
    else apply();
  }

  // Bring the header and its filters back if they were tucked away, then type.
  function openSearch() {
    if (!ui || view === "collections") return;
    if (settings.headerHidden || settings.filtersHidden) {
      settings.filtersHidden = false;
      ui.overlay.classList.remove("xbg-filters-off");
      ui.hbtn.classList.remove("xbg-half");
      if (settings.headerHidden) setHeaderHidden(false);
      else saveSettings();
    }
    ui.bar.classList.remove("xbg-bar-hidden");
    ui.search.focus();
  }

  function setLayout(value) {
    settings.layout = value;
    saveSettings();
    if (selectMode && value === "years") setSelectMode(false);
    syncControls();
    rebuild();
  }

  // `fromHistory` is set when the phone's back gesture already took us back.
  function setSelectMode(on, fromHistory = false) {
    if (on && !selectMode) addBackStep();
    else if (!on && selectMode && !fromHistory) removeBackStep();
    selectMode = on;
    selected.clear();
    ui.grid.querySelectorAll(".xbg-selected").forEach((t) => t.classList.remove("xbg-selected"));
    ui.overlay.classList.toggle("xbg-selecting", on);
    updateSelectBar();
    updateHeader();
  }

  function toggleSelect(key, forceOn = false) {
    if (forceOn || !selected.has(key)) selected.add(key);
    else selected.delete(key);
    const tile = ui.grid.querySelector(`.xbg-tile[data-key="${CSS.escape(key)}"]`);
    if (tile) tile.classList.toggle("xbg-selected", selected.has(key));
    updateSelectBar();
  }

  function updateSelectBar() {
    if (!ui) return;
    ui.selectBar.classList.toggle("xbg-hidden", !selectMode);
    ui.selectInfo.textContent = selected.size ? `${selected.size} selected` : "Tap posts to select";
    ui.addBtn.disabled = !selected.size;
    ui.removeBtn.disabled = !selected.size;
    ui.removeBtn.classList.toggle("xbg-hidden", view !== "collection");
  }

  function removeSelected() {
    const c = getCollection(openId);
    if (!c || !selected.size) return;
    const n = selected.size;
    setMembership(c, [...selected], false);
    setSelectMode(false);
    rebuild(false);
    toast(`Removed ${plural(n, "post")}`);
  }

  function collectionMenu() {
    const c = getCollection(openId);
    if (!c) return;
    openSheet(
      c.name,
      el(
        "div",
        { class: "xbg-sheet-body" },
        el("button", { class: "xbg-secondary", onclick: () => askName("Rename collection", c.name, (name) => { c.name = name; saveCollections(); updateHeader(); }) }, "Rename"),
        el(
          "button",
          { class: "xbg-secondary xbg-danger-text", onclick: () => confirmSheet("Delete collection?", `“${c.name}” will be deleted. The posts stay in your bookmarks.`, "Delete", () => {
            collections = collections.filter((x) => x !== c);
            saveCollections();
            setView("collections");
            toast("Collection deleted");
          }) },
          "Delete collection"
        )
      )
    );
  }

  // --- Building what the grid shows ----------------------------------------

  function matches(item) {
    if (filter !== "all" && (filter === "photo" ? item.type !== "photo" : item.type === "photo")) return false;
    return !searchTerms.length || matchesSearch(item);
  }

  // Every word must appear; a word starting with @ only looks at who posted it.
  function matchesSearch(item) {
    const user = (((item.tweet || "").match(/^https:\/\/x\.com\/([^/]+)\/status\//) || [])[1] || "").toLowerCase();
    const text = (item.text || "").toLowerCase();
    for (const t of searchTerms) {
      if (t[0] === "@" ? !user.includes(t.slice(1)) : !text.includes(t) && !user.includes(t)) return false;
    }
    return true;
  }

  function dateOf(item) {
    return (settings.dateMode === "posted" ? item.posted || item.saved : item.saved || item.posted) || 0;
  }

  // Remembered per date, since redraws during loading ask for the same ones again and again.
  const monthCache = new Map();
  const monthKey = (d) => {
    if (!d) return "unknown";
    let k = monthCache.get(d);
    if (k === undefined) {
      const t = new Date(d);
      k = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
      monthCache.set(d, k);
    }
    return k;
  };
  const monthLabel = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Date unknown");
  const yearOf = (d) => (d ? monthKey(d).slice(0, 4) : "unknown");

  function computeEntries() {
    const c = view === "collection" ? getCollection(openId) : null;
    const base = c ? c.keys.map(getItem).filter(Boolean) : allItems();
    totalCount = c ? c.keys.length : base.length;
    const dir = settings.sort === "oldest" ? -1 : 1;
    // Dated posts first, by date; ties and undated posts keep their bookmark order.
    let list = [];
    for (let i = 0; i < base.length; i++) if (matches(base[i])) list.push({ item: base[i], i, d: dateOf(base[i]) });
    list.sort((a, b) => (!a.d !== !b.d ? (a.d ? -1 : 1) : dir * (b.d - a.d || a.i - b.i)));
    list = applyPeriod(list);
    current = list.map((x) => x.item);
    const out = [];
    if (settings.layout === "months") {
      let header = null;
      for (const x of list) {
        const key = monthKey(x.d);
        if (!header || header.header !== key) {
          header = { header: key, label: monthLabel(x.d), count: 0 };
          out.push(header);
        }
        header.count++;
        out.push({ item: x.item });
      }
    } else {
      for (const x of list) out.push({ item: x.item });
    }
    return out;
  }

  // Work out which years/months exist (for the period bar), then keep only the
  // chosen year or month when in Months view.
  function applyPeriod(list) {
    const years = new Map();
    const months = new Map();
    for (const x of list) {
      const y = yearOf(x.d);
      years.set(y, (years.get(y) || 0) + 1);
      if (y === periodYear) {
        const k = monthKey(x.d);
        if (!months.has(k)) months.set(k, { key: k, d: x.d, count: 0 });
        months.get(k).count++;
      }
    }
    const byTime = (a, b) => (a === "unknown") - (b === "unknown") || b.localeCompare(a);
    periods = {
      years: [...years.keys()].sort(byTime).map((y) => ({ year: y, count: years.get(y) })),
      // Months read left to right through the year: January first.
      months: [...months.values()].sort((a, b) => a.key.localeCompare(b.key)),
    };
    if (settings.layout !== "months" || !periodYear) return list;
    return list.filter((x) => yearOf(x.d) === periodYear && (!periodMonth || monthKey(x.d) === periodMonth));
  }

  function renderPeriodBar() {
    const show = view !== "collections" && (settings.layout === "months" || settings.layout === "years");
    ui.periodBar.classList.toggle("xbg-hidden", !show);
    if (!show) return;
    const chip = (label, on, onclick, count, key) =>
      el("button", { class: "xbg-pchip" + (on ? " xbg-on" : ""), onclick }, label, count != null ? el("small", { "data-k": key }, String(count)) : "");
    const yearLabel = (y) => (y === "unknown" ? "No date" : y);
    const showMonths = settings.layout === "months" && periodYear && periodYear !== "unknown";
    const selection = [settings.layout, periodYear, periodMonth].join("|");
    const structure = [selection, ...periods.years.map((y) => y.year), "/", ...(showMonths ? periods.months.map((m) => m.key) : [])].join("|");

    if (ui.periodBar.dataset.structure === structure) {
      // Same chips as before (e.g. more bookmarks finished loading): just update
      // the numbers, so the bar doesn't move while you're sliding it.
      for (const y of periods.years) {
        const n = ui.yearBar.querySelector(`small[data-k="${CSS.escape(y.year)}"]`);
        if (n) n.textContent = String(y.count);
      }
      for (const m of periods.months) {
        const n = ui.monthBar.querySelector(`small[data-k="${CSS.escape(m.key)}"]`);
        if (n) n.textContent = String(m.count);
      }
      return;
    }

    const yearChips = [chip("All years", !periodYear || settings.layout === "years", () => choosePeriod(null, null))];
    for (const { year, count } of periods.years) {
      yearChips.push(chip(yearLabel(year), settings.layout === "months" && periodYear === year, () => choosePeriod(year, null), count, year));
    }
    const monthChips = [];
    if (showMonths) {
      monthChips.push(chip(`All of ${periodYear}`, !periodMonth, () => choosePeriod(periodYear, null)));
      for (const m of periods.months) {
        const label = new Date(m.d).toLocaleDateString(undefined, { month: "short" });
        monthChips.push(chip(label, periodMonth === m.key, () => choosePeriod(periodYear, m.key), m.count, m.key));
      }
    }
    const keep = [ui.yearBar.scrollLeft, ui.monthBar.scrollLeft];
    ui.periodBar.dataset.structure = structure;
    ui.yearBar.replaceChildren(...yearChips);
    ui.monthBar.replaceChildren(...monthChips);
    ui.monthBar.classList.toggle("xbg-hidden", !monthChips.length);
    if (ui.periodBar.dataset.selection === selection) {
      // Same choice, new chips: stay exactly where you were.
      ui.yearBar.scrollLeft = keep[0];
      ui.monthBar.scrollLeft = keep[1];
      return;
    }
    // A new year or month was picked: bring it into the middle.
    ui.periodBar.dataset.selection = selection;
    for (const row of [ui.yearBar, ui.monthBar]) {
      const on = row.querySelector(".xbg-on");
      if (on) row.scrollTo({ left: on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2, behavior: "smooth" });
    }
  }

  function choosePeriod(year, month) {
    periodYear = year;
    periodMonth = month;
    if (year && settings.layout !== "months") setLayout("months");
    else rebuild();
  }

  const sig = (e) => (e ? (e.header ? "h:" + e.header : e.item.key) : "");

  // Grid tiles are plain thumbnails (videos too) so scrolling stays smooth;
  // videos play in the full-screen viewer.
  // Returns true when it asked for another size (so the image isn't broken yet).
  function thumbFallback(img) {
    if (img.dataset.fb || !/name=360x360/.test(img.src)) return false;
    img.dataset.fb = "1";
    img.src = img.src.replace("name=360x360", "name=small");
    return true;
  }

  function makeTile(item) {
    const tile = el("button", { class: "xbg-tile" + (selected.has(item.key) ? " xbg-selected" : ""), "data-key": item.key, "aria-label": item.type === "photo" ? "Photo" : "Video" });
    // The picture is asked for once the tile is on screen and the scrolling has slowed (see loadThumbs).
    tile.append(el("img", { "data-src": item.thumb, decoding: "async", alt: "", referrerpolicy: "no-referrer" }));
    if (item.type !== "photo") tile.append(el("span", { class: "xbg-badge xbg-badge-time" }, item.type === "gif" ? "GIF" : "▶"));
    return tile;
  }

  function makeEntry(e) {
    if (!e.header) return makeTile(e.item);
    const countEl = el("span", { class: "xbg-section-count" }, plural(e.count, "post"));
    headerEls.set(e.header, countEl);
    return el("div", { class: "xbg-section", "data-key": e.header }, el("span", {}, e.label), countEl);
  }

  // Only the rows near the screen exist in the page (like the iPhone's Photos
  // app). Every tile's spot is worked out up front, so tens of thousands of
  // photos scroll and fast-scroll smoothly.
  const COLS = 4;
  const GAP = 2;
  const HEADER_H = 50;
  const BUFFER = 900; // px drawn above and below the screen
  let tops = [];
  let lefts = []; // -1 for a month header (full width)
  let tileSize = 0;
  let laidWidth = 0;
  let rendered = new Map(); // sig -> element on the page
  const spare = new Map(); // recently scrolled-past tiles, kept so scrolling back is instant
  const SPARE_MAX = 600;
  let lastScroll = { y: 0, t: 0 };
  let thumbTimer = null;

  function layoutGrid() {
    const width = ui.grid.clientWidth || ui.scroller.clientWidth || window.innerWidth;
    laidWidth = width;
    tileSize = (width - GAP * (COLS - 1)) / COLS;
    tops = new Array(entries.length);
    lefts = new Array(entries.length);
    let y = 0;
    let col = 0;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].header) {
        if (col) (y += tileSize + GAP), (col = 0);
        tops[i] = y;
        lefts[i] = -1;
        y += HEADER_H;
      } else {
        tops[i] = y;
        lefts[i] = col * (tileSize + GAP);
        if (++col === COLS) (col = 0), (y += tileSize + GAP);
      }
    }
    if (col) y += tileSize;
    ui.grid.style.height = Math.ceil(y) + "px";
  }

  // The first entry whose bottom edge is below `y` (grid coordinates).
  function indexAt(y) {
    let lo = 0;
    let hi = entries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] + (lefts[mid] < 0 ? HEADER_H : tileSize) <= y) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(lo, 0);
  }

  const gridTop = () => ui.grid.getBoundingClientRect().top - ui.scroller.getBoundingClientRect().top + ui.scroller.scrollTop;

  function renderVisible() {
    if (!ui || ui.grid.classList.contains("xbg-hidden")) return;
    if (ui.grid.clientWidth && ui.grid.clientWidth !== laidWidth) layoutGrid();
    const y = ui.scroller.scrollTop - gridTop();
    const bottom = y + ui.scroller.clientHeight + BUFFER;
    const next = new Map();
    const frag = document.createDocumentFragment();
    for (let i = entries.length ? indexAt(y - BUFFER) : 0; i < entries.length && tops[i] < bottom; i++) {
      const e = entries[i];
      const key = sig(e);
      let node = rendered.get(key);
      if (node) rendered.delete(key);
      else {
        node = spare.get(key);
        if (node) {
          spare.delete(key);
          node.classList.toggle("xbg-selected", selected.has(key));
        } else node = makeEntry(e);
        frag.append(node);
      }
      const pos = lefts[i] < 0 ? `${tops[i]}|h` : `${tops[i]}|${lefts[i]}|${tileSize}`;
      if (node._pos !== pos) {
        node._pos = pos;
        const st = node.style;
        st.top = tops[i] + "px";
        if (lefts[i] < 0) {
          st.left = "0";
          st.width = "100%";
          st.height = HEADER_H + "px";
        } else {
          st.left = lefts[i] + "px";
          st.width = st.height = tileSize + "px";
        }
      }
      next.set(key, node);
    }
    for (const [key, node] of rendered) {
      node.remove();
      if (node.classList.contains("xbg-tile")) spare.set(key, node);
    }
    for (const key of spare.keys()) {
      if (spare.size <= SPARE_MAX) break;
      spare.delete(key);
    }
    rendered = next;
    if (frag.childNodes.length) ui.grid.append(frag);

    // Flinging fast: wait until it slows before asking for pictures, so the
    // phone isn't busy making thumbnails for photos that have already flown past.
    const now = performance.now();
    const speed = Math.abs(ui.scroller.scrollTop - lastScroll.y) / Math.max(now - lastScroll.t, 1);
    lastScroll = { y: ui.scroller.scrollTop, t: now };
    clearTimeout(thumbTimer);
    if (speed < 2.5 && !scrubbing) loadThumbs();
    else thumbTimer = setTimeout(loadThumbs, 90);
  }

  function loadThumbs() {
    const y = ui.scroller.scrollTop - gridTop();
    const lo = y - 300;
    const hi = y + ui.scroller.clientHeight + 600;
    for (const node of rendered.values()) {
      const img = node.firstChild;
      if (!img || img.tagName !== "IMG" || !img.dataset.src) continue;
      const top = parseFloat(node.style.top);
      if (top + tileSize < lo || top > hi) continue;
      img.src = img.dataset.src;
      delete img.dataset.src;
    }
  }

  // Start the grid afresh (new view, filter or sort).
  function renderPrefix() {
    ui.grid.replaceChildren();
    rendered.clear();
    spare.clear();
    headerEls.clear();
    layoutGrid();
    renderVisible();
  }

  // Same view, updated list: keep the tiles that are still there.
  function appendUpTo() {
    layoutGrid();
    renderVisible();
  }

  function fillPage() {
    if (ui && entries.length) renderVisible();
  }

  function rebuild(resetScroll = true) {
    if (!ui) return;
    if (resetScroll) {
      ui.scroller.scrollTop = 0;
      ui.bar.classList.remove("xbg-bar-hidden");
    }
    const mode = view === "collections" ? "collections" : settings.layout === "years" ? "years" : "grid";
    ui.grid.classList.toggle("xbg-hidden", mode !== "grid");
    ui.years.classList.toggle("xbg-hidden", mode !== "years");
    ui.collGrid.classList.toggle("xbg-hidden", mode !== "collections");
    if (mode === "collections") {
      entries = [];
      ui.periodBar.classList.add("xbg-hidden");
      renderCollections();
    } else {
      entries = computeEntries();
      renderPeriodBar();
      if (mode === "years") {
        renderYears();
        entries = [];
      }
      renderPrefix();
      fillPage();
    }
    updateHeader();
    updateEmpty();
  }

  // New bookmarks arrived: keep what's on screen if it's still in the same
  // order, otherwise redraw in place without jumping to the top.
  let refreshTimer = null;
  function scheduleRefresh() {
    if (!galleryOpen()) return;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, entries.length ? Math.max(700, Math.min(4000, entries.length / 50)) : 60); // big lists redraw less often while loading
  }

  function refresh() {
    if (!galleryOpen()) return;
    if (view === "collections") return updateHeader();
    if (settings.layout === "years") return rebuild(false);
    const next = computeEntries();
    renderPeriodBar();
    entries = next;
    // Tiles that are still in the list stay on the page, so nothing flickers.
    for (const e of entries) if (e.header && headerEls.has(e.header)) headerEls.get(e.header).textContent = plural(e.count, "post");
    appendUpTo();
    fillPage();
    updateHeader();
    updateEmpty();
  }

  function updateEmpty() {
    const c = view === "collection" ? getCollection(openId) : null;
    if (view === "collections") return;
    if (current.length) ui.empty.textContent = "";
    else if (searchTerms.length && (c ? c.keys.length : totalCount)) {
      ui.empty.replaceChildren(`Nothing matches “${searchText.trim()}”. `, el("button", { class: "xbg-link", onclick: () => setSearch("") }, "Clear search"));
    } else if (c) ui.empty.textContent = c.keys.length ? "Nothing here for this filter." : "No posts yet. Go to All posts, long-press a post, pick some more, then tap “Add to collection”.";
    else if (!isBookmarks() && !totalCount) {
      ui.empty.replaceChildren("Open your bookmarks to fill the gallery. ", el("button", { class: "xbg-link", onclick: () => goToBookmarks() }, "Go to bookmarks"));
    } else if (!totalCount && loadState.nothing) {
      ui.empty.replaceChildren("X didn’t send your bookmarks. ", el("button", { class: "xbg-link", onclick: () => location.reload() }, "Reload to try again"));
    } else if (!totalCount) ui.empty.textContent = "Loading your bookmarks…";
    else ui.empty.textContent = "Nothing here for this filter.";
  }

  function renderYears() {
    const groups = [];
    const byYear = new Map();
    for (const item of current) {
      const year = yearOf(dateOf(item));
      let g = byYear.get(year);
      if (!g) {
        g = { year, items: [] };
        byYear.set(year, g);
        groups.push(g);
      }
      g.items.push(item);
    }
    // Skip redrawing (and re-loading the covers) when nothing changed.
    const signature = groups.map((g) => `${g.year}:${g.items.length}:${g.items.slice(0, 4).map((i) => i.key).join(",")}`).join("|");
    if (ui.years.dataset.sig === signature) return;
    ui.years.dataset.sig = signature;
    ui.years.replaceChildren(
      ...groups.map((g) =>
        el(
          "button",
          { class: "xbg-card", onclick: () => openYear(g.year) },
          mosaic(g.items, "xbg-card-cover"),
          el("div", { class: "xbg-card-name" }, g.year === "unknown" ? "Date unknown" : g.year),
          el("div", { class: "xbg-card-count" }, plural(g.items.length, "post"))
        )
      )
    );
  }

  // Tapping a year shows that year's posts, by month.
  function openYear(year) {
    choosePeriod(year, null);
  }

  function collectionCards() {
    const cards = [
      el(
        "button",
        { class: "xbg-card", onclick: () => askName("New collection", "", (name) => { createCollection(name); rebuild(false); }) },
        el("div", { class: "xbg-card-cover xbg-plus" }, "＋"),
        el("div", { class: "xbg-card-name" }, "New collection")
      ),
    ];
    for (const c of collections) {
      cards.push(
        el(
          "button",
          { class: "xbg-card", onclick: () => setView("collection", c.id, "left") },
          cover(c, "xbg-card-cover"),
          el("div", { class: "xbg-card-name" }, c.name),
          el("div", { class: "xbg-card-count" }, plural(c.keys.length, "post"))
        )
      );
    }
    return cards;
  }

  function renderCollections() {
    ui.collGrid.replaceChildren(...collectionCards());
    ui.empty.replaceChildren(
      collections.length ? "" : "Group your favourite posts into collections, like on Instagram.",
      el(
        "span",
        { class: "xbg-backup" },
        el("button", { class: "xbg-link", onclick: backup }, "Back up collections"),
        " · ",
        el("button", { class: "xbg-link", onclick: restore }, "Restore from backup")
      )
    );
  }

  // --- Opening and closing -------------------------------------------------

  function openGallery() {
    saveSpot();
    buildUi();
    if (!ui) return;
    if (!gotData && isBookmarks()) scanPage();
    if (!galleryOpen()) addBackStep(); // back from the grid closes the gallery, not the page
    ui.overlay.classList.remove("xbg-hidden");
    updateBall();
    rebuild();
    if (isBookmarks() && (loadState.state === "failed" || (!gotData && loadState.state === "idle"))) {
      // Background loading isn't working (or hasn't started): scroll the page instead.
      setTimeout(() => {
        if (galleryOpen() && (loadState.state === "failed" || !gotData)) startScrollLoading();
      }, gotData ? 0 : 4000);
    }
  }

  // Firefox on Android reloads the page after it's been in the background for
  // a while. Remember where you were (tab, collection, scroll position, the
  // post you had open) so the gallery comes straight back to the same spot.
  const SPOT_KEY = "xbg_spot";
  let spotTimer = null;
  function centreFeedKey() {
    const mid = window.innerHeight / 2;
    for (const el of ui.feed.querySelectorAll(".xbg-post")) {
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) return el.dataset.key;
    }
    return null;
  }
  function saveSpotNow() {
    clearTimeout(spotTimer);
    try {
      if (!ui || !galleryOpen()) return sessionStorage.removeItem(SPOT_KEY);
      sessionStorage.setItem(SPOT_KEY, JSON.stringify({ view, openId, filter, search: searchText, top: Math.round(ui.scroller.scrollTop), post: feedOpen() ? centreFeedKey() : null, at: Date.now() }));
    } catch (e) {
      /* private mode etc. */
    }
  }
  function saveSpot() {
    clearTimeout(spotTimer);
    spotTimer = setTimeout(saveSpotNow, 400);
  }
  document.addEventListener("visibilitychange", () => document.hidden && saveSpotNow());
  window.addEventListener("pagehide", saveSpotNow);

  function restoreSpot() {
    let spot = null;
    try {
      spot = JSON.parse(sessionStorage.getItem(SPOT_KEY) || "null");
    } catch (e) {
      /* ignore */
    }
    if (!spot || Date.now() - spot.at > 12 * 3600000) return false;
    openGallery();
    if (!ui) return false;
    if (spot.filter && spot.filter !== filter) setFilter(spot.filter);
    if (typeof spot.search === "string" && spot.search !== searchText) setSearch(spot.search);
    if (spot.view && spot.view !== view && (spot.view !== "collection" || getCollection(spot.openId))) setView(spot.view, spot.openId);
    ui.jumped = true;
    ui.scroller.style.paddingTop = (settings.headerHidden ? 0 : ui.bar.offsetHeight) + "px";
    ui.scroller.scrollTop = spot.top || 0;
    fillPage();
    if (spot.post && getItem(spot.post)) openLightbox(spot.post);
    return true;
  }

  function closeGallery(fromHistory = false) {
    if (!galleryOpen()) return;
    closeSheet();
    closeLightbox(false, false);
    stopScrollLoading();
    if (selectMode) setSelectMode(false);
    ui.overlay.classList.add("xbg-hidden");
    if (!fromHistory) removeBackStep();
    updateBall();
    saveSpot();
  }

  // Open the bookmarks page and pop the gallery open once it has loaded.
  // Moves X itself to the bookmarks page the way its own links do, without a
  // page load, so Firefox doesn't ask "Open this link in X app?". If X doesn't
  // follow within a few seconds, fall back to a normal page load.
  let quietPop = 0;
  function goToBookmarks() {
    try {
      sessionStorage.setItem("xbg_open", "1");
    } catch (e) {
      /* fine */
    }
    if (/(^|\.)(x|twitter)\.com$/.test(location.hostname) && !isMainBookmarks()) {
      try {
        history.pushState({}, "", "/i/bookmarks");
        quietPop++;
        // The event carries the page's own copy of the state: in Firefox an
        // object made here can't be read by X's router ("Permission denied").
        window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        watchPage();
        openGallery();
        setTimeout(() => {
          if (isMainBookmarks() && !gotData && loadState.state === "idle" && !document.querySelector('[data-testid="cellInnerDiv"]')) location.reload();
        }, 6000);
        return;
      } catch (e) {
        /* fall through */
      }
    }
    location.href = "https://x.com/i/bookmarks";
  }

  // --- Post feed --------------------------------------------------------------

  const FEED_CHUNK = 10;

  const feedOpen = () => ui && !ui.lightbox.classList.contains("xbg-hidden") && !ui.lightbox.classList.contains("xbg-closing");

  function icon(d, filled) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", filled ? "#fff" : "none");
    path.setAttribute("stroke", "#fff");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
    return svg;
  }
  const BOOKMARK_PATH = "M6.5 3h11A1.5 1.5 0 0 1 19 4.5V21l-7-4.6L5 21V4.5A1.5 1.5 0 0 1 6.5 3z";
  const OPEN_PATH = "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5";

  // Each post is just its picture or video, edge to edge, with the name and
  // date laid over the top and Save / Open post as round buttons over the
  // corner, like Instagram.
  // 1200px is sharp on any phone and much lighter than the 2048px original.
  const feedImg = (item) => (item.full ? item.full.replace(/([?&]name=)large\b/, "$1medium") : item.thumb);

  function feedPost(item) {
    const user = ((item.tweet || "").match(/^https:\/\/x\.com\/([^/]+)\/status\//) || [])[1];
    const d = dateOf(item);
    const head = el(
      "div",
      { class: "xbg-post-head" },
      el("span", { class: "xbg-post-user" }, user && user !== "i" ? "@" + user : "Post"),
      el("span", { class: "xbg-post-date" }, d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "")
    );
    // Size the box from the media's real shape (when known) so the feed
    // doesn't jump as pictures load.
    const ratio = item.w && item.h ? Math.min(Math.max(item.w / item.h, 0.56), 2) : 1;
    const isVideo = item.type !== "photo" && item.video;
    const media = el("div", { class: "xbg-post-media" + (isVideo ? " xbg-is-video" : ""), style: `aspect-ratio: ${ratio.toFixed(4)}` });
    if (item.type === "photo") {
      media.append(el("img", { src: feedImg(item), loading: "lazy", decoding: "async", alt: "", referrerpolicy: "no-referrer" }));
    } else if (isVideo) {
      videoPlayer(item, media);
    } else {
      media.append(
        el("img", { src: feedImg(item), loading: "lazy", alt: "", referrerpolicy: "no-referrer" }),
        el("p", { class: "xbg-note" }, "This video can’t play here. Tap the ↗ button to watch it on X.")
      );
    }
    const save = el("button", { class: "xbg-fab-btn xbg-save-btn", onclick: () => openPicker([item.key], () => afterSave(item.key)) });
    paintSave(save, item.key);
    const actions = el("div", { class: "xbg-post-actions" }, save);
    if (item.tweet) {
      const open = el("a", { class: "xbg-fab-btn", href: item.tweet, target: "_blank", rel: "noopener noreferrer", "aria-label": "Open post on X" }, icon(OPEN_PATH, false));
      // In the Android app the post opens in the same screen; reopen the
      // gallery when you come back to your bookmarks.
      if (window.XbgAndroid) open.addEventListener("click", () => {
        try {
          sessionStorage.setItem("xbg_open", "1");
        } catch (e) {
          /* fine */
        }
      });
      actions.append(open);
    }
    media.append(head, actions);
    // The buttons (and a video's controls) stay hidden until you tap the post.
    media.addEventListener("click", (e) => {
      if (e.target.closest("button, a, .xbg-vbar")) return;
      showPostUi(media, !media.classList.contains("xbg-ui-on"));
    });
    return el("article", { class: "xbg-post", "data-key": item.key }, media);
  }

  function showPostUi(media, on) {
    media.classList.toggle("xbg-ui-on", on);
    clearTimeout(media._hide);
    const v = media.querySelector("video");
    // While a video plays, its controls tuck away again after a few seconds.
    if (on && v && !v.paused) media._hide = setTimeout(() => showPostUi(media, false), 3500);
  }

  // --- Video player (laid out like the X app's) ------------------------------
  // The cover picture shows until the video is actually playing, then the
  // video fades in over it: no white flash. Controls: play/pause, a thin
  // progress bar you can drag, time, sound, rotate and full screen. Full
  // screen keeps the phone upright; the rotate button turns it sideways.
  const VPATH = {
    play: "M7 5.4v13.2c0 .8.9 1.3 1.6.8l10.3-6.6c.6-.4.6-1.3 0-1.7L8.6 4.6C7.9 4.2 7 4.6 7 5.4z",
    pause: "M6 4h4v16H6zM14 4h4v16h-4z",
    sound: "M3 9h4l5-4v14l-5-4H3zM15.5 8.5a5 5 0 010 7M18 6a8.5 8.5 0 010 12",
    muted: "M3 9h4l5-4v14l-5-4H3zM16 9.5l5 5M21 9.5l-5 5",
    full: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
    exitFull: "M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5",
    rotate: "M7.5 3h9A1.5 1.5 0 0118 4.5v15a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 016 19.5v-15A1.5 1.5 0 017.5 3zM20.5 9.5a8 8 0 010 5M3.5 14.5a8 8 0 010-5",
  };
  function vicon(name, filled) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", VPATH[name]);
    if (filled) path.setAttribute("fill", "currentColor");
    else {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    svg.append(path);
    return svg;
  }
  const clock = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}` : "0:00");

  function videoPlayer(item, media) {
    const cover = el("img", { class: "xbg-vcover", src: feedImg(item), alt: "", referrerpolicy: "no-referrer" });
    const v = el("video", { src: item.video, muted: true, loop: true, playsinline: true, preload: "none", disablepictureinpicture: true });
    v.muted = true;
    v.addEventListener("playing", () => media.classList.add("xbg-vready"));
    const btn = (name, label, onclick, filled) => {
      const b = el("button", { class: "xbg-vbtn", "aria-label": label, onclick: (e) => { e.stopPropagation(); onclick(); showPostUi(media, true); } });
      b.append(vicon(name, filled));
      return b;
    };
    const setIcon = (b, name, filled) => b.replaceChildren(vicon(name, filled));
    const playBtn = btn("play", "Play or pause", () => (v.paused ? v.play().catch(() => {}) : v.pause()), true);
    const soundBtn = btn("muted", "Sound", () => { v.muted = !v.muted; setIcon(soundBtn, v.muted ? "muted" : "sound"); });
    const rotateBtn = btn("rotate", "Rotate", () => rotate());
    const fullBtn = btn("full", "Full screen", () => toggleFull());
    const time = el("span", { class: "xbg-vtime" }, "0:00 / " + clock(item.duration ? item.duration / 1000 : NaN));
    const fill = el("div", { class: "xbg-vfill" });
    const track = el("div", { class: "xbg-vtrack" }, fill);
    const bar = el("div", { class: "xbg-vbar" }, track, el("div", { class: "xbg-vrow" }, playBtn, time, el("span", { class: "xbg-vspace" }), soundBtn, rotateBtn, fullBtn));
    v.addEventListener("play", () => setIcon(playBtn, "pause", true));
    v.addEventListener("pause", () => setIcon(playBtn, "play", true));
    v.addEventListener("timeupdate", () => {
      fill.style.width = (v.duration ? (v.currentTime / v.duration) * 100 : 0) + "%";
      time.textContent = clock(v.currentTime) + " / " + clock(v.duration);
    });
    // Drag along the bar to seek.
    const seek = (e) => {
      const r = track.getBoundingClientRect();
      if (v.duration) v.currentTime = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * v.duration;
    };
    track.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      track.setPointerCapture(e.pointerId);
      seek(e);
      const move = (ev) => seek(ev);
      const up = () => {
        track.removeEventListener("pointermove", move);
        track.removeEventListener("pointerup", up);
      };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
    });
    // Full screen is our own cover-the-screen view, not the browser's: Firefox
    // turns the phone sideways for any video in browser full screen, so that
    // is only used when you ask for it with the rotate button.
    const inReels = () => !!media.closest(".xbg-reels");
    function toggleFull() {
      if (inReels()) closeReels(true);
      else openReels(item.key, v);
    }
    async function rotate() {
      try {
        if (document.fullscreenElement) return await document.exitFullscreen(); // back upright
        if (!inReels()) openReels(item.key, v);
        await reels.root.requestFullscreen({ navigationUI: "hide" });
        await screen.orientation.lock("landscape");
      } catch (e) {
        /* rotation isn't available */
      }
    }
    media.append(cover, v, bar);
    if (buildingReel) setIcon(fullBtn, "exitFull");
    else ui.feedVideos.observe(v);
  }

  // --- Reels: full screen, one post at a time, swipe up / down -------------
  // Like Instagram Reels. The post under your finger moves with it; let go
  // and it carries on at your finger's speed, settling like a spring onto the
  // next or previous post (or back where it was). A quick flick is enough.
  // You can catch a post mid-move and keep dragging. Past the first or last
  // post it stretches and springs back. Only the post on screen plays.
  let reels = null; // { root, track, cur, slots: Map(index -> node), off, anim }
  let buildingReel = false;
  let reelMuted = true;

  function reelNode(i) {
    buildingReel = true;
    let post;
    try {
      post = feedPost(current[i]);
    } finally {
      buildingReel = false;
    }
    post.classList.add("xbg-reel");
    // Load the posts just off screen now, so they're there as they slide in.
    post.querySelectorAll("img").forEach((img) => (img.loading = "eager"));
    const v = post.querySelector("video");
    if (v) {
      v.preload = "metadata";
      v.addEventListener("volumechange", () => {
        if (reels && reels.slots.get(reels.cur) === post) reelMuted = v.muted;
      });
    }
    return post;
  }

  function placeReels() {
    const { slots, cur, track } = reels;
    const h = reels.root.clientHeight;
    for (const [i, node] of slots) node.style.transform = `translate3d(0, ${(i - cur) * h}px, 0)`;
    track.style.transform = `translate3d(0, ${reels.off}px, 0)`;
  }

  // Keep the posts just above and below ready; drop the rest.
  function fillReels() {
    const { slots, cur, track } = reels;
    for (const [i, node] of slots) {
      if (i < cur - 1 || i > cur + 2) {
        const v = node.querySelector("video");
        if (v) v.pause();
        node.remove();
        slots.delete(i);
      }
    }
    for (let i = Math.max(0, cur - 1); i <= Math.min(current.length - 1, cur + 2); i++) {
      if (slots.has(i)) continue;
      const node = reelNode(i);
      slots.set(i, node);
      track.append(node);
    }
    placeReels();
    for (const [i, node] of slots) {
      const v = node.querySelector("video");
      if (!v) continue;
      if (i === cur) {
        v.muted = reelMuted;
        node.querySelector(".xbg-vbtn[aria-label=Sound]")?.replaceChildren(vicon(reelMuted ? "muted" : "sound"));
        v.play().catch(() => {});
      } else {
        v.pause();
        if (Math.abs(i - cur) > 1 || v.currentTime) v.currentTime = 0;
        if (i === cur + 1) v.preload = "auto"; // the next one starts at once
      }
    }
  }

  function openReels(key, fromVideo) {
    const index = current.findIndex((it) => it.key === key);
    if (index < 0) return;
    if (reels) closeReels(true, true);
    const track = el("div", { class: "xbg-reels-track" });
    const root = el("div", { class: "xbg-reels" }, track);
    reels = { root, track, cur: index, slots: new Map(), off: 0, anim: null };
    if (fromVideo) {
      reelMuted = fromVideo.muted;
      fromVideo.pause();
    }
    ui.overlay.append(root);
    fillReels();
    // Carry on from the same moment.
    const v = fromVideo && reels.slots.get(index).querySelector("video");
    if (v && fromVideo.currentTime) v.currentTime = fromVideo.currentTime;
    wireReels(root);
    requestAnimationFrame(() => root.classList.add("xbg-reels-in"));
    addBackStep();
  }

  // Back to the feed, at whichever post you ended on.
  function closeReels(dropStep, instant) {
    if (!reels) return;
    const { root, cur } = reels;
    reels = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    root.querySelectorAll("video").forEach((v) => v.pause());
    if (instant) root.remove();
    else {
      root.classList.remove("xbg-reels-in");
      setTimeout(() => root.remove(), 260);
    }
    if (dropStep) removeBackStep();
    const item = current[cur];
    if (item && feedOpen()) {
      const post = ui.feed.querySelector(`.xbg-post[data-key="${CSS.escape(item.key)}"]`);
      if (post) centrePost(post);
      else openLightbox(item.key);
      const fv = ui.feed.querySelector(`.xbg-post[data-key="${CSS.escape(item.key)}"] video`);
      if (fv) fv.play().catch(() => {});
    }
  }

  function wireReels(root) {
    let drag = null;
    let frame = 0;
    const h = () => root.clientHeight;
    const offNow = () => new DOMMatrix(getComputedStyle(reels.track).transform).m42 || 0;
    root.addEventListener("touchstart", (e) => {
      if (!reels || e.touches.length !== 1 || e.target.closest(".xbg-vbar")) return (drag = null);
      const t = e.touches[0];
      // Caught mid-move: stop right where it is and follow the finger from there.
      const caught = !!reels.anim;
      if (reels.anim) {
        clearTimeout(reels.anim);
        reels.anim = null;
        reels.off = offNow();
        reels.track.style.transition = "none";
        placeReels();
      }
      drag = { x: t.clientX, y: t.clientY, base: reels.off, on: false, track: [], caught };
    }, { passive: true });
    root.addEventListener("touchmove", (e) => {
      if (!drag || !reels) return;
      const t = e.touches[0];
      const dx = t.clientX - drag.x;
      const dy = t.clientY - drag.y;
      if (!drag.on) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dx) > Math.abs(dy)) return (drag = null); // sideways isn't ours
        drag.on = true;
        drag.y = t.clientY;
      }
      if (e.cancelable) e.preventDefault();
      const raw = drag.base + (t.clientY - drag.y);
      const now = performance.now();
      drag.track.push([now, t.clientY]);
      while (drag.track.length > 2 && now - drag.track[0][0] > 100) drag.track.shift();
      // Nothing above the first post or below the last: stretch instead.
      const atTop = reels.cur === 0 && raw > 0;
      const atEnd = reels.cur === current.length - 1 && raw < 0;
      reels.off = atTop || atEnd ? rubberBand(raw, h()) : raw;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (reels) reels.track.style.transform = `translate3d(0, ${reels.off}px, 0)`;
      });
    }, { passive: false });
    const end = () => {
      const d = drag;
      drag = null;
      if (!d || !reels) return;
      if (!d.on) {
        // Caught and let go without dragging: settle on whichever post is nearer.
        if (d.caught) settleReels(Math.max(-1, Math.min(1, Math.round(-reels.off / h()))), 0);
        return;
      }
      const [t0, y0] = d.track[0] || [0, 0];
      const [t1, y1] = d.track[d.track.length - 1] || [0, 0];
      const v = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;
      const H = h();
      const projected = reels.off + v * 180;
      let step = projected < -H * 0.22 ? 1 : projected > H * 0.22 ? -1 : 0;
      if (reels.cur + step < 0 || reels.cur + step > current.length - 1) step = 0;
      settleReels(step, v);
    };
    root.addEventListener("touchend", end);
    root.addEventListener("touchcancel", end);
  }

  function settleReels(step, velocity) {
    const r = reels;
    const H = r.root.clientHeight;
    const goal = -step * H;
    const t = step ? 0.42 : 0.34;
    r.track.style.transition = `transform ${t}s ${springEase(velocity, Math.abs(goal - r.off), t)}`;
    r.off = goal;
    r.track.style.transform = `translate3d(0, ${goal}px, 0)`;
    // Start the next video as it arrives, not after it lands.
    if (step) {
      const next = r.slots.get(r.cur + step);
      const nv = next && next.querySelector("video");
      if (nv) {
        nv.muted = reelMuted;
        nv.play().catch(() => {});
      }
      const was = r.slots.get(r.cur);
      const wv = was && was.querySelector("video");
      if (wv) wv.pause();
    }
    r.anim = setTimeout(() => {
      r.anim = null;
      if (reels !== r) return;
      r.track.style.transition = "none";
      r.cur += step;
      r.off = 0;
      fillReels();
    }, t * 1000);
  }

  // Leaving the browser's full screen (sideways view) lets the phone turn
  // freely again; the video stays big and upright.
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement || !screen.orientation || !screen.orientation.unlock) return;
    try {
      screen.orientation.unlock();
    } catch (e) {
      /* fine */
    }
  });

  function paintSave(btn, key) {
    const saved = isSaved(key);
    btn.replaceChildren(icon(BOOKMARK_PATH, saved));
    btn.setAttribute("aria-label", saved ? "Saved to a collection" : "Save to a collection");
    btn.classList.toggle("xbg-on", saved);
  }

  function addFeedPosts(from, to, atTop) {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.append(feedPost(current[i]));
    if (atTop) ui.feed.prepend(frag);
    else ui.feed.append(frag);
  }

  // Add posts below as you near the bottom and above as you near the top
  // (keeping your place when adding above).
  function extendFeed() {
    const f = ui.feed;
    if (feedEnd < current.length && f.scrollTop + f.clientHeight > f.scrollHeight - 2500) {
      const to = Math.min(current.length, feedEnd + FEED_CHUNK);
      addFeedPosts(feedEnd, to, false);
      feedEnd = to;
      trimFeed(true);
    }
    if (feedStart > 0 && f.scrollTop < 2500) {
      const from = Math.max(0, feedStart - FEED_CHUNK);
      const before = f.scrollHeight;
      addFeedPosts(from, feedStart, true);
      f.scrollTop += f.scrollHeight - before;
      feedStart = from;
      trimFeed(false);
    }
  }

  // Only about FEED_MAX posts stay in the page; ones far behind you are
  // removed (and their videos let go), so long scrolls stay fast and light.
  // They come back automatically if you scroll back to them.
  const FEED_MAX = 40;
  function dropPost(post) {
    for (const v of post.querySelectorAll("video")) {
      v.pause();
      ui.feedVideos.unobserve(v);
      v.removeAttribute("src");
      v.load();
    }
    post.remove();
  }
  function trimFeed(fromTop) {
    const posts = ui.feed.querySelectorAll(":scope > .xbg-post");
    const extra = posts.length - FEED_MAX;
    if (extra <= 0) return;
    if (fromTop) {
      // Removing posts above you would shift the page: measure a post that
      // stays and put it back exactly where it was on screen.
      const anchor = posts[extra];
      const before = anchor.getBoundingClientRect().top;
      for (let i = 0; i < extra; i++) dropPost(posts[i]);
      feedStart += extra;
      ui.feed.style.paddingTop = ""; // the centring room is only for the very first post
      ui.feed.scrollTop += anchor.getBoundingClientRect().top - before;
    } else {
      for (let i = posts.length - extra; i < posts.length; i++) dropPost(posts[i]);
      feedEnd -= extra;
    }
  }

  function openLightbox(key) {
    saveSpot();
    const index = current.findIndex((it) => it.key === key);
    if (index < 0) return;
    const wasOpen = feedOpen();
    clearFeed();
    feedStart = Math.max(0, index - 3);
    feedEnd = Math.min(current.length, index + FEED_CHUNK);
    addFeedPosts(feedStart, feedEnd, false);
    ui.lightbox.style.transition = "none";
    ui.lightbox.style.transform = "";
    ui.lightbox.classList.remove("xbg-hidden");
    const target = ui.feed.querySelector(`.xbg-post[data-key="${CSS.escape(key)}"]`);
    centrePost(target);
    extendFeed();
    if (!wasOpen) addBackStep();
  }

  // Put the tapped post in the exact middle of the screen, whatever its shape.
  // The feed gets room above the first post and below the last, so even
  // those can sit in the middle.
  function centrePost(post) {
    const feed = ui.feed;
    feed.style.paddingBottom = "50vh";
    const first = feedStart === 0 && feed.querySelector(".xbg-post");
    feed.style.paddingTop = first ? Math.max(0, (window.innerHeight - first.offsetHeight) / 2) + "px" : "";
    if (!post) return (feed.scrollTop = 0);
    feed.scrollTop = 0;
    const r = post.getBoundingClientRect();
    const fits = r.height <= window.innerHeight;
    feed.scrollTop = fits ? r.top + r.height / 2 - window.innerHeight / 2 : r.top - feed.getBoundingClientRect().top;
  }

  function clearFeed() {
    if (reels) closeReels(true, true);
    ui.feed.querySelectorAll("video").forEach((v) => {
      v.pause();
      ui.feedVideos.unobserve(v);
    });
    ui.feed.replaceChildren();
  }

  // `fromHistory` is set when the phone's back gesture already took us back.
  // Back (gesture, button or swipe) slides the feed away quickly to the right.
  function closeLightbox(fromHistory = false, animate = true) {
    saveSpot();
    if (!ui || !feedOpen()) return;
    const lb = ui.lightbox;
    const finish = () => {
      lb.classList.remove("xbg-closing");
      clearFeed();
      lb.classList.add("xbg-hidden");
      lb.style.transition = "none";
      lb.style.transform = "";
    };
    if (animate) {
      lb.classList.add("xbg-closing");
      lb.style.transition = "transform 0.14s cubic-bezier(0.4, 0, 1, 1)";
      lb.style.transform = "translateX(100%)";
      setTimeout(finish, 140);
    } else finish();
    if (!fromHistory) removeBackStep();
  }

  // After the "Save to…" sheet closes: update the buttons, and if the post was
  // taken out of the collection being viewed, drop it from the feed too.
  function afterSave(key) {
    for (const btn of ui.feed.querySelectorAll(".xbg-post .xbg-save-btn")) paintSave(btn, btn.closest(".xbg-post").dataset.key);
    const c = view === "collection" ? getCollection(openId) : null;
    if (!c) return;
    rebuild(false);
    if (!c.keys.includes(key)) {
      const post = ui.feed.querySelector(`.xbg-post[data-key="${CSS.escape(key)}"]`);
      if (post) post.remove();
    }
    const keys = [...ui.feed.querySelectorAll(".xbg-post")].map((p) => p.dataset.key);
    if (!keys.length) return closeLightbox();
    feedStart = current.findIndex((it) => it.key === keys[0]);
    feedEnd = current.findIndex((it) => it.key === keys[keys.length - 1]) + 1;
  }

  // --- Fast-scroll bar (like the iPhone's Photos app) -------------------------
  // A slim handle on the right appears while you scroll and fades once you
  // stop. Drag it to race through the photos; a date label follows it and the
  // phone ticks at each new month.

  const SCRUB_MIN_ITEMS = 120;
  let scrubTimer = null;
  let scrubbing = false;

  function buildScrubber() {
    const thumb = el("div", { class: "xbg-scrub-thumb" });
    const label = el("div", { class: "xbg-scrub-label" });
    const track = el("div", { class: "xbg-scrubber" }, label, thumb);
    // Two small round buttons at the ends of the handle's path: ↑ jumps to the
    // very top (shown in the lower half), ↓ to the very bottom (upper half).
    const arrow = (d) => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.append(path);
      return svg;
    };
    const jumpUp = el("button", { class: "xbg-jump", "aria-label": "Go to the top", onclick: () => jumpToEnd(false) }, arrow("M12 19V5M6 11l6-6 6 6"));
    const jumpDown = el("button", { class: "xbg-jump", "aria-label": "Go to the bottom", onclick: () => jumpToEnd(true) }, arrow("M12 5v14M6 13l6 6 6-6"));
    ui.overlay.append(track, jumpUp, jumpDown);
    Object.assign(ui, { scrub: track, scrubThumb: thumb, scrubLabel: label, jumpUp, jumpDown });

    let lastLabel = "";
    const dragTo = (clientY) => {
      const { top, height } = scrubArea();
      const f = Math.min(Math.max((clientY - top) / height, 0), 1);
      placeThumb(f);
      placeJumps(f);
      if (!entries.length) return;
      // Jump to the photo at that point of the list (loading tiles up to it).
      const index = Math.round(f * (entries.length - 1));
      ui.jumped = true;
      ui.scroller.scrollTop = f >= 1 ? ui.scroller.scrollHeight : gridTop() + tops[index] - (settings.headerHidden ? 0 : ui.bar.offsetHeight);
      renderVisible();
      const text = labelFor(index);
      ui.scrubLabel.textContent = text;
      if (text !== lastLabel && lastLabel && navigator.vibrate) navigator.vibrate(4);
      lastLabel = text;
    };
    let frame = null;
    thumb.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      thumb.setPointerCapture(e.pointerId);
      scrubbing = true;
      lastLabel = "";
      track.classList.add("xbg-on", "xbg-dragging");
      clearTimeout(scrubTimer);
      dragTo(e.clientY);
    });
    thumb.addEventListener("pointermove", (e) => {
      if (!scrubbing) return;
      const y = e.clientY;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => dragTo(y));
    });
    const end = () => {
      if (!scrubbing) return;
      scrubbing = false;
      track.classList.remove("xbg-dragging");
      fillPage();
      hideScrubberSoon();
    };
    thumb.addEventListener("pointerup", end);
    thumb.addEventListener("pointercancel", end);
  }

  const JUMP_SIZE = 34;

  // The part of the screen the handle moves along: below the header, between the two jump buttons.
  function scrubEnds() {
    const top = (settings.headerHidden ? 0 : ui.bar.getBoundingClientRect().bottom) + 12;
    const bottom = window.innerHeight - (selectMode ? ui.selectBar.offsetHeight : 0) - 70;
    return { top, bottom };
  }

  function scrubArea() {
    const { top, bottom } = scrubEnds();
    const room = JUMP_SIZE + 26;
    return { top: top + room, height: Math.max(bottom - top - 2 * room, 1) };
  }

  function placeJumps(f) {
    const { top, bottom } = scrubEnds();
    ui.jumpUp.style.top = top + "px";
    ui.jumpDown.style.top = bottom - JUMP_SIZE + "px";
    ui.jumpUp.classList.toggle("xbg-on", f >= 0.5);
    ui.jumpDown.classList.toggle("xbg-on", f < 0.5);
  }

  function hideJumps() {
    ui.jumpUp.classList.remove("xbg-on");
    ui.jumpDown.classList.remove("xbg-on");
  }

  function jumpToEnd(bottom) {
    ui.jumped = true;
    if (!bottom) ui.bar.classList.remove("xbg-bar-hidden");
    ui.scroller.scrollTop = bottom ? ui.scroller.scrollHeight : 0;
    renderVisible();
    if (navigator.vibrate) navigator.vibrate(8);
    placeThumb(bottom ? 1 : 0);
    ui.scrubLabel.textContent = labelFor(bottom ? entries.length - 1 : 0);
    placeJumps(bottom ? 1 : 0);
    hideScrubberSoon();
  }

  function placeThumb(f) {
    const { top, height } = scrubArea();
    ui.scrub.style.top = top + f * height + "px";
  }

  function labelFor(index) {
    const e = entries[Math.max(0, Math.min(index, entries.length - 1))];
    if (!e) return "";
    if (e.header) return e.label;
    const d = dateOf(e.item);
    return d ? new Date(d).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "";
  }

  function showScrubber() {
    if (!ui || !ui.scrub || scrubbing) return;
    const usable = view !== "collections" && settings.layout !== "years" && entries.length >= SCRUB_MIN_ITEMS && !feedOpen();
    if (!usable) {
      hideJumps();
      return ui.scrub.classList.remove("xbg-on");
    }
    // Where we are in the whole list, from the first tile on screen.
    const y = (settings.headerHidden ? 0 : ui.bar.getBoundingClientRect().bottom) + 4;
    let index = indexAt(y - ui.grid.getBoundingClientRect().top);
    if (ui.scroller.scrollTop + ui.scroller.clientHeight >= ui.scroller.scrollHeight - 4) index = entries.length - 1;
    const f = index / Math.max(entries.length - 1, 1);
    placeThumb(f);
    placeJumps(f);
    ui.scrubLabel.textContent = labelFor(index);
    ui.scrub.classList.add("xbg-on");
    hideScrubberSoon();
  }

  function hideScrubberSoon() {
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => {
      if (scrubbing) return;
      ui.scrub.classList.remove("xbg-on");
      hideJumps();
    }, 1400);
  }

  // Photos fade in once they've loaded, so fast scrolling looks smooth instead of popping.
  document.addEventListener(
    "load",
    (e) => {
      const img = e.target;
      if (img instanceof HTMLImageElement && img.parentNode && img.parentNode.matches(".xbg-tile, .xbg-post-media")) img.classList.add("xbg-in");
    },
    true
  );

  // A picture X won't serve shows a dark tile with a cracked-Polaroid icon
  // (after trying the other thumbnail size once).
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.closest("#xbg-overlay") || img.classList.contains("xbg-gave-up")) return;
      if (thumbFallback(img)) return;
      img.classList.add("xbg-gave-up");
      img.replaceWith(el("div", { class: "xbg-broken" }));
    },
    true
  );

  // --- Show/hide-header button ------------------------------------------------
  // A floating button you can drag to either side; tap it to hide or show the
  // header (tabs, filters, sorting).

  function buildHeaderButton() {
    const btn = el("button", { class: "xbg-hbtn", "aria-label": "Show or hide the header" }, el("span", { class: "xbg-hbtn-ring" }));
    ui.overlay.append(btn);
    ui.hbtn = btn;
    const size = () => btn.offsetWidth || 54;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    let drag = null;
    let idle = null;
    const wake = () => {
      btn.classList.add("xbg-awake");
      clearTimeout(idle);
      idle = setTimeout(() => btn.classList.remove("xbg-awake"), 2500);
    };
    btn.addEventListener("pointerdown", (e) => {
      drag = { sx: e.clientX, sy: e.clientY, ox: btn.offsetLeft, oy: btn.offsetTop, moved: false };
      btn.setPointerCapture(e.pointerId);
      wake();
    });
    btn.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 8) return;
      drag.moved = true;
      btn.classList.add("xbg-dragging");
      btn.style.left = clamp(drag.ox + dx, 0, window.innerWidth - size()) + "px";
      btn.style.top = clamp(drag.oy + dy, 0, window.innerHeight - size()) + "px";
    });
    btn.addEventListener("pointerup", () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      btn.classList.remove("xbg-dragging");
      wake();
      if (!moved) return stepHeader();
      // Snap to the nearest side.
      settings.toggleBtn = { side: btn.offsetLeft + size() / 2 < window.innerWidth / 2 ? "left" : "right", y: btn.offsetTop / window.innerHeight };
      placeHeaderButton();
      saveSettings();
    });
    btn.addEventListener("pointercancel", () => {
      drag = null;
      btn.classList.remove("xbg-dragging");
      placeHeaderButton();
    });
    window.addEventListener("resize", placeHeaderButton);
    placeHeaderButton();
    wake();
  }

  function placeHeaderButton() {
    const btn = ui.hbtn;
    const s = btn.offsetWidth || 54;
    btn.style.top = Math.min(Math.max(settings.toggleBtn.y * window.innerHeight, 60), window.innerHeight - s - 60) + "px";
    btn.style.left = (settings.toggleBtn.side === "left" ? 8 : window.innerWidth - s - 8) + "px";
  }

  // Each tap: 1st hides the filters (bottom half of the header), 2nd hides
  // the rest, 3rd brings it all back.
  function stepHeader() {
    if (settings.headerHidden) {
      settings.filtersHidden = false;
      ui.controls.style.transition = "none"; // full height right away, so the grid lines up
      ui.overlay.classList.remove("xbg-filters-off");
      setHeaderHidden(false);
      void ui.controls.offsetHeight;
      ui.controls.style.transition = "";
    } else if (!settings.filtersHidden) {
      settings.filtersHidden = true;
      ui.overlay.classList.add("xbg-filters-off");
      ui.hbtn.classList.add("xbg-half");
      saveSettings();
    } else {
      setHeaderHidden(true);
    }
    ui.hbtn.classList.toggle("xbg-half", settings.filtersHidden && !settings.headerHidden);
  }

  // Fold the filters away at once (no animation), keeping the same photos on
  // screen. Used when you start swiping between the tabs.
  function foldFiltersNow() {
    if (settings.filtersHidden || settings.headerHidden) return;
    const { bar, scroller, controls } = ui;
    const before = bar.offsetHeight;
    controls.style.transition = "none";
    settings.filtersHidden = true;
    ui.overlay.classList.add("xbg-filters-off");
    ui.hbtn.classList.add("xbg-half");
    const after = bar.offsetHeight; // also applies the change before transitions come back
    controls.style.transition = "";
    saveSettings();
    scroller.style.paddingTop = after + "px";
    const d = before - after;
    if (d > 0 && scroller.scrollTop > 0) {
      ui.jumped = true;
      scroller.scrollTop = Math.max(0, scroller.scrollTop - d);
    }
  }

  function setHeaderHidden(hidden) {
    const { bar, scroller } = ui;
    const h = bar.offsetHeight;
    settings.headerHidden = hidden;
    saveSettings();
    ui.overlay.classList.toggle("xbg-header-off", hidden);
    bar.classList.remove("xbg-bar-hidden");
    // Keep the same photos on screen as the space at the top opens or closes.
    scroller.style.paddingTop = hidden ? "0px" : h + "px";
    const target = Math.max(0, scroller.scrollTop + (hidden ? -h : h));
    if (target !== scroller.scrollTop) {
      ui.jumped = true; // this scroll is ours: don't treat it as scrolling down
      scroller.scrollTop = target;
    }
    ui.hbtn.classList.toggle("xbg-on", hidden);
  }

  // --- Floating ball (shown everywhere on X) -------------------------------

  // A simple bookmark ribbon, drawn so it sits in the middle of the ball.
  function bookmarkIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M6.5 3h11A1.5 1.5 0 0 1 19 4.5V21l-7-4.6L5 21V4.5A1.5 1.5 0 0 1 6.5 3z");
    path.setAttribute("fill", "#fff");
    svg.append(path);
    return svg;
  }

  function buildBall() {
    if (ball || !document.body) return;
    ball = el("button", { id: "xbg-ball", class: "xbg-hidden", "aria-label": "Open bookmarks gallery" }, bookmarkIcon());
    document.body.append(ball);
    const size = () => ball.offsetWidth || 52;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    let drag = null;
    let idleTimer = null;

    const wake = () => {
      ball.classList.add("xbg-awake");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ball.classList.remove("xbg-awake"), 2500);
    };

    ball.addEventListener("pointerdown", (e) => {
      drag = { sx: e.clientX, sy: e.clientY, ox: ball.offsetLeft, oy: ball.offsetTop, moved: false };
      ball.setPointerCapture(e.pointerId);
      wake();
    });
    ball.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 8) return;
      drag.moved = true;
      ball.classList.add("xbg-dragging");
      ball.style.left = clamp(drag.ox + dx, 0, window.innerWidth - size()) + "px";
      ball.style.top = clamp(drag.oy + dy, 0, window.innerHeight - size()) + "px";
    });
    ball.addEventListener("pointerup", () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      ball.classList.remove("xbg-dragging");
      wake();
      if (!moved) return onBallTap();
      // Snap to the nearest side, like Android's floating accessibility button.
      settings.ball = {
        side: ball.offsetLeft + size() / 2 < window.innerWidth / 2 ? "left" : "right",
        y: ball.offsetTop / window.innerHeight,
      };
      placeBall();
      saveSettings();
    });
    ball.addEventListener("pointercancel", () => {
      drag = null;
      ball.classList.remove("xbg-dragging");
      placeBall();
    });
    window.addEventListener("resize", placeBall);
    placeBall();
    wake();
  }

  function placeBall() {
    if (!ball) return;
    const s = ball.offsetWidth || 52;
    const top = Math.min(Math.max(settings.ball.y * window.innerHeight, 70), window.innerHeight - s - 70);
    ball.style.top = top + "px";
    ball.style.left = (settings.ball.side === "left" ? 6 : window.innerWidth - s - 6) + "px";
  }

  function updateBall() {
    buildBall();
    if (!ball) return;
    ball.classList.toggle("xbg-hidden", !settings.fab || galleryOpen());
    placeBall();
  }

  // With a big saved copy, reading it takes a moment: wait for it before deciding.
  async function onBallTap() {
    if (!isBookmarks()) await storedReady;
    if (isBookmarks() || fresh.size || cached.size) openGallery();
    else goToBookmarks();
  }

  // --- Wiring --------------------------------------------------------------

  ext.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg && msg.type === "xbg-goto") {
      goToBookmarks();
      respond({ ok: true });
    }
    if (msg && msg.type === "xbg-open") {
      onBallTap();
      respond({ ok: true, onBookmarks: isBookmarks() });
    }
  });

  async function start() {
    // After an update (or reload) of the extension, Firefox stops the old
    // copy of this script but leaves its ball and gallery in the page, dead.
    // Clear them away; an open gallery comes back below through restoreSpot.
    document.querySelectorAll("#xbg-ball, #xbg-overlay").forEach((n) => n.remove());
    // The gallery itself is built the first time it opens (openGallery), so
    // ordinary X pages don't pay for it.
    updateBall();
    watchPage();
    storedReady = loadStored();
    await storedReady;
    sendPlan();
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      watchPage();
      updateHeader();
    }, 1000);
    // Reopen the gallery if we asked to (e.g. after "Refresh", or coming back
    // from a post in the Android app). Other pages leave the request for later.
    let autoOpen = false;
    if (isBookmarks()) {
      try {
        autoOpen = sessionStorage.getItem("xbg_open") === "1";
        sessionStorage.removeItem("xbg_open");
      } catch (e) {
        /* fine */
      }
      // The toolbar popup opens a new bookmarks tab with #xbg-open when there
      // was no X tab to ask; tidy it out of the address once seen.
      if (location.hash === "#xbg-open") {
        autoOpen = true;
        try {
          history.replaceState(history.state, "", location.pathname + location.search);
        } catch (e) {
          /* fine */
        }
      }
    }
    if (!restoreSpot() && autoOpen) openGallery();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
