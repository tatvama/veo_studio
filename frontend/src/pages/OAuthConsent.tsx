/**
 * /oauth/consent?request=<id> — an MCP app (e.g. claude.ai) sends the signed-in user here to approve it.
 * Allow / Deny posts the decision and then sends the browser back to the app's own callback address.
 */
import { Bot, Check, CornerDownLeft, Hourglass, UserRound, X } from "lucide-react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { LoadError } from "../components/growth/common";
import { ScopePicker, tidyScopes } from "../components/mcp/ScopePicker";
import { Button, Page, Skeleton, useDocumentTitle } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useT } from "../lib/i18n";
import { useAuthStatus, useOAuthRequest } from "../lib/queries";
import type { McpScope } from "../lib/types";

function Frame({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <Page width="narrow">
      <div className="flex min-h-[calc(100dvh-10rem)] items-center justify-center py-4">
        <motion.section aria-label={label} initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="hud w-full max-w-lg rounded-2xl border border-line bg-panel p-6 shadow-card sm:p-7">
          {children}
        </motion.section>
      </div>
    </Page>
  );
}

function Gone() {
  const t = useT();
  return (
    <Frame label={t("Sign-in link")}>
      <div className="flex flex-col items-center text-center">
        <span aria-hidden className="mb-4 grid size-12 place-items-center rounded-xl border border-warn/30 bg-warn/10 text-warn"><Hourglass className="size-5" /></span>
        <h1 className="text-balance text-xl font-semibold tracking-tight">{t("This link can't be used")}</h1>
        <p role="alert" className="mt-2 max-w-sm text-sm leading-relaxed text-mute">
          {t("This sign-in link has expired or was already used. Start again from the app you are connecting.")}
        </p>
        <Link to="/" className="mt-6 text-sm font-medium text-accent-ink hover:underline">{t("Go to the studio")}</Link>
      </div>
    </Frame>
  );
}

export default function OAuthConsent() {
  const t = useT();
  const [params] = useSearchParams();
  const rid = params.get("request");
  const { data: auth } = useAuthStatus();
  const req = useOAuthRequest(rid);
  const [picked, setPicked] = useState<McpScope[] | null>(null);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  useDocumentTitle(t("Connect an app"));

  const view = req.data;
  const notFound = req.error instanceof ApiError && (req.error.status === 404 || req.error.status === 400);
  if (!rid || gone || notFound || (view && (view.expired || view.status !== "pending"))) return <Gone />;
  if (req.isError) {
    return (
      <Page width="narrow">
        <LoadError title={t("We couldn't load this sign-in request")} onRetry={() => void req.refetch()} retrying={req.isFetching} className="mt-16" />
      </Page>
    );
  }
  if (!view) {
    return (
      <Frame>
        <div aria-busy="true" className="space-y-4">
          <Skeleton className="size-12 rounded-xl" />
          <Skeleton className="h-7 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-40 w-full" />
          <div className="flex justify-end gap-2"><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-24" /></div>
        </div>
      </Frame>
    );
  }

  const allowed = view.allowed_scopes;
  const options = tidyScopes(view.scopes, ["read", "write", "spend"]);
  const scopes = picked ?? tidyScopes(view.scopes, allowed);
  const client = view.client || t("This app");
  const user = auth?.user;
  const who = user ? (user.name ? `${user.name} · ${user.email}` : user.email) : "";
  const locked = !!busy || leaving;

  const decide = async (approve: boolean) => {
    if (locked) return;
    setBusy(approve ? "allow" : "deny");
    try {
      const res = await api.post<{ redirect: string }>(`/api/oauth/requests/${encodeURIComponent(view.id)}/decide`,
        approve ? { approve: true, scopes } : { approve: false }, { silent: true });
      setLeaving(true);
      window.location.assign(res.redirect);
    } catch (e) {
      setBusy(null);
      if (e instanceof ApiError && (e.status === 400 || e.status === 404)) setGone(true);
      else toast.error(e instanceof ApiError ? e.message : t("Can't reach the server. Check your connection and try again."));
    }
  };

  return (
    <Frame label={t("Connect an app")}>
      <div className="flex items-center gap-3">
        <span aria-hidden className="hud grid size-12 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent/10 text-accent-ink"><Bot className="size-5" /></span>
        <p className="eyebrow !text-accent-ink">{t("Connect an app")}</p>
      </div>
      <h1 className="mt-4 text-balance text-2xl font-semibold leading-tight tracking-tight">
        {t("Allow {client} to use Tatvam?", { client })}
      </h1>

      <ul className="mt-4 space-y-2 text-sm text-mute">
        {who && (
          <li className="flex items-start gap-2.5">
            <UserRound aria-hidden className="mt-0.5 size-4 shrink-0 text-dim" />
            <span className="min-w-0 break-words">{t("It will act as you ({who})", { who })}</span>
          </li>
        )}
        {view.redirect_host && (
          <li className="flex items-start gap-2.5">
            <CornerDownLeft aria-hidden className="mt-0.5 size-4 shrink-0 text-dim" />
            <span className="min-w-0 break-words">{t("It will be sent back to")} <span className="mono text-ink">{view.redirect_host}</span></span>
          </li>
        )}
      </ul>

      <div className="mt-5">
        <p className="eyebrow mb-2">{t("It asks to")}</p>
        <ScopePicker ariaLabel={t("What {client} may do", { client })} options={options} allowed={allowed} value={scopes} onChange={setPicked} disabled={locked} />
      </div>

      <p className="mt-4 text-xs leading-relaxed text-dim">
        {t("You can disconnect it any time in")}{" "}
        <Link to="/settings#mcp" className="font-medium text-accent-ink hover:underline">{t("Settings → MCP access")}</Link>.
      </p>

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" className="max-sm:h-11" icon={<X className="size-4" />} loading={busy === "deny"} disabled={locked} onClick={() => void decide(false)}>
          {t("Deny")}
        </Button>
        <Button variant="primary" className="min-w-28 max-sm:h-11" icon={<Check className="size-4" />} loading={busy === "allow"} disabled={locked}
          onClick={() => void decide(true)}>
          {t("Allow")}
        </Button>
      </div>
      {leaving && (
        <p role="status" className="mt-3 text-right text-xs text-mute">{t("Sending you back to {host}…", { host: view.redirect_host || client })}</p>
      )}
    </Frame>
  );
}
