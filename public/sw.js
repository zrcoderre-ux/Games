/* BONHOMME Service Worker
   Strategy:
   - App code (pages, app.js, local.js, tutorial.js, styles.css): always
     network-first with cache fallback, so a deploy is picked up on the next
     load and the last good copy still runs offline (vs-bots play included)
   - Other static assets (images, icons): network-first on WiFi (or connection
     type unknown/fast); cache-first with background refresh on cellular / slow
   - Same-origin requests are cached by PATH: the ?v= cache-busters index.html
     and app.js put on their URLs never strand the precached copy, and each
     path keeps a single entry. Page navigations (/?game=…&room=…) fall back
     to the cached "/".
   - Server routes (/parties/…, /gamelog…) and no-store responses are never
     touched or cached.
*/

const CACHE = "bonhomme-v4";

const PRECACHE = [
  "/",
  "/styles.css",
  "/app.js",
  "/local.js",
  "/tutorial.js",
  "/manifest.json",
  "/favicon.svg",
  "/joker-hat.png",
  "/joker-card.webp",
  "/bonhomme-card.webp",
  "/joker-silhouette.png",
  "/low-signal.webp",
  "/medium-signal.webp",
  "/high-signal.webp",
  "/Hat 180x180.png",
  "/Hat Manifest.png",
  "/icon.svg",
];

// App code is always fetched fresh when the network is there.
const CODE = new Set(["/", "/index.html", "/app.js", "/local.js", "/tutorial.js", "/styles.css"]);

// ── Install: cache all static assets ──────────────────────────────────────────
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // cache:"reload" skips the HTTP cache so a new worker never precaches stale files
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clear old caches, claim clients ──────────────────────────────────
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ──────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (e) => {
  const { request } = e;

  // Only handle GET requests for our own origin (pass WebSocket / API calls through)
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Don't intercept the worker's own routes (rooms, game log) — always live
  const p = url.pathname;
  if (p.startsWith("/parties/") || p === "/gamelog" || p.startsWith("/gamelog/")) return;

  const navigate = request.mode === "navigate";
  // One cache entry per path; "/" and "/index.html" are the same page.
  const key = navigate && (p === "/" || p === "/index.html") ? "/" : url.origin + p;
  const fresh = navigate || CODE.has(p) || !isSlow();
  e.respondWith(fresh ? networkFirst(request, key, navigate) : cacheFirst(request, key, navigate));
});

// ── Connection check ──────────────────────────────────────────────────────────
function isSlow() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return false; // unknown → assume fast (iOS Safari)
  if (!navigator.onLine) return true;
  // effectiveType: 'slow-2g' | '2g' | '3g' | '4g'
  if (conn.effectiveType && (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g")) return true;
  // type: 'wifi' | 'ethernet' | 'cellular' | 'none' | 'unknown' | 'other' | 'bluetooth' | 'wimax'
  if (conn.type === "cellular") return true;
  return false;
}

// Worth keeping: a complete same-origin 200 the server didn't mark no-store. A
// redirected response is skipped — a page answered with one fails to load.
function cacheable(response) {
  return response.ok && response.type === "basic" && !response.redirected &&
    !/no-store/i.test(response.headers.get("cache-control") || "");
}

async function fromCache(cache, key, navigate) {
  return (await cache.match(key)) ||
    (navigate ? await cache.match("/") : undefined) ||
    new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
}

// ── Network-first: fetch fresh, update cache, fall back to cache ─────────────
async function networkFirst(request, key, navigate) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (cacheable(response)) cache.put(key, response.clone());
    return response;
  } catch {
    return fromCache(cache, key, navigate);
  }
}

// ── Cache-first (cellular/slow): serve cache, revalidate in background ────────
async function cacheFirst(request, key, navigate) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached) {
    // Background revalidate so cache stays warm for next WiFi visit
    fetch(request).then((r) => { if (cacheable(r)) cache.put(key, r); }).catch(() => {});
    return cached;
  }
  // Nothing cached — try network anyway
  try {
    const response = await fetch(request);
    if (cacheable(response)) cache.put(key, response.clone());
    return response;
  } catch {
    return fromCache(cache, key, navigate);
  }
}
