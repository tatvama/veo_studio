/** Auto edit (docs/EDITOR.md §13.3): the pure planner, the executor and the five styles. */
export { describePlan, orderMedia, planAutoEdit, prettyName, takeQuality } from "./planner.ts";
export { buildAutoEdit, type BuildOptions, type BuildResult } from "./executor.ts";
export { formatSize, STYLES, styleById, type StyleDef } from "./styles.ts";
export type { AutoEditOptions, Format, MediaAnalysis, OrderChoice, Plan, PlanMedia, PlanSegment, TransitionsChoice } from "./types.ts";
