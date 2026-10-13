/**
 * The Designer's inspector (docs/EDITOR.md §16.8). For the selected layer: every property of its kind, built from the
 * kind's `props` (so other builders' kinds are editable too), then the common ones (position and size, rotation,
 * opacity, blend, when it shows, clip, pin, shadow) and its in / out / loop animation. With nothing selected: the
 * template's name, category, track, timing (in, out, length, hold, loop, stinger cut) and sound hints.
 */
import { clsx } from "clsx";
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useProject } from "../../store";
import { openMenu } from "../../ui";
import type { PropDef } from "../render/contract";
import { layerTiming } from "../render/anim";
import { layerKind } from "../render/registry";
import { DESIGN } from "../templates/kit";
import type { AnimEase, AnimStep, Box, GfxLayer, GfxRatio, GfxTemplate, LayerAnim, LoopSpec, Paint } from "../types";
import { layerOf, ratiosOf, setBox, setCommon, setProp } from "./doc";
import { safeBox } from "./geometry";
import { kindIcon } from "./LayersPanel";
import { FontPicker, IconPicker, Num, PaintPicker, Pick, Row, Sec, Seg } from "./controls";
import { CATEGORIES, ROLES } from "./validate";
import { change, clock, ds, isReadOnly, previewLength, useDesigner } from "./state";

export const ANIMS: { value: string; label: string }[] = [
  { value: "none", label: "None" }, { value: "fade", label: "Fade" }, { value: "slide", label: "Slide" }, { value: "wipe", label: "Wipe (reveal)" },
  { value: "grow", label: "Grow from its edge" }, { value: "unfold", label: "Unfold" }, { value: "flip", label: "Flip" }, { value: "pop", label: "Pop" },
  { value: "zoom", label: "Zoom" }, { value: "rise", label: "Rise" }, { value: "drop", label: "Drop" }, { value: "blur", label: "Blur" },
  { value: "typewriter", label: "Typewriter" }, { value: "stagger", label: "Word by word" }, { value: "sweep", label: "Light sweep" },
];
export const EASE_OPTIONS: { value: AnimEase; label: string }[] = [
  { value: "look", label: "As the look" }, { value: "ease_out", label: "Ease out" }, { value: "ease_in", label: "Ease in" }, { value: "ease_in_out", label: "Ease in and out" },
  { value: "linear", label: "Linear" }, { value: "back", label: "Overshoot" }, { value: "expo", label: "Fast start" }, { value: "elastic", label: "Elastic" }, { value: "bounce", label: "Bounce" },
];
const LOOPS: { value: string; label: string }[] = [
  { value: "none", label: "None" }, { value: "blink", label: "Blink (LIVE dot)" }, { value: "pulse", label: "Pulse" }, { value: "shine", label: "Shine (light sweep)" },
  { value: "float", label: "Float" }, { value: "spin", label: "Spin" }, { value: "breathe", label: "Breathe (glow)" }, { value: "flash", label: "Flash" },
];
const DIRECTIONAL = new Set(["slide", "wipe", "grow", "unfold", "flip", "sweep"]);
const BLENDS = [{ value: "normal", label: "Normal" }, { value: "screen", label: "Screen" }, { value: "multiply", label: "Multiply" }, { value: "add", label: "Add" }, { value: "overlay", label: "Overlay" }];

export function Inspector() {
  const t = useDesigner((s) => s.h.present);
  const sel = useDesigner((s) => s.sel);
  const ratio = useDesigner((s) => s.ratio);
  const readOnly = useDesigner(isReadOnly);
  const r = t.designs[ratio] ? ratio : ratiosOf(t)[0];
  const layer = sel && r ? layerOf(t, r, sel) ?? ratiosOf(t).map((x) => layerOf(t, x, sel)).find(Boolean) : undefined;
  return (
    <div className="pn-scroll">
      <fieldset disabled={readOnly} className={clsx("min-w-0", readOnly && "opacity-70")}>
        {layer && r ? <LayerInspector t={t} layer={layer} ratio={layerOf(t, r, layer.id) ? r : ratiosOf(t).find((x) => layerOf(t, x, layer.id))!} /> : <TemplateInspector t={t} />}
      </fieldset>
    </div>
  );
}

// ── a layer ──────────────────────────────────────────────────────────────────

function LayerInspector({ t, layer, ratio }: { t: GfxTemplate; layer: GfxLayer; ratio: GfxRatio }) {
  const scope = useDesigner((s) => s.scope);
  const clipMode = useDesigner((s) => s.mode === "clip");
  const look = useDesigner((s) => s.look);
  const kind = layerKind(layer.kind);
  const I = kindIcon(layer.kind);
  const both = ratiosOf(t).length > 1;
  const id = layer.id;
  const eff = both ? scope : "all";
  const setP = (def: PropDef, v: unknown) => change((tt) => setProp(tt, ratio, eff, id, def.key, v, def.type === "number" && def.unit === "px"), `p:${id}:${def.key}`);
  const setC = <K extends keyof GfxLayer>(k: K, v: GfxLayer[K] | undefined, key = String(k)) => change((tt) => setCommon(tt, eff === "all" ? "all" : ratio, id, k, v), `c:${id}:${key}`);

  const groups: [string, PropDef[]][] = [];
  for (const p of kind?.props ?? []) {
    const g = p.group ?? kind?.label ?? "Properties";
    const have = groups.find(([n]) => n === g);
    if (have) have[1].push(p); else groups.push([g, [p]]);
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <I className="size-4 shrink-0 text-accent-ink" />
        <input key={id} className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none focus:rounded focus:ring-1 focus:ring-accent/50" defaultValue={layer.name}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== layer.name) change((tt) => setCommon(tt, "all", id, "name", v)); }} />
        <span className="shrink-0 text-2xs text-dim">{kind?.label ?? layer.kind}</span>
      </div>
      {both && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="text-2xs text-mute">Changes go to</span>
          <Seg value={scope} onChange={(v) => useDesigner.setState({ scope: v })}
            options={[{ value: "all", label: "Both ratios", title: "16:9 and 9:16 change together (sizes in proportion)" }, { value: "this", label: `${ratio} only` }]} />
        </div>
      )}
      {!kind && <p className="px-3 py-3 text-xs text-warn">This layer's kind (“{layer.kind}”) isn't available in this version, so only its common properties can be changed.</p>}
      {groups.map(([g, props]) => (
        <Sec key={g} title={g} id={`k.${layer.kind}.${g}`}>
          {props.map((p) => <PropRow key={p.key} def={p} layer={layer} t={t} look={look} onChange={(v) => setP(p, v)} />)}
        </Sec>
      ))}
      <PositionSec t={t} layer={layer} ratio={ratio} setC={setC} />
      <Sec title="When it shows" id="show" open={!!layer.when || !!layer.clip}>
        <WhenRow t={t} layer={layer} onChange={(v) => setC("when", v)} />
        {both && (
          <Row label="Show in" hint="Hide this layer in one ratio only">
            <Seg value={showIn(t, id)} onChange={(v) => change((tt) => {
              let n = tt;
              for (const r of ratiosOf(tt)) n = setCommon(n, r, id, "hidden", v === "all" || v === r ? undefined : true);
              return n;
            })} options={[{ value: "all", label: "Both" }, ...ratiosOf(t).map((r) => ({ value: r as string, label: `${r} only` }))]} />
          </Row>
        )}
        <Row label="Only inside" hint="Draw this layer only inside another layer's box (a reveal behind a plate)">
          <Pick value={layer.clip ?? ""} onChange={(v) => setC("clip", v || undefined)} className="flex-1"
            options={[{ value: "", label: "Anywhere" }, ...(t.designs[ratio]?.layers ?? []).filter((l) => l.id !== id).map((l) => ({ value: l.id, label: l.name }))]} />
        </Row>
        {!clipMode && (
          <Row label="Keeps to" hint="Which frame edges it keeps to when a design is made for another ratio (Make vertical)">
            <Pick value={layer.pin?.x ?? ""} onChange={(v) => setC("pin", { ...layer.pin, x: (v || undefined) as never })} className="w-[92px]"
              options={[{ value: "", label: "Auto" }, { value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }, { value: "stretch", label: "Stretch" }]} />
            <Pick value={layer.pin?.y ?? ""} onChange={(v) => setC("pin", { ...layer.pin, y: (v || undefined) as never })} className="w-[92px]"
              options={[{ value: "", label: "Auto" }, { value: "top", label: "Top" }, { value: "center", label: "Middle" }, { value: "bottom", label: "Bottom" }, { value: "stretch", label: "Stretch" }]} />
          </Row>
        )}
      </Sec>
      <Sec title="Shadow" id="shadow" open={!!layer.shadow} right={<input type="checkbox" checked={!!layer.shadow} onChange={(e) => setC("shadow", e.target.checked ? { color: "#00000099", blur: 16, x: 0, y: 6 } : undefined)} />}>
        {layer.shadow ? (<>
          <Row label="Colour"><PaintPicker value={layer.shadow.color} look={look} allowGradient={false} allowNone={false} onChange={(p) => setC("shadow", { ...layer.shadow!, color: typeof p === "string" ? p : "#00000099" }, "sc")} /></Row>
          <Row label="Softness"><Num value={layer.shadow.blur} min={0} max={120} unit="px" onChange={(v) => setC("shadow", { ...layer.shadow!, blur: Math.round(v) }, "sb")} /></Row>
          <Row label="Offset"><span className="text-2xs text-dim">x</span><Num value={layer.shadow.x} min={-100} max={100} unit="px" onChange={(v) => setC("shadow", { ...layer.shadow!, x: Math.round(v) }, "sx")} />
            <span className="text-2xs text-dim">y</span><Num value={layer.shadow.y} min={-100} max={100} unit="px" onChange={(v) => setC("shadow", { ...layer.shadow!, y: Math.round(v) }, "sy")} /></Row>
        </>) : <p className="px-3 text-2xs text-dim">Tick to add a soft shadow.</p>}
      </Sec>
      <AnimSec t={t} layer={layer} ratio={ratio} parts={layer.kind === "list" || !!kind?.props.some((p) => p.type === "text" || p.type === "longtext")} setAnim={(a) => setC("anim", a)} />
    </div>
  );
}

const showIn = (t: GfxTemplate, id: string): string => {
  const rs = ratiosOf(t).filter((r) => layerOf(t, r, id));
  const shown = rs.filter((r) => !layerOf(t, r, id)!.hidden);
  return shown.length === rs.length || shown.length === 0 ? "all" : shown[0];
};

function PositionSec({ t, layer, ratio, setC }: { t: GfxTemplate; layer: GfxLayer; ratio: GfxRatio; setC: <K extends keyof GfxLayer>(k: K, v: GfxLayer[K] | undefined, key?: string) => void }) {
  const b = layer.box;
  const own = !!t.designs[ratio];
  const put = (nb: Box) => change((tt) => setBox(tt, ratio, layer.id, nb.map(Math.round) as Box), `box:${layer.id}`);
  const S = safeBox(ratio, t.designs[ratio]);
  const al = (what: string) => {
    const [x, y, w, h] = b;
    const nb: Box = what === "l" ? [S[0], y, w, h] : what === "c" ? [DESIGN[ratio].w / 2 - w / 2, y, w, h] : what === "r" ? [S[0] + S[2] - w, y, w, h]
      : what === "t" ? [x, S[1], w, h] : what === "m" ? [x, S[1] + S[3] / 2 - h / 2, w, h] : [x, S[1] + S[3] - h, w, h];
    put(nb);
  };
  return (
    <Sec title={`Position and size · ${ratio}`} id="pos">
      <Row label="Position"><span className="text-2xs text-dim">x</span><Num value={b[0]} unit="px" onChange={(v) => put([v, b[1], b[2], b[3]])} disabled={!own} />
        <span className="text-2xs text-dim">y</span><Num value={b[1]} unit="px" onChange={(v) => put([b[0], v, b[2], b[3]])} disabled={!own} /></Row>
      <Row label="Size"><span className="text-2xs text-dim">w</span><Num value={b[2]} min={1} unit="px" onChange={(v) => put([b[0], b[1], v, b[3]])} disabled={!own} />
        <span className="text-2xs text-dim">h</span><Num value={b[3]} min={1} unit="px" onChange={(v) => put([b[0], b[1], b[2], v])} disabled={!own} /></Row>
      <Row label="Line up" hint="With the safe area (the frame centre across)">
        {([["l", AlignStartVertical, "Safe left"], ["c", AlignCenterVertical, "Centre across"], ["r", AlignEndVertical, "Safe right"], ["t", AlignStartHorizontal, "Safe top"], ["m", AlignCenterHorizontal, "Middle of the safe area"], ["b", AlignEndHorizontal, "Safe bottom"]] as const).map(([k, Ic, title]) => (
          <button key={k} type="button" title={title} className="tl-tbtn" disabled={!own} onClick={() => al(k)}><Ic className="size-3.5" /></button>
        ))}
      </Row>
      <Row label="Rotation"><Num value={layer.rotation ?? 0} min={-180} max={180} step={1} unit="°" onChange={(v) => setC("rotation", Math.round(v) || undefined)} /></Row>
      <Row label="Opacity"><Num value={Math.round((layer.opacity ?? 1) * 100)} min={0} max={100} step={1} unit="%" onChange={(v) => setC("opacity", v >= 100 ? undefined : Math.round(v) / 100)} /></Row>
      <Row label="Blend"><Pick value={layer.blend ?? "normal"} options={BLENDS} onChange={(v) => setC("blend", v === "normal" ? undefined : v as GfxLayer["blend"])} className="flex-1" /></Row>
    </Sec>
  );
}

function WhenRow({ t, layer, onChange }: { t: GfxTemplate; layer: GfxLayer; onChange: (v: string | undefined) => void }) {
  const neg = !!layer.when?.startsWith("!");
  const fid = layer.when?.replace(/^!/, "").replace(/[{}]/g, "") ?? "";
  return (
    <Row label="Show when" hint="Hide this layer when a field is empty (a second line nobody filled in)">
      <Pick value={fid} className="min-w-0 flex-1" onChange={(v) => onChange(v ? `${neg ? "!" : ""}{${v}}` : undefined)}
        options={[{ value: "", label: "Always" }, ...t.fields.map((f) => ({ value: f.id, label: f.label || f.id }))]} />
      {fid && <Seg value={neg ? "empty" : "set"} onChange={(v) => onChange(`${v === "empty" ? "!" : ""}{${fid}}`)} options={[{ value: "set", label: "has a value" }, { value: "empty", label: "is empty" }]} />}
    </Row>
  );
}

/** One property of a kind, by its type. */
function PropRow({ def, layer, t, look, onChange }: { def: PropDef; layer: GfxLayer; t: GfxTemplate; look: ReturnType<typeof ds>["look"]; onChange: (v: unknown) => void }) {
  const v = layer.p[def.key] ?? def.default;
  switch (def.type) {
    case "paint":
      return <Row label={def.label} hint={def.hint}><PaintPicker value={(v as Paint) || undefined} look={look} onChange={(p) => onChange(p ?? "")} /></Row>;
    case "font":
      return <Row label={def.label} hint={def.hint}><FontPicker value={String(v ?? "@body")} onChange={onChange} /></Row>;
    case "number":
      return <Row label={def.label} hint={def.hint}><Num value={typeof v === "number" ? v : Number(v) || 0} min={def.min} max={def.max} step={def.step ?? 1} unit={def.unit} onChange={(n) => onChange(n)} />
        {def.hint && /follows the look|0 =|-1/.test(def.hint) && <span className="truncate text-2xs text-dim">{def.hint}</span>}</Row>;
    case "bool":
      return <Row label={def.label} hint={def.hint}><input type="checkbox" checked={!!v} onChange={(e) => onChange(e.target.checked)} /></Row>;
    case "choice": {
      const opts = def.options ?? [];
      const short = opts.length <= 3 && opts.every((o) => o.label.length <= 9);
      return <Row label={def.label} hint={def.hint}>{short ? <Seg value={String(v)} options={opts} onChange={onChange} /> : <Pick value={String(v ?? "")} options={opts} onChange={onChange} className="min-w-0 flex-1" />}</Row>;
    }
    case "text": case "longtext":
      return <TextProp def={def} layer={layer} t={t} value={String(v ?? "")} onChange={onChange} />;
    case "field":
      return <Row label={def.label} hint={def.hint}><Pick value={String(v ?? "")} className="min-w-0 flex-1" onChange={(x) => onChange(x)}
        options={[{ value: "", label: "None" }, ...t.fields.map((f) => ({ value: f.id, label: `${f.label || f.id} (${f.type})` }))]} /></Row>;
    case "icon":
      return <Row label={def.label} hint={def.hint}><IconPicker value={String(v ?? "")} onChange={onChange} /></Row>;
    case "layer":
      return <LayerProp def={def} layer={layer} t={t} value={v} onChange={onChange} />;
    case "image":
      return <ImageProp def={def} value={String(v ?? "")} onChange={onChange} />;
    case "box": {
      const b = Array.isArray(v) && v.length === 4 ? (v as number[]) : [0, 0, 0, 0];
      return <Row label={def.label} hint={def.hint}>{b.map((x, i) => <Num key={i} value={x} unit={def.unit} onChange={(n) => onChange(b.map((y, j) => (j === i ? n : y)))} />)}</Row>;
    }
    default:
      return null;
  }
}

/** Text with {field} tokens: type it, or insert a field / the clock from the menu. Double-click a layer to come here. */
function TextProp({ def, layer, t, value, onChange }: { def: PropDef; layer: GfxLayer; t: GfxTemplate; value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [txt, setTxt] = useState(value);
  useEffect(() => setTxt(value), [value, layer.id]);
  useEffect(() => {
    const h = () => { ref.current?.focus(); ref.current?.select(); };
    window.addEventListener("nr-designer:focus-text", h);
    return () => window.removeEventListener("nr-designer:focus-text", h);
  }, []);
  const insert = (tok: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? txt.length, to = el?.selectionEnd ?? txt.length;
    const nv = txt.slice(0, at) + tok + txt.slice(to);
    setTxt(nv); onChange(nv);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + tok.length, at + tok.length); });
  };
  const missing = [...txt.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).filter((id) => !t.fields.some((f) => f.id === id));
  const common = { ref, value: txt, spellCheck: false, onChange: (e: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) => { setTxt(e.target.value); onChange(e.target.value); }, onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation() };
  return (
    <div className="space-y-1 px-3">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-mute">{def.label}</span>
        <button type="button" className="text-2xs text-accent-ink hover:underline"
          onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), [
            ...t.fields.map((f) => ({ label: f.label || f.id, hint: `{${f.id}}`, onClick: () => insert(`{${f.id}}`) })),
            { separator: true, label: "Clock time", hint: "{$time}", onClick: () => insert("{$time}") },
            { label: "Clock with seconds", hint: "{$time:s}", onClick: () => insert("{$time:s}") },
            { label: "Date", hint: "{$date}", onClick: () => insert("{$date}") },
          ])}>Insert field ▾</button>
      </div>
      {def.type === "longtext" || txt.length > 40 || txt.includes("\n")
        ? <textarea {...common} rows={Math.min(5, Math.max(2, txt.split("\n").length))} className="ed-field h-auto w-full resize-y py-1 leading-snug" />
        : <input {...common} className="ed-field w-full" />}
      {missing.length > 0 && <p className="text-2xs text-warn">No field called {missing.map((m) => `{${m}}`).join(", ")}: add it in Fields, or it shows as typed.</p>}
    </div>
  );
}

/** A layer reference; `grow` takes a list of plates and padding / limits. */
function LayerProp({ def, layer, t, value, onChange }: { def: PropDef; layer: GfxLayer; t: GfxTemplate; value: unknown; onChange: (v: unknown) => void }) {
  const ratio = useDesigner((s) => s.ratio);
  const others = (t.designs[ratio] ?? t.designs[ratiosOf(t)[0]])?.layers.filter((l) => l.id !== layer.id) ?? [];
  if (def.key === "grow" || (value && typeof value === "object")) {
    const g = (value && typeof value === "object" ? value : null) as { layers: string[]; pad?: number; min?: number; max?: number } | null;
    const ids = g?.layers ?? [];
    const set = (patch: Partial<NonNullable<typeof g>>) => {
      const n = { layers: ids, ...(g ?? {}), ...patch };
      onChange(n.layers.length ? n : null);
    };
    return (
      <div className="space-y-1">
        <Row label={def.label} hint="These plates widen or narrow to fit this text, so a long name never spills out">
          <div className="flex flex-wrap gap-1">
            {others.filter((l) => l.kind !== "text").map((l) => (
              <button key={l.id} type="button" onClick={() => set({ layers: ids.includes(l.id) ? ids.filter((x) => x !== l.id) : [...ids, l.id] })}
                className={clsx("rounded border px-1.5 py-0.5 text-2xs", ids.includes(l.id) ? "border-accent bg-accent/15 text-accent-ink" : "border-line text-mute hover:bg-hover")}>{l.name}</button>
            ))}
          </div>
        </Row>
        {g && (
          <Row label="Plate room"><span className="text-2xs text-dim">pad</span><Num value={g.pad ?? 24} min={0} max={200} unit="px" onChange={(v) => set({ pad: Math.round(v) })} />
            <span className="text-2xs text-dim">max</span><Num value={g.max ?? 0} min={0} max={1920} unit="px" onChange={(v) => set({ max: Math.round(v) || undefined })} /></Row>
        )}
      </div>
    );
  }
  return <Row label={def.label} hint={def.hint}><Pick value={String(value ?? "")} onChange={onChange} className="min-w-0 flex-1" options={[{ value: "", label: "None" }, ...others.map((l) => ({ value: l.id, label: l.name }))]} /></Row>;
}

function ImageProp({ def, value, onChange }: { def: PropDef; value: string; onChange: (v: string) => void }) {
  const media = useDesignerMedia();
  return (
    <Row label={def.label} hint={def.hint}>
      <Pick value={value} onChange={onChange} className="min-w-0 flex-1" options={[{ value: "", label: "None" }, ...media.map((m) => ({ value: m.id, label: m.name }))]} />
    </Row>
  );
}
function useDesignerMedia() {
  const p = useProject();
  return p.media.filter((m) => m.kind === "image");
}

// ── animation ────────────────────────────────────────────────────────────────

function AnimSec({ t, layer, ratio, parts, setAnim }: { t: GfxTemplate; layer: GfxLayer; ratio: GfxRatio; parts: boolean; setAnim: (a: LayerAnim | undefined) => void }) {
  const [tab, setTab] = useState<"in" | "out" | "loop">("in");
  const a = layer.anim ?? {};
  const put = (patch: Partial<LayerAnim>) => {
    const n: LayerAnim = { ...a, ...patch };
    for (const k of ["in", "out", "loop"] as const) if (n[k] === undefined) delete n[k];
    setAnim(Object.keys(n).length ? n : undefined);
  };
  const preview = () => {
    const dur = previewLength(t);
    const lt = layerTiming(t, layer, dur);
    const start = tab === "out" ? Math.max(0, (lt.out?.start ?? dur - t.timing.out) - 0.3) : tab === "loop" ? lt.shownAt : 0;
    clock.setState({ t: start, playing: true });
  };
  void ratio;
  return (
    <Sec title="Animation" id="anim" right={<button type="button" title="Play this part" className="tl-tbtn" onClick={preview}><Play className="size-3.5" /></button>}>
      <div className="px-3 pb-1"><Seg value={tab} onChange={setTab} options={[{ value: "in", label: "In" }, { value: "out", label: "Out" }, { value: "loop", label: "Loop" }]} /></div>
      {tab !== "loop" ? (
        <StepEditor phase={tab} step={a[tab]} canParts={parts} onChange={(s) => put({ [tab]: s })} />
      ) : (
        <LoopEditor loop={a.loop} onChange={(l) => put({ loop: l })} />
      )}
    </Sec>
  );
}

function StepEditor({ phase, step, canParts, onChange }: { phase: "in" | "out"; step: AnimStep | undefined; canParts: boolean; onChange: (s: AnimStep | undefined) => void }) {
  const s = step ?? { kind: "none" };
  const set = (patch: Partial<AnimStep>) => {
    const n = { ...s, ...patch } as AnimStep;
    for (const k of Object.keys(n) as (keyof AnimStep)[]) if (n[k] === undefined) delete n[k];
    onChange(n.kind === "none" && Object.keys(n).length === 1 ? undefined : n);
  };
  const parts = s.kind === "stagger" || s.kind === "typewriter";
  const options = canParts ? ANIMS : ANIMS.filter((a) => a.value !== "typewriter" && a.value !== "stagger");
  return (
    <>
      <Row label={phase === "in" ? "Comes in" : "Goes out"}><Pick value={s.kind} options={options} onChange={(v) => set({ kind: v })} className="min-w-0 flex-1" /></Row>
      {s.kind !== "none" && (<>
        {DIRECTIONAL.has(s.kind) && (
          <Row label="Direction"><Seg value={s.dir ?? (s.kind === "slide" ? "up" : "right")} onChange={(v) => set({ dir: v })}
            options={[{ value: "left", label: "←" , title: "From the right, moving left" }, { value: "right", label: "→", title: "Moving right" }, { value: "up", label: "↑", title: "Moving up" }, { value: "down", label: "↓", title: "Moving down" }]} /></Row>
        )}
        <Row label="Takes"><Num value={s.dur ?? (phase === "in" ? 0.5 : 0.35)} min={0.05} max={10} step={0.05} unit="s" onChange={(v) => set({ dur: Math.round(v * 100) / 100 })} />
          <span className="text-2xs text-dim">after</span><Num value={s.delay ?? 0} min={0} max={20} step={0.02} unit="s" onChange={(v) => set({ delay: Math.round(v * 100) / 100 || undefined })} /></Row>
        <Row label="Easing"><Pick value={s.ease ?? "look"} options={EASE_OPTIONS} onChange={(v) => set({ ease: v === "look" ? undefined : v })} className="min-w-0 flex-1" /></Row>
        {(parts || s.by) && (
          <Row label="Part by part" hint="Indian scripts never go letter by letter (letters join): they go by word">
            <Pick value={s.by ?? (s.kind === "typewriter" ? "char" : "word")} onChange={(v) => set({ by: v })} className="w-[110px]"
              options={[{ value: "all", label: "All at once" }, { value: "line", label: "By line" }, { value: "word", label: "By word" }, { value: "char", label: "By letter" }, { value: "item", label: "By item" }]} />
            <Num value={s.stagger ?? 0.06} min={0} max={1} step={0.01} unit="s" onChange={(v) => set({ stagger: Math.round(v * 100) / 100 })} />
          </Row>
        )}
        {canParts && !parts && !s.by && <Row label=""><button type="button" className="text-2xs text-accent-ink hover:underline" onClick={() => set({ by: "word", stagger: 0.06 })}>Animate part by part</button></Row>}
        {(s.kind === "slide" || s.kind === "rise" || s.kind === "drop") && (
          <Row label="Distance" hint="0 = its own size"><Num value={s.distance ?? 0} min={0} max={2000} unit="px" onChange={(v) => set({ distance: Math.round(v) || undefined })} /></Row>
        )}
      </>)}
    </>
  );
}

function LoopEditor({ loop, onChange }: { loop: LoopSpec | undefined; onChange: (l: LoopSpec | undefined) => void }) {
  const l = loop ?? { kind: "none", period: 2 };
  const set = (patch: Partial<LoopSpec>) => { const n = { ...l, ...patch }; onChange(n.kind === "none" ? undefined : n); };
  return (
    <>
      <Row label="While shown"><Pick value={l.kind} options={LOOPS} onChange={(v) => set({ kind: v, period: v === "shine" ? 10 : v === "blink" ? 1 : l.period || 2 })} className="min-w-0 flex-1" /></Row>
      {l.kind !== "none" && (<>
        <Row label="Every"><Num value={l.period} min={0.1} max={60} step={0.1} unit="s" onChange={(v) => set({ period: Math.round(v * 10) / 10 })} /></Row>
        <Row label="Amount" hint="How strong (empty = the usual)"><Num value={l.amount ?? 0} min={0} max={100} step={0.01} onChange={(v) => set({ amount: v || undefined })} /></Row>
        <Row label="Starts after"><Num value={l.delay ?? 0} min={0} max={30} step={0.1} unit="s" onChange={(v) => set({ delay: Math.round(v * 10) / 10 || undefined })} /></Row>
      </>)}
    </>
  );
}

// ── the template ─────────────────────────────────────────────────────────────

const SOUNDS = ["whoosh", "swish", "impact", "riser", "hit", "tick", "ding", "boom", "glitch", "paper"];
const ROLE_LABEL: Record<string, string> = { background: "Background (below V1)", layout: "Layout", board: "Boards", strap: "Straps", ticker: "Ticker", bug: "Bug", wipe: "Wipes" };

function TemplateInspector({ t }: { t: GfxTemplate }) {
  const clipMode = useDesigner((s) => s.mode === "clip");
  const set = (patch: Partial<GfxTemplate>, key?: string) => change((tt) => ({ ...tt, ...patch }), key ? `tpl:${key}` : undefined);
  return (
    <fieldset disabled={clipMode} className={clsx("min-w-0", clipMode && "opacity-60")}>
      <div className="border-b border-line px-3 py-2">
        <p className="text-sm font-medium">Template</p>
        <p className="text-2xs text-dim">{clipMode ? "These belong to the template; this graphic follows them." : "Click a layer on the canvas or in the list to change it."}</p>
      </div>
      <Sec title="About" id="tpl.about">
        <Row label="Name"><input key={t.id + t.name} className="ed-field min-w-0 flex-1" defaultValue={t.name} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.name) set({ name: v }); }} /></Row>
        <Row label="Category"><Pick value={t.category} options={CATEGORIES.map((c) => ({ value: c, label: c }))} onChange={(v) => set({ category: v })} className="flex-1" /></Row>
        <Row label="Track" hint="Which graphics track it goes on"><Pick value={t.role} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }))} onChange={(v) => set({ role: v })} className="flex-1" /></Row>
        <Row label="Description" wide><textarea key={t.id} className="ed-field h-14 w-full py-1" defaultValue={t.description ?? ""} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { if ((t.description ?? "") !== e.target.value) set({ description: e.target.value || undefined }); }} /></Row>
        <Row label="Search words"><input key={t.id + "tags"} className="ed-field min-w-0 flex-1" defaultValue={(t.tags ?? []).join(", ")} placeholder="election, results" onKeyDown={(e) => e.stopPropagation()}
          onBlur={(e) => { const tags = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); if (tags.join() !== (t.tags ?? []).join()) set({ tags: tags.length ? tags : undefined }); }} /></Row>
      </Sec>
      <Sec title="Timing" id="tpl.timing">
        <Row label="Comes in over" hint="Seconds at the start for layers to animate in"><Num value={t.timing.in} min={0} max={10} step={0.05} unit="s" onChange={(v) => set({ timing: { ...t.timing, in: Math.round(v * 100) / 100 } }, "in")} /></Row>
        <Row label="Goes out over" hint="The last seconds, for layers to animate out"><Num value={t.timing.out} min={0} max={10} step={0.05} unit="s" onChange={(v) => set({ timing: { ...t.timing, out: Math.round(v * 100) / 100 } }, "out")} /></Row>
        <Row label="Length" hint="0 = runs to the end of the sequence (bugs, tickers, backgrounds)"><Num value={t.seconds} min={0} max={600} step={0.5} unit="s" onChange={(v) => set({ seconds: Math.round(v * 10) / 10 }, "len")} />
          {t.seconds === 0 && <span className="text-2xs text-dim">to the end</span>}</Row>
        <Row label="How long it holds"><Pick value={t.hold ?? (t.seconds === 0 ? "fill" : "fixed")} onChange={(v) => set({ hold: v })} className="flex-1"
          options={[{ value: "auto", label: "Long enough to read" }, { value: "fixed", label: "Its length" }, { value: "until-next", label: "Until the next one" }, { value: "fill", label: "To the end" }]} /></Row>
        <Row label="Loops" hint="Plays over its whole length and repeats seamlessly (tickers, bugs, backgrounds)"><input type="checkbox" checked={!!t.loop} onChange={(e) => set({ loop: e.target.checked || undefined })} /></Row>
        {(t.category === "Stingers" || t.cut !== undefined) && (
          <Row label="Cut at" hint="Where the frame is fully covered: the cut sits here"><Num value={Math.round((t.cut ?? 0.5) * 100)} min={0} max={100} unit="%" onChange={(v) => set({ cut: Math.round(v) / 100 }, "cut")} /></Row>
        )}
      </Sec>
      <Sec title="Sound hints" id="tpl.sounds" open={false}>
        <p className="px-3 text-2xs text-dim">Auto SFX adds these sounds when the graphic comes in, goes out, or (stingers) at the cut.</p>
        {(["in", "out", "cut"] as const).map((k) => (
          <Row key={k} label={k === "in" ? "Coming in" : k === "out" ? "Going out" : "At the cut"}>
            <input list="nr-designer-sounds" key={t.id + k} className="ed-field min-w-0 flex-1" defaultValue={t.sounds?.[k] ?? ""} placeholder="none" onKeyDown={(e) => e.stopPropagation()}
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (t.sounds?.[k] ?? "")) { const s = { ...t.sounds, [k]: v || undefined }; set({ sounds: Object.values(s).some(Boolean) ? s : undefined }); } }} />
          </Row>
        ))}
        <datalist id="nr-designer-sounds">{SOUNDS.map((s) => <option key={s} value={s} />)}</datalist>
      </Sec>
    </fieldset>
  );
}
