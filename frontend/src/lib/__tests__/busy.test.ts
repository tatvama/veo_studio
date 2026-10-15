/**
 * The busy latch behind useBusyAction: a second call while one action runs is ignored (so a double click on a paid
 * button spends once), the active key is reported, and a rejection neither escapes nor leaves the latch stuck.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBusyLatch } from "../busy.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("runs one action at a time and reports the active key", async () => {
  const seen: (string | null)[] = [];
  const latch = createBusyLatch((k) => seen.push(k));
  let release!: () => void;
  const first = latch.run("render", () => new Promise<string>((r) => { release = () => r("done"); }));
  assert.equal(latch.key, "render");

  let secondRan = false;
  const second = await latch.run("render", async () => { secondRan = true; return "twice"; });
  assert.equal(second, undefined, "the second click is ignored while the first is in flight");
  assert.equal(secondRan, false);

  release();
  assert.equal(await first, "done");
  assert.equal(latch.key, null);
  assert.deepEqual(seen, ["render", null]);
});

test("different keys still share the one latch", async () => {
  const latch = createBusyLatch();
  let release!: () => void;
  const a = latch.run("a", () => new Promise<void>((r) => { release = r; }));
  const b = await latch.run("b", async () => "b");
  assert.equal(b, undefined);
  release();
  await a;
  assert.equal(await latch.run("b", async () => "b"), "b", "free again once the first finishes");
});

test("a rejection is swallowed and frees the latch", async () => {
  const latch = createBusyLatch();
  const r = await latch.run("x", async () => { throw new Error("api already toasted this"); });
  assert.equal(r, undefined);
  assert.equal(latch.key, null);
  await tick();
  assert.equal(await latch.run("x", async () => 1), 1);
});
