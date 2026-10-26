// Extension pages can't run inline scripts, so the popup's logic lives here.
const statusEl = document.getElementById("status");
const BOOKMARKS = "https://x.com/i/bookmarks";

// On Android the popup may open as its own tab, so look for the X tab by URL
// instead of assuming it is the active one.
async function findXTab() {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active && (t.url || "").includes("/i/bookmarks"))
    || tabs.find((t) => (t.url || "").includes("/i/bookmarks"))
    || tabs.find((t) => t.active)
    || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function focus(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

document.getElementById("open").addEventListener("click", async () => {
  const tab = await findXTab();
  if (!tab) {
    statusEl.textContent = "Opening your bookmarks… tap the extension again once they load.";
    await chrome.tabs.create({ url: BOOKMARKS });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "xbg-open" });
    await focus(tab);
    window.close();
  } catch (e) {
    statusEl.textContent = "Reload your X tab, then try again.";
  }
});

document.getElementById("goto").addEventListener("click", async () => {
  const tab = await findXTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { url: BOOKMARKS, active: true });
  } else {
    await chrome.tabs.create({ url: BOOKMARKS });
  }
  window.close();
});
