/** Ads wizard: Brief (product, audience, tone, brand kit + locked facts) → Variants (languages × aspects × durations) → Review (plan + cost) → Run. */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Captions, Check, ChevronLeft, ChevronRight, Coins, Languages, Megaphone, Rocket, RotateCcw, Scissors, ShieldAlert, Timer, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LANG_NAMES, LANG_SHORT, secs, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useBrandKits, useSettings } from "../../lib/queries";
import type { Episode, Project } from "../../lib/types";
import { useGenerate } from "../Generate";
import { RField, SectionCard } from "../room/kit";
import { Alert, Badge, Button, Input, Meter, Select, Skeleton, Textarea, Toggle } from "../ui";
import BrandFacts, { factsOf } from "./BrandFacts";
import { ASPECTS, ASPECT_LABEL, DURATIONS, startCampaign, useCampaignEstimate, variantCount, type Aspect, type CampaignBody, type CampaignBrief, type CampaignEstimate } from "./types";
import "../../styles/console.css";
import "../../styles/campaign.css";

type Step = 0 | 1 | 2;
const TONES = ["Warm", "Bold", "Playful", "Devotional", "Premium", "Urgent"];

/** Filter-chip style toggle used for tones, languages and cut lengths. */
function Pill({ on, onClick, children, title, icon, disabled }: { on: boolean; onClick: () => void; children: ReactNode; title?: string; icon?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className="cx-chip" aria-pressed={on} aria-disabled={disabled || undefined} title={title} onClick={onClick}>
      {icon}{children}
    </button>
  );
}

/** 01 Brief → 02 Variants → 03 Review: a step counter with a meter, then the steps themselves (finished steps are clickable). */
function Stepper({ step, labels, onStep, maxReached }: { step: Step; labels: string[]; onStep: (s: Step) => void; maxReached: Step }) {
  const t = useT();
  return (
    <div className="mb-4">
      <div className="mb-2.5 flex items-center gap-3">
        <span className="eyebrow">{t("Step")} <span className="mono text-ink">{step + 1}/{labels.length}</span></span>
        <Meter filled={step + 1} total={labels.length} className="w-28 max-w-[40%]" />
      </div>
      <ol className="cm-steps" aria-label={t("Steps")}>
        {labels.map((label, i) => {
          const on = i === step, done = i < step, reachable = i <= maxReached;
          return (
            <li key={label}>
              <button type="button" disabled={!reachable} onClick={() => onStep(i as Step)} aria-current={on ? "step" : undefined} data-state={on ? "on" : done ? "done" : "todo"}>
                <span className="cm-num">{done ? <Check className="size-3" strokeWidth={3} /> : String(i + 1).padStart(2, "0")}</span>
                <span className="cm-label min-w-0 truncate text-sm font-medium max-sm:text-xs">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Portrait / landscape / square frame for the aspect chips. */
function Glyph({ aspect, active }: { aspect: Aspect; active: boolean }) {
  const [w, h] = aspect === "9:16" ? [12, 20] : aspect === "16:9" ? [22, 12] : [16, 16];
  return <span aria-hidden className={clsx("inline-block rounded-[3px] border-[1.5px]", active ? "border-accent-ink bg-accent/25" : "border-mute")} style={{ width: w, height: h }} />;
}

/** A titled block of controls inside a step. */
function Group({ icon, title, hint, right, children, className }: { icon: ReactNode; title: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("cx-block p-3.5", className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 basis-40">
          <p className="eyebrow flex items-center gap-1.5 !text-ink"><span className="text-accent-ink [&>svg]:size-3.5">{icon}</span>{title}</p>
          {hint && <p className="mt-1.5 text-2xs leading-snug text-dim">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

/** Tiny language x aspect grid: one lit cell per variant the choices will render. */
function MiniMatrix({ langs, aspects }: { langs: string[]; aspects: Aspect[] }) {
  const rows = langs.slice(0, 6);
  if (!rows.length || !aspects.length) return null;
  return (
    <div aria-hidden className="grid items-center gap-x-3 gap-y-1.5" style={{ gridTemplateColumns: `auto repeat(${aspects.length}, 2.25rem)`, justifyContent: "start" }}>
      <span />
      {aspects.map((a) => <span key={a} className="mono text-center text-2xs text-dim">{a}</span>)}
      {rows.map((l) => (
        <div key={l} className="contents">
          <span className="mono text-2xs uppercase text-mute">{LANG_SHORT[l] ?? l.toUpperCase()}</span>
          {aspects.map((a) => (
            <span key={a} className="grid h-5 place-items-center">
              <span className={clsx("rounded-[2px] bg-accent/70", a === "9:16" ? "h-4 w-2.5" : a === "16:9" ? "h-2.5 w-4" : "size-3")} />
            </span>
          ))}
        </div>
      ))}
      {langs.length > rows.length && <span className="mono col-span-full text-2xs text-dim">+{langs.length - rows.length}</span>}
    </div>
  );
}

/** The summary rail: the plan and the running estimate stay in view on every step. */
function Summary({ count, langs, aspects, durations, captions, kitName, est, loading, error, stale, started }: {
  count: number; langs: string[]; aspects: Aspect[]; durations: number[]; captions: boolean; kitName: string; est: CampaignEstimate | undefined;
  loading: boolean; error: boolean; stale: boolean; started: boolean;
}) {
  const t = useT();
  const budget = est?.budget;
  return (
    <aside aria-label={t("Campaign summary")} className="space-y-3">
      <div className="cx-block p-3.5">
        <p className="eyebrow">{t("Plan")}</p>
        <p className="mono mt-2 flex items-baseline gap-1.5 text-[1.65rem] font-medium leading-none tracking-tight">
          {count}<span className="text-sm font-normal text-dim">{count === 1 ? t("variant") : t("variants")}</span>
        </p>
        <div className="mt-3"><MiniMatrix langs={langs} aspects={aspects} /></div>
        <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-xs">
          <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{t("Languages")}</dt><dd className="mono">{langs.length}</dd></div>
          <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{t("Aspect ratios")}</dt><dd className="mono">{aspects.length}</dd></div>
          <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{t("Cut lengths")}</dt><dd className="mono">{durations.length ? `+${durations.length}` : "0"}</dd></div>
          <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{t("Burn-in captions")}</dt><dd className="mono">{captions ? t("on") : t("off")}</dd></div>
          <div className="flex items-baseline justify-between gap-3"><dt className="shrink-0 text-mute">{t("Brand kit")}</dt><dd className="min-w-0 truncate text-right" title={kitName}>{kitName || t("No brand kit")}</dd></div>
        </dl>
      </div>

      <div className="cx-block p-3.5" data-tone="money">
        <p className="eyebrow !text-money">{t("Estimate")}</p>
        <div className="mono mt-2 text-[1.65rem] font-medium leading-none tracking-tight text-money" aria-live="polite">
          {error ? "—" : !started ? "—" : est ? <span className={clsx(loading && "opacity-50 transition-opacity")}>{est.total_usd > 0 ? usd(est.total_usd) : t("Free")}</span> : loading ? <Skeleton className="h-7 w-24" /> : "—"}
        </div>
        <p className="mt-2 text-2xs leading-snug text-dim">
          {!started ? t("The cost appears once you reach the variants step.")
            : error ? t("Couldn't estimate this campaign")
            : loading && stale ? t("Updating…")
            : t("Renders are free; dubs are priced with list prices and the ledger records actual cost per job.")}
        </p>
        {started && budget && !error && !loading && (
          <p className={clsx("mt-2 flex items-center gap-1.5 border-t border-line pt-2 text-xs font-medium", budget.ok ? "text-ok" : budget.needs_role ? "text-warn" : "text-bad")}>
            {budget.ok ? <Check className="size-3.5" /> : budget.needs_role ? <TriangleAlert className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
            {budget.ok ? t("Within your limits.") : budget.needs_role ? t("Needs approval") : t("Over your limit")}
          </p>
        )}
      </div>
    </aside>
  );
}

export default function AdsWizard({ project, episode, eid, canEdit, index, onStarted, wizardRef }: {
  project: Project; episode: Episode; eid: number; canEdit: boolean; index?: number; onStarted?: () => void; wizardRef?: React.Ref<HTMLElement>;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const { data: kits, isLoading: kitsLoading } = useBrandKits();
  const { data: settings } = useSettings();
  const ids = useId();

  const [step, setStep] = useState<Step>(0);
  const [maxReached, setMaxReached] = useState<Step>(0);
  const [brief, setBrief] = useState<CampaignBrief>(() => ({ product: project.brief?.product ?? project.brief?.key_message ?? "", audience: project.brief?.audience ?? "", tone: project.brief?.tone ?? "" }));
  const [kitId, setKitId] = useState<number | null>(project.brand_kit_id ?? null);
  const [kitTouched, setKitTouched] = useState(false);
  const [cta, setCta] = useState("");
  const [langs, setLangs] = useState<string[]>(() => Array.from(new Set([project.primary_language, ...project.languages])));
  const [aspects, setAspects] = useState<Aspect[]>(() => [ASPECTS.includes(project.aspect as Aspect) ? (project.aspect as Aspect) : "9:16"]);
  const [durations, setDurations] = useState<number[]>([]);
  const [captions, setCaptions] = useState(true);
  const [starting, setStarting] = useState(false);
  const lastEst = useRef<CampaignEstimate | undefined>(undefined);

  const kitList = kits ?? [];
  const effectiveKitId = kitTouched ? kitId : (kitId ?? kitList[0]?.id ?? null);
  const kit = kitList.find((k) => k.id === effectiveKitId) ?? null;
  const facts = factsOf(kit, cta);
  const primary = project.primary_language;
  const catalogLangs = Object.keys(settings?.catalog.languages ?? LANG_NAMES);
  const allLangs = Array.from(new Set([primary, ...project.languages, ...catalogLangs]));
  const langName = (l: string) => t(settings?.catalog.languages[l]?.name ?? LANG_NAMES[l] ?? l);
  const shots = (episode.shots ?? []).filter((s) => s.include);
  const fullLen = episode.total_duration_s ?? shots.reduce((a, s) => a + Math.max(s.extend_to || 0, s.duration_s || 0), 0);

  const body: CampaignBody = useMemo(() => ({
    languages: langs, aspects, durations, brand_kit_id: effectiveKitId, cta: cta.trim(), captions, publish: false, brief,
  }), [langs, aspects, durations, effectiveKitId, cta, captions, brief]);
  const count = variantCount(body);
  // The running estimate shows from the variants step on (the brief never changes the price); the review step needs it to run.
  const { data: est, isLoading: estLoading, isError: estError, refetch: refetchEst } = useCampaignEstimate(eid, body, step >= 1 && canEdit);
  if (est) lastEst.current = est;
  const shownEst = est ?? lastEst.current;

  const go = (s: Step) => { setStep(s); if (s > maxReached) setMaxReached(s); };
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const canNext = step === 0 ? true : step === 1 ? aspects.length > 0 && langs.length > 0 : true;

  const run = async () => {
    setStarting(true);
    try {
      const r = await submit(() => startCampaign(eid, body), t("Campaign"));
      if (r) {
        qc.invalidateQueries({ queryKey: ["campaign", eid] });
        qc.invalidateQueries({ queryKey: ["project", project.id] });
        onStarted?.();
      }
    } finally { setStarting(false); }
  };

  if (!canEdit) {
    return (
      <SectionCard title={t("Ads campaign")} icon={<Megaphone />} index={index}>
        <p className="text-sm text-mute">{t("Creators and above can run campaigns. You can still watch, download and publish the variants below.")}</p>
      </SectionCard>
    );
  }
  if (!shots.length) {
    return (
      <SectionCard title={t("Ads campaign")} icon={<Megaphone />} index={index}>
        <Alert tone="info" title={t("Nothing to turn into ads yet")}>{t("Build the shot list and produce the episode first; a campaign renders what you already made.")}</Alert>
      </SectionCard>
    );
  }

  const steps = [t("Brief"), t("Variants"), t("Review")];
  const summary = `${count === 1 ? t("1 variant") : t("{n} variants", { n: count })} · ${langs.length === 1 ? t("1 language") : t("{n} languages", { n: langs.length })} · ${aspects.join(" · ")}${durations.length ? ` · ${t("+{n} cut lengths", { n: durations.length })}` : ""}`;

  return (
    <SectionCard title={t("Ads campaign")} description={t("One brief, every language and aspect ratio, with the brand facts locked.")} icon={<Megaphone />} index={index}>
      <section ref={wizardRef} aria-label={t("Campaign wizard")} className="@container">
        <Stepper step={step} labels={steps} onStep={go} maxReached={maxReached} />
        <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_16.5rem]">
          <div className="@container min-w-0">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={step} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.18 }} className="space-y-4">
                {step === 0 && (
                  <div className="grid gap-4 @2xl:grid-cols-2">
                    <div className="space-y-4">
                      <RField label={t("Product or offer")} htmlFor={`${ids}-product`} hint={t("What the ad is for: the product, the show, the offer.")}>
                        <Textarea id={`${ids}-product`} value={brief.product} rows={3} onChange={(e) => setBrief({ ...brief, product: e.target.value })}
                          placeholder={t("e.g. Temple Tales season 1 — five short episodes about a lamp that moves at night")} />
                      </RField>
                      <RField label={t("Audience")} htmlFor={`${ids}-audience`}>
                        <Input id={`${ids}-audience`} value={brief.audience} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} placeholder={t("e.g. families in Karnataka, 25–45")} />
                      </RField>
                      <RField label={t("Tone")} htmlFor={`${ids}-tone`}>
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {TONES.map((tone) => <Pill key={tone} on={brief.tone === tone} onClick={() => setBrief({ ...brief, tone: brief.tone === tone ? "" : tone })}>{t(tone)}</Pill>)}
                        </div>
                        <Input id={`${ids}-tone`} value={brief.tone} onChange={(e) => setBrief({ ...brief, tone: e.target.value })} placeholder={t("or type your own")} />
                      </RField>
                    </div>
                    <div className="space-y-4">
                      <RField label={t("Brand kit")} htmlFor={`${ids}-kit`} right={<Link to="/brand-kits" className="text-2xs font-medium text-accent-ink hover:underline">{t("Manage brand kits")}</Link>}>
                        {kitsLoading ? <Skeleton className="h-9" /> : (
                          <Select id={`${ids}-kit`} value={effectiveKitId ?? ""} onChange={(e) => { setKitTouched(true); setKitId(e.target.value ? Number(e.target.value) : null); setCta(""); }}>
                            <option value="">{t("No brand kit")}</option>
                            {kitList.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                          </Select>
                        )}
                      </RField>
                      <BrandFacts facts={facts} cta={cta || facts?.cta || ""} onCta={setCta} />
                    </div>
                  </div>
                )}

                {step === 1 && (
                  <div className="grid gap-4 @2xl:grid-cols-2">
                    <Group className="@2xl:col-span-2" icon={<Languages />} title={t("Languages")} hint={t("Every language other than {lang} is dubbed first: adapted lines, each character's voice, lips re-synced.", { lang: langName(primary) })}
                      right={<Badge><span className="mono">{t("{n} picked", { n: langs.length })}</span></Badge>}>
                      <div className="flex flex-wrap gap-1.5">
                        {allLangs.map((l) => {
                          const on = langs.includes(l), isPrimary = l === primary;
                          return (
                            <Pill key={l} on={on} onClick={() => { if (!isPrimary) setLangs(toggle(langs, l)); }} disabled={isPrimary} title={isPrimary ? t("Primary language (always included)") : undefined}
                              icon={on ? <Check strokeWidth={3} /> : undefined}>
                              {langName(l)}{isPrimary && <span className="text-2xs text-dim">· {t("primary")}</span>}
                            </Pill>
                          );
                        })}
                      </div>
                    </Group>
                    <Group icon={<Megaphone />} title={t("Aspect ratios")} hint={t("Each is reframed automatically to keep faces in the frame.")} right={<Badge><span className="mono">{t("{n} picked", { n: aspects.length })}</span></Badge>}>
                      <div className="grid gap-2">
                        {ASPECTS.map((a) => {
                          const on = aspects.includes(a);
                          return (
                            <button key={a} type="button" aria-pressed={on} onClick={() => setAspects(toggle(aspects, a))}
                              className={clsx("flex min-h-12 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                                on ? "border-accent/45 bg-accent/10" : "border-line bg-raised hover:border-dim/50")}>
                              <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-panel"><Glyph aspect={a} active={on} /></span>
                              <span className="min-w-0">
                                <span className="mono block text-sm font-medium leading-tight">{a}</span>
                                <span className="block truncate text-2xs text-dim">{t(ASPECT_LABEL[a])}</span>
                              </span>
                              {on && <Check className="ml-auto size-3.5 shrink-0 text-accent-ink" strokeWidth={3} />}
                            </button>
                          );
                        })}
                      </div>
                      {!aspects.length && <p className="mt-2 text-xs text-warn">{t("Pick at least one aspect ratio.")}</p>}
                    </Group>
                    <Group icon={<Timer />} title={t("Durations")} hint={t("The full length ({len}) is always made. Shorter lengths are cut by the Director from your shots and are approximate; lengths at or above the episode length are skipped.", { len: secs(fullLen) })}
                      right={<Badge><span className="mono">{t("+{n} cuts", { n: durations.length })}</span></Badge>}>
                      <div className="flex flex-wrap gap-1.5">
                        <span className="cx-chip is-on" title={t("Always made")}>
                          <Check strokeWidth={3} />{t("Full")} <span className="cx-n">{secs(fullLen)}</span>
                        </span>
                        {DURATIONS.map((d) => {
                          const tooLong = fullLen > 0 && d >= fullLen * 0.9;
                          return (
                            <Pill key={d} on={durations.includes(d)} disabled={tooLong} onClick={() => { if (!tooLong) setDurations(toggle(durations, d).sort((a, b) => a - b)); }}
                              title={tooLong ? t("Longer than the episode") : undefined} icon={durations.includes(d) ? <Scissors /> : undefined}>
                              <span className={clsx("mono", tooLong && "line-through opacity-60")}>{d}s</span>
                            </Pill>
                          );
                        })}
                      </div>
                    </Group>
                    <Group className="@2xl:col-span-2" icon={<Captions />} title={t("Options")}>
                      <div className="space-y-2.5 text-sm">
                        <Toggle checked={captions} onChange={setCaptions} label={t("Burn-in captions")} />
                        <p className="text-xs text-mute">{t("Music, auto-reframe and the brand end card are always on for ads.")}</p>
                      </div>
                    </Group>
                  </div>
                )}

                {step === 2 && (
                  <div className="grid gap-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(15rem,38%)]">
                    <div className="min-w-0 space-y-3">
                      <div>
                        <p className="eyebrow">{t("Plan")}</p>
                        <p className="mono mt-1.5 text-xs text-mute">{summary}</p>
                      </div>
                      {estError ? (
                        <Alert tone="bad" title={t("Couldn't estimate this campaign")} action={<Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={() => refetchEst()}>{t("Retry")}</Button>}>
                          {t("Check the choices in the previous steps and try again.")}
                        </Alert>
                      ) : estLoading || !est ? (
                        <div className="space-y-2 rounded-lg border border-line p-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-4" />)}</div>
                      ) : (
                        <div className="overflow-hidden rounded-lg border border-line">
                          <div className="cx-scroll max-h-72">
                            <table className="cx-table is-dense">
                              <thead>
                                <tr><th scope="col">{t("Step")}</th><th scope="col">{t("Item")}</th><th scope="col" className="cx-r">{t("Estimate")}</th></tr>
                              </thead>
                              <tbody>
                                {est.items.map((it, i) => (
                                  <tr key={i}>
                                    <td className="cx-fit"><Badge tone={it.kind === "dub" ? "info" : it.kind === "cutdown" ? "warn" : "neutral"}>{it.kind === "dub" ? t("Dub") : it.kind === "cutdown" ? t("Cut") : t("Export")}</Badge></td>
                                    <td className="max-w-[22rem] truncate text-mute" title={it.label}>{it.label}</td>
                                    <td className={clsx("cx-r", it.usd === 0 ? "text-dim" : "text-money")}>{usd(it.usd)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div className="flex items-center justify-between gap-3 border-t border-line bg-raised/50 px-3 py-2 text-xs">
                            <span className="eyebrow">{t("Total")}</span>
                            <span className="mono text-sm font-medium text-money">{est.total_usd > 0 ? usd(est.total_usd) : t("Free")}</span>
                          </div>
                        </div>
                      )}
                      {est && est.skipped_durations.length > 0 && (
                        <p className="text-xs text-mute">{t("Skipped {list}: longer than the episode.", { list: est.skipped_durations.map((d) => `${d}s`).join(", ") })}</p>
                      )}
                      {est && (est.budget.ok
                        ? <p className="flex items-center gap-2 text-xs text-ok"><Check className="size-3.5" />{t("Within your limits.")}</p>
                        : est.budget.needs_role
                          ? <Alert tone="warn" title={t("Needs approval")}>{est.budget.reason} {t("A {role} will be asked to approve.", { role: est.budget.needs_role })}</Alert>
                          : <Alert tone="bad" title={t("Over your limit")}>{est.budget.reason}</Alert>)}
                      <p className="text-2xs text-dim">{t("Renders are free; dubs are priced with list prices and the ledger records actual cost per job.")}</p>
                    </div>
                    <BrandFacts facts={facts} cta={cta || facts?.cta || ""} compact />
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <Summary count={count} langs={langs} aspects={aspects} durations={durations} captions={captions} kitName={kit?.name ?? ""} est={shownEst}
            loading={estLoading} error={estError} stale={!!shownEst && !est} started={step >= 1 || !!shownEst} />
        </div>

        <footer className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {step > 0 && <Button variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => go((step - 1) as Step)}>{t("Back")}</Button>}
          <div className="flex-1" />
          <span className="mono min-w-0 text-2xs text-mute @3xl:hidden">{summary}</span>
          {step < 2 ? (
            <Button variant="primary" disabled={!canNext} iconRight={<ChevronRight className="size-4" />} onClick={() => go((step + 1) as Step)}>{t("Next")}</Button>
          ) : (
            <Button variant="primary" className="px-5" loading={starting} disabled={!est || estLoading || !!estError || (est && !est.budget.ok && !est.budget.needs_role)}
              icon={est && est.total_usd > 0 ? <Coins className="size-4" /> : <Rocket className="size-4" />} onClick={run}>
              {est && !est.budget.ok && est.budget.needs_role ? t("Request approval") : est && est.total_usd > 0 ? t("Run campaign · {usd}", { usd: usd(est.total_usd) }) : t("Run campaign")}
            </Button>
          )}
        </footer>
      </section>
    </SectionCard>
  );
}
