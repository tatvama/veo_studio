import { clsx } from "clsx";
import { PenLine } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import type { Stroke } from "../../lib/types";
import { Tooltip } from "../ui";
import { CommentsPanel, Composer } from "./CommentsPanel";
import { DrawCanvas, DrawToolbar, PEN_COLORS, PEN_SIZES } from "./DrawCanvas";
import { ReviewPlayer, type PlayerHandle } from "./ReviewPlayer";
import {
  createClock, formatTC, frameOf, isTypingTarget, lsGet, lsSet, sortComments, useClockThrottled, useElementWidth, type Marker, type RComment,
} from "./utils";

export interface NewComment { body: string; timecode: number | null; drawing: Stroke[] }

/** Container width from which the player and the comments sit side by side. */
/** Width (px) from which the player and the comments sit side by side. */
export const WORKSPACE_WIDE = 700;
const WIDE = WORKSPACE_WIDE;

/**
 * Player + frame drawing + timecoded comments. Used by the internal Review page and the public client review page;
 * the caller supplies the comments and how to add / resolve them.
 *
 * Layout adapts to the width of its own box: side by side when wide (it then fills the height of its parent), stacked
 * when narrow. When stacked, `mobileFill` makes the comment list take the remaining height of the parent (phone app
 * layout) instead of a fixed height.
 */
export function ReviewWorkspace({
  src, poster, fps, peaks, durationHint, aspectHint, comments, loadingComments, commentsError, onRetryComments, canComment, notice, onAdd, onResolve, guest,
  simple = false, mobileFill = false, layout, stageMax, panelClassName, toolbarExtra, header, className, shortcutsExtra,
}: {
  src: string; poster?: string; fps: number; peaks?: number[]; durationHint?: number; aspectHint?: number; comments: RComment[];
  loadingComments?: boolean; commentsError?: boolean; onRetryComments?: () => void; canComment: boolean; notice?: ReactNode; onAdd: (c: NewComment) => Promise<void>;
  onResolve?: (c: RComment) => Promise<void>; guest?: { name: string; setName: (n: string) => void }; simple?: boolean;
  mobileFill?: boolean; /** Force the arrangement; when omitted it follows the width of this component. */ layout?: "wide" | "stacked";
  stageMax?: string; panelClassName?: string; toolbarExtra?: ReactNode; header?: ReactNode; className?: string;
  shortcutsExtra?: [string, string][];
}) {
  const t = useT();
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const wide = layout ? layout === "wide" : width >= WIDE;
  /** Phones: the comments live in a bottom sheet so the picture stays big. */
  const phone = !wide && mobileFill;
  const [sheetOpen, setSheetOpen] = useState(false);
  const clock = useMemo(() => createClock(), []);
  const time = useClockThrottled(clock, 100);
  const player = useRef<PlayerHandle>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [playing, setPlaying] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [draft, setDraft] = useState<Stroke[]>([]);
  const [color, setColorState] = useState(() => (PEN_COLORS.includes(lsGet("veo-pen-color")) ? lsGet("veo-pen-color") : PEN_COLORS[0]));
  const [size, setSize] = useState(PEN_SIZES[1]);
  const [body, setBodyState] = useState("");
  const [useTc, setUseTc] = useState(true);
  const [pinned, setPinned] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => sortComments(comments), [comments]);
  const markers: Marker[] = useMemo(() => sorted.filter((c) => c.timecode != null).map((c) => ({
    id: c.id, time: c.timecode as number, resolved: c.resolved, author: c.author.replace(/\s*\(client\)$/, ""), body: c.body,
    drawing: c.drawing.length > 0,
  })), [sorted]);
  const active = sorted.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    setActiveId(null);
    setDraft([]);
    setPinned(null);
    setDrawMode(false);
  }, [src]);
  useEffect(() => { if (playing) setDrawMode(false); }, [playing]);

  // After sending a note, highlight it in the list once it arrives.
  const knownIds = useRef<Set<number>>(new Set(comments.map((c) => c.id)));
  const awaitNew = useRef(false);
  useEffect(() => {
    if (awaitNew.current) {
      const added = comments.filter((c) => !knownIds.current.has(c.id));
      if (added.length) {
        awaitNew.current = false;
        setActiveId(added[added.length - 1].id);
      }
    }
    knownIds.current = new Set(comments.map((c) => c.id));
  }, [comments]);

  const setColor = (c: string) => { setColorState(c); lsSet("veo-pen-color", c); };
  const frame = frameOf(time, fps);

  // which drawing is on screen: the one being drawn, the selected comment's, or any comment parked on this frame
  const [shown, shownKey] = useMemo((): [Stroke[], string] => {
    if (drawMode) return [draft, "draft"];
    if (playing) return [[], ""];
    if (active?.drawing.length && (active.timecode == null || frameOf(active.timecode, fps) === frame)) return [active.drawing, `c${active.id}`];
    if (draft.length && pinned != null && frameOf(pinned, fps) === frame) return [draft, "draft"];
    const hit = sorted.find((c) => c.timecode != null && c.drawing.length > 0 && frameOf(c.timecode, fps) === frame && !c.resolved);
    return hit ? [hit.drawing, `c${hit.id}`] : [[], ""];
  }, [drawMode, draft, playing, active, frame, fps, pinned, sorted]);

  const select = (c: RComment) => {
    setActiveId(c.id);
    setDrawMode(false);
    if (phone) setSheetOpen(true);
    if (c.timecode != null) {
      player.current?.pause();
      player.current?.seek(c.timecode);
    }
  };

  const openComposer = () => {
    setSheetOpen(true);
    window.setTimeout(() => composerRef.current?.focus({ preventScroll: true }), 320);
  };

  const setBody = (v: string) => {
    setBodyState(v);
    if (v.trim() && pinned == null) setPinned(clock.get());
    if (!v.trim() && !draft.length) setPinned(null);
  };

  const toggleDraw = () => {
    if (!canComment) return;
    if (drawMode) {
      setDrawMode(false);
      return;
    }
    player.current?.pause();
    setActiveId(null);
    if (draft.length && pinned != null) player.current?.seek(pinned);
    else setPinned(clock.get());
    setUseTc(true);
    setSheetOpen(false); // give the picture all the room while drawing
    setDrawMode(true);
  };
  /** Pen toolbar "Done": on a phone continue straight to writing the note. */
  const finishDraw = () => {
    setDrawMode(false);
    if (phone && draft.length) openComposer();
  };
  const addStroke = (s: Stroke) => {
    setDraft((d) => [...d, s].slice(-50));
    if (pinned == null) setPinned(clock.get());
  };
  const undo = () => setDraft((d) => d.slice(0, -1));

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    awaitNew.current = true;
    try {
      const tc = useTc ? Math.round((pinned ?? clock.get()) * 1000) / 1000 : null;
      await onAdd({ body: text, timecode: tc, drawing: useTc ? draft : [] });
      setBodyState("");
      setDraft([]);
      setPinned(null);
      setDrawMode(false);
      setUseTc(true);
    } catch {
      /* the caller already showed the error; keep the draft */
      awaitNew.current = false;
    } finally {
      setBusy(false);
    }
  };

  const keys = useRef({ toggleDraw, undo, drawMode, activeId });
  keys.current = { toggleDraw, undo, drawMode, activeId };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const k = keys.current;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        if (k.drawMode) { e.preventDefault(); k.undo(); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        k.toggleDraw();
      } else if ((e.key === "c" || e.key === "C") && composerRef.current) {
        e.preventDefault();
        composerRef.current.focus();
      } else if (e.key === "Escape") {
        if (k.drawMode) setDrawMode(false);
        else if (k.activeId != null) setActiveId(null);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const fillPlayer = wide || mobileFill;
  return (
    <div
      ref={rootRef}
      className={clsx(
        "min-h-0",
        wide ? "grid h-full grid-cols-[minmax(0,1fr)_clamp(300px,36%,380px)] grid-rows-[minmax(0,1fr)] gap-4"
          : mobileFill ? "flex h-full flex-col gap-2" : "flex flex-col gap-3",
        className,
      )}
    >
      <div className={clsx("flex min-h-0 min-w-0 flex-col gap-2", wide && "h-full", !wide && mobileFill && "flex-1")}>
        {header}
        <ReviewPlayer
          className={fillPlayer ? "min-h-0 flex-1" : undefined}
          fill={fillPlayer}
          stageMax={stageMax}
          handleRef={player}
          src={src}
          poster={poster}
          fps={fps}
          peaks={peaks}
          durationHint={durationHint}
          aspectHint={aspectHint}
          clock={clock}
          markers={markers}
          activeMarker={activeId}
          onMarker={(id) => { const c = sorted.find((x) => x.id === id); if (c) select(c); }}
          onPlayingChange={setPlaying}
          stageClickable={!drawMode}
          simple={simple}
          shortcutsExtra={shortcutsExtra}
          overlay={(rect) => (
            <>
              {drawMode && <div className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-accent/70" />}
              <AnimatePresence>
                {(shown.length > 0 || drawMode) && (
                  <motion.div key={shownKey} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                    <DrawCanvas width={rect.width} height={rect.height} strokes={shown} editable={drawMode} color={color} size={size} onStroke={addStroke} />
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
          stageOverlay={
            <AnimatePresence>
              {drawMode && (
                <motion.div key="draw-chip" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}
                  className="pointer-events-none absolute left-2 top-2 z-20 inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 font-mono text-2xs font-semibold text-black shadow-lg">
                  <PenLine className="size-3" />{formatTC(pinned ?? time, fps, true)}
                </motion.div>
              )}
            </AnimatePresence>
          }
          dock={
            <AnimatePresence initial={false}>
              {drawMode && (
                <DrawToolbar key="pen" color={color} setColor={setColor} size={size} setSize={setSize} count={draft.length}
                  onUndo={undo} onClear={() => setDraft([])} onDone={finishDraw} />
              )}
            </AnimatePresence>
          }
          toolbar={
            <>
              {toolbarExtra}
              {canComment && (
                <Tooltip content={t("Draw on the frame (D)")}>
                  <button
                    type="button"
                    onClick={toggleDraw}
                    aria-pressed={drawMode}
                    aria-label={t("Draw on the frame (D)")}
                    className={clsx("mr-0.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors max-sm:h-10 max-sm:px-3",
                      drawMode ? "bg-accent text-black" : "text-mute hover:bg-hover hover:text-ink")}
                  >
                    <PenLine className="size-4" /><span className="@max-lg:hidden">{t("Draw")}</span>
                  </button>
                </Tooltip>
              )}
            </>
          }
        />
      </div>
      <CommentsPanel
        className={clsx(wide ? "h-full" : phone ? "shrink-0" : "h-[min(72vh,560px)]", panelClassName)}
        sheet={phone ? { open: sheetOpen, onToggle: () => setSheetOpen((o) => !o), height: "min(44dvh, 400px)", onAdd: canComment ? openComposer : undefined } : undefined}
        comments={sorted}
        fps={fps}
        time={time}
        playing={playing}
        activeId={activeId}
        onSelect={select}
        onResolve={onResolve}
        loading={loadingComments}
        error={commentsError}
        onRetry={onRetryComments}
        notice={notice}
        composer={canComment ? (
          <Composer
            ref={composerRef}
            fps={fps}
            tc={pinned ?? time}
            useTc={useTc}
            setUseTc={setUseTc}
            pinned={pinned != null && frameOf(pinned, fps) !== frame}
            onRepin={() => setPinned(clock.get())}
            body={body}
            setBody={setBody}
            onSubmit={submit}
            busy={busy}
            strokes={draft.length}
            drawing={drawMode}
            onToggleDraw={toggleDraw}
            onClearDrawing={() => { setDraft([]); if (!body.trim()) setPinned(null); }}
            guestName={guest?.name}
            setGuestName={guest?.setName}
            onFocus={() => player.current?.pause()}
          />
        ) : null}
      />
    </div>
  );
}
