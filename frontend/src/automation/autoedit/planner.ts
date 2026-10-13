/**
 * The auto edit planner (docs/EDITOR.md §13.3): media + their analysis + options → a plan of a new sequence, in
 * seconds. Pure and deterministic (the same input gives the same plan), so the `auto_edit` tool's dry run, the Auto
 * edit dialog's preview and watch folders all show what the executor will build. Five styles:
 *   talking_head  silences and bad takes out, jump-cut punch-ins, captions, voice clean-up
 *   montage       cuts on the music's beats, the liveliest moments, speed ramps, a mood
 *   documentary   scene order, long pauses trimmed, J/L cuts, an ambience bed, lower thirds
 *   highlights    9:16, the best moments by speech, loudness and motion, a hook title, captions
 *   slideshow     stills with Ken Burns, on the beats when there is music, crossfades
 */
import { formatSize, styleById } from "./styles.ts";
import type { AutoEditOptions, MediaAnalysis, Plan, PlanAudioBed, PlanCue, PlanMedia, PlanSegment, PlanTitle, PlanTransition, Range } from "./types.ts";

// ── ranges ───────────────────────────────────────────────────────────────────

const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const total = (rs: Range[]) => rs.reduce((s, r) => s + Math.max(0, r.end - r.start), 0);

/** Sorted, overlapping or touching (within `gap`) ranges joined. */
export function merge(rs: Range[], gap = 0): Range[] {
  const s = rs.filter((r) => r.end > r.start).map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** `base` minus `cut`. */
export function subtract(base: Range[], cut: Range[]): Range[] {
  let out = merge(base);
  for (const c of merge(cut)) {
    const next: Range[] = [];
    for (const r of out) {
      if (c.end <= r.start || c.start >= r.end) { next.push(r); continue; }
      if (c.start > r.start) next.push({ start: r.start, end: c.start });
      if (c.end < r.end) next.push({ start: c.end, end: r.end });
    }
    out = next;
  }
  return out;
}

const intersect = (a: Range, b: Range): Range | null => {
  const s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
  return e > s ? { start: s, end: e } : null;
};

/** Mean of a per-half-second curve over [a, b) seconds (NaN when there is no curve). */
function curveMean(curve: number[] | undefined, a: number, b: number): number {
  if (!curve?.length) return Number.NaN;
  const i0 = Math.max(0, Math.floor(a / 0.5)), i1 = Math.min(curve.length, Math.max(i0 + 1, Math.ceil(b / 0.5)));
  let s = 0, n = 0;
  for (let i = i0; i < i1; i++) { s += curve[i]; n++; }
  return n ? s / n : Number.NaN;
}

const silenceIn = (a: MediaAnalysis | undefined, w: Range) => total((a?.silences ?? []).map((s) => intersect(s, w)).filter((x): x is Range => !!x));

/** "IMG_0042_harbour-walk.mp4" → "harbour walk" */
export function prettyName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/^(IMG|VID|MVI|DSC|GOPR|DJI|PXL|C\d{4})[_-]?\d*[_-]?/i, "").replace(/[_-]+/g, " ").trim();
  return (base || name).slice(0, 60);
}

// ── bad takes ────────────────────────────────────────────────────────────────

export const BLUR_TAKE = 9.5;
export const MIN_TAKE_S = 1;

interface Quality { drop?: string; bad: Range[] }

/** Why a take is left out (too short, mostly black / frozen / blurred, clipped sound), and the bad parts of a kept one. */
export function takeQuality(m: PlanMedia, a: MediaAnalysis | undefined, soundMatters: boolean): Quality {
  const d = m.duration;
  if (m.kind === "image") return { bad: [] };
  if (!(d >= MIN_TAKE_S)) return { drop: `too short (${r3(d)} s)`, bad: [] };
  const black = merge(a?.black ?? []);
  const freeze = merge((a?.freeze ?? []).filter((f) => f.end - f.start >= 1));
  const blur = merge(a?.blur ?? []);
  const clipped = soundMatters && m.hasAudio ? merge(a?.clipped ?? []) : [];
  if (m.kind === "video") {
    if (total(black) >= 0.6 * d) return { drop: "mostly black", bad: [] };
    if (total(freeze) >= 0.6 * d) return { drop: "frozen picture", bad: [] };
    if ((a?.blurScore ?? 0) > BLUR_TAKE || total(blur) >= 0.6 * d) return { drop: "out of focus", bad: [] };
  }
  if (clipped.length && total(clipped) >= 0.4 * d) return { drop: "clipped (distorted) sound", bad: [] };
  return { bad: merge([...black, ...freeze, ...blur, ...clipped]) };
}

// ── order ────────────────────────────────────────────────────────────────────

const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
const OPENERS = /^\s*(hi|hello|hey|welcome|namaste|namaskar|good (morning|evening)|today|so,? today)\b/i;
const CLOSERS = /\b(thanks?( you)? for watching|subscribe|see you|bye|that's (it|all))\b/i;

/** Clips in the chosen order: series (natural name) order, date taken, timecode, or by content (openers first, sign-offs last). */
export function orderMedia(media: PlanMedia[], by: Record<string, MediaAnalysis>, order: AutoEditOptions["order"] = "name"): PlanMedia[] {
  const named = [...media].sort((a, b) => natural(a.name, b.name) || natural(a.path ?? "", b.path ?? ""));
  // missing dates / timecodes go last, in name order (a plain comparison: ISO dates and timecodes sort as text)
  const cmp = (x?: string, y?: string) => (x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1);
  if (order === "date") return [...named].sort((a, b) => cmp(by[a.id]?.created ?? by[a.id]?.mtime, by[b.id]?.created ?? by[b.id]?.mtime));
  if (order === "timecode") return [...named].sort((a, b) => cmp(by[a.id]?.timecode, by[b.id]?.timecode));
  if (order === "content") {
    const text = (m: PlanMedia) => (by[m.id]?.transcript ?? []).map((s) => s.text).join(" ");
    const rank = (m: PlanMedia) => (OPENERS.test(text(m)) ? 0 : CLOSERS.test(text(m)) ? 2 : 1);
    return [...named].sort((a, b) => rank(a) - rank(b));
  }
  return named;
}

// ── captions ─────────────────────────────────────────────────────────────────

/** Transcript lines under the segments, on the timeline; `words` splits them into short phrases (Shorts). */
export function captionCues(segments: PlanSegment[], by: Record<string, MediaAnalysis>, words = 0): PlanCue[] {
  const out: PlanCue[] = [];
  for (const s of segments) {
    if (!s.sound) continue;
    for (const line of by[s.mediaId]?.transcript ?? []) {
      const w = intersect(line, { start: s.in, end: s.out });
      if (!w || w.end - w.start < 0.15 || !line.text.trim()) continue;
      const start = s.at + (w.start - s.in) / s.speed, end = s.at + (w.end - s.in) / s.speed;
      const text = line.text.trim();
      if (!words) { out.push({ start: r3(start), end: r3(end), text }); continue; }
      const parts = text.split(/\s+/);
      const n = Math.max(1, Math.ceil(parts.length / words));
      for (let i = 0; i < n; i++) {
        const a = start + ((end - start) * i) / n, b = start + ((end - start) * (i + 1)) / n;
        out.push({ start: r3(a), end: r3(b), text: parts.slice(i * words, (i + 1) * words).join(" ") });
      }
    }
  }
  return out;
}

// ── the planner ──────────────────────────────────────────────────────────────

const toMap = (a: MediaAnalysis[] | Record<string, MediaAnalysis>): Record<string, MediaAnalysis> =>
  Array.isArray(a) ? Object.fromEntries(a.map((x) => [x.mediaId, x])) : a;

interface Ctx {
  by: Record<string, MediaAnalysis>; options: AutoEditOptions; notes: string[]; dropped: Plan["summary"]["dropped"];
  silenceRemoved: number; badRemoved: number;
}

/** Usable parts of each picture take, after the bad ones are dropped. */
function goodParts(media: PlanMedia[], c: Ctx, soundMatters: boolean): { m: PlanMedia; parts: Range[] }[] {
  const out: { m: PlanMedia; parts: Range[] }[] = [];
  const qs = media.map((m) => ({ m, q: takeQuality(m, c.by[m.id], soundMatters) }));
  // never drop every take for softness: keep the sharpest when all are "out of focus"
  if (qs.length && qs.every((x) => x.q.drop === "out of focus")) {
    const best = [...qs].sort((a, b) => (c.by[a.m.id]?.blurScore ?? 0) - (c.by[b.m.id]?.blurScore ?? 0))[0];
    best.q = { bad: [] };
    c.notes.push(`Every clip looked soft, so the sharpest (${best.m.name}) was kept`);
  }
  for (const { m, q } of qs) {
    if (q.drop) { c.dropped.push({ mediaId: m.id, name: m.name, reason: q.drop }); continue; }
    const base = m.kind === "image" ? [{ start: 0, end: 0 }] : [{ start: 0, end: m.duration }];
    const parts = m.kind === "image" ? base : subtract(base, q.bad);
    c.badRemoved += m.kind === "image" ? 0 : total(base) - total(parts);
    out.push({ m, parts });
  }
  return out;
}

/** Speech pieces of `parts`: silences over `minSilence` s come out, `pad` s of air left at each side. */
function speechPieces(parts: Range[], a: MediaAnalysis | undefined, o: { minSilence: number; pad: number; minPiece: number; join: number }): Range[] {
  const sil = (a?.silences ?? []).filter((s) => s.end - s.start >= o.minSilence).map((s) => ({ start: s.start + o.pad, end: s.end - o.pad })).filter((s) => s.end > s.start);
  return merge(subtract(parts, sil), o.join).filter((r) => r.end - r.start >= o.minPiece);
}

/** Drops the quietest pieces until the total fits `target` (order kept). */
function fitToTarget(pieces: { m: PlanMedia; r: Range }[], target: number, by: Record<string, MediaAnalysis>): { m: PlanMedia; r: Range }[] {
  if (!(target > 0)) return pieces;
  let list = [...pieces];
  const len = () => list.reduce((s, p) => s + p.r.end - p.r.start, 0);
  if (len() <= target) return list;
  const score = (p: { m: PlanMedia; r: Range }) => { const e = curveMean(by[p.m.id]?.energy, p.r.start, p.r.end); return Number.isFinite(e) ? e : -30; };
  const ranked = list.map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => a.s - b.s);
  const drop = new Set<number>();
  for (const x of ranked) {
    if (len() - [...drop].reduce((s, i) => s + list[i].r.end - list[i].r.start, 0) <= target) break;
    if (drop.size >= list.length - 1) break;
    drop.add(x.i);
  }
  list = list.filter((_, i) => !drop.has(i));
  // the last piece is trimmed to land on the target
  const over = len() - target;
  if (over > 0.05 && list.length) {
    const last = list[list.length - 1];
    const keep = Math.max(0.5, last.r.end - last.r.start - over);
    list[list.length - 1] = { ...last, r: { start: last.r.start, end: last.r.start + keep } };
  }
  return list;
}

function seg(m: PlanMedia, r: Range, o: Partial<PlanSegment> = {}): PlanSegment {
  const speed = o.speed ?? 1;
  return { mediaId: m.id, in: r3(r.start), out: r3(r.end), at: 0, duration: r3((r.end - r.start) / speed), speed, sound: m.hasAudio, ...o };
}

function talkingHead(media: PlanMedia[], c: Ctx): PlanSegment[] {
  const pieces: { m: PlanMedia; r: Range }[] = [];
  for (const { m, parts } of goodParts(media.filter((x) => x.kind === "video"), c, true)) {
    const a = c.by[m.id];
    const sp = m.hasAudio ? speechPieces(parts, a, { minSilence: 0.35, pad: 0.12, minPiece: 0.6, join: 0.2 }) : parts.filter((r) => r.end - r.start >= 0.6);
    c.silenceRemoved += total(parts) - total(sp);
    for (const r of sp) {
      // a long take gets a jump-cut punch-in half way
      if (r.end - r.start > 8) { const mid = r3((r.start + r.end) / 2); pieces.push({ m, r: { start: r.start, end: mid } }, { m, r: { start: mid, end: r.end } }); }
      else pieces.push({ m, r });
    }
  }
  const fitted = fitToTarget(pieces, c.options.targetSeconds ?? 0, c.by);
  let zoom = false;
  return fitted.map((p, i) => {
    const prev = fitted[i - 1];
    zoom = prev && prev.m.id === p.m.id ? !zoom : false; // within one take: alternate 100 % / 112 %
    return seg(p.m, p.r, zoom ? { scale: 112, note: "punch-in" } : {});
  });
}

function documentary(media: PlanMedia[], c: Ctx): PlanSegment[] {
  const pieces: { m: PlanMedia; r: Range }[] = [];
  for (const { m, parts } of goodParts(media.filter((x) => x.kind === "video"), c, true)) {
    const a = c.by[m.id];
    const cuts = [0, ...(a?.scenes ?? []).filter((t) => t > 0.5 && t < m.duration - 0.5), m.duration];
    for (let i = 0; i < cuts.length - 1; i++) {
      const scene = parts.map((p) => intersect(p, { start: cuts[i], end: cuts[i + 1] })).filter((x): x is Range => !!x);
      const sp = m.hasAudio ? speechPieces(scene, a, { minSilence: 1.2, pad: 0.3, minPiece: 1, join: 0.3 }) : scene.filter((r) => r.end - r.start >= 1);
      c.silenceRemoved += total(scene) - total(sp);
      for (const r of sp) pieces.push({ m, r });
    }
  }
  const fitted = fitToTarget(pieces, c.options.targetSeconds ?? 0, c.by);
  // J / L cuts where the clip changes: the next clip's sound leads in (J), or this one's runs on (L), in turn, where the
  // media has the half second of handle it needs
  const out = fitted.map((p) => seg(p.m, p.r));
  let j = true;
  for (let i = 0; i + 1 < fitted.length; i++) {
    const a = fitted[i], b = fitted[i + 1];
    if (a.m.id === b.m.id || !a.m.hasAudio || !b.m.hasAudio || a.r.end - a.r.start < 2 || b.r.end - b.r.start < 2) continue;
    const canJ = b.r.start >= 0.5, canL = a.m.duration - a.r.end >= 0.5;
    if ((j && canJ) || (!canL && canJ)) out[i + 1].soundLead = 0.5;
    else if (canL) out[i].soundTail = 0.5;
    else continue;
    j = !j;
  }
  return out;
}

function beatGrid(c: Ctx, T: number): { cuts: number[]; period: number; fromMusic: boolean } {
  const music = c.options.music && c.options.music !== "none" && c.options.music !== "ai" ? c.by[c.options.music] : undefined;
  const beats = (music?.beats ?? []).filter((b) => b > 0.05 && b < T - 0.3);
  if (beats.length >= 4) {
    const diffs = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
    const period = diffs[diffs.length >> 1] || 0.5;
    const every = Math.min(8, Math.max(1, Math.round(1.8 / period)));
    const cuts = [0, ...beats.filter((_, i) => (i + 1) % every === 0), T].filter((t, i, a) => i === 0 || t - a[i - 1] >= 0.4);
    if (T - cuts[cuts.length - 2] < 0.4) cuts.splice(cuts.length - 2, 1);
    return { cuts: cuts.map(r3), period, fromMusic: true };
  }
  const step = 2;
  const cuts: number[] = [];
  for (let t = 0; t < T - 0.5; t += step) cuts.push(r3(t));
  cuts.push(r3(T));
  return { cuts, period: 0.5, fromMusic: false };
}

/** The best window of `len` s inside `parts` (motion, then energy), not overlapping what was used. */
function liveliest(m: PlanMedia, parts: Range[], len: number, used: Range[], a: MediaAnalysis | undefined): Range | null {
  let best: Range | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const p of parts) {
    if (p.end - p.start < len - 1e-6) continue;
    for (let t = p.start; t + len <= p.end + 1e-6; t += 0.5) {
      const w = { start: t, end: t + len };
      if (used.some((u) => intersect(u, w))) continue;
      const mo = curveMean(a?.motion, w.start, w.end), en = curveMean(a?.energy, w.start, w.end);
      const s = (Number.isFinite(mo) ? mo : 0) * 10 + (Number.isFinite(en) ? (en + 60) / 60 : 0) * 0.5 - t * 1e-4; // earlier wins a tie
      if (s > bestScore) { bestScore = s; best = w; }
    }
  }
  void m;
  return best;
}

function montage(media: PlanMedia[], c: Ctx, T: number): { segments: PlanSegment[]; cuts: number[]; period: number } {
  const pool = goodParts(media.filter((x) => x.kind === "video" || x.kind === "image"), c, false).filter((x) => x.m.kind === "image" || total(x.parts) >= 0.5);
  const grid = beatGrid(c, T);
  if (!grid.fromMusic) c.notes.push("No beats to cut to (no music chosen, or none found): a cut every 2 s");
  const used = new Map<string, Range[]>();
  const out: PlanSegment[] = [];
  if (!pool.length) return { segments: out, cuts: grid.cuts, period: grid.period };
  let k = 0;
  for (let i = 0; i < grid.cuts.length - 1; i++) {
    const L = grid.cuts[i + 1] - grid.cuts[i];
    let placed = false;
    for (let tries = 0; tries < pool.length && !placed; tries++) {
      const { m, parts } = pool[(k + tries) % pool.length];
      if (m.kind === "image") { out.push({ ...seg(m, { start: 0, end: L }), sound: false, kenBurns: kb(out.length) }); placed = true; k += tries + 1; break; }
      const u = used.get(m.id) ?? [];
      let w = liveliest(m, parts, L, u, c.by[m.id]);
      let speed = 1;
      if (!w) {
        // not enough left at full speed: slow the longest unused part down to fill the beat (no slower than half speed)
        const free = subtract(parts, u).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
        if (free && free.end - free.start >= L * 0.5) { w = { start: free.start, end: free.end }; speed = Math.max(0.5, (free.end - free.start) / L); w.end = w.start + L * speed; }
      }
      if (!w) continue;
      u.push(w);
      used.set(m.id, u);
      const s = seg(m, w, { speed: r3(speed), sound: false });
      s.duration = r3(L);
      if (out.length % 4 === 3 && L >= 1.2 && speed === 1) { s.ramp = "slowmo_burst"; s.note = "speed ramp"; }
      out.push(s);
      placed = true;
      k += tries + 1;
    }
    if (!placed) { c.notes.push(`Ran out of fresh footage after ${r3(grid.cuts[i])} s`); break; }
  }
  return { segments: out, cuts: grid.cuts, period: grid.period };
}

/** Ken Burns in turn: push in to the right, pull out to the left. */
const kb = (i: number): PlanSegment["kenBurns"] => (i % 2 === 0
  ? { from: { scale: 100, x: 0, y: 0 }, to: { scale: 114, x: 0.03, y: -0.015 } }
  : { from: { scale: 114, x: -0.03, y: 0.015 }, to: { scale: 100, x: 0, y: 0 } });

function highlights(media: PlanMedia[], c: Ctx, T: number): PlanSegment[] {
  const pool = goodParts(media.filter((x) => x.kind === "video"), c, true);
  const maxMotion = Math.max(1e-6, ...pool.flatMap(({ m }) => c.by[m.id]?.motion ?? [0]));
  const W = Math.min(5, Math.max(2, T / 6));
  const cands: { m: PlanMedia; w: Range; score: number; order: number }[] = [];
  pool.forEach(({ m, parts }, mi) => {
    const a = c.by[m.id];
    for (const p of parts) for (let t = p.start; t + W <= p.end + 1e-6; t += 0.5) {
      const w = { start: t, end: t + W };
      const speech = m.hasAudio ? 1 - silenceIn(a, w) / W : 0.3;
      const en = curveMean(a?.energy, w.start, w.end), mo = curveMean(a?.motion, w.start, w.end);
      const score = 0.45 * speech + 0.35 * (Number.isFinite(en) ? Math.min(1, Math.max(0, (en + 60) / 50)) : 0.3) + 0.2 * (Number.isFinite(mo) ? Math.min(1, mo / maxMotion) : 0);
      cands.push({ m, w, score, order: mi * 1e6 + t });
    }
  });
  cands.sort((a, b) => b.score - a.score || a.order - b.order);
  const picked: typeof cands = [];
  let len = 0;
  for (const x of cands) {
    if (len >= T - 0.05) break;
    if (picked.some((p) => p.m.id === x.m.id && intersect({ start: p.w.start - 0.5, end: p.w.end + 0.5 }, x.w))) continue;
    const room = T - len;
    const w = room < W ? { start: x.w.start, end: x.w.start + Math.max(1, room) } : x.w;
    picked.push({ ...x, w });
    len += w.end - w.start;
  }
  return picked.sort((a, b) => a.order - b.order).map((p) => seg(p.m, p.w, { cover: true, note: `score ${r3(p.score)}` }));
}

function slideshow(media: PlanMedia[], c: Ctx): { segments: PlanSegment[]; per: number } {
  const pool = goodParts(media.filter((x) => x.kind === "image" || x.kind === "video"), c, false);
  const n = pool.length;
  if (!n) return { segments: [], per: 4 };
  const music = c.options.music && !["none", "ai"].includes(c.options.music) ? c.by[c.options.music] : undefined;
  let per = 4;
  if ((c.options.targetSeconds ?? 0) > 0) per = c.options.targetSeconds! / n;
  else if (music?.duration && music.duration > 0) per = Math.min(8, Math.max(2.5, music.duration / n));
  // on the beats: whole numbers of beats per photo
  const beats = music?.beats ?? [];
  if (beats.length >= 4) {
    const diffs = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
    const period = diffs[diffs.length >> 1];
    if (period > 0.2) per = Math.max(1, Math.round(per / period)) * period;
  }
  per = Math.min(10, Math.max(1.5, r3(per)));
  const segments = pool.map(({ m, parts }, i) => {
    if (m.kind === "image") return { ...seg(m, { start: 0, end: per }), sound: false, kenBurns: kb(i) };
    const p = parts.find((r) => r.end - r.start >= per) ?? parts[0];
    const end = Math.min(p.end, p.start + per);
    return seg(m, { start: p.start, end }, { sound: false, kenBurns: kb(i) });
  });
  return { segments, per };
}

/** The plan. `media` are the edit's candidates; `analysis` per media id; options as the dialog or the tool chose. */
export function planAutoEdit(media: PlanMedia[], analysis: MediaAnalysis[] | Record<string, MediaAnalysis>, options: AutoEditOptions): Plan {
  const style = styleById(options.style);
  const by = toMap(analysis);
  const format = options.format ?? style.format;
  const { width, height } = formatSize(format);
  const fps = options.fps && options.fps > 0 ? options.fps : 25;
  const musicId = options.music && !["none", "ai", ""].includes(options.music) ? options.music : null;
  const music = musicId ? media.find((m) => m.id === musicId) : undefined;
  const ordered = orderMedia(media.filter((m) => m.id !== musicId), by, options.order);
  const picture = ordered.filter((m) => m.kind !== "audio");
  const clipsIn = picture.length;
  let target = options.targetSeconds && options.targetSeconds > 0 ? options.targetSeconds : style.target;
  if (style.maxTarget) target = Math.min(target || style.target, style.maxTarget);
  const c: Ctx = { by, options: { ...options, targetSeconds: target }, notes: [], dropped: [], silenceRemoved: 0, badRemoved: 0 };

  let segments: PlanSegment[] = [];
  const transitions: PlanTransition[] = [];
  const titles: PlanTitle[] = [];
  const beds: PlanAudioBed[] = [];
  const proposals: string[] = [];
  const choice = options.transitions ?? style.transitions;
  const moodId = options.mood === "none" ? null : options.mood ?? style.defaultMood;

  if (style.id === "talking_head") segments = talkingHead(ordered, c);
  else if (style.id === "documentary") segments = documentary(ordered, c);
  else if (style.id === "highlights") segments = highlights(ordered, c, Math.max(5, target || 30));
  else if (style.id === "montage") {
    const T = options.targetSeconds && options.targetSeconds > 0 ? options.targetSeconds : music?.duration ? Math.min(music.duration, 180) : style.target;
    const r = montage(ordered, c, T);
    segments = r.segments;
  } else segments = slideshow(ordered, c).segments;

  // times on the timeline: back to back
  let t = 0;
  for (const s of segments) { s.at = r3(t); t += s.duration; }
  const length = r3(t);

  // transitions at the cuts
  const cutsAt = segments.slice(1).map((s, i) => ({ at: s.at, change: s.mediaId !== segments[i].mediaId }));
  if (choice !== "none" && choice !== "cuts") {
    for (const [i, x] of cutsAt.entries()) {
      if (style.id === "montage") {
        if (choice === "style" && i % 4 !== 3) continue;
        transitions.push({ at: x.at, type: choice === "soft" ? "fade" : "fade", duration: 0.25, track: "video" });
      } else if (style.id === "documentary") {
        if (x.change) transitions.push({ at: x.at, type: "fade", duration: 0.5, track: "video" });
      } else if (style.id === "slideshow") {
        transitions.push({ at: x.at, type: "fade", duration: r3(Math.min(0.8, segments[i].duration / 3, segments[i + 1].duration / 3)), track: "video" });
      } else if (choice === "soft" && x.change) transitions.push({ at: x.at, type: "fade", duration: 0.3, track: "video" });
    }
  }

  // titles
  if (style.id === "documentary") {
    const seen = new Set<string>();
    for (const s of segments) {
      if (seen.has(s.mediaId)) continue;
      seen.add(s.mediaId);
      const m = media.find((x) => x.id === s.mediaId)!;
      titles.push({ text: prettyName(m.name), at: s.at, duration: r3(Math.min(3, s.duration)), position: "lower_third", kind: "lower_third" });
    }
  }
  if (style.id === "highlights" && segments.length) {
    const first = segments[0];
    const line = (by[first.mediaId]?.transcript ?? []).find((x) => x.end > first.in && x.start < first.out)?.text?.trim();
    const hook = (options.title?.trim() || line || "Watch this").slice(0, 60);
    titles.push({ text: hook, at: 0, duration: r3(Math.min(2.5, length)), position: "top", kind: "hook" });
  } else if (options.title?.trim() && segments.length) {
    titles.push({ text: options.title.trim().slice(0, 80), at: 0, duration: r3(Math.min(3, length)), position: "center", kind: "hook" });
  }

  // captions from the transcripts (local Whisper ran during the analysis)
  let captions: PlanCue[] = [];
  const wantCaptions = options.captions ? options.captions !== "none" : style.captions;
  if (wantCaptions) {
    captions = captionCues(segments, by, style.id === "highlights" ? 4 : 0);
    if (!captions.length && segments.some((s) => s.sound)) c.notes.push("No captions: there was no transcript (install local Whisper in Tools, or use the paid captions tool after)");
  }

  // music and ambience beds
  if (music && length > 0) {
    const role = style.id === "documentary" ? "ambience" : "music";
    const len = Math.min(length, music.duration || length);
    beds.push({ mediaId: music.id, in: 0, duration: r3(len), at: 0, role, gainDb: role === "ambience" ? -20 : style.id === "talking_head" || style.id === "highlights" ? -18 : -3,
      fadeIn: role === "ambience" ? 1 : 0, fadeOut: r3(Math.min(2, len / 4)) });
    if (music.duration && music.duration < length - 0.5) c.notes.push(`The music (${r3(music.duration)} s) is shorter than the edit (${length} s)`);
  } else if (style.id === "documentary" && length > 0) {
    const amb = ordered.find((m) => m.kind === "audio" && /amb|room|tone|atmos|wild/i.test(m.name));
    if (amb) beds.push({ mediaId: amb.id, in: 0, duration: r3(Math.min(length, amb.duration || length)), at: 0, role: "ambience", gainDb: -20, fadeIn: 1, fadeOut: 2 });
    else c.notes.push("No ambience bed: add a room-tone or ambience recording (or choose one as the music)");
  }
  if (options.music === "ai") proposals.push(`AI music for ${length} s${moodId ? ` (${moodId})` : ""}: after the edit, run the Music tool (it's priced and needs your approval)`);
  if (style.music === "needed" && !music && options.music !== "ai") c.notes.push("Montage works best with music: choose a track (or AI music) to cut to its beats");

  const used = new Set(segments.map((s) => s.mediaId));
  const sourceLength = r3(picture.reduce((s, m) => s + (m.kind === "image" ? 0 : m.duration), 0));
  const silenceRemoved = r3(c.silenceRemoved);
  return {
    style: style.id, name: `Auto edit · ${options.folder?.trim() || "clips"} · ${style.name}`, width, height, fps,
    segments, transitions, titles, captions, beds, mood: moodId, markers: [],
    voiceFx: style.id === "talking_head" ? ["voice_enhance", "speech_level"] : style.id === "highlights" || style.id === "documentary" ? ["voice_enhance"] : [],
    dialogue: segments.some((s) => s.sound),
    proposals,
    summary: { clipsIn, clipsUsed: used.size, cuts: Math.max(0, segments.length - 1), silenceRemoved, dropped: c.dropped, badRemoved: r3(c.badRemoved), length,
      sourceLength, notes: c.notes },
  };
}

/** One paragraph for a model or the preview: clips used, cuts, silence removed, length. */
export function describePlan(p: Plan): string {
  const s = p.summary;
  const bits = [`${p.name}: ${s.clipsUsed} of ${s.clipsIn} clips, ${s.cuts} cuts, ${r3(s.length)} s long (from ${r3(s.sourceLength)} s of footage)`];
  if (s.silenceRemoved > 0.05) bits.push(`${r3(s.silenceRemoved)} s of silence removed`);
  if (s.badRemoved > 0.05) bits.push(`${r3(s.badRemoved)} s of bad picture or sound cut`);
  if (s.dropped.length) bits.push(`left out: ${s.dropped.map((d) => `${d.name} (${d.reason})`).join(", ")}`);
  if (p.transitions.length) bits.push(`${p.transitions.length} transitions`);
  if (p.titles.length) bits.push(`${p.titles.length} title${p.titles.length === 1 ? "" : "s"}`);
  if (p.captions.length) bits.push(`${p.captions.length} captions`);
  if (p.beds.length) bits.push(p.beds.map((b) => `${b.role} bed`).join(", "));
  if (p.mood) bits.push(`mood ${p.mood}`);
  return `${bits.join("; ")}.${s.notes.length ? ` Notes: ${s.notes.join(". ")}.` : ""}${p.proposals.length ? ` Next: ${p.proposals.join("; ")}.` : ""}`;
}
