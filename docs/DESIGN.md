# Tatvam AI Studio: "Command" design system

A professional production cockpit. The app is a fixed viewport: a top command bar, a slim rail, the work area, a status strip (and a bottom tab bar on phones). Inside a project all of that gives way to two bars: one 48 px project header on top and the 44 px Next bar at the bottom. Panels scroll; the page does not. Everything is data-dense but calm: hairlines instead of fills, one electric accent, mono type for numbers.

## 1. Look

| Role | Token | Use |
| --- | --- | --- |
| Ground | `bg-bg` | the page behind everything (`hud-bg` adds two faint colour glows and a hairline grid) |
| Panel | `bg-panel` | rails, cards, panels |
| Raised | `bg-raised` | inputs, chips, nested blocks |
| Hover | `bg-hover` | hover and selected rows |
| Line | `border-line` | the one hairline colour. Never a heavier border |
| Text | `text-ink` / `text-mute` / `text-dim` | primary / secondary / hints and meta |
| **Accent** (electric cyan) | `accent`, `text-accent-ink` | focus, the active item, the primary action. One primary button per area |
| Accent 2 (indigo) | `accent-2` | only in gradients with the accent (wordmark, progress, edge light) |
| **Money** (amber) | `money` | anything that costs: prices, spend, budget |
| **AI** (violet) | `ai` | the Director and AI-authored content |
| Status | `ok` `warn` `bad` `info` | state only, never decoration |

- **No hex and no `gray-*`** in components. Tokens only; the light theme is the same tokens re-valued.
- Type: Inter for UI, **JetBrains Mono (`font-mono` / `.mono`) for every number, id, timecode, price and label**. Smallest text is `text-2xs` (11 px). Headings `tracking-tight`. Use `.num` for aligned figures.
- Corners: controls `rounded-lg` (8 px), cards `rounded-xl` (10 px), modals `rounded-2xl` (14 px). Do not round more than that.
- Depth comes from hairlines and a faint top highlight, not from big shadows. Glow (`shadow-[0_0_Npx_var(--color-accent)]`) is for the active/live thing only.

## 2. HUD utilities (index.css)

| Class | What it is |
| --- | --- |
| `hud-bg` | workspace ground with glows + grid. Put it on a page's scroll container |
| `hud` | corner brackets in the top-left and bottom-right, brighter on hover. Panels, stat tiles, modals, interactive cards |
| `eyebrow` | tiny uppercase mono label (above a value, a section, a field group) |
| `mono` / `num` | mono type with tabular figures |
| `edge-light` | a gradient hairline; place `absolute inset-x-4 top-0 h-px` at the top of a panel |
| `text-gradient` | accent to accent-2 gradient text (wordmark, one hero number per page at most) |
| `live-dot` (`is-idle` `is-warn` `is-bad`) | a pulsing status dot |
| `eq` (`is-idle`) | four equalizer bars for "work is running" |
| `sweep` | a light sweeping across a bar (indeterminate progress) |
| `gen-ring` | the conic border for something generating right now |

## 3. Components (import from `components/ui`)

- `Panel` is the standard block: `eyebrow` (mono label), `title`, `icon`, `actions`, `flush` for tables/lists, `tone` for a coloured eyebrow and a lit edge. **Every dashboard block is a Panel.**
- `Metric`: big mono value, unit, delta, sparkline. KPI strips are rows of Metric inside one Panel, or `Stat` tiles.
- `Meter`: segmented bar (like a battery / flight path). `ProgressRing`: circular progress. `StatusDot`, `Tag` (`KEY value` mono chip), `Badge` (tones: accent, money, ai, ok, warn, bad, info, neutral).
- `Tabs` (in-page), `Segmented`, `Toggle`, `Select`, `Input`, `Modal`, `Menu`, `Popover`, `Tooltip` are unchanged in API.
- Project pages use `RoomPage` + `RoomHeader` + `SectionCard` (room/kit); top-level pages use `Page` + `PageHeader`. Both already carry the HUD ground.

## 4. Layout rules

- **Bento grids**: `grid gap-4` with `@container` queries, 12 columns on wide, 2 on medium, 1 on narrow. A row mixes one big panel with small ones; avoid a wall of equal cards.
- **Density**: rows 36 px, panels `p-4`, gaps 12/16. Tables use mono figures, right-aligned numbers, a hairline between rows, and a sticky header.
- **Hierarchy per page**: header (icon chip + title + one-line purpose + actions) → a KPI/status strip → the main work → secondary panels. Status is shown with an icon and a word, never colour alone.
- **Navigation**: the global rail (icons) outside projects; inside a project, the project header (back, title, the steps as a compact stepper, the open step's views with writers' and specialists' tools under **Advanced**, spend, the Director, the ⋯ menu) is the only nav. Pages never add their own top tab row; use `Tabs` for in-page views only.
- **Next bar** (projects): left, what is being made (opens the job list); right, a red **"N problems"** chip when the last run left any (opens the problem list), the next step in plain words, its price when it costs money, and one primary button. Every project screen has it, so there is always a way forward.
- **Problems you can act on**: a problem is said in plain words (what failed, then what to do next) and always carries its one fix as a button: Retry, Try another engine, Make the voice, Open the shot, or Make it for me. One list component (`pages/project/FixList`) draws them in the Next bar, on the Overview's Problems card; the canvas shows the same on the shot (a red step dot, a failure card with the fix). Status tone `bad` for a failed step, `warn` for a note or a budget stop.
- **Money before work**: every button that spends shows its price first (the cost dialog from `useGenerate().generate` / `priced`, or a price on the button from a backend quote). No single-key shortcut spends money. `submit` is for free work only. "Try another engine" lists each engine with its price for that shot, and the pick still opens the cost dialog.
- **Plain words** in labels: Picture (not keyframe), Mouth sync, Out of date, Quality check, Cast, Text view, Advanced layout, Pro finishing, Try another engine, Quick draft first (480p), Make the final film, Recipes.
- **Choices you reuse are chips**: Make it for me's recipes are one row of chips above the steps (the one matching the current choices is lit, `accent`); a chip only fills the dialog, the price still shows before anything starts. A draft recipe carries a small `480p` mono tag in the AI colour.
- **Takes are a strip**: a shot's takes are small thumbnails newest first, a kind icon in the corner, the ones in use outlined in the accent with a check; clicking another uses it. Nothing in the strip deletes.
- Empty, loading (skeleton) and error (retry) states on every view. Dialogs trap focus. Hit targets are at least 28 px (40 px on phones).

## 5. Motion

At most 450 ms and always reduced-motion aware. Enter with `rise(i)` (38 ms stagger, capped at 14 items); panels do not animate on hover except brackets and edge light. Live things (running jobs, generating tiles) use `eq`, `live-dot` or `gen-ring`. Do not animate lists longer than about 40 items.

## 6. Language and content

All user-visible text goes through `t()` / `tr()`. Indic strings run about 30 % longer: no fixed-width labels. Money is always shown in `money` colour and mono. Product name: **Tatvam AI Studio** (wordmark `TATVAM`, subtitle `AI STUDIO`).

## Money (USD and INR)

Spend is stored and billed in US dollars. The UI can show rupees beside it (preference: Both, USD or INR; live rate from `GET /api/rates`).

- Format money with `usd()` from `lib/format` (a plain string: `$12.40 ≈ ₹1,201`). Never hand-build a `$` string.
- Use `usdOnly()` for values that are defined in dollars (a cap typed into a field) and `usdPerSec()` for prices per second.
- Big figures (KPI tiles, hero numbers) go through `Metric`, `Stat` or `AnimatedNumber`, which split the string so the dollars are large and the rupees small beside or under them. For a one-off big figure use `<Money v={...} />`.
- Chart axes use `axisMoney()`, which follows the mode. Rupees use Indian digit grouping (₹1,03,400) and compact lakh and crore labels (`rupeesShort`).
- The Shell re-mounts the page when the mode changes or the first rate arrives, so no figure shows a stale format.
