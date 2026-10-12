/**
 * Effects browser (docs/EDITOR.md §3): the engine's video transitions and effects (listTransitions / listEffects),
 * audio effects and crossfades, with search, favourites (kept in this browser), groups, drag onto clips or cuts,
 * double-click to apply to the selection, and right-click to set the default transition.
 */
import { clsx } from "clsx";
import { AudioLines, Blend, ChevronDown, ChevronRight, FileCode2, Sparkles, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SearchField } from "../../components/ui";
import * as A from "../actions";
import { startDrag } from "../dnd";
import { audioEffects, makeEffect, videoEffects, type EffectDef } from "../effects";
import { listTransitions, onCatalog, thumbnail, type TransitionInfo } from "../engine";
import { importShader } from "../session";
import { IBtn } from "../ui";
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
  useEffect(() => {
    const load = () => { void listTransitions().then(setTrans); void videoEffects().then(setVfx); };
    load();
    return onCatalog(load);
  }, []);
  const [hover, setHover] = useState<{ item: Item; rect: DOMRect } | null>(null);
  const hoverTimer = useRef(0);
  const hoverOn = (i: Item, el: HTMLElement) => {
    window.clearTimeout(hoverTimer.current);
    if (i.kind === "ae" || i.kind === "at") return;
    hoverTimer.current = window.setTimeout(() => setHover({ item: i, rect: el.getBoundingClientRect() }), 260);
  };
  const hoverOff = () => { window.clearTimeout(hoverTimer.current); setHover(null); };
  useEffect(() => { try { localStorage.setItem(LS_FAV, JSON.stringify(fav)); } catch { /* blocked */ } }, [fav]);

  const all = useMemo<Item[]>(() => [
    ...trans.map((t) => ({ key: `vt:${t.id}`, id: t.id, label: t.label, kind: "vt" as const, group: t.group, hint: t.kind === "gl" ? "GL" : undefined, info: t })),
    ...vfx.map((d) => ({ key: `ve:${d.id}`, id: d.id, label: d.label, kind: "ve" as const, group: d.custom ? "Custom" : d.group, hint: d.custom ? "custom" : d.gpuOnly ? "GPU" : undefined, def: d })),
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
      onMouseEnter={(e) => hoverOn(i, e.currentTarget)} onMouseLeave={hoverOff} onDragStartCapture={hoverOff}
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
      <div className="ed-bar">
        <SearchField value={q} onChange={setQ} placeholder="Search effects and transitions" className="min-w-0 flex-1 [&_input]:h-6 [&_input]:text-xs" />
        <IBtn title="Import a custom shader…" onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), [
          { label: "Effect (GLSL: vec4 effect(vec2 uv))", onClick: () => void importShader("effect") },
          { label: "Transition (gl-transitions GLSL)", onClick: () => void importShader("transition") },
        ])}><FileCode2 className="size-3.5" /></IBtn>
      </div>
      <div className="pn-scroll">
        {section("Favourites", shown.filter((i) => fav.includes(i.key)), false)}
        {section("Video transitions", shown.filter((i) => i.kind === "vt"))}
        {section("Video effects", shown.filter((i) => i.kind === "ve"))}
        {section("Audio effects", shown.filter((i) => i.kind === "ae"), false)}
        {section("Audio transitions", shown.filter((i) => i.kind === "at"), false)}
        {!shown.length && <div className="p-4 text-center text-xs text-dim">{all.length ? "Nothing matches" : "Loading the catalogue…"}</div>}
      </div>
      <div className="ed-bar bottom text-2xs text-dim">Drag onto a clip or a cut · double-click applies to the selection</div>
      {hover && <Preview item={hover.item} rect={hover.rect} />}
    </div>
  );
}

/** The hover preview: the engine's thumbnail of the effect (sample pictures) or the transition half-way. */
function Preview({ item, rect }: { item: Item; rect: DOMRect }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">("loading");
  useEffect(() => {
    let alive = true;
    setState("loading");
    void thumbnail(item.id, item.kind === "vt" ? "transition" : "effect", 192).then((bmp) => {
      if (!alive) return;
      const c = cv.current;
      if (!bmp || !c) { setState("none"); return; }
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d")?.drawImage(bmp, 0, 0);
      setState("ok");
    });
    return () => { alive = false; };
  }, [item.id, item.kind]);
  const left = Math.min(window.innerWidth - 220, rect.right + 8), top = Math.max(8, Math.min(window.innerHeight - 150, rect.top - 30));
  return createPortal(
    <div className="hud pointer-events-none fixed z-[85] w-[208px] rounded-lg border border-line bg-raised p-2 shadow-pop" style={{ left, top }}>
      <div className="relative aspect-video overflow-hidden rounded-md bg-black">
        <canvas ref={cv} className="absolute inset-0 size-full" />
        {state !== "ok" && <div className="absolute inset-0 grid place-items-center text-2xs text-white/60">{state === "loading" ? "Rendering…" : "No preview"}</div>}
      </div>
      <p className="mt-1.5 truncate text-2xs font-medium">{item.label}</p>
      {(item.info?.author || item.def?.author) && <p className="truncate text-[10px] text-dim">{item.info?.author ?? item.def?.author} · {item.info?.license ?? item.def?.license ?? ""}</p>}
    </div>,
    document.body,
  );
}
