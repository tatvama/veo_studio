/** Reels: highlight windows proposed from the shots, "Cut this" per highlight, cut into N shorts, and the marketing pack. */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, ExternalLink, Flame, Images, Megaphone, Play, Scissors, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useMarketing, useSettings } from "../../lib/queries";
import type { Episode, Project, SubmitResult } from "../../lib/types";
import { useGenerate } from "../Generate";
import { agoT, CostConfirm, estimateImages, useActiveJobs } from "../growth/common";
import { LoadError, RoomEmpty, SectionCard } from "../room/kit";
import { Alert, Badge, Button, Metric, Panel, Select, Skeleton, Tag, rise } from "../ui";
import { makeCutdowns, useHighlights, type Highlight } from "./types";
import "../../styles/console.css";

const REASON_LABEL: Record<string, string> = {
  hook: "Opens with the hook shot", approved: "All shots approved", some_approved: "Some shots approved", dialogue: "Dialogue-heavy", video: "Every shot has video",
};

/** One highlight window as a tile: rank (or the hook flame), the time range, where it sits in the episode, why it scored, and "Cut this". */
function HighlightTile({ h, i, total, busy, canEdit, isCut, onCut }: { h: Highlight; i: number; total: number; busy: boolean; canEdit: boolean; isCut: boolean; onCut: () => void }) {
  const t = useT();
  const r = rise(i);
  const hook = h.reasons.includes("hook");
  const left = total > 0 ? Math.max(0, Math.min(98, (h.start_s / total) * 100)) : 0;
  const width = total > 0 ? Math.max(2, Math.min(100 - left, ((h.end_s - h.start_s) / total) * 100)) : 100;
  return (
    <li {...r} className={clsx("cx-block hud flex min-w-0 flex-col gap-3 p-3", r.className)} data-tone={hook ? "accent" : undefined}>
      <div className="flex items-center gap-2.5">
        <span className={clsx("mono grid size-8 shrink-0 place-items-center rounded-lg border text-xs font-semibold", hook ? "border-accent/40 bg-accent/15 text-accent-ink" : "border-line bg-raised text-mute")}
          title={hook ? t(REASON_LABEL.hook) : undefined}>
          {hook ? <Flame className="size-4" aria-label={t(REASON_LABEL.hook)} /> : String(i + 1).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <p className="mono truncate text-sm font-medium leading-tight">{secs(h.start_s)} – {secs(h.end_s)}</p>
          <p className="mono mt-0.5 text-2xs text-dim">{t("{n}s", { n: h.seconds })}</p>
        </div>
        {isCut && <Badge tone="ok"><Check className="size-3" strokeWidth={3} />{t("Cut")}</Badge>}
      </div>
      <div className="relative h-1.5 rounded-full bg-line" role="img" aria-label={`${secs(h.start_s)} – ${secs(h.end_s)} / ${secs(total)}`}>
        <span className="absolute inset-y-0 rounded-full bg-accent shadow-[0_0_8px_-1px_var(--color-accent)]" style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
      <div className="flex min-h-5 flex-wrap gap-1">
        {h.reasons.map((code) => <span key={code} className="rounded-md border border-line bg-panel px-1.5 py-0.5 text-2xs text-mute">{t(REASON_LABEL[code] ?? code)}</span>)}
      </div>
      <p className="mono truncate text-2xs text-dim" title={h.shot_codes.join(" · ")}>{h.shot_codes.join(" · ")}</p>
      {canEdit && <Button size="sm" variant="outline" className="mt-auto max-sm:h-10" loading={busy} icon={<Scissors className="size-3.5" />} onClick={onCut}>{t("Cut this")}</Button>}
    </li>
  );
}

export default function Reels({ project, episode, eid, canEdit, setEpisode }: {
  project: Project; episode: Episode; eid: number; canEdit: boolean; setEpisode: (eid: number) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const { data: hl, isLoading, isError, refetch } = useHighlights(eid);
  const { data: pack } = useMarketing(eid);
  const { data: settings } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [cutDone, setCutDone] = useState<Set<number>>(() => new Set());
  const [made, setMade] = useState<number[]>([]);
  const [n, setN] = useState(3);
  const [seconds, setSeconds] = useState(30);
  const [packOpen, setPackOpen] = useState(false);
  const packJobs = useActiveJobs((j) => j.type === "marketing" && j.episode_id === eid, project.id, () => qc.invalidateQueries({ queryKey: ["marketing", eid] }));

  const cut = async (key: string, body: { count: number; seconds: number }, idx?: number) => {
    setBusy(key);
    try {
      const r = await makeCutdowns(eid, body);
      await qc.invalidateQueries({ queryKey: ["project", project.id] });
      setMade(r.episode_ids);
      if (idx !== undefined) setCutDone((s) => new Set(s).add(idx));
      toast.success(r.episode_ids.length === 1 ? t("Cut-down created") : t("{n} cut-downs created", { n: r.episode_ids.length }));
    } catch { /* toasted */ } finally { setBusy(null); }
  };

  const isCutdown = episode.kind === "cutdown";
  const highlights = hl?.highlights ?? [];
  const platforms = project.aspect === "16:9" ? ["youtube"] : ["youtube_shorts", "instagram_reels"];
  const thumbs = estimateImages(settings, 3);
  const hasPack = !!(pack?.copies?.length || pack?.thumbnail_files?.length);

  // seconds of the episode that sit inside at least one window (windows can overlap)
  const covered = [...highlights].sort((a, b) => a.start_s - b.start_s).reduce((acc, h) => {
    const from = Math.max(h.start_s, acc.end);
    return { sum: acc.sum + Math.max(0, h.end_s - from), end: Math.max(acc.end, h.end_s) };
  }, { sum: 0, end: 0 }).sum;
  return (
    <div className="space-y-4">
      <Panel flush index={0}>
        <div className="cx-kpis" role="group" aria-label={t("Reels totals")}>
          <Metric label={t("Highlights")} value={highlights.length} size="md" />
          <Metric label={t("Covered")} value={secs(covered)} sub={hl ? t("of {len}", { len: secs(hl.total_s) }) : undefined} size="md" />
          <Metric label={t("Cut-downs made")} value={made.length} tone={made.length ? "ok" : "neutral"} size="md" />
          <Metric label={t("Marketing pack")} value={hasPack ? t("Ready") : t("None")} tone={hasPack ? "ok" : "neutral"} size="md" />
        </div>
      </Panel>
    <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
      <SectionCard title={t("Highlights")} description={t("Windows worth a reel, scored from your shots: the hook first, then dialogue-dense runs of approved shots. No model involved.")}
        icon={<Sparkles />} index={1} actions={hl ? <Badge>{t("{n} of {len}", { n: highlights.length, len: secs(hl.total_s) })}</Badge> : undefined}>
        {isError && !hl ? <LoadError onRetry={refetch} what={t("Couldn't load the highlights")} />
          : isLoading || !hl ? (
            <ul className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))]" aria-hidden>{Array.from({ length: 4 }, (_, i) => <li key={i} className="cx-block space-y-3 p-3"><div className="flex items-center gap-2.5"><Skeleton className="size-8" /><div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-3 w-10" /></div></div><Skeleton className="h-1.5 w-full" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-7 w-full" /></li>)}</ul>
          ) : !highlights.length ? (
            <RoomEmpty icon={<Sparkles />} title={t("No highlights yet")} sub={t("Add shots with dialogue, approve the good ones, and the best windows show up here.")} />
          ) : (
            <ul className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))]">
              {highlights.map((h, i) => (
                <HighlightTile key={`${h.start_s}-${h.end_s}`} h={h} i={i} total={hl.total_s} busy={busy === `h${i}`} canEdit={canEdit && !isCutdown} isCut={cutDone.has(i)}
                  onCut={() => cut(`h${i}`, { count: 1, seconds: Math.max(10, Math.min(90, h.seconds)) }, i)} />
              ))}
            </ul>
          )}
        {isCutdown && <p className="mt-3 text-xs text-mute">{t("This is already a cut-down; open the full episode to cut more.")}</p>}
        {made.length > 0 && (
          <Alert tone="ok" className="mt-3" title={made.length === 1 ? t("Cut-down ready to export") : t("{n} cut-downs ready to export", { n: made.length })}
            action={<div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" icon={<Play className="size-3.5" />} onClick={() => setEpisode(made[0])}>{t("Open")}</Button>
              <Link to={`/p/${project.id}/export`} className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-accent-ink hover:underline"><ExternalLink className="size-3.5" />{t("Export page")}</Link>
            </div>}>
            {t("Each cut-down is its own episode in the episode menu: render it on the Export page, or run a campaign on it.")}
          </Alert>
        )}
      </SectionCard>

      <div className="space-y-4">
        <SectionCard title={t("Cut into shorts")} description={t("The Director picks the best shots for standalone shorts, reusing the takes you already paid for.")} icon={<Scissors />} index={2}>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-mute">
              {t("How many")}
              <Select value={n} onChange={(e) => setN(Number(e.target.value))} className="w-20" disabled={!canEdit || isCutdown}>
                {[1, 2, 3, 4, 5, 6].map((k) => <option key={k} value={k}>{k}</option>)}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-mute">
              {t("Seconds each")}
              <Select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="w-24" disabled={!canEdit || isCutdown}>
                {[15, 20, 30, 45, 60, 90].map((k) => <option key={k} value={k}>{k}s</option>)}
              </Select>
            </label>
            <Button className="ml-auto" variant="primary" disabled={!canEdit || isCutdown} loading={busy === "n"} icon={<Scissors className="size-4" />}
              onClick={() => cut("n", { count: n, seconds })}>{t("Cut into {n} shorts", { n })}</Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Tag k={t("Output")}>{n} × {seconds}s</Tag>
            <Tag k={t("Total")}>{secs(n * seconds)}</Tag>
          </div>
          <p className="mt-2 text-2xs text-dim">{t("Free: picking shots uses a little AI text, recorded in the ledger. Rendering happens on the Export page or through a campaign.")}</p>
        </SectionCard>

        <SectionCard title={t("Marketing pack")} description={t("Titles, descriptions, hashtags and three thumbnails per platform and language, ready for publishing.")} icon={<Megaphone />} index={3}
          actions={hasPack ? <Badge tone="ok"><Check className="size-3" strokeWidth={3} />{t("Ready")}</Badge> : undefined}>
          {hasPack ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="cx-block px-3 py-2.5"><p className="eyebrow flex items-center gap-1.5"><Images className="size-3" />{t("Thumbnails")}</p><p className="mono mt-2 text-xl font-medium leading-none">{pack?.thumbnail_files?.length ?? 0}</p></div>
              <div className="cx-block px-3 py-2.5"><p className="eyebrow">{t("Copies")}</p><p className="mono mt-2 text-xl font-medium leading-none">{pack?.copies?.length ?? 0}</p></div>
              {pack?.at && <p className="mono col-span-2 text-2xs text-dim">{agoT(pack.at)}</p>}
            </div>
          ) : (
            <p className="text-sm text-mute">{t("No pack yet for this episode.")}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canEdit && (
              <Button variant="outline" loading={packJobs.length > 0} icon={<Sparkles className="size-4" />} onClick={() => setPackOpen(true)}>
                {hasPack ? t("Make again") : t("Make marketing pack")}
              </Button>
            )}
            <Link to={`/p/${project.id}/export`} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-accent-ink hover:underline">
              <ExternalLink className="size-4" />{t("Review and publish on Export")}
            </Link>
          </div>
          <CostConfirm open={packOpen} onClose={() => setPackOpen(false)} title={t("Marketing pack")} amount={thumbs}
            lines={[{ label: t("Copy for {p} platform(s) × {l} language(s)", { p: platforms.length, l: project.languages.length }), usd: 0 }, { label: t("3 thumbnail images"), usd: thumbs }]}
            note={t("Writing the copy also uses a small amount of AI text, recorded in the ledger.")}
            onConfirm={() => submit(() => api.post<SubmitResult>(`/api/episodes/${eid}/marketing`, { platforms, languages: project.languages }), t("Marketing pack"))} />
        </SectionCard>
      </div>
    </div>
    </div>
  );
}
