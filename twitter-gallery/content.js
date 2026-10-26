// Shows the media from your X bookmarks in a full-screen grid.
// inject.js loads every page of bookmarks in the background and sends the media
// here. If X refuses those requests, this falls back to scrolling the bookmarks
// page behind the gallery (and reading posts off the screen) while it is open.
(() => {
  const items = new Map(); // key -> item, in the order bookmarks were loaded
  let filter = "all";
  let current = []; // items shown under the active filter
  let lbIndex = -1;
  let ui = null;
  let gotData = false; // inject.js has delivered media
  let loadState = { state: "idle" };
  let scrollTimer = null;
  const rendered = new Set(); // keys already in the grid

  const SAFE_MEDIA = /^https:\/\/(pbs|video)\.twimg\.com\//;
  const SAFE_TWEET = /^https:\/\/x\.com\/[^\s"'<>]+$/;

  const isBookmarks = () => location.pathname.startsWith("/i/bookmarks");
  const galleryOpen = () => ui && !ui.overlay.classList.contains("xbg-hidden");

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
    scheduleRender();
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
      updateStatus();
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
  // scanning it all the time is what made the first version laggy.
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
      updateStatus();
    }, 1200);
    updateStatus();
  }

  function stopScrollLoading() {
    if (!scrollTimer) return;
    clearInterval(scrollTimer);
    scrollTimer = null;
    updateStatus();
  }

  // --- UI ------------------------------------------------------------------

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

  function buildUi() {
    if (ui || !document.body) return;
    const count = el("span", { class: "xbg-count" }, "0");
    const statusText = el("div", { class: "xbg-status" });
    const filters = el("div", { class: "xbg-filters" });
    for (const [value, label] of [["all", "All"], ["photo", "Photos"], ["video", "Videos"]]) {
      filters.append(el("button", { class: "xbg-chip" + (value === filter ? " xbg-on" : ""), "data-filter": value, onclick: () => setFilter(value) }, label));
    }
    const grid = el("div", { class: "xbg-grid" });
    grid.addEventListener("click", (e) => {
      const tile = e.target.closest(".xbg-tile");
      if (tile) openLightbox(current.findIndex((it) => it.key === tile.dataset.key));
    });
    const empty = el("p", { class: "xbg-empty" });
    const scroller = el("div", { class: "xbg-scroll" }, grid, empty);

    const stage = el("div", { class: "xbg-stage" });
    const openLink = el("a", { class: "xbg-open", target: "_blank", rel: "noopener noreferrer" }, "Open post ↗");
    const counter = el("span", { class: "xbg-counter" });
    const lightbox = el(
      "div",
      { class: "xbg-lightbox xbg-hidden" },
      stage,
      el("button", { class: "xbg-lb-close", "aria-label": "Close", onclick: closeLightbox }, "✕"),
      el("button", { class: "xbg-nav xbg-prev", "aria-label": "Previous", onclick: () => step(-1) }, "‹"),
      el("button", { class: "xbg-nav xbg-next", "aria-label": "Next", onclick: () => step(1) }, "›"),
      el("div", { class: "xbg-lb-bar" }, counter, openLink)
    );

    // Swipe left/right to move, swipe down to close. Swipes that start on the
    // video's control bar are left alone so seeking still works.
    let touch = null;
    lightbox.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      const onControls = e.target.tagName === "VIDEO" && t.clientY > e.target.getBoundingClientRect().bottom - 60;
      touch = e.touches.length === 1 && !onControls ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    lightbox.addEventListener("touchend", (e) => {
      if (!touch) return;
      const dx = e.changedTouches[0].clientX - touch.x;
      const dy = e.changedTouches[0].clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
      else if (dy > 100 && dy > Math.abs(dx) * 1.5) closeLightbox();
    });

    const overlay = el(
      "div",
      { id: "xbg-overlay", class: "xbg-hidden" },
      el(
        "header",
        { class: "xbg-bar" },
        el("button", { class: "xbg-close", "aria-label": "Close gallery", onclick: closeGallery }, "✕"),
        el("div", { class: "xbg-title" }, "Bookmarks ", count, statusText),
        filters
      ),
      scroller,
      lightbox
    );
    const fab = el("button", { id: "xbg-fab", class: "xbg-hidden", "aria-label": "Open gallery", onclick: openGallery }, "▦");
    document.body.append(overlay, fab);

    document.addEventListener("keydown", (e) => {
      if (!galleryOpen()) return;
      if (!lightbox.classList.contains("xbg-hidden")) {
        if (e.key === "Escape") closeLightbox();
        else if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
      } else if (e.key === "Escape") closeGallery();
    });

    ui = { overlay, fab, grid, empty, count, statusText, filters, lightbox, stage, openLink, counter };
    updateFab();
    updateStatus();
  }

  function updateStatus() {
    if (!ui) return;
    const s = loadState;
    let text = "";
    if (scrollTimer) text = "Loading more…";
    else if (s.state === "loading") text = "Loading all bookmarks…";
    else if (s.state === "waiting") text = `X asked us to slow down, continuing in ${s.seconds}s…`;
    else if (s.state === "done") text = "All loaded";
    else if (s.state === "failed") text = "Couldn’t load everything";
    ui.statusText.textContent = text;
  }

  function setFilter(value) {
    filter = value;
    ui.filters.querySelectorAll(".xbg-chip").forEach((b) => b.classList.toggle("xbg-on", b.dataset.filter === value));
    ui.grid.replaceChildren();
    rendered.clear();
    ui.overlay.querySelector(".xbg-scroll").scrollTop = 0;
    render();
  }

  function matches(item) {
    return filter === "all" || (filter === "photo" ? item.type === "photo" : item.type !== "photo");
  }

  // Grid tiles are plain thumbnails (videos too) so scrolling stays smooth;
  // videos play in the full-screen viewer.
  function makeTile(item) {
    const tile = el("button", { class: "xbg-tile", "data-key": item.key, "aria-label": item.type === "photo" ? "Photo" : "Video" });
    tile.append(el("img", { src: item.thumb, loading: "lazy", decoding: "async", alt: "", referrerpolicy: "no-referrer" }));
    if (item.type !== "photo") tile.append(el("span", { class: "xbg-badge" }, item.type === "gif" ? "GIF" : "▶"));
    return tile;
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued || !galleryOpen()) {
      if (ui) ui.count.textContent = String(items.size);
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (!ui) return;
    current = [];
    for (const item of items.values()) if (matches(item)) current.push(item);
    ui.count.textContent = String(items.size);
    const batch = document.createDocumentFragment();
    for (const item of current) {
      if (rendered.has(item.key)) continue;
      rendered.add(item.key);
      batch.append(makeTile(item));
    }
    if (batch.childNodes.length) ui.grid.append(batch);

    if (current.length) ui.empty.textContent = "";
    else if (!isBookmarks() && !items.size) {
      ui.empty.replaceChildren("Open your bookmarks to fill the gallery. ", el("a", { href: "https://x.com/i/bookmarks" }, "Go to bookmarks"));
    } else if (!items.size) {
      ui.empty.textContent = "Loading your bookmarks…";
    } else {
      ui.empty.textContent = "Nothing here for this filter.";
    }
  }

  function openGallery() {
    buildUi();
    if (!ui) return;
    if (!gotData) scanPage();
    ui.overlay.classList.remove("xbg-hidden");
    ui.fab.classList.add("xbg-hidden");
    render();
    if (isBookmarks() && (loadState.state === "failed" || (!gotData && loadState.state === "idle"))) {
      // Background loading isn't working (or hasn't started): scroll the page instead.
      setTimeout(() => {
        if (galleryOpen() && (loadState.state === "failed" || !gotData)) startScrollLoading();
      }, gotData ? 0 : 4000);
    }
  }

  function closeGallery() {
    closeLightbox();
    stopScrollLoading();
    ui.overlay.classList.add("xbg-hidden");
    updateFab();
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

  (globalThis.browser || chrome).runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg && msg.type === "xbg-open") {
      openGallery();
      respond({ ok: true, count: items.size, onBookmarks: isBookmarks() });
    }
  });

  function start() {
    buildUi();
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
