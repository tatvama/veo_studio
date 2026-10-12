/**
 * desktop-mcp end to end (docs/EDITOR.md §13), against the REAL Electron app and a running throwaway server, with the
 * official MCP SDK client over streamable HTTP and through the stdio relay. Skipped unless TATVAM_E2E_MCP=1:
 *
 *   TATVAM_E2E_MCP=1 TATVAM_SERVER=http://127.0.0.1:8191 TATVAM_E2E_EMAIL=… TATVAM_E2E_PASSWORD=… \
 *     node --test test/mcp-e2e.test.ts          (after `npm run build` here and in ../frontend)
 *
 * It makes a temp library and userData (nothing in Documents), FFmpeg-generated talking-head-like clips (testsrc2
 * picture, a lavfi sine voice with gaps over anoisesrc room noise, a mostly black take, a too-short take), starts the
 * app with CDP and TATVAM_MCP_PORT=18911, signs in, turns assistants on and makes a token through the bridge, then:
 * create_edit from the folder (answering the folder prompt) → auto_edit dry run, then apply → get_timeline and
 * get_frame → add_transition and add_effect → undo → export a draft → render_status until done → ffprobe; and the
 * same server through `electron.exe <app> --mcp-stdio`.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ON = process.env.TATVAM_E2E_MCP === "1";
const DESK = path.resolve(import.meta.dirname, "..");
const PORT = 18911;
const CDP = 9347;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type R = { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: Record<string, any>; isError?: boolean };
const textOf = (r: R) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

function ffmpeg(): string {
  const cands = [process.env.TATVAM_FFMPEG, path.join(DESK, "..", "..", "..", "..", "backend", ".venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries"),
    path.join(DESK, "..", "backend", ".venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries")];
  for (const c of cands) {
    if (!c || !existsSync(c)) continue;
    if (c.endsWith(".exe")) return c;
    const f = readdirSync(c).find((n) => /^ffmpeg.*\.exe$/i.test(n));
    if (f) return path.join(c, f);
  }
  return "ffmpeg";
}

function clip(ff: string, out: string, seconds: number, speech: string, video: string): void {
  const r = spawnSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=1280x720:r=25:d=${seconds}`, "-f", "lavfi", "-i", `sine=f=190:r=48000:d=${seconds}`,
    "-f", "lavfi", "-i", `anoisesrc=c=pink:r=48000:a=0.003:d=${seconds}`, "-filter_complex",
    `[0:v]${video}[v];[1:a]volume='if(${speech},1,0)':eval=frame,aformat=channel_layouts=mono[s];[2:a]aformat=channel_layouts=mono[n];[s][n]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[a]`,
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]);
  assert.equal(r.status, 0, String(r.stderr));
}

class Page {
  private id = 0;
  private wait = new Map<number, (d: any) => void>();
  private ws!: WebSocket;
  readonly url: string;
  private wsUrl: string;
  constructor(url: string, wsUrl: string) { this.url = url; this.wsUrl = wsUrl; }
  async open(): Promise<Page> {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id && this.wait.has(d.id)) { this.wait.get(d.id)!(d); this.wait.delete(d.id); } };
    return this;
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => { this.wait.set(id, r); setTimeout(() => { if (this.wait.delete(id)) r({ timeout: true }); }, 60_000); });
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result?.result?.value as T;
  }
  close(): void { try { this.ws.close(); } catch { /* closed */ } }
}

async function pageFor(match: (u: string) => boolean, ms = 30_000): Promise<Page> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      const t = list.find((x) => x.type === "page" && match(x.url));
      if (t) return new Page(t.url, t.webSocketDebuggerUrl).open();
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("no such page");
}

test("MCP end to end: folder → auto edit → look → transition, effect, undo → export, over HTTP and the stdio relay", { skip: !ON, timeout: 15 * 60_000 }, async () => {
  const email = process.env.TATVAM_E2E_EMAIL ?? "", password = process.env.TATVAM_E2E_PASSWORD ?? "";
  assert.ok(email && password, "TATVAM_E2E_EMAIL and TATVAM_E2E_PASSWORD (a user of the throwaway server)");
  const root = mkdtempSync(path.join(os.tmpdir(), "tvd-mcp-e2e-"));
  const ud = path.join(root, "ud"), lib = path.join(root, "lib"), shoot = path.join(root, "Shoot Day1");
  for (const d of [ud, lib, shoot]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ serverUrl: process.env.TATVAM_SERVER ?? "http://127.0.0.1:8191", libraryRoot: lib }));
  const ff = ffmpeg();
  clip(ff, path.join(shoot, "Day1_001.mp4"), 12, "between(t,0.3,3.2)+between(t,4.8,8.0)+between(t,9.6,11.8)", "hue=h=0");
  clip(ff, path.join(shoot, "Day1_002.mp4"), 10, "between(t,0,4)+between(t,6,10)", "hue=h=90");
  clip(ff, path.join(shoot, "Day1_003.mp4"), 6, "between(t,0,6)", "drawbox=enable='lt(t,5)':c=black:t=fill");
  clip(ff, path.join(shoot, "Day1_004.mp4"), 0.7, "between(t,0,0.7)", "hue=h=300");
  const exe = path.join(DESK, "node_modules", "electron", "dist", "electron.exe");
  const env = { ...process.env, TATVAM_USER_DATA: ud, TATVAM_UI_DIR: path.join(DESK, "..", "frontend", "dist"), TATVAM_NO_UPDATES: "1", TATVAM_MCP_PORT: String(PORT) };
  let app: ChildProcess | null = spawn(exe, [DESK, `--remote-debugging-port=${CDP}`], { env, stdio: "ignore" });
  const http = new Client({ name: "claude-code", version: "e2e" });
  try {
    const main = await pageFor((u) => u.startsWith("http://127.0.0.1:"));
    await sleep(2500);
    const login = await main.eval<number>(`fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json','X-Requested-With':'veo-studio'},
      body: JSON.stringify(${JSON.stringify({ email, password })})}).then(r => r.status)`);
    assert.equal(login, 200);
    await main.send("Page.navigate", { url: `${new URL(main.url).origin}/editor` });
    await sleep(2500);
    const off = await main.eval<{ enabled: boolean }>(`window.tatvamDesktop.assistants.state()`);
    assert.equal(off.enabled, false, "off by default");
    const on = await main.eval<{ running: boolean }>(`window.tatvamDesktop.assistants.setEnabled(true)`);
    assert.equal(on.running, true);
    const token = await main.eval<string>(`window.tatvamDesktop.assistants.createToken('E2E', ['read','edit','export']).then(r => r.token)`);

    await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await http.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })) as R;
      assert.ok(!r.isError, `${name}: ${textOf(r)}`);
      return r;
    };
    assert.ok((await http.listTools()).tools.length >= 40);
    // 1. an edit from the folder (outside the library: the prompt is answered in the editor window)
    await call("create_edit", { name: "Warmup" });
    const ed = await pageFor((u) => u.includes("/editor/edit?path="));
    await sleep(2000);
    const created = call("create_edit", { name: "Day1", from_folder: shoot });
    for (let i = 0; i < 40; i++) {
      if (await ed.eval<boolean>(`(() => { const b = [...document.querySelectorAll('[role=alertdialog] button')].find(x => x.textContent.trim() === 'Allow once'); if (b) { b.click(); return true; } return false; })()`)) break;
      await sleep(500);
    }
    const made = await created;
    assert.equal(made.structuredContent?.media.length, 4);
    await sleep(2500);
    // 2. auto edit: the plan, then the sequence
    const dry = await call("auto_edit", { style: "talking_head", dry_run: true });
    const sum = dry.structuredContent?.summary;
    assert.equal(sum.clipsIn, 4);
    assert.equal(sum.clipsUsed, 2, "the black take and the 0.7 s take are left out");
    assert.ok(sum.silenceRemoved > 4, `silence removed ${sum.silenceRemoved}`);
    const applied = await call("auto_edit", { style: "talking_head" });
    assert.match(textOf(applied), /Made "Auto edit · Shoot Day1 · Talking head \/ vlog"/);
    // 3. look
    const tl = await call("get_timeline");
    const clips = tl.structuredContent!.clips as { id: string; track: string }[];
    assert.ok(Math.abs(tl.structuredContent!.duration - sum.length) < 0.1);
    const frame = await call("get_frame", { at: 2 });
    const png = frame.content!.find((c) => c.type === "image");
    assert.equal(png?.mimeType, "image/png");
    assert.ok(Buffer.from(png!.data!, "base64").subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    // 4. a transition and an effect, 5. undo
    const v1 = clips.filter((c) => c.track === "V1");
    await call("add_transition", { clip_id: v1[1].id, edge: "in", duration: 0.5 });
    await call("add_effect", { clip_ids: [v1[0].id], effect: "vignette" });
    const fx = (r: R) => (r.structuredContent!.clips as { effects: unknown[] }[]).reduce((n, c) => n + c.effects.length, 0);
    const before = fx(await call("get_timeline"));
    assert.match(textOf(await call("undo")), /Undid Assistant: add_effect/);
    const after = await call("get_timeline");
    assert.equal(fx(after), before - 1);
    assert.equal((after.structuredContent!.transitions as unknown[]).length, 1);
    // 6. export a draft, 7. follow it
    const ex = await call("export", { name: "Day1 draft" });
    assert.equal(ex.structuredContent!.preset, "draft720", "the default export is the 720p draft");
    let st: R | null = null;
    for (let i = 0; i < 40; i++) {
      st = await call("render_status", { render_id: ex.structuredContent!.render_id, wait_seconds: 15 });
      if (["done", "failed", "cancelled"].includes(st.structuredContent!.status)) break;
    }
    assert.equal(st!.structuredContent!.status, "done", textOf(st!));
    const out = st!.structuredContent!.output as string;
    assert.ok(out.startsWith(path.join(lib, "Edits")), "into the library's Renders folder");
    const probe = String(spawnSync(ff, ["-hide_banner", "-i", out], { encoding: "utf8" }).stderr);
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe)!;
    assert.ok(Math.abs(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) - sum.length) < 0.2, probe);
    assert.match(probe, /Video: h264/);
    assert.match(probe, /Audio: aac/);
    // the same through the stdio relay
    const relay = new StdioClientTransport({ command: exe, args: [DESK, "--mcp-stdio"], env: { ...env, TATVAM_MCP_TOKEN: token } as Record<string, string> });
    const rc = new Client({ name: "claude-ai", version: "e2e" });
    await rc.connect(relay);
    assert.equal((await rc.listTools()).tools.length, (await http.listTools()).tools.length);
    const rtl = (await rc.callTool({ name: "get_timeline", arguments: {} })) as R;
    assert.equal((rtl.structuredContent!.clips as unknown[]).length, clips.length);
    await rc.close();
    ed.close();
    main.close();
  } finally {
    await http.close().catch(() => undefined);
    app?.kill();
    app = null;
    await sleep(1500);
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
