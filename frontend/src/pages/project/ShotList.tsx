import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Clapperboard, Eye, FileText, ListVideo, Lock, PenLine, Rocket, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ImportWizard } from "../../components/board/ImportWizard";
import { newScene, sceneAnchor, ShotListEditor, withKeys, type ShotPickerProps } from "../../components/board/ShotListEditor";
import { useGenerate } from "../../components/Generate";
import { Fact, LoadError, RoomHeader, RoomPage, SaveStatus, type SaveState } from "../../components/room/kit";
import { Outline, StatStrip, Workspace, pad, sceneCode, type OutlineItem } from "../../components/room/workspace";
import { Alert, Badge, Button, Meter, Modal, Select, Skeleton, Toggle } from "../../components/ui";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { QUALITY_INFO } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useEditLock, useLockHolder } from "../../lib/collab";
import { useBoard, useCharacters, useLocations, useVideoEngines } from "../../lib/queries";
import type { Board, BoardScene, Character } from "../../lib/types";
import { useProjectCtx } from "./context";

const STEPS = ["keyframes", "videos", "extend", "voices", "music", "export"] as const;

/** Clean copy for the API: no client keys, no read-only fields. */
function payload(scenes: BoardScene[], version?: string) {
  return {
    version,
    scenes: scenes.map((sc) => ({
      id: sc.id ?? null, title: sc.title, location: sc.location, time_of_day: sc.time_of_day, summary: sc.summary,
      shots: sc.shots.map((s) => ({
        id: s.id ?? null, prompt: s.prompt, characters: s.characters, duration_s: s.duration_s, extend_to: s.extend_to || 0,
        extend_prompt: s.extend_prompt, framing: s.framing, camera: s.camera, engine: s.engine || "auto",
        lines: s.lines.map((l) => ({ speaker: l.speaker, text: l.text, emotion: l.emotion })),
      })),
    })),
  };
}

export default function ShotListPage() {
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { project, eid, canEdit } = useProjectCtx();
  const [params, setParams] = useSearchParams();
  const { data: board, isLoading, isError, refetch } = useBoard(eid);
  const { data: projectCast } = useCharacters(project.id);
  const { data: library } = useCharacters();
  const { data: engines } = useVideoEngines();
  const { data: projectLocs } = useLocations(project.id);
  const { data: allLocs } = useLocations();
  const { generate } = useGenerate();
  const [scenes, setScenes] = useState<BoardScene[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(params.get("import") === "1");
  const [produce, setProduce] = useState(false);
  // team editing: the list is yours while it has unsaved edits; look-only while a teammate's is open
  const listLock = useEditLock(canEdit ? `board:${eid}` : null, dirty);
  const listHolder = useLockHolder(`board:${eid}`);
  const listLockedBy = listLock.held ? undefined : listHolder?.name ?? listLock.holder?.name;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // take the server's copy whenever we have no unsaved edits (keeps statuses fresh while jobs run)
  // the version our copy is based on (not the latest fetched one): saving with it can't overwrite newer changes
  const versionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (board && !dirtyRef.current) { setScenes(withKeys(board.scenes)); versionRef.current = board.version; }
  }, [board]);
  useEffect(() => {
    if (dirty) return;
    const h = window.setInterval(() => void refetch(), 20_000);
    return () => window.clearInterval(h);
  }, [dirty, refetch]);
  useEffect(() => {
    if (params.get("import") === "1") { params.delete("import"); setParams(params, { replace: true }); }
  }, []);

  const edit = (s: BoardScene[]) => { setScenes(s); setDirty(true); };

  const save = async (): Promise<Board | undefined> => {
    setSaving(true);
    try {
      const b = await api.put<Board>(`/api/episodes/${eid}/board`, payload(scenes, versionRef.current));
      qc.setQueryData(["board", eid], b);
      setScenes(withKeys(b.scenes));
      versionRef.current = b.version;
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["episode"] });
      qc.invalidateQueries({ queryKey: ["characters"] });
      return b;
    } catch { return undefined; } finally { setSaving(false); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirtyRef.current) void save(); }
    };
    const leave = (e: BeforeUnloadEvent) => { if (dirtyRef.current) e.preventDefault(); };
    window.addEventListener("keydown", h);
    window.addEventListener("beforeunload", leave);
    return () => { window.removeEventListener("keydown", h); window.removeEventListener("beforeunload", leave); };
  });

  // the project's cast, plus any library character a shot already uses (saving adds them to the cast)
  const cast = useMemo(() => {
    const out = [...(projectCast ?? [])];
    const have = new Set(out.map((c) => c.id));
    const used = new Set<number>();
    scenes.forEach((s) => s.shots.forEach((h) => {
      h.characters.forEach((c) => used.add(c));
      h.lines.forEach((l) => typeof l.speaker === "number" && used.add(l.speaker));
    }));
    (library ?? []).forEach((c) => { if (used.has(c.id) && !have.has(c.id)) out.push(c); });
    return out;
  }, [projectCast, library, scenes]);

  // pick characters from anywhere, make new ones on the spot, and choose each shot's video model
  const pickers: ShotPickerProps = useMemo(() => ({
    projectCast: projectCast ?? [], library: library ?? [], engines, quality: project.quality_mode,
    locations: [...new Set([...(projectLocs ?? []), ...(allLocs ?? [])].map((l) => l.name))],
    onCreateCharacter: async (name: string, photo: File | null) => {
      try {
        const ch = await api.post<Character>("/api/characters", { name, project_id: project.id });
        if (photo) {
          try { await api.upload(`/api/characters/${ch.id}/upload`, photo); } catch { /* the character exists; add the photo in Characters */ }
        }
        await qc.invalidateQueries({ queryKey: ["characters"] });
        toast.success(tr("{name} added to this project", { name }));
        return ch;
      } catch { return undefined; }
    },
  }), [projectCast, library, engines, project.quality_mode, project.id, projectLocs, allLocs, qc]);

  const stats = useMemo(() => {
    const shots = scenes.flatMap((s) => s.shots);
    return {
      shots: shots.length,
      secs: shots.reduce((a, s) => a + Math.max(s.extend_to || 0, s.duration_s), 0),
      lines: shots.reduce((a, s) => a + s.lines.filter((l) => l.speaker !== "VO").length, 0),
      vo: shots.reduce((a, s) => a + s.lines.filter((l) => l.speaker === "VO").length, 0),
      videos: shots.filter((s) => s.has_video).length,
      empty: shots.filter((s) => !s.prompt.trim()).length,
    };
  }, [scenes]);

  if (isError && !board) return <RoomPage width="full"><LoadError what={t("Couldn't load the shot list")} onRetry={() => refetch()} /></RoomPage>;
  if (isLoading || !board) {
    return (
      <RoomPage width="full">
        <div aria-busy="true">
          <Skeleton className="mb-5 h-12 w-72 max-w-full" />
          <Skeleton className="mb-4 h-24" />
          {[0, 1].map((i) => <Skeleton key={i} className="mb-4 h-64" />)}
        </div>
      </RoomPage>
    );
  }

  const hasShots = board.scenes.some((s) => s.shots.length);
  const startWriting = () => edit([newScene(1)]);
  const state: SaveState = saving ? "saving" : dirty ? "dirty" : "clean";

  // the outline rail: one anchor per scene, with its length and whether it still needs attention
  const outline: OutlineItem[] = scenes.map((sc, i) => {
    const secs = sc.shots.reduce((a, s) => a + Math.max(s.extend_to || 0, s.duration_s), 0);
    const missing = sc.shots.some((s) => !s.prompt.trim());
    const made = !!sc.shots.length && sc.shots.every((s) => s.has_video);
    return {
      id: sceneAnchor(sc, i), state: missing ? "warn" : made ? "done" : "none", meta: `${secs}s`,
      label: <span className="flex min-w-0 items-baseline gap-1.5"><span className="mono shrink-0 text-2xs text-dim">{sceneCode(i)}</span><span className="truncate">{sc.title || t("Scene {n}", { n: i + 1 })}</span></span>,
    };
  });

  return (
    <RoomPage width="full">
      <RoomHeader icon={<ListVideo />} title={t("Shot list")}
        description={t("Your film, scene by scene: what we see, who is in it and who says what. Write it here or import your script, then produce everything in one go.")}
        status={!canEdit ? <Fact icon={<Eye />}>{t("View only")}</Fact> : dirty || saving || hasShots ? <SaveStatus state={state} /> : undefined}
        actions={canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={<FileText className="size-4" />} onClick={() => setImporting(true)}>{t("Import script")}</Button>
            <Button variant={dirty ? "primary" : "secondary"} icon={<Save className="size-4" />} loading={saving} disabled={!dirty} onClick={() => void save()}>
              {t("Save")}
            </Button>
            <Button variant={dirty ? "secondary" : "primary"} icon={<Rocket className="size-4" />} disabled={!stats.shots} onClick={() => setProduce(true)}>
              {t("Produce all")}
            </Button>
          </div>
        )} />

      {!scenes.length ? (
        <div className="space-y-4">
          <div className="grid gap-4 @2xl:grid-cols-2">
            <StartCard index={1} tag="A" kicker={t("Import")} icon={<FileText className="size-5" />} title={t("Import my script")} disabled={!canEdit}
              text={t("Word, PDF or pasted text, scene by scene with visuals and dialogue. You review every scene before anything is made.")}
              onClick={() => setImporting(true)} />
            <StartCard index={2} tag="B" kicker={t("Build")} icon={<PenLine className="size-5" />} title={t("Build shot by shot")} disabled={!canEdit}
              text={t("Write each shot yourself: the prompt, the characters in it, who says which line, voice-over, length and extensions.")}
              onClick={startWriting} />
          </div>
          <PipelineStrip />
        </div>
      ) : (
        <div className="space-y-4">
          {listLockedBy && (
            <Alert tone="warn" icon={<Lock className="size-4" />}>
              {t("{name} is editing the shot list. You can look; editing opens up when they save or leave.", { name: listLockedBy })}
            </Alert>
          )}

          <StatStrip index={1} cells={[
            { key: "scenes", label: t("Scenes"), value: scenes.length },
            { key: "shots", label: t("Shots"), value: stats.shots },
            { key: "runtime", label: t("Runtime"), value: stats.secs, unit: "s", sub: stats.secs >= 60 ? <span className="mono">≈ {Math.floor(stats.secs / 60)}:{pad(stats.secs % 60)}</span> : undefined },
            { key: "dialogue", label: t("Dialogue"), value: stats.lines, sub: t("lines") },
            { key: "vo", label: t("Voice-over"), value: stats.vo, sub: t("lines") },
            {
              key: "videos", label: t("Videos made"), value: stats.videos, unit: `/ ${stats.shots}`, tone: stats.shots > 0 && stats.videos === stats.shots ? "ok" : "neutral", wide: true,
              visual: <Meter filled={bucket(stats.videos, stats.shots, 24)} total={Math.max(1, Math.min(stats.shots, 24))} tone={stats.videos === stats.shots ? "ok" : "accent"} />,
            },
          ]} aside={(stats.empty > 0 || stats.videos > 0) ? (
            <div className="flex h-full flex-col items-start justify-center gap-2">
              {stats.empty > 0 && (
                <Badge tone="warn" className="whitespace-normal text-left leading-snug"><AlertTriangle className="size-3 shrink-0" />{t("{n} shots have no prompt", { n: stats.empty })}</Badge>
              )}
              {stats.videos > 0 && (
                <Button size="sm" variant="ghost" className="-ml-2" icon={<Clapperboard className="size-3.5" />} onClick={() => nav(`/p/${project.id}/storyboard`)}>
                  {t("See takes in Storyboard")}
                </Button>
              )}
            </div>
          ) : undefined} />

          <Workspace rail={<Outline title={t("Scenes")} summary={`${scenes.length}`} items={outline} />}>
            <ShotListEditor scenes={scenes} onChange={edit} cast={cast} disabled={!canEdit || (!!listLockedBy && !dirty)} pickers={pickers}
              onMediaChanged={() => {
                // uploads don't touch the text fields: refresh thumbnails/references, keeping unsaved edits
                void refetch().then((r) => {
                  if (!r.data) return;
                  const media = new Map(r.data.scenes.flatMap((s) => s.shots).map((h) => [h.id, h]));
                  setScenes((cur) => cur.map((sc) => ({ ...sc, shots: sc.shots.map((h) => {
                    const m = h.id ? media.get(h.id) : undefined;
                    return m ? { ...h, thumb_url: m.thumb_url, keyframe_uploaded: m.keyframe_uploaded, ref_images: m.ref_images } : h;
                  }) })));
                });
              }} />
          </Workspace>
        </div>
      )}

      <ImportWizard open={importing} onClose={() => setImporting(false)} eid={eid} projectId={project.id} hasShots={hasShots}
        onDone={(b) => {
          qc.setQueryData(["board", eid], b);
          setScenes(withKeys(b.scenes));
          versionRef.current = b.version;
          setDirty(false);
          qc.invalidateQueries({ queryKey: ["characters"] });  // saving linked the script's characters to this project
        }} />
      <ProduceModal open={produce} onClose={() => setProduce(false)} dirty={dirty}
        onGo={async (steps, quality) => {
          if (dirty && !(await save())) return;
          setProduce(false);
          await generate(eid, { action: "produce", steps, quality: quality || null }, tr("Produce all"));
        }} />
    </RoomPage>
  );
}

/** `done` of `total` as cells of a `cells`-wide Meter (at least one lit while anything is done, so a start is visible). */
function bucket(done: number, total: number, cells: number) {
  if (!total || !done) return 0;
  return Math.max(1, Math.min(cells, Math.round((done / total) * Math.min(total, cells))));
}

/** The production steps, with what each does. Shared by the "Produce all" dialog and the empty state. */
function stepLabels(t: (s: string) => string): Record<(typeof STEPS)[number], [string, string]> {
  return {
    keyframes: [t("Keyframes"), t("A still image per shot, using your characters' reference photos")],
    videos: [t("Videos"), t("Each shot animated from its keyframe")],
    extend: [t("Extensions"), t("Longer clips for shots with “Extend to”")],
    voices: [t("Voices & lip-sync"), t("Dialogue in each character's voice, lips matched; voice-over by the narrator")],
    music: [t("Music"), t("A score for the whole episode")],
    export: [t("Final export"), t("The finished video with captions")],
  };
}

/** A hairline strip of what "Produce all" will do once the list exists. */
function PipelineStrip() {
  const t = useT();
  const label = stepLabels(t);
  return (
    <section className="hud relative min-w-0 rounded-xl border border-line bg-panel px-4 py-3.5">
      <p className="eyebrow mb-3">{t("Produce all")}</p>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-1">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-raised/50 px-2 text-xs text-mute">
              <span className="mono text-2xs text-dim">{pad(i + 1)}</span>{label[s][0]}
            </span>
            {i < STEPS.length - 1 && <ArrowRight aria-hidden className="size-3 text-dim" />}
          </li>
        ))}
      </ol>
    </section>
  );
}

function StartCard({ icon, title, text, onClick, disabled, tag, kicker, index }: {
  icon: ReactNode; title: string; text: string; onClick: () => void; disabled?: boolean; tag: string; kicker: string; index: number;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={{ "--i": index } as CSSProperties}
      className="hud group/start anim-rise relative flex min-w-0 flex-col items-start gap-3 rounded-xl border border-line bg-panel p-5 text-left transition-[border-color,background-color] hover:border-accent/50 hover:bg-hover/40 disabled:pointer-events-none disabled:opacity-60">
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-0 transition-opacity duration-300 group-hover/start:opacity-100" />
      <span className="eyebrow flex items-center gap-1.5"><span className="mono">{tag}</span><span aria-hidden className="opacity-50">/</span>{kicker}</span>
      <span className="hud grid size-11 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent-ink">{icon}</span>
      <span className="text-base font-semibold tracking-tight">{title}</span>
      <span className="text-sm leading-relaxed text-mute">{text}</span>
      <ArrowRight aria-hidden className="mt-1 size-4 text-dim transition-[transform,color] group-hover/start:translate-x-1 group-hover/start:text-accent-ink" />
    </button>
  );
}

function ProduceModal({ open, onClose, onGo, dirty }: {
  open: boolean; onClose: () => void; dirty: boolean; onGo: (steps: string[], quality: string) => Promise<void>;
}) {
  const t = useT();
  const { project } = useProjectCtx();
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(STEPS.map((s) => [s, true])));
  const [quality, setQuality] = useState("");
  const [busy, setBusy] = useState(false);
  const label = stepLabels(t);
  const steps = STEPS.filter((s) => on[s]);
  return (
    <Modal open={open} onClose={() => !busy && onClose()} size="md"
      title={<span className="flex items-center gap-2"><Rocket className="size-4 text-accent-ink" />{t("Produce all")}</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
        <Button variant="primary" loading={busy} disabled={!steps.length}
          onClick={async () => { setBusy(true); try { await onGo(steps, quality); } finally { setBusy(false); } }}>
          {dirty ? t("Save & see the cost") : t("See the cost")}
        </Button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm text-mute">{t("Runs the steps in order and only makes what's missing. You'll see the full cost before anything starts; the queue follows your API rate limits.")}</p>
        <div>
          <p className="eyebrow mb-2 flex items-center justify-between"><span>{t("Steps")}</span><span className="mono">{steps.length} / {STEPS.length}</span></p>
          <ol className="overflow-hidden rounded-xl border border-line">
            {STEPS.map((s, i) => (
              <li key={s} className={cn("flex items-start gap-3 border-b border-line px-3 py-2.5 transition-colors last:border-b-0", on[s] ? "bg-accent/5" : "")}>
                <span className={cn("mono mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border text-2xs font-semibold transition-colors",
                  on[s] ? "border-accent/40 bg-accent/10 text-accent-ink" : "border-line text-dim")}>{pad(i + 1)}</span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-medium", !on[s] && "text-mute")}>{label[s][0]}</p>
                  <p className="text-2xs leading-snug text-dim">{label[s][1]}</p>
                </div>
                <Toggle checked={!!on[s]} onChange={(v) => setOn({ ...on, [s]: v })} label={<span className="sr-only">{label[s][0]}</span>} />
              </li>
            ))}
          </ol>
        </div>
        <label className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm">
          <span className="font-medium">{t("Video quality")}</span>
          <Select value={quality} onChange={(e) => setQuality(e.target.value)} className="w-full sm:w-64" aria-label={t("Video quality")}>
            <option value="">{t("Project default ({q})", { q: QUALITY_INFO[project.quality_mode]?.label ?? project.quality_mode })}</option>
            {Object.entries(QUALITY_INFO).map(([k, v]) => <option key={k} value={k}>{t(v.label)} · {v.price}</option>)}
          </Select>
        </label>
      </div>
    </Modal>
  );
}
