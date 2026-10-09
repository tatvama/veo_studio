import { clsx } from "clsx";
import { ArrowRight, Check, LayoutTemplate } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { ProjectTemplate } from "../shell/templates";
import { rise, ScrollStrip } from "../ui";
import { Eyebrow } from "./Chips";

function TemplateChip({ tpl, index, applied, onPick }: { tpl: ProjectTemplate; index: number; applied: boolean; onPick: (t: ProjectTemplate) => void }) {
  const Icon = tpl.icon;
  const r = rise(index);
  return (
    <button
      type="button"
      aria-pressed={applied}
      data-active={applied}
      title={tpl.blurb}
      onClick={() => onPick(tpl)}
      style={r.style}
      className={clsx(
        "group flex h-14 w-56 shrink-0 items-center gap-2.5 rounded-lg border p-1.5 pr-3 text-left transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.98]",
        r.className,
        applied ? "border-accent/60 bg-accent/10" : "border-line bg-raised/40 hover:border-accent/40 hover:bg-hover",
      )}
    >
      <span className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-md" style={{ background: tpl.art }}>
        <span aria-hidden className="absolute inset-0 bg-[radial-gradient(circle_at_80%_10%,rgb(255_255_255/0.4),transparent_55%)]" />
        <Icon className="relative size-5 text-white drop-shadow transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium leading-tight">{tpl.label}</span>
        <span className="mono mt-1 block truncate text-2xs text-dim">{tpl.aspect} · {tpl.duration}</span>
      </span>
      {applied
        ? <Check aria-hidden className="size-4 shrink-0 text-accent-ink" />
        : <ArrowRight aria-hidden className="size-3.5 shrink-0 -translate-x-1 text-dim opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100" />}
    </button>
  );
}

/** "Start from a template": one scrolling rail of compact cards. Picking one pre-fills the composer. */
export function Templates({ items, appliedId, onPick }: { items: ProjectTemplate[]; appliedId: string | null; onPick: (t: ProjectTemplate) => void }) {
  const t = useT();
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <Eyebrow className="flex items-center gap-1.5"><LayoutTemplate className="size-3.5" aria-hidden />{t("Start from a template")}</Eyebrow>
        <span className="hidden min-w-0 truncate text-2xs text-dim @2xl:block">{t("Pre-fills the format, frame, languages and look — then make the idea yours.")}</span>
      </div>
      <ScrollStrip aria-label={t("Start from a template")} className="-mx-4 px-4 py-0.5">
        <div className="flex gap-2 pr-6">
          {items.map((tpl, i) => <TemplateChip key={tpl.id} tpl={tpl} index={i} applied={appliedId === tpl.id} onPick={onPick} />)}
        </div>
      </ScrollStrip>
    </div>
  );
}
