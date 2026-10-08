import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AudioLines, Copy, Diamond, Eye, EyeOff, Film, ImageIcon, Layers as LayersIcon, Loader2, Music2, Plus, Trash2, Upload, Volume2, VolumeX } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { toast } from "sonner";
import { formatTC, useClockThrottled, type Clock } from "../../../../components/review/utils";
import { usePeaks, type WaveSeg } from "../../../../components/review/Waveform";
import { Button, Field, IconButton, Input, Popover, Toggle, Tooltip } from "../../../../components/ui";
import { api, ApiError } from "../../../../lib/api";
import { tr, useT } from "../../../../lib/i18n";
import { KF_DEFAULT, KF_KEYS, MAX_KEYFRAMES, normalizeKf, stateAt, type KfKey, type Keyframe } from "./keyframes";
import { FPS, LABEL_W, TRACK_H, type Holds } from "./shared";
import type { Transport } from "./transport";
import { WaveLane } from "./Tracks";

// ── data ─────────────────────────────────────────────────────────────────────
export type MediaKind = "video" | "audio" | "image";
export interface LayerClip {
  id: string; src: string; url?: string; kind: MediaKind; name: string; start: number; in: number; dur: number;
  x?: number; y?: number; scale?: number; opacity?: number; rotation?: number; fade_in: number; fade_out: number; gain_db: number; muted?: boolean;
  /** Animation: `t` seconds from the clip's start; linear between keyframes (see keyframes.ts). */
  keyframes?: Keyframe[];
}
export interface LayerTrack { id: string; name: string; muted: boolean; hidden: boolean; gain_db: number; clips: LayerClip[] }
export interface MediaItem { src: string; kind: MediaKind; name: string; duration: number; url: string; thumb_url: string }
/** `holds`: freezes after main-track shots ({shot id: seconds}) — stored with the layers because they're timeline data. */
export interface LayersDoc { rev: number; video: LayerTrack[]; audio: LayerTrack[]; media: MediaItem[]; holds?: Holds }
export type LayerSel = { track: "video" | "audio"; trackId: string; clipId: string } | null;

const uid = () => Math.random().toString(36).slice(2, 12);

/** The episode's layers with a local draft that saves itself (rev-checked: a teammate's newer save wins and reloads). */
export function useLayersEditor(eid: number) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["layers", eid], queryFn: () => api.get<LayersDoc>(`/api/episodes/${eid}/layers`), enabled: !!eid });
  const [draft, setDraft] = useState<LayersDoc | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef<number | null>(null);
  const dirty = useRef(false);
  const latest = useRef<LayersDoc | null>(null);
  useEffect(() => { if (data && !dirty.current) { setDraft(data); latest.current = data; } else if (data && latest.current) latest.current = { ...latest.current, media: data.media }; }, [data]);

  const save = async () => {
    const d = latest.current;
    if (!d) return;
    setSaving(true);
    try {
      const r = await api.put<LayersDoc>(`/api/episodes/${eid}/layers`, { rev: d.rev, video: d.video, audio: d.audio, holds: d.holds ?? {} });
      if (latest.current === d) { dirty.current = false; latest.current = r; setDraft(r); } else latest.current = { ...latest.current!, rev: r.rev };
      qc.setQueryData(["layers", eid], r);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) {  // a teammate saved first: take theirs
        dirty.current = false;
        await qc.invalidateQueries({ queryKey: ["layers", eid] });
      }
    } finally { setSaving(false); }
  };
  const edit = (fn: (d: LayersDoc) => LayersDoc) => {
    const base = latest.current ?? draft;
    if (!base) return;
    const next = fn(base);
    latest.current = next;
    dirty.current = true;
    setDraft(next);
    if (pending.current) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => void save(), 600);
  };
  const upload = async (file: File): Promise<MediaItem | undefined> => {
    try {
      const m = await api.upload<MediaItem>(`/api/episodes/${eid}/media`, file);
      latest.current = latest.current ? { ...latest.current, media: [...latest.current.media, m] } : latest.current;
      setDraft((d) => (d ? { ...d, media: [...d.media, m] } : d));
      qc.invalidateQueries({ queryKey: ["layers", eid] });
      return m;
    } catch { return undefined; }
  };
  return { layers: draft, edit, upload, saving };
}

export const urlOf = (doc: LayersDoc | null, src: string) => doc?.media.find((m) => m.src === src)?.url ?? "";

// ── tracks ───────────────────────────────────────────────────────────────────
function dragX(e: RPointerEvent, cursor: string, onMove: (dx: number) => void, onEnd: (dx: number) => void) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  let dx = 0;
  const move = (ev: PointerEvent) => { dx = ev.clientX - x0; onMove(dx); };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.cursor = ""; onEnd(dx); };
  document.body.style.cursor = cursor;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function LayerTrackRow({ kind, track, index, doc, pps, view, canEdit, sel, onSelect, edit, upload, playhead, snapTime }: {
  kind: "video" | "audio"; track: LayerTrack; index: number; doc: LayersDoc; pps: number; view: { left: number; width: number };
  canEdit: boolean; sel: LayerSel; onSelect: (s: LayerSel) => void; edit: (fn: (d: LayersDoc) => LayersDoc) => void;
  upload: (f: File) => Promise<MediaItem | undefined>; playhead: () => number; snapTime: (t: number) => number;
}) {
  const t = useT();
  const addRef = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState<{ id: string; start: number; in: number; dur: number } | null>(null);
  const peaks = usePeaks(kind === "audio" ? track.clips.map((c) => urlOf(doc, c.src)) : []);

  const setTrack = (fn: (t: LayerTrack) => LayerTrack) => edit((d) => ({ ...d, [kind]: d[kind].map((x) => (x.id === track.id ? fn(x) : x)) }));
  const setClip = (id: string, patch: Partial<LayerClip>) => setTrack((x) => ({ ...x, clips: x.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const fits = (m: MediaItem) => (kind === "video" ? m.kind === "video" || m.kind === "image" : m.kind === "audio" || m.kind === "video");
  const place = (m: MediaItem) => {
    const c: LayerClip = { id: uid(), src: m.src, kind: m.kind, name: m.name, start: Math.round(playhead() * 100) / 100, in: 0,
      dur: m.kind === "image" ? 3 : Math.max(m.duration, 0.1), fade_in: 0, fade_out: 0, gain_db: 0,
      ...(kind === "video" ? { x: 0.75, y: 0.25, scale: m.kind === "image" ? 0.2 : 0.35, opacity: 1, muted: m.kind === "image" } : {}) };
    setTrack((x) => ({ ...x, clips: [...x.clips, c] }));
    onSelect({ track: kind, trackId: track.id, clipId: c.id });
    setAdding(false);
  };
  const onFile = async (f: File) => {
    setBusy(true);
    const m = await upload(f);
    setBusy(false);
    if (m && fits(m)) place(m);
    else if (m) toast.message(tr("Added to the media list — it doesn't go on this kind of layer"));
  };

  const segs: WaveSeg[] = kind === "audio" ? track.clips.flatMap((c) => {
    const d = peaks[urlOf(doc, c.src)];
    const cc = drag?.id === c.id ? { ...c, ...drag } : c;
    return d ? [{ start: cc.start, dur: cc.dur, data: d, offset: cc.in }] : [];
  }) : [];

  const clipDrag = (c: LayerClip, mode: "move" | "in" | "out") => (e: RPointerEvent) => {
    if (!canEdit) return;
    onSelect({ track: kind, trackId: track.id, clipId: c.id });
    const media = doc.media.find((m) => m.src === c.src);
    const maxLen = c.kind === "image" ? 3600 : media?.duration || c.in + c.dur;
    const calc = (dx: number) => {
      const s = dx / pps;
      if (mode === "move") return { start: Math.max(0, snapTime(c.start + s)), in: c.in, dur: c.dur };
      if (mode === "in") {
        const d = Math.max(-c.in, Math.min(s, c.dur - 0.2));
        return { start: Math.max(0, c.start + d), in: c.kind === "image" ? 0 : c.in + d, dur: c.dur - d };
      }
      return { start: c.start, in: c.in, dur: Math.max(0.2, Math.min(c.dur + s, maxLen - c.in)) };
    };
    dragX(e, mode === "move" ? "grabbing" : "ew-resize", (dx) => setDrag({ id: c.id, ...calc(dx) }), (dx) => {
      setDrag(null);
      if (Math.abs(dx) > 1) {
        const v = calc(dx);
        setClip(c.id, { start: Math.round(v.start * 100) / 100, in: Math.round(v.in * 100) / 100, dur: Math.round(v.dur * 100) / 100 });
      }
    });
  };

  const tone = kind === "video" ? "border-violet-400/60 bg-violet-500/25 text-violet-100" : "border-sky-400/60 bg-sky-500/20 text-sky-100";
  return (
    <div className="flex border-b border-line/60" style={{ height: kind === "video" ? TRACK_H + 10 : TRACK_H + 4 }}>
      <div className="sticky left-0 z-30 flex shrink-0 items-center gap-1 border-r border-line bg-panel px-1.5" style={{ width: LABEL_W }}>
        <span className={clsx("grid size-5 shrink-0 place-items-center rounded-md [&>svg]:size-3", kind === "video" ? "bg-violet-500/20 text-violet-300" : "bg-sky-500/20 text-sky-300")}>
          {kind === "video" ? <LayersIcon /> : <AudioLines />}
        </span>
        <input value={track.name} disabled={!canEdit} onChange={(e) => setTrack((x) => ({ ...x, name: e.target.value }))} aria-label={t("Layer name")}
          className="min-w-0 flex-1 truncate bg-transparent text-2xs font-semibold uppercase tracking-wide text-mute outline-none focus:text-ink" />
        {kind === "video" && (
          <button type="button" title={track.hidden ? t("Show layer") : t("Hide layer")} disabled={!canEdit} onClick={() => setTrack((x) => ({ ...x, hidden: !x.hidden }))}
            className="grid size-5 place-items-center rounded text-dim hover:text-ink">{track.hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}</button>
        )}
        <button type="button" title={track.muted ? t("Unmute layer") : t("Mute layer")} disabled={!canEdit} onClick={() => setTrack((x) => ({ ...x, muted: !x.muted }))}
          className={clsx("grid size-5 place-items-center rounded hover:text-ink", track.muted ? "text-bad" : "text-dim")}>{track.muted ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}</button>
        {canEdit && (
          <>
            <button ref={addRef} type="button" title={t("Add media to this layer")} onClick={() => setAdding((a) => !a)}
              className="grid size-5 place-items-center rounded bg-accent/15 text-accent-ink hover:bg-accent/30">{busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}</button>
            <button type="button" title={t("Delete layer")} onClick={() => edit((d) => ({ ...d, [kind]: d[kind].filter((x) => x.id !== track.id) }))}
              className="grid size-5 place-items-center rounded text-dim hover:text-bad"><Trash2 className="size-3" /></button>
          </>
        )}
      </div>
      <div className={clsx("relative flex-1", track.hidden && "opacity-40", index % 2 === 0 && "bg-raised/25")}
        onDragOver={(e) => { if (canEdit && e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && canEdit) void onFile(f); }}>
        {kind === "audio" && <WaveLane segs={segs} view={view} pps={pps} className="text-sky-300 opacity-70" />}
        {track.clips.map((c0) => {
          const c = drag?.id === c0.id ? { ...c0, ...drag } : c0;
          const on = sel?.clipId === c.id;
          const thumb = doc.media.find((m) => m.src === c.src)?.thumb_url;
          return (
            <div key={c.id} role="button" aria-pressed={on} onPointerDown={clipDrag(c0, "move")} onClick={() => onSelect({ track: kind, trackId: track.id, clipId: c.id })}
              title={`${c.name} · ${c.dur.toFixed(1)}s`}
              style={{ position: "absolute", left: c.start * pps, width: Math.max(c.dur * pps, 6), top: 3, bottom: 3,
                backgroundImage: kind === "video" && thumb ? `url(${thumb})` : undefined, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" }}
              className={clsx("group overflow-hidden rounded-md border text-2xs", tone, canEdit && "cursor-grab", on ? "z-[3] ring-2 ring-accent" : "z-[1]")}>
              {c.fade_in > 0 && <span className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-black/60 to-transparent" style={{ width: c.fade_in * pps }} />}
              {c.fade_out > 0 && <span className="pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-black/60 to-transparent" style={{ width: c.fade_out * pps }} />}
              {c.keyframes?.map((k, i) => (
                <span key={i} aria-hidden title={t("Keyframe at {t}", { t: formatTC(k.t, FPS, true) })}
                  className="pointer-events-none absolute bottom-0.5 size-1.5 -translate-x-1/2 rotate-45 border border-black/50 bg-accent-2" style={{ left: k.t * pps }} />
              ))}
              <span className="relative flex items-center gap-1 truncate px-2 py-0.5 font-medium [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">
                {c.kind === "image" ? <ImageIcon className="size-3 shrink-0" /> : c.kind === "video" ? <Film className="size-3 shrink-0" /> : <Music2 className="size-3 shrink-0" />}
                {c.name}
              </span>
              {canEdit && (
                <>
                  <span onPointerDown={clipDrag(c0, "in")} className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize opacity-0 group-hover:bg-white/50 group-hover:opacity-100" />
                  <span onPointerDown={clipDrag(c0, "out")} className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize opacity-0 group-hover:bg-white/50 group-hover:opacity-100" />
                </>
              )}
            </div>
          );
        })}
        {!track.clips.length && <span className="sticky left-[140px] inline-block px-2 text-2xs leading-[38px] text-dim">{canEdit ? t("Drop a file here, or press + to add media") : t("Empty layer")}</span>}
      </div>
      <Popover open={adding} onClose={() => setAdding(false)} anchor={addRef} width={300} className="p-2">
        <p className="mb-1.5 px-1 text-xs font-semibold">{kind === "video" ? t("Add a video or picture (placed at the playhead)") : t("Add a sound (placed at the playhead)")}</p>
        <div className="max-h-60 space-y-0.5 overflow-y-auto">
          {doc.media.filter(fits).map((m) => (
            <button key={m.src} type="button" onClick={() => place(m)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-hover">
              <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded bg-raised">
                {m.thumb_url ? <img src={m.thumb_url} alt="" className="size-full object-cover" /> : m.kind === "audio" ? <Music2 className="size-3.5 text-dim" /> : <Film className="size-3.5 text-dim" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className="shrink-0 text-2xs tabular-nums text-dim">{m.kind === "image" ? t("picture") : `${m.duration.toFixed(1)}s`}</span>
            </button>
          ))}
          {!doc.media.filter(fits).length && <p className="px-2 py-2 text-xs text-dim">{t("Nothing uploaded yet.")}</p>}
        </div>
        <Button size="sm" variant="primary" className="mt-2 w-full" icon={busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} disabled={busy}
          onClick={() => fileRef.current?.click()}>{t("Upload a file")}</Button>
        <input ref={fileRef} type="file" className="hidden" accept={kind === "video" ? "video/*,image/png,image/jpeg,image/webp" : "audio/*,video/*"}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onFile(f); }} />
      </Popover>
    </div>
  );
}

export function AddLayerRow({ canEdit, edit, saving }: { canEdit: boolean; edit: (fn: (d: LayersDoc) => LayersDoc) => void; saving: boolean }) {
  const t = useT();
  if (!canEdit) return null;
  const add = (kind: "video" | "audio") => edit((d) => ({ ...d, [kind]: [...d[kind], { id: uid(), name: `${kind === "video" ? "Video" : "Audio"} ${d[kind].length + (kind === "video" ? 2 : 1)}`, muted: false, hidden: false, gain_db: 0, clips: [] }] }));
  return (
    <div className="flex items-center gap-2 border-b border-line/60 bg-panel/60 px-2 py-1.5" style={{ paddingLeft: 8 }}>
      <Button size="sm" variant="ghost" icon={<LayersIcon className="size-3.5" />} onClick={() => add("video")}>{t("Video layer")}</Button>
      <Button size="sm" variant="ghost" icon={<AudioLines className="size-3.5" />} onClick={() => add("audio")}>{t("Audio layer")}</Button>
      <span className="text-2xs text-dim">{t("Picture-in-picture, B-roll, logos, voice-overs, extra music — drop files on a layer.")}</span>
      {saving && <span className="ml-auto inline-flex items-center gap-1 text-2xs text-dim"><Loader2 className="size-3 animate-spin" />{t("Saving…")}</span>}
    </div>
  );
}

// ── inspector ────────────────────────────────────────────────────────────────
const KF_LABEL: Record<KfKey, string> = { x: "X", y: "Y", scale: "Size", opacity: "Opacity", rotation: "Angle" };
/** Keyframe values are shown as percent (x, y, size, opacity) or degrees (angle). */
const KF_UNIT: Record<KfKey, { to: (v: number) => number; from: (v: number) => number; step: number; suffix: string }> = {
  x: { to: (v) => v * 100, from: (v) => v / 100, step: 1, suffix: "%" }, y: { to: (v) => v * 100, from: (v) => v / 100, step: 1, suffix: "%" },
  scale: { to: (v) => v * 100, from: (v) => v / 100, step: 1, suffix: "%" }, opacity: { to: (v) => v * 100, from: (v) => v / 100, step: 1, suffix: "%" },
  rotation: { to: (v) => v, from: (v) => v, step: 1, suffix: "°" },
};
const r2 = (v: number) => Math.round(v * 100) / 100;

export function LayerInspector({ doc, sel, canEdit, edit, onClose, onSeek, clock }: {
  doc: LayersDoc; sel: NonNullable<LayerSel>; canEdit: boolean; edit: (fn: (d: LayersDoc) => LayersDoc) => void; onClose: () => void; onSeek: (t: number) => void;
  /** The playhead (for "Add keyframe at playhead"). */ clock: Clock;
}) {
  const t = useT();
  const now = useClockThrottled(clock, 150);
  const track = doc[sel.track].find((x) => x.id === sel.trackId);
  const c = track?.clips.find((x) => x.id === sel.clipId);
  if (!track || !c) return null;
  const set = (patch: Partial<LayerClip>) => edit((d) => ({ ...d, [sel.track]: d[sel.track].map((x) => (x.id === track.id ? { ...x, clips: x.clips.map((k) => (k.id === c.id ? { ...k, ...patch } : k)) } : x)) }));
  const remove = () => { edit((d) => ({ ...d, [sel.track]: d[sel.track].map((x) => (x.id === track.id ? { ...x, clips: x.clips.filter((k) => k.id !== c.id) } : x)) })); onClose(); };
  const dup = () => edit((d) => ({ ...d, [sel.track]: d[sel.track].map((x) => (x.id === track.id ? { ...x, clips: [...x.clips, { ...c, id: uid(), start: c.start + c.dur }] } : x)) }));
  const num = (label: string, k: keyof LayerClip, step = 0.1, min = 0) => (
    <Field label={label}>
      <Input type="number" step={step} min={min} value={Number(c[k] ?? 0)} disabled={!canEdit} className="!h-8"
        onChange={(e) => set({ [k]: Math.max(min, Number(e.target.value)) } as Partial<LayerClip>)} />
    </Field>
  );
  const slider = (label: string, k: keyof LayerClip, min: number, max: number, step: number, fmt: (v: number) => string, fallback = 0) => (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-2xs text-mute">{label}</span>
      <input type="range" min={min} max={max} step={step} value={Number(c[k] ?? fallback)} disabled={!canEdit} aria-label={label}
        onChange={(e) => set({ [k]: Number(e.target.value) } as Partial<LayerClip>)} className="h-1.5 min-w-0 flex-1 accent-[var(--color-accent)]" />
      <span className="w-12 shrink-0 text-right text-2xs tabular-nums text-dim">{fmt(Number(c[k] ?? fallback))}</span>
    </div>
  );
  // keyframes (picture clips only)
  const kfs = c.keyframes ?? [];
  const setKfs = (list: Keyframe[]) => set({ keyframes: list.length ? normalizeKf(list, c.dur) : undefined });
  const rel = now - c.start;
  const atPlayhead = rel >= -1e-3 && rel <= c.dur + 1e-3;
  const addAtPlayhead = () => {
    const tt = Math.round(Math.max(0, Math.min(c.dur, rel)) * 1000) / 1000;
    setKfs([...kfs.filter((k) => Math.abs(k.t - tt) > 1e-3), { t: tt, ...stateAt(c, tt) }]);  // captures the values shown right now
  };
  const editKf = (i: number, patch: Partial<Keyframe>) => setKfs(kfs.map((k, j) => (j === i ? { ...k, ...patch } : k)));
  const kfField = (i: number, k: Keyframe, key: KfKey) => {
    const u = KF_UNIT[key];
    const v = k[key];
    return (
      <label key={key} className="flex min-w-0 flex-col gap-0.5">
        <span className="text-2xs text-dim">{t(KF_LABEL[key])}</span>
        <Input type="number" step={u.step} value={v === undefined ? "" : r2(u.to(v))} placeholder="–" disabled={!canEdit} aria-label={`${t(KF_LABEL[key])} ${u.suffix}`}
          onChange={(e) => editKf(i, { [key]: e.target.value === "" ? undefined : u.from(Number(e.target.value)) })} className="!h-7 min-w-0 !px-1.5 text-center text-xs tabular-nums" />
      </label>
    );
  };
  return (
    <div className="space-y-3 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-center gap-2">
        <span className={clsx("grid size-7 place-items-center rounded-lg", sel.track === "video" ? "bg-violet-500/20 text-violet-300" : "bg-sky-500/20 text-sky-300")}>
          {c.kind === "image" ? <ImageIcon className="size-4" /> : c.kind === "video" ? <Film className="size-4" /> : <Music2 className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{c.name}</p>
          <p className="text-2xs text-dim">{track.name} · {t("at {s}s for {d}s", { s: c.start.toFixed(2), d: c.dur.toFixed(2) })}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onSeek(c.start)}>{t("Go to")}</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {num(t("Start (s)"), "start")}
        {c.kind !== "image" && num(t("From (s)"), "in")}
        {num(t("Length (s)"), "dur", 0.1, 0.2)}
      </div>
      {sel.track === "video" && (
        <div className="space-y-1.5">
          {slider(t("Left ↔ right"), "x", -0.2, 1.2, 0.005, (v) => `${Math.round(v * 100)}%`, 0.5)}
          {slider(t("Up ↕ down"), "y", -0.2, 1.2, 0.005, (v) => `${Math.round(v * 100)}%`, 0.5)}
          {slider(t("Size"), "scale", 0.05, 1.5, 0.01, (v) => `${Math.round(v * 100)}%`, 0.35)}
          {slider(t("Opacity"), "opacity", 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, 1)}
          {slider(t("Angle"), "rotation", -180, 180, 1, (v) => `${Math.round(v)}°`)}
          {kfs.length > 0 && <p className="text-2xs leading-snug text-dim">{t("With keyframes, these are the values used where no keyframe applies.")}</p>}
          <div className="flex flex-wrap gap-1.5">
            {[["↖", 0.15, 0.15], ["↗", 0.85, 0.15], ["↙", 0.15, 0.85], ["↘", 0.85, 0.85], ["Centre", 0.5, 0.5]].map(([l, x, y]) => (
              <Button key={String(l)} size="sm" variant="outline" disabled={!canEdit} onClick={() => set({ x: Number(x), y: Number(y) })}>{t(String(l))}</Button>
            ))}
            <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => set({ x: 0.5, y: 0.5, scale: 1, rotation: 0 })}>{t("Full frame")}</Button>
          </div>
        </div>
      )}
      {sel.track === "video" && (
        <section className="space-y-2 rounded-lg border border-line bg-raised/40 p-2" aria-label={t("Keyframes")}>
          <div className="flex items-center gap-2">
            <Diamond className="size-3.5 text-accent-2" />
            <span className="text-xs font-semibold">{t("Keyframes")}</span>
            <span className="rounded-full bg-raised px-1.5 text-2xs tabular-nums text-dim">{kfs.length}/{MAX_KEYFRAMES}</span>
            <Tooltip content={atPlayhead ? t("Capture the picture's position, size, opacity and angle at the playhead") : t("Move the playhead onto this clip first")}>
              <Button size="sm" variant="outline" className="ml-auto" icon={<Plus className="size-3.5" />} disabled={!canEdit || !atPlayhead || kfs.length >= MAX_KEYFRAMES} onClick={addAtPlayhead}>
                {t("Add at playhead")}
              </Button>
            </Tooltip>
          </div>
          {kfs.length ? (
            <ul className="space-y-1.5">
              {kfs.map((k, i) => (
                <li key={i} className="rounded-lg border border-line bg-panel p-1.5">
                  <div className="mb-1 flex items-center gap-1.5">
                    <button type="button" onClick={() => onSeek(c.start + k.t)} title={t("Move the playhead here")}
                      className="inline-flex h-6 items-center gap-1 rounded-md bg-raised px-1.5 font-mono text-2xs tabular-nums text-mute hover:bg-hover hover:text-ink">
                      <Diamond className="size-2.5 text-accent-2" />{formatTC(k.t, FPS, true)}
                    </button>
                    <Input type="number" step={1 / FPS} min={0} max={c.dur} value={k.t} disabled={!canEdit} aria-label={t("Keyframe time (s)")}
                      onChange={(e) => editKf(i, { t: Math.max(0, Math.min(c.dur, Number(e.target.value))) })} className="!h-6 w-20 !px-1.5 text-xs tabular-nums" />
                    <span className="text-2xs text-dim">s</span>
                    {canEdit && <IconButton title={t("Delete keyframe")} className="ml-auto !size-6" onClick={() => setKfs(kfs.filter((_, j) => j !== i))}><Trash2 className="size-3" /></IconButton>}
                  </div>
                  <div className="grid grid-cols-5 gap-1">{KF_KEYS.map((key) => kfField(i, k, key))}</div>
                </li>
              ))}
            </ul>
          ) : <p className="text-2xs leading-snug text-dim">{t("Move the playhead, set the picture, add a keyframe; repeat somewhere else — the picture moves between them in straight lines.")}</p>}
          {kfs.length > 0 && <p className="text-2xs leading-snug text-dim">{t("Linear between keyframes, held before the first and after the last. The export animates the same values (opacity keyframes render more slowly on large pictures).")}</p>}
        </section>
      )}
      <div className="space-y-1.5">
        {slider(t("Fade in"), "fade_in", 0, 3, 0.1, (v) => `${v.toFixed(1)}s`)}
        {slider(t("Fade out"), "fade_out", 0, 3, 0.1, (v) => `${v.toFixed(1)}s`)}
        {c.kind !== "image" && slider(t("Volume"), "gain_db", -30, 12, 0.5, (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`)}
        {sel.track === "video" && c.kind === "video" && (
          <div className="flex items-center gap-2"><span className="w-16 shrink-0 text-2xs text-mute">{t("Its sound")}</span><Toggle checked={!c.muted} disabled={!canEdit} onChange={(v) => set({ muted: !v })} /></div>
        )}
      </div>
      {canEdit && (
        <div className="flex gap-2 border-t border-line pt-2">
          <Button size="sm" variant="outline" icon={<Copy className="size-3.5" />} onClick={dup}>{t("Duplicate after")}</Button>
          <Button size="sm" variant="ghost" className="ml-auto text-bad" icon={<Trash2 className="size-3.5" />} onClick={remove}>{t("Remove")}</Button>
        </div>
      )}
    </div>
  );
}

// ── playback in the preview player ───────────────────────────────────────────
/** Plays the layers in sync with the main track (pictures positioned like the export, sounds at their volume). */
export function LayerPlayback({ tp, doc }: { tp: Transport; doc: LayersDoc | null }) {
  const [now, setNow] = useState(0);
  useEffect(() => tp.clock.subscribe(() => setNow(Math.round(tp.clock.get() * 10) / 10)), [tp.clock]);
  const items = useMemo(() => {
    if (!doc) return { pics: [] as (LayerClip & { url: string; z: number; trackMuted: boolean })[], sounds: [] as (LayerClip & { url: string; vol: number })[] };
    const pics = doc.video.flatMap((tk, z) => (tk.hidden ? [] : tk.clips.map((c) => ({ ...c, url: urlOf(doc, c.src), z, trackMuted: tk.muted }))));
    const sounds = doc.audio.flatMap((tk) => (tk.muted ? [] : tk.clips.map((c) => ({ ...c, url: urlOf(doc, c.src), vol: Math.min(1, Math.pow(10, (c.gain_db + tk.gain_db) / 20)) }))));
    return { pics, sounds };
  }, [doc]);
  const on = (c: LayerClip) => now >= c.start - 0.05 && now < c.start + c.dur;
  return (
    <>
      {items.pics.filter(on).map((c) => (
        <AnimatedPic key={c.id} clip={c} tp={tp} z={5 + c.z}>
          {c.kind === "image" ? <img src={c.url} alt="" className="block w-full" />
            : <SyncedMedia kind="video" url={c.url} tp={tp} clip={c} muted={!!c.muted || c.trackMuted} volume={Math.min(1, Math.pow(10, c.gain_db / 20))} />}
        </AnimatedPic>
      ))}
      {items.sounds.filter(on).map((c) => <SyncedMedia key={c.id} kind="audio" url={c.url} tp={tp} clip={c} volume={c.vol} />)}
    </>
  );
}

/** The CSS for a picture clip's position / size / opacity / angle. */
function picStyle(s: Record<KfKey, number>): Partial<CSSStyleDeclaration> {
  return { left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.scale * 100}%`, opacity: String(s.opacity),
    transform: `translate(-50%, -50%)${s.rotation ? ` rotate(${s.rotation}deg)` : ""}` };
}

/** Positions a picture clip; with keyframes it follows the clock every frame (no re-render) so scrubbing shows the motion. */
function AnimatedPic({ clip, tp, z, children }: { clip: LayerClip; tp: Transport; z: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const animated = !!clip.keyframes?.length;
  useEffect(() => {
    if (!animated) return;
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      Object.assign(el.style, picStyle(stateAt(clip, tp.clock.get() - clip.start)));
    };
    apply();
    return tp.clock.subscribe(apply);
  }, [animated, clip, tp.clock]);
  const base = { x: clip.x ?? KF_DEFAULT.x, y: clip.y ?? KF_DEFAULT.y, scale: clip.scale ?? KF_DEFAULT.scale, opacity: clip.opacity ?? KF_DEFAULT.opacity, rotation: clip.rotation ?? 0 };
  const s = picStyle(animated ? stateAt(clip, tp.clock.get() - clip.start) : base);
  return (
    <div ref={ref} className="pointer-events-none absolute" style={{ left: s.left, top: s.top, width: s.width, opacity: s.opacity, transform: s.transform, zIndex: z }}>
      {children}
    </div>
  );
}

function SyncedMedia({ kind, url, tp, clip, muted, volume }: { kind: "video" | "audio"; url: string; tp: Transport; clip: LayerClip; muted?: boolean; volume: number }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = volume;
    const sync = () => {
      const want = clip.in + (tp.clock.get() - clip.start);
      if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = Math.max(0, want);
    };
    sync();
    if (tp.playing && tp.rate > 0) { el.playbackRate = tp.rate; void el.play().catch(() => undefined); } else el.pause();
    const h = window.setInterval(sync, 500);
    return () => window.clearInterval(h);
  }, [tp.playing, tp.rate, url, clip.start, clip.in, volume]);
  return kind === "video"
    ? <video ref={ref} src={url} muted={muted} playsInline preload="auto" className="block w-full" />
    : <audio ref={ref} src={url} preload="auto" />;
}
