/**
 * The editor-style multi-track demo the lab plays and the self-test checks: generic "video" tracks with a transition at
 * a cut (into the clips' handles), keyframed motion, an effects chain, a nested composition fading in from nothing, a
 * title, and an adjustment clip over everything. Composition pixels = `W`×`H`. Pure.
 */
import type { Clip, Composition, EffectInstance, TitleSpec } from "../types";

export interface DemoOptions {
  W?: number; H?: number;
  /** Transition at the V1 cut (default "fade") and its length. */
  transition?: string; duration?: number;
  /** Effects on the two V1 clips. */
  chain?: EffectInstance[];
  /** Drop parts: "nested", "title", "adjustment". */
  without?: string[];
}

const vclip = (id: string, url: string, start: number, duration: number, over: Partial<Clip> = {}): Clip =>
  ({ id, media: { url, kind: "image" }, start, duration, in: 0, speed: 1, fit: "contain", fx: {}, label: id, ...over });

export const DEMO_TITLE: TitleSpec = {
  text: "Tatvam engine · तत्त्वम्", font: "Inter Variable", size: 72, color: "#ffffff", weight: 700, align: "center",
  outline: { color: "#000000", width: 3 }, shadow: { color: "rgba(0,0,0,0.6)", blur: 12, x: 0, y: 4 },
  background: { color: "rgba(20,20,40,0.55)", padding: 18, radius: 14 }, box: [0.1, 0.72, 0.8, 0.2], animIn: "slide_up", animOut: "fade",
};

export function editorDemo(o: DemoOptions = {}): Composition {
  const W = o.W ?? 1920, H = o.H ?? 1080, d = o.duration ?? 1, no = new Set(o.without ?? []);
  const k = W / 1920;
  const inner: Composition = { width: W, height: H, fps: 24, duration: 10, tracks: [
    { id: "n1", kind: "video", clips: [vclip("nb", "lab:b", 0, 10, { effects: [{ type: "pixelate", params: { size: [12 * k, 12 * k] } }] })] },
    { id: "n2", kind: "video", clips: [vclip("nlogo", "lab:logo", 0, 10, { motion: { scale: { value: 45 }, rotation: { value: 0, keyframes: [{ t: 0, value: -30 }, { t: 6, value: 30 }] } } })] },
  ] };
  const tracks: Composition["tracks"] = [
    { id: "v1", kind: "video", clips: [vclip("a", "lab:a", 0, 4, { effects: o.chain }), vclip("b", "lab:b", 4, 4, { effects: o.chain })],
      transitions: [{ id: "t1", type: o.transition ?? "fade", at: 4, duration: d, alignment: "center", from: "a", to: "b" }] },
  ];
  if (!no.has("nested")) tracks.push({ id: "v2", kind: "video", clips: [vclip("pip", "", 1, 6, {
    type: "nested", comp: inner, in: 0,
    motion: { position: { value: [1500 * k, 300 * k], keyframes: [{ t: 0, value: [1500 * k, 300 * k] }, { t: 6, value: [1400 * k, 360 * k], ease: "ease_in_out" }] },
      scale: { value: 35 }, rotation: { value: 4 }, opacity: { value: 100 } },
    effects: [{ type: "drop_shadow", params: { distance: 14, blur: 8 } }],
  })], transitions: [{ id: "t2", type: "fade", at: 1, duration: 1, alignment: "start", to: "pip" }] });
  if (!no.has("title")) tracks.push({ id: "v3", kind: "video", clips: [vclip("title", "", 0.5, 7, {
    type: "title", title: { ...DEMO_TITLE, size: 72 * k },
    motion: { scale: { value: 100, keyframes: [{ t: 0, value: 92 }, { t: 7, value: 104 }] } },
  })] });
  if (!no.has("adjustment")) tracks.push({ id: "v4", kind: "video", clips: [vclip("adj", "", 6, 2, {
    type: "adjustment", effects: [{ type: "grayscale" }, { type: "vignette", params: { size: 0.4, amount: 0.6 } }],
    motion: { opacity: { value: 100, keyframes: [{ t: 0, value: 0 }, { t: 0.5, value: 100 }] } },
  })] });
  return { width: W, height: H, fps: 24, duration: 8, background: [0, 0, 0], tracks };
}
