import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = process.env.VEO_API ?? "http://localhost:8100";

/**
 * Emits dist/sw.js from public/sw.js with this build's id and its JS/CSS files filled in, so the service worker
 * precaches exactly the current build (and changes byte-for-byte per build, which is what makes browsers install it).
 */
function serviceWorker(): Plugin {
  return {
    name: "tatvam:service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).map((f) => f.fileName).filter((f) => /\.(js|css)$/.test(f)).sort();
      const buildId = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const src = readFileSync(fileURLToPath(new URL("./public/sw.js", import.meta.url)), "utf-8");
      if (!src.includes('"__BUILD_ID__"') || !src.includes("/* __BUILD_ASSETS__ */ []")) {
        this.error("public/sw.js lost its __BUILD_ID__ / __BUILD_ASSETS__ placeholders");
      }
      const source = src
        .replace('"__BUILD_ID__"', JSON.stringify(buildId))
        .replace("/* __BUILD_ASSETS__ */ []", JSON.stringify(files.map((f) => `/${f}`)));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      "/api/ws": { target: API.replace("http", "ws"), ws: true },
      "/api": { target: API, changeOrigin: false },
      "/media": { target: API, changeOrigin: false },
    },
  },
  build: {
    manifest: true,
  },
});
