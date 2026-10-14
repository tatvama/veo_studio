/**
 * The automatic graphics dialogs (docs/EDITOR.md §16.10): "Add speaker straps" and "Add AI labels" show what would be
 * placed (and what is left out, and why) before anything changes; one click places it all in one undo step, replacing
 * what the same tool placed last time. Click a row to see that moment.
 */
import { Bot, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Modal } from "../../../components/ui";
import { useEditorHost } from "../../host";
import { framesToSeconds, toTimecode } from "../../model/time";
import { program } from "../../playback/transport";
import { useProject, useSequence } from "../../store";
import { aiLabels, applyAiLabels } from "./aiLabels";
import { applySpeakerStraps, speakerStraps } from "./speakers";
import { aiLabelTemplate, templatePool } from "./tags";
import { speakerLabels, transcriptsFor } from "./transcripts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function AutoDialog({ kind, onClose }: { kind: "speakers" | "ai" | null; onClose: () => void }) {
  return (
    <Modal open={!!kind} onClose={onClose} title={kind === "ai" ? "Add AI-generated labels" : "Add name straps from the transcript"} wide>
      {kind === "speakers" ? <Speakers onClose={onClose} /> : kind === "ai" ? <AiLabels onClose={onClose} /> : null}
    </Modal>
  );
}

function Row({ at, fps, children, dim, onClick }: { at: number; fps: number; children: React.ReactNode; dim?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={() => { program.pause(); program.seek(at); onClick?.(); }}
      className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover ${dim ? "text-dim" : ""}`}>
      <span className="ed-tc w-[86px] shrink-0 text-2xs text-mute">{toTimecode(at, fps)}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function Speakers({ onClose }: { onClose: () => void }) {
  const host = useEditorHost();
  const p = useProject();
  const s = useSequence();
  const [gap, setGap] = useState(8);
  const [again, setAgain] = useState(90);
  const ts = useMemo(() => transcriptsFor(p), [p]);
  const labels = useMemo(() => speakerLabels(ts), [ts]);
  const plan = useMemo(() => speakerStraps(p, s.id, { transcripts: ts, minGap: gap, repeatAfter: again }), [p, s.id, ts, gap, again]);
  const names = useMemo(() => new Map(templatePool(p).map((t) => [t.id, t.name])), [p]);
  const apply = () => {
    host.apply(plan.items.length ? "Add speaker straps" : "Remove speaker straps", (d) => { applySpeakerStraps(d, s.id, plan); });
    toast.success(plan.items.length ? `Added ${plural(plan.items.length, "name strap")}` : `Removed ${plural(plan.replaced.length, "strap")}`);
    onClose();
  };
  const people = p.newsroom?.people ?? [];
  if (!Object.keys(ts).length) {
    return <Empty text="There's no transcript for the clips in this sequence yet. Transcribe them in the Transcript panel (Tatvam Desktop), then set each person's speaker label in People." onClose={onClose} />;
  }
  if (!labels.length) {
    return <Empty text="The transcripts don't say who is speaking (no speaker labels), so straps can't be placed by speaker." onClose={onClose} />;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-mute">
        A name strap goes in where each person starts speaking, matched by their speaker label in People
        {people.length ? "" : " (nobody is in People yet)"}. Straps placed by hand stay as they are.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-mute">
        <label className="flex items-center gap-1.5">At least
          <input type="number" min={2} max={120} value={gap} onChange={(e) => setGap(Math.max(2, Number(e.target.value) || 8))} className="ed-field w-14" /> s between straps</label>
        <label className="flex items-center gap-1.5">Name the same person again after
          <input type="number" min={10} max={1200} value={again} onChange={(e) => setAgain(Math.max(10, Number(e.target.value) || 90))} className="ed-field w-16" /> s</label>
      </div>
      <div className="max-h-[46vh] overflow-y-auto rounded-lg border border-line p-1">
        {!plan.items.length && !plan.skipped.length && <p className="px-2 py-3 text-sm text-dim">No speaker changes found.</p>}
        {[...plan.items.map((it) => ({ at: it.at, item: it, skip: null })), ...plan.skipped.map((sk) => ({ at: sk.at, item: null, skip: sk }))]
          .sort((a, b) => a.at - b.at).map((r, i) => r.item ? (
            <Row key={i} at={r.item.at} fps={s.fps}>
              <span className="flex items-center gap-2"><UserRound className="size-3.5 shrink-0 text-accent-ink" /><span className="font-medium">{r.item.name}</span>
                <span className="truncate text-2xs text-dim">{names.get(r.item.template) ?? r.item.template} · {framesToSeconds(r.item.duration, s.fps).toFixed(1)} s</span></span>
            </Row>
          ) : (
            <Row key={i} at={r.skip!.at} fps={s.fps} dim>
              <span className="text-xs">{r.skip!.speaker}: {r.skip!.reason[0].toLowerCase() + r.skip!.reason.slice(1)}</span>
            </Row>
          ))}
      </div>
      {!!plan.unmatched.length && (
        <p className="text-xs text-warn">
          {plan.unmatched.join(", ")} {plan.unmatched.length === 1 ? "isn't" : "aren't"} anyone in People yet. Add {plan.unmatched.length === 1 ? "them" : "each"} in People and set the speaker label to match.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {!!plan.replaced.length && <span className="mr-auto text-2xs text-dim">Replaces the {plural(plan.replaced.length, "strap")} added last time.</span>}
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!plan.items.length && !plan.replaced.length} onClick={apply}>
          {plan.items.length ? `Add ${plural(plan.items.length, "strap")}` : plan.replaced.length ? `Remove ${plural(plan.replaced.length, "strap")}` : "Add straps"}
        </Button>
      </div>
    </div>
  );
}

function AiLabels({ onClose }: { onClose: () => void }) {
  const host = useEditorHost();
  const p = useProject();
  const s = useSequence();
  const plan = useMemo(() => aiLabels(p, s.id), [p, s.id]);
  const t = aiLabelTemplate(p);
  const apply = () => {
    host.apply(plan.items.length ? "Add AI labels" : "Remove AI labels", (d) => { applyAiLabels(d, s.id, plan); });
    toast.success(plan.items.length ? `Added ${plural(plan.items.length, "AI label")}` : `Removed ${plural(plan.replaced.length, "label")}`);
    onClose();
  };
  if (!t) return <Empty text="The “AI-generated” label strap isn't in this build yet, so labels can't be placed." onClose={onClose} />;
  if (!plan.ranges.length && !plan.replaced.length) return <Empty text="No studio-made (AI) pictures are on screen in this sequence, so no labels are needed." onClose={onClose} />;
  const covered = plan.ranges.length && !plan.items.length;
  return (
    <div className="space-y-3">
      <p className="text-sm text-mute">
        While studio-made (AI) pictures are on screen, the “{t.name}” strap says so. Labels go on their own “AI label” track, so name straps aren't touched.
      </p>
      <div className="max-h-[46vh] overflow-y-auto rounded-lg border border-line p-1">
        {plan.items.map((r, i) => (
          <Row key={i} at={r.from} fps={s.fps}>
            <span className="flex items-center gap-2"><Bot className="size-3.5 shrink-0 text-accent-ink" />
              <span>AI-generated label until {toTimecode(r.to, s.fps)}</span><span className="text-2xs text-dim">{framesToSeconds(r.to - r.from, s.fps).toFixed(1)} s</span></span>
          </Row>
        ))}
        {covered ? <p className="px-2 py-3 text-sm text-dim">Labels placed by hand already cover every AI picture.</p> : null}
        {!plan.ranges.length && <p className="px-2 py-3 text-sm text-dim">No AI pictures are on screen any more.</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {!!plan.replaced.length && <span className="mr-auto text-2xs text-dim">Replaces the {plural(plan.replaced.length, "label")} added last time.</span>}
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!plan.items.length && !plan.replaced.length} onClick={apply}>
          {plan.items.length ? `Add ${plural(plan.items.length, "label")}` : `Remove ${plural(plan.replaced.length, "label")}`}
        </Button>
      </div>
    </div>
  );
}

function Empty({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-mute">{text}</p>
      <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={onClose}>Close</Button></div>
    </div>
  );
}
