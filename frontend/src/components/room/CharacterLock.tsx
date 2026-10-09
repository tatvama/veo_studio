import { useQueryClient } from "@tanstack/react-query";
import { Info, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import { setCharacterLock, useCharacterLock, type CharacterLock as LockConfig, type CharacterV3 } from "../../lib/v3";
import { Badge, Button, Input, Meter, Skeleton, Toggle } from "../ui";
import { LEVEL_TEXT } from "./cast";
import { LoadError, RField } from "./kit";
import { LEVEL_LABEL, strictnessLevel, type StrictnessLevel } from "./look";
import { WorkPanel } from "./workspace";

type TraitKey = "face" | "body" | "skin_hair" | "voice" | "costume_continuity";
const TRAITS: { key: TraitKey; label: string; hint: string }[] = [
  { key: "face", label: "Face", hint: "Identical face and facial hair in every frame." },
  { key: "body", label: "Body", hint: "Same build and body proportions." },
  { key: "skin_hair", label: "Skin & hair", hint: "Same skin tone and hairstyle." },
  { key: "voice", label: "Voice", hint: "The voice description goes into every dialogue prompt." },
  { key: "costume_continuity", label: "Costume continuity", hint: "Must wear the scene's outfit, nothing added or removed. QC fails a wrong outfit." },
];

const signed = (d: number) => `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(2)}`;
const LEVELS: StrictnessLevel[] = ["lenient", "balanced", "strict"];
const LEVEL_TONE = { lenient: "warn", balanced: "accent", strict: "ok" } as const;

/**
 * Character Lock: which traits every prompt must keep, free-text mannerisms / age / lighting, and how strict QC is.
 * Saved on its own (PUT /lock); the server answers with the exact sentence it appends to prompts.
 */
export function CharacterLockPanel({ character, editable, index, n }: { character: CharacterV3; editable: boolean; index?: number; n?: number }) {
  const t = useT();
  const qc = useQueryClient();
  const cid = character.id;
  const sliderId = useId();
  const { data, isLoading, isError, refetch } = useCharacterLock(cid);
  const [form, setForm] = useState<LockConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const serverKey = JSON.stringify(data?.lock ?? null);
  // Re-seed only when the saved lock changes (not on every refetch), so typing isn't interrupted.
  useEffect(() => { if (data) setForm(data.lock); }, [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!data && !!form && JSON.stringify(form) !== serverKey;
  const upd = (p: Partial<LockConfig>) => form && setForm({ ...form, ...p });
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const r = await setCharacterLock(cid, form);
      qc.setQueryData<{ lock: LockConfig; defaults: LockConfig; prompt_text: string }>(["character-lock", cid],
        (old) => (old ? { ...old, lock: r.lock, prompt_text: r.prompt_text } : old));
      qc.invalidateQueries({ queryKey: ["character", cid] });
      qc.invalidateQueries({ queryKey: ["characters"] });
      qc.invalidateQueries({ queryKey: ["character-look", cid] });
      toast.success(tr("Character Lock saved"));
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  const s = form?.strictness ?? 0.5;
  const level = strictnessLevel(s);
  const refs = s >= 0.5 ? 2 : 1;
  const onCount = form ? TRAITS.filter((x) => form[x.key]).length : 0;

  return (
    <WorkPanel id="sec-lock" index={index} n={n} kicker={t("Continuity")} icon={<ShieldCheck />} title={t("Character Lock")}
      badge={form ? <Badge tone={level === "strict" ? "ok" : level === "lenient" ? "warn" : "neutral"} dot>{t(LEVEL_LABEL[level])}</Badge> : undefined}
      description={t("What every prompt must keep about {name}, and how strictly QC checks it.", { name: character.name })}
      actions={editable && data && (
        <>
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={busy || JSON.stringify(form) === JSON.stringify(data.defaults)}
            onClick={() => setForm(data.defaults)}>{t("Reset to defaults")}</Button>
          <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={busy} disabled={!dirty} onClick={save}>{t("Save lock")}</Button>
        </>
      )}>
      {isLoading || (!form && !isError) ? (
        <div className="space-y-3" aria-busy="true"><Skeleton className="h-40" /><Skeleton className="h-10" /><Skeleton className="h-16" /></div>
      ) : isError || !form || !data ? (
        <LoadError what={t("Couldn't load the Character Lock")} onRetry={() => refetch()} />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 @3xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            {/* traits: a dense list, a lit bar on the left of every trait that is on */}
            <div className="min-w-0">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <p className="eyebrow">{t("Locked traits")}</p>
                <span className="mono text-2xs text-dim">{t("{a}/{n} on", { a: onCount, n: TRAITS.length })}</span>
              </div>
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                {TRAITS.map((x) => {
                  const on = !!form[x.key];
                  return (
                    <li key={x.key} className={cn("relative flex min-h-11 items-center justify-between gap-3 py-2 pl-4 pr-3 transition-colors", on ? "bg-accent/[0.04]" : "bg-bg/20")}>
                      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px] transition-colors", on ? "bg-accent shadow-[0_0_8px_var(--color-accent)]" : "bg-transparent")} />
                      <div className="min-w-0">
                        <p className={cn("text-sm font-medium", !on && "text-mute")}>{t(x.label)}</p>
                        <p className="mt-0.5 text-2xs leading-snug text-dim">{t(x.hint)}</p>
                      </div>
                      <Toggle checked={on} disabled={!editable} label={<span className="sr-only">{t(x.label)}</span>} onChange={(v) => upd({ [x.key]: v } as Partial<LockConfig>)} />
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* strictness: a labelled slider with a 3-zone meter readout */}
            <div className="min-w-0 space-y-4">
              <div className="rounded-lg border border-line bg-bg/40 p-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <label htmlFor={sliderId} className="eyebrow">{t("Strictness")}</label>
                  <span className="mono text-xs font-medium"><span className={LEVEL_TEXT[level]}>{t(LEVEL_LABEL[level])}</span> · {s.toFixed(2)}</span>
                </div>
                <div aria-hidden className="mt-3">
                  <Meter filled={LEVELS.indexOf(level) + 1} total={3} tone={LEVEL_TONE[level]} />
                  <div className="mt-1.5 grid grid-cols-3 text-2xs text-dim">
                    {LEVELS.map((l, i) => (
                      <span key={l} className={cn(i === 1 && "text-center", i === 2 && "text-right", l === level && "font-medium text-ink")}>{t(LEVEL_LABEL[l])}</span>
                    ))}
                  </div>
                </div>
                <input id={sliderId} type="range" min={0} max={1} step={0.05} value={s} disabled={!editable} className="cs-range mt-1.5 w-full"
                  aria-valuetext={t("{level}: {refs} reference image(s) per character", { level: t(LEVEL_LABEL[level]), refs })}
                  onChange={(e) => upd({ strictness: Number(e.target.value) })} />
                <dl className="mt-2.5 grid grid-cols-3 gap-2 border-t border-dashed border-line pt-3">
                  {[
                    { k: t("References"), v: String(refs), hint: t("per character in every video") },
                    { k: t("Face match"), v: signed((s - 0.5) * 0.2), hint: t("threshold") },
                    { k: t("QC pass mark"), v: signed((s - 0.5) * 0.3), hint: t("vs team defaults") },
                  ].map((x) => (
                    <div key={x.k} className="min-w-0">
                      <dt className="eyebrow truncate">{x.k}</dt>
                      <dd className="mono mt-1 text-sm font-medium">{x.v}</dd>
                      <dd className="mt-0.5 text-2xs leading-tight text-dim">{x.hint}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              {/* prompt preview */}
              <div className="relative rounded-lg border border-line bg-bg/40 p-3.5 pl-4">
                <span aria-hidden className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-accent/60" />
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="eyebrow">{t("Added to every prompt")}</span>
                  {dirty && <span className="text-2xs text-amber-300">{t("Save to refresh the preview")}</span>}
                </div>
                {data.prompt_text.trim() ? (
                  <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{data.prompt_text.trim()}</p>
                ) : <p className="text-xs text-dim">{t("Nothing is added yet: every trait is off and the text fields are empty.")}</p>}
              </div>
            </div>
          </div>

          {/* free text */}
          <div className="grid gap-4 @2xl:grid-cols-3">
            <RField label={t("Signature gestures / posture")} htmlFor={`lock-gestures-${cid}`} hint={t("e.g. tucks hair behind ear, slow deliberate nods")}>
              <Input id={`lock-gestures-${cid}`} value={form.gestures} disabled={!editable} onChange={(e) => upd({ gestures: e.target.value })} />
            </RField>
            <RField label={t("Apparent age")} htmlFor={`lock-age-${cid}`} hint={t("e.g. early 30s, or 'older and greyer' for season 2")}>
              <Input id={`lock-age-${cid}`} value={form.age} disabled={!editable} onChange={(e) => upd({ age: e.target.value })} />
            </RField>
            <RField label={t("Lighting style")} htmlFor={`lock-lighting-${cid}`} hint={t("e.g. soft warm key light, cool rim light")}>
              <Input id={`lock-lighting-${cid}`} value={form.lighting} disabled={!editable} onChange={(e) => upd({ lighting: e.target.value })} />
            </RField>
          </div>

          <p className="flex items-start gap-2 text-xs leading-relaxed text-mute">
            <Info className="mt-px size-3.5 shrink-0 text-info" />
            {t("The lock steers prompts, picks more references and tightens QC — it checks the result, it cannot guarantee identity. Approved references and a trained identity do the heavy lifting.")}
          </p>
        </div>
      )}
    </WorkPanel>
  );
}
