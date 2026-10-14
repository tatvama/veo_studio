/**
 * The recorded sound effects (Kenney's CC0 packs, docs/EDITOR.md §15) next to the procedural library: lookups over
 * the generated manifest (recorded.ts), the bundled files' public URLs, the names they are saved under in the edit,
 * their categories (the procedural ones they share, then the recorded-only collections) and how they are credited.
 * Pure and Node-safe.
 */
import { SFX_CATEGORIES } from "./engine.ts";
import {
  RECORDED_COLLECTIONS, RECORDED_PACKS, RECORDED_SFX, type RecordedCategory, type RecordedPack, type RecordedPackId, type RecordedSfx,
} from "./recorded.ts";

export {
  RECORDED_COLLECTIONS, RECORDED_MAX_FILE_BYTES, RECORDED_MAX_TOTAL_BYTES, RECORDED_MAX_TRUE_PEAK, RECORDED_PACKS, RECORDED_SFX, RECORDED_TARGET_LUFS,
  type RecordedCategory, type RecordedCollection, type RecordedPack, type RecordedPackId, type RecordedSfx,
} from "./recorded.ts";

/** Every recorded sound's id starts with this ("rec.<pack>.<file>"). */
export const RECORDED_PREFIX = "rec.";
/** Where the bundled files are served (frontend/public/sfx/recorded/). */
export const RECORDED_BASE = "/sfx/recorded/";
export const RECORDED_SOURCE_LABEL = "Recorded (Kenney CC0)";

const BY_ID = new Map(RECORDED_SFX.map((r) => [r.id, r]));
const PACK_BY_ID = new Map(RECORDED_PACKS.map((p) => [p.id, p]));

export const isRecordedId = (id: string): boolean => id.startsWith(RECORDED_PREFIX);
export const recordedSfx = (id: string): RecordedSfx | undefined => BY_ID.get(id);
export const recordedPack = (id: RecordedPackId): RecordedPack => PACK_BY_ID.get(id)!;

/** The bundled file's URL on the page's own origin. */
export const recordedUrl = (r: Pick<RecordedSfx, "pack" | "file">): string => `${RECORDED_BASE}${r.pack}/${r.file}`;

/** The name a recorded sound is saved under in `<edit>\Audio\SFX\`: "<id>.<ext>" (e.g. rec.impact.impactsoft_heavy_000.ogg). */
export function recordedFileName(r: Pick<RecordedSfx, "id" | "file">): string {
  const dot = r.file.lastIndexOf(".");
  return `${r.id}${dot >= 0 ? r.file.slice(dot).toLowerCase() : ".ogg"}`;
}

/** The categories recorded sounds are in: the procedural ones first (in their order), then the recorded-only ones. */
export const RECORDED_CATEGORIES: { id: RecordedCategory; label: string }[] = [...SFX_CATEGORIES, ...RECORDED_COLLECTIONS]
  .filter((c) => RECORDED_SFX.some((r) => r.category === c.id));
const CAT_LABEL = new Map<string, string>([...SFX_CATEGORIES, ...RECORDED_COLLECTIONS].map((c) => [c.id, c.label]));
export const recordedCategoryLabel = (id: string): string => CAT_LABEL.get(id) ?? id;

/** "Kenney · Impact Sounds (CC0)": the credit line under a recorded sound. */
export const recordedCredit = (r: Pick<RecordedSfx, "pack">): string => `Kenney · ${recordedPack(r.pack).label} (CC0)`;

/** The media comment of a saved recorded sound: where it's from, its licence, its loudness and the gain it gets. */
export function recordedComment(r: RecordedSfx): string {
  const p = recordedPack(r.pack);
  return `Recorded sound effect ${r.id}: "${r.file}" from ${p.label} by Kenney (kenney.nl, ${p.url}), CC0 1.0. `
    + `${r.lufs} LUFS, true peak ${r.truePeak} dBTP; clip gain ${r.gainDb >= 0 ? "+" : ""}${r.gainDb} dB brings it to −16 LUFS (true peak ≤ −1 dBTP)`;
}

/** The clip gain of a recorded sound for a level relative to the library's −16 LUFS (`relDb` 0: the sound's own gainDb). */
export const recordedGain = (r: Pick<RecordedSfx, "gainDb">, relDb = 0): number => Math.round((r.gainDb + relDb) * 10) / 10;
