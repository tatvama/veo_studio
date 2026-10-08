/** Ads wizard: Brief (product, audience, tone, brand kit + locked facts) → Variants (languages × aspects × durations) → Review (plan + cost) → Run. */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Captions, Check, ChevronLeft, ChevronRight, Coins, Languages, Megaphone, Rocket, RotateCcw, Scissors, Timer } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LANG_NAMES, secs, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useBrandKits, useSettings } from "../../lib/queries";
import type { Episode, Project } from "../../lib/types";
import { useGenerate } from "../Generate";
import { Chip } from "../growth/common";
import { RField, SectionCard } from "../room/kit";
import { Alert, AnimatedNumber, Badge, Button, Input, Select, Skeleton, Textarea, Toggle } from "../ui";
import BrandFacts, { factsOf } from "./BrandFacts";
import { ASPECTS, DURATIONS, startCampaign, useCampaignEstimate, variantCount, type Aspect, type CampaignBody, type CampaignBrief } from "./types";

type Step = 0 | 1 | 2;
const TONES = ["Warm", "Bold", "Playful", "Devotional", "Premium", "Urgent"];

/** 1 Brief → 2 Variants → 3 Review: finished steps are clickable. */
function Stepper({ step, labels, onStep, maxReached }: { step: Step; labels: string[]; onStep: (s: Step) => void; maxReached: Step }) {
  const t = useT();
  return (
    <ol className="mb-5 flex items-center gap-2" aria-label={t("Steps")}>
      {labels.map((label, i) => {
        const on = i === step, done = i < step, reachable = i <= maxReached;
        return (
          <li key={label} className="flex min-w-0 items-center gap-2 last:flex-none [&:not(:last-child)]:flex-1">
            <button type="button" disabled={!reachable} onClick={() => onStep(i as Step)} aria-current={on ? "step" : undefined}
              className={clsx("inline-flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-sm font-medium transition-colors", on ? "text-ink" : reachable ? "text-mute hover:bg-hover hover:text-ink" : "text-dim")}>
              <span className={clsx("grid size-6 shrink-0 place-items-center rounded-full text-2xs font-semibold tabular-nums ring-1 ring-inset",
                on ? "bg-accent text-black ring-accent" : done ? "bg-ok/15 text-green-300 ring-ok/30" : "bg-raised text-mute ring-line")}>
                {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className="truncate">{label}</span>
            </button>
            {i < labels.length - 1 && <span aria-hidden className={clsx("h-px min-w-3 flex-1", done ? "bg-ok/40" : "bg-line")} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Portrait / landscape / square frame for the aspect chips. */
function Glyph({ aspect, active }: { aspect: Aspect; active: boolean }) {
  const [w, h] = aspect === "9:16" ? [9, 15] : aspect === "16:9" ? [16, 9] : [12, 12];
  return <span aria-hidden className={clsx("inline-block rounded-[2px] border-[1.5px]", active ? "border-accent-ink bg-accent/20" : "border-current")} style={{ width: w, height: h }} />;
}

function Group({ icon, title, hint, right, children }: { icon: ReactNode; title: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line p-3.5 @md:p-4">
      <div className="mb-2.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 basis-40">
          <p className="flex items-center gap-1.5 text-sm font-medium"><span className="text-accent-ink [&>svg]:size-4">{icon}</span>{title}</p>
          {hint && <p className="mt-0.5 text-2xs leading-snug text-dim">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
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
  const { data: est, isLoading: estLoading, isError: estError, refetch: refetchEst } = useCampaignEstimate(eid, body, step === 2 && canEdit);

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
    <SectionCard title={t("Ads campaign")} description={t("One brief, every language and aspect ratio, with the brand facts locked.")} icon={<Megaphone />} index={index}
      actions={<Badge tone="accent" className="hidden @sm:inline-flex">{summary}</Badge>}>
      <section ref={wizardRef} aria-label={t("Campaign wizard")} className="@container">
        <Stepper step={step} labels={steps} onStep={go} maxReached={maxReached} />
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
                      {TONES.map((tone) => <Chip key={tone} active={brief.tone === tone} onClick={() => setBrief({ ...brief, tone: brief.tone === tone ? "" : tone })}>{t(tone)}</Chip>)}
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
                <Group icon={<Languages />} title={t("Languages")} hint={t("Every language other than {lang} is dubbed first: adapted lines, each character's voice, lips re-synced.", { lang: langName(primary) })}
                  right={<Badge>{t("{n} picked", { n: langs.length })}</Badge>}>
                  <div className="flex flex-wrap gap-1.5">
                    {allLangs.map((l) => {
                      const on = langs.includes(l), isPrimary = l === primary;
                      return (
                        <Chip key={l} active={on} onClick={() => { if (!isPrimary) setLangs(toggle(langs, l)); }} title={isPrimary ? t("Primary language (always included)") : undefined}
                          icon={on ? <Check className="size-3" strokeWidth={3} /> : undefined}>
                          {langName(l)}{isPrimary && <span className="text-2xs text-dim">· {t("primary")}</span>}
                        </Chip>
                      );
                    })}
                  </div>
                </Group>
                <Group icon={<Megaphone />} title={t("Aspect ratios")} hint={t("Each is reframed automatically to keep faces in the frame.")} right={<Badge>{t("{n} picked", { n: aspects.length })}</Badge>}>
                  <div className="flex flex-wrap gap-1.5">
                    {ASPECTS.map((a) => (
                      <Chip key={a} active={aspects.includes(a)} onClick={() => setAspects(toggle(aspects, a))} icon={<Glyph aspect={a} active={aspects.includes(a)} />}>
                        {a} <span className="text-2xs text-dim">{a === "9:16" ? t("Shorts / Reels") : a === "16:9" ? t("YouTube") : t("Square")}</span>
                      </Chip>
                    ))}
                  </div>
                  {!aspects.length && <p className="mt-2 text-xs text-warn">{t("Pick at least one aspect ratio.")}</p>}
                </Group>
                <Group icon={<Timer />} title={t("Durations")} hint={t("The full length ({len}) is always made. Shorter lengths are cut by the Director from your shots and are approximate; lengths at or above the episode length are skipped.", { len: secs(fullLen) })}
                  right={<Badge>{t("+{n} cuts", { n: durations.length })}</Badge>}>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-accent/50 bg-accent/15 px-3 text-xs font-medium max-sm:h-9" title={t("Always made")}>
                      <Check className="size-3 text-accent-ink" strokeWidth={3} />{t("Full")} <span className="text-2xs text-dim">{secs(fullLen)}</span>
                    </span>
                    {DURATIONS.map((d) => {
                      const tooLong = fullLen > 0 && d >= fullLen * 0.9;
                      return (
                        <Chip key={d} active={durations.includes(d)} onClick={() => { if (!tooLong) setDurations(toggle(durations, d).sort((a, b) => a - b)); }}
                          title={tooLong ? t("Longer than the episode") : undefined} icon={durations.includes(d) ? <Scissors className="size-3" /> : undefined}>
                          <span className={clsx(tooLong && "line-through opacity-60")}>{d}s</span>
                        </Chip>
                      );
                    })}
                  </div>
                </Group>
                <Group icon={<Captions />} title={t("Options")}>
                  <div className="space-y-2.5 text-sm">
                    <Toggle checked={captions} onChange={setCaptions} label={t("Burn-in captions")} />
                    <p className="text-xs text-mute">{t("Music, auto-reframe and the brand end card are always on for ads.")}</p>
                  </div>
                </Group>
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(260px,38%)]">
                <div className="space-y-3">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <p className="text-2xs font-medium uppercase tracking-wide text-dim">{t("Plan")}</p>
                      <p className="mt-0.5 text-sm text-mute">{summary}</p>
                    </div>
                    <div className="text-2xl font-semibold leading-none tracking-tight tabular-nums">
                      {estLoading ? <Skeleton className="h-7 w-20" /> : est ? <AnimatedNumber value={est.total_usd} format={(n) => (n > 0 ? usd(n) : t("Free"))} duration={0.5} /> : "—"}
                    </div>
                  </div>
                  {estError ? (
                    <Alert tone="bad" title={t("Couldn't estimate this campaign")} action={<Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={() => refetchEst()}>{t("Retry")}</Button>}>
                      {t("Check the choices in the previous steps and try again.")}
                    </Alert>
                  ) : estLoading || !est ? (
                    <div className="space-y-2 rounded-xl border border-line p-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-4" />)}</div>
                  ) : (
                    <div className="max-h-72 overflow-y-auto rounded-xl border border-line">
                      <table className="w-full border-collapse text-sm">
                        <thead className="sticky top-0 z-[1] bg-raised text-2xs uppercase tracking-wide text-dim">
                          <tr><th scope="col" className="px-3 py-1.5 text-left font-medium">{t("Step")}</th><th scope="col" className="px-3 py-1.5 text-left font-medium">{t("Item")}</th><th scope="col" className="px-3 py-1.5 text-right font-medium">{t("Estimate")}</th></tr>
                        </thead>
                        <tbody>
                          {est.items.map((it, i) => (
                            <tr key={i} className="border-t border-line/60">
                              <td className="w-20 px-3 py-1.5"><Badge tone={it.kind === "dub" ? "info" : it.kind === "cutdown" ? "warn" : "neutral"}>{it.kind === "dub" ? t("Dub") : it.kind === "cutdown" ? t("Cut") : t("Export")}</Badge></td>
                              <td className="max-w-0 truncate px-3 py-1.5 text-mute" title={it.label}>{it.label}</td>
                              <td className={clsx("w-20 px-3 py-1.5 text-right tabular-nums", it.usd === 0 && "text-dim")}>{usd(it.usd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
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

        <footer className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {step > 0 && <Button variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => go((step - 1) as Step)}>{t("Back")}</Button>}
          <div className="flex-1" />
          <span className="text-xs text-mute @sm:hidden">{summary}</span>
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
