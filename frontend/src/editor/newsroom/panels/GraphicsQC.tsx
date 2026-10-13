/**
 * News Room: the graphics check (docs/EDITOR.md §16.10). Checks every graphic on the sequence, in every ratio the edit
 * delivers: text that doesn't fit, letters the fonts lack, the safe area, crawl speed, hold times, graphics covering
 * each other, empty fields, old data and AI pictures without a label. Findings are grouped; click one to jump to its
 * frame with the graphic selected, "Fix" where one step can fix it, then the check runs again. Below: the automatic
 * graphics (name straps from the transcript, AI-generated labels).
 */
import { clsx } from "clsx";
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, ShieldCheck, UserRound, Wand2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../components/ui";
import { useEditorHost } from "../../host";
import { toTimecode } from "../../model/time";
import { program } from "../../playback/transport";
import { project, select, seq, setFocus, useProject, useSequence } from "../../store";
import { AutoDialog } from "../auto/AutoDialog";
import { refreshSources } from "../feeds/actions";
import { applyFix, groupFindings, type Finding } from "../qc/checks";
import { runQcInPage } from "../qc/browser";
import { useNewsroomDoc } from "../room/hooks";
import { NoNewsroom } from "../room/pickers";

export default function GraphicsQC() {
  const host = useEditorHost();
  const nr = useNewsroomDoc();
  const p = useProject();
  const s = useSequence();
  const [found, setFound] = useState<{ list: Finding[]; for: typeof p; seq: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<"speakers" | "ai" | null>(null);
  if (!nr) return <div className="pn"><NoNewsroom what="Check every graphic before export: text that doesn't fit, the safe area, crawl speed, hold times, overlaps, old data and AI labels." /></div>;

  const run = async () => {
    setBusy(true);
    try { const sq = seq(); setFound({ list: await runQcInPage(project(), sq.id), for: project(), seq: sq.id }); }
    finally { setBusy(false); }
  };
  const jump = (f: Finding) => {
    program.pause();
    program.seek(f.frame);
    if (f.clipId) select([f.clipId], "set", { linked: false });
  };
  const fix = async (f: Finding) => {
    if (!f.fix) return;
    if (f.fix.kind === "refresh") await refreshSources(host, [f.fix.sourceId]);
    else { const x = f.fix; host.apply(x.label, (d) => { applyFix(d, s.id, x); }); }
    await run();
  };
  const list = found && found.seq === s.id ? found.list : null;
  const changed = !!found && (found.for !== p || found.seq !== s.id);
  const groups = list ? groupFindings(list) : [];
  const errors = list?.filter((f) => f.severity === "error").length ?? 0;

  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-2">
        <Button size="sm" variant={list ? "secondary" : "primary"} loading={busy} icon={<ShieldCheck className="size-3.5" />} onClick={() => void run()}>
          {list ? "Check again" : "Check graphics"}
        </Button>
        <span className="min-w-0 flex-1 truncate text-2xs text-dim">
          {!list ? "" : !list.length ? "All clear" : `${list.length} ${list.length === 1 ? "thing" : "things"} to look at${errors ? `, ${errors} to fix before export` : ""}`}
          {changed && list ? " · the edit has changed since" : ""}
        </span>
      </div>
      <div className="pn-scroll">
        {!list && !busy && (
          <div className="px-4 py-6 text-center text-xs text-dim">
            <ShieldCheck className="mx-auto mb-2 size-6 text-dim" />
            <p className="mx-auto max-w-[300px]">Checks every graphic on this sequence{nr.ratio === "both" ? ", in 16:9 and 9:16," : ""} for text that doesn't fit, missing letters, the safe area, crawl speed, hold times, overlaps, empty fields, old data and AI labels.</p>
          </div>
        )}
        {busy && !list && <div className="flex items-center justify-center gap-2 py-8 text-xs text-dim"><Loader2 className="size-3.5 animate-spin" />Checking…</div>}
        {list && !list.length && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-dim">
            <CheckCircle2 className="size-6 text-ok" />
            <p>Every graphic fits, reads in time and stays inside the safe area.</p>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.kind}>
            <div className="pn-section" onClick={() => setShut((x) => ({ ...x, [g.kind]: !x[g.kind] }))}>
              {shut[g.kind] ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              <span className="flex-1">{g.label}</span>
              <span className="text-dim">{g.items.length}</span>
            </div>
            {!shut[g.kind] && g.items.map((f) => (
              <div key={f.id} className="group flex cursor-pointer items-start gap-2 border-b border-line/60 px-2 py-1.5 hover:bg-hover/60" onClick={() => jump(f)} title="Go to this frame">
                <span className={clsx("mt-1.5 size-1.5 shrink-0 rounded-full", f.severity === "error" ? "bg-bad" : "bg-warn")} />
                <span className="min-w-0 flex-1 text-xs leading-snug text-ink/90">{f.message}</span>
                <span className="ed-tc mt-0.5 shrink-0 text-[10px] text-dim">{toTimecode(f.frame, s.fps)}</span>
                {f.fix && (
                  <Button size="sm" variant="ghost" className="-my-0.5 h-6 shrink-0 px-2 text-2xs" icon={<Wand2 className="size-3" />}
                    onClick={(e) => { e.stopPropagation(); void fix(f); }}>{f.fix.label}</Button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="border-t border-line px-2 py-2">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-dim">Automatic graphics</div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" icon={<UserRound className="size-3.5" />} onClick={() => setDialog("speakers")} title="Name straps where each person starts speaking, from the transcript">Add speaker straps…</Button>
          <Button size="sm" variant="secondary" icon={<Bot className="size-3.5" />} onClick={() => setDialog("ai")} title="The AI-generated label over studio-made pictures">Add AI labels…</Button>
        </div>
        <label className="mt-2 flex items-center gap-2 text-2xs text-mute">
          <input type="checkbox" checked={nr.settings.aiLabel} onChange={(e) => { const on = e.target.checked; host.apply(on ? "Require AI labels" : "Don't require AI labels", (d) => { if (d.newsroom) d.newsroom.settings.aiLabel = on; }); }} />
          Studio-made (AI) pictures need the “AI-generated” label (India IT Rules 2026)
        </label>
      </div>
      <AutoDialog kind={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}
