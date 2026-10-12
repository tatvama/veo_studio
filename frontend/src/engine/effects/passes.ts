/** Pass builders shared by the wave-3 effects (our own GLSL). Pure. */
import type { EffectPass, PassContext, ParamValues, UniformMap } from "./registry.ts";

/**
 * One direction of a premultiplied Gaussian blur of `getColor` (the previous pass). `sigma` is a GLSL expression in
 * composition pixels (multiplied by uScale here). `src` may sample another input ("uPass0", "uOriginal").
 */
export function gaussian(sigma: string, dir: [number, number], opts: { scale?: number; src?: string; uniforms?: (p: ParamValues, c: PassContext) => UniformMap } = {}): EffectPass {
  const tex = opts.src ?? "uInput";
  return {
    scale: opts.scale,
    uniforms: opts.uniforms,
    glsl: `
vec4 gpm(vec2 q) { vec4 c = texture(${tex}, q); return vec4(c.rgb * c.a, c.a); }
vec4 effect(vec2 uv) {
  float sg = max((${sigma}) * uScale, 0.01);
  float r = min(ceil(sg * 2.6), 48.0);
  float st = max(1.0, r / 24.0);
  vec2 d = vec2(${dir[0].toFixed(1)}, ${dir[1].toFixed(1)}) / uResolution;
  vec4 acc = gpm(uv);
  float ws = 1.0;
  for (float i = 1.0; i <= 24.0; i++) {
    float x = i * st;
    if (x > r) break;
    float w = exp(-(x * x) / (2.0 * sg * sg));
    acc += (gpm(uv + d * x) + gpm(uv - d * x)) * w;
    ws += 2.0 * w;
  }
  acc /= ws;
  return acc.a > 1e-5 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);
}`,
  };
}

/** A copy of an earlier pass at full size (an effect's last pass must match its input size). */
export const copyOf = (tex: string): EffectPass => ({ glsl: `vec4 effect(vec2 uv) { return texture(${tex}, uv); }` });
