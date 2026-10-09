/** Tone tables shared by the Mission overview panels. Full class names so Tailwind can see them. */
export type Tone = "neutral" | "accent" | "money" | "ai" | "ok" | "warn" | "bad" | "info";

export const TEXT: Record<Tone, string> = {
  neutral: "text-ink", accent: "text-accent-ink", money: "text-money", ai: "text-ai", ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info",
};

export const DOT: Record<Tone, string> = {
  neutral: "bg-dim", accent: "bg-accent", money: "bg-money", ai: "bg-ai", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info",
};

/** A hairline chip: tinted border and wash with matching text. */
export const SOFT: Record<Tone, string> = {
  neutral: "border-line bg-raised text-mute",
  accent: "border-accent/35 bg-accent/10 text-accent-ink",
  money: "border-money/35 bg-money/10 text-money",
  ai: "border-ai/35 bg-ai/10 text-ai",
  ok: "border-ok/35 bg-ok/10 text-ok",
  warn: "border-warn/35 bg-warn/10 text-warn",
  bad: "border-bad/35 bg-bad/10 text-bad",
  info: "border-info/35 bg-info/10 text-info",
};

/** The start of a left-to-right wash (action bars). */
export const WASH: Record<Tone, string> = {
  neutral: "from-hover/50", accent: "from-accent/10", money: "from-money/10", ai: "from-ai/12", ok: "from-ok/10", warn: "from-warn/10", bad: "from-bad/10", info: "from-info/10",
};
