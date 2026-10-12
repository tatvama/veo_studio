/**
 * Drag and drop between the editor's panels (project bin, source monitor, effects → timeline, program monitor).
 * HTML drag and drop, because dockview panels can sit in different groups and floating windows. The payload is kept
 * here as well as on the DataTransfer, since `dragover` can't read the data, only its types.
 */
export const DND_MIME = "application/x-tatvam-editor";

export type DragPayload =
  | { kind: "media"; items: { mediaId: string; video?: boolean; audio?: boolean }[] }
  | { kind: "sequence"; sequenceId: string }
  | { kind: "effect"; effect: string; media: "video" | "audio" }
  | { kind: "transition"; transition: string; media: "video" | "audio" };

let current: DragPayload | null = null;

export function startDrag(e: React.DragEvent | DragEvent, p: DragPayload, label?: string) {
  current = p;
  const dt = e.dataTransfer;
  if (!dt) return;
  dt.effectAllowed = "copyMove";
  dt.setData(DND_MIME, JSON.stringify(p));
  dt.setData("text/plain", label ?? p.kind);
  if (label) {
    const g = document.createElement("div");
    g.textContent = label;
    g.style.cssText = "position:fixed;top:-100px;left:-100px;padding:3px 8px;border-radius:6px;font:600 11px Inter Variable,system-ui;color:#fff;background:rgba(20,30,48,.92);border:1px solid rgba(103,232,249,.5)";
    document.body.appendChild(g);
    dt.setDragImage(g, 10, 10);
    window.setTimeout(() => g.remove(), 0);
  }
}

/** The payload of the drag in progress (null for files from Explorer or a foreign drag). */
export function currentDrag(e?: React.DragEvent | DragEvent): DragPayload | null {
  if (current) return current;
  const raw = e?.dataTransfer?.getData(DND_MIME);
  if (raw) { try { return JSON.parse(raw) as DragPayload; } catch { return null; } }
  return null;
}
export const isEditorDrag = (e: React.DragEvent | DragEvent) => !!e.dataTransfer?.types.includes(DND_MIME);
export const isFileDrag = (e: React.DragEvent | DragEvent) => !!e.dataTransfer?.types.includes("Files");
export function endDrag() { current = null; }

if (typeof window !== "undefined") {
  window.addEventListener("dragend", endDrag, true);
  window.addEventListener("drop", () => window.setTimeout(endDrag, 0), true);
}
