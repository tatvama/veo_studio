/**
 * The process-wide GPU gate (docs/DESKTOP.md §4.1): a counting semaphore every encoder and GPU tool takes a slot from.
 * Also the pool that runs the render segments side by side: the plan's order on the way out, no new work after an abort.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pool } from "../src/main/download.ts";
import { defaultGpuSlots, gpuGate, Semaphore } from "../src/main/gpu-gate.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("two slots: the third waits until one is released; release is idempotent", async () => {
  const g = new Semaphore(2);
  const r1 = await g.acquire();
  const r2 = await g.acquire();
  assert.equal(g.inUse, 2);
  let got = false;
  const third = g.acquire().then((r) => { got = true; return r; });
  await tick();
  assert.equal(got, false);
  assert.equal(g.queued, 1);
  r1();
  r1(); // again: no second slot is freed
  const r3 = await third;
  assert.equal(got, true);
  assert.equal(g.inUse, 2);
  r2();
  r3();
  assert.equal(g.inUse, 0);
});

test("waiting is cancelled by the signal; run() releases on success and on failure", async () => {
  const g = new Semaphore(1);
  const release = await g.acquire();
  const ac = new AbortController();
  const waiting = g.acquire(ac.signal);
  ac.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(g.queued, 0);
  await assert.rejects(g.acquire(AbortSignal.abort()), /cancelled/);
  release();
  assert.equal(await g.run(async () => 7), 7);
  await assert.rejects(g.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(g.inUse, 0);
});

test("setSlots: growing lets waiters start, shrinking never interrupts running work", async () => {
  const g = new Semaphore(1);
  const r1 = await g.acquire();
  const second = g.acquire();
  g.setSlots(2);
  const r2 = await second;
  assert.equal(g.slots, 2);
  g.setSlots(1);
  assert.equal(g.inUse, 2, "both keep running");
  r1();
  r2();
  assert.equal(g.inUse, 0);
  assert.equal(defaultGpuSlots({}), 2);
  assert.equal(defaultGpuSlots({ TATVAM_GPU_SLOTS: "3" }), 3);
  assert.equal(defaultGpuSlots({ TATVAM_GPU_SLOTS: "0" }), 2);
  assert.equal(defaultGpuSlots({ TATVAM_GPU_SLOTS: "many" }), 2);
  assert.ok(gpuGate.slots >= 1);
});

test("pool: results land by index however long each takes, and nothing new starts after an abort", async () => {
  const out: string[] = [];
  const started: number[] = [];
  await pool(["a", "b", "c", "d"], 2, async (item, i) => {
    started.push(i);
    await new Promise((r) => setTimeout(r, i === 0 ? 40 : 5));
    out[i] = item.toUpperCase();
  });
  assert.deepEqual(out, ["A", "B", "C", "D"]);
  assert.deepEqual(started, [0, 1, 2, 3]);
  const ac = new AbortController();
  const ran: number[] = [];
  await assert.rejects(pool([1, 2, 3, 4], 2, async (_x, i) => {
    ran.push(i);
    if (i === 1) { ac.abort(); throw new Error("segment 1 failed"); }
    await tick();
  }, ac.signal), /segment 1 failed/);
  await tick();
  assert.deepEqual(ran, [0, 1], "the items after the failure never start");
});
