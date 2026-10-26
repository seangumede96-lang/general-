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
  let settings = { fab: true, ball: { side: "right", y: 0.6 }, sort: "newest", dateMode: "saved", layout: "grid", theme: "dark", headerHidden: false, toggleBtn: { side: "right", y: 0.75 } };
  let cacheTime = 0;
  let lastTotal = 0; // how many bookmarks the last full load found, to show progress next time

  let view = "all"; // "all" | "collections" | "collection"
  let openId = null; // collection shown when view === "collection"
  let filter = "all";
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
  const isSaved = (key) => collections.some((c) => c.keys.includes(key));
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

  async function loadStored() {
    try {
      const data = await store.get(Object.values(K));
      const s = data[K.settings] || {};
      settings = { ...settings, ...s, ball: { ...settings.ball, ...(s.ball || {}) }, toggleBtn: { ...settings.toggleBtn, ...(s.toggleBtn || {}) } };
      collections = (data[K.collections] || []).map(cleanCollection).filter(Boolean);
      for (const raw of Object.values(data[K.items] || {})) {
        const item = clean(raw);
        if (item) savedItems.set(item.key, item);
      }
      const cache = data[K.cache];
      if (cache && Array.isArray(cache.items) && !(gotData && loadState.state === "done")) {
        cacheTime = Number(cache.at) || 0;
        lastTotal = Number(cache.posts) || 0;
        for (const raw of cache.items) {
          const item = clean(raw);
          if (item && !fresh.has(item.key)) cached.set(item.key, item);
        }
      }
    } catch (e) {
      /* start empty */
    }
    updateBall();
    applyTheme();
    if (ui && ui.hbtn) {
      placeHeaderButton();
      if (settings.headerHidden !== ui.overlay.classList.contains("xbg-header-off")) setHeaderHidden(settings.headerHidden);
    }
    syncControls();
    if (galleryOpen()) rebuild(false);
  }

  function saveSettings() {
    store.set({ [K.settings]: settings }).catch(() => {});
  }

  // Keep the finished list as the saved copy for next time.
  function saveCache() {
    if (!fresh.size || !isMainBookmarks()) return;
    cacheTime = Date.now();
    cached.clear();
    if (loadState.posts) lastTotal = loadState.posts;
    store.set({ [K.cache]: { at: cacheTime, posts: lastTotal, items: [...fresh.values()] } }).catch(() => {});
    scheduleRefresh();
  }

  function saveCollections() {
    const used = new Set(collections.flatMap((c) => c.keys));
    for (const key of used) {
      const item = getItem(key);
      if (item) savedItems.set(key, { ...item });
    }
    for (const key of [...savedItems.keys()]) if (!used.has(key)) savedItems.delete(key);
    store
      .set({ [K.collections]: collections, [K.items]: Object.fromEntries(savedItems) })
      .catch(() => toast("Couldn’t save your collections"));
  }

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[K.settings] || !changes[K.settings].newValue) return;
    settings.fab = changes[K.settings].newValue.fab !== false;
    updateBall();
  });

  function createCollection(name) {
    const c = { id: newId(), name: name.trim().slice(0, 60), keys: [] };
    collections.push(c);
    saveCollections();
    return c;
  }

  function setMembership(c, keys, add) {
    if (add) {
      for (const k of [...keys].reverse()) if (!c.keys.includes(k)) c.keys.unshift(k);
    } else {
      c.keys = c.keys.filter((k) => !keys.includes(k));
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

  function restore() {
    const input = el("input", { type: "file", accept: "application/json,.json" });
    input.addEventListener("change", async () => {
      try {
        const data = JSON.parse(await input.files[0].text());
        for (const raw of Object.values(data.items || {})) {
          const item = clean(raw);
          if (item && !savedItems.has(item.key)) savedItems.set(item.key, item);
        }
        let added = 0;
        for (const raw of data.collections || []) {
          const c = cleanCollection(raw);
          if (!c) continue;
          const existing = getCollection(c.id);
          if (existing) existing.keys = [...new Set([...existing.keys, ...c.keys])];
          else {
            collections.push(c);
            added++;
          }
        }
        saveCollections();
        rebuild();
        toast(`Restored ${plural(added, "collection")}`);
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
      }
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
        addItem({ key: keyOf(img.src), type: "photo", tweet, posted, thumb: sized(img.src, "small"), full: sized(img.src, "large") });
      }
      for (const img of article.querySelectorAll('img[src*="video_thumb"]')) {
        const type = img.src.includes("tweet_video_thumb") ? "gif" : "video";
        addItem({ key: keyOf(img.src), type, tweet, posted, thumb: sized(img.src, "small"), full: sized(img.src, "large") });
      }
      for (const v of article.querySelectorAll("video[poster]")) {
        const src = v.currentSrc || v.src || "";
        const video = /^https:\/\/video\.twimg\.com\/.+\.mp4/.test(src) ? src : null;
        const type = v.poster.includes("tweet_video_thumb") ? "gif" : "video";
        addItem({ key: keyOf(v.poster), type, tweet, posted, thumb: sized(v.poster, "small"), full: sized(v.poster, "large"), video });
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
        loadState = { state: "done" };
        saveCache();
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
    toastTimer = setTimeout(() => ui.toast.classList.add("xbg-hidden"), 2500);
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
    const close = el("button", { class: "xbg-close", "aria-label": "Close gallery", onclick: closeGallery }, "✕");
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
    const filters = el("div", { class: "xbg-chips" });
    for (const [value, label] of [["all", "All"], ["photo", "Photos"], ["video", "Videos"]]) {
      filters.append(el("button", { class: "xbg-chip", "data-filter": value, onclick: () => setFilter(value) }, label));
    }
    const sortBtn = el("button", { class: "xbg-chip xbg-sort", onclick: sortMenu });
    const layouts = el("div", { class: "xbg-seg" });
    for (const [value, label] of [["grid", "Grid"], ["months", "Months"], ["years", "Years"]]) {
      layouts.append(el("button", { "data-layout": value, onclick: () => setLayout(value) }, label));
    }
    const yearBar = el("div", { class: "xbg-period-row" });
    const monthBar = el("div", { class: "xbg-period-row" });
    const periodBar = el("div", { class: "xbg-periods xbg-hidden" }, yearBar, monthBar);
    const controls = el("div", { class: "xbg-controls" }, el("div", { class: "xbg-row" }, filters, sortBtn), layouts, periodBar);

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
      overlay, bar, back, close, titleName, count, statusText, refreshBtn, selectBtn, menuBtn, tabs, filters, sortBtn,
      layouts, controls, periodBar, yearBar, monthBar, grid, years, collGrid, empty, sentinel, scroller, selectBar, selectInfo, addBtn, removeBtn,
      lightbox, feed, toast: toastEl, sheet: null, progress, progressFill, progressPct,
    };

    wireGrid();
    wireScroller();
    wireLightbox();
    buildScrubber();
    buildHeaderButton();
    document.addEventListener("keydown", onKey);
    new ResizeObserver(() => (scroller.style.paddingTop = settings.headerHidden ? "0px" : bar.offsetHeight + "px")).observe(bar);
    applyTheme();
    if (settings.headerHidden) setHeaderHidden(true);
    syncControls();
    updateHeader();
  }

  function onKey(e) {
    if (!galleryOpen() || (e.key !== "Escape" && !e.key.startsWith("Arrow"))) return;
    if (ui.sheet) {
      if (e.key === "Escape") closeSheet();
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
      });
    }, { passive: true });

    let swipe = null;
    scroller.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      swipe = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
    }, { passive: true });
    scroller.addEventListener("touchend", (e) => {
      if (!swipe || selectMode || ui.sheet) return (swipe = null);
      const dx = e.changedTouches[0].clientX - swipe.x;
      const dy = e.changedTouches[0].clientY - swipe.y;
      const quick = Date.now() - swipe.at < 700;
      swipe = null;
      if (!quick || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
      if (dx < 0 && view === "all") setView("collections", null, "left");
      else if (dx > 0 && view === "collections") setView("all", null, "right");
      else if (dx > 0 && view === "collection") setView("collections", null, "right");
    });
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
      });
    }, { passive: true });
    ui.feedVideos = new IntersectionObserver(
      (list) => {
        for (const entry of list) {
          const v = entry.target;
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
      const onControls = e.target.tagName === "VIDEO" && t.clientY > e.target.getBoundingClientRect().bottom - 60;
      swipe = e.touches.length === 1 && !onControls && !ui.sheet ? { x: t.clientX, y: t.clientY, dx: 0, decided: false } : null;
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
      const far = swipe.dx > window.innerWidth * 0.3;
      swipe = null;
      lightbox.style.transition = "transform 0.2s ease-out";
      lightbox.style.transform = far ? "translateX(100%)" : "";
      if (far) setTimeout(() => closeLightbox(), 200);
    };
    lightbox.addEventListener("touchend", endSwipe);
    lightbox.addEventListener("touchcancel", endSwipe);

    window.addEventListener("popstate", onBack);
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

  function onBack() {
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
    if (ui.alert && ui.alert.isConnected) {
      // A confirmation was open: back just closes it.
      ui.alert.remove();
      if (feedOpen() || selectMode) addBackStep();
    } else if (ui.sheet) {
      // A menu was open: back just closes the menu. While selecting, keep the
      // selection (the menu's "done" step would otherwise end it).
      if (selectMode && !feedOpen()) {
        closeSheet(true);
        rebuild(false);
      } else {
        closeSheet();
      }
      if (feedOpen() || selectMode) addBackStep();
    } else if (feedOpen()) closeLightbox(true);
    else if (selectMode) setSelectMode(false, true);
  }

  function syncControls() {
    if (!ui) return;
    ui.filters.querySelectorAll(".xbg-chip").forEach((b) => b.classList.toggle("xbg-on", b.dataset.filter === filter));
    ui.layouts.querySelectorAll("button").forEach((b) => b.classList.toggle("xbg-on", b.dataset.layout === settings.layout));
    ui.sortBtn.textContent = settings.sort === "oldest" ? "⇅ Oldest" : "⇅ Newest";
  }

  function updateHeader() {
    if (!ui) return;
    const c = view === "collection" ? getCollection(openId) : null;
    ui.back.classList.toggle("xbg-hidden", !c);
    ui.close.classList.toggle("xbg-hidden", !!c);
    ui.tabs.classList.toggle("xbg-hidden", !!c);
    ui.controls.classList.toggle("xbg-hidden", view === "collections");
    ui.selectBtn.classList.toggle("xbg-hidden", view === "collections" || settings.layout === "years");
    ui.selectBtn.textContent = selectMode ? "Cancel" : "Select";
    ui.titleName.textContent = c ? c.name : "Bookmarks";
    ui.count.textContent = (c ? c.keys.length : view === "collections" ? collections.length : totalCount || allItems().length).toLocaleString();
    ui.tabs.querySelectorAll(".xbg-tab").forEach((t) => t.classList.toggle("xbg-on", t.dataset.view === view));

    let text = "";
    let canRefresh = false;
    if (view === "all") {
      const s = loadState;
      if (!isBookmarks()) {
        text = cached.size || fresh.size ? `Saved copy · ${ago(cacheTime)}` : "";
        canRefresh = true;
      } else if (scrollTimer) text = "Loading more…";
      else if (s.state === "loading") text = loadingText(s.posts);
      else if (s.state === "waiting") text = `X asked us to slow down, continuing in ${s.seconds}s…`;
      else if (s.state === "done") text = s.posts ? `All ${s.posts.toLocaleString()} bookmarks loaded` : "All loaded";
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

  function setView(value, id = null, slide = null) {
    const from = view;
    const here = { top: ui.scroller.scrollTop, barHidden: ui.bar.classList.contains("xbg-bar-hidden") };
    if (from === "collections" && value !== "collections") collectionsSpot = here;
    if (from === "collection") collectionSpots.set(openId, here);
    view = value;
    openId = id;
    if (selectMode) setSelectMode(false);
    rebuild();
    const spot = value === "collections" && from === "collection" ? collectionsSpot : value === "collection" ? collectionSpots.get(id) : null;
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
    return filter === "all" || (filter === "photo" ? item.type === "photo" : item.type !== "photo");
  }

  function dateOf(item) {
    return (settings.dateMode === "posted" ? item.posted || item.saved : item.saved || item.posted) || 0;
  }

  const monthKey = (d) => {
    if (!d) return "unknown";
    const t = new Date(d);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
  };
  const monthLabel = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Date unknown");
  const yearOf = (d) => (d ? String(new Date(d).getFullYear()) : "unknown");

  function computeEntries() {
    const c = view === "collection" ? getCollection(openId) : null;
    const base = c ? c.keys.map(getItem).filter(Boolean) : allItems();
    totalCount = c ? c.keys.length : base.length;
    const dir = settings.sort === "oldest" ? -1 : 1;
    // Dated posts first, by date; ties and undated posts keep their bookmark order.
    let list = base.filter(matches).map((item, i) => ({ item, i, d: dateOf(item) }));
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
  const COLS = 3;
  const GAP = 3;
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
    }, entries.length ? 700 : 60);
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
    else if (c) ui.empty.textContent = c.keys.length ? "Nothing here for this filter." : "No posts yet. Go to All posts, long-press a post, pick some more, then tap “Add to collection”.";
    else if (!isBookmarks() && !totalCount) {
      ui.empty.replaceChildren("Open your bookmarks to fill the gallery. ", el("button", { class: "xbg-link", onclick: () => goToBookmarks() }, "Go to bookmarks"));
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

  function renderCollections() {
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
    ui.collGrid.replaceChildren(...cards);
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
    buildUi();
    if (!ui) return;
    if (!gotData && isBookmarks()) scanPage();
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

  function closeGallery() {
    closeSheet();
    closeLightbox();
    stopScrollLoading();
    if (selectMode) setSelectMode(false);
    ui.overlay.classList.add("xbg-hidden");
    updateBall();
  }

  // Open the bookmarks page and pop the gallery open once it has loaded.
  function goToBookmarks() {
    try {
      sessionStorage.setItem("xbg_open", "1");
    } catch (e) {
      /* fine */
    }
    location.href = "https://x.com/i/bookmarks";
  }

  // --- Post feed --------------------------------------------------------------

  const FEED_CHUNK = 10;

  const feedOpen = () => ui && !ui.lightbox.classList.contains("xbg-hidden");

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
      media.append(el("img", { src: item.full || item.thumb, loading: "lazy", decoding: "async", alt: "", referrerpolicy: "no-referrer" }));
    } else if (isVideo) {
      const v = el("video", { src: item.video, poster: item.full || item.thumb, controls: true, muted: true, loop: true, playsinline: true, preload: "none" });
      v.muted = true;
      media.append(v);
      ui.feedVideos.observe(v);
    } else {
      media.append(
        el("img", { src: item.full || item.thumb, loading: "lazy", alt: "", referrerpolicy: "no-referrer" }),
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
    return el("article", { class: "xbg-post", "data-key": item.key }, media);
  }

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
    }
    if (feedStart > 0 && f.scrollTop < 2500) {
      const from = Math.max(0, feedStart - FEED_CHUNK);
      const before = f.scrollHeight;
      addFeedPosts(from, feedStart, true);
      f.scrollTop += f.scrollHeight - before;
      feedStart = from;
    }
  }

  function openLightbox(key) {
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
    ui.feed.querySelectorAll("video").forEach((v) => {
      v.pause();
      ui.feedVideos.unobserve(v);
    });
    ui.feed.replaceChildren();
  }

  // `fromHistory` is set when the phone's back gesture already took us back.
  function closeLightbox(fromHistory = false) {
    if (!ui || !feedOpen()) return;
    clearFeed();
    ui.lightbox.classList.add("xbg-hidden");
    ui.lightbox.style.transition = "none";
    ui.lightbox.style.transform = "";
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

  // A picture X won't serve shows a dark tile with a cracked-Polaroid icon.
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.closest("#xbg-overlay") || img.classList.contains("xbg-gave-up")) return;
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
      if (!moved) return setHeaderHidden(!settings.headerHidden);
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

  function onBallTap() {
    if (isBookmarks() || fresh.size || cached.size) openGallery();
    else goToBookmarks();
  }

  // --- Wiring --------------------------------------------------------------

  ext.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg && msg.type === "xbg-open") {
      onBallTap();
      respond({ ok: true, onBookmarks: isBookmarks() });
    }
  });

  async function start() {
    buildUi();
    updateBall();
    watchPage();
    await loadStored();
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
    }
    if (autoOpen) openGallery();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
