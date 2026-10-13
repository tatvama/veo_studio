/**
 * News shorts maker (docs/EDITOR.md §16.11): one 9:16 short per rundown story. Each short is the story's range of
 * the vertical version of the sequence (companionProject), after a headline card, with the story's strap and a
 * ticker (added when the range has none of its own) and captions from the transcript when there is one. The panel
 * shows the list, then queues one export per short. Pure.
 */
import { uid } from "../../model/ids.ts";
import { framesToSeconds, secondsToFrames } from "../../model/time.ts";
import type { EditProject, Sequence, TitleSpec } from "../../model/types.ts";
import type { CaptionCue } from "../../templates/captions.ts";
import type { GfxField, GfxListItem, GfxTemplate, GfxValue, Person, RundownStory } from "../types.ts";
import { graphicsOf, placeColor, placeGraphic, placeTitle, sliceSequence, topTrack } from "./build.ts";
import { deliveryName, uniqueNames } from "./names.ts";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const HEADLINE = new Set(["headline", "title", "text", "line1", "main", "story", "heading"]);
const STRAP = new Set(["strap", "subtitle", "sub", "line2", "subline", "secondary", "detail"]);
const SLUG = new Set(["slug", "tag", "category", "label", "topic"]);
const PLACE = new Set(["location", "place", "city", "dateline"]);
const ITEMS = new Set(["items", "lines", "ticker", "news", "headlines"]);
const POINTS = new Set(["points", "bullets", "keypoints"]);

/** A story's text for a template's fields: by the field's `fill` hint, else by its id or label. */
export function storyValues(t: GfxTemplate, story: RundownStory, o: { people?: Person[]; tickerLines?: string[] } = {}): Record<string, GfxValue> {
  const reporter = o.people?.find((p) => p.id === story.reporter);
  const lines = (story.ticker?.length ? story.ticker : o.tickerLines ?? []).filter(Boolean);
  const out: Record<string, GfxValue> = {};
  const set = (f: GfxField, v: GfxValue | undefined) => { if (v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) out[f.id] = v; };
  for (const f of t.fields) {
    const hint = f.fill ?? "";
    const keys = [norm(f.id), norm(f.label)];
    const is = (s: Set<string>) => keys.some((k) => s.has(k));
    const list = (xs: string[] | undefined) => (xs?.length ? xs.map((text): GfxListItem => ({ text })) : undefined);
    if (f.type === "list") {
      if (hint === "story.points" || is(POINTS)) set(f, list(story.points));
      else if (hint === "story.ticker" || is(ITEMS)) set(f, list(lines));
      continue;
    }
    if (f.type !== "text" && f.type !== "longtext") continue;
    if (hint === "story.headline" || (!hint && is(HEADLINE))) set(f, story.headline);
    else if (hint === "story.strap" || (!hint && is(STRAP))) set(f, story.strap ?? "");
    else if (hint === "story.slug" || (!hint && is(SLUG))) set(f, story.slug);
    else if (hint === "place" || hint === "story.location" || (!hint && is(PLACE))) set(f, story.location ?? "");
    else if (hint === "person.name") set(f, reporter?.name);
    else if (hint === "person.role") set(f, reporter?.role);
  }
  // a template with no recognisable headline field gets the headline in its first text field
  if (story.headline && !Object.values(out).includes(story.headline)) {
    const first = t.fields.find((f) => (f.type === "text" || f.type === "longtext") && out[f.id] === undefined);
    if (first) out[first.id] = story.headline;
  }
  return out;
}

export interface ShortsOptions {
  stories: RundownStory[];
  people?: Person[];
  /** The vertical version of the story's sequence (companionProject) and the project it is in. */
  source: { project: EditProject; sequence: Sequence };
  /** The headline card: a template (Openers / Boards), else the headline as a title on a colour. 0 s = no card. */
  card: { seconds: number; template?: GfxTemplate | null; color: string; font?: string; textColor?: string };
  /** Added when the story's range has none of its own. */
  strap?: GfxTemplate | null; strapSeconds?: number;
  ticker?: GfxTemplate | null;
  /** Caption cues on the sequence's timeline (frames), e.g. from the transcripts (captionTrackFromSegments). */
  cues?: CaptionCue[];
  look?: string;
}

export interface PlannedShort {
  story: RundownStory; name: string;
  /** Null when the story isn't on the timeline yet. */
  sequence: Sequence | null;
  frames: number; seconds: number;
  parts: { card: boolean; strap: "own" | "added" | "none"; ticker: "own" | "added" | "none"; captions: number };
  problems: string[];
}

/** Where captions sit in 9:16: clear of the bottom 22 % the apps draw on (fractions of the frame). */
export const VERTICAL_CAPTION_BOX: [number, number, number, number] = [0.08, 0.6, 0.84, 0.14];

export function planShorts(o: ShortsOptions): PlannedShort[] {
  const src = o.source.sequence;
  const fps = src.fps;
  const cardFrames = o.card.seconds > 0 ? Math.max(1, secondsToFrames(o.card.seconds, fps)) : 0;
  const names = uniqueNames(o.stories.map((s) => deliveryName(s.slug || s.headline || "Story", { ratio: "9:16" })));
  const others = o.stories.map((s) => s.headline).filter(Boolean);
  return o.stories.map((story, i) => {
    const base: PlannedShort = { story, name: names[i], sequence: null, frames: 0, seconds: 0, parts: { card: false, strap: "none", ticker: "none", captions: 0 }, problems: [] };
    const a = story.start, b = story.end;
    if (a === undefined || b === undefined || !(b > a)) return { ...base, problems: ["Not on the timeline yet: Build the rundown (or mark the story) first"] };
    const len = b - a;
    const total = cardFrames + len;
    let seq = sliceSequence(o.source.project, src, a, b, cardFrames, `Short · ${story.slug || story.headline}`);
    if (!seq.clips.length) base.problems.push("Nothing is on the timeline in this story's range");
    const gfx = { ...(o.look ? { look: o.look } : {}) };
    // 1. the headline card
    if (cardFrames) {
      if (o.card.template) seq = placeGraphic(seq, o.card.template, 0, cardFrames, { ...gfx, values: storyValues(o.card.template, story, o) }).seq;
      else {
        const v1 = seq.tracks.filter((t) => t.kind === "video" && !t.gfxRole).sort((x, y) => x.index - y.index)[0];
        seq = placeColor(seq, v1.id, 0, cardFrames, o.card.color, "Headline card");
        const r = topTrack(seq, "Headline card");
        const spec: Partial<TitleSpec> & { text: string } = { text: story.headline || story.slug, box: [0.08, 0.3, 0.84, 0.3], size: 92, weight: 800,
          color: o.card.textColor ?? "#ffffff", animIn: "fade", animOut: "fade", ...(o.card.font ? { font: o.card.font } : {}) };
        seq = placeTitle(r.seq, r.trackId, 0, cardFrames, spec);
      }
      base.parts.card = true;
    }
    // 2. the strap and the ticker, unless the story's range has its own
    if (graphicsOf(seq, "strap").some((c) => c.start >= cardFrames)) base.parts.strap = "own";
    else if (o.strap) {
      const hold = Math.min(len, secondsToFrames(o.strapSeconds ?? (o.strap.seconds > 0 ? o.strap.seconds : 6), fps));
      seq = placeGraphic(seq, o.strap, cardFrames, hold, { ...gfx, values: storyValues(o.strap, story, o) }).seq;
      base.parts.strap = "added";
    }
    if (graphicsOf(seq, "ticker").length) base.parts.ticker = "own";
    else if (o.ticker) {
      seq = placeGraphic(seq, o.ticker, 0, total, { ...gfx, values: storyValues(o.ticker, story, { ...o, tickerLines: others.filter((h) => h !== story.headline) }) }).seq;
      base.parts.ticker = "added";
    }
    // 3. captions that start in the story, moved with it (their karaoke words are timed from their own start)
    const cues = (o.cues ?? []).filter((c) => c.start >= a && c.start < b);
    if (cues.length) {
      const r = topTrack(seq, "Captions");
      seq = r.seq;
      for (const c of cues) {
        const from = c.start - a + cardFrames, to = Math.min(total, c.end - a + cardFrames);
        if (to > from) seq = placeTitle(seq, r.trackId, from, to - from, { ...c.spec, box: VERTICAL_CAPTION_BOX });
      }
      base.parts.captions = cues.length;
    }
    return { ...base, sequence: { ...seq, id: uid("s") }, frames: total, seconds: framesToSeconds(total, fps) };
  });
}
