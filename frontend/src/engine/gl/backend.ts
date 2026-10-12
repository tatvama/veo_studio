/**
 * The drawing interface the renderer, effects and transitions use (docs/ENGINE.md §1): textures, render targets,
 * programs, a fullscreen draw and read-back. WebGL2 implements it today (webgl2.ts); a WebGPU backend can come later
 * without touching the timeline, effect or transition code.
 */
export type UniformValue = number | boolean | number[] | Float32Array | Int32Array;

export interface Texture {
  readonly w: number; readonly h: number;
  /** Has a mip chain (generateMips was called since the last upload / draw). */
  mips: boolean;
}
/** A texture you can draw into. Pooled: release() it when done. */
export interface RenderTarget extends Texture { readonly format: "rgba16f" | "rgba8" }

export interface Program { readonly name: string; ready(): boolean }

export interface DrawCall {
  program: Program;
  /** null = the canvas. */
  target: RenderTarget | null;
  uniforms?: Record<string, UniformValue>;
  textures?: Record<string, Texture | Texture3D>;
  /** Fixed-function blending (premultiplied "over") instead of replacing the target. */
  blend?: "over" | "none";
  viewport?: [number, number, number, number];
}
export interface Texture3D { readonly size: number; readonly is3d: true }

export interface Backend {
  readonly kind: "webgl2";
  /** Render targets are half-float (else RGBA8). */
  readonly floatTargets: boolean;
  readonly maxTextureSize: number;
  /** A texture for a source (video, image, frame): (re)uploaded with upload(). */
  createTexture(): Texture;
  upload(tex: Texture, src: TexImageSource, w: number, h: number): void;
  /** Raw texels; "r32f" textures are point-sampled (read them with texelFetch). */
  uploadData(tex: Texture, w: number, h: number, data: Float32Array | Uint8Array, format: "rgba16f" | "rgba8" | "r8" | "r32f"): void;
  /** One plane of a decoded video frame (8-bit, 1 or 2 channels, rows `stride` bytes apart), point-sampled. */
  uploadPlane(tex: Texture, w: number, h: number, data: Uint8Array, offset: number, stride: number, channels: 1 | 2): void;
  createTexture3D(size: number, rgb: Float32Array): Texture3D;
  generateMips(tex: Texture): void;
  deleteTexture(tex: Texture | Texture3D): void;
  /** `mips`: allocate a mip chain so generateMips() works on it (transitions that blur by mip level). */
  target(w: number, h: number, opts?: { format?: "rgba16f" | "rgba8"; mips?: boolean }): RenderTarget;
  release(rt: RenderTarget | null | undefined): void;
  clear(rt: RenderTarget | null, rgba: [number, number, number, number]): void;
  /** Compiled lazily and cached by source; `glsl1` = a GLSL ES 1.00 fragment shader (gl-transitions). */
  program(name: string, fragment: string, opts?: { glsl1?: boolean }): Program;
  /** Throws the compile / link error (with the shader's name) if the program failed. */
  check(p: Program): void;
  draw(call: DrawCall): void;
  read(rt: RenderTarget, x: number, y: number, w: number, h: number, out: Uint8Array): Uint8Array;
  readFloat(rt: RenderTarget, x: number, y: number, w: number, h: number): Float32Array;
  /** Blocks until the GPU is done (a 1-pixel read-back). */
  finish(): void;
  resizeCanvas(w: number, h: number): void;
  dispose(): void;
}

/** A shader compile or link failure, naming the shader. */
export class ShaderError extends Error {
  shader: string;
  log: string;
  constructor(shader: string, log: string) {
    super(`Shader "${shader}" failed: ${log.trim().split("\n").slice(0, 6).join(" | ")}`);
    this.shader = shader;
    this.log = log;
  }
}
