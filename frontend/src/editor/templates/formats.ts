/**
 * Delivery formats (docs/EDITOR.md §10, multi-format export): 16:9, 9:16, 1:1 and 4:5, each with its safe area (the
 * part a platform doesn't cover with its own buttons and captions), and auto-reframe: a copy of a sequence in another
 * aspect where every picture fills the frame and follows the faces in it (engine trackFaces → smoothed position
 * keyframes), or stays centred when there are none. Titles keep their place as fractions of the frame, scaled to fit,
 * and are pulled inside the safe area. Pure.
 */
import { uid } from "../model/ids.ts";
import { ctxOf, normalize, tracksOf } from "../model/ops.ts";
import { framesToSeconds } from "../model/time.ts";
import type { EditProject, Keyframe, MediaItem, Sequence, TimelineClip, TitleSpec } from "../model/types.ts";

export interface Format { id: "16:9" | "9:16" | "1:1" | "4:5"; label: string; w: number; h: number; hint: string }
export const FORMATS: Format[] = [
  { id: "16:9", label: "Landscape 16:9", w: 16, h: 9, hint: "YouTube, TV" },
  { id: "9:16", label: "Vertical 9:16", w: 9, h: 16, hint: "Reels, Shorts, TikTok" },
  { id: "1:1", label: "Square 1:1", w: 1, h: 1, hint: "Feed posts" },
  { id: "4:5", label: "Portrait 4:5", w: 4, h: 5, hint: "Instagram feed" },
];
export const formatById = (id: string) => FORMATS.find((f) => f.id === id);

/** Margins (fractions of the frame) a platform's own interface covers. */
export interface Safe { top: number; bottom: number; left: number; right: number }
export const SAFE_AREAS: Record<Format["id"], Safe> = {
  "16:9": { top: 0.05, bottom: 0.08, left: 0.05, right: 0.05 },
  "9:16": { top: 0.12, bottom: 0.22, left: 0.06, right: 0.16 },
  "1:1": { top: 0.06, bottom: 0.08, left: 0.06, right: 0.06 },
  "4:5": { top: 0.06, bottom: 0.12, left: 0.05, right: 0.05 },
};

/** The format a sequence already is (within 2 %), else null. */
export function formatOf(seq: { width: number; height: number }): Format | null {
  const a = seq.width / seq.height;
  return FORMATS.find((f) => Math.abs(f.w / f.h - a) / a < 0.02) ?? null;
}

/** Pixel size of a format for a sequence: the short side kept (1080p → 1080×1920 vertical, 4K → 2160×3840), even numbers. */
export function formatSize(seq: { width: number; height: number }, f: Format): { width: number; height: number } {
  const short = Math.min(seq.width, seq.height);
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return f.w >= f.h ? { width: even((short * f.w) / f.h), height: even(short) } : { width: even(short), height: even((short * f.h) / f.w) };
}

// ── face-following reframe ───────────────────────────────────────────────────

/** A face (or subject) the engine found: source seconds, and its box as fractions of the picture (x, y = top-left). */
export interface FaceSample { t: number; x: number; y: number; w: number; h: number }
export interface ReframeOptions {
  /** Seconds of the moving average. */ window?: number;
  /** The aim only moves when the subject is this far (fraction of the picture) from it. */ deadZone?: number;
  /** Seconds between keyframes. */ step?: number;
  /** Keyframes closer than this (fraction of the frame) to the line through their neighbours are dropped. */ tolerance?: number;
}

/**
 * Smoothed aim points (subject centres, fractions of the picture) from raw samples: the largest face per moment,
 * gaps held, a centred moving average, then a dead zone so small drifts don't move the frame.
 */
export function smoothAim(samples: FaceSample[], o: ReframeOptions = {}): { t: number; x: number; y: number }[] {
  const win = o.window ?? 1, dz = o.deadZone ?? 0.05;
  const byT = new Map<number, FaceSample>();
  for (const s of samples) {
    if (!(s.w > 0 && s.h > 0)) continue;
    const k = Math.round(s.t * 1000) / 1000;
    const have = byT.get(k);
    if (!have || s.w * s.h > have.w * have.h) byT.set(k, s);
  }
  const pts = [...byT.values()].sort((a, b) => a.t - b.t).map((s) => ({ t: s.t, x: s.x + s.w / 2, y: s.y + s.h * 0.42 }));
  if (!pts.length) return [];
  const avg = pts.map((p) => {
    const near = pts.filter((q) => Math.abs(q.t - p.t) <= win / 2);
    return { t: p.t, x: near.reduce((n, q) => n + q.x, 0) / near.length, y: near.reduce((n, q) => n + q.y, 0) / near.length };
  });
  const out: { t: number; x: number; y: number }[] = [];
  let ax = avg[0].x, ay = avg[0].y;
  for (const p of avg) {
    if (Math.abs(p.x - ax) > dz) ax = p.x - Math.sign(p.x - ax) * dz;
    if (Math.abs(p.y - ay) > dz) ay = p.y - Math.sign(p.y - ay) * dz;
    out.push({ t: p.t, x: ax, y: ay });
  }
  return out;
}

/** Drops points that lie (within tol) on the line between their neighbours. */
function simplify<T extends { t: number; v: [number, number] }>(pts: T[], tol: number): T[] {
  if (pts.length <= 2) return pts;
  const keep = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = keep[keep.length - 1], b = pts[i], c = pts[i + 1];
    const k = (b.t - a.t) / Math.max(1e-9, c.t - a.t);
    const ex = a.v[0] + (c.v[0] - a.v[0]) * k, ey = a.v[1] + (c.v[1] - a.v[1]) * k;
    if (Math.abs(ex - b.v[0]) > tol || Math.abs(ey - b.v[1]) > tol) keep.push(b);
  }
  keep.push(pts[pts.length - 1]);
  return keep;
}

export interface ReframeClip {
  /** The picture's size (pixels) and where the clip starts in it (source seconds), its speed and length (timeline frames). */
  picW: number; picH: number; srcIn: number; speed: number; frames: number; fps: number;
}

/**
 * Motion for a clip in a W×H frame that fills it (cover) and keeps the subject in frame: the scale (% of the fitted
 * size) and the position (pixels; keyframes at clip-relative frames, eased, clamped so no edge shows). Without
 * samples the picture is centred.
 */
export function reframeMotion(samples: FaceSample[], c: ReframeClip, W: number, H: number, o: ReframeOptions = {}):
  { scale: number; position: { value: [number, number]; keyframes?: Keyframe<[number, number]>[] } } {
  const fitK = Math.min(W / c.picW, H / c.picH), coverK = Math.max(W / c.picW, H / c.picH);
  const scale = Math.round((coverK / fitK) * 100 * 100) / 100;
  const dw = c.picW * coverK, dh = c.picH * coverK;
  const clampX = (x: number) => Math.max(W - dw / 2, Math.min(dw / 2, x));
  const clampY = (y: number) => Math.max(H - dh / 2, Math.min(dh / 2, y));
  const at = (fx: number, fy: number): [number, number] => [Math.round(clampX(W / 2 - (fx - 0.5) * dw) * 10) / 10, Math.round(clampY(H / 2 - (fy - 0.5) * dh) * 10) / 10];
  const centre: [number, number] = [W / 2, H / 2];
  const sp = c.speed > 0 ? c.speed : 1;
  const srcEnd = c.srcIn + framesToSeconds(c.frames, c.fps) * sp;
  const aim = smoothAim(samples.filter((s) => s.t >= c.srcIn - 0.5 && s.t <= srcEnd + 0.5), o);
  if (!aim.length) return { scale, position: { value: centre } };
  const step = o.step ?? 0.5;
  const raw: { t: number; frame: number; v: [number, number] }[] = [];
  const sample = (tSrc: number) => {
    // the aim at a source time: linear between the smoothed points, held at the ends
    if (tSrc <= aim[0].t) return aim[0];
    for (let i = 1; i < aim.length; i++) if (tSrc < aim[i].t) {
      const a = aim[i - 1], b = aim[i], k = (tSrc - a.t) / Math.max(1e-9, b.t - a.t);
      return { t: tSrc, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    return aim[aim.length - 1];
  };
  const lastFrame = Math.max(0, c.frames - 1);
  for (let f = 0; ; f = Math.min(lastFrame, f + Math.max(1, Math.round(step * c.fps)))) {
    const p = sample(c.srcIn + framesToSeconds(f, c.fps) * sp);
    raw.push({ t: f, frame: f, v: at(p.x, p.y) });
    if (f >= lastFrame) break;
  }
  const tol = (o.tolerance ?? 0.01) * Math.max(W, H);
  const kept = simplify(raw, tol);
  const first = kept[0].v;
  if (kept.every((k) => Math.abs(k.v[0] - first[0]) < 0.5 && Math.abs(k.v[1] - first[1]) < 0.5)) return { scale, position: { value: first } };
  return { scale, position: { value: first, keyframes: kept.map((k) => ({ frame: k.frame, value: k.v, ease: "ease_in_out" as const })) } };
}

// ── titles and the safe area ─────────────────────────────────────────────────

/** A title box pulled inside the safe area (and shrunk when it's bigger than it). */
export function fitBox(box: TitleSpec["box"], safe: Safe): TitleSpec["box"] {
  const [x, y, w, h] = box;
  const sw = 1 - safe.left - safe.right, sh = 1 - safe.top - safe.bottom;
  const nw = Math.min(w, sw), nh = Math.min(h, sh);
  const nx = Math.max(safe.left, Math.min(1 - safe.right - nw, x + (w - nw) / 2));
  const ny = Math.max(safe.top, Math.min(1 - safe.bottom - nh, y + (h - nh) / 2));
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return [r(nx), r(ny), r(nw), r(nh)];
}

export const boxInside = (box: TitleSpec["box"], safe: Safe) => {
  const [x, y, w, h] = box;
  const e = 1e-4;
  return x >= safe.left - e && y >= safe.top - e && x + w <= 1 - safe.right + e && y + h <= 1 - safe.bottom + e;
};

/** Title clips of a sequence whose box leaves the format's safe area. */
export function safeAreaIssues(seq: Sequence, f: Format): { clipId: string; name: string; box: TitleSpec["box"] }[] {
  const safe = SAFE_AREAS[f.id];
  const video = new Set(tracksOf(seq, "video").map((t) => t.id));
  return seq.clips.filter((c) => video.has(c.trackId) && c.enabled && c.source.type === "title" && !boxInside(c.source.text.box, safe))
    .map((c) => ({ clipId: c.id, name: c.name, box: (c.source as { text: TitleSpec }).text.box }));
}

export interface ReframeResult { sequence: Sequence; reframed: number; followed: number; titlesMoved: number }

/**
 * A copy of a sequence in another format (fresh ids; nothing else in the project changes): media and nested clips
 * fill the frame and follow `faces[clipId]` (source-time samples), title text scales with the frame's width and its
 * boxes move inside the safe area when `fitTitles`, everything else is kept. Keyframed motion on a clip is kept as it
 * is (not reframed).
 */
export function reframeSequence(project: EditProject, seqId: string, f: Format, faces: Record<string, FaceSample[]> = {}, opts: { fitTitles?: boolean; name?: string } = {}): ReframeResult {
  const s = project.sequences.find((x) => x.id === seqId);
  if (!s) throw new Error(`No sequence ${seqId}`);
  const { width: W, height: H } = formatSize(s, f);
  const ctx = ctxOf(project);
  const tid = new Map(s.tracks.map((t) => [t.id, uid(t.kind === "video" ? "v" : "a")]));
  const cid = new Map(s.clips.map((c) => [c.id, uid("c")]));
  const lid = new Map<string, string>();
  const safe = SAFE_AREAS[f.id];
  const textK = Math.min(W / s.width, H / s.height);
  let reframed = 0, followed = 0, titlesMoved = 0;
  const videoTracks = new Set(tracksOf(s, "video").map((t) => t.id));
  const clips: TimelineClip[] = s.clips.map((c) => {
    const x: TimelineClip = { ...c, id: cid.get(c.id)!, trackId: tid.get(c.trackId)!, effects: c.effects.map((e) => ({ ...e, id: e.id.startsWith("mood:") ? `${e.id.split(":").slice(0, 2).join(":")}:${uid("e")}` : uid("e") })) };
    if (c.linkId) x.linkId = lid.get(c.linkId) ?? (lid.set(c.linkId, uid("l")), lid.get(c.linkId)!);
    const isVideo = videoTracks.has(c.trackId);
    const m = c.motion;
    if (isVideo && c.source.type === "title") {
      const text: TitleSpec = { ...c.source.text, size: Math.round(c.source.text.size * textK * 10) / 10 };
      if (text.look?.sub) text.look = { ...text.look, sub: { ...text.look.sub, size: Math.round(text.look.sub.size * textK * 10) / 10 } };
      if (opts.fitTitles && !boxInside(text.box, safe)) { text.box = fitBox(text.box, safe); titlesMoved++; }
      x.source = { type: "title", text };
      x.motion = { ...m, position: { value: [W / 2, H / 2] }, anchor: { value: [W / 2, H / 2] } };
      if (m.position.keyframes?.length) x.motion.position = { ...m.position, value: [m.position.value[0] * (W / s.width), m.position.value[1] * (H / s.height)],
        keyframes: m.position.keyframes.map((k) => ({ ...k, value: [k.value[0] * (W / s.width), k.value[1] * (H / s.height)] as [number, number] })) };
      return x;
    }
    if (!isVideo || (c.source.type !== "media" && c.source.type !== "nested")) {
      if (isVideo) x.motion = { ...m, position: { value: [W / 2, H / 2] }, anchor: { value: [W / 2, H / 2] } };
      return x;
    }
    let pic: { w: number; h: number } | null = null, srcIn = 0, fps = s.fps;
    if (c.source.type === "media") {
      const md: MediaItem | undefined = ctx.media(c.source.mediaId);
      if (md && md.width > 0 && md.height > 0) { pic = { w: md.width, h: md.height }; fps = md.fps > 0 ? md.fps : s.fps; srcIn = framesToSeconds(c.source.in, fps); }
    } else {
      const ns = ctx.sequence(c.source.sequenceId);
      if (ns) { pic = { w: ns.width, h: ns.height }; srcIn = framesToSeconds(c.source.in, ns.fps); }
    }
    if (!pic) return x;
    const moved = !!(m.position.keyframes?.length || m.scale.keyframes?.length);
    if (moved) {
      // its own animation stays, re-centred on the new frame
      const dx = W / 2 - s.width / 2, dy = H / 2 - s.height / 2;
      x.motion = { ...m, position: { ...m.position, value: [m.position.value[0] + dx, m.position.value[1] + dy], keyframes: m.position.keyframes?.map((k) => ({ ...k, value: [k.value[0] + dx, k.value[1] + dy] as [number, number] })) } };
      return x;
    }
    const fm = reframeMotion(faces[c.id] ?? [], { picW: pic.w, picH: pic.h, srcIn, speed: c.speed, frames: c.duration, fps: s.fps }, W, H);
    reframed++;
    if (fm.position.keyframes?.length || (faces[c.id]?.length ?? 0) > 0) followed++;
    const userScale = m.scale.value / 100;
    x.motion = { ...m, scale: { value: Math.round(fm.scale * userScale * 100) / 100 }, position: fm.position, anchor: { value: [pic.w / 2, pic.h / 2] } };
    return x;
  });
  const out: Sequence = {
    ...s, id: uid("s"), name: opts.name ?? `${s.name} · ${f.id}`, width: W, height: H,
    tracks: s.tracks.map((t) => ({ ...t, id: tid.get(t.id)! })),
    clips,
    transitions: s.transitions.map((t) => {
      const x = { ...t, id: uid("t"), trackId: tid.get(t.trackId)!, fromClipId: t.fromClipId ? cid.get(t.fromClipId) : undefined, toClipId: t.toClipId ? cid.get(t.toClipId) : undefined };
      if (!x.fromClipId) delete x.fromClipId;
      if (!x.toClipId) delete x.toClipId;
      return x;
    }),
    markers: s.markers.map((m) => ({ ...m, id: uid("m") })),
  };
  return { sequence: normalize(out, ctx), reframed, followed, titlesMoved };
}
