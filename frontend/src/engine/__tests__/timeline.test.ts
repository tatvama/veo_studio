import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, fadeAt, sourceTime } from "../timeline.ts";
import { dimsFor, fromEpisode } from "../fromEpisode.ts";
import { fromPlan, type RenderPlan } from "../fromPlan.ts";
import type { Clip, Composition } from "../types.ts";
import type { Episode, Shot, Take } from "../../lib/types";

const close = (a: number, b: number, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);
const clip = (over: Partial<Clip> = {}): Clip => ({ id: "c", media: { url: "a.mp4", kind: "video" }, start: 0, duration: 4, in: 0, speed: 1, fit: "cover", fx: {}, ...over });

test("source time: trim, speed, reverse from in + duration·speed, clamped, holds freeze", () => {
  close(sourceTime(clip({ in: 1.5 }), 2), 3.5);
  close(sourceTime(clip({ in: 1, speed: 2 }), 1), 3);
  const r = clip({ in: 1, speed: 2, reverse: true, duration: 2 });
  close(sourceTime(r, 0), 1 + 4 - 1e-3);
  close(sourceTime(r, 0.5), 4);
  close(sourceTime(r, 2), 1);
  close(sourceTime(clip({ duration: 2 }), 5), 2 - 1e-3);  // past the end: the last frame
  close(sourceTime(clip({ duration: 3, hold: 1 }), 2.5), 2 - 1e-3);  // the hold shows the last frame
  close(sourceTime(clip({ media: { url: "", kind: "video", duration: 1.2 } }), 3), 1.2 - 1e-3);
  assert.equal(sourceTime(clip({ media: { url: "", kind: "image" } }), 3), 0);
});

test("fades: linear from black / to black like ffmpeg fade st/d", () => {
  const c = clip({ duration: 4, fx: { fade_in: 1, fade_out: 0.5 } });
  close(fadeAt(c, 0), 0); close(fadeAt(c, 0.25), 0.25); close(fadeAt(c, 2), 1); close(fadeAt(c, 3.75), 0.5); close(fadeAt(c, 4), 0);
});

const comp = (clips: Clip[], layers: Clip[] = []): Composition => ({ width: 1920, height: 1080, fps: 24, duration: 10,
  tracks: [{ id: "main", kind: "main", clips }, { id: "l", kind: "layer", clips: layers }] });

test("evaluate: one clip, then both during the transition with eased progress, layers keyframed with fades", () => {
  const a = clip({ id: "a", duration: 4 });
  const b = clip({ id: "b", start: 3, duration: 4, in: 1, transitionIn: { type: "wipeleft", duration: 1, easing: "ease_in" } });
  const l = clip({ id: "l", start: 2, duration: 2, fit: "contain", fx: { fade_in: 1 }, transform: { x: 0.5, y: 0.5, scale: 0.3, rotation: 0, opacity: 0.8,
    keyframes: [{ t: 0, x: 0 }, { t: 2, x: 1 }] } });
  const f1 = evaluate(comp([a, b], [l]), 1);
  assert.equal(f1.tracks[0].clips.length, 1); assert.equal(f1.tracks[0].clips[0].clip.id, "a"); assert.equal(f1.tracks[1].clips.length, 0);
  const f2 = evaluate(comp([a, b], [l]), 3.5);
  const tr = f2.tracks[0].transition!;
  assert.equal(tr.type, "wipeleft"); close(tr.raw, 0.5); close(tr.progress, 0.125);
  assert.equal(tr.from!.clip.id, "a"); assert.equal(tr.to!.clip.id, "b");
  close(tr.to!.sourceTime, 1.5); close(tr.from!.sourceTime, 3.5);
  const ls = f2.tracks[1].clips[0];
  close(ls.transform!.x, 0.75); close(ls.transform!.opacity, 0.8);
  close(evaluate(comp([a, b], [l]), 2.5).tracks[1].clips[0].transform!.opacity, 0.4);
  const f3 = evaluate(comp([a, b], [l]), 4.2);
  assert.equal(f3.tracks[0].clips.length, 1); assert.equal(f3.tracks[0].clips[0].clip.id, "b"); assert.equal(f3.tracks[0].transition, undefined);
  assert.equal(evaluate(comp([a, b]), 7.5).tracks[0].clips.length, 0);
  const hidden = comp([a]); hidden.tracks[1].hidden = true; hidden.tracks[1].clips = [l];
  assert.equal(evaluate(hidden, 3).tracks.length, 1);
});

// ── builders ─────────────────────────────────────────────────────────────────
const take = (url: string, d: number): Take => ({ id: 1, shot_id: 1, kind: "video", language: null, provider: "", model: "", params: {}, prompt: "", path: "",
  url, thumb_url: "", duration_s: d, cost_usd: 0, qc: {}, selected: true, status: "done", created_at: "", created_by: null, interaction_id: "", parent_take_id: null });
const shot = (id: number, over: Partial<Shot>): Shot => ({ id, episode_id: 1, order: id, code: `SH${id}`, duration_s: 4, include: true, trim_in: 0, trim_out: 0,
  keyframe: take(`/media/k${id}.png`, 0), video: null, lipsync: null, voicelock: null, fx: {}, ...over } as Shot);

test("fromEpisode: layoutClips timing (trims, speed, overlap clamp, holds), sources, stills push in, layers", () => {
  const shots = [
    shot(1, { video: take("/media/v1.mp4", 6), trim_in: 0.5, trim_out: 0.5 }),                                   // 5 s
    shot(2, { video: take("/media/v2.mp4", 4), lipsync: take("/media/l2.mp4", 4), fx: { speed: 2, transition: { type: "fade", duration: 2 } } }), // 2 s, overlap min(2, 1, 2.5) = 1
    shot(3, { fx: { transition: { type: "gl:cube", duration: 0.5, params: { persp: 0.5 }, easing: "ease_out" }, look: "cinematic" } }), // still 4 s
    shot(4, { include: false }),
    shot(5, { video: take("/media/v5.mp4", 3), fx: { reverse: true, move: { kind: "pan_left", amount: 0.2 } } }),
  ];
  const ep = { id: 1, project_id: 7, shots } as unknown as Episode;
  const layers = { rev: 1, holds: { "3": 1.5 }, audio: [], media: [{ src: "projects/7/layers/x.png", kind: "image", name: "", duration: 0, url: "/media/x.png", thumb_url: "" }],
    video: [{ id: "t1", name: "", muted: false, hidden: false, gain_db: 0, clips: [{ id: "c1", src: "projects/7/layers/x.png", kind: "image", name: "logo", start: 1, in: 0, dur: 3,
      fade_in: 0.5, fade_out: 0, gain_db: 0, x: 0.8, y: 0.2, scale: 0.2 }] },
    { id: "t2", name: "", muted: false, hidden: true, gain_db: 0, clips: [] }] } as any;
  const c = fromEpisode(ep, layers, { aspect: "9:16", height: 720 });
  assert.equal(c.width, 720); assert.equal(c.height, 1280);
  const m = c.tracks[0].clips;
  assert.equal(m.length, 4);
  assert.equal(m[0].media.url, "/media/v1.mp4"); close(m[0].in, 0.5); close(m[0].duration, 5); close(m[0].start, 0);
  assert.equal(m[1].media.url, "/media/l2.mp4"); close(m[1].duration, 2); close(m[1].start, 4); close(m[1].transitionIn!.duration, 1); assert.equal(m[1].speed, 2);
  assert.equal(m[2].media.kind, "image"); assert.equal(m[2].kenburns, true); close(m[2].start, 5.5); close(m[2].transitionIn!.duration, 0.5);
  assert.equal(m[2].transitionIn!.type, "gl:cube"); assert.equal(m[2].transitionIn!.easing, "ease_out"); assert.deepEqual(m[2].transitionIn!.params, { persp: 0.5 });
  close(m[2].duration, 5.5); close(m[2].hold!, 1.5);  // 4 s + 1.5 s hold
  close(m[3].start, 5.5 + 5.5); assert.equal(m[3].reverse, true); assert.equal(m[3].kenburns, undefined); assert.equal(m[3].move!.kind, "pan_left");
  close(c.duration, 14);
  assert.equal(c.lutUrls!.cinematic, "/api/fx/looks/cinematic.cube");
  assert.equal(c.tracks.length, 2);
  const l = c.tracks[1].clips[0];
  assert.equal(l.media.url, "/media/x.png"); assert.equal(l.transform!.x, 0.8); assert.equal(l.transform!.scale, 0.2); assert.equal(l.fx.fade_in, 0.5);
  const plain = fromEpisode(ep, layers, { width: 640, height: 360, effects: false, holds: false });
  assert.equal(plain.tracks.length, 1); assert.equal(plain.tracks[0].clips[1].transitionIn, undefined); assert.equal(plain.tracks[0].clips[1].speed, 1);
  assert.deepEqual(dimsFor("16:9", 1080), [1920, 1080]); assert.deepEqual(dimsFor("1:1", 720), [720, 720]); assert.deepEqual(dimsFor("9:16", 2160), [2160, 3840]);
});

test("fromPlan: segments as timed by the server, gpu_transition, end card clamp, layers from raw values, LUT keys", () => {
  const plan: RenderPlan = {
    w: 3840, h: 2160, fps: 30, duration_s: 9.6, gpu_only: ["gl:cube"],
    segments: [
      { shot_id: 1, code: "A", source: "p/1/a.mp4", source_kind: "video", duration: 5, trim_in: 0.2, speed: 1, seg_len: 5, start: 0, transition: null, center: [0.4, 0.5],
        fx: { look: "lut:ab", flip_h: true }, gpu_transition: null },
      { shot_id: 2, code: "B", source: "p/1/b.png", source_kind: "still", duration: 4, trim_in: 0, speed: 1, seg_len: 4, start: 4.5, transition: ["fade", 0.5], kenburns: true,
        fx: { transition: { type: "gl:cube", duration: 0.5, easing: "ease_in" } }, gpu_transition: { type: "gl:cube", duration: 0.5, params: { persp: 0.2 }, easing: "ease_in" } },
      { shot_id: 3, code: "C", source: "p/1/c.mp4", source_kind: "video", duration: 2, trim_in: 0, speed: 2, seg_len: 1, start: 8.5, transition: null, fx: { speed: 2, reverse: true },
        gpu_transition: null },
    ],
    end_card: { key: "p/1/end.png", seconds: 3, transition: ["fade", 0.4] },
    layers: { pics: [
      { key: "p/1/logo.png", kind: "image", start: 1, in: 0, dur: 2, x: "main_w*0.9-overlay_w/2", raw: { id: "c1", track: "t1", x: 0.9, y: 0.1, scale: 0.1, opacity: 1, rotation: 0, keyframes: [], fade_in: 0, fade_out: 0.5 } },
      { key: "p/1/logo2.png", kind: "image", start: 4, in: 0, dur: 2, raw: { id: "c2", track: "t1", x: 0.2, y: 0.2, scale: 0.2, opacity: 0.5, rotation: 10, keyframes: [{ t: 0, x: 0 }], fade_in: 0, fade_out: 0 } },
      { key: "p/1/pip.mp4", kind: "video", start: 2, in: 1, dur: 2, x: "main_w*0.5-overlay_w/2" },
    ] },
    luts: { ab: "p/1/luts/ab.cube" },
  };
  const c = fromPlan(plan, (k) => `local:///${k}`);
  assert.equal(c.width, 3840); assert.equal(c.fps, 30); close(c.duration, 9.6);
  const m = c.tracks[0].clips;
  assert.equal(m.length, 4);
  assert.equal(m[0].media.url, "local:///p/1/a.mp4"); assert.deepEqual(m[0].center, [0.4, 0.5]); close(m[0].in, 0.2); assert.equal(m[0].transitionIn, undefined);
  assert.equal(c.lutUrls!["lut:ab"], "local:///p/1/luts/ab.cube");
  assert.equal(m[1].kenburns, true); assert.equal(m[1].media.kind, "image");
  assert.deepEqual(m[1].transitionIn, { type: "gl:cube", duration: 0.5, params: { persp: 0.2 }, easing: "ease_in" });
  assert.equal(m[2].reverse, true); assert.equal(m[2].speed, 2); assert.equal(m[2].transitionIn, undefined);
  close(m[3].start, 9.5 - 0.4); assert.equal(m[3].transitionIn!.type, "fade");
  assert.equal(c.tracks.length, 3);  // main, layer track t1 (two clips), the pic without raw values
  assert.equal(c.tracks[1].clips.length, 2);
  assert.equal(c.tracks[1].clips[0].transform!.x, 0.9); assert.equal(c.tracks[1].clips[0].fx.fade_out, 0.5); assert.equal(c.tracks[1].clips[0].transform!.keyframes, undefined);
  assert.equal(c.tracks[1].clips[1].transform!.rotation, 10); assert.equal(c.tracks[1].clips[1].transform!.keyframes!.length, 1);
  assert.equal(c.tracks[2].clips[0].transform!.x, 0.5);  // an overlay expression isn't a position
  assert.ok(c.warnings!.some((w) => /raw values/.test(w)));
});
