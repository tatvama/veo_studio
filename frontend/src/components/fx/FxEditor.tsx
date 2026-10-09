import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Blend, Check, ChevronDown, Clapperboard, Copy, FlipHorizontal2, FlipVertical2, Gauge, Loader2, Move, Palette, Play, RotateCcw,
  ScanEye, SlidersHorizontal, Sparkles, SunDim, Trash2, Upload, Vibrate, Wand2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";
import { useProjectCtx } from "../../pages/project/context";
import { api } from "../../lib/api";
import { useLockHolder } from "../../lib/collab";
import {
  ADJUST_INFO, APPROX_TRANSITIONS, MOVE_LABELS, fxFilter, fxTransform, isLut, moveKeyframes, transitionFrame,
  type AdjustKey, type FxCatalog, type MoveKind, type ShotFx,
} from "../../lib/fx";
import { tr, useT } from "../../lib/i18n";
import { useEpisode } from "../../lib/queries";
import type { Shot } from "../../lib/types";
import { Rng } from "../../pages/project/production/instruments";
import { Badge, Button, Menu, Segmented, Spinner, Toggle, Tooltip } from "../ui";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const useFxCatalog = () => useQuery({ queryKey: ["fx-catalog"], queryFn: () => api.get<FxCatalog>("/api/fx/catalog"), staleTime: Infinity });
const useLuts = (pid: number) => useQuery({ queryKey: ["luts", pid], queryFn: () => api.get<{ id: string; name: string }[]>(`/api/projects/${pid}/luts`) });

const mediaOf = (s?: Shot) => ({
  video: s?.lipsync?.url || s?.voicelock?.url || s?.video?.url || "",
  still: s?.keyframe?.url || s?.video?.thumb_url || "",
  thumb: s?.video?.thumb_url || s?.keyframe?.thumb_url || "",
});

/**
 * Transitions & effects for one shot: transition in from the previous shot, colour look (presets or your LUTs),
 * adjustments, speed / reverse / flip / camera moves / stabilise, fades. Changes save by themselves; the preview is
 * instant (CSS), "Exact preview" renders a few seconds with the export's own FFmpeg filters.
 */
export function FxEditor({ shotId }: { shotId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { project, eid, lang, canEdit } = useProjectCtx();
  const { data: ep } = useEpisode(eid, lang);
  const { data: cat } = useFxCatalog();
  const { data: luts } = useLuts(project.id);
  const order = useMemo(() => (ep?.shots ?? []).filter((s) => s.include).sort((a, b) => a.order - b.order), [ep]);
  const idx = order.findIndex((s) => s.id === shotId);
  const shot = order[idx];
  const prev = idx > 0 ? order[idx - 1] : undefined;
  const lock = useLockHolder(`shot:${shotId}`, shot ? `board:${shot.episode_id}` : null);
  const editable = canEdit && !lock;

  const [fx, setFx] = useState<ShotFx>({});
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const loadedFor = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const lutInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (shot && loadedFor.current !== shot.id) { setFx((shot as any).fx ?? {}); loadedFor.current = shot.id; setState("idle"); }
  }, [shot]);

  const change = (next: ShotFx) => {
    setFx(next);
    if (!editable) return;
    setState("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        await api.put(`/api/shots/${shotId}/fx`, { fx: next });
        setState("saved");
        qc.invalidateQueries({ queryKey: ["episode"] });
      } catch { setState("idle"); }
    }, 450);
  };
  const set = <K extends keyof ShotFx>(k: K, v: ShotFx[K]) => change({ ...fx, [k]: v });
  const setAdj = (k: AdjustKey, v: number) => change({ ...fx, adjust: { ...(fx.adjust ?? {}), [k]: v } });

  const applyAll = async (keys: string[], what: string) => {
    try {
      const r = await api.post<{ updated: number; skipped: string[] }>(`/api/episodes/${eid}/fx/apply`, { fx, keys });
      qc.invalidateQueries({ queryKey: ["episode"] });
      toast.success(tr("{what} applied to {n} shots", { what, n: r.updated }), {
        description: r.skipped.length ? tr("Skipped (someone is editing): {codes}", { codes: r.skipped.join(", ") }) : undefined,
      });
    } catch { /* api toasts */ }
  };

  const uploadLut = async (file: File) => {
    try {
      const r = await api.upload<{ id: string; name: string }>(`/api/projects/${project.id}/luts`, file);
      qc.invalidateQueries({ queryKey: ["luts", project.id] });
      set("look", `lut:${r.id}`);
      toast.success(tr("LUT “{name}” added", { name: r.name }));
    } catch { /* api toasts */ }
  };

  if (!shot || !cat) return <div className="grid h-full place-items-center"><Spinner /></div>;
  const m = mediaOf(shot);
  const active = Object.keys(fx).length;

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex shrink-0 items-center gap-2 border-b border-line bg-raised/30 px-3 py-2">
        <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-70" />
        <span className="grid size-6 place-items-center rounded-md border border-accent/30 bg-accent/10 text-accent-ink"><Sparkles className="size-3.5" /></span>
        <span className="mono text-sm font-semibold tracking-wide">{shot.code}</span>
        <span className="eyebrow">{t("Transitions & effects")}</span>
        {active > 0 && <Badge tone="accent">{t("{n} on", { n: active })}</Badge>}
        <div className="flex-1" />
        <span className="mono text-2xs text-dim">{state === "saving" ? t("Saving…") : state === "saved" ? t("Saved") : ""}</span>
        {editable && (
          <Menu width={240} items={[
            { icon: <Blend className="size-4" />, label: t("Use this transition on every shot"), disabled: !fx.transition, onClick: () => void applyAll(["transition"], t("Transition")) },
            { icon: <Palette className="size-4" />, label: t("Use this look on every shot"), onClick: () => void applyAll(["look", "adjust"], t("Look")) },
            { icon: <Copy className="size-4" />, label: t("Copy all these effects to every shot"), separator: true,
              onClick: () => void applyAll(["transition", "look", "adjust", "speed", "move", "fade_in", "fade_out", "flip_h", "flip_v", "reverse", "stabilize"], t("Effects")) },
            { icon: <RotateCcw className="size-4" />, label: t("Clear this shot's effects"), danger: true, separator: true, onClick: () => change({}) },
          ]} trigger={(p) => <Button {...p} size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />}>{t("Apply…")}</Button>} />
        )}
      </div>
      {lock && <p className="shrink-0 bg-warn/10 px-3 py-1.5 text-xs text-warn">{t("{name} is editing this shot — effects are read-only until they finish.", { name: lock.name })}</p>}

      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <FxPreview shot={shot} prev={prev} fx={fx} aspect={project.aspect} />

        <Section icon={<Blend />} title={t("Transition in")} summary={fx.transition ? `${label(cat, fx.transition.type)} · ${fx.transition.duration}s` : t("Cut")}>
          {!prev ? <p className="text-xs text-dim">{t("This is the first shot — nothing comes before it.")}</p> : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-mute">{t("Length")}</span>
                <Range min={0.1} max={2.5} step={0.05} value={fx.transition?.duration ?? 0.5} disabled={!editable || !fx.transition}
                  onChange={(v) => fx.transition && set("transition", { ...fx.transition, duration: v })} suffix="s" />
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1.5">
                <TransitionTile id="" label={t("Cut")} selected={!fx.transition} disabled={!editable} onPick={() => set("transition", undefined)} />
              </div>
              {cat.transitions.map((g) => (
                <div key={g.group}>
                  <p className="eyebrow mb-1.5">{t(g.group)}</p>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1.5">
                    {g.items.map((it) => (
                      <TransitionTile key={it.id} id={it.id} label={t(it.label)} selected={fx.transition?.type === it.id} disabled={!editable}
                        onPick={() => set("transition", { type: it.id, duration: fx.transition?.duration ?? 0.5 })} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section icon={<Palette />} title={t("Look")} summary={fx.look ? lookLabel(cat, luts, fx.look) : t("Natural")}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-1.5">
            {cat.looks.map((l) => (
              <LookTile key={l.id} label={t(l.label)} thumb={m.thumb} filter={fxFilter({ look: l.id })} disabled={!editable}
                selected={(fx.look ?? "none") === l.id} onPick={() => set("look", l.id === "none" ? undefined : l.id)} />
            ))}
            {(luts ?? []).map((l) => (
              <LookTile key={l.id} label={`LUT · ${l.name}`} thumb={m.thumb} filter="" lut disabled={!editable}
                selected={fx.look === `lut:${l.id}`} onPick={() => set("look", `lut:${l.id}`)}
                onRemove={editable ? async () => {
                  await api.del(`/api/projects/${project.id}/luts/${l.id}`).catch(() => undefined);
                  if (fx.look === `lut:${l.id}`) set("look", undefined);
                  qc.invalidateQueries({ queryKey: ["luts", project.id] });
                } : undefined} />
            ))}
            {editable && (
              <button type="button" onClick={() => lutInput.current?.click()}
                className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-2xs text-mute transition-colors hover:border-accent/50 hover:text-ink">
                <Upload className="size-4" />{t("Add .cube LUT")}
              </button>
            )}
            <input ref={lutInput} type="file" accept=".cube" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadLut(f); }} />
          </div>
          {isLut(fx.look) && <p className="mt-2 text-2xs text-dim">{t("LUTs show in the Exact preview and the export (the quick preview can't run them).")}</p>}
        </Section>

        <Section icon={<SlidersHorizontal />} title={t("Adjust")} summary={Object.keys(fx.adjust ?? {}).filter((k) => (fx.adjust as any)[k]).length ? t("{n} changed", { n: Object.keys(fx.adjust ?? {}).filter((k) => (fx.adjust as any)[k]).length }) : t("No changes")}>
          <div className="space-y-2">
            {cat.adjust.map((k) => (
              <div key={k} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-xs text-mute">{t(ADJUST_INFO[k].label)}</span>
                <Range min={ADJUST_INFO[k].min} max={1} step={0.01} value={fx.adjust?.[k] ?? 0} disabled={!editable} onChange={(v) => setAdj(k, v)} center={ADJUST_INFO[k].min < 0} />
              </div>
            ))}
            {editable && Object.keys(fx.adjust ?? {}).length > 0 && (
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => set("adjust", undefined)}>{t("Reset adjustments")}</Button>
            )}
          </div>
        </Section>

        <Section icon={<Move />} title={t("Motion & speed")} summary={[fx.speed && fx.speed !== 1 ? `${fx.speed}×` : "", fx.move ? t(MOVE_LABELS[fx.move.kind]) : "", fx.reverse ? t("reversed") : ""].filter(Boolean).join(" · ") || t("Normal")}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex w-20 shrink-0 items-center gap-1 text-xs text-mute"><Gauge className="size-3.5" />{t("Speed")}</span>
              <div className="flex flex-wrap gap-1">
                {SPEEDS.map((s) => (
                  <button key={s} type="button" disabled={!editable} onClick={() => set("speed", s === 1 ? undefined : s)}
                    className={clsx("mono rounded-md border px-2 py-0.5 text-xs tabular-nums transition-colors disabled:opacity-50",
                      (fx.speed ?? 1) === s ? "border-accent/60 bg-accent/12 font-semibold text-accent-ink shadow-[0_0_12px_-6px_var(--color-accent)]" : "border-line hover:bg-hover")}>{s}×</button>
                ))}
              </div>
            </div>
            {(fx.speed ?? 1) !== 1 && <p className="pl-[5.5rem] text-2xs text-dim">{t("The shot's sound (and lip-sync) follows the speed. The clip becomes {s}s.", { s: (shot.duration_s / (fx.speed ?? 1)).toFixed(1) })}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex w-20 shrink-0 items-center gap-1 text-xs text-mute"><Clapperboard className="size-3.5" />{t("Camera")}</span>
              <Segmented size="sm" value={fx.move?.kind ?? "none"} aria-label={t("Camera move")}
                onChange={(k: MoveKind) => editable && set("move", k === "none" ? undefined : { kind: k, amount: fx.move?.amount ?? 0.15 })}
                options={cat.moves.map((k) => ({ value: k, label: t(MOVE_LABELS[k]) }))} />
            </div>
            {fx.move && (
              <div className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-mute">{t("Strength")}</span>
                <Range min={0.02} max={0.5} step={0.01} value={fx.move.amount} disabled={!editable} onChange={(v) => set("move", { ...fx.move!, amount: v })} />
              </div>
            )}
            <div className="grid gap-2 @md:grid-cols-2">
              <ToggleRow icon={<RotateCcw />} label={t("Play backwards")} checked={!!fx.reverse} disabled={!editable} onChange={(v) => set("reverse", v || undefined)} />
              <ToggleRow icon={<Vibrate />} label={t("Stabilise (slower export)")} checked={!!fx.stabilize} disabled={!editable} onChange={(v) => set("stabilize", v || undefined)} />
              <ToggleRow icon={<FlipHorizontal2 />} label={t("Mirror")} checked={!!fx.flip_h} disabled={!editable} onChange={(v) => set("flip_h", v || undefined)} />
              <ToggleRow icon={<FlipVertical2 />} label={t("Upside down")} checked={!!fx.flip_v} disabled={!editable} onChange={(v) => set("flip_v", v || undefined)} />
            </div>
          </div>
        </Section>

        <Section icon={<SunDim />} title={t("Fades")} summary={[fx.fade_in ? t("in {s}s", { s: fx.fade_in }) : "", fx.fade_out ? t("out {s}s", { s: fx.fade_out }) : ""].filter(Boolean).join(" · ") || t("None")}>
          <div className="space-y-2">
            <div className="flex items-center gap-3"><span className="w-24 shrink-0 text-xs text-mute">{t("From black")}</span>
              <Range min={0} max={3} step={0.1} value={fx.fade_in ?? 0} disabled={!editable} onChange={(v) => set("fade_in", v || undefined)} suffix="s" /></div>
            <div className="flex items-center gap-3"><span className="w-24 shrink-0 text-xs text-mute">{t("To black")}</span>
              <Range min={0} max={3} step={0.1} value={fx.fade_out ?? 0} disabled={!editable} onChange={(v) => set("fade_out", v || undefined)} suffix="s" /></div>
          </div>
        </Section>
        <p className="px-4 py-3 text-2xs text-dim">{t("Titles & lower thirds (with animations) are added on the Timeline's Titles track.")}</p>
      </div>
    </div>
  );
}

const label = (cat: FxCatalog, id: string) => cat.transitions.flatMap((g) => g.items).find((x) => x.id === id)?.label ?? id;
const lookLabel = (cat: FxCatalog, luts: { id: string; name: string }[] | undefined, look: string) =>
  isLut(look) ? `LUT · ${luts?.find((l) => `lut:${l.id}` === look)?.name ?? "?"}` : cat.looks.find((l) => l.id === look)?.label ?? look;

function Section({ icon, title, summary, children }: { icon: ReactNode; title: string; summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-t border-line">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left outline-none transition-colors hover:bg-hover/40 focus-visible:bg-hover/40">
        <span className={clsx("grid size-6 shrink-0 place-items-center rounded-md border transition-colors [&>svg]:size-3.5",
          open ? "border-accent/30 bg-accent/10 text-accent-ink" : "border-line bg-raised text-mute")}>{icon}</span>
        <span className="eyebrow !text-ink">{title}</span>
        {summary && <span className="mono min-w-0 truncate text-2xs text-dim">{summary}</span>}
        <ChevronDown className={clsx("ml-auto size-4 text-dim transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

function Range({ min, max, step, value, onChange, disabled, suffix, center }: {
  min: number; max: number; step: number; value: number; onChange: (v: number) => void; disabled?: boolean; suffix?: string; center?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Rng min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => !disabled && onChange(center ? 0 : min)}
        className="flex-1" />
      <span className="mono w-12 shrink-0 text-right text-2xs tabular-nums text-mute">{suffix ? `${value.toFixed(1)}${suffix}` : (value > 0 && center ? "+" : "") + Math.round(value * 100)}</span>
    </div>
  );
}

function ToggleRow({ icon, label, checked, onChange, disabled }: { icon: ReactNode; label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-raised/30 px-2.5 py-1.5">
      <span className="text-dim [&>svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/** A transition tile that plays a tiny A→B demo of itself on hover. */
function TransitionTile({ id, label, selected, disabled, onPick }: { id: string; label: string; selected: boolean; disabled?: boolean; onPick: () => void }) {
  const [p, setP] = useState(0.35);
  const raf = useRef<number | null>(null);
  const play = () => {
    if (!id) return;
    const t0 = performance.now();
    const loop = (now: number) => { setP(((now - t0) / 1100) % 1.25 > 1 ? 1 : ((now - t0) / 1100) % 1.25); raf.current = requestAnimationFrame(loop); };
    raf.current = requestAnimationFrame(loop);
  };
  const stop = () => { if (raf.current) cancelAnimationFrame(raf.current); raf.current = null; setP(0.35); };
  useEffect(() => stop, []);
  const f = id ? transitionFrame(id, p) : { a: {}, b: { opacity: 0 }, bTop: true };
  const layer = (s: CSSProperties, bg: string, z: number): CSSProperties => ({ ...s, position: "absolute", inset: 0, background: bg, zIndex: z });
  return (
    <button type="button" disabled={disabled} onClick={onPick} onMouseEnter={play} onMouseLeave={stop} onFocus={play} onBlur={stop}
      className={clsx("group rounded-lg border p-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60",
        selected ? "border-accent/60 bg-accent/10 shadow-[0_0_14px_-8px_var(--color-accent)]" : "border-line hover:border-dim/60")}>
      <span className="relative block aspect-video overflow-hidden rounded-md" style={{ background: (f as any).bg ?? "rgb(0 0 0)" }}>
        <span style={layer(f.a, "linear-gradient(135deg, var(--color-ai), var(--color-accent-2))", f.bTop ? 1 : 2)} />
        <span style={layer(f.b, "linear-gradient(135deg, var(--color-accent), var(--color-info))", f.bTop ? 2 : 1)} />
        {selected && <Check className="absolute right-1 top-1 z-10 size-3.5 rounded-md bg-accent p-0.5 text-[var(--on-accent)]" strokeWidth={3} />}
      </span>
      <span className="mt-1 block truncate text-2xs font-medium">{label}</span>
    </button>
  );
}

function LookTile({ label, thumb, filter, selected, disabled, onPick, lut, onRemove }: {
  label: string; thumb: string; filter: string; selected: boolean; disabled?: boolean; onPick: () => void; lut?: boolean; onRemove?: () => void;
}) {
  return (
    <div className={clsx("group relative rounded-lg border p-1 transition-colors", selected ? "border-accent/60 bg-accent/10 shadow-[0_0_14px_-8px_var(--color-accent)]" : "border-line hover:border-dim/60")}>
      <button type="button" disabled={disabled} onClick={onPick} className="block w-full text-left disabled:opacity-60">
        <span className="relative block aspect-[4/3] overflow-hidden rounded-md bg-raised">
          {thumb ? <img src={thumb} alt="" className="size-full object-cover" style={{ filter }} draggable={false} />
            : <span className="block size-full bg-gradient-to-br from-accent via-info to-accent-2" style={{ filter }} />}
          {lut && <span className="mono absolute bottom-1 left-1 rounded bg-black/65 px-1 text-2xs font-semibold text-white">LUT</span>}
          {selected && <Check className="absolute right-1 top-1 size-3.5 rounded-md bg-accent p-0.5 text-[var(--on-accent)]" strokeWidth={3} />}
        </span>
        <span className="mt-1 block truncate text-2xs font-medium">{label}</span>
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="Remove LUT"
          className="absolute left-1.5 top-1.5 hidden size-5 place-items-center rounded bg-black/60 text-white group-hover:grid"><Trash2 className="size-3" /></button>
      )}
    </div>
  );
}

const GRAIN = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.9'/></svg>\")";

/** Instant preview: the shot with its look/adjustments/move/speed/fades, or the transition from the shot before; plus the exact render. */
function FxPreview({ shot, prev, fx, aspect }: { shot: Shot; prev?: Shot; fx: ShotFx; aspect: string }) {
  const t = useT();
  const [mode, setMode] = useState<"shot" | "transition" | "exact">("shot");
  const [exact, setExact] = useState<{ url: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState<number | null>(null);
  const mediaRef = useRef<HTMLElement | null>(null);
  const fadeRef = useRef<HTMLDivElement | null>(null);
  const prevVid = useRef<HTMLVideoElement | null>(null);
  const m = mediaOf(shot);
  const pm = mediaOf(prev);
  const ratio = aspect === "9:16" ? "9 / 16" : aspect === "1:1" ? "1 / 1" : "16 / 9";
  const key = JSON.stringify(fx);

  // camera move + fades follow the clip (loops with it)
  useEffect(() => {
    if (mode !== "shot") return;
    const el = mediaRef.current;
    const kf = moveKeyframes(fx);
    const dur = (shot.duration_s / (fx.speed ?? 1)) * 1000;
    const anims: Animation[] = [];
    if (el && kf) anims.push(el.animate(kf, { duration: dur, iterations: Infinity, easing: "linear" }));
    const fade = fadeRef.current;
    if (fade && (fx.fade_in || fx.fade_out)) {
      const a = (fx.fade_in ?? 0) * 1000 / dur, b = 1 - (fx.fade_out ?? 0) * 1000 / dur;
      anims.push(fade.animate([{ opacity: fx.fade_in ? 1 : 0, offset: 0 }, { opacity: 0, offset: Math.max(a, 0.001) },
        { opacity: 0, offset: Math.min(b, 0.999) }, { opacity: fx.fade_out ? 1 : 0, offset: 1 }], { duration: dur, iterations: Infinity }));
    }
    if (el instanceof HTMLVideoElement) { el.playbackRate = fx.speed ?? 1; el.currentTime = 0; void el.play().catch(() => undefined); }
    return () => anims.forEach((a) => a.cancel());
  }, [mode, key, m.video, m.still]);

  const playTransition = () => {
    if (!fx.transition || !prev) return;
    setMode("transition");
    const d = fx.transition.duration * 1000;
    const pv = prevVid.current;
    if (pv && pv.duration) { pv.currentTime = Math.max(pv.duration - fx.transition.duration - 0.8, 0); void pv.play().catch(() => undefined); }
    const t0 = performance.now() + 800;
    const loop = (now: number) => {
      const q = (now - t0) / d;
      setP(Math.max(0, Math.min(1, q)));
      if (q < 1.6) requestAnimationFrame(loop); else setP(null);
    };
    setP(0);
    requestAnimationFrame(loop);
  };

  const runExact = async () => {
    if (exact?.key === key) { setMode("exact"); return; }
    setBusy(true);
    try {
      const r = await api.post<{ url: string }>(`/api/shots/${shot.id}/fx/preview`, { fx });
      setExact({ url: r.url, key });
      setMode("exact");
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  const filter = fxFilter(fx, 0.5);
  const flip = fxTransform(fx);
  const a = fx.adjust ?? {};
  const tf = mode === "transition" && fx.transition && p != null ? transitionFrame(fx.transition.type, p) : null;

  return (
    <div className="space-y-2 p-3">
      <div className="scr mx-auto max-h-[46vh]" style={{ aspectRatio: ratio, maxWidth: aspect === "9:16" ? 260 : "100%" }}>
        {mode === "exact" && exact ? (
          <video key={exact.url} src={exact.url} className="size-full object-contain" autoPlay loop playsInline controls />
        ) : (
          <>
            {/* outgoing (previous shot) layer, only for the transition demo */}
            {mode === "transition" && prev && (
              <div className="absolute inset-0" style={{ ...(tf?.a ?? {}), zIndex: tf && !tf.bTop ? 2 : 1, background: tf?.bg }}>
                {pm.video ? <video ref={prevVid} src={pm.video} muted playsInline className="size-full object-cover" style={{ filter: fxFilter((prev as any).fx, 0.5), transform: fxTransform((prev as any).fx) }} />
                  : <img src={pm.still} alt="" className="size-full object-cover" />}
              </div>
            )}
            <div className="absolute inset-0 overflow-hidden" style={{ ...(tf?.b ?? {}), zIndex: tf && !tf.bTop ? 1 : 2, opacity: mode === "transition" && p === 0 ? 0 : (tf?.b as any)?.opacity }}>
              <div className="size-full" style={{ transform: flip || undefined }}>
                {m.video ? (
                  <video ref={(el) => { mediaRef.current = el; }} src={m.video} muted loop playsInline autoPlay className="size-full object-cover" style={{ filter }} />
                ) : m.still ? (
                  <img ref={(el) => { mediaRef.current = el; }} src={m.still} alt="" className="size-full object-cover" style={{ filter }} />
                ) : <div className="grid size-full place-items-center text-xs text-white/60">{t("No picture yet")}</div>}
              </div>
              {!!a.vignette && <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(ellipse at center, transparent ${55 - a.vignette * 25}%, rgba(0,0,0,${0.35 + a.vignette * 0.5}) 100%)` }} />}
              {!!a.grain && <div className="pointer-events-none absolute inset-0 mix-blend-overlay" style={{ backgroundImage: GRAIN, opacity: a.grain * 0.55 }} />}
              <div ref={fadeRef} className="pointer-events-none absolute inset-0 bg-black opacity-0" />
            </div>
          </>
        )}
        <span className="mono absolute left-3 top-3 z-10 rounded border border-white/15 bg-black/60 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider text-white">
          {mode === "exact" ? t("Exact — as exported") : mode === "transition" ? t("Transition preview") : t("Quick preview")}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button size="sm" variant={mode === "shot" ? "secondary" : "ghost"} icon={<Play className="size-3.5" />} onClick={() => setMode("shot")}>{t("Shot")}</Button>
        <Tooltip content={!prev ? t("First shot: no transition in") : !fx.transition ? t("Pick a transition below") : APPROX_TRANSITIONS.has(fx.transition.type) ? t("Approximate here — Exact preview shows the real one") : t("Plays the end of the previous shot into this one")}>
          <Button size="sm" variant={mode === "transition" ? "secondary" : "ghost"} icon={<Blend className="size-3.5" />} disabled={!prev || !fx.transition} onClick={playTransition}>{t("Transition")}</Button>
        </Tooltip>
        <Tooltip content={t("Renders a few seconds with the export's own filters (LUTs, reverse, stabilise included)")}>
          <Button size="sm" variant={mode === "exact" ? "primary" : "outline"} icon={busy ? <Loader2 className="size-3.5 animate-spin" /> : <ScanEye className="size-3.5" />} disabled={busy} onClick={() => void runExact()}>
            {busy ? t("Rendering…") : t("Exact preview")}
          </Button>
        </Tooltip>
      </div>
      {(fx.reverse || fx.stabilize || isLut(fx.look)) && mode !== "exact" && (
        <p className="text-center text-2xs text-dim">{t("Reverse, stabilise and LUTs appear in the Exact preview.")}</p>
      )}
    </div>
  );
}
