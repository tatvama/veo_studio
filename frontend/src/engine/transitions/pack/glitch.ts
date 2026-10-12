/** Glitch & retro transitions (our own GLSL): VHS tracking, RGB split, datamosh-like block smear, TV static, scan-line
 *  roll, pixel sorting, digital noise and a CRT switching off and on. */
import type { PackParam, PackTransition } from "./types.ts";

const amountP = (d = 1): PackParam => ({ name: "amount", type: "float", default: d, min: 0, max: 2, step: 0.01 });

const VHS = `
vec4 transition(vec2 uv) {
  float t = progress, env = sin(t * PI), fr = floor(t * 60.0);
  float bandY = fract(t * 1.7 + 0.2);
  float band = exp(-pow((uv.y - bandY) * 9.0, 2.0)) * env * amount;
  float lineN = nHash(vec2(floor(uv.y * 240.0), fr));
  float shift = (lineN - 0.5) * 0.07 * band + sin(uv.y * 40.0 + t * 30.0) * 0.004 * env * amount;
  vec2 q = vec2(uv.x + shift, uv.y);
  float sw = smoothstep(0.42, 0.58, t + (nHash(vec2(floor(uv.y * 30.0), fr)) - 0.5) * 0.15 * env);
  vec4 c = mix(getFromColor(q), getToColor(q), sw);
  vec2 ca = vec2(0.006 * env * amount, 0.0);
  vec3 col = vec3(mix(getFromColor(q + ca).r, getToColor(q + ca).r, sw), c.g, mix(getFromColor(q - ca).b, getToColor(q - ca).b, sw));
  float spk = step(0.985 - band * 0.25, nHash(floor(uv * vec2(480.0, 270.0)) + fr));
  col = mix(col, vec3(0.92), spk * min(band * 2.0, 1.0));
  col += (nHash(floor(uv * u_res) + fr * 13.0) - 0.5) * 0.12 * env * amount;
  col *= 1.0 - 0.15 * env * (0.5 + 0.5 * sin(uv.y * u_res.y * 1.5));
  return vec4(col, c.a);
}`;

const RGB_SPLIT = `
vec4 transition(vec2 uv) {
  float t = progress, env = sin(t * PI);
  float fr = floor(t * 24.0);
  float row = floor(uv.y * 18.0);
  float sw = step(0.5 + (nHash(vec2(row, fr)) - 0.5) * 0.3 * env, t);
  vec2 o = vec2(0.045, 0.012) * env * env * amount;
  vec2 j = vec2((nHash(vec2(row, fr + 3.0)) - 0.5) * 0.04 * env * amount, 0.0);
  vec2 q = uv + j;
  vec4 A = getFromColor(q), B = getToColor(q);
  float r = mix(getFromColor(q + o).r, getToColor(q + o).r, sw);
  float b = mix(getFromColor(q - o).b, getToColor(q - o).b, sw);
  vec4 c = mix(A, B, sw);
  return vec4(r, c.g, b, c.a);
}`;

const SMEAR = `
vec4 transition(vec2 uv) {
  float t = progress, env = sin(t * PI);
  vec2 bpx = vec2(block);
  vec2 cell = floor(uv * u_res / bpx);
  float tb = nHash(cell + 3.1) * 0.6 + 0.2;
  float sw = step(tb, t);
  vec2 mv = (nHash2(cell + floor(t * 8.0) * 0.0) - 0.5) * vec2(0.14, 0.05) * env * amount;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    vec2 q = clamp(uv - mv * (float(i) / 7.0), 0.0, 1.0);
    acc += mix(getFromColor(q), getToColor(q), sw);
  }
  vec4 c = acc / 8.0;
  // macroblock quantisation while it moshes
  float lv = mix(256.0, 10.0, env * amount * 0.5);
  c.rgb = mix(c.rgb, floor(c.rgb * lv + 0.5) / lv, env);
  return c;
}`;

const STATIC = `
vec4 transition(vec2 uv) {
  float t = progress;
  float env = clamp(1.0 - abs(t * 2.0 - 1.0) * 1.15, 0.0, 1.0);
  env = env * env * (3.0 - 2.0 * env);
  float fr = floor(t * 50.0);
  vec2 jit = vec2((nHash(vec2(floor(uv.y * 90.0), fr)) - 0.5) * 0.02 * env, 0.0);
  vec4 base = t < 0.5 ? getFromColor(uv + jit) : getToColor(uv + jit);
  float n = nHash(floor(uv * u_res / grain) + fr * 17.0);
  float roll = smoothstep(0.0, 0.08, abs(fract(uv.y - t * 2.0) - 0.5) - 0.38);
  vec3 st = vec3(n) * (0.75 + 0.25 * sin(uv.y * u_res.y * 2.0)) * (0.8 + 0.2 * roll);
  vec3 c = mix(base.rgb, st, env * amount);
  return vec4(c, base.a);
}`;

const ROLL = `
vec4 transition(vec2 uv) {
  float t = progress;
  float e = t * t * (3.0 - 2.0 * t);
  float gap = 0.12;
  float jx = (nHash(vec2(floor(uv.y * 120.0), floor(t * 30.0))) - 0.5) * 0.015 * sin(t * PI) * amount;
  float y = uv.y + e * (1.0 + gap);
  vec4 c;
  if (y < 1.0) c = getFromColor(vec2(uv.x + jx, y));
  else if (y < 1.0 + gap) { float k = (y - 1.0) / gap; c = bgColor(); c.rgb += vec3(0.5) * exp(-pow((k - 0.5) * 12.0, 2.0)); }
  else c = getToColor(vec2(uv.x + jx, y - 1.0 - gap));
  float env = sin(t * PI);
  c.rgb *= 1.0 - 0.25 * env * amount * (0.5 + 0.5 * sin(uv.y * u_res.y * 1.2));
  c.rgb *= 1.0 + 0.15 * env * (nHash(vec2(floor(t * 40.0), 3.0)) - 0.5);
  return c;
}`;

const SORT = `
vec4 src(vec2 q, float t) {
  float col = floor(q.x * u_res.x / 3.0);
  float sw = step(nHash(vec2(col, 7.0)) * 0.4 + 0.3, t);
  return mix(getFromColor(q), getToColor(q), sw);
}
vec4 transition(vec2 uv) {
  float t = progress, env = sin(t * PI);
  float L = 0.3 * env * amount;
  vec4 best = src(uv, t);
  float bl = dot(best.rgb, K709);
  for (int i = 1; i <= 24; i++) {
    vec2 q = uv - vec2(0.0, L * float(i) / 24.0);
    if (q.y < 0.0) break;
    vec4 c = src(q, t);
    float l = dot(c.rgb, K709);
    if (l > bl && l > threshold) { best = c; bl = l; }
  }
  return best;
}`;

const DIGITAL = `
vec4 transition(vec2 uv) {
  float t = progress, env = sin(t * PI);
  float fr = floor(t * 30.0);
  vec2 cell = floor(uv * u_res / vec2(block * 2.0, block));
  float h = nHash(cell + fr * 7.0);
  float sw = step(nHash(cell + 11.0) * 0.7 + 0.15, t);
  bool glitch = h < 0.35 * env * amount;
  vec2 q = uv;
  if (glitch) q.x += (nHash(cell + fr) - 0.5) * 0.2;
  vec4 c = mix(getFromColor(q), getToColor(q), sw);
  if (glitch) {
    float k = nHash(cell + fr * 3.0);
    if (k < 0.3) c.rgb = vec3(nHash(cell + 1.0), nHash(cell + 2.0), nHash(cell + 3.0));
    else if (k < 0.6) c.rgb = floor(c.rgb * 3.0) / 3.0;
    else c.rgb = c.gbr;
  }
  c.rgb += (nHash(floor(uv * u_res * 0.5) + fr) - 0.5) * 0.15 * env * amount;
  return c;
}`;

const TV_OFF = `
vec4 transition(vec2 uv) {
  float t = progress;
  bool first = t < 0.5;
  float k = first ? t * 2.0 : (1.0 - t) * 2.0;
  float sy = max(1.0 - smoothstep(0.0, 0.62, k), 0.004);
  float sx = max(1.0 - smoothstep(0.62, 1.0, k), 0.003);
  vec2 q = (uv - 0.5) / vec2(sx, sy) + 0.5;
  float inside = gInside(q);
  vec4 c = first ? getFromColor(clamp(q, 0.0, 1.0)) : getToColor(clamp(q, 0.0, 1.0));
  c.rgb = c.rgb * (1.0 + 2.5 * k) + vec3(0.7) * smoothstep(0.45, 0.9, k);
  vec4 bg = bgColor();
  float glow = exp(-pow((uv.y - 0.5) * u_res.y / (2.0 + 30.0 * sy), 2.0)) * exp(-pow((uv.x - 0.5) / (0.05 + sx), 2.0)) * smoothstep(0.55, 1.0, k);
  vec4 o = mix(bg, c, inside);
  o.rgb += vec3(0.8, 0.9, 1.0) * glow * 0.6;
  return o;
}`;

export const GLITCH: PackTransition[] = [
  { id: "vhs_tracking", label: "VHS tracking", group: "Glitch & retro", glsl: VHS, params: [amountP()] },
  { id: "rgb_split", label: "RGB split", group: "Glitch & retro", glsl: RGB_SPLIT, params: [amountP()] },
  { id: "block_smear", label: "Datamosh smear", group: "Glitch & retro", glsl: SMEAR,
    params: [amountP(), { name: "block", type: "float", default: 24, min: 4, max: 96, step: 1, description: "Block size (pixels)" }] },
  { id: "tv_static", label: "TV static", group: "Glitch & retro", glsl: STATIC,
    params: [amountP(), { name: "grain", type: "float", default: 2, min: 1, max: 8, step: 0.5, description: "Noise size (pixels)" }] },
  { id: "scanline_roll", label: "Scan-line roll", group: "Glitch & retro", glsl: ROLL, params: [amountP()] },
  { id: "pixel_sort", label: "Pixel sort", group: "Glitch & retro", glsl: SORT,
    params: [amountP(), { name: "threshold", type: "float", default: 0.35, min: 0, max: 1, step: 0.01 }] },
  { id: "digital_noise", label: "Digital noise", group: "Glitch & retro", glsl: DIGITAL,
    params: [amountP(), { name: "block", type: "float", default: 16, min: 4, max: 64, step: 1, description: "Block size (pixels)" }] },
  { id: "tv_off", label: "CRT off / on", group: "Glitch & retro", glsl: TV_OFF, params: [] },
];
