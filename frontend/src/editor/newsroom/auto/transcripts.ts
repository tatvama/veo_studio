/**
 * The transcripts automatic straps read (docs/EDITOR.md §16.10). The Transcript panel keeps local Whisper transcripts
 * per media file in this browser (localStorage "tatvam-editor:transcripts:v1", keyed by the file's path in lower case),
 * not in the edit; this reads the same store for the edit's media. Browser only.
 */
import type { EditProject } from "../../model/types";
import type { Transcript } from "../../panels/TranscriptOps";
import { readTranscriptStore, transcriptKey } from "../../panels/transcriptStore";

/** Transcripts of the edit's media, by media id (empty when none were made in this browser). */
export function transcriptsFor(p: EditProject): Record<string, Transcript> {
  const store: Record<string, Transcript> = readTranscriptStore();
  const out: Record<string, Transcript> = {};
  for (const m of p.media) {
    const t = store[transcriptKey(m)];
    if (t?.words?.length) out[m.id] = { ...t, mediaId: m.id };
  }
  return out;
}

/** Speaker labels found in the transcripts (for the People panel's hint and the dialog). */
export function speakerLabels(ts: Record<string, Transcript>): string[] {
  const s = new Set<string>();
  for (const t of Object.values(ts)) for (const w of t.words) if (w.speaker?.trim()) s.add(w.speaker.trim());
  return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
