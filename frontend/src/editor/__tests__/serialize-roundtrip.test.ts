import assert from "node:assert/strict";
import { test } from "node:test";
import { baseClip, defaultTitle, newSequence } from "../model/defaults.ts";
import { addTransition, ctxOf, normalize } from "../model/ops.ts";
import { parseProject } from "../model/serialize.ts";
import type { EditProject, Sequence, TimelineClip } from "../model/types.ts";
import { A, project, put, seqOf, V } from "./fixtures.ts";

const future = { x: 1, nested: { y: [1, "two"] } };

/** A project that uses every optional field of model/types.ts, and an unknown key on every object. */
function everything(): EditProject {
  const p = project();
  const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 49 });
  s = put(p, s, "m2", 50, { in: 50, out: 99 });
  s = addTransition(s, ctx, V(s, 0).id, 50, "gl:cube", 10).seq;
  s = addTransition(s, ctx, A(s, 0).id, 50, "audio:constant_power", 10).seq;
  // a multicam source sequence
  const mc: Sequence = { ...newSequence("Cams", s, { video: 2, audio: 2 }), multicam: { angles: [{ name: "Wide", mediaId: "m1", future }, { name: "Close" }], syncedBy: "audio", future } as never };
  const fx = { id: "e_eq", type: "audio:eq", enabled: true, params: { band: { value: "lowshelf" }, gain: { value: 3, keyframes: [{ frame: 0, value: 0, ease: "linear" as const }, { frame: 20, value: 3, ease: "bezier" as const, out: [0.3, 0] as [number, number] }] } }, future };
  s = {
    ...s, magnetic: true, masterEffects: [{ ...fx, id: "e_master" }], inPoint: 5, outPoint: 80, workArea: { zoom: 2, scroll: 10 },
    source: { pid: 3, eid: 9, lang: "hi", cutVersion: null }, future,
    tracks: s.tracks.map((t) => (t.kind === "audio" && t.index === 0 ? { ...t, role: "dialogue", effects: [fx], future } : t.kind === "video" && t.index === 0 ? { ...t, future } : t)),
    markers: [{ id: "mk1", frame: 12, duration: 0, name: "Beat", color: "#fbbf24", kind: "beat", comment: "on the one", future } as never],
  } as Sequence;
  s = {
    ...s, clips: s.clips.map((c) => (c.start === 0 && c.trackId === V(s, 0).id ? {
      ...c, colorLabel: "rose", role: "dialogue", connectedTo: "c_other", connectOffset: 4, future,
      timeRemap: { value: 100, keyframes: [{ frame: 0, value: 100, ease: "bezier", out: [0.4, 0], future } as never, { frame: 30, value: 40, ease: "linear", in: [0.6, 1] }] },
      motion: { ...c.motion, position: { value: [960, 540], keyframes: [{ frame: 0, value: [500, 500], ease: "linear", tangentOut: [10, -60] }, { frame: 40, value: [900, 300], ease: "hold", tangentIn: [-30, 0] }] }, future } as never,
      effects: [{ id: "e_blur", type: "gaussian_blur", enabled: false, params: { radius: { value: 4 } }, mask: { shape: "ellipse", x: 0.5, y: 0.5, w: 0.3, h: 0.3, feather: 0.2 } }],
      source: { ...c.source, future } as never,
    } : c.trackId === A(s, 0).id && c.start === 0 ? { ...c, audio: { ...c.audio!, fadeIn: 3, future } as never, effects: [fx] } : c)),
  };
  const title = baseClip(s, V(s, 2).id, 0, 40, { type: "title", text: {
    ...defaultTitle("Hello world"), template: "lower-third-02",
    karaoke: { words: [{ start: 0, end: 0.4, text: "Hello", future } as never, { start: 0.4, end: 0.9, text: "world" }], color: "#fff", highlightColor: "#ffd166", mode: "fill" },
    look: { in: "rise", out: "fade", stagger: "word", decor: { kind: "bar", color: "#f00" }, gradient: ["#fff", "#aaa"], count: { from: 0, to: 9 } },
    shape: { kind: "arrow", fill: "#fff", direction: "left" }, future,
  } as never }, "Caption");
  const tone = baseClip(s, A(s, 1).id, 0, 25, { type: "generate", generator: "tone", params: { freq: { value: 440 }, wave: { value: "sine" } } }, "Tone");
  const cam = baseClip(s, V(s, 1).id, 0, 30, { type: "nested", sequenceId: mc.id, in: 0 }, "Cams");
  cam.multicam = { angle: 1, audioAngle: 0 };
  s = normalize({ ...s, clips: [...s.clips, title, tone, cam] }, ctx);
  p.media = p.media.map((m, i) => (i === 0 ? { ...m, studioKey: "k1", seconds: 10, sampleRate: 48000, proxyUrl: "/p", comment: "hi", colorLabel: "tan", inPoint: 3, outPoint: 40,
    peaks: [0.1, 0.5], missing: false, markers: [{ id: "sm", frame: 5, duration: 2, name: "src", color: "#fff", kind: "scene" }], future } as never : m));
  return {
    ...p, sequences: [s, normalize(mc, ctx)], studioProjectId: 42, bins: [{ id: "b1", name: "Footage", parentId: null, color: "#123", future } as never],
    luts: [{ id: "l1", name: "Teal", path: "Luts/teal.cube", size: 33, url: "/__media/l1", match: { from: "shot-3", strength: 0.8 } } as never],
    settings: { ...p.settings, future } as never, future,
  } as EditProject;
}

test("every field round-trips through save and open (unknown ones too)", () => {
  const p = everything();
  // the fixture has what it says (so a dropped field fails the comparison)
  const s0 = p.sequences[0];
  assert.deepEqual(s0.transitions.map((t) => t.type).sort(), ["audio:constant_power", "gl:cube"]);
  assert.ok(s0.masterEffects?.length && s0.tracks.some((t) => t.role === "dialogue" && t.effects?.length) && s0.magnetic);
  assert.ok(s0.clips.some((c) => c.role && c.timeRemap && c.connectedTo) && s0.clips.some((c) => c.multicam) && s0.clips.some((c) => c.source.type === "generate"));
  assert.ok(s0.clips.some((c) => c.source.type === "title" && c.source.text.karaoke && c.source.text.look && c.source.text.shape && c.source.text.template));
  assert.ok(p.sequences[1].multicam && p.luts?.length);
  const back = parseProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.project, p);
  // and a second trip changes nothing
  assert.deepEqual(parseProject(JSON.stringify(back.project)).project, p);
});

test("malformed optional values are dropped, the rest of the object stays", () => {
  const p = everything();
  const raw = JSON.parse(JSON.stringify(p));
  const seq = raw.sequences[0];
  seq.masterEffects = 5;
  seq.tracks[0].role = "banana"; seq.tracks[0].effects = "nope";
  const c = seq.clips.find((x: { name: string }) => x.name === "Caption");
  c.source.text.karaoke.words.push({ start: "x", end: 1, text: "bad" });
  c.role = 7;
  const g = seq.clips.find((x: { name: string }) => x.name === "Tone");
  g.source.params.freq = 880;   // a bare value becomes a Param
  const back = parseProject(raw).project.sequences[0];
  assert.equal(back.masterEffects, undefined);
  assert.equal(back.tracks[0].role, undefined); assert.equal(back.tracks[0].effects, undefined);
  assert.deepEqual((back.tracks[0] as unknown as { future: unknown }).future, future);
  const bc = back.clips.find((x) => x.name === "Caption")!;
  assert.equal(bc.role, undefined);
  assert.equal(bc.source.type === "title" && bc.source.text.karaoke!.words.length, 2);
  const bg = back.clips.find((x) => x.name === "Tone")!;
  assert.deepEqual(bg.source.type === "generate" && bg.source.params.freq, { value: 880 });
});
