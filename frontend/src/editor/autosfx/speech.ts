/**
 * Where speech plays, for auto SFX's ducking (docs/EDITOR.md §15.2): the dialogue clips (role "dialogue", by clip or
 * track) minus their silences from the desktop's free silence analysis (editor.analyze "silence", on this PC). Without
 * the desktop it is undefined, and the planner falls back to the dialogue clips' extents.
 */
import { editorBridge } from "../../lib/desktop";
import { readSilences } from "../ai/analysis.ts";
import { silenceCuts, soundParts } from "../ai/commands.ts";
import { trackById } from "../model/ops.ts";
import type { EditorHost } from "../model/types.ts";
import { isDialogue } from "./events.ts";
import type { FrameRange } from "./types.ts";

export async function speechRanges(host: EditorHost): Promise<FrameRange[] | undefined> {
  const seq = host.sequence();
  const dlg = seq.clips.filter((c) => c.enabled && c.source.type === "media" && !trackById(seq, c.trackId)?.muted && isDialogue(seq, c));
  if (!dlg.length) return [];
  const b = editorBridge();
  if (!b?.analyze || !host.path()) return undefined;
  const ids = new Set(dlg.map((c) => c.id));
  const parts = soundParts(host.project(), seq, { clipIds: [...ids] }).filter((p) => ids.has(p.clipId));
  const memo = new Map<string, { start: number; end: number }[] | null>();
  const out: FrameRange[] = [];
  for (const part of parts) {
    let sil = memo.get(part.mediaId);
    if (sil === undefined) {
      try { sil = readSilences(await b.analyze(host.path(), part.mediaId, "silence", { noiseDb: -35, minMs: 300 })); } catch { sil = null; }
      memo.set(part.mediaId, sil);
    }
    if (!sil) { out.push({ from: part.tlStart, to: part.tlEnd }); continue; }
    let a = part.tlStart;
    for (const [qa, qb] of silenceCuts(part, sil, seq.fps, 0, 250)) {
      if (qa > a) out.push({ from: a, to: qa });
      a = Math.max(a, qb);
    }
    if (a < part.tlEnd) out.push({ from: a, to: part.tlEnd });
  }
  return out;
}
