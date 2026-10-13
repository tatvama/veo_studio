/**
 * Settings → AI assistants (docs/EDITOR.md §13): the on/off switch, the port, tokens (made with a name and scopes,
 * copied, revoked, last used), the folders assistants may use, connected assistants, watch folders, the activity log,
 * and the connection snippets for Claude Code, Claude Desktop and Codex, ready to copy with a token filled in. It
 * never writes those apps' config files: Copy only. A default export with no required props (desktop-shell mounts it).
 */
import { clsx } from "clsx";
import { Bot, Check, Copy, Eye, EyeOff, FolderPlus, KeyRound, Plug, Plus, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Field, Input, Select, Toggle } from "../../components/ui";
import { desktop, type AssistantScope, type AssistantsState, type AutoEditStyle, type EditListEntry, type WatchFolder } from "../../lib/desktop";
import { assistantsBridge, errText } from "../api";
import { STYLES } from "../autoedit/styles";
import ActivityLog from "./ActivityLog";
import { ago, useAssistants } from "./useAssistants";

const SCOPES: { id: AssistantScope; label: string; hint: string }[] = [
  { id: "read", label: "Read", hint: "look at edits, media, timelines and frames" },
  { id: "edit", label: "Edit", hint: "change edits (each change is one undo step)" },
  { id: "export", label: "Export", hint: "render files into the edit's Renders folder" },
  { id: "spend", label: "Spend", hint: "approve paid AI work within your budgets" },
];
const PLACEHOLDER = "tvd_…";

function Section({ title, sub, children, actions }: { title: string; sub?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {sub && <p className="mt-0.5 text-xs text-mute">{sub}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function CopyButton({ text, label = "Copy", disabled }: { text: () => Promise<string> | string; label?: string; disabled?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="secondary" disabled={disabled} icon={done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      onClick={async () => { try { await navigator.clipboard.writeText(await text()); setDone(true); window.setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ } }}>
      {done ? "Copied" : label}
    </Button>
  );
}

/** The three ready-made connections (§13.5). */
export function snippets(st: Pick<AssistantsState, "port" | "command">, token: string) {
  const url = `http://127.0.0.1:${st.port}/mcp`;
  const desktopJson = JSON.stringify({ mcpServers: { "tatvam-desktop": { command: st.command.exe, args: st.command.args, env: { TATVAM_MCP_TOKEN: token } } } }, null, 2);
  const toml = [
    "[mcp_servers.tatvam-desktop]",
    `command = ${JSON.stringify(st.command.exe)}`,
    `args = [${st.command.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `env = { TATVAM_MCP_TOKEN = ${JSON.stringify(token)} }`,
  ].join("\n");
  return [
    { id: "claude-code", title: "Claude Code", where: "Run in a terminal", text: `claude mcp add --transport http tatvam-desktop ${url} --header "Authorization: Bearer ${token}"` },
    { id: "claude-desktop", title: "Claude Desktop", where: "Add to claude_desktop_config.json (Settings → Developer → Edit config), then restart Claude Desktop", text: desktopJson },
    { id: "codex", title: "Codex", where: "Add to ~/.codex/config.toml", text: toml },
    { id: "other", title: "Other MCP apps", where: "Streamable HTTP with a bearer token", text: `URL: ${url}\nHeader: Authorization: Bearer ${token}` },
  ];
}

export default function AssistantsSettings() {
  const b = assistantsBridge();
  const [st, setSt] = useAssistants();
  const [err, setErr] = useState<string | null>(null);
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<AssistantScope[]>(["read", "edit", "export"]);
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [pick, setPick] = useState<string>("");
  const [value, setValue] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [edits, setEdits] = useState<EditListEntry[]>([]);
  const [wf, setWf] = useState<{ style: AutoEditStyle; editPath: string; mode: WatchFolder["mode"] }>({ style: "talking_head", editPath: "", mode: "append" });
  const run = async (fn: () => Promise<AssistantsState | void>) => {
    setErr(null);
    try { const s = await fn(); if (s) setSt(s); } catch (e) { setErr(errText(e)); }
  };
  useEffect(() => { if (st && !port) setPort(String(st.port)); }, [st, port]);
  useEffect(() => { if (st && !pick && st.tokens[0]) setPick(st.tokens[0].id); }, [st, pick]);
  useEffect(() => { setValue(null); setReveal(false); }, [pick]);
  useEffect(() => { void desktop()?.editor?.list().then(setEdits).catch(() => undefined); }, []);
  const token = fresh && st?.tokens.some((t) => t.id === pick && t.name === fresh.name) ? fresh.token : value;
  const shown = useMemo(() => (st ? snippets(st, token && reveal ? token : PLACEHOLDER) : []), [st, token, reveal]);
  const fullText = async (id: string) => {
    let t = token;
    if (!t && pick && b) { t = await b.tokenValue(pick); setValue(t); }
    return snippets(st!, t || PLACEHOLDER).find((s) => s.id === id)!.text;
  };

  if (!b) return <Alert tone="info" title="AI assistants need Tatvam Desktop">Claude Desktop, Claude Code and Codex connect to the editor on this PC through the desktop app.</Alert>;
  if (!st) return <p className="p-4 text-sm text-mute">Loading…</p>;

  return (
    <div className="space-y-4 text-sm">
      <Section title="AI assistants" sub="Let Claude Desktop, Claude Code, Codex or another MCP app work in the editor on this PC: open edits, cut, add effects, auto edit folders and export. Everything they change shows in the editor as an undoable step.">
        <div className="flex flex-wrap items-center gap-3">
          <Toggle checked={st.enabled} onChange={(on) => void run(() => b.setEnabled(on))} label={<span className="font-medium">Allow AI assistants to control Tatvam</span>} />
          {st.enabled && (st.running ? <Badge tone="ok" dot>Listening on {st.url}</Badge> : <Badge tone="bad" dot>Not running</Badge>)}
          {st.paused && <Badge tone="warn">Paused</Badge>}
        </div>
        {st.error && <Alert tone="bad">{st.error}</Alert>}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Port" hint="Only this PC can connect (127.0.0.1). Web pages are always refused."><Input className="w-28" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} /></Field>
          <Button size="sm" disabled={Number(port) === st.port} onClick={() => void run(() => b.setPort(Number(port)))}>Use port</Button>
        </div>
        {err && <Alert tone="bad">{err}</Alert>}
      </Section>

      <Section title="Tokens" sub="Each assistant gets its own token. Requests without a valid token are refused. Tokens are kept encrypted on this PC.">
        {!st.encrypted && <Alert tone="warn">Windows encryption isn't available, so a token can be copied only when it is made.</Alert>}
        {st.tokens.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {st.tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <KeyRound className="size-4 text-mute" />
                <span className="font-medium">{t.name}</span>
                <span className="font-mono text-2xs text-dim">{t.hint}</span>
                <span className="flex gap-1">{t.scopes.map((s) => <Badge key={s} tone={s === "spend" ? "money" : s === "read" ? "neutral" : "accent"}>{s}</Badge>)}</span>
                <span className="ml-auto text-2xs text-dim">made {ago(t.created)} · used {ago(t.lastUsed)}</span>
                <CopyButton label="Copy token" disabled={!st.encrypted} text={() => b.tokenValue(t.id)} />
                <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => { if (window.confirm(`Revoke "${t.name}"? It stops working at once.`)) void run(() => b.revokeToken(t.id)); }}>Revoke</Button>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-dim">No tokens yet.</p>}
        <div className="rounded-lg border border-dashed border-line p-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="New token for" className="min-w-48 flex-1"><Input value={name} placeholder="Claude Desktop" onChange={(e) => setName(e.target.value)} /></Field>
            <div className="flex flex-wrap gap-3 pb-1.5">
              {SCOPES.map((s) => (
                <label key={s.id} className={clsx("inline-flex items-center gap-1.5 text-xs", s.id === "read" && "opacity-70")} title={s.hint}>
                  <input type="checkbox" checked={scopes.includes(s.id)} disabled={s.id === "read"}
                    onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />{s.label}
                </label>
              ))}
            </div>
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} disabled={!name.trim()}
              onClick={() => void run(async () => { const r = await b.createToken(name.trim(), scopes); setFresh({ token: r.token, name: r.info.name }); setPick(r.info.id); setName(""); return b.state(); })}>
              Make token
            </Button>
          </div>
          <p className="mt-1.5 text-2xs text-dim">{SCOPES.map((s) => `${s.label}: ${s.hint}`).join(" · ")}. Without Spend, paid AI tools only propose: you approve them in Tatvam.</p>
          {fresh && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-raised px-3 py-2">
              <span className="text-xs">Token for {fresh.name}:</span>
              <code className="break-all font-mono text-xs">{fresh.token}</code>
              <CopyButton text={() => fresh.token} />
              <button type="button" className="ml-auto text-dim hover:text-ink" title="Hide" onClick={() => setFresh(null)}><X className="size-4" /></button>
            </div>
          )}
        </div>
      </Section>

      <Section title="Connect an assistant" sub="Copy one of these into the app. Tatvam never edits those apps' settings itself."
        actions={st.tokens.length ? (
          <div className="flex items-center gap-2">
            <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Token in the snippets">
              {st.tokens.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
            <Button size="sm" variant="ghost" icon={reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              onClick={() => void (async () => { if (!reveal && !token && pick) { try { setValue(await b.tokenValue(pick)); } catch (e) { setErr(errText(e)); return; } } setReveal((r) => !r); })()}>
              {reveal ? "Hide token" : "Show token"}
            </Button>
          </div>
        ) : undefined}>
        {!st.enabled && <Alert tone="info">Turn on "Allow AI assistants" above first.</Alert>}
        <div className="grid gap-3 lg:grid-cols-2">
          {shown.map((s) => (
            <div key={s.id} className="flex min-w-0 flex-col rounded-lg border border-line bg-raised/50">
              <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
                <Plug className="size-3.5 text-mute" />
                <span className="text-xs font-semibold">{s.title}</span>
                <span className="truncate text-2xs text-dim">{s.where}</span>
                <span className="ml-auto"><CopyButton text={() => fullText(s.id)} disabled={!st.tokens.length && s.id !== "other"} /></span>
              </div>
              <pre className="min-h-0 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-2xs leading-relaxed text-mute">{s.text}</pre>
            </div>
          ))}
        </div>
        <p className="text-2xs text-dim">Claude Desktop and Codex start Tatvam themselves through <code className="font-mono">{st.command.exe.split(/[\\/]/).pop()} --mcp-stdio</code> when it isn't running. In Claude Code, ask for example: "Auto edit D:\Shoots\Day1 as a talking-head vlog and export a draft".</p>
      </Section>

      <Section title="Folders" sub="Assistants may use the library and these folders. Any other folder asks you first (Allow once, Always or Deny; no answer in 60 s is a Deny)."
        actions={<Button size="sm" icon={<FolderPlus className="size-3.5" />} onClick={() => void run(() => b.addFolder())}>Add folder…</Button>}>
        <ul className="space-y-1">
          <li className="flex items-center gap-2 rounded-md bg-raised/60 px-2.5 py-1.5 font-mono text-xs"><span className="flex-1 truncate">{st.libraryRoot}</span><Badge>library</Badge></li>
          {st.folders.map((f) => (
            <li key={f} className="flex items-center gap-2 rounded-md bg-raised/60 px-2.5 py-1.5 font-mono text-xs">
              <span className="flex-1 truncate">{f}</span>
              <button type="button" className="text-dim hover:text-red-300" title="Remove" onClick={() => void run(() => b.removeFolder(f))}><X className="size-3.5" /></button>
            </li>
          ))}
        </ul>
        <p className="text-2xs text-dim">Only video, audio, pictures and timeline files (XML, EDL, OTIO, captions, LUTs, edits) are read. Exports go only into each edit's Renders folder.</p>
      </Section>

      <Section title="Connected now">
        {st.sessions.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {st.sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                <Bot className={clsx("size-4", s.busy ? "animate-pulse text-ai" : "text-mute")} />
                <span className="font-medium">{s.client}</span>{s.clientVersion && <span className="text-dim">{s.clientVersion}</span>}
                <span className="text-dim">token {s.tokenName} · {s.calls} calls · last {ago(s.lastCall)}{s.lastTool ? ` (${s.lastTool})` : ""}</span>
                <Button size="sm" variant="danger" className="ml-auto" icon={<Square className="size-3" />} onClick={() => void run(() => b.stop(s.id))}>Stop</Button>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-dim">No assistant is connected.</p>}
      </Section>

      <Section title="Watch folders" sub="New clips in a folder (once their size has held for 5 seconds) are cut into an edit in a style: added to the end of its auto edit, or the auto edit is made again. Nothing renders or spends on its own.">
        {st.watches.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {st.watches.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                <Toggle checked={w.on} onChange={(on) => void run(() => b.updateWatch(w.id, { on }))} />
                <span className="min-w-0 flex-1 truncate font-mono" title={w.folder}>{w.folder}</span>
                <span className="text-mute">→ {w.editPath.split(/[\\/]/).pop()?.replace(/\.tatvamedit$/i, "")}</span>
                <Badge tone="accent">{STYLES.find((s) => s.id === w.style)?.name ?? w.style}</Badge>
                <Badge>{w.mode === "rebuild" ? "rebuild" : "append"}</Badge>
                {w.lastRun && <span className="text-dim">{w.lastCount ?? 0} added {ago(w.lastRun)}</span>}
                {w.lastError && <span className="text-red-300" title={w.lastError}>error</span>}
                <button type="button" className="text-dim hover:text-red-300" title="Remove" onClick={() => void run(() => b.removeWatch(w.id))}><Trash2 className="size-3.5" /></button>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-dim">No watch folders.</p>}
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-line p-3">
          <Field label="Into the edit" className="min-w-56 flex-1">
            <Select value={wf.editPath} onChange={(e) => setWf({ ...wf, editPath: e.target.value })}>
              <option value="">Choose an edit…</option>
              {edits.map((x) => <option key={x.path} value={x.path}>{x.name}</option>)}
            </Select>
          </Field>
          <Field label="Style"><Select value={wf.style} onChange={(e) => setWf({ ...wf, style: e.target.value as AutoEditStyle })}>{STYLES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="New clips"><Select value={wf.mode} onChange={(e) => setWf({ ...wf, mode: e.target.value as WatchFolder["mode"] })}>
            <option value="append">Append to the auto edit</option><option value="rebuild">Rebuild the auto edit</option></Select></Field>
          <Button size="sm" variant="primary" icon={<FolderPlus className="size-3.5" />} disabled={!wf.editPath} onClick={() => void run(() => b.addWatch(wf))}>Watch a folder…</Button>
        </div>
      </Section>

      <Section title="Activity" sub="Every call an assistant made, and every request that was refused (the last 1000 are kept).">
        <ActivityLog refreshKey={st.sessions.map((s) => `${s.id}:${s.calls}`).join(",")} />
      </Section>
    </div>
  );
}
