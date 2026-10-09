import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  ChevronRight, Clapperboard, Clock, DatabaseZap, Film, FolderOpen, Image as ImageIcon, LayoutGrid, List, Loader2, MapPin, ScrollText, Search, SearchX,
  UserRound, X, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useGenerate } from "../components/Generate";
import { isTypingTarget } from "../components/shell/keys";
import {
  Alert, Button, Kbd, Metric, Page, PageHeader, Panel, Popover, ScrollStrip, Segmented, Select, Skeleton, Tag, Tooltip, rise,
} from "../components/ui";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useAuthStatus, useJobs, useProjects } from "../lib/queries";
import { useUI } from "../lib/store";
import { ROLE_RANK, type Episode, type Job, type Project, type SearchResult, type Shot, type SubmitResult } from "../lib/types";
import "../styles/console.css";

type Kind = "shot" | "character" | "location" | "render" | "story" | "project" | "other";

const KIND_OF: Record<string, Kind> = {
  take: "shot", shot: "shot", character: "character", location: "location", export: "render", episode: "story", script: "story",
  scene: "story", project: "project",
};
const KINDS: Kind[] = ["shot", "character", "location", "render", "story", "project", "other"];
const KIND_ICON: Record<Kind, LucideIcon> = { shot: Film, character: UserRound, location: MapPin, render: Clapperboard, story: ScrollText, project: FolderOpen, other: ImageIcon };
const KIND_HUE: Record<Kind, number> = { shot: 28, character: 330, location: 150, render: 215, story: 275, project: 60, other: 200 };
/** Kinds worth showing as filters before any search has run. */
const DEFAULT_KINDS: Kind[] = ["shot", "character", "location", "render"];

const EXAMPLES = ["close-up at night", "smiling near the lamp", "argument in the kitchen", "final render Kannada"];
const RECENT_KEY = "veo-recent-searches";
const VIEW_KEY = "veo-search-view";
const MAX_RECENT = 8;

/** Placeholder picture for a result without a thumbnail: a soft gradient in a per-kind hue. */
const artGradient = (hue: number) => `linear-gradient(135deg, oklch(0.62 0.14 ${hue}), oklch(0.44 0.12 ${(hue + 40) % 360}))`;

const kindOf = (r: SearchResult): Kind => KIND_OF[r.entity_type] ?? "other";
const shotCode = (text: string) =>
  (/^\w+ of (\S+)/.exec(text)?.[1] ?? /\b((?:OLD-)?[EC]\d{2,}-SH\d{2,})\b/.exec(text)?.[1] ?? null)?.replace(/[:;,.]+$/, "") ?? null;

function useKindText() {
  const t = useT();
  const plural: Record<Kind, string> = {
    shot: t("Shots"), character: t("Characters"), location: t("Locations"), render: t("Renders"), story: t("Story"), project: t("Projects"), other: t("Other"),
  };
  const singular: Record<Kind, string> = {
    shot: t("Shot"), character: t("Character"), location: t("Location"), render: t("Render"), story: t("Story"), project: t("Project"), other: t("Item"),
  };
  return { plural, singular };
}

/** Active jobs matching `match`; calls `onDone` when the last one finishes (to refresh data the live feed doesn't cover). */
function useActiveJobs(match: (j: Job) => boolean, onDone?: () => void): Job[] {
  const { data } = useJobs();
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

// ── recent searches (per browser; wrapped because storage can be blocked) ────────────────────────────────────────
function readRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}
function useRecents() {
  const [list, setList] = useState<string[]>(readRecents);
  const save = (next: string[]) => {
    setList(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  const add = useCallback((q: string) => {
    const v = q.trim();
    if (v.length < 2) return;
    setList((cur) => {
      const next = [v, ...cur.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, MAX_RECENT);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);
  return { list, add, remove: (q: string) => save(list.filter((x) => x !== q)), clear: () => save([]) };
}

/** Grid or list of results, remembered per browser. */
function useView(): ["grid" | "list", (v: "grid" | "list") => void] {
  const [view, setView] = useState<"grid" | "list">(() => {
    try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; }
  });
  return [view, (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } }];
}

// ── highlighting ─────────────────────────────────────────────────────────────────────────────────────────────────
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A short excerpt that starts near the first matching word, so the match is visible without reading the whole text. */
function excerpt(text: string, words: string[], max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max || !words.length) return clean.slice(0, max);
  const hit = clean.search(new RegExp(words.map(esc).join("|"), "i"));
  if (hit < 60) return clean.slice(0, max);
  const start = Math.max(0, hit - 70);
  return "…" + clean.slice(start, start + max);
}

function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map(esc).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? <mark key={i} className="rounded bg-accent/25 px-0.5 text-ink">{part}</mark> : <span key={i}>{part}</span>)}
    </>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────────────────────────────────────────
interface ItemProps {
  r: SearchResult; index: number; kind: Kind; label: string; title: string; words: string[]; maxScore: number; busy: boolean; onOpen: () => void;
}

/** Relevance as a mono percentage with a thin bar. */
function Relevance({ rel, className }: { rel: number; className?: string }) {
  const t = useT();
  const pct = Math.round(rel * 100);
  return (
    <Tooltip content={t("Relevance {pct}%", { pct })}>
      <span className={clsx("mono inline-flex shrink-0 items-center gap-1.5 text-2xs tabular-nums text-dim", className)} role="img" aria-label={t("Relevance {pct}%", { pct })}>
        <span className="h-1 w-12 overflow-hidden rounded-full bg-line"><span className={clsx("block h-full rounded-full", rel > 0.8 ? "bg-accent" : "bg-accent/55")} style={{ width: `${rel * 100}%` }} /></span>
        {pct}
      </span>
    </Tooltip>
  );
}

/** The picture of a result, or a gradient with the kind's icon. */
function Thumb({ r, kind, className, iconClass }: { r: SearchResult; kind: Kind; className?: string; iconClass?: string }) {
  const Icon = KIND_ICON[kind];
  return r.thumb_url ? (
    <img src={r.thumb_url} alt="" loading="lazy" className={clsx("size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]", className)} />
  ) : (
    <div className="relative grid size-full place-items-center" style={{ background: artGradient(KIND_HUE[kind]) }} aria-hidden>
      <div className="absolute inset-0 bg-gradient-to-br from-white/25 via-transparent to-transparent" />
      <Icon className={clsx("relative text-white/85", iconClass ?? "size-8")} strokeWidth={1.6} />
    </div>
  );
}

/** A result as a monitor tile: picture with a mono pill, the highlighted excerpt, mono meta underneath. */
function ResultTile({ r, index, kind, label, title, words, maxScore, busy, onOpen }: ItemProps) {
  const Icon = KIND_ICON[kind];
  const code = kind === "shot" ? shotCode(r.text) : null;
  const rel = Math.max(0.06, r.score / maxScore);
  const wrap = rise(index);
  return (
    <div className={wrap.className} style={wrap.style}>
      <button type="button" data-result onClick={onOpen} disabled={busy}
        className="hud lift group flex h-full w-full scroll-mt-40 flex-col rounded-xl border border-line bg-panel text-left hover:border-accent/40 disabled:opacity-80 sm:scroll-mt-36">
        <div className="cx-monitor relative aspect-video w-full shrink-0 !rounded-b-none !rounded-t-[0.5625rem] !border-0">
          <Thumb r={r} kind={kind} />
          <span className="mono absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-md bg-black/55 px-1.5 py-1 text-2xs font-medium leading-none text-white backdrop-blur-sm"><Icon className="size-3" />{code ?? label}</span>
          {busy && <span className="absolute inset-0 z-10 grid place-items-center bg-bg/60"><Loader2 className="size-5 animate-spin" /></span>}
        </div>
        <div className="flex flex-1 flex-col gap-3 p-3">
          <p className="line-clamp-3 text-xs leading-relaxed text-mute"><Highlight text={excerpt(r.text, words)} words={words} /></p>
          <div className="mono mt-auto flex items-center gap-3 text-2xs">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-dim">
              <FolderOpen className="size-3 shrink-0" /><span className="truncate">{title}</span>
            </span>
            <Relevance rel={rel} />
          </div>
        </div>
      </button>
    </div>
  );
}

/** A result as a dense row: small picture, mono id line, excerpt, relevance, chevron. */
function ResultRow({ r, index, kind, label, title, words, maxScore, busy, onOpen }: ItemProps) {
  const code = kind === "shot" ? shotCode(r.text) : null;
  const rel = Math.max(0.06, r.score / maxScore);
  const wrap = rise(index);
  return (
    <li className={wrap.className} style={wrap.style}>
      <button type="button" data-result onClick={onOpen} disabled={busy}
        className="group flex min-h-14 w-full scroll-mt-40 items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-hover/60 disabled:opacity-80 sm:scroll-mt-36">
        <span className="relative h-10 w-[4.5rem] shrink-0 overflow-hidden rounded-md border border-line bg-raised">
          <Thumb r={r} kind={kind} iconClass="size-4" />
          {busy && <span className="absolute inset-0 grid place-items-center bg-bg/60"><Loader2 className="size-4 animate-spin" /></span>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="mono flex min-w-0 items-center gap-1.5 text-2xs text-dim">
            <span className="shrink-0 font-medium text-accent-ink">{code ?? label}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{title}</span>
            <span aria-hidden className="max-sm:hidden">·</span>
            <span className="shrink-0 max-sm:hidden">{r.entity_type}#{r.entity_id}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-mute"><Highlight text={excerpt(r.text, words, 200)} words={words} /></span>
        </span>
        <Relevance rel={rel} className="max-sm:hidden" />
        <ChevronRight className="size-4 shrink-0 text-dim transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
      </button>
    </li>
  );
}

function ResultSkeleton() {
  return (
    <div aria-hidden className="overflow-hidden rounded-xl border border-line bg-panel">
      <Skeleton className="aspect-video rounded-none" />
      <div className="space-y-2 p-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-2/3" />
        <div className="flex items-center justify-between pt-2"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-1 w-14" /></div>
      </div>
    </div>
  );
}

/** A full-width "nothing here" panel with an icon tile, a title, a line of help and optional actions. */
function Hero({ icon: Icon, title, sub, children }: { icon: LucideIcon; title: string; sub: string; children?: React.ReactNode }) {
  return (
    <div className="hud anim-rise relative rounded-xl border border-dashed border-line bg-panel/60 px-5 py-12 text-center">
      <div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[radial-gradient(ellipse_at_50%_0%,color-mix(in_oklab,var(--color-accent)_10%,transparent),transparent_65%)]" />
      <div className="relative mx-auto mb-4 w-fit">
        <span aria-hidden className="anim-glow absolute inset-0 -m-4 rounded-full bg-accent/12 blur-2xl" />
        <div className="anim-float relative grid size-14 place-items-center rounded-xl border border-line bg-raised text-mute shadow-card"><Icon className="size-7" /></div>
      </div>
      <p className="relative font-medium">{title}</p>
      <p className="relative mx-auto mt-1 max-w-md text-sm text-mute">{sub}</p>
      {children && <div className="relative mt-5">{children}</div>}
    </div>
  );
}

export default function SearchPage() {
  const t = useT();
  const qc = useQueryClient();
  const nav = useNavigate();
  const ui = useUI();
  const { submit } = useGenerate();
  const { plural, singular } = useKindText();
  const { data: auth } = useAuthStatus();
  const canIndex = ROLE_RANK[auth?.user?.role ?? "viewer"] >= ROLE_RANK.creator;
  const { data: projects } = useProjects();
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const urlProject = Number(params.get("project")) || null;
  const [text, setText] = useState(urlQ);
  const [q, setQ] = useState(urlQ.trim());
  const qRef = useRef(q);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [view, setView] = useView();
  const [opening, setOpening] = useState<number | null>(null);
  const [indexTarget, setIndexTarget] = useState<string>("");
  const [indexing, setIndexing] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const indexBtn = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const recents = useRecents();

  const commit = (v: string, projectId = urlProject) => {
    qRef.current = v;
    setQ(v);
    const next: Record<string, string> = {};
    if (v) next.q = v;
    if (projectId) next.project = String(projectId);
    setParams(next, { replace: true });
  };

  // Another page (command palette) can navigate here with ?q=… — follow external URL changes.
  useEffect(() => {
    if (urlQ.trim() !== qRef.current) {
      setText(urlQ);
      qRef.current = urlQ.trim();
      setQ(urlQ.trim());
    }
  }, [urlQ]);

  // Debounce typing.
  useEffect(() => {
    const v = text.trim();
    if (v === qRef.current) return;
    const id = setTimeout(() => commit(v), 350);
    return () => clearTimeout(id);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  // "/" jumps to the search box from anywhere on the page.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ["search", q, urlProject],
    queryFn: () => api.post<{ results: SearchResult[]; indexed: number }>("/api/search", { q, project_id: urlProject, limit: 60 }),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const indexJobs = useActiveJobs((j) => j.type === "search_index", () => qc.invalidateQueries({ queryKey: ["search"] }));

  // Remember searches that actually found something.
  const found = data?.results.length ?? 0;
  useEffect(() => {
    if (q && !isFetching && found > 0) recents.add(q);
  }, [q, isFetching, found]); // eslint-disable-line react-hooks/exhaustive-deps

  const titles = useMemo(() => Object.fromEntries((projects ?? []).map((p) => [p.id, p.title])), [projects]);
  const results = useMemo(() => (q ? data?.results ?? [] : []), [q, data]);
  const counts = useMemo(() => {
    const c: Partial<Record<Kind, number>> = {};
    for (const r of results) c[kindOf(r)] = (c[kindOf(r)] ?? 0) + 1;
    return c;
  }, [results]);
  const shown = kind === "all" ? results : results.filter((r) => kindOf(r) === kind);
  const maxScore = Math.max(0.0001, ...results.map((r) => r.score));
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const chipKinds = q ? KINDS.filter((k) => counts[k] || k === kind) : DEFAULT_KINDS;
  const projectName = urlProject ? titles[urlProject] ?? t("Project #{n}", { n: urlProject }) : null;
  // results grouped by entity type, in a fixed order
  const groups = useMemo(() => {
    const m = new Map<Kind, SearchResult[]>();
    for (const r of shown) m.set(kindOf(r), [...(m.get(kindOf(r)) ?? []), r]);
    return KINDS.filter((k) => m.has(k)).map((k) => ({ kind: k, items: m.get(k)! }));
  }, [shown]);
  const projectCount = useMemo(() => new Set(shown.map((r) => r.project_id).filter(Boolean)).size, [shown]);

  const open = async (r: SearchResult) => {
    const pid = r.project_id;
    if (!pid) return;
    const k = kindOf(r);
    if (k === "character" || k === "location") return nav(`/p/${pid}/bible`);
    if (k === "project") return nav(`/p/${pid}`);
    if (k === "story") {
      if (r.entity_type === "episode") ui.setEpisode(pid, r.entity_id);
      return nav(`/p/${pid}/story`);
    }
    if (k === "render") {
      const epId = Number(/episode (\d+)/.exec(r.text)?.[1]);
      if (epId) ui.setEpisode(pid, epId);
      return nav(`/p/${pid}/export`);
    }
    if (k !== "shot") return nav(`/p/${pid}`);
    const sid = r.shot_id ?? (r.entity_type === "shot" ? r.entity_id : null);
    if (sid) {
      setOpening(r.id);
      try {
        const shot = await api.get<Shot>(`/api/shots/${sid}`, { silent: true });
        if (shot.episode_id) ui.setEpisode(pid, shot.episode_id);
        ui.setSelectedShot(shot.id);
        return nav(`/p/${pid}/storyboard`);
      } catch {
        /* deleted since indexing: fall back to the shot code below */
      } finally {
        setOpening(null);
      }
    }
    // A take: find its shot from the shot code in the indexed text (E01-SH03 = episode 1, C12-SH02 = cut-down #12).
    const code = shotCode(r.text);
    setOpening(r.id);
    try {
      const project = await qc.fetchQuery({ queryKey: ["project", pid], queryFn: () => api.get<Project>(`/api/projects/${pid}`) });
      const m = code ? /^(?:OLD-)?([EC])(\d+)-/.exec(code) : null;
      const eps = project.episodes ?? [];
      const likely = m ? eps.filter((e) => (m[1] === "C" ? e.id === Number(m[2]) : e.number === Number(m[2]))) : [];
      const order = [...likely, ...eps.filter((e) => !likely.includes(e))];
      for (const e of code ? order : []) {
        const full = await api.get<Episode>(`/api/episodes/${e.id}`, { silent: true });
        const shot = (full.shots ?? []).find((s) => s.code === code);
        if (shot) {
          ui.setEpisode(pid, e.id);
          ui.setSelectedShot(shot.id);
          return nav(`/p/${pid}/storyboard`);
        }
      }
      toast.info(t("That shot has moved or been deleted — re-index the project to refresh search."));
      nav(`/p/${pid}/storyboard`);
    } catch {
      nav(`/p/${pid}/storyboard`);
    } finally {
      setOpening(null);
    }
  };

  const reindex = async (target = indexTarget) => {
    const list = target === "all" ? (projects ?? []) : (projects ?? []).filter((p) => String(p.id) === target);
    if (!list.length) return;
    setIndexing(true);
    try {
      if (list.length === 1) {
        await submit(() => api.post<SubmitResult>(`/api/projects/${list[0].id}/search/index`), t("Search index · {name}", { name: list[0].title }));
      } else {
        let ok = 0;
        for (const p of list) {
          try {
            await api.post<SubmitResult>(`/api/projects/${p.id}/search/index`, {}, { silent: true });
            ok += 1;
          } catch { /* keep going */ }
        }
        qc.invalidateQueries({ queryKey: ["jobs"] });
        if (ok) toast.success(t("Indexing {n} projects", { n: ok }));
        else toast.error(t("Couldn't start indexing"));
      }
    } finally {
      setIndexing(false);
    }
  };

  // Arrow keys move between result cards (and back up into the search box).
  const moveFocus = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const items = [...(grid.current?.querySelectorAll<HTMLElement>("[data-result]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === "ArrowRight") return void items[Math.min(items.length - 1, i + 1)].focus();
    if (e.key === "ArrowLeft") return i === 0 ? inputRef.current?.focus() : void items[i - 1].focus();
    const cur = items[i].getBoundingClientRect();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const rects = items.map((el) => el.getBoundingClientRect());
    const cand = items.map((el, j) => ({ el, r: rects[j] })).filter(({ r }, j) => j !== i && (dir > 0 ? r.top > cur.top + 8 : r.top < cur.top - 8));
    if (!cand.length) { if (dir < 0) inputRef.current?.focus(); return; }
    const rowTop = dir > 0 ? Math.min(...cand.map((c) => c.r.top)) : Math.max(...cand.map((c) => c.r.top));
    const row = cand.filter((c) => Math.abs(c.r.top - rowTop) < 8).sort((a, b) => Math.abs(a.r.left - cur.left) - Math.abs(b.r.left - cur.left));
    row[0].el.focus();
  };

  const setProjectFilter = (v: string) => commit(q, Number(v) || null);
  const run = (v: string) => { setText(v); commit(v.trim()); inputRef.current?.focus(); };
  const clearAll = () => { setText(""); commit(""); setKind("all"); inputRef.current?.focus(); };
  const busyIndexing = indexing || indexJobs.length > 0;

  let tileIndex = 0;

  return (
    <Page width="wide">
      <PageHeader title={t("Search everything")} subtitle={t("Find shots, takes, characters and renders by what's in them — in plain words.")} icon={<Search className="size-5" />} />

      {/* the query bar and its filters stay in view while the results scroll */}
      <div className="sticky top-0 z-20 -mx-4 bg-bg/85 px-4 pb-3 pt-1 backdrop-blur-md sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <form className="group/search relative" role="search" onSubmit={(e) => { e.preventDefault(); commit(text.trim()); }}>
          <Search className="pointer-events-none absolute left-4 top-1/2 size-[1.125rem] -translate-y-1/2 text-dim transition-colors group-focus-within/search:text-accent-ink" />
          <input
            ref={inputRef}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && text) { e.preventDefault(); clearAll(); }
              if (e.key === "ArrowDown") {
                const first = grid.current?.querySelector<HTMLElement>("[data-result]");
                if (first) { e.preventDefault(); first.focus(); }
              }
            }}
            aria-label={t("Search everything")}
            placeholder={t("e.g. Ravi near the lamp at night")}
            enterKeyHint="search"
            className="h-12 w-full rounded-xl border border-line bg-panel pl-11 pr-[4.5rem] text-base text-ink shadow-card transition-[border-color,box-shadow] duration-200 placeholder:text-dim hover:border-dim/40 focus:border-accent/60 focus:shadow-glow focus:outline-none sm:pr-28"
          />
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
            {isFetching && <Loader2 className="size-4 animate-spin text-mute" aria-label={t("Searching…")} />}
            {text ? (
              <Tooltip content={t("Clear")} shortcut={<Kbd>Esc</Kbd>}>
                <button type="button" aria-label={t("Clear")} onClick={clearAll}
                  className="grid size-8 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-ink"><X className="size-4" /></button>
              </Tooltip>
            ) : (
              <span className="mono hidden items-center gap-1 text-2xs text-dim sm:flex"><Kbd>/</Kbd>{t("to search")}</span>
            )}
          </div>
        </form>

        <div className="mt-2.5 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
          <ScrollStrip className="-mx-4 px-4 py-0.5 sm:mx-0 sm:min-w-0 sm:flex-1 sm:px-0">
            <div role="group" aria-label={t("Filter by type")} className="flex gap-1.5 pr-6">
              <button type="button" className="cx-chip" aria-pressed={kind === "all"} onClick={() => setKind("all")}>
                {t("All")}{q && <span className="cx-n">{results.length}</span>}
              </button>
              {chipKinds.map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <button key={k} type="button" className="cx-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
                    <Icon />{plural[k]}{q && <span className="cx-n">{counts[k] ?? 0}</span>}
                  </button>
                );
              })}
            </div>
          </ScrollStrip>
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <div className="min-w-0 flex-1 sm:w-52 sm:flex-none">
              <Select value={urlProject ?? ""} onChange={(e) => setProjectFilter(e.target.value)} aria-label={t("Project")}>
                <option value="">{t("All projects")}</option>
                {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </Select>
            </div>
            <div role="radiogroup" aria-label={t("View")} className="inline-flex shrink-0 rounded-lg border border-line bg-panel p-0.5">
              {([["grid", t("Grid"), LayoutGrid], ["list", t("List"), List]] as const).map(([v, label, Icon]) => (
                <button key={v} type="button" role="radio" aria-checked={view === v} aria-label={label} title={label} onClick={() => setView(v)}
                  className={clsx("grid size-8 place-items-center rounded-md transition-colors max-sm:size-9", view === v ? "bg-raised text-accent-ink ring-1 ring-inset ring-line" : "text-mute hover:text-ink")}>
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
            {canIndex && (
              <Button ref={indexBtn} variant="outline" className="h-10 sm:h-9" icon={busyIndexing ? <Loader2 className="size-4 animate-spin" /> : <DatabaseZap className="size-4" />}
                aria-haspopup="dialog" aria-expanded={indexOpen} onClick={() => setIndexOpen((v) => !v)}>
                <span className="max-sm:sr-only">{busyIndexing ? t("Indexing…") : t("Index")}</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      {canIndex && (
        <Popover open={indexOpen} onClose={() => setIndexOpen(false)} anchor={indexBtn} placement="bottom-end" width={340} className="p-4">
          <div className="space-y-3">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent-ink"><DatabaseZap className="size-4" /></span>
              <div>
                <p className="text-sm font-medium">{t("Search index")}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-mute">
                  {t("Search uses an index of each project. Re-index after big changes so new shots and renders show up. Indexing is free.")}
                </p>
              </div>
            </div>
            <Select value={indexTarget} onChange={(e) => setIndexTarget(e.target.value)} aria-label={t("Project to index")}>
              <option value="">{t("Pick a project…")}</option>
              <option value="all">{t("All projects")}</option>
              {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </Select>
            <div className="flex items-center justify-between gap-3">
              <span className="mono text-2xs text-dim">{data && q ? t("{n} items indexed", { n: data.indexed }) : ""}</span>
              <Button size="sm" variant="primary" loading={busyIndexing} disabled={!indexTarget} onClick={() => void reindex()}>
                {busyIndexing ? t("Indexing…") : t("Re-index")}
              </Button>
            </div>
          </div>
        </Popover>
      )}

      {/* results */}
      <div className="mt-3" aria-live="polite">
        {!q ? (
          <div className="grid gap-4 @container lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <Panel eyebrow={t("Recent searches")} icon={<Clock />} index={0} flush
              actions={recents.list.length > 0 ? (
                <button type="button" onClick={recents.clear} className="rounded-md px-1.5 py-1 text-2xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink">{t("Clear history")}</button>
              ) : undefined}>
              {recents.list.length > 0 ? (
                <ul className="mt-3 divide-y divide-line border-t border-line" aria-label={t("Recent searches")}>
                  {recents.list.map((r) => (
                    <li key={r} className="group/recent flex items-center">
                      <button type="button" onClick={() => run(r)} className="mono flex h-10 min-w-0 flex-1 items-center gap-2 px-4 text-left text-xs text-mute transition-colors hover:bg-hover/60 hover:text-ink">
                        <span aria-hidden className="text-accent-ink">›</span><span className="truncate">{r}</span>
                      </button>
                      <button type="button" aria-label={t("Remove “{q}” from recent searches", { q: r })} onClick={() => recents.remove(r)}
                        className="mr-1.5 grid size-8 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink"><X className="size-3.5" /></button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 pb-4 pt-3 text-xs text-dim">{t("Searches that find something are remembered here.")}</p>
              )}
            </Panel>
            <div className="space-y-4">
              <Hero icon={Search} title={t("Search your studio")} sub={t("Describe what you're looking for — a character, a place, a mood or a line of dialogue.")}>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {EXAMPLES.map((ex) => (
                    <button key={ex} type="button" className="cx-chip" onClick={() => run(t(ex))}>{t(ex)}</button>
                  ))}
                </div>
              </Hero>
            </div>
          </div>
        ) : !data && isFetching ? (
          <div aria-busy="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => <ResultSkeleton key={i} />)}
          </div>
        ) : isError ? (
          <Alert tone="bad" title={t("Search failed")} action={<Button size="sm" variant="outline" onClick={() => void refetch()}>{t("Try again")}</Button>}>
            {t("Try again in a moment.")}
          </Alert>
        ) : data && data.indexed === 0 ? (
          <Hero icon={DatabaseZap} title={t("Nothing is indexed yet")}
            sub={canIndex ? t("Index your projects once and search will find shots, takes, characters and renders by what's in them.") : t("Ask a creator to re-index a project, then search again.")}>
            {canIndex && (projects ?? []).length > 0 && (
              <Button variant="primary" icon={<DatabaseZap className="size-4" />} loading={busyIndexing} onClick={() => void reindex("all")}>
                {(projects ?? []).length > 1 ? t("Index all projects") : t("Index this project")}
              </Button>
            )}
          </Hero>
        ) : !shown.length ? (
          <Hero icon={SearchX} title={t("No matches for “{q}”", { q })}
            sub={t("Try fewer or different words — describe a mood, a place or a line of dialogue.")}>
            <div className="flex flex-wrap justify-center gap-2">
              {kind !== "all" && <Button variant="outline" onClick={() => setKind("all")}>{t("Show all types")}</Button>}
              {urlProject && <Button variant="outline" onClick={() => setProjectFilter("")}>{t("Search all projects")}</Button>}
              <Button variant="ghost" onClick={clearAll}>{t("Clear search")}</Button>
            </div>
          </Hero>
        ) : (
          <>
            <Panel flush className="mb-4" index={0}>
              <div className="cx-kpis">
                <Metric size="sm" tone="accent" label={t("Results")} value={shown.length} sub={shown.length >= 60 ? t("showing the best 60") : undefined} />
                <Metric size="sm" label={t("Types")} value={groups.length} />
                <Metric size="sm" label={t("Projects")} value={projectCount} sub={projectName ?? undefined} />
                <Metric size="sm" label={t("Indexed")} value={data?.indexed ?? 0} />
              </div>
            </Panel>
            <p className="mono mb-3 text-xs text-mute">
              {shown.length === 1 ? t("1 result for “{q}”", { q }) : t("{n} results for “{q}”", { n: shown.length, q })}
              {projectName && <> · <span className="text-dim">{projectName}</span></>}
            </p>
            <div key={`${kind}-${q}`} ref={grid} onKeyDown={moveFocus} className="space-y-4">
              {groups.map((g) => {
                const Icon = KIND_ICON[g.kind];
                const items = g.items.map((r) => ({
                  r, kind: g.kind, label: singular[g.kind], words, maxScore, busy: opening === r.id, onOpen: () => void open(r),
                  title: r.project_id ? titles[r.project_id] ?? t("Project #{n}", { n: r.project_id }) : "—",
                }));
                return (
                  <Panel key={g.kind} eyebrow={plural[g.kind]} icon={<Icon />} flush={view === "list"} bodyClassName={view === "grid" ? "!pt-3.5" : undefined}
                    actions={<Tag k={t("Found")}>{g.items.length}</Tag>}>
                    {view === "grid" ? (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {items.map((it) => <ResultTile key={it.r.id} index={tileIndex++} {...it} />)}
                      </div>
                    ) : (
                      <ul className="mt-3 divide-y divide-line border-t border-line">
                        {items.map((it) => <ResultRow key={it.r.id} index={tileIndex++} {...it} />)}
                      </ul>
                    )}
                  </Panel>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Page>
  );
}
