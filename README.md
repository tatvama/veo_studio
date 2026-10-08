# VEO Studio

An AI video studio for teams. You give it a concept, and it takes you from hook to script, scene plan, cast and voices, shot list, keyframes, video, lip-sync, music, sound and the final edit, in **English, Hindi, Kannada, Telugu and Tamil**.
It isn't tied to one AI provider: the **Model Hub** keeps a live catalog of about 800 models (Google Veo, Kling, Seedance, Wan, MiniMax, LTX, Luma, Grok, sync.so, HeyGen, ElevenLabs …) and routes every shot to the best engine for the job.
The **Director** agent can do any step for you. Paid steps always show the cost first.

The working plan is [TATVAM_PLAN.md](TATVAM_PLAN.md): the full design, the three surfaces (web studio, desktop finishing room, mobile review app) and the roadmap. The older [PLAN.md](PLAN.md) is kept only as a record of what was built first. This file covers running and using it.

---

## 1. Run it on this Windows PC (development)

You need Python 3.12 and Node 20 or newer. Both are already installed here.

```bash
# backend (first time only)
cd backend
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

```bash
# start the API + background worker on http://localhost:8100
cd backend
.venv\Scripts\python -m uvicorn app.main:app --port 8100 --reload
```

```bash
# start the web app on http://localhost:5173 (second terminal)
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. The first visit asks you to create the **admin account**, then a short tour shows you around.

**No keys yet?** The studio runs in **Mock mode**. You get free placeholder images, video and voices, so the team can learn the whole flow before spending anything.

**Upgrading from v1?** Just start the new version. The database upgrades itself on start (new tables and columns are added, rows are kept).

## 2. Add your API keys

You can add them in either of two places:
- **Settings → AI services & API keys** in the app (admins only). Keys are encrypted with `APP_SECRET`.
- The `.env` file. Copy `.env.example` to `.env` and fill in the keys you have.

| Key | Used for |
|---|---|
| `GEMINI_API_KEY` | Writing, images, Veo video, voices (TTS + voice design), Omni edits, Lyria music, lip-sync and vision QC, search |
| `FAL_KEY` | The Model Hub catalog: Kling, Seedance, Wan, MiniMax, LTX, sync-3, HeyGen and ~800 more; character identity (LoRA) training |
| `ELEVENLABS_API_KEY` | Voices, Voice Lock (voice changer), voice design, sound effects, audio clean-up |
| `SYNC_API_KEY` | sync.so lip-sync |
| `SARVAM_API_KEY` | Optional Indian-language voices (Bulbul) |

Set `APP_SECRET` in `.env` to a long random string before inviting the team.

**YouTube publishing** (optional): create a Google Cloud OAuth client (Web application) with the YouTube Data API v3 and YouTube Analytics API enabled. Add the redirect URI `<PUBLIC_BASE_URL>/api/integrations/youtube/callback`, put the ID and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, then click **Settings → Integrations → Connect YouTube**. The same client also enables Google sign-in.

**Objective face check** (optional, recommended): download two small OpenCV face models (≈ 37 MB) so QC can measure face similarity instead of only asking the vision model:

```bash
backend\.venv\Scripts\python scripts\get_face_models.py
```

## 3. Phase 0: test every service on your keys (about $10)

```bash
backend\.venv\Scripts\python spike\run_spike.py --list
```

```bash
backend\.venv\Scripts\python spike\run_spike.py --all --budget 15
```

The script writes `spike/results/<date>/report.md` with every clip, image and voice sample. It answers the plan's open questions:
- Do the model IDs exist on your key?
- Does Veo 3.1 Lite keep the face from the keyframe? Saver mode depends on this.
- Can Veo take a first frame and reference images together?
- How good is Veo's own Hindi, Kannada, Telugu and Tamil dialogue?
- How do lip-sync and the ElevenLabs voice changer sound?

The voice samples in `listen/` have code names, so the team can do a **blind listening test**. Afterwards, set the winning voice service per language in **Settings → Voices**.

## 4. Daily workflow

| Step | Where | What happens |
|---|---|---|
| Concept | Home | Type the idea or **start from a template** (Short, Reel ad, product ad, web-series episode, devotional story, explainer, music video, kids story). Pick format, frame, languages, look and quality, then **Start** (or turn on **Autopilot**) |
| Brief | Brief tab | AI fills audience, tone, length and CTA. **Trend scout** suggests current trends, hook patterns and formats for your audience. Series: **Plan season** |
| Hook + script | Story tab | 6 scored hooks (with **what worked before** from your YouTube analytics), pick one and **Write script**. Then the **writers' room**: **Critic** scores the draft and the loop rewrites until it passes, **Table read** plays the whole episode in the cast voices, **Continuity** checks props, wardrobe and time of day, **Localization** translates and gives each language a native-speaker polish. Every change is saved in **Versions** with a diff and restore |
| Scenes | Scenes tab | One card per scene: goal, conflict, turn, emotion, cast, props, wardrobe, blocking and coverage plan. Approve the cards, then **Break into shots** follows them |
| Bible | Bible tab | **Build from script** creates the cast, locations and style. Generate sheets and voices, approve images and **Lock**. **Train identity** gives a character a face model so every keyframe keeps the exact face. A consent record is asked for when a real person's face or voice is used |
| Shots | Storyboard tab | **Keyframes** (cents each), then **Videos**, then **Voice + lip-sync**, then **Music**. Click a shot to edit it, pick the **engine** (or Auto), run a **shootout** between 2–4 engines and pick the winner, compare takes, retake, extend, **Edit with words** or approve. Each take shows its engine and QC (face match, lip-sync score) |
| Timeline | Timeline tab | Zoom, snap, J/K/L shuttle, waveforms for dialogue, music and SFX, **Auto SFX**, title and lower-third track, caption preview, music volume and ducking |
| Export | Export tab | **Animatic** (free preview), **Render** (Shorts / Reels / YouTube / Square, karaoke or clean captions, auto-reframe, brand-kit end card), **Dub**, **Cut into shorts**, **Marketing pack** (titles, descriptions, hashtags and thumbnails per platform and language), **Publish to YouTube** (or schedule it), **Client link** |
| Review | Review tab | Frame-accurate player, timecoded comments, draw on the frame, A/B **wipe compare** between renders, approve the final. Clients get a link that works without an account, on phone or desktop |
| Director | Right panel (`Ctrl+J`) | Ask in plain words, e.g. *"dub into Telugu"*, *"Ravi wears his wedding outfit in this episode"*, *"cut this into 3 shorts"*. In Co-pilot mode it proposes the work with a price and you click **Approve** |

**Anywhere:** `Ctrl+K` opens the command palette (pages, projects, actions, theme, language, search). `?` lists every shortcut. **Search everything** finds shots, takes, scenes, characters and renders by what's in them ("Ravi near the lamp at night").

### Quality modes
| Mode | How | ≈ $/second |
|---|---|---|
| **Saver** (default) | Approved keyframe → cheapest good image-to-video engine | 0.05 |
| **Balanced** | Mid-tier engines with up to 3 reference images | 0.10 |
| **Hero** | Best available engine, 1080p or 4K | 0.40 |

Each mode is a **routing chain** in the Model Hub (for example Veo 3.1 Lite → Wan 3.0 → Seedance 2.0 Mini). If an engine fails or is down, the next one in the chain takes over. Admins can reorder the chains.

### Dialogue methods (Settings → Dialogue & dubbing, or per project)
- **Audio-first** (default): the line is spoken in the character's locked voice, then lip-sync moves the mouth to match. All 5 languages.
- **Audio-driven**: the video engine animates the character *from* the voice track (MiniMax H3 lip-sync, Kling AI Avatar, LTX audio-to-video …). Best acting and mouth shapes; falls back to audio-first if no engine is available.
- **Voice lock**: keeps the engine's own acting and swaps in the character's ElevenLabs voice. English, Hindi and Tamil only; one speaker per shot.
- **Native when possible**: the video engine speaks the line itself. Cheapest; good for English ads and shorts.

**Dubbing** either re-syncs the lips on the existing video (**re-dub**, cheaper) or regenerates audio-driven shots per language (**regenerate**, most accurate mouth shapes).

## 5. Model Hub

- **Catalog:** the hub syncs fal.ai's model list every 24 hours (Settings → Model Hub). It reads each model's input schema, works out what it can do (text-to-video, image-to-video, reference-to-video, first/last frame, audio-driven, lip-sync, extend, edit …) and prices it. New releases show up under **New models** for an admin to enable or dismiss. The first sync files everything outside the routing chains as available-but-off, so the team isn't asked to review 800 models at once.
- **Routing policy:** drag to reorder each chain (Saver, Balanced, Hero, Dialogue, Lip-sync, Image, Edit, Extend).
- **Per shot:** the engine picker in the shot drawer shows only engines that can do that shot (reference images, audio, length), with the price. **Shootout** runs the same shot on 2–4 engines; the winner is credited in the hub, so ratings reflect your own results.
- **Quality checks:** every new take is checked for face match (OpenCV, if the face models are installed), extra people, text artifacts and, for dialogue, lip-sync. A failed take is retried automatically on the next engine, up to the retake limit.

## 6. Team, roles and money

| Role | Can |
|---|---|
| Admin | Users, API keys, team budget, settings, Model Hub, audit log |
| Producer | Approve spending over limits, lock the Bible, approve final exports, publish, delete brand kits |
| Creator | Write and generate within their own monthly limit |
| Reviewer | Comment (with @mentions), approve takes, pick shootout winners |
| Viewer | Watch |

How spending is controlled:
- **Team cap:** set a monthly team cap (Settings → Budget). Alerts fire at 50%, 80% and 100%.
- **Personal limits:** each creator has their own monthly limit.
- **Project caps:** each project can have its own cap.
- **Approvals:** anything over a limit goes to the **Approvals** inbox.
- **Costs page:** shows spending by project, by person and by service, plus the full ledger.

**Audit & consent:** the audit log records sensitive actions (keys, settings, publishing, client links, identity training, deletions) with who and from where. Consent records (signed release, scope, expiry) cover cloned voices and real people's faces.

## 7. Interface

- **Sidebar:** labelled sections (Create, Library, Team, System) with your recent projects; collapse it to icons with `[` or the arrow button. On narrow windows it stays slim and opens as a slide-over.
- **Project workspace:** each step (Brief → Story → Scenes → Bible → Storyboard → Timeline → Export) shows whether it is done, in progress or not started, with a progress line under the header. The Director floats over the page on small screens.
- **Themes:** dark, light or follow the system (user menu or `Ctrl+K`).
- **Interface language:** English, हिन्दी, ಕನ್ನಡ, తెలుగు, தமிழ் (user menu, login page or `Ctrl+K`). Film terms (Shot, Scene, Take, Storyboard …) stay in English on purpose, as they're used on set.
- **Motion:** smooth transitions throughout; respects the system's reduce-motion setting, or turn it off in the user menu.
- **Install as an app:** in Chrome or Edge, use *Install VEO Studio* from the address bar (works on desktop and Android). The app shell loads offline; your work always comes live from the server.

## 8. Deploy for the team (Unraid, a VPS or Docker Desktop)

```bash
copy .env.example .env
```

In `.env`, set `APP_SECRET`, `POSTGRES_PASSWORD`, `PUBLIC_BASE_URL` and your keys. Then:

```bash
docker compose up -d --build
```

Open `http://<server-ip>:8100`. For a secure team link from anywhere without opening router ports, add a Cloudflare Tunnel token to `.env` and run:

```bash
docker compose --profile tunnel up -d
```

Then set `COOKIE_SECURE=true`. The image includes FFmpeg (with Indic text shaping) and Noto fonts for all five scripts. Data lives in `./data/` (Postgres + media). Back it up. Client review links use `PUBLIC_BASE_URL`, so set it to the address clients will open.

**Voice Lock separation (optional):** the default uses ElevenLabs audio isolation. That loses the clip's background sound, so the shot gets the new voice plus your music. For a proper voice/background split on the CPU, build with:

```bash
docker compose build --build-arg WITH_DEMUCS=1
```

## 9. Tests

```bash
cd backend
.venv\Scripts\python -m pytest
```

28 tests, all in mock mode (about 2 minutes):
- **v1 pipeline:** concept → hooks → script → bible → sheets → voices → shots → keyframes → videos + QC → lip-sync → music → animatic → export → Kannada dub → Kannada export → Director agent → approvals.
- **v2:** Model Hub catalog sync and schema mapping (22 real fal.ai schemas), routing with fallbacks, explicit engine, shootout and winner, audio-driven dialogue, identity training, critic loop, scene cards, script versions, continuity, table read, marketing pack, SFX, brand-kit end card, overlays, karaoke captions, search, client review links with guest comments, audit, preferences.
- **Upgrade:** a v1-shaped table is migrated in place with its rows kept.

## 10. Code map

```
backend/app/
  main.py            FastAPI app (+ serves frontend/dist in production)      db_migrate.py  auto-upgrade on start
  config.py          .env settings          catalog.py   model IDs, prices, languages, voices, presets
  models.py          database tables        settings_store.py  team settings + encrypted API keys
  api/               REST: auth, admin, projects, bible, shots, generate, work (jobs, approvals, comments, agent, ws, media),
                     hub (Model Hub), room (writers' room), growth (brand kits, search, consents, audit, YouTube, review links, prefs)
  core/              studio.py (writing room), generation.py (job specs + estimates), model_hub.py (catalog, policy, pricing),
                     budget.py, jobs.py, youtube.py, audit.py
  agents/            director.py (agent loop), tools.py, prompts.py, schemas.py
  providers/         gemini.py, fal.py, schema_map.py (OpenAPI → capabilities → arguments), elevenlabs.py, syncso.py, sarvam.py,
                     mock.py, services.py (one run_model() for every engine)
  pipeline/          prompting.py, voice.py, captions.py (karaoke ASS), assembler.py (reframe, SFX, end card), ffmpeg.py, faces.py
  workers/           worker.py (DB job queue), handlers.py, handlers_hub.py, handlers_room.py, handlers_growth.py, run.py
frontend/src/
  pages/             Home, Login, Library, SearchPage, BrandKits, PublicReview, models/ (Model Hub), admin/*,
                     project/* (Brief, Story, Scenes, Bible, Storyboard, ShotDrawer, Timeline, Export, Review, Activity)
  components/        shell/ (palette, tour, theme, user menu), hub/, room/, review/, growth/, Generate (cost dialog), ui
  lib/               api, queries, types, live (WebSocket), i18n.ts + i18n/{hi,kn,te,ta}.ts
spike/run_spike.py   Phase 0 real-API tests
scripts/             get_face_models.py, i18n/ (keys.py, split.py, merge.py — find and merge UI translations)
```

**Design system:** [docs/DESIGN.md](docs/DESIGN.md) describes the tokens, components, layout and motion rules every screen follows. In development, `/dev/kit` shows every shared component in the current theme.

**Adding UI text:** wrap it in `t("…")` (`const t = useT()`). Then `python scripts/i18n/keys.py` shows how many strings each language is missing; put translations in `scripts/i18n/work/<lang>_NN.json` and run `python scripts/i18n/merge.py`. Untranslated strings simply show in English.

## 11. What's verified, and what isn't

**Verified here, with mock providers:**
- All 28 backend tests pass.
- Every page, checked in a browser, including: scene cards, critic, table read, engine picker, shootout and winner, identity training, review mode with timecoded comments and drawing, client review link on a phone-sized screen with a guest comment, marketing pack, semantic search, Auto SFX, light theme, Hindi interface, command palette, onboarding tour, template gallery and the installable app (service worker, offline shell).
- Upgrading the v1 dev database to v2 in place.
- Rendering in English and Kannada with correct Indic captions, karaoke captions and title overlays.

**Not yet verified:**
- **Real API calls:** they follow Google's, fal.ai's, ElevenLabs', sync.so's and Sarvam's current docs, but haven't run with real keys yet. Phase 0 is that check. The Model Hub's schema mapping was tested on 22 real fal.ai schemas; the other ~780 are mapped the same way on the first live sync.
- **YouTube upload and analytics:** written to the YouTube Data/Analytics API docs, untested without an OAuth client.
- **Identity (LoRA) training** on fal.ai: mock only.
- **Docker image:** written but not built here, because Docker Desktop isn't running on this PC.
- **Postgres:** only tested on SQLite so far.
- **Google sign-in:** written but untested.
- **Translations:** machine-translated by AI and checked for placeholders. A native speaker should review the Kannada, Telugu, Tamil and Hindi wording.

**Not built yet:**
- **Real-time collaborative editing** of the same shot. The last save wins; there is undo per shot.
- **Instagram/Facebook direct publishing:** use the Make.com webhook or download the render.
