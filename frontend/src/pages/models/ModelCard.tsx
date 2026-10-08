import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AlertTriangle, AudioLines, Boxes, CalendarDays, Film, Fingerprint, Image as ImageIcon, Images, MessageSquareText, Mic, Music, Play, Speech,
  Star, Trophy, UserRound, Volume2, Wand2, XCircle, Zap,
} from "lucide-react";
import { memo, useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";
import { MODE_LABELS, STATUS_LABELS, TASK_LABELS, TIER_LABELS, dateText, durationsText, isVideoUrl } from "../../components/hub/util";
import { Badge, Toggle, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import type { AIModel } from "../../lib/types";
import { patchModelInCache, providerLabel, refreshAfterModelChange } from "./catalogData";

export type ModelPatchBody = Partial<Pick<AIModel, "status" | "tier" | "rating" | "notes" | "price_usd" | "price_unit" | "param_overrides">>;

export const modelPath = (id: string) => `/api/models/${id.split("/").map(encodeURIComponent).join("/")}`;

/** PATCH /api/models/{id} (admin) — updates every cached list immediately, then refreshes counts (not every loaded page). */
export function useModelPatch() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  // stable identities, so memoised cards don't re-render when something unrelated changes
  const patch = useCallback(async (m: AIModel, body: ModelPatchBody, success?: string): Promise<AIModel | undefined> => {
    setBusy(m.id);
    try {
      const res = await api.patch<AIModel>(modelPath(m.id), body);
      patchModelInCache(qc, res);
      refreshAfterModelChange(qc);
      if (success) toast.success(success);
      return res;
    } catch {
      return undefined; // api() already showed the error
    } finally {
      setBusy(null);
    }
  }, [qc]);
  const setEnabled = useCallback((m: AIModel, on: boolean) =>
    patch(m, { status: on ? "enabled" : "disabled" }, on ? tr("{name} enabled", { name: m.display_name }) : tr("{name} disabled", { name: m.display_name })), [patch]);
  return { patch, setEnabled, busy };
}

export const TASK_ICON: Record<string, typeof Film> = {
  video: Film, avatar: UserRound, lipsync: Speech, edit: Wand2, image: ImageIcon, tts: AudioLines, music: Music, train: Zap, other: Boxes,
};

/** "maker · family", leaving out a family that the name already starts with. */
export function modelSubtitle(m: Pick<AIModel, "display_name" | "maker" | "family" | "endpoint">): string {
  const name = (m.display_name || "").toLowerCase();
  const fam = m.family && !name.startsWith(m.family.toLowerCase()) ? m.family : "";
  return [m.maker, fam].filter(Boolean).join(" · ") || m.endpoint;
}

/** Base hue of the generated thumbnail per task, so the grid reads at a glance even without real previews. */
const TASK_HUE: Record<string, number> = { video: 45, avatar: 350, lipsync: 305, edit: 200, image: 255, tts: 150, music: 95, train: 275, other: 230 };

function hueFor(m: Pick<AIModel, "task" | "family" | "maker" | "id">): number {
  const base = TASK_HUE[m.task] ?? 230;
  const s = m.family || m.maker || m.id;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (base + (Math.abs(h) % 41) - 20 + 360) % 360;
}

/* ── small badges ───────────────────────────────────────────────────────────── */

/** Status chip. Own markup (not <Badge>) so it stays legible on top of thumbnails in both themes. */
export function StatusBadge({ status }: { status: AIModel["status"] }) {
  const t = useT();
  const base = "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-none";
  if (status === "new") {
    return (
      <span className="relative inline-flex">
        <span aria-hidden className="anim-glow absolute -inset-0.5 rounded-md bg-accent/60 blur-[6px]" />
        <span className={clsx(base, "relative border-accent bg-accent font-semibold tracking-wide text-black")}>{t("NEW")}</span>
      </span>
    );
  }
  const tone = {
    enabled: "border-ok/40 bg-panel/90 text-green-300", disabled: "border-line bg-panel/90 text-mute", retired: "border-bad/40 bg-panel/90 text-red-300",
  }[status] ?? "border-line bg-panel/90 text-mute";
  return (
    <span className={clsx(base, "backdrop-blur-sm", tone)}>
      {status === "enabled" && <span className="size-1.5 rounded-full bg-ok" />}
      {t(STATUS_LABELS[status] ?? status)}
    </span>
  );
}

function providerDot(m: Pick<AIModel, "provider_mode">) {
  return m.provider_mode === "live" ? "bg-ok" : m.provider_mode === "mock" ? "bg-warn" : "bg-bad";
}
function providerState(m: Pick<AIModel, "provider_mode">, t: (s: string) => string) {
  return m.provider_mode === "live" ? t("live") : m.provider_mode === "mock" ? t("mock mode") : t("no API key");
}

export function ProviderBadge({ m, className }: { m: AIModel; className?: string }) {
  const t = useT();
  return (
    <Badge title={`${providerLabel(m.provider)} · ${providerState(m, t)}`} className={className}>
      <span className={clsx("size-1.5 rounded-full", providerDot(m))} />{providerLabel(m.provider)}
    </Badge>
  );
}

/** Chip that sits on top of a thumbnail (always light-on-dark). */
export function OverlayChip({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/55 px-1.5 py-0.5 text-2xs font-medium leading-none text-white backdrop-blur-sm", className)}>
      {children}
    </span>
  );
}

export function ModeChips({ modes, max = 6, className }: { modes?: string[]; max?: number; className?: string }) {
  const t = useT();
  const list = modes ?? [];
  if (!list.length) return null;
  return (
    <span className={clsx("inline-flex flex-wrap items-center gap-1", className)}>
      {list.slice(0, max).map((x) => (
        <span key={x} title={t(MODE_LABELS[x] ?? x)} className="rounded border border-line bg-raised px-1 py-px font-mono text-2xs leading-4 text-mute">{x}</span>
      ))}
      {list.length > max && <span className="text-2xs text-dim" title={list.slice(max).map((x) => t(MODE_LABELS[x] ?? x)).join(", ")}>+{list.length - max}</span>}
    </span>
  );
}

export function CapIcons({ m }: { m: AIModel }) {
  const t = useT();
  const c = m.capabilities ?? {};
  const dur = durationsText(c.durations);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-mute">
      {c.native_audio && <span className="inline-flex items-center gap-0.5 text-green-300" title={t("Generates its own sound")}><Volume2 className="size-3.5" />{t("audio")}</span>}
      {c.speech_in_video && <span className="inline-flex items-center gap-0.5" title={t("Speaks the line itself: voice and lips in one pass (Google route)")}><MessageSquareText className="size-3.5" />{t("speaks")}</span>}
      {c.audio_driven && <span className="inline-flex items-center gap-0.5" title={t("Animates the face from a voice track you give it")}><Mic className="size-3.5" />{t("audio-driven")}</span>}
      {c.lora_input && <span className="inline-flex items-center gap-0.5" title={t("Accepts a trained identity (LoRA) for a locked face")}><Fingerprint className="size-3.5" />{t("identity")}</span>}
      {c.lipsync_to_audio && <span className="inline-flex items-center gap-0.5" title={t("Re-syncs the lips of an existing clip to given audio")}><Speech className="size-3.5" />{t("lip-sync")}</span>}
      {(c.max_refs ?? 0) > 0 && <span className="inline-flex items-center gap-0.5" title={t("Up to {n} reference images", { n: c.max_refs ?? 0 })}><Images className="size-3.5" />{c.max_refs}</span>}
      {dur && <span title={t("Clip lengths")}>{dur}</span>}
      {!!c.resolutions?.length && <span title={t("Resolutions")}>{c.resolutions.join(" · ")}</span>}
      {c.usable === false && <span className="inline-flex items-center gap-0.5 text-red-300" title={t("Input schema could not be mapped — this engine can't be used yet")}><XCircle className="size-3.5" />{t("unusable")}</span>}
    </span>
  );
}

export function PriceText({ m, className, compact }: { m: AIModel; className?: string; compact?: boolean }) {
  const t = useT();
  const est = m.est_8s_usd;
  return (
    <span className={clsx("inline-flex min-w-0 items-baseline gap-1.5", className)} title={`${m.price_label}${m.price_source ? ` · ${t(m.price_source)}` : ""}`}>
      <span className={clsx("shrink-0 font-semibold tabular-nums", est != null || m.price_usd != null ? "text-ink" : "text-dim")}>{est != null ? usd(est) : m.price_label}</span>
      {est != null && <span className="truncate text-2xs text-dim">{t("per 8s")}{!compact && m.price_label ? ` · ${m.price_label}` : ""}</span>}
    </span>
  );
}

export function Stats({ m }: { m: AIModel }) {
  const t = useT();
  const total = (m.uses || 0) + (m.failures || 0);
  const failPct = total ? Math.round(((m.failures || 0) / total) * 100) : 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-mute">
      <span className="inline-flex items-center gap-0.5" title={t("Team rating")}><Star className={clsx("size-3", m.rating ? "fill-accent-2 text-accent-2" : "")} />{m.rating != null ? m.rating.toFixed(1) : "—"}</span>
      <span className="inline-flex items-center gap-0.5" title={t("Shootout wins")}><Trophy className="size-3" />{m.wins || 0}</span>
      <span title={t("Successful generations")}>{t("{n} uses", { n: m.uses || 0 })}</span>
      {(m.failures || 0) > 0 && <span className={clsx(failPct >= 20 ? "text-red-300" : "text-amber-300")} title={t("Failed generations")}>{t("{n} failed", { n: m.failures })} ({failPct}%)</span>}
    </span>
  );
}

/* ── thumbnail ──────────────────────────────────────────────────────────────── */

/**
 * 16:9 preview. Real images load lazily and fade in; everything else (most of the catalog has none) gets a generated
 * backdrop tinted by task, so cards never look broken. Video previews only mount while hovered.
 */
export function ModelThumb({ m, className, iconClass = "size-8", eager, aspect = "aspect-video", iconAt = "center" }: {
  m: AIModel; className?: string; iconClass?: string; eager?: boolean; aspect?: string; iconAt?: "center" | "right";
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState(false);
  const Icon = TASK_ICON[m.task] ?? Boxes;
  const src = m.thumbnail_url;
  const isVideo = !!src && isVideoUrl(src);
  const hue = hueFor(m);
  const back: CSSProperties = {
    background: `radial-gradient(120% 100% at 15% 0%, color-mix(in oklab, oklch(0.72 0.15 ${hue}) 30%, transparent), transparent 62%), linear-gradient(140deg, color-mix(in oklab, oklch(0.6 0.12 ${hue}) 18%, var(--color-raised)), var(--color-raised))`,
  };
  const dots: CSSProperties = {
    backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--color-ink) 9%, transparent) 1px, transparent 0)",
    backgroundSize: "14px 14px",
  };
  const showImg = !!src && !isVideo && !failed;
  return (
    <div className={clsx("relative overflow-hidden bg-raised", aspect, className)} style={back}
      onPointerEnter={isVideo ? () => setHover(true) : undefined} onPointerLeave={isVideo ? () => setHover(false) : undefined}>
      {!(showImg && loaded) && (
        <>
          <div aria-hidden className="absolute inset-0 opacity-70" style={dots} />
          <Icon aria-hidden className={clsx("absolute", iconAt === "right" ? "right-8 top-6" : "inset-0 m-auto", iconClass)}
            style={{ color: `color-mix(in oklab, oklch(0.7 0.15 ${hue}) 78%, var(--color-ink))`, opacity: 0.8 }} />
        </>
      )}
      {showImg && (
        <img src={src} alt="" loading={eager ? "eager" : "lazy"} decoding="async" draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
          className={clsx("absolute inset-0 size-full object-cover transition-[opacity,transform] duration-300 group-hover:scale-[1.04]", loaded ? "opacity-100" : "opacity-0")} />
      )}
      {isVideo && !failed && (
        <>
          {hover && <video src={src} muted loop autoPlay playsInline preload="auto" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />}
          {!hover && <span aria-hidden className="absolute right-2 bottom-2 grid size-6 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm"><Play className="size-3 fill-current" /></span>}
        </>
      )}
    </div>
  );
}

/* ── enable toggle ──────────────────────────────────────────────────────────── */

export function EnableToggle({ m, admin, busy, onToggle }: { m: AIModel; admin: boolean; busy: boolean; onToggle: (on: boolean) => void }) {
  const t = useT();
  if (m.status === "retired") return <span className="text-2xs text-dim">{t("Retired")}</span>;
  return (
    <span title={admin ? undefined : t("Only admins can switch engines on or off")} className="inline-flex">
      <Toggle checked={m.status === "enabled"} disabled={!admin || busy} onChange={onToggle}
        label={<span className="sr-only">{t("Enable {name}", { name: m.display_name || m.endpoint })}</span>} />
    </span>
  );
}

/* ── card (grid view) ───────────────────────────────────────────────────────── */

export const ModelCard = memo(function ModelCard({ m, admin, busy, onToggle, onOpen, index }: {
  m: AIModel; admin: boolean; busy: boolean; onToggle: (m: AIModel, on: boolean) => void; onOpen: (m: AIModel) => void; index?: number;
}) {
  const t = useT();
  const TaskIcon = TASK_ICON[m.task] ?? Boxes;
  const name = m.display_name || m.endpoint;
  const caps = m.capabilities ?? {};
  const hasCaps = !!(caps.modes?.length || caps.native_audio || (caps.max_refs ?? 0) > 0 || caps.durations || caps.resolutions?.length || caps.usable === false);
  // only the first screenful animates in; later pages just appear
  const r = index !== undefined && index < 12 ? rise(index) : null;
  return (
    <article
      className={clsx(
        "group lift relative flex flex-col overflow-hidden rounded-xl border bg-panel [contain-intrinsic-size:auto_318px] [content-visibility:auto]",
        m.status === "new" ? "border-accent/45 hover:border-accent/70" : m.status === "enabled" ? "border-ok/25 hover:border-ok/50" : "border-line hover:border-dim/60",
        r?.className,
      )}
      style={r?.style}
    >
      <button type="button" onClick={() => onOpen(m)} aria-label={t("Open {name}", { name })}
        className="absolute inset-0 z-[1] rounded-xl outline-offset-[-2px]" />
      <div className="relative">
        <ModelThumb m={m} />
        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-1">
          <StatusBadge status={m.status} />
          <div className="flex flex-wrap justify-end gap-1">
            {m.builtin && <OverlayChip title={t("Built-in engine (direct API)")}>{t("built-in")}</OverlayChip>}
            {m.tier && <OverlayChip>{t(TIER_LABELS[m.tier] ?? m.tier)}</OverlayChip>}
          </div>
        </div>
        <div className="pointer-events-none absolute bottom-2 left-2">
          <OverlayChip title={`${providerLabel(m.provider)} · ${providerState(m, t)}`}>
            <span className={clsx("size-1.5 rounded-full", providerDot(m))} />{providerLabel(m.provider)}
          </OverlayChip>
        </div>
      </div>

      <div className="pointer-events-none flex flex-1 flex-col gap-2.5 p-3">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug" title={name}>{name}</h3>
          <p className="mt-0.5 truncate text-xs text-mute" title={m.id}>{modelSubtitle(m)}</p>
        </div>

        <div className="flex min-h-[22px] flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-2xs font-medium text-mute"><TaskIcon className="size-3" />{t(TASK_LABELS[m.task] ?? m.task)}</span>
          {hasCaps ? (
            <>
              <ModeChips modes={caps.modes} max={3} />
              <CapIcons m={m} />
            </>
          ) : <span className="text-2xs text-dim">{t("Details not mapped yet")}</span>}
        </div>

        {m.unmapped_required?.length > 0 && (
          <p className="flex items-center gap-1 text-2xs text-amber-300" title={m.unmapped_required.join(", ")}>
            <AlertTriangle className="size-3 shrink-0" /><span className="truncate">{t("Needs mapping: {fields}", { fields: m.unmapped_required.slice(0, 3).join(", ") })}</span>
          </p>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-2.5">
          <div className="min-w-0">
            <PriceText m={m} compact className="text-sm" />
            <div className="mt-0.5 flex items-center gap-2">
              {m.uses || m.wins || m.rating != null || m.failures ? <Stats m={m} /> : <span className="text-2xs text-dim">{t("No usage yet")}</span>}
              {m.released_at && <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-dim" title={t("Released")}><CalendarDays className="size-3" />{dateText(m.released_at)}</span>}
            </div>
          </div>
          <div className="pointer-events-auto relative z-[2] shrink-0"><EnableToggle m={m} admin={admin} busy={busy} onToggle={(on) => onToggle(m, on)} /></div>
        </div>
      </div>
    </article>
  );
});

/* ── row (list view) ────────────────────────────────────────────────────────── */

export const ModelRow = memo(function ModelRow({ m, admin, busy, onToggle, onOpen }: {
  m: AIModel; admin: boolean; busy: boolean; onToggle: (m: AIModel, on: boolean) => void; onOpen: (m: AIModel) => void;
}) {
  const t = useT();
  const TaskIcon = TASK_ICON[m.task] ?? Boxes;
  const name = m.display_name || m.endpoint;
  return (
    <tr onClick={() => onOpen(m)} className="group cursor-pointer border-b border-line/70 text-xs transition-colors last:border-0 hover:bg-hover/60">
      <td className="max-w-[300px] py-2 pl-3 pr-2">
        <div className="flex items-center gap-3">
          <ModelThumb m={m} className="w-14 shrink-0 rounded-md" iconClass="size-4" />
          <div className="min-w-0">
            <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(m); }} title={name}
              className="block max-w-full truncate rounded text-left text-sm font-medium text-ink hover:text-accent-ink">{name}</button>
            <p className="truncate text-2xs text-dim" title={m.id}>{modelSubtitle(m)}</p>
          </div>
        </div>
      </td>
      <td className="px-2"><ProviderBadge m={m} /></td>
      <td className="px-2"><span className="inline-flex items-center gap-1 text-mute"><TaskIcon className="size-3.5" />{t(TASK_LABELS[m.task] ?? m.task)}</span></td>
      <td className="hidden px-2 xl:table-cell"><ModeChips modes={m.capabilities?.modes} max={3} /></td>
      <td className="hidden px-2 lg:table-cell"><CapIcons m={m} /></td>
      <td className="whitespace-nowrap px-2 text-right tabular-nums">{m.est_8s_usd != null ? <span className="font-medium text-ink">{usd(m.est_8s_usd)}</span> : <span className="text-dim">{m.price_label}</span>}</td>
      <td className="px-2"><StatusBadge status={m.status} /></td>
      <td className="hidden px-2 xl:table-cell"><Stats m={m} /></td>
      <td className="py-2 pl-2 pr-3 text-right" onClick={(e) => e.stopPropagation()}><EnableToggle m={m} admin={admin} busy={busy} onToggle={(on) => onToggle(m, on)} /></td>
    </tr>
  );
});
