import assert from "node:assert/strict";
import { test } from "node:test";
import { begin, cancel, command, commit, exec, HISTORY_LIMIT, initHistory, jumpTo, preview, redo, undo } from "../model/commands.ts";
import { moveClips, updateSequence, withLinked } from "../model/ops.ts";
import { project, put, seqOf } from "./fixtures.ts";
import type { EditProject } from "../model/types.ts";

const rename = (n: string) => command(`Rename ${n}`, (p: EditProject) => ({ ...p, name: n }));

test("exec / undo / redo, and a new command clears the redo stack", () => {
  let h = initHistory(project());
  h = exec(h, rename("A"));
  h = exec(h, rename("B"));
  assert.equal(h.present.name, "B");
  h = undo(h);
  assert.equal(h.present.name, "A");
  h = redo(h);
  assert.equal(h.present.name, "B");
  h = undo(undo(h));
  assert.equal(h.present.name, "Test");
  h = exec(h, rename("C"));
  assert.equal(h.future.length, 0);
  assert.deepEqual(h.past.map((e) => e.label), ["Rename C"]);
});

test("a no-op command records nothing; coalescing merges quick edits", () => {
  let h = initHistory(project());
  h = exec(h, command("Nothing", (p) => p));
  assert.equal(h.past.length, 0);
  h = exec(h, command("Opacity", (p) => ({ ...p, name: "1" }), "op"), 1000);
  h = exec(h, command("Opacity", (p) => ({ ...p, name: "2" }), "op"), 1300);
  h = exec(h, command("Opacity", (p) => ({ ...p, name: "3" }), "op"), 5000);
  assert.equal(h.past.length, 2);
  h = undo(h);
  assert.equal(h.present.name, "2");
  h = undo(h);
  assert.equal(h.present.name, "Test");
});

test("a drag is one entry; cancel restores; each preview starts from the base", () => {
  const p0 = project();
  const s0 = put(p0, seqOf(p0), "m1", 0, { in: 0, out: 49 });
  const p = { ...p0, sequences: [s0] };
  const ids = withLinked(s0, [s0.clips[0].id]);
  let h = initHistory(p);
  h = begin(h, "Move clips");
  for (const dx of [5, 10, 15, 20]) h = preview(h, (b) => updateSequence(b, s0.id, (s, ctx) => moveClips(s, ctx, ids, dx)));
  assert.equal(h.present.sequences[0].clips[0].start, 20);
  h = commit(h);
  assert.equal(h.past.length, 1);
  assert.equal(h.past[0].label, "Move clips");
  h = undo(h);
  assert.equal(h.present.sequences[0].clips[0].start, 0);
  h = begin(redo(h), "Move clips");
  h = preview(h, (b) => updateSequence(b, s0.id, (s, ctx) => moveClips(s, ctx, ids, 100)));
  h = cancel(h);
  assert.equal(h.present.sequences[0].clips[0].start, 20);
  assert.equal(h.past.length, 1);
});

test("the history keeps 500 steps; jumpTo goes to any of them", () => {
  let h = initHistory(project());
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = exec(h, rename(String(i)));
  assert.equal(h.past.length, HISTORY_LIMIT);
  h = jumpTo(h, 9);
  assert.equal(h.present.name, String(20 + 9));
  assert.equal(h.future.length, HISTORY_LIMIT - 10);
  h = jumpTo(h, HISTORY_LIMIT - 1);
  assert.equal(h.present.name, String(HISTORY_LIMIT + 19));
});
