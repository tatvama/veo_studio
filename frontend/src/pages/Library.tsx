import { useQueries, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BadgeCheck, BookUser, Check, FolderPlus, ImageIcon, LayoutGrid, List, Loader2, Lock, MapPin, SearchX, TriangleAlert, UserRound, UserRoundPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CharacterDetail } from "../components/room/CharacterDetail";
import { NewCharacterModal } from "../components/room/NewCharacter";
import { toast } from "sonner";
import { MediaPill } from "../components/home/Chips";
import { useProjectKinds } from "../components/home/kinds";
import { hueOf, InitialArt, MiniThumb, ThumbArt } from "../components/home/ThumbArt";
import { isTypingTarget } from "../components/shell/keys";
import { Alert, Badge, Button, Empty, Kbd, Metric, Modal, Page, PageHeader, Panel, SearchField, Segmented, Select, Skeleton, Tag, rise } from "../components/ui";
import { api } from "../lib/api";
import { LANG_NAMES, LANG_SHORT } from "../lib/format";
import { tr, useT } from "../lib/i18n";
import { useAuthStatus, useBrandKits, useCharacters, useLocations, useProjects } from "../lib/queries";
import { ROLE_RANK, type Character, type Location } from "../lib/types";
import "../styles/console.css";

type View = "all" | "characters" | "locations";
type Layout = "grid" | "list";
type Target = { kind: "character" | "location"; id: number; name: string };

const GRID_CHARS = "grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))]";
const GRID_LOCS = "sm:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]";
/** Lists longer than this do not animate their entrance. */
const ANIMATE_UP_TO = 40;

/** Picture that falls back to the supplied art when it is missing or fails to load. */
function Picture({ src, alt, fallback }: { src: string; alt: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <>{fallback}</>;
  return (
    <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)}
      className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]" />
  );
}

function LockedPill() {
  const t = useT();
  return (
    <MediaPill title={t("Locked by a producer — the look won't change")}>
      <Lock className="size-3 text-white/80" />{t("Locked")}
    </MediaPill>
  );
}

function IdentityPill({ status }: { status?: string }) {
  const t = useT();
  if (status === "ready") {
    return <MediaPill title={t("A custom look was trained for this character, so they stay consistent in every shot.")}><BadgeCheck className="size-3 text-white/80" />{t("Identity trained")}</MediaPill>;
  }
  if (status === "training" || status === "preparing") {
    return <MediaPill title={t("A custom look is being trained for this character.")}><Loader2 className="size-3 animate-spin" />{t("Training…")}</MediaPill>;
  }
  if (status === "failed") {
    return <MediaPill title={t("Training the custom look failed. Open the character in its project to retry.")}><TriangleAlert className="size-3 text-warn" />{t("Training failed")}</MediaPill>;
  }
  return null;
}

function AddButton({ onAdd }: { onAdd: () => void }) {
  const t = useT();
  return (
    <Button size="sm" variant="outline" block className="mt-auto h-10 sm:h-7" icon={<FolderPlus className="size-3.5" />} onClick={onAdd}>
      {t("Add to project")}
    </Button>
  );
}

/** Language codes a character has a voice for. */
const voicesOf = (c: Character): string[] => (Array.isArray(c.voices) ? c.voices : [])
  .map((v) => (typeof v === "string" ? v : (v as { language?: string })?.language))
  .filter((v): v is string => !!v);

/** A rise-in wrapper that switches itself off for long lists (index < 0). */
const enter = (index: number) => (index >= 0 ? rise(index) : { className: "", style: undefined });

const cardShell = "hud group relative flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel transition-colors duration-150 hover:border-accent/40";

function CharacterCard({ c, index, canAdd, onAdd, onOpen }: { c: Character; index: number; canAdd: boolean; onAdd: () => void; onOpen: () => void }) {
  const t = useT();
  const r = enter(index);
  const voices = voicesOf(c);
  const details = [c.gender, c.age].filter(Boolean).join(" · ");
  return (
    <li className={r.className} style={r.style}>
      <article className={cardShell}>
        <button type="button" onClick={onOpen} aria-label={t("Open {name}", { name: c.name })}
          className="relative aspect-[3/4] shrink-0 overflow-hidden bg-raised text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          <Picture src={c.avatar_url} alt={c.name} fallback={<InitialArt name={c.name} hue={hueOf(c.name)} />} />
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/25" />
          <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
            {c.locked && <LockedPill />}
            <IdentityPill status={c.identity?.status} />
          </div>
          {!!c.asset_count && (
            <MediaPill className="mono absolute bottom-2 left-2" title={c.asset_count === 1 ? t("1 picture") : t("{n} pictures", { n: c.asset_count })}>
              <ImageIcon className="size-3" />{c.asset_count}
            </MediaPill>
          )}
        </button>
        <div className="flex flex-1 flex-col gap-2.5 p-3">
          <div className="min-w-0">
            <h3 className="truncate font-medium leading-snug" title={c.name}>
              <button type="button" onClick={onOpen} className="max-w-full truncate hover:underline">{c.name}</button>
            </h3>
            <p className="mt-0.5 truncate text-xs text-mute" title={c.role}>{c.role || t("No role yet")}</p>
            <p className="mono mt-1 flex items-center gap-1.5 truncate text-2xs capitalize text-dim">
              <span>v{c.version ?? 1}</span>{details && <><span aria-hidden>·</span><span className="truncate">{details}</span></>}
            </p>
          </div>
          <div className="flex min-h-5 flex-wrap items-center gap-1">
            {voices.length ? (
              <Tag k={t("Voice")} className="max-w-full"><span title={voices.map((l) => t("Has a {lang} voice", { lang: LANG_NAMES[l] ?? l })).join(", ")}>{voices.map((l) => LANG_SHORT[l] ?? l.toUpperCase()).join(" ")}</span></Tag>
            ) : <span className="text-2xs text-dim">{t("No voices yet")}</span>}
          </div>
          {canAdd && <AddButton onAdd={onAdd} />}
        </div>
      </article>
    </li>
  );
}

function LocationCard({ l, index, canAdd, onAdd }: { l: Location; index: number; canAdd: boolean; onAdd: () => void }) {
  const t = useT();
  const r = enter(index);
  return (
    <li className={r.className} style={r.style}>
      <article className={cardShell}>
        <div className="relative aspect-video shrink-0 overflow-hidden bg-raised">
          <Picture src={l.thumb_url} alt={l.name} fallback={<ThumbArt hue={hueOf(l.name)} icon={MapPin} />} />
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/20" />
          {l.locked && <div className="absolute left-2 top-2"><LockedPill /></div>}
        </div>
        <div className="flex flex-1 flex-col gap-2.5 p-3">
          <div className="min-w-0">
            <h3 className="truncate font-medium leading-snug" title={l.name}>{l.name}</h3>
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-mute">{l.description_text || t("No description yet")}</p>
          </div>
          {canAdd && <AddButton onAdd={onAdd} />}
        </div>
      </article>
    </li>
  );
}

function CardSkeleton({ tall }: { tall?: boolean }) {
  return (
    <li aria-hidden className="overflow-hidden rounded-xl border border-line bg-panel">
      <Skeleton className={clsx("rounded-none", tall ? "aspect-[3/4]" : "aspect-video")} />
      <div className="space-y-2.5 p-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-7 w-full" />
      </div>
    </li>
  );
}

/** One row of the dense list: thumbnail, name, what it is, mono meta, state, and the add button. */
type Row = { kind: "character"; c: Character } | { kind: "location"; l: Location };

function ListView({ rows, canAdd, onOpen, onAdd }: { rows: Row[]; canAdd: boolean; onOpen: (id: number) => void; onAdd: (t: Target) => void }) {
  const t = useT();
  return (
    <Panel flush>
      <div className="cx-scroll max-h-[70vh]">
        <table className="cx-table is-dense" aria-label={t("Shared library")}>
          <thead>
            <tr>
              <th scope="col" className="cx-stick">{t("Name")}</th>
              <th scope="col">{t("Type")}</th>
              <th scope="col">{t("Details")}</th>
              <th scope="col">{t("Meta")}</th>
              <th scope="col">{t("State")}</th>
              {canAdd && <th scope="col"><span className="sr-only">{t("Add to project")}</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isChar = row.kind === "character";
              const id = isChar ? row.c.id : row.l.id;
              const name = isChar ? row.c.name : row.l.name;
              const locked = isChar ? row.c.locked : row.l.locked;
              const thumb = (
                <MiniThumb src={isChar ? row.c.avatar_url : row.l.thumb_url} hue={hueOf(name)} icon={isChar ? UserRound : MapPin} className="size-7 rounded-md" />
              );
              const voices = isChar ? voicesOf(row.c) : [];
              const ident = isChar ? row.c.identity?.status : undefined;
              return (
                <tr key={`${row.kind}-${id}`}>
                  <td className="cx-stick">
                    {isChar ? (
                      <button type="button" onClick={() => onOpen(id)} aria-label={t("Open {name}", { name })} className="flex max-w-[16rem] items-center gap-2.5 text-left font-medium hover:underline">
                        {thumb}<span className="truncate">{name}</span>
                      </button>
                    ) : (
                      <span className="flex max-w-[16rem] items-center gap-2.5 font-medium">{thumb}<span className="truncate">{name}</span></span>
                    )}
                  </td>
                  <td className="cx-fit"><span className="inline-flex items-center gap-1.5 text-xs text-mute">{isChar ? <UserRound className="size-3.5" /> : <MapPin className="size-3.5" />}{isChar ? t("Character") : t("Location")}</span></td>
                  <td className="max-w-[18rem] truncate text-xs text-mute" title={isChar ? row.c.role : row.l.description_text}>
                    {isChar ? (row.c.role || t("No role yet")) : (row.l.description_text || t("No description yet"))}
                  </td>
                  <td className="cx-mono">
                    {isChar
                      ? [`v${row.c.version ?? 1}`, row.c.asset_count ? t("{n} pictures", { n: row.c.asset_count }) : "", voices.length ? voices.map((l) => LANG_SHORT[l] ?? l.toUpperCase()).join(" ") : ""].filter(Boolean).join(" · ")
                      : "—"}
                  </td>
                  <td>
                    <span className="flex flex-wrap items-center gap-1">
                      {locked && <Badge tone="info"><Lock className="size-3" />{t("Locked")}</Badge>}
                      {ident === "ready" && <Badge tone="ok"><BadgeCheck className="size-3" />{t("Identity trained")}</Badge>}
                      {(ident === "training" || ident === "preparing") && <Badge tone="accent"><Loader2 className="size-3 animate-spin" />{t("Training…")}</Badge>}
                      {ident === "failed" && <Badge tone="warn"><TriangleAlert className="size-3" />{t("Training failed")}</Badge>}
                      {!locked && !ident && <span className="text-dim">—</span>}
                    </span>
                  </td>
                  {canAdd && (
                    <td className="cx-fit">
                      <Button size="sm" variant="outline" className="max-sm:h-10" icon={<FolderPlus className="size-3.5" />} onClick={() => onAdd({ kind: row.kind, id, name })}>{t("Add to project")}</Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function AddToProjectModal({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const nav = useNavigate();
  const kinds = useProjectKinds();
  const { data: projects, isLoading } = useProjects();
  const [pid, setPid] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPid("");
    setQ("");
    onClose();
  };

  const add = async () => {
    if (!target || !pid) return;
    const project = projects?.find((p) => p.id === Number(pid));
    setBusy(true);
    try {
      const path = target.kind === "character" ? `/api/projects/${pid}/cast/${target.id}` : `/api/projects/${pid}/locations/${target.id}`;
      await api.post(path);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["project", Number(pid)] }),
        qc.invalidateQueries({ queryKey: [target.kind === "character" ? "characters" : "locations"] }),
      ]);
      toast.success(tr("{name} added to {project}", { name: target.name, project: project?.title ?? tr("the project") }));
      close();
    } catch {
      /* the api helper already showed the error */
    } finally {
      setBusy(false);
    }
  };

  const list = projects ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle ? list.filter((p) => p.title.toLowerCase().includes(needle)) : list;

  return (
    <Modal
      open={!!target}
      onClose={close}
      title={target ? t("Add {name} to a project", { name: target.name }) : t("Add to project")}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>{t("Cancel")}</Button>
          <Button variant="primary" icon={<FolderPlus className="size-4" />} loading={busy} disabled={!pid} onClick={add}>{t("Add to project")}</Button>
        </>
      )}
    >
      {isLoading ? (
        <div className="space-y-2" aria-busy="true">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}</div>
      ) : !list.length ? (
        <div className="py-4 text-center">
          <p className="text-sm text-mute">{t("You don't have any projects yet.")}</p>
          <Button className="mt-3" variant="primary" onClick={() => { close(); nav("/"); }}>{t("Start one first.")}</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-mute">
            {target?.kind === "character"
              ? t("They join the project's cast with their look and voices. Changes to a shared character show up in every project that uses it.")
              : t("The place is added to the project's locations, ready to use in scenes.")}
          </p>
          {list.length > 6 && <SearchField value={q} onChange={setQ} placeholder={t("Search projects…")} aria-label={t("Search projects")} data-autofocus />}
          <div role="radiogroup" aria-label={t("Project")} className="-mr-1 max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {shown.map((p, i) => {
              const on = String(p.id) === pid;
              return (
                <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => setPid(String(p.id))}
                  data-autofocus={i === 0 && list.length <= 6 ? "" : undefined}
                  className={clsx("flex w-full items-center gap-3 rounded-xl border p-2 text-left transition-colors",
                    on ? "border-accent/60 bg-accent/10" : "border-line bg-panel hover:border-dim/50 hover:bg-hover")}>
                  <MiniThumb src={p.thumb_url} hue={hueOf(p.id)} className="size-11" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.title}</span>
                    <span className="block truncate text-xs text-mute">{kinds.find((k) => k.value === p.type)?.label ?? p.type} · {p.aspect}</span>
                  </span>
                  <span className={clsx("grid size-5 shrink-0 place-items-center rounded-full border transition-colors", on ? "border-transparent bg-accent text-black" : "border-line text-transparent")}>
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                </button>
              );
            })}
            {!shown.length && <p className="py-6 text-center text-sm text-mute">{t("No projects match")}</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}

const NONE: never[] = [];
const dedupe = <T extends { id: number }>(xs: T[]): T[] => { const seen = new Set<number>(); return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))); };
const mergeChars = (rs: { data?: Character[]; isLoading: boolean; isError: boolean }[]) => ({ data: dedupe(rs.flatMap((r) => r.data ?? [])), loading: rs.some((r) => r.isLoading), error: rs.some((r) => r.isError) });
const mergeLocs = (rs: { data?: Location[]; isLoading: boolean; isError: boolean }[]) => ({ data: dedupe(rs.flatMap((r) => r.data ?? [])), loading: rs.some((r) => r.isLoading), error: rs.some((r) => r.isError) });

export default function LibraryPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: auth } = useAuthStatus();
  const role = auth?.user?.role;
  const canAdd = role ? ROLE_RANK[role] >= ROLE_RANK.creator : false;
  const [view, setView] = useState<View>("all");
  const [layout, setLayout] = useState<Layout>("grid");
  const [query, setQuery] = useState("");
  const [lockedOnly, setLockedOnly] = useState(false);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [brandId, setBrandId] = useState<number | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const { data: characters, isLoading: charsLoading, isError: charsError, refetch: refetchChars } = useCharacters();
  const { data: locations, isLoading: locsLoading, isError: locsError, refetch: refetchLocs } = useLocations();
  const { data: projects } = useProjects();
  const { data: kits } = useBrandKits();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const charId = Number(params.get("char")) || null;
  const [creating, setCreating] = useState(false);
  const openChar = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set("char", String(id)); else p.delete("char");
    setParams(p, { replace: !id });
    window.scrollTo({ top: 0 });
  };

  // "by project" / "by brand": the cast and locations of one project, or of every project that uses a brand kit (same query keys as the project pages).
  const scopeActive = projectId != null || brandId != null;
  const scopePids = useMemo(
    () => (projectId != null ? [projectId] : brandId != null ? (projects ?? []).filter((p) => p.brand_kit_id === brandId).map((p) => p.id) : []),
    [projectId, brandId, projects],
  );
  const scopedC = useQueries({ queries: scopePids.map((pid) => ({ queryKey: ["characters", pid], queryFn: () => api.get<Character[]>(`/api/characters?project_id=${pid}`) })), combine: mergeChars });
  const scopedL = useQueries({ queries: scopePids.map((pid) => ({ queryKey: ["locations", pid], queryFn: () => api.get<Location[]>(`/api/locations?project_id=${pid}`) })), combine: mergeLocs });
  const srcChars: Character[] = scopeActive ? scopedC.data : (characters ?? NONE);
  const srcLocs: Location[] = scopeActive ? scopedL.data : (locations ?? NONE);
  const scopeWait = scopeActive && !projects; // a brand's projects are not known yet
  const cLoading = scopeActive ? scopedC.loading || scopeWait : charsLoading;
  const lLoading = scopeActive ? scopedL.loading || scopeWait : locsLoading;
  const cError = scopeActive ? scopedC.error : charsError;
  const lError = scopeActive ? scopedL.error : locsError;
  const retryChars = () => void (scopeActive ? qc.invalidateQueries({ queryKey: ["characters"] }) : refetchChars());
  const retryLocs = () => void (scopeActive ? qc.invalidateQueries({ queryKey: ["locations"] }) : refetchLocs());

  // "/" jumps to the search box, like on the rest of the studio.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const q = query.trim().toLowerCase();
  const chars = useMemo(() => srcChars.filter((c) =>
    (!lockedOnly || c.locked) && (!q || [c.name, c.role, c.personality].some((s) => (s || "").toLowerCase().includes(q)))), [srcChars, q, lockedOnly]);
  const locs = useMemo(() => srcLocs.filter((l) =>
    (!lockedOnly || l.locked) && (!q || [l.name, l.description_text].some((s) => (s || "").toLowerCase().includes(q)))), [srcLocs, q, lockedOnly]);

  const showChars = view !== "locations";
  const showLocs = view !== "characters";
  const loading = (showChars && cLoading) || (showLocs && lLoading);
  const failedKinds = [showChars && cError, showLocs && lError].filter(Boolean).length;
  const kinds = (showChars ? 1 : 0) + (showLocs ? 1 : 0);
  const total = (showChars ? srcChars.length : 0) + (showLocs ? srcLocs.length : 0);
  const shown = (showChars ? chars.length : 0) + (showLocs ? locs.length : 0);
  const nLocked = srcChars.filter((c) => c.locked).length + srcLocs.filter((l) => l.locked).length;
  const nVoiced = srcChars.filter((c) => voicesOf(c).length > 0).length;
  const filtersOn = !!q || lockedOnly || scopeActive;
  const clearFilters = () => { setQuery(""); setLockedOnly(false); setProjectId(null); setBrandId(null); };
  const projectChoices = brandId != null ? (projects ?? []).filter((p) => p.brand_kit_id === brandId) : (projects ?? []);
  const searchLabel = view === "characters" ? t("Search characters…") : view === "locations" ? t("Search locations…") : t("Search the library…");

  if (charId) {
    return (
      <Page width="default">
        <div className="@container">
          <CharacterDetail cid={charId} chars={chars} backLabel={t("Library")} onBack={() => openChar(null)} onOpen={(id) => openChar(id)} />
        </div>
      </Page>
    );
  }

  const sectionTitle = (icon: ReactNode, label: string, n: number) => (
    <h2 className="eyebrow mb-3 flex items-center gap-2 !text-mute"><span className="[&>svg]:size-3.5">{icon}</span>{label}<span className="mono text-dim">{n}</span></h2>
  );
  const rows: Row[] = [
    ...(showChars ? chars.map((c): Row => ({ kind: "character", c })) : []),
    ...(showLocs ? locs.map((l): Row => ({ kind: "location", l })) : []),
  ];
  const addTo = (tg: Target) => setTarget(tg);
  // an item that already belongs to the chosen project has nothing to add it to
  const canAddHere = canAdd && projectId == null;

  return (
    <Page width="wide">
      <PageHeader
        title={t("Shared library")}
        subtitle={t("Your own characters and places, reusable in every project: the same face, voice and setting everywhere.")}
        icon={<BookUser className="size-5" />}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
          {canAdd && showChars && (
            <Button variant="primary" icon={<UserRoundPlus className="size-4" />} onClick={() => setCreating(true)}>{t("New character")}</Button>
          )}
          <SearchField
            ref={search}
            value={query}
            onChange={setQuery}
            placeholder={searchLabel}
            aria-label={searchLabel}
            shortcut={<Kbd>/</Kbd>}
            // full width on phones (this also makes the header wrap the field under the title instead of squeezing the title)
            className="w-[calc(100vw-2rem)] max-w-full sm:w-64"
          />
          </div>
        )}
      />

      <Panel flush index={1} className="mb-4">
        <div className="cx-kpis" role="group" aria-label={t("Library totals")}>
          <Metric label={t("Characters")} value={srcChars.length} size="md" />
          <Metric label={t("Locations")} value={srcLocs.length} size="md" />
          <Metric label={t("Locked")} value={nLocked} tone={nLocked ? "accent" : "neutral"} size="md" />
          <Metric label={t("With voices")} value={nVoiced} sub={srcChars.length ? t("of {n} characters", { n: srcChars.length }) : undefined} size="md" />
        </div>
      </Panel>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t("Show")} className="flex flex-wrap gap-1.5">
          <button type="button" className="cx-chip" aria-pressed={view === "all"} onClick={() => setView("all")}>{t("All")}<span className="cx-n">{srcChars.length + srcLocs.length}</span></button>
          <button type="button" className="cx-chip" aria-pressed={view === "characters"} onClick={() => setView("characters")}><UserRound />{t("Characters")}<span className="cx-n">{srcChars.length}</span></button>
          <button type="button" className="cx-chip" aria-pressed={view === "locations"} onClick={() => setView("locations")}><MapPin />{t("Locations")}<span className="cx-n">{srcLocs.length}</span></button>
        </div>
        <button type="button" className="cx-chip" aria-pressed={lockedOnly} onClick={() => setLockedOnly((v) => !v)}><Lock />{t("Locked")}<span className="cx-n">{nLocked}</span></button>
        {!!kits?.length && (
          <Select aria-label={t("Brand")} value={brandId ?? ""} className="h-8 w-auto min-w-[8.5rem] max-w-[11rem] text-xs max-sm:h-10 max-sm:flex-1"
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              setBrandId(id);
              if (id != null && projectId != null && (projects ?? []).find((p) => p.id === projectId)?.brand_kit_id !== id) setProjectId(null);
            }}>
            <option value="">{t("All brands")}</option>
            {kits.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </Select>
        )}
        {!!projects?.length && (
          <Select aria-label={t("Project")} value={projectId ?? ""} className="h-8 w-auto min-w-[9.5rem] max-w-[13rem] text-xs max-sm:h-10 max-sm:flex-1"
            onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t("All projects")}</option>
            {projectChoices.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </Select>
        )}
        {filtersOn && <button type="button" className="cx-chip" onClick={clearFilters}>{t("Clear filters")}</button>}
        <div className="ml-auto flex items-center gap-3">
          {filtersOn && !loading && <span className="mono text-2xs text-dim">{t("Showing {n} of {total}", { n: shown, total })}</span>}
          <Segmented<Layout> size="sm" value={layout} onChange={setLayout} aria-label={t("Layout")}
            options={[
              { value: "grid", title: t("Grid"), label: <span className="flex items-center"><LayoutGrid className="size-4" /><span className="sr-only">{t("Grid")}</span></span> },
              { value: "list", title: t("List"), label: <span className="flex items-center"><List className="size-4" /><span className="sr-only">{t("List")}</span></span> },
            ]} />
        </div>
      </div>

      {loading ? (
        layout === "list" ? (
          <Panel flush><div aria-busy="true" className="space-y-px p-1">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-9 w-full rounded-md" />)}</div></Panel>
        ) : (
          <ul aria-busy="true" className={clsx("grid gap-4", view === "locations" ? GRID_LOCS : GRID_CHARS)}>
            {Array.from({ length: view === "locations" ? 6 : 8 }, (_, i) => <CardSkeleton key={i} tall={view !== "locations"} />)}
          </ul>
        )
      ) : (
        <>
          {failedKinds > 0 && (
            <div className="mb-4 space-y-3">
              {showChars && cError && (
                <Alert tone="bad" title={t("Couldn't load the library")} action={<Button size="sm" variant="outline" onClick={retryChars}>{t("Try again")}</Button>}>{t("Check your connection and try again.")}</Alert>
              )}
              {showLocs && lError && (
                <Alert tone="bad" title={t("Couldn't load the library")} action={<Button size="sm" variant="outline" onClick={retryLocs}>{t("Try again")}</Button>}>{t("Check your connection and try again.")}</Alert>
              )}
            </div>
          )}
          {failedKinds === kinds ? null : total === 0 ? (
            scopeActive ? (
              <Empty icon={<BookUser className="size-7" />} title={t("Nothing in this scope yet")} sub={t("Pick another project or brand, or clear the filter.")}
                action={<Button variant="outline" onClick={clearFilters}>{t("Clear filters")}</Button>} />
            ) : view === "characters" ? (
              <Empty icon={<BookUser className="size-7" />} title={t("No shared characters yet")}
                sub={t("Create a character from your own photos and voice, then use them in any project.")}
                action={canAdd ? <Button variant="primary" icon={<UserRoundPlus className="size-4" />} onClick={() => setCreating(true)}>{t("New character")}</Button> : undefined} />
            ) : view === "locations" ? (
              <Empty icon={<MapPin className="size-7" />} title={t("No locations yet")}
                sub={t("Places you create in a project are saved here, so you can reuse them in your next video.")}
                action={canAdd ? <Button variant="primary" onClick={() => nav("/")}>{t("Go to projects")}</Button> : undefined} />
            ) : (
              <Empty icon={<BookUser className="size-7" />} title={t("Nothing in the library yet")}
                sub={`${t("Create a character from your own photos and voice, then use them in any project.")} ${t("Places you create in a project are saved here, so you can reuse them in your next video.")}`}
                action={canAdd ? <Button variant="primary" icon={<UserRoundPlus className="size-4" />} onClick={() => setCreating(true)}>{t("New character")}</Button> : undefined} />
            )
          ) : shown === 0 ? (
            <Empty icon={<SearchX className="size-7" />}
              title={q ? t("Nothing matches \"{q}\"", { q: query.trim() }) : t("Nothing matches these filters")}
              sub={q ? t("Try a different name or clear the search.") : t("Try a different filter or clear them all.")}
              action={<Button variant="outline" onClick={clearFilters}>{q && !scopeActive && !lockedOnly ? t("Clear search") : t("Clear filters")}</Button>} />
          ) : layout === "list" ? (
            <ListView rows={rows} canAdd={canAddHere} onOpen={(id) => openChar(id)} onAdd={addTo} />
          ) : (
            <div className="space-y-6">
              {showChars && !cError && chars.length > 0 && (
                <section key={`chars-${view}`} aria-label={t("Characters")}>
                  {view === "all" && sectionTitle(<UserRound />, t("Characters"), chars.length)}
                  <ul className={clsx("grid gap-4", GRID_CHARS)}>
                    {chars.map((c, i) => (
                      <CharacterCard key={c.id} c={c} index={chars.length > ANIMATE_UP_TO ? -1 : i} canAdd={canAddHere} onOpen={() => openChar(c.id)}
                        onAdd={() => addTo({ kind: "character", id: c.id, name: c.name })} />
                    ))}
                  </ul>
                </section>
              )}
              {showLocs && !lError && locs.length > 0 && (
                <section key={`locs-${view}`} aria-label={t("Locations")}>
                  {view === "all" && sectionTitle(<MapPin />, t("Locations"), locs.length)}
                  <ul className={clsx("grid gap-4", GRID_LOCS)}>
                    {locs.map((l, i) => (
                      <LocationCard key={l.id} l={l} index={locs.length > ANIMATE_UP_TO ? -1 : i} canAdd={canAddHere}
                        onAdd={() => addTo({ kind: "location", id: l.id, name: l.name })} />
                    ))}
                  </ul>
                </section>
              )}
              {view === "all" && !filtersOn && !cError && !lError && (srcChars.length === 0 || srcLocs.length === 0) && (
                <p className="rounded-xl border border-dashed border-line px-4 py-3 text-xs text-mute">
                  {srcChars.length === 0 ? t("No shared characters yet") : t("No locations yet")}
                </p>
              )}
            </div>
          )}
        </>
      )}

      <AddToProjectModal target={target} onClose={() => setTarget(null)} />
      <NewCharacterModal open={creating} onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); openChar(c.id); }} />
    </Page>
  );
}
