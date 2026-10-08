/**
 * "Start from a template" presets for the create-project form on Home (and the command palette).
 * Every field maps onto what POST /api/projects accepts: type, aspect, languages, primary_language,
 * style_preset, quality_mode, agent_mode and the concept text (from which the backend auto-writes the brief).
 * Use getTemplates(t) so labels and blurbs are translated (the concept text is sample content and stays as written).
 */
import type { LucideIcon } from "lucide-react";
import { Baby, Clapperboard, Megaphone, Music2, Package, Presentation, Smartphone, Sparkles } from "lucide-react";

export interface ProjectTemplate {
  id: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
  /** CSS gradient for the card art (works in both themes). */
  art: string;
  type: "short" | "series" | "ad" | "explainer" | "devotional";
  aspect: "9:16" | "16:9" | "1:1";
  languages: string[];
  primary: string;
  style: string; // a catalog style preset name, or "" to let the Director decide
  quality?: "" | "saver" | "balanced" | "hero";
  concept: string;
  duration: string; // display hint only
}

/** English → translated text, written as literal t("…") calls so the i18n extractor finds them. */
type T = (s: string) => string;

export function getTemplates(t: T): ProjectTemplate[] {
  return [
    {
      id: "yt-short",
      label: t("YouTube Short"),
      blurb: t("Vertical, hook in 2 seconds, loops cleanly."),
      icon: Smartphone,
      art: "linear-gradient(135deg, #ef4444 0%, #f97316 55%, #fbbf24 100%)",
      type: "short", aspect: "9:16", languages: ["en", "hi"], primary: "en", style: "Cinematic Warm", quality: "",
      duration: "≈45 s",
      concept: "A 45-second YouTube Short: a street-food vendor in Bengaluru secretly cooks for stray dogs every night after closing — until one night the dogs bring him something. Scroll-stopping hook in the first 2 seconds, one twist, and a final beat that loops back to the opening.",
    },
    {
      id: "reel-ad",
      label: t("Instagram Reel ad"),
      blurb: t("15–30 s vertical ad with a clear call to action."),
      icon: Megaphone,
      art: "linear-gradient(135deg, #d946ef 0%, #f43f5e 50%, #f97316 100%)",
      type: "ad", aspect: "9:16", languages: ["en"], primary: "en", style: "Bright Commercial", quality: "",
      duration: "≈30 s",
      concept: "A 30-second Instagram Reel ad for a handmade cotton saree brand from Mysuru: hook in the first second, the everyday problem (synthetic sarees that feel hot), the product as the hero in motion, a quick customer smile, and an end card with 'Shop the collection' as the call to action.",
    },
    {
      id: "product-ad",
      label: t("Product ad (16:9)"),
      blurb: t("Widescreen hero product film for YouTube and web."),
      icon: Package,
      art: "linear-gradient(135deg, #0ea5e9 0%, #6366f1 60%, #a855f7 100%)",
      type: "ad", aspect: "16:9", languages: ["en"], primary: "en", style: "Bright Commercial", quality: "balanced",
      duration: "≈30 s",
      concept: "A 30-second widescreen product film for a stainless-steel filter-coffee maker: macro shots of the brew dripping, morning light in a South Indian kitchen, a family sharing the first cup, three crisp product benefits on screen, and a closing logo with the tagline.",
    },
    {
      id: "web-series",
      label: t("Web-series episode"),
      blurb: t("Episodic drama with a cliff-hanger and recurring cast."),
      icon: Clapperboard,
      art: "linear-gradient(135deg, #0f172a 0%, #334155 45%, #f97316 100%)",
      type: "series", aspect: "9:16", languages: ["en", "hi"], primary: "en", style: "Moody Thriller", quality: "",
      duration: "≈5 min / episode",
      concept: "Episode 1 of a vertical web-series thriller: a night-shift auto-rickshaw driver in Bengaluru starts receiving rides booked from a phone number that belonged to his missing brother. Introduce the main cast, plant one mystery, and end on a cliff-hanger that sets up episode 2.",
    },
    {
      id: "devotional",
      label: t("Devotional / mythology story"),
      blurb: t("Reverent, golden-hour storytelling for all ages."),
      icon: Sparkles,
      art: "linear-gradient(135deg, #b45309 0%, #f59e0b 50%, #fde68a 100%)",
      type: "devotional", aspect: "9:16", languages: ["kn", "en"], primary: "kn", style: "Devotional Glow", quality: "",
      duration: "≈2 min",
      concept: "The story of young Prahlada's unwavering faith and Lord Narasimha's appearance at dusk, told reverently in about two minutes — warm lamp light, a calm narrator, and a closing line about devotion conquering fear.",
    },
    {
      id: "explainer",
      label: t("Explainer"),
      blurb: t("Voice-over led, clear steps, warm visuals."),
      icon: Presentation,
      art: "linear-gradient(135deg, #059669 0%, #10b981 45%, #a3e635 100%)",
      type: "explainer", aspect: "16:9", languages: ["en", "kn"], primary: "en", style: "", quality: "",
      duration: "≈90 s",
      concept: "A 90-second explainer: how UPI payments work, told through a vegetable seller and her first-time customer — three simple steps, one common mistake to avoid, and a reassuring closing line about safety.",
    },
    {
      id: "music-video",
      label: t("Music video"),
      blurb: t("Mood-driven visuals cut to the beat."),
      icon: Music2,
      art: "linear-gradient(135deg, #7c3aed 0%, #db2777 55%, #f97316 100%)",
      type: "short", aspect: "16:9", languages: ["en"], primary: "en", style: "Cinematic Warm", quality: "",
      duration: "≈60 s",
      concept: "A 60-second music video for a soft indie song about leaving home: a young woman packs her childhood room, rides an overnight train past monsoon fields, and arrives in a new city at sunrise. No dialogue — visual storytelling cut to the rhythm, with recurring motifs of her grandmother's bangle.",
    },
    {
      id: "kids-story",
      label: t("Kids story"),
      blurb: t("Bright 3D animation with a gentle moral."),
      icon: Baby,
      art: "linear-gradient(135deg, #22d3ee 0%, #38bdf8 40%, #facc15 100%)",
      type: "short", aspect: "16:9", languages: ["en", "hi"], primary: "en", style: "3D Animated", quality: "",
      duration: "≈60 s",
      concept: "A one-minute animated kids' story: a tiny elephant who is afraid of water learns to swim with help from a cheerful kingfisher. Bright, playful, gentle humour, and a simple moral about asking friends for help.",
    },
  ];
}

export const templateById = (t: T, id: string | null | undefined) => getTemplates(t).find((x) => x.id === id);
