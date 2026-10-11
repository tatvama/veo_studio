import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOptimistic, isCacheableGet, matchCutWrite, projectOf, replayQueue, rewriteLocation, rewriteSetCookie, type QueuedWrite,
} from "../src/main/offline.ts";

test("cut writes are recognised (and only those)", () => {
  assert.deepEqual(matchCutWrite("PUT", "/api/episodes/3/layers"), { kind: "layers", id: 3 });
  assert.deepEqual(matchCutWrite("patch", "/api/shots/41?x=1"), { kind: "shot", id: 41 });
  assert.deepEqual(matchCutWrite("PUT", "/api/shots/41/fx"), { kind: "fx", id: 41 });
  assert.deepEqual(matchCutWrite("PUT", "/api/shots/41/overlays"), { kind: "overlays", id: 41 });
  assert.deepEqual(matchCutWrite("POST", "/api/episodes/3/shots/reorder"), { kind: "reorder", id: 3 });
  assert.deepEqual(matchCutWrite("PATCH", "/api/episodes/3"), { kind: "episode", id: 3 });
  assert.equal(matchCutWrite("POST", "/api/episodes/3/generate"), null);
  assert.equal(matchCutWrite("GET", "/api/episodes/3/layers"), null);
  assert.equal(matchCutWrite("DELETE", "/api/shots/41"), null);
});

test("cacheable GETs and the project of a request", () => {
  assert.ok(isCacheableGet("/api/episodes/3?lang=kn"));
  assert.ok(!isCacheableGet("/api/health/live"));
  assert.ok(!isCacheableGet("/api/auth/google/start"));
  assert.ok(!isCacheableGet("/media/x.mp4"));
  assert.equal(projectOf("/api/projects/12/episodes"), 12);
  assert.equal(projectOf("/api/episodes/3", "http://127.0.0.1:18100/p/7/edit"), 7);
  assert.equal(projectOf("/api/episodes/3", "http://127.0.0.1:18100/desktop/panel/program?pid=9&eid=3"), 9);
  assert.equal(projectOf("/api/episodes/3", "http://127.0.0.1:18100/"), null);
});

test("Set-Cookie loses Domain and Secure but keeps the rest", () => {
  assert.equal(rewriteSetCookie("veo_session=abc; Domain=studio.example.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=100"),
    "veo_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=100");
  assert.equal(rewriteSetCookie("a=b; secure; samesite=none"), "a=b; SameSite=Lax");
  assert.equal(rewriteSetCookie("a=b"), "a=b");
});

test("Location pointing at the server comes back to the gateway", () => {
  const gw = "http://127.0.0.1:18100";
  assert.equal(rewriteLocation("http://localhost:8100/p/1?x=2#h", "http://localhost:8100", gw), `${gw}/p/1?x=2#h`);
  assert.equal(rewriteLocation("/login", "http://localhost:8100", gw), `${gw}/login`);
  assert.equal(rewriteLocation("https://accounts.google.com/o/oauth2", "http://localhost:8100", gw), "https://accounts.google.com/o/oauth2");
});

const episode = {
  id: 3, title: "Ep", settings: { duck: true, music_volume_db: -16 },
  shots: [{ id: 1, order: 1, include: true, trim_in: 0 }, { id: 2, order: 2, include: true, trim_in: 0 }, { id: 3, order: 3, include: false }],
};

test("optimistic layers: replace and rev + 1, clip urls added", () => {
  const entries = [{ path: "/api/episodes/3/layers", body: { rev: 5, video: [], audio: [], holds: { 1: 2 }, media: [{ src: "projects/1/layers/a.mp4" }] } }];
  const r = applyOptimistic(entries, "PUT", "/api/episodes/3/layers", { rev: 5, video: [{ id: "v", clips: [{ id: "c", src: "projects/1/layers/a.mp4" }] }], audio: [] });
  assert.equal(r.updated.length, 1);
  const doc = r.updated[0].body as { rev: number; holds: unknown; media: unknown[]; video: { clips: { url: string }[] }[] };
  assert.equal(doc.rev, 6);
  assert.deepEqual(doc.holds, { 1: 2 });
  assert.equal(doc.media.length, 1);
  assert.equal(doc.video[0].clips[0].url, "/media/projects/1/layers/a.mp4");
  assert.equal((r.result as { rev: number }).rev, 6);
});

test("optimistic shot patch / fx / overlays merge into cached episodes", () => {
  const entries = [{ path: "/api/episodes/3?lang=kn", body: episode }, { path: "/api/shots/2", body: { id: 2, trim_in: 0 } }, { path: "/api/projects", body: [] }];
  const p = applyOptimistic(entries, "PATCH", "/api/shots/2", { trim_in: 0.4, include: false });
  assert.equal(p.updated.length, 2);
  const ep = p.updated.find((u) => u.path.startsWith("/api/episodes"))!.body as typeof episode;
  assert.deepEqual(ep.shots[1], { id: 2, order: 2, include: false, trim_in: 0.4 });
  assert.equal(ep.shots[0].trim_in, 0);
  assert.equal((p.result as { trim_in: number }).trim_in, 0.4);
  const fx = applyOptimistic(entries, "PUT", "/api/shots/1/fx", { fx: { look: "teal" } });
  assert.deepEqual(((fx.updated[0].body as typeof episode).shots[0] as Record<string, unknown>).fx, { look: "teal" });
  const ov = applyOptimistic(entries, "PUT", "/api/shots/1/overlays", { overlays: [{ text: "Hi" }] });
  assert.deepEqual(((ov.updated[0].body as typeof episode).shots[0] as Record<string, unknown>).overlays, [{ text: "Hi" }]);
});

test("optimistic reorder and episode settings", () => {
  const entries = [{ path: "/api/episodes/3", body: episode }];
  const r = applyOptimistic(entries, "POST", "/api/episodes/3/shots/reorder", { shot_ids: [2, 1] });
  const shots = (r.updated[0].body as typeof episode).shots;
  assert.deepEqual(shots.map((s) => [s.id, s.order]), [[2, 1], [1, 2], [3, 5003]]);
  const e = applyOptimistic(entries, "PATCH", "/api/episodes/3", { settings: { duck: false }, title: "New" });
  const doc = e.updated[0].body as typeof episode;
  assert.deepEqual(doc.settings, { duck: false, music_volume_db: -16 });
  assert.equal(doc.title, "New");
});

test("replay: in order, 409 on layers refetches the rev once, 4xx dropped, network error stops", async () => {
  const rows: QueuedWrite[] = [
    { id: 1, method: "PATCH", path: "/api/shots/2", body: "{\"trim_in\":1}", tries: 0 },
    { id: 2, method: "PUT", path: "/api/episodes/3/layers", body: "{\"rev\":5,\"video\":[],\"audio\":[]}", tries: 0 },
    { id: 3, method: "PUT", path: "/api/shots/9/fx", body: "{\"fx\":{}}", tries: 0 },
    { id: 4, method: "PATCH", path: "/api/episodes/3", body: "{\"title\":\"x\"}", tries: 0 },
  ];
  const sent: string[] = [];
  const done: number[] = [];
  const failed: [number, boolean][] = [];
  let layersCalls = 0;
  const out = await replayQueue(rows, {
    send: async (method, path, body) => {
      sent.push(`${method} ${path} ${body}`);
      if (path.endsWith("/layers")) return ++layersCalls === 1 ? { status: 409, json: { detail: "changed" } } : { status: 200, json: { rev: 8 } };
      if (path === "/api/shots/9/fx") return { status: 423, json: { detail: "Checked out by Asha" } };
      if (path === "/api/episodes/3") throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      return { status: 200, json: {} };
    },
    layersRev: async () => 7,
    done: (id) => done.push(id),
    failed: (id, _e, drop) => failed.push([id, drop]),
  });
  assert.deepEqual(done, [1, 2]);
  assert.deepEqual(failed, [[3, true]]);
  assert.equal(out.sent, 2);
  assert.equal(out.dropped, 1);
  assert.equal(out.stoppedOffline, true);
  assert.ok(sent[2].includes("\"rev\":7"), "retried with the server's rev");
  assert.match(out.lastError ?? "", /refused/);
});
