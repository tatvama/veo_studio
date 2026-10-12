/**
 * OpenTimelineIO JSON (.otio; docs/EDITOR.md §12), written to the published core schemas: Timeline.1 → Stack.1 →
 * Track.1 (kind "Video" / "Audio") → Gap.1, Clip.2 (media_references + active_media_reference_key with an
 * ExternalReference.1 / GeneratorReference.1 / MissingReference.1), Transition.1 (in_offset / out_offset around the
 * cut, SMPTE_Dissolve or Custom_Transition), Stack.1 for a nested sequence, LinearTimeWarp.1 / FreezeFrame.1 for speed,
 * Effect.1 for everything else, Marker.2 with OTIO's colour names; RationalTime.1 / TimeRange.1 times at the
 * sequence rate (video sources at the file's own rate).
 * Everything Tatvam needs to come back exactly (motion, levels, fades, effects, transition types, track settings,
 * titles …) is in `metadata.tatvam`, which other OTIO tools keep and ignore. Pure.
 */
import type { EditProject, EffectInstance, Marker, Sequence, TimelineClip, Track } from "../model/types.ts";
import {
  editorFps, fpsExact, generatorOf, GENERATOR_LABELS, MARKER_COLORS, masterEffects, otioColor, otioColorHex, pathToUrl, r6, rampAverage, snapFps,
  trackEffects, trackRole, urlToPath, kindOfPath, baseName, asRole, isMarkerKind,
} from "./common.ts";
import type { IrClip, IrDoc, IrMarker, IrMedia, IrSequence, IrTrack, IrTransition } from "./ir.ts";
import { FileTable, prepareSequence, sequencesUsed, transitionRange, type ExportOptions, type XItem, type XSeq } from "./prepare.ts";

type J = Record<string, unknown>;
const RT = (value: number, rate: number): J => ({ OTIO_SCHEMA: "RationalTime.1", rate: r6(rate), value: r6(value) });
const TR = (start: number, duration: number, rate: number, durRate = rate): J => ({ OTIO_SCHEMA: "TimeRange.1", duration: RT(duration, durRate), start_time: RT(start, rate) });
const item = (schema: string, name: string, extra: J): J => ({ OTIO_SCHEMA: schema, metadata: {}, name, source_range: null, effects: [], markers: [], enabled: true, ...extra });

export interface OtioResult { text: string; warnings: string[] }

function marker(m: Marker, toUnits: (f: number) => number, rate: number): J {
  return {
    OTIO_SCHEMA: "Marker.2", metadata: { tatvam: { color: m.color, ...(m.kind ? { kind: m.kind } : {}) } }, name: m.name, color: otioColor(m.color),
    marked_range: TR(toUnits(m.frame), toUnits(m.duration), rate), comment: m.comment ?? "",
  };
}

export function toOtio(project: EditProject, sequenceId: string, opts: ExportOptions = {}): OtioResult {
  const root = project.sequences.find((s) => s.id === sequenceId);
  if (!root) throw new Error("That sequence isn't in the edit");
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const files = new FileTable(project, opts, warn);
  const views = new Map<string, XSeq>(sequencesUsed(project, sequenceId).map((s) => [s.id, prepareSequence(project, s, files, s === root ? opts : { ...opts, stems: undefined, videoTracks: undefined }, warn)]));

  const clipMeta = (c: TimelineClip, extra: J = {}): J => {
    const { id, trackId, start, duration, source, effects, ...rest } = c;
    void trackId; void start; void duration; void effects;
    return { tatvam: { clipId: id, clip: structuredClone(rest), ...(source.type !== "media" ? { source: structuredClone(source) } : {}), ...extra } };
  };
  const effectsOf = (it: XItem): J[] => {
    const out: J[] = [];
    if (it.speed < 1e-6) out.push({ OTIO_SCHEMA: "FreezeFrame.1", metadata: {}, name: "", effect_name: "FreezeFrame", time_scalar: 0 });
    else if (Math.abs(it.speed - 1) > 1e-6 || it.reverse) out.push({ OTIO_SCHEMA: "LinearTimeWarp.1", metadata: {}, name: "", effect_name: "LinearTimeWarp", time_scalar: r6((it.reverse ? -1 : 1) * it.speed) });
    for (const e of it.clip.effects ?? []) out.push({ OTIO_SCHEMA: "Effect.1", metadata: { tatvam: { effect: structuredClone(e) } }, name: e.type, effect_name: e.type });
    return out;
  };

  const writeSeq = (seq: Sequence, range?: { start: number; duration: number }): J => {
    const v = views.get(seq.id)!;
    const R = fpsExact(seq.fps);
    const children: J[] = [];
    for (const t of v.tracks) children.push(writeTrack(v, t, R));
    const stack = item("Stack.1", seq === root ? "tracks" : seq.name, {
      children, source_range: range ? TR(range.start, range.duration, R) : null,
      markers: seq.markers.map((m) => marker(m, (f) => f, R)),
    });
    if (seq !== root) stack.metadata = { tatvam: { sequence: { id: seq.id, name: seq.name, fps: seq.fps, width: seq.width, height: seq.height } } };
    for (const n of v.notes) warn(`"${n.note.kind === "item" ? n.note.name : n.label}" wasn't rendered: it's a gap in the OTIO (kept in its metadata)`);
    return stack;
  };

  const writeTrack = (v: XSeq, t: XSeq["tracks"][number], R: number): J => {
    const tr: Track = t.track;
    const children: J[] = [];
    let cursor = 0;
    const meta: J = { locked: tr.locked, muted: tr.muted, hidden: tr.hidden, solo: tr.solo, volume: tr.volume, pan: tr.pan, name: tr.name };
    const role = trackRole(tr);
    if (role) meta.role = role;
    const fx = trackEffects(tr);
    if (fx.length) meta.effects = structuredClone(fx);
    const items = t.items;
    const gapNotes = v.notes.filter((n) => n.note.kind === "item" && n.note.track === `${t.kind === "video" ? "V" : "A"}${t.index + 1}`);
    const gap = (len: number, metadata: J = {}) => { children.push(item("Gap.1", "", { source_range: TR(0, len, R), metadata })); cursor += len; };
    const trans = (x: NonNullable<XItem["tin"]>, inOff: number, outOff: number) => {
      const plain = x.type === "fade" || x.type.startsWith("audio:constant");
      children.push({ OTIO_SCHEMA: "Transition.1", metadata: { tatvam: { type: x.type, alignment: x.alignment, easing: x.easing, ...(x.params ? { params: x.params } : {}) } },
        name: plain ? "" : x.type, in_offset: RT(inOff, R), out_offset: RT(outOff, R), transition_type: plain ? "SMPTE_Dissolve" : "Custom_Transition" });
    };
    const done = new Set<string>();
    for (const it of items) {
      const c = it.clip;
      if (it.start > cursor) gap(it.start - cursor);
      if (it.start < cursor) { warn(`"${c.name}" overlaps the clip before it on ${tr.name}: it's moved after it in the OTIO`); }
      // a fade in from nothing (after a gap or at the start)
      if (it.tin && !done.has(it.tin.id)) {
        if (!it.tin.fromClipId) {
          if (!children.length || children[children.length - 1].OTIO_SCHEMA !== "Gap.1") gap(0);
          trans(it.tin, 0, it.tin.duration);
        }
        done.add(it.tin.id);
      }
      const R6 = (x: number) => r6(x);
      let clip: J;
      if (it.what === "nested" && it.nested) {
        const ns = it.nested;
        const NR = fpsExact(ns.fps);
        clip = writeSeq(ns, { start: R6((it.srcIn / R) * NR), duration: R6((c.duration * it.speed / R) * NR) });
        (clip as J).name = c.name || ns.name;
        (clip as J).effects = effectsOf(it);
        (clip as J).metadata = { ...((clip as J).metadata as J), ...clipMeta(c) };
        (clip as J).enabled = c.enabled !== false;
      } else {
        let ref: J;
        let start = it.srcIn, rate = R;
        if (it.what === "file" && it.file) {
          const f = it.file;
          if (f.kind === "video") { rate = fpsExact(f.fps); start = (it.srcIn / R) * rate; }
          ref = f.path
            ? { OTIO_SCHEMA: "ExternalReference.1", metadata: {}, name: f.name, available_range: f.kind === "image" ? null : TR(0, f.seconds * rate, rate), available_image_bounds: null,
              target_url: pathToUrl(f.path, "triple") }
            : { OTIO_SCHEMA: "MissingReference.1", metadata: {}, name: f.name, available_range: null, available_image_bounds: null };
        } else {
          const s = c.source;
          const gen = generatorOf(c);
          ref = { OTIO_SCHEMA: "GeneratorReference.1", metadata: {}, name: "", available_range: null, available_image_bounds: null,
            generator_kind: s.type === "color" ? "SolidColor" : s.type === "title" ? "Text" : s.type === "adjustment" ? "Adjustment" : gen ? (GENERATOR_LABELS[gen.generator] ?? gen.generator) : "Generator",
            parameters: s.type === "color" ? { color: s.color } : s.type === "title" ? { text: s.text.text } : {} };
          start = 0;
        }
        clip = item("Clip.2", c.name || it.file?.name || "Clip", {
          source_range: TR(start, c.duration, rate, R), effects: effectsOf(it), enabled: c.enabled !== false,
          media_references: { DEFAULT_MEDIA: ref }, active_media_reference_key: "DEFAULT_MEDIA",
          markers: it.markers.map((m) => marker(m, (f) => (rate === R ? f : (f / R) * rate), rate)),
          metadata: clipMeta(c),
        });
      }
      children.push(clip);
      cursor = Math.max(cursor, it.end);
      if (it.tout && !done.has(it.tout.id)) {
        const [x0, x1] = transitionRange(it.tout);
        if (it.tout.toClipId && items.some((x) => x.clip.id === it.tout!.toClipId && x.start === it.end)) trans(it.tout, it.tout.at - x0, x1 - it.tout.at);
        else { trans(it.tout, it.tout.duration, 0); const next = items.find((x) => x.start >= it.end); if (!next || next.start === it.end) gap(0); }
        done.add(it.tout.id);
      }
    }
    if (gapNotes.length) meta.items = gapNotes.map((n) => n.note);
    return item("Track.1", tr.name, { kind: t.kind === "video" ? "Video" : "Audio", children, enabled: !(t.kind === "audio" ? tr.muted : tr.hidden), metadata: { tatvam: meta } });
  };

  const stack = writeSeq(root);
  const mfx = masterEffects(root);
  const timeline: J = {
    OTIO_SCHEMA: "Timeline.1",
    metadata: { tatvam: { version: 1, fps: root.fps, width: root.width, height: root.height, ...(mfx.length ? { masterEffects: structuredClone(mfx) } : {}) } },
    name: root.name, global_start_time: RT(0, fpsExact(root.fps)), tracks: stack,
  };
  return { text: JSON.stringify(timeline, null, 4) + "\n", warnings };
}

// ── import ───────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is J => !!v && typeof v === "object" && !Array.isArray(v);
const schema = (o: unknown) => (isObj(o) && typeof o.OTIO_SCHEMA === "string" ? o.OTIO_SCHEMA.split(".")[0] : "");
const secs = (t: unknown): number => (isObj(t) && Number(t.rate) > 0 && Number.isFinite(Number(t.value)) ? Number(t.value) / Number(t.rate) : 0);
const rateOfRt = (t: unknown): number => (isObj(t) && Number(t.rate) > 0 ? Number(t.rate) : 0);
const tatvam = (o: J): J => (isObj(o.metadata) && isObj((o.metadata as J).tatvam) ? ((o.metadata as J).tatvam as J) : {});

export interface OtioImportOptions { name?: string }

export function fromOtio(text: string, opts: OtioImportOptions = {}): IrDoc {
  let root: unknown;
  try { root = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new Error("This isn't an OpenTimelineIO file (not JSON)"); }
  if (schema(root) === "SerializableCollection" && isObj(root) && Array.isArray(root.children)) root = (root.children as unknown[]).find((c) => schema(c) === "Timeline");
  if (schema(root) !== "Timeline" || !isObj(root)) throw new Error("This isn't an OpenTimelineIO timeline");
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const tm = tatvam(root);
  // the rate: Tatvam's, the global start time's, else the first time in the file
  let rate = Number(tm.fps) > 0 ? fpsExact(Number(tm.fps)) : rateOfRt(root.global_start_time);
  if (!rate) {
    const find = (o: unknown): number => { if (isObj(o)) { if (o.OTIO_SCHEMA === "RationalTime.1" && Number(o.rate) > 0) return Number(o.rate); for (const v of Object.values(o)) { const r = find(v); if (r) return r; } } else if (Array.isArray(o)) for (const v of o) { const r = find(v); if (r) return r; } return 0; };
    rate = find(root) || 24;
  }
  const media: IrMedia[] = [];
  const mediaBy = new Map<string, IrMedia>();
  const sequences: IrSequence[] = [];
  const unknown = new Set<string>();
  let n = 0;
  const seqByTatvam = new Map<string, IrSequence>();

  const mediaFor = (ref: J, kind: "video" | "audio", clipName: string): IrMedia | null => {
    const s = schema(ref);
    if (s === "ExternalReference" || s === "ImageSequenceReference") {
      const url = String(ref.target_url ?? ref.target_url_base ?? "");
      const p = urlToPath(url);
      const key = `url:${p.toLowerCase()}`;
      let m = mediaBy.get(key);
      if (!m) {
        const ext = kindOfPath(p);
        const ar = ref.available_range as J | null;
        m = { key, name: String(ref.name || "") || baseName(p) || clipName, path: p, kind: ext === "image" ? "image" : ext === "audio" || (kind === "audio" && ext !== "video") ? "audio" : "video", hasAudio: kind === "audio" || ext !== "image" };
        if (isObj(ar)) {
          const d = secs(ar.duration);
          if (d > 0) m.seconds = d;
          const r = rateOfRt(ar.duration);
          if (m.kind === "video" && r > 0 && r < 1000) m.fps = snapFps(r);
        }
        media.push(m);
        mediaBy.set(key, m);
      }
      if (kind === "audio") m.hasAudio = true;
      return m;
    }
    if (s === "MissingReference" || !s) {
      const key = `missing:${clipName.toLowerCase()}`;
      let m = mediaBy.get(key);
      if (!m) {
        m = { key, name: clipName || "Media", path: "", kind: kind === "audio" ? "audio" : "video", hasAudio: kind === "audio" };
        warn(`"${clipName}" has no media in the OTIO file: it's offline until you relink it`);
        media.push(m);
        mediaBy.set(key, m);
      }
      return m;
    }
    return null;
  };

  const convertStack = (stack: J, name: string, key: string): IrSequence => {
    const st = tatvam(stack);
    const sq = isObj(st.sequence) ? (st.sequence as J) : {};
    const fps = editorFps(Number(sq.fps) > 0 ? Number(sq.fps) : snapFps(rate)).fps;
    const R = fpsExact(fps);
    const ir: IrSequence = { key, name: String(sq.name ?? name ?? "Sequence"), fps, width: Number(sq.width) || Number(tm.width) || 1920, height: Number(sq.height) || Number(tm.height) || 1080,
      tracks: [], clips: [], transitions: [], markers: [] };
    sequences.push(ir);
    const fr = (t: unknown) => secs(t) * R;
    for (const m of Array.isArray(stack.markers) ? stack.markers : []) if (isObj(m)) ir.markers.push(readMarker(m, (sec) => sec * R, 0));
    const counts = { video: 0, audio: 0 };
    for (const t of Array.isArray(stack.children) ? stack.children : []) {
      if (schema(t) !== "Track" || !isObj(t)) { if (schema(t) === "Stack") warn("A stack directly inside a stack was skipped"); continue; }
      const kind = String(t.kind).toLowerCase() === "audio" ? "audio" : "video";
      const ti = counts[kind]++;
      const tt = tatvam(t);
      const irt: IrTrack = { kind, index: ti, enabled: t.enabled !== false, name: typeof t.name === "string" && t.name ? t.name : undefined };
      const extra: NonNullable<IrTrack["extra"]> = {};
      if (tt.locked === true) irt.locked = true;
      if (tt.solo === true) extra.solo = true;
      if (Number.isFinite(Number(tt.volume)) && Number(tt.volume)) extra.volume = Number(tt.volume);
      if (Number.isFinite(Number(tt.pan)) && Number(tt.pan)) extra.pan = Number(tt.pan);
      const role = asRole(tt.role);
      if (role) extra.role = role;
      if (Array.isArray(tt.effects)) extra.effects = tt.effects as EffectInstance[];
      if (Object.keys(extra).length) irt.extra = extra;
      ir.tracks.push(irt);
      let cursor = 0;
      const kids = Array.isArray(t.children) ? (t.children as unknown[]).filter(isObj) : [];
      const placed: (IrClip | null)[] = [];
      kids.forEach((ch) => {
        const s = schema(ch);
        if (s === "Transition") { placed.push(null); return; }
        const sr = isObj(ch.source_range) ? (ch.source_range as J) : null;
        let dur = sr ? fr(sr.duration) : 0;
        if (s === "Gap") { cursor += dur; placed.push(null); return; }
        if (s !== "Clip" && s !== "Stack") { warn(`An OTIO ${s || "item"} was skipped`); placed.push(null); return; }
        const meta = tatvam(ch);
        const name = String(ch.name ?? "");
        const c: IrClip = { ref: `o${++n}`, kind, track: ti, start: Math.round(cursor), duration: 0, name, enabled: ch.enabled !== false };
        // speed
        for (const e of Array.isArray(ch.effects) ? (ch.effects as unknown[]).filter(isObj) : []) {
          const es = schema(e);
          if (es === "LinearTimeWarp") { const k = Number(e.time_scalar); if (Number.isFinite(k) && k !== 0) { c.speed = Math.abs(k); if (k < 0) c.reverse = true; } }
          else if (es === "FreezeFrame") { (c.extra ??= {}).timeRemap = { value: 0 }; }
          else if (isObj(tatvam(e).effect)) (c.effects ??= []).push(tatvam(e).effect as unknown as EffectInstance);
          else { const nm = String(e.effect_name || e.name || "Effect"); unknown.add(nm); (c.notes ??= []).push({ name: `${nm} (not imported)`, comment: "An effect from the OTIO file that Tatvam doesn't have" }); }
        }
        if (isObj(meta.clip)) Object.assign((c.extra ??= {}), meta.clip as Partial<TimelineClip>);
        if (c.extra?.speed !== undefined) { c.speed = Number(c.extra.speed) || c.speed; }
        if (c.extra?.reverse !== undefined) c.reverse = !!c.extra.reverse;
        if (c.extra) { delete c.extra.speed; delete c.extra.reverse; delete c.extra.enabled; delete c.extra.name; delete c.extra.effects; }
        // ramps are written at their average: back to the clip's own speed
        if (c.extra?.timeRemap && c.speed) {
          const avg = rampAverage({ timeRemap: c.extra.timeRemap, duration: Math.max(1, Math.round(dur)) });
          if (avg > 1e-6 && !meta.clip) c.speed = r6(c.speed / avg);
        }
        if (s === "Stack") {
          const sk = isObj(tatvam(ch).sequence) ? String((tatvam(ch).sequence as J).id ?? "") : "";
          let ns = sk ? seqByTatvam.get(sk) : undefined;
          if (!ns) { ns = convertStack(ch, name, `stack:${sk || ++n}`); if (sk) seqByTatvam.set(sk, ns); }
          const nsR = fpsExact(ns.fps);
          c.nested = { key: ns.key, in: sr ? secs(sr.start_time) * nsR : 0 };
          if (!sr) dur = Math.max(0, ...ns.clips.map((x) => x.start + x.duration)) * (R / nsR);
        } else {
          const refs = isObj(ch.media_references) ? (ch.media_references as J) : null;
          const ref = (refs ? refs[String(ch.active_media_reference_key ?? "DEFAULT_MEDIA")] ?? Object.values(refs)[0] : ch.media_reference) as J | undefined;
          const src = isObj(meta.source) ? (meta.source as unknown as TimelineClip["source"]) : null;
          if (src) c.source = src;
          else if (schema(ref) === "GeneratorReference") {
            const gk = String((ref as J).generator_kind ?? "").toLowerCase();
            const params = isObj((ref as J).parameters) ? ((ref as J).parameters as J) : {};
            if (gk.includes("color") || gk.includes("solid")) c.source = { type: "color", color: typeof params.color === "string" ? params.color : "#000000" };
            else { warn(`The OTIO generator "${(ref as J).generator_kind}" is a black matte here`); c.source = { type: "color", color: "#000000" }; }
          } else {
            const m = mediaFor(isObj(ref) ? ref : {}, kind, name);
            if (!m) { placed.push(null); cursor += dur; return; }
            const ar = isObj(ref) && isObj((ref as J).available_range) ? ((ref as J).available_range as J) : null;
            const base = ar ? secs(ar.start_time) : 0;
            c.media = { key: m.key, in: Math.max(0, (sr ? secs(sr.start_time) : 0) - base) };
            if (!sr && ar) dur = secs(ar.duration) * R;
            if (!c.name) c.name = m.name;
            for (const mk of Array.isArray(ch.markers) ? (ch.markers as unknown[]).filter(isObj) : []) {
              const x = readMarker(mk, (sec) => sec, base);
              (m.markers ??= []).some((y) => Math.abs(y.at - x.at) < 1e-6 && y.name === x.name) || m.markers!.push(x);
            }
          }
        }
        c.duration = Math.round(dur);
        cursor += dur;
        if (c.duration >= 1) { ir.clips.push(c); placed.push(c); } else placed.push(null);
      });
      // transitions: around the cut between their neighbours
      let pos = 0;
      kids.forEach((ch, j) => {
        const s = schema(ch);
        if (s !== "Transition") { const sr = isObj(ch.source_range) ? (ch.source_range as J) : null; pos += sr ? fr(sr.duration) : (placed[j]?.duration ?? 0); return; }
        const inO = Math.round(fr(ch.in_offset)), outO = Math.round(fr(ch.out_offset));
        const from = placed[j - 1] ?? undefined, to = placed[j + 1] ?? undefined;
        if (!from && !to) return;
        const tt2 = tatvam(ch);
        const d = Math.max(1, inO + outO);
        let alignment: IrTransition["alignment"] = typeof tt2.alignment === "string" && ["center", "start", "end"].includes(tt2.alignment) ? (tt2.alignment as IrTransition["alignment"]) : inO === 0 ? "start" : outO === 0 ? "end" : "center";
        if (!from) alignment = "start";
        if (!to) alignment = "end";
        let at = Math.round(pos);
        if (alignment === "center" && inO !== Math.floor(d / 2)) at = Math.round(pos - inO + Math.floor(d / 2));
        const type = typeof tt2.type === "string" ? tt2.type : kind === "audio" ? "audio:constant_power" : "fade";
        if (!tt2.type && String(ch.transition_type) !== "SMPTE_Dissolve") warn(`The OTIO transition "${ch.name || ch.transition_type}" is a cross dissolve here`);
        const x: IrTransition = { kind, track: ti, at, duration: d, alignment, type, from: from?.ref, to: to?.ref };
        if (isObj(tt2.params)) x.params = tt2.params as Record<string, unknown>;
        if (typeof tt2.easing === "string") x.easing = tt2.easing as IrTransition["easing"];
        ir.transitions.push(x);
      });
      // unrendered generators kept in the track's metadata
      if (Array.isArray(tt.items)) {
        for (const nt of tt.items as J[]) {
          if (!isObj(nt) || !isObj(nt.source) || !(Number(nt.duration) > 0)) continue;
          ir.clips.push({ ref: `o${++n}`, kind, track: ti, start: Number(nt.start) || 0, duration: Number(nt.duration), name: String(nt.name ?? "Generator"), source: nt.source as unknown as TimelineClip["source"],
            ...(Array.isArray(nt.effects) ? { effects: nt.effects as EffectInstance[] } : {}) });
        }
      }
    }
    return ir;
  };

  const tracks = isObj(root.tracks) ? (root.tracks as J) : null;
  if (!tracks) throw new Error("The OTIO timeline has no tracks");
  const main = convertStack(tracks, String(root.name ?? "Timeline"), "main");
  main.name = String(root.name ?? main.name);
  if (Array.isArray(tm.masterEffects)) main.masterEffects = tm.masterEffects as EffectInstance[];
  if (unknown.size) warn(`Effects Tatvam doesn't have were noted as markers on the clips' media: ${[...unknown].slice(0, 8).join(", ")}`);
  return { name: opts.name ?? main.name, sequences, main: main.key, media, warnings };
}

/** A Marker.2: `scale` turns seconds into the IR's units (frames for a sequence, seconds for media), `base` = the
 *  media's own start time, which marks on a clip count from. */
function readMarker(m: J, scale: (seconds: number) => number, base: number): IrMarker {
  const r = isObj(m.marked_range) ? (m.marked_range as J) : {};
  const mt = tatvam(m);
  const out: IrMarker = { at: Math.max(0, scale(secs(r.start_time) - base)), duration: Math.max(0, scale(secs(r.duration))), name: String(m.name ?? ""),
    color: typeof mt.color === "string" ? mt.color : m.color ? otioColorHex(String(m.color)) : MARKER_COLORS[0] };
  if (typeof m.comment === "string" && m.comment) out.comment = m.comment;
  if (isMarkerKind(mt.kind)) out.kind = mt.kind;
  return out;
}
