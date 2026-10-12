/**
 * The stdio relay (docs/EDITOR.md §13.1): `"Tatvam Studio.exe" --mcp-stdio` (dev: `electron.exe desktop --mcp-stdio`)
 * for MCP apps that can only start a command (Claude Desktop, Codex). It reads TATVAM_MCP_TOKEN, starts the app
 * detached when nothing answers on the port (waiting up to 30 s), then relays JSON-RPC both ways with the SDK's
 * stdio and streamable HTTP transports. It never opens a window and exits when stdin closes. stdout carries the
 * protocol only: every log line goes to userData/logs/mcp-stdio.log (and stderr).
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { format } from "node:util";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { effectivePort, sanitizeAssistants } from "./settings.ts";

export const RELAY_FLAG = "--mcp-stdio";
export const isRelayRun = (argv: string[]) => argv.includes(RELAY_FLAG);

/** Is something listening on 127.0.0.1:port? */
export function portOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function waitForPort(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return portOpen(port);
}

const isRequest = (m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; method: string } =>
  typeof (m as { method?: unknown }).method === "string" && (m as { id?: unknown }).id !== undefined;

export interface RelayOptions {
  url: string;
  token: string;
  stdin?: Readable; stdout?: Writable;
  log(m: string): void;
  /** stdin closed, or the upstream went away for good */
  onExit(code: number): void;
  /** answer every request with this error instead of relaying (the server is off, no token …) */
  refuse?: string;
}

/** Relays one MCP client on stdin/stdout to the HTTP server. Resolves when it is running. */
export async function runRelay(o: RelayOptions): Promise<{ close(): Promise<void> }> {
  const down = new StdioServerTransport(o.stdin, o.stdout);
  const up = o.refuse ? null : new StreamableHTTPClientTransport(new URL(o.url), { requestInit: { headers: { Authorization: `Bearer ${o.token}` } } });
  let closing = false;
  const close = async (code = 0) => {
    if (closing) return;
    closing = true;
    if (up) {
      try { if (up.sessionId) await up.terminateSession(); } catch { /* the app went away */ }
      await up.close().catch(() => undefined);
    }
    await down.close().catch(() => undefined);
    o.onExit(code);
  };
  const fail = (m: JSONRPCMessage, message: string) => {
    if (isRequest(m)) void down.send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message } } as JSONRPCMessage).catch(() => undefined);
  };
  if (up) {
    up.onmessage = (m) => {
      const r = (m as { result?: { protocolVersion?: string } }).result;
      if (r && typeof r.protocolVersion === "string" && !up.protocolVersion) up.setProtocolVersion(r.protocolVersion);
      void down.send(m).catch((e) => o.log(`relay → stdout: ${(e as Error).message}`));
    };
    up.onerror = (e) => o.log(`relay upstream: ${e.message}`);
    up.onclose = () => { o.log("relay: the server closed the session"); };
    await up.start();
  }
  down.onmessage = (m) => {
    if (!up) { fail(m, o.refuse ?? "Tatvam isn't available"); return; }
    up.send(m).catch((e) => {
      const msg = String((e as Error)?.message ?? e);
      o.log(`relay → server: ${msg}`);
      const status = /\b(401|403|404|421|429)\b/.exec(msg)?.[1];
      fail(m, status === "401" ? "Tatvam refused the token: make one in Tatvam (Settings → AI assistants) and set TATVAM_MCP_TOKEN"
        : status === "403" ? `Tatvam refused the request: ${msg.replace(/^.*Error POSTing to endpoint:\s*/, "")}`
          : status === "404" ? "The session ended in Tatvam (the user stopped it, or the app restarted): reconnect"
            : `Tatvam didn't answer: ${msg}`);
    });
  };
  down.onerror = (e) => o.log(`relay stdin: ${e.message}`);
  down.onclose = () => { void close(0); };
  const input = o.stdin ?? process.stdin;
  input.once("end", () => void close(0));
  input.once("close", () => void close(0));
  await down.start();
  return { close: () => close(0) };
}

/** The environment the node-mode relay child gets its paths from (relayViaNode → mcp/relay-node.ts). */
export const RELAY_ENV = { userData: "TATVAM_RELAY_USER_DATA", exe: "TATVAM_RELAY_EXE", args: "TATVAM_RELAY_ARGS" } as const;

/**
 * `--mcp-stdio` inside Electron: Electron's main process can't read stdin on Windows, so the relay runs in a child of
 * the same executable in plain Node mode (ELECTRON_RUN_AS_NODE) with the MCP app's pipes handed straight to it. The
 * parent opens no window and exits with the child.
 */
export function relayViaNode(o: { execPath: string; script: string; userData: string; appArgs: string[]; env: Record<string, string | undefined>; exit(code: number): void }): void {
  const env: Record<string, string | undefined> = { ...o.env, ELECTRON_RUN_AS_NODE: "1", [RELAY_ENV.userData]: o.userData, [RELAY_ENV.exe]: o.execPath,
    [RELAY_ENV.args]: JSON.stringify(o.appArgs) };
  const child = spawn(o.execPath, [o.script], { stdio: "inherit", env: env as NodeJS.ProcessEnv, windowsHide: true });
  child.on("exit", (code) => o.exit(code ?? 0));
  child.on("error", () => o.exit(1));
}

export interface RelayEnv {
  userData: string;
  /** the app to start when it isn't running: the exe and its arguments (dev: the app folder) */
  exe: string; args: string[];
  env: Record<string, string | undefined>;
  exit(code: number): void;
}

/** The relay as `--mcp-stdio` runs it inside Electron (index.ts): settings, start the app if needed, relay. */
export async function startStdioRelay(r: RelayEnv): Promise<void> {
  const logFile = path.join(r.userData, "logs", "mcp-stdio.log");
  try { mkdirSync(path.dirname(logFile), { recursive: true }); } catch { /* read-only */ }
  const log = (m: string) => {
    const line = `${new Date().toISOString()} [${process.pid}] ${m}\n`;
    try { appendFileSync(logFile, line); } catch { /* never break the protocol over a log line */ }
    try { process.stderr.write(line); } catch { /* no stderr */ }
  };
  // nothing may print to stdout but the protocol
  const toLog = (...a: unknown[]) => log(format(...a));
  console.log = toLog; console.info = toLog; console.debug = toLog; console.warn = toLog; console.error = toLog;
  process.on("uncaughtException", (e) => log(`uncaught ${(e as Error).stack ?? e}`));
  process.on("unhandledRejection", (e) => log(`unhandled ${(e as Error)?.stack ?? e}`));

  let settings = sanitizeAssistants(undefined);
  try { settings = sanitizeAssistants(JSON.parse(readFileSync(path.join(r.userData, "settings.json"), "utf8")).assistants); } catch { /* first run */ }
  const port = effectivePort(settings, r.env);
  const url = `http://127.0.0.1:${port}/mcp`;
  const token = (r.env.TATVAM_MCP_TOKEN ?? "").trim();
  let refuse: string | undefined;
  if (!/^tvd_[A-Za-z0-9_-]{20,100}$/.test(token)) refuse = "Set TATVAM_MCP_TOKEN to a token from Tatvam (Settings → AI assistants → Tokens)";
  else if (!settings.enabled) refuse = "AI assistants are off in Tatvam: turn on Settings → AI assistants → \"Allow AI assistants to control Tatvam\"";
  if (!refuse && !(await portOpen(port))) {
    log(`nothing on port ${port}: starting ${r.exe} ${r.args.join(" ")}`);
    const env = { ...r.env };
    for (const k of ["TATVAM_MCP_TOKEN", "ELECTRON_RUN_AS_NODE", RELAY_ENV.userData, RELAY_ENV.exe, RELAY_ENV.args]) delete env[k];
    try {
      const child = spawn(r.exe, r.args, { detached: true, stdio: "ignore", env: env as NodeJS.ProcessEnv, windowsHide: false });
      child.unref();
    } catch (e) { log(`start failed: ${(e as Error).message}`); }
    if (!(await waitForPort(port, 30_000))) refuse = `Tatvam didn't start its assistant server on port ${port} within 30 s (is "Allow AI assistants" on?)`;
  }
  if (refuse) log(`refusing: ${refuse}`);
  else log(`relaying to ${url}`);
  await runRelay({ url, token, refuse, log, onExit: (code) => { log(`stdin closed: exit ${code}`); r.exit(code); } });
}
