/** Smaller "make more from this episode" panels of the Export page: dubbing and cut-downs. */
import { Check, Languages, Loader2, Minus, Plus, Scissors } from "lucide-react";
import { useState } from "react";
import "../../styles/console.css";
import { LANG_NAMES } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Episode, Job, Project } from "../../lib/types";
import { Badge, Button, Panel, Progress } from "../ui";

export function DubCard({ project, episode, canEdit, jobs, onDub }: {
  project: Project; episode: Episode; canEdit: boolean; jobs: Job[]; onDub: (lang: string) => Promise<void> | void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const shots = (episode.shots ?? []).filter((s) => s.include);
  const withLines = shots.filter((s) => (s.dialogue?.[project.primary_language]?.length ?? 0) > 0);
  const targets = Object.keys(LANG_NAMES).filter((l) => l !== project.primary_language);

  const go = async (l: string) => {
    setBusy(l);
    try { await onDub(l); } finally { setBusy(null); }
  };

  return (
    <Panel eyebrow={t("Languages")} icon={<Languages />} title={t("Dub")}>
      <p className="mb-3 text-xs leading-relaxed text-mute">
        {t("Same video, new language: adapts the lines, speaks them in each character's voice, re-syncs the lips.")}
      </p>
      <ul className="space-y-2">
        {targets.map((l) => {
          const translated = withLines.filter((s) => (s.dialogue?.[l]?.length ?? 0) > 0).length;
          const total = withLines.length;
          const job = jobs.find((j) => j.payload?.language === l);
          const done = total > 0 && translated >= total;
          const working = !!job || busy === l;
          return (
            <li key={l} className="cx-block flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium leading-tight">{t(LANG_NAMES[l])}</span>
                  {working ? (
                    <Badge tone="accent"><Loader2 className="size-3 animate-spin" />{t("Dubbing…")}</Badge>
                  ) : done ? (
                    <Badge tone="ok"><Check className="size-3" strokeWidth={3} />{t("Ready")}</Badge>
                  ) : null}
                </div>
                {total > 0 ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    {job && job.progress > 0 ? <Progress value={job.progress} size="sm" className="flex-1" /> : <Progress value={translated / total} size="sm" tone={done ? "ok" : "accent"} className="flex-1" />}
                    <span className="mono shrink-0 text-2xs text-mute">{t("{a}/{b} shots translated", { a: translated, b: total })}</span>
                  </div>
                ) : <p className="mt-0.5 text-xs text-dim">{t("no dialogue")}</p>}
              </div>
              {canEdit && (
                <Button size="sm" className="max-sm:h-10" variant="outline" disabled={working} onClick={() => go(l)}>{translated ? t("Redo") : t("Dub")}</Button>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** [−] 3 [+] with clamping. */
function Stepper({ value, min, max, step = 1, onChange, label, suffix }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; suffix?: string;
}) {
  const t = useT();
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v))));
  return (
    <div role="group" aria-label={label} className="inline-flex h-9 items-center rounded-lg border border-line bg-raised max-sm:h-11">
      <button type="button" aria-label={t("Decrease")} disabled={value <= min} onClick={() => set(value - step)}
        className="grid h-full w-9 place-items-center rounded-l-lg text-mute transition-colors hover:bg-hover hover:text-ink disabled:opacity-40 max-sm:w-11"><Minus className="size-3.5" /></button>
      <span aria-live="polite" className="mono min-w-12 text-center text-sm font-medium">{value}{suffix}</span>
      <button type="button" aria-label={t("Increase")} disabled={value >= max} onClick={() => set(value + step)}
        className="grid h-full w-9 place-items-center rounded-r-lg text-mute transition-colors hover:bg-hover hover:text-ink disabled:opacity-40 max-sm:w-11"><Plus className="size-3.5" /></button>
    </div>
  );
}

export function CutdownCard({ onCreate }: { onCreate: (opts: { count: number; seconds: number }) => Promise<void> }) {
  const t = useT();
  const [cuts, setCuts] = useState({ count: 3, seconds: 30 });
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await onCreate(cuts); } finally { setBusy(false); }
  };
  return (
    <Panel eyebrow={t("Shorts")} icon={<Scissors />} title={t("Cut into shorts")} tone="ai">
      <p className="mb-3 text-xs leading-relaxed text-mute">
        {t("The Director picks the best shots for standalone shorts, reusing the takes you already paid for.")}
      </p>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div>
          <p className="eyebrow mb-1.5">{t("How many")}</p>
          <Stepper label={t("How many")} value={cuts.count} min={1} max={6} onChange={(count) => setCuts((c) => ({ ...c, count }))} />
        </div>
        <div>
          <p className="eyebrow mb-1.5">{t("Seconds each")}</p>
          <Stepper label={t("Seconds each")} value={cuts.seconds} min={10} max={90} step={5} suffix="s" onChange={(seconds) => setCuts((c) => ({ ...c, seconds }))} />
        </div>
        <Button className="ml-auto max-sm:h-10" variant="outline" loading={busy} icon={<Scissors className="size-4" />} onClick={go}>{t("Create cut-downs")}</Button>
      </div>
    </Panel>
  );
}
