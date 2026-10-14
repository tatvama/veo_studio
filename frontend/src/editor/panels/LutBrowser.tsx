/**
 * LUT browser (docs/EDITOR.md §10, §12): every preset look, the edit's imported .cube LUTs, the studio team's LUTs and
 * the LUT folders the user adds (.cube / .3dl; only folders they choose, nothing scanned) as a grid of the selected
 * clip's frame at the playhead through each one. Search, favourites (this browser), strength, and apply (replace the
 * clip's look) or stack (another look on top), one undoable command for the selection.
 */
import { clsx } from "clsx";
import { FileUp, FolderPlus, Layers, RefreshCw, Star, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, SearchField } from "../../components/ui";
import { api } from "../../lib/api";
import { LOOKS } from "../effects";
import { useEditorHost } from "../host";
import { isMoodEffect } from "../moods/apply";
import { addFolder, hasFolderBridge, loadFolders, lookForFolderLut, reconnect, removeFolder, useLutFolders } from "../moods/lutFolders";
import { Slider } from "../moods/ui";
import { uid } from "../model/ids";
import { tracksOf } from "../model/ops";
import { importLut } from "../session";
import { setFocus, useEditor, useProject, useSequence } from "../store";
import { PreviewCard } from "../preview/Card";
import { PreviewSwitch, usePreviewChoice } from "../preview/choice";
import { categoryColor, lutItem } from "../preview/items";
import type { LiveSpec } from "../preview/live";
import { pickUserClip } from "../preview/samples";
import { program } from "../playback/transport";

const LS_FAV = "tatvam-editor:lut-favourites";
const readFav = (): string[] => { try { return JSON.parse(localStorage.getItem(LS_FAV) || "[]"); } catch { return []; } };
type Group = "all" | "fav" | "preset" | "imported" | "team" | "folders";
interface Item { id: string; label: string; group: "preset" | "imported" | "team" | "folder"; folder?: string; pending?: boolean }

let foldersLoaded = false;

export default function LutBrowser() {
  const host = useEditorHost();
  const p = useProject();
  const s = useSequence();
  const sel = useEditor((x) => x.selection);
  const root = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<Group>("all");
  const [fav, setFav] = useState<string[]>(readFav);
  const [strength, setStrength] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const [team, setTeam] = useState<Item[]>([]);
  useEffect(() => { try { localStorage.setItem(LS_FAV, JSON.stringify(fav)); } catch { /* blocked */ } }, [fav]);
  const folders = useLutFolders((x) => x.folders);
  const folderBusy = useLutFolders((x) => x.busy);
  useEffect(() => { if (!foldersLoaded) { foldersLoaded = true; void loadFolders(); } }, []);
  const teamPid = s.source?.pid ?? p.studioProjectId ?? null;
  useEffect(() => {
    if (!teamPid) { setTeam([]); return; }
    let alive = true;
    void api.get<{ id: string; name: string }[]>(`/api/projects/${teamPid}/luts`, { silent: true })
      .then((ls) => { if (alive) setTeam(ls.map((l) => ({ id: `lut:${l.id}`, label: l.name, group: "team" as const }))); }).catch(() => undefined);
    return () => { alive = false; };
  }, [teamPid]);
  const items: Item[] = useMemo(() => [
    ...LOOKS.filter((l) => l.value !== "none").map((l) => ({ id: l.value, label: l.label, group: "preset" as const })),
    ...(p.luts ?? []).map((l) => ({ id: `lut:${l.id}`, label: l.name, group: "imported" as const })),
    ...team.filter((t) => !(p.luts ?? []).some((l) => `lut:${l.id}` === t.id)),
    ...folders.flatMap((f) => f.luts.filter((l) => !l.error).map((l) => ({ id: `lut:${l.id}`, label: l.name, group: "folder" as const, folder: f.name, pending: l.pending }))),
  ], [p.luts, team, folders]);
  const ql = q.trim().toLowerCase();
  const shown = items.filter((i) => (group === "all" || (group === "fav" ? fav.includes(i.id) : group === "folders" ? i.group === "folder" : i.group === group))
    && (!ql || i.label.toLowerCase().includes(ql) || i.id.includes(ql) || (i.folder ?? "").toLowerCase().includes(ql)));
  // the thumbnails at full strength a moment after the slider stops
  const [thumbK, setThumbK] = useState(strength);
  useEffect(() => { const id = window.setTimeout(() => setThumbK(strength), 300); return () => window.clearTimeout(id); }, [strength]);
  // preview-polish: cards rendered by the shared preview engine, on the user's clip or a sample
  const pc = usePreviewChoice("luts");

  const videoIds = () => {
    const vids = new Set(tracksOf(s, "video").map((t) => t.id));
    return s.clips.filter((c) => sel.includes(c.id) && vids.has(c.trackId) && c.source.type !== "title").map((c) => c.id);
  };
  const apply = async (id0: string, stack: boolean) => {
    const ids = videoIds();
    if (!ids.length) { toast.message("Select video clips first"); return; }
    const item = items.find((i) => i.id === id0);
    const label = item?.label ?? id0;
    let id = id0;
    if (item?.group === "folder") {
      try {
        const r = await lookForFolderLut(id0.slice(4));
        id = r.look;
        if (!r.exportable) toast.warning(`${label} shows in the preview; for the export, add it with Import LUT… (this build can't copy folder LUTs into the edit yet)`, { id: "folder-lut" });
      } catch (e) { toast.error(`Couldn't use ${label}: ${(e as Error).message}`); return; }
    }
    host.apply(`${stack ? "Stack" : "Apply"} look ${label}`, (d) => {
      const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
      for (const c of sq.clips) {
        if (!ids.includes(c.id)) continue;
        const own = c.effects.find((e) => e.type === "look" && !isMoodEffect(e));
        const params = { look: { value: id }, lut_strength: { value: strength } };
        if (own && !stack) own.params = { ...own.params, ...params };
        else if (stack) c.effects.push({ id: uid("e"), type: "look", enabled: true, params });
        else c.effects.unshift({ id: uid("e"), type: "look", enabled: true, params });
      }
    });
    toast.success(`${label} on ${ids.length} clip${ids.length === 1 ? "" : "s"}${stack ? " (stacked)" : ""}`);
  };
  const toggleFav = (id: string) => setFav((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  /** preview-polish: the Program monitor's live preview (the apply below, on a copy: the selection, else the clip under the playhead). */
  const liveFor = (i: Item): LiveSpec | null => (i.pending || i.group === "folder" ? null : {
    key: `luts:${i.id}:${strength}`, label: i.label, hint: "Double-click to apply",
    mutate: (d) => {
      const sq = d.sequences.find((x) => x.id === d.activeSequenceId);
      if (!sq) return;
      const vids = new Set(tracksOf(sq, "video").map((t) => t.id));
      let ids = sq.clips.filter((c) => sel.includes(c.id) && vids.has(c.trackId) && c.source.type !== "title").map((c) => c.id);
      if (!ids.length) { const u = pickUserClip(sq, [], program.frame); if (u) ids = [u.id]; }
      for (const c of sq.clips) {
        if (!ids.includes(c.id)) continue;
        const own = c.effects.find((e) => e.type === "look" && !isMoodEffect(e));
        const params = { look: { value: i.id }, lut_strength: { value: strength } };
        if (own) own.params = { ...own.params, ...params }; else c.effects.unshift({ id: uid("e"), type: "look", enabled: true, params });
      }
    },
  });

  return (
    <div ref={root} className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Search looks and LUTs" className="min-w-0 flex-1 [&_input]:h-6 [&_input]:text-xs" />
        <button type="button" className="ed-ibtn" title="Import a .cube LUT into this edit…" onClick={() => void importLut()}><FileUp className="size-3.5" /></button>
        <button type="button" className="ed-ibtn" title="Add a folder of your LUTs (.cube, .3dl)…" disabled={folderBusy}
          onClick={() => void addFolder().then((f) => { if (f) { setGroup("folders"); toast.success(`${f.name}: ${f.luts.filter((l) => !l.error).length} LUT${f.luts.length === 1 ? "" : "s"}${f.luts.some((l) => l.error) ? ` (${f.luts.filter((l) => l.error).length} skipped)` : ""}`); } })}><FolderPlus className="size-3.5" /></button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
        <div className="ed-seg">
          {([["all", "All"], ["fav", "Favourites"], ["preset", "Presets"], ["imported", "Imported"], ["team", "Team"], ["folders", "Folders"]] as const).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={group === v} onClick={() => setGroup(v)}>{l}</button>
          ))}
        </div>
        <div className="min-w-[160px] flex-1"><Slider label="Strength" value={strength} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={setStrength} /></div>
        <PreviewSwitch pc={pc} />
      </div>
      <div className="pn-scroll">
        {group === "folders" && (
          <div className="border-b border-line px-3 py-2" data-lut-folders>
            {!folders.length && <p className="text-2xs text-dim">Add a folder of your own .cube or .3dl LUTs{hasFolderBridge() ? "; Tatvam remembers it." : "; this browser remembers it when it can."} Only folders you choose are read.</p>}
            {folders.map((f) => (
              <div key={f.key} className="flex items-center gap-2 py-0.5 text-2xs">
                <span className="min-w-0 flex-1 truncate" title={f.path ?? f.name}>{f.name}</span>
                <span className="text-dim">{f.needsPermission ? "needs access" : `${f.luts.filter((l) => !l.error).length} LUTs${f.source === "picked" ? " · this session" : ""}`}</span>
                {f.needsPermission && <button type="button" className="ed-ibtn" title="Read this folder again" onClick={() => void reconnect(f.key)}><RefreshCw className="size-3" /></button>}
                <button type="button" className="ed-ibtn" title="Remove the folder from the list (the files stay)" onClick={() => void removeFolder(f.key)}><X className="size-3" /></button>
              </div>
            ))}
          </div>
        )}
        <p className="px-3 pt-2 text-2xs text-dim">{pc.choice.mode === "clip" ? `${pc.clipName ?? "Your clip"} at the playhead` : "On samples that fit each look"}{sel.length ? "" : " · select clips to apply"}</p>
        <div className="pv-grid">
          {shown.map((i) => (
            <PreviewCard key={i.id} item={lutItem(i.id, i.label, thumbK)} choice={pc.choice} name={i.label} data={{ lut: i.id }}
              dot={categoryColor(i.group, ["preset", "imported", "team", "folder"])} selected={picked === i.id}
              meta={i.group !== "preset" ? <span className="max-w-[72px] truncate uppercase" title={i.folder}>{i.group === "folder" ? i.folder : i.group}</span> : undefined}
              desc={i.pending ? "Apply to preview" : i.group === "preset" ? "Preset look" : i.group === "imported" ? "Imported LUT" : i.group === "team" ? "Team LUT" : "Folder LUT"}
              live={liveFor(i)} title="Move across to scrub the strength, hold to play · double-click to apply to the selection"
              onClick={() => setPicked(i.id)} onDoubleClick={() => void apply(i.id, false)}
              corner={<button type="button" aria-label="Favourite" onClick={() => toggleFav(i.id)} className={clsx("grid size-5 place-items-center rounded bg-black/45", fav.includes(i.id) ? "text-warn" : "text-white/70 hover:text-white")}>
                <Star className="size-3" fill={fav.includes(i.id) ? "currentColor" : "none"} />
              </button>} />
          ))}
          {!shown.length && <p className="col-span-full p-4 text-center text-xs text-dim">{group === "fav" ? "Star looks to keep them here" : group === "team" ? (teamPid ? "The studio project has no LUTs" : "Team LUTs come with a studio project") : group === "folders" ? "No LUTs in your folders yet" : "Nothing matches"}</p>}
        </div>
      </div>
      <div className="ed-bar bottom gap-1.5">
        <span className="min-w-0 flex-1 truncate text-2xs text-dim">{picked ? items.find((i) => i.id === picked)?.label : "Pick a look"}</span>
        <Button size="sm" variant="secondary" disabled={!picked} icon={<Layers className="size-3.5" />} onClick={() => picked && void apply(picked, true)}>Stack</Button>
        <Button size="sm" variant="primary" disabled={!picked} icon={<Wand2 className="size-3.5" />} onClick={() => picked && void apply(picked, false)}>Apply</Button>
      </div>
    </div>
  );
}
