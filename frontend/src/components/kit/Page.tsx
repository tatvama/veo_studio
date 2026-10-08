import { cn } from "../../lib/cn";
import { ChevronLeft } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { rise } from "./Motion";

const WIDTHS = {
  narrow: "max-w-3xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
  full: "max-w-none",
} as const;

/**
 * Standard page frame: scrolls on its own, centres content, and uses one set of paddings everywhere.
 *   <Page width="wide"> <PageHeader title=… /> … </Page>
 */
export function Page({ children, width = "default", className, flush }: {
  children: ReactNode; width?: keyof typeof WIDTHS; className?: string; flush?: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden overscroll-contain" data-page-scroller>
      <div className={cn("mx-auto w-full", WIDTHS[width], flush ? "" : "px-4 py-6 sm:px-6 sm:py-8 lg:px-8", className)}>{children}</div>
    </div>
  );
}

/** Page title block: optional icon chip, h1, subtitle, back link and right-aligned actions. */
export function PageHeader({ title, subtitle, icon, actions, back, eyebrow, className }: {
  title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode; back?: { to: string; label: string }; eyebrow?: ReactNode; className?: string;
}) {
  const r = rise(0);
  return (
    <header {...r} className={cn("mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3", r.className, className)}>
      <div className="min-w-0 flex-1 basis-64">
        {back && (
          <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-mute transition-colors hover:text-ink">
            <ChevronLeft className="size-3.5" />{back.label}
          </Link>
        )}
        {eyebrow && <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.12em] text-accent-ink">{eyebrow}</div>}
        <div className="flex items-center gap-3">
          {icon && <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent-ink ring-1 ring-inset ring-accent/20">{icon}</span>}
          <div className="min-w-0">
            <h1 className="text-balance text-2xl font-semibold leading-tight tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 max-w-2xl text-sm text-mute">{subtitle}</p>}
          </div>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Titled block inside a page (h2 + optional description and actions). */
export function Section({ title, description, actions, children, className, id }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  return (
    <section id={id} className={cn("mb-8 scroll-mt-20", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-mute">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Sets the browser tab title, e.g. "Storyboard · My project — VEO Studio". */
export function useDocumentTitle(...parts: (string | undefined | null | false)[]) {
  const title = [...parts.filter(Boolean)].join(" · ");
  useEffect(() => {
    document.title = title ? `${title} — VEO Studio` : "VEO Studio";
  }, [title]);
}

/** Placeholder shaped like a typical page (header + a grid of cards), shown while a route's code or data loads. */
export function PageSkeleton({ cards = 6, className }: { cards?: number; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8", className)} aria-busy="true" aria-live="polite">
      <div className="mb-6 flex items-center gap-3">
        <div className="skeleton size-10 rounded-xl" />
        <div className="space-y-2">
          <div className="skeleton h-6 w-56 rounded-lg" />
          <div className="skeleton h-3.5 w-80 max-w-[60vw] rounded-md" />
        </div>
      </div>
      <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="anim-fade rounded-xl border border-line bg-panel p-4" style={{ "--i": i } as React.CSSProperties}>
            <div className="skeleton mb-4 aspect-video rounded-lg" />
            <div className="skeleton mb-2 h-4 w-3/4 rounded-md" />
            <div className="skeleton h-3 w-1/2 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
