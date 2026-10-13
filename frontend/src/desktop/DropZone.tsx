/**
 * Drag and drop from Explorer onto any window (desktop shell). Drops a page handles itself (the editor's panels and
 * timeline, upload fields) stay with it; the rest land here:
 *  - a folder → "New edit from this folder" (an empty edit with its clips, or Auto edit),
 *  - a .tatvamedit → opens it; an .xml / .edl / .otio → imported as a new edit (editor-interop, when it's in this build),
 *  - media files → into the open edit (the editor registers a drop target), else the open studio project's media
 *    library, else a new edit with them.
 */
import { FilePlus2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { desktop, type DropEntry } from "../lib/desktop";
import { folderChoice, importTimeline, newEditWithClips, uploadToProject } from "./actions";
import { editUrl, errText } from "./bridge";
import { currentDropTargets } from "./state";

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

export function DropZone() {
  const nav = useNavigate();
  const loc = useLocation();
  const [over, setOver] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const locRef = useRef(loc);
  locRef.current = loc;

  useEffect(() => {
    const d = desktop();
    if (!d?.shell) return;
    const hideSoon = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOver(false), 250); };
    const dragover = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      setOver(true);
      hideSoon();
      if (!e.defaultPrevented) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; }
    };
    const drop = (e: DragEvent) => {
      setOver(false);
      if (!hasFiles(e) || e.defaultPrevented) return; // the page took it
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void handle(files);
    };
    const handle = async (files: File[]) => {
      let entries: DropEntry[] = [];
      try { entries = (await d.shell!.dropped(files)).entries; } catch (err) { toast.error(errText(err)); return; }
      if (!entries.length) { toast.message("Nothing Tatvam can open was dropped"); return; }
      const folder = entries.find((x) => x.type === "folder");
      const edit = entries.find((x) => x.type === "edit");
      const timeline = entries.find((x) => x.type === "timeline");
      const media = entries.filter((x) => x.type === "media");
      if (edit) { nav(editUrl(edit.path)); return; }
      if (timeline) { await importTimeline(timeline.path, nav); return; }
      if (folder) { folderChoice(folder); return; }
      if (media.length) {
        const paths = media.map((m) => m.path);
        for (const t of currentDropTargets()) {
          if (t.media && (await t.media(paths))) return;
        }
        const pid = /^\/p\/(\d+)/.exec(locRef.current.pathname)?.[1];
        if (pid) {
          const byPath = new Map(files.map((f) => [f.name, f]));
          await uploadToProject(Number(pid), media.map((m) => byPath.get(m.name)).filter((f): f is File => Boolean(f)));
          return;
        }
        await newEditWithClips(media.length === 1 ? media[0].name.replace(/\.[^.]+$/, "") : "Dropped clips", paths, nav);
        return;
      }
      toast.message(`${entries[0].name}: Tatvam opens folders of clips, video, audio and images, .tatvamedit edits, and XML, EDL or OTIO timelines`);
    };
    window.addEventListener("dragover", dragover);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", dragover); window.removeEventListener("drop", drop); window.clearTimeout(timer.current); };
  }, [nav]);

  if (!over) return null;
  const inEdit = loc.pathname === "/editor/edit";
  const inProject = /^\/p\/\d+/.test(loc.pathname);
  return (
    <div className="desk-ui desk-drop" aria-hidden>
      <div>
        <FilePlus2 className="mx-auto mb-2 size-6 text-accent-ink" />
        <p className="text-sm font-medium">Drop to open or import</p>
        <p className="mt-1 text-2xs leading-snug text-dim">
          A folder starts a new edit · media goes {inEdit ? "into this edit" : inProject ? "to this project's media" : "into a new edit"} · .tatvamedit, XML, EDL and OTIO open
        </p>
      </div>
    </div>
  );
}
