/**
 * The local MCP server (docs/EDITOR.md §13.1): streamable HTTP on 127.0.0.1:<port>/mcp, one MCP session per
 * connected assistant. Every request passes the gate (loopback Host, no browser Origin, no CORS), a bearer token and
 * a rate limit; every tool call checks the token's scopes, waits while the user has paused assistants, and goes into
 * the activity log. The display name of an assistant is its clientInfo.name (known apps by their product name).
 * Electron-free (tests run it in Node).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AssistantScope, AssistantSession, AssistantToken } from "../../shared/types.ts";
import type { ActivityLog } from "./activity.ts";
import type { FolderGuard } from "./folders.ts";
import { failure } from "./format.ts";
import { bearerOf, gate, RateLimiter } from "./security.ts";
import type { TokenStore } from "./tokens.ts";
import { scopesFor, TOOLS, type CallCtx, type McpDeps, type ToolDef } from "./tools.ts";

export const SERVER_NAME = "tatvam-desktop";
export const INSTRUCTIONS = [
  "Tatvam Desktop's local video editor. Start with `status` (what is open, your scopes), then `list_edits` / `open_edit` or `create_edit` (from_folder imports a folder).",
  "Every change runs in the user's editor window as an undoable step called \"Assistant: <tool>\"; the user sees it live and can pause or stop you.",
  "Times are seconds on the timeline; results show seconds and timecode. Look with `get_timeline` and `get_frame` before and after you change things.",
  "`auto_edit` (style talking_head, montage, documentary, highlights or slideshow) cuts a whole sequence in one step; try dry_run first.",
  "Folders other than the library ask the user first. Exports go into the edit's Renders folder; `export` returns a render id for `render_status`.",
  "Paid AI tools (`run_ai_tool`) are priced and proposed to the user; only a token with the spend scope may approve them, within budgets.",
].join("\n");

/** clientInfo.name → the product name the banner shows. */
const KNOWN_CLIENTS: Record<string, string> = {
  "claude-ai": "Claude Desktop", "claude-desktop": "Claude Desktop", "claude-code": "Claude Code", "codex-mcp-client": "Codex", codex: "Codex",
  "codex-cli": "Codex", cursor: "Cursor", "cursor-vscode": "Cursor", "visual studio code": "VS Code", "mcp-inspector": "MCP Inspector",
};
export function displayName(info: { name?: string; title?: string } | undefined, fallback: string): string {
  const n = (info?.name ?? "").trim();
  const known = KNOWN_CLIENTS[n.toLowerCase()];
  if (known) return known;
  return (info?.title?.trim() || n || fallback).slice(0, 60);
}

interface Session {
  id: string; transport: StreamableHTTPServerTransport; server: McpServer;
  token: AssistantToken; client: string; clientVersion?: string;
  since: string; lastCall?: string; lastTool?: string; calls: number; busy: number; edit?: string;
  ended: boolean;
}

export interface ServerDeps {
  tokens: TokenStore;
  activity: ActivityLog;
  folders: FolderGuard;
  mcp: McpDeps;
  version: string;
  log(m: string): void;
  /** sessions, pause or busy changed (the banner and Settings follow) */
  onChange(): void;
  /** for tests: request and tool-call limits per token per minute */
  limits?: { requests: number; calls: number };
}

const json = (res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
};

export class AssistantServer {
  private http: Server | null = null;
  private sessions = new Map<string, Session>();
  private requests: RateLimiter;
  private calls: RateLimiter;
  private pausedFlag = false;
  private resume: (() => void)[] = [];
  /** tokens the user stopped: new sessions refused until then */
  private stopped = new Map<string, number>();
  port = 0;
  error: string | undefined;

  private deps: ServerDeps;

  constructor(deps: ServerDeps) {
    this.deps = deps;
    this.requests = new RateLimiter(deps.limits?.requests ?? 600, 60_000);
    this.calls = new RateLimiter(deps.limits?.calls ?? 120, 60_000);
  }

  get running(): boolean { return Boolean(this.http?.listening); }
  get paused(): boolean { return this.pausedFlag; }

  async start(port: number): Promise<void> {
    if (this.running && this.port === port) return;
    await this.stop();
    this.error = undefined;
    const srv = createServer((req, res) => void this.handle(req, res).catch((e) => {
      this.deps.log(`assistants: ${(e as Error).stack ?? e}`);
      json(res, 500, { error: "Internal error" });
    }));
    srv.headersTimeout = 30_000;
    srv.requestTimeout = 0; // SSE streams stay open
    await new Promise<void>((resolve, reject) => {
      srv.once("error", (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use: pick another in Settings → AI assistants`) : e));
      srv.listen(port, "127.0.0.1", () => resolve());
    }).catch((e) => { this.error = (e as Error).message; throw e; });
    this.http = srv;
    this.port = port;
    this.deps.log(`assistants: MCP server on http://127.0.0.1:${port}/mcp`);
    this.deps.onChange();
  }

  async stop(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.end(id, false);
    this.deps.folders.denyAll();
    this.setPaused(false);
    const srv = this.http;
    this.http = null;
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
      this.deps.log("assistants: MCP server stopped");
    }
    this.deps.onChange();
  }

  setPaused(on: boolean): void {
    this.pausedFlag = on;
    if (!on) for (const r of this.resume.splice(0)) r();
    this.deps.onChange();
  }

  /** Stop: end one session or all; the token can't start a new one for 2 minutes. */
  async stopSessions(id?: string): Promise<void> {
    const list = id ? [this.sessions.get(id)].filter((s): s is Session => !!s) : [...this.sessions.values()];
    for (const s of list) {
      this.stopped.set(s.token.id, Date.now() + 120_000);
      this.deps.activity.add({ client: s.client, tokenName: s.token.name, session: s.id, tool: "stop", ok: true, summary: "The user stopped this assistant" });
      await this.end(s.id, true);
    }
    this.deps.onChange();
  }

  /** A revoked token's sessions end at once. */
  async dropToken(tokenId: string): Promise<void> {
    for (const s of [...this.sessions.values()]) if (s.token.id === tokenId) await this.end(s.id, true);
  }

  sessionInfos(): AssistantSession[] {
    return [...this.sessions.values()].filter((s) => !s.ended).map((s) => ({ id: s.id, client: s.client, ...(s.clientVersion ? { clientVersion: s.clientVersion } : {}),
      tokenId: s.token.id, tokenName: s.token.name, since: s.since, ...(s.lastCall ? { lastCall: s.lastCall } : {}), ...(s.lastTool ? { lastTool: s.lastTool } : {}),
      calls: s.calls, ...(s.edit ? { edit: s.edit } : {}), busy: s.busy > 0 }));
  }

  private async end(id: string, notify: boolean): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.ended = true;
    this.sessions.delete(id);
    this.deps.folders.forget(id);
    await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
    if (notify) this.deps.onChange();
  }

  private refuse(res: ServerResponse, status: number, message: string, who = "unknown", headers: Record<string, string> = {}): void {
    this.deps.activity.add({ client: who, tool: "request", ok: false, summary: `Refused (${status}): ${message}` });
    json(res, status, { error: message }, headers);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const g = gate(req, this.port);
    if (g) { this.refuse(res, g.status, g.message); return; }
    const token = this.deps.tokens.verify(bearerOf(req.headers.authorization));
    if (!token) {
      this.refuse(res, 401, req.headers.authorization ? "That token isn't valid (revoked, or for another PC)" : "A bearer token is needed: Settings → AI assistants → Tokens",
        "unknown", { "WWW-Authenticate": `Bearer realm="${SERVER_NAME}"` });
      return;
    }
    if (!this.requests.take(token.id)) {
      this.refuse(res, 429, "Too many requests: slow down", token.name, { "Retry-After": String(this.requests.retryAfter(token.id)) });
      return;
    }
    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    let s: Session | undefined;
    if (sessionId) {
      s = this.sessions.get(sessionId);
      if (!s || s.token.id !== token.id) { json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found: start a new one" }, id: null }); return; }
    } else if (req.method === "POST") {
      const until = this.stopped.get(token.id) ?? 0;
      if (until > Date.now()) { this.refuse(res, 403, "The user stopped this assistant a moment ago: try again later", token.name); return; }
      s = this.newSession(token);
    } else {
      json(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "No session: send initialize first" }, id: null });
      return;
    }
    (req as IncomingMessage & { auth?: unknown }).auth = { token: "", clientId: token.id, scopes: [...token.scopes], extra: { name: token.name } };
    await s.transport.handleRequest(req as IncomingMessage & { auth?: never }, res);
  }

  private newSession(token: AssistantToken): Session {
    const server = new McpServer({ name: SERVER_NAME, title: "Tatvam Desktop", version: this.deps.version }, { instructions: INSTRUCTIONS, capabilities: { logging: {} } });
    const s: Session = { id: "", transport: null as never, server, token, client: token.name, since: new Date().toISOString(), calls: 0, busy: 0, ended: false };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        s.id = id;
        this.sessions.set(id, s);
        this.deps.onChange();
      },
      onsessionclosed: (id) => { void this.end(id, true); },
    });
    s.transport = transport;
    // the client's name and version arrive with initialize (clientInfo); the session is known once it's answered
    server.server.oninitialized = () => {
      const info = server.server.getClientVersion();
      s.client = displayName(info, token.name);
      if (info?.version) s.clientVersion = String(info.version).slice(0, 40);
      this.deps.activity.add({ client: s.client, tokenName: token.name, session: s.id, tool: "connect", ok: true,
        summary: `Connected (${info?.name ?? "unknown app"} ${info?.version ?? ""})`.trim() });
      this.deps.onChange();
    };
    transport.onclose = () => { if (s.id && this.sessions.has(s.id)) void this.end(s.id, true); };
    for (const t of TOOLS) {
      server.registerTool(t.name, {
        title: t.title, description: t.description, inputSchema: t.input,
        annotations: { readOnlyHint: Boolean(t.readOnly), destructiveHint: Boolean(t.destructive), openWorldHint: false, idempotentHint: Boolean(t.readOnly) },
      }, (async (args: Record<string, unknown>, extra: { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification(n: unknown): Promise<void> }) =>
        this.call(s, t, args ?? {}, extra)) as never);
    }
    void server.connect(transport);
    return s;
  }

  private async whenRunning(signal: AbortSignal): Promise<void> {
    while (this.pausedFlag && !signal.aborted) {
      await new Promise<void>((r) => {
        this.resume.push(r);
        signal.addEventListener("abort", () => r(), { once: true });
      });
    }
  }

  async call(s: Session, t: ToolDef, args: Record<string, unknown>,
    extra: { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification(n: unknown): Promise<void> }): Promise<unknown> {
    const started = Date.now();
    const log = (ok: boolean, summary: string) => this.deps.activity.add({ client: s.client, tokenName: s.token.name, session: s.id, tool: t.name, ok, ms: Date.now() - started,
      summary, ...(s.edit ? { edit: s.edit } : {}) });
    if (s.ended) return failure("This session was stopped by the user");
    const need = scopesFor(t, args);
    const missing = need.filter((x) => !s.token.scopes.includes(x as AssistantScope));
    if (missing.length) {
      const msg = `This token (${s.token.name}) lacks the ${missing.map((m) => `"${m}"`).join(" and ")} scope${missing.length > 1 ? "s" : ""} for ${t.name}. The user can make a token with it in Settings → AI assistants.`;
      log(false, msg);
      return failure(msg);
    }
    if (!this.calls.take(s.token.id)) {
      log(false, "rate limited");
      return failure(`Too many tool calls: wait ${this.calls.retryAfter(s.token.id)} s`);
    }
    if (this.pausedFlag) {
      this.deps.onChange();
      await this.whenRunning(extra.signal);
      if (s.ended) return failure("This session was stopped by the user");
    }
    s.busy++;
    s.calls++;
    s.lastCall = new Date().toISOString();
    s.lastTool = t.name;
    this.deps.onChange();
    const token = extra._meta?.progressToken;
    let lastP = -1;
    const ctx: CallCtx = {
      session: s.id, client: s.client, tokenName: s.token.name, scopes: [...s.token.scopes], signal: extra.signal,
      progress: token === undefined ? undefined : (progress, total, message) => {
        if (progress <= lastP) return;
        lastP = progress;
        void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, ...(total !== undefined ? { total } : {}), message } }).catch(() => undefined);
      },
      edit: () => s.edit,
      setEdit: (f) => { s.edit = f; },
    };
    try {
      const r = await t.run(args as never, ctx, this.deps.mcp);
      const first = ((r.content?.[0] as { text?: string } | undefined)?.text ?? "").split("\n")[0];
      log(!r.isError, first.slice(0, 300));
      return r;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "");
      log(false, msg.slice(0, 300));
      return failure(msg);
    } finally {
      s.busy--;
      this.deps.tokens.touch(s.token.id);
      this.deps.onChange();
    }
  }
}
