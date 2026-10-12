/**
 * The frame of the desktop's own pages (Start, Settings, the first-run steps): the workspace ground, one scroll area,
 * a width that reads well, and the window title. Consistent loading / empty / error blocks for their cards.
 */
import { clsx } from "clsx";
import { CircleAlert, RotateCw } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Button, Skeleton } from "../../components/ui";

export function DesktopPage({ title, children, wide, className }: { title: string; children: ReactNode; wide?: boolean; className?: string }) {
  useEffect(() => { document.title = `${title} · Tatvam Studio`; }, [title]);
  return (
    <div className={clsx("desk-ui hud-bg h-full overflow-y-auto overscroll-contain bg-bg text-ink", className)}>
      <main className={clsx("mx-auto px-6 pb-12 pt-7", wide ? "max-w-7xl" : "max-w-6xl")}>{children}</main>
    </div>
  );
}

export function LoadingRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return <div className={clsx("grid gap-2", className)} aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>;
}

export function ErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-xl border border-bad/25 bg-bad/8 px-3.5 py-2.5 text-sm">
      <CircleAlert className="size-4 shrink-0 text-red-300" />
      <span className="min-w-0 flex-1 text-mute">{message}</span>
      {onRetry && <Button size="sm" variant="ghost" icon={<RotateCw className="size-3.5" />} onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function EmptyRow({ icon, title, sub, action }: { icon?: ReactNode; title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-8 text-center">
      {icon && <span className="grid size-10 place-items-center rounded-xl border border-line bg-raised text-mute">{icon}</span>}
      <p className="text-sm font-medium">{title}</p>
      {sub && <p className="max-w-sm text-2xs leading-relaxed text-dim">{sub}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** A card of the desktop pages: a titled panel with optional actions. */
export function Card({ title, icon, actions, children, className, id, flush }: {
  title: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; flush?: boolean;
}) {
  return (
    <section id={id} className={clsx("rounded-2xl border border-line bg-panel shadow-card", className)} aria-label={typeof title === "string" ? title : undefined}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        {icon && <span className="text-mute [&>svg]:size-4">{icon}</span>}
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="flex-1" />
        {actions}
      </header>
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}
