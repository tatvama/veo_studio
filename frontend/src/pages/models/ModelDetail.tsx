import {
  AlertTriangle, Check, Coins, Copy, ExternalLink, GitCompareArrows, Info, Layers, ListTree, Lock, Settings2, Tags, Trophy, X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  MODE_LABELS, PRICE_UNITS, TASK_LABELS, TIERS, TIER_LABELS, dateText, durationsText, visibleTags,
} from "../../components/hub/util";
import { Alert, Badge, Button, Field, IconButton, Input, Meter, Metric, Panel, Segmented, Select, Skeleton, Tabs, Tag, Textarea } from "../../components/ui";
import { cn } from "../../lib/cn";
import { ago, usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useModel } from "../../lib/queries";
import type { AIModel } from "../../lib/types";
import { providerLabel } from "./catalogData";
import { CAP_DEFS, clipUsd, hasCap, isListPrice, isTimeBased, perSecond, rateText, speedCells, successPct } from "./modelMeta";
import { ModelThumb, ProviderBadge, RoutesLine, StateBadge, StatusBadge, TASK_ICON, useModelPatch, type ModelPatchBody } from "./ModelCard";
import { SlideOver } from "./SlideOver";

import "../../styles/console.css";
import "../../styles/models.css";

interface Form { status: string; tier: string; rating: string; price_usd: string; price_unit: string; notes: string; overrides: string }

const toForm = (m: AIModel): Form => ({
  status: m.status, tier: m.tier || "", rating: m.rating != null ? String(m.rating) : "",
  price_usd: m.price_usd != null ? String(m.price_usd) : "", price_unit: m.price_unit || "", notes: m.notes || "",
  overrides: JSON.stringify(m.param_overrides ?? {}, null, 2),
});

function parseOverrides(text: string): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: tr("Must be a JSON object, e.g. {\"fixed_args\": {…}}") };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

type TabKey = "overview" | "params" | "team";

/** Whether the model is in the catalog's compare tray (all optional: the detail also works on its own). */
export interface DetailCompare { on: boolean; full: boolean; toggle: () => void }

/** Slide-over spec sheet for one engine: specs, capabilities, track record, price table, parameter mapping and (for admins) team settings. */
export default function ModelDetail({ model, open, admin, onClose, compare }: { model: AIModel; open: boolean; admin: boolean; onClose: () => void; compare?: DetailCompare }) {
  const guard = useRef<(() => boolean) | null>(null);
  const requestClose = () => { if (guard.current?.()) return; onClose(); };
  return (
    <SlideOver open={open} onClose={requestClose} label={model.display_name || model.endpoint}>
      <DetailBody key={model.id} model={model} admin={admin} requestClose={requestClose} onClose={onClose} guard={guard} compare={compare} />
    </SlideOver>
  );
}

function DetailBody({ model, admin, requestClose, onClose, guard, compare }: {
  model: AIModel; admin: boolean; requestClose: () => void; onClose: () => void; guard: React.MutableRefObject<(() => boolean) | null>; compare?: DetailCompare;
}) {
  const t = useT();
  const { data: full, isLoading } = useModel(model.id);
  const m: AIModel = { ...model, ...(full ?? {}) };
  const { patch, busy } = useModelPatch();
  const [tab, setTabState] = useState<TabKey>("overview");
  const scroller = useRef<HTMLDivElement>(null);
  const setTab = (next: TabKey) => {
    setTabState(next);
    // a new tab starts at its top (just under the sticky tab bar)
    const el = scroller.current;
    const bar = el?.querySelector<HTMLElement>("[data-tabs-sticky]");
    if (el && bar && el.scrollTop > bar.offsetTop) el.scrollTo({ top: bar.offsetTop });
  };
  const [form, setForm] = useState<Form>(() => toForm(m));
  const [base, setBase] = useState<Form>(() => toForm(m));
  const [copied, setCopied] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // adopt fresh server data when the user hasn't touched the form
  const serverForm = JSON.stringify(toForm(m));
  useEffect(() => {
    const next = JSON.parse(serverForm) as Form;
    if (JSON.stringify(form) === JSON.stringify(base)) setForm(next);
    setBase(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverForm]);

  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const parsed = useMemo(() => parseOverrides(form.overrides), [form.overrides]);
  const ratingNum = form.rating.trim() === "" ? null : Number(form.rating);
  const priceNum = form.price_usd.trim() === "" ? null : Number(form.price_usd);
  const ratingBad = ratingNum !== null && (Number.isNaN(ratingNum) || ratingNum < 0 || ratingNum > 5);
  const priceBad = priceNum !== null && (Number.isNaN(priceNum) || priceNum < 0);
  const invalid = !parsed.ok || ratingBad || priceBad;
  const teamDirty = (["status", "tier", "rating", "price_usd", "price_unit", "notes"] as const).some((k) => form[k] !== base[k]);
  const paramsDirty = form.overrides !== base.overrides;

  // closing with unsaved edits asks first (inline, not a browser dialog)
  guard.current = () => {
    if (!dirty || !admin) return false;
    setConfirmClose(true);
    return true;
  };
  useEffect(() => { if (!dirty) setConfirmClose(false); }, [dirty]);

  const save = async () => {
    if (invalid || !parsed.ok || !admin) return;
    const body: ModelPatchBody = {};
    if (form.status !== base.status) body.status = form.status as AIModel["status"];
    if (form.tier !== base.tier) body.tier = form.tier;
    if (form.rating !== base.rating) body.rating = ratingNum;
    if (form.price_usd !== base.price_usd) body.price_usd = priceNum;
    if (form.price_unit !== base.price_unit) body.price_unit = form.price_unit;
    if (form.notes !== base.notes) body.notes = form.notes;
    if (JSON.stringify(parsed.value) !== JSON.stringify(m.param_overrides ?? {})) body.param_overrides = parsed.value;
    if (!Object.keys(body).length) { setBase(form); return; }
    const res = await patch(m, body, tr("Saved {name}", { name: m.display_name }));
    if (res) {
      const next = toForm({ ...m, ...res });
      setBase(next);
      setForm(next);
    }
  };

  // Ctrl/Cmd+S saves
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void saveRef.current(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(m.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error(t("Couldn't copy"));
    }
  };

  const pm = (full?.param_map ?? null) as null | {
    slots?: Record<string, { name: string; types?: string[]; enum?: any[] | null; min?: number | null; max?: number | null; default?: any; required?: boolean; max_items?: number | null }>;
    required_defaults?: Record<string, any>; unmapped_required?: string[]; property_names?: string[];
  };
  const slots = Object.entries(pm?.slots ?? {});
  const set = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const name = m.display_name || m.endpoint;
  const TaskIcon = TASK_ICON[m.task] ?? TASK_ICON.other;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* header: provider and state, name, engine id, compare */}
        <div className="px-5 pb-4 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <ProviderBadge m={m} />
              <StateBadge m={m} />
              <StatusBadge status={m.status} />
            </div>
            <IconButton title={t("Close")} shortcut="Esc" tipSide="left" onClick={requestClose} className="-mr-1.5 -mt-1 shrink-0"><X className="size-4" /></IconButton>
          </div>
          <h3 className="mt-3 text-xl font-semibold leading-tight tracking-tight" title={name}>{name}</h3>
          <button type="button" onClick={copyId} title={t("Copy engine id")}
            className="mono mt-1 flex max-w-full items-center gap-1.5 rounded text-2xs text-mute transition-colors hover:text-ink">
            <span className="truncate">{m.id}</span>
            {copied ? <Check className="size-3 shrink-0 text-ok" /> : <Copy className="size-3 shrink-0" />}
          </button>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Tag><span className="inline-flex items-center gap-1"><TaskIcon className="size-3" aria-hidden />{t(TASK_LABELS[m.task] ?? m.task)}</span></Tag>
            {m.tier && <Tag k={t("Tier")}>{t(TIER_LABELS[m.tier] ?? m.tier)}</Tag>}
            {m.builtin && <Tag>{t("built-in")}</Tag>}
            {compare && (
              <Button size="sm" variant="outline" className="ml-auto" aria-pressed={compare.on} disabled={compare.full && !compare.on} onClick={compare.toggle}
                icon={<GitCompareArrows className="size-3.5" />}>{compare.on ? t("In compare") : t("Add to compare")}</Button>
            )}
          </div>
          {m.thumbnail_url && (
            <div className="hud mt-4">
              <div className="cx-monitor">
                <ModelThumb m={m} aspect="aspect-[16/7]" className="max-h-44 w-full" iconClass="size-12" iconAt="right" eager />
              </div>
            </div>
          )}
        </div>

        <div data-tabs-sticky className="sticky top-0 z-10 border-b border-line bg-panel/95 px-5 backdrop-blur">
          <Tabs value={tab} onChange={setTab} className="border-b-0" tabs={[
            { value: "overview", label: t("Overview") },
            { value: "params", label: <span className="flex items-center gap-1.5">{t("Parameters")}{paramsDirty && <span aria-hidden className="size-1.5 rounded-full bg-warn" />}</span>, count: slots.length || undefined },
            { value: "team", label: <span className="flex items-center gap-1.5">{t("Team settings")}{teamDirty && <span aria-hidden className="size-1.5 rounded-full bg-warn" />}</span> },
          ]} />
        </div>

        <div className="px-5 py-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} className="space-y-4">
              {tab === "overview" && <Overview m={m} />}
              {tab === "params" && (
                <Params m={m} pm={pm} slots={slots} loading={isLoading} admin={admin} form={form} set={set} parsed={parsed} />
              )}
              {tab === "team" && (
                <Team m={m} admin={admin} form={form} set={set} ratingBad={ratingBad} priceBad={priceBad} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* footer */}
      <div className="shrink-0 border-t border-line bg-panel px-5 py-3">
        <AnimatePresence mode="wait" initial={false}>
          {confirmClose ? (
            <motion.div key="confirm" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}
              className="flex flex-wrap items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-warn"><AlertTriangle className="size-4 shrink-0" />{t("Discard unsaved changes to this model?")}</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClose(false)}>{t("Keep editing")}</Button>
              <Button size="sm" variant="danger" onClick={onClose}>{t("Discard & close")}</Button>
            </motion.div>
          ) : admin ? (
            <motion.div key="actions" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}
              className="flex items-center gap-2">
              <span className={cn("flex items-center gap-1.5 text-xs", dirty ? "text-warn" : "text-dim")}>
                {dirty ? <><span className="size-1.5 rounded-full bg-warn" />{t("Unsaved changes")}</> : t("All changes saved")}
              </span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setForm(base)}>{t("Discard")}</Button>
              <Button variant="primary" size="sm" disabled={!dirty || invalid} loading={busy === m.id} onClick={save}>{t("Save")}</Button>
            </motion.div>
          ) : (
            <motion.p key="ro" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-1.5 text-xs text-dim">
              <Lock className="size-3.5" />{t("Only admins can change these settings.")}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────────── */

function Fact({ k, v }: { k: string; v: ReactNode }) {
  if (v === "" || v == null || v === false) return null;
  return (<><dt className="eyebrow self-center">{k}</dt><dd className="mono min-w-0 break-words text-xs text-ink">{v}</dd></>);
}

/** Price per length of output: the estimate at list price for 1 s … 60 s, or one line for engines priced per run. */
const PRICE_ROWS = [1, 5, 8, 10, 15, 30, 60];

function PriceTable({ m }: { m: AIModel }) {
  const t = useT();
  const { value, exact } = perSecond(m);
  const timed = isTimeBased(m) && value != null;
  return (
    <div className="space-y-2.5">
      <div className="cx-scroll rounded-lg border border-line">
        <table className="cx-table is-dense" aria-label={t("Price")}>
          <thead><tr><th>{timed ? t("Length") : t("Unit")}</th><th className="cx-r">{t("Cost")}</th></tr></thead>
          <tbody>
            {timed ? PRICE_ROWS.map((s) => (
              <tr key={s} data-selected={s === 8 || undefined}>
                <td className="cx-mono">{s < 60 ? `${s} s` : "1 min"}</td>
                <td className="cx-r text-money">{usd(value! * s, value! * s < 1 ? 3 : 2)}</td>
              </tr>
            )) : (
              <tr>
                <td className="cx-mono">{m.price_unit ? t("per {unit}", { unit: m.price_unit }) : t("per run")}</td>
                <td className={cn("cx-r", m.price_usd != null ? "text-money" : "text-dim")}>{m.price_usd != null ? usd(m.price_usd, m.price_usd < 1 ? 3 : 2) : m.price_label}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-2xs leading-4 text-dim">
        <span className="mono text-mute">{m.price_label}</span>{m.price_source ? <> · {t(m.price_source)}</> : null}
        {timed && !exact ? <> · {t("Spread from a per-run price; the real cost depends on the clip.")}</> : null}
        {isListPrice(m) && timed ? <> · {t("Provider is not live: shown at list price, nothing is charged.")}</> : null}
      </p>
    </div>
  );
}

function Overview({ m }: { m: AIModel }) {
  const t = useT();
  const caps = m.capabilities ?? {};
  const tags = visibleTags(m.tags);
  const { value: ps, exact } = perSecond(m);
  const clip = clipUsd(m);
  const ok = successPct(m);
  const total = (m.uses || 0) + (m.failures || 0);
  return (
    <>
      <Panel flush>
        <div className="hub-kpis-wrap">
          <div className="hub-kpis">
            <Metric tone="money" size="sm" label={t("Per second")} value={ps != null ? `${exact ? "" : "~"}${rateText(ps)}` : "—"} unit={ps != null ? "/s" : undefined} />
            <Metric tone="money" size="sm" label={t("8 s clip")} value={clip != null ? usd(clip) : "—"} sub={<span className="truncate" title={m.price_label}>{m.price_label}</span>} />
            <Metric size="sm" label={t("Rating")} value={m.rating != null ? m.rating.toFixed(1) : "—"} sub={m.rating != null ? t("out of 5") : t("Not rated yet")} />
            <Metric size="sm" label={t("Uses")} value={(m.uses || 0).toLocaleString()} sub={(m.failures || 0) > 0 ? t("{n} failed", { n: m.failures }) : t("No failures")} />
            <Metric size="sm" tone={ok == null ? "neutral" : ok >= 80 ? "ok" : ok >= 60 ? "warn" : "bad"} label={t("Success")} value={ok != null ? `${ok}%` : "—"} sub={total ? t("{n} runs", { n: total }) : t("No runs yet")} />
            <Metric size="sm" label={t("Wins")} value={(m.wins || 0).toLocaleString()} sub={t("Shootout wins")} />
          </div>
        </div>
      </Panel>

      {m.description && <p className="text-sm leading-relaxed text-mute">{m.description}</p>}

      <Panel eyebrow={t("Capabilities")} icon={<Layers />}>
        <ul aria-label={t("Capabilities")} className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {CAP_DEFS.map((d) => {
            const on = hasCap(m, d.key);
            return (
              <li key={d.key} className="flex items-start gap-2" title={t(d.title)}>
                <span data-on={on} className="hub-cap shrink-0"><d.icon aria-hidden /><span>{t(d.label)}</span></span>
                <span className={cn("mono mt-0.5 text-2xs", on ? "text-accent-ink" : "text-dim")}>{on ? t("Yes") : t("No")}</span>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
          {(caps.modes ?? []).map((x) => <Badge key={x} title={x}>{t(MODE_LABELS[x] ?? x)}</Badge>)}
          {!(caps.modes ?? []).length && <span className="text-sm text-dim">{t("No modes detected")}</span>}
          {caps.usable === false && <Badge tone="bad">{t("unusable")}</Badge>}
        </div>
      </Panel>

      <Panel eyebrow={t("Specs")} icon={<Info />}>
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
          <Fact k={t("Maker")} v={m.maker} />
          <Fact k={t("Family")} v={m.family} />
          <Fact k={t("Endpoint")} v={<span className="break-all">{m.endpoint}</span>} />
          <Fact k={t("Provider")} v={`${providerLabel(m.provider)} · ${m.provider_mode === "live" ? t("live") : m.provider_mode === "mock" ? t("mock mode") : t("no API key")}`} />
          <Fact k={t("Tier")} v={m.tier ? t(TIER_LABELS[m.tier] ?? m.tier) : ""} />
          <Fact k={t("Durations")} v={durationsText(caps.durations)} />
          <Fact k={t("Resolutions")} v={(caps.resolutions ?? []).join(", ")} />
          <Fact k={t("Aspect ratios")} v={(caps.aspects ?? []).join(", ")} />
          <Fact k={t("Reference images")} v={caps.max_refs ? String(caps.max_refs) : ""} />
          <Fact k={t("Released")} v={dateText(m.released_at)} />
          <Fact k={t("First seen")} v={m.first_seen ? `${dateText(m.first_seen)} · ${ago(m.first_seen)}` : ""} />
        </dl>
      </Panel>

      <Panel eyebrow={t("Track record")} icon={<Trophy />}>
        <div className="grid gap-4 sm:grid-cols-3">
          <div title={t("Estimated from the engine's tier: draft is fastest, premium is the best quality")}>
            <p className="eyebrow mb-1.5 flex items-center justify-between gap-2"><span>{t("Speed")}</span><span className="mono normal-case tracking-normal text-mute">{m.tier ? t(TIER_LABELS[m.tier] ?? m.tier) : "—"}</span></p>
            <Meter filled={speedCells(m.tier)} total={3} />
          </div>
          <div title={t("Team rating")}>
            <p className="eyebrow mb-1.5 flex items-center justify-between gap-2"><span>{t("Rating")}</span><span className="mono normal-case tracking-normal text-mute">{m.rating != null ? `${m.rating.toFixed(1)} / 5` : "—"}</span></p>
            <Meter filled={m.rating != null ? Math.round(m.rating) : 0} total={5} />
          </div>
          <div title={t("Successful generations")}>
            <p className="eyebrow mb-1.5 flex items-center justify-between gap-2"><span>{t("Success")}</span><span className="mono normal-case tracking-normal text-mute">{ok != null ? `${ok}%` : "—"}</span></p>
            <Meter filled={ok != null ? Math.round(ok / 10) : 0} total={10} tone={ok == null ? "accent" : ok >= 80 ? "ok" : ok >= 60 ? "warn" : "bad"} />
          </div>
        </div>
        <p className="mono mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-dim">
          <span>{t("{n} uses", { n: (m.uses || 0).toLocaleString() })}</span>
          <span>{t("{n} failed", { n: (m.failures || 0).toLocaleString() })}</span>
          <span>{t("{n} wins", { n: (m.wins || 0).toLocaleString() })}</span>
        </p>
      </Panel>

      <Panel eyebrow={t("Price")} icon={<Coins />}>
        <PriceTable m={m} />
        {(m.other_routes?.length ?? 0) > 0 && (
          <div className="mt-3 border-t border-line pt-3">
            <RoutesLine m={m} />
            <p className="mt-1 text-2xs text-dim">{t("With “Cheapest route first” on (Settings), the cheapest live provider runs this model and the others take over if it fails.")}</p>
          </div>
        )}
      </Panel>

      {tags.length > 0 && (
        <Panel eyebrow={t("Tags")} icon={<Tags />}>
          <div className="flex flex-wrap gap-1">{tags.map((x) => <Badge key={x}>{x}</Badge>)}</div>
        </Panel>
      )}

      {!m.builtin && m.provider === "fal" && (
        <a href={`https://fal.ai/models/${m.endpoint}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-mute transition-colors hover:text-ink">
          <ExternalLink className="size-4" />{t("Open on fal.ai")}
        </a>
      )}
    </>
  );
}

function Params({ m, pm, slots, loading, admin, form, set, parsed }: {
  m: AIModel;
  pm: null | { required_defaults?: Record<string, any>; unmapped_required?: string[]; property_names?: string[] };
  slots: [string, { name: string; types?: string[]; enum?: any[] | null; min?: number | null; max?: number | null; default?: any; required?: boolean; max_items?: number | null }][];
  loading: boolean; admin: boolean; form: Form; set: (k: keyof Form, v: string) => void;
  parsed: { ok: true; value: Record<string, any> } | { ok: false; error: string };
}) {
  const t = useT();
  return (
    <>
      <Panel eyebrow={t("Parameter mapping")} icon={<ListTree />}>
        <p className="-mt-1 mb-3 text-xs text-mute">{t("How our generic request (prompt, first frame, audio…) is mapped onto this engine's inputs.")}</p>
        {loading ? (
          <div className="space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-3/4" /></div>
        ) : !slots.length ? (
          <p className="flex items-center gap-1.5 text-sm text-dim"><Info className="size-4 shrink-0" />
            {m.builtin ? t("Built-in engine — parameters are handled by the native integration.") : t("No schema mapped yet. Run a sync to fetch it.")}
          </p>
        ) : (
          <div className="cx-scroll max-h-[22rem] rounded-lg border border-line">
            <table className="cx-table is-dense" aria-label={t("Parameter mapping")}>
              <thead>
                <tr>
                  <th>{t("Slot")}</th><th>{t("Parameter")}</th><th>{t("Type")}</th><th>{t("Values")}</th><th>{t("Default")}</th>
                </tr>
              </thead>
              <tbody>
                {slots.map(([slot, s]) => (
                  <tr key={slot}>
                    <td className="cx-mono">{slot}</td>
                    <td className="mono text-xs">{s.name}{s.required && <span className="ml-0.5 text-bad" title={t("Required")}>*</span>}</td>
                    <td className="cx-mono">{(s.types ?? []).join(" | ")}</td>
                    <td className="cx-mono max-w-[140px] truncate" title={s.enum?.join(", ")}>
                      {s.enum?.length ? s.enum.slice(0, 6).join(", ") + (s.enum.length > 6 ? "…" : "") : s.min != null || s.max != null ? `${s.min ?? ""}–${s.max ?? ""}` : s.max_items ? `≤${s.max_items}` : ""}
                    </td>
                    <td className="cx-mono max-w-[90px] truncate">{s.default != null ? String(s.default) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!pm?.required_defaults && Object.keys(pm.required_defaults).length > 0 && (
          <p className="mt-2 text-xs text-dim">{t("Required inputs filled with defaults")}: <span className="mono">{Object.keys(pm.required_defaults).join(", ")}</span></p>
        )}
        {!!m.unmapped_required?.length && (
          <Alert tone="warn" className="mt-3">
            {t("Required inputs we can't fill automatically: {fields}. Add them under fixed_args below.", { fields: m.unmapped_required.join(", ") })}
          </Alert>
        )}
        {!!pm?.property_names?.length && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-mute hover:text-ink">{t("All {n} inputs", { n: pm.property_names.length })}</summary>
            <p className="mono mt-1.5 break-words text-dim">{pm.property_names.join(", ")}</p>
          </details>
        )}
      </Panel>

      <Panel eyebrow={t("Parameter overrides")} icon={<Settings2 />}>
        <Field label={t("Parameter overrides (JSON)")}
          hint={parsed.ok
            ? <span>{t("Extra fixed arguments sent with every request, e.g.")} <code className="mono">{`{"fixed_args": {"enable_safety_checker": false}}`}</code></span>
            : <span className="text-bad">{t("Invalid JSON")}: {parsed.error}</span>}>
          <Textarea rows={7} spellCheck={false} value={form.overrides} disabled={!admin} onChange={(e) => set("overrides", e.target.value)}
            className={cn("font-mono text-xs", !parsed.ok && "border-bad/60 focus:border-bad")} />
        </Field>
      </Panel>
    </>
  );
}

function Team({ m, admin, form, set, ratingBad, priceBad }: {
  m: AIModel; admin: boolean; form: Form; set: (k: keyof Form, v: string) => void; ratingBad: boolean; priceBad: boolean;
}) {
  const t = useT();
  return (
    <>
      {!admin && <Alert tone="info" icon={<Lock className="size-4" />}>{t("Only admins can change these.")}</Alert>}
      <Panel eyebrow={t("Availability")} icon={<Settings2 />}>
        <p className="-mt-1 mb-3 text-xs text-mute">{t("Enabled engines can be picked for shots and used by the routing policy.")}</p>
        {m.status === "retired" ? <p className="text-sm text-dim">{t("Retired — no longer listed by the provider.")}</p> : (
          <div className={cn(!admin && "pointer-events-none opacity-60")}>
            <Segmented value={form.status} onChange={(v) => set("status", v)} aria-label={t("Status")} options={[
              { value: "enabled", label: t("Enabled") }, { value: "disabled", label: t("Disabled") }, { value: "new", label: t("New") },
            ]} />
          </div>
        )}
      </Panel>

      <Panel eyebrow={t("Quality and price")} icon={<Coins />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Tier")}>
            <Select value={form.tier} disabled={!admin} onChange={(e) => set("tier", e.target.value)}>
              <option value="">—</option>
              {TIERS.map((x) => <option key={x} value={x}>{t(TIER_LABELS[x])}</option>)}
            </Select>
          </Field>
          <Field label={t("Team rating (0–5)")} hint={ratingBad ? <span className="text-bad">{t("Enter a number from 0 to 5")}</span> : undefined}>
            <Input type="number" step="0.5" min={0} max={5} value={form.rating} disabled={!admin} onChange={(e) => set("rating", e.target.value)} placeholder="—" className="mono" />
          </Field>
          <Field label={t("Price override (USD)")} hint={priceBad ? <span className="text-bad">{t("Enter a positive number")}</span> : t("Leave empty to use the live / catalog price.")}>
            <Input type="number" step="0.001" min={0} value={form.price_usd} disabled={!admin} onChange={(e) => set("price_usd", e.target.value)} placeholder="—" className="mono text-money" />
          </Field>
          <Field label={t("Price unit")}>
            <Select value={form.price_unit} disabled={!admin} onChange={(e) => set("price_unit", e.target.value)}>
              <option value="">—</option>
              {[...new Set([...PRICE_UNITS, ...(form.price_unit ? [form.price_unit] : [])])].map((u) => <option key={u} value={u}>{t("per {unit}", { unit: u })}</option>)}
            </Select>
          </Field>
        </div>
      </Panel>

      <Panel eyebrow={t("Notes")} icon={<Info />}>
        <Textarea rows={3} value={form.notes} disabled={!admin} onChange={(e) => set("notes", e.target.value)} aria-label={t("Notes")}
          placeholder={t("e.g. great for close-ups; struggles with hands")} />
      </Panel>
    </>
  );
}
