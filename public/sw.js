/* BONHOMME Service Worker
   Strategy:
   - WiFi (or connection type unknown/fast): network-first with cache fallback
   - Cellular / slow / offline: cache-first with network fallback
   - Static assets are cached on install; cache is updated on network-first hits
*/

const CACHE = "bonhomme-v2";

const PRECACHE = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/tutorial.js",
  "/manifest.json",
  "/favicon.svg",
  "/joker-hat.png",
  "/joker-card.webp",
  "/bonhomme-card.webp",
  "/low-signal.webp",
  "/medium-signal.webp",
  "/high-signal.webp",
  "/Hat 180x180.png",
  "/Hat Manifest.png",
  "/icon.svg",
];

// ── Install: cache all static assets ──────────────────────────────────────────
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
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
  // Don't intercept Cloudflare worker API paths (non-page/asset requests)
  if (url.pathname.startsWith("/party/") || url.pathname.startsWith("/api/")) return;

  e.respondWith(isWifi() ? networkFirst(request) : cacheFirst(request));
});

// ── Connection check ──────────────────────────────────────────────────────────
function isWifi() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return true; // unknown → assume fast (iOS Safari)
  if (!navigator.onLine) return false;
  // effectiveType: 'slow-2g' | '2g' | '3g' | '4g'
  if (conn.effectiveType && (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g")) return false;
  // type: 'wifi' | 'ethernet' | 'cellular' | 'none' | 'unknown' | 'other' | 'bluetooth' | 'wimax'
  if (conn.type === "cellular") return false;
  return true;
}

// ── Network-first (WiFi): fetch fresh, update cache, fall back to cache ────────
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return cache.match(request) || new Response("Offline", { status: 503 });
  }
}

// ── Cache-first (cellular/offline): serve cache, revalidate in background ─────
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // Background revalidate so cache stays warm for next WiFi visit
    fetch(request).then((r) => { if (r.ok) cache.put(request, r); }).catch(() => {});
    return cached;
  }
  // Nothing cached — try network anyway
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}
