import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Info, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { tr, useT } from "../../lib/i18n";
import { setCharacterLock, useCharacterLock, type CharacterLock as LockConfig, type CharacterV3 } from "../../lib/v3";
import { Badge, Button, Input, Skeleton, Toggle } from "../ui";
import { LoadError, RField, SectionCard } from "./kit";
import { LEVEL_LABEL, strictnessLevel } from "./look";

type TraitKey = "face" | "body" | "skin_hair" | "voice" | "costume_continuity";
const TRAITS: { key: TraitKey; label: string; hint: string }[] = [
  { key: "face", label: "Face", hint: "Identical face and facial hair in every frame." },
  { key: "body", label: "Body", hint: "Same build and body proportions." },
  { key: "skin_hair", label: "Skin & hair", hint: "Same skin tone and hairstyle." },
  { key: "voice", label: "Voice", hint: "The voice description goes into every dialogue prompt." },
  { key: "costume_continuity", label: "Costume continuity", hint: "Must wear the scene's outfit, nothing added or removed. QC fails a wrong outfit." },
];

const signed = (d: number) => `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(2)}`;

/**
 * Character Lock: which traits every prompt must keep, free-text mannerisms / age / lighting, and how strict QC is.
 * Saved on its own (PUT /lock); the server answers with the exact sentence it appends to prompts.
 */
export function CharacterLockPanel({ character, editable, index }: { character: CharacterV3; editable: boolean; index?: number }) {
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
    <SectionCard id="sec-lock" index={index} icon={<ShieldCheck />}
      title={<span className="flex flex-wrap items-center gap-2">{t("Character Lock")}{form && <Badge tone={level === "strict" ? "ok" : level === "lenient" ? "warn" : "neutral"} dot>{t(LEVEL_LABEL[level])}</Badge>}</span>}
      description={t("What every prompt must keep about {name}, and how strictly QC checks it.", { name: character.name })}
      actions={editable && data && (
        <>
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={busy || JSON.stringify(form) === JSON.stringify(data.defaults)}
            onClick={() => setForm(data.defaults)}>{t("Reset to defaults")}</Button>
          <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={busy} disabled={!dirty} onClick={save}>{t("Save lock")}</Button>
        </>
      )}>
      {isLoading || (!form && !isError) ? (
        <div className="space-y-3" aria-busy="true"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-9 w-2/3" /><Skeleton className="h-16" /></div>
      ) : isError || !form || !data ? (
        <LoadError what={t("Couldn't load the Character Lock")} onRetry={() => refetch()} />
      ) : (
        <div className="space-y-5">
          {/* traits */}
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <p className="text-xs font-medium text-mute">{t("Locked traits")}</p>
              <span className="text-2xs tabular-nums text-dim">{t("{a}/{n} on", { a: onCount, n: TRAITS.length })}</span>
            </div>
            <ul className="grid gap-2 @lg:grid-cols-2">
              {TRAITS.map((x) => (
                <li key={x.key} className={clsx("flex items-start justify-between gap-3 rounded-xl border p-3", form[x.key] ? "border-ok/30 bg-ok/5" : "border-line bg-bg/30")}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t(x.label)}</p>
                    <p className="mt-0.5 text-xs leading-snug text-mute">{t(x.hint)}</p>
                  </div>
                  <Toggle checked={!!form[x.key]} disabled={!editable} label={<span className="sr-only">{t(x.label)}</span>} onChange={(v) => upd({ [x.key]: v } as Partial<LockConfig>)} />
                </li>
              ))}
            </ul>
          </div>

          {/* free text */}
          <div className="grid gap-4 @lg:grid-cols-3">
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

          {/* strictness */}
          <div className="rounded-xl border border-line bg-bg/40 p-3.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <label htmlFor={sliderId} className="text-xs font-medium text-mute">{t("Strictness")}</label>
              <span className="text-xs font-medium tabular-nums">{t(LEVEL_LABEL[level])} · {s.toFixed(2)}</span>
            </div>
            <input id={sliderId} type="range" min={0} max={1} step={0.05} value={s} disabled={!editable} className="mt-2 w-full"
              aria-valuetext={t("{level}: {refs} reference image(s) per character", { level: t(LEVEL_LABEL[level]), refs })}
              onChange={(e) => upd({ strictness: Number(e.target.value) })} />
            <div aria-hidden className="flex justify-between text-2xs text-dim"><span>{t("Lenient")}</span><span>{t("Balanced")}</span><span>{t("Strict")}</span></div>
            <p className="mt-2 text-xs leading-relaxed text-mute">
              {t("{refs} reference image(s) per character in every video · face-match threshold {face} · QC pass mark {qc} (relative to the team defaults)",
                { refs, face: signed((s - 0.5) * 0.2), qc: signed((s - 0.5) * 0.3) })}
            </p>
          </div>

          {/* prompt preview */}
          <div className="rounded-xl border border-line bg-bg/40 p-3.5">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
              <span className="font-medium text-mute">{t("Added to every prompt")}</span>
              {dirty && <span className="text-2xs text-amber-300">{t("Save to refresh the preview")}</span>}
            </div>
            {data.prompt_text.trim() ? (
              <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{data.prompt_text.trim()}</p>
            ) : <p className="text-xs text-dim">{t("Nothing is added yet: every trait is off and the text fields are empty.")}</p>}
          </div>

          <p className="flex items-start gap-2 text-xs leading-relaxed text-mute">
            <Info className="mt-px size-3.5 shrink-0 text-info" />
            {t("The lock steers prompts, picks more references and tightens QC — it checks the result, it cannot guarantee identity. Approved references and a trained identity do the heavy lifting.")}
          </p>
        </div>
      )}
    </SectionCard>
  );
}
