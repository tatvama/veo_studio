/** Building blocks of the Settings window: a section, a row (label, help, control) and a status line. */
import { clsx } from "clsx";
import type { ReactNode } from "react";

export function Section({ id, title, blurb, children, actions }: { id: string; title: string; blurb?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section id={`s-${id}`} data-section={id} aria-labelledby={`h-${id}`} className="scroll-mt-4 rounded-2xl border border-line bg-panel shadow-card">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 id={`h-${id}`} className="text-[15px] font-semibold">{title}</h2>
          {blurb && <p className="text-2xs text-dim">{blurb}</p>}
        </div>
        {actions}
      </header>
      <div className="divide-y divide-line/70">{children}</div>
    </section>
  );
}

export function Row({ id, label, help, children, stack, className }: { id: string; label: ReactNode; help?: ReactNode; children?: ReactNode; stack?: boolean; className?: string }) {
  return (
    <div id={`i-${id}`} data-item={id} className={clsx("px-5 py-3.5 transition-colors data-[hit=true]:bg-accent/[0.07]", stack ? "space-y-2.5" : "flex flex-wrap items-center gap-x-6 gap-y-2", className)}>
      <div className={clsx("min-w-0", !stack && "flex-1 basis-64")}>
        <p className="text-sm font-medium">{label}</p>
        {help && <div className="mt-0.5 text-2xs leading-relaxed text-dim">{help}</div>}
      </div>
      {children !== undefined && <div className={clsx(!stack && "flex shrink-0 flex-wrap items-center gap-2")}>{children}</div>}
    </div>
  );
}

export function StatusLine({ tone = "info", children }: { tone?: "info" | "ok" | "warn" | "bad"; children: ReactNode }) {
  return (
    <p className={clsx("text-2xs leading-relaxed", tone === "ok" ? "text-ok" : tone === "warn" ? "text-amber-300" : tone === "bad" ? "text-red-300" : "text-mute")} role="status">{children}</p>
  );
}

/** A bar of used / free space. */
export function SpaceBar({ free, total, low }: { free: number; total: number; low?: boolean }) {
  const used = total > 0 ? 1 - free / total : 0;
  return (
    <div className="h-2 w-48 overflow-hidden rounded-full bg-raised ring-1 ring-inset ring-line" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label="Used space">
      <div className={clsx("h-full rounded-full", low ? "bg-warn" : "bg-accent")} style={{ width: `${Math.round(used * 100)}%` }} />
    </div>
  );
}
