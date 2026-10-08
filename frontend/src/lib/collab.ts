/**
 * Team presence and edit locks (see backend core/collab.py).
 * - The live WebSocket (lib/live.ts) receives "presence" snapshots into `usePresence`.
 * - `useReportView` tells teammates which view this tab shows.
 * - `useEditLock(target, active)` holds a lock while you edit (renewed every 15 s, released when you stop).
 * - `useLockHolder(target)` says who else is editing something, so the UI can turn read-only.
 */
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "./api";
import { useAuthStatus } from "./queries";

export interface PresencePerson { user_id: number; name: string; views: string[]; editing: string[] }
export interface LockInfo { target: string; user_id: number; name: string; since: number }

interface PresenceState { projectId: number | null; people: PresencePerson[]; locks: LockInfo[] }
export const usePresence = create<PresenceState>(() => ({ projectId: null, people: [], locks: [] }));

// the live socket registers its sender here; presence messages wait for it
let sender: ((msg: unknown) => void) | null = null;
let lastReport: unknown = null;
export function setLiveSender(fn: ((msg: unknown) => void) | null) {
  sender = fn;
  if (fn && lastReport) fn(lastReport);  // tell the server again after a reconnect
}
export function receivePresence(projectId: number, payload: { people: PresencePerson[]; locks: LockInfo[] }) {
  usePresence.setState({ projectId, people: payload.people ?? [], locks: payload.locks ?? [] });
}

/** This tab's view in the project (studio, timeline, shots…), refreshed so it never times out. */
export function useReportView(projectId: number | null, view: string) {
  useEffect(() => {
    if (!projectId) return;
    const msg = { type: "presence", project_id: projectId, view };
    lastReport = msg;
    sender?.(msg);
    const h = window.setInterval(() => sender?.(msg), 20_000);
    return () => window.clearInterval(h);
  }, [projectId, view]);
}

export function useMyId(): number | undefined {
  return useAuthStatus().data?.user?.id;
}

/** Someone other than me holding a lock on `target` (or on any of `targets`). */
export function useLockHolder(...targets: (string | null | undefined)[]): LockInfo | undefined {
  const me = useMyId();
  const locks = usePresence((s) => s.locks);
  return locks.find((l) => targets.includes(l.target) && l.user_id !== me);
}

const release = (target: string) => {
  // keepalive: still sent when the tab is closing
  void fetch("/api/locks/release", {
    method: "POST", keepalive: true, credentials: "include",
    headers: { "Content-Type": "application/json", "X-Requested-With": "veo-studio" }, body: JSON.stringify({ target }),
  }).catch(() => undefined);
};

/**
 * Hold `target` while `active` (e.g. while a form has unsaved edits). Returns the other person if they got there first.
 */
export function useEditLock(target: string | null, active: boolean): { held: boolean; holder?: { name: string } } {
  const [state, setState] = useState<{ held: boolean; holder?: { name: string } }>({ held: false });
  const heldRef = useRef<string | null>(null);
  useEffect(() => {
    if (!target || !active) { setState({ held: false }); return; }
    let stop = false;
    const take = async () => {
      try {
        const r = await api.post<{ ok: boolean; holder?: { name: string } }>("/api/locks", { target }, { silent: true });
        if (stop) return;
        if (r.ok) heldRef.current = target;
        setState(r.ok ? { held: true } : { held: false, holder: r.holder });
      } catch { /* offline for a moment: try again on the next beat */ }
    };
    void take();
    const h = window.setInterval(() => void take(), 15_000);
    const bye = () => { if (heldRef.current) release(heldRef.current); };
    window.addEventListener("pagehide", bye);
    return () => {
      stop = true;
      window.clearInterval(h);
      window.removeEventListener("pagehide", bye);
      if (heldRef.current === target) { release(target); heldRef.current = null; }
    };
  }, [target, active]);
  return state;
}

const VIEW_LABELS: Record<string, string> = {
  studio: "Studio", shots: "Shot list", storyboard: "Storyboard", timeline: "Timeline", export: "Export", bible: "Characters",
  brief: "Brief", story: "Story", scenes: "Scenes", review: "Review", activity: "Activity",
};
export const viewLabel = (v: string) => VIEW_LABELS[v] ?? v;
