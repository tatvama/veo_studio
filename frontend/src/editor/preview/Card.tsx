/**
 * The preview card (preview-polish): a consistent 16:9 frame with a subtle inner border, the item rendered by the real
 * engine on the chosen picture (a skeleton shimmer while it renders), its name with the category colour dot and a
 * one-line description; selected, hover and keyboard-focus states; hover scrubs and loops it (player.ts), and after
 * 400 ms the Program monitor shows it applied (live.ts). Clicks are the panel's own (apply behaviour unchanged).
 * Also PreviewFrame (the frame alone, for list rows) and PreviewPopover (a large frame a list row drives).
 */
import "./preview.css";
import { clsx } from "clsx";
import { Check } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sizeBucket } from "./keys";
import { beginLive, endLive, type LiveSpec } from "./live";
import { CardPlayer, type CardState } from "./player";
import type { FrameChoice, PreviewItem } from "./service";
import { installPreviewDebug } from "./debug";

installPreviewDebug();

/** The frame's CSS width → its render size (device pixels), following resizes. */
function useBucket(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } | null {
  const [b, setB] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const upd = () => { const w = el.clientWidth; if (w > 0) { const nb = sizeBucket(w, window.devicePixelRatio || 1); setB((o) => (o && o.w === nb.w ? o : nb)); } };
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return b;
}

/** True once the element is near the viewport (and while it stays there). */
function useNear(ref: React.RefObject<HTMLElement | null>, margin = "240px"): boolean {
  const [v, setV] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setV(es.some((e) => e.isIntersecting)), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return v;
}

/** A CardPlayer on a canvas, configured from props. */
function usePlayer(item: PreviewItem, choice: FrameChoice, frameRef: React.RefObject<HTMLElement | null>, fixed?: { w: number; h: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const hud = useRef<HTMLSpanElement>(null);
  const player = useRef<CardPlayer | null>(null);
  const [state, setState] = useState<CardState>("loading");
  const measured = useBucket(frameRef);
  const bucket = fixed ?? measured;
  const near = useNear(frameRef);
  useEffect(() => {
    const p = new CardPlayer(cv.current!, setState, hud.current);
    player.current = p;
    return () => { p.dispose(); player.current = null; };
  }, []);
  useEffect(() => { if (bucket) player.current?.configure(item, choice, bucket); }, [item, choice, bucket?.w, bucket?.h]);
  useEffect(() => { player.current?.setVisible(near); }, [near]);
  return { cv, hud, player, state };
}

export interface CardProps {
  item: PreviewItem;
  choice: FrameChoice;
  name: ReactNode;
  desc?: ReactNode;
  /** The category colour (a CSS colour). */
  dot?: string;
  /** Small text at the right of the name (a length, a group). */
  meta?: ReactNode;
  selected?: boolean;
  /** The item is on the chosen clips now (a check badge). */
  applied?: boolean;
  /** Extra things over the frame (top right), e.g. a favourite star. */
  corner?: ReactNode;
  /** The Program monitor's live preview of it (null: none). */
  live?: LiveSpec | null;
  title?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  onDoubleClick?: (e: MouseEvent<HTMLElement>) => void;
  /** data-* attributes for the card (the panels' tests and QA find cards by them). */
  data?: Record<string, string>;
  className?: string;
  style?: CSSProperties;
}

export function PreviewCard({ item, choice, name, desc, dot, meta, selected, applied, corner, live, title, onClick, onDoubleClick, data, className, style }: CardProps) {
  const frame = useRef<HTMLDivElement>(null);
  const { cv, hud, player, state } = usePlayer(item, choice, frame);
  const liveTimer = useRef(0);
  const liveOn = useRef(false);
  const startLive = () => {
    window.clearTimeout(liveTimer.current);
    if (!live) return;
    liveTimer.current = window.setTimeout(() => { liveOn.current = beginLive(live); }, 400);
  };
  const stopLive = (why = "leave") => { window.clearTimeout(liveTimer.current); if (liveOn.current && live) endLive(live.key, why); liveOn.current = false; };
  useEffect(() => () => stopLive("card changed"), [live?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const attrs = Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));
  return (
    <div role="button" tabIndex={0} aria-pressed={selected ?? undefined} title={title} {...attrs} data-pv-state={state}
      className={clsx("pv-card", selected && "is-selected", className)} style={style}
      onClick={onClick} onDoubleClick={onDoubleClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(e as unknown as MouseEvent<HTMLElement>); } }}
      onPointerEnter={() => { player.current?.enter(); startLive(); }}
      onPointerMove={(e) => { const r = frame.current?.getBoundingClientRect(); if (r) player.current?.move(e.clientX, r.left, r.width); }}
      onPointerLeave={() => { player.current?.leave(); stopLive("pointer left"); }}
      onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) startLive(); }}
      onBlur={() => stopLive("blur")}>
      <div ref={frame} className="pv-frame">
        <canvas ref={cv} aria-hidden />
        {state === "loading" && <div className="pv-skel" />}
        {state === "none" && <div className="pv-none" style={dot ? { background: `linear-gradient(135deg, color-mix(in srgb, ${dot} 45%, #0b0d12), #0b0d12)` } : undefined}>No preview</div>}
        <span ref={hud} className="pv-hud" />
        {applied && <span className="pv-applied" title="On these clips now"><Check className="size-3" /></span>}
        {corner && <span className="pv-corner" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>{corner}</span>}
      </div>
      <div className="pv-meta">
        <p className="pv-name">{dot && <span className="pv-dot" style={{ background: dot }} />}<span className="truncate">{name}</span>{meta && <span className="pv-meta-r">{meta}</span>}</p>
        {desc && <p className="pv-desc">{desc}</p>}
      </div>
    </div>
  );
}

/** The frame alone (list rows): a still, with the hover animation when the row passes pointer events in. */
export function PreviewFrame({ item, choice, className, width }: { item: PreviewItem; choice: FrameChoice; className?: string; width?: number }) {
  const frame = useRef<HTMLDivElement>(null);
  const fixed = width ? sizeBucket(width, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1) : undefined;
  const { cv, hud, state } = usePlayer(item, choice, frame, fixed);
  return (
    <div ref={frame} className={clsx("pv-frame pv-frame-sm", className)} style={width ? { width } : undefined} data-pv-state={state}>
      <canvas ref={cv} aria-hidden />
      {state === "loading" && <div className="pv-skel" />}
      <span ref={hud} className="pv-hud" hidden />
    </div>
  );
}

/** The open popover's pointer handler (a list row forwards its pointer moves here: no re-render per move). */
let activePop: ((clientX: number) => void) | null = null;
/** A list row's pointer move → the open popover scrubs. */
export function movePopover(clientX: number) { activePop?.(clientX); }

/**
 * A large animated preview next to a list row: the row's pointer x (movePopover) scrubs it, holding still plays
 * it; `live` shows it on the Program monitor 400 ms after the row was entered (`enteredAt`).
 */
export function PreviewPopover({ item, choice, rect, title, sub, live, enteredAt }: { item: PreviewItem; choice: FrameChoice; rect: DOMRect; title: ReactNode; sub?: ReactNode; live?: LiveSpec | null; enteredAt?: number }) {
  const frame = useRef<HTMLDivElement>(null);
  const fixed = sizeBucket(232, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const { cv, hud, player, state } = usePlayer(item, choice, frame, fixed);
  useEffect(() => {
    const p = player.current;
    if (p) p.priority = 60;
    p?.setVisible(true); p?.enter();
    const move = (x: number) => p?.move(x, rect.left, rect.width);
    activePop = move;
    return () => { if (activePop === move) activePop = null; p?.leave(); };
  }, [item, rect.left, rect.width]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!live) return;
    let on = false;
    const id = window.setTimeout(() => { on = beginLive(live); }, Math.max(0, 400 - (performance.now() - (enteredAt ?? performance.now()))));
    return () => { window.clearTimeout(id); if (on) endLive(live.key); };
  }, [live?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const left = Math.min(window.innerWidth - 256, rect.right + 8), top = Math.max(8, Math.min(window.innerHeight - 190, rect.top - 40));
  return createPortal(
    <div className="pv-pop hud pointer-events-none fixed z-[85]" style={{ left, top }} data-pv-pop={item.id}>
      <div ref={frame} className="pv-frame" style={{ width: 232 }}>
        <canvas ref={cv} aria-hidden />
        {state === "loading" && <div className="pv-skel" />}
        {state === "none" && <div className="pv-none">No preview</div>}
        <span ref={hud} className="pv-hud" />
      </div>
      <p className="pv-name mt-1.5">{title}</p>
      {sub && <p className="pv-desc">{sub}</p>}
      {live && <p className="pv-desc">Move across to scrub · the Program monitor shows it on your edit</p>}
    </div>,
    document.body,
  );
}
