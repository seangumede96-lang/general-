// Extension pages can't run inline scripts, so the popup's logic lives here.
// Firefox-based browsers expose `browser`; Chrome-based ones expose `chrome`.
const ext = globalThis.browser || chrome;
const statusEl = document.getElementById("status");
const BOOKMARKS = "https://x.com/i/bookmarks";

// On Android the popup may open as its own tab, so look for the X tab by URL
// instead of assuming it is the active one.
async function findXTab() {
  const tabs = await ext.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active && (t.url || "").includes("/i/bookmarks"))
    || tabs.find((t) => (t.url || "").includes("/i/bookmarks"))
    || tabs.find((t) => t.active)
    || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function focus(tab) {
  await ext.tabs.update(tab.id, { active: true });
  // Firefox for Android has no windows API: calling it would throw and make a
  // message that did arrive look like it failed.
  if (tab.windowId !== undefined && ext.windows) ext.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

// Firefox lets you switch off the extension's access to X (about:addons →
// Permissions). Without it nothing runs on X and the X tabs can't even be
// found, so say so and offer to turn it back on instead of failing quietly.
const ORIGINS = ["https://x.com/*", "https://twitter.com/*"];
const openBtn = document.getElementById("open");
let hasAccess = true;
ext.permissions.contains({ origins: ORIGINS }).then((ok) => {
  hasAccess = ok;
  if (ok) return;
  statusEl.textContent = "The gallery isn’t allowed on x.com right now, so it can’t show your bookmarks.";
  openBtn.textContent = "Allow access to X";
}, () => {});

// Asks for access again; true once it's allowed. It has to be the first
// thing the click does, or Firefox won't show the request.
async function allowAccess() {
  const ok = await ext.permissions.request({ origins: ORIGINS }).catch(() => false);
  if (!ok) {
    statusEl.textContent = "The gallery needs access to x.com to show your bookmarks.";
    return false;
  }
  hasAccess = true;
  openBtn.textContent = "Open gallery";
  statusEl.textContent = "";
  return true;
}

openBtn.addEventListener("click", async () => {
  const granted = !hasAccess;
  if (granted && !(await allowAccess())) return;
  const tab = await findXTab();
  if (!tab) {
    // The new tab opens the gallery itself once it has loaded (see #xbg-open in content.js).
    statusEl.textContent = "Opening your bookmarks…";
    await ext.tabs.create({ url: BOOKMARKS + "#xbg-open" });
    window.close();
    return;
  }
  try {
    await ext.tabs.sendMessage(tab.id, { type: "xbg-open" });
  } catch (e) {
    if (granted) {
      // Access was only just given back, so this tab started without the
      // gallery: load the bookmarks there and open it.
      await ext.tabs.update(tab.id, { url: BOOKMARKS + "#xbg-open", active: true });
      // Already on the bookmarks, that only changes the #: load it afresh.
      if ((tab.url || "").split("#")[0] === BOOKMARKS) await ext.tabs.reload(tab.id);
      await focus(tab).catch(() => {});
      window.close();
      return;
    }
    statusEl.textContent = "Reload your X tab, then try again.";
    return;
  }
  await focus(tab).catch(() => {});
  window.close();
});

document.getElementById("goto").addEventListener("click", async () => {
  const tab = await findXTab();
  if (tab) {
    // Ask the page to move to the bookmarks itself (no page load, so Firefox
    // doesn't offer to open the X app); load the address only if that fails.
    try {
      await ext.tabs.sendMessage(tab.id, { type: "xbg-goto" });
    } catch (e) {
      await ext.tabs.update(tab.id, { url: BOOKMARKS, active: true });
    }
    await focus(tab).catch(() => {});
  } else {
    await ext.tabs.create({ url: BOOKMARKS });
  }
  window.close();
});

// Floating button setting (shared with the gallery through extension storage).
const fabBox = document.getElementById("fab");
fabBox.checked = true;
ext.storage.local.get("xbg_settings").then((data) => {
  fabBox.checked = !data.xbg_settings || data.xbg_settings.fab !== false;
  fabBox.dataset.ready = "1";
}, () => {});
fabBox.addEventListener("change", async () => {
  const data = await ext.storage.local.get("xbg_settings");
  await ext.storage.local.set({ xbg_settings: { ...(data.xbg_settings || {}), fab: fabBox.checked } });
});
