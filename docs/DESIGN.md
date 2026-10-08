# VEO Studio — design system and UI guide

How the interface is built and how to keep it consistent. Applies to every page and component in `frontend/src`.

**Feel we are going for:** calm, dense and precise, like Linear / Frame.io / Runway. Dark-first, one warm accent, strong
hierarchy, quick motion that explains what changed. Never decorative for its own sake.

---

## 1. Tokens (`src/index.css`)

Use token classes only. No hex values or `gray-*` / `zinc-*` colours in components (the light theme works by swapping the
variables). Exception: user data such as brand-kit swatches or drawing strokes (inline `style`).

| Token | Use |
|---|---|
| `bg-bg` | page background |
| `bg-panel` | cards, sidebars, inputs, popovers' base |
| `bg-raised` | chips, secondary buttons, table headers, tooltips, popovers |
| `bg-hover` | hover state of rows / buttons |
| `border-line` | every border and divider |
| `text-ink` | primary text, values, titles |
| `text-mute` | secondary text, labels, descriptions (≈8:1 contrast) |
| `text-dim` | hints, timestamps, placeholders (≈5:1 — never for anything the user must read to act) |
| `text-accent-ink` | accent **text and icons** (deeper orange in the light theme). Use `bg-accent` / `border-accent` for fills. |
| `text-ok / warn / bad / info` | status text; `bg-ok/12 border-ok/30` for tinted surfaces |

**Type scale** (Inter variable, bundled): `text-2xs` 11px (hints, badges, kbd — the smallest text allowed) · `text-xs` 12 ·
`text-sm` 14 (default UI text) · `text-base` 16 · `text-lg` 18 (section titles) · `text-xl` 20 · `text-2xl` 24 (page titles) ·
`text-3xl` 30 (hero). Weights: 400 body, 500 labels/buttons, 600 titles. Headings use `tracking-tight`. Numbers that change
or align in columns use `tabular-nums`. Never write `text-[10px]` / `text-[9px]`.

**Radius:** controls `rounded-lg` (8) · cards `rounded-xl` (12) · modals `rounded-2xl` (16) · pills/avatars `rounded-full`.
**Shadows:** `shadow-card` (resting card), `shadow-lift` (hover), `shadow-pop` (popovers, menus), `shadow-modal`, `shadow-glow` (accent focus).
Bordered panels (`border bg-panel rounded-xl`) get `shadow-card` automatically.
**Spacing:** 4px grid. Page gutters `px-4 sm:px-6 lg:px-8`; card padding `p-4` (dense) or `p-5`; gaps `gap-2` (inline), `gap-3/4` (grids), `gap-6` (sections).

## 2. Layout

- Every routed page uses `<Page>` + `<PageHeader title subtitle icon actions />` (`components/ui`). It gives the scroll container, the
  single `<h1>`, consistent padding and an entrance animation. Widths: `narrow` (forms), `default`, `wide` (dashboards, grids), `full`.
- Group content with `<Section title description actions>`; use `Card`/bordered panels for each block.
- Grids: `grid gap-4 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]` rather than fixed column counts.
- Master/detail or settings pages: sticky side navigation (≥1024px) + content column; below that, a horizontal `ScrollStrip`.
- Toolbars that matter while scrolling are `sticky top-0 z-10 bg-bg/85 backdrop-blur`.
- Breakpoints: `<768` phone (stack everything, 44px touch targets), `768–1100` compact (slim sidebar, floating Director), `≥1100` docked.
  Components that live in resizable areas (project header, cards) use **container queries** (`@container` + `@3xl:` …) instead of viewport breakpoints.
- Long text: titles `truncate` with `title=` / tooltip; descriptions `line-clamp-2`; never let content push a container wider than its parent.
  Indic strings run ~30% longer than English — leave room.
- Everything must work with no data (empty state with a next action), while loading (skeleton shaped like the final content) and on error (message + retry).

## 3. Components (`import … from "../components/ui"`)

`Button` (primary / secondary / outline / ghost / danger; sm md lg; `loading`, `icon`, `iconRight`, `block`) · `IconButton` (needs `title` → accessible
name + animated tooltip; `shortcut`, `tipSide`) · `Input` `Textarea` `Select` `SearchField` `Field` · `Toggle` · `Segmented` · `Tabs` (with `count`) ·
`ScrollStrip` · `Modal` (`size` sm/md/lg/xl; focus trap built in; becomes a bottom sheet on phones) · `Popover` + `Menu` (anchored, flips, keyboard) ·
`Tooltip` (wrap any single element) · `Badge` (`dot`) · `Alert` (info/warn/bad/ok/accent) · `Card` (`interactive` → hover lift) ·
`Stat` (KPI tile with count-up) · `Sparkline` · `Progress` (`indeterminate`, `tone`, `size`) · `ProgressRing` · `Skeleton` / `SkeletonText` ·
`Empty` (animated icon) · `Avatar` / `AvatarStack` · `Kbd` · `AnimatedNumber`.

Rules of thumb
- One primary button per view area. Destructive actions are `danger` and confirm.
- Icon-only controls are always `IconButton` with a `title`. Native `title=` is only for non-interactive text.
- Form rows: `Field` label above control, hint below (`text-2xs text-dim`). Group related fields in a bordered card with a title.
- Status is never colour alone: pair with an icon or text.
- Money always goes through the cost dialog (`useGenerate`) — never spend on a bare click.

## 4. Motion

All motion is subtle (≤ 450 ms) and respects reduced-motion automatically (global CSS + `MotionConfig`).

| Situation | How |
|---|---|
| Page / block entrance | `<div {...rise(i)}>` (CSS, staggered 38 ms per sibling, capped at 14) — also `Reveal`, `InView` for below-the-fold blocks |
| Cards on hover | `lift` class (translateY −2px + shadow); clickable `Card` already does it |
| Press | buttons scale to 0.97 (built in) |
| Appear / disappear of a block | `AnimatePresence` + `motion.div` fade/slide (150–250 ms); lists use `layout` for smooth reflow |
| Switchers (tabs, segmented, sidebar) | shared `layoutId` sliding indicator (built in) |
| Numbers (costs, counts, stats) | `AnimatedNumber` / `Stat` |
| Bars | `Progress` animates with a spring; unknown duration → `indeterminate` |
| Loading data | **skeletons** shaped like the content. `Spinner` only inside buttons or tiny inline spots |
| Something generating right now | `gen-ring` class (rotating accent border) + `Progress` |
| Empty states | `Empty` (floating icon) |
| Overlays | modal/popover scale+fade, drawers slide with a spring |

```tsx
// staggered entrance: merge rise()'s class + style with your own
const r = rise(index);                       // { className: "anim-rise", style: { "--i": index } }
<li className={clsx("rounded-xl border ...", r.className)} style={r.style}>…</li>
<Tooltip content={t("Copy")}><button …/></Tooltip>   // wrap exactly ONE element
```

Don't animate: large lists past ~40 items (only the first screenful), layout properties on scroll, or anything that delays an action.
Prefer `transform` / `opacity`. Never animate the thing the user is trying to click.

## 5. Accessibility and content

- Every user-visible string goes through `t()` (`const t = useT()`; `tr()` outside React). English text is the key. Placeholders `{n}`.
- Contrast AA: use `text-mute` for readable secondary text; `text-dim` only for hints. Focus rings are global (`:focus-visible`).
- Keyboard: every action reachable; dialogs trap focus (built in); menus support arrows + Enter + Esc.
- Hit targets ≥ 28px on desktop, ≥ 40px on phones.
- Page `<title>` is set by the shell; a project page sets "Section · Project".

## 6. Per-page QA checklist (what "done" means)

1. Loads with a skeleton (no blank flash, no layout jump) and animates in.
2. Empty, loading, error and "lots of data" states all look intentional.
3. At 1280, 1024, 768 and 375 px wide: no horizontal scroll, nothing clipped, nothing overlapping, sensible stacking.
4. Light theme and dark theme both fine (contrast, borders, shadows, images).
5. Hindi / Kannada / Telugu / Tamil strings don't break layouts.
6. Hover, focus-visible, active, disabled and loading states exist on every control.
7. Tab order and keyboard use are sane; icon buttons have names.
8. No console errors or warnings; `npx tsc -p . --noEmit` is clean.

## 7. How to look at your work in the Browser pane (for people and agents)

- The pane is small (≈ 882×421). Native size gives the sharpest screenshots. For other widths use `resize_window`
  (custom sizes up to ~1024 wide render at good quality; wider ones are downscaled — judge layout, not text; mobile preset = 375×812 at 1:1).
- Open **your own tab** (`tabs_create`, then `navigate`); background tabs screenshot fine. Never touch other tabs.
- The dev app is already signed in. Do not change the account theme/language: for the light theme run
  `document.documentElement.dataset.theme = "light"` in your own tab (not persisted; reload resets it).
- Dev-only audit helper: add `<script src="/__audit.js">` through the console, then `__A.go("/route")`, `__A.check()` returns overflow / contrast /
  tiny-text / small-target / unnamed-control findings for the current page.
