/**
 * News Room: the rundown (docs/EDITOR.md §16.8). Stories as compact rows — slug, headline, second line, reporter,
 * location, key points, ticker lines and status — added by hand, imported from a CSV (Excel's "Save as CSV" too) or
 * pasted one per line, reordered by dragging. **Build** places every story's straps, key points board and ticker lines
 * on its part of the timeline (rundown.ts): the dry run lists what it will do first, it's one undo step, and running
 * it again replaces what it placed before. Jump to a story, mark it here, mark it done.
 */
import { clsx } from "clsx";
import { ChevronRight, Circle, ClipboardPaste, FileUp, GripVertical, Hammer, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Modal, Select, Textarea } from "../../../components/ui";
import { uid } from "../../model/ids";
import { removeClips, ctxOf, addMarker } from "../../model/ops";
import { toTimecode } from "../../model/time";
import type { EditProject } from "../../model/types";
import { program } from "../../playback/transport";
import { project, setFocus, useProject } from "../../store";
import { IBtn, openMenu } from "../../ui";
import { ensureNewsroom } from "../commands";
import { applyBuild, BUILD_PARTS, builtClips, planBuild, RANGE_MODES, storyMarker, storyRanges, type BuildOptions, type BuildPart, type RangeMode } from "../rundown";
import type { GfxTemplate, RundownStory } from "../types";
import { host } from "../room/actions";
import { looksLikeHeader, mapColumns, parseCsv, positional, STORY_COLUMNS, storiesFromLines, storiesFromRows, type StoryColumn } from "../room/csv";
import { moveItem, updateStory } from "../room/doc";
import { lines } from "../room/fields";
import { allTemplates, tplById, useLibraryTemplates, useNewsroomDoc } from "../room/hooks";
import { candidates, WANT } from "../room/pick";
import { LiveText, NoNewsroom, personName, PersonPicker, PlacePicker } from "../room/pickers";
import { useNewsBoot } from "../room/NewNewsEdit";

const STATUS: { id: NonNullable<RundownStory["status"]>; label: string; cls: string }[] = [
  { id: "draft", label: "Draft", cls: "text-dim" }, { id: "ready", label: "Ready", cls: "text-amber-300" }, { id: "done", label: "Done", cls: "text-emerald-400" },
];
const nextStatus = (s: RundownStory["status"]) => STATUS[(STATUS.findIndex((x) => x.id === (s ?? "draft")) + 1) % STATUS.length].id;
const editNr = (label: string, fn: (d: EditProject) => void) => host().apply(label, (d) => { ensureNewsroom(d); fn(d); });

export default function Rundown() {
  useNewsBoot();
  const nr = useNewsroomDoc();
  const p = useProject();
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [build, setBuild] = useState<string[] | null>(null);
  const [paste, setPaste] = useState(false);
  const [csv, setCsv] = useState<{ name: string; rows: string[][] } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  if (!nr) return <div className="pn"><NoNewsroom what="The rundown lists this bulletin's stories; Build puts their straps, key points and ticker lines on the timeline." /></div>;
  const stories = nr.rundown;
  const seq = p.sequences.find((s) => s.id === p.activeSequenceId)!;
  const ranges = storyRanges(seq, stories, "auto");

  const add = () => {
    const id = uid("st");
    editNr("Add story", (d) => { d.newsroom!.rundown.push({ id, slug: `STORY ${d.newsroom!.rundown.length + 1}`, headline: "", status: "draft" }); });
    setOpen(id);
  };
  const jump = (s: RundownStory) => {
    const r = ranges.find((x) => x.storyId === s.id);
    const f = s.start ?? storyMarker(seq, s)?.frame ?? r?.start;
    if (f !== undefined) program.seek(f);
  };
  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text().catch(() => "");
    const rows = parseCsv(text);
    if (!rows.length) { toast.error(`${f.name} has no rows`); return; }
    setCsv({ name: f.name, rows });
  };
  const onDrop = () => {
    if (!drag) return;
    const { from, to } = drag;
    setDrag(null);
    if (from === to || from + 1 === to) return;
    editNr("Move story", (d) => { d.newsroom!.rundown = moveItem(d.newsroom!.rundown, from, to > from ? to - 1 : to); });
  };
  const built = builtClips(seq).length;

  return (
    <div className="pn" data-nr-panel="rundown" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-1">
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={add}>Story</Button>
        <Button size="sm" variant="ghost" icon={<FileUp className="size-3.5" />} onClick={() => file.current?.click()} title="Import a CSV (Excel: File → Save as → CSV)">Import</Button>
        <Button size="sm" variant="ghost" icon={<ClipboardPaste className="size-3.5" />} onClick={() => setPaste(true)} title="Paste stories, one per line">Paste</Button>
        <div className="flex-1" />
        <Button size="sm" variant="primary" icon={<Hammer className="size-3.5" />} disabled={!stories.length} onClick={() => setBuild(stories.map((s) => s.id))} title="Put every story's graphics on the timeline">Build…</Button>
        <IBtn title="More" onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), [
          { label: `Remove built graphics${built ? ` (${built})` : ""}`, disabled: !built, onClick: () => host().apply("Remove built graphics", (d) => { const s = d.sequences.find((x) => x.id === d.activeSequenceId)!; const i = d.sequences.indexOf(s); d.sequences[i] = removeClips(s, ctxOf(d), builtClips(s).map((c) => c.id)); }) },
          { label: "Forget where stories sit", hint: "Build places them again", disabled: !stories.some((s) => s.start !== undefined), onClick: () => editNr("Forget story ranges", (d) => { d.newsroom!.rundown = d.newsroom!.rundown.map(({ start: _s, end: _e, ...x }) => x); }) },
          { label: "Mark every story as draft", onClick: () => editNr("Stories to draft", (d) => { d.newsroom!.rundown = d.newsroom!.rundown.map((x) => ({ ...x, status: "draft" })); }) },
          { label: "Clear the rundown…", danger: true, separator: true, disabled: !stories.length, onClick: () => { if (window.confirm(`Delete all ${stories.length} stories? (Their graphics stay on the timeline.)`)) editNr("Clear rundown", (d) => { d.newsroom!.rundown = []; }); } },
        ])}><MoreHorizontal className="size-4" /></IBtn>
        <input ref={file} type="file" accept=".csv,.tsv,.txt,text/csv" className="hidden" onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      <div className="pn-scroll" onDragOver={(e) => { if (drag) e.preventDefault(); }} onDrop={onDrop}>
        {!stories.length ? (
          <div className="pn-empty">
            <div className="max-w-[260px] space-y-2">
              <p>No stories yet.</p>
              <p className="text-2xs">Add one, paste a list of headlines (one per line), or import a CSV with columns such as Slug, Headline, Reporter, Location, Key points and Ticker.</p>
            </div>
          </div>
        ) : stories.map((s, i) => {
          const r = ranges.find((x) => x.storyId === s.id);
          const st = STATUS.find((x) => x.id === (s.status ?? "draft"))!;
          const isOpen = open === s.id;
          const rep = s.reporter ? nr.people.find((x) => x.id === s.reporter) : undefined;
          return (
            <div key={s.id} data-story={s.id}
              onDragOver={(e) => { if (!drag) return; e.preventDefault(); const b = e.currentTarget.getBoundingClientRect(); const to = e.clientY > b.top + b.height / 2 ? i + 1 : i; if (to !== drag.to) setDrag({ ...drag, to }); }}
              className={clsx("border-b border-line", drag?.to === i && "shadow-[inset_0_2px_0_var(--color-accent)]", drag?.to === i + 1 && i === stories.length - 1 && "shadow-[inset_0_-2px_0_var(--color-accent)]")}>
              <div className={clsx("pn-row cursor-pointer gap-1.5 py-1", isOpen && "sel", s.status === "done" && "opacity-60")} onClick={() => setOpen(isOpen ? null : s.id)}
                onContextMenu={(e) => { e.preventDefault(); openMenu(e, storyMenu(s, i)); }}>
                <span draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.slug); setDrag({ from: i, to: i }); }} onDragEnd={() => setDrag(null)}
                  onClick={(e) => e.stopPropagation()} className="cursor-grab text-dim hover:text-ink" title="Drag to reorder"><GripVertical className="size-3.5" /></span>
                <button type="button" title={`${st.label} — click to change`} onClick={(e) => { e.stopPropagation(); editNr(`Story ${nextStatus(s.status)}`, (d) => { Object.assign(d, updateStory(d, s.id, { status: nextStatus(s.status) })); }); }}
                  className={clsx("shrink-0", st.cls)}><Circle className={clsx("size-2.5", s.status && s.status !== "draft" && "fill-current")} /></button>
                <ChevronRight className={clsx("size-3 shrink-0 text-dim transition-transform", isOpen && "rotate-90")} />
                <span className="w-[5.5rem] shrink-0 truncate text-2xs font-semibold tracking-wide">{s.slug || "—"}</span>
                <span className="min-w-0 flex-1 truncate text-xs">{s.headline || <span className="text-dim">No headline</span>}{rep ? <span className="text-dim"> · {rep.name}</span> : null}</span>
                {r && <button type="button" className="mono shrink-0 rounded px-1 text-[10px] text-dim hover:bg-hover hover:text-ink" title={`Go to this story (${r.from === "story" ? "built here" : r.from === "marker" ? "its marker" : "its share of the sequence"})`}
                  onClick={(e) => { e.stopPropagation(); jump(s); }}>{toTimecode(s.start ?? r.start, seq.fps).slice(3, 8)}</button>}
              </div>
              {isOpen && <StoryEditor s={s} onBuild={() => setBuild([s.id])} onJump={() => jump(s)} />}
            </div>
          );
        })}
      </div>
      <div className="ed-bar bottom text-2xs text-dim">{stories.length} stor{stories.length === 1 ? "y" : "ies"} · {stories.filter((s) => s.status === "done").length} done{built ? ` · ${built} graphics built` : ""}</div>
      {build && <BuildDialog only={build.length === stories.length ? undefined : build} onClose={() => setBuild(null)} />}
      {paste && <PasteDialog onClose={() => setPaste(false)} />}
      {csv && <CsvDialog name={csv.name} rows={csv.rows} onClose={() => setCsv(null)} />}
    </div>
  );

  function storyMenu(s: RundownStory, i: number) {
    const mine = builtClips(seq, s.id);
    return [
      { label: "Build this story…", onClick: () => setBuild([s.id]) },
      { label: "Go to this story", onClick: () => jump(s) },
      { label: "Starts here", hint: "playhead", separator: true, onClick: () => editNr("Story start", (d) => { Object.assign(d, updateStory(d, s.id, { start: program.frame, end: Math.max(program.frame + 1, s.end ?? program.frame + 1) })); }) },
      { label: "Ends here", hint: "playhead", disabled: (s.start ?? r0(s)) >= program.frame, onClick: () => editNr("Story end", (d) => { Object.assign(d, updateStory(d, s.id, { start: s.start ?? r0(s), end: program.frame })); }) },
      { label: "Add a story marker here", onClick: () => host().apply("Story marker", (d) => { const q = d.sequences.find((x) => x.id === d.activeSequenceId)!; q.markers = addMarker(q.markers, program.frame, { name: s.slug || s.headline, color: "#38bdf8", kind: "chapter" }); }) },
      { label: "Mark as done", separator: true, disabled: s.status === "done", onClick: () => editNr("Story done", (d) => { Object.assign(d, updateStory(d, s.id, { status: "done" })); }) },
      { label: "Move up", disabled: i === 0, onClick: () => editNr("Move story", (d) => { d.newsroom!.rundown = moveItem(d.newsroom!.rundown, i, i - 1); }) },
      { label: "Move down", disabled: i === stories.length - 1, onClick: () => editNr("Move story", (d) => { d.newsroom!.rundown = moveItem(d.newsroom!.rundown, i, i + 1); }) },
      { label: `Remove its graphics${mine.length ? ` (${mine.length})` : ""}`, separator: true, disabled: !mine.length, onClick: () => host().apply("Remove story graphics", (d) => { const k = d.sequences.findIndex((x) => x.id === d.activeSequenceId); d.sequences[k] = removeClips(d.sequences[k], ctxOf(d), mine.map((c) => c.id)); }) },
      { label: "Delete story", danger: true, onClick: () => { editNr("Delete story", (d) => { d.newsroom!.rundown = d.newsroom!.rundown.filter((x) => x.id !== s.id); }); if (open === s.id) setOpen(null); } },
    ];
  }
  function r0(s: RundownStory) { return ranges.find((x) => x.storyId === s.id)?.start ?? 0; }
}

// ── one story ────────────────────────────────────────────────────────────────

function StoryEditor({ s, onBuild, onJump }: { s: RundownStory; onBuild: () => void; onJump: () => void }) {
  const nr = useNewsroomDoc()!;
  const p = useProject();
  const fps = p.sequences.find((x) => x.id === p.activeSequenceId)?.fps ?? 25;
  const k = (f: string) => `story:${s.id}:${f}`;
  const T = (f: keyof RundownStory, label: string, o: { multiline?: boolean; list?: boolean; placeholder?: string } = {}) => (
    <label className="grid gap-0.5">
      <span className="text-[10px] text-dim">{label}</span>
      <LiveText multiline={o.multiline || o.list} rows={o.list ? 3 : 2} placeholder={o.placeholder} liveKey={k(f)} label={`Story ${label.toLowerCase()}`}
        value={o.list ? ((s[f] as string[] | undefined) ?? []).join("\n") : String(s[f] ?? "")}
        make={(b, v) => updateStory(b, s.id, { [f]: o.list ? lines(v) : f === "slug" ? v.toUpperCase() : v })} />
    </label>
  );
  const rep = s.reporter ? nr.people.find((x) => x.id === s.reporter) : undefined;
  const set = (label: string, patch: Partial<RundownStory>) => editNr(label, (d) => { Object.assign(d, updateStory(d, s.id, patch)); });
  return (
    <div className="grid gap-2 bg-raised/30 px-3 pb-3 pt-1.5 text-xs" onKeyDown={(e) => e.stopPropagation()}>
      <div className="grid grid-cols-[6.5rem_1fr] gap-2">{T("slug", "Slug")}{T("headline", "Headline", { placeholder: "What the strap says" })}</div>
      {T("strap", "Second line", { placeholder: "Optional" })}
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-0.5">
          <span className="text-[10px] text-dim">Reporter</span>
          <div className="flex items-center gap-1">
            <span className={clsx("min-w-0 flex-1 truncate", !rep && "text-dim")}>{rep ? personName(rep) : "None"}</span>
            <PersonPicker people={nr.people} label="Pick" onPick={(x) => set(`Reporter ${x.name}`, { reporter: x.id, ...(s.location ? {} : x.location ? { location: x.location } : {}) })} />
            {rep && <button type="button" className="text-2xs text-dim hover:text-ink" onClick={() => set("No reporter", { reporter: undefined })}>×</button>}
          </div>
        </div>
        <div className="grid gap-0.5">
          <span className="text-[10px] text-dim">Location</span>
          <div className="flex items-center gap-1">
            <LiveText value={s.location ?? ""} liveKey={k("location")} label="Story location" make={(b, v) => updateStory(b, s.id, { location: v || undefined })} />
            {nr.places.length > 0 && <PlacePicker places={nr.places} onPick={(x) => set(`Location ${x.name}`, { location: x.name })} />}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">{T("points", "Key points (one per line)", { list: true })}{T("ticker", "Ticker lines (one per line)", { list: true })}</div>
      {T("notes", "Notes", { multiline: true })}
      <div className="flex flex-wrap items-center gap-1.5 text-2xs text-dim">
        <span className="mono">{s.start !== undefined && s.end !== undefined ? `${toTimecode(s.start, fps)} – ${toTimecode(s.end, fps)}` : "Not placed yet"}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onJump}>Go to</Button>
        <Button size="sm" variant="secondary" icon={<Hammer className="size-3" />} onClick={onBuild}>Build this story</Button>
      </div>
    </div>
  );
}

// ── Build ────────────────────────────────────────────────────────────────────

const WANTS: Record<BuildPart, typeof WANT[keyof typeof WANT]> = { headline: WANT.headlineStrap, reporter: WANT.reporterStrap, points: WANT.keyPoints, ticker: WANT.ticker };
const LS_BUILD = "tatvam-editor:nr-build:v1";
interface BuildPrefs { parts: Record<BuildPart, boolean>; templates: Partial<Record<BuildPart, string>>; ranges: RangeMode }
const loadPrefs = (): BuildPrefs => {
  const d: BuildPrefs = { parts: { headline: true, reporter: true, points: true, ticker: true }, templates: {}, ranges: "auto" };
  try { const v = JSON.parse(localStorage.getItem(LS_BUILD) ?? "null") as BuildPrefs | null; return v ? { ...d, ...v, parts: { ...d.parts, ...v.parts } } : d; } catch { return d; }
};

function BuildDialog({ only, onClose }: { only?: string[]; onClose: () => void }) {
  const p = useProject();
  const library = useLibraryTemplates();
  const [prefs, setPrefs] = useState<BuildPrefs>(loadPrefs);
  useEffect(() => { try { localStorage.setItem(LS_BUILD, JSON.stringify(prefs)); } catch { /* blocked */ } }, [prefs]);
  const all = useMemo(() => allTemplates(p, library), [p.newsroom?.templates, library]); // eslint-disable-line react-hooks/exhaustive-deps
  const choices = useMemo(() => Object.fromEntries(BUILD_PARTS.map(({ part }) => [part, candidates(all, WANTS[part])])) as Record<BuildPart, GfxTemplate[]>, [all]);
  const chosen = (part: BuildPart) => choices[part].find((t) => t.id === prefs.templates[part]) ?? choices[part][0];
  const opts: BuildOptions = {
    parts: prefs.parts, ranges: prefs.ranges, only, readSpeed: p.newsroom?.settings?.readSpeed,
    templates: Object.fromEntries(BUILD_PARTS.map(({ part }) => [part, chosen(part)]).filter(([, t]) => t)),
    templateById: (id) => tplById(project(), id),
  };
  const plan = useMemo(() => planBuild(p, opts), [p, prefs, only, choices]); // eslint-disable-line react-hooks/exhaustive-deps
  const seq = p.sequences.find((s) => s.id === plan.seqId);
  const fps = seq?.fps ?? 25;
  const run = () => {
    let n = 0;
    host().apply(only?.length === 1 ? `Build ${p.newsroom?.rundown.find((s) => s.id === only[0])?.slug ?? "story"}` : "Build rundown", (d) => { n = applyBuild(d, planBuild(d, opts)).length; });
    toast.success(`${n} graphic${n === 1 ? "" : "s"} placed${plan.remove.length ? `, ${plan.remove.length} from the last build replaced` : ""}`);
    onClose();
  };
  const slugOf = (id: string) => p.newsroom?.rundown.find((s) => s.id === id)?.slug ?? "";
  const partLabel = (x: BuildPart) => BUILD_PARTS.find((b) => b.part === x)!.label;
  return (
    <Modal open onClose={onClose} title={only?.length === 1 ? `Build ${slugOf(only[0])}` : "Build the rundown"} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!plan.items.length} onClick={run}>Build {plan.items.length} graphic{plan.items.length === 1 ? "" : "s"}</Button></>}>
      <div className="grid gap-4 md:grid-cols-[1fr_1.2fr]">
        <div className="grid content-start gap-3">
          <p className="eyebrow">What to place</p>
          {BUILD_PARTS.map(({ part, label, hint }) => (
            <div key={part} className="grid gap-1">
              <label className="flex items-center gap-2 text-sm" title={hint}>
                <input type="checkbox" checked={prefs.parts[part]} onChange={(e) => setPrefs({ ...prefs, parts: { ...prefs.parts, [part]: e.target.checked } })} />{label}
              </label>
              {prefs.parts[part] && (choices[part].length ? (
                <Select className="!h-8 text-xs" value={chosen(part)?.id ?? ""} onChange={(e) => setPrefs({ ...prefs, templates: { ...prefs.templates, [part]: e.target.value } })}>
                  {choices[part].map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              ) : <p className="text-2xs text-dim">No template of this kind yet.</p>)}
            </div>
          ))}
          <p className="eyebrow mt-1">Where each story sits</p>
          <Select className="!h-8 text-xs" value={prefs.ranges} onChange={(e) => setPrefs({ ...prefs, ranges: e.target.value as RangeMode })}>
            {RANGE_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
          <p className="text-2xs text-dim">{RANGE_MODES.find((m) => m.id === prefs.ranges)?.hint}</p>
        </div>
        <div className="grid content-start gap-2">
          <p className="eyebrow">What Build will do</p>
          {plan.remove.length > 0 && <p className="text-xs text-mute">Replaces {plan.remove.length} graphic{plan.remove.length === 1 ? "" : "s"} from the last build.</p>}
          <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
            {!plan.items.length ? <p className="p-3 text-xs text-dim">Nothing to place.</p> : [...plan.items].sort((a, b) => a.at - b.at).map((it, i) => (
              <div key={i} className="pn-row gap-2 border-b border-line py-1 text-xs last:border-0">
                <span className="mono w-[4.5rem] shrink-0 text-2xs text-dim">{toTimecode(it.at, fps).slice(3)}</span>
                <span className="w-20 shrink-0 truncate text-2xs font-semibold">{it.slug}</span>
                <span className="min-w-0 flex-1 truncate">{partLabel(it.part)} <span className="text-dim">· {it.template.name}</span></span>
                <span className="mono shrink-0 text-2xs text-dim">{(it.duration / fps).toFixed(1)} s</span>
              </div>
            ))}
          </div>
          {plan.notes.map((n, i) => <p key={i} className="text-2xs text-amber-300/90">{n}</p>)}
        </div>
      </div>
    </Modal>
  );
}

// ── import ───────────────────────────────────────────────────────────────────

function PasteDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const stories = useMemo(() => storiesFromLines(text, () => "x"), [text]);
  const ok = () => {
    const list = storiesFromLines(text, uid);
    editNr(`Paste ${list.length} stories`, (d) => { d.newsroom!.rundown.push(...list); });
    toast.success(`${list.length} stor${list.length === 1 ? "y" : "ies"} added`);
    onClose();
  };
  return (
    <Modal open onClose={onClose} title="Paste stories" size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!stories.length} onClick={ok}>Add {stories.length || ""} stor{stories.length === 1 ? "y" : "ies"}</Button></>}>
      <p className="mb-2 text-xs text-mute">One story per line: just the headline, or <span className="mono text-ink">SLUG | Headline | second line</span>. A paste from a spreadsheet works too.</p>
      <Textarea data-autofocus rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={"PUNE RAINS | Heavy rain lashes Pune | Schools shut on Friday\nSensex ends 400 points higher"} />
      {stories.length > 0 && <p className="mt-2 text-2xs text-dim">First: <span className="font-semibold text-mute">{stories[0].slug}</span> · {stories[0].headline}</p>}
    </Modal>
  );
}

function CsvDialog({ name, rows, onClose }: { name: string; rows: string[][]; onClose: () => void }) {
  const nr = useNewsroomDoc();
  const [header, setHeaderState] = useState(() => looksLikeHeader(rows[0]));
  const [mapping, setMapping] = useState<Record<StoryColumn, number>>(() => (looksLikeHeader(rows[0]) ? mapColumns(rows[0]) : positional(rows[0].length)));
  const setHeader = (h: boolean) => { setHeaderState(h); setMapping(h ? mapColumns(rows[0]) : positional(rows[0].length)); };
  const [replace, setReplace] = useState(false);
  const heads = header ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`);
  const result = useMemo(() => storiesFromRows(rows, nr?.people ?? [], () => "x", { mapping, header }), [rows, mapping, header, nr?.people]);
  const ok = () => {
    const r = storiesFromRows(rows, project().newsroom?.people ?? [], uid, { mapping, header });
    editNr(`Import ${r.stories.length} stories`, (d) => {
      const n = d.newsroom!;
      n.people = [...(n.people ?? []), ...r.people];
      n.rundown = replace ? r.stories : [...n.rundown, ...r.stories];
    });
    toast.success(`${r.stories.length} stor${r.stories.length === 1 ? "y" : "ies"} imported${r.people.length ? `, ${r.people.length} reporter${r.people.length === 1 ? "" : "s"} added to People` : ""}`);
    onClose();
  };
  return (
    <Modal open onClose={onClose} title={`Import ${name}`} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!result.stories.length} onClick={ok}>{replace ? "Replace the rundown" : "Add"} ({result.stories.length})</Button></>}>
      <div className="grid gap-3">
        <p className="text-xs text-mute">{rows.length} row{rows.length === 1 ? "" : "s"}. Check which column holds what (found by the header names):</p>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />The first row is the column names</label>
        <div className="grid gap-x-3 gap-y-1.5 sm:grid-cols-2">
          {STORY_COLUMNS.map((c) => (
            <label key={c.key} className="grid grid-cols-[6.5rem_1fr] items-center gap-2 text-xs">
              <span className="text-mute">{c.label}</span>
              <Select className="!h-7 text-xs" value={mapping[c.key]} onChange={(e) => setMapping({ ...mapping, [c.key]: Number(e.target.value) })}>
                <option value={-1}>—</option>
                {heads.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </Select>
            </label>
          ))}
        </div>
        <div className="rounded-lg border border-line p-2 text-xs">
          {result.stories.slice(0, 3).map((s) => <p key={s.id + s.slug + s.headline} className="truncate"><span className="font-semibold">{s.slug}</span> · {s.headline}{s.points?.length ? <span className="text-dim"> · {s.points.length} points</span> : null}</p>)}
          {result.stories.length > 3 && <p className="text-dim">… and {result.stories.length - 3} more</p>}
          {!result.stories.length && <p className="text-dim">No stories: choose the Headline or Slug column.</p>}
        </div>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />Replace the stories already in the rundown</label>
      </div>
    </Modal>
  );
}
