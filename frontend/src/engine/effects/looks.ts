/**
 * The server's preset looks (backend fx.py LOOKS) as ordered steps the GPU runs with its FFmpeg-matched filters,
 * so they come out like the server render rather than like a 33-point LUT of it (a LUT can't hold eq's YUV maths
 * on colours outside RGB). The looks built on FFmpeg's curves presets stay on the server's .cube LUT. Pure.
 */
import { eqInt } from "./params.ts";

export type LookStep =
  | { op: "eq"; brightness?: number; contrast?: number; gamma?: number; saturation?: number }
  | { op: "cb"; s?: [number, number, number]; m?: [number, number, number]; h?: [number, number, number] }
  | { op: "vib"; intensity: number }
  | { op: "hue"; h?: number; s?: number }
  | { op: "ccm"; m: number[] }
  | { op: "negate" };

/** colorbalance=rs:gs:bs:rm:gm:bm:rh:gh:bh as shadows / midtones / highlights. */
const cb = (o: Partial<Record<"rs" | "gs" | "bs" | "rm" | "gm" | "bm" | "rh" | "gh" | "bh", number>>): LookStep => ({
  op: "cb", s: [o.rs ?? 0, o.gs ?? 0, o.bs ?? 0], m: [o.rm ?? 0, o.gm ?? 0, o.bm ?? 0], h: [o.rh ?? 0, o.gh ?? 0, o.bh ?? 0],
});

export const NATIVE_LOOKS: Record<string, LookStep[]> = {
  cinematic: [{ op: "eq", contrast: 1.12, saturation: 0.92 }, cb({ rs: -0.04, bs: 0.06, rh: 0.06, bh: -0.05 })],
  teal_orange: [cb({ rs: -0.12, gs: -0.02, bs: 0.14, rh: 0.12, gh: 0.02, bh: -0.12 }), { op: "eq", contrast: 1.1, saturation: 1.08 }],
  warm: [cb({ rs: 0.06, bs: -0.06, rm: 0.08, gm: 0.02, bm: -0.08 }), { op: "eq", saturation: 1.05 }],
  golden_hour: [cb({ rm: 0.14, gm: 0.06, bm: -0.12, rh: 0.1, bh: -0.08 }), { op: "eq", contrast: 1.05, saturation: 1.12, gamma: 1.04 }],
  cool: [cb({ rs: -0.04, bs: 0.08, rm: -0.06, bm: 0.08 }), { op: "eq", saturation: 0.95 }],
  moonlight: [cb({ rs: -0.1, bs: 0.15, rm: -0.08, bm: 0.12 }), { op: "eq", brightness: -0.05, saturation: 0.7, contrast: 1.08 }],
  vivid: [{ op: "vib", intensity: 0.35 }, { op: "eq", saturation: 1.2, contrast: 1.06 }],
  bleach_bypass: [{ op: "eq", saturation: 0.55, contrast: 1.28 }],
  noir: [{ op: "hue", s: 0 }, { op: "eq", contrast: 1.35, brightness: -0.03 }],
  black_white: [{ op: "hue", s: 0 }],
  sepia: [{ op: "ccm", m: [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131] }],
  negative: [{ op: "negate" }],
};

export const isNativeLook = (look: string | undefined) => !!look && Object.prototype.hasOwnProperty.call(NATIVE_LOOKS, look);

/** A GLSL float literal. */
const fl = (x: number) => { const s = String(Number.isFinite(x) ? x : 0); return /[.e]/.test(s) ? s : `${s}.0`; };
const v3 = (a: [number, number, number] | undefined) => `vec3(${(a ?? [0, 0, 0]).map(fl).join(", ")})`;

/** The steps as `vec3 nativeLook(vec3 c)` over the clip shader's nl* helpers (shaders.ts, NLOOK). */
export function lookGlsl(steps: LookStep[]): string {
  const body = steps.map((s) => {
    switch (s.op) {
      case "eq": {
        const b = s.brightness ?? 0, c = s.contrast ?? 1, g = s.gamma ?? 1, sat = s.saturation ?? 1;
        const luma = c !== 1 || b !== 0 || g !== 1, chroma = sat !== 1;
        const ki = [...eqInt(c, b), ...eqInt(sat, 0)];
        return `  c = nlEq(c, vec4(${[b, c, g, sat].map(fl).join(", ")}), vec2(${luma ? "1.0" : "0.0"}, ${chroma ? "1.0" : "0.0"}), vec4(${ki.map(fl).join(", ")}));`;
      }
      case "cb": return `  c = nlCb(c, ${v3(s.s)}, ${v3(s.m)}, ${v3(s.h)});`;
      case "vib": return `  c = nlVib(c, ${fl(s.intensity)});`;
      case "hue": { const r = ((s.h ?? 0) * Math.PI) / 180; return `  c = nlHue(c, vec2(${fl(Math.cos(r))}, ${fl(Math.sin(r))}), ${fl(s.s ?? 1)});`; }
      case "ccm": { const m = s.m; return `  c = nlCcm(c, vec3(${m.slice(0, 3).map(fl).join(", ")}), vec3(${m.slice(3, 6).map(fl).join(", ")}), vec3(${m.slice(6, 9).map(fl).join(", ")}));`; }
      case "negate": return "  c = nlNeg(c);";
      default: return "";
    }
  });
  return `vec3 nativeLook(vec3 c) {\n${body.join("\n")}\n  return c;\n}`;
}
