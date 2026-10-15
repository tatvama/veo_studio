/* Tatvam Studio service worker.
 * - Install: precache the app shell (/index.html, manifest, icons) and every JS/CSS file of this build, so any page
 *   still opens offline. The list and the build id are injected by the build (vite.config.ts → serviceWorker()),
 *   which also makes this file change per build, so the browser installs the new worker and its new precache.
 * - /assets/* (hashed, immutable): cache-first; fonts, images and wasm are cached as they are first used.
 * - Page navigations: network-first, falling back to the cached app shell when offline.
 * - Activate: drop every cache that is not this build's (old builds' assets go in one sweep, no count-based trim
 *   that could evict the shell's own chunks).
 * - Never touches /api/*, /media/*, websockets or any non-GET request.
 */
const BUILD_ID = "__BUILD_ID__";
const BUILD_ASSETS = /* __BUILD_ASSETS__ */ [];
const VERSION = `veo-studio-${BUILD_ID}`;
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const SHELL_URL = "/index.html";
const PRECACHE = [SHELL_URL, "/manifest.webmanifest", "/favicon.svg", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => undefined)),
      // one failed file (a proxy hiccup) must not fail the install: that file is simply fetched on first use
      caches.open(ASSET_CACHE).then((cache) => Promise.all(BUILD_ASSETS.map((url) => cache.add(url).catch(() => undefined)))),
    ]).then(() => self.skipWaiting()),
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

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") await cache.put(request, res.clone());
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
