/**
 * The live preview on the Program monitor (preview-polish), as in Resolve: hover a card for 400 ms and the program
 * shows the item applied — the panel's own apply, run on a copy of the edit, so it is exactly what a click gives.
 * It never enters undo (the real edit is never touched), it goes away when the pointer leaves, and any real change
 * to the edit ends it. Transitions, titles and templates loop over their own range of the sequence (≈30 fps on the
 * monitor's own engine), within 8 ms a frame: slower draws drop to ½ resolution, then to a still.
 */
import { useSyncExternalStore } from "react";
import { ctxOf, normalize } from "../model/ops";
import type { EditProject } from "../model/types";
import { program } from "../playback/transport";
import { project } from "../store";

export interface LiveSpec {
  /** Unique per card (a card's begin and end pair by it). */
  key: string;
  label: string;
  /** How to keep it ("Click to apply", "Double-click to apply"). */
  hint?: string;
  /** The panel's apply on a draft of the edit. */
  mutate(draft: EditProject): void;
  /** Sequence frames to loop over while it shows (a transition's range, a title's clip); null: the playhead's frame. */
  span?(before: EditProject, after: EditProject): [number, number] | null;
}

interface State { spec: LiveSpec; base: EditProject; project: EditProject; span: [number, number] | null; fps: number; t: number | null }
let state: State | null = null;
let ver = 0;
const subs = new Set<() => void>();
const emit = () => { ver++; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Draws the program at t seconds at a resolution, returning how long the draw took (ms). Set by the monitor. */
type Drawer = (t: number, resolution: number) => number;
let drawer: Drawer | null = null;
export function setLiveDrawer(d: Drawer | null) { drawer = d; }

/** Frame times of live loops (ms), the last 120, and the resolution they ran at. */
export const liveStats = { ms: [] as number[], resolution: 1, stills: 0, shown: 0, ended: [] as string[] };

export const reducedMotion = () => {
  try { return document.documentElement.dataset.motion === "reduced" || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

/** Shows `spec` on the Program monitor (false when it can't: playing, nothing in the edit for it to change, or the
 *  apply threw). */
export function beginLive(spec: LiveSpec): boolean {
  if (program.playing) return false;
  const base = project();
  const seq0 = base.sequences.find((s) => s.id === base.activeSequenceId);
  if (!seq0?.clips.length) return false;
  try {
    const draft = structuredClone(base) as EditProject;
    spec.mutate(draft);
    // the apply changed nothing here (no clips in its scope): no preview to show
    if (JSON.stringify(draft.sequences) === JSON.stringify(base.sequences)) return false;
    const c = ctxOf(draft);
    const after: EditProject = { ...draft, sequences: draft.sequences.map((s) => normalize(s, c)) };
    const sq = after.sequences.find((s) => s.id === after.activeSequenceId);
    state = { spec, base, project: after, span: spec.span?.(base, after) ?? null, fps: sq?.fps ?? 25, t: null };
  } catch (e) { console.warn("[preview] live", e); return false; }
  liveStats.shown++;
  emit();
  startLoop();
  return true;
}

/** Ends the live preview (only `key`'s, when given). */
export function endLive(key?: string, why = "leave") {
  if (!state || (key && state.spec.key !== key)) return;
  liveStats.ended.push(why); if (liveStats.ended.length > 20) liveStats.ended.shift();
  state = null;
  stopLoop();
  emit();
}
export const liveKey = () => state?.spec.key ?? null;

/** The project the Program monitor draws: the tentative one while a live preview shows. */
export function useLiveProject(p: EditProject): EditProject {
  useSyncExternalStore(subscribe, () => ver);
  if (state && state.base !== p) { queueMicrotask(() => { if (state && state.base !== project()) endLive(undefined, "edit changed"); }); return p; }
  return state?.project ?? p;
}

/** Where a live loop is (seconds), or null: the monitor's own redraws use it. */
export const liveTime = (): number | null => state?.t ?? null;

/** The badge over the monitor while a preview shows. */
export function useLiveLabel(): { label: string; hint: string } | null {
  useSyncExternalStore(subscribe, () => ver);
  return state ? { label: state.spec.label, hint: state.spec.hint ?? "Click to apply" } : null;
}

// ── the loop ────────────────────────────────────────────────────────────────────────────────────────────

let raf = 0;
function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

function startLoop() {
  stopLoop();
  const st = state;
  if (!st?.span) return;
  const [a, b] = st.span;
  const from = a / st.fps, to = Math.max(from + 1 / st.fps, b / st.fps);
  const len = to - from, holdS = 0.5;
  // a still in the middle when motion is reduced
  if (reducedMotion()) { st.t = from + len * 0.5; liveStats.stills++; window.setTimeout(() => { if (state === st) drawer?.(st.t!, 1); }, 80); return; }
  let res = 1, slow = 0, last = -1;
  const t0 = performance.now() + 60; // the monitor loads the tentative edit first
  const tick = () => {
    if (state !== st) return;
    raf = requestAnimationFrame(tick);
    const el = (performance.now() - t0) / 1000;
    if (el < 0) return;
    const cyc = el % (len + holdS);
    const t = from + Math.min(len, cyc);
    const f = Math.round(t * 30);
    if (f === last) return;
    last = f;
    st.t = t;
    const ms = drawer?.(t, res) ?? 0;
    liveStats.ms.push(ms);
    if (liveStats.ms.length > 120) liveStats.ms.shift();
    liveStats.resolution = res;
    // over budget three frames running: half resolution, then a still
    slow = ms > 8 ? slow + 1 : 0;
    if (slow >= 3) {
      slow = 0;
      if (res > 0.5) res = 0.5;
      else { stopLoop(); st.t = from + len * 0.5; liveStats.stills++; drawer?.(st.t, res); }
    }
  };
  raf = requestAnimationFrame(tick);
}
