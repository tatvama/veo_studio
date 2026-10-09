// `npm run setup` from the repo root: creates backend/.venv, installs Python packages and the web app's npm packages.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const run = (cmd, cwd = ROOT) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

const venv = join(ROOT, "backend", ".venv");
const python = join(venv, WIN ? "Scripts/python.exe" : "bin/python");
if (!existsSync(python)) run(`${WIN ? "py -3.12" : "python3.12"} -m venv .venv`, join(ROOT, "backend"));
run(`"${python}" -m pip install -r requirements.txt`, join(ROOT, "backend"));
run("npm ci --no-audit --no-fund", join(ROOT, "frontend"));

console.log("\nDone. Start both with: npm run dev");
