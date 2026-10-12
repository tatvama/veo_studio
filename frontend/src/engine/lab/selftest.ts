/**
 * GPU checks the lab page runs (driven over CDP in Electron and in the browser pane):
 *   runSelfTest   compiles every transition (xfade + gl + registered) and every registry effect, renders each at
 *                 320×180 (transitions at progress 0.5), checks the pixels aren't black / NaN and that an effect changes
 *                 the picture; the fx keys; the editor's generic tracks (transitions into handles, nested, titles,
 *                 adjustment), incremental loads, playback resolution, thumbnails, a lost context coming back; a
 *                 contact sheet
 *   runYuvTest    readYuv420() against a CPU reference and back to RGB (direct and padded sizes)
 *   runBench      1080p / 4K frame times: one transition + 3 effects + 1 layer
 *   runParity     the xfade transitions against FFmpeg frames (PSNR), from a reference the driver injects
 */
import { makeLut } from "../cube";
import { createEngine, listEffects, listTransitions, registerEffect, registerTransition, type Engine } from "../index";
import type { Program } from "../gl/backend";
import { transitionProgram } from "../transitions/gltransitions";
import type { Clip, Composition, ShotFx } from "../types";
import { packI420, yuvToRgb } from "../yuv";
import { badge, blocks, invertStripUrl, lightUrl, procedural, rawRgb } from "./media";
import { editorDemo } from "./demo";
import type { CustomSource } from "../sources/source";

export interface Failure { id: string; error: string }
export interface Check { name: string; ok: boolean; detail: string }
export interface SelfTestResult {
  ok: boolean; total: number; failures: Failure[]; ms: number; compileMs: number;
  transitions: { xfade: number; gl: number; custom: number }; effects: number; registry: number; byGroup: Record<string, number>;
  checks: Check[]; renderer: string; floatTargets: boolean;
  items: { id: string; ms: number; mean: number }[];
}

const W = 320, H = 180;
const clip = (o: Partial<Clip> & { id: string }): Clip => ({ media: { url: "lab:a", kind: "image" }, start: 0, duration: 4, in: 0, speed: 1, fit: "cover", fx: {}, ...o });
const comp = (main: Clip[], layers: Clip[] = [], blend?: Composition["tracks"][number]["blend"]): Composition => ({
  width: W, height: H, fps: 24, duration: 4,
  tracks: [{ id: "main", kind: "main", clips: main }, ...(layers.length ? [{ id: "l", kind: "layer" as const, clips: layers, blend }] : [])],
});

export function gpuName(eng: Engine): string {
  const gl = eng.renderer.b.gl;
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

function stats(px: Float32Array) {
  let nan = 0, sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) { nan++; continue; }
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return { nan, mean: sum / (px.length / 4) };
}
/** Mean absolute difference, and the share of pixels that changed by more than 1/255. */
function diff(a: Float32Array, b: Float32Array) {
  let s = 0, changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    s += d;
    if (d > 1.5 / 255) changed++;
  }
  return { mean: s / (a.length * 0.75), changed: changed / (a.length / 4) };
}

class Sheet {
  private g: CanvasRenderingContext2D | null;
  private tmp = document.createElement("canvas");
  private n = 0;
  private cols = 10;
  constructor(canvas: HTMLCanvasElement | undefined, count: number) {
    this.g = canvas?.getContext("2d") ?? null;
    if (canvas) { canvas.width = this.cols * 160; canvas.height = Math.ceil(count / this.cols) * 104; }
    this.tmp.width = W; this.tmp.height = H;
    if (this.g) { this.g.fillStyle = "#111"; this.g.fillRect(0, 0, canvas!.width, canvas!.height); }
  }
  add(rgba: Uint8Array, label: string, bad: boolean) {
    const g = this.g;
    if (!g) return;
    const t = this.tmp.getContext("2d")!;
    const img = t.createImageData(W, H);
    img.data.set(rgba);
    t.putImageData(img, 0, 0);
    const x = (this.n % this.cols) * 160, y = Math.floor(this.n / this.cols) * 104;
    g.drawImage(this.tmp, x, y, 160, 90);
    g.fillStyle = bad ? "#b91c1c" : "#000"; g.fillRect(x, y + 90, 160, 14);
    g.fillStyle = "#ddd"; g.font = "10px ui-monospace, monospace"; g.fillText(label.slice(0, 26), x + 3, y + 101);
    this.n++;
  }
}

async function compileAll(eng: Engine, ids: string[], failures: Failure[]): Promise<number> {
  const b = eng.renderer.b;
  const t0 = performance.now();
  const progs: [string, Program][] = [];
  for (const id of ids) {
    const tp = transitionProgram(id);
    if (!tp) { failures.push({ id, error: "no program" }); continue; }
    progs.push([id, b.program(tp.name, tp.source, { glsl1: tp.glsl1 })]);
  }
  for (let i = 0; i < 400 && progs.some(([, p]) => !p.ready()); i++) await new Promise((r) => setTimeout(r, 10));
  for (const [id, p] of progs) { try { b.check(p); } catch (e) { failures.push({ id, error: (e as Error).message }); } }
  return performance.now() - t0;
}

export async function runSelfTest(sheetCanvas?: HTMLCanvasElement): Promise<SelfTestResult> {
  const t0 = performance.now();
  const eng = await createEngine({ width: W, height: H, canvas: document.createElement("canvas") });
  const r = eng.renderer, b = r.b;
  const sources: Record<string, CustomSource> = { "lab:a": procedural("A", 640, 360, true), "lab:b": procedural("B", 640, 360, true),
    "lab:sq": procedural("B", 360, 360, true), "lab:logo": badge(256) };
  const lut = makeLut(17, (x, y, z) => [Math.min(1, x * 1.1 + 0.05), y * 0.9, Math.min(1, z * 0.8 + 0.1)]);
  const failures: Failure[] = [];
  const items: SelfTestResult["items"] = [];
  registerCustom();
  const infos = await listTransitions();
  const ids = infos.map((t) => t.id);
  const fxTests = effectTests();
  const reg = listEffects();
  const sheet = new Sheet(sheetCanvas, ids.length + fxTests.length + reg.length + 8);
  const compileMs = await compileAll(eng, ids, failures);
  const renderer = gpuName(eng), floatTargets = eng.floatTargets;
  const failed = new Set(failures.map((f) => f.id));

  // transitions: A → B at progress 0.5
  const tc = comp([clip({ id: "a", duration: 2 }), clip({ id: "b", start: 1, duration: 2, media: { url: "lab:b", kind: "image" }, transitionIn: { type: "fade", duration: 1 } })]);
  await eng.load(tc, { mode: "exact", sources });
  for (const id of ids) {
    if (failed.has(id)) continue;
    const s0 = performance.now();
    try {
      tc.tracks[0].clips[1].transitionIn!.type = id;
      r.warnings.clear();
      await r.renderExact(1.5);
      let st = stats(b.readFloat(r.frame!, 0, 0, W, H));
      if (st.nan) throw new Error(`${st.nan} NaN pixels`);
      for (const at of [1.3, 1.1]) {  // a dip or a crop is black half-way
        if (st.mean >= 0.01) break;
        await r.renderExact(at);
        st = stats(b.readFloat(r.frame!, 0, 0, W, H));
      }
      if (st.mean < 0.01) throw new Error("all black");
      if (r.warnings.size) throw new Error([...r.warnings].join("; "));
      items.push({ id, ms: performance.now() - s0, mean: st.mean });
      sheet.add(r.readRgba(), id, false);
    } catch (e) { failures.push({ id, error: (e as Error).message }); sheet.add(r.readRgba(), id, true); }
  }

  // effects: each against the plain picture
  const plain = new Map<string, Float32Array>();
  const base = async (key: string, c: Composition) => {
    if (!plain.has(key)) { await eng.load(c, { mode: "exact", sources, luts: { test: lut } }); await r.renderExact(1); plain.set(key, b.readFloat(r.frame!, 0, 0, W, H)); }
    return plain.get(key)!;
  };
  for (const t of fxTests) {
    const s0 = performance.now();
    try {
      const ref = await base(t.base, t.baseComp);
      await eng.load(t.comp, { mode: "exact", sources, luts: { test: lut } });
      r.warnings.clear();
      await r.renderExact(t.t ?? 1);
      const px = b.readFloat(r.frame!, 0, 0, W, H);
      const st = stats(px);
      if (st.nan) throw new Error(`${st.nan} NaN pixels`);
      if (st.mean < 0.005 && !t.dark) throw new Error("all black");
      const d = diff(px, ref);
      if (d.mean < 0.002 && d.changed < 0.02) throw new Error(`no visible change (mean difference ${d.mean.toFixed(4)}, ${(d.changed * 100).toFixed(1)} % of pixels)`);
      if (r.warnings.size) throw new Error([...r.warnings].join("; "));
      items.push({ id: t.id, ms: performance.now() - s0, mean: st.mean });
      sheet.add(r.readRgba(), t.id, false);
    } catch (e) { failures.push({ id: t.id, error: (e as Error).message }); if (r.frame) sheet.add(r.readRgba(), t.id, true); }
  }

  // registry effects: each in a video track's chain against the plain picture
  const images = { strip: invertStripUrl(16), light: lightUrl(128) };
  await eng.load(vcomp([]), { mode: "exact", sources });
  await r.renderExact(1);
  const vref = b.readFloat(r.frame!, 0, 0, W, H);
  await eng.load(vcomp([], true), { mode: "exact", sources });
  await r.renderExact(1);
  const sref = b.readFloat(r.frame!, 0, 0, W, H);
  for (const e of reg) {
    const s0 = performance.now();
    const id = `fx:${e.id}`;
    try {
      const params: Record<string, unknown> = { ...(FX_TEST[e.id] ?? {}) };
      if (e.id === "color_map") params.map = images.strip;
      if (e.id === "simple_lightmap") params.map = images.light;
      await eng.load(vcomp([{ type: e.id, params }], SCALED.has(e.id)), { mode: "exact", sources });
      r.warnings.clear();
      await r.renderExact(1);
      const px = b.readFloat(r.frame!, 0, 0, W, H);
      const st = stats(px);
      if (st.nan) throw new Error(`${st.nan} NaN pixels`);
      if (r.warnings.size) throw new Error([...r.warnings].join("; "));
      if (st.mean < 0.005 && !DARK.has(e.id)) throw new Error("all black");
      const d = diff(px, SCALED.has(e.id) ? sref : vref);
      if (d.mean < 0.002 && d.changed < 0.02) throw new Error(`no visible change (mean difference ${d.mean.toFixed(4)}, ${(d.changed * 100).toFixed(1)} % of pixels)`);
      items.push({ id, ms: performance.now() - s0, mean: st.mean });
      sheet.add(r.readRgba(), e.id, false);
    } catch (err) { failures.push({ id, error: (err as Error).message }); if (r.frame) sheet.add(r.readRgba(), e.id, true); }
  }
  eng.dispose();

  const checks = await genericChecks(sources, sheet);
  for (const c of checks) if (!c.ok) failures.push({ id: `check:${c.name}`, error: c.detail });
  const byGroup: Record<string, number> = {};
  for (const e of reg) byGroup[e.group] = (byGroup[e.group] ?? 0) + 1;
  return {
    ok: failures.length === 0, total: ids.length + fxTests.length + reg.length + checks.length, failures, ms: Math.round(performance.now() - t0), compileMs: Math.round(compileMs),
    transitions: { xfade: infos.filter((t) => t.kind === "xfade").length, gl: infos.filter((t) => t.kind === "gl").length, custom: infos.filter((t) => t.kind === "custom").length },
    effects: fxTests.length, registry: reg.length, byGroup, checks, renderer, floatTargets, items,
  };
}

/** A runtime GLSL effect and transition. */
function registerCustom() {
  registerEffect({ id: "lab.invert", label: "Invert (custom)", group: "Colour", params: [{ name: "amount", label: "Amount", type: "float", default: 1, min: 0, max: 1 }],
    glsl: "vec4 effect(vec2 uv) { vec4 c = getColor(uv); return vec4(mix(c.rgb, 1.0 - c.rgb, amount), c.a); }" });
  registerTransition({ id: "lab.diagonal", label: "Diagonal wipe (custom)", params: [{ name: "smoothness", type: "float", default: 0.1 }],
    glsl: "uniform float smoothness; vec4 transition(vec2 uv) { float d = (uv.x + uv.y) * 0.5; return mix(getFromColor(uv), getToColor(uv), smoothstep(d - smoothness, d + smoothness, progress * (1.0 + 2.0 * smoothness) - smoothness)); }" });
}

/** Parameters that make an effect visible on the test picture (its defaults may be neutral). */
const FX_TEST: Record<string, Record<string, unknown>> = {
  adjust: { contrast: 0.5, saturation: 0.4, vignette: 0.5 },
  wheels: { gain: [0.4, 0, -0.2], lift: [0.1, 0, 0] },
  curves: { master: [[0, 0], [0.5, 0.75], [1, 1]] },
  chroma: { color: "#00C000", similarity: 0.15 },
  brightness_contrast: { brightness: 0.2, contrast: 0.3 },
  shockwave: { speed: 60, wavelength: 60, amplitude: 20 },
  perspective: { topLeft: [0.15, 0.1], bottomRight: [0.9, 0.85] },
  crop: { left: 20, bottom: 15 },
  reflection: { boundary: 0.4 },
  simplex_noise: { strength: 0.3 },
  twist: { radius: 120 }, bulge_pinch: { radius: 120 },
  channel_mixer: { red: [0, 1, 0], green: [1, 0, 0] },
  hsl_adjustment: { hue: 90, saturation: 0.3 },
  hue_saturation: { hue: 0.3, saturation: 0.3 },
  multi_color_replace: { from1: "#c0c000", to1: "#0000ff", tolerance: 0.2 },
};
/** Effects that may leave the test picture dark. */
const DARK = new Set(["ascii", "edge_work", "luma_key"]);

const vclip = (id: string, url: string, start: number, duration: number, over: Partial<Clip> = {}): Clip =>
  ({ id, media: { url, kind: "image" }, start, duration, in: 0, speed: 1, fit: "contain", fx: {}, ...over });
/** A picture with a registry chain on a video track; `scaled`: at 60 % (effects that draw outside the picture). */
const vcomp = (effects: Clip["effects"], scaled = false): Composition => ({ width: W, height: H, fps: 24, duration: 4, background: scaled ? [0.45, 0.5, 0.55] : [0, 0, 0], tracks: [{ id: "v1", kind: "video",
  clips: [vclip("a", "lab:a", 0, 4, { effects, ...(scaled ? { motion: { scale: { value: 60 } } } : {}) })] }] });
const SCALED = new Set(["drop_shadow", "outline", "outer_glow", "bevel", "mask", "crop"]);

/** The editor's tracks end to end, and the engine's API around them. */
async function genericChecks(sources: Record<string, CustomSource>, sheet: Sheet): Promise<Check[]> {
  const out: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  const eng = await createEngine({ width: W, height: H, canvas: document.createElement("canvas") });
  const r = eng.renderer, b = r.b;
  const chain: Clip["effects"] = [{ type: "hue_saturation", params: { saturation: { value: 0.3 } } }];
  const demo = editorDemo({ W, H, transition: "wipeleft", duration: 1, chain });
  const at = async (c: Composition, t: number) => { await eng.load(c, { mode: "exact", sources }); r.warnings.clear(); await r.renderExact(t); return b.readFloat(r.frame!, 0, 0, W, H); };
  const region = (px: Float32Array, x0: number, y0: number, x1: number, y1: number) => {
    let s = 0, n = 0;
    for (let y = Math.floor(y0 * H); y < y1 * H; y++) for (let x = Math.floor(x0 * W); x < x1 * W; x++) { const i = (y * W + x) * 4; s += px[i] + px[i + 1] + px[i + 2]; n += 3; }
    return s / Math.max(n, 1);
  };
  try {
    // a transition at the cut, centred: half-way it shows both sides (wipe)
    const mid = await at(demo, 4);
    const warn = [...r.warnings];
    sheet.add(r.readRgba(), "editor: wipe at the cut", false);
    const v1 = (t: number) => at(editorDemo({ W, H, transition: "wipeleft", without: ["nested", "title", "adjustment"], chain }), t);
    const pureA = await v1(3), pureB = await v1(5), midPlain = await v1(4);
    const dl = diff(midPlain, pureA).changed, dr = diff(midPlain, pureB).changed;
    check("transition at a cut", !warn.length && dl > 0.2 && dr > 0.2 && stats(mid).nan === 0, `vs A ${(dl * 100).toFixed(0)} %, vs B ${(dr * 100).toFixed(0)} % changed${warn.length ? "; " + warn.join("; ") : ""}`);
    // the nested comp fades in from nothing at its start (an edge transition)
    const box = [0.68, 0.12, 0.88, 0.4] as const;
    const half = region(await at(demo, 1.5), ...box);
    sheet.add(r.readRgba(), "editor: nested fading in", false);
    const full = region(await at(demo, 3), ...box);
    const none = region(await at(editorDemo({ W, H, transition: "wipeleft", without: ["nested"], chain }), 1.5), ...box);
    check("nested + edge fade", Math.abs(full - none) > 0.02 && Math.abs(half - (none + full) / 2) < Math.abs(full - none) * 0.35 + 0.02,
      `region mean: none ${none.toFixed(3)}, half-way ${half.toFixed(3)}, full ${full.toFixed(3)}`);
    // the title draws
    const withT = await at(demo, 2.5);
    sheet.add(r.readRgba(), "editor: title", false);
    const noT = await at(editorDemo({ W, H, transition: "wipeleft", without: ["title"], chain }), 2.5);
    const td = diff(withT, noT);
    check("title", td.changed > 0.03, `${(td.changed * 100).toFixed(1)} % of pixels`);
    // the adjustment clip greys everything below it
    const adj = await at(demo, 7);
    sheet.add(r.readRgba(), "editor: adjustment", false);
    let sat = 0;
    for (let i = 0; i < adj.length; i += 4) sat = Math.max(sat, Math.abs(adj[i] - adj[i + 1]) + Math.abs(adj[i + 1] - adj[i + 2]));
    check("adjustment clip", sat < 0.03, `max channel spread ${sat.toFixed(4)}`);
    // incremental: a parameter edit with a new sources object keeps every source and uploads nothing again
    await eng.load(demo, { mode: "exact", sources });
    await r.renderExact(2);
    const keys = r.sourceInfo().map((s) => s.key).sort().join("|"), up = r.stats.uploads;
    const edited = editorDemo({ W, H, transition: "wipeleft", duration: 1, chain: [{ type: "hue_saturation", params: { saturation: { value: -0.5 } } }] });
    const l0 = performance.now();
    await eng.update(edited, { sources: { ...sources } });
    const lms = performance.now() - l0;
    await r.renderExact(2);
    const keys2 = r.sourceInfo().map((s) => s.key).sort().join("|");
    check("incremental load", keys === keys2 && r.stats.uploads === up, `${r.sourceInfo().length} sources kept, ${r.stats.uploads - up} uploads, update() ${lms.toFixed(1)} ms`);
    // playback resolution
    eng.drawLive(2, { resolution: 0.5, playing: false });
    const hf = r.frame!;
    check("playback resolution ½", hf.w === W / 2 && hf.h === H / 2 && eng.stats.resolution === 0.5, `${hf.w}×${hf.h}`);
    eng.drawLive(2, { resolution: 1 });
    // thumbnails
    const ids = ["fade", "gl:cube", "lab.diagonal", "glitch", "look", "lab.invert"];
    const thumbs = await Promise.all(ids.map((id) => eng.renderThumbnail(id, 160)));
    check("thumbnails", thumbs.every((t) => t.width === 160 && t.height === 90), thumbs.map((t, i) => `${ids[i]} ${t.width}×${t.height}`).join(", "));
    // a broken custom effect only warns
    registerEffect({ id: "lab.broken", label: "Broken", group: "Colour", params: [], glsl: "vec4 effect(vec2 uv) { return nope; }" });
    await eng.load(vcomp([{ type: "lab.broken" }]), { mode: "exact", sources });
    r.warnings.clear();
    await r.renderExact(1);
    check("broken custom effect", [...r.warnings].some((w) => /Broken/.test(w)) && !!r.frame, [...r.warnings].join("; ").slice(0, 160));
    // a lost context comes back
    await eng.load(demo, { mode: "exact", sources });
    await r.renderExact(2.5);
    const before = eng.readRgba().slice();
    const lose = b.gl.getExtension("WEBGL_lose_context");
    if (!lose) check("context restore", false, "no WEBGL_lose_context");
    else {
      lose.loseContext();
      await until(() => b.lost);
      let threw = false;
      try { await r.renderExact(2.5); } catch { threw = true; }
      lose.restoreContext();
      await until(() => !b.lost);
      await r.renderExact(2.5);
      const after = eng.readRgba();
      let md = 0;
      for (let i = 0; i < after.length; i++) md = Math.max(md, Math.abs(after[i] - before[i]));
      check("context restore", threw && eng.stats.restores === 1 && md <= 2, `export threw while lost: ${threw}, restores ${eng.stats.restores}, max difference after ${md}`);
      sheet.add(after, "after a context restore", md > 2);
    }
  } catch (e) { check("generic tracks", false, (e as Error).message); }
  eng.dispose();
  return out;
}

const until = async (f: () => boolean, ms = 5000) => { const t0 = performance.now(); while (!f() && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20)); };


interface FxTest { id: string; comp: Composition; base: string; baseComp: Composition; t?: number; dark?: boolean }

function effectTests(): FxTest[] {
  const out: FxTest[] = [];
  const plainA = comp([clip({ id: "a" })]);
  const add = (id: string, fx: ShotFx, over: Partial<Clip> = {}, t?: number) =>
    out.push({ id, comp: comp([clip({ id: "a", ...over, fx })]), base: "a", baseComp: plainA, t });
  add("look (LUT)", { look: "test" });
  add("look at 50%", { look: "test", lut_strength: 0.5 });
  for (const k of ["exposure", "contrast", "saturation", "temperature", "tint", "vibrance", "gamma", "hue", "sharpen", "blur", "vignette", "grain"] as const)
    add(`adjust.${k}`, { adjust: { [k]: 0.7 } });
  add("adjust.negative", { adjust: { exposure: -0.6, contrast: -0.5, saturation: -0.8, temperature: -0.7, vibrance: -0.5 } });
  add("wheels", { wheels: { lift: [0.2, 0, -0.1], gamma: [0, 0.3, 0], gain: [0.1, 0, 0.2] } });
  add("curves", { curves: { master: [[0, 0], [0.5, 0.7], [1, 1]], r: [[0, 0.1], [1, 0.9]] } });
  add("chroma key", { chroma: { color: "#00C000", similarity: 0.15, smoothness: 0.08, spill: 0.1 } });
  add("mask rect", { adjust: { saturation: -1, exposure: 0.4 }, mask: { shape: "rect", x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 15, feather: 0.2 } });
  add("mask ellipse inverted", { adjust: { saturation: -1 }, mask: { shape: "ellipse", x: 0.4, y: 0.5, w: 0.4, h: 0.6, feather: 0.5, invert: true } });
  add("glow", { glow: { amount: 0.8, threshold: 0.5, radius: 0.4 } });
  add("glow + sharpen + blur", { glow: { amount: 0.6, threshold: 0.6, radius: 0.3 }, adjust: { sharpen: 0.6, blur: 0.3 } });
  add("all effects + mask", { look: "test", adjust: { contrast: 0.3, vibrance: 0.4, hue: 0.1, sharpen: 0.3, vignette: 0.5, grain: 0.3 },
    wheels: { lift: [0.05, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0.1] }, curves: { master: [[0, 0.05], [1, 0.95]] }, glow: { amount: 0.3, threshold: 0.7, radius: 0.2 },
    mask: { shape: "ellipse", x: 0.5, y: 0.5, w: 0.8, h: 0.8, feather: 0.3 } });
  add("flip_h", { flip_h: true });
  add("flip_v", { flip_v: true });
  add("fade in (half)", { fade_in: 2 });
  add("move zoom_in", {}, { move: { kind: "zoom_in", amount: 0.4 }, duration: 2 });
  add("move pan_left", {}, { move: { kind: "pan_left", amount: 0.3 }, duration: 2 }, 0.2);
  add("still push-in", {}, { kenburns: true }, 3);
  const sq = comp([clip({ id: "sq", media: { url: "lab:sq", kind: "image" } })]);
  out.push({ id: "fit contain", comp: comp([clip({ id: "sq", media: { url: "lab:sq", kind: "image" }, fit: "contain" })]), base: "sq", baseComp: sq });
  out.push({ id: "cover aim", comp: comp([clip({ id: "sq", media: { url: "lab:sq", kind: "image" }, center: [0.5, 0.95] })]), base: "sq", baseComp: sq });
  const logo = (o: Partial<Clip> = {}) => clip({ id: "logo", media: { url: "lab:logo", kind: "image" }, fit: "contain",
    transform: { x: 0.6, y: 0.45, scale: 0.4, rotation: 20, opacity: 0.9 }, ...o });
  for (const m of ["normal", "add", "multiply", "screen", "overlay", "lighten", "darken"] as const)
    out.push({ id: `layer ${m}`, comp: comp([clip({ id: "a" })], [logo()], m), base: "a", baseComp: plainA });
  out.push({ id: "layer keyframes + fades", comp: comp([clip({ id: "a" })], [logo({ fx: { fade_in: 0.5, fade_out: 0.5 },
    transform: { x: 0.5, y: 0.5, scale: 0.3, rotation: 0, opacity: 1, keyframes: [{ t: 0, x: 0.2, rotation: -30 }, { t: 2, x: 0.8, rotation: 30, easing: "ease_in_out" }] } })]),
    base: "a", baseComp: plainA });
  out.push({ id: "layer chroma + mask", comp: comp([clip({ id: "a" })], [clip({ id: "pip", media: { url: "lab:b", kind: "image" }, fit: "contain",
    transform: { x: 0.5, y: 0.5, scale: 0.6, rotation: 0, opacity: 1 }, fx: { chroma: { color: "#06D6A0", similarity: 0.12, smoothness: 0.1, spill: 0.2 },
      mask: { shape: "ellipse", x: 0.5, y: 0.5, w: 0.9, h: 0.9, feather: 0.3 } } })]), base: "a", baseComp: plainA });
  return out;
}

// ── YUV round trip ───────────────────────────────────────────────────────────
export interface YuvTestResult { ok: boolean; sizes: { w: number; h: number; direct: boolean; bytes: number; mismatched: number; maxCode: number; maxRgb: number; meanRgb: number }[] }

export async function runYuvTest(): Promise<YuvTestResult> {
  const sizes: YuvTestResult["sizes"] = [];
  for (const [w, h] of [[320, 180], [334, 186], [1920, 1080]]) {
    const eng = await createEngine({ width: w, height: h, canvas: document.createElement("canvas") });
    await eng.load({ width: w, height: h, fps: 24, duration: 1, tracks: [{ id: "m", kind: "main", clips: [clip({ id: "p", media: { url: "lab:p", kind: "image" } })] }] },
      { mode: "exact", sources: { "lab:p": blocks(w, h, w + h) } });
    await eng.renderExact(0);
    const rgba = eng.readRgba();
    const yuv = eng.readYuv420().slice();
    const ref = packI420(rgba, w, h);
    let mismatched = 0, maxCode = 0;
    for (let i = 0; i < ref.length; i++) { const d = Math.abs(ref[i] - yuv[i]); if (d > 1) mismatched++; maxCode = Math.max(maxCode, d); }
    let maxRgb = 0, sum = 0;
    const cw = w / 2, ch = h / 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = yuvToRgb(yuv[y * w + x], yuv[w * h + (y >> 1) * cw + (x >> 1)], yuv[w * h + cw * ch + (y >> 1) * cw + (x >> 1)]);
      for (let k = 0; k < 3; k++) { const d = Math.abs(c[k] * 255 - rgba[(y * w + x) * 4 + k]); maxRgb = Math.max(maxRgb, d); sum += d; }
    }
    sizes.push({ w, h, direct: w % 8 === 0 && (h / 2) % 2 === 0, bytes: yuv.length, mismatched, maxCode, maxRgb: Math.round(maxRgb * 10) / 10,
      meanRgb: Math.round((sum / (w * h * 3)) * 1000) / 1000 });
    eng.dispose();
  }
  return { ok: sizes.every((s) => s.bytes === s.w * s.h * 1.5 && s.mismatched === 0 && s.maxRgb <= 4), sizes };
}

// ── frame timings ────────────────────────────────────────────────────────────
export interface BenchResult { renderer: string; floatTargets: boolean; frames: number; results: { size: string; transition: string; avgMs: number; p50Ms: number; p95Ms: number; yuvMs: number }[] }

export async function runBench(frames = 60): Promise<BenchResult> {
  const results: BenchResult["results"] = [];
  let renderer = "", floatTargets = false;
  for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
    const eng = await createEngine({ width: w, height: h, canvas: document.createElement("canvas") });
    renderer = gpuName(eng); floatTargets = eng.floatTargets;
    const sources = { "lab:a": procedural("A", w, h, true), "lab:b": procedural("B", w, h, true), "lab:logo": badge(512) };
    const fx: ShotFx = { adjust: { contrast: 0.3, saturation: 0.2, vignette: 0.4 }, curves: { master: [[0, 0.05], [0.5, 0.55], [1, 0.95]] } };
    for (const tr of ["fade", "gl:cube", "hblur"]) {
      const c: Composition = { width: w, height: h, fps: 24, duration: 4, tracks: [
        { id: "m", kind: "main", clips: [clip({ id: "a", duration: 3, fx }), clip({ id: "b", start: 1, duration: 3, media: { url: "lab:b", kind: "image" }, fx,
          transitionIn: { type: tr, duration: 2 } })] },
        { id: "l", kind: "layer", clips: [clip({ id: "logo", media: { url: "lab:logo", kind: "image" }, fit: "contain",
          transform: { x: 0.8, y: 0.2, scale: 0.15, rotation: 0, opacity: 1, keyframes: [{ t: 0, rotation: 0 }, { t: 4, rotation: 90 }] } })] }] };
      await eng.load(c, { mode: "exact", sources });
      for (let i = 0; i < 5; i++) { await eng.renderExact(1.5); eng.renderer.b.finish(); }  // warm up: compile, upload
      const ms: number[] = [];
      for (let i = 0; i < frames; i++) {
        const s = performance.now();
        await eng.renderExact(1 + (i / frames) * 1.9);
        eng.renderer.b.finish();
        ms.push(performance.now() - s);
      }
      const ys = performance.now();
      for (let i = 0; i < 10; i++) eng.readYuv420();
      const yuvMs = (performance.now() - ys) / 10;
      ms.sort((a, b) => a - b);
      results.push({ size: `${w}x${h}`, transition: tr, avgMs: round(ms.reduce((a, b) => a + b, 0) / ms.length), p50Ms: round(ms[Math.floor(ms.length / 2)]),
        p95Ms: round(ms[Math.floor(ms.length * 0.95)]), yuvMs: round(yuvMs) });
    }
    // the editor: 2 video tracks (two clips with a transition at the cut, a title), 4 registry effects on each clip
    const chain: Clip["effects"] = [{ type: "brightness_contrast", params: { brightness: 0.05, contrast: 0.1 } }, { type: "hue_saturation", params: { saturation: 0.2 } },
      { type: "vignette" }, { type: "unsharp_mask" }];
    for (const tr of ["fade", "gl:cube"]) {
      const c = editorDemo({ W: w, H: h, transition: tr, duration: 2, chain, without: ["nested", "adjustment"] });
      await eng.load(c, { mode: "exact", sources });
      for (let i = 0; i < 5; i++) { await eng.renderExact(4); eng.renderer.b.finish(); }
      const ms: number[] = [];
      for (let i = 0; i < frames; i++) {
        const s = performance.now();
        await eng.renderExact(3.05 + (i / frames) * 1.9);  // inside the transition: both clips and their effects every frame
        eng.renderer.b.finish();
        ms.push(performance.now() - s);
      }
      ms.sort((a, b) => a - b);
      results.push({ size: `${w}x${h}`, transition: `editor: 2 tracks, ${tr}, 4 effects ×2 clips, title`, avgMs: round(ms.reduce((a, b) => a + b, 0) / ms.length),
        p50Ms: round(ms[Math.floor(ms.length / 2)]), p95Ms: round(ms[Math.floor(ms.length * 0.95)]), yuvMs: 0 });
    }
    eng.dispose();
  }
  return { renderer, floatTargets, frames, results };
}
const round = (v: number) => Math.round(v * 100) / 100;

// ── parity with FFmpeg's xfade ───────────────────────────────────────────────
/** `format`: "rgb24" frames (FFmpeg xfade on gbrp) or "yuv420p" (the real pipeline: BT.709 limited, compared with readYuv420). */
export interface ParityRef { w: number; h: number; ps: number[]; a: string; b: string; frames: Record<string, string[]>; format?: "rgb24" | "yuv420p" }
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const psnr = (se: number, n: number) => (se === 0 ? 99 : Math.round(10 * Math.log10((255 * 255) / (se / n)) * 10) / 10);

/** PSNR (dB) per transition and progress against FFmpeg 7.1 frames of the same two pictures (yuv420p: Y then chroma). */
export async function runParity(ref: ParityRef): Promise<Record<string, number[]>> {
  const { w, h } = ref;
  const eng = await createEngine({ width: w, height: h, canvas: document.createElement("canvas") });
  const sources = { "ref:a": rawRgb(unb64(ref.a), w, h), "ref:b": rawRgb(unb64(ref.b), w, h) };
  const c: Composition = { width: w, height: h, fps: 20, duration: 4, stillsMatrix: "bt709", tracks: [{ id: "m", kind: "main", clips: [
    clip({ id: "a", duration: 2, media: { url: "ref:a", kind: "image" } }),
    clip({ id: "b", start: 1, duration: 2, media: { url: "ref:b", kind: "image" }, transitionIn: { type: "fade", duration: 1 } })] }] };
  await eng.load(c, { mode: "exact", sources });
  const out: Record<string, number[]> = {};
  for (const [id, frames] of Object.entries(ref.frames)) {
    c.tracks[0].clips[1].transitionIn!.type = id;
    out[id] = [];
    for (let i = 0; i < ref.ps.length; i++) {
      await eng.renderExact(1 + ref.ps[i]);
      const want = unb64(frames[i]);
      if (ref.format === "yuv420p") {
        const got = eng.readYuv420();
        let sy = 0, sc = 0;
        for (let k = 0; k < got.length; k++) { const d = got[k] - want[k]; if (k < w * h) sy += d * d; else sc += d * d; }
        out[id].push(psnr(sy, w * h), psnr(sc, w * h / 2));
      } else {
        const got = eng.readRgba();
        let se = 0;
        for (let p = 0; p < w * h; p++) for (let k = 0; k < 3; k++) { const d = got[p * 4 + k] - want[p * 3 + k]; se += d * d; }
        out[id].push(psnr(se, w * h * 3));
      }
    }
  }
  eng.dispose();
  return out;
}

// ── parity of the adjust effects with fx.py's FFmpeg filters ─────────────────
export interface FxParityRef { w: number; h: number; a: string; tests: { id: string; adjust: Record<string, number>; vf: string; frame: string }[] }

/** Luma and chroma PSNR (dB) per adjust setting against FFmpeg running fx.adjust_filters() on yuv420p. */
export async function runFxParity(ref: FxParityRef): Promise<Record<string, [number, number]>> {
  const { w, h } = ref;
  const eng = await createEngine({ width: w, height: h, canvas: document.createElement("canvas") });
  const c: Composition = { width: w, height: h, fps: 24, duration: 1, stillsMatrix: "bt709", tracks: [{ id: "m", kind: "main", clips: [clip({ id: "a", media: { url: "ref:a", kind: "image" } })] }] };
  await eng.load(c, { mode: "exact", sources: { "ref:a": rawRgb(unb64(ref.a), w, h) } });
  const out: Record<string, [number, number]> = {};
  for (const t of ref.tests) {
    c.tracks[0].clips[0].fx = { adjust: t.adjust };
    await eng.renderExact(0);
    const got = eng.readYuv420(), want = unb64(t.frame);
    let sy = 0, sc = 0;
    for (let k = 0; k < got.length; k++) { const d = got[k] - want[k]; if (k < w * h) sy += d * d; else sc += d * d; }
    out[t.id] = [psnr(sy, w * h), psnr(sc, (w * h) / 2)];
  }
  eng.dispose();
  return out;
}
