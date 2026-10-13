/**
 * The built-in effects (docs/EDITOR.md §4, §10): the first 67 in eight groups, then the 40 of wave 3 (Film, Lens,
 * Clean-up, more Colour, Stylize, Keying, Light and Transform), registered on import. Ports keep their authors' MIT
 * notices (each file's header; full text in licenses.ts); the wave-3 effects are our own.
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
import film_grain from "./film/film_grain.ts";
import film_halation from "./film/halation.ts";
import film_gate_weave from "./film/gate_weave.ts";
import film_scratches_dust from "./film/scratches_dust.ts";
import film_light_flicker from "./film/light_flicker.ts";
import film_damage from "./film/film_damage.ts";
import film_print from "./film/film_print.ts";
import lens_anamorphic_flare from "./lens/anamorphic_flare.ts";
import lens_chromatic_aberration from "./lens/chromatic_aberration.ts";
import lens_distortion from "./lens/lens_distortion.ts";
import lens_bokeh_blur from "./lens/bokeh_blur.ts";
import lens_prism from "./lens/prism.ts";
import lens_vignette_pro from "./lens/vignette_pro.ts";
import lens_diffusion from "./lens/diffusion.ts";
import stylize_vhs from "./stylize/vhs.ts";
import stylize_film_8mm from "./stylize/film_8mm.ts";
import stylize_toon from "./stylize/toon.ts";
import stylize_sketch from "./stylize/sketch.ts";
import stylize_watercolour from "./stylize/watercolour.ts";
import stylize_oil_paint from "./stylize/oil_paint.ts";
import stylize_posterize from "./stylize/posterize.ts";
import stylize_duotone from "./stylize/duotone.ts";
import stylize_tritone from "./stylize/tritone.ts";
import stylize_halftone_pro from "./stylize/halftone_pro.ts";
import stylize_neon_edges from "./stylize/neon_edges.ts";
import stylize_pixel_sort from "./stylize/pixel_sort.ts";
import cleanup_temporal_denoise from "./cleanup/temporal_denoise.ts";
import cleanup_deflicker from "./cleanup/deflicker.ts";
import cleanup_skin_smoothing from "./cleanup/skin_smoothing.ts";
import cleanup_dehaze from "./cleanup/dehaze.ts";
import colour_input_profile from "./colour/input_profile.ts";
import colour_output_transform from "./colour/output_transform.ts";
import { hueVsHue, hueVsSat, lumaVsSat, splitToning } from "./colour/hue_curves.ts";
import { bgBlurDef, bgReplaceDef } from "./keying/background.ts";
import light_leak from "./light/light_leak.ts";
import transform_letterbox from "./transform/letterbox.ts";

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

/** Wave 3 (docs/EDITOR.md §10): 40 more. */
export const WAVE3_EFFECTS: EffectDef[] = [
  film_grain, film_halation, film_gate_weave, film_scratches_dust, film_light_flicker, film_damage, film_print,
  lens_anamorphic_flare, lens_chromatic_aberration, lens_distortion, lens_bokeh_blur, lens_prism, lens_vignette_pro, lens_diffusion,
  stylize_vhs, stylize_film_8mm, stylize_toon, stylize_sketch, stylize_watercolour, stylize_oil_paint, stylize_posterize,
  stylize_duotone, stylize_tritone, stylize_halftone_pro, stylize_neon_edges, stylize_pixel_sort,
  cleanup_temporal_denoise, cleanup_deflicker, cleanup_skin_smoothing, cleanup_dehaze,
  colour_input_profile, colour_output_transform, hueVsSat, hueVsHue, lumaVsSat, splitToning,
  bgBlurDef, bgReplaceDef, light_leak, transform_letterbox,
];
BUILTIN_EFFECTS.push(...WAVE3_EFFECTS);

for (const d of BUILTIN_EFFECTS) registerEffect(d);
