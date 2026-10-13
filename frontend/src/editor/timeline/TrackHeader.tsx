/**
 * A track header: target (the Vn / An pill), lock, sync lock, output (eye / speaker), mute and solo, the name
 * (double-click to rename), and the bottom edge to drag its height. Right-click for add / delete.
 */
import { clsx } from "clsx";
import { Eye, EyeOff, Link2, Link2Off, Lock, LockOpen, Volume2, VolumeX } from "lucide-react";
import { memo, useState } from "react";
import * as A from "../actions";
import { MAX_TRACK_H, MIN_TRACK_H, TRACK_H } from "../model/defaults";
import type { Track } from "../model/types";
import { gesture, seq } from "../store";
import { openMenu } from "../ui";
import { updateTrack as opUpdateTrack } from "../model/ops";
import { updateSequence } from "../model/ops";

function TrackHeaderImpl({ track: t, width, clips }: { track: Track; width: number; clips: number }) {
  const [rename, setRename] = useState<string | null>(null);
  const video = t.kind === "video";
  const up = (patch: Partial<Track>, label: string) => A.updateTrack(t.id, patch, label);
  const small = t.height < 40;
  return (
    <div className="tl-head relative" style={{ width, height: t.height }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, [
          { label: "Rename…", onClick: () => setRename(t.name) },
          { label: `Add ${video ? "video" : "audio"} track above`, separator: true, onClick: () => A.addTrack(t.kind, video ? t.index + 1 : t.index) },
          { label: `Add ${video ? "video" : "audio"} track below`, onClick: () => A.addTrack(t.kind, video ? t.index : t.index + 1) },
          { label: "Delete track", danger: true, onClick: () => A.removeTrack(t.id), hint: clips ? `${clips} clips` : undefined },
          { label: "Height", separator: true, items: [
            { label: "Small", onClick: () => up({ height: 32 }, "Track height") }, { label: "Medium", onClick: () => up({ height: TRACK_H[t.kind] }, "Track height") },
            { label: "Large", onClick: () => up({ height: video ? 110 : 90 }, "Track height") },
          ] },
        ]);
      }}>
      <button type="button" className={clsx("tl-target ml-1", t.targeted && "on")} title={`${t.targeted ? "Targeted" : "Not targeted"}: edits from the Source monitor and Add Edit go here`}
        onClick={(e) => {
          if (e.shiftKey || e.ctrlKey) { up({ targeted: !t.targeted }, "Target track"); return; }
          // a click targets this track and un-targets the others of its kind (Premiere's source patching)
          A.updateTrack(t.id, { targeted: true }, "Target track");
          for (const o of seq().tracks) if (o.kind === t.kind && o.id !== t.id && o.targeted) A.updateTrack(o.id, { targeted: false }, "Target track");
        }}>
        {video ? "V" : "A"}{t.index + 1}
      </button>
      <div className={clsx("flex min-w-0 flex-1", small ? "flex-row items-center gap-0.5" : "flex-col gap-0.5")}>
        <div className="flex items-center gap-0.5">
          <button type="button" className={clsx("tl-tbtn lock", t.locked && "on")} title={t.locked ? "Unlock track" : "Lock track"} onClick={() => up({ locked: !t.locked }, t.locked ? "Unlock track" : "Lock track")}>
            {t.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
          </button>
          <button type="button" className={clsx("tl-tbtn", t.syncLock && "on")} title={t.syncLock ? "Sync lock on: inserts and ripples move this track" : "Sync lock off"} onClick={() => up({ syncLock: !t.syncLock }, "Sync lock")}>
            {t.syncLock ? <Link2 className="size-3" /> : <Link2Off className="size-3" />}
          </button>
          {video ? (
            <button type="button" className={clsx("tl-tbtn", !t.hidden && "on")} title={t.hidden ? "Show track output" : "Hide track output"} onClick={() => up({ hidden: !t.hidden }, "Toggle track output")}>
              {t.hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            </button>
          ) : (
            <>
              <button type="button" className={clsx("tl-tbtn mute text-[10px] font-bold", t.muted && "on")} title="Mute" onClick={() => up({ muted: !t.muted }, "Mute track")}>M</button>
              <button type="button" className={clsx("tl-tbtn solo text-[10px] font-bold", t.solo && "on")} title="Solo" onClick={() => up({ solo: !t.solo }, "Solo track")}>S</button>
              <span className="tl-tbtn" title={t.muted ? "Muted" : `${t.volume.toFixed(1)} dB`}>{t.muted ? <VolumeX className="size-3 text-warn" /> : <Volume2 className="size-3" />}</span>
            </>
          )}
        </div>
        {rename !== null ? (
          <input autoFocus value={rename} onChange={(e) => setRename(e.target.value)} onBlur={() => { if (rename.trim()) up({ name: rename.trim() }, "Rename track"); setRename(null); }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRename(null); }}
            className="ed-field h-5 w-full text-2xs" />
        ) : (
          <span className={clsx("min-h-3 truncate px-0.5 text-2xs", small && "ml-1", t.name === `${video ? "V" : "A"}${t.index + 1}` ? "text-dim" : "text-mute")}
            onDoubleClick={() => setRename(t.name)} title={`${t.name} — double-click to rename`}>{t.name === `${video ? "V" : "A"}${t.index + 1}` ? (video ? "Video" : "Audio") : t.name}</span>
        )}
      </div>
      <div className="tl-resize" title="Drag to change the height"
        onPointerDown={(e) => {
          e.preventDefault(); e.stopPropagation();
          const y0 = e.clientY, h0 = t.height;
          gesture.begin("Track height");
          const move = (ev: PointerEvent) => {
            const h = Math.max(MIN_TRACK_H, Math.min(MAX_TRACK_H, Math.round(h0 + ev.clientY - y0)));
            gesture.preview((p) => updateSequence(p, p.activeSequenceId, (s) => opUpdateTrack(s, t.id, { height: h })));
          };
          const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); gesture.commit(); };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", end);
        }} />
    </div>
  );
}

export const TrackHeader = memo(TrackHeaderImpl);
