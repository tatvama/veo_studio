/**
 * Where local transcripts live: per media file in this browser (localStorage), keyed by the file's path in lower case,
 * so a file transcribed once serves every edit it's in. The Transcript panel writes it; News Room speaker straps read
 * it (newsroom/auto/transcripts.ts). Browser only.
 */
import type { MediaItem } from "../model/types";
import type { Transcript } from "./TranscriptOps";

const LS = "tatvam-editor:transcripts:v1";
export type TranscriptStore = Record<string, Transcript & { at: string; path: string }>;

export const readTranscriptStore = (): TranscriptStore => { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; } };
export function writeTranscriptStore(s: TranscriptStore) {
  try { localStorage.setItem(LS, JSON.stringify(s)); } catch {
    // full: keep the newest half
    const keep = Object.entries(s).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, Math.max(1, Math.floor(Object.keys(s).length / 2)));
    try { localStorage.setItem(LS, JSON.stringify(Object.fromEntries(keep))); } catch { /* blocked */ }
  }
}
/** A media file's key in the store. */
export const transcriptKey = (m: Pick<MediaItem, "path" | "id">) => (m.path || m.id).toLowerCase();
