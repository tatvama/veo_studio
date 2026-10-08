import { clsx } from "clsx";
import {
  Bot, Clapperboard, Flame, Image as ImageIcon, Languages, LayoutGrid, Mic, PenLine, Play, Scissors, Users, type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { useMemo } from "react";
import { useT, useUiLanguage } from "../../lib/i18n";

/** One quick order. `order` is the English text that is sent (the Director routes on it); `label` is the translated chip text. */
export interface Suggestion { order: string; label: string; icon: LucideIcon }

export function useSuggestions(): Suggestion[] {
  const t = useT();
  const lang = useUiLanguage();
  // `t` is a stable function, so the UI language is the real dependency
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo<Suggestion[]>(() => [
    { order: "Write 6 hooks, more shocking", label: t("Write 6 hooks, more shocking"), icon: Flame },
    { order: "Write the script", label: t("Write the script"), icon: PenLine },
    { order: "Build the bible", label: t("Build the bible"), icon: Users },
    { order: "Plan the shots", label: t("Plan the shots"), icon: LayoutGrid },
    { order: "Generate keyframes", label: t("Generate keyframes"), icon: ImageIcon },
    { order: "Generate videos", label: t("Generate videos"), icon: Clapperboard },
    { order: "Voices and lip-sync", label: t("Voices and lip-sync"), icon: Mic },
    { order: "Make an animatic", label: t("Make an animatic"), icon: Play },
    { order: "Dub into Kannada", label: t("Dub into Kannada"), icon: Languages },
    { order: "Cut this episode into 3 shorts", label: t("Cut this episode into 3 shorts"), icon: Scissors },
  ], [t, lang]);
}

/** The Director's face: a soft accent tile. `working` adds the rotating "generating" ring. */
export function DirectorMark({ size = 28, working, square, className }: { size?: number; working?: boolean; square?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "relative grid shrink-0 place-items-center border border-accent/25 bg-accent/15 text-accent-ink",
        square ? "rounded-xl" : "rounded-full",
        working && "gen-ring",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Bot style={{ width: Math.round(size * 0.54), height: Math.round(size * 0.54) }} />
    </span>
  );
}

/** Three softly bouncing dots (the "thinking" indicator). */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden className={clsx("inline-flex h-4 items-center gap-1", className)}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1.5 rounded-full bg-accent-ink"
          animate={{ y: [0, -3, 0], opacity: [0.35, 1, 0.35] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut", delay: i * 0.15 }}
        />
      ))}
    </span>
  );
}
