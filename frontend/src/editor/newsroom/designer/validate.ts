/**
 * Shape checks for looks and templates read from the library or a .tatvamlook / .tatvamgfx file (docs/EDITOR.md
 * §16.8–16.9). A file that isn't one is refused with a plain reason ("The colours are missing: accent"); optional
 * parts a newer or older app may leave out are filled from the defaults. Pure.
 */
import type { ChannelLook, GfxCategory, GfxDesign, GfxField, GfxFieldType, GfxLayer, GfxRatio, GfxRole, GfxTemplate, LookColor } from "../types.ts";

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export const LOOK_COLORS: LookColor[] = ["primary", "secondary", "accent", "dark", "light", "text", "textOnPrimary", "breaking", "live", "up", "down"];
export const CATEGORIES: GfxCategory[] = ["Tickers", "Bugs", "Straps", "Boards", "Layouts", "Stingers", "Openers", "Backgrounds"];
export const ROLES: GfxRole[] = ["background", "layout", "board", "strap", "ticker", "bug", "wipe"];
export const FIELD_TYPES: GfxFieldType[] = ["text", "longtext", "list", "number", "image", "toggle", "choice", "table", "color", "datetime"];
export const RATIOS: GfxRatio[] = ["16:9", "9:16", "1:1", "4:5"];
/** A look's embedded logo (data: URL) is kept small so a look file travels on its own. */
export const MAX_LOGO_BYTES = 256 * 1024;
const MAX_LAYERS = 500, MAX_FIELDS = 200;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isHex = (v: unknown) => isStr(v) && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim());
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => isStr(v) && (list as readonly string[]).includes(v);
const fontRef = (v: unknown) => isObj(v) && isStr(v.family) && !!v.family.trim() && isNum(v.weight);

/** Rough size of a data: URL's contents in bytes. */
export const dataUrlBytes = (u: string) => Math.floor(((u.length - u.indexOf(",") - 1) * 3) / 4);

/** Checks a look (and fills optional parts from `fallback`, a ready look). */
export function checkLook(v: unknown, fallback: ChannelLook): Checked<ChannelLook> {
  if (!isObj(v)) return fail("It isn't a channel look.");
  if (!isStr(v.id) || !v.id.trim()) return fail("The look has no id.");
  if (!isStr(v.name) || !v.name.trim()) return fail("The look has no name.");
  if (!isObj(v.colors)) return fail("The look has no colours.");
  const colors = v.colors;
  const missing = LOOK_COLORS.filter((k) => !isHex(colors[k]));
  if (missing.length) return fail(`Some colours are missing or not colours: ${missing.join(", ")}.`);
  if (!isObj(v.fonts) || !fontRef(v.fonts.headline) || !fontRef(v.fonts.body) || !fontRef(v.fonts.numbers)) return fail("The look's fonts are missing (headline, body and numbers).");
  const out = JSON.parse(JSON.stringify(v)) as ChannelLook & Record<string, unknown>;
  const f = fallback;
  if (!oneOf(out.motion, ["sharp", "smooth", "bouncy"] as const)) out.motion = f.motion;
  if (!oneOf(out.plate, ["flat", "glass", "angled", "rounded"] as const)) out.plate = f.plate;
  if (!isNum(out.radius)) out.radius = f.radius;
  if (typeof out.upper !== "boolean") out.upper = f.upper;
  if (!isObj(out.bug) || !oneOf(out.bug.corner, ["tl", "tr", "bl", "br"] as const) || !isNum(out.bug.scale) || !isNum(out.bug.opacity)) out.bug = { ...f.bug };
  if (!isObj(out.numbers) || !oneOf(out.numbers.system, ["indian", "international"] as const) || !oneOf(out.numbers.digits, ["latin", "native"] as const) || !isStr(out.numbers.currency)) out.numbers = { ...f.numbers };
  if (!isObj(out.clock) || (out.clock.hours !== 12 && out.clock.hours !== 24) || !isStr(out.clock.zone) || !oneOf(out.clock.date, ["dmy", "mdy", "long"] as const)) out.clock = { ...f.clock };
  if (!oneOf(out.separator, ["dot", "diamond", "bar", "logo", "slash"] as const)) out.separator = f.separator;
  if (out.fonts.scripts !== undefined && !isObj(out.fonts.scripts)) delete out.fonts.scripts;
  if (out.logo !== undefined) {
    if (!isObj(out.logo)) delete out.logo;
    else {
      const lg = out.logo as Record<string, unknown>;
      if (lg.image !== undefined) {
        if (!isStr(lg.image) || !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/i.test(lg.image)) return fail("The look's logo isn't an image.");
        if (dataUrlBytes(lg.image) > MAX_LOGO_BYTES) return fail("The look's logo is larger than 256 KB.");
      }
      for (const k of ["mediaId", "text"]) if (lg[k] !== undefined && !isStr(lg[k])) delete lg[k];
    }
  }
  delete out.builtIn;
  return { ok: true, value: out };
}

function checkLayer(l: unknown, where: string): string | null {
  if (!isObj(l)) return `${where}: a layer isn't readable.`;
  if (!isStr(l.id) || !l.id) return `${where}: a layer has no id.`;
  if (!isStr(l.kind) || !l.kind) return `${where}: layer "${l.id}" has no kind.`;
  if (!Array.isArray(l.box) || l.box.length !== 4 || !l.box.every(isNum)) return `${where}: layer "${l.id}" has no position and size.`;
  if (!isObj(l.p)) return `${where}: layer "${l.id}" has no properties.`;
  if (l.opacity !== undefined && !isNum(l.opacity)) return `${where}: layer "${l.id}" has a bad opacity.`;
  if (l.rotation !== undefined && !isNum(l.rotation)) return `${where}: layer "${l.id}" has a bad rotation.`;
  if (l.anim !== undefined && !isObj(l.anim)) return `${where}: layer "${l.id}" has a bad animation.`;
  for (const k of ["when", "clip"]) if (l[k] !== undefined && !isStr(l[k])) return `${where}: layer "${l.id}" has a bad "${k}".`;
  return null;
}

function checkField(f: unknown): string | null {
  if (!isObj(f)) return "A field isn't readable.";
  if (!isStr(f.id) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.id)) return `A field has a bad id (${JSON.stringify(f.id)}).`;
  if (!isStr(f.label)) return `Field "${f.id}" has no label.`;
  if (!oneOf(f.type, FIELD_TYPES)) return `Field "${f.id}" has an unknown type.`;
  if (!("default" in f)) return `Field "${f.id}" has no default value.`;
  return null;
}

/** Checks a template: identity, category and role, timing, fields, and every design's layers. */
export function checkTemplate(v: unknown): Checked<GfxTemplate> {
  if (!isObj(v)) return fail("It isn't a graphic template.");
  if (!isStr(v.id) || !v.id.trim()) return fail("The template has no id.");
  if (!isStr(v.name) || !v.name.trim()) return fail("The template has no name.");
  if (!oneOf(v.category, CATEGORIES)) return fail(`The template's category isn't one of ${CATEGORIES.join(", ")}.`);
  if (!oneOf(v.role, ROLES)) return fail("The template's track role isn't known.");
  if (!isNum(v.seconds) || v.seconds < 0) return fail("The template's length isn't a number of seconds.");
  if (!isObj(v.timing) || !isNum(v.timing.in) || !isNum(v.timing.out)) return fail("The template's in / out timing is missing.");
  if (!Array.isArray(v.fields)) return fail("The template's fields are missing.");
  if (v.fields.length > MAX_FIELDS) return fail(`The template has more than ${MAX_FIELDS} fields.`);
  const ids = new Set<string>();
  for (const f of v.fields) {
    const e = checkField(f);
    if (e) return fail(e);
    const id = (f as GfxField).id;
    if (ids.has(id)) return fail(`Two fields share the id "${id}".`);
    ids.add(id);
  }
  if (!isObj(v.designs)) return fail("The template has no designs.");
  const ratios = Object.keys(v.designs);
  if (!ratios.length) return fail("The template has no designs.");
  for (const r of ratios) {
    if (!oneOf(r, RATIOS)) return fail(`Unknown design ratio "${r}".`);
    const d = v.designs[r];
    if (!isObj(d) || !Array.isArray(d.layers)) return fail(`The ${r} design has no layers.`);
    if (d.layers.length > MAX_LAYERS) return fail(`The ${r} design has more than ${MAX_LAYERS} layers.`);
    const seen = new Set<string>();
    for (const l of d.layers) {
      const e = checkLayer(l, `The ${r} design`);
      if (e) return fail(e);
      const id = (l as GfxLayer).id;
      if (seen.has(id)) return fail(`The ${r} design has two layers called "${id}".`);
      seen.add(id);
    }
    if (d.safe !== undefined && (!Array.isArray(d.safe) || d.safe.length !== 4 || !d.safe.every(isNum))) return fail(`The ${r} design's safe area isn't readable.`);
  }
  if (v.version !== 1) return fail("This template was made by a newer version of Tatvam.");
  const out = JSON.parse(JSON.stringify(v)) as GfxTemplate;
  for (const r of ratios) { const d = out.designs[r as GfxRatio] as GfxDesign; for (const l of d.layers) if (!isStr(l.name)) l.name = l.id; }
  return { ok: true, value: out };
}

/** Parses JSON text and checks it; a reason when it isn't valid JSON. */
export function parseChecked<T>(json: string, check: (v: unknown) => Checked<T>): Checked<T> {
  let v: unknown;
  try { v = JSON.parse(json); } catch { return fail("The file isn't readable (it isn't JSON)."); }
  return check(v);
}
