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

## 9. Status (13 October 2026)

Phases 1–3 are built, together with the §8 AI tools and wave 3 (§10–§13). All of it runs in Tatvam Desktop with the
real bridge, and GPU exports work.

**Checks:** frontend `test:editor` and `test:engine`, desktop `npm test`, backend full suite (see the PR for the
counts). The GPU self-test passes 472 of 472.

**Measured in Electron (phases 1–3):**
- Import of real files (thumbnails, filmstrips, peaks) in about 1 s.
- Save and reopen keeps every clip, marker and piece of media, and every optional field (a round-trip test covers
  all of them, and unknown future fields survive too).
- Smooth with 254 clips (a drag step averages 26 ms, a scroll step 17 ms).
- A V2 wipe between picture-in-picture clips, V1 motion keyframes, and pixelate inside a feathered ellipse mask.
- ½-resolution playback with no dropped frames, and speed ramps in real time (62 frames in 2.5 s, none dropped).
- A custom shader imported, applied and exported.
- GPU export of edits on NVENC with the full audio mix; 10-bit frames for HEVC Main10 and ProRes.

**Free tools on this PC (GTX 1660 Ti):**
- Silence, scene, beat (120.1 BPM) and loudness analysis. Loudness can measure one clip's range.
- Audio sync to the sample (confidence 0.99).
- RIFE slow motion: 1080p 24→96 fps at 15 fps, ×4 slow motion of 2 s in 19 s.
- Whisper captions on 60 s of speech:
  - large-v3-turbo on CUDA 12.4: 8.5 s; on the CPU: 93 s (about 11× faster);
  - base: 3 s on CUDA, 9 s on the CPU.
- Export loudness within 0.1 LU of each preset (YouTube −14, EBU −23, Apple −16, OTT −24); ducking 4.2 dB under
  speech.

**AI tools (mock mode):** captions, voice-over, the assistant in one undo step, remove silences with ripple,
highlights into a 9:16 Short, B-roll ideas, thumbnails, mood per scene, backups with restore, frame comments.

**Not done yet:**
- Mask keyframes and tracked masks (wave 4).
- Export progress inside the editor (it shows in the desktop's render queue and the status bar).
- Sarvam speech-to-text (there's no provider for it).
- Live runs of the paid AI providers.
- Real Premiere / Audition checks of the XML details listed in §12.
- Packaged-installer checks of the assistants' stdio relay.

## 10. Wave 3: more looks, transitions and workflow (started 12 October 2026)

Asked for: more transitions, filters, colour profiles, moods, a smoother workflow and more features. Each area below
has one owner, so there are five builders working in parallel. The shared interfaces come after the table, and each
owner keeps its edits to other people's files small and additive.

| Owner | What |
| --- | --- |
| **engine-pack** (`frontend/src/engine/**`) | **Transitions** (+~110): a procedural luma-matte library (60+ patterns: clock, iris shapes, brush, ink, smoke, burn, blinds, mosaic …); light leaks and film burns; whip pan, zoom-through, spin and stretch with motion blur; glitch and retro (VHS, RGB split, datamosh, static, scan lines); 3D (flip, fold, page roll, cube variants, doors). **Effects** (+~40): film (grain types, halation, gate weave, scratches and dust, flicker); lens (anamorphic flare, chromatic aberration, distortion, bokeh, prism); retro and stylize (VHS, 8 mm, cartoon, sketch, watercolour, posterize, duotone); clean-up (temporal denoise, deflicker, skin smoothing). **Colour:** camera log inputs (S-Log3, LogC3/LogC4, V-Log, C-Log3, D-Log, BMD Film Gen 5, from the published curves); outputs (Rec.709, sRGB, HLG, PQ); hue-vs-sat, hue-vs-hue and luma-vs-sat curves. **Analysis:** auto white balance, shot match and grade-from-a-reference (Reinhard transfer in Lab, which outputs effect params). **APIs:** GPU scopes, clip-frame thumbnails for the LUT and Mood browsers, 10-bit read-back (`readYuv420p10`), and MediaPipe (Apache-2.0) background blur/replace effects and a face tracker for auto-reframe |
| **editor-motion** (`editor/model/**`, `editor/timeline/**`, `editor/panels/EffectControls*`, a new `editor/panels/GraphEditor*`, `editor/keymap.ts`; owns `types.ts`, `ops.ts`, `store.ts`) | Speed ramps (a `timeRemap` curve), a keyframe graph editor (bezier handles), motion paths in the program monitor, a magnetic timeline mode, snapping to beats, freeze frame, compound clips, multicam (angles synced by audio), a keyboard shortcut editor (Premiere / Resolve / Final Cut presets), saved workspaces |
| **editor-looks** (new `editor/panels/{Moods,LutBrowser,Scopes,Templates,Transcript,Comments,Versions}*`, `editor/moods/**`, `editor/templates/**`, `editor/render/title.ts`) | Moods (one click, an intensity slider, a mood per scene from the studio's scene emotions); a LUT browser with live thumbnails; a scopes panel; colour profile UI with auto WB, shot match and reference grade; animated title templates (~100), karaoke captions, lower thirds, stickers, shapes, an Indic font picker; a templates library (intros, outros, subscribe, social); multi-format export (16:9, 9:16 and 1:1 in one go, with face-tracked auto-reframe); edit by transcript; timeline review comments; a version history UI |
| **desktop-tools** (`desktop/**`) | Tool installs (RIFE, whisper.cpp CPU/CUDA plus models), RIFE slow motion, local Whisper transcription with word timings, audio EQ / compressor / limiter / noise removal / sidechain ducking / loudness presets in the export mix, multicam sync analysis, automatic proxies, a batch multi-format export queue, 10-bit GPU frames, the version-history and backup bridge |
| **backend-ai2** (`backend/**`, `frontend/src/editor/ai/**`) | Edit backups and versions on the server, timeline review comments on edits, and new AI tools: B-roll suggestions from the transcript, auto highlights into Shorts, a thumbnail generator, music to length and mood, voice cloning with a consent record, mood suggestions per scene. All of them show in the AI panel |

**Shared interfaces:**
- **engine → editor:**
  - `computeScopes(kind, frame?)`
  - `analyzeColor(url, t)` returns `{wb: {temperature, tint}, stats}`
  - `matchColor(source, reference)` returns adjust/wheels params
  - `renderThumbnail(id, width, kind, {source?: {url, t}})`
  - `trackFaces(url, from, to)` returns `[{t, x, y, w, h}]`
  - effect ids `input_profile`, `output_transform`, `bg_blur`, `bg_replace`
- **desktop → editor:**
  - `tools.status()` / `tools.install(id)` for `"rife"`, `"whisper"`, `"whisper-cuda"`, `"whisper-model:<name>"`
  - `editor.transcribeLocal(path, mediaId, {language, model})` returns `{language, segments: [{start, end, text, words}]}`
  - `editor.interpolate(path, mediaId, {factor | fps, in?, out?})` returns a MediaItem
  - `editor.analyze(path, mediaId, "sync", {against})` returns `{offset}`
  - `editor.versions(path)` / `editor.restoreVersion(path, id)`
  - `editor.exportBatch(path, sequenceId, [{preset, aspect, reframe}])`
- **server:**
  - `POST/GET /api/edits/{pid}/backups` and `/backups/{bid}/restore`
  - comments with `target_type = "edit"`, carrying `sequence_id` and a frame
  - new AI tools `broll_suggest`, `highlights`, `thumbnail`, `voice_clone`, `mood_suggest`

**Result (13 October 2026):**
- **engine-pack:** 120 `tv:` transitions (304 in all), 40 effects (107 in all), the camera log profiles, HDR and 10-bit
  read-back, GPU scopes, colour analysis and match, MediaPipe background blur and replace and face tracking, time
  maps, native eases and title sub-rect uploads (docs/ENGINE.md §7).
- **editor-motion:** speed ramps (one clip with a time map) and freeze frames, the graph editor, motion overlay and
  paths, magnetic mode, snapping to beats and transients, compound clips with tabs, multicam (2–9 angles), the
  shortcut editor (Premiere / Resolve / Final Cut), and 5 workspaces.
- **editor-looks:** 18 moods, the LUT browser with user LUT folders, scopes and colour tools, 106 title templates,
  42 stickers, 7 caption styles, karaoke captions, 11 template sequences, multi-format export with reframe, edit by
  transcript, comments, and versions (local plus cloud).
- **desktop-tools:** tool installs (RIFE, whisper.cpp CPU and CUDA 12.4, the models), slow motion, local
  transcription, the full audio export graph (§11), sync, proxies, batch and 10-bit export, auto backups, sidecars,
  and `writeLut`.
- **backend-ai2:** edit backups, frame comments, and the AI tools broll_suggest, highlights, thumbnail, music by
  mood/BPM, voice_clone (consent required, producer role) and mood_suggest.

## 11. Audio effects (wave 3, added 12 October 2026)

The audio effects are `EffectInstance`s on audio clips (or on a track's or the master's effect list). Every parameter
is a keyframeable `Param`. One list of ids and parameters is shared by:
- **Preview** (`frontend/src/editor/audiofx/**`, owned by **editor-audio**): WebAudio in realtime. Effects that
  WebAudio can't do the same way play from an **audio render cache**: the desktop renders that clip's sound with the
  export's own FFmpeg graph, so preview and export always match.
- **Export** (`desktop/src/main/editor-audio.ts`, owned by **desktop-tools**): FFmpeg filters.

| Group | Effect ids (FFmpeg in export) |
| --- | --- |
| Dynamics | `gain` (volume), `compressor` (acompressor), `multiband` (3 bands, mcompand), `limiter` (alimiter), `gate` (agate), `expander` (compand), `deesser` (deesser), `auto_level` (dynaudnorm), `speech_level` (speechnorm) |
| EQ & filters | `eq3` (bass/equalizer/treble), `eq_graphic` (10-band equalizer chain), `eq_param` (up to 6 biquad bands), `highpass`, `lowpass`, `bandpass`, `notch`, `dehum` (50/60 Hz + harmonics), `tilt` (tiltshelf), `virtual_bass` (virtualbass), `exciter` (aexciter), `crystalizer` |
| Clean-up | `denoise` (afftdn), `denoise_wavelet` (afwtdn), `denoise_nl` (anlmdn), `declick` (adeclick), `declip` (adeclip), `dialogue_enhance` (dialoguenhance), `voice_enhance` (highpass + presence EQ + deesser), `trim_silence` (silenceremove at the edges) |
| Time & pitch | `pitch_shift` (rubberband pitch, formants kept), `time_stretch` (rubberband tempo), voice presets `chipmunk`, `deep_voice`, `robot` (afreqshift + comb), `alien` |
| Space | `reverb` (afir with built-in impulse responses: room, studio, hall, plate, church, cathedral, stage, bathroom, stairwell), `echo` (aecho), `stereo_widen` (stereowiden), `haas`, `mono`, `auto_pan` (apulsator) |
| Modulation & creative | `chorus`, `flanger`, `phaser` (aphaser), `tremolo`, `vibrato`, `distortion` (asoftclip types), `bitcrusher` (acrusher), `lofi`, `telephone`, `radio`, `megaphone`, `walkie_talkie`, `underwater`, `next_room`, `vinyl` (crackle + wow) |
| Utility | `channel_swap`, `left_only`, `right_only` (channelmap/pan), `invert_polarity`, `mono_to_stereo`, `delay_sync` (compensationdelay, ms) |

**Impulse responses** are generated by a shared, deterministic recipe: early reflections, then exponentially
decaying filtered noise, with these parameters per preset: size, decay, damping, pre-delay and stereo width. Both
sides use the same WAV files. The desktop writes them to `userData/irs/<preset>.wav` and serves them at
`/__media/irs/…`; the preview's ConvolverNode loads them.

**Meters and analysis** (editor-audio):
- In the mixer and on the master: a LUFS meter (momentary, short-term, integrated), true peak and a phase
  correlation meter.
- A spectrum analyser panel.
- "Match loudness": every selected clip is set to the same LUFS, measured with `editor.analyze(…, "loudness")`.

**Bridge (desktop-tools):** `editor.renderAudioPreview(path, sequenceId, clipId)` renders that clip with its trims,
speed and effects through the export graph into `Cache\audio\<hash>.wav` and returns `{url, duration}`. It is cached
by a hash of the source, the trims and the effect parameters.

**Result (13 October 2026):**
- **Catalogue:** 75 effect ids. 49 play live in WebAudio; 26 play from the desktop's render of that clip. There are
  also 3 generator clip types, 20 audio transitions and 11 chain presets.
- **Preview vs export:** registry and export agree on every id, parameter name and default (checked by a script),
  and the impulse-response recipe is byte-identical on both sides. Of 48 measured cases on FFmpeg 7.1, 44 null below
  −56 dB (most below −75 dB), and vinyl matches in level (its crackle is random). The four compressor-type effects
  are within 0.6 dB RMS, because the preview uses Chrome's DynamicsCompressor.
- **FFmpeg 7.1 quirks** worked around in the export:
  - `bass`/`treble` aren't the RBJ shelf; we use `lowshelf`/`highshelf`.
  - `tiltshelf` gain is inverted.
  - `chorus` ignores its base delay; we use `flanger`.
  - `vibrato` emits NaN at the start, so a guard follows it.
  - `haas` is a comb; we use `adelay` on one channel.
  - `acrusher` only downsamples on the mix side, so it runs in two passes.
  - `acrusher` at `aa=0` divides by zero and outputs NaN when its float rounding lands past the half step (any
    upstream filter can cause this), so the hold pass uses `aa=1` and `aeval` rounds the bits.
- **Meters:** a −23 dBFS tone reads −23.00 LUFS (BS.1770-4, EBU 3341 levels in the tests).

### 11.1 Audition and Premiere parity (added 12 October 2026)

Checked against Adobe's public effect lists for Audition and Premiere Pro. We write everything ourselves; no Adobe
code, presets, impulse responses or LUTs are copied or bundled. These are additions to the table above:

| Group | Effect ids (FFmpeg in export) |
| --- | --- |
| Dynamics | `tube_compressor` (acompressor + asoftclip tanh), `loudness_maximizer` (gain + alimiter), `mastering` (eq_param + exciter + stereo_widen + limiter, one panel), `dc_offset` (highpass 5 Hz / dcshift) |
| Clean-up | `noise_print` (afftdn: learn the noise from a marked range, `sample_noise`, then reduce), `hiss_reduction` (afftdn, high bands only), `dereverb` (afftdn + gate on the tail; marked "basic"), `center_extract` (keep or remove the centre: vocals out for karaoke, or dialogue only; pan/stereotools) |
| Time & pitch | `pitch_bend` (keyframed rubberband pitch through sendcmd) |
| Space | `doppler` (keyframed pitch + pan + level from a path), `surround_reverb` → the stereo `reverb` with width |
| Creative | `guitar_amp` (EQ + asoftclip + cabinet IR through afir), `invert` (= `invert_polarity`), `silence` |
| Generate (new clip types) | `tone` (sine, square, sawtooth, sweeps), `noise` (white, pink, brown, blue, violet, velvet: anoisesrc), `dtmf` |

**Audio transitions** (on an audio cut, like video transitions): `constant_power` (acrossfade qsin, the default),
`constant_gain` (tri) and `exponential` (exp), plus the other acrossfade curves by name.

**Essential Sound style panel** (editor-audio): tag a clip as **Dialogue, Music, SFX or Ambience** and get one-click,
role-based controls:
- **Dialogue:** loudness to target; repair (noise, rumble, hum, de-ess, reverb); clarity (dynamics, EQ preset, voice
  enhance); creative reverb.
- **Music:** loudness; auto-duck under dialogue; **remix to length** (cut on the beats from `editor.analyze(…, "beats")`
  so the music ends with the sequence).
- **SFX:** loudness and reverb.
- **Ambience:** loudness, stereo width and duck.

Every control writes ordinary effect instances, so nothing is hidden.

**Not doing:**
- Automatic pitch correction (auto-tune).
- Spectral (frequency) editing with a healing brush. This one is a later phase.
- Hosting third-party VST3 plug-ins. That needs a native host; it's a later phase, and only for the user's own
  plug-ins.

## 12. Interchange with Premiere Pro and Audition (added 12 October 2026)

Owner: **editor-interop**. Pure converters live in `frontend/src/editor/interop/**`; disk access and launching the
apps live in `desktop/src/main/editor-interop.ts`. It works without Adobe installed: the exchange files are open
formats.

| Format | Export | Import | Opens in |
| --- | --- | --- | --- |
| **FCP 7 XML** (`xmeml` v4) | Sequence → tracks, clips (in/out, speed, enabled), transitions (cross dissolve, dip), markers, audio levels and pan keyframes, nested sequences | Premiere's File → Export → Final Cut Pro XML: the same features; unknown effects become markers with their name | Premiere Pro (File → Import), Audition (open the XML as a multitrack session), DaVinci Resolve, Final Cut Pro 7 |
| **EDL** (CMX 3600) | V1 + A1–A4, dissolves, clip names in comments | Yes | Everything |
| **OpenTimelineIO** (`.otio` JSON) | Full timeline with markers and metadata | Yes | Resolve, OTIO tools |
| **Audio stems + AAF-free handoff** | "Send to Audition": each audio track rendered to a WAV (with or without effects) + an FCP XML that places them | — | Audition |
| **Markers CSV** | Premiere's marker CSV layout | Yes | Premiere and YouTube chapters |

Media paths in exported files are the local absolute paths (`file://localhost/D:/…`), so the other app finds them.
Clips that only exist on the server are made local first, as the desktop already does for exports.

**Open in Premiere / Audition:** the desktop looks for the apps (registry App Paths and
`Program Files\Adobe\Adobe Premiere Pro *\Adobe Premiere Pro.exe`, `…\Adobe Audition *\Adobe Audition.exe`). When
it finds one, the button writes the XML and opens it in that app. Otherwise it saves the file and opens the
folder.

**User LUTs and looks:** the LUT browser (editor-looks) can add any folder of `.cube` / `.3dl` files the user
chooses. We never scan or ship other apps' installed LUTs.

**Result (13 October 2026):**
- **Export and import:**
  - FCP 7 XML, EDL, OTIO and markers CSV all export and import, and so do YouTube chapters.
  - Re-importing XML, EDL and OTIO in Electron gave identical clip lists. EDL keeps V1 and the audio only.
  - Anything XML can't carry is kept as a "Tatvam: …" marker with its data and restored on import.
  - Network (UNC) paths in imported files are never opened.
- **Still to check in real Premiere / Audition:**
  - keyframe `<when>` timing;
  - marker colours;
  - the Dip to Color parameter;
  - the audio cross-fade ids;
  - Time Remap on audio;
  - the Text/Color generators;
  - how Audition opens the stems XML.

## 13. AI assistants and auto edit (added 12 October 2026)

Owner: **desktop-mcp**. Main-process code is in `desktop/src/main/mcp/**` and `desktop/src/main/autowatch.ts`.
Renderer code (planner, executor, UI) is in `frontend/src/automation/**`. With this, Claude Desktop, Claude Code,
Codex or any other MCP app can drive the **local** editor. The studio's own MCP server (docs/MCP.md) stays as it is,
for the server side.

### 13.1 Local MCP server
- **Transport.** Streamable HTTP on `127.0.0.1:<port>/mcp`. The default port is 18110, set in Settings or with
  `TATVAM_MCP_PORT`. It listens on loopback only.
  - A stdio relay serves apps that can only start a command: `"Tatvam Studio.exe" --mcp-stdio`. It starts the app if
    it isn't running, then relays to the HTTP server, and never opens a window of its own.
- **Off by default.** Turn it on in Settings → AI assistants ("Allow AI assistants to control Tatvam").
- **Tokens.** Each assistant has its own token: a name, scopes, created and last-used dates, and Revoke. Tokens are
  kept with `safeStorage`. Requests carry `Authorization: Bearer tvd_…`.
  - The Host header must be the loopback address and port.
  - A request with a browser `Origin` header is refused, which blocks web pages and DNS rebinding.
  - CORS is never answered.
- **Scopes:**
  - `read`: look at edits, media, timelines and frames.
  - `edit`: change edits.
  - `export`: render files.
  - `spend`: approve paid AI work; budgets still apply. Without it, paid tools only **propose**, and the user
    approves in the app.
- **Folders.** An assistant can use the library root and the folders listed in Settings → AI assistants → Folders.
  Any other folder gets an in-app prompt ("Claude Desktop wants to use D:\Shoots\Day1"): Allow once, Always or Deny.
  Exports go only to the library's export folders. Only media and interchange file types are read.
- **Visible and undoable.** Every change runs in the open editor window as an ordinary command labelled
  "Assistant: <tool>", so it can be seen and Ctrl+Z works. A banner shows "<client name> is editing — Pause / Stop".
  Pause makes further tool calls wait; Stop ends the session. Every call goes into a log (Settings → AI assistants →
  Activity).

### 13.2 Tools (one JSON schema each, short descriptions, results summarised for a model)
| Group | Tools |
| --- | --- |
| Project | `status`, `list_edits`, `open_edit`, `create_edit` (name, format preset, optional `from_folder`), `save_edit`, `list_formats` |
| Media | `import_media` (paths or a folder, recursive, type filter, series order), `list_media`, `analyze_media` (scenes, silence, beats, loudness, transcript through local Whisper, black, freeze and blur detection) |
| Timeline | `get_timeline` (tracks and clips in seconds and timecode, concise), `add_clip`, `move_clip`, `trim_clip`, `split_at`, `delete_clips` (ripple optional), `set_speed`, `add_transition`, `add_effect` / `set_effect_param` (video and audio, including keyframes), `apply_mood`, `add_title`, `add_captions`, `add_marker`, `set_audio` (gain, pan, role, ducking), `undo`, `redo` |
| See it | `get_frame` (the program monitor at time t as a PNG image, at most 1280 px), `get_waveform_summary` |
| Auto edit | `auto_edit` (see 13.3; `dry_run` returns the plan without applying it), `list_auto_edit_styles` |
| Export | `list_presets`, `export` (preset, range, name), `render_status`, `cancel_render` |
| AI tools | The editor's existing AI tools (docs/EDITOR.md §8 and §10) through the same estimate → approve → job path. With `spend`, the assistant can approve within budgets |

### 13.3 Auto edit (`frontend/src/automation/autoedit/**`, a pure planner plus an executor)
- **Input:** a folder or media items.
- **Order:** by series name (the default; natural sort, follows docs/DESKTOP.md §3.1), by date taken, by timecode,
  or by content (transcript).
- **Analysis:** silences, scenes, beats, loudness, transcript, and bad takes (black, frozen, blurred, too short, or
  clipped sound).
- **Styles:**
  - **Talking head / vlog:** cut silences and bad takes, jump-cut punch-ins, captions, voice clean-up and loudness.
  - **Montage / music video:** cuts and transitions on the beats of a chosen or generated music track, speed
    ramps, and a mood.
  - **Documentary:** scene order, J/L cuts, ambience bed, lower thirds.
  - **Highlights / Short:** 9:16, the best moments by speech, loudness and motion, a hook title, captions.
  - **Slideshow:** stills with Ken Burns to music.
- **Options:** target length, format, music (a file, the library, or AI music through approval), caption language,
  mood or look, transition style, titles.
- **Output:** a new sequence "Auto edit · <folder> · <style>" as ONE undoable command, plus a summary (clips used,
  silence removed, length).
- **Where it appears:** the same planner backs the `auto_edit` tool, the **Auto edit** button (Start window "New
  edit from folder", the editor's File menu and the Project panel), and watch folders.

### 13.4 Watch folders (`desktop/src/main/autowatch.ts`)
- **Settings:** each watch folder has a style, a target edit and a mode: "append to the edit" or "rebuild the auto
  edit".
- **Trigger:** a new file is used once its size has stayed the same for 5 s.
- **Result:** a notification ("3 new clips added to Lighthouse auto edit"). Nothing renders or spends unless the
  user has set that up.

### 13.5 Connecting (Settings → AI assistants shows these, ready to copy, with the token filled in)
- **Claude Code:** `claude mcp add --transport http tatvam-desktop http://127.0.0.1:18110/mcp --header "Authorization: Bearer tvd_…"`
- **Claude Desktop** (`claude_desktop_config.json`):
  `{"mcpServers": {"tatvam-desktop": {"command": "<app exe>", "args": ["--mcp-stdio"], "env": {"TATVAM_MCP_TOKEN": "tvd_…"}}}}`
- **Codex** (`~/.codex/config.toml`):
  `[mcp_servers.tatvam-desktop]`, `command = "<app exe>"`, `args = ["--mcp-stdio"]`, `env = { TATVAM_MCP_TOKEN = "tvd_…" }`
- **Other apps:** the HTTP address plus a bearer token.

**Result (13 October 2026):**
- **Tools:** 40 tools, each limited by its scope.
- **Live test:** the end-to-end test is `desktop/test/mcp-e2e.test.ts`; run it with `TATVAM_E2E_MCP=1`.
  - Folder prompt, then auto edit: 5 clips in, a black take and a 0.7 s take dropped, 5.2 s of silence removed,
    25.8 s out.
  - get_frame, a transition, an effect and an undo.
  - A draft export, checked with ffprobe.
- **Relay:** works through `ELECTRON_RUN_AS_NODE` with `dist/mcp-relay.cjs`, because Electron's main process can't read
  stdin on Windows. The packaged build must keep the runAsNode fuse on.
- **Watch folders:** added a new clip 7.7 s after it was copied.
- **SDK:** `@modelcontextprotocol/sdk` 1.30.1 and `zod` 4.6.5, bundled.

## 14. Roadmap: wave 4 (planned, not started; added 13 October 2026)

These are the next editor features the user chose: all local, no AI, and nothing built yet. Each area is designed
so it could be built on its own later. The research for broadcast graphics (classy text animations, tickers,
stingers, the Wipe Designer, live previews and licence-clean assets) is kept outside the repository; this table is
its summary.

**Asset packs** (4 HDR lighting maps, 6 CC0 materials, Kenney particle sprites, about 52 MB, and 20 OFL fonts,
11.7 MB) are **not approved yet**. Without them, lighting, materials and particles are generated by code.

| Area | What | Where it would live |
| --- | --- | --- |
| **Preview and smart render** | **Preview render:**<br>• Render in to out, plus an automatic render of heavy parts when idle.<br>• A green / amber / red bar over the timeline ruler (rendered / heavy / too slow).<br>• The cache is keyed by a hash of the composition slice (clips, params, effects, engine version).<br>• Playback uses the cached file for that range; a change only drops the affected ranges.<br>• Files go in `Cache\preview\<edit>\`, and there's "Delete render files".<br>**Smart render on export:** a range with no effects, an unchanged source, the same codec, size and frame rate, cut on GOP boundaries is stream-copied; everything else is encoded. Segments are joined with the concat demuxer; the sound is always remixed. A test checks the result frame-exact against a full render | `desktop/src/main/preview-render.ts`, `smart-render.ts` (new), a few lines in `render.ts`; `frontend/src/editor/render-cache/**` (new) |
| **Network render** | **Network render.** One PC is the main; the others are **render nodes**, set to "Render for other PCs" in Settings.<br>• **Finding nodes:** UDP broadcast and mDNS on the LAN, private addresses only.<br>• **Pairing:** a 6-digit code shown on the node, then a per-pair token.<br>• **Work:** the main splits an export into frame ranges by GOP, scaled to each node's measured speed. Nodes fetch the edit and the media they need from the main's gateway with the token (or use the same paths when a shared drive or NAS has them), render with the **same app version**, and stream the segments back.<br>• **Finish:** the main checks each segment (frames, duration, hash), joins them, mixes the sound and muxes.<br>• **Failures:** a lost node's range is given to another node, or rendered locally.<br>• Never over the internet; a node can be stopped any time | `desktop/src/main/netrender/**` (new), a Settings section |
| **Pro editing tools** | **Trim monitor:** two-up outgoing/incoming frames, ripple/roll/slip/slide with live preview, J/K/L trimming while it plays, and frame counters.<br>**Timeline list view:** every clip and marker with search and filters, plus "Close all gaps".<br>**Organising:** track folders (collapse, mute/solo the group), clip colour labels (Premiere's 16) with "select label group", and sub-clips.<br>**Macros:** record actions from the action registry, then replay, name, give a shortcut, and export/import as JSON | `frontend/src/editor/timeline/**`, `editor/model/{trim,macros,labels,folders}.ts` (new), a new `panels/TrimMonitor.tsx` and `panels/TimelineList.tsx` |
| **Media management and subtitles** | **Bins:**<br>• Smart bins (saved rules: kind, rating, keyword, label, used/unused, resolution, fps, date, camera).<br>• Ratings, favourites and keywords.<br>• Clip details from ffprobe and EXIF (camera, lens, ISO, shutter, timecode, colour tags, audio layout).<br>• "Used in timeline" badges with jump-to.<br>**Collect project:** copy every used file (or trimmed copies with handles) into one folder, relink, and write a report.<br>**Subtitle editor:**<br>• A cue list over the waveform; drag edges, split and merge, keep the reading-speed limits (CPS, line length).<br>• Styles; import and export SRT, VTT and TTML (and SCC for export).<br>• Burn-in, or a sidecar on export | `editor/panels/ProjectPanel*` (additive), `editor/media/**` (new), `editor/subtitles/**` (new), `desktop/src/main/editor-meta.ts`, `collect.ts` (new) |
| **Pen masks and tracking** | **Pen masks:**<br>• Bézier paths drawn on the program monitor; several per clip.<br>• Add / subtract / intersect / difference; feather per point; expansion; opacity; invert.<br>• Keyframed paths (vertex interpolation).<br>• Rectangle and ellipse presets that become paths.<br>**Classic tracker (not AI):**<br>• Point tracking: pyramidal Lucas–Kanade in a worker or on the GPU, with confidence.<br>• Planar tracking: homography from several points with RANSAC.<br>• Track forward/back from the playhead.<br>• Apply the track to a mask, a title, a sticker, a blur/pixelate effect, or a colour window.<br>• Stabilise from a track | `frontend/src/engine/masks/**`, `engine/tracking/**` (new), `editor/panels/MaskTools*` (new), small mounts in ProgramMonitor |
| **Colour** | **Node grading:** serial, parallel and layer nodes. Each node holds wheels, curves, an HSL qualifier, a window (from pen masks and tracking) and a LUT, with a node graph UI, bypass and per-node keyframes.<br>**HSL qualifier:** hue/sat/luma ranges with softness, matte view, denoise and blur of the matte.<br>**Colour management:**<br>• ACES in the engine: ACEScct working space, IDTs from the existing log curves, and an ACES 1.3 output (RRT+ODT) for Rec.709, sRGB, Rec.2100 PQ and HLG.<br>• OCIO: import a config's baked LUTs per display/view; no OCIO runtime.<br>**HDR scopes** in nits (PQ scale), and **gamut warnings** (a zebra overlay for out-of-gamut colour).<br>**Grades:** a still gallery (grab, wipe compare, apply its grade), copy/paste a grade (Ctrl+Alt+V picks attributes), and grade versions per clip | `frontend/src/engine/colour/**` (new), `editor/colour/**` (new), a **Colour** workspace |
| **Motion graphics** | **Lottie import:** lottie-web light canvas build (MIT; no expressions, no eval) as a generated source, with keyframable properties from the file.<br>**Vector work:** shape layers (rect, ellipse, polygon, star, path; fill/stroke/gradient; trim paths; repeater) and text on a path.<br>**3D extruded titles:** opentype.js outlines (harfbuzzjs for Indic shaping), WebGL extrusion with bevel, procedural studio lighting (HDR maps once approved) and materials (metal, glass, matte).<br>**Effects:**<br>• A GPU particle generator (emitters, forces, sprites procedural or from packs once approved).<br>• Camera-shake presets.<br>• Split-screen and picture-in-picture layout templates.<br>**Expressions:** a safe expression language (a parser, never eval): `time`, `value`, `wiggle(f, a)`, `loopOut()`, `linear()`, `ease()`, `random(seed)`, maths, and references to other params.<br>**Keyframe preset library** | `frontend/src/engine/mograph/**`, `editor/mograph/**` (new) |
| **Broadcast graphics and live previews** | **Text:** the 42 classy text in/out animations from the research (mask reveals, staggers with springs, kinetic, stroke/fill, slice/glitch), including per-akshara animation for Indic text.<br>**Tickers:** 16 ticker and lower-third systems (crawl, flip, breaking bar, stock with arrows, score bug, clock/live bug, weather, election, social, now playing, stacked). Data comes from CSV, JSON or RSS and is **frozen into the project** so exports repeat. Crawl speeds are 0.10 / 0.14 / 0.19 of frame height per second; EBU R95 safe areas.<br>**Stingers:** 30 wipe/stinger transitions (panels, shapes, brush/ink, liquid, slices, light sweeps, paper tear, logo), all procedural.<br>**Wipe Designer:** 18 params, a JSON spec rendered by one shader, a coverage check (the cut is never visible), and "Randomise" with taste rules. Save it as a transition.<br>**Live previews:**<br>• Animated catalogue thumbnails from the user's clip.<br>• A Resolve-style hover preview on the program monitor (400 ms, never in undo, half size).<br>• One cache.<br>• Budget: hover ≤ 0.5 ms per frame, live ≤ 8 ms per frame | `editor/templates/broadcast/**`, `engine/transitions/stingers/**` (new), `editor/panels/WipeDesigner*`, `editor/preview/**` (new) |
| **Monitor tools, QC and recording** | **Monitor tools:** zebras, false colour, focus peaking, safe areas and grids (rule of thirds, centre, custom), a 1:1 pixel loupe, A/B wipe compare between two clips, versions or stills, and a clean full-screen output on a second monitor.<br>**QC before export:**<br>• Flash frames (≤ 2-frame leftovers), black frames, gaps, offline media, missing fonts.<br>• Titles outside the safe area.<br>• Loudness and true peak against the preset, and audio clipping.<br>• A photosensitive flash and red-flash check (ITU-R BT.1702 / Ofcom guidance).<br>• Each finding jumps to its frame; "Fix" where possible.<br>**Recording:**<br>• Voice-over with punch-in (pre-roll, countdown, takes stacked).<br>• Webcam and screen capture (desktopCapturer), straight onto the timeline.<br>• A teleprompter window fed by the studio script or typed text, with speed and mirror | `editor/panels/ProgramMonitor*` (additive overlays), `editor/qc/**`, `editor/record/**` (new), `desktop/src/main/record.ts`, `output.ts` (new) |

**When it's built:**
- **Contracts first:** each builder adds its optional model fields to `editor/model/types.ts`, keeps `serialize.ts`
  round-tripping them (the round-trip test there must still pass), and mirrors the bridge in
  `desktop/src/shared/types.ts`, `preload` and `frontend/src/lib/desktop.ts`.
- **Undo:** every user action is one command through the store's command API.
- **Export matches preview:** everything new that draws (masks, nodes, mograph, stingers, tickers) goes through
  `editor/engine.ts buildComposition`, so the hidden render window draws it the same way.
- **Tests:** pure modules with `node --test` (`test:editor` / `test:engine` / desktop `npm test`), and they must pass
  on Linux CI. No hard-coded Windows paths: use `path.join(os.tmpdir(), …)`, and guard Windows-only behaviour with
  `skip`.
- **Live QA:** in Electron over CDP against a throwaway server, each builder on its own ports. Never port 8100, never
  the real database, never the user's Documents folder.

## 16. News Room: broadcast graphics (started 13 October 2026)

What was asked for: a separate **News Room** inside the editor for news-style editing:
- tickers, name straps, info boards, screen layouts, wipes and openers, all **fully customisable**;
- content that is easy to add, looping graphics, several screen layouts, and both **16:9 and 9:16**;
- "all the advanced extras".

This is graphics for recorded edits, not the live Newsroom Studio (dropped).

Decisions:
- **Assets:** everything is generated by code with the fonts already bundled (Oswald, Bebas Neue, Anton, Teko, Inter,
  Montserrat, Poppins, and the Anek Devanagari / Kannada / Telugu / Tamil fonts). The news font pack is not approved yet.
- **Maps:** map boards use the user's own map image with animated pins. No built-in map of India (official borders
  need an approved source).
- **No AI helpers** in this section.
- **Sound effects:** templates carry sound hints (`sounds`). When the SFX branch (§15) is on main, auto SFX reads them.

### 16.1 Where things live

Everything is under `frontend/src/editor/newsroom/`, plus `desktop/src/main/newsroom/`. The model gains these
additive fields (`model/types.ts`):
- `EditProject.newsroom?: NewsroomDoc` holds the look, the templates copied into the edit, the rundown, people and
  places, data snapshots, air time, the ratio mode and settings.
- `ClipSource` gets `{ type: "graphic"; gfx: GfxInstance }`.
- `TimelineClip.slot?: SlotBinding` places a clip in a screen layout's box.
- `Track.gfxRole?: GfxRole` marks a graphics track.

All News Room types are in `newsroom/types.ts`, and the renderer contract is in `newsroom/render/contract.ts`. These
two files are the contract: change them only with the lead's agreement.

| Path | What | Owner |
| --- | --- | --- |
| `types.ts`, `render/contract.ts`, `render/registry.ts`, `templates/kit.ts`, `templates/index.ts`, `render/kinds/index.ts`, `events.ts`, `overlays.tsx` | The contract, registries and wiring | lead |
| `render/index.ts`, `render/kinds/basic.ts`, `render/**` (engine, animation, text, paint, images, frame keys) | The renderer, plus the rect / text / image / logo / line / icon kinds | nr-core |
| `looks.ts`, `format.ts`, `commands.ts`, `resolve.ts`, `companion.ts`, `preview.tsx`, `hooks.ts`, `lab/**` | Looks, formats, commands, resolution, the both-ratio companion, the shared preview component, hooks, the dev lab | nr-core |
| `model/toComposition.ts`, `editor/engine.ts`, `model/serialize.ts`, `pages/desktop/RenderJob.tsx`, `automation/bridge/frame.ts`, `App.tsx` (the lab route only) | Additive edits so graphics draw in preview and export | nr-core |
| `templates/tickers.ts`, `templates/bugs.ts`, `render/kinds/ticker.ts`, `render/kinds/clock.ts`, `tickers/**` | 16 ticker and bar systems, bugs (logo, LIVE, clock), the ticker item editor | nr-tickers |
| `templates/straps.ts`, `templates/boards.ts`, `render/kinds/{number,list,bars,table,pins}.ts`, `boards/**` | 14 name straps and 16 boards | nr-boards |
| `templates/layouts.ts`, `render/kinds/slot.ts`, `slots.ts`, `layouts/**` | 12 + 8 screen layouts, video boxes, layout morph, squeeze-back | nr-layouts |
| `templates/stingers.ts`, `templates/openers.ts`, `templates/backgrounds.ts`, `render/kinds/{shine,panels,bg}.ts`, `wipes/**` | 30 stingers, 8 openers and bumpers, 10 looping backgrounds, the Wipe Designer, news transitions | nr-wipes |
| `designer/**`, `panels/LookPanel.tsx`, `library.ts`, `desktop/src/main/newsroom/files.ts` | The Template Designer, the channel look editor, Make my look, the look / template library on disk | nr-designer |
| `panels/{GraphicsLibrary,FillIn,Rundown,People,Playlist,CompanionMonitor}.tsx`, `room/**`, `rundown.ts`, `editor/EditorHome.tsx` (additive), `editor/keymap.ts` (additive) | The room: New news edit, library, Fill in, rundown and Build, people and places, playlist and quick keys, find and replace, the other-ratio monitor | nr-room |
| `feeds/**` (named so because the repository ignores `data/` folders), `auto/**`, `qc/**`, `panels/{DataPanel,GraphicsQC}.tsx`, `desktop/src/main/newsroom/fetch.ts` | Data sources and snapshots, speaker straps, AI-content labels, graphics QC | nr-data |
| `delivery/**`, `panels/Deliver.tsx`, `desktop/src/main/newsroom/export.ts` (+ additive in `render.ts` / RenderJob read-back) | Both-ratio export, transparent export, loops, batch from a spreadsheet, news shorts, language versions, preview reel, TV presets | nr-delivery |

### 16.2 Channel looks (`looks.ts`, `format.ts`)

A look holds:
- colours (primary, secondary, accent, dark, light, text, textOnPrimary, breaking, live, up, down);
- fonts (headline, body, numbers, plus one per script), the logo, motion (sharp / smooth / bouncy), plate style (flat /
  glass / angled / rounded), radius and capitals;
- bug corner, scale and opacity;
- number style (Indian grouping, native digits, ₹), clock (12/24 h, zone, date style), ticker separator and sound hints.

Five ready looks:
- `look.classic_red`
- `look.modern_blue`
- `look.business` (navy and gold)
- `look.sports` (energetic green and black, Teko)
- `look.regional` (saffron and deep blue; Anek fonts per script, native digits off by default)

How layers use a look:
- Layers say `"@primary"`, `"@textOnPrimary/80"` and `"@headline"`; nothing hard-codes a colour unless the Designer
  sets one.
- Changing the edit's look re-skins every graphic.
- Formats: `fmtNumber` does Indian grouping (12,34,567), lakh / crore compact, signs and the currency. `fmtClock` and
  `fmtDate` use `Intl` with the look's zone. `scriptOf` picks the per-script font.

### 16.3 The renderer (`render/**`)

```ts
drawGraphic(g, input: GfxRenderInput, W, H, t, dur): DirtyRect   // draws at t seconds of a clip dur long
graphicFrameKey(input, W, H, t, dur): string                      // same key → same picture
ensureGraphicAssets(input): Promise<void>                         // fonts loaded, images decoded (export)
registerLayerKind(def: LayerKindDef)                              // kinds add themselves (render/kinds/*)
```

**Design space.** 1920×1080 (16:9), 1080×1920 (9:16), 1080×1080 (1:1) and 1080×1350 (4:5).
- The core scales design pixels to the canvas.
- A ratio without its own design gets one made from the nearest design using the layers' `pin`s.
- `ratioOf(W, H)` picks the design.

**Timing.**
- The in phase is `timing.in` seconds from the clip start; the out phase is the last `timing.out` seconds.
- Each layer's `anim.in` / `anim.out` runs inside its phase (`delay`, `dur`, ease by the look's motion).
- `loop` runs while the layer is shown.
- Templates with `loop: true` (tickers, bugs, backgrounds) have no out phase unless they set one.
- Everything is a pure function of `t`: the same frame always draws the same picture, so exports repeat exactly.
  Blinks and staggers snap to frames.

**Animations the core applies:**
- fade
- slide (dir)
- wipe / mask reveal (dir)
- grow (a plate's width from its anchored edge)
- flip (3D-look scale on x or y)
- pop
- zoom
- rise / drop
- blur
- typewriter
- sweep (light sweep across the layer)
- unfold
- stagger (`by` line / word / item)

For Indic text, never animate per letter: letters join, so the smallest unit is a grapheme cluster or a word. Use
`Intl.Segmenter`.

**Loops:**
- blink (LIVE dot)
- pulse
- shine (a light sweep every `period` s)
- float
- spin
- breathe
- flash (priority items)

**Layers.**
- Layers draw in order. `when` hides a layer when a field is empty, `clip` confines it to another layer's box, and
  `opacity`, `rotation`, `blend` and `shadow` apply to any kind.
- A text layer with `p.grow = { layers: [...], pad, min, max }` resizes those plates to the text's measured width, so
  straps fit names.
- Text that doesn't fit shrinks (`p.fit: "shrink"`, down to 60 %), then wraps (`maxLines`), then ellipsizes.

**Core kinds (basic.ts):**
- **rect:** fill (paint or gradient), stroke, radius, skew (angled ends by look.plate), glass (translucent with a light
  top edge), stripe accents.
- **text:** fields, font, size, weight, colour, align, valign, tracking, upper (or the look's), italic, outline, shadow,
  maxLines, fit, grow.
- **image:** a field's image, cover / contain, circle / rounded mask, border.
- **logo:** the look's logo, or its text logo.
- **line**
- **icon:** a built-in vector set. Kinds may add icons with `registerIcons`.

**Property conventions** (the Designer shows these as "Follow look", "Auto" …):
- **rect:** `fill`, `gloss`, `glass` ("look" / "on" / "off"), `shape` ("look" / "flat" / "rounded" / "angled" / "pill"),
  `radius` (−1 follows the look), `skew`, `ends`, `stroke`, `strokeWidth`, `stripe` (side), `stripeColor`,
  `stripeWidth`.
- **text:** `text`, `font`, `size`, `weight` (0 follows the look), `color`, `align`, `valign`, `padX`, `tracking`
  (design px), `lineHeight`, `upper` ("look" / "on" / "off"), `fit`, `maxLines` (0 = as many as the box holds),
  `minScale`, `outline`, `outlineWidth`, `grow: { layers, pad, min, max }`.
- **Text tokens:** `{field}`, `{$time}`, `{$time:s}`, `{$date}`.
- **Paints** may name a colour field: `"{level}"` uses that field's value (a colour or a look token).
- **`when`:** `"{field}"`, `"!{field}"`, `"{field}=value"` and `"{field}!=value"`.
- **Directions** of an animation are the way the layer travels. Loops: `glowColor` for glow.
- **Number props with a usual value** say so in their hint ("−1 follows the look", "0 = as many as fit"); a `null`
  default means "automatic".
- **Overrides** ("Change only this one") are keyed by layer id, or `"<layerId>@<ratio>"` for one ratio only
  (`applyOverrides(layers, ov, ratio)`).
- **The logo bug** (`role: "bug"`, `kind: "logo"`) is designed top right; `placeBug` mirrors it to the look's
  `bug.corner`, scales it by `bug.scale` and fades it by `bug.opacity`.
- **Kinds beyond the list in `types.ts` are fine:** layouts add "backdrop" and "progress", boards add "stamp", wipes
  add "countdown".

**Collision rules** (`NewsroomSettings.collision`, on by default): a strap or board on screen with a ticker, breaking
bar or stacked ticker lifts above their top edge. The composition passes `input.avoid`, the boxes of the other
graphics at the clip's start.

**Performance.**
- A static picture is drawn once.
- A crawl pre-renders its strip once, then moves it.
- `bounds` lets the engine upload only the changed rectangle.
- Target: no more than 2 ms per graphic per frame at 1080p.

**In the composition** (nr-core):
- A graphic clip becomes a generated source `{ kind: "graphic", input, width, height, duration }` at URL
  `gen:gfx:<path><clipId>`, in both `toComposition` and `toVideoComposition`.
- `editor/engine.ts makeGenerated` draws it.
- `RenderJob.tsx` and `automation/bridge/frame.ts` await `ensureGraphicAssets` for every graphic before the first frame.
- Slot clips get their motion and a `crop` effect from `slotMotion` (16.6). Layout graphics get `layoutOverrides`
  (their morph) as their render overrides, so holes and pictures move together.
- `CompositionOptions.lang` picks a language version; `Composition.transparent` draws on transparency (alpha exports).

**The dev lab** (dev builds only, no sign-in): `/editor/gfx-lab?template=<id>&ratio=16:9|9:16|both&t=<s>&look=<id>&values=<URL-encoded JSON>&w=<px>`,
or `grid=<Category>` for a contact sheet. Extras: `bg=studio|checker|black|grey`, `avoid=1` (a ticker on screen),
`dur=<s>`, `engine=1` (through `buildComposition` and the GPU engine), `perf=1` (ms per 1080p draw). It sets
`document.title = "ready"` once drawn. The Designer and the Wipe Designer have dev-only openers too: `?nrDesigner=<id>`
and `?nrWipes=<id|new>` in the editor.

### 16.4 Templates (`templates/**`)

Built-ins are code (`kit.ts`: `tpl`, `rect`, `text`, `field.*`, `anim`, `step`). Every one has a 16:9 **and** a 9:16
design, ids `nr.<category>.<name>` (stable forever), sample values that read like real Indian news, and `sounds` hints.

| Category | Count | Owner |
| --- | --- | --- |
| Tickers | 16 systems | nr-tickers |
| Bugs | logo bug, LIVE bug and clock, corner clock / date / temperature, EXCLUSIVE / RECORDED tags | nr-tickers |
| Straps | 14 | nr-boards |
| Boards | 16 | nr-boards |
| Layouts | 12 for 16:9 + 8 vertical-first | nr-layouts |
| Stingers | 30 | nr-wipes |
| Openers | 8 | nr-wipes |
| Backgrounds | 10 seamless loops | nr-wipes |

**The 16 ticker systems:**
- crawl
- flip
- stacked two-row
- breaking bar
- category
- weather
- markets
- score (cricket, football, kabaddi)
- election
- speed news
- rates
- alert
- social
- now / next
- headline-only band
- vertical two-line

**The 14 straps:**
- anchor
- reporter with location
- guest / expert
- two-line headline
- location
- on phone (photo)
- via video call
- hashtag
- source / courtesy
- file footage / representative image / archive
- translated
- sponsored by
- AI-generated label
- story slug

**The 16 boards:**
- key points (bullets build)
- big number (counting, lakh / crore, ₹)
- quote with photo
- poll bars
- timeline
- vs comparison
- fact check with stamp
- rates
- weather
- election seats (half-donut with the majority line)
- cricket scorecard
- top headlines list
- profile card
- countdown
- map with pins (the user's map image)
- photo gallery

**Design rules for "nice layouts"** (every template):
- **Safe areas:** stay inside graphics-safe (5 % in 16:9; 9:16 keeps clear of the top 12 %, bottom 22 % and right 16 %
  where Reels and Shorts draw their buttons).
- **Hierarchy:** a strong hierarchy with headline 700–800 weight, secondary 500. Sizes at 1080 lines: name 50–56 px,
  role 30–36, ticker 38–44, headline strap 56–64, board titles 64–80. Vertical sizes are about 1.15× (on a 1080-wide
  frame).
- **Plates:** an accent stripe or tag in `@accent`, subtle gradients, angled or rounded by the look, never plain grey
  boxes.
- **Motion:**
  - in 0.4–0.7 s with staggers of 60–120 ms between parts, out 0.3–0.4 s;
  - plates lead and text follows;
  - logos get a shine loop every 8–12 s;
  - nothing pops without easing.
- **Numbers:** tabular figures and the look's number format.
- **Text that won't fit** shrinks, never clips. Sample text includes a long name and a Hindi line.

### 16.5 Commands and tracks (`commands.ts`)

`ensureNewsroom`, `ensureGfxTrack`, `useTemplate`, `templateOf`, `addGraphic`, `setGraphicValues`,
`replaceGraphicTemplate`, `applyLook`, `autoHold`, `graphicClips`. Pure: UI code calls them inside one
`host.apply(label, draft => …)` (one undo step).

Graphics tracks are video tracks with `gfxRole`. They're created on first use, named, above the picture tracks in
this order bottom → top:
1. Layout
2. Boards
3. Straps
4. Ticker
5. Bug
6. Wipes

The Background track goes **below** V1.

`addGraphic` copies the template into `newsroom.templates` and sets the length:
- **auto:** words / readSpeed, 4–12 s
- **fill:** to the sequence end
- **until-next:** to the next graphic on the track
- **fixed:** `seconds`

It returns the clip id.

### 16.6 Screen layouts and video boxes (`slots.ts`, `render/kinds/slot.ts`)

A layout is a graphic on the Layout track that sits above the pictures. It draws the background with **see-through
holes** where its boxes are, plus frames, labels and name tags. Pictures go on the tracks below it with
`slot = { index, fit, zoom, offset }`.

`slotMotion` turns the layout on screen into the clip's motion (position, scale) and a `crop` effect (in %), per
ratio:
- **Layout change:** when the layout changes, the boxes glide from the old to the new place during the new layout's in
  phase. This is the layout morph, baked as keyframes on whole frames.
- **No layout:** a clip with a slot and no layout on screen keeps its own motion.

Squeeze-back / L-band is a layout whose box 0 shrinks while the L-shaped frame and its ad / info panel come in.

How it fits together:
- Layouts draw their studio plate with the "backdrop" kind, and story counters with "progress".
- `layoutOverrides` gives each layout graphic its morph:
  - boxes glide from the previous layout;
  - the main picture squeezes in from, and back out to, full frame when it was on screen before or carries on after;
  - the old layout holds its boxes while a new one takes over;
  - the backdrop doesn't dip.
- With no layout on screen a slot clip shows full frame. A layout without that box hides it.
- `layouts/commands.ts` (`assignSlot`, `placeInSlot` …), `layouts/SlotAssigner.tsx` and the clip menu ("Put in box",
  "Fill the boxes in order", "Take out of box") do the placing.

UI: right-click a clip → "Put in box 1…n", or drop a clip from the bin onto a box in the program monitor.

### 16.7 Both ratios (`companion.ts`)

`newsroom.ratio = "both"` gives one timeline and two outputs. `companionProject(p, seqId, "9:16")` builds the other
ratio on the fly, never saved:
- graphics use their 9:16 design;
- slot clips follow the 9:16 layout boxes;
- other pictures are reframed to fill (`formats.ts reframeSequence`, with face samples when the edit has them);
- graphics whose `ratios` exclude it are dropped.

The Other ratio monitor and the export both use it.

### 16.8 The room (`room/**`, panels, `EditorHome.tsx`)

**Editor Home: "New news edit"**
- You choose the name, ratio (16:9 / 9:16 / Both), channel look (live previews) and frame rate.
- It creates the edit, a starter set (logo bug, LIVE bug and clock, a crawl with sample lines, filling the sequence)
  and opens the **News Room** workspace (`workspaces.ts` id `news`).
- Any edit can switch to it from Window → Workspaces. The first graphic added to an edit creates `newsroom`.

**Panels:**
- **Graphics (`nr-graphics`):**
  - every category, with animated previews on hover (`preview.tsx`) and search;
  - click to add at the playhead on its track, or drag to the timeline;
  - Wipes add at the nearest cut;
  - a "Customise" button opens the Designer.
- **Fill in (`nr-fill`):**
  - a form built from the selected graphic's fields: text, lists (one per line, paste a list), tables, images from the
    bin, people and places pickers;
  - the look, hold, ratios and language tabs;
  - "Change only this one" and "Edit template".
- **Rundown (`nr-rundown`):**
  - stories as rows; import CSV / Excel-saved CSV or paste lines;
  - **Build** places each story's strap, key points and ticker lines on its range (story markers);
  - reorder or retime stories.
- **People (`nr-people`):** people and places with photos, roles, names per language and the transcript speaker label.
- **Playlist (`nr-playlist`):** ready graphics on F1–F12, like a channel graphics operator.
- **Other ratio (`nr-companion`):** the live 9:16 (or 16:9) monitor.
- **Channel look (`nr-look`)**, **Data (`nr-data`)**, **Graphics check (`nr-qc`)** and **News delivery (`nr-deliver`)**
  are described in 16.10 and 16.11.

**Quick keys:** add a name strap, ticker, breaking bar, layout, or a wipe at the nearest cut. nr-room picks free keys
after checking `keymap.ts` (N, B, T and L are taken by editing tools), and shows them in the shortcuts list.

**Find and replace** across every graphic's text.

**Full-window tools** (`events.ts`, mounted by `overlays.tsx`): `openDesigner({ template, clipId?, onSaved })` and
`openWipeDesigner()`.

**The Template Designer** (nr-designer):
- A layers list (add, delete, reorder, duplicate, hide, lock) and the 16:9 and 9:16 designs side by side.
- Move and resize on canvas with snapping to safe areas and to other layers.
- An inspector built from each kind's `props` (every property, "follow look" or custom), and per-layer in / out /
  loop animation with timing.
- A fields editor: add a blank, name it, link it to text, type, default.
- "Make vertical" builds 9:16 from 16:9 by pins.
- Preview playback with sample values and in every ready look.
- Save as a new template (`my.<uuid>`, into the edit and the library), lock, duplicate, export / import a `.tatvamgfx`
  file.

**The channel look editor** (nr-designer): ready looks, every colour and font, the logo (from the bin or a file), motion
and plates.
- **Make my look:** pick a logo; its main colours are found by k-means on the logo's pixels; choose a style; done.
- Save to the library and export / import `.tatvamlook`.

### 16.9 Desktop bridge (`window.tatvamDesktop.newsroom`, `main/newsroom/**`)

- `libraryList`, `libraryRead`, `libraryWrite`, `libraryDelete`, `exportFile` and `importFile` (nr-designer): one
  JSON file per look or template in `<library>\News\Looks` and `<library>\News\Templates`. Ids are checked: no path
  separators.
- `fetchText(url)` (nr-data): http / https only, private and loopback addresses refused, at most 10 MB, 20 s, no
  cookies.
- `readTextFile(path?)` (nr-data): an open dialog when no path is given.
- `exportGraphics(options)` (nr-delivery).

In the browser (no desktop) the library falls back to localStorage and data to `fetch` (CORS permitting).

### 16.10 Data, automation and checks (`feeds/**`, `auto/**`, `qc/**`)

**Data sources:**
- Kinds: CSV, JSON (with a root path), RSS / Atom, a published Google Sheet CSV link, or manual.
- **Refresh** freezes a `DataSnapshot` (rows, items, time) into the edit, so exports repeat. The panel shows
  "as of 19:42". `bind` links a graphic's field to a source and column.
- Mappers fill the weather, markets, score, election and rates templates from rows.

**Linking fields to data.** A linked field's path is one of:
- empty (the whole source);
- `"Column"`;
- `"Column#3"` (row 3);
- `"@markets"` (through a mapper);
- `"@ticker:Title"`.

**Automation:**
- **Speaker straps:** the transcript's speaker runs are matched to people (by their speaker label), and a strap is
  placed at each speaker change. Re-running replaces the earlier ones, never doubles them. One undo step.
- **AI-content labels:** while studio-made (AI) media is on screen, an "AI-generated" label strap is placed over it
  (`settings.aiLabel`), and QC warns when one is missing. The labels go on their own "AI label" track (a strap
  track just above Straps), so they never overwrite name straps.
- **Tagging:** graphics the tools place carry `values._auto = "speaker" | "ai-label"`, so a re-run replaces only its own
  graphics. Anything that walks all value keys skips keys starting with "_".
- **Where transcripts come from:** they live per media file in this browser (`panels/transcriptStore.ts`), not in the
  edit, so speaker straps work on the PC that made the transcript.

**Graphics check (QC):** each finding jumps to its frame and offers "Fix" where it can.
- text that doesn't fit (shrunk below 70 % or ellipsized);
- letters the font lacks (shown as empty boxes);
- outside the safe area;
- crawl too fast to read;
- holds shorter than their reading time;
- graphics covering each other;
- empty required fields;
- data older than a day.

### 16.11 Delivery (`delivery/**`, `main/newsroom/export.ts`)

**Exports:**
- **Both ratios:** export the 16:9 and 9:16 in one go (through the existing export, with the companion for 9:16).
- **Transparent graphics:** graphics tracks only on a transparent background, as ProRes 4444, WebM VP9 with alpha, or
  a PNG sequence. RGBA is read back from the GPU render.
- **Loops:** export a ticker or background as a seamless loop of a chosen length.
- **Language versions:** each graphic's `langs` values for one language.

**Batch and shorts:**
- **Batch from a spreadsheet:** one template plus CSV rows gives one video per row, named by a column.
- **News shorts maker:** one 9:16 short per rundown story. Each has a headline card, strap, captions (if a transcript
  exists) and a ticker, from the story's range.

**Presets and the reel:**
- **Look preview reel:** every graphic of a look with sample text, for a client.
- **TV presets:** EBU R128 −23 LUFS loudness and a broadcast-safe colour limiter (16–235), next to the web presets.

**How a news export runs:**
- `exportGraphics` checks the options, reads the saved edit and queues a render job. It returns at once with the job
  id and the planned path; the jobs list follows the render's progress.
- The GPU render window prepares the job (`delivery/window.ts`): the language values, the other ratio
  (`companionProject`) and graphics only. Alpha jobs draw with `Composition.transparent` and send RGBA to FFmpeg.
- Loops are cut on whole cycles: layer loops, backgrounds' periods and tickers' measured cycles
  (`tickers/period.ts crawlPeriod`).

### 16.12 Rules for the builders

**The shared rules of §14 apply.** In particular:
- additive model fields;
- `serialize.ts` round-trips everything (its test stays green);
- one undo step per user action;
- everything that draws goes through `buildComposition`, so export matches preview;
- `node --test` on pure modules, portable to Linux CI.

**Ownership:**
- Only touch files you own (16.1).
- When you need something from another owner's file, say so in your report; don't edit it.
- The lead merges and commits: **builders don't commit or push**.

**Placeholders and compiling:**
- Placeholders (marked PLACEHOLDER) keep their exported signatures. Their owner replaces the bodies.
- `tsc -b` must pass for your files. Errors in files you don't own aren't yours: report them.

**Imports and UI:**
- Imports inside pure modules end in `.ts` (Node runs them).
- Tests go in `frontend/src/editor/__tests__/newsroom-*.test.ts`, which `npm run test:editor` (and CI) runs.
- UI follows the editor's existing panel style (`pn`, `pn-empty`, editor.css tokens), in English, and is calm and
  uncluttered.

**Visual QA:**
- Templates and kinds are checked by eye in the dev lab (`/editor/gfx-lab`, nr-core): a template at a time, both
  ratios, scrubbable time, every ready look.
- Screenshots with headless Edge against the shared dev server the lead runs. Never port 8100, never the real database,
  never the user's Documents folder.
