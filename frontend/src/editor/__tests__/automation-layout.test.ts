/**
 * The assistant's caption layout (automation/bridge/layout.ts): a lower third moves up out of the caption band while
 * captions show under it; titles elsewhere, titles at other times and the captions themselves stay where they are.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { captionClipIds, clearCaptionBand } from "../../automation/bridge/layout.ts";
import { captionStyle } from "../ai/commands.ts";
import { defaultTitle } from "../model/defaults.ts";
import { addGenerated, ctxOf } from "../model/ops.ts";
import type { TitleSpec } from "../model/types.ts";
import { project, seqOf, V } from "./fixtures.ts";

const title = (text: string, box: TitleSpec["box"]): TitleSpec => ({ ...defaultTitle(text), box });

test("captions push an overlapping lower third above the caption band, nothing else moves", () => {
  const p = project();
  const ctx = ctxOf(p);
  let s = seqOf(p);
  const band = captionStyle(s).box!;
  const lower = addGenerated(s, ctx, V(s, 1).id, 25, 75, { type: "title", text: title("Lower third", [0.06, 0.72, 0.5, 0.14]) }, "Lower third");
  s = lower.seq;
  const later = addGenerated(s, ctx, V(s, 1).id, 400, 50, { type: "title", text: title("Later", [0.06, 0.72, 0.5, 0.14]) }, "Later");
  s = later.seq;
  const centre = addGenerated(s, ctx, V(s, 1).id, 120, 50, { type: "title", text: title("Centre", [0.1, 0.38, 0.8, 0.24]) }, "Centre");
  s = centre.seq;
  const cap = addGenerated(s, ctx, V(s, 2).id, 0, 200, { type: "title", text: { ...defaultTitle("Caption"), ...captionStyle(s), text: "Caption" } as TitleSpec }, "Caption");
  s = cap.seq;
  const ids = captionClipIds(s);
  assert.deepEqual([...ids], [cap.clipId]);
  const out = clearCaptionBand(s, ids);
  const box = (id: string) => (out.clips.find((c) => c.id === id)!.source as { text: TitleSpec }).text.box;
  assert.ok(box(lower.clipId)[1] + box(lower.clipId)[3] <= band[1] - 0.02 + 1e-9, "the lower third ends above the captions");
  assert.deepEqual(box(later.clipId), [0.06, 0.72, 0.5, 0.14], "no captions under it then: unchanged");
  assert.deepEqual(box(centre.clipId), [0.1, 0.38, 0.8, 0.24], "a centre title is never in the band");
  assert.deepEqual(box(cap.clipId), band, "captions stay put");
  assert.equal(clearCaptionBand(out, ids), out, "already clear: the same sequence back");
});
