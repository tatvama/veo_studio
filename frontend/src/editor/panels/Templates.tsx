/**
 * Templates panel (docs/EDITOR.md §10): animated title templates (~100: headlines, lower thirds, tickers, end cards,
 * subscribe / like, quotes, chapters, countdowns), each previewed live on hover; caption styles with karaoke; stickers
 * and shapes (title clips); an Indic font picker with live samples; and the templates library (intros, outros,
 * subscribe prompts, social formats) inserted flattened or nested, with placeholder text and media slots.
 */
import { clsx } from "clsx";
import { Captions, LayoutTemplate, Shapes, Type } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Input, SearchField } from "../../components/ui";
import { FONTS, scriptOf, SCRIPT_FALLBACK, supports, type Script } from "../../pages/posters/fonts";
import "../../pages/posters/fonts";
import { useEditorHost } from "../host";
import { addGenerated, addTrack, clipEnd, ctxOf, tracksOf } from "../model/ops";
import { secondsToFrames } from "../model/time";
import type { Sequence, TitleSpec } from "../model/types";
import { program } from "../playback/transport";
import { ed, project, select, setFocus, useEditor, useSequence } from "../store";
import { CAPTION_STYLES, restyleCaption } from "../templates/captions";
import { formatOf } from "../templates/formats";
import { useVisualiserDetect, visualiserAudio, withVisualiserAudio } from "../templates/packs/visualiser";
// integration: an audiogram brings its sound into the new sequence (templates/audiogram.ts)
import { audiogramChoices, audiogramMedia, withAudiogramAudio } from "../templates/audiogram";
import { makeVisualizerSource } from "../audiotools";
import { fillSlot, insertTemplate, isSlot, SEQ_TEMPLATE_GROUPS, SEQ_TEMPLATES, socialSequence, type SeqTemplate } from "../templates/sequences";
import { STICKERS, stickerSpec, templateSpec, TEMPLATE_CATEGORIES, titleTemplates, type TemplateCategory, type TitleTemplate } from "../templates/titles";
// preview-polish: cards rendered by the shared preview engine (the title at its hold pose over a darkened frame)
import { PreviewCard, PreviewFrame } from "../preview/Card";
import { PreviewSwitch, usePreviewChoice } from "../preview/choice";
import { categoryColor, sequenceItem, specItem, titleItem } from "../preview/items";
import { templateLive, titleLive } from "../preview/liveSpecs";
import type { FrameChoice } from "../preview/service";

/** A value that follows `v` a moment after it stops changing (the cards re-render then, not on every key). */
function useSettled<T>(v: T, ms = 350): T {
  const [x, setX] = useState(v);
  useEffect(() => { const id = window.setTimeout(() => setX(v), ms); return () => window.clearTimeout(id); }, [v, ms]);
  return x;
}

type Tab = "titles" | "captions" | "stickers" | "fonts" | "library";

/** The topmost unlocked video track free over [at, at + len), else null. */
function freeTrack(s: Sequence, at: number, len: number): string | null {
  for (const t of [...tracksOf(s, "video")].reverse()) {
    if (t.locked) continue;
    if (!s.clips.some((c) => c.trackId === t.id && c.start < at + len && clipEnd(c) > at)) return t.id;
  }
  return null;
}

/** Puts title clips at the playhead (a free track, else a new one) in one command and selects the first. */
function placeTitles(host: ReturnType<typeof useEditorHost>, label: string, items: { spec: TitleSpec; seconds: number; name: string }[]) {
  const at = program.frame;
  let first: string | null = null;
  host.apply(label, (d) => {
    const i = d.sequences.findIndex((x) => x.id === d.activeSequenceId);
    let s = d.sequences[i];
    const ctx = ctxOf(d);
    for (const it of items) {
      const len = Math.max(1, secondsToFrames(it.seconds, s.fps));
      let tid = freeTrack(s, at, len);
      if (!tid) { const r = addTrack(s, "video"); s = r.seq; tid = r.trackId; }
      const r = addGenerated(s, ctx, tid, at, len, { type: "title", text: it.spec }, it.name);
      s = r.seq;
      first ??= r.clipId;
    }
    d.sequences[i] = s;
  });
  if (first) select([first]);
}

export default function TemplatesPanel() {
  const [tab, setTab] = useState<Tab>("titles");
  const pc = usePreviewChoice("templates");
  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-1">
        <div className="ed-seg">
          {([["titles", "Titles", Type], ["captions", "Captions", Captions], ["stickers", "Stickers", Shapes], ["fonts", "Fonts", Type], ["library", "Library", LayoutTemplate]] as const).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={tab === v} onClick={() => setTab(v)}>{l}</button>
          ))}
        </div>
        {tab !== "fonts" && <PreviewSwitch pc={pc} className="ml-auto" />}
      </div>
      {tab === "titles" && <TitlesTab choice={pc.choice} />}
      {tab === "captions" && <CaptionsTab choice={pc.choice} />}
      {tab === "stickers" && <StickersTab choice={pc.choice} />}
      {tab === "fonts" && <FontsTab />}
      {tab === "library" && <LibraryTab choice={pc.choice} />}
    </div>
  );
}

// ── titles ───────────────────────────────────────────────────────────────────

function TitlesTab({ choice }: { choice: FrameChoice }) {
  const host = useEditorHost();
  const s = useSequence();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<TemplateCategory | "All">("All");
  const [text, setText] = useState("");
  const all = titleTemplates();
  const ql = q.trim().toLowerCase();
  const shown = all.filter((t) => (cat === "All" || t.category === cat) && (!ql || t.name.toLowerCase().includes(ql) || t.id.includes(ql)));
  const ptext = useSettled(text.trim());
  const specs = useMemo(() => new Map(all.map((t) => [t.id, templateSpec(t, 1080, ptext ? { text: ptext } : {})])), [ptext]);
  const add = (t: TitleTemplate) => placeTitles(host, `Title ${t.name}`, [{ spec: templateSpec(t, s.height, text.trim() ? { text: text.trim() } : {}), seconds: t.seconds, name: (text.trim() || t.fields.text).slice(0, 40) || t.name }]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
        <SearchField value={q} onChange={setQ} placeholder={`Search ${all.length} templates`} className="min-w-[140px] flex-1 [&_input]:h-6 [&_input]:text-xs" />
        <Input className="h-6 w-40 text-xs" placeholder="Your text (optional)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="flex flex-wrap gap-1 border-b border-line px-2 py-1.5">
        {(["All", ...TEMPLATE_CATEGORIES] as const).map((c) => (
          <button key={c} type="button" onClick={() => setCat(c)} className={clsx("rounded-md px-2 py-0.5 text-2xs", cat === c ? "bg-accent/20 text-accent-ink" : "text-mute hover:bg-hover")}>
            {c}{c !== "All" && <span className="ml-1 text-dim">{all.filter((t) => t.category === c).length}</span>}
          </button>
        ))}
      </div>
      <div className="pn-scroll">
        <div className="pv-grid">
          {shown.map((t) => (
            <PreviewCard key={t.id} item={titleItem(t, specs.get(t.id)!)} choice={choice} data={{ template: t.id }} name={t.name} desc={t.category} meta={`${t.seconds} s`}
              dot={categoryColor(t.category, TEMPLATE_CATEGORIES)} title="Move across: in → hold → out · hold still to play · click to add at the playhead"
              live={titleLive(`tpl:${t.id}:${ptext}`, t.name, [{ spec: templateSpec(t, s.height, ptext ? { text: ptext } : {}), seconds: t.seconds, name: (ptext || t.fields.text).slice(0, 40) || t.name }])}
              onClick={() => add(t)} />
          ))}
        </div>
      </div>
      <div className="ed-bar bottom text-2xs text-dim">Move across a card to scrub it, hold to play · click adds it at the playhead · edit the text in the Text panel</div>
    </>
  );
}

// ── captions ─────────────────────────────────────────────────────────────────

const SAMPLE_WORDS = "This is how your captions look".split(" ");
function captionSample(styleId: string): TitleSpec {
  const st = CAPTION_STYLES.find((x) => x.id === styleId)!;
  const words = SAMPLE_WORDS.map((w, i) => ({ start: 0.25 + i * 0.42, end: 0.25 + i * 0.42 + 0.38, text: w }));
  return { text: SAMPLE_WORDS.join(" "), font: "Inter Variable", size: 64, color: st.color, weight: 700, align: "center", box: [0.06, 0.62, 0.88, 0.3], animIn: "none", animOut: "none", ...st.spec,
    ...(st.karaoke ? { karaoke: { mode: st.karaoke, color: st.color, highlightColor: st.highlight, words } } : {}) };
}

function CaptionsTab({ choice }: { choice: FrameChoice }) {
  const host = useEditorHost();
  const s = useSequence();
  const sel = useEditor((x) => x.selection);
  const titles = s.clips.filter((c) => sel.includes(c.id) && c.source.type === "title");
  const restyle = (id: string) => {
    if (!titles.length) { toast.message("Select caption clips (title clips) first"); return; }
    host.apply(`Caption style ${CAPTION_STYLES.find((x) => x.id === id)?.label}`, (d) => {
      const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
      const st = CAPTION_STYLES.find((x) => x.id === id)!;
      for (const c of sq.clips) {
        if (!sel.includes(c.id) || c.source.type !== "title") continue;
        let spec = c.source.text;
        // plain captions become karaoke: the words spread over the clip by length
        if (st.karaoke && !spec.karaoke) {
          const parts = spec.text.split(/\s+/).filter(Boolean), secs = c.duration / sq.fps;
          const total = parts.reduce((n, p) => n + p.length + 1, 0) || 1;
          let t = 0;
          const words = parts.map((p) => { const dd = (secs * (p.length + 1)) / total; const w = { start: Math.round(t * 1000) / 1000, end: Math.round((t + dd) * 1000) / 1000, text: p }; t += dd; return w; });
          spec = { ...spec, karaoke: { mode: st.karaoke, color: st.color, highlightColor: st.highlight, words } };
        }
        c.source = { type: "title", text: restyleCaption(spec, id, sq.height) };
      }
    });
    toast.success(`${titles.length} caption${titles.length === 1 ? "" : "s"} restyled`);
  };
  return (
    <div className="pn-scroll">
      <p className="px-3 pt-2 text-2xs text-dim">Pick a style for the selected caption clips. Karaoke highlights each word as it's spoken: captions from the Transcript panel (local Whisper) and the AI captions tool carry word timings; plain captions get theirs spread over the clip.</p>
      <div className="pv-grid" style={{ ["--pv-min" as string]: "180px" }}>
        {CAPTION_STYLES.map((st) => (
          <PreviewCard key={st.id} item={specItem(`caption.${st.id}`, captionSample(st.id), 3.2, "caption")} choice={choice} data={{ "caption-style": st.id }} name={st.label}
            desc={st.karaoke ? `Karaoke · ${st.karaoke}` : "Caption"} dot={categoryColor(st.karaoke ? "karaoke" : "caption")}
            title="Move across to scrub the words, hold to play · click restyles the selected captions" onClick={() => restyle(st.id)} />
        ))}
      </div>
      <p className="px-3 pb-3 text-2xs text-dim">{titles.length ? `${titles.length} title clip${titles.length === 1 ? "" : "s"} selected` : "Select caption clips on the timeline to restyle them"}</p>
    </div>
  );
}

// ── stickers and shapes ──────────────────────────────────────────────────────

function StickersTab({ choice }: { choice: FrameChoice }) {
  const host = useEditorHost();
  const s = useSequence();
  const groups = ["Shapes", "Arrows", "Callouts", "Emoji"] as const;
  const add = (id: string) => {
    const st = STICKERS.find((x) => x.id === id)!;
    placeTitles(host, `Sticker ${st.name}`, [{ spec: stickerSpec(st, s.width, s.height), seconds: 4, name: st.name }]);
  };
  return (
    <div className="pn-scroll">
      {groups.map((g) => (
        <div key={g}>
          <div className="pn-section cursor-default">{g}</div>
          {g === "Emoji" ? (
            <div className="grid gap-1.5 p-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(44px, 1fr))" }}>
              {STICKERS.filter((x) => x.group === g).map((st) => (
                <button key={st.id} type="button" data-sticker={st.id} title={`Add ${st.name} at the playhead`} onClick={() => add(st.id)}
                  className="rounded-md border border-line p-1 hover:border-accent/60">
                  <span className="block text-center text-2xl leading-9">{st.shape.emoji}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="pv-grid" style={{ ["--pv-min" as string]: "120px" }}>
              {STICKERS.filter((x) => x.group === g).map((st) => (
                <PreviewCard key={st.id} data={{ sticker: st.id }} choice={choice} name={st.name} dot={categoryColor(g, groups)}
                  item={specItem(`sticker.${st.id}`, { ...stickerSpec(st, 1920, 1080), box: [0.2, 0.15, 0.6, Math.min(0.7, (0.6 * 16) / 9 / (st.aspect ?? 1))] }, 4, `sticker ${g}`)}
                  live={titleLive(`sticker:${st.id}`, st.name, [{ spec: stickerSpec(st, s.width, s.height), seconds: 4, name: st.name }])}
                  title={`Add ${st.name} at the playhead · move across to scrub its pop in and out`} onClick={() => add(st.id)} />
              ))}
            </div>
          )}
        </div>
      ))}
      <p className="px-3 pb-3 text-2xs text-dim">Stickers are title clips: move and scale them in Effect Controls, change text and colours in the Text panel.</p>
    </div>
  );
}

// ── fonts ────────────────────────────────────────────────────────────────────

const SCRIPT_SAMPLE: Record<Script, string> = { latin: "The quick brown fox", devanagari: "नमस्ते दुनिया", kannada: "ನಮಸ್ಕಾರ ಜಗತ್ತು", telugu: "నమస్కారం ప్రపంచం", tamil: "வணக்கம் உலகம்" };
const SCRIPT_LABEL: Record<Script, string> = { latin: "Latin", devanagari: "Devanagari (Hindi, Marathi)", kannada: "Kannada", telugu: "Telugu", tamil: "Tamil" };

function FontsTab() {
  const host = useEditorHost();
  const s = useSequence();
  const sel = useEditor((x) => x.selection);
  const titles = s.clips.filter((c) => sel.includes(c.id) && c.source.type === "title");
  const [script, setScript] = useState<Script | "all">("all");
  const [sample, setSample] = useState("");
  const scripts: Script[] = ["latin", "devanagari", "kannada", "telugu", "tamil"];
  const list = FONTS.filter((f) => script === "all" || f.scripts.includes(script));
  const setFont = (family: string, weight: number) => {
    if (!titles.length) { toast.message("Select title clips first"); return; }
    host.apply(`Font ${family}`, (d) => {
      const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
      for (const c of sq.clips) if (sel.includes(c.id) && c.source.type === "title") c.source = { type: "title", text: { ...c.source.text, font: family, weight: FONTS.find((f) => f.family === family)?.weights.includes(c.source.text.weight) ? c.source.text.weight : weight } };
    });
  };
  const autoFix = () => {
    let n = 0;
    host.apply("Fonts for the script", (d) => {
      const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
      for (const c of sq.clips) {
        if (!sel.includes(c.id) || c.source.type !== "title") continue;
        const tx = c.source.text.karaoke?.words.map((w) => w.text).join(" ") || c.source.text.text;
        if (supports(c.source.text.font, tx)) continue;
        c.source = { type: "title", text: { ...c.source.text, font: SCRIPT_FALLBACK[scriptOf(tx)], weight: 600 } };
        n++;
      }
    });
    toast.message(n ? `${n} title${n === 1 ? "" : "s"} switched to a font for their script` : "Every selected title's font covers its script");
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
        <select className="ed-field" value={script} onChange={(e) => setScript(e.target.value as Script | "all")}>
          <option value="all">Every script</option>
          {scripts.map((x) => <option key={x} value={x}>{SCRIPT_LABEL[x]}</option>)}
        </select>
        <Input className="h-6 min-w-0 flex-1 text-xs" placeholder="Type a sample (any script)" value={sample} onChange={(e) => setSample(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <Button size="sm" variant="ghost" onClick={autoFix} title="Give selected titles a font that covers their text's script">Fix fonts</Button>
      </div>
      <div className="pn-scroll">
        {list.map((f) => {
          const text = sample.trim() || (script !== "all" ? SCRIPT_SAMPLE[script] : f.scripts.find((x) => x !== "latin") ? SCRIPT_SAMPLE[f.scripts.find((x) => x !== "latin")!] : f.sample);
          const ok = supports(f.family, text);
          return (
            <button key={f.family} type="button" data-font={f.family} className="pn-row w-full gap-3 py-1.5 text-left" onClick={() => setFont(f.family, f.weights.includes(700) ? 700 : f.weights[f.weights.length - 1])}>
              <span className="w-32 shrink-0 text-2xs text-mute">{f.label}<span className="block text-[10px] text-dim">{f.scripts.map((x) => SCRIPT_LABEL[x].split(" ")[0]).join(", ")}</span></span>
              <span className={clsx("min-w-0 flex-1 truncate text-lg", !ok && "opacity-40")} style={{ fontFamily: `"${f.family}"`, fontWeight: f.weights.includes(600) ? 600 : f.weights[0] }} title={ok ? undefined : "This font doesn't cover that script"}>{text}</span>
            </button>
          );
        })}
      </div>
      <div className="ed-bar bottom text-2xs text-dim">{titles.length ? `Click a font to use it on ${titles.length} title${titles.length === 1 ? "" : "s"}` : "Select title clips, then click a font"}</div>
    </>
  );
}

// ── the templates library ────────────────────────────────────────────────────

function LibraryTab({ choice }: { choice: FrameChoice }) {
  const host = useEditorHost();
  const s = useSequence();
  const sourceId = useEditor((x) => x.sourceId);
  const [picked, setPicked] = useState<SeqTemplate>(SEQ_TEMPLATES[0]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [nest, setNest] = useState(true);
  const vis = useVisualiserDetect(picked.group === "Audiograms" ? picked.id : null);
  useEffect(() => setFields(Object.fromEntries(picked.fields.map((f) => [f.key, f.value]))), [picked]);
  // an audiogram's sound: the selected audio clip, else the dialogue mix (nested), else the media the user picks
  const selection = useEditor((x) => x.selection);
  const audiogram = picked.group === "Audiograms";
  const choices = useMemo(() => (audiogram ? audiogramChoices(project(), s, selection, s.inPoint ?? program.frame) : []), [audiogram, s, selection]);
  // with no selected clip and no dialogue the user picks the media (nothing is chosen for them)
  const mustPick = choices.length > 0 && choices[0].source.kind === "media";
  const [agPick, setAgPick] = useState(-1);
  useEffect(() => setAgPick(mustPick ? -1 : 0), [choices.length, choices[0]?.label, mustPick]);
  const agChoice = agPick >= 0 ? choices[Math.min(agPick, choices.length - 1)] ?? null : null;
  const slots = s.clips.filter(isSlot);
  const insert = (mode: "flatten" | "nest") => {
    const at = program.frame;
    let ids: string[] = [];
    host.apply(`Template ${picked.name}`, (d) => {
      const r = insertTemplate(d, d.activeSequenceId, picked, at, mode, fields);
      d.sequences = r.project.sequences;
      ids = r.clipIds;
    });
    if (ids.length) select([ids[0]]);
    toast.success(`${picked.name} added${mode === "nest" ? " as a nested sequence" : ""}`);
  };
  const social = () => {
    if (audiogram && mustPick && !agChoice) {
      toast.message("Pick the sound for the audiogram first (the edit has no selected audio clip or dialogue track)");
      document.querySelector<HTMLSelectElement>("[data-audiogram-sound] select")?.focus();
      return;
    }
    let sid = "", sound: string | null = null;
    host.apply(`New ${picked.name}`, (d) => {
      const fromId = d.activeSequenceId;
      // an audiogram: built with its chosen sound (so the visualiser is drawn, not the static waveform), then the
      // sound goes on the new sequence's A1 and the visualiser follows it — one undo step
      const ag = audiogram && agChoice ? agChoice.source : null;
      const r = withVisualiserAudio(ag ? audiogramMedia(d, fromId, ag) : null, () => socialSequence(d, fromId, picked, { nest, fields }));
      let out = r.project;
      if (ag) { const a = withAudiogramAudio(out, r.sequenceId, fromId, ag, { makeVisualiser: makeVisualizerSource }); out = a.project; sound = a.audioClipId; }
      d.sequences = out.sequences; d.activeSequenceId = r.sequenceId; sid = r.sequenceId;
    });
    program.seek(0);
    const name = project().sequences.find((x) => x.id === sid)?.name ?? picked.name;
    if (audiogram && !sound) toast.message(`New sequence “${name}”: add its sound on A1 (the edit has no audio yet), the visualiser draws it`);
    else toast.success(`New sequence “${name}”${sound && agChoice ? ` with ${agChoice.label.replace(/^The /, "the ")} on A1` : ""}`);
  };
  const fill = (clipId: string) => {
    const m = project().media.find((x) => x.id === (sourceId ?? ed().sourceId));
    if (!m) { toast.message("Open a clip in the Source monitor first, then fill the slot with it"); return; }
    host.apply(`Fill slot with ${m.name}`, (d) => {
      const i = d.sequences.findIndex((x) => x.id === d.activeSequenceId);
      d.sequences[i] = fillSlot(d.sequences[i], ctxOf(d), clipId, m);
    });
  };
  const groups = SEQ_TEMPLATE_GROUPS.filter((g) => SEQ_TEMPLATES.some((t) => t.group === g));
  // a template for a format the sequence already is can also go in at the playhead
  const sameFormat = !!picked.format && formatOf(s)?.id === picked.format;
  const pfields = useSettled(fields);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-[46%] min-w-[150px] overflow-y-auto border-r border-line">
        {groups.map((g) => (
          <div key={g}>
            <div className="pn-section cursor-default">{g}</div>
            {SEQ_TEMPLATES.filter((t) => t.group === g).map((t) => (
              <div key={t.id} data-seq-template={t.id} className={clsx("pn-row cursor-pointer py-0.5", picked.id === t.id && "sel")} onClick={() => setPicked(t)}>
                <PreviewFrame item={sequenceItem(t)} choice={choice} width={48} /><span className="min-w-0 flex-1 truncate">{t.name}</span><span className="mono text-[10px] text-dim">{t.format ?? `${t.seconds}s`}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-3">
        <PreviewCard className="mb-3" item={sequenceItem(picked, pfields)} choice={choice} name={picked.name} desc={picked.blurb} meta={`${picked.seconds} s`} dot={categoryColor(picked.group, SEQ_TEMPLATE_GROUPS)}
          data={{ "seq-preview": picked.id }} live={!picked.format || sameFormat ? templateLive(picked, pfields) : null}
          title="Move across to scrub, hold still to play · the buttons below insert it" />
        <p className="text-sm font-semibold">{picked.name}</p>
        <p className="mb-3 text-2xs text-dim">{picked.blurb}{picked.format ? ` · makes a ${picked.format} sequence` : ""}</p>
        {picked.group === "Audiograms" && (
          <p className="mb-3 text-2xs text-mute" data-visualiser={vis === null ? "checking" : vis ? "live" : "static"}>
            {vis === null ? "Looking for the audio visualiser…" : !vis ? "This build has no audio visualiser yet, so it draws a static waveform you can replace later."
              : agChoice ? "The sound goes on the new sequence's A1 and the audio-reactive visualiser draws it."
              : visualiserAudio() ? `Draws the audio-reactive visualiser from “${visualiserAudio()!.name}”.`
              : "Import the episode's audio first: without it the template draws a static waveform."}
          </p>
        )}
        {audiogram && choices.length > 0 && (
          <label className="mb-3 grid gap-0.5 text-2xs text-mute" data-audiogram-sound>Sound
            <select className="h-7 rounded-md border border-line bg-panel px-1.5 text-xs text-ink" value={agChoice ? Math.min(agPick, choices.length - 1) : -1} onChange={(e) => setAgPick(Number(e.target.value))}>
              {!agChoice && <option value={-1} disabled>Pick the episode's sound…</option>}
              {choices.map((c, i) => <option key={`${c.source.kind}:${i}`} value={i}>{c.label}</option>)}
            </select>
          </label>
        )}
        <div className="grid gap-2">
          {picked.fields.map((f) => (
            <label key={f.key} className="grid gap-0.5 text-2xs text-mute">{f.label}
              <Input className="h-7 text-xs" value={fields[f.key] ?? ""} onChange={(e) => setFields((x) => ({ ...x, [f.key]: e.target.value }))} onKeyDown={(e) => e.stopPropagation()} />
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {picked.format ? (
            <>
              <label className="flex w-full items-center gap-1.5 text-2xs text-mute"><input type="checkbox" checked={nest} onChange={(e) => setNest(e.target.checked)} />Put “{s.name}” in its main slot</label>
              <Button size="sm" variant="primary" onClick={social}>New {picked.format} sequence</Button>
              {sameFormat && <Button size="sm" variant="secondary" onClick={() => insert("flatten")}>Insert at the playhead</Button>}
            </>
          ) : (
            <>
              <Button size="sm" variant="primary" onClick={() => insert("flatten")}>Insert at the playhead</Button>
              <Button size="sm" variant="secondary" onClick={() => insert("nest")}>Insert nested</Button>
            </>
          )}
        </div>
        <div className="mt-4">
          <p className="eyebrow mb-1">Media slots in this sequence</p>
          {!slots.length && <p className="text-2xs text-dim">Templates put dark “Slot · …” clips where your footage goes.</p>}
          {slots.map((c) => (
            <div key={c.id} className="pn-row px-0">
              <span className="min-w-0 flex-1 truncate text-2xs">{c.name.replace(/^Slot · /, "")}</span>
              <Button size="sm" variant="ghost" onClick={() => fill(c.id)} title="Put the Source monitor's clip in this slot">Fill from Source</Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
