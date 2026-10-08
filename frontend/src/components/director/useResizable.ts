import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

export const DIRECTOR_MIN = 320;
export const DIRECTOR_MAX = 560;
export const DIRECTOR_DEFAULT = 360;
const KEY = "veo-director-width";

const clamp = (v: number) => Math.max(DIRECTOR_MIN, Math.min(DIRECTOR_MAX, Math.round(v)));

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DIRECTOR_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clamp(v) : DIRECTOR_DEFAULT;
  } catch {
    return DIRECTOR_DEFAULT;
  }
}

function write(v: number) {
  try {
    if (v === DIRECTOR_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(v));
  } catch { /* private mode / blocked storage: the width just isn't remembered */ }
}

/**
 * Width of the Director panel, set by dragging a handle on its left edge (pointer or keyboard), remembered in localStorage.
 * While dragging only the CSS variable `--agent-w` on `target` changes (no React renders); the state is committed on release.
 */
export function useResizableWidth(target: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(read);
  const [dragging, setDragging] = useState(false);
  const live = useRef(width);
  const cleanup = useRef<(() => void) | null>(null);

  const apply = useCallback((w: number) => {
    live.current = w;
    target.current?.style.setProperty("--agent-w", `${w}px`);
  }, [target]);

  const commit = useCallback((w: number) => {
    const v = clamp(w);
    setWidth(v);
    apply(v);
    write(v);
  }, [apply]);

  const reset = useCallback(() => commit(DIRECTOR_DEFAULT), [commit]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = live.current;
    let last = startW;
    let raf = 0;
    const root = document.documentElement;
    const prevCursor = root.style.cursor;
    const prevSelect = document.body.style.userSelect;
    root.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setDragging(true);

    const move = (ev: PointerEvent) => {
      last = clamp(startW + (startX - ev.clientX));
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; apply(last); });
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (raf) cancelAnimationFrame(raf);
      root.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      cleanup.current = null;
      setDragging(false);
      commit(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    cleanup.current = end;
  }, [apply, commit]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") commit(live.current + step);
    else if (e.key === "ArrowRight") commit(live.current - step);
    else if (e.key === "Home" || e.key === "Enter") reset();
    else if (e.key === "End") commit(DIRECTOR_MAX);
    else return;
    e.preventDefault();
    e.stopPropagation(); // arrow keys also move the selected shot on the storyboard
  }, [commit, reset]);

  // If the panel unmounts mid-drag, put the cursor and text selection back.
  useEffect(() => () => cleanup.current?.(), []);

  return { width, dragging, reset, handleProps: { onPointerDown, onKeyDown, onDoubleClick: reset } };
}
