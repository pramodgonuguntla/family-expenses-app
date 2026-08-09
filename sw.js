// Service worker: keeps the app installable and usable offline, without ever
// pinning users to a stale build.
//
// Strategy is NETWORK-FIRST for the app shell. The previous version was
// cache-first under a fixed cache name, which meant a deployed change could
// never reach a device that had already opened the app: sw.js itself never
// changed, so the browser never reinstalled it, so the old app.js/styles.css
// were served forever and even a reload was intercepted. Network-first means
// a deploy is picked up on the next open, and the cache is only a fallback
// for when the device is actually offline.
const CACHE = "expenses-shell-v8";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./config.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never touch API calls to Apps Script — always straight to network.
  if (url.hostname.includes("script.google.com") || url.hostname.includes("googleusercontent.com")) return;
  if (e.request.method !== "GET") return;
  // Only manage our own origin; let anything else pass through untouched.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Refresh the cached copy so the next offline open is current.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        // Offline: fall back to cache, then to the shell for navigations.
        caches.match(e.request).then((cached) => {
          if (cached) return cached;
          if (e.request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
