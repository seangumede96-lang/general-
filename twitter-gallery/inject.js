// Runs inside the x.com page itself. When the bookmarks page loads its own data,
// this reads the media list out of that response (including playable .mp4 links,
// which the page's HTML never exposes) and hands it to content.js.
(() => {
  if (window.__xbgHooked) return;
  window.__xbgHooked = true;

  const BOOKMARK_API = /\/graphql\/[^/?]+\/Bookmark/;

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

  function toItem(media, tweet) {
    const thumb = media.media_url_https;
    if (!thumb) return null;
    const base = { key: keyOf(thumb), tweet: tweetUrl(media, tweet), thumb: sized(thumb, "small") };
    if (media.type === "photo") return { ...base, type: "photo", full: sized(thumb, "large") };
    const mp4s = ((media.video_info && media.video_info.variants) || [])
      .filter((v) => v.content_type === "video/mp4" && v.url)
      .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
    return {
      ...base,
      type: media.type === "animated_gif" ? "gif" : "video",
      full: sized(thumb, "large"),
      videoLow: mp4s.length ? mp4s[0].url : null,
      video: mp4s.length ? mp4s[mp4s.length - 1].url : null,
    };
  }

  // Walk the whole response and pick out every post that has media, so small
  // changes to X's response layout don't break the extension.
  function extract(root) {
    const out = [];
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 80) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      const media = node.legacy && node.legacy.extended_entities && node.legacy.extended_entities.media;
      if (node.rest_id && Array.isArray(media)) {
        for (const m of media) {
          const item = toItem(m, node);
          if (item && !seen.has(item.key)) {
            seen.add(item.key);
            out.push(item);
          }
        }
      }
      for (const k in node) walk(node[k], depth + 1);
    };
    walk(root, 0);
    return out;
  }

  function publish(json) {
    try {
      const items = extract(json);
      if (items.length) window.postMessage({ __xbg: true, items }, location.origin);
    } catch (e) {
      /* ignore malformed responses */
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const input = args[0];
      const url = String(input instanceof Request ? input.url : input);
      if (BOOKMARK_API.test(url)) res.clone().json().then(publish, () => {});
    } catch (e) {
      /* never break the page */
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xbgUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__xbgUrl && BOOKMARK_API.test(this.__xbgUrl)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "json") publish(this.response);
          else if (this.responseType === "" || this.responseType === "text") publish(JSON.parse(this.responseText));
        } catch (e) {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, args);
  };
})();
