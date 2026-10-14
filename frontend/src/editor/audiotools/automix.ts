/**
 * Auto mix (docs/EDITOR.md §15.4): every audio clip's integrated loudness (measured over the clip's own range) is
 * brought to its role's target by its clip gain:
 *  - dialogue at the platform target (the export's loudness preset: −14 LUFS for YouTube by default),
 *  - music 10 LU under the dialogue, SFX 6 LU under, ambience 14 LU under,
 * counting the track's volume, capped at ±12 dB. The role is the clip's tag, else its track's, else a guess from the
 * track name. Room tone follows its dialogue. Music and ambience then duck under the dialogue in the export (the
 * roles are written on the clips, so the export's sidechain ducking finds them). The plan is a dry run (a table of
 * role, clip, before and after); applying it is one undo step. Pure.
 */
import { guessRole } from "../audiofx/essential.ts";
import { updateClips, type Ctx } from "../model/ops.ts";
import type { AudioRole, Sequence, TimelineClip } from "../model/types.ts";

/** The export's loudness presets (desktop editor-audio.ts LOUDNESS). */
export const LOUDNESS_TARGETS: { id: string; label: string; lufs: number }[] = [
  { id: "youtube", label: "YouTube (−14 LUFS)", lufs: -14 },
  { id: "instagram", label: "Instagram / Reels (−14 LUFS)", lufs: -14 },
  { id: "spotify", label: "Spotify (−14 LUFS)", lufs: -14 },
  { id: "apple", label: "Apple Music / Podcasts (−16 LUFS)", lufs: -16 },
  { id: "ebu_r128", label: "Broadcast EBU R128 (−23 LUFS)", lufs: -23 },
  { id: "ott", label: "OTT / streaming (−24 LUFS)", lufs: -24 },
];
/** LU under the dialogue target, per role. */
export const ROLE_OFFSETS: Record<AudioRole, number> = { dialogue: 0, music: -10, sfx: -6, ambience: -14 };
export const AUTO_MIX_CAP = 12;
/** A clip quieter than this (LUFS) counts as unmeasured (silence). */
export const UNMEASURABLE = -69;

export const ROLE_LABELS: Record<AudioRole, string> = { dialogue: "Dialogue", music: "Music", sfx: "SFX", ambience: "Ambience" };

/** A clip's role: its tag, else its track's, else the track name's guess. */
export function roleOf(seq: Sequence, c: TimelineClip): AudioRole | undefined {
  const t = seq.tracks.find((x) => x.id === c.trackId);
  return c.role ?? t?.role ?? guessRole(t?.name);
}

/** The clips auto mix measures: enabled media clips on audio tracks (room tone follows its dialogue instead). */
export function autoMixClips(seq: Sequence, ids?: Iterable<string>): TimelineClip[] {
  const only = ids ? new Set(ids) : null;
  const audio = new Set(seq.tracks.filter((t) => t.kind === "audio").map((t) => t.id));
  return seq.clips.filter((c) => audio.has(c.trackId) && c.enabled && c.source.type === "media" && !c.roomTone && (!only || only.has(c.id)));
}

/** The clip's level as auto mix sees it: its first keyframe when keyframed, else its value. */
export const clipLevel = (c: TimelineClip) => (c.audio?.gain.keyframes?.length ? c.audio.gain.keyframes[0].value : c.audio?.gain.value ?? 0);

export interface AutoMixRow {
  clipId: string; name: string; role: AudioRole; trackId: string;
  /** LUFS of the clip's source range (before its gain); null for room tone. */
  measured: number | null;
  /** Clip gain (dB) now and after. */
  before: number; after: number;
  /** The role's target (LUFS) and where the clip lands (measured + gain + track volume). */
  target: number; result: number | null;
  capped: boolean; note?: string;
}
export interface AutoMixPlan {
  target: number; rows: AutoMixRow[];
  skipped: { clipId: string; name: string; reason: string }[];
  /** Music or ambience will duck under the dialogue in the export. */
  ducking: boolean;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** The dry run: what each clip's gain becomes. `measured` = LUFS by clip id (null or missing: couldn't be measured). */
export function planAutoMix(seq: Sequence, measured: Record<string, number | null | undefined>, opts: {
  target: number; cap?: number; offsets?: Partial<Record<AudioRole, number>>; ids?: Iterable<string>;
}): AutoMixPlan {
  const cap = opts.cap ?? AUTO_MIX_CAP;
  const off = { ...ROLE_OFFSETS, ...(opts.offsets ?? {}) };
  const rows: AutoMixRow[] = [];
  const skipped: AutoMixPlan["skipped"] = [];
  const vol = new Map(seq.tracks.map((t) => [t.id, t.volume]));
  for (const c of autoMixClips(seq, opts.ids)) {
    const role = roleOf(seq, c);
    if (!role) { skipped.push({ clipId: c.id, name: c.name, reason: "No role: tag it in Essential Sound or name its track" }); continue; }
    const m = measured[c.id];
    if (m === null || m === undefined || !Number.isFinite(m) || m <= UNMEASURABLE) { skipped.push({ clipId: c.id, name: c.name, reason: "Couldn't be measured (silent or too short)" }); continue; }
    const target = opts.target + off[role];
    const want = target - m - (vol.get(c.trackId) ?? 0);
    const after = r1(Math.max(-cap, Math.min(cap, want)));
    rows.push({ clipId: c.id, name: c.name, role, trackId: c.trackId, measured: r1(m), before: r1(clipLevel(c)), after, target,
      result: r1(m + after + (vol.get(c.trackId) ?? 0)), capped: Math.abs(want) > cap + 0.05 });
  }
  // room tone keeps the level of the dialogue it was taken from
  for (const c of seq.clips.filter((x) => x.roomTone && x.enabled && x.source.type === "media")) {
    const mid = (c.source as { mediaId: string }).mediaId;
    const d = rows.find((r) => r.role === "dialogue" && seq.clips.find((x) => x.id === r.clipId && x.source.type === "media" && x.source.mediaId === mid));
    if (!d) continue;
    rows.push({ clipId: c.id, name: c.name, role: roleOf(seq, c) ?? "dialogue", trackId: c.trackId, measured: null, before: r1(clipLevel(c)), after: d.after,
      target: d.target, result: null, capped: d.capped, note: "Room tone: follows its dialogue" });
  }
  const roles = new Set(rows.map((r) => r.role));
  return { target: opts.target, rows, skipped, ducking: roles.has("dialogue") && (roles.has("music") || roles.has("ambience")) };
}

/** Sets the gains of a plan (keyframed levels move together, keeping their shape) and writes each clip's role on it. */
export function applyAutoMix(seq: Sequence, ctx: Ctx, plan: AutoMixPlan): Sequence {
  const by = new Map(plan.rows.map((r) => [r.clipId, r]));
  return updateClips(seq, ctx, [...by.keys()], (c) => {
    const r = by.get(c.id)!;
    if (!c.audio) return c;
    const ks = c.audio.gain.keyframes;
    const d = r.after - clipLevel(c);
    const gain = ks?.length ? { ...c.audio.gain, value: r1(c.audio.gain.value + d), keyframes: ks.map((k) => ({ ...k, value: r1(k.value + d) })) } : { ...c.audio.gain, value: r.after };
    const x: TimelineClip = { ...c, audio: { ...c.audio, gain } };
    if (!c.role && !c.roomTone) x.role = r.role;
    return x;
  });
}
