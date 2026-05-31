/* 旅行美食地圖 service worker
 * Strategies:
 *   - App shell (HTML/JS/CSS/icons + leaflet CDN): cache-first
 *   - stations.json: stale-while-revalidate
 *   - OSM tiles (*.tile.openstreetmap.org): cache-first + LRU 100MB cap
 *   - Photo storage (food-map-photos object/public): cache-first (immutable URLs)
 *   - Supabase REST/RPC: network-only (always fresh, may fail offline)
 */
const SW_VERSION = "v1.0.51-mobile-A+C";
const CACHE_SHELL  = `tfm-shell-${SW_VERSION}`;
const CACHE_DATA   = `tfm-data-${SW_VERSION}`;
const CACHE_TILES  = `tfm-tiles`;        // 不带版本，cross-deploy 持久
const CACHE_PHOTOS = `tfm-photos`;       // 不带版本，cross-deploy 持久

const TILE_CACHE_LIMIT_BYTES = 100 * 1024 * 1024; // 100MB
const TILE_LRU_CHECK_EVERY_N = 20;                 // 每 N 次 tile insert check size 一次

// App shell — minimal set; everything else falls through to runtime caches
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css",
  "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css",
  "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js",
  "https://unpkg.com/@supabase/supabase-js@2",
];

self.addEventListener("install", evt => {
  evt.waitUntil((async () => {
    const cache = await caches.open(CACHE_SHELL);
    // addAll 全部成功 or 全部 fail；分散 add 容忍個別失敗
    await Promise.allSettled(SHELL_ASSETS.map(u => cache.add(u).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", evt => {
  evt.waitUntil((async () => {
    // 刪除舊版本 shell / data caches；tiles + photos 保留
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k === CACHE_TILES || k === CACHE_PHOTOS) return null;
      if (k === CACHE_SHELL || k === CACHE_DATA) return null;
      if (k.startsWith("tfm-shell-") || k.startsWith("tfm-data-")) return caches.delete(k);
      return null;
    }));
    await self.clients.claim();
  })());
});

// helper: is OSM tile
function isOsmTile(url) {
  return /\.tile\.openstreetmap\.org\//.test(url.href);
}
// helper: is photo storage
function isPhotoStorage(url) {
  return /\/storage\/v1\/object\/public\/food-map-photos\//.test(url.href);
}
// helper: is Supabase API (REST / RPC / auth) — exclude storage which we cache separately
function isSupabaseApi(url) {
  return url.hostname.endsWith(".supabase.co")
      && !url.pathname.startsWith("/storage/v1/object/public/");
}
// helper: is stations.json
function isStationsJson(url) {
  return url.pathname.endsWith("/data/stations.json");
}

// LRU counter (in-memory; resets on SW restart but that's OK — we just check size periodically)
let tileInsertCounter = 0;

async function lruEvictTilesIfNeeded() {
  try {
    const est = await self.navigator.storage.estimate?.();
    // estimate is total origin storage; we use cache size as a proxy
    const cache = await caches.open(CACHE_TILES);
    const keys = await cache.keys();
    if (keys.length === 0) return;

    // Sum approximate sizes by fetching response sizes from headers (or by Content-Length)
    // Cheaper proxy: cap by entry count if size unknown
    // Estimate avg tile = 15KB → 100MB ≈ 6800 tiles
    const MAX_TILES = Math.floor(TILE_CACHE_LIMIT_BYTES / (15 * 1024));
    if (keys.length <= MAX_TILES) return;

    // delete oldest first — Cache API doesn't expose insert time, but keys() returns in insertion order
    const overflow = keys.length - MAX_TILES;
    for (let i = 0; i < overflow; i++) {
      await cache.delete(keys[i]);
    }
  } catch (e) {
    // ignore
  }
}

async function cacheFirstTile(req) {
  const cache = await caches.open(CACHE_TILES);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    // Note: leaflet sends tiles with crossOrigin='anonymous' → CORS mode. If CORS header missing,
    // resp.type === 'opaque' which still has status=0 but for OSM a/b/c.tile.openstreetmap.org
    // CORS headers exist. We cache resp.ok OR opaque (type='opaque' has ok=false, status=0).
    if (resp && (resp.ok || resp.type === 'opaque')) {
      // clone BEFORE returning; .then() ensures put completes before incrementing counter
      const clone = resp.clone();
      cache.put(req, clone).then(() => {
        tileInsertCounter++;
        if (tileInsertCounter % TILE_LRU_CHECK_EVERY_N === 0) {
          lruEvictTilesIfNeeded();
        }
      }).catch(() => {});
    }
    return resp;
  } catch (e) {
    // offline + not cached → return placeholder 1x1 transparent png
    return new Response(
      Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), c => c.charCodeAt(0)),
      { headers: { "Content-Type": "image/png" }, status: 200 }
    );
  }
}

async function cacheFirstPhoto(req) {
  const cache = await caches.open(CACHE_PHOTOS);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (e) {
    return new Response("", { status: 504, statusText: "offline" });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(resp => {
    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  }).catch(() => null);
  return cached || (await fetchPromise) || new Response("", { status: 504 });
}

// network-first: try network, fall back to cache on failure.
// Used for app shell (index.html / app.js / sw.js / config.js) so updates
// take effect on next reload without waiting for SW lifecycle.
async function networkFirstShell(req) {
  const cache = await caches.open(CACHE_SHELL);
  try {
    const resp = await fetch(req);
    if (resp && resp.ok && req.method === "GET") {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === "navigate") {
      const idx = await cache.match("./index.html") || await cache.match("./");
      if (idx) return idx;
    }
    return new Response("offline", { status: 504 });
  }
}

async function cacheFirstShell(req) {
  const cache = await caches.open(CACHE_SHELL);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp && resp.ok && (req.method === "GET")) {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (e) {
    if (req.mode === "navigate") {
      const idx = await cache.match("./index.html") || await cache.match("./");
      if (idx) return idx;
    }
    return new Response("offline", { status: 504 });
  }
}

function isAppShellAsset(url) {
  // same-origin HTML / JS / CSS / manifest are app shell — must always be fresh
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  return /\.(html?|js|css|webmanifest)$/i.test(p) || p === "/" || p.endsWith("/travel-food-map/");
}

self.addEventListener("fetch", evt => {
  const req = evt.request;
  if (req.method !== "GET") return; // 只 cache GET
  const url = new URL(req.url);

  // OSM tiles → cache-first + LRU
  if (isOsmTile(url)) {
    evt.respondWith(cacheFirstTile(req));
    return;
  }
  // Photos → cache-first (immutable storage paths)
  if (isPhotoStorage(url)) {
    evt.respondWith(cacheFirstPhoto(req));
    return;
  }
  // Supabase API → network-only (no cache) — let the browser default handle
  if (isSupabaseApi(url)) {
    return; // do not respondWith → falls through to network
  }
  // stations.json → stale-while-revalidate
  if (isStationsJson(url)) {
    evt.respondWith(staleWhileRevalidate(req, CACHE_DATA));
    return;
  }
  // App shell (same-origin HTML/JS/CSS) → network-first so updates land immediately
  if (req.mode === "navigate" || isAppShellAsset(url)) {
    evt.respondWith(networkFirstShell(req));
    return;
  }
  // CDN deps (leaflet etc) → cache-first (versioned, safe to cache hard)
  evt.respondWith(cacheFirstShell(req));
});

// 接收 client message: 用嚟 manual clear cache or get cache info
self.addEventListener("message", evt => {
  const msg = evt.data;
  if (!msg || !msg.type) return;
  if (msg.type === "GET_CACHE_INFO") {
    (async () => {
      const tilesCache = await caches.open(CACHE_TILES);
      const tilesKeys = await tilesCache.keys();
      const photosCache = await caches.open(CACHE_PHOTOS);
      const photosKeys = await photosCache.keys();
      const est = await self.navigator.storage.estimate?.();
      evt.source.postMessage({
        type: "CACHE_INFO",
        tilesCount: tilesKeys.length,
        photosCount: photosKeys.length,
        estimate: est ? { usage: est.usage, quota: est.quota } : null,
        version: SW_VERSION,
      });
    })();
  } else if (msg.type === "CLEAR_TILES") {
    caches.delete(CACHE_TILES).then(() => evt.source.postMessage({ type: "TILES_CLEARED" }));
  } else if (msg.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
