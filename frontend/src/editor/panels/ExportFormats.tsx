/**
 * Multi-format export (docs/EDITOR.md §10): pick formats (16:9, 9:16, 1:1, 4:5) and presets. A format the sequence
 * isn't gets a reframed copy ("<name> · 9:16"): every picture fills the frame and follows the faces the engine finds
 * (trackFaces → smoothed position keyframes; centred without them), titles scale and move inside the format's safe
 * area. Then one batch export (bridge.editor.exportBatch, else one export per item). Opened from File → Export
 * multiple formats… (the "ed:export-formats" event).
 */
import { clsx } from "clsx";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Modal, Toggle } from "../../components/ui";
import { desktop, editorBridge, type RenderPreset } from "../../lib/desktop";
import { lookCaps, trackFaces } from "../moods/engineLooks";
import { seqEnd, tracksOf } from "../model/ops";
import { framesToSeconds, shortDuration } from "../model/time";
import type { Sequence } from "../model/types";
import { save } from "../session";
import { ed, exec, isDirty, project, urlFor, useSequence } from "../store";
import { FORMATS, formatOf, formatSize, reframeSequence, safeAreaIssues, type FaceSample, type Format } from "../templates/formats";

type BatchItem = { preset: string; sequenceId?: string; name?: string; range?: "all" | "inout" };
type BatchBridge = { exportBatch?(path: string, sequenceId: string, items: BatchItem[]): Promise<string[]>; export(path: string, sequenceId: string, opts: { preset: string; range: "all" | "inout"; name?: string }): Promise<string> };

export function ExportFormatsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("ed:export-formats", on);
    return () => window.removeEventListener("ed:export-formats", on);
  }, []);
  return open ? <Dialog onClose={() => setOpen(false)} /> : null;
}
export const openExportFormats = () => window.dispatchEvent(new CustomEvent("ed:export-formats"));

/** Faces in each picture clip of a sequence (source seconds), clip by clip. */
async function facesOf(s: Sequence, onStep: (msg: string) => void): Promise<Record<string, FaceSample[]>> {
  const out: Record<string, FaceSample[]> = {};
  const p = project();
  const vids = new Set(tracksOf(s, "video").map((t) => t.id));
  const clips = s.clips.filter((c) => vids.has(c.trackId) && c.source.type === "media");
  let i = 0;
  for (const c of clips) {
    const m = p.media.find((x) => x.id === (c.source as { mediaId: string }).mediaId);
    i++;
    if (!m || m.kind !== "video") continue;
    const url = urlFor(m);
    if (!url) continue;
    onStep(`Finding faces in ${c.name} (${i} of ${clips.length})…`);
    const f = m.fps > 0 ? m.fps : s.fps;
    const a = framesToSeconds((c.source as { in: number }).in, f), b = a + framesToSeconds(c.duration, s.fps) * (c.speed || 1);
    const r = await trackFaces(url, a, b);
    if (r.faces.length) out[c.id] = r.faces;
  }
  return out;
}

function Dialog({ onClose }: { onClose: () => void }) {
  const s = useSequence();
  const own = formatOf(s);
  const [picked, setPicked] = useState<Set<Format["id"]>>(() => new Set([own?.id ?? "16:9", ...(own?.id === "9:16" ? [] : ["9:16" as const])]));
  const [presets, setPresets] = useState<RenderPreset[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<"all" | "inout">(s.inPoint !== undefined || s.outPoint !== undefined ? "inout" : "all");
  const [reframe, setReframe] = useState(true);
  const [fitTitles, setFitTitles] = useState(true);
  const [faces, setFaces] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const bridge = editorBridge() as unknown as BatchBridge | null;
  useEffect(() => { void lookCaps().then((c) => setFaces(c.trackFaces)); }, []);
  useEffect(() => {
    const d = desktop();
    if (!d) return;
    d.render.presets().then((ps) => {
      setPresets(ps);
      const best = ps.find((x) => Math.min(x.w, x.h) === Math.min(s.width, s.height)) ?? ps[0];
      if (best) setChosen(new Set([best.id]));
    }).catch(() => undefined);
  }, [s.width, s.height]);
  const len = seqEnd(s);
  const issues = useMemo(() => Object.fromEntries(FORMATS.map((f) => [f.id, safeAreaIssues(s, f)])), [s]);
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const formats = FORMATS.filter((f) => picked.has(f.id));
  const items = formats.length * Math.max(1, chosen.size);

  /** The reframed copies (made, or remade, in one command); returns format → sequence id. */
  const makeCopies = async (): Promise<Record<string, string>> => {
    const ids: Record<string, string> = {};
    const need = formats.filter((f) => f.id !== own?.id);
    if (own && picked.has(own.id)) ids[own.id] = s.id;
    if (!need.length) return ids;
    let fc: Record<string, FaceSample[]> = {};
    if (reframe && faces) fc = await facesOf(s, setBusy);
    setBusy("Making the reframed copies…");
    const p0 = project();
    const made = need.map((f) => ({ f, r: reframeSequence(p0, s.id, f, reframe ? fc : {}, { fitTitles }) }));
    exec(`Reframe for ${need.map((f) => f.id).join(", ")}`, (p) => {
      // a copy made before for the same format is replaced
      const names = new Set(made.map((m) => m.r.sequence.name));
      const used = new Set(p.sequences.flatMap((x) => x.clips.filter((c) => c.source.type === "nested").map((c) => (c.source as { sequenceId: string }).sequenceId)));
      const keep = p.sequences.filter((x) => !(names.has(x.name) && x.id !== s.id && !used.has(x.id)));
      return { ...p, sequences: [...keep, ...made.map((m) => m.r.sequence)] };
    });
    for (const m of made) ids[m.f.id] = m.r.sequence.id;
    const followed = made.reduce((n, m) => n + m.r.followed, 0), moved = made.reduce((n, m) => n + m.r.titlesMoved, 0);
    toast.success(`${made.length} reframed cop${made.length === 1 ? "y" : "ies"}${reframe ? ` · ${followed ? `${followed} clip${followed === 1 ? "" : "s"} follow faces` : faces ? "no faces found: centred" : "centred (face tracking comes with the engine's tracker)"}` : ""}${moved ? ` · ${moved} title${moved === 1 ? "" : "s"} moved into the safe area` : ""}`);
    return ids;
  };

  const run = async (exportToo: boolean) => {
    if (!formats.length) return;
    try {
      const ids = await makeCopies();
      if (!exportToo) { setBusy(null); onClose(); return; }
      const path = ed().path;
      if (!bridge || !path) { toast.message("Exporting needs Tatvam Desktop: the copies are in the Project panel"); setBusy(null); return; }
      setBusy("Saving…");
      if (isDirty() && !(await save())) { setBusy(null); return; }
      const list: BatchItem[] = formats.flatMap((f) => [...chosen].map((preset) => ({ preset, sequenceId: ids[f.id], range, name: `${s.name} ${f.id.replace(":", "x")}` })));
      setBusy(`Starting ${list.length} export${list.length === 1 ? "" : "s"}…`);
      let jobs: string[] = [];
      if (typeof bridge.exportBatch === "function") jobs = await bridge.exportBatch(path, s.id, list);
      else for (const it of list) jobs.push(await bridge.export(path, it.sequenceId ?? s.id, { preset: it.preset, range, name: it.name }));
      toast.success(`${jobs.length} export${jobs.length === 1 ? "" : "s"} started — follow them in the Render queue`);
      onClose();
    } catch (e) { toast.error(`Export failed: ${String((e as Error).message).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "")}`); }
    setBusy(null);
  };

  return (
    <Modal open onClose={() => !busy && onClose()} title={`Export formats · ${s.name}`} wide
      footer={<>
        <span className="mr-auto text-2xs text-dim">{busy ?? `${items} export${items === 1 ? "" : "s"} · ${shortDuration(range === "inout" ? Math.max(0, (s.outPoint ?? len - 1) + 1 - (s.inPoint ?? 0)) : len, s.fps)} each`}</span>
        <Button variant="ghost" disabled={!!busy} onClick={onClose}>Cancel</Button>
        <Button variant="secondary" disabled={!!busy || !formats.some((f) => f.id !== own?.id)} onClick={() => void run(false)}>Only make the copies</Button>
        <Button variant="primary" loading={!!busy} disabled={!formats.length || !chosen.size || !len || !desktop()} onClick={() => void run(true)}>Export</Button>
      </>}>
      <div className="grid gap-4" data-export-formats>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FORMATS.map((f) => {
            const on = picked.has(f.id);
            const size = formatSize(s, f);
            const bad = issues[f.id]?.length ?? 0;
            return (
              <button key={f.id} type="button" data-format={f.id} onClick={() => setPicked((x) => toggle(x, f.id))}
                className={clsx("rounded-xl border p-3 text-left transition-colors", on ? "border-accent bg-accent/10" : "border-line hover:border-dim/50")}>
                <div className="mb-2 flex h-16 items-center justify-center">
                  <div className={clsx("relative rounded-[3px] border-2", on ? "border-accent" : "border-dim")} style={{ width: (56 * f.w) / Math.max(f.w, f.h), height: (56 * f.h) / Math.max(f.w, f.h) }}>
                    {on && <Check className="absolute inset-0 m-auto size-4 text-accent-ink" />}
                  </div>
                </div>
                <p className="text-xs font-medium">{f.label}{own?.id === f.id && <span className="ml-1 text-2xs text-dim">(this sequence)</span>}</p>
                <p className="text-[10px] text-dim">{f.hint} · {size.width}×{size.height}</p>
                {bad > 0 && on && f.id !== own?.id && <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-300"><AlertTriangle className="size-3" />{bad} title{bad === 1 ? "" : "s"} outside the safe area{fitTitles ? " (moved in)" : ""}</p>}
              </button>
            );
          })}
        </div>
        {desktop() ? (
          <div>
            <p className="eyebrow mb-1.5">Presets (each format gets each)</p>
            <div className="grid gap-1 sm:grid-cols-2">
              {presets.map((pr) => (
                <label key={pr.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-hover">
                  <input type="checkbox" checked={chosen.has(pr.id)} onChange={() => setChosen((x) => toggle(x, pr.id))} />
                  <span className="min-w-0 flex-1 truncate">{pr.label}</span><span className="text-2xs text-dim">{pr.codec}{pr.hardware ? " · GPU" : ""}</span>
                </label>
              ))}
              {!presets.length && <Loader2 className="size-4 animate-spin text-dim" />}
            </div>
          </div>
        ) : <p className="text-sm text-mute">Exports render in Tatvam Desktop. Here you can make the reframed copies.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle checked={reframe} onChange={setReframe} label={<span className="text-sm">Auto-reframe: follow faces {faces ? "" : <span className="text-2xs text-dim">(the engine's face tracker isn't in this build: pictures are centred)</span>}</span>} />
          <Toggle checked={fitTitles} onChange={setFitTitles} label={<span className="text-sm">Move titles into each format's safe area</span>} />
        </div>
        <div className="ed-seg w-fit">
          <button type="button" aria-pressed={range === "all"} onClick={() => setRange("all")}>Whole sequence</button>
          <button type="button" aria-pressed={range === "inout"} disabled={s.inPoint === undefined && s.outPoint === undefined} onClick={() => setRange("inout")}>In to out</button>
        </div>
        {busy && <p className="flex items-center gap-2 text-xs text-mute"><Loader2 className="size-3.5 animate-spin" />{busy}</p>}
      </div>
    </Modal>
  );
}

