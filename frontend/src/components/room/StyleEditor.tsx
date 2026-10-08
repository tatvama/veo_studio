import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Aperture, Ban, Check, Film, Lock, Palette, Sparkles, Sun } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import { useStyles } from "../../lib/queries";
import type { Style } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { Alert, Input, Skeleton, Textarea, rise } from "../ui";
import { Fact, FloatingSaveBar, RField, SectionCard, type SaveState } from "./kit";
import { useSaveShortcut } from "./util";

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

  return (
    <div>
    <div className="grid items-start gap-5 @4xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-5">
        {locked && <Alert tone="warn" icon={<Lock className="size-4" />}>{t("This style is locked. Ask a producer to unlock it before changing it.")}</Alert>}

        {editable && (
          <SectionCard index={1} icon={<Sparkles />} title={t("Start from a preset")} description={t("Fills in the fields below. Nothing is saved until you press Save.")}>
            {isLoading ? (
              <div className="grid gap-2 @lg:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 !rounded-lg" />)}</div>
            ) : !data?.presets.length ? <p className="text-sm text-dim">{t("No presets available.")}</p> : (
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,13rem),1fr))]" role="group" aria-label={t("Style presets")}>
                {data.presets.map((p) => {
                  const on = matches(p);
                  return (
                    <button key={p.name} type="button" onClick={() => applyPreset(p.name)} aria-pressed={on}
                      className={clsx("flex flex-col rounded-lg border p-3 text-left transition-colors", on ? "border-accent/60 bg-accent/10" : "border-line hover:border-dim/60 hover:bg-hover/50")}>
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {on && <Check className="size-3.5 shrink-0 text-accent-ink" strokeWidth={3} />}
                      </span>
                      <span className="mt-1 line-clamp-2 text-xs leading-snug text-mute">{p.look}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </SectionCard>
        )}

        <SectionCard index={2} icon={<Palette />} title={t("Visual style")} description={t("Added to every keyframe and video prompt.")} bodyClassName="space-y-4">
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
        </SectionCard>
      </div>

      <aside {...rise(3)} className={clsx("min-w-0 rounded-xl border border-line bg-panel p-4 @4xl:sticky @4xl:top-2", rise(3).className)} aria-label={t("Style summary")}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">{t("At a glance")}</h2>
          {current?.locked ? <Fact tone="warn" icon={<Lock />}>{t("Locked")}</Fact> : current ? <Fact>{t("Saved")}</Fact> : <Fact tone="info">{t("Not saved yet")}</Fact>}
        </div>
        <p className="truncate text-lg font-semibold tracking-tight" title={s.name || undefined}>{s.name || t("Untitled style")}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-mute">{s.look || <span className="text-dim">{t("Describe the look and lighting.")}</span>}</p>
        <dl className="mt-4 space-y-2.5">
          <Row icon={<Aperture />} label={t("Lens & camera")}>{s.lens}</Row>
          <Row icon={<Sun />} label={t("Colour grade")}>{s.grade}</Row>
          <Row icon={<Film />} label={t("Grain")}>{s.grain}</Row>
        </dl>
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-mute"><Ban className="size-3.5 text-dim" />{t("Always avoid")}</p>
          {avoid.length ? (
            <div className="flex flex-wrap gap-1.5">{avoid.map((a, i) => <span key={`${a}-${i}`} className="rounded-md border border-bad/25 bg-bad/8 px-1.5 py-0.5 text-2xs text-red-300">{a}</span>)}</div>
          ) : <p className="text-xs text-dim">—</p>}
        </div>
      </aside>
    </div>
    <FloatingSaveBar show={dirty || busy} state={state} saving={busy} onSave={save} onDiscard={() => setS(current || {})} />
    </div>
  );
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-raised text-dim [&>svg]:size-3.5">{icon}</span>
      <div className="min-w-0">
        <dt className="text-2xs text-dim">{label}</dt>
        <dd className="text-sm leading-snug">{children || <span className="text-dim">—</span>}</dd>
      </div>
    </div>
  );
}
