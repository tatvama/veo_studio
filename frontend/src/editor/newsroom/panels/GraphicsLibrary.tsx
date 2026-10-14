/**
 * News Room: the graphics library (docs/EDITOR.md §16.8). Every template by category (tickers, bugs, straps, boards,
 * layouts, wipes, openers, backgrounds) plus the user's own, each a live picture in the edit's look that plays on
 * hover. Click adds it at the playhead on its own track (a wipe on the nearest cut), drag puts it anywhere on the
 * timeline; right-click (or "⋯") to customise it in the Designer or put it on the playlist.
 */
import { clsx } from "clsx";
import { MoreHorizontal, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SearchField } from "../../../components/ui";
import { parseTimecode } from "../../model/time";
import { openDialog } from "../../dialogs";
import { program } from "../../playback/transport";
import { project, setFocus, useProject, useSequence } from "../../store";
import { IBtn, openMenu, type MenuItem } from "../../ui";
import { openDesigner, openWipeDesigner } from "../events";
import { deleteTemplate } from "../library";
import { ratioOf } from "../render/index";
import { GFX_CATEGORIES } from "../templates/index";
import type { GfxCategory, GfxRatio, GfxTemplate } from "../types";
import { PreviewFrame } from "../../preview/Card";
import { usePreviewChoice, type PreviewChoice } from "../../preview/choice";
import { transitionItem } from "../../preview/items";
import { NEWS_TRANSITIONS, type NewsTransition } from "../wipes/apply";
import { addNewsTransitionAtCut, addTemplateAt, addToPlaylist, host, isWipe } from "../room/actions";
import { listenForGfxDrops, startGfxDrag, startTransitionDrag } from "../room/drag";
import { FindReplaceHost, openFindReplace } from "../room/FindReplace";
import { allTemplates, inputOf, tplById, useLibraryTemplates } from "../room/hooks";
import { GfxPreview } from "../room/Preview";
import { fitLoopsToEnd } from "../room/starter";
import { defaults } from "../templates/kit";
import { useNewsBoot } from "../room/NewNewsEdit";

type Tab = Exclude<GfxCategory, "Stingers"> | "Wipes" | "Mine";
const TABS: { id: Tab; label: string }[] = [
  ...GFX_CATEGORIES.filter((c) => c !== "Stingers" && c !== "Openers" && c !== "Backgrounds").map((c) => ({ id: c as Tab, label: c })),
  { id: "Wipes", label: "Wipes" }, { id: "Openers", label: "Openers" }, { id: "Backgrounds", label: "Backgrounds" }, { id: "Mine", label: "My templates" },
];
const ROLE: Record<string, string> = { background: "Background", layout: "Layout", board: "Board", strap: "Strap", ticker: "Ticker", bug: "Bug", wipe: "Wipe" };
/** Small graphics are shown zoomed in on their card. */
const zoomed = (t: GfxTemplate) => t.role === "strap" || t.role === "bug" || t.role === "ticker";

const TAB_KEY = "tatvam-editor:nr-graphics-tab";
const lsGet = () => { try { return (localStorage.getItem(TAB_KEY) as Tab | null) ?? "Straps"; } catch { return "Straps" as Tab; } };

export default function GraphicsLibrary() {
  useNewsBoot();
  const p = useProject();
  const s = useSequence();
  const library = useLibraryTemplates();
  const [tab, setTabState] = useState<Tab>(lsGet);
  const [q, setQ] = useState("");
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* blocked */ } };
  useEffect(() => listenForGfxDrops(), []);

  const all = useMemo(() => allTemplates(p, library), [p.newsroom?.templates, library]); // eslint-disable-line react-hooks/exhaustive-deps
  const mineIds = useMemo(() => new Set([...library.map((t) => t.id), ...Object.values(p.newsroom?.templates ?? {}).filter((t) => t.source === "mine" || t.source === "imported").map((t) => t.id)]), [library, p.newsroom?.templates]);
  const inTab = (t: GfxTemplate, id: Tab) => (id === "Mine" ? mineIds.has(t.id) : id === "Wipes" ? isWipe(t) : t.category === id && !isWipe(t));
  const ql = q.trim().toLowerCase();
  const shown = all.filter((t) => (ql ? `${t.name} ${t.kind ?? ""} ${t.category} ${(t.tags ?? []).join(" ")} ${t.description ?? ""}`.toLowerCase().includes(ql) : inTab(t, tab)));
  const transitions = NEWS_TRANSITIONS.filter((x) => (ql ? `${x.label} transition wipe`.toLowerCase().includes(ql) : tab === "Wipes"));
  const ratio: GfxRatio = ratioOf(s.width, s.height);
  // the cards' pictures, in the edit's look (rebuilt when the look changes)
  const lookKey = `${p.newsroom?.look ?? ""}|${JSON.stringify(p.newsroom?.looks?.[p.newsroom?.look ?? ""] ?? null)}`;
  const inputs = useMemo(() => new Map(shown.map((t) => [t.id, inputOf(project(), t, { ratio, fps: s.fps })])), [shown.map((t) => t.id).join("|"), lookKey, ratio, all]); // eslint-disable-line react-hooks/exhaustive-deps

  const menu = (t: GfxTemplate): MenuItem[] => [
    { label: isWipe(t) ? "Add at the nearest cut" : "Add at the playhead", onClick: () => addTemplateAt(t) },
    !isWipe(t) && { label: "Add at…", onClick: () => openDialog({ kind: "prompt", title: `Add ${t.name} at`, label: "Timecode (or +/- frames from the playhead)", value: "", ok: "Add",
      onOk: (v) => { const f = parseTimecode(v, s.fps, program.frame); if (f === null) toast.error("That isn't a timecode"); else addTemplateAt(t, Math.max(0, f)); } }) },
    { label: "Add to playlist", separator: true, onClick: () => addToPlaylist(t, defaults(t)) },
    { label: "Customise…", hint: "Designer", onClick: () => (isWipe(t) && t.category === "Stingers" ? openWipeDesigner({ template: t.id, onSaved: (x) => toast.success(`Saved “${x.name}”`) }) : openDesigner({ template: tplById(p, t.id) ?? t, onSaved: (x) => toast.success(`Saved “${x.name}” to My templates`) })) },
    mineIds.has(t.id) && library.some((x) => x.id === t.id) && { label: "Delete from My templates", danger: true, separator: true, onClick: () => void deleteTemplate(t.id).then(() => toast.message(`Deleted “${t.name}”`)) },
  ].filter(Boolean) as MenuItem[];

  const more = (e: React.MouseEvent<HTMLElement>) => openMenu(e.currentTarget.getBoundingClientRect(), [
    { label: "Find and replace in graphics…", onClick: openFindReplace },
    { label: "Fit bugs and tickers to the end", hint: "after adding footage", onClick: () => {
      let n = 0;
      host().apply("Fit bugs and tickers", (d) => { n = fitLoopsToEnd(d, d.activeSequenceId, (id) => tplById(d, id)?.role); });
      toast.message(n ? `${n} graphic${n === 1 ? "" : "s"} now run to the end` : "Bugs and tickers already run to the end");
    } },
    { label: "New template in the Designer…", separator: true, onClick: () => openDesigner({ template: all.find((t) => t.category === (tab === "Mine" || tab === "Wipes" ? "Straps" : tab)) ?? all[0], onSaved: (x) => toast.success(`Saved “${x.name}”`) }) },
    { label: "Design a wipe…", onClick: () => openWipeDesigner({ onSaved: (x) => toast.success(`Saved “${x.name}”`) }) },
  ]);

  const count = (id: Tab) => all.filter((t) => inTab(t, id)).length + (id === "Wipes" ? NEWS_TRANSITIONS.length : 0);
  return (
    <div className="pn" data-nr-panel="graphics" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-1.5">
        <SearchField value={q} onChange={setQ} placeholder={`Search ${all.length} graphics`} className="min-w-0 flex-1 [&_input]:h-6 [&_input]:text-xs" onKeyDown={(e) => e.stopPropagation()} />
        <IBtn title="More" onClick={more}><MoreHorizontal className="size-4" /></IBtn>
      </div>
      {!ql && (
        <div className="flex flex-wrap gap-1 border-b border-line px-2 py-1.5">
          {TABS.map((c) => (
            <button key={c.id} type="button" onClick={() => setTab(c.id)} data-nr-tab={c.id}
              className={clsx("rounded-md px-2 py-0.5 text-2xs", tab === c.id ? "bg-accent/20 text-accent-ink" : "text-mute hover:bg-hover")}>
              {c.label}<span className="ml-1 text-dim">{count(c.id)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="pn-scroll">
        {!shown.length && !transitions.length ? (
          <div className="pn-empty">{ql ? `No graphic matches “${q}”.` : tab === "Mine" ? "Templates you make or change in the Designer show here (right-click a graphic → Customise)." : "No graphics here yet."}</div>
        ) : (
          <div className="grid gap-2 p-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {!ql && tab === "Wipes" && (
              <button type="button" onClick={() => openWipeDesigner({ onSaved: (x) => toast.success(`Saved “${x.name}”`) })} title="Make your own wipe: shapes, colours, timing"
                className="flex min-h-[7rem] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line p-1.5 text-2xs text-mute hover:border-accent/60 hover:text-ink">
                <Wand2 className="size-4" />Design a wipe…
              </button>
            )}
            {shown.map((t) => (
              <div key={t.id} data-gfx-template={t.id} role="button" tabIndex={0} draggable
                title={`${t.description ?? t.name}\nClick to add${isWipe(t) ? " at the nearest cut" : " at the playhead"} · drag onto the timeline · right-click for more`}
                onClick={() => addTemplateAt(t)} onKeyDown={(e) => { if (e.key === "Enter") addTemplateAt(t); }}
                onDragStart={(e) => startGfxDrag(e, t)}
                onContextMenu={(e) => { e.preventDefault(); openMenu(e, menu(t)); }}
                className="group relative cursor-pointer rounded-lg border border-line p-1.5 text-left outline-none hover:border-accent/60 focus-visible:border-accent">
                <GfxPreview input={inputs.get(t.id) ?? null} ratio={ratio === "9:16" ? "9:16" : "16:9"} zoom={zoomed(t)} width={300} />
                <div className="mt-1 flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-2xs">{t.name}</p>
                    <p className="truncate text-[10px] text-dim">{ROLE[t.role] ?? t.role}{t.loop ? " · loops" : t.seconds ? ` · ${t.seconds} s` : ""}</p>
                  </div>
                  <button type="button" aria-label="More" title="More" onClick={(e) => { e.stopPropagation(); openMenu(e.currentTarget.getBoundingClientRect(), menu(t)); }}
                    className="grid size-5 shrink-0 place-items-center rounded text-dim opacity-0 hover:bg-hover hover:text-ink group-hover:opacity-100 focus:opacity-100">
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {transitions.length > 0 && <p className="col-span-full pt-1 text-2xs font-semibold uppercase tracking-wide text-dim">Transitions on the cut, in the look's colours</p>}
            {transitions.length > 0 && <TransitionCards list={transitions} />}
          </div>
        )}
      </div>
      <div className="ed-bar bottom text-2xs text-dim">Hover to play · click to add at the playhead · drag onto the timeline</div>
      <FindReplaceHost />
    </div>
  );
}


/** The news transitions, previewed on the user's clip (or the sample stills) like the Effects panel's transitions. */
function TransitionCards({ list }: { list: NewsTransition[] }) {
  const pc = usePreviewChoice("newsroom", { next: true });
  return <>{list.map((x) => <TransitionCard key={x.id} x={x} choice={pc.choice} />)}</>;
}

/** A news transition: a live preview of it; click (or drag) puts it on the nearest cut. */
function TransitionCard({ x, choice }: { x: NewsTransition; choice: PreviewChoice["choice"] }) {
  return (
    <div role="button" tabIndex={0} draggable data-news-transition={x.id} title={`${x.label}: click to put it on the nearest cut, or drag it onto a cut`}
      onClick={() => addNewsTransitionAtCut(x.id)} onKeyDown={(e) => { if (e.key === "Enter") addNewsTransitionAtCut(x.id); }}
      onDragStart={(e) => startTransitionDrag(e, x.id, x.label)}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e, [{ label: "Add at the nearest cut", onClick: () => addNewsTransitionAtCut(x.id) }]); }}
      className="cursor-pointer rounded-lg border border-line p-1.5 text-left outline-none hover:border-accent/60 focus-visible:border-accent">
      <PreviewFrame item={transitionItem(x.type)} choice={choice} className="block aspect-video w-full rounded-md" />
      <p className="mt-1 truncate text-2xs">{x.label}</p>
      <p className="truncate text-[10px] text-dim">Transition · {x.seconds} s</p>
    </div>
  );
}
