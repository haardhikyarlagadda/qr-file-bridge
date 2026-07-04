// sw.js — caches the entire app (including CDN libraries and fonts) on first
// load so every subsequent use works fully offline: both devices can be in
// airplane mode and the transfer still runs end to end.

const CACHE = "qrfb-v3";

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

// Cache-first: once installed, the network is never required again.
self.addEventListener("fetch", (e) => {
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
