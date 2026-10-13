/**
 * GLSL snippets shared by the wave-3 effects and transitions (our own code): integer hashes (PCG, after Jarzynski &
 * Olano, "Hash Functions for GPU Rendering", JCGT 2020), value noise and fbm, Voronoi cells, colour helpers. Every
 * name is prefixed so a snippet can sit next to the clip HEADER or the effect prelude without clashes. Pure strings.
 */

/** Hashes 0..1 from integer lattice points (no sin(): the same on every GPU), value noise, fbm, Voronoi. */
export const NOISE_GLSL = `
uint nPcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float nHash(vec2 p) { ivec2 i = ivec2(floor(p)) + 65536; return float(nPcg(uint(i.x) ^ nPcg(uint(i.y)))) / 4294967295.0; }
float nHash(vec3 p) { ivec3 i = ivec3(floor(p)) + 65536; return float(nPcg(uint(i.x) ^ nPcg(uint(i.y) ^ nPcg(uint(i.z))))) / 4294967295.0; }
vec2 nHash2(vec2 p) { return vec2(nHash(p), nHash(p + vec2(127.0, 311.0))); }
float nNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(nHash(i), nHash(i + vec2(1.0, 0.0)), u.x), mix(nHash(i + vec2(0.0, 1.0)), nHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float nNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(nHash(i), nHash(i + vec3(1, 0, 0)), u.x), mix(nHash(i + vec3(0, 1, 0)), nHash(i + vec3(1, 1, 0)), u.x), u.y);
  float b = mix(mix(nHash(i + vec3(0, 0, 1)), nHash(i + vec3(1, 0, 1)), u.x), mix(nHash(i + vec3(0, 1, 1)), nHash(i + vec3(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z);
}
float nFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * nNoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
  return s / 0.96875;
}
float nFbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * nNoise(p); p = p * 2.03 + vec3(17.1, 9.7, 4.3); a *= 0.5; }
  return s / 0.9375;
}
// distance to the nearest of one jittered point per cell (F1), the second nearest (F2) and the nearest cell's id
vec3 nVoronoi(vec2 p, float jitter, out vec2 cell) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  cell = i;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = g + 0.5 + (nHash2(i + g) - 0.5) * jitter;
    float d = length(o - f);
    if (d < d1) { d2 = d1; d1 = d; cell = i + g; } else if (d < d2) d2 = d;
  }
  return vec3(d1, d2, nHash(cell));
}
`;

/** Colour helpers: Rec.709 luma, HSV, YCbCr-style chroma rotation. */
export const COLOR_GLSL = `
const vec3 cLumaK = vec3(0.2126, 0.7152, 0.0722);
float cLuma(vec3 c) { return dot(c, cLumaK); }
vec3 cRgb2Hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 cHsv2Rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 cSat(vec3 c, float s) { float l = cLuma(c); return vec3(l) + (c - vec3(l)) * s; }
`;

/** 2D helpers. */
export const GEOM_GLSL = `
const float gPI = 3.141592653589793;
mat2 gRot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// mirrored repeat: keeps motion transitions from showing black borders
vec2 gMirror(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
float gInside(vec2 uv) { vec2 e = step(vec2(0.0), uv) * step(uv, vec2(1.0)); return e.x * e.y; }
`;
