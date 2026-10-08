import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BadgeCheck, BookUser, Check, FolderPlus, ImageIcon, Loader2, Lock, MapPin, SearchX, TriangleAlert, UserRound, UserRoundPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CharacterDetail } from "../components/room/CharacterDetail";
import { NewCharacterModal } from "../components/room/NewCharacter";
import { toast } from "sonner";
import { MediaPill } from "../components/home/Chips";
import { useProjectKinds } from "../components/home/kinds";
import { hueOf, InitialArt, MiniThumb, ThumbArt } from "../components/home/ThumbArt";
import { isTypingTarget } from "../components/shell/keys";
import { Alert, Badge, Button, Card, Empty, Kbd, Modal, Page, PageHeader, SearchField, Skeleton, Tabs, rise } from "../components/ui";
import { api } from "../lib/api";
import { LANG_NAMES, LANG_SHORT } from "../lib/format";
import { tr, useT } from "../lib/i18n";
import { useAuthStatus, useCharacters, useLocations, useProjects } from "../lib/queries";
import { ROLE_RANK, type Character, type Location } from "../lib/types";

type TabKey = "characters" | "locations";
type Target = { kind: "character" | "location"; id: number; name: string };

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
      <Lock className="size-3 text-sky-400" />{t("Locked")}
    </MediaPill>
  );
}

function IdentityPill({ status }: { status?: string }) {
  const t = useT();
  if (status === "ready") {
    return <MediaPill title={t("A custom look was trained for this character, so they stay consistent in every shot.")}><BadgeCheck className="size-3 text-emerald-400" />{t("Identity trained")}</MediaPill>;
  }
  if (status === "training" || status === "preparing") {
    return <MediaPill title={t("A custom look is being trained for this character.")}><Loader2 className="size-3 animate-spin" />{t("Training…")}</MediaPill>;
  }
  if (status === "failed") {
    return <MediaPill title={t("Training the custom look failed. Open the character in its project to retry.")}><TriangleAlert className="size-3 text-amber-400" />{t("Training failed")}</MediaPill>;
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

function CharacterCard({ c, index, canAdd, onAdd, onOpen }: { c: Character; index: number; canAdd: boolean; onAdd: () => void; onOpen: () => void }) {
  const t = useT();
  const r = rise(index);
  const voices = (Array.isArray(c.voices) ? c.voices : [])
    .map((v) => (typeof v === "string" ? v : (v as { language?: string })?.language))
    .filter((v): v is string => !!v);
  const details = [c.gender, c.age].filter(Boolean).join(" · ");
  return (
    <div className={r.className} style={r.style}>
      <Card className="lift group flex h-full flex-col overflow-hidden hover:border-accent/40">
        <button type="button" onClick={onOpen} aria-label={t("Open {name}", { name: c.name })}
          className="relative aspect-[3/4] shrink-0 overflow-hidden bg-raised text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          <Picture src={c.avatar_url} alt={c.name} fallback={<InitialArt name={c.name} hue={hueOf(c.name)} />} />
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/25" />
          <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
            {c.locked && <LockedPill />}
            <IdentityPill status={c.identity?.status} />
          </div>
          {!!c.asset_count && (
            <MediaPill className="absolute bottom-2 left-2" title={c.asset_count === 1 ? t("1 picture") : t("{n} pictures", { n: c.asset_count })}>
              <ImageIcon className="size-3" />{c.asset_count}
            </MediaPill>
          )}
        </button>
        <div className="flex flex-1 flex-col gap-2.5 p-3.5">
          <div className="min-w-0">
            <h3 className="truncate font-medium leading-snug" title={c.name}>
              <button type="button" onClick={onOpen} className="max-w-full truncate hover:underline">{c.name}</button>
            </h3>
            <p className="mt-0.5 truncate text-xs text-mute" title={c.role}>{c.role || t("No role yet")}</p>
            {details && <p className="mt-0.5 truncate text-2xs capitalize text-dim">{details}</p>}
          </div>
          <div className="flex min-h-5 flex-wrap items-center gap-1">
            {voices.length ? voices.map((l) => (
              <Badge key={l} title={t("Has a {lang} voice", { lang: LANG_NAMES[l] ?? l })}>{LANG_SHORT[l] ?? l.toUpperCase()}</Badge>
            )) : <span className="text-2xs text-dim">{t("No voices yet")}</span>}
          </div>
          {canAdd && <AddButton onAdd={onAdd} />}
        </div>
      </Card>
    </div>
  );
}

function LocationCard({ l, index, canAdd, onAdd }: { l: Location; index: number; canAdd: boolean; onAdd: () => void }) {
  const t = useT();
  const r = rise(index);
  return (
    <div className={r.className} style={r.style}>
      <Card className="lift group flex h-full flex-col overflow-hidden hover:border-accent/40">
        <div className="relative aspect-video shrink-0 overflow-hidden bg-raised">
          <Picture src={l.thumb_url} alt={l.name} fallback={<ThumbArt hue={hueOf(l.name)} icon={MapPin} />} />
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/20" />
          {l.locked && <div className="absolute left-2 top-2"><LockedPill /></div>}
        </div>
        <div className="flex flex-1 flex-col gap-2.5 p-3.5">
          <div className="min-w-0">
            <h3 className="truncate font-medium leading-snug" title={l.name}>{l.name}</h3>
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-mute">{l.description_text || t("No description yet")}</p>
          </div>
          {canAdd && <AddButton onAdd={onAdd} />}
        </div>
      </Card>
    </div>
  );
}

function CardSkeleton({ tall }: { tall?: boolean }) {
  return (
    <div aria-hidden className="overflow-hidden rounded-xl border border-line bg-panel">
      <Skeleton className={clsx("rounded-none", tall ? "aspect-[3/4]" : "aspect-video")} />
      <div className="space-y-2.5 p-3.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
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

export default function LibraryPage() {
  const t = useT();
  const { data: auth } = useAuthStatus();
  const role = auth?.user?.role;
  const canAdd = role ? ROLE_RANK[role] >= ROLE_RANK.creator : false;
  const [tab, setTab] = useState<TabKey>("characters");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const { data: characters, isLoading: charsLoading, isError: charsError, refetch: refetchChars } = useCharacters();
  const { data: locations, isLoading: locsLoading, isError: locsError, refetch: refetchLocs } = useLocations();
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
  const chars = useMemo(() => (characters ?? []).filter((c) =>
    !q || [c.name, c.role, c.personality].some((s) => (s || "").toLowerCase().includes(q))), [characters, q]);
  const locs = useMemo(() => (locations ?? []).filter((l) =>
    !q || [l.name, l.description_text].some((s) => (s || "").toLowerCase().includes(q))), [locations, q]);

  const loading = tab === "characters" ? charsLoading : locsLoading;
  const failed = tab === "characters" ? charsError : locsError;
  const total = tab === "characters" ? (characters?.length ?? 0) : (locations?.length ?? 0);
  const shown = tab === "characters" ? chars.length : locs.length;

  if (charId) {
    return (
      <Page width="default">
        <div className="@container">
          <CharacterDetail cid={charId} chars={chars} backLabel={t("Library")} onBack={() => openChar(null)} onOpen={(id) => openChar(id)} />
        </div>
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title={t("Shared library")}
        subtitle={t("Your own characters and places, reusable in every project: the same face, voice and setting everywhere.")}
        icon={<BookUser className="size-5" />}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
          {canAdd && tab === "characters" && (
            <Button variant="primary" icon={<UserRoundPlus className="size-4" />} onClick={() => setCreating(true)}>{t("New character")}</Button>
          )}
          <SearchField
            ref={search}
            value={query}
            onChange={setQuery}
            placeholder={tab === "characters" ? t("Search characters…") : t("Search locations…")}
            aria-label={tab === "characters" ? t("Search characters…") : t("Search locations…")}
            shortcut={<Kbd>/</Kbd>}
            // full width on phones (this also makes the header wrap the field under the title instead of squeezing the title)
            className="w-[calc(100vw-2rem)] max-w-full sm:w-64"
          />
          </div>
        )}
      />

      <Tabs<TabKey>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "characters", label: <span className="flex items-center gap-1.5"><UserRound className="size-4" />{t("Characters")}</span>, count: characters?.length },
          { value: "locations", label: <span className="flex items-center gap-1.5"><MapPin className="size-4" />{t("Locations")}</span>, count: locations?.length },
        ]}
      />

      {loading ? (
        <div aria-busy="true" className={clsx("grid gap-4", tab === "characters" ? "grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]" : "sm:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]")}>
          {Array.from({ length: tab === "characters" ? 8 : 6 }, (_, i) => <CardSkeleton key={i} tall={tab === "characters"} />)}
        </div>
      ) : failed ? (
        <Alert tone="bad" title={t("Couldn't load the library")} action={<Button size="sm" variant="outline" onClick={() => void (tab === "characters" ? refetchChars() : refetchLocs())}>{t("Try again")}</Button>}>
          {t("Check your connection and try again.")}
        </Alert>
      ) : total === 0 ? (
        tab === "characters" ? (
          <Empty icon={<BookUser className="size-7" />} title={t("No shared characters yet")}
            sub={t("Create a character from your own photos and voice, then use them in any project.")}
            action={canAdd ? <Button variant="primary" icon={<UserRoundPlus className="size-4" />} onClick={() => setCreating(true)}>{t("New character")}</Button> : undefined} />
        ) : (
          <Empty icon={<MapPin className="size-7" />} title={t("No locations yet")}
            sub={t("Places you create in a project are saved here, so you can reuse them in your next video.")}
            action={canAdd ? <Button variant="primary" onClick={() => nav("/")}>{t("Go to projects")}</Button> : undefined} />
        )
      ) : shown === 0 ? (
        <Empty icon={<SearchX className="size-7" />} title={t("Nothing matches \"{q}\"", { q: query.trim() })} sub={t("Try a different name or clear the search.")}
          action={<Button variant="outline" onClick={() => setQuery("")}>{t("Clear search")}</Button>} />
      ) : (
        <>
          {q && <p className="mb-3 text-xs text-mute">{t("Showing {n} of {total}", { n: shown, total })}</p>}
          {tab === "characters" ? (
            <div key="chars" className="grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
              {chars.map((c, i) => (
                <CharacterCard key={c.id} c={c} index={i} canAdd={canAdd} onOpen={() => openChar(c.id)}
                  onAdd={() => setTarget({ kind: "character", id: c.id, name: c.name })} />
              ))}
            </div>
          ) : (
            <div key="locs" className="grid gap-4 sm:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
              {locs.map((l, i) => (
                <LocationCard key={l.id} l={l} index={i} canAdd={canAdd}
                  onAdd={() => setTarget({ kind: "location", id: l.id, name: l.name })} />
              ))}
            </div>
          )}
        </>
      )}

      <AddToProjectModal target={target} onClose={() => setTarget(null)} />
      <NewCharacterModal open={creating} onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); openChar(c.id); }} />
    </Page>
  );
}
