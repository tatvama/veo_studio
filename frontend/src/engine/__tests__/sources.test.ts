/**
 * The exact source's pure parts: the sample table of a long file (a loop, where Math.min(...spread) threw past ~120k
 * samples), the reference-counted cache behind demuxed files and grabbed frames, and the seek wait that races the
 * picture against an error and a timeout, leaving no listener or timer behind.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RefCache } from "../refcache.ts";
import { sampleTable } from "../sources/exact.ts";
import { waitFor } from "../sources/live.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("sampleTable: 200k samples (a long file) build without a RangeError; times from the earliest cts, sorted pts, index by time", () => {
  const n = 200_000, ts = 90_000;
  const data = new Uint8Array(1);
  // decode order with B-frame reordering: cts isn't monotonic, and the first sample isn't the earliest
  const raw = Array.from({ length: n }, (_, i) => ({ cts: 3003 * (i + (i % 3 === 2 ? -2 : 1)) + 6006, dur: 3003, key: i % 48 === 0, data, timescale: ts }));
  const t = sampleTable(raw);
  assert.equal(t.samples.length, n);
  assert.equal(t.pts.length, n);
  let min = Infinity;
  for (const s of raw) min = Math.min(min, s.cts);
  assert.equal(min, raw[2].cts, "the earliest cts is sample 2's");
  assert.equal(t.samples[2].ts, 0, "times count from the earliest sample");
  assert.equal(t.samples[0].ts, Math.round(((raw[0].cts - min) / ts) * 1e6));
  assert.equal(t.samples[0].dur, Math.round(3003 / ts * 1e6));
  for (let i = 1; i < n; i++) assert.ok(t.pts[i] >= t.pts[i - 1], `pts sorted at ${i}`);
  assert.equal(t.byTs.get(t.samples[777].ts), 777);
  assert.equal(t.samples[48].key, true); assert.equal(t.samples[49].key, false);
});

test("RefCache: one load per key while held, dropped at zero, a failed load forgotten", async () => {
  let loads = 0; const disposed: string[] = [];
  const c = new RefCache<string>(async (k) => { loads++; if (k === "bad") throw new Error("no"); return `v:${k}`; }, (v) => disposed.push(v));
  const [a, b] = await Promise.all([c.acquire("x"), c.acquire("x")]);
  assert.equal(a, "v:x"); assert.equal(b, "v:x");
  assert.equal(loads, 1); assert.equal(c.refs("x"), 2); assert.equal(c.size, 1);
  c.release("x");
  assert.equal(c.refs("x"), 1); assert.equal(c.size, 1, "still held by one");
  c.release("x");
  await tick();
  assert.equal(c.size, 0); assert.deepEqual(disposed, ["v:x"], "disposed at zero");
  c.release("x");  // one too many: ignored
  assert.equal(c.size, 0);
  await assert.rejects(c.acquire("bad"), /no/);
  await tick();
  assert.equal(c.has("bad"), false, "a failed load is forgotten");
  await assert.rejects(c.acquire("bad"), /no/);
  assert.equal(loads, 3, "and tried again");
});

test("RefCache with keep: released entries stay for the next acquire, the oldest idle ones go first", async () => {
  const disposed: string[] = [];
  const c = new RefCache<string>(async (k) => k, (v) => disposed.push(v), 2);
  for (const k of ["a", "b", "c"]) { await c.acquire(k); c.release(k); }
  await tick();
  assert.equal(c.idleCount, 2); assert.deepEqual(disposed, ["a"], "two kept, the oldest dropped");
  assert.ok(c.has("b") && c.has("c"));
  await c.acquire("b");  // out of idle, held again
  assert.equal(c.idleCount, 1); assert.equal(c.refs("b"), 1);
  await c.acquire("d"); c.release("d");
  await c.acquire("e"); c.release("e");
  await tick();
  assert.deepEqual(disposed, ["a", "c"], "c went (idle longest); b is held so it stays");
  assert.ok(c.has("b"));
  c.clear();
  await tick();
  assert.equal(c.size, 0); assert.equal(c.idleCount, 0);
  assert.deepEqual([...disposed].sort(), ["a", "b", "c", "d", "e"]);
});

/** An EventTarget that counts its listeners (what waitFor must leave at zero). */
class Counted extends EventTarget {
  n = 0;
  addEventListener(t: string, l: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) { this.n++; super.addEventListener(t, l, o); }
  removeEventListener(t: string, l: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) { this.n--; super.removeEventListener(t, l, o); }
}

test("waitFor: the event resolves, an error rejects with the message, a timeout resolves; listeners and the timer are gone each time", async () => {
  const el = new Counted();
  const p1 = waitFor(el, ["seeked"], ["error"], 5000);
  assert.equal(el.n, 2);
  el.dispatchEvent(new Event("seeked"));
  assert.equal(await p1, "ok");
  assert.equal(el.n, 0, "listeners removed after the event");
  const p2 = waitFor(el, ["seeked"], ["error"], 5000, () => "the video failed");
  el.dispatchEvent(new Event("error"));
  await assert.rejects(p2, /the video failed/);
  assert.equal(el.n, 0, "listeners removed after the error");
  const t0 = performance.now();
  const r = await waitFor(el, ["seeked"], ["error"], 15);
  assert.equal(r, "timeout");
  assert.ok(performance.now() - t0 >= 10);
  assert.equal(el.n, 0, "listeners removed after the timeout");
  // a late event after the wait ended is nobody's business
  el.dispatchEvent(new Event("error"));
  el.dispatchEvent(new Event("seeked"));
  assert.equal(el.n, 0);
});
