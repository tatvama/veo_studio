/**
 * The auto SFX planner (docs/EDITOR.md §15.2): edit events (events.ts) → sounds from the SFX library, chosen by TAG
 * (never by preset id, so the library can change), sized to the event (a whoosh as long as its transition plus
 * 0.2 s, a typing burst as long as the typewriter with one key per character …), levelled by the intensity, 6 dB lower
 * while speech plays, at most one sound per 0.4 s (the higher-priority rule wins a collision), seeded from the
 * sequence id plus the event id so a re-run gives the same plan. Pure: `planAutoSfx(seq, project, opts)`.
 */
import { SFX_PRESETS } from "../sfx/index.ts";
import { clipEnd, trackById } from "../model/ops.ts";
import { framesToSeconds, secondsToFrames } from "../model/time.ts";
import type { EditProject, Sequence } from "../model/types.ts";
import { findEvents, isDialogue, type SfxEvent, type SfxPart } from "./events.ts";
import type { AutoSfxOptions, AutoSfxPlan, CatalogPreset, FrameRange, SfxIntensity, SfxPlacement, SfxRule, SfxSkipped } from "./types.ts";

export interface RuleInfo { id: SfxRule; label: string; hint: string; priority: number; on: boolean }

/** The rules, highest priority first (a collision keeps the higher one), with their defaults. */
export const RULES: RuleInfo[] = [
  { id: "stingers", label: "Stingers and wipes", hint: "A whoosh plus a soft impact when it covers the frame", priority: 100, on: true },
  { id: "transitions", label: "Transitions", hint: "A whoosh centred on the cut, as long as the transition", priority: 90, on: true },
  { id: "countdowns", label: "Countdowns", hint: "A tick on every number and a boom at the end", priority: 85, on: true },
  { id: "speed_ramps", label: "Slow-motion ramps", hint: "A riser over the ramp-in and an impact at full slow", priority: 80, on: true },
  { id: "freeze_frames", label: "Freeze frames", hint: "A camera shutter", priority: 75, on: true },
  { id: "shake", label: "Camera shake", hint: "A boom as it starts", priority: 70, on: true },
  { id: "glitch", label: "Glitch and VHS", hint: "A glitch, tape noise or tape stop", priority: 65, on: true },
  { id: "titles", label: "Titles", hint: "Pop or swish in, a reverse swish out, typing for typewriters", priority: 60, on: true },
  { id: "stickers", label: "Stickers and buttons", hint: "A pop, and the click of subscribe and like", priority: 55, on: true },
  { id: "punch_ins", label: "Punch-in jump cuts", hint: "A subtle swish where the picture punches in", priority: 40, on: true },
  { id: "beats", label: "Beat markers", hint: "Hits on the strong beats only (off by default)", priority: 20, on: false },
];
const RULE = new Map(RULES.map((r) => [r.id, r]));
export const ruleInfo = (id: SfxRule) => RULE.get(id)!;
export const ruleIds = RULES.map((r) => r.id);

/** Clip gain (dB) per intensity, before each rule's offset; presets are normalised to −16 LUFS. */
export const INTENSITY_DB: Record<SfxIntensity, number> = { subtle: -24, normal: -18, punchy: -12 };
/** Never more than one sound per this many seconds (sounds of one event, like a whoosh and its impact, are one). */
export const MIN_GAP_S = 0.4;
/** Lower while speech plays. */
export const SPEECH_DUCK_DB = -6;
/** Takes per sound: the render seed is one of these, so one file serves many placements. */
export const TAKES = 6;
/** Beats: at most this many hits, at least a second apart. */
export const BEAT_CAP: Record<SfxIntensity, number> = { subtle: 8, normal: 16, punchy: 32 };

/** FNV-1a: a stable 32-bit hash. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Where the edit's own content ends (auto SFX never makes a sequence longer). */
export const contentEnd = (seq: Sequence) => seq.clips.reduce((m, c) => (c.autoSfx ? m : Math.max(m, clipEnd(c))), 0);

export function resolveRange(seq: Sequence, range: AutoSfxOptions["range"]): FrameRange {
  const end = Math.max(1, contentEnd(seq));
  if (range && typeof range === "object") return { from: Math.max(0, Math.round(range.from)), to: Math.max(Math.round(range.from) + 1, Math.round(range.to)) };
  if (range === "inout" && (seq.inPoint !== undefined || seq.outPoint !== undefined)) {
    const a = seq.inPoint ?? 0, b = seq.outPoint !== undefined ? seq.outPoint + 1 : end;
    return { from: a, to: Math.max(a + 1, b) };
  }
  return { from: 0, to: end };
}

/** Where speech plays without an analysis: the dialogue clips' extents. */
export function speechFromClips(seq: Sequence): FrameRange[] {
  return merge(seq.clips.filter((c) => c.enabled && !trackById(seq, c.trackId)?.muted && isDialogue(seq, c)).map((c) => ({ from: c.start, to: clipEnd(c) })));
}

export function merge(rs: FrameRange[]): FrameRange[] {
  const s = [...rs].filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
  const out: FrameRange[] = [];
  for (const r of s) { const l = out[out.length - 1]; if (l && r.from <= l.to) l.to = Math.max(l.to, r.to); else out.push({ ...r }); }
  return out;
}

// ── choosing a preset ────────────────────────────────────────────────────────

const SOFT_WORDS = ["soft", "subtle", "light", "gentle", "air", "small", "quiet", "muted", "short", "thin"];
const HARD_WORDS = ["hard", "heavy", "punch", "big", "deep", "huge", "cinematic", "massive", "aggressive", "sharp", "thick"];
/** Tags that make a sound something more specific: a plain whoosh is never a reversed one or a riser. */
const SPECIAL = ["reverse", "riser", "downlifter", "sub_drop", "braam", "countdown"];

const words = (p: CatalogPreset) => `${p.id} ${p.name} ${p.tags.join(" ")}`.toLowerCase();
const hasWord = (text: string, w: string) => text.includes(w);

/** The best preset for a part: the first tag set some preset has, the variants that suit the part and the intensity,
 *  one of them by the seed. */
export function pickPreset(catalog: CatalogPreset[], part: Pick<SfxPart, "tags" | "prefer" | "avoid" | "length">, intensity: SfxIntensity, h: number): CatalogPreset | null {
  for (const need of part.tags) {
    let list = catalog.filter((p) => need.every((t) => p.tags.includes(t)));
    if (!list.length) continue;
    const plain = list.filter((p) => !SPECIAL.some((t) => !need.includes(t) && p.tags.includes(t)));
    if (plain.length) list = plain;
    const once = list.filter((p) => !p.loop);
    if (once.length) list = once;
    const score = (p: CatalogPreset) => {
      const w = words(p);
      // a preset whose first tag is the one asked for is that kind of sound first (a whoosh, not a swish that whooshes)
      let s = p.tags[0] === need[0] ? 1 : 0;
      for (const x of part.prefer ?? []) if (hasWord(w, x)) s += 2;
      for (const x of part.avoid ?? []) if (hasWord(w, x)) s -= 3;
      // a part that wants a length is better served by a sound that has one (a typing burst, not one key)
      if (part.length !== undefined && p.params.some((x) => LENGTH_NAMES.includes(x.name.toLowerCase()))) s += 2;
      if (intensity === "subtle") s += SOFT_WORDS.some((x) => hasWord(w, x)) ? 1 : 0, s -= HARD_WORDS.some((x) => hasWord(w, x)) ? 1 : 0;
      if (intensity === "punchy") s += HARD_WORDS.some((x) => hasWord(w, x)) ? 1 : 0, s -= SOFT_WORDS.some((x) => hasWord(w, x)) ? 1 : 0;
      return s;
    };
    const best = Math.max(...list.map(score));
    const top = list.filter((p) => score(p) === best).sort((a, b) => a.id.localeCompare(b.id));
    return top[(h >>> 8) % top.length];
  }
  return null;
}

const LENGTH_NAMES = ["length", "duration", "seconds"];
const COUNT_NAMES = ["count", "keys", "strokes", "chars", "characters", "taps", "clicks", "presses"];
const ENERGY_NAMES = ["punch", "intensity", "drive", "weight", "body", "power"];
const R3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** The parameter values for a part (its length, its keystrokes, the intensity's punch) and the sound's seconds. */
export function presetValues(p: CatalogPreset, part: Pick<SfxPart, "length" | "maxLength" | "want">, intensity: SfxIntensity): { values: Record<string, number>; seconds: number; trimmed: boolean } {
  const values: Record<string, number> = {};
  const param = (names: string[]) => p.params.find((x) => names.includes(x.name.toLowerCase()));
  let seconds = p.duration;
  const lp = param(LENGTH_NAMES);
  if (lp && part.length !== undefined) { values[lp.name] = R3(clamp(part.length, lp.min, lp.max)); seconds = values[lp.name]; }
  const cp = param(COUNT_NAMES);
  if (cp && part.want?.count !== undefined) values[cp.name] = Math.round(clamp(part.want.count, cp.min, cp.max));
  // keys per second ("cps" on the typing bursts)
  const rp = p.params.find((x) => ["rate", "cps", "kps"].includes(x.name.toLowerCase()));
  if (!cp && rp && part.want?.count !== undefined && rp.max >= 4) values[rp.name] = R3(clamp(part.want.count / Math.max(0.1, part.length ?? seconds), rp.min, rp.max));
  if (intensity !== "normal") {
    for (const x of p.params) {
      if (!ENERGY_NAMES.includes(x.name.toLowerCase()) || values[x.name] !== undefined) continue;
      values[x.name] = R3(intensity === "subtle" ? x.default - 0.25 * (x.default - x.min) : x.default + 0.25 * (x.max - x.default));
    }
  }
  let trimmed = false;
  if (part.maxLength !== undefined && seconds > part.maxLength) { seconds = part.maxLength; trimmed = true; }
  return { values, seconds: Math.max(0.02, seconds), trimmed };
}

// ── the plan ─────────────────────────────────────────────────────────────────

const overlaps = (a: FrameRange, rs: FrameRange[]) => rs.some((r) => r.from < a.to && a.from < r.to);

export function planAutoSfx(seq: Sequence, project: Pick<EditProject, "media" | "sequences">, opts: AutoSfxOptions = {}): AutoSfxPlan {
  const fps = seq.fps;
  const intensity: SfxIntensity = opts.intensity ?? "normal";
  const catalog: CatalogPreset[] = opts.catalog ?? (SFX_PRESETS as unknown as CatalogPreset[]);
  const rules = Object.fromEntries(RULES.map((r) => [r.id, opts.rules?.[r.id] ?? r.on])) as Record<SfxRule, boolean>;
  const range = resolveRange(seq, opts.range);
  const speech = merge(opts.speech ?? speechFromClips(seq));
  const zero = () => Object.fromEntries(RULES.map((r) => [r.id, 0])) as Record<SfxRule, number>;
  const counts = zero(), found = zero();
  const placements: SfxPlacement[] = [];
  const skipped: SfxSkipped[] = [];
  const F = (s: number) => secondsToFrames(s, fps);
  const gap = F(MIN_GAP_S);
  const inRange = (f: number) => f >= range.from && f < range.to;
  // a sound needs a little of the sequence after its moment (the last 0.2 s is too late)
  const lastFrame = Math.max(1, contentEnd(seq) - F(0.2));

  // earlier auto sounds: replaced, unless a locked track keeps them (then their event stays as it is)
  const auto = seq.clips.filter((c) => c.autoSfx && c.start < range.to && clipEnd(c) > range.from);
  const lockedSources = new Set(auto.filter((c) => trackById(seq, c.trackId)?.locked).map((c) => c.autoSfx!.sourceId));
  const replaces = auto.filter((c) => !trackById(seq, c.trackId)?.locked).length;

  const events = findEvents(seq, { fps, beats: true, project }).filter((e) => inRange(e.hit));
  for (const e of events) found[e.rule] += e.skip ? 0 : 1;
  // highest priority first, then in time order
  const order = [...events].sort((a, b) => ruleInfo(b.rule).priority - ruleInfo(a.rule).priority || a.hit - b.hit || a.id.localeCompare(b.id));
  const taken: { hit: number; event: string; rule: SfxRule; label: string }[] = [];
  let beats = 0, lastBeat = -Infinity;

  const skip = (e: SfxEvent, reason: string, hit = e.hit, part?: string) => skipped.push({ id: part ? `${e.id}:${part}` : e.id, rule: e.rule, sourceId: e.sourceId, hit, reason });

  for (const e of order) {
    if (!rules[e.rule]) continue;
    if (e.skip) { skip(e, e.skip); continue; }
    if (lockedSources.has(e.sourceId)) { skip(e, "Its earlier sound is on a locked track"); continue; }
    if (e.rule === "beats") {
      if (beats >= BEAT_CAP[intensity]) { skip(e, `At most ${BEAT_CAP[intensity]} beat hits at ${intensity} intensity`); continue; }
      if (e.hit - lastBeat < F(1)) { skip(e, "Less than a second after the last beat hit"); continue; }
    }
    let placed = 0;
    for (const p of e.parts) {
      if (!inRange(p.hit) && p.hit !== range.to) continue;
      if (p.hit >= lastFrame) { skip(e, "At the very end of the sequence: nothing plays after it", p.hit, p.part); continue; }
      const clash = taken.find((x) => x.event !== e.id && Math.abs(x.hit - p.hit) < gap);
      if (clash) { skip(e, `Within ${MIN_GAP_S} s of ${clash.label} (${ruleInfo(clash.rule).label.toLowerCase()} come first)`, p.hit, p.part); continue; }
      const pid = `${e.id}:${p.part}`;
      // numbered parts of one event (a countdown's ticks) share their sound
      const h = hash32(`${seq.id}|${e.id}:${p.part.replace(/\d+$/, "")}`);
      const preset = pickPreset(catalog, p, intensity, h);
      if (!preset) { skip(e, `No sound in the library is tagged ${p.tags.map((t) => t.join(" + ")).join(" or ")}`, p.hit, p.part); continue; }
      const { values, seconds, trimmed } = presetValues(preset, p, intensity);
      const duration = Math.max(1, F(seconds));
      const at = p.align === "start" ? p.hit : p.align === "centre" ? p.hit - Math.floor(duration / 2) : p.hit - duration;
      const body = { from: Math.max(at, p.hit - F(0.1)), to: Math.min(at + duration, p.hit + F(0.6)) };
      const ducked = overlaps(body.to > body.from ? body : { from: at, to: at + duration }, speech);
      const gainDb = Math.round(clamp(INTENSITY_DB[intensity] + p.gain + (ducked ? SPEECH_DUCK_DB : 0), -48, 6) * 10) / 10;
      const short = Math.max(1, Math.round(duration / 4));
      const fadeIn = p.align === "start" ? 0 : Math.min(2, short);
      const fadeOut = trimmed ? Math.min(F(0.08) || 2, short) : p.align === "centre" ? Math.min(2, short) : 0;
      const label = preset.name || preset.id;
      placements.push({ id: pid, rule: e.rule, sourceId: e.sourceId, at, hit: p.hit, duration, presetId: preset.id, values, seed: 1 + (h % TAKES), gainDb, fadeIn, fadeOut, ducked,
        label, reason: p.reason, align: p.align, trim: trimmed });
      taken.push({ hit: p.hit, event: e.id, rule: e.rule, label: `"${label}"` });
      placed++;
    }
    if (placed) {
      counts[e.rule] += placed;
      if (e.rule === "beats") { beats++; lastBeat = e.hit; }
    }
  }
  placements.sort((a, b) => a.hit - b.hit || a.id.localeCompare(b.id));
  skipped.sort((a, b) => a.hit - b.hit || a.id.localeCompare(b.id));
  return { sequenceId: seq.id, fps, intensity, range, rules, placements, skipped, counts, found, replaces };
}

/** One paragraph for a model or a toast: sounds per rule, what was left out, what it replaces. */
export function describeAutoSfx(plan: AutoSfxPlan, seq?: Pick<Sequence, "name">): string {
  const S = (f: number) => Math.round(framesToSeconds(f, plan.fps) * 100) / 100;
  const per = RULES.filter((r) => plan.counts[r.id]).map((r) => `${r.label.toLowerCase()} ${plan.counts[r.id]}`);
  const bits = [`${plan.placements.length} sound effect${plan.placements.length === 1 ? "" : "s"}${seq ? ` for "${seq.name}"` : ""} at ${plan.intensity} intensity (${S(plan.range.from)}–${S(plan.range.to)} s)`];
  if (per.length) bits.push(per.join(", "));
  const ducked = plan.placements.filter((p) => p.ducked).length;
  if (ducked) bits.push(`${ducked} lowered 6 dB under speech`);
  if (plan.skipped.length) bits.push(`${plan.skipped.length} left out`);
  if (plan.replaces) bits.push(`replaces ${plan.replaces} earlier auto sound${plan.replaces === 1 ? "" : "s"}`);
  return `${bits.join("; ")}.`;
}
