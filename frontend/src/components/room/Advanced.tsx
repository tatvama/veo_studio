import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";

/**
 * Tools off the main path (writers' and specialists' tools), folded away under "Advanced" so a page leads with the one
 * thing most people do there. Remembered open or closed per `storageKey`.
 */
export function AdvancedSection({ storageKey, summary, children, className }: {
  storageKey: string; summary: ReactNode; children: ReactNode; className?: string;
}) {
  const t = useT();
  const key = `veo:advanced:${storageKey}`;
  const [open, setOpenState] = useState(() => { try { return localStorage.getItem(key) === "1"; } catch { return false; } });
  const setOpen = (v: boolean) => { setOpenState(v); try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* storage blocked */ } };
  return (
    <section className={cn("rounded-xl border border-dashed border-line", open && "border-solid bg-raised/20", className)}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-hover/40">
        <span className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-raised text-mute"><SlidersHorizontal className="size-3.5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("Advanced")}</span>
          <span className="block truncate text-2xs text-dim">{summary}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-mute transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="space-y-6 border-t border-line p-4">{children}</div>}
    </section>
  );
}
