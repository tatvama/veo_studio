/**
 * "Quick draft first" and recipes, as plain logic (no React, no imports, so `node --test` runs it as is): where the
 * film stands after a draft run, the body of "Make the final film", and Make it for me's choices as a recipe and back.
 * Tests: src/lib/__tests__/drafts.test.ts.
 */

/** The produce steps, in the order the backend runs them (core/generation.PRODUCE_STEPS). */
export const ALL_STEPS = ["cast", "keyframes", "videos", "extend", "voices", "sound", "music", "export"] as const;
export type Step = (typeof ALL_STEPS)[number];

interface ShotLike { include?: boolean; video?: { params?: Record<string, unknown> | null } | null }

/** Where the shots in the cut stand: clips that are 480p drafts, clips that are final, and shots with no clip. */
export function draftState(shots: readonly ShotLike[]): { drafts: number; finals: number; missing: number; total: number } {
  const cut = shots.filter((s) => s.include !== false);
  const drafts = cut.filter((s) => !!s.video && !!s.video.params?.draft).length;
  const finals = cut.filter((s) => !!s.video && !s.video.params?.draft).length;
  return { drafts, finals, missing: cut.length - drafts - finals, total: cut.length };
}

/** A draft run is done and the final film is next: every shot has a clip and some are 480p drafts. */
export const finalIsNext = (shots: readonly ShotLike[]) => {
  const s = draftState(shots);
  return s.total > 0 && s.missing === 0 && s.drafts > 0;
};

/** "Make the final film": everything, at full quality; the drafts are remade as finished clips (nothing else twice). */
export const FINAL_BODY = { action: "produce", steps: [...ALL_STEPS], link_scenes: "auto", music_per_scene: true } as const;

/** Make it for me's choices (what a recipe keeps). */
export interface MakeChoices {
  steps: Step[]; quality: string | null; draft: boolean; review_looks: boolean; link_scenes: "auto" | "never"; music_per_scene: boolean;
}

/** A recipe as GET /api/recipes returns it. */
export interface Recipe extends MakeChoices { id: string; name: string; builtin: boolean; about?: string; by?: string }

/** The produce body for these choices (POST /episodes/{eid}/estimate and /generate). A draft skips the longer clips. */
export function produceBody(c: MakeChoices): Record<string, unknown> | null {
  const steps = ALL_STEPS.filter((s) => c.steps.includes(s) && !(c.draft && s === "extend"));
  if (!steps.length) return null;
  return {
    action: "produce", steps, quality: c.quality || null, review_looks: c.review_looks && steps.includes("cast"),
    link_scenes: c.link_scenes, music_per_scene: c.music_per_scene, ...(c.draft && steps.includes("videos") ? { draft: true } : {}),
  };
}

/** The recipe's choices, cleaned (unknown steps dropped, in run order). */
export function choicesOf(r: Partial<MakeChoices>): MakeChoices {
  return {
    steps: ALL_STEPS.filter((s) => (r.steps ?? []).includes(s)), quality: r.quality || null, draft: !!r.draft,
    review_looks: !!r.review_looks, link_scenes: r.link_scenes === "never" ? "never" : "auto", music_per_scene: r.music_per_scene !== false,
  };
}

/** Whether the dialog's choices are this recipe's (its chip is lit). */
export function sameChoices(a: MakeChoices, b: MakeChoices): boolean {
  const x = choicesOf(a);
  const y = choicesOf(b);
  return x.steps.join() === y.steps.join() && x.quality === y.quality && x.draft === y.draft && x.review_looks === y.review_looks
    && x.link_scenes === y.link_scenes && x.music_per_scene === y.music_per_scene;
}
