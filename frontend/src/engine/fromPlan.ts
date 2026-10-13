/**
 * Desktop render plan (GET /episodes/{eid}/render-plan, docs/DESKTOP.md §2.4) → Composition. The plan already holds
 * the server's timing (assembler.timeline: start, seg_len, clamped transitions), so this only maps fields. Media
 * references are storage keys; `urlForKey` turns them into URLs the page can load.
 */
import { compDuration } from "./timeline.ts";
import type { Clip, Composition, Easing, Keyframe, ShotFx, Track, TransitionParam } from "./types.ts";

export interface PlanTransition { type: string; duration: number; params?: Record<string, TransitionParam>; easing?: Easing }
export interface PlanSegment {
  shot_id: number; code?: string; source: string; source_kind: "lipsync" | "voicelock" | "video" | "still" | string;
  duration: number; trim_in: number; speed: number; seg_len: number; start: number;
  transition: [string, number] | null; center?: [number, number] | null; kenburns?: boolean;
  /** The shot's cleaned fx (backend fx.clean). */
  fx?: ShotFx;
  /** The transition for the GPU (xfade ids and gl: types, duration already clamped); for gl: types `transition` is
   *  the FFmpeg fallback ["fade", d]. null = a cut. */
  gpu_transition?: PlanTransition | null;
}
export interface PlanPic {
  key: string; kind: "video" | "image"; start: number; in?: number; dur: number;
  /** The layer clip's own values (`x` / `y` beside it are FFmpeg overlay expressions). */
  raw?: { id?: string; track?: string; x?: number; y?: number; scale?: number; opacity?: number; rotation?: number; keyframes?: Keyframe[];
    fade_in?: number; fade_out?: number; gain_db?: number };
  x?: number | string; y?: number | string;
}
export interface RenderPlan {
  w: number; h: number; fps: number; duration_s?: number; project_id?: number;
  segments: PlanSegment[];
  end_card?: { key: string; seconds: number; transition: [string, number] | null } | null;
  layers?: { pics?: PlanPic[] };
  /** LUT id → storage key (only the LUTs in use). */
  luts?: Record<string, string>;
  /** What only the GPU draws, e.g. ["chroma", "gl:cube"]. */
  gpu_only?: string[];
}

export interface PlanOptions {
  /** A preset look's .cube URL (default /api/fx/looks/<look>.cube). */
  lookUrl?: (look: string) => string | null;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function fromPlan(plan: RenderPlan, urlForKey: (key: string) => string, opts: PlanOptions = {}): Composition {
  const warnings: string[] = [];
  const lutUrls: Record<string, string> = {};
  const fps = num(plan.fps, 24) || 24;
  if (plan.segments.length && plan.segments.every((s) => s.fx === undefined))
    warnings.push("This render plan has no per-segment fx: looks, adjustments and GPU effects are left out");
  const main: Clip[] = plan.segments.map((s, i) => {
    const still = s.source_kind === "still";
    const fx: ShotFx = { ...(s.fx ?? {}) };
    const clip: Clip = {
      id: `seg-${i}-${s.shot_id}`, label: s.code,
      media: { url: s.source ? urlForKey(s.source) : "", kind: still ? "image" : "video" },
      start: num(s.start), duration: num(s.seg_len), in: still ? 0 : num(s.trim_in), speed: still ? 1 : num(s.speed, 1) || 1,
      fit: "cover", fx,
    };
    if (!still && fx.reverse) clip.reverse = true;
    if (s.center) clip.center = [s.center[0], s.center[1]];
    if (fx.move && fx.move.kind !== "none") clip.move = fx.move;
    else if (still && s.kenburns !== false) clip.kenburns = true;
    const gt = s.gpu_transition;
    if (i > 0 && gt) clip.transitionIn = { type: gt.type, duration: num(gt.duration), params: gt.params, easing: gt.easing };
    else if (i > 0 && s.transition && gt === undefined)  // a plan from before the GPU fields
      clip.transitionIn = { type: s.transition[0], duration: num(s.transition[1]), params: fx.transition?.params, easing: fx.transition?.easing };
    const look = fx.look;
    if (look && !lutUrls[look]) {
      if (look.startsWith("lut:")) {
        const key = plan.luts?.[look.slice(4)];
        if (key) lutUrls[look] = urlForKey(key); else warnings.push(`${s.code ?? s.shot_id}: LUT ${look.slice(4)} is missing`);
      } else {
        const u = opts.lookUrl ? opts.lookUrl(look) : `/api/fx/looks/${encodeURIComponent(look)}.cube`;
        if (u) lutUrls[look] = u;
      }
    }
    return clip;
  });
  const last = main[main.length - 1];
  const ec = plan.end_card;
  if (ec?.key && last) {
    const total = last.start + last.duration;
    const tr = ec.transition;
    const d = tr ? Math.max(0.1, Math.min(num(tr[1]), ec.seconds / 2, total / 2)) : 0;  // ffmpeg.xfade_concat's clamp
    main.push({ id: "end-card", label: "End card", media: { url: urlForKey(ec.key), kind: "image" }, start: total - d, duration: ec.seconds,
      in: 0, speed: 1, fit: "cover", fx: {}, transitionIn: tr ? { type: tr[0], duration: d } : undefined });
  }
  const pics = plan.layers?.pics ?? [];
  const tracks: Track[] = [{ id: "main", kind: "main", clips: main }];
  if (pics.some((p) => !p.raw)) warnings.push("This render plan's layers have no raw values: they're drawn at the default place and size");
  // the plan lists pictures bottom → top (track by track); clips of one layer track share a track
  const byTrack = new Map<string, Track>();
  pics.forEach((p, i) => {
    const r = p.raw ?? {};
    const tid = r.track ? `layer-${r.track}` : `pic-${i}`;
    let tk = byTrack.get(tid);
    if (!tk) { tk = { id: tid, kind: "layer", clips: [] }; byTrack.set(tid, tk); tracks.push(tk); }
    const fx: ShotFx = {};
    if (num(r.fade_in) > 0) fx.fade_in = r.fade_in;
    if (num(r.fade_out) > 0) fx.fade_out = r.fade_out;
    tk.clips.push({
      id: r.id ? `layer-${r.id}` : `pic-${i}`, media: { url: urlForKey(p.key), kind: p.kind }, start: num(p.start), duration: num(p.dur),
      in: p.kind === "video" ? num(p.in) : 0, speed: 1, fit: "contain", fx,
      transform: { x: num(r.x, 0.5), y: num(r.y, 0.5), scale: num(r.scale, 0.35), opacity: num(r.opacity, 1), rotation: num(r.rotation),
        keyframes: r.keyframes?.length ? r.keyframes : undefined },
    });
  });
  const duration = num(plan.duration_s) || compDuration(tracks);
  return { width: plan.w, height: plan.h, fps, duration, tracks, lutUrls, warnings };
}
