# Tatvam AI Studio — user guide

How to use the studio day to day. For installing, configuring and deploying it, see the [README](../README.md).

- [Daily workflow](#daily-workflow)
- [Model Hub](#model-hub)
- [Team, roles and money](#team-roles-and-money)
- [Interface](#interface) · [Poster Studio](#poster-studio)

## Daily workflow

| Step | Where | What happens |
|---|---|---|
| Concept | Home | Type the idea or **start from a template** (Short, Reel ad, product ad, web-series episode, devotional story, explainer, music video, kids story). Pick format, frame, languages, look and quality, then **Start** (or turn on **Autopilot**) |
| Brief | 1 Story › Brief | AI fills audience, tone, length and CTA. **Trend scout** suggests current trends, hook patterns and formats for your audience. Series: **Plan season** |
| Hook + script | 1 Story › Hooks & script | 6 scored hooks (with **what worked before** from your YouTube analytics), pick one and **Write script**. Then the **writers' room**: **Critic** scores the draft and the loop rewrites until it passes, **Table read** plays the whole episode in the cast voices, **Continuity** checks props, wardrobe and time of day, **Localization** translates and gives each language a native-speaker polish. Every change is saved in **Versions** with a diff and restore |
| Scenes | 1 Story › Scenes | One card per scene: goal, conflict, turn, emotion, cast, props, wardrobe, blocking and coverage plan. Approve the cards, then **Break into shots** follows them |
| Cast (Bible) | 2 Cast › Characters & places | **Build from script** creates the cast, locations and style. Generate sheets and voices, approve images and **Lock**. **Train identity** gives a character a face model so every keyframe keeps the exact face. A consent record is asked for when a real person's face or voice is used |
| Shots | 3 Shots › Storyboard · List · Studio | **Keyframes** (cents each), then **Videos**, then **Voice + lip-sync**, then **Music**. Click a shot to edit it, pick the **engine** (or Auto), run a **shootout** between 2–4 engines and pick the winner, compare takes, retake, extend, **Edit with words** or approve. Each take shows its engine and QC (face match, lip-sync score) |
| Timeline | 4 Edit › Timeline | Zoom, snap, J/K/L shuttle, waveforms for dialogue, music and SFX, **Auto SFX**, title and lower-third track, caption preview, music volume and ducking |
| Export | 5 Deliver › Export | **Animatic** (free preview), **Render** (Shorts / Reels / YouTube / Square, karaoke or clean captions, auto-reframe, brand-kit end card), **Dub**, **Cut into shorts**, **Marketing pack** (titles, descriptions, hashtags and thumbnails per platform and language), **Publish to YouTube** (or schedule it), **Client link** |
| Review | 5 Deliver › Review | Frame-accurate player, timecoded comments, draw on the frame, A/B **wipe compare** between renders, approve the final. Clients get a link that works without an account, on phone or desktop |
| Director | Right panel (`Ctrl+J`) | Ask in plain words, e.g. *"dub into Telugu"*, *"Ravi wears his wedding outfit in this episode"*, *"cut this into 3 shorts"*, *"freeze Ravi's look for episodes 1-3"*, *"what is stale?"*. In Co-pilot mode it proposes the work with a price and you click **Approve** |
| World | 2 Cast › Props & wardrobe | **Props** (reusable objects with a reference image, mentioned in scripts with `@`), the **wardrobe timeline** (who wears what in every scene, continuity breaks flagged) and the **Continuity Bible** (the state at the end of every scene, written by AI and corrected by hand, carried into the next scene's prompts) |
| Dashboard | Overview (project home) | Shots by status, approved vs planned seconds, spend by provider, **cost per approved second**, **change impact** (everything stale after an edit, with a one-click regenerate), seasons |
| Ads & Reels | 5 Deliver › Ads & Reels | One brief into every language x aspect variant with **locked brand facts**; reels cut from highlights of what you already made |

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

## Model Hub

- **Catalog:** the hub syncs fal.ai's model list every 24 hours (Settings → Model Hub). It reads each model's input schema, works out what it can do (text-to-video, image-to-video, reference-to-video, first/last frame, audio-driven, lip-sync, extend, edit …) and prices it. New releases show up under **New models** for an admin to enable or dismiss. The first sync files everything outside the routing chains as available-but-off, so the team isn't asked to review 800 models at once.
- **Routing policy:** drag to reorder each chain (Saver, Balanced, Hero, Dialogue, Lip-sync, Image, Edit, Extend).
- **Per shot:** the engine picker in the shot drawer shows only engines that can do that shot (reference images, audio, length), with the price. **Shootout** runs the same shot on 2–4 engines; the winner is credited in the hub, so ratings reflect your own results.
- **Quality checks:** every new take is checked for face match (OpenCV, if the face models are installed), extra people, text artifacts and, for dialogue, lip-sync. A failed take is retried automatically on the next engine, up to the retake limit.

## Team, roles and money

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

## Interface

The app is a fixed-viewport **production cockpit** (design system: [docs/DESIGN.md](docs/DESIGN.md)). Panels scroll; the page does not.

- **Top command bar:** the Tatvam mark, a breadcrumb (Command center / project / section), the command search (`Ctrl+K`) and live telemetry: AI engine health, running jobs with a live queue, team spend against the monthly cap, the live USD to INR rate, a theme switch, notifications and your account.
- **Sign-in page:** a cinematic showreel of AI-made stills behind a glass sign-in card, with the engine lineup (Google, fal.ai, ElevenLabs, Sarvam, sync.so) scrolling along the bottom. Refresh the stills with `backend/.venv/Scripts/python scripts/showcase/generate.py` (Google Nano Banana, about $0.42), or `... generate.py fal --loops` for fal.ai FLUX stills plus two Kling motion loops (about $1.06; needs fal.ai credit).
- **Rail:** a slim icon column for Command center, Search, Library, Model Hub, Brand kits and (by role) Approvals, Costs, Team, Audit and Settings. Labels are tooltips, so the work area never shifts. On phones it becomes a bottom tab bar.
- **Command center (home):** greeting and a mission KPI strip, the new-production composer with templates, your productions as mission cards with progress, and a column with the live queue, what needs your attention, recent activity and engine health.
- **Project workspace:** a project opens on its **Overview** (flight path, telemetry, shot map, spend, change impact, live queue, cast and seasons), then five numbered steps: **1 Story** (Brief · Hooks & script · Scenes), **2 Cast** (Characters & places · Props & wardrobe), **3 Shots** (Storyboard · List · Studio, three views of the same shots), **4 Edit** (Timeline) and **5 Deliver** (Export · Review · Ads & Reels · Posters). Each step page has a step bar with the next step; the Activity log is in the project's **⋯** menu. Model Hub, Brand kits, Team and Audit are under **More** in the sidebar.
- **Status strip (bottom):** connection, engine mode, a live job ticker and shortcut hints.
- **Themes:** dark, light or follow the system: a one-click sun/moon button in the top bar, the full choice in the account menu or `Ctrl+K`.
- **Interface language:** English is the maintained interface language. The account menu, login page and `Ctrl+K` still offer हिन्दी, ಕನ್ನಡ, తెలుగు and தமிழ் from earlier machine translations; they are not maintained, and untranslated strings show in English. Film terms (Shot, Scene, Take, Storyboard …) stay in English on purpose. Content languages (scripts, voices, captions, dubbing) are separate and fully supported.
- **Motion:** smooth transitions throughout; respects the system's reduce-motion setting, or turn it off in the account menu.
- **Install as an app:** in Chrome or Edge, use *Install Tatvam AI Studio* from the address bar (works on desktop and Android). The app shell loads offline; your work always comes live from the server.

### Poster Studio

Posters, YouTube thumbnails, social posts, festival greetings, product ads and character cards, in a drag-and-drop editor (**Posters** in the rail, or **5 Deliver › Posters** in a project).

- **Layers:** images, text, shapes and effects (vignette, fade, film grain, light leak, glow, scanlines, frame). Drag, resize, rotate, snap to edges and centres, align and distribute, lock, hide, reorder, undo and redo.
- **Any size:** presets for film one-sheets, A4 and A3 print, hoardings, YouTube, OTT tiles, Instagram, Stories, WhatsApp status, X and Facebook covers, or a custom size. Resizing re-lays the design so the same poster works in every format; safe-area guides show where platforms put their own buttons.
- **Templates:** cinematic one-sheet, character spotlight, minimal typographic, YouTube thumbnail, product ad, festival greeting, cast line-up, episode card, event flyer and quote card. Brand kits recolour them and swap in the fonts and logo.
- **AI:** describe the poster in one line and get the layout, title, tagline, credits and a background painted for it. Generate backgrounds, characters (from the film's locked characters, in their outfits, cut out on a transparent background with a face-match score), elements and products, with up to four variations to swap between. Relight the whole poster so every element shares one light and colour grade; text is never touched by AI. Title, tagline, CTA and credits ideas in English, Hindi, Kannada, Telugu or Tamil.
- **Text:** 21 bundled poster fonts including Devanagari, Kannada, Telugu and Tamil display faces, drawn by the browser so Indian scripts are always shaped correctly. Gradients, outlines, shadows, pill backgrounds and auto-fit titles.
- **Export:** PNG, JPG, WebP or a 300 dpi PDF; every export is kept with the design. Autosave, named versions with restore, and a guard against overwriting a teammate who saved first.
- **Costs:** AI images are normal jobs, so budgets, approvals and the Costs page apply (about $0.07 per image with Nano Banana).
