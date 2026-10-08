import { clsx } from "clsx";
import { ArrowDown, Check, Copy, Sparkles, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ago } from "../../lib/format";
import { getUiLanguage, tr, useT } from "../../lib/i18n";
import type { AgentMessage, UserBrief } from "../../lib/types";
import { Alert, Button, rise, Skeleton } from "../ui";
import { ConfirmCard } from "./ConfirmCard";
import { Proposal, type Decision } from "./Proposal";
import { RichText, splitNote } from "./RichText";
import { DirectorMark, ThinkingDots, type Suggestion } from "./shared";

const EASE = [0.22, 1, 0.36, 1] as const;
const CLUSTER_MS = 5 * 60_000;

const reducedMotion = () => {
  try {
    return document.documentElement.dataset.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

function dayKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return tr("Today");
  if (diff === 1) return tr("Yesterday");
  try {
    return new Intl.DateTimeFormat(getUiLanguage(), { weekday: "short", day: "numeric", month: "short" }).format(d);
  } catch {
    return d.toDateString();
  }
}

const fullTime = (iso: string) => {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
};

interface Item { m: AgentMessage; day: string | null; head: boolean; tail: boolean }

function useItems(messages: AgentMessage[] | undefined): Item[] {
  return useMemo(() => {
    const list = messages ?? [];
    return list.map((m, i) => {
      const prev = list[i - 1];
      const next = list[i + 1];
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      const same = (a: AgentMessage, b: AgentMessage) =>
        a.role === b.role && a.user?.id === b.user?.id && dayKey(a.created_at) === dayKey(b.created_at)
        && Math.abs(new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) < CLUSTER_MS;
      return {
        m,
        day: newDay ? dayLabel(m.created_at) : null,
        head: newDay || !prev || !same(prev, m),
        tail: !next || !same(m, next),
      };
    });
  }, [messages]);
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={done ? t("Copied") : t("Copy")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1400);
        } catch {
          toast.error(tr("Couldn't copy"));
        }
      }}
      className="-my-1 grid size-7 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink"
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** Time / sender line under a bubble. Always laid out (no jumping), only visible on hover / focus / touch. */
function Meta({ iso, label, align, children }: { iso: string; label: string; align: "left" | "right"; children?: React.ReactNode }) {
  return (
    <div
      className={clsx(
        "mt-0.5 flex h-5 items-center gap-1 px-1 text-2xs text-dim opacity-0 transition-opacity duration-150",
        "group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
        align === "right" && "justify-end",
      )}
    >
      <span className="truncate">{label}</span>
      <span aria-hidden>·</span>
      <time dateTime={iso} title={fullTime(iso)} className="shrink-0">{ago(iso)}</time>
      {children}
    </div>
  );
}

const Row = memo(function Row({ item, me, boot, canEdit, decisions, busy, onDecide, confirmBusy, onConfirm }: {
  item: Item; me?: UserBrief | null; boot: boolean; canEdit: boolean;
  decisions: Record<string, Decision>; busy: Record<string, "approve" | "reject">; onDecide: (batch: string, kind: "approve" | "reject") => void;
  confirmBusy: Record<string, "yes" | "no">; onConfirm: (messageId: number, id: string, approve: boolean) => void;
}) {
  const t = useT();
  const { m, head, tail, day } = item;
  const mine = m.role === "user";
  const proposals = m.data?.proposals ?? [];
  const confirmations = m.data?.confirmations ?? [];
  // what the Director already did on its own (Autopilot); things it only proposed are shown as cards instead
  const done = (m.data?.actions ?? []).filter((a) => !/:\s*proposed\b/i.test(a));
  const isMe = !!me && m.user?.id === me.id;
  const sender = !mine ? t("Director") : m.user ? (isMe ? t("You") : m.user.name || m.user.email) : t("Teammate");
  const { note, body } = mine ? { note: null, body: m.content } : splitNote(m.content);
  const hasText = !!note || body.trim().length > 0;

  return (
    <motion.div
      initial={boot ? false : { opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.3, ease: EASE }}
      style={{ transformOrigin: mine ? "right bottom" : "left bottom" }}
      className={clsx(head && !day && "mt-4", day && "mt-2")}
    >
      {day && (
        <div className="mb-3 mt-2 flex items-center gap-3 text-2xs font-medium text-dim" role="separator">
          <span className="h-px flex-1 bg-line" /> {day} <span className="h-px flex-1 bg-line" />
        </div>
      )}
      {mine ? (
        <div className="group flex flex-col items-end">
          {head && !isMe && <p className="mb-0.5 px-1 text-2xs font-medium text-mute">{sender}</p>}
          <div
            title={tail ? undefined : fullTime(m.created_at)}
            className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-accent/20 bg-accent/12 px-3.5 py-2 text-sm leading-relaxed text-ink [overflow-wrap:anywhere]"
          >
            {m.content}
          </div>
          {tail && <Meta iso={m.created_at} label={sender} align="right" />}
        </div>
      ) : (
        <div className="group flex items-start gap-2">
          <div className="w-7 shrink-0">{head && <DirectorMark size={28} />}</div>
          <div className="min-w-0 flex-1">
            {hasText && (
              <div
                title={tail ? undefined : fullTime(m.created_at)}
                className="w-fit max-w-full rounded-2xl rounded-bl-md border border-line bg-raised px-3.5 py-2.5 text-sm leading-relaxed text-ink"
              >
                {note && <p className={clsx("border-line text-2xs italic leading-snug text-dim", body.trim() && "mb-2 border-b pb-2")}>{note}</p>}
                {body.trim() && <RichText text={body} />}
              </div>
            )}
            {proposals.length > 0 && (
              <div className="mt-2 space-y-2">
                {proposals.map((p) => (
                  <Proposal
                    key={p.batch_id}
                    p={p}
                    decision={decisions[p.batch_id]}
                    busy={busy[p.batch_id]}
                    canEdit={canEdit}
                    onApprove={() => onDecide(p.batch_id, "approve")}
                    onReject={() => onDecide(p.batch_id, "reject")}
                  />
                ))}
              </div>
            )}
            {confirmations.length > 0 && (
              <div className="mt-2 space-y-2">
                {confirmations.map((c) => (
                  <ConfirmCard key={c.id} item={c} busy={confirmBusy[c.id]} canEdit={canEdit} onAnswer={(yes) => onConfirm(m.id, c.id, yes)} />
                ))}
              </div>
            )}
            {done.length > 0 && (
              <ul className="mt-2 space-y-1 px-1">
                {done.slice(0, 6).map((a, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-2xs leading-snug text-mute">
                    <Zap className="mt-px size-3 shrink-0 text-accent-ink" />
                    <span className="min-w-0 break-words">{a}</span>
                  </li>
                ))}
                {done.length > 6 && <li className="pl-[18px] text-2xs text-dim">{t("+{n} more", { n: done.length - 6 })}</li>}
              </ul>
            )}
            {tail && <Meta iso={m.created_at} label={sender} align="left">{body.trim() ? <CopyButton text={body} /> : null}</Meta>}
          </div>
        </div>
      )}
    </motion.div>
  );
});

/** Shown while the Director is working: dots, a label, and after a few seconds the elapsed time. */
function Thinking() {
  const t = useT();
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => setSecs(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: 0.25, ease: EASE }}
      className="mt-4 flex items-start gap-2"
    >
      <DirectorMark size={28} working />
      <div className="flex items-center gap-2.5 rounded-2xl rounded-bl-md border border-line bg-raised px-3.5 py-2.5 text-sm text-mute">
        <ThinkingDots />
        <span>{secs >= 12 ? t("Still on it — bigger steps take a little longer") : t("Director is working…")}</span>
        {secs >= 5 && <span className="text-xs tabular-nums text-dim">{secs}s</span>}
      </div>
    </motion.div>
  );
}

function EmptyState({ canEdit, suggestions, onPick, name }: { canEdit: boolean; suggestions: Suggestion[]; onPick: (order: string) => void; name?: string }) {
  const t = useT();
  const first = name?.trim().split(/\s+/)[0];
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-1 py-4 text-center">
      <div className="relative mb-4 anim-pop">
        <span aria-hidden className="anim-glow absolute inset-0 -m-5 rounded-full bg-accent/20 blur-2xl" />
        <div className="anim-float relative grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-accent to-accent-2 text-black shadow-glow">
          <Sparkles className="size-6" />
        </div>
      </div>
      {first && <p className="anim-rise mb-0.5 text-xs font-medium text-accent-ink" style={rise(1).style}>{t("Hi {name}", { name: first })}</p>}
      <h3 className="anim-rise text-lg font-semibold tracking-tight" style={rise(2).style}>{t("Tell me what you want.")}</h3>
      <p className="anim-rise mt-1.5 max-w-[34ch] text-sm leading-relaxed text-mute" style={rise(3).style}>
        {t("I can write hooks and scripts, build characters and voices, plan shots, generate keyframes and videos, lip-sync, dub into Hindi / Kannada / Telugu / Tamil, and export. Paid steps show the cost first, and anything that would replace your work asks before it happens.")}
      </p>
      {canEdit && (
        <>
          <p className="anim-rise mb-2 mt-6 text-2xs font-semibold uppercase tracking-[0.12em] text-dim" style={rise(4).style}>{t("Try one of these")}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {suggestions.map((s, i) => {
              const r = rise(i + 5);
              return (
                <button
                  key={s.order}
                  type="button"
                  onClick={() => onPick(s.order)}
                  className={clsx(
                    "group flex h-8 max-w-full items-center gap-1.5 rounded-full border border-line bg-raised/60 px-3 text-xs text-mute transition-[color,border-color,background-color,transform] hover:border-accent/50 hover:bg-accent/8 hover:text-ink active:scale-95",
                    r.className,
                  )}
                  style={r.style}
                >
                  <s.icon className="size-3.5 shrink-0 text-dim transition-colors group-hover:text-accent-ink" />
                  <span className="truncate">{s.label}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function SkeletonThread() {
  return (
    <div aria-hidden className="space-y-4">
      <div className="flex justify-end"><Skeleton className="h-9 w-40 rounded-2xl" /></div>
      <div className="flex gap-2">
        <Skeleton className="size-7 shrink-0 rounded-full" />
        <div className="space-y-1.5"><Skeleton className="h-4 w-56 rounded-xl" /><Skeleton className="h-4 w-44 rounded-xl" /><Skeleton className="h-4 w-28 rounded-xl" /></div>
      </div>
      <div className="flex justify-end"><Skeleton className="h-9 w-28 rounded-2xl" /></div>
    </div>
  );
}

export interface ConversationProps {
  messages: AgentMessage[] | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** Message the user just sent that the server hasn't returned yet. */
  pending: { text: string; baseId: number } | null;
  sending: boolean;
  me?: UserBrief | null;
  canEdit: boolean;
  suggestions: Suggestion[];
  onPick: (order: string) => void;
  decisions: Record<string, Decision>;
  busy: Record<string, "approve" | "reject">;
  onDecide: (batch: string, kind: "approve" | "reject") => void;
  /** Confirmation cards (actions that would replace work): which one is being answered, and the answer handler. */
  confirmBusy: Record<string, "yes" | "no">;
  onConfirm: (messageId: number, id: string, approve: boolean) => void;
}

export function Conversation({ messages, loading, failed, onRetry, pending, sending, me, canEdit, suggestions, onPick, decisions, busy, onDecide,
  confirmBusy, onConfirm }: ConversationProps) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const quiet = useRef(0);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const items = useItems(messages);
  const pendingShown = !!pending && !(messages ?? []).some((m) => m.id > pending.baseId && m.role === "user" && m.content === pending.text);
  const empty = !loading && !!messages && !messages.length && !pendingShown && !sending;
  const emptyRef = useRef(empty);
  emptyRef.current = empty;

  // Messages that were already there when the thread first appeared don't animate in.
  const boot = useRef<Set<number> | null>(null);
  if (messages && !boot.current) boot.current = new Set(messages.map((m) => m.id));

  const toBottom = useCallback((smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    const animate = smooth && !reducedMotion();
    quiet.current = performance.now() + (animate ? 600 : 100);
    el.scrollTo({ top: el.scrollHeight, behavior: animate ? "smooth" : "auto" });
  }, []);

  // Stay pinned to the bottom while content grows (new message, typing dots, a card changing height).
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current && !emptyRef.current) toBottom(false); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  const loaded = useRef(false);
  const lastCount = useRef(0);
  useLayoutEffect(() => {
    if (!messages) return;
    const n = messages.length;
    if (!loaded.current) {
      loaded.current = true;
      lastCount.current = n;
      stick.current = true;
      if (n) toBottom(false);
      return;
    }
    if (n > lastCount.current && !stick.current) setUnseen((u) => u + (n - lastCount.current));
    lastCount.current = n;
  }, [messages, toBottom]);

  useEffect(() => { if (empty) scroller.current?.scrollTo({ top: 0 }); }, [empty]);

  // Sending always jumps to the newest end.
  useEffect(() => {
    if (pending) { stick.current = true; toBottom(true); }
  }, [pending, toBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (performance.now() > quiet.current) { stick.current = near; setAway(!near); }
    else if (near) { stick.current = true; setAway(false); }
    if (near) setUnseen(0);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label={t("Director chat")}
        className="mask-fade-y h-full overflow-y-auto overscroll-contain px-3 py-5"
      >
        <div ref={content} className="flex min-h-full flex-col">
          {loading && <SkeletonThread />}
          {!loading && failed && !messages && (
            <Alert tone="bad" title={t("Couldn't load the conversation.")} action={<Button size="sm" variant="outline" onClick={onRetry}>{t("Retry")}</Button>} />
          )}
          {empty && <EmptyState canEdit={canEdit} suggestions={suggestions} onPick={onPick} name={me?.name} />}
          <AnimatePresence initial={false}>
            {items.map((it) => (
              <Row
                key={it.m.id}
                item={it}
                me={me}
                boot={!!boot.current?.has(it.m.id)}
                canEdit={canEdit}
                decisions={decisions}
                busy={busy}
                onDecide={onDecide}
                confirmBusy={confirmBusy}
                onConfirm={onConfirm}
              />
            ))}
            {pendingShown && pending && (
              <motion.div
                key="pending"
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={{ duration: 0.28, ease: EASE }}
                style={{ transformOrigin: "right bottom" }}
                className="mt-4 flex justify-end"
              >
                <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-accent/20 bg-accent/12 px-3.5 py-2 text-sm leading-relaxed text-ink opacity-90 [overflow-wrap:anywhere]">
                  {pending.text}
                </div>
              </motion.div>
            )}
            {sending && <Thinking key="thinking" />}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {away && !empty && (
          <motion.button
            key="down"
            type="button"
            onClick={() => { stick.current = true; setUnseen(0); toBottom(true); }}
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.9 }}
            transition={{ duration: 0.18, ease: EASE }}
            aria-label={t("Scroll to the latest message")}
            className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel/95 px-3 text-xs font-medium text-ink shadow-pop backdrop-blur transition-colors hover:bg-hover"
          >
            <ArrowDown className="size-3.5" />
            {unseen > 0 ? t("New message") : t("Latest")}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
