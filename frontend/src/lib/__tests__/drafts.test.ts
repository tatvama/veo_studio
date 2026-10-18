/**
 * "Quick draft first" and recipes (pages/project/drafts.ts): where the film stands after a draft run, the final film's
 * body, and Make it for me's choices as a body and as a recipe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_STEPS, choicesOf, draftState, FINAL_BODY, finalIsNext, produceBody, sameChoices, type MakeChoices } from "../../pages/project/drafts.ts";

const draft = { params: { draft: true } };
const final = { params: { engine: "google:video_saver" } };

test("after a draft run the final film is next; not before every shot has a clip, nor once all are final", () => {
  assert.deepEqual(draftState([{ video: draft }, { video: final }, { video: null }, { include: false, video: null }]),
    { drafts: 1, finals: 1, missing: 1, total: 3 });
  assert.equal(finalIsNext([{ video: draft }, { video: final }]), true);
  assert.equal(finalIsNext([{ video: draft }, { video: null }]), false);  // a shot with no clip: Make it for me first
  assert.equal(finalIsNext([{ video: final }, { video: final }]), false);
  assert.equal(finalIsNext([]), false);
  // the final film runs every step at full quality (no draft flag: the drafts are remade as finished clips)
  assert.deepEqual([...FINAL_BODY.steps], [...ALL_STEPS]);
  assert.equal("draft" in FINAL_BODY, false);
});

const choices = (over: Partial<MakeChoices> = {}): MakeChoices => ({
  steps: ["cast", "keyframes", "videos", "extend", "voices", "export"], quality: null, draft: false, review_looks: true,
  link_scenes: "auto", music_per_scene: true, ...over,
});

test("the produce body: a draft drops the longer clips, the cast check only with the cast step", () => {
  assert.deepEqual(produceBody(choices({ draft: true, quality: "hero" })), {
    action: "produce", steps: ["cast", "keyframes", "videos", "voices", "export"], quality: "hero", review_looks: true,
    link_scenes: "auto", music_per_scene: true, draft: true,
  });
  const plain = produceBody(choices({ steps: ["videos", "extend"], review_looks: true }))!;
  assert.deepEqual(plain.steps, ["videos", "extend"]);
  assert.equal(plain.review_looks, false);
  assert.equal("draft" in plain, false);
  assert.equal("draft" in produceBody(choices({ steps: ["cast"], draft: true }))!, false);  // nothing to draft
  assert.equal(produceBody(choices({ steps: [] })), null);
  assert.equal(produceBody(choices({ steps: ["extend"], draft: true })), null);
});

test("recipes: cleaned choices, and a chip lights only for the same choices", () => {
  const c = choicesOf({ steps: ["export", "videos", "bogus" as never], quality: "", link_scenes: "never", music_per_scene: false });
  assert.deepEqual(c, { steps: ["videos", "export"], quality: null, draft: false, review_looks: false, link_scenes: "never", music_per_scene: false });
  assert.equal(sameChoices(choices(), { ...choices(), steps: ["export", "voices", "extend", "videos", "keyframes", "cast"] }), true);
  assert.equal(sameChoices(choices(), choices({ draft: true })), false);
  assert.equal(sameChoices(choices(), choices({ quality: "hero" })), false);
});
