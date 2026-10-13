/**
 * The preview renders (preview-polish): ONE shared offscreen GPU engine (frontend/src/engine, exact mode) draws every
 * card of every panel — a frame through an effect chain (moods, look packs, LUTs, video effects), a transition
 * between two pictures at a progress, a title over a darkened frame at a time, and a whole template sequence (the
 * editor's own buildComposition, its media slots filled with samples) — one at a time, into ImageBitmaps.
 */
import type { Composition, CustomSource, Engine } from "../../engine";
import { buildComposition, engineModule, generatedSources } from "../engine";
import { lutUrlFor } from "../moods/ui";
import { newProject } from "../model/defaults";
import { isSlot, templateSequence, type SeqTemplate } from "../templates/sequences";
import type { EditProject, MediaItem, TitleSpec } from "../model/types";
import { fontsReady, titleSource, type Src } from "./sources";

/** An effect of a chain: a registry id and its parameter values (plain, or `{ value }`). */
export interface ChainFx { type: string; params?: Record<string, unknown>; enabled?: boolean }

let engP: Promise<Engine> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let lastLoad = "";
/** What the engine couldn't draw as asked in the last render (a missing LUT, an unknown effect, a model loading). */
let lastWarnings: string[] = [];
export const lastRenderWarnings = () => lastWarnings;
/** Timings of the shared engine's renders (ms), the last 120. */
export const renderStats = { ms: [] as number[], count: 0, failed: 0 };

function engine(): Promise<Engine> {
  return (engP ??= engineModule().then((m) => m.createEngine({ width: 256, height: 144 })).catch((e) => { engP = null; throw e; }));
}

/** Runs `fn` on the shared engine when the renders before it are done. */
function exclusive<T>(fn: (eng: Engine) => Promise<T>): Promise<T> {
  const p = queue.then(async () => fn(await engine()));
  queue = p.catch(() => undefined);
  return p;
}

const plainParams = (ps: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(ps).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object) ? v : { value: v }]));
const toInstances = (fx: ChainFx[]) => fx.map((e, i) => ({ id: `pv${i}`, type: e.type, enabled: e.enabled !== false, params: plainParams(e.params) }));

/** LUT URLs for the looks a chain names. */
function lutUrls(fx: ChainFx[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const e of fx) {
    if (e.type !== "look") continue;
    const raw = e.params?.look;
    const look = raw && typeof raw === "object" && "value" in (raw as object) ? (raw as { value: unknown }).value : raw;
    if (typeof look !== "string" || look === "none") continue;
    const u = lutUrlFor(look);
    if (u) out[look] = u;
  }
  return Object.keys(out).length ? out : undefined;
}

const motionAt = (W: number, H: number) => ({ position: { value: [W / 2, H / 2] }, scale: { value: 100 }, rotation: { value: 0 }, anchor: { value: [W / 2, H / 2] }, opacity: { value: 100 }, blend: "normal" });
const clipOf = (id: string, src: Src, start: number, duration: number, W: number, H: number, effects?: ChainFx[]) => ({
  id, media: { url: src.url, kind: "video" as const, width: W, height: H, duration: 600 }, start, duration, in: 0, speed: 1, fit: "fill" as const, fx: {},
  motion: motionAt(W, H), ...(effects?.length ? { effects: toInstances(effects) } : {}),
});

/** Draws `comp` at `t` and returns the picture. */
async function draw(eng: Engine, comp: Composition, sources: Record<string, CustomSource>, t: number): Promise<ImageBitmap> {
  const t0 = performance.now();
  if (eng.width !== comp.width || eng.height !== comp.height) { eng.resize(comp.width, comp.height); lastLoad = ""; }
  const key = JSON.stringify(comp);
  if (key !== lastLoad) { await eng.load(comp, { mode: "exact", sources }); lastLoad = key; }
  await eng.renderExact(t);
  lastWarnings = eng.warnings;
  const cv = eng.canvas as OffscreenCanvas;
  const bmp = typeof cv.transferToImageBitmap === "function" ? cv.transferToImageBitmap() : await createImageBitmap(eng.canvas);
  renderStats.ms.push(performance.now() - t0);
  renderStats.count++;
  if (renderStats.ms.length > 120) renderStats.ms.shift();
  return bmp;
}

/** `src` through an effect chain at `t` seconds of its move, w × h. `refH`: the height the chain's pixel sizes are for. */
export function renderChain(src: Src, fx: ChainFx[], t: number, w: number, h: number, refH = 1080): Promise<ImageBitmap> {
  return exclusive(async (eng) => {
    const comp = {
      width: w, height: h, fps: 30, duration: 8, background: [0, 0, 0], pixelScale: h / refH,
      tracks: [{ id: "v", kind: "video", clips: [clipOf("c", src, 0, 8, w, h, fx)], transitions: [] }],
      ...(lutUrls(fx) ? { lutUrls: lutUrls(fx) } : {}),
    } as unknown as Composition;
    return draw(eng, comp, { [src.url]: src.source }, t);
  });
}

/** A transition from `a` to `b` at `progress` (0..1), w × h. */
export function renderTransition(a: Src, b: Src, id: string, progress: number, w: number, h: number, params?: Record<string, unknown>): Promise<ImageBitmap> {
  return exclusive(async (eng) => {
    const comp = {
      width: w, height: h, fps: 30, duration: 3, background: [0, 0, 0], pixelScale: h / 1080,
      tracks: [{
        id: "v", kind: "video", clips: [clipOf("a", a, 0, 1.5, w, h), clipOf("b", b, 1.5, 1.5, w, h)],
        transitions: [{ id: "tr", type: id, at: 1.5, duration: 1, alignment: "center", start: 1, from: "a", to: "b", easing: "linear", ...(params && Object.keys(params).length ? { params } : {}) }],
      }],
    } as unknown as Composition;
    const p = Math.min(0.999, Math.max(0.001, progress));
    return draw(eng, comp, { [a.url]: a.source, [b.url]: b.source }, 1 + p);
  });
}

/** What darkens a frame under a title (so it reads the way it would over footage). */
export const TITLE_BACKDROP: ChainFx[] = [{ type: "adjust", params: { exposure: -0.62, saturation: -0.42, contrast: -0.12, blur: 0.16 } }];

/** A title (a spec at 1080 lines, `dur` seconds long) over `bg` (darkened) at `t`, w × h. */
export async function renderTitle(bg: Src | null, spec: TitleSpec, dur: number, t: number, w: number, h: number, key: string): Promise<ImageBitmap> {
  await fontsReady(spec);
  return exclusive(async (eng) => {
    const title = titleSource(spec, dur, w, h, 1080, key);
    const clips = [{ id: "bg", clips: bg ? [clipOf("bg", bg, 0, Math.max(8, dur), w, h, TITLE_BACKDROP)] : [] }, { id: "tt", clips: [clipOf("tt", title, 0, dur, w, h)] }];
    const comp = {
      width: w, height: h, fps: 30, duration: Math.max(8, dur), background: [0.04, 0.05, 0.08], pixelScale: h / 1080,
      tracks: clips.map((c) => ({ id: c.id, kind: "video", clips: c.clips, transitions: [] })),
    } as unknown as Composition;
    const sources: Record<string, CustomSource> = { [title.url]: title.source };
    if (bg) sources[bg.url] = bg.source;
    return draw(eng, comp, sources, Math.min(dur - 1 / 60, Math.max(0, t)));
  });
}

/**
 * A template sequence (the editor's own composition of it) at `t`, its media slots filled by `slot(i)`, w × h. A
 * template without slots (an overlay: subscribe buttons, end-screen cards) is shown over `slot(0)` darkened, as it
 * would sit over footage.
 */
export async function renderSequence(tpl: SeqTemplate, fields: Record<string, string> | undefined, slot: (i: number) => Promise<Src | null>, t: number, w: number, h: number): Promise<ImageBitmap> {
  const seq = templateSequence(tpl, { width: w, height: h, fps: 30 }, fields);
  const media: MediaItem[] = [];
  const sources: Record<string, CustomSource> = {};
  let k = 0;
  const clips = [];
  for (const c of seq.clips) {
    if (!isSlot(c)) { clips.push(c); continue; }
    const src = await slot(k++);
    if (!src) { clips.push(c); continue; }
    const id = `pv-${src.url}`;
    if (!media.some((m) => m.id === id)) {
      media.push({ id, binId: null, name: src.key, kind: "video", path: src.url, url: src.url, duration: 600 * 30, fps: 30, width: w, height: h, hasAudio: false, markers: [] });
      sources[src.url] = src.source;
    }
    clips.push({ ...c, source: { type: "media" as const, mediaId: id, in: 0 }, motion: { ...c.motion, anchor: { value: [w / 2, h / 2] as [number, number] } } });
  }
  const specs = seq.clips.flatMap((c) => (c.source.type === "title" ? [c.source.text] : []));
  await Promise.all(specs.map(fontsReady));
  await engineModule();
  const p0 = newProject("Preview", { width: w, height: h, fps: 30 });
  const sq = { ...seq, clips };
  const p: EditProject = { ...p0, media, sequences: [sq], activeSequenceId: sq.id };
  const r = buildComposition(p, sq.id, { urlFor: (m) => m.url, lutUrl: lutUrlFor });
  const all = { ...generatedSources(r.generated), ...sources };
  const used: Record<string, CustomSource> = {};
  const walk = (c: Composition) => { for (const tr of c.tracks) for (const cl of tr.clips) { if (cl.media?.url && all[cl.media.url]) used[cl.media.url] = all[cl.media.url]; if (cl.comp) walk(cl.comp); } };
  walk(r.comp);
  let tracks = r.comp.tracks;
  if (!k) {
    const bg = await slot(0);
    if (bg) { used[bg.url] = bg.source; tracks = [{ id: "pv-bg", kind: "video", clips: [clipOf("pv-bg", bg, 0, Math.max(8, tpl.seconds), w, h, TITLE_BACKDROP)], transitions: [] } as never, ...tracks]; }
  }
  const comp = { ...r.comp, tracks, pixelScale: h / 1080 } as Composition;
  return exclusive((eng) => draw(eng, comp, used, Math.min(Math.max(0, t), Math.max(0, comp.duration - 1 / 30))));
}

/** Drops the shared engine (a lost context comes back on the next render). */
export function resetPreviewEngine() {
  const p = engP;
  engP = null; lastLoad = "";
  void p?.then((e) => e.dispose()).catch(() => undefined);
}
