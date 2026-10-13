// Bundles the main process (CommonJS, Node 24) and the sandboxed preload (CommonJS, only `electron` external).
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const define = { __APP_VERSION__: JSON.stringify(pkg.version) };

rmSync(join(root, "dist"), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: "linked",
  // runtime dependencies stay in node_modules (electron-builder packs them); ws' native helpers are optional
  external: ["electron", "ws", "electron-updater", "ffmpeg-static", "bufferutil", "utf-8-validate"],
  define,
  logLevel: "warning",
});
await build({
  absWorkingDir: root,
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "browser",
  target: "es2024",
  format: "cjs", // sandboxed preloads must be CommonJS and may only require("electron")
  external: ["electron"],
  define,
  logLevel: "warning",
});
await build({ // the Studio server window's own bridge (main/connect.ts)
  absWorkingDir: root,
  entryPoints: ["src/preload/connect.ts"],
  outfile: "dist/connect-preload.cjs",
  bundle: true,
  platform: "browser",
  target: "es2024",
  format: "cjs",
  external: ["electron"],
  logLevel: "warning",
});
// desktop-mcp: the stdio relay runs in Node mode (ELECTRON_RUN_AS_NODE), so it is its own bundle without Electron
await build({
  absWorkingDir: root,
  entryPoints: ["src/main/mcp/relay-node.ts"],
  outfile: "dist/mcp-relay.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  define,
  logLevel: "warning",
});
console.log(`bundled main + preload (v${pkg.version}) into dist/`);
