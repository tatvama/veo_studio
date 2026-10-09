import { useQueryClient } from "@tanstack/react-query";
import { Clapperboard, CloudUpload, RefreshCw, Settings2, Trash2, Zap, ZapOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { Character, SubmitResult } from "../../lib/types";
import { ConfirmDialog } from "../../pages/admin/shared/ConfirmDialog";
import { useGenerate } from "../Generate";
import { Alert, Badge, Button } from "../ui";
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
/** An image BytePlus still holds: accepted or still being checked (mirrors handlers_hub; rejected and deleted ones are sent again). */
const held = (x: { status: string }) => x.status === "Active" || x.status === "Processing";
/** The sheet views BytePlus gets, and how many (mirrors handlers_hub.REGISTER_KINDS / REGISTER_MAX). */
const KINDS = ["front", "three_quarter", "full_body", "profile", "outfit"];
const MAX = 4;

/** Registers an AI character in the BytePlus asset library, so Seedance takes it as a trusted reference instead of
 * blocking the face as a real person. */
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
  // "registering" with no job running is a run that stopped, unless the last word was a re-check that found images
  // BytePlus is still looking at
  const rechecked = !!reg.checked_at && (!reg.updated_at || Date.parse(reg.checked_at) >= Date.parse(reg.updated_at));
  const status = job ? "registering"
    : reg.status === "registering" ? (rechecked && assets.some((x) => x.status === "Processing") ? "checking" : "failed")
    : (reg.status ?? "none");
  const st = STATE[status] ?? STATE.none;
  const mode = settings?.providers.find((p) => p.provider === "byteplus_iam")?.mode;
  // mirrors handlers_hub.register_images: the approved sheet views, or the whole AI-made sheet while none is approved
  const sheet = (c.assets ?? []).filter((a) => !a.archived && KINDS.includes(a.kind));
  const pool = sheet.some((a) => a.approved) ? sheet.filter((a) => a.approved) : sheet;
  const eligible = Math.min(pool.length, MAX);
  const kept = assets.filter(held).length;
  const newOnes = Math.min(pool.filter((a) => !assets.some((x) => x.source_id === a.id && held(x))).length, Math.max(MAX - kept, 0));
  const auto = c.byteplus_auto;
  const canCheck = canEdit && mode !== "missing" && assets.length > 0;
  const canRemove = editable && mode !== "missing" && !!c.provider_assets?.byteplus;

  const refresh = () => { qc.invalidateQueries({ queryKey: ["character", c.id] }); qc.invalidateQueries({ queryKey: ["characters"] }); };
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
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const action = status === "ready" ? t("Add {n} new image(s)", { n: newOnes }) : status === "failed" ? t("Try again") : t("Register with BytePlus");
  const when = [reg.registered_at && t("Registered {when}", { when: ago(reg.registered_at) }), reg.checked_at && t("Checked {when}", { when: ago(reg.checked_at) })]
    .filter(Boolean).join(" · ");

  return (
    <WorkPanel id="sec-byteplus" n={n} kicker={t("Seedance · BytePlus")} icon={<Clapperboard />} title={t("Video character")}
      badge={<>
        {!(c.seedance_ready && status === "ready") && <Badge tone={st.tone} dot>{t(st.label)}</Badge>}
        {c.seedance_ready && <SeedanceBadge />}
      </>}
      description={t("Registers this AI character's sheet images in your BytePlus asset library. Seedance then uses them as trusted references, so the character keeps its look and isn't blocked as a real person.")}
      actions={editable && mode !== "missing" && status !== "checking" && !(status === "ready" && !newOnes) ? (
        <Button size="sm" variant={status === "ready" ? "secondary" : "primary"} loading={busy === "register"} className="max-sm:h-10"
          disabled={!!job || !eligible || !!busy} icon={<CloudUpload className="size-3.5" />}
          title={eligible ? undefined : t("Make the character sheet (front, three-quarter, full body) first")} onClick={() => void register()}>
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
        {status === "failed" && reg.error && <Alert tone="bad" title={t("Registration failed")}>{reg.error}</Alert>}
        {assets.length > 0 ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {assets.map((a) => (
              <li key={a.asset_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{t(VIEW_LABEL[a.kind] ?? a.kind.replace(/_/g, " "))}</span>
                  <span className="mono ml-2 text-2xs text-dim">{a.asset_id}</span>
                  {a.status === "Missing"
                    ? <span className="block text-2xs text-mute">{t("Deleted from the BytePlus library. Registering again sends it back.")}</span>
                    : a.error && <span className="block text-2xs text-bad">{a.error}</span>}
                </span>
                <Badge tone={ASSET_TONE[a.status] ?? "neutral"} dot>{t(a.status)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-mute">
            {eligible
              ? t("{n} sheet image(s) will be sent: {which}.", { n: eligible, which: sheet.some((a) => a.approved) ? t("the approved ones") : t("none is approved yet, so the sheet as it is") })
              : t("Make the character sheet first: front, three-quarter and full body work best.")}
          </p>
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
        {auto !== undefined && auto !== "Already registered" && mode !== "missing" && (
          <p className="flex items-start gap-1.5 text-xs text-mute">
            {auto ? <ZapOff aria-hidden className="mt-0.5 size-3.5 shrink-0 text-dim" /> : <Zap aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ok" />}
            <span>
              {!auto ? t("Registers by itself when the sheet is approved or the character is locked.")
                : auto.startsWith("Automatic registration is off") ? (
                  <>{t("Automatic registration is off. Turn it on in")} <Link to="/settings#generation" className="font-medium text-accent-ink hover:underline">{t("Settings → Generation")}</Link>.</>
                ) : `${t("Won't register by itself")} — ${t(auto)}.`}
            </span>
          </p>
        )}
        <p className="text-xs text-dim">
          {t("For AI-created characters only: a real person has to verify themselves in the BytePlus console. Your own photos are never sent.")}
        </p>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} busy={busy === "remove"} title={t("Remove {name} from BytePlus?", { name: c.name })}
        confirmLabel={t("Remove")} icon={<Trash2 className="size-4" />} onConfirm={remove}>
        {t("This deletes {name}'s images from your BytePlus asset library. Seedance then no longer knows the character and may block the face as a real person. You can register again any time.", { name: c.name })}
      </ConfirmDialog>
    </WorkPanel>
  );
}
