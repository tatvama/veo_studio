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

/**
 * Colour classes cycled across services, tokens only (categorical identity colours: no status colours, and not money amber
 * because spend bars already use it). `stroke` is the same colour as a CSS variable for inline SVG.
 */
export const SERIES = [
  { bar: "bg-accent", soft: "bg-accent/10 text-accent-ink", dot: "bg-accent", stroke: "var(--color-accent)" },
  { bar: "bg-accent-2", soft: "bg-accent-2/12 text-accent-2", dot: "bg-accent-2", stroke: "var(--color-accent-2)" },
  { bar: "bg-info", soft: "bg-info/10 text-info", dot: "bg-info", stroke: "var(--color-info)" },
  { bar: "bg-ai", soft: "bg-ai/10 text-ai", dot: "bg-ai", stroke: "var(--color-ai)" },
  { bar: "bg-mute", soft: "bg-raised text-mute", dot: "bg-mute", stroke: "var(--color-mute)" },
] as const;
