import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowRight, Equal, FlagTriangleRight, Image as ImageIcon, Layers } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { announce } from "../Generate";
import { Alert, Button, Field, Modal, Select, Skeleton, Toggle } from "../ui";
import { framesPlan, setFramesEngine, startStoryboard, useFramesEngines, type FramesPlan, type StoryboardBody } from "../../lib/frames";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";

/**
 * Storyboard frames for some scenes (or picked shots): every shot's start frame and end frame, made in order, each frame
 * following the one before. "Sync the clips" links each shot of a scene to the one before so it starts exactly on that end
 * frame: the clips then join without a jump and can be made side by side. The engine choice is saved for the project
 * (e.g. Seedream 5.0 Pro for a Seedance film) and also used by every single keyframe and end frame.
 */
export function StoryboardFramesModal({ open, onClose, projectId, eid, sceneIds, shotIds, scope }: {
  open: boolean; onClose: () => void; projectId: number; eid: number; sceneIds?: number[]; shotIds?: number[];
  /** What the run covers, in words ("Scene 2", "3 selected shots", "Every scene"). */
  scope: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: engines, isLoading: enginesLoading } = useFramesEngines(projectId, open);
  const [endFrames, setEndFrames] = useState(true);
  const [sync, setSync] = useState(false);
  const [redo, setRedo] = useState(false);
  const [plan, setPlan] = useState<FramesPlan | null>(null);
  const [planErr, setPlanErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [savingEngine, setSavingEngine] = useState(false);
  const current = engines?.current ?? "";

  const body: StoryboardBody = useMemo(() => ({
    scene_ids: sceneIds?.length ? sceneIds : undefined, shot_ids: shotIds?.length ? shotIds : undefined,
    end_frames: endFrames, sync, redo,
  }), [sceneIds, shotIds, endFrames, sync, redo]);

  // what the run would make, refreshed whenever an option (or the project's engine) changes
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setPlanErr("");
    framesPlan(eid, body)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) { setPlan(null); setPlanErr(String(e?.message ?? e)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open, eid, body, current]);

  const pickEngine = async (id: string) => {
    setSavingEngine(true);
    try {
      await setFramesEngine(projectId, id);
      qc.invalidateQueries({ queryKey: ["frames-engines", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    } catch { /* api() showed the error */ } finally { setSavingEngine(false); }
  };

  const start = async () => {
    setStarting(true);
    try {
      const r = await startStoryboard(eid, body);
      if (r.status === "nothing") toast.info(tr("Storyboard frames: every frame is already made"));
      else announce(r, tr("Storyboard frames"));
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["episode"] });
      onClose();
    } catch { /* api() showed the error */ } finally { setStarting(false); }
  };

  const chosen = engines?.engines.find((e) => e.id === current);
  const nothing = !!plan && plan.steps.length === 0 && !sync;
  return (
    <Modal open={open} onClose={onClose} closable={!starting} title={t("Storyboard frames · {scope}", { scope })}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={starting}>{t("Cancel")}</Button>
        <Button variant="primary" icon={<Layers className="size-3.5" />} loading={starting} disabled={loading || !plan || nothing}
          onClick={() => void start()}>
          {plan && plan.total_usd > 0 ? t("Make frames · ~{usd}", { usd: usd(plan.total_usd) }) : t("Make frames")}
        </Button>
      </>}>
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-mute">
          {t("Each shot gets a start frame and an end frame, made in order so every frame follows the one before (same people, place and light). Videos then run from each start frame to its end frame.")}
        </p>

        <Field label={t("Frames engine (saved for this project)")}
          hint={chosen ? t("{name}: about {usd} per image. Used for every start and end frame of this project.", { name: chosen.display_name, usd: usd(chosen.est_usd) })
            : t("Auto: the team's image chain (Google first). Pick Seedream for a Seedance film.")}>
          {enginesLoading ? <Skeleton className="h-9 w-full" /> : (
            <Select value={current} disabled={savingEngine} onChange={(e) => void pickEngine(e.target.value)} aria-label={t("Frames engine")}>
              <option value="">{t("Auto — team image chain")}</option>
              {(engines?.engines ?? []).map((e) => (
                <option key={e.id} value={e.id} disabled={e.provider_mode === "missing"}>
                  {e.display_name} · ~{usd(e.est_usd)}{e.provider_mode === "mock" ? ` · ${t("test mode")}` : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="space-y-2.5 rounded-lg border border-line bg-raised/30 p-3">
          <Toggle checked={endFrames} onChange={setEndFrames} label={<span className="text-xs">
            <span className="font-medium">{t("End frame for every shot")}</span>
            <span className="block text-2xs text-dim">{t("Off: only start frames (and the end frames a synced shot starts on)")}</span></span>} />
          <Toggle checked={sync} onChange={setSync} label={<span className="text-xs">
            <span className="font-medium">{t("Sync the clips")}</span>
            <span className="block text-2xs text-dim">{t("Each shot of a scene starts exactly on the end frame of the shot before: one continuous action, no jump at the cuts")}</span></span>} />
          <Toggle checked={redo} onChange={setRedo} label={<span className="text-xs">
            <span className="font-medium">{t("Remake frames that are already made")}</span>
            <span className="block text-2xs text-dim">{t("Off: keep good frames, make only what is missing or out of date")}</span></span>} />
        </div>

        {planErr ? <Alert tone="bad">{planErr}</Alert> : loading && !plan ? <Skeleton className="h-16 w-full" /> : plan && (
          <div className={clsx("space-y-2 transition-opacity", loading && "opacity-60")}>
            <p className="mono flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
              <span><span className="font-semibold text-ink">{plan.images}</span> <span className="text-mute">{t("new images")}</span></span>
              <span><span className="font-semibold text-ink">{plan.copies}</span> <span className="text-mute">{t("synced copies (free)")}</span></span>
              <span className="text-money">~{usd(plan.total_usd)}</span>
              <span className="truncate text-dim">{plan.engine_label}</span>
            </p>
            {nothing ? <p className="text-xs text-mute">{t("Every frame is already made. Turn on 'Remake' to make them again.")}</p> : (
              <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                {plan.steps.map((s, i) => (
                  <span key={`${s.shot_id}-${s.kind}-${i}`} title={s.copy ? t("A copy of the end frame before: free") : undefined}
                    className={clsx("mono inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs",
                      s.copy ? "border-ok/30 bg-ok/8 text-ok" : "border-line bg-panel text-mute")}>
                    {s.kind === "keyframe" ? (s.copy ? <Equal className="size-3" /> : <ImageIcon className="size-3" />) : <FlagTriangleRight className="size-3" />}
                    {s.code} {s.kind === "keyframe" ? t("start") : t("end")}
                    {i < plan.steps.length - 1 && <ArrowRight className="ml-0.5 size-2.5 text-dim/60" />}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
