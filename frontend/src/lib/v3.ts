/** Tatvam v3 API: types and query hooks for the new backend endpoints (production.py, shots.next, bible.lighting,
 *  board.import/apply, projects.pronunciations). Import from here; do not add these to types.ts / queries.ts. */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Character, Take } from "./types";

// ── mentions ─────────────────────────────────────────────────────────────────
export type MentionKind = "character" | "location" | "prop";
export interface MentionCandidate { kind: MentionKind; id: number; name: string; token: string; in_project: boolean }
/** `@[Name](kind:id)` */
export const MENTION_RE = /@\[([^\]\n]+)\]\((character|location|prop):(\d+)\)/g;
export const mentionToken = (kind: MentionKind, id: number, name: string) => `@[${name}](${kind}:${id})`;
export const plainText = (s: string) => (s || "").replace(MENTION_RE, (_m, name) => name);
export function findMentions(s: string): { kind: MentionKind; id: number; name: string; start: number; end: number }[] {
  const out: { kind: MentionKind; id: number; name: string; start: number; end: number }[] = [];
  for (const m of (s || "").matchAll(MENTION_RE)) {
    out.push({ kind: m[2] as MentionKind, id: Number(m[3]), name: m[1], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}
export const useMentionCandidates = (pid: number, q = "", kind?: MentionKind, limit = 12) =>
  useQuery({ queryKey: ["mentions", pid, q, kind ?? "all", limit],
             queryFn: () => api.get<MentionCandidate[]>(`/api/projects/${pid}/mentions?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}&limit=${limit}`),
             enabled: !!pid, staleTime: 15_000 });
export interface MentionCreated { kind: MentionKind; id: number; name: string; token: string }
export const createMention = (kind: MentionKind, name: string, project_id: number) =>
  api.post<MentionCreated>("/api/mentions/create", { kind, name, project_id });
export interface ResolveResult { script: Record<string, any>; created: { kind: string; id: number; name: string }[]; entities: Record<MentionKind, number[]> }
export const resolveMentions = (eid: number, create_missing = true) =>
  api.post<ResolveResult>(`/api/episodes/${eid}/script/resolve`, { create_missing });

// ── import wizard apply ───────────────────────────────────────────────────────
export interface ImportApplyResult { episode_id: number; scenes: any[]; version?: string; characters: Record<string, number>; created: { id: number; name: string }[] }
export const importApply = (eid: number, draft: any, mapping: Record<string, number | "new">, create_missing = true, write_script = true) =>
  api.post<ImportApplyResult>(`/api/episodes/${eid}/import/apply`, { draft, mapping, create_missing, write_script });

// ── change impact ─────────────────────────────────────────────────────────────
export interface StaleTake { id: number; kind: string; language: string | null; reason: string; selected: boolean }
export interface Impact { shots: { shot_id: number; code: string; status: string; takes: StaleTake[] }[]; counts: Record<string, number>;
                          estimate_usd: number; plan: { label: string; usd: number }[] }
export const useImpact = (eid: number | undefined) =>
  useQuery({ queryKey: ["impact", eid], queryFn: () => api.get<Impact>(`/api/episodes/${eid}/impact`), enabled: !!eid });
export const regenerateStale = (eid: number, shot_ids?: number[], kinds?: string[]) =>
  api.post(`/api/episodes/${eid}/impact/regenerate`, { shot_ids, kinds });
export const markFresh = (tid: number) => api.post<Take>(`/api/takes/${tid}/fresh`, {});
export const useDialogueCheck = (sid: number | null, lang?: string) =>
  useQuery({ queryKey: ["dialogue-check", sid, lang], queryFn: () => api.get<{ warnings: string[] }>(`/api/shots/${sid}/dialogue-check${lang ? `?lang=${lang}` : ""}`),
             enabled: !!sid });

// ── Film Map: next shot ───────────────────────────────────────────────────────
export interface NextShotIn { action?: string; framing?: string; camera?: string; duration_s?: 4 | 6 | 8; mode?: "last_frame" | "extend"; generate?: boolean; quality?: string | null }
export const nextShot = (sid: number, body: NextShotIn) => api.post<{ shot: any; jobs: any }>(`/api/shots/${sid}/next`, body);

// ── dashboards ────────────────────────────────────────────────────────────────
export interface EpisodeDashboard {
  episode_id: number; number: number; title: string; status: string;
  shots: { total: number; approved: number; in_review: number; remaining: number; generating: number; by_status: Record<string, number> };
  footage: { planned_s: number; approved_s: number; generated_s: number; rejected_takes: number; regeneration_rate: number; stale_takes: number };
  spend: { total_usd: number; by_provider: Record<string, number>; wasted_usd: number; per_approved_second: number | null; estimated_remaining_usd: number | null };
  queue: { active_jobs: number; renders: number; pending_approvals: number };
  timeline_ready: boolean;
  latest_export: { id: number; preset: string; language: string; approved: boolean } | null;
}
export interface ProjectDashboard {
  project_id: number; title: string; type: string; status: string; episodes: EpisodeDashboard[];
  shots: { total: number; approved: number; in_review: number; remaining: number; generating: number };
  footage: { approved_s: number; generated_s: number; stale_takes: number };
  spend: { total_usd: number; by_provider: Record<string, number>; budget_cap_usd: number | null; per_approved_second: number | null };
  queue: { active_jobs: number; pending_approvals: number };
}
export const useEpisodeDashboard = (eid: number | undefined) =>
  useQuery({ queryKey: ["dashboard", "episode", eid], queryFn: () => api.get<EpisodeDashboard>(`/api/episodes/${eid}/dashboard`), enabled: !!eid, refetchInterval: 20_000 });
export const useProjectDashboard = (pid: number | undefined) =>
  useQuery({ queryKey: ["dashboard", "project", pid], queryFn: () => api.get<ProjectDashboard>(`/api/projects/${pid}/dashboard`), enabled: !!pid, refetchInterval: 20_000 });

// ── seasons ───────────────────────────────────────────────────────────────────
export interface Season { id: number; project_id: number; number: number; title: string; arc: string; status: string; created_at: string;
                          episodes: { id: number; number: number; title: string; status: string }[] }
export const useSeasons = (pid: number | undefined) =>
  useQuery({ queryKey: ["seasons", pid], queryFn: () => api.get<Season[]>(`/api/projects/${pid}/seasons`), enabled: !!pid });
export const addSeason = (pid: number, body: { number?: number; title?: string; arc?: string; episodes?: number }) => api.post<Season>(`/api/projects/${pid}/seasons`, body);
export const patchSeason = (sid: number, body: Partial<Pick<Season, "title" | "arc" | "status">>) => api.patch<Season>(`/api/seasons/${sid}`, body);

// ── continuity bible, wardrobe ────────────────────────────────────────────────
export interface EndState { characters: Record<string, { name: string; outfit: string; state: string }>; props: string[]; time_of_day: string; weather: string; notes: string; source: "ai" | "manual" }
export interface BibleScene { id: number; order: number; title: string; wardrobe: Record<string, string>; props: string[]; prop_ids: number[]; end_state: Partial<EndState> }
export const useContinuityBible = (eid: number | undefined) =>
  useQuery({ queryKey: ["continuity-bible", eid], queryFn: () => api.get<{ episode_id: number; scenes: BibleScene[] }>(`/api/episodes/${eid}/continuity-bible`), enabled: !!eid });
export const aiEndState = (scid: number) => api.post<EndState>(`/api/scenes/${scid}/end-state`, {});
export const editEndState = (scid: number, body: Partial<EndState>) => api.patch<EndState>(`/api/scenes/${scid}/end-state`, body);
export interface WardrobeRow { scene_id: number; order: number; title: string; outfit: string; source: "scene" | "shot" | "bible" | "default"; mixed: boolean; change: boolean; break: boolean }
export interface WardrobeTimeline { episode_id: number; characters: { character_id: number; name: string; scenes: WardrobeRow[] }[]; breaks: number }
export const useWardrobe = (eid: number | undefined) =>
  useQuery({ queryKey: ["wardrobe", eid], queryFn: () => api.get<WardrobeTimeline>(`/api/episodes/${eid}/wardrobe`), enabled: !!eid });

// ── character lock, versions, costumes, lighting ──────────────────────────────
export interface CharacterLock { face: boolean; body: boolean; skin_hair: boolean; voice: boolean; costume_continuity: boolean; gestures: string; age: string; lighting: string; strictness: number }
export const useCharacterLock = (cid: number | undefined) =>
  useQuery({ queryKey: ["character-lock", cid], queryFn: () => api.get<{ lock: CharacterLock; defaults: CharacterLock; prompt_text: string }>(`/api/characters/${cid}/lock`), enabled: !!cid });
export const setCharacterLock = (cid: number, lock: Partial<CharacterLock>) => api.put<{ lock: CharacterLock; prompt_text: string }>(`/api/characters/${cid}/lock`, { lock });
export interface CharacterVersion { id: number; character_id: number; version: number; label: string; episode_from: number | null; episode_to: number | null;
                                    dna_text: string; voice_description: string; lock: Partial<CharacterLock>; asset_ids: number[]; identity: Record<string, any>; note: string; created_at: string }
export const useCharacterVersions = (cid: number | undefined) =>
  useQuery({ queryKey: ["character-versions", cid], queryFn: () => api.get<CharacterVersion[]>(`/api/characters/${cid}/versions`), enabled: !!cid });
export const createVersion = (cid: number, body: { label?: string; episode_from?: number | null; episode_to?: number | null; note?: string; dna_text?: string; voice_description?: string; lock?: Partial<CharacterLock> }) =>
  api.post<CharacterVersion>(`/api/characters/${cid}/versions`, body);
export const patchVersion = (vid: number, body: Partial<CharacterVersion>) => api.patch<CharacterVersion>(`/api/character-versions/${vid}`, body);
export const deleteVersion = (vid: number) => api.del(`/api/character-versions/${vid}`);
export const restoreVersion = (vid: number) => api.post(`/api/character-versions/${vid}/restore`, {});
export const useCharacterLook = (cid: number | undefined, episode?: number) =>
  useQuery({ queryKey: ["character-look", cid, episode], queryFn: () => api.get<{ dna: string; voice: string; lock: CharacterLock; asset_ids: number[]; version: CharacterVersion | null }>(`/api/characters/${cid}/look${episode ? `?episode=${episode}` : ""}`), enabled: !!cid });
export interface Costume { id: number; character_id: number; name: string; description: string; episode_from: number | null; episode_to: number | null; is_default: boolean; archived: boolean;
                           images: { id: number; url: string; view: string; approved: boolean; label: string }[] }
export const useCostumes = (cid: number | undefined) =>
  useQuery({ queryKey: ["costumes", cid], queryFn: () => api.get<Costume[]>(`/api/characters/${cid}/costumes`), enabled: !!cid });
export const createCostume = (cid: number, body: { name: string; description?: string; episode_from?: number | null; episode_to?: number | null; is_default?: boolean; generate?: boolean; views?: string[]; project_id?: number | null }) =>
  api.post<{ costume: Costume; jobs?: any }>(`/api/characters/${cid}/costumes`, body);
export const patchCostume = (coid: number, body: Partial<Pick<Costume, "name" | "description" | "episode_from" | "episode_to" | "is_default">>) => api.patch<Costume>(`/api/costumes/${coid}`, body);
export const deleteCostume = (coid: number) => api.del(`/api/costumes/${coid}`);
export const generateLighting = (cid: number, project_id?: number | null, variants?: string[]) => api.post(`/api/characters/${cid}/lighting`, { project_id, variants });
export const SHEET_VIEWS = ["front", "three_quarter", "profile", "back", "full_body"] as const;
export const LIGHTING_VARIANTS = ["day", "dusk", "night_interior"] as const;
/** Extra fields the character payload now carries (CharacterDetail reads them off `Character` via this helper type). */
export type CharacterV3 = Character & { lock?: Partial<CharacterLock>; lock_effective?: CharacterLock; name_pronunciation?: string; performance_notes?: string;
                                        versions?: CharacterVersion[]; costumes?: Omit<Costume, "images">[]; assets?: (Character["assets"] extends (infer A)[] | undefined ? A & { view?: string; lighting?: string } : any)[] };

// ── props ─────────────────────────────────────────────────────────────────────
export interface Prop { id: number; name: string; description: string; path: string; url: string; shared: boolean; archived: boolean; in_project?: boolean }
export const useProps = (pid?: number) =>
  useQuery({ queryKey: ["props", pid ?? "library"], queryFn: () => api.get<Prop[]>(`/api/props${pid ? `?project_id=${pid}` : ""}`) });
export const createProp = (body: { name: string; description?: string; shared?: boolean; project_id?: number | null }) => api.post<Prop>("/api/props", body);
export const patchProp = (id: number, body: Partial<Pick<Prop, "name" | "description" | "shared" | "archived">>) => api.patch<Prop>(`/api/props/${id}`, body);
export const uploadPropImage = (id: number, file: File) => api.upload<Prop>(`/api/props/${id}/upload`, file);
export const addPropToProject = (pid: number, id: number) => api.post(`/api/projects/${pid}/props/${id}`, {});
export const removePropFromProject = (pid: number, id: number) => api.del(`/api/projects/${pid}/props/${id}`);

// ── shot fields added in v3 (patch with PATCH /api/shots/{id}) ───────────────
export interface ShotV3Fields { continuity_from_shot_id?: number | null; continuity_mode?: "last_frame" | "extend"; prop_ids?: number[] }
/** Take fields added in v3 */
export type TakeV3 = Take & { stale?: boolean; stale_reason?: string };
