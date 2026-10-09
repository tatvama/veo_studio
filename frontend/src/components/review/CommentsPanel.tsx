import { clsx } from "clsx";
import { Check, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, MessageSquare, PenLine, Pencil, RotateCcw, Send, TriangleAlert, UserRound, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { Avatar, Badge, Button, IconButton, Input, Skeleton, Spinner } from "../ui";
import { DrawingThumb, TimecodeChip } from "./parts";
import { frameOf, relTime, type RComment } from "./utils";
import "../../styles/console.css";
import "../../styles/review.css";

type Filter = "all" | "open" | "resolved";

const cleanName = (n: string) => n.replace(/\s*\(client\)$/, "");

function CommentItem({ c, fps, aspect, active, current, reply, flow, onSelect, onResolve }: {
  c: RComment; fps: number; aspect: number; active: boolean; current: boolean; reply: boolean; flow: boolean; onSelect: () => void; onResolve?: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    // keep the item visible inside the list only (never scroll the page — on phones the list sits under the video)
    const el = ref.current;
    const box = el?.closest<HTMLElement>("[data-comment-scroll]");
    if (!(active || current) || !el || !box) return;
    // natural-flow list (phone layout): the page itself scrolls, scroll-margin keeps the item clear of the pinned monitor and composer
    if (flow) {
      if (active) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top) box.scrollBy({ top: r.top - b.top - 8, behavior: "smooth" });
    else if (r.bottom > b.bottom) box.scrollBy({ top: r.bottom - b.bottom + 8, behavior: "smooth" });
  }, [active, current, flow]);

  const name = cleanName(c.author);
  const dim = c.resolved && !active;
  return (
    <motion.li
      ref={ref}
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      aria-current={active || undefined}
      onClick={onSelect}
      className={clsx("scroll-mb-32 scroll-mt-[var(--rv-stick,0px)] pb-2 last:pb-0", reply && "relative ml-6")}
    >
      {reply && <span aria-hidden className="absolute -left-3.5 -top-2 h-7 w-3 rounded-bl-lg border-b border-l border-line" />}
      <div className="rv-comment cx-block group cursor-pointer" data-active={active || undefined} data-current={current || undefined}>
        <div className={clsx("flex items-center gap-2 px-2.5 pt-2.5", dim && "opacity-70")}>
          <Avatar name={name} size={24} />
          <span className="min-w-0 truncate text-xs font-semibold text-ink">{name}</span>
          {c.guest && <Badge tone="info">{t("Client")}</Badge>}
          <span className="mono shrink-0 text-2xs text-dim">{relTime(c.created_at)}</span>
          <div className="flex-1" />
          {c.resolved && (
            <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-ok"><CircleCheck className="size-3.5" />{t("Resolved")}</span>
          )}
          {onResolve && (
            <IconButton
              title={c.resolved ? t("Reopen") : t("Resolve")}
              disabled={busy}
              onClick={async (e) => {
                e.stopPropagation();
                setBusy(true);
                try { await onResolve(); } finally { setBusy(false); }
              }}
              className={clsx("-my-1 -mr-1 !size-7 shrink-0 max-sm:!size-10", !c.resolved && !busy && "max-sm:opacity-100 sm:opacity-0 sm:focus-visible:opacity-100 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100")}
            >
              {busy ? <Spinner className="size-3.5" /> : c.resolved ? <RotateCcw className="size-3.5" /> : <Check className="size-4" />}
            </IconButton>
          )}
        </div>
        {!reply && (
          <div className={clsx("flex flex-wrap items-center gap-1.5 px-2.5 pt-2", dim && "opacity-70")}>
            {c.timecode != null ? (
              <TimecodeChip tc={c.timecode} fps={fps} title={t("Jump to this moment")} onClick={(e) => { e.stopPropagation(); onSelect(); }} />
            ) : (
              <span className="inline-flex h-6 items-center rounded-md border border-line bg-raised px-1.5 text-2xs font-medium text-mute">{t("General")}</span>
            )}
          </div>
        )}
        <div className={clsx("flex items-start gap-2.5 px-2.5 pb-2.5 pt-1.5", dim && "opacity-70")}>
          <p className={clsx("min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-snug text-ink", dim && "line-clamp-2")}>{c.body}</p>
          {c.drawing.length > 0 && <DrawingThumb strokes={c.drawing} ratio={aspect} />}
        </div>
      </div>
    </motion.li>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2 p-2.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="cx-block flex gap-2.5 p-2.5">
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Phone layout: the panel is a bottom sheet — only its header shows until it is opened. */
export interface Sheet { open: boolean; onToggle: () => void; height: string; onAdd?: () => void }

/**
 * The comment console. Timecode-sorted list with count + filter chips, threads (same-frame comments nest), active/current
 * highlighting, animated enter/exit and the composer pinned at the bottom.
 *   • `sheet` – phone bottom-sheet variant.
 *   • `flow`  – no inner scroller: the list flows with the page (the composer sticks to the bottom edge of the page).
 *   • `aspect` – width / height of the picture, so drawing thumbnails have the frame's shape.
 */
export function CommentsPanel({ comments, fps, time, playing, activeId, onSelect, onResolve, loading, error, onRetry, composer, notice, className, sheet, flow = false, aspect = 16 / 9 }: {
  comments: RComment[]; fps: number; time: number; playing: boolean; activeId: number | null; onSelect: (c: RComment) => void;
  onResolve?: (c: RComment) => Promise<void>; loading?: boolean; error?: boolean; onRetry?: () => void; composer?: React.ReactNode;
  notice?: React.ReactNode; className?: string; sheet?: Sheet; flow?: boolean; aspect?: number;
}) {
  const t = useT();
  const [chosen, setFilter] = useState<Filter>("all");
  const open = comments.filter((c) => !c.resolved).length;
  const resolvedCount = comments.length - open;
  const filter: Filter = resolvedCount ? chosen : "all";
  const shown = useMemo(
    () => comments.filter((c) => (filter === "all" ? true : filter === "open" ? !c.resolved : c.resolved)),
    [comments, filter],
  );
  // the comment the playhead is sitting on (or just passed while playing)
  const currentId = useMemo(() => {
    let best: RComment | null = null;
    const f = frameOf(time, fps);
    for (const c of shown) {
      if (c.timecode == null) continue;
      if (playing ? c.timecode <= time && time - c.timecode < 1.5 : frameOf(c.timecode, fps) === f) best = c;
    }
    return best?.id ?? null;
  }, [shown, time, fps, playing]);

  const firstGeneral = shown.findIndex((c) => c.timecode == null);

  // previous / next timecoded comment, relative to the selected one (or to the playhead)
  const timed = useMemo(() => shown.filter((c) => c.timecode != null), [shown]);
  const find = (dir: 1 | -1): RComment | undefined => {
    const at = timed.findIndex((c) => c.id === (activeId ?? currentId));
    if (at >= 0) return timed[at + dir];
    return dir > 0 ? timed.find((c) => (c.timecode as number) > time + 1e-3) : [...timed].reverse().find((c) => (c.timecode as number) < time - 1e-3);
  };
  const prevC = timed.length ? find(-1) : undefined;
  const nextC = timed.length ? find(1) : undefined;
  const navControl = timed.length > 1 && (
    <div className="flex items-center">
      <IconButton title={t("Previous comment")} disabled={!prevC} onClick={() => prevC && onSelect(prevC)} className="max-sm:!size-10"><ChevronLeft className="size-4" /></IconButton>
      <IconButton title={t("Next comment")} disabled={!nextC} onClick={() => nextC && onSelect(nextC)} className="max-sm:!size-10"><ChevronRight className="size-4" /></IconButton>
    </div>
  );

  const chips = comments.length > 0 && (
    <div role="group" aria-label={t("Filter comments")} className="flex flex-wrap items-center gap-1.5">
      {([["all", t("All"), comments.length], ["open", t("Open"), open], ["resolved", t("Resolved"), resolvedCount]] as [Filter, string, number][]).map(([v, label, n]) => (
        <button key={v} type="button" className="cx-chip" aria-pressed={filter === v} disabled={v === "resolved" && !resolvedCount} onClick={() => setFilter(v)}>
          {label}<span className="cx-n">{n}</span>
        </button>
      ))}
    </div>
  );

  /** Header line: eyebrow + a state word (never colour alone). */
  const state = !comments.length ? t("Nothing yet") : open ? null : t("All resolved");
  const headTitle = (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent-ink"><MessageSquare className="size-4" /></span>
      <span className="min-w-0 text-left">
        <span className="eyebrow block truncate !text-ink">{t("Comments")}</span>
        <span className="mono mt-1 block truncate text-2xs leading-tight text-dim">{open ? t("{n} open", { n: open }) : state}</span>
      </span>
    </>
  );
  const body = (
    <>
      {notice}
      <div data-comment-scroll className={clsx("min-h-[120px]", !flow && "flex-1 overflow-y-auto overscroll-contain")}>
        {loading ? (
          <ListSkeleton />
        ) : error && !comments.length ? (
          <div className="flex flex-col items-center px-6 py-8 text-center">
            <span className="mb-2 grid size-10 place-items-center rounded-xl bg-bad/12 text-bad"><TriangleAlert className="size-5" /></span>
            <p className="text-sm font-semibold">{t("Couldn't load the comments")}</p>
            {onRetry && <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>{t("Try again")}</Button>}
          </div>
        ) : !shown.length ? (
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
            <span className="anim-float mb-3 grid size-12 place-items-center rounded-xl border border-line bg-raised text-mute"><MessageSquare className="size-5" /></span>
            <p className="text-sm font-semibold">{filter === "resolved" ? t("Nothing resolved yet") : filter === "open" && comments.length ? t("Everything is resolved") : t("No comments yet")}</p>
            <p className="mt-1 max-w-[17rem] text-xs leading-relaxed text-mute">{t("Pause on a frame, draw on it if it helps, and leave a note — it is pinned to that exact timecode.")}</p>
          </div>
        ) : (
          <ul className="p-2.5">
            <AnimatePresence initial={false}>
              {shown.flatMap((c, i) => {
                const prev = shown[i - 1];
                const reply = !!prev && prev.timecode != null && c.timecode != null && frameOf(prev.timecode, fps) === frameOf(c.timecode, fps);
                const out = [];
                if (i === firstGeneral && i > 0) {
                  out.push(<li key="general-label" aria-hidden className="eyebrow px-1 pb-2 pt-3">{t("General")}</li>);
                }
                out.push(
                  <CommentItem key={c.id} c={c} fps={fps} aspect={aspect} flow={flow} active={activeId === c.id} current={currentId === c.id && activeId !== c.id} reply={reply}
                    onSelect={() => onSelect(c)} onResolve={onResolve ? () => onResolve(c) : undefined} />,
                );
                return out;
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
      {composer && <div className={clsx("shrink-0", flow && "sticky bottom-0 z-10 rounded-b-xl bg-panel")}>{composer}</div>}
    </>
  );

  if (sheet) {
    return (
      <section aria-label={t("Comments")} className={clsx("flex shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-panel", className)}>
        <div className={clsx("flex shrink-0 items-center gap-2 px-3 py-2", sheet.open && "pb-1.5")}>
          <button type="button" aria-expanded={sheet.open} onClick={sheet.onToggle} className="-m-1 flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 text-left">
            {headTitle}
          </button>
          {sheet.open && navControl}
          {!sheet.open && sheet.onAdd && (
            <Button size="sm" variant="primary" icon={<Pencil className="size-3.5" />} onClick={sheet.onAdd} className="max-sm:h-10">{t("Add comment")}</Button>
          )}
          <IconButton title={sheet.open ? t("Hide comments") : t("Show comments")} onClick={sheet.onToggle} className="max-sm:!size-10">
            <ChevronUp className={clsx("size-4 transition-transform duration-200", sheet.open && "rotate-180")} />
          </IconButton>
        </div>
        {sheet.open && chips && <div className="shrink-0 border-b border-line px-3 pb-2">{chips}</div>}
        <div
          inert={!sheet.open}
          className="flex min-h-0 flex-col overflow-hidden transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ height: sheet.open ? sheet.height : 0 }}
        >
          {body}
        </div>
      </section>
    );
  }

  return (
    <section aria-label={t("Comments")} className={clsx("hud flex min-h-0 flex-col rounded-xl border border-line bg-panel", className)}>
      <header className="shrink-0 space-y-2.5 border-b border-line px-3.5 pb-3 pt-3">
        <div className="flex items-center gap-2.5">
          {headTitle}
          <div className="flex-1" />
          {open === 0 && comments.length > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-ok"><CircleCheck className="size-3.5" />{t("All resolved")}</span>
          )}
          {navControl}
        </div>
        {chips}
      </header>
      {body}
    </section>
  );
}

/** The compose box: stamps the current (or pinned) timecode, carries the drawing, and sends on Enter. */
export const Composer = forwardRef<HTMLTextAreaElement, {
  fps: number; tc: number; useTc: boolean; setUseTc: (v: boolean) => void; pinned: boolean; onRepin: () => void;
  body: string; setBody: (v: string) => void; onSubmit: () => void; busy: boolean;
  strokes: number; drawing: boolean; onToggleDraw: () => void; onClearDrawing: () => void;
  guestName?: string; setGuestName?: (v: string) => void; onFocus?: () => void; placeholder?: string;
}>(function Composer(p, ref) {
  const t = useT();
  const needName = p.setGuestName !== undefined;
  const hasName = (p.guestName ?? "").trim().length > 0;
  const can = p.body.trim().length > 0 && (!needName || hasName) && !p.busy;
  // Typing the name saves it on every keystroke, so keep the field open until the person leaves it.
  const [editName, setEditName] = useState(() => !hasName);
  const prevBusy = useRef(false);
  useEffect(() => {
    if (prevBusy.current && !p.busy && hasName) setEditName(false);
    prevBusy.current = p.busy;
  }, [p.busy, hasName]);

  return (
    <div className="shrink-0 rounded-b-[0.5625rem] border-t border-line bg-panel p-2.5 sm:p-3">
      {needName && (
        <AnimatePresence initial={false} mode="wait">
          {hasName && !editName ? (
            <motion.p key="as" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
              className="mb-2 flex items-center gap-1.5 text-xs text-mute">
              <UserRound className="size-3.5 shrink-0 text-dim" />
              <span className="min-w-0 truncate">{t("Commenting as")} <b className="font-semibold text-ink">{p.guestName!.trim()}</b></span>
              <button type="button" onClick={() => setEditName(true)} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-mute hover:bg-hover hover:text-ink max-sm:h-10 max-sm:px-2.5">
                <Pencil className="size-3" />{t("Change")}
              </button>
            </motion.p>
          ) : (
            <motion.div key="name" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="mb-2">
              <Input value={p.guestName ?? ""} onChange={(e) => p.setGuestName!(e.target.value)} maxLength={80}
                onBlur={() => hasName && setEditName(false)}
                onKeyDown={(e) => { if (e.key === "Enter" && hasName) { e.preventDefault(); setEditName(false); } }}
                placeholder={t("Your name")} aria-label={t("Your name")} autoComplete="name"
                className={clsx(!hasName && p.body.trim() && "!border-warn/70")} />
              {!hasName && p.body.trim() && <p className="mt-1 text-2xs text-warn">{t("Add your name so the team knows who this is from.")}</p>}
            </motion.div>
          )}
        </AnimatePresence>
      )}
      <div className="rounded-xl border border-line bg-raised/50 transition-[border-color,box-shadow] focus-within:border-accent/70 focus-within:ring-[3px] focus-within:ring-accent/15">
        <textarea
          ref={ref}
          value={p.body}
          rows={2}
          maxLength={2000}
          onFocus={p.onFocus}
          onChange={(e) => p.setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (can) p.onSubmit();
            } else if (e.key === "Escape") {
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
          aria-label={t("Leave a comment…")}
          placeholder={p.placeholder ?? t("Leave a comment…")}
          className="block max-h-40 min-h-[52px] w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-sm text-ink outline-none placeholder:text-dim"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <TimecodeChip tc={p.tc} fps={p.fps} pressed={p.useTc} muted={!p.useTc} onClick={() => p.setUseTc(!p.useTc)}
            title={p.useTc ? t("Pinned to this timecode — click for a general comment") : t("General comment — click to pin to the timecode")} />
          {p.useTc && p.pinned && (
            <IconButton title={t("Use the current frame")} onClick={p.onRepin} className="!size-7 max-sm:!size-10"><RotateCcw className="size-3.5" /></IconButton>
          )}
          <button type="button" onClick={p.onToggleDraw} aria-pressed={p.drawing} title={t("Draw on the frame (D)")}
            className={clsx("inline-flex h-7 items-center gap-1 rounded-md px-2 text-2xs font-medium transition-colors max-sm:h-10",
              p.drawing ? "bg-accent text-black" : p.strokes ? "bg-accent/10 text-accent-ink hover:bg-accent/20" : "text-mute hover:bg-hover hover:text-ink")}>
            <PenLine className="size-3.5" />{p.strokes === 1 ? t("1 stroke") : p.strokes ? t("{n} strokes", { n: p.strokes }) : t("Draw")}
          </button>
          {p.strokes > 0 && !p.drawing && (
            <IconButton title={t("Remove drawing")} onClick={p.onClearDrawing} className="!size-7 max-sm:!size-10"><X className="size-3.5" /></IconButton>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="primary" loading={p.busy} disabled={!can} onClick={p.onSubmit} icon={<Send className="size-3.5" />} className="max-sm:h-10">
            {t("Send")}
          </Button>
        </div>
      </div>
      <p className="mt-1.5 hidden text-2xs text-dim lg:block">{t("Enter to send · Shift+Enter for a new line · D to draw · C to comment")}</p>
    </div>
  );
});
