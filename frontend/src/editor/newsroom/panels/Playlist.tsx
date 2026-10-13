/**
 * News Room: the graphics playlist (docs/EDITOR.md §16.8). Up to twelve ready graphics — a template with its words
 * filled in — on F1–F12, like a channel's graphics operator: press the key (or the row's play button) and it lands at
 * the playhead. Add the selected graphic or one from the library, rename, reorder by dragging, remove.
 */
import { clsx } from "clsx";
import { GripVertical, MoreHorizontal, Play, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui";
import { setFocus, useProject } from "../../store";
import { IBtn, openMenu, type MenuItem } from "../../ui";
import { GFX_CATEGORIES } from "../templates/index";
import { defaults } from "../templates/kit";
import { ratioOf } from "../render/index";
import { addToPlaylist, fireKey, host } from "../room/actions";
import { listenForGfxDrops, startGfxDrag } from "../room/drag";
import { graphicLabel } from "../room/fields";
import { allTemplates, inputOf, tplById, useLibraryTemplates, useNewsroomDoc, useSelectedGfx } from "../room/hooks";
import { moveEntry, PLAYLIST_KEYS, PLAYLIST_MAX, removeEntry, renameEntry } from "../room/playlist";
import { NoNewsroom } from "../room/pickers";
import { GfxPreview } from "../room/Preview";
import { useNewsBoot } from "../room/NewNewsEdit";

export default function Playlist() {
  useNewsBoot();
  const nr = useNewsroomDoc();
  const p = useProject();
  const sel = useSelectedGfx();
  const library = useLibraryTemplates();
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [rename, setRename] = useState<number | null>(null);
  useEffect(() => listenForGfxDrops(), []);
  const list = nr?.playlist ?? [];
  const seq = p.sequences.find((s) => s.id === p.activeSequenceId)!;
  const ratio = ratioOf(seq.width, seq.height) === "9:16" ? "9:16" : "16:9";
  const lookKey = `${nr?.look ?? ""}`;
  const inputs = useMemo(() => list.map((e) => { const t = tplById(p, e.template); return t ? inputOf(p, t, { values: e.values, ratio, fps: seq.fps }) : null; }), [list, lookKey, ratio]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!nr) return <div className="pn"><NoNewsroom what="The playlist keeps up to twelve ready graphics on F1–F12, to drop in at the playhead with one key." /></div>;

  const fromLibrary = (e: React.MouseEvent<HTMLElement>) => {
    const all = allTemplates(p, library);
    const items: MenuItem[] = GFX_CATEGORIES.map((c) => ({ label: c, items: all.filter((t) => t.category === c).map((t) => ({ label: t.name, onClick: () => addToPlaylist(t, defaults(t)) })) }))
      .filter((x) => (x.items as MenuItem[]).length);
    openMenu(e.currentTarget.getBoundingClientRect(), items);
  };
  const setList = (label: string, next: typeof list) => host().apply(label, (d) => { if (d.newsroom) d.newsroom.playlist = next; });
  const drop = () => {
    if (!drag) return;
    const { from, to } = drag;
    setDrag(null);
    if (from !== to && from + 1 !== to) setList("Move playlist graphic", moveEntry(list, from, to > from ? to - 1 : to));
  };
  const full = list.length >= PLAYLIST_MAX;
  return (
    <div className="pn" data-nr-panel="playlist" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-1">
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={!sel?.template || full}
          title={sel ? "Put the selected graphic (with its words) on the next key" : "Select a graphic on the timeline first"}
          onClick={() => sel?.template && addToPlaylist(sel.template, sel.clip.source.gfx.values)}>Selected graphic</Button>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={full} onClick={fromLibrary}>From the library</Button>
        <div className="flex-1" />
        <span className="text-2xs text-dim">{list.length} / {PLAYLIST_MAX}</span>
      </div>
      <div className="pn-scroll" onDragOver={(e) => { if (drag) e.preventDefault(); }} onDrop={drop}>
        {!list.length ? (
          <div className="pn-empty">
            <div className="max-w-[260px] space-y-2">
              <p>Nothing on the keys yet.</p>
              <p className="text-2xs">Fill in a strap or a breaking bar, select it, then “Selected graphic”: it goes on F1. Press F1 later to drop it in at the playhead.</p>
            </div>
          </div>
        ) : list.map((e, i) => {
          const t = tplById(p, e.template);
          const name = e.name || graphicLabel(t, e.values);
          const menu: MenuItem[] = [
            { label: "Add at the playhead", shortcut: e.key, onClick: () => fireKey(e.key) },
            { label: "Rename…", onClick: () => setRename(i) },
            { label: "Move up", separator: true, disabled: i === 0, onClick: () => setList("Move playlist graphic", moveEntry(list, i, i - 1)) },
            { label: "Move down", disabled: i === list.length - 1, onClick: () => setList("Move playlist graphic", moveEntry(list, i, i + 1)) },
            { label: "Remove", danger: true, separator: true, onClick: () => setList("Remove from playlist", removeEntry(list, i)) },
          ];
          return (
            <div key={`${e.key}-${i}`} data-playlist={e.key}
              onDragOver={(ev) => { if (!drag) return; ev.preventDefault(); const b = ev.currentTarget.getBoundingClientRect(); const to = ev.clientY > b.top + b.height / 2 ? i + 1 : i; if (to !== drag.to) setDrag({ ...drag, to }); }}
              onContextMenu={(ev) => { ev.preventDefault(); openMenu(ev, menu); }}
              className={clsx("group flex items-center gap-2 border-b border-line px-2 py-1.5", drag?.to === i && "shadow-[inset_0_2px_0_var(--color-accent)]", drag?.to === i + 1 && i === list.length - 1 && "shadow-[inset_0_-2px_0_var(--color-accent)]")}>
              <span draggable onDragStart={(ev) => { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", e.key); setDrag({ from: i, to: i }); }} onDragEnd={() => setDrag(null)}
                className="cursor-grab text-dim hover:text-ink" title="Drag to reorder (the keys follow the order)"><GripVertical className="size-3.5" /></span>
              <span className="mono w-8 shrink-0 rounded bg-accent/15 py-0.5 text-center text-2xs font-semibold text-accent-ink">{PLAYLIST_KEYS[i]}</span>
              <div className="w-24 shrink-0" draggable={!!t} onDragStart={(ev) => t && startGfxDrag(ev, t, e.values)} title="Drag onto the timeline">
                <GfxPreview input={inputs[i]} ratio={ratio} zoom={!!t && (t.role === "strap" || t.role === "bug" || t.role === "ticker")} width={192} />
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                {rename === i ? (
                  <input autoFocus defaultValue={name} className="ed-field w-full" onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") setRename(null); }}
                    onBlur={(ev) => { const v = ev.target.value.trim(); setRename(null); if (v && v !== name) setList("Rename playlist graphic", renameEntry(list, i, v)); }} />
                ) : <p className="truncate text-xs" onDoubleClick={() => setRename(i)} title="Double-click to rename">{name}</p>}
                <p className="truncate text-[10px] text-dim">{t ? `${t.name} · ${t.category}` : "Template missing"}</p>
              </div>
              <IBtn title={`Add at the playhead (${e.key})`} onClick={() => fireKey(e.key)} disabled={!t}><Play className="size-3.5" /></IBtn>
              <IBtn title="More" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={(ev) => openMenu(ev.currentTarget.getBoundingClientRect(), menu)}><MoreHorizontal className="size-3.5" /></IBtn>
            </div>
          );
        })}
      </div>
      <div className="ed-bar bottom text-2xs text-dim">F1–F12 add these at the playhead · Alt+N strap · Alt+T ticker · Alt+B breaking · Alt+L layout · Alt+S wipe</div>
    </div>
  );
}

