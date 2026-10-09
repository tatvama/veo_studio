import { Clapperboard, CloudUpload, Settings2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { Character, SubmitResult } from "../../lib/types";
import { useGenerate } from "../Generate";
import { Alert, Badge, Button } from "../ui";
import { JobStrip } from "./cast";
import { VIEW_LABEL } from "./look";
import { useCharScope } from "./scope";
import { useActiveJobs } from "./util";
import { WorkPanel } from "./workspace";

type Reg = NonNullable<NonNullable<Character["provider_assets"]>["byteplus"]>;
const STATE: Record<string, { tone: "ok" | "info" | "bad" | "neutral"; label: string }> = {
  ready: { tone: "ok", label: "Registered" },
  registering: { tone: "info", label: "Registering" },
  failed: { tone: "bad", label: "Failed" },
  none: { tone: "neutral", label: "Not registered" },
};
const ASSET_TONE: Record<string, "ok" | "info" | "bad"> = { Active: "ok", Processing: "info", Failed: "bad" };
/** The sheet views BytePlus gets, and how many (mirrors handlers_hub.REGISTER_KINDS / REGISTER_MAX). */
const KINDS = ["front", "three_quarter", "full_body", "profile", "outfit"];
const MAX = 4;

/** Registers an AI character in the BytePlus asset library, so Seedance takes it as a trusted reference instead of
 * blocking the face as a real person. */
export function BytePlusPanel({ character: c, n }: { character: Character; n?: number }) {
  const t = useT();
  const { projectId, canEdit, canProduce } = useCharScope();
  const editable = canEdit && (!c.locked || canProduce);
  const { submit } = useGenerate();
  const { data: settings } = useSettings();
  const [busy, setBusy] = useState(false);
  const job = useActiveJobs(projectId, (j) => j.type === "byteplus_register" && Number(j.payload?.character_id) === c.id)[0];
  const reg: Reg = c.provider_assets?.byteplus ?? {};
  const status = job ? "registering" : reg.status === "registering" ? "failed" : (reg.status ?? "none");
  const st = STATE[status] ?? STATE.none;
  const mode = settings?.providers.find((p) => p.provider === "byteplus_iam")?.mode;
  const assets = reg.assets ?? [];
  // mirrors handlers_hub.register_images: the approved sheet views, or the whole AI-made sheet while none is approved
  const sheet = (c.assets ?? []).filter((a) => !a.archived && KINDS.includes(a.kind));
  const pool = sheet.some((a) => a.approved) ? sheet.filter((a) => a.approved) : sheet;
  const eligible = Math.min(pool.length, MAX);
  const kept = assets.filter((x) => x.status !== "Failed").length;
  const newOnes = Math.min(pool.filter((a) => !assets.some((x) => x.source_id === a.id && x.status !== "Failed")).length, Math.max(MAX - kept, 0));

  const register = async () => {
    setBusy(true);
    try {
      await submit(() => api.post<SubmitResult>(`/api/characters/${c.id}/register/byteplus`, { project_id: projectId ?? null }),
        tr("Register {name} with BytePlus", { name: c.name }));
    } finally { setBusy(false); }
  };

  const action = status === "ready" ? t("Add {n} new image(s)", { n: newOnes }) : status === "failed" ? t("Try again") : t("Register with BytePlus");

  return (
    <WorkPanel id="sec-byteplus" n={n} kicker={t("Seedance · BytePlus")} icon={<Clapperboard />} title={t("Video character")}
      badge={<Badge tone={st.tone} dot>{t(st.label)}</Badge>}
      description={t("Registers this AI character's sheet images in your BytePlus asset library. Seedance then uses them as trusted references, so the character keeps its look and isn't blocked as a real person.")}
      actions={editable && mode !== "missing" && !(status === "ready" && !newOnes) ? (
        <Button size="sm" variant={status === "ready" ? "secondary" : "primary"} loading={busy} className="max-sm:h-10"
          disabled={!!job || !eligible} icon={<CloudUpload className="size-3.5" />}
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
                  {a.error && <span className="block text-2xs text-bad">{a.error}</span>}
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
        <p className="text-xs text-dim">
          {t("For AI-created characters only: a real person has to verify themselves in the BytePlus console. Your own photos are never sent.")}
          {reg.registered_at ? ` ${t("Registered {when}.", { when: ago(reg.registered_at) })}` : ""}
        </p>
      </div>
    </WorkPanel>
  );
}
