/**
 * GPU scopes of a frame (docs/EDITOR.md §10): waveform (luma), RGB parade, vectorscope (Cb/Cr, BT.709) and histogram
 * (R, G, B, luma). Every sample of a grid over the frame is one point, added into a half-float target (one draw), then
 * a display pass tone-maps the density and draws the graticule; the result is read back as RGBA8 (a few hundred KB),
 * so a scope costs well under a frame at 1080p. Our own GLSL.
 */
import { HEADER } from "./effects/shaders";
import type { Program, Texture } from "./gl/backend";
import type { WebGL2Backend } from "./gl/webgl2";

export type ScopeKind = "waveform" | "parade" | "vectorscope" | "histogram";
export const SCOPE_KINDS: ScopeKind[] = ["waveform", "parade", "vectorscope", "histogram"];

export interface ScopeOptions {
  /** Output size in pixels (defaults per kind: waveform 512×256, parade 768×256, vectorscope 256×256, histogram 512×200). */
  width?: number; height?: number;
  /** Brightness of the traces (default 1). */
  gain?: number;
  /** Draw the graticule (default true). */
  graticule?: boolean;
  /** Also draw the result into this canvas (it is resized to the scope). */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
}

const KIND: Record<ScopeKind, number> = { waveform: 0, parade: 1, vectorscope: 2, histogram: 3 };
const SIZE: Record<ScopeKind, [number, number]> = { waveform: [512, 256], parade: [768, 256], vectorscope: [256, 256], histogram: [512, 200] };

const VS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_frame;
uniform ivec2 u_grid;
uniform ivec2 u_size;
uniform int u_kind;
uniform float u_k;
out vec4 v_col;
void main() {
  int id = gl_VertexID;
  int n = u_grid.x * u_grid.y;
  int ch = 0;
  if (u_kind == 1 || u_kind == 3) { ch = id / n; id -= ch * n; }
  int gx = id % u_grid.x, gy = id / u_grid.x;
  ivec2 p = ivec2((float(gx) + 0.5) * float(u_size.x) / float(u_grid.x), (float(gy) + 0.5) * float(u_size.y) / float(u_grid.y));
  vec3 c = clamp(texelFetch(u_frame, p, 0).rgb, -0.05, 1.05);
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float x, y;
  vec3 col;
  if (u_kind == 0) { x = (float(gx) + 0.5) / float(u_grid.x); y = luma; col = vec3(0.55, 1.0, 0.65); }
  else if (u_kind == 1) {
    float v = ch == 0 ? c.r : ch == 1 ? c.g : c.b;
    x = (float(ch) + (float(gx) + 0.5) / float(u_grid.x)) / 3.0; y = v;
    col = ch == 0 ? vec3(1.0, 0.3, 0.25) : ch == 1 ? vec3(0.35, 1.0, 0.4) : vec3(0.35, 0.55, 1.0);
  } else if (u_kind == 2) {
    float cb = (c.b - luma) / 1.8556, cr = (c.r - luma) / 1.5748;
    x = 0.5 + cb * 0.9; y = 0.5 + cr * 0.9;
    col = mix(vec3(0.7, 1.0, 0.75), clamp(c, 0.0, 1.0) * 1.4 + 0.15, 0.55);
  } else {
    float v = ch == 0 ? c.r : ch == 1 ? c.g : ch == 2 ? c.b : luma;
    x = (floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5) + 0.5) / 256.0; y = 0.5;
    col = vec3(0.0);
  }
  float m = u_kind == 0 || u_kind == 1 ? 0.05 : 0.0;
  float yy = m + (1.0 - 2.0 * m) * y;
  gl_Position = vec4(x * 2.0 - 1.0, u_kind == 3 ? 0.0 : 1.0 - 2.0 * yy, 0.0, 1.0);
  gl_PointSize = 1.0;
  v_col = u_kind == 3 ? vec4(ch == 0 ? 1.0 : 0.0, ch == 1 ? 1.0 : 0.0, ch == 2 ? 1.0 : 0.0, ch == 3 ? 1.0 : 0.0) : vec4(col * u_k, u_k);
}`;
const FS = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 o_color;
void main() { o_color = v_col; }`;

const DISPLAY = HEADER + `
uniform sampler2D u_acc;
uniform int u_kind;
uniform float u_gain;
uniform vec4 u_max;
uniform float u_grat;
float hline(float y, float at) { return 1.0 - smoothstep(0.0, 1.2 / u_res.y, abs(y - at)); }
float vline(float x, float at) { return 1.0 - smoothstep(0.0, 1.2 / u_res.x, abs(x - at)); }
void main() {
  vec2 uv = v_uv;
  vec3 col = vec3(0.035, 0.04, 0.05);
  if (u_kind < 3) {
    vec3 a = texture(u_acc, uv).rgb;
    col += 1.0 - exp(-a * u_gain);
    if (u_grat > 0.5 && u_kind < 2) {
      for (int i = 0; i <= 4; i++) col += vec3(0.16, 0.14, 0.08) * hline(uv.y, 1.0 - (0.05 + 0.9 * float(i) / 4.0));
      if (u_kind == 1) col += vec3(0.2) * (vline(uv.x, 1.0 / 3.0) + vline(uv.x, 2.0 / 3.0));
    }
    if (u_grat > 0.5 && u_kind == 2) {
      vec2 d = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
      float r = length(d);
      col += vec3(0.16, 0.14, 0.08) * (1.0 - smoothstep(0.0, 1.5 / u_res.y, abs(r - 0.45 * 0.9 * 1.0)));
      col += vec3(0.08) * (1.0 - smoothstep(0.0, 1.0 / u_res.y, abs(r - 0.225)));
      // the skin-tone line (about 123° in the Cb/Cr plane)
      vec2 sk = normalize(vec2(-0.55, -0.835));
      float along = dot(d, sk), off = abs(d.x * sk.y - d.y * sk.x);
      col += vec3(0.18, 0.12, 0.06) * step(0.0, along) * (1.0 - smoothstep(0.0, 1.2 / u_res.y, off)) * step(along, 0.45);
      // 75 % colour targets
      for (int i = 0; i < 6; i++) {
        vec3 t = i == 0 ? vec3(0.75, 0.0, 0.0) : i == 1 ? vec3(0.75, 0.75, 0.0) : i == 2 ? vec3(0.0, 0.75, 0.0) : i == 3 ? vec3(0.0, 0.75, 0.75) : i == 4 ? vec3(0.0, 0.0, 0.75) : vec3(0.75, 0.0, 0.75);
        float l = dot(t, vec3(0.2126, 0.7152, 0.0722));
        vec2 q = vec2(0.5 + (t.b - l) / 1.8556 * 0.9, 1.0 - (0.5 + (t.r - l) / 1.5748 * 0.9));
        vec2 e = abs(uv - q) * u_res;
        col += vec3(0.25, 0.2, 0.1) * step(max(e.x, e.y), 5.0) * step(4.0, max(e.x, e.y));
      }
    }
  } else {
    vec4 h = texture(u_acc, vec2(uv.x, 0.5)) / max(u_max, vec4(1.0));
    float y = 1.0 - uv.y;
    col += vec3(h.r > y ? 0.75 : 0.0, h.g > y ? 0.75 : 0.0, h.b > y ? 0.75 : 0.0) * 0.55 + (h.a > y ? vec3(0.32) : vec3(0.0));
    if (u_grat > 0.5) for (int i = 1; i < 4; i++) col += vec3(0.08) * vline(uv.x, float(i) / 4.0);
  }
  o_color = vec4(min(col, 1.0), 1.0);
}`;

export class Scopes {
  private b: WebGL2Backend;
  private buf: Uint8Array | null = null;
  constructor(b: WebGL2Backend) { this.b = b; }

  /** The scope of `frame` as RGBA8 rows (top first). */
  render(kind: ScopeKind, frame: Texture, o: ScopeOptions = {}): { data: Uint8Array; w: number; h: number } {
    const b = this.b;
    const [dw, dh] = SIZE[kind];
    const w = Math.max(32, Math.round(o.width ?? dw)), h = Math.max(32, Math.round(o.height ?? dh));
    const k = KIND[kind];
    const gain = o.gain ?? 1;
    // the sample grid: about one column per output column, up to 288 rows
    const gx = Math.max(8, Math.min(frame.w, kind === "parade" ? Math.round(w / 3) : kind === "vectorscope" ? 384 : w));
    const gy = Math.max(8, Math.min(frame.h, kind === "vectorscope" ? 216 : 288));
    const n = gx * gy;
    const accW = kind === "histogram" ? 256 : w, accH = kind === "histogram" ? 1 : h;
    const acc = b.target(accW, accH, { format: b.floatTargets ? "rgba16f" : "rgba8" });
    b.clear(acc, [0, 0, 0, 0]);
    // weight per point so a typical spread lands near 1
    let wk = kind === "vectorscope" ? (w * h) / n * 2.5 : (h / gy) * 0.6;
    if (kind === "parade") wk = (h / gy) * 0.6 * (gx * 3 / w);
    if (kind === "waveform") wk *= gx / w;
    if (!b.floatTargets) wk = Math.max(wk, 1 / 255);
    const prog: Program = b.pointProgram(`scope-acc`, VS, FS);
    b.drawPoints({ program: prog, target: acc, count: kind === "parade" ? n * 3 : kind === "histogram" ? n * 4 : n,
      uniforms: { u_grid: [gx, gy], u_size: [frame.w, frame.h], u_kind: k, u_k: wk }, textures: { u_frame: frame } });
    let max = [1, 1, 1, 1];
    if (kind === "histogram") {
      const v = b.readFloat(acc, 0, 0, 256, 1);
      max = [0, 1, 2, 3].map((c) => { let m = 1; for (let i = 1; i < 255; i++) m = Math.max(m, v[i * 4 + c]); return m * 1.05; });
    }
    const out = b.target(w, h, { format: "rgba8" });
    b.draw({ program: b.program("scope-display", DISPLAY), target: out, uniforms: { u_res: [w, h], u_kind: k, u_gain: 2 * gain, u_max: max, u_grat: o.graticule === false ? 0 : 1 },
      textures: { u_acc: acc } });
    b.release(acc);
    if (!this.buf || this.buf.length !== w * h * 4) this.buf = new Uint8Array(w * h * 4);
    b.read(out, 0, 0, w, h, this.buf);
    b.release(out);
    return { data: this.buf, w, h };
  }
}
