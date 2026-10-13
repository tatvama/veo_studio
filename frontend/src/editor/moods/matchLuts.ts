/**
 * Shot-match LUTs kept with the edit (editor-looks): the engine's exact transfer (.cube text) is written into the edit's
 * LUTs\ folder with bridge.editor.writeLut and referenced by its gateway URL (/__media/<mediaId>/<name>, loadable in
 * every window, the export one too), so the project file stays small. Older desktop builds without writeLut keep the
 * LUT in the document as a data: URL; those are moved to files the next time the edit is saved with writeLut present.
 */
import { editorBridge } from "../../lib/desktop";
import type { EditProject } from "../model/types";
import { ed, project, replaceProject, useEditor } from "../store";

type LutBridge = {
  writeLut?(editPath: string, name: string, cubeText: string): Promise<{ mediaId: string; url: string; file: string }>;
  writeSidecar?(editPath: string, name: string, json: unknown): Promise<unknown>;
};
const bridge = () => editorBridge() as unknown as LutBridge | null;
type LutEntry = NonNullable<EditProject["luts"]>[number];

/** A short stable id for a LUT's text. */
export function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 7) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `${h.toString(36)}${text.length.toString(36)}`;
}
const safeName = (s: string) => s.replace(/[^\p{L}\p{N} _.-]+/gu, " ").trim().slice(0, 60) || "Shot match";

/**
 * The project.luts entry for a match LUT: a file in the edit's LUTs\ folder (writeLut), else a data: URL (older desktop
 * builds). Null without an edit on disk (the browser, the demo): the caller then uses wheels + adjust.
 */
export async function keepMatchLut(label: string, cube: string, size = 17): Promise<LutEntry | null> {
  const b = bridge();
  const path = ed().path;
  if (!b || !path || ed().demo) return null;
  const id = `match_${hashText(cube)}`;
  if (b.writeLut) {
    const r = await b.writeLut(path, safeName(label), cube);
    return { id, name: label.slice(0, 60), path: r.file, url: r.url, size };
  }
  void b.writeSidecar?.(path, `lut-${id}`, { name: label, size, cube }).catch(() => undefined);
  return { id, name: label.slice(0, 60), url: `data:text/plain;base64,${btoa(cube)}`, size };
}

const isData = (l: LutEntry) => typeof l.url === "string" && l.url.startsWith("data:");
function decode(url: string): string | null {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  try { return m[1] ? atob(m[2]) : decodeURIComponent(m[2]); } catch { return null; }
}

let running = false;
/** Moves data: LUTs into files with writeLut (no undo step; the next autosave writes the smaller document). */
export async function migrateDataLuts(): Promise<number> {
  const b = bridge();
  const path = ed().path;
  const luts = project().luts ?? [];
  if (running || !b?.writeLut || !path || ed().demo || !luts.some(isData)) return 0;
  running = true;
  try {
    const moved = new Map<string, LutEntry>();
    for (const l of luts.filter(isData)) {
      const cube = decode(l.url!);
      if (!cube) continue;
      try { const r = await b.writeLut(path, safeName(l.name), cube); moved.set(l.id, { ...l, path: r.file, url: r.url }); } catch { /* kept as it is */ }
    }
    if (!moved.size) return 0;
    const p = project();
    replaceProject({ ...p, luts: (p.luts ?? []).map((l) => moved.get(l.id) ?? l) });
    return moved.size;
  } finally { running = false; }
}

/** After each save with the bridge present, data: LUTs move to files (EditorApp starts it; returns the stop). */
export function startLutMigration(): () => void {
  let last = ed().savedAt;
  return useEditor.subscribe((s) => {
    if (s.savedAt === last || s.saving) return;
    last = s.savedAt;
    void migrateDataLuts();
  });
}
