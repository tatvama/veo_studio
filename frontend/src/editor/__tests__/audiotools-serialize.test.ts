/**
 * The audio tools' model fields round-trip through save and open (model/serialize.ts): the visualiser clip source
 * with every setting (and fields a newer Tatvam may add) and room-tone clips; malformed values are repaired or dropped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeVisualizerSource } from "../audiotools/visualizer.ts";
import { baseClip } from "../model/defaults.ts";
import { ctxOf, normalize } from "../model/ops.ts";
import { parseProject } from "../model/serialize.ts";
import type { EditProject } from "../model/types.ts";
import { A, project, put, seqOf, V } from "./fixtures.ts";

function withTools(): EditProject {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  const audio = s.clips.find((c) => c.trackId === A(s, 0).id)!;
  const viz = baseClip(s, V(s, 1).id, 0, 100, { ...makeVisualizerSource({ audioClipId: audio.id, style: "circle", colors: ["#fff", "#f0f", "#0ff"], glow: 0.8,
    smoothing: 0.4, freqMin: 60, freqMax: 9000, sensitivity: 1.5, bars: 40, box: [0.2, 0.2, 0.6, 0.6], thickness: 0.5, background: "#101010", offset: 1.5, bands: 32 }),
    gradient: false, future: { y: 1 } } as never, "Audio visualiser");
  const media = baseClip(s, V(s, 2).id, 0, 50, makeVisualizerSource({ mediaId: "music", style: "particles" }), "Music visualiser");
  const tone = { ...baseClip(s, A(s, 0).id, 100, 20, { type: "media", mediaId: "m1", in: 30 }, "Room tone"), roomTone: true };
  s = normalize({ ...s, clips: [...s.clips, viz, media, tone] }, ctxOf(p));
  p.sequences = [s];
  return p;
}

test("visualiser sources and room tone round-trip through save and open", () => {
  const p = withTools();
  const s = p.sequences[0];
  assert.ok(s.clips.some((c) => c.source.type === "visualizer" && c.source.audioClipId) && s.clips.some((c) => c.source.type === "visualizer" && c.source.mediaId));
  assert.ok(s.clips.some((c) => c.roomTone));
  const back = parseProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.project, p);
  assert.deepEqual(parseProject(JSON.stringify(back.project)).project, p);
});

test("malformed visualiser settings are repaired or dropped; one without a sound is dropped", () => {
  const raw = JSON.parse(JSON.stringify(withTools()));
  const seq = raw.sequences[0];
  const v = seq.clips.find((c: { name: string }) => c.name === "Audio visualiser");
  v.source.colors = "red"; v.source.box = [1, 2]; v.source.glow = "lots"; v.source.gradient = 3; v.source.style = 9;
  const t = seq.clips.find((c: { name: string }) => c.name === "Room tone");
  t.roomTone = "yes";
  seq.clips.push({ ...v, id: "c_bad", name: "Orphan", source: { type: "visualizer", style: "bars", colors: [] } });
  const { project: p, warnings } = parseProject(raw);
  const s = p.sequences[0];
  const bv = s.clips.find((c) => c.name === "Audio visualiser")!;
  assert.ok(bv.source.type === "visualizer");
  if (bv.source.type === "visualizer") {
    assert.equal(bv.source.style, "bars"); assert.equal(bv.source.colors.length, 3);
    assert.equal(bv.source.box, undefined); assert.equal(bv.source.glow, undefined); assert.equal(bv.source.gradient, undefined);
    assert.equal(bv.source.sensitivity, 1.5); assert.deepEqual((bv.source as unknown as { future: unknown }).future, { y: 1 });
  }
  assert.equal(s.clips.find((c) => c.name === "Room tone")!.roomTone, undefined);
  assert.ok(!s.clips.some((c) => c.name === "Orphan"));
  assert.ok(warnings.some((w) => /unknown source/.test(w)));
});
