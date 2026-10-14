/**
 * Auto mix (editor/audiotools/automix.ts): the role of each clip, the target per role (dialogue at the platform
 * target, music −10 LU, SFX −6 LU, ambience −14 LU under it), the track volume, the ±12 dB cap, keyframed levels,
 * room tone following its dialogue, ducking and the one-step apply.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAutoMix, AUTO_MIX_CAP, planAutoMix, ROLE_OFFSETS, roleOf } from "../audiotools/automix.ts";
import { baseClip, newTrack } from "../model/defaults.ts";
import { ctxOf, normalize } from "../model/ops.ts";
import type { EditProject, Sequence, TimelineClip } from "../model/types.ts";
import { project, seqOf } from "./fixtures.ts";

function mix(): { p: EditProject; s: Sequence; ids: Record<string, string> } {
  const p = project();
  const s0 = seqOf(p);
  const video = s0.tracks.filter((t) => t.kind === "video");
  const tracks = [...video, newTrack("audio", 0, { name: "Dialogue" }), newTrack("audio", 1, { name: "Music", volume: -2 }), newTrack("audio", 2, { name: "SFX" }),
    newTrack("audio", 3, { name: "A4" }), newTrack("audio", 4, { name: "A5", role: "ambience" })];
  const [dlg, mus, sfx, a4, a5] = tracks.slice(video.length);
  const s1 = { ...s0, tracks };
  const clip = (tid: string, at: number, mediaId: string, name: string, extra: Partial<TimelineClip> = {}) => ({ ...baseClip(s1, tid, at, 50, { type: "media", mediaId, in: 0 }, name), ...extra });
  const clips = [
    clip(dlg.id, 0, "m1", "Host"), clip(dlg.id, 60, "m2", "Guest"),
    clip(mus.id, 0, "music", "Bed"),
    clip(sfx.id, 10, "m1", "Whoosh"),
    clip(a4.id, 0, "m2", "Tagged room", { role: "ambience" }),
    clip(a4.id, 60, "m2", "Untagged"),                                  // A4: no role anywhere
    clip(a5.id, 0, "m1", "Rain"),
    clip(dlg.id, 50, "m1", "Room tone", { roomTone: true }),
  ];
  const s = normalize({ ...s1, clips }, ctxOf(p));
  p.sequences = [s];
  const ids = Object.fromEntries(s.clips.map((c) => [c.name, c.id]));
  return { p, s, ids };
}

test("roles: the clip's tag, else its track's, else the track name's guess", () => {
  const { s, ids } = mix();
  const r = (n: string) => roleOf(s, s.clips.find((c) => c.id === ids[n])!);
  assert.equal(r("Host"), "dialogue"); assert.equal(r("Bed"), "music"); assert.equal(r("Whoosh"), "sfx");
  assert.equal(r("Tagged room"), "ambience"); assert.equal(r("Rain"), "ambience"); assert.equal(r("Untagged"), undefined);
});

test("targets per role, the track volume counted, ±12 dB cap, the dry run before anything changes", () => {
  const { s, ids } = mix();
  const measured = { [ids.Host]: -20, [ids.Guest]: -30, [ids.Bed]: -12, [ids.Whoosh]: -18, [ids["Tagged room"]]: -40, [ids.Untagged]: -20, [ids.Rain]: -35 };
  const plan = planAutoMix(s, measured, { target: -14 });
  const row = (n: string) => plan.rows.find((x) => x.clipId === ids[n])!;
  // dialogue at −14: −20 needs +6, −30 would need +16 → capped at +12
  assert.equal(row("Host").after, 6); assert.equal(row("Host").target, -14); assert.equal(row("Host").result, -14);
  assert.equal(row("Guest").after, AUTO_MIX_CAP); assert.ok(row("Guest").capped); assert.equal(row("Guest").result, -18);
  // music 10 LU under: −24, on a track at −2 dB: −24 − (−12) − (−2) = −10
  assert.equal(row("Bed").target, -14 + ROLE_OFFSETS.music); assert.equal(row("Bed").after, -10); assert.equal(row("Bed").result, -24);
  // SFX 6 LU under: −20 → −2; ambience 14 LU under: −28 → +12 and +7
  assert.equal(row("Whoosh").after, -2); assert.equal(row("Whoosh").target, -20);
  assert.equal(row("Tagged room").after, 12); assert.equal(row("Rain").after, 7); assert.equal(row("Rain").target, -28);
  // the untagged clip is skipped with its reason; room tone follows its dialogue (same media, m1 → Host)
  assert.ok(plan.skipped.some((x) => x.clipId === ids.Untagged && /role/i.test(x.reason)));
  assert.equal(row("Room tone").after, row("Host").after); assert.equal(row("Room tone").measured, null);
  assert.ok(plan.ducking);
  // a dry run: the sequence itself is untouched
  assert.ok(s.clips.every((c) => (c.audio?.gain.value ?? 0) === 0));
  // another platform target moves every role with it
  const ebu = planAutoMix(s, measured, { target: -23 });
  assert.equal(ebu.rows.find((x) => x.clipId === ids.Host)!.after, -3);
  // music at −33 would need −19 dB: held at the cap
  assert.equal(ebu.rows.find((x) => x.clipId === ids.Bed)!.after, -AUTO_MIX_CAP);
  assert.ok(ebu.rows.find((x) => x.clipId === ids.Bed)!.capped);
});

test("unmeasurable clips are left alone; no music means no ducking", () => {
  const { s, ids } = mix();
  const plan = planAutoMix(s, { [ids.Host]: null, [ids.Guest]: -75, [ids.Whoosh]: -18 }, { target: -14 });
  assert.deepEqual(plan.rows.map((r) => r.clipId).sort(), [ids.Whoosh].sort());
  assert.ok(plan.skipped.some((x) => x.clipId === ids.Host) && plan.skipped.some((x) => x.clipId === ids.Guest));
  assert.equal(plan.ducking, false);
  // only the selected clips
  const sel = planAutoMix(s, { [ids.Host]: -20, [ids.Bed]: -12 }, { target: -14, ids: [ids.Host] });
  assert.deepEqual(sel.rows.filter((r) => !r.note).map((r) => r.clipId), [ids.Host]);
});

test("apply: gains set (keyframed levels keep their shape), roles written for the export's ducking", () => {
  const { p, s, ids } = mix();
  const ducked = {
    ...s, clips: s.clips.map((c) => (c.id === ids.Bed ? { ...c, audio: { ...c.audio!, gain: { value: -3, keyframes: [{ frame: 0, value: -3, ease: "linear" as const }, { frame: 20, value: -15, ease: "linear" as const }] } } } : c)),
  };
  const plan = planAutoMix(ducked, { [ids.Host]: -20, [ids.Bed]: -12 }, { target: -14 });
  const out = applyAutoMix(ducked, ctxOf(p), plan);
  const c = (n: string) => out.clips.find((x) => x.id === ids[n])!;
  assert.equal(c("Host").audio!.gain.value, 6);
  assert.equal(c("Host").role, "dialogue"); assert.equal(c("Bed").role, "music");
  // the duck moved as a whole: its first key lands on the planned level, the 12 dB dip stays
  assert.deepEqual(c("Bed").audio!.gain.keyframes!.map((k) => k.value), [-10, -22]);
  assert.equal(c("Room tone").audio!.gain.value, 6);
  assert.equal(c("Room tone").role, undefined);
  // what the plan didn't touch stays as it was
  assert.deepEqual(c("Untagged"), ducked.clips.find((x) => x.id === ids.Untagged));
});
