/**
 * Preview items for each kind of thing the panels show (preview-polish): moods, look packs, LUTs, video effects,
 * transitions, title templates, stickers, caption styles and template sequences, plus the category colours of their
 * dots. Each item is made once per definition (and intensity) and reused, so cards keep their pictures.
 */
import { moodEffects, type MoodDef } from "../../lib/moods";
import type { EffectDef } from "../effects";
import { lookEffects, type LookDef } from "../moods/packs/looks";
import type { TitleSpec } from "../model/types";
import { formatById } from "../templates/formats";
import type { SeqTemplate } from "../templates/sequences";
import type { TitleTemplate } from "../templates/titles";
import { hash32 } from "./samples";
import { cardParams } from "./scrub";
import type { PreviewItem } from "./service";

const memo = new Map<string, PreviewItem>();
function once<T extends PreviewItem>(key: string, make: () => T): T {
  let it = memo.get(key) as T | undefined;
  if (!it) { it = make(); memo.set(key, it); if (memo.size > 3000) memo.delete(memo.keys().next().value as string); }
  return it;
}

/** Effect instances (a clip's, with ids and `{ value }` params) as a chain (the ids dropped, so versions are stable). */
export const asChain = (fx: { type: string; params?: Record<string, unknown>; enabled?: boolean }[]) => fx.map((e) => ({ type: e.type, params: e.params, enabled: e.enabled }));

/** Any chain of effects at an intensity k (the card's still), scrubbing 0 … kMax. */
export const chainItem = (id: string, text: string, effects: (k: number) => { type: string; params?: Record<string, unknown>; enabled?: boolean }[], k = 1, kMax = 1.5): PreviewItem =>
  once(`chain:${id}@${k}`, () => ({ kind: "chain", id, text, k, kMax, effects: (kk) => asChain(effects(kk)) }));

/** A mood at the panel's intensity (the card's still) — scrubbing goes 0 … 150 %. */
export const moodItem = (m: MoodDef, k = 1): PreviewItem => once(`mood:${m.id}@${k}`, () => ({
  kind: "chain", id: `mood.${m.id}`, text: `${m.label} ${m.blurb}`, k, kMax: 1.5, effects: (kk) => moodEffects(m, kk),
}));

/** A look of a look pack at the panel's intensity. */
export const lookItem = (l: LookDef, k = 1): PreviewItem => once(`look:${l.id}@${k}`, () => ({
  kind: "chain", id: `look.${l.id}`, text: `${l.label} ${l.blurb} ${l.pack}`, k, kMax: 1.5, effects: (kk) => lookEffects(l, kk),
}));

/** A LUT or preset look at a strength (0..1). */
export const lutItem = (id: string, label: string, strength = 1): PreviewItem => once(`lut:${id}@${strength}`, () => ({
  kind: "chain", id: `lut.${id}`, text: label, k: strength, kMax: 1, effects: (kk) => (kk <= 1e-3 ? [] : [{ type: "look", params: { look: id, lut_strength: Math.min(1, kk) } }]),
}));

/** A video effect at slightly exaggerated parameters (its strength scrubs 0 … 150 %). */
export const effectItem = (d: EffectDef): PreviewItem => once(`fx:${d.id}`, () => {
  const defaults = Object.fromEntries(d.params.map((p) => [p.name, p.default]));
  return {
    kind: "chain", id: `fx.${d.id}`, text: `${d.label} ${d.group}`, k: 1, kMax: 1.5,
    effects: (kk) => [{ type: d.id, params: { ...defaults, ...cardParams(d.params, kk) } }],
  };
});

export const transitionItem = (id: string): PreviewItem => once(`tr:${id}`, () => ({ kind: "transition", id }));

/** A title template's spec (at 1080 lines) for its card. */
export const titleItem = (t: TitleTemplate, spec: TitleSpec): PreviewItem => once(`title:${t.id}:${JSON.stringify(spec)}`, () => ({
  kind: "title", id: `title.${t.id}`, text: `${t.category} ${t.name}`, spec, seconds: t.seconds,
}));

/** Any title spec (stickers, caption styles) as a card. */
export const specItem = (id: string, spec: TitleSpec, seconds: number, text = ""): PreviewItem => once(`spec:${id}:${JSON.stringify(spec)}:${seconds}`, () => ({
  kind: "title", id, text, spec, seconds,
}));

/** A template sequence (its format's aspect). */
export const sequenceItem = (t: SeqTemplate, fields?: Record<string, string>): PreviewItem => once(`seq:${t.id}:${JSON.stringify(fields ?? {})}`, () => {
  const f = t.format ? formatById(t.format) : undefined;
  const aspect = f ? f.w / f.h : 16 / 9;
  return { kind: "sequence", id: `seq.${t.id}`, text: `${t.group} ${t.name} ${t.blurb}`, tpl: t, fields, aspect };
});

// ── category colours ────────────────────────────────────────────────────────────────────────────────────

/** Theme tokens for category dots (they follow dark and light). */
const PALETTE = ["var(--color-accent)", "var(--color-ai)", "var(--color-ok)", "var(--color-warn)", "var(--color-info)", "var(--color-bad)", "var(--color-accent-2)", "var(--color-money)"];
/** A stable colour per category name: by its place in `order` when given (neighbours differ), else by its name. */
export const categoryColor = (name: string, order?: readonly string[]): string => {
  const i = order ? order.indexOf(name) : -1;
  return PALETTE[(i >= 0 ? i : hash32(name.toLowerCase())) % PALETTE.length];
};
