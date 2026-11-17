const CACHE_NAME = "spendsnap-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./privacy.html",
  "./terms.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-120.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/config.js",
  "./js/image-utils.js",
  "./js/currency.js",
  "./js/gemini.js",
  "./js/google-sync.js",
  "./js/app.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only cache same-origin GET requests (never cache Google/Gemini/FX API calls)
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match("./index.html"))
      )
  );
});
