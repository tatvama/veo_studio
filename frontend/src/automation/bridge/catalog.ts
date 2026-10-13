/**
 * The assistant tools' share of the §15 additions (docs/EDITOR.md §13.2, §15), pure so the tests run them as they are:
 * - list_catalog rows for `looks` (the moods and the 30 look-pack looks), `audio_presets` (the audio chain presets,
 *   as the `preset:<id>` add_effect takes) and `sfx` (the sound effects library with its tags and categories);
 * - which sound add_sfx places: a preset id, or a tag (the seed picks among the sounds that have it);
 * - a mood or a look-pack look by id (apply_mood);
 * - an audio chain preset's effects on audio clips (add_effect "preset:<id>"), and one library sound placed on the SFX
 *   track (add_sfx): each one undo step.
 * The editor window's tools.ts runs them on the open edit.
 */
import { CHAIN_PRESETS, type ChainPreset } from "../../editor/audiofx/registry.ts";
import { makeAudioFx } from "../../editor/audiofx/stack.ts";
import { updateClips, type Ctx } from "../../editor/model/ops.ts";
import type { EditorHost, EffectInstance, MediaItem, Sequence } from "../../editor/model/types.ts";
import { lookById, LOOK_PACKS, LOOKS, type LookDef } from "../../editor/moods/packs/looks.ts";
import { DEFAULT_SEED, placeSfx, prepareSfxMedia, SFX_CATEGORIES, SFX_PRESETS, SFX_TAGS, sfxPreset, type SfxPreset } from "../../editor/sfx/index.ts";
import { moodById, MOODS, type MoodDef } from "../../lib/moods.ts";

export interface CatalogRow { id: string; label: string; group?: string; params?: string; tags?: string[] }
export type NewCatalogKind = "looks" | "audio_presets" | "sfx";
export const NEW_CATALOG_KINDS: NewCatalogKind[] = ["looks", "audio_presets", "sfx"];
/** add_effect's id for a chain preset. */
export const CHAIN_PREFIX = "preset:";

const packLabel = (id: string) => LOOK_PACKS.find((p) => p.id === id)?.label ?? id;
const categoryLabel = (id: string) => SFX_CATEGORIES.find((c) => c.id === id)?.label ?? id;

/** The rows of one of the new kinds that match `q` (lower case; "" = all), in catalogue order. */
export function catalogRows(kind: NewCatalogKind, q = ""): CatalogRow[] {
  const hit = (...xs: (string | undefined)[]) => !q || xs.some((x) => (x ?? "").toLowerCase().includes(q));
  if (kind === "looks") {
    return [
      ...MOODS.filter((m) => hit(m.id, m.label, m.blurb, "mood")).map((m): CatalogRow => ({ id: m.id, label: m.label, group: `Mood · ${m.blurb}` })),
      ...LOOKS.filter((l) => hit(l.id, l.label, l.blurb, l.pack, packLabel(l.pack))).map((l): CatalogRow => ({ id: l.id, label: l.label, group: `${packLabel(l.pack)} look pack · ${l.blurb}` })),
    ];
  }
  if (kind === "audio_presets") {
    return CHAIN_PRESETS.filter((p) => hit(p.id, p.name, p.group)).map((p) => ({ id: `${CHAIN_PREFIX}${p.id}`, label: p.name, group: p.group, params: p.effects.map((e) => e.id).join(" → ") }));
  }
  return SFX_PRESETS.filter((p) => hit(p.id, p.name, p.category, categoryLabel(p.category), ...p.tags))
    .map((p) => ({ id: p.id, label: p.name, group: categoryLabel(p.category), tags: [...p.tags], params: `${Math.round(p.duration * 100) / 100} s${p.loop ? ", loops" : ""}` }));
}

/** One catalogue line for a model: "id — label [group] (params) {tags}". */
export const catalogLine = (r: CatalogRow) => `${r.id} — ${r.label}${r.group ? ` [${r.group}]` : ""}${r.params ? ` (${r.params})` : ""}${r.tags?.length ? ` {${r.tags.join(", ")}}` : ""}`;

/**
 * The sound add_sfx places: `preset` (an id), else the sounds tagged `tag` (the first, or with a seed the seed-th of
 * them, wrapping). The seed is also the sound's own variation (default 1, the library's).
 */
export function pickSfx(preset?: string, tag?: string, seed?: number): { preset: SfxPreset; seed: number; among: number } {
  const s = seed === undefined || !Number.isFinite(seed) ? DEFAULT_SEED : Math.trunc(seed) >>> 0;
  if (preset) {
    const p = sfxPreset(preset);
    if (!p) throw new Error(`No sound effect ${preset}: list_catalog(sfx) lists them`);
    return { preset: p, seed: s, among: 1 };
  }
  if (!tag) throw new Error("Give preset (a sound id from list_catalog(sfx)) or tag");
  const t = tag.trim().toLowerCase();
  if (!(SFX_TAGS as readonly string[]).includes(t)) throw new Error(`No tag ${tag} (tags: ${SFX_TAGS.join(", ")})`);
  const all = SFX_PRESETS.filter((p) => p.tags.includes(t));
  if (!all.length) throw new Error(`No sound has the tag ${tag}`);
  return { preset: all[seed === undefined ? 0 : s % all.length], seed: s, among: all.length };
}

/** A mood (lib/moods.ts) or a look-pack look ("cinematic.teal_orange", also "look.cinematic.teal_orange"). */
export function moodOrLook(id: string): { mood: MoodDef; look?: undefined } | { mood?: undefined; look: LookDef } | null {
  const mood = moodById(id);
  if (mood) return { mood };
  const look = lookById(id);
  return look ? { look } : null;
}

/** The chain preset of "preset:<id>" (or a bare id). */
export function chainPreset(id: string): ChainPreset {
  const bare = id.startsWith(CHAIN_PREFIX) ? id.slice(CHAIN_PREFIX.length) : id;
  const p = CHAIN_PRESETS.find((x) => x.id === bare);
  if (!p) throw new Error(`No audio chain preset ${id}: list_catalog(audio_presets) lists them (${CHAIN_PRESETS.slice(0, 6).map((x) => `${CHAIN_PREFIX}${x.id}`).join(", ")} …)`);
  return p;
}

/** A chain preset's effects in order, new instances (new ids) for one clip. */
export const chainEffects = (p: ChainPreset): EffectInstance[] => p.effects.map((e) => makeAudioFx(e.id, e.values));

/** The chain's effects after each clip's own (the caller keeps it to audio clips); clip id → the new effect ids. */
export function addChainPreset(seq: Sequence, ctx: Ctx, clipIds: string[], p: ChainPreset): { seq: Sequence; made: Map<string, string[]> } {
  const made = new Map<string, string[]>();
  const out = updateClips(seq, ctx, clipIds, (x) => {
    const es = chainEffects(p);
    made.set(x.id, es.map((e) => e.id));
    return { ...x, effects: [...x.effects, ...es] };
  });
  return { seq: out, made };
}

/**
 * add_sfx: the sound rendered and saved into the edit (prepareSfxMedia, nothing changed yet), then placed on an SFX
 * track at `at` (sequence frames) with its media and bin in ONE undo step (placeSfx). "" clip id: nothing placed.
 */
export async function addLibrarySfx(host: EditorHost, o: { preset?: string; tag?: string; seed?: number; at: number; gainDb?: number; label: string }):
  Promise<{ clipId: string; item: MediaItem; pick: ReturnType<typeof pickSfx> }> {
  const pick = pickSfx(o.preset, o.tag, o.seed);
  const item = await prepareSfxMedia(host, pick.preset.id, {}, pick.seed);
  const clipId = placeSfx(host, item, { at: o.at, gainDb: o.gainDb, name: pick.preset.name, label: o.label });
  return { clipId, item, pick };
}
