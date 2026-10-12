/**
 * Moods: one-click looks for a whole edit (docs/EDITOR.md §10, editor-looks). Each mood is a colour and texture chain
 * made of the GPU engine's registry effects (look, adjust, wheels, curves, glow, vignette, noise, old film …), a
 * transition style, a caption / title style, a music prompt and a pacing hint. An intensity scales every parameter
 * toward its neutral value (0 = no change, 1 = as designed, up to 1.5 = pushed further, clamped to the ranges).
 *
 * Pure data and maths: the editor (editor/moods/**) applies them to clips, and the studio can reuse them (moodShotFx
 * gives a studio shot's `fx` for the same mood).
 */

export interface MoodEffect { type: string; params: Record<string, unknown> }

export interface MoodTitle {
  font: string; weight: number; color: string; size: number;
  outline?: { color: string; width: number }; shadow?: { color: string; blur: number; x: number; y: number };
  background?: { color: string; padding: number; radius: number };
  animIn?: "none" | "fade" | "slide_up" | "typewriter" | "pop"; animOut?: "none" | "fade" | "slide_down";
  /** Karaoke highlight colour for captions in this mood. */
  highlight: string;
}

export interface MoodDef {
  id: string; label: string; blurb: string;
  /** In chain order, at full strength. */
  effects: MoodEffect[];
  /** Transition ids (xfade or "gl:<name>"), used in turn at the cuts, and their length. */
  transition: { ids: string[]; seconds: number; easing: "linear" | "ease_in" | "ease_out" | "ease_in_out" };
  title: MoodTitle;
  /** A prompt for the AI music tool. */
  music: string;
  /** Average shot length the mood cuts at, in seconds. */
  pacing: { avgShot: number; label: string };
  /** Words in a scene's emotion that suggest this mood. */
  emotions: string[];
  /** Two colours for the UI card. */
  swatch: [string, string];
}

const adj = (p: Record<string, number>): MoodEffect => ({ type: "adjust", params: p });
const look = (id: string, strength: number): MoodEffect => ({ type: "look", params: { look: id, lut_strength: strength } });
const glow = (amount: number, threshold = 0.7, radius = 0.4): MoodEffect => ({ type: "glow", params: { amount, threshold, radius } });
const vignette = (amount: number, size = 0.5): MoodEffect => ({ type: "vignette", params: { size, amount } });
const wheels = (lift: number[], gamma: number[], gain: number[]): MoodEffect => ({ type: "wheels", params: { lift, gamma, gain } });
const curve = (master: number[][]): MoodEffect => ({ type: "curves", params: { master, r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] } });
const T = (font: string, weight: number, color: string, size: number, highlight: string, more: Partial<MoodTitle> = {}): MoodTitle =>
  ({ font, weight, color, size, highlight, shadow: { color: "#000000aa", blur: 12, x: 0, y: 4 }, animIn: "fade", animOut: "fade", ...more });

export const MOODS: MoodDef[] = [
  { id: "romantic", label: "Romantic", blurb: "Warm, soft and glowing skin tones",
    effects: [look("warm", 0.6), adj({ exposure: 0.05, contrast: -0.1, saturation: 0.08, temperature: 0.22, tint: 0.08, vibrance: 0.15 }), glow(0.35, 0.65, 0.45), vignette(0.25, 0.55)],
    transition: { ids: ["fade", "gl:Dreamy", "dissolve"], seconds: 1, easing: "ease_in_out" },
    title: T("Great Vibes", 400, "#fff4ea", 110, "#ff9db8"), music: "Soft romantic piano and strings, warm and intimate, 70 BPM",
    pacing: { avgShot: 4.5, label: "Lingering" }, emotions: ["love", "romance", "romantic", "tender", "intimate", "affection", "longing", "pyaar", "प्रेम", "प्यार"], swatch: ["#f9a8b8", "#c2410c"] },
  { id: "thriller", label: "Thriller", blurb: "Cold steel, crushed shadows, tension",
    effects: [look("teal_orange", 0.7), adj({ contrast: 0.25, saturation: -0.15, temperature: -0.15, gamma: -0.1, sharpen: 0.2 }), vignette(0.45, 0.45)],
    transition: { ids: ["fadeblack", "gl:GlitchDisplace", "hblur"], seconds: 0.5, easing: "ease_in" },
    title: T("Bebas Neue", 400, "#e5edf5", 120, "#38bdf8", { animIn: "pop" }), music: "Tense pulsing synth bass, ticking percussion, rising strings, 100 BPM",
    pacing: { avgShot: 2.2, label: "Tight" }, emotions: ["tense", "tension", "suspense", "danger", "chase", "anxious", "paranoid", "thrill", "threat"], swatch: ["#0e7490", "#111827"] },
  { id: "horror", label: "Horror", blurb: "Sickly, dark and grainy",
    effects: [look("bleach_bypass", 0.6), adj({ exposure: -0.2, contrast: 0.3, saturation: -0.5, temperature: -0.3, tint: 0.1, grain: 0.35 }), vignette(0.7, 0.35), { type: "noise", params: { amount: 0.08, animate: true } }],
    transition: { ids: ["fadeblack", "gl:TVStatic", "fadegrays"], seconds: 0.6, easing: "ease_in" },
    title: T("Cinzel Variable", 700, "#d7d2c8", 100, "#ef4444", { shadow: { color: "#000000", blur: 24, x: 0, y: 0 } }), music: "Dark ambient drones, dissonant strings, distant thuds and sudden hits",
    pacing: { avgShot: 3, label: "Uneasy" }, emotions: ["fear", "horror", "terror", "dread", "scary", "creepy", "haunted", "ghost", "dar", "डर", "भय"], swatch: ["#3f3f46", "#7f1d1d"] },
  { id: "nostalgic", label: "Nostalgic", blurb: "Faded film, warm memories",
    effects: [look("faded_film", 0.7), adj({ contrast: -0.15, saturation: -0.2, temperature: 0.2, grain: 0.3 }),
      { type: "old_film", params: { sepia: 0.25, noise: 0.2, noiseSize: 1, scratch: 0.2, scratchDensity: 0.2, scratchWidth: 1, vignetting: 0.3, vignettingAlpha: 0.8, vignettingBlur: 0.4 } }],
    transition: { ids: ["fade", "gl:FilmBurn", "dissolve"], seconds: 1.2, easing: "ease_in_out" },
    title: T("Playfair Display Variable", 500, "#fbf1dc", 96, "#f5c16c"), music: "Warm vintage acoustic guitar with vinyl crackle, gentle and wistful",
    pacing: { avgShot: 4, label: "Unhurried" }, emotions: ["nostalgia", "nostalgic", "memory", "memories", "childhood", "flashback", "past", "reminisce", "yaad", "याद"], swatch: ["#d6b88a", "#78350f"] },
  { id: "dreamy", label: "Dreamy", blurb: "Pastel haze and bloom",
    effects: [look("pastel", 0.6), adj({ exposure: 0.1, contrast: -0.2, saturation: -0.1, blur: 0.12 }), glow(0.55, 0.5, 0.6)],
    transition: { ids: ["gl:Dreamy", "gl:DreamyZoom", "fade"], seconds: 1.4, easing: "ease_in_out" },
    title: T("Montserrat Variable", 300, "#ffffff", 90, "#c4b5fd", { shadow: { color: "#a78bfa88", blur: 30, x: 0, y: 0 } }), music: "Ethereal ambient pads, soft chimes and reverb guitar, slow",
    pacing: { avgShot: 5, label: "Floating" }, emotions: ["dream", "dreamy", "magical", "wonder", "fantasy", "surreal", "ethereal", "sapna", "सपना"], swatch: ["#e9d5ff", "#93c5fd"] },
  { id: "epic", label: "Epic", blurb: "Big contrast, heroic scale",
    effects: [look("cinematic", 0.8), adj({ contrast: 0.2, saturation: 0.05, gamma: -0.05, sharpen: 0.25, vibrance: 0.1 }), vignette(0.35, 0.5)],
    transition: { ids: ["fadeblack", "gl:CrossZoom", "zoomin"], seconds: 0.8, easing: "ease_in_out" },
    title: T("Cinzel Variable", 800, "#f8e7b5", 120, "#fbbf24", { animIn: "slide_up" }), music: "Epic orchestral score, big taiko drums, choir, heroic brass",
    pacing: { avgShot: 3, label: "Building" }, emotions: ["epic", "heroic", "triumph", "victory", "battle", "war", "glory", "courage", "veer", "वीर", "युद्ध"], swatch: ["#f59e0b", "#1e293b"] },
  { id: "devotional", label: "Devotional", blurb: "Golden, serene light",
    effects: [look("golden_hour", 0.7), adj({ exposure: 0.08, temperature: 0.3, saturation: 0.1, vibrance: 0.2 }), glow(0.45, 0.6, 0.5)],
    transition: { ids: ["fade", "dissolve", "gl:fadecolor"], seconds: 1.5, easing: "ease_in_out" },
    title: T("Yatra One", 400, "#fff3c4", 100, "#f59e0b"), music: "Devotional bhajan with harmonium, tabla and temple bells, serene",
    pacing: { avgShot: 5, label: "Meditative" }, emotions: ["devotion", "devotional", "prayer", "divine", "spiritual", "faith", "temple", "bhakti", "peace", "भक्ति", "पूजा"], swatch: ["#fcd34d", "#b45309"] },
  { id: "festival", label: "Festival", blurb: "Saturated colour and sparkle",
    effects: [look("vivid", 0.8), adj({ saturation: 0.3, vibrance: 0.35, contrast: 0.1, exposure: 0.05 }), glow(0.3, 0.7, 0.3)],
    transition: { ids: ["gl:CrossZoom", "slideleft", "circleopen", "gl:pinwheel"], seconds: 0.5, easing: "ease_out" },
    title: T("Baloo 2 Variable", 800, "#ffe066", 110, "#ff4d6d", { outline: { color: "#7c2d12", width: 5 }, animIn: "pop" }), music: "Festive dhol and shehnai, celebratory, energetic Indian folk beat",
    pacing: { avgShot: 1.8, label: "Lively" }, emotions: ["celebration", "festival", "festive", "joy", "joyful", "party", "wedding", "diwali", "holi", "utsav", "उत्सव", "खुशी"], swatch: ["#f472b6", "#facc15"] },
  { id: "monsoon", label: "Monsoon", blurb: "Cool, wet greens and grey skies",
    effects: [look("cool", 0.7), adj({ temperature: -0.25, tint: -0.05, saturation: -0.1, contrast: 0.05, gamma: 0.05 }), { type: "hue_saturation", params: { hue: -0.03, saturation: -0.05 } }],
    transition: { ids: ["gl:ripple", "gl:WaterDrop", "fade"], seconds: 1, easing: "ease_in_out" },
    title: T("Montserrat Variable", 500, "#e0f2fe", 90, "#7dd3fc"), music: "Rain ambience, soft sitar and bansuri, melancholic monsoon raga",
    pacing: { avgShot: 4, label: "Flowing" }, emotions: ["rain", "monsoon", "storm", "wet", "grey", "baarish", "बारिश", "longing"], swatch: ["#64748b", "#0f766e"] },
  { id: "noir", label: "Noir", blurb: "Hard black and white",
    effects: [look("noir", 1), adj({ contrast: 0.35, grain: 0.25, sharpen: 0.1 }), vignette(0.55, 0.45)],
    transition: { ids: ["fadeblack", "radial", "wipeleft"], seconds: 0.7, easing: "linear" },
    title: T("DM Serif Display", 400, "#f5f5f5", 100, "#e5e7eb"), music: "Smoky jazz saxophone, upright bass and brushed drums, late night",
    pacing: { avgShot: 3.5, label: "Measured" }, emotions: ["noir", "crime", "detective", "mystery", "cynical", "betrayal", "night", "shadow"], swatch: ["#e5e5e5", "#0a0a0a"] },
  { id: "comedy", label: "Comedy", blurb: "Bright, clean and cheerful",
    effects: [look("vivid", 0.5), adj({ exposure: 0.1, saturation: 0.2, vibrance: 0.25, contrast: 0.05, temperature: 0.1 })],
    transition: { ids: ["gl:Bounce", "slideleft", "gl:pinwheel", "zoomin"], seconds: 0.4, easing: "ease_out" },
    title: T("Baloo 2 Variable", 800, "#fff200", 110, "#ffffff", { outline: { color: "#000000", width: 6 }, animIn: "pop" }), music: "Quirky pizzicato strings, ukulele and whistles, playful",
    pacing: { avgShot: 1.6, label: "Snappy" }, emotions: ["funny", "comedy", "comic", "humour", "humor", "silly", "playful", "hilarious", "mazaak", "मज़ाक", "हंसी"], swatch: ["#fde047", "#22c55e"] },
  { id: "documentary", label: "Documentary", blurb: "Natural and true to life",
    effects: [look("cinematic", 0.3), adj({ contrast: 0.05, saturation: -0.05, sharpen: 0.1 })],
    transition: { ids: ["fade", "fadeblack"], seconds: 0.8, easing: "linear" },
    title: T("Inter Variable", 600, "#ffffff", 72, "#facc15", { background: { color: "#000000a6", padding: 14, radius: 6 }, shadow: undefined }), music: "Understated piano and strings, thoughtful documentary underscore",
    pacing: { avgShot: 5.5, label: "Observational" }, emotions: ["calm", "informative", "documentary", "real", "honest", "reflective", "neutral", "explain"], swatch: ["#a3a3a3", "#365314"] },
  { id: "action", label: "Action", blurb: "Punchy teal and orange, crisp",
    effects: [look("teal_orange", 0.9), adj({ contrast: 0.3, saturation: 0.15, sharpen: 0.3, vibrance: 0.1 }), vignette(0.3, 0.5)],
    transition: { ids: ["gl:directionalwarp", "gl:CrossZoom", "slideleft", "hblur"], seconds: 0.35, easing: "ease_in" },
    title: T("Anton", 400, "#ffffff", 130, "#f97316", { animIn: "pop", outline: { color: "#000000", width: 3 } }), music: "Hard-hitting trailer percussion, distorted bass and brass stabs, 140 BPM",
    pacing: { avgShot: 1.2, label: "Fast" }, emotions: ["action", "fight", "angry", "anger", "rage", "explosive", "intense", "adrenaline", "revenge", "gussa", "गुस्सा"], swatch: ["#f97316", "#0e7490"] },
  { id: "melancholy", label: "Melancholy", blurb: "Muted blues, heavy and quiet",
    effects: [look("moonlight", 0.6), adj({ saturation: -0.35, contrast: -0.05, temperature: -0.2, exposure: -0.08, grain: 0.15 }), vignette(0.4, 0.5)],
    transition: { ids: ["fade", "fadegrays"], seconds: 1.6, easing: "ease_in_out" },
    title: T("Playfair Display Variable", 400, "#e2e8f0", 90, "#93c5fd"), music: "Slow solo cello and sparse piano, sorrowful and quiet",
    pacing: { avgShot: 6, label: "Slow" }, emotions: ["sad", "sadness", "grief", "loss", "lonely", "melancholy", "heartbreak", "tragic", "despair", "dukh", "दुख", "उदास"], swatch: ["#93c5fd", "#1e3a8a"] },
  { id: "summer", label: "Summer", blurb: "Sunny, bright and saturated",
    effects: [look("golden_hour", 0.6), adj({ exposure: 0.12, saturation: 0.2, vibrance: 0.3, temperature: 0.25, contrast: 0.05 }), glow(0.3, 0.75, 0.35)],
    transition: { ids: ["slideleft", "gl:SimpleZoom", "circleopen"], seconds: 0.6, easing: "ease_out" },
    title: T("Poppins", 800, "#ffffff", 110, "#fb923c", { animIn: "slide_up" }), music: "Sunny upbeat indie pop, acoustic guitar and hand claps",
    pacing: { avgShot: 2.5, label: "Breezy" }, emotions: ["happy", "summer", "sunny", "fun", "carefree", "beach", "holiday", "cheerful", "bright"], swatch: ["#fbbf24", "#38bdf8"] },
  { id: "cyberpunk", label: "Cyberpunk", blurb: "Neon magenta and cyan",
    effects: [look("cross_process", 0.5), adj({ contrast: 0.25, saturation: 0.3, tint: 0.2, temperature: -0.3 }), glow(0.6, 0.55, 0.5),
      { type: "rgb_split", params: { red: [-4, 0], green: [0, 0], blue: [4, 0] } }, vignette(0.4, 0.5)],
    transition: { ids: ["gl:GlitchMemories", "gl:StripDatamoshGlitch", "pixelize"], seconds: 0.5, easing: "linear" },
    title: T("Oswald Variable", 600, "#f0abfc", 110, "#22d3ee", { shadow: { color: "#e879f9", blur: 26, x: 0, y: 0 } }), music: "Dark synthwave with pulsing arpeggios and gated drums, retro-futuristic",
    pacing: { avgShot: 2, label: "Driving" }, emotions: ["futuristic", "neon", "cyber", "tech", "dystopia", "hacker", "sci-fi", "robot"], swatch: ["#e879f9", "#22d3ee"] },
  { id: "mystery", label: "Mystery", blurb: "Dim, cold and secretive",
    effects: [look("moonlight", 0.7), adj({ contrast: 0.15, exposure: -0.1, saturation: -0.25, temperature: -0.2 }), vignette(0.6, 0.4),
      wheels([-0.02, -0.01, 0.03], [0, 0, 0.02], [0, 0, 0])],
    transition: { ids: ["fadeblack", "gl:DefocusBlur", "fade"], seconds: 0.9, easing: "ease_in_out" },
    title: T("Cinzel Variable", 500, "#cbd5e1", 96, "#a5b4fc"), music: "Mysterious celesta and low pizzicato strings, hushed and curious",
    pacing: { avgShot: 3.5, label: "Searching" }, emotions: ["mystery", "mysterious", "secret", "curious", "unknown", "riddle", "rahasya", "रहस्य"], swatch: ["#6366f1", "#0f172a"] },
  { id: "inspiring", label: "Inspiring", blurb: "Lifted, clean and hopeful",
    effects: [look("cinematic", 0.5), adj({ exposure: 0.08, contrast: 0.1, vibrance: 0.2, temperature: 0.1 }), glow(0.25, 0.75, 0.4),
      curve([[0, 0.02], [0.25, 0.24], [0.75, 0.8], [1, 1]])],
    transition: { ids: ["fade", "gl:SimpleZoom", "dissolve"], seconds: 0.9, easing: "ease_in_out" },
    title: T("Montserrat Variable", 700, "#ffffff", 100, "#34d399", { animIn: "slide_up" }), music: "Uplifting piano build with strings and drums, hopeful and bright",
    pacing: { avgShot: 3.5, label: "Rising" }, emotions: ["hope", "hopeful", "inspire", "inspiring", "inspirational", "determined", "uplifting", "dream big", "motivation", "umeed", "उम्मीद"], swatch: ["#34d399", "#0ea5e9"] },
];

export const moodById = (id: string): MoodDef | undefined => MOODS.find((m) => m.id === id);

// ── intensity ────────────────────────────────────────────────────────────────

/** Neutral value and range of each scalable parameter, per effect type ("*" = every parameter of that effect). */
const NEUTRAL: Record<string, Record<string, { n: number | number[]; min?: number; max?: number }>> = {
  look: { lut_strength: { n: 0, min: 0, max: 1 } },
  adjust: {
    exposure: { n: 0, min: -1, max: 1 }, contrast: { n: 0, min: -1, max: 1 }, saturation: { n: 0, min: -1, max: 1 }, temperature: { n: 0, min: -1, max: 1 },
    tint: { n: 0, min: -1, max: 1 }, vibrance: { n: 0, min: -1, max: 1 }, gamma: { n: 0, min: -1, max: 1 }, hue: { n: 0, min: -1, max: 1 },
    sharpen: { n: 0, min: 0, max: 1 }, blur: { n: 0, min: 0, max: 1 }, vignette: { n: 0, min: 0, max: 1 }, grain: { n: 0, min: 0, max: 1 },
  },
  wheels: { lift: { n: [0, 0, 0], min: -1, max: 1 }, gamma: { n: [0, 0, 0], min: -1, max: 1 }, gain: { n: [0, 0, 0], min: -1, max: 1 } },
  glow: { amount: { n: 0, min: 0, max: 1 } },
  vignette: { amount: { n: 0, min: 0, max: 1 } },
  noise: { amount: { n: 0, min: 0, max: 1 } },
  old_film: { sepia: { n: 0, min: 0, max: 1 }, noise: { n: 0, min: 0, max: 1 }, scratch: { n: 0, min: -1, max: 1 }, vignetting: { n: 0, min: 0, max: 1 } },
  rgb_split: { red: { n: [0, 0], min: -100, max: 100 }, green: { n: [0, 0], min: -100, max: 100 }, blue: { n: [0, 0], min: -100, max: 100 } },
  hue_saturation: { hue: { n: 0, min: -1, max: 1 }, saturation: { n: 0, min: -1, max: 1 } },
  vibrance: { amount: { n: 0, min: -1, max: 1 } },
  color_balance: { shadows: { n: [0, 0, 0], min: -1, max: 1 }, midtones: { n: [0, 0, 0], min: -1, max: 1 }, highlights: { n: [0, 0, 0], min: -1, max: 1 } },
  color_overlay: { alpha: { n: 0, min: 0, max: 1 } },
  sepia: { amount: { n: 0, min: 0, max: 1 } },
  grayscale: { amount: { n: 0, min: 0, max: 1 } },
  bloom: { amount: { n: 0, min: 0, max: 2 } },
  advanced_bloom: { bloomScale: { n: 0, min: 0, max: 3 } },
  simple_adjustment: { gamma: { n: 1, min: 0.1, max: 5 }, saturation: { n: 1, min: 0, max: 5 }, contrast: { n: 1, min: 0, max: 5 }, brightness: { n: 1, min: 0, max: 5 },
    red: { n: 1, min: 0, max: 5 }, green: { n: 1, min: 0, max: 5 }, blue: { n: 1, min: 0, max: 5 } },
  hsl_adjustment: { hue: { n: 0, min: -180, max: 180 }, saturation: { n: 0, min: -1, max: 1 }, lightness: { n: 0, min: -1, max: 1 } },
  crt: { noise: { n: 0, min: 0, max: 1 }, vignetting: { n: 0, min: 0, max: 1 }, lineContrast: { n: 0, min: 0, max: 1 } },
  glitch: { offset: { n: 0, min: 0, max: 600 } },
};

export const MAX_INTENSITY = 1.5;
const clamp = (v: number, a = -Infinity, b = Infinity) => Math.max(a, Math.min(b, v));
const round = (v: number) => Math.round(v * 10000) / 10000;
const lerp = (n: number, v: number, k: number) => n + (v - n) * k;

/** True for a curve: 2+ points [x, y]. */
const isCurve = (v: unknown): v is number[][] => Array.isArray(v) && v.length >= 2 && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number"));

/** One parameter at intensity k: numbers and vectors move from neutral toward the designed value; curves toward the diagonal. */
export function scaleParam(type: string, name: string, value: unknown, k: number): unknown {
  k = clamp(k, 0, MAX_INTENSITY);
  if (type === "curves" && isCurve(value)) return value.map(([x, y]) => [x, round(clamp(lerp(x, y, k), 0, 1))]);
  const nd = NEUTRAL[type]?.[name];
  if (!nd) return value;
  if (typeof value === "number" && typeof nd.n === "number") return round(clamp(lerp(nd.n, value, k), nd.min, nd.max));
  if (Array.isArray(value) && Array.isArray(nd.n) && value.every((x) => typeof x === "number")) {
    const nv = nd.n;
    return (value as number[]).map((x, i) => round(clamp(lerp(nv[i] ?? 0, x, k), nd.min, nd.max)));
  }
  return value;
}

/** An effect's parameters at intensity k (0..1.5). */
export function scaleEffect(e: MoodEffect, k: number): MoodEffect {
  return { type: e.type, params: Object.fromEntries(Object.entries(e.params).map(([n, v]) => [n, scaleParam(e.type, n, v, k)])) };
}

/** A mood's chain at an intensity (0 leaves the picture as it is: every parameter at its neutral value). */
export function moodEffects(m: MoodDef, intensity = 1): MoodEffect[] {
  return m.effects.map((e) => scaleEffect(e, intensity));
}

/** A mood's transition length in frames at a frame rate. */
export const moodTransitionFrames = (m: MoodDef, fps: number) => Math.max(1, Math.round(m.transition.seconds * fps));

// ── scene emotions → moods ───────────────────────────────────────────────────

/**
 * The mood a scene's emotion suggests ("quiet grief", "joyful wedding", "डर"): the mood with the most matching words
 * (whole words for Latin, substrings for other scripts), ties to the earlier mood; null when nothing matches.
 */
export function moodForEmotion(emotion: string): MoodDef | null {
  const text = ` ${(emotion || "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")} `;
  if (!text.trim()) return null;
  let best: MoodDef | null = null, score = 0;
  for (const m of MOODS) {
    let s = 0;
    for (const w of m.emotions) {
      const word = w.toLowerCase();
      if (/^[a-z -]+$/.test(word) ? text.includes(` ${word} `) || text.includes(` ${word}s `) : text.includes(word)) s += word.includes(" ") ? 2 : 1;
    }
    if (s > score) { best = m; score = s; }
  }
  return best;
}

// ── the studio's shot fx (reuse) ─────────────────────────────────────────────

/**
 * The same mood as a studio shot's `fx` (docs/ENGINE.md §2: look, lut_strength, adjust, wheels, curves, glow): the
 * effects the FFmpeg render also draws. Registry-only effects (vignette, noise, old film …) fold into adjust where
 * they can (vignette, grain) and are left out otherwise.
 */
export function moodShotFx(m: MoodDef, intensity = 1): Record<string, unknown> {
  const fx: Record<string, unknown> = {};
  const adjust: Record<string, number> = {};
  for (const e of moodEffects(m, intensity)) {
    const p = e.params as Record<string, never>;
    if (e.type === "look") { fx.look = p.look; fx.lut_strength = p.lut_strength; }
    else if (e.type === "adjust") for (const [k, v] of Object.entries(p)) { if (typeof v === "number" && v) adjust[k] = clamp((adjust[k] ?? 0) + v, -1, 1); }
    else if (e.type === "wheels") fx.wheels = { lift: p.lift, gamma: p.gamma, gain: p.gain };
    else if (e.type === "curves") fx.curves = { master: p.master };
    else if (e.type === "glow") fx.glow = { amount: p.amount, threshold: p.threshold, radius: p.radius };
    else if (e.type === "vignette" && typeof p.amount === "number") adjust.vignette = clamp(Math.max(adjust.vignette ?? 0, p.amount), 0, 1);
    else if ((e.type === "noise" || e.type === "old_film") && typeof (p.amount ?? p.noise) === "number") adjust.grain = clamp(Math.max(adjust.grain ?? 0, (p.amount ?? p.noise) as number), 0, 1);
  }
  const clean = Object.fromEntries(Object.entries(adjust).map(([k, v]) => [k, round(v)]).filter(([, v]) => v !== 0));
  if (Object.keys(clean).length) fx.adjust = clean;
  return fx;
}
