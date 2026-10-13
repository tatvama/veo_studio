/**
 * `npm run smoke` (TATVAM_SMOKE=1): load the UI through the gateway, sign in (first-run setup on an empty server,
 * or TATVAM_SMOKE_EMAIL / TATVAM_SMOKE_PASSWORD), call the API with the cookie from the page and from the main
 * process, open /api/ws through the gateway, check the bridge, then print one `TATVAM_SMOKE {json}` line and quit.
 * On a server that is already set up and no credentials given, it checks the anonymous paths only.
 */
import { randomBytes } from "node:crypto";
import { app, session, type BrowserWindow } from "electron";
import type { AppCtx } from "./ipc.ts";
import { COOKIE } from "./upstream.ts";

type Check = { ok: boolean; [k: string]: unknown };

async function inPage<T>(win: BrowserWindow, code: string): Promise<T> {
  return (await win.webContents.executeJavaScript(code, true)) as T;
}

export async function runSmoke(ctx: AppCtx, win: BrowserWindow): Promise<void> {
  const out: Record<string, Check> = {};
  const t0 = Date.now();
  const timeout = setTimeout(() => {
    console.log(`TATVAM_SMOKE ${JSON.stringify({ ok: false, error: "timeout", checks: out })}`);
    app.exit(2);
  }, 90_000);
  try {
    if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once("did-finish-load", () => r()));
    // 1. the UI through the gateway
    const page = await fetch(`${ctx.gateway.url}/`);
    const html = await page.text();
    const root = await inPage<boolean>(win, "Boolean(document.getElementById('root'))");
    const spa = await fetch(`${ctx.gateway.url}/p/1/finish`);
    out.ui = { ok: page.status === 200 && html.includes("<div id=\"root\"") && root && spa.status === 200, status: page.status,
      title: win.webContents.getTitle(), spaFallback: spa.status };
    // 2. sign in from the page, so the cookie lands on the gateway origin
    const st = await inPage<{ status: number; setup_needed?: boolean }>(win,
      "fetch('/api/auth/status').then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }))");
    const envEmail = process.env.TATVAM_SMOKE_EMAIL;
    const envPass = process.env.TATVAM_SMOKE_PASSWORD;
    const signIn = Boolean(st.setup_needed) || Boolean(envEmail && envPass);
    const email = (envEmail || `smoke-${randomBytes(4).toString("hex")}@tatvam.test`).toLowerCase();
    if (signIn) {
      const password = envPass || randomBytes(18).toString("base64url");
      const status = await inPage<number>(win, `fetch(${JSON.stringify(st.setup_needed ? "/api/auth/setup" : "/api/auth/login")}, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'veo-studio' },
        body: JSON.stringify({ email: ${JSON.stringify(email)}, name: 'Smoke test', password: ${JSON.stringify(password)} }) }).then(r => r.status)`);
      const [c] = await session.defaultSession.cookies.get({ url: ctx.gateway.url, name: COOKIE });
      out.auth = { ok: status === 200 && Boolean(c) && !c.secure && (c.hostOnly ?? true), status, firstRunSetup: Boolean(st.setup_needed),
        cookie: c ? { domain: c.domain, hostOnly: c.hostOnly, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite } : null };
      // 3. the API with that cookie: from the page through the gateway, and from the main process straight to the server
      const me = await inPage<{ status: number; email?: string }>(win, "fetch('/api/auth/me').then(async r => ({ status: r.status, email: ((await r.json().catch(() => ({}))).user || {}).email }))");
      let mainStatus = 0;
      try { mainStatus = (await ctx.upstream.fetch("/api/auth/me", { timeoutMs: 10_000 })).status; } catch { mainStatus = -1; }
      out.api = { ok: me.status === 200 && mainStatus === 200 && me.email === email, page: me.status, mainProcess: mainStatus, sameUser: me.email === email };
    } else {
      out.auth = { ok: st.status === 200, skipped: "the server is already set up: set TATVAM_SMOKE_EMAIL and TATVAM_SMOKE_PASSWORD to sign in" };
      out.api = { ok: st.status === 200, page: st.status, anonymous: true };
    }
    // 4. the event socket through the gateway
    out.ws = await inPage<Check>(win, `new Promise((resolve) => {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/api/ws');
      const t = setTimeout(() => resolve({ ok: false, error: 'no open in 8 s' }), 8000);
      ws.onopen = () => { clearTimeout(t); setTimeout(() => ws.close(), 50); resolve({ ok: true }); };
      ws.onerror = () => { clearTimeout(t); resolve({ ok: false, error: 'socket error' }); };
    })`);
    // 5. the bridge
    out.bridge = await inPage<Check>(win, `(async () => {
      const d = window.tatvamDesktop;
      if (!d) return { ok: false, error: 'no bridge' };
      const info = await d.info();
      const off = await d.offline.status();
      const presets = await d.render.presets();
      const unsub = d.sync.onProgress(() => {});
      unsub();
      const displays = await d.windows.displays();
      const wid = await d.windows.popOut('program', { pid: 1, eid: 1 });
      await new Promise((r) => setTimeout(r, 1500));
      const list = await d.windows.list();
      await d.windows.close(wid);
      const workspaces = await d.windows.workspaces();
      return { ok: info.gatewayUrl === location.origin && off.online === true && Array.isArray(presets)
          && list.some((w) => w.id === wid && w.panel === 'program') && workspaces.length >= 5,
        version: d.version, platform: d.platform, machine: info.machine, presets: presets.map((p) => p.id + ':' + (p.hardware || 'cpu')),
        displays: displays.length, popOut: list.find((w) => w.id === wid) || null, workspaces: workspaces.map((w) => w.name) };
    })()`);
    // 5b. the editor bridge (read-only: the smoke's library is the real one, so nothing is created)
    out.editor = await inPage<Check>(win, `(async () => {
      const e = window.tatvamDesktop.editor;
      if (!e) return { ok: false, error: 'no editor bridge' };
      const edits = await e.list();
      const shaders = await e.shaders();
      const drop = e.pathsForDrop([]);
      const refused = await e.open('C:\\\\nowhere\\\\x.tatvamedit').then(() => 'opened', (err) => String(err.message || err));
      return { ok: Array.isArray(edits) && Array.isArray(shaders) && Array.isArray(drop) && drop.length === 0 && /wasn't opened in Tatvam/.test(refused),
        edits: edits.length, shaders: shaders.length, refused };
    })()`);
    // 6. the machine check
    out.machine = await inPage<Check>(win, `window.tatvamDesktop.media.machineCheck().then((m) => ({ ok: Boolean(m.verdict && m.baseline && m.encoders),
      verdict: m.verdict, nvenc: m.nvenc, gpu: (m.gpus || [])[0], ramGb: Math.round((m.ramBytes || 0) / 1073741824), disk: m.disk && m.disk.kind,
      baseline: (m.baseline.items || []).map((i) => i.label + '=' + (i.ok ? 'ok' : 'below')), notes: m.notes }))`);
    // 6. FFmpeg on this PC
    const ff = ctx.ff();
    out.ffmpeg = { ok: Boolean(ff), path: ff?.path, version: ff?.version, source: ff?.source };
  } catch (e) {
    out.error = { ok: false, error: String((e as Error).stack || e) };
  } finally {
    clearTimeout(timeout);
  }
  const ok = Object.values(out).every((c) => c.ok);
  console.log(`TATVAM_SMOKE ${JSON.stringify({ ok, ms: Date.now() - t0, gateway: ctx.gateway.url, server: ctx.config.get().serverUrl, checks: out })}`);
  setTimeout(() => app.exit(ok ? 0 : 1), 200);
}
