import { Lock, RotateCcw, Route, Unlink } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { STATUS_LABELS, STATUS_TONE } from "../../components/hub/util";
import { Badge, Button, Input, StatusDot, Tag, Toggle } from "../../components/ui";
import { cn } from "../../lib/cn";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { AIModel, ModelRoute } from "../../lib/types";
import { providerLabel, routeOf } from "./catalogData";
import { clipUsd } from "./modelMeta";

/*
 * Routes: one model reachable through several providers (Seedance on BytePlus, OpenRouter and fal.ai). The catalog shows
 * the model once with its routes; each route is its own engine, switched on or off by itself.
 */

const MODE_TONE = { live: "ok", mock: "warn", missing: "bad" } as const;
const ROUTES_TITLE = "The same model through several providers: the cheapest live route that is on runs first, the others take over if it fails";

/** Most routes a card lists; the model page has the rest. */
const CARD_MAX = 4;

/** Valid route keys (the server checks the same). */
export const ROUTE_KEY_RX = /^[a-z0-9][a-z0-9.-]{0,59}$/;

export const isOn = (r: Pick<ModelRoute, "status">) => r.status === "enabled";

function modeText(mode: ModelRoute["provider_mode"], t: (s: string) => string) {
  return mode === "live" ? t("live") : mode === "mock" ? t("mock mode") : t("no API key");
}

/** USD for an 8 second clip through one route (the list price while its provider isn't live), or null when not priced per clip. */
export function routeClip(r: ModelRoute, task: AIModel["task"]): number | null {
  return clipUsd({ est_8s_usd: r.est_8s_usd, price_usd: r.price_usd ?? null, price_unit: r.price_unit ?? "", task, builtin: false });
}

/** A card's status across its routes: on when any route is on, otherwise the most hopeful of the rest. */
export function cardStatus(m: Pick<AIModel, "status" | "routes">): AIModel["status"] {
  const routes = m.routes ?? [];
  if (routes.length < 2) return m.status;
  for (const s of ["enabled", "new", "disabled"] as const) if (routes.some((r) => r.status === s)) return s;
  return m.status;
}

/**
 * The routes listed on an engine's page: its card's routes (switched-off ones too), the engine itself when the card wasn't
 * found, then switched-on engines with the same key that the search missed (a key set by hand under another name).
 */
export function pageRoutes(m: AIModel, card: ModelRoute[] | undefined): ModelRoute[] {
  const out = [...(card ?? [])];
  const seen = new Set(out.map((r) => r.id));
  if (!seen.has(m.id)) { out.unshift(routeOf(m)); seen.add(m.id); }
  for (const r of m.other_routes ?? []) if (!seen.has(r.id)) { out.push(r); seen.add(r.id); }
  return out;
}

/** "2 of 3 routes on". */
export function RoutesOn({ routes, className }: { routes: ModelRoute[]; className?: string }) {
  const t = useT();
  const n = routes.filter(isOn).length;
  return <Badge tone={n ? "ok" : "neutral"} dot title={t(ROUTES_TITLE)} className={cn("mono", className)}>{t("{n} of {m} routes on", { n, m: routes.length })}</Badge>;
}

/** On/off switch for one route. The clipping box keeps its padded click area off the switches above and below. */
function RouteSwitch({ r, name, busy, onToggle }: { r: ModelRoute; name: string; busy: boolean; onToggle: (r: ModelRoute, on: boolean) => void }) {
  const t = useT();
  if (r.status === "retired") return <span className="mono shrink-0 text-2xs uppercase tracking-wider text-dim">{t("Retired")}</span>;
  return (
    <span className="pointer-events-auto relative z-[2] -m-1 inline-flex shrink-0 overflow-hidden p-1">
      <Toggle checked={isOn(r)} disabled={busy} onChange={(on) => onToggle(r, on)}
        label={<span className="sr-only">{t("Run {name} on {provider}", { name, provider: providerLabel(r.provider) })}</span>} />
    </span>
  );
}

function PriceText({ r, task, className }: { r: ModelRoute; task: AIModel["task"]; className?: string }) {
  const t = useT();
  const clip = routeClip(r, task);
  return (
    <span className={cn("mono shrink-0", isOn(r) && clip != null ? "text-money" : "text-dim", className)}
      title={clip != null ? `${t("8 s clip")} · ${r.price_label ?? ""}` : r.price_label}>
      {clip != null ? usd(clip) : r.price_label || "—"}
    </span>
  );
}

/**
 * The routes of a grouped card, lead first: provider with its live / placeholder / no-key dot and the price of an 8 s clip.
 * Admins get an on/off switch per route; the rows themselves let clicks through to the card (which opens the model).
 */
export function CardRoutes({ m, admin, busyId, onToggle, className }: {
  m: AIModel; admin: boolean; busyId: string | null; onToggle?: (r: ModelRoute, on: boolean) => void; className?: string;
}) {
  const t = useT();
  const routes = m.routes ?? [];
  if (routes.length < 2) return null;
  const name = m.display_name || m.endpoint;
  const more = routes.length - CARD_MAX;
  return (
    <div className={cn("pointer-events-none rounded-lg border border-line bg-raised/40 px-2.5 py-2", className)}>
      <p className="eyebrow mb-1 flex items-center gap-1.5" title={t(ROUTES_TITLE)}><Route className="size-3" aria-hidden />{t("{n} routes", { n: routes.length })}</p>
      <ul aria-label={t("Routes")} className="space-y-1">
        {routes.slice(0, CARD_MAX).map((r) => {
          const on = isOn(r);
          return (
            <li key={r.id} className="flex min-h-6 items-center gap-2 text-2xs">
              <StatusDot tone={MODE_TONE[r.provider_mode]} />
              <span title={`${providerLabel(r.provider)} · ${modeText(r.provider_mode, t)} · ${r.endpoint || r.id}`}
                className={cn("mono min-w-0 flex-1 truncate uppercase tracking-wider", on ? "text-mute" : "text-dim line-through")}>
                {providerLabel(r.provider)}
              </span>
              <PriceText r={r} task={m.task} />
              {admin && onToggle ? <RouteSwitch r={r} name={name} busy={busyId === r.id} onToggle={onToggle} />
                : !on && <span className="mono shrink-0 uppercase tracking-wider text-dim">{t(STATUS_LABELS[r.status ?? ""] ?? "Off")}</span>}
            </li>
          );
        })}
      </ul>
      {more > 0 && <p className="mt-1 text-2xs text-dim">{t("+{n} more on the model page", { n: more })}</p>}
    </div>
  );
}

/** Every route of a model on its page: provider and state, endpoint, price of an 8 s clip, and an on/off switch for admins. */
export function RouteTable({ routes, task, name, currentId, leadId, admin, busyId, onToggle }: {
  routes: ModelRoute[]; task: AIModel["task"]; name: string; currentId: string; leadId: string | null; admin: boolean;
  busyId: string | null; onToggle: (r: ModelRoute, on: boolean) => void;
}) {
  const t = useT();
  return (
    <ul aria-label={t("Routes")} className="divide-y divide-line rounded-lg border border-line">
      {routes.map((r) => {
        const on = isOn(r);
        const clip = routeClip(r, task);
        const status = r.status ?? "disabled";
        return (
          <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
            <StatusDot tone={MODE_TONE[r.provider_mode]} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className={cn("text-sm font-medium", !on && "text-mute")}>{providerLabel(r.provider)}</span>
                <span className="text-2xs text-dim">{modeText(r.provider_mode, t)}</span>
                {r.id === leadId && <Badge tone="accent" title={t("The cheapest live route that is on: it runs first, the others are its fallback")}>{t("Runs first")}</Badge>}
                {r.id === currentId && <Badge>{t("This engine")}</Badge>}
                {r.route_key_set && <Badge title={t("An admin set this engine's route key by hand")}>{t("key set by hand")}</Badge>}
              </p>
              <p className="mono mt-0.5 truncate text-2xs text-dim" title={r.id}>{r.endpoint || r.id}</p>
            </div>
            <span className="shrink-0 text-right text-xs">
              <PriceText r={r} task={task} className="block" />
              {clip != null && <span className="block text-2xs text-dim">{t("8 s clip")}</span>}
            </span>
            {admin ? <RouteSwitch r={r} name={name} busy={busyId === r.id} onToggle={onToggle} />
              : <Badge tone={STATUS_TONE[status] ?? "neutral"} dot className="mono uppercase tracking-wider">{t(STATUS_LABELS[status] ?? status)}</Badge>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The route key of one engine: what it is, whether an admin set it, and (for admins) a field to change it, reset it to the
 * one worked out from the name, or keep the engine apart from every other.
 */
export function RouteKeyEditor({ m, admin, busy, onSave }: { m: AIModel; admin: boolean; busy: boolean; onSave: (key: string | null) => void }) {
  const t = useT();
  const id = useId();
  const key = m.route_key ?? "";
  const byHand = typeof m.param_overrides?.route_key === "string";
  const [draft, setDraft] = useState(key);
  // follow the saved key (from here or another tab)
  useEffect(() => setDraft(key), [key]);
  const clean = draft.trim().toLowerCase();
  const bad = clean !== "" && !ROUTE_KEY_RX.test(clean);
  const canSave = !!clean && !bad && clean !== key && !busy;
  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-mute">
        {t("Engines with the same route key run the same model through different providers. The cheapest live one runs first; the others are its fallback.")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">{t("Current")}</span>
        {key ? <Tag className="text-xs">{key}</Tag> : <span className="text-xs text-dim">{t("None: not merged with other engines")}</span>}
        <Badge tone={byHand ? "accent" : "neutral"} title={byHand ? t("An admin set this key; it stays when the name changes") : t("Worked out from the engine's name")}>
          {byHand ? t("set by hand") : t("automatic")}
        </Badge>
      </div>
      {!key && !byHand && (
        <p className="text-2xs leading-4 text-dim">{t("The name doesn't match a model we know, so this engine stands alone. Give it a key to merge it with the same model on other providers.")}</p>
      )}
      {admin ? (
        <form className="space-y-2.5" onSubmit={(e) => { e.preventDefault(); if (canSave) onSave(clean); }}>
          <label htmlFor={id} className="block text-xs font-medium text-mute">{t("Route key")}</label>
          <div className="flex gap-2">
            <Input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} autoComplete="off" placeholder="seedance-2.5"
              aria-invalid={bad || undefined} className={cn("mono min-w-0 flex-1", bad && "border-bad/60 focus:border-bad")} />
            <Button type="submit" variant="primary" disabled={!canSave} loading={busy}>{t("Save")}</Button>
          </div>
          <p className={cn("text-2xs leading-snug", bad ? "text-bad" : "text-dim")}>
            {t("Lowercase letters, digits, dots and dashes, starting with a letter or digit, e.g. seedance-2.5")}
          </p>
          <div className="flex flex-wrap gap-2 border-t border-line pt-2.5">
            <Button type="button" size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} disabled={!byHand || busy}
              title={t("Forget the key set by hand and work it out from the name again")} onClick={() => onSave(null)}>{t("Reset to automatic")}</Button>
            <Button type="button" size="sm" variant="outline" icon={<Unlink className="size-3.5" />} disabled={(byHand && key === "") || busy}
              title={t("Keep this engine apart: never merged with engines on other providers")} onClick={() => onSave("")}>{t("Never merge")}</Button>
          </div>
        </form>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-dim"><Lock className="size-3.5" />{t("Only admins can change the route key.")}</p>
      )}
    </div>
  );
}
