/**
 * Audio tools 2 (docs/EDITOR.md §15.4): auto mix, room-tone fill, the breath remover and the audio-reactive
 * visualiser. The public, pure part (templates feature-detect `VISUALIZER_STYLES` / `makeVisualizerSource`):
 */
export { makeVisualizerSource, isVisualizerSource, visualizerSettings, VISUALIZER_DEFAULTS, VISUALIZER_PALETTES, VISUALIZER_STYLES } from "./visualizer.ts";
export type { VisualizerSettings, VisualizerSource, VisualizerStyle } from "./visualizer.ts";
export { LOUDNESS_TARGETS, ROLE_OFFSETS, planAutoMix, applyAutoMix } from "./automix.ts";
export { roomToneFill, removeRoomTone, breathGain } from "./edits.ts";
export { SPECTRUM_BANDS, spectrumKey, spectrumSidecarName } from "./spectrum.ts";
