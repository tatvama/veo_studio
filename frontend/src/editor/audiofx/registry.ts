/**
 * The audio effects (docs/EDITOR.md §11, §11.1): ONE list of ids, groups, parameters and presets shared by the
 * preview (WebAudio, audiofx/graph.ts) and the export (FFmpeg, desktop/src/main/editor-audio*.ts). An effect on a
 * clip, a track (`Track.effects`) or the master (`Sequence.masterEffects`) is an ordinary `EffectInstance` whose type
 * is `"audio:<id>"` (the legacy `"audio:eq"` is `eq3`); every parameter is a keyframeable `Param`. Clip effects key on
 * clip frames, track and master effects on sequence frames.
 *
 * `preview: "realtime"` effects play live in WebAudio with the same maths as their FFmpeg filter; `"cache"` effects
 * play from the desktop's audio render cache (`editor.renderAudioPreview`), i.e. the export graph itself.
 * The FFmpeg mapping the preview was built and measured against is audiofx/ffmpegRef.ts.
 * Pure: no DOM, so Node's type stripping runs the tests on it as written.
 */

export type AudioFxGroup = "Dynamics" | "EQ & filters" | "Clean-up" | "Time & pitch" | "Space" | "Modulation & creative" | "Utility";
export const AUDIO_FX_GROUPS: AudioFxGroup[] = ["Dynamics", "EQ & filters", "Clean-up", "Time & pitch", "Space", "Modulation & creative", "Utility"];

export type AudioParamValue = number | string;
export interface AudioParamDef {
  name: string; label: string;
  /** number: keyframeable; select / text: a held value (string) */
  type: "number" | "select" | "text";
  default: AudioParamValue;
  min?: number; max?: number; step?: number; unit?: string;
  options?: { value: string; label: string }[];
  /** A frequency-like slider (log scale in the UI). */
  log?: boolean;
}
export interface AudioFxPreset { name: string; values: Record<string, AudioParamValue> }
export interface AudioFxDef {
  id: string; group: AudioFxGroup; label: string;
  preview: "realtime" | "cache";
  params: AudioParamDef[];
  presets?: AudioFxPreset[];
  /** Plays exactly like another effect (same params). */
  sameAs?: string;
  note?: string;
  /** Search words. */
  tags?: string[];
}

// ── param helpers ───────────────────────────────────────────────────────────
const n = (name: string, label: string, def: number, min: number, max: number, step: number, unit?: string, log?: boolean): AudioParamDef =>
  ({ name, label, type: "number", default: def, min, max, step, unit, ...(log ? { log } : {}) });
const db = (name: string, label: string, def: number, min = -24, max = 24) => n(name, label, def, min, max, 0.1, "dB");
const hz = (name: string, label: string, def: number, min: number, max: number) => n(name, label, def, min, max, 1, "Hz", true);
const sec = (name: string, label: string, def: number, min: number, max: number, step = 0.001) => n(name, label, def, min, max, step, "s");
const ms = (name: string, label: string, def: number, min: number, max: number, step = 0.1) => n(name, label, def, min, max, step, "ms");
const amt = (name: string, label: string, def: number, min = 0, max = 1, step = 0.01) => n(name, label, def, min, max, step);
const sel = (name: string, label: string, def: string, options: [string, string][]): AudioParamDef =>
  ({ name, label, type: "select", default: def, options: options.map(([value, l]) => ({ value, label: l })) });
const q = (def: number, max = 10) => n("q", "Q", def, 0.1, max, 0.01);

/** FFmpeg asoftclip types (distortion, guitar amp, the creative voices). */
export const CLIP_TYPES: [string, string][] = [
  ["tanh", "Tube (tanh)"], ["hard", "Hard clip"], ["atan", "Soft (atan)"], ["cubic", "Cubic"], ["exp", "Exponential"],
  ["alg", "Algebraic"], ["quintic", "Quintic"], ["sin", "Sine fold"], ["erf", "Error function"],
];
/** Built-in impulse responses (audiofx/ir.ts; the desktop serves the same WAVs at /__media/irs/<preset>.wav). */
export const REVERB_PRESETS: [string, string][] = [
  ["room", "Room"], ["studio", "Studio"], ["hall", "Concert hall"], ["plate", "Plate"], ["church", "Church"], ["cathedral", "Cathedral"],
  ["stage", "Stage"], ["bathroom", "Bathroom"], ["stairwell", "Stairwell"],
];
export const CABINETS: [string, string][] = [["cab_1x12", "1×12 combo"], ["cab_2x12", "2×12 open back"], ["cab_4x12", "4×12 stack"], ["none", "No cabinet"]];
const CHANNEL: [string, string][] = [["both", "Both"], ["left", "Left"], ["right", "Right"]];

/** eq_param band types (FFmpeg: equalizer, lowshelf, highshelf, lowpass, highpass, bandreject, bandpass). */
export const BAND_TYPES: [string, string][] = [
  ["off", "Off"], ["peak", "Bell"], ["lowshelf", "Low shelf"], ["highshelf", "High shelf"], ["lowpass", "Low-pass"],
  ["highpass", "High-pass"], ["notch", "Notch"], ["bandpass", "Band-pass"],
];
export const EQ_PARAM_BANDS = 6;
const PARAM_BAND_DEFAULTS: [string, number][] = [["lowshelf", 100], ["peak", 250], ["peak", 1000], ["peak", 3000], ["peak", 6000], ["highshelf", 10000]];
const eqParamBands = (): AudioParamDef[] => PARAM_BAND_DEFAULTS.flatMap(([type, f], i) => {
  const k = i + 1;
  return [sel(`type${k}`, `Band ${k} type`, type, BAND_TYPES), hz(`freq${k}`, `Band ${k} frequency`, f, 20, 20000), db(`gain${k}`, `Band ${k} gain`, 0), n(`q${k}`, `Band ${k} Q`, 1, 0.1, 30, 0.01)];
});
/** eq_graphic: ten octave bands, each an FFmpeg `equalizer=f=<f>:t=q:w=1.41:g=<dB>` (WebAudio peaking, Q 1.41). */
export const GRAPHIC_BANDS: [string, number][] = [["b31", 31], ["b62", 62], ["b125", 125], ["b250", 250], ["b500", 500], ["b1k", 1000], ["b2k", 2000], ["b4k", 4000], ["b8k", 8000], ["b16k", 16000]];
export const GRAPHIC_Q = 1.41;
const graphicLabel = (f: number) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);

const COMPRESSOR = (t = -24, r = 4, a = 0.01, rel = 0.25): AudioParamDef[] => [
  db("threshold", "Threshold", t, -60, 0), n("ratio", "Ratio", r, 1, 20, 0.1, ":1"), sec("attack", "Attack", a, 0.0001, 1), sec("release", "Release", rel, 0.01, 3, 0.01),
  db("makeup", "Make-up gain", 0, 0, 24), db("knee", "Knee", 2.8, 0, 30),
];

// ── the effects ─────────────────────────────────────────────────────────────
const RT = "realtime" as const, CACHE = "cache" as const;

export const AUDIO_FX: AudioFxDef[] = [
  // Dynamics
  { id: "gain", group: "Dynamics", label: "Gain", preview: RT, params: [db("gain", "Gain", 0, -48, 24)], tags: ["volume", "level"],
    presets: [{ name: "−6 dB", values: { gain: -6 } }, { name: "+6 dB", values: { gain: 6 } }] },
  { id: "compressor", group: "Dynamics", label: "Compressor", preview: RT, params: COMPRESSOR(), tags: ["dynamics"],
    presets: [
      { name: "Gentle", values: { threshold: -18, ratio: 2, attack: 0.02, release: 0.3, makeup: 2, knee: 6 } },
      { name: "Vocal", values: { threshold: -20, ratio: 3, attack: 0.005, release: 0.15, makeup: 4, knee: 6 } },
      { name: "Punchy drums", values: { threshold: -12, ratio: 4, attack: 0.03, release: 0.1, makeup: 3, knee: 2.8 } },
      { name: "Broadcast", values: { threshold: -24, ratio: 6, attack: 0.002, release: 0.2, makeup: 6, knee: 2.8 } },
    ] },
  { id: "multiband", group: "Dynamics", label: "Multiband compressor", preview: CACHE, params: [
    hz("lowCross", "Low crossover", 250, 40, 1000), hz("highCross", "High crossover", 3000, 1000, 12000),
    db("threshold", "Threshold", -24, -60, 0), n("ratio", "Ratio", 3, 1, 20, 0.1, ":1"), sec("attack", "Attack", 0.01, 0.001, 1), sec("release", "Release", 0.2, 0.01, 3, 0.01),
    db("lowGain", "Low gain", 0, -12, 12), db("midGain", "Mid gain", 0, -12, 12), db("highGain", "High gain", 0, -12, 12),
  ] },
  { id: "limiter", group: "Dynamics", label: "Limiter", preview: RT, params: [db("ceiling", "Ceiling", -1, -24, 0), sec("release", "Release", 0.05, 0.001, 1)],
    presets: [{ name: "Safety (−1 dB)", values: { ceiling: -1, release: 0.05 } }, { name: "Broadcast (−2 dB)", values: { ceiling: -2, release: 0.1 } }, { name: "Hard (−0.1 dB)", values: { ceiling: -0.1, release: 0.02 } }] },
  { id: "gate", group: "Dynamics", label: "Noise gate", preview: RT, params: [
    db("threshold", "Threshold", -50, -90, 0), db("range", "Range", -40, -90, 0), sec("attack", "Attack", 0.005, 0.0001, 0.5), sec("release", "Release", 0.12, 0.005, 2), n("ratio", "Ratio", 10, 1, 50, 0.1, ":1"),
  ], tags: ["noise"] },
  { id: "expander", group: "Dynamics", label: "Expander", preview: RT, params: [db("threshold", "Threshold", -40, -90, 0), n("ratio", "Ratio", 2, 1, 10, 0.1, ":1"), sec("attack", "Attack", 0.01, 0.001, 1), sec("release", "Release", 0.1, 0.01, 3)] },
  { id: "deesser", group: "Dynamics", label: "De-esser", preview: CACHE, params: [amt("intensity", "Intensity", 0.5), amt("max", "Max reduction", 0.5), amt("frequency", "Frequency", 0.5)], tags: ["sibilance", "voice"] },
  { id: "auto_level", group: "Dynamics", label: "Auto level", preview: CACHE, params: [ms("frame", "Frame", 500, 10, 8000, 1), n("window", "Window", 31, 3, 301, 2, "frames"), amt("peak", "Peak", 0.95), n("maxGain", "Max gain", 10, 1, 100, 0.1, "×")], tags: ["dynaudnorm", "normalize"] },
  { id: "speech_level", group: "Dynamics", label: "Speech level", preview: CACHE, params: [amt("peak", "Peak", 0.95), n("expansion", "Expansion", 2, 1, 50, 0.1, "×"), n("compression", "Compression", 2, 1, 50, 0.1, "×"), amt("threshold", "Threshold", 0)], tags: ["speechnorm", "voice"] },
  { id: "tube_compressor", group: "Dynamics", label: "Tube compressor", preview: RT, params: [...COMPRESSOR(-18, 3, 0.01, 0.2).filter((p) => p.name !== "knee"), db("drive", "Drive", 6, 0, 24)],
    note: "acompressor, then tanh saturation (drive in, the same back out)", tags: ["warm", "saturation"] },
  { id: "loudness_maximizer", group: "Dynamics", label: "Loudness maximizer", preview: RT, params: [db("boost", "Boost", 6, 0, 24), db("ceiling", "Ceiling", -1, -12, 0), sec("release", "Release", 0.05, 0.001, 1)], tags: ["louder", "limiter"] },
  { id: "mastering", group: "Dynamics", label: "Mastering", preview: CACHE, params: [
    db("low", "Low (100 Hz shelf)", 0, -12, 12), db("mid", "Mid (1 kHz)", 0, -12, 12), db("high", "High (8 kHz shelf)", 0, -12, 12),
    amt("excite", "Exciter", 0), amt("width", "Width", 0), db("boost", "Boost", 0, 0, 18), db("ceiling", "Ceiling", -1, -12, 0),
  ], note: "EQ, exciter, stereo width and a limiter in one panel", tags: ["master"] },
  { id: "dc_offset", group: "Dynamics", label: "DC offset removal", preview: RT, params: [hz("frequency", "High-pass", 5, 1, 40)], tags: ["dc"] },

  // EQ & filters
  { id: "eq3", group: "EQ & filters", label: "EQ (3-band)", preview: RT, params: [
    db("low", "Low", 0), db("mid", "Mid", 0), db("high", "High", 0), hz("lowFreq", "Low frequency", 200, 20, 1000), hz("midFreq", "Mid frequency", 1000, 200, 8000),
    hz("highFreq", "High frequency", 4000, 1000, 16000), n("midQ", "Mid Q", 0.8, 0.1, 10, 0.01),
  ], tags: ["equalizer", "bass", "treble"],
    presets: [{ name: "Warm", values: { low: 3, mid: 0, high: -2 } }, { name: "Bright", values: { low: -1, mid: 0, high: 4 } }, { name: "Telephone-ish", values: { low: -12, mid: 6, high: -12 } }] },
  { id: "eq_graphic", group: "EQ & filters", label: "Graphic EQ (10-band)", preview: RT, params: GRAPHIC_BANDS.map(([k, f]) => db(k, graphicLabel(f), 0, -12, 12)), tags: ["equalizer"],
    presets: [
      { name: "Bass boost", values: { b31: 5, b62: 5, b125: 3, b250: 1 } },
      { name: "Vocal presence", values: { b125: -2, b250: -1, b2k: 2, b4k: 3, b8k: 1 } },
      { name: "Smile", values: { b31: 4, b62: 3, b125: 1, b1k: -2, b4k: 1, b8k: 3, b16k: 4 } },
      { name: "Warm", values: { b62: 2, b125: 2, b250: 1, b4k: -1, b8k: -2, b16k: -3 } },
    ] },
  { id: "eq_param", group: "EQ & filters", label: "Parametric EQ (6-band)", preview: RT, params: eqParamBands(), tags: ["equalizer"],
    note: "Shelves use FFmpeg slope 1 (t=s:w=1), like WebAudio",
    presets: [
      { name: "Voice clarity", values: { type1: "highpass", freq1: 80, q1: 0.707, gain2: -2, freq2: 300, gain4: 3, freq4: 3500, q4: 1.2 } },
      { name: "Kill rumble", values: { type1: "highpass", freq1: 100, q1: 0.707 } },
    ] },
  { id: "highpass", group: "EQ & filters", label: "High-pass", preview: RT, params: [hz("frequency", "Frequency", 80, 10, 2000), q(0.707)], tags: ["low cut", "rumble"] },
  { id: "lowpass", group: "EQ & filters", label: "Low-pass", preview: RT, params: [hz("frequency", "Frequency", 12000, 200, 20000), q(0.707)], tags: ["high cut"] },
  { id: "bandpass", group: "EQ & filters", label: "Band-pass", preview: RT, params: [hz("frequency", "Frequency", 1000, 50, 15000), q(0.707)] },
  { id: "notch", group: "EQ & filters", label: "Notch", preview: RT, params: [hz("frequency", "Frequency", 1000, 20, 20000), q(10, 100)], tags: ["band reject"] },
  { id: "dehum", group: "EQ & filters", label: "De-hum", preview: RT, params: [n("frequency", "Mains", 50, 40, 70, 1, "Hz"), n("harmonics", "Harmonics", 4, 1, 8, 1), q(30, 100)],
    presets: [{ name: "50 Hz mains", values: { frequency: 50 } }, { name: "60 Hz mains", values: { frequency: 60 } }], tags: ["hum", "buzz"] },
  { id: "tilt", group: "EQ & filters", label: "Tilt EQ", preview: RT, params: [db("gain", "Tilt", 0, -12, 12), hz("frequency", "Pivot", 1000, 100, 10000)], tags: ["tiltshelf"] },
  { id: "virtual_bass", group: "EQ & filters", label: "Virtual bass", preview: CACHE, params: [hz("cutoff", "Cutoff", 250, 100, 500), n("strength", "Strength", 3, 0.5, 3, 0.1)] },
  { id: "exciter", group: "EQ & filters", label: "Exciter", preview: CACHE, params: [
    n("amount", "Amount", 1, 0, 64, 0.1), n("drive", "Drive", 8.5, 0.1, 10, 0.1), n("blend", "Blend", 0, -10, 10, 0.1), hz("frequency", "Frequency", 7500, 2000, 12000), hz("ceiling", "Ceiling", 9999, 9999, 20000),
  ], tags: ["harmonics", "air"] },
  { id: "crystalizer", group: "EQ & filters", label: "Crystalizer", preview: CACHE, params: [n("intensity", "Intensity", 2, -10, 10, 0.1)] },

  // Clean-up
  { id: "denoise", group: "Clean-up", label: "Noise reduction", preview: CACHE, params: [amt("amount", "Amount", 0.5)], tags: ["afftdn", "hiss"] },
  { id: "denoise_wavelet", group: "Clean-up", label: "Wavelet denoise", preview: CACHE, params: [db("noise", "Noise level", -45, -90, -10), n("percent", "Amount", 85, 0, 100, 1, "%")] },
  { id: "denoise_nl", group: "Clean-up", label: "Non-local means denoise", preview: CACHE, params: [n("strength", "Strength", 0.001, 0.00001, 10, 0.00001), ms("patch", "Patch", 2, 1, 100), ms("research", "Research", 6, 2, 300)] },
  { id: "declick", group: "Clean-up", label: "De-click", preview: CACHE, params: [ms("window", "Window", 55, 10, 100), n("overlap", "Overlap", 75, 50, 95, 1, "%"), n("threshold", "Threshold", 2, 1, 100, 0.1), n("burst", "Burst fusion", 2, 0, 10, 0.1)] },
  { id: "declip", group: "Clean-up", label: "De-clip", preview: CACHE, params: [ms("window", "Window", 55, 10, 100), n("overlap", "Overlap", 75, 50, 95, 1, "%"), n("threshold", "Threshold", 10, 1, 100, 0.1)] },
  { id: "dialogue_enhance", group: "Clean-up", label: "Dialogue enhance", preview: CACHE, params: [amt("original", "Original", 1), amt("enhance", "Enhance", 1, 0, 3), n("voice", "Voice detection", 2, 2, 32, 0.1)] },
  { id: "voice_enhance", group: "Clean-up", label: "Voice enhance", preview: CACHE, params: [amt("amount", "Amount", 0.5)], note: "High-pass at 80 Hz, less mud at 300 Hz, presence at 3 kHz, de-ess" },
  { id: "trim_silence", group: "Clean-up", label: "Trim silence (edges)", preview: CACHE, params: [db("threshold", "Threshold", -50, -90, -10), sec("keep", "Keep", 0.1, 0, 2, 0.01)] },
  { id: "noise_print", group: "Clean-up", label: "Noise print reduction", preview: CACHE, params: [
    db("reduction", "Reduction", 12, 0, 60), db("floor", "Noise floor", -50, -80, -20), n("noiseStart", "Noise from", 0, 0, 86400, 0.01, "s"), n("noiseEnd", "Noise to", 0, 0, 86400, 0.01, "s"),
  ], note: "Learns the noise from a marked range of the source (Learn noise), then reduces it (afftdn sample_noise)", tags: ["learn", "afftdn"] },
  { id: "hiss_reduction", group: "Clean-up", label: "Hiss reduction", preview: CACHE, params: [db("reduction", "Reduction", 12, 0, 40), hz("frequency", "Above", 4000, 1000, 12000)], tags: ["afftdn"] },
  { id: "dereverb", group: "Clean-up", label: "De-reverb (basic)", preview: CACHE, params: [amt("amount", "Amount", 0.5)], note: "Basic: spectral reduction and a gate on the tail" },
  { id: "center_extract", group: "Clean-up", label: "Centre channel extract", preview: RT, params: [sel("mode", "Centre", "remove", [["remove", "Remove (karaoke)"], ["keep", "Keep (dialogue only)"]]), amt("amount", "Amount", 1)],
    tags: ["karaoke", "vocal remover"] },

  // Time & pitch
  { id: "pitch_shift", group: "Time & pitch", label: "Pitch shift", preview: CACHE, params: [n("semitones", "Semitones", 0, -12, 12, 0.1, "st"), n("cents", "Cents", 0, -100, 100, 1, "ct")], note: "Formants kept" },
  { id: "time_stretch", group: "Time & pitch", label: "Time stretch", preview: CACHE, params: [n("tempo", "Tempo", 1, 0.5, 2, 0.01, "×")] },
  { id: "chipmunk", group: "Time & pitch", label: "Chipmunk", preview: CACHE, params: [n("semitones", "Semitones", 7, 3, 12, 0.5, "st")], tags: ["voice"] },
  { id: "deep_voice", group: "Time & pitch", label: "Deep voice", preview: CACHE, params: [n("semitones", "Semitones", -5, -12, -2, 0.5, "st")], tags: ["voice"] },
  { id: "robot", group: "Time & pitch", label: "Robot", preview: CACHE, params: [amt("amount", "Amount", 1)], tags: ["voice"] },
  { id: "alien", group: "Time & pitch", label: "Alien", preview: CACHE, params: [amt("amount", "Amount", 1)], tags: ["voice"] },
  { id: "pitch_bend", group: "Time & pitch", label: "Pitch bend", preview: CACHE, params: [n("semitones", "Semitones", 0, -24, 24, 0.1, "st")], note: "Keyframe the semitones" },

  // Space
  { id: "reverb", group: "Space", label: "Reverb", preview: RT, params: [sel("preset", "Space", "room", REVERB_PRESETS), amt("mix", "Mix", 0.3), amt("width", "Width", 1, 0, 2), ms("predelay", "Pre-delay", 0, 0, 200, 1)],
    tags: ["room", "hall", "surround"],
    presets: [
      { name: "Small room", values: { preset: "room", mix: 0.2 } }, { name: "Studio", values: { preset: "studio", mix: 0.2 } },
      { name: "Concert hall", values: { preset: "hall", mix: 0.35 } }, { name: "Plate", values: { preset: "plate", mix: 0.3 } },
      { name: "Church", values: { preset: "church", mix: 0.4 } }, { name: "Cathedral", values: { preset: "cathedral", mix: 0.45, predelay: 20 } },
      { name: "Stage", values: { preset: "stage", mix: 0.3 } }, { name: "Bathroom", values: { preset: "bathroom", mix: 0.3 } }, { name: "Stairwell", values: { preset: "stairwell", mix: 0.35 } },
      { name: "Wide surround", values: { preset: "hall", mix: 0.35, width: 1.6 } },
    ] },
  { id: "echo", group: "Space", label: "Echo", preview: RT, params: [ms("delay", "Delay", 300, 5, 2000, 1), amt("feedback", "Feedback", 0.4, 0, 0.95), amt("wet", "Echo level", 0.5)], tags: ["delay"],
    presets: [{ name: "Slapback", values: { delay: 110, feedback: 0.1, wet: 0.4 } }, { name: "Canyon", values: { delay: 600, feedback: 0.55, wet: 0.5 } }] },
  { id: "stereo_widen", group: "Space", label: "Stereo widener", preview: RT, params: [ms("delay", "Delay", 20, 1, 100), amt("feedback", "Feedback", 0.3, 0, 0.9), amt("crossfeed", "Crossfeed", 0.3, 0, 0.8), amt("drymix", "Dry", 0.8)] },
  { id: "haas", group: "Space", label: "Haas widener", preview: RT, params: [ms("delay", "Delay", 15, 1, 40), sel("channel", "Delayed side", "right", [["left", "Left"], ["right", "Right"]])] },
  { id: "mono", group: "Space", label: "Mono", preview: RT, params: [amt("amount", "Amount", 1)] },
  { id: "auto_pan", group: "Space", label: "Auto pan", preview: RT, params: [n("rate", "Rate", 2, 0.01, 20, 0.01, "Hz"), amt("depth", "Depth", 1)], tags: ["apulsator"] },
  { id: "doppler", group: "Space", label: "Doppler", preview: RT, params: [
    sel("path", "Path", "pass_lr", [["pass_lr", "Passes left → right"], ["pass_rl", "Passes right → left"], ["approach", "Comes closer"], ["recede", "Goes away"]]),
    n("speed", "Speed", 20, 1, 100, 0.5, "m/s"), n("distance", "Closest distance", 3, 0.5, 50, 0.1, "m"), amt("center", "Closest at", 0.5),
  ], note: "Pitch, pan and level from a straight path past the listener (audiofx/doppler.ts)", tags: ["car", "pass by"] },

  // Modulation & creative
  { id: "chorus", group: "Modulation & creative", label: "Chorus", preview: RT, params: [ms("delay", "Delay", 25, 5, 50), ms("depth", "Depth", 2, 0.1, 10), n("rate", "Rate", 0.5, 0.05, 5, 0.01, "Hz"), amt("mix", "Mix", 0.5)] },
  { id: "flanger", group: "Modulation & creative", label: "Flanger", preview: RT, params: [ms("delay", "Delay", 0, 0, 30), ms("depth", "Depth", 2, 0, 10), n("regen", "Feedback", 0, -95, 95, 1, "%"), n("width", "Mix", 71, 0, 100, 1, "%"), n("speed", "Rate", 0.5, 0.1, 10, 0.01, "Hz")] },
  { id: "phaser", group: "Modulation & creative", label: "Phaser", preview: RT, params: [
    amt("inGain", "Input", 0.4), amt("outGain", "Output", 0.74), ms("delay", "Delay", 3, 0.1, 5), amt("decay", "Decay", 0.4, 0, 0.99), n("speed", "Rate", 0.5, 0.1, 2, 0.01, "Hz"),
    sel("type", "Wave", "t", [["t", "Triangle"], ["s", "Sine"]]),
  ] },
  { id: "tremolo", group: "Modulation & creative", label: "Tremolo", preview: RT, params: [n("rate", "Rate", 5, 0.1, 20, 0.1, "Hz"), amt("depth", "Depth", 0.5)] },
  { id: "vibrato", group: "Modulation & creative", label: "Vibrato", preview: RT, params: [n("rate", "Rate", 5, 0.1, 20, 0.1, "Hz"), amt("depth", "Depth", 0.5)] },
  { id: "distortion", group: "Modulation & creative", label: "Distortion", preview: RT, params: [sel("type", "Type", "tanh", CLIP_TYPES), db("drive", "Drive", 12, 0, 48), db("output", "Output", 0, -24, 12)], tags: ["asoftclip", "saturation", "overdrive"] },
  { id: "bitcrusher", group: "Modulation & creative", label: "Bitcrusher", preview: RT, params: [n("bits", "Bits", 8, 1, 16, 1), n("samples", "Downsample", 1, 1, 64, 1, "×"), amt("mix", "Mix", 1)], tags: ["acrusher"] },
  { id: "lofi", group: "Modulation & creative", label: "Lo-fi", preview: RT, params: [n("bits", "Bits", 10, 4, 16, 1), n("samples", "Downsample", 3, 1, 16, 1, "×"), hz("cutoff", "Tone", 5000, 1000, 12000)] },
  { id: "telephone", group: "Modulation & creative", label: "Telephone", preview: RT, params: [hz("low", "Low cut", 300, 100, 1000), hz("high", "High cut", 3400, 2000, 8000)], tags: ["phone", "voice"] },
  { id: "radio", group: "Modulation & creative", label: "Old radio", preview: RT, params: [hz("low", "Low cut", 200, 50, 1000), hz("high", "High cut", 5000, 2000, 10000), db("drive", "Drive", 6, 0, 30), db("noise", "Static", -50, -90, -20)], tags: ["voice", "am"] },
  { id: "megaphone", group: "Modulation & creative", label: "Megaphone", preview: RT, params: [hz("low", "Low cut", 500, 100, 1500), hz("high", "High cut", 3500, 1500, 8000), db("drive", "Drive", 12, 0, 36)], tags: ["voice", "bullhorn"] },
  { id: "walkie_talkie", group: "Modulation & creative", label: "Walkie-talkie", preview: RT, params: [hz("low", "Low cut", 400, 100, 1500), hz("high", "High cut", 2800, 1500, 8000), db("drive", "Drive", 18, 0, 36), db("noise", "Static", -40, -90, -20)], tags: ["voice", "radio"] },
  { id: "underwater", group: "Modulation & creative", label: "Underwater", preview: RT, params: [hz("cutoff", "Muffle", 600, 100, 2000), amt("wobble", "Wobble", 0.3)] },
  { id: "next_room", group: "Modulation & creative", label: "Next room", preview: RT, params: [hz("cutoff", "Wall", 400, 100, 2000), amt("room", "Room", 0.35), db("level", "Level", -6, -24, 0)], tags: ["muffled", "party"] },
  { id: "vinyl", group: "Modulation & creative", label: "Vinyl", preview: RT, params: [amt("crackle", "Crackle", 0.5), amt("wow", "Wow", 0.3)], tags: ["record", "crackle", "old"] },
  { id: "guitar_amp", group: "Modulation & creative", label: "Guitar amp", preview: RT, params: [
    db("drive", "Drive", 24, 0, 48), sel("type", "Character", "tanh", CLIP_TYPES), db("bass", "Bass", 0, -12, 12), db("mid", "Mid", 0, -12, 12), db("treble", "Treble", 0, -12, 12),
    sel("cabinet", "Cabinet", "cab_4x12", CABINETS), db("level", "Level", -12, -36, 6),
  ], tags: ["amp", "cabinet", "overdrive"],
    presets: [{ name: "Clean", values: { drive: 6, type: "tanh", cabinet: "cab_1x12", level: -6 } }, { name: "Crunch", values: { drive: 24, type: "tanh", mid: 3 } }, { name: "High gain", values: { drive: 40, type: "hard", bass: 3, mid: -3, treble: 2, level: -18 } }] },
  { id: "invert", group: "Modulation & creative", label: "Invert", preview: RT, sameAs: "invert_polarity", params: [sel("channel", "Channels", "both", CHANNEL)] },
  { id: "silence", group: "Modulation & creative", label: "Silence", preview: RT, params: [] },

  // Utility
  { id: "channel_swap", group: "Utility", label: "Swap channels", preview: RT, params: [] },
  { id: "left_only", group: "Utility", label: "Left channel only", preview: RT, params: [] },
  { id: "right_only", group: "Utility", label: "Right channel only", preview: RT, params: [] },
  { id: "invert_polarity", group: "Utility", label: "Invert polarity", preview: RT, params: [sel("channel", "Channels", "both", CHANNEL)], tags: ["phase"] },
  { id: "mono_to_stereo", group: "Utility", label: "Mono to stereo", preview: RT, params: [ms("delay", "Delay", 12, 1, 40), amt("width", "Width", 0.5)], tags: ["pseudo stereo"] },
  { id: "delay_sync", group: "Utility", label: "Delay (sync)", preview: RT, params: [ms("delay", "Delay", 0, 0, 500, 0.1)], tags: ["compensation", "offset"] },
];

const BY_ID = new Map(AUDIO_FX.map((d) => [d.id, d]));
/** Other names the export accepts for an id (legacy and §11.1 aliases). */
export const AUDIO_FX_ALIASES: Record<string, string> = { eq: "eq3", surround_reverb: "reverb" };

/** The registry id of an effect type: "audio:eq3" / "eq3" → "eq3"; "audio:eq" → "eq3"; null when not an audio effect. */
export function audioFxId(type: string): string | null {
  const bare = type.startsWith("audio:") ? type.slice(6) : type;
  const id = AUDIO_FX_ALIASES[bare] ?? bare;
  return BY_ID.has(id) ? id : null;
}
/** The EffectInstance type of a registry id. */
export const audioFxType = (id: string) => `audio:${id}`;
export const audioFxDef = (typeOrId: string): AudioFxDef | undefined => { const id = audioFxId(typeOrId); return id ? BY_ID.get(id) : undefined; };
export const isAudioFxType = (type: string) => audioFxId(type) !== null;
/** The id whose implementation plays this one ("invert" plays as "invert_polarity"). */
export const implId = (id: string) => BY_ID.get(id)?.sameAs ?? id;

/** Default values of an effect's params. */
export function audioFxDefaults(id: string): Record<string, AudioParamValue> {
  const d = audioFxDef(id);
  return Object.fromEntries((d?.params ?? []).map((p) => [p.name, p.default]));
}

/** Values for an effect, with defaults filled and numbers clamped to the declared range (unknown names dropped). */
export function resolveParams(id: string, values: Record<string, unknown>): Record<string, AudioParamValue> {
  const d = audioFxDef(id);
  const out: Record<string, AudioParamValue> = {};
  for (const p of d?.params ?? []) {
    const v = values[p.name];
    if (p.type === "number") {
      const x = typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : (p.default as number);
      out[p.name] = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, x));
    } else if (p.type === "select") {
      const s = typeof v === "string" ? v : String(p.default);
      out[p.name] = p.options?.some((o) => o.value === s) ? s : String(p.default);
    } else out[p.name] = typeof v === "string" ? v : String(p.default);
  }
  return out;
}

/** True when any of the effects needs the render cache to be heard (it is enabled and a "cache" effect). */
export function needsCache(effects: { type: string; enabled?: boolean }[]): boolean {
  return effects.some((e) => e.enabled !== false && audioFxDef(e.type)?.preview === "cache");
}

/** Effects by group, in registry order (the add menu, the Effects panel). */
export function byGroup(defs: AudioFxDef[] = AUDIO_FX): { group: AudioFxGroup; defs: AudioFxDef[] }[] {
  return AUDIO_FX_GROUPS.map((group) => ({ group, defs: defs.filter((d) => d.group === group) })).filter((g) => g.defs.length);
}

export function searchAudioFx(q: string, defs: AudioFxDef[] = AUDIO_FX): AudioFxDef[] {
  const s = q.trim().toLowerCase();
  if (!s) return defs;
  return defs.filter((d) => d.label.toLowerCase().includes(s) || d.id.includes(s) || d.group.toLowerCase().includes(s) || (d.tags ?? []).some((t) => t.includes(s)));
}

// ── chain presets: several effects in one click (the AudioEffects panel's Presets menu) ──────────────────
export interface ChainPreset { id: string; group: "Voice" | "Space" | "Music" | "Creative"; name: string; effects: { id: string; values?: Record<string, AudioParamValue> }[] }
export const CHAIN_PRESETS: ChainPreset[] = [
  { id: "podcast_voice", group: "Voice", name: "Podcast voice", effects: [
    { id: "highpass", values: { frequency: 80 } }, { id: "compressor", values: { threshold: -22, ratio: 3, attack: 0.005, release: 0.15, makeup: 5, knee: 6 } },
    { id: "eq_param", values: { gain2: -2, freq2: 300, gain4: 3, freq4: 3500, q4: 1.2 } }, { id: "limiter", values: { ceiling: -1 } }] },
  { id: "radio_host", group: "Voice", name: "Radio host", effects: [
    { id: "highpass", values: { frequency: 70 } }, { id: "compressor", values: { threshold: -26, ratio: 5, attack: 0.002, release: 0.12, makeup: 8, knee: 2.8 } },
    { id: "eq3", values: { low: 3, lowFreq: 150, mid: -1, high: 3, highFreq: 5000 } }, { id: "limiter", values: { ceiling: -1 } }] },
  { id: "warm_narrator", group: "Voice", name: "Warm narrator", effects: [
    { id: "highpass", values: { frequency: 60 } }, { id: "tube_compressor", values: { threshold: -20, ratio: 2.5, makeup: 3, drive: 4 } },
    { id: "eq3", values: { low: 2, lowFreq: 180, high: -1.5, highFreq: 6000 } }, { id: "reverb", values: { preset: "studio", mix: 0.08 } }] },
  { id: "clean_dialogue", group: "Voice", name: "Clean dialogue", effects: [
    { id: "highpass", values: { frequency: 90 } }, { id: "gate", values: { threshold: -55, range: -20 } }, { id: "compressor", values: { threshold: -20, ratio: 2.5, makeup: 3 } }] },
  { id: "phone_call", group: "Voice", name: "Phone call", effects: [{ id: "telephone" }, { id: "distortion", values: { type: "tanh", drive: 6, output: -3 } }] },
  { id: "small_room", group: "Space", name: "Small room", effects: [{ id: "reverb", values: { preset: "room", mix: 0.2 } }] },
  { id: "concert_hall", group: "Space", name: "Concert hall", effects: [{ id: "reverb", values: { preset: "hall", mix: 0.35 } }] },
  { id: "big_church", group: "Space", name: "Big church", effects: [{ id: "reverb", values: { preset: "cathedral", mix: 0.45, predelay: 25 } }] },
  { id: "master_gentle", group: "Music", name: "Master bus (gentle)", effects: [
    { id: "eq3", values: { low: 1, high: 1 } }, { id: "compressor", values: { threshold: -16, ratio: 2, attack: 0.02, release: 0.3, makeup: 2, knee: 6 } }, { id: "limiter", values: { ceiling: -1 } }] },
  { id: "loud_clear", group: "Music", name: "Loud and clear", effects: [{ id: "loudness_maximizer", values: { boost: 6, ceiling: -1 } }] },
  { id: "lofi_radio", group: "Creative", name: "Lo-fi radio", effects: [{ id: "lofi" }, { id: "vinyl", values: { crackle: 0.4, wow: 0.2 } }] },
];

// ── generator clips (§11.1 "Generate": a clip source, not an effect) ──────────────────────────────────────
export type GeneratorKind = "tone" | "noise" | "dtmf";
export interface GeneratorDef { kind: GeneratorKind; label: string; params: AudioParamDef[]; note?: string }
export const GENERATORS: GeneratorDef[] = [
  { kind: "tone", label: "Tone", params: [
    sel("wave", "Wave", "sine", [["sine", "Sine"], ["square", "Square"], ["sawtooth", "Sawtooth"], ["triangle", "Triangle"]]),
    hz("frequency", "Frequency", 1000, 20, 20000), n("sweepTo", "Sweep to", 0, 0, 20000, 1, "Hz"),
    sel("sweep", "Sweep", "log", [["log", "Logarithmic"], ["linear", "Linear"]]), db("level", "Level", -18, -60, 0),
  ], note: "Sweep to 0 = a steady tone" },
  { kind: "noise", label: "Noise", params: [
    sel("color", "Colour", "pink", [["white", "White"], ["pink", "Pink"], ["brown", "Brown"], ["blue", "Blue"], ["violet", "Violet"], ["velvet", "Velvet"]]),
    db("level", "Level", -24, -60, 0), n("density", "Density (velvet)", 0.05, 0.001, 1, 0.001), n("seed", "Seed", 1, 0, 99999, 1),
  ], note: "FFmpeg anoisesrc; level = amplitude (dBFS)" },
  { kind: "dtmf", label: "DTMF tones", params: [
    { name: "digits", label: "Digits", type: "text", default: "0123456789*#" }, ms("tone", "Tone", 100, 40, 1000, 1), ms("gap", "Gap", 60, 20, 1000, 1), db("level", "Level", -12, -60, 0),
  ] },
];
export const generatorDef = (kind: string) => GENERATORS.find((g) => g.kind === kind);
export function generatorDefaults(kind: GeneratorKind): Record<string, AudioParamValue> {
  return Object.fromEntries((generatorDef(kind)?.params ?? []).map((p) => [p.name, p.default]));
}

// ── audio transitions (§11.1: on an audio cut, like video transitions; FFmpeg acrossfade curves) ──────────
export interface AudioTransitionDef { id: string; label: string; curve: string; note?: string }
/** `curve` = the acrossfade / afade curve name; the first is the default crossfade. */
export const AUDIO_TRANSITION_DEFS: AudioTransitionDef[] = [
  { id: "audio:constant_power", label: "Constant power", curve: "qsin", note: "The default crossfade" },
  { id: "audio:constant_gain", label: "Constant gain", curve: "tri" },
  { id: "audio:exponential", label: "Exponential fade", curve: "exp" },
  { id: "audio:hsin", label: "Half sine", curve: "hsin" }, { id: "audio:esin", label: "Exponential sine", curve: "esin" },
  { id: "audio:log", label: "Logarithmic", curve: "log" }, { id: "audio:ipar", label: "Inverted parabola", curve: "ipar" },
  { id: "audio:qua", label: "Quadratic", curve: "qua" }, { id: "audio:cub", label: "Cubic", curve: "cub" },
  { id: "audio:squ", label: "Square root", curve: "squ" }, { id: "audio:cbr", label: "Cubic root", curve: "cbr" },
  { id: "audio:par", label: "Parabola", curve: "par" }, { id: "audio:iqsin", label: "Inverted quarter sine", curve: "iqsin" },
  { id: "audio:ihsin", label: "Inverted half sine", curve: "ihsin" }, { id: "audio:dese", label: "Double-exponential seat", curve: "dese" },
  { id: "audio:desi", label: "Double-exponential sigmoid", curve: "desi" }, { id: "audio:losi", label: "Logistic sigmoid", curve: "losi" },
  { id: "audio:sinc", label: "Sine cardinal", curve: "sinc" }, { id: "audio:isinc", label: "Inverted sine cardinal", curve: "isinc" },
  { id: "audio:nofade", label: "Cut (no fade)", curve: "nofade" },
];
/** The acrossfade curve of an audio transition type (unknown → qsin, like the export). */
export function transitionCurve(type: string): string {
  const d = AUDIO_TRANSITION_DEFS.find((x) => x.id === type);
  if (d) return d.curve;
  const bare = type.startsWith("audio:") ? type.slice(6) : type;
  return AUDIO_TRANSITION_DEFS.find((x) => x.curve === bare)?.curve ?? (/gain|linear|tri/i.test(type) ? "tri" : "qsin");
}

// ── Essential Sound roles (§11.1) ────────────────────────────────────────────────────────────────────────
export type SoundRole = "dialogue" | "music" | "sfx" | "ambience";
export const SOUND_ROLES: { id: SoundRole; label: string }[] = [
  { id: "dialogue", label: "Dialogue" }, { id: "music", label: "Music" }, { id: "sfx", label: "SFX" }, { id: "ambience", label: "Ambience" },
];
