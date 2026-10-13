/**
 * The way from an assistant's tool call to the editor window that has the edit open (docs/EDITOR.md §13.1): each
 * editor page attaches its edit (assistants.attach), a call goes to that window over IPC (assistants.call) and comes
 * back as a reply (assistants.reply) from the same window, so it runs there as "Assistant: <tool>", visibly and with
 * undo. Electron-free: `send` delivers to a window by id.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AssistantCall, AssistantReply, AssistantScope } from "../../shared/types.ts";

export interface Attached { windowId: number; path: string; name: string; dirty: boolean; at: number }

interface Pending { windowId: number; resolve(r: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }

const key = (p: string) => path.resolve(p).toLowerCase();

export class EditorLink {
  private windows = new Map<number, Attached>();
  private pending = new Map<string, Pending>();
  private waiters = new Set<() => void>();

  private send: (windowId: number, call: AssistantCall) => boolean;
  constructor(send: (windowId: number, call: AssistantCall) => boolean) { this.send = send; }

  attach(windowId: number, file: string, info: { name?: string; dirty?: boolean }): void {
    this.windows.set(windowId, { windowId, path: path.resolve(file), name: String(info.name ?? path.basename(file, ".tatvamedit")).slice(0, 200),
      dirty: Boolean(info.dirty), at: Date.now() });
    for (const w of [...this.waiters]) w();
  }

  detach(windowId: number, file?: string): void {
    const a = this.windows.get(windowId);
    if (!a || (file && key(a.path) !== key(file))) return;
    this.windows.delete(windowId);
    for (const [id, p] of this.pending) if (p.windowId === windowId) { clearTimeout(p.timer); this.pending.delete(id); p.reject(new Error("The editor window closed the edit")); }
  }

  /** The window went away. */
  gone(windowId: number): void { this.detach(windowId); }

  list(): Attached[] { return [...this.windows.values()].sort((a, b) => b.at - a.at); }
  windowFor(file: string): Attached | undefined { return this.list().find((a) => key(a.path) === key(file)); }

  /** Waits until a window attaches this edit (after open_edit navigated one), up to `ms`. */
  async waitFor(file: string, ms: number): Promise<Attached | undefined> {
    const until = Date.now() + ms;
    for (;;) {
      const a = this.windowFor(file);
      if (a || Date.now() >= until) return a;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
        const t = setTimeout(done, Math.min(500, Math.max(10, until - Date.now())));
        this.waiters.add(done);
      });
    }
  }

  /** Runs a tool in the window that has `file` open; rejects with the page's error, or after `timeoutMs`. */
  call<T = unknown>(file: string, tool: string, args: Record<string, unknown>, o: { client: string; scopes: AssistantScope[]; timeoutMs?: number }): Promise<T> {
    const a = this.windowFor(file);
    if (!a) return Promise.reject(new Error(`${path.basename(file)} isn't open in an editor window: call open_edit first`));
    const id = randomBytes(8).toString("hex");
    const call: AssistantCall = { id, tool, args, client: o.client, label: `Assistant: ${tool}`, scopes: o.scopes };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`The editor window didn't answer ${tool} in ${Math.round((o.timeoutMs ?? 60_000) / 1000)} s`));
      }, o.timeoutMs ?? 60_000);
      timer.unref?.();
      this.pending.set(id, { windowId: a.windowId, resolve: resolve as (r: unknown) => void, reject, timer });
      if (!this.send(a.windowId, call)) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.windows.delete(a.windowId);
        reject(new Error("The editor window is gone"));
      }
    });
  }

  /** A reply from a window; only the window the call went to may answer it. */
  reply(windowId: number, id: string, r: AssistantReply): boolean {
    const p = this.pending.get(String(id));
    if (!p || p.windowId !== windowId) return false;
    clearTimeout(p.timer);
    this.pending.delete(String(id));
    if (r && r.ok) p.resolve(r.result);
    else p.reject(new Error(String(r?.error ?? "The editor couldn't do that").slice(0, 2000)));
    return true;
  }
}
