import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Bot, Check, Info, KeyRound, Plus, Trash2, TriangleAlert, Unplug } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { agoT, CopyButton, fmtDate } from "../../../components/growth/common";
import { MCP_SCOPES, ScopePicker, tidyScopes } from "../../../components/mcp/ScopePicker";
import { Alert, Badge, Button, Input, Select, Skeleton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { useMcpInfo, useMcpTokens } from "../../../lib/queries";
import type { McpScope, McpToken } from "../../../lib/types";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { Row, Rows, SettingsCard } from "./controls";

const EXPIRY = [
  { value: "", label: "Never" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "365 days" },
];
const SCOPE_LABEL: Record<string, string> = Object.fromEntries(MCP_SCOPES.map((s) => [s.value, s.label]));

/** A ready-to-paste block (shell command or JSON) with its own copy button. */
function Snippet({ label, text, what, wrap }: { label: string; text: string; what: string; wrap?: boolean }) {
  return (
    <div className="cx-block overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="eyebrow truncate">{label}</span>
        <CopyButton text={text} what={what} size="icon" />
      </div>
      <pre className={clsx("cx-scroll px-3 py-2.5 font-mono text-2xs leading-relaxed text-ink", wrap ? "whitespace-pre-wrap break-all" : "overflow-x-auto")}>{text}</pre>
    </div>
  );
}

/** Shown once, right after a token is made: the secret and the setup lines for Claude Code / Claude Desktop with it filled in. */
function NewToken({ token, url, onDone }: { token: McpToken & { token: string }; url: string; onDone: () => void }) {
  const t = useT();
  const command = `claude mcp add --transport http tatvam ${url} --header "Authorization: Bearer ${token.token}"`;
  const json = JSON.stringify({ mcpServers: { tatvam: { type: "http", url, headers: { Authorization: `Bearer ${token.token}` } } } }, null, 2);
  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
      className="overflow-hidden">
      <div role="status" className="space-y-3 rounded-xl border border-accent/40 bg-accent/[0.06] p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Check aria-hidden className="size-4 text-ok" strokeWidth={2.6} />
          {t("Token “{name}” created", { name: token.name })}
        </p>
        <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-panel px-3 py-2">
          <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-ink">{token.token}</code>
          <CopyButton text={token.token} what={t("Token")} />
        </div>
        <p className="flex items-start gap-1.5 text-xs font-medium text-amber-300">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {t("Copy it now — it won't be shown again")}
        </p>
        <Snippet label={t("Claude Code (run in a terminal)")} text={command} what={t("Command")} wrap />
        <Snippet label={t("Claude Desktop / other apps (JSON)")} text={json} what={t("Settings")} />
        <div className="flex justify-end">
          <Button size="sm" variant="outline" className="max-sm:h-10" icon={<Check className="size-3.5" />} onClick={onDone}>{t("Done, I've copied it")}</Button>
        </div>
      </div>
    </motion.div>
  );
}

function TokenRow({ tk, onRevoke }: { tk: McpToken; onRevoke: () => void }) {
  const t = useT();
  const app = tk.kind === "oauth_access";
  const expired = !!tk.expires_at && new Date(tk.expires_at).getTime() < Date.now();
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2.5 border-t border-line px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1 basis-64">
        <p className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{tk.name || tk.client_id}</span>
          <Badge tone={app ? "ai" : "neutral"}>{app ? t("Connected app") : t("Personal token")}</Badge>
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="mono text-2xs text-dim">{tk.prefix}…</span>
          {app && tk.client_id && tk.client_id !== tk.name && <span title={t("App ID")} className="mono max-w-48 truncate text-2xs text-dim">{tk.client_id}</span>}
          {tk.scopes.map((s) => (
            <Badge key={s} tone={s === "spend" ? "money" : s === "write" ? "accent" : "neutral"}>{t(SCOPE_LABEL[s] ?? s)}</Badge>
          ))}
        </div>
        <p className="mt-1.5 text-2xs text-dim">
          {tk.last_used_at ? t("Last used {when}", { when: agoT(tk.last_used_at) }) : t("Never used")}
          <span aria-hidden> · </span>
          {app ? t("Renews while connected")
            : !tk.expires_at ? t("Never expires")
              : expired ? <span className="text-red-300">{t("Expired")}</span>
                : t("Expires {date}", { date: fmtDate(tk.expires_at) })}
        </p>
      </div>
      <Button size="sm" variant="danger" className="max-sm:h-10" icon={app ? <Unplug className="size-3.5" /> : <Trash2 className="size-3.5" />} onClick={onRevoke}>
        {app ? t("Disconnect") : t("Revoke")}
      </Button>
    </li>
  );
}

/**
 * Settings → MCP access. Per-user (every role sees it): the MCP server address, personal tokens for Claude Code /
 * Claude Desktop, and the list of tokens and connected apps with revoke. Not part of the admin save bar.
 */
export function McpAccessCard({ index }: { index: number }) {
  const t = useT();
  const qc = useQueryClient();
  const info = useMcpInfo();
  const list = useMcpTokens();
  const allowed: McpScope[] = info.data?.scopes ?? ["read"];
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<McpScope[]>(["read", "write"]);
  const [expiry, setExpiry] = useState("");
  const [created, setCreated] = useState<(McpToken & { token: string }) | null>(null);
  const [confirm, setConfirm] = useState<McpToken | null>(null);
  const picked = tidyScopes(scopes, allowed);

  const create = useMutation({
    mutationFn: () => api.post<McpToken>("/api/mcp/tokens", {
      name: name.trim() || "MCP token", scopes: picked, expires_days: expiry ? Number(expiry) : null,
    }),
    onSuccess: (tk) => {
      if (tk.token) setCreated({ ...tk, token: tk.token });
      setName("");
      void qc.invalidateQueries({ queryKey: ["mcp", "tokens"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (tk: McpToken) => api.post<{ ok: boolean }>(`/api/mcp/tokens/${tk.id}/revoke`),
    onSuccess: (_, tk) => {
      toast.success(tk.kind === "oauth_access" ? t("{name} disconnected", { name: tk.name || tk.client_id }) : t("Token revoked"));
      if (created?.id === tk.id) setCreated(null);
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ["mcp", "tokens"] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!create.isPending) create.mutate();
  };

  const url = info.data?.url ?? "";
  const tokens = list.data ?? [];
  const confirmApp = confirm?.kind === "oauth_access";

  return (
    <SettingsCard id="mcp" index={index} icon={<Bot className="size-4" />} title={t("MCP access")}
      sub={t("Let Claude (Claude Code, Claude Desktop, claude.ai) or another MCP app work in Tatvam for you: read and improve scripts, plan scenes, storyboard, and make videos scene by scene — paid steps always come back as a cost proposal first.")}>
      {info.isError && (
        <Alert tone="warn" className="mb-4" action={<Button size="sm" variant="outline" loading={info.isFetching} onClick={() => void info.refetch()}>{t("Try again")}</Button>}>
          {t("Couldn't load the MCP server details.")}
        </Alert>
      )}
      {info.data && !info.data.enabled && (
        <Alert tone="warn" className="mb-4">
          {t("The MCP server is switched off on this studio, so apps can't connect yet. Tokens you make now will work once an admin turns it on.")}
        </Alert>
      )}
      <Rows>
        <Row stack label={t("Server address")}>
          {info.isLoading ? <Skeleton className="h-10 w-full max-w-xl" /> : (
            <div className="flex w-full max-w-xl items-center gap-2 rounded-lg border border-line bg-raised/60 px-3 py-1.5">
              <code className="min-w-0 flex-1 select-all truncate font-mono text-xs text-ink" title={url}>{url || "—"}</code>
              {url && <CopyButton text={url} what={t("Server address")} size="icon" />}
            </div>
          )}
          {info.data && (
            <p className="mt-2 flex max-w-[62ch] items-start gap-1.5 text-xs leading-relaxed text-mute">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {info.data.oauth
                ? t("claude.ai: add a custom connector with the address above; you'll be asked to sign in and approve it here.")
                : t("Sign-in for claude.ai needs the studio on an HTTPS address (PUBLIC_BASE_URL); personal tokens work anywhere.")}
            </p>
          )}
        </Row>

        <Row stack label={t("Create a token")} hint={t("For Claude Code, Claude Desktop and other apps that take a token. Make one per app so you can revoke it on its own.")}>
          <div className="w-full space-y-3">
            <form onSubmit={submit} className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <div className="min-w-48 flex-[2]">
                  <label htmlFor="mcp-token-name" className="eyebrow mb-1.5 block">{t("Name")}</label>
                  <Input id="mcp-token-name" value={name} maxLength={120} autoComplete="off" placeholder={t("e.g. Claude Code on my laptop")}
                    className="max-sm:h-10" onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="min-w-36 flex-1">
                  <label htmlFor="mcp-token-expiry" className="eyebrow mb-1.5 block">{t("Expires")}</label>
                  <Select id="mcp-token-expiry" value={expiry} className="max-sm:h-10" onChange={(e) => setExpiry(e.target.value)}>
                    {EXPIRY.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
                  </Select>
                </div>
              </div>
              <div>
                <p className="eyebrow mb-1.5">{t("What it can do")}</p>
                {info.isLoading ? <Skeleton className="h-36 w-full" /> : (
                  <ScopePicker ariaLabel={t("What it can do")} options={allowed} allowed={allowed} value={picked} onChange={setScopes} disabled={create.isPending} />
                )}
                {info.data && allowed.length === 1 && (
                  <p className="mt-1.5 text-xs text-mute">{t("Your role can give read access only.")}</p>
                )}
              </div>
              <div className="flex justify-end">
                <Button type="submit" variant="primary" className="max-sm:h-10" icon={<Plus className="size-4" />} loading={create.isPending} disabled={!info.data}>
                  {t("Create token")}
                </Button>
              </div>
            </form>
            <AnimatePresence initial={false}>
              {created && <NewToken key={created.id} token={created} url={url} onDone={() => setCreated(null)} />}
            </AnimatePresence>
          </div>
        </Row>

        <Row stack label={<span className="flex items-center gap-2">{t("Tokens and connected apps")}
          {!!tokens.length && <span className="mono rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-2xs font-normal text-dim">{tokens.length}</span>}</span>}>
          {list.isLoading ? (
            <div className="w-full space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
          ) : list.isError ? (
            <Alert tone="warn" className="w-full" action={<Button size="sm" variant="outline" loading={list.isFetching} onClick={() => void list.refetch()}>{t("Try again")}</Button>}>
              {t("Couldn't load your tokens.")}
            </Alert>
          ) : !tokens.length ? (
            <div className="cx-block flex w-full items-center gap-3 px-4 py-6 text-sm text-mute">
              <KeyRound aria-hidden className="size-4 shrink-0 text-dim" />
              {t("No tokens or connected apps yet. Create a token above, or connect claude.ai with the server address.")}
            </div>
          ) : (
            <ul className="cx-block w-full overflow-hidden">
              {tokens.map((tk) => <TokenRow key={tk.id} tk={tk} onRevoke={() => setConfirm(tk)} />)}
            </ul>
          )}
        </Row>
      </Rows>

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} busy={revoke.isPending}
        title={confirmApp ? t("Disconnect this app?") : t("Revoke this token?")}
        confirmLabel={confirmApp ? t("Disconnect") : t("Revoke token")} icon={confirmApp ? <Unplug className="size-4" /> : <Trash2 className="size-4" />}
        onConfirm={() => { if (confirm) revoke.mutate(confirm); }}>
        {confirm && (confirmApp
          ? t("{name} will lose access to Tatvam straight away. You can connect it again later.", { name: confirm.name || confirm.client_id })
          : t("Apps using “{name}” ({prefix}…) will stop working straight away. This can't be undone.", { name: confirm.name, prefix: confirm.prefix }))}
      </ConfirmDialog>
    </SettingsCard>
  );
}
