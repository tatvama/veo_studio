/**
 * Find and replace across every graphic's words (docs/EDITOR.md §16.8), from the Graphics or Fill in panel's "⋯"
 * menu: a name spelled wrong in ten straps, a place renamed, a figure updated. The matches are listed (click one to
 * go there); "Replace all" is one undo step.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button, Input, Modal } from "../../../components/ui";
import { toTimecode } from "../../model/time";
import { program } from "../../playback/transport";
import { openSequence } from "../../actions";
import { project, select, useProject } from "../../store";
import { findInGraphics, replaceInGraphics, type FindOptions } from "./textSearch";
import { host } from "./actions";
import { tplById } from "./hooks";

let open = false, ver = 0;
const subs = new Set<() => void>();
const emit = () => { ver++; subs.forEach((f) => f()); };
export function openFindReplace() { open = true; emit(); }
const close = () => { open = false; emit(); };
const useVersion = () => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => ver, () => ver);

let hosts: symbol[] = [];
/** Mount in each panel that offers it; only the first mounted one draws the dialog. */
export function FindReplaceHost() {
  const [me] = useState(() => Symbol("fr"));
  useEffect(() => {
    hosts = [...hosts, me]; emit();
    return () => { hosts = hosts.filter((x) => x !== me); emit(); };
  }, [me]);
  useVersion();
  if (hosts[0] !== me || !open) return null;
  return <FindReplaceDialog />;
}

function FindReplaceDialog() {
  const p = useProject();
  const [q, setQ] = useState("");
  const [to, setTo] = useState("");
  const [o, setO] = useState<FindOptions & { here: boolean }>({ matchCase: false, wholeWord: false, here: false });
  const opts: FindOptions = { matchCase: o.matchCase, wholeWord: o.wholeWord, seqId: o.here ? p.activeSequenceId : undefined };
  const hits = useMemo(() => (q.trim() ? findInGraphics(p, q, opts) : []), [p, q, o]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = hits.reduce((n, h) => n + h.count, 0);
  const replace = () => {
    let n = 0;
    host().apply(`Replace "${q}"`, (d) => { n = replaceInGraphics(d, q, to, opts); });
    toast.success(n ? `Replaced ${n} time${n === 1 ? "" : "s"}` : "Nothing to replace");
  };
  const go = (seqId: string, clipId: string, start: number) => {
    if (project().activeSequenceId !== seqId) openSequence(seqId);
    program.seek(start);
    select([clipId], "set", { linked: false });
  };
  const fieldLabel = (clipId: string, seqId: string, field: string) => {
    const c = p.sequences.find((s) => s.id === seqId)?.clips.find((x) => x.id === clipId);
    const t = c?.source.type === "graphic" ? tplById(p, c.source.gfx.template) : undefined;
    return t?.fields.find((f) => f.id === field)?.label ?? field;
  };
  const fps = p.sequences.find((s) => s.id === p.activeSequenceId)?.fps ?? 25;
  return (
    <Modal open onClose={close} title="Find and replace in graphics" size="md"
      footer={<><Button variant="ghost" onClick={close}>Close</Button><Button variant="primary" disabled={!total} onClick={replace}>Replace all{total ? ` (${total})` : ""}</Button></>}>
      <div className="grid gap-3">
        <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2 text-xs">
          <span className="text-mute">Find</span>
          <Input data-autofocus className="h-8 text-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A name, a place, a figure…" />
          <span className="text-mute">Replace with</span>
          <Input className="h-8 text-sm" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && total) replace(); }} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!o.matchCase} onChange={(e) => setO({ ...o, matchCase: e.target.checked })} />Match capitals</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!o.wholeWord} onChange={(e) => setO({ ...o, wholeWord: e.target.checked })} />Whole words</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={o.here} onChange={(e) => setO({ ...o, here: e.target.checked })} />This sequence only</label>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
          {!q.trim() ? <p className="p-3 text-xs text-dim">Type what to look for: every strap, ticker, board and language version is searched.</p>
            : !hits.length ? <p className="p-3 text-xs text-dim">No graphic has “{q}”.</p>
            : hits.map((h, i) => (
              <button key={i} type="button" onClick={() => go(h.seqId, h.clipId, h.start)} className="pn-row w-full gap-2 border-b border-line py-1.5 text-left text-xs last:border-0">
                <span className="mono w-20 shrink-0 text-2xs text-dim">{toTimecode(h.start, fps)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{h.excerpt}</span>
                  <span className="block truncate text-2xs text-dim">{h.clipName} · {fieldLabel(h.clipId, h.seqId, h.field)}{h.lang ? ` · ${h.lang.toUpperCase()}` : ""}</span>
                </span>
                {h.count > 1 && <span className="shrink-0 text-2xs text-mute">×{h.count}</span>}
              </button>
            ))}
        </div>
      </div>
    </Modal>
  );
}
