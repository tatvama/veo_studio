/** News Room graphics in auto SFX (autosfx/events.ts graphicEvents): stingers, straps, quiet loops. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findEvents } from "../autosfx/events.ts";
import { addGraphic } from "../newsroom/commands.ts";
import { STINGERS } from "../newsroom/templates/stingers.ts";
import { newProject } from "../model/defaults.ts";

test("a stinger gets a whoosh and an impact at its cut; a strap swishes in and out; a crawl stays quiet", () => {
  const p = newProject("SFX", { width: 1920, height: 1080, fps: 25 });
  const seqId = p.activeSequenceId;
  const sting = STINGERS[0];
  const sid = addGraphic(p, sting, { at: 100, duration: 30, seqId });
  const strap = addGraphic(p, "nr.straps.anchor", { at: 200, duration: 125, seqId });
  addGraphic(p, "nr.tickers.crawl", { at: 0, duration: 500, seqId });
  const seq = p.sequences.find((s) => s.id === seqId)!;
  const ev = findEvents(seq, { fps: 25, beats: false, project: p });
  const s = ev.find((e) => e.sourceId === sid)!;
  assert.equal(s.rule, "stingers");
  const cut = 100 + Math.round((sting.cut ?? 0.5) * 30);
  assert.deepEqual(s.parts.map((x) => [x.part, x.hit]), [["whoosh", cut], ["impact", cut]]);
  const st = ev.find((e) => e.sourceId === strap)!;
  assert.equal(st.rule, "titles");
  assert.deepEqual(st.parts.map((x) => x.part), ["in", "out"]);
  assert.equal(st.parts[1].hit, 325);
  assert.equal(ev.filter((e) => e.id.includes("Crawl") || seq.clips.find((c) => c.id === e.sourceId)?.name === "Crawl").length, 0);
});
