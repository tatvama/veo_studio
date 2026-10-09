/** Settings → Integrations: connect / disconnect YouTube channels for publishing + analytics. Also the Export page's channel panel. */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BarChart3, ExternalLink, Eye, MonitorPlay, Plug, Unplug } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import "../../styles/console.css";
import { ConfirmDialog } from "../../pages/admin/shared/ConfirmDialog";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useIntegrations } from "../../lib/queries";
import { ROLE_RANK, type Role } from "../../lib/types";
import { Avatar, Badge, Button, Panel, Skeleton, StatusDot } from "../ui";
import { agoT, CopyButton, fmtDateTime, listItem, platformLabel } from "./common";
import type { ExportMetrics, RenderRow } from "./ExportCard";

import { Pill } from "../../pages/admin/shared/Pill";
function Step({ n, last, children }: { n: number; last?: boolean; children: React.ReactNode }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span aria-hidden className="absolute left-[11px] top-6 h-[calc(100%-1.25rem)] w-px bg-line" />}
      <span className="mono relative grid size-6 shrink-0 place-items-center rounded-md border border-line bg-raised text-2xs font-medium text-mute">{n}</span>
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
        <Skeleton className="size-10 rounded-lg" />
        <div className="flex-1 space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-72 max-w-full" /></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="hud grid size-10 shrink-0 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent-ink"><MonitorPlay className="size-5" /></span>
        <div className="min-w-0 flex-1 basis-60">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            YouTube
            {data?.youtube_ready ? (accounts.length ? <Pill tone="ok" dot>{t("Connected")}</Pill> : <Badge>{t("Not connected")}</Badge>)
              : <Pill tone="warn" dot>{t("Needs setup")}</Pill>}
          </p>
          <p className="mt-0.5 text-xs text-mute">{t("Upload finished renders and pull views and retention back into the hook writer.")}</p>
        </div>
        {data?.youtube_ready && canConnect && (
          <Button size="sm" variant={accounts.length ? "outline" : "primary"} className="max-sm:h-10" icon={<Plug className="size-3.5" />} loading={connecting} onClick={connect}>
            {accounts.length ? t("Connect another channel") : t("Connect channel")}
          </Button>
        )}
      </div>

      {!data?.youtube_ready && (
        <div className="cx-block p-4" data-tone="money">
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
        <ul className="cx-block divide-y divide-line overflow-hidden">
          <AnimatePresence initial={false}>
            {[...accounts, ...others].map((a) => {
              const name = a.account_name || a.account_id || a.provider;
              return (
                <motion.li key={a.id} layout {...listItem} className="flex items-center gap-3 bg-panel px-3.5 py-2.5">
                  <span className="relative shrink-0">
                    <Avatar name={name} size={34} />
                    <StatusDot tone="ok" live className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-panel" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{name}</p>
                    <p className="mono truncate text-2xs text-dim" title={fmtDateTime(a.created_at)}>
                      {a.provider} · {a.account_id ? `${a.account_id} · ` : ""}{t("connected {when}", { when: agoT(a.created_at) })}
                    </p>
                  </div>
                  {a.provider === "youtube" && a.account_id && (
                    <a href={`https://www.youtube.com/channel/${a.account_id}`} target="_blank" rel="noreferrer" aria-label={t("Open the channel on YouTube")} title={t("Open the channel on YouTube")}
                      className="grid size-8 place-items-center rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink max-sm:size-10"><ExternalLink className="size-4" /></a>
                  )}
                  {canRemove && (
                    <Button size="sm" variant="ghost" icon={<Unplug className="size-3.5" />} loading={removing === a.id} className={clsx("hover:text-bad max-sm:h-10")}
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

/** The Export page's channel panel: connection state, the connected channel(s) and a publish history with views. */
export function YouTubePanel({ exports, metrics, canProduce, refreshing, onRefreshMetrics, className }: {
  exports: RenderRow[]; metrics: Record<number, ExportMetrics>; canProduce: boolean; refreshing?: boolean; onRefreshMetrics?: () => void; className?: string;
}) {
  const t = useT();
  const { data, isLoading } = useIntegrations();
  const accounts = (data?.accounts ?? []).filter((a) => a.provider === "youtube");
  const connected = !!data?.youtube_ready && accounts.length > 0;

  const history = exports
    .flatMap((x) => Object.entries(x.published ?? {}).map(([platform, v]) => ({ x, platform, v })))
    .sort((a, b) => (b.v.at ?? "").localeCompare(a.v.at ?? ""));
  const anyYouTube = exports.some((x) => x.published?.youtube?.video_id);

  return (
    <Panel index={4} className={className} eyebrow={t("Channel")} icon={<MonitorPlay />} title={t("YouTube")}
      actions={canProduce && anyYouTube && onRefreshMetrics ? (
        <Button size="sm" variant="outline" className="max-sm:h-10" icon={<BarChart3 className="size-3.5" />} loading={refreshing} onClick={onRefreshMetrics}>{t("Refresh metrics")}</Button>
      ) : undefined}>
      {isLoading ? (
        <div className="space-y-2.5" aria-hidden><Skeleton className="h-4 w-32" /><Skeleton className="h-10 rounded-lg" /></div>
      ) : (
        <div className="@container">
        <div className="grid gap-x-6 gap-y-4 @xl:grid-cols-2">
          <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2 text-xs font-medium">
            <StatusDot tone={connected ? "ok" : data?.youtube_ready ? "neutral" : "warn"} live={connected} />
            <span className={connected ? "text-ok" : data?.youtube_ready ? "text-mute" : "text-warn"}>
              {connected ? t("Connected") : data?.youtube_ready ? t("Not connected") : t("Needs setup")}
            </span>
          </div>

          {connected ? (
            <ul className="cx-block divide-y divide-line overflow-hidden">
              {accounts.map((a) => {
                const name = a.account_name || a.account_id || "YouTube";
                return (
                  <li key={a.id} className="flex items-center gap-2.5 px-3 py-2">
                    <Avatar name={name} size={26} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{name}</p>
                      <p className="mono truncate text-2xs text-dim" title={fmtDateTime(a.created_at)}>{t("connected {when}", { when: agoT(a.created_at) })}</p>
                    </div>
                    {a.account_id && (
                      <a href={`https://www.youtube.com/channel/${a.account_id}`} target="_blank" rel="noreferrer" aria-label={t("Open the channel on YouTube")} title={t("Open the channel on YouTube")}
                        className="grid size-8 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink max-sm:size-10"><ExternalLink className="size-3.5" /></a>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="cx-block flex items-start gap-3 px-3.5 py-3">
              <MonitorPlay className="mt-0.5 size-4 shrink-0 text-mute" />
              <div className="min-w-0 flex-1 text-xs leading-relaxed text-mute">
                <p>{t("Publish finished renders straight to your channel.")}</p>
                {canProduce
                  ? <Link to="/settings#integrations" className="mt-1.5 inline-flex font-medium text-accent-ink hover:underline max-sm:min-h-10 max-sm:items-center">{t("Connect YouTube to publish")}</Link>
                  : <p className="mt-1 text-dim">{t("A producer or admin can connect a channel.")}</p>}
              </div>
            </div>
          )}
          </div>

          <div className="min-w-0">
            <p className="eyebrow mb-2 flex items-center gap-2">{t("Publish history")}<span className="mono text-dim">{history.length}</span></p>
            {history.length ? (
              <ul className="cx-block cx-scroll max-h-56 divide-y divide-line">
                {history.map(({ x, platform, v }) => {
                  const m = platform === "youtube" ? metrics[x.id] : undefined;
                  return (
                    <li key={`${x.id}-${platform}`} className="flex items-center gap-2.5 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium" title={v.title}>{v.title || (platform === "youtube" ? t("YouTube video") : platformLabel(platform))}</p>
                        <p className="mono truncate text-2xs text-dim">#{x.id} · {platform === "youtube" ? "" : `${platformLabel(platform)} · `}{v.status === "uploaded" ? t("Uploaded") : v.status}{v.at ? ` · ${agoT(v.at)}` : ""}</p>
                      </div>
                      {m && <span className="mono inline-flex shrink-0 items-center gap-1 text-2xs text-mute" title={t("Views")}><Eye className="size-3" />{m.views.toLocaleString()}</span>}
                      {v.url && (
                        <a href={v.url} target="_blank" rel="noreferrer" aria-label={t("Open")} title={v.url}
                          className="grid size-7 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-hover hover:text-ink max-sm:size-10"><ExternalLink className="size-3.5" /></a>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-dim">{t("Nothing published yet.")}</p>
            )}
          </div>
        </div>
        </div>
      )}
    </Panel>
  );
}
