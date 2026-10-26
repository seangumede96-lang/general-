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
  if (tab.windowId !== undefined) ext.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

document.getElementById("open").addEventListener("click", async () => {
  const tab = await findXTab();
  if (!tab) {
    statusEl.textContent = "Opening your bookmarks… tap the extension again once they load.";
    await ext.tabs.create({ url: BOOKMARKS });
    return;
  }
  try {
    await ext.tabs.sendMessage(tab.id, { type: "xbg-open" });
    await focus(tab);
    window.close();
  } catch (e) {
    statusEl.textContent = "Reload your X tab, then try again.";
  }
});

document.getElementById("goto").addEventListener("click", async () => {
  const tab = await findXTab();
  if (tab) {
    // Ask the page to move to the bookmarks itself (no page load, so Firefox
    // doesn't offer to open the X app); load the address only if that fails.
    try {
      await ext.tabs.sendMessage(tab.id, { type: "xbg-goto" });
      await focus(tab);
    } catch (e) {
      await ext.tabs.update(tab.id, { url: BOOKMARKS, active: true });
    }
  } else {
    await ext.tabs.create({ url: BOOKMARKS });
  }
  window.close();
});

// Floating button setting (shared with the gallery through extension storage).
const fabBox = document.getElementById("fab");
ext.storage.local.get("xbg_settings").then((data) => {
  fabBox.checked = !data.xbg_settings || data.xbg_settings.fab !== false;
  fabBox.dataset.ready = "1";
});
fabBox.addEventListener("change", async () => {
  const data = await ext.storage.local.get("xbg_settings");
  await ext.storage.local.set({ xbg_settings: { ...(data.xbg_settings || {}), fab: fabBox.checked } });
});
