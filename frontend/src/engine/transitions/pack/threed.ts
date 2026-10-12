/** 3D transitions (our own GLSL): ray-cast pictures on rectangles in a small scene (camera at z = −D looking at the
 *  frame on z = 0, x right, y down, z away): flips, book folds, a page roll, cubes outside and in, doors, a box and a
 *  grid of cards. */
import type { PackParam, PackTransition } from "./types.ts";

const RAY = `
const float CAM = 2.0;
vec3 rayDir(vec2 uv) { return normalize(vec3((uv.x - 0.5) * ratio, uv.y - 0.5, CAM)); }
// rotation of a point about the y / x axis
vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
vec3 rotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
// a rectangle: centre C, half-axes U (width) and V (height, down). st in -1..1; front = the side facing −(U×V)
bool hitRect(vec3 ro, vec3 rd, vec3 C, vec3 U, vec3 V, out vec2 st, out float t, out bool front) {
  vec3 N = cross(U, V);
  float den = dot(rd, N);
  if (abs(den) < 1e-7) return false;
  t = dot(C - ro, N) / den;
  if (t <= 1e-4) return false;
  vec3 q = ro + rd * t - C;
  st = vec2(dot(q, U) / dot(U, U), dot(q, V) / dot(V, V));
  front = den > 0.0;
  return abs(st.x) <= 1.0 && abs(st.y) <= 1.0;
}
float shadeOf(vec3 rd, vec3 U, vec3 V) { return mix(0.45, 1.0, abs(dot(normalize(cross(U, V)), rd))); }
vec4 shaded(vec4 c, float k) { return vec4(c.rgb * k, c.a); }
// st → texture uv
vec2 tuv(vec2 st) { return st * 0.5 + 0.5; }
float ease3(float t) { return t * t * (3.0 - 2.0 * t); }
`;

/** A card flipping about its vertical (h) or horizontal (v) axis, pulled back half-way. */
const flip = (vertical: boolean) => `${RAY}
vec4 transition(vec2 uv) {
  float e = ease3(progress);
  float a = e * PI;
  vec3 ro = vec3(0.0, 0.0, -CAM), rd = rayDir(uv);
  vec3 C = vec3(0.0, 0.0, sin(progress * PI) * depth);
  vec3 U = vec3(ratio * 0.5, 0.0, 0.0), V = vec3(0.0, 0.5, 0.0);
  ${vertical ? "U = rotX(U, a); V = rotX(V, a);" : "U = rotY(U, a); V = rotY(V, a);"}
  vec2 st; float t; bool fr;
  if (!hitRect(ro, rd, C, U, V, st, t, fr)) return bgColor();
  float k = shadeOf(rd, U, V);
  ${vertical ? "return fr ? shaded(getFromColor(tuv(st)), k) : shaded(getToColor(tuv(vec2(st.x, -st.y))), k);"
    : "return fr ? shaded(getFromColor(tuv(st)), k) : shaded(getToColor(tuv(vec2(-st.x, st.y))), k);"}
}`;

/** A book page: the outgoing picture's right half turns over the spine; its back is the incoming left half. */
const fold = (vertical: boolean) => `${RAY}
vec4 sideA(vec2 u) { return getFromColor(${vertical ? "u.yx" : "u"}); }
vec4 sideB(vec2 u) { return getToColor(${vertical ? "u.yx" : "u"}); }
vec4 transition(vec2 uv0) {
  vec2 uv = ${vertical ? "uv0.yx" : "uv0"};
  float R = ${vertical ? "1.0 / ratio" : "ratio"};
  float e = ease3(progress);
  float a = e * PI;
  vec3 ro = vec3(0.0, 0.0, -CAM);
  vec3 rd = normalize(vec3((uv.x - 0.5) * R, uv.y - 0.5, CAM));
  // the page: hinged at x = 0, from the spine (st.x = -1) to the free edge (+1), lifting toward the camera
  vec3 U = rotY(vec3(R * 0.25, 0.0, 0.0), a), V = vec3(0.0, 0.5, 0.0);
  vec3 C = U;
  vec2 st; float t; bool fr;
  if (hitRect(ro, rd, C, U, V, st, t, fr)) {
    float k = shadeOf(rd, U, V);
    return fr ? shaded(sideA(vec2(0.75 + st.x * 0.25, st.y * 0.5 + 0.5)), k) : shaded(sideB(vec2(0.25 - st.x * 0.25, st.y * 0.5 + 0.5)), k);
  }
  // the static halves (the page's shadow falls on them)
  float sh = 1.0 - 0.35 * sin(a) * smoothstep(0.5, 0.0, abs(uv.x - 0.5 + cos(a) * 0.25));
  vec4 c = uv.x < 0.5 ? sideA(uv) : sideB(uv);
  return shaded(c, sh);
}`;

const PAGE_ROLL = `
vec4 transition(vec2 uv) {
  float R = radius;
  float X0 = mix(1.0, -2.2 * R, progress);
  float d = (uv.x - X0) * ratio;
  float r = R * ratio;
  if (d < 0.0) return getFromColor(uv);
  if (d <= r) {
    float ph = asin(clamp(d / r, 0.0, 1.0));
    float xb = X0 + R * (PI - ph);
    if (xb <= 1.0) {
      vec4 c = getFromColor(vec2(xb, uv.y));
      c.rgb = mix(c.rgb, vec3(dot(c.rgb, K709)), 0.5) * 0.65 + 0.35;
      return vec4(c.rgb * (0.75 + 0.25 * cos(ph)), c.a);
    }
    float xf = X0 + R * ph;
    if (xf <= 1.0) { vec4 c = getFromColor(vec2(xf, uv.y)); return vec4(c.rgb * (0.55 + 0.45 * cos(ph)), c.a); }
  }
  vec4 b = getToColor(uv);
  float s = 1.0 - 0.55 * exp(-max(d - r, 0.0) / (r * 0.8));
  return vec4(b.rgb * s, b.a);
}`;

/** A cube turning so its side face (the incoming picture) comes to the front; pulled back half-way. */
const cube = (axis: "y" | "x", dir: number) => `${RAY}
vec3 rot(vec3 v, float a) { return ${axis === "y" ? "rotY(v, a)" : "rotX(v, a)"}; }
vec4 transition(vec2 uv) {
  float e = ease3(progress);
  float a = ${dir.toFixed(1)} * e * PI * 0.5;
  float hw = ratio * 0.5, hh = 0.5;
  float half_ = ${axis === "y" ? "hw" : "hh"};
  vec3 K = vec3(0.0, 0.0, half_ + sin(progress * PI) * depth);
  vec3 ro = vec3(0.0, 0.0, -CAM), rd = rayDir(uv);
  // front face (outgoing) and the side face (incoming) before turning, relative to the centre K
  vec3 Cf = vec3(0.0, 0.0, -half_), Uf = vec3(hw, 0.0, 0.0), Vf = vec3(0.0, hh, 0.0);
  ${axis === "y"
    ? (dir > 0 ? "vec3 Cs = vec3(hw, 0.0, 0.0), Us = vec3(0.0, 0.0, hw), Vs = vec3(0.0, hh, 0.0);" : "vec3 Cs = vec3(-hw, 0.0, 0.0), Us = vec3(0.0, 0.0, -hw), Vs = vec3(0.0, hh, 0.0);")
    : (dir > 0 ? "vec3 Cs = vec3(0.0, -hh, 0.0), Us = vec3(hw, 0.0, 0.0), Vs = vec3(0.0, 0.0, -hh);" : "vec3 Cs = vec3(0.0, hh, 0.0), Us = vec3(hw, 0.0, 0.0), Vs = vec3(0.0, 0.0, hh);")}
  vec2 st; float t, best = 1e9; bool fr;
  vec4 c = bgColor();
  if (hitRect(ro, rd, K + rot(Cf, a), rot(Uf, a), rot(Vf, a), st, t, fr) && fr && t < best) { best = t; c = shaded(getFromColor(tuv(st)), shadeOf(rd, rot(Uf, a), rot(Vf, a))); }
  if (hitRect(ro, rd, K + rot(Cs, a), rot(Us, a), rot(Vs, a), st, t, fr) && fr && t < best) { best = t; c = shaded(getToColor(tuv(st)), shadeOf(rd, rot(Us, a), rot(Vs, a))); }
  return c;
}`;

/** Inside a room: the camera at the centre of the cube turns from the front wall to the right one. */
const CUBE_INNER = `${RAY}
vec4 transition(vec2 uv) {
  float e = ease3(progress);
  float a = e * PI * 0.5;
  float hw = ratio * 0.5;
  vec3 ro = vec3(0.0, 0.0, -hw);
  vec3 rd = rotY(normalize(vec3((uv.x - 0.5) * ratio, uv.y - 0.5, hw)), a);
  vec2 st; float t, best = 1e9; bool fr;
  vec4 c = bgColor();
  vec3 Uf = vec3(hw, 0.0, 0.0), Vf = vec3(0.0, 0.5, 0.0);
  if (hitRect(ro, rd, vec3(0.0), Uf, Vf, st, t, fr) && t < best) { best = t; c = shaded(getFromColor(tuv(st)), 1.0 - 0.35 * e); }
  vec3 Ur = vec3(0.0, 0.0, -hw), Vr = vec3(0.0, 0.5, 0.0);
  if (hitRect(ro, rd, vec3(hw, 0.0, -hw), Ur, Vr, st, t, fr) && t < best) { best = t; c = shaded(getToColor(tuv(st)), 0.65 + 0.35 * e); }
  return c;
}`;

const DOORS = `${RAY}
vec4 transition(vec2 uv) {
  float e = ease3(progress);
  float a = e * PI * 0.55;
  float hw = ratio * 0.5;
  vec3 ro = vec3(0.0, 0.0, -CAM), rd = rayDir(uv);
  vec2 st; float t, best = 1e9; bool fr;
  // what's behind: the incoming picture coming forward
  float zb = 0.6 * (1.0 - e);
  vec4 c = bgColor();
  if (hitRect(ro, rd, vec3(0.0, 0.0, zb), vec3(hw, 0.0, 0.0), vec3(0.0, 0.5, 0.0), st, t, fr) && t < best) { best = t; c = shaded(getToColor(tuv(st)), 0.6 + 0.4 * e); }
  vec3 Ul = rotY(vec3(hw * 0.5, 0.0, 0.0), -a), Ur = rotY(vec3(-hw * 0.5, 0.0, 0.0), a), V = vec3(0.0, 0.5, 0.0);
  if (hitRect(ro, rd, vec3(-hw, 0.0, 0.0) + Ul, Ul, V, st, t, fr) && t < best) {
    best = t; vec2 u = vec2((st.x * 0.5 + 0.5) * 0.5, st.y * 0.5 + 0.5);
    c = shaded(fr ? getFromColor(u) : vec4(vec3(0.25), 1.0), shadeOf(rd, Ul, V));
  }
  if (hitRect(ro, rd, vec3(hw, 0.0, 0.0) + Ur, Ur, V, st, t, fr) && t < best) {
    best = t; vec2 u = vec2(1.0 - (st.x * 0.5 + 0.5) * 0.5, st.y * 0.5 + 0.5);
    c = shaded(!fr ? getFromColor(u) : vec4(vec3(0.25), 1.0), shadeOf(rd, Ur, V));
  }
  return c;
}`;

const CARDS = `
vec4 transition(vec2 uv) {
  vec2 grid = vec2(floor(rows * ratio + 0.5), rows);
  vec2 cell = floor(uv * grid), f = fract(uv * grid) - 0.5;
  float delay = (cell.x + cell.y) / max(grid.x + grid.y - 2.0, 1.0) * 0.6 + nHash(cell) * 0.05;
  float k = clamp((progress - delay) / 0.35, 0.0, 1.0);
  k = k * k * (3.0 - 2.0 * k);
  float ang = k * PI, cs = cos(ang), sn = sin(ang);
  float xl = f.x / (abs(cs) < 1e-3 ? 1e-3 * sign(cs + 1e-9) : cs);
  float yl = f.y / (1.0 + 0.35 * sn * (cs >= 0.0 ? -xl : xl) * 0.5);
  if (abs(xl) > 0.5 - gap || abs(yl) > 0.5 - gap) return bgColor();
  float shade = 0.55 + 0.45 * abs(cs);
  vec4 c = cs >= 0.0 ? getFromColor((cell + vec2(xl, yl) + 0.5) / grid) : getToColor((cell + vec2(-xl, yl) + 0.5) / grid);
  return vec4(c.rgb * shade, c.a);
}`;

const depthP = (d: number): PackParam => ({ name: "depth", type: "float", default: d, min: 0, max: 3, step: 0.01, description: "How far it pulls back" });
export const THREED: PackTransition[] = [
  { id: "flip", label: "Flip", group: "3D", glsl: flip(false), params: [depthP(0.6)] },
  { id: "flip_v", label: "Flip (vertical)", group: "3D", glsl: flip(true), params: [depthP(0.5)] },
  { id: "fold", label: "Book fold", group: "3D", glsl: fold(false), params: [] },
  { id: "fold_v", label: "Book fold (vertical)", group: "3D", glsl: fold(true), params: [] },
  { id: "page_roll", label: "Page roll", group: "3D", glsl: PAGE_ROLL, params: [{ name: "radius", type: "float", default: 0.09, min: 0.02, max: 0.3, step: 0.005 }] },
  { id: "cube_left", label: "Cube left", group: "3D", glsl: cube("y", 1), params: [depthP(0.7)] },
  { id: "cube_right", label: "Cube right", group: "3D", glsl: cube("y", -1), params: [depthP(0.7)] },
  { id: "cube_up", label: "Cube up", group: "3D", glsl: cube("x", 1), params: [depthP(0.5)] },
  { id: "cube_down", label: "Cube down", group: "3D", glsl: cube("x", -1), params: [depthP(0.5)] },
  { id: "cube_inner", label: "Cube (inside)", group: "3D", glsl: CUBE_INNER, params: [] },
  { id: "doors_open", label: "Doors open", group: "3D", glsl: DOORS, params: [] },
  { id: "box", label: "Box turn", group: "3D", glsl: cube("y", 1), params: [depthP(2.2)] },
  { id: "cards", label: "Cards", group: "3D", glsl: CARDS, params: [{ name: "rows", type: "float", default: 5, min: 1, max: 20, step: 1 },
    { name: "gap", type: "float", default: 0.02, min: 0, max: 0.2, step: 0.005 }] },
];
