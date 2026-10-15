import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Clapperboard, CloudUpload, RefreshCw, Settings2, ShieldAlert, Trash2, Zap, ZapOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { BytePlusPlan, Character, SubmitResult } from "../../lib/types";
import { ConfirmDialog } from "../../pages/admin/shared/ConfirmDialog";
import { useGenerate } from "../Generate";
import { Alert, Badge, Button } from "../ui";
import { uploadLabel } from "./AiMade";
import { JobStrip } from "./cast";
import { VIEW_LABEL } from "./look";
import { SeedanceBadge } from "./SeedanceBadge";
import { useCharScope } from "./scope";
import { useActiveJobs } from "./util";
import { WorkPanel } from "./workspace";

type Reg = NonNullable<NonNullable<Character["provider_assets"]>["byteplus"]>;
const STATE: Record<string, { tone: "ok" | "info" | "bad" | "neutral"; label: string }> = {
  ready: { tone: "ok", label: "Registered" },
  registering: { tone: "info", label: "Registering" },
  checking: { tone: "info", label: "BytePlus is checking" },
  failed: { tone: "bad", label: "Failed" },
  none: { tone: "neutral", label: "Not registered" },
};
const ASSET_TONE: Record<string, "ok" | "info" | "bad" | "neutral"> = { Active: "ok", Processing: "info", Failed: "bad", Missing: "neutral" };
/** What an image is, for this panel: an attested upload or a sheet view. */
const kindLabel = (kind: string) => (kind === "source" ? "AI-made upload" : VIEW_LABEL[kind] ?? kind.replace(/_/g, " "));

/** Registers an AI character in the BytePlus asset library, so Seedance takes it as a trusted reference instead of
 * blocking the face as a real person. What would be sent, what is skipped and why the character can't be registered
 * all come from the server (GET /api/characters/{id}/byteplus/plan), so the panel never disagrees with the rules. */
export function BytePlusPanel({ character: c, n }: { character: Character; n?: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { projectId, canEdit, canProduce } = useCharScope();
  const editable = canEdit && (!c.locked || canProduce);
  const { submit } = useGenerate();
  const { data: settings } = useSettings();
  const [busy, setBusy] = useState<"" | "register" | "check" | "remove">("");
  const [confirm, setConfirm] = useState(false);
  const job = useActiveJobs(projectId, (j) => j.type === "byteplus_register" && Number(j.payload?.character_id) === c.id)[0];
  const reg: Reg = c.provider_assets?.byteplus ?? {};
  const assets = reg.assets ?? [];
  // the plan follows the character: any change to its images, attestations or registration asks again
  const sig = [(c.assets ?? []).map((a) => `${a.id}:${a.kind}:${a.approved ? 1 : 0}:${a.archived ? 1 : 0}:${a.ai_made ? 1 : 0}`).join(","),
    reg.status, reg.updated_at, reg.checked_at, c.archived ? 1 : 0].join("|");
  const { data: plan } = useQuery({
    queryKey: ["byteplus-plan", c.id, sig],
    queryFn: () => api.get<BytePlusPlan>(`/api/characters/${c.id}/byteplus/plan`, { silent: true }),
  });
  // "registering" with no job running is a run that stopped, unless the last word was a re-check that found images
  // BytePlus is still looking at
  const rechecked = !!reg.checked_at && (!reg.updated_at || Date.parse(reg.checked_at) >= Date.parse(reg.updated_at));
  const status = job ? "registering"
    : reg.status === "registering" ? (rechecked && assets.some((x) => x.status === "Processing") ? "checking" : "failed")
    : (reg.status ?? "none");
  const st = STATE[status] ?? STATE.none;
  const mode = settings?.providers.find((p) => p.provider === "byteplus_iam")?.mode;
  const block = plan?.blocked ?? c.byteplus_block ?? "";
  const withdrawn = !!reg.withdrawn;
  const toSend = (plan?.images ?? []).filter((x) => !x.registered);
  const eligible = plan?.images.length ?? 0;
  const auto = c.byteplus_auto;
  const canCheck = canEdit && mode !== "missing" && assets.length > 0 && !withdrawn;
  // taking a registration back is always allowed to whoever may edit (a locked character too: it's the safe direction)
  const canRemove = canEdit && mode !== "missing" && !!c.provider_assets?.byteplus;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["character", c.id] });
    qc.invalidateQueries({ queryKey: ["characters"] });
    qc.invalidateQueries({ queryKey: ["byteplus-plan", c.id] });
  };
  const register = async () => {
    setBusy("register");
    try {
      await submit(() => api.post<SubmitResult>(`/api/characters/${c.id}/register/byteplus`, { project_id: projectId ?? null }),
        tr("Register {name} with BytePlus", { name: c.name }));
    } finally { setBusy(""); }
  };
  const recheck = async () => {
    setBusy("check");
    try {
      await api.post<Reg>(`/api/characters/${c.id}/byteplus/refresh`);
      refresh();
      toast.success(tr("Checked with BytePlus"));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  const remove = async () => {
    setBusy("remove");
    try {
      await api.del<{ ok: boolean; removed: number }>(`/api/characters/${c.id}/byteplus`);
      refresh();
      setConfirm(false);
      toast.success(tr("{name} removed from BytePlus", { name: c.name }));
    } catch { refresh(); /* api toasts; a failed retry updates the error shown here */ } finally { setBusy(""); }
  };

  const action = status === "ready" ? t("Add {n} new image(s)", { n: toSend.length }) : status === "failed" ? t("Try again") : t("Register with BytePlus");
  const why = block || plan?.setup || (!eligible ? t("Make the character sheet (front, three-quarter, full body) or upload an AI-made image first") : "");
  const when = [reg.registered_at && t("Registered {when}", { when: ago(reg.registered_at) }), reg.checked_at && t("Checked {when}", { when: ago(reg.checked_at) })]
    .filter(Boolean).join(" · ");
  const showRegister = editable && mode !== "missing" && status !== "checking" && !withdrawn && !(status === "ready" && !toSend.length && !block);

  return (
    <WorkPanel id="sec-byteplus" n={n} kicker={t("Seedance · BytePlus")} icon={<Clapperboard />} title={t("Video character")}
      badge={<>
        {!(c.seedance_ready && status === "ready") && <Badge tone={withdrawn ? "bad" : st.tone} dot>{withdrawn ? t("Removal pending") : t(st.label)}</Badge>}
        {c.seedance_ready && <SeedanceBadge />}
      </>}
      description={t("Registers this AI character's images (the uploads you marked AI-generated and its sheet views) in your BytePlus asset library. Seedance then uses them as trusted references, so the character keeps its look and isn't blocked as a real person.")}
      actions={showRegister ? (
        <Button size="sm" variant={status === "ready" ? "secondary" : "primary"} loading={busy === "register"} className="max-sm:h-10"
          disabled={!!job || !!why || !!busy || !plan} icon={<CloudUpload className="size-3.5" />}
          title={why || undefined} onClick={() => void register()}>
          {action}
        </Button>
      ) : undefined}>
      <div className="space-y-3">
        {mode === "missing" && (
          <Alert tone="info" icon={<Settings2 className="size-4" />}>
            {t("Add the BytePlus access key and secret in")} <Link to="/settings#keys" className="font-medium text-accent-ink hover:underline">{t("Settings → AI services")}</Link> {t("to register characters.")}
          </Alert>
        )}
        <AnimatePresence initial={false}>
          {job && (
            <motion.div key="job" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <JobStrip label={job.message || t("Queued")} right={`${Math.round((job.progress || 0) * 100)}%`} progress={job.progress ?? 0.05} />
            </motion.div>
          )}
        </AnimatePresence>
        {withdrawn ? (
          <Alert tone="bad" icon={<ShieldAlert className="size-4" />} title={t("Not removed from BytePlus yet")}>
            {reg.withdrawn === "archived" ? t("The character was archived.") : t("An upload was marked as a real person's photo.")}{" "}
            {t("It isn't used here any more, but BytePlus still holds the images.")}
            {reg.remove_error && <span className="mt-1 block text-2xs">{reg.remove_error}</span>}
            {canRemove && <span className="mt-1 block">{t("Press Remove from BytePlus to try again.")}</span>}
          </Alert>
        ) : status === "failed" && reg.error && <Alert tone="bad" title={t("Registration failed")}>{reg.error}</Alert>}
        {block && !withdrawn && (
          <Alert tone="warn" icon={<Ban className="size-4" />} title={assets.length ? t("No more images can be sent") : t("Can't be registered")}>
            {t(block)}
            {c.byteplus_block?.startsWith("Made from a photo") && (
              <span className="mt-1 block text-2xs">{t("If an upload is AI-generated after all, mark it so under Reference pack → Your uploads.")}</span>
            )}
          </Alert>
        )}
        {assets.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {assets.map((a) => (
              <li key={a.asset_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{t(kindLabel(a.kind))}</span>
                  {a.resized && <span className="ml-2 text-2xs text-dim">{t("smaller copy")}</span>}
                  <span className="mono ml-2 text-2xs text-dim">{a.asset_id}</span>
                  {a.status === "Missing"
                    ? <span className="block text-2xs text-mute">{t("Deleted from the BytePlus library. Registering again sends it back.")}</span>
                    : a.error && <span className="block text-2xs text-bad">{a.error}</span>}
                </span>
                <Badge tone={ASSET_TONE[a.status] ?? "neutral"} dot>{t(a.status)}</Badge>
              </li>
            ))}
          </ul>
        )}
        {!block && !withdrawn && plan && (
          toSend.length > 0 ? (
            <div>
              <p className="eyebrow mb-2">{status === "ready" ? t("New images to send ({n})", { n: toSend.length }) : t("Images that will be sent ({n})", { n: toSend.length })}</p>
              <ul className="flex flex-wrap gap-2.5">
                {toSend.map((x) => (
                  <li key={x.id} className="w-20 min-w-0" title={x.note || undefined}>
                    <img src={x.url} alt="" loading="lazy" className="aspect-[3/4] w-full rounded-md border border-line bg-raised object-cover" />
                    <p className="mt-1 truncate text-2xs font-medium">{x.kind === "source" ? uploadLabel(x) : t(kindLabel(x.kind))}</p>
                    <p className="truncate text-2xs text-dim">{x.kind === "source" ? t("AI-made upload") : x.resize ? t("smaller copy") : t("sheet view")}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-2xs text-dim">
                {t("Best first, up to {n} images: the uploads you marked AI-generated, then the approved sheet views (or the whole sheet while none is approved).", { n: plan.max })}
              </p>
            </div>
          ) : !assets.length && !plan.skipped.length && (
            <p className="text-sm text-mute">{t("Make the character sheet first (front, three-quarter and full body work best), or upload an AI-made image.")}</p>
          )
        )}
        {!block && !withdrawn && !!plan?.skipped.length && (
          <div>
            <p className="eyebrow mb-1.5">{t("Not sent ({n})", { n: plan.skipped.length })}</p>
            <ul className="space-y-1">
              {plan.skipped.map((x) => (
                <li key={x.id} className="flex items-start gap-2 text-xs text-mute">
                  {x.url && <img src={x.url} alt="" loading="lazy" className="h-8 w-6 shrink-0 rounded border border-line object-cover" />}
                  <span className="min-w-0"><span className="font-medium text-ink">{x.kind === "source" ? uploadLabel({ label: x.label ?? "", ai_made: true }) : t(kindLabel(x.kind))}</span> — {x.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {(when || canCheck || canRemove) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="mono text-2xs text-dim">{when}</p>
            <div className="flex flex-wrap items-center gap-2">
              {canCheck && (
                <Button size="sm" variant="outline" className="max-sm:h-10" icon={<RefreshCw className="size-3.5" />} loading={busy === "check"}
                  disabled={!!job || !!busy} title={job ? t("Wait for the registration to finish") : t("Ask BytePlus again how each image stands")}
                  onClick={() => void recheck()}>{t("Re-check status")}</Button>
              )}
              {canRemove && (
                <Button size="sm" variant="danger" className="max-sm:h-10" icon={<Trash2 className="size-3.5" />}
                  disabled={!!job || !!busy} title={job ? t("Wait for the registration to finish") : undefined}
                  onClick={() => setConfirm(true)}>{t("Remove from BytePlus")}</Button>
              )}
            </div>
          </div>
        )}
        {auto !== undefined && auto !== "Already registered" && mode !== "missing" && !block && (
          <p className="flex items-start gap-1.5 text-xs text-mute">
            {auto ? <ZapOff aria-hidden className="mt-0.5 size-3.5 shrink-0 text-dim" /> : <Zap aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ok" />}
            <span>
              {!auto ? t("Registers by itself when the sheet is approved, an AI-made image is uploaded or the character is locked.")
                : auto.startsWith("Automatic registration is off") ? (
                  <>{t("Automatic registration is off. Turn it on in")} <Link to="/settings#generation" className="font-medium text-accent-ink hover:underline">{t("Settings → Generation")}</Link>.</>
                ) : `${t("Won't register by itself")} — ${t(auto)}.`}
            </span>
          </p>
        )}
        <p className="text-xs text-dim">
          {t("For AI-created characters only: a real person has to verify themselves in the BytePlus console. Photos of real people are never sent.")}
        </p>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} busy={busy === "remove"} title={t("Remove {name} from BytePlus?", { name: c.name })}
        confirmLabel={t("Remove")} icon={<Trash2 className="size-4" />} onConfirm={remove}>
        {t("This deletes {name}'s images from your BytePlus asset library. Seedance then no longer knows the character and may block the face as a real person. You can register again any time.", { name: c.name })}
      </ConfirmDialog>
    </WorkPanel>
  );
}
