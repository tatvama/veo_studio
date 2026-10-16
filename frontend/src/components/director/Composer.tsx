import { clsx } from "clsx";
import { Crosshair, Eye, ImagePlus, Loader2, Send } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { useT } from "../../lib/i18n";
import type { AgentAttachmentTag } from "../../lib/types";
import { useMentionField } from "../room/MentionField";
import { MOD } from "../shell/keys";
import { Kbd, Tooltip } from "../ui";
import { ATTACH_TYPES, AttachmentStrip, MAX_ATTACHMENTS, type DraftAttachment } from "./Attachments";
import type { Suggestion } from "./shared";
import "../../styles/director.css";

export const MAX_LEN = 30_000; // the API rejects longer messages: a long brief or a whole script fits
const MAX_H = 168;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
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
 * The command line at the bottom of the Director console: quick-order chips above, attached pictures (each with a tag),
 * a prompt glyph and an auto-growing textarea with @mentions of the cast, places and props, one primary Send, and the
 * key hints in mono underneath. Pictures come in with the attach button, paste or drag-and-drop.
 */
export function Composer({ pid, value, onChange, onSend, onPick, sending, canEdit, selectedCode, suggestions, chips = true,
  attachments = [], onFiles, onRemoveAttachment, onTagAttachment }: {
  pid: number; value: string; onChange: (v: string) => void; onSend: () => void; onPick: (order: string) => void;
  sending: boolean; canEdit: boolean; selectedCode?: string; suggestions: Suggestion[];
  /** Show the quick-order row above the box (the empty conversation already shows them, larger). */
  chips?: boolean;
  attachments?: DraftAttachment[]; onFiles?: (files: File[]) => void; onRemoveAttachment?: (key: string) => void;
  onTagAttachment?: (key: string, tag: AgentAttachmentTag | null) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const mention = useMentionField({ pid, value, onChange, ref, enabled: canEdit && !sending });

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
  const near = value.length > MAX_LEN - 2000;
  const extras = !!selectedCode || near;
  const uploading = attachments.some((a) => a.status === "uploading");
  const canSend = (!!text || attachments.length > 0) && !uploading && !sending;
  const canAttach = !!onFiles && attachments.length < MAX_ATTACHMENTS && !sending;
  const takeFiles = (list: FileList | File[] | null | undefined) => {
    const files = Array.from(list ?? []).filter((f) => ATTACH_TYPES.includes(f.type));
    if (files.length && onFiles) onFiles(files);
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => ATTACH_TYPES.includes(f.type));
    if (!imgs.length || !onFiles) return;
    onFiles(imgs);
    if (!e.clipboardData.getData("text")) e.preventDefault(); // a copied picture only: nothing to paste as text
  };

  return (
    <div
      className="@container relative shrink-0 border-t border-line bg-panel px-3 pb-2.5 pt-2"
      onDragEnter={(e) => { if (onFiles && hasFiles(e)) { e.preventDefault(); setDragging(true); } }}
      onDragOver={(e) => { if (onFiles && hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        if (!onFiles || !hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        takeFiles(e.dataTransfer.files);
      }}
    >
      <span aria-hidden className="dr-edge pointer-events-none absolute inset-x-4 top-0 opacity-70" />
      {dragging && (
        <div aria-hidden className="pointer-events-none absolute inset-1.5 z-10 grid place-items-center rounded-lg border-2 border-dashed border-ai/60 bg-ai/10 text-xs font-medium text-ai backdrop-blur-[1px]">
          <span className="flex items-center gap-1.5"><ImagePlus className="size-4" />{t("Drop pictures to attach (up to {n})", { n: MAX_ATTACHMENTS })}</span>
        </div>
      )}
      <AnimatePresence initial={false}>
        {chips && !value && !attachments.length && (
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
        <AttachmentStrip items={attachments} pid={pid} disabled={sending} onRemove={(k) => onRemoveAttachment?.(k)}
          onTag={(k, tag) => onTagAttachment?.(k, tag)} />
        <div className="flex items-end gap-1.5 py-1.5 pl-3 pr-1.5">
          <span aria-hidden className="mono mb-[0.55rem] select-none text-sm font-medium leading-none text-ai">›</span>
          <textarea
            ref={ref}
            id="agent-input"
            value={value}
            rows={1}
            maxLength={MAX_LEN}
            aria-label={t("Ask the Director…")}
            placeholder={attachments.length ? t("Say what to do with the pictures… (@ to mention)") : t("Ask the Director… (@ to mention)")}
            {...mention.fieldProps}
            onPaste={onPaste}
            onKeyDown={(e) => {
              mention.fieldProps.onKeyDown(e); // the @ list takes the arrows, Enter, Tab and Esc while it is open
              if (e.defaultPrevented) return;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) onSend(); }
            }}
            className="block max-h-[168px] min-h-9 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed text-ink outline-none placeholder:text-dim"
          />
          {mention.popover}
          {onFiles && (
            <>
              <input ref={fileInput} type="file" accept={ATTACH_TYPES.join(",")} multiple hidden
                onChange={(e) => { takeFiles(e.target.files); e.target.value = ""; }} />
              <Tooltip content={t("Attach pictures (or paste, or drop them here)")} side="top" disabled={!canAttach}>
                <button
                  type="button"
                  aria-label={t("Attach pictures")}
                  onClick={() => fileInput.current?.click()}
                  disabled={!canAttach}
                  className="mb-0.5 grid size-8 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-hover hover:text-ai disabled:cursor-not-allowed disabled:opacity-45 max-sm:size-10"
                >
                  <ImagePlus className="size-4" />
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip content={uploading ? t("Waiting for the pictures to upload") : t("Send")} shortcut={<Kbd>↵</Kbd>} side="top" disabled={!canSend}>
            <button
              type="button"
              aria-label={t("Send")}
              aria-busy={sending || undefined}
              onClick={onSend}
              disabled={!canSend}
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
