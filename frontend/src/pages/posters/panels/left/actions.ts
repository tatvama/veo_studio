/**
 * What the left panel does to the document. Everything goes through the editor store, so undo/redo and autosave work.
 * No React here.
 */
import { toast } from "sonner";
import type { BrandKit } from "../../../../lib/types";
import { tr } from "../../../../lib/i18n";
import { fixFontForText, layersFromDrop, newImage, newText, refitImage, unionBox, boundsOf } from "../../doc";
import { FONTS, fontDef, supports, type FontDef } from "../../fonts";
import { useEditor } from "../../store";
import type { BrandInput } from "../../templates";
import type { DesignDoc, DropPayload, ImageLayer, Layer, TextLayer, TextPresetKey } from "../../types";

type ImagePayload = Extract<DropPayload, { kind: "image" }>;

const W = () => useEditor.getState().width;
const H = () => useEditor.getState().height;

/** A single selected image layer that is still an empty frame (template slot) and isn't being painted. */
export function emptySelectedSlot(): ImageLayer | null {
  const st = useEditor.getState();
  if (st.selection.length !== 1) return null;
  const l = st.doc.layers.find((x) => x.id === st.selection[0]);
  return l && l.type === "image" && !l.src && !l.pending ? l : null;
}

/** Put an image into an existing image layer (a slot or a frame), keeping its box sensible. */
export function fillImage(layerId: string, p: { src: string; asset?: string; width: number; height: number }) {
  const st = useEditor.getState();
  const l = st.doc.layers.find((x) => x.id === layerId);
  if (!l || l.type !== "image") return;
  const next = refitImage({ ...l, src: p.src, asset: p.asset, pending: null }, p.width, p.height);
  st.patchLayer(layerId, next);
  st.select([layerId]);
}

/**
 * The click / keyboard path of drag and drop: add the item at the page centre. Clicking a photo while an empty frame is
 * selected fills that frame instead.
 */
export function addPayload(p: DropPayload) {
  const st = useEditor.getState();
  if (p.kind === "image") {
    const slot = emptySelectedSlot();
    if (slot) { fillImage(slot.id, p); return; }
  }
  const layers = layersFromDrop(p, st.width, st.height);
  st.addLayers(layers, p.kind === "image" && p.role === "background" ? { index: 0 } : undefined);
}

/** Use an image as the page background: fills the existing background layer, or adds one under everything. */
export function setAsBackground(p: Omit<ImagePayload, "kind">) {
  const st = useEditor.getState();
  const bg = st.doc.layers.find((l) => l.type === "image" && l.role === "background" && l.width >= st.width * 0.9 && l.height >= st.height * 0.9);
  if (bg) { fillImage(bg.id, p); return; }
  const layer = newImage(p.src, p.width, p.height, st.width, st.height, { asset: p.asset, role: "background", name: p.name ?? "Background", cover: true });
  st.addLayers([layer], { index: 0 });
}

/** Add several images, each a little further down-right of the last, so a batch upload doesn't stack exactly. */
export function addImagesStaggered(items: { src: string; asset?: string; width: number; height: number; name?: string }[]) {
  if (!items.length) return;
  const st = useEditor.getState();
  const step = Math.min(st.width, st.height) * 0.04;
  const start = -((items.length - 1) * step) / 2;
  const layers = items.map((it, i) => newImage(it.src, it.width, it.height, st.width, st.height, {
    asset: it.asset, role: "photo", name: it.name, at: { x: st.width / 2 + start + i * step, y: st.height / 2 + start + i * step },
  }));
  st.addLayers(layers);
}

/** Move a stack of layers so its bounding box is centred on the page (for multi-layer items built at any spot). */
export function centreOnPage(layers: Layer[], pw = W(), ph = H()): Layer[] {
  const box = unionBox(layers.map(boundsOf));
  if (!box) return layers;
  const dx = Math.round(pw / 2 - (box.x + box.width / 2)), dy = Math.round(ph / 2 - (box.y + box.height / 2));
  return layers.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy }));
}

// ── fonts ────────────────────────────────────────────────

/** The closest weight a font really has. */
export function nearestWeight(def: FontDef | undefined, w: number): number {
  if (!def || !def.weights.length) return w;
  return def.weights.reduce((best, x) => (Math.abs(x - w) < Math.abs(best - w) ? x : best), def.weights[0]);
}

/** A bundled family for a brand kit's font name ("Poppins", "Inter", "Playfair Display"…), or undefined if we don't ship it. */
export function mapFont(name: string | undefined | null): string | undefined {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return undefined;
  const hit = FONTS.find((f) => f.label.toLowerCase() === n || f.family.toLowerCase() === n)
    ?? FONTS.find((f) => f.family.toLowerCase().startsWith(n) || n.startsWith(f.label.toLowerCase()));
  return hit?.family;
}

export const selectedText = (): TextLayer[] => {
  const st = useEditor.getState();
  return st.doc.layers.filter((l): l is TextLayer => l.type === "text" && st.selection.includes(l.id));
};

/**
 * Set a font on the selected text layers. Layers in a script the font can't draw keep their font (and we say so).
 * Returns how many layers changed, or null when no text is selected.
 */
export function applyFontToSelection(family: string): number | null {
  const sel = selectedText();
  if (!sel.length) return null;
  const def = fontDef(family);
  const patches: Record<string, Partial<TextLayer>> = {};
  let skipped = 0;
  for (const l of sel) {
    if (!supports(family, l.text)) { skipped++; continue; }
    patches[l.id] = { fontFamily: family, fontWeight: nearestWeight(def, l.fontWeight) };
  }
  const n = Object.keys(patches).length;
  if (n) useEditor.getState().patchLayers(patches);
  if (skipped) toast.warning(tr("{font} can't draw the script of {n} selected text layer(s); they keep their font.", { font: def?.label ?? family, n: skipped }));
  return n;
}

/** Brand fonts on every text layer: the heading font on titles, badges and buttons, the body font on the rest. */
export function applyBrandFonts(heading?: string, body?: string): number {
  let n = 0;
  useEditor.getState().commit((doc) => {
    doc.layers = doc.layers.map((l) => {
      if (l.type !== "text") return l;
      const fam = l.role === "title" || l.role === "badge" || l.role === "cta" ? heading ?? body : body ?? heading;
      if (!fam || fam === l.fontFamily || !supports(fam, l.text)) return l;
      n++;
      return { ...l, fontFamily: fam, fontWeight: nearestWeight(fontDef(fam), l.fontWeight) };
    });
    return doc;
  });
  return n;
}

// ── colours ──────────────────────────────────────────────

/** Fill the selected text and shape layers with a colour, or colour the page when nothing is selected. */
export function applyColour(color: string): "layers" | "page" | "none" {
  const st = useEditor.getState();
  if (!st.selection.length) {
    st.setBackground({ color, gradient: null });
    return "page";
  }
  const patches: Record<string, Partial<Layer>> = {};
  for (const l of st.doc.layers) {
    if (!st.selection.includes(l.id)) continue;
    if (l.type === "text" || l.type === "shape") patches[l.id] = { fill: color } as Partial<Layer>;
  }
  if (!Object.keys(patches).length) return "none";
  st.patchLayers(patches);
  return "layers";
}

// ── templates & brand ────────────────────────────────────

/** The template input for a brand kit (fonts mapped to bundled families, logo with its natural size when known). */
export function brandInput(kit: BrandKit | null | undefined, logoSize: { w: number; h: number } | null): BrandInput | null {
  if (!kit) return null;
  return {
    colors: (kit.colors ?? []).filter(Boolean),
    headingFont: mapFont(kit.fonts?.heading),
    bodyFont: mapFont(kit.fonts?.body),
    logo: kit.logo_url && logoSize ? { src: kit.logo_url, asset: kit.logo_path || undefined, width: logoSize.w, height: logoSize.h } : null,
    tagline: kit.tagline || undefined,
    cta: kit.cta || undefined,
  };
}

/**
 * Finish a freshly built template document before it replaces the current one: fix fonts for Indian scripts, carry
 * over images that filled matching slots (so switching layouts keeps your AI background and hero), keep the brief.
 */
export function finishTemplateDoc(next: DesignDoc, prev: DesignDoc, opts: { carry?: boolean; skipSlots?: string[] } = {}): DesignDoc {
  const skip = new Set(opts.skipSlots ?? []);
  const filled = prev.layers.filter((l): l is ImageLayer => l.type === "image" && !!l.src && !l.pending);
  const used = new Set<string>();
  const pick = (slot: string | undefined, role: string | undefined): ImageLayer | undefined => {
    const bySlot = slot ? filled.find((l) => l.slot === slot && !used.has(l.id)) : undefined;
    if (bySlot) return bySlot;
    if (role === "background") return filled.find((l) => l.role === "background" && !used.has(l.id));
    if (role === "character") return filled.find((l) => l.role === "character" && !used.has(l.id));
    if (role === "product") return filled.find((l) => l.role === "product" && !used.has(l.id));
    return undefined;
  };
  const layers = next.layers.map((l): Layer => {
    if (l.type === "text") return fixFontForText(l);
    if (opts.carry === false || l.type !== "image" || l.src || (l.slot && skip.has(l.slot))) return l;
    const old = pick(l.slot, l.role);
    if (!old) return l;
    used.add(old.id);
    const carried: ImageLayer = { ...l, src: old.src, asset: old.asset, ai: old.ai ?? null, alternatives: old.alternatives ?? [], filters: { ...(l.filters ?? {}), ...(old.filters ?? {}) } };
    return old.naturalWidth && old.naturalHeight ? refitImage(carried, old.naturalWidth, old.naturalHeight) : carried;
  });
  return { ...next, layers, meta: { ...(next.meta ?? {}), ...(prev.meta?.brief ? { brief: prev.meta.brief } : {}) } };
}

/** The text preset that suits a piece of AI copy (titles in an Indian language use that script's title preset). */
export function presetForCopy(kind: string, language: string): TextPresetKey {
  if (kind === "title") {
    return ({ hi: "devanagari", kn: "kannada", te: "telugu", ta: "tamil" } as Record<string, TextPresetKey>)[language] ?? "title";
  }
  return ({ tagline: "tagline", cta: "cta", credits: "credits", headline: "subtitle", caption: "body" } as Record<string, TextPresetKey>)[kind] ?? "body";
}

/** Put text into the first selected text layer (switching to a font that can draw it), or add a new text layer. */
export function placeCopy(text: string, preset: TextPresetKey): "replaced" | "added" {
  const sel = selectedText()[0];
  if (sel) {
    const fixed = fixFontForText({ ...sel, text });
    useEditor.getState().patchLayer(sel.id, { text, fontFamily: fixed.fontFamily });
    return "replaced";
  }
  addPayload({ kind: "text", preset, text });
  return "added";
}

/** A text layer built from a preset with overrides, centred on the page and with a font that can draw it. */
export function textLayer(preset: TextPresetKey, over: Partial<TextLayer> = {}): TextLayer {
  return fixFontForText(newText(preset, W(), H(), over));
}
