/**
 * Problems you can act on, as plain logic (no React, no imports with side effects, so `node --test` runs it as is):
 * the last run's problems (GET /api/episodes/{eid}/canvas → run_problems, backend core/problems.py) and the shots' failed
 * steps that nothing has replaced since (the same answer's per-shot `problems`), merged into one list, each with the
 * one-click fix that matches what it says to do next. Tests: src/lib/__tests__/problems.test.ts.
 */

/** The five steps of a shot (the canvas dots, canvas/model.ts StepId). */
export type StepKind = "picture" | "video" | "voice" | "mouth" | "sound";

/**
 * The one-click fix: retry (make that step again, its price first) · engine (try another video engine for the shot) ·
 * voice (make the missing voice) · open (open the shot: something to change by hand) · continue (press Make it for me
 * again: a budget stop, a skipped export, a cast picture or the music that failed) · "" (nothing to press).
 */
export type FixAction = "retry" | "engine" | "voice" | "open" | "continue" | "";

/** One problem of the last run, as the backend keeps it (older runs have no action, kind or job_id). */
export interface RunProblem {
  shot: string; shot_id: number | null; step: string; reason: string; next: string;
  action?: FixAction; kind?: StepKind | ""; job_id?: number | null;
}

/** A shot's failed step (GET /canvas → shots[id].problems[step]). */
export interface StepFailure { job_id: number; error: string; at: string | null; reason?: string; next?: string; blocked?: boolean }

/** One row of the problem list. */
export interface FixItem {
  key: string;
  shotId: number | null;
  code: string;
  /** The step it is about, when it is one of the shot's five steps. */
  kind: StepKind | null;
  /** Where it happened, in the run's words ("Videos", "budget", "export"…). */
  step: string;
  reason: string;
  next: string;
  action: FixAction;
  /** Offer "Try another engine" too (a failed or blocked video). */
  engine: boolean;
  from: "run" | "step";
}

const KINDS: readonly StepKind[] = ["picture", "video", "voice", "mouth", "sound"];
const isKind = (k: unknown): k is StepKind => typeof k === "string" && (KINDS as readonly string[]).includes(k);

/**
 * The step a run problem is about: its kind ("" = none of the shot's steps, e.g. a line too long for one clip); older
 * runs have none, so it is read from the run's step name ("Videos", "Keyframes"…).
 */
export function kindOf(p: RunProblem): StepKind | null {
  if (p.kind !== undefined) return isKind(p.kind) ? p.kind : null;
  if (!p.shot_id) return null;
  const s = p.step.toLowerCase();
  if (s.includes("keyframe") || s.includes("picture")) return "picture";
  if (s.includes("video")) return "video";
  if (s.includes("lip") || s.includes("mouth")) return "mouth";
  if (s.includes("voice")) return "voice";
  if (s.includes("sound")) return "sound";
  return null;
}

/** The fix of a run problem: the backend's when it says, else read from its words (older runs). */
export function actionOf(p: RunProblem): FixAction {
  if (p.action !== undefined && (["retry", "engine", "voice", "open", "continue", ""] as string[]).includes(p.action)) return p.action;
  const said = `${p.reason} ${p.next}`.toLowerCase();
  if (p.step === "budget" || p.step === "export" || said.includes("produce all again") || said.includes("press produce all")) return "continue";
  if (!p.shot_id) return "";
  if (said.includes("safety filter") || said.includes("another engine")) return "engine";
  const k = kindOf(p);
  if (k === "voice") return "voice";
  if (k && (said.includes("run it again") || said.includes("make it again"))) return "retry";
  return "open";
}

/** The fix of a shot's failed step. */
export function stepAction(kind: StepKind, f: StepFailure): FixAction {
  if (kind === "video" && (f.blocked || /^blocked by safety filter/i.test(f.error))) return "engine";
  return kind === "voice" ? "voice" : "retry";
}

/**
 * The last run's problems, then the shots' failed steps the run didn't already list (the same shot and step once),
 * in that order. `codes` names shots by id; `included` (when given) leaves out shots not in the cut.
 */
export function collectFixes(run: readonly RunProblem[] | undefined,
  steps: Record<string, { problems?: Partial<Record<StepKind, StepFailure>> }> | undefined,
  codes: ReadonlyMap<number, string>, included?: ReadonlySet<number>): FixItem[] {
  const out: FixItem[] = [];
  const seen = new Set<string>();
  (run ?? []).forEach((p, i) => {
    if (p.shot_id && included && !included.has(p.shot_id)) return;
    const kind = kindOf(p);
    const action = actionOf(p);
    if (p.shot_id && kind) seen.add(`${p.shot_id}:${kind}`);
    out.push({ key: `run-${i}-${p.shot_id ?? "x"}-${p.job_id ?? ""}`, shotId: p.shot_id ?? null, code: p.shot || (p.shot_id ? codes.get(p.shot_id) ?? "" : ""),
      kind, step: p.step, reason: p.reason, next: p.next, action, engine: !!p.shot_id && (kind === "video" || action === "engine"), from: "run" });
  });
  for (const [id, info] of Object.entries(steps ?? {})) {
    const shotId = Number(id);
    if (included && !included.has(shotId)) continue;
    for (const kind of KINDS) {
      const f = info.problems?.[kind];
      if (!f || seen.has(`${shotId}:${kind}`)) continue;
      seen.add(`${shotId}:${kind}`);
      const action = stepAction(kind, f);
      out.push({ key: `step-${shotId}-${kind}`, shotId, code: codes.get(shotId) ?? "", kind, step: kind,
        reason: f.reason || f.error, next: f.next || "", action, engine: kind === "video", from: "step" });
    }
  }
  return out;
}

interface ShotSteps {
  problems: Partial<Record<StepKind, StepFailure>>;
  notes?: { reason: string; next: string; action?: string }[];
}

/**
 * The canvas's shots with the last run's problems put on them: a problem about one of a shot's steps shows as that
 * step failed (unless a failure of its own is there), with the run's words; any other problem of the shot is a note.
 * Shots without one keep their object (so memoised nodes don't redraw).
 */
export function withRunProblems<T extends ShotSteps>(shots: Record<string, T> | undefined, run: readonly RunProblem[] | undefined): Record<string, T> {
  const base = shots ?? {};
  if (!run?.length) return base;
  const out: Record<string, T> = { ...base };
  for (const p of run) {
    if (!p.shot_id) continue;
    const cur = out[String(p.shot_id)];
    if (!cur) continue;
    const kind = kindOf(p);
    if (kind) {
      if (cur.problems[kind]) continue;
      const action = actionOf(p);
      out[String(p.shot_id)] = { ...cur, problems: { ...cur.problems, [kind]: { job_id: p.job_id ?? 0, error: p.reason, at: null, reason: p.reason,
        next: p.next, blocked: action === "engine" } } };
    } else {
      out[String(p.shot_id)] = { ...cur, notes: [...(cur.notes ?? []), { reason: p.reason, next: p.next, action: actionOf(p) }] };
    }
  }
  return out;
}

/** "Open this shot" from the Next bar or the Overview (detail: { shotId }): the canvas opens it over itself and cancels
 * the event; when nobody does, the Grid view's shot panel opens it. */
export const OPEN_SHOT_EVENT = "tatvam:open-shot";

/** The button that fixes it, in plain words (keys for t()). */
export const FIX_LABEL: Record<Exclude<FixAction, "">, string> = {
  retry: "Retry", engine: "Try another engine", voice: "Make the voice", open: "Open the shot", continue: "Make it for me",
};

/** "1 problem" / "3 problems" (keys for t()). */
export const problemCountLabel = (n: number) => (n === 1 ? "1 problem" : "{n} problems");
