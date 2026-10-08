/** The campaign status board: one card per language × aspect (× duration) variant, with download and publish links. */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { CheckCircle2, Download, ExternalLink, Hourglass, Loader2, Lock, Megaphone, Play, Scissors, Square, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { LANG_NAMES, LANG_SHORT, secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { agoT, downloadUrl } from "../growth/common";
import { LoadError, RoomEmpty, SectionCard } from "../room/kit";
import { Badge, Button, Modal, Progress, Skeleton, rise } from "../ui";
import { Swatches } from "./BrandFacts";
import { ASPECT_RATIO, stopJob, type CampaignState, type Variant } from "./types";

const STATUS_TONE: Record<CampaignState["status"], "neutral" | "accent" | "ok" | "warn" | "bad"> = {
  none: "neutral", running: "accent", done: "ok", partial: "warn", failed: "bad", cancelled: "neutral", stopped: "neutral",
};

function statusLabel(t: (s: string) => string, s: CampaignState["status"]) {
  return { none: t("No campaign"), running: t("Running"), done: t("Done"), partial: t("Partly done"), failed: t("Failed"), cancelled: t("Stopped"), stopped: t("Stopped") }[s];
}

function VariantCard({ v, pid, index, onPlay }: { v: Variant; pid: number; index: number; onPlay: () => void }) {
  const t = useT();
  const r = rise(index);
  const ex = v.export;
  const ready = v.status === "ready" && !!ex?.url;
  const failed = v.status === "failed";
  const working = v.status === "queued" || v.status === "running";
  const ratio = ASPECT_RATIO[v.aspect] ?? 9 / 16;
  const name = t(LANG_NAMES[v.language] ?? v.language);
  return (
    <li {...r} className={clsx("flex flex-col overflow-hidden rounded-xl border border-line bg-panel", working && "gen-ring", r.className)}>
      <button type="button" onClick={onPlay} disabled={!ready} aria-label={ready ? t("Play {name} {aspect}", { name, aspect: v.aspect }) : undefined}
        aria-hidden={!ready || undefined} tabIndex={ready ? 0 : -1}
        className="group relative grid aspect-[16/10] w-full place-items-center bg-raised/60 disabled:cursor-default">
        <span className="relative overflow-hidden rounded-md bg-black ring-1 ring-inset ring-white/10" style={{ aspectRatio: String(ratio), height: ratio < 1 ? "82%" : ratio > 1 ? "58%" : "70%" }}>
          {ready && ex?.thumb_url ? (
            <img src={ex.thumb_url} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
          ) : (
            <span className="grid size-full place-items-center text-dim">
              {working ? <Loader2 className="size-5 animate-spin text-accent-ink" /> : failed ? <TriangleAlert className="size-5 text-bad" /> : <Hourglass className="size-5" />}
            </span>
          )}
          {ready && <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/30"><Play className="size-6 fill-white text-white opacity-0 drop-shadow transition-opacity group-hover:opacity-100" /></span>}
        </span>
      </button>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium leading-tight">{name} <span className="text-mute">· {v.aspect}</span></p>
            <p className="mt-0.5 text-2xs text-dim">{v.cut ? t("{n}s cut", { n: v.duration }) : t("Full length")}{ex?.duration_s ? ` · ${secs(ex.duration_s)}` : ""}</p>
          </div>
          {ready ? <Badge tone="ok"><CheckCircle2 className="size-3" />{t("Ready")}</Badge>
            : failed ? <Badge tone="bad" title={v.error}><TriangleAlert className="size-3" />{t("Failed")}</Badge>
            : working ? <Badge tone="accent"><Loader2 className="size-3 animate-spin" />{v.status === "running" ? t("Rendering") : t("Queued")}</Badge>
            : <Badge>{t("Planned")}</Badge>}
        </div>
        {failed && v.error && <p className="line-clamp-2 text-2xs text-bad" title={v.error}>{v.error}</p>}
        {ex?.published?.youtube?.video_id && <p className="text-2xs text-ok">{t("Published on YouTube")}</p>}
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
          <Button size="sm" variant="outline" disabled={!ready} icon={<Download className="size-3.5" />}
            onClick={() => ex && downloadUrl(ex.url, `${LANG_SHORT[v.language] ?? v.language}_${v.aspect.replace(":", "x")}_${v.duration}s.mp4`)}>{t("Download")}</Button>
          <Link to={`/p/${pid}/export`} className={clsx("inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink", !ready && "pointer-events-none opacity-45")}
            aria-disabled={!ready}>
            <ExternalLink className="size-3.5" />{t("Publish")}
          </Link>
        </div>
      </div>
    </li>
  );
}

export function BoardSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="flex items-center gap-3"><Skeleton className="h-5 w-24" /><Skeleton className="h-2 flex-1" /><Skeleton className="h-5 w-16" /></div>
      <ul className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className="overflow-hidden rounded-xl border border-line bg-panel"><Skeleton className="aspect-[16/10] rounded-none" /><div className="space-y-2 p-3"><Skeleton className="h-4 w-28" /><Skeleton className="h-3 w-16" /><Skeleton className="h-7 w-24" /></div></li>
        ))}
      </ul>
    </div>
  );
}

export default function CampaignBoard({ state, isLoading, isError, refetch, pid, canEdit, index, onNew }: {
  state: CampaignState | undefined; isLoading: boolean; isError: boolean; refetch: () => void; pid: number; canEdit: boolean; index?: number;
  onNew?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [playing, setPlaying] = useState<Variant | null>(null);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const stop = async () => {
    if (!state?.job_id) return;
    setStopping(true);
    try {
      await stopJob(state.job_id);
      toast.success(t("Campaign stopped"));
      qc.invalidateQueries({ queryKey: ["campaign"] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      setConfirmStop(false);
    } catch { /* toasted */ } finally { setStopping(false); }
  };

  const body = (() => {
    if (isError && !state) return <LoadError onRetry={refetch} what={t("Couldn't load the campaign")} />;
    if (isLoading || !state) return <BoardSkeleton />;
    if (state.status === "none" || !state.variants.length) {
      return <RoomEmpty icon={<Megaphone />} title={t("No campaign yet")} sub={t("Fill in the brief, pick languages and aspect ratios, and run it: every variant lands here.")}
        action={canEdit && onNew ? <Button variant="outline" onClick={onNew}>{t("Start with the brief")}</Button> : undefined} />;
    }
    const p = state.progress ?? { done: 0, failed: 0, total: state.variants.length };
    const running = state.status === "running";
    const full = state.variants.filter((v) => !v.cut);
    const cuts = state.variants.filter((v) => v.cut);
    const groups = [{ key: "full", label: t("Full length"), items: full }, ...[...new Set(cuts.map((c) => c.duration))].map((d) => ({ key: `cut-${d}`, label: t("{n}s cut", { n: d }), items: cuts.filter((c) => c.duration === d) }))]
      .filter((g) => g.items.length);
    const facts = state.brand_facts;
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge tone={STATUS_TONE[state.status]} dot={!running}>{running && <Loader2 className="size-3 animate-spin" />}{statusLabel(t, state.status)}</Badge>
          <div className="min-w-32 flex-1 basis-40">
            <Progress value={p.total ? p.done / p.total : 0} tone={state.status === "failed" ? "bad" : p.failed ? "warn" : running ? "accent" : "ok"} indeterminate={running && p.done === 0} />
          </div>
          <span className="text-xs tabular-nums text-mute">{t("{a}/{b} ready", { a: p.done, b: p.total })}{p.failed ? ` · ${t("{n} failed", { n: p.failed })}` : ""}</span>
          {state.started_at && <span className="text-2xs text-dim">{state.finished_at ? t("finished {ago}", { ago: agoT(state.finished_at) }) : t("started {ago}", { ago: agoT(state.started_at) })}</span>}
          {running && canEdit && state.job_id && (
            <Button size="sm" variant="danger" icon={<Square className="size-3" />} onClick={() => setConfirmStop(true)}>{t("Stop")}</Button>
          )}
        </div>
        {running && state.job?.message && <p className="text-xs text-mute">{state.job.message}</p>}
        {state.error && <p className="text-xs text-bad">{state.error}</p>}
        {facts && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-accent/25 bg-accent/5 px-3 py-2 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-accent-ink"><Lock className="size-3.5" />{t("Locked")}</span>
            <span className="text-mute">{facts.name || t("No brand kit")}</span>
            <Swatches colors={facts.colors} size="sm" />
            {facts.tagline && <span className="truncate text-mute" title={facts.tagline}>{facts.tagline}</span>}
            {facts.cta && <span className="truncate font-medium" title={facts.cta}>{t("CTA")}: {facts.cta}</span>}
          </div>
        )}
        {groups.map((g, gi) => (
          <div key={g.key}>
            {groups.length > 1 && <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-dim">{g.key !== "full" && <Scissors className="size-3" />}{g.label}</h3>}
            <ul className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
              {g.items.map((v, i) => <VariantCard key={`${v.language}-${v.aspect}-${v.duration}`} v={v} pid={pid} index={gi * 4 + i} onPlay={() => setPlaying(v)} />)}
            </ul>
          </div>
        ))}
        <p className="text-2xs text-dim">{t("Publishing (YouTube, review links, Make.com) lives on the Export page: every variant is a normal render there.")}</p>
      </div>
    );
  })();

  return (
    <SectionCard title={t("Campaign")} description={t("Every variant of this episode, rendered with the locked brand facts.")} icon={<Megaphone />} index={index}>
      {body}
      <Modal open={!!playing} onClose={() => setPlaying(null)} size={playing && ASPECT_RATIO[playing.aspect] < 0.9 ? "md" : "lg"}
        title={playing ? `${t(LANG_NAMES[playing.language] ?? playing.language)} · ${playing.aspect}${playing.cut ? ` · ${t("{n}s cut", { n: playing.duration })}` : ""}` : ""}>
        {playing?.export?.url && <video src={playing.export.url} controls autoPlay playsInline className="mx-auto max-h-[72vh] max-w-full rounded-xl bg-black" />}
      </Modal>
      <Modal open={confirmStop} onClose={() => setConfirmStop(false)} title={t("Stop this campaign?")} size="sm"
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmStop(false)}>{t("Keep running")}</Button>
          <Button variant="danger" loading={stopping} onClick={stop}>{t("Stop campaign")}</Button>
        </>}>
        <p className="text-sm text-mute">{t("Dubs and renders still waiting are cancelled; finished variants stay. You can run it again later.")}</p>
      </Modal>
    </SectionCard>
  );
}
