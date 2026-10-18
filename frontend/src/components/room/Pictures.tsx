import { Check, ImageOff, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { Skeleton, rise } from "../ui";
import { Lightbox, type GalleryItem } from "./Lightbox";

/** One place in the big picture grid: a picture (maybe not made yet), what it shows, and whether it is being made. */
export interface PictureSlot {
  key: string; label: string; sub?: string;
  /** the picture; missing = a dashed "not made yet" frame */
  asset?: { id: number; url: string; approved?: boolean };
  /** being made right now */
  pending?: boolean;
  /** Redo makes a new picture of this view (not for your own photos) */
  redo?: boolean;
}

/**
 * Big reference pictures, each with Approve and Redo under it (and Remove), and a lightbox on click. Approved pictures are
 * what every shot copies the look from, so the approve button is the main action of each tile.
 */
export function PictureGrid({ slots, aspect = "3 / 4", minTile = 11, canEdit, onApprove, onRedo, onRemove, redoPrice, className }: {
  slots: PictureSlot[]; aspect?: string; minTile?: number; canEdit: boolean;
  onApprove?: (id: number, approved: boolean) => void; onRedo?: (slot: PictureSlot) => void; onRemove?: (id: number) => void;
  /** shown on each Redo button ("Redo · $0.04") */ redoPrice?: ReactNode; className?: string;
}) {
  const t = useT();
  const items = useMemo<GalleryItem[]>(() => slots.filter((s) => s.asset).map((s) => ({ id: s.asset!.id, url: s.asset!.url, label: s.label, sub: s.sub, approved: s.asset!.approved })), [slots]);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { if (open !== null && open >= items.length) setOpen(items.length ? items.length - 1 : null); }, [items.length, open]);

  return (
    <>
      <ul className={cn("grid gap-3", className)} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${minTile}rem), 1fr))` }}>
        {slots.map((s, i) => {
          const r = rise(i);
          const a = s.asset;
          const at = a ? items.findIndex((x) => x.id === a.id) : -1;
          return (
            <li key={s.key} className={cn("group @container flex min-w-0 flex-col overflow-hidden rounded-xl border bg-panel transition-colors",
              a?.approved ? "border-ok/60 shadow-[0_0_16px_-8px_var(--color-ok)]" : a ? "border-line hover:border-dim/50" : "border-dashed border-line", s.pending && "gen-ring", r.className)} style={r.style}>
              <div className="rm-scan relative overflow-hidden bg-raised" style={{ aspectRatio: aspect }}>
                {a ? (
                  <button type="button" onClick={() => setOpen(at)} aria-label={`${t("View")}: ${s.label}`} className="block size-full cursor-zoom-in">
                    <img src={a.url} alt={s.label} loading="lazy" className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]" />
                  </button>
                ) : s.pending ? (
                  <Skeleton className="!rounded-none size-full" />
                ) : (
                  <span className="flex size-full flex-col items-center justify-center gap-1.5 p-3 text-center text-dim">
                    <ImageOff aria-hidden className="size-5" />
                    <span className="text-2xs">{t("Not made yet")}</span>
                  </span>
                )}
                {a?.approved && (
                  <span className="mono pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-ok px-1.5 py-1 text-2xs font-semibold uppercase leading-none tracking-wide text-black shadow-card">
                    <Check aria-hidden className="size-3" strokeWidth={3} />{t("Approved")}
                  </span>
                )}
                {s.pending && a && <span aria-hidden className="sweep absolute inset-x-0 bottom-0 h-0.5 bg-accent/60" />}
              </div>
              <div className="flex flex-1 flex-col gap-2 border-t border-line p-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium" title={s.label}>{s.label}</p>
                  {s.sub && <p className="truncate text-2xs text-dim" title={s.sub}>{s.sub}</p>}
                </div>
                {canEdit && (a || (s.redo && onRedo)) && (
                  <div className="mt-auto space-y-1.5">
                    {a && onApprove && (
                      <button type="button" onClick={() => onApprove(a.id, !a.approved)} aria-pressed={!!a.approved}
                        className={cn("flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors max-sm:h-10",
                          a.approved ? "border-ok/50 bg-ok/15 text-ok hover:bg-ok/25" : "border-line bg-raised text-ink hover:border-ok/50 hover:text-ok")}>
                        <Check aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />{a.approved ? t("Approved") : t("Approve")}
                      </button>
                    )}
                    {((s.redo && onRedo && !s.pending) || (a && onRemove)) && (
                      <div className="flex items-center gap-1.5">
                        {s.redo && onRedo && !s.pending && (
                          <button type="button" onClick={() => onRedo(s)} title={a ? t("Make a new {view}", { view: s.label }) : t("Make the {view}", { view: s.label })}
                            className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border border-line bg-raised px-2 text-xs font-medium text-ink transition-colors hover:border-accent/50 hover:text-accent-ink max-sm:h-10">
                            <RefreshCw aria-hidden className="size-3.5 shrink-0" /><span className="shrink-0">{a ? t("Redo") : t("Make")}</span>
                            {redoPrice && <span className="hidden min-w-0 truncate @[10.5rem]:inline">{redoPrice}</span>}
                          </button>
                        )}
                        {a && onRemove && (
                          <button type="button" onClick={() => onRemove(a.id)} title={t("Remove")} aria-label={`${t("Remove")}: ${s.label}`}
                            className="ml-auto grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-raised text-mute transition-colors hover:border-bad/50 hover:text-bad max-sm:size-10">
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)}
        actions={canEdit && onApprove ? (it) => (
          <button type="button" onClick={() => onApprove(it.id, !it.approved)}
            className={cn("inline-flex h-10 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors sm:h-9", it.approved ? "bg-ok text-black hover:bg-ok/85" : "bg-white/15 text-white hover:bg-white/25")}>
            <Check className="size-4" strokeWidth={2.5} />{it.approved ? t("Approved") : t("Approve")}
          </button>
        ) : undefined} />
    </>
  );
}
