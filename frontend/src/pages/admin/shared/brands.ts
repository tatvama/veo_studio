/** Proper names of the AI services (the API reports lowercase slugs). */
const BRANDS: Record<string, string> = {
  gemini: "Google Gemini",
  google: "Google",
  fal: "fal.ai",
  elevenlabs: "ElevenLabs",
  sync: "sync.so",
  sarvam: "Sarvam AI",
  openai: "OpenAI",
  anthropic: "Anthropic",
  mock: "Mock provider",
  system: "System",
};

export function brandName(provider: string | null | undefined): string {
  if (!provider) return "—";
  const key = provider.toLowerCase();
  return BRANDS[key] ?? provider.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Two-letter mark for the service avatar chips. */
export function brandMark(provider: string | null | undefined): string {
  const name = brandName(provider).replace(/[^A-Za-z0-9 ]/g, " ").trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2);
  return (words[0][0] + words[1][0]);
}

/** Colour classes cycled across services, tokens only. */
export const SERIES = [
  { bar: "bg-accent", soft: "bg-accent/8 text-accent-ink", dot: "bg-accent" },
  { bar: "bg-info", soft: "bg-info/8 text-sky-300", dot: "bg-info" },
  { bar: "bg-ok", soft: "bg-ok/8 text-green-300", dot: "bg-ok" },
  { bar: "bg-accent-2", soft: "bg-accent-2/8 text-yellow-300", dot: "bg-accent-2" },
  { bar: "bg-warn", soft: "bg-warn/8 text-amber-300", dot: "bg-warn" },
] as const;
