/**
 * "New screens are ready" (docs/DESKTOP.md §4.3): when the app has a newer build of the screens than the one this
 * window loaded, every window shows the toast with Reload and Later. Reload saves the editor first, and asks when
 * other work in the window isn't saved. Windows opened later get the new build anyway.
 *
 * Also the confirm dialog the shell uses for that question (and before restarting into an update).
 */
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button, Modal } from "../components/ui";
import { desktop, type UiStatus } from "../lib/desktop";
import { reloadWindow, saveGuards } from "./state";

// ── confirm ──────────────────────────────────────────────────────────────────

interface Ask { title: string; body: string; ok: string; resolve(v: boolean): void }
let asking: Ask | null = null;
const subs = new Set<() => void>();
export function askConfirm(o: { title: string; body: string; ok: string }): Promise<boolean> {
  return new Promise((resolve) => {
    asking?.resolve(false);
    asking = { ...o, resolve };
    subs.forEach((f) => f());
  });
}
function answer(v: boolean) {
  const a = asking;
  asking = null;
  subs.forEach((f) => f());
  a?.resolve(v);
}

export function ConfirmHost() {
  const a = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => asking, () => asking);
  return (
    <Modal open={Boolean(a)} onClose={() => answer(false)} title={a?.title ?? ""} size="sm"
      footer={<><Button variant="ghost" onClick={() => answer(false)}>Cancel</Button><Button variant="primary" data-autofocus onClick={() => answer(true)}>{a?.ok ?? "OK"}</Button></>}>
      <p className="text-sm leading-relaxed text-mute">{a?.body}</p>
    </Modal>
  );
}

const askUnsaved = (names: string[]) => askConfirm({
  title: "Unsaved changes",
  body: `${names.join(", ")} ${names.length === 1 ? "has" : "have"} changes that aren't saved. Reloading loses them.`,
  ok: "Reload anyway",
});

/** Save what can be saved, ask about the rest, then run `fn` (restart into an update). */
export async function reloadGuardsThen(fn: () => void): Promise<void> {
  const ok = await saveGuards((names) => askConfirm({
    title: "Unsaved changes",
    body: `${names.join(", ")} ${names.length === 1 ? "has" : "have"} changes that aren't saved. Restarting loses them.`,
    ok: "Restart anyway",
  })).catch(() => false);
  if (ok) fn();
}

// ── the watcher ──────────────────────────────────────────────────────────────

export function ScreensWatcher() {
  const loaded = useRef<string | null | undefined>(undefined);
  const shown = useRef<string | null>(null);
  const noticed = useRef<string | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const d = desktop();
    if (!d?.app.uiStatus) return;
    let alive = true;
    const seen = (s: UiStatus) => {
      if (!alive) return;
      if (loaded.current === undefined) { loaded.current = s.build ?? null; return; }
      if (s.notice && noticed.current !== s.notice && /Update Tatvam Desktop/.test(s.notice)) {
        noticed.current = s.notice;
        toast.warning("Update Tatvam Desktop to get the newest screens", { description: s.notice, id: "screens-notice" });
      }
      if (!s.build || s.checking || s.build === loaded.current || shown.current === s.build) return;
      shown.current = s.build;
      setTick((x) => x + 1);
      toast("New screens are ready", {
        id: "screens-ready",
        description: `${s.label}. Reload this window to use them; windows you open from now on get them anyway.`,
        icon: <RefreshCw className="size-4 text-accent-ink" />,
        duration: Infinity,
        action: { label: "Reload", onClick: () => { void reloadWindow(askUnsaved).then((done) => { if (!done) shown.current = null; }); } },
        cancel: { label: "Later", onClick: () => undefined },
      });
    };
    d.app.uiStatus().then(seen).catch(() => undefined);
    const off = d.app.onUiStatus?.(seen);
    return () => { alive = false; off?.(); };
  }, []);
  return null;
}
