// Phone Gallery: the photos and videos on this phone in an Instagram-style
// grid, with albums you make yourself, the phone's own folders, month/year
// views, and a scrolling feed. Runs inside the Android app (see MainActivity),
// which supplies the media list, thumbnails, files and storage through
// `window.Android`. Adapted from the X Bookmarks Gallery (twitter-gallery/).
(() => {
  const Android = window.Android;
  // Settings and albums are kept by the app on the phone.
  const store = {
    get(keys) {
      const out = {};
      for (const key of keys) {
        try {
          const value = Android.get(key);
          if (value) out[key] = JSON.parse(value);
        } catch (e) {
          /* skip unreadable values */
        }
      }
      return Promise.resolve(out);
    },
    set(values) {
      try {
        for (const [key, value] of Object.entries(values)) Android.set(key, JSON.stringify(value));
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };

  const fresh = new Map(); // key -> photo/video on the phone, newest first
  const cached = new Map(); // unused here (kept so shared code reads the same)
  const savedItems = new Map(); // key -> item, for everything in an album
  let collections = []; // [{ id, name, keys: [newest first] }]
  let settings = { sort: "newest", dateMode: "saved", layout: "grid", hiddenFolders: [] };
  let starred = []; // keys of starred photos/videos, most recently starred first
  const trash = new Map(); // key -> item in the phone's recycle bin (with `expires`)

  let view = "all"; // "all" | "collections" (the Albums tab) | "collection" (an album) | "folder" | "starred" | "trash"
  let openId = null; // album id, or folder name when view === "folder"
  let filter = "all";
  let periodYear = null; // Months view: only this year ("2026"), or all years when null
  let periodMonth = null; // Months view: only this month ("2026-01"), or the whole year when null
  let periods = { years: [], months: [] }; // what the period bar offers
  let entries = []; // what the grid shows: { item } or { header, label, count }
  let current = []; // the items in `entries`, in order (for the full-screen viewer)
  let totalCount = 0;
  let shown = 0; // how many entries are in the page so far
  const headerEls = new Map();
  let feedStart = 0; // the feed shows current[feedStart .. feedEnd)
  let feedEnd = 0;
  let ui = null;
  let gotData = false; // inject.js has delivered media during this visit
  let loadState = { state: "idle" };
  let scrollTimer = null;
  let selectMode = false;
  const selected = new Set();

  const PAGE = 60; // tiles added at a time as you scroll
  const SAFE_MEDIA = /^\/(thumb|media)\/[iv]\d+$/; // served by the app
  const K = { collections: "pg_albums", items: "pg_items", settings: "pg_settings", starred: "pg_starred" };
  const galleryOpen = () => ui && !ui.overlay.classList.contains("xbg-hidden");
  // Only what's on the phone right now (deleted items drop out of albums and Starred).
  const getItem = (key) => fresh.get(key) || (view === "trash" ? trash.get(key) : undefined);
  const isStarred = (key) => starred.includes(key);
  const insideViews = ["collection", "folder", "starred", "trash"];
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
    if (!item || typeof item.key !== "string" || !["photo", "video"].includes(item.type)) return null;
    const out = { key: item.key, type: item.type };
    for (const f of ["thumb", "full", "video"]) {
      out[f] = typeof item[f] === "string" && SAFE_MEDIA.test(item[f]) ? item[f] : null;
    }
    for (const f of ["saved", "posted", "w", "h", "duration", "expires"]) out[f] = Number.isFinite(item[f]) && item[f] > 0 ? item[f] : null;
    out.folder = typeof item.folder === "string" ? item.folder.slice(0, 100) : "";
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

  // Everything on the phone, and what the All tab shows (minus hidden folders).
  const phoneItems = () => [...fresh.values()];
  function allItems() {
    const hidden = new Set(settings.hiddenFolders);
    return phoneItems().filter((it) => !hidden.has(it.folder || "Other"));
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
      settings = { ...settings, ...s };
      if (!Array.isArray(settings.hiddenFolders)) settings.hiddenFolders = [];
      starred = (data[K.starred] || []).filter((k) => typeof k === "string");
      collections = (data[K.collections] || []).map(cleanCollection).filter(Boolean);
      for (const raw of Object.values(data[K.items] || {})) {
        const item = clean(raw);
        if (item) savedItems.set(item.key, item);
      }
    } catch (e) {
      /* start empty */
    }
    syncControls();
  }

  function saveSettings() {
    store.set({ [K.settings]: settings }).catch(() => {});
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
      .catch(() => toast("Couldn’t save your albums"));
  }

  function saveStarred() {
    store.set({ [K.starred]: starred }).catch(() => toast("Couldn’t save your stars"));
  }

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
    const data = JSON.stringify({ app: "phone-gallery", version: 1, collections, items: Object.fromEntries(savedItems) });
    // The app saves the file to Downloads itself.
    if (Android && Android.saveFile) {
      toast(Android.saveFile("gallery-albums.json", data) ? "Backup saved to your Downloads" : "Couldn’t save the backup");
      return;
    }
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const a = el("a", { href: url, download: "gallery-albums.json" });
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
        toast(`Restored ${plural(added, "album")}`);
      } catch (e) {
        toast("That file isn’t an albums backup");
      }
    });
    input.click();
  }

  // --- Photos and videos on the phone --------------------------------------

  // Ask the app for everything (it reads the phone's media library).
  function loadMedia() {
    let list = [];
    try {
      list = Android.hasAccess() ? JSON.parse(Android.getMedia() || "[]") : [];
    } catch (e) {
      list = [];
    }
    fresh.clear();
    for (const raw of list) {
      const item = clean(raw);
      if (item) fresh.set(item.key, item);
    }
    let binList = [];
    try {
      binList = Android.hasAccess() ? JSON.parse(Android.getTrash() || "[]") : [];
    } catch (e) {
      binList = [];
    }
    trash.clear();
    for (const raw of binList) {
      const item = clean(raw);
      if (item) trash.set(item.key, item);
    }
    gotData = true;
    if (ui) {
      rebuild(false);
      syncFeed();
    }
  }

  // --- Star, share, delete, restore ----------------------------------------

  function toggleStar(keys) {
    const all = keys.every(isStarred);
    if (all) starred = starred.filter((k) => !keys.includes(k));
    else for (const k of [...keys].reverse()) if (!isStarred(k)) starred.unshift(k);
    saveStarred();
    toast(all ? `Removed ${plural(keys.length, "star")}` : `Starred ${plural(keys.length, "item")}`);
    if (selectMode) setSelectMode(false);
    rebuild(false);
    paintFeedButtons();
    syncFeed();
  }

  const shareKeys = (keys) => Android.share(keys.join(","));
  // These open Android's own confirmation; the result comes back in galleryActionDone.
  const deleteKeys = (keys) => Android.trash(keys.join(","));
  const restoreKeys = (keys) => Android.restore(keys.join(","));
  const deleteForever = (keys) => Android.deleteForever(keys.join(","));

  window.galleryActionDone = (kind, ok, count) => {
    if (!ok) return;
    const n = plural(count || 1, "item");
    toast(kind === "trash" ? `Moved ${n} to the recycle bin` : kind === "restore" ? `Restored ${n}` : `Deleted ${n} forever`);
    if (selectMode) setSelectMode(false);
    loadMedia();
  };



  const durationText = (ms) => {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };

  // The phone's own folders (Camera, Screenshots, WhatsApp…), newest first.
  function phoneFolders() {
    const byName = new Map();
    for (const item of fresh.values()) {
      const name = item.folder || "Other";
      let f = byName.get(name);
      if (!f) byName.set(name, (f = { name, items: [] }));
      f.items.push(item);
    }
    const newest = (f) => Math.max(...f.items.slice(0, 1).map(dateOf), 0);
    return [...byName.values()].sort((a, b) => newest(b) - newest(a));
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
    const input = el("input", { class: "xbg-input", type: "text", maxlength: "60", placeholder: "Album name", value: initial || "" });
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

  function confirmSheet(title, text, action, onConfirm) {
    openSheet(
      title,
      el(
        "div",
        { class: "xbg-sheet-body" },
        el("p", { class: "xbg-sheet-text" }, text),
        el("button", { class: "xbg-primary xbg-danger", onclick: () => { closeSheet(); onConfirm(); } }, action),
        el("button", { class: "xbg-secondary", onclick: () => closeSheet() }, "Cancel")
      )
    );
  }

  // "Save to collection" picker for one or more posts.
  function openPicker(keys, onDone) {
    const list = el("div", { class: "xbg-picker" });
    const draw = () => {
      list.replaceChildren();
      list.append(
        el(
          "button",
          { class: "xbg-pick", onclick: () => askName("New album", "", (name) => { setMembership(createCollection(name), keys, true); openPicker(keys, onDone); }) },
          el("div", { class: "xbg-pick-cover xbg-plus" }, "＋"),
          el("span", { class: "xbg-pick-name" }, "New album")
        )
      );
      for (const c of collections) {
        const inIt = keys.every((k) => c.keys.includes(k));
        list.append(
          el(
            "button",
            { class: "xbg-pick" + (inIt ? " xbg-on" : ""), onclick: () => { setMembership(c, keys, !inIt); draw(); } },
            cover(c, "xbg-pick-cover"),
            el("span", { class: "xbg-pick-name" }, c.name, el("small", {}, plural(c.keys.length, "item"))),
            el("span", { class: "xbg-pick-check" }, inIt ? "✓" : "")
          )
        );
      }
    };
    draw();
    const title = keys.length > 1 ? `Add ${keys.length} items to…` : "Add to album…";
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
        option("Taken", settings.dateMode === "saved", () => (settings.dateMode = "saved")),
        option("Added to the phone", settings.dateMode === "posted", () => (settings.dateMode = "posted"))
      )
    );
  }

  // --- Gallery UI ----------------------------------------------------------

  function buildUi() {
    if (ui || !document.body) return;
    const back = el("button", { class: "xbg-close", "aria-label": "Back", onclick: () => setView("collections") }, "‹");
    const close = el("button", { class: "xbg-close", "aria-label": "Close gallery", onclick: () => {} }, "✕");
    const titleName = el("span", {}, "Gallery");
    const count = el("span", { class: "xbg-count" }, "0");
    const statusText = el("span");
    const refreshBtn = el("button", { class: "xbg-link xbg-hidden", onclick: () => Android.requestAccess() }, "Allow access");
    const status = el("div", { class: "xbg-status" }, statusText, refreshBtn);
    const selectBtn = el("button", { class: "xbg-text-btn", onclick: () => setSelectMode(!selectMode) }, "Select");
    const menuBtn = el("button", { class: "xbg-close", "aria-label": "Options", onclick: () => (view === "collection" ? collectionMenu() : view === "trash" ? trashMenu() : galleryMenu()) }, "⋯");

    const tabs = el("div", { class: "xbg-tabs" });
    for (const [value, label] of [["all", "▦  All"], ["collections", "▢  Albums"]]) {
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
    const selectActions = el("div", { class: "xbg-select-actions" });
    const selectBar = el("div", { class: "xbg-select-bar xbg-hidden" }, selectInfo, selectActions);

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
    const toastEl = el("div", { class: "xbg-toast xbg-hidden" });
    const overlay = el("div", { id: "xbg-overlay", class: "xbg-hidden" }, scroller, bar, selectBar, lightbox, toastEl);
    document.body.append(overlay);

    ui = {
      overlay, bar, back, close, titleName, count, statusText, refreshBtn, selectBtn, menuBtn, tabs, filters, sortBtn,
      layouts, controls, periodBar, yearBar, monthBar, grid, years, collGrid, empty, sentinel, scroller, selectBar, selectInfo, selectActions,
      lightbox, feed, toast: toastEl, sheet: null,
    };

    wireGrid();
    wireScroller();
    wireLightbox();
    document.addEventListener("keydown", onKey);
    new ResizeObserver(() => (scroller.style.paddingTop = bar.offsetHeight + "px")).observe(bar);
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
      else if (insideViews.includes(view)) setView("collections");
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
        if (y < bar.offsetHeight) bar.classList.remove("xbg-bar-hidden");
        else if (dy > 6) bar.classList.add("xbg-bar-hidden");
        else if (dy < -6) bar.classList.remove("xbg-bar-hidden");
        if (Math.abs(dy) > 6 || y < bar.offsetHeight) lastY = y;
        fillPage();
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
      else if (dx > 0 && insideViews.includes(view)) setView("collections", null, "right");
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

  }


  function addBackStep() {}
  function removeBackStep() {}

  // The phone's back button/gesture (forwarded by the app): close the top
  // thing that's open. Returns false when there's nothing left, so the app
  // can close itself.
  window.galleryBack = () => {
    if (!ui) return false;
    if (ui.sheet) {
      if (selectMode && !feedOpen()) {
        closeSheet(true);
        rebuild(false);
      } else {
        closeSheet();
      }
    } else if (feedOpen()) closeLightbox(true);
    else if (selectMode) setSelectMode(false, true);
    else if (insideViews.includes(view)) setView("collections", null, "right");
    else if (view === "collections") setView("all", null, "right");
    else return false;
    return true;
  };

  function syncControls() {
    if (!ui) return;
    ui.filters.querySelectorAll(".xbg-chip").forEach((b) => b.classList.toggle("xbg-on", b.dataset.filter === filter));
    ui.layouts.querySelectorAll("button").forEach((b) => b.classList.toggle("xbg-on", b.dataset.layout === settings.layout));
    ui.sortBtn.textContent = settings.sort === "oldest" ? "⇅ Oldest" : "⇅ Newest";
  }

  function updateHeader() {
    if (!ui) return;
    const c = view === "collection" ? getCollection(openId) : null;
    const inside = insideViews.includes(view);
    ui.back.classList.toggle("xbg-hidden", !inside);
    ui.close.classList.add("xbg-hidden"); // the gallery is the whole app: nothing to close
    ui.menuBtn.classList.toggle("xbg-hidden", !(c || view === "all" || (view === "trash" && trash.size)));
    ui.tabs.classList.toggle("xbg-hidden", inside);
    ui.controls.classList.toggle("xbg-hidden", view === "collections");
    ui.selectBtn.classList.toggle("xbg-hidden", view === "collections" || settings.layout === "years");
    ui.selectBtn.textContent = selectMode ? "Cancel" : "Select";
    ui.titleName.textContent = c ? c.name
      : view === "folder" ? openId
      : view === "starred" ? "Starred"
      : view === "trash" ? "Recycle bin"
      : "Gallery";
    ui.count.textContent = String(c ? c.keys.length : view === "collections" ? collections.length + phoneFolders().length : totalCount || allItems().length);
    ui.tabs.querySelectorAll(".xbg-tab").forEach((t) => t.classList.toggle("xbg-on", t.dataset.view === view));
    const noAccess = !Android.hasAccess();
    const hiddenCount = settings.hiddenFolders.length;
    ui.statusText.textContent = noAccess ? "No access to photos"
      : view === "trash" ? "Deleted for good after 30 days"
      : view === "all" && hiddenCount ? `${plural(hiddenCount, "folder")} hidden`
      : "";
    ui.refreshBtn.classList.toggle("xbg-hidden", !noAccess);
  }

  function setView(value, id = null, slide = null) {
    view = value;
    openId = id;
    if (selectMode) setSelectMode(false);
    rebuild();
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
    ui.selectInfo.textContent = selected.size ? `${selected.size} selected` : "Tap to select";
    const keys = () => [...selected];
    const none = !selected.size;
    const btn = (label, path, onclick, opts = {}) =>
      el("button", { class: "xbg-bar-btn" + (opts.danger ? " xbg-danger-text" : ""), "aria-label": label, disabled: none, onclick: () => onclick(keys()) },
        icon(path, !!opts.filled), el("small", {}, label));
    const actions = [];
    if (view === "trash") {
      actions.push(btn("Restore", RESTORE_PATH, restoreKeys), btn("Delete", TRASH_PATH, deleteForever, { danger: true }));
    } else {
      const allStarred = !none && keys().every(isStarred);
      actions.push(
        btn(allStarred ? "Unstar" : "Star", STAR_PATH, toggleStar, { filled: allStarred }),
        btn("Album", BOOKMARK_PATH, (k) => openPicker(k, () => { setSelectMode(false); rebuild(false); })),
        btn("Share", SHARE_PATH, shareKeys)
      );
      if (view === "collection") actions.push(btn("Remove", MINUS_PATH, () => removeSelected()));
      actions.push(btn("Delete", TRASH_PATH, deleteKeys, { danger: true }));
    }
    ui.selectActions.replaceChildren(...actions);
  }

  function removeSelected() {
    const c = getCollection(openId);
    if (!c || !selected.size) return;
    const n = selected.size;
    setMembership(c, [...selected], false);
    setSelectMode(false);
    rebuild(false);
    toast(`Removed ${plural(n, "item")}`);
  }

  // ⋯ on the All tab: choose which folders appear in All.
  function galleryMenu() {
    const list = el("div", { class: "xbg-picker" });
    const draw = () => {
      const hidden = new Set(settings.hiddenFolders);
      list.replaceChildren(
        ...phoneFolders().map((f) => {
          const shown = !hidden.has(f.name);
          return el(
            "button",
            {
              class: "xbg-pick" + (shown ? " xbg-on" : ""),
              onclick: () => {
                settings.hiddenFolders = shown ? [...settings.hiddenFolders, f.name] : settings.hiddenFolders.filter((n) => n !== f.name);
                saveSettings();
                draw();
              },
            },
            mosaic(f.items, "xbg-pick-cover"),
            el("span", { class: "xbg-pick-name" }, f.name, el("small", {}, shown ? plural(f.items.length, "item") : "Hidden from All")),
            el("span", { class: "xbg-switch" + (shown ? " xbg-on" : "") })
          );
        })
      );
    };
    draw();
    const extra = [];
    if (Android.canSkipConfirm && !Android.canSkipConfirm()) {
      extra.push(el("button", { class: "xbg-secondary", onclick: () => Android.openManageMedia() }, "Delete without asking each time…"));
    }
    openSheet(
      "Show in All",
      el("div", { class: "xbg-sheet-body" }, el("p", { class: "xbg-sheet-text" }, "Turn a folder off to keep it out of All. It still opens from Albums."), list, ...extra,
        el("button", { class: "xbg-primary", onclick: () => closeSheet() }, "Done")),
      () => rebuild(false)
    );
  }

  function trashMenu() {
    confirmSheet("Empty the recycle bin?", `${plural(trash.size, "item")} will be deleted forever.`, "Delete all", () => deleteForever([...trash.keys()]));
  }

  function collectionMenu() {
    const c = getCollection(openId);
    if (!c) return;
    openSheet(
      c.name,
      el(
        "div",
        { class: "xbg-sheet-body" },
        el("button", { class: "xbg-secondary", onclick: () => askName("Rename album", c.name, (name) => { c.name = name; saveCollections(); updateHeader(); }) }, "Rename"),
        el(
          "button",
          { class: "xbg-secondary xbg-danger-text", onclick: () => confirmSheet("Delete album?", `“${c.name}” will be deleted. The photos stay on your phone.`, "Delete", () => {
            collections = collections.filter((x) => x !== c);
            saveCollections();
            setView("collections");
            toast("Album deleted");
          }) },
          "Delete album"
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
    const base = c ? c.keys.map(getItem).filter(Boolean)
      : view === "folder" ? phoneItems().filter((it) => (it.folder || "Other") === openId)
      : view === "starred" ? starred.map(getItem).filter(Boolean)
      : view === "trash" ? [...trash.values()]
      : allItems();
    totalCount = base.length;
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
    tile.append(el("img", { src: item.thumb, loading: "lazy", decoding: "async", alt: "" }));
    if (item.type !== "photo") tile.append(el("span", { class: "xbg-badge" }, item.duration ? "▶ " + durationText(item.duration) : "▶"));
    if (view === "trash" && item.expires) {
      const days = Math.max(0, Math.ceil((item.expires - Date.now()) / 86400000));
      tile.append(el("span", { class: "xbg-badge xbg-badge-left" }, plural(days, "day") + " left"));
    } else if (isStarred(item.key)) {
      tile.append(el("span", { class: "xbg-star-badge" }, "★"));
    }
    return tile;
  }

  function makeEntry(e) {
    if (!e.header) return makeTile(e.item);
    const countEl = el("span", { class: "xbg-section-count" }, plural(e.count, "item"));
    headerEls.set(e.header, countEl);
    return el("div", { class: "xbg-section", "data-key": e.header }, el("span", {}, e.label), countEl);
  }

  // Tiles are added a page at a time as you scroll, instead of all at once,
  // so opening the gallery stays quick even with thousands of bookmarks.
  function appendUpTo(n) {
    const end = Math.min(n, entries.length);
    if (shown >= end) return;
    const frag = document.createDocumentFragment();
    for (; shown < end; shown++) frag.append(makeEntry(entries[shown]));
    ui.grid.append(frag);
  }

  function renderPrefix(n) {
    ui.grid.replaceChildren();
    headerEls.clear();
    shown = 0;
    appendUpTo(n);
  }

  function fillPage() {
    if (!ui || !entries.length) return;
    for (let i = 0; i < 20 && shown < entries.length; i++) {
      if (ui.sentinel.getBoundingClientRect().top > window.innerHeight + 1500) break;
      appendUpTo(shown + PAGE);
    }
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
      renderPrefix(resetScroll ? PAGE : Math.max(shown, PAGE));
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
    let same = shown <= next.length;
    for (let i = 0; same && i < shown; i++) if (sig(next[i]) !== sig(entries[i])) same = false;
    entries = next;
    if (same) {
      for (const e of entries) if (e.header && headerEls.has(e.header)) headerEls.get(e.header).textContent = plural(e.count, "item");
      appendUpTo(Math.max(shown, PAGE));
    } else {
      renderPrefix(Math.max(shown, PAGE));
    }
    fillPage();
    updateHeader();
    updateEmpty();
  }

  function updateEmpty() {
    const c = view === "collection" ? getCollection(openId) : null;
    if (view === "collections") return;
    if (current.length) ui.empty.textContent = "";
    else if (view === "trash") ui.empty.textContent = "The recycle bin is empty.";
    else if (view === "starred") ui.empty.textContent = "Nothing starred yet. Tap ★ on a photo, or long-press photos and tap Star.";
    else if (c) ui.empty.textContent = c.keys.length ? "Nothing here for this filter." : "Nothing in this album yet. Go to All, long-press a photo, pick some more, then tap “Add to album”.";
    else if (!Android.hasAccess()) {
      ui.empty.replaceChildren("This app needs permission to show your photos and videos. ", el("button", { class: "xbg-link", onclick: () => Android.requestAccess() }, "Allow access"));
    } else if (!gotData) ui.empty.textContent = "Loading your photos…";
    else if (!totalCount) ui.empty.textContent = "No photos or videos found on this phone.";
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
          el("div", { class: "xbg-card-count" }, plural(g.items.length, "item"))
        )
      )
    );
  }

  // Tapping a year shows that year's posts, by month.
  function openYear(year) {
    choosePeriod(year, null);
  }

  // The Albums tab: albums you made, then the phone's own folders.
  function renderCollections() {
    const starredItems = starred.map(getItem).filter(Boolean);
    const cards = [
      el(
        "button",
        { class: "xbg-card", onclick: () => setView("starred", null, "left") },
        starredItems.length ? mosaic(starredItems, "xbg-card-cover") : el("div", { class: "xbg-card-cover xbg-plus" }, "★"),
        el("div", { class: "xbg-card-name" }, "★ Starred"),
        el("div", { class: "xbg-card-count" }, plural(starredItems.length, "item"))
      ),
      el(
        "button",
        { class: "xbg-card", onclick: () => setView("trash", null, "left") },
        trash.size ? mosaic([...trash.values()], "xbg-card-cover xbg-dim") : el("div", { class: "xbg-card-cover xbg-plus" }, "🗑"),
        el("div", { class: "xbg-card-name" }, "Recycle bin"),
        el("div", { class: "xbg-card-count" }, plural(trash.size, "item"))
      ),
      el("div", { class: "xbg-cards-title" }, "Your albums"),
      el(
        "button",
        { class: "xbg-card", onclick: () => askName("New album", "", (name) => { createCollection(name); rebuild(false); }) },
        el("div", { class: "xbg-card-cover xbg-plus" }, "＋"),
        el("div", { class: "xbg-card-name" }, "New album")
      ),
    ];
    for (const c of collections) {
      cards.push(
        el(
          "button",
          { class: "xbg-card", onclick: () => setView("collection", c.id, "left") },
          cover(c, "xbg-card-cover"),
          el("div", { class: "xbg-card-name" }, c.name),
          el("div", { class: "xbg-card-count" }, plural(c.keys.length, "item"))
        )
      );
    }
    const folders = phoneFolders();
    if (folders.length) {
      cards.push(el("div", { class: "xbg-cards-title" }, "On this phone"));
      const hidden = new Set(settings.hiddenFolders);
      for (const f of folders) {
        cards.push(
          el(
            "button",
            { class: "xbg-card", onclick: () => setView("folder", f.name, "left") },
            mosaic(f.items, "xbg-card-cover"),
            el("div", { class: "xbg-card-name" }, f.name),
            el("div", { class: "xbg-card-count" }, plural(f.items.length, "item") + (hidden.has(f.name) ? " · hidden from All" : ""))
          )
        );
      }
    }
    ui.collGrid.replaceChildren(...cards);
    ui.empty.replaceChildren(
      el(
        "span",
        { class: "xbg-backup" },
        el("button", { class: "xbg-link", onclick: backup }, "Back up albums"),
        " · ",
        el("button", { class: "xbg-link", onclick: restore }, "Restore from backup")
      )
    );
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
  const SHARE_PATH = "M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6";
  const STAR_PATH = "M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z";
  const TRASH_PATH = "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6";
  const RESTORE_PATH = "M4 12a8 8 0 1 0 3-6.2M4 4v5h5";
  const MINUS_PATH = "M5 12h14";

  // Each post is just its picture or video, edge to edge, with the name and
  // date laid over the top and Save / Open post as round buttons over the
  // corner, like Instagram.
  function feedPost(item) {
    const d = dateOf(item);
    const head = el(
      "div",
      { class: "xbg-post-head" },
      el("span", { class: "xbg-post-user" }, item.folder || "Photo"),
      el("span", { class: "xbg-post-date" }, d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "")
    );
    // Size the box from the media's real shape so the feed doesn't jump.
    const ratio = item.w && item.h ? Math.min(Math.max(item.w / item.h, 0.56), 2) : 1;
    const isVideo = item.type === "video";
    const media = el("div", { class: "xbg-post-media" + (isVideo ? " xbg-is-video" : ""), style: `aspect-ratio: ${ratio.toFixed(4)}` });
    if (isVideo) {
      const v = el("video", { src: item.video, poster: item.thumb, controls: true, muted: true, loop: true, playsinline: true, preload: "none" });
      v.muted = true;
      media.append(v);
      ui.feedVideos.observe(v);
    } else {
      media.append(el("img", { src: item.full || item.thumb, loading: "lazy", decoding: "async", alt: "" }));
    }
    const fab = (label, path, onclick, cls = "") => el("button", { class: "xbg-fab-btn " + cls, "aria-label": label, onclick }, icon(path, false));
    const actions = el("div", { class: "xbg-post-actions" });
    if (view === "trash") {
      actions.append(fab("Restore", RESTORE_PATH, () => restoreKeys([item.key])), fab("Delete forever", TRASH_PATH, () => deleteForever([item.key]), "xbg-danger-btn"));
    } else {
      const star = fab("Star", STAR_PATH, () => toggleStar([item.key]), "xbg-star-btn");
      const save = el("button", { class: "xbg-fab-btn xbg-save-btn", onclick: () => openPicker([item.key], () => afterSave(item.key)) });
      actions.append(star, save, fab("Share", SHARE_PATH, () => shareKeys([item.key])), fab("Delete", TRASH_PATH, () => deleteKeys([item.key])));
    }
    media.append(head, actions);
    const post = el("article", { class: "xbg-post", "data-key": item.key }, media);
    paintPostButtons(post);
    return post;
  }

  function paintPostButtons(post) {
    const key = post.dataset.key;
    const save = post.querySelector(".xbg-save-btn");
    if (save) paintSave(save, key);
    const star = post.querySelector(".xbg-star-btn");
    if (star) {
      const on = isStarred(key);
      star.replaceChildren(icon(STAR_PATH, on));
      star.setAttribute("aria-label", on ? "Unstar" : "Star");
      star.classList.toggle("xbg-on", on);
    }
  }

  const paintFeedButtons = () => ui.feed.querySelectorAll(".xbg-post").forEach(paintPostButtons);

  // After deleting/restoring/unstarring: drop posts that no longer belong in
  // this view from the feed (and close it if nothing is left).
  function syncFeed() {
    if (!feedOpen()) return;
    const keep = new Set(current.map((it) => it.key));
    for (const post of [...ui.feed.querySelectorAll(".xbg-post")]) if (!keep.has(post.dataset.key)) post.remove();
    const keys = [...ui.feed.querySelectorAll(".xbg-post")].map((p) => p.dataset.key);
    if (!keys.length) return closeLightbox();
    feedStart = current.findIndex((it) => it.key === keys[0]);
    feedEnd = current.findIndex((it) => it.key === keys[keys.length - 1]) + 1;
    extendFeed();
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
    ui.feed.scrollTop = target ? target.offsetTop : 0;
    extendFeed();
    if (!wasOpen) addBackStep();
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

  // --- Start ----------------------------------------------------------------

  // Called by the app after you grant access, and whenever it comes back to
  // the front (to pick up new photos).
  window.galleryReload = () => loadMedia();

  async function start() {
    buildUi();
    ui.overlay.classList.remove("xbg-hidden");
    await loadStored();
    rebuild();
    // Read the media after the first paint so the app opens instantly.
    setTimeout(loadMedia, 0);
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
