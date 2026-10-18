import { create } from "zustand";

/** What is being dragged from the library onto the canvas. */
export type DragPayload =
  | { kind: "character"; id: number; name: string }
  | { kind: "place"; id: number; name: string }
  | { kind: "prop"; id: number; name: string };

/** The drag payload's MIME type (HTML drag and drop). */
export const DRAG_MIME = "application/x-tatvam-canvas";

/**
 * Short-lived canvas state the nodes read with selectors (a node re-renders only when its own answer changes), kept out
 * of the node array so a hover, a highlight or a library drag never rebuilds the graph.
 */
interface CanvasUI {
  drag: DragPayload | null;
  /** A character picked in the library: their shots are lit, the rest dimmed. */
  highlight: number | null;
  /** Search hits, in film order, and the one in focus. */
  matches: ReadonlySet<number>;
  current: number | null;
  setDrag: (d: DragPayload | null) => void;
  setHighlight: (id: number | null) => void;
  setMatches: (ids: number[], current: number | null) => void;
  reset: () => void;
}

const EMPTY: ReadonlySet<number> = new Set();

export const useCanvasUI = create<CanvasUI>((set) => ({
  drag: null,
  highlight: null,
  matches: EMPTY,
  current: null,
  setDrag: (drag) => set({ drag }),
  setHighlight: (highlight) => set({ highlight }),
  setMatches: (ids, current) => set({ matches: ids.length ? new Set(ids) : EMPTY, current }),
  reset: () => set({ drag: null, highlight: null, matches: EMPTY, current: null }),
}));

/** Reads a library payload from a drop (the store has it too; the data transfer survives a drag from another window). */
export function readDrag(e: { dataTransfer: DataTransfer | null }): DragPayload | null {
  const live = useCanvasUI.getState().drag;
  if (live) return live;
  try {
    const raw = e.dataTransfer?.getData(DRAG_MIME);
    const v = raw ? JSON.parse(raw) : null;
    return v && (v.kind === "character" || v.kind === "place" || v.kind === "prop") && typeof v.id === "number" ? v : null;
  } catch { return null; }
}
