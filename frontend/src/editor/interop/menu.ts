/**
 * The editor's File menu entries for interchange (docs/EDITOR.md §12): Export for Premiere Pro / Audition (XML), EDL,
 * OTIO, markers CSV and YouTube chapters; Open in Premiere Pro; Send to Audition (stems + XML); Import XML / EDL /
 * OTIO as a new edit; Import markers CSV into this sequence. The desktop writes and reads the files (bridge
 * editor.interop); the edit is saved first because the desktop reads the saved file. Not used by the desktop.
 */
import { toast } from "sonner";
import { editorBridge, type InteropExportResult, type InteropFormat } from "../../lib/desktop";
import { uid } from "../model/ids";
import type { EditProject, Marker, MediaItem } from "../model/types";
import { save } from "../session";
import { ed, exec, isDirty, project, setUrls } from "../store";
import type { MenuItem } from "../ui";
import { rebaseMedia } from "./build";
import { fromMarkersCsv } from "./markers";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p;

function showWarnings(ws: string[]) {
  if (!ws.length) return;
  const head = ws.slice(0, 3);
  for (const w of head) toast.warning(w);
  if (ws.length > head.length) toast.message(`${ws.length - head.length} more note${ws.length - head.length === 1 ? "" : "s"} about the export`, { description: ws.slice(3, 8).join("\n") });
}

/** Studio media the desktop made local for the export: the edit's items point at the local copies now (one undo step). */
function applyPulled(pulled: { mediaId: string; item: MediaItem }[]) {
  if (!pulled.length) return;
  exec("Make studio media local", (p) => pulled.reduce((q: EditProject, x) => rebaseMedia(q, x.mediaId, x.item), p));
  setUrls(Object.fromEntries(pulled.filter((x) => x.item.url).map((x) => [x.mediaId, x.item.url!])));
}

async function exportNow(format: InteropFormat, quiet = false): Promise<InteropExportResult | null> {
  const b = editorBridge();
  const path = ed().path;
  if (!b?.interop || !path) { toast.message(ed().demo ? "Exports for other apps need Tatvam Desktop (the demo edit isn't on disk)" : "This needs a newer Tatvam Desktop"); return null; }
  if (isDirty() && !(await save())) return null;
  const p = project();
  const t = toast.loading(format === "audition-stems" ? "Rendering the audio stems…" : "Writing the file…");
  try {
    const r = await b.interop.exportFile(path, p.activeSequenceId, format);
    toast.dismiss(t);
    if (!r) return null;
    applyPulled(r.pulled);
    if (!quiet) toast.success(`Saved ${nameOf(r.path)}`, { description: folderOf(r.path) });
    showWarnings(r.warnings);
    return r;
  } catch (e) {
    toast.dismiss(t);
    toast.error(`Export failed: ${msg(e)}`);
    return null;
  }
}

async function openIn(app: "premiere" | "audition") {
  const r = await exportNow(app === "premiere" ? "premiere-xml" : "audition-stems", true);
  if (!r) return;
  const b = editorBridge()!;
  const label = app === "premiere" ? "Premiere Pro" : "Audition";
  try {
    const o = await b.interop!.openIn(app, r.path);
    if (o.opened === "app") toast.success(`Opening it in ${o.app ?? label}`, { description: app === "premiere" ? "Premiere imports the XML as a new sequence" : "Audition opens the stems as a multitrack session" });
    else toast.message(`${label} isn't installed on this PC: the file is in ${folderOf(r.path)}`, { description: nameOf(r.path) });
  } catch (e) {
    toast.error(`Couldn't open ${label}: ${msg(e)}`);
  }
}

/** XML / EDL / OTIO → a new edit (`go` opens it, asking about unsaved changes first); a markers CSV → this sequence. */
export async function importInterchange(go: (path: string) => void, onlyMarkers = false) {
  const b = editorBridge();
  if (!b?.interop) { toast.message("Importing timelines needs a newer Tatvam Desktop"); return; }
  try {
    const r = await b.interop.importFile();
    if (!r) return;
    if (r.kind === "markers") {
      const p = project();
      const seq = p.sequences.find((s) => s.id === p.activeSequenceId);
      if (!seq || !ed().path && !ed().demo) { toast.message("Open an edit to add markers to"); return; }
      const { markers, warnings } = fromMarkersCsv(r.text, seq.fps);
      if (!markers.length) { toast.error(warnings[0] ?? "The file has no markers"); return; }
      const add: Marker[] = markers.map((m) => ({ id: uid("m"), frame: m.frame, duration: m.duration, name: m.name, color: m.color, ...(m.comment ? { comment: m.comment } : {}), ...(m.kind ? { kind: m.kind } : {}) }));
      exec(`Import ${markers.length} markers`, (q) => ({ ...q, sequences: q.sequences.map((s) => (s.id === seq.id ? { ...s, markers: [...s.markers, ...add].sort((x, y) => x.frame - y.frame) } : s)) }));
      toast.success(`Added ${markers.length} marker${markers.length === 1 ? "" : "s"} from ${r.name}`);
      showWarnings(warnings);
      return;
    }
    if (onlyMarkers) toast.message("That was a timeline: it opens as a new edit");
    toast.success(`Imported ${r.name}`, { description: r.missing ? `${r.missing} file${r.missing === 1 ? " is" : "s are"} offline: relink in the Project panel` : undefined });
    showWarnings(r.warnings.filter((w) => !/aren't on this PC|isn't on this PC/.test(w)));
    go(r.path);
  } catch (e) {
    toast.error(`Import failed: ${msg(e)}`);
  }
}

/** The File menu entries (EditorApp). `go` opens an edit by path (with the unsaved-changes guard). */
export function interopFileItems(go: (path: string) => void): MenuItem[] {
  const ok = !!editorBridge()?.interop;
  const x = (label: string, format: InteropFormat): MenuItem => ({ label, disabled: !ok, onClick: () => void exportNow(format) });
  return [
    { label: "Export for other apps", separator: true, disabled: !ok, items: [
      x("Premiere Pro XML (FCP 7)…", "premiere-xml"),
      x("Audition XML…", "audition-xml"),
      x("Audition stems + XML…", "audition-stems"),
      x("EDL (CMX 3600)…", "edl"),
      x("OpenTimelineIO (.otio)…", "otio"),
      x("Markers CSV…", "markers-csv"),
      x("YouTube chapters…", "youtube-chapters"),
    ] },
    { label: "Open in Premiere Pro", disabled: !ok, onClick: () => void openIn("premiere") },
    { label: "Send to Audition", disabled: !ok, onClick: () => void openIn("audition") },
    { label: "Import XML, EDL or OTIO…", disabled: !ok, onClick: () => void importInterchange(go) },
    { label: "Import markers CSV…", disabled: !ok, onClick: () => void importInterchange(go, true) },
  ];
}
