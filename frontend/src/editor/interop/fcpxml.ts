/**
 * Final Cut Pro 7 XML (xmeml version 4), the file Premiere Pro, Audition, DaVinci Resolve and FCP 7 exchange
 * (docs/EDITOR.md §12). Written from Apple's "Final Cut Pro XML Interchange Format" and what Premiere's
 * File → Export → Final Cut Pro XML writes:
 *  - times are frames: clip start / end on the sequence's <rate>, in / out on the clip's (written = the sequence's);
 *    an NTSC rate is the integer timebase plus <ntsc>TRUE</ntsc>.
 *  - a clip next to a transition has start or end −1 and its in / out reach into the transition (Apple's rule).
 *  - each <file> is written in full once, then referenced as <file id="…"/>; nested sequences the same way.
 *  - speed: Premiere's "Time Remap" filter (speed %, reverse); levels and pan: "Audio Levels" (linear gain) and
 *    "Audio Pan" with keyframes (<when> = the media frame, so they move with a slip); opacity: "Opacity".
 *  - transitions: Cross Dissolve, Dip to Color Dissolve, Cross Fade (+3dB) / (0dB); fades on clip edges as edge
 *    transitions (start-black / end-black) or, next to another clip, in the level keyframes.
 *  - markers with a <color>; a clip's role (Dialogue, Music, SFX, Ambience) or colour label in <labels><label2>.
 * What has no slot (effects, motion, speed ramps, other transitions, track volume / effects, titles' styles) is kept in
 * "Tatvam: <name>" markers with the exact data as JSON, which the importer reads back. Pure.
 */
import type { EditProject, EffectInstance, Keyframe, Param, Sequence, TimelineClip, Transition } from "../model/types.ts";
import {
  asRole, dbToLin, defaultTitleSpec, fpsExact, fpsFromRate, hexToRgb, kindOfPath, LABELS, linToDb, MARKER_COLORS,
  noteMarker, pathToUrl, PREMIERE_MARKER_COLORS, r6, rampAverage, rateOf, readNote, rgbToHex, roleLabel, roleOf, toTimecode, isDropFrame,
  trackEffects, trackRole, masterEffects, urlToPath, uuidOf, valueAt, clipRole, type TatvamNote, type TrackNote,
} from "./common.ts";
import type { IrClip, IrDoc, IrMarker, IrMedia, IrSequence, IrTrack, IrTransition } from "./ir.ts";
import { FileTable, prepareSequence, sequencesUsed, transitionKind, transitionRange, opacityIsDefault, type ExportOptions, type XFile, type XItem, type XSeq } from "./prepare.ts";
import { boolOf, descendants, kid, kids, numOf, parseXml, path, txt, XmlWriter, type XNode } from "./xml.ts";

export interface FcpExportOptions extends ExportOptions {
  /** Audition's flavour: written the same way (Audition opens xmeml as a multitrack session); only the label differs. */
  audition?: boolean;
}
export interface FcpExportResult { text: string; warnings: string[]; files: XFile[] }

const TITLE_LABEL = "Title", COLOR_LABEL = "Colour matte", ADJUST_LABEL = "Adjustment layer";

function rate(w: XmlWriter, fps: number) {
  const r = rateOf(fps);
  w.start("rate").leaf("timebase", r.timebase).leaf("ntsc", r.ntsc).end();
}
function color(w: XmlWriter, tag: string, hex: string) {
  const [r, g, b] = hexToRgb(hex);
  w.start(tag).leaf("alpha", 255).leaf("red", r).leaf("green", g).leaf("blue", b).end();
}
function timecode(w: XmlWriter, fps: number, frame = 0) {
  w.start("timecode");
  rate(w, fps);
  w.leaf("string", toTimecode(frame, fps)).leaf("frame", frame).leaf("displayformat", isDropFrame(fps) ? "DF" : "NDF").end();
}

// ── export ───────────────────────────────────────────────────────────────────

export function toFcpXml(project: EditProject, sequenceId: string, opts: FcpExportOptions = {}): FcpExportResult {
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const root = project.sequences.find((s) => s.id === sequenceId);
  if (!root) throw new Error("That sequence isn't in the edit");
  const files = new FileTable(project, opts, warn);
  const seqs = sequencesUsed(project, sequenceId);
  const xo: FcpExportOptions = { ...opts, fadesAsTransitions: true };
  const views = new Map<string, XSeq>(seqs.map((s) => [s.id, prepareSequence(project, s, files, s === root ? xo : { ...xo, stems: undefined, videoTracks: undefined }, warn)]));
  // stills: one length for their <file> (the longest any clip uses)
  const stillLen = new Map<string, number>();
  for (const v of views.values()) for (const t of v.tracks) for (const it of t.items) {
    if (it.file?.kind === "image") stillLen.set(it.file.key, Math.max(stillLen.get(it.file.key) ?? 0, Math.ceil(it.srcIn + it.span) + 1));
  }
  const seqId = new Map(seqs.map((s, i) => [s.id, `sequence-${i + 1}`]));
  const fileId = new Map<string, string>();
  const written = new Set<string>();
  let clipN = 0, genN = 0;
  const w = new XmlWriter();
  w.raw("<!DOCTYPE xmeml>");
  w.start("xmeml", { version: 4 });

  const idOfFile = (f: XFile) => {
    let id = fileId.get(f.key);
    if (!id) { id = `file-${fileId.size + 1}`; fileId.set(f.key, id); }
    return id;
  };
  const writeFile = (f: XFile, seqFps: number) => {
    const id = idOfFile(f);
    if (written.has(id)) { w.empty("file", { id }); return; }
    written.add(id);
    const fFps = f.kind === "video" ? f.fps : seqFps;
    const dur = f.kind === "image" ? stillLen.get(f.key) ?? 1 : Math.max(0, Math.round(f.seconds * fpsExact(fFps)));
    w.start("file", { id }).leaf("name", f.name);
    if (f.path) w.leaf("pathurl", pathToUrl(f.path, "localhost"));
    rate(w, fFps);
    w.leaf("duration", dur);
    timecode(w, fFps);
    w.start("media");
    if (f.kind !== "audio") {
      w.start("video").start("samplecharacteristics");
      rate(w, fFps);
      w.leaf("width", f.width || root.width).leaf("height", f.height || root.height).leaf("anamorphic", false).leaf("pixelaspectratio", "square").leaf("fielddominance", "none");
      w.end().end();
    }
    if (f.kind === "audio" || (f.kind === "video" && f.hasAudio)) {
      w.start("audio").start("samplecharacteristics").leaf("depth", 16).leaf("samplerate", f.sampleRate || 48000).end().leaf("channelcount", Math.max(1, f.channels || 2)).end();
    }
    w.end().end();
  };

  const writeSequence = (seq: Sequence) => {
    const id = seqId.get(seq.id)!;
    if (written.has(id)) { w.empty("sequence", { id }); return; }
    written.add(id);
    const v = views.get(seq.id)!;
    const fps = seq.fps;
    w.start("sequence", { id }).leaf("uuid", uuidOf(`${project.id}/${seq.id}`)).leaf("duration", v.end);
    rate(w, fps);
    w.leaf("name", seq.name);
    // ids for every item first (links point across tracks)
    const ids = new Map<string, string>();
    for (const t of v.tracks) for (const it of t.items) {
      if (it.what === "file" || it.what === "nested") ids.set(it.clip.id, `clipitem-${++clipN}`);
      else if (it.what !== "gap") ids.set(it.clip.id, `generatoritem-${++genN}`);
    }
    const seqNotes: { at: number; label: string; note: TatvamNote }[] = [...v.notes];
    w.start("media").start("video").start("format").start("samplecharacteristics");
    rate(w, fps);
    w.leaf("width", seq.width).leaf("height", seq.height).leaf("anamorphic", false).leaf("pixelaspectratio", "square").leaf("fielddominance", "none").leaf("colordepth", 24);
    w.end().end();
    for (const t of v.tracks.filter((x) => x.kind === "video")) writeTrack(v, t, ids, seqNotes);
    w.end().start("audio").leaf("numOutputChannels", 2).start("format").start("samplecharacteristics").leaf("depth", 16).leaf("samplerate", 48000).end().end();
    w.start("outputs").start("group").leaf("index", 1).leaf("numchannels", 2).leaf("downmix", 0).start("channel").leaf("index", 1).end().start("channel").leaf("index", 2).end().end().end();
    for (const t of v.tracks.filter((x) => x.kind === "audio")) writeTrack(v, t, ids, seqNotes);
    w.end().end();
    timecode(w, fps);
    // track settings FCP has no place for
    const tnotes: TrackNote[] = [];
    for (const t of seq.tracks) {
      const n: TrackNote = { kind: t.kind, index: t.index };
      let any = false;
      const def = `${t.kind === "video" ? "V" : "A"}${t.index + 1}`;
      if (t.name !== def) { n.name = t.name; any = true; }
      if (t.volume) { n.volume = t.volume; any = true; }
      if (t.pan) { n.pan = t.pan; any = true; }
      if (t.solo) { n.solo = true; any = true; }
      const role = trackRole(t);
      if (role) { n.role = role; any = true; }
      const fx = trackEffects(t);
      if (fx.length) { n.effects = structuredClone(fx); any = true; }
      if (any) tnotes.push(n);
    }
    const mfx = masterEffects(seq);
    if (tnotes.length || mfx.length) {
      if (tnotes.some((n) => n.volume || n.pan)) warn("Track volume and pan aren't part of FCP XML: they're kept in a \"Tatvam: Tracks\" marker (the clips' own levels are written)");
      if (tnotes.some((n) => n.effects) || mfx.length) warn("Track and master effects aren't part of FCP XML: they're kept in a \"Tatvam: Tracks\" marker");
      seqNotes.unshift({ at: 0, label: "Tracks", note: { kind: "tracks", tracks: tnotes, ...(mfx.length ? { masterEffects: structuredClone(mfx) } : {}) } });
    }
    for (const m of seq.markers) writeMarker(m.frame, m.duration, m.name, m.comment ?? "", m.color);
    for (const n of seqNotes) { const mk = noteMarker(n.label, n.note); writeMarker(n.at, 0, mk.name, mk.comment, "#fb7185"); }
    w.end();
  };

  const writeMarker = (frame: number, duration: number, name: string, comment: string, hex?: string) => {
    w.start("marker").leaf("comment", comment).leaf("name", name).leaf("in", Math.round(frame)).leaf("out", duration > 0 ? Math.round(frame + duration) : -1);
    if (hex) color(w, "color", hex);
    w.end();
  };

  const writeTrack = (v: XSeq, t: XSeq["tracks"][number], ids: Map<string, string>, seqNotes: { at: number; label: string; note: TatvamNote }[]) => {
    const audio = t.kind === "audio";
    const stereo = audio && t.items.some((x) => (x.file?.channels ?? 2) >= 2);
    w.start("track", audio ? { premiereTrackType: stereo ? "Stereo" : "Mono" } : undefined);
    const items = t.items.filter((x) => x.what !== "gap");
    const has = new Set(items.map((x) => x.clip.id));
    const done = new Set<string>();
    // the exact transition, when the XML one isn't it, rides on a clip marker (the incoming clip's, else the outgoing's)
    const noted = new Set<string>();
    for (const it of items) {
      for (const tr of [it.tin, it.tout]) {
        if (!tr || noted.has(tr.id) || tr.id.startsWith("fi_") || tr.id.startsWith("fo_")) continue;
        noted.add(tr.id);
        const k = transitionKind(tr.type);
        if (k.exact && !(tr.params && Object.keys(tr.params).length) && (!tr.easing || tr.easing === "linear")) continue;
        const target = items.find((x) => x.clip.id === tr.toClipId && x.what !== "title" && x.what !== "color" && x.what !== "adjustment")
          ?? items.find((x) => x.clip.id === tr.fromClipId && x.what !== "title" && x.what !== "color" && x.what !== "adjustment");
        if (!target) continue;
        target.notes.push({ label: "Transition", note: { kind: "transition", side: target.clip.id === tr.toClipId ? "in" : "out", type: tr.type,
          ...(tr.params ? { params: tr.params } : {}), easing: tr.easing, alignment: tr.alignment } });
      }
    }
    for (const it of items) {
      if (it.tin && !done.has(it.tin.id) && (!it.tin.fromClipId || !has.has(it.tin.fromClipId))) {
        if (it.tin.fromClipId) { warn(`The transition into "${it.clip.name}" comes from a clip that isn't written; it's written as a fade in`); }
        writeTransition(v, t.kind, { ...it.tin, fromClipId: undefined, alignment: "start", at: it.start });
        done.add(it.tin.id);
      }
      writeItem(v, it, ids, seqNotes);
      if (it.tout && !done.has(it.tout.id)) {
        const toThere = it.tout.toClipId && has.has(it.tout.toClipId);
        if (it.tout.toClipId && !toThere) warn(`The transition out of "${it.clip.name}" goes to a clip that isn't written; it's written as a fade out`);
        writeTransition(v, t.kind, toThere ? it.tout : { ...it.tout, toClipId: undefined, alignment: "end", at: it.end });
        done.add(it.tout.id);
      }
    }
    for (const tr of t.transitions) if (!done.has(tr.id)) warn("A transition whose clips aren't written was left out");
    w.leaf("enabled", !(audio ? t.track.muted : t.track.hidden)).leaf("locked", t.track.locked);
    if (audio) w.leaf("outputchannelindex", 1);
    w.end();
  };

  const writeTransition = (v: XSeq, kind: "video" | "audio", tr: Transition) => {
    const [x0, x1] = transitionRange(tr);
    const edgeIn = !tr.fromClipId, edgeOut = !tr.toClipId;
    const alignment = edgeIn ? "start-black" : edgeOut ? "end-black" : tr.alignment;
    const k = transitionKind(tr.type);
    if (kind === "video" && (k.kind === "xfade0db" || k.kind === "xfade3db")) { warn("An audio transition on a video track was written as a cross dissolve"); }
    w.start("transitionitem").leaf("start", x0).leaf("end", x1).leaf("alignment", alignment);
    rate(w, v.fps);
    w.start("effect");
    if (kind === "audio") {
      const zero = k.kind === "xfade0db";
      w.leaf("name", zero ? "Cross Fade (0dB)" : "Cross Fade (+3dB)").leaf("effectid", zero ? "KGAudioTransCrossFade0dB" : "KGAudioTransCrossFade3dB")
        .leaf("effectcategory", "audiotransition").leaf("effecttype", "transition").leaf("mediatype", "audio");
      if (!k.exact) warn(`"${tr.type.replace(/^audio:/, "")}" crossfades have no FCP XML equivalent: written as Cross Fade (+3dB)`);
    } else if (k.kind === "dip") {
      w.leaf("name", "Dip to Color Dissolve").leaf("effectid", "Dip to Color Dissolve").leaf("effectcategory", "Dissolve").leaf("effecttype", "transition").leaf("mediatype", "video")
        .leaf("wipecode", 0).leaf("wipeaccuracy", 100).leaf("startratio", 0).leaf("endratio", 1).leaf("reverse", false);
      w.start("parameter").leaf("parameterid", "color").leaf("name", "Color");
      color(w, "value", k.color ?? "#000000");
      w.end();
    } else {
      w.leaf("name", "Cross Dissolve").leaf("effectid", "Cross Dissolve").leaf("effectcategory", "Dissolve").leaf("effecttype", "transition").leaf("mediatype", "video")
        .leaf("wipecode", 0).leaf("wipeaccuracy", 100).leaf("startratio", 0).leaf("endratio", 1).leaf("reverse", false);
      if (!k.exact) warn(`"${tr.type}" has no FCP XML equivalent: written as a Cross Dissolve (the original is kept in a "Tatvam: Transition" marker)`);
    }
    w.end().end();
  };

  const writeItem = (v: XSeq, it: XItem, ids: Map<string, string>, seqNotes: { at: number; label: string; note: TatvamNote }[]) => {
    const c = it.clip;
    const fps = v.fps;
    const audio = it.kind === "audio";
    if (it.what === "title" || it.what === "color" || it.what === "adjustment") {
      writeGenerator(v, it, ids.get(c.id)!, seqNotes);
      return;
    }
    // cut-to-cut source, then reaching into the transitions (Apple's −1 rule)
    const pre = it.tin && it.tin.fromClipId ? it.tin.at - transitionRange(it.tin)[0] : 0;
    const post = it.tout && it.tout.toClipId ? transitionRange(it.tout)[1] - it.tout.at : 0;
    const lo = it.srcIn, hi = it.srcIn + it.span;
    let inF = it.reverse ? lo - post * it.speed : lo - pre * it.speed;
    let outF = it.reverse ? hi + pre * it.speed : hi + post * it.speed;
    if (inF < -0.5) { warn(`"${c.name}" has no media before its transition: Premiere will shorten that transition`); inF = 0; }
    if (Number.isFinite(it.available) && outF > it.available + 0.5) {
      warn(`"${c.name}" has no media after its ${it.tout ? "transition" : "out point"}: Premiere will shorten it`);
      outF = it.available;
    }
    w.start("clipitem", { id: ids.get(c.id)!, ...(audio && (it.file?.channels ?? 2) >= 2 ? { premiereChannelType: "stereo" } : {}) });
    if (it.file) w.leaf("masterclipid", `masterclip-${idOfFile(it.file).slice(5)}`);
    w.leaf("name", c.name || it.file?.name || it.nested?.name || "Clip").leaf("enabled", c.enabled !== false);
    const avail = it.file?.kind === "image" ? stillLen.get(it.file.key) ?? 1 : Number.isFinite(it.available) ? Math.round(it.available) : Math.round(outF);
    w.leaf("duration", avail);
    rate(w, fps);
    w.leaf("start", it.tin ? -1 : it.start).leaf("end", it.tout ? -1 : it.end).leaf("in", Math.round(inF)).leaf("out", Math.round(outF));
    if (!audio) {
      w.leaf("alphatype", "none").leaf("pixelaspectratio", "square").leaf("anamorphic", false);
      if (c.motion?.blend && c.motion.blend !== "normal") w.leaf("compositemode", c.motion.blend);
    }
    if (it.file) writeFile(it.file, fps);
    else if (it.nested) writeSequence(it.nested);
    if (audio) w.start("sourcetrack").leaf("mediatype", "audio").leaf("trackindex", 1).end();
    // filters
    if (Math.abs(it.speed - 1) > 1e-6 || it.reverse) writeTimeRemap(audio, it.speed, it.reverse);
    if (!audio && !opacityIsDefault(c)) writeParamFilter("Opacity", "opacity", "motion", "video", "opacity", "opacity", 0, 100, c.motion.opacity, (x) => x, it);
    if (audio && c.audio) writeLevels(it);
    if (!audio && c.audio && !c.linkId) warn(`The sound of "${c.name}" (a clip on a video track) isn't written: put it on an audio track to keep it`);
    // links
    if (c.linkId) {
      const group = v.tracks.flatMap((t) => t.items.filter((x) => x.clip.linkId === c.linkId && ids.has(x.clip.id)));
      if (group.length > 1) {
        for (const g of group) {
          const tr = v.tracks.find((t) => t.items.includes(g))!;
          w.start("link").leaf("linkclipref", ids.get(g.clip.id)!).leaf("mediatype", g.kind).leaf("trackindex", tr.index + 1)
            .leaf("clipindex", tr.items.filter((x) => x.what !== "gap").indexOf(g) + 1);
          if (g.kind === "audio") w.leaf("groupindex", 1);
          w.end();
        }
      }
    }
    const role = clipRole(c);
    const label = role ? roleLabel(role) : c.colorLabel && LABELS.includes(c.colorLabel) ? c.colorLabel[0].toUpperCase() + c.colorLabel.slice(1) : undefined;
    if (label) w.start("labels").leaf("label2", label).end();
    if (role && c.colorLabel) it.notes.push({ label: "Clip", note: { kind: "clip", colorLabel: c.colorLabel } });
    for (const m of it.markers) writeMarker(m.frame, m.duration, m.name, m.comment ?? "", m.color);
    for (const n of it.notes) { const mk = noteMarker(n.label, n.note); writeMarker(lo, 0, mk.name, mk.comment, "#fb7185"); }
    w.end();
  };

  const writeTimeRemap = (audio: boolean, speed: number, reverse: boolean) => {
    w.start("filter").start("effect").leaf("name", "Time Remap").leaf("effectid", "timeremap").leaf("effectcategory", "motion").leaf("effecttype", "motion")
      .leaf("mediatype", audio ? "audio" : "video");
    const p = (id: string, value: string | number | boolean, min?: number, max?: number) => {
      w.start("parameter", { authoringApp: "PremierePro" }).leaf("parameterid", id).leaf("name", id);
      if (min !== undefined) w.leaf("valuemin", min).leaf("valuemax", max);
      w.leaf("value", value).end();
    };
    p("variablespeed", 0, 0, 1);
    p("speed", r6(speed * 100), -100000, 100000);
    p("reverse", reverse);
    p("frameblending", false);
    w.end().end();
  };

  /** Clip-relative frame f → the <when> FCP keys on (the media frame, in the clip's timebase). */
  const whenOf = (it: XItem, f: number) => Math.round(it.reverse ? it.srcIn + it.span - f * it.speed : it.srcIn + f * it.speed);

  const writeParamFilter = (name: string, id: string, category: string, mediatype: string, paramId: string, paramName: string, min: number, max: number,
    p: Param<number>, map: (x: number) => number, it: XItem) => {
    w.start("filter").start("effect").leaf("name", name).leaf("effectid", id).leaf("effectcategory", category).leaf("effecttype", category).leaf("mediatype", mediatype);
    w.start("parameter", { authoringApp: "PremierePro" }).leaf("parameterid", paramId).leaf("name", paramName).leaf("valuemin", min).leaf("valuemax", max)
      .leaf("value", r6(map(valueAt(p, 0, 0))));
    for (const k of p.keyframes ?? []) w.start("keyframe").leaf("when", whenOf(it, k.frame)).leaf("value", r6(map(Number(k.value)))).end();
    w.end().end().end();
  };

  const writeLevels = (it: XItem) => {
    const a = it.clip.audio!;
    const D = it.clip.duration;
    const fin = it.tin ? 0 : a.fadeIn, fout = it.tout ? 0 : a.fadeOut;
    const gain = a.gain;
    let level: Param<number>;
    if (fin > 0 || fout > 0) {
      // fades next to another clip: in the level keyframes
      const frames = new Set<number>([0, D, ...(gain.keyframes ?? []).map((k) => k.frame).filter((f) => f > 0 && f < D)]);
      if (fin > 0) frames.add(Math.min(D, fin));
      if (fout > 0) frames.add(Math.max(0, D - fout));
      const env = (f: number) => Math.min(fin > 0 ? Math.min(1, f / fin) : 1, fout > 0 ? Math.min(1, (D - f) / fout) : 1);
      const ks: Keyframe<number>[] = [...frames].sort((x, y) => x - y).map((f) => ({ frame: f, value: linToDb(dbToLin(valueAt(gain, f, 0)) * Math.max(0, env(f))), ease: "linear" }));
      level = { value: valueAt(gain, 0, 0), keyframes: ks };
    } else level = gain;
    const keyedOrSet = !!level.keyframes?.length || Math.abs(level.value) > 1e-9;
    if (keyedOrSet) {
      const over = [level.value, ...(level.keyframes ?? []).map((k) => Number(k.value))].some((x) => x > 12.0001);
      if (over) warn(`"${it.clip.name}": levels above +12 dB are written as +12 dB (FCP XML's limit)`);
      writeParamFilter("Audio Levels", "audiolevels", "audiolevels", "audio", "level", "Level", 0, 3.98109, level, (x) => Math.min(3.98109, dbToLin(x)), it);
    }
    const pan = a.pan;
    if (pan.keyframes?.length || Math.abs(pan.value) > 1e-9) writeParamFilter("Audio Pan", "audiopan", "audiopan", "audio", "pan", "Pan", -1, 1, pan, (x) => Math.max(-1, Math.min(1, x)), it);
  };

  const writeGenerator = (v: XSeq, it: XItem, id: string, seqNotes: { at: number; label: string; note: TatvamNote }[]) => {
    const c = it.clip;
    const s = c.source;
    const D = c.duration;
    w.start("generatoritem", { id }).leaf("name", c.name || (s.type === "title" ? s.text.text : s.type)).leaf("enabled", s.type === "adjustment" ? false : c.enabled !== false)
      .leaf("duration", D);
    rate(w, v.fps);
    w.leaf("start", it.tin ? -1 : it.start).leaf("end", it.tout ? -1 : it.end).leaf("in", 0).leaf("out", D).leaf("anamorphic", false).leaf("alphatype", s.type === "title" ? "straight" : "none");
    w.start("effect");
    if (s.type === "title") {
      w.leaf("name", "Text").leaf("effectid", "Text").leaf("effectcategory", "Text").leaf("effecttype", "generator").leaf("mediatype", "video");
      w.start("parameter").leaf("parameterid", "str").leaf("name", "Text").leaf("value", s.text.text).end();
      w.start("parameter").leaf("parameterid", "fontname").leaf("name", "Font").leaf("value", s.text.font).end();
      w.start("parameter").leaf("parameterid", "fontsize").leaf("name", "Size").leaf("valuemin", 0).leaf("valuemax", 1000).leaf("value", s.text.size).end();
      w.start("parameter").leaf("parameterid", "fontcolor").leaf("name", "Font Color");
      color(w, "value", s.text.color);
      w.end();
    } else if (s.type === "color") {
      w.leaf("name", "Color").leaf("effectid", "Color").leaf("effectcategory", "Matte").leaf("effecttype", "generator").leaf("mediatype", "video");
      w.start("parameter").leaf("parameterid", "fillcolor").leaf("name", "Color");
      color(w, "value", s.color);
      w.end();
    } else {
      w.leaf("name", "Slug").leaf("effectid", "slug").leaf("effectcategory", "Matte").leaf("effecttype", "generator").leaf("mediatype", "video");
      warn(`"${c.name}" is an adjustment layer: FCP XML has none, so it's a disabled slug with a "Tatvam: Adjustment layer" marker`);
    }
    w.end();
    if (!opacityIsDefault(c)) writeParamFilter("Opacity", "opacity", "motion", "video", "opacity", "opacity", 0, 100, c.motion.opacity, (x) => x, { ...it, srcIn: 0, span: D, speed: 1, reverse: false });
    w.end();
    const motionNote = it.notes.find((n) => n.note.kind === "motion");
    const label = s.type === "title" ? TITLE_LABEL : s.type === "color" ? COLOR_LABEL : ADJUST_LABEL;
    if (s.type === "title" && (s.text.outline || s.text.background || s.text.look || s.text.karaoke)) warn(`"${c.name}": the title's style is kept in a "Tatvam: Title" marker (other apps show plain text)`);
    seqNotes.push({ at: it.start, label, note: {
      kind: "item", track: `${it.kind === "video" ? "V" : "A"}${it.trackIndex + 1}`, start: it.start, duration: D, source: structuredClone(s), name: c.name,
      ...(c.effects.length ? { effects: structuredClone(c.effects) } : {}), ...(motionNote && motionNote.note.kind === "motion" ? { motion: motionNote.note.motion } : {}),
      ...(c.enabled === false ? { enabled: false } : {}),
    } });
  };

  writeSequence(root);
  // nested sequences are written inside the clips that use them; any not reached still go in (unreachable = none)
  w.end();
  return { text: w.toString(), warnings: [...warnings, ...[...views.values()].flatMap((x) => x.warnings)], files: files.all() };
}

// ── import ───────────────────────────────────────────────────────────────────

export interface FcpImportOptions { name?: string }

function rateFrom(n: XNode | undefined, d: number): number {
  const r = kid(n, "rate");
  if (!r) return d;
  const tb = numOf(r, "timebase", 0);
  if (!(tb > 0)) return d;
  return fpsFromRate(tb, boolOf(r, "ntsc", false));
}

function colorFrom(n: XNode | undefined): string | undefined {
  if (!n) return undefined;
  const r = numOf(n, "red", NaN), g = numOf(n, "green", NaN), b = numOf(n, "blue", NaN);
  if (![r, g, b].every(Number.isFinite)) return undefined;
  // 0..255 (Apple's examples); 0..1 floats also seen
  const k = Math.max(r, g, b) <= 1 && (r % 1 || g % 1 || b % 1) ? 255 : 1;
  return rgbToHex(r * k, g * k, b * k);
}

function markerColor(m: XNode): string | undefined {
  const c = colorFrom(kid(m, "color"));
  if (c) return c;
  const pp = txt(m, "pproColor");
  if (/^\d+$/.test(pp)) {
    const v = Number(pp);
    if (v >= 0 && v < PREMIERE_MARKER_COLORS.length) return PREMIERE_MARKER_COLORS[v][1];
  }
  return undefined;
}

/** The Tatvam transition type for an FCP transition effect. */
function transitionType(eff: XNode | undefined, kind: "video" | "audio", warn: (s: string) => void): string {
  const name = txt(eff, "name"), id = txt(eff, "effectid");
  const s = `${name} ${id}`.toLowerCase();
  if (kind === "audio") {
    if (/0db|constant gain/.test(s)) return "audio:constant_gain";
    if (/exponential/.test(s)) return "audio:exponential";
    if (!/3db|constant power|cross ?fade/.test(s) && s.trim()) warn(`The audio transition "${name || id}" is imported as a constant power crossfade`);
    return "audio:constant_power";
  }
  if (/dip to black/.test(s)) return "fadeblack";
  if (/dip to white/.test(s)) return "fadewhite";
  if (/dip to colou?r/.test(s)) {
    const p = kids(eff, "parameter").find((x) => kid(x, "value") && kid(kid(x, "value"), "red"));
    const c = colorFrom(kid(p, "value"));
    if (c) { const [r, g, b] = hexToRgb(c); if (r + g + b > 600) return "fadewhite"; if (r + g + b > 60) warn(`"${name}" in a colour is imported as a dip to black`); }
    return "fadeblack";
  }
  if (/cross dissolve/.test(s) || !s.trim()) return "fade";
  warn(`The transition "${name || id}" is imported as a cross dissolve`);
  return "fade";
}

interface TrItem { node: XNode; start: number; end: number; cut: number; alignment: string }

export function fromFcpXml(text: string, opts: FcpImportOptions = {}): IrDoc {
  const doc = parseXml(text);
  const xmeml = kid(doc, "xmeml") ?? descendants(doc, "xmeml")[0];
  if (!xmeml) throw new Error("This isn't a Final Cut Pro XML file (no <xmeml>)");
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const fileDefs = new Map<string, XNode>(), seqDefs = new Map<string, XNode>();
  for (const f of descendants(xmeml, "file")) if (f.attrs.id && f.children.length && !fileDefs.has(f.attrs.id)) fileDefs.set(f.attrs.id, f);
  for (const s of descendants(xmeml, "sequence")) if (s.attrs.id && s.children.length && !seqDefs.has(s.attrs.id)) seqDefs.set(s.attrs.id, s);
  // top-level sequences: not inside a clip item
  const tops: XNode[] = [];
  const walk = (n: XNode) => {
    for (const c of n.children) {
      if (c.name === "sequence" && c.children.length) tops.push(c);
      else if (c.name !== "clipitem" && c.name !== "clip") walk(c);
    }
  };
  walk(xmeml);
  if (!tops.length) throw new Error("The XML has no sequence in it");
  const media: IrMedia[] = [];
  const mediaByKey = new Map<string, IrMedia>();
  const sequences: IrSequence[] = [];
  const seqByKey = new Map<string, IrSequence>();
  const unknown = new Set<string>();
  let merged = 0, anon = 0;

  const mediaFor = (fileNode: XNode): IrMedia | null => {
    const def = fileNode.children.length ? fileNode : fileDefs.get(fileNode.attrs.id ?? "");
    if (!def) { warn("A clip points at a file the XML doesn't describe; it was left out"); return null; }
    const key = `file:${def.attrs.id ?? `#${++anon}`}`;
    const have = mediaByKey.get(key);
    if (have) return have;
    const url = txt(def, "pathurl");
    const p = url ? urlToPath(url) : "";
    const name = txt(def, "name") || (p ? p.split(/[\\/]/).pop()! : "Media");
    const fFps = rateFrom(def, 25);
    const dur = numOf(def, "duration", 0);
    const vid = path(def, "media", "video"), aud = path(def, "media", "audio");
    const ext = kindOfPath(p || name);
    const kind: IrMedia["kind"] = ext === "image" ? "image" : vid ? "video" : aud ? "audio" : ext ?? "video";
    const vsc = kid(vid, "samplecharacteristics"), asc = kid(aud, "samplecharacteristics");
    const m: IrMedia = { key, name, path: p, kind, hasAudio: !!aud || kind === "audio" };
    if (dur > 0 && kind !== "image") m.seconds = dur / fpsExact(fFps);
    if (kind === "video") m.fps = rateFrom(vsc, fFps);
    if (vsc) { m.width = numOf(vsc, "width", 0) || undefined; m.height = numOf(vsc, "height", 0) || undefined; }
    if (aud) { const ch = numOf(aud, "channelcount", 0); if (ch > 0) m.channels = ch; const sr = numOf(asc, "samplerate", 0); if (sr > 0) m.sampleRate = sr; }
    if (!p) warn(`"${name}" has no file path in the XML: it's offline until you relink it`);
    media.push(m);
    mediaByKey.set(key, m);
    return m;
  };

  const convertSeq = (node: XNode): IrSequence => {
    const key = `seq:${node.attrs.id ?? `#${++anon}`}`;
    const have = seqByKey.get(key);
    if (have) return have;
    const fps = rateFrom(node, 25);
    const F = fpsExact(fps);
    const vfmt = path(node, "media", "video", "format", "samplecharacteristics");
    const ir: IrSequence = { key, name: txt(node, "name") || "Sequence", fps, width: numOf(vfmt, "width", 1920), height: numOf(vfmt, "height", 1080),
      tracks: [], clips: [], transitions: [], markers: [] };
    seqByKey.set(key, ir);
    sequences.push(ir);
    const itemNotes: Extract<TatvamNote, { kind: "item" }>[] = [];
    let tracksNote: Extract<TatvamNote, { kind: "tracks" }> | null = null;
    for (const m of kids(node, "marker")) {
      const name = txt(m, "name"), comment = txt(m, "comment");
      const note = readNote(name, comment);
      if (note?.kind === "item") { itemNotes.push(note); continue; }
      if (note?.kind === "tracks") { tracksNote = note; continue; }
      const inF = numOf(m, "in", 0), outF = numOf(m, "out", -1);
      const mk: IrMarker = { at: inF, duration: outF > inF ? outF - inF : 0, name, color: markerColor(m) ?? MARKER_COLORS[0] };
      if (comment) mk.comment = comment;
      ir.markers.push(mk);
    }
    const clipRefs = new Map<string, IrClip>();
    const linkOf = new Map<string, string[]>();
    const transNotes: { clip: IrClip; note: Extract<TatvamNote, { kind: "transition" }> }[] = [];
    const seen = new Map<string, number>(); // stereo pairs on two tracks

    for (const kind of ["video", "audio"] as const) {
      const tracks = kids(path(node, "media", kind), "track");
      tracks.forEach((tn, ti) => {
        const tr: IrTrack = { kind, index: ti, enabled: boolOf(tn, "enabled", true), locked: boolOf(tn, "locked", false) };
        ir.tracks.push(tr);
        const items = tn.children.filter((c) => c.name === "clipitem" || c.name === "transitionitem" || c.name === "generatoritem");
        const trans = new Map<XNode, TrItem>();
        for (const it of items) {
          if (it.name !== "transitionitem") continue;
          const k = F / fpsExact(rateFrom(it, fps));
          const start = numOf(it, "start", 0) * k, end = numOf(it, "end", 0) * k;
          const al = txt(it, "alignment").toLowerCase() || "center";
          const cut = al === "start" || al === "start-black" ? start : al === "end" || al === "end-black" ? end : Math.floor((start + end) / 2);
          trans.set(it, { node: it, start, end, cut, alignment: al });
        }
        items.forEach((it, j) => {
          if (it.name === "transitionitem") return;
          const prev = items[j - 1], next = items[j + 1];
          const pt = prev && trans.get(prev), nt = next && trans.get(next);
          const cfps = rateFrom(it, fps);
          const k = F / fpsExact(cfps);
          let start = numOf(it, "start", 0), end = numOf(it, "end", 0);
          const inF = numOf(it, "in", 0), outF = numOf(it, "out", 0);
          const startDash = start < 0, endDash = end < 0;
          // −1: from the transition; the in / out then reach into it
          const extStart = startDash ? (pt ? pt.start : NaN) : start;
          const extEnd = endDash ? (nt ? nt.end : NaN) : end;
          const cutStart = startDash ? (pt ? pt.cut : NaN) : start;
          const cutEnd = endDash ? (nt ? nt.cut : NaN) : end;
          start = cutStart; end = cutEnd;
          const ref = it.attrs.id || `${kind}${ti}:${j}`;
          if (!Number.isFinite(start) || !Number.isFinite(end)) {
            // a −1 with no transition next to it: lengths from the in / out
            const len = Math.max(1, Math.round((outF - inF) * k));
            if (!Number.isFinite(start) && Number.isFinite(end)) start = end - len;
            else if (!Number.isFinite(end) && Number.isFinite(start)) end = start + len;
            else { warn(`"${txt(it, "name")}" has no position on the timeline; it was left out`); return; }
          }
          const es = Number.isFinite(extStart) ? extStart : start, ee = Number.isFinite(extEnd) ? extEnd : end;
          if (end <= start) return;
          if (it.name === "generatoritem") { readGenerator(it, kind, ti, start, end, ref, ir, clipRefs); return; }
          // speed: Premiere's Time Remap filter, else the in / out against the timeline length
          let speed = 1, reverse = false, speedSet = false;
          const filters = kids(it, "filter").map((f) => kid(f, "effect")).filter((e): e is XNode => !!e);
          for (const e of filters) {
            const id = `${txt(e, "effectid")} ${txt(e, "name")}`.toLowerCase();
            if (!/timeremap|time remap/.test(id)) continue;
            for (const p of kids(e, "parameter")) {
              const pid = txt(p, "parameterid").toLowerCase();
              if (pid === "speed") { const v = numOf(p, "value", 100); if (v < 0) reverse = true; if (Math.abs(v) > 1e-6) { speed = Math.abs(v) / 100; speedSet = true; } }
              if (pid === "reverse" && boolOf(p, "value", false)) reverse = true;
              if (pid === "variablespeed" && boolOf(p, "value", false)) warn(`"${txt(it, "name")}" has a variable speed (time remapping) in the XML: it's imported at its constant speed`);
            }
          }
          const srcLen = (outF - inF) * k; // sequence frames of source
          if (!speedSet && ee > es && Math.abs(srcLen - (ee - es)) > 1) speed = srcLen / (ee - es);
          const lo = Math.min(inF, outF) * k;
          const srcCut = reverse ? lo + (ee - end) * speed : lo + (start - es) * speed; // sequence frames of source time
          const clip: IrClip = { ref, kind, track: ti, start, duration: end - start, name: txt(it, "name"), enabled: boolOf(it, "enabled", true) };
          if (Math.abs(speed - 1) > 1e-6) clip.speed = speed;
          if (reverse) clip.reverse = true;
          const fileNode = kid(it, "file"), nestNode = kid(it, "sequence");
          let m: IrMedia | null = null;
          if (nestNode) {
            const def = nestNode.children.length ? nestNode : seqDefs.get(nestNode.attrs.id ?? "");
            if (!def) { warn(`The nested sequence in "${clip.name}" isn't in the XML; it was left out`); return; }
            const ns = convertSeq(def);
            clip.nested = { key: ns.key, in: (srcCut / F) * fpsExact(ns.fps) };
          } else if (fileNode) {
            m = mediaFor(fileNode);
            if (!m) return;
            if (kind === "video" && m.kind === "audio") { warn(`"${clip.name}" is a sound file on a video track; it was left out`); return; }
            clip.media = { key: m.key, in: srcCut / F };
            if (!clip.name) clip.name = m.name;
          } else { warn(`"${clip.name || "A clip"}" has no media in the XML; it was left out`); return; }
          // a stereo pair on two tracks (FCP 7 style) becomes one clip
          if (kind === "audio" && m) {
            const sig = `${m.key}|${Math.round(start)}|${Math.round(end)}|${Math.round(srcCut)}`;
            const st = numOf(kid(it, "sourcetrack"), "trackindex", 1);
            const prevTi = seen.get(sig);
            if (prevTi !== undefined && prevTi !== ti && st > 1) { merged++; clipRefs.set(ref, clipRefs.get(`${sig}#first`)!); return; }
            if (prevTi === undefined) { seen.set(sig, ti); clipRefs.set(`${sig}#first`, clip); }
          }
          // filters: levels, pan, opacity; the rest become notes
          const kf = (p: XNode, map: (v: number) => number): Param<number> => {
            const value = map(numOf(p, "value", NaN));
            const keys = kids(p, "keyframe").map((x) => ({ when: numOf(x, "when", NaN), v: numOf(x, "value", NaN) })).filter((x) => Number.isFinite(x.when) && Number.isFinite(x.v));
            const out: Param<number> = { value: Number.isFinite(value) ? r6(value) : 0 };
            if (keys.length) {
              // <when> on the media (moves with a slip) or, from some writers, from the clip's start
              const media = keys.every((x) => x.when * k >= lo - 1.5 && x.when * k <= Math.max(inF, outF) * k + 1.5) && lo > 0.5;
              out.keyframes = keys.map((x) => ({
                frame: Math.round(media ? (reverse ? (lo + (ee - es) * speed - x.when * k) / speed - (start - es) : (x.when * k - srcCut) / speed) : x.when * k),
                value: r6(map(x.v)), ease: "linear" as const,
              }));
              if (!Number.isFinite(value)) out.value = out.keyframes[0].value;
            }
            return out;
          };
          for (const e of filters) {
            const id = txt(e, "effectid").toLowerCase(), name = txt(e, "name");
            const s = `${id} ${name.toLowerCase()}`;
            if (/timeremap|time remap/.test(s)) continue;
            const params = kids(e, "parameter");
            if (/audiolevels|audio levels|volume/.test(s) && kind === "audio") {
              const p = params.find((x) => /level|volume/i.test(txt(x, "parameterid") || txt(x, "name"))) ?? params[0];
              if (!p) continue;
              const vals = [numOf(p, "value", 1), ...kids(p, "keyframe").map((x) => numOf(x, "value", 1))];
              const isDb = vals.some((v) => v < 0) || numOf(p, "valuemax", 3.98109) > 10;
              clip.gain = kf(p, (v) => (isDb ? v : linToDb(v)));
            } else if (/audiopan|audio pan|^pan| pan$/.test(s) && kind === "audio") {
              const p = params.find((x) => /pan/i.test(txt(x, "parameterid") || txt(x, "name"))) ?? params[0];
              if (!p) continue;
              const vmax = Math.abs(numOf(p, "valuemax", 1)) || 1;
              clip.pan = kf(p, (v) => Math.max(-1, Math.min(1, v / (vmax > 1 ? vmax : 1))));
            } else if (/opacity/.test(s) && kind === "video") {
              const p = params.find((x) => /opacity/i.test(txt(x, "parameterid") || txt(x, "name"))) ?? params[0];
              if (p) clip.opacity = kf(p, (v) => Math.max(0, Math.min(100, v)));
            } else if (/^basic|basic motion/.test(s) && params.every((p) => !kids(p, "keyframe").length && (/(scale)/i.test(txt(p, "parameterid")) ? numOf(p, "value", 100) === 100 : /(rotation)/i.test(txt(p, "parameterid")) ? numOf(p, "value", 0) === 0 : true))) {
              continue; // an untouched Basic Motion (FCP 7 writes one on every clip)
            } else {
              const label = name || id || "Effect";
              unknown.add(label);
              (clip.notes ??= []).push({ name: `${label} (not imported)`, comment: `An effect from the XML that Tatvam doesn't have` });
            }
          }
          const comp = txt(it, "compositemode").toLowerCase();
          if (kind === "video" && ["add", "multiply", "screen", "overlay", "lighten", "darken"].includes(comp)) clip.blend = comp as IrClip["blend"];
          const l2 = txt(kid(it, "labels"), "label2");
          if (l2) {
            const role = roleOf(l2);
            if (role) (clip.extra ??= {}).role = role;
            else if (LABELS.includes(l2.toLowerCase())) (clip.extra ??= {}).colorLabel = l2.toLowerCase();
          }
          // markers: Tatvam data, or the media's markers
          for (const mk of kids(it, "marker")) {
            const name = txt(mk, "name"), comment = txt(mk, "comment");
            const note = readNote(name, comment);
            if (note) { applyClipNote(clip, note, transNotes); continue; }
            if (!m) continue;
            const mi = numOf(mk, "in", 0) / fpsExact(cfps), mo = numOf(mk, "out", -1);
            const at = mi, dur = mo > 0 ? mo / fpsExact(cfps) - mi : 0;
            const list = (m.markers ??= []);
            if (!list.some((x) => Math.abs(x.at - at) < 1e-6 && x.name === name)) list.push({ at, duration: Math.max(0, dur), name, color: markerColor(mk) ?? MARKER_COLORS[0], ...(comment ? { comment } : {}) });
          }
          for (const ln of kids(it, "link")) {
            const r = txt(ln, "linkclipref");
            if (r) linkOf.set(ref, [...(linkOf.get(ref) ?? []), r]);
          }
          ir.clips.push(clip);
          clipRefs.set(ref, clip);
        });
        // transitions after the clips are known
        items.forEach((it, j) => {
          const t = trans.get(it);
          if (!t) return;
          const prev = items[j - 1], next = items[j + 1];
          // a clip that ends (starts) away from the transition isn't part of it: a gap is between them
          const away = (n: XNode | undefined, tag: "end" | "start") => !!n && numOf(n, tag, -1) >= 0 && (tag === "end" ? numOf(n, tag, 0) < t.start - 0.5 : numOf(n, tag, 0) > t.end + 0.5);
          const edgeIn = t.alignment === "start-black" || !prev || prev.name === "transitionitem" || away(prev, "end");
          const edgeOut = t.alignment === "end-black" || !next || next.name === "transitionitem" || away(next, "start");
          const same = (c: IrClip | undefined) => (c && c.kind === kind && c.track === ti ? c : undefined);
          const from = !edgeIn ? same(clipRefs.get(prev.attrs.id || `${kind}${ti}:${j - 1}`)) : undefined;
          const to = !edgeOut ? same(clipRefs.get(next.attrs.id || `${kind}${ti}:${j + 1}`)) : undefined;
          if (!from && !to) return;
          const d = Math.max(1, Math.round(t.end - t.start));
          let alignment: IrTransition["alignment"]; let at: number;
          if (!from) { alignment = "start"; at = Math.round(t.start); }
          else if (!to) { alignment = "end"; at = Math.round(t.end); }
          else if (Math.round(t.cut) === Math.round(t.start)) { alignment = "start"; at = Math.round(t.start); }
          else if (Math.round(t.cut) === Math.round(t.end)) { alignment = "end"; at = Math.round(t.end); }
          else { alignment = "center"; at = Math.round(t.cut); }
          const x: IrTransition = { kind, track: ti, at, duration: d, alignment, type: transitionType(kid(it, "effect"), kind, warn), from: from?.ref, to: to?.ref };
          ir.transitions.push(x);
        });
      });
    }
    // Tatvam's exact transitions (the XML had the nearest FCP one)
    for (const { clip, note } of transNotes) {
      const x = ir.transitions.find((t) => (note.side === "in" ? t.to === clip.ref : t.from === clip.ref));
      if (!x) continue;
      x.type = note.type;
      if (note.params) x.params = note.params;
      if (note.easing) x.easing = note.easing;
    }
    // links (both directions, any group size)
    const parent = new Map<string, string>();
    const find = (a: string): string => { let r = a; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
    for (const [a, refs] of linkOf) for (const b of refs) { if (!clipRefs.has(b)) continue; const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); }
    const groups = new Map<string, IrClip[]>();
    for (const c of ir.clips) { if (!linkOf.has(c.ref) && !parent.has(c.ref)) continue; const r = find(c.ref); groups.set(r, [...(groups.get(r) ?? []), c]); }
    for (const [r, cs] of groups) if (cs.length > 1) for (const c of cs) c.link = `${key}/${r}`;
    // titles / generators / slugs and unrendered generators from the Tatvam notes
    for (const n of itemNotes) {
      const kind = n.track.startsWith("A") ? "audio" : "video";
      const ti = Math.max(0, parseInt(n.track.slice(1), 10) - 1 || 0);
      const c = ir.clips.find((x) => x.kind === kind && x.track === ti && Math.round(x.start) === Math.round(n.start) && x.source);
      if (c) {
        c.source = n.source;
        if (n.name) c.name = n.name;
        if (n.effects) c.effects = n.effects;
        if (n.motion) (c.extra ??= {}).motion = n.motion;
        if (n.enabled === false) c.enabled = false; else if (n.source.type === "adjustment") c.enabled = true;
      } else if (n.duration && n.duration > 0) {
        ir.clips.push({ ref: `note:${n.track}:${n.start}`, kind, track: ti, start: n.start, duration: n.duration, name: n.name, source: n.source,
          ...(n.effects ? { effects: n.effects } : {}), ...(n.enabled === false ? { enabled: false } : {}) });
      }
    }
    if (tracksNote) {
      for (const t of tracksNote.tracks) {
        let tr = ir.tracks.find((x) => x.kind === t.kind && x.index === t.index);
        if (!tr) { tr = { kind: t.kind, index: t.index }; ir.tracks.push(tr); }
        const extra: NonNullable<IrTrack["extra"]> = {};
        if (t.name) extra.name = t.name;
        if (t.volume) extra.volume = t.volume;
        if (t.pan) extra.pan = t.pan;
        if (t.solo) extra.solo = true;
        const role = asRole(t.role);
        if (role) extra.role = role;
        if (t.effects) extra.effects = t.effects;
        tr.extra = { ...tr.extra, ...extra };
      }
      if (tracksNote.masterEffects) ir.masterEffects = tracksNote.masterEffects;
    }
    return ir;
  };

  const readGenerator = (it: XNode, kind: "video" | "audio", ti: number, start: number, end: number, ref: string, ir: IrSequence,
    clipRefs: Map<string, IrClip>) => {
    const eff = kid(it, "effect");
    const id = `${txt(eff, "effectid")} ${txt(eff, "name")}`.toLowerCase();
    const name = txt(it, "name");
    const enabled = boolOf(it, "enabled", true);
    const params = kids(eff, "parameter");
    const pv = (re: RegExp) => params.find((p) => re.test(txt(p, "parameterid")) || re.test(txt(p, "name")));
    let source: TimelineClip["source"] | null = null;
    if (/\btext\b|title|outline text|scrolling/.test(id)) {
      const spec = defaultTitleSpec(txt(pv(/^str$|^text$/i), "value") || name || "Title");
      const font = txt(pv(/font(name)?$/i), "value"); if (font) spec.font = font;
      const size = numOf(pv(/fontsize|^size$/i), "value", NaN); if (Number.isFinite(size) && size > 0) spec.size = size;
      const col = colorFrom(kid(pv(/fontcolor|font color/i), "value")); if (col) spec.color = col;
      source = { type: "title", text: spec };
    } else if (/color|colour|matte/.test(id)) {
      const p = params.find((x) => kid(kid(x, "value"), "red"));
      source = { type: "color", color: colorFrom(kid(p, "value")) ?? "#000000" };
    } else if (/slug/.test(id)) {
      source = enabled ? { type: "color", color: "#000000" } : { type: "adjustment" };
    } else {
      warn(`The generator "${txt(eff, "name") || name}" isn't one Tatvam has: it's a black matte`);
      source = { type: "color", color: "#000000" };
    }
    const c: IrClip = { ref, kind, track: ti, start, duration: end - start, name: name || "Generator", enabled, source };
    ir.clips.push(c);
    clipRefs.set(ref, c);
  };

  const mainIr = convertSeq(tops[0]);
  for (const t of tops.slice(1)) convertSeq(t);
  if (merged) warn(`${merged} stereo pair${merged === 1 ? " was" : "s were"} merged into stereo clips`);
  if (unknown.size) warn(`Effects Tatvam doesn't have were noted as markers on the clips' media: ${[...unknown].slice(0, 8).join(", ")}${unknown.size > 8 ? " …" : ""}`);
  // used media only
  const used = new Set(sequences.flatMap((s) => s.clips.map((c) => c.media?.key).filter((x): x is string => !!x)));
  return { name: opts.name ?? mainIr.name, sequences, main: mainIr.key, media: media.filter((m) => used.has(m.key)), warnings };
}

function applyClipNote(clip: IrClip, note: TatvamNote, transNotes: { clip: IrClip; note: Extract<TatvamNote, { kind: "transition" }> }[]) {
  switch (note.kind) {
    case "effect": (clip.effects ??= []).push(note.effect as EffectInstance); break;
    case "motion": (clip.extra ??= {}).motion = note.motion; break;
    case "timeRemap": {
      (clip.extra ??= {}).timeRemap = note.timeRemap;
      // the XML speed is the ramp's average: back to the clip's own speed
      const avg = rampAverage({ timeRemap: note.timeRemap, duration: Math.max(1, Math.round(clip.duration)) });
      if (avg > 1e-6) clip.speed = r6((clip.speed ?? 1) / avg);
      break;
    }
    case "transition": transNotes.push({ clip, note }); break;
    case "source": {
      clip.source = note.source;
      delete clip.media;
      break;
    }
    case "clip": {
      if (note.colorLabel) (clip.extra ??= {}).colorLabel = note.colorLabel;
      const role = asRole(note.role);
      if (role) (clip.extra ??= {}).role = role;
      break;
    }
    default: break;
  }
}
