/** Shared fixtures of the News delivery tests: two templates and a small news sequence. */
import type { EditProject, Sequence } from "../model/types.ts";
import { placeGraphic } from "../newsroom/delivery/build.ts";
import { field, rect, text, tpl } from "../newsroom/templates/kit.ts";
import { project, put, seqOf } from "./fixtures.ts";

export const STRAP = tpl({ id: "t.strap", name: "Two-line strap", category: "Straps", role: "strap", seconds: 6,
  fields: [field.text("headline", "Headline", "Sample headline"), field.text("strap", "Second line", "Sample line")],
  designs: { "16:9": [rect("plate", [120, 820, 900, 120], { fill: "@primary" }), text("t", [140, 820, 860, 120], "{headline}")], "9:16": [rect("plate", [60, 1300, 960, 160])] } });
export const TICKER = tpl({ id: "t.ticker", name: "Crawl", category: "Tickers", role: "ticker", seconds: 0, loop: true,
  fields: [field.list("items", "Lines", [{ text: "One" }])], designs: { "16:9": [rect("bar", [0, 980, 1920, 60])] } });

/** A news sequence: m1 on V1 0..100, a strap at 10..60 and a ticker 0..100 on their tracks; a Hindi version of the strap. */
export function newsProject(): { p: EditProject; s: Sequence; strapId: string; tickerId: string } {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  const a = placeGraphic(s, STRAP, 10, 50, { values: { headline: "Rains lash Mumbai" }, langs: { hi: { headline: "मुंबई में भारी बारिश" } } });
  const b = placeGraphic(a.seq, TICKER, 0, 100, { values: {} });
  s = b.seq;
  p.sequences = [s];
  p.newsroom = { version: 1, look: "look.classic_red", looks: {}, templates: {}, ratio: "both", rundown: [], people: [], places: [], sources: [], data: {}, langs: ["en", "kn"],
    settings: { safeGuides: true, collision: true, readSpeed: 3, tickerSpeed: "normal", aiLabel: false } };
  return { p, s, strapId: a.clipId, tickerId: b.clipId };
}
