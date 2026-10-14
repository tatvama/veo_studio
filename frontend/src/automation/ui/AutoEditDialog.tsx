/**
 * The Auto edit dialog (docs/EDITOR.md §13.3): a folder (or the edit's media), a style card, the target length,
 * format, music, captions language, mood, transitions and order → "Analyse and preview" (free analysis on this PC) →
 * the plan (clips used, cuts, silence removed, length, what was left out) → Create, which builds the sequence as ONE
 * undo step. Opens from the editor's File menu and Project panel, the Start window ("New edit from folder") and a
 * dropped folder (openAutoEdit()). Outside an open edit, Create makes a new edit in the library and opens it.
 * A default export with no required props.
 */
import { clsx } from "clsx";
import { Clapperboard, FolderOpen, Loader2, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Field, Input, Modal, Select } from "../../components/ui";
import { forDisk } from "../../editor/model/serialize";
import type { EditProject, MediaItem } from "../../editor/model/types";
import { resolveUrls } from "../../editor/session";
import { ed, exec, project, seq, useEditor } from "../../editor/store";
import { desktop, editorBridge, type AnalysisKindName, type AnalyzeMediaRef, type AutoEditStyle, type FolderListing, type MediaAnalysis } from "../../lib/desktop";
import { MOODS } from "../../lib/moods";
import { assistantsBridge, AUTO_EDIT_EVENT, errText, type OpenAutoEdit } from "../api";
import { resolveSfxUrls, withAutoSfx } from "../../editor/autosfx/autoedit"; // auto-sfx: "Add sound effects" (additive)
import { runAutoSfx } from "../../editor/autosfx/apply";
import { makeHost } from "../../editor/host";
import { buildAutoEdit, describePlan, formatSize, planAutoEdit, STYLES, styleById, type AutoEditOptions, type Format, type OrderChoice, type Plan, type PlanMedia, type TransitionsChoice } from "../autoedit";

const LANGS = [["none", "No captions"], ["auto", "Captions: detect the language"], ["en", "English"], ["hi", "Hindi"], ["kn", "Kannada"], ["te", "Telugu"], ["ta", "Tamil"],
  ["ml", "Malayalam"], ["mr", "Marathi"], ["bn", "Bengali"]] as const;
const COLORS = ["#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#60a5fa", "#f97316", "#e879f9"];
const r1 = (v: number) => Math.round(v * 10) / 10;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const secs = (m: MediaItem) => m.seconds ?? (m.fps > 0 ? m.duration / m.fps : 0);
const ref = (m: MediaItem): AnalyzeMediaRef => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, hasAudio: m.hasAudio, seconds: secs(m), width: m.width, height: m.height });
const pm = (m: MediaItem): PlanMedia => ({ id: m.id, name: m.name, kind: m.kind, duration: secs(m), hasAudio: m.hasAudio, width: m.width, height: m.height, path: m.path });
const inFolder = (folder: string, p: string) => p.toLowerCase().startsWith(`${folder.toLowerCase().replace(/[\\/]+$/, "")}\\`) || p.toLowerCase().startsWith(`${folder.toLowerCase().replace(/[\\/]+$/, "")}/`);

type Phase = "setup" | "working" | "preview";

export default function AutoEditDialog({ open: openProp, onClose, folder: folderProp, files: filesProp }: { open?: boolean; onClose?: () => void; folder?: string;
  /** only these files of the folder (a drop of some files) */ files?: string[] } = {}) {
  const [open, setOpen] = useState(false);
  const editPath = useEditor((s) => s.path);
  const inEditor = Boolean(editPath);
  const [folder, setFolder] = useState<string | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [style, setStyle] = useState<AutoEditStyle>("talking_head");
  const [target, setTarget] = useState("");
  const [format, setFormat] = useState<Format | "">("");
  const [music, setMusic] = useState("none");
  const [captions, setCaptions] = useState("none");
  const [mood, setMood] = useState("");
  const [transitions, setTransitions] = useState<TransitionsChoice | "">("");
  const [order, setOrder] = useState<OrderChoice>("name");
  const [title, setTitle] = useState("");
  const [sfx, setSfx] = useState<NonNullable<AutoEditOptions["sfx"]>>("none");
  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState<{ done: number; total: number; current?: string; step: string } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [work, setWork] = useState<{ project: EditProject; path: string; fresh: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const show = (o: OpenAutoEdit = {}) => {
    setErr(null); setPlan(null); setPhase("setup"); setProgress(null); setWork(null);
    if (o.folder) { setFolder(o.folder); setListing(o.listing ?? null); if (!o.listing) void loadFolder(o.folder); }
    else if (!inEditor) { setFolder(null); setListing(null); }
    setOpen(true);
  };
  useEffect(() => {
    const h = (e: Event) => show((e as CustomEvent<OpenAutoEdit>).detail ?? {});
    window.addEventListener(AUTO_EDIT_EVENT, h);
    return () => window.removeEventListener(AUTO_EDIT_EVENT, h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inEditor]);
  useEffect(() => { if (openProp) show({ folder: folderProp }); else if (openProp === false) setOpen(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [openProp, folderProp]);
  useEffect(() => {
    const b = assistantsBridge();
    if (!b) return;
    return b.onProgress((p) => setProgress((x) => ({ step: x?.step ?? "Analysing", ...p })));
  }, []);
  const close = () => { if (phase === "working") return; setOpen(false); onClose?.(); };

  async function loadFolder(f: string) {
    try {
      const l = await assistantsBridge()!.listFolder(f);
      const only = filesProp?.length ? new Set(filesProp.map((x) => x.toLowerCase())) : null;
      setListing(only ? { ...l, files: l.files.filter((x) => only.has(x.path.toLowerCase())) } : l);
    } catch (e) { setErr(errText(e)); }
  }
  async function chooseFolder() {
    const b = assistantsBridge();
    if (!b) return;
    const l = await b.chooseFolder().catch((e) => { setErr(errText(e)); return null; });
    if (l) { setFolder(l.folder); setListing(l); setPlan(null); }
  }

  const s = styleById(style);
  // the audio a montage / slideshow can cut to: in the folder, or already in the edit
  const projectAudio = inEditor ? project().media.filter((m) => m.kind === "audio") : [];
  const folderAudio = (listing?.files ?? []).filter((f) => f.kind === "audio");
  const counts = useMemo(() => {
    const files = listing?.files ?? [];
    return { video: files.filter((f) => f.kind === "video").length, audio: files.filter((f) => f.kind === "audio").length, image: files.filter((f) => f.kind === "image").length };
  }, [listing]);

  const options = (folderName: string, fps: number): AutoEditOptions => ({
    style, targetSeconds: Number(target) > 0 ? Number(target) : undefined, format: format || undefined, music, captions, mood: mood || undefined,
    transitions: transitions || undefined, order, title: title.trim() || undefined, folder: folderName, fps, sfx,
  });

  async function analyse() {
    const eb = editorBridge(), ab = assistantsBridge();
    if (!eb || !ab) { setErr("Auto edit needs Tatvam Desktop"); return; }
    setErr(null); setPhase("working"); setPlan(null);
    try {
      let proj: EditProject;
      let path: string;
      let fresh = false;
      let candidates: MediaItem[];
      const folderName = folder ? folder.split(/[\\/]/).filter(Boolean).pop() ?? "Clips" : project().name;
      const files = (listing?.files ?? []).map((f) => f.path);
      if (inEditor) {
        path = ed().path!;
        if (folder && files.length) {
          const have = new Set(project().media.map((m) => m.path.toLowerCase()));
          const todo = files.filter((f) => !have.has(f.toLowerCase()));
          if (todo.length) {
            setProgress({ done: 0, total: todo.length, step: `Importing ${todo.length} file${todo.length === 1 ? "" : "s"}` });
            const items = await eb.importMedia(path, todo);
            exec(`Auto edit: import ${folderName}`, (p) => {
              const b = p.bins.find((x) => x.name === folderName && !x.parentId);
              const binId = b?.id ?? `b_${Math.random().toString(36).slice(2, 10)}`;
              return { ...p, bins: b ? p.bins : [...p.bins, { id: binId, name: folderName, parentId: null }], media: [...p.media, ...items.map((m) => ({ ...m, binId }))] };
            });
            void resolveUrls(items);
          }
          candidates = project().media.filter((m) => inFolder(folder, m.path));
        } else candidates = project().media.filter((m) => !m.missing && !m.path.startsWith("studio:"));
        proj = project();
      } else {
        if (!folder || !files.length) throw new Error("Choose a folder with video, audio or pictures first");
        const size = formatSize(format || s.format);
        let made: { path: string; project: EditProject } | null = null;
        for (let i = 0; i < 6 && !made; i++) {
          try { made = await eb.create(i ? `${folderName} ${i + 1}` : folderName, { ...size, fps: 25 }); } catch (e) { if (i === 5 || !/already exists/i.test(errText(e))) throw e; }
        }
        setProgress({ done: 0, total: files.length, step: `Importing ${files.length} file${files.length === 1 ? "" : "s"}` });
        const items = await eb.importMedia(made!.path, files);
        const binId = `b_${Math.random().toString(36).slice(2, 10)}`;
        proj = { ...(made!.project as EditProject), bins: [{ id: binId, name: folderName, parentId: null }], media: items.map((m) => ({ ...m, binId })) as MediaItem[] };
        path = made!.path;
        fresh = true;
        candidates = proj.media;
      }
      const musicItem = music !== "none" && music !== "ai" ? proj.media.find((m) => m.id === music || m.path.toLowerCase() === music.toLowerCase()) : undefined;
      const kinds: AnalysisKindName[] = ["silence", "scenes", "loudness", "quality"];
      if (captions !== "none") kinds.push("transcript");
      setProgress({ done: 0, total: candidates.length, step: "Analysing (silences, scenes, bad takes)" });
      const analysis: MediaAnalysis[] = await ab.analyze(path, candidates.filter((m) => m.kind !== "image" && m.id !== musicItem?.id).map(ref), kinds);
      if (musicItem) analysis.push(...await ab.analyze(path, [ref(musicItem)], ["beats", "loudness"]));
      const media = [...candidates.filter((m) => m.id !== musicItem?.id), ...(musicItem ? [musicItem] : [])];
      const p = planAutoEdit(media.map(pm), analysis, { ...options(folderName, inEditor ? seq().fps : 25), music: musicItem?.id ?? (music === "ai" ? "ai" : "none") });
      setPlan(p);
      setWork({ project: proj, path, fresh });
      setPhase("preview");
    } catch (e) {
      setErr(errText(e));
      setPhase("setup");
    } finally { setProgress(null); }
  }

  async function create() {
    if (!plan || !work) return;
    setPhase("working");
    setProgress({ done: 0, total: 1, step: "Cutting the sequence" });
    try {
      if (inEditor && !work.fresh) {
        const label = `Auto edit: ${styleById(plan.style).name}`;
        if (plan.sfx) {
          // auto-sfx: the sounds go onto the new sequence before it is committed, so it all is ONE undo step
          setProgress({ done: 0, total: 1, step: "Adding sound effects" });
          const base = project();
          const built = buildAutoEdit(base, plan);
          const withSfx = await withAutoSfx(built.project, work.path, built.sequenceId, plan.sfx).catch(() => null);
          if (withSfx && project() === base) { exec(label, () => withSfx.project); resolveSfxUrls(withSfx.media); }
          else {
            // the edit changed while the sounds were made: the cut first, then its sounds as a second step
            exec(label, (p) => buildAutoEdit(p, plan).project);
            if (withSfx) await runAutoSfx(makeHost(), { intensity: plan.sfx }, { onMedia: resolveSfxUrls }).catch(() => undefined);
          }
        } else exec(label, (p) => buildAutoEdit(p, plan).project);
      } else {
        const r = buildAutoEdit(work.project, plan);
        let made = r.project;
        if (plan.sfx) made = (await withAutoSfx(made, work.path, r.sequenceId, plan.sfx).catch(() => null))?.project ?? made; // auto-sfx
        await editorBridge()!.save(work.path, forDisk(made));
        window.location.assign(`/editor/edit?path=${encodeURIComponent(work.path)}`);
      }
      setOpen(false);
      onClose?.();
    } catch (e) {
      setErr(errText(e));
      setPhase("preview");
    } finally { setProgress(null); }
  }

  if (!desktop()) return null;
  const totalLen = plan?.summary.length ?? 0;
  const mediaColor = new Map<string, string>();
  plan?.segments.forEach((x) => { if (!mediaColor.has(x.mediaId)) mediaColor.set(x.mediaId, COLORS[mediaColor.size % COLORS.length]); });
  const names = new Map((work?.project.media ?? []).map((m) => [m.id, m.name]));

  return (
    <Modal open={open} onClose={close} size="xl" title={<span className="inline-flex items-center gap-2"><Wand2 className="size-4 text-ai" />Auto edit</span>}
      footer={(
        <div className="flex w-full items-center gap-2">
          {err && <span className="mr-auto max-w-[60%] truncate text-xs text-red-300" title={err}>{err}</span>}
          <Button variant="ghost" className={clsx(!err && "ml-auto")} onClick={close} disabled={phase === "working"}>Cancel</Button>
          {phase === "preview" && <Button variant="secondary" onClick={() => { setPhase("setup"); setPlan(null); }}>Change options</Button>}
          {phase !== "preview"
            ? <Button variant="primary" icon={phase === "working" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} disabled={phase === "working" || (!inEditor && !listing?.files.length)} onClick={() => void analyse()}>Analyse and preview</Button>
            : <Button variant="primary" icon={<Clapperboard className="size-4" />} disabled={!plan?.segments.length} onClick={() => void create()}>Create</Button>}
        </div>
      )}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised/50 px-3 py-2">
          <FolderOpen className="size-4 text-mute" />
          {folder ? <span className="min-w-0 flex-1 truncate font-mono text-xs" title={folder}>{folder}</span>
            : <span className="flex-1 text-xs text-mute">{inEditor ? "The edit's media (or choose a folder to import and cut)" : "Choose a folder of clips"}</span>}
          {listing && <span className="text-2xs text-dim">{counts.video} videos · {counts.audio} audio · {counts.image} pictures{listing.truncated ? " (first 2000)" : ""}</span>}
          <Button size="sm" onClick={() => void chooseFolder()} disabled={phase === "working"}>{folder ? "Change…" : "Choose folder…"}</Button>
        </div>

        {phase !== "preview" && (
          <>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {STYLES.map((x) => (
                <button key={x.id} type="button" onClick={() => setStyle(x.id)} aria-pressed={style === x.id}
                  className={clsx("rounded-xl border p-3 text-left transition-colors", style === x.id ? "border-ai/60 bg-ai/10" : "border-line bg-panel hover:border-dim/50")}>
                  <p className="text-sm font-semibold">{x.name}</p>
                  <p className="mt-1 text-2xs leading-snug text-mute">{x.blurb}</p>
                  <p className="mt-2 text-2xs text-dim">{x.format}{x.target ? ` · ${x.target} s` : ""}</p>
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Target length (seconds)" hint={s.target ? `Default ${s.target} s${s.maxTarget ? `, at most ${s.maxTarget}` : ""}` : "Default: everything good"}>
                <Input value={target} inputMode="numeric" placeholder={s.target ? String(s.target) : "All"} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))} />
              </Field>
              <Field label="Format"><Select value={format} onChange={(e) => setFormat(e.target.value as Format | "")}>
                <option value="">{s.format} (the style's)</option><option value="16:9">16:9 landscape</option><option value="9:16">9:16 vertical</option><option value="1:1">1:1 square</option></Select></Field>
              <Field label="Music" hint={s.music === "needed" ? "Montage cuts on its beats" : undefined}>
                <Select value={music} onChange={(e) => setMusic(e.target.value)}>
                  <option value="none">No music</option>
                  {projectAudio.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  {folderAudio.filter((f) => !projectAudio.some((m) => m.path.toLowerCase() === f.path.toLowerCase())).map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
                  <option value="ai">AI music (priced, you approve it after)</option>
                </Select>
              </Field>
              <Field label="Captions" hint="Free, with local Whisper (Tools)"><Select value={captions} onChange={(e) => setCaptions(e.target.value)}>
                {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
              <Field label="Mood"><Select value={mood} onChange={(e) => setMood(e.target.value)}>
                <option value="">{s.defaultMood ? `${MOODS.find((m) => m.id === s.defaultMood)?.label ?? s.defaultMood} (the style's)` : "None (the style's)"}</option>
                <option value="none">None</option>
                {MOODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></Field>
              <Field label="Transitions"><Select value={transitions} onChange={(e) => setTransitions(e.target.value as TransitionsChoice | "")}>
                <option value="">The style's ({s.transitions})</option><option value="cuts">Hard cuts</option><option value="soft">Soft dissolves</option><option value="style">On the beat / per style</option><option value="none">None</option></Select></Field>
              <Field label="Order"><Select value={order} onChange={(e) => setOrder(e.target.value as OrderChoice)}>
                <option value="name">Series order (names)</option><option value="date">Date taken</option><option value="timecode">Timecode</option><option value="content">Content (openers first)</option></Select></Field>
              <Field label={style === "highlights" ? "Hook title" : "Opening title"}><Input value={title} placeholder={style === "highlights" ? "From the best line" : "None"} onChange={(e) => setTitle(e.target.value)} /></Field>
              <Field label="Add sound effects" hint="Whooshes, pops and hits made on this PC (Auto SFX)"><Select value={sfx} onChange={(e) => setSfx(e.target.value as NonNullable<AutoEditOptions["sfx"]>)}>
                <option value="none">No</option><option value="subtle">Yes, subtle</option><option value="normal">Yes, normal</option><option value="punchy">Yes, punchy</option></Select></Field>
            </div>
            {!inEditor && <Alert tone="info">A new edit called after the folder is made in the library; Create opens it.</Alert>}
          </>
        )}

        {phase === "working" && progress && (
          <div className="rounded-lg border border-line bg-raised/40 p-3">
            <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{progress.step}{progress.total > 1 ? `: ${progress.done} of ${progress.total}` : ""}</p>
            {progress.current && <p className="mt-1 truncate text-2xs text-dim">{progress.current}</p>}
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-ai transition-[width]" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
          </div>
        )}

        {phase === "preview" && plan && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge tone="accent">{plan.summary.clipsUsed} of {plan.summary.clipsIn} clips used</Badge>
              <Badge>{plan.summary.cuts} cuts</Badge>
              {plan.summary.silenceRemoved > 0.05 && <Badge tone="ok">{r1(plan.summary.silenceRemoved)} s of silence removed</Badge>}
              {plan.summary.badRemoved > 0.05 && <Badge tone="warn">{r1(plan.summary.badRemoved)} s of bad picture or sound cut</Badge>}
              <Badge tone="ai">Length {mmss(totalLen)} ({r1(totalLen)} s)</Badge>
              <Badge>{plan.width}×{plan.height}</Badge>
              {plan.mood && <Badge>{plan.mood}</Badge>}
              {plan.captions.length > 0 && <Badge>{plan.captions.length} captions</Badge>}
              {plan.titles.length > 0 && <Badge>{plan.titles.length} title{plan.titles.length === 1 ? "" : "s"}</Badge>}
            </div>
            <div>
              <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-dim">{plan.name}</p>
              <div className="relative h-12 overflow-hidden rounded-lg border border-line bg-black/40">
                {plan.segments.map((x, i) => (
                  <div key={i} className="absolute inset-y-0 border-r border-black/50" title={`${names.get(x.mediaId) ?? x.mediaId}: ${r1(x.in)}–${r1(x.out)} s${x.note ? ` (${x.note})` : ""}`}
                    style={{ left: `${(x.at / Math.max(0.01, totalLen)) * 100}%`, width: `${(x.duration / Math.max(0.01, totalLen)) * 100}%`, background: mediaColor.get(x.mediaId), opacity: x.scale || x.ramp ? 0.75 : 0.95 }} />
                ))}
                {plan.transitions.map((t, i) => <div key={`t${i}`} className="absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${(t.at / Math.max(0.01, totalLen)) * 100}%` }} />)}
              </div>
              {(plan.titles.length > 0 || plan.beds.length > 0) && (
                <div className="relative mt-1 h-3">
                  {plan.titles.map((t, i) => <div key={i} className="absolute h-3 rounded-sm bg-amber-300/70" title={t.text} style={{ left: `${(t.at / Math.max(0.01, totalLen)) * 100}%`, width: `${(t.duration / Math.max(0.01, totalLen)) * 100}%` }} />)}
                </div>
              )}
              {plan.beds.map((bd, i) => <div key={i} className="mt-1 h-2 rounded-sm bg-emerald-400/50" title={`${bd.role}: ${names.get(bd.mediaId) ?? bd.mediaId}`} style={{ width: `${(bd.duration / Math.max(0.01, totalLen)) * 100}%` }} />)}
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-mute">
                {[...mediaColor].map(([id, c]) => <span key={id} className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: c }} />{names.get(id) ?? id}</span>)}
              </div>
            </div>
            {plan.summary.dropped.length > 0 && (
              <div className="rounded-lg border border-line p-2.5 text-xs">
                <p className="mb-1 font-medium">Left out</p>
                <ul className="space-y-0.5 text-mute">{plan.summary.dropped.map((d) => <li key={d.mediaId}>{d.name}: {d.reason}</li>)}</ul>
              </div>
            )}
            {(plan.summary.notes.length > 0 || plan.proposals.length > 0) && (
              <Alert tone="info">{[...plan.summary.notes, ...plan.proposals].map((n, i) => <p key={i}>{n}</p>)}</Alert>
            )}
            <p className="text-2xs text-dim">{describePlan(plan)} Create adds it as one step: Ctrl+Z takes it back.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
