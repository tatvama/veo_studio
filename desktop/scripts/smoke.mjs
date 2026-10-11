// npm run smoke: bundle, start the app with TATVAM_SMOKE=1 and a throw-away userData folder, print the app's one
// `TATVAM_SMOKE {json}` status line and exit with its result. TATVAM_SERVER picks the studio server (default
// http://localhost:8100); TATVAM_UI_DIR the built UI. On an already set-up server only anonymous paths are checked
// unless TATVAM_SMOKE_EMAIL / TATVAM_SMOKE_PASSWORD are set.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { cwd: root, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

const userData = mkdtempSync(path.join(os.tmpdir(), "tatvam-smoke-"));
const env = { ...process.env, TATVAM_SMOKE: "1", TATVAM_USER_DATA: userData, TATVAM_NO_UPDATES: "1" };
const child = spawn(electronPath, ["."], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let line = "";
let buf = "";
const onData = (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (l.startsWith("TATVAM_SMOKE ")) line = l;
    else if (process.env.TATVAM_SMOKE_VERBOSE) console.error(l);
  }
};
child.stdout.on("data", onData);
child.stderr.on("data", (d) => { if (process.env.TATVAM_SMOKE_VERBOSE) process.stderr.write(d); });
const kill = setTimeout(() => {
  console.error("smoke: the app didn't finish in 120 s");
  child.kill();
}, 120_000);
child.on("exit", (code) => {
  clearTimeout(kill);
  if (buf.trim().startsWith("TATVAM_SMOKE ")) line = buf.trim();
  console.log(line || `TATVAM_SMOKE ${JSON.stringify({ ok: false, error: `the app exited (${code}) without a status line` })}`);
  if (!process.env.TATVAM_SMOKE_KEEP) rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  process.exit(line && JSON.parse(line.slice("TATVAM_SMOKE ".length)).ok ? 0 : 1);
});
