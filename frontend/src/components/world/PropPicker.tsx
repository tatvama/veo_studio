import { clsx } from "clsx";
import { Check, Package } from "lucide-react";
import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { useProps, type Prop } from "../../lib/v3";
import { Skeleton } from "../ui";

/** Chips for every prop in the project; toggling one writes `prop_ids`. Library props that aren't in the project are left out. */
export function PropPicker({ pid, value, onChange, disabled, showLibrary }: {
  pid: number; value: number[]; onChange: (ids: number[]) => void; disabled?: boolean;
  /** Also offer shared library props that are not in this project (greyed). */
  showLibrary?: boolean;
}) {
  const t = useT();
  const { data, isLoading } = useProps(pid);
  if (isLoading) return <div className="flex gap-1.5"><Skeleton className="h-7 w-20" /><Skeleton className="h-7 w-24" /><Skeleton className="h-7 w-16" /></div>;
  const all = data ?? [];
  const inProject = all.filter((p) => p.in_project);
  const library = showLibrary ? all.filter((p) => !p.in_project) : [];
  // keep props that were picked but have since left the project visible, so they can still be removed
  const picked = value.map((id) => all.find((p) => p.id === id)).filter(Boolean) as Prop[];
  const list = [...inProject, ...picked.filter((p) => !inProject.some((q) => q.id === p.id)), ...library];
  if (!list.length) {
    return (
      <p className="text-xs text-dim">
        {t("No props in this project yet.")}{" "}
        <Link to={`/p/${pid}/world?tab=props`} className="font-medium text-accent-ink hover:underline">{t("Add props on the World page")}</Link>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Props")}>
      {list.map((p) => {
        const on = value.includes(p.id);
        return (
          <button key={p.id} type="button" disabled={disabled} aria-pressed={on} title={p.description || p.name}
            onClick={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])}
            className={clsx("inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border py-0.5 pl-0.5 pr-2.5 text-xs transition-colors disabled:cursor-not-allowed pointer-coarse:h-9",
              on ? "border-accent/50 bg-accent/10 text-ink" : "border-line text-mute hover:border-dim hover:text-ink", !p.in_project && !on && "opacity-70")}>
            {p.url ? <img src={p.url} alt="" className="size-5 shrink-0 rounded-md object-cover" loading="lazy" />
              : <span className="grid size-5 shrink-0 place-items-center rounded-md bg-raised text-dim"><Package className="size-3" /></span>}
            <span className="truncate">{p.name}</span>
            {on && <Check className="size-3 shrink-0 text-accent-ink" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}
