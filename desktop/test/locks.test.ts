/**
 * Checkout locks held by this app (docs/DESKTOP.md §2.1): tracked from the answers the gateway forwards, released on
 * quit only when still ours and from this machine, against a fake server.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { HeldLocks } from "../src/main/locks.ts";
import { Upstream } from "../src/main/upstream.ts";

test("observe: a checkout or heartbeat holds, a check-in or release frees; failures and other paths are ignored", () => {
  const h = new HeldLocks();
  h.observe("POST", "/api/episodes/12/checkout", 200);
  h.observe("POST", "/api/episodes/13/checkout", 423); // someone else has it
  h.observe("POST", "/api/episodes/14/checkout/heartbeat", 200); // taken before this run
  h.observe("GET", "/api/episodes/15/checkout", 200); // only looking
  h.observe("POST", "/api/episodes/16/checkout/", 201);
  h.observe("POST", "/api/episodes/12/renders/uploads", 200);
  assert.deepEqual(h.list(), [12, 14, 16]);
  h.observe("POST", "/api/episodes/12/checkin", 200);
  h.observe("DELETE", "/api/episodes/14/checkout", 200);
  h.observe("DELETE", "/api/episodes/16/checkout", 403); // refused: still held
  assert.deepEqual(h.list(), [16]);
});

test("releaseAll: deletes what is still ours on this machine, leaves another PC's lock and a lock someone else took", async () => {
  const locks = new Map<string, { mine: boolean; machine: string } | null>([
    ["1", { mine: true, machine: "EDIT-PC" }], ["2", { mine: true, machine: "OTHER-PC" }], ["3", { mine: false, machine: "EDIT-PC" }], ["4", null],
  ]);
  const deleted: string[] = [];
  const srv = http.createServer((req, res) => {
    const m = /^\/api\/episodes\/(\d+)\/checkout$/.exec(req.url ?? "");
    const json = (code: number, v: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
    if (!m) return json(404, { detail: "nope" });
    if (req.method === "GET") return json(200, { lock: locks.get(m[1]) ?? null });
    if (req.method === "DELETE") {
      assert.equal(req.headers["x-requested-with"], "veo-studio");
      deleted.push(m[1]);
      locks.set(m[1], null);
      return json(200, { lock: null });
    }
    json(405, {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const up = new Upstream({ serverUrl: () => `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, cookie: async () => "veo_session=tok" });
  try {
    const h = new HeldLocks();
    for (const eid of [1, 2, 3, 4]) h.observe("POST", `/api/episodes/${eid}/checkout`, 200);
    const logs: string[] = [];
    assert.equal(await h.releaseAll(up, "edit-pc", 2000, (m) => logs.push(m)), 1);
    assert.deepEqual(deleted, ["1"]);
    assert.deepEqual(h.list(), [2], "the other PC's lock is still noted; the ones not ours any more are dropped");
    assert.ok(logs.some((l) => /released the cut of episode 1/.test(l)));
    assert.equal(await new HeldLocks().releaseAll(up, "edit-pc"), 0);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
  // a server that is gone: nothing thrown, nothing hangs past the deadline
  const h = new HeldLocks();
  h.observe("POST", "/api/episodes/9/checkout", 200);
  const t0 = Date.now();
  assert.equal(await h.releaseAll(new Upstream({ serverUrl: () => "http://127.0.0.1:9", cookie: async () => "" }), "edit-pc", 500), 0);
  assert.ok(Date.now() - t0 < 5000);
});
