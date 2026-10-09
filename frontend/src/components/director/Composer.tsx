import { clsx } from "clsx";
import { Crosshair, Eye, Loader2, Send } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import { MOD } from "../shell/keys";
import { Kbd, Tooltip } from "../ui";
import type { Suggestion } from "./shared";
import "../../styles/director.css";

const MAX_LEN = 4000; // the API rejects longer messages
const MAX_H = 168;
/** Hide the extras (quick orders, key hints) when the window is short, so the conversation keeps its room. */
const TALL_ONLY = "[@media(max-height:560px)]:hidden";

/** Quick orders in one row. Fades whichever edge hides more chips; the mouse wheel scrolls it sideways. */
function Chips({ items, disabled, onPick }: { items: Suggestion[]; disabled: boolean; onPick: (order: string) => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.style.setProperty("--fl", el.scrollLeft > 2 ? "22px" : "0px");
      el.style.setProperty("--fr", el.scrollLeft + el.clientWidth < el.scrollWidth - 2 ? "34px" : "0px");
    };
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    el.addEventListener("wheel", wheel, { passive: false });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); el.removeEventListener("wheel", wheel); ro.disconnect(); };
  }, []);

  return (
    <div ref={ref} role="group" aria-label={t("Quick orders")} className="scroll-strip no-scrollbar -mx-1 overflow-x-auto px-1 py-1">
      <div className="flex w-max gap-1.5">
        {items.map((s) => (
          <button key={s.order} type="button" disabled={disabled} onClick={() => onPick(s.order)} className="dr-chip">
            <s.icon />
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The command line at the bottom of the Director console: quick-order chips above, a prompt glyph and an auto-growing
 * textarea, one primary Send, and the key hints in mono underneath.
 */
export function Composer({ value, onChange, onSend, onPick, sending, canEdit, selectedCode, suggestions, chips = true }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onPick: (order: string) => void;
  sending: boolean; canEdit: boolean; selectedCode?: string; suggestions: Suggestion[];
  /** Show the quick-order row above the box (the empty conversation already shows them, larger). */
  chips?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to ~7 lines, then scroll inside.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? "auto" : "hidden";
  }, [value]);

  if (!canEdit) {
    return (
      <div className="border-t border-line p-3">
        <p className="cx-block flex items-start gap-2 px-3 py-2.5 text-xs leading-relaxed text-mute">
          <Eye className="mt-0.5 size-3.5 shrink-0 text-dim" />
          {t("Viewers and reviewers can read the Director's log but not give orders.")}
        </p>
      </div>
    );
  }

  const text = value.trim();
  const near = value.length > MAX_LEN - 600;
  const extras = !!selectedCode || near;

  return (
    <div className="@container relative shrink-0 border-t border-line bg-panel px-3 pb-2.5 pt-2">
      <span aria-hidden className="dr-edge pointer-events-none absolute inset-x-4 top-0 opacity-70" />
      <AnimatePresence initial={false}>
        {chips && !value && (
          <motion.div
            key="chips"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className={clsx("overflow-hidden", TALL_ONLY)}
          >
            <Chips items={suggestions} disabled={sending} onPick={onPick} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="dr-input mt-1">
        <div className="flex items-end gap-1.5 py-1.5 pl-3 pr-1.5">
          <span aria-hidden className="mono mb-[0.55rem] select-none text-sm font-medium leading-none text-ai">›</span>
          <textarea
            ref={ref}
            id="agent-input"
            value={value}
            rows={1}
            maxLength={MAX_LEN}
            aria-label={t("Ask the Director…")}
            placeholder={t("Ask the Director…")}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend(); }
            }}
            className="block max-h-[168px] min-h-9 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed text-ink outline-none placeholder:text-dim"
          />
          <Tooltip content={t("Send")} shortcut={<Kbd>↵</Kbd>} side="top" disabled={!text || sending}>
            <button
              type="button"
              aria-label={t("Send")}
              aria-busy={sending || undefined}
              onClick={onSend}
              disabled={!text || sending}
              className="btn-primary mb-0.5 grid size-8 shrink-0 select-none place-items-center rounded-lg text-black transition-[transform,opacity,filter] duration-150 active:scale-90 disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100 max-sm:size-10"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </button>
          </Tooltip>
        </div>
        <AnimatePresence initial={false}>
          {extras && (
            <motion.div
              key="extras"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-2 border-t border-line/60 px-3 py-1.5">
                {selectedCode && (
                  <Tooltip content={t("e.g. \"make this shot more tense\"")} side="top">
                    <span className="mono inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 text-2xs font-medium text-accent-ink">
                      <Crosshair className="size-3 shrink-0" />
                      <span className="truncate">{t("Selected:")} {selectedCode}</span>
                    </span>
                  </Tooltip>
                )}
                <div className="flex-1" />
                {near && (
                  <span className={clsx("mono text-2xs tabular-nums", value.length >= MAX_LEN ? "text-bad" : "text-dim")}>
                    {value.length.toLocaleString()} / {MAX_LEN.toLocaleString()}
                  </span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <p className={clsx("mono mt-1.5 hidden flex-wrap items-center gap-x-1 px-1 text-2xs text-dim sm:flex", TALL_ONLY)}>
        <Kbd>Enter</Kbd> {t("send")}<span aria-hidden>·</span><Kbd>Shift</Kbd><span aria-hidden>+</span><Kbd>Enter</Kbd> {t("new line")}
        <span aria-hidden className="hidden @[400px]:inline">·</span><span className="hidden items-center gap-1 @[400px]:inline-flex"><Kbd>{MOD}</Kbd><span aria-hidden>+</span><Kbd>J</Kbd> {t("focus")}</span>
      </p>
    </div>
  );
}
