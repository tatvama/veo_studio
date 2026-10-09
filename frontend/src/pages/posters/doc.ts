/** Pure operations on design documents: making layers, resizing a whole design, aligning, ordering. No React here. */
import { SCRIPT_FALLBACK, scriptOf } from "./fonts";
import type {
  AiKind, DesignDoc, DropPayload, EffectKind, EffectLayer, ImageLayer, Layer, Paint, Role, ShapeKind, ShapeLayer, TextLayer, TextPresetKey,
} from "./types";

export const uid = (p = "l") => `${p}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

export const emptyDoc = (color = "#0b0f17"): DesignDoc => ({ v: 1, background: { color, gradient: null }, layers: [] });

const base = (type: Layer["type"], name: string, x: number, y: number, width: number, height: number) => ({
  id: uid(type[0]), type, name, x, y, width, height, rotation: 0, opacity: 1, visible: true, locked: false, shadow: null,
});

// ── text ─────────────────────────────────────────────────

interface TextPreset { name: string; text: string; role: Role; size: number; family: string; weight: number; spacing: number;
  lineHeight: number; uppercase?: boolean; fill?: Paint; align?: TextLayer["align"]; widthFrac: number; italic?: boolean }

/** Sizes are a fraction of the design's shorter side, so presets look right on any format. */
export const TEXT_PRESETS: Record<TextPresetKey, TextPreset> = {
  title: { name: "Title", text: "THE LAST LIGHT", role: "title", size: 0.13, family: "Anton", weight: 400, spacing: 2, lineHeight: 0.95, uppercase: true, widthFrac: 0.84 },
  subtitle: { name: "Subtitle", text: "A Tatvam Original", role: "tagline", size: 0.045, family: "Montserrat Variable", weight: 600, spacing: 6, lineHeight: 1.2, uppercase: true, widthFrac: 0.7 },
  tagline: { name: "Tagline", text: "Some lights refuse to go out.", role: "tagline", size: 0.045, family: "Playfair Display Variable", weight: 500, spacing: 0, lineHeight: 1.25, widthFrac: 0.75, italic: true },
  body: { name: "Body text", text: "Add a few lines of detail here.", role: "body", size: 0.03, family: "Inter Variable", weight: 400, spacing: 0, lineHeight: 1.45, widthFrac: 0.6, align: "left" },
  credits: { name: "Credits block", text: "TATVAM STUDIOS PRESENTS  A FILM BY ASHA RAO  WRITTEN BY RAVI KUMAR  MUSIC BY MEERA IYER  CINEMATOGRAPHY BY ARJUN NAIR  EDITED BY SARA KHAN  PRODUCED BY TATVAM AI STUDIO",
    role: "credits", size: 0.016, family: "Oswald Variable", weight: 300, spacing: 1.5, lineHeight: 1.35, uppercase: true, widthFrac: 0.82, fill: "#d4d4d8" },
  badge: { name: "Badge", text: "IN CINEMAS 14 NOV", role: "badge", size: 0.03, family: "Bebas Neue", weight: 400, spacing: 3, lineHeight: 1, uppercase: true, widthFrac: 0.42 },
  cta: { name: "Button text", text: "WATCH NOW", role: "cta", size: 0.034, family: "Montserrat Variable", weight: 800, spacing: 2, lineHeight: 1, uppercase: true, widthFrac: 0.36 },
  quote: { name: "Quote", text: "“The flame remembers every prayer.”", role: "body", size: 0.05, family: "DM Serif Display", weight: 400, spacing: 0, lineHeight: 1.2, widthFrac: 0.8 },
  devanagari: { name: "Hindi title", text: "आख़िरी रोशनी", role: "title", size: 0.1, family: "Yatra One", weight: 400, spacing: 0, lineHeight: 1.25, widthFrac: 0.84 },
  kannada: { name: "Kannada title", text: "ಕೊನೆಯ ಬೆಳಕು", role: "title", size: 0.085, family: "Anek Kannada Variable", weight: 800, spacing: 0, lineHeight: 1.3, widthFrac: 0.84 },
  telugu: { name: "Telugu title", text: "చివరి వెలుగు", role: "title", size: 0.085, family: "Anek Telugu Variable", weight: 800, spacing: 0, lineHeight: 1.35, widthFrac: 0.84 },
  tamil: { name: "Tamil title", text: "கடைசி ஒளி", role: "title", size: 0.08, family: "Anek Tamil Variable", weight: 800, spacing: 0, lineHeight: 1.35, widthFrac: 0.84 },
};

export function newText(preset: TextPresetKey, W: number, H: number, over: Partial<TextLayer> = {}): TextLayer {
  const p = TEXT_PRESETS[preset];
  const short = Math.min(W, H);
  const fontSize = Math.round(p.size * short);
  const width = Math.round(W * p.widthFrac);
  const lines = Math.max(1, Math.ceil((p.text.length * fontSize * 0.55) / width));
  const height = Math.round(fontSize * p.lineHeight * Math.min(lines, 6) + fontSize * 0.2);
  const t: TextLayer = {
    ...base("text", p.name, Math.round((W - width) / 2), Math.round((H - height) / 2), width, height),
    type: "text", text: p.text, fontFamily: p.family, fontSize, fontWeight: p.weight, fontStyle: p.italic ? "italic" : "normal",
    fill: p.fill ?? "#ffffff", align: p.align ?? "center", verticalAlign: "middle", lineHeight: p.lineHeight, letterSpacing: p.spacing,
    uppercase: p.uppercase, stroke: null, background: null, role: p.role, autoFit: preset === "title",
    ...over,
  };
  if (preset === "badge") t.background = { color: "#e11d48", padding: Math.round(fontSize * 0.45), radius: Math.round(fontSize * 0.2) };
  if (preset === "cta") t.background = { color: "#22d3ee", padding: Math.round(fontSize * 0.6), radius: Math.round(fontSize * 0.5) };
  if (preset === "cta") t.fill = "#05070b";
  if (preset === "title") t.shadow = { color: "#000000", blur: Math.round(fontSize * 0.25), x: 0, y: Math.round(fontSize * 0.04), opacity: 0.55 };
  return t;
}

/** If the text is in an Indian script the font can't draw, switch to a family that can. */
export function fixFontForText(layer: TextLayer): TextLayer {
  const script = scriptOf(layer.text);
  if (script === "latin") return layer;
  const ok = (layer.fontFamily.includes("Anek") && layer.fontFamily.toLowerCase().includes(script))
    || (script === "devanagari" && /Yatra|Rozha|Baloo|Poppins|Teko|Anek Devanagari/.test(layer.fontFamily));
  return ok ? layer : { ...layer, fontFamily: SCRIPT_FALLBACK[script] };
}

// ── images ───────────────────────────────────────────────

/** An image layer sized to fit within ~60% of the design (or covering it, for backgrounds), centred on `at`. */
export function newImage(src: string, nw: number, nh: number, W: number, H: number,
  opt: { asset?: string; role?: Role; name?: string; at?: { x: number; y: number }; cover?: boolean } = {}): ImageLayer {
  const role = opt.role ?? "photo";
  const cover = opt.cover ?? role === "background";
  let width: number, height: number;
  if (cover) {
    width = W; height = H;
  } else {
    const s = Math.min((W * 0.6) / nw, (H * 0.6) / nh, 1.5);
    width = Math.round(nw * s); height = Math.round(nh * s);
  }
  const cx = opt.at?.x ?? W / 2, cy = opt.at?.y ?? H / 2;
  return {
    ...base("image", opt.name ?? (role === "background" ? "Background" : role === "character" ? "Character" : "Image"),
      cover ? 0 : Math.round(cx - width / 2), cover ? 0 : Math.round(cy - height / 2), width, height),
    type: "image", src, asset: opt.asset, naturalWidth: nw, naturalHeight: nh, fit: cover ? "cover" : "fill", role,
    focusX: 0.5, focusY: 0.5, cornerRadius: 0, mask: "none", stroke: null, filters: {}, ai: null, alternatives: [], pending: null,
  };
}

/** Placeholder for an AI image that is still being painted: the editor shows a shimmer until the job lands. */
export function newPendingImage(kind: AiKind, rect: { x: number; y: number; width: number; height: number }, role: Role, name: string): ImageLayer {
  return {
    ...base("image", name, rect.x, rect.y, rect.width, rect.height),
    type: "image", src: "", fit: role === "background" ? "cover" : "contain", role, focusX: 0.5, focusY: 0.5, cornerRadius: 0,
    mask: "none", stroke: null, filters: {}, ai: null, alternatives: [], pending: { jobIds: [], kind },
  };
}

// ── shapes & effects ─────────────────────────────────────

export function newShape(shape: ShapeKind, W: number, H: number, over: Partial<ShapeLayer> = {}): ShapeLayer {
  const s = Math.round(Math.min(W, H) * 0.3);
  const wide = shape === "line" || shape === "arrow";
  const width = wide ? Math.round(W * 0.5) : s, height = wide ? Math.max(8, Math.round(s * 0.04)) : s;
  return {
    ...base("shape", shape[0].toUpperCase() + shape.slice(1), Math.round((W - width) / 2), Math.round((H - height) / 2), width, height),
    type: "shape", shape, fill: wide ? "#ffffff" : "#22d3ee", stroke: null, cornerRadius: shape === "rect" ? Math.round(s * 0.06) : 0,
    sides: 6, points: shape === "burst" ? 16 : 5, innerRatio: shape === "ring" ? 0.78 : shape === "burst" ? 0.82 : 0.45, role: "decor",
    ...over,
  };
}

export function newEffect(effect: EffectKind, W: number, H: number, over: Partial<EffectLayer> = {}): EffectLayer {
  const defaults: Record<EffectKind, { color: string; intensity: number; angle?: number; name: string; blend?: Layer["blend"] }> = {
    vignette: { color: "#000000", intensity: 0.65, name: "Vignette" },
    fade: { color: "#05070b", intensity: 0.9, angle: 90, name: "Fade to colour" },
    grain: { color: "#ffffff", intensity: 0.18, name: "Film grain", blend: "overlay" },
    "light-leak": { color: "#ff8a3d", intensity: 0.55, angle: 315, name: "Light leak", blend: "screen" },
    glow: { color: "#22d3ee", intensity: 0.5, name: "Glow", blend: "screen" },
    scanlines: { color: "#000000", intensity: 0.25, name: "Scanlines", blend: "multiply" },
    frame: { color: "#ffffff", intensity: 0.5, name: "Frame" },
  };
  const d = defaults[effect];
  return {
    ...base("effect", d.name, 0, 0, W, H), type: "effect", effect, color: d.color, intensity: d.intensity, angle: d.angle,
    role: "effect", blend: d.blend ?? "normal", locked: effect !== "frame" && effect !== "glow", ...over,
  };
}

/** Turn something dropped from a panel into layers, centred where it was dropped. */
export function layersFromDrop(p: DropPayload, W: number, H: number, at?: { x: number; y: number }): Layer[] {
  const centre = (l: Layer): Layer => (at && !(l.type === "image" && l.role === "background") && l.type !== "effect"
    ? { ...l, x: Math.round(at.x - l.width / 2), y: Math.round(at.y - l.height / 2) } : l);
  switch (p.kind) {
    case "image":
      return [newImage(p.src, p.width, p.height, W, H, { asset: p.asset, role: p.role, name: p.name, at })];
    case "text": {
      let t = newText(p.preset, W, H, { ...(p.text ? { text: p.text } : {}), ...(p.fontFamily ? { fontFamily: p.fontFamily } : {}) });
      t = fixFontForText(t);
      return [centre(t)];
    }
    case "shape":
      return [centre(newShape(p.shape, W, H, { ...(p.fill !== undefined ? { fill: p.fill } : {}), ...(p.stroke ? { stroke: p.stroke } : {}),
        ...(p.name ? { name: p.name } : {}) }))];
    case "effect":
      return [newEffect(p.effect, W, H, { ...(p.color ? { color: p.color } : {}), ...(p.intensity != null ? { intensity: p.intensity } : {}) })];
    case "layers":
      return p.layers.map((l) => ({ ...structuredClone(l), id: uid(l.type[0]) }));
  }
}

// ── geometry ─────────────────────────────────────────────

export interface Box { x: number; y: number; width: number; height: number }

/** Axis-aligned bounds of a (possibly rotated) layer. */
export function boundsOf(l: Pick<Layer, "x" | "y" | "width" | "height" | "rotation">): Box {
  if (!l.rotation) return { x: l.x, y: l.y, width: l.width, height: l.height };
  const r = (l.rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const pts = [[0, 0], [l.width, 0], [l.width, l.height], [0, l.height]].map(([px, py]) => [l.x + px * c - py * s, l.y + px * s + py * c]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Align layers to each other (2+ selected) or to the page (1 selected). Moves by the rotated bounds. */
export function align(layers: Layer[], mode: AlignMode, page: Box): Map<string, { x: number; y: number }> {
  const target = layers.length > 1 ? unionBox(layers.map(boundsOf))! : page;
  const out = new Map<string, { x: number; y: number }>();
  for (const l of layers) {
    const b = boundsOf(l);
    let dx = 0, dy = 0;
    if (mode === "left") dx = target.x - b.x;
    if (mode === "hcenter") dx = target.x + target.width / 2 - (b.x + b.width / 2);
    if (mode === "right") dx = target.x + target.width - (b.x + b.width);
    if (mode === "top") dy = target.y - b.y;
    if (mode === "vcenter") dy = target.y + target.height / 2 - (b.y + b.height / 2);
    if (mode === "bottom") dy = target.y + target.height - (b.y + b.height);
    out.set(l.id, { x: Math.round(l.x + dx), y: Math.round(l.y + dy) });
  }
  return out;
}

/** Spread 3+ layers evenly (equal gaps) across their own span. */
export function distribute(layers: Layer[], axis: "h" | "v"): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (layers.length < 3) return out;
  const items = layers.map((l) => ({ l, b: boundsOf(l) })).sort((a, b) => (axis === "h" ? a.b.x - b.b.x : a.b.y - b.b.y));
  const first = items[0].b, last = items[items.length - 1].b;
  const span = axis === "h" ? last.x + last.width - first.x : last.y + last.height - first.y;
  const total = items.reduce((s, i) => s + (axis === "h" ? i.b.width : i.b.height), 0);
  const gap = (span - total) / (items.length - 1);
  let cur = axis === "h" ? first.x : first.y;
  for (const { l, b } of items) {
    const d = cur - (axis === "h" ? b.x : b.y);
    out.set(l.id, axis === "h" ? { x: Math.round(l.x + d), y: l.y } : { x: l.x, y: Math.round(l.y + d) });
    cur += (axis === "h" ? b.width : b.height) + gap;
  }
  return out;
}

// ── order ────────────────────────────────────────────────

export function moveLayers(layers: Layer[], ids: string[], to: "front" | "back" | "forward" | "backward"): Layer[] {
  const set = new Set(ids);
  const picked = layers.filter((l) => set.has(l.id));
  const rest = layers.filter((l) => !set.has(l.id));
  if (to === "front") return [...rest, ...picked];
  if (to === "back") return [...picked, ...rest];
  const arr = [...layers];
  const idx = arr.map((l, i) => (set.has(l.id) ? i : -1)).filter((i) => i >= 0);
  if (to === "forward") {
    for (const i of idx.reverse()) if (i < arr.length - 1 && !set.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
  } else {
    for (const i of idx) if (i > 0 && !set.has(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
  }
  return arr;
}

// ── smart resize ─────────────────────────────────────────

const covers = (l: Layer, W: number, H: number) => l.width >= W * 0.9 && l.height >= H * 0.9 && l.x <= W * 0.05 && l.y <= H * 0.05;

/**
 * Re-lay a design for a new size ("one design, every format"). Full-bleed layers (backgrounds, effects) stretch to the
 * new page; everything else keeps its relative position and scales by the smaller ratio so nothing distorts.
 */
export function smartResize(doc: DesignDoc, fromW: number, fromH: number, toW: number, toH: number): DesignDoc {
  const sx = toW / fromW, sy = toH / fromH, s = Math.min(sx, sy);
  const layers = doc.layers.map((l): Layer => {
    if (l.type === "effect" || covers(l, fromW, fromH)) {
      return { ...l, x: Math.round(l.x * sx), y: Math.round(l.y * sy), width: Math.round(l.width * sx), height: Math.round(l.height * sy) };
    }
    const cx = (l.x + l.width / 2) / fromW, cy = (l.y + l.height / 2) / fromH;
    const w = Math.round(l.width * s), h = Math.round(l.height * s);
    let width = w, height = h;
    // wide text blocks keep using the page width they had (titles shouldn't shrink to a column on a wide banner)
    if (l.type === "text") width = Math.min(Math.round(toW * (l.width / fromW)), Math.round(l.width * Math.max(sx, s)));
    const moved: Layer = { ...l, x: Math.round(cx * toW - width / 2), y: Math.round(cy * toH - height / 2), width, height };
    if (moved.type === "text") {
      moved.fontSize = Math.max(6, Math.round(moved.fontSize * s));
      moved.letterSpacing = +(moved.letterSpacing * s).toFixed(2);
      if (moved.background) moved.background = { ...moved.background, padding: Math.round(moved.background.padding * s), radius: Math.round(moved.background.radius * s) };
      if (moved.stroke) moved.stroke = { ...moved.stroke, width: +(moved.stroke.width * s).toFixed(2) };
    }
    if (moved.shadow) moved.shadow = { ...moved.shadow, blur: Math.round(moved.shadow.blur * s), x: Math.round(moved.shadow.x * s), y: Math.round(moved.shadow.y * s) };
    return moved;
  });
  return { ...doc, layers };
}

/** Fit an image into its box: new natural size from an AI result or a swap, keeping the layer's footprint sensible. */
export function refitImage(l: ImageLayer, nw: number, nh: number): ImageLayer {
  if (l.role === "background" || l.fit === "cover") return { ...l, naturalWidth: nw, naturalHeight: nh };
  // cut-outs and photos: keep the box height and bottom edge, adopt the new aspect (feet stay on the ground)
  const width = Math.round(l.height * (nw / nh));
  return { ...l, naturalWidth: nw, naturalHeight: nh, width, x: Math.round(l.x + (l.width - width) / 2), fit: "fill" };
}

export const isText = (l: Layer): l is TextLayer => l.type === "text";
export const isImage = (l: Layer): l is ImageLayer => l.type === "image";
export const isShape = (l: Layer): l is ShapeLayer => l.type === "shape";
export const isEffect = (l: Layer): l is EffectLayer => l.type === "effect";

/** Text as drawn (upper-cased when the layer says so). */
export const displayText = (l: TextLayer) => (l.uppercase ? l.text.toLocaleUpperCase() : l.text);

/** A copy of layers with fresh ids, nudged so a paste or duplicate is visible. */
export function cloneLayers(layers: Layer[], offset = 24): Layer[] {
  return layers.map((l) => ({ ...structuredClone(l), id: uid(l.type[0]), x: l.x + offset, y: l.y + offset, name: `${l.name} copy`, pending: null } as Layer));
}
