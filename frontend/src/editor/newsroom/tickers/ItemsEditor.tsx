/**
 * The ticker item editor (docs/EDITOR.md §16.8): the Fill in panel embeds it for list fields. One compact row per
 * item: its text, and the tag, value, change, icon and colour when the list uses them; a priority switch (the item
 * flashes); drag the grip (or Alt+↑ / ↓ on it) to reorder; Enter adds a line after, Backspace on an empty line
 * removes it. "Paste lines" takes one item per line (columns from a spreadsheet or "tag | text | value | change").
 * The header shows the count and about how long one loop of the crawl takes.
 */
import { clsx } from "clsx";
import { ClipboardPaste, GripVertical, Plus, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Button, Textarea } from "../../../components/ui";
import { IBtn } from "../../ui";
import { iconList } from "../render/icons";
import type { GfxField, GfxListItem } from "../types";
import { columnsFor, loopText, moveItem, parseLines, parseNumberLoose, type ItemColumns } from "./lines";

const COLUMN_LABELS: [keyof ItemColumns, string, string][] = [
  ["tag", "Tag", "A tag or category before the item (a handle, a city)"],
  ["value", "Value", "A number shown after the text (a price, a score, a temperature)"],
  ["delta", "Change", "The change since last time (▲ green / ▼ red)"],
  ["icon", "Icon", "An icon before the text (weather)"],
  ["color", "Colour", "The item's own colour (a party, a category)"],
];

/** The item without empty details, so the saved list stays tidy. */
function tidy(it: GfxListItem): GfxListItem {
  const out: GfxListItem = { text: it.text ?? "" };
  if (it.tag?.trim()) out.tag = it.tag;
  if (it.flash) out.flash = true;
  if (it.icon) out.icon = it.icon;
  if (typeof it.value === "number" && Number.isFinite(it.value)) out.value = it.value;
  if (typeof it.delta === "number" && Number.isFinite(it.delta)) out.delta = it.delta;
  if (it.color) out.color = it.color;
  return out;
}

/** A number cell that keeps what's being typed ("12.", "-") until it reads as a number. */
function NumCell({ value, onChange, label, width }: { value: number | undefined; onChange: (v: number | undefined) => void; label: string; width: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? "" : String(value));
  return (
    <input
      className={clsx("ed-field ed-tc text-right", width)} inputMode="decimal" aria-label={label} title={label} placeholder={label === "Change" ? "±" : "—"}
      value={shown}
      onFocus={() => setDraft(value === undefined ? "" : String(value))}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value);
        const t = e.target.value.trim();
        if (!t) onChange(undefined);
        else { const n = parseNumberLoose(t); if (n !== undefined) onChange(n); }
      }}
    />
  );
}

export function TickerItemsEditor({ value, onChange, field }: { value: GfxListItem[]; onChange(v: GfxListItem[]): void; field: GfxField }) {
  const items = useMemo(() => (Array.isArray(value) ? value : []).map((x) => (typeof x === "string" ? { text: x } : x)), [value]);
  const [cols, setCols] = useState<ItemColumns>(() => columnsFor(value, field.default));
  const [paste, setPaste] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const focusNext = useRef<number | null>(null);
  const max = field.maxItems ?? 0;
  const full = max > 0 && items.length >= max;
  const icons = useMemo(() => iconList(), []);

  // a list that gains details (another source filled it) shows their columns
  useEffect(() => {
    const c = columnsFor(value);
    setCols((x) => ({ tag: x.tag || c.tag, value: x.value || c.value, delta: x.delta || c.delta, icon: x.icon || c.icon, color: x.color || c.color }));
  }, [value]);
  useEffect(() => {
    if (focusNext.current === null) return;
    inputs.current.get(focusNext.current)?.focus();
    focusNext.current = null;
  });

  const commit = (next: GfxListItem[]) => onChange(next.map(tidy));
  const set = (i: number, patch: Partial<GfxListItem>) => commit(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const add = (at = items.length) => {
    if (full) return;
    const next = items.slice();
    next.splice(at, 0, { text: "" });
    focusNext.current = at;
    commit(next);
  };
  const remove = (i: number) => { focusNext.current = Math.max(0, i - 1); commit(items.filter((_, j) => j !== i)); };
  const move = (from: number, to: number) => { if (to >= 0 && to < items.length) { focusNext.current = null; commit(moveItem(items, from, to)); } };
  const applyPaste = (mode: "add" | "replace") => {
    const got = parseLines(paste ?? "", cols);
    const next = mode === "replace" ? got : [...items, ...got];
    commit(max > 0 ? next.slice(0, max) : next);
    setPaste(null);
  };

  const onTextKey = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); add(i + 1); }
    else if (e.key === "Backspace" && !items[i].text && items.length > 1) { e.preventDefault(); remove(i); }
    else if (e.key === "ArrowDown" && !e.altKey) inputs.current.get(i + 1)?.focus();
    else if (e.key === "ArrowUp" && !e.altKey) inputs.current.get(i - 1)?.focus();
  };
  const onGripKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(i, i + (e.key === "ArrowUp" ? -1 : 1)); }
  };
  const overRow = (i: number) => (e: DragEvent<HTMLDivElement>) => {
    if (!drag) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const over = e.clientY > r.top + r.height / 2 ? i + 1 : i;
    if (over !== drag.over) setDrag({ ...drag, over });
  };
  const drop = () => {
    if (drag) move(drag.from, drag.over > drag.from ? drag.over - 1 : drag.over);
    setDrag(null);
  };
  const flashing = items.filter((i) => i.flash).length;
  const details = cols.tag || cols.icon || cols.value || cols.delta || cols.color;

  return (
    <div className="grid gap-1.5" onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-2xs text-dim">
          {items.length} {items.length === 1 ? "item" : "items"}{max ? ` of ${max}` : ""}
          {items.length ? ` · ${loopText(items)} a loop` : ""}{flashing ? ` · ${flashing} priority` : ""}
        </span>
        <Button size="sm" variant="ghost" icon={<ClipboardPaste className="size-3.5" />} onClick={() => setPaste(paste === null ? "" : null)}>Paste lines</Button>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={full} onClick={() => add()}>Add</Button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-2xs text-dim">Details</span>
        <div className="ed-seg shrink-0" role="group" aria-label="Details shown">
          {COLUMN_LABELS.map(([k, label, tip]) => (
            <button key={k} type="button" title={tip} aria-pressed={cols[k]} onClick={() => setCols({ ...cols, [k]: !cols[k] })}>{label}</button>
          ))}
        </div>
      </div>

      {paste !== null && (
        <div className="grid gap-1.5 rounded-md border border-line bg-raised/50 p-2">
          <Textarea autoFocus rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} className="text-xs"
            placeholder={cols.tag ? "Sports | India beat Malaysia 4–1\n!Heavy rain shuts Andheri subway" : "One item per line\n!Start a line with ! to make it flash"} />
          <p className="text-2xs text-dim">
            One item per line. Start a line with ! to make it flash. Columns pasted from a spreadsheet (or split by " | ") fill
            {cols.tag ? " the tag, the text," : " the text,"} the value and the change.
          </p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setPaste(null)}>Cancel</Button>
            <Button size="sm" variant="secondary" disabled={!paste.trim()} onClick={() => applyPaste("replace")}>Replace all</Button>
            <Button size="sm" variant="primary" disabled={!paste.trim()} onClick={() => applyPaste("add")}>Add to the end</Button>
          </div>
        </div>
      )}

      {items.length === 0 && paste === null && (
        <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-2xs text-dim">
          No lines yet. Add one, or paste a list.
        </div>
      )}

      {items.length > 0 && (
        <div className="grid" onDragOver={(e) => drag && e.preventDefault()} onDrop={drop}>
          {items.map((it, i) => (
            <div
              key={i}
              onDragOver={overRow(i)}
              className={clsx("relative flex min-h-7 flex-wrap items-center gap-x-1 rounded-md px-0.5", details && "border-b border-line/50", it.flash && "bg-bad/8",
                drag?.over === i && "before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded before:bg-accent",
                drag?.over === i + 1 && i === items.length - 1 && "after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded after:bg-accent",
                drag?.from === i && "opacity-50")}
            >
              <button
                type="button" draggable aria-label={`Move item ${i + 1} (drag, or Alt+arrow keys)`} title="Drag to reorder"
                className="ed-ibtn h-6 w-4 cursor-grab text-dim active:cursor-grabbing"
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                  const row = e.currentTarget.parentElement;
                  if (row) e.dataTransfer.setDragImage(row, 12, 14);
                  setDrag({ from: i, over: i });
                }}
                onDragEnd={() => setDrag(null)}
                onKeyDown={onGripKey(i)}
              >
                <GripVertical className="size-3.5" />
              </button>
              <span className="ed-tc w-5 shrink-0 text-right text-[10px] text-dim">{i + 1}</span>
              <input
                ref={(el) => { if (el) inputs.current.set(i, el); else inputs.current.delete(i); }}
                className="ed-field min-w-0 flex-1" aria-label={`Item ${i + 1}`} placeholder="Type the line"
                value={it.text} onChange={(e) => set(i, { text: e.target.value })} onKeyDown={onTextKey(i)}
              />
              <IBtn title={it.flash ? "Priority: flashes (click to stop)" : "Make it a priority item (flashes)"} on={!!it.flash}
                className={clsx("size-6", it.flash ? "text-bad" : "text-dim")} onClick={() => set(i, { flash: !it.flash })}>
                <Zap className="size-3.5" fill={it.flash ? "currentColor" : "none"} />
              </IBtn>
              <IBtn title="Remove" className="size-6 text-dim" onClick={() => remove(i)}><X className="size-3.5" /></IBtn>
              {details && (
                <div className="flex basis-full flex-wrap items-center gap-1 pb-1 pl-10 pr-14">
                  {cols.tag && <input className="ed-field w-28 min-w-0" aria-label="Tag" placeholder="Tag" value={it.tag ?? ""} onChange={(e) => set(i, { tag: e.target.value })} />}
                  {cols.icon && (
                    <select className="ed-field w-28" aria-label="Icon" value={it.icon ?? ""} onChange={(e) => set(i, { icon: e.target.value || undefined })}>
                      <option value="">No icon</option>
                      {icons.map(([id, d]) => <option key={id} value={id}>{d.label}</option>)}
                    </select>
                  )}
                  {cols.value && <NumCell label="Value" width="w-24" value={it.value} onChange={(v) => set(i, { value: v })} />}
                  {cols.delta && <NumCell label="Change" width="w-16" value={it.delta} onChange={(v) => set(i, { delta: v })} />}
                  {cols.color && (
                    <input type="color" aria-label="Colour" title="Colour" className="h-5 w-7 cursor-pointer rounded border border-line bg-transparent"
                      value={(it.color ?? "#8a94a6").slice(0, 7)} onChange={(e) => set(i, { color: e.target.value })} />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {field.hint && <p className="text-[10px] text-dim">{field.hint}</p>}
    </div>
  );
}

export default TickerItemsEditor;
