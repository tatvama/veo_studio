/**
 * How tool results read for a model (docs/EDITOR.md §13.2): times in seconds AND timecode, short lines, and the same
 * data as structured content. Pure.
 */
import { fpsRational } from "../editor-model.ts";

const pad = (n: number, w = 2) => String(Math.max(0, Math.floor(n))).padStart(w, "0");

/** Seconds → HH:MM:SS:FF at `fps` (non-drop). */
export function timecode(seconds: number, fps: number): string {
  const [n, d] = fpsRational(fps > 0 ? fps : 25);
  const nominal = Math.round(n / d);
  const total = Math.max(0, Math.floor((seconds * n) / d + 1e-6)); // the frame that shows at that time
  const ff = total % nominal;
  const s = Math.floor(total / nominal);
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}:${pad(ff)}`;
}

/** "12.48 s (00:00:12:12)" */
export function at(seconds: number, fps: number): string {
  return `${round(seconds, 2)} s (${timecode(seconds, fps)})`;
}

export function round(v: number, d = 3): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** "1 clip" / "3 clips" */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A tool result: the text summary plus structured content (and optional extra content such as an image). */
export function result(text: string, data?: Record<string, unknown>, extra: unknown[] = []): { content: unknown[]; structuredContent?: Record<string, unknown> } {
  return { content: [{ type: "text", text }, ...extra], ...(data ? { structuredContent: data } : {}) };
}

/** A tool error the model can act on (isError, the reason in plain words). */
export function failure(message: string): { content: unknown[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}
