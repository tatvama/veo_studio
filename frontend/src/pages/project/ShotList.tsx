import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Clapperboard, FileText, ListVideo, Lock, PenLine, Rocket, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ImportWizard } from "../../components/board/ImportWizard";
import { newScene, ShotListEditor, withKeys, type ShotPickerProps } from "../../components/board/ShotListEditor";
import { useGenerate } from "../../components/Generate";
import { LoadError, RoomHeader, RoomPage } from "../../components/room/kit";
import { Badge, Button, Modal, Select, Skeleton, Toggle } from "../../components/ui";
import { api } from "../../lib/api";
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
    return <RoomPage width="full"><Skeleton className="mb-4 h-16" />{[0, 1].map((i) => <Skeleton key={i} className="mb-4 h-64" />)}</RoomPage>;
  }

  const hasShots = board.scenes.some((s) => s.shots.length);
  const startWriting = () => edit([newScene(1)]);

  return (
    <RoomPage width="full">
      <RoomHeader icon={<ListVideo />} title={t("Shot list")}
        description={t("Your film, scene by scene: what we see, who is in it and who says what. Write it here or import your script, then produce everything in one go.")}
        status={dirty ? <Badge tone="warn">{t("Unsaved changes")}</Badge> : hasShots ? <Badge tone="ok">{t("Saved")}</Badge> : undefined}
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
        <div className="mx-auto grid max-w-3xl gap-4 py-6 sm:grid-cols-2">
          <StartCard icon={<FileText className="size-6" />} title={t("Import my script")} disabled={!canEdit}
            text={t("Word, PDF or pasted text, scene by scene with visuals and dialogue. You review every scene before anything is made.")}
            onClick={() => setImporting(true)} />
          <StartCard icon={<PenLine className="size-6" />} title={t("Build shot by shot")} disabled={!canEdit}
            text={t("Write each shot yourself: the prompt, the characters in it, who says which line, voice-over, length and extensions.")}
            onClick={startWriting} />
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-panel/80 px-3 py-2 text-xs text-mute">
            <span><b className="text-ink">{scenes.length}</b> {t("scenes")}</span>
            <span><b className="text-ink">{stats.shots}</b> {t("shots")}</span>
            <span><b className="text-ink">{stats.secs}s</b> {t("total")}</span>
            <span><b className="text-ink">{stats.lines}</b> {t("dialogue lines")}</span>
            <span><b className="text-ink">{stats.vo}</b> {t("voice-over lines")}</span>
            <span><b className="text-ink">{stats.videos}/{stats.shots}</b> {t("videos made")}</span>
            {stats.empty > 0 && <Badge tone="warn">{t("{n} shots have no prompt", { n: stats.empty })}</Badge>}
            <div className="flex-1" />
            {stats.videos > 0 && <Button size="sm" variant="ghost" icon={<Clapperboard className="size-3.5" />} onClick={() => nav(`/p/${project.id}/storyboard`)}>{t("See takes in Storyboard")}</Button>}
          </div>
          <div className="@container">
            {listLockedBy && (
              <p className="mb-3 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
                <Lock className="size-3.5 shrink-0" />
                {t("{name} is editing the shot list. You can look; editing opens up when they save or leave.", { name: listLockedBy })}
              </p>
            )}
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
          </div>
        </>
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

function StartCard({ icon, title, text, onClick, disabled }: { icon: ReactNode; title: string; text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="group flex flex-col items-start gap-3 rounded-2xl border border-line bg-panel p-5 text-left shadow-card transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lift disabled:pointer-events-none disabled:opacity-60">
      <span className="grid size-11 place-items-center rounded-xl bg-accent/12 text-accent-ink transition-transform group-hover:scale-105">{icon}</span>
      <span className="text-base font-semibold">{title}</span>
      <span className="text-sm leading-relaxed text-mute">{text}</span>
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
  const label: Record<string, [string, string]> = {
    keyframes: [t("Keyframes"), t("A still image per shot, using your characters' reference photos")],
    videos: [t("Videos"), t("Each shot animated from its keyframe")],
    extend: [t("Extensions"), t("Longer clips for shots with “Extend to”")],
    voices: [t("Voices & lip-sync"), t("Dialogue in each character's voice, lips matched; voice-over by the narrator")],
    music: [t("Music"), t("A score for the whole episode")],
    export: [t("Final export"), t("The finished video with captions")],
  };
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
        <ul className="space-y-1.5">
          {STEPS.map((s, i) => (
            <li key={s} className={clsx("flex items-start gap-3 rounded-lg border px-3 py-2 transition-colors", on[s] ? "border-accent/40 bg-accent/5" : "border-line")}>
              <span className="mt-0.5 w-4 text-right font-mono text-2xs text-dim">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{label[s][0]}</p>
                <p className="text-2xs text-dim">{label[s][1]}</p>
              </div>
              <Toggle checked={!!on[s]} onChange={(v) => setOn({ ...on, [s]: v })} />
            </li>
          ))}
        </ul>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">{t("Video quality")}</span>
          <Select value={quality} onChange={(e) => setQuality(e.target.value)} className="!w-56" aria-label={t("Video quality")}>
            <option value="">{t("Project default ({q})", { q: QUALITY_INFO[project.quality_mode]?.label ?? project.quality_mode })}</option>
            {Object.entries(QUALITY_INFO).map(([k, v]) => <option key={k} value={k}>{t(v.label)} · {v.price}</option>)}
          </Select>
        </label>
      </div>
    </Modal>
  );
}
