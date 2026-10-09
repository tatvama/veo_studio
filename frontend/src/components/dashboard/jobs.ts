import { tr } from "../../lib/i18n";

/** Human names for the job types the backend can create. */
export function jobName(type: unknown): string {
  const key = String(type ?? "");
  const map: Record<string, string> = {
    keyframe: tr("Keyframe"), video: tr("Video"), qc: tr("QC review"), voice: tr("Voice"), lipsync: tr("Lip-sync"), voicelock: tr("Voice lock"),
    music: tr("Music"), sfx: tr("Sound effects"), character_sheet: tr("Character sheet"), character_outfit: tr("Outfit"),
    character_expressions: tr("Expressions"), location_images: tr("Location images"), voice_design: tr("Voice design"),
    voice_preview: tr("Voice preview"), omni_edit: tr("Omni edit"), animatic: tr("Animatic"), export: tr("Export"), dub: tr("Dub episode"),
    autopilot: tr("Autopilot"), marketing: tr("Marketing pack"), search_index: tr("Search index"), publish_youtube: tr("YouTube upload"),
    fetch_metrics: tr("YouTube analytics"), train_identity: tr("Identity training"), narration: tr("Narration"), extend: tr("Extension"),
    table_read: tr("Table read"), thumbnail: tr("Thumbnails"), shootout: tr("Shootout"), location_plate: tr("Location plates"), edit: tr("Edit"),
  };
  return map[key] ?? (key ? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : tr("Job"));
}

/** Job types that make or change a take of a shot. */
export const TAKE_JOBS = new Set(["keyframe", "video", "voice", "lipsync", "voicelock", "narration", "qc", "extend", "omni_edit", "edit"]);
