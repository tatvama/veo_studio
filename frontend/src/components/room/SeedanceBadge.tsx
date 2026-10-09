import { Clapperboard } from "lucide-react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { Badge, Tooltip } from "../ui";

/**
 * "Seedance-ready": the character is registered in the BytePlus asset library, so Seedance keeps its look and doesn't
 * block the face as a real person. `overlay` is the dark chip that sits on a portrait (reads on any photo in both themes);
 * `tip` replaces the tooltip (e.g. for a whole shot's cast).
 */
export function SeedanceBadge({ overlay, tip, className }: { overlay?: boolean; tip?: string; className?: string }) {
  const t = useT();
  const why = tip ?? t("Registered with BytePlus: Seedance keeps this character's look");
  return (
    <Tooltip content={why}>
      {overlay ? (
        <span className={cn("inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-1 text-2xs font-medium leading-none text-white backdrop-blur [&>svg]:size-3 [&>svg]:shrink-0", className)}>
          <Clapperboard aria-hidden className="text-ok" />{t("Seedance-ready")}<span className="sr-only">: {why}</span>
        </span>
      ) : (
        <Badge tone="ok" className={cn("[&>svg]:size-3", className)}>
          <Clapperboard aria-hidden />{t("Seedance-ready")}<span className="sr-only">: {why}</span>
        </Badge>
      )}
    </Tooltip>
  );
}
