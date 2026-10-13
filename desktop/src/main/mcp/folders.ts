/**
 * The folder allow-list with its in-app prompt (docs/EDITOR.md §13.1): "Claude Desktop wants to use D:\Shoots\Day1" →
 * Allow once (for this session), Always (added to Settings → AI assistants → Folders) or Deny. No answer in 60 s is a
 * Deny. Only one prompt per folder is open at a time; callers asking about the same folder share it. Electron-free:
 * `show` puts the prompt on screen (a window's FolderPrompt, or a native box) and `close` takes it away.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import type { FolderAnswer, FolderPromptRequest } from "../../shared/types.ts";
import { folderDecision, inside, promptFolder } from "./security.ts";

export const PROMPT_TIMEOUT_MS = 60_000;

export interface FolderDeps {
  libraryRoot(): string;
  folders(): string[];
  /** "Always": add to the saved folders */
  addFolder(folder: string): void;
  show(p: FolderPromptRequest): void;
  close(id: string): void;
  timeoutMs?: number;
}

interface Open { req: FolderPromptRequest; waiters: ((a: FolderAnswer) => void)[]; timer: NodeJS.Timeout }

export class FolderGuard {
  private open = new Map<string, Open>();
  /** "Allow once" grants per session */
  private once = new Map<string, Set<string>>();
  private deps: FolderDeps;
  constructor(deps: FolderDeps) { this.deps = deps; }

  sessionFolders(session: string): string[] { return [...(this.once.get(session) ?? [])]; }
  forget(session: string): void { this.once.delete(session); }
  pending(): FolderPromptRequest[] { return [...this.open.values()].map((o) => o.req); }

  /** The decision without asking (tests, listing). */
  decide(target: string, session: string) {
    return folderDecision(target, { library: this.deps.libraryRoot(), folders: this.deps.folders(), session: this.sessionFolders(session) });
  }

  /**
   * Resolves when the assistant may use `target` (a file or folder); throws with a plain reason when it may not.
   * `client` is who asks (the prompt's wording), `why` what for.
   */
  async check(target: string, ctx: { session: string; client: string; why: string }): Promise<void> {
    const d = this.decide(target, ctx.session);
    if (d === "allowed") return;
    if (d === "refused") throw new Error(`${target} can't be used by an assistant (system folders and relative paths are off limits)`);
    let isDir = false;
    try { isDir = statSync(target).isDirectory(); } catch { isDir = false; }
    const folder = promptFolder(target, isDir);
    const answer = await this.ask(folder, ctx.client, ctx.why);
    if (answer === "deny") throw new Error(`The user didn't allow ${folder} (or didn't answer within 60 s). Ask them to add it in Settings → AI assistants → Folders.`);
    if (answer === "always") this.deps.addFolder(folder);
    else {
      const set = this.once.get(ctx.session) ?? new Set<string>();
      set.add(folder);
      this.once.set(ctx.session, set);
    }
  }

  /** One prompt per folder; a second asker waits for the same answer. */
  ask(folder: string, client: string, why: string): Promise<FolderAnswer> {
    const key = path.resolve(folder).toLowerCase();
    const have = [...this.open.values()].find((o) => path.resolve(o.req.folder).toLowerCase() === key || inside(o.req.folder, folder));
    return new Promise<FolderAnswer>((resolve) => {
      if (have) { have.waiters.push(resolve); return; }
      const ms = this.deps.timeoutMs ?? PROMPT_TIMEOUT_MS;
      const req: FolderPromptRequest = { id: randomBytes(6).toString("hex"), client, folder: path.resolve(folder), why: why.slice(0, 200),
        expiresAt: new Date(Date.now() + ms).toISOString() };
      const o: Open = { req, waiters: [resolve], timer: setTimeout(() => this.answer(req.id, "deny"), ms) };
      o.timer.unref?.();
      this.open.set(req.id, o);
      try { this.deps.show(req); } catch { this.answer(req.id, "deny"); }
    });
  }

  answer(id: string, answer: FolderAnswer): boolean {
    const o = this.open.get(id);
    if (!o) return false;
    clearTimeout(o.timer);
    this.open.delete(id);
    const a: FolderAnswer = answer === "once" || answer === "always" ? answer : "deny";
    try { this.deps.close(id); } catch { /* the window went away */ }
    for (const w of o.waiters) w(a);
    return true;
  }

  /** Deny everything still open (the app quits, the server stops). */
  denyAll(): void { for (const id of [...this.open.keys()]) this.answer(id, "deny"); }
}
