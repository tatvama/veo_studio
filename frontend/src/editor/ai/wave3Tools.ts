/**
 * The wave 3 AI tools as calls the AI panel uses (docs/EDITOR.md §10): B-roll ideas and highlights from the transcript,
 * thumbnails from the frame at the playhead, a cloned voice (only with a consent record), a mood per scene, backups of
 * the edit on the studio and timeline review comments. Paid runs go through runFlow (price first, the studio's jobs,
 * budgets and approvals); everything reaches the edit through the EditorHost.
 */
import { api, ApiError } from "../../lib/api";
import { ctxOf } from "../model/ops";
import { secondsToFrames } from "../model/time";
import { ensureKey, ensureStudioProject, importOutput, runFlow } from "./api";
import { bridgeMessage, deviceName, versionsBridge, type LocalVersion } from "./bridge";
import { soundParts } from "./commands";
import type { EditorHost, EditProject, MediaItem, Sequence } from "./host-types";
import { askChoice } from "./store";
import { pictureAtPlayhead } from "./tools";
import type { Backup, BrollIdea, ClonedVoice, ConsentRow, EditComment, EpisodeScene, Highlight, MoodPick, Platform, Segment } from "./types";
import { backupDoc, moodMarkers, restoredProject, shortsFrom, type SceneRange } from "./wave3";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : bridgeMessage(e));

// ── B-roll ideas and highlights (from the transcript) ────────────────────────

export async function brollIdeas(host: EditorHost, segments: Segment[], opts: { style?: string; count?: number } = {}): Promise<BrollIdea[] | null> {
  if (!segments.length) { host.toast("Make captions first: the ideas follow what is said", "warn"); return null; }
  const jobs = await runFlow(host, {
    title: "B-roll ideas",
    prepare: async () => [{ tool: "broll_suggest", params: { segments: segments.slice(0, 3000), style: opts.style ?? "", count: opts.count ?? 6 } }],
    apply: () => undefined,
  });
  return jobs?.[0]?.result.ideas ?? null;
}

export async function findHighlights(host: EditorHost, segments: Segment[], opts: { targetSeconds: number; count: number; platform: Platform }): Promise<Highlight[] | null> {
  if (!segments.length) { host.toast("Make captions first: highlights are picked from what is said", "warn"); return null; }
  const jobs = await runFlow(host, {
    title: "Highlights",
    prepare: async () => [{ tool: "highlights", params: { segments: segments.slice(0, 3000), target_seconds: opts.targetSeconds, count: opts.count, platform: opts.platform } }],
    apply: () => undefined,
  });
  return jobs?.[0]?.result.highlights ?? null;
}

/** The picked highlights as new vertical sequences (one undo step). → how many. */
export function makeShorts(host: EditorHost, picks: Highlight[]): number {
  const seqs = shortsFrom(host.project(), host.sequence(), picks);
  if (!seqs.length) return 0;
  host.apply(`Highlights: ${seqs.length} Short${seqs.length === 1 ? "" : "s"}`, (d) => { d.sequences.push(...seqs); });
  return seqs.length;
}

/** A media item from the bin at a B-roll idea's time, on a free track above the main picture. */
export function placeIdea(host: EditorHost, item: MediaItem, idea: BrollIdea): string {
  const seq = host.sequence();
  const at = secondsToFrames(idea.start, seq.fps), len = Math.max(1, secondsToFrames(idea.end - idea.start, seq.fps));
  const free = seq.tracks.filter((t) => t.kind === "video" && !t.locked && t.index >= 1 && !/^captions\b/i.test(t.name))
    .sort((a, b) => a.index - b.index).find((t) => !seq.clips.some((c) => c.trackId === t.id && c.start < at + len && at < c.start + c.duration));
  return host.placeClip({ mediaId: item.id, trackKind: "video", at, trackId: free?.id, newTrack: !free, name: item.name, duration: len, mode: "overwrite" });
}

// ── thumbnails ───────────────────────────────────────────────────────────────

export async function thumbnails(host: EditorHost, opts: { title: string; style: string; count: number; aspects: ("16:9" | "9:16")[] }): Promise<MediaItem[]> {
  const pic = pictureAtPlayhead(host);
  if (!pic) { host.toast("Put the playhead over a picture first", "warn"); return []; }
  const made: MediaItem[] = [];
  await runFlow(host, {
    title: "Thumbnails",
    note: "Made from the frame at the playhead through the team's image engines (Google first). They go into the Thumbnails bin.",
    prepare: async (say, fresh) => {
      say(`Sending ${pic.part.name}`);
      const key = await ensureKey(host, pic.part.mediaId, { fresh });
      const m = host.project().media.find((x) => x.id === pic.part.mediaId);
      return [{ tool: "thumbnail", what: pic.part.name, params: {
        ...(m?.kind === "image" ? { frame_key: key } : { key, at: pic.at }), title: opts.title, style: opts.style, count: opts.count, aspects: opts.aspects } }];
    },
    apply: async (js) => {
      for (const o of js[0].result.outputs) made.push(await importOutput(host, o, "Thumbnails"));
      host.toast(`${made.length} thumbnail${made.length === 1 ? "" : "s"} in the Thumbnails bin`, "ok");
    },
  });
  return made;
}

// ── a cloned voice (only with the speaker's consent) ─────────────────────────

/** The valid voice-replication consents (producers see them; others get `forbidden`). */
export async function voiceConsents(): Promise<{ rows: ConsentRow[]; forbidden: boolean }> {
  try {
    const rows = await api.get<ConsentRow[]>("/api/consents", { silent: true });
    const today = new Date().toISOString().slice(0, 10);
    return { rows: rows.filter((r) => r.kind === "voice_replication" && (!r.expires_on || r.expires_on >= today)), forbidden: false };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 401)) return { rows: [], forbidden: true };
    throw e;
  }
}

export async function cloneVoice(host: EditorHost, clipId: string, opts: { name: string; consentId: number; languages?: string[] }): Promise<ClonedVoice | null> {
  let voice: ClonedVoice | null = null;
  await runFlow(host, {
    title: `Clone a voice: ${opts.name}`,
    note: "The voice is cloned on ElevenLabs under the speaker's consent record, and becomes a studio voice for voice-over and dubbing.",
    prepare: async (say, fresh) => {
      const part = soundParts(host.project(), host.sequence(), { clipIds: [clipId] })[0];
      if (!part) throw new Error("Pick a clip with the speaker's voice");
      say(`Sending ${part.name}`);
      return [{ tool: "voice_clone", what: opts.name, params: { sample_key: await ensureKey(host, part.mediaId, { fresh }), start: part.srcStart, end: part.srcEnd,
        name: opts.name, consent_id: opts.consentId, languages: opts.languages ?? [] } }];
    },
    apply: (js) => {
      voice = (js[0].result.voice as ClonedVoice) ?? null;
      host.toast(`Voice “${opts.name}” is ready: pick it under Studio voices in AI voice-over or Dub`, "ok");
    },
  });
  return voice;
}

// ── a mood per scene ─────────────────────────────────────────────────────────

export const episodeScenes = (pid: number, eid: number) =>
  api.get<{ episode_id: number; title: string; scenes: EpisodeScene[] }>(`/api/edits/${pid}/episode-scenes?episode_id=${eid}`, { silent: true });

export async function suggestMoods(host: EditorHost, scenes: SceneRange[], moods: (string | { id: string; label: string; words: string[] })[]): Promise<MoodPick[] | null> {
  if (!scenes.length) { host.toast("No scenes: add markers where scenes start, or put clips on V1", "warn"); return null; }
  const jobs = await runFlow(host, {
    title: "Mood per scene",
    prepare: async () => [{ tool: "mood_suggest", params: { scenes: scenes.slice(0, 200).map((s) => ({ id: s.id, title: s.title, emotion: s.emotion, summary: s.summary })),
      moods: moods.slice(0, 100) } }],
    apply: () => undefined,
  });
  return jobs?.[0]?.result.moods ?? null;
}

/**
 * The picked moods as looks on each scene's clips, through editor-looks' applyMood (editor/moods/apply.ts: the mood's
 * effect chain on the clips in the scene's range), in one undo step. → how many scenes got one.
 */
export function applyMoodLooks(host: EditorHost, scenes: SceneRange[], picks: MoodPick[],
  apply: (...a: unknown[]) => { seq: unknown }, byId: (id: string) => unknown): number {
  const sid = host.sequence().id;
  let n = 0;
  host.apply(`Moods on ${picks.length} scene${picks.length === 1 ? "" : "s"}`, (d) => {
    const i = d.sequences.findIndex((x) => x.id === sid);
    if (i < 0) return;
    let s = d.sequences[i];
    const ctx = ctxOf(d);
    for (const pick of picks) {
      const def = byId(pick.mood), sc = scenes.find((x) => x.id === pick.scene_id);
      if (!def || !sc) continue;
      s = apply(s, ctx, def, { kind: "range", from: sc.start, to: sc.end }, { intensity: 1 }).seq as Sequence;
      n++;
    }
    d.sequences[i] = s;
  });
  return n;
}

export function addMoodMarkers(host: EditorHost, scenes: SceneRange[], picks: MoodPick[]): void {
  const sid = host.sequence().id;
  const next = moodMarkers(host.project(), sid, scenes, picks);
  const s = next.sequences.find((x) => x.id === sid);
  if (s) host.apply(`${picks.length} mood marker${picks.length === 1 ? "" : "s"}`, (d) => { const x = d.sequences.find((y) => y.id === sid); if (x) x.markers = s.markers; });
}

// ── backups ──────────────────────────────────────────────────────────────────

/** Backs the edit up on the studio (and on this PC when the desktop can). Null when it failed (already shown). */
export async function backupNow(host: EditorHost, note = ""): Promise<Backup | null> {
  try {
    const pid = await ensureStudioProject(host);
    const local = versionsBridge();
    if (local?.backupNow && host.path()) await local.backupNow(host.path()).catch(() => undefined);
    const fd = new FormData();
    const json = JSON.stringify(backupDoc(host.project()));
    fd.append("file", new Blob([json], { type: "application/json" }), `${(host.project().name || "edit").replace(/[\\/:*?"<>|]/g, "_")}.tatvamedit`);
    fd.append("device", await deviceName());
    if (note) fd.append("note", note.slice(0, 200));
    const b = await api.post<Backup>(`/api/edits/${pid}/backups`, fd, { silent: true });
    host.toast(b.deduped ? "Already backed up: nothing changed since the last backup" : "Backed up on the studio", "ok");
    return b;
  } catch (e) {
    host.toast(`Backup: ${errText(e)}`, "error");
    return null;
  }
}

export async function listBackups(host: EditorHost): Promise<Backup[]> {
  const pid = host.studioProjectId();
  return pid ? api.get<Backup[]>(`/api/edits/${pid}/backups`, { silent: true }) : [];
}

const isEdit = (x: unknown): x is EditProject => !!x && typeof x === "object" && (x as EditProject).format === "tatvam-edit" && Array.isArray((x as EditProject).sequences);

function replaceWith(host: EditorHost, label: string, doc: EditProject) {
  const next = restoredProject(host.project(), doc);
  host.apply(label, (d) => {
    for (const k of Object.keys(d) as (keyof EditProject)[]) if (!(k in next)) delete d[k];
    Object.assign(d, next);
  });
}

/** Puts a studio backup back as the open edit (one undo step; saving writes it to the PC). */
export async function restoreBackup(host: EditorHost, b: Backup): Promise<boolean> {
  const when = b.created_at ? new Date(b.created_at).toLocaleString() : `#${b.id}`;
  const ok = await askChoice({ title: "Restore this backup?", multiple: false, confirmLabel: "Restore",
    note: `The edit becomes the copy from ${when}${b.device ? ` (${b.device})` : ""}: ${b.clip_count} clips. Undo takes it back.`,
    items: [{ id: "yes", label: b.name || "This edit", detail: `${b.sequence_count} sequence${b.sequence_count === 1 ? "" : "s"}`, checked: true }] });
  if (!ok?.length) return false;
  try {
    const r = await api.post<{ backup: Backup; project: unknown }>(`/api/edits/${b.project_id}/backups/${b.id}/restore`, {}, { silent: true });
    if (!isEdit(r.project)) throw new Error("That backup isn't an edit");
    replaceWith(host, `Restore the backup from ${when}`, r.project);
    host.toast("Backup restored. Save to keep it on this PC.", "ok");
    return true;
  } catch (e) {
    host.toast(`Restore: ${errText(e)}`, "error");
    return false;
  }
}

/** This PC's own versions of the edit (desktop-tools), or null when the desktop can't list them. */
export async function localVersions(host: EditorHost): Promise<LocalVersion[] | null> {
  const b = versionsBridge();
  if (!b?.versions || !host.path()) return null;
  try {
    const r = await b.versions(host.path());
    return Array.isArray(r) ? r : r?.versions ?? [];
  } catch {
    return null;
  }
}

export async function restoreLocal(host: EditorHost, v: LocalVersion): Promise<boolean> {
  const b = versionsBridge();
  if (!b?.restoreVersion) return false;
  try {
    const r = await b.restoreVersion(host.path(), v.id);
    const doc = isEdit(r) ? r : isEdit((r as { project?: unknown })?.project) ? (r as { project: EditProject }).project : null;
    if (doc) replaceWith(host, `Restore the version from ${v.modified ?? v.created ?? v.id}`, doc);
    host.toast(doc ? "Version restored" : "Version restored on this PC: reopen the edit to see it", "ok");
    return true;
  } catch (e) {
    host.toast(`Restore: ${bridgeMessage(e)}`, "error");
    return false;
  }
}

// ── timeline review comments ─────────────────────────────────────────────────

/** A sequence id as the comments API takes it. */
export const seqKey = (id: string) => id.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);

export async function listComments(host: EditorHost, all = false): Promise<EditComment[]> {
  const pid = host.studioProjectId();
  if (!pid) return [];
  const q = `target_type=edit&target_id=${pid}${all ? "" : `&sequence_id=${encodeURIComponent(seqKey(host.sequence().id))}`}`;
  return api.get<EditComment[]>(`/api/comments?${q}`, { silent: true });
}

export async function addComment(host: EditorHost, body: string, frame: number): Promise<EditComment | null> {
  try {
    const pid = await ensureStudioProject(host);
    const seq = host.sequence();
    return await api.post<EditComment>("/api/comments", { target_type: "edit", target_id: pid, body: body.slice(0, 4000),
      sequence_id: seqKey(seq.id), frame: Math.max(0, Math.round(frame)),
      timecode: Math.round((frame / seq.fps) * 1000) / 1000 }, { silent: true });
  } catch (e) {
    host.toast(`Comment: ${errText(e)}`, "error");
    return null;
  }
}

export const resolveComment = (id: number) => api.post<EditComment>(`/api/comments/${id}/resolve`, {}, { silent: true });
