/**
 * The 58 FFmpeg xfade transitions (backend fx.py TRANSITION_GROUPS) as GPU transitions, written from how FFmpeg 7.1's
 * xfade looks (directions and edges checked against its frames), so cuts made for the server render keep their look.
 * Each body is `vec4 transition(vec2 uv)` in image space (y down) with `progress` 0 → 1 (all outgoing → all incoming);
 * `P` is FFmpeg's own progress (1 → 0), `pix` the integer pixel, `puv` = pix / size (FFmpeg's x / w).
 */
import { yuvToRgbRaw } from "../yuv";

export const XFADE_GROUPS: [string, [string, string][]][] = [
  ["Dissolves", [["fade", "Crossfade"], ["dissolve", "Dissolve"], ["fadeblack", "Dip to black"], ["fadewhite", "Dip to white"],
    ["fadegrays", "Fade through grey"], ["fadefast", "Fast fade"], ["fadeslow", "Slow fade"], ["hblur", "Blur fade"], ["distance", "Distance"],
    ["pixelize", "Pixelize"]]],
  ["Wipes", [["wipeleft", "Wipe left"], ["wiperight", "Wipe right"], ["wipeup", "Wipe up"], ["wipedown", "Wipe down"], ["wipetl", "Wipe ↖"],
    ["wipetr", "Wipe ↗"], ["wipebl", "Wipe ↙"], ["wipebr", "Wipe ↘"], ["smoothleft", "Soft wipe left"], ["smoothright", "Soft wipe right"],
    ["smoothup", "Soft wipe up"], ["smoothdown", "Soft wipe down"]]],
  ["Slides & pushes", [["slideleft", "Slide left"], ["slideright", "Slide right"], ["slideup", "Slide up"], ["slidedown", "Slide down"],
    ["coverleft", "Cover left"], ["coverright", "Cover right"], ["coverup", "Cover up"], ["coverdown", "Cover down"], ["revealleft", "Reveal left"],
    ["revealright", "Reveal right"], ["revealup", "Reveal up"], ["revealdown", "Reveal down"]]],
  ["Shapes", [["circleopen", "Iris open"], ["circleclose", "Iris close"], ["circlecrop", "Circle crop"], ["rectcrop", "Box crop"],
    ["radial", "Clock wipe"], ["vertopen", "Barn doors open (vertical)"], ["vertclose", "Barn doors close (vertical)"], ["horzopen", "Barn doors open"],
    ["horzclose", "Barn doors close"], ["diagtl", "Diagonal ↖"], ["diagtr", "Diagonal ↗"], ["diagbl", "Diagonal ↙"], ["diagbr", "Diagonal ↘"]]],
  ["Slices & wind", [["hlslice", "Slices left"], ["hrslice", "Slices right"], ["vuslice", "Slices up"], ["vdslice", "Slices down"],
    ["hlwind", "Wind left"], ["hrwind", "Wind right"], ["vuwind", "Wind up"], ["vdwind", "Wind down"]]],
  ["Zoom & squeeze", [["zoomin", "Zoom in"], ["squeezeh", "Squeeze horizontal"], ["squeezev", "Squeeze vertical"]]],
];
export const XFADE_IDS = XFADE_GROUPS.flatMap(([, items]) => items.map(([id]) => id));

/** RGB of the YUV code (y, 127, 127): FFmpeg xfade's fill colour, as GLSL. */
function fill(y: number): string {
  const [r, g, b] = yuvToRgbRaw(y, 127, 127);
  return `${r.toFixed(7)}, ${g.toFixed(7)}, ${b.toFixed(7)}`;
}

/** Shared by every xfade program (after the common header). */
export const XFADE_PRELUDE = `
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float progress;
uniform float ratio;
uniform sampler2D u_rand;   // frand(0, y) in row 0, frand(x, 0) in row 1 (frand.ts)
uniform sampler2D u_rand2;  // frand(x, y) per pixel
const float PI = 3.141592653589793;
// FFmpeg's xfade on yuv420p fills with Y 0 / 255 and chroma 127 (below black / above white in limited range): kept
// out of 0..1 here so the YUV read-back writes the same codes (half-float targets; the canvas clamps)
const vec4 BLACK = vec4(${fill(0)}, 1.0);
const vec4 WHITE = vec4(${fill(255)}, 1.0);
vec4 getFromColor(vec2 uv) { return texture(u_from, uv); }
vec4 getToColor(vec2 uv) { return texture(u_to, uv); }
vec2 pixOf(vec2 uv) { return floor(uv * u_res); }
vec2 at(vec2 p) { return (p + 0.5) / u_res; }
vec4 A(vec2 p) { return texture(u_from, at(p)); }
vec4 B(vec2 p) { return texture(u_to, at(p)); }
float luma(vec4 c) { return dot(c.rgb, K709); }
vec4 grayOf(vec4 c) { return vec4(fromYcc(vec3(toYcc(clamp(c.rgb, 0.0, 1.0)).x, 127.0 / 255.0, 127.0 / 255.0)), c.a); }
vec3 ycc(vec4 c) { return toYcc(clamp(c.rgb, 0.0, 1.0)); }
// FFmpeg's smoothstep also takes edge0 > edge1
float ss(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
`;

const T = (body: string) => `vec4 transition(vec2 uv) {
  float P = 1.0 - progress;
  vec2 pix = pixOf(uv), puv = pix / u_res, W = u_res;
  vec4 a = getFromColor(uv), b = getToColor(uv);
${body}
}`;

const fadeThrough = (bg: string) => T(`  vec4 t1 = mix(${bg}, a, ss(0.8, 1.0, P));
  vec4 t2 = mix(b, ${bg}, ss(0.2, 1.0, P));
  return mix(t2, t1, P);`);
const wind = (coord: string, rnd: string) => T(`  float r = texelFetch(u_rand, ${rnd}, 0).r;
  float m = ss(0.0, -0.2, (${coord}) * 0.8 + 0.2 * r - progress * 1.2);
  return mix(a, b, m);`);
const slice = (coord: string) => T(`  float xx = ${coord};
  return ss(-0.5, 0.0, xx - P * 1.5) > fract(10.0 * xx) ? b : a;`);
const soft = (coord: string) => T(`  return mix(a, b, ss(0.0, 1.0, 1.0 + (${coord}) - 2.0 * P));`);

export const XFADE_GLSL: Record<string, string> = {
  fade: T(`  return mix(a, b, progress);`),
  dissolve: T(`  return texelFetch(u_rand2, ivec2(pix), 0).r * 2.0 + P * 2.0 - 1.5 >= 0.5 ? a : b;`),
  fadeblack: fadeThrough("BLACK"),
  fadewhite: fadeThrough("WHITE"),
  fadegrays: T(`  vec4 ga = grayOf(a), gb = grayOf(b);
  vec4 t1 = mix(ga, a, ss(0.8, 1.0, P));
  vec4 t2 = mix(b, gb, ss(0.2, 1.0, P));
  return mix(t2, t1, P);`),
  // per YUV plane, as FFmpeg runs them on yuv420p
  fadefast: T(`  vec3 qa = ycc(a), qb = ycc(b);
  vec3 m = pow(vec3(P), 1.0 + log(1.0 + abs(qa - qb)));
  return vec4(fromYcc(qa * m + qb * (1.0 - m)), mix(b.a, a.a, P));`),
  fadeslow: T(`  vec3 qa = ycc(a), qb = ycc(b);
  vec3 m = pow(vec3(P), 1.0 + log(2.0 - abs(qa - qb)));
  return vec4(fromYcc(qa * m + qb * (1.0 - m)), mix(b.a, a.a, P));`),
  hblur: T(`  float prog = P <= 0.5 ? P * 2.0 : (1.0 - P) * 2.0;
  float size = floor(1.0 + floor(W.x / 2.0) * prog);
  // FFmpeg's running sum: the box starts at the pixel and shrinks at the right edge
  float span = min(pix.x + size, W.x) - pix.x;
  float lod = max(0.0, log2(span / 24.0));
  vec4 sa = vec4(0.0), sb = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    vec2 q = vec2((pix.x + (float(i) + 0.5) * span / 24.0) / W.x, uv.y);
    sa += textureLod(u_from, q, lod); sb += textureLod(u_to, q, lod);
  }
  return mix(sa, sb, progress) / 24.0;`),
  distance: T(`  float d = distance(toYcc(clamp(a.rgb, 0.0, 1.0)), toYcc(clamp(b.rgb, 0.0, 1.0)));
  vec4 t = d <= P ? a : b;
  return mix(b, t, P);`),
  pixelize: T(`  float d = min(P, 1.0 - P);
  float dist = ceil(d * 50.0) / 50.0;
  float sq = 2.0 * dist * min(W.x, W.y) / 20.0;
  vec2 s = dist > 0.0 ? min(floor((floor(pix / sq) + 0.5) * sq), W - 1.0) : pix;
  return mix(A(s), B(s), progress);`),
  wipeleft: T(`  return pix.x > floor(W.x * P) ? b : a;`),
  wiperight: T(`  return pix.x > floor(W.x * (1.0 - P)) ? a : b;`),
  wipeup: T(`  return pix.y > floor(W.y * P) ? b : a;`),
  wipedown: T(`  return pix.y > floor(W.y * (1.0 - P)) ? a : b;`),
  wipetl: T(`  return (pix.y <= floor(W.y * P) && pix.x <= floor(W.x * P)) ? a : b;`),
  wipetr: T(`  return (pix.y <= floor(W.y * P) && pix.x > floor(W.x * (1.0 - P))) ? a : b;`),
  wipebl: T(`  return (pix.y > floor(W.y * (1.0 - P)) && pix.x <= floor(W.x * P)) ? a : b;`),
  wipebr: T(`  return (pix.y > floor(W.y * (1.0 - P)) && pix.x > floor(W.x * (1.0 - P))) ? a : b;`),
  smoothleft: soft("puv.x"),
  smoothright: soft("(W.x - 1.0 - pix.x) / W.x"),
  smoothup: soft("puv.y"),
  smoothdown: soft("(W.y - 1.0 - pix.y) / W.y"),
  slideleft: T(`  float zx = pix.x - floor(P * W.x);
  return zx >= 0.0 ? B(vec2(zx, pix.y)) : A(vec2(zx + W.x, pix.y));`),
  slideright: T(`  float zx = pix.x + floor(P * W.x);
  return zx < W.x ? B(vec2(zx, pix.y)) : A(vec2(zx - W.x, pix.y));`),
  slideup: T(`  float zy = pix.y - floor(P * W.y);
  return zy >= 0.0 ? B(vec2(pix.x, zy)) : A(vec2(pix.x, zy + W.y));`),
  slidedown: T(`  float zy = pix.y + floor(P * W.y);
  return zy < W.y ? B(vec2(pix.x, zy)) : A(vec2(pix.x, zy - W.y));`),
  coverleft: T(`  float zx = pix.x - floor(P * W.x);
  return zx >= 0.0 ? B(vec2(zx, pix.y)) : a;`),
  coverright: T(`  float zx = pix.x + floor(P * W.x);
  return zx < W.x ? B(vec2(zx, pix.y)) : a;`),
  coverup: T(`  float zy = pix.y - floor(P * W.y);
  return zy >= 0.0 ? B(vec2(pix.x, zy)) : a;`),
  coverdown: T(`  float zy = pix.y + floor(P * W.y);
  return zy < W.y ? B(vec2(pix.x, zy)) : a;`),
  revealleft: T(`  float zx = pix.x + W.x - floor(P * W.x);
  return zx < W.x ? A(vec2(zx, pix.y)) : b;`),
  revealright: T(`  float zx = pix.x - W.x + floor(P * W.x);
  return zx >= 0.0 ? A(vec2(zx, pix.y)) : b;`),
  revealup: T(`  float zy = pix.y + W.y - floor(P * W.y);
  return zy < W.y ? A(vec2(pix.x, zy)) : b;`),
  revealdown: T(`  float zy = pix.y - W.y + floor(P * W.y);
  return zy >= 0.0 ? A(vec2(pix.x, zy)) : b;`),
  circleopen: T(`  float z = length(W * 0.5);
  float m = ss(0.0, 1.0, length(pix - floor(W * 0.5)) / z + (P - 0.5) * 3.0);
  return mix(b, a, m);`),
  circleclose: T(`  float z = length(W * 0.5);
  float m = ss(0.0, 1.0, length(pix - floor(W * 0.5)) / z + (0.5 - P) * 3.0);
  return mix(a, b, m);`),
  circlecrop: T(`  float z = pow(2.0 * abs(P - 0.5), 3.0) * length(W * 0.5);
  float dist = length(pix - floor(W * 0.5));
  return z < dist ? BLACK : (P < 0.5 ? b : a);`),
  rectcrop: T(`  vec2 z = floor(abs(P - 0.5) * W), c = floor(W * 0.5);
  bool inside = pix.x > c.x - z.x && pix.x < c.x + z.x && pix.y > c.y - z.y && pix.y < c.y + z.y;
  return inside ? (P < 0.5 ? b : a) : BLACK;`),
  radial: T(`  vec2 d = pix - floor(W * 0.5);
  float m = ss(0.0, 1.0, atan(d.x, d.y) - (P - 0.5) * PI * 2.5);
  return mix(a, b, m);`),
  vertopen: T(`  float w2 = W.x / 2.0;
  return mix(a, b, ss(0.0, 1.0, 2.0 - abs((pix.x - w2) / w2) - P * 2.0));`),
  vertclose: T(`  float w2 = W.x / 2.0;
  return mix(a, b, ss(0.0, 1.0, 1.0 + abs((pix.x - w2) / w2) - P * 2.0));`),
  horzopen: T(`  float h2 = W.y / 2.0;
  return mix(a, b, ss(0.0, 1.0, 2.0 - abs((pix.y - h2) / h2) - P * 2.0));`),
  horzclose: T(`  float h2 = W.y / 2.0;
  return mix(a, b, ss(0.0, 1.0, 1.0 + abs((pix.y - h2) / h2) - P * 2.0));`),
  diagtl: soft("puv.x * puv.y"),
  diagtr: soft("(W.x - 1.0 - pix.x) / W.x * puv.y"),
  diagbl: soft("puv.x * (W.y - 1.0 - pix.y) / W.y"),
  diagbr: soft("(W.x - 1.0 - pix.x) / W.x * (W.y - 1.0 - pix.y) / W.y"),
  hlslice: slice("puv.x"),
  hrslice: slice("(W.x - 1.0 - pix.x) / W.x"),
  vuslice: slice("puv.y"),
  vdslice: slice("(W.y - 1.0 - pix.y) / W.y"),
  hlwind: wind("(W.x - pix.x) / W.x", "ivec2(int(pix.y), 0)"),
  hrwind: wind("puv.x", "ivec2(int(pix.y), 0)"),
  vuwind: wind("(W.y - pix.y) / W.y", "ivec2(int(pix.x), 1)"),
  vdwind: wind("puv.y", "ivec2(int(pix.x), 1)"),
  zoomin: T(`  float zf = ss(0.5, 1.0, P);
  vec4 z = A(clamp(ceil((0.5 + zf * (puv - 0.5)) * (W - 1.0)), vec2(0.0), W - 1.0));
  return mix(b, z, ss(0.0, 0.5, P));`),
  squeezeh: T(`  float z = 0.5 + (pix.y / W.y - 0.5) / max(P, 1e-6);
  return (z < 0.0 || z > 1.0) ? b : A(vec2(pix.x, floor(z * (W.y - 1.0) + 0.5)));`),
  squeezev: T(`  float z = 0.5 + (pix.x / W.x - 0.5) / max(P, 1e-6);
  return (z < 0.0 || z > 1.0) ? b : A(vec2(floor(z * (W.x - 1.0) + 0.5), pix.y));`),
};

/** Transitions whose inputs need a mip chain (they blur by mip level). */
export const XFADE_MIPS = new Set(["hblur"]);
/** Extra inputs: frand tables (frand.ts). */
export const XFADE_TEXTURES: Record<string, string[]> = { dissolve: ["u_rand2"], hlwind: ["u_rand"], hrwind: ["u_rand"], vuwind: ["u_rand"], vdwind: ["u_rand"] };
