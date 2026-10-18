import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  ArrowLeftRight, AudioLines, Check, CircleCheck, Film, Gauge, LayoutGrid, Plus, RefreshCw, Sparkles, Trash2, WandSparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useGenerate } from "../../../../components/Generate";
import { Button, Field, Modal, Textarea } from "../../../../components/ui";
import { api } from "../../../../lib/api";
import { LANG_SHORT, QUALITY_INFO, ago, usd } from "../../../../lib/format";
import { tr, useT } from "../../../../lib/i18n";
import { useUI } from "../../../../lib/store";
import type { Shot, SubmitResult, Take } from "../../../../lib/types";
import { markFresh, type TakeV3 } from "../../../../lib/v3";
import { ContextMenu, type CtxItem, type MenuAnchor } from "./ContextMenu";
import { SPEED_PRESETS, type Clip } from "./shared";
import { estimateBatch, quote } from "../../../../lib/estimates";

export interface ClipMenuState { shotId: number; anchor: MenuAnchor; returnFocus: HTMLElement | null }

const KIND_LABEL: Record<string, string> = { video: "Video", lipsync: "Mouth sync", voicelock: "Voice lock" };

/**
 * The actions behind a main-track clip's right-click / "…" menu: AI regeneration (through the cost flow), take
 * swapping, speed, approval, removal, and jumping to the storyboard. Money always goes through useGenerate().submit.
 */
export function ClipMenu({ state, clip, eid, lang, projectId, canEdit, canReview, embedded, onClose, onSpeed, onInspect }: {
  state: ClipMenuState | null; clip: Clip | null; eid: number; lang: string; projectId: number; canEdit: boolean; canReview: boolean;
  embedded: boolean; onClose: () => void;
  /** Writes fx.speed (merged with the shot's other effects). */ onSpeed: (shot: Shot, speed: number) => Promise<void>;
  /** Opens the clip inspector (custom speed, numeric trims). */ onInspect: (shotId: number) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { priced } = useGenerate();
  const setSelectedShot = useUI((s) => s.setSelectedShot);
  const [takes, setTakes] = useState<{ shotId: number; list: Take[] } | null>(null);
  const [dialog, setDialog] = useState<"extend" | "edit" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const shot = clip?.shot ?? null;
  const open = !!state && !!shot;

  // the shot's takes (for "Swap take"): loaded when the menu opens, once per shot
  useEffect(() => {
    if (!state) return;
    let alive = true;
    api.get<Shot>(`/api/shots/${state.shotId}`, { silent: true })
      .then((s) => { if (alive) setTakes({ shotId: state.shotId, list: s.takes ?? [] }); })
      .catch(() => { if (alive) setTakes({ shotId: state.shotId, list: [] }); });
    return () => { alive = false; };
  }, [state?.shotId, open]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["episode", eid] });
    if (shot) qc.invalidateQueries({ queryKey: ["shot", shot.id] });
  };
  /** A paid action on this clip's shot: the price first (the same estimate as the batch buttons), then the job. */
  const act = (path: "video" | "lipsync", what: string, body: Record<string, any> = {}) => {
    if (!shot) return;
    const action = path === "video" ? "videos" : "lipsync";
    void priced({ quote: () => estimateBatch(eid, { action, shot_ids: [shot.id], ...body }),
      run: () => api.post<SubmitResult>(`/api/shots/${shot.id}/${path}`, body), what: `${what} ${shot.code}` });
  };
  const select = async (take: Take) => {
    try {
      await api.post(`/api/takes/${take.id}/select`);
      toast.success(tr("{code} now uses take #{id}", { code: shot?.code ?? "", id: take.id }));
      refresh();
    } catch { /* api toasts */ }
  };
  const fresh = async (stale: TakeV3[]) => {
    try {
      await Promise.all(stale.map((x) => markFresh(x.id)));
      toast.success(tr("Marked fresh"));
      refresh();
    } catch { /* api toasts */ }
  };
  const approve = async (on: boolean) => {
    if (!shot) return;
    try {
      await api.post(`/api/shots/${shot.id}/approve`, { approved: on });
      toast.success(on ? tr("{code} approved", { code: shot.code }) : tr("{code} approval removed", { code: shot.code }));
      refresh();
    } catch { /* api toasts */ }
  };
  const remove = async () => {
    if (!shot) return;
    try {
      await api.patch(`/api/shots/${shot.id}`, { include: false });
      toast.success(tr("{code} removed from the cut — it keeps its takes", { code: shot.code }));
      qc.invalidateQueries({ queryKey: ["episode", eid] });
    } catch { /* api toasts */ }
  };
  const openStoryboard = () => {
    if (!shot) return;
    setSelectedShot(shot.id);
    if (!embedded) navigate(`/p/${projectId}/storyboard`);
  };
  const runDialog = async () => {
    if (!shot || !shot.video) return;
    setBusy(true);
    try {
      const take = shot.video.id;
      const r = dialog === "edit"
        ? await priced({ quote: () => quote({ action: "edit", take_id: take, instruction: text }),
            run: () => api.post<SubmitResult>(`/api/takes/${take}/edit`, { instruction: text }), what: `${t("Edit with words")} ${shot.code}` })
        : await priced({ quote: () => quote({ action: "extend", shot_id: shot.id, prompt: text }),
            run: () => api.post<SubmitResult>(`/api/shots/${shot.id}/extend`, { prompt: text }), what: `${t("Extend")} ${shot.code}` });
      if (r) { setDialog(null); setText(""); }
    } finally { setBusy(false); }
  };

  const v = shot?.video ?? null;
  const visual = [shot?.lipsync, shot?.voicelock, shot?.video].filter(Boolean) as TakeV3[];
  const stale = visual.filter((x) => x.stale);
  const approved = shot?.status === "approved";
  const speed = shot?.fx?.speed ?? 1;
  const loaded = !!shot && takes?.shotId === shot.id;
  const takeList = loaded
    ? takes!.list.filter((x) => (x.kind === "video" || x.kind === "lipsync") && x.status !== "archived" && !(x as any).archived)
      .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))
    : [];
  const takeRows = (): CtxItem[] => {
    if (!loaded) return [{ label: t("Loading takes…"), disabled: true }];
    if (!takeList.length) return [{ label: t("No video takes yet"), disabled: true }];
    return takeList.map((x) => ({
      active: x.selected, disabled: !canReview || x.selected, onClick: () => void select(x),
      label: (
        <span className="flex items-center gap-2">
          <span className="grid h-6 w-10 shrink-0 place-items-center overflow-hidden rounded bg-black">
            {x.thumb_url ? <img src={x.thumb_url} alt="" className="size-full object-cover" /> : <Film className="size-3 text-dim" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 truncate">
              #{x.id} · {t(KIND_LABEL[x.kind] ?? x.kind)}{x.language && ` · ${LANG_SHORT[x.language] ?? x.language}`}
              {x.selected && <Check className="size-3 shrink-0 text-accent-ink" />}
              {(x as TakeV3).stale && <span className="rounded bg-warn/15 px-1 text-2xs text-warn">{t("out of date")}</span>}
            </span>
            <span className="block truncate text-2xs font-normal text-dim">
              {x.params?.quality ? `${t(QUALITY_INFO[x.params.quality]?.label ?? x.params.quality)} · ` : ""}{ago(x.created_at)}{x.cost_usd ? ` · ${usd(x.cost_usd)}` : ""}
            </span>
          </span>
        </span>
      ),
    }));
  };

  const items: (CtxItem | false | null)[] = shot ? [
    { label: t("Regenerate video"), icon: <RefreshCw className="size-3.5" />, disabled: !canEdit,
      children: Object.entries(QUALITY_INFO).map(([k, q]) => ({ label: t(q.label), hint: q.price, active: shot.effective_quality === k,
        onClick: () => act("video", t("Video"), { quality: k }) })) },
    { label: t("Extend +7s"), icon: <Plus className="size-3.5" />, disabled: !canEdit || !v, onClick: () => { setText(shot.extend_prompt || ""); setDialog("extend"); } },
    { label: t("Fix mouth sync ({lang})", { lang: LANG_SHORT[lang] ?? lang }), icon: <AudioLines className="size-3.5" />, disabled: !canEdit || !v,
      onClick: () => act("lipsync", t("Mouth sync"), { language: lang }) },
    { label: t("Edit with words"), icon: <WandSparkles className="size-3.5" />, disabled: !canEdit || !v, onClick: () => { setText(""); setDialog("edit"); } },
    { label: t("Swap take"), icon: <ArrowLeftRight className="size-3.5" />, disabled: !canReview, hint: loaded && takeList.length ? String(takeList.length) : undefined,
      children: takeRows() },
    { label: t("Speed"), icon: <Gauge className="size-3.5" />, hint: `${speed}×`, disabled: !canEdit || clip?.kind === "still",
      children: [
        ...SPEED_PRESETS.map((s) => ({ label: `${s}×`, active: Math.abs(speed - s) < 1e-3, onClick: () => void onSpeed(shot, s) })),
        { label: t("Custom… (in the inspector)"), separator: true, onClick: () => onInspect(shot.id) },
      ] },
    stale.length > 0 && { label: stale.length > 1 ? t("Mark {n} takes fresh", { n: stale.length }) : t("Mark fresh"), icon: <Sparkles className="size-3.5" />,
      hint: stale[0].stale_reason ? <span className="max-w-[90px] truncate">{stale[0].stale_reason}</span> : undefined, disabled: !canReview, separator: true,
      onClick: () => void fresh(stale) },
    { label: approved ? t("Unapprove") : t("Approve"), icon: <CircleCheck className={clsx("size-3.5", approved && "text-ok")} />, disabled: !canReview,
      separator: !stale.length, active: approved, onClick: () => void approve(!approved) },
    { label: t("Open in storyboard"), icon: <LayoutGrid className="size-3.5" />, onClick: openStoryboard },
    { label: t("Remove from cut"), icon: <Trash2 className="size-3.5" />, danger: true, disabled: !canEdit, separator: true, onClick: () => void remove() },
  ] : [];

  return (
    <>
      <ContextMenu open={open} anchor={state?.anchor ?? null} onClose={onClose} items={items} width={264} returnFocus={state?.returnFocus}
        label={t("Clip actions for {code}", { code: shot?.code ?? "" })} />
      <Modal open={dialog === "edit"} onClose={() => setDialog(null)} title={t("Edit this clip with words")}
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!text.trim() || !v} loading={busy} onClick={() => void runDialog()}>{t("See the price")}</Button></>}>
        <Field label={t("What should change?")} hint={t("e.g. 'remove the extra person on the left', 'make it night', 'add light rain'. A new take is created; the old one is kept.")}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
      </Modal>
      <Modal open={dialog === "extend"} onClose={() => setDialog(null)} title={t("Extend this shot by 7 seconds")}
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy} disabled={!v} onClick={() => void runDialog()}>{t("Extend")}</Button></>}>
        <Field label={t("What happens next?")} hint={t("Extension works on 720p clips made in the last 2 days.")}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Ravi steps closer to the lamp; the flame bends towards him.")} autoFocus />
        </Field>
      </Modal>
    </>
  );
}
