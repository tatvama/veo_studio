/**
 * Every built-in News Room template (docs/EDITOR.md §16.4), by category. Each category's file is owned by one builder;
 * this index only gathers them. Pure (data only).
 */
import type { GfxCategory, GfxTemplate } from "../types.ts";
import { BACKGROUNDS } from "./backgrounds.ts";
import { BOARDS } from "./boards.ts";
import { BUGS } from "./bugs.ts";
import { LAYOUTS } from "./layouts.ts";
import { OPENERS } from "./openers.ts";
import { STINGERS } from "./stingers.ts";
import { STRAPS } from "./straps.ts";
import { TICKERS } from "./tickers.ts";

export const GFX_CATEGORIES: GfxCategory[] = ["Tickers", "Bugs", "Straps", "Boards", "Layouts", "Stingers", "Openers", "Backgrounds"];

let all: GfxTemplate[] | null = null;
let byId: Map<string, GfxTemplate> | null = null;
/** Every built-in template (the same order every build). */
export const builtinTemplates = (): GfxTemplate[] =>
  (all ??= [...TICKERS, ...BUGS, ...STRAPS, ...BOARDS, ...LAYOUTS, ...STINGERS, ...OPENERS, ...BACKGROUNDS]);
export const builtinTemplate = (id: string): GfxTemplate | undefined =>
  (byId ??= new Map(builtinTemplates().map((t) => [t.id, t]))).get(id);
export const templatesIn = (c: GfxCategory): GfxTemplate[] => builtinTemplates().filter((t) => t.category === c);
