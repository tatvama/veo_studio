import { Check, ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { IconButton, Skeleton, rise } from "../ui";
import { useDialogFocus } from "./util";
import "../../styles/room.css";

export interface GalleryItem {
  id: number; url: string; label: string; sub?: string; approved?: boolean; badge?: ReactNode;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Full-screen image viewer: arrow keys / buttons to move, Esc to close, thumbnails along the bottom. */
export function Lightbox({ items, index, onIndex, onClose, actions }: {
  items: GalleryItem[]; index: number | null; onIndex: (i: number) => void; onClose: () => void; actions?: (item: GalleryItem) => ReactNode;
}) {
  return createPortal(
    <AnimatePresence>
      {index !== null && items[index] && <Viewer key="viewer" items={items} index={index} onIndex={onIndex} onClose={onClose} actions={actions} />}
    </AnimatePresence>,
    document.body,
  );
}

function Viewer({ items, index, onIndex, onClose, actions }: {
  items: GalleryItem[]; index: number; onIndex: (i: number) => void; onClose: () => void; actions?: (item: GalleryItem) => ReactNode;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const dir = useRef(1);
  const item = items[index];
  const many = items.length > 1;
  useDialogFocus(root);

  const go = (to: number) => {
    const n = Math.max(0, Math.min(items.length - 1, to));
    if (n === index) return;
    dir.current = n > index ? 1 : -1;
    onIndex(n);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(index + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(index - 1); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });

  // The strip keeps the current thumbnail in view.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [index]);

  return (
    <motion.div ref={root} role="dialog" aria-modal="true" aria-label={item.label}
      className="fixed inset-0 z-[60] flex flex-col bg-black/85 text-white backdrop-blur-sm"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3 sm:px-6" onMouseDown={(e) => e.stopPropagation()}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{item.label}</p>
          {item.sub && <p className="mono truncate text-2xs text-white/70">{item.sub}</p>}
        </div>
        {item.badge}
        {many && <span className="mono shrink-0 text-xs text-white/70">{pad(index + 1)} / {pad(items.length)}</span>}
        <IconButton title={t("Close")} onClick={onClose} data-autofocus className="size-10 text-white/80! hover:bg-white/15! hover:text-white! sm:size-8"><X className="size-5" /></IconButton>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-12 sm:px-20" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <AnimatePresence mode="popLayout" initial={false} custom={dir.current}>
          <motion.img key={item.id} src={item.url} alt={item.label} custom={dir.current}
            variants={{ enter: (d: number) => ({ opacity: 0, x: d * 48, scale: 0.98 }), center: { opacity: 1, x: 0, scale: 1 }, exit: (d: number) => ({ opacity: 0, x: d * -48, scale: 0.98 }) }}
            initial="enter" animate="center" exit="exit" transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="max-h-full max-w-full rounded-lg object-contain shadow-modal" draggable={false} onMouseDown={(e) => e.stopPropagation()} />
        </AnimatePresence>
        {many && (
          <>
            <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label={t("Previous image")} onMouseDown={(e) => e.stopPropagation()}
              className="absolute left-2 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-lg border border-white/15 bg-black/50 text-white transition-colors hover:bg-white/20 disabled:opacity-30 sm:left-5">
              <ChevronLeft className="size-5" />
            </button>
            <button type="button" onClick={() => go(index + 1)} disabled={index === items.length - 1} aria-label={t("Next image")} onMouseDown={(e) => e.stopPropagation()}
              className="absolute right-2 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-lg border border-white/15 bg-black/50 text-white transition-colors hover:bg-white/20 disabled:opacity-30 sm:right-5">
              <ChevronRight className="size-5" />
            </button>
          </>
        )}
      </div>

      <div className="flex flex-col items-center gap-3 px-4 pb-4 pt-3 sm:px-6" onMouseDown={(e) => e.stopPropagation()}>
        {actions && <div className="flex flex-wrap items-center justify-center gap-2">{actions(item)}</div>}
        {many && (
          <div ref={strip} className="no-scrollbar flex max-w-full gap-1.5 overflow-x-auto py-1">
            {items.map((it, i) => (
              <button key={it.id} type="button" onClick={() => go(i)} aria-label={it.label} aria-current={i === index ? "true" : undefined}
                className={cn("relative h-12 w-9 shrink-0 overflow-hidden rounded-md border-2 transition-[border-color,opacity]", i === index ? "border-accent opacity-100" : "border-transparent opacity-55 hover:opacity-100")}>
                <img src={it.url} alt="" className="size-full object-cover" loading="lazy" />
                {it.approved && <span aria-hidden className="absolute bottom-0 right-0 grid size-3.5 place-items-center rounded-tl bg-ok text-black"><Check className="size-2.5" strokeWidth={3.5} /></span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

/**
 * A grid of image tiles that open in the lightbox. Each tile is a hairline frame: the image on a scanline well, a mono caption under
 * it, a lit check when it is approved. Editors get approve / remove on each tile (and inside the viewer).
 * `aspect` is the image shape, e.g. "3 / 4" for portraits or "16 / 10" for places.
 */
export function Gallery({ items, canEdit, aspect = "3 / 4", minTile = 8, onApprove, onRemove, approveLabel, className, pending = 0 }: {
  items: GalleryItem[]; canEdit: boolean; aspect?: string; minTile?: number; pending?: number;
  onApprove?: (item: GalleryItem) => void; onRemove?: (item: GalleryItem) => void; approveLabel?: string; className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  // Keep the viewer valid when the list shrinks (an image was removed while it was open).
  useEffect(() => { if (open !== null && open >= items.length) setOpen(items.length ? items.length - 1 : null); }, [items.length, open]);

  return (
    <>
      <div className={cn("grid gap-3", className)} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${minTile}rem), 1fr))` }}>
        {items.map((it, i) => {
          const r = rise(i);
          return (
            <figure key={it.id} className={cn("group relative m-0 min-w-0 overflow-hidden rounded-lg border bg-panel transition-colors",
              it.approved ? "border-ok/60 shadow-[0_0_14px_-8px_var(--color-ok)]" : "border-line hover:border-dim/50", r.className)} style={r.style}>
              <div className="rm-scan relative overflow-hidden bg-raised" style={{ aspectRatio: aspect }}>
                <button type="button" onClick={() => setOpen(i)} aria-label={`${t("View")}: ${it.label}`} className="block size-full cursor-zoom-in">
                  <img src={it.url} alt={it.label} loading="lazy" className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]" />
                </button>
                {it.approved && (
                  <span className="mono pointer-events-none absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-ok px-1.5 py-1 text-2xs font-semibold uppercase leading-none tracking-wide text-black shadow-card">
                    <Check aria-hidden className="size-3" strokeWidth={3} />{approveLabel ?? t("Approved")}
                  </span>
                )}
                {canEdit && (
                  <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    {onApprove && (
                      <button type="button" title={it.approved ? t("Unapprove") : t("Approve as reference")} aria-label={it.approved ? t("Unapprove") : t("Approve as reference")} aria-pressed={!!it.approved}
                        onClick={() => onApprove(it)}
                        className={cn("grid size-8 place-items-center rounded-md backdrop-blur transition-colors sm:size-7", it.approved ? "bg-ok text-black" : "bg-black/60 text-white hover:bg-ok hover:text-black")}>
                        <Check className="size-4" strokeWidth={2.5} />
                      </button>
                    )}
                    {onRemove && (
                      <button type="button" title={t("Remove")} aria-label={t("Remove")} onClick={() => onRemove(it)}
                        className="grid size-8 place-items-center rounded-md bg-black/60 text-white backdrop-blur transition-colors hover:bg-bad sm:size-7">
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <figcaption className="border-t border-line px-2 py-1.5">
                <p className="mono truncate text-2xs font-medium leading-4 text-ink" title={it.label}>{it.label}</p>
                {it.sub && <p className="truncate text-2xs leading-4 text-dim" title={it.sub}>{it.sub}</p>}
              </figcaption>
            </figure>
          );
        })}
        {Array.from({ length: pending }, (_, i) => (
          <div key={`pending-${i}`} aria-hidden className="gen-ring relative rounded-lg border border-line bg-panel">
            <div className="overflow-hidden rounded-t-[7px]"><Skeleton className="!rounded-none" style={{ aspectRatio: aspect }} /></div>
            <div className="border-t border-line px-2 py-2"><Skeleton className="h-3 w-2/3" /></div>
          </div>
        ))}
      </div>
      <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)}
        actions={canEdit && (onApprove || onRemove) ? (it) => (
          <>
            {onApprove && (
              <button type="button" onClick={() => onApprove(it)}
                className={cn("inline-flex h-10 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors sm:h-9", it.approved ? "bg-ok text-black hover:bg-ok/85" : "bg-white/15 text-white hover:bg-white/25")}>
                <Check className="size-4" strokeWidth={2.5} />{it.approved ? t("Approved") : t("Approve as reference")}
              </button>
            )}
            {onRemove && (
              <button type="button" onClick={() => onRemove(it)}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-white/15 px-3.5 text-sm font-medium text-white transition-colors hover:bg-bad sm:h-9">
                <Trash2 className="size-4" />{t("Remove")}
              </button>
            )}
          </>
        ) : undefined} />
    </>
  );
}
