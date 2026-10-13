/**
 * The News delivery panel's sections (panels/Deliver.tsx; docs/EDITOR.md §16.11): both ratios, transparent
 * graphics, loops, language versions, TV delivery, batch from a spreadsheet, news shorts and the look preview reel,
 * plus the jobs list. Each section makes `NewsExportOptions` with the pure planners (plan.ts, batch.ts, shorts.ts,
 * reel.ts, loops.ts) and queues them (jobs.ts); the edit is saved first, because the desktop renders the saved edit.
 */
import { clsx } from "clsx";
import { ChevronDown, ChevronRight, FolderOpen, Loader2, Square, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, Progress } from "../../../components/ui";
import { desktop, newsroomBridge, type NewsExportOptions, type RenderPreset } from "../../../lib/desktop";
import { ctxOf } from "../../model/ops";
import { framesToSeconds, shortDuration } from "../../model/time";
import type { EditProject, MediaItem, Sequence, TimelineClip } from "../../model/types";
import { captionWords, placeWords, type Transcript } from "../../panels/TranscriptOps";
import { save } from "../../session";
import { ed, exec, isDirty, urlFor, useEditor, useProject, useSequence } from "../../store";
import { captionTrackFromSegments, type CaptionSegment } from "../../templates/captions";
import { companionProject } from "../companion";
import { BUILTIN_LOOKS, resolveLook } from "../looks";
import { clipInput } from "../room/hooks";
import { storyRanges } from "../rundown";
import { builtinTemplate, GFX_CATEGORIES } from "../templates/index";
import type { GfxCategory, GfxInstance, GfxRatio, GfxRole, GfxTemplate } from "../types";
import { guessMapping, mappableFields, planBatch, type BatchBackground, type BatchMapping } from "./batch";
import { ROLE_NAME } from "./build";
import { parseTable, type Table } from "./csv";
import { cancelGroup, cancelJob, clearFinished, isActive, queueExport, revealJob, useDeliveryJobs, type DeliveryJob } from "./jobs";
import { findSeamlessAsync, planLoop, SEAMLESS, seamCheck } from "./loops";
import { deliveryName } from "./names";
import { bothRatios, CODECS, generated, isAlpha, languageVersions, LOUDNESS_CHOICES, markedRange, transparent, tvDelivery, type Codec } from "./plan";
import { editLanguages, seqRatio } from "./prepare";
import { planReel, REEL_CATEGORIES } from "./reel";
import { planShorts, type PlannedShort } from "./shorts";

type GraphicClip = TimelineClip & { source: { type: "graphic"; gfx: GfxInstance } };
type Loudness = NonNullable<NewsExportOptions["loudness"]>;

// ── small parts ──────────────────────────────────────────────────────────────

const OPEN_KEY = "tatvam-editor:nr-deliver:open";
const readOpen = (): string[] => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) || "[\"ratios\"]"); } catch { return ["ratios"]; } };

function Section({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => readOpen().includes(id));
  const toggle = () => {
    setOpen(!open);
    try { const s = new Set(readOpen()); if (open) s.delete(id); else s.add(id); localStorage.setItem(OPEN_KEY, JSON.stringify([...s])); } catch { /* blocked */ }
  };
  return (
    <div data-nr-deliver={id}>
      <button type="button" className="pn-section w-full" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="flex-1 text-left">{title}</span>
      </button>
      {open && <div className="space-y-2 px-3 pb-3 pt-2"><p className="text-2xs leading-snug text-dim">{hint}</p>{children}</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-h-[26px] items-center gap-2"><span className="w-24 shrink-0 text-2xs text-mute">{label}</span><span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</span></label>;
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void }) {
  return (
    <span className="ed-seg">
      {options.map((o) => <button key={o.id} type="button" aria-pressed={value === o.id} disabled={o.disabled} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </span>
  );
}

function Go({ children, onClick, disabled, busy }: { children: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return <Button size="sm" variant="primary" loading={busy} disabled={disabled || !desktop()} onClick={onClick} title={desktop() ? undefined : "Needs the Tatvam Desktop app"}>{children}</Button>;
}

const Note = ({ children, warn }: { children: ReactNode; warn?: boolean }) => <p className={clsx("text-2xs leading-snug", warn ? "text-amber-300" : "text-dim")}>{children}</p>;

let presetCache: RenderPreset[] | null = null;
function usePresets(): RenderPreset[] {
  const [list, setList] = useState<RenderPreset[]>(presetCache ?? []);
  useEffect(() => {
    if (presetCache) return;
    void desktop()?.render.presets().then((ps) => { presetCache = ps; setList(ps); }).catch(() => undefined);
  }, []);
  return list;
}

function PresetPick({ value, onChange, vertical }: { value: string; onChange: (v: string) => void; vertical?: boolean }) {
  const presets = usePresets();
  return (
    <select className="ed-field min-w-0 flex-1" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Preset">
      <option value="">Automatic (by size)</option>
      {presets.filter((p) => p.container === "mp4" || p.container === "mov").map((p) => <option key={p.id} value={p.id}>{p.label}{vertical && p.w > p.h ? " (made vertical)" : ""}</option>)}
    </select>
  );
}

function CodecPick({ value, onChange, alphaOnly }: { value: Codec; onChange: (c: Codec) => void; alphaOnly?: boolean }) {
  const list = CODECS.filter((c) => !alphaOnly || c.alpha);
  return (
    <>
      <select className="ed-field min-w-0 flex-1" value={value} onChange={(e) => onChange(e.target.value as Codec)} aria-label="Format">
        {list.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <Note>{CODECS.find((c) => c.id === value)?.hint}</Note>
    </>
  );
}

function TemplatePick({ value, onChange, templates, none, filter }: { value: string; onChange: (id: string) => void; templates: GfxTemplate[]; none?: string; filter?: GfxCategory[] }) {
  const cats = GFX_CATEGORIES.filter((c) => !filter || filter.includes(c));
  return (
    <select className="ed-field min-w-0 flex-1" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Graphic">
      {none !== undefined && <option value="">{none}</option>}
      {cats.map((c) => {
        const list = templates.filter((t) => t.category === c);
        return list.length ? <optgroup key={c} label={c}>{list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup> : null;
      })}
    </select>
  );
}

// ── running exports ──────────────────────────────────────────────────────────

/** Saves when needed, then queues every export (one job each). */
function useRun() {
  const [busy, setBusy] = useState(false);
  const run = async (items: { label: string; o: NewsExportOptions }[], group?: string): Promise<boolean> => {
    if (!items.length) return false;
    if (!desktop() || !newsroomBridge()) { toast.message("Exports need the Tatvam Desktop app"); return false; }
    const path = ed().path;
    if (!path) { toast.message("Save the edit first"); return false; }
    setBusy(true);
    try {
      if (isDirty() && !(await save())) return false;
      let ok = 0;
      for (const it of items) if ((await queueExport(it.label, { ...it.o, editPath: path }, group)).status !== "failed") ok++;
      if (ok) toast.success(`${ok} export${ok === 1 ? "" : "s"} started: they're listed at the bottom of this panel`);
      if (ok < items.length) toast.error(`${items.length - ok} couldn't start: see the list below`);
      return ok > 0;
    } finally { setBusy(false); }
  };
  return { run, busy };
}

const pathOr = () => ed().path ?? "";
const base = (s: Sequence) => ({ editPath: pathOr(), sequence: s });

/** Templates the saved edit can't find on its own (library templates not copied in): sent with the export. */
function missingTemplates(p: EditProject, used: GfxTemplate[]): Record<string, GfxTemplate> {
  return Object.fromEntries(used.filter((t) => !p.newsroom?.templates?.[t.id] && !builtinTemplate(t.id)).map((t) => [t.id, t]));
}

function RangePick({ s, value, onChange }: { s: Sequence; value: "all" | "inout"; onChange: (v: "all" | "inout") => void }) {
  return <Seg value={value} onChange={onChange} options={[{ id: "all", label: "Whole sequence" }, { id: "inout", label: "In to out", disabled: !markedRange(s) }]} />;
}

// ── 1. both ratios ───────────────────────────────────────────────────────────

export function BothRatios() {
  const s = useSequence();
  const { run, busy } = useRun();
  const [preset, setPreset] = useState("");
  const [loud, setLoud] = useState<Loudness>("youtube");
  const [legal, setLegal] = useState(false);
  const [range, setRange] = useState<"all" | "inout">("all");
  const list = bothRatios(base(s), { ...(preset ? { preset } : {}), loudness: loud, ...(legal ? { legal } : {}), ...(range === "inout" ? { range: markedRange(s) } : {}) });
  return (
    <Section id="ratios" title="Both ratios" hint="The 16:9 and the 9:16 of this sequence in one go. The 9:16 uses each graphic's vertical design and reframes the pictures.">
      <Row label="Quality"><PresetPick value={preset} onChange={setPreset} /></Row>
      <Row label="Loudness">
        <select className="ed-field min-w-0 flex-1" value={loud} onChange={(e) => setLoud(e.target.value as Loudness)} aria-label="Loudness">
          {LOUDNESS_CHOICES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </Row>
      <Row label="Colours"><label className="flex items-center gap-1.5 text-2xs"><input type="checkbox" checked={legal} onChange={(e) => setLegal(e.target.checked)} />Broadcast-safe (legal range 16–235)</label></Row>
      <Row label="Range"><RangePick s={s} value={range} onChange={setRange} /></Row>
      <Note>Makes {list.map((o) => `${o.name}.mp4`).join(" and ")} in the edit's Exports\News folder.</Note>
      <Go busy={busy} onClick={() => void run(list.map((o) => ({ label: o.name!, o })), "ratios")}>Export 16:9 and 9:16</Go>
    </Section>
  );
}

// ── 2. transparent graphics ──────────────────────────────────────────────────

function useSelectedGraphics(s: Sequence): GraphicClip[] {
  const sel = useEditor((x) => x.selection);
  return useMemo(() => s.clips.filter((c): c is GraphicClip => sel.includes(c.id) && c.source.type === "graphic"), [s, sel]);
}

export function Transparent() {
  const s = useSequence();
  const { run, busy } = useRun();
  const picked = useSelectedGraphics(s);
  const roles = useMemo(() => [...new Set(s.tracks.filter((t) => t.gfxRole && s.clips.some((c) => c.trackId === t.id)).map((t) => t.gfxRole!))], [s]);
  const [what, setWhat] = useState<"all" | "role" | "selected">("all");
  const [role, setRole] = useState<GfxRole | "">("");
  const [codec, setCodec] = useState<Codec>("prores4444");
  const [other, setOther] = useState(false);
  const [range, setRange] = useState<"all" | "inout">("all");
  const own = seqRatio(s.width, s.height);
  const r = role || roles[0] || "";
  const nothing = !roles.length;
  const go = () => {
    const o = transparent(base(s), codec as Exclude<Codec, "mp4">, {
      ...(what === "role" && r ? { roles: [r], suffix: ROLE_NAME[r as GfxRole] } : {}),
      ...(what === "selected" ? { clipIds: picked.map((c) => c.id), suffix: picked.length === 1 ? picked[0].name : "selected graphics" } : {}),
      ...(other ? { ratio: own === "9:16" ? "16:9" : "9:16" } : {}),
      ...(range === "inout" ? { range: markedRange(s) } : {}),
    });
    void run([{ label: o.name!, o }], "transparent");
  };
  return (
    <Section id="transparent" title="Transparent graphics" hint="Only the graphics, on a see-through background, to lay over pictures in another editor or playout system.">
      <Row label="Graphics">
        <Seg value={what} onChange={setWhat} options={[{ id: "all", label: "All" }, { id: "role", label: "One kind", disabled: nothing }, { id: "selected", label: `Selected (${picked.length})`, disabled: !picked.length }]} />
        {what === "role" && (
          <select className="ed-field" value={r} onChange={(e) => setRole(e.target.value as GfxRole)} aria-label="Kind of graphic">
            {roles.map((x) => <option key={x} value={x}>{ROLE_NAME[x]}</option>)}
          </select>
        )}
      </Row>
      <Row label="Format"><CodecPick value={codec} onChange={setCodec} alphaOnly /></Row>
      <Row label="Ratio"><Seg value={other ? "o" : "s"} onChange={(v) => setOther(v === "o")} options={[{ id: "s", label: `This one (${own})` }, { id: "o", label: own === "9:16" ? "16:9" : "9:16" }]} /></Row>
      <Row label="Range"><RangePick s={s} value={range} onChange={setRange} /></Row>
      {nothing && <Note warn>This sequence has no graphics yet.</Note>}
      <Go busy={busy} disabled={nothing || (what === "selected" && !picked.length)} onClick={go}>Export graphics</Go>
    </Section>
  );
}

// ── 3. loops ─────────────────────────────────────────────────────────────────

type Drawer = (t: number) => Uint8ClampedArray | null;
/** Small frames of a graphic clip (the renderer), for the seam check. */
async function drawerFor(p: EditProject, seq: Sequence, clip: GraphicClip): Promise<Drawer | null> {
  const [{ drawGraphic, ensureGraphicAssets }] = await Promise.all([import("../render/index")]);
  const input = clipInput(p, seq, clip, urlFor);
  if (!input || typeof OffscreenCanvas === "undefined") return null;
  await ensureGraphicAssets(input).catch(() => undefined);
  const w = seq.width >= seq.height ? 192 : 108, h = seq.width >= seq.height ? 108 : 192;
  const g = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  const dur = framesToSeconds(clip.duration, seq.fps);
  return (t) => { g.clearRect(0, 0, w, h); drawGraphic(g, input, w, h, t, dur); return g.getImageData(0, 0, w, h).data; };
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const blank = (px: ArrayLike<number>) => { for (let i = 3; i < px.length; i += 4) if (px[i]) return false; return true; };

export function Loop({ templates }: { templates: GfxTemplate[] }) {
  const p = useProject();
  const s = useSequence();
  const { run, busy } = useRun();
  const picked = useSelectedGraphics(s);
  const clip = picked[0];
  const looping = templates.filter((t) => t.loop || ["Tickers", "Bugs", "Backgrounds"].includes(t.category));
  const [tplId, setTplId] = useState("");
  const template = clip ? templates.find((t) => t.id === clip.source.gfx.template) ?? p.newsroom?.templates?.[clip.source.gfx.template] : templates.find((t) => t.id === (tplId || looping[0]?.id));
  const [seconds, setSeconds] = useState(10);
  const [bg, setBg] = useState<"none" | "color">("none");
  const [color, setColor] = useState("#000000");
  const [codec, setCodec] = useState<Codec>("prores4444");
  const [frames, setFrames] = useState<number | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { setFrames(null); setCheck(null); }, [clip?.id, tplId, seconds]);
  const plan = useMemo(() => {
    if (!template) return null;
    const { template: _t, ...gfx } = clip?.source.gfx ?? { template: "", values: {} };
    return planLoop(template, gfx, { seconds, width: s.width, height: s.height, fps: s.fps, background: bg === "color" ? color : null, ...(frames ? { frames } : {}),
      look: resolveLook(p, clip?.source.gfx.look) });
  }, [template, clip, seconds, s.width, s.height, s.fps, bg, color, frames, p]);
  const outCodec: Codec = bg === "color" ? "mp4" : codec === "mp4" ? "prores4444" : codec;
  const drawer = async () => {
    if (!plan) return null;
    const c = plan.sequence.clips.find((x): x is GraphicClip => x.source.type === "graphic")!;
    return drawerFor({ ...p, sequences: [...p.sequences, plan.sequence] }, plan.sequence, c);
  };
  const checkSeam = async () => {
    if (!plan) return;
    setChecking(true);
    try {
      const draw = await drawer();
      if (!draw) { setCheck("The loop can't be checked here yet (the graphics renderer isn't ready)."); return; }
      const first = draw(plan.startFrame / s.fps);
      if (!first || blank(first)) { setCheck("Nothing is drawn at the loop's start, so there's nothing to compare."); return; }
      const r = seamCheck(draw, plan.startFrame, plan.length.frames, s.fps);
      setCheck(!r ? "Couldn't draw the frames." : r.ok ? "Seamless: the frame after the last is the same as the first." : `Not seamless yet: the end jumps (${(r.diff * 100).toFixed(2)} % different).${plan.open.length ? " Try “Find a seamless length”." : ""}`);
    } finally { setChecking(false); }
  };
  const find = async () => {
    if (!plan) return;
    setChecking(true);
    try {
      const draw = await drawer();
      if (!draw) { setCheck("The loop can't be checked here yet (the graphics renderer isn't ready)."); return; }
      // from half the length asked for up to a minute and a half (a crawl goes round in about that)
      const want = Math.round(seconds * s.fps);
      const r = await findSeamlessAsync(draw, plan.startFrame, s.fps, Math.max(1, Math.round(want * 0.5)), Math.max(Math.round(want * 1.5), Math.round(90 * s.fps)));
      if (!r) { setCheck("Couldn't draw the frames."); return; }
      setFrames(r.frames);
      setCheck(r.diff <= SEAMLESS ? `Seamless at ${(r.frames / s.fps).toFixed(2)} s.` : `Closest is ${(r.frames / s.fps).toFixed(2)} s (${(r.diff * 100).toFixed(2)} % different at the seam).`);
    } finally { setChecking(false); }
  };
  const go = () => {
    if (!plan || !template) return;
    const name = deliveryName(`${template.name} loop ${plan.length.seconds.toFixed(1).replace(/\.0$/, "")}s`);
    const o = generated(pathOr(), plan.sequence, { codec: outCodec, name, range: plan.range, templates: missingTemplates(p, [template]) });
    void run([{ label: name, o }], "loop");
  };
  return (
    <Section id="loop" title="Loop" hint="A ticker, bug or moving background as a loop that plays end to end without a jump, for playout or a website.">
      <Row label="Graphic">
        {clip ? <span className="truncate text-xs">{clip.name} <span className="text-dim">(selected)</span></span>
          : <TemplatePick value={tplId || looping[0]?.id || ""} onChange={setTplId} templates={looping.length ? looping : templates} />}
      </Row>
      <Row label="Length"><input type="number" className="ed-field w-16" min={1} max={300} value={seconds} onChange={(e) => setSeconds(Math.max(1, Math.min(300, Number(e.target.value) || 1)))} aria-label="Seconds" /><span className="text-2xs text-dim">seconds</span></Row>
      <Row label="Behind it">
        <Seg value={bg} onChange={setBg} options={[{ id: "none", label: "Transparent" }, { id: "color", label: "A colour" }]} />
        {bg === "color" && <input type="color" className="h-6 w-8 rounded border border-line bg-transparent" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Colour" />}
      </Row>
      {bg === "none" ? <Row label="Format"><CodecPick value={outCodec} onChange={setCodec} alphaOnly /></Row> : <Note>Exported as an MP4.</Note>}
      {plan && (
        <Note>
          {frames ? `Loop length ${plan.length.seconds.toFixed(2)} s (found by drawing).`
            : plan.still ? `It doesn't change once it's in, so any length loops: ${plan.length.seconds.toFixed(2)} s.`
            : plan.length.exact ? `Its animation repeats every ${(plan.length.seconds / plan.length.cycles).toFixed(2)} s, so the loop is ${plan.length.seconds.toFixed(2)} s (${plan.length.cycles} repeat${plan.length.cycles === 1 ? "" : "s"}).`
            : `${cap(plan.open.join("; "))}: check the loop, or find a seamless length by drawing (${plan.length.seconds.toFixed(2)} s now).`}
        </Note>
      )}
      {check && <Note warn={!/^Seamless/.test(check)}>{check}</Note>}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" loading={checking} disabled={!plan} onClick={() => void checkSeam()}>Check the loop</Button>
        {plan && !plan.length.exact && <Button size="sm" variant="ghost" disabled={checking} onClick={() => void find()}>Find a seamless length</Button>}
        <Go busy={busy} disabled={!plan} onClick={go}>Export loop</Go>
      </div>
    </Section>
  );
}

// ── 4. language versions ─────────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = { en: "English", hi: "Hindi", kn: "Kannada", te: "Telugu", ta: "Tamil", ml: "Malayalam", mr: "Marathi", bn: "Bengali", gu: "Gujarati", pa: "Punjabi", or: "Odia", ur: "Urdu" };

export function Languages() {
  const p = useProject();
  const s = useSequence();
  const { run, busy } = useRun();
  const langs = useMemo(() => editLanguages(p), [p]);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [ratio, setRatio] = useState<"own" | "other" | "both">("own");
  const own = seqRatio(s.width, s.height), other: GfxRatio = own === "9:16" ? "16:9" : "9:16";
  const chosen = langs.filter((l) => on.has(l));
  const list = (ratio === "both" ? [undefined, other] : [ratio === "other" ? other : undefined]).flatMap((r) => languageVersions(base(s), chosen, r ? { ratio: r } : {}));
  return (
    <Section id="langs" title="Language versions" hint="The same sequence with every graphic in another language (the language tabs in Fill in).">
      {langs.length ? (
        <Row label="Languages">
          {langs.map((l) => (
            <label key={l} className="flex items-center gap-1 text-2xs">
              <input type="checkbox" checked={on.has(l)} onChange={() => setOn((x) => { const n = new Set(x); if (n.has(l)) n.delete(l); else n.add(l); return n; })} />{LANG_NAMES[l] ?? l}
            </label>
          ))}
        </Row>
      ) : <Note>No graphic has another language yet. Add one in Fill in (its language tabs), then come back.</Note>}
      <Row label="Ratio"><Seg value={ratio} onChange={setRatio} options={[{ id: "own", label: own }, { id: "other", label: other }, { id: "both", label: "Both" }]} /></Row>
      <Go busy={busy} disabled={!list.length} onClick={() => void run(list.map((o) => ({ label: o.name!, o })), "langs")}>
        Export {list.length || ""} version{list.length === 1 ? "" : "s"}
      </Go>
    </Section>
  );
}

// ── 5. TV delivery ───────────────────────────────────────────────────────────

export function Tv() {
  const s = useSequence();
  const { run, busy } = useRun();
  const presets = usePresets();
  const [preset, setPreset] = useState("broadcast1080");
  const [both, setBoth] = useState(false);
  const [range, setRange] = useState<"all" | "inout">("all");
  const has = presets.some((p) => p.id === preset);
  const list = tvDelivery(base(s), { both, preset: has || !presets.length ? preset : undefined, ...(range === "inout" ? { range: markedRange(s) } : {}) });
  return (
    <Section id="tv" title="TV delivery" hint="For broadcast: sound at EBU R128 (−23 LUFS, true peak −1 dBTP) and broadcast-safe colours (legal range 16–235).">
      <Row label="Quality"><PresetPick value={preset} onChange={setPreset} /></Row>
      <Row label="Also 9:16"><input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} aria-label="Also the other ratio" /></Row>
      <Row label="Range"><RangePick s={s} value={range} onChange={setRange} /></Row>
      <Go busy={busy} onClick={() => void run(list.map((o) => ({ label: o.name!, o })), "tv")}>Export for TV</Go>
    </Section>
  );
}

// ── 6. batch from a spreadsheet ──────────────────────────────────────────────

export function Batch({ templates }: { templates: GfxTemplate[] }) {
  const p = useProject();
  const s = useSequence();
  const { run, busy } = useRun();
  const [table, setTable] = useState<Table & { name: string } | null>(null);
  const [paste, setPaste] = useState("");
  const [tplId, setTplId] = useState("");
  const template = templates.find((t) => t.id === tplId) ?? templates.find((t) => t.category === "Straps") ?? templates[0];
  const [mapping, setMapping] = useState<BatchMapping>({});
  const [nameCol, setNameCol] = useState("");
  const [lenCol, setLenCol] = useState("");
  const [seconds, setSeconds] = useState(6);
  const [bgKind, setBgKind] = useState<BatchBackground["kind"]>("color");
  const [color, setColor] = useState("#000000");
  const [mediaId, setMediaId] = useState("");
  const [codec, setCodec] = useState<Codec>("prores4444");
  const [preset, setPreset] = useState("");
  const pictures = p.media.filter((m) => m.kind !== "audio");
  useEffect(() => { if (table && template) setMapping(guessMapping(template, table.columns)); }, [table, template?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = (name: string, text: string) => {
    const t = parseTable(text);
    if (!t.columns.length) { toast.error("That file has no rows"); return; }
    setTable({ ...t, name });
    setNameCol(t.columns[0]);
  };
  const open = async () => {
    const b = newsroomBridge();
    if (b) { const f = await b.readTextFile().catch((e) => { toast.error(String((e as Error).message)); return null; }); if (f) load(f.name, f.text); return; }
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".csv,.tsv,.txt";
    inp.onchange = () => { const f = inp.files?.[0]; if (f) void f.text().then((t) => load(f.name, t)); };
    inp.click();
  };
  const background: BatchBackground = bgKind === "media" ? { kind: "media", mediaId: mediaId || pictures[0]?.id || "" } : bgKind === "color" ? { kind: "color", color } : { kind: "transparent" };
  const rows = useMemo(() => table && template ? planBatch({ template, columns: table.columns, rows: table.rows, mapping, nameColumn: nameCol || undefined,
    nameBase: template.name, lengthColumn: lenCol || undefined, seconds, background, width: s.width, height: s.height, fps: s.fps, media: p.media }) : [],
  [table, template, mapping, nameCol, lenCol, seconds, bgKind, color, mediaId, s.width, s.height, s.fps, p.media]); // eslint-disable-line react-hooks/exhaustive-deps
  const outCodec: Codec = bgKind === "transparent" ? (codec === "mp4" ? "prores4444" : codec) : "mp4";
  const problems = rows.flatMap((r) => r.problems.map((x) => `${r.name}: ${x}`));
  const go = () => {
    if (!template) return;
    const extra = missingTemplates(p, [template]);
    void run(rows.map((r) => ({ label: r.name, o: generated(pathOr(), r.sequence, { codec: outCodec, name: r.name, templates: extra, ...(outCodec === "mp4" && preset ? { preset } : {}) }) })), "batch");
  };
  const fields = template ? mappableFields(template) : [];
  return (
    <Section id="batch" title="Batch from a spreadsheet" hint="One graphic, many videos: each row of a CSV (Excel: Save as CSV) fills the graphic's blanks and becomes its own short video.">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => void open()}>Open a spreadsheet…</Button>
        {table && <span className="text-2xs text-mute">{table.name} · {table.rows.length} row{table.rows.length === 1 ? "" : "s"}</span>}
      </div>
      {!table && (
        <div className="space-y-1">
          <textarea className="ed-field h-16 w-full py-1" placeholder={"Or paste rows from a sheet here (the first row names the columns)"} value={paste} onChange={(e) => setPaste(e.target.value)} />
          {paste.trim() && <Button size="sm" variant="ghost" onClick={() => load("Pasted rows", paste)}>Use these rows</Button>}
        </div>
      )}
      {table && (
        <>
          <Row label="Graphic"><TemplatePick value={template?.id ?? ""} onChange={setTplId} templates={templates} /></Row>
          <div className="rounded-md border border-line">
            <div className="flex px-2 py-1 text-2xs text-dim"><span className="w-1/2">Blank in the graphic</span><span>Column</span></div>
            {fields.map((f) => (
              <div key={f.id} className="pn-row">
                <span className="w-1/2 truncate text-xs">{f.label}</span>
                <select className="ed-field min-w-0 flex-1" value={mapping[f.id] ?? ""} onChange={(e) => setMapping({ ...mapping, [f.id]: e.target.value })} aria-label={`Column for ${f.label}`}>
                  <option value="">Keep the sample</option>
                  {table.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            ))}
          </div>
          <Row label="File names">
            <select className="ed-field min-w-0 flex-1" value={nameCol} onChange={(e) => setNameCol(e.target.value)} aria-label="Name column">
              <option value="">Numbered</option>
              {table.columns.map((c) => <option key={c} value={c}>From “{c}”</option>)}
            </select>
          </Row>
          <Row label="Length">
            <input type="number" className="ed-field w-16" min={1} max={600} value={seconds} onChange={(e) => setSeconds(Math.max(1, Math.min(600, Number(e.target.value) || 1)))} aria-label="Seconds" />
            <span className="text-2xs text-dim">s, or</span>
            <select className="ed-field min-w-0 flex-1" value={lenCol} onChange={(e) => setLenCol(e.target.value)} aria-label="Length column">
              <option value="">the same for every row</option>
              {table.columns.map((c) => <option key={c} value={c}>from “{c}”</option>)}
            </select>
          </Row>
          <Row label="Behind it">
            <Seg value={bgKind} onChange={setBgKind} options={[{ id: "color", label: "Colour" }, { id: "media", label: "A clip", disabled: !pictures.length }, { id: "transparent", label: "Transparent" }]} />
            {bgKind === "color" && <input type="color" className="h-6 w-8 rounded border border-line bg-transparent" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Colour" />}
            {bgKind === "media" && (
              <select className="ed-field min-w-0 flex-1" value={mediaId || pictures[0]?.id} onChange={(e) => setMediaId(e.target.value)} aria-label="Background clip">
                {pictures.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
          </Row>
          {bgKind === "transparent" ? <Row label="Format"><CodecPick value={outCodec} onChange={setCodec} alphaOnly /></Row> : <Row label="Quality"><PresetPick value={preset} onChange={setPreset} /></Row>}
          <Note>{rows.length ? `${rows.length} video${rows.length === 1 ? "" : "s"}: ${rows.slice(0, 4).map((r) => r.name).join(", ")}${rows.length > 4 ? " …" : ""}` : "No row has anything in the chosen columns."}</Note>
          {problems.slice(0, 4).map((x) => <Note key={x} warn>{x}</Note>)}
          {problems.length > 4 && <Note warn>…and {problems.length - 4} more.</Note>}
          <div className="flex flex-wrap gap-1.5">
            <Go busy={busy} disabled={!rows.length || rows.length > 300} onClick={go}>Export {rows.length} video{rows.length === 1 ? "" : "s"}</Go>
            <Button size="sm" variant="ghost" onClick={() => setTable(null)}>Another file</Button>
          </div>
          {rows.length > 300 && <Note warn>At most 300 rows at a time.</Note>}
        </>
      )}
    </Section>
  );
}

// ── 7. news shorts ───────────────────────────────────────────────────────────

const TRANSCRIPTS = "tatvam-editor:transcripts:v1";
/** The Transcript panel's transcripts (by media file) for this edit's media. */
function transcriptsOf(media: MediaItem[]): Record<string, Transcript> {
  let store: Record<string, Transcript> = {};
  try { store = JSON.parse(localStorage.getItem(TRANSCRIPTS) || "{}"); } catch { /* none */ }
  const out: Record<string, Transcript> = {};
  for (const m of media) { const t = store[(m.path || m.id).toLowerCase()]; if (t) out[m.id] = { ...t, mediaId: m.id }; }
  return out;
}

/** Caption cues (timeline frames) from the transcripts of what's on the sequence; vertical sizes. */
function cuesFor(p: EditProject, s: Sequence) {
  const words = placeWords(s, ctxOf(p), transcriptsOf(p.media));
  if (!words.length) return [];
  const segs: CaptionSegment[] = [];
  let cur: CaptionSegment | null = null;
  for (const w of words) {
    const a = framesToSeconds(w.from, s.fps), b = framesToSeconds(w.to, s.fps);
    if (!cur || a - cur.end > 0.6 || w.speaker !== cur.speaker) { cur = { start: a, end: b, text: w.text, words: [], speaker: w.speaker }; segs.push(cur); }
    else { cur.end = b; cur.text += ` ${w.text}`; }
    cur.words!.push({ start: a, end: b, text: w.text });
  }
  return captionTrackFromSegments(segs, { fps: s.fps, height: 1080, preset: "karaoke-box", maxWords: 4, maxChars: 26 });
}

export function Shorts({ templates }: { templates: GfxTemplate[] }) {
  const p = useProject();
  const s = useSequence();
  const { run, busy } = useRun();
  const stories = p.newsroom?.rundown ?? [];
  const ranges = useMemo(() => storyRanges(s, stories, "auto"), [s, stories]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [cardSecs, setCardSecs] = useState(2.5);
  const [cardId, setCardId] = useState("");
  const [strapId, setStrapId] = useState(() => templates.find((t) => t.category === "Straps")?.id ?? "");
  const [tickerId, setTickerId] = useState(() => templates.find((t) => t.category === "Tickers")?.id ?? "");
  const [captions, setCaptions] = useState(true);
  const [preset, setPreset] = useState("");
  const [list, setList] = useState<PlannedShort[] | null>(null);
  const [extra, setExtra] = useState<Sequence[]>([]);
  const onTimeline = captionWords(s).length > 0;
  const transcribed = useMemo(() => Object.keys(transcriptsOf(p.media)).length > 0, [p.media]);
  const look = resolveLook(p);
  const byId = (id: string) => templates.find((t) => t.id === id) ?? null;
  const preview = () => {
    const vertical = s.height > s.width;
    const comp = vertical ? { project: p, sequenceId: s.id } : companionProject(p, s.id, "9:16");
    const src = comp.project.sequences.find((x) => x.id === comp.sequenceId) ?? s;
    const own = new Set(p.sequences.map((x) => x.id));
    setExtra(comp.project.sequences.filter((x) => !own.has(x.id) && x.id !== comp.sequenceId));
    const chosen = stories.filter((st) => !off.has(st.id)).map((st) => { const r = ranges.find((x) => x.storyId === st.id); return r ? { ...st, start: r.start, end: r.end } : st; });
    setList(planShorts({ stories: chosen, people: p.newsroom?.people, source: { project: comp.project, sequence: src },
      card: { seconds: cardSecs, template: byId(cardId), color: look.colors.primary, font: look.fonts.headline.family, textColor: look.colors.textOnPrimary },
      strap: byId(strapId), ticker: byId(tickerId), cues: captions && !onTimeline ? cuesFor(p, s) : [] }));
  };
  useEffect(() => { setList(null); }, [s, stories, off, cardSecs, cardId, strapId, tickerId, captions]);
  const ready = (list ?? []).filter((x) => x.sequence);
  const go = () => {
    const used = [byId(cardId), byId(strapId), byId(tickerId)].filter((t): t is GfxTemplate => !!t);
    const tpls = missingTemplates(p, used);
    void run(ready.map((x) => ({ label: x.name, o: { ...generated(pathOr(), x.sequence!, { codec: "mp4", name: x.name, extra, templates: tpls, ...(preset ? { preset } : {}) }), ratio: "9:16" as const } })), "shorts");
  };
  if (!stories.length) {
    return <Section id="shorts" title="News shorts" hint="One vertical short per story of the rundown."><Note>The rundown is empty. Add stories in the Rundown panel (and Build them onto the timeline) first.</Note></Section>;
  }
  return (
    <Section id="shorts" title="News shorts" hint="One vertical short per story of the rundown: a headline card, the story's part of the sequence in 9:16, its strap, the ticker and captions.">
      <div className="max-h-40 overflow-auto rounded-md border border-line">
        {stories.map((st) => {
          const r = ranges.find((x) => x.storyId === st.id);
          return (
            <label key={st.id} className="pn-row">
              <input type="checkbox" checked={!off.has(st.id)} onChange={() => setOff((x) => { const n = new Set(x); if (n.has(st.id)) n.delete(st.id); else n.add(st.id); return n; })} />
              <span className="min-w-0 flex-1 truncate text-xs">{st.slug || st.headline}</span>
              <span className="text-2xs text-dim">{r ? shortDuration(r.end - r.start, s.fps) : "not placed"}</span>
            </label>
          );
        })}
      </div>
      <Row label="Headline card">
        <input type="number" className="ed-field w-14" min={0} max={10} step={0.5} value={cardSecs} onChange={(e) => setCardSecs(Math.max(0, Math.min(10, Number(e.target.value) || 0)))} aria-label="Card seconds" />
        <span className="text-2xs text-dim">s</span>
        <TemplatePick value={cardId} onChange={setCardId} templates={templates} none="The headline on the look's colour" filter={["Openers", "Boards", "Straps"]} />
      </Row>
      <Row label="Strap"><TemplatePick value={strapId} onChange={setStrapId} templates={templates} none="None" filter={["Straps"]} /></Row>
      <Row label="Ticker"><TemplatePick value={tickerId} onChange={setTickerId} templates={templates} none="None" filter={["Tickers"]} /></Row>
      <Row label="Captions">
        {onTimeline ? <Note>From the captions on the timeline.</Note> : transcribed
          ? <label className="flex items-center gap-1.5 text-2xs"><input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />From the transcript</label>
          : <Note>No transcript yet (Transcript panel), so no captions.</Note>}
      </Row>
      <Row label="Quality"><PresetPick value={preset} onChange={setPreset} vertical /></Row>
      {!list ? <Button size="sm" variant="secondary" onClick={preview}>Show the shorts</Button> : (
        <>
          <div className="max-h-48 overflow-auto rounded-md border border-line">
            {list.map((x) => (
              <div key={x.story.id} className="border-b border-line/60 px-2 py-1 last:border-0">
                <div className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{x.name}</span><span className="text-2xs text-dim">{x.sequence ? `${x.seconds.toFixed(1)} s` : "—"}</span></div>
                {x.sequence && <p className="text-2xs text-dim">{[x.parts.card && "card", x.parts.strap !== "none" && `strap${x.parts.strap === "own" ? " (its own)" : ""}`,
                  x.parts.ticker !== "none" && `ticker${x.parts.ticker === "own" ? " (its own)" : ""}`, x.parts.captions && `${x.parts.captions} captions`].filter(Boolean).join(" · ")}</p>}
                {x.problems.map((m) => <Note key={m} warn>{m}</Note>)}
              </div>
            ))}
          </div>
          <Go busy={busy} disabled={!ready.length} onClick={go}>Export {ready.length} short{ready.length === 1 ? "" : "s"}</Go>
        </>
      )}
    </Section>
  );
}

// ── 8. look preview reel ─────────────────────────────────────────────────────

export function Reel({ templates }: { templates: GfxTemplate[] }) {
  const p = useProject();
  const s = useSequence();
  const { run, busy } = useRun();
  const looks = useMemo(() => { const own = Object.values(p.newsroom?.looks ?? {}); return [...own, ...BUILTIN_LOOKS.filter((l) => !own.some((o) => o.id === l.id))]; }, [p.newsroom?.looks]);
  const [lookId, setLookId] = useState(() => resolveLook(p).id);
  const [cats, setCats] = useState<Set<GfxCategory>>(new Set(REEL_CATEGORIES));
  const [per, setPer] = useState<"1" | "3" | "0">("3");
  const [seconds, setSeconds] = useState(4);
  const [vertical, setVertical] = useState(false);
  const look = looks.find((l) => l.id === lookId) ?? resolveLook(p);
  const size = vertical ? { width: Math.min(s.width, s.height), height: Math.max(s.width, s.height) } : { width: Math.max(s.width, s.height), height: Math.min(s.width, s.height) };
  const reel = useMemo(() => planReel({ look, templates, categories: REEL_CATEGORIES.filter((c) => cats.has(c)), perCategory: Number(per), seconds, titleSeconds: 2,
    ...size, fps: s.fps }), [look, templates, cats, per, seconds, size.width, size.height, s.fps]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = framesToSeconds(reel.items.reduce((m, it) => Math.max(m, it.start + it.frames), 0), s.fps);
  const add = () => {
    exec(`Add ${reel.sequence.name}`, (d) => ({ ...d, sequences: [...d.sequences, reel.sequence] }));
    toast.success(`${reel.sequence.name} is in the project: open it from the Project panel`);
  };
  const name = deliveryName(`${look.name} look preview`, { ratio: vertical ? "9:16" : null });
  const go = () => void run([{ label: name, o: generated(pathOr(), reel.sequence, { codec: "mp4", name, templates: missingTemplates(p, Object.values(reel.templates)) }) }], "reel");
  return (
    <Section id="reel" title="Look preview reel" hint="Every kind of graphic in a channel look with its sample text, one after another with a title card each: a video to send a client for approval.">
      <Row label="Look">
        <select className="ed-field min-w-0 flex-1" value={look.id} onChange={(e) => setLookId(e.target.value)} aria-label="Look">
          {looks.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Row>
      <Row label="Show">
        {REEL_CATEGORIES.map((c) => (
          <label key={c} className="flex items-center gap-1 text-2xs">
            <input type="checkbox" checked={cats.has(c)} onChange={() => setCats((x) => { const n = new Set(x); if (n.has(c)) n.delete(c); else n.add(c); return n; })} />{c}
          </label>
        ))}
      </Row>
      <Row label="Of each"><Seg value={per} onChange={setPer} options={[{ id: "1", label: "One" }, { id: "3", label: "Three" }, { id: "0", label: "All" }]} /></Row>
      <Row label="Each for"><input type="number" className="ed-field w-14" min={2} max={15} value={seconds} onChange={(e) => setSeconds(Math.max(2, Math.min(15, Number(e.target.value) || 4)))} aria-label="Seconds" /><span className="text-2xs text-dim">seconds</span></Row>
      <Row label="Ratio"><Seg value={vertical ? "v" : "h"} onChange={(v) => setVertical(v === "v")} options={[{ id: "h", label: "16:9" }, { id: "v", label: "9:16" }]} /></Row>
      <Note>{reel.items.length ? `${reel.items.length} graphics, ${Math.round(total)} s.` : "No graphics in the chosen kinds yet."}</Note>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" disabled={!reel.items.length} onClick={add}>Add to the project</Button>
        <Go busy={busy} disabled={!reel.items.length} onClick={go}>Export the reel</Go>
      </div>
    </Section>
  );
}

// ── jobs ─────────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<DeliveryJob["status"], string> = {
  starting: "Starting", queued: "Waiting", preparing: "Preparing", downloading: "Getting media", rendering: "Rendering", uploading: "Uploading",
  done: "Done", failed: "Didn't finish", cancelled: "Cancelled",
};

export function JobsList() {
  const jobs = useDeliveryJobs();
  if (!jobs.length) return null;
  const groups = [...new Set(jobs.filter((j) => j.group && isActive(j)).map((j) => j.group!))];
  return (
    <div className="max-h-[40%] shrink-0 overflow-auto border-t border-line" data-nr-jobs>
      <div className="ed-bar !h-7">
        <span className="flex-1 text-2xs font-medium text-mute">Exports</span>
        {groups.map((g) => <button key={g} type="button" className="ed-menubtn !h-5 !text-2xs" onClick={() => void cancelGroup(g)}>Stop all ({g})</button>)}
        {jobs.some((j) => !isActive(j)) && <button type="button" className="ed-menubtn !h-5 !text-2xs" onClick={clearFinished}>Clear finished</button>}
      </div>
      {jobs.map((j) => (
        <div key={j.id} className="px-2.5 py-1.5" data-job={j.status}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs">{j.label}</span>
            <span className={clsx("text-2xs", j.status === "failed" ? "text-red-300" : j.status === "done" ? "text-emerald-400" : "text-dim")}>
              {isActive(j) && j.status !== "queued" && j.status !== "starting" ? `${Math.round(j.progress * 100)} %` : STATUS_LABEL[j.status]}
            </span>
            {isActive(j) && <button type="button" className="ed-menubtn !h-5 !px-1" title="Stop" aria-label="Stop" onClick={() => void cancelJob(j.id)}><Square className="size-3" /></button>}
            {j.status === "done" && <button type="button" className="ed-menubtn !h-5 !px-1" title="Show in folder" aria-label="Show in folder" onClick={() => void revealJob(j.id)}><FolderOpen className="size-3.5" /></button>}
            {j.status === "starting" && <Loader2 className="size-3 animate-spin text-dim" />}
          </div>
          {isActive(j) && j.status !== "starting" && <Progress value={j.progress} size="sm" className="mt-1" />}
          {isActive(j) && <p className="truncate text-2xs text-dim">{j.step}{j.eta_s ? ` · about ${j.eta_s < 90 ? `${j.eta_s} s` : `${Math.round(j.eta_s / 60)} min`} left` : ""}</p>}
          {j.status === "failed" && j.error && <p className="flex items-start gap-1 text-2xs text-red-300"><X className="mt-0.5 size-3 shrink-0" />{j.error}</p>}
        </div>
      ))}
    </div>
  );
}
