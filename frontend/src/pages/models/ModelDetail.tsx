import { clsx } from "clsx";
import {
  AlertTriangle, Check, Copy, ExternalLink, Info, Layers, ListTree, Lock, Settings2, Star, Tags, Trophy, Wallet, X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  MODE_LABELS, PRICE_UNITS, TASK_LABELS, TIERS, TIER_LABELS, dateText, durationsText, visibleTags,
} from "../../components/hub/util";
import { Alert, Badge, Button, Field, IconButton, Input, Segmented, Select, Skeleton, Tabs, Textarea } from "../../components/ui";
import { ago, usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useModel } from "../../lib/queries";
import type { AIModel } from "../../lib/types";
import { providerLabel } from "./catalogData";
import { CapIcons, ModelThumb, ProviderBadge, StatusBadge, TASK_ICON, useModelPatch, type ModelPatchBody } from "./ModelCard";
import { SlideOver } from "./SlideOver";

import { Pill } from "../admin/shared/Pill";
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

/** Slide-over with everything about one engine: specs, price, parameter mapping and (for admins) team settings. */
export default function ModelDetail({ model, open, admin, onClose }: { model: AIModel; open: boolean; admin: boolean; onClose: () => void }) {
  const guard = useRef<(() => boolean) | null>(null);
  const requestClose = () => { if (guard.current?.()) return; onClose(); };
  return (
    <SlideOver open={open} onClose={requestClose} label={model.display_name || model.endpoint}>
      <DetailBody key={model.id} model={model} admin={admin} requestClose={requestClose} onClose={onClose} guard={guard} />
    </SlideOver>
  );
}

function DetailBody({ model, admin, requestClose, onClose, guard }: {
  model: AIModel; admin: boolean; requestClose: () => void; onClose: () => void; guard: React.MutableRefObject<(() => boolean) | null>;
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
      <div className="absolute right-3 top-3 z-20">
        <IconButton title={t("Close")} shortcut="Esc" tipSide="left" onClick={requestClose} className="bg-black/55 text-white backdrop-blur-sm hover:bg-black/75 hover:text-white">
          <X className="size-4" />
        </IconButton>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* hero */}
        <div className="relative">
          <ModelThumb m={m} aspect="aspect-[16/7]" className="max-h-52 w-full" iconClass="size-14" iconAt="right" eager />
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-panel via-panel/30 to-transparent" />
          <div className="absolute inset-x-5 bottom-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={m.status} />
              <ProviderBadge m={m} />
              <Badge><TaskIcon className="size-3" />{t(TASK_LABELS[m.task] ?? m.task)}</Badge>
              {m.builtin && <Pill tone="info">{t("built-in")}</Pill>}
              {m.tier && <Badge>{t(TIER_LABELS[m.tier] ?? m.tier)}</Badge>}
            </div>
            <h3 className="mt-1.5 truncate text-xl font-semibold tracking-tight" title={name}>{name}</h3>
            <button type="button" onClick={copyId} title={t("Copy engine id")}
              className="mt-0.5 flex max-w-full items-center gap-1.5 rounded font-mono text-2xs text-mute transition-colors hover:text-ink">
              <span className="truncate">{m.id}</span>
              {copied ? <Check className="size-3 shrink-0 text-ok" /> : <Copy className="size-3 shrink-0" />}
            </button>
          </div>
        </div>

        <div data-tabs-sticky className="sticky top-0 z-10 bg-panel/95 px-5 pt-1 backdrop-blur">
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: "overview", label: t("Overview") },
            { value: "params", label: <span className="flex items-center gap-1.5">{t("Parameters")}{paramsDirty && <span className="size-1.5 rounded-full bg-warn" />}</span>, count: slots.length || undefined },
            { value: "team", label: <span className="flex items-center gap-1.5">{t("Team settings")}{teamDirty && <span className="size-1.5 rounded-full bg-warn" />}</span> },
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
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-amber-300"><AlertTriangle className="size-4 shrink-0" />{t("Discard unsaved changes to this model?")}</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClose(false)}>{t("Keep editing")}</Button>
              <Button size="sm" variant="danger" onClick={onClose}>{t("Discard & close")}</Button>
            </motion.div>
          ) : admin ? (
            <motion.div key="actions" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}
              className="flex items-center gap-2">
              <span className={clsx("flex items-center gap-1.5 text-xs transition-opacity", dirty ? "text-amber-300 opacity-100" : "text-dim opacity-100")}>
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

function Section({ icon, title, hint, children, className }: { icon: ReactNode; title: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-xl border border-line bg-raised/30 p-4", className)}>
      <h4 className="flex items-center gap-2 text-sm font-semibold"><span className="text-mute">{icon}</span>{title}</h4>
      {hint && <p className="mt-0.5 text-xs text-mute">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  if (v === "" || v == null || v === false) return null;
  return (<><dt className="text-xs text-dim">{k}</dt><dd className="min-w-0 break-words text-sm text-ink">{v}</dd></>);
}

function Tile({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-raised/40 px-3 py-2.5">
      <p className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-dim">{icon}{label}</p>
      <p className="mt-1 truncate text-lg font-semibold leading-none tabular-nums tracking-tight">{value}</p>
      {sub && <p className="mt-1 truncate text-2xs text-dim">{sub}</p>}
    </div>
  );
}

function Overview({ m }: { m: AIModel }) {
  const t = useT();
  const caps = m.capabilities ?? {};
  const tags = visibleTags(m.tags);
  const total = (m.uses || 0) + (m.failures || 0);
  const failPct = total ? Math.round(((m.failures || 0) / total) * 100) : 0;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label={t("8 s clip")} value={m.est_8s_usd != null ? usd(m.est_8s_usd) : "—"} sub={m.price_label} icon={<Wallet className="size-3" />} />
        <Tile label={t("Rating")} value={m.rating != null ? m.rating.toFixed(1) : "—"} sub={m.rating != null ? t("out of 5") : t("Not rated yet")} icon={<Star className="size-3" />} />
        <Tile label={t("Uses")} value={(m.uses || 0).toLocaleString()}
          sub={(m.failures || 0) > 0 ? <span className={failPct >= 20 ? "text-red-300" : "text-amber-300"}>{t("{n} failed", { n: m.failures })} ({failPct}%)</span> : t("No failures")} />
        <Tile label={t("Wins")} value={(m.wins || 0).toLocaleString()} sub={t("Shootout wins")} icon={<Trophy className="size-3" />} />
      </div>

      {m.description && <p className="text-sm leading-relaxed text-mute">{m.description}</p>}

      <Section icon={<Layers className="size-4" />} title={t("Capabilities")}>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {(caps.modes ?? []).map((x) => <Badge key={x} title={x}>{t(MODE_LABELS[x] ?? x)}</Badge>)}
            {!(caps.modes ?? []).length && <span className="text-sm text-dim">{t("No modes detected")}</span>}
          </div>
          <CapIcons m={m} />
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
            <Fact k={t("Durations")} v={durationsText(caps.durations)} />
            <Fact k={t("Resolutions")} v={(caps.resolutions ?? []).join(", ")} />
            <Fact k={t("Aspect ratios")} v={(caps.aspects ?? []).join(", ")} />
            <Fact k={t("Reference images")} v={caps.max_refs ? String(caps.max_refs) : ""} />
            <Fact k={t("Native audio")} v={caps.native_audio ? t("Yes") : t("No")} />
            <Fact k={t("Speaks lines")} v={caps.speech_in_video ? t("Yes: voice and lips in one pass") : t("No")} />
            <Fact k={t("Audio-driven")} v={caps.audio_driven ? t("Yes: animates from a voice track") : t("No")} />
            <Fact k={t("Trained identity")} v={caps.lora_input ? t("Yes: accepts LoRA weights") : t("No")} />
            <Fact k={t("Lip-sync to audio")} v={caps.lipsync_to_audio ? t("Yes") : t("No")} />
          </dl>
        </div>
      </Section>

      <Section icon={<Info className="size-4" />} title={t("Details")}>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
          <Fact k={t("Maker")} v={m.maker} />
          <Fact k={t("Family")} v={m.family} />
          <Fact k={t("Endpoint")} v={<span className="break-all font-mono text-xs">{m.endpoint}</span>} />
          <Fact k={t("Provider")} v={`${providerLabel(m.provider)} · ${m.provider_mode === "live" ? t("live") : m.provider_mode === "mock" ? t("mock mode") : t("no API key")}`} />
          <Fact k={t("Tier")} v={m.tier ? t(TIER_LABELS[m.tier] ?? m.tier) : ""} />
          <Fact k={t("Price")} v={`${m.price_label}${m.price_source ? ` · ${t(m.price_source)}` : ""}`} />
          <Fact k={t("Released")} v={dateText(m.released_at)} />
          <Fact k={t("First seen")} v={m.first_seen ? `${dateText(m.first_seen)} · ${ago(m.first_seen)}` : ""} />
        </dl>
      </Section>

      {tags.length > 0 && (
        <Section icon={<Tags className="size-4" />} title={t("Tags")}>
          <div className="flex flex-wrap gap-1">{tags.map((x) => <Badge key={x}>{x}</Badge>)}</div>
        </Section>
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
      <Section icon={<ListTree className="size-4" />} title={t("Parameter mapping")} hint={t("How our generic request (prompt, first frame, audio…) is mapped onto this engine's inputs.")}>
        {loading ? (
          <div className="space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-3/4" /></div>
        ) : !slots.length ? (
          <p className="flex items-center gap-1.5 text-sm text-dim"><Info className="size-4 shrink-0" />
            {m.builtin ? t("Built-in engine — parameters are handled by the native integration.") : t("No schema mapped yet. Run a sync to fetch it.")}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-xs">
              <thead className="bg-raised text-dim">
                <tr>
                  <th className="px-2.5 py-2 font-medium">{t("Slot")}</th><th className="px-2.5 font-medium">{t("Parameter")}</th>
                  <th className="px-2.5 font-medium">{t("Type")}</th><th className="px-2.5 font-medium">{t("Values")}</th><th className="px-2.5 font-medium">{t("Default")}</th>
                </tr>
              </thead>
              <tbody>
                {slots.map(([slot, s]) => (
                  <tr key={slot} className="border-t border-line/70">
                    <td className="px-2.5 py-2 font-mono text-mute">{slot}</td>
                    <td className="px-2.5 font-mono">{s.name}{s.required && <span className="ml-0.5 text-red-300" title={t("Required")}>*</span>}</td>
                    <td className="px-2.5 text-dim">{(s.types ?? []).join(" | ")}</td>
                    <td className="max-w-[140px] truncate px-2.5 text-dim" title={s.enum?.join(", ")}>
                      {s.enum?.length ? s.enum.slice(0, 6).join(", ") + (s.enum.length > 6 ? "…" : "") : s.min != null || s.max != null ? `${s.min ?? ""}–${s.max ?? ""}` : s.max_items ? `≤${s.max_items}` : ""}
                    </td>
                    <td className="max-w-[90px] truncate px-2.5 text-dim">{s.default != null ? String(s.default) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!pm?.required_defaults && Object.keys(pm.required_defaults).length > 0 && (
          <p className="mt-2 text-xs text-dim">{t("Required inputs filled with defaults")}: <span className="font-mono">{Object.keys(pm.required_defaults).join(", ")}</span></p>
        )}
        {!!m.unmapped_required?.length && (
          <Alert tone="warn" className="mt-3">
            {t("Required inputs we can't fill automatically: {fields}. Add them under fixed_args below.", { fields: m.unmapped_required.join(", ") })}
          </Alert>
        )}
        {!!pm?.property_names?.length && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-mute hover:text-ink">{t("All {n} inputs", { n: pm.property_names.length })}</summary>
            <p className="mt-1.5 break-words font-mono text-dim">{pm.property_names.join(", ")}</p>
          </details>
        )}
      </Section>

      <Section icon={<Settings2 className="size-4" />} title={t("Parameter overrides")}>
        <Field label={t("Parameter overrides (JSON)")}
          hint={parsed.ok
            ? <span>{t("Extra fixed arguments sent with every request, e.g.")} <code className="font-mono">{`{"fixed_args": {"enable_safety_checker": false}}`}</code></span>
            : <span className="text-red-300">{t("Invalid JSON")}: {parsed.error}</span>}>
          <Textarea rows={7} spellCheck={false} value={form.overrides} disabled={!admin} onChange={(e) => set("overrides", e.target.value)}
            className={clsx("font-mono text-xs", !parsed.ok && "border-bad/60 focus:border-bad")} />
        </Field>
      </Section>
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
      <Section icon={<Settings2 className="size-4" />} title={t("Availability")} hint={t("Enabled engines can be picked for shots and used by the routing policy.")}>
        {m.status === "retired" ? <p className="text-sm text-dim">{t("Retired — no longer listed by the provider.")}</p> : (
          <div className={clsx(!admin && "pointer-events-none opacity-60")}>
            <Segmented value={form.status} onChange={(v) => set("status", v)} aria-label={t("Status")} options={[
              { value: "enabled", label: t("Enabled") }, { value: "disabled", label: t("Disabled") }, { value: "new", label: t("New") },
            ]} />
          </div>
        )}
      </Section>

      <Section icon={<Wallet className="size-4" />} title={t("Quality and price")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Tier")}>
            <Select value={form.tier} disabled={!admin} onChange={(e) => set("tier", e.target.value)}>
              <option value="">—</option>
              {TIERS.map((x) => <option key={x} value={x}>{t(TIER_LABELS[x])}</option>)}
            </Select>
          </Field>
          <Field label={t("Team rating (0–5)")} hint={ratingBad ? <span className="text-red-300">{t("Enter a number from 0 to 5")}</span> : undefined}>
            <Input type="number" step="0.5" min={0} max={5} value={form.rating} disabled={!admin} onChange={(e) => set("rating", e.target.value)} placeholder="—" />
          </Field>
          <Field label={t("Price override (USD)")} hint={priceBad ? <span className="text-red-300">{t("Enter a positive number")}</span> : t("Leave empty to use the live / catalog price.")}>
            <Input type="number" step="0.001" min={0} value={form.price_usd} disabled={!admin} onChange={(e) => set("price_usd", e.target.value)} placeholder="—" />
          </Field>
          <Field label={t("Price unit")}>
            <Select value={form.price_unit} disabled={!admin} onChange={(e) => set("price_unit", e.target.value)}>
              <option value="">—</option>
              {[...new Set([...PRICE_UNITS, ...(form.price_unit ? [form.price_unit] : [])])].map((u) => <option key={u} value={u}>{t("per {unit}", { unit: u })}</option>)}
            </Select>
          </Field>
        </div>
      </Section>

      <Section icon={<Info className="size-4" />} title={t("Notes")}>
        <Textarea rows={3} value={form.notes} disabled={!admin} onChange={(e) => set("notes", e.target.value)} aria-label={t("Notes")}
          placeholder={t("e.g. great for close-ups; struggles with hands")} />
      </Section>
    </>
  );
}
