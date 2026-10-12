import assert from "node:assert/strict";
import { test } from "node:test";
import { addKeyframe, valueAt } from "../model/params.ts";
import {
  addTrack, addTransition, applyDefaultTransition, clearRange, clipEnd, copyClips, ctxOf, editMedia, extract, handles, lift, link, markClip,
  moveClips, nestClips, pasteAttributes, pasteClips, rateStretch, razor, rearrange, removeTrack, rippleDelete, rippleDeleteGap,
  rippleTrimToPlayhead, rollEdit, setEnabled, setSpeed, slideClip, slipClip, swapClips, trimClip, unlink, updateParam, updateTrack,
  withLinked,
} from "../model/ops.ts";
import { A, on, project, put, seqOf, spans, V } from "./fixtures.ts";

test("overwrite places linked A/V halves and splits what's under them", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0);
  assert.deepEqual(spans(s, V(s, 0).id), [[0, 250]]);
  assert.deepEqual(spans(s, A(s, 0).id), [[0, 250]]);
  const [v, a] = [on(s, V(s, 0).id)[0], on(s, A(s, 0).id)[0]];
  assert.ok(v.linkId && v.linkId === a.linkId);
  s = put(p, s, "m2", 100, { in: 0, out: 49 });
  assert.deepEqual(spans(s, V(s, 0).id), [[0, 100], [100, 150], [150, 250]]);
  const right = on(s, V(s, 0).id)[2];
  assert.equal(right.source.type === "media" && right.source.in, 150, "the right half continues the source");
  // the right halves of the split pair are linked to each other, not to the left halves
  const rv = on(s, V(s, 0).id)[2], ra = on(s, A(s, 0).id)[2];
  assert.ok(rv.linkId && rv.linkId === ra.linkId && rv.linkId !== v.linkId);
  void ctx;
});

test("insert pushes the targeted and sync-locked tracks; sync lock off stays", () => {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0);
  s = updateTrack(s, A(s, 1).id, { syncLock: false });
  s = put(p, s, "music" as string, 0, undefined, 0, 1, true);
  const before = spans(s, A(s, 1).id);
  s = editMedia(s, ctxOf(p), p.media[1], 50, "insert", { range: { in: 0, out: 24 } });
  assert.deepEqual(spans(s, V(s, 0).id), [[0, 50], [50, 75], [75, 275]]);
  assert.deepEqual(spans(s, A(s, 0).id), [[0, 50], [50, 75], [75, 275]]);
  assert.deepEqual(spans(s, A(s, 1).id), before, "a track without sync lock doesn't move");
});

test("razor splits linked clips and keeps keyframed values", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0);
  const v = on(s, V(s, 0).id)[0];
  s = updateParam(s, ctx, v.id, "motion.opacity", (pp) => addKeyframe(addKeyframe(pp, 0, 0), 100, 100));
  s = razor(s, ctx, 50, { ids: [v.id] });
  assert.deepEqual(spans(s, V(s, 0).id), [[0, 50], [50, 250]]);
  assert.deepEqual(spans(s, A(s, 0).id), [[0, 50], [50, 250]]);
  const [l, r] = on(s, V(s, 0).id);
  assert.equal(valueAt(l.motion.opacity, 49), 49);
  assert.equal(valueAt(r.motion.opacity, 0), 50);
  assert.equal(valueAt(r.motion.opacity, 50), 100);
});

test("trim stops at the neighbour and the handles; ripple trim moves what follows", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 50, out: 149 });
  s = put(p, s, "m2", 100, { in: 0, out: 99 });
  const [a, b] = on(s, V(s, 0).id);
  assert.deepEqual(handles(a, s, ctx), { head: 50, tail: 100 });
  // plain trim of a's end into b is blocked by b
  assert.deepEqual(spans(trimClip(s, ctx, a.id, "end", 30), V(s, 0).id), [[0, 100], [100, 200]]);
  // a's start can only go back 50 frames (its head)… but it's at frame 0 already
  assert.deepEqual(spans(trimClip(s, ctx, a.id, "start", -80), V(s, 0).id), [[0, 100], [100, 200]]);
  // b's start back 80 frames: no head handle (in 0) → unchanged
  assert.deepEqual(spans(trimClip(s, ctx, b.id, "start", -10), V(s, 0).id), [[0, 100], [100, 200]]);
  // ripple: a's end +30 pushes b (and its linked audio) along
  const r = trimClip(s, ctx, a.id, "end", 30, { ripple: true });
  assert.deepEqual(spans(r, V(s, 0).id), [[0, 130], [130, 230]]);
  assert.deepEqual(spans(r, A(s, 0).id), [[0, 130], [130, 230]]);
  // ripple start trim shortens a from its head and pulls b back
  const r2 = trimClip(s, ctx, a.id, "start", 20, { ripple: true });
  assert.deepEqual(spans(r2, V(s, 0).id), [[0, 80], [80, 180]]);
  const a2 = on(r2, V(s, 0).id)[0];
  assert.equal(a2.source.type === "media" && a2.source.in, 70);
});

test("roll, slip and slide keep the sequence length", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 50, out: 149 });
  s = put(p, s, "m2", 100, { in: 50, out: 149 });
  s = put(p, s, "m1", 200, { in: 50, out: 149 });
  const [a, b, c] = on(s, V(s, 0).id);
  const rolled = rollEdit(s, ctx, a.id, b.id, 20);
  assert.deepEqual(spans(rolled, V(s, 0).id), [[0, 120], [120, 200], [200, 300]]);
  assert.deepEqual(spans(rollEdit(s, ctx, a.id, b.id, 500), V(s, 0).id), [[0, 199], [199, 200], [200, 300]], "b keeps one frame");
  assert.deepEqual(spans(rollEdit(s, ctx, a.id, b.id, -500), V(s, 0).id), [[0, 50], [50, 200], [200, 300]], "limited by b's head handle (50)");
  const slipped = slipClip(s, ctx, b.id, -30);
  const b2 = on(slipped, V(s, 0).id)[1];
  assert.equal(b2.source.type === "media" && b2.source.in, 20);
  assert.deepEqual(spans(slipped, V(s, 0).id), spans(s, V(s, 0).id));
  const slid = slideClip(s, ctx, b.id, 10);
  assert.deepEqual(spans(slid, V(s, 0).id), [[0, 110], [110, 210], [210, 300]]);
  const c2 = on(slid, V(s, 0).id)[2];
  assert.equal(c2.source.type === "media" && c2.source.in, 60);
  void c;
});

test("rate stretch keeps the source frames and changes the speed", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  const v = on(s, V(s, 0).id)[0];
  s = rateStretch(s, ctx, v.id, "end", 100);
  const x = on(s, V(s, 0).id)[0];
  assert.equal(x.duration, 200);
  assert.equal(x.speed, 0.5);
  assert.equal(on(s, A(s, 0).id)[0].speed, 0.5, "the linked audio stretches too");
  const y = on(rateStretch(s, ctx, x.id, "end", -10000), V(s, 0).id)[0];
  assert.equal(y.duration, 25, "4× is the fastest");
  const sp = setSpeed(s, ctx, [x.id], 2, { ripple: true });
  assert.equal(on(sp, V(s, 0).id)[0].duration, 50);
});

test("ripple delete closes the gap on sync-locked tracks only as far as they have room", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 0, out: 99 });
  s = put(p, s, "m1", 200, { in: 0, out: 99 });
  const mid = on(s, V(s, 0).id)[1];
  const r = rippleDelete(s, ctx, withLinked(s, [mid.id]));
  assert.deepEqual(spans(r, V(s, 0).id), [[0, 100], [100, 200]]);
  assert.deepEqual(spans(r, A(s, 0).id), [[0, 100], [100, 200]]);
  // a still on V2 over frames 50..175 (sync-locked) leaves room for 25 frames only
  const blocked = put(p, s, "still", 50, undefined, 1, 0, false);
  const r2 = rippleDelete(blocked, ctx, withLinked(blocked, [mid.id]));
  assert.deepEqual(spans(r2, V(s, 0).id), [[0, 100], [175, 275]]);
  // with V2's sync lock off the whole gap closes
  const free = rippleDelete(updateTrack(blocked, V(s, 1).id, { syncLock: false }), ctx, withLinked(blocked, [mid.id]));
  assert.deepEqual(spans(free, V(s, 0).id), [[0, 100], [100, 200]]);
  // gaps
  const gap = rippleDeleteGap({ ...s, clips: s.clips.filter((c) => !withLinked(s, [mid.id]).includes(c.id)) }, ctx, V(s, 0).id, 150);
  assert.deepEqual(spans(gap, V(s, 0).id), [[0, 100], [100, 200]]);
});

test("lift leaves a gap, extract closes it; Q / W trim to the playhead", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0);
  assert.deepEqual(spans(lift(s, ctx, 50, 100), V(s, 0).id), [[0, 50], [100, 250]]);
  assert.deepEqual(spans(extract(s, ctx, 50, 100), V(s, 0).id), [[0, 50], [50, 200]]);
  assert.deepEqual(spans(extract(s, ctx, 50, 100), A(s, 0).id), [[0, 50], [50, 200]]);
  s = put(p, s, "m2", 250, { in: 0, out: 99 });
  assert.deepEqual(spans(rippleTrimToPlayhead(s, ctx, 280, "prev"), V(s, 0).id), [[0, 250], [250, 320]]);
  assert.deepEqual(spans(rippleTrimToPlayhead(s, ctx, 280, "next"), V(s, 0).id), [[0, 250], [250, 280]]);
});

test("move overwrites at the destination, Alt duplicates, Ctrl inserts, clamps to frame 0 and the tracks", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 0, out: 99 });
  const [a, b] = on(s, V(s, 0).id);
  const ids = withLinked(s, [b.id]);
  const moved = moveClips(s, ctx, ids, -50);
  assert.deepEqual(spans(moved, V(s, 0).id), [[0, 50], [50, 150]], "b overwrote the tail of a");
  const dup = moveClips(s, ctx, ids, 200, { video: 0, audio: 0 }, { duplicate: true });
  assert.deepEqual(spans(dup, V(s, 0).id), [[0, 100], [100, 200], [300, 400]]);
  const copies = on(dup, V(s, 0).id)[2];
  assert.ok(copies.id !== b.id && copies.linkId && copies.linkId !== b.linkId);
  const ins = moveClips(s, ctx, ids, -100, { video: 0, audio: 0 }, { mode: "insert" });
  assert.deepEqual(spans(ins, V(s, 0).id), [[0, 100], [100, 200]]);
  assert.equal(on(ins, V(s, 0).id)[0].id, b.id, "b went before a");
  const up = moveClips(s, ctx, [a.id], 0, { video: 5, audio: 0 });
  assert.equal(on(up, V(s, 2).id).length, 1, "clamped to the top track");
  const locked = updateTrack(s, V(s, 1).id, { locked: true });
  assert.equal(moveClips(locked, ctx, [a.id], 0, { video: 1, audio: 0 }), locked, "nothing moves onto a locked track");
  assert.equal(on(moveClips(s, ctx, ids, -500), V(s, 0).id)[0].start, 0);
});

test("rearrange, swap, link / unlink, enable", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 49 });
  s = put(p, s, "m2", 50, { in: 0, out: 99 });
  s = put(p, s, "m1", 150, { in: 0, out: 24 });
  const [a, b, c] = on(s, V(s, 0).id);
  const r = rearrange(s, ctx, withLinked(s, [c.id]), 0);
  assert.deepEqual(on(r, V(s, 0).id).map((x) => x.id), [c.id, a.id, b.id]);
  assert.deepEqual(spans(r, V(s, 0).id), [[0, 25], [25, 75], [75, 175]]);
  const sw = swapClips(s, ctx, a.id, b.id);
  assert.equal(on(sw, V(s, 0).id).find((x) => x.id === b.id)!.start, 0);
  const un = unlink(s, ctx, [a.id]);
  assert.equal(withLinked(un, [a.id]).length, 1);
  const ln = link(un, ctx, [a.id, b.id]);
  assert.equal(withLinked(ln, [a.id]).length, 2);
  assert.equal(on(setEnabled(s, ctx, [a.id]), V(s, 0).id)[0].enabled, false);
});

test("transitions: centred on a cut, clamped to the handles, follow their clips, dropped when the cut goes", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });      // tail handle 150
  s = put(p, s, "m2", 100, { in: 10, out: 109 });             // head handle 10
  const vt = V(s, 0).id;
  const r = addTransition(s, ctx, vt, 100, "fade", 50);
  assert.ok(r.id);
  assert.equal(r.seq.transitions[0].duration, 20, "centre: 2 × min(tail 150, head 10)");
  const st = addTransition(s, ctx, vt, 100, "fade", 50, { alignment: "start" });
  assert.equal(st.seq.transitions[0].duration, 50, "start of cut: the outgoing tail (150) allows 50");
  const en = addTransition(s, ctx, vt, 100, "fade", 50, { alignment: "end" });
  assert.equal(en.seq.transitions[0].duration, 10, "end of cut: the incoming head (10)");
  // a cut without handles at all repeats frames instead (up to the clips' length)
  let s2 = put(p, seqOf(p), "m1", 0, { in: 150, out: 249 });
  s2 = put(p, s2, "m2", 100, { in: 0, out: 99 });
  assert.equal(addTransition(s2, ctx, vt, 100, "fade", 30).seq.transitions[0].duration, 30);
  // the transition follows a ripple and goes away when the cut does
  const [a] = on(r.seq, vt);
  const rip = trimClip(r.seq, ctx, a.id, "end", -20, { ripple: true });
  assert.equal(rip.transitions[0].at, 80);
  const gone = moveClips(r.seq, ctx, withLinked(r.seq, [a.id]), 0, { video: 1, audio: 0 });
  assert.equal(gone.transitions.length, 0);
  // an edge (fade in) on the first clip
  const edge = addTransition(s, ctx, vt, 0, "fade", 25);
  assert.equal(edge.seq.transitions[0].alignment, "start");
  assert.equal(edge.seq.transitions[0].toClipId, a.id);
  // Ctrl+D on the cut nearest the playhead
  const d = applyDefaultTransition(s, ctx, "video", "fade", 20, 95);
  assert.equal(d.transitions.length, 1);
  assert.equal(d.transitions[0].at, 100);
  // razor moves the outgoing side of a transition onto the right half
  const cut = razor(r.seq, ctx, 50, { trackIds: [vt] });
  assert.equal(cut.transitions.length, 1);
  assert.equal(cut.transitions[0].fromClipId, on(cut, vt)[1].id);
});

test("copy / paste overwrite and insert; paste attributes", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 49 });
  const cb = copyClips(s, withLinked(s, [on(s, V(s, 0).id)[0].id]))!;
  const pasted = pasteClips(s, ctx, cb, 25, "overwrite");
  assert.deepEqual(spans(pasted.seq, V(s, 0).id), [[0, 25], [25, 75]]);
  const ins = pasteClips(s, ctx, cb, 25, "insert");
  assert.deepEqual(spans(ins.seq, V(s, 0).id), [[0, 25], [25, 75], [75, 100]]);
  const src = on(s, V(s, 0).id)[0];
  const styled = updateParam(s, ctx, src.id, "motion.scale", () => ({ value: 50 }));
  s = put(p, styled, "m2", 100, { in: 0, out: 49 });
  const tgt = on(s, V(s, 0).id)[1];
  const pa = pasteAttributes(s, ctx, on(s, V(s, 0).id)[0], [tgt.id]);
  assert.equal(on(pa, V(s, 0).id)[1].motion.scale.value, 50);
});

test("tracks: add, remove (keeps one of each), rename indexes", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = seqOf(p);
  const added = addTrack(s, "video", 0);
  s = added.seq;
  assert.equal(V(s, 0).id, added.trackId);
  assert.deepEqual(s.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index).map((t) => t.name), ["V1", "V2", "V3", "V4"]);
  s = removeTrack(s, ctx, added.trackId);
  for (let i = 0; i < 5; i++) s = removeTrack(s, ctx, V(s, 0).id);
  assert.equal(s.tracks.filter((t) => t.kind === "video").length, 1);
});

test("mark clip (X) and nest (Ctrl+Shift+N)", () => {
  const p = project();
  let s = put(p, seqOf(p), "m1", 10, { in: 0, out: 49 });
  s = markClip(s, 20);
  assert.equal(s.inPoint, 10);
  assert.equal(s.outPoint, 59);
  p.sequences = [s];
  const ids = s.clips.map((c) => c.id);
  const n = nestClips(p, s.id, ids, "Nest");
  assert.ok(n.sequenceId);
  const outer = n.project.sequences.find((x) => x.id === s.id)!;
  assert.equal(outer.clips.length, 2);
  assert.ok(outer.clips.every((c) => c.source.type === "nested" && c.start === 10 && c.duration === 50));
  const inner = n.project.sequences.find((x) => x.id === n.sequenceId)!;
  assert.deepEqual(inner.clips.map((c) => c.start), [0, 0]);
});

test("clearRange trims and splits", () => {
  const p = project(); const ctx = ctxOf(p);
  const s = put(p, seqOf(p), "m1", 0);
  const vt = V(s, 0).id;
  const r = clearRange(s, ctx, vt, 40, 60);
  const cs = on(r, vt);
  assert.deepEqual(cs.map((c) => [c.start, clipEnd(c)]), [[0, 40], [60, 250]]);
  assert.equal(cs[1].source.type === "media" && cs[1].source.in, 60);
});

test("audio media counted in samples: spans, handles and trims in sequence frames", () => {
  const p = project();
  p.media = p.media.map((m) => (m.id === "music" ? { ...m, fps: 48000, duration: 48000 * 60 } : m));
  const ctx = ctxOf(p);
  const s = put(p, seqOf(p), "music", 0, { in: 48000 * 10, out: 48000 * 20 - 1 }, 0, 0, true);
  const c = on(s, A(s, 0).id)[0];
  assert.equal(c.duration, 250, "10 s at 25 fps");
  assert.deepEqual(handles(c, s, ctx), { head: 250, tail: 1000 });
  const t = on(trimClip(s, ctx, c.id, "start", 25), A(s, 0).id)[0];
  assert.equal(t.source.type === "media" && t.source.in, 48000 * 11);
});
