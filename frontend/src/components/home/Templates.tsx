import { clsx } from "clsx";
import { ArrowRight, Check } from "lucide-react";
import { LANG_SHORT } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ProjectTemplate } from "../shell/templates";
import { rise, Section } from "../ui";

function TemplateCard({ tpl, index, applied, onPick }: { tpl: ProjectTemplate; index: number; applied: boolean; onPick: (t: ProjectTemplate) => void }) {
  const t = useT();
  const r = rise(index);
  const Icon = tpl.icon;
  return (
    // entrance on the wrapper, hover lift on the button (a running CSS animation would otherwise pin the transform)
    <div className={clsx("w-52 shrink-0 snap-start sm:w-auto", r.className)} style={r.style}>
      <button
        type="button"
        aria-pressed={applied}
        onClick={() => onPick(tpl)}
        className={clsx(
          "lift group flex h-full w-full flex-col overflow-hidden rounded-xl border bg-panel text-left",
          applied ? "border-accent/60 shadow-glow" : "border-line hover:border-accent/40",
        )}
      >
        <div className="relative h-20 shrink-0 overflow-hidden" style={{ background: tpl.art }}>
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_15%,rgb(255_255_255/0.4),transparent_48%)] opacity-70 transition-opacity duration-300 group-hover:opacity-100" />
          <Icon className="absolute bottom-2.5 left-3 size-7 text-white drop-shadow transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-110" />
          <span className="absolute right-2 top-2 rounded-md bg-black/40 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white backdrop-blur-sm">{tpl.aspect}</span>
          {applied && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-2xs font-semibold text-white backdrop-blur-sm">
              <Check className="size-3" />{t("Applied")}
            </span>
          )}
        </div>
        <div className="flex flex-1 flex-col p-3">
          <p className="text-sm font-medium leading-snug">{tpl.label}</p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-mute">{tpl.blurb}</p>
          <div className="mt-auto flex items-center justify-between gap-2 pt-2.5 text-2xs text-dim">
            <span className="min-w-0 truncate">{tpl.languages.map((l) => LANG_SHORT[l]).join(" · ")} · {tpl.duration}</span>
            <ArrowRight className="size-3.5 shrink-0 -translate-x-1 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100" />
          </div>
        </div>
      </button>
    </div>
  );
}

/** "Start from a template": a snap-scrolling strip on phones, a grid from the sm breakpoint up. */
export function Templates({ items, appliedId, onPick }: { items: ProjectTemplate[]; appliedId: string | null; onPick: (t: ProjectTemplate) => void }) {
  const t = useT();
  return (
    <Section title={t("Start from a template")} description={t("Pre-fills the format, frame, languages and look — then make the idea yours.")} className="mb-10">
      <div className="no-scrollbar -mx-4 flex scroll-px-4 snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-3 pt-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 md:grid-cols-4">
        {items.map((tpl, i) => (
          <TemplateCard key={tpl.id} tpl={tpl} index={i} applied={appliedId === tpl.id} onPick={onPick} />
        ))}
      </div>
    </Section>
  );
}
