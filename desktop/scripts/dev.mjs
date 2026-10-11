// npm run dev: bundle, make sure a UI build exists, then start Electron on this folder.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(process.execPath, [join(root, "scripts", "build.mjs")], root);
const frontend = join(root, "..", "frontend");
if (!process.env.TATVAM_UI_DIR && !existsSync(join(frontend, "dist", "index.html"))) {
  if (existsSync(join(frontend, "node_modules"))) {
    console.log("frontend/dist is missing: building the UI once (npm run build in frontend/)");
    run("npm", ["run", "build"], frontend);
  } else {
    console.log("frontend/dist is missing and frontend/node_modules isn't installed: the gateway will show the server's UI");
  }
}
const child = spawn(electronPath, ["."], { cwd: root, stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
