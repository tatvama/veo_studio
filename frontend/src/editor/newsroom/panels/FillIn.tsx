/**
 * News Room: Fill in (docs/EDITOR.md §16.8) — the form for the selected graphic, built from its template's blanks:
 * text with character hints, lines, lists, tables (paste from a spreadsheet), numbers, switches, choices, colours
 * from the look, dates and pictures from the bin, with people / places / story pickers that fill several blanks at
 * once. Below: the look, the length (auto, until the next graphic, to the end, or seconds), which ratio it shows in,
 * language versions, and for screen layouts which picture goes in which box. A live picture sits at the top. Typing
 * is one undo step per field; every other change is one step.
 */
import { clsx } from "clsx";
import { Languages, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, Modal, Segmented, Textarea } from "../../../components/ui";
import { framesToSeconds, secondsToFrames, toTimecode } from "../../model/time";
import type { EditProject } from "../../model/types";
import { program } from "../../playback/transport";
import { setFocus, urlFor, useEditor, useProject } from "../../store";
import { IBtn, openMenu, type MenuItem } from "../../ui";
import { autoHold, replaceGraphicTemplate, useTemplate as copyTemplateIn, type GraphicClip } from "../commands";
import { openDesigner } from "../events";
import { fmtNumber } from "../format";
import { BUILTIN_LOOKS, resolveLook } from "../looks";
import { ratioOf } from "../render/index";
import type { GfxField, GfxImageRef, GfxInstance, GfxListItem, GfxRatio, GfxTableRow, GfxTemplate, GfxValue, LookColor } from "../types";
import { addToPlaylist, host } from "../room/actions";
import { parseNumber, tableFromText } from "../room/csv";
import { setClipLength, untilNext, updateGraphic } from "../room/doc";
import { fillKey, groupFields, itemsText, lengthHint, valueIn, valuesFromPerson, valuesFromPlace, valuesFromStory } from "../room/fields";
import { FindReplaceHost, openFindReplace } from "../room/FindReplace";
import { allTemplates, clipInput, useLibraryTemplates, useSelectedGfx, useNewsroomDoc } from "../room/hooks";
import { ImagePicker, LiveText, PersonPicker, PlacePicker, StoryPicker } from "../room/pickers";
import { GfxPreview } from "../room/Preview";
import { contentEnd } from "../room/starter";
import { liveDone, liveEdit } from "../room/live";
import { TickerItemsEditor } from "../tickers/ItemsEditor";
import { SlotAssigner } from "../layouts/SlotAssigner";
import { isLayout } from "../slots";
import { useNewsBoot } from "../room/NewNewsEdit";

const LANG_NAMES: Record<string, string> = { en: "English", hi: "Hindi", kn: "Kannada", te: "Telugu", ta: "Tamil", ml: "Malayalam", mr: "Marathi", bn: "Bengali", gu: "Gujarati", pa: "Punjabi", or: "Odia", ur: "Urdu" };
const langName = (c: string) => LANG_NAMES[c] ?? c.toUpperCase();

export default function FillIn() {
  useNewsBoot();
  const sel = useSelectedGfx();
  if (!sel) return <div className="pn" data-nr-panel="fill" onPointerDown={() => setFocus("other")}><Nothing /><FindReplaceHost /></div>;
  if (!sel.template) return <div className="pn-empty">This graphic's template isn't in the edit. Replace it from its right-click menu.</div>;
  return <Form key={sel.clip.id} clip={sel.clip} seqId={sel.seq.id} template={sel.template} />;
}

/** No graphic selected or under the playhead. */
function Nothing() {
  return (
    <div className="pn-empty">
      <div className="w-full max-w-[280px] space-y-2">
        <p>Select a graphic on the timeline (or put the playhead on one) to fill it in.</p>
        <p className="text-2xs text-dim">Add one from the Graphics panel, or with a quick key: Alt+N name strap, Alt+T ticker, Alt+B breaking bar, Alt+L layout, Alt+S wipe.</p>
      </div>
    </div>
  );
}

// ── the form ─────────────────────────────────────────────────────────────────

/** A change of one graphic (in the main values or a language's). */
const setValues = (clipId: string, lang: string | null, vals: Record<string, GfxValue>) => (base: EditProject) =>
  updateGraphic(base, clipId, (g) => (lang ? { ...g, langs: { ...(g.langs ?? {}), [lang]: { ...(g.langs?.[lang] ?? {}), ...vals } } } : { ...g, values: { ...g.values, ...vals } }));
const applyDoc = (label: string, fn: (p: EditProject) => EditProject) => host().apply(label, (d) => { const n = fn(d); if (n !== d) d.sequences = n.sequences; });

function Form({ clip, seqId, template: t }: { clip: GraphicClip; seqId: string; template: GfxTemplate }) {
  const p = useProject();
  const nr = useNewsroomDoc();
  const urls = useEditor((x) => x.urls);
  const seq = p.sequences.find((s) => s.id === seqId)!;
  const g = clip.source.gfx;
  const langs = nr?.langs?.length ? nr.langs : ["en"];
  const [lang, setLang] = useState<string>(langs[0]);
  const main = lang === langs[0];
  const L = main ? null : lang;
  const ratio: GfxRatio = ratioOf(seq.width, seq.height);
  const input = useMemo(() => clipInput(p, seq, clip, urlFor, L ?? undefined), [p, seq, clip, L, urls]); // eslint-disable-line react-hooks/exhaustive-deps
  const people = nr?.people ?? [], places = nr?.places ?? [], stories = nr?.rundown ?? [];
  const keyOf = (f: GfxField) => `gfx:${clip.id}:${lang}:${f.id}`;
  const texty = (f: GfxField) => f.type === "text" || f.type === "longtext" || f.type === "list";
  // a language version shows its own words (empty = the main version's, shown as the placeholder)
  const val = (f: GfxField) => (!L ? g.values[f.id] ?? f.default : texty(f) ? g.langs?.[L]?.[f.id] ?? (f.type === "list" ? [] : "") : valueIn(g, f, L));
  const placeholder = (f: GfxField) => { const v = L ? g.values[f.id] ?? f.default : f.default; return f.type === "list" ? (L ? itemsText(v) : "") : typeof v === "string" ? v : ""; };
  const set = (label: string, vals: Record<string, GfxValue>) => applyDoc(label, setValues(clip.id, L, vals));

  const sources = new Set(t.fields.map((f) => fillKey(f)?.split(".")[0]).filter(Boolean));
  const fillFrom = (label: string, vals: Record<string, GfxValue>) => {
    if (!Object.keys(vals).length) { toast.message("This graphic has no blanks for that"); return; }
    set(label, vals);
  };

  return (
    <div className="pn" data-nr-panel="fill" onPointerDown={() => setFocus("other")}>
      <Header clip={clip} t={t} lang={L} />
      <div className="pn-scroll">
        <div className="p-2"><GfxPreview input={input} ratio={ratio === "9:16" ? "9:16" : "16:9"} zoom={t.role === "strap" || t.role === "bug" || t.role === "ticker"} width={480} /></div>
        {(langs.length > 1 || nr) && <LangTabs langs={langs} lang={lang} setLang={setLang} clip={clip} t={t} />}
        {(sources.has("person") || sources.has("place") || sources.has("story")) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
            <span className="text-2xs text-dim">Fill from</span>
            {sources.has("person") && <PersonPicker people={people} lang={L ?? undefined} onPick={(x) => fillFrom(`Fill in ${x.name}`, valuesFromPerson(t, x, L ?? undefined))} />}
            {(sources.has("place") || sources.has("person")) && places.length > 0 && <PlacePicker places={places} lang={L ?? undefined} onPick={(x) => fillFrom(`Fill in ${x.name}`, valuesFromPlace(t, x, L ?? undefined))} />}
            {sources.has("story") && <StoryPicker stories={stories} onPick={(x) => fillFrom(`Fill in ${x.slug}`, valuesFromStory(t, x, people, L ?? undefined))} />}
          </div>
        )}
        {!t.fields.length && <p className="px-3 pb-2 text-xs text-dim">This graphic has nothing to fill in.</p>}
        {groupFields(t.fields).map(({ group, fields }) => (
          <div key={group ?? "_"} className="pb-1">
            {group && <div className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-dim">{group}</div>}
            {fields.map((f) => (
              <FieldRow key={f.id} f={f} hint={lengthHint(f, val(f))} lang={L}>
                <FieldInput f={f} value={val(f)} placeholder={placeholder(f)} liveKey={keyOf(f)} clipId={clip.id} lang={L} set={set} media={p.media} lookOf={() => resolveLook(p, g.look)} />
              </FieldRow>
            ))}
          </div>
        ))}
        <Settings clip={clip} seqId={seqId} t={t} />
      </div>
      <FindReplaceHost />
    </div>
  );
}

function Header({ clip, t, lang }: { clip: GraphicClip; t: GfxTemplate; lang: string | null }) {
  const p = useProject();
  const library = useLibraryTemplates();
  const g = clip.source.gfx;
  const replaceWith = (x: GfxTemplate) => host().apply(`Replace with ${x.name}`, (d) => {
    copyTemplateIn(d, x);
    replaceGraphicTemplate(d, clip.id, x.id);
  });
  const more = (e: React.MouseEvent<HTMLElement>) => {
    const same = allTemplates(p, library).filter((x) => x.category === t.category && x.id !== t.id);
    const items: MenuItem[] = [
      { label: "Replace template", items: same.length ? same.map((x) => ({ label: x.name, hint: x.kind, onClick: () => replaceWith(x) })) : [{ label: "No other templates of this kind", disabled: true }] },
      { label: "Edit template…", hint: "every graphic using it", onClick: () => openDesigner({ template: t, onSaved: (x) => toast.success(`Saved “${x.name}”`) }) },
      { label: "Change only this one…", onClick: () => openDesigner({ template: t, clipId: clip.id, onSaved: () => toast.success("This graphic was changed") }) },
      { label: "Add to playlist", separator: true, onClick: () => addToPlaylist(t, g.values) },
      { label: "Find and replace in graphics…", onClick: openFindReplace },
      { label: "Go to its start", separator: true, onClick: () => program.seek(clip.start) },
    ];
    openMenu(e.currentTarget.getBoundingClientRect(), items);
  };
  return (
    <div className="ed-bar gap-1.5">
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-xs font-medium">{t.name}{lang ? <span className="ml-1 text-2xs text-accent-ink">· {langName(lang)}</span> : null}</p>
        <p className="truncate text-[10px] text-dim">{t.category}{g.overrides && Object.keys(g.overrides).length ? " · changed for this one" : ""}</p>
      </div>
      <IBtn title="More" onClick={more}><MoreHorizontal className="size-4" /></IBtn>
    </div>
  );
}

function LangTabs({ langs, lang, setLang, clip, t }: { langs: string[]; lang: string; setLang: (l: string) => void; clip: GraphicClip; t: GfxTemplate }) {
  const add = (e: React.MouseEvent<HTMLElement>) => openMenu(e.currentTarget.getBoundingClientRect(),
    Object.entries(LANG_NAMES).filter(([c]) => !langs.includes(c)).map(([c, n]) => ({ label: n, hint: c, onClick: () => {
      host().apply(`Add language ${n}`, (d) => { if (d.newsroom) d.newsroom.langs = [...(d.newsroom.langs?.length ? d.newsroom.langs : ["en"]), c]; });
      setLang(c);
    } })));
  const filled = (l: string) => t.fields.some((f) => { const v = clip.source.gfx.langs?.[l]?.[f.id]; return v !== undefined && v !== null && v !== ""; });
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
      <Languages className="size-3.5 text-dim" />
      {langs.map((l, i) => (
        <button key={l} type="button" onClick={() => setLang(l)} title={i === 0 ? "The main version" : filled(l) ? `${langName(l)} version` : `${langName(l)}: empty blanks show the main version`}
          className={clsx("rounded-md px-1.5 py-0.5 text-2xs", lang === l ? "bg-accent/20 text-accent-ink" : "text-mute hover:bg-hover", i > 0 && !filled(l) && lang !== l && "opacity-60")}>
          {langName(l)}
        </button>
      ))}
      <button type="button" onClick={add} title="Add a language version" className="grid size-5 place-items-center rounded-md text-dim hover:bg-hover hover:text-ink"><Plus className="size-3" /></button>
    </div>
  );
}

function FieldRow({ f, hint, lang, children }: { f: GfxField; hint: { text: string; over: boolean } | null; lang: string | null; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-3 py-1">
      <div className="flex items-baseline gap-2 text-2xs">
        <span className="font-medium text-mute">{f.label}{f.required ? <span className="text-accent-ink"> *</span> : null}</span>
        {f.hint && <span className="min-w-0 flex-1 truncate text-dim" title={f.hint}>{f.hint}</span>}
        {!f.hint && <span className="flex-1" />}
        {hint && <span className={clsx("mono shrink-0", hint.over ? "text-amber-300" : "text-dim")} title={hint.over ? "Longer than the design expects: it will shrink to fit" : undefined}>{hint.text}</span>}
        {lang && <span className="shrink-0 text-dim">{lang.toUpperCase()}</span>}
      </div>
      {children}
    </div>
  );
}

const TOKENS: LookColor[] = ["primary", "secondary", "accent", "breaking", "live", "dark", "light", "up", "down"];

function FieldInput({ f, value, placeholder, liveKey, clipId, lang, set, media, lookOf }: {
  f: GfxField; value: GfxValue; placeholder?: string; liveKey: string; clipId: string; lang: string | null;
  set: (label: string, vals: Record<string, GfxValue>) => void; media: EditProject["media"]; lookOf: () => ReturnType<typeof resolveLook>;
}) {
  const make = (v: GfxValue) => (base: EditProject) => setValues(clipId, lang, { [f.id]: v })(base);
  const label = `Fill in ${f.label}`;
  switch (f.type) {
    case "text": case "datetime":
      if (f.type === "datetime") return <input type="datetime-local" className="ed-field w-full" value={typeof value === "string" ? value.slice(0, 16) : ""} onChange={(e) => set(label, { [f.id]: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />;
      return <LiveText value={typeof value === "string" ? value : String(value ?? "")} liveKey={liveKey} label={label} make={(b, v) => make(v)(b)} placeholder={placeholder} />;
    case "longtext":
      return <LiveText multiline rows={Math.min(6, Math.max(2, (typeof value === "string" ? value.split("\n").length : 1) + 1))} value={typeof value === "string" ? value : ""} liveKey={liveKey} label={label} make={(b, v) => make(v)(b)} placeholder={placeholder} />;
    case "list":
      return <ListField f={f} value={value} liveKey={liveKey} label={label} make={make} placeholder={placeholder} />;
    case "table":
      return <TableField f={f} value={Array.isArray(value) ? (value as GfxTableRow[]) : []} liveKey={liveKey} label={label} make={make} set={set} />;
    case "number": {
      const n = typeof value === "number" ? value : parseNumber(String(value ?? "")) ?? 0;
      let shown = "";
      try { shown = fmtNumber(n, lookOf(), f.format ?? {}); } catch { shown = ""; }
      return (
        <div className="flex items-center gap-2">
          <LiveText value={String(n)} liveKey={liveKey} label={label} make={(b, v) => make(parseNumber(v) ?? 0)(b)} className="w-32" />
          {shown && <span className="mono truncate text-2xs text-dim" title="As the graphic writes it">{shown}</span>}
        </div>
      );
    }
    case "toggle":
      return <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={value === true} onChange={(e) => set(label, { [f.id]: e.target.checked })} />{value === true ? "On" : "Off"}</label>;
    case "choice":
      return (
        <select className="ed-field w-full" value={typeof value === "string" ? value : ""} onChange={(e) => set(label, { [f.id]: e.target.value })}>
          {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case "color": {
      const look = lookOf();
      const v = typeof value === "string" ? value : "";
      const hex = v.startsWith("@") ? look.colors[v.slice(1).split("/")[0] as LookColor] ?? "#888888" : v || "#888888";
      return (
        <div className="flex flex-wrap items-center gap-1">
          {TOKENS.map((k) => (
            <button key={k} type="button" title={`${k} (the look's)`} onClick={() => set(label, { [f.id]: `@${k}` })}
              className={clsx("size-5 rounded border", v === `@${k}` ? "border-white ring-2 ring-accent/60" : "border-line")} style={{ background: look.colors[k] }} />
          ))}
          <label className="ml-1 flex items-center gap-1 text-2xs text-dim" title="Your own colour">
            <input type="color" value={/^#[0-9a-f]{6}/i.test(hex) ? hex.slice(0, 7) : "#888888"} onChange={(e) => set(label, { [f.id]: e.target.value })} className="h-5 w-7 cursor-pointer rounded border border-line bg-transparent" />
            {v.startsWith("@") ? "Custom" : v}
          </label>
        </div>
      );
    }
    case "image":
      return <ImagePicker media={media} value={value && typeof value === "object" && !Array.isArray(value) ? (value as GfxImageRef) : null} onChange={(v) => set(v ? `Picture for ${f.label}` : `Remove ${f.label}`, { [f.id]: v })} />;
    default:
      return <p className="text-2xs text-dim">This blank ({f.type}) is filled in by its own panel.</p>;
  }
}

/**
 * List blanks (tickers, key points, headlines): nr-tickers' item editor (text, tag, value, change, priority, reorder,
 * paste lines). Every change shows at once; one focus of the list is one undo step.
 */
function ListField({ f, value, liveKey, label, make, placeholder }: { f: GfxField; value: GfxValue; liveKey: string; label: string; make: (v: GfxValue) => (b: EditProject) => EditProject; placeholder?: string }) {
  const items = Array.isArray(value) ? (value as unknown[]).map((x) => (typeof x === "string" ? { text: x } : (x as GfxListItem))) : [];
  return (
    <div className="grid gap-0.5" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) liveDone(liveKey); }}>
      <TickerItemsEditor field={f} value={items} onChange={(v) => liveEdit(label, liveKey, (b) => make(v)(b))} />
      {!items.length && placeholder && <span className="truncate text-[10px] text-dim" title={placeholder}>Empty: the main version's lines show ({placeholder.split(/\r?\n/)[0]}…)</span>}
    </div>
  );
}

/** Table blanks: a compact grid, add / remove rows, paste from a spreadsheet. */
function TableField({ f, value, liveKey, label, make, set }: { f: GfxField; value: GfxTableRow[]; liveKey: string; label: string;
  make: (v: GfxValue) => (b: EditProject) => EditProject; set: (label: string, vals: Record<string, GfxValue>) => void }) {
  const cols = f.columns ?? [];
  const [paste, setPaste] = useState<string | null>(null);
  const cellChange = (r: number, c: string, num: boolean) => (b: EditProject, v: string) => make(value.map((row, i) => (i === r ? { ...row, [c]: num ? parseNumber(v) ?? v : v } : row)))(b);
  return (
    <div className="grid gap-1">
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full border-collapse text-2xs">
          <thead><tr>{cols.map((c) => <th key={c.id} className="border-b border-line px-1 py-0.5 text-left font-medium text-dim">{c.label}</th>)}<th className="w-6 border-b border-line" /></tr></thead>
          <tbody>
            {value.map((row, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c.id} className="p-0.5">
                    <LiveText value={String(row[c.id] ?? "")} liveKey={`${liveKey}:${i}:${c.id}`} label={label} make={cellChange(i, c.id, c.type === "number")} className={clsx("!h-6 min-w-[4rem] !px-1 text-2xs", c.type === "number" && "text-right")} />
                  </td>
                ))}
                <td className="p-0.5"><button type="button" title="Remove row" className="grid size-5 place-items-center rounded text-dim hover:bg-hover hover:text-red-300" onClick={() => set(`Remove row ${i + 1}`, { [f.id]: value.filter((_, j) => j !== i) })}><Trash2 className="size-3" /></button></td>
              </tr>
            ))}
            {!value.length && <tr><td colSpan={cols.length + 1} className="px-2 py-1.5 text-dim">No rows yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" icon={<Plus className="size-3" />} onClick={() => set("Add row", { [f.id]: [...value, Object.fromEntries(cols.map((c) => [c.id, c.type === "number" ? 0 : ""]))] })} disabled={!!f.maxItems && value.length >= f.maxItems}>Row</Button>
        <Button size="sm" variant="ghost" onClick={() => setPaste("")}>Paste from a spreadsheet…</Button>
      </div>
      <Modal open={paste !== null} onClose={() => setPaste(null)} title={`Paste ${f.label}`} size="md"
        footer={<><Button variant="ghost" onClick={() => setPaste(null)}>Cancel</Button><Button variant="primary" disabled={!paste?.trim()} onClick={() => {
          const rows = tableFromText(paste ?? "", f);
          if (!rows.length) { toast.error("No rows found"); return; }
          set(`Paste ${f.label}`, { [f.id]: f.maxItems ? rows.slice(0, f.maxItems) : rows });
          setPaste(null);
        }}>Use these rows</Button></>}>
        <p className="mb-2 text-xs text-mute">Copy the cells in Excel or Google Sheets and paste them here. Columns in order: {cols.map((c) => c.label).join(", ")}. A header row is skipped.</p>
        <Textarea data-autofocus rows={8} className="mono text-xs" value={paste ?? ""} onChange={(e) => setPaste(e.target.value)} />
      </Modal>
    </div>
  );
}

// ── look, length, ratios, layout boxes ───────────────────────────────────────

function Settings({ clip, seqId, t }: { clip: GraphicClip; seqId: string; t: GfxTemplate }) {
  const p = useProject();
  const nr = p.newsroom;
  const seq = p.sequences.find((s) => s.id === seqId)!;
  const g = clip.source.gfx;
  const secs = framesToSeconds(clip.duration, seq.fps);
  const looks = [...BUILTIN_LOOKS, ...Object.values(nr?.looks ?? {}).filter((l) => !BUILTIN_LOOKS.some((b) => b.id === l.id))];
  const editLook = resolveLook(p);
  const setGfx = (label: string, fn: (g: GfxInstance) => GfxInstance) => applyDoc(label, (b) => updateGraphic(b, clip.id, fn));
  const setLen = (label: string, frames: number) => host().apply(label, (d) => { setClipLength(d, clip.id, frames); });
  const next = untilNext(seq, clip.id);
  const end = contentEnd(seq);
  const ratios = g.ratios?.length === 1 ? g.ratios[0] : "both";
  return (
    <div className="mt-1 border-t border-line px-3 py-2">
      <div className="grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-2 text-2xs">
        <span className="text-mute">Look</span>
        <select className="ed-field w-full" value={g.look ?? ""} onChange={(e) => setGfx("Graphic look", (x) => { const n = { ...x }; if (e.target.value) n.look = e.target.value; else delete n.look; return n; })}>
          <option value="">The edit's look ({editLook.name})</option>
          {looks.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <span className="text-mute">Length</span>
        <div className="flex flex-wrap items-center gap-1">
          <input type="number" min={0.2} step={0.5} className="ed-field w-16" key={clip.duration} defaultValue={Math.round(secs * 10) / 10}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && Math.abs(v - secs) > 0.01) setLen("Graphic length", secondsToFrames(v, seq.fps)); }} />
          <span className="text-dim">s</span>
          <button type="button" className="rounded-md px-1.5 py-0.5 text-mute hover:bg-hover hover:text-ink" title="Long enough to read its words"
            onClick={() => setLen("Length: auto", secondsToFrames(autoHold(t, g.values, nr?.settings?.readSpeed ?? 3), seq.fps))}>Auto</button>
          <button type="button" disabled={next === null} className="rounded-md px-1.5 py-0.5 text-mute hover:bg-hover hover:text-ink disabled:opacity-40" title="Until the next graphic on its track"
            onClick={() => next !== null && setLen("Length: until next", next)}>Until next</button>
          <button type="button" disabled={end <= clip.start} className="rounded-md px-1.5 py-0.5 text-mute hover:bg-hover hover:text-ink disabled:opacity-40" title="To the end of the pictures"
            onClick={() => setLen("Length: to the end", end - clip.start)}>To the end</button>
        </div>
        <span className="text-mute">Starts</span>
        <button type="button" className="mono justify-self-start rounded px-1 text-left text-dim hover:bg-hover hover:text-ink" title="Go there" onClick={() => program.seek(clip.start)}>{toTimecode(clip.start, seq.fps)}</button>
        {nr?.ratio === "both" && (
          <>
            <span className="text-mute">Shows in</span>
            <Segmented size="sm" value={ratios} onChange={(v) => setGfx("Graphic ratios", (x) => { const n = { ...x }; if (v === "both") delete n.ratios; else n.ratios = [v as GfxRatio]; return n; })}
              options={[{ value: "both", label: "Both" }, { value: "16:9", label: "16:9 only" }, { value: "9:16", label: "9:16 only" }]} />
          </>
        )}
      </div>
      {isLayout(t) && <LayoutBoxes clip={clip} />}
    </div>
  );
}

/** Screen layouts: which picture goes in which box (nr-layouts' SlotAssigner). */
function LayoutBoxes({ clip }: { clip: GraphicClip }) {
  return (
    <div className="-mx-3 mt-3 border-t border-line pt-2">
      <p className="mb-1 px-3 text-2xs font-semibold uppercase tracking-wide text-dim">Boxes</p>
      <SlotAssigner clipId={clip.id} />
    </div>
  );
}
