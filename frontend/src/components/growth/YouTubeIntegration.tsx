/** Settings → Integrations: connect / disconnect YouTube channels for publishing + analytics. */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { CircleCheck, ExternalLink, MonitorPlay, Plug, Unplug } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "../../pages/admin/shared/ConfirmDialog";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useIntegrations } from "../../lib/queries";
import { ROLE_RANK, type Role } from "../../lib/types";
import { Avatar, Badge, Button, Skeleton } from "../ui";
import { agoT, CopyButton, fmtDateTime, listItem } from "./common";

import { Pill } from "../../pages/admin/shared/Pill";
function Step({ n, last, children }: { n: number; last?: boolean; children: React.ReactNode }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span aria-hidden className="absolute left-[11px] top-6 h-[calc(100%-1.25rem)] w-px bg-line" />}
      <span className="relative grid size-6 shrink-0 place-items-center rounded-full border border-line bg-raised text-2xs font-semibold tabular-nums text-mute">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5 text-sm text-mute">{children}</div>
    </li>
  );
}

export default function YouTubeIntegration({ role }: { role: Role }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useIntegrations();
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ id: number; name: string } | null>(null);
  const canConnect = ROLE_RANK[role] >= ROLE_RANK.producer;
  const canRemove = role === "admin";
  const accounts = (data?.accounts ?? []).filter((a) => a.provider === "youtube");
  const others = (data?.accounts ?? []).filter((a) => a.provider !== "youtube");
  // the exact address the server sends to Google (from PUBLIC_BASE_URL), so a copied value always matches
  const callback = data?.redirect_uri || `${window.location.origin}/api/integrations/youtube/callback`;

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await api.get<{ url: string }>("/api/integrations/youtube/connect");
      toast.message(t("Opening Google to connect your channel…"));
      window.location.assign(r.url);
    } catch {
      setConnecting(false); /* toasted by api */
    }
  };

  const remove = async () => {
    if (!confirm) return;
    setRemoving(confirm.id);
    try {
      await api.del(`/api/integrations/${confirm.id}`);
      await qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.success(t("{name} disconnected", { name: confirm.name }));
      setConfirm(null);
    } catch {
      /* toasted */
    } finally {
      setRemoving(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-xl" />
        <div className="flex-1 space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-72 max-w-full" /></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bad/12 text-bad ring-1 ring-inset ring-bad/20"><MonitorPlay className="size-5" /></span>
        <div className="min-w-0 flex-1 basis-60">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            YouTube
            {data?.youtube_ready ? (accounts.length ? <Pill tone="ok" dot>{t("Connected")}</Pill> : <Badge>{t("Not connected")}</Badge>)
              : <Pill tone="warn" dot>{t("Needs setup")}</Pill>}
          </p>
          <p className="mt-0.5 text-xs text-mute">{t("Upload finished renders and pull views and retention back into the hook writer.")}</p>
        </div>
        {data?.youtube_ready && canConnect && (
          <Button size="sm" variant={accounts.length ? "outline" : "primary"} icon={<Plug className="size-3.5" />} loading={connecting} onClick={connect}>
            {accounts.length ? t("Connect another channel") : t("Connect channel")}
          </Button>
        )}
      </div>

      {!data?.youtube_ready && (
        <div className="rounded-xl border border-warn/30 bg-warn/6 p-4">
          <p className="mb-3 text-sm font-medium">{t("YouTube needs a Google OAuth client on the server first.")}</p>
          <ol>
            <Step n={1}>{t("In Google Cloud Console, enable the YouTube Data API v3 and the YouTube Analytics API.")}</Step>
            <Step n={2}>
              {t("Create an OAuth client (type: Web application) and add this authorised redirect URI:")}
              <span className="mt-2 flex items-center gap-1 rounded-lg border border-line bg-bg px-2 py-1">
                <code className="min-w-0 flex-1 truncate font-mono text-2xs text-ink" title={callback}>{callback}</code>
                <CopyButton size="icon" text={callback} what={t("Redirect URI")} />
              </span>
              <span className="mt-1.5 block text-xs text-dim">{t("It must start with the server's PUBLIC_BASE_URL — use that address if it differs from this one.")}</span>
            </Step>
            <Step n={3}>{t("Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the server's .env file and restart the studio.")}</Step>
            <Step n={4} last>{t("While the OAuth consent screen is in Testing mode, add the channel owner's Google account as a test user.")}</Step>
          </ol>
        </div>
      )}

      {data?.youtube_ready && !canConnect && !accounts.length && (
        <p className="text-xs text-dim">{t("A producer or admin can connect a channel.")}</p>
      )}

      {!!accounts.length && (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          <AnimatePresence initial={false}>
            {[...accounts, ...others].map((a) => {
              const name = a.account_name || a.account_id || a.provider;
              return (
                <motion.li key={a.id} layout {...listItem} className="flex items-center gap-3 bg-panel px-3.5 py-2.5">
                  <span className="relative shrink-0">
                    <Avatar name={name} size={34} />
                    <CircleCheck className="absolute -bottom-1 -right-1 size-4 rounded-full bg-panel text-ok" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{name}</p>
                    <p className="truncate text-2xs text-dim" title={fmtDateTime(a.created_at)}>
                      {a.provider} · {a.account_id ? `${a.account_id} · ` : ""}{t("connected {when}", { when: agoT(a.created_at) })}
                    </p>
                  </div>
                  {a.provider === "youtube" && a.account_id && (
                    <a href={`https://www.youtube.com/channel/${a.account_id}`} target="_blank" rel="noreferrer" aria-label={t("Open the channel on YouTube")} title={t("Open the channel on YouTube")}
                      className="grid size-8 place-items-center rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink"><ExternalLink className="size-4" /></a>
                  )}
                  {canRemove && (
                    <Button size="sm" variant="ghost" icon={<Unplug className="size-3.5" />} loading={removing === a.id} className={clsx("hover:text-bad")}
                      onClick={() => setConfirm({ id: a.id, name: a.account_name || a.provider })}>{t("Disconnect")}</Button>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} busy={removing !== null} title={t("Disconnect this channel?")}
        confirmLabel={t("Disconnect")} icon={<Unplug className="size-4" />} onConfirm={remove}>
        {confirm && t("Disconnect {name}? Publishing and analytics for this channel stop until it's connected again.", { name: confirm.name })}
      </ConfirmDialog>
    </div>
  );
}
