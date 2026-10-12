/**
 * "New edit from this folder" (Start, the Jump List, a folder dropped from Explorer): two ways to start —
 * "Empty edit with these clips" (the clips in the project panel, the timeline empty) or "Auto edit…" (desktop-mcp's
 * AutoEditDialog, when this build has it).
 */
import { clsx } from "clsx";
import { FolderOpen, Sparkles, Wand2 } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Modal, Spinner } from "../components/ui";
import { newEditWithClips } from "./actions";
import { loadAutoEdit } from "./automation";
import { chooseFolderEdit, useShellUi } from "./state";

export function FolderEditChoice() {
  const { folder } = useShellUi();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState<{ folder: string; files: string[] } | null>(null);
  const AutoEdit = useMemo(() => (loadAutoEdit ? lazy(loadAutoEdit) : null), []);
  const close = () => chooseFolderEdit(null);
  const n = folder?.media?.length ?? 0;
  const kinds = useMemo(() => {
    const c = { video: 0, audio: 0, image: 0 };
    for (const f of folder?.media ?? []) {
      const e = f.split(".").pop()?.toLowerCase() ?? "";
      if (["mp4", "mov", "mkv", "webm", "m4v", "avi"].includes(e)) c.video++;
      else if (["wav", "mp3", "aac", "m4a", "flac", "ogg"].includes(e)) c.audio++;
      else c.image++;
    }
    return [c.video && `${c.video} video`, c.audio && `${c.audio} audio`, c.image && `${c.image} image${c.image === 1 ? "" : "s"}`].filter(Boolean).join(", ");
  }, [folder]);
  const empty = async () => {
    if (!folder) return;
    setBusy(true);
    const ok = await newEditWithClips(folder.name, folder.media ?? [], (to) => nav(to));
    setBusy(false);
    if (ok) close();
  };
  return (
    <>
      <Modal open={Boolean(folder)} onClose={close} title="New edit from this folder" size="md"
        footer={<Button variant="ghost" onClick={close}>Cancel</Button>}>
        {folder && (
          <div className="desk-ui space-y-3">
            <div className="flex items-center gap-3 rounded-xl border border-line bg-raised px-3 py-2.5">
              <FolderOpen className="size-5 shrink-0 text-accent-ink" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{folder.name}</p>
                <p className="mono truncate text-2xs text-dim" title={folder.path}>{n} clip{n === 1 ? "" : "s"}{kinds ? ` · ${kinds}` : ""} · {folder.path}</p>
              </div>
            </div>
            <button type="button" data-autofocus disabled={busy} onClick={() => void empty()}
              className="group flex w-full items-start gap-3 rounded-xl border border-line px-3.5 py-3 text-left transition-colors hover:border-accent/40 hover:bg-hover disabled:opacity-60">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-mute group-hover:text-accent-ink">{busy ? <Spinner /> : <FolderOpen className="size-4" />}</span>
              <span>
                <span className="block text-sm font-medium">Empty edit with these clips</span>
                <span className="block text-2xs leading-snug text-dim">A new edit named "{folder.name}" with the clips in its Project panel, ready for you to cut.</span>
              </span>
            </button>
            <button type="button" disabled={!AutoEdit || busy} onClick={() => { setAuto({ folder: folder.path, files: folder.media ?? [] }); close(); }}
              className={clsx("group flex w-full items-start gap-3 rounded-xl border border-line px-3.5 py-3 text-left transition-colors",
                AutoEdit ? "hover:border-ai/40 hover:bg-hover" : "cursor-not-allowed opacity-60")}>
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-mute group-hover:text-ai"><Wand2 className="size-4" /></span>
              <span>
                <span className="flex items-center gap-2 text-sm font-medium">Auto edit…{!AutoEdit && <span className="rounded-md border border-line px-1.5 text-2xs font-normal text-dim">Coming soon</span>}</span>
                <span className="block text-2xs leading-snug text-dim">Let the assistant pick the best takes and make a first cut from this folder.</span>
              </span>
              <Sparkles className="ml-auto mt-1 size-3.5 shrink-0 text-ai/70" />
            </button>
          </div>
        )}
      </Modal>
      {auto && AutoEdit && (
        <Suspense fallback={null}>
          <AutoEdit folder={auto.folder} files={auto.files} open onClose={() => setAuto(null)} />
        </Suspense>
      )}
    </>
  );
}
