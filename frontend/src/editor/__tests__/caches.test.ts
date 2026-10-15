/**
 * The editor's bounded caches: the preview bitmaps' LRU (a card holds the bitmap it shows, so an evicted one is closed
 * only once no card shows it) and the byte-capped LRU behind the mixer's rendered generator sounds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ByteLru } from "../playback/lru.ts";
import { BitmapLru } from "../preview/cache.ts";

class FakeBitmap {
  readonly width: number; readonly height: number;
  closed = false;
  constructor(w: number, h: number) { this.width = w; this.height = h; }
  close() { this.closed = true; }
}
const px = (n: number) => new FakeBitmap(n, 1);  // n px × 4 bytes

test("BitmapLru: evicts by bytes, closes unheld evictions at once (delay 0) and held ones only at the last unhold", () => {
  const lru = new BitmapLru<FakeBitmap>(4 * 25, 0);  // room for 25 px
  const a = px(10), b = px(10), c = px(10), d = px(10);
  lru.set("a", a); lru.set("b", b);
  assert.equal(lru.bytes, 80); assert.equal(lru.size, 2);
  lru.hold(a);
  lru.set("c", c);  // over budget: a (the oldest) goes, but a card shows it
  assert.equal(lru.size, 2); assert.ok(!lru.has("a"));
  assert.equal(a.closed, false, "held: not closed"); assert.equal(lru.retiredCount, 1);
  lru.set("d", d);  // b goes, nobody holds it
  assert.equal(b.closed, true); assert.ok(!lru.has("b"));
  assert.equal(lru.bytes, 80);
  lru.hold(a); lru.unhold(a);
  assert.equal(a.closed, false, "still one holder");
  lru.unhold(a);
  assert.equal(a.closed, true, "closed at the last unhold"); assert.equal(lru.retiredCount, 0);
  lru.unhold(a);  // one too many: harmless
  assert.equal(lru.holders(a), 0);
  // get() refreshes: c is used, so d goes next
  assert.equal(lru.get("c"), c);
  lru.set("e", px(10));
  assert.equal(d.closed, true); assert.equal(c.closed, false); assert.ok(lru.has("c"));
  // the same bitmap again is a no-op; a different one for a key evicts the old
  lru.set("c", c);
  assert.equal(lru.bytes, 80);
  const c2 = px(5);
  lru.set("c", c2);
  assert.equal(c.closed, true); assert.equal(lru.bytes, 60);
  // one entry larger than the budget is kept all the same (there is nothing smaller to show)
  lru.set("big", px(1000));
  assert.ok(lru.has("big")); assert.equal(lru.size, 1);
});

test("ByteLru: a byte budget, oldest first, get() refreshes, the entry just added always stays, onEvict reports", () => {
  const gone: string[] = [];
  const lru = new ByteLru<Float32Array>(100, (b) => b.byteLength, (_v, k) => gone.push(k));
  lru.set("a", new Float32Array(10));  // 40 B
  lru.set("b", new Float32Array(10));  // 80 B
  assert.equal(lru.bytes, 80); assert.equal(lru.size, 2);
  assert.ok(lru.get("a"), "a used: b is now the oldest");
  lru.set("c", new Float32Array(10));  // 120 B > 100: b goes
  assert.deepEqual(gone, ["b"]); assert.equal(lru.bytes, 80);
  assert.ok(lru.has("a") && lru.has("c"));
  lru.set("huge", new Float32Array(100));  // 400 B: everything else goes, huge stays
  assert.deepEqual(gone, ["b", "a", "c"]); assert.equal(lru.size, 1); assert.equal(lru.bytes, 400);
  lru.set("huge", new Float32Array(2));  // replaced: the old one is reported
  assert.deepEqual(gone, ["b", "a", "c", "huge"]); assert.equal(lru.bytes, 8);
  assert.equal(lru.delete("huge"), true); assert.equal(lru.delete("huge"), false);
  assert.equal(lru.bytes, 0); assert.equal(lru.size, 0);
  lru.set("x", new Float32Array(1)); lru.clear();
  assert.equal(gone.at(-1), "x"); assert.equal(lru.size, 0);
});
