// Collects media from your X bookmarks and shows it in a full-screen grid.
// Media comes from two places: the page's own data (via inject.js, which has
// playable video links) and the posts visible on screen (a fallback).
(() => {
  const items = new Map(); // key -> item, in the order bookmarks were loaded
  let filter = "all";
  let current = []; // items shown under the active filter
  let lbIndex = -1;
  let autoTimer = null;
  let ui = null;
  const rendered = new Map(); // key -> { el, sig }

  const SAFE_MEDIA = /^https:\/\/(pbs|video)\.twimg\.com\//;
  const SAFE_TWEET = /^https:\/\/x\.com\/[^\s"'<>]+$/;

  const isBookmarks = () => location.pathname.startsWith("/i/bookmarks");

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
    for (const f of ["thumb", "full", "video", "videoLow"]) {
      out[f] = typeof item[f] === "string" && SAFE_MEDIA.test(item[f]) ? item[f] : null;
    }
    return out.thumb ? out : null;
  }

  function addItem(raw, fromData) {
    const item = clean(raw);
    if (!item) return;
    const old = items.get(item.key);
    if (old && old.fromData && !fromData) return;
    if (old && !fromData) {
      // Same post seen on screen again: only fill in what we did not have.
      for (const f in item) if (!old[f] && item[f]) old[f] = item[f];
    } else {
      items.set(item.key, { ...old, ...item, tweet: item.tweet || (old && old.tweet), fromData: fromData || (old && old.fromData) });
    }
    scheduleRender();
  }

  // --- Data from inject.js -------------------------------------------------

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__xbg !== true || !Array.isArray(e.data.items)) return;
    e.data.items.forEach((it) => addItem(it, true));
  });

  // --- Fallback: read posts visible on screen ------------------------------

  function scanPage() {
    if (!isBookmarks()) return;
    document.querySelectorAll("article").forEach((article) => {
      const time = article.querySelector('a[href*="/status/"] time');
      const link = time && time.closest("a");
      if (!link) return;
      const tweet = new URL(link.getAttribute("href"), "https://x.com").href.replace(/\/(photo|video|analytics)(\/\d+)?$/, "");

      article.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach((img) => {
        addItem({ key: keyOf(img.src), type: "photo", tweet, thumb: sized(img.src, "small"), full: sized(img.src, "large") }, false);
      });
      article.querySelectorAll('img[src*="video_thumb"]').forEach((img) => {
        const type = img.src.includes("tweet_video_thumb") ? "gif" : "video";
        addItem({ key: keyOf(img.src), type, tweet, thumb: sized(img.src, "small"), full: sized(img.src, "large") }, false);
      });
      article.querySelectorAll("video[poster]").forEach((v) => {
        const src = v.currentSrc || v.src || (v.querySelector("source") || {}).src || "";
        const direct = /^https:\/\/video\.twimg\.com\/.+\.mp4/.test(src) ? src : null;
        const type = v.poster.includes("tweet_video_thumb") ? "gif" : "video";
        addItem({ key: keyOf(v.poster), type, tweet, thumb: sized(v.poster, "small"), full: sized(v.poster, "large"), video: direct, videoLow: direct }, false);
      });
    });
  }

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scanPage();
    }, 400);
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
    const filters = el("div", { class: "xbg-filters" });
    for (const [value, label] of [["all", "All"], ["photo", "Photos"], ["video", "Videos"]]) {
      filters.append(el("button", { class: "xbg-chip" + (value === filter ? " xbg-on" : ""), "data-filter": value, onclick: () => setFilter(value) }, label));
    }
    const loadBtn = el("button", { class: "xbg-load", onclick: toggleAutoLoad }, "Load more");
    const grid = el("div", { class: "xbg-grid" });
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

    let touchX = null, touchY = null;
    lightbox.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
    lightbox.addEventListener("touchend", (e) => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      touchX = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closeLightbox();
    });

    const overlay = el(
      "div",
      { id: "xbg-overlay", class: "xbg-hidden" },
      el(
        "header",
        { class: "xbg-bar" },
        el("button", { class: "xbg-close", "aria-label": "Close gallery", onclick: closeGallery }, "✕"),
        el("div", { class: "xbg-title" }, "Bookmarks ", count),
        loadBtn,
        filters
      ),
      scroller,
      lightbox
    );
    const fab = el("button", { id: "xbg-fab", class: "xbg-hidden", "aria-label": "Open gallery", onclick: openGallery }, "▦");
    document.body.append(overlay, fab);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const v = entry.target;
          if (entry.isIntersecting) v.play().catch(() => {});
          else v.pause();
        }
      },
      { root: scroller, threshold: 0.6 }
    );

    document.addEventListener("keydown", (e) => {
      if (overlay.classList.contains("xbg-hidden")) return;
      if (!lightbox.classList.contains("xbg-hidden")) {
        if (e.key === "Escape") closeLightbox();
        else if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
      } else if (e.key === "Escape") closeGallery();
    });

    ui = { overlay, fab, grid, empty, count, filters, loadBtn, lightbox, stage, openLink, counter, observer };
    updateFab();
  }

  function setFilter(value) {
    filter = value;
    ui.filters.querySelectorAll(".xbg-chip").forEach((b) => b.classList.toggle("xbg-on", b.dataset.filter === value));
    ui.grid.replaceChildren();
    rendered.clear();
    render();
  }

  function matches(item) {
    return filter === "all" || (filter === "photo" ? item.type === "photo" : item.type !== "photo");
  }

  function makeTile(item) {
    const tile = el("button", { class: "xbg-tile", "aria-label": item.type === "photo" ? "Photo" : "Video" });
    tile.addEventListener("click", () => openLightbox(current.indexOf(items.get(item.key))));
    const preview = item.videoLow || item.video;
    if (item.type !== "photo" && preview) {
      const v = el("video", { muted: true, loop: true, playsinline: true, preload: "none", poster: item.thumb, src: preview });
      v.muted = true;
      tile.append(v);
      ui.observer.observe(v);
    } else {
      tile.append(el("img", { src: item.thumb, loading: "lazy", alt: "", referrerpolicy: "no-referrer" }));
    }
    if (item.type !== "photo") tile.append(el("span", { class: "xbg-badge" }, item.type === "gif" ? "GIF" : "▶"));
    return tile;
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (!ui) return;
    current = [...items.values()].filter(matches);
    ui.count.textContent = String(items.size);
    current.forEach((item) => {
      const sig = [item.thumb, item.videoLow, item.video].join("|");
      const r = rendered.get(item.key);
      if (r && r.sig === sig) return;
      const tile = makeTile(item);
      if (r) {
        r.el.querySelectorAll("video").forEach((v) => ui.observer.unobserve(v));
        r.el.replaceWith(tile);
      } else {
        ui.grid.append(tile);
      }
      rendered.set(item.key, { el: tile, sig });
    });
    if (current.length) ui.empty.textContent = "";
    else if (!isBookmarks()) {
      ui.empty.replaceChildren("Open your bookmarks to fill the gallery. ", el("a", { href: "https://x.com/i/bookmarks" }, "Go to bookmarks"));
    } else {
      ui.empty.textContent = items.size ? "Nothing here for this filter." : "No media yet. Tap “Load more” or scroll your bookmarks.";
    }
  }

  function openGallery() {
    buildUi();
    if (!ui) return;
    scanPage();
    render();
    ui.overlay.classList.remove("xbg-hidden");
    ui.fab.classList.add("xbg-hidden");
  }

  function closeGallery() {
    closeLightbox();
    stopAutoLoad();
    ui.overlay.classList.add("xbg-hidden");
    ui.overlay.querySelectorAll(".xbg-grid video").forEach((v) => v.pause());
    updateFab();
  }

  function openLightbox(index) {
    if (index < 0 || index >= current.length) return;
    lbIndex = index;
    const item = current[index];
    ui.stage.replaceChildren();
    if (item.type === "photo") {
      ui.stage.append(el("img", { src: item.full || item.thumb, alt: "", referrerpolicy: "no-referrer" }));
    } else if (item.video) {
      const v = el("video", { src: item.video, poster: item.full || item.thumb, controls: true, autoplay: true, playsinline: true, loop: item.type === "gif" });
      ui.stage.append(v);
      v.play().catch(() => {});
    } else {
      ui.stage.append(
        el("img", { src: item.full || item.thumb, alt: "" }),
        el("p", { class: "xbg-note" }, "This video can’t play here. Tap “Open post” to watch it.")
      );
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
    if (lbIndex < 0) return;
    openLightbox((lbIndex + delta + current.length) % current.length);
  }

  // "Load more": keep scrolling the bookmarks page behind the gallery so X loads
  // older bookmarks, until nothing new shows up for a while.
  function toggleAutoLoad() {
    if (autoTimer) return stopAutoLoad();
    if (!isBookmarks()) {
      location.href = "https://x.com/i/bookmarks";
      return;
    }
    let lastSize = items.size;
    let idle = 0;
    ui.loadBtn.textContent = "Stop";
    ui.loadBtn.classList.add("xbg-on");
    autoTimer = setInterval(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      scanPage();
      if (items.size > lastSize) {
        lastSize = items.size;
        idle = 0;
      } else if (++idle >= 10) {
        stopAutoLoad();
        ui.loadBtn.textContent = "All loaded";
      }
    }, 1200);
  }

  function stopAutoLoad() {
    if (!autoTimer) return;
    clearInterval(autoTimer);
    autoTimer = null;
    ui.loadBtn.textContent = "Load more";
    ui.loadBtn.classList.remove("xbg-on");
  }

  function updateFab() {
    if (!ui) return;
    const galleryOpen = !ui.overlay.classList.contains("xbg-hidden");
    ui.fab.classList.toggle("xbg-hidden", galleryOpen || !isBookmarks());
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
    new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        updateFab();
        queueScan();
      }
    }, 800);
    queueScan();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
