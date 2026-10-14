/**
 * The Designer's left side (docs/EDITOR.md §16.8): the layers (top of the list = in front; add any registered kind,
 * duplicate, delete, drag to reorder, hide, lock, rename) and the fields (the blanks the Fill in form asks for: add,
 * name, type, default, hint, required; link to text with {tokens}; reorder; remove).
 */
import { clsx } from "clsx";
import {
  BarChart3, ChevronDown, ChevronRight, Clock, Columns3, Copy, Eye, EyeOff, GripVertical, Hash, Image, Layers, List, Lock, LockOpen, MapPin,
  Minus, Plus, Rss, Shapes, Sparkles, Square, Table, Trash2, Tv, Type, Video,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Menu } from "../../../components/ui";
import { openMenu } from "../../ui";
import { defaultProps, layerKind, layerKinds } from "../render/registry";
import type { GfxField, GfxFieldType, GfxLayer, GfxListItem, GfxTemplate, GfxValue } from "../types";
import { addField, addLayer, defaultFor, duplicateLayer, fieldUses, isFieldId, moveField, moveLayer, ratiosOf, removeField, removeLayer, setCommon, updateField } from "./doc";
import { Num, PaintPicker, Pick, Row } from "./controls";
import { change, ds, select, useDesigner } from "./state";

const KIND_ICON: Record<string, typeof Square> = {
  rect: Square, text: Type, image: Image, logo: Tv, line: Minus, icon: Shapes, ticker: Rss, clock: Clock, number: Hash, list: List,
  bars: BarChart3, table: Table, pins: MapPin, slot: Video, shine: Sparkles, panels: Columns3, bg: Layers,
};
export const kindIcon = (k: string) => KIND_ICON[k] ?? Square;

export const FIELD_TYPES: { value: GfxFieldType; label: string }[] = [
  { value: "text", label: "Text" }, { value: "longtext", label: "Long text" }, { value: "list", label: "List (one per line)" },
  { value: "number", label: "Number" }, { value: "image", label: "Picture" }, { value: "toggle", label: "Switch" },
  { value: "choice", label: "Choice" }, { value: "table", label: "Table" }, { value: "color", label: "Colour" }, { value: "datetime", label: "Date and time" },
];
const FILLS = [
  { value: "", label: "Typed in" }, { value: "person.name", label: "A person's name" }, { value: "person.role", label: "A person's role" },
  { value: "person.photo", label: "A person's photo" }, { value: "place", label: "A place" }, { value: "story.headline", label: "Story headline" },
  { value: "story.strap", label: "Story second line" }, { value: "story.slug", label: "Story slug" }, { value: "story.points", label: "Story key points" },
];

export function LayersPanel({ readOnly }: { readOnly: boolean }) {
  const tab = useDesigner((s) => s.tab);
  const clipMode = useDesigner((s) => s.mode === "clip");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="ed-bar gap-1 px-2">
        <div className="ed-seg">
          <button type="button" aria-pressed={tab === "layers"} onClick={() => useDesigner.setState({ tab: "layers" })}>Layers</button>
          <button type="button" aria-pressed={tab === "fields"} onClick={() => useDesigner.setState({ tab: "fields" })}>Fields</button>
        </div>
        <span className="flex-1" />
        {tab === "layers" && !readOnly && !clipMode && <AddLayer />}
        {tab === "fields" && !readOnly && !clipMode && <AddField />}
      </div>
      <div className="pn-scroll">{tab === "layers" ? <LayerList readOnly={readOnly} /> : <FieldList readOnly={readOnly || clipMode} />}</div>
      {clipMode && <p className="border-t border-line px-3 py-2 text-2xs leading-snug text-dim">Changes here apply to this graphic only. Adding layers and fields needs the template (Edit template).</p>}
    </div>
  );
}

// ── layers ───────────────────────────────────────────────────────────────────

function AddLayer() {
  const groups = ["Basic", "Text", "Data", "Video", "Motion"] as const;
  const kinds = layerKinds();
  const add = (kind: string) => {
    const k = layerKind(kind);
    const st = ds();
    const { t, id } = addLayer(st.h.present, kind, defaultProps(kind), { name: k?.label ?? kind, above: st.sel ?? undefined });
    change(() => t);
    select(id);
  };
  return (
    <button type="button" className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-mute hover:bg-hover hover:text-ink" onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(),
      groups.filter((g) => kinds.some((k) => k.group === g)).map((g) => ({
        label: g, items: kinds.filter((k) => k.group === g).map((k) => { const I = kindIcon(k.kind); return { label: k.label, icon: <I className="size-3.5" />, onClick: () => add(k.kind) }; }),
      })))}>
      <Plus className="size-3.5" /> Add layer
    </button>
  );
}

function LayerList({ readOnly }: { readOnly: boolean }) {
  const t = useDesigner((s) => s.h.present);
  const ratio = useDesigner((s) => s.ratio);
  const sel = useDesigner((s) => s.sel);
  const clipMode = useDesigner((s) => s.mode === "clip");
  const r = t.designs[ratio] ? ratio : ratiosOf(t)[0];
  const layers = r ? t.designs[r]!.layers : [];
  const [drop, setDrop] = useState<{ id: string; above: boolean } | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  if (!layers.length) return <div className="pn-empty h-auto py-10">No layers yet. Add one with “Add layer”.</div>;
  const structural = !readOnly && !clipMode;

  const menu = (e: React.MouseEvent, l: GfxLayer) => {
    e.preventDefault();
    select(l.id);
    openMenu(e, [
      { label: "Rename", onClick: () => setRename(l.id), disabled: readOnly },
      structural && { label: "Duplicate", icon: <Copy className="size-3.5" />, shortcut: "Ctrl+D", onClick: () => { const r2 = duplicateLayer(ds().h.present, l.id); change(() => r2.t); select(r2.id); } },
      { label: l.hidden ? "Show" : "Hide", onClick: () => change((tt) => setCommon(tt, "all", l.id, "hidden", l.hidden ? undefined : true)), disabled: readOnly },
      { label: l.locked ? "Unlock" : "Lock (can't be picked on the canvas)", onClick: () => change((tt) => setCommon(tt, "all", l.id, "locked", l.locked ? undefined : true)), disabled: readOnly },
      structural && { separator: true, label: "Bring to front", onClick: () => change((tt) => moveLayer(tt, r!, l.id, layers.length - 1)) },
      structural && { label: "Send to back", onClick: () => change((tt) => moveLayer(tt, r!, l.id, 0)) },
      structural && { separator: true, label: "Delete", danger: true, icon: <Trash2 className="size-3.5" />, shortcut: "Del", onClick: () => change((tt) => removeLayer(tt, l.id)) },
    ]);
  };

  return (
    <div className="py-1" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null); }}>
      {[...layers].reverse().map((l) => {
        const I = kindIcon(l.kind);
        const on = l.id === sel;
        return (
          <div key={l.id} draggable={structural && rename !== l.id}
            onDragStart={(e) => { dragId.current = l.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", l.id); }}
            onDragOver={(e) => {
              if (!dragId.current || dragId.current === l.id) return;
              e.preventDefault();
              const rc = e.currentTarget.getBoundingClientRect();
              setDrop({ id: l.id, above: e.clientY < rc.top + rc.height / 2 });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragId.current; dragId.current = null; setDrop(null);
              if (!from || from === l.id || !r) return;
              const iM = layers.findIndex((x) => x.id === from), iT = layers.findIndex((x) => x.id === l.id);
              const above = e.clientY < e.currentTarget.getBoundingClientRect().top + e.currentTarget.clientHeight / 2;
              const to = above ? (iM < iT ? iT : iT + 1) : (iM < iT ? iT - 1 : iT);
              change((tt) => moveLayer(tt, r, from, to));
            }}
            onDragEnd={() => { dragId.current = null; setDrop(null); }}
            onClick={() => select(l.id)} onDoubleClick={() => !readOnly && setRename(l.id)} onContextMenu={(e) => menu(e, l)}
            className={clsx("pn-row group relative cursor-default", on && "sel", l.hidden && "opacity-50")}>
            {drop?.id === l.id && <span className={clsx("absolute inset-x-1 h-0.5 rounded bg-accent", drop.above ? "top-0" : "bottom-0")} />}
            {structural && <GripVertical className="size-3.5 shrink-0 cursor-grab text-dim opacity-0 group-hover:opacity-100" />}
            <I className={clsx("size-3.5 shrink-0", on ? "text-accent-ink" : "text-mute")} />
            {rename === l.id ? (
              <input autoFocus defaultValue={l.name} className="ed-field h-6 min-w-0 flex-1"
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRename(null); }}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== l.name) change((tt) => setCommon(tt, "all", l.id, "name", v)); setRename(null); }} />
            ) : (
              <span className="min-w-0 flex-1 truncate" title={`${layerKind(l.kind)?.label ?? l.kind} · ${l.id}`}>{l.name}</span>
            )}
            {l.when && <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-dim" title={`Shown when ${l.when.startsWith("!") ? "this is empty: " : ""}${l.when.replace(/^!/, "")}`}>if</span>}
            <button type="button" title={l.hidden ? "Show" : "Hide"} disabled={readOnly} className={clsx("tl-tbtn", !l.hidden && "opacity-0 group-hover:opacity-100")}
              onClick={(e) => { e.stopPropagation(); change((tt) => setCommon(tt, "all", l.id, "hidden", l.hidden ? undefined : true)); }}>
              {l.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            <button type="button" title={l.locked ? "Unlock" : "Lock on the canvas"} disabled={readOnly} className={clsx("tl-tbtn", l.locked ? "lock on" : "opacity-0 group-hover:opacity-100")}
              onClick={(e) => { e.stopPropagation(); change((tt) => setCommon(tt, "all", l.id, "locked", l.locked ? undefined : true)); }}>
              {l.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
            </button>
          </div>
        );
      })}
      <p className="px-3 pb-2 pt-3 text-2xs leading-snug text-dim">The top of the list is in front. Drag to reorder; right-click for more.</p>
    </div>
  );
}

// ── fields ───────────────────────────────────────────────────────────────────

function AddField() {
  return (
    <Menu width={190} trigger={(p) => <button type="button" {...p} className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-mute hover:bg-hover hover:text-ink"><Plus className="size-3.5" /> Add field</button>}
      items={FIELD_TYPES.map((f) => ({
        label: f.label, onClick: () => {
          const { t, id } = addField(ds().h.present, f.value, f.value === "image" ? "Picture" : f.value === "list" ? "Items" : "New field");
          change(() => t);
          window.dispatchEvent(new CustomEvent("nr-designer:open-field", { detail: id }));
        },
      }))} />
  );
}

function FieldList({ readOnly }: { readOnly: boolean }) {
  const t = useDesigner((s) => s.h.present);
  const [open, setOpen] = useState<string | null>(null);
  const dragI = useRef<number | null>(null);
  const [dropI, setDropI] = useState<number | null>(null);
  useEffect(() => {
    const h = (e: Event) => setOpen((e as CustomEvent<string>).detail);
    window.addEventListener("nr-designer:open-field", h);
    return () => window.removeEventListener("nr-designer:open-field", h);
  }, []);
  if (!t.fields.length) return <div className="pn-empty h-auto py-10">No fields. A field is a blank someone fills in (a name, a headline, a photo); put it in text as {"{id}"}.</div>;
  return (
    <div className="py-1">
      {t.fields.map((f, i) => {
        const uses = fieldUses(t, f.id);
        const on = open === f.id;
        return (
          <div key={f.id} className={clsx("border-b border-line/50", dropI === i && "border-t-2 border-t-accent")}
            draggable={!readOnly && !on} onDragStart={() => { dragI.current = i; }}
            onDragOver={(e) => { if (dragI.current === null) return; e.preventDefault(); setDropI(i); }}
            onDrop={() => { const from = dragI.current; dragI.current = null; setDropI(null); if (from !== null && from !== i) change((tt) => moveField(tt, from, i)); }}
            onDragEnd={() => { dragI.current = null; setDropI(null); }}>
            <div className={clsx("pn-row group cursor-default", on && "sel")} onClick={() => setOpen(on ? null : f.id)}>
              {on ? <ChevronDown className="size-3.5 text-dim" /> : <ChevronRight className="size-3.5 text-dim" />}
              <span className="min-w-0 flex-1 truncate">{f.label || f.id}</span>
              <span className="ed-tc shrink-0 text-[10px] text-dim">{`{${f.id}}`}</span>
              <span className={clsx("shrink-0 rounded px-1 text-[10px]", uses ? "bg-hover text-mute" : "bg-warn/15 text-warn")} title={uses ? `Used by ${uses} layer${uses > 1 ? "s" : ""}` : "Not used by any layer yet"}>{uses || "unused"}</span>
            </div>
            {on && <FieldEditor f={f} t={t} readOnly={readOnly} />}
          </div>
        );
      })}
    </div>
  );
}

function FieldEditor({ f, t, readOnly }: { f: GfxField; t: GfxTemplate; readOnly: boolean }) {
  const look = useDesigner((s) => s.look);
  const sel = useDesigner((s) => s.sel);
  const ratio = useDesigner((s) => s.ratio);
  const set = (patch: Partial<GfxField>, key?: string) => change((tt) => updateField(tt, f.id, patch), key ? `field:${f.id}:${key}` : undefined);
  const selLayer = sel ? (t.designs[ratio] ?? t.designs[ratiosOf(t)[0]])?.layers.find((l) => l.id === sel) : undefined;
  const textKey = selLayer ? layerKind(selLayer.kind)?.props.find((p) => p.type === "text" || p.type === "longtext")?.key : undefined;
  const fieldKey = selLayer ? layerKind(selLayer.kind)?.props.find((p) => p.type === "field")?.key : undefined;
  const link = () => {
    if (!selLayer) return;
    if (fieldKey && (f.type === "image" || f.type === "list" || f.type === "table" || f.type === "number")) {
      change((tt) => {
        let n = tt;
        for (const r of ratiosOf(tt)) n = { ...n, designs: { ...n.designs, [r]: { ...n.designs[r]!, layers: n.designs[r]!.layers.map((l) => (l.id === selLayer.id ? { ...l, p: { ...l.p, [fieldKey]: f.id } } : l)) } } };
        return n;
      });
      toast.success(`“${selLayer.name}” now shows ${f.label}`);
    } else if (textKey) {
      change((tt) => {
        let n = tt;
        for (const r of ratiosOf(tt)) n = { ...n, designs: { ...n.designs, [r]: { ...n.designs[r]!, layers: n.designs[r]!.layers.map((l) => (l.id === selLayer.id ? { ...l, p: { ...l.p, [textKey]: `${String(l.p[textKey] ?? "").trim()}${String(l.p[textKey] ?? "").trim() ? " " : ""}{${f.id}}` } } : l)) } } };
        return n;
      });
      toast.success(`Added {${f.id}} to “${selLayer.name}”`);
    }
  };
  const [idText, setIdText] = useState(f.id);
  return (
    <div className="space-y-1 pb-2 pt-1">
      <Row label="Label"><input className="ed-field min-w-0 flex-1" defaultValue={f.label} disabled={readOnly} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { if (e.target.value !== f.label) set({ label: e.target.value }); }} /></Row>
      <Row label="Name in text" hint="Write {name} in a text layer to show this field there">
        <input className="ed-field ed-tc min-w-0 flex-1" value={idText} disabled={readOnly} spellCheck={false} onChange={(e) => setIdText(e.target.value.replace(/[^A-Za-z0-9_]/g, "_"))}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          onBlur={() => {
            if (idText === f.id) return;
            if (!isFieldId(idText) || t.fields.some((x) => x.id === idText)) { toast.error("That name is taken or not allowed (letters, digits and _; not starting with a digit)."); setIdText(f.id); return; }
            set({ id: idText });
          }} />
      </Row>
      <Row label="Type"><Pick value={f.type} options={FIELD_TYPES} disabled={readOnly} onChange={(v) => set({ type: v, default: defaultFor(v), ...(v === "choice" && !f.options ? { options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }], default: "one" } : {}) })} className="flex-1" /></Row>
      <Row label="Sample / default" wide={f.type === "longtext" || f.type === "list" || f.type === "table"}>
        <DefaultEditor f={f} look={look} disabled={readOnly} onChange={(v) => set({ default: v }, "default")} />
      </Row>
      {f.type === "choice" && <OptionsEditor f={f} disabled={readOnly} onChange={(options) => set({ options })} />}
      {f.type === "table" && <ColumnsEditor f={f} disabled={readOnly} onChange={(columns) => set({ columns })} />}
      {f.type === "number" && (
        <Row label="Written as">
          <span className="text-2xs text-dim">decimals</span><Num value={f.format?.decimals ?? 0} min={0} max={4} onChange={(v) => set({ format: { ...f.format, decimals: Math.round(v) } }, "fmt")} />
          <label className="flex items-center gap-1 text-2xs"><input type="checkbox" checked={!!f.format?.currency} onChange={(e) => set({ format: { ...f.format, currency: e.target.checked } })} />₹</label>
          <label className="flex items-center gap-1 text-2xs" title="1,23,45,678 → 1.23 crore"><input type="checkbox" checked={!!f.format?.compact} onChange={(e) => set({ format: { ...f.format, compact: e.target.checked } })} />lakh / crore</label>
          <label className="flex items-center gap-1 text-2xs"><input type="checkbox" checked={!!f.format?.sign} onChange={(e) => set({ format: { ...f.format, sign: e.target.checked } })} />+ sign</label>
        </Row>
      )}
      {(f.type === "text" || f.type === "longtext") && <Row label="Soft limit" hint="The Fill in form warns past this many letters (0 = none)"><Num value={f.maxLength ?? 0} min={0} max={500} unit="letters" onChange={(v) => set({ maxLength: Math.round(v) || undefined }, "max")} /></Row>}
      {(f.type === "list" || f.type === "table") && <Row label="Most items"><Num value={f.maxItems ?? 0} min={0} max={200} onChange={(v) => set({ maxItems: Math.round(v) || undefined }, "maxi")} /></Row>}
      <Row label="Hint"><input className="ed-field min-w-0 flex-1" defaultValue={f.hint ?? ""} placeholder="Shown under the box in Fill in" disabled={readOnly} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { if ((f.hint ?? "") !== e.target.value) set({ hint: e.target.value || undefined }); }} /></Row>
      <Row label="Comes from"><Pick value={f.fill ?? ""} options={FILLS} disabled={readOnly} onChange={(v) => set({ fill: v || undefined })} className="flex-1" /></Row>
      <Row label="Required"><input type="checkbox" checked={!!f.required} disabled={readOnly} onChange={(e) => set({ required: e.target.checked || undefined })} /><span className="text-2xs text-dim">Flagged when empty</span></Row>
      {!readOnly && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-1">
          <button type="button" className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-40" disabled={!selLayer || (!textKey && !fieldKey)} onClick={link}
            title={selLayer ? `Show this field in “${selLayer.name}”` : "Select a layer first"}>
            {selLayer ? `Use in “${selLayer.name}”` : "Use in the selected layer"}
          </button>
          <button type="button" className="rounded-md px-2 py-1 text-xs text-red-300 hover:bg-bad/15"
            onClick={() => {
              const uses = fieldUses(t, f.id);
              if (uses && !window.confirm(`${uses} layer${uses > 1 ? "s use" : " uses"} {${f.id}}. Remove the field anyway? Their text keeps the {${f.id}} mark.`)) return;
              change((tt) => removeField(tt, f.id));
            }}>Remove</button>
        </div>
      )}
    </div>
  );
}

function DefaultEditor({ f, look, disabled, onChange }: { f: GfxField; look: ReturnType<typeof ds>["look"]; disabled: boolean; onChange: (v: GfxValue) => void }) {
  const v = f.default;
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  switch (f.type) {
    case "text": case "datetime":
      return <input className="ed-field min-w-0 flex-1" type={f.type === "datetime" ? "datetime-local" : "text"} defaultValue={String(v ?? "")} disabled={disabled} onKeyDown={stop} onBlur={(e) => onChange(e.target.value)} key={f.id + f.type} />;
    case "longtext":
      return <textarea className="ed-field h-16 w-full py-1" defaultValue={String(v ?? "")} disabled={disabled} onKeyDown={stop} onBlur={(e) => onChange(e.target.value)} key={f.id + f.type} />;
    case "list":
      return <textarea className="ed-field h-20 w-full py-1" placeholder="One item per line" key={f.id + f.type} disabled={disabled} onKeyDown={stop}
        defaultValue={(Array.isArray(v) ? (v as (GfxListItem | string)[]) : []).map((x) => (typeof x === "string" ? x : x.text)).join("\n")}
        onBlur={(e) => onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean).map((text) => ({ text })))} />;
    case "number":
      return <Num value={typeof v === "number" ? v : 0} step={1} onChange={(n, done) => { if (done) onChange(n); }} />;
    case "toggle":
      return <input type="checkbox" checked={!!v} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
    case "choice":
      return <Pick value={String(v ?? "")} options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))} disabled={disabled} onChange={onChange} className="flex-1" />;
    case "color":
      return <PaintPicker value={String(v ?? "@primary")} look={look} allowGradient={false} allowNone={false} onChange={(p) => onChange(typeof p === "string" ? p : "@primary")} disabled={disabled} />;
    case "image":
      return <span className="text-2xs text-dim">Pictures are picked in Fill in (from the bin).</span>;
    case "table":
      return <TableDefault f={f} disabled={disabled} onChange={onChange} />;
  }
}

function TableDefault({ f, disabled, onChange }: { f: GfxField; disabled: boolean; onChange: (v: GfxValue) => void }) {
  const cols = f.columns ?? [];
  const rows = Array.isArray(f.default) ? (f.default as Record<string, string | number>[]) : [];
  return (
    <textarea className="ed-field ed-tc h-20 w-full py-1 text-2xs" key={f.id + cols.map((c) => c.id).join()} disabled={disabled} onKeyDown={(e) => e.stopPropagation()}
      placeholder={`One row per line: ${cols.map((c) => c.label).join(" | ")}`}
      defaultValue={rows.map((r) => cols.map((c) => r[c.id] ?? "").join(" | ")).join("\n")}
      onBlur={(e) => onChange(e.target.value.split("\n").filter((l) => l.trim()).map((line) => {
        const cells = line.split("|").map((s) => s.trim());
        return Object.fromEntries(cols.map((c, i) => [c.id, c.type === "number" && cells[i] !== "" && Number.isFinite(Number(cells[i])) ? Number(cells[i]) : cells[i] ?? ""]));
      }))} />
  );
}

function ListRows<T>({ items, render, onAdd, addLabel, disabled }: { items: T[]; render: (x: T, i: number) => ReactNode; onAdd: () => void; addLabel: string; disabled: boolean }) {
  return (
    <div className="space-y-1 px-3">
      {items.map((x, i) => <div key={i} className="flex items-center gap-1">{render(x, i)}</div>)}
      {!disabled && <button type="button" className="text-2xs text-accent-ink hover:underline" onClick={onAdd}>{addLabel}</button>}
    </div>
  );
}

function OptionsEditor({ f, disabled, onChange }: { f: GfxField; disabled: boolean; onChange: (o: NonNullable<GfxField["options"]>) => void }) {
  const opts = f.options ?? [];
  const put = (i: number, patch: Partial<{ value: string; label: string }>) => onChange(opts.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  return (
    <div className="pb-1">
      <p className="px-3 pb-1 text-2xs text-mute">Choices</p>
      <ListRows items={opts} disabled={disabled} addLabel="Add a choice" onAdd={() => onChange([...opts, { value: `option_${opts.length + 1}`, label: `Option ${opts.length + 1}` }])}
        render={(o, i) => (<>
          <input className="ed-field min-w-0 flex-1" defaultValue={o.label} disabled={disabled} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => put(i, { label: e.target.value })} placeholder="Shown as" />
          <input className="ed-field ed-tc w-24" defaultValue={o.value} disabled={disabled} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => put(i, { value: e.target.value.trim() || o.value })} placeholder="value" />
          {!disabled && <button type="button" className="tl-tbtn" title="Remove" onClick={() => onChange(opts.filter((_, j) => j !== i))}><Trash2 className="size-3" /></button>}
        </>)} />
    </div>
  );
}

function ColumnsEditor({ f, disabled, onChange }: { f: GfxField; disabled: boolean; onChange: (c: NonNullable<GfxField["columns"]>) => void }) {
  const cols = f.columns ?? [];
  const put = (i: number, patch: Partial<NonNullable<GfxField["columns"]>[number]>) => onChange(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="pb-1">
      <p className="px-3 pb-1 text-2xs text-mute">Columns</p>
      <ListRows items={cols} disabled={disabled} addLabel="Add a column" onAdd={() => onChange([...cols, { id: `col${cols.length + 1}`, label: `Column ${cols.length + 1}`, type: "text" }])}
        render={(c, i) => (<>
          <input className="ed-field min-w-0 flex-1" defaultValue={c.label} disabled={disabled} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => put(i, { label: e.target.value })} />
          <Pick value={c.type} disabled={disabled} options={[{ value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "color", label: "Colour" }]} onChange={(v) => put(i, { type: v })} className="w-24" />
          {!disabled && <button type="button" className="tl-tbtn" title="Remove" onClick={() => onChange(cols.filter((_, j) => j !== i))}><Trash2 className="size-3" /></button>}
        </>)} />
    </div>
  );
}
