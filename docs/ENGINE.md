# Tatvam GPU render engine

*Phase 9, part 2 (TATVAM_PLAN.md §8.1, §8.2, §16.5). Started 12 October 2026.*

The engine is one TypeScript code base that draws the cut on the graphics card. It runs in three places:

| Place | What it does |
| --- | --- |
| **Browser preview** | Plays the cut in the web studio at reduced size, with the real transitions and effects instead of CSS approximations |
| **Desktop preview** | The same, at full size, in Tatvam Desktop's program monitor and pop-out windows |
| **Desktop final render** | A hidden window renders every frame exactly, and FFmpeg only encodes them (NVENC / Quick Sync / AMF) |

**Preview and render look the same, because they are the same code.** The FFmpeg server render stays as it is for
the web; anything it can't draw falls back to the nearest thing it can, with a warning.

## 1. Backend choice

v1 is **WebGL2**: it runs in every current browser and in Electron, `texImage2D` takes a `<video>`, an `ImageBitmap`
or a WebCodecs `VideoFrame`, and 3D textures handle LUTs. Shaders are GLSL ES 3.00, so the **gl-transitions**
collection (MIT, 125 transitions) runs as written. Every draw goes through a small `Backend` interface (textures,
render targets, programs, draw-quad, read-back), so a **WebGPU** backend can come in later for compute effects
without touching the timeline, effects or transitions code.

## 2. Effects data (shared by server and UI: `Shot.fx`)

Everything that exists today stays the same: `transition {type, duration}`, `look`, `adjust` (12 keys), `speed`,
`reverse`, `flip_h`, `flip_v`, `stabilize`, `move`, `fade_in` and `fade_out`. New, all optional:

| Key | Shape (ranges are clamped by `fx.clean`) | Notes |
| --- | --- | --- |
| `transition.type` | also `"gl:<name>"`, e.g. `"gl:cube"`, `"gl:GlitchMemories"` | One of the gl-transitions names |
| `transition.params` | `{name: number \| [n,n] \| [n,n,n] \| [n,n,n,n] \| bool}` | Overrides the transition's default uniforms; unknown names are dropped |
| `transition.easing` | `"linear"` (default), `"ease_in"`, `"ease_out"`, `"ease_in_out"` | |
| `lut_strength` | 0..1, default 1 | How much of the look or LUT to apply |
| `wheels` | `{lift: [r,g,b], gamma: [r,g,b], gain: [r,g,b]}`, each value -1..1 | Three-way colour corrector |
| `curves` | `{master?, r?, g?, b?}`: each 2..16 points `[x, y]` in 0..1, x ascending | Monotone cubic, baked into a 256-entry lookup |
| `chroma` | `{color: "#RRGGBB", similarity: 0..1, smoothness: 0..1, spill: 0..1}` | Green or blue screen key; what shows through is the track below, else black |
| `mask` | `{shape: "rect" \| "ellipse", x, y, w, h (0..1, centre and size), rotation: -180..180, feather: 0..1, invert: bool}` | Limits the shot's effects (or, on a layer, the layer) to a shape |
| `glow` | `{amount: 0..1, threshold: 0..1, radius: 0..1}` | Bloom from the highlights |

The GPU-only keys are `gl:` transitions, `wheels`, `curves`, `chroma`, `mask` and `glow`. The server keeps them, the
FFmpeg render ignores them and adds a warning, and a `gl:` transition becomes `fade` there ("Rendered as a fade: the
cube transition needs the GPU render in Tatvam Desktop").

`GET /api/fx/catalog` adds two lists:
- `gpu_transitions`: `[{id: "gl:cube", label, tags, author, license, params: [{name, type, default, min?, max?}]}]`
- `gpu_effects`: `["wheels", "curves", "chroma", "mask", "glow"]`

`GET /api/fx/looks/{look}.cube` is a 33-point 3D LUT of a preset look. The server bakes it once with FFmpeg (an
identity HALD image through the look's own filter) and caches it, so the GPU applies **exactly** the server's look.

The render plan gives every segment its cleaned `fx` and `gpu_transition` (the `gl:` type with params, or null),
next to the FFmpeg strings it already carries.

## 3. Composition (the engine's input, `frontend/src/engine/types.ts`)

```ts
interface Composition {
  width: number; height: number; fps: number; duration: number;
  tracks: Track[];                  // drawn bottom → top: tracks[0] is the main (shots) track
  background?: [number, number, number];
}
interface Track { id: string; kind: "main" | "layer"; hidden?: boolean; opacity?: number; blend?: BlendMode; clips: Clip[] }
interface Clip {
  id: string;
  media: { url: string; kind: "video" | "image"; width?: number; height?: number; duration?: number };
  start: number;          // seconds on the cut where the clip starts (a transition overlaps the clip before it)
  duration: number;       // seconds on the cut
  in: number;             // source seconds at the clip's start (trim)
  speed: number;          // 0.25..4; reverse plays from in + duration*speed backwards
  reverse?: boolean;
  fit: "cover" | "contain"; center?: [number, number];   // crop aim for cover (face-aware reframe)
  move?: { kind: MoveKind; amount: number };              // Ken Burns, as fx.move
  kenburns?: boolean;                                     // stills: the default slow push-in
  transform?: Transform;                                  // layers: x, y (centre 0..1), scale, rotation, opacity + keyframes
  fx: ShotFx;                                             // §2 (look, adjust, wheels, curves, chroma, mask, glow, flips, fades)
  transitionIn?: { type: string; duration: number; params?: Record<string, unknown>; easing?: Easing };
}
```

Two builders produce a Composition:
- `fromEpisode(episode, layers, {width, height, lang})` uses the same maths as `layoutClips()` and `assembler.timeline()`.
- `fromPlan(plan, urlForKey)` uses the desktop render plan.

## 4. Engine API (`frontend/src/engine/index.ts`)

```ts
const eng = await createEngine({ canvas?: HTMLCanvasElement | OffscreenCanvas, width, height, backend?: "webgl2" });
await eng.load(comp, { mode: "live" | "exact" });   // live = <video> elements; exact = WebCodecs, frame-accurate
eng.drawLive(t);                                     // realtime preview: draws what the sources show now
await eng.renderExact(t);                            // export: waits for exactly the frame at t on every clip
eng.readYuv420(): Uint8Array;                        // the frame as planar YUV 4:2:0, BT.709 limited range (W·H·1.5 bytes)
eng.resize(w, h); eng.dispose();
listTransitions(); listEffects();                    // the catalogue the UI shows
```

A frame is drawn in this order:
1. **Each clip:** sample its source at its own time (in, speed, reverse), fit or crop and Ken Burns, flips.
2. **Effects, in order:** LUT or look (with strength), adjust, wheels, curves, chroma key, glow, sharpen, blur,
   vignette, grain. The mask confines all of them.
3. **Fades.**
4. **The main track's transition** (`progress` eased) blends the clip before with this one.
5. **Layer tracks:** transform with keyframes, opacity and blend mode, composited in order.
6. **Output:** the canvas, or a YUV read-back for export (four Y samples per RGBA pixel, so `readPixels` stays
   RGBA8).

**Transitions.** The **58 FFmpeg xfade ids** are written as GPU transitions that look like the server's, so old cuts
keep their look. The **125 gl-transitions** come from the `gl-transitions` npm package. Each one is wrapped in a
program: `getFromColor` / `getToColor` / `progress` / `ratio`, plus its params as uniforms, compiled lazily and
cached.

**Sources.**
- **Live:** one muted `<video>` per clip, kept within half a frame of the timeline (seek when it drifts). Sound stays
  with the existing player.
- **Exact:** mp4box.js demuxes the file, a WebCodecs `VideoDecoder` decodes in order, and frames are cached by
  timestamp. Images go through `createImageBitmap`.

## 5. Desktop GPU render (Tatvam Desktop)

1. Render card → **Engine: GPU** (on by default when the cut uses a GPU-only transition or effect).
2. Main fetches the render plan and makes every key local, as before.
3. Main opens a hidden window `/desktop/render-job?id=…` (`backgroundThrottling: false`). The page asks the bridge
   for the job, builds `fromPlan(...)` with local media URLs, renders frame `i` at `t = i / fps`, and hands each frame
   to `engine.frame(id, i, bytes)` (an invoke, so main's write to FFmpeg sets the pace). It ends with
   `engine.done(id)`, or `engine.fail(id, message)` if something breaks.
4. FFmpeg reads `-f rawvideo -pix_fmt yuv420p -s W×H -r fps -i pipe:0` and adds the **audio** from the existing
   pipeline. That pipeline runs at draft size, keeps only its sound, and is unchanged otherwise: crossfades, voice,
   layers, music with ducking, loudnorm. Captions and titles are burned with the plan's ASS (libass with HarfBuzz
   shaping, the same as now), and the result is encoded with the preset's encoder and BT.709 tags.
5. Upload and versions work as before.

## 6. Tests

- **Pure modules** (timeline, keyframes, easing, curves, `.cube` parser, `fromEpisode`, `fromPlan`, YUV packing
  maths): `node --test` (`npm run test:engine` in `frontend/`, also in CI).
- **GPU:** `/dev/engine`, the engine lab page, renders a test composition with every transition and effect. It is
  driven over CDP in Electron and in the browser pane, and screenshots are compared.
- **Parity:** a desktop GPU render of a cut with fades and xfade transitions against the FFmpeg render of the same
  cut (PSNR, frame by frame).
