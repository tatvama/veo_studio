/**
 * Problems you can act on (pages/project/problems.ts): the last run's problems and the shots' failed steps merged into
 * one list, each with the fix its words call for; and the run's problems put on the canvas's dots.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionOf, collectFixes, kindOf, stepAction, withRunProblems, type RunProblem, type StepFailure, type StepKind,
} from "../../pages/project/problems.ts";

const run = (over: Partial<RunProblem>): RunProblem => ({ shot: "E01-SH01", shot_id: 1, step: "Videos", reason: "It failed", next: "", ...over });
const codes = new Map([[1, "E01-SH01"], [2, "E01-SH02"], [3, "E01-SH03"]]);

test("the fix: the backend's when it says, else read from the words (older runs)", () => {
  assert.equal(actionOf(run({ action: "voice" })), "voice");
  assert.equal(actionOf(run({ action: "" })), "");
  // older runs had no action: a safety block → another engine, the budget and a skipped export → carry on
  assert.equal(actionOf(run({ reason: "A safety filter blocked it: weapons", next: "Soften it, or try another engine" })), "engine");
  assert.equal(actionOf(run({ shot_id: null, shot: "", step: "budget", reason: "Stopped at your budget: press Produce all to continue" })), "continue");
  assert.equal(actionOf(run({ shot_id: null, shot: "", step: "export", reason: "Export skipped: 1 shot has no video" })), "continue");
  assert.equal(actionOf(run({ step: "Voices first", reason: "It took too long", next: "Run it again" })), "voice");
  assert.equal(actionOf(run({ step: "Keyframes", reason: "It took too long", next: "Run it again" })), "retry");
  assert.equal(actionOf(run({ step: "QC", reason: "The line has 30 words", next: "Split the shot" })), "open");
  assert.equal(actionOf(run({ shot_id: null, shot: "", step: "Continuity", reason: "Couldn't write the end states" })), "");
  assert.equal(kindOf(run({ kind: "mouth", step: "Voices & lip-sync" })), "mouth");
  assert.equal(kindOf(run({ step: "Voices & lip-sync" })), "mouth");
  assert.equal(kindOf(run({ shot_id: null, step: "Videos" })), null);
  assert.equal(kindOf(run({ step: "Voices first", kind: "" })), null);  // the backend says: none of the shot's steps
  const blocked: StepFailure = { job_id: 4, error: "Blocked by safety filter: Veo blocked it", at: null };
  assert.equal(stepAction("video", blocked), "engine");
  assert.equal(stepAction("video", { ...blocked, error: "timed out" }), "retry");
  assert.equal(stepAction("voice", { ...blocked, error: "timed out" }), "voice");
});

test("one list: the run's problems first, then failed steps it didn't list (each shot and step once)", () => {
  const list = collectFixes([
    run({ shot_id: 1, kind: "video", action: "engine", job_id: 9 }),
    run({ shot_id: null, shot: "", step: "budget", reason: "Stopped at your budget", action: "continue" }),
    run({ shot_id: 3, kind: "picture", action: "retry" }),
  ], {
    1: { problems: { video: { job_id: 9, error: "Blocked by safety filter: x", at: null, reason: "A safety filter blocked it", blocked: true } } },
    2: { problems: { voice: { job_id: 11, error: "timed out", at: null, reason: "It took too long", next: "Run it again" } } },
    3: { problems: {} },
  }, codes);
  assert.deepEqual(list.map((x) => [x.shotId, x.kind, x.action, x.engine, x.from]), [
    [1, "video", "engine", true, "run"], [null, null, "continue", false, "run"], [3, "picture", "retry", false, "run"],
    [2, "voice", "voice", false, "step"],
  ]);
  assert.equal(list[3].code, "E01-SH02");
  assert.equal(list[3].reason, "It took too long");
  // a shot left out of the cut is left out here too; no problems: an empty list
  const cut = collectFixes([run({ shot_id: 3, kind: "picture" })], undefined, codes, new Set([1, 2]));
  assert.deepEqual(cut, []);
  assert.deepEqual(collectFixes(undefined, undefined, codes), []);
});

test("the run's problems go on the canvas's dots; other words about a shot become its notes", () => {
  type S = { voice: string; problems: Partial<Record<StepKind, StepFailure>>; notes?: { reason: string; next: string; action?: string }[] };
  const shots: Record<string, S> = {
    1: { voice: "need", problems: {} },
    2: { voice: "need", problems: { video: { job_id: 5, error: "own failure", at: null } } },
    3: { voice: "need", problems: {} },
  };
  const out = withRunProblems(shots, [
    run({ shot_id: 1, kind: "video", action: "engine", job_id: 7, reason: "A safety filter blocked it", next: "Try another engine" }),
    run({ shot_id: 2, kind: "video", job_id: 8, reason: "the run's words" }),
    run({ shot_id: 1, step: "Voices first", reason: "The lines run 9 s", next: "Split the shot", action: "open", kind: "" }),
    run({ shot_id: null, shot: "", step: "budget", reason: "Stopped at your budget" }),
  ]);
  assert.deepEqual(out[1].problems.video, { job_id: 7, error: "A safety filter blocked it", at: null, reason: "A safety filter blocked it",
    next: "Try another engine", blocked: true });
  assert.equal(out[2].problems.video?.error, "own failure");  // its own failure stays
  assert.deepEqual(out[1].notes, [{ reason: "The lines run 9 s", next: "Split the shot", action: "open" }]);
  assert.equal(out[3], shots[3]);  // untouched shots keep their object (memoised nodes don't redraw)
  assert.equal(withRunProblems(shots, []), shots);
});
