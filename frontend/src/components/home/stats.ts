import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../../lib/api";
import type { ProjectDashboard } from "../../lib/v3";

export type DashState = { status: "pending" | "error" | "success"; data?: ProjectDashboard };

/**
 * Production numbers (shots approved / total, approved footage) for a handful of projects at once.
 * Same query key as the project's own Overview page, so the two share the cache and live events refresh both.
 * Errors stay silent: a card without numbers just hides its progress meter.
 */
export function useProjectStats(ids: number[]) {
  const results = useQueries({
    queries: ids.map((pid) => ({
      queryKey: ["dashboard", "project", pid] as const,
      queryFn: () => api.get<ProjectDashboard>(`/api/projects/${pid}/dashboard`, { silent: true }),
      staleTime: 30_000,
      retry: 1,
    })),
  });
  const sig = results.map((r) => `${r.status}:${r.dataUpdatedAt}`).join("|");
  return useMemo(() => {
    const byId = new Map<number, DashState>();
    let approved = 0, total = 0, approvedS = 0, loaded = 0, pending = 0;
    ids.forEach((id, i) => {
      const r = results[i];
      if (!r) return;
      byId.set(id, { status: r.status, data: r.data });
      if (r.status === "pending") pending += 1;
      if (r.data) {
        loaded += 1;
        approved += r.data.shots.approved;
        total += r.data.shots.total;
        approvedS += r.data.footage.approved_s;
      }
    });
    return { byId, approved, total, approvedS, loaded, pending };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, ids.join(",")]);
}

/** Cells for the segmented pipeline meter: one per shot up to 12, then proportional. */
export function meterCells(total: number, approved: number): { cells: number; filled: number } {
  if (total <= 0) return { cells: 10, filled: 0 };
  const cells = Math.min(total, 12);
  const filled = approved <= 0 ? 0 : Math.max(1, Math.round((approved / total) * cells));
  return { cells, filled: Math.min(cells, filled) };
}
