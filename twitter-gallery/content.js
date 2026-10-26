// Shows the media from your X bookmarks in a full-screen grid, with
// Instagram-style collections you can sort posts into.
// inject.js loads every page of bookmarks in the background and sends the media
// here. If X refuses those requests, this falls back to scrolling the bookmarks
// page behind the gallery (and reading posts off the screen) while it is open.
(() => {
  const ext = globalThis.browser || chrome;
  const items = new Map(); // key -> item, in the order bookmarks were loaded
  const savedItems = new Map(); // key -> item, for every post in a collection (kept in storage)
  let collections = []; // [{ id, name, keys: [newest first] }]
  let view = "all"; // "all" | "collections" | "collection"
  let openId = null; // collection shown when view === "collection"
  let filter = "all";
  let current = []; // items shown in the grid right now
  let lbIndex = -1;
  let ui = null;
  let gotData = false; // inject.js has delivered media
  let loadState = { state: "idle" };
  let scrollTimer = null;
  let selectMode = false;
  const selected = new Set();
  const rendered = new Set(); // keys already in the grid

  const SAFE_MEDIA = /^https:\/\/(pbs|video)\.twimg\.com\//;
  const SAFE_TWEET = /^https:\/\/x\.com\/[^\s"'<>]+$/;
  const STORE_COLLECTIONS = "xbg_collections";
  const STORE_ITEMS = "xbg_items";

  const isBookmarks = () => location.pathname.startsWith("/i/bookmarks");
  const galleryOpen = () => ui && !ui.overlay.classList.contains("xbg-hidden");
  const getItem = (key) => items.get(key) || savedItems.get(key);
  const getCollection = (id) => collections.find((c) => c.id === id);
  const isSaved = (key) => collections.some((c) => c.keys.includes(key));

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
    return out.thumb ? out : null;
  }

  function addItem(raw) {
    const item = clean(raw);
    if (!item) return;
    const old = items.get(item.key);
    if (old) {
      for (const f in item) if (item[f] && !old[f]) old[f] = item[f];
    } else {
      items.set(item.key, item);
    }
    const saved = savedItems.get(item.key);
    if (saved) for (const f in item) if (item[f] && !saved[f]) saved[f] = item[f];
    scheduleRender();
  }

  // --- Collections storage -------------------------------------------------

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

  async function loadCollections() {
    try {
      const data = await ext.storage.local.get([STORE_COLLECTIONS, STORE_ITEMS]);
      collections = (data[STORE_COLLECTIONS] || []).map(cleanCollection).filter(Boolean);
      for (const raw of Object.values(data[STORE_ITEMS] || {})) {
        const item = clean(raw);
        if (item) savedItems.set(item.key, item);
      }
    } catch (e) {
      collections = [];
    }
    if (galleryOpen()) rebuild();
  }

  function saveCollections() {
    const used = new Set(collections.flatMap((c) => c.keys));
    for (const key of used) {
      const item = getItem(key);
      if (item) savedItems.set(key, { ...item });
    }
    for (const key of [...savedItems.keys()]) if (!used.has(key)) savedItems.delete(key);
    ext.storage.local
      .set({ [STORE_COLLECTIONS]: collections, [STORE_ITEMS]: Object.fromEntries(savedItems) })
      .catch(() => toast("Couldn’t save your collections"));
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
    const data = JSON.stringify({ app: "x-bookmarks-gallery", version: 1, collections, items: Object.fromEntries(savedItems) });
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
        toast(`Restored ${added} collection${added === 1 ? "" : "s"}`);
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
      if (loadState.state === "done") stopScrollLoading();
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
      for (const img of article.querySelectorAll('img[src*="pbs.twimg.com/media/"]')) {
        addItem({ key: keyOf(img.src), type: "photo", tweet, thumb: sized(img.src, "small"), full: sized(img.src, "large") });
      }
      for (const img of article.querySelectorAll('img[src*="video_thumb"]')) {
        const type = img.src.includes("tweet_video_thumb") ? "gif" : "video";
        addItem({ key: keyOf(img.src), type, tweet, thumb: sized(img.src, "small"), full: sized(img.src, "large") });
      }
      for (const v of article.querySelectorAll("video[poster]")) {
        const src = v.currentSrc || v.src || "";
        const video = /^https:\/\/video\.twimg\.com\/.+\.mp4/.test(src) ? src : null;
        const type = v.poster.includes("tweet_video_thumb") ? "gif" : "video";
        addItem({ key: keyOf(v.poster), type, tweet, thumb: sized(v.poster, "small"), full: sized(v.poster, "large"), video });
      }
    }
  }

  // Only scan the page when the background loader hasn't delivered anything,
  // or while the scroll fallback is running; X's page changes constantly and
  // scanning it all the time is slow.
  let scanQueued = false;
  function queueScan() {
    if (scanQueued || (gotData && !scrollTimer) || !isBookmarks()) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scanPage();
    }, 800);
  }

  function startScrollLoading() {
    if (scrollTimer || !isBookmarks()) return;
    let lastSize = items.size;
    let idle = 0;
    scrollTimer = setInterval(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      scanPage();
      if (items.size > lastSize) {
        lastSize = items.size;
        idle = 0;
      } else if (++idle >= 12) {
        stopScrollLoading();
        loadState = { state: "done" };
      }
      updateHeader();
    }, 1200);
    updateHeader();
  }

  function stopScrollLoading() {
    if (!scrollTimer) return;
    clearInterval(scrollTimer);
    scrollTimer = null;
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

  function cover(c, cls) {
    const thumbs = c.keys.map(getItem).filter(Boolean).slice(0, 4);
    const box = el("div", { class: `${cls} xbg-mosaic`, "data-n": String(thumbs.length) });
    for (const it of thumbs) box.append(el("img", { src: it.thumb, loading: "lazy", decoding: "async", alt: "", referrerpolicy: "no-referrer" }));
    return box;
  }

  let toastTimer = null;
  function toast(text) {
    if (!ui) return;
    ui.toast.textContent = text;
    ui.toast.classList.remove("xbg-hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.add("xbg-hidden"), 2500);
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
            el("span", { class: "xbg-pick-name" }, c.name, el("small", {}, `${c.keys.length} posts`)),
            el("span", { class: "xbg-pick-check" }, inIt ? "✓" : "")
          )
        );
      }
    };
    draw();
    const title = keys.length > 1 ? `Save ${keys.length} posts to…` : "Save to…";
    openSheet(title, el("div", { class: "xbg-sheet-body" }, list, el("button", { class: "xbg-primary", onclick: () => closeSheet() }, "Done")), onDone);
  }

  // --- Gallery UI ----------------------------------------------------------

  function buildUi() {
    if (ui || !document.body) return;
    const back = el("button", { class: "xbg-close", "aria-label": "Back", onclick: () => setView("collections") }, "‹");
    const close = el("button", { class: "xbg-close", "aria-label": "Close gallery", onclick: closeGallery }, "✕");
    const titleName = el("span", {}, "Bookmarks");
    const count = el("span", { class: "xbg-count" }, "0");
    const statusText = el("div", { class: "xbg-status" });
    const selectBtn = el("button", { class: "xbg-text-btn", onclick: () => setSelectMode(!selectMode) }, "Select");
    const menuBtn = el("button", { class: "xbg-close", "aria-label": "Collection options", onclick: collectionMenu }, "⋯");

    const tabs = el("div", { class: "xbg-tabs" });
    for (const [value, label] of [["all", "▦  All posts"], ["collections", "▢  Collections"]]) {
      tabs.append(el("button", { class: "xbg-tab", "data-view": value, onclick: () => setView(value) }, label));
    }
    const filters = el("div", { class: "xbg-filters" });
    for (const [value, label] of [["all", "All"], ["photo", "Photos"], ["video", "Videos"]]) {
      filters.append(el("button", { class: "xbg-chip" + (value === filter ? " xbg-on" : ""), "data-filter": value, onclick: () => setFilter(value) }, label));
    }

    const grid = el("div", { class: "xbg-grid" });
    grid.addEventListener("click", (e) => {
      const tile = e.target.closest(".xbg-tile");
      if (!tile) return;
      const key = tile.dataset.key;
      if (selectMode) {
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
        tile.classList.toggle("xbg-selected", selected.has(key));
        updateSelectBar();
      } else {
        openLightbox(current.findIndex((it) => it.key === key));
      }
    });
    const collGrid = el("div", { class: "xbg-collections xbg-hidden" });
    const empty = el("p", { class: "xbg-empty" });
    const scroller = el("div", { class: "xbg-scroll" }, grid, collGrid, empty);

    const selectInfo = el("span", { class: "xbg-select-info" });
    const addBtn = el("button", { class: "xbg-primary", onclick: () => openPicker([...selected], () => { setSelectMode(false); rebuild(); }) }, "Add to collection");
    const removeBtn = el("button", { class: "xbg-secondary", onclick: removeSelected }, "Remove");
    const selectBar = el("div", { class: "xbg-select-bar xbg-hidden" }, selectInfo, removeBtn, addBtn);

    const stage = el("div", { class: "xbg-stage" });
    const openLink = el("a", { class: "xbg-open", target: "_blank", rel: "noopener noreferrer" }, "Open post ↗");
    const saveBtn = el("button", { class: "xbg-save", onclick: () => {
      if (lbIndex < 0) return;
      const key = current[lbIndex].key;
      openPicker([key], () => updateSaveBtn(key));
    } });
    const counter = el("span", { class: "xbg-counter" });
    const lightbox = el(
      "div",
      { class: "xbg-lightbox xbg-hidden" },
      stage,
      el("button", { class: "xbg-lb-close", "aria-label": "Close", onclick: closeLightbox }, "✕"),
      el("button", { class: "xbg-nav xbg-prev", "aria-label": "Previous", onclick: () => step(-1) }, "‹"),
      el("button", { class: "xbg-nav xbg-next", "aria-label": "Next", onclick: () => step(1) }, "›"),
      el("div", { class: "xbg-lb-bar" }, counter, el("div", { class: "xbg-lb-actions" }, saveBtn, openLink))
    );

    // Swipe left/right to move, swipe down to close. Swipes that start on the
    // video's control bar are left alone so seeking still works.
    let touch = null;
    lightbox.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      const onControls = e.target.tagName === "VIDEO" && t.clientY > e.target.getBoundingClientRect().bottom - 60;
      touch = e.touches.length === 1 && !onControls && !e.target.closest(".xbg-lb-bar") ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    lightbox.addEventListener("touchend", (e) => {
      if (!touch) return;
      const dx = e.changedTouches[0].clientX - touch.x;
      const dy = e.changedTouches[0].clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
      else if (dy > 100 && dy > Math.abs(dx) * 1.5) closeLightbox();
    });

    const toastEl = el("div", { class: "xbg-toast xbg-hidden" });
    const overlay = el(
      "div",
      { id: "xbg-overlay", class: "xbg-hidden" },
      el(
        "header",
        { class: "xbg-bar" },
        el("div", { class: "xbg-row" }, back, close, el("div", { class: "xbg-title" }, titleName, " ", count, statusText), selectBtn, menuBtn),
        tabs,
        filters
      ),
      scroller,
      selectBar,
      lightbox,
      toastEl
    );
    const fab = el("button", { id: "xbg-fab", class: "xbg-hidden", "aria-label": "Open gallery", onclick: openGallery }, "▦");
    document.body.append(overlay, fab);

    document.addEventListener("keydown", (e) => {
      if (!galleryOpen() || e.key !== "Escape" && !e.key.startsWith("Arrow")) return;
      if (ui.sheet) {
        if (e.key === "Escape") closeSheet();
      } else if (!lightbox.classList.contains("xbg-hidden")) {
        if (e.key === "Escape") closeLightbox();
        else if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
      } else if (e.key === "Escape") {
        if (selectMode) setSelectMode(false);
        else if (view === "collection") setView("collections");
        else closeGallery();
      }
    });

    ui = {
      overlay, fab, back, close, titleName, count, statusText, selectBtn, menuBtn, tabs, filters,
      grid, collGrid, empty, scroller, selectBar, selectInfo, addBtn, removeBtn,
      lightbox, stage, openLink, saveBtn, counter, toast: toastEl, sheet: null,
    };
    updateFab();
    updateHeader();
  }

  function updateHeader() {
    if (!ui) return;
    const c = view === "collection" ? getCollection(openId) : null;
    ui.back.classList.toggle("xbg-hidden", !c);
    ui.close.classList.toggle("xbg-hidden", !!c);
    ui.menuBtn.classList.toggle("xbg-hidden", !c);
    ui.tabs.classList.toggle("xbg-hidden", !!c);
    ui.filters.classList.toggle("xbg-hidden", view === "collections");
    ui.selectBtn.classList.toggle("xbg-hidden", view === "collections");
    ui.selectBtn.textContent = selectMode ? "Cancel" : "Select";
    ui.titleName.textContent = c ? c.name : "Bookmarks";
    ui.count.textContent = String(c ? c.keys.length : items.size);
    ui.tabs.querySelectorAll(".xbg-tab").forEach((t) => t.classList.toggle("xbg-on", t.dataset.view === view));

    let text = "";
    if (view === "all") {
      const s = loadState;
      if (scrollTimer) text = "Loading more…";
      else if (s.state === "loading") text = "Loading all bookmarks…";
      else if (s.state === "waiting") text = `X asked us to slow down, continuing in ${s.seconds}s…`;
      else if (s.state === "done") text = "All loaded";
      else if (s.state === "failed") text = "Couldn’t load everything";
    }
    ui.statusText.textContent = text;
  }

  function setView(value, id = null) {
    view = value;
    openId = id;
    selectMode = false;
    selected.clear();
    updateSelectBar();
    ui.scroller.scrollTop = 0;
    rebuild();
  }

  function setFilter(value) {
    filter = value;
    ui.filters.querySelectorAll(".xbg-chip").forEach((b) => b.classList.toggle("xbg-on", b.dataset.filter === value));
    ui.scroller.scrollTop = 0;
    rebuild();
  }

  function setSelectMode(on) {
    selectMode = on;
    selected.clear();
    ui.grid.querySelectorAll(".xbg-selected").forEach((t) => t.classList.remove("xbg-selected"));
    ui.overlay.classList.toggle("xbg-selecting", on);
    updateSelectBar();
    updateHeader();
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
    rebuild();
    toast(`Removed ${n} post${n === 1 ? "" : "s"}`);
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

  function matches(item) {
    return filter === "all" || (filter === "photo" ? item.type === "photo" : item.type !== "photo");
  }

  // Grid tiles are plain thumbnails (videos too) so scrolling stays smooth;
  // videos play in the full-screen viewer.
  function makeTile(item) {
    const tile = el("button", { class: "xbg-tile" + (selected.has(item.key) ? " xbg-selected" : ""), "data-key": item.key, "aria-label": item.type === "photo" ? "Photo" : "Video" });
    tile.append(el("img", { src: item.thumb, loading: "lazy", decoding: "async", alt: "", referrerpolicy: "no-referrer" }));
    if (item.type !== "photo") tile.append(el("span", { class: "xbg-badge" }, item.type === "gif" ? "GIF" : "▶"));
    return tile;
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued || !galleryOpen()) {
      if (ui && view === "all") ui.count.textContent = String(items.size);
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function rebuild() {
    if (!ui) return;
    ui.grid.replaceChildren();
    rendered.clear();
    render();
  }

  function render() {
    if (!ui) return;
    updateHeader();
    const showCollections = view === "collections";
    ui.grid.classList.toggle("xbg-hidden", showCollections);
    ui.collGrid.classList.toggle("xbg-hidden", !showCollections);
    if (showCollections) return renderCollections();

    const c = view === "collection" ? getCollection(openId) : null;
    const source = c ? c.keys.map(getItem).filter(Boolean) : items.values();
    current = [];
    for (const item of source) if (matches(item)) current.push(item);

    // "All posts" only ever grows, so new tiles are appended; collections are
    // rebuilt whenever they change.
    const batch = document.createDocumentFragment();
    for (const item of current) {
      if (rendered.has(item.key)) continue;
      rendered.add(item.key);
      batch.append(makeTile(item));
    }
    if (batch.childNodes.length) ui.grid.append(batch);

    if (current.length) ui.empty.textContent = "";
    else if (c) ui.empty.textContent = c.keys.length ? "Nothing here for this filter." : "No posts yet. Go to All posts, tap Select, pick some posts, then tap “Add to collection”.";
    else if (!isBookmarks() && !items.size) {
      ui.empty.replaceChildren("Open your bookmarks to fill the gallery. ", el("a", { href: "https://x.com/i/bookmarks" }, "Go to bookmarks"));
    } else if (!items.size) ui.empty.textContent = "Loading your bookmarks…";
    else ui.empty.textContent = "Nothing here for this filter.";
  }

  function renderCollections() {
    const cards = [
      el(
        "button",
        { class: "xbg-card", onclick: () => askName("New collection", "", (name) => { createCollection(name); render(); }) },
        el("div", { class: "xbg-card-cover xbg-plus" }, "＋"),
        el("div", { class: "xbg-card-name" }, "New collection")
      ),
    ];
    for (const c of collections) {
      cards.push(
        el(
          "button",
          { class: "xbg-card", onclick: () => setView("collection", c.id) },
          cover(c, "xbg-card-cover"),
          el("div", { class: "xbg-card-name" }, c.name),
          el("div", { class: "xbg-card-count" }, `${c.keys.length} post${c.keys.length === 1 ? "" : "s"}`)
        )
      );
    }
    ui.collGrid.replaceChildren(...cards);
    ui.empty.replaceChildren(
      collections.length ? "" : "Group your favourite posts into collections, like on Instagram.",
      el("span", { class: "xbg-backup" },
        el("button", { class: "xbg-link", onclick: backup }, "Back up collections"),
        " · ",
        el("button", { class: "xbg-link", onclick: restore }, "Restore from backup"))
    );
  }

  function openGallery() {
    buildUi();
    if (!ui) return;
    if (!gotData) scanPage();
    ui.overlay.classList.remove("xbg-hidden");
    ui.fab.classList.add("xbg-hidden");
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
    updateFab();
  }

  function updateSaveBtn(key) {
    // Taking the post out of the collection being viewed removes it from this view.
    const c = view === "collection" ? getCollection(openId) : null;
    if (c && !c.keys.includes(key)) {
      closeLightbox();
      rebuild();
      return;
    }
    if (c) rebuild();
    const saved = isSaved(key);
    ui.saveBtn.textContent = saved ? "✓ Saved" : "＋ Save";
    ui.saveBtn.classList.toggle("xbg-on", saved);
  }

  function openLightbox(index) {
    if (index < 0 || index >= current.length) return;
    lbIndex = index;
    const item = current[index];
    ui.stage.querySelectorAll("video").forEach((v) => v.pause());
    ui.stage.replaceChildren();
    if (item.type === "photo") {
      ui.stage.append(el("img", { src: item.full || item.thumb, alt: "", referrerpolicy: "no-referrer" }));
    } else if (item.video) {
      const v = el("video", { src: item.video, poster: item.full || item.thumb, controls: true, autoplay: true, playsinline: true, loop: item.type === "gif", preload: "auto" });
      if (item.type === "gif") v.muted = true;
      ui.stage.append(v);
      v.play().catch(() => {});
    } else {
      ui.stage.append(
        el("img", { src: item.full || item.thumb, alt: "" }),
        el("p", { class: "xbg-note" }, "This video can’t play here. Tap “Open post” to watch it.")
      );
    }
    // Warm up the neighbours so swiping feels instant.
    for (const n of [current[index + 1], current[index - 1]]) {
      if (n && n.type === "photo") new Image().src = n.full || n.thumb;
    }
    ui.counter.textContent = `${index + 1} / ${current.length}`;
    if (item.tweet) {
      ui.openLink.href = item.tweet;
      ui.openLink.classList.remove("xbg-hidden");
    } else {
      ui.openLink.classList.add("xbg-hidden");
    }
    const saved = isSaved(item.key);
    ui.saveBtn.textContent = saved ? "✓ Saved" : "＋ Save";
    ui.saveBtn.classList.toggle("xbg-on", saved);
    ui.lightbox.classList.remove("xbg-hidden");
  }

  function closeLightbox() {
    if (!ui) return;
    ui.stage.querySelectorAll("video").forEach((v) => v.pause());
    ui.stage.replaceChildren();
    ui.lightbox.classList.add("xbg-hidden");
    lbIndex = -1;
  }

  function step(delta) {
    if (lbIndex < 0 || !current.length) return;
    openLightbox((lbIndex + delta + current.length) % current.length);
  }

  function updateFab() {
    if (!ui) return;
    ui.fab.classList.toggle("xbg-hidden", galleryOpen() || !isBookmarks());
  }

  // --- Wiring --------------------------------------------------------------

  ext.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg && msg.type === "xbg-open") {
      openGallery();
      respond({ ok: true, count: items.size, onBookmarks: isBookmarks() });
    }
  });

  function start() {
    buildUi();
    loadCollections();
    new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        updateFab();
        queueScan();
      }
    }, 1000);
    queueScan();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
