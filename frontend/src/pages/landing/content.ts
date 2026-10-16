/**
 * Everything the landing page says, in one place. Each claim here is something the studio does today (README.md,
 * docs/USER_GUIDE.md, docs/DESKTOP.md): keep it that way when you edit, because this is the public page.
 */
import {
  AudioWaveform, Bot, Boxes, Clapperboard, Film, Languages, Megaphone, MonitorPlay, PenLine, ScanFace, ShieldCheck, Workflow,
  type LucideIcon,
} from "lucide-react";

export const NAV = [
  { id: "features", label: "Features" },
  { id: "how", label: "How it works" },
  { id: "india", label: "Made in India" },
  { id: "cost", label: "Cost" },
  { id: "faq", label: "FAQ" },
] as const;

/** "story" in the five languages the studio writes and speaks. The hero cycles through them. */
export const HERO_WORDS = [
  { text: "कहानी", lang: "hi" },
  { text: "கதை", lang: "ta" },
  { text: "కథ", lang: "te" },
  { text: "ಕಥೆ", lang: "kn" },
  { text: "story", lang: "en" },
] as const;

export const PROOF = ["Free to join", "5 Indian languages", "Every cost shown in ₹ first"];

export const STATS: { value: number; suffix: string; label: string; glyph?: string }[] = [
  { value: 5, suffix: "", label: "Indian languages for scripts, voices and captions" },
  { value: 800, suffix: "+", label: "AI models under one roof" },
  { value: 4, suffix: "K", label: "finishing, on your own graphics card" },
  { value: 0, suffix: "", glyph: "₹", label: "shown first, on every paid step" },
];

export type FeatureId = "director" | "writers" | "lock" | "shots" | "hub" | "timeline" | "sound" | "voices" | "desktop" | "ads" | "team" | "autopilot";
export interface Feature { id: FeatureId; icon: LucideIcon; title: string; text: string; tag?: string; wide?: boolean }

/** In reading order; the three wide cards carry a small picture. */
export const FEATURES: Feature[] = [
  { id: "director", icon: Bot, wide: true, tag: "Claude or Gemini", title: "A Director that works for you",
    text: "Talk to your studio. The Director plans, writes and runs any step for you, and asks before it spends anything." },
  { id: "writers", icon: PenLine, title: "A writers' room in a box",
    text: "Scored hooks, scripts a critic rewrites until they pass, table reads in your cast's voices, and a native-speaker polish in every language." },
  { id: "lock", icon: ScanFace, title: "Characters that stay themselves",
    text: "Lock the face, body, costume, voice and gestures of every character, so they look like themselves in every shot." },
  { id: "shots", icon: Clapperboard, wide: true, tag: "Shootouts", title: "Shots you can trust",
    text: "Run two to four engines on the same shot and keep the best take. Keyframe checks and automatic retakes keep a scene consistent from the first frame to the last." },
  { id: "hub", icon: Boxes, wide: true, tag: "800+ models", title: "Every leading model, one studio",
    text: "Veo, Kling, Seedance, Wan, Hailuo, FLUX and more, with Saver, Balanced and Hero routing and automatic fallbacks when an engine is busy." },
  { id: "timeline", icon: Film, title: "A real editor, not a toy",
    text: "J/K/L shuttle, roll trims, speed ramps, keyframes, waveforms, karaoke captions and 106 title templates." },
  { id: "sound", icon: AudioWaveform, title: "Sound that finishes the film",
    text: "136 generated sound effects, Auto SFX that places them where the cut needs them, 75 audio effects, loudness meters and automatic ducking." },
  { id: "voices", icon: Languages, title: "Voices and lip-sync in your language",
    text: "Indian-language voices from Sarvam, plus ElevenLabs and Gemini. Design a voice, clone one with a consent record, and dub with lip-sync." },
  { id: "desktop", icon: MonitorPlay, title: "4K finishing on your own GPU",
    text: "The Windows app upscales shots to 4K or 2K with AI on your own NVIDIA, AMD or Intel graphics card, and renders locally with hardware encoding." },
  { id: "ads", icon: Megaphone, title: "Ads, Reels and posters",
    text: "Cut-downs for Shorts and Reels, ad variants in every language, and a drag-and-drop Poster Studio with festival greetings and brand kits." },
  { id: "team", icon: ShieldCheck, title: "Built for teams and clients",
    text: "Roles from Viewer to Admin, budgets per team, person and project, an approvals inbox, an audit log and client review links with timeline comments." },
  { id: "autopilot", icon: Workflow, title: "Autopilot, and MCP for Claude",
    text: "Hand Autopilot a concept and it runs the pipeline end to end. Or drive the whole studio from Claude Code, Claude Desktop or claude.ai." },
];

/** One line under each step of the studio (the labels and blurbs come from components/shell/nav.ts). */
export const STEP_DETAIL: Record<string, string> = {
  story: "A brief, six scored hooks, a script the critic approves, and scene cards.",
  cast: "Characters, places and props with reference sheets, locked so they never drift.",
  shots: "Keyframes first, then video. Pick an engine per shot, or run a shootout.",
  edit: "A pro timeline with music, voice, sound effects and titles.",
  deliver: "Render for Shorts, Reels or YouTube, collect feedback, make ads and posters.",
};

export const INDIA_POINTS: { title: string; text: string }[] = [
  { title: "Speaks your language", text: "Scripts, voices, captions and dubbing in Hindi, Kannada, Telugu, Tamil and English, with a native-speaker polish on every translation." },
  { title: "Rupees, not guesswork", text: "Every estimate, budget and receipt shows in ₹ beside the dollar price, and nothing paid runs until you approve it." },
  { title: "Stories that look like home", text: "Festival posters, Indian-language voices and a showreel of Indian stories: Holi, monsoon rooftops, Kerala backwaters." },
];

/** What each quality tier is for (the price per second comes from the server: GET /api/public/rates). */
export const TIER_COPY: Record<string, { name: string; for: string }> = {
  saver: { name: "Saver", for: "Drafts, storyboards and quick social clips" },
  balanced: { name: "Balanced", for: "Everyday quality for most shots" },
  hero: { name: "Hero", for: "Hero shots, finished at 1080p" },
};

/** Used only if the rates endpoint can't be reached, so the estimator never shows an empty box. */
export const FALLBACK_RATES = {
  usd_inr: 97,
  tiers: [
    { id: "saver", resolution: "720p", usd_per_second: 0.05 },
    { id: "balanced", resolution: "720p", usd_per_second: 0.1 },
    { id: "hero", resolution: "1080p", usd_per_second: 0.4 },
  ],
};

/** The providers the studio connects to today, and what each one does for you. */
export const BUILT_ON: { name: string; what: string }[] = [
  { name: "Google", what: "Veo 3.1 video, Gemini writing, Nano Banana images and Lyria music" },
  { name: "Anthropic", what: "Claude, the brain of the Director and the writers' room" },
  { name: "ElevenLabs", what: "Natural voices and voice design" },
  { name: "Sarvam AI", what: "Bulbul, voices that sound right in Indian languages" },
  { name: "sync.so", what: "Lip-sync that follows the dialogue" },
  { name: "fal.ai", what: "Kling, Wan, Hailuo, FLUX, LTX and many more" },
  { name: "BytePlus", what: "Seedance video and Seedream images" },
  { name: "OpenRouter", what: "More video and text models behind one account" },
];

/**
 * Recognition and partnerships, shown as a row of badges above the provider list. Empty on purpose: add an entry only
 * when it is true and you hold the paperwork (the partner programme's written confirmation, the DPIIT certificate
 * number). Do not use the national emblem or a government's or company's logo without their permission: say it in words.
 *
 *   { name: "Startup India", line: "DPIIT-recognised startup · Certificate no. …" },
 *   { name: "NVIDIA Inception", line: "Member of the NVIDIA Inception programme" },
 */
export const RECOGNITION: { name: string; line: string }[] = [];

export const FAQ: { q: string; a: string }[] = [
  { q: "What is Tatvam AI Studio?",
    a: "An AI video studio that takes you from a concept to a finished, edited film: story, cast, shots, edit and delivery in one place, with a Director that can do any step for you." },
  { q: "Which languages does it support?",
    a: "English, Hindi, Kannada, Telugu and Tamil: scripts, voices, captions and dubbing, with a native-speaker polish on translations." },
  { q: "How much does it cost?",
    a: "You pay for what you generate. Every paid step shows its price in rupees first, budgets can be set per team, person and project, and nothing runs without approval. Try the estimator above, and join the waitlist so we can tell you the moment your invite is ready." },
  { q: "Do I need to know AI tools or video editing?",
    a: "No. The Director can plan, write and run steps for you, Autopilot can take a concept all the way to a first cut, and the full editor is there when you want control." },
  { q: "Can I work with my team and my clients?",
    a: "Yes. Roles run from Viewer to Admin, producers approve spending, and clients can comment on a private review link without making an account." },
  { q: "Can I try it before I spend anything?",
    a: "The studio has a Mock mode that runs the whole flow with placeholder media, so you can learn the workflow before any paid generation." },
  { q: "What do you do with my email and number?",
    a: "We use them only to tell you about Tatvam's launch. We don't sell them, and you can ask us to delete them whenever you like." },
];
