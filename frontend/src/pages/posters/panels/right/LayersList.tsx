/**
 * The layers list: top of the stack first. Click selects (Ctrl/⌘ toggles, Shift selects a range), hover highlights on
 * the canvas, double-click renames, drag reorders. Keyboard: ↑/↓ move the selection (Shift extends), Ctrl/⌘+↑/↓ move
 * the layer, Enter or F2 renames, Delete removes.
 */
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, GripVertical, ImageIcon, Layers, Loader2, Lock, LockOpen, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "../../../../lib/cn";
import { useT } from "../../../../lib/i18n";
import { useEditor } from "../../store";
import type { Layer } from "../../types";
import { CHECKER, paintCss } from "./color";
import { LayerGlyph, roleLabels } from "./shared";

const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function Thumb({ layer }: { layer: Layer }) {
  const box = "relative grid size-7 shrink-0 place-items-center overflow-hidden rounded-md ring-1 ring-inset ring-line";
  if (layer.type === "image") {
    return layer.src
      ? <span className={box} style={CHECKER}><img src={layer.src} alt="" draggable={false} className="size-full object-cover" /></span>
      : <span className={cn(box, "border border-dashed border-dim/50 ring-0")}><ImageIcon className={cn("size-3.5", layer.ai || layer.pending ? "text-ai" : "text-dim")} /></span>;
  }
  if (layer.type === "shape" && layer.fill) {
    const round = layer.shape === "ellipse" || layer.shape === "ring";
    return (
      <span className={cn(box, "bg-raised")}>
        <span className="size-4 ring-1 ring-inset ring-line" style={{ ...CHECKER, borderRadius: round ? "50%" : 3 }}>
          <span className="block size-full" style={{ background: paintCss(layer.fill), borderRadius: round ? "50%" : 3 }} />
        </span>
      </span>
    );
  }
  return <span className={cn(box, "bg-raised")}><LayerGlyph layer={layer} /></span>;
}

function LayerRow({ layer, selected, hovered, renaming, onRowClick, onRename, onRenameDone }: {
  layer: Layer; selected: boolean; hovered: boolean; renaming: boolean;
  onRowClick: (e: MouseEvent, id: string) => void; onRename: (id: string) => void; onRenameDone: (name: string | null) => void;
}) {
  const t = useT();
  const { patchLayer, setHover } = useEditor(useShallow((s) => ({ patchLayer: s.patchLayer, setHover: s.setHover })));
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: layer.id });
  const [draft, setDraft] = useState(layer.name);
  const done = useRef(false);
  useEffect(() => { if (renaming) { setDraft(layer.name); done.current = false; } }, [renaming, layer.name]);
  // Enter/Esc and the blur that follows them must finish the rename once
  const finish = (name: string | null) => { if (done.current) return; done.current = true; onRenameDone(name); };
  const role = layer.role ? roleLabels(t)[layer.role] : "";
  const pending = layer.type === "image" && !!layer.pending;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div
      ref={setNodeRef}
      id={`poster-layer-${layer.id}`}
      role="option"
      aria-selected={selected}
      data-layer-row={layer.id}
      {...listeners}
      onClick={(e) => onRowClick(e, layer.id)}
      onDoubleClick={() => onRename(layer.id)}
      onMouseEnter={() => setHover(layer.id)}
      onMouseLeave={() => setHover(null)}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group relative flex h-10 cursor-default select-none items-center gap-2 rounded-md pl-1 pr-1 transition-colors",
        selected ? "bg-accent/12 text-ink ring-1 ring-inset ring-accent/35" : hovered ? "bg-hover/70" : "hover:bg-hover/70",
        isDragging && "z-10 bg-raised shadow-pop ring-1 ring-accent/50",
      )}
    >
      <GripVertical className="size-3.5 shrink-0 cursor-grab text-dim opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing" aria-hidden />
      <span className={cn("contents", !layer.visible && "[&>*]:opacity-45")}>
        <Thumb layer={layer} />
      </span>
      <div className={cn("min-w-0 flex-1", !layer.visible && "opacity-50")}>
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPointerDown={stop}
            onClick={stop}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") finish(draft);
              if (e.key === "Escape") finish(null);
            }}
            onBlur={() => finish(draft)}
            onFocus={(e) => e.target.select()}
            maxLength={120}
            aria-label={t("Layer name")}
            className="h-6 w-full rounded border border-accent/60 bg-panel px-1.5 text-xs text-ink outline-none ring-[3px] ring-accent/15"
          />
        ) : (
          <>
            <span className="block truncate text-xs font-medium leading-tight">{layer.name || t("Untitled layer")}</span>
            {role && <span className="mono block truncate text-[10px] uppercase leading-tight tracking-wider text-dim">{role}{layer.type === "image" && layer.ai ? ` · ${t("AI")}` : ""}</span>}
          </>
        )}
      </div>
      {pending && <Loader2 className="size-3.5 shrink-0 animate-spin text-ai" aria-label={t("AI is painting")} />}
      {!pending && layer.type === "image" && layer.ai && !role && <Sparkles className="size-3 shrink-0 text-ai" aria-label={t("AI image")} />}
      <button type="button" onPointerDown={stop} onClick={(e) => { stop(e); patchLayer(layer.id, { visible: !layer.visible }); }}
        aria-label={layer.visible ? t("Hide") : t("Show")} title={layer.visible ? t("Hide") : t("Show")}
        className={cn("grid size-6 shrink-0 place-items-center rounded text-dim transition-[opacity,color] hover:bg-hover hover:text-ink",
          layer.visible ? "opacity-0 focus-visible:opacity-100 group-hover:opacity-100" : "text-mute opacity-100")}>
        {layer.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
      <button type="button" onPointerDown={stop} onClick={(e) => { stop(e); patchLayer(layer.id, { locked: !layer.locked }); }}
        aria-label={layer.locked ? t("Unlock") : t("Lock")} title={layer.locked ? t("Unlock") : t("Lock")}
        className={cn("grid size-6 shrink-0 place-items-center rounded transition-[opacity,color] hover:bg-hover hover:text-ink",
          layer.locked ? "text-warn opacity-100" : "text-dim opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}>
        {layer.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
      </button>
    </div>
  );
}

export function LayersList() {
  const t = useT();
  const { layers, selection, hover, select, reorder, order, patchLayer, removeLayers, selectAll } = useEditor(useShallow((s) => ({
    layers: s.doc.layers, selection: s.selection, hover: s.hover, select: s.select, reorder: s.reorder, order: s.order, patchLayer: s.patchLayer,
    removeLayers: s.removeLayers, selectAll: s.selectAll,
  })));
  const visual = [...layers].reverse();
  const n = layers.length;
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // keep the last selected row in view (selection often changes from the canvas)
  const last = selection[selection.length - 1];
  useEffect(() => {
    if (!last) return;
    listRef.current?.querySelector<HTMLElement>(`[data-layer-row="${globalThis.CSS.escape(last)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [last]);

  const rangeTo = (id: string) => {
    const a = visual.findIndex((l) => l.id === anchor.current), b = visual.findIndex((l) => l.id === id);
    if (a < 0 || b < 0) return [id];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return visual.slice(lo, hi + 1).map((l) => l.id);
  };
  const onRowClick = (e: MouseEvent, id: string) => {
    if (e.shiftKey && anchor.current) select(rangeTo(id), e.ctrlKey || e.metaKey ? "add" : "set");
    else if (e.ctrlKey || e.metaKey) { select([id], "toggle"); anchor.current = id; }
    else { select([id]); anchor.current = id; }
    listRef.current?.focus({ preventScroll: true });
  };
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = visual.findIndex((l) => l.id === active.id), to = visual.findIndex((l) => l.id === over.id);
    if (from < 0 || to < 0) return;
    // the list is drawn top-first; the document is bottom-first
    reorder(n - 1 - from, n - 1 - to);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (renaming || !visual.length) return;
    const mod = e.ctrlKey || e.metaKey;
    const cur = visual.findIndex((l) => l.id === last);
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === "ArrowUp" ? -1 : 1;
      if (mod && selection.length) { order(d < 0 ? "forward" : "backward"); return; }
      const next = visual[Math.max(0, Math.min(visual.length - 1, cur < 0 ? (d < 0 ? visual.length - 1 : 0) : cur + d))];
      if (!next) return;
      if (e.shiftKey) {
        if (!anchor.current) anchor.current = last ?? next.id;
        // keep the moving end last so the next step continues from it
        select([...rangeTo(next.id).filter((id) => id !== next.id), next.id]);
      } else {
        select([next.id]);
        anchor.current = next.id;
      }
    } else if ((e.key === "Enter" || e.key === "F2") && selection.length === 1) {
      e.preventDefault();
      e.stopPropagation();
      setRenaming(selection[0]);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selection.length) {
      e.preventDefault();
      e.stopPropagation();
      removeLayers();
    } else if (e.key === "Escape" && selection.length) {
      e.stopPropagation();
      select([]);
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      selectAll();
    }
  };
  const finishRename = (name: string | null) => {
    const id = renaming;
    setRenaming(null);
    if (id && name !== null) {
      const l = layers.find((x) => x.id === id);
      const v = name.trim();
      if (l && v && v !== l.name) patchLayer(id, { name: v });
    }
    listRef.current?.focus({ preventScroll: true });
  };

  if (!n) {
    return (
      <div className="flex flex-col items-center px-6 py-14 text-center">
        <span className="grid size-10 place-items-center rounded-xl border border-line bg-raised text-dim"><Layers className="size-5" /></span>
        <p className="mt-3 text-sm font-medium text-ink">{t("No layers yet")}</p>
        <p className="mt-1 text-xs leading-relaxed text-mute">{t("Add text, shapes, photos or an AI image from the left panel, or drop a picture on the page.")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable
        aria-label={t("Layers")}
        aria-activedescendant={last ? `poster-layer-${last}` : undefined}
        tabIndex={0}
        onKeyDown={onKey}
        onClick={(e) => { if (e.target === e.currentTarget) select([]); }}
        className="flex-1 space-y-px p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[vertical]} onDragEnd={onDragEnd}>
          <SortableContext items={visual.map((l) => l.id)} strategy={verticalListSortingStrategy}>
            {visual.map((l) => (
              <LayerRow key={l.id} layer={l} selected={selection.includes(l.id)} hovered={hover === l.id} renaming={renaming === l.id}
                onRowClick={onRowClick} onRename={setRenaming} onRenameDone={finishRename} />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-panel/95 px-3 py-1.5 text-2xs text-dim backdrop-blur">
        <span className="mono">{t("{n} layers", { n })}</span>
        <span className="truncate">· {t("drag to reorder, Shift-click for a range")}</span>
      </div>
    </div>
  );
}
