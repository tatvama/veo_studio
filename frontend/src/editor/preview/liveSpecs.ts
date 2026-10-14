/**
 * Live previews of the Effects and Templates panels' items (preview-polish, live.ts): the same operations their
 * apply runs (model/ops, templates/sequences), on a copy of the edit — an effect on the selected clips (else the
 * clip under the playhead), a transition at the selection's edges or the cut nearest the playhead, a title or a
 * template at the playhead — and the range of the sequence the monitor loops over while it shows.
 */
import { addEffect, addGenerated, addTrack, applyDefaultTransition, clipEnd, ctxOf, kindOf, tracksOf, transitionRange } from "../model/ops";
import { secondsToFrames } from "../model/time";
import type { EditProject, EffectInstance, Sequence, TitleSpec } from "../model/types";
import { program } from "../playback/transport";
import { ed } from "../store";
import { insertTemplate, type SeqTemplate } from "../templates/sequences";
import type { LiveSpec } from "./live";
import { pickUserClip } from "./samples";

const active = (d: EditProject) => d.sequences.findIndex((x) => x.id === d.activeSequenceId);

/** The selected clips of a kind, else the user's clip under the playhead. */
function targets(s: Sequence, kind: "video" | "audio"): string[] {
  const sel = ed().selection;
  const ids = s.clips.filter((c) => sel.includes(c.id) && kindOf(s, c) === kind).map((c) => c.id);
  if (ids.length || kind !== "video") return ids;
  const u = pickUserClip(s, [], program.frame);
  return u ? [u.id] : [];
}

export function effectLive(id: string, label: string, make: () => EffectInstance): LiveSpec {
  return {
    key: `fx:${id}`, label, hint: "Double-click or drag to apply",
    mutate: (d) => { const i = active(d); if (i < 0) return; const s = d.sequences[i]; d.sequences[i] = addEffect(s, ctxOf(d), targets(s, "video"), make); },
  };
}

export function transitionLive(id: string, label: string): LiveSpec {
  return {
    key: `tr:${id}`, label, hint: "Double-click or drag onto a cut to apply",
    mutate: (d) => {
      const i = active(d); if (i < 0) return;
      const s = d.sequences[i];
      d.sequences[i] = applyDefaultTransition(s, ctxOf(d), "video", id, secondsToFrames(1, s.fps), program.frame, ed().selection);
    },
    // the new transition nearest the playhead, with a few frames either side
    span: (before, after) => {
      const b = before.sequences.find((x) => x.id === before.activeSequenceId), a = after.sequences.find((x) => x.id === after.activeSequenceId);
      if (!a) return null;
      const old = new Set((b?.transitions ?? []).map((t) => `${t.trackId}@${t.at}:${t.type}`));
      const fresh = a.transitions.filter((t) => !old.has(`${t.trackId}@${t.at}:${t.type}`) && !t.type.startsWith("audio:"));
      if (!fresh.length) return null;
      const f = program.frame;
      const t = fresh.sort((x, y) => Math.abs(x.at - f) - Math.abs(y.at - f))[0];
      const [x0, x1] = transitionRange(t);
      const pad = Math.round(a.fps * 0.3);
      return [Math.max(0, x0 - pad), x1 + pad];
    },
  };
}

/** The topmost unlocked video track free over [at, at + len) (Templates' placeTitles). */
function freeTrack(s: Sequence, at: number, len: number): string | null {
  for (const t of [...tracksOf(s, "video")].reverse()) {
    if (t.locked) continue;
    if (!s.clips.some((c) => c.trackId === t.id && c.start < at + len && clipEnd(c) > at)) return t.id;
  }
  return null;
}

/** Titles (or stickers) placed at the playhead, as the Templates panel places them. */
export function titleLive(key: string, label: string, items: { spec: TitleSpec; seconds: number; name: string }[], hint = "Click to add at the playhead"): LiveSpec {
  return {
    key, label, hint,
    mutate: (d) => {
      const i = active(d); if (i < 0) return;
      let s = d.sequences[i];
      const at = program.frame, ctx = ctxOf(d);
      for (const it of items) {
        const len = Math.max(1, secondsToFrames(it.seconds, s.fps));
        let tid = freeTrack(s, at, len);
        if (!tid) { const r = addTrack(s, "video"); s = r.seq; tid = r.trackId; }
        s = addGenerated(s, ctx, tid, at, len, { type: "title", text: it.spec }, it.name).seq;
      }
      d.sequences[i] = s;
    },
    span: (_b, a) => {
      const s = a.sequences.find((x) => x.id === a.activeSequenceId);
      const len = Math.max(...items.map((it) => secondsToFrames(it.seconds, s?.fps ?? 25)));
      return [program.frame, program.frame + len];
    },
  };
}

/** A template sequence inserted (flattened) at the playhead. */
export function templateLive(t: SeqTemplate, fields: Record<string, string>): LiveSpec {
  return {
    key: `seq:${t.id}:${JSON.stringify(fields)}`, label: t.name, hint: "Insert it below to keep it",
    mutate: (d) => { const r = insertTemplate(d, d.activeSequenceId, t, program.frame, "flatten", fields); d.sequences = r.project.sequences; },
    span: (_b, a) => { const s = a.sequences.find((x) => x.id === a.activeSequenceId); return [program.frame, program.frame + secondsToFrames(t.seconds, s?.fps ?? 25)]; },
  };
}
