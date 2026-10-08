/**
 * Live preview of a shot's effects in the browser (CSS), mirroring backend/app/pipeline/fx.py.
 * The export uses FFmpeg; these are close approximations for instant feedback. "Exact preview" renders the real thing.
 */
import type { CSSProperties } from "react";

export interface ShotFx {
  transition?: { type: string; duration: number };
  look?: string;
  adjust?: Partial<Record<AdjustKey, number>>;
  speed?: number; reverse?: boolean; flip_h?: boolean; flip_v?: boolean; stabilize?: boolean;
  move?: { kind: MoveKind; amount: number };
  fade_in?: number; fade_out?: number;
}
export type AdjustKey = "exposure" | "contrast" | "saturation" | "temperature" | "tint" | "vibrance" | "gamma" | "hue"
  | "sharpen" | "blur" | "vignette" | "grain";
export type MoveKind = "none" | "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "pan_up" | "pan_down";
export interface FxCatalog {
  transitions: { group: string; items: { id: string; label: string }[] }[];
  looks: { id: string; label: string }[]; moves: MoveKind[]; adjust: AdjustKey[];
}

export const ADJUST_INFO: Record<AdjustKey, { label: string; min: number }> = {
  exposure: { label: "Exposure", min: -1 }, contrast: { label: "Contrast", min: -1 }, saturation: { label: "Saturation", min: -1 },
  temperature: { label: "Temperature", min: -1 }, tint: { label: "Tint", min: -1 }, vibrance: { label: "Vibrance", min: -1 },
  gamma: { label: "Midtones", min: -1 }, hue: { label: "Hue shift", min: -1 }, sharpen: { label: "Sharpen", min: 0 },
  blur: { label: "Blur", min: 0 }, vignette: { label: "Vignette", min: 0 }, grain: { label: "Film grain", min: 0 },
};

export const MOVE_LABELS: Record<MoveKind, string> = {
  none: "None", zoom_in: "Push in", zoom_out: "Pull out", pan_left: "Pan left", pan_right: "Pan right", pan_up: "Tilt up", pan_down: "Tilt down",
};

const LOOK_CSS: Record<string, string> = {
  cinematic: "contrast(1.12) saturate(0.92) hue-rotate(-4deg)",
  teal_orange: "contrast(1.1) saturate(1.15) hue-rotate(-8deg) sepia(0.08)",
  warm: "sepia(0.18) saturate(1.1)",
  golden_hour: "sepia(0.3) saturate(1.25) brightness(1.03) contrast(1.05)",
  cool: "saturate(0.95) hue-rotate(10deg)",
  moonlight: "brightness(0.9) saturate(0.7) hue-rotate(18deg) contrast(1.08)",
  vivid: "saturate(1.45) contrast(1.06)",
  pastel: "saturate(0.75) brightness(1.08) contrast(0.92)",
  vintage: "sepia(0.35) contrast(0.95) saturate(0.85)",
  faded_film: "contrast(0.85) brightness(1.05) saturate(0.85)",
  cross_process: "hue-rotate(-12deg) saturate(1.3) contrast(1.15)",
  bleach_bypass: "saturate(0.55) contrast(1.28)",
  high_contrast: "contrast(1.35)",
  matte: "contrast(0.88) brightness(1.04)",
  noir: "grayscale(1) contrast(1.35) brightness(0.97)",
  black_white: "grayscale(1)",
  sepia: "sepia(1)",
  negative: "invert(1)",
};

export const isLut = (look?: string) => !!look?.startsWith("lut:");

/** CSS `filter` for the look + adjustments (blur scaled to the preview size). */
export function fxFilter(fx: ShotFx | undefined, scale = 1): string {
  if (!fx) return "";
  const out: string[] = [];
  if (fx.look && LOOK_CSS[fx.look]) out.push(LOOK_CSS[fx.look]);
  const a = fx.adjust ?? {};
  if (a.exposure) out.push(`brightness(${(1 + a.exposure * 0.35).toFixed(3)})`);
  if (a.gamma) out.push(`brightness(${(1 + a.gamma * 0.12).toFixed(3)})`);
  if (a.contrast) out.push(`contrast(${(1 + a.contrast * 0.6).toFixed(3)})`);
  if (a.saturation) out.push(`saturate(${(1 + a.saturation).toFixed(3)})`);
  if (a.vibrance) out.push(`saturate(${(1 + a.vibrance * 0.4).toFixed(3)})`);
  if (a.temperature) out.push(a.temperature > 0 ? `sepia(${(a.temperature * 0.35).toFixed(3)})` : `hue-rotate(${(a.temperature * 14).toFixed(1)}deg) saturate(${(1 + a.temperature * 0.1).toFixed(3)})`);
  if (a.tint) out.push(`hue-rotate(${(-a.tint * 12).toFixed(1)}deg)`);
  if (a.hue) out.push(`hue-rotate(${(a.hue * 180).toFixed(1)}deg)`);
  if (a.sharpen) out.push(`contrast(${(1 + a.sharpen * 0.08).toFixed(3)})`);
  if (a.blur) out.push(`blur(${(a.blur * 4 * scale).toFixed(2)}px)`);
  return out.join(" ");
}

export function fxTransform(fx: ShotFx | undefined): string {
  return [fx?.flip_h ? "scaleX(-1)" : "", fx?.flip_v ? "scaleY(-1)" : ""].filter(Boolean).join(" ");
}

/** Keyframes for a camera move over the clip (Web Animations API). */
export function moveKeyframes(fx: ShotFx | undefined): Keyframe[] | null {
  const m = fx?.move;
  if (!m || m.kind === "none") return null;
  const z = 1 + m.amount;
  const k = (m.amount / 2) * 100 / z;
  switch (m.kind) {
    case "zoom_in": return [{ transform: "scale(1)" }, { transform: `scale(${z})` }];
    case "zoom_out": return [{ transform: `scale(${z})` }, { transform: "scale(1)" }];
    case "pan_left": return [{ transform: `scale(${z}) translateX(-${k}%)` }, { transform: `scale(${z}) translateX(${k}%)` }];
    case "pan_right": return [{ transform: `scale(${z}) translateX(${k}%)` }, { transform: `scale(${z}) translateX(-${k}%)` }];
    case "pan_up": return [{ transform: `scale(${z}) translateY(-${k}%)` }, { transform: `scale(${z}) translateY(${k}%)` }];
    case "pan_down": return [{ transform: `scale(${z}) translateY(${k}%)` }, { transform: `scale(${z}) translateY(-${k}%)` }];
    default: return null;
  }
}

/** Styles for the outgoing (a) and incoming (b) picture at progress p (0→1) of a transition; `bTop` false = a above b. */
export function transitionFrame(type: string, p: number): { a: CSSProperties; b: CSSProperties; bTop: boolean; bg?: string } {
  const q = Math.max(0, Math.min(1, p));
  const r = (1 - q) * 100;
  const pct = (n: number) => `${n.toFixed(2)}%`;
  const fadeB = { a: {}, b: { opacity: q }, bTop: true };
  switch (type) {
    case "fade": case "dissolve": case "distance": case "fadefast": case "fadeslow": return fadeB;
    case "hblur": case "pixelize": {
      const blur = `blur(${(Math.sin(q * Math.PI) * 6).toFixed(2)}px)`;
      return { a: { filter: blur }, b: { opacity: q, filter: blur }, bTop: true };
    }
    case "fadeblack": case "fadewhite": case "fadegrays":
      return { a: { opacity: q < 0.5 ? 1 - q * 2 : 0, filter: type === "fadegrays" ? `grayscale(${Math.min(q * 2, 1)})` : undefined },
        b: { opacity: q > 0.5 ? q * 2 - 1 : 0, filter: type === "fadegrays" ? `grayscale(${Math.max(1 - (q - 0.5) * 2, 0)})` : undefined },
        bTop: true, bg: type === "fadewhite" ? "#fff" : type === "fadegrays" ? "#777" : "#000" };
    case "wipeleft": case "smoothleft": case "hlslice": case "hlwind": return { a: {}, b: { clipPath: `inset(0 0 0 ${pct(r)})` }, bTop: true };
    case "wiperight": case "smoothright": case "hrslice": case "hrwind": return { a: {}, b: { clipPath: `inset(0 ${pct(r)} 0 0)` }, bTop: true };
    case "wipeup": case "smoothup": case "vuslice": case "vuwind": return { a: {}, b: { clipPath: `inset(${pct(r)} 0 0 0)` }, bTop: true };
    case "wipedown": case "smoothdown": case "vdslice": case "vdwind": return { a: {}, b: { clipPath: `inset(0 0 ${pct(r)} 0)` }, bTop: true };
    case "wipetl": case "diagtl": return { a: {}, b: { clipPath: `inset(${pct(r)} 0 0 ${pct(r)})` }, bTop: true };
    case "wipetr": case "diagtr": return { a: {}, b: { clipPath: `inset(${pct(r)} ${pct(r)} 0 0)` }, bTop: true };
    case "wipebl": case "diagbl": return { a: {}, b: { clipPath: `inset(0 0 ${pct(r)} ${pct(r)})` }, bTop: true };
    case "wipebr": case "diagbr": return { a: {}, b: { clipPath: `inset(0 ${pct(r)} ${pct(r)} 0)` }, bTop: true };
    case "slideleft": return { a: { transform: `translateX(${pct(-q * 100)})` }, b: { transform: `translateX(${pct(r)})` }, bTop: true };
    case "slideright": return { a: { transform: `translateX(${pct(q * 100)})` }, b: { transform: `translateX(${pct(-r)})` }, bTop: true };
    case "slideup": return { a: { transform: `translateY(${pct(-q * 100)})` }, b: { transform: `translateY(${pct(r)})` }, bTop: true };
    case "slidedown": return { a: { transform: `translateY(${pct(q * 100)})` }, b: { transform: `translateY(${pct(-r)})` }, bTop: true };
    case "coverleft": return { a: {}, b: { transform: `translateX(${pct(r)})` }, bTop: true };
    case "coverright": return { a: {}, b: { transform: `translateX(${pct(-r)})` }, bTop: true };
    case "coverup": return { a: {}, b: { transform: `translateY(${pct(r)})` }, bTop: true };
    case "coverdown": return { a: {}, b: { transform: `translateY(${pct(-r)})` }, bTop: true };
    case "revealleft": return { a: { transform: `translateX(${pct(-q * 100)})` }, b: {}, bTop: false };
    case "revealright": return { a: { transform: `translateX(${pct(q * 100)})` }, b: {}, bTop: false };
    case "revealup": return { a: { transform: `translateY(${pct(-q * 100)})` }, b: {}, bTop: false };
    case "revealdown": return { a: { transform: `translateY(${pct(q * 100)})` }, b: {}, bTop: false };
    case "circleopen": return { a: {}, b: { clipPath: `circle(${pct(q * 75)} at 50% 50%)` }, bTop: true };
    case "circleclose": return { a: { clipPath: `circle(${pct(r * 0.75)} at 50% 50%)` }, b: {}, bTop: false };
    case "circlecrop": return q < 0.5 ? { a: { clipPath: `circle(${pct((1 - q * 2) * 75)} at 50% 50%)` }, b: { opacity: 0 }, bTop: false, bg: "#000" }
      : { a: { opacity: 0 }, b: { clipPath: `circle(${pct((q * 2 - 1) * 75)} at 50% 50%)` }, bTop: true, bg: "#000" };
    case "rectcrop": return q < 0.5 ? { a: { clipPath: `inset(${pct(q * 100)})` }, b: { opacity: 0 }, bTop: false, bg: "#000" }
      : { a: { opacity: 0 }, b: { clipPath: `inset(${pct((1 - q) * 100)})` }, bTop: true, bg: "#000" };
    case "radial": return { a: {}, b: { maskImage: `conic-gradient(#000 ${(q * 360).toFixed(1)}deg, transparent 0)`, WebkitMaskImage: `conic-gradient(#000 ${(q * 360).toFixed(1)}deg, transparent 0)` }, bTop: true };
    case "vertopen": return { a: {}, b: { clipPath: `inset(0 ${pct(r / 2)})` }, bTop: true };
    case "vertclose": return { a: { clipPath: `inset(0 ${pct(q * 50)})` }, b: {}, bTop: false };
    case "horzopen": return { a: {}, b: { clipPath: `inset(${pct(r / 2)} 0)` }, bTop: true };
    case "horzclose": return { a: { clipPath: `inset(${pct(q * 50)} 0)` }, b: {}, bTop: false };
    case "zoomin": return { a: { transform: `scale(${1 + q})`, opacity: 1 - q }, b: { opacity: q }, bTop: true };
    case "squeezeh": return { a: { transform: `scaleX(${Math.max(1 - q * 2, 0)})` }, b: { transform: `scaleX(${Math.max(q * 2 - 1, 0)})` }, bTop: true, bg: "#000" };
    case "squeezev": return { a: { transform: `scaleY(${Math.max(1 - q * 2, 0)})` }, b: { transform: `scaleY(${Math.max(q * 2 - 1, 0)})` }, bTop: true, bg: "#000" };
    default: return fadeB;
  }
}

/** Some transitions only roughly match in the browser preview. */
export const APPROX_TRANSITIONS = new Set(["distance", "pixelize", "hlslice", "hrslice", "vuslice", "vdslice", "hlwind", "hrwind", "vuwind",
  "vdwind", "smoothleft", "smoothright", "smoothup", "smoothdown", "diagtl", "diagtr", "diagbl", "diagbr", "hblur"]);
