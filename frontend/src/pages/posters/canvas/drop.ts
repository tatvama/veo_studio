/**
 * Turning things dropped or pasted onto the canvas into layers: panel payloads (DND_MIME), image files from the
 * desktop or the clipboard (uploaded first), and copied layers. Images dropped onto an empty slot fill that slot.
 */
import { toast } from "sonner";
import { tr } from "../../../lib/i18n";
import { designsApi } from "../api";
import { boundsOf, fixFontForText, layersFromDrop, newText, refitImage, uid, unionBox } from "../doc";
import { useEditor } from "../store";
import type { DropPayload, ImageLayer, Layer } from "../types";
import { CLIP_PREFIX } from "./commands";

export interface Pt { x: number; y: number }

export function containsPoint(l: Pick<Layer, "x" | "y" | "width" | "height" | "rotation">, p: Pt): boolean {
  const r = ((l.rotation || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = p.x - l.x, dy = p.y - l.y;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  return lx >= 0 && ly >= 0 && lx <= l.width && ly <= l.height;
}

/** The top-most image layer under a point that can take a dropped image: an empty slot, or any image when `any`. */
export function slotAt(p: Pt, any: boolean): ImageLayer | null {
  const layers = useEditor.getState().doc.layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.type !== "image" || !l.visible || !containsPoint(l, p)) continue;
    if (any || (!l.src && !l.pending)) return l;
  }
  return null;
}

/** Put an image into an existing layer, keeping its frame. */
export function fillSlot(l: ImageLayer, img: { src: string; asset?: string; width: number; height: number }) {
  const next = refitImage({ ...l, src: img.src, asset: img.asset, pending: null }, img.width || 1, img.height || 1);
  const { id: _id, ...patch } = next;
  useEditor.getState().patchLayer(l.id, patch);
  useEditor.getState().select([l.id]);
}

/**
 * Move a dropped group of layers so the centre of its bounding box sits at `at`. Layers that cover the whole page
 * (full-page overlays, effects) stay where they are.
 */
export function centreGroupAt(layers: Layer[], at: Pt, W: number, H: number): Layer[] {
  const fullPage = (l: Layer) => {
    if (l.type === "effect") return true;
    const b = boundsOf(l);
    return b.width >= W * 0.98 && b.height >= H * 0.98;
  };
  const movable = layers.filter((l) => !fullPage(l));
  const u = unionBox(movable.map(boundsOf));
  if (!u) return layers;
  const dx = Math.round(at.x - (u.x + u.width / 2)), dy = Math.round(at.y - (u.y + u.height / 2));
  if (!dx && !dy) return layers;
  return layers.map((l) => (fullPage(l) ? l : ({ ...l, x: l.x + dx, y: l.y + dy } as Layer)));
}

export function placePayload(payload: DropPayload, at: Pt | undefined, alt = false) {
  const st = useEditor.getState();
  if (payload.kind === "image" && at) {
    const slot = slotAt(at, alt);
    if (slot) { fillSlot(slot, payload); return; }
  }
  let layers = layersFromDrop(payload, st.width, st.height, at);
  if (payload.kind === "layers" && at) layers = centreGroupAt(layers, at, st.width, st.height);
  const bottom = payload.kind === "image" && payload.role === "background";
  st.addLayers(layers, { index: bottom ? 0 : undefined });
}

const isImageFile = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(f.name);

/** Upload image files and place them: into `targetId`, into an empty slot under `at`, or as new layers at `at`. */
export async function uploadFiles(designId: number, files: File[], opts: { at?: Pt; alt?: boolean; targetId?: string } = {}) {
  const images = files.filter(isImageFile);
  if (!images.length) {
    if (files.length) toast.error(tr("Only images can be added to a design (PNG, JPG, WebP or GIF)."));
    return;
  }
  let i = 0;
  for (const f of images) {
    const id = toast.loading(tr("Uploading {name}…", { name: f.name || tr("image") }));
    try {
      const up = await designsApi.upload(designId, f);
      toast.success(tr("Added {name}", { name: up.name || f.name || tr("image") }), { id, duration: 1800 });
      const st = useEditor.getState();
      const target = opts.targetId ? st.doc.layers.find((l) => l.id === opts.targetId) : undefined;
      if (target && target.type === "image" && i === 0) {
        fillSlot(target, up);
      } else {
        const at = opts.at ? { x: opts.at.x + i * 24, y: opts.at.y + i * 24 } : undefined;
        placePayload({ kind: "image", src: up.src, asset: up.asset, width: up.width, height: up.height, name: (up.name || "Image").replace(/\.[a-z0-9]+$/i, "") }, at, opts.alt);
      }
    } catch {
      toast.dismiss(id); // the API layer already explained what went wrong
    }
    i++;
  }
}

/** Copy layers: the editor clipboard, plus the system clipboard so they paste into another design or tab. */
export function copyLayers(ids?: string[]) {
  const st = useEditor.getState();
  st.copy(ids);
  const layers = useEditor.getState().clipboard;
  if (!layers.length) return;
  try {
    void navigator.clipboard?.writeText(CLIP_PREFIX + JSON.stringify(layers)).catch(() => {});
  } catch { /* clipboard not available */ }
}

/** Handle a paste: image files upload, copied layers come back, plain text becomes a text layer. Returns true if handled. */
export function handlePaste(designId: number, data: DataTransfer | null): boolean {
  const st = useEditor.getState();
  const files = data ? Array.from(data.files).filter(isImageFile) : [];
  if (files.length) {
    void uploadFiles(designId, files, { at: { x: st.width / 2, y: st.height / 2 } });
    return true;
  }
  const text = data?.getData("text/plain") ?? "";
  if (text.startsWith(CLIP_PREFIX)) {
    try {
      const layers = JSON.parse(text.slice(CLIP_PREFIX.length)) as Layer[];
      const here = new Set(st.doc.layers.map((l) => l.id));
      const sameDoc = layers.some((l) => here.has(l.id));
      if (sameDoc && st.clipboard.length) st.paste();
      else st.addLayers(layers.map((l) => ({ ...structuredClone(l), id: uid(l.type[0]), pending: null }) as Layer));
      return true;
    } catch { /* not ours after all */ }
  }
  if (st.clipboard.length) { st.paste(); return true; }
  if (text.trim()) {
    const t = fixFontForText(newText("body", st.width, st.height, { text: text.trim().slice(0, 2000), name: tr("Pasted text") }));
    st.addLayers([t]);
    return true;
  }
  return false;
}
