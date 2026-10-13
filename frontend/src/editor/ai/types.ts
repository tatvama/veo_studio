/**
 * What the studio's editor endpoints take and give (backend/app/api/edits.py, core/edit_ai.py). Times are seconds;
 * a result's times count from the start of the source range the tool was given (`offset` = that start).
 */

export type ToolId =
  | "transcribe" | "translate" | "tts" | "dub" | "clean_voice" | "sfx" | "sfx_suggest" | "music"
  | "video" | "extend" | "edit_words" | "upscale" | "assistant"
  | "broll_suggest" | "highlights" | "thumbnail" | "voice_clone" | "mood_suggest";

export interface ToolCall { tool: ToolId; params: Record<string, unknown>; what?: string }

export interface CostLine { label: string; usd: number }
export interface Budget { ok: boolean; needs_role: string | null; reason: string }

export interface Estimate {
  tool: ToolId; label: string; job: string; params: Record<string, unknown>; items: CostLine[]; total_usd: number;
  budget: Budget; engine?: string; engine_id?: string; mode?: string; seconds?: number; resolution?: string;
  to?: [number, number]; voice?: string; images?: number; prompt?: string;
}

export interface RunResult {
  batch_id: string; status: "queued" | "awaiting_approval" | "proposed" | string; total_usd: number; reason?: string;
  job_id: number | null; tool: ToolId; items: CostLine[];
}

export interface Output {
  key: string; url: string; kind: "audio" | "video" | "image"; duration: number; name: string;
  role?: string; start?: number; end?: number; text?: string; width?: number; height?: number;
  /** thumbnails */
  aspect?: "16:9" | "9:16"; variant?: number;
}

export interface Word { start: number; end: number; text: string }
export interface Segment { start: number; end: number; text: string; words?: Word[] }

export interface AiResult {
  tool: ToolId; outputs: Output[]; offset?: number;
  language?: string; segments?: Segment[]; lines?: Output[];
  suggestions?: string[];
  reply?: string; commands?: AiCommandRow[]; rejected?: { op: string; reason: string }[];
  engine?: string; engine_label?: string; mode?: string; mock?: boolean;
  ideas?: BrollIdea[]; highlights?: Highlight[]; moods?: MoodPick[]; voice?: ClonedVoice | Record<string, unknown>;
  prompt?: string; platform?: string; title?: string;
}

// ── wave 3 tools (docs/EDITOR.md §10; times in seconds on the sequence) ─────────────

export interface BrollIdea { start: number; end: number; prompt: string; reason: string }
export interface Highlight { start: number; end: number; title: string; hook: string; why: string }
export interface MoodPick { scene_id: string; mood: string; why: string }
export type Platform = "shorts" | "reels" | "tiktok" | "any";
export interface ClonedVoice {
  provider: string; voice_id: string; name: string; character_id: number; profile_ids: number[]; languages: string[];
  consent_id: number; subject: string;
}
export interface ConsentRow { id: number; kind: string; subject_name: string; scope: string; expires_on: string; character_id: number | null }

/** A copy of the edit on the studio (core/edit_backups.py). */
export interface Backup {
  id: number; project_id: number; created_at: string | null; size: number; sha256: string; name: string; edit_id: string;
  edit_modified: string; clip_count: number; sequence_count: number; duration: number; device: string; note: string;
  by: { id: number; name: string } | null; download_url: string; deduped?: boolean;
}

/** A timeline review comment on the edit (comments API, target_type "edit"). */
export interface EditComment {
  id: number; project_id: number; target_type: string; target_id: number; body: string; timecode: number | null;
  sequence_id: string | null; frame: number | null; resolved: boolean; created_at: string; mentions: number[];
  user: { id: number; name: string; email: string; role: string } | null;
}

export interface EpisodeScene { id: number; title: string; emotion: string; summary: string; shot_codes: string[] }

export interface AiJob {
  id: number; type: string; status: "queued" | "running" | "awaiting_approval" | "succeeded" | "failed" | "cancelled" | string;
  progress: number; message: string; error: string; label: string; batch_id: string; cost_estimate: number; cost_actual: number;
  tool: ToolId; result: AiResult; created_at: string | null; finished_at: string | null;
}

export interface UploadedAsset {
  key: string; url?: string; kind?: "video" | "audio" | "image"; duration?: number; has_audio?: boolean;
  width?: number; height?: number;
}

export interface ToolStatus { id: ToolId; label: string; group: string; provider: string; mode: "live" | "mock" | "missing"; ready: boolean }
export interface ToolsInfo { tools: ToolStatus[]; languages: { code: string; name: string }[]; google_first: boolean }

export interface VoiceRef { provider?: string; voice_id?: string; profile_id?: number }
export interface VoicesInfo {
  default: { provider: string; voice_id: string };
  studio: { provider: string; voice_id: string; profile_id: number; language: string; name: string; source: string }[];
  providers: { provider: string; mode: string; voices: { voice_id: string; name: string; description: string }[] }[];
}

// ── the edit assistant's commands (times in seconds on the sequence; core/edit_ai.py) ─────────────

export type AiCommand =
  | { op: "trim_to_duration"; seconds: number }
  | { op: "add_markers"; markers: { at: number; name: string; color: string; comment: string }[] }
  | { op: "remove_range"; start: number; end: number; ripple: boolean; track_ids: string[] }
  | { op: "split_at"; at: number; track_ids: string[] }
  | { op: "move_clip"; clip_id: string; to: number; track_id: string }
  | { op: "delete_clip"; clip_id: string; ripple: boolean }
  | { op: "set_speed"; clip_id: string; speed: number }
  | { op: "set_volume"; clip_id: string; gain_db: number }
  | { op: "add_title"; text: string; at: number; duration: number; position: "top" | "center" | "lower_third" | "bottom"; size: number }
  | { op: "add_transition"; clip_id: string; edge: "in" | "out"; type: string; duration: number }
  | { op: "set_effect"; clip_id: string; effect: string; params: Record<string, number | string | boolean> }
  | { op: "add_music"; prompt: string; start: number; end: number; volume_db: number }
  | { op: "add_captions"; clip_ids: string[]; language: string; words: boolean };

export type AiCommandRow = AiCommand & { id: string; summary: string; paid: boolean };

/** What the assistant is told about the sequence (core/edit_ai.Digest). */
export interface Digest {
  name: string; fps: number; width: number; height: number; duration: number; playhead: number;
  in_point: number | null; out_point: number | null;
  tracks: { id: string; kind: "video" | "audio"; name: string; locked: boolean }[];
  clips: { id: string; track_id: string; start: number; end: number; name: string; kind: string; media_kind: string; has_audio: boolean; text: string }[];
  markers: { at: number; name: string }[];
  selection: string[]; effects: string[]; transitions: string[];
}
