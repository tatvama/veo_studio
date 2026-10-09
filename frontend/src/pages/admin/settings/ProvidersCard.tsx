import { useQueryClient } from "@tanstack/react-query";
import { usd } from "../../../lib/format";
import { clsx } from "clsx";
import { KeyRound, Save, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import "../../../styles/settings.css";
import { Alert, Button, Input, Skeleton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import type { ProviderStatus } from "../../../lib/types";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { brandMark, brandName } from "../shared/brands";
import { SettingsCard } from "./controls";
import { StateTag, type StatusTone } from "./state";
import { useApiKeys } from "./useApiKeys";

const MODE: Record<ProviderStatus["mode"], { tone: StatusTone; word: string; title: string; live?: boolean; edge: string }> = {
  live: { tone: "ok", word: "Live", title: "Live", live: true, edge: "bg-ok" },
  mock: { tone: "warn", word: "Placeholder", title: "Mock — free placeholder", edge: "bg-warn" },
  missing: { tone: "bad", word: "Missing key", title: "Missing key", edge: "bg-bad" },
};
const SOURCE_LABEL: Record<string, string> = { admin: "Saved here", env: "From server .env file", missing: "No key" };

/** "$0.05", "$0.036", "$0.20": at least two decimals, up to three. */
function price(n: unknown): string | null {
  if (n === null || n === undefined || n === "") return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return usd(v, 3).replace(/(\.\d\d)0(?=\D|$)/g, "$1");
}
function flat(v: unknown): number[] {
  if (typeof v === "number") return [v];
  if (v && typeof v === "object") return Object.values(v).flatMap(flat);
  return [];
}

/** "Google Gemini (text, images, Veo…)" → "text, images, Veo…": the brand name already sits above, so show only what the service is for. */
function detailOf(label: string): string {
  const m = label.match(/^[^(]*\((.*)\)\s*$/);
  return m ? m[1] : label;
}

/** The unit prices that matter for each service, read from the price table in use (so overrides show up here). */
function costFacts(provider: string, prices: Record<string, any> | undefined, t: (s: string) => string): { k: string; v: string }[] {
  if (!prices) return [];
  const tts = (prices.tts_per_1k_chars ?? {}) as Record<string, number>;
  const out: { k: string; v: string }[] = [];
  const add = (k: string, v: string | null) => { if (v) out.push({ k: t(k), v }); };
  switch (provider) {
    case "gemini": {
      const vids = flat(prices.video_per_second);
      if (vids.length) add("Video / sec, from", price(Math.min(...vids)));
      add("Voice / 1k letters", price(tts.gemini));
      break;
    }
    case "elevenlabs":
      add("Voice / 1k letters", price(tts.elevenlabs));
      add("Voice changer / min", price((prices.sts_per_minute ?? {}).elevenlabs));
      break;
    case "sarvam":
      add("Voice / 1k letters", price(tts.sarvam));
      break;
    case "anthropic": {
      const claude = Object.entries((prices.text_per_million ?? {}) as Record<string, { in?: number; out?: number }>).find(([m]) => m.startsWith("claude"))?.[1];
      add("Chat / 1M tokens in", price(claude?.in));
      add("Chat / 1M tokens out", price(claude?.out));
      break;
    }
    case "sync": {
      const l = flat(prices.lipsync_per_second);
      if (l.length) {
        const lo = price(Math.min(...l)), hi = price(Math.max(...l));
        add("Lip-sync / sec", lo === hi ? lo : `${lo}–${hi}`);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** Which AI services are on, as an engine table: mode, key state, unit prices, and (for admins) a place to paste, replace or remove each key. */
export function ProvidersCard({ providers, isAdmin, index, prices }: { providers: ProviderStatus[]; isAdmin: boolean; index: number; prices?: Record<string, any> }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: keys, isLoading, isError, isFetching, refetch } = useApiKeys(isAdmin);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState("");  // BytePlus asset library: access key + secret, saved as "KEY:SECRET"
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProviderStatus | null>(null);
  const keyMap = useMemo(() => Object.fromEntries((keys ?? []).map((k) => [k.provider, k])), [keys]);
  const anyMock = providers.some((p) => p.mode === "mock");
  const anyMissing = providers.some((p) => p.mode === "missing");

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["api-keys"] }),
    qc.invalidateQueries({ queryKey: ["settings"] }),
    qc.invalidateQueries({ queryKey: ["providers"] }),
  ]);

  const saveKey = async (p: ProviderStatus) => {
    const pair = p.provider === "byteplus_iam";
    if (pair && (!value.trim() || !secret.trim())) return void toast.error(t("Paste both the Access Key ID and the Secret Access Key"));
    const key = pair ? `${value.trim()}:${secret.trim()}` : value.trim();
    if (key.length < 8) return void toast.error(t("That key looks too short — paste the full key"));
    setBusy(p.provider);
    try {
      await api.put(`/api/settings/api-keys/${p.provider}`, { key });
      await refresh();
      setEditing(null);
      setValue("");
      setSecret("");
      toast.success(t("{name} key saved", { name: brandName(p.provider) }), { description: t("New generations will use the real service.") });
    } catch {
      /* already toasted */
    } finally {
      setBusy(null);
    }
  };

  const removeKey = async () => {
    const p = confirmRemove;
    if (!p) return;
    setBusy(p.provider);
    try {
      await api.del(`/api/settings/api-keys/${p.provider}`);
      await refresh();
      toast.success(t("{name} key removed", { name: brandName(p.provider) }));
      setConfirmRemove(null);
    } catch {
      /* already toasted */
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsCard id="keys" index={index} icon={<KeyRound className="size-4" />} title={t("AI services & API keys")}
      sub={isAdmin ? t("Keys are stored encrypted. A key saved here wins over the server .env file.") : t("Which AI services are switched on. Only admins can see or change keys.")}>
      <div className="mb-4 space-y-2.5 empty:hidden">
        {anyMock && (
          <Alert tone="accent" icon={<Sparkles className="size-4" />}>
            <b className="font-medium text-ink">{t("Mock mode")}</b> {t("means the studio makes free placeholder images, video and voices so you can try every step. Nothing is charged. Add a real key to get real output (and real costs).")}
          </Alert>
        )}
        {anyMissing && (
          <Alert tone="bad" icon={<TriangleAlert className="size-4" />}>
            <b className="font-medium text-ink">{t("Missing key")}</b> {t("means that service is off until a key is added.")}
          </Alert>
        )}
        {isAdmin && isError && (
          <Alert tone="warn" action={<Button size="sm" variant="outline" loading={isFetching} onClick={() => void refetch()}>{t("Try again")}</Button>}>
            {t("Couldn't read which keys are saved.")}
          </Alert>
        )}
      </div>

      {providers.length === 0 ? (
        <div className="cx-block px-4 py-8 text-center text-sm text-mute">{t("No AI services are reported yet.")}</div>
      ) : (
        <div className="cx-block overflow-hidden">
          <div aria-hidden data-readonly={isAdmin ? undefined : "true"} className="st-engine-head eyebrow">
            <span>{t("Engine")}</span><span>{t("Mode")}</span>{isAdmin && <span>{t("Key")}</span>}<span>{t("Unit prices")}</span>{isAdmin && <span />}
          </div>
          <ul>
            {providers.map((p) => {
              const k = keyMap[p.provider];
              const mode = MODE[p.mode] ?? MODE.missing;
              const isEditing = editing === p.provider;
              const facts = costFacts(p.provider, prices, t);
              return (
                <li key={p.provider} data-mode={p.mode} className="relative border-t border-line px-4 py-3.5 first:border-t-0">
                  <span aria-hidden className={clsx("absolute inset-y-0 left-0 w-0.5", mode.edge)} />
                  <div className="st-engine-grid" data-readonly={isAdmin ? undefined : "true"}>
                    <div className="st-eng-main flex min-w-0 items-center gap-3">
                      <span aria-hidden className="mono grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-xs font-semibold uppercase text-mute ring-1 ring-inset ring-line">{brandMark(p.provider)}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{brandName(p.provider)}</p>
                        <p title={p.label} className="mt-0.5 text-xs text-mute first-letter:uppercase">{detailOf(p.label)}</p>
                      </div>
                    </div>

                    <div className="min-w-0">
                      <p className="eyebrow st-eng-label mb-1.5">{t("Mode")}</p>
                      <StateTag tone={mode.tone} live={mode.live} title={t(mode.title)} className="text-xs">{t(mode.word)}</StateTag>
                    </div>

                    {isAdmin && (
                      <div className="min-w-0">
                        <p className="eyebrow st-eng-label mb-1.5">{t("Key")}</p>
                        {isLoading ? <Skeleton className="h-8 w-28" /> : k ? (
                          <div className="text-xs">
                            <p className={clsx(k.source === "missing" ? "text-dim" : "text-mute")}>{t(SOURCE_LABEL[k.source] ?? k.source)}</p>
                            {k.masked && <p className="mono mt-0.5 truncate text-dim">{k.masked}</p>}
                          </div>
                        ) : <span className="text-xs text-dim">—</span>}
                      </div>
                    )}

                    <div className="st-eng-price min-w-0">
                      <p className="eyebrow st-eng-label mb-1.5">{t("Unit prices")}</p>
                      {facts.length ? (
                        <dl className="space-y-0.5">
                          {facts.map((f) => (
                            <div key={f.k} className="flex items-baseline justify-between gap-3">
                              <dt className="min-w-0 text-2xs text-dim">{f.k}</dt>
                              <dd className="mono shrink-0 text-xs text-money">{f.v}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : ["fal", "openrouter", "byteplus"].includes(p.provider) ? (
                        <p className="text-xs text-mute">{t("Priced per model.")} <Link to="/models" className="font-medium text-accent-ink hover:underline">{t("Open Model Hub")}</Link></p>
                      ) : <span className="text-xs text-dim">—</span>}
                    </div>

                    {isAdmin && (
                      <div className="st-eng-act flex flex-wrap items-center gap-2 @[56rem]:justify-end">
                        {!isEditing && (
                          <Button size="sm" variant="outline" className="max-sm:h-10" icon={<KeyRound className="size-3.5" />} onClick={() => { setEditing(p.provider); setValue(""); setSecret(""); }}>
                            {k && k.source !== "missing" ? t("Replace key") : t("Set key")}
                          </Button>
                        )}
                        {k?.source === "admin" && !isEditing && (
                          <Button size="sm" variant="danger" className="max-sm:h-10" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmRemove(p)}>{t("Remove")}</Button>
                        )}
                      </div>
                    )}
                  </div>

                  <AnimatePresence initial={false}>
                    {isAdmin && isEditing && (
                      <motion.form key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden"
                        onSubmit={(e) => { e.preventDefault(); void saveKey(p); }}>
                        <div className="cx-block mt-3 flex flex-wrap gap-2 p-2.5">
                          {p.provider === "byteplus_iam" ? (
                            <>
                              <Input autoFocus autoComplete="off" spellCheck={false} className="min-w-[180px] flex-1 font-mono max-sm:h-10"
                                aria-label={t("Access Key ID")} placeholder={t("Access Key ID (AKLT…)")} value={value} onChange={(e) => setValue(e.target.value)} />
                              <Input type="password" autoComplete="off" className="min-w-[180px] flex-1 font-mono max-sm:h-10"
                                aria-label={t("Secret Access Key")} placeholder={t("Secret Access Key")} value={secret} onChange={(e) => setSecret(e.target.value)} />
                            </>
                          ) : (
                            <Input type="password" autoFocus autoComplete="off" className="min-w-[220px] flex-1 font-mono max-sm:h-10"
                              aria-label={t("Paste the {name} API key", { name: brandName(p.provider) })}
                              placeholder={t("Paste the {name} API key", { name: brandName(p.provider) })} value={value} onChange={(e) => setValue(e.target.value)} />
                          )}
                          <Button type="submit" variant="primary" className="max-sm:h-10" icon={<Save className="size-4" />} loading={busy === p.provider}>{t("Save key")}</Button>
                          <Button type="button" variant="ghost" className="max-sm:h-10" icon={<X className="size-4" />} onClick={() => { setEditing(null); setValue(""); setSecret(""); }}>{t("Cancel")}</Button>
                        </div>
                      </motion.form>
                    )}
                  </AnimatePresence>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <ConfirmDialog open={!!confirmRemove} onClose={() => setConfirmRemove(null)} busy={!!busy && !!confirmRemove} title={t("Remove this API key?")}
        confirmLabel={t("Remove key")} icon={<Trash2 className="size-4" />} onConfirm={removeKey}>
        {confirmRemove && t("Remove the saved {name} key? If the server .env file has a key it will be used instead; otherwise this service switches to mock or off.", { name: brandName(confirmRemove.provider) })}
      </ConfirmDialog>
    </SettingsCard>
  );
}
