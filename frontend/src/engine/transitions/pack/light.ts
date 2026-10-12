/** Light transitions (our own GLSL): light leaks, film burns, flashes with bloom, a lens-flare sweep. */
import type { PackParam, PackTransition } from "./types.ts";

const LEAK = `
vec4 transition(vec2 uv) {
  vec4 a = getFromColor(uv), b = getToColor(uv);
  float env = sin(progress * PI);
  env = env * env * (3.0 - 2.0 * env);
  vec2 p = (uv - 0.5) * vec2(ratio, 1.0);
  float ang = radians(angle);
  vec2 drift = vec2(cos(ang), sin(ang)) * (progress - 0.5);
  vec3 leak = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 h = nHash2(vec2(fi, seed * 13.0 + 1.0));
    vec2 c = vec2((h.x - 0.5) * ratio * 1.1, (h.y - 0.5) * 0.9) + drift * vec2(ratio, 1.0) * 0.9;
    float rad = 0.22 + 0.32 * nHash(vec2(fi, seed + 7.0));
    vec2 d = (p - c) / vec2(1.7, 1.0);
    float w = exp(-dot(d, d) / (rad * rad));
    vec3 col = rainbow > 0.5 ? cHsv2Rgb(vec3(fract(nHash(vec2(fi, seed + 3.0)) + progress * 0.3), 0.75, 1.0)) : mix(color1, color2, nHash(vec2(fi, seed + 3.0)));
    leak += col * w;
  }
  // light through the gate from one side
  float side = cos(ang) >= 0.0 ? uv.x : 1.0 - uv.x;
  leak += color1 * exp(-side * 6.0) * 0.35;
  leak *= intensity * env * 0.45;
  vec4 base = mix(a, b, smoothstep(0.35, 0.65, progress));
  vec3 c = 1.0 - (1.0 - clamp(base.rgb, 0.0, 1.0)) * (1.0 - clamp(leak, 0.0, 1.0));
  c += max(leak - 1.0, 0.0) * 0.4;
  return vec4(c, base.a);
}`;
const leakParams = (c1: number[], c2: number[], seed: number, angle: number, rainbow = false): PackParam[] => [
  { name: "color1", type: "vec3", default: c1, color: true },
  { name: "color2", type: "vec3", default: c2, color: true },
  { name: "intensity", type: "float", default: 1, min: 0, max: 3, step: 0.01 },
  { name: "angle", type: "float", default: angle, min: -180, max: 180, step: 1, description: "Direction the light drifts (degrees)" },
  { name: "seed", type: "float", default: seed, min: 0, max: 100, step: 1 },
  { name: "rainbow", type: "bool", default: rainbow },
];

const BURN = `
vec4 transition(vec2 uv) {
  vec4 a = getFromColor(uv), b = getToColor(uv);
  vec2 p = (uv - 0.5) * vec2(ratio, 1.0);
  vec2 c0 = (nHash2(vec2(seed, 2.0)) - 0.5) * vec2(ratio, 1.0) * 0.5;
  float n = nFbm(p * 4.0 + seed * 10.0) * 0.45 + nFbm(p * 11.0 - seed) * 0.15;
  float d = edges > 0.5 ? 1.0 - max(abs(p.x) / ratio, abs(p.y)) * 2.0 + n * 1.4 : length(p - c0) + n;
  float front = mix(-0.3, edges > 0.5 ? 1.9 : 1.7, progress);
  float hole = smoothstep(front + 0.02, front - 0.02, d);
  float edge = exp(-pow((d - front) / 0.035, 2.0));
  float ahead = smoothstep(front + 0.28, front, d) * (1.0 - hole);
  vec3 col = a.rgb * (1.0 - 0.7 * ahead) + color * ahead * 0.2;
  vec3 outc = mix(col, b.rgb, hole);
  outc += (color * 2.0 + vec3(1.0, 0.9, 0.6) * heat) * edge;
  outc += color * flash * sin(progress * PI) * (1.0 - hole);
  return vec4(outc, mix(a.a, b.a, hole));
}`;
const burnParams = (color: number[], edges: boolean, heat: number, flash: number, seed: number): PackParam[] => [
  { name: "color", type: "vec3", default: color, color: true },
  { name: "edges", type: "bool", default: edges, description: "Burn in from the edges" },
  { name: "heat", type: "float", default: heat, min: 0, max: 3, step: 0.01 },
  { name: "flash", type: "float", default: flash, min: 0, max: 1, step: 0.01 },
  { name: "seed", type: "float", default: seed, min: 0, max: 100, step: 1 },
];

const FLASH = `
vec4 transition(vec2 uv) {
  float t = progress;
  float k = pow(1.0 - abs(t * 2.0 - 1.0), 1.6);
  bool first = t < 0.5;
  vec4 src = first ? getFromColor(uv) : getToColor(uv);
  float lod = 1.0 + 6.0 * k;
  vec3 blur = first ? textureLod(u_from, uv, lod).rgb : textureLod(u_to, uv, lod).rgb;
  vec3 blur2 = first ? textureLod(u_from, uv, lod + 1.5).rgb : textureLod(u_to, uv, lod + 1.5).rgb;
  vec3 hi = max((blur + blur2) * 0.5 - threshold, 0.0) / max(1.0 - threshold, 0.05);
  vec3 c = mix(src.rgb, blur, soften * k) + hi * bloom * k * 2.0;
  c = mix(c, color, smoothstep(hold, 1.0, k));
  return vec4(c, src.a);
}`;
const flashParams = (color: number[], bloom: number, soften: number, hold: number): PackParam[] => [
  { name: "color", type: "vec3", default: color, color: true },
  { name: "bloom", type: "float", default: bloom, min: 0, max: 2, step: 0.01 },
  { name: "threshold", type: "float", default: 0.55, min: 0, max: 1, step: 0.01 },
  { name: "soften", type: "float", default: soften, min: 0, max: 1, step: 0.01 },
  { name: "hold", type: "float", default: hold, min: 0, max: 0.95, step: 0.01, description: "Where the dip reaches the colour" },
];

const FLARE = `
vec4 transition(vec2 uv) {
  vec4 a = getFromColor(uv), b = getToColor(uv);
  vec4 base = mix(a, b, smoothstep(0.4, 0.6, progress));
  vec2 p = (uv - 0.5) * vec2(ratio, 1.0);
  float x = mix(-0.75, 0.75, progress) * ratio * direction;
  vec2 L = vec2(x, -0.16 + 0.08 * sin(progress * 3.0));
  float env = sin(progress * PI);
  float d = length(p - L);
  vec3 col = color * (0.0009 / (d * d + 0.0012));
  col += color * exp(-abs(p.y - L.y) * 55.0) * exp(-abs(p.x - L.x) * 1.4) * 0.8;
  col += color * 0.3 * exp(-pow((d - 0.22) * 20.0, 2.0));
  for (int i = 1; i <= 5; i++) {
    float fi = float(i);
    vec2 g = -L * (fi * 0.32 - 0.25);
    float gd = length(p - g), rr = 0.025 + 0.022 * fi;
    col += cHsv2Rgb(vec3(fract(0.13 * fi + 0.52), 0.55, 1.0)) * 0.22 * smoothstep(rr, rr * 0.55, gd);
  }
  col *= intensity * env;
  vec3 c = 1.0 - (1.0 - clamp(base.rgb, 0.0, 1.0)) * (1.0 - clamp(col, 0.0, 1.0));
  c += max(col - 1.0, 0.0) * 0.3;
  return vec4(c, base.a);
}`;
const flareParams = (dir: number): PackParam[] => [
  { name: "color", type: "vec3", default: [1, 0.85, 0.6], color: true },
  { name: "intensity", type: "float", default: 1.2, min: 0, max: 3, step: 0.01 },
  { name: "direction", type: "float", default: dir, min: -1, max: 1, step: 2, description: "1: left to right, −1: right to left" },
];

export const LIGHT: PackTransition[] = [
  { id: "light_leak_warm", label: "Light leak, warm", group: "Light", glsl: LEAK, params: leakParams([1, 0.55, 0.15], [1, 0.85, 0.35], 3, 0) },
  { id: "light_leak_amber", label: "Light leak, amber", group: "Light", glsl: LEAK, params: leakParams([1, 0.42, 0.05], [0.95, 0.65, 0.2], 11, 20) },
  { id: "light_leak_rose", label: "Light leak, rose", group: "Light", glsl: LEAK, params: leakParams([1, 0.3, 0.35], [1, 0.6, 0.45], 23, 160) },
  { id: "light_leak_cool", label: "Light leak, cool", group: "Light", glsl: LEAK, params: leakParams([0.35, 0.6, 1], [0.6, 0.85, 1], 37, 180) },
  { id: "light_leak_teal", label: "Light leak, teal", group: "Light", glsl: LEAK, params: leakParams([0.2, 0.9, 0.8], [0.5, 1, 0.6], 41, -30) },
  { id: "light_leak_rainbow", label: "Light leak, prism", group: "Light", glsl: LEAK, params: leakParams([1, 0.6, 0.3], [0.5, 0.7, 1], 53, 0, true) },
  { id: "film_burn", label: "Film burn", group: "Light", glsl: BURN, params: burnParams([1, 0.42, 0.08], false, 1, 0.25, 5) },
  { id: "film_burn_edges", label: "Film burn from the edges", group: "Light", glsl: BURN, params: burnParams([1, 0.35, 0.05], true, 0.8, 0.2, 9) },
  { id: "film_burn_hot", label: "Film burn, white hot", group: "Light", glsl: BURN, params: burnParams([1, 0.8, 0.5], false, 2.5, 0.6, 17) },
  { id: "flash", label: "Flash", group: "Light", glsl: FLASH, mips: true, params: flashParams([1, 1, 1], 0.8, 0.2, 0.55) },
  { id: "flash_warm", label: "Warm flash", group: "Light", glsl: FLASH, mips: true, params: flashParams([1, 0.86, 0.68], 1, 0.25, 0.6) },
  { id: "flash_bloom", label: "Bloom dissolve", group: "Light", glsl: FLASH, mips: true, params: flashParams([1, 1, 1], 1.6, 0.8, 0.85) },
  { id: "lens_flare", label: "Lens flare sweep", group: "Light", glsl: FLARE, params: flareParams(1) },
  { id: "lens_flare_back", label: "Lens flare sweep (right to left)", group: "Light", glsl: FLARE, params: flareParams(-1) },
];
