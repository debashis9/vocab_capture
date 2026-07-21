// Service worker for Margin.
// Job in Phase 1: make the app installable and let the *shell* open offline.
// It deliberately does NOT cache dictionary lookups (those need the live network).

const CACHE = "margin-shell-v12";

// Files that make up the app shell.
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// On install: pre-cache the shell.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// On activate: drop old caches when we bump the version above.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// On fetch:
//  - same-origin GET  -> serve from cache, fall back to network (the app shell)
//  - everything else  -> just go to the network (the dictionary API, fonts, etc.)
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === "GET" && url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req))
    );
  }
  // else: default network behaviour, no interception
});
