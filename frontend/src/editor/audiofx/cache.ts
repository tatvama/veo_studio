/**
 * The audio render cache (docs/EDITOR.md §11): a clip with an effect WebAudio can't play the export's way is heard
 * from `bridge.editor.renderAudioPreview(path, sequenceId, clipId, clip)`: the desktop renders it with the export's
 * own FFmpeg graph (trims, speed and every audio effect of the clip baked in; gain, pan and fades are the preview's).
 * One entry per clip, keyed by the clip's sound (plan.ts clipCacheKey); a change waits 600 ms (a slider being dragged)
 * before rendering again. In a plain browser, or an older desktop build, the entry is "unavailable".
 */
import { useSyncExternalStore } from "react";
import { editorBridge } from "../../lib/desktop";
import { ed, project } from "../store";

export type CacheStatus = "waiting" | "rendering" | "ready" | "error" | "unavailable";
export interface CacheEntry { key: string; status: CacheStatus; url?: string; duration?: number; error?: string; warnings?: string[] }

const DEBOUNCE_MS = 600;

class AudioRenderCache {
  private entries = new Map<string, CacheEntry>();
  private timers = new Map<string, number>();
  private listeners = new Set<() => void>();
  private version = 0;

  /** True when this window can render (the desktop bridge has renderAudioPreview and the edit is on disk). */
  available(): boolean { return !!editorBridge()?.renderAudioPreview && !!ed().path; }

  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  getVersion = () => this.version;
  private emit() { this.version++; for (const l of this.listeners) l(); }

  get(clipId: string): CacheEntry | undefined { return this.entries.get(clipId); }

  /** The entry for a clip's current sound, starting a (debounced) render when it changed. */
  want(clipId: string, key: string, sequenceId: string): CacheEntry {
    const cur = this.entries.get(clipId);
    if (cur && cur.key === key) return cur;
    if (!this.available()) {
      const e: CacheEntry = { key, status: "unavailable" };
      this.entries.set(clipId, e);
      queueMicrotask(() => this.emit());
      return e;
    }
    const e: CacheEntry = { key, status: "waiting" };
    this.entries.set(clipId, e);
    window.clearTimeout(this.timers.get(clipId));
    this.timers.set(clipId, window.setTimeout(() => void this.render(clipId, key, sequenceId), DEBOUNCE_MS));
    queueMicrotask(() => this.emit());
    return e;
  }

  private async render(clipId: string, key: string, sequenceId: string) {
    this.timers.delete(clipId);
    const b = editorBridge(), path = ed().path;
    if (!b?.renderAudioPreview || !path) return;
    const e = this.entries.get(clipId);
    if (!e || e.key !== key) return;
    this.entries.set(clipId, { key, status: "rendering" });
    this.emit();
    const clip = project().sequences.find((s) => s.id === sequenceId)?.clips.find((c) => c.id === clipId);
    try {
      const r = await b.renderAudioPreview(path, sequenceId, clipId, clip);
      if (this.entries.get(clipId)?.key !== key) return;
      this.entries.set(clipId, { key, status: "ready", url: r.url, duration: r.duration, warnings: r.warnings });
    } catch (err) {
      if (this.entries.get(clipId)?.key !== key) return;
      this.entries.set(clipId, { key, status: "error", error: String((err as Error)?.message ?? err) });
    }
    this.emit();
  }

  /** Forget a clip (it left the sequence). */
  drop(clipId: string) { window.clearTimeout(this.timers.get(clipId)); this.timers.delete(clipId); if (this.entries.delete(clipId)) this.emit(); }
  /** Clips still rendering or waiting. */
  busy(): string[] { return [...this.entries].filter(([, e]) => e.status === "rendering" || e.status === "waiting").map(([id]) => id); }
}

export const audioCache = new AudioRenderCache();
/** Re-renders when any cache entry changes. */
export const useAudioCache = () => { useSyncExternalStore(audioCache.subscribe, audioCache.getVersion, audioCache.getVersion); return audioCache; };
