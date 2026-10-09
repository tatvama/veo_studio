import { useQueryClient } from "@tanstack/react-query";
import { Aperture, Ban, Check, Film, Lock, Palette, Sparkles, Sun } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import { useStyles } from "../../lib/queries";
import type { Style } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { Alert, Input, Meter, Skeleton, Textarea } from "../ui";
import { Fact, FloatingSaveBar, RField, type SaveState } from "./kit";
import { useSaveShortcut } from "./util";
import { WorkPanel, Workspace, pad } from "./workspace";

type Fields = Pick<Style, "name" | "look" | "lens" | "grade" | "grain" | "avoid_list" | "notes">;
const KEYS: (keyof Fields)[] = ["name", "look", "lens", "grade", "grain", "avoid_list", "notes"];
const pick = (s: Partial<Style> | null | undefined): Partial<Fields> => Object.fromEntries(KEYS.map((k) => [k, s?.[k] ?? ""])) as Partial<Fields>;

/** The project's visual style: start from a preset, tune the fields, and see the summary update as you type. */
export function StyleEditor() {
  const t = useT();
  const { project, canEdit, canProduce } = useProjectCtx();
  const qc = useQueryClient();
  const { data, isLoading } = useStyles();
  const current = project.style;
  const [s, setS] = useState<Partial<Style>>(current || {});
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => setS(current || {}), [current?.id, current?.name, current?.look, current?.lens, current?.grade, current?.grain, current?.avoid_list, current?.notes]);
  useEffect(() => {
    if (!justSaved) return;
    const id = window.setTimeout(() => setJustSaved(false), 2200);
    return () => window.clearTimeout(id);
  }, [justSaved]);

  const locked = !!current?.locked && !canProduce;
  const editable = canEdit && !locked;
  const base = useMemo(() => JSON.stringify(pick(current)), [current]);
  const dirty = JSON.stringify(pick(s)) !== base && (editable);

  const save = async () => {
    setBusy(true);
    try {
      if (current) await api.patch(`/api/styles/${current.id}`, { name: s.name, look: s.look, lens: s.lens, grade: s.grade, grain: s.grain, avoid_list: s.avoid_list, notes: s.notes });
      else await api.post("/api/styles", { ...s, name: s.name || tr("Project style"), project_id: project.id });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      setJustSaved(true);
      toast.success(tr("Style saved"));
    } catch { /* api toasts */ } finally { setBusy(false); }
  };
  const applyPreset = (name: string) => {
    const p = data?.presets.find((x) => x.name === name);
    if (p) setS({ ...s, ...p });
  };
  useSaveShortcut(dirty && !busy, save);
  const state: SaveState = busy ? "saving" : dirty ? "dirty" : justSaved ? "saved" : "clean";
  const avoid = (s.avoid_list || "").split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
  const matches = (p: Omit<Style, "id" | "locked">) => KEYS.filter((k) => k !== "notes").every((k) => (s[k] ?? "") === (p[k] ?? "")) ;
  const filled = [s.name, s.look, s.lens, s.grade, s.grain].filter((x) => (x ?? "").trim()).length;

  const summary = (
    <WorkPanel index={3} kicker={t("Summary")} icon={<Palette />} title={t("At a glance")} tone={current?.locked ? "warn" : "accent"}
      badge={current?.locked ? <Fact tone="warn" icon={<Lock />}>{t("Locked")}</Fact> : current ? <Fact>{t("Saved")}</Fact> : <Fact tone="info">{t("Not saved yet")}</Fact>}>
      <div aria-label={t("Style summary")} role="group">
        <p className="truncate text-lg font-semibold tracking-tight" title={s.name || undefined}>{s.name || t("Untitled style")}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-mute">{s.look || <span className="text-dim">{t("Describe the look and lighting.")}</span>}</p>
        <div className="mt-3.5 flex items-center gap-2.5">
          <Meter filled={filled} total={5} tone={filled === 5 ? "ok" : "accent"} className="flex-1" />
          <span className="mono shrink-0 text-2xs text-dim">{filled}/5</span>
        </div>
        <dl className="mt-4 divide-y divide-dashed divide-line border-y border-dashed border-line">
          <Row icon={<Aperture />} label={t("Lens & camera")}>{s.lens}</Row>
          <Row icon={<Sun />} label={t("Colour grade")}>{s.grade}</Row>
          <Row icon={<Film />} label={t("Grain")}>{s.grain}</Row>
        </dl>
        <div className="mt-4">
          <p className="eyebrow mb-2 flex items-center gap-1.5"><Ban aria-hidden className="size-3.5" />{t("Always avoid")}</p>
          {avoid.length ? (
            <div className="flex flex-wrap gap-1.5">{avoid.map((a, i) => <span key={`${a}-${i}`} className="rounded-md border border-bad/25 bg-bad/8 px-1.5 py-0.5 text-2xs text-red-300">{a}</span>)}</div>
          ) : <p className="text-xs text-dim">—</p>}
        </div>
      </div>
    </WorkPanel>
  );

  return (
    <div>
      <Workspace railKind="panel" rail={summary}>
        {locked && <Alert tone="warn" icon={<Lock className="size-4" />}>{t("This style is locked. Ask a producer to unlock it before changing it.")}</Alert>}

        {editable && (
          <WorkPanel index={1} n={1} kicker={t("Presets")} icon={<Sparkles />} title={t("Start from a preset")} description={t("Fills in the fields below. Nothing is saved until you press Save.")}>
            {isLoading ? (
              <div className="grid gap-2 @lg:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 !rounded-lg" />)}</div>
            ) : !data?.presets.length ? <p className="text-sm text-dim">{t("No presets available.")}</p> : (
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,13rem),1fr))]" role="group" aria-label={t("Style presets")}>
                {data.presets.map((p, i) => {
                  const on = matches(p);
                  const tags = [p.lens, p.grade, p.grain].filter((x): x is string => !!x && !!x.trim());
                  return (
                    <button key={p.name} type="button" onClick={() => applyPreset(p.name)} aria-pressed={on}
                      className={cn("group relative flex min-h-12 flex-col gap-1.5 rounded-lg border py-3 pl-4 pr-3 text-left transition-colors",
                        on ? "border-accent/60 bg-accent/10" : "border-line hover:border-dim/60 hover:bg-hover/50")}>
                      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px] rounded-l-lg transition-colors", on ? "bg-accent shadow-[0_0_8px_var(--color-accent)]" : "bg-transparent group-hover:bg-dim/40")} />
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span className="mono shrink-0 text-2xs text-dim">P{pad(i + 1)}</span>
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {on && <Check aria-hidden className="size-3.5 shrink-0 text-accent-ink" strokeWidth={3} />}
                      </span>
                      <span className="line-clamp-2 text-xs leading-snug text-mute">{p.look}</span>
                      {tags.length > 0 && (
                        <span className="mt-0.5 flex flex-wrap gap-1">
                          {tags.slice(0, 3).map((x) => <span key={x} className="mono max-w-full truncate rounded border border-line bg-raised/60 px-1 text-2xs leading-4 text-dim">{x}</span>)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </WorkPanel>
        )}

        <WorkPanel index={2} n={2} kicker={t("Look")} icon={<Palette />} title={t("Visual style")} description={t("Added to every keyframe and video prompt.")} bodyClassName="space-y-4">
          <RField label={t("Name")} htmlFor="st-name"><Input id="st-name" value={s.name || ""} disabled={!editable} onChange={(e) => setS({ ...s, name: e.target.value })} /></RField>
          <RField label={t("Look & lighting")} htmlFor="st-look"><Textarea id="st-look" rows={2} value={s.look || ""} disabled={!editable} onChange={(e) => setS({ ...s, look: e.target.value })} /></RField>
          <div className="grid gap-4 @xl:grid-cols-3">
            <RField label={t("Lens & camera")} htmlFor="st-lens"><Input id="st-lens" value={s.lens || ""} disabled={!editable} onChange={(e) => setS({ ...s, lens: e.target.value })} /></RField>
            <RField label={t("Colour grade")} htmlFor="st-grade"><Input id="st-grade" value={s.grade || ""} disabled={!editable} onChange={(e) => setS({ ...s, grade: e.target.value })} /></RField>
            <RField label={t("Grain")} htmlFor="st-grain"><Input id="st-grain" value={s.grain || ""} disabled={!editable} onChange={(e) => setS({ ...s, grain: e.target.value })} /></RField>
          </div>
          <RField label={t("Always avoid")} htmlFor="st-avoid" hint={t("Becomes the negative prompt")}>
            <Input id="st-avoid" value={s.avoid_list || ""} disabled={!editable} onChange={(e) => setS({ ...s, avoid_list: e.target.value })} />
          </RField>
        </WorkPanel>
      </Workspace>
      <FloatingSaveBar show={dirty || busy} state={state} saving={busy} onSave={save} onDiscard={() => setS(current || {})} />
    </div>
  );
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 py-2.5">
      <span aria-hidden className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-line bg-raised text-dim [&>svg]:size-3.5">{icon}</span>
      <div className="min-w-0">
        <dt className="eyebrow">{label}</dt>
        <dd className="mt-1 text-sm leading-snug">{children || <span className="text-dim">—</span>}</dd>
      </div>
    </div>
  );
}
