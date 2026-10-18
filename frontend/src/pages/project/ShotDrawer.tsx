import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AudioLines, ChevronLeft, ChevronRight, CircleCheck, Ellipsis, FileText, Film, Image as ImageIcon, Lock, MessageSquare, Mic, Plus,
  SlidersHorizontal, Sparkles, Undo2, WandSparkles, X,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { EndFrameControls, FramePair } from "../../components/board/FramePair";
import { ShotRefs, UploadKeyframeButton } from "../../components/board/ShotMedia";
import { useGenerate } from "../../components/Generate";
import { QcChecklist } from "../../components/hub/Qc";
import ShootoutModal from "../../components/hub/ShootoutModal";
import { SaveStatus } from "../../components/room/kit";
import { useSaveShortcut } from "../../components/room/util";
import { Badge, Button, Field, IconButton, Menu, Modal, ScrollStrip, Skeleton, Tag, Textarea } from "../../components/ui";
import { api } from "../../lib/api";
import { estimateBatch, quote } from "../../lib/estimates";
import { LANG_SHORT, QUALITY_INFO } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useShot } from "../../lib/queries";
import type { DialogueLine, Estimate, Shot, SubmitResult, Take } from "../../lib/types";
import { FxEditor } from "../../components/fx/FxEditor";
import { useEditLock, useLockHolder } from "../../lib/collab";
import { useProjectCtx } from "./context";
import { RailSeg, fmtDur } from "./production/instruments";
import { LoadError } from "./production/LoadError";
import { MediaStage, stageWidth } from "./production/MediaStage";
import { QualityMenu } from "./production/QualityMenu";
import { Details } from "./production/ShotDetails";
import { Recovery } from "./production/Recovery";
import { Comments, PromptView } from "./production/ShotExtras";
import { ratioOf, shotStatusLabel } from "./production/shotMeta";
import { Takes } from "./production/ShotTakes";
import { KIND_LABELS, TakeInfo, TakeStrip } from "./production/ViewerPanel";

export { Comments };

type Tab = "details" | "takes" | "prompt" | "effects" | "comments";
type View = "final" | "video" | "keyframe" | "endframe";

const VISUAL = ["lipsync", "voicelock", "video", "keyframe", "endframe"];
const STILLS = ["keyframe", "endframe"];

/** A keyboard-key hint inside a button (inherits the button's colour). */
function Hint({ children }: { children: ReactNode }) {
  return <kbd className="mono ml-0.5 rounded border border-current/20 px-1 text-2xs leading-4 opacity-70">{children}</kbd>;
}

function pickForm(s: Shot): Partial<Shot> {
  return {
    duration_s: s.duration_s, framing: s.framing, camera: s.camera, action: s.action, characters: s.characters, outfits: s.outfits,
    location_id: s.location_id, dialogue: s.dialogue, narration: s.narration, sfx: s.sfx, music_cue: s.music_cue, mode: s.mode,
    quality_mode: s.quality_mode, voice_mode: s.voice_mode, continuity_from_prev: s.continuity_from_prev, include: s.include,
    trim_in: s.trim_in, trim_out: s.trim_out, notes: s.notes, end_note: s.end_note ?? "",
    // v3: props, Film Map continuity link (ShotDetails writes these into the form so the Save button sends them)
    ...({ prop_ids: (s as any).prop_ids ?? [], continuity_from_shot_id: (s as any).continuity_from_shot_id ?? null,
          continuity_mode: (s as any).continuity_mode ?? "last_frame" } as Partial<Shot>),
  };
}

export default function ShotDrawer({ shotId, onClose, onPrev, onNext, position, embedded }: {
  shotId: number; onClose: () => void; onPrev: () => void; onNext: () => void;
  /** Inside a Studio panel: fills the panel, no slide-in or scrim, and no single-key shortcuts (the timeline owns those). */
  embedded?: boolean;
  /** Where this shot sits in the storyboard (and whether the current filter leaves a shot before / after it). */
  position?: { index: number; total: number; hasPrev?: boolean; hasNext?: boolean };
}) {
  const t = useT();
  const { project, lang, canEdit, canReview } = useProjectCtx();
  const qc = useQueryClient();
  const { priced } = useGenerate();
  const { data: shot, isError, refetch } = useShot(shotId, lang);
  const [tab, setTab] = useState<Tab>("details");
  const [view, setView] = useState<View>("final");
  const [pinned, setPinned] = useState<number | null>(null);
  const [form, setForm] = useState<Partial<Shot>>({});
  const [quality, setQuality] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [shootoutOpen, setShootoutOpen] = useState(false);
  const [lipEngine, setLipEngine] = useState("auto");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // Edits save themselves (a moment after you stop typing), so what you see is what Retake and Video use.
  // `base` is the form as the server last had it: a server update replaces the form only while it holds no newer edits.
  const [formFor, setFormFor] = useState<number | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const base = useRef("");
  const serverForm = shot ? JSON.stringify(pickForm(shot)) : "";
  useEffect(() => {
    if (!shot) return;
    if (formFor !== shot.id || JSON.stringify(formRef.current) === base.current) {
      setForm(pickForm(shot));
      setFormFor(shot.id);
      base.current = serverForm;
    }
  }, [shot?.id, serverForm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setView("final"); setPinned(null); setLipEngine("auto");
    scroller.current?.scrollTo({ top: 0 });
  }, [shotId]);

  const refresh = () => { qc.invalidateQueries({ queryKey: ["shot", shotId] }); qc.invalidateQueries({ queryKey: ["episode"] }); };
  // (the form is seeded from the shot in an effect, so don't call it "unsaved" in the one render before that)
  const dirty = !!shot && formFor === shot.id && serverForm !== JSON.stringify(form);
  // team editing: hold this shot while you have unsaved changes; look-only while a teammate holds it (or the list)
  const othersLock = useLockHolder(`shot:${shotId}`, shot ? `board:${shot.episode_id}` : null);
  const myLock = useEditLock(canEdit ? `shot:${shotId}` : null, dirty);
  const lockedBy = myLock.held ? undefined : othersLock?.name ?? myLock.holder?.name;
  const canChange = canEdit && !lockedBy;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); } catch { /* api() showed the error */ } finally { setBusy(null); }
  };

  /** Saves the edits now (one save at a time). False when the save failed (api() showed why). */
  const inFlight = useRef<Promise<boolean> | null>(null);
  const saveNow = async (): Promise<boolean> => {
    while (inFlight.current) await inFlight.current;
    const body = formRef.current;
    const json = JSON.stringify(body);
    if (json === base.current) return true;
    setSaving(true);
    const p = api.patch(`/api/shots/${shotId}`, body).then(() => {
      base.current = json;
      setJustSaved(true);
      qc.invalidateQueries({ queryKey: ["shot", shotId] });
      qc.invalidateQueries({ queryKey: ["episode"] });
      return true;
    }, () => false);
    inFlight.current = p;
    try { return await p; } finally { inFlight.current = null; setSaving(false); }
  };
  useEffect(() => {
    if (!dirty || !canChange) return;
    const id = window.setTimeout(() => void saveNow(), 1200);
    return () => window.clearTimeout(id);
  }, [dirty, canChange, JSON.stringify(form)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!justSaved) return;
    const id = window.setTimeout(() => setJustSaved(false), 2000);
    return () => window.clearTimeout(id);
  }, [justSaved]);
  useSaveShortcut(canChange && dirty, () => void saveNow());
  // Moving to another shot (or closing) before the save timer fired: send the edits of the shot being left.
  const leaving = useRef<{ sid: number; body: Partial<Shot> } | null>(null);
  useEffect(() => { leaving.current = dirty && canChange && JSON.stringify(form) !== base.current ? { sid: shotId, body: form } : null; });
  useEffect(() => () => {
    const l = leaving.current;
    if (!l) return;
    void api.patch(`/api/shots/${l.sid}`, l.body).then(() => {
      qc.invalidateQueries({ queryKey: ["shot", l.sid] });
      qc.invalidateQueries({ queryKey: ["episode"] });
    }, () => { /* api() showed the error */ });
  }, [shotId]); // eslint-disable-line react-hooks/exhaustive-deps

  const undo = () => run("undo", async () => {
    await api.post(`/api/shots/${shotId}/undo`);
    base.current = "";  // take the server's copy back in
    refresh();
    toast.success(tr("Undone"));
  });
  /**
   * A paid action on this shot: its unsaved edits are saved first (the prompt is built from the saved shot), then the
   * price is shown before anything is spent (a free one just runs).
   */
  const act = (key: string, what: string, price: () => Promise<Estimate>, path: string, body: Record<string, any> = {}) =>
    run(key, async () => {
      if (dirty && !(await saveNow())) return;
      return priced({ quote: price, run: () => api.post<SubmitResult>(path, body), what: `${what} ${shot?.code ?? ""}`.trim() });
    });
  const batch = (action: string, extra: Record<string, unknown> = {}) => () =>
    estimateBatch(shot?.episode_id ?? 0, { action, shot_ids: [shotId], ...extra });
  const makePicture = () => act("keyframe", t("Picture"), batch("keyframes"), `/api/shots/${shotId}/keyframe`);
  const makeVideo = () => act("video", shot?.video ? t("Retake") : t("Video"), batch("videos", { quality: quality || undefined }),
    `/api/shots/${shotId}/video`, { quality: quality || undefined });
  const lipBody = () => ({ language: lang, model: lipEngine !== "auto" ? lipEngine : undefined });
  const approve = () => run("approve", async () => {
    const on = shot?.status !== "approved";
    await api.post(`/api/shots/${shotId}/approve`, { approved: on });
    refresh();
    toast.success(on ? tr("{code} approved", { code: shot?.code ?? "" }) : tr("{code} approval removed", { code: shot?.code ?? "" }));
  });

  // shortcuts inside the drawer: only A (approve, free). Nothing that spends money sits on a single key.
  useEffect(() => {
    if (embedded) return;
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector("[role=dialog], .fixed.inset-0.z-50")) return; // a modal is open
      if (e.key.toLowerCase() === "a" && canReview) approve();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [shotId, shot?.status, canReview, embedded]); // eslint-disable-line react-hooks/exhaustive-deps

  const frame = (children: ReactNode) => embedded ? (
    <div aria-label={t("Shot details")} className="@container relative flex h-full w-full flex-col bg-panel">{children}</div>
  ) : (
    <>
      {/* up to laptop widths (1440 px) the drawer floats over the grid, so dim it and let a click on the dimmed part close it;
          on wider screens it sits beside the grid */}
      <motion.div key="scrim" aria-hidden onClick={onClose}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
        className="absolute inset-0 z-20 bg-black/45 @min-[90rem]:hidden" />
      <motion.aside
        key="drawer" aria-label={t("Shot details")}
        initial={{ x: 44, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
        exit={{ x: 44, opacity: 0, transition: { duration: 0.16, ease: "easeIn" } }}
        transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.8 }}
        className="@container absolute inset-y-0 right-0 z-30 flex w-[min(100%,480px)] flex-col border-l border-line bg-panel shadow-modal @min-[90rem]:static @min-[90rem]:z-auto @min-[90rem]:w-[480px] @min-[90rem]:shrink-0 @min-[90rem]:shadow-none"
      >
        {children}
      </motion.aside>
    </>
  );

  if (!shot) return frame(<DrawerSkeleton onClose={onClose} error={isError} onRetry={() => void refetch()} />);

  const approved = shot.status === "approved";
  const langShort = LANG_SHORT[lang] ?? lang;
  const lines = (form.dialogue?.[lang] ?? []) as DialogueLine[];
  const hasLines = (shot.dialogue?.[lang]?.length ?? 0) > 0;
  const takes = shot.takes ?? [];
  const finalTake = shot.lipsync || shot.voicelock || shot.video;
  const pinnedTake = pinned != null ? takes.find((x) => x.id === pinned) ?? null : null;
  const media: Take | null = pinnedTake ?? (view === "final" ? finalTake : view === "video" ? shot.video
    : view === "endframe" ? shot.endframe ?? null : shot.keyframe);
  const stageKind = media ? (STILLS.includes(media.kind) ? "image" : "video") : shot.keyframe ? "image" : "empty";
  const stageSrc = media ? media.url : shot.keyframe?.url;
  // short on purpose: a portrait stage is narrow, and the details sit in the take card beside it
  const stageLabel = pinnedTake ? `${t(KIND_LABELS[pinnedTake.kind] ?? pinnedTake.kind)} #${pinnedTake.id}`
    : view === "keyframe" ? t("Start frame") : view === "endframe" ? t("End frame") : view === "video" ? t("Raw video")
    : shot.video || shot.lipsync || shot.voicelock ? t("Final") : undefined;
  // QC lives on the raw video; the lip-sync score on the lip-sync take
  const qcBase = pinnedTake ? (pinnedTake.kind === "video" ? pinnedTake : pinnedTake.kind === "lipsync" || pinnedTake.kind === "voicelock" ? shot.video : null)
    : view === "keyframe" || view === "endframe" ? null : shot.video;
  const qcLip = pinnedTake ? (pinnedTake.kind === "lipsync" ? pinnedTake : null) : view === "final" ? shot.lipsync : null;
  const rr = ratioOf(project.aspect);
  const side = rr.w / rr.h <= 0.85;
  const atStart = !!position && (position.hasPrev === undefined ? position.index <= 0 : !position.hasPrev);
  const atEnd = !!position && (position.hasNext === undefined ? position.index >= position.total - 1 : !position.hasNext);

  const stage = (
    <MediaStage id={`${shot.id}-${media?.id ?? 0}-${stageKind}`} kind={stageKind} src={stageSrc} poster={media?.thumb_url || shot.keyframe?.url}
      aspect={project.aspect} label={stageLabel} />
  );
  const viewSwitch = <ViewSwitch view={view} onChange={(v) => { setView(v); setPinned(null); }} pinned={pinned != null} hasEnd={!!shot.endframe} />;
  // start → end frame, and the link to the end frame before (shown once the shot uses either)
  const framesRow = shot.endframe || shot.frames_link || shot.end_note ? (
    <FramePair shot={shot} aspect={project.aspect} viewing={pinned == null && (view === "keyframe" || view === "endframe") ? view : null}
      onView={(w) => { setView(w); setPinned(null); }} />
  ) : null;
  const qcBlock = qcBase || qcLip ? <QcChecklist take={qcBase} lipTake={qcLip} compact /> : null;
  const strip = (
    <TakeStrip takes={takes.filter((x) => VISUAL.includes(x.kind))} active={pinned} aspect={project.aspect}
      onPick={(x) => setPinned(pinned === x.id ? null : x.id)} />
  );
  // portrait / square clips leave room beside the viewer, so the take details sit there; wide clips get the full width
  const viewer = side ? (
    <div className="grid gap-3 @md:grid-cols-[auto_minmax(0,1fr)]">
      <div style={{ width: stageWidth(project.aspect) }} className="mx-auto max-w-full @md:mx-0">{stage}</div>
      <div className="min-w-0 space-y-2.5">{viewSwitch}<TakeInfo take={media} />{qcBlock}</div>
      <div className="min-w-0 @md:col-span-2">{strip}</div>
      {framesRow && <div className="min-w-0 @md:col-span-2">{framesRow}</div>}
    </div>
  ) : (
    <div className="grid gap-3 @md:grid-cols-2">
      <div className="@md:col-span-2">{stage}</div>
      <div className="min-w-0 space-y-2.5">{viewSwitch}<TakeInfo take={media} /></div>
      <div className="min-w-0">{qcBlock}</div>
      <div className="min-w-0 @md:col-span-2">{strip}</div>
      {framesRow && <div className="min-w-0 @md:col-span-2">{framesRow}</div>}
    </div>
  );

  return frame(
    <>
      {/* header: step through the shots, the code in mono, where the shot stands */}
      <header className="relative shrink-0 border-b border-line bg-panel">
        <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-80" />
        <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-2">
          <div className="flex shrink-0 items-center rounded-lg border border-line bg-raised/50">
            <IconButton title={t("Previous shot (←)")} onClick={onPrev} disabled={atStart} className="!size-7 rounded-r-none"><ChevronLeft className="size-4" /></IconButton>
            {position && <span className="mono min-w-[3.25rem] px-1 text-center text-2xs tabular-nums text-mute">{position.index + 1}<span className="text-dim">/{position.total}</span></span>}
            <IconButton title={t("Next shot (→)")} onClick={onNext} disabled={atEnd} className="!size-7 rounded-l-none"><ChevronRight className="size-4" /></IconButton>
          </div>
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{t("Shot")}</p>
            <h2 className="mono truncate text-[0.95rem] font-semibold leading-tight tracking-wide">{shot.code}</h2>
          </div>
          {shot.generating && (
            <span className="mono inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-1 text-2xs font-medium text-accent-ink">
              <span className="eq" aria-hidden><i /><i /><i /><i /></span>{t("generating…")}
            </span>
          )}
          <Badge tone={approved ? "ok" : "neutral"} dot>{shotStatusLabel(t, shot.status)}</Badge>
          <IconButton title={t("Close (Esc)")} onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          <Tag k={t("Length")}>{fmtDur(shot.duration_s)}</Tag>
          <Tag k={t("Ratio")}>{project.aspect}</Tag>
          <Tag k={t("Quality")}>{t(QUALITY_INFO[shot.effective_quality]?.label ?? shot.effective_quality)}</Tag>
          <Tag k={t("Takes")}>{takes.length}</Tag>
        </div>
      </header>
      {lockedBy && (
        <p className="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <Lock className="size-3.5 shrink-0" />
          {t("{name} is editing this shot. You can look; editing opens up when they finish.", { name: lockedBy })}
        </p>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* the monitor */}
        <div className="border-b border-line bg-gradient-to-b from-raised/40 to-transparent p-3">{viewer}</div>

        {canChange && (
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-b border-line bg-raised/25 px-3 py-2.5">
            {/* picture → video (one primary action at a time: the video while there is none, then Approve). Every button that
                spends money shows its price first; edits are saved before a retake, so it uses what you wrote. */}
            <div className="space-y-1.5">
              <p className="eyebrow">{t("Picture")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" icon={<ImageIcon className="size-3.5" />} loading={busy === "keyframe"} onClick={makePicture}
                  title={t("Make the start picture (you see the price first)")}>
                  {shot.keyframe ? t("New picture") : t("Picture")}
                </Button>
                <UploadKeyframeButton shotId={shot.id} label={t("Upload")} onDone={refresh} />
                <EndFrameControls shot={shot} onDone={refresh} />
                <div className="inline-flex">
                  <Button size="sm" variant={shot.video ? "secondary" : "primary"} className="rounded-r-none" icon={<Film className="size-3.5" />} loading={busy === "video"}
                    onClick={makeVideo} title={shot.video ? t("Make a new take with your latest edits (you see the price first)") : t("Make the video (you see the price first)")}>
                    {shot.video ? t("Retake") : t("Video")}
                  </Button>
                  <QualityMenu joined tone={shot.video ? "secondary" : "primary"} value={quality} onChange={setQuality} defaultKey={shot.effective_quality} defaultLabel={t("This shot's default")} />
                </div>
              </div>
            </div>
            {/* sound: voice → mouth sync read as one pipeline, so they sit in one joined group; "more" closes the row */}
            {(hasLines || !!shot.narration?.[lang] || !!shot.video) && <div className="space-y-1.5">
              <p className="eyebrow">{t("Sound")}</p>
              <div className="flex items-center gap-2">
                {(hasLines || shot.narration?.[lang]) && (
                  <div className="inline-flex">
                    <Button size="sm" className={clsx(shot.video && hasLines && "rounded-r-none")} icon={<Mic className="size-3.5" />} loading={busy === "voice"}
                      onClick={() => act("voice", t("Voice"), batch("voices", { language: lang }), `/api/shots/${shotId}/voice`, { language: lang })}>
                      {t("Voice {lang}", { lang: langShort })}
                    </Button>
                    {shot.video && hasLines && (
                      <Button size="sm" className="-ml-px rounded-l-none" icon={<AudioLines className="size-3.5" />} loading={busy === "lipsync"}
                        onClick={() => act("lipsync", t("Mouth sync"), batch("lipsync", lipBody()), `/api/shots/${shotId}/lipsync`, lipBody())}>
                        {t("Mouth sync {lang}", { lang: langShort })}
                      </Button>
                    )}
                  </div>
                )}
                {shot.video && (
                  <Menu width={268} items={[
                    { icon: <Plus className="size-4" />, label: t("Extend +7s"), onClick: () => setExtendOpen(true) },
                    { icon: <WandSparkles className="size-4" />, label: t("Edit with words"), onClick: () => setEditOpen(true) },
                    shot.dialogue?.[project.primary_language]?.length ? {
                      icon: <Mic className="size-4" />, label: t("Voice lock"), separator: true,
                      onClick: () => void act("voicelock", t("Voice lock"), batch("voicelock"), `/api/shots/${shotId}/voicelock`),
                    } : null,
                  ]} trigger={(p) => (
                    <IconButton title={t("More actions")} {...p} disabled={busy === "voicelock" || busy === "extend"}>
                      <Ellipsis className="size-4" />
                    </IconButton>
                  )} />
                )}
              </div>
            </div>}
          </div>
        )}
        {/* the last video failed (a safety filter, or anything else): try another engine (shown on every tab) */}
        {(shot.blocked || shot.failed) && <div className="border-b border-line px-3 py-2.5"><Recovery shot={shot} canEdit={canChange} /></div>}
        {/* the shot's own references: what the keyframe and video must follow besides the characters */}
        {(canEdit || (shot.ref_images?.length ?? 0) > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5">
            <div className="min-w-0 flex-1 basis-40">
              <p className="eyebrow">{t("This shot's references")}</p>
              <p className="mt-1.5 text-2xs leading-snug text-dim">{t("A product, a prop or a look to match. Characters' photos are added automatically.")}</p>
            </div>
            <ShotRefs shotId={shot.id} refs={shot.ref_images ?? []} canEdit={canChange} onChanged={refresh} compact />
          </div>
        )}

        {/* the inspector's tabs: a compact segmented rail with counts */}
        <div className="sticky top-0 z-10 border-b border-line bg-panel/95 px-3 py-2 backdrop-blur">
          <ScrollStrip>
            <RailSeg kind="tab" grow value={tab} onChange={setTab} label={t("Shot details")} className="min-w-max" options={[
              { value: "details", label: t("Details"), icon: <SlidersHorizontal /> },
              { value: "takes", label: t("Takes"), icon: <Film />, count: takes.length },
              { value: "prompt", label: t("Prompt"), icon: <FileText /> },
              { value: "effects", label: t("Effects"), icon: <Sparkles />, count: Object.keys(shot.fx ?? {}).length || undefined },
              { value: "comments", label: t("Comments"), icon: <MessageSquare />, count: shot.comments || undefined },
            ]} />
          </ScrollStrip>
        </div>

        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: "easeOut" }} className="p-3">
          {tab === "details" && (formFor === shot.id ? (
            <Details shot={shot} form={form} setForm={setForm} lang={lang} lines={lines} disabled={!canChange} hasLines={hasLines}
              lipEngine={lipEngine} setLipEngine={setLipEngine} onShootout={() => setShootoutOpen(true)} />
          ) : (
            <div className="space-y-3" aria-busy="true"><Skeleton className="h-40 rounded-xl" /><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></div>
          ))}
          {tab === "takes" && (
            <Takes shot={shot} canEdit={canEdit} canReview={canReview} refresh={refresh} aspect={project.aspect} onShootout={() => setShootoutOpen(true)}
              viewing={pinned} onView={(x) => { setPinned(x.id); scroller.current?.scrollTo({ top: 0, behavior: "smooth" }); }} />
          )}
          {tab === "prompt" && <PromptView shotId={shotId} lang={lang} />}
          {tab === "effects" && <div className="-m-3 h-[70vh]"><FxEditor shotId={shotId} /></div>}
          {tab === "comments" && <Comments projectId={project.id} shotId={shotId} />}
        </motion.div>
      </div>

      {/* sticky footer: undo on the left, the commit actions on the right */}
      <footer className="relative flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-panel px-3 py-2.5">
        <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-60" />
        {canEdit && (
          <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} loading={busy === "undo"} onClick={undo} title={t("Put back the shot as it was before the last saved change")}>
            <span className="hidden @sm:inline">{t("Undo last change")}</span><span className="@sm:hidden">{t("Undo")}</span>
          </Button>
        )}
        <div className="min-w-0 flex-1 text-right">
          {/* edits save themselves; this says where they stand */}
          {canChange && formFor === shot.id && <SaveStatus state={saving ? "saving" : dirty ? "dirty" : justSaved ? "saved" : "clean"} />}
        </div>
        {canReview && (
          <Button size="sm" variant={approved || dirty || !shot.video ? "secondary" : "primary"} icon={<CircleCheck className={clsx("size-3.5", approved && "text-ok")} />}
            loading={busy === "approve"} onClick={approve}>
            {approved ? t("Approved") : t("Approve")}<Hint>A</Hint>
          </Button>
        )}
      </footer>

      <ShootoutModal shot={shot} open={shootoutOpen} onClose={() => setShootoutOpen(false)} onStarted={() => setTab("takes")} />
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={t("Edit this clip with words")}
        footer={<><Button variant="ghost" onClick={() => setEditOpen(false)}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!text.trim() || !shot.video} loading={busy === "edit"} onClick={() => run("edit", async () => {
            const take = shot.video!.id;
            const r = await priced({ quote: () => quote({ action: "edit", take_id: take, instruction: text }),
              run: () => api.post<SubmitResult>(`/api/takes/${take}/edit`, { instruction: text }), what: tr("Edit with words") });
            if (r) { setEditOpen(false); setText(""); }
          })}>{t("See the price")}</Button></>}>
        <Field label={t("What should change?")} hint={t("e.g. 'remove the extra person on the left', 'make it night', 'add light rain'. A new take is created; the old one is kept.")}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
      </Modal>
      <Modal open={extendOpen} onClose={() => setExtendOpen(false)} title={t("Extend this shot by 7 seconds")}
        footer={<><Button variant="ghost" onClick={() => setExtendOpen(false)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy === "extend"} onClick={async () => {
            await act("extend", t("Extend"), () => quote({ action: "extend", shot_id: shotId, prompt: text }), `/api/shots/${shotId}/extend`, { prompt: text });
            setExtendOpen(false); setText("");
          }}>{t("See the price")}</Button></>}>
        <Field label={t("What happens next?")} hint={t("Extension works on 720p clips made in the last 2 days.")}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Ravi steps closer to the lamp; the flame bends towards him.")} autoFocus />
        </Field>
      </Modal>
    </>,
  );
}

/** Final / raw clip / keyframe switch for the viewer (no segment is lit while a specific take is being previewed). */
function ViewSwitch({ view, onChange, pinned, hasEnd }: { view: View; onChange: (v: View) => void; pinned: boolean; hasEnd: boolean }) {
  const t = useT();
  return (
    <RailSeg grow size="sm" label={t("What to show")} value={(pinned ? "" : view) as View} onChange={onChange} options={[
      { value: "final", label: t("Final") }, { value: "video", label: t("Raw video") },
      { value: "keyframe", label: hasEnd ? t("Start") : t("Picture") },
      ...(hasEnd ? [{ value: "endframe" as const, label: t("End") }] : []),
    ]} />
  );
}

function DrawerSkeleton({ onClose, error, onRetry }: { onClose: () => void; error?: boolean; onRetry: () => void }) {
  const t = useT();
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        {error ? <h2 className="eyebrow px-1">{t("Shot details")}</h2> : <><Skeleton className="h-7 w-24" /><Skeleton className="h-8 w-28" /></>}
        <div className="flex-1" />
        <IconButton title={t("Close (Esc)")} onClick={onClose}><X className="size-4" /></IconButton>
      </header>
      {error ? <LoadError compact what={t("this shot")} onRetry={onRetry} /> : (
      <div className="flex-1 space-y-4 overflow-hidden p-3" aria-busy="true">
        <div className="grid grid-cols-[auto_1fr] gap-3"><Skeleton className="h-64 w-36" /><div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /></div></div>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
      )}
    </>
  );
}
