/**
 * Auto SFX (docs/EDITOR.md §15.2): sound effects placed where the edit calls for them. The planner and the builder
 * are pure (tests); applying renders the sounds with the SFX engine (editor/sfx) and places them as one undo step.
 * Mount <AutoSfxDialog /> (autosfx/AutoSfxDialog.tsx) in the editor; openAutoSfx() opens it from a menu.
 */
export { describeAutoSfx, hash32, INTENSITY_DB, MIN_GAP_S, planAutoSfx, resolveRange, ruleIds, ruleInfo, RULES, SPEECH_DUCK_DB, speechFromClips, type RuleInfo } from "./planner.ts";
export { buildAutoSfx, isAutoSfx, removeAutoSfx, sfxKey, sfxLanes, SFX_TRACK } from "./build.ts";
export { applyAutoSfx, clearSfxCache, projectHost, removeAutoSfxCommand, runAutoSfx, type ApplyOptions, type ApplyResult } from "./apply.ts";
export { findEvents, titleTiming, transitionKind, type SfxEvent, type SfxPart } from "./events.ts";
export type { AutoSfxOptions, AutoSfxPlan, FrameRange, SfxIntensity, SfxPlacement, SfxRule, SfxSkipped } from "./types.ts";

export const AUTO_SFX_EVENT = "ed:auto-sfx";
/** Opens the Auto SFX dialog (mounted by the editor). `remove` asks to remove the auto sound effects instead. */
export function openAutoSfx(o: { remove?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent(AUTO_SFX_EVENT, { detail: o }));
}
