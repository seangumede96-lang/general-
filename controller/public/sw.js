// Service worker with one job: when the app's engine is not running, show a page that says
// so and how to start it, in place of the browser's "site can't be reached" screen.
// Nothing else is cached; while the app runs, every request goes straight to it.
const OFFLINE = '/offline.html';
self.addEventListener('install', (e) => {
	e.waitUntil(caches.open('offline-v1').then((c) => c.add(new Request(OFFLINE, { cache: 'reload' }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
	if (e.request.mode !== 'navigate') return;
	e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
