/**
 * Timing and animation maths of the News Room renderer (docs/EDITOR.md §16.3), as pure functions of time: easing by
 * the look's motion, a layer's in / out phases inside the template's timing, the pose an in / out step gives a layer
 * (offset, scale, opacity, a reveal rectangle, blur, a light sweep), per-part staggers snapped to frames, and loops
 * (blink, pulse, shine, float, spin, breathe, flash). No canvas here, so it is Node-testable.
 */
import type { AnimDir, AnimStep, Box, ChannelLook, GfxLayer, GfxTemplate, LoopSpec } from "../types.ts";

export const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

// ── easing ───────────────────────────────────────────────────────────────────

const outCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const inCubic = (x: number) => x * x * x;
const outQuint = (x: number) => 1 - Math.pow(1 - x, 5);
const inQuint = (x: number) => x * x * x * x * x;
const inOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const outBack = (x: number, s = 1.45) => { const t = x - 1; return 1 + (s + 1) * t * t * t + s * t * t; };
const inBack = (x: number, s = 1.45) => (s + 1) * x * x * x - s * x * x;
const outExpo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const outElastic = (x: number) => (x === 0 || x === 1 ? x : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
const outBounce = (x: number) => {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) { x -= 1.5 / d; return n * x * x + 0.75; }
  if (x < 2.5 / d) { x -= 2.25 / d; return n * x * x + 0.9375; }
  x -= 2.625 / d; return n * x * x + 0.984375;
};

export const EASES: Record<string, (x: number) => number> = {
  linear: (x) => x, ease_in: inCubic, ease_out: outCubic, ease_in_out: inOutCubic, back: (x) => outBack(x),
  elastic: outElastic, bounce: outBounce, expo: outExpo,
  in_quint: inQuint, out_quint: outQuint, in_back: (x) => inBack(x),
};

/**
 * An ease by name; "look" (or none) follows the look's motion: sharp = cubic, smooth = quint, bouncy = a little
 * overshoot. `leaving` picks the accelerating twin (out phases).
 */
export function easeFn(kind: string | undefined, motion: ChannelLook["motion"], leaving = false): (x: number) => number {
  if (kind && kind !== "look" && EASES[kind]) return EASES[kind];
  if (motion === "smooth") return leaving ? inCubic : outQuint;
  if (motion === "bouncy") return leaving ? (x) => inBack(x, 1.2) : (x) => outBack(x, 1.7);
  return leaving ? inCubic : outCubic;
}

// ── phases ───────────────────────────────────────────────────────────────────

/** A layer's step, placed in clip seconds. */
export interface PlacedStep { step: AnimStep; start: number; dur: number }
export interface LayerTiming {
  in?: PlacedStep; out?: PlacedStep;
  /** Seconds when the layer is fully in (loops start here). */
  shownAt: number;
  /** Seconds when its out step starts (Infinity: never leaves). */
  leaveAt: number;
}

/** The template's phases for a clip of `dur` seconds: in [0, inLen], out [outStart, dur]; both shrink on short clips. */
export function phasesOf(t: Pick<GfxTemplate, "timing" | "loop">, dur: number): { inLen: number; outStart: number; k: number } {
  const ti = Math.max(0, t.timing?.in ?? 0.6), to = Math.max(0, t.timing?.out ?? 0.4);
  const k = ti + to > dur && ti + to > 0 ? Math.max(0, dur) / (ti + to) : 1;
  return { inLen: ti * k, outStart: dur - to * k, k };
}

const DEFAULT_IN = 0.5, DEFAULT_OUT = 0.35;

/** Where a layer's in and out steps sit in the clip (delays count from each phase start; short clips scale them). */
export function layerTiming(t: Pick<GfxTemplate, "timing" | "loop">, layer: Pick<GfxLayer, "anim">, dur: number): LayerTiming {
  const { inLen, outStart, k } = phasesOf(t, dur);
  const a = layer.anim;
  const res: LayerTiming = { shownAt: 0, leaveAt: Infinity };
  if (a?.in && a.in.kind !== "none") {
    const d = Math.max(1e-3, (a.in.dur ?? Math.max(DEFAULT_IN, inLen - (a.in.delay ?? 0))) * k);
    res.in = { step: a.in, start: (a.in.delay ?? 0) * k, dur: d };
    res.shownAt = res.in.start + d;
  }
  if (a?.out && a.out.kind !== "none") {
    const d = Math.max(1e-3, (a.out.dur ?? DEFAULT_OUT) * k);
    res.out = { step: a.out, start: outStart + (a.out.delay ?? 0) * k, dur: d };
    res.leaveAt = res.out.start;
  }
  return res;
}

/** Linear progress of a placed step at t (0 before, 1 after). */
export const stepProgress = (s: PlacedStep | undefined, t: number): number => (s ? clamp01((t - s.start) / s.dur) : 1);

/** True while t is inside a step (something moves). */
export const inStep = (s: PlacedStep | undefined, t: number) => !!s && t >= s.start && t <= s.start + s.dur;

// ── poses ────────────────────────────────────────────────────────────────────

/** What an animation does to a layer at one moment (design px; scales about the box centre unless `origin`). */
export interface Pose {
  dx: number; dy: number; sx: number; sy: number; alpha: number; rot: number;
  /** Reveal: the part of the box shown (fractions of the box: x0, y0, x1, y1). */
  reveal?: [number, number, number, number];
  /** Blur in design px. */
  blur: number;
  /** A light sweep across the layer at this position (0..1 across), or null. */
  sweep: number | null;
  /** Brightness multiplier (flash). */
  bright: number;
  /** Glow (breathe): blur radius in design px. */
  glow: number;
  /** Box change for kinds that resize instead of scale (grow, unfold on plates): fractions kept (w, h) and the
   *  anchor (0 left / top, 0.5 centre, 1 right / bottom). */
  size?: { w: number; h: number; ax: number; ay: number };
}
export const IDENTITY: Pose = { dx: 0, dy: 0, sx: 1, sy: 1, alpha: 1, rot: 0, blur: 0, sweep: null, bright: 1, glow: 0 };

const DIR: Record<AnimDir, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const OPP: Record<AnimDir, AnimDir> = { left: "right", right: "left", up: "down", down: "up" };

/** The step's direction; an out step without one goes back the way its in step came. */
export function dirOf(step: AnimStep, leaving: boolean, inStepDir?: AnimDir): AnimDir {
  if (step.dir) return step.dir;
  const k = step.kind;
  if (k === "rise") return "up";
  if (k === "drop") return "down";
  if (leaving && inStepDir) return OPP[inStepDir];
  return leaving ? "left" : "right";
}

/**
 * The pose of a step at eased amount `e` (1 = fully shown, 0 = fully away; may overshoot with bouncy eases). `box`
 * is the layer's box; `leaving` true for out steps. Directions are the way the layer travels.
 */
export function poseOf(step: AnimStep, e: number, box: Box, leaving: boolean, inDir?: AnimDir): Pose {
  const p: Pose = { ...IDENTITY };
  const r = 1 - e;  // how far away it still is
  const dir = dirOf(step, leaving, inDir);
  const [vx, vy] = DIR[dir];
  const ec = clamp01(e);
  switch (step.kind) {
    case "fade": p.alpha = ec; break;
    case "slide": {
      const dist = step.distance ?? (vx ? box[2] : box[3]);
      const s = leaving ? 1 : -1;  // in: comes from behind the direction; out: carries on in it
      p.dx = s * vx * dist * r; p.dy = s * vy * dist * r;
      p.alpha = clamp01(ec * 4);
      break;
    }
    case "rise": case "drop": {
      const dist = step.distance ?? Math.min(80, Math.max(24, box[3] * 0.5));
      const s = leaving ? 1 : -1;
      p.dy = s * vy * dist * r; p.dx = s * vx * dist * r;
      p.alpha = ec;
      break;
    }
    case "wipe": {
      // the edge travels in `dir`: in reveals from the far side, out hides from the near side
      const q = ec;
      if (!leaving) p.reveal = vx > 0 ? [0, 0, q, 1] : vx < 0 ? [1 - q, 0, 1, 1] : vy > 0 ? [0, 0, 1, q] : [0, 1 - q, 1, 1];
      else p.reveal = vx > 0 ? [1 - q, 0, 1, 1] : vx < 0 ? [0, 0, q, 1] : vy > 0 ? [0, 1 - q, 1, 1] : [0, 0, 1, q];
      break;
    }
    case "grow": {
      const q = Math.max(0, e);
      const horiz = vx !== 0;
      // the anchor is the edge it grows from (in) / shrinks towards (out)
      const a = horiz ? (leaving ? (vx > 0 ? 1 : 0) : (vx > 0 ? 0 : 1)) : (leaving ? (vy > 0 ? 1 : 0) : (vy > 0 ? 0 : 1));
      p.size = horiz ? { w: q, h: 1, ax: a, ay: 0.5 } : { w: 1, h: q, ax: 0.5, ay: a };
      p.alpha = clamp01(ec * 6);
      break;
    }
    case "unfold": {
      const q = Math.max(0, e);
      const w = clamp01(q * 2), h = q < 0.5 ? 0.06 : 0.06 + 0.94 * Math.min(1.2, (q - 0.5) * 2);
      p.size = { w: Math.max(0.001, w), h, ax: 0.5, ay: 0.5 };
      p.alpha = clamp01(ec * 5);
      break;
    }
    case "flip": {
      const s = Math.max(0.001, Math.sin((clamp01(e) * Math.PI) / 2) * (e > 1 ? e : 1));
      if (vx !== 0) p.sx = s; else p.sy = s;
      p.alpha = clamp01(ec * 3);
      p.bright = 0.6 + 0.4 * ec;
      break;
    }
    case "pop": { const s = 0.55 + 0.45 * e; p.sx = p.sy = Math.max(0.01, s); p.alpha = clamp01(ec * 2.5); break; }
    case "zoom": { const s = 1 + 0.25 * r; p.sx = p.sy = Math.max(0.01, s); p.alpha = ec; break; }
    case "blur": p.blur = 24 * clamp01(r); p.alpha = ec; break;
    case "sweep": p.alpha = clamp01(ec * 2); p.sweep = leaving ? 1 - ec : ec; break;
    case "typewriter": case "stagger": p.alpha = 1; break;  // parts animate themselves (text kinds)
    case "none": break;
    default: p.alpha = ec;  // unknown kinds fade
  }
  return p;
}

/** Combines two poses (an in or out pose with a loop pose). */
export function combine(a: Pose, b: Pose): Pose {
  return {
    dx: a.dx + b.dx, dy: a.dy + b.dy, sx: a.sx * b.sx, sy: a.sy * b.sy, alpha: a.alpha * b.alpha, rot: a.rot + b.rot,
    reveal: a.reveal && b.reveal ? [Math.max(a.reveal[0], b.reveal[0]), Math.max(a.reveal[1], b.reveal[1]), Math.min(a.reveal[2], b.reveal[2]), Math.min(a.reveal[3], b.reveal[3])] : a.reveal ?? b.reveal,
    blur: a.blur + b.blur, sweep: a.sweep ?? b.sweep, bright: a.bright * b.bright, glow: a.glow + b.glow,
    size: a.size && b.size ? { w: a.size.w * b.size.w, h: a.size.h * b.size.h, ax: a.size.ax, ay: a.size.ay } : a.size ?? b.size,
  };
}

// ── parts (stagger by line / word / item; typewriter) ────────────────────────

/** Steps that animate text in parts: the text kind draws them part by part (the core applies no transform). */
export const isPartStep = (s: AnimStep | undefined): boolean =>
  !!s && (s.kind === "typewriter" || s.kind === "stagger" || (!!s.by && s.by !== "all"));

/** Snaps seconds to whole frames (staggers and blinks repeat exactly in exports). */
export const snap = (t: number, fps: number) => (fps > 0 ? Math.round(t * fps) / fps : t);

/**
 * Progress (0..1, linear) of part i of n inside a step that has run `local` seconds of its `dur`. Parts start
 * `stagger` s apart (default: spread over half the step, 20–120 ms), each taking the rest; delays snap to frames.
 */
export function partProgress(step: AnimStep, local: number, dur: number, i: number, n: number, fps: number): number {
  if (n <= 1) return clamp01(local / dur);
  if (step.kind === "typewriter") {
    // one part after another, evenly over the step; each appears whole
    const at = snap((dur * i) / n, fps);
    return local >= at ? 1 : 0;
  }
  const s = step.stagger ?? Math.min(0.12, Math.max(0.02, (dur * 0.5) / (n - 1)));
  const pd = Math.max(0.15, dur - s * (n - 1));
  return clamp01((local - snap(s * i, fps)) / pd);
}

/** The pose of one part (a stagger's parts rise and fade unless the step says otherwise). */
export function partPose(step: AnimStep, e: number, box: Box, leaving: boolean): Pose {
  if (step.kind === "typewriter") return { ...IDENTITY, alpha: e > 0 ? 1 : 0 };
  const kind = step.kind === "stagger" ? (step.dir ? "slide" : "rise") : step.kind;
  return poseOf({ ...step, kind, distance: step.distance ?? (kind === "slide" ? Math.min(60, box[2] * 0.3) : undefined) }, e, box, leaving);
}

// ── loops ────────────────────────────────────────────────────────────────────

const SHINE_LEN = 0.9;

/** The pose a loop adds `s` seconds after the layer is shown (frame-snapped). */
export function loopPose(loop: LoopSpec, s: number, fps: number): Pose {
  const p: Pose = { ...IDENTITY };
  const t = snap(s - (loop.delay ?? 0), fps);
  if (t < 0) return p;
  const per = Math.max(0.05, loop.period || 1);
  const x = (t % per) / per;
  const amt = loop.amount;
  switch (loop.kind) {
    case "blink": p.alpha = x < 0.5 ? 1 : amt ?? 0.15; break;
    case "pulse": { const s1 = 1 + (amt ?? 0.06) * (0.5 - 0.5 * Math.cos(2 * Math.PI * x)); p.sx = p.sy = s1; break; }
    case "float": p.dy = Math.sin(2 * Math.PI * x) * (amt ?? 6); break;
    case "spin": p.rot = 360 * x * (amt ?? 1); break;
    case "breathe": { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * x); p.glow = (amt ?? 18) * w; p.alpha = 0.88 + 0.12 * w; break; }
    case "flash": { const q = x < 0.12 ? x / 0.12 : x < 0.5 ? 1 - (x - 0.12) / 0.38 : 0; p.bright = 1 + (amt ?? 0.6) * clamp01(q); break; }
    case "shine": { const w = t % per; if (w < SHINE_LEN) p.sweep = w / SHINE_LEN; break; }
  }
  return p;
}

/** True when a loop changes the picture at `s` seconds after shown (shine rests between sweeps). */
export function loopMoving(loop: LoopSpec, s: number, fps: number): boolean {
  const t = snap(s - (loop.delay ?? 0), fps);
  if (t < 0) return false;
  if (loop.kind === "shine") { const per = Math.max(0.05, loop.period || 1); return t % per <= SHINE_LEN + 1 / Math.max(1, fps); }
  return true;
}
