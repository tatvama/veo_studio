/**
 * WebGL2 implementation of the Backend: one context (alpha off, drawing buffer kept for read-back), half-float
 * render targets when the GPU can render to them (else RGBA8), a pool of targets by size, programs compiled lazily
 * and cached by source hash (in parallel where KHR_parallel_shader_compile exists), one fullscreen triangle.
 * Texture rows are top first everywhere ("image space"); only the canvas present flips.
 */
import { ShaderError, type Backend, type DrawCall, type Program, type RenderTarget, type Texture, type Texture3D, type UniformValue } from "./backend";
import { notifyCanvasRestored } from "../sources/canvasLoss";

const VS3 = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const VS1 = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

class GLTex implements Texture {
  w = 0; h = 0; mips = false;
  tex: WebGLTexture;
  constructor(tex: WebGLTexture) { this.tex = tex; }
}
class GLTarget extends GLTex implements RenderTarget {
  format: "rgba16f" | "rgba8";
  fbo: WebGLFramebuffer;
  key: string;
  levels: number;
  /** The frame (tick) it was last handed out. */
  used = 0;
  constructor(tex: WebGLTexture, fbo: WebGLFramebuffer, w: number, h: number, format: "rgba16f" | "rgba8", levels: number) {
    super(tex);
    this.fbo = fbo; this.w = w; this.h = h; this.format = format; this.levels = levels;
    this.key = `${w}x${h}:${format}:${levels > 1 ? "m" : ""}`;
  }
}
class GLTex3D implements Texture3D {
  readonly is3d = true;
  size: number;
  tex: WebGLTexture;
  constructor(tex: WebGLTexture, size: number) { this.tex = tex; this.size = size; }
}
interface UniformInfo { loc: WebGLUniformLocation; type: number; size: number }
class GLProgram implements Program {
  name: string;
  prog: WebGLProgram;
  vs: WebGLShader; fs: WebGLShader;
  gl: WebGL2RenderingContext;
  parallel: boolean;
  linked: boolean | null = null;
  error = "";
  uniforms = new Map<string, UniformInfo>();
  samplers: { name: string; type: number }[] = [];
  constructor(gl: WebGL2RenderingContext, name: string, prog: WebGLProgram, vs: WebGLShader, fs: WebGLShader, parallel: boolean) {
    this.gl = gl; this.name = name; this.prog = prog; this.vs = vs; this.fs = fs; this.parallel = parallel;
  }
  ready(): boolean {
    if (this.linked !== null) return true;
    if (!this.parallel) return true;
    return !!this.gl.getProgramParameter(this.prog, 0x91B1 /* COMPLETION_STATUS_KHR */);
  }
}

const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ":" + s.length;
};

/** Numbered source lines around the ones a compile log names (readable errors). */
function excerpt(src: string, log: string): string {
  let lines = src.split("\n");
  const at = lines.findIndex((l) => l.startsWith("#line 1"));
  if (at >= 0) lines = lines.slice(at + 1);
  const nums = [...log.matchAll(/ERROR:\s*\d+:(\d+)/g)].map((m) => Number(m[1])).slice(0, 2);
  return nums.map((n) => lines.slice(Math.max(0, n - 2), n + 1).map((l, i) => `${Math.max(1, n - 1) + i}: ${l}`).join("\n")).join("\n…\n");
}

export class WebGL2Backend implements Backend {
  readonly kind = "webgl2" as const;
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  floatTargets = false;
  maxTextureSize = 4096;
  private parallel = false;
  private programs = new Map<string, GLProgram>();
  /** Fast path: the same fragment string again (no hashing). */
  private byFrag = [new Map<string, GLProgram>(), new Map<string, GLProgram>()];
  private tickNo = 0;
  private pool = new Map<string, GLTarget[]>();
  private all = new Set<GLTarget>();
  private vao!: WebGLVertexArrayObject;
  /** No attributes: point clouds index their data by gl_VertexID (scopes). */
  private emptyVao!: WebGLVertexArrayObject;
  private dummy2d!: WebGLTexture;
  private dummy3d!: WebGLTexture;
  lost = false;
  /** Called after a lost context came back (everything on the GPU is gone: the owner re-creates its textures). */
  onRestore: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 isn't available on this computer");
    this.gl = gl;
    this.init();
    if ("addEventListener" in canvas) {
      canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; }, false);
      canvas.addEventListener("webglcontextrestored", () => {
        this.programs.clear(); this.byFrag[0].clear(); this.byFrag[1].clear(); this.pool.clear(); this.all.clear();
        this.init();
        this.lost = false;
        this.onRestore?.();
        // the monitors draw again (nothing else would while paused)
        notifyCanvasRestored();
      }, false);
    }
  }

  /** Context state: extensions, pixel store, the fullscreen triangle, dummy textures (again after a restore). */
  private init() {
    const gl = this.gl;
    this.floatTargets = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    gl.getExtension("OES_texture_float_linear");
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.emptyVao = gl.createVertexArray()!;
    this.dummy2d = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummy2d);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.dummy3d = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.dummy3d);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  private params(target: number, mips: boolean) {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }

  createTexture(): Texture {
    const gl = this.gl;
    const t = new GLTex(gl.createTexture()!);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    this.params(gl.TEXTURE_2D, false);
    return t;
  }

  upload(tex: Texture, src: TexImageSource, w: number, h: number): void {
    const gl = this.gl, t = tex as GLTex;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    t.w = w; t.h = h;
    if (t.mips) { t.mips = false; gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); }
  }

  /** Updates part of an uploaded texture (same size as `src`) from the same part of `src`: x, y, w, h in pixels. */
  uploadSub(tex: Texture, src: TexImageSource, x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const gl = this.gl, t = tex as GLTex;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    if (t.mips) { t.mips = false; gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); }
  }

  uploadData(tex: Texture, w: number, h: number, data: Float32Array | Uint8Array, format: "rgba16f" | "rgba8" | "r8" | "r32f"): void {
    const gl = this.gl, t = tex as GLTex;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (format === "r32f") {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
    } else if (format === "rgba16f") gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    else if (format === "r8") gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    t.w = w; t.h = h; t.mips = false;
  }

  uploadPlane(tex: Texture, w: number, h: number, data: Uint8Array, offset: number, stride: number, channels: 1 | 2): void {
    const gl = this.gl, t = tex as GLTex;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, Math.floor(stride / channels));
    const fmt = channels === 2 ? gl.RG : gl.RED;
    const view = data.subarray(offset, offset + stride * (h - 1) + w * channels);
    if (t.w === w && t.h === h && (t as GLTex & { ch?: number }).ch === channels) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt, gl.UNSIGNED_BYTE, view);
    else gl.texImage2D(gl.TEXTURE_2D, 0, channels === 2 ? gl.RG8 : gl.R8, w, h, 0, fmt, gl.UNSIGNED_BYTE, view);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    t.w = w; t.h = h; t.mips = false;
    (t as GLTex & { ch?: number }).ch = channels;
  }

  createTexture3D(size: number, rgb: Float32Array): Texture3D {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    this.params(gl.TEXTURE_3D, false);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, rgb);
    return new GLTex3D(tex, size);
  }

  generateMips(tex: Texture): void {
    const gl = this.gl, t = tex as GLTex;
    if (t instanceof GLTarget && t.levels < 2) return;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    t.mips = true;
  }

  deleteTexture(tex: Texture | Texture3D): void {
    this.gl.deleteTexture((tex as GLTex | GLTex3D).tex);
  }

  target(w: number, h: number, opts: { format?: "rgba16f" | "rgba8"; mips?: boolean } = {}): RenderTarget {
    const gl = this.gl;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const format = opts.format ?? (this.floatTargets ? "rgba16f" : "rgba8");
    const levels = opts.mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    const key = `${w}x${h}:${format}:${levels > 1 ? "m" : ""}`;
    const free = this.pool.get(key);
    if (free?.length) {
      const t = free.pop()!;
      t.used = this.tickNo;
      if (t.mips) { gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); t.mips = false; }
      return t;
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, format === "rgba16f" ? gl.RGBA16F : gl.RGBA8, w, h);
    this.params(gl.TEXTURE_2D, false);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Render target ${key} is incomplete (0x${st.toString(16)})`);
    const t = new GLTarget(tex, fbo, w, h, format, levels);
    t.used = this.tickNo;
    this.all.add(t);
    return t;
  }

  release(rt: RenderTarget | null | undefined): void {
    if (!rt) return;
    const t = rt as GLTarget;
    if (!this.all.has(t)) return;
    const list = this.pool.get(t.key) ?? [];
    if (!list.includes(t)) list.push(t);
    this.pool.set(t.key, list);
  }

  /** A new frame (for trimOld). */
  tick(): void { this.tickNo++; }

  /** Free pooled targets not handed out in the last `age` ticks (sizes that came and went: animated scale). */
  trimOld(age: number): void {
    const gl = this.gl;
    for (const [k, list] of this.pool) {
      const keep = list.filter((t) => this.tickNo - t.used <= age);
      for (const t of list) if (!keep.includes(t)) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); this.all.delete(t); }
      if (keep.length) this.pool.set(k, keep); else this.pool.delete(k);
    }
  }

  /** Free pooled targets nobody holds (after a size change). */
  trim(): void {
    const gl = this.gl;
    for (const list of this.pool.values()) for (const t of list) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); this.all.delete(t); }
    this.pool.clear();
  }

  clear(rt: RenderTarget | null, rgba: [number, number, number, number]): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? (rt as GLTarget).fbo : null);
    gl.viewport(0, 0, rt ? rt.w : gl.drawingBufferWidth, rt ? rt.h : gl.drawingBufferHeight);
    gl.clearColor(rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** A program with its own vertex shader (GLSL ES 3.00), for point clouds drawn with drawPoints(). Cached by source. */
  pointProgram(name: string, vertex: string, fragment: string): Program {
    const key = hash(vertex + "\u0001" + fragment);
    const hit = this.programs.get(key);
    if (hit) return hit;
    const gl = this.gl;
    const mk = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const vs = mk(gl.VERTEX_SHADER, vertex), fs = mk(gl.FRAGMENT_SHADER, fragment);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    const p = new GLProgram(gl, name, prog, vs, fs, false);
    (p as GLProgram & { src: string }).src = fragment;
    this.programs.set(key, p);
    return p;
  }

  /** `count` points (gl_VertexID 0..count−1) into a target, added together (ONE, ONE blending): scopes. */
  drawPoints(call: { program: Program; target: RenderTarget; count: number; uniforms?: Record<string, UniformValue>; textures?: Record<string, Texture | Texture3D> }): void {
    const gl = this.gl;
    const p = call.program as GLProgram;
    this.check(p);
    const rt = call.target as GLTarget;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.viewport(0, 0, rt.w, rt.h);
    gl.useProgram(p.prog);
    let unit = 0;
    for (const sm of p.samplers) {
      const tex = call.textures?.[sm.name] as GLTex | GLTex3D | undefined;
      const is3d = sm.type === gl.SAMPLER_3D;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(is3d ? gl.TEXTURE_3D : gl.TEXTURE_2D, tex ? tex.tex : is3d ? this.dummy3d : this.dummy2d);
      gl.uniform1i(p.uniforms.get(sm.name)!.loc, unit);
      unit++;
    }
    for (const k in call.uniforms) this.set(p, k, call.uniforms[k]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.POINTS, 0, Math.max(0, Math.floor(call.count)));
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    rt.mips = false;
  }

  program(name: string, fragment: string, opts: { glsl1?: boolean } = {}): Program {
    const fast = this.byFrag[opts.glsl1 ? 1 : 0].get(fragment);
    if (fast) return fast;
    const vsSrc = opts.glsl1 ? VS1 : VS3;
    const key = hash(vsSrc + "\u0000" + fragment);
    const hit = this.programs.get(key);
    if (hit) { this.byFrag[opts.glsl1 ? 1 : 0].set(fragment, hit); return hit; }
    const gl = this.gl;
    const mk = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fragment);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "a_pos");
    gl.linkProgram(prog);
    const p = new GLProgram(gl, name, prog, vs, fs, this.parallel);
    (p as GLProgram & { src: string }).src = fragment;
    this.programs.set(key, p);
    this.byFrag[opts.glsl1 ? 1 : 0].set(fragment, p);
    return p;
  }

  check(program: Program): void {
    const p = program as GLProgram & { src?: string };
    if (p.linked === true) return;
    if (p.linked === false) throw new ShaderError(p.name, p.error);
    const gl = this.gl;
    if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
      const fsLog = gl.getShaderInfoLog(p.fs) || "";
      const log = fsLog || gl.getShaderInfoLog(p.vs) || gl.getProgramInfoLog(p.prog) || "link failed";
      p.linked = false;
      p.error = log + (fsLog && p.src ? "\n" + excerpt(p.src, fsLog) : "");
      throw new ShaderError(p.name, p.error);
    }
    p.linked = true;
    const n = gl.getProgramParameter(p.prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p.prog, i)!;
      const name = info.name.replace(/\[0\]$/, "");
      const loc = gl.getUniformLocation(p.prog, info.name);
      if (!loc) continue;
      p.uniforms.set(name, { loc, type: info.type, size: info.size });
      if (info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_3D) p.samplers.push({ name, type: info.type });
    }
    gl.deleteShader(p.vs); gl.deleteShader(p.fs);
  }

  private set(p: GLProgram, name: string, v: UniformValue) {
    const u = p.uniforms.get(name);
    if (!u) return;
    const gl = this.gl;
    const arr = typeof v === "number" ? [v] : typeof v === "boolean" ? [v ? 1 : 0] : Array.from(v as ArrayLike<number>, (x) => Number(x));
    switch (u.type) {
      case gl.FLOAT: u.size > 1 ? gl.uniform1fv(u.loc, arr) : gl.uniform1f(u.loc, arr[0] ?? 0); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, pad(arr, 2 * u.size)); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, pad(arr, 3 * u.size)); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, pad(arr, 4 * u.size)); break;
      case gl.INT: case gl.BOOL: u.size > 1 ? gl.uniform1iv(u.loc, arr.map(Math.round)) : gl.uniform1i(u.loc, Math.round(arr[0] ?? 0)); break;
      case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(u.loc, pad(arr, 2 * u.size).map(Math.round)); break;
      case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3iv(u.loc, pad(arr, 3 * u.size).map(Math.round)); break;
      case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4iv(u.loc, pad(arr, 4 * u.size).map(Math.round)); break;
      case gl.FLOAT_MAT2: gl.uniformMatrix2fv(u.loc, false, pad(arr, 4)); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, pad(arr, 9)); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, pad(arr, 16)); break;
      default: break;
    }
  }

  draw(call: DrawCall): void {
    const gl = this.gl;
    const p = call.program as GLProgram;
    this.check(p);
    const rt = call.target as GLTarget | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fbo : null);
    const vp = call.viewport ?? [0, 0, rt ? rt.w : gl.drawingBufferWidth, rt ? rt.h : gl.drawingBufferHeight];
    gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    gl.useProgram(p.prog);
    let unit = 0;
    for (const s of p.samplers) {
      const tex = call.textures?.[s.name] as GLTex | GLTex3D | undefined;
      const is3d = s.type === gl.SAMPLER_3D;
      gl.activeTexture(gl.TEXTURE0 + unit);
      if (rt && tex === rt) throw new Error(`${p.name}: a target can't be its own input`);
      gl.bindTexture(is3d ? gl.TEXTURE_3D : gl.TEXTURE_2D, tex ? tex.tex : is3d ? this.dummy3d : this.dummy2d);
      gl.uniform1i(p.uniforms.get(s.name)!.loc, unit);
      unit++;
    }
    for (const k in call.uniforms) this.set(p, k, call.uniforms[k]);
    if (call.blend === "over") { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    if (rt) rt.mips = false;
  }

  read(rt: RenderTarget, x: number, y: number, w: number, h: number, out: Uint8Array): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, (rt as GLTarget).fbo);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  readFloat(rt: RenderTarget, x: number, y: number, w: number, h: number): Float32Array {
    const gl = this.gl;
    const out = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, (rt as GLTarget).fbo);
    if (rt.format === "rgba16f") gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    else {
      const b = new Uint8Array(w * h * 4);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      for (let i = 0; i < b.length; i++) out[i] = b[i] / 255;
    }
    return out;
  }

  finish(): void {
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }

  resizeCanvas(w: number, h: number): void {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.all) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); }
    this.all.clear(); this.pool.clear();
    for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    this.programs.clear(); this.byFrag[0].clear(); this.byFrag[1].clear();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function pad(a: number[], n: number): number[] {
  if (a.length >= n) return a.slice(0, n);
  return a.concat(new Array(n - a.length).fill(0));
}
