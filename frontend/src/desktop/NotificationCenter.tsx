/**
 * The notification centre (the bell in the status bar): the history of renders, AI jobs, syncs, downloads and updates,
 * newest first. Clicking one focuses the window and item it points at. New ones also show as a toast in the window
 * that has the focus (Windows shows its own toast when no Tatvam window has it).
 */
import { clsx } from "clsx";
import { Bell, BellOff, CheckCheck, CircleAlert, CircleCheck, CloudDownload, Info, RefreshCw, Rocket, Settings2, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button, Tooltip } from "../components/ui";
import { desktop, type DesktopNotification } from "../lib/desktop";
import { ago, useNotifications } from "./bridge";
import { setOverlay, useShellUi } from "./state";

const KIND_ICON = { render: Rocket, ai: Sparkles, sync: RefreshCw, update: CloudDownload, download: CloudDownload, system: Info } as const;

function NoteIcon({ n }: { n: DesktopNotification }) {
  const I = n.tone === "error" ? CircleAlert : n.tone === "warn" ? TriangleAlert : n.tone === "ok" ? CircleCheck : KIND_ICON[n.kind] ?? Info;
  return (
    <span className={clsx("grid size-7 shrink-0 place-items-center rounded-lg border",
      n.tone === "error" ? "border-bad/30 bg-bad/10 text-red-300" : n.tone === "warn" ? "border-warn/30 bg-warn/10 text-amber-300"
        : n.tone === "ok" ? "border-ok/30 bg-ok/10 text-ok" : "border-line bg-raised text-mute")}>
      <I className="size-3.5" />
    </span>
  );
}

export function BellButton() {
  const list = useNotifications();
  const unread = (list ?? []).filter((n) => !n.read).length;
  const { overlay } = useShellUi();
  return (
    <Tooltip content={unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"} side="top">
      <button type="button" className="desk-sb-item relative" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={overlay === "notifications"}
        onClick={() => setOverlay(overlay === "notifications" ? null : "notifications")}>
        <Bell className="size-3.5" />
        {unread > 0 && <span className="mono rounded-full bg-accent px-1 text-[10px] font-bold leading-[14px] text-black">{unread > 99 ? "99+" : unread}</span>}
      </button>
    </Tooltip>
  );
}

export function NotificationPanel() {
  const { overlay } = useShellUi();
  const open = overlay === "notifications";
  const list = useNotifications() ?? [];
  const n = desktop()?.notifications;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOverlay(null); };
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!panel.current?.contains(t) && !t.closest?.("[aria-label^='Notifications']")) setOverlay(null);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", down, true);
    const id = window.setTimeout(() => panel.current?.querySelector<HTMLElement>("button")?.focus(), 40);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("mousedown", down, true); window.clearTimeout(id); };
  }, [open]);
  const unread = list.filter((x) => !x.read).length;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div ref={panel} key="desk-notes" role="dialog" aria-label="Notification centre"
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          className="desk-ui fixed bottom-[calc(var(--desk-statusbar)+6px)] right-2 z-[72] flex max-h-[min(70vh,560px)] w-[380px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-modal">
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <Bell className="size-4 text-mute" />
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && <span className="mono rounded-md bg-accent/15 px-1.5 text-2xs text-accent-ink">{unread} new</span>}
            <span className="flex-1" />
            <Tooltip content="Mark all as read"><button type="button" className="ed-ibtn" aria-label="Mark all as read" disabled={!unread} onClick={() => void n?.markRead()}><CheckCheck className="size-4" /></button></Tooltip>
            <Tooltip content="Clear all"><button type="button" className="ed-ibtn" aria-label="Clear all" disabled={!list.length} onClick={() => void n?.clear()}><Trash2 className="size-4" /></button></Tooltip>
            <Tooltip content="Notification settings"><button type="button" className="ed-ibtn" aria-label="Notification settings" onClick={() => { setOverlay(null); void desktop()?.shell?.open("settings", { section: "notifications" }); }}><Settings2 className="size-4" /></button></Tooltip>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <BellOff className="size-6 text-dim" />
                <p className="text-sm font-medium">No notifications</p>
                <p className="text-2xs text-dim">Finished renders, AI jobs, syncs, downloads and updates show up here.</p>
              </div>
            ) : (
              <ul className="divide-y divide-line/70">
                {list.map((x) => (
                  <li key={x.id}>
                    <button type="button" onClick={() => { setOverlay(null); void n?.open(x.id); }}
                      className={clsx("flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-hover", !x.read && "bg-accent/[0.04]")}>
                      <NoteIcon n={x} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className={clsx("min-w-0 flex-1 truncate text-sm", x.read ? "text-mute" : "font-medium text-ink")}>{x.title}</span>
                          {!x.read && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="unread" />}
                        </span>
                        {x.body && <span className="mt-0.5 line-clamp-2 block text-2xs leading-snug text-dim">{x.body}</span>}
                        <span className="mono mt-1 block text-[10px] uppercase tracking-wide text-dim">{x.kind} · {ago(x.at)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {list.length > 0 && (
            <div className="border-t border-line px-3 py-2 text-right">
              <Button size="sm" variant="ghost" onClick={() => setOverlay(null)}>Close</Button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** New notifications as a toast in the focused window (with an Open button). */
export function NotificationToasts() {
  const list = useNotifications();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!list) return;
    if (!seen.current) { seen.current = new Set(list.map((x) => x.id)); return; }
    for (const x of list) {
      if (seen.current.has(x.id)) continue;
      seen.current.add(x.id);
      if (x.read || !document.hasFocus()) continue;
      const fn = x.tone === "error" ? toast.error : x.tone === "warn" ? toast.warning : x.tone === "ok" ? toast.success : toast.message;
      fn(x.title, { description: x.body, ...(x.target ? { action: { label: "Open", onClick: () => void desktop()?.notifications?.open(x.id) } } : {}) });
    }
  }, [list]);
  return null;
}
