/** The Markers list, the History (click a step to go back to it) and Info panels. */
import { clsx } from "clsx";
import { Bookmark, History as HistoryIcon, Trash2 } from "lucide-react";
import { useMemo } from "react";
import * as A from "../actions";
import { openDialog } from "../dialogs";
import { ctxOf, handles, kindOf, markedRange, seqEnd, sourceFrameAt, trackById } from "../model/ops";
import { fpsLabel, shortDuration, toTimecode } from "../model/time";
import { program, useFrame } from "../playback/transport";
import { jumpHistory, selectMarker, setFocus, useEditor, useProject, useSequence } from "../store";
import { IBtn } from "../ui";

export function MarkersPanel() {
  const s = useSequence();
  const selM = useEditor((x) => x.selMarker);
  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar">
        <span className="flex-1 text-2xs text-dim">{s.markers.length} marker{s.markers.length === 1 ? "" : "s"} in {s.name}</span>
        <IBtn title="Add marker at the playhead" shortcut="M" onClick={() => A.addSeqMarker()}><Bookmark className="size-3.5" /></IBtn>
      </div>
      <div className="pn-scroll">
        {s.markers.map((m) => (
          <div key={m.id} className={clsx("pn-row group cursor-pointer", selM === m.id && "sel")} onClick={() => { selectMarker(m.id); program.seek(m.frame); }} onDoubleClick={() => openDialog({ kind: "marker", id: m.id })}>
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: m.color }} />
            <span className="mono w-[5.5rem] shrink-0 text-2xs text-accent-ink">{toTimecode(m.frame, s.fps)}</span>
            <span className="min-w-0 flex-1 truncate">{m.name || <span className="text-dim">Marker</span>}{m.comment && <span className="ml-2 text-dim">{m.comment}</span>}</span>
            {m.duration > 0 && <span className="mono text-2xs text-dim">{shortDuration(m.duration, s.fps)}</span>}
            <button type="button" aria-label="Delete marker" className="text-dim opacity-0 hover:text-red-300 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); A.removeSeqMarker(m.id); }}><Trash2 className="size-3" /></button>
          </div>
        ))}
        {!s.markers.length && <div className="pn-empty">Press M to add a marker at the playhead.</div>}
      </div>
    </div>
  );
}

export function HistoryPanel() {
  const h = useEditor((x) => x.h);
  const steps = [...h.past.map((e, i) => ({ label: e.label, at: e.at, i, done: true })), ...h.future.map((e, k) => ({ label: e.label, at: e.at, i: h.past.length + k, done: false }))];
  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar"><HistoryIcon className="size-3.5 text-dim" /><span className="flex-1 text-2xs text-dim">{h.past.length} step{h.past.length === 1 ? "" : "s"}{h.future.length ? ` · ${h.future.length} to redo` : ""} · up to 500</span></div>
      <div className="pn-scroll">
        <div className={clsx("pn-row cursor-pointer", !h.past.length && "sel")} onClick={() => jumpHistory(-1)}><span className="text-mute">Opened</span></div>
        {steps.map((st) => (
          <div key={st.i} className={clsx("pn-row cursor-pointer", st.i === h.past.length - 1 && "sel", !st.done && "opacity-45")} onClick={() => jumpHistory(st.i)}>
            <span className="mono w-6 shrink-0 text-right text-2xs text-dim">{st.i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{st.label}</span>
            <span className="mono text-[10px] text-dim">{new Date(st.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function InfoPanel() {
  const p = useProject();
  const s = useSequence();
  const sel = useEditor((x) => x.selection);
  const f = useFrame(program);
  const ctx = useMemo(() => ctxOf(p), [p]);
  const c = s.clips.find((x) => x.id === sel[0]);
  const m = c?.source.type === "media" ? p.media.find((x) => x.id === (c.source as { mediaId: string }).mediaId) : undefined;
  const range = markedRange(s);
  const row = (k: string, v: React.ReactNode) => <><span className="text-dim">{k}</span><span className="mono truncate">{v}</span></>;
  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="pn-scroll">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-3 text-2xs">
          <span className="eyebrow col-span-2">Sequence</span>
          {row("Name", s.name)}
          {row("Format", `${s.width}×${s.height} · ${fpsLabel(s.fps)} · 48 kHz`)}
          {row("Playhead", toTimecode(f, s.fps))}
          {row("Length", toTimecode(seqEnd(s), s.fps))}
          {range && row("In → out", `${toTimecode(range[0], s.fps)} → ${toTimecode(range[1] - 1, s.fps)} (${shortDuration(range[1] - range[0], s.fps)})`)}
          {row("Clips", `${s.clips.length} on ${s.tracks.length} tracks · ${s.transitions.length} transitions`)}
          {c && (
            <>
              <span className="eyebrow col-span-2 mt-2">{sel.length > 1 ? `Clip (${sel.length} selected)` : "Clip"}</span>
              {row("Name", c.name)}
              {row("Track", `${trackById(s, c.trackId)?.name} (${kindOf(s, c)})`)}
              {row("Start", toTimecode(c.start, s.fps))}
              {row("End", toTimecode(c.start + c.duration, s.fps))}
              {row("Duration", toTimecode(c.duration, s.fps))}
              {row("Speed", `${Math.round(c.speed * 1000) / 10}%${c.reverse ? " reversed" : ""}`)}
              {c.source.type === "media" && row("Source in", `${Math.round(c.source.in)} (${m ? fpsLabel(m.fps) : ""})`)}
              {c.source.type === "media" && f >= c.start && f < c.start + c.duration && row("Source here", Math.round(sourceFrameAt(c, s, ctx, f)))}
              {(() => { const hh = handles(c, s, ctx); return row("Handles", `${Number.isFinite(hh.head) ? hh.head : "∞"} / ${Number.isFinite(hh.tail) ? hh.tail : "∞"} frames`); })()}
              {c.effects.length > 0 && row("Effects", c.effects.map((e) => e.type).join(", "))}
              {m && row("File", m.path)}
            </>
          )}
          <span className="eyebrow col-span-2 mt-2">Edit</span>
          {row("Name", p.name)}
          {row("Media", `${p.media.length} items in ${p.bins.length} bins`)}
          {row("Sequences", p.sequences.length)}
        </div>
      </div>
    </div>
  );
}
