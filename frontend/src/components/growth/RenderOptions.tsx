/** Per-episode render look & sound (stored in episode.settings / project.brand_kit_id — the export job reads them). */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AudioLines, Check, Crop, Palette, Volume2, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useBrandKits, useSettings } from "../../lib/queries";
import type { Episode, Project, SubmitResult } from "../../lib/types";
import { useGenerate } from "../Generate";
import { Badge, Button, Progress, Select, Toggle } from "../ui";
import { CardHeader, Chip, CostConfirm, providerLive, SettingRow, useActiveJobs } from "./common";

export const CAPTION_STYLES: { value: string; label: string; desc: string }[] = [
  { value: "karaoke", label: "Karaoke", desc: "Words light up as they are spoken" },
  { value: "clean", label: "Clean", desc: "Plain white text with a soft outline" },
  { value: "boxed", label: "Boxed", desc: "Text on a dark box — easiest to read" },
  { value: "none", label: "None", desc: "No burned-in captions (SRT file still made)" },
];

/** Shorthand for the effective caption style / music level — shown as a summary when the options are collapsed. */
export function useRenderSummary(episode: Episode, project: Project) {
  const t = useT();
  const { data: settings } = useSettings();
  const { data: kits } = useBrandKits();
  const es = (episode.settings ?? {}) as Record<string, any>;
  const teamCaption = String(settings?.settings.caption_style ?? "karaoke");
  const style = (es.caption_style as string | null | undefined) || teamCaption;
  const kit = (kits ?? []).find((k) => k.id === project.brand_kit_id);
  const styleLabel = t(CAPTION_STYLES.find((c) => c.value === style)?.label ?? style);
  return [
    t("{s} captions", { s: styleLabel }),
    t("Music {n} dB", { n: Number(es.music_volume_db ?? -16) }),
    kit ? kit.name : t("No brand kit"),
  ];
}

function FieldLabel({ icon, children, right }: { icon?: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-mute">
      {icon}<span>{children}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

export default function RenderOptions({ project, episode, canEdit }: { project: Project; episode: Episode; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: kits } = useBrandKits();
  const eid = episode.id;
  const es = (episode.settings ?? {}) as Record<string, any>;
  const teamCaption = String(settings?.settings.caption_style ?? "karaoke");
  const teamReframe = settings?.settings.auto_reframe !== false;
  const autoReframe = es.auto_reframe === undefined || es.auto_reframe === null ? teamReframe : es.auto_reframe !== false;
  const sfxOn = es.sfx !== false;
  const caption = (es.caption_style as string | null | undefined) || "default";
  const [volume, setVolume] = useState<number>(Number(es.music_volume_db ?? -16));
  const [saving, setSaving] = useState<string | null>(null);
  const shots = (episode.shots ?? []).filter((s) => s.include);
  const withSfx = shots.filter((s) => s.sfx_track?.path).length;
  const kit = (kits ?? []).find((k) => k.id === project.brand_kit_id);

  const saveEpisode = async (key: string, patch: Record<string, unknown>, msg: string) => {
    setSaving(key);
    try {
      await api.patch(`/api/episodes/${eid}`, { settings: patch });
      await qc.invalidateQueries({ queryKey: ["episode", eid] });
      toast.success(msg);
    } catch {
      /* toasted by api */
    } finally {
      setSaving(null);
    }
  };

  // Music level: save shortly after the slider stops moving.
  const serverVolume = Number(es.music_volume_db ?? -16);
  useEffect(() => setVolume(serverVolume), [serverVolume]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onVolume = (v: number) => {
    setVolume(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => saveEpisode("volume", { music_volume_db: v }, t("Music level set to {n} dB", { n: v })), 700);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setKit = async (id: number | null) => {
    setSaving("kit");
    try {
      await api.patch(`/api/projects/${project.id}`, { brand_kit_id: id });
      await qc.invalidateQueries({ queryKey: ["project", project.id] });
      toast.success(id ? t("Brand kit applied to this project") : t("Brand kit removed from this project"));
    } catch {
      /* toasted */
    } finally {
      setSaving(null);
    }
  };

  const captionLabel = (v: string) => t(CAPTION_STYLES.find((c) => c.value === v)?.label ?? v);
  const effective = caption === "default" ? teamCaption : caption;
  const pickCaption = (v: string) => saveEpisode("caption", { caption_style: v === "default" ? null : v },
    t("Caption style: {s}", { s: v === "default" ? t("team default") : captionLabel(v) }));
  const captionOptions = [{ value: "default", label: t("Default ({s})", { s: captionLabel(teamCaption) }), desc: t("Use the team setting") },
    ...CAPTION_STYLES.map((c) => ({ value: c.value, label: t(c.label), desc: t(c.desc) }))];

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel>{t("Caption style")}</FieldLabel>
        <div role="group" aria-label={t("Caption style")} className={clsx("flex flex-wrap gap-1.5 transition-opacity", (!canEdit || saving === "caption") && "pointer-events-none opacity-60")}>
          {captionOptions.map((o) => (
            <Chip key={o.value} active={caption === o.value} onClick={() => pickCaption(o.value)} title={o.desc}
              icon={caption === o.value ? <Check className="size-3" strokeWidth={3} /> : undefined}>{o.label}</Chip>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-mute">{t(CAPTION_STYLES.find((c) => c.value === effective)?.desc ?? "")}</p>
      </div>

      <div>
        <FieldLabel icon={<Palette className="size-3.5" />}>{t("Brand kit")}</FieldLabel>
        <div className="flex items-center gap-2.5">
          <Select className="min-w-0 flex-1" value={project.brand_kit_id ?? ""} disabled={!canEdit || saving === "kit"} aria-label={t("Brand kit")}
            onChange={(e) => setKit(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t("No brand kit")}</option>
            {(kits ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </Select>
          {kit?.colors?.length ? (
            <span className="flex shrink-0 -space-x-1.5">
              {kit.colors.slice(0, 4).map((c, i) => (
                <span key={i} className="size-5 rounded-full border-2 border-panel shadow-sm" style={{ background: c }} title={c} />
              ))}
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 text-xs text-mute">
          {kit ? (kit.end_card?.enabled ? t("Adds a {n}s branded end card to final renders.", { n: kit.end_card.seconds ?? 3 })
            : t("This kit's end card is off.")) : t("Pick a kit to add a branded end card.")}{" "}
          <Link to="/brand-kits" className="font-medium text-accent-ink underline-offset-2 hover:underline">{t("Edit kits")}</Link>
        </p>
      </div>

      <div>
        <FieldLabel icon={<Volume2 className="size-3.5" />} right={<span className="font-mono text-xs tabular-nums text-ink">{volume} dB</span>}>{t("Music level")}</FieldLabel>
        <input type="range" min={-30} max={-6} step={1} value={volume} disabled={!canEdit} className="w-full accent-accent"
          onChange={(e) => onVolume(Number(e.target.value))} aria-label={t("Music level")} />
        <div className="mt-2">
          <Toggle checked={es.duck !== false} disabled={!canEdit || saving === "duck"}
            onChange={(v) => saveEpisode("duck", { duck: v }, v ? t("Music ducks under dialogue") : t("Music ducking off"))}
            label={<span className="text-sm text-mute">{t("Lower music under dialogue")}</span>} />
        </div>
      </div>

      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-raised/30">
        <SettingRow icon={<Crop className="size-4" />} label={t("Auto-reframe")}
          hint={<>{t("Clips shot in another shape are cropped around the main face for 9:16, 1:1 or 16:9.")}{" "}
            {es.auto_reframe === undefined || es.auto_reframe === null
              ? <Link to="/settings#delivery" className="font-medium text-accent-ink underline-offset-2 hover:underline">{t("Team setting")}</Link>
              : <button type="button" className="font-medium text-accent-ink underline-offset-2 hover:underline disabled:opacity-50" disabled={!canEdit}
                  onClick={() => saveEpisode("reframe", { auto_reframe: null }, t("Using the team setting"))}>{t("Use team setting")}</button>}</>}>
          <Toggle checked={autoReframe} disabled={!canEdit || saving === "reframe"} label={<span className="sr-only">{t("Auto-reframe")}</span>}
            onChange={(v) => saveEpisode("reframe", { auto_reframe: v }, v ? t("Auto-reframe on for this episode") : t("Auto-reframe off for this episode"))} />
        </SettingRow>
        <SettingRow icon={<AudioLines className="size-4" />}
          label={<span className="flex items-center gap-2">{t("Sound effects")}<Badge tone={withSfx ? "ok" : "neutral"}>{t("{n}/{m} shots", { n: withSfx, m: shots.length })}</Badge></span>}
          hint={t("Mixed into renders when switched on. Loudness is normalised to −14 LUFS.")}>
          <Toggle checked={sfxOn} disabled={!canEdit || saving === "sfx"} label={<span className="sr-only">{t("Sound effects")}</span>}
            onChange={(v) => saveEpisode("sfx", { sfx: v }, v ? t("Sound effects included in renders") : t("Sound effects left out of renders"))} />
        </SettingRow>
      </div>
    </div>
  );
}

/** Generate ambience and spot effects for every shot (own card on the Export page). */
export function SoundDesignCard({ project, episode, canEdit }: { project: Project; episode: Episode; canEdit: boolean }) {
  const t = useT();
  const { submit } = useGenerate();
  const { data: settings } = useSettings();
  const eid = episode.id;
  const [open, setOpen] = useState(false);
  const shots = (episode.shots ?? []).filter((s) => s.include);
  const withSfx = shots.filter((s) => s.sfx_track?.path).length;
  const cost = providerLive(settings, "elevenlabs") ? 0.012 * shots.length : 0;
  const running = useActiveJobs((j) => j.type === "sfx" && j.episode_id === eid, project.id);
  const pct = shots.length ? withSfx / shots.length : 0;

  return (
    <div className="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <CardHeader icon={<AudioLines className="size-4" />} title={t("Sound design")}
        sub={t("Ambience and spot effects for every shot, mixed into your renders.")} className="!mb-3" />
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-mute">{t("{n}/{m} shots", { n: withSfx, m: shots.length })}</span>
          <span className="font-mono tabular-nums text-dim">{Math.round(pct * 100)}%</span>
        </div>
        <Progress value={pct} tone={pct >= 1 ? "ok" : "accent"} />
      </div>
      {canEdit ? (
        <Button variant="outline" block icon={<Wand2 className="size-4" />} loading={running.length > 0} disabled={!shots.length} onClick={() => setOpen(true)}>
          {withSfx ? t("Redo sound design") : t("Design sound effects")}
        </Button>
      ) : null}
      {canEdit && (
        <CostConfirm open={open} onClose={() => setOpen(false)} title={t("Sound design")} amount={cost}
          lines={[{ label: t("Ambience and spot effects for {n} shots", { n: shots.length }), usd: cost }]}
          note={t("Plans effects per shot, then generates them with ElevenLabs. Replaces existing effects.")}
          onConfirm={() => submit(() => api.post<SubmitResult>(`/api/episodes/${eid}/sfx`, {}), t("Sound design"))} />
      )}
    </div>
  );
}
