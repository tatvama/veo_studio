/**
 * The desktop shell's view of the bridge (frontend/src/lib/desktop.ts): live hooks for the screens' status, the
 * appearance, jobs, disk space, notifications, the shell state and the updater. In a browser (or an older desktop build
 * without these groups) every hook returns null and nothing throws.
 */
import { useEffect, useState } from "react";
import {
  desktop, type AppearanceState, type DesktopNotification, type DiskStatus, type JobsSummary, type OfflineStatus, type ShellState, type TatvamDesktop,
  type UiStatus, type UpdateState,
} from "../lib/desktop";

/** The local tools bridge (desktop/src/shared/types.ts ToolsBridge), typed here: the frontend mirror doesn't list it. */
export type ToolId = "realesrgan" | "rife" | "whisper" | "whisper-cuda" | "whisper-model:base" | "whisper-model:large-v3-turbo-q5";
export interface ToolStatus {
  id: ToolId; label: string; installed: boolean; version: string; sizeBytes: number; installing: boolean; progress: number; error?: string;
  platformSupported: boolean; gpu?: { index: number; name: string } | null; kind: "program" | "model"; license: string; note: string; missing?: string[];
}
export interface ToolsBridge {
  status(): Promise<ToolStatus[]>;
  install(id: ToolId): Promise<ToolStatus>;
  remove(id: ToolId): Promise<ToolStatus>;
  onProgress(cb: (t: ToolStatus) => void): () => void;
}
export const toolsBridge = (): ToolsBridge | null => ((desktop() as unknown as { tools?: ToolsBridge } | null)?.tools ?? null);

/** desktop-mcp's assistants group (docs/EDITOR.md §13), feature-detected: its state lists the sessions of connected assistants. */
export interface AssistantsStatus {
  active?: boolean; assistant?: string; name?: string; client?: string;
  sessions?: { client?: string; name?: string; busy?: boolean; active?: boolean; edit?: string }[];
}
type AssistantsLike = {
  state?(): Promise<AssistantsStatus>; onState?(cb: (s: AssistantsStatus) => void): () => void;
  status?(): Promise<AssistantsStatus>; onStatus?(cb: (s: AssistantsStatus) => void): () => void;
};
export const assistantsBridge = (): AssistantsLike | null => ((desktop() as unknown as { assistants?: AssistantsLike } | null)?.assistants ?? null);

export const hasShell = (): boolean => Boolean(desktop()?.shell);

/** One value from the bridge: read once, then kept live by its `on…` event. */
function useLive<T>(read: (d: TatvamDesktop) => (() => Promise<T>) | undefined, listen: (d: TatvamDesktop) => ((cb: (v: T) => void) => () => void) | undefined): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    const d = desktop();
    if (!d) return;
    let alive = true;
    const r = read(d);
    if (r) r().then((x) => { if (alive) setV(x); }).catch(() => undefined);
    let off: (() => void) | undefined;
    try { off = listen(d)?.((x) => { if (alive) setV(x); }); } catch { /* old bridge */ }
    return () => { alive = false; off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

export const useUiStatus = () => useLive<UiStatus>((d) => d.app.uiStatus?.bind(d.app), (d) => d.app.onUiStatus?.bind(d.app));
export const useAppearanceState = () => useLive<AppearanceState>((d) => d.appearance?.get.bind(d.appearance), (d) => d.appearance?.onChange.bind(d.appearance));
export const useJobs = () => useLive<JobsSummary>((d) => d.shell?.jobs.bind(d.shell), (d) => d.shell?.onJobs.bind(d.shell));
export const useDisk = () => useLive<DiskStatus>((d) => d.shell?.disk.bind(d.shell), (d) => d.shell?.onDisk.bind(d.shell));
export const useNotifications = () => useLive<DesktopNotification[]>((d) => d.notifications?.list.bind(d.notifications), (d) => d.notifications?.onChange.bind(d.notifications));
export const useShellState = () => useLive<ShellState>((d) => d.shell?.state.bind(d.shell), (d) => d.shell?.onState.bind(d.shell));
export const useUpdate = () => useLive<UpdateState>((d) => (d.app.updateState ? d.app.updateState.bind(d.app) : undefined), (d) => d.app.onUpdate.bind(d.app));
export const useOfflineStatus = () => useLive<OfflineStatus>((d) => d.offline.status.bind(d.offline), (d) => d.offline.onChange.bind(d.offline));

/** desktop-mcp: "<assistant> is editing" while a session is active. */
export function useAssistantEditing(): string | null {
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => {
    const a = assistantsBridge();
    if (!a) return;
    const take = (s: AssistantsStatus | null | undefined) => {
      if (!s) { setWho(null); return; }
      const list = s.sessions ?? [];
      const live: { assistant?: string; name?: string; client?: string } | undefined = s.active ? s : list.find((x) => x.busy || x.active) ?? list[0];
      setWho(live ? String(live.assistant || live.client || live.name || "An assistant") : null);
    };
    let alive = true;
    const read = a.state?.bind(a) ?? a.status?.bind(a);
    read?.().then((s) => { if (alive) take(s); }).catch(() => undefined);
    let off: (() => void) | undefined;
    try { off = (a.onState ?? a.onStatus)?.call(a, (s: AssistantsStatus) => { if (alive) take(s); }); } catch { /* not there yet */ }
    return () => { alive = false; off?.(); };
  }, []);
  return who;
}

/** "Error invoking remote method 'x': Error: message" → "message". */
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? "")).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");

export const editUrl = (p: string) => `/editor/edit?path=${encodeURIComponent(p)}`;

/** "3 min ago", "yesterday", "12 Oct". */
export function ago(iso: string | undefined | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: s > 300 * 86400 ? "numeric" : undefined });
}
