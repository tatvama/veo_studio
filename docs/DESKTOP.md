# Tatvam Desktop: the finishing room

*Phase 9 of TATVAM_PLAN.md (section 16). Started 11 October 2026.*

The desktop app is for the one or two editors who finish a cut: 4K output, hardware encoding, local footage,
several windows across several screens, and cutting offline. It does **no AI work of its own**. Every AI button still
calls the server, through the same cost check and approvals. The web stays the studio for everyone else, and phones
stay the review layer.

## 1. Shape

| Part | What it is |
| --- | --- |
| Shell | **Electron 44** (Chromium 152, Node 24) around the same React frontend. We chose it over Tauri on 11 Oct 2026: no Rust or C++ toolchain is needed, the TypeScript render engine can pipe frames straight into FFmpeg, and the bigger installer doesn't matter on an editing PC |
| `desktop/` | The Electron app: main process, preload bridge and a local gateway, all in TypeScript and bundled with esbuild |
| Local gateway | An HTTP server on `127.0.0.1:<port>` (default 18100). It serves the UI, forwards `/api`, `/media` and the WebSocket to the studio server, serves media from the local project folder when that file is there, and queues cut edits while offline |
| Server additions | Checkout locks, cut versions, the desktop manifest, the render plan, chunked render upload, the AI upscale step and review notes per episode (`backend/app/api/desktop.py`, `backend/app/core/desktop.py`) |
| Frontend additions | The **Finishing room** page inside step 4 Edit, pop-out panel routes (`/desktop/panel/...`), a read-only cut while someone else has it checked out, and a cross-window playhead bus |

Because the UI is served from the gateway's own origin, the frontend keeps relative `/api` and `/media` URLs and
the server needs no CORS change. The session cookie lives on `127.0.0.1`. The gateway strips `Domain` and `Secure`
from `Set-Cookie`, and passes the cookie on to the server.

Google sign-in works too. The app opens `<server>/api/auth/google/start` in its own window, waits for the redirect
back to the server, copies the `veo_session` cookie onto the gateway origin, and reloads.

## 2. Server API (all under `/api`, cookie auth, writes need `X-Requested-With: veo-studio`)

### 2.1 Checkout lock (one editor per cut)

The table is `cut_locks`: `episode_id` (unique), `user_id`, `client` ("desktop" | "web"), `machine`, `acquired_at`
and `heartbeat_at`. It lives in Postgres, so it survives restarts. A lock **does not expire on its own**: an editor
can keep it through a long offline stretch. A producer or admin can force-release it. The desktop app releases the
cuts it still holds when it quits (`main/locks.ts`: the gateway notes every checkout, heartbeat, check-in and release
it forwards; on quit each held lock is read back and `DELETE`d only if it is still ours and from this machine, best
effort within 2.5 s). Closing the web page does not release a lock: there the heartbeat age shows how stale it is.

| Method & path | Body | Result |
| --- | --- | --- |
| `GET /episodes/{eid}/checkout` | – | `{lock: null \| {episode_id, user: {id,name,email,role}, client, machine, acquired_at, heartbeat_at, mine: bool}}` |
| `POST /episodes/{eid}/checkout` | `{client?: "desktop", machine?: str, force?: bool}` | 200 `{lock}`. 423 `{detail}` when another user holds it. `force` needs producer and records an audit entry |
| `POST /episodes/{eid}/checkout/heartbeat` | – | 200 `{lock}`. 409 if you no longer hold it |
| `POST /episodes/{eid}/checkin` | `{note?: str}` | Saves a cut version (§2.2), releases the lock, returns `{version: <version object>}` |
| `DELETE /episodes/{eid}/checkout` | – | Releases the lock without saving a version (the holder, or a producer; audited as `cut.checkout.release`). Returns `{lock: null}` |

**Enforcement.** While user A holds the lock, these cut edits by anyone else return **423**
`"Checked out by <name> on <client> — the cut is read-only until they check in"`:

- shot reorder
- `PATCH /shots/{sid}` when it touches `trim_in`, `trim_out`, `include` or `order`
- `PUT /shots/{sid}/fx`
- `POST /episodes/{eid}/fx/apply`
- `PUT /shots/{sid}/overlays`
- `PUT /episodes/{eid}/layers`
- `PATCH /episodes/{eid}` when it touches `settings`
- selecting music for that episode
- `DELETE /shots/{sid}`, `POST /shots/{sid}/undo` (when the undo changes cut fields), `PUT /episodes/{eid}/board`
  (when it moves or drops shots in the cut; new shots at the end are fine) and the Director's `update_shot` include
  change

A `PATCH` that sends a cut field with its current value passes: only real changes are refused. A forced checkout
is audited as `cut.checkout.force`.

Generation, take selection and approvals stay open, so phones and the web keep the pipeline moving. Each change
emits `episode.updated {what: "checkout"}`. Presence reports the desktop editor as `editing: "cut:<eid>"`.

### 2.2 Cut versions (check-in history with rollback)

The table is `cut_versions`: `episode_id`, `number` (1..n per episode), `note`, `snapshot` JSON, `stats` JSON,
`client`, `created_by`, `created_at` and `restored_from` (the version **number** it brought back, nullable).

The snapshot holds:
- `shots`: `[{id, order, include, trim_in, trim_out, fx, overlays, sfx_track, selected: {"video": take_id, "lipsync:kn": take_id, ...}}]`.
  `selected` holds the *current* take of every kind (and language), picked by hand or not, so a restore brings back
  exactly the clips that were in the cut
- `settings`: the episode settings
- `layers`: the layers document without `rev`
- `music_id`: the selected music `AudioAsset` id, or null

| Method & path | Result |
| --- | --- |
| `GET /episodes/{eid}/versions` | `[{id, number, note, client, created_by: user_brief, created_at, restored_from, stats: {shots, included, duration_s}}]`, newest first |
| `POST /episodes/{eid}/versions` `{note}` | Saves a version now (the lock holder, or anyone when the cut isn't checked out) |
| `GET /versions/{vid}` | The full row with its snapshot |
| `POST /versions/{vid}/restore` | First saves the current cut as a version ("Before restoring vN"), then writes the snapshot back. Shots that no longer exist are skipped; shots added since are kept after the restored ones; layers keep the current `rev + 1` and their media library is merged; `music_id` null unselects all music. Then it saves "Restored vN" with `restored_from` and returns that version. 423 if someone else holds the lock |

### 2.3 Desktop manifest (what the local folder should contain)

`GET /projects/{pid}/desktop/manifest?scope=approved|cut&episode_id=`

- **approved** (the default) lists the current takes of shots whose status is approved, plus every take selected
  by hand. It also lists the selected music, approved renders, and the approved Bible stills of characters,
  locations and props.
- **cut** lists every current take of every shot that is included in the cut. Editors use this to start before
  approval.

```json
{
  "project": {"id": 1, "title": "Kaali", "aspect": "9:16", "languages": ["kn","en"], "primary_language": "kn"},
  "generated_at": "2026-10-11T10:00:00Z",
  "episodes": [{"id": 3, "number": 2, "season": 1, "title": "…", "cut_version": 4,
                "scenes": [{"id": 9, "order": 1, "title": "…"}],
                "shots": [{"id": 41, "code": "E02-SH03", "order": 3, "cut_index": 3, "include": true,
                           "scene_id": 9, "scene_order": 1, "status": "approved", "duration_s": 6}]}],
  "items": [{
    "key": "projects/1/shots/41/video/ab12cd34ef56.mp4",
    "url": "/media/projects/1/shots/41/video/ab12cd34ef56.mp4",
    "folder": "Takes",
    "kind": "video",
    "role": "take",
    "episode_id": 3, "scene_id": 9, "shot_id": 41, "take_id": 77, "language": null,
    "series": {"season": 1, "episode": 2, "scene": 1, "shot": 3, "cut": 3, "take": 2, "version": 2, "code": "E02-SH03"},
    "approved": true, "selected": true,
    "duration_s": 6.0, "updated_at": "2026-10-10T12:00:00Z",
    "ext": "mp4", "label": "Video take 2"
  }]
}
```

The `folder` values are: `Takes` (video, keyframe, lipsync, voicelock, upscale), `Audio/Voice` (voice, narration),
`Audio/Music`, `Audio/SFX`, `Captions` (export .srt), `Renders` (exports), `Bible/Characters`, `Bible/Locations`,
`Bible/Props`, `Imports` (layer media that came from desktop imports) and `Media` (other layer media).

As built, the manifest also has a top-level `scope`, episodes carry `kind`, and items may carry `asset_id`,
`export_id`, `preset`, `character_id` / `location_id` / `prop_id` and `media_kind`. `role` is one of take, sfx,
music, render, captions, bible, import, media. Missing series numbers are 0; `cut_index` and `scene_order` are null
for shots outside the cut. Lip-sync, voice-lock and upscale takes made from an older video are left out.

Within the series, `take` is the take's number among the shot's takes of the same kind and language, counted in
creation order from 1. `version` is the same number for takes, and the render version for exports.

### 2.4 Render plan (the desktop renders exactly what the server would)

`GET /episodes/{eid}/render-plan?lang=kn&w=3840&h=2160&fps=24&effects=1&captions=1&music=1&upscaled=1`

The plan reuses `assembler.plan()` and the same timing maths as `assembler.render()`. It returns ready-made filter
strings for the requested size. LUT files are written as `@@LUT_<id>@@` (no colon, so FFmpeg escaping leaves it alone), and the desktop swaps in an escaped local
path. Every media reference is a storage **key**, and the desktop turns keys into local files, downloading any that
are missing.

```json
{
  "episode_id": 3, "lang": "kn", "w": 3840, "h": 2160, "fps": 24, "cut_version": 4,
  "fingerprint": "sha1 of the cut", "warnings": ["…"],
  "segments": [{
    "shot_id": 41, "code": "E02-SH03", "source": "projects/1/shots/41/video/ab.mp4", "source_kind": "video",
    "upscaled": false, "duration": 5.5, "trim_in": 0.2, "speed": 1.0, "seg_len": 5.5,
    "audio_override": null, "extra_audio": [{"key": "…", "offset": 0.0, "gain_db": 0}],
    "keep_src_audio": true, "src_gain_db": 0, "has_audio": true,
    "pre": "reverse,setpts=(PTS-STARTPTS)/1.5,", "stabilize": false, "center": [0.5, 0.42],
    "kenburns": true, "vf_post": "hflip,eq=contrast=1.12,format=yuv420p", "af_fx": "afade=t=in:st=0:d=0.5",
    "transition": ["fade", 0.5]
  }],
  "end_card": {"key": "projects/1/desktop/endcard_3_3840x2160.png", "seconds": 3, "transition": ["fade", 0.4]},
  "layers": {
    "pics": [{"key": "…", "kind": "video", "start": 1, "in": 0, "dur": 3, "chain": ["setpts=…"], "x": "main_w*0.5-overlay_w/2", "y": "…"}],
    "sounds": [{"key": "…", "start": 1, "in": 0, "dur": 3, "gain_db": 0, "fade_in": 0, "fade_out": 0}]
  },
  "music": {"key": "…", "volume_db": -16, "duck": true},
  "captions": {"srt": "1\n00:00:00,200 --> …", "ass": "[Script Info]…", "burn": true},
  "luts": {"3": "projects/1/luts/3.cube"},
  "loudnorm": "loudnorm=I=-14:TP=-1.5:LRA=11",
  "keys": ["every storage key above, de-duplicated"]
}
```

As built, the plan also carries `project_id`, `generated_at`, `duration_s`, `options {effects, captions, music,
upscaled}` and `stabilize_filters {detect, transform}` with a `@@TRF@@` placeholder (the desktop runs the detect pass
itself when `segment.stabilize` is true; `pre` never stabilises). Each segment has `start` (its time on the finished
cut) and **`vf`, the complete video chain**, which the desktop uses as is (adding `flags=lanczos`, and `unsharp`
for local upscale, at 2160p and up). The end card has `vf` too, captions carry `style` and `font`, `luts` lists only
the LUTs in use, and `music` is null when there is none. Without `w`/`h` the size is the project aspect at a 1080
short side; `fps` is clamped to 1..120. The server render and the plan share `timeline()`, `render_options()`,
`music_track()`, `caption_files()` and the FFmpeg chain helpers, so they can't drift apart.

`upscaled=1` makes the plan use a ready `upscale` take (§2.6) of the current video whenever one exists and isn't
stale. `segment.upscaled` says whether that happened.

### 2.5 Render upload (to the Render Center)

The upload is chunked, so a 4K master survives a flaky connection.

| Method & path | Body | Result |
| --- | --- | --- |
| `POST /episodes/{eid}/renders/uploads` | `{filename, size, language, preset, w, h, fps, codec, encoder, cut_version, duration_s, machine}` | `{upload_id, chunk_size}` (8 MB) |
| `PUT /renders/uploads/{uid}?offset=N` | raw bytes (`application/octet-stream`) | `{received}`. 409 with `{received}` if the offset is wrong, so the client resumes from there |
| `GET /renders/uploads/{uid}` | – | `{received, size}` |
| `POST /renders/uploads/{uid}/complete` | `{srt?: str}` | Creates the `Export` row: `kind="final"`, `preset="desktop:<preset>"`, `status="ready"`, `version` = the next number for the episode, `options = {source:"desktop", w, h, fps, codec, encoder, cut_version, machine}`. Saves the file as `projects/{pid}/exports/e{NN}_{lang}_{preset}_v{version}_{id}.mp4`, adds a thumbnail and peaks, emits `export.updated`, and returns `export_out` |

Init may also send the plan's `fingerprint`. Over the size cap returns 413, a chunk past the declared size 400, and
a wrong offset or an early complete 409 `{detail, received}`. The status call returns `{upload_id, received, size}`.
The desktop resumes at the `received` a 409 names, but gives up after 5 consecutive 409s at the same byte ("upload
stuck"), so a server that never takes the chunk it asks for can't keep it looping.
The file keeps a `.mov` / `.mkv` / `.webm` extension from `filename` (ProRes masters), else `.mp4`. Unfinished
uploads older than a week are cleared.

`Export.version` is a new nullable integer column. Server renders get one too, from the same per-episode counter.
The team setting `desktop_upload_max_mb` (default 8000) caps the size.

### 2.6 AI upscale step (in the cloud, or free on the editor's PC)

- `POST /episodes/{eid}/upscale/estimate` `{shot_ids?: [...], target_h?: 2160}` returns
  `{items: [{shot_id, code, take_id, from: [w,h], to: [w,h], seconds, usd}], total_usd, skipped: [...]}`.
  Shots whose current video already meets the target, or that already have an upscale that isn't stale, are skipped.
- `POST /episodes/{eid}/upscale` takes the same body. It submits `upscale` jobs through `jobs.submit`, so it gets
  the same estimate, budget and approval path as every paid step. The result has the usual
  `{batch_id, status, total_usd, ...}` shape.
- Worker `upscale` sends the video through fal (team setting `upscale_fal_endpoint`, default
  `fal-ai/topaz/upscale/video` with model Proteus, `upscale_factor` = target / source, `H264_output: true`). It
  stores the result as `Take(kind="upscale", parent_take_id=<video take>, params={w, h, factor, endpoint})` and
  records the cost (team setting `upscale_price_per_s`, default 0.08). With mock providers it uses an FFmpeg
  Lanczos scale and costs nothing.
- An upscale is **stale** once its parent is no longer the shot's current video.
- As built, `target_h` (360..4320) is the clip's **short side** and the factor is capped at 4×. Estimate items also
  carry `factor`; skipped entries are `{shot_id, code, reason}`. Submit returns the `jobs.submit` shape plus `items`
  and `not_upscaled`. A fal result without sound gets the source audio added back. Estimate items also carry the
  source take's `key` and `url`, so a desktop can upscale it itself.
- **On the editor's PC (free):** `POST /takes/{tid}/upscales` (multipart: `file`, `model`, `machine`, `seconds`)
  stores a clip that Tatvam Desktop upscaled on its own graphics card as `Take(kind="upscale", provider="local",
  model="realesrgan:<model>", parent_take_id=tid, cost_usd=0)` and selects it. It must be larger than the video with
  the same shape (else 400), within `desktop_upload_max_mb` (else 413). From then on it is an upscale like any other:
  the render plan uses it with `upscaled=1`, the manifest lists it in `Takes/`, a newer video makes it stale.

### 2.7 Review notes for the desktop timeline

`GET /episodes/{eid}/review-notes` returns
`[{id, export_id, export_version, cut_version, timecode, body, drawing, author, guest_name, resolved, created_at, maps_to_cut: bool}]`
for comments on this episode's renders, newest render first, then by timecode. `maps_to_cut` is true when the
render was made from the current cut (its recorded `fingerprint`, else its `cut_version`), which means its timecodes
land on the timeline as they are. Server renders now record `options.cut_version` and `options.fingerprint` too.

## 3. Local project folder

- The **library root** is chosen by the user (a folder picker). The default is `Documents\Tatvam Projects`.
- Any project can be **moved** to its own folder: Finishing room → Local folder → This project → "Change…" moves
  the files (copy and delete across drives) and updates the mirror. "Open" shows it in Explorer.
- The default project folder name is `<Project title> (#<id>)`. It contains:

```
Takes/ Audio/Voice/ Audio/Music/ Audio/SFX/ Captions/ Imports/ Proxies/ Renders/ Cache/
Bible/Characters/ Bible/Locations/ Bible/Props/ Media/ Edits/
project.tatvam.json          ← human-readable project file (ids, server, naming, last sync)
.tatvam/mirror.sqlite        ← the SQLite mirror (node:sqlite)
```

- Premiere and DaVinci can read the folder: `Edits/` holds a CMX3600 EDL and an FCPXML of the current cut, both
  pointing at the series-named local files.
- `Cache` and `Proxies` can be thrown away. Files in `Renders` are cleaned only after they have uploaded, and files
  in `Imports` only after they have been ingested.

### 3.1 Series file naming (names follow the cut)

Every file gets its name from a template. Tokens are `{name}` or `{name:03}`, where the number zero-pads to that
many digits.

| Token | Meaning |
| --- | --- |
| `{project}` | Project title, made safe for a file name |
| `{season}` `{episode}` | Season and episode numbers |
| `{scene}` | Scene order (1-based) |
| `{shot}` | Shot order in the episode |
| `{cut}` | Position among the included shots, so the folder sorts in playback order |
| `{code}` | The shot code, e.g. E02-SH03 |
| `{kind}` | video, keyframe, lipsync, voice, music, render … |
| `{lang}` | Language code, empty when there is none |
| `{take}` `{version}` | Take number, or render version |
| `{preset}` | The render preset |
| `{date}` | YYYYMMDD |
| `{seq}` | The running number inside its folder |
| `{id}` | The take, asset or export id |
| `{label}` | A short label |

Default templates:

| Folder | Template |
| --- | --- |
| Takes | `{project}_S{season:02}E{episode:02}_{cut:03}_SC{scene:02}_SH{shot:03}_{kind}{_lang}_T{take:02}` |
| Audio | `{project}_S{season:02}E{episode:02}_{cut:03}_SH{shot:03}_{kind}{_lang}_T{take:02}` |
| Music | `{project}_S{season:02}E{episode:02}_music_{seq:02}` |
| Renders | `{project}_S{season:02}E{episode:02}_{lang}_{preset}_v{version:03}` |
| Captions | `{project}_S{season:02}E{episode:02}_{lang}_v{version:03}` |
| Bible | `{project}_{kind}_{label}_{seq:02}` |
| Imports | `IMP_{seq:04}_{label}` |

`{_lang}` is shorthand for "an underscore plus the value, or nothing when it is empty", and it works for any
token.

Names are made safe for Windows: no `<>:"/\|?*`, no reserved names (CON, NUL …), and a whole path under 240
characters. Two files that end up with the same name get `_2`, `_3` and so on.

**Kept in series.** After every sync the mirror works out the name each file should have. When shots are reordered,
a take is re-picked or a scene moves, it renames in two phases (first to temporary names, then to the final names),
so the folder always lists in cut order. The rename plan can be previewed before it runs (Finishing room → File
names → Rename plan, then "Rename now"). Tested live on 11 Oct 2026: moving the last shot to the front renamed
three takes (`…_001_SC02_SH001…`, `…_002_SC01_SH002…`, `…_003_SC01_SH003…`) and rewrote the EDL.

## 4. Desktop app internals (`desktop/src`)

| Module | Job |
| --- | --- |
| `main/index.ts` | Lifecycle, single instance, the `tatvam://` deep link, wiring |
| `main/config.ts` | `settings.json` in userData: `serverUrl`, `gatewayPort`, `uiSource` ("bundled", the default, or the opt-in "auto" / "server", §4.3), `appearance`, `assistants`, `lutFolders`, `editorBackups`, `libraryRoot`, `projectFolders {pid: path}`, `naming {folder: template}`, `pullScope`, `proxyMode`, `encoder` preferences (`prefer`, `hevc10bit`, `intermediateCq`, `hwDecode` on by default, `gpuSlots` default 2), `workspaces`, `windowState` |
| `main/gateway.ts` | The local HTTP gateway (§1): static UI with SPA fallback; `/api` and `/media` forwarded with streaming and Range; WebSocket upgrade forwarded; local-first `/media` (with a proxy file in proxy mode); offline cache and write queue |
| `main/upstream.ts` | Server calls from the main process (session cookie and `X-Requested-With` added), plus the WebSocket listener that triggers re-syncs |
| `main/library.ts` | Library root, project folders, folder skeleton, move, open, disk usage, clean |
| `main/naming.ts` | Template engine, safe names, the series rename plan (pure functions with unit tests) |
| `main/mirror.ts` | SQLite mirror: `projects`, `episodes`, `shots`, `files(key, local_path, name, size, state, synced_at)`, `queue`, `api_cache` |
| `main/sync.ts` | Manifest → download queue (3 at a time, resumable `.part` files, checked sizes) → series names → cleanup; progress events |
| `main/watch.ts` | Watches the `Imports` folder; a file whose size has held steady is uploaded to `POST /episodes/{eid}/media` and marked ingested |
| `main/ffmpeg.ts` | Finds FFmpeg (the path set in the Studio server window, `TATVAM_FFMPEG`, the bundled `resources/ffmpeg.exe`, then `ffmpeg-static` / the system one / the backend's imageio copy in dev, preferring 7.x: 6.1 lacks vidstab and some xfade transitions), probes the encoders, test-encodes on NVENC, QSV and AMF, and runs the machine check |
| `main/proxies.ts` | 1080p proxies, made on NVENC when it is available, decoded on the card, one GPU slot each |
| `main/gpu-gate.ts` | **The GPU gate**: one process-wide semaphore (`encoder.gpuSlots`, default 2, `TATVAM_GPU_SLOTS`) that every encoder and GPU tool takes a slot from: render steps and the GPU frame pass, proxies (library and editor), the local upscaler, RIFE and CUDA Whisper. Consumer GeForce cards allow only a few NVENC sessions at once |
| `main/aiupscale.ts` | **AI upscale on this PC** (§4.2): installs the pinned Real-ESRGAN build on demand, picks the Vulkan GPU, and runs frames out → Real-ESRGAN → HEVC back with the original sound → upload as the shot's upscale take |
| `main/render-args.ts` | Pure FFmpeg argument builders for every render step, checked in tests against the arguments the server's `ffmpeg.py` / `layers.py` build |
| `main/render.ts` | Runs a render plan locally at 4K with hardware encoding (the segments side by side, as many as the GPU gate has slots, in the plan's order), reports progress and ETA, stops a step that makes no progress for 10 minutes, can cancel, writes into `Renders/` |
| `main/upload.ts` | Chunked, resumable render upload |
| `main/edl.ts`, `main/edits.ts` | Write a CMX3600 EDL (dissolves, M2 speed lines) and an FCPXML 1.10 of the cut into `Edits/` |
| `main/offline.ts` | Pure logic of the offline cache and write queue (which writes queue, how they patch the cached GETs, replay order) |
| `main/download.ts` | Resumable `.part` downloads with Range |
| `main/signin.ts` | Google sign-in window that copies the session cookie onto the gateway origin |
| `main/connect.ts` | The native **Studio server** window (File → Studio server…): server address with a live test, interface source, FFmpeg path |
| `main/ipc.ts` | The bridge's main-process side; every call checks the sender frame is on the gateway origin |
| `main/smoke.ts` | `npm run smoke`: UI, sign-in, API, WebSocket, bridge, a pop-out and the machine check, one JSON status line |
| `main/windows.ts` | The main window, pop-out panels, the display list, move to display, clean full-screen feed, workspaces, saved window state |
| `main/menu.ts` | The application menu and its shortcuts |
| `main/updater.ts` | `electron-updater` on the GitHub Releases of the public, releases-only repository [tatvama/tatvam-desktop-releases](https://github.com/tatvama/tatvam-desktop-releases), used only when the app is packaged |
| `main/log.ts` | A rolling log file in `userData/logs`, plus local crash dumps |
| `main/uicache.ts` | **Screens from the server** (§4.3): manifest check, sha256-verified downloads, atomic build swap, offline copy |
| `main/notify.ts`, `main/taskbar.ts`, `main/tray.ts`, `main/shell*.ts` | Native toasts and the notification centre, taskbar progress / overlay / thumbnail buttons / Jump List, the tray, appearance (Mica, accent, theme, scale), Start, Settings, onboarding, splash and crash recovery |
| `main/tools.ts` | Installs the PC's own tools on demand, each pinned by SHA-256: Real-ESRGAN, RIFE, whisper.cpp (CPU and CUDA 12.4) and its models |
| `main/editor*.ts` | Tatvam Editor's side (docs/EDITOR.md §5): projects, media, analysis, the audio export graph and effects (`editor-audio.ts`, `editor-audiofx.ts`, `editor-irs.ts`), Whisper, RIFE, sync, jobs, versions, interchange (`editor-interop.ts`) |
| `main/mcp/**`, `main/autowatch.ts` | The local MCP server for AI assistants, the `--mcp-stdio` relay, and watch folders (docs/EDITOR.md §13) |
| `preload/index.ts` | `window.tatvamDesktop`, the typed bridge (§5) |
| `preload/connect.ts` | `window.tatvamConnect`, only in the Studio server window |

**What the web UI may change.** `settings.set` from a page accepts only `naming`, `pullScope`, `proxyMode`,
`encoder` and `autoSync` (`RENDERER_SETTINGS`). The server address, interface source and FFmpeg path decide where
the session cookie goes and which program runs, so only the native Studio server window changes them (its IPC
answers that window alone); folders change only through native folder dialogs. The gateway serves local media only
to requests that carry the app's own session cookie and rejects unexpected `Host` headers (DNS rebinding).

**Trust boundaries (tightened 15 October 2026).**
- **A public server address must be https**: `normalizeServerUrl` accepts plain `http://` only on this PC
  (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) or on the local network (`10/8`, `172.16/12`, `192.168/16`,
  `fc00::/7`, `*.local`), the same rule `uicache.originRule` applies to screens; a bare host name becomes `https://…`;
  an explicit `http://` to a public address is refused with the reason (shown by the Studio server window). A stored
  or `TATVAM_SERVER` address that breaks the rule falls back to `http://localhost:8100`. Every call carries the
  session cookie and, when chosen, the server's screens run inside the app, so a server reached over the internet
  needs a certificate.
- **Screens from the server are opt-in.** `uiSource` defaults to `"bundled"`; "From the server, with an offline copy"
  (`auto`) and "Always live from the server" (`server`) are labelled as running the server's own code and are chosen
  in the Studio server window only (a settings file with an unchosen `auto` / `server` moves back to `bundled`). The
  manifest's sha256 check and the origin rule of §4.3 still apply when they are chosen.
- **A page imports only what the user handed over.** `editor.importMedia` from the bridge takes paths that came back
  from a native file dialog, were dropped from Explorer (the preload registers a drop's real paths with the main
  process before the page sees them, `IPC.editorGrantPaths`), sit in a folder the user chose or dropped (`shell.dropped`,
  `assistants.chooseFolder`, the assistants' folders, watch folders, the library), lie inside the edit's own folder,
  or already belong to an edit. Any other absolute path a page names is refused ("wasn't chosen in a file dialog or
  dropped from Explorer"). In-process callers (the MCP server after its own folder checks, interchange imports) are
  not gated.
- **Deep links ask first.** `tatvam://editor?path=…` allow-lists the edit straight away only inside the library's
  `Edits/` folder; for any other `.tatvamedit` a native dialog ("Open this edit?", with the full path) must be
  accepted first, because opening an edit lets the editor read and serve every media file it lists.
- **One path rule.** `main/paths.ts` `isInside(dir, file)` (the folder itself or below it, case-insensitive, either
  slash; a sibling folder sharing the prefix is outside) is the only confinement check: the editor's allow-list,
  `library.open`, the renders clean-up and the MCP server's `inside` all use it.

### 4.1 Encoder presets

| id | Label | Size (16:9, swapped for 9:16) | Video | Notes |
| --- | --- | --- | --- | --- |
| `yt4k` | YouTube 4K | 3840×2160 | HEVC 10-bit, CQ 19 | NVENC → QSV → AMF → x265 |
| `yt4k_h264` | YouTube 4K (H.264) | 3840×2160 | H.264 8-bit, CQ 18 | |
| `social4k` | Shorts / Reels 4K | 2160×3840 | HEVC 8-bit | |
| `yt2k` | YouTube 2K | 2560×1440 | HEVC 8-bit, CQ 19 | Swapped for 9:16 projects |
| `social2k` | Shorts / Reels 2K | 1440×2560 | HEVC 8-bit, CQ 20 | Always vertical |
| `master_prores` | Master ProRes 422 HQ | 3840×2160 | prores_ks profile 3, yuv422p10le, .mov | Software encoder |
| `broadcast1080` | Broadcast 1080p25 | 1920×1080 at 25 fps | H.264 high, 50 Mb/s CBR, AAC 48 kHz | |
| `review1080` | Review 1080p (fast) | 1920×1080 | H.264 CQ 23 | |
| `av1_4k` | AV1 4K (archive) | 3840×2160 | AV1 NVENC, only where supported (RTX 40 and up) | Hidden when the probe fails |

- Intermediate segments use the fastest hardware H.264 encoder at CQ 16 (NVENC on its quickest preset `p2`: they are
  thrown away after the join), falling back to x264 veryfast at CRF 16. The segments of a plan are independent, so they
  encode side by side (`pool`, as many at once as the GPU gate has slots) and are joined in order; one failure stops the rest.
- **Hardware decode** (`encoder.hwDecode`, default on): when the probe found NVENC, every source clip of a segment or
  proxy is opened with `-hwaccel cuda` (`-hwaccel d3d11va` on Windows when only Quick Sync / AMF work). Without
  `-hwaccel_output_format` the frames come back to system memory, so the CPU filter graphs (scale, crop, vidstab, LUTs,
  xfade) are unchanged: the decode is the win. If a hardware-decoded encode fails, the step is retried on the CPU, the
  job gets a warning and the rest of that job decodes in software.
- **The GPU gate** (`main/gpu-gate.ts`): renders, proxies, the local upscaler and the editor's GPU tools each take one
  slot (`encoder.gpuSlots`, default 2) before touching the card, so a render, an auto proxy and a slow-motion job can't
  open more NVENC sessions than a GeForce allows. A render step with no FFmpeg progress for 10 minutes, or a GPU frame
  the encoder doesn't take for 10 minutes, is killed and the job fails with that reason.
- At 1440p and above (2K and 4K), scaling uses `flags=lanczos`. When a shot has no AI upscale, "Local upscale" adds a
  light `unsharp`.
- The hardware baseline is an RTX 3060, 32 GB of RAM and an NVMe SSD. The machine check compares this PC with it.

### 4.2 AI upscale on this PC (Real-ESRGAN)

Finishing room → AI upscale → **This PC · free** (the cloud Topaz route stays as **Cloud · paid**).

- **Engine:** Real-ESRGAN ncnn-vulkan v0.2.5.0 (github.com/xinntao/Real-ESRGAN, BSD-3), installed once on demand into
  `userData/tools/` with the **Install** button: `realesrgan-ncnn-vulkan-20220424-windows.zip`, 45,474,481 bytes,
  SHA-256 `abc02804…802d`, checked before it is unpacked with Windows' `tar.exe`. Vulkan, so NVIDIA, AMD and Intel
  cards all work; the dedicated card is picked over built-in graphics. Windows only for now.
- **Models:** **Fast** = `realesr-animevideov3` (×2/×3/×4, made for video, little flicker), the default; **Best detail**
  = `realesrgan-x4plus` (×4 only: the most natural texture, far slower).
- **Steps per shot:** PNG frames out (FFmpeg) → Real-ESRGAN to JPEG frames on the GPU → back to HEVC at CQ 17 on the
  hardware encoder at the exact target size (Lanczos), converted from the frames' full-range BT.601 to limited-range
  BT.709 like the AI clips (left as JPEG levels it rendered about 4 levels brighter), original sound copied → upload
  (`POST /takes/{tid}/upscales`) → the file moves into `Takes/` and the next sync gives it its series name.
- **Measured on the reference laptop (GTX 1660 Ti), 11 Oct 2026:** Fast, 1080p → 4K: 1.3–1.5 frames a second, a
  6-second shot (144 frames) in 100–105 s; x4plus: about 20 s a frame (a 6-second shot ≈ 48 min). The estimate starts
  from these numbers and then uses what this PC actually managed (`upscale-speed.json`, output megapixels a second).
- Compared on a 1080p still at 4K: plain Lanczos is soft, the video model gives clearly sharper edges and texture
  (a little crisp), x4plus the most natural detail.

### 4.3 Screens from the server, with an offline copy (added 12 October 2026)

`uiSource` gains **`"auto"`**. Since 15 October it is **opt-in**: the default is `"bundled"` (the copy inside the app),
and `"auto"` or `"server"` are chosen in File → Studio server…, which says plainly that they run the server's own
code inside the app. A settings file with an unchosen `"auto"` / `"server"` (no `uiSourceChosen`) moves back to
`"bundled"`.

**Picking the screens.** In `auto`, the gateway serves the UI from, in this order:
1. **The server's build**, if it's reachable, allowed and compatible.
2. **The last good copy of that server's build**, saved on this PC.
3. **The copy inside the app.**

Every build is served from disk (`userData/ui-cache/<server-hash>/<build>/`), so an `index.html` and its `assets/`
always come from the same build.

**Server manifest.** `GET /api/ui/manifest` (no sign-in needed) returns:
- `build`: the sha256 of `index.html`, 12 hex characters.
- `version`: the app version.
- `built_at`.
- `requires_desktop`: the lowest desktop app version the screens need, from `frontend/package.json` →
  `tatvam.requiresDesktop`.
- `files`: `[{path, size, sha256}]`.

The server computes it once from `frontend/dist` and caches it until `index.html` changes.

**Fetching a new build.**
- When: at start, every 10 minutes, and whenever the connection comes back.
- How: the desktop compares `build` with its active copy, downloads only the files it doesn't already have (it
  checks every sha256), and builds the new folder under a temporary name before renaming it into place. It keeps the
  last 2 builds per server.
- It never fetches from a different origin than `serverUrl`. It only fetches over HTTPS, or from loopback or a
  private-network address (10/8, 172.16/12, 192.168/16, fc00::/7, `*.local`). Anything else stays on the copy
  inside the app, and the Studio server window says why.
- If `requires_desktop` is newer than the app, it keeps the current copy and shows "Update Tatvam Desktop to get the
  newest screens".

**Switching builds.** Never in the middle of work. When a new build is ready, every window shows the toast "New
screens are ready" with **Reload** and **Later**. The editor saves first, and windows with unsaved work ask before
reloading. Windows opened after that use the new build.

**Status.** The Studio server window, Help → About and the status bar show which screens are running ("Server build
3f2a9c, 12 Oct", "Offline copy of server build 3f2a9c" or "Built into the app 3.1.0"), plus the last check and any
error. The bridge has `app.uiStatus()` and `app.onUiStatus(cb)`.

## 5. Bridge: `window.tatvamDesktop` (preload)

```ts
interface TatvamDesktop {
  version: string; platform: string;
  info(): Promise<{ appVersion; serverUrl; gatewayUrl; libraryRoot; uiSource; packaged: boolean; machine?: string }>;
  settings: { get(): Promise<DesktopSettings>; set(patch: Partial<DesktopSettings>): Promise<DesktopSettings> };
  library: {
    chooseRoot(): Promise<string | null>;
    projectFolder(pid: number): Promise<{ path: string; exists: boolean; custom: boolean }>;
    chooseProjectFolder(pid: number): Promise<string | null>;   // pick + move existing files
    open(pid: number, sub?: string): Promise<void>;
    usage(pid: number): Promise<{ folders: Record<string, { files: number; bytes: number }>; freeBytes: number }>;
    clean(pid: number, what: ("cache" | "proxies" | "renders")[]): Promise<{ removedBytes: number }>;
  };
  naming: {
    get(): Promise<Record<string, string>>; set(t: Record<string, string>): Promise<void>;
    preview(pid: number): Promise<{ from: string; to: string }[]>;   // rename plan
    tokens(): Promise<{ token: string; help: string }[]>;
  };
  sync: {
    start(pid: number, opts?: { scope?: "approved" | "cut"; episodeId?: number }): Promise<void>;
    stop(pid: number): Promise<void>;
    status(pid: number): Promise<SyncStatus>;
    onProgress(cb: (s: SyncStatus) => void): () => void;
  };
  imports: { status(pid: number): Promise<{ watching: boolean; pending: number; ingested: number; failed: string[] }>;
             setWatching(pid: number, eid: number, on: boolean): Promise<void> };
  media: { machineCheck(): Promise<MachineReport>; proxies(pid: number, on: boolean): Promise<void>;
           proxyMode(on: boolean): Promise<void>; proxyStatus(pid); onProxyProgress(cb) };
  render: {
    presets(): Promise<RenderPreset[]>;
    start(job: { pid: number; eid: number; lang: string; preset: string; effects?: boolean; captions?: boolean;
                 music?: boolean; upscaled?: boolean; localUpscale?: boolean; upload?: boolean }): Promise<string>;
    cancel(id: string): Promise<void>;
    list(): Promise<RenderJob[]>;
    onProgress(cb: (j: RenderJob) => void): () => void;
    reveal(id: string): Promise<void>;
    upload(id: string): Promise<void>;
  };
  edl: { write(pid: number, eid: number, lang: string): Promise<{ edl: string; fcpxml: string }> };
  windows: {
    displays(): Promise<{ id: number; label: string; bounds; primary: boolean; scaleFactor: number }[]>;
    popOut(panel: PanelId, opts?: { pid?: number; eid?: number; display?: number; fullscreen?: boolean; clean?: boolean }): Promise<number>;
    list(): Promise<{ id: number; panel: string; display: number; fullscreen: boolean }[]>;
    moveToDisplay(windowId: number, display: number, fullscreen?: boolean): Promise<void>;
    close(windowId: number): Promise<void>;
    workspaces(): Promise<Workspace[]>;
    saveWorkspace(name: string): Promise<Workspace>;
    applyWorkspace(id: string): Promise<void>;
    deleteWorkspace(id: string): Promise<void>;
    exportWorkspaces(): Promise<string | null>; importWorkspaces(): Promise<number>;
  };
  app: { openExternal(url: string): Promise<void>; revealLogs(): Promise<void>; checkForUpdates(): Promise<UpdateState>;
         openConnection(): Promise<void>;   // opens the native Studio server window
         onUpdate(cb: (u: UpdateState) => void): () => void; onMenu(cb: (action: string) => void): () => void };
  offline: { status(): Promise<{ online: boolean; queued: number; lastError?: string }>; onChange(cb): () => void; flush(): Promise<void> };
  upscale: { tool(); install(); onTool(cb); estimate({pid, eid, targetH, model: "fast" | "best", shotIds?}); start(same);
             list(); cancel(id); onProgress(cb) };   // AI upscale on this PC (§4.2)
  // added 12–13 October (all optional; older builds lack them, so pages feature-detect):
  engine?: { job(id); frame(id, i, Uint8Array | Uint16Array); done(id); fail(id, msg) };  // GPU render window; bits 10 → yuv420p10le
  editor?: EditorBridge;         // Tatvam Editor: docs/EDITOR.md §5, plus interop, writeLut, sidecars, versions, analyze …
  tools?: { status(); install(id); remove(id); onProgress(cb) };   // RIFE, whisper.cpp (CPU / CUDA 12.4), models, Real-ESRGAN
  appearance?: { get(); set(patch); onChange(cb) };                // theme, accent, density, scale, reduce motion, contrast
  shell?: { state(); setPrefs(p); open(what); dropped(files); jobs(); disk(); storage(); clearStorage(id); … };
  notifications?: { list(); onChange(cb); show(n); markRead(id); clear(); open(id) };
  assistants?: AssistantsBridge;  // local MCP server for AI assistants: docs/EDITOR.md §13
  // app also gains uiStatus(), onUiStatus(cb), checkUi(), updateState(), installUpdate(), releaseNotes()
}
type PanelId = "program" | "source" | "timeline" | "scopes" | "mixer" | "notes" | "media" | "renders" | "bible";
```

The exact shapes (`SyncStatus` with its phases and `inFolder`, `MachineReport`, `RenderPreset.hardware`,
`RenderJob` with `progress` 0..1, `eta_s`, `export_id`, `version`, `UpdateState`, `OfflineStatus`) live in
`desktop/src/shared/types.ts`, mirrored by `frontend/src/lib/desktop.ts`. Extra fields are additive. Menu actions
the page handles (`app.onMenu`): `open-settings` and `machine-check` open the project's Finishing room, `about` shows
the About box (`components/shell/DesktopMenu.tsx`).

The built-in workspaces are **Edit**, **Colour**, **Audio**, **Review** and **Story**. Each one lists the panels it
opens, their displays and whether they go full screen.

**Windows talk to each other** over `BroadcastChannel("tatvam-desktop")`, which every window shares because they
all have the same origin. The messages are `{type: "playhead", eid, t, playing}`, `{type: "select", eid, shotId}`,
`{type: "marks", eid, in, out}`, `{type: "seek", eid, t}` and `{type: "frame", eid, url, time, ...}` (each with `src` and
`at`). The same bus also works for
browser pop-outs on the web.

## 6. Running it

```bash
cd desktop
npm ci
npm run dev        # bundles main + preloads and starts Electron (UI from ../frontend/dist: build it first)
npm test           # unit tests (node --test; no Electron, GPU or FFmpeg needed)
npm run smoke      # starts the app against TATVAM_SERVER, checks UI, sign-in, API, socket, bridge, pop-out
npm run dist       # Windows installer (NSIS) in desktop/release, with the built UI and FFmpeg 7.1 inside
```

- `TATVAM_SERVER` (default `http://localhost:8100`) sets the server on the first run; after that, File → Studio
  server… changes it. Off this PC and the local network the address must be `https://` (§4, trust boundaries). `TATVAM_UI_DIR` points at another built UI, `TATVAM_USER_DATA` at another settings folder.
- The end-to-end test (`TATVAM_E2E=1`, see `desktop/test/e2e.test.ts`) syncs a cut, writes the EDL, renders it in 4K
  and uploads it to a running server.
- CI runs the desktop typecheck and unit tests (job "Desktop app").
- **Releases and updates.**
  - A release builds the Windows installer and attaches it, with `latest.yml` and the blockmap, to this repository's
    GitHub Release (an internal copy).
  - It also publishes it to the **public, releases-only repository** [tatvama/tatvam-desktop-releases](https://github.com/tatvama/tatvam-desktop-releases), which holds no source code. Installed
    apps update from there (`publish` in `desktop/electron-builder.yml`), so they need no token even when this
    repository is private. `desktop/test/release-config.test.ts` checks that the feed and the workflow name the
    same repository.
- **One-time setup:** a fine-grained personal access token with access to that repository only (permission
  **Contents: read and write**), saved as the Actions secret `DESKTOP_RELEASES_TOKEN`. Without it the release job
  stops with a message saying so. After adding it, run the Release workflow with `publish_tag` = that tag.
- **Signing** uses the optional `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` (or `CSC_LINK` / `CSC_KEY_PASSWORD`)
  secrets, passed to electron-builder as `CSC_LINK` / `CSC_KEY_PASSWORD`; as soon as they exist every release is signed,
  nothing else to change. Without them the installer is unsigned and Windows SmartScreen warns on first run.
- **Update verification.** `desktop/electron-builder.yml` sets `win.verifyUpdateCodeSignature: true` and
  `win.publisherName` (the certificate's subject CN; change it to match the certificate that is bought), so
  electron-updater refuses an update whose Authenticode signature isn't that publisher's. **This only protects anything
  once builds are signed**: an unsigned build has no signature to compare, so until then an update's integrity rests on
  TLS to GitHub and the blockmap. `desktop/test/release-config.test.ts` keeps the two settings and the workflow's
  signing variables in place.

## 7. Status (13 October 2026)

Built and tested on the reference laptop (GTX 1660 Ti 6 GB, i7-9750H, 32 GB, NVMe), against throwaway servers with
mock providers. Part 1 (the finishing room, 11 October) is below this list.

Part 2 (12–13 October):
- **The GPU render engine** (docs/ENGINE.md) and **Tatvam Editor** (docs/EDITOR.md), with its free tools on this
  PC and the AI tools.
- **Screens from the server** with an offline copy (§4.3). Tested live:
  - (a) The server's build is served.
  - (b) With the server stopped, the offline copy is served and labelled.
  - (c) A new build arrives with Reload / Later.
  - (d) A damaged cached file is caught and downloaded again.
- **Desktop UI and UX:**
  - Windows 11 title bar with Mica, appearance settings, the command palette (Ctrl+Shift+P).
  - Native notifications and a notification centre.
  - Taskbar progress and Jump List, the tray.
  - Drag and drop from Explorer.
  - The Start window, the Settings window (11 sections, searchable) and onboarding.
  - The status bar, the update pill and crash recovery.
- **AI assistants** (docs/EDITOR.md §13): a local MCP server with 40 tools, auto edit and watch folders.
- **Not seen live:** the tray, the taskbar buttons, the Jump List and native toasts, because CDP can't see them; and
  the stdio relay in a packaged build.


Built and tested on the reference laptop (GTX 1660 Ti 6 GB, i7-9750H, 32 GB, NVMe), against a throwaway server
with mock providers:

| Area | Result |
| --- | --- |
| Checks | Backend 195 tests and ruff, frontend `tsc -b` + build, desktop typecheck + 43 unit tests: all pass |
| Local AI upscale | Installed through the app in 8 s (download, SHA-256 check, unpack), GTX 1660 Ti picked; two 6 s shots upscaled 1080p → 4K at 1.5 frames/s (100–105 s each), uploaded as upscale takes, renamed into the series by the next sync, and used by a YouTube 2K render (2560×1440 HEVC on NVENC) |
| Live run | Sign-in through the gateway, checkout, sync of the approved cut (series names, EDL and FCPXML), machine check, 4K HEVC 10-bit render on NVENC (16 s cut in 34–47 s), chunked upload to the Render Center as v1, v2, pop-out program monitor and scopes, five workspaces, Studio server window, and the settings allow-list |
| Installer | The NSIS installer builds (134 MB, unsigned), and the packaged app passes the same smoke run with the bundled UI and FFmpeg |

Not yet exercised live: proxies, the Imports watcher, a real Google sign-in round trip, display hot-plug, offline
replay from the real UI (covered by unit tests), and the paid fal upscale (mock only; check fal's current Topaz
price before relying on `upscale_price_per_s`). Kenburns stills are slow at 4K, captions need the caption font
installed on the PC for Indic shaping, and there is no app icon yet.

**Next (roadmap only, not started):** wave 4 of the editor, docs/EDITOR.md §14 (preview render, smart render, network render, trim monitor, masks and tracking,
node grading, motion graphics and broadcast graphics, QC, recording, subtitles, media management).
