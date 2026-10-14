/**
 * QA and debugging (preview-polish): with the editor's debug flag on (localStorage "tatvam-editor:debug" = "1"),
 * window.__tatvamPreview reads the preview timings — idle renders, card draws, live frames, the cache.
 */
import { cardStats } from "./player";
import { liveStats } from "./live";
import { renderStats } from "./render";
import { previewDebug, requestStill } from "./service";
import { frameRetryIn, userFrame } from "./frames";

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : 0);
const max = (xs: number[]) => (xs.length ? Math.round(Math.max(...xs) * 1000) / 1000 : 0);
const p95 = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] * 1000) / 1000; };

export function installPreviewDebug() {
  try {
    if (typeof window === "undefined" || localStorage.getItem("tatvam-editor:debug") !== "1") return;
    (window as unknown as Record<string, unknown>).__tatvamPreview = {
      stats: () => ({
        service: previewDebug(),
        engine: { renders: renderStats.count, avgMs: avg(renderStats.ms), p95Ms: p95(renderStats.ms), maxMs: max(renderStats.ms) },
        card: { draws: cardStats.draw.length, avgMs: avg(cardStats.draw), p95Ms: p95(cardStats.draw), maxMs: max(cardStats.draw), halved: cardStats.halved, stillsOnly: cardStats.stillsOnly },
        live: { frames: liveStats.ms.length, avgMs: avg(liveStats.ms), p95Ms: p95(liveStats.ms), maxMs: max(liveStats.ms), resolution: liveStats.resolution, stills: liveStats.stills, shown: liveStats.shown, ended: [...liveStats.ended] },
      }),
      frames: { userFrame, frameRetryIn },
      requestStill,
      reset: () => { renderStats.ms.length = 0; cardStats.draw.length = 0; liveStats.ms.length = 0; },
    };
  } catch { /* storage blocked */ }
}
