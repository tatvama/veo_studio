/**
 * The Wipe Designer window (docs/EDITOR.md §16.8, nr-wipes): every stinger parameter on the left (shape, timing,
 * colours from the look, what lands on the cut, feel), the wipe playing live in 16:9 and 9:16 over a sample outgoing
 * and incoming shot (so you see the cut hide), a scrubber with the cut and the hold marked, the coverage check, and
 * Randomise. Save copies the stinger into the edit (one undo step) and the library; "Save and add" also puts it on the
 * nearest cut. Esc closes; Space plays; Ctrl+Z / Ctrl+Shift+Z undo and redo.
 */
import { clsx } from "clsx";
import { Check, Dices, Minus, Pause, Play, Plus, Redo2, Shuffle, Undo2, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, Toggle } from "../../../components/ui";
import { useEditorHost } from "../../host";
import { program } from "../../playback/transport";
import { project } from "../../store";
import { IBtn, typing } from "../../ui";
import { templateOf, useTemplate } from "../commands";
import { Num, Pick, Row, Sec, Seg, Swatch } from "../designer/controls";
import type { OpenWipeDesigner } from "../events";
import { isMyTemplate, loadTemplate, newTemplateId, saveTemplate } from "../library";
import { BUILTIN_LOOKS, resolveLook } from "../looks";
import { drawGraphic, ensureGraphicAssets } from "../render";
import type { GfxRenderInput } from "../render/contract";
import { onAssets } from "../render/images";
import { builtinTemplate } from "../templates/index";
import { defaults } from "../templates/kit";
import { STINGERS } from "../templates/stingers";
import type { ChannelLook, GfxRatio, GfxTemplate } from "../types";
import { applyStinger, nearestCut } from "./apply";
import { checkStinger, describeSpec, PALETTE_SLOTS, randomSpec, specFromTemplate, stingerTemplate, wipeSpec, WIPE_DEFAULTS, type PaletteSlot, type WipeSpec } from "./designer";
import { MIN_HOLD, PANEL_EASES, PANEL_EDGES, PANEL_EXITS, PANEL_LAYOUTS, PANEL_ORDERS, stingerClock, motionOf } from "./geometry";

// ── opening ──────────────────────────────────────────────────────────────────

interface Start { spec: WipeSpec; name: string; id: string | null }

async function startFrom(req: OpenWipeDesigner): Promise<Start> {
  if (!req.template) return { spec: wipeSpec(), name: "My wipe", id: null };
  const p = project();
  const t: GfxTemplate | null = templateOf(p, req.template) ?? builtinTemplate(req.template) ?? await loadTemplate(req.template).catch(() => null);
  const spec = t ? specFromTemplate(t) : null;
  if (!t || !spec) return { spec: wipeSpec(), name: "My wipe", id: null };
  const mine = isMyTemplate(t.id);
  return { spec, name: mine ? t.name : `${t.name} (mine)`, id: mine ? t.id : null };
}

export default function WipeDesigner({ request, onClose }: { request: OpenWipeDesigner; onClose: () => void }) {
  const [start, setStart] = useState<Start | null>(null);
  useEffect(() => {
    let alive = true;
    void startFrom(request).then((s) => alive && setStart(s)).catch(() => alive && setStart({ spec: wipeSpec(), name: "My wipe", id: null }));
    return () => { alive = false; };
  }, [request]);
  if (!start) return <Shell><div className="grid flex-1 place-items-center text-xs text-dim">Opening the Wipe Designer…</div></Shell>;
  return <Window start={start} request={request} onClose={onClose} />;
}

function Shell({ children }: { children: ReactNode }) {
  return <div data-nr-wipes className="ed-root fixed inset-0 z-[60] flex flex-col bg-bg text-ink">{children}</div>;
}

// ── history ──────────────────────────────────────────────────────────────────

interface Hist { past: WipeSpec[]; present: WipeSpec; future: WipeSpec[]; key?: string }

function useHistory(initial: WipeSpec) {
  const [h, setH] = useState<Hist>({ past: [], present: initial, future: [] });
  const change = useCallback((next: WipeSpec | ((s: WipeSpec) => WipeSpec), key?: string) => {
    setH((cur) => {
      const n = typeof next === "function" ? next(cur.present) : next;
      if (JSON.stringify(n) === JSON.stringify(cur.present)) return cur;
      // a drag of the same control is one step
      if (key && cur.key === key) return { ...cur, present: n };
      return { past: [...cur.past.slice(-80), cur.present], present: n, future: [], key };
    });
  }, []);
  const undo = useCallback(() => setH((c) => (c.past.length ? { past: c.past.slice(0, -1), present: c.past[c.past.length - 1], future: [c.present, ...c.future] } : c)), []);
  const redo = useCallback(() => setH((c) => (c.future.length ? { past: [...c.past, c.present], present: c.future[0], future: c.future.slice(1) } : c)), []);
  const endDrag = useCallback(() => setH((c) => (c.key ? { ...c, key: undefined } : c)), []);
  return { h, change, undo, redo, endDrag };
}

// ── the window ───────────────────────────────────────────────────────────────

const LOOK_SLOTS: PaletteSlot[] = PALETTE_SLOTS.map((s) => s.value);

function Window({ start, request, onClose }: { start: Start; request: OpenWipeDesigner; onClose: () => void }) {
  const host = useEditorHost();
  const { h, change, undo, redo, endDrag } = useHistory(start.spec);
  const spec = h.present;
  const [name, setName] = useState(start.name);
  const [savedId, setSavedId] = useState<string | null>(start.id);
  const [saved, setSaved] = useState<string>(JSON.stringify(start.spec));
  const [lookId, setLookId] = useState<string>(() => resolveLook(project()).id);
  const [t, setT] = useState(() => spec.seconds * spec.cut);
  const [playing, setPlaying] = useState(true);
  const [rolls, setRolls] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const dirty = JSON.stringify(spec) !== saved;

  const editLook = useMemo(() => resolveLook(project()), []);
  const looks = useMemo(() => {
    const list = [editLook, ...BUILTIN_LOOKS.filter((l) => l.id !== editLook.id)];
    return list;
  }, [editLook]);
  const look = looks.find((l) => l.id === lookId) ?? editLook;

  const template = useMemo(() => stingerTemplate(spec, { id: savedId ?? "my.preview", name, description: describeSpec(spec), tags: ["stinger", "mine"] }), [spec, name, savedId]);
  const deferred = useDeferredValue(template);
  const check = useMemo(() => checkStinger(deferred, 12), [deferred]);

  const set = <K extends keyof WipeSpec>(k: K, v: WipeSpec[K], done = true) => {
    change((s) => ({ ...s, [k]: v }), done ? undefined : `drag:${String(k)}`);
    if (done) endDrag();
  };
  const randomise = () => {
    const n = rolls + 1;
    setRolls(n);
    const r = randomSpec(look, spec.seed * 7 + n * 13 + 1, { logo: spec.logo, text: spec.text, textPlate: spec.textPlate, textStyle: spec.textStyle });
    change(r);
    setT(r.seconds * r.cut - 0.25);
    setPlaying(true);
  };

  // ── saving ─────────────────────────────────────────────────────────────────
  const build = (): GfxTemplate | null => {
    const c = checkStinger(template, 8);
    if (!c.ok) { toast.error(`This wipe would show the cut. ${c.reasons[0] ?? ""}`); return null; }
    const id = savedId ?? newTemplateId();
    return { ...stingerTemplate(spec, { id, name: name.trim() || "My wipe", description: describeSpec(spec), tags: ["stinger", "mine"] }), source: "mine", modified: new Date().toISOString() };
  };
  const finish = async (tt: GfxTemplate, msg: string) => {
    let inLib = true;
    try { await saveTemplate(tt); } catch (e) { inLib = false; toast.warning(`Saved in this edit, but not in your library: ${(e as Error).message}`); }
    setSavedId(tt.id); setSaved(JSON.stringify(spec));
    request.onSaved?.(tt);
    toast.success(`${msg}${inLib ? " (and in your library)" : ""}`);
  };
  const save = async () => {
    const tt = build();
    if (!tt) return;
    try { host.apply("Save wipe", (d) => useTemplate(d, tt)); } catch (e) { toast.error(`Couldn't save: ${(e as Error).message}`); return; }
    await finish(tt, `Saved “${tt.name}”`);
  };
  const saveAndAdd = async () => {
    const tt = build();
    if (!tt) return;
    const p = project();
    const s = p.sequences.find((x) => x.id === p.activeSequenceId);
    const cut = s ? nearestCut(s, program.frame) : null;
    if (!s || cut === null) { toast.message("There's no cut in this sequence yet: saved without adding it."); await save(); return; }
    let ok = false;
    try { host.apply("Add wipe", (d) => { useTemplate(d, tt); ok = !!applyStinger(d, s.id, cut, tt.id); }); } catch (e) { toast.error(`Couldn't add it: ${(e as Error).message}`); return; }
    await finish(tt, ok ? `Saved “${tt.name}” and put it on the cut` : `Saved “${tt.name}”`);
  };

  // ── keys ───────────────────────────────────────────────────────────────────
  const requestClose = () => { if (dirty) setConfirm(true); else onClose(); };
  const keyRef = useRef({ requestClose, undo, redo, confirm, setPlaying, save });
  keyRef.current = { requestClose, undo, redo, confirm, setPlaying, save };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const k = keyRef.current;
      const mod = e.ctrlKey || e.metaKey;
      const otherPopup = [...document.querySelectorAll("body > [role=dialog], [data-ctxmenu]")].some((el) => !el.hasAttribute("data-nr-wipes"));
      if (e.key === "Escape") { if (otherPopup) return; e.stopPropagation(); if (k.confirm) setConfirm(false); else k.requestClose(); return; }
      e.stopPropagation();
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void k.save(); return; }
      if (typing(e) || otherPopup) return;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) k.redo(); else k.undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); k.redo(); return; }
      if (e.key === " ") { e.preventDefault(); k.setPlaying((p) => !p); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  // ── playback ───────────────────────────────────────────────────────────────
  const len = template.seconds;
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // play the wipe, rest a moment on the incoming shot, then again
      setT((x) => { const n = x + dt; return n > len + 0.5 ? -0.3 : n; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, len]);

  const ck = stingerClock(motionOf(template.designs["16:9"]!.layers[0].p), len);
  const shownT = Math.max(0, Math.min(len, t));

  return (
    <Shell>
      {/* top bar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <IBtn title="Close (Esc)" onClick={requestClose}><X className="size-4" /></IBtn>
        <span className="text-sm font-semibold">Wipe Designer</span>
        <input className="ed-field w-56" value={name} onChange={(e) => setName(e.target.value)} aria-label="Wipe name" placeholder="Name this wipe" />
        <span className="hidden truncate text-2xs text-dim xl:inline">{describeSpec(spec)}</span>
        {dirty && <span className="shrink-0 text-2xs text-warn">Unsaved</span>}
        <span className="mx-1 h-5 w-px bg-line" />
        <IBtn title="Undo" shortcut="Ctrl+Z" disabled={!h.past.length} onClick={undo}><Undo2 className="size-4" /></IBtn>
        <IBtn title="Redo" shortcut="Ctrl+Shift+Z" disabled={!h.future.length} onClick={redo}><Redo2 className="size-4" /></IBtn>
        <span className="flex-1" />
        <span className="text-2xs text-mute">Look</span>
        <Pick value={look.id} options={looks.map((l) => ({ value: l.id, label: l.id === editLook.id ? `${l.name} (this edit)` : l.name }))} onChange={setLookId} className="w-44" />
        <Button size="sm" variant="secondary" icon={<Shuffle className="size-3.5" />} onClick={randomise} title="A new wipe that suits the look (your logo and headline stay)">Randomise</Button>
        <Button size="sm" variant="ghost" onClick={() => void saveAndAdd()} disabled={!check.ok} title="Save it, then put it on the cut nearest the playhead">Save and add at the cut</Button>
        <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => void save()} disabled={!check.ok} title={check.ok ? "Save to this edit and your library (Ctrl+S)" : check.reasons[0]}>Save</Button>
      </div>
      {confirm && (
        <div className="flex items-center gap-3 border-b border-line bg-warn/10 px-4 py-2 text-xs">
          <span className="flex-1">You changed this wipe. Close without saving?</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Keep editing</Button>
          <Button size="sm" variant="danger" onClick={onClose}>Close without saving</Button>
          <Button size="sm" variant="primary" disabled={!check.ok} onClick={() => void save().then(onClose)}>Save and close</Button>
        </div>
      )}
      {/* body */}
      <div className="flex min-h-0 flex-1">
        <Controls spec={spec} set={set} change={change} look={look} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Stage template={template} look={look} t={shownT} cutAt={len * spec.cut} />
          <Scrubber t={shownT} len={len} hold={[ck.inEnd, ck.outStart]} cut={len * spec.cut} playing={playing}
            onPlay={() => setPlaying((p) => !p)} onSeek={(x) => { setPlaying(false); setT(x); }} />
          <Coverage check={check} />
        </div>
      </div>
    </Shell>
  );
}

// ── controls ─────────────────────────────────────────────────────────────────

const DIRS: { value: number; label: string; title: string }[] = [
  { value: 0, label: "→", title: "Left to right" }, { value: 180, label: "←", title: "Right to left" },
  { value: 90, label: "↓", title: "Top to bottom" }, { value: -90, label: "↑", title: "Bottom to top" },
  { value: 30, label: "↘", title: "Diagonal down" }, { value: -30, label: "↗", title: "Diagonal up" },
];

function Controls({ spec, set, change, look }: {
  spec: WipeSpec; look: ChannelLook;
  set: <K extends keyof WipeSpec>(k: K, v: WipeSpec[K], done?: boolean) => void;
  change: (next: WipeSpec | ((s: WipeSpec) => WipeSpec), key?: string) => void;
}) {
  const n = <K extends keyof WipeSpec>(k: K) => (v: number, done: boolean) => set(k, v as WipeSpec[K], done);
  const startFromBuiltIn = (id: string) => { const t = STINGERS.find((x) => x.id === id); const s = t && specFromTemplate(t); if (s) change(s); };
  const stacked = spec.layout === "stack" || spec.layout === "circles" || spec.layout === "split";
  return (
    <div className="w-[320px] shrink-0 overflow-y-auto border-r border-line bg-panel pb-6">
      <Row label="Start from">
        <Pick value="" options={[{ value: "", label: "A ready wipe…" }, ...STINGERS.map((t) => ({ value: t.id, label: t.name }))]} onChange={(v) => v && startFromBuiltIn(v)} className="flex-1" />
      </Row>
      <Sec title="Shape" id="wipes.shape">
        <Row label="Shape"><Pick value={spec.layout} options={PANEL_LAYOUTS} onChange={(v) => set("layout", v)} className="flex-1" /></Row>
        <Row label="Edge" hint={spec.layout === "tiles" ? "Tiles: chevron = diamonds, round = dots" : undefined}>
          <Pick value={spec.edge} options={PANEL_EDGES} onChange={(v) => set("edge", v)} className="flex-1" disabled={spec.layout === "blades" || spec.layout === "flip"} />
        </Row>
        <Row label={spec.layout === "tiles" ? "Columns" : spec.layout === "circles" ? "Rings" : "Count"}><Num value={spec.count} min={1} max={spec.layout === "tiles" ? 16 : 12} onChange={n("count")} /></Row>
        <Row label="Edge depth"><Num value={spec.depth} min={0} max={1} step={0.01} onChange={n("depth")} disabled={spec.edge === "straight"} /></Row>
        {spec.layout !== "circles" ? (
          <Row label="Direction">
            <Seg value={DIRS.some((d) => d.value === spec.angle) ? spec.angle : 9999} options={DIRS} onChange={(v) => set("angle", v)} />
            <Num value={spec.angle} min={-180} max={180} unit="°" onChange={n("angle")} />
          </Row>
        ) : (
          <Row label="From">
            <Seg value={`${spec.cx},${spec.cy}`} onChange={(v) => { const [x, y] = v.split(",").map(Number); change((s) => ({ ...s, cx: x, cy: y })); }}
              options={[{ value: "0.5,0.5", label: "Middle" }, { value: "0,0", label: "↖" }, { value: "1,0", label: "↗" }, { value: "0,1", label: "↙" }, { value: "1,1", label: "↘" }]} />
          </Row>
        )}
      </Sec>
      <Sec title="Timing" id="wipes.timing">
        <Row label="Length"><Num value={spec.seconds} min={0.5} max={3} step={0.05} unit="s" onChange={n("seconds")} /></Row>
        <Row label="Cut point" hint="Where the frame is fully covered and the shots change"><Num value={spec.cut} min={0.25} max={0.75} step={0.01} onChange={n("cut")} /></Row>
        <Row label="Hold" hint="How long the frame stays covered around the cut"><Num value={spec.hold} min={MIN_HOLD} max={1.2} step={0.01} unit="s" onChange={n("hold")} /></Row>
        <Row label="Stagger"><Num value={spec.stagger} min={0} max={0.25} step={0.005} unit="s" onChange={n("stagger")} /></Row>
        {!stacked && <Row label="Order"><Pick value={spec.order} options={PANEL_ORDERS} onChange={(v) => set("order", v)} className="flex-1" /></Row>}
        <Row label="Ease"><Pick value={spec.ease} options={PANEL_EASES} onChange={(v) => set("ease", v)} className="flex-1" /></Row>
        {(spec.ease === "back" || spec.ease === "elastic") && <Row label="Overshoot"><Num value={spec.overshoot} min={0} max={1} step={0.01} onChange={n("overshoot")} /></Row>}
        {spec.layout !== "split" && <Row label="Leaving"><Seg value={spec.exit} options={PANEL_EXITS} onChange={(v) => set("exit", v)} /></Row>}
      </Sec>
      <Sec title="Colours" id="wipes.colours">
        <div className="space-y-1 px-3">
          {spec.colors.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-[86px] text-2xs text-mute">{stacked ? (i === spec.colors.length - 1 ? "Top panel" : `Panel ${i + 1}`) : `Colour ${i + 1}`}</span>
              <Swatch css={look.colors[c]} title={c} />
              <Pick value={c} options={PALETTE_SLOTS} onChange={(v) => change((s) => ({ ...s, colors: s.colors.map((x, j) => (j === i ? v : x)) }))} className="flex-1" />
              <IBtn title="Remove this colour" disabled={spec.colors.length <= 1} onClick={() => change((s) => ({ ...s, colors: s.colors.filter((_, j) => j !== i) }))}><Minus className="size-3.5" /></IBtn>
            </div>
          ))}
          {spec.colors.length < 4 && (
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />}
              onClick={() => change((s) => ({ ...s, colors: [...s.colors, LOOK_SLOTS.find((x) => !s.colors.includes(x)) ?? "primary"] }))}>Add a colour</Button>
          )}
        </div>
        <Row label="Finish"><Seg value={spec.finish} options={[{ value: "flat", label: "Flat" }, { value: "gradient", label: "Shaded" }, { value: "glass", label: "Glass" }]} onChange={(v) => set("finish", v)} /></Row>
        <Row label="Edge line"><Num value={spec.line} min={0} max={30} unit="px" onChange={n("line")} />
          {spec.line > 0 && <Pick value={spec.lineColor} options={PALETTE_SLOTS} onChange={(v) => set("lineColor", v)} className="flex-1" />}
        </Row>
      </Sec>
      <Sec title="On the cut" id="wipes.cut">
        <Row label="Logo"><Toggle checked={spec.logo} onChange={(v) => change((s) => ({ ...s, logo: v, hold: v && s.hold < 0.35 ? 0.45 : s.hold }))} label="Reveal" /></Row>
        <Row label="Headline" hint="Shown on the cut; you can change it later in Fill in">
          <input className="ed-field flex-1" value={spec.text} maxLength={28} placeholder="e.g. BREAKING NEWS" onChange={(e) => change((s) => ({ ...s, text: e.target.value }), "text")} />
        </Row>
        {spec.text && (<>
          <Row label="Headline move"><Seg value={spec.textStyle} options={[{ value: "slam", label: "Slam" }, { value: "slide", label: "Slide" }, { value: "rise", label: "Rise" }]} onChange={(v) => set("textStyle", v)} /></Row>
          <Row label="Plate"><Pick value={spec.textPlate} options={[{ value: "", label: "None" }, ...PALETTE_SLOTS]} onChange={(v) => set("textPlate", v as WipeSpec["textPlate"])} className="flex-1" /></Row>
        </>)}
        <Row label="Flash"><Num value={spec.flash} min={0} max={1} step={0.01} onChange={n("flash")} /></Row>
        <Row label="Light sweep"><Toggle checked={spec.sweep} onChange={(v) => set("sweep", v)} label="On the cut" /></Row>
      </Sec>
      <Sec title="Feel" id="wipes.feel">
        <Row label="Motion trail" hint="A soft blur behind fast panels"><Num value={spec.blur} min={0} max={1} step={0.01} onChange={n("blur")} /></Row>
        <Row label="Shadow"><Num value={spec.shadow} min={0} max={1} step={0.01} onChange={n("shadow")} /></Row>
        <Row label="Variation" hint="Changes torn and brushed edges and random orders">
          <Num value={spec.seed} min={0} max={9999} onChange={n("seed")} />
          <IBtn title="Another variation" onClick={() => set("seed", (spec.seed * 37 + 11) % 9999)}><Dices className="size-3.5" /></IBtn>
        </Row>
        <Row label="">
          <Button size="sm" variant="ghost" onClick={() => change(wipeSpec({ ...WIPE_DEFAULTS, logo: spec.logo, text: spec.text }))}>Back to the defaults</Button>
        </Row>
      </Sec>
    </div>
  );
}

// ── the stage ────────────────────────────────────────────────────────────────

const RATIOS: GfxRatio[] = ["16:9", "9:16"];
const ASPECT: Record<string, number> = { "16:9": 16 / 9, "9:16": 9 / 16 };

function Stage({ template, look, t, cutAt }: { template: GfxTemplate; look: ChannelLook; t: number; cutAt: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 500 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const gap = 28, labelH = 22;
  const h = Math.max(120, Math.min(size.h - labelH - 24, (size.w - gap - 48) / (ASPECT["16:9"] + ASPECT["9:16"])));
  return (
    <div ref={box} className="flex min-h-0 flex-1 items-center justify-center gap-7 overflow-hidden bg-[#07090e] p-6">
      {RATIOS.map((r) => (
        <div key={r} className="flex flex-col items-center gap-1.5">
          <span className="text-2xs text-dim">{r === "16:9" ? "16:9 · TV and YouTube" : "9:16 · Reels and Shorts"}</span>
          <Preview template={template} look={look} ratio={r} w={Math.round(h * ASPECT[r])} h={Math.round(h)} t={t} cutAt={cutAt} />
        </div>
      ))}
    </div>
  );
}

/** The sample shots under the wipe: "A" before the cut, "B" after (so it's plain the cut is hidden). */
function drawShot(g: CanvasRenderingContext2D, W: number, H: number, incoming: boolean) {
  const gr = g.createLinearGradient(0, 0, W, H);
  if (incoming) { gr.addColorStop(0, "#5b2a86"); gr.addColorStop(1, "#e0773a"); } else { gr.addColorStop(0, "#0f4c5c"); gr.addColorStop(1, "#5fa8a0"); }
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  g.fillStyle = "rgba(255,255,255,0.08)";
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(W * (0.15 + i * 0.15), H * (0.75 - (i % 2) * 0.1), Math.min(W, H) * 0.12, 0, Math.PI * 2); g.fill(); }
  const m = Math.min(W, H);
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `700 ${Math.round(m * 0.28)}px "Inter Variable", system-ui, sans-serif`;
  g.fillText(incoming ? "B" : "A", W / 2, H / 2 - m * 0.06);
  g.font = `600 ${Math.round(m * 0.055)}px "Inter Variable", system-ui, sans-serif`;
  g.fillText(incoming ? "Incoming shot" : "Outgoing shot", W / 2, H / 2 + m * 0.16);
}

function Preview({ template, look, ratio, w, h, t, cutAt }: { template: GfxTemplate; look: ChannelLook; ratio: GfxRatio; w: number; h: number; t: number; cutAt: number }) {
  const back = useRef<HTMLCanvasElement>(null);
  const front = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(2, Math.round(w * dpr)), H = Math.max(2, Math.round(h * dpr));
  const input = useMemo<GfxRenderInput>(() => {
    const p = project();
    const images: Record<string, string> = {};
    const logoId = look.logo?.mediaId;
    const m = logoId ? p.media.find((x) => x.id === logoId) : undefined;
    if (logoId && m?.url) images[logoId] = m.url;
    return { template, values: defaults(template), look, images, seed: 1, fps: 30, ratio };
  }, [template, look, ratio]);
  useEffect(() => { void ensureGraphicAssets(input).then(() => setTick((x) => x + 1)); }, [input]);
  useEffect(() => onAssets(() => setTick((x) => x + 1)), []);
  const incoming = t >= cutAt;
  useEffect(() => {
    const g = back.current?.getContext("2d");
    if (g) drawShot(g, W, H, incoming);
  }, [incoming, W, H]);
  useEffect(() => {
    const g = front.current?.getContext("2d");
    if (!g) return;
    drawGraphic(g, input, W, H, t, template.seconds);
  }, [input, W, H, t, template.seconds, tick]);
  return (
    <div className="relative overflow-hidden rounded-md border border-line shadow-lg" style={{ width: w, height: h }}>
      <canvas ref={back} width={W} height={H} className="absolute inset-0 h-full w-full" />
      <canvas ref={front} width={W} height={H} className="absolute inset-0 h-full w-full" />
    </div>
  );
}

// ── the scrubber and the check ───────────────────────────────────────────────

function Scrubber({ t, len, hold, cut, playing, onPlay, onSeek }: {
  t: number; len: number; hold: [number, number]; cut: number; playing: boolean; onPlay: () => void; onSeek: (t: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const seekAt = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    onSeek(Math.max(0, Math.min(len, ((clientX - r.left) / r.width) * len)));
  };
  const pct = (x: number) => `${(Math.max(0, Math.min(len, x)) / len) * 100}%`;
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line bg-panel px-4">
      <IBtn title={playing ? "Pause (Space)" : "Play (Space)"} onClick={onPlay}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</IBtn>
      <div ref={bar} className="relative h-6 flex-1 cursor-pointer select-none" role="slider" aria-label="Time" aria-valuenow={t} aria-valuemin={0} aria-valuemax={len}
        onPointerDown={(e) => {
          const el = e.currentTarget;
          seekAt(e.clientX);
          try { el.setPointerCapture(e.pointerId); } catch { /* a synthetic or finished pointer */ }
          const move = (ev: PointerEvent) => seekAt(ev.clientX);
          const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
          el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
        }}>
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line" />
        <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent/35" style={{ left: pct(hold[0]), width: `calc(${pct(hold[1])} - ${pct(hold[0])})` }} title="Fully covered" />
        <div className="absolute top-0 h-6 w-0.5 bg-accent" style={{ left: pct(cut) }} title="The cut" />
        <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-ink shadow" style={{ left: pct(t) }} />
      </div>
      <span className="w-28 text-right font-mono text-2xs text-mute">{t.toFixed(2)} / {len.toFixed(2)} s</span>
      <span className="flex items-center gap-1 text-2xs text-dim"><span className="inline-block h-3 w-0.5 bg-accent" /> cut</span>
    </div>
  );
}

function Coverage({ check }: { check: ReturnType<typeof checkStinger> }) {
  return (
    <div className={clsx("flex min-h-9 shrink-0 items-center gap-2 border-t border-line px-4 py-2 text-xs", check.ok ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad")}>
      {check.ok ? <Check className="size-3.5 shrink-0" /> : <X className="size-3.5 shrink-0" />}
      <span className="flex-1">
        {check.ok ? "The frame is fully covered at the cut in 16:9 and 9:16: nobody will see the shots change." : `${check.reasons.join(" ")} Change the shape or timing to save it.`}
      </span>
    </div>
  );
}
