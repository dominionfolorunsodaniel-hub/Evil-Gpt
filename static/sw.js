// VYRA AI service worker. Versioned shell cache; network-first for assets so deployments are visible immediately.
const CACHE = "vyra-shell-v7-files";
const SHELL = ["/static/style.css?v=20261122-files", "/static/script.js?v=20261122-files", "/static/theme.js?v=20261122-files", "/static/pwa.js?v=20261122-files", "/static/icon-192.png", "/offline.html"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req=e.request, url=new URL(req.url);
  if(req.method!=="GET"||url.origin!==location.origin)return;
  if(url.pathname.startsWith("/static/")){
    e.respondWith(fetch(req).then((r)=>{if(r.ok)caches.open(CACHE).then((c)=>c.put(req,r.clone()));return r;}).catch(()=>caches.match(req)));
    return;
  }
  if(req.mode==="navigate"){e.respondWith(fetch(req).catch(()=>caches.match("/offline.html")));}
});
