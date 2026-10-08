/** Small shared building blocks for the growth / publishing / admin pages. */
import { clsx } from "clsx";
import { Check, Coins, Copy, Info, ShieldAlert, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { tr, useT } from "../../lib/i18n";
import { usd } from "../../lib/format";
import { useJobs } from "../../lib/queries";
import type { Job, SettingsPayload } from "../../lib/types";
import { Button, Modal } from "../ui";

// ── time ─────────────────────────────────────────────────────────────────────

/** Like format.ago() but translated. */
export function agoT(iso?: string | null): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return tr("in {n}d", { n: Math.max(1, Math.round(-s / 86400)) });
  if (s < 45) return tr("just now");
  if (s < 3600) return tr("{n}m ago", { n: Math.round(s / 60) });
  if (s < 86400) return tr("{n}h ago", { n: Math.round(s / 3600) });
  return tr("{n}d ago", { n: Math.round(s / 86400) });
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ── clipboard / downloads ────────────────────────────────────────────────────

/**
 * Write to the clipboard. Falls back to a hidden textarea + execCommand when the async Clipboard API is missing
 * (plain-http LAN addresses) or refused (page not focused).
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* try the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    Object.assign(ta.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function copyText(text: string, what?: string): Promise<boolean> {
  if (await writeClipboard(text)) {
    toast.success(what ? tr("{what} copied", { what }) : tr("Copied to clipboard"));
    return true;
  }
  toast.error(tr("Couldn't copy — select the text and copy it manually"));
  return false;
}

/** Copy with an inline confirmation: `copied` is true for ~1.6 s after a successful copy. */
export function useCopy(text: string, opts: { what?: string; toast?: boolean } = {}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback(async (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    if (!(await writeClipboard(text))) {
      toast.error(tr("Couldn't copy — select the text and copy it manually"));
      return false;
    }
    if (opts.toast) toast.success(opts.what ? tr("{what} copied", { what: opts.what }) : tr("Copied to clipboard"));
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
    return true;
  }, [text, opts.what, opts.toast]);
  return { copied, copy };
}

/**
 * Copy button with an inline "Copied" confirmation (no toast unless `toast` is set).
 *   size="sm"   → outline button with a label     size="icon" → square icon button
 */
export function CopyButton({ text, what, label, size = "sm", className, toast: withToast }: {
  text: string; what?: string; label?: ReactNode; size?: "sm" | "icon"; className?: string; toast?: boolean;
}) {
  const t = useT();
  const { copied, copy } = useCopy(text, { what, toast: withToast });
  if (size === "icon") {
    return (
      <button type="button" onClick={copy} title={copied ? t("Copied") : t("Copy")} aria-label={copied ? t("Copied") : t("Copy")}
        className={clsx("relative inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-hover max-sm:size-10",
          copied ? "text-green-300" : "text-mute hover:text-ink", className)}>
        <motion.span key={copied ? "ok" : "copy"} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.16 }} className="grid place-items-center">
          {copied ? <Check className="size-3.5" strokeWidth={2.6} /> : <Copy className="size-3.5" />}
        </motion.span>
        <span role="status" aria-live="polite" className="sr-only">{copied ? t("Copied") : ""}</span>
      </button>
    );
  }
  return (
    <Button type="button" size="sm" variant="outline" onClick={copy} className={clsx("max-sm:h-10", copied && "!border-ok/40 !text-green-300", className)}
      icon={<motion.span key={copied ? "ok" : "copy"} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.16 }} className="grid place-items-center">
        {copied ? <Check className="size-3.5" strokeWidth={2.6} /> : <Copy className="size-3.5" />}</motion.span>}>
      {copied ? t("Copied") : label ?? t("Copy")}
    </Button>
  );
}

/** Save a (same-origin) file through the browser's download flow. */
export function downloadUrl(url: string, name?: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name ?? decodeURIComponent(url.split("?")[0].split("/").pop() ?? "");
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── visual bits ──────────────────────────────────────────────────────────────

const NOTICE_TONES = {
  info: "border-info/30 bg-info/10",
  warn: "border-warn/30 bg-warn/10",
  bad: "border-bad/30 bg-bad/10",
  accent: "border-accent/30 bg-accent/10",
  neutral: "border-line bg-raised/50",
};
const NOTICE_ICON = {
  info: <Info className="mt-0.5 size-4 shrink-0 text-info" />,
  warn: <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />,
  bad: <ShieldAlert className="mt-0.5 size-4 shrink-0 text-bad" />,
  accent: <Info className="mt-0.5 size-4 shrink-0 text-accent-ink" />,
  neutral: <Info className="mt-0.5 size-4 shrink-0 text-mute" />,
};

export function Notice({ tone = "info", icon, children, className, action }: {
  tone?: keyof typeof NOTICE_TONES; icon?: ReactNode; children: ReactNode; className?: string; action?: ReactNode;
}) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={clsx("flex items-start gap-3 rounded-xl border px-4 py-3 text-sm text-ink", NOTICE_TONES[tone], className)}>
      {icon ?? NOTICE_ICON[tone]}
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** "Couldn't load this" block with a retry button (use when a page's main query fails). */
export function LoadError({ title, onRetry, retrying, className }: { title?: string; onRetry: () => void; retrying?: boolean; className?: string }) {
  const t = useT();
  return (
    <div className={clsx("mx-auto max-w-xl", className)}>
      <div role="alert" className="flex flex-col items-center rounded-2xl border border-bad/30 bg-bad/[0.06] px-6 py-10 text-center">
        <span className="mb-3 grid size-12 place-items-center rounded-2xl bg-bad/12 text-bad"><TriangleAlert className="size-6" /></span>
        <p className="font-semibold">{title ?? t("We couldn't load this page")}</p>
        <p className="mt-1 max-w-sm text-sm text-mute">{t("The server didn't respond. Check your connection and try again.")}</p>
        <Button className="mt-5" variant="outline" loading={retrying} onClick={onRetry}>{t("Try again")}</Button>
      </div>
    </div>
  );
}

/** Toggleable filter pill. */
export function Chip({ active, onClick, children, count, title, icon }: {
  active: boolean; onClick: () => void; children: ReactNode; count?: number; title?: string; icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={active}
      className={clsx("inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-95 max-sm:h-9",
        active ? "border-accent/50 bg-accent/15 text-ink" : "border-line text-mute hover:border-dim/60 hover:bg-hover hover:text-ink")}
    >
      {icon && <span className={active ? "text-accent-ink" : "text-dim"}>{icon}</span>}
      {children}
      {count !== undefined && <span className={clsx("tabular-nums", active ? "text-accent-ink" : "text-dim")}>{count}</span>}
    </button>
  );
}

export function CardHeader({ icon, title, sub, actions, className }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx("mb-4 flex flex-wrap items-start gap-x-3 gap-y-2", className)}>
      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent-ink ring-1 ring-inset ring-accent/20">{icon}</div>
      <div className="min-w-0 flex-1 basis-48">
        <h3 className="text-base font-semibold leading-tight tracking-tight">{title}</h3>
        {sub && <p className="mt-0.5 text-xs leading-relaxed text-mute sm:text-sm">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Label + hint on the left, a control on the right: the row used for switches and small selectors. */
export function SettingRow({ icon, label, hint, children, className }: { icon?: ReactNode; label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3", className)}>
      {icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-mute @max-sm:hidden">{icon}</span>}
      <div className="min-w-0 flex-1 basis-20">
        <p className="text-sm font-medium leading-tight">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-snug text-mute">{hint}</p>}
      </div>
      <div className="ml-auto shrink-0">{children}</div>
    </div>
  );
}

/** "n / limit" with a thin meter; turns amber past `soft` and red past `limit`. */
export function CharCount({ n, limit, soft, className }: { n: number; limit: number; soft?: number; className?: string }) {
  const t = useT();
  const over = n > limit;
  const warn = !over && soft !== undefined && n > soft;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 font-mono text-2xs tabular-nums", over ? "text-red-300" : warn ? "text-amber-300" : "text-dim", className)}
      title={over ? t("Over the {n} character limit", { n: limit }) : warn ? t("Recommended: under {n} characters", { n: soft ?? limit }) : t("{a} of {b} characters", { a: n, b: limit })}>
      <span aria-hidden className="relative h-1 w-8 overflow-hidden rounded-full bg-line">
        <span className={clsx("absolute inset-y-0 left-0 rounded-full transition-[width] duration-200", over ? "bg-bad" : warn ? "bg-warn" : "bg-ok/80")}
          style={{ width: `${Math.min(100, (n / limit) * 100)}%` }} />
      </span>
      {n}/{limit}
    </span>
  );
}

/** Shared motion presets (MotionConfig at the root honours reduced motion). */
export const listItem = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18, ease: "easeOut" as const },
};

export function Lift({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <motion.div layout {...listItem} whileHover={{ y: -2 }} className={className} onClick={onClick}>
      {children}
    </motion.div>
  );
}

// ── jobs ─────────────────────────────────────────────────────────────────────

/** Active jobs matching `match`; calls `onDone` when the last one finishes (to refresh data the live feed doesn't cover). */
export function useActiveJobs(match: (j: Job) => boolean, pid?: number, onDone?: () => void): Job[] {
  const { data } = useJobs(pid);
  const active = (data ?? []).filter(match);
  const n = active.length;
  const prev = useRef(n);
  const cb = useRef(onDone);
  useEffect(() => { cb.current = onDone; }, [onDone]);
  useEffect(() => {
    if (prev.current > 0 && n === 0) cb.current?.();
    prev.current = n;
  }, [n]);
  return active;
}

// ── cost estimates for single-endpoint paid actions ──────────────────────────

/** Same formula as the backend Estimator.image(): free when the image provider runs in mock mode. */
export function estimateImages(s: SettingsPayload | undefined, n: number): number {
  if (!s) return 0;
  const mode = s.providers.find((p) => p.provider === "gemini")?.mode;
  if (mode !== "live") return 0;
  const model = s.models?.image;
  const price = Number((s.prices?.image_each ?? {})[model] ?? 0.07);
  return n * price;
}

export function providerLive(s: SettingsPayload | undefined, provider: string): boolean {
  return s?.providers.find((p) => p.provider === provider)?.mode === "live";
}

/**
 * Confirmation for paid actions that don't go through /estimate (marketing pack, sound design).
 * The server still runs the budget check and may send the work for approval — `announce()` reports that.
 */
export function CostConfirm({ open, onClose, title, amount, lines, note, confirmLabel, onConfirm, children, disabled }: {
  open: boolean; onClose: () => void; title: string; amount: number; lines: { label: string; usd: number }[];
  note?: ReactNode; confirmLabel?: string; onConfirm: () => Promise<unknown>; children?: ReactNode; disabled?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      // `useGenerate().submit` resolves to undefined when the request failed (already toasted) — keep the dialog open then.
      if ((await onConfirm()) !== undefined) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-lg bg-accent/12 text-accent-ink"><Coins className="size-4" /></span>{title}</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="primary" loading={busy} disabled={disabled} onClick={go}>
          {confirmLabel ?? (amount > 0 ? t("Generate · {usd}", { usd: usd(amount) }) : t("Generate · free"))}
        </Button>
      </>}
    >
      <div className="space-y-4">
        {children}
        <div className="rounded-xl border border-line bg-raised/40">
          <div className="flex items-baseline justify-between gap-3 px-4 py-3">
            <span className="text-sm text-mute">{t("Estimated cost")}</span>
            <span className={clsx("text-2xl font-semibold tabular-nums tracking-tight", amount === 0 && "text-green-300")}>{amount > 0 ? `~${usd(amount)}` : t("Free")}</span>
          </div>
          {!!lines.length && (
            <div className="border-t border-line">
              {lines.map((l, i) => (
                <div key={i} className="flex justify-between gap-3 border-b border-line/60 px-4 py-2 text-sm last:border-0">
                  <span className="text-mute">{l.label}</span>
                  <span className="shrink-0 tabular-nums">{l.usd > 0 ? usd(l.usd) : t("free")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {note && <p className="text-xs leading-relaxed text-mute">{note}</p>}
        <p className="flex items-start gap-2 text-xs leading-relaxed text-dim"><Info className="mt-0.5 size-3.5 shrink-0" />{t("If this goes over a spending limit it is sent to a producer for approval instead of starting.")}</p>
      </div>
    </Modal>
  );
}

export const PLATFORM_LABELS: Record<string, string> = {
  youtube: "YouTube", youtube_shorts: "YouTube Shorts", instagram_reels: "Instagram Reels", instagram: "Instagram",
  facebook_reels: "Facebook Reels", facebook: "Facebook", whatsapp: "WhatsApp Status", tiktok: "TikTok", x: "X",
};

export function platformLabel(p: string): string {
  return PLATFORM_LABELS[p] ?? p.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
