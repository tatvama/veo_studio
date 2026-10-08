import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { KeyRound, Save, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Notice } from "../../../components/growth/common";
import { Button, Input, Skeleton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import type { ProviderStatus } from "../../../lib/types";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { brandMark, brandName } from "../shared/brands";
import { SettingsCard } from "./controls";

import { Pill } from "../shared/Pill";
interface ApiKeyRow { provider: string; source: "admin" | "env" | "missing"; masked: string }

const MODE_BADGE: Record<ProviderStatus["mode"], { tone: "ok" | "warn" | "bad"; label: string }> = {
  live: { tone: "ok", label: "Live" },
  mock: { tone: "warn", label: "Mock — free placeholder" },
  missing: { tone: "bad", label: "Missing key" },
};
const SOURCE_LABEL: Record<string, string> = { admin: "Saved here", env: "From server .env file", missing: "No key" };

/** Which AI services are on, and (for admins) a place to paste, replace or remove each API key. */
export function ProvidersCard({ providers, isAdmin, index }: { providers: ProviderStatus[]; isAdmin: boolean; index: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: keys, isLoading } = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.get<ApiKeyRow[]>("/api/settings/api-keys"),
    enabled: isAdmin,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
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
    const key = value.trim();
    if (key.length < 8) return void toast.error(t("That key looks too short — paste the full key"));
    setBusy(p.provider);
    try {
      await api.put(`/api/settings/api-keys/${p.provider}`, { key });
      await refresh();
      setEditing(null);
      setValue("");
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
      {anyMock && (
        <Notice tone="accent" icon={<Sparkles className="mt-0.5 size-4 shrink-0 text-accent-ink" />} className="mb-3">
          <b>{t("Mock mode")}</b> {t("means the studio makes free placeholder images, video and voices so you can try every step. Nothing is charged. Add a real key to get real output (and real costs).")}
        </Notice>
      )}
      {anyMissing && (
        <Notice tone="bad" icon={<TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" />} className="mb-3">
          <b>{t("Missing key")}</b> {t("means that service is off until a key is added.")}
        </Notice>
      )}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {providers.map((p) => {
          const k = keyMap[p.provider];
          const mode = MODE_BADGE[p.mode] ?? MODE_BADGE.missing;
          const isEditing = editing === p.provider;
          return (
            <li key={p.provider} className="bg-panel px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-xs font-semibold uppercase text-mute ring-1 ring-inset ring-line">{brandMark(p.provider)}</span>
                <div className="min-w-0 flex-1 basis-48">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span>{brandName(p.provider)}</span>
                    <Pill tone={mode.tone} dot>{t(mode.label)}</Pill>
                  </p>
                  <p className="mt-0.5 text-xs text-mute">{p.label}</p>
                </div>
                {isAdmin && (
                  <div className="flex flex-wrap items-center gap-3">
                    {isLoading ? <Skeleton className="h-8 w-28" /> : k && (
                      <div className="text-right text-xs">
                        <p className={clsx(k.source === "missing" ? "text-dim" : "text-mute")}>{t(SOURCE_LABEL[k.source] ?? k.source)}</p>
                        {k.masked && <p className="font-mono text-dim">{k.masked}</p>}
                      </div>
                    )}
                    {!isEditing && (
                      <Button size="sm" variant="outline" icon={<KeyRound className="size-3.5" />} onClick={() => { setEditing(p.provider); setValue(""); }}>
                        {k && k.source !== "missing" ? t("Replace key") : t("Set key")}
                      </Button>
                    )}
                    {k?.source === "admin" && !isEditing && (
                      <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmRemove(p)}>{t("Remove")}</Button>
                    )}
                  </div>
                )}
              </div>
              <AnimatePresence initial={false}>
                {isAdmin && isEditing && (
                  <motion.form key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden"
                    onSubmit={(e) => { e.preventDefault(); void saveKey(p); }}>
                    <div className="flex flex-wrap gap-2 pt-3">
                      <Input type="password" autoFocus autoComplete="off" className="min-w-[240px] flex-1 font-mono"
                        aria-label={t("Paste the {name} API key", { name: brandName(p.provider) })}
                        placeholder={t("Paste the {name} API key", { name: brandName(p.provider) })} value={value} onChange={(e) => setValue(e.target.value)} />
                      <Button type="submit" variant="primary" icon={<Save className="size-4" />} loading={busy === p.provider}>{t("Save key")}</Button>
                      <Button type="button" variant="ghost" icon={<X className="size-4" />} onClick={() => { setEditing(null); setValue(""); }}>{t("Cancel")}</Button>
                    </div>
                  </motion.form>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog open={!!confirmRemove} onClose={() => setConfirmRemove(null)} busy={!!busy && !!confirmRemove} title={t("Remove this API key?")}
        confirmLabel={t("Remove key")} icon={<Trash2 className="size-4" />} onConfirm={removeKey}>
        {confirmRemove && t("Remove the saved {name} key? If the server .env file has a key it will be used instead; otherwise this service switches to mock or off.", { name: brandName(confirmRemove.provider) })}
      </ConfirmDialog>
    </SettingsCard>
  );
}
