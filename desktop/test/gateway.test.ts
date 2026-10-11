import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { Gateway, parseRange, type OfflineStore } from "../src/main/gateway.ts";
import { Mirror } from "../src/main/mirror.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-gw-"));
const ui = path.join(tmp, "ui");
mkdirSync(path.join(ui, "assets"), { recursive: true });
writeFileSync(path.join(ui, "index.html"), "<!doctype html><div id=\"root\"></div>");
writeFileSync(path.join(ui, "assets", "app-1234.js"), "console.log(1)");
writeFileSync(path.join(tmp, "secret.txt"), "secret");
const localFile = path.join(tmp, "local.mp4");
writeFileSync(localFile, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));

// ── a fake studio server ──
let upPort = 0;
let layersRev = 5;
const received: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const json = (status: number, v: unknown, h: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...h });
      res.end(JSON.stringify(v));
    };
    const u = req.url!;
    if (u === "/api/health/live") return json(200, { ok: true });
    if (u === "/api/auth/setup") {
      return json(200, { user: { id: 1 } }, { "Set-Cookie": ["veo_session=tok123; Domain=localhost; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600"] });
    }
    if (u.startsWith("/api/echo")) return json(200, { host: req.headers.host, cookie: req.headers.cookie, range: req.headers.range, origin: req.headers.origin });
    if (u === "/api/redirect") { res.writeHead(302, { Location: `http://127.0.0.1:${upPort}/p/1/edit` }); return res.end(); }
    if (u === "/api/episodes/3") return json(200, { id: 3, shots: [{ id: 1, order: 1, include: true, trim_in: 0 }, { id: 2, order: 2, include: true }] });
    if (u === "/api/episodes/3/layers" && req.method === "GET") return json(200, { rev: layersRev, video: [], audio: [], holds: {}, media: [] });
    if (u === "/api/episodes/3/layers" && req.method === "PUT") {
      const b = JSON.parse(body);
      if (b.rev !== layersRev) return json(409, { detail: "changed" });
      layersRev++;
      return json(200, { rev: layersRev });
    }
    if (u === "/api/shots/1" && req.method === "PATCH") return json(200, { id: 1, ...JSON.parse(body) });
    if (u.startsWith("/media/")) return json(200, { from: "upstream", range: req.headers.range ?? null });
    json(404, { detail: "nope" });
  });
});
const wss = new WebSocketServer({ noServer: true });
let wsCookie: string | undefined;
upstream.on("upgrade", (req, socket, head) => {
  wsCookie = req.headers.cookie;
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: "presence", url: req.url }));
    ws.on("message", (m) => ws.send(`echo:${m}`));
  });
});

const mem = new Mirror(":memory:");
const store: OfflineStore = { forProject: () => mem, all: () => [mem] };
const gw = new Gateway({
  upstream: () => `http://127.0.0.1:${upPort}`,
  uiDir: () => ui,
  uiSource: () => "bundled",
  resolveMedia: (key) => (key === "projects/1/shots/1/video/local.mp4" ? localFile : null),
  store,
  getCookie: async () => "veo_session=tok123",
  healthIntervalMs: 100,
  connectTimeoutMs: 2000,
});
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();

function listenUpstream(port = 0): Promise<void> {
  return new Promise((r) => upstream.listen(port, "127.0.0.1", () => { upPort = (upstream.address() as AddressInfo).port; r(); }));
}
function closeUpstream(): Promise<void> {
  return new Promise((r) => { upstream.close(() => r()); upstream.closeAllConnections(); });
}

before(async () => {
  await listenUpstream();
  await gw.listen(0);
  base = gw.url;
});
after(async () => {
  await gw.close();
  if (upstream.listening) await closeUpstream();
  wss.close();
  mem.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("parseRange", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=990-2000", 1000), { start: 990, end: 999 });
  assert.equal(parseRange("bytes=2000-", 1000), "invalid");
  assert.equal(parseRange(undefined, 1000), null);
});

test("static UI with SPA fallback, MIME types and caching", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/html/);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.match(await r.text(), /id="root"/);
  const js = await fetch(`${base}/assets/app-1234.js`);
  assert.match(js.headers.get("content-type")!, /text\/javascript/);
  assert.match(js.headers.get("cache-control")!, /immutable/);
  const spa = await fetch(`${base}/p/12/finish?episode=3`);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /id="root"/);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  const trav = await fetch(`${base}/..%2Fsecret.txt`);
  assert.notEqual(await trav.text(), "secret");
  assert.equal((await fetch(`${base}/__desktop/anything`)).status, 404);
});

test("API forwarding: Host, cookie, Range and Origin; Set-Cookie and Location rewritten", async () => {
  const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}" });
  assert.equal(setup.status, 200);
  const sc = setup.headers.getSetCookie();
  assert.equal(sc.length, 1);
  assert.equal(sc[0], "veo_session=tok123; Path=/; HttpOnly; SameSite=Lax; Max-Age=600");
  const echo = await json(await fetch(`${base}/api/echo?x=1`, { headers: { Cookie: "veo_session=tok123", Range: "bytes=5-9", Origin: base } }));
  assert.equal(echo.host, `127.0.0.1:${upPort}`);
  assert.equal(echo.cookie, "veo_session=tok123");
  assert.equal(echo.range, "bytes=5-9");
  assert.equal(echo.origin, `http://127.0.0.1:${upPort}`);
  const red = await fetch(`${base}/api/redirect`, { redirect: "manual" });
  assert.equal(red.status, 302);
  assert.equal(red.headers.get("location"), `${base}/p/1/edit`);
  const wrongHost = await new Promise<number>((resolve) => {
    http.get({ host: "127.0.0.1", port: gw.port, path: "/api/echo", headers: { Host: "evil.example:80" } }, (res) => { res.resume(); resolve(res.statusCode!); });
  });
  assert.equal(wrongHost, 421);
});

test("local-first media with Range, ETag and the session check", async () => {
  const key = "/media/projects/1/shots/1/video/local.mp4";
  const r = await fetch(`${base}${key}`, { headers: { Cookie: "veo_session=tok123", Range: "bytes=10-19" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 10-19/1000");
  assert.equal(r.headers.get("content-type"), "video/mp4");
  const bytes = new Uint8Array(await r.arrayBuffer());
  assert.deepEqual([...bytes], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const etag = r.headers.get("etag")!;
  assert.ok(etag);
  const full = await fetch(`${base}${key}`, { headers: { Cookie: "veo_session=tok123" } });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-length"), "1000");
  await full.arrayBuffer();
  const nm = await fetch(`${base}${key}`, { headers: { Cookie: "veo_session=tok123", "If-None-Match": etag } });
  assert.equal(nm.status, 304);
  const bad = await fetch(`${base}${key}`, { headers: { Cookie: "veo_session=tok123", Range: "bytes=5000-" } });
  assert.equal(bad.status, 416);
  // without the app's session the local copy isn't served: the request goes to the server
  const anon = await fetch(`${base}${key}`, { headers: { Range: "bytes=0-1" } });
  assert.deepEqual(await anon.json(), { from: "upstream", range: "bytes=0-1" });
  const remote = await fetch(`${base}/media/projects/1/other.mp4`, { headers: { Cookie: "veo_session=tok123" } });
  assert.equal((await json(remote)).from, "upstream");
});

test("WebSocket upgrade is forwarded with the cookie", async () => {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws?project_id=1`, { headers: { Cookie: "veo_session=tok123" } });
  const msgs: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (m) => {
      msgs.push(String(m));
      if (msgs.length === 1) ws.send("hi");
      if (msgs.length === 2) resolve();
    });
    ws.on("error", reject);
  });
  ws.close();
  assert.equal(JSON.parse(msgs[0]).url, "/api/ws?project_id=1");
  assert.equal(msgs[1], "echo:hi");
  assert.equal(wsCookie, "veo_session=tok123");
  // only /api/ws upgrades
  const other = new WebSocket(`${base.replace("http", "ws")}/api/other`);
  await new Promise<void>((resolve) => { other.on("error", () => resolve()); other.on("close", () => resolve()); });
});

test("offline: cached GETs answer, cut edits queue with an optimistic cache, replay on reconnect", async () => {
  const headers = { Cookie: "veo_session=tok123", "Content-Type": "application/json", "X-Requested-With": "veo-studio", Referer: `${base}/p/1/edit` };
  assert.equal((await fetch(`${base}/api/episodes/3`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/episodes/3/layers`, { headers })).status, 200);
  const port = upPort;
  await closeUpstream();
  const cached = await fetch(`${base}/api/episodes/3`, { headers });
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get("x-tatvam-offline"), "1");
  assert.equal(gw.online, false);
  const patch = await fetch(`${base}/api/shots/1`, { method: "PATCH", headers, body: JSON.stringify({ trim_in: 0.5 }) });
  assert.equal(patch.status, 202);
  const pj = await json(patch);
  assert.equal(pj.queued, true);
  assert.equal(pj.offline, true);
  assert.equal(pj.trim_in, 0.5);
  const lay = await fetch(`${base}/api/episodes/3/layers`, { method: "PUT", headers, body: JSON.stringify({ rev: 5, video: [], audio: [] }) });
  assert.equal(lay.status, 202);
  assert.equal((await json(lay)).rev, 6);
  const after = await json(await fetch(`${base}/api/episodes/3`, { headers }));
  assert.equal(after.shots[0].trim_in, 0.5);
  assert.equal((await fetch(`${base}/api/not-cached`, { headers })).status, 503);
  assert.equal((await fetch(`${base}/api/episodes/3/generate`, { method: "POST", headers, body: "{}" })).status, 503);
  assert.equal(gw.status().queued, 2);
  // someone else saved the layers meanwhile: the replay meets a 409, refetches the rev and retries once
  layersRev = 7;
  received.length = 0;
  await listenUpstream(port);
  await gw.flush();
  assert.equal(gw.online, true);
  assert.equal(gw.status().queued, 0);
  const replayed = received.filter((r) => r.method !== "GET");
  assert.deepEqual(replayed.map((r) => `${r.method} ${r.url}`), ["PATCH /api/shots/1", "PUT /api/episodes/3/layers", "PUT /api/episodes/3/layers"]);
  assert.equal(JSON.parse(replayed[2].body).rev, 7);
  assert.equal(replayed[0].headers.cookie, "veo_session=tok123");
  assert.equal(replayed[0].headers["x-requested-with"], "veo-studio");
  assert.equal(layersRev, 8);
});
