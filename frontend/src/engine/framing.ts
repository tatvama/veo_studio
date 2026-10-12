/**
 * Framing maths as texture-coordinate transforms (image space: x right, y down, 0..1). One affine map per clip per
 * frame takes an output pixel to the source: cover crop with centre aim (ffmpeg.fit_filter), then the camera
 * (fx.move_filter's zoompan, or still_vf's default push-in), then the flips (applied after the move, as in FFmpeg).
 */
import type { Clip, KfKey } from "./types.ts";
import type { MotionState } from "./timeline.ts";

/** src = uv · s + o, per axis. */
export interface UvXform { sx: number; sy: number; ox: number; oy: number }

/** The part of the source a cover fit shows, in source units: offset and size (one of fw / fh is 1). */
export function coverRect(sw: number, sh: number, w: number, h: number, center?: [number, number] | null) {
  if (!(sw > 0 && sh > 0 && w > 0 && h > 0)) return { x0: 0, y0: 0, fw: 1, fh: 1 };
  const s = Math.max(w / sw, h / sh);
  const fw = Math.min(1, w / (sw * s)), fh = Math.min(1, h / (sh * s));
  const aim = (c: number | undefined, f: number) => (c === undefined ? (1 - f) / 2 : Math.max(0, Math.min(1 - f, c - f / 2)));
  return { x0: aim(center?.[0], fw), y0: aim(center?.[1], fh), fw, fh };
}

/** Contain: the source fits inside the frame; returns the source rect in frame units (letterbox outside it). */
export function containRect(sw: number, sh: number, w: number, h: number) {
  if (!(sw > 0 && sh > 0 && w > 0 && h > 0)) return { x0: 0, y0: 0, fw: 1, fh: 1 };
  const s = Math.min(w / sw, h / sh);
  const fw = (sw * s) / w, fh = (sh * s) / h;
  return { x0: (1 - fw) / 2, y0: (1 - fh) / 2, fw, fh };
}

/** Still push-in: zoompan z = min(zoom + 0.0009, 1.12) per output frame, centred. */
export const KENBURNS_STEP = 0.0009;
export const KENBURNS_MAX = 1.12;

/** The camera window at `local` seconds into the clip: zoom z and top-left offset (framed = o + uv / z). */
export function cameraAt(clip: Pick<Clip, "move" | "kenburns" | "duration" | "hold">, local: number, fps: number) {
  const frame = Math.max(0, local) * fps;
  const mv = clip.move;
  if (mv && mv.kind !== "none") {
    const a = Math.max(0, mv.amount);
    const n = Math.max(Math.floor((clip.duration - (clip.hold ?? 0)) * fps + 1e-6), 1);
    const p = Math.min(frame / n, 1);
    let z = 1 + a, ox: number, oy: number;
    if (mv.kind === "zoom_in") z = 1 + a * p;
    else if (mv.kind === "zoom_out") z = 1 + a - a * p;
    const c = 0.5 - 0.5 / z, span = 1 - 1 / z;
    ox = mv.kind === "pan_left" ? span * (1 - p) : mv.kind === "pan_right" ? span * p : c;
    oy = mv.kind === "pan_up" ? span * (1 - p) : mv.kind === "pan_down" ? span * p : c;
    return { z, ox, oy };
  }
  if (clip.kenburns) {
    const z = Math.min(1 + KENBURNS_STEP * frame, KENBURNS_MAX);
    return { z, ox: 0.5 - 0.5 / z, oy: 0.5 - 0.5 / z };
  }
  return { z: 1, ox: 0, oy: 0 };
}

/**
 * The whole map for a clip drawn into a w×h target: source size sw×sh. `contain` leaves the outside of the picture
 * out of range (the shader draws it transparent).
 */
export function clipUv(clip: Pick<Clip, "fit" | "center" | "move" | "kenburns" | "duration" | "hold" | "fx">, sw: number, sh: number,
  w: number, h: number, local: number, fps: number): UvXform {
  const cam = cameraAt(clip, local, fps);
  const fh = !!clip.fx?.flip_h, fv = !!clip.fx?.flip_v;
  let x0: number, y0: number, sxs: number, sys: number;
  if (clip.fit === "fill") {
    x0 = 0; y0 = 0; sxs = 1; sys = 1;
  } else if (clip.fit === "contain") {
    const r = containRect(sw, sh, w, h);  // framed uv → source: (uv - x0) / fw
    x0 = -r.x0 / r.fw; y0 = -r.y0 / r.fh; sxs = 1 / r.fw; sys = 1 / r.fh;
  } else {
    const r = coverRect(sw, sh, w, h, clip.center);
    x0 = r.x0; y0 = r.y0; sxs = r.fw; sys = r.fh;
  }
  // src = x0 + sxs · (cam.o + flip(uv) / z)
  const kx = sxs / cam.z, ky = sys / cam.z;
  return {
    sx: fh ? -kx : kx, sy: fv ? -ky : ky,
    ox: x0 + sxs * cam.ox + (fh ? kx : 0), oy: y0 + sys * cam.oy + (fv ? ky : 0),
  };
}

/** Source pixels per output pixel (mipmaps help above ~1.5). */
export const minification = (uv: UvXform, sw: number, sh: number, w: number, h: number) =>
  Math.max((Math.abs(uv.sx) * sw) / w, (Math.abs(uv.sy) * sh) / h);

/** Where a layer picture sits (layers.py pic_chain): centre (x·W, y·H), width scale·W (even), height by its aspect,
 *  turned `rotation` degrees clockwise about its centre. Pixels, y down. */
export function layerRect(s: Record<KfKey, number>, W: number, H: number, aspect: number) {
  const w = Math.max(2, Math.round((W * s.scale) / 2) * 2);
  return { cx: W * s.x, cy: H * s.y, w, h: Math.max(2, w * aspect), rot: (s.rotation * Math.PI) / 180 };
}

/** The picture's size when it fits the frame (motion scale 100 %): contain fits inside, cover fills, fill stretches. */
export function fittedSize(pw: number, ph: number, W: number, H: number, fit: Clip["fit"]): [number, number] {
  if (!(pw > 0 && ph > 0)) return [W, H];
  if (fit === "fill") return [W, H];
  const k = fit === "cover" ? Math.max(W / pw, H / ph) : Math.min(W / pw, H / ph);
  return [pw * k, ph * k];
}

/**
 * Where a clip with motion sits (Premiere's Motion): the picture (pw×ph of its own pixels), fitted to the W×H frame
 * and scaled, has its anchor point (picture pixels, default the centre) at `position` (frame pixels, default the
 * centre), turned about it. Returns the picture's centre, size and angle (radians, clockwise) in frame pixels.
 * `unit` converts composition pixels to the render's (a half-size preview passes 0.5).
 */
export function motionRect(m: MotionState, pw: number, ph: number, W: number, H: number, fit: Clip["fit"], unit = 1) {
  const [fw, fh] = fittedSize(pw, ph, W, H, fit);
  const s = m.scale / 100;
  const w = fw * s, h = fh * s;
  const kx = pw > 0 ? w / pw : 1, ky = ph > 0 ? h / ph : 1;  // render pixels per picture pixel
  const pos = m.position ? [m.position[0] * unit, m.position[1] * unit] : [W / 2, H / 2];
  const anc = m.anchor ?? [pw / 2, ph / 2];
  const ax = (pw / 2 - anc[0]) * kx, ay = (ph / 2 - anc[1]) * ky;  // centre relative to the anchor, before turning
  const r = (m.rotation * Math.PI) / 180, c = Math.cos(r), n = Math.sin(r);
  return { cx: pos[0] + ax * c - ay * n, cy: pos[1] + ax * n + ay * c, w, h, rot: r };
}
