import { clsx } from "clsx";
import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { copyText } from "../../../components/growth/common";
import { IconButton } from "../../../components/ui";
import { useT } from "../../../lib/i18n";

/** A label on the left and a value (mono) on the right: one line of a facts list. */
export function KV({ k, children, className }: { k: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex min-w-0 items-baseline justify-between gap-3 py-1.5 text-xs", className)}>
      <span className="shrink-0 text-mute">{k}</span>
      <span className="mono min-w-0 truncate text-right text-ink">{children}</span>
    </div>
  );
}

/** A file-system path: mono, truncated from the left so the folder name stays visible, with a copy button. */
export function PathLine({ path, className }: { path?: string | null; className?: string }) {
  const t = useT();
  if (!path) return <span className="text-xs text-dim">—</span>;
  return (
    <span className={clsx("flex min-w-0 items-center gap-1", className)}>
      <span className="mono min-w-0 flex-1 truncate text-xs text-ink [direction:rtl] [text-align:left]" title={path}>&lrm;{path}&lrm;</span>
      <IconButton title={t("Copy path")} className="!size-6" onClick={() => void copyText(path, t("Path"))}><Copy className="size-3" /></IconButton>
    </span>
  );
}

/** A sub-section inside a card, separated by a hairline. */
export function Sub({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("border-t border-line pt-3 first:border-0 first:pt-0", className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A quiet one-line note (the endpoint isn't on this server yet, nothing here yet…). */
export function Quiet({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={clsx("rounded-lg border border-dashed border-line px-3 py-2.5 text-xs leading-relaxed text-mute", className)}>{children}</p>;
}
