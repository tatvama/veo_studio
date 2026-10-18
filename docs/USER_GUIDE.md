# Tatvam AI Studio — user guide

How to use the studio day to day. For installing, configuring and deploying it, see the [README](../README.md).

- [Daily workflow](#daily-workflow) · [The Shots canvas](#the-shots-canvas) · [Make it for me: drafts and recipes](#make-it-for-me-drafts-and-recipes) · [Problems you can act on](#problems-you-can-act-on)
- [Character boards](#character-boards)
- [Seedance characters (BytePlus)](#seedance-characters-byteplus)
- [Model Hub](#model-hub)
- [Team, roles and money](#team-roles-and-money)
- [Interface](#interface) · [Poster Studio](#poster-studio)

## Daily workflow

The usual path, start to finish:

1. **Home box:** paste your script or describe your idea.
2. **Check story:** the scenes, shots, speakers and voice-over lines we read from it, before anything is saved.
3. **Cast:** a picture and a voice for every character (**Make the cast**, price first), or your own photos.
4. **Shots**, in three views of the same film: **Canvas** (the scenes as rows of shot cards you can drag, link and fix),
   **Grid** (big pictures to compare takes) and **Text** (the shot list as words).
5. **Make it for me:** everything the shots still need, only what is missing, with the price before it starts. Try
   **Quick draft first** for a cheap 480p cut, or a **recipe** in one click.
6. The **Next bar** at the bottom of every project screen always says what is next (with its price), shows what is
   being made, and lists any **problems** with a one-click fix.
7. **Export:** the finished film, with captions, for Shorts, Reels or YouTube.

| Step | Where | What happens |
|---|---|---|
| Concept | Home | One box: **paste your script, or describe your idea** (or **start from a template**: Short, Reel ad, product ad, web-series episode, devotional story, explainer, music video, kids story). A pasted script is recognised (*Script found: 3 scenes, 12 lines — we'll use your words*): **Start with my script** creates the project and opens **Check story** (scenes, shots, people, voice-over lines, length, warnings) before anything is saved; after the import you land on **Cast** with **Make the cast** and its price. An idea is written up for you (**Start**, or choose how far AI takes it). A script file is under **Upload a script file** |
| Brief | 1 Story › Brief | AI fills audience, tone, length and CTA. **Trend scout** suggests current trends, hook patterns and formats for your audience. Series: **Plan season** |
| Hook + script | 1 Story › Hooks & script | 6 scored hooks (with **what worked before** from your YouTube analytics), pick one and **Write script**. Then the **writers' room**: **Critic** scores the draft and the loop rewrites until it passes, **Table read** plays the whole episode in the cast voices, **Continuity** checks props, wardrobe and time of day, **Localization** translates and gives each language a native-speaker polish. Every change is saved in **Versions** with a diff and restore |
| Scenes | 1 Story › Scenes | One card per scene: goal, conflict, turn, emotion, cast, props, wardrobe, blocking and coverage plan. Approve the cards, then **Break into shots** follows them |
| Cast | 2 Cast | Faces first: the list of faces on the left (with *voice ✓ / no voice* and *look out of date*), the open character's big pictures in the middle (**Approve** / **Redo** on each, **Make pictures** with its price) and a details panel on the right: **Voice** (play the sample, **Design voice** with its price), **Look lock**, **Outfits**, **Who they are** and **Advanced** (expressions, lighting, boards, identity training, Seedance, consent, versions). When a character's look changes after shots were made, **Redo these shots** (with its price) remakes the shots that still show the old look. Places work the same way. **Build from script** creates the cast and places; a consent record is asked for when a real person's face or voice is used |
| Shots | 3 Shots › Canvas · Grid · Text | **Pictures** (cents each), then **Videos**, then **Voice + mouth sync**, then **Sound** and **Music**: one at a time from a shot's step dots, or all at once with **Make it for me**. Click a shot to edit it, pick the **engine** (or Auto), run a **shootout** between 2–4 engines and pick the winner, compare takes, retake, extend, **Edit with words** or approve. Each take shows its engine and QC (face match, lip-sync score). See [the Shots canvas](#the-shots-canvas). The Grid shows the cast's faces on every shot; **Who** shows only one character's shots (and the make buttons then cover just theirs) |
| Timeline | 4 Edit › Timeline | The preview (left) and the clip's details (right) on top, the tracks always on screen below. Zoom, snap, J/K/L shuttle, waveforms for dialogue, music and sound effects, **Add music** and **Add effects** (with their prices) on the Music and Sound effects tracks, title and lower-third track, caption preview, music volume and ducking |
| Finishing room | 4 Edit › Finishing room | **Check out** the cut so the web timeline goes read-only for everyone else, **check in** with a note (every check-in is a version you can **restore**), **AI upscale** to 4K or 2K (free on the desktop's graphics card, or in the cloud with the price shown first), **review notes** from your renders as markers on the timeline, and **pop-out** program monitor, scopes, mixer and notes windows. In the **desktop app** it also has the project folder, file names in series, local 4K renders on your graphics card and the machine check (see below) |
| Export | 5 Deliver › Export | One card on top: the newest film playing, **Reels 9:16 / YouTube 16:9 / Square**, captions on or off, **Render** with its price, **Download** and a **Quick preview**. Below it, tabs: **Share** (client link, YouTube), **Dub**, **Promote** (cut into shorts, brand kit, marketing pack) and **Renders** (every format, look & sound, sound design, the queue and all finished renders). A quick draft run's **draft cut** (480p) is listed with the renders; it is never published |
| Review | 5 Deliver › Review | Frame-accurate player, timecoded comments, draw on the frame, A/B **wipe compare** between renders, approve the final. Clients get a link that works without an account, on phone or desktop |
| Director | Right panel (`Ctrl+J`) | Ask in plain words, e.g. *"dub into Telugu"*, *"Ravi wears his wedding outfit in this episode"*, *"cut this into 3 shorts"*, *"freeze Ravi's look for episodes 1-3"*, *"what is stale?"*. Or give it the whole film in one message with tagged pictures ([below](#the-director-one-long-prompt-with-pictures)). In Co-pilot mode it proposes the work with a price and you click **Approve** |
| World | 2 Cast › Props & wardrobe | **Props** (reusable objects with a reference image, mentioned in scripts with `@`), the **wardrobe timeline** (who wears what in every scene, continuity breaks flagged) and the **Continuity Bible** (the state at the end of every scene, written by AI and corrected by hand, carried into the next scene's prompts) |
| Dashboard | Overview (project home) | Shots by status, approved vs planned seconds, spend by provider, **cost per approved second**, **change impact** (everything stale after an edit, with a one-click regenerate), seasons |
| Ads & Reels | 5 Deliver › Ads & Reels | One brief into every language x aspect variant with **locked brand facts**; reels cut from highlights of what you already made |

**v3 (Tatvam):** `@mentions` in the script editor (characters, places, props stored by id), an import wizard that previews visuals and dialogue before anything is saved, **shot-to-shot links** on the canvas (Continue, Exact match, Extend) and **next shot**, the **Character Lock** (face, body, voice, costume, gestures, strictness), **character versions** per episode range, **costumes** with 3-angle turnarounds, the **back view** and **lighting variants** in the reference pack, the **Google dialogue route** (Veo speaks each line itself in the languages you allow; dubbing regenerates per language; QC checks the words spoken), **change impact** (edits mark takes stale instead of deleting anything), and a professional timeline (right-click AI actions, roll trims, speed, keyframe animation on layers). Design notes: [docs/V3.md](docs/V3.md); the plan: [TATVAM_PLAN.md](TATVAM_PLAN.md).

**Anywhere:** `Ctrl+K` opens the command palette (pages, projects, actions, theme, language, search). `?` lists every shortcut. **Search everything** finds shots, takes, scenes, characters and renders by what's in them ("Ravi near the lamp at night").

### The Shots canvas

**3 Shots › Canvas** shows the whole film on one board. Phones get the same shots as a list, with the shot opening in a
sheet.

- **Scenes are rows**, top to bottom in film order, with their shots left to right. Fold a scene with its arrow; drag
  its grip up or down to move it. Its header shows the place, the time of day, the mood, the scene's music (play it, or
  **Add music**) and **Make scene** with its price.
- **Each shot is a card** with its picture or clip (hover to play), its length, its words and its cast, and **five step
  dots**: Picture → Video → Voice → Mouth sync → Sound. Green is made, glowing is being made, red failed, amber is out of
  date (the shot changed after it was made), dashed is not made yet, faint means nothing to make (no lines to voice).
  Click a dot to make that step again, its price first.
- **Drag from the library** (left): a face onto a shot adds that character (onto a scene's title: to all its shots), a
  place onto a scene sets where it happens, a prop onto a shot adds it. Click a face to light up every shot they are in.
- **Link shots** by dragging one shot's right edge onto another. The label on the link says how the second continues:
  **Continue** (it starts from the first clip's last frame), **Exact match** (it starts exactly on the first shot's end
  frame, so the two join without a jump) or **Extend** (its video extends the first clip). Click the label to switch.
- **The inspector** (right) edits the selected shot: the words, lines and voice-over, cast, framing, camera, place,
  outfits, sound effects and, under Advanced, length, engine and links. Edits save themselves. It also shows what
  failed with its fix, and the shot's **takes**: pictures and videos, newest first, the ones in use marked. Click
  another take to use it instead (the next step then starts from it); nothing is deleted. **Make it** makes what the
  shot still needs; **More** opens the full shot (prompt, effects, comments).
- **Tidy** puts the scenes back in rows and the shots left to right; **Fit** shows the whole film; `Ctrl+F` finds a shot
  by code or words; `Ctrl+Z` / `Ctrl+Y` undo and redo moves, links and cast changes. The film card at the end renders
  the film and downloads it.

### Make it for me: drafts and recipes

**Make it for me** (the Next bar, the Text view, the Brief) makes everything the shots still need, in order, only what is
missing. Switch steps off to leave them out, pick the video quality, and the price shows before anything starts.

- **Quick draft first (480p, cheaper):** every shot without a clip gets a cheap 480p preview on the cheapest engine
  that makes one (the dialog names it in the price), the voices are made and kept, and the drafts are cut together as a
  **draft cut** (in Export). Drafts get no quality check, aren't extended and never replace a finished clip. When the
  draft is ready, the Next bar offers **Make the final film** with its price: the drafts are remade as finished clips and
  the film is rendered. A draft never counts as finished: the final render waits until every shot has its real clip.
- **Recipes** are saved choices, one click each, at the top of the dialog. Three come built in: **Reels draft** (a
  quick 480p cut with one music track), **Full film, Hero quality** (everything at the best quality, stopping after new
  cast pictures and voices so you can check them) and **Storyboard first** (the cast and a picture per shot, to check the
  look before paying for video). **Save these choices** keeps the current ones as a recipe for the whole team; a team
  recipe's **×** deletes it. A recipe only fills the dialog: you still see the price first.

### Problems you can act on

When a run can't make something, it says so in plain words with what to do next, and the fix is one click away:

- the **Next bar** shows **3 problems** (it hides when there are none); click it for the list;
- the **Overview**'s Problems card lists them first;
- on the **canvas** the shot's step dot turns red and its card says what failed.

Each problem has its button: **Retry** (that step again, price first), **Try another engine** (for a failed or blocked
video: the other engines that can make this shot, each with its price; the one you pick makes this shot only, as
picked, so "Google first" doesn't swap it), **Make the voice**, **Open the shot** (something to change by hand, like a line
too long for one clip) or **Make it for me** (a run that stopped at your budget carries on; nothing is made twice). A
problem drops off the list once its step has been made. The next run starts a fresh list.

### The Director: one long prompt with pictures

Give the Director the whole film in one message, up to 30,000 characters: a story, a brief or your finished script, with reference pictures of the cast, the places and the look.

- **Attach pictures** with the picture button in the Director box, by pasting them (`Ctrl+V`) or by dropping them on the box: up to 8 per message (PNG, JPG or WEBP, 15 MB each).
- **Tag each picture** with the label under its thumbnail: an existing character, location or prop (the project's, or the shared library's), a **new name** (it becomes cast), or **Look / style reference**. An untagged picture is fine; the Director asks when it matters.
- **@mentions:** type `@` in the box to pick a character, place or prop from the same list as the script editor. The Director gets exactly that one, not just a name.
- What the Director then does, with a live checklist:
  1. adds the tagged people, places and props to **2 Cast**, with your picture as their approved reference (the same as uploading it there);
  2. imports your script **word for word** (scenes, shots and lines as you wrote them; it leaves out the instructions around the script), or writes the script from your story;
  3. plans the scene cards and the shots, and checks continuity;
  4. proposes the paid steps with their price, cheapest first: character sheets for cast that only has your photo, keyframes, then the **videos scene by scene**. Each scene carries the wardrobe, props and time of day of the one before, a scene that picks up straight from the previous one starts from its last frame, and linked shots start from the last frame of the clip they continue. Ask it to pause after each scene to review as you go.
- **Engines:** say *"make it on Seedance"* (or name another engine of the Model Hub) and the Director sets that engine on the shots. Otherwise every shot stays on **Auto** (the team's routing, Google first).
- **Money and your work:** in **Ask me first** mode every paid step waits for **Approve**, and anything that would replace your work (a new script, a new shot list) shows a Confirm card first. Budgets, limits and producer approvals apply as everywhere.
- The pictures stay in the chat with their tags, and long messages open folded (**Show all**). With Claude as the Director's engine it sees the pictures; with Gemini it goes by their tags.
- Shots that continue another shot are always made in link order, also when you ask for the videos of a few shots.

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

### Start and end frames, synced clips (storyboard frames)
A shot can have a **start frame** (its keyframe) and an **end frame**: the same shot a few seconds later, where the action has got to. The video is then made with **first + last frame** (Seedance, Veo, Kling …), so the clip runs from one picture to the other instead of wandering. An engine without first + last frame starts from the start frame only.

- **One shot:** in the shot drawer, **End frame** makes it from the start frame, the cast and the shot's **How it ends** text (Details › Shot); the menu next to it uploads your own or stops using one. The viewer switches between **Start** and **End**, and the row under the takes shows start → end.
- **Synced shots:** link a shot to the one before with **Exact match** (Details › Advanced › Continues from, or click a link's label on the canvas). It then starts on *exactly* that end frame (a free copy), so the two clips join without a jump. Because both clips come from frames known in advance, they are made side by side instead of one after the other.
- **A whole scene:** **Frames** (the Grid view's toolbar, or on a scene's header) makes every start and end frame in order, each following the one before, with a price first. **Sync the clips** links each shot of the scene to the one before (one continuous action); **Remake** redoes frames that are already good. End frames get the same vision check as keyframes (compared with their own start frame), with one automatic retake.
- **Frames engine:** the dialog's engine choice is saved for the project and used for every start and end frame, including single keyframes. Pick **Seedream 5.0 Pro** for a Seedance film; **Auto** keeps the team's image chain (Google first). The Director (`storyboard_frames`) and the MCP server (`storyboard_frames`) do the same.

## Character boards

Where: **2 Cast › Characters & places**, open a character, **Reference pack**.

### Split a board you already have

A character board is one image with many views of the same character: a turnaround (front, three-quarter, side, back),
expressions, outfits. **Upload a board** cuts it into separate views:

1. **Panels are found.** On a plain background the studio finds them itself, from the gutters between the pictures (or
   the separate figures when nothing lines up). On a busy background a vision model finds them instead.
2. **Each panel is labelled** by a small vision check (front, three-quarter, profile, back, full body, an expression
   with its name, an outfit, or other). It is a job like any other: priced first (a few cents at most), counted against
   the budget, and sent for approval when the budget asks for it. If it can't run, you label the panels yourself.
3. **You review them** in **Review views**: pick what each panel shows, name the expression or the outfit (and its angle),
   untick the panels you don't want, and fix a crop by dragging its box on the board (or its corner to resize), or by
   typing the numbers under **Adjust box**. **Add a panel** draws a new box; **Label again with AI** relabels your boxes.
4. **Save views.** Each kept panel becomes its own approved image in the reference pack (outfit panels also create the
   outfit), marked *from your board*.

Good to know:

- The board itself is kept as **your own picture**, never used whole as a look reference. Like an uploaded photo, it
  counts as a real person's pictures unless you tick **This image is AI-generated — not a photo of a real person** when
  you upload it (or later under **Your uploads**). Only then can the character be registered with BytePlus, and only
  then are the views cut from the board sent along (see [Seedance characters](#seedance-characters-byteplus)). A face
  model trains on them as your own photos (no AI variations are added).
- Removing the board keeps the views you saved.

### A whole board in one request (Seedream on BytePlus)

**Full board in one go** makes the turnaround, the five expressions and, if you describe one, an outfit's mini
turnaround in **one** Seedream request on BytePlus, from the character's reference image. Each image is saved as its
view, in the order the request listed them.

- One request makes at most 15 images, and the reference image counts toward that limit (so 14 with a reference).
- BytePlus decides how many images come back and bills only those. Any it doesn't return (or refuses) are made one by one
  on the same engine, within the same estimate. The job says which panels are still missing, if any.
- It needs **Seedream 5.0 Lite (BytePlus)**: BytePlus doesn't offer one-request boards on **Seedream 5.0 Pro** yet. Pro
  can still make this character's views one at a time (see below).

### The image engine per character

**Image engine for this character** picks the engine that makes this character's sheet, expressions, lighting variants
and outfits. **Auto** is the team's image chain (Google first, as set in the Model Hub). Pick another engine, for example
**Seedream 5.0 Pro (BytePlus)**, and it is remembered for the next regenerations. A picked engine is used exactly as
picked: "Google first" doesn't replace it, and no other engine or provider is tried behind your back (only the team's
opt-in safety fallback, if it is on). The list shows each engine's price per image.
## Seedance characters (BytePlus)

Seedance (BytePlus) blocks faces it takes for real people. An **AI character** registered in your private BytePlus asset
library is trusted instead: Seedance gets the registered images as references and keeps the look. Real people can't be
registered from the studio; they verify themselves in the BytePlus console.

**Once:**
1. In the BytePlus ModelArk console, open **Model activation → Advanced Creation Rights** and turn on the free version
   (50 images, 50 groups).
2. Add the BytePlus **access key and secret** (an IAM user with ArkFullAccess) in **Settings → AI services**.
3. Use **bucket storage** (`STORAGE_BACKEND=s3` with the R2 settings): BytePlus downloads the images by link.

**For each AI character** (2 Cast › the character):
1. Give it a look BytePlus may take: **upload** an AI-generated image and tick **"This image is AI-generated — not a
   photo of a real person"**, or **Generate sheet** and approve the good views. Every upload counts as a real
   person's photo until you tick the box; you can change it later under **Reference pack → Your uploads** (with a
   confirm, and it is recorded in the audit log). The box is on every upload: the character page, **New character**,
   the import wizard's **Add photo** and **+ Character** in the shot list.
2. In **Video character**, check **Images that will be sent**: up to 4, best first (the uploads you marked
   AI-generated, then the approved sheet views). BytePlus takes images of 300–6000 px per side, between 0.4 and 2.5
   times as wide as tall and under 30 MB: larger ones go as a smaller copy, too small or oddly shaped ones are listed
   under **Not sent** with the reason.
3. Press **Register with BytePlus** and wait until the images show **Active** (BytePlus reviews each one; **Re-check
   status** asks again). The character then shows the Seedance badge.

**Never sent:** a character with an upload that isn't marked AI-generated counts as **made from a photo of a real
person**: Register is turned off with the reason, and automatic registration (Settings → Generation) skips it. An
upload can't be relabelled as a sheet view to get around this. If you mark an upload as a real person's photo while
the character is registered, or **archive** the character, it is removed from BytePlus right away. If BytePlus can't
be reached then, the registration stays marked (Seedance no longer uses it) and **Remove from BytePlus** tries again.

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

- **Top command bar** (outside projects): the Tatvam mark, a breadcrumb (Home / section), the command search (`Ctrl+K`) and live telemetry: AI engine health, running jobs with a live queue, team spend against the monthly cap, the live USD to INR rate, a theme switch, notifications and your account.
- **Landing page (the public home):** what a signed-out visitor sees at the web address: a cinematic hero, a picture of the studio, the five steps, every feature, a **rupee cost estimator** (it reads the studio's own prices and the live USD to INR rate), the showreel, the AI engines the studio connects to, an FAQ and the **waitlist** (email, mobile number and a tick to agree to be contacted). Its *Sign in* goes to `/login`. Signed-in people can preview it any time at `/welcome`. Tatvam Desktop, the installed app and deep links (an MCP consent page, a project link) skip it and open to the sign-in card, and a fresh install still starts with the admin setup card. All the wording is in `frontend/src/pages/landing/content.ts`; keep every claim there true, because the page is public. **Recognition and partnerships** (Startup India, NVIDIA Inception and the like) are an empty list there on purpose: add one only once you hold the paperwork, and write it in words rather than using a logo or the national emblem.
- **Waitlist (Team page, admins):** everyone who joined from the landing page, newest first, with **Download CSV** and a remove button (it asks first) for anyone who wants to be taken off. People join through `POST /api/public/waitlist`: eight tries per address every ten minutes, a hidden field that catches bots, the same answer for a new and an existing email (so the form can't be used to see who has joined), and the first details kept (nobody can overwrite an entry). It does not verify the email or number (no OTP or confirmation mail).
- **Sign-in page** (`/login`): a cinematic showreel of AI-made stills behind a glass sign-in card, with the engine lineup (Google, fal.ai, ElevenLabs, Sarvam, sync.so) scrolling along the bottom. Refresh the stills with `backend/.venv/Scripts/python scripts/showcase/generate.py` (Google Nano Banana, about $0.42), or `... generate.py fal --loops` for fal.ai FLUX stills plus two Kling motion loops (about $1.06; needs fal.ai credit).
- **Rail:** a slim icon column for Home, Search, Library, Model Hub, Brand kits and (by role) Approvals, Costs, Team, Audit and Settings. Labels are tooltips, so the work area never shifts. On phones it becomes a bottom tab bar.
- **Home:** greeting and a KPI strip, the one box to start a production (paste a script or describe an idea) with templates, your productions with progress, and a column with the live queue, what needs your attention, recent activity and engine health.
- **Project workspace:** one header on top (back to Home, the title, the steps as a stepper **1 Story · 2 Cast · 3 Shots · 4 Edit · 5 Deliver**, the open step's views, spend, search, the **Director**, the **⋯** menu and your account) and the **Next bar** at the bottom: what is being made right now (click it for the job list with costs, retry and cancel), any **problems** with their one-click fixes, and the next step in plain words with its price and one button (after a quick draft: **Make the final film**). Projects made from your own script leave out the Story step until it has writing in it (⋯ › *Show the Story step*). The steps' pages: **Story** (Brief · Script; *Advanced:* Scene cards), **Cast** (Cast; *Advanced:* Props & wardrobe), **Shots** (Canvas · Grid · Text; *Advanced:* Advanced layout), **Edit** (Timeline · Pro finishing) and **Deliver** (Export · Review · Ads & Reels · Posters). The **Overview** (the gauge icon) shows progress with the next step, problems and spend; the rest is under **More**. The Director docks on the right on laptops and wider screens and opens over the page on smaller ones.
- **Make it for me:** one button (the Next bar, the shot list's Text view, the Brief) lets the studio do the work: with no shots yet it goes from your idea to the final film, stopping where you ask so you can check; once there are shots it makes everything they still need (cast pictures and voices, pictures, videos, voices and mouth sync, sound, music, the final film), only what is missing, or a quick 480p draft first, or a saved recipe ([more](#make-it-for-me-drafts-and-recipes)). The price shows before anything starts.
- **Prices first:** every button that spends money shows what it costs before it runs (a cost dialog, or the price on the button). Edits in the shot panel save themselves, so **Retake** always uses what you wrote.
- **Status strip (bottom, outside projects):** connection, engine mode, a live job ticker and shortcut hints.
- **Themes:** dark, light or follow the system: a one-click sun/moon button in the top bar, the full choice in the account menu or `Ctrl+K`.
- **Interface language:** English is the maintained interface language. The account menu, login page and `Ctrl+K` still offer हिन्दी, ಕನ್ನಡ, తెలుగు and தமிழ் from earlier machine translations; they are not maintained, and untranslated strings show in English. Film terms (Shot, Scene, Take, Storyboard …) stay in English on purpose. Content languages (scripts, voices, captions, dubbing) are separate and fully supported.
- **Motion:** smooth transitions throughout; respects the system's reduce-motion setting, or turn it off in the account menu.
- **Phones:** Home, Cast, Timeline, Export and the project header are one column with 40 px touch targets. On the Cast a tap on a face opens it full screen with its details under the pictures; the Timeline is a preview and the list of what is on each track (editing needs a bigger screen); details open as sheets from the bottom.
- **Install as an app:** in Chrome or Edge, use *Install Tatvam AI Studio* from the address bar (works on desktop and Android). The app shell loads offline; your work always comes live from the server.

### Tatvam Studio desktop app (the finishing room)

For the editors who finish a cut in 4K. It is the same studio in a Windows app, with these extras (design:
[docs/DESKTOP.md](DESKTOP.md)):

- **Connect:** File → **Studio server…** sets the server address (test it there), whether the interface comes with
  the app (works offline) or from the server, and which FFmpeg to use. Sign in as usual.
- **Project folder:** in 4 Edit › Finishing room › **Local folder**, pick the library folder (default
  `Documents\Tatvam Projects`) or move this project to its own folder, choose what to pull (**Approved** or
  **Everything in the cut**) and press **Sync now**. Files land in `Takes`, `Audio`, `Captions`, `Renders`, `Bible`,
  `Media` …, and `Edits` holds an EDL and FCPXML of the cut for Premiere or DaVinci. Drop footage into `Imports` and it
  uploads to the episode's media by itself.
- **File names in series:** **File names** shows the template for each folder (tokens like `{cut:03}`, `{scene:02}`,
  `{shot:03}`, `{take:02}`, `{lang}`) and the **Rename plan**. When the cut changes, a sync renames the files so the
  folder always lists in cut order.
- **AI upscale to 4K or 2K:** in **AI upscale**, choose **This PC · free** (Real-ESRGAN on your graphics card; press
  **Install the upscaler** once, 45 MB) or **Cloud · paid** (Topaz, priced first). Pick **4K · 2160p** or **2K · 1440p**
  and **Fast** (the default, about 2 minutes per 6-second shot on a GTX 1660 Ti) or **Best detail** (much slower, for a
  hero shot), then **Estimate the time** and **Upscale**. Each finished shot uploads as its upscale take, so renders with
  **Use AI upscales** and the rest of the team use it.
- **Render:** pick a preset (YouTube 4K, Shorts / Reels 4K, YouTube 2K, Shorts / Reels 2K, ProRes master, broadcast 1080p25, review 1080p), turn on
  **Use AI upscales** or **Local upscale**, and **Render**. It runs on the graphics card (NVENC, Quick Sync or AMF), shows
  progress and time left, and with **Upload when done** the file appears in 5 Deliver › Export and Review as the
  next version (v1, v2 …), ready for review links and phone approvals. No AI runs here, so nothing is charged. It
  sounds like the web export: every clip's sound and every voice are brought to one loudness before the mix, and the
  music dips under the voices only (not under the rain or the sound effects).
- **Windows & screens:** open the **Program** monitor, **Source**, **Timeline**, **Scopes**, **Mixer**, **Review notes**,
  **Media**, **Renders** or **Bible** in their own windows (`Ctrl+Shift+1…8`), on any screen, full screen or as a
  **clean feed** for a client monitor. `Ctrl+Shift+M` sends the program monitor to the next screen. **Workspaces**
  (Edit, Colour, Audio, Review, Story, `Ctrl+1…5`) open a set of windows in one go; save your own and export them for
  the team. Every window follows the same playhead.
- **This machine:** **Run machine check** compares the PC with the editing baseline (RTX 3060, 32 GB RAM, NVMe SSD)
  and lists the encoders that work. **Play 1080p proxies** keeps scrubbing smooth on slower PCs.
- **Offline:** if the server can't be reached, keep cutting; the edits are queued and sent in order when it's back.

### Poster Studio

Posters, YouTube thumbnails, social posts, festival greetings, product ads and character cards, in a drag-and-drop editor (**Posters** in the rail, or **5 Deliver › Posters** in a project).

- **Layers:** images, text, shapes and effects (vignette, fade, film grain, light leak, glow, scanlines, frame). Drag, resize, rotate, snap to edges and centres, align and distribute, lock, hide, reorder, undo and redo.
- **Any size:** presets for film one-sheets, A4 and A3 print, hoardings, YouTube, OTT tiles, Instagram, Stories, WhatsApp status, X and Facebook covers, or a custom size. Resizing re-lays the design so the same poster works in every format; safe-area guides show where platforms put their own buttons.
- **Templates:** cinematic one-sheet, character spotlight, minimal typographic, YouTube thumbnail, product ad, festival greeting, cast line-up, episode card, event flyer and quote card. Brand kits recolour them and swap in the fonts and logo.
- **AI:** describe the poster in one line and get the layout, title, tagline, credits and a background painted for it. Generate backgrounds, characters (from the film's locked characters, in their outfits, cut out on a transparent background with a face-match score), elements and products, with up to four variations to swap between. Relight the whole poster so every element shares one light and colour grade; text is never touched by AI. Title, tagline, CTA and credits ideas in English, Hindi, Kannada, Telugu or Tamil.
- **Text:** 21 bundled poster fonts including Devanagari, Kannada, Telugu and Tamil display faces, drawn by the browser so Indian scripts are always shaped correctly. Gradients, outlines, shadows, pill backgrounds and auto-fit titles.
- **Export:** PNG, JPG, WebP or a 300 dpi PDF; every export is kept with the design. Autosave, named versions with restore, and a guard against overwriting a teammate who saved first.
- **Costs:** AI images are normal jobs, so budgets, approvals and the Costs page apply (about $0.07 per image with Nano Banana).
