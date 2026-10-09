/** "New render" panel of the Export page: pick a format preset, language and options, then render. */
import { useQueries, useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Captions, Check, ChevronDown, Clapperboard, Languages, Music2, Send, SlidersHorizontal, Timer, Wand2, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import "../../styles/console.css";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT, secs, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Episode, Estimate, Job, Project } from "../../lib/types";
import { useGenerate } from "../Generate";
import { Alert, Button, Panel, Segmented, Select, Skeleton, Tag, Toggle, Tooltip } from "../ui";
import { SettingRow } from "./common";
import type { PresetInfo } from "./ExportCard";
import RenderOptions, { useRenderSummary } from "./RenderOptions";

/** A little frame in the shape of the output (portrait / square / landscape). */
function AspectGlyph({ ratio, active, fast }: { ratio: number; active: boolean; fast?: boolean }) {
  const portrait = ratio < 0.9, landscape = ratio > 1.2;
  const w = portrait ? Math.round(28 * ratio) : landscape ? 34 : 24;
  const h = portrait ? 28 : landscape ? Math.round(34 / ratio) : 24;
  return (
    <span className="grid size-10 shrink-0 place-items-center">
      <span className={clsx("grid place-items-center rounded-[4px] border-[1.5px] transition-colors", fast && "border-dashed",
        active ? "border-accent-ink bg-accent/15 text-accent-ink" : "border-mute/50 bg-raised text-dim")} style={{ width: w, height: h }}>
        {fast && <Zap className="size-3" />}
      </span>
    </span>
  );
}

const medianOf = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Typical render time per kind (from this project's recent finished render jobs) and what finished renders cost. */
export function useRenderHistory(pid: number) {
  return useQuery({
    queryKey: ["render-history", pid],
    queryFn: async () => {
      const rows = await api.get<Job[]>(`/api/jobs?status=succeeded&project_id=${pid}&limit=200`, { silent: true });
      const recent = rows.slice(0, 80);
      const secsOf = (type: string) => recent.filter((j) => j.type === type && j.started_at && j.finished_at)
        .map((j) => (new Date(j.finished_at!).getTime() - new Date(j.started_at!).getTime()) / 1000).filter((s) => s > 0 && s < 3600);
      return {
        export: medianOf(secsOf("export")),
        animatic: medianOf(secsOf("animatic")),
        renders: rows.filter((j) => j.type === "export" || j.type === "animatic").map((j) => ({ episode_id: j.episode_id, usd: j.cost_actual || 0 })),
      };
    },
    staleTime: 120_000,
  });
}

export default function NewRender({ project, episode, lang, canEdit, presets, webhook, onRequested }: {
  project: Project; episode: Episode; lang: string; canEdit: boolean; presets: Record<string, PresetInfo>; webhook: boolean;
  /** Called when the person presses Render / Animatic (before any cost dialog). */ onRequested?: () => void;
}) {
  const t = useT();
  const { generate } = useGenerate();
  const gid = useId();
  const eid = episode.id;
  const defaultPreset = project.aspect === "16:9" ? "youtube" : project.aspect === "1:1" ? "square" : "shorts";
  const [preset, setPreset] = useState(defaultPreset);
  const [outLang, setOutLang] = useState(lang);
  const [captions, setCaptions] = useState(true);
  const [music, setMusic] = useState(true);
  const [publish, setPublish] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const summary = useRenderSummary(episode, project);

  const entries = Object.entries(presets);
  const presetKey = presets[preset] ? preset : entries[0]?.[0] ?? preset;
  const info = presets[presetKey];
  const presetLabel = info?.label ?? presetKey;
  const body = { action: "export", language: outLang, preset: presetKey, captions, music, publish };

  // One estimate per preset, so every card can show its own price (the selected one drives the action bar).
  const estimates = useQueries({
    queries: entries.map(([k]) => {
      const b = { ...body, preset: k };
      return {
        queryKey: ["estimate", eid, b] as const,
        queryFn: () => api.post<Estimate>(`/api/episodes/${eid}/estimate`, b, { silent: true }),
        enabled: canEdit,
        staleTime: 30_000,
        retry: false,
      };
    }),
  });
  const estOf = (k: string) => estimates[entries.findIndex(([kk]) => kk === k)];
  const est = info ? estOf(presetKey)?.data : undefined;
  const estLoading = info ? estOf(presetKey)?.isLoading ?? false : false;
  const { data: times } = useRenderHistory(project.id);
  const typical = times?.export ?? null;

  // `generate` estimates first (and may open the cost dialog), so show progress on the button meanwhile.
  const [starting, setStarting] = useState<"render" | "animatic" | null>(null);
  const run = async (kind: "render" | "animatic", fn: () => Promise<void>) => {
    setStarting(kind);
    onRequested?.();
    try { await fn(); } finally { setStarting(null); }
  };
  const render = () => run("render", () => generate(eid, body, t("Export {preset} [{lang}]", { preset: t(presetLabel), lang: LANG_SHORT[outLang] })));
  const animatic = () => run("animatic", () => generate(eid, { action: "animatic", language: outLang, captions, music }, t("Animatic [{lang}]", { lang: LANG_SHORT[outLang] })));

  const stripAspect = (s: string) => s.replace(/\s*\d{1,2}:\d{1,2}\s*$/, "");
  const langs = project.languages;
  const price = (e: { data?: Estimate; isLoading: boolean } | undefined) =>
    e?.isLoading ? <Skeleton className="h-3.5 w-10" /> : e?.data && e.data.total_usd > 0 ? `~${usd(e.data.total_usd)}` : t("Free");

  return (
    <Panel index={1} eyebrow={t("Compose")} icon={<Clapperboard />} title={t("New render")} tone="accent">
      <div className="@container">
        <p className="mb-4 text-xs leading-relaxed text-mute">
          {t("Rendering runs on your server (FFmpeg) — free. Shots without video use their keyframe; warnings list anything missing.")}
        </p>

        {/* format presets */}
        <div role="radiogroup" aria-label={t("Format")} className="grid gap-2.5 @md:grid-cols-2 @3xl:grid-cols-3">
          {!entries.length && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[88px] rounded-xl" />)}
          {entries.map(([k, p], i) => {
            const sel = k === presetKey;
            const ratio = p.w && p.h ? p.w / p.h : 9 / 16;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => setPreset(k)}
                className={clsx("group relative flex min-w-0 flex-col gap-2.5 rounded-xl border p-3 text-left transition-[background-color,border-color,transform] duration-150 active:scale-[0.99]",
                  sel ? "border-transparent bg-accent/[0.07]" : "border-line bg-raised/40 hover:border-dim/50 hover:bg-hover/50")}
              >
                {sel && <motion.span layoutId={`${gid}-ring`} transition={{ type: "spring", stiffness: 520, damping: 40 }} className="pointer-events-none absolute inset-0 rounded-xl border-2 border-accent/70" />}
                <span className="relative flex items-center gap-2.5">
                  <AspectGlyph ratio={ratio} active={sel} fast={!p.aspect} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium leading-tight">{stripAspect(t(p.label))}</span>
                    <span className="mono mt-0.5 block truncate text-2xs text-dim">{p.aspect ?? t("fast preview")}</span>
                  </span>
                  <span className={clsx("grid size-5 shrink-0 place-items-center rounded-full transition-all", sel ? "scale-100 bg-accent text-black opacity-100" : "scale-75 opacity-0")}>
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                </span>
                <span className="relative flex flex-wrap items-center gap-1.5">
                  {p.aspect ? <Tag>{p.aspect}</Tag> : <Tag tone="info">{t("fast")}</Tag>}
                  {p.w ? <Tag>{p.w}×{p.h}</Tag> : null}
                  {canEdit && <span className="mono ml-auto text-xs font-medium text-money" aria-label={t("Estimated cost")}>{price(estOf(k))}</span>}
                </span>
              </button>
            );
          })}
        </div>

        {/* output options: one control grid */}
        <div className="mt-3 grid gap-2.5 @md:grid-cols-2">
          <div className="cx-block">
            <SettingRow icon={<Languages className="size-4" />} label={t("Language")}>
              {langs.length > 3 ? (
                <Select value={outLang} onChange={(e) => setOutLang(e.target.value)} className="!h-8 w-36 text-xs max-sm:!h-10" aria-label={t("Language")}>
                  {langs.map((l) => <option key={l} value={l}>{t(LANG_NAMES[l])}</option>)}
                </Select>
              ) : (
                <Segmented value={outLang} onChange={setOutLang} aria-label={t("Language")}
                  options={langs.map((l) => ({ value: l, label: t(LANG_NAMES[l] ?? l) }))} />
              )}
            </SettingRow>
          </div>
          <div className="cx-block">
            <SettingRow icon={<Captions className="size-4" />} label={t("Burn-in captions")}>
              <Toggle checked={captions} onChange={setCaptions} label={<span className="sr-only">{t("Burn-in captions")}</span>} />
            </SettingRow>
          </div>
          <div className="cx-block">
            <SettingRow icon={<Music2 className="size-4" />} label={t("Music")}>
              <Toggle checked={music} onChange={setMusic} label={<span className="sr-only">{t("Music")}</span>} />
            </SettingRow>
          </div>
          <div className="cx-block">
            <SettingRow icon={<Send className="size-4" />} label={t("Send to Make.com")}
              hint={webhook ? undefined : <Link to="/settings" className="font-medium text-accent-ink hover:underline">{t("Set a Make.com webhook in Settings")}</Link>}>
              <Toggle checked={publish} onChange={setPublish} disabled={!webhook} label={<span className="sr-only">{t("Send to Make.com")}</span>} />
            </SettingRow>
          </div>
        </div>

        {/* look & sound */}
        <div className="cx-block mt-2.5 overflow-hidden">
          <button type="button" aria-expanded={optionsOpen} aria-controls={`${gid}-opts`} onClick={() => setOptionsOpen((o) => !o)}
            className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-hover/50">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-raised text-mute"><SlidersHorizontal className="size-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium leading-tight">{t("Look & sound")} <span className="text-xs font-normal text-dim">· {t("saved for this episode")}</span></span>
              <span className="mono mt-1 block truncate text-2xs text-mute">{summary.join(" · ")}</span>
            </span>
            <ChevronDown className={clsx("size-4 shrink-0 text-dim transition-transform duration-200", optionsOpen && "rotate-180")} />
          </button>
          <AnimatePresence initial={false}>
            {optionsOpen && (
              <motion.div id={`${gid}-opts`} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                <div className="border-t border-line p-3"><RenderOptions project={project} episode={episode} canEdit={canEdit} /></div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* go */}
        {canEdit ? (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-4">
            <div className="min-w-0 basis-full @md:flex-1 @md:basis-44">
              <p className="eyebrow">{t("Estimated cost")}</p>
              <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="mono text-xl font-medium leading-none text-money">
                  {estLoading ? <Skeleton className="h-5 w-16" /> : est && est.total_usd > 0 ? `~${usd(est.total_usd)}` : t("Free")}
                </span>
                {typical ? (
                  <span className="mono inline-flex items-center gap-1 text-2xs text-dim" title={t("Based on your previous renders of this project")}>
                    <Timer className="size-3" />{t("about {time}", { time: secs(typical) })}
                  </span>
                ) : null}
              </p>
              <p className="mono mt-1 truncate text-2xs text-dim">{stripAspect(t(presetLabel))} · {t(LANG_NAMES[outLang] ?? outLang)}{info?.w ? ` · ${info.w}×${info.h}` : ""}</p>
            </div>
            <Tooltip content={t("A quick 720p preview to check timing")}>
              <Button icon={<Wand2 className="size-4" />} loading={starting === "animatic"} disabled={!!starting} onClick={animatic} className="max-sm:h-10 max-sm:flex-1 @md:flex-none">{t("Animatic")}</Button>
            </Tooltip>
            <Button variant="primary" className="px-5 max-sm:h-10 max-sm:flex-1 @md:flex-none" icon={<Clapperboard className="size-4" />} loading={starting === "render"} disabled={!!starting} onClick={render}>{t("Render")}</Button>
            {est && !est.budget.ok && (
              <Alert tone="warn" className="w-full">{est.budget.reason || t("This needs a producer's approval before it starts.")}</Alert>
            )}
          </div>
        ) : (
          <p className="mt-4 border-t border-line pt-4 text-xs text-mute">{t("Creators and above can start renders. You can still watch, review and download them.")}</p>
        )}
      </div>
    </Panel>
  );
}
