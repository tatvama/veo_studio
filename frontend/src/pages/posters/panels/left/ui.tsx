/** Small building blocks shared by the left panel's tabs. Tokens only: these render the editor chrome, not the poster. */
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { create } from "zustand";
import { Button, Modal, Tooltip } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { tr, useT } from "../../../../lib/i18n";
import { useEditor } from "../../store";
import { DND_MIME, type DropPayload } from "../../types";
import { addPayload } from "./actions";

// ── sections ─────────────────────────────────────────────

/** A block of the panel with a header that sticks to the top while its content scrolls under it. */
export function Section({ title, icon, actions, children, className, bodyClassName, tone }: {
  title: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
  tone?: "ai" | "accent" | "money";
}) {
  return (
    <section className={cn("border-b border-line last:border-b-0", className)}>
      <header className="sticky top-0 z-10 flex h-9 items-center justify-between gap-2 border-b border-line/70 bg-panel/95 px-3 backdrop-blur-md">
        <span className={cn("eyebrow flex min-w-0 items-center gap-1.5 truncate", tone === "ai" && "text-ai", tone === "accent" && "text-accent-ink",
          tone === "money" && "text-money")}>
          {icon && <span className="shrink-0 [&>svg]:size-3.5">{icon}</span>}
          <span className="truncate">{title}</span>
        </span>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      <div className={cn("p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A compact toggle chip (filters, styles, presets). */
export function Chip({ on, onClick, children, title, className, disabled }: {
  on?: boolean; onClick?: () => void; children: ReactNode; title?: string; className?: string; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-45",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        on ? "border-accent/50 bg-accent/12 text-accent-ink" : "border-line bg-raised text-mute hover:bg-hover hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Muted helper copy under a control. */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-2xs leading-snug text-dim", className)}>{children}</p>;
}

// ── drag and drop ────────────────────────────────────────

/**
 * Start an HTML5 drag carrying a DropPayload. The drag image is the element marked `data-ghost` inside the item (the
 * thumbnail, the sample text, the shape), so what follows the cursor looks like the thing being placed.
 */
export function startDrag(e: DragEvent<HTMLElement>, payload: DropPayload) {
  e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "copy";
  const ghost = e.currentTarget.querySelector<HTMLElement>("[data-ghost]") ?? (e.currentTarget.hasAttribute("data-ghost") ? e.currentTarget : null);
  if (ghost) {
    const r = ghost.getBoundingClientRect();
    try { e.dataTransfer.setDragImage(ghost, Math.round(r.width / 2), Math.round(r.height / 2)); } catch { /* old browsers: default image */ }
  }
}

/**
 * Something the user can drag onto the canvas or click (Enter / Space) to add at the page centre.
 * `payload` is built lazily so it always uses the current design size.
 */
export function DragItem({ payload, onAdd, label, tip, className, style, children, tipSide = "right", disabled }: {
  payload: () => DropPayload | null; onAdd?: () => void; label: string; tip?: ReactNode; className?: string; style?: CSSProperties;
  children: ReactNode; tipSide?: "top" | "bottom" | "left" | "right"; disabled?: boolean;
}) {
  const add = () => {
    if (disabled) return;
    if (onAdd) { onAdd(); return; }
    const p = payload();
    if (p) addPayload(p);
  };
  const el = (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      draggable={!disabled}
      aria-label={label}
      aria-disabled={disabled || undefined}
      onDragStart={(e) => {
        const p = disabled ? null : payload();
        if (!p) { e.preventDefault(); return; }
        startDrag(e, p);
      }}
      onClick={add}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); add(); }
      }}
      style={style}
      className={cn("cursor-grab select-none outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-accent/50", className,
        disabled && "pointer-events-none cursor-default opacity-45")}
    >
      {children}
    </div>
  );
  return tip ? <Tooltip content={tip} side={tipSide} delay={500}>{el}</Tooltip> : el;
}

// ── lazy mounting ────────────────────────────────────────

/** Renders `children` only once the box scrolls into view (heavy previews), showing `placeholder` until then. */
export function LazyMount({ children, placeholder, className, style }: { children: ReactNode; placeholder?: ReactNode; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || on) return;
    if (typeof IntersectionObserver === "undefined") { setOn(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) { setOn(true); io.disconnect(); }
    }, { rootMargin: "160px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [on]);
  return <div ref={ref} className={className} style={style}>{on ? children : placeholder}</div>;
}

// ── image sizes ──────────────────────────────────────────

const sizes = new Map<string, { w: number; h: number }>();

export const rememberSize = (url: string, w: number, h: number) => { if (url && w && h) sizes.set(url, { w, h }); };
export const sizeOf = (url: string) => sizes.get(url);

/** Natural size of an image (loads it once; cached for the session). */
export function useNaturalSize(url: string | null | undefined) {
  const [s, setS] = useState(() => (url ? sizes.get(url) ?? null : null));
  useEffect(() => {
    if (!url) { setS(null); return; }
    const hit = sizes.get(url);
    if (hit) { setS(hit); return; }
    let live = true;
    const im = new Image();
    im.onload = () => {
      rememberSize(url, im.naturalWidth, im.naturalHeight);
      if (live) setS({ w: im.naturalWidth, h: im.naturalHeight });
    };
    im.src = url;
    return () => { live = false; };
  }, [url]);
  return s;
}

/** onLoad handler for thumbnails that show the full image: records its natural size for drag payloads. */
export const recordSize = (url: string) => (e: React.SyntheticEvent<HTMLImageElement>) =>
  rememberSize(url, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);

// ── confirm ──────────────────────────────────────────────

interface ConfirmReq { title: string; body: string; confirm: string; resolve: (ok: boolean) => void }
const useConfirm = create<{ req: ConfirmReq | null }>(() => ({ req: null }));

export function askConfirm(req: Omit<ConfirmReq, "resolve">): Promise<boolean> {
  const prev = useConfirm.getState().req;
  prev?.resolve(false);
  return new Promise((resolve) => useConfirm.setState({ req: { ...req, resolve } }));
}

/** Ask before a template or AI layout replaces a design that already has layers. Resolves true at once on an empty page. */
export function confirmReplace(what: string): Promise<boolean> {
  if (!useEditor.getState().doc.layers.length) return Promise.resolve(true);
  return askConfirm({
    title: tr("Replace this design?"),
    body: tr("{what} replaces the current layers. Images in matching slots are carried over, and Undo brings the old design back.", { what }),
    confirm: tr("Replace"),
  });
}

/** Mount once (the left panel does) to show `askConfirm` dialogs. */
export function ConfirmHost() {
  const t = useT();
  const req = useConfirm((s) => s.req);
  const close = (ok: boolean) => {
    const r = useConfirm.getState().req;
    useConfirm.setState({ req: null });
    r?.resolve(ok);
  };
  return (
    <Modal open={!!req} onClose={() => close(false)} title={req?.title ?? ""} size="sm"
      footer={<>
        <Button variant="ghost" onClick={() => close(false)}>{t("Cancel")}</Button>
        <Button variant="primary" data-autofocus onClick={() => close(true)}>{req?.confirm ?? t("OK")}</Button>
      </>}>
      <p className="text-sm leading-relaxed text-mute">{req?.body}</p>
    </Modal>
  );
}
