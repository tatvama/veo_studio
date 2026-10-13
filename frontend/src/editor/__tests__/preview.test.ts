/**
 * The preview cards' pure parts (preview-polish): which sample an item shows and which of the user's clips wins,
 * the Ken Burns crop, the cache key and size buckets, the idle scheduler's budget, the procedural audio samples
 * (deterministic, levelled) and the hover-scrub mapping (pointer x → progress, a title's in → hold → out, loops).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { audioSample, musicLoop, sampleKindFor, voicePhrase, SAMPLE_LUFS, SAMPLE_RATE, SAMPLE_SECONDS } from "../preview/audioSample.ts";
import { digest, sizeBucket, sourceKey, stableStringify, thumbKey, versionOf, PREVIEW_RENDER_VERSION } from "../preview/keys.ts";
import { coverCrop, kbPhase, kenBurns, nextClipOnTrack, pickUserClip, sampleById, sampleFor, samplePair, SAMPLE_IDS, SAMPLES } from "../preview/samples.ts";
import { IdleScheduler, type IdleDeadlineLike } from "../preview/scheduler.ts";
import { cardParams, loopIndex, scrubProgress, stripIndex, stripTimes, titleTimeAt, titleTiming } from "../preview/scrub.ts";
import { integratedLufs, truePeakDb } from "../sfx/level.ts";
import { put, project, seqOf, V } from "./fixtures.ts";

// ── the sample library ──────────────────────────────────────────────────────────────────────────────────

test("samples: the six showreel stills, licence-clean local files", () => {
  assert.deepEqual([...SAMPLE_IDS].sort(), ["backwaters", "dance", "holi", "lamp", "monsoon", "nightshoot"]);
  for (const s of SAMPLES) {
    assert.equal(s.url, `/showcase/${s.id}.webp`);
    assert.equal(s.smUrl, `/showcase/${s.id}-sm.webp`);
    assert.ok(s.kb.z0 >= 1 && s.kb.z1 >= 1 && s.kb.z1 <= 1.15 && s.kb.z0 <= 1.15, `${s.id} zooms gently`);
  }
  assert.equal(sampleById("lamp")?.label, "The lamp");
});

test("samples: moods map to the pictures that fit them", () => {
  const want: Record<string, string[]> = {
    horror: ["nightshoot", "lamp"], thriller: ["nightshoot", "lamp"], romantic: ["backwaters"], dreamy: ["backwaters"], devotional: ["lamp"],
    festival: ["holi"], joyful: ["holi"], epic: ["monsoon"], dance: ["dance"], music_video: ["dance"],
  };
  for (const [id, ok] of Object.entries(want)) {
    assert.ok(ok.includes(sampleFor(id)), `${id} → ${sampleFor(id)}`);
    assert.ok(ok.includes(sampleFor(`mood.${id}`)), `mood.${id}`);
  }
  // look packs and templates go by their words; anything else gets a stable pick
  assert.equal(sampleFor("look.music_video.neon_pop", "Neon pop"), "nightshoot");
  assert.equal(sampleFor("look.wedding.soft_glow", "Soft glow wedding"), "backwaters");
  assert.equal(sampleFor("title.headline.cinematic.fade", "Headlines Cinematic"), sampleFor("title.headline.cinematic.fade", "Headlines Cinematic"));
  const odd = sampleFor("zz.qq.42");
  assert.ok(SAMPLE_IDS.includes(odd));
  assert.equal(sampleFor("zz.qq.42"), odd, "stable per item");
  const spread = new Set(Array.from({ length: 60 }, (_, i) => sampleFor(`x${i}`)));
  assert.ok(spread.size >= 4, "unknown items spread over the samples");
});

test("samples: a transition's A and B are two different samples, stable per id", () => {
  for (const id of ["fade", "wipeleft", "gl:CrossZoom", "tv:clock", "tv:ink_bleed", "custom:mine"]) {
    const [a, b] = samplePair(id);
    assert.notEqual(a, b, id);
    assert.deepEqual(samplePair(id), [a, b]);
  }
});

test("samples: the Ken Burns move ping-pongs over 3 s and the crop stays inside the picture", () => {
  assert.equal(kbPhase(0), 0);
  assert.equal(kbPhase(3), 1);
  assert.equal(kbPhase(6), 0);
  assert.ok(Math.abs(kbPhase(1.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(kbPhase(4.5) - 0.5) < 1e-9, "on the way back");
  const kb = sampleById("lamp")!.kb;
  const a = kenBurns(kb, 0), b = kenBurns(kb, 3);
  assert.equal(a.zoom, kb.z0); assert.equal(b.zoom, kb.z1);
  for (const t of [0, 0.7, 1.5, 2.2, 3, 4.1]) {
    const m = kenBurns(kb, t), r = coverCrop(720, 402, 256, 144, m.zoom, m.cx, m.cy);
    assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= 720 + 1e-9 && r.sy + r.sh <= 402 + 1e-9, `t=${t}`);
    assert.ok(Math.abs(r.sw / r.sh - 16 / 9) < 1e-6, "16:9 crop");
  }
  // a portrait picture into a landscape frame crops its height
  const p = coverCrop(1080, 1920, 160, 90);
  assert.equal(p.sw, 1080);
  assert.ok(Math.abs(p.sh - 607.5) < 1e-9);
});

test("samples: the user's clip wins — the selected clip, else V1 under the playhead, else the first V1 clip", () => {
  const p = project();
  let s = seqOf(p);
  assert.equal(pickUserClip(s, [], 0), null, "no video clips: the samples");
  s = put(p, s, "m1", 0);          // V1 0–250
  s = put(p, s, "m2", 250);        // V1 250–500
  s = put(p, s, "still", 100, undefined, 1, 0, false);   // V2 over the first clip
  const v1 = s.clips.filter((c) => c.trackId === V(s, 0).id).sort((a, b) => a.start - b.start);
  const v2 = s.clips.find((c) => c.trackId === V(s, 1).id)!;
  assert.equal(pickUserClip(s, [], 300)?.id, v1[1].id, "V1 under the playhead");
  assert.equal(pickUserClip(s, [], 120)?.id, v1[0].id, "V1 wins over V2 under the playhead");
  assert.equal(pickUserClip(s, [], 9999)?.id, v1[0].id, "else the first V1 clip");
  assert.equal(pickUserClip(s, [v2.id], 300)?.id, v2.id, "the selection wins");
  const audioOnly = s.clips.find((c) => c.trackId !== V(s, 0).id && c.trackId !== V(s, 1).id)!;
  assert.equal(pickUserClip(s, [audioOnly.id], 300)?.id, v1[1].id, "a selected audio clip isn't a picture");
  assert.equal(nextClipOnTrack(s, v1[0])?.id, v1[1].id, "a transition's B side");
  assert.equal(nextClipOnTrack(s, v1[1]), null);
});

// ── cache keys ──────────────────────────────────────────────────────────────────────────────────────────

test("cache key: item, version, frame source and size, with the renderer's version", () => {
  const base = { kind: "chain", id: "mood.horror", version: versionOf({ fx: [{ type: "look", params: { look: "noir" } }] }), source: { kind: "sample" as const, id: "lamp" }, w: 256, h: 144 };
  const k = thumbKey(base);
  assert.ok(k.startsWith(`r${PREVIEW_RENDER_VERSION}|chain|mood.horror|`));
  assert.ok(k.includes("|s:lamp|256x144"));
  assert.equal(thumbKey({ ...base }), k, "stable");
  for (const change of [{ id: "mood.thriller" }, { version: "x" }, { source: { kind: "sample" as const, id: "holi" } }, { w: 320, h: 180 }, { kind: "transition" }, { variant: "f3" }]) {
    assert.notEqual(thumbKey({ ...base, ...change }), k, JSON.stringify(change));
  }
  // the user's clip: media and time (to 0.1 s); a transition: both sides
  assert.equal(sourceKey({ kind: "clip", mediaId: "m1", t: 2.04 }), "c:m1@2.0");
  assert.equal(sourceKey({ kind: "clip", mediaId: "m1", t: 2.04 }), sourceKey({ kind: "clip", mediaId: "m1", t: 1.96 }));
  assert.notEqual(sourceKey({ kind: "clip", mediaId: "m1", t: 2 }), sourceKey({ kind: "clip", mediaId: "m2", t: 2 }));
  assert.equal(sourceKey({ kind: "pair", a: { kind: "sample", id: "holi" }, b: { kind: "clip", mediaId: "m2", t: 0 } }), "p:(s:holi)(c:m2@0.0)");
});

test("cache key: versions ignore key order and float noise, and see real changes", () => {
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
  assert.equal(versionOf({ amount: 0.1 + 0.2 }), versionOf({ amount: 0.3 }));
  assert.notEqual(versionOf({ amount: 0.3 }), versionOf({ amount: 0.31 }));
  assert.equal(stableStringify({ a: undefined, b: 2 }), stableStringify({ b: 2 }));
  assert.match(digest("hello"), /^[0-9a-z]+$/);
  assert.notEqual(digest("hello"), digest("hellp"));
});

test("cache key: DPR-aware 16:9 size buckets", () => {
  assert.deepEqual(sizeBucket(148, 1), { w: 160, h: 90 });
  assert.deepEqual(sizeBucket(148, 2), { w: 320, h: 180 });
  assert.deepEqual(sizeBucket(148, 1.25), { w: 192, h: 108 });
  assert.deepEqual(sizeBucket(40, 1), { w: 96, h: 54 });
  assert.deepEqual(sizeBucket(5000, 2), { w: 640, h: 360 }, "capped");
  assert.equal(sizeBucket(150, 1).w, sizeBucket(152, 1).w, "nearby widths share renders");
});

// ── the idle scheduler ──────────────────────────────────────────────────────────────────────────────────

/** A hand-driven clock and idle callback; each job costs `cost` ms. */
function rig(cost = 4) {
  let now = 0;
  const idles: ((d: IdleDeadlineLike) => void)[] = [];
  const s = new IdleScheduler({ now: () => now, requestIdle: (cb) => { idles.push(cb); } }, { maxPerIdle: 3, budgetMs: 8, reserveMs: 2 });
  const ran: string[] = [];
  const job = (key: string, priority = 1, wanted?: () => boolean) => ({ key, priority, wanted, run: () => { now += cost; ran.push(key); } });
  /** Runs the next idle callback with `left` ms of idle time. */
  const idle = async (left: number, didTimeout = false) => {
    const cb = idles.shift();
    assert.ok(cb, "an idle callback is waiting");
    const end = now + left;
    let done = 0;
    const before = ran.length;
    cb({ timeRemaining: () => Math.max(0, end - now), didTimeout });
    await new Promise((r) => setTimeout(r, 0));
    done = ran.length - before;
    return done;
  };
  return { s, ran, job, idle, idles, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}

test("idle scheduler: a few jobs per idle callback, within the budget", async () => {
  const r = rig(4);
  for (let i = 0; i < 7; i++) r.s.add(r.job(`j${i}`));
  assert.equal(await r.idle(50), 2, "8 ms of work (two 4 ms jobs), not the whole 50 ms");
  assert.equal(await r.idle(50), 2);
  const r2 = rig(1);
  for (let i = 0; i < 9; i++) r2.s.add(r2.job(`k${i}`));
  assert.equal(await r2.idle(50), 3, "at most maxPerIdle");
  assert.equal(await r2.idle(3), 1, "a short idle period: what fits before the reserve");
  assert.equal(await r2.idle(1), 0, "under the reserve: nothing (typing and scrolling come first)");
  assert.equal(await r2.idle(0, true), 3, "a timed-out callback still runs a small slice");
  assert.ok(r2.idles.length >= 1, "more is scheduled while jobs remain");
});

test("idle scheduler: a busy page with only slivers of idle time still fills in", async () => {
  const r = rig(2);
  for (let i = 0; i < 4; i++) r.s.add(r.job(`b${i}`));
  r.advance(500);                      // nothing has run for a while
  assert.ok((await r.idle(1)) >= 1, "starving: a slice runs even in a 1 ms idle period");
  assert.equal(await r.idle(1), 0, "then the reserve again");
  r.advance(200);
  assert.ok((await r.idle(0.5)) >= 1);
});

test("idle scheduler: while the user types or scrolls only real idle time is used; once they stop, a job a callback", async () => {
  let now = 0, busy = true;
  const idles: ((d: IdleDeadlineLike) => void)[] = [];
  const s = new IdleScheduler({ now: () => now, busy: () => busy, requestIdle: (cb) => { idles.push(cb); } }, { maxPerIdle: 3, budgetMs: 8, reserveMs: 2 });
  let ran = 0;
  for (let i = 0; i < 6; i++) s.add({ key: `q${i}`, priority: 1, run: () => { now += 20; ran++; } });
  const idle = async (left: number, didTimeout = false) => { const end = now + left; idles.shift()!({ timeRemaining: () => Math.max(0, end - now), didTimeout }); await new Promise((r) => setTimeout(r, 0)); };
  now = 1000;
  await idle(1.5); await idle(1.5, true);
  assert.equal(ran, 0, "typing: a 20 ms render never runs in a 1.5 ms sliver, starving or not");
  busy = false;
  await idle(1.5);
  assert.equal(ran, 1, "quiet: one render per callback, even in a sliver of a 144 Hz frame");
  await idle(1.5);
  assert.equal(ran, 2);
});

test("idle scheduler: the hovered card first, gone cards dropped, keys deduped", async () => {
  const r = rig(1);
  let visible = true;
  r.s.add(r.job("still-a", 10));
  r.s.add(r.job("strip-0", 100));
  r.s.add(r.job("offscreen", 10, () => visible));
  r.s.add(r.job("still-b", 10));
  r.s.add(r.job("still-a", 50));   // asked again, higher: one job, raised
  assert.equal(r.s.pending, 4);
  visible = false;
  await r.idle(50);
  await r.idle(50);
  assert.deepEqual(r.ran, ["strip-0", "still-a", "still-b"]);
  assert.equal(r.s.stats.dropped, 1);
  assert.equal(r.s.pending, 0);
});

// ── the procedural audio samples ────────────────────────────────────────────────────────────────────────

const hashOf = (ch: Float32Array[]) => { const h = createHash("sha256"); for (const c of ch) h.update(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)); return h.digest("hex"); };

test("audio samples: a music loop and a voice-like phrase, 4 s stereo, deterministic", () => {
  for (const [name, f] of [["music", musicLoop], ["voice", voicePhrase]] as const) {
    const a = f(SAMPLE_RATE), b = f(SAMPLE_RATE);
    assert.equal(a.length, 2, name);
    assert.equal(a[0].length, SAMPLE_SECONDS * SAMPLE_RATE, `${name}: 4 s`);
    assert.equal(hashOf(a), hashOf(b), `${name}: the same samples every render`);
    assert.ok(a[0].every(Number.isFinite), `${name}: no NaN`);
  }
  assert.notEqual(hashOf(musicLoop()), hashOf(voicePhrase()));
  assert.equal(audioSample("music"), audioSample("music"), "cached");
});

test("audio samples: levelled to −18 LUFS, true peak under −1 dBTP, a real phrase with pauses", () => {
  for (const ch of [musicLoop(), voicePhrase()]) {
    const L = integratedLufs(ch, SAMPLE_RATE);
    assert.ok(Math.abs(L - SAMPLE_LUFS) < 0.3, `${L.toFixed(2)} LUFS`);
    assert.ok(truePeakDb(ch) <= -1, `${truePeakDb(ch).toFixed(2)} dBTP`);
  }
  // the voice: syllables (loud) and a breath between the phrases (quiet), mono like dialogue
  const v = voicePhrase();
  const rms = (a: number, b: number) => { let s = 0; for (let i = Math.round(a * SAMPLE_RATE); i < Math.round(b * SAMPLE_RATE); i++) s += v[0][i] * v[0][i]; return Math.sqrt(s / ((b - a) * SAMPLE_RATE)); };
  assert.ok(rms(0.4, 1.2) > 10 * rms(3.3, 3.9), "speech, then silence at the end");
  assert.ok(v[0].every((x, i) => x === v[1][i]), "centred");
  // the music loops: its end flows into its start (no click at the wrap)
  const m = musicLoop();
  const n = m[0].length;
  assert.ok(Math.abs(m[0][n - 1] - m[0][0]) < 0.5);
});

test("audio samples: voice tools get the voice, the rest the music", () => {
  assert.equal(sampleKindFor("deesser"), "voice");
  assert.equal(sampleKindFor("telephone"), "voice");
  assert.equal(sampleKindFor("reverb"), "voice");
  assert.equal(sampleKindFor("compressor"), "music");
  assert.equal(sampleKindFor("bitcrusher"), "music");
  assert.equal(sampleKindFor("preset:lofi_radio", "Creative"), "music");
  assert.equal(sampleKindFor("preset:phone_call", "Voice"), "voice");
  assert.equal(sampleKindFor("radio", "Modulation & creative"), "voice");
  assert.equal(sampleKindFor("youtube_voice", "Voice"), "voice");
  assert.equal(sampleKindFor("master_gentle", "Music"), "music");
  assert.equal(sampleKindFor("denoise", "Clean-up"), "voice");
});

// ── the hover-scrub mapping ─────────────────────────────────────────────────────────────────────────────

test("hover scrub: pointer x across a card → progress, with easy ends", () => {
  assert.equal(scrubProgress(100, 100, 200), 0, "the left edge");
  assert.equal(scrubProgress(105, 100, 200), 0, "inside the left dead zone");
  assert.equal(scrubProgress(300, 100, 200), 1, "the right edge");
  assert.equal(scrubProgress(296, 100, 200), 1, "inside the right dead zone");
  assert.ok(Math.abs(scrubProgress(200, 100, 200) - 0.5) < 1e-9, "the middle");
  assert.equal(scrubProgress(-50, 100, 200), 0, "clamped");
  assert.equal(scrubProgress(900, 100, 200), 1, "clamped");
  assert.equal(scrubProgress(150, 100, 0), 0, "a card with no width");
  let last = -1;
  for (let x = 100; x <= 300; x += 5) { const p = scrubProgress(x, 100, 200); assert.ok(p >= last); last = p; }
  assert.equal(stripIndex(0, 17), 0);
  assert.equal(stripIndex(1, 17), 16);
  assert.equal(stripIndex(0.5, 17), 8);
  assert.equal(stripIndex(0.5, 1), 0);
});

test("hover scrub: a title's in → hold → out, its hold pose for the still", () => {
  const spec = { text: "Big News", look: { in: "rise", out: "fade" } } as const;
  const tm = titleTiming(spec as never, 4);
  assert.equal(tm.inEnd, 0.5);
  assert.equal(tm.outStart, 3.5);
  assert.ok(tm.hold > tm.inEnd && tm.hold < tm.outStart, "the still is fully in, not frame 0");
  assert.equal(titleTimeAt(0, 4, tm.inEnd, tm.outStart), 0);
  assert.equal(titleTimeAt(0.3, 4, tm.inEnd, tm.outStart), 0.5, "the first 30 %: the entrance");
  assert.equal(titleTimeAt(0.7, 4, tm.inEnd, tm.outStart), 3.5, "the middle 40 %: the hold");
  assert.equal(titleTimeAt(1, 4, tm.inEnd, tm.outStart), 4, "the last 30 %: the exit");
  assert.equal(titleTiming({ text: "x" } as never, 4).inEnd, 0, "no animation: in at once");
  const tw = titleTiming({ text: "The quick brown fox jumps", look: { in: "typewriter" } } as never, 5);
  assert.ok(tw.inEnd >= 0.5 && tw.inEnd <= 2, "typewriter takes its typing time");
  assert.equal(titleTiming({ text: "x", look: { in: "fade", inDur: 1.2 } } as never, 4).inEnd, 1.2, "a template's own in duration");
});

test("hover scrub: held cards loop at 15 fps; strips cover their span", () => {
  assert.equal(loopIndex(0, 10), 0);
  assert.equal(loopIndex(1000 / 15 * 3, 10), 3);
  assert.equal(loopIndex(1000 / 15 * 12, 10, "loop", 4), 9, "held on the last frame");
  assert.equal(loopIndex(1000 / 15 * 14, 10, "loop", 4), 0, "then round again");
  assert.equal(loopIndex(1000 / 15 * 9, 10, "pingpong"), 9);
  assert.equal(loopIndex(1000 / 15 * 12, 10, "pingpong"), 6, "and back");
  assert.equal(loopIndex(1000 / 15 * 18, 10, "pingpong"), 0);
  const ts = stripTimes(3, 46);
  assert.equal(ts.length, 46);
  assert.equal(ts[0], 0);
  assert.ok(Math.abs(ts[45] - 3) < 1e-9);
});

test("hover scrub: an effect's card parameters go from none to a little more than the default", () => {
  const defs = [
    { name: "amount", type: "float", default: 0.5, min: 0, max: 1 },
    { name: "grain", type: "float", default: 0, min: 0, max: 1 },
    { name: "angle", type: "float", default: 30, min: 0, max: 360 },
    { name: "mode", type: "select", default: "a" },
  ];
  const none = cardParams(defs, 0), card = cardParams(defs, 1), more = cardParams(defs, 1.5);
  assert.deepEqual(none, { amount: 0, grain: 0 }, "only strength-like numbers move");
  assert.ok((card.amount as number) > 0.5 && (card.amount as number) <= 0.7, "slightly exaggerated");
  assert.equal(card.grain, 0.25, "an effect that's off by default shows at a quarter");
  assert.ok((more.amount as number) > (card.amount as number) && (more.amount as number) <= 1);
});
