/** The campaign status board: a language × aspect matrix of variant tiles (play, download, publish), with a KPI strip above it. */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { CheckCircle2, Download, ExternalLink, Hourglass, Loader2, Lock, Megaphone, Minus, Play, RotateCcw, Square, TriangleAlert, Send } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { LANG_NAMES, LANG_SHORT, secs, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { agoT, downloadUrl } from "../growth/common";
import { LoadError, RoomEmpty, SectionCard } from "../room/kit";
import { Badge, Button, IconButton, Metric, Modal, Panel, Progress, Skeleton, rise } from "../ui";
import { Swatches } from "./BrandFacts";
import { ASPECTS, ASPECT_LABEL, ASPECT_RATIO, bodyOfState, priceOf, stopJob, useCampaignEstimate, type Aspect, type CampaignBody, type CampaignState, type Variant } from "./types";
import "../../styles/console.css";
import "../../styles/campaign.css";

export const STATUS_TONE: Record<CampaignState["status"], "neutral" | "accent" | "ok" | "warn" | "bad"> = {
  none: "neutral", running: "accent", done: "ok", partial: "warn", failed: "bad", cancelled: "neutral", stopped: "neutral",
};

export function statusLabel(t: (s: string) => string, s: CampaignState["status"]) {
  return { none: t("No campaign"), running: t("Running"), done: t("Done"), partial: t("Partly done"), failed: t("Failed"), cancelled: t("Stopped"), stopped: t("Stopped") }[s];
}

const NO_BODY: CampaignBody = { languages: [], aspects: [], durations: [], brand_kit_id: null, cta: "", captions: true, publish: false, brief: { product: "", audience: "", tone: "" } };
const fileName = (v: Variant) => `${LANG_SHORT[v.language] ?? v.language}_${v.aspect.replace(":", "x")}_${v.duration}s.mp4`;
const isReady = (v: Variant) => v.status === "ready" && !!v.export?.url;
const isWorking = (v: Variant) => v.status === "queued" || v.status === "running";

/** The four equalizer bars: work is running. */
function Eq({ idle }: { idle?: boolean }) {
  return <span aria-hidden className={clsx("eq", idle && "is-idle")}><i /><i /><i /><i /></span>;
}

/** Portrait / landscape / square outline for the column headers. */
function AspectGlyph({ aspect }: { aspect: Aspect }) {
  const [w, h] = aspect === "9:16" ? [9, 15] : aspect === "16:9" ? [15, 9] : [12, 12];
  return <span aria-hidden className="inline-block shrink-0 rounded-[2px] border-[1.5px] border-mute" style={{ width: w, height: h }} />;
}

/** One cell of the matrix: a monitor bed with the thumbnail (or its state), a mono footer (state + price) and the actions. */
function Tile({ v, aspect, name, price, pid, index, canEdit, onPlay, onAgain }: {
  v: Variant | undefined; aspect: Aspect; name: string; price: number | undefined; pid: number; index: number; canEdit: boolean; onPlay: () => void; onAgain?: () => void;
}) {
  const t = useT();
  const r = rise(index);
  const ratio = ASPECT_RATIO[aspect] ?? 9 / 16;
  const frame = { aspectRatio: String(ratio), height: ratio < 1 ? "92%" : ratio > 1 ? "62%" : "76%" };
  if (!v) {
    return (
      <div data-state="empty" className="cm-tile">
        <div className="cm-bed text-dim"><Minus className="size-4" aria-hidden /></div>
        <div className="cm-foot"><span className="text-2xs text-dim">{t("Not in this plan")}</span></div>
      </div>
    );
  }
  const ex = v.export;
  const ready = isReady(v), failed = v.status === "failed", working = isWorking(v);
  const state = ready ? "ready" : failed ? "failed" : working ? "working" : "planned";
  const inner = (
    <span className="cm-frame bg-black ring-1 ring-inset ring-white/10" style={frame}>
      {ready && ex?.thumb_url ? (
        <img src={ex.thumb_url} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
      ) : (
        <span className="grid size-full place-items-center text-dim">
          {working ? <Eq /> : failed ? <TriangleAlert className="size-5 text-bad" /> : ready ? <Play className="size-5" /> : <Hourglass className="size-5" />}
        </span>
      )}
      {ready && <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/35"><Play className="size-6 fill-white text-white opacity-0 drop-shadow transition-opacity group-hover:opacity-100" /></span>}
    </span>
  );
  return (
    <div {...r} data-state={state} className={clsx("cm-tile", working ? "gen-ring" : "hud", r.className)}>
      {ready ? (
        <button type="button" onClick={onPlay} aria-label={t("Play {name} {aspect}", { name, aspect })} className="cm-bed cx-monitor group">{inner}</button>
      ) : (
        <div className="cm-bed cx-monitor group" role="img" aria-label={`${name} ${aspect}: ${failed ? t("Failed") : working ? (v.status === "running" ? t("Rendering") : t("Queued")) : t("Planned")}`}>{inner}</div>
      )}
      <div className="cm-foot">
        {ready ? <span className="inline-flex items-center gap-1 text-2xs font-medium text-ok"><CheckCircle2 className="size-3" />{t("Ready")}{ex?.duration_s ? <span className="mono ml-1 font-normal text-dim">{secs(ex.duration_s)}</span> : null}</span>
          : failed ? <span className="inline-flex items-center gap-1 text-2xs font-medium text-bad" title={v.error}><TriangleAlert className="size-3" />{t("Failed")}</span>
          : working ? <span className="inline-flex items-center gap-1 text-2xs font-medium text-accent-ink"><Loader2 className="size-3 animate-spin" />{v.status === "running" ? t("Rendering") : t("Queued")}</span>
          : <span className="inline-flex items-center gap-1 text-2xs font-medium text-dim"><Hourglass className="size-3" />{t("Planned")}</span>}
        {price !== undefined && <span className={clsx("mono text-2xs", price > 0 ? "text-money" : "text-dim")}>{price > 0 ? usd(price) : t("Free")}</span>}
      </div>
      {failed && v.error && <p className="line-clamp-2 px-1 text-2xs leading-snug text-bad" title={v.error}>{v.error}</p>}
      {ex?.published?.youtube?.video_id && <p className="flex items-center gap-1 px-1 text-2xs text-ok"><Send className="size-3" />{t("Published on YouTube")}</p>}
      {ready && (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="min-w-0 flex-1 max-sm:h-10" icon={<Download className="size-3.5" />}
            onClick={() => ex && downloadUrl(ex.url, fileName(v))}>{t("Download")}</Button>
          <Link to={`/p/${pid}/export`} aria-label={t("Publish")} title={t("Publish")}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-line text-mute transition-colors hover:border-dim/50 hover:bg-hover hover:text-ink max-sm:size-10">
            <ExternalLink className="size-3.5" />
          </Link>
        </div>
      )}
      {failed && canEdit && onAgain && (
        <Button size="sm" variant="outline" className="max-sm:h-10" icon={<RotateCcw className="size-3.5" />} onClick={onAgain} title={t("Open the wizard to run this variant again")}>{t("Run again")}</Button>
      )}
    </div>
  );
}

export function BoardSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="flex items-center gap-3"><Skeleton className="h-5 w-24" /><Skeleton className="h-2 flex-1" /><Skeleton className="h-5 w-16" /></div>
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="flex gap-3 border-b border-line p-3"><Skeleton className="h-8 w-32" /><Skeleton className="h-8 flex-1" /><Skeleton className="h-8 flex-1" /><Skeleton className="h-8 flex-1" /></div>
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="flex gap-3 border-b border-line p-3 last:border-0">
            <Skeleton className="h-28 w-32" />
            {Array.from({ length: 3 }, (_, j) => <Skeleton key={j} className="h-28 flex-1" />)}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CampaignBoard({ state, isLoading, isError, refetch, pid, canEdit, index, onNew, eid }: {
  state: CampaignState | undefined; isLoading: boolean; isError: boolean; refetch: () => void; pid: number; canEdit: boolean; index?: number;
  onNew?: () => void;
  /** When given, the board prices its tiles from the plan estimate of the choices this campaign ran with. */
  eid?: number;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [playing, setPlaying] = useState<Variant | null>(null);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [lenSel, setLenSel] = useState("full");

  const hasVariants = !!state && state.status !== "none" && state.variants.length > 0;
  const estBody = useMemo(() => (state && hasVariants ? bodyOfState(state) : NO_BODY), [state, hasVariants]);
  const { data: est } = useCampaignEstimate(eid ?? 0, estBody, !!eid && canEdit && hasVariants);
  const price = useMemo(() => priceOf(est?.items), [est]);

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

  const downloadAll = (vs: Variant[]) => {
    const ready = vs.filter(isReady);
    ready.forEach((v, i) => window.setTimeout(() => downloadUrl(v.export!.url, fileName(v)), i * 350));
    if (ready.length) toast.success(ready.length === 1 ? t("Download started") : t("{n} downloads started", { n: ready.length }));
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
    const lengths = [{ key: "full", label: t("Full length"), items: full }, ...[...new Set(cuts.map((c) => c.duration))].map((d) => ({ key: `cut-${d}`, label: t("{n}s cut", { n: d }), items: cuts.filter((c) => c.duration === d) }))]
      .filter((g) => g.items.length);
    const active = lengths.find((g) => g.key === lenSel) ?? lengths[0];
    const langs = [...new Set(state.variants.map((v) => v.language))];
    const aspects = ASPECTS.filter((a) => state.variants.some((v) => v.aspect === a));
    const facts = state.brand_facts;
    const pick = (l: string, a: Aspect) => active.items.find((v) => v.language === l && v.aspect === a);
    const nameOf = (l: string) => t(LANG_NAMES[l] ?? l);
    const readyIn = (vs: Variant[]) => vs.filter(isReady).length;

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge tone={STATUS_TONE[state.status]} dot={!running}>{running && <Loader2 className="size-3 animate-spin" />}{statusLabel(t, state.status)}</Badge>
          <div className="min-w-32 flex-1 basis-40">
            <Progress value={p.total ? p.done / p.total : 0} tone={state.status === "failed" ? "bad" : p.failed ? "warn" : running ? "accent" : "ok"} indeterminate={running && p.done === 0} />
          </div>
          <span className="mono text-xs text-mute">{t("{a}/{b} ready", { a: p.done, b: p.total })}{p.failed ? ` · ${t("{n} failed", { n: p.failed })}` : ""}</span>
          {state.started_at && <span className="mono text-2xs text-dim">{state.finished_at ? t("finished {ago}", { ago: agoT(state.finished_at) }) : t("started {ago}", { ago: agoT(state.started_at) })}</span>}
          {running && canEdit && state.job_id && (
            <Button size="sm" variant="danger" icon={<Square className="size-3" />} onClick={() => setConfirmStop(true)}>{t("Stop")}</Button>
          )}
        </div>
        {running && state.job?.message && <p className="mono text-xs text-mute">{state.job.message}</p>}
        {state.error && <p className="text-xs text-bad">{state.error}</p>}
        {facts && (
          <div data-tone="accent" className="cx-block flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 text-xs">
            <span className="eyebrow inline-flex items-center gap-1.5 !text-accent-ink"><Lock className="size-3" />{t("Locked")}</span>
            <span className="text-mute">{facts.name || t("No brand kit")}</span>
            <Swatches colors={facts.colors} size="sm" />
            {facts.tagline && <span className="min-w-0 truncate text-mute" title={facts.tagline}>{facts.tagline}</span>}
            {facts.cta && <span className="min-w-0 truncate font-medium" title={facts.cta}>{t("CTA")}: {facts.cta}</span>}
          </div>
        )}

        {lengths.length > 1 && (
          <div role="group" aria-label={t("Length")} className="flex flex-wrap items-center gap-1.5">
            <span className="eyebrow mr-1">{t("Length")}</span>
            {lengths.map((g) => (
              <button key={g.key} type="button" className="cx-chip" aria-pressed={g.key === active.key} onClick={() => setLenSel(g.key)}>
                {g.label}<span className="cx-n">{readyIn(g.items)}/{g.items.length}</span>
              </button>
            ))}
          </div>
        )}

        <div className="cx-scroll rounded-lg border border-line">
          <table className="cm-matrix" style={{ "--cm-cols": aspects.length } as CSSProperties} aria-label={t("Variants by language and aspect ratio")}>
            <thead>
              <tr>
                <th scope="col"><span className="eyebrow">{t("Language")}</span></th>
                {aspects.map((a) => {
                  const col = active.items.filter((v) => v.aspect === a);
                  return (
                    <th key={a} scope="col">
                      <div className="flex items-center gap-2">
                        <AspectGlyph aspect={a} />
                        <div className="min-w-0 flex-1">
                          <p className="mono text-sm font-medium leading-none">{a}</p>
                          <p className="mt-1 truncate text-2xs text-dim">{t(ASPECT_LABEL[a])}</p>
                        </div>
                        <span className="mono text-2xs text-dim">{readyIn(col)}/{col.length}</span>
                        <IconButton title={t("Download all ready {aspect}", { aspect: a })} className="max-sm:size-10" disabled={!readyIn(col)} onClick={() => downloadAll(col)}><Download className="size-3.5" /></IconButton>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {langs.map((l, ri) => {
                const row = active.items.filter((v) => v.language === l);
                const dub = price.dub.get(l) ?? 0;
                return (
                  <tr key={l}>
                    <th scope="row">
                      <div className="flex flex-wrap items-start gap-1.5">
                        <div className="min-w-0 flex-1 basis-full sm:basis-0">
                          <p className="truncate text-sm font-medium" title={nameOf(l)}>{nameOf(l)}</p>
                          <p className="mono mt-1 text-2xs text-dim">{LANG_SHORT[l] ?? l.toUpperCase()} · {readyIn(row)}/{row.length}</p>
                          {dub > 0 && <p className="mono mt-0.5 text-2xs text-money">{t("Dub")} {usd(dub)}</p>}
                        </div>
                        <IconButton title={t("Download all ready {name}", { name: nameOf(l) })} className="-mr-1 max-sm:size-10" disabled={!readyIn(row)} onClick={() => downloadAll(row)}><Download className="size-3.5" /></IconButton>
                      </div>
                    </th>
                    {aspects.map((a, ci) => {
                      const v = pick(l, a);
                      return (
                        <td key={a}>
                          <Tile v={v} aspect={a} name={nameOf(l)} pid={pid} canEdit={canEdit} index={ri * aspects.length + ci} onPlay={() => v && setPlaying(v)} onAgain={onNew}
                            price={v && est ? price.cell.get(`${v.language}|${v.aspect}|${v.duration}`) ?? 0 : undefined} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-2xs text-dim">{t("Publishing (YouTube, review links, Make.com) lives on the Export page: every variant is a normal render there.")}</p>
      </div>
    );
  })();

  // KPI strip: only once a campaign exists.
  const kpis = (() => {
    if (!state || !state.variants.length || state.status === "none") return null;
    const total = state.variants.length;
    const done = state.variants.filter(isReady).length;
    const working = state.variants.filter(isWorking).length;
    const failed = state.variants.filter((v) => v.status === "failed").length;
    return (
      <Panel flush index={index}>
        <div className="cx-kpis" role="group" aria-label={t("Campaign totals")}>
          <Metric label={t("Variants ready")} value={done} unit={<span className="mono text-sm font-normal text-dim">/ {total}</span>} tone={done === total ? "ok" : "neutral"} size="md" />
          <Metric label={t("Generating")} value={working} tone={working ? "accent" : "neutral"} unit={working ? <Eq /> : undefined} size="md" />
          <Metric label={t("Failed")} value={failed} tone={failed ? "bad" : "neutral"} size="md" />
          <Metric label={t("Cost to finish")} value={est ? (est.total_usd > 0 ? usd(est.total_usd) : t("Free")) : "—"} tone={est && est.total_usd > 0 ? "money" : "neutral"} size="md" />
        </div>
      </Panel>
    );
  })();

  return (
    <div className="space-y-4">
      {kpis}
      <SectionCard title={t("Campaign")} description={t("Every variant of this episode, rendered with the locked brand facts.")} icon={<Megaphone />} index={kpis ? undefined : index}>
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
    </div>
  );
}
