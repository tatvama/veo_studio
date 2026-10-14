/**
 * The Designer inspector's reading of kind props (newsroom/designer/sentinel.ts, docs/EDITOR.md §16.8): which number
 * props are "Auto" (default null) or "Follow look" / "As typed" sentinels, and which are plain numbers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sentinelOf } from "../newsroom/designer/sentinel.ts";
import type { PropDef } from "../newsroom/render/contract.ts";

const n = (o: Partial<PropDef>): PropDef => ({ key: "x", label: "X", type: "number", default: 0, ...o });

test("sentinels", () => {
  assert.deepEqual(sentinelOf(n({ default: null, key: "cx" })), { value: null, label: "Auto" });
  assert.deepEqual(sentinelOf(n({ key: "radius", default: -1, hint: "-1 follows the look" })), { value: -1, label: "Follow look" });
  assert.deepEqual(sentinelOf(n({ key: "radius", default: -1, hint: "−1 = the look's" })), { value: -1, label: "Follow look" });
  assert.deepEqual(sentinelOf(n({ key: "weight", default: 0, hint: "0 follows the look" })), { value: 0, label: "Follow look" });
  assert.deepEqual(sentinelOf(n({ key: "decimals", default: -1, hint: "−1 = as typed" })), { value: -1, label: "As typed" });
  assert.deepEqual(sentinelOf(n({ key: "maxLines", default: 0, hint: "0 = as many as fit" })), { value: 0, label: "As many as fit" });
  assert.equal(sentinelOf(n({ key: "angle", default: 0, hint: "0 = left to right, 90 = top to bottom" })), null, "a meaning, not a sentinel");
  assert.equal(sentinelOf(n({ key: "size", default: 48 })), null);
  assert.equal(sentinelOf(n({ key: "weight", default: 700, hint: "0 follows the look" })), null, "only when the default is the sentinel");
});
