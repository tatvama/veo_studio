import assert from "node:assert/strict";
import { test } from "node:test";
import { MOODS, moodById, moodEffects, moodForEmotion, moodShotFx, scaleParam } from "../../lib/moods.ts";
import { applyMood, clipMood, isMoodEffect, removeMood } from "../moods/apply.ts";
import { sceneRanges } from "../moods/scenes.ts";
import { ctxOf } from "../model/ops.ts";
import { project, put, seqOf, V } from "./fixtures.ts";

test("16+ moods, each with effects, transitions, a title style, music and pacing", () => {
  assert.ok(MOODS.length >= 16);
  const want = ["romantic", "thriller", "horror", "nostalgic", "dreamy", "epic", "devotional", "festival", "monsoon", "noir", "comedy", "documentary", "action", "melancholy", "summer", "cyberpunk"];
  for (const id of want) assert.ok(moodById(id), id);
  assert.equal(new Set(MOODS.map((m) => m.id)).size, MOODS.length);
  for (const m of MOODS) {
    assert.ok(m.effects.length > 0 && m.transition.ids.length > 0 && m.music && m.pacing.avgShot > 0 && m.title.font, m.id);
  }
});

test("intensity scales toward neutral: 0 is neutral, 1 as designed, 1.5 clamped", () => {
  assert.equal(scaleParam("adjust", "contrast", 0.4, 0), 0);
  assert.equal(scaleParam("adjust", "contrast", 0.4, 0.5), 0.2);
  assert.equal(scaleParam("adjust", "contrast", 0.4, 1), 0.4);
  assert.equal(scaleParam("adjust", "contrast", 0.8, 1.5), 1);         // clamped to the range
  assert.equal(scaleParam("look", "lut_strength", 0.8, 0.5), 0.4);
  assert.equal(scaleParam("look", "look", "warm", 0), "warm");           // strings never scale
  assert.deepEqual(scaleParam("wheels", "lift", [0.1, -0.2, 0], 0.5), [0.05, -0.1, 0]);
  assert.deepEqual(scaleParam("simple_adjustment", "gamma", 1.4, 0.5), 1.2); // neutral 1
  // curves move toward the diagonal
  assert.deepEqual(scaleParam("curves", "master", [[0, 0.1], [1, 0.9]], 0), [[0, 0], [1, 1]]);
  assert.deepEqual(scaleParam("curves", "master", [[0, 0.1], [1, 0.9]], 0.5), [[0, 0.05], [1, 0.95]]);
  // unknown params are left as they are
  assert.equal(scaleParam("glow", "threshold", 0.6, 0), 0.6);
  const neutral = moodEffects(moodById("thriller")!, 0);
  const adj = neutral.find((e) => e.type === "adjust")!;
  assert.ok(Object.values(adj.params).every((v) => v === 0));
});

test("scene emotions map to moods", () => {
  assert.equal(moodForEmotion("quiet grief after the funeral")?.id, "melancholy");
  assert.equal(moodForEmotion("A joyful wedding celebration")?.id, "festival");
  assert.equal(moodForEmotion("tense chase through the market")?.id, "thriller");
  assert.equal(moodForEmotion("डर")?.id, "horror");
  assert.equal(moodForEmotion(""), null);
  assert.equal(moodForEmotion("zzz qqq"), null);
});

test("a mood's studio fx keeps the FFmpeg-drawable keys", () => {
  const fx = moodShotFx(moodById("noir")!, 1);
  assert.equal(fx.look, "noir");
  assert.ok((fx.adjust as Record<string, number>).contrast > 0);
  assert.ok((fx.adjust as Record<string, number>).vignette > 0);  // the vignette effect folds into adjust
});

test("applying a mood replaces the earlier one, adds transitions at the cuts, in one sequence change", () => {
  const p = project();
  let s = seqOf(p);
  s = put(p, s, "m1", 0, { in: 0, out: 49 });
  s = put(p, s, "m2", 50, { in: 0, out: 49 });
  const ctx = ctxOf({ ...p, sequences: [s] });
  const v1 = s.clips.filter((c) => c.trackId === V(s, 0).id).map((c) => c.id);
  const r1 = applyMood(s, ctx, moodById("romantic")!, { kind: "clips", ids: v1 }, { intensity: 1, transitions: true });
  assert.equal(r1.clips, 2);
  assert.equal(r1.cuts, 1);
  assert.equal(r1.seq.transitions.length, 1);
  assert.equal(r1.seq.transitions[0].type, "fade");
  const c0 = r1.seq.clips.find((c) => c.id === v1[0])!;
  assert.equal(clipMood(c0), "romantic");
  assert.equal(c0.effects.length, moodById("romantic")!.effects.length);
  // a second mood swaps the chain (no stacking) and keeps the user's own effects after it
  const withMine = { ...r1.seq, clips: r1.seq.clips.map((c) => (c.id === v1[0] ? { ...c, effects: [...c.effects, { id: "e_user", type: "pixelate", enabled: true, params: {} }] } : c)) };
  const r2 = applyMood(withMine, ctx, moodById("noir")!, { kind: "sequence" }, { intensity: 0.5 });
  const c1 = r2.seq.clips.find((c) => c.id === v1[0])!;
  assert.equal(clipMood(c1), "noir");
  assert.equal(c1.effects.filter(isMoodEffect).length, moodById("noir")!.effects.length);
  assert.equal(c1.effects[c1.effects.length - 1].id, "e_user");
  const look = c1.effects.find((e) => e.type === "look")!;
  assert.equal(look.params.lut_strength.value, 0.5);
  // audio clips are never touched
  assert.ok(r2.seq.clips.filter((c) => !v1.includes(c.id)).every((c) => !c.effects.some(isMoodEffect)));
  const r3 = removeMood(r2.seq, ctx, { kind: "sequence" });
  assert.equal(r3.clips, 2);
  assert.ok(r3.seq.clips.every((c) => !c.effects.some(isMoodEffect)));
});

test("scenes become ranges between their markers, with a suggested mood", () => {
  const p = project();
  let s = seqOf(p);
  s = put(p, s, "m1", 0, { in: 0, out: 99 });
  s = { ...s, markers: [{ id: "k1", frame: 0, duration: 0, name: "Scene 1: The wedding", color: "#fff" }, { id: "k2", frame: 60, duration: 0, name: "Scene 2", color: "#fff" }] };
  const r = sceneRanges(s, [{ id: 11, order: 1, emotion: "joyful celebration" }, { id: 12, order: 2, emotion: "grief" }], { 12: { mood: "noir", why: "AI" } });
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].from, r[0].to, r[1].from, r[1].to], [0, 60, 60, 100]);
  assert.equal(r[0].suggested?.id, "festival");
  assert.equal(r[1].suggested?.id, "noir");   // the AI's suggestion wins
});
