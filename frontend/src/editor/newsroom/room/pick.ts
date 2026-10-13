/**
 * The News Room room (docs/EDITOR.md §16.8): which template a quick key, the starter set or the rundown Build uses
 * when the user hasn't chosen one. Picks by category / role, then the template's `kind`, then words in its id or name,
 * so it keeps working whatever the template owners call their designs. Pure.
 */
import type { GfxCategory, GfxRole, GfxTemplate } from "../types.ts";

export interface Want {
  category?: GfxCategory; role?: GfxRole;
  /** Preferred `kind`s, best first. */
  kinds?: string[];
  /** Words to look for in the id or name, best first. */
  words?: string[];
}

/** What each automatic job looks for. */
export const WANT = {
  nameStrap: { category: "Straps", kinds: ["anchor", "guest", "expert", "name", "reporter"], words: ["anchor", "name", "guest"] },
  reporterStrap: { category: "Straps", kinds: ["reporter", "reporter_location", "correspondent"], words: ["reporter", "correspondent"] },
  headlineStrap: { category: "Straps", kinds: ["headline", "two_line", "two_line_headline", "slug"], words: ["headline", "two line", "two_line"] },
  crawl: { category: "Tickers", kinds: ["crawl"], words: ["crawl", "scroll"] },
  ticker: { category: "Tickers", kinds: ["crawl", "flip", "stacked"], words: ["crawl", "ticker"] },
  breaking: { category: "Tickers", kinds: ["breaking", "breaking_bar", "alert"], words: ["breaking", "alert"] },
  keyPoints: { category: "Boards", kinds: ["key_points", "points", "bullets", "keypoints"], words: ["key points", "key_points", "points", "bullet"] },
  layout: { category: "Layouts", kinds: ["two_way", "split", "two_box", "double"], words: ["two", "split", "2"] },
  wipe: { category: "Stingers", kinds: ["stinger", "panels", "light"], words: ["stinger", "wipe"] },
  logoBug: { category: "Bugs", kinds: ["logo", "logo_bug"], words: ["logo"] },
  liveBug: { category: "Bugs", kinds: ["live_clock", "live", "live_bug"], words: ["live"] },
} satisfies Record<string, Want>;

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();

/** How well a template fits (higher is better; 0 = not at all). */
export function score(t: GfxTemplate, w: Want): number {
  if (w.category && t.category !== w.category) return 0;
  if (w.role && t.role !== w.role) return 0;
  let s = 1;
  const kinds = (w.kinds ?? []).map(norm);
  const k = t.kind ? norm(t.kind) : "";
  const ki = k ? kinds.indexOf(k) : -1;
  if (ki >= 0) s += 100 - ki;
  const hay = `${norm(t.id.split(".").pop() ?? t.id)} ${norm(t.name)}`;
  const words = (w.words ?? []).map(norm);
  const wi = words.findIndex((x) => x && hay.includes(x));
  if (wi >= 0) s += 50 - wi;
  return s;
}

/** The best template for a job (built-ins first in their order on a tie), or undefined. */
export function pickTemplate(list: GfxTemplate[], w: Want): GfxTemplate | undefined {
  let best: GfxTemplate | undefined, bs = 0;
  for (const t of list) { const s = score(t, w); if (s > bs) { best = t; bs = s; } }
  return best;
}

/** The templates a job can use, best first (for the Build dialog's choices). */
export function candidates(list: GfxTemplate[], w: Want): GfxTemplate[] {
  return list.map((t) => [t, score(t, { category: w.category, role: w.role, kinds: w.kinds, words: w.words })] as const)
    .filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([t]) => t);
}
