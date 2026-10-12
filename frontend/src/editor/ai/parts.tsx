/**
 * The AI panel's building blocks (docs/EDITOR.md §8): a collapsible tool section with its free / paid badge, a labelled
 * row, the run button with the price on it, notes, and the live price of a tool's calls.
 */
import { ChevronDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { usd } from "../../lib/format";
import { Badge, Button } from "../../components/ui";
import { estimate } from "./api";
import type { EditorHost } from "./host-types";
import type { ToolCall } from "./types";

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The studio key of media already sent (no upload just to show a price). */
export function knownKey(host: EditorHost, mediaId: string): string | null {
  const m = host.project().media.find((x) => x.id === mediaId);
  if (!m) return null;
  return m.path.startsWith("studio:") ? m.path.slice(7) : m.studioKey ?? null;
}

export interface Price { usd: number | null; ok: boolean; loading: boolean }

/** The price of `calls` while the section is open and the edit is connected to the studio (null calls: the media
 *  must be sent first, so the price comes in the confirm dialog). */
export function usePrice(host: EditorHost, open: boolean, make: () => ToolCall[] | null, deps: unknown[]): Price {
  const [st, setSt] = useState<Price>({ usd: null, ok: true, loading: false });
  const pid = host.studioProjectId();
  useEffect(() => {
    const calls = pid && open ? make() : null;
    if (!pid || !calls?.length) { setSt({ usd: null, ok: true, loading: false }); return; }
    let alive = true;
    setSt((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      Promise.all(calls.map((c) => estimate(pid, c)))
        .then((es) => alive && setSt({ usd: es.reduce((s, e) => s + e.total_usd, 0), ok: es.every((e) => e.budget.ok), loading: false }))
        .catch(() => alive && setSt({ usd: null, ok: true, loading: false }));
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  }, [pid, open, ...deps]);  // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

export const priceText = (p: Price) => (p.loading ? "…" : p.usd === null ? "see price" : p.usd > 0 ? `~${usd(p.usd)}${p.ok ? "" : " · approval"}` : p.ok ? "free" : "approval");

export function Section({ id, open, onToggle, icon, title, free, children, hint, badge }: {
  id: string; open: boolean; onToggle: (id: string) => void; icon: ReactNode; title: string; free?: boolean; children: ReactNode; hint?: string;
  /** Instead of free / paid (e.g. "studio" for backups and comments). */
  badge?: string;
}) {
  return (
    <div className="border-b border-line">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover" onClick={() => onToggle(id)} aria-expanded={open}>
        <span className="text-mute">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {hint && !open && <span className="truncate text-2xs text-dim">{hint}</span>}
        {badge ? <Badge>{badge}</Badge> : <Badge tone={free ? "ok" : "money"}>{free ? "free" : "paid"}</Badge>}
        <ChevronDown className={`size-4 shrink-0 text-dim transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="space-y-2.5 px-3 pb-3 pt-1">{children}</div>}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-mute">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

export function Go({ label, price, onClick, disabled, busy }: { label: string; price?: Price; onClick: () => unknown; disabled?: boolean; busy?: boolean }) {
  const [running, setRunning] = useState(false);
  return (
    <Button variant="primary" size="sm" block disabled={disabled} loading={running || busy}
      onClick={async () => { setRunning(true); try { await onClick(); } finally { setRunning(false); } }}>
      {label}{price && <span className="opacity-70">· {priceText(price)}</span>}
    </Button>
  );
}

export const Note = ({ children }: { children: ReactNode }) => <p className="text-2xs leading-snug text-dim">{children}</p>;
