# Tatvam Editor: the desktop editing timeline

*Requested 12 October 2026. Built on the GPU engine (docs/ENGINE.md) inside Tatvam Desktop.*

A Premiere-style editor that stands on its own. You sign in, then **create a new edit** or **open / import** one,
and you're in a workspace that is only about editing:
- a project bin with imported media
- source and program monitors with in/out points and markers
- a multi-track timeline with drag and drop
- effects and transitions, effect controls with keyframes
- an audio mixer
- export

It works on any footage on the PC, not just Tatvam shots. You can also start from a studio episode's cut.

## 1. Where things live

| Thing | Where |
| --- | --- |
| **Edit project** | A folder in the library, `Tatvam Projects\Edits\<Name>\`, holding `<Name>.tatvamedit` (JSON, §2), `Media\` (copies of imported files when "copy into project" is on), `Cache\` (thumbnails, waveforms, proxies, previews) and `Renders\` |
| **Media** | Referenced by absolute path (like Premiere), or copied into `Media\`. Files are served to the editor window by the gateway at `/__media/<id>/<name>`. Only files the main process registered for an open edit project are served, and only with the app's session cookie, with Range support |
| **Account** | The normal sign-in (studio server). It covers AI features in the editor (upscale, Director later), Render Center upload, and the studio media of an episode imported into an edit |
| **Backup** | Autosave every 10 s with no unsaved changes lost, plus `<Name>.tatvamedit.bak` copies (the last 10). Saving to the studio server comes later |

## 2. Document model (`frontend/src/editor/model/types.ts`)

All times are **integer frames** at the sequence's frame rate (`fps`: 23.976, 24, 25, 29.97, 30, 50, 59.94 or 60). A
source position is in source frames at the media's own rate, converted on the fly.

```ts
interface EditProject {
  format: "tatvam-edit"; version: 1; id: string; name: string; created: string; modified: string;
  bins: Bin[]; media: MediaItem[]; sequences: Sequence[]; activeSequenceId: string;
  settings: { copyMedia: boolean; proxy: "off" | "auto" | "always"; autosaveSeconds: number };
}
interface Bin { id: string; name: string; parentId: string | null; color?: string }
interface MediaItem {
  id: string; binId: string | null; name: string; kind: "video" | "audio" | "image";
  path: string;                       // absolute local path (or "studio:<key>" for studio media)
  url?: string;                       // filled at runtime by the bridge (gateway /__media/...)
  duration: number; fps: number; width: number; height: number; hasAudio: boolean; audioChannels?: number;
  thumb?: string; filmstrip?: string; peaks?: number[]; proxyPath?: string; missing?: boolean;
  markers: Marker[]; inPoint?: number; outPoint?: number;     // source monitor marks (source frames)
  colorLabel?: string; comment?: string; offline?: boolean;
}
interface Sequence {
  id: string; name: string; width: number; height: number; fps: number; sampleRate: 48000;
  tracks: Track[];                    // video tracks V1..Vn (V1 bottom) and audio tracks A1..An
  clips: TimelineClip[];
  transitions: Transition[];          // at cuts on one track (or a clip's start or end edge)
  markers: Marker[]; inPoint?: number; outPoint?: number; playhead: number;
  workArea?: { zoom: number; scroll: number };
}
interface Track { id: string; kind: "video" | "audio"; name: string; index: number;
  locked: boolean; hidden: boolean; muted: boolean; solo: boolean; targeted: boolean; syncLock: boolean;
  height: number; volume: number /* dB */; pan: number /* -1..1 */; }
interface TimelineClip {
  id: string; trackId: string; start: number; duration: number;          // timeline frames
  source: { type: "media"; mediaId: string; in: number /* source frames */ }
        | { type: "title"; text: TitleSpec } | { type: "color"; color: string }
        | { type: "adjustment" } | { type: "nested"; sequenceId: string; in: number };
  speed: number; reverse: boolean; enabled: boolean; name: string; colorLabel?: string;
  linkId?: string;                                                         // A/V halves of one piece of media
  motion: { position: Param<[number, number]>; scale: Param<number>; rotation: Param<number>; anchor: Param<[number, number]>;
            opacity: Param<number>; blend: BlendMode; uniformScale: boolean };
  effects: EffectInstance[];                                               // video: in order; audio: gain, EQ … later
  audio?: { gain: Param<number> /* dB */; pan: Param<number>; fadeIn: number; fadeOut: number };
  timeRemap?: Param<number>;                                               // speed ramps (later)
}
type Param<T> = { value: T; keyframes?: { frame: number /* clip-relative */; value: T; ease: Easing }[] };
interface EffectInstance { id: string; type: string; enabled: boolean; params: Record<string, Param<unknown>>; mask?: MaskSpec }
interface Transition { id: string; trackId: string; at: number /* timeline frame of the cut */; duration: number;
  alignment: "center" | "start" | "end"; type: string /* xfade id | "gl:<name>" */; params?: Record<string, unknown>; easing: Easing;
  fromClipId?: string; toClipId?: string }
interface Marker { id: string; frame: number; duration: number; name: string; color: string; comment?: string }
interface TitleSpec { text: string; font: string; size: number; color: string; weight: number; align: "left" | "center" | "right";
  outline?: { color: string; width: number }; shadow?: { color: string; blur: number; x: number; y: number };
  background?: { color: string; padding: number; radius: number }; box: [number, number, number, number] /* x,y,w,h 0..1 */;
  animIn?: "none" | "fade" | "slide_up" | "typewriter" | "pop"; animOut?: "none" | "fade" | "slide_down" }
```

`toComposition(project, sequenceId)` turns a sequence into the engine's Composition (seconds, URLs, effects with
keyframes). The engine draws it for preview and export. `fromEpisode()` (ENGINE.md) lets a studio episode's cut become
a new sequence.

## 3. Editing (Premiere-style)

**Commands and undo.** Every change is a command applied to an immutable document:
- Undo and redo hold 500 steps, and the History panel lists them by name.
- Dragging produces one entry, not one per frame.
- The document is the single source of truth, kept in a zustand store.

**Tools (with their keys):**

| Tool | Key |
| --- | --- |
| Selection | V |
| Track select forward / backward | A / Shift+A |
| Ripple edit | B |
| Rolling edit | N |
| Rate stretch | R |
| Razor | C |
| Slip | Y |
| Slide | U |
| Pen (keyframes on the clip's opacity or volume line) | P |
| Hand | H |
| Zoom | Z |
| Text (adds a title clip) | T |

**Timeline:**
- **Tracks:** add, delete and rename. Each track header has target, lock, toggle output (eye or speaker), mute and
  solo controls, a sync lock, and a height you can change.
- **Clips:** dragging from the bin or source monitor, with Ctrl held, does an insert instead of an overwrite. You can
  drag between tracks, use **Ctrl-drag** to swap or insert, and **Alt-drag** to duplicate or unlink.
- **Snapping (S):** to cuts, markers, the playhead and in/out points.
- **Linked selection:** A/V clips move together. Alt-click selects only one half.
- **Keys:**
  - ripple delete: Shift+Del
  - lift: ; and extract: '
  - insert: , and overwrite: .
  - add edit (razor at the playhead): Ctrl+K
  - edit points: Q / W
  - go to next and previous edit: Up / Down
  - nudge: Alt+← / Alt+→
  - copy, paste, paste insert: Ctrl+C, Ctrl+V, Ctrl+Shift+V
  - paste attributes: Ctrl+Alt+V
  - enable or disable: Shift+E
  - group: Ctrl+G
  - nest: Ctrl+Shift+N
  - markers: M, with Shift+M and Ctrl+Shift+M to go to the next and previous
  - in/out: I / O, with X to mark the clip, Ctrl+Shift+X to clear, and Shift+I / Shift+O to go to them
  - play: J/K/L, Space, the arrows and Shift+arrows (5 frames), Home / End
  - zoom: = / -, and \ fits the sequence
- **Lanes:** keyframe lanes on clips (opacity and volume), waveforms on audio clips, filmstrip thumbnails on video
  clips.
- **Navigation:** a ruler with timecode, a work-area in/out range, and a mini-map.
- **Transitions:** dragged onto a cut (or a clip's edge). Ctrl+D adds the default video transition and Ctrl+Shift+D
  the default audio crossfade. Dragging an edge changes the duration. Double-click opens the settings.

**Panels** (dockview, saved layouts):
- **Project:** bins as folders, list and icon views, import (button, Ctrl+I, or drag from Explorer), search,
  metadata, relink missing media, new sequence from a clip.
- **Source:** the clip player with in/out marks, markers, insert / overwrite buttons, and drag of video-only or
  audio-only.
- **Program:** the sequence on the GPU engine, with safe-margin overlays (action and title safe), playback resolution
  (full, ½, ¼), zoom (fit, 100 %), in/out, markers, lift / extract, timecode, and dropped-frame display.
- **Timeline.**
- **Effects:** every video effect, video transition, audio effect and preset, with search, favourites, groups and an
  animated preview on hover. You drag them onto clips or cuts.
- **Effect Controls:** the selected clip's motion, opacity and time, plus every effect with its parameters. Each has a
  keyframe stopwatch, add/remove/next/previous keyframe buttons, a mini timeline with keyframes, and easing.
- **Audio Mixer:** a fader, pan, mute, solo and peak meter for each track, plus the master.
- **Text:** title clips with font, size, colour, outline, shadow, background box and in/out animation. Indic scripts
  are shaped by the browser's HarfBuzz.
- **Markers, History, Info.**

**Import:** video (mp4, mov, mkv, webm, m4v, avi), audio (wav, mp3, aac, m4a, flac, ogg) and images (png, jpg, webp,
gif, tiff). Each file is checked with FFmpeg (duration, fps, size, audio), and the app makes a thumbnail, a filmstrip
and waveform peaks. Proxies are optional.

You can also import:
- a **studio episode** (its cut becomes a sequence, with the media synced into the edit folder)
- your own **.cube LUTs**
- **custom transitions** in gl-transitions GLSL format
- **custom effects** as a small GLSL fragment with declared parameters

## 4. The catalogue

| Kind | Source | Count |
| --- | --- | --- |
| Transitions | The 58 FFmpeg xfade ones, redrawn on the GPU, plus **gl-transitions** (MIT) | 183 |
| Colour | Adjust (12 controls), preset looks (exact LUTs), your LUTs with strength, colour wheels, curves, HSL, colour balance, channel mixer | ~10 |
| Keying and compositing | Chroma key, luma key, masks (rectangle, ellipse, feather, invert), blend modes, drop shadow, outline, bevel | ~8 |
| Stylize and blur | From **pixi-filters** (MIT): advanced bloom, glow, god rays, glitch, CRT, old film, RGB split, shockwave, twist, bulge/pinch, zoom blur, motion blur, radial blur, kawase blur, tilt-shift, emboss, cross-hatch, dot, ASCII, pixelate, reflection, simplex noise, colour map, colour gradient, colour replace, convolution. From **glfx.js** (MIT): colour halftone, dot screen, edge work, hexagonal pixelate, ink, lens blur, denoise, swirl, unsharp mask, noise, sepia, vibrance, vignette, perspective | ~45 |
| Transform | Motion (position, scale, rotation, anchor), crop, flips, Ken Burns, picture-in-picture presets | built-in |
| Audio | Gain, volume keyframes, pan, fades, crossfades (constant power / constant gain), EQ (3-band), compressor, limiter, noise gate | 8 |

Each effect lives in `frontend/src/engine/effects/<group>/<name>.ts`: its GLSL, its parameters (name, type, default,
min, max, step, label) and its group. A port keeps its source's MIT notice and author. The UI builds its controls from
the declared parameters.

## 5. Desktop bridge additions (`window.tatvamDesktop.editor`)

```ts
editor: {
  list(): Promise<{ path: string; name: string; modified: string; thumb?: string }[]>;   // recent and library edits
  create(name: string, preset: { width: number; height: number; fps: number }): Promise<{ path: string; project: EditProject }>;
  open(path?: string): Promise<{ path: string; project: EditProject } | null>;            // no path: file dialog
  save(path: string, project: EditProject): Promise<{ modified: string }>;               // atomic write and .bak rotation
  importMedia(path: string, files?: string[]): Promise<MediaItem[]>;                     // no files: dialog; probe, thumbs, peaks
  pathsForDrop(files: File[]): string[];                                                 // webUtils.getPathForFile, drag from Explorer
  mediaUrl(path: string, file: string): Promise<string>;                                 // registers the file: /__media/<id>/<name>
  relink(path: string, mediaId: string): Promise<MediaItem | null>;
  proxy(path: string, mediaId: string): Promise<void>;
  importEpisode(pid: number, eid: number, path: string): Promise<{ sequenceId: string; project: EditProject }>;
  export(path: string, sequenceId: string, opts: { preset: string; range: "all" | "inout"; upload?: boolean }): Promise<string>;
  importLut(path: string): Promise<{ id: string; name: string } | null>;
  importShader(path: string, kind: "transition" | "effect"): Promise<{ id: string; name: string } | null>;
}
```

An export renders the sequence with the GPU engine through the desktop GPU render path. The hidden window's job holds
a Composition instead of a server plan. The audio is mixed by FFmpeg from the sequence's audio clips: trim, speed,
gain and pan keyframes, fades, crossfades, track volume and pan, mute and solo, then loudnorm. It is muxed with the
preset's encoder.

## 6. Engine additions needed

These go into `frontend/src/engine`:
- **Generic tracks:** transitions on any video track (at cuts and edges), keyframed `motion` on every clip, and
  keyframed **effect parameters**.
- **New clip types:** title clips (Canvas2D text into a texture, cached while static, animated in and out), colour
  mattes, adjustment clips (effects on everything below), and nested sequences (rendered into a texture).
- **Effect registry:** declared parameters, the pixi-filters and glfx.js ports, and custom GLSL effects and
  transitions registered at runtime.
- **Playback resolution:** full, ½ or ¼ for preview, with proxies when there are any.

## 7. Phases

1. The model, commands, undo and timeline (multi-track, drag and drop, tools, snapping, markers, in/out), plus the
   project bin and import, the program and source monitors, the editor home (new, open, import episode), save and
   autosave.
2. Effects and transitions on the timeline and in Effect Controls with keyframes, the full catalogue (pixi-filters,
   glfx ports), titles.
3. Audio mixer and audio effects, export through the GPU engine, nested sequences, adjustment layers, custom shader
   and LUT import.
4. Polish: proxies, relink, multicam, speed ramps, track groups, OTIO export.

## 8. AI tools in the editor

The editor has an **AI** panel and an **AI** submenu on the clip context menu. They work on any clip on the timeline,
not only Tatvam shots.
- **Paid steps:** each shows its price first and goes through the studio's jobs, budgets and approvals
  (`jobs.submit`). Google stays first wherever the studio is Google-first, and writing runs on Claude.
- **Free steps:** these run on the PC (FFmpeg or the GPU) and cost nothing.

| Tool | What it does | Runs on |
| --- | --- | --- |
| **Auto captions** | Speech to text with word timings for the selected clips or the in/out range, in any studio language, onto a new caption track (title clips, styled; karaoke highlight optional) | Server: Gemini listening (Google-first), Sarvam for Indic when set |
| **Translate captions** | Caption track → new tracks in other languages | Server: Claude |
| **AI voice-over** | Type or paste text → a voice clip on an audio track (voice picker: the studio's voices) | Server: ElevenLabs / Sarvam / Gemini TTS routes |
| **Dub a clip** | Transcribe → translate → voice in the target language, timed to the original lines, onto a new audio track (the original muted, kept) | Server |
| **Clean up voice** | Isolate the voice from noise and music | Server: ElevenLabs isolation |
| **Sound effects** | Prompt (or "suggest from the picture") → an SFX clip at the playhead | Server: ElevenLabs SFX |
| **Music** | Prompt + length (in/out or selection) → a music clip, ducked under dialogue | Server: music route |
| **Generate B-roll / fill gap** | Prompt (+ optional first frame from the playhead) → a video clip of the gap's length, into the bin and the gap | Server: video routes (Veo first), with engine and price shown |
| **Extend clip** | Continue a clip from its last frame for N seconds | Server: video routes |
| **Edit with words** | Change a clip with an instruction ("make it night", "remove the car") | Server: omni-edit route |
| **AI upscale** | To 2K or 4K | This PC (Real-ESRGAN, free) or cloud Topaz (paid) |
| **Remove silences** | Find pauses over N ms below −X dB and cut them out (ripple), with a preview list first | This PC (FFmpeg silencedetect) |
| **Detect scenes** | Split a long clip at its cuts, or add markers there | This PC (FFmpeg scene score) |
| **Beat markers** | Markers on a music clip's beats, for cutting to the beat | This PC (onset detection on the decoded audio) |
| **Loudness** | Measure (LUFS, peak) and normalise a clip or the mix | This PC (FFmpeg ebur128 / loudnorm) |
| **Edit assistant** | Chat. Instructions like "cut this to 30 seconds", "add captions and music", "make the intro punchier" become a list of edit commands. You review them, apply them in one go, and undo them in one step | Server: Claude, tools = the editor's commands |

**Plumbing:**
- **The studio side:** an edit gets a studio project on first AI use, `POST /api/edits` with
  `Project.type = "edit"`, hidden from the studio's project lists. That project carries the costs, budget,
  approvals and history. Its id is stored in the edit as `studioProjectId`.
- **Media the AI needs:** uploaded with `bridge.editor.uploadAsset(path, mediaId, projectId)`, sent to
  `POST /api/edits/{pid}/assets`. The returned key is cached on the MediaItem as `studioKey`.
- **Running a tool:** `POST /api/edits/{pid}/ai/estimate` with `{tool, params}` gives the price, then
  `/ai/run` with the same body starts it. Results arrive on the job: `{outputs: [{key, kind, duration}],
  segments?, commands?, reply?}`.
- **Results back on the PC:** `bridge.editor.importStudioAsset(path, key)` downloads into `Media\` and returns a
  MediaItem.
- **Local analysis:** `bridge.editor.analyze(path, mediaId, kind)`, where kind is `"silence" | "scenes" | "beats" |
  "loudness"`, with options.

**How AI tools reach the editor:** the AI code (`frontend/src/editor/ai/**`) only touches the editor through this
interface, which the editor implements:

```ts
interface EditorHost {
  project(): EditProject; sequence(): Sequence; selection(): { clipIds: string[]; trackIds: string[] };
  playhead(): number; inOut(): { in?: number; out?: number };
  apply(label: string, mutate: (draft: EditProject) => void): void;          // one undoable command
  addMedia(items: MediaItem[], binName?: string): void;
  placeClip(opts: { mediaId: string; trackKind: "video" | "audio"; at: number; trackId?: string; newTrack?: boolean;
                    name?: string; duration?: number; mode?: "overwrite" | "insert" }): string /* clip id */;
  addTitleTrack(name: string, cues: { start: number; end: number; text: string }[], style?: Partial<TitleSpec>): void;
  path(): string; studioProjectId(): number | null; setStudioProjectId(id: number): void;
  toast(msg: string, kind?: "ok" | "warn" | "error"): void;
}
// frontend/src/editor/ai/index.ts exports:
//   AiPanel({ host }: { host: EditorHost }): JSX.Element
//   aiClipActions(host: EditorHost, clipIds: string[]): { id: string; label: string; group: string; run(): void; paid: boolean }[]
```

## 9. Status (12 October 2026)

Phases 1 and 2 are built, plus most of 3, together with the §8 AI tools. All of it runs in Tatvam Desktop with the
real bridge, and GPU exports work.

**Checks:** frontend `test:editor` 49 tests and `test:engine` 28 tests, desktop 81 tests, backend full suite with
12 tests for the AI tools.

**Measured in Electron:**
- Import of real files (thumbnails, filmstrips, peaks) in about 1 s.
- Save and reopen keeps every clip, marker and piece of media.
- Smooth with 254 clips (a drag step averages 26 ms, a scroll step 17 ms).
- A V2 wipe between picture-in-picture clips, V1 motion keyframes, and pixelate inside a feathered ellipse mask.
- ½-resolution playback with no dropped frames.
- A custom shader imported, applied and exported.
- GPU export of edits on NVENC with the full audio mix.

**Free analysis tools on test media:** silence detection (exact gaps), scene detection (the cut at 2 s), beats
(120.1 BPM), loudness (−21.8 LUFS).

**AI tools (mock mode):** captions, voice-over, the assistant applied in one undo step, and remove-silences with
ripple.

**Not done yet:**
- Mask keyframes.
- Mixing the sound of nested sequences.
- The noise gate in preview.
- Export progress inside the editor (it shows in the desktop's render queue).
- Sarvam speech-to-text (there's no provider for it).
- Karaoke word highlight.
- Sidechain ducking for AI music.
- Free Real-ESRGAN upscaling for edit media (edit media upscales in the cloud).
- Multicam, speed ramps, track groups and OTIO export (phase 4).
- Live runs of the paid AI providers.
