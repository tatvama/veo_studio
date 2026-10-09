import { CalendarDays, Check, ChevronLeft, ChevronRight, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { TASK_LABELS, dateText } from "../../components/hub/util";
import { Badge, Button, IconButton, Panel, Tooltip } from "../../components/ui";
import { useT } from "../../lib/i18n";
import type { AIModel } from "../../lib/types";
import { CapRow, ModeChips, PriceBlock, ProviderBadge, StateBadge, TASK_ICON } from "./ModelCard";

import "../../styles/console.css";
import "../../styles/models.css";

/** Horizontal scroll-snap strip of freshly discovered engines with one-click Enable / Dismiss. */
export default memo(function NewModels({ models, count, admin, busyId, onEnable, onDismiss, onOpen, onReviewAll }: {
  models: AIModel[]; count: number; admin: boolean; busyId: string | null;
  onEnable: (m: AIModel) => void; onDismiss: (m: AIModel) => void; onOpen: (m: AIModel) => void; onReviewAll: () => void;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const start = el.scrollLeft <= 2;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    el.style.setProperty("--fl", start ? "0px" : "28px");
    el.style.setProperty("--fr", end ? "0px" : "40px");
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", measure); ro.disconnect(); };
  }, [measure, models.length]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: "smooth" });
  };

  return (
    <motion.div
      role="region" aria-label={t("New models")}
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }} className="-m-1 overflow-hidden p-1"
    >
      <Panel tone="accent" icon={<Sparkles />} eyebrow={<span className="flex items-center gap-2">{t("New models")}<Badge tone="accent" className="mono">{count}</Badge></span>}
        actions={(
          <>
            <Button size="sm" variant="ghost" onClick={onReviewAll}>{t("Review all")}</Button>
            <IconButton title={t("Previous")} onClick={() => page(-1)} disabled={edges.start} className="hidden sm:inline-flex"><ChevronLeft className="size-4" /></IconButton>
            <IconButton title={t("Next")} onClick={() => page(1)} disabled={edges.end} className="hidden sm:inline-flex"><ChevronRight className="size-4" /></IconButton>
          </>
        )}>
        <p className="-mt-1 mb-3 text-xs text-mute">
          {admin ? t("Discovered by the last sync. Enable the ones worth trying; dismiss the rest.") : t("Discovered by the last sync. An admin can enable them.")}
        </p>
        <div ref={scroller} tabIndex={-1}
          className="scroll-strip no-scrollbar -mx-4 -my-1 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 py-1">
          <AnimatePresence initial={false}>
            {models.map((m) => {
              const TaskIcon = TASK_ICON[m.task];
              return (
                <motion.article
                  key={m.id} layout="position"
                  initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9, width: 0, marginRight: -12 }}
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                  className="hud hub-card group relative flex w-[17rem] max-w-[82vw] shrink-0 snap-start flex-col gap-2.5 rounded-xl border bg-panel p-3.5"
                >
                  <button type="button" onClick={() => onOpen(m)} aria-label={t("Open {name}", { name: m.display_name })}
                    className="absolute inset-0 z-[1] rounded-xl outline-offset-[-2px]" />
                  <div className="pointer-events-none flex items-center justify-between gap-2">
                    <ProviderBadge m={m} />
                    <StateBadge m={m} />
                  </div>
                  <div className="pointer-events-none min-w-0">
                    <h4 className="truncate text-sm font-semibold leading-snug" title={m.display_name}>{m.display_name}</h4>
                    <p className="mono flex items-center gap-1.5 truncate text-2xs text-dim">
                      {TaskIcon && <TaskIcon className="size-3 shrink-0" aria-hidden />}
                      <span className="truncate">{[m.maker, t(TASK_LABELS[m.task] ?? m.task)].filter(Boolean).join(" · ")}</span>
                    </p>
                  </div>
                  <div className="pointer-events-none flex flex-col gap-1.5">
                    <CapRow m={m} lit />
                    <ModeChips modes={m.capabilities?.modes} max={3} />
                  </div>
                  <div className="pointer-events-none mt-auto flex items-end justify-between gap-2 border-t border-line pt-2.5">
                    <PriceBlock m={m} size="sm" />
                    {m.released_at && <span className="mono inline-flex shrink-0 items-center gap-1 text-2xs text-dim"><CalendarDays className="size-3" aria-hidden />{dateText(m.released_at)}</span>}
                  </div>
                  {admin && (
                    <div className="relative z-[2] flex gap-1.5">
                      <Button size="sm" variant="secondary" className="flex-1 max-sm:h-10" icon={<Check className="size-3.5" />} loading={busyId === m.id} onClick={() => onEnable(m)}>{t("Enable")}</Button>
                      <Tooltip content={t("Hide it from the new list (disable)")}>
                        <Button size="sm" variant="ghost" className="max-sm:h-10" icon={<X className="size-3.5" />} disabled={busyId === m.id} onClick={() => onDismiss(m)}>{t("Dismiss")}</Button>
                      </Tooltip>
                    </div>
                  )}
                </motion.article>
              );
            })}
          </AnimatePresence>
        </div>
      </Panel>
    </motion.div>
  );
});
