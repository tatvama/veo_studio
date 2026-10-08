import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AlertCircle, ArrowRight, CheckCircle2, Gauge, Repeat, Sparkles, Wand2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { CriticReport, Episode, SubmitResult } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { useGenerate } from "../Generate";
import { AnimatedNumber, Badge, Button, Progress, Select } from "../ui";
import { Fact, PanelHead, RoomEmpty, ScoreBar } from "./kit";
import { scoreTone, TONE_STROKE, TONE_TEXT, TONE_TEXT_SM, useActiveJobs } from "./util";

const DIMENSIONS: Record<string, string> = {
  hook: "Hook", clarity: "Clarity", pacing: "Pacing", emotion: "Emotion", dialogue: "Dialogue",
  cultural_fit: "Cultural fit", visual_potential: "Visual potential",
};

const human = (k: string) => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Circular 0–10 score. A small tick on the ring marks the pass bar. */
export function ScoreRing({ value, size = 88, bar = 7.5, label }: { value: number; size?: number; bar?: number; label?: string }) {
  const stroke = Math.max(6, size / 11);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value / 10));
  const tone = scoreTone(value, bar);
  const ang = Math.max(0, Math.min(1, bar / 10)) * 2 * Math.PI;
  const [tx1, ty1, tx2, ty2] = [0, 1].map((k) => (r + (k ? stroke * 0.75 : -stroke * 0.75)) as number).flatMap((rr) => [size / 2 + rr * Math.cos(ang), size / 2 + rr * Math.sin(ang)]);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${value.toFixed(1)} / 10`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-line" />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          className={TONE_STROKE[tone]} strokeDasharray={c}
          initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - pct) }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} />
        <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} className="stroke-mute" strokeWidth={2} strokeLinecap="round" opacity={0.7} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={clsx("font-semibold tabular-nums leading-none", TONE_TEXT[tone], size >= 100 ? "text-3xl" : "text-xl")}><AnimatedNumber value={value} format={(n) => n.toFixed(1)} duration={0.8} /></span>
        {label && <span className="mt-1 text-2xs text-dim">{label}</span>}
      </div>
    </div>
  );
}

/** Script critic: quick critique (sync) or the critic → rewrite loop (job). Report persists on Episode.critic. */
export function CriticPanel({ ep, onUseNotes }: { ep: Episode; onUseNotes?: (notes: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { project, canEdit } = useProjectCtx();
  const { submit } = useGenerate();
  const { data: settings } = useSettings();
  const bar = Number(settings?.settings.critic_min_score ?? 7.5);
  const [rounds, setRounds] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const running = useActiveJobs(project.id, (j) => j.type === "critic_loop" && j.episode_id === ep.id)[0];
  const r = ep.critic as Partial<CriticReport>;
  const has = typeof r?.overall === "number";
  const hasScript = !!ep.script?.scenes?.length;
  const nRounds = rounds ?? Number(settings?.settings.critic_rounds ?? 1);

  const quick = async () => {
    setBusy("once");
    try {
      const rep = await api.post<CriticReport>(`/api/episodes/${ep.id}/critic/once`);
      await qc.invalidateQueries({ queryKey: ["episode", ep.id] });
      toast.success(tr("Critique ready · {score}/10", { score: rep.overall.toFixed(1) }));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const loop = async () => {
    setBusy("loop");
    try {
      await submit(() => api.post<SubmitResult>(`/api/episodes/${ep.id}/critic`, { rounds: nRounds }), tr("Critic loop"));
    } finally { setBusy(""); }
  };

  const scores = Object.entries(r?.scores ?? {}).filter(([, v]) => typeof v === "number");
  const history = r?.history ?? [];
  const passed = has && r.overall! >= bar;

  return (
    <div>
      <PanelHead title={t("Script critic")}
        description={t("A script editor scores the draft. The loop rewrites until it clears the bar ({bar}).", { bar: bar.toFixed(1) })}
        actions={canEdit && (
          <>
            <Button size="sm" loading={busy === "once"} disabled={!hasScript || !!running} icon={<Sparkles className="size-3.5" />} onClick={quick}>
              {t("Quick critique")}
            </Button>
            <Select aria-label={t("Rounds")} title={t("Maximum rewrite rounds")} value={nRounds} onChange={(e) => setRounds(Number(e.target.value))}
              className="h-7! w-28! text-xs!">
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n === 1 ? t("1 round") : t("{n} rounds", { n })}</option>)}
            </Select>
            <Button size="sm" variant="primary" loading={busy === "loop"} disabled={!hasScript || !!running}
              icon={<Repeat className="size-3.5" />} onClick={loop}>{t("Critic loop")}</Button>
          </>
        )} />

      <AnimatePresence initial={false}>
        {running && (
          <motion.div key="run" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mb-4 rounded-lg border border-info/30 bg-info/10 p-3">
              <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-sky-300">{running.message || t("Critic loop running…")}</span>
                <span className="shrink-0 tabular-nums text-mute">{Math.round((running.progress || 0) * 100)}%</span>
              </div>
              <Progress value={running.progress || 0} tone="info" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!has ? (
        <RoomEmpty icon={<Gauge className="size-7" />} title={t("No critique yet")} sub={hasScript ? t("Run a quick critique for scores and notes, or the loop to auto-revise.") : t("Write the script first.")} />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-x-8 gap-y-5 @2xl:grid-cols-[11rem_minmax(0,1fr)]">
            <div className="flex flex-col items-center gap-2.5 text-center">
              <ScoreRing value={r.overall!} bar={bar} size={112} label={t("overall")} />
              <Fact tone={passed ? "ok" : "warn"} icon={passed ? <CheckCircle2 /> : <AlertCircle />}>{passed ? t("Clears the bar") : t("Below the bar")}</Fact>
              <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-2xs text-dim">
                {typeof r.round === "number" && <Badge>{t("Round {n}", { n: r.round + 1 })}</Badge>}
                {r.at && <span title={new Date(r.at).toLocaleString()}>{ago(r.at)}</span>}
              </div>
              {history.length > 1 && (
                <div className="flex flex-wrap items-center justify-center gap-1 text-xs" aria-label={t("Score by round")}>
                  {history.map((h, i) => (
                    <span key={i} className="flex items-center gap-1">
                      {i > 0 && <ArrowRight className="size-3 text-dim" />}
                      <span className={clsx("font-medium tabular-nums", TONE_TEXT_SM[scoreTone(h.overall, bar)])}>{h.overall.toFixed(1)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="grid content-start gap-x-8 gap-y-3.5 @xl:grid-cols-2">
              {scores.map(([k, v], i) => (
                <ScoreBar key={k} label={t(DIMENSIONS[k] ?? human(k))} value={v} tone={scoreTone(v, bar)} delay={i * 0.04} marker={bar} />
              ))}
              <p className="col-span-full flex items-center gap-1.5 text-2xs text-dim"><span aria-hidden className="h-3 w-px bg-mute/60" />{t("Tick = the pass bar ({bar})", { bar: bar.toFixed(1) })}</p>
            </div>
          </div>

          <div className="grid gap-4 @2xl:grid-cols-2">
            <NoteList title={t("What works")} items={r.strengths ?? []} tone="ok" icon={<CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" />} />
            <NoteList title={t("Problems to fix")} items={r.problems ?? []} tone="warn" icon={<AlertCircle className="mt-0.5 size-3.5 shrink-0 text-warn" />} />
          </div>

          {r.rewrite_instructions && (
            <div className="rounded-xl border border-accent/25 bg-accent/6 p-3.5">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-accent-ink"><Wand2 className="size-3.5" />{t("Suggested fixes for the next draft")}</p>
                {canEdit && onUseNotes && (
                  <Button size="sm" variant="outline" icon={<Wand2 className="size-3.5" />} onClick={() => onUseNotes(r.rewrite_instructions!)}>
                    {t("Use as rewrite instructions")}
                  </Button>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{r.rewrite_instructions}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NoteList({ title, items, icon, tone }: { title: string; items: string[]; icon: ReactNode; tone: "ok" | "warn" }) {
  const t = useT();
  return (
    <div className={clsx("rounded-xl border p-3.5", tone === "warn" && items.length ? "border-warn/25 bg-warn/5" : "border-line bg-bg/40")}>
      <p className="mb-2 text-xs font-semibold text-mute">{title}</p>
      {!items.length ? <p className="text-xs text-dim">{t("None noted.")}</p> : (
        <ul className="space-y-2">
          {items.map((s, i) => (
            <motion.li key={i} className="flex gap-2 text-sm leading-snug"
              initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: i * 0.04 }}>
              {icon}<span>{s}</span>
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}
