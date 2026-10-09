import { clsx } from "clsx";
import { Archive, Columns2, Cpu, Crown, Eye, Film, History, Image as ImageIcon, LifeBuoy, Loader2, Maximize2, Mic, Play, ShieldCheck, Sparkles, Swords, Trophy, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SyncedCompare, usePickWinner } from "../../../components/hub/Compare";
import { QcBadges, QcDetails, qcSummary } from "../../../components/hub/Qc";
import { takeEngine } from "../../../components/hub/util";
import { Badge, Button, Empty, IconButton, Modal } from "../../../components/ui";
import { api } from "../../../lib/api";
import { LANG_SHORT, QUALITY_INFO, ago, usd } from "../../../lib/format";
import { tr, useT } from "../../../lib/i18n";
import type { Shot, Take } from "../../../lib/types";
import { markFresh, type TakeV3 } from "../../../lib/v3";
import { ratioOf, thumbRatio } from "./shotMeta";

const KIND_LABELS: Record<string, string> = {
  lipsync: "Lip-sync", voicelock: "Voice lock", video: "Video", keyframe: "Keyframe", voice: "Voice", narration: "Narration",
};
const KIND_ORDER = ["lipsync", "voicelock", "video", "keyframe", "voice", "narration"];
const isVisual = (k: string) => k === "video" || k === "keyframe" || k === "lipsync" || k === "voicelock";
const isAudio = (k: string) => k === "voice" || k === "narration";

/** The Takes tab: shootout comparison, side-by-side compare, then every take grouped by kind. */
export function Takes({ shot, canEdit, canReview, refresh, aspect, onShootout, onView, viewing }: {
  shot: Shot; canEdit: boolean; canReview: boolean; refresh: () => void; aspect: string; onShootout: () => void;
  /** Show a take in the large viewer at the top of the drawer. */
  onView: (take: Take) => void; viewing: number | null;
}) {
  const t = useT();
  const [compare, setCompare] = useState<number[]>([]);
  const [qcOpen, setQcOpen] = useState<number | null>(null);
  const [shootSel, setShootSel] = useState<number[] | null>(null);
  const [big, setBig] = useState(false);
  const [archiving, setArchiving] = useState<number | null>(null);
  const [freshing, setFreshing] = useState<number | null>(null);
  const { pick, busy } = usePickWinner(shot.id);
  const takes = shot.takes ?? [];
  const staleCount = useMemo(() => takes.filter((x) => (x as TakeV3).stale).length, [takes]);
  const groups = useMemo(() => KIND_ORDER.map((k) => ({ kind: k, items: takes.filter((x) => x.kind === k) })).filter((g) => g.items.length), [takes]);
  const r = ratioOf(aspect);
  const row = r.w / r.h < 1.2; // portrait / square clips get a thumbnail-left row, wide clips a thumbnail-on-top card

  // shootout takes (newest first); by default compare the latest take of each engine, up to 4
  const shoot = useMemo(() => takes.filter((x) => x.kind === "video" && x.params?.shootout), [takes]);
  const defaultShoot = useMemo(() => {
    const seen = new Set<string>();
    const out: Take[] = [];
    for (const x of shoot) {
      const k = String(x.params?.engine || x.model);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
      if (out.length === 4) break;
    }
    return out;
  }, [shoot]);
  const shootPicked = shootSel ? shoot.filter((x) => shootSel.includes(x.id)) : defaultShoot;
  const toggleShoot = (id: number) => setShootSel((cur) => {
    const base = cur ?? defaultShoot.map((x) => x.id);
    return base.includes(id) ? base.filter((x) => x !== id) : [...base, id].slice(-4);
  });
  useEffect(() => { setShootSel(null); setCompare([]); }, [shot.id]);

  const arch = async (x: Take) => {
    setArchiving(x.id);
    try {
      await api.post(`/api/takes/${x.id}/archive`);
      refresh();
      toast.success(tr("Take #{id} archived", { id: x.id }));
    } catch { /* api() showed the error */ } finally { setArchiving(null); }
  };
  const fresh = async (x: Take) => {
    setFreshing(x.id);
    try {
      await markFresh(x.id);
      refresh();
      toast.success(tr("Take #{id} marked fresh", { id: x.id }));
    } catch { /* api() showed the error */ } finally { setFreshing(null); }
  };
  const pair = takes.filter((x) => compare.includes(x.id));

  if (!takes.length) {
    return <Empty icon={<Film className="size-7" />} title={t("No takes yet. Generate a keyframe or video.")} sub={t("Every generation is kept here as a take, so you can compare them and go back.")} />;
  }

  return (
    <div className="space-y-5">
      {staleCount > 0 && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-xs text-warn">
          <History className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {staleCount === 1 ? t("1 take is stale: the shot changed after it was made.") : t("{n} takes are stale: the shot changed after they were made.", { n: staleCount })}
            {" "}{t("Regenerate from the Dashboard, or mark a take fresh if it still fits.")}
          </span>
        </div>
      )}
      {shoot.length > 0 && (
        <section className="hud relative overflow-hidden rounded-xl border border-accent/30 bg-accent/5">
          <header className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent/15 text-accent-ink"><Swords className="size-3.5" /></span>
            <div className="min-w-0 flex-1">
              <h4 className="eyebrow !text-ink">{t("Shootout")}</h4>
              <p className="mt-1.5 truncate text-2xs text-mute">{t("{n} takes · pick the one that goes in the cut", { n: shoot.length })}</p>
            </div>
            {canEdit && <Button size="sm" variant="ghost" onClick={onShootout}>{t("New shootout")}</Button>}
            <IconButton title={t("Compare full size")} onClick={() => setBig(true)}><Maximize2 className="size-4" /></IconButton>
          </header>
          {shoot.length > 2 && (
            <div className="flex flex-wrap gap-1 px-3 pb-2.5">
              {shoot.slice(0, 10).map((x) => {
                const on = shootPicked.some((p) => p.id === x.id);
                return (
                  <button key={x.id} type="button" onClick={() => toggleShoot(x.id)} aria-pressed={on}
                    className={clsx("mono max-w-[190px] truncate rounded-md border px-2 py-0.5 text-2xs transition-colors",
                      on ? "border-accent/50 bg-accent/12 text-ink" : "border-line text-mute hover:border-dim/60 hover:text-ink")}
                    title={t("Show / hide in the comparison")}>
                    {takeEngine(x)} <span className="text-dim">#{x.id}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="border-t border-accent/20 p-2.5">
            {!big && shootPicked.length > 0 && <SyncedCompare takes={shootPicked} shotId={shot.id} canReview={canReview} action="winner" aspect={aspect} />}
            {!canReview && <p className="mt-2 text-2xs text-dim">{t("A reviewer picks the winner.")}</p>}
          </div>
        </section>
      )}

      <AnimatePresence initial={false}>
        {compare.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="flex items-center gap-2 rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-xs text-info">
              <Columns2 className="size-4" /> {compare.length < 2 ? t("Pick one more take to compare") : t("{n} takes side by side", { n: compare.length })}
              <div className="flex-1" />
              <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => setCompare([])}>{t("Clear")}</Button>
            </div>
            {pair.length >= 2 && (
              <div className="mt-2 rounded-xl border border-info/40 p-2.5">
                <SyncedCompare takes={pair} shotId={shot.id} canReview={canReview} action="select" aspect={aspect} />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {groups.map((g) => (
        <section key={g.kind}>
          <h4 className="eyebrow mb-2 flex items-center gap-2">
            <span className="text-mute [&>svg]:size-3.5">{g.kind === "keyframe" ? <ImageIcon /> : isAudio(g.kind) ? <Mic /> : <Film />}</span>
            {t(KIND_LABELS[g.kind] ?? g.kind)}
            <span className="mono text-dim">{g.items.length}</span>
            <span aria-hidden className="h-px flex-1 bg-line" />
          </h4>
          <div className={clsx("grid gap-2.5", row ? "grid-cols-1" : "grid-cols-1 @md:grid-cols-2")}>
            <AnimatePresence initial={false}>
              {g.items.map((x) => (
                <TakeCard key={x.id} x={x} aspect={aspect} row={row || isAudio(x.kind)} showing={viewing === x.id}
                  canEdit={canEdit} canReview={canReview} comparing={compare.includes(x.id)} qcOpen={qcOpen === x.id}
                  busy={busy === x.id} archiving={archiving === x.id} freshing={freshing === x.id}
                  onView={() => onView(x)} onPick={(mode) => pick(x, mode)} onArchive={() => arch(x)} onFresh={() => fresh(x)}
                  onCompare={() => setCompare((c) => (c.includes(x.id) ? c.filter((y) => y !== x.id) : [...c.slice(-3), x.id]))}
                  onToggleQc={() => setQcOpen((o) => (o === x.id ? null : x.id))} />
              ))}
            </AnimatePresence>
          </div>
        </section>
      ))}

      <Modal open={big} onClose={() => setBig(false)} wide
        title={<span className="flex items-center gap-2"><Swords className="size-4 text-accent-ink" />{t("Shootout · {code}", { code: shot.code })}</span>}>
        {shootPicked.length > 0 ? <SyncedCompare takes={shootPicked} shotId={shot.id} canReview={canReview} action="winner" aspect={aspect} />
          : <p className="text-sm text-mute">{t("Pick takes to compare.")}</p>}
      </Modal>
    </div>
  );
}

/** One take: a poster that opens it in the viewer, what made it, its QC, and the actions that apply. */
function TakeCard({ x, aspect, row, showing, canEdit, canReview, comparing, qcOpen, busy, archiving, freshing, onView, onPick, onArchive, onCompare, onToggleQc, onFresh }: {
  x: Take; aspect: string; row: boolean; showing: boolean; canEdit: boolean; canReview: boolean; comparing: boolean; qcOpen: boolean;
  busy: boolean; archiving: boolean; freshing: boolean; onView: () => void; onPick: (mode: "winner" | "select") => void; onArchive: () => void; onCompare: () => void;
  onToggleQc: () => void; onFresh: () => void;
}) {
  const t = useT();
  const q = qcSummary(x);
  const stale = !!(x as TakeV3).stale;
  const staleReason = ((x as TakeV3).stale_reason || "").trim();
  const isShoot = !!x.params?.shootout;
  const isDraft = !!x.params?.draft;
  // engines that blocked the shot before this take was made on another one
  const recoveredFrom: string[] = Array.isArray(x.params?.recovered_from) ? x.params.recovered_from : [];
  const visual = isVisual(x.kind);
  const src = x.thumb_url || (x.kind === "keyframe" ? x.url : "");
  const engine = !isAudio(x.kind) ? takeEngine(x) : "";
  const poster = visual ? (
    <button type="button" onClick={onView} aria-label={t("Show in the viewer")} aria-pressed={showing}
      className={clsx("scr [--scr-l:7px] group/th block shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        row ? "w-[84px] self-start" : "w-full", showing && "is-lit")}
      style={{ aspectRatio: thumbRatio(aspect) }}>
      {src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" /> : <span className="grid size-full place-items-center text-dim"><Film className="size-5" /></span>}
      <span className="absolute inset-0 grid place-items-center bg-black/10 transition-colors group-hover/th:bg-black/35">
        <span className={clsx("grid place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-transform group-hover/th:scale-110", row ? "size-7" : "size-9")}>
          {x.kind === "keyframe" ? <Eye className="size-4" /> : <Play className="size-4 translate-x-px" fill="currentColor" />}
        </span>
      </span>
      {x.selected && (
        <span className="mono pointer-events-none absolute left-1.5 top-1.5 z-[5] inline-flex items-center gap-1 rounded bg-accent px-1 py-0.5 text-2xs font-semibold text-[var(--on-accent)] shadow">
          <Crown className="size-3" />{!row && t("in use")}
        </span>
      )}
      {showing && <span className="mono pointer-events-none absolute bottom-1.5 right-1.5 z-[5] rounded bg-accent px-1 text-2xs font-semibold leading-4 text-[var(--on-accent)]">{t("Viewing")}</span>}
    </button>
  ) : (
    <span className="grid size-10 shrink-0 place-items-center self-start rounded-lg bg-raised text-mute"><Mic className="size-4" /></span>
  );
  return (
    <motion.div layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.18, ease: "easeOut" }}
      className={clsx("overflow-hidden rounded-xl border bg-panel transition-colors",
        x.selected ? "border-accent/60 shadow-[0_0_16px_-8px_var(--color-accent)]" : stale ? "border-warn/40" : q.passed === false ? "border-bad/40" : "border-line hover:border-dim/50", row ? "flex gap-3 p-2.5" : "")}>
      {poster}
      <div className={clsx("min-w-0 flex-1 space-y-1.5 text-2xs", !row && "p-2.5")}>
        <div className="flex flex-wrap items-center gap-1">
          {/* wide cards carry "in use" on the poster; rows and audio takes say it in words */}
          {x.selected && (row || !visual) && <Badge tone="accent"><Crown className="size-3" />{t("in use")}</Badge>}
          {stale && <Badge tone="warn" title={staleReason || t("The shot changed after this take was made")}><History className="size-3" />{t("Stale")}</Badge>}
          {isShoot && <Badge tone="info" title={t("Made in a shootout")}><Swords className="size-3" />{t("shootout")}</Badge>}
          {isDraft && (
            <Badge tone="ai" title={t("A cheap low-resolution preview. It doesn't replace a finished clip; Produce all still makes the final clip.")}>
              <Eye className="size-3" />{t("Draft · {res}", { res: x.params?.resolution || "480p" })}
            </Badge>
          )}
          {recoveredFrom.length > 0 && (
            <Badge title={t("Made on another engine after {n} engine(s) blocked it", { n: recoveredFrom.length })}>
              <LifeBuoy className="size-3" />{t("Recovered")}
            </Badge>
          )}
          {x.language && <Badge>{LANG_SHORT[x.language] ?? x.language}</Badge>}
          {x.params?.quality && <Badge>{t(QUALITY_INFO[x.params.quality]?.label ?? x.params.quality)}</Badge>}
          {x.params?.mode && <Badge tone="info">{String(x.params.mode).replaceAll("_", " ")}</Badge>}
          <QcBadges take={x} />
          {x.params?.warning && <Badge tone="warn">{t(x.params.warning)}</Badge>}
        </div>
        {engine && <p className="mono flex items-center gap-1 truncate text-mute" title={x.params?.engine || x.model}><Cpu className="size-3 shrink-0" />{engine}</p>}
        <p className="mono truncate tabular-nums text-dim">#{x.id} · <span className="text-money">{usd(x.cost_usd)}</span> · {ago(x.created_at)}</p>
        {stale && (
          <p className="flex items-start gap-1 text-warn" title={staleReason || undefined}>
            <History className="mt-px size-3 shrink-0" />
            <span className="line-clamp-2">{staleReason ? t("Stale: {reason}", { reason: staleReason }) : t("Stale: the shot changed after this take was made")}</span>
          </p>
        )}
        {x.params?.edit_instruction && <p className="truncate text-mute">✎ {x.params.edit_instruction}</p>}
        {isAudio(x.kind) && <audio src={x.url} controls preload="none" className="h-8 w-full" />}
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {!x.selected && canReview && (isShoot ? (
            <Button size="sm" variant="primary" icon={<Trophy className="size-3.5" />} loading={busy} onClick={() => onPick("winner")}>{t("Pick winner")}</Button>
          ) : (
            <Button size="sm" loading={busy} onClick={() => onPick("select")}>{t("Use this")}</Button>
          ))}
          {stale && canReview && (
            <Button size="sm" variant="outline" icon={<Sparkles className="size-3.5" />} loading={freshing} onClick={onFresh}
              title={t("Keep this take: clear the stale flag")}>{t("Mark fresh")}</Button>
          )}
          <span className="flex-1" />
          {visual && (
            <IconButton title={comparing ? t("Remove from compare") : t("Compare")} active={comparing} className="!size-7" onClick={onCompare}>
              <Columns2 className="size-3.5" />
            </IconButton>
          )}
          {(q.checked || q.retakes > 0 || (x.params?.attempts?.length ?? 0) > 0) && (
            <IconButton title={t("Quality check details")} active={qcOpen} className="!size-7" onClick={onToggleQc}>
              <ShieldCheck className="size-3.5" />
            </IconButton>
          )}
          {canEdit && (
            <IconButton title={t("Archive")} className="!size-7" disabled={archiving} onClick={onArchive}>
              {archiving ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
            </IconButton>
          )}
        </div>
        <AnimatePresence initial={false}>
          {qcOpen && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden pt-1">
              <QcDetails take={x} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
