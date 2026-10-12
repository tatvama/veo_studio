/**
 * Server calls for the finishing room (docs/DESKTOP.md §2): the checkout lock on an episode's cut, cut versions with
 * rollback, review notes per episode and the paid 4K upscale step. The endpoints may be missing on an older server:
 * reads then come back empty (`available: false`) instead of failing the page.
 */
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { api, ApiError } from "./api";
import { desktop, isDesktop } from "./desktop";
import { tr } from "./i18n";
import type { UserBrief } from "./types";

// ── types ────────────────────────────────────────────────────────────────────

export interface CutLock {
  user: UserBrief; client: "desktop" | "web" | (string & {}); machine: string; acquired_at: string; heartbeat_at: string;
  /** I hold it. */
  mine: boolean;
}

export interface CutVersion {
  id: number; number: number; note: string; client: string; created_by: UserBrief | null; created_at: string;
  restored_from: number | null; stats: { shots: number; included: number; duration_s: number };
}

export interface ReviewNote {
  id: number; export_id: number; export_version: number | null; cut_version: number | null; timecode: number | null;
  body: string; drawing: unknown; author: string | UserBrief | null; guest_name?: string | null; resolved: boolean; created_at: string;
  /** The render was made from the current cut version, so its timecodes land on the timeline as they are. */
  maps_to_cut: boolean;
}

export interface UpscaleItem { shot_id: number; code: string; take_id: number; from: [number, number]; to: [number, number]; seconds: number; usd: number }
export type UpscaleSkip = string | { shot_id?: number; code?: string; reason?: string };
export interface UpscaleEstimate { items: UpscaleItem[]; total_usd: number; skipped: UpscaleSkip[] }

/** Missing endpoint (older server): treat as "not there" instead of an error. */
const missing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

// ── checkout lock ────────────────────────────────────────────────────────────

/** Who holds the cut. `lockedByOther`: someone else has it checked out, so cut edits are read-only here. */
export function useCheckout(eid: number | undefined) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["checkout", eid],
    queryFn: async (): Promise<{ lock: CutLock | null; unavailable?: boolean }> => {
      try {
        const r = await api.get<{ lock: CutLock | null }>(`/api/episodes/${eid}/checkout`, { silent: true });
        return { lock: r?.lock ?? null };
      } catch (e) {
        if (missing(e)) return { lock: null, unavailable: true };
        throw e;
      }
    },
    enabled: !!eid,
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: false,
  });
  // a 423 from any cut edit means the lock changed under us: read it again
  useEffect(() => {
    const h = () => qc.invalidateQueries({ queryKey: ["checkout"] });
    window.addEventListener("veo:cut-locked", h);
    return () => window.removeEventListener("veo:cut-locked", h);
  }, [qc]);
  const lock = q.data?.lock ?? null;
  return { ...q, lock, lockedByOther: !!lock && !lock.mine, available: !!q.data && !q.data.unavailable };
}

const beats = new Map<number, { n: number; h: number }>();

/** While `on`, tells the server every 60 s that I'm still holding the cut (one timer per episode, however many callers). */
export function useCheckoutHeartbeat(eid: number | undefined, on: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!eid || !on) return;
    let b = beats.get(eid);
    if (!b) {
      const beat = async () => {
        try {
          await api.post(`/api/episodes/${eid}/checkout/heartbeat`, {}, { silent: true });
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            toast.warning(tr("You no longer hold the cut"), { id: "cut-lost", description: tr("Someone released it. Check it out again to keep editing.") });
            qc.invalidateQueries({ queryKey: ["checkout", eid] });
          }
          /* offline for a moment: the next beat tries again (the lock doesn't expire on its own) */
        }
      };
      void beat();
      b = { n: 0, h: window.setInterval(() => void beat(), 60_000) };
      beats.set(eid, b);
    }
    b.n++;
    return () => {
      const x = beats.get(eid);
      if (!x) return;
      x.n--;
      if (x.n <= 0) { window.clearInterval(x.h); beats.delete(eid); }
    };
  }, [eid, on, qc]);
}

/** "Chrome on Windows", or the computer's name inside the desktop app. */
export async function machineName(): Promise<string> {
  const d = desktop();
  if (d) {
    try {
      const info = await d.info();
      if (info.machine) return info.machine;
    } catch { /* fall through */ }
    return `Tatvam Desktop · ${d.platform === "win32" ? "Windows" : d.platform === "darwin" ? "macOS" : d.platform}`;
  }
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const refreshCut = (qc: QueryClient, eid: number) => {
  qc.invalidateQueries({ queryKey: ["checkout", eid] });
  qc.invalidateQueries({ queryKey: ["versions", eid] });
};

/** Checks the cut out (desktop or web). Resolves to undefined when it failed (a 423 was already shown as a notice). */
export async function checkout(qc: QueryClient, eid: number, opts: { force?: boolean } = {}): Promise<CutLock | null | undefined> {
  try {
    const r = await api.post<{ lock: CutLock | null }>(`/api/episodes/${eid}/checkout`, {
      client: isDesktop ? "desktop" : "web", machine: await machineName(), ...(opts.force ? { force: true } : {}),
    });
    return r?.lock ?? null;
  } catch {
    return undefined;
  } finally {
    refreshCut(qc, eid);
  }
}

/** Saves a version with the note and releases the lock. Resolves to the new version's number (or undefined). */
export async function checkin(qc: QueryClient, eid: number, note: string): Promise<number | undefined> {
  try {
    const r = await api.post<{ version: CutVersion | number | null }>(`/api/episodes/${eid}/checkin`, { note: note.trim() || undefined });
    const v = r?.version;
    return typeof v === "number" ? v : v?.number;
  } catch {
    return undefined;
  } finally {
    refreshCut(qc, eid);
  }
}

/** Releases the lock without saving a version (the holder, or a producer forcing it). */
export async function releaseCheckout(qc: QueryClient, eid: number): Promise<boolean> {
  try {
    await api.del(`/api/episodes/${eid}/checkout`);
    return true;
  } catch {
    return false;
  } finally {
    refreshCut(qc, eid);
  }
}

// ── versions ─────────────────────────────────────────────────────────────────

export function useVersions(eid: number | undefined) {
  const q = useQuery({
    queryKey: ["versions", eid],
    queryFn: async (): Promise<{ list: CutVersion[]; unavailable?: boolean }> => {
      try {
        return { list: (await api.get<CutVersion[]>(`/api/episodes/${eid}/versions`, { silent: true })) ?? [] };
      } catch (e) {
        if (missing(e)) return { list: [], unavailable: true };
        throw e;
      }
    },
    enabled: !!eid,
    retry: false,
  });
  return { ...q, versions: q.data?.list ?? [], available: !!q.data && !q.data.unavailable };
}

export async function saveVersion(qc: QueryClient, eid: number, note: string): Promise<CutVersion | undefined> {
  try {
    return await api.post<CutVersion>(`/api/episodes/${eid}/versions`, { note: note.trim() });
  } catch {
    return undefined;
  } finally {
    qc.invalidateQueries({ queryKey: ["versions", eid] });
  }
}

/** Rolls the cut back to a version (the server saves the current cut first). */
export async function restoreVersion(qc: QueryClient, eid: number, vid: number): Promise<boolean> {
  try {
    await api.post(`/api/versions/${vid}/restore`);
    return true;
  } catch {
    return false;
  } finally {
    qc.invalidateQueries({ queryKey: ["versions", eid] });
    qc.invalidateQueries({ queryKey: ["episode", eid] });
    qc.invalidateQueries({ queryKey: ["layers", eid] });
  }
}

// ── review notes ─────────────────────────────────────────────────────────────

export function useReviewNotes(eid: number | undefined) {
  const q = useQuery({
    queryKey: ["review-notes", eid],
    queryFn: async (): Promise<{ list: ReviewNote[]; unavailable?: boolean }> => {
      try {
        return { list: (await api.get<ReviewNote[]>(`/api/episodes/${eid}/review-notes`, { silent: true })) ?? [] };
      } catch (e) {
        if (missing(e)) return { list: [], unavailable: true };
        throw e;
      }
    },
    enabled: !!eid,
    retry: false,
  });
  return { ...q, notes: q.data?.list ?? [], available: !!q.data && !q.data.unavailable };
}

export function noteAuthor(n: ReviewNote): string {
  if (n.guest_name) return n.guest_name;
  if (typeof n.author === "string") return n.author || tr("Guest");
  return n.author?.name ?? tr("Guest");
}

// ── 4K upscale (paid) ────────────────────────────────────────────────────────

export async function estimateUpscale(eid: number, body: { shot_ids?: number[]; target_h?: number }): Promise<UpscaleEstimate | undefined> {
  try {
    const r = await api.post<UpscaleEstimate>(`/api/episodes/${eid}/upscale/estimate`, body);
    return { items: r?.items ?? [], total_usd: r?.total_usd ?? 0, skipped: r?.skipped ?? [] };
  } catch {
    return undefined;
  }
}

export function skipLabel(s: UpscaleSkip): string {
  if (typeof s === "string") return s;
  return [s.code ?? (s.shot_id ? `#${s.shot_id}` : ""), s.reason].filter(Boolean).join(": ");
}
