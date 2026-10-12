// Before electron-builder: copy the built UI into build/web and the best FFmpeg into build/ffmpeg/ffmpeg.exe.
// UI: TATVAM_UI_DIR, else ../frontend/dist. FFmpeg: TATVAM_FFMPEG, else the backend's imageio FFmpeg 7.1 (NVENC, vidstab,
// every xfade transition the server uses), else ffmpeg-static (6.1, no vidstab).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = process.env.TATVAM_UI_DIR || path.join(root, "..", "frontend", "dist");
if (!existsSync(path.join(ui, "index.html"))) {
  console.error(`No built UI at ${ui}: run npm run build in frontend/ or set TATVAM_UI_DIR`);
  process.exit(1);
}
rmSync(path.join(root, "build", "web"), { recursive: true, force: true });
cpSync(ui, path.join(root, "build", "web"), { recursive: true });

function backendFfmpeg() {
  let dir = root;
  for (let i = 0; i < 8; i++) {
    const bin = path.join(dir, "backend", ".venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries");
    if (existsSync(bin)) {
      const f = readdirSync(bin).find((n) => /^ffmpeg.*\.exe$/i.test(n));
      if (f) return path.join(bin, f);
    }
    dir = path.dirname(dir);
  }
  return null;
}
function ffmpegStatic() {
  try { return createRequire(path.join(root, "package.json"))("ffmpeg-static"); } catch { return null; }
}
const ff = [process.env.TATVAM_FFMPEG, backendFfmpeg(), ffmpegStatic()].find((p) => p && existsSync(p));
if (!ff) {
  console.error("No FFmpeg found to bundle: set TATVAM_FFMPEG");
  process.exit(1);
}
mkdirSync(path.join(root, "build", "ffmpeg"), { recursive: true });
cpSync(ff, path.join(root, "build", "ffmpeg", "ffmpeg.exe"));
console.log(`prepared build/web from ${ui} and build/ffmpeg/ffmpeg.exe from ${ff}`);
