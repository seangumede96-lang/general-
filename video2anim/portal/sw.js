// Minimal service worker so Android lets you install the portal as an app.
// Live data always comes from the network; only the page shell is cached for a friendly offline screen.
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", e => e.waitUntil(caches.open("v2a-shell-v1").then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith("/api/") || e.request.method !== "GET") return;   // never cache live data
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open("v2a-shell-v1").then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
