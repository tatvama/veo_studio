import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clapperboard, Clock, Languages, Link2Off, MessageSquareOff, RefreshCw } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { ReviewWorkspace, type NewComment } from "../components/review/ReviewWorkspace";
import { DEFAULT_FPS, lsGet, lsSet, type RComment } from "../components/review/utils";
import { Badge, Button, Skeleton } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { LANG_NAMES, secs } from "../lib/format";
import { UI_LANGUAGES, setUiLanguage, useT, useUiLanguage } from "../lib/i18n";
import type { Stroke } from "../lib/types";

/** GET /api/review/{token} */
interface ReviewInfo {
  project: string; episode: string; label: string; allow_comments: boolean; duration_s: number; language: string; peaks: number[];
  video_url: string; poster_url: string; expires_at?: string | null;
}
/** GET /api/review/{token}/comments */
interface PublicComment {
  id: number; body: string; timecode: number | null; drawing: Stroke[]; resolved: boolean; created_at: string; author: string;
  user_id: number | null; guest_name: string;
}

const NAME_KEY = "veo-review-guest-name";

/** Phones: let the layout shrink with the on-screen keyboard (Chrome ≥ 108) so the composer stays visible above it. */
function useKeyboardResizesLayout() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const prev = meta.getAttribute("content") ?? "";
    if (!/interactive-widget/.test(prev)) meta.setAttribute("content", `${prev}, interactive-widget=resizes-content`);
    return () => meta.setAttribute("content", prev);
  }, []);
}

function Brand() {
  const t = useT();
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <span className="grid size-9 place-items-center rounded-xl bg-linear-to-br from-accent to-accent-2 text-black shadow-[0_6px_18px_-6px_rgb(34_211_238/0.7)]">
        <Clapperboard className="size-[18px]" />
      </span>
      <span className="hidden leading-tight sm:block">
        <span className="block text-sm font-semibold tracking-tight">VEO Studio</span>
        <span className="block text-2xs font-medium uppercase tracking-[0.12em] text-accent-ink">{t("Client review")}</span>
      </span>
    </div>
  );
}

function LangPicker() {
  const t = useT();
  const cur = useUiLanguage();
  return (
    <label className="relative inline-flex shrink-0 items-center" title={t("Interface language")}>
      <Languages className="pointer-events-none absolute left-2.5 size-4 text-mute" />
      <select value={cur} onChange={(e) => setUiLanguage(e.target.value)} aria-label={t("Interface language")}
        className="h-9 rounded-lg border border-line bg-panel pl-8 pr-8 text-xs font-medium max-sm:h-10 text-ink transition-colors hover:border-dim/40 focus:border-accent/70 focus:outline-none focus:ring-[3px] focus:ring-accent/15">
        {Object.entries(UI_LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </label>
  );
}

/** App-like frame: branded header on top, content fills the rest of the screen (the page itself never scrolls on a phone). */
function Frame({ children, title, footer = true }: { children: ReactNode; title?: ReactNode; footer?: boolean }) {
  const t = useT();
  return (
    <div className="flex h-screen min-h-[480px] flex-col bg-bg text-ink supports-[height:100dvh]:h-dvh"
      style={{ backgroundImage: "radial-gradient(52rem 22rem at 8% -8%, color-mix(in oklab, var(--color-accent) 11%, transparent), transparent 70%)" }}>
      <header className="shrink-0 border-b border-line bg-panel/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1560px] items-center gap-3 px-3 sm:px-4">
          <Brand />
          {title && <span className="hidden h-7 w-px bg-line sm:block" />}
          <div className="min-w-0 flex-1">{title}</div>
          <LangPicker />
        </div>
      </header>
      {children}
      {footer && (
        <footer className="hidden shrink-0 border-t border-line px-4 py-2 text-center text-2xs text-dim lg:block">
          {t("Shared privately for review — please don't forward this link.")} · VEO Studio
        </footer>
      )}
    </div>
  );
}

function StateScreen({ icon, tone = "neutral", title, sub, hint, action }: {
  icon: ReactNode; tone?: "neutral" | "warn"; title: string; sub: string; hint?: string; action?: ReactNode;
}) {
  return (
    <Frame footer={false}>
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
        <motion.div initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-md rounded-2xl border border-line bg-panel px-6 py-10 text-center shadow-modal sm:px-10">
          <div className="relative mx-auto mb-5 w-fit">
            <span aria-hidden className="anim-glow absolute inset-0 -m-5 rounded-full bg-accent/10 blur-2xl" />
            <div className={`anim-float relative grid size-16 place-items-center rounded-2xl border border-line bg-raised shadow-card ${tone === "warn" ? "text-warn" : "text-mute"}`}>{icon}</div>
          </div>
          <h1 className="text-balance text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-mute">{sub}</p>
          {hint && <p className="mx-auto mt-3 max-w-sm rounded-lg bg-raised px-3 py-2 text-xs leading-relaxed text-mute">{hint}</p>}
          {action && <div className="mt-6">{action}</div>}
        </motion.div>
      </main>
    </Frame>
  );
}

function ReviewSkeleton() {
  return (
    <Frame title={<div className="space-y-1.5"><Skeleton className="h-3.5 w-40 sm:w-56" /><Skeleton className="h-3 w-28 sm:w-44" /></div>}>
      <main className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex h-full max-w-[1560px] flex-col gap-2 p-3 sm:p-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:gap-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
            <div className="relative min-h-0 flex-1 bg-black"><div className="shimmer absolute inset-0" /></div>
            <div className="space-y-3 border-t border-line p-3"><Skeleton className="h-2 w-full rounded-full" /><div className="flex gap-2"><Skeleton className="size-9 rounded-full" /><Skeleton className="h-8 w-24" /></div></div>
          </div>
          <div className="h-[44%] min-h-[220px] shrink-0 space-y-3 rounded-xl border border-line bg-panel p-3.5 lg:h-auto">
            <Skeleton className="h-6 w-32" />
            {[0, 1].map((i) => <div key={i} className="flex gap-2.5"><Skeleton className="size-7 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-3 w-full" /></div></div>)}
          </div>
        </div>
      </main>
    </Frame>
  );
}

export default function PublicReview() {
  const { token = "" } = useParams();
  const t = useT();
  const qc = useQueryClient();
  const [name, setNameState] = useState(() => lsGet(NAME_KEY));
  const base = `/api/review/${encodeURIComponent(token)}`;
  useKeyboardResizesLayout();

  const info = useQuery({
    queryKey: ["review", token],
    queryFn: () => api.get<ReviewInfo>(base, { silent: true }),
    retry: (n, e) => !(e instanceof ApiError && (e.status === 404 || e.status === 403)) && n < 2,
    staleTime: 60_000,
  });
  const comments = useQuery({
    queryKey: ["review-comments", token],
    queryFn: () => api.get<PublicComment[]>(`${base}/comments`, { silent: true }),
    enabled: info.isSuccess,
    refetchInterval: 20_000,
  });

  useEffect(() => {
    const prev = document.title;
    if (info.data) document.title = `${info.data.episode || info.data.project} · ${t("Review")}`;
    return () => { document.title = prev; };
  }, [info.data?.episode, info.data?.project]);

  const setName = (n: string) => {
    setNameState(n);
    lsSet(NAME_KEY, n.trim());
  };

  if (info.isLoading) return <ReviewSkeleton />;
  if (info.error || !info.data) {
    const gone = info.error instanceof ApiError && (info.error.status === 404 || info.error.status === 403);
    return gone ? (
      <StateScreen icon={<Link2Off className="size-7" />} title={t("This review link is no longer available")}
        sub={t("It may have expired or been revoked, or the address is incomplete. Ask the person who shared it with you for a fresh link.")}
        hint={t("Review links can expire after a set time, and the team can switch them off at any moment.")} />
    ) : (
      <StateScreen icon={<AlertTriangle className="size-7" />} tone="warn" title={t("We couldn't load this review")}
        sub={t("The server didn't respond. Check your connection and try again.")}
        action={<Button variant="primary" icon={<RefreshCw className="size-4" />} loading={info.isFetching} onClick={() => info.refetch()}>{t("Try again")}</Button>} />
    );
  }

  const d = info.data;
  const list: RComment[] = (comments.data ?? []).map((c) => ({
    id: c.id, body: c.body, timecode: c.timecode ?? null, drawing: Array.isArray(c.drawing) ? c.drawing : [], resolved: !!c.resolved,
    created_at: c.created_at, author: c.author || c.guest_name || t("Guest"), guest: !c.user_id,
  }));

  // On a phone the composer sits at the bottom of the screen, so keep toasts at the top where they don't cover it.
  const toastAt = () => (window.matchMedia("(max-width: 639px)").matches ? { position: "top-center" as const } : {});
  const add = async (c: NewComment) => {
    const guest = name.trim();
    if (!guest) {
      toast.error(t("Please add your name first"), toastAt());
      throw new Error("name");
    }
    try {
      await api.post(`${base}/comments`, { guest_name: guest, ...c }, { silent: true });
    } catch (e) {
      const msg = e instanceof ApiError ? (e.status === 403 ? t("Comments are turned off for this link.")
        : e.status === 404 ? t("This review link is no longer available") : e.message) : t("Couldn't send your comment — check your connection.");
      toast.error(msg, toastAt());
      if (e instanceof ApiError && e.status === 404) qc.invalidateQueries({ queryKey: ["review", token] });
      throw e;
    }
    lsSet(NAME_KEY, guest);
    await qc.invalidateQueries({ queryKey: ["review-comments", token] });
    toast.success(t("Thanks — your comment was added"), toastAt());
  };

  return (
    <Frame title={
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 truncate text-sm font-semibold leading-tight">
          <span className="truncate">{d.episode}</span>
          {d.label ? <Badge tone="accent" className="shrink-0 max-sm:hidden">{d.label}</Badge> : null}
        </h1>
        <p className="mt-0.5 truncate text-2xs text-mute">
          {d.project}
          <span className="hidden sm:inline"> · {t(LANG_NAMES[d.language] ?? d.language)} · {secs(d.duration_s)}</span>
          {d.expires_at ? <span className="hidden lg:inline"> · <Clock className="-mt-0.5 inline size-3" /> {t("until {date}", { date: new Date(d.expires_at).toLocaleDateString() })}</span> : null}
        </p>
      </div>
    }>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto h-full min-h-[520px] max-w-[1560px] p-3 sm:p-4">
          <ReviewWorkspace
            className="h-full"
            src={d.video_url}
            poster={d.poster_url}
            fps={DEFAULT_FPS}
            peaks={d.peaks}
            durationHint={d.duration_s}
            comments={list}
            loadingComments={comments.isLoading}
            commentsError={comments.isError}
            onRetryComments={() => comments.refetch()}
            canComment={d.allow_comments}
            guest={{ name, setName }}
            onAdd={add}
            simple
            mobileFill
            notice={!d.allow_comments ? (
              <p className="flex shrink-0 items-center gap-2 border-b border-line bg-raised/40 px-3.5 py-2 text-xs text-mute">
                <MessageSquareOff className="size-3.5 shrink-0" />{t("Comments are turned off for this link — you can still watch and read notes.")}
              </p>
            ) : undefined}
          />
        </motion.div>
      </main>
    </Frame>
  );
}
