// `npm run dev` from the repo root: starts the API (uvicorn, :8100) and the web app (Vite, :5173) together.
// Ctrl+C stops both; if either one exits, the other is stopped too.
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const only = process.argv[2]; // "api" | "web" | undefined (both)

const python = join(ROOT, "backend", ".venv", WIN ? "Scripts/python.exe" : "bin/python");
const vite = join(ROOT, "frontend", "node_modules", "vite", "bin", "vite.js");

const procs = [];
if (only !== "web") {
  if (!existsSync(python)) fail("backend/.venv not found — run `npm run setup` first.");
  procs.push(start("api", "\x1b[36m", python, ["-m", "uvicorn", "app.main:app", "--port", "8100", "--reload"], "backend"));
}
if (only !== "api") {
  if (!existsSync(vite)) fail("frontend/node_modules not found — run `npm run setup` first.");
  procs.push(start("web", "\x1b[35m", process.execPath, [vite, "--port", "5173"], "frontend"));
}
if (!only) console.log("\n  Open http://localhost:5173  (API on http://localhost:8100)\n");

function start(name, color, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd: join(ROOT, cwd), env: { ...process.env, FORCE_COLOR: "1" } });
  const tag = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(tag + l + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${tag}exited (${code ?? "signal"})`);
    stopAll(code ?? 0);
  });
  return child;
}

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    if (p.exitCode !== null) continue;
    // uvicorn --reload runs the app in a child process; kill the whole tree so port 8100 is freed
    if (WIN) { try { execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: "ignore" }); } catch {} }
    else p.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 300);
}

function fail(msg) {
  console.error(`\x1b[31m${msg}\x1b[0m`);
  process.exit(1);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
