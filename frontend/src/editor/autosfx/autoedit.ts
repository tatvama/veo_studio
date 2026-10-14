/**
 * Auto SFX in the editor's flows (docs/EDITOR.md §15.2): auto edit's "Add sound effects" (the sounds go onto the new
 * sequence before it is committed, so auto edit plus its sounds is ONE undo step) and the helpers the dialog and the
 * assistant tool share (speech from the silence analysis, preview URLs for the new sounds).
 */
import type { EditProject, MediaItem } from "../model/types";
import { resolveUrls } from "../session";
import { applyAutoSfx, projectHost, type ApplyResult } from "./apply";
import { planAutoSfx } from "./planner";
import { speechRanges } from "./speech";
import type { AutoSfxPlan, SfxIntensity } from "./types";

/** The editor resolves the gateway URLs of the sounds it just got. */
export const resolveSfxUrls = (items: MediaItem[]) => { void resolveUrls(items); };

/** A built project with auto SFX on one of its sequences (nothing committed: the caller makes it one command). */
export async function withAutoSfx(project: EditProject, editPath: string, sequenceId: string, intensity: SfxIntensity):
  Promise<{ project: EditProject; plan: AutoSfxPlan; result: ApplyResult; media: MediaItem[] }> {
  const host = projectHost(project, editPath, { sequenceId });
  const speech = await speechRanges(host).catch(() => undefined);
  const plan = planAutoSfx(host.sequence(), host.project(), { intensity, speech });
  const media: MediaItem[] = [];
  const result = await applyAutoSfx(host, plan, { label: "Auto SFX", onMedia: (m) => media.push(...m) });
  // keep the caller's active sequence
  return { project: { ...host.current(), activeSequenceId: project.activeSequenceId }, plan, result, media };
}
