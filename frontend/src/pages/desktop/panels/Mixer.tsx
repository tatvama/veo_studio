import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AudioLines, Check, Eye, EyeOff, Gauge, Layers as LayersIcon, Loader2, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Chip } from "../../../components/growth/common";
import { CAPTION_STYLES } from "../../../components/growth/RenderOptions";
import { Button, Panel } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useBus } from "../../../lib/bus";
import { useT } from "../../../lib/i18n";
import { useEpisode, useSettings } from "../../../lib/queries";
import { useProjectCtx } from "../../project/context";
import { Rng } from "../../project/production/instruments";
import { useLayersEditor, type LayerTrack } from "../../project/production/timeline/Layers";
import { MixCard } from "../../project/production/timeline/Panels";
import { useFollowMedia, useProgramTarget } from "./follow";

const dbToGain = (db: number) => Math.min(4, Math.pow(10, db / 20));

/**
 * A level meter of the program's sound: hidden copies of the current shot and the music, kept on the program's time over
 * the bus, feed an AnalyserNode that is not connected to the speakers (so nothing plays twice). Browsers only start audio
 * after a click, hence the button.
 */
function LevelMeter({ eid, lang, musicUrl, musicDb }: { eid: number; lang: string; musicUrl?: string; musicDb: number }) {
  const t = useT();
  const target = useProgramTarget(eid, lang);
  const vid = useRef<HTMLVideoElement>(null);
  const mus = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState("");
  const graph = useRef<{ ctx: AudioContext; l: AnalyserNode; r: AnalyserNode; music?: GainNode } | null>(null);
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const peaks = useRef<(HTMLDivElement | null)[]>([]);
  const readout = useRef<HTMLSpanElement>(null);
  useFollowMedia(vid, on ? target : null);

  // the music runs on the cut's clock (looped), like the timeline preview
  useBus("playhead", (m) => {
    const a = mus.current;
    if (!on || !a || !a.duration || !Number.isFinite(a.duration)) return;
    const want = m.t % a.duration;
    if (Math.abs(a.currentTime - want) > (m.playing ? 0.35 : 0.02)) a.currentTime = want;
    if (m.playing) void a.play().catch(() => undefined); else a.pause();
  }, { eid });
  useEffect(() => { if (graph.current?.music) graph.current.music.gain.value = dbToGain(musicDb) * 2.5; }, [musicDb]);

  const start = async () => {
    setErr("");
    try {
      if (!vid.current) return;
      const ctx = new AudioContext();
      const sum = ctx.createGain();
      sum.channelCount = 2; sum.channelCountMode = "explicit"; sum.channelInterpretation = "speakers";  // mono shots reach both bars
      ctx.createMediaElementSource(vid.current).connect(sum);
      let music: GainNode | undefined;
      if (mus.current && musicUrl) {
        music = ctx.createGain();
        music.gain.value = dbToGain(musicDb) * 2.5;
        ctx.createMediaElementSource(mus.current).connect(music).connect(sum);
      }
      const split = ctx.createChannelSplitter(2);
      const l = ctx.createAnalyser(), r = ctx.createAnalyser();
      l.fftSize = r.fftSize = 2048;
      sum.connect(split);
      split.connect(l, 0);
      split.connect(r, 1);
      await ctx.resume();
      graph.current = { ctx, l, r, music };
      setOn(true);
    } catch (e) {
      setErr(t("The meter can't start here: {e}", { e: e instanceof Error ? e.message : String(e) }));
    }
  };
  useEffect(() => () => { void graph.current?.ctx.close().catch(() => undefined); }, []);

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const buf = new Float32Array(2048);
    const hold = [-60, -60];
    const holdAt = [0, 0];
    const tick = () => {
      const g = graph.current;
      if (!g) return;
      const now = performance.now();
      const vals = [g.l, g.r].map((a, i) => {
        a.getFloatTimeDomainData(buf);
        let peak = 0, sum = 0;
        for (let k = 0; k < buf.length; k++) { const v = Math.abs(buf[k]); if (v > peak) peak = v; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const pdb = peak > 0 ? 20 * Math.log10(peak) : -90;
        const rdb = rms > 0 ? 20 * Math.log10(rms) : -90;
        if (pdb >= hold[i] || now - holdAt[i] > 1500) { hold[i] = pdb; holdAt[i] = now; }
        return { pdb, rdb };
      });
      const pos = (db: number) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
      vals.forEach((v, i) => {
        const b = bars.current[i];
        if (b) b.style.height = pos(v.rdb);
        const p = peaks.current[i];
        if (p) { p.style.bottom = pos(hold[i]); p.style.background = hold[i] > -1 ? "var(--color-bad)" : hold[i] > -9 ? "var(--color-warn)" : "var(--color-ok)"; }
      });
      if (readout.current) readout.current.textContent = `${Math.max(-60, Math.max(hold[0], hold[1])).toFixed(1)} dBFS`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on]);

  return (
    <Panel eyebrow={t("Level")} icon={<Gauge />} actions={on ? <span ref={readout} className="mono text-2xs tabular-nums text-mute" /> : undefined}>
      {!on ? (
        <div className="space-y-2">
          <Button size="sm" variant="outline" icon={<AudioLines className="size-3.5" />} onClick={() => void start()}>{t("Start the meter")}</Button>
          <p className="text-2xs leading-snug text-dim">{t("Follows the program's playhead: the current shot's sound plus the music, peak and RMS per channel.")}</p>
          {err && <p className="text-2xs text-bad">{err}</p>}
        </div>
      ) : (
        <div className="flex items-end gap-3">
          <div className="flex h-40 gap-2">
            {[0, 1].map((i) => (
              <div key={i} className="relative w-4 overflow-hidden rounded-sm bg-raised ring-1 ring-inset ring-line" aria-label={i ? t("Right") : t("Left")}>
                <div ref={(el) => { bars.current[i] = el; }} className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ok via-warn to-bad" style={{ height: 0 }} />
                <div ref={(el) => { peaks.current[i] = el; }} className="absolute inset-x-0 h-0.5" style={{ bottom: 0 }} />
              </div>
            ))}
          </div>
          <div className="mono flex h-40 flex-col justify-between text-2xs text-dim">{["0", "-12", "-24", "-36", "-48", "-60"].map((d) => <span key={d}>{d}</span>)}</div>
          <p className="max-w-[14rem] text-2xs leading-snug text-dim">{t("Renders are normalised to −14 LUFS, so peaks near 0 here are fine; red means clipping in a source.")}</p>
        </div>
      )}
      <video ref={vid} playsInline preload="auto" className="hidden" aria-hidden />
      {musicUrl && <audio ref={mus} src={musicUrl} loop preload="auto" className="hidden" />}
    </Panel>
  );
}

function TrackRow({ tk, kind, canEdit, onChange }: { tk: LayerTrack; kind: "video" | "audio"; canEdit: boolean; onChange: (patch: Partial<LayerTrack>) => void }) {
  const t = useT();
  return (
    <li className="flex items-center gap-2 py-1.5">
      <span className={clsx("grid size-6 shrink-0 place-items-center rounded-md border [&>svg]:size-3", kind === "video" ? "border-accent-2/30 bg-accent-2/10 text-accent-2" : "border-info/30 bg-info/10 text-info")}>
        {kind === "video" ? <LayersIcon /> : <AudioLines />}
      </span>
      <span className="mono w-24 shrink-0 truncate text-2xs uppercase tracking-wider text-mute" title={tk.name}>{tk.name}</span>
      {kind === "video" && (
        <button type="button" disabled={!canEdit} title={tk.hidden ? t("Show layer") : t("Hide layer")} onClick={() => onChange({ hidden: !tk.hidden })}
          className="grid size-6 place-items-center rounded text-dim hover:text-ink disabled:opacity-45">{tk.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}</button>
      )}
      <button type="button" disabled={!canEdit} title={tk.muted ? t("Unmute layer") : t("Mute layer")} onClick={() => onChange({ muted: !tk.muted })}
        className={clsx("grid size-6 place-items-center rounded hover:text-ink disabled:opacity-45", tk.muted ? "text-bad" : "text-dim")}>{tk.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}</button>
      <Rng min={-30} max={12} step={0.5} value={tk.gain_db ?? 0} disabled={!canEdit || tk.muted} aria-label={t("{name} volume", { name: tk.name })}
        onChange={(e) => onChange({ gain_db: Number(e.target.value) })} className="flex-1" />
      <span className="mono w-14 shrink-0 text-right text-2xs tabular-nums text-dim">{(tk.gain_db ?? 0) > 0 ? "+" : ""}{(tk.gain_db ?? 0).toFixed(1)} dB</span>
    </li>
  );
}

/** The episode's mix: music level and ducking, caption style, each layer's mute and gain, and a level meter. */
export default function MixerPanel() {
  const t = useT();
  const qc = useQueryClient();
  const { eid, lang, canEdit } = useProjectCtx();
  const { data: ep } = useEpisode(eid, lang);
  const { data: team } = useSettings();
  const { layers, edit, saving } = useLayersEditor(eid);
  const settings = (ep?.settings ?? {}) as Record<string, any>;
  const music = ep?.music?.find((m) => m.selected) ?? ep?.music?.[0];
  const [volDraft, setVolDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const patch = async (s: Record<string, unknown>, msg?: string) => {
    try {
      await api.patch(`/api/episodes/${eid}`, { settings: s });
      if (msg) toast.success(msg, { id: "mix" });
    } catch { /* toasted (a 423 says who has the cut) */ }
    await qc.invalidateQueries({ queryKey: ["episode", eid] });
  };
  const onVolume = (v: number) => {
    setVolDraft(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => { await patch({ music_volume_db: v }, t("Mix updated")); setVolDraft(null); }, 350);
  };
  const db = volDraft ?? Number(settings.music_volume_db ?? -16);
  const caption = (settings.caption_style as string | null | undefined) || "default";
  const teamCaption = String(team?.settings.caption_style ?? "karaoke");
  const setTrack = (kind: "video" | "audio", id: string) => (p: Partial<LayerTrack>) =>
    edit((d) => ({ ...d, [kind]: d[kind].map((x) => (x.id === id ? { ...x, ...p } : x)) }));
  const tracks = [...(layers?.video ?? []).map((tk) => ({ tk, kind: "video" as const })), ...(layers?.audio ?? []).map((tk) => ({ tk, kind: "audio" as const }))];

  return (
    <div className="@container h-full overflow-y-auto p-3">
      <div className="grid gap-3 @3xl:grid-cols-2">
        <div className="space-y-3">
          <MixCard lang={lang} db={db} duck={settings.duck !== false} canEdit={canEdit} onVolume={onVolume} onDuck={(v) => void patch({ duck: v }, t("Mix updated"))} />
          <Panel eyebrow={t("Captions")}>
            <div className={clsx("flex flex-wrap gap-1.5", !canEdit && "pointer-events-none opacity-60")} role="group" aria-label={t("Caption style")}>
              {[{ value: "default", label: t("Team default ({s})", { s: t(CAPTION_STYLES.find((c) => c.value === teamCaption)?.label ?? teamCaption) }) },
                ...CAPTION_STYLES.map((c) => ({ value: c.value, label: t(c.label) }))].map((o) => (
                <Chip key={o.value} active={caption === o.value} onClick={() => void patch({ caption_style: o.value === "default" ? null : o.value }, t("Caption style saved"))}
                  icon={caption === o.value ? <Check className="size-3" strokeWidth={3} /> : undefined}>{o.label}</Chip>
              ))}
            </div>
          </Panel>
        </div>
        <div className="space-y-3">
          <Panel eyebrow={t("Layers")} icon={<LayersIcon />} actions={saving ? <Loader2 className="size-3.5 animate-spin text-dim" /> : undefined}>
            {tracks.length ? (
              <ul className="divide-y divide-line/60">
                {tracks.map(({ tk, kind }) => <TrackRow key={tk.id} tk={tk} kind={kind} canEdit={canEdit} onChange={setTrack(kind, tk.id)} />)}
              </ul>
            ) : <p className="text-xs text-mute">{t("No layers on this episode. Add video or audio layers on the timeline.")}</p>}
          </Panel>
          <LevelMeter eid={eid} lang={lang} musicUrl={music?.url} musicDb={db} />
        </div>
      </div>
    </div>
  );
}
