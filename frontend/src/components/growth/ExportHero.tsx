/** The Export page's hero: the newest film playing, the three formats, captions on or off, Render with its price, Download. */
import { clsx } from "clsx";
import { Captions, Clapperboard, Download, Film, Wand2 } from "lucide-react";
import { useState } from "react";
import { useBatchEstimate } from "../../lib/estimates";
import { LANG_NAMES, LANG_SHORT, secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Episode, Job, Project } from "../../lib/types";
import { useGenerate } from "../Generate";
import { PriceSuffix } from "../kit/Price";
import { Button, Select, Toggle } from "../ui";
import { downloadUrl, SweepBar } from "./common";
import type { PresetInfo, RenderRow } from "./ExportCard";

/** The three formats people post in. Other presets (Shorts, the fast draft) are under Renders › New render. */
const FORMATS = [
  { key: "reels", label: "Reels", aspect: "9:16", w: 9, h: 16 },
  { key: "youtube", label: "YouTube", aspect: "16:9", w: 16, h: 9 },
  { key: "square", label: "Square", aspect: "1:1", w: 1, h: 1 },
] as const;

/** The format that matches the project's shape (a 9:16 film defaults to Reels). */
export const defaultFormat = (aspect: string) => (aspect === "16:9" ? "youtube" : aspect === "1:1" ? "square" : "reels");

function Glyph({ w, h, on }: { w: number; h: number; on: boolean }) {
  const s = 16 / Math.max(w, h);
  return <span aria-hidden className={clsx("inline-block rounded-[3px] border-[1.5px]", on ? "border-accent-ink bg-accent/20" : "border-mute/60")} style={{ width: Math.round(w * s), height: Math.round(h * s) }} />;
}

export function ExportHero({ project, episode, lang, canEdit, presets, newest, renderJobs, onRequested, onAllRenders }: {
  project: Project; episode: Episode; lang: string; canEdit: boolean; presets: Record<string, PresetInfo>;
  /** the newest finished render (final or preview) */ newest?: RenderRow;
  /** renders running now */ renderJobs: Job[];
  onRequested?: () => void; /** opens the Renders tab */ onAllRenders: () => void;
}) {
  const t = useT();
  const { generate } = useGenerate();
  const eid = episode.id;
  const [format, setFormat] = useState<string>(() => defaultFormat(project.aspect));
  const [captions, setCaptions] = useState(true);
  const [outLang, setOutLang] = useState(lang);
  const [starting, setStarting] = useState<"render" | "preview" | null>(null);
  const preset = presets[format] ? format : Object.keys(presets).find((k) => k === defaultFormat(project.aspect)) ?? format;
  const body = { action: "export", language: outLang, preset, captions, music: true, publish: false };
  const { data: est } = useBatchEstimate(eid, canEdit ? body : null, [(episode.shots ?? []).length]);
  const { data: previewEst } = useBatchEstimate(eid, canEdit ? { action: "animatic", language: outLang, captions, music: true } : null, [(episode.shots ?? []).length]);

  const go = async (kind: "render" | "preview") => {
    setStarting(kind);
    onRequested?.();
    try {
      if (kind === "render") await generate(eid, body, t("Render {format} [{lang}]", { format: t(FORMATS.find((f) => f.key === format)?.label ?? format), lang: LANG_SHORT[outLang] ?? outLang }));
      else await generate(eid, { action: "animatic", language: outLang, captions, music: true }, t("Quick preview [{lang}]", { lang: LANG_SHORT[outLang] ?? outLang }));
    } finally { setStarting(null); }
  };

  const ratio = newest && presets[newest.preset]?.w ? presets[newest.preset].w / presets[newest.preset].h : 9 / 16;
  const running = renderJobs[0];
  const what = newest ? `${newest.kind === "final" ? t("Final") : t("Preview")}${newest.version ? ` v${newest.version}` : ""} · ${t(presets[newest.preset]?.label ?? newest.preset)} · ${t(LANG_NAMES[newest.language] ?? newest.language)} · ${secs(newest.duration_s)}` : "";

  return (
    <section aria-label={t("Your film")} className="hud relative overflow-hidden rounded-xl border border-line bg-panel">
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-70" />
      <div className="grid gap-4 p-3 sm:p-4 @3xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] @3xl:gap-6">
        {/* the newest film */}
        <div className="min-w-0">
          <div className="grid place-items-center overflow-hidden rounded-lg border border-line bg-black">
            {newest ? (
              <video key={newest.id} src={newest.url} poster={newest.thumb_url || undefined} controls playsInline preload="metadata"
                className={clsx("block max-w-full bg-black", ratio < 1 ? "h-[min(52vh,30rem)] w-auto max-sm:h-[42vh]" : "max-h-[min(52vh,30rem)] w-full")} style={{ aspectRatio: String(ratio) }} />
            ) : (
              <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 p-6 text-center text-white/70">
                <Film aria-hidden className="size-7" />
                <p className="text-sm font-medium text-white/85">{t("No film yet")}</p>
                <p className="max-w-xs text-xs text-white/60">{t("Pick a format and press Render. Shots without a video use their picture.")}</p>
              </div>
            )}
          </div>
          {newest && <p className="mono mt-2 truncate text-2xs text-mute" title={what}>{what}</p>}
        </div>

        {/* make it */}
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{t("Your film")}</h2>
            <p className="mt-0.5 text-xs text-mute">{t("Pick where it goes, then render. Rendering runs on your server, so it is usually free.")}</p>
          </div>

          <div role="radiogroup" aria-label={t("Format")} className="grid grid-cols-3 gap-2">
            {FORMATS.map((f) => {
              const on = f.key === format;
              return (
                <button key={f.key} type="button" role="radio" aria-checked={on} onClick={() => setFormat(f.key)} disabled={!presets[f.key] && Object.keys(presets).length > 0}
                  className={clsx("flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-center transition-colors disabled:opacity-40",
                    on ? "border-accent/60 bg-accent/10 text-ink" : "border-line bg-raised/50 text-mute hover:border-dim/60 hover:text-ink")}>
                  <span className="flex items-center gap-1.5 text-sm font-medium"><Glyph w={f.w} h={f.h} on={on} />{t(f.label)}</span>
                  <span className="mono text-2xs text-dim">{f.aspect}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Toggle checked={captions} onChange={setCaptions} label={<span className="inline-flex items-center gap-1.5 text-sm"><Captions aria-hidden className="size-4 text-mute" />{t("Captions")}</span>} />
            {project.languages.length > 1 && (
              <Select value={outLang} onChange={(e) => setOutLang(e.target.value)} className="!h-9 w-auto text-sm max-sm:!h-10" aria-label={t("Language")}>
                {project.languages.map((l) => <option key={l} value={l}>{t(LANG_NAMES[l] ?? l)}</option>)}
              </Select>
            )}
          </div>

          {running && (
            <div role="status" className="space-y-1.5 rounded-lg border border-info/30 bg-info/8 p-2.5">
              <p className="flex items-center gap-2 text-xs text-sky-300"><span aria-hidden className="eq shrink-0"><i /><i /><i /><i /></span>
                <span className="min-w-0 flex-1 truncate">{running.message || running.label}</span><span className="mono">{Math.round((running.progress || 0) * 100)}%</span></p>
              <SweepBar value={running.progress || null} tone="info" label={t("Rendering")} />
            </div>
          )}

          {canEdit ? (
            <div className="mt-auto flex flex-wrap items-center gap-2">
              <Button variant="primary" className="min-h-10 px-5 max-sm:flex-1" icon={<Clapperboard className="size-4" />} loading={starting === "render"} disabled={!!starting}
                onClick={() => void go("render")}>
                {t("Render")}<PriceSuffix usd={est?.total_usd} />
              </Button>
              {newest && (
                <Button className="min-h-10 max-sm:flex-1" icon={<Download className="size-4" />} onClick={() => downloadUrl(newest.url)}>{t("Download")}</Button>
              )}
              <Button variant="ghost" className="min-h-10" icon={<Wand2 className="size-4" />} loading={starting === "preview"} disabled={!!starting} onClick={() => void go("preview")}
                title={t("A quick 720p preview to check timing")}>
                {t("Quick preview")}<PriceSuffix usd={previewEst?.total_usd} />
              </Button>
            </div>
          ) : newest ? (
            <div className="mt-auto"><Button className="min-h-10" icon={<Download className="size-4" />} onClick={() => downloadUrl(newest.url)}>{t("Download")}</Button></div>
          ) : (
            <p className="mt-auto text-xs text-mute">{t("Creators and above can start renders. You can still watch, review and download them.")}</p>
          )}
          {est && !est.budget.ok && <p className="text-xs text-warn">{est.budget.reason || t("This needs a producer's approval before it starts.")}</p>}
          <button type="button" onClick={onAllRenders} className="self-start text-xs font-medium text-accent-ink hover:underline max-sm:min-h-10">{t("More formats, look & sound, all renders")}</button>
        </div>
      </div>
    </section>
  );
}
