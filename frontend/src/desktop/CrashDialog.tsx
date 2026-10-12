/**
 * Crash recovery: when the last run ended without a clean quit, "Tatvam closed unexpectedly" offers to reopen the last
 * windows (the page the main window was on, the pop-out panels, the edit that was open: its autosave has the latest).
 */
import { LifeBuoy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Modal } from "../components/ui";
import { desktop, type ShellState } from "../lib/desktop";
import { ago } from "./bridge";

export function CrashDialog({ state }: { state: ShellState | null }) {
  const [open, setOpen] = useState(false);
  const c = state?.crashed;
  useEffect(() => { if (c) setOpen(true); }, [c]);
  if (!c) return null;
  const edit = c.editPath ? c.editPath.split(/[\\/]/).pop()?.replace(/\.tatvamedit$/i, "") : null;
  const where = edit ? `the edit "${edit}"` : c.url && c.url !== "/desktop/panel/start" ? c.url.replace(/\?.*$/, "") : null;
  const done = (reopen: boolean) => { setOpen(false); void desktop()?.shell?.recover(reopen); };
  return (
    <Modal open={open} onClose={() => done(false)} title={<span className="flex items-center gap-2"><LifeBuoy className="size-4 text-warn" />Tatvam closed unexpectedly</span>} size="sm"
      footer={<><Button variant="ghost" onClick={() => done(false)}>Start fresh</Button><Button variant="primary" data-autofocus onClick={() => done(true)}>Reopen last windows</Button></>}>
      <div className="space-y-2 text-sm text-mute">
        <p>The last session ({ago(c.at)}) didn't close normally.{where ? ` You were on ${where}.` : ""}{c.panels.length ? ` ${c.panels.length} panel${c.panels.length === 1 ? " was" : "s were"} open.` : ""}</p>
        {edit && <p className="text-2xs text-dim">Edits save themselves every few seconds, so the edit opens as it was last saved.</p>}
      </div>
    </Modal>
  );
}
