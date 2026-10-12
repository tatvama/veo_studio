/**
 * Draws a Composition frame on the GPU (docs/ENGINE.md §4, docs/EDITOR.md §6), tracks bottom → top:
 * - "main" (the studio cut): each shot fills the frame (cover) through its framing transform, then its fx (a LUT or a
 *   preset look run as its FFmpeg filters, adjust, wheels, curves, chroma key, glow, sharpen, blur, vignette, grain,
 *   inside its mask), its registry effects, its fade to black; the two shots of a transition blend.
 * - "layer": pictures placed by their `transform`.
 * - "video" (the editor), and any clip with `motion`: the picture (media, title, colour matte, nested composition)
 *   with its fx and registry effects, placed by its motion; adjustment clips grade everything below them; transitions
 *   at cuts and clip edges blend premultiplied full-frame layers, reaching into the clips' handles.
 * Then the canvas or the YUV read-back. Every picture renders into a pooled target; a plain clip is one pass.
 */
import { parseCube, type Lut3D } from "./cube";
import { bakeCurves } from "./curves";
import { frandGrid, frandRows } from "./frand";
import { isNativeLook, lookGlsl, NATIVE_LOOKS } from "./effects/looks";
import { eqInt, fxPlan, gblurWeights, hexRgb, linearTaps, type FxPlan } from "./effects/params";
import { curveTexels, effectSource, getEffect, paramUniforms, paramValues, passesOf, type EffectApi, type EffectDef, type PassContext } from "./effects/registry";
import { BLUR, clipShader, COMPOSITE, COPY, COVER, FADE, GBLUR, GLOW_EXTRACT, MASK_MIX, PRESENT, UNSHARP, YUV10_PACK, YUV2RGB, YUV_PACK, type ClipFlags } from "./effects/shaders";
import { clipUv, layerRect, minification, motionRect } from "./framing";
import { isAnimated, isParam } from "./keyframes";
import { ShaderError, type Program, type RenderTarget, type Texture, type Texture3D, type UniformValue } from "./gl/backend";
import { WebGL2Backend } from "./gl/webgl2";
import { ExactVideo } from "./sources/exact";
import { LiveVideo } from "./sources/live";
import { CanvasSource, ImageSource, type CustomSource, type Frame, type FrameSource } from "./sources/source";
import { MatteSource, TitleSource } from "./sources/title";
import { evaluate, sourceRate, sourceTime, type ClipState, type FrameState, type MotionState, type TrackState, type TransitionState } from "./timeline";
import { loadGl, transitionProgram, transitionUniforms, type TransitionProgram } from "./transitions/gltransitions";
import { BLEND_MODES, type BlendMode, type Clip, type Composition, type EffectInstance, type FxMask, type ShotFx, type Track } from "./types";
import { basis, glslMat3, repack, repack10, rgbToYuv, yuv10Layout, yuvLayout } from "./yuv";
import { equalise, matteDef, matteSeed, matteSize, MATTE_CURVE } from "./transitions/pack/mattes";
import { matteSource } from "./transitions/pack/index";
import { registeredLut } from "./luts";
import { loadSegmenter, segmentPerson, segmenterReady } from "./ml/mediapipe";

const M_STILL = glslMat3(basis("bt601", "bt709"));   // a still's RGB → the working RGB of FFmpeg's BT.601 encode
const M_FF = glslMat3(basis("bt709", "bt601"));      // working RGB → the RGB FFmpeg's filters see (BT.601)
const M_FF_INV = glslMat3(basis("bt601", "bt709"));

export type Mode = "live" | "exact";
export interface LoadOptions {
  mode?: Mode;
  /** url → a picture the page draws itself (the lab's procedural media, the editor's demo media). */
  sources?: Record<string, CustomSource>;
  /** look id → an already parsed LUT (else Composition.lutUrls are fetched). */
  luts?: Record<string, Lut3D>;
}
export interface DrawOptions {
  /** The videos run on their own (else guessed from how t moves). */
  playing?: boolean;
  rate?: number;
  /** Playback resolution: 1, 0.5 or 0.25 of the output size (scaled up onto the canvas). Default 1. */
  resolution?: number;
}
/** An effect instance's picture from earlier frames (EffectDef.temporal). */
interface Hist { frame: number; prev: RenderTarget | null; cur: RenderTarget | null; used: number }
/** An effect instance's person mask (EffectDef.segmentation). */
interface SegMask { frame: number; uploads: number; tex: Texture; used: number }
/** Options of a thumbnail (Engine.renderThumbnail). */
export interface ThumbOptions {
  /** The user's own picture instead of the sample one (the LUT and Mood browsers). */
  source?: TexImageSource & { width: number; height: number };
  /** Parameters for the effect (or the transition's uniforms). */
  params?: Record<string, unknown>;
  /** Transitions: where to show it (default 0.5). */
  progress?: number;
  /** A look's .cube URL when it isn't a native look or a registered LUT. */
  lutUrl?: string;
}
interface SrcTex {
  tex: Texture; version: number;
  /** The uploaded image (exact-mode video: the planes and the converted picture instead). */
  img: Texture;
  planes?: { y: Texture; c: Texture; c2: Texture };
  rt?: RenderTarget;
  /** FFmpeg turns this picture into RGB with BT.601 (untagged video, stills). */
  ff601: boolean;
  still: boolean;
}
type Tex = Texture | Texture3D;
/** A composition being drawn: its render size, render pixels per composition pixel (`unit`; `px` with pixelScale). */
interface Ctx { comp: Composition; W: number; H: number; unit: number; px: number; path: string; depth: number }
/** What a clip samples: a source's texture, a nested composition, or what's below an adjustment clip. `pw`×`ph` is
 *  the picture's own pixel size (motion's anchor unit). */
interface Pic { tex: Texture; still: boolean; ff601: boolean; pw: number; ph: number; own?: RenderTarget }
interface Placed { rt: RenderTarget; cx: number; cy: number; w: number; h: number; rot: number; opacity: number; blend?: BlendMode }
interface ClipOpts {
  pic?: Pic | null;
  /** The target is the picture's own rectangle (motion): sample all of it (else the clip's fit). */
  fill?: boolean;
  /** Render pixels per composition pixel for pixel-sized effects. */
  px?: number;
  ctx?: Ctx;
  /** false: leave the main track's fade to the caller. */
  fade?: boolean;
  path?: string;
}

const PRELOAD_S = 3, KEEP_S = 6, MAX_NEST = 8;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const blendIdx = (m?: BlendMode) => Math.max(0, BLEND_MODES.indexOf(m ?? "normal"));
/** A nested clip's time inside its composition at cut time t (its time map, speed, freeze). */
const nestedTime = (c: Clip, t: number) => sourceTime(c, t - c.start, true);
const hasEffects = (c: Clip) => !!c.effects?.some((e) => e && e.enabled !== false);
/** Seconds a track's transitions reach past its clips' ends (export keeps their decoders that long). */
const reachOf = (tk: Track) => Math.max(0, ...(tk.transitions ?? []).map((x) => x.duration || 0), ...tk.clips.map((c) => c.transitionIn?.duration ?? 0));

export class Renderer {
  readonly b: WebGL2Backend;
  comp: Composition | null = null;
  mode: Mode = "live";
  /** Output size (the composition's, unless resized). */
  w = 0; h = 0;
  /** The last frame drawn (valid until the next draw). */
  frame: RenderTarget | null = null;
  readonly warnings = new Set<string>();
  readonly stats = { uploads: 0, passes: 0, lastMs: 0, restores: 0, resolution: 1, subUploads: 0 };
  private opts: LoadOptions = {};
  private custom: Record<string, CustomSource> = {};
  private sources = new Map<string, FrameSource>();
  /** The CustomSource object a "cus:" source was made from (a new object for the same url replaces it). */
  private customOf = new Map<string, CustomSource>();
  private texs = new Map<FrameSource, SrcTex>();
  private luts = new Map<string, { tex: Texture3D; lut: Lut3D; from: string | Lut3D }>();
  private curveTex = new Map<string, Texture>();
  private images = new Map<string, { bmp: ImageBitmap | null; tex: Texture | null }>();
  private noise: Texture | null = null;
  private clearTex: Texture | null = null;
  private whiteTex: Texture | null = null;
  private rand = new Map<string, Texture>();
  private shaders = new Map<string, { name: string; source: string }>();
  private fxShaders = new WeakMap<EffectDef, { name: string; source: string }[]>();
  private lookCode = new Map<string, string>();
  private samples: Texture[] | null = null;
  private yuvBuf: Uint8Array | null = null;
  private yuv10Buf: Uint8Array | null = null;
  /** Luma mattes of the tv: pack, generated once per matte and aspect ratio. */
  private mattes = new Map<string, RenderTarget>();
  private history = new Map<string, Hist>();
  private segs = new Map<string, SegMask>();
  /** drawLive calls (segmentation runs at most once per displayed frame). */
  private drawNo = 0;
  private last = { t: NaN, wall: 0 };
  /** This frame's render size (the output size × the playback resolution). */
  private rw = 0; private rh = 0;
  private frames = 0;

  constructor(b: WebGL2Backend) {
    this.b = b;
    b.onRestore = () => this.restored();
  }

  /** Takes a composition. Calling it again (an edit) keeps the media, LUTs and textures the new one still uses, so
   *  it's cheap; custom sources are kept while their object for a url stays the same. A new mode starts over. */
  async load(comp: Composition, opts: LoadOptions = {}): Promise<void> {
    const mode = opts.mode ?? "live";
    if (mode !== this.mode) this.unload();
    this.mode = mode;
    this.opts = opts;
    this.custom = opts.sources ?? {};
    this.prune(comp, opts);
    this.warnings.clear();
    this.comp = comp;
    if (!this.w || !this.h) { this.w = comp.width; this.h = comp.height; }
    for (const w of comp.warnings ?? []) this.warnings.add(w);
    let gl = false;
    this.eachClip(comp, (c) => { if (c.transitionIn?.type.startsWith("gl:")) gl = true; }, (tk) => { if (tk.transitions?.some((x) => x.type.startsWith("gl:"))) gl = true; });
    if (gl) await loadGl().catch(() => this.warnings.add("gl-transitions didn't load"));
    await Promise.all([this.loadLuts(comp, opts), this.loadImages(comp), this.prepareEffects(comp)]);
    // the first frame's media
    const waits: Promise<unknown>[] = [];
    this.visit(evaluate(comp, 0), this.rootCtx(this.w, this.h), 1, (cs, ctx) => {
      const s = this.sourceFor(cs.clip, ctx.path);
      if (s) waits.push(s.ready.catch((e) => this.warnings.add((e as Error).message)));
    });
    await Promise.all(waits);
  }

  /** An edit: load() with the last options (only what changed is (re)loaded). */
  update(comp: Composition, opts: LoadOptions = {}): Promise<void> { return this.load(comp, { ...this.opts, ...opts }); }

  /** Output size (canvas and render). */
  resize(w: number, h: number) {
    this.w = Math.max(2, Math.round(w)); this.h = Math.max(2, Math.round(h));
    this.b.resizeCanvas(this.w, this.h);
    this.b.release(this.frame); this.frame = null;
    this.b.trim();
  }

  private pxScale() { return this.comp ? (this.comp.pixelScale ?? 1) * ((this.rh || this.h) / (this.comp.height || 1)) : 1; }

  // ── composition walking ────────────────────────────────────────────────────
  /** Every clip (nested compositions' too) with the path of nested clip ids leading to it. */
  private eachClip(comp: Composition, fn: (c: Clip, path: string, tk: Track) => void, onTrack?: (tk: Track) => void, path = "", depth = 0) {
    for (const tk of comp.tracks) {
      onTrack?.(tk);
      for (const c of tk.clips) {
        fn(c, path, tk);
        if (c.type === "nested" && c.comp && depth < MAX_NEST) this.eachClip(c.comp, fn, onTrack, `${path}${c.id}/`, depth + 1);
      }
    }
  }

  /** Every clip state of a frame (transitions' and nested ones too) with its composition's context. */
  private visit(fs: FrameState, ctx: Ctx, rate: number, fn: (cs: ClipState, ctx: Ctx, rate: number) => void) {
    for (const ts of fs.tracks) for (const cs of ts.clips) {
      fn(cs, ctx, rate);
      if (cs.nested && cs.clip.comp) this.visit(cs.nested, this.nestedCtx(ctx, cs.clip), rate * sourceRate(cs.clip, cs.local), fn);
    }
  }

  private rootCtx(W: number, H: number): Ctx {
    const comp = this.comp!;
    const unit = H / (comp.height || H);
    return { comp, W, H, unit, px: (comp.pixelScale ?? 1) * unit, path: "", depth: 0 };
  }

  /** A nested composition drawn at the parent's pixel density (within the texture limit). */
  private nestedCtx(ctx: Ctx, c: Clip): Ctx {
    const nc = c.comp!;
    let W = Math.max(2, Math.round(nc.width * ctx.unit)), H = Math.max(2, Math.round(nc.height * ctx.unit));
    const k = Math.min(1, this.b.maxTextureSize / W, this.b.maxTextureSize / H);
    W = Math.max(2, Math.floor(W * k)); H = Math.max(2, Math.floor(H * k));
    const unit = H / (nc.height || H);
    return { comp: nc, W, H, unit, px: (ctx.px / ctx.unit) * unit, path: `${ctx.path}${c.id}/`, depth: ctx.depth + 1 };
  }

  // ── sources ────────────────────────────────────────────────────────────────
  private keyOf(c: Clip, path: string, custom = this.custom): string | null {
    const type = c.type ?? "media";
    if (type === "title") return c.title ? `title:${path}${c.id}:${c.duration}:${JSON.stringify(c.title)}` : null;
    if (type === "color") return `matte:${c.color ?? "#000000"}`;
    if (type !== "media") return null;
    const u = c.media.url;
    if (!u) return null;
    if (custom[u]) return `cus:${u}`;
    return c.media.kind === "image" ? `img:${u}` : `vid:${path}${c.id}:${u}`;
  }

  /** Looks the composition uses (fx.look and "look" effects), nested ones included. */
  private looksOf(comp: Composition): Set<string> {
    const out = new Set<string>();
    const add = (v: unknown) => { if (typeof v === "string" && v && v !== "none") out.add(v); };
    this.eachClip(comp, (c) => {
      add(c.fx?.look);
      for (const e of c.effects ?? []) {
        if (!e || e.type !== "look" || e.enabled === false) continue;
        const p = e.params?.look;
        if (isParam(p)) { add(p.value); for (const k of p.keyframes ?? []) add(k.value); } else add(p);
      }
    });
    return out;
  }

  /** Image URLs of effect parameters. */
  private imagesOf(comp: Composition): Set<string> {
    const out = new Set<string>();
    this.eachClip(comp, (c) => {
      for (const e of c.effects ?? []) {
        const def = e ? getEffect(e.type) : undefined;
        if (!def) continue;
        for (const p of def.params) {
          if (p.type !== "image") continue;
          const v = e.params?.[p.name];
          const u = isParam(v) ? v.value : v;
          if (typeof u === "string" && u) out.add(u);
        }
      }
    });
    return out;
  }

  /** Effects the composition uses that need something loaded first (a model): their prepare(), errors as warnings. */
  private async prepareEffects(comp: Composition) {
    const defs = new Set<EffectDef>();
    this.eachClip(comp, (c) => { for (const e of c.effects ?? []) { const d = e && e.enabled !== false ? getEffect(e.type) : undefined; if (d?.prepare) defs.add(d); } });
    await Promise.all([...defs].map((d) => d.prepare!().catch((e) => this.warnings.add(`${d.label}: ${(e as Error).message}`))));
  }

  /** Where a look's LUT comes from: a LUT handed in, a registered one, Composition.lutUrls, or the look id itself when
   *  it is "url:<url>" (a .cube any window can fetch: matchColor's saved LUT). */
  private lutSource(look: string, comp: Composition | null = this.comp, opts: LoadOptions = this.opts): Lut3D | string | undefined {
    return opts.luts?.[look] ?? registeredLut(look) ?? comp?.lutUrls?.[look] ?? (look.startsWith("url:") ? look.slice(4) : undefined);
  }

  /** A preset look runs as its FFmpeg filters unless a LUT was handed in for it or the composition asks for LUTs. */
  private useNative(look: string, comp = this.comp, opts = this.opts) { return comp?.nativeLooks !== false && isNativeLook(look) && !opts.luts?.[look]; }

  private lookCodeOf(look: string) {
    let s = this.lookCode.get(look);
    if (s === undefined) { s = lookGlsl(NATIVE_LOOKS[look]); this.lookCode.set(look, s); }
    return s;
  }

  private async loadLuts(comp: Composition, opts: LoadOptions) {
    const looks = [...this.looksOf(comp)].filter((l) => !this.useNative(l, comp, opts));
    await Promise.all(looks.map(async (look) => {
      try {
        if (this.luts.has(look)) return;
        const src = this.lutSource(look, comp, opts);
        let lut = typeof src === "string" ? undefined : src;
        const url = typeof src === "string" ? src : undefined;
        if (!lut) {
          if (!url) { this.warnings.add(`No LUT for the look "${look}"`); return; }
          const r = await fetch(url, { credentials: "same-origin" });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          lut = parseCube(await r.text());
        }
        if (this.luts.has(look) || this.b.lost) return;
        this.luts.set(look, { tex: this.b.createTexture3D(lut.size, lut.data), lut, from: src ?? "" });
      } catch (e) { this.warnings.add(`Look "${look}" left out: ${(e as Error).message}`); }
    }));
  }

  private async loadImages(comp: Composition) {
    await Promise.all([...this.imagesOf(comp)].map(async (url) => {
      if (this.images.has(url)) return;
      const slot: { bmp: ImageBitmap | null; tex: Texture | null } = { bmp: null, tex: null };
      this.images.set(url, slot);
      try {
        const r = await fetch(url, { credentials: "same-origin" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        slot.bmp = await createImageBitmap(await r.blob());
      } catch (e) { this.warnings.add(`Image ${url.slice(0, 60)} didn't load: ${(e as Error).message}`); }
    }));
  }

  /** Before a reload: release the media, LUTs and images the new composition doesn't use. */
  private prune(comp: Composition, opts: LoadOptions) {
    const custom = opts.sources ?? {};
    const keys = new Set<string>();
    this.eachClip(comp, (c, path) => { const k = this.keyOf(c, path, custom); if (k) keys.add(k); });
    for (const k of [...this.sources.keys()]) {
      const changed = k.startsWith("cus:") && custom[k.slice(4)] !== this.customOf.get(k);
      if (!keys.has(k) || changed) this.dropSource(k);
    }
    const looks = this.looksOf(comp);
    for (const [look, l] of [...this.luts]) {
      if (!looks.has(look) || this.useNative(look, comp, opts) || l.from !== (this.lutSource(look, comp, opts) ?? "")) { this.b.deleteTexture(l.tex); this.luts.delete(look); }
    }
    const imgs = this.imagesOf(comp);
    for (const [u, im] of [...this.images]) if (!imgs.has(u)) { if (im.tex) this.b.deleteTexture(im.tex); im.bmp?.close(); this.images.delete(u); }
  }

  private sourceFor(c: Clip, path: string, create = true): FrameSource | null {
    const k = this.keyOf(c, path);
    if (!k) return null;
    let s = this.sources.get(k);
    if (!s && create) {
      const fps = this.comp?.fps ?? 24;
      const type = c.type ?? "media";
      if (type === "title") s = new TitleSource(c.title!, c.duration);
      else if (type === "color") s = new MatteSource(c.color ?? "#000000");
      else {
        const cus = this.custom[c.media.url];
        if (cus) { s = new CanvasSource(cus); this.customOf.set(k, cus); }
        else s = c.media.kind === "image" ? new ImageSource(c.media.url) : this.mode === "exact" ? new ExactVideo(c.media.url, fps) : new LiveVideo(c.media.url, fps);
      }
      this.sources.set(k, s);
      s.ready.catch((e) => this.warnings.add(`${c.label ?? c.id}: ${(e as Error).message}`));
    }
    return s ?? null;
  }

  private dropSource(k: string) {
    const s = this.sources.get(k);
    if (!s) return;
    s.dispose();
    const st = this.texs.get(s);
    if (st) {
      this.b.deleteTexture(st.img);
      if (st.planes) { this.b.deleteTexture(st.planes.y); this.b.deleteTexture(st.planes.c); this.b.deleteTexture(st.planes.c2); }
      this.b.release(st.rt);
      this.texs.delete(s);
    }
    this.sources.delete(k);
    this.customOf.delete(k);
  }

  /** Videos near t get an element / decoder; far ones are released (nested compositions at their own time). */
  private manage(t: number) {
    const exact = this.mode === "exact";
    const walk = (comp: Composition, t: number, path: string, depth: number, visible: boolean) => {
      for (const tk of comp.tracks) {
        const ext = exact ? 0.5 + reachOf(tk) : KEEP_S;
        const vis = visible && !tk.hidden;
        for (const c of tk.clips) {
          const end = c.start + c.duration;
          const near = t >= c.start - PRELOAD_S && t <= end + 1;
          const far = t < c.start - KEEP_S || t > end + ext;
          if (c.type === "nested") {
            if (c.comp && depth < MAX_NEST) walk(c.comp, far ? -1e9 : nestedTime(c, t), `${path}${c.id}/`, depth + 1, vis);
            continue;
          }
          if ((c.type ?? "media") !== "media" || c.media.kind !== "video" || this.custom[c.media.url]) continue;
          const k = this.keyOf(c, path);
          if (!k) continue;
          if (near && vis) this.sourceFor(c, path);
          else if (far && this.sources.has(k)) this.dropSource(k);
        }
      }
    };
    walk(this.comp!, t, "", 0, true);
  }

  /** Cue the videos about to start (their first frame), rest the others. */
  private cue(t: number, active: Set<FrameSource>) {
    const walk = (comp: Composition, t: number, path: string, depth: number) => {
      for (const tk of comp.tracks) for (const c of tk.clips) {
        if (c.type === "nested") {
          if (c.comp && depth < MAX_NEST && t >= c.start - PRELOAD_S && t < c.start + c.duration) walk(c.comp, nestedTime(c, t), `${path}${c.id}/`, depth + 1);
          continue;
        }
        if ((c.type ?? "media") !== "media" || c.media.kind !== "video") continue;
        const k = this.keyOf(c, path);
        const s = k ? this.sources.get(k) : undefined;
        if (!s || active.has(s)) continue;
        if (c.start > t && c.start - t < PRELOAD_S) this.upload(s, s.live(sourceTime(c, 0), false, 0));
        else s.idle();
      }
    };
    walk(this.comp!, t, "", 0);
  }

  private upload(src: FrameSource, fr: Frame | null): SrcTex {
    let st = this.texs.get(src);
    if (!st) {
      const img = this.b.createTexture();
      const still = src.kind !== "video";
      st = { tex: img, img, version: -1, still, ff601: still };
      this.texs.set(src, st);
    }
    if (fr && fr.version !== st.version && fr.width && fr.height) {
      const b = this.b;
      if (fr.yuv) {
        const p = fr.yuv, w = fr.width, h = fr.height, cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
        st.planes ??= { y: b.createTexture(), c: b.createTexture(), c2: b.createTexture() };
        b.uploadPlane(st.planes.y, w, h, p.data, p.layout[0].offset, p.layout[0].stride, 1);
        if (p.format === "NV12") b.uploadPlane(st.planes.c, cw, ch, p.data, p.layout[1].offset, p.layout[1].stride, 2);
        else {
          b.uploadPlane(st.planes.c, cw, ch, p.data, p.layout[1].offset, p.layout[1].stride, 1);
          b.uploadPlane(st.planes.c2, cw, ch, p.data, p.layout[2].offset, p.layout[2].stride, 1);
        }
        if (!st.rt || st.rt.w !== w || st.rt.h !== h) { b.release(st.rt); st.rt = b.target(w, h, { mips: true }); }
        this.pass({ name: "yuv2rgb", source: YUV2RGB }, st.rt, { u_res: [w, h], u_nv12: p.format === "NV12" ? 1 : 0, u_full: p.fullRange ? 1 : 0 },
          { u_y: st.planes.y, u_c: st.planes.c, u_c2: st.planes.c2 });
        st.tex = st.rt;
        st.ff601 = p.ffmpeg601;
      } else if (fr.rect && st.img.w === fr.width && st.img.h === fr.height && st.version >= 0) {
        // a custom source told us what changed (CustomSource.bounds): only that part goes up
        b.uploadSub(st.img, fr.image, fr.rect[0], fr.rect[1], fr.rect[2], fr.rect[3]);
        st.tex = st.img;
        this.stats.subUploads++;
      } else {
        b.upload(st.img, fr.image, fr.width, fr.height);
        st.tex = st.img;
      }
      st.version = fr.version;
      this.stats.uploads++;
    }
    return st;
  }

  // ── frames ─────────────────────────────────────────────────────────────────
  /** Realtime preview: draw what the sources show now, steering them toward t. */
  drawLive(t: number, opts: DrawOptions = {}): void {
    if (!this.comp || this.b.lost) return;
    const t0 = performance.now();
    this.drawNo++;
    const rate = opts.rate ?? 1;
    const dt = t - this.last.t, dw = (t0 - this.last.wall) / 1000;
    const playing = opts.playing ?? (dt > 0 && dt < 0.25 && Math.abs(dt - dw * rate) < 0.12);
    this.last = { t, wall: t0 };
    this.manage(t);
    const res = Math.min(1, Math.max(0.1, Number(opts.resolution) || 1));
    const rw = Math.max(2, Math.round(this.w * res)), rh = Math.max(2, Math.round(this.h * res));
    this.stats.resolution = res;
    const fs = evaluate(this.comp, t);
    const active = new Set<FrameSource>();
    this.visit(fs, this.rootCtx(rw, rh), 1, (cs, ctx, k) => {
      const s = this.sourceFor(cs.clip, ctx.path);
      if (!s) return;
      active.add(s);
      if (s instanceof TitleSource) s.size(ctx.W, ctx.H, ctx.unit);
      // the clip's local rate (a time map's slope, 0 on a freeze): the video pauses on the frame rather than running
      const cr = rate * sourceRate(cs.clip, cs.local) * k;
      this.upload(s, s.live(cs.sourceTime, playing && (!cs.clip.reverse || !!cs.clip.timeMap?.length) && cr > 0, cr));
    });
    this.cue(t, active);
    this.draw(fs, rw, rh);
    this.present();
    this.stats.lastMs = performance.now() - t0;
  }

  /** Export: waits for exactly the frame at t on every clip, then draws it. */
  async renderExact(t: number): Promise<void> {
    if (!this.comp) return;
    if (this.b.lost) throw new Error("The graphics card reset (WebGL context lost)");
    const t0 = performance.now();
    this.manage(t);
    const fs = evaluate(this.comp, t);
    const jobs: { s: FrameSource; t: number }[] = [];
    this.visit(fs, this.rootCtx(this.w, this.h), 1, (cs, ctx) => {
      const s = this.sourceFor(cs.clip, ctx.path);
      if (!s) return;
      if (s instanceof TitleSource) s.size(ctx.W, ctx.H, ctx.unit);
      jobs.push({ s, t: cs.sourceTime });
    });
    for (const j of jobs) {
      await j.s.ready.catch(() => undefined);
      this.upload(j.s, await j.s.exact(j.t));
    }
    if (this.b.lost) throw new Error("The graphics card reset (WebGL context lost)");
    this.draw(fs, this.w, this.h);
    this.present();
    this.stats.lastMs = performance.now() - t0;
  }

  /** Draws a frame from already-uploaded sources (also tests and benchmarks), at w×h (default: the output size). */
  draw(fs: FrameState, w = this.rw || this.w, h = this.rh || this.h): RenderTarget {
    this.rw = w; this.rh = h;
    this.b.tick();
    if (++this.frames % 90 === 0) { this.b.trimOld(240); this.pruneTemporal(240); }
    const acc = this.drawComp(this.rootCtx(w, h), fs, true);
    this.b.release(this.frame);
    this.frame = acc;
    return acc;
  }

  present(): void {
    if (!this.frame) return;
    this.pass({ name: "present", source: PRESENT }, null, { u_res: [this.b.gl.drawingBufferWidth, this.b.gl.drawingBufferHeight] }, { u_in: this.frame });
  }

  /** One composition into a W×H target: the root on its background, a nested one on transparency. */
  private drawComp(ctx: Ctx, fs: FrameState, opaque: boolean): RenderTarget {
    const { W, H, comp } = ctx;
    let acc = this.b.target(W, H);
    const bg = comp.background ?? [0, 0, 0];
    this.b.clear(acc, opaque ? [bg[0], bg[1], bg[2], 1] : [0, 0, 0, 0]);
    for (const ts of fs.tracks) {
      if ((ts.track.opacity ?? 1) <= 1e-4) continue;
      for (const it of ts.items) acc = it.kind === "clip" ? this.drawClip(acc, it.cs, ts, ctx) : this.drawTransition(acc, it.tr, ts, ctx);
    }
    return acc;
  }

  private drawClip(acc: RenderTarget, cs: ClipState, ts: TrackState, ctx: Ctx): RenderTarget {
    const c = cs.clip, op = ts.track.opacity ?? 1;
    if (c.type === "adjustment") return this.adjustment(acc, cs, ts, ctx);
    if (ts.track.kind === "main" && !c.motion) {
      const pic = this.mainPicture(cs, ctx, false);
      const out = this.composite(acc, pic, ctx.W / 2, ctx.H / 2, ctx.W, ctx.H, 0, op, blendIdx(ts.track.blend));
      this.b.release(pic);
      return out;
    }
    const p = this.placed(cs, ts, ctx);
    if (!p) return acc;
    const out = this.composite(acc, p.rt, p.cx, p.cy, p.w, p.h, p.rot, p.opacity * op, blendIdx(p.blend ?? ts.track.blend));
    this.b.release(p.rt);
    return out;
  }

  /** A main-track shot at the frame size: fx, registry effects, then the fade to black. */
  private mainPicture(cs: ClipState, ctx: Ctx, mips: boolean): RenderTarget {
    const o: ClipOpts = { ctx, path: ctx.path, px: ctx.px };
    if (!hasEffects(cs.clip)) return this.renderClip(cs, ctx.W, ctx.H, false, mips, o);
    let rt = this.renderClip(cs, ctx.W, ctx.H, false, false, { ...o, fade: false });
    rt = this.effectChain(rt, cs, ctx, ctx.px);
    if (cs.fade < 0.9999 || mips || rt.w !== ctx.W || rt.h !== ctx.H) {
      const out = this.b.target(ctx.W, ctx.H, { mips });
      this.pass({ name: "fade", source: FADE }, out, { u_res: [ctx.W, ctx.H], u_fade: cs.fade }, { u_in: rt });
      this.b.release(rt);
      rt = out;
    }
    return rt;
  }

  /** What a clip samples (null: nothing to draw yet). */
  private picOf(cs: ClipState, ctx: Ctx): Pic | null {
    const c = cs.clip, type = c.type ?? "media";
    if (type === "nested") {
      if (!c.comp || !cs.nested) return null;
      const rt = this.drawComp(this.nestedCtx(ctx, c), cs.nested, false);
      return { tex: rt, still: false, ff601: false, pw: c.comp.width, ph: c.comp.height, own: rt };
    }
    if (type === "adjustment") return null;
    return this.mediaPic(c, ctx.path, ctx.comp);
  }

  private mediaPic(c: Clip, path: string, comp = this.comp): Pic | null {
    const s = this.sourceFor(c, path, false);
    const st = s ? this.texs.get(s) : undefined;
    if (!st || !st.tex.w) return null;
    const media = (c.type ?? "media") === "media";
    return { tex: st.tex, still: st.still, ff601: st.ff601,
      pw: media ? c.media.width || st.tex.w : comp?.width ?? st.tex.w, ph: media ? c.media.height || st.tex.h : comp?.height ?? st.tex.h };
  }

  /** A picture with its fx and effects, and where it goes: motion (Premiere-style) or a layer's transform. */
  private placed(cs: ClipState, ts: TrackState, ctx: Ctx): Placed | null {
    const b = this.b, c = cs.clip, { W, H } = ctx;
    const pic = this.picOf(cs, ctx);
    if (!pic) return null;
    const main = ts.track.kind === "main";
    let r: { cx: number; cy: number; w: number; h: number; rot: number }, opacity: number, sc: number;
    const generic = !!cs.motion || !cs.transform;
    let k = 1;
    if (generic) {
      const m: MotionState = cs.motion ?? { scale: 100, rotation: 0, opacity: main ? 1 : cs.fade };
      r = motionRect(m, pic.pw, pic.ph, W, H, c.fit, ctx.unit);
      opacity = m.opacity * (main ? cs.fade : 1);
      sc = Math.abs(m.scale) / 100;
    } else {
      const tr = cs.transform!;
      r = layerRect(tr, W, H, pic.tex.h / pic.tex.w);
      opacity = tr.opacity;
      sc = 1;
    }
    const aw = Math.abs(r.w), ah = Math.abs(r.h);
    if (opacity <= 1e-4 || aw < 0.5 || ah < 0.5) { b.release(pic.own); return null; }
    const maxS = Math.min(b.maxTextureSize, 2 * Math.max(W, H, 1024));
    k = Math.min(1, maxS / aw, maxS / ah);
    // an animated scale would ask for a new target size every frame: round those up to 16 px (rendered a little
    // larger, drawn into the exact rectangle); a still size stays exact (a plain clip is drawn 1:1)
    const q = generic && isAnimated(c.motion?.scale) ? 16 : 1;
    const pw = Math.max(2, Math.min(maxS, Math.ceil((aw * k) / q) * q)), ph = Math.max(2, Math.min(maxS, Math.ceil((ah * k) / q) * q));
    k = pw / aw;
    const px = ctx.px * k * sc;
    let rt = this.renderClip(cs, pw, ph, true, false, { pic, fill: generic, px, ctx, path: ctx.path });
    b.release(pic.own);
    let w = r.w, h = r.h;
    if (hasEffects(c)) {
      const pad = Math.min(512, Math.ceil(this.padOf(cs, ctx) * px));
      if (pad > 0) {
        const big = b.target(pw + 2 * pad, ph + 2 * pad);
        this.place(big, rt, big.w / 2, big.h / 2, pw, ph, 0, 1, false);
        b.release(rt);
        rt = big;
        w += Math.sign(r.w) * (2 * pad) / k; h += Math.sign(r.h) * (2 * pad) / k;
      }
      rt = this.effectChain(rt, cs, ctx, px);
    }
    return { rt, cx: r.cx, cy: r.cy, w, h, rot: r.rot, opacity, blend: cs.motion?.blend };
  }

  /** Composition pixels the clip's effects draw outside its picture. */
  private padOf(cs: ClipState, ctx: Ctx): number {
    let pad = 0;
    for (const e of cs.clip.effects ?? []) {
      if (!e || e.enabled === false) continue;
      const def = getEffect(e.type);
      if (!def?.pad) continue;
      const v = def.pad(paramValues(def, e, cs.local, ctx.comp.fps || 24));
      if (Number.isFinite(v) && v > 0) pad += Math.min(v, 1000);
    }
    return pad;
  }

  private opacityOf(cs: ClipState, ts: TrackState): number {
    if (cs.motion) return cs.motion.opacity * (ts.track.kind === "main" ? cs.fade : 1);
    if (cs.transform) return cs.transform.opacity;
    return cs.fade;
  }

  /** An adjustment clip: its fx and effects on everything below it, at its opacity. */
  private adjustment(acc: RenderTarget, cs: ClipState, ts: TrackState, ctx: Ctx): RenderTarget {
    const op = this.opacityOf(cs, ts) * (ts.track.opacity ?? 1);
    if (op <= 1e-4) return acc;
    const rt = this.adjusted(acc, cs, ctx);
    const out = this.composite(acc, rt, ctx.W / 2, ctx.H / 2, ctx.W, ctx.H, 0, op, blendIdx(cs.motion?.blend ?? ts.track.blend));
    this.b.release(rt);
    return out;
  }

  private adjusted(acc: RenderTarget, cs: ClipState, ctx: Ctx): RenderTarget {
    const pic: Pic = { tex: acc, still: false, ff601: false, pw: ctx.comp.width, ph: ctx.comp.height };
    const rt = this.renderClip({ ...cs, fade: 1 }, ctx.W, ctx.H, true, false, { pic, fill: true, px: ctx.px, ctx });
    return this.effectChain(rt, cs, ctx, ctx.px);
  }

  private drawTransition(acc: RenderTarget, tr: TransitionState, ts: TrackState, ctx: Ctx): RenderTarget {
    const b = this.b, { W, H } = ctx, op = ts.track.opacity ?? 1;
    const tp = this.transitionFor(tr.type);
    const plainMain = (cs: ClipState | null) => !!cs && !cs.clip.motion && cs.clip.type !== "adjustment";
    if (ts.track.kind === "main" && plainMain(tr.from) && plainMain(tr.to)) {
      // the studio cut: two opaque frame-filling shots, exactly as before
      const a = this.mainPicture(tr.from!, ctx, tp.mips), c = this.mainPicture(tr.to!, ctx, tp.mips);
      const pic = this.runTransition(tp, a, c, tr, W, H);
      b.release(a); b.release(c);
      const out = this.composite(acc, pic, W / 2, H / 2, W, H, 0, op, blendIdx(ts.track.blend));
      b.release(pic);
      return out;
    }
    // any track: each side as a premultiplied full-frame layer (nothing = transparent)
    const side = (cs: ClipState | null): RenderTarget => {
      const t = b.target(W, H, { mips: tp.mips });
      if (cs?.clip.type === "adjustment") {
        const rt = this.adjusted(acc, cs, ctx);
        this.place(t, rt, W / 2, H / 2, W, H, 0, this.opacityOf(cs, ts), true);
        b.release(rt);
        return t;
      }
      const p = cs ? this.placed(cs, ts, ctx) : null;
      if (!p) { b.clear(t, [0, 0, 0, 0]); return t; }
      this.place(t, p.rt, p.cx, p.cy, p.w, p.h, p.rot, p.opacity, true);
      b.release(p.rt);
      return t;
    };
    const A = side(tr.from), B = side(tr.to);
    const pic = this.runTransition(tp, A, B, tr, W, H, true);
    b.release(A); b.release(B);
    const out = this.composite(acc, pic, W / 2, H / 2, W, H, 0, op, blendIdx(ts.track.blend), true);
    b.release(pic);
    return out;
  }

  // ── passes ─────────────────────────────────────────────────────────────────
  private pass(sh: { name: string; source: string }, target: RenderTarget | null, uniforms: Record<string, UniformValue>, textures: Record<string, Tex | null | undefined>,
    glsl1 = false): void {
    const prog: Program = this.b.program(sh.name, sh.source, { glsl1 });
    const tex: Record<string, Tex> = {};
    for (const k in textures) if (textures[k]) tex[k] = textures[k]!;
    this.b.draw({ program: prog, target, uniforms, textures: tex });
    this.stats.passes++;
  }

  private clipProgram(f: ClipFlags, look?: string) {
    const key = JSON.stringify({ ...f, nlook: undefined }) + (look ?? "");
    let s = this.shaders.get(key);
    if (!s) { s = clipShader(f); this.shaders.set(key, s); }
    return s;
  }

  private curveTexture(key: string, texels: () => Float32Array): Texture {
    let t = this.curveTex.get(key);
    if (!t) { t = this.b.createTexture(); this.b.uploadData(t, 256, 1, texels(), "rgba16f"); this.curveTex.set(key, t); }
    return t;
  }

  private curvesFor(c: Clip): Texture | null {
    const cv = c.fx.curves;
    if (!cv) return null;
    return this.curveTexture(`fx:${JSON.stringify(cv)}`, () => bakeCurves(cv));
  }

  private gradeFlags(p: FxPlan): Partial<ClipFlags> {
    return { lut: p.lut, eq: !!p.adjust.eq, cb: !!p.adjust.cb, vib: p.adjust.vibrance !== undefined, hue: p.adjust.hue !== undefined, wheels: p.wheels,
      curves: p.curves, chroma: p.chroma };
  }

  private gradeUniforms(c: Clip, p: FxPlan, lut: { lut: Lut3D } | undefined): Record<string, UniformValue> {
    const u: Record<string, UniformValue> = {};
    const a = p.adjust, fx = c.fx;
    if (lut) {
      u.u_lutN = lut.lut.size; u.u_lutMin = lut.lut.domainMin; u.u_lutMax = lut.lut.domainMax;
      u.u_lutMix = clamp01(fx.lut_strength ?? 1);
    }
    if (a.eq) {
      u.u_eq = [a.eq.brightness, a.eq.contrast, a.eq.gamma, a.eq.saturation];
      u.u_eqOn = [a.eq.luma ? 1 : 0, a.eq.chroma ? 1 : 0];
      u.u_eqInt = [...eqInt(a.eq.contrast, a.eq.brightness), ...eqInt(a.eq.saturation, 0)];
    }
    if (a.cb) { u.u_cbS = [0, 0, 0]; u.u_cbM = a.cb; u.u_cbH = [0, 0, 0]; }
    if (a.vibrance !== undefined) u.u_vib = a.vibrance;
    if (a.hue !== undefined) { const r = (a.hue * Math.PI) / 180; u.u_hue = [Math.cos(r), Math.sin(r)]; }
    if (p.wheels && fx.wheels) {
      const v = (x: number[] | undefined, k: number) => Math.max(-1, Math.min(1, Number(x?.[k]) || 0));
      u.u_lift = [0, 1, 2].map((k) => v(fx.wheels!.lift, k) * 0.5);
      u.u_gain = [0, 1, 2].map((k) => 1 + v(fx.wheels!.gain, k));
      u.u_gam = [0, 1, 2].map((k) => Math.pow(2, -v(fx.wheels!.gamma, k)));
    }
    if (p.chroma && fx.chroma) {
      const k = rgbToYuv(...hexRgb(fx.chroma.color)!);
      u.u_keyCC = [k[1] / 255, k[2] / 255];
      u.u_key = [fx.chroma.similarity ?? 0.4, fx.chroma.smoothness ?? 0.08, fx.chroma.spill ?? 0.1];
    }
    return u;
  }

  private maskUniforms(m: FxMask): Record<string, UniformValue> {
    return { u_mask: [m.x ?? 0.5, m.y ?? 0.5, m.w ?? 0.5, m.h ?? 0.5], u_mask2: [((m.rotation ?? 0) * Math.PI) / 180, m.feather ?? 0, m.invert ? 1 : 0, m.shape === "ellipse" ? 1 : 0] };
  }

  private finishUniforms(cs: ClipState, p: FxPlan, px: number, fps: number): Record<string, UniformValue> {
    const u: Record<string, UniformValue> = {};
    const fx = cs.clip.fx;
    if (p.adjust.vignette) u.u_vig = p.adjust.vignette;
    if (p.adjust.grain) { u.u_grain = p.adjust.grain * Math.min(1, px); u.u_frame = Math.round((cs.clip.start + cs.local) * fps); }
    if (p.mask && fx.mask) Object.assign(u, this.maskUniforms(fx.mask));
    u.u_fade = cs.fade;
    return u;
  }

  /** One clip at w×h: source → framing → fx (→ fade on the main track). With `fill`, the target is the picture's own
   *  rectangle (motion places it); else the clip's fit frames it. */
  renderClip(cs: ClipState, w: number, h: number, layer: boolean, mips: boolean, o: ClipOpts = {}): RenderTarget {
    const b = this.b, c = cs.clip;
    const pic = o.pic !== undefined ? o.pic : this.mediaPic(c, o.path ?? "", o.ctx?.comp);
    const out = b.target(w, h, { mips });
    if (!pic || !pic.tex.w) { b.clear(out, [0, 0, 0, layer ? 0 : 1]); return out; }
    const comp = o.ctx?.comp ?? this.comp;
    const fps = comp?.fps || 24;
    const px = o.px ?? this.pxScale();
    const tex = pic.tex;
    const fx = c.fx ?? {};
    const look = fx.look && fx.look !== "none" && (fx.lut_strength ?? 1) > 1e-3 ? fx.look : undefined;
    const native = look && this.useNative(look) ? this.lookCodeOf(look) : undefined;
    const lut = look && !native ? this.luts.get(look) : undefined;
    const plan = fxPlan(fx, !!lut);
    const fc = o.fill ? { ...c, fit: "fill" as const } : c;
    const uv = clipUv(fc, tex.w, tex.h, w, h, cs.local, fps);
    if (!tex.mips && minification(uv, tex.w, tex.h, w, h) > 1.5) b.generateMips(tex);
    const base: Record<string, UniformValue> = { u_res: [w, h], u_xf: [uv.sx, uv.sy, uv.ox, uv.oy], u_contain: fc.fit === "contain" ? 1 : 0,
      u_srcM: M_STILL, u_ffm: M_FF, u_ffmInv: M_FF_INV };
    const srcm = pic.still && comp?.stillsMatrix !== "bt709";
    const ffm = pic.ff601 && comp?.ffmpegRgb !== false && (plan.lut || !!native || !!plan.adjust.cb || plan.adjust.vibrance !== undefined);
    const grade = { ...this.gradeFlags(plan), ffm, nlook: native };
    const gu = this.gradeUniforms(c, plan, lut);
    if (native) gu.u_lookMix = clamp01(fx.lut_strength ?? 1);
    const fin = { vig: !!plan.adjust.vignette, grain: !!plan.adjust.grain, mask: plan.mask, fade: !layer && o.fade !== false && cs.fade < 0.9999 };
    const fu = this.finishUniforms(cs, plan, px, fps);
    const gtex = { u_src: tex, u_lut: lut?.tex, u_curves: plan.curves ? this.curvesFor(c) : null };
    if (!plan.neighbourhood) {
      this.pass(this.clipProgram({ src: true, srcm, input: false, ...grade, ...fin }, look), out, { ...base, ...gu, ...fu }, gtex);
      return out;
    }
    let cur = b.target(w, h);
    this.pass(this.clipProgram({ src: true, srcm, input: false, ...grade }, look), cur, { ...base, ...gu }, gtex);
    let glow: RenderTarget | null = null;
    const g = fx.glow;
    if (plan.glow && g) {
      glow = this.glowOf(cur, g.threshold ?? 0.7, g.radius ?? 0.3, w, h);
      if (plan.adjust.sharpen || plan.adjust.blur) {
        const t2 = b.target(w, h);
        this.pass(this.clipProgram({ src: false, input: true, glowAdd: true }), t2, { u_res: [w, h], u_glowAmt: g.amount }, { u_in: cur, u_glow: glow });
        b.release(cur); b.release(glow); glow = null; cur = t2;
      }
    }
    if (plan.adjust.sharpen) {
      const t2 = b.target(w, h);
      this.pass({ name: "unsharp", source: UNSHARP }, t2, { u_res: [w, h], u_amount: plan.adjust.sharpen, u_step: px }, { u_in: cur });
      b.release(cur); cur = t2;
    }
    if (plan.adjust.blur) cur = this.gblur(cur, plan.adjust.blur * px, w, h);
    this.pass(this.clipProgram({ src: fin.mask, srcm: fin.mask && srcm, input: true, glowAdd: !!glow, ...fin }), out,
      { ...base, ...fu, u_glowAmt: g?.amount ?? 0 }, { u_in: cur, u_src: tex, u_glow: glow });
    b.release(cur); b.release(glow);
    return out;
  }

  // ── registry effects ───────────────────────────────────────────────────────
  /** A clip's registry effects in order on its picture (`rt` is consumed; returns the result). */
  private effectChain(rt: RenderTarget, cs: ClipState, ctx: Ctx, scale: number): RenderTarget {
    let cur = rt;
    const list = cs.clip.effects ?? [];
    for (let i = 0; i < list.length; i++) {
      const inst = list[i];
      if (!inst || inst.enabled === false) continue;
      const def = getEffect(inst.type);
      if (!def) { this.warnings.add(`The effect "${inst.type}" isn't available here`); continue; }
      let next: RenderTarget;
      try { next = this.runEffect(def, inst, cur, cs, ctx, scale, `${ctx.path}${cs.clip.id}#${inst.id ?? i}:${def.id}`); } catch (e) { this.warnings.add(`${def.label}: ${(e as Error).message}`); continue; }
      if (next === cur) continue;
      const m = inst.mask;
      if (m && (m.w ?? 0) > 0 && (m.h ?? 0) > 0) {
        const mixed = this.b.target(cur.w, cur.h);
        this.pass({ name: "mask-mix", source: MASK_MIX }, mixed, { u_res: [cur.w, cur.h], ...this.maskUniforms(m) }, { u_a: cur, u_b: next });
        this.b.release(next);
        next = mixed;
      }
      this.b.release(cur);
      cur = next;
    }
    return cur;
  }

  private fxShader(def: EffectDef, k: number) {
    let list = this.fxShaders.get(def);
    if (!list) { list = passesOf(def).map((p, i) => ({ name: `fx:${def.id}#${i}`, source: effectSource(def, p.glsl) })); this.fxShaders.set(def, list); }
    return list[k];
  }

  /** Samplers for curve and image parameters. */
  private paramTextures(def: EffectDef, v: Record<string, unknown>): Record<string, Texture> {
    const out: Record<string, Texture> = {};
    for (const p of def.params) {
      if (p.type === "curve") { const pts = v[p.name]; out[p.name] = this.curveTexture(`p${p.periodic ? "w" : ""}:${JSON.stringify(pts)}`, () => curveTexels(pts, !!p.periodic)); }
      else if (p.type === "image") {
        const im = this.images.get(String(v[p.name] ?? ""));
        if (im?.bmp && !im.tex) { im.tex = this.b.createTexture(); this.b.upload(im.tex, im.bmp, im.bmp.width, im.bmp.height); }
        out[p.name] = im?.tex ?? this.white();
      }
    }
    return out;
  }

  /** One effect on `input` (not consumed): its passes, or a built-in's render through the FFmpeg-matched pipeline.
   *  `key` names the instance (its history and person mask live under it; none for thumbnails). */
  private runEffect(def: EffectDef, inst: EffectInstance | undefined, input: RenderTarget, cs: ClipState, ctx: Ctx, scale: number, key?: string): RenderTarget {
    const b = this.b, fps = ctx.comp.fps || 24;
    const t = cs.local, frame = Math.round((cs.clip.start + cs.local) * fps), duration = cs.clip.duration;
    const values = paramValues(def, inst, t, fps);
    if (def.render) {
      const api: EffectApi = { input, w: input.w, h: input.h, values, t, frame, scale, duration, fps,
        legacy: (fx) => this.legacyOn(input, fx as ShotFx, cs, ctx, scale) };
      return (def.render(api) as RenderTarget | null | undefined) ?? input;
    }
    const passes = passesOf(def);
    const base = paramUniforms(def, values);
    const ptex: Record<string, Tex | null | undefined> = this.paramTextures(def, values);
    const hist = def.temporal ? this.historyFor(key ? `${key}@${input.w}x${input.h}` : null, frame) : null;
    if (def.temporal) { ptex.uHistory = hist?.tex ?? this.transparent(); base.uHistoryValid = hist?.tex ? 1 : 0; }
    if (def.segmentation) ptex.uMask = this.personMask(key ?? `thumb:${def.id}`, frame, input);
    const outs: RenderTarget[] = [];
    let cur = input;
    const drop = (x: RenderTarget) => { if (x !== input && !outs.includes(x)) b.release(x); };
    for (let k = 0; k < passes.length; k++) {
      const pass = passes[k];
      const ps = pass.scale ?? 1;
      const tw = pass.size ? Math.max(1, Math.round(pass.size[0])) : Math.max(1, Math.round(input.w * ps));
      const th = pass.size ? Math.max(1, Math.round(pass.size[1])) : Math.max(1, Math.round(input.h * ps));
      const n = pass.repeat ? Math.max(1, Math.min(64, Math.round(pass.repeat(values)) || 1)) : 1;
      const sh = this.fxShader(def, k);
      for (let i = 0; i < n; i++) {
        const pc: PassContext = { w: tw, h: th, inW: cur.w, inH: cur.h, t, frame, scale: scale * (tw / input.w), iteration: i, duration, fps };
        const u = { ...base, ...def.uniforms?.(values, pc), ...pass.uniforms?.(values, pc),
          uResolution: [tw, th], uInputSize: [cur.w, cur.h], uTime: t, uFrame: frame, uScale: pc.scale, uIteration: i } as Record<string, UniformValue>;
        const out = b.target(tw, th);
        try {
          this.pass(sh, out, u, { uInput: cur, uOriginal: input, uPass0: outs[0], uPass1: outs[1], uPass2: outs[2], ...ptex });
        } catch (e) {
          b.release(out); drop(cur); for (const x of outs) if (x !== input) b.release(x);
          throw e;
        }
        drop(cur);
        cur = out;
      }
      outs.push(cur);
    }
    if (hist) hist.store(outs[Math.min(Math.max(def.temporal?.pass ?? outs.length - 1, 0), outs.length - 1)]);
    for (const x of outs) if (x !== cur) b.release(x);
    return cur;
  }

  // ── temporal effects and person masks ──────────────────────────────────────
  /** The history of an effect instance for `frame`: the previous frame's picture (one or two frames back; a redraw of
   *  the same frame gets the same one), and store() for this frame's. */
  private historyFor(key: string | null, frame: number): { tex: RenderTarget | null; store: (rt: RenderTarget) => void } | null {
    if (!key) return { tex: null, store: () => undefined };
    let e = this.history.get(key);
    if (!e) { e = { frame: NaN, prev: null, cur: null, used: 0 }; this.history.set(key, e); }
    const h = e;
    h.used = this.frames;
    const d = frame - h.frame;
    const mode = d === 0 ? "same" : h.cur && d >= 1 && d <= 2 ? "next" : "reset";
    const tex = mode === "same" ? h.prev : mode === "next" ? h.cur : null;
    return {
      tex,
      store: (rt: RenderTarget) => {
        const copy = this.b.target(rt.w, rt.h);
        this.pass({ name: "copy", source: COPY }, copy, { u_res: [rt.w, rt.h] }, { u_in: rt });
        if (mode === "same") { this.b.release(h.cur); h.cur = copy; return; }
        if (mode === "next") { this.b.release(h.prev); h.prev = h.cur; }
        else { this.b.release(h.prev); this.b.release(h.cur); h.prev = null; }
        h.cur = copy; h.frame = frame;
      },
    };
  }

  /** The person mask of an effect's input (MediaPipe): computed once per frame (exact) or per displayed frame while
   *  the picture changes (live), reused while paused. White (everything a person) until the model has loaded. */
  private personMask(key: string, frame: number, input: RenderTarget): Texture {
    const e = this.segs.get(key);
    const live = this.mode === "live";
    if (e) e.used = this.frames;
    if (e && e.frame === frame && (!live || e.uploads === this.stats.uploads)) return e.tex;
    const seg = segmenterReady();
    if (!seg) {
      this.warnings.add("Background effects: the segmentation model is still loading");
      void loadSegmenter().catch(() => undefined);
      return e?.tex ?? this.white();
    }
    const aspect = input.h / Math.max(input.w, 1);
    const sw = 256, sh = Math.max(16, Math.min(512, Math.round(256 * aspect)));
    const small = this.b.target(sw, sh, { format: "rgba8" });
    this.pass({ name: "copy", source: COPY }, small, { u_res: [sw, sh] }, { u_in: input });
    const px = new Uint8Array(sw * sh * 4);
    this.b.read(small, 0, 0, sw, sh, px);
    this.b.release(small);
    let m: { data: Uint8Array; w: number; h: number } | null = null;
    try { m = segmentPerson(new ImageData(new Uint8ClampedArray(px.buffer), sw, sh)); } catch (err) { this.warnings.add(`Segmentation failed: ${(err as Error).message}`); }
    const tex = e?.tex ?? this.b.createTexture();
    if (m) this.b.uploadData(tex, m.w, m.h, m.data, "r8");
    else if (!e) this.b.uploadData(tex, 1, 1, new Uint8Array([255]), "r8");
    this.segs.set(key, { frame, uploads: this.stats.uploads, tex, used: this.frames });
    return tex;
  }

  /** Drops histories and masks no frame used for `age` frames. */
  private pruneTemporal(age: number) {
    for (const [k, h] of [...this.history]) if (this.frames - h.used > age) { this.b.release(h.prev); this.b.release(h.cur); this.history.delete(k); }
    for (const [k, m] of [...this.segs]) if (this.frames - m.used > age) { this.b.deleteTexture(m.tex); this.segs.delete(k); }
  }

  // ── luma mattes (tv: pack) ─────────────────────────────────────────────────
  /** A pack matte for this aspect ratio: rendered once raw (a small copy read back for its histogram), then at full
   *  size through the histogram's equalisation table, so every matte sweeps at an even pace. */
  matteTex(id: string, w: number, h: number): RenderTarget {
    const ms = matteSize(w / Math.max(h, 1));
    const k = `${id}@${ms.key}`;
    const hit = this.mattes.get(k);
    if (hit) return hit;
    const d = matteDef(id);
    if (!d) throw new Error(`No matte "${id}"`);
    const sh = { name: `matte:${id}`, source: matteSource(d) };
    const seed = matteSeed(id), asp = ms.w / ms.h;
    const sw = 256, shh = Math.max(16, Math.round(256 / asp));
    const raw = this.b.target(sw, shh, { format: this.b.floatTargets ? "rgba16f" : "rgba8" });
    this.pass(sh, raw, { u_res: [sw, shh], uSeed: seed, uAsp: asp, uFinal: 0, uRange: [0, 1] }, {});
    const vals = this.b.readFloat(raw, 0, 0, sw, shh);
    this.b.release(raw);
    const r = new Float32Array(sw * shh);
    for (let i = 0; i < r.length; i++) r[i] = vals[i * 4];
    const eq = equalise(r);
    const curve = this.b.createTexture();
    const texels = new Float32Array(MATTE_CURVE * 4);
    for (let i = 0; i < MATTE_CURVE; i++) texels[i * 4] = texels[i * 4 + 1] = texels[i * 4 + 2] = eq.table[i];
    this.b.uploadData(curve, MATTE_CURVE, 1, texels, "rgba16f");
    const out = this.b.target(ms.w, ms.h, { format: this.b.floatTargets ? "rgba16f" : "rgba8" });
    this.pass(sh, out, { u_res: [ms.w, ms.h], uSeed: seed, uAsp: asp, uFinal: 1, uRange: [eq.min, eq.max] }, { uCurve: curve });
    this.b.deleteTexture(curve);
    this.mattes.set(k, out);
    return out;
  }

  /** The FFmpeg-matched clip pipeline (fx keys) on an effect's input. */
  private legacyOn(input: RenderTarget, fx: ShotFx, cs: ClipState, ctx: Ctx, scale: number): RenderTarget {
    const clip: Clip = { ...cs.clip, fit: "fill", center: undefined, move: undefined, kenburns: false, fx: fx ?? {}, effects: undefined };
    return this.renderClip({ ...cs, clip, fade: 1 }, input.w, input.h, true, false,
      { pic: { tex: input, still: false, ff601: false, pw: input.w, ph: input.h }, fill: true, px: scale, ctx });
  }

  // ── neighbourhood helpers ──────────────────────────────────────────────────
  /** Two-pass separable blur (releases `rt`, returns the result). */
  private blur(rt: RenderTarget, weights: number[], w: number, h: number): RenderTarget {
    const { center, taps } = linearTaps(weights);
    const t = taps.slice(0, 32);
    const u = { u_res: [w, h], u_w0: center, u_taps: t.flat(), u_n: t.length };
    const a = this.b.target(w, h), c = this.b.target(w, h);
    this.pass({ name: "blur", source: BLUR }, a, { ...u, u_dir: [1, 0] }, { u_in: rt });
    this.pass({ name: "blur", source: BLUR }, c, { ...u, u_dir: [0, 1] }, { u_in: a });
    this.b.release(rt); this.b.release(a);
    return c;
  }

  /** FFmpeg gblur on yuv420p: sigma on luma, the same sigma on the half-size chroma planes (twice as wide here). */
  private gblur(rt: RenderTarget, sigma: number, w: number, h: number): RenderTarget {
    const l = linearTaps(gblurWeights(sigma)), c = linearTaps(gblurWeights(sigma * 2, 64));
    const lt = l.taps.slice(0, 32), ct = c.taps.slice(0, 32);
    const u = { u_res: [w, h], u_w0: l.center, u_taps: lt.flat(), u_n: lt.length, u_cw0: c.center, u_ctaps: ct.flat(), u_cn: ct.length };
    const a = this.b.target(w, h), out = this.b.target(w, h);
    this.pass({ name: "gblur", source: GBLUR }, a, { ...u, u_dir: [1, 0] }, { u_in: rt });
    this.pass({ name: "gblur", source: GBLUR }, out, { ...u, u_dir: [0, 1] }, { u_in: a });
    this.b.release(rt); this.b.release(a);
    return out;
  }

  private glowOf(src: RenderTarget, threshold: number, radius: number, w: number, h: number): RenderTarget {
    const hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
    const ext = this.b.target(hw, hh);
    this.pass({ name: "glow-extract", source: GLOW_EXTRACT }, ext, { u_res: [hw, hh], u_thr: Math.min(0.99, Math.max(0, threshold)) }, { u_in: src });
    const sigma = Math.max(1, radius * Math.min(hw, hh) * 0.08);
    const R = Math.min(64, Math.ceil(sigma * 3));
    const wts = Array.from({ length: R + 1 }, (_, i) => Math.exp((-i * i) / (2 * sigma * sigma)));
    const sum = wts.reduce((s, x, i) => s + (i ? 2 * x : x), 0);
    return this.blur(ext, wts.map((x) => x / sum), hw, hh);
  }

  // ── transitions, compositing ───────────────────────────────────────────────
  private transitionFor(type: string): TransitionProgram {
    const tp = transitionProgram(type);
    if (tp) return tp;
    this.warnings.add(`Transition "${type}" isn't available here: drawn as a crossfade`);
    return transitionProgram("fade")!;
  }

  /** `pm`: the inputs are premultiplied layers (pack transitions draw a transparent background then). */
  private runTransition(tp: TransitionProgram, a: RenderTarget, c: RenderTarget, tr: Pick<TransitionState, "progress" | "params">, w: number, h: number, pm = false): RenderTarget {
    const b = this.b;
    if (tp.mips) { b.generateMips(a); b.generateMips(c); }
    const out = b.target(w, h);
    const tex: Record<string, Tex> = { u_from: a, u_to: c };
    for (const n of tp.textures) tex[n] = n === "u_rand" ? this.randTex(false, w, h) : n === "u_rand2" ? this.randTex(true, w, h) : n === "u_matte" ? this.matteTex(tp.matte ?? "", w, h) : this.noiseTex();
    try {
      this.pass({ name: tp.name, source: tp.source }, out, { u_res: [w, h], progress: tr.progress, ratio: w / h, u_pm: pm ? 1 : 0, ...transitionUniforms(tp, tr.params) }, tex, tp.glsl1);
    } catch (e) {
      if (!(e instanceof ShaderError) || tp.id === "fade") throw e;
      this.warnings.add(`${tp.id}: ${e.message} (drawn as a crossfade)`);
      b.release(out);
      return this.runTransition(transitionProgram("fade")!, a, c, tr, w, h, pm);
    }
    return out;
  }

  /** `pic` over `acc` (released) as a rectangle centred at cx, cy (w×h pixels, negative = mirrored, turned rot
   *  radians clockwise). `inPm`: pic is premultiplied. */
  private composite(acc: RenderTarget, pic: RenderTarget, cx: number, cy: number, w: number, h: number, rot: number, opacity: number, mode: number, inPm = false): RenderTarget {
    const out = this.b.target(acc.w, acc.h);
    this.pass({ name: "composite", source: COMPOSITE }, out, { u_res: [acc.w, acc.h], u_center: [cx, cy], u_size: [w, h],
      u_rot: [Math.cos(rot), Math.sin(rot)], u_opacity: opacity, u_mode: mode, u_inPm: inPm ? 1 : 0, u_outPm: 0 }, { u_dst: acc, u_layer: pic });
    this.b.release(acc);
    return out;
  }

  /** Draws `pic` alone into `target` (transparent elsewhere), premultiplied when `pm`. */
  private place(target: RenderTarget, pic: RenderTarget, cx: number, cy: number, w: number, h: number, rot: number, opacity: number, pm: boolean) {
    this.pass({ name: "composite", source: COMPOSITE }, target, { u_res: [target.w, target.h], u_center: [cx, cy], u_size: [w, h],
      u_rot: [Math.cos(rot), Math.sin(rot)], u_opacity: opacity, u_mode: 0, u_inPm: 0, u_outPm: pm ? 1 : 0 }, { u_dst: this.transparent(), u_layer: pic });
  }

  /** 1×1 white: an image parameter without an image (pixi's Texture.WHITE). */
  private white(): Texture {
    if (!this.whiteTex) { this.whiteTex = this.b.createTexture(); this.b.uploadData(this.whiteTex, 1, 1, new Uint8Array([255, 255, 255, 255]), "rgba8"); }
    return this.whiteTex;
  }

  private transparent(): Texture {
    if (!this.clearTex) { this.clearTex = this.b.createTexture(); this.b.uploadData(this.clearTex, 1, 1, new Uint8Array(4), "rgba8"); }
    return this.clearTex;
  }

  /** FFmpeg's frand values as a texture: per row / column (two rows of max(w, h)), or per pixel. */
  randTex(grid: boolean, w: number, h: number): Texture {
    const key = grid ? `g${w}x${h}` : `r${Math.max(w, h)}`;
    let t = this.rand.get(key);
    if (!t) {
      t = this.b.createTexture();
      if (grid) this.b.uploadData(t, w, h, frandGrid(w, h), "r32f");
      else { const n = Math.max(w, h); this.b.uploadData(t, n, 2, frandRows(n), "r32f"); }
      this.rand.set(key, t);
    }
    return t;
  }

  /** A smooth grey noise image for gl-transitions that take an extra texture (luma, displacement). */
  noiseTex(): Texture {
    if (this.noise) return this.noise;
    const N = 256, data = new Uint8Array(N * N * 4);
    const rnd = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
    const val = (x: number, y: number, f: number) => {
      const fx = (x / N) * f, fy = (y / N) * f, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const m = (i: number, j: number) => rnd(((i % f) + f) % f, ((j % f) + f) % f);
      return (m(ix, iy) * (1 - sx) + m(ix + 1, iy) * sx) * (1 - sy) + (m(ix, iy + 1) * (1 - sx) + m(ix + 1, iy + 1) * sx) * sy;
    };
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = 0.55 * val(x, y, 4) + 0.3 * val(x, y, 8) + 0.15 * val(x, y, 16);
      const o = (y * N + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.round(Math.min(1, Math.max(0, v)) * 255);
      data[o + 3] = 255;
    }
    this.noise = this.b.createTexture();
    this.b.uploadData(this.noise, N, N, data, "rgba8");
    return this.noise;
  }

  // ── thumbnails ─────────────────────────────────────────────────────────────
  /** Two sample pictures (a warm and a cool scene with shapes) for thumbnails. */
  private sampleTextures(): Texture[] {
    if (this.samples) return this.samples;
    const W = 320, H = 180;
    const mk = (warm: boolean) => {
      const d = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H, o = (y * W + x) * 4;
        const sky = warm ? [1, 0.62 - 0.3 * v, 0.3 + 0.2 * u] : [0.15 + 0.2 * u, 0.45 + 0.3 * v, 0.85];
        const dx = u - (warm ? 0.35 : 0.65), dy = (v - 0.45) * (H / W), disc = dx * dx + dy * dy < 0.012;
        const ground = v > 0.72 + 0.05 * Math.sin(u * 9);
        const c = disc ? (warm ? [1, 0.95, 0.6] : [0.95, 0.95, 1]) : ground ? (warm ? [0.35, 0.2, 0.1] : [0.1, 0.3, 0.2]) : sky;
        d[o] = Math.round(clamp01(c[0]) * 255); d[o + 1] = Math.round(clamp01(c[1]) * 255); d[o + 2] = Math.round(clamp01(c[2]) * 255); d[o + 3] = 255;
      }
      const t = this.b.createTexture();
      this.b.uploadData(t, W, H, d, "rgba8");
      return t;
    };
    this.samples = [mk(true), mk(false)];
    return this.samples;
  }

  /** A transition half-way, an effect (defaults or `params`) or a look on the sample pictures, or on the user's own
   *  picture (`source`), w×h RGBA rows top first. */
  async thumbnail(kind: "transition" | "effect" | "look", id: string, w: number, h: number, o: ThumbOptions = {}): Promise<{ data: Uint8Array; w: number; h: number }> {
    if (this.b.lost) throw new Error("The graphics card reset (WebGL context lost)");
    if (kind === "transition" && id.startsWith("gl:")) await loadGl().catch(() => undefined);
    const b = this.b, [sa, sb] = this.sampleTextures();
    const copy = (t: Texture, mips = false) => { const rt = b.target(w, h, { mips }); this.pass({ name: "copy", source: COPY }, rt, { u_res: [w, h] }, { u_in: t }); return rt; };
    let own: Texture | null = null;
    const first = (mips = false) => {
      if (!o.source) return copy(sa, mips);
      own = b.createTexture();
      b.upload(own, o.source, o.source.width, o.source.height);
      const rt = b.target(w, h, { mips });
      const sa_ = o.source.width / Math.max(o.source.height, 1), ta = w / h;
      this.pass({ name: "cover", source: COVER }, rt, { u_res: [w, h], u_scale: sa_ > ta ? [ta / sa_, 1] : [1, sa_ / ta] }, { u_in: own });
      return rt;
    };
    let out: RenderTarget;
    try {
      if (kind === "transition") {
        const tp = transitionProgram(id);
        if (!tp) throw new Error(`No transition "${id}"`);
        const A = first(tp.mips), B = copy(sb, tp.mips);
        out = this.runTransition(tp, A, B, { progress: o.progress ?? 0.5, params: o.params }, w, h);
        b.release(A); b.release(B);
      } else {
        const def = getEffect(kind === "look" ? "look" : id);
        if (!def) throw new Error(`No effect "${id}"`);
        if (kind === "look") await this.ensureLook(id, o.lutUrl);
        const input = first();
        const clip: Clip = { id: "thumb", media: { url: "", kind: "image" }, start: 0, duration: 2, in: 0, speed: 1, fit: "fill", fx: {} };
        const comp: Composition = { width: w, height: h, fps: 24, duration: 2, tracks: [] };
        const ctx: Ctx = { comp, W: w, H: h, unit: 1, px: 1, path: "", depth: 0 };
        const inst: EffectInstance = { type: def.id, params: kind === "look" ? { look: id, lut_strength: 1, ...(o.params ?? {}) } : o.params };
        try { out = this.runEffect(def, inst, input, { clip, index: 0, local: 1, sourceTime: 1, fade: 1 }, ctx, w / 640); } catch (e) { b.release(input); throw e; }
        if (out !== input) b.release(input);
      }
    } finally { if (own) b.deleteTexture(own); }
    const data = this.readRgba(out);
    b.release(out);
    return { data, w, h };
  }

  /** A look's LUT for a thumbnail when it isn't loaded yet (a registered LUT, or `url`). */
  private async ensureLook(look: string, url?: string) {
    if (!look || look === "none" || this.useNative(look) || this.luts.has(look)) return;
    let lut = registeredLut(look) ?? this.opts.luts?.[look];
    if (!lut) {
      const s = this.lutSource(look);
      const u = url ?? (typeof s === "string" ? s : undefined);
      if (!u) return;
      const r = await fetch(u, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`Look "${look}": HTTP ${r.status}`);
      lut = parseCube(await r.text());
    }
    if (!this.luts.has(look)) this.luts.set(look, { tex: this.b.createTexture3D(lut.size, lut.data), lut, from: lut });
  }

  // ── read-back ──────────────────────────────────────────────────────────────
  /** The last frame as planar I420, BT.709 limited range (w·h·1.5 bytes; valid until the next call). */
  readYuv420(): Uint8Array {
    if (!this.frame) throw new Error("Nothing drawn yet");
    const fw = this.frame.w, fh = this.frame.h;
    const L = yuvLayout(fw, fh);
    const rt = this.b.target(L.texW, L.texH, { format: "rgba8" });
    this.pass({ name: "yuv-pack", source: YUV_PACK }, rt, { u_res: [L.texW, L.texH], u_size: [fw, fh], u_texW: L.texW, u_cRows: L.cRows }, { u_in: this.frame });
    const n = L.texW * 4 * L.texH;
    if (!this.yuvBuf || this.yuvBuf.length !== n) this.yuvBuf = new Uint8Array(n);
    this.b.read(rt, 0, 0, L.texW, L.texH, this.yuvBuf);
    this.b.release(rt);
    return repack(L, this.yuvBuf);
  }

  /** The last frame as planar 4:2:0 10-bit (16-bit little-endian words: w·h Y, then U, then V; limited range), encoded
   *  for Composition.output (transfer sdr / hlg / pq, primaries bt709 / bt2020; default SDR BT.709). The desktop hands
   *  it to FFmpeg as yuv420p10le. The buffer is reused: copy it to keep it. */
  readYuv420p10(): Uint16Array {
    if (!this.frame) throw new Error("Nothing drawn yet");
    const fw = this.frame.w, fh = this.frame.h;
    const o = this.comp?.output;
    const tf = o?.transfer === "pq" ? 2 : o?.transfer === "hlg" ? 1 : 0, pr = o?.primaries === "bt2020" ? 1 : 0;
    const L = yuv10Layout(fw, fh);
    const rt = this.b.target(L.texW, L.texH, { format: "rgba8" });
    this.pass({ name: "yuv10-pack", source: YUV10_PACK }, rt, { u_res: [L.texW, L.texH], u_size: [fw, fh], u_texW: L.texW, u_cRows: L.cRows, u_out: [tf, pr] }, { u_in: this.frame });
    const n = L.texW * 4 * L.texH;
    if (!this.yuv10Buf || this.yuv10Buf.length !== n) this.yuv10Buf = new Uint8Array(n);
    this.b.read(rt, 0, 0, L.texW, L.texH, this.yuv10Buf);
    this.b.release(rt);
    return repack10(L, this.yuv10Buf);
  }

  /** The last frame (or a target) as RGBA8, rows top first (tests). */
  readRgba(rt: RenderTarget | null = this.frame): Uint8Array {
    if (!rt) throw new Error("Nothing drawn yet");
    const tmp = this.b.target(rt.w, rt.h, { format: "rgba8" });
    this.pass({ name: "copy", source: COPY }, tmp, { u_res: [rt.w, rt.h] }, { u_in: rt });
    const out = new Uint8Array(rt.w * rt.h * 4);
    this.b.read(tmp, 0, 0, rt.w, rt.h, out);
    this.b.release(tmp);
    return out;
  }

  /** What each source is doing (debugging): exact videos say "hardware", "software" or "fallback". */
  sourceInfo(): { key: string; kind: string; path?: string; size?: [number, number] }[] {
    return [...this.sources.entries()].map(([key, s]) => {
      const st = this.texs.get(s);
      return { key, kind: s.kind, path: (s as { path?: string }).path, size: st?.tex.w ? [st.tex.w, st.tex.h] : undefined };
    });
  }

  /** Upload an image for a clip's source directly (tests, the lab's self-test). */
  setFrame(c: Clip, img: TexImageSource, w: number, h: number, path = "") {
    const s = this.sourceFor(c, path);
    if (s) this.upload(s, { image: img, width: w, height: h, version: performance.now() + Math.random() });
  }

  /** Counts for the lab (incremental loads keep sources). */
  counts() { return { sources: this.sources.size, textures: this.texs.size, luts: this.luts.size, images: this.images.size, curves: this.curveTex.size }; }

  // ── context loss ───────────────────────────────────────────────────────────
  /** The context came back: every GPU object is gone. Re-create textures; sources re-upload on the next frame. */
  private restored() {
    for (const st of this.texs.values()) {
      st.img = this.b.createTexture(); st.tex = st.img;
      st.planes = undefined; st.rt = undefined; st.version = -1;
    }
    for (const l of this.luts.values()) l.tex = this.b.createTexture3D(l.lut.size, l.lut.data);
    this.curveTex.clear(); this.rand.clear();
    this.mattes.clear(); this.history.clear(); this.segs.clear();
    this.noise = null; this.clearTex = null; this.whiteTex = null; this.samples = null;
    for (const im of this.images.values()) im.tex = null;
    this.frame = null;
    this.stats.restores++;
    this.warnings.add("The graphics card reset; the engine restored its textures");
  }

  private unload() {
    for (const k of [...this.sources.keys()]) this.dropSource(k);
    for (const l of this.luts.values()) this.b.deleteTexture(l.tex);
    this.luts.clear();
    for (const t of this.curveTex.values()) this.b.deleteTexture(t);
    this.curveTex.clear();
    for (const t of this.rand.values()) this.b.deleteTexture(t);
    this.rand.clear();
    for (const im of this.images.values()) { if (im.tex) this.b.deleteTexture(im.tex); im.bmp?.close(); }
    this.images.clear();
    for (const h of this.history.values()) { this.b.release(h.prev); this.b.release(h.cur); }
    this.history.clear();
    for (const m of this.segs.values()) this.b.deleteTexture(m.tex);
    this.segs.clear();
    this.warnings.clear();
  }

  dispose() {
    this.unload();
    this.b.onRestore = null;
    this.b.release(this.frame);
    this.frame = null;
    this.b.dispose();
  }
}
