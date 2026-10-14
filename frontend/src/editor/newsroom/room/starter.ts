/**
 * New news edit (docs/EDITOR.md §16.8): the starter set a news edit opens with — the channel's logo bug, the LIVE bug
 * with its clock and a crawl with sample lines, across the whole sequence (a minute when it's still empty) — and
 * "Fit bugs and tickers to the end" for when footage is added later. Pure (the commands are passed in, so tests can
 * run without the renderer).
 */
import { addTrack, clipEnd, seqEnd } from "../../model/ops.ts";
import { secondsToFrames } from "../../model/time.ts";
import type { EditProject, Sequence } from "../../model/types.ts";
import type { addGraphic, applyLook, ensureGfxTrack, ensureNewsroom } from "../commands.ts";
import type { GfxRole, GfxTemplate, GfxValue, NewsroomDoc } from "../types.ts";
import { pickTemplate, WANT } from "./pick.ts";

/** Sample crawl lines when the crawl template has none of its own. */
export const SAMPLE_LINES = [
  "Heavy rain alert for coastal Karnataka for the next 48 hours",
  "Sensex closes 412 points higher; Nifty ends above 25,100",
  "Metro Phase 2 trial runs to begin next month in Bengaluru",
  "Kharif sowing up 6% over last year, says the agriculture ministry",
  "मुंबई में भारी बारिश, लोकल ट्रेनें देर से चल रहीं",
  "India beat Australia by five wickets to level the series 1–1",
];

export interface NewsEditSetup {
  ratio: NewsroomDoc["ratio"];
  look: string;
  /** ISO local date-time the clocks show at the start (room/doc.ts airTimeOf). */
  airTime?: string;
  /** Length of the starter set when the sequence is empty (seconds). */
  seconds?: number;
}
export interface StarterDeps {
  ensureNewsroom: typeof ensureNewsroom; addGraphic: typeof addGraphic; applyLook: typeof applyLook;
  /** When given, the LIVE bug gets a bug track of its own (above the logo's), so both stay on screen. */
  ensureGfxTrack?: typeof ensureGfxTrack;
  templates: GfxTemplate[];
}

/** A second track for a role, right above the first one; returns its id. */
export function extraGfxTrack(p: EditProject, seqId: string, role: GfxRole, name: string, ensure: typeof ensureGfxTrack): string {
  const first = ensure(p, seqId, role);
  const i = p.sequences.findIndex((s) => s.id === seqId);
  const s = p.sequences[i];
  const t = s.tracks.find((x) => x.id === first)!;
  const r = addTrack(s, "video", t.index + 1);
  p.sequences[i] = { ...r.seq, tracks: r.seq.tracks.map((x) => (x.id === r.trackId ? { ...x, name, gfxRole: role } : x)) };
  return r.trackId;
}

/** Makes a draft a news edit with the starter set; returns the new clips and notes on anything left out. */
export function applyStarterSet(p: EditProject, seqId: string, o: NewsEditSetup, d: StarterDeps): { clipIds: string[]; notes: string[] } {
  const nr = d.ensureNewsroom(p);
  nr.ratio = o.ratio;
  if (o.airTime) nr.airTime = o.airTime;
  d.applyLook(p, o.look);
  if (p.newsroom) p.newsroom.look = o.look;
  const seq = p.sequences.find((s) => s.id === seqId);
  if (!seq) return { clipIds: [], notes: ["The sequence wasn't found."] };
  const len = seqEnd(seq) || secondsToFrames(o.seconds ?? 60, seq.fps);
  const clipIds: string[] = [], notes: string[] = [];
  const put = (what: string, t: GfxTemplate | undefined, values?: Record<string, GfxValue>, track?: () => string) => {
    if (!t) { notes.push(`No ${what} template yet.`); return; }
    try { clipIds.push(d.addGraphic(p, t, { at: 0, duration: len, seqId, ...(values ? { values } : {}), ...(track ? { trackId: track() } : {}) })); }
    catch (e) { notes.push(`The ${what} couldn't be added: ${(e as Error).message}`); }
  };
  const logo = pickTemplate(d.templates, WANT.logoBug), live = pickTemplate(d.templates, WANT.liveBug);
  put("logo bug", logo);
  // the LIVE bug sits on its own track when the logo bug is on the Bug track (one clip per track at a time)
  put("LIVE bug", live, undefined, logo && live && d.ensureGfxTrack ? () => extraGfxTrack(p, seqId, live.role, "LIVE", d.ensureGfxTrack!) : undefined);
  const crawl = pickTemplate(d.templates, WANT.crawl);
  const list = crawl?.fields.find((f) => f.type === "list");
  const empty = !list || !Array.isArray(list.default) || !(list.default as unknown[]).length;
  put("crawl", crawl, list && empty ? { [list.id]: SAMPLE_LINES.map((text) => ({ text })) } : undefined);
  return { clipIds, notes };
}

/** The end of the pictures and sound (graphics left out); the sequence end when there are none. */
export function contentEnd(seq: Sequence): number {
  let e = 0;
  for (const c of seq.clips) if (c.source.type !== "graphic") e = Math.max(e, clipEnd(c));
  return e || seqEnd(seq);
}

/**
 * Stretches (or trims) the last bug, ticker and background on each graphics track to end with the pictures. Returns
 * how many changed. Works on a draft.
 */
export function fitLoopsToEnd(p: EditProject, seqId: string, roleOf: (templateId: string) => string | undefined): number {
  const s = p.sequences.find((x) => x.id === seqId);
  if (!s) return 0;
  const end = contentEnd(s);
  let n = 0;
  const last = new Map<string, number>();
  s.clips.forEach((c, i) => {
    if (c.source.type !== "graphic") return;
    const role = roleOf(c.source.gfx.template);
    if (role !== "bug" && role !== "ticker" && role !== "background") return;
    const j = last.get(c.trackId);
    if (j === undefined || s.clips[j].start < c.start) last.set(c.trackId, i);
  });
  for (const i of last.values()) {
    const c = s.clips[i];
    if (c.start >= end || clipEnd(c) === end) continue;
    s.clips[i] = { ...c, duration: end - c.start };
    n++;
  }
  return n;
}
