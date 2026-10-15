/**
 * The GL backend's pure parts: the render-target pool (a frame that throws gives its targets back instead of leaking
 * one set per failure; targets kept on purpose stay out) and the uniform scratch fill.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ShaderError } from "../gl/backend.ts";
import { TargetPool } from "../gl/pool.ts";
import { fillUniform } from "../gl/webgl2.ts";

interface T { key: string; used: number; id: number }

/** A backend of pooled targets whose pass() fails when told to, and a renderer frame that uses it as the real one does. */
class MockBackend {
  pool = new TargetPool<T>();
  allocs = 0;
  failNext = 0;
  target(key: string): T { return this.pool.take(key) ?? this.pool.add({ key, used: 0, id: this.allocs++ }); }
  release(t: T | null | undefined) { this.pool.release(t); }
  tick() { this.pool.nextTick(); }
  pass(_out: T) { if (this.failNext > 0) { this.failNext--; throw new ShaderError("clip[lut]", "ERROR: 0:12: 'x' : undeclared identifier"); } }
}

/** draw(): tick, a chain of passes through pooled targets, release on the way; reclaim what a throw left behind. */
function frame(b: MockBackend, kept: T[]) {
  b.tick();
  const acc = b.target("1920x1080:rgba16f:");
  try {
    const clip = b.target("1920x1080:rgba16f:");
    b.pass(clip);
    const fx = b.target("960x540:rgba16f:");
    b.pass(fx);
    b.release(fx);
    b.pass(acc);
    b.release(clip);
  } catch (e) {
    b.pool.reclaim(kept);
    throw e;
  }
  return acc;
}

test("TargetPool: a frame whose pass() throws leaves no leak; the pool stays the size of one good frame", () => {
  const b = new MockBackend();
  let prev: T | null = null;
  const good = () => { const acc = frame(b, []); b.release(prev); prev = acc; };
  good(); good();
  const size = b.pool.size;
  assert.equal(size, 4, "the last frame's result (held), the accumulator, the clip, the half-size fx");
  for (let i = 0; i < 5; i++) {
    b.failNext = 1;
    assert.throws(() => frame(b, []), ShaderError);
    assert.equal(b.pool.size, size, `no new target after failed frame ${i}`);
    assert.equal(b.pool.lentCount, 0, "everything handed out was given back");
    assert.equal(b.pool.freeCount, size - 1, "the previous frame's result is still held");
  }
  good();
  assert.equal(b.pool.size, size, "a good frame after the failures allocates nothing new");
  assert.equal(b.allocs, size);
});

test("TargetPool: reclaim keeps what the renderer holds on purpose (a history copy), release is idempotent, tick ages", () => {
  const b = new MockBackend();
  b.tick();
  const hist = b.target("640x360:rgba16f:");  // stored across frames
  const tmp = b.target("640x360:rgba16f:");
  assert.equal(b.pool.lentCount, 2);
  assert.equal(b.pool.reclaim([hist, null, undefined]), 1, "only the stray one goes back");
  assert.equal(b.pool.freeCount, 1); assert.equal(b.pool.lentCount, 1);
  assert.equal(b.pool.release(tmp), false, "already free");
  assert.equal(b.pool.release({ key: "x", used: 0, id: 99 }), false, "not ours");
  assert.equal(b.pool.take("640x360:rgba16f:"), tmp, "the reclaimed one is reused");
  // ageing: a size not asked for in `age` ticks is freed
  const deleted: T[] = [];
  b.release(tmp);
  for (let i = 0; i < 5; i++) b.tick();
  b.pool.trimOld(3, (t) => deleted.push(t));
  assert.deepEqual(deleted, [tmp]);
  assert.equal(b.pool.size, 1, "the held history stays");
  b.pool.clear((t) => deleted.push(t));
  assert.deepEqual(deleted, [tmp, hist]);
  assert.equal(b.pool.size, 0);
});

test("fillUniform: exact length, zero padded, extra dropped, rounded for integers, nothing allocated", () => {
  const f = new Float32Array(4);
  assert.equal(fillUniform(f, [1, 2], 4, false), f, "the scratch array itself");
  assert.deepEqual([...f], [1, 2, 0, 0]);
  fillUniform(f, [9, 8, 7, 6, 5], 4, false);
  assert.deepEqual([...f], [9, 8, 7, 6]);
  fillUniform(f, [NaN, Infinity, "3" as unknown as number, 0.5], 4, false);
  assert.deepEqual([...f], [0, 0, 3, 0.5], "non-finite → 0, numeric strings read");
  const i = new Int32Array(3);
  fillUniform(i, [0.6, 1.4, -2.5], 3, true);
  assert.deepEqual([...i], [1, 1, -2]);
  fillUniform(i, new Float32Array([7]), 3, true);
  assert.deepEqual([...i], [7, 0, 0]);
});
