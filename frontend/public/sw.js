/* VEO Studio service worker.
 * - /assets/* (hashed build files): cache-first.
 * - Page navigations: network-first, falling back to the cached app shell (/index.html) when offline.
 * - Never touches /api/*, /media/*, websockets or any non-GET request.
 * Bump VERSION to drop old caches on the next activation.
 */
const VERSION = "veo-studio-v2.1";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const SHELL_URL = "/index.html";
const PRECACHE = [SHELL_URL, "/manifest.webmanifest", "/favicon.svg", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(`${VERSION}-`)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function bypass(request, url) {
  if (request.method !== "GET") return true;
  if (url.origin !== self.location.origin) return true;
  if (request.headers.get("upgrade") === "websocket") return true;
  const p = url.pathname;
  return p.startsWith("/api/") || p === "/api" || p.startsWith("/media/") || p === "/media" || p.startsWith("/ws") || p.startsWith("/api/ws");
}

async function networkFirstPage(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok && res.type === "basic" && (res.headers.get("content-type") || "").includes("text/html")) {
      cache.put(SHELL_URL, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    throw err;
  }
}

const MAX_ASSETS = 120; // hashed files from old builds pile up; keep the newest N

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") {
    await cache.put(request, res.clone());
    trim(cache);
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (bypass(request, url)) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstAsset(request));
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
