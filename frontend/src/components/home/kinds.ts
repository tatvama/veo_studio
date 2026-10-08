import { Film, Megaphone, Mic2, Star, Tv, type LucideIcon } from "lucide-react";
import { useT } from "../../lib/i18n";

export type Aspect = "9:16" | "16:9" | "1:1";

/** The frame a new project of this type starts with (the creator can still change it). */
export const DEFAULT_ASPECT: Record<string, Aspect> = { short: "9:16", series: "9:16", ad: "9:16", explainer: "16:9", devotional: "9:16" };

export interface ProjectKind { value: string; label: string; icon: LucideIcon }

/** Project types with translated labels. Labels are literal t() calls so the i18n extractor finds them. */
export function useProjectKinds(): ProjectKind[] {
  const t = useT();
  return [
    { value: "short", label: t("Short / Reel"), icon: Film },
    { value: "series", label: t("Web series"), icon: Tv },
    { value: "ad", label: t("Ad"), icon: Megaphone },
    { value: "explainer", label: t("Explainer / VO"), icon: Mic2 },
    { value: "devotional", label: t("Devotional story"), icon: Star },
  ];
}

/** Sample concepts shown under the composer. */
export function useExamples(): string[] {
  const t = useT();
  return [
    t("A young temple priest discovers that the brass lamp moves by itself every night — and it is trying to warn him."),
    t("30-second ad for a homemade mango pickle brand from Udupi — grandmother's recipe, modern packaging."),
    t("Explainer: how a farmer in Mandya doubled his yield with drip irrigation, told as a warm story."),
    t("Hanuman's leap to Lanka, told for kids in 60 seconds, reverent and colourful."),
  ];
}
