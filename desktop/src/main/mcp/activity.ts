/**
 * The assistants' activity log (docs/EDITOR.md §13.1, Settings → AI assistants → Activity): one JSON line per tool call
 * or refusal in userData/assistants-activity.jsonl, the last 1000 kept. Electron-free.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../config.ts";
import type { AssistantActivity } from "../../shared/types.ts";

export const ACTIVITY_KEEP = 1000;

export class ActivityLog {
  private count = 0;
  private listeners = new Set<(e: AssistantActivity) => void>();

  readonly file: string;
  private keep: number;

  constructor(file: string, keep = ACTIVITY_KEEP) {
    this.file = file;
    this.keep = keep;
    mkdirSync(path.dirname(file), { recursive: true });
    this.count = this.read().length;
  }

  private read(): AssistantActivity[] {
    if (!existsSync(this.file)) return [];
    const out: AssistantActivity[] = [];
    for (const line of readFileSync(this.file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as AssistantActivity); } catch { /* a torn line */ }
    }
    return out;
  }

  add(e: Omit<AssistantActivity, "at"> & { at?: string }): AssistantActivity {
    const entry: AssistantActivity = { at: e.at ?? new Date().toISOString(), ...e } as AssistantActivity;
    if (entry.summary) entry.summary = entry.summary.replace(/[\r\n]+/g, " ").slice(0, 400);
    try {
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
      this.count++;
      // trim in batches so a long session doesn't rewrite the file on every call
      if (this.count > this.keep + Math.max(10, Math.round(this.keep / 10))) {
        const all = this.read().slice(-this.keep);
        writeFileAtomic(this.file, all.map((x) => JSON.stringify(x)).join("\n") + "\n");
        this.count = all.length;
      }
    } catch { /* the log never breaks a call */ }
    for (const l of this.listeners) l(entry);
    return entry;
  }

  /** Newest first. */
  list(limit = 200): AssistantActivity[] {
    return this.read().slice(-Math.max(1, Math.min(this.keep, limit))).reverse();
  }

  onAdd(fn: (e: AssistantActivity) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
