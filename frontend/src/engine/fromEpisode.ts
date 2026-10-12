/**
 * Episode (+ its layers) → Composition for the studio preview: the same timing as timeline/shared.ts layoutClips()
 * (trims, speed, transitions overlapping the previous shot, holds) and backend assembler.timeline().
 * The source of a shot is its lip-sync, else voice lock, else video take; a shot without video shows its keyframe
 * still with the default push-in.
 */
import type { Episode, Shot } from "../lib/types";
import type { LayersDoc } from "../pages/project/production/timeline/Layers";
import { compDuration } from "./timeline.ts";
import type { Clip, Composition, ShotFx, Track } from "./types.ts";

export interface EpisodeOptions {
  /** Output size; without both, `aspect` at `height` short side (backend ffmpeg.dims_for). */
  width?: number; height?: number; aspect?: string;
  lang?: string; fps?: number;
  /** Freezes from the timeline's "hold" trim mode (default on, like the timeline; the export closes them). */
  holds?: boolean;
  /** false = plain cut: no transitions, looks, moves or layers (the render's "effects" switch). */
  effects?: boolean;
  /** Composition.pixelScale: preview size / export size. */
  pixelScale?: number;
  /** A look's .cube URL (default: /api/fx/looks/<look>.cube, team LUTs from /media). */
  lutUrl?: (look: string) => string | null;
}

/** Even pixel dims for an aspect at a given short side (backend ffmpeg.dims_for). */
export function dimsFor(aspect: string, short = 1080): [number, number] {
  if (aspect === "9:16") return [short, Math.floor((short * 16) / 9 / 2) * 2];
  if (aspect === "1:1") return [short, short];
  return [Math.floor((short * 16) / 9 / 2) * 2, short];
}

export const defaultLutUrl = (look: string, projectId: number) =>
  look.startsWith("lut:") ? `/media/projects/${projectId}/luts/${encodeURIComponent(look.slice(4))}.cube` : `/api/fx/looks/${encodeURIComponent(look)}.cube`;

const MAX_HOLD = 10;
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** One main-track clip per included shot, laid out like layoutClips(). */
export function shotClips(shots: Shot[], opts: Pick<EpisodeOptions, "holds" | "effects"> & { holdMap?: Record<string, number> } = {}): Clip[] {
  const effects = opts.effects !== false;
  const holds = opts.holds !== false ? opts.holdMap ?? {} : {};
  let prevStart = 0, prevDur = 0, prevHold = 0;
  return shots.map((s, i) => {
    const v = s.lipsync || s.voicelock || s.video;
    const fx: ShotFx = effects ? { ...(s.fx ?? {}) } : {};
    const raw = v?.duration_s || s.duration_s;
    const ti = num(s.trim_in), to = num(s.trim_out);
    const speed = v ? num(fx.speed, 1) || 1 : 1;
    const duration = v ? Math.max(raw - ti - to, 0.5) / speed : s.duration_s;
    const tr = fx.transition;
    const overlap = i > 0 && tr ? Math.max(0.1, Math.min(num(tr.duration, 0.5), duration / 2, prevDur / 2)) : 0;
    const start = i === 0 ? 0 : prevStart + prevDur + prevHold - overlap;
    const hold = Math.max(0, Math.min(MAX_HOLD, num(holds[s.id])));
    prevStart = start; prevDur = duration; prevHold = hold;
    const move = fx.move && fx.move.kind !== "none" ? fx.move : undefined;
    const clip: Clip = {
      id: `shot-${s.id}`, label: s.code,
      media: { url: v?.url || s.keyframe?.url || "", kind: v ? "video" : "image", duration: v?.duration_s || undefined },
      start, duration: duration + hold, in: v ? ti : 0, speed, fit: "cover", fx,
    };
    if (hold) clip.hold = hold;
    if (v && fx.reverse) clip.reverse = true;
    if (move) clip.move = move;
    if (!v && !move) clip.kenburns = true;
    if (overlap && tr) clip.transitionIn = { type: tr.type, duration: overlap, params: tr.params, easing: tr.easing };
    return clip;
  });
}

/** Picture layers (hidden tracks skipped), bottom → top. */
export function layerTracks(layers: LayersDoc | null | undefined): Track[] {
  const out: Track[] = [];
  const media = new Map((layers?.media ?? []).map((m) => [m.src, m]));
  for (const tk of layers?.video ?? []) {
    if (tk.hidden) continue;
    const clips: Clip[] = tk.clips.filter((c) => c.kind === "video" || c.kind === "image").map((c) => {
      const m = media.get(c.src);
      const fx: ShotFx = {};
      if (c.fade_in > 0) fx.fade_in = c.fade_in;
      if (c.fade_out > 0) fx.fade_out = c.fade_out;
      return {
        id: `layer-${c.id}`, label: c.name,
        media: { url: c.url || m?.url || `/media/${c.src}`, kind: c.kind as "video" | "image", duration: m?.duration || undefined },
        start: c.start, duration: c.dur, in: c.kind === "video" ? num(c.in) : 0, speed: 1, fit: "contain" as const, fx,
        transform: { x: num(c.x, 0.5), y: num(c.y, 0.5), scale: num(c.scale, 0.35), opacity: num(c.opacity, 1), rotation: num(c.rotation),
          keyframes: c.keyframes?.length ? c.keyframes : undefined },
      };
    }).sort((a, b) => a.start - b.start);
    out.push({ id: `layer-${tk.id}`, kind: "layer", clips });
  }
  return out;
}

export function fromEpisode(episode: Episode, layers: LayersDoc | null | undefined, opts: EpisodeOptions = {}): Composition {
  const [width, height] = opts.width && opts.height ? [opts.width, opts.height] : dimsFor(opts.aspect ?? "16:9", opts.height ?? 1080);
  const shots = (episode.shots ?? []).filter((s) => s.include).sort((a, b) => a.order - b.order || a.id - b.id);
  const main = shotClips(shots, { holds: opts.holds, effects: opts.effects, holdMap: layers?.holds });
  const warnings: string[] = [];
  const lutUrls: Record<string, string> = {};
  for (const c of main) {
    if (!c.media.url) warnings.push(`${c.label}: no video or keyframe yet (black)`);
    const look = c.fx.look;
    if (look && look !== "none" && !lutUrls[look]) {
      const u = opts.lutUrl ? opts.lutUrl(look) : defaultLutUrl(look, episode.project_id);
      if (u) lutUrls[look] = u;
    }
  }
  const tracks: Track[] = [{ id: "main", kind: "main", clips: main }, ...(opts.effects === false ? [] : layerTracks(layers))];
  return { width, height, fps: opts.fps ?? 24, duration: compDuration(tracks), tracks, lutUrls, pixelScale: opts.pixelScale, warnings };
}
