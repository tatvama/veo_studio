/**
 * The EditorHost (docs/EDITOR.md §8): how the AI tools in editor/ai/** reach the editor. Reads come from the store;
 * every write is one undoable command.
 */
import { useMemo } from "react";
import { toast } from "sonner";
import { addMedia as addMediaItems } from "./actions";
import { defaultTitle } from "./model/defaults";
import { uid } from "./model/ids";
import { addGenerated, addTrack, clipsFromMedia, ctxOf, normalize, placeClips, targetTracks, tracksOf, updateSequence } from "./model/ops";
import type { EditorHost, EditProject, TimelineClip, TitleSpec } from "./model/types";
import { program } from "./playback/transport";
import { resolveUrls } from "./session";
import { ed, exec, project, replaceProject, seq } from "./store";

export type { EditorHost } from "./model/types";

export function makeHost(): EditorHost {
  return {
    project,
    sequence: seq,
    selection: () => {
      const ids = ed().selection;
      const s = seq();
      return { clipIds: [...ids], trackIds: [...new Set(s.clips.filter((c) => ids.includes(c.id)).map((c) => c.trackId))] };
    },
    playhead: () => program.frame,
    inOut: () => { const s = seq(); return { in: s.inPoint, out: s.outPoint }; },
    apply(label, mutate) {
      exec(label, (p) => {
        const draft = structuredClone(p) as EditProject;
        mutate(draft);
        const c = ctxOf(draft);
        return { ...draft, sequences: draft.sequences.map((s) => normalize(s, c)) };
      });
    },
    addMedia(items, binName) {
      let binId: string | null = null;
      if (binName) {
        const have = project().bins.find((b) => b.name === binName && !b.parentId);
        binId = have?.id ?? uid("b");
        if (!have) { const id = binId; exec(`New bin ${binName}`, (p) => ({ ...p, bins: [...p.bins, { id, name: binName, parentId: null }] })); }
      }
      const fresh = addMediaItems(items, binId);
      void resolveUrls(fresh);
    },
    placeClip(opts) {
      let clipId = "";
      const p0 = project();
      const m = p0.media.find((x) => x.id === opts.mediaId);
      if (!m) throw new Error(`No media ${opts.mediaId} in the project`);
      exec(opts.name ? `Place ${opts.name}` : "Place clip", (p) => updateSequence(p, p.activeSequenceId, (s, c) => {
        let sq = s;
        let tid = opts.trackId;
        if (opts.newTrack || (!tid && !targetTracks(sq)[opts.trackKind])) { const r = addTrack(sq, opts.trackKind); sq = r.seq; tid = r.trackId; }
        tid ??= targetTracks(sq)[opts.trackKind]!.id;
        const cs: TimelineClip[] = clipsFromMedia(sq, m, Math.max(0, Math.round(opts.at)), {
          videoTrackId: opts.trackKind === "video" ? tid : undefined, audioTrackId: opts.trackKind === "audio" ? tid : undefined,
          video: opts.trackKind === "video", audio: opts.trackKind === "audio", duration: opts.duration, name: opts.name,
        });
        if (!cs.length) return sq;
        clipId = cs[0].id;
        return placeClips(sq, c, cs, opts.mode ?? "overwrite");
      }));
      return clipId;
    },
    addTitleTrack(name, cues, style) {
      if (!cues.length) return;
      exec(`Add ${name}`, (p) => updateSequence(p, p.activeSequenceId, (s, c) => {
        const r = addTrack(s, "video");
        let sq = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name } : t)) };
        const base: TitleSpec = { ...defaultTitle(""), size: 64, box: [0.08, 0.78, 0.84, 0.16], animIn: "none", animOut: "none",
          background: { color: "#000000a6", padding: 14, radius: 8 }, shadow: undefined, ...style };
        for (const cue of cues) {
          const a = Math.max(0, Math.round(cue.start)), b = Math.max(a + 1, Math.round(cue.end));
          sq = addGenerated(sq, c, r.trackId, a, b - a, { type: "title", text: { ...base, text: cue.text } }, cue.text.slice(0, 40) || "Caption").seq;
        }
        return sq;
      }));
      void tracksOf;
    },
    path: () => ed().path ?? "",
    studioProjectId: () => project().studioProjectId ?? null,
    setStudioProjectId(id) { replaceProject({ ...project(), studioProjectId: id }); },
    toast(msg, kind) { if (kind === "error") toast.error(msg); else if (kind === "warn") toast.warning(msg); else if (kind === "ok") toast.success(msg); else toast.message(msg); },
  };
}

/** The EditorHost for the AI panel and the clip context menu (stable for the page's life). */
export function useEditorHost(): EditorHost {
  return useMemo(makeHost, []);
}
