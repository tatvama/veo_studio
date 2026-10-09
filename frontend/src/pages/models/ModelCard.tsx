import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, AudioLines, Boxes, Film, GitCompareArrows, Image as ImageIcon, Images, Music, Play, Route, Speech, Sparkles, Star, Trophy, UserRound, Wand2, XCircle, Zap,
} from "lucide-react";
import { memo, useCallback, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { MODE_LABELS, STATUS_LABELS, TASK_LABELS, TIER_LABELS, durationsText, isVideoUrl } from "../../components/hub/util";
import { Badge, Meter, StatusDot, Tag, Toggle, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import type { AIModel } from "../../lib/types";
import { patchModelInCache, providerLabel, refreshAfterModelChange } from "./catalogData";
import { capRows, clipUsd, isListPrice, perSecond, purposeText, rateText, speedCells, successPct } from "./modelMeta";

import "../../styles/console.css";
import "../../styles/models.css";

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

/* ── small badges ───────────────────────────────────────────────────────────── */

const MONO_BADGE = "mono uppercase tracking-wider";

/** Catalog status: new / enabled / disabled / retired. Dot or icon plus a word, never colour alone. */
export function StatusBadge({ status, className }: { status: AIModel["status"]; className?: string }) {
  const t = useT();
  const label = t(STATUS_LABELS[status] ?? status);
  if (status === "new") return <Badge tone="accent" className={cn(MONO_BADGE, className)}><Sparkles className="size-3" />{label}</Badge>;
  if (status === "enabled") return <Badge tone="ok" dot className={cn(MONO_BADGE, className)}>{label}</Badge>;
  if (status === "retired") return <Badge tone="bad" className={cn(MONO_BADGE, className)}><XCircle className="size-3" />{label}</Badge>;
  return <Badge className={cn(MONO_BADGE, className)}>{label}</Badge>;
}

type Tone = "ok" | "warn" | "bad";
export const providerTone = (m: Pick<AIModel, "provider_mode">): Tone => (m.provider_mode === "live" ? "ok" : m.provider_mode === "mock" ? "warn" : "bad");
function providerState(m: Pick<AIModel, "provider_mode">, t: (s: string) => string) {
  return m.provider_mode === "live" ? t("live") : m.provider_mode === "mock" ? t("mock mode") : t("no API key");
}

/** Whether the provider behind this engine is live, a placeholder (mock mode) or missing its key. */
export function StateBadge({ m, className }: { m: Pick<AIModel, "provider" | "provider_mode">; className?: string }) {
  const t = useT();
  const text = m.provider_mode === "live" ? t("Live") : m.provider_mode === "mock" ? t("Placeholder") : t("No API key");
  return (
    <Badge tone={providerTone(m)} dot title={`${providerLabel(m.provider)} · ${providerState(m, t)}`} className={cn(MONO_BADGE, className)}>{text}</Badge>
  );
}

/** Provider name with a state dot: the eyebrow line of a spec card. */
export function ProviderBadge({ m, className }: { m: Pick<AIModel, "provider" | "provider_mode">; className?: string }) {
  const t = useT();
  return (
    <span title={`${providerLabel(m.provider)} · ${providerState(m, t)}`} className={cn("mono inline-flex min-w-0 items-center gap-1.5 text-2xs uppercase tracking-wider text-mute", className)}>
      <StatusDot tone={providerTone(m)} />
      <span className="truncate">{providerLabel(m.provider)}</span>
    </span>
  );
}

export function ModeChips({ modes, max = 6, className }: { modes?: string[]; max?: number; className?: string }) {
  const t = useT();
  const list = modes ?? [];
  if (!list.length) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {list.slice(0, max).map((x) => (
        <span key={x} title={t(MODE_LABELS[x] ?? x)} className="mono rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-2xs leading-none text-mute">{x}</span>
      ))}
      {list.length > max && <span className="mono text-2xs text-dim" title={list.slice(max).map((x) => t(MODE_LABELS[x] ?? x)).join(", ")}>+{list.length - max}</span>}
    </span>
  );
}

/** Capability chips: lit when the engine can do it, dashed and struck through when engines of its kind usually can. */
export function CapRow({ m, className, lit }: { m: Pick<AIModel, "capabilities" | "task">; className?: string; lit?: boolean }) {
  const t = useT();
  const rows = capRows(m).filter((r) => !lit || r.on);
  if (!rows.length) return null;
  return (
    <ul aria-label={t("Capabilities")} className={cn("flex flex-wrap items-center gap-1", className)}>
      {rows.map(({ def, on }) => (
        <li key={def.key} data-on={on} className="hub-cap" title={on ? t(def.title) : `${t(def.label)}: ${t("No")}`}>
          <def.icon aria-hidden />
          <span>{t(def.label)}</span>
          {!on && <span className="sr-only">{t("No")}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Mono spec tags: reference images, clip lengths, resolutions, and a warning when the schema is not mapped. */
export function SpecTags({ m, className, modes = 0 }: { m: AIModel; className?: string; modes?: number }) {
  const t = useT();
  const c = m.capabilities ?? {};
  const dur = durationsText(c.durations);
  const refs = c.max_refs ?? 0;
  const res = c.resolutions ?? [];
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {modes > 0 && <ModeChips modes={c.modes} max={modes} />}
      {refs > 0 && <span title={t("Up to {n} reference images", { n: refs })}><Tag k={<Images className="size-3" aria-hidden />}>{refs}</Tag></span>}
      {dur && <span title={t("Clip lengths")}><Tag>{dur}</Tag></span>}
      {res.length > 0 && <span title={t("Resolutions")}><Tag>{res.join(" · ")}</Tag></span>}
      {c.usable === false && (
        <Badge tone="bad" title={t("Input schema could not be mapped — this engine can't be used yet")}><XCircle className="size-3" />{t("unusable")}</Badge>
      )}
    </span>
  );
}

/** The same model through other providers, each with its state and price per second. */
export function RoutesLine({ m, className }: { m: Pick<AIModel, "other_routes">; className?: string }) {
  const t = useT();
  const routes = m.other_routes ?? [];
  if (!routes.length) return null;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-mute", className)}
      title={t("The same model through other providers: the cheapest live one runs first, the others take over if it fails")}>
      <Route className="size-3 shrink-0" aria-hidden /><span>{t("Also on")}</span>
      {routes.map((r) => (
        <span key={r.id} className="mono inline-flex items-center gap-1">
          <StatusDot tone={r.provider_mode === "live" ? "ok" : r.provider_mode === "mock" ? "warn" : "bad"} />
          {providerLabel(r.provider)}
          {r.est_8s_usd ? <span className="text-money">{rateText(r.est_8s_usd / 8)}/s</span> : null}
        </span>
      ))}
    </p>
  );
}

/** Price per second in money mono, with the 8 second clip under it (or the plain list price for engines not priced per clip). */
export function PriceBlock({ m, className, size = "md" }: { m: AIModel; className?: string; size?: "sm" | "md" }) {
  const t = useT();
  const { value, exact } = perSecond(m);
  const clip = clipUsd(m);
  const hint = `${m.price_label}${m.price_source ? ` · ${t(m.price_source)}` : ""}`;
  if (value == null) {
    return (
      <span className={cn("mono block min-w-0", className)} title={hint}>
        <span className={cn("block truncate font-medium", size === "sm" ? "text-xs" : "text-sm", m.price_usd != null ? "text-money" : "text-dim")}>{m.price_label}</span>
        {m.price_usd != null && m.price_source && <span className="mt-0.5 block truncate text-2xs text-dim">{t(m.price_source)}</span>}
      </span>
    );
  }
  return (
    <span className={cn("mono block min-w-0", className)} title={hint}>
      <span className="flex items-baseline gap-1 text-money">
        <span className={cn("font-medium leading-none", size === "sm" ? "text-sm" : "text-lg")}>{exact ? "" : "~"}{rateText(value)}</span>
        <span className="text-2xs text-dim">/s</span>
      </span>
      {clip != null && (
        <span className="mt-1 block truncate text-2xs text-dim">
          {t("8 s clip")} <span className="text-money">{usd(clip)}</span>{isListPrice(m) && <span> · {t("list price")}</span>}
        </span>
      )}
    </span>
  );
}

/** Speed (from the tier) and the team rating as two segmented meters. */
export function MeterPair({ m, className }: { m: Pick<AIModel, "tier" | "rating">; className?: string }) {
  const t = useT();
  const sp = speedCells(m.tier);
  const rating = m.rating != null ? Math.max(0, Math.min(5, Math.round(m.rating))) : 0;
  return (
    <div className={cn("grid grid-cols-2 gap-4", className)}>
      <div title={t("Estimated from the engine's tier: draft is fastest, premium is the best quality")}>
        <p className="eyebrow mb-1.5 flex items-center justify-between gap-2"><span>{t("Speed")}</span>
          <span className="mono normal-case tracking-normal text-mute">{m.tier ? t(TIER_LABELS[m.tier] ?? m.tier) : "—"}</span></p>
        <Meter filled={sp} total={3} tone="accent" />
      </div>
      <div title={t("Team rating")}>
        <p className="eyebrow mb-1.5 flex items-center justify-between gap-2"><span>{t("Rating")}</span>
          <span className="mono normal-case tracking-normal text-mute">{m.rating != null ? m.rating.toFixed(1) : "—"}</span></p>
        <Meter filled={rating} total={5} tone="accent" />
      </div>
    </div>
  );
}

/** Wins, uses and failures as one mono line. */
export function Stats({ m, className }: { m: Pick<AIModel, "wins" | "uses" | "failures" | "rating">; className?: string }) {
  const t = useT();
  const total = (m.uses || 0) + (m.failures || 0);
  const failPct = total ? Math.round(((m.failures || 0) / total) * 100) : 0;
  return (
    <span className={cn("mono inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-mute", className)}>
      <span className="inline-flex items-center gap-0.5" title={t("Shootout wins")}><Trophy className="size-3" />{m.wins || 0}</span>
      <span title={t("Successful generations")}>{t("{n} uses", { n: (m.uses || 0).toLocaleString() })}</span>
      {(m.failures || 0) > 0 && <span className={failPct >= 20 ? "text-bad" : "text-warn"} title={t("Failed generations")}>{t("{n} failed", { n: m.failures })} ({failPct}%)</span>}
    </span>
  );
}

/* ── thumbnail ──────────────────────────────────────────────────────────────── */

/**
 * Preview tile. Real images load lazily and fade in; everything else (most of the catalog has none) gets a quiet dotted
 * bed with the task icon, so cards never look broken. Video previews only mount while hovered.
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
  const dots: CSSProperties = {
    backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--color-ink) 9%, transparent) 1px, transparent 0)",
    backgroundSize: "12px 12px",
  };
  const showImg = !!src && !isVideo && !failed;
  return (
    <div className={cn("relative overflow-hidden bg-raised", aspect, className)}
      onPointerEnter={isVideo ? () => setHover(true) : undefined} onPointerLeave={isVideo ? () => setHover(false) : undefined}>
      {!(showImg && loaded) && (
        <>
          <div aria-hidden className="absolute inset-0 opacity-80" style={dots} />
          <Icon aria-hidden className={cn("absolute text-accent-ink/70", iconAt === "right" ? "right-8 top-6" : "inset-0 m-auto", iconClass)} />
        </>
      )}
      {showImg && (
        <img src={src} alt="" loading={eager ? "eager" : "lazy"} decoding="async" draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
          className={cn("absolute inset-0 size-full object-cover transition-opacity duration-300", loaded ? "opacity-100" : "opacity-0")} />
      )}
      {isVideo && !failed && (
        <>
          {hover && <video src={src} muted loop autoPlay playsInline preload="auto" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />}
          {!hover && <span aria-hidden className="absolute bottom-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm"><Play className="size-2.5 fill-current" /></span>}
        </>
      )}
    </div>
  );
}

/* ── enable toggle ──────────────────────────────────────────────────────────── */

export function EnableToggle({ m, admin, busy, onToggle }: { m: AIModel; admin: boolean; busy: boolean; onToggle: (on: boolean) => void }) {
  const t = useT();
  if (m.status === "retired") return <span className="mono text-2xs uppercase tracking-wider text-dim">{t("Retired")}</span>;
  return (
    <span title={admin ? undefined : t("Only admins can switch engines on or off")} className="inline-flex">
      <Toggle checked={m.status === "enabled"} disabled={!admin || busy} onChange={onToggle}
        label={<span className="sr-only">{t("Enable {name}", { name: m.display_name || m.endpoint })}</span>} />
    </span>
  );
}

/** "Add to compare" switch used on cards and rows. */
export function CompareToggle({ name, on, onToggle, disabled, className }: { name: string; on: boolean; onToggle: () => void; disabled?: boolean; className?: string }) {
  const t = useT();
  return (
    <button type="button" aria-pressed={on} disabled={disabled && !on} onClick={onToggle} aria-label={t("Compare {name}", { name })}
      title={disabled && !on ? t("Compare up to {n} engines at a time", { n: 3 }) : t("Compare {name}", { name })}
      className={cn("cx-chip max-sm:h-10", on && "is-on", className)}>
      <GitCompareArrows aria-hidden />{t("Compare")}
    </button>
  );
}

/* ── spec-sheet card (grid view) ────────────────────────────────────────────── */

export const ModelCard = memo(function ModelCard({ m, admin, busy, onToggle, onOpen, index, open, comparing, compareFull, onCompare }: {
  m: AIModel; admin: boolean; busy: boolean; onToggle: (m: AIModel, on: boolean) => void; onOpen: (m: AIModel) => void; index?: number;
  open?: boolean; comparing?: boolean; compareFull?: boolean; onCompare?: (m: AIModel) => void;
}) {
  const t = useT();
  const name = m.display_name || m.endpoint;
  const purpose = purposeText(m);
  const TaskIcon = TASK_ICON[m.task] ?? Boxes;
  const c = m.capabilities ?? {};
  const mapped = !!(c.modes?.length || c.native_audio || (c.max_refs ?? 0) > 0 || c.durations || c.resolutions?.length || c.usable === false);
  // only the first screenful animates in; later pages just appear
  const r = index !== undefined && index < 12 ? rise(index) : null;
  const ok = successPct(m);
  return (
    <article data-status={m.status} data-open={open || undefined} style={r?.style}
      className={cn("hud hub-card group relative flex h-full flex-col gap-3 rounded-xl border bg-panel p-3.5", r?.className)}>
      <button type="button" onClick={() => onOpen(m)} aria-label={t("Open {name}", { name })} className="absolute inset-0 z-[1] rounded-xl outline-offset-[-2px]" />

      <div className="pointer-events-none flex items-center justify-between gap-2">
        <ProviderBadge m={m} />
        <span className="flex shrink-0 items-center gap-1">
          {m.status !== "enabled" && <StatusBadge status={m.status} />}
          <StateBadge m={m} />
        </span>
      </div>

      <div className="pointer-events-none flex items-start gap-3">
        <ModelThumb m={m} aspect="aspect-square" className="size-11 shrink-0 rounded-lg border border-line" iconClass="size-5" />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug" title={name}>{name}</h3>
          <p className="mono mt-0.5 truncate text-2xs text-dim" title={m.id}>{modelSubtitle(m)}</p>
        </div>
      </div>

      <p className="pointer-events-none line-clamp-2 min-h-8 text-xs leading-4 text-mute">
        {purpose || ((c.modes ?? []).map((x) => t(MODE_LABELS[x] ?? x)).join(" · ") || t(TASK_LABELS[m.task] ?? m.task))}
      </p>

      <div className="pointer-events-none flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Tag><span className="inline-flex items-center gap-1"><TaskIcon className="size-3" aria-hidden />{t(TASK_LABELS[m.task] ?? m.task)}</span></Tag>
          {m.builtin && <span title={t("Built-in engine (direct API)")}><Tag>{t("built-in")}</Tag></span>}
        </div>
        <CapRow m={m} />
        {mapped ? <SpecTags m={m} modes={3} /> : <span className="text-2xs text-dim">{t("Details not mapped yet")}</span>}
        <RoutesLine m={m} />
        {m.unmapped_required?.length > 0 && (
          <p className="flex items-center gap-1 text-2xs text-warn" title={m.unmapped_required.join(", ")}>
            <AlertTriangle className="size-3 shrink-0" /><span className="truncate">{t("Needs mapping: {fields}", { fields: m.unmapped_required.slice(0, 3).join(", ") })}</span>
          </p>
        )}
      </div>

      <MeterPair m={m} className="pointer-events-none" />

      <div className="mt-auto flex flex-col gap-2.5 border-t border-line pt-3">
        <div className="pointer-events-none flex items-end justify-between gap-3">
          <PriceBlock m={m} />
          <div className="min-w-0 text-right">
            {m.uses || m.wins || m.failures ? <Stats m={m} className="justify-end" /> : <span className="text-2xs text-dim">{t("No usage yet")}</span>}
            {ok != null && <p className="mono mt-0.5 text-2xs text-dim">{t("{n}% success", { n: ok })}</p>}
          </div>
        </div>
        <div className="relative z-[2] flex items-center justify-between gap-2">
          {onCompare ? <CompareToggle name={name} on={!!comparing} disabled={compareFull} onToggle={() => onCompare(m)} /> : <span />}
          <EnableToggle m={m} admin={admin} busy={busy} onToggle={(on) => onToggle(m, on)} />
        </div>
      </div>
    </article>
  );
});

/* ── row (table view) ───────────────────────────────────────────────────────── */

export const ModelRow = memo(function ModelRow({ m, admin, busy, onToggle, onOpen, open, comparing, compareFull, onCompare }: {
  m: AIModel; admin: boolean; busy: boolean; onToggle: (m: AIModel, on: boolean) => void; onOpen: (m: AIModel) => void;
  open?: boolean; comparing?: boolean; compareFull?: boolean; onCompare?: (m: AIModel) => void;
}) {
  const t = useT();
  const TaskIcon = TASK_ICON[m.task] ?? Boxes;
  const name = m.display_name || m.endpoint;
  const { value, exact } = perSecond(m);
  const clip = clipUsd(m);
  const lit = capRows(m).filter((r) => r.on);
  return (
    <tr onClick={() => onOpen(m)} data-selected={open || undefined} className="group cursor-pointer">
      <td className="cx-stick max-w-[20rem]">
        <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(m); }} title={name}
          className="block max-w-full truncate rounded text-left text-sm font-medium text-ink hover:text-accent-ink">{name}</button>
        <p className="mono max-w-[18rem] truncate text-2xs text-dim" title={m.id}>{modelSubtitle(m)}</p>
      </td>
      <td><span className="inline-flex items-center gap-2"><ProviderBadge m={m} /></span></td>
      <td><span className="inline-flex items-center gap-1.5 text-mute"><TaskIcon className="size-3.5" aria-hidden />{t(TASK_LABELS[m.task] ?? m.task)}</span></td>
      <td>
        {lit.length ? (
          <ul aria-label={t("Capabilities")} className="flex items-center gap-1.5">
            {lit.map(({ def }) => (
              <li key={def.key} title={t(def.title)} className="text-accent-ink"><def.icon className="size-3.5" aria-hidden /><span className="sr-only">{t(def.label)}</span></li>
            ))}
          </ul>
        ) : <span className="text-dim">—</span>}
      </td>
      <td className="cx-r">{value != null ? <span className="text-money">{exact ? "" : "~"}{rateText(value)}</span> : <span className="text-dim">—</span>}</td>
      <td className="cx-r">{clip != null ? <span className="text-money">{usd(clip)}</span> : <span className="text-dim" title={m.price_label}>{m.price_label}</span>}</td>
      <td className="cx-mono">{m.tier ? t(TIER_LABELS[m.tier] ?? m.tier) : "—"}</td>
      <td className="cx-r">{m.rating != null ? <span className="inline-flex items-center gap-1"><Star className="size-3 text-dim" aria-hidden />{m.rating.toFixed(1)}</span> : <span className="text-dim">—</span>}</td>
      <td className="cx-r" title={(m.failures || 0) > 0 ? t("{n} failed", { n: m.failures }) : undefined}>{(m.uses || 0).toLocaleString()}</td>
      <td><span className="inline-flex flex-wrap items-center gap-1"><StatusBadge status={m.status} /><StateBadge m={m} /></span></td>
      {/* w-px, not .cx-fit: a 1% column inflates a max-content table to (content / 1%) wide */}
      <td className="w-px whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
        <span className="inline-flex items-center gap-2">
          {onCompare && <CompareToggle name={name} on={!!comparing} disabled={compareFull} onToggle={() => onCompare(m)} />}
          <EnableToggle m={m} admin={admin} busy={busy} onToggle={(on) => onToggle(m, on)} />
        </span>
      </td>
    </tr>
  );
});
