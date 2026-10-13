/**
 * GLSL ES 3.00 for the clip pipeline (docs/ENGINE.md §4 steps 1–3), compositing, present and the YUV read-back.
 * The clip shader is one source with #defines per effect, so a clip with a LUT and an eq compiles to a program that
 * does only that; programs are cached by source. Colour maths follows what FFmpeg does for the same fx (checked
 * against FFmpeg 7.1 on test colours): eq / hue / vignette / noise work on BT.709 limited-range YCbCr code values,
 * colorbalance / vibrance / curves / LUTs on RGB. Like FFmpeg, a YUV filter only clips code values: its RGB result may
 * leave 0..1 (half-float targets keep it, the YUV read-back writes the same codes); an RGB filter clips its input.
 */
import { OUTPUT_GLSL } from "../colour.ts";
import { YUV_GLSL } from "../yuv.ts";

export const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
in vec2 v_uv;
out vec4 o_color;
uniform vec2 u_res;
const vec3 K709 = vec3(0.2126, 0.7152, 0.0722);
vec3 toYcc(vec3 c) {
  float y = dot(c, K709);
  return vec3(16.0 + 219.0 * y, 128.0 + 224.0 * (c.b - y) / 1.8556, 128.0 + 224.0 * (c.r - y) / 1.5748) / 255.0;
}
vec3 fromYcc(vec3 q) {
  vec3 k = q * 255.0;
  float y = (k.x - 16.0) / 219.0, pb = (k.y - 128.0) / 224.0, pr = (k.z - 128.0) / 224.0;
  float r = y + 1.5748 * pr, b = y + 1.8556 * pb;
  return vec3(r, (y - 0.2126 * r - 0.0722 * b) / 0.7152, b);
}
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float rand3(uvec3 p) { return float(pcg(p.x ^ pcg(p.y ^ pcg(p.z)))) / 4294967295.0; }
float max3(vec3 c) { return max(c.r, max(c.g, c.b)); }
float min3(vec3 c) { return min(c.r, min(c.g, c.b)); }
`;

/** The rotated, feathered rectangle / ellipse of a mask (fx.mask, an effect's mask). */
export const MASK_GLSL = `uniform vec4 u_mask;   // centre x, y, size w, h (fractions of the frame)
uniform vec4 u_mask2;  // rotation (radians, clockwise), feather, invert, shape (0 rect, 1 ellipse)
float maskAt(vec2 uv) {
  vec2 p = (uv - u_mask.xy) * u_res;
  float cr = cos(u_mask2.x), sr = sin(u_mask2.x);
  p = vec2(cr * p.x + sr * p.y, -sr * p.x + cr * p.y);
  vec2 hs = max(u_mask.zw * u_res * 0.5, vec2(1.0));
  float d;
  if (u_mask2.w > 0.5) d = (length(p / hs) - 1.0) * min(hs.x, hs.y);
  else { vec2 q = abs(p) - hs; d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
  float band = max(u_mask2.y * min(hs.x, hs.y), 0.75);
  float m = 1.0 - smoothstep(-band, band, d);
  return u_mask2.z > 0.5 ? 1.0 - m : m;
}`;

export interface ClipFlags {
  /** Sample the clip's source through the framing transform (else only `input`). */
  src: boolean;
  /** Start from a previous pass's output. */
  input: boolean;
  lut?: boolean; eq?: boolean; cb?: boolean; vib?: boolean; hue?: boolean; wheels?: boolean; curves?: boolean; chroma?: boolean;
  glowAdd?: boolean; vig?: boolean; grain?: boolean; mask?: boolean; fade?: boolean;
  /** Stills: re-express the picture so the YUV out is FFmpeg's BT.601 encode of it. */
  srcm?: boolean;
  /** Run the RGB filters (LUT, colorbalance, vibrance) on the RGB FFmpeg would see (BT.601 for untagged / stills). */
  ffm?: boolean;
  /** A preset look run as its FFmpeg filters: the GLSL of `vec3 nativeLook(vec3 c)` (effects/looks.ts). */
  nlook?: string;
}

const CLIP_BODY = `
#ifdef SRC
uniform sampler2D u_src;
uniform vec4 u_xf;
uniform float u_contain;
#ifdef SRCM
uniform mat3 u_srcM;
#endif
vec4 source(vec2 uv) {
  vec2 s = uv * u_xf.xy + u_xf.zw;
  vec4 c = texture(u_src, s);
#ifdef SRCM
  c.rgb = u_srcM * c.rgb;
#endif
  if (u_contain > 0.5) { vec2 e = step(vec2(0.0), s) * step(s, vec2(1.0)); c *= e.x * e.y; }
  return c;
}
#endif
#ifdef FFM
uniform mat3 u_ffm;
uniform mat3 u_ffmInv;
vec3 ffIn(vec3 c) { return u_ffm * c; }
vec3 ffOut(vec3 c) { return u_ffmInv * c; }
#else
vec3 ffIn(vec3 c) { return c; }
vec3 ffOut(vec3 c) { return c; }
#endif
#ifdef INPUT
uniform sampler2D u_in;
#endif
#ifdef LUT
uniform sampler3D u_lut;
uniform float u_lutN;
uniform vec3 u_lutMin;
uniform vec3 u_lutMax;
uniform float u_lutMix;
vec3 lutAt(ivec3 p) { return texelFetch(u_lut, p, 0).rgb; }
// tetrahedral, as FFmpeg's lut3d=interp=tetrahedral
vec3 applyLut(vec3 c) {
  vec3 p = clamp((c - u_lutMin) / (u_lutMax - u_lutMin), 0.0, 1.0) * (u_lutN - 1.0);
  vec3 i0 = min(floor(p), vec3(u_lutN - 2.0));
  vec3 f = p - i0;
  ivec3 b = ivec3(i0);
  vec3 c000 = lutAt(b), c111 = lutAt(b + ivec3(1));
  vec3 o;
  if (f.r > f.g) {
    if (f.g > f.b) o = (1.0 - f.r) * c000 + (f.r - f.g) * lutAt(b + ivec3(1, 0, 0)) + (f.g - f.b) * lutAt(b + ivec3(1, 1, 0)) + f.b * c111;
    else if (f.r > f.b) o = (1.0 - f.r) * c000 + (f.r - f.b) * lutAt(b + ivec3(1, 0, 0)) + (f.b - f.g) * lutAt(b + ivec3(1, 0, 1)) + f.g * c111;
    else o = (1.0 - f.b) * c000 + (f.b - f.r) * lutAt(b + ivec3(0, 0, 1)) + (f.r - f.g) * lutAt(b + ivec3(1, 0, 1)) + f.g * c111;
  } else {
    if (f.b > f.g) o = (1.0 - f.b) * c000 + (f.b - f.g) * lutAt(b + ivec3(0, 0, 1)) + (f.g - f.r) * lutAt(b + ivec3(0, 1, 1)) + f.r * c111;
    else if (f.b > f.r) o = (1.0 - f.g) * c000 + (f.g - f.b) * lutAt(b + ivec3(0, 1, 0)) + (f.b - f.r) * lutAt(b + ivec3(0, 1, 1)) + f.r * c111;
    else o = (1.0 - f.g) * c000 + (f.g - f.r) * lutAt(b + ivec3(0, 1, 0)) + (f.r - f.b) * lutAt(b + ivec3(1, 1, 0)) + f.b * c111;
  }
  return mix(c, o, u_lutMix);
}
#endif
#ifdef EQ
uniform vec4 u_eq;   // brightness, contrast, gamma, saturation
uniform vec2 u_eqOn; // luma, chroma
uniform vec4 u_eqInt; // FFmpeg's integer path: luma contrast·4096, luma offset, chroma contrast·4096, chroma offset
// eq with gamma: FFmpeg's 256-entry table (256·v, truncated)
float eqLut(float v, float c, float b, float g) {
  v = c * (v - 0.5) + 0.5 + b;
  if (v <= 0.0) return 0.0;
  return clamp((256.0 * pow(v, 1.0 / g) - 0.5) / 255.0, 0.0, 1.0);
}
// eq without gamma: FFmpeg's integer path, pel = (src·k >> 12) + offset (k, offset from params.ts eqInt)
float eqLin(float v, float k, float off) { return clamp((floor(floor(v * 255.0 + 0.5) * k / 4096.0) + off) / 255.0, 0.0, 1.0); }
vec3 applyEq(vec3 c) {
  vec3 q = clamp(toYcc(c), 0.0, 1.0);
  if (u_eqOn.x > 0.5) q.x = abs(u_eq.z - 1.0) > 1e-6 ? eqLut(q.x, u_eq.y, u_eq.x, u_eq.z) : eqLin(q.x, u_eqInt.x, u_eqInt.y);
  if (u_eqOn.y > 0.5) q.yz = vec2(eqLin(q.y, u_eqInt.z, u_eqInt.w), eqLin(q.z, u_eqInt.z, u_eqInt.w));
  return fromYcc(q);
}
#endif
#ifdef CB
uniform vec3 u_cbS;
uniform vec3 u_cbM;
uniform vec3 u_cbH;
// FFmpeg colorbalance: l = max + min (not halved), ramps of width 1/4 at 1/3 and 2/3
float cbComp(float v, float l, float s, float m, float h) {
  s *= clamp((0.333 - l) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  m *= clamp((l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * clamp((1.0 - l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  h *= clamp((l + 0.333 - 1.0) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  return clamp(v + s + m + h, 0.0, 1.0);
}
vec3 applyCb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float l = max3(c) + min3(c);
  return vec3(cbComp(c.r, l, u_cbS.r, u_cbM.r, u_cbH.r), cbComp(c.g, l, u_cbS.g, u_cbM.g, u_cbH.g), cbComp(c.b, l, u_cbS.b, u_cbM.b, u_cbH.b));
}
#endif
#ifdef VIB
uniform float u_vib;
// FFmpeg vibrance as measured: luma weights r 0.072186, g 0.715158, b 0.212656; k = 1 + i·(1 + sign(i)·(max − min))
vec3 applyVib(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float l = dot(c, vec3(0.072186, 0.715158, 0.212656));
  float k = 1.0 + u_vib * (1.0 + sign(u_vib) * (max3(c) - min3(c)));
  return clamp(mix(vec3(l), c, k), 0.0, 1.0);
}
#endif
#ifdef HUE
uniform vec2 u_hue; // cos, sin
vec3 applyHue(vec3 c) {
  vec3 q = clamp(toYcc(c), 0.0, 1.0);
  vec2 d = q.yz - 128.0 / 255.0;
  q.yz = vec2(u_hue.x * d.x - u_hue.y * d.y, u_hue.y * d.x + u_hue.x * d.y) + 128.0 / 255.0;
  return fromYcc(clamp(q, 0.0, 1.0));
}
#endif
#ifdef WHEELS
uniform vec3 u_lift;  // offset of the blacks
uniform vec3 u_gain;  // multiplier
uniform vec3 u_gam;   // exponent
vec3 applyWheels(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  c = (c + u_lift * (1.0 - c)) * u_gain;
  return clamp(pow(max(c, 0.0), u_gam), 0.0, 1.0);
}
#endif
#ifdef CURVES
uniform sampler2D u_curves;
vec3 applyCurves(vec3 c) {
  vec3 x = clamp(c, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
  return vec3(texture(u_curves, vec2(x.r, 0.5)).r, texture(u_curves, vec2(x.g, 0.5)).g, texture(u_curves, vec2(x.b, 0.5)).b);
}
#endif
#ifdef CHROMA
uniform vec2 u_keyCC;  // the key's CbCr
uniform vec3 u_key;    // similarity, smoothness, spill (OBS-style)
vec4 applyChroma(vec4 c) {
  vec3 q = toYcc(clamp(c.rgb, 0.0, 1.0));
  float base = distance(q.yz, u_keyCC) - u_key.x;
  float a = pow(clamp(base / max(u_key.y, 1e-4), 0.0, 1.0), 1.5);
  float spill = pow(clamp(base / max(u_key.z, 1e-4), 0.0, 1.0), 1.5);
  c.rgb = mix(vec3(dot(c.rgb, K709)), c.rgb, spill);
  return vec4(c.rgb, c.a * a);
}
#endif
#ifdef GLOW_ADD
uniform sampler2D u_glow;
uniform float u_glowAmt;
#endif
#ifdef VIG
uniform float u_vig;
// FFmpeg vignette: cos(angle·d)^4, d = distance from the centre / half diagonal; in YUV it scales Y codes (with the
// 16 offset) and chroma alike, which in RGB is c·f − 16/219·(1 − f)
vec3 applyVig(vec3 c) {
  vec2 d = (gl_FragCoord.xy - 0.5) - u_res * 0.5;
  float dn = length(d) / length(u_res * 0.5);
  float k = cos(u_vig * dn);
  float f = dn > 1.0 ? 0.0 : k * k * k * k;
  return c * f - (16.0 / 219.0) * (1.0 - f);
}
#endif
#ifdef GRAIN
uniform float u_grain;  // code values (noise=alls=N: uniform in ±N/2 on Y, Cb and Cr; chroma at half resolution)
uniform float u_frame;
vec3 applyGrain(vec3 c) {
  uvec2 px = uvec2(gl_FragCoord.xy);
  uint fr = uint(u_frame);
  vec3 n = vec3(rand3(uvec3(px, fr)), rand3(uvec3(px / 2u, fr + 7919u)), rand3(uvec3(px / 2u, fr + 104729u))) - 0.5;
  vec3 q = clamp(toYcc(c), 0.0, 1.0) + n * u_grain / 255.0;
  return fromYcc(clamp(q, 0.0, 1.0));
}
#endif
#ifdef MASK
${MASK_GLSL}
#endif
#ifdef NLOOK
// a preset look as its FFmpeg filters (effects/looks.ts writes nativeLook() from these)
uniform float u_lookMix;
float nlEqLut(float v, float c, float b, float g) {
  v = c * (v - 0.5) + 0.5 + b;
  if (v <= 0.0) return 0.0;
  return clamp((256.0 * pow(v, 1.0 / g) - 0.5) / 255.0, 0.0, 1.0);
}
float nlEqLin(float v, float k, float off) { return clamp((floor(floor(v * 255.0 + 0.5) * k / 4096.0) + off) / 255.0, 0.0, 1.0); }
vec3 nlEq(vec3 c, vec4 p, vec2 on, vec4 ki) {
  vec3 q = clamp(toYcc(c), 0.0, 1.0);
  if (on.x > 0.5) q.x = abs(p.z - 1.0) > 1e-6 ? nlEqLut(q.x, p.y, p.x, p.z) : nlEqLin(q.x, ki.x, ki.y);
  if (on.y > 0.5) q.yz = vec2(nlEqLin(q.y, ki.z, ki.w), nlEqLin(q.z, ki.z, ki.w));
  return fromYcc(q);
}
float nlCbComp(float v, float l, float s, float m, float h) {
  s *= clamp((0.333 - l) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  m *= clamp((l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * clamp((1.0 - l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  h *= clamp((l + 0.333 - 1.0) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  return clamp(v + s + m + h, 0.0, 1.0);
}
vec3 nlCb(vec3 c, vec3 s, vec3 m, vec3 h) {
  c = clamp(ffIn(c), 0.0, 1.0);
  float l = max3(c) + min3(c);
  return ffOut(vec3(nlCbComp(c.r, l, s.r, m.r, h.r), nlCbComp(c.g, l, s.g, m.g, h.g), nlCbComp(c.b, l, s.b, m.b, h.b)));
}
vec3 nlVib(vec3 c, float i) {
  c = clamp(ffIn(c), 0.0, 1.0);
  float l = dot(c, vec3(0.072186, 0.715158, 0.212656));
  float k = 1.0 + i * (1.0 + sign(i) * (max3(c) - min3(c)));
  return ffOut(clamp(mix(vec3(l), c, k), 0.0, 1.0));
}
vec3 nlHue(vec3 c, vec2 cs, float s) {
  vec3 q = clamp(toYcc(c), 0.0, 1.0);
  vec2 d = q.yz - 128.0 / 255.0;
  q.yz = vec2(cs.x * d.x - cs.y * d.y, cs.y * d.x + cs.x * d.y) * s + 128.0 / 255.0;
  return fromYcc(clamp(q, 0.0, 1.0));
}
vec3 nlCcm(vec3 c, vec3 r, vec3 g, vec3 b) {
  c = clamp(ffIn(c), 0.0, 1.0);
  return ffOut(clamp(vec3(dot(c, r), dot(c, g), dot(c, b)), 0.0, 1.0));
}
// negate on limited-range YUV: maxval + minval - clip(v)
vec3 nlNeg(vec3 c) {
  vec3 k = clamp(toYcc(c), 0.0, 1.0) * 255.0;
  k = vec3(251.0 - clamp(k.x, 16.0, 235.0), 256.0 - clamp(k.yz, 16.0, 240.0));
  return fromYcc(k / 255.0);
}
NLOOK_FN
#endif
#ifdef FADE
uniform float u_fade;
#endif
void main() {
#ifdef SRC
  vec4 orig = source(v_uv);
#else
  vec4 orig = vec4(0.0);
#endif
#ifdef INPUT
  vec4 c = texture(u_in, v_uv);
#else
  vec4 c = orig;
#endif
  vec3 rgb = c.rgb;
#ifdef LUT
  rgb = ffOut(applyLut(ffIn(rgb)));
#endif
#ifdef NLOOK
  rgb = mix(rgb, nativeLook(rgb), u_lookMix);
#endif
#ifdef EQ
  rgb = applyEq(rgb);
#endif
#ifdef CB
  rgb = ffOut(applyCb(ffIn(rgb)));
#endif
#ifdef VIB
  rgb = ffOut(applyVib(ffIn(rgb)));
#endif
#ifdef HUE
  rgb = applyHue(rgb);
#endif
#ifdef WHEELS
  rgb = applyWheels(rgb);
#endif
#ifdef CURVES
  rgb = applyCurves(rgb);
#endif
  c.rgb = rgb;
#ifdef CHROMA
  c = applyChroma(c);
#endif
#ifdef GLOW_ADD
  c.rgb = 1.0 - (1.0 - clamp(c.rgb, 0.0, 1.0)) * (1.0 - clamp(texture(u_glow, v_uv).rgb * u_glowAmt, 0.0, 1.0));
#endif
#ifdef VIG
  c.rgb = applyVig(c.rgb);
#endif
#ifdef GRAIN
  c.rgb = applyGrain(c.rgb);
#endif
#ifdef MASK
  c = mix(orig, c, maskAt(v_uv));
#endif
#ifdef FADE
  c.rgb *= u_fade;
#endif
  o_color = c;
}
`;

const DEFINES: [keyof ClipFlags, string][] = [["src", "SRC"], ["input", "INPUT"], ["srcm", "SRCM"], ["ffm", "FFM"], ["lut", "LUT"], ["eq", "EQ"], ["cb", "CB"], ["vib", "VIB"],
  ["hue", "HUE"], ["wheels", "WHEELS"], ["curves", "CURVES"], ["chroma", "CHROMA"], ["glowAdd", "GLOW_ADD"], ["vig", "VIG"], ["grain", "GRAIN"],
  ["mask", "MASK"], ["fade", "FADE"]];

/** The clip shader for a set of effects; the name lists them (shown in compile errors). */
export function clipShader(f: ClipFlags): { name: string; source: string } {
  const on = DEFINES.filter(([k]) => f[k]).map(([, d]) => d);
  if (f.nlook) on.push("NLOOK");
  const src = HEADER.replace("#version 300 es\n", `#version 300 es\n${on.map((d) => `#define ${d}\n`).join("")}`);
  return { name: `clip[${on.join(",").toLowerCase()}]`, source: src + CLIP_BODY.replace("NLOOK_FN", f.nlook ?? "") };
}

/** unsharp=5:5:amount on luma codes: the 5×5 binomial blur as 3×3 bilinear taps, Y' = Y + amount·(Y − blur(Y)), clipped. */
export const UNSHARP = HEADER + `
uniform sampler2D u_in;
uniform float u_amount;
uniform float u_step;
void main() {
  vec4 c = texture(u_in, v_uv);
  vec2 px = u_step / u_res;
  float o = 1.2, wc = 6.0 / 16.0, ws = 5.0 / 16.0;
  float blur = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float w = (i == 0 ? wc : ws) * (j == 0 ? wc : ws);
    blur += w * dot(texture(u_in, v_uv + vec2(float(i), float(j)) * o * px).rgb, K709);
  }
  vec3 q = toYcc(c.rgb);
  q.x = clamp(q.x + u_amount * (dot(c.rgb, K709) - blur) * 219.0 / 255.0, 0.0, 1.0);
  o_color = vec4(fromYcc(q), c.a);
}`;

/** One direction of a separable blur, premultiplied so keyed edges don't darken; taps are (offset px, weight). */
export const BLUR = HEADER + `
uniform sampler2D u_in;
uniform vec2 u_dir;
uniform float u_w0;
uniform vec2 u_taps[32];
uniform int u_n;
vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }
void main() {
  vec4 acc = pm(texture(u_in, v_uv)) * u_w0;
  for (int i = 0; i < 32; i++) {
    if (i >= u_n) break;
    vec2 o = u_dir * u_taps[i].x / u_res;
    acc += (pm(texture(u_in, v_uv + o)) + pm(texture(u_in, v_uv - o))) * u_taps[i].y;
  }
  o_color = acc.a > 1e-5 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);
}`;

/** gblur on yuv420p: luma with one kernel, chroma (a half-size plane in FFmpeg) with another twice as wide. */
export const GBLUR = HEADER + `
uniform sampler2D u_in;
uniform vec2 u_dir;
uniform float u_w0;
uniform vec2 u_taps[32];
uniform int u_n;
uniform float u_cw0;
uniform vec2 u_ctaps[32];
uniform int u_cn;
void main() {
  vec4 c = texture(u_in, v_uv);
  vec3 q0 = toYcc(c.rgb);
  float y = q0.x * u_w0;
  vec2 ch = q0.yz * u_cw0;
  for (int i = 0; i < 32; i++) {
    if (i >= u_n) break;
    vec2 o = u_dir * u_taps[i].x / u_res;
    y += (toYcc(texture(u_in, v_uv + o).rgb).x + toYcc(texture(u_in, v_uv - o).rgb).x) * u_taps[i].y;
  }
  for (int i = 0; i < 32; i++) {
    if (i >= u_cn) break;
    vec2 o = u_dir * u_ctaps[i].x / u_res;
    ch += (toYcc(texture(u_in, v_uv + o).rgb).yz + toYcc(texture(u_in, v_uv - o).rgb).yz) * u_ctaps[i].y;
  }
  o_color = vec4(fromYcc(vec3(y, ch)), c.a);
}`;

/** Glow: the highlights above the threshold, drawn into a half-size target. */
export const GLOW_EXTRACT = HEADER + `
uniform sampler2D u_in;
uniform float u_thr;
void main() {
  vec4 c = texture(u_in, v_uv);
  o_color = vec4(max(c.rgb - u_thr, 0.0) / max(1.0 - u_thr, 1e-3) * c.a, 1.0);
}`;

/** A picture over what's there: a transformed rectangle (layers; the main track covers the frame), straight alpha,
 *  W3C separable blend modes. */
export const COMPOSITE = HEADER + `
uniform sampler2D u_dst;
uniform sampler2D u_layer;
uniform vec2 u_center;
uniform vec2 u_size;
uniform vec2 u_rot;
uniform float u_opacity;
uniform int u_mode;
vec3 blendMode(vec3 b, vec3 s, int m) {
  if (m == 1) return min(b + s, 1.0);
  if (m == 2) return b * s;
  if (m == 3) return 1.0 - (1.0 - b) * (1.0 - s);
  if (m == 4) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (m == 5) return max(b, s);
  if (m == 6) return min(b, s);
  return s;
}
uniform float u_inPm;   // the layer is premultiplied (a transition's output on a track with transparency)
uniform float u_outPm;  // write premultiplied (a transition's input)
void main() {
  vec4 dst = texture(u_dst, v_uv);
  vec2 p = v_uv * u_res - u_center;
  vec2 q = vec2(u_rot.x * p.x + u_rot.y * p.y, -u_rot.y * p.x + u_rot.x * p.y);
  vec2 luv = q / u_size + 0.5;
  vec2 cov = clamp((0.5 - abs(luv - 0.5)) * abs(u_size) + 0.5, 0.0, 1.0);
  vec4 s = texture(u_layer, luv);
  if (u_inPm > 0.5) s.rgb = s.a > 1e-6 ? s.rgb / s.a : vec3(0.0);
  float a = clamp(s.a * u_opacity * cov.x * cov.y, 0.0, 1.0);
  // normal passes values through unclamped (xfade's below-black fill must reach the YUV read-back)
  vec3 cs = u_mode == 0 ? s.rgb : mix(s.rgb, blendMode(clamp(dst.rgb, 0.0, 1.0), clamp(s.rgb, 0.0, 1.0), u_mode), dst.a);
  float oa = a + dst.a * (1.0 - a);
  vec4 o = oa > 1e-6 ? vec4((cs * a + dst.rgb * dst.a * (1.0 - a)) / oa, oa) : vec4(0.0);
  if (u_outPm > 0.5) o.rgb *= o.a;
  o_color = o;
}`;

/** An effect confined to a shape: the effect's output inside the mask, its input outside. */
export const MASK_MIX = HEADER + `
uniform sampler2D u_a;
uniform sampler2D u_b;
${MASK_GLSL}
void main() { o_color = mix(texture(u_a, v_uv), texture(u_b, v_uv), maskAt(v_uv)); }`;

/** A fade multiplier on a picture (main-track clips with registry effects fade after them). */
export const FADE = HEADER + `
uniform sampler2D u_in;
uniform float u_fade;
void main() { vec4 c = texture(u_in, v_uv); o_color = vec4(c.rgb * u_fade, c.a); }`;

/** A decoded video frame's planes → RGB with BT.709 (the read-back's own matrix, so a plain clip's YUV comes back
 *  unchanged), nearest chroma, nothing clipped. Full-range sources are mapped to limited range, as FFmpeg's
 *  yuvj → yuv420p does. */
export const YUV2RGB = HEADER + `
uniform sampler2D u_y;
uniform sampler2D u_c;
uniform sampler2D u_c2;
uniform float u_nv12;
uniform float u_full;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float Y = texelFetch(u_y, p, 0).r;
  ivec2 q = p / 2;
  vec2 C = u_nv12 > 0.5 ? texelFetch(u_c, q, 0).rg : vec2(texelFetch(u_c, q, 0).r, texelFetch(u_c2, q, 0).r);
  vec3 ycc = vec3(Y, C);
  if (u_full > 0.5) ycc = vec3((16.0 + 219.0 * Y) / 255.0, (128.0 + (C * 255.0 - 128.0) * 224.0 / 255.0) / 255.0);
  o_color = vec4(fromYcc(ycc), 1.0);
}`;

/** The frame onto the canvas (the only place rows flip). */
export const PRESENT = HEADER + `
uniform sampler2D u_in;
void main() { o_color = vec4(clamp(texture(u_in, vec2(v_uv.x, 1.0 - v_uv.y)).rgb, 0.0, 1.0), 1.0); }`;

/** Draws a texture as is (copies, scaled). */
export const COPY = HEADER + `
uniform sampler2D u_in;
void main() { o_color = texture(u_in, v_uv); }`;

/** Packs the frame into the YUV 4:2:0 layout of yuv.ts (four samples per RGBA8 texel). */
export const YUV_PACK = HEADER + YUV_GLSL + `
uniform sampler2D u_in;
uniform ivec2 u_size;
uniform int u_texW;
uniform int u_cRows;
// not clamped: xfade's below-black / above-white fills must reach the codes (the RGBA8 write clamps them to 0..255)
vec3 px(ivec2 p) { return texelFetch(u_in, clamp(p, ivec2(0), u_size - 1), 0).rgb; }
vec2 chroma(ivec2 c) {
  ivec2 p = c * 2;
  vec3 s = px(p) + px(p + ivec2(1, 0)) + px(p + ivec2(0, 1)) + px(p + ivec2(1, 1));
  return yuvUV(s * 0.25);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int h = u_size.y;
  if (t.y < h) {
    int x = t.x * 4;
    o_color = vec4(yuvY(px(ivec2(x, t.y))), yuvY(px(ivec2(x + 1, t.y))), yuvY(px(ivec2(x + 2, t.y))), yuvY(px(ivec2(x + 3, t.y))));
    return;
  }
  int rr = t.y - h;
  int plane = 0;
  if (rr >= u_cRows) { rr -= u_cRows; plane = 1; }
  int half_ = u_texW / 2;
  int cy = t.x < half_ ? 2 * rr : 2 * rr + 1;
  int cx = 4 * (t.x < half_ ? t.x : t.x - half_);
  ivec2 cs = u_size / 2;
  if (cy >= cs.y) { o_color = vec4(0.5); return; }
  vec4 o;
  for (int k = 0; k < 4; k++) {
    vec2 c = chroma(ivec2(min(cx + k, cs.x - 1), cy));
    o[k] = plane == 0 ? c.x : c.y;
  }
  o_color = o;
}`;

/** Packs the frame into the 10-bit 4:2:0 layout of yuv.ts (yuv10Layout: two 16-bit samples per RGBA8 texel), through
 *  the output's transfer and primaries (colour.ts encodeOutput, BT.709 or BT.2020 non-constant-luminance matrix). */
export const YUV10_PACK = HEADER + OUTPUT_GLSL + `
uniform sampler2D u_in;
uniform ivec2 u_size;
uniform int u_texW;
uniform int u_cRows;
uniform vec2 u_out;
vec3 sig(ivec2 p) { return encodeOut(texelFetch(u_in, clamp(p, ivec2(0), u_size - 1), 0).rgb, u_out); }
vec4 bytes2(float a, float b) {
  a = clamp(floor(a + 0.5), 0.0, 1023.0); b = clamp(floor(b + 0.5), 0.0, 1023.0);
  return vec4(mod(a, 256.0), floor(a / 256.0), mod(b, 256.0), floor(b / 256.0)) / 255.0;
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int h = u_size.y;
  if (t.y < h) {
    int x = t.x * 2;
    o_color = bytes2(ycc10(sig(ivec2(x, t.y)), u_out).x, ycc10(sig(ivec2(x + 1, t.y)), u_out).x);
    return;
  }
  int rr = t.y - h;
  int plane = 0;
  if (rr >= u_cRows) { rr -= u_cRows; plane = 1; }
  int half_ = u_texW / 2;
  int cy = t.x < half_ ? 2 * rr : 2 * rr + 1;
  int cx = 2 * (t.x < half_ ? t.x : t.x - half_);
  ivec2 cs = u_size / 2;
  if (cy >= cs.y) { o_color = bytes2(512.0, 512.0); return; }
  float v0 = 512.0, v1 = 512.0;
  for (int k = 0; k < 2; k++) {
    ivec2 p = ivec2(min(cx + k, cs.x - 1), cy) * 2;
    vec3 s = (sig(p) + sig(p + ivec2(1, 0)) + sig(p + ivec2(0, 1)) + sig(p + ivec2(1, 1))) * 0.25;
    vec3 y = ycc10(s, u_out);
    float v = plane == 0 ? y.y : y.z;
    if (k == 0) v0 = v; else v1 = v;
  }
  o_color = bytes2(v0, v1);
}`;

/** A picture cropped to fill the target (cover), for thumbnails of a user's own frame. */
export const COVER = HEADER + `
uniform sampler2D u_in;
uniform vec2 u_scale;
void main() { o_color = texture(u_in, (v_uv - 0.5) * u_scale + 0.5); }`;
