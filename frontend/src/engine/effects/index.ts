/**
 * The built-in effects (docs/EDITOR.md §4): 67 in eight groups, registered on import. Ports keep their
 * authors' MIT notices (each file's header; full text in licenses.ts).
 */
import { registerEffect, type EffectDef } from "./registry.ts";
import colour_adjust from "./colour/adjust.ts";
import colour_brightness_contrast from "./colour/brightness_contrast.ts";
import colour_channel_mixer from "./colour/channel_mixer.ts";
import colour_color_balance from "./colour/color_balance.ts";
import colour_color_map from "./colour/color_map.ts";
import colour_color_overlay from "./colour/color_overlay.ts";
import colour_color_replace from "./colour/color_replace.ts";
import colour_curves from "./colour/curves.ts";
import colour_grayscale from "./colour/grayscale.ts";
import colour_hsl_adjustment from "./colour/hsl_adjustment.ts";
import colour_hsl_qualifier from "./colour/hsl_qualifier.ts";
import colour_hue_saturation from "./colour/hue_saturation.ts";
import colour_look from "./colour/look.ts";
import colour_multi_color_replace from "./colour/multi_color_replace.ts";
import colour_sepia from "./colour/sepia.ts";
import colour_simple_adjustment from "./colour/simple_adjustment.ts";
import colour_vibrance from "./colour/vibrance.ts";
import colour_wheels from "./colour/wheels.ts";
import keying_bevel from "./keying/bevel.ts";
import keying_chroma from "./keying/chroma.ts";
import keying_drop_shadow from "./keying/drop_shadow.ts";
import keying_luma_key from "./keying/luma_key.ts";
import keying_mask from "./keying/mask.ts";
import keying_outer_glow from "./keying/outer_glow.ts";
import keying_outline from "./keying/outline.ts";
import blur_convolution from "./blur/convolution.ts";
import blur_denoise from "./blur/denoise.ts";
import blur_gaussian_blur from "./blur/gaussian_blur.ts";
import blur_kawase_blur from "./blur/kawase_blur.ts";
import blur_lens_blur from "./blur/lens_blur.ts";
import blur_motion_blur from "./blur/motion_blur.ts";
import blur_radial_blur from "./blur/radial_blur.ts";
import blur_tilt_shift from "./blur/tilt_shift.ts";
import blur_triangle_blur from "./blur/triangle_blur.ts";
import blur_unsharp_mask from "./blur/unsharp_mask.ts";
import blur_zoom_blur from "./blur/zoom_blur.ts";
import distort_bulge_pinch from "./distort/bulge_pinch.ts";
import distort_glitch from "./distort/glitch.ts";
import distort_reflection from "./distort/reflection.ts";
import distort_rgb_split from "./distort/rgb_split.ts";
import distort_shockwave from "./distort/shockwave.ts";
import distort_twist from "./distort/twist.ts";
import distort_wave from "./distort/wave.ts";
import stylize_ascii from "./stylize/ascii.ts";
import stylize_color_halftone from "./stylize/color_halftone.ts";
import stylize_cross_hatch from "./stylize/cross_hatch.ts";
import stylize_crt from "./stylize/crt.ts";
import stylize_dot_screen from "./stylize/dot_screen.ts";
import stylize_edge_work from "./stylize/edge_work.ts";
import stylize_emboss from "./stylize/emboss.ts";
import stylize_hexagonal_pixelate from "./stylize/hexagonal_pixelate.ts";
import stylize_ink from "./stylize/ink.ts";
import stylize_noise from "./stylize/noise.ts";
import stylize_old_film from "./stylize/old_film.ts";
import stylize_pixelate from "./stylize/pixelate.ts";
import stylize_vignette from "./stylize/vignette.ts";
import light_advanced_bloom from "./light/advanced_bloom.ts";
import light_bloom from "./light/bloom.ts";
import light_glow from "./light/glow.ts";
import light_godray from "./light/godray.ts";
import light_simple_lightmap from "./light/simple_lightmap.ts";
import generate_color_gradient from "./generate/color_gradient.ts";
import generate_simplex_noise from "./generate/simplex_noise.ts";
import transform_crop from "./transform/crop.ts";
import transform_flip from "./transform/flip.ts";
import transform_move from "./transform/move.ts";
import transform_perspective from "./transform/perspective.ts";

export const BUILTIN_EFFECTS: EffectDef[] = [
  colour_adjust, colour_brightness_contrast, colour_channel_mixer, colour_color_balance, colour_color_map,
  colour_color_overlay, colour_color_replace, colour_curves, colour_grayscale, colour_hsl_adjustment,
  colour_hsl_qualifier, colour_hue_saturation, colour_look, colour_multi_color_replace, colour_sepia,
  colour_simple_adjustment, colour_vibrance, colour_wheels, keying_bevel, keying_chroma, keying_drop_shadow,
  keying_luma_key, keying_mask, keying_outer_glow, keying_outline, blur_convolution, blur_denoise,
  blur_gaussian_blur, blur_kawase_blur, blur_lens_blur, blur_motion_blur, blur_radial_blur, blur_tilt_shift,
  blur_triangle_blur, blur_unsharp_mask, blur_zoom_blur, distort_bulge_pinch, distort_glitch, distort_reflection,
  distort_rgb_split, distort_shockwave, distort_twist, distort_wave, stylize_ascii, stylize_color_halftone,
  stylize_cross_hatch, stylize_crt, stylize_dot_screen, stylize_edge_work, stylize_emboss,
  stylize_hexagonal_pixelate, stylize_ink, stylize_noise, stylize_old_film, stylize_pixelate, stylize_vignette,
  light_advanced_bloom, light_bloom, light_glow, light_godray, light_simple_lightmap, generate_color_gradient,
  generate_simplex_noise, transform_crop, transform_flip, transform_move, transform_perspective,
];

for (const d of BUILTIN_EFFECTS) registerEffect(d);
