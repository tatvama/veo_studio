import { useQueryClient } from "@tanstack/react-query";
import { Check, Coins, Copy, FileText, Loader2, RotateCcw, ScanFace, ShieldAlert, ShieldCheck, Upload, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { ago, usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { Character, ConsentRow, SubmitResult } from "../../lib/types";
import { useCharScope } from "./scope";
import { useGenerate } from "../Generate";
import { Alert, Badge, Button, Field, Input, Meter, Modal, Select, Skeleton, Textarea } from "../ui";
import { JobStrip, scaleMeter } from "./cast";
import { Fact } from "./kit";
import { Gallery, type GalleryItem } from "./Lightbox";
import { consentNeeds, IDENTITY_STATUS, useActiveJobs, useConsentRows } from "./util";
import { WorkPanel, scrollToSection } from "./workspace";

type IdStatus = NonNullable<Character["identity"]["status"]>;
const STATUS = IDENTITY_STATUS;

/** Small badge for character lists: identity ready / training. */
export function IdentityBadge({ identity }: { identity: Character["identity"] | undefined }) {
  const t = useT();
  const s = identity?.status;
  if (s === "ready") return <Badge tone="ok" title={t("Identity trained — the face is locked in every keyframe")}><ScanFace className="size-3" />ID</Badge>;
  if (s === "training" || s === "preparing") return <Badge tone="info" title={t("Identity training")}><Loader2 className="size-3 animate-spin" />ID</Badge>;
  if (s === "failed") return <Badge tone="bad" title={identity?.error || t("Identity training failed")}><ScanFace className="size-3" />ID</Badge>;
  return null;
}

/** Four-step progress for the face model: reference images → training set → training → ready. Mono nodes joined by connector lines. */
function Stepper({ status, hasRefs, trainingImages }: { status: IdStatus | "none"; hasRefs: boolean; trainingImages: number }) {
  const t = useT();
  const steps = [t("Reference images"), t("Training set"), t("Training"), t("Ready")];
  let done = 0;
  let active = -1;
  let failed = -1;
  if (status === "none") done = hasRefs ? 1 : 0;
  else if (status === "preparing") { done = 1; active = 1; }
  else if (status === "training") { done = 2; active = 2; }
  else if (status === "ready") done = 4;
  else if (status === "failed" || status === "cancelled") { done = trainingImages > 0 ? 2 : 1; failed = done; }
  return (
    <ol className="grid grid-cols-4" aria-label={t("Training progress")}>
      {steps.map((label, i) => {
        const isDone = i < done;
        const isActive = i === active;
        const isFailed = i === failed;
        return (
          <li key={label} className="relative flex flex-col items-center gap-2 px-1 text-center" aria-current={isActive ? "step" : undefined}>
            {i > 0 && (
              <span aria-hidden className={cn("absolute left-[calc(-50%+1.375rem)] right-[calc(50%+1.375rem)] top-3.5 h-px -translate-y-1/2 transition-colors duration-500",
                i <= done ? "bg-ok/60" : isActive || (isFailed && i === failed) ? "bg-accent/50" : "rm-rule")} />
            )}
            <span className={cn("mono relative z-[1] grid size-7 place-items-center rounded-md border text-2xs font-semibold transition-colors duration-300",
              isFailed ? "border-bad/50 bg-bad/15 text-bad" : isDone ? "border-ok/50 bg-ok/15 text-ok"
                : isActive ? "border-accent bg-accent/12 text-accent-ink shadow-[0_0_12px_-3px_var(--color-accent)]" : "border-line bg-raised text-dim")}>
              {isFailed ? <X className="size-3.5" strokeWidth={3} /> : isDone ? <Check className="size-3.5" strokeWidth={3} /> : isActive ? <Loader2 className="size-3.5 animate-spin" /> : String(i + 1).padStart(2, "0")}
            </span>
            <span className={cn("text-2xs leading-tight", isDone || isActive || isFailed ? "font-medium text-ink" : "text-dim")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Character identity (LoRA): train, status/progress, trigger word, samples, reset. */
export function IdentityPanel({ character: c, index, n }: { character: Character; index?: number; n?: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { projectId, canEdit, canProduce } = useCharScope();
  const editable = canEdit && (!c.locked || canProduce);  // locked: only a producer may train or change the set
  const { submit } = useGenerate();
  const { data: settings } = useSettings();
  const [confirm, setConfirm] = useState<"train" | "reset" | null>(null);
  const [busy, setBusy] = useState(false);
  const job = useActiveJobs(projectId, (j) => j.type === "train_identity" && Number(j.payload?.character_id) === c.id)[0];
  const varJob = useActiveJobs(projectId, (j) => j.type === "identity_variations" && Number(j.payload?.character_id) === c.id)[0];
  const id = c.identity || {};
  const status: IdStatus | "none" = id.status ?? "none";
  const st = STATUS[status] ?? STATUS.none;
  const inFlight = !!job || status === "preparing" || status === "training";

  const assets = (c.assets ?? []).filter((a) => !a.archived);
  const refs = assets.filter((a) => a.kind !== "identity_test" && a.kind !== "training");
  const training = assets.filter((a) => a.kind === "training");
  const tests = assets.filter((a) => a.kind === "identity_test").slice(-3).reverse();

  // Mirrors generation.train_identity_spec: ≈ $3 trainer + 8 images (only when providers are live).
  const live = (p: string) => settings?.providers.find((x) => x.provider === p)?.mode === "live";
  const imgPrice = Number(settings?.prices?.image_each?.[settings?.models?.image ?? ""] ?? 0.07);
  const estimate = live("fal") ? 3 + (live("gemini") ? 8 * imgPrice : 0) : 0;
  const ts = c.training ?? { basis: "sheet" as const, own: 0, variations_approved: 0, variations_waiting: 0, count: 0, min: 4, good: 10, auto_fill: false };
  const enough = ts.count >= ts.min;
  const ownPhotos = assets.filter((a) => a.kind === "source");
  const setMeter = scaleMeter(Math.min(ts.count, ts.good), ts.good, 10);

  const makeVariations = () => submit(() => api.post<SubmitResult>(`/api/characters/${c.id}/training/variations`, { count: 6, project_id: projectId ?? null }),
    tr("Variations of {name}'s photo", { name: c.name }));
  const patchAsset = async (aid: number, body: Record<string, unknown>) => {
    try { await api.patch(`/api/character-assets/${aid}`, body); await refresh(); } catch { /* api toasts */ }
  };

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["character", c.id] }),
    qc.invalidateQueries({ queryKey: ["characters"] }),
  ]);

  const train = async () => {
    setBusy(true);
    try {
      const r = await submit(() => api.post<SubmitResult>(`/api/characters/${c.id}/train`, { project_id: projectId ?? null }),
        tr("Train identity: {name}", { name: c.name }));
      if (r) setConfirm(null);
    } finally { setBusy(false); }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await api.del(`/api/characters/${c.id}/identity`);
      await refresh();
      toast.success(tr("Identity reset for {name}", { name: c.name }));
      setConfirm(null);
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  const copyTrigger = async () => {
    if (!id.trigger) return;
    try { await navigator.clipboard.writeText(id.trigger); toast.success(tr("Trigger word copied")); } catch { /* clipboard blocked */ }
  };

  const jobLabel = job && job.status !== "running"
    ? (job.status === "awaiting_approval" ? t("Awaiting budget approval") : job.status === "proposed" ? t("Proposed — confirm in the Director panel") : t("Queued"))
    : null;

  const testItems: GalleryItem[] = tests.map((a) => ({ id: a.id, url: a.url, label: t("Identity test"), badge: <Fact tone="ok" icon={<ScanFace />}>{t("Face matched")}</Fact> }));
  const trainItems: GalleryItem[] = training.map((a, i) => ({
    id: a.id, url: a.url, label: a.label || t("Variation {n}", { n: i + 1 }), approved: a.approved,
    sub: a.approved ? t("used for training") : t("not used — approve if it looks like them"),
  }));

  return (
    <WorkPanel id="sec-identity" index={index} n={n} kicker={t("Face model")} icon={<ScanFace />} title={t("Identity")}
      badge={<Badge tone={st.tone} dot>{t(st.label)}</Badge>}
      description={t("Trains a face model on this character so every keyframe keeps the exact same face.")}
      actions={<>
        {editable && (
          <Button size="sm" variant={status === "ready" ? "secondary" : "primary"} disabled={inFlight || !enough} icon={<ScanFace className="size-3.5" />} className="max-sm:h-10"
            title={enough ? undefined : t("Needs at least {n} approved images", { n: ts.min })} onClick={() => setConfirm("train")}>
            {status === "ready" || status === "failed" || status === "cancelled" ? t("Retrain identity") : t("Train identity")}
          </Button>
        )}
        {canProduce && status !== "none" && !inFlight && (
          <Button size="sm" variant="ghost" className="max-sm:h-10" icon={<RotateCcw className="size-3.5" />} onClick={() => setConfirm("reset")}>{t("Reset identity")}</Button>
        )}
      </>}>
      <div className="space-y-5">
        <Stepper status={status} hasRefs={refs.length > 0} trainingImages={training.length} />

        <AnimatePresence initial={false}>
          {(job || status === "preparing" || status === "training") && (
            <motion.div key="progress" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <JobStrip label={jobLabel ?? job?.message ?? (status === "training" ? t("Training (10–30 min)…") : t("Building the training set…"))}
                right={job ? `${Math.round((job.progress || 0) * 100)}%` : ""} progress={job?.progress ?? (status === "training" ? 0.4 : 0.1)} />
            </motion.div>
          )}
        </AnimatePresence>

        {(status === "failed" || status === "cancelled") && id.error && (
          <Alert tone={status === "failed" ? "bad" : "info"} title={status === "failed" ? t("Training failed") : t("Training was stopped")}>{id.error}</Alert>
        )}

        {c.training?.train_suggested && !inFlight && (
          <Alert tone="info" title={t("Worth training an identity")}>
            {t("{name} is in {n} shots. A trained face model keeps the face the same in every one of them.", { name: c.name, n: c.training.shots ?? 0 })}
          </Alert>
        )}

        {/* the training set: only images the user approved */}
        <div className={cn("rounded-lg border p-3.5", enough ? "border-ok/30 bg-ok/5" : "border-warn/40 bg-warn/5")}>
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <p className="eyebrow">{t("Training set")}</p>
            <span className="flex items-center gap-2.5">
              <Meter filled={setMeter.filled} total={setMeter.total} tone={enough ? "ok" : "warn"} className="w-20" />
              <span className="mono text-xs"><b className="font-semibold">{ts.count}</b><span className="text-dim"> / {ts.good}</span></span>
            </span>
          </div>
          <p className="text-sm font-medium">
            {ts.basis === "your_photos"
              ? t("Trains on {n} images: {own} of your photos + {v} approved variations", { n: ts.count, own: ts.own, v: ts.variations_approved })
              : t("AI-designed character: trains on its {n} sheet image(s), filled up with variations of its sheet. Upload photos of a real person to train only on those instead.", { n: ts.count })}
          </p>
          <p className="mt-0.5 text-xs text-mute">
            {enough
              ? (ts.count < ts.good ? t("Enough to train; {good}+ clear photos give a more reliable face.", { good: ts.good }) : t("Nothing else is added: no images you haven't seen."))
              : t("Needs at least {min} — nothing is added automatically. Upload more photos, or make variations of your photo and approve the ones that look like the person.", { min: ts.min })}
          </p>
          {editable && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" variant={ownPhotos.length ? "secondary" : "primary"} icon={<Upload className="size-3.5" />} className="max-sm:h-10"
                onClick={() => scrollToSection("sec-sheet")}>{t("Upload more photos")}</Button>
              {ownPhotos.length > 0 && (
                <Button size="sm" icon={<ScanFace className="size-3.5" />} className="max-sm:h-10" loading={!!varJob} disabled={!!varJob} onClick={() => void makeVariations()}>
                  {t("Make 6 variations of my photo")}
                </Button>
              )}
            </div>
          )}
          {ts.variations_waiting > 0 && (
            <p className="mt-2 text-xs text-warn">{t("{n} variation(s) waiting for your review below: approve (✓) the ones that look like the person.", { n: ts.variations_waiting })}</p>
          )}
        </div>

        <dl className="grid gap-px overflow-hidden rounded-lg border border-line bg-line text-sm @lg:grid-cols-3">
          <div className="min-w-0 bg-panel p-3">
            <dt className="eyebrow">{t("Trigger word")}</dt>
            <dd className="mt-2 flex items-center gap-1.5">
              {id.trigger ? (
                <>
                  <code className="mono truncate rounded bg-raised px-1.5 py-0.5 text-xs">{id.trigger}</code>
                  <button type="button" title={t("Copy")} aria-label={t("Copy")} onClick={copyTrigger} className="grid size-8 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink sm:size-6"><Copy className="size-3.5" /></button>
                </>
              ) : <span className="text-dim">—</span>}
            </dd>
          </div>
          <div className="bg-panel p-3">
            <dt className="eyebrow">{t("Training images")}</dt>
            <dd className="mono mt-2 text-sm font-medium">{id.images ?? "—"}</dd>
          </div>
          <div className="bg-panel p-3">
            <dt className="eyebrow">{t("Trained")}</dt>
            <dd className="mono mt-2 text-sm" title={id.trained_at ? new Date(id.trained_at).toLocaleString() : undefined}>{id.trained_at ? ago(id.trained_at) : "—"}</dd>
          </div>
        </dl>

        {trainItems.length > 0 && (
          <div>
            <p className="eyebrow mb-2.5 !normal-case !tracking-normal">{t("Variations of your photo ({n}) — only approved ones are trained on", { n: trainItems.length })}</p>
            <Gallery items={trainItems} canEdit={editable} minTile={5} aspect="3 / 4" className="gap-2"
              onApprove={(it) => void patchAsset(it.id, { approved: !it.approved })} onRemove={(it) => void patchAsset(it.id, { archived: true })} />
          </div>
        )}
        {testItems.length > 0 && (
          <div>
            <p className="eyebrow mb-2.5 !normal-case !tracking-normal">{t("Identity tests ({n})", { n: testItems.length })}</p>
            <Gallery items={testItems} canEdit={false} minTile={5} aspect="3 / 4" className="gap-2" />
          </div>
        )}
      </div>

      <Modal open={confirm === "train"} onClose={() => setConfirm(null)}
        title={<span className="flex items-center gap-2"><Coins className="size-4 text-money" />{t("Train identity for {name}", { name: c.name })}</span>}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={train}>{estimate ? t("Train · ≈{cost}", { cost: usd(estimate) }) : t("Train")}</Button>
        </>}>
        <div className="space-y-4 text-sm">
          <div className="flex items-baseline justify-between gap-3 rounded-lg border border-line bg-bg/40 px-4 py-3">
            <span className="eyebrow">{t("Approximate cost")}</span>
            <span className="mono text-2xl font-semibold text-money">{estimate ? `≈${usd(estimate)}` : usd(0)}</span>
          </div>
          <ul className="space-y-2 text-mute">
            {[
              ts.basis === "your_photos"
                ? t("Trains on {n} images: {own} of your photos + {v} variations you approved. Nothing else is added.", { n: ts.count, own: ts.own, v: ts.variations_approved })
                : t("Trains on its {n} sheet image(s), filled up with variations of the sheet (AI-designed character).", { n: ts.count }),
              t("Training takes 10–30 minutes and runs in the background."),
              t("When it's ready, keyframes with this character use the trained face automatically."),
            ].map((line) => (
              <li key={line} className="flex gap-2.5"><span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-ok/12 text-ok"><Check className="size-2.5" strokeWidth={3.5} /></span>{line}</li>
            ))}
          </ul>
          {!estimate && <p className="text-xs text-dim">{t("The identity trainer is in mock mode, so this run is free.")}</p>}
          <p className="text-xs text-dim">{t("Estimate uses list prices; budget limits and approvals still apply.")}</p>
        </div>
      </Modal>

      <Modal open={confirm === "reset"} onClose={() => setConfirm(null)} title={t("Reset identity?")}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>{t("Cancel")}</Button>
          <Button variant="danger" loading={busy} onClick={reset}>{t("Reset identity")}</Button>
        </>}>
        <p className="text-sm text-mute">{t("Keyframes will stop using the trained face for {name}. Images stay in the reference sheet; you can retrain at any time.", { name: c.name })}</p>
      </Modal>
    </WorkPanel>
  );
}

// ── consent ──────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = { likeness: "Likeness", voice_replication: "Voice", music: "Music", other: "Other" };
const today = () => new Date().toISOString().slice(0, 10);

/** Consent for real-person likeness (uploaded photos) or a possibly cloned external ElevenLabs voice. */
export function ConsentPanel({ character: c, index, n }: { character: Character; index?: number; n?: number }) {
  const t = useT();
  const { canProduce } = useCharScope();
  const { data: consents, isLoading, isError } = useConsentRows(canProduce);
  const [adding, setAdding] = useState<string | null>(null);

  const { photos, external } = consentNeeds(c);
  const needs: { kind: string; why: string }[] = [];
  if (photos.length) needs.push({ kind: "likeness", why: t("{n} uploaded photo(s) of a real person", { n: photos.length }) });
  if (external.length) needs.push({ kind: "voice_replication", why: t("External ElevenLabs voice ({langs}) — may be a cloned voice", { langs: external.map((v) => v.language.toUpperCase()).join(", ") }) });
  const mine = (consents ?? []).filter((r) => r.character_id === c.id);
  if (!needs.length && !mine.length) return null;

  const valid = (r: ConsentRow) => !r.expires_on || r.expires_on >= today();
  const missingKinds = needs.filter((x) => !mine.some((r) => r.kind === x.kind && valid(r))).length;

  return (
    <WorkPanel id="sec-consent" index={index} n={n} kicker={t("Compliance")} icon={<ShieldCheck />} title={t("Consent")}
      tone={missingKinds > 0 ? "warn" : undefined}
      description={t("Real people's faces and voices need a signed consent on file before publishing.")}
      actions={canProduce && <Button size="sm" icon={<Upload className="size-3.5" />} className="max-sm:h-10" onClick={() => setAdding(needs[0]?.kind ?? "likeness")}>{t("Add consent")}</Button>}>
      {!canProduce ? (
        <div className="space-y-2">
          {needs.map((x) => (
            <Alert key={x.kind} tone="warn" icon={<ShieldAlert className="size-4" />}>
              {x.why}. <span className="text-mute">{t("A producer must have consent on file.")}</span>
            </Alert>
          ))}
        </div>
      ) : isLoading ? <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : isError ? (
        <p className="text-sm text-mute">{t("Couldn't load consent records.")}</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {needs.map((x) => {
            const rows = mine.filter((r) => r.kind === x.kind);
            const ok = rows.find(valid);
            if (ok) return null;
            const expired = rows[0];
            return (
              <li key={x.kind} className="relative flex flex-wrap items-center gap-3 bg-warn/5 py-3 pl-4 pr-3 text-sm">
                <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-warn" />
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-warn/15 text-warn"><ShieldAlert className="size-4" /></span>
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block font-medium">
                    {expired ? t("{kind} consent expired on {date}", { kind: t(KIND_LABEL[x.kind] ?? x.kind), date: expired.expires_on })
                      : t("No {kind} consent on file", { kind: t(KIND_LABEL[x.kind] ?? x.kind).toLowerCase() })}
                  </span>
                  <span className="block text-xs text-mute">{x.why}</span>
                </span>
                <Button size="sm" variant="outline" className="max-sm:h-10" onClick={() => setAdding(x.kind)}>{t("Add consent")}</Button>
              </li>
            );
          })}
          {mine.map((r) => (
            <li key={r.id} className={cn("relative flex flex-wrap items-center gap-3 py-3 pl-4 pr-3 text-sm", valid(r) ? "bg-ok/5" : "bg-bg/40")}>
              <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", valid(r) ? "bg-ok" : "bg-transparent")} />
              <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", valid(r) ? "bg-ok/15 text-ok" : "bg-raised text-dim")}>
                {valid(r) ? <ShieldCheck className="size-4" /> : <ShieldAlert className="size-4" />}
              </span>
              <span className="min-w-0 flex-1 basis-48">
                <span className="block"><span className="font-medium">{valid(r) ? t("Consent on file") : t("Expired consent")}</span>
                  <span className="text-mute"> · {t(KIND_LABEL[r.kind] ?? r.kind)} · {r.subject_name}</span></span>
                <span className="mono block text-2xs text-dim">
                  {[r.scope, r.expires_on ? t("expires {date}", { date: r.expires_on }) : t("no expiry"), t("recorded {when}", { when: ago(r.created_at) })].filter(Boolean).join(" · ")}
                </span>
              </span>
              {r.file_url && (
                <a href={r.file_url} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-md px-2 py-1 text-xs text-mute transition-colors hover:bg-hover hover:text-ink sm:min-h-0">
                  <FileText className="size-3.5" />{t("Signed form")}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}

      <AddConsentModal open={!!adding} kind={adding ?? "likeness"} character={c} onClose={() => setAdding(null)} />
    </WorkPanel>
  );
}

function AddConsentModal({ open, kind, character, onClose }: { open: boolean; kind: string; character: Character; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState({ kind, subject_name: "", scope: "", expires_on: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) { setForm({ kind, subject_name: "", scope: "", expires_on: "" }); setFile(null); }
  }

  const save = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("kind", form.kind);
      fd.append("subject_name", form.subject_name.trim());
      fd.append("scope", form.scope.trim());
      fd.append("expires_on", form.expires_on);
      fd.append("character_id", String(character.id));
      if (file) fd.append("file", file);
      await api.post<ConsentRow>("/api/consents", fd);
      await qc.invalidateQueries({ queryKey: ["consents"] });
      toast.success(tr("Consent recorded for {name}", { name: character.name }));
      onClose();
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={t("Add consent — {name}", { name: character.name })}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="primary" loading={busy} disabled={!form.subject_name.trim()} onClick={save}>{t("Save consent")}</Button>
      </>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Kind")}>
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="likeness">{t("Likeness (face / photos)")}</option>
              <option value="voice_replication">{t("Voice (cloned / replicated)")}</option>
              <option value="other">{t("Other")}</option>
            </Select>
          </Field>
          <Field label={t("Person's name")}>
            <Input value={form.subject_name} onChange={(e) => setForm({ ...form, subject_name: e.target.value })} placeholder={t("Full name as signed")} />
          </Field>
        </div>
        <Field label={t("Scope")} hint={t("What the consent covers: projects, platforms, languages, paid ads…")}>
          <Textarea rows={2} value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Expires on")} hint={t("Leave blank if it doesn't expire")}>
            <Input type="date" className="mono" value={form.expires_on} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
          </Field>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-mute">{t("Signed form")}</span>
            <div className="flex h-9 items-center gap-2">
              <Button size="sm" type="button" icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>{file ? t("Replace") : t("Upload")}</Button>
              <span className="min-w-0 truncate text-xs text-mute">{file?.name ?? t("PDF or image")}</span>
              <input ref={fileRef} type="file" hidden accept="application/pdf,image/png,image/jpeg,image/webp"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
