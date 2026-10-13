/**
 * The Template Designer's edits on a working copy of a template (docs/EDITOR.md §16.8): layers (add, delete,
 * duplicate, reorder, rename, hide, lock, properties per ratio or in both), fields (add, rename with their {tokens},
 * reorder, remove), "Change only this one" overrides, and the Designer's own undo history. Every function returns a
 * new template and leaves its input alone. A layer with the same id in each ratio's design is "the same layer":
 * structure changes apply to every design; positions belong to one design. Pure.
 */
import { DESIGN } from "../templates/kit.ts";
import type { Box, GfxDesign, GfxField, GfxFieldType, GfxLayer, GfxRatio, GfxTemplate, GfxValue } from "../types.ts";
import { safeBox } from "./geometry.ts";

export const RATIO_ORDER: GfxRatio[] = ["16:9", "9:16", "1:1", "4:5"];
export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** The ratios a template has a design for, in the usual order. */
export const ratiosOf = (t: GfxTemplate): GfxRatio[] => RATIO_ORDER.filter((r) => !!t.designs[r]);
export const layerOf = (t: GfxTemplate, ratio: GfxRatio, id: string): GfxLayer | undefined => t.designs[ratio]?.layers.find((l) => l.id === id);
/** Every layer id of the template (any design), in the first design's order. */
export function layerIds(t: GfxTemplate): string[] {
  const out: string[] = [];
  for (const r of ratiosOf(t)) for (const l of t.designs[r]!.layers) if (!out.includes(l.id)) out.push(l.id);
  return out;
}

function edit(t: GfxTemplate, fn: (n: GfxTemplate) => void): GfxTemplate {
  const n = clone(t);
  fn(n);
  return n;
}
const designs = (t: GfxTemplate) => ratiosOf(t).map((r) => [r, t.designs[r]!] as const);

/** Sizes are about 1.15× in a 9:16 design (on a 1080-wide frame) compared with 16:9 at 1080 lines. */
export const scaleOf = (r: GfxRatio) => (r === "9:16" ? 1.15 : 1);

/** A new layer id like "text_3", unique across every design. */
export function newLayerId(t: GfxTemplate, base: string): string {
  const taken = new Set(layerIds(t));
  const stem = base.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "layer";
  for (let i = 1; ; i++) { const id = `${stem}_${i}`; if (!taken.has(id)) return id; }
}

/** A sensible starting size for a new layer of a kind (16:9 design px; 9:16 is scaled and kept inside the safe area). */
const START: Record<string, [number, number]> = {
  text: [760, 84], rect: [760, 110], image: [280, 280], logo: [220, 110], line: [600, 6], icon: [84, 84],
  ticker: [1728, 64], clock: [220, 64], number: [520, 200], list: [760, 420], bars: [760, 420], table: [900, 480], pins: [900, 600],
  slot: [960, 540], shine: [760, 110], panels: [1920, 1080], bg: [1920, 1080],
};
function startBox(kind: string, ratio: GfxRatio, design: GfxDesign): Box {
  const { w: W, h: H } = DESIGN[ratio];
  const s = safeBox(ratio, design);
  let [w, h] = START[kind] ?? [600, 200];
  if (w >= 1900 && h >= 1000) return [0, 0, W, H]; // full-frame kinds
  w *= scaleOf(ratio); h *= scaleOf(ratio);
  w = Math.min(w, s[2]); h = Math.min(h, s[3]);
  return [Math.round(s[0] + (s[2] - w) / 2), Math.round(s[1] + (s[3] - h) / 2), Math.round(w), Math.round(h)];
}

/** Adds a layer of a kind to every design (above `above`, else on top); returns the template and the new id. */
export function addLayer(t: GfxTemplate, kind: string, p: Record<string, unknown>, o: { name?: string; above?: string; box?: Partial<Record<GfxRatio, Box>> } = {}): { t: GfxTemplate; id: string } {
  const id = newLayerId(t, kind);
  const n = edit(t, (n) => {
    if (!ratiosOf(n).length) n.designs["16:9"] = { layers: [] };
    for (const [r, d] of designs(n)) {
      const l: GfxLayer = { id, name: o.name ?? id.replace(/_/g, " "), kind, box: o.box?.[r] ?? startBox(kind, r, d), p: clone(p) };
      const at = o.above ? d.layers.findIndex((x) => x.id === o.above) : -1;
      if (at >= 0) d.layers.splice(at + 1, 0, l); else d.layers.push(l);
    }
  });
  return { t: n, id };
}

export function removeLayer(t: GfxTemplate, id: string): GfxTemplate {
  return edit(t, (n) => {
    for (const [, d] of designs(n)) {
      d.layers = d.layers.filter((l) => l.id !== id);
      for (const l of d.layers) if (l.clip === id) delete l.clip;
    }
  });
}

/** A copy of a layer just above it in every design (nudged a little so it shows); returns the new id. */
export function duplicateLayer(t: GfxTemplate, id: string): { t: GfxTemplate; id: string } {
  const src = ratiosOf(t).map((r) => layerOf(t, r, id)).find(Boolean);
  const nid = newLayerId(t, src?.id.replace(/_\d+$/, "") ?? "layer");
  const n = edit(t, (n) => {
    for (const [, d] of designs(n)) {
      const i = d.layers.findIndex((l) => l.id === id);
      if (i < 0) continue;
      const c = clone(d.layers[i]);
      c.id = nid; c.name = `${d.layers[i].name} copy`;
      c.box = [c.box[0] + 20, c.box[1] + 20, c.box[2], c.box[3]];
      d.layers.splice(i + 1, 0, c);
    }
  });
  return { t: n, id: nid };
}

/**
 * Moves a layer to `toIndex` in one design's order (0 = bottom), and to the matching place in the other designs (just
 * above the same layer it now sits above, or at the bottom).
 */
export function moveLayer(t: GfxTemplate, ratio: GfxRatio, id: string, toIndex: number): GfxTemplate {
  return edit(t, (n) => {
    const d = n.designs[ratio];
    if (!d) return;
    const i = d.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const [l] = d.layers.splice(i, 1);
    const to = Math.max(0, Math.min(d.layers.length, toIndex));
    d.layers.splice(to, 0, l);
    const below = to > 0 ? d.layers[to - 1].id : null;
    for (const [r, o] of designs(n)) {
      if (r === ratio) continue;
      const j = o.layers.findIndex((x) => x.id === id);
      if (j < 0) continue;
      const [m] = o.layers.splice(j, 1);
      const k = below ? o.layers.findIndex((x) => x.id === below) : -1;
      o.layers.splice(below && k >= 0 ? k + 1 : below ? o.layers.length : 0, 0, m);
    }
  });
}

/** Changes a layer in one design or in all of them. */
export function updateLayer(t: GfxTemplate, ratio: GfxRatio | "all", id: string, fn: (l: GfxLayer, r: GfxRatio) => GfxLayer | void): GfxTemplate {
  return edit(t, (n) => {
    for (const [r, d] of designs(n)) {
      if (ratio !== "all" && r !== ratio) continue;
      const i = d.layers.findIndex((l) => l.id === id);
      if (i < 0) continue;
      const out = fn(d.layers[i], r);
      if (out) d.layers[i] = out;
    }
  });
}

/**
 * Sets one property of a layer's kind (`p[key]`). In both ratios, a number with a unit follows the change in
 * proportion (a size made 10 % bigger in 16:9 is 10 % bigger in 9:16 too); other values are copied.
 */
export function setProp(t: GfxTemplate, ratio: GfxRatio, scope: "this" | "all", id: string, key: string, value: unknown, proportional = false): GfxTemplate {
  const old = layerOf(t, ratio, id)?.p[key];
  return updateLayer(t, scope === "all" ? "all" : ratio, id, (l, r) => {
    let v = value;
    if (r !== ratio && proportional && typeof value === "number" && typeof old === "number" && typeof l.p[key] === "number" && old !== 0) {
      v = Math.round((l.p[key] as number) * (value / old) * 100) / 100;
    }
    if (v === undefined) delete l.p[key]; else l.p[key] = clone(v);
  });
}

/** Sets a common layer property (opacity, rotation, anim, when, clip, pin, shadow, blend, name, hidden, locked). */
export function setCommon<K extends keyof GfxLayer>(t: GfxTemplate, ratio: GfxRatio | "all", id: string, key: K, value: GfxLayer[K] | undefined): GfxTemplate {
  return updateLayer(t, ratio, id, (l) => {
    if (value === undefined) delete l[key]; else l[key] = clone(value) as GfxLayer[K];
  });
}

export const setBox = (t: GfxTemplate, ratio: GfxRatio, id: string, box: Box): GfxTemplate =>
  updateLayer(t, ratio, id, (l) => { l.box = box; });

// ── fields ───────────────────────────────────────────────────────────────────

const DEFAULT_VALUE: Record<GfxFieldType, GfxValue> = {
  text: "", longtext: "", list: [], number: 0, image: null, toggle: false, choice: "", table: [], color: "@primary", datetime: "",
};
export const defaultFor = (type: GfxFieldType): GfxValue => clone(DEFAULT_VALUE[type]);
export const isFieldId = (id: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(id);
/** "Reporter name" → "reporter_name", unique among the template's fields. */
export function fieldIdFrom(t: GfxTemplate, label: string, except?: string): string {
  const stem = label.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().replace(/^(\d)/, "_$1") || "field";
  const taken = new Set(t.fields.map((f) => f.id).filter((x) => x !== except));
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.has(`${stem}_${i}`)) return `${stem}_${i}`;
}

export function addField(t: GfxTemplate, type: GfxFieldType, label = "New field"): { t: GfxTemplate; id: string } {
  const id = fieldIdFrom(t, label);
  const f: GfxField = { id, label, type, default: defaultFor(type) };
  if (type === "choice") { f.options = [{ value: "one", label: "One" }, { value: "two", label: "Two" }]; f.default = "one"; }
  if (type === "table") f.columns = [{ id: "name", label: "Name", type: "text" }, { id: "value", label: "Value", type: "number" }];
  return { t: edit(t, (n) => { n.fields.push(f); }), id };
}

/** The {tokens} in a text. */
export const tokensIn = (s: string): string[] => [...s.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
/** Keys of `p` that name a field outright (an image's field, a list's field…): "field", or ending in "Field". */
const isFieldKey = (k: string) => k === "field" || /Field$/.test(k);

/** How many layers use a field (a {token} in their text, a field property, or their `when`). */
export function fieldUses(t: GfxTemplate, id: string): number {
  const used = new Set<string>();
  for (const [r, d] of designs(t)) for (const l of d.layers) {
    const hit = Object.entries(l.p).some(([k, v]) => typeof v === "string" && (tokensIn(v).includes(id) || (isFieldKey(k) && v === id)))
      || (l.when !== undefined && l.when.replace(/^!/, "").replace(/[{}]/g, "") === id);
    if (hit) used.add(`${r}|${l.id}`);
  }
  return new Set([...used].map((x) => x.split("|")[1])).size;
}

/** Changes a field. A new id is carried into every {token}, field property and `when` that used the old one. */
export function updateField(t: GfxTemplate, id: string, patch: Partial<GfxField>): GfxTemplate {
  const to = patch.id;
  if (to !== undefined && to !== id && (!isFieldId(to) || t.fields.some((f) => f.id === to))) return t;
  return edit(t, (n) => {
    const f = n.fields.find((x) => x.id === id);
    if (!f) return;
    Object.assign(f, clone(patch));
    if (patch.type && patch.type !== t.fields.find((x) => x.id === id)?.type && patch.default === undefined) f.default = defaultFor(patch.type);
    if (!to || to === id) return;
    const re = new RegExp(`\\{${id}\\}`, "g");
    for (const [, d] of designs(n)) for (const l of d.layers) {
      for (const [k, v] of Object.entries(l.p)) {
        if (typeof v !== "string") continue;
        if (isFieldKey(k) && v === id) l.p[k] = to;
        else if (v.includes(`{${id}}`)) l.p[k] = v.replace(re, `{${to}}`);
      }
      if (l.when && l.when.replace(/^!/, "").replace(/[{}]/g, "") === id) l.when = l.when.replace(id, to);
    }
  });
}

export function removeField(t: GfxTemplate, id: string): GfxTemplate {
  return edit(t, (n) => { n.fields = n.fields.filter((f) => f.id !== id); });
}
export function moveField(t: GfxTemplate, from: number, to: number): GfxTemplate {
  return edit(t, (n) => {
    if (from < 0 || from >= n.fields.length) return;
    const [f] = n.fields.splice(from, 1);
    n.fields.splice(Math.max(0, Math.min(n.fields.length, to)), 0, f);
  });
}

// ── "Change only this one" ───────────────────────────────────────────────────

type Ov = Record<string, Partial<GfxLayer>>;
/** Keys a clip can change. `box` and `hidden` usually differ per ratio. */
const OV_KEYS: (keyof GfxLayer)[] = ["name", "box", "rotation", "opacity", "anim", "when", "pin", "shadow", "blend", "clip", "hidden"];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** One layer with an override applied: plain keys replace, `p` merges key by key. */
export function applyOverride(l: GfxLayer, o: Partial<GfxLayer> | undefined): GfxLayer {
  if (!o) return l;
  const { p, ...rest } = o;
  return { ...l, ...clone(rest), p: p ? { ...l.p, ...clone(p) } : l.p };
}
/** The template as one clip sees it: `overrides[id]`, then `overrides["id@ratio"]` for that ratio's design. */
export function withOverrides(t: GfxTemplate, ov: Ov | undefined): GfxTemplate {
  if (!ov || !Object.keys(ov).length) return t;
  return edit(t, (n) => {
    for (const [r, d] of designs(n)) d.layers = d.layers.map((l) => applyOverride(applyOverride(l, ov[l.id]), ov[`${l.id}@${r}`]));
  });
}

/**
 * The overrides that turn `base` into `edited` (layers matched by id in each design). A change that is the same in
 * every ratio goes under the layer id; one that differs (a position, a size made bigger in proportion) goes under
 * "id@ratio". `p` holds only the properties that changed.
 */
export function overridesBetween(base: GfxTemplate, edited: GfxTemplate): Ov {
  const per = new Map<string, Map<GfxRatio, Record<string, unknown>>>();
  for (const r of ratiosOf(base)) {
    const ed = edited.designs[r];
    if (!ed) continue;
    for (const b of base.designs[r]!.layers) {
      const e = ed.layers.find((l) => l.id === b.id);
      if (!e) continue;
      const d: Record<string, unknown> = {};
      // a removed value: hidden → false, when / clip → "" (no condition); others can't be removed by an override
      for (const k of OV_KEYS) if (!same(b[k], e[k])) d[k] = e[k] !== undefined ? clone(e[k]) : k === "hidden" ? false : k === "when" || k === "clip" ? "" : null;
      for (const k of new Set([...Object.keys(b.p), ...Object.keys(e.p)])) if (!same(b.p[k], e.p[k])) d[`p.${k}`] = e.p[k] === undefined ? null : clone(e.p[k]);
      if (!Object.keys(d).length) continue;
      if (!per.has(b.id)) per.set(b.id, new Map());
      per.get(b.id)!.set(r, d);
    }
  }
  const out: Ov = {};
  const put = (key: string, k: string, v: unknown) => {
    if (v === null) return;
    const o = (out[key] ??= {}) as Record<string, unknown>;
    if (k.startsWith("p.")) ((o.p ??= {}) as Record<string, unknown>)[k.slice(2)] = v;
    else o[k] = v;
  };
  for (const [id, byRatio] of per) {
    const rs = ratiosOf(base).filter((r) => edited.designs[r] && base.designs[r]!.layers.some((l) => l.id === id));
    const keys = new Set([...byRatio.values()].flatMap((d) => Object.keys(d)));
    for (const k of keys) {
      const vals = rs.map((r) => (byRatio.get(r)?.[k] === undefined ? undefined : byRatio.get(r)![k]));
      const shared = rs.length > 0 && vals.every((v) => v !== undefined && same(v, vals[0]));
      if (shared) put(id, k, vals[0]);
      else rs.forEach((r, i) => { if (vals[i] !== undefined) put(`${id}@${r}`, k, vals[i]); });
    }
  }
  return out;
}

// ── the Designer's own undo ──────────────────────────────────────────────────

export interface History<T> { past: T[]; present: T; future: T[]; key?: string; at?: number }
export const history = {
  init: <T,>(v: T): History<T> => ({ past: [], present: v, future: [] }),
  /** A new state; repeated changes with the same key within 1.2 s (a drag, a slider) are one undo step. */
  push<T>(h: History<T>, v: T, key?: string, now = Date.now()): History<T> {
    if (v === h.present) return h;
    if (key && h.key === key && h.at !== undefined && now - h.at < 1200) return { ...h, present: v, future: [], at: now };
    return { past: [...h.past.slice(-199), h.present], present: v, future: [], key, at: now };
  },
  undo<T>(h: History<T>): History<T> {
    if (!h.past.length) return h;
    return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
  },
  redo<T>(h: History<T>): History<T> {
    if (!h.future.length) return h;
    return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
  },
};
