# Tatvam AI Studio: Build Plan v3

*Date: 9 October 2026. This replaces the earlier VEO Studio plans as the team's working plan. The old `PLAN.md` stays only as a record of what was built before. Updated the same day with the three-surface decision: web studio, desktop finishing room and mobile review app (sections 15 to 18).*

Tatvam AI Studio is one in-house production system: start with a story idea, finish with a film, a series episode, a reel or an advertisement, without leaving the app. It is **Google-first**, **API-only** (no GPU servers of our own; the editor's own PC renders the final cut), and built around **characters that stay the same person across hundreds of shots**.

---

## 1. Decisions that shape everything

| Decision | Choice | Why |
| --- | --- | --- |
| Video, images, voices, QC | **Google by default**: Veo 3.1 for video, Nano Banana for images and keyframes, Gemini 3.8 Flash TTS for voices, Gemini vision and Gemini 3.5 Transcribe for QC | One billing account, best image-to-video fidelity, voices in 130+ languages including Hindi, Kannada, Telugu and Tamil |
| Models Google doesn't have | **fal.ai** as the gateway (about 800 models), **Replicate** as an optional second gateway | Both expose per-model schemas, so one adapter maps them. They cover LoRA training, audio-driven video and lip-sync-to-audio |
| Infrastructure | One Docker image on a small VPS, managed Postgres, Cloudflare R2. No Redis, no GPU servers | Nothing to operate. The job queue already runs in the database. The only GPU in the system is the editor's own PC, used for the final render (section 16) |
| Code base | Keep FastAPI + React + the existing database queue. No rewrite to Next.js or Node | 15k lines of backend and 42k of frontend already cover most of the vision |
| Surfaces | **Web is the studio.** The **desktop finishing room** is the same React code in a Tauri shell with local FFmpeg and a GPU render engine, for one or two editors. The **mobile review app** is the same web app installed as a PWA. One backend, one database, one login | All AI work is a cloud call, so a desktop app gains nothing there. It earns its place only for 4K editing, GPU effects, local footage and offline cutting. Phones are where approvals wait, not where edits happen |
| Lip-sync | **Google route**: Veo speaks the line inside the video, in the language's own script. Dubbing means regenerating the shot per language | Google sells no lip-sync-to-audio API, and Gemini Omni cannot edit voices. The fallback (Gemini TTS voice + sync.so lips) stays available per language |
| Character identity | The **reference pack** is the training: all angles, expressions, every outfit. LoRA is optional and only sharpens keyframes | Veo has no training. Identity comes from the keyframe plus up to 3 reference images |
| Money and canon | AI proposes, people approve: spend over a limit, locking a character, replacing an approved take, publishing | Keeps costs and continuity under human control |

---

## 2. Product structure

One left rail, twelve modules. Every module edits the same project database.

| Module | Covers (vision modules) | Today |
| --- | --- | --- |
| Dashboard | Production Control Center, cost intelligence | Partly: costs, approvals, activity |
| Productions | Project Manager: films, series, seasons, episodes, reels, ads | Exists: project, episode, scene, shot. Add seasons |
| Story Studio | AI Story Studio, Script & Dialogue Studio, import wizard | Exists. Add @mentions and a richer import |
| Character Lab | Character Intelligence Lab | Exists. Needs the training pack, lock, versions, outfits |
| World | World & Location Studio, props, costumes, continuity bible | Locations exist. Props, costumes and the bible are new |
| Storyboard | Storyboard Studio, AI Director, Film Map (node graph) | Exists. Add shot-to-shot chaining |
| Image Studio | AI Image Studio | Exists inside shots. Give it its own page |
| Video Studio | AI Video Studio, model gateway | Exists (Model Hub) |
| Audio Studio | Voice & Sound Studio | Exists. Add voice descriptions and a pronunciation dictionary |
| Timeline | Advanced Timeline Editor, AI Post-Production | Basic layers exist. The biggest build |
| Library | Asset Library, versions | Exists |
| Render Center | Render & Export Studio, QC report | Exists. Add the QC report and a publish gate |

The three production modes (Film & Series, Shorts & Reels, Ads) are **templates and wizards over the same modules**, not separate apps.

The same modules appear on three surfaces (section 15). The web shows all twelve. The desktop finishing room adds the full editor and render on top of them. The mobile app shows Dashboard, review, approvals and capture only.

---

## 3. Characters: the core engine

### 3.1 Creating a character
Sources: AI design from a description, uploaded photos, reference video frames, or a consented real person. Every character stores:

- **DNA text**: 60 to 80 fixed words on age, face, skin, hair, eyes, build, marks and signature outfit. Pasted into every prompt unchanged.
- **Reference pack**: the training, see 3.2.
- **Voice**: a written voice description (age, timbre, pace, accent) injected into every Veo prompt, plus a Gemini TTS designed or replicated voice stored as a voice ID for narration, trailers and the fallback route.
- **Performance notes**: speaking style, signature gestures, pronunciation of the name.
- **Consent record** whenever a real face or voice is used.

### 3.2 Training the reference pack, in all directions
Generated with Nano Banana from the DNA text or one photo, then reviewed and approved one by one:

1. Turnaround: front, three-quarter, profile, **back**, full body. The back view is new.
2. Expressions: neutral, happy, angry, sad, surprised, plus any the story needs.
3. **Per outfit**: a 3-angle mini turnaround instead of a single image. New.
4. Lighting variants: day, dusk, night interior. New.
5. Optional **LoRA** on fal.ai or Replicate from the approved pack, for sharper single-character keyframes. Training versions with evaluation and rollback.

A pack is **locked** when approved. Any change creates a new **character version**. Versions can be scoped to an episode range, which is how a character ages, grows a beard or changes hairstyle over time while staying the same person.

### 3.3 Clothes that change per video
- A scene card assigns an outfit per character. A shot can override it.
- The prompt compiler writes the outfit text and picks that outfit's reference images.
- A **wardrobe timeline** per episode shows who wears what, scene by scene, and flags continuity breaks.
- QC fails a take whose outfit does not match the scene's wardrobe.

### 3.4 Character Lock
A structured constraint set per character: face, body, skin and facial hair, voice, gestures, costume continuity, age, lighting style. Each constraint feeds three places: the prompt compiler, the reference selection and the QC thresholds. It is a steering and checking system, not a guarantee, and the UI says so.

### 3.5 Consistency validator
Every take is scored before it can be approved:

| Check | Tool |
| --- | --- |
| Face similarity to the pack | OpenCV face embedding (runs on CPU, no GPU) |
| Outfit, extra people, text artifacts, hands, action match | Gemini vision |
| Spoken words match the script, in the right language | Gemini 3.5 Transcribe |
| Lip-sync quality | Gemini vision lip-sync score |
| Face stability through the clip | Face check on 4 sampled frames |

Failed takes retry on the next engine in the chain, within the retake and budget limits. Results show side by side.

---

## 4. Script-first workflow

### 4.1 Story Studio
Concept, synopsis, logline, treatment, season arc, episode outlines, and a screenplay with scene headings, action, dialogue and transitions. Five languages with native-speaker polish. Script versions with diff and restore. Critic loop, table read, continuity check. All of this exists today.

### 4.2 @mentions (new)
Typing `@` in the script editor autocompletes characters, locations and props. A mention is stored as an ID, not text, so renaming a character updates every script, and the shot breakdown knows exactly who is in each shot. An unknown `@name` offers to create the character on the spot.

### 4.3 Import wizard (extend)
Accepts DOCX, PDF, Fountain and plain text. Recognises SCENE, SHOT, VISUAL:, PROMPT:, dialogue, VO:, DURATION and CAMERA labels. Anything unstructured is arranged by AI without changing a word, and changed lines are flagged. New: a **preview step** that shows every scene and shot with its visual, dialogue and detected speakers before saving, maps speakers to characters (or creates them), and writes `@mentions` into the imported script.

### 4.4 Script intelligence (new)
A dependency graph from each dialogue line to its voice take, lip-sync take, keyframe, video take, subtitle segment and timeline clip. Editing a line marks the affected items **stale** and offers selective regeneration. Nothing approved is deleted.

---

## 5. AI Director and the Film Map

The Director turns each scene into structured shots: framing, lens, movement, blocking, eyelines, lighting, duration, cast, outfits, props and references. Shots can be approved, generated, rejected, regenerated or replaced with full history. Exists.

**Film Map** (node graph, exists): characters connect to shots, locations to scenes. New:
- **Shot-to-shot edges**: connecting shot A to shot B sets B's continuity source to A's last frame, and optionally A's video for Veo extension.
- **Generate next shot** on any node: uses the previous shot's approved last frame, the continuity state and the scene wardrobe.
- Node badges: keyframe approved, video approved, QC score, cost.

---

## 6. Storyboard to video

| Step | Default engine | Notes |
| --- | --- | --- |
| Keyframe | Nano Banana with up to 8 references: character pack, outfit, location, previous last frame | The identity anchor for every mode |
| Video, Saver | Veo 3.1 Lite from the keyframe | Cheapest. No reference images, no extension |
| Video, Balanced | Veo 3.1 Fast: keyframe as first frame + 3 references | 8-second clips, 1080p |
| Video, Hero | Veo 3.1 Standard, up to 4K | A few key shots only |
| Continuous action | Last frame of shot N starts shot N+1 | Exists |
| Long take | Veo extension, 7 s per hop up to 148 s, 720p | Keep the voice audible in the last second before extending |
| Controlled transition | First + last frame interpolation | Exists |
| Small fixes | Gemini Omni multi-turn edit | "Remove the cup", "make it night" |
| Animatic | Keyframes + timed dialogue + music, free | Review before spending on video |

Every generation keeps its prompt, reference versions, model, parameters, cost, source assets and result. Multiple candidate takes are made; only approved takes reach the timeline.

---

## 7. Voice and lip-sync, the Google route

Google's position today: Veo 3.1 generates speech and lips together from quoted dialogue. English is fully supported, other languages are "not evaluated, may work". There is no audio input, no voice picker and no voice persistence across generations. Gemini Omni cannot edit voices. Gemini 3.8 Flash TTS gives locked voices in 130+ languages. Gemini 3.5 Transcribe verifies the words.

**Default chain for a dialogue shot**
1. The line goes into the Veo prompt in the target language's own script, attribution first, early in the prompt, one speaker per clip, one solid line per 8 seconds, with the character's voice description.
2. Face from the keyframe and reference images.
3. QC: Transcribe checks the words, vision checks the lips, the face check runs as always. A mismatch triggers an automatic retake.
4. **Dubbing** means regenerating the shot with the translated line. Fully Google.

**Fallback chain** (per language, chosen after the Phase 0 test): Gemini TTS locked voice, then sync.so lip-sync on the clip. Cheaper per language and an exact voice, but non-Google for the lips.

**Known limit**: two separate Veo shots of the same character can sound slightly different. The voice description narrows it, and extension removes it within one take. If a series needs an exact voice, that language switches to the fallback chain.

Also in Audio Studio: narration, a pronunciation dictionary per project (names, Sanskrit terms) applied before every voice call, Lyria music, sound effects, ambience, mixing, and Dialogue Lock (approved audio becomes the source of truth for subtitles and lips).

---

## 8. Timeline editor

Built in stages on the existing layer model (video and audio tracks, position, scale, opacity, fades, transitions, waveforms, J/K/L shuttle).

1. **AI actions on a clip** (right-click): regenerate, improve character, extend, fix lip-sync, change background, enhance, add subtitles, make vertical cut, swap from the take stack. A regenerated clip joins the original clip's take stack and replaces it non-destructively.
2. **Editing tools**: ripple, roll, slip, slide, split, speed, reverse, freeze frame, markers, snapping.
3. **Animation**: keyframes on position, scale, opacity, rotation. Titles and lower thirds exist.
4. **Compositing**: picture-in-picture, masks, blend modes.
5. **Audio**: multitrack mix, fades, gain automation, ducking (ducking exists).
6. **Nested sequences, colour** (exposure, contrast, white balance, LUTs), proxies, version snapshots.

Three views of one project: Story view, Storyboard view, Timeline view. OpenTimelineIO export comes last, only if editors need to hand projects to outside tools.

The stages above are the **web timeline**: everything FFmpeg can render on the server, which is enough for AI clips of 4 to 8 seconds at 1080p. Everyone uses it to cut, review and preview. The Filmora-level catalogue below needs a GPU render engine and lands in the **desktop finishing room** (section 16).

### 8.1 Editing feature catalogue

| Area | Exists today (FFmpeg) | To add | Renders on |
| --- | --- | --- | --- |
| Transitions | About 40 xfade transitions: dissolves, dips, wipes, barn doors, clock wipe, zoom, squeeze, with duration | Shader transitions: glitch, light leak, film burn, morph, cube, page curl, luma mattes (the gl-transitions set, 70+). Drag onto a cut point, easing, direction, animated thumbnails, favourites, matching audio crossfade, AI-suggested transition per cut | GPU engine |
| Effects | Looks, uploaded LUTs, speed and reverse, flip, Ken Burns moves, fade to black | Keyframes on position, scale, rotation and opacity; speed ramps on a curve; masks (shape, pen, tracked); chroma key and AI background removal; stabilisation; motion blur, glow, vignette, grain, sharpen, denoise; face blur with tracking; freeze frame; picture in picture; split-screen templates | GPU engine (freeze, PiP, stabilise also in FFmpeg) |
| Colour | Preset looks and LUTs | Colour wheels, curves, HSL qualifiers, scopes (waveform, vectorscope, histogram), shot-to-shot colour match, adjustment layers | GPU engine |
| Multi-layer timeline | Video, image and audio tracks, blend modes, waveform, captions, J/K/L | Unlimited tracks with lock, solo, mute and hide; magnetic snapping; ripple, roll, slip and slide; razor; J and L cuts; markers; compound clips; nested sequences; track groups; linked audio; multicam; minimap | Both |
| Titles and text | Caption generation, brand kits | Animated title presets, lower thirds, kinetic typography, word-highlight karaoke captions, stickers and shapes. Correct Indic shaping for Hindi, Kannada, Telugu and Tamil is the hard requirement | Both (libass on FFmpeg, HarfBuzz on GPU) |
| Audio | Per-clip gain, fades, ducking, ElevenLabs clean-up | Beat detection for beat-synced cuts, EQ and compressor, audio keyframes, voice isolation, music auto-fit to length, SFX library, mixer with meters, loudness normalisation for YouTube | Both |

### 8.2 Render engine decision

Preview and final render must look identical. FFmpeg cannot draw shader transitions, keyframed masks or node composites, so there are two paths:

1. Keep FFmpeg and limit the catalogue to what it can draw. This is the web timeline.
2. Build **one GPU render engine** (WebGPU, with WebGL fallback) that previews in the browser and in the desktop app, and renders the final file headlessly in the desktop app. FFmpeg then only decodes and encodes.

We take path 2 for the desktop finishing room and keep path 1 for the web. The engine is one code base in TypeScript or Rust, used in three places: browser preview at reduced resolution, desktop preview, desktop final render. The web timeline keeps working for anyone without the desktop app.

### 8.3 Node connection

The node graph library is already in the frontend for the Film Map. Three uses, in order of fit:

1. **Generation recipe graph**: prompt, keyframe, video, lip-sync and QC as connected nodes, with the Bible wired in. Like ComfyUI, but every node knows the characters, outfits and cost gate. Recipes are saved and reused per production mode. This fits the product best and goes into Phase 7.
2. **Effect stacking** per clip as a node chain. Small, once the GPU engine exists.
3. **Full node compositing** (Fusion or Nuke style). The biggest build in the whole plan. Only if editors ask for it after the rest ships.

### 8.4 Workspace and monitors

Panels already dock. To add: workspace presets (Edit, Colour, Audio, Story), saved and shared layouts, pop-out panels into separate windows, a full-screen program monitor on a second display, source and program dual monitors, external clean-feed output. Pop-outs work in the browser with shared state between windows, but the desktop app does it natively and without pop-up limits.

---

## 9. Reels and Ads

**Reels Studio**: import an episode or long video, then highlight detection, transcript-based editing, hook suggestions, captions, vertical reframing with subject tracking, music, branded intro and outro, and several short versions. Every cut is editable. Cut-into-shorts, captions and reframing exist.

**Ads Studio** wizard: brief, audience, hook variants, script, storyboard, visuals, voice-over, logo, product facts and CTA, final ad plus alternative cuts, all languages and aspect ratios in one run. Brand facts, logos, colours and CTA are **locked data** that no model may invent. Brand kits and the marketing pack exist. Durations: 6, 10, 15, 30, 45, 60 and 90 seconds, plus custom.

---

## 10. Production control

- **Episode dashboard**: total, approved, in review and remaining shots; approved footage; rejected footage; spend by provider; render queue; pending reviews; storage; estimated remaining work.
- **Cost intelligence**: estimate before and actual after; cost per approved second; regeneration rate; wasted generations; provider comparison; project total.
- **Approval chain**: Draft, Ready for generation, Generated, Quality review, Director approved, Timeline ready, Final approved.
- **Roles**: Writer, Director, Storyboard artist, Character artist, Generation operator, Video editor, Audio editor, Producer, Admin. Today there are four roles: Admin, Producer, Creator, Viewer. Extend.
- **Reviews**: frame-accurate comments, drawing on frames, A/B compare, approve or reject with reasons, client links without accounts. Exists.

---

## 11. Model gateway

All seven gateway requirements exist in the Model Hub: dynamic registry, capability detection from schemas, character references passed to compatible models, shot chaining, provider fallback within chain and budget, pricing and per-project cost, and async jobs with retry and cancel. Additions:

- Capability flags for **speech-in-video**, **audio-driven**, **LoRA input** and **lip-sync-to-audio**, plus a **language quality score** per model from our own tests.
- Fallback across providers asks for approval when the next engine is more expensive than the limit.
- A Replicate adapter beside fal.ai, using the same schema mapper.
- **Done (Oct 2026):** OpenRouter (video catalog with live prices, optional text route) and BytePlus ModelArk (Seedance 2.0 / 2.5 / 2.5 Premium, Seedream 5.0 Pro) as providers. Engines that run the same model share a route key, and the router tries the cheapest live route first, then the others. AI characters are registered in the BytePlus asset library so Seedance takes them as trusted references instead of blocking them as real people.

---

## 12. Agents

Ten specialists share one structured record store rather than chat text: Story, Screenplay, Director, Continuity, Prompt, Production, Quality, Editing assistant, Sound and Delivery. They are implemented as tool groups and prompts on the existing Director agent, not as separate services. Agents propose. Spend over a limit, canonical character changes, approved-take replacement and publishing need a person.

---

## 13. Storage and data

- **R2 is the shared store and the local disk is a cache** (done 8 October). Layout: `projects/<id>/characters`, `shots/<id>/<kind>`, `layers`, `renders`, `exports`, `consents`. Private bucket, checksums, versions, lifecycle rules. A second backup destination for masters and database dumps.
- **Postgres** holds metadata only. Add `seasons`, `character_versions`, `props`, `costumes`, `continuity_states`, `shot_links`, `dependencies` (stale tracking) and `voice_descriptions`. Connection pooling and worker limits from day one.
- **No Redis.** The database queue handles jobs, locks and progress.
- The **local cache** cleans only files that are safely in R2.
- **Desktop project folder** (section 16.3): a mirror of the project's approved media on the editor's disk, plus a SQLite copy of the project metadata. R2 stays the source of truth. The folder cleans only files that are safely in R2.
- **Checkout locks** on timelines live in Postgres, so the web and the desktop agree on who is editing.

---

## 14. Safeguards

- **Database exposure**: the Postgres server is reachable from the public internet with a password only. Restrict it to known IPs or a VPN and require SSL before inviting the team.
- Secrets live in `.env` or encrypted in the app, never in chat or git.
- Consent and usage rights for real faces and voices. Voice replication only with a consent recording.
- Audit log, role checks, project isolation. Exist.
- Automatic timeline snapshots, database backups, restore drills.
- Idempotent jobs, retries, timeouts, cancellation, rate limits. Exist.
- Asset provenance: generated, original, licensed, stock, supplied.
- Desktop and mobile use the same login, roles, cost gate and audit log. Client review on a phone goes through the existing links with watermark and expiry. Local media on a desktop is deleted on request when a project is closed.

---

## 15. Three surfaces: web, desktop, mobile

One backend, one database, one login. Web is the studio, desktop is the finishing room, mobile is the approval and capture layer.

| Surface | Who | Does | Does not | Built as |
| --- | --- | --- | --- | --- |
| **Web studio** | Everyone | All twelve modules, all AI generation, approvals, costs, the web timeline, reviews, publishing | Final 4K render, GPU effects | The current React and FastAPI app in Docker on the VPS |
| **Desktop finishing room** | One or two editors | Full timeline, shader transitions and effects, colour, titles, mixer, 4K render, local footage, offline cutting | Any AI generation of its own; every AI button calls the server | Tauri shell around the same React code, a Rust side for FFmpeg, sync and the render engine |
| **Mobile review app** | Producers, directors, writers, clients, actors, on-set team | Review, frame comments, approvals, spend approvals, notifications, capture | Editing | The web app installed as a PWA; a native Expo app later only if needed |

Why not web only: a browser cannot run hardware decode and encode, long 4K timelines or a headless GPU render. Why not desktop only: the team, the Bible, approvals and costs need the server, every AI step is a cloud call, and anyone with a link must be able to work. Why mobile at all: decisions wait on phones, and an approval made from a phone unblocks a render the same minute.

Order of value: web first, always. Mobile next, because it is two weeks of layout on existing pages. Desktop last, because it only pays off once the editing engine exists to justify it.

---

## 16. Desktop finishing room

### 16.1 What lives where

| | Web (server) | Desktop (local) |
| --- | --- | --- |
| Source of truth | Project, Bible, scripts, shots, approved takes, costs, roles | SQLite mirror, synced |
| Media | Masters in R2 | Project folder on disk, pulled on demand |
| Timeline | Web timeline, anyone can view and comment | Full editor, one person at a time |
| Rendering | Previews and drafts | Final 4K masters on the editor's GPU, uploaded back |
| AI generation | All of it | Same buttons, same server, same cost gate |

### 16.2 Sync model

- Opening a project on desktop downloads the **approved** takes, voices, music, captions and Bible into the local folder. Nothing unapproved is pulled.
- The editor **checks out** the timeline. The web shows "being edited by X" and that cut goes read-only. No two people overwrite each other.
- Edits save locally every few seconds and push to the server on each change when online. Offline edits queue and sync on reconnect.
- Renders upload to R2 and appear in Render Center with a version number. Reviewers watch in the browser or on a phone, comment on frames, and the comments appear in the desktop timeline.
- **Check-in** releases the lock. Every check-in is a version with rollback.

### 16.3 Local project folder

One folder per project: `Takes`, `Audio`, `Captions`, `Imports`, `Proxies`, `Renders`, `Cache`, plus a project file. Footage dropped into `Imports` is ingested automatically (a watch folder). The folder is readable by Premiere or DaVinci, so nothing is trapped. `Cache` and `Proxies` are disposable; `Renders` upload and are then safe to clean.

### 16.4 4K pipeline

- Veo gives 1080p, or 4K only on 8-second Standard shots. The desktop adds an **upscale step**, run locally or through fal.ai, so every clip reaches 3840 by 2160 before the final render. The cost of the upscale shows before it runs, like every paid step.
- Editing uses **1080p proxies** for smooth scrubbing and switches to full 4K for render.
- Render uses hardware encoding (NVENC on NVIDIA, QuickSync on Intel) to H.264, HEVC and ProRes, 10-bit, with presets for YouTube 4K, Shorts and Reels, and broadcast.
- Hardware baseline: an RTX 3060 or better, 32 GB RAM, an NVMe SSD. Below that everything works but renders slowly.

### 16.5 Transitions and effects

Everything in section 8.1 marked "GPU engine" ships here first, on the engine from section 8.2: shader transitions plus the existing 40, keyframes, speed ramps, masks, chroma key, blur, glow, grain, vignette, colour wheels, curves, LUTs and scopes, titles with correct Indic shaping, caption templates, lower thirds, ducking, mixer and loudness normalisation.

### 16.6 Build shape

Tauri shell around the current React frontend. Rust side for FFmpeg, file sync, the watch folder and the render engine host. SQLite mirror of the project. Same login, roles and cost gate. Tauri over Electron: a 10 MB installer and far less memory. Needs an installer, code signing (to avoid SmartScreen warnings), auto-update and crash reporting. Windows first; the same shell builds for macOS if an editor needs it.

### 16.7 Sizing

| Piece | Effort |
| --- | --- |
| Tauri shell, local folder, SQLite mirror, sync with checkout locks | 3 to 4 weeks |
| Proxies, upscale step, hardware-encoded 4K export with presets | 3 to 4 weeks |
| GPU render engine with transitions, keyframes, masks, colour, titles, mixer | 3 to 5 months for one strong developer |
| Pop-out monitors, workspace presets, installer, signing, auto-update | 2 to 3 weeks |

The render engine is the long pole and the only reason the desktop exists. It is planned as its own phase, not squeezed into Phase 5.

---

## 17. Mobile review and capture app

A review and approval app, not an editor. Its job is to unblock the pipeline from anywhere.

**On mobile**

- Watch any render or take, scrub frame by frame, compare two takes side by side.
- Tap a frame, draw on it, type or speak a note. Comments land on the timeline the editor sees.
- Approve or reject takes, keyframes, scripts and character locks, with the cost shown first.
- Spend approvals: when a job crosses the limit, the producer gets a push notification and approves from the phone.
- Notifications: render finished, QC failed, approval waiting, comment reply, publish done.
- On-set capture: reference photos for the Bible, a voice sample with the consent script, location references. They upload straight into the project.
- Voice notes to the Director that become tasks or change requests.
- Dashboard: spend today, what is rendering, what waits on whom, publish schedule.
- Publish controls: approve a thumbnail, pick a title variant, confirm or reschedule a post.

**Off mobile**: timeline editing, effects, colour, anything that needs a GPU or a big screen.

| Option | Verdict |
| --- | --- |
| **Installable web app (PWA)** from the existing React code | Start here. No new code base, works on Android and iPhone, supports push, camera and microphone. The review page already exists, so this is mostly phone layouts |
| **Native app with Expo (React Native)** | Later, only for App Store presence, background uploads of large files or deeper camera control. Shares logic with the web code |
| **Flutter, Swift and Kotlin** | No. Separate code base, separate team, no reuse |

---

## 18. Feature backlog beyond editing

New items only, grouped by where they sit. The web studio owns all of them unless marked desktop.

- **Pre-production**: Fountain and Final Draft import and export with automatic breakdown into scenes, props, locations and wardrobe; beat sheets and structure templates (three act, hero's journey, PAS and AIDA for ads); mood boards and reference boards; pitch deck and treatment generation; hook scoring and retention prediction on the script; trend research per language and region.
- **Image and video generation**: inpainting, outpainting, background swap, relighting, upscaling and style transfer in Image Studio; camera-move presets for keyframes (dolly, crane, orbit) from depth maps; video-to-video restyle; frame interpolation to 60 fps, slow motion, seamless loops; batch variants with side-by-side A/B and a seed lock; prompt library with versions and a prompt coach that explains why a shot failed.
- **Audio and localisation**: stem separation; foley and ambience generation from the script; emotion and pace control per line; dub timing fit so a translated line matches the shot length; auto-translated subtitles and on-screen text; per-language thumbnails and titles; recording booth with teleprompter and built-in consent capture.
- **Capture (desktop)**: screen recording, webcam capture, phone import, watch folders, Stream Deck and Loupedeck support, shortcut profiles that mimic Premiere or Resolve, clean full-screen output to a second display or TV.
- **Motion graphics**: reusable templates for intros, outros, lower thirds, logo stings, animated charts and maps; template packs per production mode; safe-area overlays per platform and captions that avoid platform UI.
- **Quality control**: artefact detection for hands, text and flicker; audio sync check; caption QC; continuity checks for props and wardrobe with a bible that fills itself; broadcast-legal levels; C2PA provenance signing and invisible watermarking on every export.
- **Distribution**: publish to Instagram, Facebook, TikTok and X beside YouTube, with scheduling and best time to post; auto-clipping of episodes into Shorts and Reels with reframing and hooks (extends Reels Studio); thumbnail A/B, title and description variants, chapters, end screens, hashtag sets; analytics pulled back into the project.
- **Team and business**: side-by-side version compare and sign-off workflows on top of the existing frame comments; client portal with watermark, expiry and download control; notifications over email, Slack and WhatsApp; production schedule with deadlines, budget versus actual per episode and cost forecasting per season; per-user quotas, invoices and markup, white label and multi-tenant if the studio is sold; SSO; asset rights and licence tracking; model usage reports by retake rate.
- **Library**: vision-based auto tagging, face search across clips, duplicate detection, stock footage and music integration, shareable packs of Bibles, templates, LUTs, transitions and prompt sets.

**First picks** (cheap given what exists, large daily impact): Fountain and Final Draft import with breakdown; inpainting and outpainting in Image Studio; multi-platform publish with scheduling; artefact and continuity QC feeding the publish gate; C2PA signing on export.

---

## 19. Roadmap

| Phase | Weeks | Deliverables | Done when |
| --- | --- | --- | --- |
| **0. Prove the keys** | 1 | Run the spike on real keys. Language matrix: Hindi, Kannada, Telugu, Tamil, each in native script and romanised, close-up and medium shot, Veo Fast and Lite, rated by native speakers and by Transcribe. Confirm LoRA training. Postgres pooling and lock-down. | A per-language decision: native Veo, or TTS + lip-sync |
| **1. Script first** | 3 | @mentions, import preview, shot-to-shot edges and "generate next shot", seasons | A prepared script imports cleanly and produces a chained shot list |
| **2. Character Lab v2** | 4 | Back view, outfit turnarounds, lighting variants, versions with episode scope, Character Lock (face, body, voice, costume, gestures) fed into the prompt compiler and QC, training versions with evaluation and rollback, trained identities passed to video models that accept LoRA inputs and references to the rest, props and costumes as real entities, wardrobe timeline, outfit QC, Continuity Bible recording state at the end of each scene, voice descriptions, pronunciation dictionary | 10 shots of one character in 2 outfits pass face and outfit QC |
| **3. Google voice route** | 2 | Native Veo dialogue per language, prompt shape, Transcribe QC, regenerate-per-language dubbing, fallback switch | One scene in 3 languages with synced lips and no manual fixes |
| **4. Change impact and dashboard** | 3 | Dependency graph, stale flags, selective regeneration, episode dashboard, cost per approved second | Editing a line lists exactly what to redo |
| **5. Timeline pro (web)** | 6 | Clip AI actions, trims, speed, keyframe animation, nested sequences, masks, colour basics, everything FFmpeg can render. GPU-only effects wait for Phase 9 | A full episode finishes inside the app |
| **6. Reels and Ads wizards** | 3 | Ads wizard with locked brand facts, batch variants, Reels highlight flow | One brief yields 3 languages in 3 aspect ratios |
| **7. Polish** | ongoing | Replicate adapter, OTIO export, QC report and publish gate, analytics, generation recipe node graph (section 8.3) | Season-scale use |
| **8. Mobile review PWA** | 2 | Installable web app: phone layouts for review, frame comments with drawing, approvals and spend approvals, push notifications, on-set capture of references and consent recordings (section 17). Can run beside Phase 5 | A producer approves a spend request and a take from a phone, and a reference photo shot on set appears in the Bible |
| **9. Desktop finishing room** | 18 to 26 | Tauri shell, local project folder, SQLite mirror, sync with checkout locks, proxies, upscale step, hardware-encoded 4K export with presets, then the GPU render engine with shader transitions, keyframes, masks, chroma key, colour tools, Indic-shaped titles, ducking and mixer, pop-out monitors, workspace presets, installer and auto-update (section 16) | The 3-minute short is finished on the desktop in 4K with shader transitions, uploaded, reviewed and approved on a phone, and reopened on the web with every version intact |

Estimates assume 2 to 3 engineers plus the existing code. Phase 9 starts after Phase 5 and its render engine is one strong developer for three to five months; it must not be squeezed into Phase 5. The acceptance test for Phases 2 to 5 is the **3-minute short**: story, two recurring characters, one location, storyboard, generated shots with saved references, continuity kept, edited in the timeline, dialogue synced, a horizontal master, a vertical reel, and the project reopened on another machine with every version intact.

### 19.1 Next up (immediate)

Short items to add before the next phase, in this order. Each one builds on what shipped in October 2026 (Poster Studio, single-port server, health checks, OpenRouter and BytePlus providers, cheapest-route routing).

| # | Item | What to build | Done when |
| --- | --- | --- | --- |
| 1 | **Live keys check for the new providers** | Add the OpenRouter key and the BytePlus API key and access key + secret. Make one clip each way (first frame, reference images), register one character, and compare the cost ledger with the providers' bills. Confirm OpenRouter's reference-image field and data-URI support, and the Seedance 2.5 Premium price | Real clips from both providers, costs within 5% of the bills |
| 2 | **Deploy to Coolify** | Use `connect_timeout` instead of `timeout` for psycopg, pick the database (shared Postgres or a fresh one), add the new provider keys to the compose environment, and check the health probes | `/api/health/ready` is green on Coolify and a job runs end to end |
| 3 | **Blocked-shot recovery** | A "Retry with another engine" button on a take blocked by a safety filter, and an opt-in setting "On a safety block, try another model" that works even with Google first. Show the price of the next engine before it runs | A character shot blocked by Veo finishes on Seedance with the registered character in one click |
| 4 | **Seedance-ready characters** | Optional auto-registration with BytePlus when a character sheet is approved or locked. A "Seedance-ready" badge on cast cards and in the shot model picker. Re-check asset status, and remove entries from the library on request | Every locked AI character is ready for Seedance without a manual step |
| 5 | **More from Seedance** | Audio-driven dialogue (reference audio, for the dialogue chain), extending a clip from a reference video, and 480p draft previews before the final render | A dialogue shot can run on Seedance from the recorded voice |
| 6 | **OpenRouter images** | Image models through OpenRouter (Nano Banana, Seedream) as extra routes in the image chain | Keyframes still generate when Google's image quota is used up |
| 7 | **One card per model in the Model Hub** | A grouped catalog view (each model once, with its routes), editing the route key in the model page, and switching single routes on or off | Seedance shows as one card with three routes |
| 8 | **Spend safety across providers** | Read OpenRouter credit and BytePlus balance, skip a provider with no credit, ask for approval when the fallback route costs more than the limit, and leave the asset-library key out of the "providers live" count | No job fails for lack of credit when another route can do it |
| 9 | **Phase 0 on real keys** | Still waiting for Veo billing: run the language matrix and confirm LoRA training | Per-language decision recorded |

**Status (9 October 2026).** Built and tested with mock providers: 3, 4, 5, 6, 7 and 8, plus the code half of 2 (psycopg
gets `connect_timeout`; the compose file lists the provider keys). Still to do on real keys and servers: 1 (live keys
check), the rest of 2 (deploy on Coolify), 9 (Phase 0). Not yet confirmed against the live APIs: OpenRouter's
`input_references` for video, BytePlus `reference_audio` / `reference_video` and asset deletion, and the BytePlus balance
call (`QueryBalanceAcct`); an unreadable balance never blocks work. New team settings, all off by default except the
limit: `safety_fallback`, `quota_fallback_routes` (keeps Google first strict while off), `byteplus_auto_register`,
`fallback_extra_limit_usd` ($0.50).

---

## 20. What is reused and what is new

| Reused as is | Extended | New |
| --- | --- | --- |
| Model Hub, routing chains, cost ledger, budgets, approvals | Script import, Film Map, prompt compiler, QC, dubbing, timeline layers, roles | @mentions, dependency graph, Character Lock, character versions, outfit turnarounds, back view, wardrobe timeline, props and costumes, continuity bible, seasons, episode dashboard, Ads wizard, Replicate adapter |
| Writers' room, scene cards, continuity check, script versions | Character Lab pages, Audio Studio | Pronunciation dictionary, Transcribe QC, voice descriptions |
| Review links, consents, audit, YouTube publish, brand kits | Export (QC report, publish gate) | Timeline pro tools |
| Dockable panels, Film Map node graph, review page | Review page as the mobile PWA, Film Map as the generation recipe graph | Tauri shell, local project folder, SQLite mirror, sync and checkout locks, upscale step, hardware 4K export, GPU render engine, shader transitions, pop-out monitors, push notifications, on-set capture |
