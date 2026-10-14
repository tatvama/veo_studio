/**
 * Auto SFX test fixtures: a small SFX library of our own (so the tests don't hang on the real library's ids — the
 * planner picks by tag), a stand-in for the SFX engine's addSfxMedia, an edit with one of every event, and an
 * EditorHost over the editor's own command history (to count undo steps).
 */
import type { AddSfxMedia } from "../autosfx/apply.ts";
import type { CatalogPreset } from "../autosfx/types.ts";
import * as H from "../model/commands.ts";
import { baseClip, defaultTitle } from "../model/defaults.ts";
import { addTransition, ctxOf, normalize, tracksOf, updateSequence } from "../model/ops.ts";
import { applyRampPreset } from "../model/retime.ts";
import type { EditorHost, EditProject, MediaItem, Sequence, TimelineClip, TitleSpec } from "../model/types.ts";
import { STICKERS, stickerSpec } from "../templates/titles.ts";
import { project, put, seqOf, V } from "./fixtures.ts";

const len = (d: number, min = 0.1, max = 6) => ({ name: "length", min, max, default: d });
const P = (id: string, name: string, tags: string[], duration: number, params: CatalogPreset["params"] = []): CatalogPreset => ({ id, name, tags, duration, params });

export const CATALOG: CatalogPreset[] = [
  P("t.whoosh.air", "Air", ["whoosh"], 0.8, [len(0.8)]),
  P("t.whoosh.fast", "Fast", ["whoosh"], 0.6, [len(0.6)]),
  P("t.whoosh.soft", "Soft breeze", ["whoosh"], 0.7, [len(0.7)]),
  P("t.whoosh.heavy", "Heavy", ["whoosh"], 0.9, [len(0.9)]),
  P("t.swish", "Quick swish", ["swish", "whoosh"], 0.35, [len(0.35)]),
  P("t.reverse", "Reverse swish", ["swish", "whoosh", "reverse"], 0.9, [len(0.9)]),
  P("t.riser", "Tension riser", ["riser", "whoosh"], 2, [len(2, 0.5, 8)]),
  P("t.impact.soft", "Soft thud", ["impact", "hit"], 1.2),
  P("t.boom", "Deep boom", ["impact", "boom"], 2.5, [{ name: "punch", min: 0, max: 1, default: 0.5 }]),
  P("t.pop", "Pop", ["pop"], 0.25),
  P("t.click", "Click", ["click"], 0.08),
  P("t.typing", "Typing", ["typing"], 1.5, [len(1.5, 0.2, 10), { name: "keys", min: 1, max: 200, default: 12 }]),
  P("t.shutter", "Shutter", ["shutter"], 0.3),
  P("t.glitch", "Digital glitch", ["glitch"], 0.6, [len(0.6)]),
  P("t.static", "Static", ["static"], 1),
  P("t.tape", "Tape stop", ["tape_stop"], 1),
  P("t.tick", "Tick", ["tick"], 0.1),
  P("t.ding", "Ding", ["ding"], 1),
  P("t.hit", "Punch hit", ["hit"], 0.5),
];

/** The SFX engine's addSfxMedia, standing in: a 48 kHz audio item as long as the sound, imported via the host. */
export const calls: { id: string; values: Record<string, number>; seed: number }[] = [];
export const fakeAddSfx: AddSfxMedia = async (host, id, values = {}, seed = 1) => {
  calls.push({ id, values, seed });
  const p = CATALOG.find((x) => x.id === id)!;
  const sec = values.length ?? p.duration;
  const tag = `${id}_${seed}_${Object.keys(values).sort().map((k) => `${k}${values[k]}`).join("_")}`.replace(/[^a-z0-9_]/gi, "_");
  const m: MediaItem = { id: `sfx_${tag}`, binId: null, name: `${id}_${seed}.wav`, kind: "audio", path: `/edit/Audio/SFX/${tag}.wav`,
    duration: Math.round(sec * 48000), fps: 48000, width: 0, height: 0, hasAudio: true, markers: [], seconds: sec, sampleRate: 48000 };
  if (!host.project().media.some((x) => x.path === m.path)) host.addMedia([m], "SFX");
  return m;
};

const FPS = 25;
const title = (s: Sequence, trackIdx: number, start: number, dur: number, spec: TitleSpec, name: string): TimelineClip =>
  baseClip(s, V(s, trackIdx).id, start, dur, { type: "title", text: spec }, name);

/**
 * The QA edit (25 fps): three clips on V1 (m1 0–4 s, m2 4–8 s, m1 8–12 s), gl:cube at the first cut and the luma-matte
 * wipe tv:matte_linear at the second, a slide-in lower third (1.2–6.2 s) and a typewriter title (6.4–9.4 s) on V2, a
 * subscribe sticker (2.4–6.4 s) on V3, a slow-motion burst on the middle clip, a camera shake (tv:shake) at the start
 * of the first clip and a 5 → 0 countdown (on V2, 10.4–... s).
 */
export function qaEdit(): EditProject {
  const p = project();
  const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 0, out: 99 });
  s = put(p, s, "m1", 200, { in: 100, out: 199 });
  s = addTransition(s, ctx, V(s, 0).id, 100, "gl:cube", 20).seq;
  s = addTransition(s, ctx, V(s, 0).id, 200, "tv:matte_linear", 20).seq;
  const first = s.clips.find((c) => c.trackId === V(s, 0).id && c.start === 0)!;
  s = addTransition(s, ctx, V(s, 0).id, 0, "tv:shake", 10, { side: "to" }).seq;
  void first;
  const lower: TitleSpec = { ...defaultTitle("Asha Rao"), animIn: "none", animOut: "none", look: { in: "slide_left", out: "fade", inDur: 0.6 } };
  const typed: TitleSpec = { ...defaultTitle("Hello world"), animIn: "typewriter", animOut: "slide_down" };
  const sub = stickerSpec(STICKERS.find((x) => x.id === "subscribe")!, 1920, 1080, 0.5, 0.8);
  const count: TitleSpec = { ...defaultTitle("#"), animIn: "none", animOut: "none", look: { in: "pop", out: "fade", count: { from: 5, to: 0 } } };
  s = { ...s, clips: [...s.clips,
    title(s, 1, 30, 125, lower, "Lower third"),
    title(s, 1, 160, 75, typed, "Typed"),
    title(s, 2, 60, 100, sub, "Subscribe"),
    title(s, 1, 260, 125, count, "Countdown"),
  ] };
  s = normalize(s, ctx);
  const mid = s.clips.find((c) => c.trackId === V(s, 0).id && c.start === 100)!;
  s = applyRampPreset(s, ctx, [mid.id], "slowmo_burst", 150, { fit: "length" });
  return { ...p, sequences: [s] };
}

/** An EditorHost over the editor's own command history (model/commands.ts): `history()` shows the undo steps. */
export function historyHost(p0: EditProject, path = "/edit/Test.tatvamedit"): EditorHost & { history(): H.HistoryState; undo(): void } {
  let h = H.initHistory(p0);
  const host: EditorHost & { history(): H.HistoryState; undo(): void } = {
    history: () => h,
    undo: () => { h = H.undo(h); },
    project: () => h.present,
    sequence: () => h.present.sequences.find((s) => s.id === h.present.activeSequenceId)!,
    selection: () => ({ clipIds: [], trackIds: [] }),
    playhead: () => 0,
    inOut: () => ({}),
    apply(label, mutate) {
      h = H.exec(h, H.command(label, (p) => {
        const d = structuredClone(p);
        mutate(d);
        const c = ctxOf(d);
        return { ...d, sequences: d.sequences.map((s) => normalize(s, c)) };
      }));
    },
    addMedia(items) { h = H.exec(h, H.command("Import", (p) => ({ ...p, media: [...p.media, ...items] }))); },
    placeClip() { throw new Error("no"); },
    addTitleTrack() { throw new Error("no"); },
    path: () => path,
    studioProjectId: () => null,
    setStudioProjectId() {},
    toast() {},
  };
  return host;
}

export const fps = FPS;
export { tracksOf, updateSequence };
