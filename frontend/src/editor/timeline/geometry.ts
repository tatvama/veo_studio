/** Timeline layout: rows (V tracks top-down Vn…V1, a divider, then A1…An), pixel ↔ frame. */
import { tracksOf } from "../model/ops";
import type { Sequence, Track } from "../model/types";

export const HEADER_W = 196;
export const SPLIT_H = 6;
export const EDGE_PX = 7;

export interface Row { track: Track; top: number; height: number }
export interface Layout { rows: Row[]; height: number; splitTop: number }

export function layoutRows(seq: Sequence): Layout {
  const rows: Row[] = [];
  let y = 0;
  for (const t of [...tracksOf(seq, "video")].reverse()) { rows.push({ track: t, top: y, height: t.height }); y += t.height + 1; }
  const splitTop = y;
  y += SPLIT_H;
  for (const t of tracksOf(seq, "audio")) { rows.push({ track: t, top: y, height: t.height }); y += t.height + 1; }
  return { rows, height: y, splitTop };
}

/** The row at a y in the rows' coordinate space, or the nearest of `kind`. */
export function rowAt(layout: Layout, y: number, kind?: Track["kind"]): Row | null {
  const rows = kind ? layout.rows.filter((r) => r.track.kind === kind) : layout.rows;
  if (!rows.length) return null;
  for (const r of rows) if (y >= r.top && y < r.top + r.height + 1) return r;
  return y < rows[0].top ? rows[0] : y >= rows[rows.length - 1].top ? rows[rows.length - 1] : rows.reduce((b, r) => (Math.abs(r.top + r.height / 2 - y) < Math.abs(b.top + b.height / 2 - y) ? r : b));
}

export const fx = (frame: number, zoom: number, scroll: number) => frame * zoom - scroll;
export const xf = (x: number, zoom: number, scroll: number) => (x + scroll) / zoom;

/** Ruler tick spacing (frames) for a zoom: major ticks ≥ 90 px apart, on round timecode steps. */
export function tickStep(zoom: number, fps: number): { major: number; minor: number } {
  const n = Math.round(fps);
  const steps = [1, 2, 5, 10, n / 2, n, 2 * n, 5 * n, 10 * n, 15 * n, 30 * n, 60 * n, 120 * n, 300 * n, 600 * n, 1800 * n, 3600 * n].filter((s) => Number.isInteger(s) && s > 0);
  const major = steps.find((s) => s * zoom >= 90) ?? steps[steps.length - 1];
  const sub = major >= n ? (major / n >= 60 ? 6 : major / n >= 10 ? 5 : major / n >= 2 ? (major / n === 15 ? 3 : 4) : 5) : major >= 10 ? 5 : major >= 2 ? 2 : 1;
  return { major, minor: Math.max(1, Math.round(major / sub)) };
}
