/**
 * Effects browser (docs/EDITOR.md §3): the engine's video transitions and effects (listTransitions / listEffects),
 * audio effects and crossfades, with search, favourites (kept in this browser), groups, drag onto clips or cuts,
 * double-click to apply to the selection, and right-click to set the default transition.
 */
import { clsx } from "clsx";
import { AudioLines, AudioWaveform, ChevronDown, ChevronRight, FileCode2, Sparkles, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchField } from "../../components/ui";
import * as A from "../actions";
import { startDrag } from "../dnd";
import { audioEffects, makeEffect, videoEffects, type EffectDef } from "../effects";
import { listTransitions, onCatalog, type TransitionInfo } from "../engine";
import { importShader } from "../session";
import { IBtn } from "../ui";
import { AUDIO_TRANSITIONS, kindOf } from "../model/ops";
import { ed, seq, setFocus } from "../store";
import { openMenu } from "../ui";
import { addGenerator, GEN_MIME, installGeneratorDrop } from "../audiofx/actions";
import { AUDIO_TRANSITION_DEFS, GENERATORS, type GeneratorKind } from "../audiofx/registry";
import { addVisualizer } from "../audiotools/actions"; // audio-tools2: the audio visualiser (additive)
import { installVisualizerDrop, VISUALIZER_ITEM, VIZ_MIME } from "../audiotools/menu";
// preview-polish: engine thumbnails, the animated hover preview, live previews on the Program monitor, audio wave bars
import { audioFxId } from "../audiofx/registry";
import { AuditionNote, AudioWave, fxChain, rowAudition, toggleAudition } from "../preview/AudioWave";
import { movePopover, PreviewFrame, PreviewPopover } from "../preview/Card";
import { PreviewSwitch, usePreviewChoice } from "../preview/choice";
import { effectItem, transitionItem } from "../preview/items";
import { effectLive, transitionLive } from "../preview/liveSpecs";

// generators (tone, noise, DTMF) dragged from here land on an audio track as a new clip
installGeneratorDrop();
installVisualizerDrop(); // "Audio visualiser" lands on a video track

const LS_FAV = "tatvam-editor:fx-favourites";
const readFav = (): string[] => { try { return JSON.parse(localStorage.getItem(LS_FAV) || "[]"); } catch { return []; } };

interface Item { key: string; id: string; label: string; kind: "vt" | "ve" | "ae" | "at" | "gen" | "viz"; group: string; hint?: string; info?: TransitionInfo; def?: EffectDef }

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
  const [hover, setHover] = useState<{ item: Item; rect: DOMRect; at: number } | null>(null);
  const hoverTimer = useRef(0);
  const pc = usePreviewChoice("effects", { next: true });
  const hoverOn = (i: Item, el: HTMLElement) => {
    window.clearTimeout(hoverTimer.current);
    if (i.kind === "ae" || i.kind === "at" || i.kind === "gen" || i.kind === "viz") return;
    const at = performance.now();
    hoverTimer.current = window.setTimeout(() => setHover({ item: i, rect: el.getBoundingClientRect(), at }), 260);
  };
  const hoverOff = () => { window.clearTimeout(hoverTimer.current); setHover(null); };
  useEffect(() => { try { localStorage.setItem(LS_FAV, JSON.stringify(fav)); } catch { /* blocked */ } }, [fav]);

  const all = useMemo<Item[]>(() => [
    ...trans.map((t) => ({ key: `vt:${t.id}`, id: t.id, label: t.label, kind: "vt" as const, group: t.group, hint: t.kind === "gl" ? "GL" : undefined, info: t })),
    ...vfx.map((d) => ({ key: `ve:${d.id}`, id: d.id, label: d.label, kind: "ve" as const, group: d.custom ? "Custom" : d.group, hint: d.custom ? "custom" : d.gpuOnly ? "GPU" : undefined, def: d })),
    ...audioEffects().map((d) => ({ key: `ae:${d.id}`, id: d.id, label: d.label, kind: "ae" as const, group: d.group, def: d })),
    ...AUDIO_TRANSITIONS.map((t) => ({ key: `at:${t.id}`, id: t.id, label: t.label, kind: "at" as const, group: "Crossfade" })),
    ...AUDIO_TRANSITION_DEFS.filter((t) => !AUDIO_TRANSITIONS.some((x) => x.id === t.id)).map((t) => ({ key: `at:${t.id}`, id: t.id, label: t.label, kind: "at" as const, group: "Crossfade", hint: t.curve })),
    ...GENERATORS.map((g) => ({ key: `gen:${g.kind}`, id: g.kind, label: g.label, kind: "gen" as const, group: "Generate", hint: "clip" })),
    { key: `viz:${VISUALIZER_ITEM.id}`, id: VISUALIZER_ITEM.id, label: VISUALIZER_ITEM.label, kind: "viz" as const, group: "Generate", hint: VISUALIZER_ITEM.hint },
  ], [trans, vfx]);
  const ql = q.trim().toLowerCase();
  const shown = ql ? all.filter((i) => i.label.toLowerCase().includes(ql) || i.group.toLowerCase().includes(ql) || (i.info?.tags ?? []).some((t) => t.includes(ql))) : all;

  const apply = (i: Item) => {
    if (i.kind === "gen") { addGenerator(i.id as GeneratorKind); return; }
    if (i.kind === "viz") { void addVisualizer(); return; }
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
      onMouseEnter={(e) => { hoverOn(i, e.currentTarget); if (i.kind === "ae") rowAudition.enter(fxChain(audioFxId(i.id) ?? i.id)); }}
      onMouseLeave={() => { hoverOff(); if (i.kind === "ae") rowAudition.leave(fxChain(audioFxId(i.id) ?? i.id)); }}
      onMouseMove={(e) => movePopover(e.clientX)} onDragStartCapture={hoverOff}
      onClick={i.kind === "ae" ? () => toggleAudition(fxChain(audioFxId(i.id) ?? i.id)) : undefined}
      onDragStart={(e) => i.kind === "gen" || i.kind === "viz" ? (e.dataTransfer.setData(i.kind === "viz" ? VIZ_MIME : GEN_MIME, i.id), e.dataTransfer.setData("text/plain", i.label), e.dataTransfer.effectAllowed = "copy") : startDrag(e, i.kind === "vt" || i.kind === "at"
        ? { kind: "transition", transition: i.id, media: i.kind === "vt" ? "video" : "audio" }
        : { kind: "effect", effect: i.id, media: i.kind === "ve" ? "video" : "audio" }, i.label)}
      onDoubleClick={() => apply(i)}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e, [
        { label: i.kind === "vt" || i.kind === "at" ? "Apply to selected clips' edges" : "Apply to selected clips", onClick: () => apply(i) },
        (i.kind === "vt" || i.kind === "at") && { label: i.kind === "vt" ? "Set as default transition" : "Set as default crossfade", onClick: () => A.setDefaultTransition(i.kind === "vt" ? "video" : "audio", i.id) },
        { label: fav.includes(i.key) ? "Remove from favourites" : "Add to favourites", onClick: () => toggleFav(i.key) },
      ]); }}
      title={i.info?.description ?? i.def?.note ?? (i.info?.author ? `by ${i.info.author}` : undefined)}>
      {i.kind === "vt" ? <PreviewFrame item={transitionItem(i.id)} choice={pc.choice} width={40} /> : i.kind === "ve" && i.def ? <PreviewFrame item={effectItem(i.def)} choice={pc.choice} width={40} /> : i.kind === "ve" ? <Sparkles className="size-3.5 shrink-0 text-ai" /> : i.kind === "gen" || i.kind === "viz" ? <AudioWaveform className="size-3.5 shrink-0 text-ok" /> : <AudioLines className="size-3.5 shrink-0 text-ok" />}
      <span className="min-w-0 flex-1 truncate">{i.label}</span>
      {i.kind === "ae" && <AudioWave chain={fxChain(audioFxId(i.id) ?? i.id)} note={false} barsWidth={72} />}
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
        <IBtn title="Sound effects library" onClick={() => window.dispatchEvent(new CustomEvent("ed:panel", { detail: "sfx" }))}><AudioWaveform className="size-3.5" /></IBtn>
        <IBtn title="Import a custom shader…" onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), [
          { label: "Effect (GLSL: vec4 effect(vec2 uv))", onClick: () => void importShader("effect") },
          { label: "Transition (gl-transitions GLSL)", onClick: () => void importShader("transition") },
        ])}><FileCode2 className="size-3.5" /></IBtn>
      </div>
      <div className="pn-scroll">
        {section("Favourites", shown.filter((i) => fav.includes(i.key)), false)}
        {section("Video transitions", shown.filter((i) => i.kind === "vt"))}
        {section("Video effects", shown.filter((i) => i.kind === "ve"))}
        {section("Audio effects", shown.filter((i) => i.kind === "ae"))}
        {section("Audio transitions", shown.filter((i) => i.kind === "at"), false)}
        {section("Generate", shown.filter((i) => i.kind === "gen" || i.kind === "viz"), false)}
        {!shown.length && <div className="p-4 text-center text-xs text-dim">{all.length ? "Nothing matches" : "Loading the catalogue…"}</div>}
      </div>
      <div className="ed-bar bottom text-2xs text-dim"><AuditionNote className="flex-1" fallback="Drag onto a clip or a cut · double-click applies to the selection" /><PreviewSwitch pc={pc} /></div>
      {hover && (hover.item.kind === "vt" || hover.item.def) && (
        <PreviewPopover item={hover.item.kind === "vt" ? transitionItem(hover.item.id) : effectItem(hover.item.def!)} choice={pc.choice} rect={hover.rect} enteredAt={hover.at}
          title={hover.item.label} sub={hover.item.info?.author || hover.item.def?.author ? `${hover.item.info?.author ?? hover.item.def?.author} · ${hover.item.info?.license ?? hover.item.def?.license ?? ""}` : hover.item.group}
          live={hover.item.kind === "vt" ? transitionLive(hover.item.id, hover.item.label) : effectLive(hover.item.id, hover.item.label, () => makeEffect(hover.item.id, vfx))} />
      )}
    </div>
  );
}
