# Tatvam AI Studio

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
| Director | Right panel (`Ctrl+J`) | Ask in plain words, e.g. *"dub into Telugu"*, *"Ravi wears his wedding outfit in this episode"*, *"cut this into 3 shorts"*, *"freeze Ravi's look for episodes 1-3"*, *"what is stale?"*. In Co-pilot mode it proposes the work with a price and you click **Approve** |
| World | World tab | **Props** (reusable objects with a reference image, mentioned in scripts with `@`), the **wardrobe timeline** (who wears what in every scene, continuity breaks flagged) and the **Continuity Bible** (the state at the end of every scene, written by AI and corrected by hand, carried into the next scene's prompts) |
| Dashboard | Dashboard tab | Shots by status, approved vs planned seconds, spend by provider, **cost per approved second**, **change impact** (everything stale after an edit, with a one-click regenerate), seasons |
| Ads & Reels | Ads & Reels tab | One brief into every language x aspect variant with **locked brand facts**; reels cut from highlights of what you already made |

**v3 (Tatvam):** `@mentions` in the script editor (characters, places, props stored by id), an import wizard that previews visuals and dialogue before anything is saved, Film Map **shot-to-shot links** (last frame or extension) and **next shot**, the **Character Lock** (face, body, voice, costume, gestures, strictness), **character versions** per episode range, **costumes** with 3-angle turnarounds, the **back view** and **lighting variants** in the reference pack, the **Google dialogue route** (Veo speaks each line itself in the languages you allow; dubbing regenerates per language; QC checks the words spoken), **change impact** (edits mark takes stale instead of deleting anything), and a professional timeline (right-click AI actions, roll trims, speed, keyframe animation on layers). Design notes: [docs/V3.md](docs/V3.md); the plan: [TATVAM_PLAN.md](TATVAM_PLAN.md).

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
- **Rupees next to dollars:** every cost figure can show INR beside USD (Both, USD or INR, set in the top bar or the account menu). Billing stays in US dollars; the rupee figure is an estimate at the live mid-market rate (refreshed every 15 minutes, last good rate kept if the source is down). Pin your own rate, for example your bank rate, with `USD_INR_RATE` in `.env`.

**Audit & consent:** the audit log records sensitive actions (keys, settings, publishing, client links, identity training, deletions) with who and from where. Consent records (signed release, scope, expiry) cover cloned voices and real people's faces.

## 7. Interface

The app is a fixed-viewport **production cockpit** (design system: [docs/DESIGN.md](docs/DESIGN.md)). Panels scroll; the page does not.

- **Top command bar:** the Tatvam mark, a breadcrumb (Command center / project / section), the command search (`Ctrl+K`) and live telemetry: AI engine health, running jobs with a live queue, team spend against the monthly cap, the live USD to INR rate, a theme switch, notifications and your account.
- **Sign-in page:** a cinematic showreel of AI-made stills behind a glass sign-in card, with the engine lineup (Google, fal.ai, ElevenLabs, Sarvam, sync.so) scrolling along the bottom. Refresh the stills with `backend/.venv/Scripts/python scripts/showcase/generate.py` (Google Nano Banana, about $0.42), or `... generate.py fal --loops` for fal.ai FLUX stills plus two Kling motion loops (about $1.06; needs fal.ai credit).
- **Rail:** a slim icon column for Command center, Search, Library, Model Hub, Brand kits and (by role) Approvals, Costs, Team, Audit and Settings. Labels are tooltips, so the work area never shifts. On phones it becomes a bottom tab bar.
- **Command center (home):** greeting and a mission KPI strip, the new-production composer with templates, your productions as mission cards with progress, and a column with the live queue, what needs your attention, recent activity and engine health.
- **Project workspace:** the left **pipeline rail** shows the project, episode and language switchers, then the production flow (Mission overview, 01 Write, 02 Cast, 03 Shots, 04 Finish, Log) with per-stage progress, the next-step card and the Director toggle. `[` collapses it to icons; below 1024 px it becomes a stage strip. Projects open on the **Mission overview**: flight path, telemetry, shot map, spend, change impact, live queue, cast and seasons.
- **Status strip (bottom):** connection, engine mode, a live job ticker and shortcut hints.
- **Themes:** dark, light or follow the system: a one-click sun/moon button in the top bar, the full choice in the account menu or `Ctrl+K`.
- **Interface language:** English, हिन्दी, ಕನ್ನಡ, తెలుగు, தமிழ் (account menu, login page or `Ctrl+K`). Film terms (Shot, Scene, Take, Storyboard …) stay in English on purpose, as they're used on set.
- **Motion:** smooth transitions throughout; respects the system's reduce-motion setting, or turn it off in the account menu.
- **Install as an app:** in Chrome or Edge, use *Install Tatvam AI Studio* from the address bar (works on desktop and Android). The app shell loads offline; your work always comes live from the server.

### Poster Studio

Posters, YouTube thumbnails, social posts, festival greetings, product ads and character cards, in a drag-and-drop editor (**Posters** in the rail, or the **Posters** tab of a project).

- **Layers:** images, text, shapes and effects (vignette, fade, film grain, light leak, glow, scanlines, frame). Drag, resize, rotate, snap to edges and centres, align and distribute, lock, hide, reorder, undo and redo.
- **Any size:** presets for film one-sheets, A4 and A3 print, hoardings, YouTube, OTT tiles, Instagram, Stories, WhatsApp status, X and Facebook covers, or a custom size. Resizing re-lays the design so the same poster works in every format; safe-area guides show where platforms put their own buttons.
- **Templates:** cinematic one-sheet, character spotlight, minimal typographic, YouTube thumbnail, product ad, festival greeting, cast line-up, episode card, event flyer and quote card. Brand kits recolour them and swap in the fonts and logo.
- **AI:** describe the poster in one line and get the layout, title, tagline, credits and a background painted for it. Generate backgrounds, characters (from the film's locked characters, in their outfits, cut out on a transparent background with a face-match score), elements and products, with up to four variations to swap between. Relight the whole poster so every element shares one light and colour grade; text is never touched by AI. Title, tagline, CTA and credits ideas in English, Hindi, Kannada, Telugu or Tamil.
- **Text:** 21 bundled poster fonts including Devanagari, Kannada, Telugu and Tamil display faces, drawn by the browser so Indian scripts are always shaped correctly. Gradients, outlines, shadows, pill backgrounds and auto-fit titles.
- **Export:** PNG, JPG, WebP or a 300 dpi PDF; every export is kept with the design. Autosave, named versions with restore, and a guard against overwriting a teammate who saved first.
- **Costs:** AI images are normal jobs, so budgets, approvals and the Costs page apply (about $0.07 per image with Nano Banana).

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

**Health checks (Coolify, Docker, uptime monitors):**

| Check | Use it for |
|---|---|
| `GET /api/health/live` | Liveness. Answers while the server runs; never touches the database, so a slow database can't get the app restarted. |
| `GET /api/health/ready` | Readiness. 200 when the database answers (and, with the worker inside the web process, the worker is alive); 503 with details otherwise. |
| `python -m app.health api` | The image's built-in Docker `HEALTHCHECK` (no curl needed). |
| `python -m app.health worker` | The worker container's check: healthy while its job loop keeps beating. |

In Coolify, set the health check to port `8100` and path `/api/health/live` (the image includes `curl` for Coolify's own probe). Give it a start period of about a minute: the first connection to a remote Postgres can be slow.

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
                     production (dashboards, impact, seasons, mentions, continuity bible, lock, versions, costumes, props), campaign,
                     hub (Model Hub), room (writers' room), growth (brand kits, search, consents, audit, YouTube, review links, prefs)
  core/              studio.py (writing room), generation.py (job specs + estimates), model_hub.py (catalog, policy, pricing),
                     mentions.py (@tokens), dependencies.py (change impact), lock.py (Character Lock), continuity.py (bible,
                     wardrobe), dashboard.py, campaign.py,
                     budget.py, jobs.py, youtube.py, audit.py
  agents/            director.py (agent loop), tools.py, prompts.py, schemas.py
  providers/         gemini.py, fal.py, schema_map.py (OpenAPI → capabilities → arguments), elevenlabs.py, syncso.py, sarvam.py,
                     mock.py, services.py (one run_model() for every engine)
  pipeline/          prompting.py, voice.py, captions.py (karaoke ASS), assembler.py (reframe, SFX, end card), ffmpeg.py, faces.py
  workers/           worker.py (DB job queue), handlers.py, handlers_hub.py, handlers_room.py, handlers_growth.py, handlers_campaign.py, run.py
frontend/src/
  pages/             Home, Login, Library, SearchPage, BrandKits, PublicReview, models/ (Model Hub), admin/*,
                     project/Dashboard, World, Campaign (v3),
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
