/**
 * Project panel (docs/EDITOR.md §3): bins as folders, list and icon views, import (button, Ctrl+I, drop from
 * Explorer), search, metadata, relink missing media, new sequence from a clip, and dragging clips or sequences into
 * the timeline or the Source monitor. Icon view scrubs a clip's filmstrip under the pointer.
 */
import { clsx } from "clsx";
import {
  AudioLines, ChevronDown, ChevronRight, Clapperboard, Film, Folder, FolderOpen, FolderPlus, Image as ImageIcon, LayoutGrid, List, Plus, TriangleAlert, Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchField } from "../../components/ui";
import * as A from "../actions";
import { openDialog } from "../dialogs";
import { isFileDrag, startDrag } from "../dnd";
import { LABEL_COLORS } from "../model/defaults";
import { seqEnd } from "../model/ops";
import { fpsLabel, shortDuration } from "../model/time";
import type { Bin, MediaItem, Sequence } from "../model/types";
import { importDropped, importFiles, makeProxy, relink } from "../session";
import { setFocus, urlFor, useEditor, useProject } from "../store";
import { IBtn, openMenu, type MenuItem } from "../ui";
import { loadImage } from "../timeline/draw";
import { GeneratorRows } from "../audiofx/GeneratorRows";
import { openAutoEdit } from "../../automation/api"; // desktop-mcp: the Auto edit dialog (additive)

type View = "list" | "icon";
const LS_VIEW = "tatvam-editor:project-view";

const kindIcon = (m: MediaItem) => (m.kind === "audio" ? AudioLines : m.kind === "image" ? ImageIcon : Film);
const durOf = (m: MediaItem) => shortDuration(A.displayLength(m), A.displayFps(m));

export default function ProjectPanel() {
  const p = useProject();
  const sourceId = useEditor((x) => x.sourceId);
  const [view, setView] = useState<View>(() => { try { return (localStorage.getItem(LS_VIEW) as View) || "list"; } catch { return "list"; } });
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [overBin, setOverBin] = useState<string | null | undefined>(undefined);
  const [rename, setRename] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { try { localStorage.setItem(LS_VIEW, view); } catch { /* blocked */ } }, [view]);
  useEffect(() => {
    const reveal = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const m = p.media.find((x) => x.id === id);
      if (!m) return;
      setQ(""); setSel([id]);
      if (m.binId) setOpen((o) => ({ ...o, [m.binId!]: true }));
      window.setTimeout(() => document.querySelector(`[data-media="${id}"]`)?.scrollIntoView({ block: "nearest" }), 30);
    };
    window.addEventListener("ed:reveal", reveal);
    return () => window.removeEventListener("ed:reveal", reveal);
  }, [p.media]);

  const ql = q.trim().toLowerCase();
  const match = (m: MediaItem) => !ql || m.name.toLowerCase().includes(ql) || (m.comment ?? "").toLowerCase().includes(ql) || m.path.toLowerCase().includes(ql);
  const items = useMemo(() => p.media.filter(match), [p.media, ql]);
  const selected = p.media.filter((m) => sel.includes(m.id));
  const first = selected[0];

  const click = (e: React.MouseEvent, id: string) => {
    setFocus("project");
    if (e.shiftKey || e.ctrlKey || e.metaKey) setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    else setSel([id]);
  };
  const dragItems = (e: React.DragEvent, m: MediaItem) => {
    const ids = sel.includes(m.id) ? sel : [m.id];
    startDrag(e, { kind: "media", items: ids.map((mediaId) => ({ mediaId })) }, ids.length > 1 ? `${ids.length} clips` : m.name);
  };
  const mediaMenu = (m: MediaItem): MenuItem[] => {
    const ids = sel.includes(m.id) ? sel : [m.id];
    return [
      { label: "Open in Source monitor", onClick: () => A.openInSource(m.id) },
      { label: "Insert at playhead", shortcut: ",", onClick: () => A.sourceEdit("insert", { mediaId: m.id }) },
      { label: "Overwrite at playhead", shortcut: ".", onClick: () => A.sourceEdit("overwrite", { mediaId: m.id }) },
      { label: "New sequence from clip", separator: true, onClick: () => A.sequenceFromClip(m.id) },
      { label: "Rename…", onClick: () => openDialog({ kind: "prompt", title: "Rename clip", label: "Name", value: m.name, ok: "Rename", onOk: (v) => A.updateMediaItem(m.id, (x) => ({ ...x, name: v }), "Rename media") }) },
      { label: "Label", items: [{ label: "None", onClick: () => ids.forEach((id) => A.updateMediaItem(id, (x) => { const y = { ...x }; delete y.colorLabel; return y; }, "Label")) },
        ...LABEL_COLORS.map((l) => ({ label: l.label, checked: m.colorLabel === l.id, onClick: () => ids.forEach((id) => A.updateMediaItem(id, (x) => ({ ...x, colorLabel: l.id }), "Label")) }))] },
      { label: "Move to bin", items: [{ label: "Project (no bin)", onClick: () => A.moveToBin(ids, null) }, ...p.bins.map((b) => ({ label: b.name, onClick: () => A.moveToBin(ids, b.id) }))] },
      { label: m.missing || m.offline ? "Relink…" : "Replace / relink…", separator: true, onClick: () => void relink(m.id) },
      m.kind === "video" ? { label: m.proxyPath ? "Remake proxy" : "Make proxy", onClick: () => void makeProxy(m.id) } : null,
      { label: ids.length > 1 ? `Remove ${ids.length} items` : "Remove from project", danger: true, separator: true, onClick: () => A.removeMedia(ids) },
    ].filter(Boolean) as MenuItem[];
  };
  const binMenu = (b: Bin): MenuItem[] => [
    { label: "New bin inside", onClick: () => { const id = A.newBin("New bin", b.id); setOpen((o) => ({ ...o, [b.id]: true })); setRename(id); } },
    { label: "Rename…", onClick: () => setRename(b.id) },
    { label: "Delete bin", danger: true, separator: true, hint: "items move up", onClick: () => A.deleteBin(b.id) },
  ];

  const onDropTo = async (e: React.DragEvent, binId: string | null) => {
    setOverBin(undefined);
    if (isFileDrag(e) && e.dataTransfer.files.length) { e.preventDefault(); await importDropped(e.dataTransfer.files, binId); return; }
    const raw = e.dataTransfer.getData("application/x-tatvam-editor");
    if (raw) {
      e.preventDefault();
      try { const pay = JSON.parse(raw); if (pay.kind === "media") A.moveToBin(pay.items.map((x: { mediaId: string }) => x.mediaId), binId); } catch { /* not ours */ }
    }
  };

  const binTree = (parent: string | null, depth: number): React.ReactNode => p.bins.filter((b) => b.parentId === parent).sort((a, b) => a.name.localeCompare(b.name)).map((b) => {
    const isOpen = open[b.id] ?? true;
    const inside = items.filter((m) => m.binId === b.id);
    if (ql && !inside.length && !p.bins.some((x) => x.parentId === b.id)) return null;
    return (
      <div key={b.id}>
        <div className={clsx("pn-row", overBin === b.id && "bg-accent/15")} style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => setOpen((o) => ({ ...o, [b.id]: !isOpen }))} onContextMenu={(e) => { e.preventDefault(); openMenu(e, binMenu(b)); }}
          onDragOver={(e) => { e.preventDefault(); setOverBin(b.id); }} onDragLeave={() => setOverBin(undefined)} onDrop={(e) => void onDropTo(e, b.id)}>
          {isOpen ? <ChevronDown className="size-3 text-dim" /> : <ChevronRight className="size-3 text-dim" />}
          {isOpen ? <FolderOpen className="size-3.5 text-warn" /> : <Folder className="size-3.5 text-warn" />}
          {rename === b.id ? (
            <input autoFocus defaultValue={b.name} className="ed-field h-5 flex-1" onClick={(e) => e.stopPropagation()}
              onBlur={(e) => { if (e.target.value.trim()) A.renameBin(b.id, e.target.value.trim()); setRename(null); }}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRename(null); }} />
          ) : <span className="flex-1 truncate font-medium" onDoubleClick={(e) => { e.stopPropagation(); setRename(b.id); }}>{b.name}</span>}
          <span className="mono text-2xs text-dim">{inside.length}</span>
        </div>
        {isOpen && (
          <>
            {binTree(b.id, depth + 1)}
            {view === "list" ? inside.map((m) => <MediaRow key={m.id} m={m} depth={depth + 1} sel={sel.includes(m.id)} inSource={sourceId === m.id} onClick={click} onDrag={dragItems} onMenu={mediaMenu} />)
              : <IconGrid items={inside} sel={sel} onClick={click} onDrag={dragItems} onMenu={mediaMenu} />}
          </>
        )}
      </div>
    );
  });
  const loose = items.filter((m) => !m.binId);
  const seqs = p.sequences.filter((s) => !ql || s.name.toLowerCase().includes(ql));

  return (
    <div className="pn @container" tabIndex={-1} onPointerDown={() => setFocus("project")}
      onKeyDown={(e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && sel.length && !(e.target as HTMLElement).closest("input,textarea")) { e.preventDefault(); A.removeMedia(sel); setSel([]); }
        else if (e.key === "Enter" && sel.length === 1 && !(e.target as HTMLElement).closest("input,textarea")) { e.preventDefault(); A.openInSource(sel[0]); }
      }}
      onDragOver={(e) => { if (isFileDrag(e)) { e.preventDefault(); if (overBin === undefined) setOverBin(null); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverBin(undefined); }}
      onDrop={(e) => void onDropTo(e, null)}>
      <div className="ed-bar">
        <IBtn title="Import media" shortcut="Ctrl+I" onClick={() => void importFiles()}><Upload className="size-3.5" /></IBtn>
        <IBtn title="New bin" onClick={() => { const id = A.newBin(); setRename(id); }}><FolderPlus className="size-3.5" /></IBtn>
        <IBtn title="New item" onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), [
          { label: "Sequence…", onClick: () => openDialog({ kind: "newSequence" }) },
          { label: "Title", shortcut: "T", onClick: () => A.newTitle() },
          { label: "Colour matte", onClick: () => A.newMatte("color") },
          { label: "Adjustment layer", onClick: () => A.newMatte("adjustment") },
          { label: "Sound effects…", onClick: () => window.dispatchEvent(new CustomEvent("ed:panel", { detail: "sfx" })) },
          { label: "Auto edit…", separator: true, onClick: () => openAutoEdit() },
        ])}><Plus className="size-3.5" /></IBtn>
        <SearchField ref={searchRef} value={q} onChange={setQ} placeholder="Search" className="mx-1 min-w-0 flex-1 [&_input]:h-6 [&_input]:text-xs" />
        <div className="ed-seg">
          <button type="button" aria-pressed={view === "list"} title="List view" onClick={() => setView("list")}><List className="size-3.5" /></button>
          <button type="button" aria-pressed={view === "icon"} title="Icon view" onClick={() => setView("icon")}><LayoutGrid className="size-3.5" /></button>
        </div>
      </div>
      <div className={clsx("pn-scroll", overBin === null && "ring-2 ring-inset ring-accent/60")}>
        {seqs.length > 0 && (
          <div>
            <div className="pn-section" onClick={() => setOpen((o) => ({ ...o, __seq: !(o.__seq ?? true) }))}>
              {(open.__seq ?? true) ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}Sequences<span className="mono ml-auto text-dim">{seqs.length}</span>
            </div>
            {(open.__seq ?? true) && seqs.map((s) => <SequenceRow key={s.id} s={s} active={s.id === p.activeSequenceId} />)}
          </div>
        )}
        <div className="pn-section" onClick={() => setOpen((o) => ({ ...o, __media: !(o.__media ?? true) }))}>
          {(open.__media ?? true) ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}Media<span className="mono ml-auto text-dim">{items.length}{ql ? ` of ${p.media.length}` : ""}</span>
        </div>
        {(open.__media ?? true) && (
          <>
            {binTree(null, 0)}
            {view === "list" ? loose.map((m) => <MediaRow key={m.id} m={m} depth={0} sel={sel.includes(m.id)} inSource={sourceId === m.id} onClick={click} onDrag={dragItems} onMenu={mediaMenu} />)
              : <IconGrid items={loose} sel={sel} onClick={click} onDrag={dragItems} onMenu={mediaMenu} />}
            {!p.media.length && (
              <div className="p-6 text-center text-xs text-dim">
                <Upload className="mx-auto mb-2 size-6" />
                Import video, audio and pictures (Ctrl+I), or drop files here from Explorer.
              </div>
            )}
          </>
        )}
        <GeneratorRows filter={q} />
      </div>
      {first && <Metadata m={first} count={selected.length} />}
    </div>
  );
}

function MediaRow({ m, depth, sel, inSource, onClick, onDrag, onMenu }: {
  m: MediaItem; depth: number; sel: boolean; inSource: boolean;
  onClick: (e: React.MouseEvent, id: string) => void; onDrag: (e: React.DragEvent, m: MediaItem) => void; onMenu: (m: MediaItem) => MenuItem[];
}) {
  const I = kindIcon(m);
  const label = m.colorLabel ? LABEL_COLORS.find((l) => l.id === m.colorLabel)?.css : undefined;
  const offline = m.missing || m.offline || !urlFor(m);
  return (
    <div data-media={m.id} className={clsx("pn-row cursor-default", sel && "sel")} style={{ paddingLeft: 10 + depth * 14 }} draggable
      onDragStart={(e) => onDrag(e, m)} onClick={(e) => onClick(e, m.id)} onDoubleClick={() => A.openInSource(m.id)}
      onContextMenu={(e) => { e.preventDefault(); onClick(e, m.id); openMenu(e, onMenu(m)); }}>
      <span className="block h-3.5 w-1 shrink-0 rounded-full" style={{ background: label ?? "transparent" }} />
      {m.thumb ? <img src={m.thumb} alt="" className="h-5 w-9 shrink-0 rounded-sm object-cover" draggable={false} /> : <I className="size-3.5 shrink-0 text-mute" />}
      <span className={clsx("min-w-0 flex-1 truncate", inSource && "text-accent-ink")} title={m.path}>{m.name}</span>
      {offline && <TriangleAlert className="size-3.5 shrink-0 text-bad" aria-label="Offline" />}
      <span className="mono w-14 shrink-0 text-right text-2xs text-dim">{durOf(m)}</span>
      <span className="mono hidden w-16 shrink-0 text-right text-2xs text-dim @[420px]:inline">{m.kind === "audio" ? `${m.audioChannels ?? ""}ch` : m.width ? `${m.width}×${m.height}` : ""}</span>
    </div>
  );
}

function IconGrid({ items, sel, onClick, onDrag, onMenu }: {
  items: MediaItem[]; sel: string[]; onClick: (e: React.MouseEvent, id: string) => void; onDrag: (e: React.DragEvent, m: MediaItem) => void; onMenu: (m: MediaItem) => MenuItem[];
}) {
  if (!items.length) return null;
  return (
    <div className="grid gap-2 p-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))" }}>
      {items.map((m) => <IconCard key={m.id} m={m} sel={sel.includes(m.id)} onClick={onClick} onDrag={onDrag} onMenu={onMenu} />)}
    </div>
  );
}

function IconCard({ m, sel, onClick, onDrag, onMenu }: {
  m: MediaItem; sel: boolean; onClick: (e: React.MouseEvent, id: string) => void; onDrag: (e: React.DragEvent, m: MediaItem) => void; onMenu: (m: MediaItem) => MenuItem[];
}) {
  const [scrub, setScrub] = useState<number | null>(null);
  const [frames, setFrames] = useState(0);
  const I = kindIcon(m);
  useEffect(() => {
    if (scrub === null || frames || !m.filmstrip) return;
    const aspect = m.width > 0 && m.height > 0 ? m.width / m.height : 16 / 9;
    void loadImage(m.filmstrip).then((img) => { if (img) setFrames(Math.max(1, Math.round(img.naturalWidth / (img.naturalHeight * aspect)))); });
  }, [scrub, frames, m.filmstrip, m.width, m.height]);
  const pic = scrub !== null && m.filmstrip ? m.filmstrip : m.thumb;
  return (
    <div data-media={m.id} draggable onDragStart={(e) => onDrag(e, m)} onClick={(e) => onClick(e, m.id)} onDoubleClick={() => A.openInSource(m.id)}
      onContextMenu={(e) => { e.preventDefault(); onClick(e, m.id); openMenu(e, onMenu(m)); }}
      className={clsx("overflow-hidden rounded-lg border bg-raised", sel ? "border-accent/70 ring-1 ring-accent/40" : "border-line hover:border-dim/50")}>
      <div className="relative aspect-video bg-black/60"
        onMouseMove={(e) => { if (!m.filmstrip) return; const r = e.currentTarget.getBoundingClientRect(); setScrub(Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width))); }}
        onMouseLeave={() => setScrub(null)}>
        {pic ? (
          scrub !== null && m.filmstrip && frames > 1 ? (
            <div className="absolute inset-0" style={{ backgroundImage: `url(${m.filmstrip})`, backgroundSize: `${frames * 100}% 100%`, backgroundPosition: `${(Math.floor(scrub * frames) / (frames - 1)) * 100}% 0` }} />
          ) : <img src={pic} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
        ) : <div className="absolute inset-0 grid place-items-center text-dim"><I className="size-6" /></div>}
        {scrub !== null && <div className="absolute bottom-0 top-0 w-px bg-bad" style={{ left: `${scrub * 100}%` }} />}
        <span className="mono absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white/90">{durOf(m)}</span>
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1"><I className="size-3 shrink-0 text-dim" /><span className="truncate text-2xs">{m.name}</span></div>
    </div>
  );
}

function SequenceRow({ s, active }: { s: Sequence; active: boolean }) {
  return (
    <div className={clsx("pn-row cursor-default", active && "sel")} draggable
      onDragStart={(e) => startDrag(e, { kind: "sequence", sequenceId: s.id }, s.name)}
      onDoubleClick={() => A.openSequence(s.id)}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e, [
        { label: "Open in timeline", onClick: () => A.openSequence(s.id) },
        { label: "Rename…", onClick: () => openDialog({ kind: "prompt", title: "Rename sequence", label: "Name", value: s.name, ok: "Rename", onOk: (v) => A.renameSequence(s.id, v) }) },
        { label: "Duplicate", onClick: () => A.duplicateSequence(s.id) },
        { label: "Delete sequence", danger: true, separator: true, onClick: () => A.deleteSequence(s.id) },
      ]); }}>
      <Clapperboard className={clsx("ml-1 size-3.5 shrink-0", active ? "text-accent-ink" : "text-mute")} />
      <span className="min-w-0 flex-1 truncate">{s.name}</span>
      <span className="mono shrink-0 text-2xs text-dim">{s.width}×{s.height} · {fpsLabel(s.fps).replace(" fps", "")}</span>
      <span className="mono w-14 shrink-0 text-right text-2xs text-dim">{shortDuration(seqEnd(s), s.fps)}</span>
    </div>
  );
}

function Metadata({ m, count }: { m: MediaItem; count: number }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="shrink-0 border-t border-line">
      <div className="pn-section" onClick={() => setOpen((v) => !v)}>{open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}Metadata{count > 1 && <span className="ml-auto text-dim">{count} selected</span>}</div>
      {open && (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-2xs">
          <span className="text-dim">Name</span><span className="truncate">{m.name}</span>
          <span className="text-dim">File</span><span className="mono truncate" title={m.path}>{m.path}</span>
          <span className="text-dim">Duration</span><span className="mono">{durOf(m)}{m.kind === "video" ? ` · ${fpsLabel(m.fps)}` : m.kind === "audio" && m.fps > 1000 ? ` · ${(m.fps / 1000).toFixed(1)} kHz` : ""}</span>
          {m.kind !== "audio" && <><span className="text-dim">Size</span><span className="mono">{m.width}×{m.height}</span></>}
          <span className="text-dim">Sound</span><span>{m.hasAudio ? `${m.audioChannels ?? "?"} channel${m.audioChannels === 1 ? "" : "s"}` : "None"}</span>
          {(m.missing || m.offline) && <><span className="text-dim">Status</span><span className="text-red-300">Offline — right-click → Relink</span></>}
          {m.proxyPath && <><span className="text-dim">Proxy</span><span className="mono truncate">{m.proxyPath}</span></>}
          <span className="text-dim">Comment</span>
          <input key={m.id} defaultValue={m.comment ?? ""} placeholder="Add a note" className="ed-field h-5 text-2xs"
            onBlur={(e) => { if ((m.comment ?? "") !== e.target.value) A.updateMediaItem(m.id, (x) => ({ ...x, comment: e.target.value }), "Media comment"); }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </div>
      )}
    </div>
  );
}
