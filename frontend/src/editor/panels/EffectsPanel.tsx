/**
 * Effects browser (docs/EDITOR.md §3): the engine's video transitions and effects (listTransitions / listEffects),
 * audio effects and crossfades, with search, favourites (kept in this browser), groups, drag onto clips or cuts,
 * double-click to apply to the selection, and right-click to set the default transition.
 */
import { clsx } from "clsx";
import { AudioLines, Blend, ChevronDown, ChevronRight, Sparkles, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SearchField } from "../../components/ui";
import * as A from "../actions";
import { startDrag } from "../dnd";
import { audioEffects, makeEffect, videoEffects, type EffectDef } from "../effects";
import { listTransitions, type TransitionInfo } from "../engine";
import { AUDIO_TRANSITIONS, kindOf } from "../model/ops";
import { ed, seq, setFocus } from "../store";
import { openMenu } from "../ui";

const LS_FAV = "tatvam-editor:fx-favourites";
const readFav = (): string[] => { try { return JSON.parse(localStorage.getItem(LS_FAV) || "[]"); } catch { return []; } };

interface Item { key: string; id: string; label: string; kind: "vt" | "ve" | "ae" | "at"; group: string; hint?: string; info?: TransitionInfo; def?: EffectDef }

export default function EffectsPanel() {
  const [q, setQ] = useState("");
  const [trans, setTrans] = useState<TransitionInfo[]>([]);
  const [vfx, setVfx] = useState<EffectDef[]>([]);
  const [fav, setFav] = useState<string[]>(readFav);
  const [open, setOpen] = useState<Record<string, boolean>>({ Favourites: true, "Video transitions": true, "Video effects": true, "Audio effects": false, "Audio transitions": false });
  useEffect(() => { void listTransitions().then(setTrans); void videoEffects().then(setVfx); }, []);
  useEffect(() => { try { localStorage.setItem(LS_FAV, JSON.stringify(fav)); } catch { /* blocked */ } }, [fav]);

  const all = useMemo<Item[]>(() => [
    ...trans.map((t) => ({ key: `vt:${t.id}`, id: t.id, label: t.label, kind: "vt" as const, group: t.group, hint: t.kind === "gl" ? "GL" : undefined, info: t })),
    ...vfx.map((d) => ({ key: `ve:${d.id}`, id: d.id, label: d.label, kind: "ve" as const, group: d.group, hint: d.gpuOnly ? "GPU" : undefined, def: d })),
    ...audioEffects().map((d) => ({ key: `ae:${d.id}`, id: d.id, label: d.label, kind: "ae" as const, group: "Audio", def: d })),
    ...AUDIO_TRANSITIONS.map((t) => ({ key: `at:${t.id}`, id: t.id, label: t.label, kind: "at" as const, group: "Crossfade" })),
  ], [trans, vfx]);
  const ql = q.trim().toLowerCase();
  const shown = ql ? all.filter((i) => i.label.toLowerCase().includes(ql) || i.group.toLowerCase().includes(ql) || (i.info?.tags ?? []).some((t) => t.includes(ql))) : all;

  const apply = (i: Item) => {
    if (i.kind === "vt" || i.kind === "at") {
      A.applyTransition(i.kind === "vt" ? "video" : "audio", i.id, `Apply ${i.label}`);
      return;
    }
    const s = seq();
    const kind = i.kind === "ve" ? "video" : "audio";
    const ids = s.clips.filter((c) => ed().selection.includes(c.id) && kindOf(s, c) === kind).map((c) => c.id);
    if (!ids.length) { A.applyEffect([], () => makeEffect(i.id)); return; }
    A.applyEffect(ids, () => makeEffect(i.id, vfx), `Apply ${i.label}`);
  };
  const toggleFav = (key: string) => setFav((f) => (f.includes(key) ? f.filter((x) => x !== key) : [...f, key]));

  const row = (i: Item) => (
    <div key={i.key} draggable className="pn-row group cursor-grab pl-6"
      onDragStart={(e) => startDrag(e, i.kind === "vt" || i.kind === "at"
        ? { kind: "transition", transition: i.id, media: i.kind === "vt" ? "video" : "audio" }
        : { kind: "effect", effect: i.id, media: i.kind === "ve" ? "video" : "audio" }, i.label)}
      onDoubleClick={() => apply(i)}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e, [
        { label: i.kind === "vt" || i.kind === "at" ? "Apply to selected clips' edges" : "Apply to selected clips", onClick: () => apply(i) },
        (i.kind === "vt" || i.kind === "at") && { label: i.kind === "vt" ? "Set as default transition" : "Set as default crossfade", onClick: () => A.setDefaultTransition(i.kind === "vt" ? "video" : "audio", i.id) },
        { label: fav.includes(i.key) ? "Remove from favourites" : "Add to favourites", onClick: () => toggleFav(i.key) },
      ]); }}
      title={i.info?.description ?? i.def?.note ?? (i.info?.author ? `by ${i.info.author}` : undefined)}>
      {i.kind === "vt" ? <Blend className="size-3.5 shrink-0 text-accent-ink" /> : i.kind === "ve" ? <Sparkles className="size-3.5 shrink-0 text-ai" /> : <AudioLines className="size-3.5 shrink-0 text-ok" />}
      <span className="min-w-0 flex-1 truncate">{i.label}</span>
      {(i.kind === "vt" && i.id === A.defaultVideoTransition()) || (i.kind === "at" && i.id === A.defaultAudioTransition()) ? <span className="text-2xs text-accent-ink">default</span> : null}
      {i.hint && <span className="mono text-[10px] text-dim">{i.hint}</span>}
      <button type="button" aria-label="Favourite" onClick={() => toggleFav(i.key)} className={clsx("shrink-0", fav.includes(i.key) ? "text-warn" : "text-dim opacity-0 group-hover:opacity-100")}>
        <Star className="size-3" fill={fav.includes(i.key) ? "currentColor" : "none"} />
      </button>
    </div>
  );

  const section = (title: string, items: Item[], sub = true) => {
    if (!items.length) return null;
    const isOpen = ql ? true : open[title] ?? true;
    const groups = sub ? [...new Set(items.map((i) => i.group))] : [""];
    return (
      <div key={title}>
        <div className="pn-section" onClick={() => setOpen((o) => ({ ...o, [title]: !isOpen }))}>
          {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{title}<span className="mono ml-auto text-dim">{items.length}</span>
        </div>
        {isOpen && groups.map((g) => {
          const gi = sub ? items.filter((i) => i.group === g) : items;
          const gk = `${title}/${g}`;
          const gOpen = ql ? true : open[gk] ?? !sub;
          if (!sub) return <div key={gk}>{gi.map(row)}</div>;
          return (
            <div key={gk}>
              <div className="pn-row cursor-pointer pl-3 text-mute" onClick={() => setOpen((o) => ({ ...o, [gk]: !gOpen }))}>
                {gOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}<span className="flex-1">{g}</span><span className="mono text-2xs text-dim">{gi.length}</span>
              </div>
              {gOpen && gi.map(row)}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="pn" onPointerDown={() => setFocus("effects")}>
      <div className="ed-bar"><SearchField value={q} onChange={setQ} placeholder="Search effects and transitions" className="w-full [&_input]:h-6 [&_input]:text-xs" /></div>
      <div className="pn-scroll">
        {section("Favourites", shown.filter((i) => fav.includes(i.key)), false)}
        {section("Video transitions", shown.filter((i) => i.kind === "vt"))}
        {section("Video effects", shown.filter((i) => i.kind === "ve"))}
        {section("Audio effects", shown.filter((i) => i.kind === "ae"), false)}
        {section("Audio transitions", shown.filter((i) => i.kind === "at"), false)}
        {!shown.length && <div className="p-4 text-center text-xs text-dim">{all.length ? "Nothing matches" : "Loading the catalogue…"}</div>}
      </div>
      <div className="ed-bar bottom text-2xs text-dim">Drag onto a clip or a cut · double-click applies to the selection</div>
    </div>
  );
}
