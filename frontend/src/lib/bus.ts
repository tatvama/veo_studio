/**
 * The cross-window bus (docs/DESKTOP.md §5): every window of the same origin — desktop pop-outs and browser pop-outs alike —
 * shares `BroadcastChannel("tatvam-desktop")`. Messages are also delivered to listeners in the sending window, so a panel
 * and the Finishing room in one tab talk the same way; each sender stamps a `src` so it can ignore its own echo.
 *
 * The last `select`, `marks`, `seek` and paused `playhead` per episode are kept in localStorage, so a window that opens
 * later starts on the shot and time the others are on.
 */
import { useEffect, useMemo, useRef } from "react";

export type BusMessage =
  | { type: "playhead"; eid: number; t: number; playing: boolean }
  | { type: "select"; eid: number; shotId: number | null }
  | { type: "marks"; eid: number; in: number | null; out: number | null; shotId?: number | null }
  | { type: "seek"; eid: number; t: number }
  /** What the program monitor shows right now: the media file and the time inside it (scopes read frames from it). */
  | { type: "frame"; eid: number; url: string; time: number; shotId?: number | null; filter?: string; playing?: boolean; rate?: number };

export type BusType = BusMessage["type"];
export type BusOf<K extends BusType> = Extract<BusMessage, { type: K }>;
export type BusEnvelope<K extends BusType = BusType> = BusOf<K> & { src: string; at: number };

const CHANNEL = "tatvam-desktop";
const LAST_KEY = "tatvam-bus-last";
const WINDOW_ID = Math.random().toString(36).slice(2, 10);
let counter = 0;

type Listener = (m: BusEnvelope) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function ensure(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (ev) => {
      const m = ev.data as BusEnvelope;
      if (m && typeof m === "object" && typeof m.type === "string") deliver(m);
    };
  } catch {
    channel = null;
  }
  return channel;
}

function deliver(m: BusEnvelope) {
  remember(m);
  listeners.forEach((l) => {
    try { l(m); } catch (e) { console.warn("[bus] listener failed", e); }
  });
}

// ── last known state ─────────────────────────────────────────────────────────

type LastMap = Record<string, BusEnvelope>;
let lastCache: LastMap | null = null;
let lastWrite = 0;

function readLast(): LastMap {
  if (lastCache) return lastCache;
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) || "{}");
    lastCache = v && typeof v === "object" ? v : {};
  } catch { lastCache = {}; }
  return lastCache!;
}

function remember(m: BusEnvelope) {
  // a running playhead changes ten times a second: only its resting place is worth keeping
  if (m.type === "frame" || (m.type === "playhead" && m.playing)) return;
  const map = { ...readLast(), [`${m.type}:${m.eid}`]: m };
  lastCache = map;
  const now = Date.now();
  if (m.type === "playhead" && now - lastWrite < 500) return;
  lastWrite = now;
  try {
    // keep the map small: the newest 40 entries
    const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, 40);
    localStorage.setItem(LAST_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* storage blocked */ }
}

/** The last message of a kind for an episode (from any window), if it is younger than `maxAgeMs`. */
export function lastOf<K extends BusType>(type: K, eid: number, maxAgeMs = Infinity): BusEnvelope<K> | null {
  lastCache = null; // another window may have written since
  const m = readLast()[`${type}:${eid}`] as BusEnvelope<K> | undefined;
  return m && Date.now() - m.at <= maxAgeMs ? m : null;
}

// ── API ──────────────────────────────────────────────────────────────────────

/** Sends a message to every window (and this one). `src` identifies the sender; use `useBusSource()` in components. */
export function publish(msg: BusMessage, src: string = WINDOW_ID): void {
  const m = { ...msg, src, at: Date.now() } as BusEnvelope;
  try { ensure()?.postMessage(m); } catch { /* closed channel */ }
  deliver(m);
}

/** Listens to every message (low level; prefer `useBus`). Returns the unsubscribe function. */
export function subscribe(fn: Listener): () => void {
  ensure();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A sender id unique to this component instance, for `publish(msg, src)` and `useBus(…, { self: src })`. */
export function useBusSource(): string {
  return useMemo(() => `${WINDOW_ID}:${++counter}`, []);
}

/**
 * Calls `handler` for each message of `type` (optionally only for episode `eid`, and never for messages sent by `self`).
 * The handler can change between renders without re-subscribing.
 */
export function useBus<K extends BusType>(type: K, handler: (m: BusEnvelope<K>) => void, opts: { eid?: number; self?: string } = {}) {
  const ref = useRef(handler);
  ref.current = handler;
  const { eid, self } = opts;
  useEffect(() => subscribe((m) => {
    if (m.type !== type) return;
    if (eid !== undefined && m.eid !== eid) return;
    if (self && m.src === self) return;
    ref.current(m as BusEnvelope<K>);
  }), [type, eid, self]);
}

/** Calls `fn` at most every `ms` (trailing call kept), for playhead messages. */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  return (...a: A) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...a);
      return;
    }
    pending = a;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      }, wait);
    }
  };
}

// ── open panels (so a click can tell whether a program window will follow it) ──

const PANELS_KEY = "tatvam-panels-open";

/** A pop-out panel marks itself open every few seconds (in localStorage, shared by every window). */
export function usePanelBeacon(panel: string, eid: number | undefined) {
  useEffect(() => {
    if (!eid) return;
    const beat = () => {
      try {
        const v = JSON.parse(localStorage.getItem(PANELS_KEY) || "{}");
        v[`${panel}:${eid}`] = Date.now();
        localStorage.setItem(PANELS_KEY, JSON.stringify(v));
      } catch { /* storage blocked */ }
    };
    beat();
    const h = window.setInterval(beat, 4000);
    const bye = () => {
      try {
        const v = JSON.parse(localStorage.getItem(PANELS_KEY) || "{}");
        delete v[`${panel}:${eid}`];
        localStorage.setItem(PANELS_KEY, JSON.stringify(v));
      } catch { /* storage blocked */ }
    };
    window.addEventListener("pagehide", bye);
    return () => { window.clearInterval(h); window.removeEventListener("pagehide", bye); bye(); };
  }, [panel, eid]);
}

/** Whether a panel of this kind is open for the episode in any window (seen in the last 10 s). */
export function panelOpen(panel: string, eid: number): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(PANELS_KEY) || "{}");
    return Date.now() - Number(v[`${panel}:${eid}`] ?? 0) < 10_000;
  } catch { return false; }
}
