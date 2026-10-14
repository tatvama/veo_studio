/**
 * News Room (docs/EDITOR.md §16): broadcast graphics for the Tatvam Editor. Tickers, bugs, name straps, boards,
 * screen layouts, stingers, openers and animated backgrounds are all **templates**: layers with blanks (fields), one
 * design per ratio, drawn in the colours, fonts and motion of a **channel look**. A graphic on the timeline is a clip
 * whose source is `{ type: "graphic", gfx: GfxInstance }`.
 *
 * Pure types: no runtime code, so Node's type stripping runs the tests as written.
 */

// ── ratios and design space ──────────────────────────────────────────────────

/** A design per ratio. Design space (pixels): 16:9 = 1920×1080, 9:16 = 1080×1920, 1:1 = 1080×1080, 4:5 = 1080×1350. */
export type GfxRatio = "16:9" | "9:16" | "1:1" | "4:5";
/** x, y (top-left), w, h in design pixels. */
export type Box = [number, number, number, number];

// ── look ─────────────────────────────────────────────────────────────────────

/**
 * Colours a layer can use by name: "@primary", "@secondary" … (optionally "@primary/60" = 60 % opacity), or a plain
 * "#rrggbb" / "#rrggbbaa". A gradient is two paints and an angle (degrees, 0 = left → right).
 */
export type LookColor = "primary" | "secondary" | "accent" | "dark" | "light" | "text" | "textOnPrimary" | "breaking" | "live" | "up" | "down";
export type Paint = string | { gradient: [string, string]; angle?: number };
/** "@headline", "@body", "@numbers" (the look's fonts) or a family name. */
export type FontName = string;
export interface FontRef { family: string; weight: number }
/** Scripts with their own font in a look (ISO 15924, lower case). */
export type ScriptId = "latn" | "deva" | "knda" | "telu" | "taml" | "beng" | "gujr" | "mlym" | "guru" | "orya";

export interface ChannelLook {
  id: string; name: string;
  /** Ready looks ship with the app; the rest are the user's (saved in the edit and in the look library). */
  builtIn?: boolean;
  colors: Record<LookColor, string>;
  fonts: { headline: FontRef; body: FontRef; numbers: FontRef; scripts?: Partial<Record<ScriptId, FontRef>> };
  /** The channel logo: an image in the edit (mediaId), an embedded small image (data: URL ≤ 256 KB, so a look file
   *  travels on its own), or a text logo drawn in the look's fonts. */
  logo?: { mediaId?: string; image?: string; text?: string };
  /** How things move: sharp = quick cubic, smooth = soft quint, bouncy = a little overshoot. */
  motion: "sharp" | "smooth" | "bouncy";
  /** How plates look: flat, glass (translucent with a light edge), angled (slanted ends), rounded. */
  plate: "flat" | "glass" | "angled" | "rounded";
  /** Corner radius for rounded plates (design px). */
  radius: number;
  /** Straps and tags in capitals. */
  upper: boolean;
  /** Where the logo bug sits, its size (1 = default) and opacity (0..1). */
  bug: { corner: "tl" | "tr" | "bl" | "br"; scale: number; opacity: number };
  /** Numbers: Indian grouping (1,00,000; lakh / crore) or international; Latin or native digits; currency sign. */
  numbers: { system: "indian" | "international"; digits: "latin" | "native"; currency: string };
  /** Clocks and dates. `zone` is an IANA zone ("Asia/Kolkata"). */
  clock: { hours: 12 | 24; zone: string; date: "dmy" | "mdy" | "long" };
  /** Between ticker items. */
  separator: "dot" | "diamond" | "bar" | "logo" | "slash";
  /** Sound hints for auto SFX (SFX preset tags). */
  sounds?: { in?: string; out?: string; stinger?: string };
}

// ── fields (the blanks) and values ───────────────────────────────────────────

export type GfxFieldType = "text" | "longtext" | "list" | "number" | "image" | "toggle" | "choice" | "table" | "color" | "datetime";

/** One ticker / list item. `value` / `delta` for markets and scores; `flash` = a priority item. */
export interface GfxListItem { text: string; tag?: string; flash?: boolean; icon?: string; value?: number; delta?: number; color?: string }
export type GfxTableRow = Record<string, string | number>;
/** An image in the edit (a MediaItem id), with an optional crop (fractions of the picture: x, y, w, h). */
export interface GfxImageRef { mediaId: string; crop?: [number, number, number, number] }
export type GfxValue = string | number | boolean | null | string[] | GfxListItem[] | GfxTableRow[] | GfxImageRef;

export interface GfxField {
  /** Used in text as "{id}". Stable: values are kept by id when a template changes. */
  id: string; label: string; type: GfxFieldType;
  default: GfxValue;
  hint?: string; group?: string; required?: boolean;
  /** text: a soft limit the Fill in form shows; longtext / list: lines. */
  maxLength?: number; maxItems?: number;
  /** choice */
  options?: { value: string; label: string }[];
  /** table: its columns (number columns count and format). */
  columns?: { id: string; label: string; type: "text" | "number" | "color" }[];
  /** number: how it is written. */
  format?: NumberFormat;
  /** Where this field's value usually comes from: "person.name", "person.role", "place", "story.headline" … (the
   *  rundown and the people library fill these). */
  fill?: string;
}

export interface NumberFormat {
  decimals?: number; prefix?: string; suffix?: string;
  /** "look" = the look's currency sign. */
  currency?: boolean;
  /** 1,23,45,678 → "1.23 crore" (Indian) / "12.3M" (international). */
  compact?: boolean;
  /** Show + for positive numbers (deltas). */
  sign?: boolean;
}

// ── layers ───────────────────────────────────────────────────────────────────

/**
 * Layer kinds. The core draws the basic ones; the rest are registered by their module
 * (render/kinds/*.ts, `registerLayerKind`). The Designer builds its inspector from each kind's `props`.
 */
export type GfxLayerKind =
  | "rect" | "text" | "image" | "logo" | "line" | "icon"            // core (render/kinds/basic.ts)
  | "ticker" | "clock"                                               // tickers (render/kinds/ticker.ts, clock.ts)
  | "number" | "list" | "bars" | "table" | "pins" | "stamp"          // boards (render/kinds/number.ts …, boards/stamp.ts)
  | "slot"                                                           // layouts (render/kinds/slot.ts)
  | "shine" | "panels" | "bg" | "countdown"                          // wipes (render/kinds/shine.ts, panels.ts, bg.ts)
  | (string & {});

export type AnimKind =
  | "none" | "fade" | "slide" | "wipe" | "grow" | "flip" | "pop" | "zoom" | "rise" | "drop" | "blur" | "typewriter"
  | "sweep" | "unfold" | "stagger" | (string & {});
export type AnimDir = "left" | "right" | "up" | "down";
export type AnimEase = "look" | "linear" | "ease_in" | "ease_out" | "ease_in_out" | "back" | "elastic" | "bounce" | "expo";

/** One animation phase of a layer. Times are seconds; `delay` counts from the phase start (in: the clip start; out:
 *  the start of the graphic's out phase). */
export interface AnimStep {
  kind: AnimKind; dir?: AnimDir; dur?: number; delay?: number; ease?: AnimEase;
  /** Text: animate per line / word / letter (Indic: never per letter, letters join), lists: per item. */
  by?: "all" | "line" | "word" | "char" | "item";
  /** Seconds between parts (by ≠ all). */
  stagger?: number;
  /** Slide / rise / drop distance in design px (default: the layer's size in that direction). */
  distance?: number;
}

/** A loop while the layer is shown: blink (LIVE dot), pulse, shine (a light sweep every `period` s), float, spin,
 *  breathe (glow), flash (priority items). */
export interface LoopSpec { kind: "blink" | "pulse" | "shine" | "float" | "spin" | "breathe" | "flash" | (string & {}); period: number; amount?: number; delay?: number }

export interface LayerAnim { in?: AnimStep; out?: AnimStep; loop?: LoopSpec }

export interface ShadowSpec { color: string; blur: number; x: number; y: number }

export interface GfxLayer {
  /** Unique in its design; the same id in each ratio's design is "the same layer" (overrides and the Designer use it). */
  id: string; name: string; kind: GfxLayerKind;
  box: Box;
  rotation?: number; /** 0..1 */ opacity?: number;
  /** Kind-specific properties, described by the kind's `props` (PropDef) — e.g. rect: fill, stroke, radius, skew;
   *  text: text, font, size, weight, color, align … */
  p: Record<string, unknown>;
  anim?: LayerAnim;
  /** Shown only when this field has a value (text not empty, toggle on, image set): "{field}" or "!{field}" (when empty);
   *  or when it equals a value: "{field}=value" / "{field}!=value" (case-insensitive). */
  when?: string;
  /** For "Make vertical" and other ratios: which edges the layer keeps to. */
  pin?: { x?: "left" | "right" | "center" | "stretch"; y?: "top" | "bottom" | "center" | "stretch" };
  shadow?: ShadowSpec;
  blend?: "normal" | "screen" | "multiply" | "add" | "overlay";
  /** Draw only inside another layer's box (a mask reveal behind a plate): that layer's id. */
  clip?: string;
  hidden?: boolean;
  /** Designer only: can't be selected on the monitor. */
  locked?: boolean;
}

export interface GfxDesign {
  layers: GfxLayer[];
  /** The design's own safe area (design px insets: top, right, bottom, left); default: the format's (formats.ts). */
  safe?: [number, number, number, number];
}

// ── templates ────────────────────────────────────────────────────────────────

export type GfxCategory = "Tickers" | "Bugs" | "Straps" | "Boards" | "Layouts" | "Stingers" | "Openers" | "Backgrounds";
/** Which graphics track a template goes on (bottom → top: background, layout, board, strap, ticker, bug, wipe). */
export type GfxRole = "background" | "layout" | "board" | "strap" | "ticker" | "bug" | "wipe";

export interface GfxTemplate {
  /** Built-in: "nr.<category>.<name>" (stable, never renamed). The user's: "my.<uuid>". */
  id: string; name: string; category: GfxCategory; role: GfxRole;
  /** Sub type for filters and tools: "crawl", "flip", "breaking", "anchor", "two_way", "stinger" … */
  kind?: string;
  description?: string; tags?: string[];
  /** Default length in seconds (0 = to the end of the sequence: bugs, tickers, backgrounds). */
  seconds: number;
  /** Seconds of the in and out phases (layer delays fit inside them). */
  timing: { in: number; out: number };
  fields: GfxField[];
  /** One design per ratio. Built-ins have 16:9 and 9:16; 1:1 / 4:5 fall back to an automatic layout. */
  designs: Partial<Record<GfxRatio, GfxDesign>>;
  /** auto = length from reading time; until-next = until the next graphic on its track; fill = to the sequence end. */
  hold?: "auto" | "fixed" | "until-next" | "fill";
  /** Plays over its whole length and loops seamlessly (tickers, bugs, backgrounds). */
  loop?: boolean;
  /** Stingers: the fraction of the length where the frame is fully covered (the cut sits there). */
  cut?: number;
  /** Sound hints for auto SFX (SFX preset tags: "whoosh", "impact", "swish" …). */
  sounds?: { in?: string; out?: string; cut?: string };
  /** builtin | mine (made or changed in the Designer) | imported. Locked: others can only fill it in. */
  source?: "builtin" | "mine" | "imported"; locked?: boolean;
  author?: string; modified?: string;
  version: 1;
}

// ── on the timeline ──────────────────────────────────────────────────────────

/** A graphic clip's source: `{ type: "graphic", gfx: GfxInstance }` (model/types.ts ClipSource). */
export interface GfxInstance {
  /** Key into `EditProject.newsroom.templates` (the template is copied into the edit when first used, so the edit
   *  opens and exports the same anywhere). */
  template: string;
  values: Record<string, GfxValue>;
  /** A look for this graphic only (default: the edit's look). */
  look?: string;
  /** Both-ratio edits: show it only in these ratios (default: all). */
  ratios?: GfxRatio[];
  /** Changes to this graphic only ("Change only this one" in the Designer): by layer id, or "<layerId>@<ratio>" for
   *  one ratio only (positions, sizes, shown in one ratio). */
  overrides?: Record<string, Partial<GfxLayer>>;
  /** Values that come from a data source (frozen in `newsroom.data`), by field id. */
  bind?: Record<string, { source: string; path?: string }>;
  /** Language versions: values per language code ("hi", "kn" …) used when that language is exported. */
  langs?: Record<string, Record<string, GfxValue>>;
  /** Variation seed (stingers, backgrounds). */
  seed?: number;
}

/** A video (or image) clip shown in a screen layout's box: `TimelineClip.slot`. The box comes from the layout graphic
 *  on screen at that moment (its "slot" layers), per ratio, so a layout change or the other ratio moves it. */
export interface SlotBinding {
  /** The layout's box number (0 = main). */
  index: number;
  /** cover = fill the box (default); contain = whole picture inside it. */
  fit?: "cover" | "contain";
  /** 1 = just filling the box; more zooms in. */
  zoom?: number;
  /** Where the picture is aimed inside the box: -0.5..0.5 of the picture from centre. */
  offset?: [number, number];
}

// ── the edit's News Room document ────────────────────────────────────────────

export interface RundownStory {
  id: string; slug: string; headline: string;
  /** Second strap line. */
  strap?: string;
  /** Person ids (people library). */
  reporter?: string; guests?: string[];
  location?: string;
  points?: string[]; ticker?: string[];
  notes?: string;
  /** Where it sits on the timeline (sequence frames), once built or marked. */
  start?: number; end?: number;
  layout?: string;
  status?: "draft" | "ready" | "done";
  /** Template ids to build for this story (default: strap + key points when there are points). */
  graphics?: string[];
}

export interface Person {
  id: string; name: string; role: string;
  kind?: "anchor" | "reporter" | "guest" | "expert" | "other";
  location?: string;
  photo?: GfxImageRef;
  /** The name in other languages / scripts: { hi: "प्रिया राव" }. */
  names?: Record<string, string>;
  /** The transcript speaker label this person is ("Speaker 1"), for automatic straps. */
  speaker?: string;
}
export interface Place { id: string; name: string; names?: Record<string, string> }

export interface DataSource {
  id: string; name: string;
  kind: "csv" | "json" | "rss" | "sheet" | "manual";
  /** Web address (RSS, JSON, a published Google Sheet CSV) or a local file. */
  url?: string; path?: string;
  /** JSON: the path to the rows ("data.items"). */
  root?: string;
}
/** What a data source said when it was last refreshed: saved in the edit so every export repeats exactly. */
export interface DataSnapshot { source: string; at: string; rows: GfxTableRow[]; items?: GfxListItem[]; error?: string }

export interface NewsroomSettings {
  /** Show title-safe / action-safe guides on the monitors. */
  safeGuides: boolean;
  /** Straps move up above a breaking bar, nothing covers the bug (render-time rules). */
  collision: boolean;
  /** Words per second for automatic hold lengths. */
  readSpeed: number;
  tickerSpeed: "slow" | "normal" | "fast";
  /** Show the "AI-generated" label while AI-made studio media is on screen (India IT Rules 2026). */
  aiLabel: boolean;
}

/** `EditProject.newsroom`: present once the edit is a news edit (or a graphic was added). */
export interface NewsroomDoc {
  version: 1;
  /** The edit's look id (a key of `looks`, or a built-in look id). */
  look: string;
  /** Looks used in this edit (copied in, so it opens the same anywhere). */
  looks: Record<string, ChannelLook>;
  /** Templates used in this edit, by id (copied in on first use). */
  templates: Record<string, GfxTemplate>;
  /** "both" = one timeline, a 16:9 and a 9:16 output (the 9:16 is made on the fly: newsroom/companion.ts). */
  ratio: "16:9" | "9:16" | "both";
  rundown: RundownStory[];
  people: Person[]; places: Place[];
  sources: DataSource[];
  data: Record<string, DataSnapshot>;
  /** Clocks show this time (ISO local date-time) plus the time into the sequence: exports always repeat. */
  airTime?: string;
  /** Language versions of this edit ("en" first). */
  langs?: string[];
  /** The graphics playlist: ready graphics on F1–F12. */
  playlist?: { key: string; template: string; values: Record<string, GfxValue>; name?: string }[];
  settings: NewsroomSettings;
}
