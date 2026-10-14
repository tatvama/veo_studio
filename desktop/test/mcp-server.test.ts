/**
 * The local MCP server end to end in Node (src/main/mcp/server.ts, tools.ts, stdio.ts; docs/EDITOR.md §13): the
 * official SDK client over streamable HTTP and through the stdio relay, against fake editor windows. Covers the auth
 * (missing / bad token, scopes), the Host and Origin refusals with no CORS, pause and stop, the folder prompt, the
 * export confinement, the rate limit, the tool schema snapshot and the relay's framing.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ActivityLog } from "../src/main/mcp/activity.ts";
import { Analyzer } from "../src/main/mcp/analyze.ts";
import { FolderGuard } from "../src/main/mcp/folders.ts";
import { McpJobs } from "../src/main/mcp/jobs.ts";
import { EditorLink } from "../src/main/mcp/link.ts";
import { AssistantServer, displayName } from "../src/main/mcp/server.ts";
import { runRelay } from "../src/main/mcp/stdio.ts";
import { TokenStore } from "../src/main/mcp/tokens.ts";
import { TOOLS, type McpDeps } from "../src/main/mcp/tools.ts";
import type { AssistantCall, FolderPromptRequest } from "../src/shared/types.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "tvd-mcp-"));
const LIB = path.join(dir, "Library");
const PORT = 18911 + Math.floor(Math.random() * 400) + 50; // never 18110
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const SNAPSHOT = path.join(import.meta.dirname, "fixtures", "mcp-tools.snapshot.json");

const prompts: FolderPromptRequest[] = [];
let answerWith: "once" | "always" | "deny" | null = "deny";
const calls: AssistantCall[] = [];

const tokens = new TokenStore(path.join(dir, "tokens.json"), { available: () => true, encrypt: (s) => Buffer.from(s).toString("base64"),
  decrypt: (b) => Buffer.from(b, "base64").toString() });
const activity = new ActivityLog(path.join(dir, "activity.jsonl"));
const folders = new FolderGuard({ libraryRoot: () => LIB, folders: () => [], addFolder: () => undefined, close: () => undefined, timeoutMs: 300,
  show: (p) => { prompts.push(p); if (answerWith) setTimeout(() => folders.answer(p.id, answerWith!), 5); } });
const link: EditorLink = new EditorLink((windowId, call) => {
  calls.push(call);
  // a fake editor window: answers like frontend/src/automation/bridge would
  setTimeout(() => {
    const r = ((): unknown => {
      switch (call.tool) {
        case "get_timeline": return { text: "Sequence 01: 1920×1080 at 25 fps, 0 s (00:00:00:00), 0 clips", data: { sequence_id: "s1", clips: [] } };
        case "save_edit": return { text: "Saved", data: { sequence_id: "s1" } };
        case "__media": return { data: { media: [] } };
        case "add_marker": return { text: `Marker at ${call.args.at} s`, data: { marker_id: "m1" } };
        default: return { text: `${call.tool} done`, data: {} };
      }
    })();
    link.reply(windowId, call.id, { ok: true, result: r });
  }, 2);
  return true;
});
const editPath = path.join(LIB, "Edits", "Test", "Test.tatvamedit");
const outside = path.join(dir, "Elsewhere", "Mine.tatvamedit");
const mcp: McpDeps = {
  editor: {
    list: async () => [{ path: editPath, name: "Test", modified: "2026-10-12T10:00:00.000Z" }],
    create: async () => { throw new Error("not in this test"); },
    save: async () => ({ modified: new Date().toISOString() }),
    importMedia: async () => [],
    export: async () => "render-0001",
    allowEditFile: () => undefined,
    editsRoot: () => path.join(LIB, "Edits"),
  },
  renders: {
    presets: async () => [{ id: "review1080", label: "Review 1080p (fast)", w: 1920, h: 1080, fps: 0, codec: "h264", container: "mp4" },
      { id: "draft720", label: "Draft 720p", w: 1280, h: 720, fps: 0, codec: "h264", container: "mp4" }],
    get: (id) => (id === "render-0001" ? { id, pid: 0, eid: 0, lang: "", preset: "review1080", status: "done", progress: 1, step: "Done", output: "x.mp4",
      duration_s: 12.5, fps: 25, w: 1920, h: 1080, options: { effects: true, captions: false, music: true, upscaled: false, localUpscale: false, upload: false },
      warnings: [], createdAt: "", upload: { state: "idle" } } : undefined),
    cancel: () => undefined,
  },
  link, folders, jobs: new McpJobs(),
  analyzer: new Analyzer({ analyze: async () => { throw new Error("no"); }, ffmpegLines: async () => undefined, log: () => undefined }),
  libraryRoot: () => LIB,
  showEdit: async () => undefined,
  log: () => undefined,
};
let changes = 0;
const server = new AssistantServer({ tokens, activity, folders, mcp, version: "3.0.0-test", log: () => undefined, onChange: () => { changes++; },
  limits: { requests: 1000, calls: 40 } });
const full = tokens.create("Test full", ["read", "edit", "export"]);
const readOnly = tokens.create("Test read", ["read"]);

async function connect(token: string, name = "test-client"): Promise<Client> {
  const c = new Client({ name, version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

function raw(headers: Record<string, string>, method = "POST", body = "{}"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: PORT, path: "/mcp", method, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } }, (res) => {
      let b = "";
      res.on("data", (d) => { b += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    if (method !== "GET" && method !== "OPTIONS") r.write(body);
    r.end();
  });
}

const textOf = (r: unknown) => (((r as { content?: unknown }).content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("\n");

before(async () => { await server.start(PORT); link.attach(7, editPath, { name: "Test", dirty: false }); });
after(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });

test("refused before MCP: no token, a bad token, a browser Origin, a foreign Host, a CORS preflight", async () => {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
  const host = `127.0.0.1:${PORT}`;
  const none = await raw({ Host: host }, "POST", init);
  assert.equal(none.status, 401);
  assert.match(String(none.headers["www-authenticate"]), /^Bearer /);
  assert.equal((await raw({ Host: host, Authorization: "Bearer tvd_this-is-not-a-real-token-000000" }, "POST", init)).status, 401);
  const browser = await raw({ Host: host, Authorization: `Bearer ${full.token}`, Origin: "https://evil.example" }, "POST", init);
  assert.equal(browser.status, 403);
  assert.equal(browser.headers["access-control-allow-origin"], undefined, "no CORS");
  assert.equal((await raw({ Host: `evil.example:${PORT}`, Authorization: `Bearer ${full.token}` }, "POST", init)).status, 421, "DNS rebinding");
  const pre = await raw({ Host: host, Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }, "OPTIONS");
  assert.notEqual(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-origin"], undefined);
  assert.ok(activity.list(20).some((a) => !a.ok && /Refused \(403\)/.test(a.summary ?? "")), "refusals are in the activity log");
});

test("the SDK client connects with a token, lists the tools, and status answers in plain text", async () => {
  const c = await connect(full.token, "claude-ai");
  try {
    assert.equal(c.getServerVersion()?.name, "tatvam-desktop");
    assert.match(c.getInstructions() ?? "", /status/);
    const { tools } = await c.listTools();
    assert.equal(tools.length, TOOLS.length);
    assert.ok(tools.length >= 40, `${tools.length} tools`);
    const r = await c.callTool({ name: "status", arguments: {} });
    assert.match(textOf(r), /Scopes: read, edit, export\./);
    assert.deepEqual((r.structuredContent as { scopes: string[] }).scopes, ["read", "edit", "export"]);
    const s = server.sessionInfos();
    assert.equal(s.length, 1);
    assert.equal(s[0].client, "Claude Desktop", "clientInfo.name claude-ai is shown as Claude Desktop");
    // a timeline tool goes to the editor window as "Assistant: <tool>"
    const m = await c.callTool({ name: "add_marker", arguments: { at: 2.5, name: "Hook" } });
    assert.equal(m.isError, undefined);
    const last = calls[calls.length - 1];
    assert.equal(last.tool, "add_marker");
    assert.equal(last.label, "Assistant: add_marker");
    assert.equal(last.client, "Claude Desktop");
  } finally { await c.close(); }
});

test("tool schemas match the snapshot (names, required fields, types)", async () => {
  const c = await connect(full.token);
  try {
    const { tools } = await c.listTools();
    const snap = tools.map((t) => ({ name: t.name, readOnly: Boolean(t.annotations?.readOnlyHint), input: t.inputSchema }));
    if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(SNAPSHOT)) writeFileSync(SNAPSHOT, `${JSON.stringify(snap, null, 2)}\n`);
    assert.deepEqual(snap, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
    for (const t of tools) {
      assert.ok((t.description ?? "").length > 30 && (t.description ?? "").length < 520, `${t.name}: a short description for a model`);
      assert.equal(t.inputSchema.type, "object");
    }
  } finally { await c.close(); }
});

test("scopes: a read-only token can look but not change, export or approve", async () => {
  const c = await connect(readOnly.token);
  try {
    const ok = await c.callTool({ name: "get_timeline", arguments: {} });
    assert.equal(ok.isError, undefined);
    for (const [name, args] of [["save_edit", {}], ["delete_clips", { clip_ids: ["c1"] }], ["export", { preset: "review1080" }],
      ["run_ai_tool", { tool: "music", args: { prompt: "x", seconds: 10 }, approve: true }]] as const) {
      const r = await c.callTool({ name, arguments: args as Record<string, unknown> });
      assert.equal(r.isError, true, name);
      assert.match(textOf(r), /lacks the "(edit|export|spend)"/, name);
    }
    const dry = await c.callTool({ name: "auto_edit", arguments: { style: "montage", dry_run: true } });
    assert.doesNotMatch(textOf(dry), /lacks/, "a dry run only needs read");
  } finally { await c.close(); }
});

test("folders outside the library prompt the user; Deny refuses, Allow once lets it through", async () => {
  const c = await connect(full.token);
  try {
    answerWith = "deny";
    const before = prompts.length;
    // native paths outside the library (they needn't exist: the prompt comes first)
    const r = await c.callTool({ name: "import_media", arguments: { paths: [path.join(dir, "Shoots", "Day1", "a.mp4")] } });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /didn't allow/);
    assert.equal(prompts.length, before + 1);
    assert.equal(prompts[prompts.length - 1].folder, path.join(dir, "Shoots", "Day1"));
    answerWith = null; // nobody answers: denied after the timeout
    const slow = await c.callTool({ name: "import_media", arguments: { paths: [path.join(dir, "Slow", "b.mp4")] } });
    assert.match(textOf(slow), /didn't answer within 60 s|didn't allow/);
    answerWith = "once";
    const once = await c.callTool({ name: "import_media", arguments: { paths: [path.join(dir, "Once", "c.exe")] } });
    assert.match(textOf(once), /only media and interchange files/, "a program is never read, prompt or not");
    const rel = await c.callTool({ name: "import_media", arguments: { paths: [path.join("Shoots", "a.mp4")] } });
    assert.match(textOf(rel), /Give a full path/, "a relative path is refused before anything else");
  } finally { await c.close(); answerWith = "deny"; }
});

test("exports: only edits in the library, into their Renders folder; render_status reports the file", async () => {
  const c = await connect(full.token);
  try {
    const ok = await c.callTool({ name: "export", arguments: { preset: "review1080" } });
    assert.equal(ok.isError, undefined, textOf(ok));
    assert.match(textOf(ok), /render-0001/);
    assert.equal((ok.structuredContent as { folder: string }).folder, path.join(path.dirname(editPath), "Renders"));
    const draft = await c.callTool({ name: "export", arguments: {} });
    assert.equal((draft.structuredContent as { preset: string }).preset, "draft720", "a draft by default");
    const bad = await c.callTool({ name: "export", arguments: { preset: "review1080", name: "..\\..\\evil" } });
    assert.match(textOf(bad), /plain name/);
    const st = await c.callTool({ name: "render_status", arguments: { render_id: "render-0001" } });
    assert.match(textOf(st), /done/);
    assert.match(textOf(st), /12\.5 s \(00:00:12:12\)/, "seconds and timecode");
    link.attach(8, outside, { name: "Mine", dirty: false });
    const o = await c.callTool({ name: "open_edit", arguments: { path: outside } });
    assert.equal(o.isError, true, "outside the library: the user is asked (and here says no)");
  } finally { await c.close(); link.detach(8); }
});

test("§15 tools: add_sfx (edit scope) and list_catalog's looks, audio_presets and sfx go to the editor window", async () => {
  const t = tokens.create("SFX", ["read", "edit"]), ro = tokens.create("SFX read", ["read"]);
  const c = await connect(t.token);
  try {
    const none = await c.callTool({ name: "add_sfx", arguments: { at: 1 } });
    assert.equal(none.isError, true);
    assert.match(textOf(none), /preset .*or tag/, "a preset or a tag, before the window is asked");
    const ok = await c.callTool({ name: "add_sfx", arguments: { tag: "whoosh", at: 2.5, gain_db: -6, seed: 3 } });
    assert.equal(ok.isError, undefined, textOf(ok));
    const last = calls[calls.length - 1];
    assert.deepEqual([last.tool, last.label, last.args.tag, last.args.at, last.args.gain_db, last.args.seed], ["add_sfx", "Assistant: add_sfx", "whoosh", 2.5, -6, 3]);
    const loud = await c.callTool({ name: "add_sfx", arguments: { preset: "impact.boom_deep", at: 0, gain_db: 30 } });
    assert.equal(loud.isError, true, "gain_db is capped at +12 dB");
    for (const kind of ["looks", "audio_presets", "sfx"]) {
      const r = await c.callTool({ name: "list_catalog", arguments: { kind, search: "x" } });
      assert.equal(r.isError, undefined, kind);
      assert.deepEqual([calls[calls.length - 1].tool, calls[calls.length - 1].args.kind], ["list_catalog", kind]);
    }
    assert.equal((await c.callTool({ name: "list_catalog", arguments: { kind: "sounds" } })).isError, true);
    const fx = await c.callTool({ name: "add_effect", arguments: { clip_ids: ["a1"], effect: "preset:youtube_voice" } });
    assert.equal(fx.isError, undefined);
    assert.equal(calls[calls.length - 1].args.effect, "preset:youtube_voice", "a chain preset id passes through");
    const look = await c.callTool({ name: "apply_mood", arguments: { mood: "cinematic.teal_orange" } });
    assert.equal(look.isError, undefined);
  } finally { await c.close(); }
  const r = await connect(ro.token);
  try {
    assert.match(textOf(await r.callTool({ name: "add_sfx", arguments: { preset: "whoosh.fast", at: 0 } })), /lacks the "edit"/);
  } finally { await r.close(); }
});

test("pause holds tool calls until resume; stop ends the session and refuses a new one for a while", async () => {
  const c = await connect(full.token);
  server.setPaused(true);
  let done = false;
  const p = c.callTool({ name: "status", arguments: {} }).then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(done, false, "waiting while paused");
  server.setPaused(false);
  const r = await p;
  assert.match(textOf(r), /Scopes/);
  await server.stopSessions();
  assert.equal(server.sessionInfos().length, 0);
  await assert.rejects(c.callTool({ name: "status", arguments: {} }));
  await assert.rejects(connect(full.token), /403|stopped/);
  await c.close().catch(() => undefined);
});

test("the rate limit answers with a tool error", async () => {
  const t = tokens.create("Busy", ["read"]);
  const c = await connect(t.token);
  try {
    let limited = false;
    for (let i = 0; i < 45 && !limited; i++) {
      const r = await c.callTool({ name: "list_formats", arguments: {} });
      if (r.isError && /Too many tool calls/.test(textOf(r))) limited = true;
    }
    assert.equal(limited, true);
  } finally { await c.close(); }
});

test("stdio relay: newline-delimited JSON-RPC both ways, and it exits when stdin closes", async () => {
  const t = tokens.create("Relay", ["read"]);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let exited = -1;
  const lines: Record<string, unknown>[] = [];
  let buf = "";
  stdout.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) lines.push(JSON.parse(l)); }
  });
  const waitFor = async (id: number) => {
    for (let k = 0; k < 200; k++) { const m = lines.find((x) => x.id === id); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`no answer ${id}`);
  };
  await runRelay({ url: URL_, token: t.token, stdin, stdout, log: () => undefined, onExit: (code) => { exited = code; } });
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "0.9" } } })}\n`);
  const init = await waitFor(1) as { result: { serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, "tatvam-desktop");
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const list = await waitFor(2) as { result: { tools: unknown[] } };
  assert.equal(list.result.tools.length, TOOLS.length);
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_formats", arguments: {} } })}\n`);
  const call = await waitFor(3) as { result: { content: { text: string }[] } };
  assert.match(call.result.content[0].text, /1080p/);
  assert.ok(server.sessionInfos().some((s) => s.client === "Codex"), "the relay passes the client's own clientInfo");
  stdin.end();
  for (let k = 0; k < 100 && exited < 0; k++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(exited, 0);
  // refused mode (no token, server off): every request gets a clear error, nothing hangs
  const in2 = new PassThrough();
  const out2 = new PassThrough();
  let got = "";
  out2.on("data", (d) => { got += String(d); });
  await runRelay({ url: URL_, token: "", refuse: "AI assistants are off in Tatvam", stdin: in2, stdout: out2, log: () => undefined, onExit: () => undefined });
  in2.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} })}\n`);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(got, /"id":9.*AI assistants are off/);
  in2.end();
});

test("display names: known MCP apps by product name, others by clientInfo", () => {
  assert.equal(displayName({ name: "claude-code" }, "t"), "Claude Code");
  assert.equal(displayName({ name: "codex-mcp-client" }, "t"), "Codex");
  assert.equal(displayName({ name: "my-agent", title: "My Agent" }, "t"), "My Agent");
  assert.equal(displayName(undefined, "Token name"), "Token name");
  assert.ok(changes > 0, "the banner and Settings were told");
});
