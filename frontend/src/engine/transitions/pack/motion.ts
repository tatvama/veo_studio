/** Motion transitions (our own GLSL): whip pans, zoom-throughs, spins, stretch / squash, shake, swing and slides, each
 *  with a blur along its motion that peaks with the speed. Directions are baked into each variant's source. */
import type { PackParam, PackTransition } from "./types.ts";

const v2 = (x: number, y: number) => `vec2(${x.toFixed(1)}, ${y.toFixed(1)})`;
const EASE = `
float easeIO(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5; }
float speedIO(float t) { return t < 0.5 ? 12.0 * t * t : 12.0 * (1.0 - t) * (1.0 - t); }  // d/dt easeIO, peak 3
`;
const blurP: PackParam = { name: "blur", type: "float", default: 1, min: 0, max: 2, step: 0.01, description: "Motion blur" };

/** A push: the content moves along D, the incoming picture follows the outgoing one. */
const whip = (d: [number, number]) => `${EASE}
const vec2 D = ${v2(d[0], d[1])};
vec4 pushAt(vec2 uv, float o) {
  vec2 q = uv - D * o;
  return gInside(q) > 0.5 ? getFromColor(q) : getToColor(q + D);
}
vec4 transition(vec2 uv) {
  float e = easeIO(progress), len = blur * 0.32 * speedIO(progress) / 3.0;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) acc += pushAt(uv, e + (float(i) / 23.0 - 0.5) * len);
  return acc / 24.0;
}`;

/** In: the outgoing picture rushes in, the incoming one settles from close up; out: the reverse. Radial blur. */
const zoom = (into: boolean) => `${EASE}
vec4 zs(sampler2D t, vec2 uv, float s) { return texture(t, gMirror(0.5 + (uv - 0.5) / s)); }
vec4 transition(vec2 uv) {
  float t = progress;
  float k = t < 0.5 ? t * 2.0 : (1.0 - t) * 2.0;
  float e = k * k * k;
  float s = ${into ? "1.0 + 2.2 * e" : "1.0 / (1.0 + 1.4 * e)"};
  float spread = blur * 0.14 * k * k;
  vec4 a = vec4(0.0), b = vec4(0.0);
  for (int i = 0; i < 20; i++) {
    float f = 1.0 + spread * (float(i) / 19.0 - 0.5);
    a += zs(u_from, uv, s * f); b += zs(u_to, uv, s * f);
  }
  return mix(a, b, smoothstep(0.46, 0.54, t)) / 20.0;
}`;

const spin = (dir: number) => `${EASE}
vec4 rs(sampler2D t, vec2 uv, float ang, float s) {
  vec2 p = gRot(ang) * ((uv - 0.5) * vec2(ratio, 1.0)) / s;
  return texture(t, gMirror(p / vec2(ratio, 1.0) + 0.5));
}
vec4 transition(vec2 uv) {
  float t = progress;
  float k = t < 0.5 ? t * 2.0 : (1.0 - t) * 2.0;
  float e = k * k;
  float ang = ${dir.toFixed(1)} * (t < 0.5 ? e : -e) * PI * 0.5;
  float s = 1.0 + 0.7 * k;
  float spread = blur * 0.45 * k * k;
  vec4 a = vec4(0.0), b = vec4(0.0);
  for (int i = 0; i < 20; i++) {
    float o = spread * (float(i) / 19.0 - 0.5);
    a += rs(u_from, uv, ang + o, s); b += rs(u_to, uv, ang + o, s);
  }
  return mix(a, b, smoothstep(0.47, 0.53, t)) / 20.0;
}`;

/** Stretch (scale up along an axis, blurred) or squash (down to a line, on the background). */
const stretch = (axis: "x" | "y", squash: boolean) => `${EASE}
vec4 ss(sampler2D t, vec2 uv, float s) {
  vec2 q = uv;
  q.${axis} = 0.5 + (uv.${axis} - 0.5) / s;
  ${squash ? "return gInside(q) > 0.5 ? texture(t, q) : bgColor();" : "return texture(t, gMirror(q));"}
}
vec4 transition(vec2 uv) {
  float t = progress;
  float k = t < 0.5 ? t * 2.0 : (1.0 - t) * 2.0;
  float e = k * k * (3.0 - 2.0 * k);
  float s = ${squash ? "max(1.0 - 0.97 * e, 0.02)" : "1.0 + 5.0 * e * e"};
  float spread = blur * ${squash ? "0.0" : "0.25"} * k;
  vec4 a = vec4(0.0), b = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    vec2 o = vec2(0.0);
    o.${axis} = spread * (float(i) / 15.0 - 0.5);
    a += ss(u_from, uv + o, s); b += ss(u_to, uv + o, s);
  }
  vec4 c = mix(a, b, smoothstep(0.47, 0.53, t)) / 16.0;
  ${squash ? "c.rgb *= 1.0 + 1.5 * e * e;" : ""}
  return c;
}`;

const SHAKE = `
vec2 shakeAt(float t) {
  float f = t * 28.0, i = floor(f), u = fract(f);
  u = u * u * (3.0 - 2.0 * u);
  vec2 a = nHash2(vec2(i, seed)) - 0.5, b = nHash2(vec2(i + 1.0, seed)) - 0.5;
  return mix(a, b, u);
}
vec4 transition(vec2 uv) {
  float env = sin(progress * PI);
  env *= env;
  vec2 o = shakeAt(progress) * amount * env * vec2(1.0, 0.8);
  vec2 v = (shakeAt(progress + 0.01) - shakeAt(progress - 0.01)) * amount * env * blur;
  float zoom = 1.0 + amount * 1.6 * env;
  float m = smoothstep(0.35, 0.65, progress);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    vec2 q = 0.5 + (uv - 0.5) / zoom + o + v * (float(i) / 11.0 - 0.5);
    q = gMirror(q);
    acc += mix(getFromColor(q), getToColor(q), m);
  }
  return acc / 12.0;
}`;

/** A pendulum swing about a pivot above the frame: the outgoing picture swings away, the incoming one swings in. */
const swing = (dir: number) => `${EASE}
vec4 sw(sampler2D t, vec2 uv, float ang) {
  vec2 piv = vec2(0.0, -0.75);
  vec2 p = (uv - 0.5) * vec2(ratio, 1.0) - piv;
  p = gRot(ang) * p + piv;
  vec2 q = p / vec2(ratio, 1.0) + 0.5;
  return gInside(q) > 0.5 ? texture(t, q) : vec4(0.0);
}
vec4 transition(vec2 uv) {
  float t = progress;
  bool first = t < 0.5;
  float k = first ? t * 2.0 : (1.0 - t) * 2.0;
  float e = k * k * (3.0 - 2.0 * k);
  float ang = ${dir.toFixed(1)} * (first ? e : -e) * 1.25;
  float spread = blur * 0.18 * sin(k * PI * 0.5) * k;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) acc += first ? sw(u_from, uv, ang + spread * (float(i) / 11.0 - 0.5)) : sw(u_to, uv, ang + spread * (float(i) / 11.0 - 0.5));
  acc /= 12.0;
  vec4 bg = bgColor();
  return acc + bg * (1.0 - acc.a);
}`;

/** The incoming picture slides over the outgoing one, blurred along its motion. */
const slide = (d: [number, number]) => `${EASE}
const vec2 D = ${v2(d[0], d[1])};
vec4 transition(vec2 uv) {
  float e = easeIO(progress), len = blur * 0.18 * speedIO(progress) / 3.0;
  vec4 acc = vec4(0.0);
  float cov = 0.0;
  for (int i = 0; i < 16; i++) {
    vec2 q = uv + D * (1.0 - e + (float(i) / 15.0 - 0.5) * len);
    float inside = gInside(q);
    acc += getToColor(clamp(q, 0.0, 1.0)) * inside;
    cov += inside;
  }
  acc /= 16.0; cov /= 16.0;
  vec4 a = getFromColor(uv);
  a.rgb *= 1.0 - 0.25 * e;
  return a * (1.0 - cov) + acc;
}`;

const seedP: PackParam = { name: "seed", type: "float", default: 7, min: 0, max: 100, step: 1 };
export const MOTION: PackTransition[] = [
  { id: "whip_left", label: "Whip pan left", group: "Motion", glsl: whip([-1, 0]), params: [blurP] },
  { id: "whip_right", label: "Whip pan right", group: "Motion", glsl: whip([1, 0]), params: [blurP] },
  { id: "whip_up", label: "Whip pan up", group: "Motion", glsl: whip([0, -1]), params: [blurP] },
  { id: "whip_down", label: "Whip pan down", group: "Motion", glsl: whip([0, 1]), params: [blurP] },
  { id: "zoom_in", label: "Zoom through (in)", group: "Motion", glsl: zoom(true), params: [blurP] },
  { id: "zoom_out", label: "Zoom through (out)", group: "Motion", glsl: zoom(false), params: [blurP] },
  { id: "spin_cw", label: "Spin clockwise", group: "Motion", glsl: spin(1), params: [blurP] },
  { id: "spin_ccw", label: "Spin anticlockwise", group: "Motion", glsl: spin(-1), params: [blurP] },
  { id: "stretch", label: "Stretch", group: "Motion", glsl: stretch("x", false), params: [blurP] },
  { id: "squash", label: "Squash", group: "Motion", glsl: stretch("y", true), params: [blurP] },
  { id: "shake", label: "Camera shake", group: "Motion", glsl: SHAKE, params: [{ name: "amount", type: "float", default: 0.08, min: 0, max: 0.3, step: 0.005 }, blurP, seedP] },
  { id: "swing_left", label: "Swing left", group: "Motion", glsl: swing(1), params: [blurP] },
  { id: "swing_right", label: "Swing right", group: "Motion", glsl: swing(-1), params: [blurP] },
  { id: "slide_left", label: "Slide left (motion blur)", group: "Motion", glsl: slide([-1, 0]), params: [blurP] },
  { id: "slide_right", label: "Slide right (motion blur)", group: "Motion", glsl: slide([1, 0]), params: [blurP] },
  { id: "slide_up", label: "Slide up (motion blur)", group: "Motion", glsl: slide([0, -1]), params: [blurP] },
  { id: "slide_down", label: "Slide down (motion blur)", group: "Motion", glsl: slide([0, 1]), params: [blurP] },
];
