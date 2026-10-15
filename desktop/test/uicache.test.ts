/**
 * Screens from the server, with an offline copy (docs/DESKTOP.md §4.3): the source choice, the manifest checks (a bad
 * sha256 is rejected), the atomic swap and the last-2 rule, the origin rule, the settings migration and the offline
 * fallback, against a fake studio server. Also the gateway serving several build folders.
 *
 * Deterministic: every test has its own temp folder, its own fake server and its own copy of the app's UI; nothing is
 * shared between tests; "offline" is a fetch that fails (no port juggling); no fixed sleeps; corruption is detected by
 * content (an explicit, clearly different modification time for the quick check, and a full check with the time put
 * back), never by the file system's time resolution.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, writeFileSync, type Stats } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Config, defaultSettings, migrateSettings, sanitize } from "../src/main/config.ts";
import { Gateway, type OfflineStore } from "../src/main/gateway.ts";
import { Mirror } from "../src/main/mirror.ts";
import { chooseServing, compareVersions, originRule, safeRelPath, serverKey, UiCache, uiLabel, validateManifest, type UiManifest } from "../src/main/uicache.ts";
import type { UiSource, UiStatus } from "../src/shared/types.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-ui-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
/** A temp folder of its own for every test. */
const fresh = (name: string) => mkdtempSync(path.join(tmp, `${name}-`));

/**
 * Damages a cached file in place through one handle: what it was (the handle's stat), the new bytes, then the times
 * `stamp` picks from the old stat. One handle, so the file looked at is the file changed.
 */
async function damage(f: string, text: string, stamp: (was: Stats) => [Date, Date]): Promise<void> {
  const fh = await fsp.open(f, "r+");
  try {
    const was = await fh.stat();
    await fh.truncate(0);
    await fh.write(text, 0, "utf8");
    const [atime, mtime] = stamp(was);
    await fh.utimes(atime, mtime);
  } finally {
    await fh.close();
  }
}

interface FakeBuild { files: Record<string, string>; requires?: string; lie?: string }
const B1: FakeBuild = { files: { "index.html": "<!doctype html><title>b1</title>", "assets/app-1111.js": "console.log('b1')", "assets/shared-aaaa.js": "export const shared = 1;" } };
const B2: FakeBuild = { files: { "index.html": "<!doctype html><title>b2</title>", "assets/app-2222.js": "console.log('b2')", "assets/shared-aaaa.js": "export const shared = 1;" } };
const B3: FakeBuild = { files: { "index.html": "<!doctype html><title>b3</title>", "assets/app-3333.js": "console.log('b3')" } };

function manifestOf(b: FakeBuild): UiManifest {
  const files = Object.entries(b.files).map(([p, c]) => ({ path: p, size: Buffer.byteLength(c), sha256: sha(c) }));
  return { build: sha(b.files["index.html"]).slice(0, 12), version: "3.1.0", built_at: "2026-10-12T10:00:00Z", requires_desktop: b.requires ?? "3.0.0", files };
}

/** The copy of the screens inside the app, in a folder of its own. */
function makeBundled(root: string): string {
  const dir = path.join(root, "bundled");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>bundled</title>");
  writeFileSync(path.join(dir, "assets", "shared-aaaa.js"), "export const shared = 1;");
  writeFileSync(path.join(dir, "assets", "only-bundled-1.js"), "bundled only");
  return dir;
}

/** A fake studio server with a switchable build. `down` makes every request fail like a server that's gone. */
async function fakeServer(initial: FakeBuild) {
  const st = { build: initial, hits: [] as string[], down: false };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || "/").split("?")[0]);
    st.hits.push(u);
    if (u === "/api/ui/manifest") {
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify(manifestOf(st.build)));
      return;
    }
    const rel = u.replace(/^\//, "");
    if (rel in st.build.files) {
      const body = st.build.lie === rel ? `${st.build.files[rel]}/* tampered */` : st.build.files[rel];
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": Buffer.byteLength(body), Connection: "close" });
      res.end(body);
      return;
    }
    res.writeHead(404, { Connection: "close" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchImpl: typeof fetch = (input, init) => (st.down
    ? Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))
    : fetch(input, init));
  const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return { st, url, fetchImpl, close };
}
type Fake = Awaited<ReturnType<typeof fakeServer>>;

function cache(root: string, srv: Pick<Fake, "url" | "fetchImpl">, bundled: string, opts: { setting?: UiSource; appVersion?: string; onStatus?(s: UiStatus): void; url?: string } = {}) {
  return new UiCache({ root: path.join(root, "ui-cache"), appVersion: opts.appVersion ?? "3.1.0", serverUrl: () => opts.url ?? srv.url, setting: () => opts.setting ?? "auto",
    bundledDir: () => bundled, onStatus: opts.onStatus, timeoutMs: 20_000, fetchImpl: srv.fetchImpl });
}

/** One test's world: a temp folder, a fake server, the app's own copy. */
async function world(name: string, first: FakeBuild) {
  const root = fresh(name);
  const srv = await fakeServer(first);
  const bundled = makeBundled(root);
  return { root, srv, bundled, serverDir: () => path.join(root, "ui-cache", serverKey(srv.url)) };
}

// ── pure rules ──
test("origin rule: https anywhere, http only on loopback and private networks", () => {
  for (const ok of ["https://studio.example.com", "http://127.0.0.1:8100", "http://127.0.0.2", "http://localhost:8100", "http://[::1]:8100",
    "http://10.1.2.3", "http://172.16.0.9", "http://172.31.255.1", "http://192.168.1.20:8100", "http://studio.local", "http://[fd12:3456::1]"]) {
    assert.equal(originRule(ok).ok, true, ok);
  }
  for (const bad of ["http://studio.example.com", "http://8.8.8.8", "http://172.32.0.1", "http://11.0.0.1", "http://[2001:db8::1]", "ftp://10.0.0.1", "nonsense"]) {
    const r = originRule(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.reason, bad);
  }
});

test("versions compare numerically", () => {
  assert.equal(compareVersions("3.0.0", "3.0.0"), 0);
  assert.equal(compareVersions("3.10.0", "3.9.9"), 1);
  assert.equal(compareVersions("3.1", "3.1.1"), -1);
  assert.equal(compareVersions("4.0.0-beta.1", "3.9.0"), 1);
});

test("manifest checks: paths stay inside, hashes are hex, index.html names the build", () => {
  const good = manifestOf(B1);
  assert.equal(validateManifest(good).build, good.build);
  for (const p of ["../evil.js", "/abs.js", "a\\b.js", "C:/x.js", "a/../../b", "a//b", ".tatvam-build.json"]) assert.equal(safeRelPath(p), false, p);
  assert.throws(() => validateManifest({ ...good, files: [...good.files, { path: "../x", size: 1, sha256: "0".repeat(64) }] }), /Unsafe path/);
  assert.throws(() => validateManifest({ ...good, files: good.files.map((f) => ({ ...f, sha256: "xyz" })) }), /Bad sha256/);
  assert.throws(() => validateManifest({ ...good, build: "deadbeefdead" }), /hash of index.html/);
  assert.throws(() => validateManifest({ ...good, files: good.files.filter((f) => f.path !== "index.html") }), /no index.html/);
});

test("source choice", () => {
  const base = { originOk: true, cached: true, bundled: true };
  assert.equal(chooseServing({ setting: "auto", ...base }), "cache");
  assert.equal(chooseServing({ setting: "auto", ...base, cached: false }), "bundled");
  assert.equal(chooseServing({ setting: "auto", ...base, originOk: false }), "bundled");
  assert.equal(chooseServing({ setting: "auto", ...base, envUiDir: true }), "bundled");
  assert.equal(chooseServing({ setting: "auto", originOk: true, cached: false, bundled: false }), "remote");
  assert.equal(chooseServing({ setting: "bundled", ...base }), "bundled");
  assert.equal(chooseServing({ setting: "server", ...base }), "remote");
  assert.equal(uiLabel({ serving: "cache", build: "3f2a9c112233", builtAt: "2026-10-12T10:00:00Z", online: true, appVersion: "3.1.0" }), "Server build 3f2a9c, 12 Oct");
  assert.equal(uiLabel({ serving: "cache", build: "3f2a9c112233", online: false, appVersion: "3.1.0" }), "Offline copy of server build 3f2a9c");
  assert.equal(uiLabel({ serving: "bundled", online: true, appVersion: "3.1.0" }), "Built into the app 3.1.0");
});

test("migration: server screens are opt-in; an unchosen auto or server moves to bundled, a chosen one stays", () => {
  assert.deepEqual(migrateSettings({ uiSource: "auto" }), { value: { uiSource: "bundled" }, migrated: true });
  assert.deepEqual(migrateSettings({ uiSource: "server" }), { value: { uiSource: "bundled" }, migrated: true });
  assert.equal(migrateSettings({ uiSource: "auto", uiSourceChosen: true }).migrated, false);
  assert.equal(migrateSettings({ uiSource: "bundled" }).migrated, false);
  const docs = fresh("docs");
  const d = defaultSettings({ documents: docs, env: {} });
  assert.equal(d.uiSource, "bundled");
  assert.equal(sanitize({ uiSource: "auto" }, d).uiSource, "auto");
  // a settings.json from the weeks when "auto" was written as the default
  const ud = fresh("ud-migrate");
  writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ serverUrl: "http://localhost:8100", uiSource: "auto", libraryRoot: "D:\\Lib" }));
  const c = new Config(ud, docs, {});
  assert.equal(c.get().uiSource, "bundled");
  assert.equal(JSON.parse(readFileSync(path.join(ud, "settings.json"), "utf8")).uiSource, "bundled"); // saved back
  assert.equal(c.get().libraryRoot, "D:\\Lib");
  c.set({ uiSource: "auto", uiSourceChosen: true });
  assert.equal(new Config(ud, docs, {}).get().uiSource, "auto"); // a choice survives the next start
  assert.equal(c.get().appearance.theme, "dark");
  assert.equal(c.set({ appearance: { scale: 133 } as never }).appearance.scale, 135);
});

// ── the cache against a fake server ──
test("fetch, verify and serve a server build; reuse files it already has", async () => {
  const w = await world("fetch", B1);
  try {
    const seen: UiStatus[] = [];
    const c = cache(w.root, w.srv, w.bundled, { onStatus: (s) => seen.push(s) });
    await c.init();
    assert.equal(c.status().serving, "bundled");
    w.srv.st.hits.length = 0;
    const s = await c.check("test");
    assert.equal(s.serving, "cache", JSON.stringify(s));
    assert.equal(s.build, manifestOf(B1).build);
    assert.match(s.label, /^Server build [0-9a-f]{6}, 12 Oct$/);
    assert.equal(w.srv.st.hits.includes("/assets/shared-aaaa.js"), false, "the shared file is copied from the app's own copy");
    const dir = path.join(w.serverDir(), manifestOf(B1).build);
    assert.deepEqual(c.dirs(), [dir, w.bundled]);
    assert.equal(readFileSync(path.join(dir, "assets", "app-1111.js"), "utf8"), "console.log('b1')");
    assert.ok(seen.some((x) => x.checking));
    // nothing new: a second check downloads nothing
    w.srv.st.hits.length = 0;
    await c.check("again");
    assert.deepEqual(w.srv.st.hits, ["/api/ui/manifest"]);
  } finally { await w.srv.close(); }
});

test("a file whose sha256 doesn't match is rejected and nothing is swapped in", async () => {
  const w = await world("reject", B1);
  try {
    const c = cache(w.root, w.srv, w.bundled);
    await c.init();
    await c.check();
    const b1 = manifestOf(B1).build;
    w.srv.st.build = { ...B2, lie: "assets/app-2222.js" };
    const s = await c.check();
    assert.match(s.lastError ?? "", /doesn't match the manifest.*rejected/);
    assert.equal(s.build, b1, "still on the last good build");
    assert.deepEqual(readdirSync(w.serverDir()).filter((n) => n.startsWith(".tmp-")), [], "the temporary folder is gone");
    assert.equal(existsSync(path.join(w.serverDir(), manifestOf(B2).build)), false);
    w.srv.st.build = B2;
    assert.equal((await c.check()).build, manifestOf(B2).build);
  } finally { await w.srv.close(); }
});

test("atomic swap: the pointer moves only after the new folder is complete; the last 2 builds are kept", async () => {
  const w = await world("swap", B1);
  try {
    const c = cache(w.root, w.srv, w.bundled);
    await c.init();
    assert.equal((await c.check()).build, manifestOf(B1).build);
    w.srv.st.build = B2;
    assert.equal((await c.check()).build, manifestOf(B2).build);
    const st = JSON.parse(readFileSync(path.join(w.serverDir(), "state.json"), "utf8"));
    assert.equal(st.active, manifestOf(B2).build);
    assert.deepEqual(st.builds.map((b: { build: string }) => b.build), [manifestOf(B2).build, manifestOf(B1).build]);
    // windows opened on b1 still get b1's assets after the switch
    assert.deepEqual(c.dirs(), [path.join(w.serverDir(), manifestOf(B2).build), path.join(w.serverDir(), manifestOf(B1).build), w.bundled]);
    w.srv.st.build = B3;
    assert.equal((await c.check()).build, manifestOf(B3).build); // the swap awaits the removal of builds beyond the last 2
    assert.equal(existsSync(path.join(w.serverDir(), manifestOf(B1).build)), false, "b1 dropped (keep 2)");
    assert.ok(existsSync(path.join(w.serverDir(), manifestOf(B2).build)));
    assert.ok(existsSync(path.join(w.serverDir(), manifestOf(B3).build, ".tatvam-build.json")));
    assert.deepEqual(readdirSync(w.serverDir()).filter((n) => n.startsWith(".tmp-")), []);
  } finally { await w.srv.close(); }
});

test("a build that needs a newer desktop app isn't fetched", async () => {
  const w = await world("requires", { ...B1, requires: "9.0.0" });
  try {
    const c = cache(w.root, w.srv, w.bundled);
    await c.init();
    const s = await c.check();
    assert.equal(s.serving, "bundled");
    assert.match(s.notice ?? "", /Update Tatvam Desktop to get the newest screens/);
    assert.deepEqual(w.srv.st.hits, ["/api/ui/manifest"], "no file was fetched");
  } finally { await w.srv.close(); }
});

test("not allowed origins stay on the copy inside the app, and say why", async () => {
  const w = await world("origin", B1);
  try {
    const c = cache(w.root, w.srv, w.bundled, { url: "http://studio.example.com" });
    await c.init();
    const s = await c.check();
    assert.equal(s.serving, "bundled");
    assert.equal(s.originOk, false);
    assert.match(s.originReason ?? "", /public address over plain http/);
    assert.deepEqual(c.dirs(), [w.bundled]);
    assert.deepEqual(w.srv.st.hits, [], "nothing was asked of that server");
  } finally { await w.srv.close(); }
});

test("a damaged cached file is caught and fetched again (quick check by size and time, full check by content)", async () => {
  const w = await world("damaged", B1);
  try {
    const c = cache(w.root, w.srv, w.bundled);
    await c.init();
    await c.check();
    const build = manifestOf(B1).build;
    const f = path.join(w.serverDir(), build, "assets", "app-1111.js");
    // 1. same size, different bytes, and a clearly different modification time: the quick check of every check() sees it
    await damage(f, "console.log('XX')", (recorded) => { const later = new Date(recorded.mtimeMs + 60_000); return [later, later]; });
    w.srv.st.hits.length = 0;
    const s = await c.check();
    assert.equal(s.lastError, undefined);
    assert.ok(w.srv.st.hits.includes("/assets/app-1111.js"), "re-downloaded");
    assert.equal(readFileSync(f, "utf8"), "console.log('b1')");
    // 2. damaged with its recorded time put back: only the content tells, and the full check (at start) finds it
    await damage(f, "console.log('YY')", (now) => [now.atime, now.mtime]);
    assert.deepEqual(await c.verify(build, true), ["assets/app-1111.js"]);
    const c2 = cache(w.root, w.srv, w.bundled);
    await c2.init(); // a fresh start verifies every sha256 of the active build
    assert.equal(c2.status().serving, "bundled", "a damaged copy isn't served");
    const back = await c2.check();
    assert.equal(back.serving, "cache");
    assert.equal(readFileSync(f, "utf8"), "console.log('b1')");
  } finally { await w.srv.close(); }
});

test("offline fallback: the saved server build keeps serving when the server is gone, also after a restart", async () => {
  const w = await world("offline", B1);
  try {
    const c = cache(w.root, w.srv, w.bundled);
    await c.init();
    await c.check();
    const b1 = manifestOf(B1).build;
    w.srv.st.down = true;
    const s = await c.check("timer");
    assert.equal(s.online, false);
    assert.equal(s.serving, "cache");
    assert.equal(s.label, `Offline copy of server build ${b1.slice(0, 6)}`);
    assert.match(s.lastError ?? "", /can't be reached/);
    assert.equal(c.dirs()?.[0], path.join(w.serverDir(), b1));
    // a fresh start with the server still down: the full check passes, the copy is served
    const c2 = cache(w.root, w.srv, w.bundled);
    await c2.init();
    c2.setOnline(false);
    assert.equal(c2.status().serving, "cache");
    assert.equal(c2.status().label, `Offline copy of server build ${b1.slice(0, 6)}`);
    assert.equal(c2.dirs()?.[0], path.join(w.serverDir(), b1));
    // the server is back: coming online starts a check (check() joins the one in flight)
    w.srv.st.down = false;
    c2.setOnline(true);
    const back = await c2.check("reconnect");
    assert.equal(back.online, true);
    assert.equal(back.serving, "cache");
    assert.equal(back.label, `Server build ${b1.slice(0, 6)}, 12 Oct`);
  } finally { await w.srv.close(); }
});

// ── the gateway serves the cache's folders ──
test("gateway in auto: index.html from the newest build, older builds still answer for assets", async () => {
  const root = fresh("gw");
  const bundled = makeBundled(root);
  const newer = path.join(root, "new"), older = path.join(root, "old");
  mkdirSync(path.join(newer, "assets"), { recursive: true });
  mkdirSync(path.join(older, "assets"), { recursive: true });
  writeFileSync(path.join(newer, "index.html"), "<title>new</title>");
  writeFileSync(path.join(newer, "assets", "app-new.js"), "new");
  writeFileSync(path.join(older, "index.html"), "<title>old</title>");
  writeFileSync(path.join(older, "assets", "app-old.js"), "old");
  writeFileSync(path.join(root, "secret.txt"), "secret");
  const mem = new Mirror(":memory:");
  const store: OfflineStore = { forProject: () => mem, all: () => [mem] };
  let dirs: string[] | null = [newer, older, bundled];
  let src: UiSource = "auto";
  const gw = new Gateway({ upstream: () => "http://127.0.0.1:9", uiDir: () => bundled, uiSource: () => src, uiDirs: () => dirs, store });
  const p = await gw.listen(20000 + Math.floor(Math.random() * 30000));
  const get = async (u: string) => { const r = await fetch(`http://127.0.0.1:${p}${u}`); return { status: r.status, text: await r.text(), cc: r.headers.get("cache-control") }; };
  try {
    assert.equal((await get("/p/1/edit")).text, "<title>new</title>");
    assert.equal((await get("/assets/app-old.js")).text, "old");
    assert.equal((await get("/assets/app-new.js")).cc, "public, max-age=31536000, immutable");
    assert.equal((await get("/assets/only-bundled-1.js")).text, "bundled only");
    assert.equal((await get("/assets/missing.js")).status, 404);
    assert.notEqual((await get("/..%2f..%2fsecret.txt")).text, "secret");
    assert.notEqual((await get("/assets/..%2f..%2f..%2fsecret.txt")).text, "secret");
    src = "bundled";
    assert.equal((await get("/")).text, "<!doctype html><title>bundled</title>");
    src = "auto"; dirs = [];
    assert.equal((await get("/")).text, "<!doctype html><title>bundled</title>", "no cache yet: the copy inside the app");
  } finally {
    await gw.close();
    mem.close();
  }
});
