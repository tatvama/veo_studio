/**
 * Notifications (desktop shell): native Windows toasts (Electron Notification under the app's AppUserModelId) and an
 * in-app notification centre with history (the bell in the status bar). Kinds: render, ai, sync, update, download,
 * system; each can be turned off in Settings → Notifications. Clicking one focuses the window and item it points at.
 *
 * Other main-process modules call `notify({title, body, kind, target})` (e.g. desktop-mcp's watch folders).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Notification, type NativeImage } from "electron";
import type { DesktopNotification, NotificationKind, NotificationTarget, ShellPrefs } from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";
import { NOTIFICATION_KINDS } from "./shell-state.ts";

export interface NotifyInput { title: string; body?: string; kind?: NotificationKind; tone?: DesktopNotification["tone"]; target?: NotificationTarget }

export interface NotificationDeps {
  file: string;
  prefs(): ShellPrefs;
  /** focus the window and item */
  open(target: NotificationTarget | undefined): void;
  broadcast(list: DesktopNotification[]): void;
  icon?(): NativeImage | undefined;
  /** no native toast while one of the app's windows has the focus and shows the in-app toast (still listed) */
  appFocused?(): boolean;
  log(msg: string): void;
}

const MAX = 100;

export class NotificationCenter {
  private deps: NotificationDeps;
  private items: DesktopNotification[] = [];
  private live = new Map<string, Notification>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(deps: NotificationDeps) {
    this.deps = deps;
    try {
      if (existsSync(deps.file)) {
        const raw = JSON.parse(readFileSync(deps.file, "utf8")) as DesktopNotification[];
        if (Array.isArray(raw)) this.items = raw.filter((n) => n && typeof n.id === "string" && typeof n.title === "string").slice(0, MAX);
      }
    } catch { this.items = []; }
  }

  list(): DesktopNotification[] {
    return this.items.map((n) => ({ ...n }));
  }

  show(input: NotifyInput): DesktopNotification | null {
    const kind: NotificationKind = NOTIFICATION_KINDS.includes(input.kind as NotificationKind) ? (input.kind as NotificationKind) : "system";
    const prefs = this.deps.prefs();
    if (!prefs.notifications[kind]) return null;
    const title = String(input.title ?? "").trim().slice(0, 200);
    if (!title) return null;
    const n: DesktopNotification = {
      id: randomUUID(), kind, title, ...(input.body ? { body: String(input.body).slice(0, 600) } : {}),
      ...(input.tone ? { tone: input.tone } : {}), at: new Date().toISOString(), read: false,
      ...(input.target ? { target: sanitizeTarget(input.target) } : {}),
    };
    this.items = [n, ...this.items].slice(0, MAX);
    this.changed();
    if (prefs.notifications.native && Notification.isSupported() && !this.deps.appFocused?.()) {
      try {
        const toast = new Notification({ title: n.title, body: n.body ?? "", icon: this.deps.icon?.(), silent: kind === "sync" || kind === "download",
          urgency: n.tone === "error" ? "critical" : "normal", timeoutType: "default" });
        toast.on("click", () => this.open(n.id));
        toast.on("close", () => this.live.delete(n.id));
        this.live.set(n.id, toast); // keep a reference, or the click handler is collected
        toast.show();
      } catch (e) {
        this.deps.log(`notification: ${(e as Error).message}`);
      }
    }
    return { ...n };
  }

  markRead(id?: string): void {
    let changed = false;
    for (const n of this.items) if ((!id || n.id === id) && !n.read) { n.read = true; changed = true; }
    if (changed) this.changed();
  }

  clear(): void {
    this.items = [];
    for (const t of this.live.values()) { try { t.close(); } catch { /* gone */ } }
    this.live.clear();
    this.changed();
  }

  open(id: string): void {
    const n = this.items.find((x) => x.id === id);
    if (!n) return;
    this.markRead(id);
    this.deps.open(n.target);
  }

  private changed(): void {
    this.deps.broadcast(this.list());
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { writeFileAtomic(this.deps.file, JSON.stringify(this.items)); } catch (e) { this.deps.log(`notifications: ${(e as Error).message}`); }
    }, 500);
    this.saveTimer.unref?.();
  }
}

function sanitizeTarget(t: NotificationTarget): NotificationTarget {
  const out: NotificationTarget = {};
  if (typeof t.url === "string" && t.url.startsWith("/") && !t.url.startsWith("//")) out.url = t.url.slice(0, 500);
  if (typeof t.settings === "string") out.settings = t.settings.slice(0, 40);
  if (typeof t.renderId === "string") out.renderId = t.renderId.slice(0, 80);
  if (typeof t.editPath === "string") out.editPath = t.editPath.slice(0, 1000);
  if (typeof t.reveal === "string") out.reveal = t.reveal.slice(0, 1000);
  return out;
}

let center: NotificationCenter | null = null;

export function setNotificationCenter(c: NotificationCenter | null): void {
  center = c;
}

/** Show a notification (native toast + the in-app centre), if its kind is on. Safe to call before the app is ready. */
export function notify(n: NotifyInput): DesktopNotification | null {
  return center?.show(n) ?? null;
}
