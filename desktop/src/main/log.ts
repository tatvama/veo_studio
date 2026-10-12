/**
 * A rolling log file (userData/logs/main.log, 5 MB × 3) that also mirrors console output, plus local crash dumps.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

let file = "";
let written = 0;

export function logsDir(): string {
  return file ? path.dirname(file) : "";
}

function rotate(): void {
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = i === 1 ? file : file.replace(/\.log$/, `.${i - 1}.log`);
    const to = file.replace(/\.log$/, `.${i}.log`);
    try {
      if (existsSync(to)) unlinkSync(to);
      if (existsSync(from)) renameSync(from, to);
    } catch { /* a viewer may hold it open */ }
  }
  written = 0;
}

export function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${format(...args)}\n`;
  if (!file) return;
  try {
    if (written + line.length > MAX_BYTES) rotate();
    appendFileSync(file, line);
    written += Buffer.byteLength(line);
  } catch { /* never let logging break the app */ }
}

/** Start logging into `<userData>/logs/main.log` and tee console.* into it. Call once, early. */
export function initLog(userData: string): string {
  const dir = path.join(userData, "logs");
  mkdirSync(dir, { recursive: true });
  file = path.join(dir, "main.log");
  try { written = existsSync(file) ? statSync(file).size : 0; } catch { written = 0; }
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { log("info", ...a); orig.log(...a); };
  console.info = (...a: unknown[]) => { log("info", ...a); orig.info(...a); };
  console.warn = (...a: unknown[]) => { log("warn", ...a); orig.warn(...a); };
  console.error = (...a: unknown[]) => { log("error", ...a); orig.error(...a); };
  process.on("uncaughtException", (e) => log("error", "uncaught", e));
  process.on("unhandledRejection", (e) => log("error", "unhandled rejection", e));
  return file;
}
