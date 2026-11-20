// Vyra AI service worker: caches the app shell so it opens fast and shows a friendly page offline.
// Never caches API calls, chat streams or anything private.
const CACHE = "vyra-shell-v2";
const SHELL = ["/static/style.css", "/static/script.js", "/static/theme.js", "/static/icon-192.png", "/offline.html"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/static/")) {  // stale-while-revalidate for static files
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (req.mode === "navigate") {  // pages: network first, offline page if the network is down
    e.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
  }
});
