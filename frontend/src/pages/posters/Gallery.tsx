/**
 * Poster Studio home (/posters) and a project's posters (/p/:pid/posters): search, scope, archived toggle, a strip of
 * templates to start from, and the designs as cards (thumbnail, format, age, status) with open, duplicate and archive.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive, ArchiveRestore, CheckCircle2, Copy, ExternalLink, Film, Image as ImageIcon, LayoutTemplate, MonitorPlay, Plus, RefreshCw, Smartphone,
  Sparkles, Square,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Alert, Badge, Button, Empty, IconButton, Page, PageHeader, ScrollStrip, SearchField, Section, Segmented, Skeleton, Toggle, rise, useDocumentTitle } from "../../components/ui";
import { cn } from "../../lib/cn";
import { ago } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useAuthStatus } from "../../lib/queries";
import { ROLE_RANK } from "../../lib/types";
import { designsApi, useDesigns } from "./api";
import { DocPreview } from "./canvas/Preview";
import { formatOf, ratioLabel } from "./formats";
import NewDesignDialog, { type NewDesignInitial } from "./NewDesign";
import { TEMPLATES, templateOf } from "./templates";
import type { Design } from "./types";

/** Inside a project the project layout owns the tab title. */
function GalleryTitle() {
  const t = useT();
  useDocumentTitle(t("Poster Studio"));
  return null;
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(id); }, [value, ms]);
  return v;
}

/** When there is no thumbnail yet: the template's colours (or the accent) behind a frame in the design's shape. */
function FallbackThumb({ d }: { d: Design }) {
  const t = useT();
  const tpl = templateOf(d.template);
  const k = 0.62 / Math.max(d.width, d.height);
  const label = formatOf(d.format)?.label;
  return (
    <div className={cn("absolute inset-0 grid place-items-center", !tpl && "bg-gradient-to-br from-accent/18 via-raised to-accent-2/14")}
      style={tpl ? { background: `linear-gradient(135deg, ${tpl.swatch[0]}, ${tpl.swatch[1]})` } : undefined}>
      <div className={cn("grid place-items-center rounded-md border text-center shadow-lg backdrop-blur-[2px]",
        tpl ? "border-white/35 bg-black/20 text-white" : "border-line bg-panel/70 text-ink")}
        style={{ width: `${d.width * k * 100}%`, height: `${d.height * k * 100}%` }}>
        <span className="px-1">
          <span className="block truncate text-2xs font-medium">{label ? t(label) : t("Custom")}</span>
          <span className="mono block text-[10px] opacity-80">{ratioLabel(d.width, d.height)}</span>
        </span>
      </div>
    </div>
  );
}

function DesignCard({ d, i, canEdit, onDuplicate, onArchive }: {
  d: Design; i: number; canEdit: boolean; onDuplicate: (d: Design) => void; onArchive: (d: Design) => void;
}) {
  const t = useT();
  const nav = useNavigate();
  const [broken, setBroken] = useState(false);
  const fmt = formatOf(d.format);
  const r = rise(i);
  const act = "size-7 rounded-md border border-line bg-panel/90 text-mute shadow-card backdrop-blur hover:bg-hover hover:text-ink";
  return (
    <div className={cn("group relative", r.className)} style={r.style}>
      <Link to={`/posters/${d.id}`}
        className="hud lift block overflow-hidden rounded-xl border border-line bg-panel outline-none transition-colors hover:border-accent/40 focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/30">
        <div className="relative aspect-square overflow-hidden border-b border-line bg-raised">
          {d.thumb_url && !broken ? (
            <img src={d.thumb_url} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)}
              className="absolute inset-0 m-auto max-h-[86%] max-w-[86%] rounded-[3px] object-contain shadow-[0_10px_30px_-12px_rgb(0_0_0/0.6)] transition-transform duration-300 group-hover:scale-[1.02]" />
          ) : <FallbackThumb d={d} />}
          {d.status === "approved" && (
            <span className="absolute left-2 top-2"><Badge tone="ok"><CheckCircle2 className="size-3" />{t("Approved")}</Badge></span>
          )}
          {d.archived && <span className="absolute bottom-2 left-2"><Badge><Archive className="size-3" />{t("Archived")}</Badge></span>}
        </div>
        <div className="space-y-0.5 px-2.5 py-2">
          <p className="truncate text-sm font-medium text-ink" title={d.title}>{d.title || t("Untitled design")}</p>
          <p className="flex items-center gap-1.5 text-2xs text-dim">
            <span className="truncate">{fmt ? t(fmt.label) : t("Custom")}</span>
            <span className="mono shrink-0">{d.width}×{d.height}</span>
          </p>
          <p className="mono text-[10px] text-dim">{t("Edited")} {ago(d.updated_at)}</p>
        </div>
      </Link>
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <IconButton title={t("Open")} className={act} onClick={() => nav(`/posters/${d.id}`)}><ExternalLink className="size-3.5" /></IconButton>
        {canEdit && <IconButton title={t("Duplicate")} className={act} onClick={() => onDuplicate(d)}><Copy className="size-3.5" /></IconButton>}
        {canEdit && (
          <IconButton title={d.archived ? t("Restore") : t("Archive")} className={act} onClick={() => onArchive(d)}>
            {d.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </IconButton>
        )}
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <Skeleton className="aspect-square rounded-none" />
      <div className="space-y-1.5 p-2.5"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>
    </div>
  );
}

/** "Start from a template": live previews at each template's best size. */
function TemplateStrip({ onPick }: { onPick: (key: string) => void }) {
  const t = useT();
  const items = useMemo(() => TEMPLATES.map((tpl) => {
    const f = formatOf(tpl.formats[0]) ?? { width: 1080, height: 1350 };
    return { tpl, w: f.width, h: f.height, doc: tpl.build({ width: f.width, height: f.height }) };
  }), []);
  return (
    <Section title={t("Start from a template")} description={t("Every template re-lays itself for any size, and fills with your project's cast and copy.")}>
      <ScrollStrip className="-mx-1 flex gap-3 px-1 pb-2">
        {items.map(({ tpl, w, h, doc }, i) => {
          const r = rise(i);
          return (
            <button key={tpl.key} type="button" onClick={() => onPick(tpl.key)} title={t(tpl.description)}
              className={cn("hud group w-36 shrink-0 rounded-xl border border-line bg-panel p-1.5 text-left outline-none transition-colors hover:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/40", r.className)}
              style={r.style}>
              <span className="grid h-40 place-items-center overflow-hidden rounded-lg bg-raised">
                <DocPreview doc={doc} width={w} height={h} maxSize={128} className="rounded-sm shadow-card transition-transform duration-300 group-hover:scale-[1.03]" />
              </span>
              <span className="mt-1.5 block truncate px-1 text-xs font-medium text-ink">{t(tpl.label)}</span>
              <span className="block truncate px-1 pb-0.5 text-2xs text-dim">{t(tpl.category)} · {ratioLabel(w, h)}</span>
            </button>
          );
        })}
      </ScrollStrip>
    </Section>
  );
}

/** Poster Studio home (/posters) and a project's posters (/p/:pid/posters). */
export default function PostersGallery({ projectId }: { projectId?: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: auth } = useAuthStatus();
  const canEdit = ROLE_RANK[auth?.user?.role ?? "viewer"] >= ROLE_RANK.creator;
  const inProject = !!projectId;
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput.trim(), 250);
  const [scope, setScope] = useState<"project" | "all">("project");
  const [archived, setArchived] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; initial?: NewDesignInitial }>({ open: false });
  const { data, isLoading, error, refetch, isFetching } = useDesigns(inProject && scope === "project" ? projectId : null, q, archived);
  const nav = useNavigate();

  const designs = data ?? [];
  const approved = designs.filter((d) => d.status === "approved").length;
  const newDesign = (initial?: NewDesignInitial) => setDialog({ open: true, initial });
  const refresh = () => qc.invalidateQueries({ queryKey: ["designs"] });

  const duplicate = async (d: Design) => {
    try {
      const copy = await designsApi.duplicate(d.id);
      refresh();
      toast.success(t("Duplicated “{title}”", { title: d.title }), { action: { label: t("Open"), onClick: () => nav(`/posters/${copy.id}`) } });
    } catch { /* toasted */ }
  };
  const archive = async (d: Design) => {
    try {
      await designsApi.archive(d.id, d.archived);
      refresh();
      if (d.archived) toast.success(t("Restored “{title}”", { title: d.title }));
      else toast.success(t("Archived “{title}”", { title: d.title }), {
        action: { label: t("Undo"), onClick: () => { void designsApi.archive(d.id, true).then(refresh); } },
      });
    } catch { /* toasted */ }
  };

  const quick: { key: string; label: string; icon: typeof Film }[] = [
    { key: "film_poster", label: t("Film poster"), icon: Film },
    { key: "yt_thumbnail", label: t("YouTube thumbnail"), icon: MonitorPlay },
    { key: "ig_post", label: t("Instagram post"), icon: Square },
    { key: "story", label: t("Story"), icon: Smartphone },
  ];
  const searching = !!q;
  const showStrip = canEdit && !archived && !searching;

  return (
    <Page width="wide">
      {!inProject && <GalleryTitle />}
      <PageHeader
        icon={<LayoutTemplate className="size-5" />}
        eyebrow={inProject ? t("Project posters") : undefined}
        title={t("Poster Studio")}
        subtitle={t("Film posters, thumbnails, social posts and festival greetings. Real text in every Indian script; AI art from your locked cast.")}
        actions={canEdit ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => newDesign()}>{t("New design")}</Button> : undefined}
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <SearchField value={qInput} onChange={setQInput} placeholder={t("Search designs")} className="w-full sm:w-72" aria-label={t("Search designs")} />
        {inProject && (
          <Segmented size="sm" value={scope} onChange={setScope} aria-label={t("Which designs")}
            options={[{ value: "project", label: t("This project") }, { value: "all", label: t("All designs") }]} />
        )}
        <Toggle checked={archived} onChange={setArchived} label={<span className="text-xs text-mute">{t("Archived")}</span>} />
        <span className="ml-auto flex items-center gap-2 text-2xs text-dim">
          {isFetching && !isLoading && <RefreshCw className="size-3 animate-spin" aria-label={t("Refreshing")} />}
          {!isLoading && !error && (
            <span className="mono">{t("{n} designs", { n: designs.length })}{approved ? ` · ${t("{n} approved", { n: approved })}` : ""}</span>
          )}
        </span>
      </div>

      {showStrip && <TemplateStrip onPick={(key) => newDesign({ template: key })} />}

      <Section title={archived ? t("Archived designs") : searching ? t("Results") : t("Your designs")}>
        {error ? (
          <Alert tone="bad" title={t("Couldn't load designs")} action={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => refetch()}>{t("Retry")}</Button>}>
            {error instanceof Error ? error.message : t("Something went wrong.")}
          </Alert>
        ) : isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] sm:gap-4">
            {Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : designs.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] sm:gap-4">
            {designs.map((d, i) => <DesignCard key={d.id} d={d} i={i} canEdit={canEdit} onDuplicate={duplicate} onArchive={archive} />)}
          </div>
        ) : searching || archived ? (
          <Empty icon={<ImageIcon className="size-7" />} title={searching ? t("No designs match “{q}”", { q }) : t("Nothing archived")}
            sub={searching ? t("Try another word: titles, templates and formats are searched.") : t("Archived designs show up here and can be restored.")}
            action={searching ? <Button variant="ghost" onClick={() => setQInput("")}>{t("Clear search")}</Button> : undefined} />
        ) : (
          <Empty icon={<Sparkles className="size-7" />} title={inProject && scope === "project" ? t("No posters for this project yet") : t("No designs yet")}
            sub={t("Pick a size to start. Templates, AI backgrounds and your characters are one click away in the editor.")}
            action={canEdit ? (
              <div className="flex flex-col items-center gap-4">
                <Button variant="primary" size="lg" icon={<Plus className="size-4" />} onClick={() => newDesign()}>{t("Create your first design")}</Button>
                <div className="flex flex-wrap justify-center gap-2">
                  {quick.map((qk) => {
                    const f = formatOf(qk.key);
                    return (
                      <button key={qk.key} type="button" onClick={() => newDesign({ format: qk.key })}
                        className="hud inline-flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink transition-colors hover:border-accent/40 hover:bg-hover">
                        <qk.icon className="size-4 text-accent-ink" />{qk.label}
                        {f && <span className="mono text-2xs text-dim">{ratioLabel(f.width, f.height)}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : undefined} />
        )}
      </Section>

      <NewDesignDialog open={dialog.open} initial={dialog.initial} projectId={projectId ?? null} onClose={() => setDialog((s) => ({ ...s, open: false }))} />
    </Page>
  );
}
