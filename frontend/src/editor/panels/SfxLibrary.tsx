/**
 * Sound effects library (docs/EDITOR.md §15.1): the procedural SFX presets with search, category chips and
 * favourites. Each row has its name, length, a waveform (rendered once in a worker and cached), play / stop, and, when
 * selected, its parameters (re-rendered when a slider is let go), "Randomise" (a new seed) and "Add to timeline at
 * playhead" (on the SFX track, made with role "sfx" when missing: one undo step). Rows drag onto the timeline with the
 * editor's media payload (dnd.ts). Keys: ↑ / ↓ move, Space previews, Enter adds at the playhead.
 */
import { clsx } from "clsx";
import { Dices, GripVertical, Loader2, Play, Plus, RotateCcw, Square, Star } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SearchField } from "../../components/ui";
import { startDrag } from "../dnd";
import { useEditorHost, type EditorHost } from "../host";
import type { MediaItem } from "../model/types";
import { renderInWorker } from "../sfx/client";
import {
  DEFAULT_SEED, ensureSfxMedia, isCustom, placeSfx, prepareSfxMedia, resolveValues, SFX_CATEGORIES, SFX_ENGINE_VERSION, SFX_PRESETS, sfxKey, sfxSeconds,
  type SfxParam, type SfxPreset,
} from "../sfx";
import { ed, seq, select, setFocus } from "../store";
import { IBtn } from "../ui";

const LS_FAV = "tatvam-editor:sfx-favourites";
const LS_THUMBS = `tatvam-editor:sfx-thumbs:v${SFX_ENGINE_VERSION}`;
const SFX_MIME = "application/x-tatvam-sfx";
const PEAKS = 64;
const PREVIEW_GAIN = 0.5; // −6 dB: the sounds are at −16 LUFS

const lsGet = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } };
const catLabel = new Map(SFX_CATEGORIES.map((c) => [c.id, c.label]));
const fmtSecs = (s: number) => (s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`);
const fmtVal = (p: SfxParam, v: number) => `${p.step && p.step < 0.1 ? v.toFixed(2) : p.step && p.step < 1 ? v.toFixed(1) : Math.round(v)}${p.unit ? ` ${p.unit}` : ""}`;

interface Variant { id: string; values: Record<string, number>; seed: number }
const keyOf = (v: Variant) => sfxKey(v.id, v.values, v.seed);

// ── renders: waveforms (kept, the defaults also in this browser), the last few previews, media made ─────────

const thumbs = new Map<string, number[]>(Object.entries(lsGet<Record<string, number[]>>(LS_THUMBS, {})));
const defaultKeys = new Set(SFX_PRESETS.map((p) => sfxKey(p.id, {}, DEFAULT_SEED)));
const buffers = new Map<string, Float32Array[]>();
const inflight = new Map<string, Promise<Float32Array[]>>();
const prepared = new Map<string, MediaItem>();
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

function render(v: Variant): Promise<Float32Array[]> {
  const k = keyOf(v);
  const have = buffers.get(k);
  if (have) return Promise.resolve(have);
  let p = inflight.get(k);
  if (!p) {
    p = renderInWorker(v.id, v.values, v.seed, PEAKS).then((r) => {
      buffers.set(k, r.channels);
      while (buffers.size > 8) buffers.delete(buffers.keys().next().value as string);
      if (!thumbs.has(k)) {
        thumbs.set(k, r.peaks.map((x) => Math.round(x * 100) / 100));
        if (defaultKeys.has(k)) lsSet(LS_THUMBS, Object.fromEntries([...thumbs].filter(([kk]) => defaultKeys.has(kk))));
        changed();
      }
      return r.channels;
    }).finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

/** Waveforms wanted on screen render one at a time, the latest request first. */
const thumbQueue: Variant[] = [];
let thumbBusy = false;
function wantThumb(v: Variant) {
  const k = keyOf(v);
  if (thumbs.has(k) || thumbQueue.some((x) => keyOf(x) === k)) return;
  thumbQueue.push(v);
  void pumpThumbs();
}
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    while (thumbQueue.length) {
      const v = thumbQueue.shift()!;
      if (thumbs.has(keyOf(v))) continue;
      try { await render(v); } catch { thumbs.set(keyOf(v), []); }
    }
  } finally { thumbBusy = false; }
}

async function prepare(host: EditorHost, v: Variant): Promise<MediaItem> {
  const k = `${host.path()}|${keyOf(v)}`;
  const have = prepared.get(k);
  if (have) return have;
  const item = await prepareSfxMedia(host, v.id, v.values, v.seed);
  prepared.set(k, item);
  return item;
}

// ── preview playback ────────────────────────────────────────────────────────────────────────────────────

let actx: AudioContext | null = null;
let voice: { src: AudioBufferSourceNode; key: string } | null = null;
let playingKey: string | null = null;
function stopPreview() {
  if (voice) { try { voice.src.stop(); } catch { /* ended */ } voice = null; }
  if (playingKey !== null) { playingKey = null; changed(); }
}
async function playPreview(v: Variant) {
  const k = keyOf(v);
  stopPreview();
  playingKey = k; changed();
  const ch = await render(v);
  if (playingKey !== k) return;
  actx ??= new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  if (actx.state === "suspended") await actx.resume().catch(() => undefined);
  const buf = actx.createBuffer(ch.length, ch[0].length, 48000);
  ch.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const src = actx.createBufferSource(), g = actx.createGain();
  src.buffer = buf; g.gain.value = PREVIEW_GAIN;
  src.connect(g).connect(actx.destination);
  src.onended = () => { if (voice?.src === src) { voice = null; if (playingKey === k) { playingKey = null; changed(); } } };
  voice = { src, key: k };
  src.start();
}

// ── adding ──────────────────────────────────────────────────────────────────────────────────────────────

async function addAt(host: EditorHost, p: SfxPreset, v: Variant, at: number, trackId?: string): Promise<boolean> {
  try {
    const item = await prepare(host, v);
    const clip = placeSfx(host, item, { at, trackId, name: p.name });
    if (!clip) { toast.message("Nothing was placed: is the SFX track locked?"); return false; }
    select([clip]);
    return true;
  } catch (e) {
    toast.error(`Couldn't add ${p.name}: ${String((e as Error)?.message ?? e)}`);
    return false;
  }
}

/** A sound dragged before its file was ready lands here: on an unlocked audio track lane, at the drop point. */
let dropHost: EditorHost | null = null;
let dropInstalled = false;
function installSfxDrop(host: EditorHost) {
  dropHost = host;
  if (dropInstalled || typeof window === "undefined") return;
  dropInstalled = true;
  const laneOf = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(SFX_MIME)) return null;
    const lane = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".tl-lane[data-track]");
    const t = lane ? seq().tracks.find((x) => x.id === lane.dataset.track) : undefined;
    return lane && t?.kind === "audio" && !t.locked ? { lane, track: t } : null;
  };
  window.addEventListener("dragover", (e) => { if (laneOf(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } });
  window.addEventListener("drop", (e) => {
    const hit = laneOf(e);
    if (!hit || !dropHost) return;
    e.preventDefault();
    let v: Variant;
    try { v = JSON.parse(e.dataTransfer?.getData(SFX_MIME) ?? "") as Variant; } catch { return; }
    const p = SFX_PRESETS.find((x) => x.id === v.id);
    if (!p) return;
    const s = ed();
    const frame = Math.max(0, Math.round((e.clientX - hit.lane.getBoundingClientRect().left + s.scroll) / s.zoom));
    void addAt(dropHost, p, v, frame, hit.track.id);
  });
}

// ── the panel ───────────────────────────────────────────────────────────────────────────────────────────

function useStore() {
  const [, set] = useState(0);
  useEffect(() => { const l = () => set((x) => x + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
}

export default function SfxLibrary() {
  const host = useEditorHost();
  useStore();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>(() => lsGet("tatvam-editor:sfx-cat", "all"));
  const [fav, setFav] = useState<string[]>(() => lsGet<string[]>(LS_FAV, []));
  const [sel, setSel] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, Record<string, number>>>({});
  const [seeds, setSeeds] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { installSfxDrop(host); }, [host]);
  useEffect(() => lsSet(LS_FAV, fav), [fav]);
  useEffect(() => lsSet("tatvam-editor:sfx-cat", cat), [cat]);
  useEffect(() => () => stopPreview(), []);

  const ql = q.trim().toLowerCase();
  const shown = useMemo(() => SFX_PRESETS.filter((p) => {
    if (cat === "fav" ? !fav.includes(p.id) : cat !== "all" && p.category !== cat) return false;
    if (!ql) return true;
    return p.name.toLowerCase().includes(ql) || p.id.includes(ql) || (catLabel.get(p.category) ?? "").toLowerCase().includes(ql) || p.tags.some((t) => t.includes(ql));
  }), [cat, fav, ql]);
  const counts = useMemo(() => { const m = new Map<string, number>(); for (const p of SFX_PRESETS) m.set(p.category, (m.get(p.category) ?? 0) + 1); return m; }, []);

  const variant = (p: SfxPreset): Variant => ({ id: p.id, values: vals[p.id] ?? {}, seed: seeds[p.id] ?? DEFAULT_SEED });
  const toggleFav = (id: string) => setFav((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const togglePlay = (p: SfxPreset) => { const v = variant(p); if (playingKey === keyOf(v)) stopPreview(); else void playPreview(v); };
  const add = async (p: SfxPreset) => {
    if (busy) return;
    setBusy(p.id);
    const ok = await addAt(host, p, variant(p), host.playhead());
    setBusy(null);
    if (ok) toast.success(`${p.name} added at the playhead`);
  };
  const choose = (id: string) => { setSel(id); listRef.current?.focus({ preventScroll: true }); };

  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t !== listRef.current) return;
    const i = shown.findIndex((p) => p.id === sel);
    const go = (j: number) => {
      const p = shown[Math.max(0, Math.min(shown.length - 1, j))];
      if (!p) return;
      setSel(p.id);
      requestAnimationFrame(() => listRef.current?.querySelector(`[data-sfx="${CSS.escape(p.id)}"]`)?.scrollIntoView({ block: "nearest" }));
    };
    const cur = i >= 0 ? shown[i] : undefined;
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(shown.length - 1);
    else if (e.key === " " && cur) togglePlay(cur);
    else if (e.key === "Enter" && cur) void add(cur);
    else return;
    e.preventDefault(); e.stopPropagation();
  };

  const chip = (id: string, label: string, n?: number) => (
    <button key={id} type="button" onClick={() => setCat(id)} aria-pressed={cat === id}
      className={clsx("inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-2xs", cat === id ? "border-accent/50 bg-accent/15 text-accent-ink" : "border-line text-mute hover:bg-hover hover:text-ink")}>
      {id === "fav" && <Star className="size-2.5" fill={cat === id ? "currentColor" : "none"} />}{label}{n !== undefined && <span className="mono text-dim">{n}</span>}
    </button>
  );

  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar">
        <SearchField value={q} onChange={setQ} placeholder="Search sound effects" className="min-w-0 flex-1 [&_input]:h-6 [&_input]:text-xs" />
        <span className="mono shrink-0 text-2xs text-dim">{shown.length}</span>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-line px-2 py-1.5">
        {chip("all", "All", SFX_PRESETS.length)}
        {chip("fav", "Favourites", fav.length)}
        {SFX_CATEGORIES.map((c) => chip(c.id, c.label, counts.get(c.id)))}
      </div>
      <div ref={listRef} className="pn-scroll outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40" tabIndex={0} onKeyDown={onKey}
        role="listbox" aria-label="Sound effects" aria-activedescendant={sel ? `sfx-${sel}` : undefined}>
        {shown.map((p) => {
          const v = variant(p);
          return (
            <div key={p.id}>
              <Row p={p} v={v} selected={sel === p.id} fav={fav.includes(p.id)} busy={busy === p.id} showCat={cat === "all" || cat === "fav" || !!ql}
                onSelect={() => choose(p.id)} onPlay={() => togglePlay(p)} onFav={() => toggleFav(p.id)} onAdd={() => void add(p)}
                onDragStart={(e) => {
                  const ready = prepared.get(`${host.path()}|${keyOf(v)}`);
                  if (ready) {
                    const m = ensureSfxMedia(host, ready);
                    startDrag(e, { kind: "media", items: [{ mediaId: m.id, video: false, audio: true }] }, p.name);
                  } else {
                    e.dataTransfer.setData(SFX_MIME, JSON.stringify(v));
                    e.dataTransfer.setData("text/plain", p.name);
                    e.dataTransfer.effectAllowed = "copy";
                  }
                }}
                onPress={() => { void prepare(host, v).catch(() => undefined); }} />
              {sel === p.id && (
                <Params p={p} v={v}
                  onChange={(name, x) => setVals((o) => ({ ...o, [p.id]: { ...resolveValues(p.id, o[p.id] ?? {}), [name]: x } }))}
                  onRandom={() => setSeeds((o) => ({ ...o, [p.id]: 1 + Math.floor(Math.random() * 99998) }))}
                  onReset={() => { setVals((o) => { const n = { ...o }; delete n[p.id]; return n; }); setSeeds((o) => { const n = { ...o }; delete n[p.id]; return n; }); }}
                  onAdd={() => void add(p)} busy={busy === p.id} />
              )}
            </div>
          );
        })}
        {!shown.length && <div className="p-4 text-center text-xs text-dim">{cat === "fav" && !fav.length ? "Star a sound to keep it here" : "Nothing matches"}</div>}
      </div>
      <div className="ed-bar bottom gap-2 text-2xs text-dim">
        <span className="truncate">Made by code, levelled to −16 LUFS · ↑↓ move · Space plays · Enter adds at the playhead · drag onto a track</span>
      </div>
    </div>
  );
}

const Row = memo(function Row({ p, v, selected, fav, busy, showCat, onSelect, onPlay, onFav, onAdd, onDragStart, onPress }: {
  p: SfxPreset; v: Variant; selected: boolean; fav: boolean; busy: boolean; showCat: boolean;
  onSelect: () => void; onPlay: () => void; onFav: () => void; onAdd: () => void; onDragStart: (e: React.DragEvent) => void; onPress: () => void;
}) {
  const k = keyOf(v);
  const ref = useRef<HTMLDivElement>(null);
  const peaks = thumbs.get(k);
  useEffect(() => {
    if (peaks || !ref.current) return;
    const el = ref.current;
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { wantThumb(v); io.disconnect(); } }, { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [k, peaks]); // eslint-disable-line react-hooks/exhaustive-deps
  const playing = playingKey === k;
  const custom = isCustom(p.id, v.values) || v.seed !== DEFAULT_SEED;
  return (
    <div ref={ref} id={`sfx-${p.id}`} data-sfx={p.id} role="option" aria-selected={selected} draggable
      className={clsx("pn-row group cursor-default pl-1", selected && "sel")}
      onClick={onSelect} onDoubleClick={onAdd} onDragStart={onDragStart}
      onPointerDown={(e) => { if (e.button === 0 && selected && !(e.target as HTMLElement).closest("button")) onPress(); }}
      title={`${p.name}: ${p.tags.length ? p.tags.join(", ") : catLabel.get(p.category)} · double-click or Enter adds at the playhead, or drag onto a track`}>
      <GripVertical className="size-3 shrink-0 text-dim opacity-0 group-hover:opacity-100" />
      <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label={playing ? `Stop ${p.name}` : `Play ${p.name}`} onClick={(e) => { e.stopPropagation(); onPlay(); }}
        className={clsx("grid size-5 shrink-0 place-items-center rounded-full border", playing ? "border-accent/60 bg-accent/20 text-accent-ink" : "border-line text-mute hover:text-ink")}>
        {playing ? <Square className="size-2.5" fill="currentColor" /> : <Play className="ml-px size-2.5" fill="currentColor" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate">{p.name}{custom && <span className="ml-1 text-2xs text-accent-ink">edited</span>}{p.loop && <span className="ml-1 text-2xs text-dim">loop</span>}</div>
        {showCat && <div className="truncate text-[10px] leading-3 text-dim">{catLabel.get(p.category)}</div>}
      </div>
      <Wave peaks={peaks} active={playing} />
      <span className="mono w-10 shrink-0 text-right text-2xs text-dim">{fmtSecs(sfxSeconds(p.id, v.values))}</span>
      <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label={fav ? "Remove from favourites" : "Add to favourites"} onClick={(e) => { e.stopPropagation(); onFav(); }}
        className={clsx("shrink-0", fav ? "text-warn" : "text-dim opacity-0 group-hover:opacity-100")}>
        <Star className="size-3" fill={fav ? "currentColor" : "none"} />
      </button>
      <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label={`Add ${p.name} at the playhead`} onClick={(e) => { e.stopPropagation(); onAdd(); }} disabled={busy}
        className={clsx("grid size-5 shrink-0 place-items-center rounded text-mute hover:bg-hover hover:text-ink group-hover:opacity-100", selected || busy ? "opacity-100" : "opacity-0")}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3.5" />}
      </button>
    </div>
  );
});

function Wave({ peaks, active }: { peaks?: number[]; active: boolean }) {
  const W = 64, H = 18;
  if (!peaks) return <span className="h-[18px] w-16 shrink-0 rounded-sm bg-raised/60" />;
  let d = "";
  peaks.forEach((x, i) => { const h = Math.max(0.6, x * (H / 2 - 1)); d += `M${i + 0.5} ${H / 2 - h}V${H / 2 + h}`; });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[18px] w-16 shrink-0" aria-hidden preserveAspectRatio="none">
      <path d={d} stroke={active ? "var(--color-accent)" : "var(--color-mute)"} strokeWidth={0.8} opacity={active ? 1 : 0.75} />
    </svg>
  );
}

function Params({ p, v, onChange, onRandom, onReset, onAdd, busy }: {
  p: SfxPreset; v: Variant; busy: boolean;
  onChange: (name: string, v: number) => void; onRandom: () => void; onReset: () => void; onAdd: () => void;
}) {
  const values = resolveValues(p.id, v.values);
  return (
    <div className="space-y-1.5 border-b border-line bg-raised/40 px-3 py-2" onClick={(e) => e.stopPropagation()}>
      {p.params.map((x) => <ParamSlider key={x.name} p={x} value={values[x.name]} onCommit={(val) => onChange(x.name, val)} />)}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <button type="button" className="inline-flex h-6 items-center gap-1 rounded-md border border-line px-2 text-2xs text-mute hover:bg-hover hover:text-ink" onClick={onRandom} title="A new random seed: the same sound, a new take">
          <Dices className="size-3" />Randomise
        </button>
        <IBtn title="Back to the preset" onClick={onReset}><RotateCcw className="size-3" /></IBtn>
        <span className="mono text-2xs text-dim">seed {v.seed}</span>
        <button type="button" disabled={busy} onClick={onAdd}
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-md bg-accent/15 px-2 text-2xs font-medium text-accent-ink hover:bg-accent/25 disabled:opacity-50">
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}Add to timeline at playhead
        </button>
      </div>
    </div>
  );
}

/** A slider that shows its value while it moves and commits it when let go (the sound re-renders then). */
function ParamSlider({ p, value, onCommit }: { p: SfxParam; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const commit = () => { if (draft !== null) { if (Math.abs(draft - value) > 1e-9) onCommit(draft); setDraft(null); } };
  return (
    <label className="flex min-w-0 items-center gap-2 text-2xs text-mute">
      <span className="w-24 shrink-0 truncate">{p.label}</span>
      <input type="range" className="min-w-0 flex-1 accent-[var(--color-accent)]" min={p.min} max={p.max} step={p.step ?? 0.01} value={shown}
        onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit}
        onKeyDown={(e) => e.stopPropagation()} />
      <span className="mono w-14 shrink-0 text-right text-accent-ink">{fmtVal(p, shown)}</span>
    </label>
  );
}
