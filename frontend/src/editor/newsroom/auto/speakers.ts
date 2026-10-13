/**
 * Automatic name straps (docs/EDITOR.md §16.10). The transcript's words (kept per media file by the Transcript panel,
 * placed where the timeline shows them by `placeWords`) are grouped into speaker runs; each speaker label is matched to
 * a person (`Person.speaker`, else the person's name), and a name strap goes in at each speaker change: the anchor,
 * reporter or guest strap by the person's kind, filled from the person. Straps keep a minimum gap, the same person
 * isn't named again for a while, short runs are skipped, and a strap never runs past its speaker. A range that already
 * has a strap placed by hand is left alone. `speakerStraps` is the dry run (what would be placed, replaced and why
 * not); `applySpeakerStraps` does it on a draft in one undo step, replacing the earlier automatic straps. Pure.
 */
import { ctxOf, removeClips } from "../../model/ops.ts";
import { secondsToFrames } from "../../model/time.ts";
import type { EditProject } from "../../model/types.ts";
import { placeWords, type PlacedWord, type Transcript } from "../../panels/TranscriptOps.ts";
import { addGraphic, autoHold } from "../commands.ts";
import type { GfxTemplate, GfxValue, Person } from "../types.ts";
import { AUTO_KEY, autoClips, isGraphicClip, templatePool } from "./tags.ts";

export interface SpeakerRun { speaker: string; from: number; to: number; words: number }

/** Runs of words by one speaker label (a new run after another speaker, an unlabelled word or a pause of `gap` s). */
export function speakerRuns(words: PlacedWord[], fps: number, o: { gap?: number } = {}): SpeakerRun[] {
  const gap = secondsToFrames(o.gap ?? 1.5, fps);
  const out: SpeakerRun[] = [];
  let cur: SpeakerRun | null = null;
  for (const w of [...words].sort((a, b) => a.from - b.from)) {
    const sp = w.speaker?.trim();
    if (!sp) { cur = null; continue; }
    if (cur && cur.speaker === sp && w.from - cur.to <= gap) { cur.to = Math.max(cur.to, w.to); cur.words++; continue; }
    cur = { speaker: sp, from: w.from, to: w.to, words: 1 };
    out.push(cur);
  }
  // a label that continues straight after a pause is the same turn: merge runs of one speaker back to back
  return out.reduce<SpeakerRun[]>((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && last.speaker === r.speaker) { last.to = r.to; last.words += r.words; } else acc.push({ ...r });
    return acc;
  }, []);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** The person a speaker label is: their `speaker` label first, then their name (in any of its languages). */
export function personFor(people: Person[], label: string): Person | undefined {
  const k = norm(label);
  return people.find((p) => p.speaker && norm(p.speaker) === k)
    ?? people.find((p) => norm(p.name) === k || Object.values(p.names ?? {}).some((n) => norm(n) === k));
}

/** The strap template for a kind of person: built-in anchor / reporter / guest straps, else any name strap. */
export function strapTemplateFor(p: EditProject, kind: Person["kind"], prefer?: string): GfxTemplate | undefined {
  const pool = templatePool(p).filter((t) => t.role === "strap");
  if (prefer) { const t = pool.find((x) => x.id === prefer); if (t) return t; }
  const want = kind === "expert" ? ["expert", "guest"] : kind === "anchor" || kind === "reporter" ? [kind] : ["guest"];
  for (const w of want) {
    const t = pool.find((x) => x.id === `nr.straps.${w}`) ?? pool.find((x) => x.kind === w)
      ?? pool.find((x) => x.id.toLowerCase().includes(w) || (x.tags ?? []).includes(w));
    if (t) return t;
  }
  return pool.find((t) => t.fields.some((f) => f.fill === "person.name")) ?? pool.find((t) => t.fields.some((f) => f.id === "name"));
}

/** A strap's values for a person, by the fields' `fill` hints (else their ids): name, role, location, photo. */
export function personValues(t: GfxTemplate, person: Person, lang?: string): Record<string, GfxValue> {
  const out: Record<string, GfxValue> = {};
  for (const f of t.fields) {
    const what = f.fill ?? ({ name: "person.name", role: "person.role", title: "person.role", designation: "person.role", location: "person.location",
      place: "person.location", city: "person.location", photo: "person.photo" } as Record<string, string>)[f.id];
    if (what === "person.name") out[f.id] = (lang && person.names?.[lang]) || person.name;
    else if (what === "person.role" && person.role) out[f.id] = person.role;
    else if ((what === "person.location" || what === "place") && person.location) out[f.id] = person.location;
    else if (what === "person.photo" && person.photo && f.type === "image") out[f.id] = person.photo;
  }
  return out;
}

export interface SpeakerStrapOptions {
  /** Transcripts by media id (the Transcript panel keeps them per file). */
  transcripts?: Record<string, Transcript>;
  /** Or the placed words themselves. */
  words?: PlacedWord[];
  /** Seconds between two straps at least (default 8). */ minGap?: number;
  /** Seconds before the same person is named again (default 90). */ repeatAfter?: number;
  /** Seconds a speaker must talk for a strap (default 2.5). */ minRun?: number;
  /** Seconds after the speaker starts (default 0.4). */ lead?: number;
  /** Seconds a strap stays (default: its reading time, at most the speaker's run). */ hold?: number;
  /** A template id per kind of person (default: the built-in straps). */ templates?: Partial<Record<NonNullable<Person["kind"]>, string>>;
  /** Language of the names (Person.names). */ lang?: string;
}
export interface StrapPlanItem { at: number; duration: number; speaker: string; personId: string; name: string; template: string; values: Record<string, GfxValue> }
export interface StrapPlan {
  items: StrapPlanItem[];
  /** Earlier automatic straps that are replaced. */ replaced: string[];
  /** Speaker changes left out, and why. */ skipped: { at: number; speaker: string; reason: string }[];
  /** Speaker labels with nobody in People. */ unmatched: string[];
  runs: number;
}

/** The dry run: which straps would go where (see the module header). */
export function speakerStraps(p: EditProject, seqId: string, o: SpeakerStrapOptions = {}): StrapPlan {
  const seq = p.sequences.find((s) => s.id === seqId);
  const plan: StrapPlan = { items: [], replaced: [], skipped: [], unmatched: [], runs: 0 };
  if (!seq) return plan;
  plan.replaced = autoClips(seq, "speaker").map((c) => c.id);
  const words = o.words ?? placeWords(seq, ctxOf(p), o.transcripts ?? {});
  const runs = speakerRuns(words, seq.fps);
  plan.runs = runs.length;
  const people = p.newsroom?.people ?? [];
  const f = (s: number) => secondsToFrames(s, seq.fps);
  const minGap = f(o.minGap ?? 8), repeat = f(o.repeatAfter ?? 90), minRun = f(o.minRun ?? 2.5), lead = f(o.lead ?? 0.4);
  const replaced = new Set(plan.replaced);
  const manual = seq.clips.filter((c) => isGraphicClip(c) && !replaced.has(c.id) && seq.tracks.find((t) => t.id === c.trackId)?.gfxRole === "strap");
  const lastNamed = new Map<string, number>();
  const unmatched = new Set<string>();
  let lastAt = -Infinity, prevSpeaker = "";
  for (const r of runs) {
    const changed = r.speaker !== prevSpeaker;
    prevSpeaker = r.speaker;
    if (!changed) continue;
    const person = personFor(people, r.speaker);
    const at = r.from + lead;
    const skip = (reason: string) => plan.skipped.push({ at: r.from, speaker: r.speaker, reason });
    if (!person) { unmatched.add(r.speaker); skip("Nobody in People has this speaker label"); continue; }
    if (r.to - r.from < minRun) { skip("Speaks too briefly"); continue; }
    if (at - lastAt < minGap) { skip("Too soon after the last strap"); continue; }
    const seen = lastNamed.get(person.id);
    if (seen !== undefined && at - seen < repeat) { skip(`${person.name} was named a moment ago`); continue; }
    const t = strapTemplateFor(p, person.kind, person.kind ? o.templates?.[person.kind] : undefined);
    if (!t) { skip("No name strap template"); continue; }
    const values = personValues(t, person, o.lang);
    const want = f(o.hold ?? autoHold(t, values, p.newsroom?.settings.readSpeed ?? 3));
    const duration = Math.min(want, r.to - at);
    if (duration < minRun) { skip("Speaks too briefly"); continue; }
    if (manual.some((c) => c.start < at + duration && at < c.start + c.duration)) { skip("A strap placed by hand is already there"); continue; }
    plan.items.push({ at, duration, speaker: r.speaker, personId: person.id, name: person.name, template: t.id, values });
    lastAt = at;
    lastNamed.set(person.id, at);
  }
  plan.unmatched = [...unmatched];
  return plan;
}

/** Places a plan's straps on a draft (earlier automatic straps removed first); returns the new clip ids. */
export function applySpeakerStraps(p: EditProject, seqId: string, plan: StrapPlan): string[] {
  const i = p.sequences.findIndex((s) => s.id === seqId);
  if (i < 0) return [];
  const old = autoClips(p.sequences[i], "speaker").map((c) => c.id);
  if (old.length) p.sequences[i] = removeClips(p.sequences[i], ctxOf(p), old);
  return plan.items.map((it) => addGraphic(p, it.template, { at: it.at, duration: it.duration, values: { ...it.values, [AUTO_KEY]: "speaker" }, seqId }));
}
