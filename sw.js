// Service worker for Margin.
// Job in Phase 1: make the app installable and let the *shell* open offline.
// It deliberately does NOT cache dictionary lookups (those need the live network).

const CACHE = "margin-shell-v47";

// Files that make up the app shell.
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  // Versioned filenames on purpose. Android bakes the icon into a WebAPK at
  // install time and decides whether to regenerate by diffing the manifest --
  // including icon URLs. Replacing the bytes behind an unchanged filename is
  // invisible to that check, so a new icon can take days to appear or never
  // land at all. Change the suffix whenever the artwork changes.
  "./icons/icon-192-v3.png",
  "./icons/icon-512-v3.png",
  "./icons/icon-maskable-512-v3.png",
];

// The one cross-origin file the app shell can't start without -- without
// this cached, nothing in the app (not even an already-signed-in session)
// can initialize offline, since Supabase's own client object never exists.
// Pinned to an exact version (not the floating @2 tag index.html used to
// use) so this literal URL always matches index.html's <script src> exactly
// -- caches.match() is exact-URL, so if these two ever drifted apart the
// cached copy would simply never be found. Keep both in sync if bumped.
const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0";

// On install: pre-cache the shell. Each file is fetched with {cache: "reload"}
// to bypass the browser's own HTTP cache -- plain caches.addAll(SHELL) fetches
// normally, so a stale HTTP-cached index.html could get pulled into a brand
// new CACHE bucket even though the version name itself is fresh. That's what
// caused the admin-badge fix to not show up under the "v22" cache on 2026-08-02.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all([...SHELL, SUPABASE_SDK_URL].map((url) =>
        fetch(url, { cache: "reload" }).then((res) => c.put(url, res))
      ))
    ).then(() => self.skipWaiting())
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
//  - same-origin GET       -> serve from cache, fall back to network (the app shell)
//  - the pinned Supabase SDK URL, exactly -> same cache-first treatment, so
//    the app can initialize offline
//  - everything else cross-origin -> just go to the network (the dictionary
//    API, the AI Worker, fonts, etc.) -- never cached
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === "GET" && url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req))
    );
    return;
  }

  if (req.method === "GET" && req.url === SUPABASE_SDK_URL) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req))
    );
    return;
  }
  // else: default network behaviour, no interception
});
