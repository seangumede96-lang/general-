// The settings page (about:addons → Bookmarks Gallery → Preferences). It reads
// and writes the same storage as the gallery; open X tabs pick up changes
// through storage.onChanged.
const ext = globalThis.browser || chrome;
const store = ext.storage.local;
const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return plural(Math.round(h / 24), "day") + " ago";
}

function say(text) {
  $("message").textContent = text;
}

async function getSettings() {
  const s = (await store.get("xbg_settings")).xbg_settings;
  return s && typeof s === "object" ? s : {};
}

// --- Settings switches ------------------------------------------------------

async function showSettings() {
  const s = await getSettings();
  for (const box of document.querySelectorAll("input[data-setting]")) {
    const key = box.dataset.setting;
    if (box.dataset.on) box.checked = (s[key] || box.dataset.on) === box.dataset.on;
    else if (box.dataset.default === "true") box.checked = s[key] !== false;
    else box.checked = !!s[key];
  }
  $("last-backup").textContent = s.lastBackup ? `Once a week, if you have collections. Last backup ${ago(s.lastBackup)}.` : "Once a week, if you have collections. Never backed up yet.";
}

for (const box of document.querySelectorAll("input[data-setting]")) {
  box.addEventListener("change", async () => {
    const s = await getSettings();
    s[box.dataset.setting] = box.dataset.on ? (box.checked ? box.dataset.on : box.dataset.off) : box.checked;
    await store.set({ xbg_settings: s });
  });
}

// --- What's saved -----------------------------------------------------------

async function readAll() {
  const data = await store.get(null);
  const chunks = (prefix, n) => Array.from({ length: Number(n) > 0 ? Number(n) : 0 }, (_, i) => data[prefix + i]).filter(Array.isArray).flat();
  const cache = data.xbg_cache || null;
  const partial = data.xbg_cache_partial || null;
  const items = [
    ...(cache ? (Array.isArray(cache.items) ? cache.items : chunks("xbg_cache_", cache.chunks)) : []),
    ...(partial ? chunks("xbg_cache_partial_", partial.chunks) : []),
    ...Object.values(data.xbg_items || {}),
  ].filter((it) => it && typeof it.key === "string");
  return { data, cache, partial, items, collections: Array.isArray(data.xbg_collections) ? data.xbg_collections : [] };
}

async function showFacts() {
  const { data, cache, partial, items, collections } = await readAll();
  const lines = [];
  if (cache && cache.posts) lines.push(`${plural(Number(cache.posts), "bookmark")} in the saved copy (saved ${ago(cache.at)}), ${plural(new Set(items.map((i) => i.key)).size, "picture and video").replace("picture and videos", "pictures and videos")}.`);
  else if (partial) lines.push(`Partly loaded: ${plural(Number(partial.posts) || 0, "bookmark")} so far.`);
  else lines.push("No saved copy of your bookmarks yet: open x.com/i/bookmarks.");
  const inThem = collections.reduce((n, c) => n + ((c && c.keys) || []).length, 0);
  const waiting = collections.reduce((n, c) => n + ((c && c.pending) || []).length, 0);
  lines.push(collections.length ? `${plural(collections.length, "collection")} with ${plural(inThem, "picture and video").replace("picture and videos", "pictures and videos")}` + (waiting ? ` (${plural(waiting, "more post")} to come as bookmarks load).` : ".") : "No collections yet.");
  const hidden = Array.isArray(data.xbg_hidden) ? data.xbg_hidden.length : 0;
  lines.push(hidden ? `${plural(hidden, "post")} hidden from All posts.` : "No hidden posts.");
  $("facts").replaceChildren(...lines.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  $("unhide").disabled = !hidden;
}

// --- Back up / restore ------------------------------------------------------

$("backup").addEventListener("click", async () => {
  const data = await store.get(["xbg_collections", "xbg_items"]);
  const collections = data.xbg_collections || [];
  if (!collections.length) return say("There are no collections to back up yet.");
  const json = JSON.stringify({ app: "x-bookmarks-gallery", version: 1, collections, items: data.xbg_items || {} });
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "bookmark-collections.json" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  const s = await getSettings();
  s.lastBackup = Date.now();
  delete s.backupSnooze;
  await store.set({ xbg_settings: s });
  say(`Backed up ${plural(collections.length, "collection")} to your downloads.`);
});

const cleanId = (id) => String(id).match(/^\d{1,25}$/) && String(id);

// Same merge as the gallery's "Restore from backup": backups (media keys) and
// sorted-folder files (post ids, matched to the saved copy; the rest wait).
async function restoreFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    return say("That file isn’t a collections backup.");
  }
  if (!parsed || !Array.isArray(parsed.collections)) return say("That file isn’t a collections backup.");
  const { data, items } = await readAll();
  const collections = Array.isArray(data.xbg_collections) ? data.xbg_collections : [];
  const savedItems = { ...(data.xbg_items || {}) };
  for (const [k, it] of Object.entries(parsed.items || {})) if (it && it.key === k && !savedItems[k]) savedItems[k] = it;
  const mediaOf = new Map();
  for (const it of [...items, ...Object.values(savedItems)]) {
    const m = String(it.tweet || "").match(/\/status\/(\d+)/);
    if (!m) continue;
    if (!mediaOf.has(m[1])) mediaOf.set(m[1], new Set());
    mediaOf.get(m[1]).add(it.key);
  }
  let added = 0;
  let updated = 0;
  let named = 0;
  let matched = 0;
  for (const raw of parsed.collections) {
    if (!raw || typeof raw.name !== "string") continue;
    const posts = Array.isArray(raw.posts) ? raw.posts.map(cleanId).filter(Boolean) : [];
    named += posts.length;
    matched += posts.filter((id) => mediaOf.has(id)).length;
    const keys = [...new Set([...(Array.isArray(raw.keys) ? raw.keys.filter((k) => typeof k === "string") : []), ...posts.flatMap((id) => [...(mediaOf.get(id) || [])])])];
    const pending = [...new Set([...(Array.isArray(raw.pending) ? raw.pending.map(cleanId).filter(Boolean) : []), ...posts.filter((id) => !mediaOf.has(id))])];
    const id = typeof raw.id === "string" && raw.id ? raw.id.slice(0, 40) : Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const existing = collections.find((c) => c.id === id);
    if (existing) {
      existing.keys = [...new Set([...existing.keys, ...keys])];
      const all = [...new Set([...(existing.pending || []), ...pending])];
      if (all.length) existing.pending = all;
      updated++;
    } else {
      const c = { id, name: raw.name.trim().slice(0, 60) || "Untitled", keys };
      if (pending.length) c.pending = pending;
      collections.push(c);
      added++;
    }
  }
  await store.set({ xbg_collections: collections, xbg_items: savedItems });
  const parts = [];
  if (added) parts.push(`added ${plural(added, "folder")}`);
  if (updated) parts.push(`${added ? "updated" : "Updated"} ${plural(updated, "folder")} you already had`);
  let msg = (parts.join(", ") || "Nothing to import").replace(/^a/, "A") + ".";
  if (named) msg += `\n${matched.toLocaleString()} of the ${named.toLocaleString()} posts in the file are in your saved bookmarks.`;
  if (named > matched) msg += `\nThe other ${(named - matched).toLocaleString()} will be added to their folders by themselves as your bookmarks load.`;
  say(msg);
}

$("restore").addEventListener("click", () => {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: "application/json,.json" });
  input.addEventListener("change", () => input.files[0] && restoreFile(input.files[0]));
  document.body.append(input); // Firefox for Android only opens the picker for inputs in the page
  input.style.display = "none";
  input.click();
  setTimeout(() => input.remove(), 60000);
});

$("unhide").addEventListener("click", async () => {
  await store.set({ xbg_hidden: [] });
  say("All posts show in All posts again.");
});

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.xbg_settings) showSettings();
  showFacts();
});

showSettings();
showFacts();
