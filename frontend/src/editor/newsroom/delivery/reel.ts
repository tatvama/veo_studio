/**
 * Look preview reel (docs/EDITOR.md §16.11): every graphic category in a channel look with its sample text, one
 * graphic after another, a title card before each category, over the look's first animated background (or its dark
 * colour), for a client to approve. A generated sequence: the panel adds it to the edit or exports it like any
 * other. Pure.
 */
import { uid } from "../../model/ids.ts";
import { secondsToFrames } from "../../model/time.ts";
import type { Sequence } from "../../model/types.ts";
import { defaults } from "../templates/kit.ts";
import type { ChannelLook, GfxCategory, GfxTemplate } from "../types.ts";
import { blankSequence, placeColor, placeGraphic, placeTitle, topTrack } from "./build.ts";

export const REEL_CATEGORIES: GfxCategory[] = ["Openers", "Bugs", "Straps", "Tickers", "Boards", "Layouts", "Stingers", "Backgrounds"];

export interface ReelOptions {
  look: ChannelLook;
  /** The templates to show (usually the built-ins plus the edit's own). */
  templates: GfxTemplate[];
  categories?: GfxCategory[];
  /** At most this many per category (0 = all). */
  perCategory?: number;
  /** Seconds per graphic (stingers keep their own shorter length) and per title card. */
  seconds: number; titleSeconds: number;
  width: number; height: number; fps: number;
  /** "background": the look's first looping background under everything; "color": its dark colour. */
  backdrop?: "background" | "color";
}

export interface ReelItem { category: GfxCategory; template: string; name: string; start: number; frames: number }

/** The reel as one sequence, what's in it (by start) and the templates it uses (sent with the export). */
export function planReel(o: ReelOptions): { sequence: Sequence; items: ReelItem[]; templates: Record<string, GfxTemplate> } {
  const cats = (o.categories ?? REEL_CATEGORIES).filter((c) => o.templates.some((t) => t.category === c));
  const per = (s: number) => Math.max(1, secondsToFrames(s, o.fps));
  const titleF = o.titleSeconds > 0 ? per(o.titleSeconds) : 0;
  let seq: Sequence = { ...blankSequence(`Look preview · ${o.look.name}`, o), id: uid("s") };
  const used: Record<string, GfxTemplate> = {};
  const items: ReelItem[] = [];
  const titleTrack = topTrack(seq, "Category titles");
  seq = titleTrack.seq;
  let at = 0;
  const lookGfx = { look: o.look.id };
  for (const cat of cats) {
    const list = o.templates.filter((t) => t.category === cat).slice(0, o.perCategory ? o.perCategory : undefined);
    if (titleF) {
      seq = placeTitle(seq, titleTrack.trackId, at, titleF, { text: cat, box: [0.1, 0.36, 0.8, 0.2], size: 110, weight: 800, color: o.look.colors.text,
        font: o.look.fonts.headline.family, animIn: "fade", animOut: "fade",
        look: { sub: { text: `${o.look.name} · ${list.length} graphic${list.length === 1 ? "" : "s"}`, size: 40, color: o.look.colors.accent } } });
      at += titleF;
    }
    for (const t of list) {
      const own = cat === "Stingers" && t.seconds > 0 ? Math.min(t.seconds, o.seconds) : o.seconds;
      const frames = per(own);
      seq = placeGraphic(seq, t, at, frames, { ...lookGfx, values: defaults(t) }).seq;
      used[t.id] = t;
      items.push({ category: cat, template: t.id, name: t.name, start: at, frames });
      at += frames;
    }
  }
  // under everything: the look's first animated background, else its dark colour (not under the Backgrounds
  // themselves: they are the picture there)
  const v1 = seq.tracks.find((t) => t.kind === "video" && !t.gfxRole)!;
  const bgTpl = o.backdrop !== "color" ? o.templates.find((t) => t.category === "Backgrounds") : undefined;
  const own = items.filter((x) => x.category === "Backgrounds");
  const gap = own.length ? [own[0].start, own[own.length - 1].start + own[own.length - 1].frames] : [at, at];
  for (const [a, b] of [[0, gap[0]], [gap[1], at]]) {
    if (b <= a) continue;
    if (bgTpl) {
      seq = placeGraphic(seq, { ...bgTpl, role: "background" }, a, b - a, { ...lookGfx, values: defaults(bgTpl) }, "Backdrop").seq;
      used[bgTpl.id] = bgTpl;
    } else seq = placeColor(seq, v1.id, a, b - a, o.look.colors.dark, "Backdrop");
  }
  return { sequence: seq, items, templates: used };
}
