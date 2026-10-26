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
  let settings = {
    sort: "newest", dateMode: "saved", layout: "grid", hiddenFolders: [],
    theme: "dark", groupSmall: true, headerHidden: false, toggleBtn: { side: "right", y: 0.75 },
  };
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
  const headerEls = new Map();
  let feedStart = 0; // the feed shows current[feedStart .. feedEnd)
  let feedEnd = 0;
  let ui = null;
  let gotData = false; // inject.js has delivered media during this visit
  let loadState = { state: "idle" };
  let scrollTimer = null;
  let selectMode = false;
  const selected = new Set();

  const SAFE_MEDIA = /^\/(thumb|media)\/[iv]\d+$/; // served by the app
  const K = { collections: "pg_albums", items: "pg_items", settings: "pg_settings", starred: "pg_starred" };
  const galleryOpen = () => ui && !ui.overlay.classList.contains("xbg-hidden");
  // Only what's on the phone right now (deleted items drop out of albums and Starred).
  const getItem = (key) => fresh.get(key) || (view === "trash" ? trash.get(key) : undefined);
  const isStarred = (key) => starred.includes(key);
  const insideViews = ["collection", "folder", "starred", "trash", "videos", "gifs", "others"];
  // Folders with fewer items than this are combined into "Others" (like the
  // phone's own gallery does with one-off app and Instagram-account folders).
  const SMALL_FOLDER = 5;
  const MAIN_FOLDERS = ["Camera", "Screenshots", "Download", "Pictures"];
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
    if (!item.thumb) {
      // The app sends a compact list: links follow from the key.
      item.thumb = "/thumb/" + item.key;
      item.full = "/media/" + item.key;
      if (item.type === "video") item.video = item.full;
    }
    const out = { key: item.key, type: item.type };
    for (const f of ["thumb", "full", "video"]) {
      out[f] = typeof item[f] === "string" && SAFE_MEDIA.test(item[f]) ? item[f] : null;
    }
    for (const f of ["saved", "posted", "w", "h", "duration", "expires"]) out[f] = Number.isFinite(item[f]) && item[f] > 0 ? item[f] : null;
    out.folder = typeof item.folder === "string" ? item.folder.slice(0, 100) : "";
    out.name = typeof item.name === "string" ? item.name.slice(0, 200) : "";
    out.size = Number.isFinite(item.size) && item.size > 0 ? item.size : null;
    out.gif = item.gif === true;
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
      settings.toggleBtn = { side: "right", y: 0.75, ...(s.toggleBtn || {}) };
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
    const first = !gotData;
    gotData = true;
    if (ui) {
      // First load draws the page; later loads only touch what changed.
      if (first || view === "collections") rebuild(false);
      else refresh();
      syncFeed();
      syncViewer();
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
  const itemWord = (keys) => {
    if (keys.length > 1) return `${keys.length} items`;
    const it = getItem(keys[0]) || trash.get(keys[0]);
    return it && it.type === "video" ? "this video" : "this photo";
  };
  const deleteKeys = (keys) =>
    iosAlert(`Delete ${itemWord(keys)}?`, "It will go to the Recycle bin and be deleted for good after 30 days.", "Delete", () => Android.trash(keys.join(",")));
  const restoreKeys = (keys) => Android.restore(keys.join(","));
  const deleteForever = (keys) =>
    iosAlert(`Delete ${itemWord(keys)} forever?`, "This can’t be undone.", "Delete", () => Android.deleteForever(keys.join(",")));

  // An iPhone-style action sheet at the bottom: the message, then Delete, then Cancel.
  function iosAlert(title, message, action, onConfirm) {
    const close = () => backdrop.remove();
    const extra = Android.canSkipConfirm && !Android.canSkipConfirm()
      ? el("button", { class: "xbg-alert-link", onclick: () => { close(); Android.openManageMedia(); } }, "Stop Android asking again")
      : "";
    const box = el(
      "div",
      { class: "xbg-alert xbg-action-sheet", role: "alertdialog" },
      el("div", { class: "xbg-alert-text" }, el("div", { class: "xbg-alert-title" }, title), el("div", { class: "xbg-alert-message" }, message), extra),
      el("button", { class: "xbg-alert-action", onclick: () => { close(); onConfirm(); } }, action),
      el("button", { class: "xbg-alert-cancel", onclick: close }, "Cancel")
    );
    const backdrop = el("div", { class: "xbg-alert-backdrop xbg-sheet-style", onclick: (e) => e.target === backdrop && close() }, box);
    ui.overlay.append(backdrop);
    ui.alert = backdrop;
  }

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

  const isSmallFolder = (f) => settings.groupSmall && f.items.length < SMALL_FOLDER && !MAIN_FOLDERS.includes(f.name);
  const smallFolders = () => phoneFolders().filter(isSmallFolder);

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
    syncBars();
  }

  // `replacing` is set when another sheet takes this one's place, so the
  // first sheet's "done" action doesn't run early.
  function closeSheet(replacing = false) {
    if (!ui || !ui.sheet) return;
    const { __onClose } = ui.sheet;
    ui.sheet.remove();
    ui.sheet = null;
    syncBars();
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
    const menuBtn = el("button", { class: "xbg-close", "aria-label": "Options", onclick: () => (view === "collection" ? collectionMenu() : view === "trash" ? trashMenu() : settingsMenu()) }, "⋯");

    const tabs = el("div", { class: "xbg-tabs" });
    for (const [value, label] of [["all", "All"], ["collections", "Albums"]]) {
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
    const collGrid = el("div", { class: "xbg-albums xbg-hidden" });
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
    new ResizeObserver(() => (scroller.style.paddingTop = settings.headerHidden ? "0px" : bar.offsetHeight + "px")).observe(bar);
    syncControls();
    updateHeader();
  }

  function onKey(e) {
    if (!galleryOpen() || (e.key !== "Escape" && !e.key.startsWith("Arrow"))) return;
    if (ui.sheet) {
      if (e.key === "Escape") closeSheet();
    } else if (viewerOpen()) {
      if (e.key === "Escape") closeViewer();
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
    if (ui.alert && ui.alert.isConnected) {
      ui.alert.remove();
      return true;
    }
    if (ui.sheet) {
      if (selectMode && !feedOpen()) {
        closeSheet(true);
        rebuild(false);
      } else {
        closeSheet();
      }
    } else if (viewerOpen()) closeViewer();
    else if (feedOpen()) closeLightbox(true);
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
    ui.menuBtn.classList.toggle("xbg-hidden", !(c || view === "all" || view === "collections" || (view === "trash" && trash.size)));
    ui.tabs.classList.toggle("xbg-hidden", inside);
    ui.controls.classList.toggle("xbg-hidden", view === "collections");
    ui.selectBtn.classList.toggle("xbg-hidden", view === "collections" || settings.layout === "years");
    ui.selectBtn.textContent = selectMode ? "Cancel" : "Select";
    ui.titleName.textContent = c ? c.name
      : view === "folder" ? openId
      : view === "starred" ? "Starred"
      : view === "trash" ? "Recycle bin"
      : view === "videos" ? "Videos"
      : view === "gifs" ? "GIFs"
      : view === "others" ? "Others"
      : view === "collections" ? "Albums"
      : "Gallery";
    ui.count.textContent = view === "collections" ? "" : String(c ? c.keys.length : totalCount || allItems().length);
    ui.tabs.querySelectorAll(".xbg-tab").forEach((t) => t.classList.toggle("xbg-on", t.dataset.view === view));
    const noAccess = !Android.hasAccess();
    const hiddenCount = settings.hiddenFolders.length;
    ui.statusText.textContent = noAccess ? "No access to photos"
      : view === "trash" ? "Deleted for good after 30 days"
      : view === "all" && hiddenCount ? `${plural(hiddenCount, "folder")} hidden`
      : "";
    ui.refreshBtn.classList.toggle("xbg-hidden", !noAccess);
  }

  // Where the Albums page was when you opened an album, so Back returns exactly there.
  let albumsSpot = null;

  function setView(value, id = null, slide = null) {
    const from = view;
    if (from === "collections" && value !== "collections") {
      albumsSpot = { top: ui.scroller.scrollTop, barHidden: ui.bar.classList.contains("xbg-bar-hidden") };
    }
    view = value;
    openId = id;
    if (selectMode) setSelectMode(false);
    rebuild();
    if (value === "collections" && insideViews.includes(from) && albumsSpot) {
      ui.jumped = true; // our own scroll: leave the header as it was
      ui.scroller.scrollTop = albumsSpot.top;
      ui.bar.classList.toggle("xbg-bar-hidden", albumsSpot.barHidden && albumsSpot.top > 0);
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

  // ⋯ on the All and Albums tabs.
  function settingsMenu() {
    const toggle = (label, note, on, flip) =>
      el(
        "button",
        { class: "xbg-pick xbg-setting", onclick: () => { flip(); saveSettings(); settingsMenu(); } },
        el("span", { class: "xbg-pick-name" }, label, note ? el("small", {}, note) : ""),
        el("span", { class: "xbg-switch" + (on ? " xbg-on" : "") })
      );
    const hiddenCount = settings.hiddenFolders.length;
    const extra = [];
    if (Android.canSkipConfirm && !Android.canSkipConfirm()) {
      extra.push(el("button", { class: "xbg-secondary", onclick: () => Android.openManageMedia() }, "Delete without asking each time…"));
    }
    openSheet(
      "Settings",
      el(
        "div",
        { class: "xbg-sheet-body" },
        toggle("Dark mode", "", settings.theme !== "light", () => {
          settings.theme = settings.theme === "light" ? "dark" : "light";
          applyTheme();
        }),
        toggle("Combine small folders", `Folders with fewer than ${SMALL_FOLDER} items go into “Others”`, settings.groupSmall, () => {
          settings.groupSmall = !settings.groupSmall;
        }),
        el("button", { class: "xbg-secondary", onclick: () => foldersMenu() }, hiddenCount ? `Folders shown in All (${hiddenCount} hidden)…` : "Folders shown in All…"),
        ...extra,
        el("button", { class: "xbg-primary", onclick: () => closeSheet() }, "Done")
      ),
      () => rebuild(false)
    );
  }

  function applyTheme() {
    const light = settings.theme === "light";
    if (ui) ui.overlay.classList.toggle("xbg-light", light);
    document.documentElement.classList.toggle("xbg-light-page", light);
    syncBars();
  }

  // Phone status and navigation bars: the theme's colour, but black while a photo is open.
  // An open menu sheet colours the bottom bar too, so the sheet runs to the screen's edge.
  function syncBars() {
    const page = settings.theme === "light" ? "#f2f3f5" : "#000000";
    const top = ui && viewerOpen() ? "#000000" : page;
    const sheet = ui && ui.sheet && ui.sheet.querySelector(".xbg-sheet");
    const bottom = sheet ? hexColor(getComputedStyle(sheet).backgroundColor) || top : top;
    if (Android.setBars) Android.setBars(top, bottom);
    else if (Android.setLightBars) Android.setLightBars(top !== "#000000");
  }

  function hexColor(rgb) {
    const m = rgb.match(/\d+/g);
    return m && m.length >= 3 ? "#" + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, "0")).join("") : "";
  }

  // Choose which folders appear in All.
  function foldersMenu() {
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
    iosAlert("Empty the Recycle bin?", `${plural(trash.size, "item")} will be deleted forever. This can’t be undone.`, "Delete all", () => Android.deleteForever([...trash.keys()].join(",")));
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
          { class: "xbg-secondary xbg-danger-text", onclick: () => { closeSheet(true); iosAlert(`Delete “${c.name}”?`, "The album will be deleted. The photos stay on your phone.", "Delete", () => {
            collections = collections.filter((x) => x !== c);
            saveCollections();
            setView("collections");
            toast("Album deleted");
          }); } },
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
      : view === "videos" ? phoneItems().filter((it) => it.type === "video")
      : view === "gifs" ? phoneItems().filter((it) => it.gif)
      : view === "others" ? smallFolders().flatMap((f) => f.items)
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
    if (item.type === "video") tile.append(el("span", { class: "xbg-badge xbg-badge-time" }, item.duration ? durationText(item.duration) : "▶"));
    else if (item.gif) tile.append(el("span", { class: "xbg-badge xbg-badge-time" }, "GIF"));
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
      else frag.append((node = makeEntry(e)));
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
    for (const node of rendered.values()) node.remove();
    rendered = next;
    if (frag.childNodes.length) ui.grid.append(frag);
  }

  // Start the grid afresh (new view, filter or sort).
  function renderPrefix() {
    ui.grid.replaceChildren();
    rendered.clear();
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
    for (const e of entries) if (e.header && headerEls.has(e.header)) headerEls.get(e.header).textContent = plural(e.count, "item");
    appendUpTo();
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

  // The Albums tab, laid out like the phone's own gallery: the main albums,
  // your albums, the phone's other folders (small ones combined into
  // "Others"), then a list of media types and the recycle bin.
  function albumCard(name, sub, cover, onclick, cls = "") {
    return el("button", { class: "xbg-album " + cls, onclick }, cover, el("div", { class: "xbg-card-name" }, name), el("div", { class: "xbg-card-count" }, sub));
  }

  function coverOf(item, extraCls = "") {
    const box = el("div", { class: "xbg-album-cover " + extraCls });
    if (item) box.append(el("img", { src: item.thumb, loading: "lazy", decoding: "async", alt: "" }));
    return box;
  }

  // The "All" album's cover: the newest photo as a Polaroid.
  function polaroidCover(item) {
    const box = el("div", { class: "xbg-album-cover xbg-polaroid-bg" });
    const card = el("div", { class: "xbg-polaroid" });
    if (item) card.append(el("img", { src: item.thumb, alt: "" }));
    box.append(card);
    return box;
  }

  function renderCollections() {
    const items = phoneItems();
    const folders = phoneFolders();
    const byName = new Map(folders.map((f) => [f.name, f]));
    const starredItems = starred.map(getItem).filter(Boolean);
    const videos = items.filter((it) => it.type === "video");
    const gifs = items.filter((it) => it.gif);
    const count = (n) => n.toLocaleString();
    const main = [
      albumCard("All", count(items.length), polaroidCover(allItems()[0]), () => setView("all", null, "right")),
    ];
    if (byName.has("Camera")) main.push(albumCard("Camera", count(byName.get("Camera").items.length), coverOf(byName.get("Camera").items[0]), () => setView("folder", "Camera", "left")));
    main.push(albumCard("Starred", count(starredItems.length), coverOf(starredItems[0], "xbg-starred-cover"), () => setView("starred", null, "left")));
    main.push(albumCard("Videos", count(videos.length), coverOf(videos[0]), () => setView("videos", null, "left")));
    if (byName.has("Screenshots")) main.push(albumCard("Screenshots", count(byName.get("Screenshots").items.length), coverOf(byName.get("Screenshots").items[0]), () => setView("folder", "Screenshots", "left")));

    const yours = [albumCard("New album", "", el("div", { class: "xbg-album-cover xbg-plus" }, "＋"), () => askName("New album", "", (name) => { createCollection(name); rebuild(false); }))];
    for (const c of collections) {
      yours.push(albumCard(c.name, count(c.keys.length), coverOf(c.keys.map(getItem).find(Boolean)), () => setView("collection", c.id, "left")));
    }

    const hidden = new Set(settings.hiddenFolders);
    const small = folders.filter(isSmallFolder);
    const more = folders
      .filter((f) => !["Camera", "Screenshots"].includes(f.name) && !isSmallFolder(f))
      .map((f) => albumCard(f.name, count(f.items.length) + (hidden.has(f.name) ? " · hidden" : ""), coverOf(f.items[0]), () => setView("folder", f.name, "left")));
    if (small.length) {
      const otherItems = small.flatMap((f) => f.items).sort((a, b) => dateOf(b) - dateOf(a));
      more.push(albumCard("Others", count(otherItems.length), coverOf(otherItems[0]), () => setView("others", null, "left")));
    }

    const row = (iconPath, label, n, onclick) =>
      el("button", { class: "xbg-type-row", onclick }, icon(iconPath, false), el("span", { class: "xbg-type-name" }, label), el("span", { class: "xbg-type-count" }, count(n)), el("span", { class: "xbg-type-arrow" }, "›"));

    ui.collGrid.replaceChildren(
      el("div", { class: "xbg-album-grid" }, ...main),
      el("div", { class: "xbg-cards-title" }, "Your albums"),
      el("div", { class: "xbg-album-grid" }, ...yours),
      ...(more.length ? [el("div", { class: "xbg-cards-title" }, "More albums"), el("div", { class: "xbg-album-grid" }, ...more)] : []),
      el("div", { class: "xbg-cards-title" }, "Media types"),
      el("div", { class: "xbg-type-list" }, row(VIDEO_PATH, "Videos", videos.length, () => setView("videos", null, "left")), row(GIF_PATH, "GIFs", gifs.length, () => setView("gifs", null, "left"))),
      el("div", { class: "xbg-type-list" }, row(STAR_PATH, "Starred", starredItems.length, () => setView("starred", null, "left")), row(TRASH_PATH, "Recycle bin", trash.size, () => setView("trash", null, "left")))
    );
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
  const SHARE_PATH = "M12 3v11M8 7l4-4 4 4M8.5 10H6.5a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 17.5 10h-2";
  const STAR_PATH = "M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z";
  const TRASH_PATH = "M4 6.5h16M9.5 6.5V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6 6.5l.9 13a1.5 1.5 0 0 0 1.5 1.4h7.2a1.5 1.5 0 0 0 1.5-1.4l.9-13M10 10.5v7M14 10.5v7";
  const RESTORE_PATH = "M4 12a8 8 0 1 0 3-6.2M4 4v5h5";
  const MINUS_PATH = "M5 12h14";
  const VIDEO_PATH = "M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 10l5-3v10l-5-3";
  const GIF_PATH = "M4 6h16v12H4zM9 10H7v4h2v-1.5M12 10v4M15 14v-4h2M15 12h1.5";
  const MORE_PATH = "M12 5.5v.01M12 12v.01M12 18.5v.01";
  const MORE_H_PATH = "M5.5 12h.01M12 12h.01M18.5 12h.01";
  const CHEVRON_PATH = "M15 5l-7 7 7 7";
  const INFO_PATH = "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.01";
  const BACK_PATH = "M19 12H5M11 6l-6 6 6 6";

  // The feed is just the pictures and videos, edge to edge, with nothing laid
  // over them. Tap one to open it full screen.
  function feedPost(item) {
    // Size the box from the media's real shape so the feed doesn't jump.
    const ratio = item.w && item.h ? Math.min(Math.max(item.w / item.h, 0.56), 2) : 1;
    const isVideo = item.type === "video";
    const media = el("div", { class: "xbg-post-media" + (isVideo ? " xbg-is-video" : ""), style: `aspect-ratio: ${ratio.toFixed(4)}` });
    if (isVideo) {
      const v = el("video", { src: item.video, poster: item.thumb, muted: true, loop: true, playsinline: true, preload: "none" });
      v.muted = true;
      media.append(v, el("span", { class: "xbg-badge xbg-badge-time" }, item.duration ? durationText(item.duration) : "▶"));
      ui.feedVideos.observe(v);
    } else {
      media.append(el("img", { src: item.full || item.thumb, loading: "lazy", decoding: "async", alt: "" }));
    }
    media.addEventListener("click", () => openViewer(item.key));
    return el("article", { class: "xbg-post", "data-key": item.key }, media);
  }

  const paintFeedButtons = () => paintViewer();

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

  // After the "Add to album…" sheet closes: if the photo was taken out of the
  // album being viewed, it leaves this view.
  function afterSave() {
    if (view === "collection") {
      rebuild(false);
      syncFeed();
      syncViewer();
    }
    paintViewer();
  }

  // --- Full-screen view of one photo or video ------------------------------
  // Opens from the feed and shows just that one photo or video. The bars stay
  // hidden until you tap; tap again to hide them.

  let viewerKey = null;
  const viewerOpen = () => ui && ui.viewer && !ui.viewer.classList.contains("xbg-hidden");

  function buildViewer() {
    if (ui.viewer) return;
    const stage = el("div", { class: "xbg-v-stage" });
    const title = el("div", { class: "xbg-v-title" });
    const sub = el("div", { class: "xbg-v-sub" });
    // Like the iPhone's Photos app: round back and ⋯ buttons, the date in a pill.
    const top = el(
      "div",
      { class: "xbg-v-top" },
      el("button", { class: "xbg-glass xbg-round", "aria-label": "Back", onclick: () => closeViewer() }, icon(CHEVRON_PATH, false)),
      el("div", { class: "xbg-glass xbg-pill xbg-v-titles" }, title, sub),
      el("button", { class: "xbg-glass xbg-round", "aria-label": "More", onclick: () => viewerKey && viewerMenu(viewerKey) }, icon(MORE_H_PATH, false))
    );
    const bottom = el("div", { class: "xbg-v-bottom" });
    const viewer = el("div", { class: "xbg-viewer xbg-hidden" }, stage, top, bottom);
    ui.overlay.append(viewer);
    Object.assign(ui, { viewer, vStage: stage, vTitle: title, vSub: sub, vBottom: bottom });

    // A tap shows or hides the bars.
    stage.addEventListener("click", () => viewer.classList.toggle("xbg-ui-on"));

    // Swipe up or down to go back to the gallery; the photo follows your finger.
    let swipe = null;
    stage.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      const onControls = e.target.tagName === "VIDEO" && t.clientY > e.target.getBoundingClientRect().bottom - 70;
      swipe = e.touches.length === 1 && !onControls ? { x: t.clientX, y: t.clientY, dy: 0, on: false } : null;
    }, { passive: true });
    stage.addEventListener("touchmove", (e) => {
      if (!swipe || e.touches.length !== 1) return (swipe = null);
      const dx = e.touches[0].clientX - swipe.x;
      const dy = e.touches[0].clientY - swipe.y;
      if (!swipe.on) {
        if (Math.abs(dy) < 12) return;
        if (Math.abs(dx) > Math.abs(dy)) return (swipe = null);
        swipe.on = true;
        viewer.classList.add("xbg-v-dragging");
      }
      swipe.dy = dy;
      const p = Math.min(Math.abs(dy) / 450, 1);
      stage.style.transform = `translateY(${dy}px) scale(${1 - p * 0.3})`;
      viewer.style.backgroundColor = `rgba(0, 0, 0, ${1 - p * 0.85})`;
    }, { passive: true });
    const endSwipe = () => {
      const s = swipe;
      swipe = null;
      if (!s || !s.on) return;
      viewer.classList.remove("xbg-v-dragging");
      stage.style.transition = viewer.style.transition = "transform 0.22s ease-out, opacity 0.22s ease-out, background-color 0.22s ease-out";
      if (Math.abs(s.dy) > 90) {
        stage.style.transform = `translateY(${Math.sign(s.dy) * window.innerHeight * 0.5}px) scale(0.6)`;
        stage.style.opacity = "0";
        viewer.style.backgroundColor = "rgba(0, 0, 0, 0)";
        setTimeout(closeViewer, 200);
      } else {
        stage.style.transform = "";
        viewer.style.backgroundColor = "";
        setTimeout(resetViewerMotion, 230);
      }
    };
    stage.addEventListener("touchend", endSwipe);
    stage.addEventListener("touchcancel", endSwipe);
  }

  function resetViewerMotion() {
    if (!ui.viewer) return;
    ui.viewer.classList.remove("xbg-v-dragging");
    for (const st of [ui.vStage.style, ui.viewer.style]) st.transition = st.transform = st.opacity = st.backgroundColor = "";
  }

  function friendlyDate(d) {
    if (!d) return "";
    const day = new Date(d);
    const today = new Date();
    const days = Math.round((new Date(today.toDateString()) - new Date(day.toDateString())) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return day.toLocaleDateString(undefined, { day: "numeric", month: "long", year: day.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  }

  function showViewerItem(key) {
    const item = current.find((it) => it.key === key);
    if (!item) return closeViewer();
    viewerKey = key;
    viewerIndexHint = current.indexOf(item);
    const { vStage: stage } = ui;
    stage.querySelectorAll("video").forEach((v) => v.pause());
    stage.replaceChildren(
      item.type === "video"
        ? el("video", { src: item.video, poster: item.thumb, controls: true, autoplay: true, playsinline: true, loop: true })
        : el("img", { src: item.full || item.thumb, alt: "" })
    );
    const d = dateOf(item);
    ui.vTitle.textContent = friendlyDate(d);
    ui.vSub.textContent = [d ? new Date(d).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "", item.folder].filter(Boolean).join(" · ");
    paintViewer();
  }

  function paintViewer() {
    if (!viewerOpen() || !viewerKey) return;
    const key = viewerKey;
    const btn = (label, path, onclick, filled = false, cls = "") =>
      el("button", { class: "xbg-v-btn " + cls, "aria-label": label, onclick }, icon(path, filled));
    if (view === "trash") {
      ui.vBottom.replaceChildren(
        el("div", { class: "xbg-glass xbg-round" }, btn("Restore", RESTORE_PATH, () => restoreKeys([key]))),
        el("div", { class: "xbg-glass xbg-round" }, btn("Delete forever", TRASH_PATH, () => deleteForever([key]), false, "xbg-danger-text"))
      );
      return;
    }
    const starredNow = isStarred(key);
    // Share on the left, Star · Info · Album in the middle, Delete on the right.
    ui.vBottom.replaceChildren(
      el("div", { class: "xbg-glass xbg-round" }, btn("Share", SHARE_PATH, () => shareKeys([key]))),
      el(
        "div",
        { class: "xbg-glass xbg-pill xbg-v-group" },
        btn(starredNow ? "Unstar" : "Star", STAR_PATH, () => toggleStar([key]), starredNow, starredNow ? "xbg-on" : ""),
        btn("Info", INFO_PATH, () => viewerMore(key)),
        btn("Add to album", BOOKMARK_PATH, () => openPicker([key], afterSave))
      ),
      el("div", { class: "xbg-glass xbg-round" }, btn("Delete", TRASH_PATH, () => deleteKeys([key])))
    );
  }

  // ⋯ at the top of the full-screen view.
  function viewerMenu(key) {
    openSheet(
      "",
      el(
        "div",
        { class: "xbg-sheet-body" },
        el("button", { class: "xbg-secondary", onclick: () => { closeSheet(); Android.openWith(key); } }, "Open with another app"),
        el("button", { class: "xbg-secondary", onclick: () => { closeSheet(); openPicker([key], afterSave); } }, "Add to album"),
        el("button", { class: "xbg-secondary", onclick: () => viewerMore(key) }, "Details"),
        el("button", { class: "xbg-primary", onclick: () => closeSheet() }, "Close")
      )
    );
  }

  function viewerMore(key) {
    const item = current.find((it) => it.key === key);
    if (!item) return;
    const d = dateOf(item);
    const size = item.size ? (item.size > 1048576 ? (item.size / 1048576).toFixed(1) + " MB" : Math.round(item.size / 1024) + " KB") : "";
    const line = (label, value) => (value ? el("div", { class: "xbg-detail" }, el("span", {}, label), el("b", {}, value)) : "");
    openSheet(
      "Details",
      el(
        "div",
        { class: "xbg-sheet-body" },
        line("Name", item.name),
        line("Taken", d ? new Date(d).toLocaleString() : ""),
        line("Folder", item.folder),
        line("Size", [item.w && item.h ? `${item.w} × ${item.h}` : "", size].filter(Boolean).join(" · ")),
        item.type === "video" && item.duration ? line("Length", durationText(item.duration)) : "",
        el("button", { class: "xbg-secondary", onclick: () => { closeSheet(); Android.openWith(key); } }, "Open with another app"),
        el("button", { class: "xbg-primary", onclick: () => closeSheet() }, "Done")
      )
    );
  }

  function openViewer(key) {
    buildViewer();
    ui.feed.querySelectorAll("video").forEach((v) => v.pause());
    ui.viewer.classList.remove("xbg-hidden", "xbg-ui-on"); // bars start hidden
    syncBars();
    showViewerItem(key);
  }

  function closeViewer() {
    if (!viewerOpen()) return;
    ui.vStage.querySelectorAll("video").forEach((v) => v.pause());
    ui.vStage.replaceChildren();
    ui.viewer.classList.add("xbg-hidden");
    resetViewerMotion();
    syncBars();
    // Leave the feed where you were in the full-screen view.
    const post = feedOpen() && viewerKey && ui.feed.querySelector(`.xbg-post[data-key="${CSS.escape(viewerKey)}"]`);
    if (post) ui.feed.scrollTop = post.offsetTop;
    viewerKey = null;
  }

  // After deleting/restoring: if the open item is gone, show the next one.
  let viewerIndexHint = 0;
  function syncViewer() {
    if (!viewerOpen()) return;
    const i = current.findIndex((it) => it.key === viewerKey);
    if (i >= 0) {
      viewerIndexHint = i;
      return paintViewer();
    }
    const next = current[Math.min(viewerIndexHint, current.length - 1)];
    if (next) showViewerItem(next.key);
    else closeViewer();
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
    ui.overlay.append(track);
    Object.assign(ui, { scrub: track, scrubThumb: thumb, scrubLabel: label });

    let lastLabel = "";
    const dragTo = (clientY) => {
      const { top, height } = scrubArea();
      const f = Math.min(Math.max((clientY - top) / height, 0), 1);
      placeThumb(f);
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

  // The part of the screen the handle moves along (below the header).
  function scrubArea() {
    const top = (settings.headerHidden ? 0 : ui.bar.getBoundingClientRect().bottom) + 12;
    const bottom = window.innerHeight - (selectMode ? ui.selectBar.offsetHeight : 0) - 70;
    return { top, height: Math.max(bottom - top, 1) };
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
    if (!usable) return ui.scrub.classList.remove("xbg-on");
    // Where we are in the whole list, from the first tile on screen.
    const y = (settings.headerHidden ? 0 : ui.bar.getBoundingClientRect().bottom) + 4;
    let index = indexAt(y - ui.grid.getBoundingClientRect().top);
    if (ui.scroller.scrollTop + ui.scroller.clientHeight >= ui.scroller.scrollHeight - 4) index = entries.length - 1;
    placeThumb(index / Math.max(entries.length - 1, 1));
    ui.scrubLabel.textContent = labelFor(index);
    ui.scrub.classList.add("xbg-on");
    hideScrubberSoon();
  }

  function hideScrubberSoon() {
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => {
      if (!scrubbing) ui.scrub.classList.remove("xbg-on");
    }, 1400);
  }

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
    ui.jumped = true; // this scroll is ours: don't treat it as scrolling down
    scroller.scrollTop = Math.max(0, scroller.scrollTop + (hidden ? -h : h));
    ui.hbtn.classList.toggle("xbg-on", hidden);
  }

  // --- Files the phone can't show -------------------------------------------
  // Instead of the browser's broken-image symbol, show a dark tile with a
  // cracked-Polaroid icon (and, full screen, a way to open it elsewhere).
  // Photos fade in once they've loaded, so fast scrolling looks smooth instead of popping.
  document.addEventListener(
    "load",
    (e) => {
      const img = e.target;
      if (img instanceof HTMLImageElement && img.parentNode && img.parentNode.matches(".xbg-tile, .xbg-post-media")) img.classList.add("xbg-in");
    },
    true
  );

  document.addEventListener("error", (e) => {
    const media = e.target;
    if (!(media instanceof HTMLImageElement || media instanceof HTMLVideoElement) || !media.closest("#xbg-overlay")) return;
    if (media.classList.contains("xbg-gave-up")) return;
    media.classList.add("xbg-gave-up");
    const broken = el("div", { class: "xbg-broken" });
    if (media.closest(".xbg-v-stage") && viewerKey) {
      const key = viewerKey;
      broken.append(
        el("p", {}, "This file can’t be shown here."),
        el("button", { class: "xbg-secondary", onclick: (ev) => { ev.stopPropagation(); Android.openWith(key); } }, "Open with another app")
      );
    }
    media.replaceWith(broken);
  }, true);

  // --- Start ----------------------------------------------------------------

  // Called by the app after you grant access, and whenever it comes back to
  // the front (to pick up new photos).
  // Coming back to the app: only reload if photos were added, changed or
  // deleted meanwhile (Android keeps a change counter), so it doesn't redraw.
  let mediaStamp = "";
  window.galleryReload = () => {
    let stamp = "";
    try {
      stamp = Android.changeStamp ? Android.changeStamp() : "";
    } catch (e) {
      stamp = "";
    }
    if (stamp && stamp === mediaStamp && Android.hasAccess()) return;
    mediaStamp = stamp;
    loadMedia();
  };

  async function start() {
    buildUi();
    ui.overlay.classList.remove("xbg-hidden");
    await loadStored();
    applyTheme();
    buildHeaderButton();
    buildScrubber();
    if (settings.headerHidden) setHeaderHidden(true);
    rebuild();
    // Read the media after the first paint so the app opens instantly.
    setTimeout(window.galleryReload, 0);
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
