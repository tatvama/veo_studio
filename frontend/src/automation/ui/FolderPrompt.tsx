/**
 * The folder prompt (docs/EDITOR.md §13.1): "Claude Desktop wants to use D:\Shoots\Day1" with Allow once, Always and
 * Deny. No answer in 60 s is a Deny (the main process decides; this shows the countdown). Mounting it makes this
 * window a place prompts can show.
 */
import { FolderOpen, ShieldQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui";
import type { FolderAnswer, FolderPromptRequest } from "../../lib/desktop";
import { assistantsBridge } from "../api";

export default function FolderPrompt() {
  const [list, setList] = useState<FolderPromptRequest[]>([]);
  const [, tick] = useState(0);
  useEffect(() => {
    const b = assistantsBridge();
    if (!b) return;
    const off = b.onFolderPrompt((p) => {
      if ("closed" in p) setList((l) => l.filter((x) => x.id !== p.id));
      else setList((l) => (l.some((x) => x.id === p.id) ? l : [...l, p]));
    });
    void b.promptHost(true).catch(() => undefined);
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => { off(); window.clearInterval(t); void b.promptHost(false).catch(() => undefined); };
  }, []);
  const p = list[0];
  if (!p) return null;
  const left = Math.max(0, Math.round((Date.parse(p.expiresAt) - Date.now()) / 1000));
  const answer = (a: FolderAnswer) => {
    setList((l) => l.filter((x) => x.id !== p.id));
    void assistantsBridge()?.answerFolderPrompt(p.id, a).catch(() => undefined);
  };
  return (
    <div className="fixed inset-0 z-[300] grid place-items-center bg-black/55 p-4" role="alertdialog" aria-modal="true" aria-labelledby="folder-prompt-title">
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-warn/12 text-amber-300"><ShieldQuestion className="size-5" /></span>
          <div className="min-w-0 flex-1">
            <p id="folder-prompt-title" className="font-semibold leading-snug">{p.client} wants to use a folder</p>
            <p className="mt-1.5 flex items-center gap-1.5 break-all rounded-lg border border-line bg-raised px-2.5 py-1.5 font-mono text-xs text-ink">
              <FolderOpen className="size-3.5 shrink-0 text-mute" />{p.folder}
            </p>
            <p className="mt-2 text-xs text-mute">{p.why ? `It asks ${p.why}. ` : ""}Only video, audio, pictures and timeline files there can be read. Deny is chosen in {left} s.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => answer("deny")} autoFocus>Deny</Button>
          <Button variant="secondary" onClick={() => answer("once")} title="For this assistant's session only">Allow once</Button>
          <Button variant="primary" onClick={() => answer("always")} title="Added to Settings → AI assistants → Folders">Always</Button>
        </div>
        {list.length > 1 && <p className="mt-2 text-right text-2xs text-dim">{list.length - 1} more waiting</p>}
      </div>
    </div>
  );
}
