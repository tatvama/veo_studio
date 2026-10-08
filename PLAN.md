# VEO STUDIO: Build Plan

**AI video studio:** you give a concept, and the studio works through hook, script, characters, voices and storyboard, then generates the video scene by scene and edits the final cut.
**Built for:** AI web series (same characters and voices in every episode), YouTube Shorts, Reels and ads, in **English, Hindi, Kannada, Telugu and Tamil**.
**Used by:** a team, with logins and roles.
**Powered by:** Google Gemini API (Veo 3.1, Gemini Omni Flash, Nano Banana, Gemini TTS, Lyria, Gemini Flash/Pro), plus ElevenLabs and sync.so for voice and lip-sync.
**Status:** Built (2026-10-07). Phases 1–5 and most of Phase 6 are implemented and verified with mock providers; Phase 0 scripts are ready to run on real keys. See section 17 and [README.md](README.md).

---

## 0. Summary

| | |
|---|---|
| **What** | A team web app with an AI "Director" agent. Type a concept and it proposes hooks, script, cast, shot list and storyboard. The team approves or tweaks each step, then it generates the video shot by shot and edits the final cut. |
| **Three rules that give the quality** | 1. **Bible first:** characters, voices, places and style are locked once and reused everywhere. 2. **Keyframe first:** approve a cheap image before paying for a video. 3. **Voice lock:** every character keeps one voice across all episodes and all 5 languages. |
| **Budget** | **Saver mode by default.** Most shots are an approved keyframe animated with Veo 3.1 Lite ($0.05/s). A 60 s short costs about $7–8 and a 10-min episode about $65 (section 2). |
| **Stack** | React (Vite + TS + Tailwind + shadcn/ui) · Python FastAPI · `google-genai` SDK · Redis job queue · PostgreSQL · FFmpeg · **Docker**, so the same setup runs on Windows, Unraid or a VPS. No NVIDIA GPU needed. |
| **Build order** | 6 phases. Phase 1 gives a working "Concept → Short video" for the team in about 2 weeks. |

---

## 1. What we learned from the references

| Reference | What it really is | What we take from it |
|---|---|---|
| [veo-3/veo-3](https://github.com/veo-3/veo-3) | A showcase/marketing repo. It has no code, only demo videos and very long prompts (300+ words). | Veo responds best to **long, structured prompts** that cover camera, lighting, action, dialogue in quotes, SFX and ambience. That becomes our **Prompt Compiler** (section 5.4). |
| [timoncool/videosos](https://github.com/timoncool/videosos) (1.3k★) | Browser video studio: Next.js, multi-track timeline, FFmpeg, 100+ models via fal.ai/Runware, lip-sync | Multi-track timeline, **cost shown per item and per project**, provider adapters so you are not locked to one vendor, keyboard shortcuts, advanced settings hidden until needed. |
| [loofiboss-bit/Loofi-Veo-prompt-generator](https://github.com/loofiboss-bit/Loofi-Veo-prompt-generator) | Local-first creator studio with **approval-gated** steps | Workflow **Brief → Scenes → Assets → Generate → Review → Export**, a "Production Bible", prompts stored as structured JSON with alternatives, and **no paid call without an explicit OK and a cost cap**. |
| [Anil-matcha/veo3.1-comfyui](https://github.com/Anil-matcha/veo3.1-comfyui) | ComfyUI nodes for Veo 3.1 with 4K upscale | Node/step thinking. A final upscale pass is an optional step. |
| [ishandutta2007/veo_prompts](https://github.com/ishandutta2007/veo_prompts), awesome-veo-3-prompts | Prompt collections | Seed data for our prompt library and style presets. |
| [SamurAIGPT/veo4-video-generator](https://github.com/SamurAIGPT/veo4-video-generator) | Next.js SaaS (auth + billing) | Useful later if you sell the studio as a service. **Note:** Google has not released a "Veo 4". Repos with "Veo 4" in the name are third-party wrappers. Google's newer video model is **Gemini Omni Flash**. |

---

## 2. Models and services (as of Oct 2026)

> All model IDs live in `config.py`, not in code. **Phase 0 checks each one against your API keys** because Veo 3.1 is still "preview" and its IDs may change.

### Google (main provider)
| Job in the studio | Model | Why |
|---|---|---|
| Director, writer and shot planner (the agent's brain) | `gemini-3.8-flash` (default), `gemini-3.1-pro-preview` (heavy scripts) | Function calling and JSON structured output, fast and cheap. Writes natively in all 5 languages. |
| Character sheets, locations, keyframes, thumbnails | `gemini-nano-banana-2.1` (default), `gemini-3-pro-image` (hero quality) | Keeps the same face across many images and edits images with a text instruction |
| Video: Saver (default) | `veo-3.1-lite-generate-preview` | $0.05/s. Animates an approved keyframe (image-to-video). Cannot use reference images or extension. |
| Video: Balanced | `veo-3.1-fast-generate-preview` | $0.10–0.12/s. Up to 3 reference images, first+last frame, extension |
| Video: Hero | `veo-3.1-generate-preview` | $0.40/s. Best quality, for a few key shots only |
| Conversational editing ("remove the cup", "make it night") | `gemini-omni-1.1-flash` (Interactions API) | Multi-turn edit using `previous_interaction_id`, plus subject reference and extension. About $0.10/s |
| Character voices and narration | `gemini-3.8-flash-tts` | **Custom voices:** *Voice Design* makes a voice from a text description, and *Voice Replication* copies a real voice (needs that person's consent recording). Also 30 prebuilt voices, 130+ languages including Hindi, Kannada, Telugu and Tamil, and style tags like `[whispers]` |
| Background music | `lyria-3.5` | Full-length music generation |
| Subtitles and dialogue check | `gemini-3.5-transcribe` | Captions (SRT) and checking that the spoken line matches the script |
| QC reviewer | `gemini-3.8-flash` (vision) | Compares frames from a clip with the character sheet and flags drift |

### Outside Google (you approved ElevenLabs and sync.so; the others are to test)
| Job | Service | Why | Price (verify) |
|---|---|---|---|
| **Lip-sync** for dialogue shots | **sync.so**: `lipsync-2` (default), `lipsync-2-pro` (close-ups, beards, teeth), `sync-3` (side angles, 4K) | Lips follow whatever audio we give it, so it suits all 5 languages | $0.04–0.05/s · $0.067–0.083/s · $0.107–0.133/s. Plans from $5/mo |
| **Voice changer** (keep Veo's acting, swap in the locked voice) | **ElevenLabs** `eleven_multilingual_sts_v2` | Lip timing stays identical. Lists English, Hindi and Tamil, but **not Kannada or Telugu** | ElevenLabs credit plan |
| Premium emotional TTS | **ElevenLabs** `eleven_v3` / `eleven_v4` | Very expressive. Supports Hindi, Kannada, Telugu and Tamil | ElevenLabs credit plan |
| Indian-language TTS (budget, to test) | **Sarvam AI Bulbul v3** | Built for Indian languages, Indian names and Hinglish/Tanglish | about ₹30 per 10,000 characters |
| Optional: one key for many models | **fal.ai** | Pay per use with no subscription. Alternative lip-sync and cheaper video models to compare | per model |

### Hard limits that shape the design (Veo 3.1)
- Clip length is **4, 6 or 8 s**. Reference images, 1080p, 4K and interpolation all require **8 s**. So **an 8-second shot is our basic unit**, with 4 or 6 s for short dialogue or inserts.
- At most **3 reference images** per shot, and only on Standard and Fast, not Lite.
- **Extension** adds +7 s per hop, up to 148 s total, at **720p only**, and not on Lite.
- Aspect ratio is **16:9 or 9:16** only. For 1:1 we crop in FFmpeg.
- Prompt limit is about 1,024 tokens.
- **Google deletes generated videos after 2 days**, so workers download every clip immediately.
- Latency is 11 s to 6 min, so everything runs as a background job with live progress.
- Native dialogue audio is tested in **English only**. Section 6 explains how we handle the other 4 languages.

### What it costs (Saver mode)
**Assumptions:** 8 s shots, 1.5× for retakes, about half of the runtime has dialogue that needs lip-sync (`lipsync-2`). Prices are Sept 2026 and need checking.

| Output | Video (Lite) | Lip-sync | Images + voice | **Total** |
|---|---|---|---|---|
| 30 s ad | ~$2.40 | ~$0.75 | < $1 | **~$4–5** |
| 60 s short | ~$4.80 | ~$1.60 | < $1 | **~$7–8** |
| 10 min episode | ~$45 | ~$15 | ~$3–8 | **~$65–70** |
| Same episode dubbed into 1 more language (section 6) | $0 | ~$15 | ~$1 | **~$16** |

- **Balanced** mode roughly doubles the video column. **Hero** shots ($0.40/s) are for a handful of moments only.
- **Fixed monthly costs:** server ₹0 on Unraid (or about $10–30 for a VPS), sync.so plan from $5, ElevenLabs lowest plan if used.
- **Ways we keep it low:** keyframe-first, an animatic preview before any video, Saver as the default, at most 2 auto-retakes, reuse of B-roll and establishing shots across episodes, and spend caps with alerts.

---

## 3. Design principles

1. **Bible first.** Characters, voices, locations and style are created once, approved, then *locked* (versioned). Every shot reads from the Bible. Nothing is re-described from scratch.
2. **Keyframe first.** Each shot gets a still keyframe (Nano Banana, a few cents) with the characters already in it. You approve it, and only then is it animated. This also lets the cheap Lite model keep faces correct.
3. **Agent proposes, people approve.** Each stage ends in an approval card. "Autopilot" mode can skip the cards but still stops at the budget gates.
4. **Everything is structured JSON.** The hierarchy is Project → Episode → Scene → Shot → Take. The agent and the UI edit the same data.
5. **Deterministic prompt compiler.** The LLM writes only the shot-specific part. Character descriptions are pasted **word for word** from the Bible, because paraphrasing a character each time causes drift.
6. **Every take is kept.** Each shot can have many takes. Compare them side by side and pick one. Nothing is overwritten.
7. **Cost is visible everywhere.** You see an estimate before each run, a ledger after it, and caps per person, per project and per month.
8. **Provider adapters.** Veo, Omni, ElevenLabs, sync.so, Sarvam and fal.ai all plug into the same interface, so swapping one is a config change.

---

## 4. Pipeline: from concept to final video

```
 CONCEPT ──► BRIEF ──► HOOKS ──► STORY ──► BIBLE ──► SHOT LIST ──► STORYBOARD ──► ANIMATIC ──► VIDEO ──► VOICE + ──► EDIT ──► EXPORT
  (text,     format,   5–10      logline   cast,     scenes →      keyframe       keyframes    Veo /     LIP-SYNC    timeline  9:16 / 16:9
  voice      length,   options,  → beats   voices,   shots,        per shot       + TTS +      Omni      voice lock  captions  thumbnails
  note,      aspect,   scored    → script  places,   camera,       (cheap)        temp music   (paid,    music, mix  titles    SRT, dubs
  ref imgs)  language                      style     dialogue                     (cheap)      gated)
     │          │        ✓          ✓        ✓          ✓             ✓              ✓           ✓ $        ✓          ✓         ✓
     └──────────────── ✓ = approval card (Co-pilot mode)   $ = budget gate (always) ────────────────────────────────────────────┘
```

| # | Stage | Agent does | Team does |
|---|---|---|---|
| 0 | Concept | Takes text, voice note, reference images/videos or a sample ad | Type or paste the idea |
| 1 | Brief | Fills in format (series/short/ad), length, aspect, audience, tone, **language(s)**, budget | Confirm or edit |
| 2 | Hooks | Writes 5–10 hooks for the first 1.5–3 s (question, bold claim, visual shock, pattern break) and scores each | Pick one, or mix two |
| 3 | Story | Logline → beat sheet → full script with dialogue, written natively in the chosen language. For a series it also writes the season arc and episode outlines | Edit inline |
| 4 | Bible | Proposes characters, voices, locations and style. Generates character sheets and voice samples | Producer approves and locks |
| 5 | Shot list | Splits scenes into shots with framing, camera move, action, dialogue, SFX, music cue, refs and mode. For dialogue, it records the voice line first and sizes the shot to it | Reorder, edit, delete |
| 6 | Storyboard | Generates one keyframe per shot | Approve or regenerate per card |
| 7 | Animatic | Plays keyframes + real TTS dialogue + temp music to show timing and pacing | Check flow before paying |
| 8 | Video | Shows a cost estimate, then **budget gate**, then queues the jobs. Downloads clips, runs QC, auto-retakes failures (within cap) | Pick the best take |
| 9 | Voice + lip-sync | Voice lock or lip-sync (section 6), Lyria music, SFX, loudness at −14 LUFS for social | Adjust levels |
| 10 | Edit | Assembles the timeline, adds transitions, styled burned-in captions (Indian scripts supported), title and end card | Trim and reorder |
| 11 | Export | Platform presets (Shorts/Reels/YouTube), thumbnail (Nano Banana), SRT, **dubs into other languages** | Download or publish |

---

## 5. Consistency engine (characters, places, style)

### 5.1 Character Bible
Each character has:
- **Character DNA:** a fixed text block of 60–80 words covering age, face, skin, hair, eyes, build, signature outfit and distinguishing marks. It is pasted word for word into every prompt.
- **Turnaround sheet:** front, ¾, profile and full body, generated by Nano Banana from one photo or from the DNA text.
- **Expression sheet:** neutral, happy, angry, sad, surprised.
- **Outfit variants:** for example "Ep 3, wedding outfit". The variant is tied to the episode or scene.
- **Voice profile:** see section 6.
- **Lock and version:** once approved, a change creates v2. Old episodes keep v1.

Locations and Style follow the same pattern. Locations have wide, medium and detail images plus time-of-day variants. Style covers look, lens, colour grade, film grain and an "avoid" list.

### 5.2 Getting the characters into each shot
- **Saver mode:** Nano Banana composes the keyframe from the character sheets, the location and the previous frame. Lite then animates that keyframe, so the identity comes from the image.
- **Balanced/Hero mode:** Veo takes up to 3 refs directly. The agent picks them:
  - 1 character in shot: the character's front ref, the ¾ ref and the location wide shot.
  - 2 characters: character A, character B and the location.
  - 3 or more characters: fall back to the keyframe route.

### 5.3 Continuity between shots
- **Same continuous action:** take the last frame of shot N (FFmpeg) and use it as the start of the shot N+1 keyframe.
- **Long continuous take:** Veo **extension** (+7 s per hop, 720p, Fast or Standard).
- **Controlled transition:** **first + last frame** interpolation (both are keyframes you approved).
- **Small fix inside a clip:** Gemini Omni multi-turn edit ("remove the extra person on the left").

### 5.4 Prompt Compiler (deterministic template)
The LLM fills only `[SHOT]`, `[DIALOGUE]` and `[AUDIO]`. Everything else comes from the Bible.
```
[STYLE]      Cinematic, warm tungsten and dusk-blue palette, 35mm film grain, shallow depth of field, soft haze.
[LOCATION]   Temple courtyard at dusk, worn stone floor, rows of brass oil lamps, distant gopuram silhouette.
[CHARACTERS] Ravi: 28-year-old Indian man, lean build, short wavy black hair, light stubble, deep-set brown eyes,
             cream kurta with maroon border, thin silver chain. Meera: <her DNA, word for word>
[SHOT]       Medium two-shot. Slow dolly-in. Ravi turns from the lamp to face Meera, hesitant.
[DIALOGUE]   Ravi says quietly, "I saw him again last night." Meera replies calmly, "Then it wasn't a dream."
[AUDIO]      Temple bells far away, crickets, oil lamps flickering. Low tanpura drone.
[AVOID]      Subtitles, on-screen text, extra people, warped hands.   (→ negativePrompt where supported)
```
For audio-first shots (section 6, mode C), `[DIALOGUE]` becomes *"Ravi speaks quietly to Meera"* so the face moves naturally, and the real line is lip-synced afterwards.

### 5.5 QC reviewer
After each clip finishes, the worker samples 4 frames and sends them to Gemini vision with the character sheet. The model returns:
`{identity_match: 0–1, outfit_match, extra_people, text_artifacts, hand_issues, matches_action}`
Takes below the threshold are flagged in red. They are auto-retaken only if retakes are on and the budget allows.

---

## 6. Voice and lip-sync (same voice every episode, 5 languages)

**Do Veo and Gemini give lip-synced voice?** Yes. Veo 3.1 and Gemini Omni Flash create the voice and the lip movement together, already in sync, at no extra cost. There are two catches:
1. **You can't pin a character's voice.** Each clip gets its own voice, so a series character sounds different from shot to shot and episode to episode.
2. **Google only tests this dialogue in English.** Hindi, Kannada, Telugu and Tamil may come out mispronounced or garbled. Phase 0 tests this, and if it is good enough we save money.

So the studio uses Veo's built-in lip-sync wherever those catches don't matter, and a locked-voice route everywhere else.

| Mode | How it works | Use for |
|---|---|---|
| **A. Native** | Veo makes voice and lips together | English ads and shorts with one-off characters. Cheapest. |
| **B. Voice Lock** | Veo makes voice and lips → Demucs (runs on CPU) splits the voice from the background sound → ElevenLabs voice changer turns it into the character's locked voice → mix back. Lip timing is unchanged. | English, Hindi and Tamil series dialogue when Veo's acting looks good. **Not for Kannada or Telugu.** |
| **C. Audio first** (default for series) | Write the line → TTS in the character's locked voice → measure its length → choose a 4, 6 or 8 s shot → Veo makes the shot with the character talking → sync.so re-syncs the lips to our audio | **All 5 languages.** Most control over every word. |
| **Narration** | TTS voice-over with no visible speaker | Explainers, devotional stories, ads with VO |

### Language plan
| Language | Default mode | TTS options compared in Phase 0 (blind listening test) |
|---|---|---|
| English | A for ads/shorts, B or C for series | Gemini TTS, ElevenLabs |
| Hindi | C (B if Veo's Hindi passes Phase 0) | Gemini TTS, ElevenLabs v3, Sarvam Bulbul |
| Tamil | C (B if Veo's Tamil passes Phase 0) | Gemini TTS, ElevenLabs v3, Sarvam Bulbul |
| Kannada | C | Gemini TTS, ElevenLabs v3, Sarvam Bulbul |
| Telugu | C | Gemini TTS, ElevenLabs v3, Sarvam Bulbul |

The winner for each language is chosen by how it sounds to your team, not by marketing claims.

### Voice profile per character
Each profile stores: one voice ID per language and provider (for example Gemini `voice_…` for Kannada, ElevenLabs for English), a style prompt (age, accent, pace, pitch, default emotion), a sample clip per language, and, for mode B, the ElevenLabs target voice.
New character voices are made with **Voice Design** (Gemini or ElevenLabs) from a text description, for example *"warm, deep male voice, mid-50s, calm, slight Kannada accent"*. Real people's voices are only replicated with their recorded consent.

### Dub mode: one episode in 5 languages
1. Keep the same video.
2. The agent adapts the script into the new language (natural phrasing, not word for word) and keeps line lengths close.
3. TTS each line in the same character's voice in the new language.
4. sync.so re-syncs the lips.

This costs about **$16 per extra language** for a 10-min episode, instead of about $65 to remake it.

### Notes
- sync.so `lipsync-2` needs the mouth to be moving in the input video, so dialogue-shot prompts always say the character is speaking. `sync-3` can open closed lips and handles side angles.
- Captions use Noto Sans fonts for the Devanagari, Kannada, Telugu and Tamil scripts.
- Gemini TTS multi-speaker takes at most 2 prebuilt voices per call, so custom voices are generated line by line and joined, which is what we want for editing anyway.

---

## 7. The agent ("Director")

A chat panel that is always open on the right. It works on whatever you have selected.

**Modes**
- **Co-pilot** (default): the agent stops at every approval card.
- **Autopilot:** concept → finished video. It stops only at budget gates and on QC failures.
- **Command:** one-off orders such as *"Regenerate every shot with Ravi in his Ep 3 outfit"*, *"Make shot 4 more tense"*, *"Give me 3 more hooks, funnier"*, *"Cut this episode into three 30 s shorts"*, *"Dub episode 2 into Telugu"*.

**Roles.** One model with different system prompts, kept in `backend/app/agents/prompts/*.md`: Writer · Casting · DP/Director (camera language) · Prompt Engineer · Editor · Dubbing/Localization · QC Reviewer.

**Tools the agent can call** (Gemini function calling; each is also a REST endpoint the UI uses):
```
brief.update            hooks.generate(n)          story.write_script        story.localize(lang)
bible.create_character  bible.generate_sheet       bible.design_voice        bible.lock
bible.create_location
shots.breakdown         shots.update               shots.compile_prompt
keyframe.generate       video.generate(model,mode) video.extend              video.edit (Omni)
voice.speak(lang)       voice.lock_clip            lipsync.apply             music.generate
captions.generate       timeline.assemble          export.render             export.dub(lang)
cost.estimate           qc.review
```

**Guardrails**
- Any call that spends money first returns `cost.estimate` and waits for approval (or uses the autopilot allowance).
- It respects the person's, project's and team's spend limits (section 10).
- All agent outputs are validated against Pydantic schemas. Invalid output is shown as a draft and never silently saved.

**Series memory.** Each episode is summarised (who knows what, open threads, outfit and location state) and fed into the next episode's planning so the story stays consistent.

---

## 8. Format templates

| Template | Defaults |
|---|---|
| **Web series episode** | 16:9 or 9:16, 3–10 min, season arc, cold-open hook, end-of-episode cliffhanger, audio-first voices, dub mode |
| **Short / Reel** | 9:16, 15–60 s, hook in the first 1.5 s, styled captions, loop-friendly ending |
| **Ad (15 / 30 s)** | Hook → problem → product → proof → CTA, logo end card, 3 hook variants for A/B testing |
| **Explainer / VO story** | Narration (TTS), B-roll shots, music bed |
| **Devotional / mythology story** | Narration + character scenes, traditional music cues, reverent style preset |

**Hook engine:** generates N hooks, scores them (curiosity, clarity, visual strength, platform fit) and can render the top 3 as separate first shots for A/B tests.

---

## 9. UI / UX

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ VEO STUDIO  ▸ "Kaal Chakra" ▸ Ep 1 ▸ [EN|HI|KN|TE|TA]   Team: $23 / $60  👤3 │
├──────────┬──────────────────────────────────────────────┬────────────────────┤
│ Brief    │                                              │  DIRECTOR (agent)  │
│ Story    │   STORYBOARD   [Grid] [Timeline]             │                    │
│ Bible    │   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │  > make shot 3     │
│ Board ◄  │   │ SH1  │ │ SH2  │ │ SH3  │ │ SH4  │  ...   │    more tense      │
│ Timeline │   │ ✓ v2 │ │ ⏳62%│ │ ⚠ QC │ │ 💬 2 │        │                    │
│ Export   │   └──────┘ └──────┘ └──────┘ └──────┘        │  [Approve] [Retry] │
├──────────┴──────────────────────────────────────────────┴────────────────────┤
│ Jobs: SH2 Veo Lite 62% · SH5 queued (Priya) · SH1 done ✓   Animatic ▶  Render │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Home:** a big "Start from a concept" box plus project cards.
- **Language switch** at the top. It shows the same episode in each dubbed language.
- **Shot card:** keyframe or clip thumbnail, status, takes (v1, v2…), comment count, Approve / Regenerate / Edit prompt / Compare takes.
- **Bible:** character cards with turnaround, expressions, a voice sample ▶ for each language, and a lock 🔒 icon.
- **Timeline:** tracks for video, dialogue, music, SFX and captions. Drag to reorder, trim handles.
- **Live updates:** job progress and teammates' changes arrive over WebSocket, with no page refresh.
- **Keyboard:** `A` approve · `R` regenerate · `←/→` next shot · `Space` play · `Ctrl+K` command the agent.
- **Undo** everywhere. Every take and every Bible version is kept.

---

## 10. Team and roles

- **Login:** Google sign-in for team members with Google accounts, plus email/password invites. Admin invites people; there is no public sign-up.
- **Roles**

| Role | Can |
|---|---|
| Admin | Manage users, API keys, monthly team budget, model settings |
| Producer | Approve spending above limits, lock the Bible, approve the final export |
| Creator | Write, generate keyframes, videos and voices within their own spend limit |
| Reviewer | Watch, comment, approve or reject takes |
| Viewer | Watch only |

- **Spend controls:** a monthly team cap, plus per-person and per-project limits. Anything above a limit becomes an approval request to a Producer. Alerts fire at 50%, 80% and 100%.
- **Working together:**
  - Everyone sees new takes appear live.
  - Comments with @mentions on any shot or take.
  - A shot is locked while it is generating, so two people never pay for the same shot twice.
  - An activity log shows who generated what and what it cost.
- **Shared library:** characters, voices, locations and styles can be shared across projects, so a series "universe" is reused.
- **Security:** API keys are stored encrypted on the server and only Admins can see them. They are never sent to the browser.

---

## 11. Architecture, tech stack and hosting

```
 Team browsers ──HTTPS──► Cloudflare Tunnel (or VPS) ──► FastAPI (Python) ──► PostgreSQL
                                                            │
                                                            ├──► Redis queue ──► Workers ──► Google (Veo · Omni · Nano Banana · TTS · Lyria · Gemini)
                                                            │                      │      └─► ElevenLabs · sync.so · (Sarvam · fal.ai)
                                                            │                      └──► FFmpeg + Demucs (CPU)
                                                            └──► Media store (local disk on Unraid/PC, or Cloudflare R2 on a VPS)
```

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite + TypeScript, Tailwind + shadcn/ui, Zustand, TanStack Query, dnd-kit | Fast, smooth drag-and-drop UI |
| Backend | Python 3.12 + FastAPI + Pydantic + SQLAlchemy | One `google-genai` SDK covers every Google model. Same language as KUNDLI V4. |
| Auth | Google OAuth + email/password, session cookies, role checks on every endpoint | Team logins (section 10) |
| Jobs | Redis + ARQ workers | Video calls take minutes and need polling, retries, concurrency limits and rate-limit backoff |
| DB | PostgreSQL | Projects, shots, takes, users, comments, cost ledger |
| Media | One storage layer: local disk, or any S3-compatible bucket (Cloudflare R2) | Moving between hosts needs no code change. Clips must be downloaded within 2 days |
| Video and audio tools | FFmpeg, Demucs (CPU) | Frames, concat, crop, mix, burned captions, −14 LUFS, voice/background split |
| Packaging | Docker Compose: api · worker · redis · postgres · frontend · cloudflared | Same setup on Windows, Unraid or a VPS |
| Optional | Make.com webhook when an export finishes (WhatsApp notify or auto-post) | Fits your existing workflows |

### Where it runs
**No NVIDIA GPU is needed.** All the heavy AI runs on Google, ElevenLabs and sync.so servers. Our server only runs the website, the job queue, FFmpeg and Demucs, so a normal CPU is enough.

| Option | Cost | Good | Watch out |
|---|---|---|---|
| Windows PC (Docker Desktop) | ₹0 | Easiest for building and testing | The team can't reach it when the PC is off |
| **Unraid + Cloudflare Tunnel** (recommended to start) | ₹0 extra | Lots of disk for videos; secure HTTPS link for the team from anywhere; no open router ports | Depends on office power and internet upload speed |
| VPS (4 vCPU / 8 GB) + Cloudflare R2 for videos | about $10–30/month plus storage | Always on and fast for a remote team | Monthly bill; VPS disks are small, so videos go to R2 (no download fees) |

**Recommendation:** build and test on Windows, then run it for the team on Unraid behind Cloudflare Tunnel. If uptime becomes a problem, move the same Docker setup to a VPS. That takes about a day and no code changes. **The final choice can wait until the end of Phase 1.**

---

## 12. Data model

| Table | Key columns |
|---|---|
| `users` / `teams` | email, name, role, auth provider, monthly_spend_limit |
| `projects` | id, team_id, type (series/short/ad/explainer), title, aspect, languages[], style_id, budget_cap, quality_mode (saver/balanced/hero), mode (copilot/autopilot) |
| `project_members` | project_id, user_id, role override |
| `episodes` | project_id, season, number, outline, summary_for_next |
| `characters` | id, library_id, name, dna_text, version, locked |
| `character_assets` | character_id, kind (front/three_quarter/profile/full/expression/outfit), episode_scope, path, approved |
| `voice_profiles` | character_id, language, provider, voice_id, style_prompt, sample_path, sts_target_voice |
| `locations` / `location_assets` | name, description_text, time-of-day variants, images |
| `style_guides` | look, lens, grade, grain, avoid_list |
| `scenes` | episode_id, order, location_id, time_of_day, summary |
| `shots` | scene_id, order, duration, framing, camera, action, dialogue (JSON per language), sfx, music_cue, mode, ref_ids, continuity_from, compiled_prompt, voice_mode, status, locked_by |
| `takes` | shot_id, kind (keyframe/video/audio/lipsync), language, provider, model, params (JSON), cost, path, qc (JSON), selected, created_by |
| `jobs` | type, payload, status, provider_operation_id, attempts, error, cost_estimate, cost_actual, requested_by |
| `approvals` | job_id or export_id, requested_by, approver, status |
| `comments` | target (shot/take), user_id, body, mentions |
| `timelines` | episode_id, language, tracks (JSON) |
| `agent_messages` | project_id, user_id, role, content, tool_calls |
| `cost_ledger` | team_id, project_id, user_id, job_id, provider, model, units, usd |

**Shot example**
```json
{
  "shot_id": "E01-S03-SH02",
  "duration_s": 8,
  "aspect": "9:16",
  "quality_mode": "saver",
  "mode": "keyframe_to_video",
  "characters": ["ravi", "meera"],
  "location": "temple_courtyard_dusk",
  "framing": "medium two-shot",
  "camera": "slow dolly-in, 35mm, shallow depth of field",
  "action": "Ravi turns from the lamp to face Meera, hesitant.",
  "dialogue": {
    "en": [
      {"character": "ravi",  "line": "I saw him again last night.", "emotion": "hushed, uneasy"},
      {"character": "meera", "line": "Then it wasn't a dream.",      "emotion": "calm, certain"}
    ],
    "kn": [
      {"character": "ravi",  "line": "ನಿನ್ನೆ ರಾತ್ರಿ ಅವನನ್ನು ಮತ್ತೆ ನೋಡಿದೆ.", "emotion": "hushed, uneasy"},
      {"character": "meera", "line": "ಹಾಗಾದರೆ ಅದು ಕನಸಲ್ಲ.",              "emotion": "calm, certain"}
    ]
  },
  "voice_mode": "audio_first",
  "sfx": "temple bells far away, crickets, oil lamp flicker",
  "music_cue": "low tanpura drone enters",
  "continuity_from": "E01-S03-SH01.last_frame",
  "refs": ["char:ravi:front", "char:meera:three_quarter", "loc:temple_courtyard_dusk:wide"]
}
```

---

## 13. Folder structure

```
VEO_STUDIO/
├─ backend/
│  ├─ app/
│  │  ├─ main.py · config.py (all model IDs + prices here)
│  │  ├─ auth/         google_oauth.py · sessions.py · roles.py
│  │  ├─ api/          projects, bible, story, shots, takes, jobs, agent, export, comments, users, ws
│  │  ├─ agents/       director.py · tools.py · prompts/ (writer, casting, dp, editor, localization, qc)
│  │  ├─ providers/    base.py · gemini_text.py · nano_banana.py · veo.py · omni.py · gemini_tts.py · lyria.py
│  │  │                elevenlabs.py · syncso.py · sarvam.py · fal.py
│  │  ├─ pipeline/     prompt_compiler.py · ref_picker.py · continuity.py · qc.py · voice.py · lipsync.py
│  │  │                dubbing.py · audio_mix.py · captions.py · assembler.py · cost.py · budget.py
│  │  ├─ storage/      local.py · s3.py (R2)
│  │  ├─ workers/      queue.py · video_jobs.py · image_jobs.py · audio_jobs.py
│  │  ├─ models/       SQLAlchemy tables
│  │  └─ schemas/      Pydantic (Brief, Hook, Script, Character, VoiceProfile, Shot, Take, QCResult…)
│  └─ tests/           fake providers (no paid calls in tests)
├─ spike/              Phase 0 test scripts + results
├─ frontend/
│  └─ src/
│     ├─ pages/        Login · Home · Brief · Story · Bible · Storyboard · Timeline · Export · Team
│     ├─ components/   AgentPanel · ShotCard · TakeCompare · CharacterCard · VoicePlayer · JobTray · CostMeter · Comments · Timeline/
│     └─ store/ · api/
├─ media/              (git-ignored) generated files
├─ docker-compose.yml
├─ .env.example
└─ PLAN.md
```

---

## 14. Roadmap

| Phase | Goal | Deliverables | Done when |
|---|---|---|---|
| **0. API spike** (3–4 days, about $20–30 of API credit) | Prove every model and service works, and pick the winners | Scripts in `spike/` that call each service and log quality, latency and cost | See the Phase 0 checklist below |
| **1. MVP: Concept → Short** (~2 weeks) | End-to-end path for the team | Login (Google + email) with Admin/Creator/Viewer roles · Brief → hooks → script → shot list → keyframes → Veo Lite clips → FFmpeg concat → MP4 · Co-pilot agent · job queue · auto-download · cost estimate · monthly team cap | Two team members log in, and one makes a 30–60 s 9:16 short from one sentence for under $10 |
| **2. Consistency engine** (~2 weeks) | Same characters and places in every shot | Character/Location/Style Bible, turnaround generator, prompt compiler, keyframe composer, ref picker, last-frame continuity, extension, QC reviewer, quality modes | 10 shots of the same character pass QC ≥ 0.8 identity match in Saver mode |
| **3. Voice, lip-sync and languages** (~2 weeks) | Same voices in all 5 languages | Voice profiles + Voice Design · audio-first mode (C) with sync.so · Voice Lock mode (B) with Demucs + ElevenLabs · narration · Lyria music · mixing · Indian-script captions · **dub mode** | The same character sounds identical in 3 episodes, and one episode is dubbed into Kannada with synced lips |
| **4. Editor UX and teamwork** (~2 weeks) | Smooth and interactive for the team | Multi-track timeline, takes compare, drag-and-drop, animatic, shortcuts, live job tray, undo · all 5 roles · comments and @mentions · per-person limits and approval requests · activity log | A full episode is edited and approved by different team members without leaving the app |
| **5. Full agent / Autopilot** (~1–2 weeks) | "Make it for me" | Autopilot with budget gates, bulk commands, series memory, templates, hook A/B variants, shared library | One concept becomes a finished short with zero clicks except the budget approval |
| **6. Scale and extras** | Grow | Omni chat-editing, more providers via fal.ai, Make.com publishing, analytics, 4K upscale, move to a VPS if needed | As needed |

### Phase 0 checklist
1. Confirm every model ID on your keys.
2. **Veo native dialogue** in Hindi, Kannada, Telugu and Tamil. Is it good enough for mode A or B?
3. **Veo 3.1 Lite image-to-video:** does it keep the face from the keyframe? Saver mode depends on this.
4. Veo Fast: 3 refs, first+last frame, extension. Can `image` and `referenceImages` be used together?
5. Nano Banana: the same face across 4 keyframes in different scenes.
6. **Blind listening test** in each language: Gemini TTS (designed voice) vs ElevenLabs v3 vs Sarvam Bulbul.
7. sync.so `lipsync-2` vs `lipsync-2-pro` on a Kannada and a Telugu line.
8. ElevenLabs voice changer on Hindi and Tamil Veo dialogue.
9. Real latency and cost of each call, logged to a sheet.

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Veo is "preview", so the API or IDs may change | Provider adapters; model IDs in config; Phase 0 checks |
| Lite can't hold faces well enough | Phase 0 test; fall back to Fast with refs for those shots (about double the video cost) |
| Characters drift between shots | Bible + word-for-word DNA + keyframe-first + refs + QC + retakes |
| Voices change between clips | Audio-first (C) or Voice Lock (B) |
| Veo mispronounces Indian languages | Audio-first + sync.so for those languages |
| ElevenLabs voice changer lacks Kannada/Telugu | Use mode C for those two languages |
| Lip-sync weak on side angles or covered mouths | Plan dialogue shots facing camera; use `sync-3` where needed |
| Costs run away | Saver default, animatic before video, approval gates, per-person/project/team caps, alerts, cost ledger |
| Too many subscriptions | Start on the lowest plans or pay-as-you-go (fal.ai) and review monthly |
| Clips deleted after 2 days | Worker downloads on completion and verifies the file before marking the take ready |
| Office internet or power down (Unraid) | Same Docker setup moves to a VPS in about a day |
| Safety filters block a prompt | Show the reason, let the agent suggest a rephrase. Ref images only allow adults (`allow_adult`) |
| Rate limits and quotas | Queue concurrency limit, exponential backoff, resumable jobs |
| Real faces, voices and likeness | Only use people who have given consent (voice replication needs a consent recording). Outputs carry a SynthID watermark. Turn on the platform "AI-generated" label for YouTube and Instagram |

---

## 16. Decisions

| Question | Your answer | What the plan does |
|---|---|---|
| Where it runs | Not sure: VPS, Unraid or Windows | Docker everywhere. Build on Windows, run on Unraid + Cloudflare Tunnel, move to a VPS if needed. Final call at the end of Phase 1 |
| Non-Google tools | ElevenLabs + sync.so OK, open to others | sync.so for lip-sync, ElevenLabs for voice changer and premium TTS. Sarvam AI and fal.ai added as options to test |
| NVIDIA GPU | No | All AI runs through cloud APIs; only CPU tools locally (FFmpeg, Demucs) |
| Languages | English, Hindi, Kannada, Telugu, Tamil | Audio-first voices, best TTS chosen per language, dub mode, Indian-script captions |
| Budget | As low as possible | Saver mode default, animatic before video, caps and alerts |
| Users | Team | Logins, 5 roles, spend limits, approvals, comments, shared library |

### Needed from you to start Phase 0
1. A **Gemini API key with billing turned on** (Veo is paid only).
2. An **ElevenLabs** account (lowest paid plan) and a **sync.so** account (Hobbyist, $5/mo).
3. Optional: a **Sarvam AI** key for the Indian-language voice test.
4. About **$20–30** of total API credit for the tests.

Put the keys in `VEO_STUDIO/.env` yourself, using the names in `.env.example`. Don't paste keys into chat.

---

## 17. v1 build status (2026-10-07)

| Phase | Status | Notes |
|---|---|---|
| 0. API spike | **Ready to run** | `spike/run_spike.py`: 20 tests (~$10.50), blind listening-test folder, report.md. Needs your keys |
| 1. MVP | **Done** | Concept → brief → hooks → script → shots → keyframes → Veo → render; logins; co-pilot agent; cost estimates; team cap |
| 2. Consistency engine | **Done** | Bible (DNA, sheets, expressions, outfits, locations, style), prompt compiler, ref picker, continuity frames, extension, interpolation, QC + auto-retake, quality modes |
| 3. Voice & languages | **Done** | Voice profiles per language (Gemini voice design, ElevenLabs design, Sarvam speakers, prebuilt voices), audio-first + sync.so lip-sync, Voice Lock (ElevenLabs STS; Demucs optional), narration, Lyria music, ducking, −14 LUFS, Indic captions (HarfBuzz shaping verified), dub mode |
| 4. Editor UX & teamwork | **Done** | Drag-and-drop storyboard + timeline, takes compare, animatic, sequence preview, shortcuts, live updates (WebSocket), undo per shot, 5 roles, comments + @mentions, per-person/project/team limits, approvals inbox, activity log |
| 5. Autopilot | **Done** | One budget gate, 13 stages, 1.5× overspend guard, series memory, cut-downs, 20-tool Director agent |
| 6. Extras | **Mostly done** | Omni chat-editing ✔, Make.com webhook ✔, cost analytics ✔, Docker + Cloudflare Tunnel ✔, R2 mirror ✔. **Not built:** fal.ai adapter, 4K upscale pass |

**Changes from the plan while building**
- **No Redis:** the job queue lives in the database (SQLite or Postgres). That is one less service to run, and long Veo jobs resume after a restart without paying twice.
- **SQLite by default** on a single machine. Docker Compose uses Postgres.
- **Interactions API over REST** for all Gemini text, image, TTS, voice, Omni and music calls. Veo uses REST `predictLongRunning`. Both follow the Oct 2026 docs.
- **One speaking character per shot** is enforced in shot planning. It makes lip-sync and Voice Lock reliable.

## 18. v2 build status (2026-10-08)

v2 makes the studio multi-model, more accurate, and adds the writers' room, growth tools and a pro interface. All verified in mock mode (28 backend tests + browser checks); real-API checks are part of Phase 0.

| Area | Status | What's in it |
|---|---|---|
| Model Hub | **Done** | fal.ai catalog sync (~800 models, daily), OpenAPI schema → capabilities → arguments mapper, live pricing, new-model review (first sync files non-policy models as off), routing chains with fallback, per-shot engine picker, shootouts + winner ratings, Google + sync.so built-ins |
| Accuracy | **Done** | Character identity (LoRA) training on fal.ai, identity-aware keyframes, OpenCV face-match QC (optional models), Gemini lip-sync QC, auto-retake on the next engine, audio-driven dialogue (a2v engines), re-dub or regenerate dubbing |
| Writers' room | **Done** | Trend scout, hook insights from analytics, critic loop with scores, table read with line sync, scene cards (goal/conflict/turn/coverage/blocking/wardrobe), continuity check, script versions with diff + restore, native-speaker polish per language, more Autopilot stages |
| Growth | **Done** | Karaoke/clean/boxed captions, auto-reframe, Auto SFX, title + lower-third overlays, brand kits with end card, marketing pack (copy + thumbnails per platform and language), YouTube publish + schedule + thumbnail, analytics → hook learning loop, semantic search, client review links, consent records, audit log |
| Pro UI | **Done** | Motion throughout, command palette (Ctrl+K; Director moved to Ctrl+J), light/dark/system theme, UI in 5 languages (AI-translated, needs native review), onboarding tour, template gallery, installable PWA, pro timeline (waveforms, zoom, snap, J/K/L), review mode with frame drawing, timecoded comments and A/B wipe, page-level code splitting |

**Changes while building v2**
- **Upgrades in place:** `db_migrate.py` adds new tables/columns and relaxes NOT NULL constraints (SQLite tables are rebuilt with their rows), so a v1 database just works.
- **One `run_model()` for every engine:** the router picks a model from the chain, the schema mapper turns the shot into that model's arguments, and failures fall through to the next engine.
- **Shootout takes never replace the take in use** and skip auto-retakes; the team picks the winner.

---

## Sources
- Veo 3.1 API docs: https://ai.google.dev/gemini-api/docs/veo
- Gemini Omni Flash docs: https://ai.google.dev/gemini-api/docs/omni
- Gemini models list: https://ai.google.dev/gemini-api/docs/models
- Gemini API changelog: https://ai.google.dev/gemini-api/docs/changelog
- Gemini TTS (incl. Voice Design / Replication): https://ai.google.dev/gemini-api/docs/speech-generation
- Veo 3.1 launch post: https://developers.googleblog.com/introducing-veo-3-1-and-new-creative-capabilities-in-the-gemini-api/
- Veo pricing summary: https://benchlm.ai/media-pricing/veo
- Omni Flash pricing: https://www.eesel.ai/blog/gemini-omni-flash-pricing
- Veo 4 status: https://aireiter.com/blog/veo-4
- ElevenLabs models: https://elevenlabs.io/docs/models
- ElevenLabs Eleven v3 languages: https://elevenlabs.io/blog/eleven-v3
- sync.so lipsync models: https://sync.so/docs/models/lipsync
- sync.so pricing: https://sync.so/pricing
- Sarvam AI TTS: https://www.sarvam.ai/apis/text-to-speech.md
- References: https://github.com/veo-3/veo-3 · https://github.com/topics/google-veo · https://github.com/timoncool/videosos · https://github.com/loofiboss-bit/Loofi-Veo-prompt-generator
