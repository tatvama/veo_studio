/**
 * "<client> is editing — Pause / Stop" (docs/EDITOR.md §13.1): shows while an assistant is connected and has acted in
 * the last two minutes (or is acting now). Pause makes further tool calls wait; Stop ends the session. It also hosts
 * the folder prompt, so any window that mounts the banner can ask.
 */
import { clsx } from "clsx";
import { Bot, Pause, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { AssistantSession } from "../../lib/desktop";
import { assistantsBridge } from "../api";
import FolderPrompt from "./FolderPrompt";
import { useAssistants } from "./useAssistants";

const RECENT_MS = 2 * 60_000;

export default function AssistantBanner() {
  const [st, setSt] = useAssistants();
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 5000); return () => window.clearInterval(t); }, []);
  const b = assistantsBridge();
  if (!b) return null;
  const active = (st?.sessions ?? []).filter((s: AssistantSession) => s.busy || (s.lastCall && Date.now() - Date.parse(s.lastCall) < RECENT_MS));
  const show = st?.enabled && active.length > 0;
  const names = [...new Set(active.map((s) => s.client))];
  const label = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const busy = active.some((s) => s.busy);
  const last = active.map((s) => s.lastTool).filter(Boolean)[0];
  return (
    <>
      <FolderPrompt />
      {show && (
        <div role="status" aria-live="polite"
          className={clsx("fixed bottom-9 right-4 z-[250] flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-xl backdrop-blur",
            st?.paused ? "border-warn/40 bg-warn/15 text-amber-200" : "border-ai/40 bg-panel/90 text-ink")}>
          <Bot className={clsx("size-4", !st?.paused && busy && "animate-pulse text-ai")} />
          <span className="font-medium">{st?.paused ? `${label} is paused` : `${label} is editing`}</span>
          {!st?.paused && last && <span className="hidden text-mute sm:inline">· {last.replace(/_/g, " ")}</span>}
          <span className="mx-0.5 h-4 w-px bg-line" />
          <button type="button" className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-hover"
            onClick={() => void b.pause(!st?.paused).then(setSt)} title={st?.paused ? "Let it carry on" : "Its next tool calls wait until you resume"}>
            {st?.paused ? <><Play className="size-3.5" />Resume</> : <><Pause className="size-3.5" />Pause</>}
          </button>
          <button type="button" className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-red-300 hover:bg-bad/15"
            onClick={() => void b.stop().then(setSt)} title="End the assistant's session now">
            <Square className="size-3" />Stop
          </button>
        </div>
      )}
    </>
  );
}
