# Tatvam AI Studio: Build Plan v3

*Date: 9 October 2026. This replaces the earlier VEO Studio plans as the team's working plan. The old `PLAN.md` stays only as a record of what was built before.*

Tatvam AI Studio is one in-house production system: start with a story idea, finish with a film, a series episode, a reel or an advertisement, without leaving the app. It is **Google-first**, **API-only** (no GPUs of our own), and built around **characters that stay the same person across hundreds of shots**.

---

## 1. Decisions that shape everything

| Decision | Choice | Why |
| --- | --- | --- |
| Video, images, voices, QC | **Google by default**: Veo 3.1 for video, Nano Banana for images and keyframes, Gemini 3.8 Flash TTS for voices, Gemini vision and Gemini 3.5 Transcribe for QC | One billing account, best image-to-video fidelity, voices in 130+ languages including Hindi, Kannada, Telugu and Tamil |
| Models Google doesn't have | **fal.ai** as the gateway (about 800 models), **Replicate** as an optional second gateway | Both expose per-model schemas, so one adapter maps them. They cover LoRA training, audio-driven video and lip-sync-to-audio |
| Infrastructure | One Docker image on a small VPS, managed Postgres, Cloudflare R2. No Redis, no GPU workers, no desktop app | Nothing to operate. The job queue already runs in the database |
| Code base | Keep FastAPI + React + the existing database queue. No rewrite to Next.js, Node or Tauri | 15k lines of backend and 42k of frontend already cover most of the vision |
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

---

## 12. Agents

Ten specialists share one structured record store rather than chat text: Story, Screenplay, Director, Continuity, Prompt, Production, Quality, Editing assistant, Sound and Delivery. They are implemented as tool groups and prompts on the existing Director agent, not as separate services. Agents propose. Spend over a limit, canonical character changes, approved-take replacement and publishing need a person.

---

## 13. Storage and data

- **R2 is the shared store and the local disk is a cache** (done 8 October). Layout: `projects/<id>/characters`, `shots/<id>/<kind>`, `layers`, `renders`, `exports`, `consents`. Private bucket, checksums, versions, lifecycle rules. A second backup destination for masters and database dumps.
- **Postgres** holds metadata only. Add `seasons`, `character_versions`, `props`, `costumes`, `continuity_states`, `shot_links`, `dependencies` (stale tracking) and `voice_descriptions`. Connection pooling and worker limits from day one.
- **No Redis.** The database queue handles jobs, locks and progress.
- The **local cache** cleans only files that are safely in R2.

---

## 14. Safeguards

- **Database exposure**: the Postgres server is reachable from the public internet with a password only. Restrict it to known IPs or a VPN and require SSL before inviting the team.
- Secrets live in `.env` or encrypted in the app, never in chat or git.
- Consent and usage rights for real faces and voices. Voice replication only with a consent recording.
- Audit log, role checks, project isolation. Exist.
- Automatic timeline snapshots, database backups, restore drills.
- Idempotent jobs, retries, timeouts, cancellation, rate limits. Exist.
- Asset provenance: generated, original, licensed, stock, supplied.

---

## 15. Roadmap

| Phase | Weeks | Deliverables | Done when |
| --- | --- | --- | --- |
| **0. Prove the keys** | 1 | Run the spike on real keys. Language matrix: Hindi, Kannada, Telugu, Tamil, each in native script and romanised, close-up and medium shot, Veo Fast and Lite, rated by native speakers and by Transcribe. Confirm LoRA training. Postgres pooling and lock-down. | A per-language decision: native Veo, or TTS + lip-sync |
| **1. Script first** | 3 | @mentions, import preview, shot-to-shot edges and "generate next shot", seasons | A prepared script imports cleanly and produces a chained shot list |
| **2. Character Lab v2** | 4 | Back view, outfit turnarounds, lighting variants, versions with episode scope, Character Lock (face, body, voice, costume, gestures) fed into the prompt compiler and QC, training versions with evaluation and rollback, trained identities passed to video models that accept LoRA inputs and references to the rest, props and costumes as real entities, wardrobe timeline, outfit QC, Continuity Bible recording state at the end of each scene, voice descriptions, pronunciation dictionary | 10 shots of one character in 2 outfits pass face and outfit QC |
| **3. Google voice route** | 2 | Native Veo dialogue per language, prompt shape, Transcribe QC, regenerate-per-language dubbing, fallback switch | One scene in 3 languages with synced lips and no manual fixes |
| **4. Change impact and dashboard** | 3 | Dependency graph, stale flags, selective regeneration, episode dashboard, cost per approved second | Editing a line lists exactly what to redo |
| **5. Timeline pro** | 6 | Clip AI actions, trims, speed, keyframe animation, nested sequences, masks, colour basics | A full episode finishes inside the app |
| **6. Reels and Ads wizards** | 3 | Ads wizard with locked brand facts, batch variants, Reels highlight flow | One brief yields 3 languages in 3 aspect ratios |
| **7. Polish** | ongoing | Replicate adapter, OTIO export, QC report and publish gate, analytics | Season-scale use |

Estimates assume 2 to 3 engineers plus the existing code. The acceptance test for Phases 2 to 5 is the **3-minute short**: story, two recurring characters, one location, storyboard, generated shots with saved references, continuity kept, edited in the timeline, dialogue synced, a horizontal master, a vertical reel, and the project reopened on another machine with every version intact.

---

## 16. What is reused and what is new

| Reused as is | Extended | New |
| --- | --- | --- |
| Model Hub, routing chains, cost ledger, budgets, approvals | Script import, Film Map, prompt compiler, QC, dubbing, timeline layers, roles | @mentions, dependency graph, Character Lock, character versions, outfit turnarounds, back view, wardrobe timeline, props and costumes, continuity bible, seasons, episode dashboard, Ads wizard, Replicate adapter |
| Writers' room, scene cards, continuity check, script versions | Character Lab pages, Audio Studio | Pronunciation dictionary, Transcribe QC, voice descriptions |
| Review links, consents, audit, YouTube publish, brand kits | Export (QC report, publish gate) | Timeline pro tools |
