// sw.js — caches the entire app (including CDN libraries and fonts) on first
// load so every subsequent use works fully offline: both devices can be in
// airplane mode and the transfer still runs end to end.

const CACHE = "qrfb-v8";

const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/main.js",
  "./js/sender.js",
  "./js/receiver.js",
  "./js/frame.js",
  "./js/crypto.js",
  "./js/base45.js",
  "./js/camera.js",
  "./manifest.webmanifest",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Navigations are network-first (so a deploy is picked up on the next load,
// with the cache as offline fallback). Everything else stays cache-first so
// transfers keep working fully offline once installed.
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          // Opportunistically cache same-origin and CDN GETs (e.g. fonts).
          if (e.request.method === "GET" && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});
