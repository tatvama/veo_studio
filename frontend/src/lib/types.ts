export type Role = "viewer" | "reviewer" | "creator" | "producer" | "admin";
export const ROLE_RANK: Record<Role, number> = { viewer: 0, reviewer: 1, creator: 2, producer: 3, admin: 4 };

export interface UserBrief { id: number; name: string; email: string; role: Role }
export interface User extends UserBrief {
  active: boolean; monthly_limit_usd: number | null; created_at: string; last_login_at: string | null;
  spent_month_usd?: number; effective_limit_usd?: number | null;
}

export interface Take {
  id: number; shot_id: number; kind: string; language: string | null; provider: string; model: string;
  params: Record<string, any>; prompt: string; path: string; url: string; thumb_url: string; duration_s: number;
  cost_usd: number; qc: Record<string, any>; selected: boolean; status: string; created_at: string; created_by: number | null;
  interaction_id: string; parent_take_id: number | null;
}

export interface DialogueLine { character_id: number | "NARRATOR"; line: string; emotion?: string }

export interface Shot {
  id: number; episode_id: number; scene_id: number | null; order: number; code: string; duration_s: number;
  framing: string; camera: string; action: string; characters: number[]; outfits: Record<string, string>;
  location_id: number | null; dialogue: Record<string, DialogueLine[]>; narration: Record<string, string>;
  sfx: string; music_cue: string; mode: string; quality_mode: string | null; voice_mode: string;
  continuity_from_prev: boolean; include: boolean; trim_in: number; trim_out: number; status: string; notes: string;
  generating: boolean; keyframe: Take | null; video: Take | null; voice: Take | null; narration_take: Take | null;
  lipsync: Take | null; voicelock: Take | null; effective_quality: string; effective_voice_mode: string;
  active_jobs: string[]; comments: number; takes?: Take[];
  engine: string; overlays: { text: string; start: number; end: number; kind: "title" | "lower_third"; anim?: string }[];
  /** transitions & effects (see lib/fx.ts) */
  fx?: import("./fx").ShotFx;
  sfx_track: { path?: string; prompt?: string; start?: number; volume_db?: number };
  extend_to: number; extend_prompt: string;
  /** The user's reference images for this shot (product, prop, look). */
  ref_images?: ShotRef[];
}
export interface ShotRef { label: string; url: string; path?: string }

export interface Scene { id: number; episode_id: number; order: number; title: string; location_id: number | null; time_of_day: string; summary: string }

// ── Shot list (manual builder + script import) ───────────────────────────────
/** speaker: a character id, or "VO" for voice-over (read by the project narrator). */
export interface BoardLine { speaker: number | "VO"; text: string; emotion: string; changed?: boolean }
export interface BoardShot {
  id?: number | null; key?: string; code?: string; prompt: string; characters: number[]; lines: BoardLine[];
  duration_s: number; extend_to: number; extend_prompt: string; framing: string; camera: string;
  status?: string; generating?: boolean; thumb_url?: string; video_s?: number; has_video?: boolean;
  keyframe_uploaded?: boolean; ref_images?: ShotRef[];
  /** video model: "auto" (team policy, Google first) or an engine id */
  engine?: string;
}
export interface BoardScene { id?: number | null; key?: string; title: string; location: string; time_of_day: string; summary: string; shots: BoardShot[] }
export interface Board {
  episode_id: number; language: string; scenes: BoardScene[];
  /** content version; sent back on save so a stale editor can't overwrite newer changes */
  version?: string;
  limits: { durations: number[]; extend_step_s: number; max_extend_s: number };
}
/** A parsed script before it is saved: speakers and characters are still names from the file. */
export interface DraftLine { speaker: string; text: string; emotion: string; changed?: boolean }
export interface DraftShot { prompt: string; characters: string[]; lines: DraftLine[]; duration_s: number; framing: string; camera: string }
export interface DraftScene { title: string; location: string; time_of_day: string; summary: string; shots: DraftShot[] }
export interface ImportResult {
  draft: { title: string; scenes: DraftScene[] }; method: "markers" | "ai"; warnings: string[]; source: string; text: string;
  stats: { scenes: number; shots: number; lines: number };
  characters: { name: string; lines: number; match: (Character & { in_project: boolean }) | null }[];
}

export interface Hook { text: string; type: string; visual: string; scores: Record<string, number>; total: number }
export interface ScriptLine { character: string; line: string; emotion: string }
export interface ScriptScene { title: string; location: string; time_of_day: string; summary: string; action: string; lines: ScriptLine[] }
export interface Script { logline?: string; beats?: string[]; scenes?: ScriptScene[] }

export interface AudioAsset { id: number; kind: string; prompt: string; url: string; duration_s: number; selected: boolean; cost_usd: number; created_at: string }
export interface ExportRow {
  id: number; episode_id: number; language: string; preset: string; kind: string; status: string; url: string; srt_url: string;
  thumb_url: string; duration_s: number; warnings: string[]; created_at: string; options: Record<string, any>; approved_by: number | null;
  peaks: number[]; published: Record<string, { status: string; url?: string; video_id?: string; title?: string; at?: string }>;
  ai_disclosure: boolean;
}

export interface Episode {
  id: number; project_id: number; number: number; season: number; kind: string; title: string; outline: string;
  hooks: Hook[]; selected_hook: number | null; script: Script; summary_for_next: string; settings: Record<string, any>;
  status: string; scenes?: Scene[]; shots?: Shot[]; music?: AudioAsset[]; exports?: ExportRow[]; total_duration_s?: number;
  critic: Partial<CriticReport>; continuity: Partial<ContinuityReport>; table_read: Record<string, Partial<TableRead>>;
  marketing: MarketingPack;
}

export interface CharacterAsset { id: number; character_id: number; kind: string; label: string; outfit: string; url: string; approved: boolean; archived: boolean; created_at: string }
export interface VoiceProfile {
  id: number; character_id: number; language: string; provider: string; voice_id: string; voice_name: string;
  description: string; style_prompt: string; sample_url: string; sts_voice_id: string;
}
export interface Character {
  id: number; name: string; role: string; gender: string; age: string; dna_text: string; personality: string;
  voice_description: string; shared: boolean; version: number; locked: boolean; avatar_url: string;
  assets?: CharacterAsset[]; voices?: any[]; asset_count?: number;
  identity: { status?: "preparing" | "training" | "ready" | "failed" | "cancelled"; trigger?: string; images?: number; trained_at?: string;
    error?: string; lora_url?: string; basis?: "your_photos" | "sheet" };
  /** The character registered with outside services: BytePlus asset library entries that Seedance takes as references. */
  provider_assets?: { byteplus?: { status?: "registering" | "ready" | "failed"; group_id?: string; error?: string; registered_at?: string;
    updated_at?: string; assets?: { asset_id: string; source_id: number; path: string; kind: string; status: "Active" | "Processing" | "Failed" | string; error?: string }[] } };
  /** What a face model would be trained on now: the user's photos + approved variations (or the sheet if no photos). */
  training?: { basis: "your_photos" | "sheet"; own: number; variations_approved: number; variations_waiting: number; count: number; min: number;
    good: number; auto_fill: boolean };
}
export interface LocationAsset { id: number; kind: string; label: string; time_of_day: string; url: string; approved: boolean }
export interface Location { id: number; name: string; description_text: string; locked: boolean; thumb_url: string; assets?: LocationAsset[] }
export interface Style { id: number; name: string; look: string; lens: string; grade: string; grain: string; avoid_list: string; notes: string; locked: boolean }

export interface Project {
  id: number; title: string; type: string; concept: string; aspect: string; languages: string[]; primary_language: string;
  quality_mode: string; agent_mode: string; workflow?: "director" | "script" | "shots"; budget_cap_usd: number | null; brief: Record<string, any>; story: Record<string, any>;
  style_id: number | null; brand_kit_id: number | null; status: string; autopilot: Record<string, any>; archived: boolean; created_at: string; updated_at: string;
  episodes: Episode[]; spent_usd: number; thumb_url: string; owner: UserBrief | null; cast?: Character[]; locations?: Location[];
  style?: Style | null;
}

export interface Job {
  id: number; type: string; status: string; project_id: number | null; episode_id: number | null; shot_id: number | null;
  label: string; progress: number; message: string; cost_estimate: number; cost_actual: number; batch_id: string; error: string;
  created_at: string; started_at: string | null; finished_at: string | null; requested_by_user: UserBrief | null; payload: Record<string, any>;
}

export interface SubmitResult { batch_id: string; status: string; total_usd: number; jobs: Job[]; skipped?: number; reason?: string }
export interface Estimate {
  count: number; total_usd: number; items: { label: string; usd: number }[];
  budget: { ok: boolean; needs_role: string | null; reason: string };
  team: TeamStatus;
}
export interface TeamStatus { cap_usd: number; spent_usd: number; reserved_usd: number; remaining_usd: number | null; pct: number }

export interface ProviderStatus { provider: string; label: string; mode: "live" | "mock" | "missing" }

export interface Catalog {
  languages: Record<string, { name: string; bcp47: string; script: string }>;
  quality_modes: Record<string, { model_key: string; resolution: string; label: string }>;
  project_types: Record<string, { label: string; aspect: string; duration_s: number }>;
  export_presets: Record<string, { label: string; aspect: string | null; w: number; h: number }>;
  style_presets: Omit<Style, "id" | "locked">[];
  gemini_voices: [string, string][];
  sarvam_speakers: Record<string, string[]>;
  sts_languages: string[];
  roles: Role[];
  autopilot: AutopilotCatalog;
}

export interface Milestone { id: "script" | "cast" | "storyboard" | "final"; label: string; until: string; tab: string; description: string }
export interface AutopilotCatalog { stages: string[]; labels: Record<string, string>; milestones: Milestone[] }
/** Project.autopilot: the last (or current) run. */
export interface AutopilotState {
  job_id?: number; episode_id?: number; stage?: string; milestone?: string; through?: string; pause_after?: string[];
  paused_after?: string; status?: "running" | "done" | "paused" | "finished" | "failed" | "cancelled" | "stopped"; log?: string[];
  error?: string; updated_at?: string;
}

export interface SettingsPayload {
  settings: Record<string, any>; models: Record<string, string>; prices: Record<string, any>; catalog: Catalog;
  providers: ProviderStatus[]; team: TeamStatus;
}

export interface AgentMessage {
  id: number; role: "user" | "assistant"; content: string; created_at: string; user: UserBrief | null;
  data: {
    proposals?: { batch_id: string; status: string; total_usd: number; what: string; count: number; pending?: boolean; reason?: string }[];
    actions?: string[];
    /** Actions that would replace existing work, waiting for the user's OK. */
    confirmations?: { id: string; tool: string; what: string; detail: string; status: "pending" | "done" | "declined" | "failed"; result?: string }[];
  };
}

export interface Comment { id: number; target_type: string; target_id: number; body: string; resolved: boolean; created_at: string; user: UserBrief | null;
  timecode?: number | null; drawing?: Stroke[]; guest_name?: string }
export interface EventRow { id: number; project_id: number | null; type: string; payload: Record<string, any>; created_at: string; user: UserBrief | null }
export interface Approval {
  id: number; batch_id: string; project_id: number | null; project_title: string; amount_usd: number; reason: string; summary: string;
  needs_role: Role; status: string; created_at: string; requested_by_user: UserBrief | null; can_decide: boolean;
}
export interface Notification { type: string; id: number; text: string; project_id?: number; target_type?: string; target_id?: number; created_at: string }

// ── v2: Model Hub ────────────────────────────────────────────────────────────
export interface AIModel {
  id: string; provider: string; endpoint: string; family: string; maker: string; display_name: string; description: string;
  category: string; task: "video" | "avatar" | "lipsync" | "edit" | "image" | "tts" | "music" | "train" | "other";
  capabilities: { modes?: string[]; max_refs?: number; durations?: number[] | { min?: number; max?: number } | null;
    resolutions?: string[] | null; aspects?: string[] | null; native_audio?: boolean; usable?: boolean;
    // gateway flags (v3): what the engine can do for characters and dialogue
    speech_in_video?: boolean; audio_driven?: boolean; lora_input?: boolean; lipsync_to_audio?: boolean };
  price_usd: number | null; price_unit: string; price_source: string; price_label: string; est_8s_usd: number | null;
  status: "new" | "enabled" | "disabled" | "retired"; tier: string; rating: number | null; wins: number; uses: number;
  failures: number; tags: string[]; thumbnail_url: string; released_at: string; builtin: boolean; notes: string;
  provider_mode: "live" | "mock" | "missing"; unmapped_required: string[]; first_seen: string; estimate_usd?: number;
  param_map?: Record<string, any>; param_overrides?: Record<string, any>;
  /** The model behind the engine ("seedance-2"); engines with the same key run the same model through other providers. */
  route_key?: string; other_routes?: ModelRoute[];
}
/** One provider's way to run a model. */
export interface ModelRoute {
  id: string; provider: string; display_name: string; provider_mode: "live" | "mock" | "missing"; est_8s_usd: number | null;
  price_usd?: number | null; price_unit?: string; modes?: string[];
}
/** How a video model can use a shot: characters/location by "refs" (images go to the model), "keyframe" or not at all. */
export interface VideoFit {
  characters: "refs" | "keyframe" | "none"; location: "refs" | "keyframe" | "none"; max_refs: number;
  start_frame: boolean; end_frame: boolean; sound: boolean; extend: boolean; talking: boolean;
}
/** A video model for the shot picker: listed once, led by its cheapest live route; `routes` are all of them. */
export interface VideoEngine extends AIModel { fit: VideoFit; routes?: Pick<ModelRoute, "id" | "provider" | "display_name" | "provider_mode" | "est_8s_usd">[] }
export interface VideoEngines { engines: VideoEngine[]; auto_first: Record<string, string | null>; google_first: boolean }
export interface ModelList { models: AIModel[]; total: number; offset: number; last_sync: { at?: string; total?: number; new?: string[]; new_count?: number; retired?: number; priced?: number };
  counts: Record<string, number> }
export interface ModelPolicy { chains: Record<string, string[]>; labels: Record<string, string>; defaults: Record<string, string[]>;
  models: Record<string, AIModel> }
export interface ShotEngines { engines: AIModel[]; current: string; auto_chain: string[]; chain: string }

// ── v2: Writers' room ────────────────────────────────────────────────────────
export interface SceneCard extends Scene {
  goal: string; conflict: string; turn: string; emotion: string; characters: number[]; props: string[];
  wardrobe: Record<string, string>; continuity_notes: string; coverage: string[]; blocking: string; approved: boolean;
}
export interface CriticReport {
  scores: Record<string, number>; overall: number; strengths: string[]; problems: string[]; rewrite_instructions: string;
  round?: number; at?: string; history?: { round: number; overall: number }[];
}
export interface ContinuityReport { ok: boolean; issues: { severity: string; where: string; problem: string; fix: string }[]; at?: string }
export interface ScriptVersion { id: number; episode_id: number; version: number; script: Script; note: string; source: string;
  critic: Partial<CriticReport>; created_by: number | null; created_at: string }
export interface TableReadLine { scene: number; scene_title: string; character: string; character_id: any; text: string; start: number; end: number }
export interface TableRead { path: string; url: string; duration: number; lines: TableReadLine[]; at: string }
export interface MarketingPack {
  copies?: { platform: string; language: string; titles: string[]; description: string; hashtags: string[]; pinned_comment: string }[];
  thumbnails?: { concept: string; overlay_text: string; image_prompt: string }[];
  thumbnail_files?: { path: string; url: string; overlay_text: string; concept: string }[]; posting_tips?: string[]; at?: string;
}
export interface Trends { trends: string[]; hook_patterns: string[]; sounds_or_formats: string[]; cautions: string[]; at?: string }

// ── v2: Growth ───────────────────────────────────────────────────────────────
export interface BrandKit {
  id: number; name: string; logo_path: string; logo_url: string; colors: string[]; fonts: Record<string, string>; tagline: string;
  cta: string; website: string; product_assets: { path: string; label: string }[]; product_urls: { path: string; label: string; url: string }[];
  voice_tone: string; rules: string; end_card: { enabled?: boolean; seconds?: number; text?: string }; created_at: string;
}
export interface SearchResult { id: number; entity_type: string; entity_id: number; project_id: number | null; text: string; thumb_url: string; score: number;
  shot_id?: number | null }
export interface ReviewLinkRow { token: string; export_id: number; label: string; allow_comments: boolean; expires_at: string | null; revoked: boolean; url: string; created_at: string }
export interface IntegrationRow { id: number; provider: string; account_name: string; account_id: string; created_at: string }
export interface ConsentRow { id: number; kind: string; subject_name: string; character_id: number | null; file_url: string; scope: string; expires_on: string; created_at: string }
export interface AuditRow { id: number; action: string; target: string; detail: Record<string, any>; ip: string; created_at: string; user: UserBrief | null }
export interface Prefs { ui_language?: string; theme?: "dark" | "light" | "system"; onboarding_done?: boolean; motion?: "full" | "reduced"; currency?: "both" | "usd" | "inr" }
export interface HookInsight { hook: string; avg_view_pct: number | null; views: number; export_id: number; retention: [number, number][] }
export interface Stroke { color: string; width?: number; points: [number, number][] }
export interface ReviewComment extends Comment { timecode: number | null; drawing: Stroke[]; guest_name: string; author?: string }

// ── MCP access (Settings → MCP access, /oauth/consent) ───────────────────────
export type McpScope = "read" | "write" | "spend";
export interface McpInfo { enabled: boolean; url: string; oauth: boolean; scopes: McpScope[]; tools: string[] }
export interface McpToken {
  id: number; name: string; kind: "personal" | "oauth_access"; prefix: string; scopes: McpScope[]; project_ids: number[]; client_id: string;
  expires_at: string | null; last_used_at: string | null; created_at: string;
  /** The raw secret: only in the response that created the token. */
  token?: string;
}
export interface OAuthRequestView {
  id: string; client: string; redirect_host: string; scopes: McpScope[]; status: "pending" | "approved" | "denied" | "used"; expired: boolean;
  allowed_scopes: McpScope[];
}
