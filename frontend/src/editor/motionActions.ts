/**
 * The editor-motion commands (docs/EDITOR.md §10): speed ramps and freeze frames, the magnetic timeline, compound
 * clips (nest with a name, open as a tab with breadcrumbs, un-nest), multicam (make from clips synced by sound, cut
 * angles while playing, flatten). Each is one named, undoable command on the store, like actions.ts.
 */
import { toast } from "sonner";
import { editorBridge } from "../lib/desktop";
import * as A from "./actions";
import { openDialog } from "./dialogs";
import { unnestClip } from "./model/compound";
import * as MC from "./model/multicam";
import * as O from "./model/ops";
import { hasRamp, RAMP_PRESETS, type RampPresetId } from "./model/remap";
import * as R from "./model/retime";
import { secondsToFrames } from "./model/time";
import type { TimelineClip } from "./model/types";
import { program } from "./playback/transport";
import { clearSelection, ctx, ed, exec, project, select, seq, seqExec, setTabs } from "./store";

const fr = (s: number) => secondsToFrames(s, seq().fps);
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };

// ── speed ramps and freeze frames ────────────────────────────────────────────

const FIT_KEY = "tatvam-editor:ramp-fit";
/** Whether a ramp keeps the clip's length (default) or all its frames (the clip grows or shrinks, rippling). */
export const rampFit = (): R.RampFit => (lsGet(FIT_KEY, "length") === "content" ? "content" : "length");
export const setRampFit = (f: R.RampFit) => lsSet(FIT_KEY, f);
const FREEZE_KEY = "tatvam-editor:freeze-seconds";
export const freezeSeconds = () => { const v = Number(lsGet(FREEZE_KEY, "2")); return Number.isFinite(v) && v > 0 ? v : 2; };
export const setFreezeSeconds = (s: number) => lsSet(FREEZE_KEY, String(s));

const retimable = (ids: string[]) => seq().clips.filter((c) => ids.includes(c.id) && c.source.type === "media").map((c) => c.id);

/** The export's sound mix (Tatvam Desktop) doesn't follow speed ramps yet: what to tell before an export. */
export function rampedSoundNote(): string | null {
  const s = seq();
  const n = s.clips.filter((c) => c.enabled && hasRamp(c) && c.source.type === "media" && (O.kindOf(s, c) === "audio" || (c.audio && !c.linkId))).length;
  return n ? `${n} speed-ramped sound clip${n === 1 ? "" : "s"}: the picture follows the ramp, but the export's sound mix plays ${n === 1 ? "it" : "them"} at the clip's base speed for now (the preview follows the ramp).` : null;
}

export function applyRamp(ids: string[], preset: RampPresetId, fit = rampFit()) {
  const ok = retimable(ids);
  if (!ok.length) { toast.message("Select a video or sound clip to ramp"); return; }
  const label = RAMP_PRESETS.find((p) => p.id === preset)?.label ?? "Speed ramp";
  const at = program.frame;
  seqExec(`Speed ramp: ${label}`, (s, c) => R.applyRampPreset(s, c, ok, preset, at, { fit, hold: fr(freezeSeconds()) }));
}
export function removeRamp(ids: string[], fit = rampFit()) {
  seqExec("Remove speed ramp", (s, c) => R.setRamp(s, c, ids, () => null, { fit }));
}
/** Turns time remapping on (a flat 100 % curve to put keyframes on). */
export function enableRamp(id: string) {
  seqExec("Time remapping", (s, c) => R.setRamp(s, c, [id], (x) => x.timeRemap ?? { value: 100 }));
}

/** The clip to freeze: the selected one under the playhead, else the top video clip there on the targeted tracks. */
function clipUnderPlayhead(kind: "video" | "audio" = "video"): TimelineClip | undefined {
  const s = seq(), f = program.frame;
  const sel = s.clips.filter((c) => ed().selection.includes(c.id) && c.start <= f && f < O.clipEnd(c) && O.kindOf(s, c) === kind);
  if (sel.length) return sel[0];
  const ts = O.tracksOf(s, kind).filter((t) => !t.locked).reverse();
  const tg = ts.filter((t) => t.targeted);
  for (const t of [...tg, ...ts]) { const c = O.clipAt(s, t.id, f); if (c && c.source.type === "media") return c; }
  return undefined;
}

export function insertFreezeAt(seconds = freezeSeconds()) {
  const c = clipUnderPlayhead();
  if (!c) { toast.message("Put the playhead over a video clip to freeze it"); return; }
  const f = program.frame, n = fr(seconds);
  seqExec("Insert frame hold", (s, cx) => R.insertFreeze(s, cx, c.id, f, n));
  select([c.id]);
}
export function holdFrameAt() {
  const c = clipUnderPlayhead();
  if (!c) { toast.message("Put the playhead over a video clip"); return; }
  const f = program.frame;
  seqExec("Frame hold", (s, cx) => R.holdFrame(s, cx, c.id, f));
}
export function freezeLast(id: string, seconds = freezeSeconds()) {
  seqExec("Hold last frame", (s, cx) => R.freezeLastFrame(s, cx, id, fr(seconds)));
}

// ── magnetic timeline ────────────────────────────────────────────────────────

export function toggleMagnetic() {
  const on = !seq().magnetic;
  exec(on ? "Magnetic timeline on" : "Magnetic timeline off", (p) => O.updateSequence(p, p.activeSequenceId, (s) => {
    if (on) return { ...s, magnetic: true };
    const x = { ...s, clips: s.clips.map((c) => { if (!c.connectedTo) return c; const y = { ...c }; delete y.connectedTo; delete y.connectOffset; return y; }) };
    delete x.magnetic;
    return x;
  }));
  toast.message(on ? "Magnetic timeline: V1 is the storyline (gaps close, clips above ride along)" : "Position mode: clips stay where you put them");
}

// ── compound clips ───────────────────────────────────────────────────────────

/** Nest (Ctrl+Shift+N) with a name. */
export function nestNamed() {
  const ids = ed().selection;
  if (!ids.length) { toast.message("Select clips to nest"); return; }
  const n = project().sequences.length;
  openDialog({ kind: "prompt", title: "Nest into a compound clip", label: "Name", value: `Compound ${String(n).padStart(2, "0")}`, ok: "Nest", onOk: (name) => {
    let made: string | null = null;
    exec("Nest", (p) => { const r = O.nestClips(p, p.activeSequenceId, ids, name || "Compound"); made = r.sequenceId; return r.project; });
    clearSelection();
    if (made) toast.success(`"${name}" made — double-click it to edit inside`);
  } });
}

export function unnest(id?: string) {
  const s = seq();
  const c = s.clips.find((x) => x.id === (id ?? ed().selection.find((y) => s.clips.find((z) => z.id === y)?.source.type === "nested")));
  if (!c || c.source.type !== "nested") { toast.message("Select a nested (compound) clip to break apart"); return; }
  let ids: string[] = [];
  exec("Un-nest", (p) => { const r = unnestClip(p, p.activeSequenceId, c.id); ids = r.clipIds; return r.project; });
  if (ids.length) select(ids, "set", { linked: false });
}

/** Opens a sequence as a timeline tab; from a nested clip, its parent goes on the breadcrumb trail. */
export function openTab(id: string, opts: { fromParent?: boolean } = {}) {
  const st = ed();
  const cur = project().activeSequenceId;
  const tabs = st.tabs.includes(id) ? st.tabs : [...st.tabs, id];
  let crumbs = st.crumbs;
  if (opts.fromParent) crumbs = [...st.crumbs.filter((x) => x !== id), cur];
  else if (st.crumbs.includes(id)) crumbs = st.crumbs.slice(0, st.crumbs.indexOf(id));
  else if (id !== cur) crumbs = [];
  setTabs(tabs.includes(cur) || cur === id ? tabs : [cur, ...tabs], crumbs);
  A.openSequence(id);
}
export function closeTab(id: string) {
  const st = ed();
  const tabs = st.tabs.filter((x) => x !== id);
  if (!tabs.length) return;
  setTabs(tabs, st.crumbs.filter((x) => x !== id));
  if (project().activeSequenceId === id) A.openSequence(tabs[tabs.length - 1]);
}

// ── multicam ─────────────────────────────────────────────────────────────────

export type SyncBy = "audio" | "in" | "timeline";

/** Makes a multicam clip from the selected clips (one per piece of media): synced by their sound (Tatvam Desktop's
 *  sync analysis), by their in points, or as they sit on the timeline; it replaces them. */
export async function createMulticam(by: SyncBy = "audio") {
  const s = seq(), cx = ctx();
  const sel = s.clips.filter((c) => ed().selection.includes(c.id) && c.source.type === "media");
  // one clip per media item (the picture half when there is one)
  const pick = new Map<string, TimelineClip>();
  for (const c of [...sel].sort((a, b) => (O.kindOf(s, a) === "video" ? -1 : 1) - (O.kindOf(s, b) === "video" ? -1 : 1) || a.start - b.start)) {
    const mid = (c.source as { mediaId: string }).mediaId;
    if (!pick.has(mid)) pick.set(mid, c);
  }
  const clips = [...pick.values()].sort((a, b) => O.trackById(s, a.trackId)!.index - O.trackById(s, b.trackId)!.index || a.start - b.start);
  if (clips.length < 2) { toast.message("Select two or more clips of different media (one per camera)"); return; }
  if (clips.length > 9) { toast.message("A multicam clip takes up to 9 angles"); return; }
  let offsets: number[] = by === "in" ? MC.offsetsFromInPoints(clips, s, cx) : MC.offsetsFromTimeline(clips, s, cx);
  let used: SyncBy = by;
  if (by === "audio") {
    const b = editorBridge(), path = ed().path;
    const ref = (clips[0].source as { mediaId: string }).mediaId;
    const t = toast.loading("Syncing the angles by their sound…");
    try {
      if (!b || !path) throw new Error("needs Tatvam Desktop");
      const analyze = b.analyze as unknown as (p: string, m: string, k: string, o: Record<string, unknown>) => Promise<{ offset?: number }>;
      offsets = [0];
      for (let i = 1; i < clips.length; i++) {
        const r = await analyze(path, (clips[i].source as { mediaId: string }).mediaId, "sync", { against: ref });
        if (typeof r?.offset !== "number" || !Number.isFinite(r.offset)) throw new Error("no offset came back");
        offsets.push(r.offset);
      }
      toast.dismiss(t);
    } catch (e) {
      toast.dismiss(t);
      offsets = MC.offsetsFromTimeline(clips, s, cx);
      used = "timeline";
      toast.message(`Synced by where the clips sit on the timeline (sound sync ${(e as Error).message || "failed"})`);
    }
  }
  const p = project();
  const name = `Multicam ${String(p.sequences.filter((x) => x.multicam).length + 1).padStart(2, "0")}`;
  const angles: MC.AngleSpec[] = clips.map((c, i) => ({ mediaId: (c.source as { mediaId: string }).mediaId, name: c.name, offset: offsets[i] }));
  const all = O.withLinked(s, sel.map((c) => c.id));
  const start = Math.min(...sel.map((c) => c.start)), end = Math.max(...sel.map(O.clipEnd));
  const ref = clips[0];
  const vt = O.kindOf(s, ref) === "video" ? ref.trackId : O.targetTracks(s).video?.id;
  const aHalf = s.clips.find((c) => c.linkId && c.linkId === ref.linkId && O.kindOf(s, c) === "audio");
  const at = aHalf?.trackId ?? O.targetTracks(s).audio?.id;
  let ids: string[] = [];
  exec("Make multicam clip", (pp) => {
    const r = MC.createMulticamSequence(pp, name, angles, seq(), used);
    const mc = r.project.sequences.find((x) => x.id === r.sequenceId)!;
    // the multicam sequence frame under the reference clip's first frame
    const refMid = (ref.source as { mediaId: string }).mediaId;
    const m = cx.media(refMid);
    const refAt = mc.clips.find((c) => c.source.type === "media" && c.source.mediaId === refMid);
    const inSeq = O.mediaToSeqFrames(m!, (ref.source as { in: number }).in, mc.fps);
    const win = Math.max(0, (refAt?.start ?? 0) + inSeq - (ref.start - start));
    // the clip covers what was selected, from that point of the multicam sequence
    const placed = MC.placeMulticam(r.project, pp.activeSequenceId, r.sequenceId, start, vt, at, all, { in: win, duration: end - start });
    ids = placed.clipIds;
    return placed.project;
  });
  if (ids.length) {
    select(ids);
    toast.success(`Multicam clip with ${clips.length} angles — show the angles in the Source monitor and press 1–${clips.length} while playing to cut`);
  }
}

/** The multicam clip under the playhead (selected first, else the top video track's). */
export function multicamUnderPlayhead(): TimelineClip | undefined {
  const s = seq(), f = program.frame;
  const here = s.clips.filter((c) => c.multicam && c.start <= f && f < O.clipEnd(c) && O.kindOf(s, c) === "video");
  return here.find((c) => ed().selection.includes(c.id)) ?? here.sort((a, b) => O.trackById(s, b.trackId)!.index - O.trackById(s, a.trackId)!.index)[0];
}

/** Cuts to angle `n` (0-based) at the playhead (1–9 keys); false when no multicam clip is there. */
export function cutToAngle(n: number, opts: { audio?: boolean } = {}): boolean {
  const c = multicamUnderPlayhead();
  if (!c) return false;
  if (n >= MC.angleCount(c, ctx())) return true;
  const f = program.frame;
  const track = opts.audio ? seq().clips.find((x) => x.linkId && x.linkId === c.linkId && O.kindOf(seq(), x) === "audio" && x.start <= f && f < O.clipEnd(x))?.trackId : c.trackId;
  if (!track) return true;
  seqExec(opts.audio ? `Sound to angle ${n + 1}` : `Cut to angle ${n + 1}`, (s, cx) => MC.switchAngle(s, cx, track, f, n, opts));
  return true;
}

export function flattenMulticam(ids?: string[]) {
  const s = seq();
  const list = ids ?? s.clips.filter((c) => c.multicam).map((c) => c.id);
  if (!s.clips.some((c) => c.multicam && list.includes(c.id))) { toast.message("No multicam clips to flatten"); return; }
  exec("Flatten multicam", (p) => MC.flattenMulticam(p, p.activeSequenceId, O.withLinked(seq(), list)));
}
