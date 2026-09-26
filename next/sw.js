// Network-first for the app files, cache as the offline fallback -- a deploy
// reaches phones on the next open, and the app still opens with no signal.
// Data never goes through here: it lives in the page's own storage.
const CACHE = "expenses-next-v2";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json", "../config.js", "../icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("expenses-next-") && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    // no-cache: always ask GitHub whether the file changed (cheap 304 if not),
    // instead of reusing a copy for up to 10 minutes after a push.
    fetch(e.request.mode === "navigate" ? e.request.url : e.request, { cache: "no-cache" })
      .then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
