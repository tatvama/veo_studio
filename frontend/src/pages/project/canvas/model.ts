/**
 * The Shots canvas, as plain logic (no React, no imports with side effects, so `node --test` runs it as is):
 * the five steps of a shot and the state of each dot, the auto layout (scenes as rows, shots left → right), where a
 * dragged shot or scene lands, search, and the local undo stack. Tests: src/lib/__tests__/canvas*.test.ts.
 */

// ── the five steps of a shot ─────────────────────────────────────────────────

export type StepId = "picture" | "video" | "voice" | "mouth" | "sound";
export const STEPS: readonly StepId[] = ["picture", "video", "voice", "mouth", "sound"];
/** Plain words for the steps (keys for t()). */
export const STEP_LABEL: Record<StepId, string> = {
  picture: "Picture", video: "Video", voice: "Voice", mouth: "Mouth sync", sound: "Sound",
};

/** What one step of one shot costs to (re)make: the body for POST /episodes/{eid}/estimate and /generate. */
export function stepBody(step: StepId, shotId: number): Record<string, unknown> {
  const shot_ids = [shotId];
  switch (step) {
    case "picture": return { action: "keyframes", shot_ids };
    case "video": return { action: "videos", shot_ids };
    case "voice": return { action: "voices", shot_ids };
    case "mouth": return { action: "lipsync", shot_ids };
    // sound effects run through Produce all's sound step: ElevenLabs when connected, else the free library
    case "sound": return { action: "produce", steps: ["sound"], shot_ids };
  }
}

/** The steps Make it / Make scene run: only what is still missing (music and the render are the film's, not a shot's). */
export const MAKE_STEPS = ["cast", "keyframes", "videos", "extend", "voices", "sound"] as const;
export const makeBody = (shotIds: number[]) => ({ action: "produce", steps: [...MAKE_STEPS], shot_ids: shotIds });

/** "need": the film needs it · "optional": not needed (e.g. the video engine already speaks the lines) · "none": nothing to make. */
export type Need = "need" | "optional" | "none";
export interface Problem { job_id: number; error: string; at: string | null }
/** Per shot, from GET /api/episodes/{eid}/canvas. */
export interface ShotInfo { voice: Need; mouth: Need; sound: Need; voice_mode?: string; problems: Partial<Record<StepId, Problem>> }
export interface SceneMusic { id: number; url: string; duration_s: number; prompt: string; selected: boolean }
export interface CanvasInfo {
  episode_id: number; language: string; shots: Record<string, ShotInfo>; scene_music: Record<string, SceneMusic>;
  sound_engine: boolean; lipsync_engine: boolean;
}

interface TakeLike { id?: number; stale?: boolean; stale_reason?: string }
/** The fields of a shot the dots read (lib/types Shot fits it). */
export interface ShotLike {
  keyframe?: TakeLike | null; video?: TakeLike | null; voice?: TakeLike | null; narration_take?: TakeLike | null;
  lipsync?: TakeLike | null; voicelock?: TakeLike | null; active_jobs?: string[] | null; sfx_track?: { path?: string } | null;
  blocked?: { error?: string } | null; generating?: boolean;
}

/**
 * done (green) · running (glowing) · failed (red, with the reason) · stale (made before an edit: out of date) ·
 * empty (not made yet) · none (nothing to make for this shot, e.g. no lines to voice).
 */
export type DotState = "done" | "running" | "failed" | "stale" | "empty" | "none";
export interface Dot { step: StepId; state: DotState; need: Need; error?: string; jobId?: number; staleReason?: string }

/** Job types (Shot.active_jobs) that are making each step right now. */
const RUNNING: Record<StepId, readonly string[]> = {
  picture: ["keyframe", "endframe"], video: ["video"], voice: ["voice", "voicelock"], mouth: ["lipsync"], sound: ["sfx"],
};

function takeOf(shot: ShotLike, step: StepId): TakeLike | null {
  switch (step) {
    case "picture": return shot.keyframe ?? null;
    case "video": return shot.video ?? null;
    case "voice": return shot.voice ?? shot.narration_take ?? shot.voicelock ?? null;
    case "mouth": return shot.lipsync ?? null;
    case "sound": return shot.sfx_track?.path ? {} : null;
  }
}

/** The five dots of a shot. Running beats failed beats out of date beats done. */
export function shotDots(shot: ShotLike, info?: ShotInfo | null): Dot[] {
  const active = shot.active_jobs ?? [];
  return STEPS.map((step) => {
    const need: Need = step === "picture" || step === "video" ? "need" : info ? info[step] : "need";
    const take = takeOf(shot, step);
    const problem = info?.problems?.[step];
    if (RUNNING[step].some((t) => active.includes(t))) return { step, state: "running", need };
    if (problem) return { step, state: "failed", need, error: problem.error, jobId: problem.job_id };
    if (step === "video" && shot.blocked?.error) return { step, state: "failed", need, error: shot.blocked.error };
    if (take?.stale) return { step, state: "stale", need, staleReason: take.stale_reason || "" };
    if (take) return { step, state: "done", need };
    return { step, state: need === "none" ? "none" : "empty", need };
  });
}

/** What a shot's badges say: anything out of date, anything failed. */
export function shotFlags(dots: Dot[]): { stale: Dot[]; failed: Dot[]; running: boolean; done: number; todo: number } {
  return {
    stale: dots.filter((d) => d.state === "stale"),
    failed: dots.filter((d) => d.state === "failed"),
    running: dots.some((d) => d.state === "running"),
    done: dots.filter((d) => d.state === "done").length,
    todo: dots.filter((d) => d.state === "empty" && d.need === "need").length,
  };
}

/** "8s", or "8s → 15s" for a shot extended past its first clip. */
export function lengthLabel(duration: number, extendTo?: number | null): string {
  return extendTo && extendTo > duration ? `${duration}s → ${extendTo}s` : `${duration}s`;
}
export const shotSeconds = (duration: number, extendTo?: number | null) => Math.max(extendTo || 0, duration);

// ── links between shots ──────────────────────────────────────────────────────

export type LinkMode = "last_frame" | "end_frame" | "extend";
export const LINK_MODES: readonly LinkMode[] = ["last_frame", "end_frame", "extend"];
/** Plain words on a link's label (keys for t()). */
export const LINK_LABEL: Record<LinkMode, string> = { last_frame: "Continue", end_frame: "Exact match", extend: "Extend" };
export const LINK_HINT: Record<LinkMode, string> = {
  last_frame: "{target} starts from {source}'s last frame",
  end_frame: "{target} starts exactly on {source}'s end frame: the two clips join without a jump",
  extend: "{target}'s video extends {source}'s clip",
};
export const nextLinkMode = (m: LinkMode): LinkMode => LINK_MODES[(LINK_MODES.indexOf(m) + 1) % LINK_MODES.length];

// ── layout ───────────────────────────────────────────────────────────────────

export const LAYOUT = {
  shotW: 232, shotH: 212, gapX: 64, gapY: 44, padX: 16, headerH: 72, padBottom: 16, collapsedH: 72, minSlots: 2,
} as const;
export type Layout = typeof LAYOUT;

export interface GroupIn { key: string; count: number; collapsed: boolean }
export interface Box { key: string; x: number; y: number; w: number; h: number }

/** Width of a scene row: its shots, plus one slot for "Add a shot" (and never narrower than two slots). */
export function groupWidth(count: number, o: Layout = LAYOUT): number {
  const slots = Math.max(o.minSlots, count + 1);
  return o.padX * 2 + slots * o.shotW + (slots - 1) * o.gapX;
}

/** Scenes as rows, top to bottom in film order. */
export function layoutGroups(groups: GroupIn[], o: Layout = LAYOUT): Box[] {
  let y = 0;
  return groups.map((g) => {
    const h = g.collapsed ? o.collapsedH : o.headerH + o.shotH + o.padBottom;
    const box = { key: g.key, x: 0, y, w: groupWidth(g.count, o), h };
    y += h + o.gapY;
    return box;
  });
}

/** Where shot number `i` of a scene sits inside its row (relative to the row). */
export const shotSlot = (i: number, o: Layout = LAYOUT) => ({ x: o.padX + i * (o.shotW + o.gapX), y: o.headerH });

/** The slot a shot dropped at `relX` (left edge, relative to the row) goes into, among `count` other shots. */
export function slotAt(relX: number, count: number, o: Layout = LAYOUT): number {
  const i = Math.round((relX - o.padX) / (o.shotW + o.gapX));
  return Math.max(0, Math.min(count, i));
}

/** The row under a point's y (the nearest row when it falls in a gap; -1 with no rows). */
export function boxAtY(boxes: Box[], y: number): number {
  let best = -1;
  let dist = Infinity;
  boxes.forEach((b, i) => {
    const d = y < b.y ? b.y - y : y > b.y + b.h ? y - (b.y + b.h) : 0;
    if (d < dist) { dist = d; best = i; }
  });
  return best;
}

/** The scene order after a row was dragged so that its centre is at `centerY`. */
export function orderAfterDrag(boxes: Box[], key: string, centerY: number): string[] {
  const others = boxes.filter((b) => b.key !== key);
  const at = others.filter((b) => b.y + b.h / 2 < centerY).length;
  const keys = others.map((b) => b.key);
  keys.splice(at, 0, key);
  return keys;
}

/** `ids` with `id` moved to position `at` (clamped). */
export function moveTo<T>(ids: readonly T[], id: T, at: number): T[] {
  const out = ids.filter((x) => x !== id);
  out.splice(Math.max(0, Math.min(at, out.length)), 0, id);
  return out;
}

export interface GroupIds { key: string; ids: number[] }
/** The film's shot order (scenes in order, each scene's shots in order) after moving `shotId` to slot `slot` of scene `toKey`. */
export function orderAfterMove(groups: readonly GroupIds[], shotId: number, toKey: string, slot: number): number[] {
  return groups.flatMap((g) => {
    const ids = g.ids.filter((id) => id !== shotId);
    return g.key === toKey ? moveTo(ids, shotId, slot) : ids;
  });
}

/** Where a shot is: its scene's key and its slot there; null when it isn't in any. */
export function whereIs(groups: readonly GroupIds[], shotId: number): { key: string; slot: number } | null {
  for (const g of groups) {
    const i = g.ids.indexOf(shotId);
    if (i >= 0) return { key: g.key, slot: i };
  }
  return null;
}

// ── search ───────────────────────────────────────────────────────────────────

export interface Searchable { id: number; code: string; text: string }
/** Shots whose code or words contain every word of the query (case-insensitive), in film order. */
export function searchShots(items: readonly Searchable[], query: string): number[] {
  const words = query.toLowerCase().split(" ").map((w) => w.trim()).filter(Boolean);
  if (!words.length) return [];
  return items.filter((s) => {
    const hay = `${s.code} ${s.text}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).map((s) => s.id);
}

// ── undo ─────────────────────────────────────────────────────────────────────

/** One canvas edit that can be taken back: `undo` re-applies the state before it, `redo` the edit again. */
export interface UndoEntry { label: string; undo: () => unknown; redo?: () => unknown }
export interface UndoStack {
  push(e: UndoEntry): void;
  /** Takes the newest edit off the stack (it moves to the redo list); undefined when there is none. */
  takeUndo(): UndoEntry | undefined;
  /** Takes the newest undone edit back (it returns to the undo list); undefined when there is none. */
  takeRedo(): UndoEntry | undefined;
  readonly size: number;
  readonly redoSize: number;
  peek(): UndoEntry | undefined;
  clear(): void;
  subscribe(fn: () => void): () => void;
}

/** A small local undo stack: the newest `limit` edits; a new edit clears what was undone. */
export function createUndoStack(limit = 50): UndoStack {
  let done: UndoEntry[] = [];
  let undone: UndoEntry[] = [];
  const subs = new Set<() => void>();
  const changed = () => subs.forEach((f) => f());
  return {
    push(e) {
      done.push(e);
      if (done.length > limit) done = done.slice(done.length - limit);
      undone = [];
      changed();
    },
    takeUndo() {
      const e = done.pop();
      if (e) { if (e.redo) undone.push(e); changed(); }
      return e;
    },
    takeRedo() {
      const e = undone.pop();
      if (e) { done.push(e); changed(); }
      return e;
    },
    get size() { return done.length; },
    get redoSize() { return undone.length; },
    peek: () => done[done.length - 1],
    clear() { done = []; undone = []; changed(); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

// ── saved camera ─────────────────────────────────────────────────────────────

export interface Viewport { x: number; y: number; zoom: number }
export const viewKey = (eid: number) => `tatvam:canvas-view:${eid}`;
export const collapsedKey = (eid: number) => `tatvam:canvas-collapsed:${eid}`;

/** A saved viewport, or null when it is missing or not a viewport. */
export function parseViewport(raw: string | null): Viewport | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    const ok = v && [v.x, v.y, v.zoom].every((n) => typeof n === "number" && Number.isFinite(n)) && v.zoom > 0;
    return ok ? { x: v.x, y: v.y, zoom: v.zoom } : null;
  } catch { return null; }
}
