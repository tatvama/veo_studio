import { Bot, Clapperboard, FileText, Shirt, UserPen } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { WardrobeRow } from "../../lib/v3";
import { Badge } from "../ui";

/** Where an outfit in the wardrobe timeline came from: the scene card, the shots, the Continuity Bible or nothing (default look). */
export function SourceBadge({ source, className }: { source: WardrobeRow["source"]; className?: string }) {
  const t = useT();
  const map = {
    scene: { tone: "ok" as const, label: t("scene card"), icon: <FileText className="size-3" />, hint: t("Set on the scene card") },
    shot: { tone: "info" as const, label: t("shots"), icon: <Clapperboard className="size-3" />, hint: t("Read from the shots of this scene") },
    bible: { tone: "accent" as const, label: t("bible"), icon: <Shirt className="size-3" />, hint: t("From the Continuity Bible end state") },
    default: { tone: "neutral" as const, label: t("default"), icon: <Shirt className="size-3" />, hint: t("Nothing set — the character's default look") },
  }[source] ?? { tone: "neutral" as const, label: source, icon: null, hint: "" };
  return <Badge tone={map.tone} title={map.hint} className={className}>{map.icon}{map.label}</Badge>;
}

/** Who wrote an end state: the AI continuity supervisor or a person. */
export function StateSourceBadge({ source, className }: { source?: "ai" | "manual" | string; className?: string }) {
  const t = useT();
  if (!source) return null;
  return source === "ai"
    ? <Badge tone="accent" title={t("Written by AI from the script and the previous scene")} className={className}><Bot className="size-3" />{t("AI")}</Badge>
    : <Badge tone="info" title={t("Edited by hand")} className={className}><UserPen className="size-3" />{t("manual")}</Badge>;
}
