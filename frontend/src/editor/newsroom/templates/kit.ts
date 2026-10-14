/**
 * Helpers for writing News Room templates as code (docs/EDITOR.md §16.4). A template is plain data (newsroom/types.ts);
 * these only make the built-in ones short and consistent. Pure.
 *
 *   tpl({ id: "nr.straps.anchor", name: "Anchor", category: "Straps", role: "strap", seconds: 6,
 *     fields: [field.text("name", "Name", "Priya Rao"), field.text("role", "Role", "Anchor")],
 *     designs: { "16:9": [rect("plate", [120, 820, 760, 86], { fill: "@primary" }), text("name", [150, 820, 700, 86], "{name}", { size: 52 })],
 *                "9:16": [...] } })
 */
import type {
  AnimStep, Box, GfxCategory, GfxDesign, GfxField, GfxLayer, GfxLayerKind, GfxListItem, GfxRatio, GfxRole, GfxTableRow,
  GfxTemplate, GfxValue, LayerAnim, LoopSpec, NumberFormat,
} from "../types.ts";

/** Design sizes per ratio (pixels). */
export const DESIGN: Record<GfxRatio, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 }, "9:16": { w: 1080, h: 1920 }, "1:1": { w: 1080, h: 1080 }, "4:5": { w: 1080, h: 1350 },
};

type Extra = Partial<Omit<GfxLayer, "id" | "kind" | "box" | "p">>;

export function layer(kind: GfxLayerKind, id: string, box: Box, p: Record<string, unknown> = {}, extra: Extra = {}): GfxLayer {
  return { id, name: extra.name ?? id.replace(/[_-]+/g, " "), kind, box, p, ...extra };
}
export const rect = (id: string, box: Box, p: Record<string, unknown> = {}, extra?: Extra) => layer("rect", id, box, p, extra);
export const text = (id: string, box: Box, value: string, p: Record<string, unknown> = {}, extra?: Extra) => layer("text", id, box, { text: value, ...p }, extra);
export const image = (id: string, box: Box, field: string, p: Record<string, unknown> = {}, extra?: Extra) => layer("image", id, box, { field, ...p }, extra);
export const logo = (id: string, box: Box, p: Record<string, unknown> = {}, extra?: Extra) => layer("logo", id, box, p, extra);
export const line = (id: string, box: Box, p: Record<string, unknown> = {}, extra?: Extra) => layer("line", id, box, p, extra);
export const icon = (id: string, box: Box, name: string, p: Record<string, unknown> = {}, extra?: Extra) => layer("icon", id, box, { icon: name, ...p }, extra);

/** Animation shorthands: in / out steps and loops. */
export const anim = (i?: AnimStep, o?: AnimStep, loop?: LoopSpec): LayerAnim => ({ ...(i ? { in: i } : {}), ...(o ? { out: o } : {}), ...(loop ? { loop } : {}) });
export const step = (kind: AnimStep["kind"], o: Omit<AnimStep, "kind"> = {}): AnimStep => ({ kind, ...o });

export const field = {
  text: (id: string, label: string, def = "", o: Partial<GfxField> = {}): GfxField => ({ id, label, type: "text", default: def, ...o }),
  longtext: (id: string, label: string, def = "", o: Partial<GfxField> = {}): GfxField => ({ id, label, type: "longtext", default: def, ...o }),
  number: (id: string, label: string, def = 0, format?: NumberFormat, o: Partial<GfxField> = {}): GfxField => ({ id, label, type: "number", default: def, ...(format ? { format } : {}), ...o }),
  list: (id: string, label: string, def: GfxListItem[] = [], o: Partial<GfxField> = {}): GfxField => ({ id, label, type: "list", default: def, ...o }),
  table: (id: string, label: string, columns: NonNullable<GfxField["columns"]>, def: GfxTableRow[] = [], o: Partial<GfxField> = {}): GfxField => ({ id, label, type: "table", columns, default: def, ...o }),
  image: (id: string, label: string, o: Partial<GfxField> = {}): GfxField => ({ id, label, type: "image", default: null, ...o }),
  toggle: (id: string, label: string, def = false, o: Partial<GfxField> = {}): GfxField => ({ id, label, type: "toggle", default: def, ...o }),
  choice: (id: string, label: string, options: { value: string; label: string }[], def?: string, o: Partial<GfxField> = {}): GfxField =>
    ({ id, label, type: "choice", options, default: def ?? options[0]?.value ?? "", ...o }),
  color: (id: string, label: string, def = "@primary", o: Partial<GfxField> = {}): GfxField => ({ id, label, type: "color", default: def, ...o }),
  datetime: (id: string, label: string, def = "", o: Partial<GfxField> = {}): GfxField => ({ id, label, type: "datetime", default: def, ...o }),
};

/** Ticker items from plain lines. */
export const items = (...lines: string[]): GfxListItem[] => lines.map((text) => ({ text }));

export interface TplInput {
  id: string; name: string; category: GfxCategory; role: GfxRole; kind?: string; description?: string; tags?: string[];
  seconds: number; timing?: { in: number; out: number }; fields: GfxField[];
  /** Layers per ratio (16:9 and 9:16 for every built-in). */
  designs: Partial<Record<GfxRatio, GfxLayer[] | GfxDesign>>;
  hold?: GfxTemplate["hold"]; loop?: boolean; cut?: number; sounds?: GfxTemplate["sounds"];
}

export function tpl(t: TplInput): GfxTemplate {
  const designs: GfxTemplate["designs"] = {};
  for (const [r, d] of Object.entries(t.designs) as [GfxRatio, GfxLayer[] | GfxDesign][]) designs[r] = Array.isArray(d) ? { layers: d } : d;
  return {
    id: t.id, name: t.name, category: t.category, role: t.role, ...(t.kind ? { kind: t.kind } : {}),
    ...(t.description ? { description: t.description } : {}), ...(t.tags ? { tags: t.tags } : {}),
    seconds: t.seconds, timing: t.timing ?? { in: 0.6, out: 0.4 }, fields: t.fields, designs,
    ...(t.hold ? { hold: t.hold } : {}), ...(t.loop ? { loop: true } : {}), ...(t.cut !== undefined ? { cut: t.cut } : {}),
    ...(t.sounds ? { sounds: t.sounds } : {}), source: "builtin", version: 1,
  };
}

/** Default values of a template's fields. */
export const defaults = (t: GfxTemplate): Record<string, GfxValue> => Object.fromEntries(t.fields.map((f) => [f.id, f.default]));
