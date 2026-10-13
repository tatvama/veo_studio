/**
 * Background blur and background replace from a person mask: MediaPipe's selfie segmenter (Apache-2.0,
 * frontend/public/models/mediapipe/NOTICE.md) runs on the effect's input (live: at most once per displayed frame,
 * reused while paused; export: every frame) and the renderer hands the mask over as `uMask`. Our own GLSL: a blur of
 * the background only (the person doesn't bleed into it), a soft matte edge and light wrap.
 */
import type { EffectDef, EffectPass } from "../registry.ts";

const prepare = async () => { const m = await import("../../ml/mediapipe.ts"); await m.loadSegmenter(); };

/** One direction of a blur that only gathers background pixels (alpha carries how much background was found). */
const bgBlur = (dir: [number, number], first: boolean): EffectPass => ({
  scale: 0.5,
  glsl: `
float bgw(vec2 q) { return 1.0 - smoothstep(0.35, 0.65, texture(uMask, q).r); }
vec4 effect(vec2 uv) {
  float sg = max(strength * uScale, 0.5);
  float r = min(ceil(sg * 2.5), 64.0);
  float st = max(1.0, r / 24.0);
  vec2 d = vec2(${dir[0].toFixed(1)}, ${dir[1].toFixed(1)}) / uResolution;
  vec3 acc = vec3(0.0);
  float ws = 0.0, cov = 0.0;
  for (float i = -24.0; i <= 24.0; i++) {
    float x = i * st;
    if (abs(x) > r) continue;
    vec2 q = uv + d * x;
    float g = exp(-(x * x) / (2.0 * sg * sg));
    vec4 c = getColor(q);
    float w = ${first ? "bgw(q)" : "c.a"};
    acc += c.rgb * w * g;
    cov += w * g;
    ws += g;
  }
  return cov > 1e-5 ? vec4(acc / cov, cov / ws) : vec4(getColor(uv).rgb, 0.0);
}`,
});

const matte = `
float personAt(vec2 uv) {
  float raw = texture(uMask, uv).r;
  float t = 0.5 - expand * 0.4;
  return smoothstep(t - feather * 0.5 - 0.02, t + feather * 0.5 + 0.02, raw);
}`;

export const bgBlurDef: EffectDef = {
  id: "bg_blur", label: "Background blur", group: "Keying", author: "Tatvam (segmentation: Google MediaPipe, Apache-2.0)", license: "Proprietary",
  description: "Blurs everything but the person (MediaPipe selfie segmentation)",
  segmentation: true, prepare,
  params: [
    { name: "strength", label: "Blur", type: "float", default: 14, min: 0, max: 60, step: 0.5, unit: "px" },
    { name: "feather", label: "Edge softness", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "expand", label: "Expand", type: "float", default: 0, min: -1, max: 1, step: 0.01, description: "Grow or shrink the person matte" },
    { name: "show_mask", label: "Show the mask", type: "bool", default: false },
  ],
  passes: [
    bgBlur([1, 0], true),
    bgBlur([0, 1], false),
    { glsl: `${matte}
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  float m = personAt(uv);
  if (show_mask > 0.5) return vec4(vec3(m), 1.0);
  vec4 b = getColor(uv);
  vec3 bg = mix(o.rgb, b.rgb, smoothstep(0.0, 0.25, b.a));
  return vec4(mix(bg, o.rgb, m), o.a);
}` },
  ],
};

export const bgReplaceDef: EffectDef = {
  id: "bg_replace", label: "Background replace", group: "Keying", author: "Tatvam (segmentation: Google MediaPipe, Apache-2.0)", license: "Proprietary",
  description: "Puts a colour, an image or a blurred plate behind the person (MediaPipe selfie segmentation)",
  segmentation: true, prepare,
  params: [
    { name: "mode", label: "Background", type: "enum", default: "colour", options: [{ value: "colour", label: "Colour" }, { value: "image", label: "Image" }, { value: "plate", label: "Blurred plate" }] },
    { name: "color", label: "Colour", type: "color", default: "#1f8f4e" },
    { name: "backdrop", label: "Image", type: "image", default: "" },
    { name: "strength", label: "Plate blur", type: "float", default: 30, min: 0, max: 60, step: 0.5, unit: "px" },
    { name: "feather", label: "Edge softness", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "expand", label: "Expand", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "wrap", label: "Light wrap", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
  ],
  passes: [
    bgBlur([1, 0], true),
    bgBlur([0, 1], false),
    { glsl: `${matte}
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  float m = personAt(uv);
  vec3 bg;
  if (mode < 0.5) bg = color;
  else if (mode < 1.5) {
    vec2 isz = vec2(textureSize(backdrop, 0));
    float ia = isz.x / max(isz.y, 1.0), fa = uResolution.x / uResolution.y;
    vec2 q = uv - 0.5;
    q *= ia > fa ? vec2(fa / ia, 1.0) : vec2(1.0, ia / fa);
    bg = texture(backdrop, q + 0.5).rgb;
  } else { vec4 b = getColor(uv); bg = mix(o.rgb, b.rgb, smoothstep(0.0, 0.25, b.a)); }
  // light wrap: the new background glows a little into the person's edge
  float edge = m * (1.0 - m) * 4.0;
  vec3 person = mix(o.rgb, 1.0 - (1.0 - o.rgb) * (1.0 - bg), edge * wrap);
  return vec4(mix(bg, person, m), 1.0);
}` },
  ],
};
