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
 *   wave 3        every tv: transition also has to differ visibly from both pictures; temporal effects get warm-up
 *                 frames; then the 10-bit HDR read-back against the CPU packer, scopes, analyzeColor / matchColor,
 *                 thumbnails of a user's frame, MediaPipe (runFxBench: 1080p timings of the heavy new effects)
 */
import { makeLut } from "../cube";
import { analyzeColor, computeScopes, createEngine, listEffects, listTransitions, matchColor, mediaPipeStatus, registerEffect, registerTransition, trackFaces, type Engine } from "../index";
import { packI420p10, type Primaries, type Transfer } from "../colour";
import { labStats, samplePixels, statsDistance } from "../analysis/colorMath";
import type { Program } from "../gl/backend";
import { transitionProgram } from "../transitions/gltransitions";
import type { Clip, Composition, ShotFx, TitleSpec } from "../types";
import { packI420, yuvToRgb } from "../yuv";
import { badge, blocks, invertStripUrl, lightUrl, procedural, rawRgb } from "./media";
import { editorDemo } from "./demo";
import type { CustomSource } from "../sources/source";
import { onCanvasRestored, watchCanvas } from "../sources/canvasLoss";

export interface Failure { id: string; error: string }
export interface Check { name: string; ok: boolean; detail: string }
export interface SelfTestResult {
  ok: boolean; total: number; failures: Failure[]; ms: number; compileMs: number;
  transitions: { xfade: number; gl: number; custom: number; tv: number }; effects: number; registry: number; byGroup: Record<string, number>;
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
  await r.renderExact(0.5);
  const pureA = b.readFloat(r.frame!, 0, 0, W, H);
  await r.renderExact(2.5);
  const pureB = b.readFloat(r.frame!, 0, 0, W, H);
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
      if (id.startsWith("tv:")) {
        // a wave-3 transition must show something of its own: different from both pictures somewhere in it
        let ok = false, worst = "";
        for (const at of [1.5, 1.3, 1.7, 1.15]) {
          await r.renderExact(at);
          const px = b.readFloat(r.frame!, 0, 0, W, H);
          if (stats(px).nan) throw new Error("NaN pixels");
          const da = diff(px, pureA), db = diff(px, pureB);
          if (da.changed > 0.02 && db.changed > 0.02) { ok = true; break; }
          worst = `at ${at - 1}: vs A ${(da.changed * 100).toFixed(1)} %, vs B ${(db.changed * 100).toFixed(1)} %`;
        }
        if (!ok) throw new Error(`no visible transition (${worst})`);
        await r.renderExact(1.5);
      }
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
      if (e.id === "bg_replace") params.mode = "colour";
      const pre = FX_PRE[e.id] ?? [], src = FX_SRC[e.id], warm = e.temporal ? 6 : 0;
      let ref = SCALED.has(e.id) ? sref : vref;
      if (pre.length || src) {
        // the reference: the same picture and pre-chain without the effect, at the same frame
        await eng.load(vcomp(pre, SCALED.has(e.id), src), { mode: "exact", sources });
        await r.renderExact(1);
        ref = b.readFloat(r.frame!, 0, 0, W, H);
      }
      await eng.load(vcomp([...pre, { id: "under-test", type: e.id, params }], SCALED.has(e.id), src), { mode: "exact", sources });
      for (let k = warm; k >= 1; k--) await r.renderExact(1 - k / 24);
      r.warnings.clear();
      await r.renderExact(1);
      const px = b.readFloat(r.frame!, 0, 0, W, H);
      const st = stats(px);
      if (st.nan) throw new Error(`${st.nan} NaN pixels`);
      if (r.warnings.size) throw new Error([...r.warnings].join("; "));
      if (st.mean < 0.005 && !DARK.has(e.id)) throw new Error("all black");
      const d = diff(px, ref);
      if (d.mean < 0.002 && d.changed < 0.02) throw new Error(`no visible change (mean difference ${d.mean.toFixed(4)}, ${(d.changed * 100).toFixed(1)} % of pixels)`);
      items.push({ id, ms: performance.now() - s0, mean: st.mean });
      sheet.add(r.readRgba(), e.id, false);
    } catch (err) { failures.push({ id, error: (err as Error).message }); if (r.frame) sheet.add(r.readRgba(), e.id, true); }
  }
  eng.dispose();

  const checks = [...await genericChecks(sources, sheet), ...await wave3Checks(sources, sheet)];
  for (const c of checks) if (!c.ok) failures.push({ id: `check:${c.name}`, error: c.detail });
  const byGroup: Record<string, number> = {};
  for (const e of reg) byGroup[e.group] = (byGroup[e.group] ?? 0) + 1;
  return {
    ok: failures.length === 0, total: ids.length + fxTests.length + reg.length + checks.length, failures, ms: Math.round(performance.now() - t0), compileMs: Math.round(compileMs),
    transitions: { xfade: infos.filter((t) => t.kind === "xfade").length, gl: infos.filter((t) => t.kind === "gl").length, custom: infos.filter((t) => t.kind === "custom").length, tv: infos.filter((t) => t.kind === "tv").length },
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
  // wave 3
  output_transform: { target: "srgb" },
  hue_vs_sat: { curve: [[0, 0.1], [0.5, 0.95], [1, 0.1]] },
  hue_vs_hue: { curve: [[0, 0.95], [0.5, 0.05]] },
  luma_vs_sat: { curve: [[0, 0.05], [1, 0.95]] },
  scratches_dust: { scratches: 1, dust: 1, hairs: 1 },
  light_flicker: { amount: 1 },
  gate_weave: { amount: 10, rotation: 1 },
  skin_smoothing: { amount: 1, radius: 12 },
  temporal_denoise: { strength: 0.9, sensitivity: 0 },
  deflicker: { smoothing: 0.95 },
};
/** Effects that run on another effect's output in the test (noise to clean, flicker to even out). */
const FX_PRE: Record<string, Clip["effects"]> = {
  temporal_denoise: [{ id: "pre", type: "noise", params: { amount: 0.3, animate: true } }],
  skin_smoothing: [{ id: "pre", type: "noise", params: { amount: 0.25, animate: false } }],
  deflicker: [{ id: "pre", type: "light_flicker", params: { amount: 1, speed: 2 } }],
};
/** Effects tested on picture B (it has skin-like tones). */
const FX_SRC: Record<string, string> = { skin_smoothing: "lab:b" };
/** Effects that may leave the test picture dark. */
const DARK = new Set(["ascii", "edge_work", "luma_key"]);

const vclip = (id: string, url: string, start: number, duration: number, over: Partial<Clip> = {}): Clip =>
  ({ id, media: { url, kind: "image" }, start, duration, in: 0, speed: 1, fit: "contain", fx: {}, ...over });
/** A picture with a registry chain on a video track; `scaled`: at 60 % (effects that draw outside the picture). */
const vcomp = (effects: Clip["effects"], scaled = false, src = "lab:a"): Composition => ({ width: W, height: H, fps: 24, duration: 4, background: scaled ? [0.45, 0.5, 0.55] : [0, 0, 0], tracks: [{ id: "v1", kind: "video",
  clips: [vclip("a", src, 0, 4, { effects, ...(scaled ? { motion: { scale: { value: 60 } } } : {}) })] }] });
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

// ── wave 3: HDR read-back, scopes, analysis, thumbnails of a user frame, MediaPipe ────────────────────────────
async function wave3Checks(sources: Record<string, CustomSource>, sheet: Sheet): Promise<Check[]> {
  const out: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  const run = async (name: string, f: () => Promise<void>) => { try { await f(); } catch (e) { check(name, false, (e as Error).message); } };
  // 10-bit read-back against the CPU packer, every transfer and primaries
  await run("hdr read-back", async () => {
    const w = 64, h = 36;
    const eng = await createEngine({ width: w, height: h, canvas: document.createElement("canvas") });
    const rows: string[] = [];
    let ok = true;
    for (const [tf, pr] of [["sdr", "bt709"], ["sdr", "bt2020"], ["hlg", "bt2020"], ["pq", "bt2020"], ["pq", "bt709"]] as [Transfer, Primaries][]) {
      const c: Composition = { width: w, height: h, fps: 24, duration: 1, output: { transfer: tf, primaries: pr }, tracks: [{ id: "m", kind: "main", clips: [clip({ id: "p", media: { url: "lab:p", kind: "image" } })] }] };
      await eng.load(c, { mode: "exact", sources: { "lab:p": blocks(w, h, 5) } });
      await eng.renderExact(0);
      const f = eng.renderer.b.readFloat(eng.renderer.frame!, 0, 0, w, h);
      const got = eng.readYuv420p10().slice(), want = packI420p10(f, w, h, tf, pr);
      let md = 0;
      for (let i = 0; i < want.length; i++) md = Math.max(md, Math.abs(got[i] - want[i]));
      const y8 = eng.readYuv420();
      let m8 = 0;
      if (tf === "sdr" && pr === "bt709") for (let i = 0; i < y8.length; i++) m8 = Math.max(m8, Math.abs(got[i] - y8[i] * 4));
      rows.push(`${tf}/${pr}: max ${md}${tf === "sdr" && pr === "bt709" ? `, vs 8-bit×4 ${m8}` : ""}`);
      if (got.length !== w * h * 1.5 || md > 2 || m8 > 6) ok = false;
    }
    // an odd size (padded layout)
    const ow = 38, oh = 22;
    eng.resize(ow, oh);
    await eng.load({ width: ow, height: oh, fps: 24, duration: 1, tracks: [{ id: "m", kind: "main", clips: [clip({ id: "p", media: { url: "lab:q", kind: "image" } })] }] }, { mode: "exact", sources: { "lab:q": blocks(ow, oh, 9) } });
    await eng.renderExact(0);
    const fo = eng.renderer.b.readFloat(eng.renderer.frame!, 0, 0, ow, oh), go = eng.readYuv420p10(), wo = packI420p10(fo, ow, oh);
    let mo = 0;
    for (let i = 0; i < wo.length; i++) mo = Math.max(mo, Math.abs(go[i] - wo[i]));
    rows.push(`${ow}×${oh} padded: max ${mo}`);
    eng.dispose();
    check("hdr read-back", ok && mo <= 2 && go.length === ow * oh * 1.5, rows.join("; "));
  });
  // scopes: sizes, a grey frame's waveform trace at mid height, timing
  await run("scopes", async () => {
    const eng = await createEngine({ width: 1920, height: 1080, canvas: document.createElement("canvas") });
    await eng.load({ width: 1920, height: 1080, fps: 24, duration: 1, tracks: [{ id: "m", kind: "video", clips: [vclip("g", "", 0, 1, { type: "color", color: "#808080", fit: "fill" })] }] }, { mode: "exact" });
    await eng.renderExact(0);
    const wf = await eng.computeScopes("waveform", { width: 256, height: 128 });
    const c = document.createElement("canvas"); c.width = wf.width; c.height = wf.height;
    const g = c.getContext("2d")!; g.drawImage(wf, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let best = 0, row = -1;
    for (let y = 0; y < c.height; y++) { let s = 0; for (let x = 0; x < c.width; x++) s += px[(y * c.width + x) * 4 + 1]; if (s > best) { best = s; row = y; } }
    const want = (1 - (0.05 + 0.9 * (128 / 255))) * 128;
    const sizes: string[] = [];
    let ms = 0;
    await eng.load({ width: 1920, height: 1080, fps: 24, duration: 4, tracks: [{ id: "v", kind: "video", clips: [vclip("a", "lab:a", 0, 4, { fit: "fill" })] }] }, { mode: "exact", sources });
    await eng.renderExact(1);
    for (const k of ["waveform", "parade", "vectorscope", "histogram"] as const) {
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) { const bmp = await eng.computeScopes(k); if (i === 0) sizes.push(`${k} ${bmp.width}×${bmp.height}`); bmp.close(); }
      ms = Math.max(ms, (performance.now() - t0) / 5);
    }
    const mod = await computeScopes("histogram", { data: new Uint8Array(64 * 36 * 4).fill(200), width: 64, height: 36 });
    sizes.push(`module-level ${mod.width}×${mod.height}`);
    eng.dispose();
    check("scopes", Math.abs(row - want) <= 3 && ms < 100, `grey waveform peak row ${row} (want ≈${want.toFixed(1)}); ${sizes.join(", ")}; slowest ${ms.toFixed(1)} ms at 1080p`);
  });
  // analysis: a warm-tinted frame asks for a cooler temperature; matchColor brings the stats closer, through the engine
  await run("analyzeColor", async () => {
    const w = 160, h = 90, d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = 30 + (x / w) * 70 + (y / h) * 20, o = (y * w + x) * 4;
      d[o] = Math.min(255, v * 1.18 + 6); d[o + 1] = v; d[o + 2] = v * 0.8; d[o + 3] = 255;
    }
    const warm = await analyzeColor({ image: new ImageData(d, w, h) });
    for (let i = 0; i < d.length; i += 4) { const v = d[i + 1]; d[i] = v * 0.9; d[i + 1] = Math.min(255, v * 1.15 + 5); d[i + 2] = v * 0.9; }
    const green = await analyzeColor({ image: new ImageData(d, w, h) });
    check("analyzeColor", warm.wb.temperature < -0.05 && green.wb.tint > 0.05 && warm.stats.histogram.length === 256,
      `warm → temperature ${warm.wb.temperature}, tint ${warm.wb.tint}; green → tint ${green.wb.tint}; cast ${warm.wb.cast}`);
  });
  await run("matchColor", async () => {
    const eng = await createEngine({ width: W, height: H, canvas: document.createElement("canvas") });
    const shot = (url: string, effects?: Clip["effects"], fx: ShotFx = {}): Composition => ({ width: W, height: H, fps: 24, duration: 4, tracks: [{ id: "v", kind: "video", clips: [vclip("s", url, 0, 4, { effects, fx, fit: "fill" })] }] });
    const grab = async (c: Composition) => { await eng.load(c, { mode: "exact", sources }); await eng.renderExact(1); return new ImageData(Uint8ClampedArray.from(eng.readRgba()), W, H); };
    const srcImg = await grab(shot("lab:a", [{ type: "color_overlay", params: { color: "#2050ff", alpha: 0.35 } }]));
    const refImg = await grab(shot("lab:b"));
    const m = await matchColor({ image: srcImg }, { image: refImg });
    const st = (im: ImageData) => labStats(samplePixels(im.data, im.width, im.height));
    const ref = st(refImg), before = statsDistance(st(srcImg), ref);
    const viaLut = await grab(shot("lab:a", [{ type: "color_overlay", params: { color: "#2050ff", alpha: 0.35 } }, { type: "look", params: { look: m.lut.id, lut_strength: 1 } }]));
    const viaWheels = await grab(shot("lab:a", [{ type: "color_overlay", params: { color: "#2050ff", alpha: 0.35 } }, { type: "adjust", params: { saturation: m.adjust.saturation } }, { type: "wheels", params: m.wheels }]));
    const dl = statsDistance(st(viaLut), ref), dw = statsDistance(st(viaWheels), ref);
    // another window: the saved .cube by URL ("url:<url>"), nothing registered there
    const cubeUrl = URL.createObjectURL(new Blob([m.cube], { type: "text/plain" }));
    const viaUrl = await grab(shot("lab:a", [{ type: "color_overlay", params: { color: "#2050ff", alpha: 0.35 } }, { type: "look", params: { look: `url:${cubeUrl}`, lut_strength: 1 } }]));
    URL.revokeObjectURL(cubeUrl);
    let du = 0;
    for (let i = 0; i < viaUrl.data.length; i++) du = Math.max(du, Math.abs(viaUrl.data[i] - viaLut.data[i]));
    sheet.add(eng.readRgba(), "matchColor (wheels)", !(dw < before));
    eng.dispose();
    check("matchColor", dl < before * 0.7 && dw < before && du <= 1, `Lab distance to the reference: before ${before.toFixed(1)}, LUT ${dl.toFixed(1)}, adjust + wheels ${dw.toFixed(1)}; the .cube loaded by URL vs the registered LUT: max ${du}`);
  });
  // thumbnails of a user's own frame through a look, an effect and a transition
  await run("thumbnails of a user frame", async () => {
    const eng = await createEngine({ width: W, height: H, canvas: document.createElement("canvas") });
    const cv = sources["lab:b"].draw(0) as HTMLCanvasElement;
    const image = await createImageBitmap(cv);
    const a = await eng.renderThumbnail("teal_orange", 160, "look", { source: { image } });
    const b2 = await eng.renderThumbnail("film_grain", 160, "effect", { source: { image }, params: { amount: 1 } });
    const c = await eng.renderThumbnail("tv:matte_burn", 160, "transition", { source: { image }, progress: 0.4 });
    const plain = await eng.renderThumbnail("vignette", 160, "effect", { source: { image }, params: { amount: 0 } });
    const read = (bmp: ImageBitmap) => { const k = document.createElement("canvas"); k.width = bmp.width; k.height = bmp.height; const g = k.getContext("2d")!; g.drawImage(bmp, 0, 0); return g.getImageData(0, 0, k.width, k.height).data; };
    const p0 = read(plain), dd = (x: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < x.length; i += 4) s += Math.abs(x[i] - p0[i]) + Math.abs(x[i + 1] - p0[i + 1]) + Math.abs(x[i + 2] - p0[i + 2]); return s / (x.length / 4) / 3; };
    const ds = [dd(read(a)), dd(read(b2)), dd(read(c))];
    eng.dispose();
    check("thumbnails of a user frame", [a, b2, c].every((x) => x.width === 160 && x.height === 90) && ds.every((x) => x > 1), `differences from the plain frame (0..255): look ${ds[0].toFixed(1)}, grain ${ds[1].toFixed(1)}, burn ${ds[2].toFixed(1)}`);
  });
  // temporal history: a redraw of the same frame is the same; a jump starts over
  await run("temporal history", async () => {
    const eng = await createEngine({ width: W, height: H, canvas: document.createElement("canvas") });
    await eng.load(vcomp([{ id: "n", type: "noise", params: { amount: 0.3 } }, { id: "d", type: "temporal_denoise", params: { strength: 0.9, sensitivity: 0 } }]), { mode: "exact", sources });
    for (let k = 4; k >= 1; k--) await eng.renderExact(1 - k / 24);
    await eng.renderExact(1);
    const a1 = eng.readRgba().slice();
    await eng.renderExact(1);
    const a2 = eng.readRgba();
    let same = 0;
    for (let i = 0; i < a1.length; i++) same = Math.max(same, Math.abs(a1[i] - a2[i]));
    await eng.renderExact(3);  // a jump: no history
    const j = eng.renderer.b.readFloat(eng.renderer.frame!, 0, 0, W, H);
    await eng.load(vcomp([{ id: "n", type: "noise", params: { amount: 0.3 } }]), { mode: "exact", sources });
    await eng.renderExact(3);
    const plain = eng.renderer.b.readFloat(eng.renderer.frame!, 0, 0, W, H);
    const dj = diff(j, plain);
    eng.dispose();
    check("temporal history", same <= 1 && dj.mean < 0.05, `redraw max difference ${same}; after a jump vs no history: mean ${dj.mean.toFixed(4)}`);
  });
  // speed ramps (Clip.timeMap) and freeze frames (speed 0), exact: the mapped source time is the very frame drawn
  await run("time remap (exact)", async () => {
    const eng = await createEngine({ width: W, height: H, canvas: document.createElement("canvas") });
    const mv = { "lab:mv": procedural("A", W, H, false) };
    const one = (o: Partial<Clip>): Composition => ({ width: W, height: H, fps: 24, duration: 6, tracks: [{ id: "v", kind: "video", clips: [vclip("c", "lab:mv", 0, 6, { media: { url: "lab:mv", kind: "video", duration: 10 }, fit: "fill", ...o })] }] });
    const at = async (c: Composition, t: number) => { await eng.load(c, { mode: "exact", sources: mv }); await eng.renderExact(t); return eng.readRgba().slice(); };
    const same = (a: Uint8Array, b2: Uint8Array) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b2[i])); return m; };
    const ramp = one({ timeMap: [{ t: 0, s: 0 }, { t: 1, s: 0.5 }, { t: 2, s: 0.5 }, { t: 3, s: 2.5 }] });
    const r1 = same(await at(ramp, 0.5), await at(one({ in: 0.25 }), 0));
    const r2 = same(await at(ramp, 2.5), await at(one({ in: 1.5 }), 0));
    const f1 = await at(ramp, 1.2), f2 = await at(ramp, 1.8);
    const fz = same(f1, f2), fz0 = same(f1, await at(one({ in: 0.5 }), 0));
    const moving = same(await at(one({}), 1.2), await at(one({}), 1.8));
    const s0 = same(await at(one({ speed: 0, in: 2 }), 0.3), await at(one({ speed: 0, in: 2 }), 4));
    eng.dispose();
    check("time remap (exact)", r1 === 0 && r2 === 0 && fz === 0 && fz0 === 0 && moving > 20 && s0 === 0,
      `ramp vs plain at the mapped time: ${r1}, ${r2}; freeze segment: ${fz} (vs its frame ${fz0}; a moving clip differs by ${moving}); speed 0: ${s0}`);
  });
  // custom sources with version / bounds: nothing goes up while static, only the changed box otherwise
  await run("custom source bounds", async () => {
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d")!;
    let ver = 1, box: [number, number, number, number] = [20, 20, 60, 30];
    const paint = () => { g.clearRect(0, 0, W, H); g.fillStyle = "#ff8800"; g.fillRect(box[0], box[1], box[2], box[3]); };
    paint();
    const hooked: CustomSource = { kind: "canvas", width: W, height: H, draw: () => cv, version: () => ver, bounds: () => box };
    const plain: CustomSource = { kind: "canvas", width: W, height: H, draw: () => cv };
    const c = (url: string): Composition => ({ width: W, height: H, fps: 24, duration: 4, background: [0, 0, 0], tracks: [{ id: "v", kind: "video", clips: [vclip("t", url, 0, 4, { fit: "fill" })] }] });
    const eng = await createEngine({ width: W, height: H, canvas: document.createElement("canvas") });
    await eng.load(c("cus:title"), { mode: "exact", sources: { "cus:title": hooked } });
    await eng.renderExact(0.5);
    const u0 = eng.stats.uploads;
    await eng.renderExact(1); await eng.renderExact(1.5);
    const u1 = eng.stats.uploads;
    ver = 2; box = [120, 60, 50, 40]; paint();
    const s0 = eng.stats.subUploads;
    await eng.renderExact(2);
    const sub = eng.stats.subUploads - s0, got = eng.readRgba().slice();
    eng.dispose();
    const ref = await createEngine({ width: W, height: H, canvas: document.createElement("canvas") });
    await ref.load(c("cus:plain"), { mode: "exact", sources: { "cus:plain": plain } });
    await ref.renderExact(2);
    const want = ref.readRgba();
    ref.dispose();
    let md = 0;
    for (let i = 0; i < want.length; i++) md = Math.max(md, Math.abs(want[i] - got[i]));
    check("custom source bounds", u1 === u0 && sub === 1 && md === 0, `static frames uploaded ${u1 - u0} times; after a change ${sub} sub-rect upload; vs a full upload max difference ${md}`);
  });
  // a GPU reset (canvasLoss.ts): the browser brings every 2D canvas back blank and fires "contextrestored"; titles
  // holding still (the engine's own, and a versioned custom source like the editor's template titles) and colour
  // mattes draw again, also when the WebGL context was lost with them, and the monitors hear of it
  await run("canvas restore (GPU reset)", async () => {
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d")!;
    let last = "", box: [number, number, number, number] | null = null;
    const restores = watchCanvas(cv);
    const keyAt = () => `static|${restores()}`;
    const paint = () => { g.clearRect(0, 0, W, H); g.fillStyle = "#ff8800"; g.fillRect(200, 40, 80, 50); box = [200, 40, 80, 50]; };
    const hooked: CustomSource = { kind: "canvas", width: W, height: H, version: () => restores(), bounds: () => box,
      draw: () => { if (keyAt() !== last) { last = keyAt(); paint(); } return cv; } };
    const title: TitleSpec = { text: "Holding still", font: "Inter Variable", size: 28, color: "#ffffff", weight: 700, align: "center", box: [0.05, 0.6, 0.6, 0.3] };
    const comp: Composition = { width: W, height: H, fps: 24, duration: 4, background: [0, 0, 0], tracks: [
      { id: "m", kind: "video", clips: [vclip("matte", "", 0, 4, { type: "color", color: "#2255cc", motion: { scale: { value: 30 }, position: { value: [50, 40] } } })] },
      { id: "t", kind: "video", clips: [vclip("title", "", 0, 4, { type: "title", title })] },
      { id: "c", kind: "video", clips: [vclip("hook", "cus:still", 0, 4, { fit: "fill" })] },
    ] };
    await document.fonts.load(`700 28px "Inter Variable"`).catch(() => undefined);
    const eng = await createEngine({ width: W, height: H, canvas: document.createElement("canvas") });
    const r = eng.renderer, b = r.b;
    await eng.load(comp, { mode: "live", sources: { "cus:still": hooked } });
    for (let i = 0; i < 3; i++) eng.drawLive(2 + i / 24);
    const before = eng.readRgba().slice();
    const maxDiff = (a: Uint8Array) => { let m = 0; for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(a[i + k] - before[i + k])); return m; };
    let lit = 0;
    for (let i = 0; i < before.length; i += 4) if (before[i] + before[i + 1] + before[i + 2] > 60) lit++;
    let heard = 0;
    const off = onCanvasRestored(() => { heard++; });
    const canvases = [cv, ...[...(r as unknown as { sources: Map<string, { cv?: HTMLCanvasElement | OffscreenCanvas | null }> }).sources.values()].map((s) => s.cv).filter((c): c is HTMLCanvasElement | OffscreenCanvas => !!c)];
    const blank = () => { for (const c of canvases) { (c.getContext("2d") as CanvasRenderingContext2D).clearRect(0, 0, c.width, c.height); c.dispatchEvent(new Event("contextrestored")); } };
    // 1. only the 2D canvases come back blank (the engine's textures stay): the pictures are drawn and uploaded again
    blank();
    for (let i = 0; i < 3; i++) eng.drawLive(2.5 + i / 24);
    const md1 = maxDiff(eng.readRgba());
    // 2. the whole GPU: the WebGL context goes too, and comes back after the canvases
    const lose = b.gl.getExtension("WEBGL_lose_context");
    if (lose) { lose.loseContext(); await until(() => b.lost); }
    blank();
    if (lose) { lose.restoreContext(); await until(() => !b.lost); }
    for (let i = 0; i < 3; i++) eng.drawLive(3 + i / 24);
    const after = eng.readRgba().slice();
    const md2 = maxDiff(after);
    await new Promise((res) => setTimeout(res, 60));
    off();
    eng.dispose();
    check("canvas restore (GPU reset)", canvases.length === 3 && lit > 1500 && md1 <= 2 && md2 <= 2 && heard >= 1 && (!lose || eng.stats.restores === 1),
      `${canvases.length} canvases blanked (custom, title, matte), ${lit} lit pixels; max difference after a 2D reset ${md1}, after a full GPU reset ${md2}; monitors told ${heard}×; WebGL restores ${eng.stats.restores}`);
    sheet.add(after, "after a GPU reset (2D canvases blanked)", md2 > 2);
  });
  // live: the <video> runs at the time map's slope, pauses on a freeze (never playbackRate 0)
  await run("time remap (live)", async () => {
    const cv = document.createElement("canvas"); cv.width = 160; cv.height = 90;
    const g = cv.getContext("2d")!;
    const rec = new MediaRecorder(cv.captureStream(30), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start(100);
    const t0 = performance.now();
    await new Promise<void>((res) => { const tick = () => { const k = (performance.now() - t0) / 1000; g.fillStyle = `hsl(${k * 200} 80% 50%)`; g.fillRect(0, 0, 160, 90); if (k < 4) requestAnimationFrame(tick); else res(); }; tick(); });
    await new Promise<void>((res) => { rec.onstop = () => res(); rec.stop(); });
    const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
    const eng = await createEngine({ width: 160, height: 90, canvas: document.createElement("canvas") });
    const c: Composition = { width: 160, height: 90, fps: 24, duration: 6, tracks: [{ id: "v", kind: "video", clips: [vclip("c", url, 0, 6, { media: { url, kind: "video" }, fit: "fill",
      timeMap: [{ t: 0, s: 0 }, { t: 2, s: 1 }, { t: 3, s: 1 }, { t: 5, s: 3 }] })] }] };
    await eng.load(c, { mode: "live" });
    const el = [...(eng.renderer as unknown as { sources: Map<string, { el?: HTMLVideoElement }> }).sources.values()].find((x) => x.el)?.el;
    if (!el) throw new Error("no video element");
    const state = async (t: number) => { for (let i = 0; i < 12; i++) { eng.drawLive(t + i / 60, { playing: true }); await new Promise((r) => setTimeout(r, 16)); } return { rate: el.playbackRate, paused: el.paused }; };
    const a = await state(0.5), f = await state(2.2), b2 = await state(3.5);
    eng.dispose();
    URL.revokeObjectURL(url);
    check("time remap (live)", Math.abs(a.rate - 0.5) < 0.08 && !a.paused && f.paused && f.rate > 0 && Math.abs(b2.rate - 1) < 0.15 && !b2.paused,
      `slope 0.5: rate ${a.rate.toFixed(3)} ${a.paused ? "paused" : "playing"}; freeze: ${f.paused ? "paused" : "playing"} (rate ${f.rate.toFixed(3)}); slope 1: rate ${b2.rate.toFixed(3)} ${b2.paused ? "paused" : "playing"}`);
  });
  // MediaPipe: the segmenter and the face detector load (WASM from the build, models from /models/mediapipe)
  await run("mediapipe", async () => {
    const t0 = performance.now();
    const faces = await trackFaces(invertStripUrl(16), 0, 0);
    const st = mediaPipeStatus();
    check("mediapipe", st.segmenter === "ready" && st.faces === "ready" && Array.isArray(faces), `segmenter ${st.segmenter}, face detector ${st.faces} (${st.delegate}); faces in a test strip: ${faces.length}; ${(performance.now() - t0).toFixed(0)} ms`);
  });
  // MediaPipe on a real picture (the studio's showcase dancer): the person matte and the face
  await run("mediapipe on a person", async () => {
    const url = "/showcase/dance.webp";
    const faces = await trackFaces(url, 0, 0);
    const f = faces[0];
    const faceOk = !!f && Math.abs(f.cx - 0.51) < 0.06 && Math.abs(f.cy - 0.24) < 0.08 && f.w > 0.02 && f.w < 0.25;
    const w = W, h = H;
    const eng = await createEngine({ width: w, height: h, canvas: document.createElement("canvas") });
    await eng.load({ width: w, height: h, fps: 24, duration: 1, tracks: [{ id: "v", kind: "video", clips: [vclip("d", url, 0, 1, { fit: "fill", effects: [{ id: "m", type: "bg_blur", params: { show_mask: true, feather: 0 } }] })] }] }, { mode: "exact" });
    eng.renderer.warnings.clear();
    await eng.renderExact(0.5);
    const px = eng.renderer.b.readFloat(eng.renderer.frame!, 0, 0, w, h);
    const mean = (x0: number, y0: number, x1: number, y1: number) => { let s = 0, n = 0; for (let y = Math.floor(y0 * h); y < y1 * h; y++) for (let x = Math.floor(x0 * w); x < x1 * w; x++) { s += px[(y * w + x) * 4]; n++; } return s / Math.max(n, 1); };
    const body = mean(0.46, 0.4, 0.56, 0.7), corners = (mean(0, 0, 0.15, 0.25) + mean(0.85, 0, 1, 0.25) + mean(0, 0.8, 0.15, 1) + mean(0.85, 0.8, 1, 1)) / 4;
    sheet.add(eng.readRgba(), "person matte", false);
    const warn = [...eng.renderer.warnings];
    eng.dispose();
    check("mediapipe on a person", faceOk && body > 0.6 && corners < 0.15 && !warn.length,
      `subject (${f?.source ?? "none"}) ${f ? `centre ${f.cx.toFixed(3)}, ${f.cy.toFixed(3)}, ${f.w.toFixed(3)}×${f.h.toFixed(3)}, score ${f.score.toFixed(2)}; ${f.faces.length} face boxes` : ""} (the dancer's face is at about 0.51, 0.24); person matte: body ${body.toFixed(2)}, corners ${corners.toFixed(2)}${warn.length ? "; " + warn.join("; ") : ""}`);
  });
  return out;
}

// ── 1080p timings of the heavy new effects and transitions ────────────────────
export interface FxBenchResult { renderer: string; results: { id: string; avgMs: number; p95Ms: number }[] }
export async function runFxBench(frames = 30): Promise<FxBenchResult> {
  const w = 1920, h = 1080;
  const eng = await createEngine({ width: w, height: h, canvas: document.createElement("canvas") });
  const sources = { "lab:a": procedural("A", w, h, true), "lab:b": procedural("B", w, h, true) };
  const results: FxBenchResult["results"] = [];
  const time = async (id: string, c: Composition, at: (i: number) => number) => {
    await eng.load(c, { mode: "exact", sources });
    for (let i = 0; i < 4; i++) { await eng.renderExact(at(i)); eng.renderer.b.finish(); }
    const ms: number[] = [];
    for (let i = 0; i < frames; i++) { const s = performance.now(); await eng.renderExact(at(i + 4)); eng.renderer.b.finish(); ms.push(performance.now() - s); }
    ms.sort((a, b) => a - b);
    results.push({ id, avgMs: round(ms.reduce((a, b) => a + b, 0) / ms.length), p95Ms: round(ms[Math.floor(ms.length * 0.95)]) });
  };
  const one = (effects: Clip["effects"]): Composition => ({ width: w, height: h, fps: 24, duration: 8, tracks: [{ id: "v", kind: "video", clips: [vclip("a", "lab:a", 0, 8, { effects, fit: "fill" })] }] });
  await time("plain clip", one([]), (i) => 0.5 + i / 24);
  for (const [id, params] of [["bokeh_blur", { radius: 24 }], ["temporal_denoise", {}], ["bg_blur", {}], ["oil_paint", {}], ["watercolour", {}], ["anamorphic_flare", {}], ["skin_smoothing", {}], ["input_profile", {}], ["film_grain", {}]] as [string, Record<string, unknown>][])
  {
    await time(id, one([{ id: "x", type: id, params }]), (i) => 0.5 + i / 24);
    if (id === "bg_blur") results.push({ id: "bg_blur: segmentation of the last frame", avgMs: round(mediaPipeStatus().segmentMs ?? -1), p95Ms: 0 });
  }
  for (const tr of ["tv:matte_burn", "tv:whip_left", "tv:cube_left", "tv:light_leak_warm", "tv:vhs_tracking"]) {
    const c: Composition = { width: w, height: h, fps: 24, duration: 4, tracks: [{ id: "m", kind: "main", clips: [clip({ id: "a", duration: 3 }), clip({ id: "b", start: 1, duration: 3, media: { url: "lab:b", kind: "image" }, transitionIn: { type: tr, duration: 2 } })] }] };
    await time(tr, c, (i) => 1.05 + (i / (frames + 4)) * 1.9);
  }
  const renderer = gpuName(eng);
  eng.dispose();
  return { renderer, results };
}

// ── MediaPipe timings and the face boxes of the showcase dancer ───────────────
export interface MlBenchResult { segment: Record<string, { loadMs: number; avgMs: number; p95Ms: number }>; faces: unknown; trackMs: number }
export async function runMlBench(): Promise<MlBenchResult> {
  const mp = await import("../ml/mediapipe");
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 144;
  const g = cv.getContext("2d")!;
  const img = await createImageBitmap(await (await fetch("/showcase/dance.webp")).blob());
  g.drawImage(img, 0, 0, 256, 144);
  const data = g.getImageData(0, 0, 256, 144);
  const segment: MlBenchResult["segment"] = {};
  for (const d of ["CPU", "GPU"] as const) {
    try {
      mp.setMediaPipeOptions({ delegate: d });
      const t0 = performance.now();
      await mp.loadSegmenter();
      const loadMs = performance.now() - t0;
      const ms: number[] = [];
      for (let i = 0; i < 25; i++) { const s = performance.now(); mp.segmentPerson(data); ms.push(performance.now() - s); }
      ms.sort((a, b) => a - b);
      segment[d] = { loadMs: round(loadMs), avgMs: round(ms.slice(3).reduce((a, b) => a + b, 0) / (ms.length - 3)), p95Ms: round(ms[Math.floor(ms.length * 0.95)]) };
    } catch (e) { segment[d] = { loadMs: -1, avgMs: -1, p95Ms: -1 }; console.warn(d, e); }
  }
  mp.setMediaPipeOptions({ delegate: "CPU" });
  const full = await mp.detectFaces(img, img.width, img.height, { tiles: false, minScore: 0.3 });
  const tiled = await mp.detectFaces(img, img.width, img.height);
  const t1 = performance.now();
  const track = await mp.trackFaces("/showcase/dance.webp", 0, 0);
  return { segment, faces: { full, tiled, track }, trackMs: round(performance.now() - t1) };
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
