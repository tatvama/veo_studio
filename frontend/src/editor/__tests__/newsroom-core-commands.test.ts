import assert from "node:assert/strict";
import { test } from "node:test";
import { clipEnd, ctxOf, normalize, tracksOf } from "../model/ops.ts";
import { parseProject } from "../model/serialize.ts";
import { framesToSeconds } from "../model/time.ts";
import { toComposition, toVideoComposition, slotted } from "../model/toComposition.ts";
import type { EditProject, TimelineClip } from "../model/types.ts";
import {
  addGraphic, applyLook, autoHold, ensureGfxTrack, ensureNewsroom, findGraphic, graphicClips, graphicsAt, replaceGraphicTemplate,
  setGraphicValues, templateOf, useTemplate,
} from "../newsroom/commands.ts";
import { companionProject } from "../newsroom/companion.ts";
import { zonedTimeToMs } from "../newsroom/format.ts";
import { boundValue, DEFAULT_AIR_TIME, renderInputFor } from "../newsroom/resolve.ts";
import { anim, field, rect, step, text, tpl } from "../newsroom/templates/kit.ts";
import { project, put, seqOf, V } from "./fixtures.ts";

const strap = tpl({
  id: "t.strap", name: "Name strap", category: "Straps", role: "strap", seconds: 6, hold: "fixed",
  fields: [field.text("name", "Name", "Priya Rao"), field.text("role", "Role", "Anchor"), field.image("photo", "Photo")],
  designs: {
    "16:9": [rect("plate", [120, 820, 760, 86]), text("name", [150, 820, 700, 86], "{name}", {}, { anim: anim(step("fade")) })],
    "9:16": [rect("plate", [60, 1300, 960, 100]), text("name", [90, 1300, 900, 100], "{name}")],
  },
});
const strap2 = tpl({ ...strap, id: "t.strap2", name: "Guest strap", fields: [field.text("name", "Name", "Guest"), field.text("org", "Organisation", "IIT Bombay")],
  designs: { "16:9": [rect("plate", [120, 820, 760, 86]), text("org", [150, 900, 700, 40], "{org}")], "9:16": [rect("plate", [60, 1300, 960, 100])] } });
const ticker = tpl({ id: "t.ticker", name: "Crawl", category: "Tickers", role: "ticker", seconds: 0, loop: true,
  fields: [field.list("items", "Items", [{ text: "Sensex up 300" }])],
  designs: { "16:9": [rect("band", [0, 980, 1920, 70])], "9:16": [rect("band", [0, 1380, 1080, 80])] } });
const bug = tpl({ id: "t.bug", name: "Logo bug", category: "Bugs", role: "bug", seconds: 0, fields: [], designs: { "16:9": [rect("logo", [1700, 60, 160, 80])] } });
const reading = tpl({ id: "t.points", name: "Key points", category: "Boards", role: "board", seconds: 8, hold: "auto",
  fields: [field.text("title", "Title", "What we know"), field.list("points", "Points", [{ text: "Schools shut in three districts" }, { text: "Trains running late by two hours" }])],
  designs: { "16:9": [rect("card", [200, 200, 1520, 600])] } });

/** A news edit: pictures on V1 (0..100, 100..200 frames). */
function edit(): EditProject {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 0, out: 99 });
  p.sequences = [s];
  return p;
}
const sid = (p: EditProject) => p.sequences[0].id;
const seq0 = (p: EditProject) => p.sequences[0];
const tidy = (p: EditProject) => { p.sequences = p.sequences.map((s) => normalize(s, ctxOf(p))); return p; };

test("graphics tracks: made on first use, named, above the pictures in role order; Background below V1", () => {
  const p = edit();
  const strapT = ensureGfxTrack(p, sid(p), "strap");
  const bugT = ensureGfxTrack(p, sid(p), "bug");
  const layoutT = ensureGfxTrack(p, sid(p), "layout");
  const tickerT = ensureGfxTrack(p, sid(p), "ticker");
  const wipeT = ensureGfxTrack(p, sid(p), "wipe");
  const boardT = ensureGfxTrack(p, sid(p), "board");
  const bgT = ensureGfxTrack(p, sid(p), "background");
  assert.equal(ensureGfxTrack(p, sid(p), "strap"), strapT, "made once");
  const vids = tracksOf(seq0(p), "video");
  assert.deepEqual(vids.map((t) => t.name), ["Background", "V1", "V2", "V3", "Layout", "Boards", "Straps", "Ticker", "Bug", "Wipes"]);
  assert.deepEqual(vids.map((t) => t.id).slice(4), [layoutT, boardT, strapT, tickerT, bugT, wipeT]);
  assert.equal(vids[0].id, bgT);
  assert.equal(vids[0].gfxRole, "background");
  // the pictures moved up with their clips
  assert.equal(seq0(p).clips.filter((c) => c.trackId === vids[1].id).length, 2);
});

test("addGraphic copies the template and the look in, holds by the template, overwrites its range", () => {
  const p = edit();
  const id = addGraphic(p, strap, { at: 10, values: { name: "Dr. Anjali Mehta" } });
  tidy(p);
  const nr = p.newsroom!;
  assert.ok(nr.templates["t.strap"] && nr.templates["t.strap"] !== strap, "a copy");
  assert.ok(nr.looks[nr.look], "the edit's look is in the edit");
  const c = findGraphic(p, id)!.clip;
  assert.equal(c.duration, 150);  // 6 s at 25 fps
  assert.equal(c.source.gfx.values.name, "Dr. Anjali Mehta");
  assert.equal(c.source.gfx.values.role, "Anchor");
  assert.equal(tracksOf(seq0(p), "video").find((t) => t.id === c.trackId)!.gfxRole, "strap");
  assert.equal(templateOf(p, c)!.id, "t.strap");
  // fill: to the sequence end
  const t1 = addGraphic(p, ticker, { at: 0 });
  assert.equal(findGraphic(p, t1)!.clip.duration, 200);
  // auto: reading time, 4..12 s
  const words = 3 + 5 + 6;
  assert.equal(autoHold(reading, {}), Math.max(4, Math.min(12, Math.round((words / 3 + 0.6 + 0.4 + 1) * 10) / 10)));
  const b = addGraphic(p, reading, { at: 0 });
  assert.equal(findGraphic(p, b)!.clip.duration, Math.round(autoHold(reading, {}) * 25));
  // until-next: up to the next graphic on its track
  const later = addGraphic(p, strap, { at: 180 });
  const un = addGraphic(p, { ...strap, id: "t.strap.un", hold: "until-next" }, { at: 165, trackId: findGraphic(p, later)!.clip.trackId });
  assert.equal(findGraphic(p, un)!.clip.duration, 15);
  // overwrite: a strap over the first one trims it
  addGraphic(p, strap, { at: 100, duration: 50 });
  tidy(p);
  const first = findGraphic(p, id)!.clip;
  assert.equal(clipEnd(first), 100);
  assert.deepEqual(graphicClips(seq0(p), "strap").map((x) => x.start), [10, 100, 150, 165, 180]);  // the first one split around it
  assert.equal(graphicsAt(seq0(p), 50).length, 3);
});

test("values, template swaps (matching fields kept), looks", () => {
  const p = edit();
  const id = addGraphic(p, strap, { at: 0, values: { name: "Kavya", role: "Reporter" } });
  setGraphicValues(p, id, { role: "Senior reporter", extra: undefined as never });
  assert.equal(findGraphic(p, id)!.clip.source.gfx.values.role, "Senior reporter");
  setGraphicValues(p, id, { role: undefined as never });
  assert.equal("role" in findGraphic(p, id)!.clip.source.gfx.values, false);
  useTemplate(p, strap2);
  replaceGraphicTemplate(p, id, "t.strap2");
  const c = findGraphic(p, id)!.clip;
  assert.equal(c.source.gfx.template, "t.strap2");
  assert.deepEqual(c.source.gfx.values, { name: "Kavya", org: "IIT Bombay" });
  applyLook(p, "look.sports");
  assert.equal(p.newsroom!.look, "look.sports");
  assert.equal(p.newsroom!.looks["look.sports"].fonts.headline.family, "Teko Variable");
  assert.equal(ensureNewsroom(p), p.newsroom);
});

test("renderInputFor: defaults, data binding, languages, pictures, air time, collisions", () => {
  const p = edit();
  const s = addGraphic(p, strap, { at: 50, values: { photo: { mediaId: "still" } } });
  addGraphic(p, ticker, { at: 0 });
  const nr = ensureNewsroom(p);
  nr.data.wx = { source: "wx", at: "2026-10-13T19:00:00Z", rows: [{ city: "Pune", temp: 31 }, { city: "Nagpur", temp: 35 }] };
  const c = findGraphic(p, s)!.clip;
  c.source.gfx.bind = { role: { source: "wx", path: "rows.1.city" } };
  c.source.gfx.langs = { hi: { name: "प्रिया राव" } };
  const inp = renderInputFor(p, seq0(p), c, { urlFor: (m) => `http://x/${m.id}` })!;
  assert.equal(inp.values.name, "Priya Rao");
  assert.equal(inp.values.role, "Nagpur");
  assert.deepEqual(inp.images, { still: "http://x/still" });
  assert.equal(inp.fps, 25);
  assert.equal(inp.clockAt, zonedTimeToMs(DEFAULT_AIR_TIME, "Asia/Kolkata") + framesToSeconds(50, 25) * 1000);
  assert.equal(inp.seed, renderInputFor(p, seq0(p), c)!.seed, "seed is stable");
  assert.equal(renderInputFor(p, seq0(p), c, { lang: "hi" })!.values.name, "प्रिया राव");
  assert.equal(inp.avoid?.length, 1);
  assert.equal(inp.avoid![0].role, "ticker");
  assert.ok(Math.abs(inp.avoid![0].box[1] - 980 / 1080) < 1e-9);
  nr.airTime = "2026-10-13T21:30";
  assert.equal(renderInputFor(p, seq0(p), c)!.clockAt, zonedTimeToMs("2026-10-13T21:30", "Asia/Kolkata") + 2000);
  nr.settings.collision = false;
  assert.equal(renderInputFor(p, seq0(p), c)!.avoid, undefined);
  assert.equal(renderInputFor(p, seq0(p), seq0(p).clips.find((x) => x.source.type === "media")!), null);
  // snapshots → values
  const snap = nr.data.wx;
  assert.deepEqual(boundValue(snap, { id: "l", label: "", type: "list", default: [] }, "city"), [{ text: "Pune" }, { text: "Nagpur" }]);
  assert.equal(boundValue(snap, { id: "n", label: "", type: "number", default: 0 }, "temp"), 31);
  assert.equal(boundValue(snap, undefined, "rows.1.temp"), "35");
});

test("composition: a graphic clip is a generated picture in both mappings (nested too); `ratios` leave it out", () => {
  const p = edit();
  const id = addGraphic(p, strap, { at: 10 });
  const bugId = addGraphic(p, bug, { at: 0 });
  findGraphic(p, bugId)!.clip.source.gfx.ratios = ["9:16"];
  tidy(p);
  const legacy = toComposition(p, sid(p));
  const g = legacy.generated[`gen:gfx:${id}`];
  assert.ok(g && g.kind === "graphic");
  assert.equal(g.kind === "graphic" && g.input.template.id, "t.strap");
  assert.equal(g.width, 1920);
  assert.equal(g.kind === "graphic" && g.duration, 6);
  assert.equal(legacy.generated[`gen:gfx:${bugId}`], undefined, "16:9 isn't in its ratios");
  const layer = legacy.comp.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  assert.equal(layer.media.url, `gen:gfx:${id}`);
  assert.ok(Math.abs(layer.start - 0.4) < 1e-9);
  const generic = toVideoComposition(p, sid(p));
  assert.ok(generic.generated[`gen:gfx:${id}`]);
  assert.equal(generic.comp.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.media.url, `gen:gfx:${id}`);
  // inside a nested sequence: its path in the url
  const outer = { ...seq0(p), id: "s_outer", clips: [] as TimelineClip[] };
  const nest: TimelineClip = { ...seq0(p).clips[0], id: "c_nest", trackId: V(outer, 0).id, start: 0, duration: 200, source: { type: "nested", sequenceId: sid(p), in: 0 } };
  outer.clips = [nest];
  p.sequences.push(outer);
  const nested = toVideoComposition(p, "s_outer");
  assert.ok(nested.generated[`gen:gfx:c_nest/${id}`]);
});

test("slot clips take their motion and a crop effect from the layout", () => {
  const p = edit();
  ensureNewsroom(p);
  const c = { ...seq0(p).clips[0], slot: { index: 1 } };
  const place = () => ({ position: { value: [480, 270] as [number, number] }, scale: { value: 50 }, anchor: { value: [960, 540] as [number, number] }, crop: { left: { value: 10 }, right: { value: 10 }, top: { value: 0 }, bottom: { value: 0 } } });
  const out = slotted(p, seq0(p), c, ctxOf(p), place);
  assert.deepEqual(out.motion.position.value, [480, 270]);
  assert.equal(out.motion.scale.value, 50);
  const crop = out.effects.find((e) => e.type === "crop")!;
  assert.equal(crop.params.left.value, 10);
  assert.equal(slotted(p, seq0(p), c, ctxOf(p), () => null), c, "no layout on screen: its own motion");
  assert.equal(slotted(p, seq0(p), seq0(p).clips[0], ctxOf(p), place), seq0(p).clips[0], "not in a box");
});

test("serialize: newsroom, graphic sources, slots and graphics tracks round-trip", () => {
  const p = edit();
  const id = addGraphic(p, strap, { at: 10, values: { photo: { mediaId: "still", crop: [0, 0, 0.5, 0.5] } } });
  const g = findGraphic(p, id)!.clip;
  g.source.gfx.overrides = { plate: { p: { fill: "#123456" } } };
  g.source.gfx.bind = { role: { source: "wx" } };
  g.source.gfx.langs = { kn: { name: "ಪ್ರಿಯಾ" } };
  g.source.gfx.ratios = ["16:9"];
  g.source.gfx.seed = 9;
  const nr = ensureNewsroom(p);
  nr.airTime = "2026-10-13T21:00";
  nr.people = [{ id: "pp1", name: "Priya Rao", role: "Anchor", photo: { mediaId: "still" } }];
  nr.data = { wx: { source: "wx", at: "2026-10-13T19:00:00Z", rows: [{ a: 1 }] } };
  nr.playlist = [{ key: "F1", template: "t.strap", values: { name: "x" } }];
  p.sequences[0] = { ...seq0(p), clips: seq0(p).clips.map((c) => (c.source.type === "media" && c.start === 0 && c.trackId === V(seq0(p), 0).id ? { ...c, slot: { index: 2, fit: "contain", zoom: 1.2, offset: [0.1, -0.1] } } : c)) };
  tidy(p);
  const back = parseProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.project.newsroom, p.newsroom);
  assert.deepEqual(back.project.sequences[0].clips, p.sequences[0].clips);
  assert.deepEqual(back.project.sequences[0].tracks, p.sequences[0].tracks);
  // malformed bits are repaired, not fatal
  const bad = JSON.parse(JSON.stringify(p));
  bad.newsroom.settings = "x"; bad.newsroom.templates.broken = 5; bad.sequences[0].tracks[0].gfxRole = "nope";
  bad.sequences[0].clips.find((c: TimelineClip) => c.slot).slot.fit = "stretch";
  const fixed = parseProject(bad).project;
  assert.equal(fixed.newsroom!.settings.collision, true);
  assert.equal("broken" in fixed.newsroom!.templates, false);
  assert.equal(fixed.sequences[0].tracks[0].gfxRole, undefined);
  assert.equal(fixed.sequences[0].clips.find((c) => c.slot)!.slot!.fit, undefined);
});

test("companion: the other ratio keeps ids, drops graphics not shown in it, draws graphics at its size", () => {
  const p = edit();
  const id = addGraphic(p, strap, { at: 10 });
  const only16 = addGraphic(p, bug, { at: 0 });
  findGraphic(p, only16)!.clip.source.gfx.ratios = ["16:9"];
  tidy(p);
  const { project: cp, sequenceId } = companionProject(p, sid(p), "9:16");
  const cs = cp.sequences.find((s) => s.id === sequenceId)!;
  assert.equal(sequenceId, `${sid(p)}~9:16`);
  assert.equal(cs.width, 1080);
  assert.equal(cs.height, 1920);
  assert.ok(cs.clips.some((c) => c.id === id));
  assert.ok(!cs.clips.some((c) => c.id === only16));
  assert.deepEqual(cs.tracks.map((t) => t.id), seq0(p).tracks.map((t) => t.id));
  const comp = toVideoComposition(cp, sequenceId);
  const g = comp.generated[`gen:gfx:${id}`];
  assert.ok(g && g.width === 1080 && g.height === 1920);
  assert.equal(companionProject(p, sid(p), "16:9").sequenceId, sid(p), "already that ratio");
  // rebuilt: the same ids again
  assert.deepEqual(companionProject(p, sid(p), "9:16").project.sequences.at(-1)!.clips.map((c) => c.id), cs.clips.map((c) => c.id));
});
