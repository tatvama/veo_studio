/**
 * Shared helpers for the review player, compare view and timeline: timecodes, a tiny time store ("clock") that lets
 * the playhead update at 60 fps without re-rendering whole pages, keyboard guards and storage helpers.
 */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { tr } from "../../lib/i18n";
import type { Stroke } from "../../lib/types";

/** Renders run at 24 fps (backend `ffmpeg.normalize_clip` default) unless the export says otherwise. */
export const DEFAULT_FPS = 24;

/** A comment normalised from either the internal (/api/comments) or the public (/api/review/…/comments) API. */
export interface RComment {
  id: number;
  body: string;
  timecode: number | null;
  drawing: Stroke[];
  resolved: boolean;
  created_at: string;
  author: string;
  guest: boolean;
}

export interface Marker { id: number; time: number; resolved: boolean; author: string; body: string; drawing: boolean }

export function fpsOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 120 ? Math.round(n) : DEFAULT_FPS;
}

export const frameOf = (t: number, fps: number) => Math.floor(Math.max(0, t) * fps + 1e-6);
/** Middle of a frame — seeking there makes every browser show exactly that frame. */
export const frameTime = (frame: number, fps: number) => (Math.max(0, frame) + 0.5) / fps;

const p2 = (n: number) => String(n).padStart(2, "0");

/** HH:MM:SS:FF (compact drops the hours when zero). */
export function formatTC(sec: number, fps = DEFAULT_FPS, compact = false): string {
  const total = frameOf(Number.isFinite(sec) ? sec : 0, fps);
  const f = total % fps;
  const s = Math.floor(total / fps);
  const hh = Math.floor(s / 3600);
  const tc = `${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}:${p2(f)}`;
  return compact && hh === 0 ? tc : `${p2(hh)}:${tc}`;
}

/** m:ss for rulers, with frames when the step is below a second. */
export function rulerLabel(sec: number, fps: number, withFrames: boolean): string {
  const s = Math.floor(sec + 1e-6);
  const base = `${Math.floor(s / 60)}:${p2(s % 60)}`;
  return withFrames ? `${base}:${p2(frameOf(sec, fps) % fps)}` : base;
}

export function relTime(iso?: string | null): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return tr("just now");
  if (s < 3600) return tr("{n}m ago", { n: Math.round(s / 60) });
  if (s < 86400) return tr("{n}h ago", { n: Math.round(s / 3600) });
  return tr("{n}d ago", { n: Math.round(s / 86400) });
}

/** True when a key press belongs to a text field (shortcuts must not fire while typing). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["range", "checkbox", "radio", "button", "submit", "color"].includes(type);
  }
  return el.isContentEditable;
}

/** Shortcut guard: ignore typing, modified combos (except Shift) and keys already handled. */
export function shortcutAllowed(e: KeyboardEvent): boolean {
  return !e.defaultPrevented && !isTypingTarget(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export function lsGet(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
export function lsSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Live match of a CSS media query (false during SSR / first paint). */
export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(q); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(q).matches,
    () => false,
  );
}

/**
 * Width of an element in px, measured before the first paint (no layout flash) and kept in sync.
 * Returns a callback ref (so it also works when the element mounts later) and the width.
 */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

// ── clock: a subscribable current-time store ────────────────────────────────

export interface Clock { get(): number; set(t: number): void; subscribe(cb: () => void): () => void }

export function createClock(initial = 0): Clock {
  let t = initial;
  const ls = new Set<() => void>();
  return {
    get: () => t,
    set: (v: number) => {
      if (v === t) return;
      t = v;
      ls.forEach((l) => l());
    },
    subscribe: (cb) => {
      ls.add(cb);
      return () => { ls.delete(cb); };
    },
  };
}

/** Every tick (use in tiny components only — playheads, timecode readouts). */
export function useClock(clock: Clock): number {
  return useSyncExternalStore(clock.subscribe, clock.get, clock.get);
}

/** Throttled view of the clock for heavier components (comment lists, overlays). Always delivers the final value. */
export function useClockThrottled(clock: Clock, ms = 120): number {
  const [v, setV] = useState(clock.get());
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = () => { last = performance.now(); setV(clock.get()); };
    const onTick = () => {
      const since = performance.now() - last;
      if (since >= ms) push();
      else if (!timer) timer = setTimeout(() => { timer = null; push(); }, ms - since);
    };
    push();
    const un = clock.subscribe(onTick);
    return () => { un(); if (timer) clearTimeout(timer); };
  }, [clock, ms]);
  return v;
}

/** Stable hue class for an author's avatar (theme tokens only). */
const AVATAR_TONES = [
  "bg-accent/20 text-accent-ink", "bg-info/20 text-info", "bg-ok/20 text-ok", "bg-warn/20 text-warn", "bg-accent-2/20 text-accent-2",
  "bg-bad/20 text-bad",
];
export function avatarTone(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}
export function initials(name: string): string {
  const parts = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function sortComments(list: RComment[]): RComment[] {
  return [...list].sort((a, b) => {
    if (a.timecode == null && b.timecode == null) return a.id - b.id;
    if (a.timecode == null) return 1;
    if (b.timecode == null) return -1;
    return a.timecode - b.timecode || a.id - b.id;
  });
}
