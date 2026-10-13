/**
 * Interchange with Premiere Pro, Audition, Resolve and OTIO tools (docs/EDITOR.md §12): one entry for every export
 * format and every import. The desktop (desktop/src/main/editor-interop.ts) calls these to write and read the files;
 * the converters are pure, so Node tests run them as they are.
 */
import type { EditProject } from "../model/types.ts";
import { buildProject, rebaseMedia, type BuildOptions, type BuildResult } from "./build.ts";
import { baseName, extOf, type LabelFn } from "./common.ts";
import { fromEdl, toEdl } from "./edl.ts";
import { fromFcpXml, toFcpXml } from "./fcpxml.ts";
import type { IrDoc } from "./ir.ts";
import { fromMarkersCsv, toMarkersCsv, toYoutubeChapters } from "./markers.ts";
import { fromOtio, toOtio } from "./otio.ts";
import type { ExportOptions, XFile } from "./prepare.ts";

export type InteropFormat = "premiere-xml" | "audition-xml" | "audition-stems" | "edl" | "otio" | "markers-csv" | "youtube-chapters";
export type InteropImportKind = "fcpxml" | "edl" | "otio" | "markers-csv";

export const INTEROP_FORMATS: Record<InteropFormat, { label: string; ext: string; note: string }> = {
  "premiere-xml": { label: "Premiere Pro XML", ext: "xml", note: "Final Cut Pro 7 XML: Premiere Pro (File → Import), DaVinci Resolve, FCP 7" },
  "audition-xml": { label: "Audition XML", ext: "xml", note: "The sound as clips with their levels, pan and fades, plus V1 for picture: Audition opens it as a multitrack session" },
  "audition-stems": { label: "Audition stems", ext: "xml", note: "Each audio track rendered to a 48 kHz WAV, and an XML that places the stems" },
  edl: { label: "EDL (CMX 3600)", ext: "edl", note: "V1 and A1–A4, cuts, dissolves, speed: opens everywhere" },
  otio: { label: "OpenTimelineIO", ext: "otio", note: "The whole timeline with markers and metadata: Resolve and OTIO tools" },
  "markers-csv": { label: "Markers CSV", ext: "csv", note: "Premiere's marker layout: Marker Name, Description, In, Out, Duration, Marker Type" },
  "youtube-chapters": { label: "YouTube chapters", ext: "txt", note: "\"0:00 Intro\" lines for a video description" },
};
export const isInteropFormat = (f: unknown): f is InteropFormat => typeof f === "string" && f in INTEROP_FORMATS;

export interface InteropExportOptions extends ExportOptions { labelFor?: LabelFn; title?: string }
export interface InteropExport { text: string; ext: string; warnings: string[]; files: XFile[] }

/** A sequence in one of the exchange formats. "audition-stems" needs `stems` (the desktop renders them). */
export function exportSequence(project: EditProject, sequenceId: string, format: InteropFormat, opts: InteropExportOptions = {}): InteropExport {
  const seq = project.sequences.find((s) => s.id === sequenceId);
  if (!seq) throw new Error("That sequence isn't in the edit");
  const ext = INTEROP_FORMATS[format].ext;
  switch (format) {
    case "premiere-xml": { const r = toFcpXml(project, sequenceId, opts); return { ...r, ext }; }
    case "audition-xml": { const r = toFcpXml(project, sequenceId, { ...opts, audition: true, videoTracks: [0] }); return { ...r, ext }; }
    case "audition-stems": {
      if (!opts.stems) throw new Error("Audition stems are rendered by Tatvam Desktop");
      const r = toFcpXml(project, sequenceId, { ...opts, audition: true, videoTracks: [0] });
      return { ...r, ext };
    }
    case "edl": { const r = toEdl(project, sequenceId, opts); return { ...r, ext, files: [] }; }
    case "otio": { const r = toOtio(project, sequenceId, opts); return { ...r, ext, files: [] }; }
    case "markers-csv": return { text: toMarkersCsv(seq), ext, warnings: seq.markers.length ? [] : ["The sequence has no markers"], files: [] };
    case "youtube-chapters": { const r = toYoutubeChapters(seq); return { ...r, ext, files: [] }; }
  }
}

/** Which importer reads a file (by its extension, else by a look at the text). */
export function detectImport(fileName: string, text: string): InteropImportKind | null {
  const e = extOf(fileName);
  if (e === "xml" || e === "fcpxml7") return "fcpxml";
  if (e === "edl") return "edl";
  if (e === "otio") return "otio";
  if (e === "csv" || e === "tsv") return "markers-csv";
  const head = text.slice(0, 2000);
  if (/<xmeml/i.test(head)) return "fcpxml";
  if (/"OTIO_SCHEMA"\s*:/.test(head)) return "otio";
  if (/^\s*(TITLE:|FCM:|\d{3,6}\s+\S+\s+\S+\s+[CDWK])/m.test(head)) return "edl";
  return null;
}

/** A timeline file → the IR (markers CSV isn't a timeline: use fromMarkersCsv). */
export function readTimeline(text: string, kind: Exclude<InteropImportKind, "markers-csv">, opts: { name?: string; fps?: number } = {}): IrDoc {
  if (kind === "fcpxml") return fromFcpXml(text, { name: opts.name });
  if (kind === "edl") return fromEdl(text, { name: opts.name, fps: opts.fps });
  return fromOtio(text, { name: opts.name });
}

/** A timeline file → a new edit project (media not probed yet: the desktop does that and calls rebaseMedia). */
export function importTimeline(text: string, fileName: string, opts: BuildOptions & { fps?: number } = {}): BuildResult & { kind: InteropImportKind } {
  const kind = detectImport(fileName, text);
  if (!kind || kind === "markers-csv") throw new Error(`${baseName(fileName)} isn't a timeline Tatvam reads (Final Cut Pro XML, CMX 3600 EDL or OpenTimelineIO)`);
  const name = opts.name ?? baseName(fileName).replace(/\.[^.]+$/, "");
  const doc = readTimeline(text, kind, { name, fps: opts.fps });
  return { ...buildProject(doc, { ...opts, name }), kind };
}

export { buildProject, fromMarkersCsv, rebaseMedia };
export type { IrDoc };
