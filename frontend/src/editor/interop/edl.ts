/**
 * CMX 3600 EDLs (docs/EDITOR.md §12): one video track (V1 by default) and up to four audio tracks (A, A2, A3, A4),
 * cuts, dissolves (two lines under one event number: the outgoing source held at the dissolve's start, then
 * "D nnn" with the incoming source), fades from and to black ("BL"), speed changes as M2 lines (the source's frames
 * per second, negative = reverse), "* FROM CLIP NAME:" / "* TO CLIP NAME:" / "* SOURCE FILE:" comments and
 * "* LOC:" marker comments. Timecode: drop-frame at 29.97 / 59.94 ("FCM: DROP FRAME", HH:MM:SS;FF), else
 * non-drop. Source timecode counts from the start of each file. A "* TATVAM FPS:" comment keeps the exact rate
 * (23.976 vs 24) for the way back. Pure.
 */
import type { EditProject } from "../model/types.ts";
import {
  baseName, editorFps, fpsExact, isDropFrame, kindOfPath, MARKER_COLORS, nominalFps, otioColor, otioColorHex, parseTimecode, r6, snapFps, toTimecode,
} from "./common.ts";
import type { IrClip, IrDoc, IrMarker, IrMedia, IrSequence, IrTransition } from "./ir.ts";
import { FileTable, prepareSequence, transitionRange, type ExportOptions, type XItem } from "./prepare.ts";

export interface EdlExportOptions extends ExportOptions {
  title?: string;
  /** Record timecode of the sequence's first frame (frames; default 0 = 00:00:00:00). */
  startTc?: number;
  /** The video track that goes in (0 = V1). */
  videoTrack?: number;
}
export interface EdlResult { text: string; warnings: string[] }

const AUDIO_FIELDS = ["A", "A2", "A3", "A4"];

export function toEdl(project: EditProject, sequenceId: string, opts: EdlExportOptions = {}): EdlResult {
  const seq = project.sequences.find((s) => s.id === sequenceId);
  if (!seq) throw new Error("That sequence isn't in the edit");
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const files = new FileTable(project, opts, warn);
  const v = prepareSequence(project, seq, files, { ...opts, fadesAsTransitions: true }, warn);
  const fps = seq.fps;
  const df = isDropFrame(fps);
  const off = Math.max(0, Math.round(opts.startTc ?? 0));
  const tc = (f: number) => toTimecode(Math.max(0, Math.round(f)), fps, df);
  const vIndex = opts.videoTrack ?? 0;
  const lines: string[] = [`TITLE: ${(opts.title ?? seq.name).replace(/[\r\n]/g, " ").slice(0, 70)}`, `FCM: ${df ? "DROP FRAME" : "NON-DROP FRAME"}`, `* TATVAM FPS: ${fps}`, ""];
  let ev = 0;
  const num = () => String(++ev).padStart(3, "0");
  const reelOf = (it: XItem | null) => (it ? "AX" : "BL");
  const line = (n: string, reel: string, track: string, type: string, dur: number | null, sIn: number, sOut: number, rIn: number, rOut: number) =>
    `${n}  ${reel.padEnd(8)} ${track.padEnd(5)} ${type.padEnd(4)} ${dur === null ? "   " : String(Math.max(0, Math.round(dur))).padStart(3, "0")} ${tc(sIn)} ${tc(sOut)} ${tc(rIn + off)} ${tc(rOut + off)}`;
  /** Source position (sequence frames of source time) at timeline frame f, also outside the clip (handles). */
  const srcAt = (it: XItem, f: number) => (it.reverse ? it.srcIn + it.span - (f - it.start) * it.speed : it.srcIn + (f - it.start) * it.speed);
  const comments = (from: XItem | null, to?: XItem | null) => {
    const out: string[] = [];
    if (from) out.push(`* FROM CLIP NAME: ${from.clip.name || from.file?.name || "Clip"}`);
    if (to) out.push(`* TO CLIP NAME: ${to.clip.name || to.file?.name || "Clip"}`);
    const src = to ?? from;
    if (src?.file?.path) out.push(`* SOURCE FILE: ${src.file.path}`);
    return out;
  };
  const m2 = (it: XItem, srcIn: number) => {
    if (Math.abs(it.speed - 1) < 1e-6 && !it.reverse) return [];
    const s = (it.reverse ? -1 : 1) * it.speed * nominalFps(fps);
    const str = (s < 0 ? "-" : "") + Math.abs(s).toFixed(1).padStart(5, "0");
    return [`M2   ${reelOf(it).padEnd(8)}       ${str}                ${tc(srcIn)}`];
  };
  const tracks = [
    ...v.tracks.filter((t) => t.kind === "video" && t.index === vIndex).map((t) => ({ t, field: "V" })),
    ...v.tracks.filter((t) => t.kind === "audio" && t.index < 4).map((t) => ({ t, field: AUDIO_FIELDS[t.index] })),
  ];
  for (const t of v.tracks) {
    if (!t.items.length) continue;
    if (t.kind === "video" && t.index !== vIndex) warn(`V${t.index + 1} isn't in the EDL (an EDL has one video track): export V${t.index + 1} on its own, or use XML / OTIO`);
    if (t.kind === "audio" && t.index >= 4) warn(`A${t.index + 1} isn't in the EDL (CMX 3600 has four audio channels)`);
  }
  for (const { t, field } of tracks) {
    const items = t.items.filter((it) => {
      if (it.what === "file" && it.file) return true;
      if (it.what !== "gap") warn(`"${it.clip.name}" (${it.what === "nested" ? "a nested sequence" : it.what}) can't be in an EDL; it was left out`);
      return false;
    });
    const ids = new Set(items.map((x) => x.clip.id));
    for (const it of items) {
      if (it.clip.enabled === false) warn(`"${it.clip.name}" is disabled: it's in the EDL like any other clip`);
      if (it.notes.some((n) => n.note.kind === "effect" || n.note.kind === "motion")) warn(`Effects and motion aren't in an EDL ("${it.clip.name}")`);
      if (it.clip.audio && ((it.clip.audio.fadeIn > 0 && it.tin && !it.tin.id.startsWith("fi_")) || (it.clip.audio.fadeOut > 0 && it.tout && !it.tout.id.startsWith("fo_")))) {
        warn(`"${it.clip.name}": a fade next to a transition isn't in the EDL`);
      }
      if (it.clip.audio && (it.clip.audio.gain.keyframes?.length || it.clip.audio.gain.value || it.clip.audio.pan.value || it.clip.audio.pan.keyframes?.length)) {
        warn("Clip levels and pan aren't in an EDL");
      }
      const cutIn = it.tin && it.tin.fromClipId && ids.has(it.tin.fromClipId) ? it.tin : null;
      const fadeIn = it.tin && !cutIn ? it.tin : null;
      const cutOut = it.tout && it.tout.toClipId && ids.has(it.tout.toClipId) ? it.tout : null;
      const fadeOut = it.tout && !cutOut ? it.tout : null;
      if ((it.tin && it.tin.type !== "fade" && it.tin.type !== "audio:constant_power" && it.tin.type !== "audio:constant_gain" && it.tin.type !== "fadeblack")
        || (it.tout && it.tout.type !== "fade" && it.tout.type !== "audio:constant_power" && it.tout.type !== "audio:constant_gain" && it.tout.type !== "fadeblack")) {
        warn("Transitions other than dissolves are written as dissolves in the EDL");
      }
      // where this clip's own event starts and ends
      const recIn = cutIn ? transitionRange(cutIn)[0] : fadeIn ? fadeIn.at : it.start;
      const recOut = cutOut ? transitionRange(cutOut)[0] : fadeOut ? transitionRange(fadeOut)[0] : it.end;
      const sIn = srcAt(it, recIn), sOut = srcAt(it, recIn) + (recOut - recIn) * it.speed * (it.reverse ? -1 : 1);
      const [lo, hi] = [Math.min(sIn, sOut), Math.max(sIn, sOut)];
      const n = num();
      if (cutIn) {
        const from = items.find((x) => x.clip.id === cutIn.fromClipId)!;
        const x0 = transitionRange(cutIn)[0];
        const fs = srcAt(from, x0);
        lines.push(line(n, reelOf(from), field, "C", null, fs, fs, x0, x0));
        lines.push(line(n, reelOf(it), field, "D", cutIn.duration, lo, hi, recIn, recOut));
        lines.push(...m2(it, lo), ...comments(from, it), "");
      } else if (fadeIn) {
        lines.push(line(n, "BL", field, "C", null, 0, 0, recIn, recIn));
        lines.push(line(n, reelOf(it), field, "D", fadeIn.duration, lo, hi, recIn, recOut));
        lines.push(...m2(it, lo), ...comments(null, it), "");
      } else {
        lines.push(line(n, reelOf(it), field, "C", null, lo, hi, recIn, recOut));
        lines.push(...m2(it, lo), ...comments(it), "");
      }
      if (fadeOut) {
        const x0 = transitionRange(fadeOut)[0];
        const fs = srcAt(it, x0);
        const n2 = num();
        lines.push(line(n2, reelOf(it), field, "C", null, fs, fs, x0, x0));
        lines.push(line(n2, "BL", field, "D", fadeOut.duration, 0, fadeOut.duration, x0, it.end));
        lines.push(...comments(it), "");
      }
    }
  }
  if (!ev) warn("The EDL has no events: the sequence has no clips an EDL can hold");
  for (const m of seq.markers) lines.push(`* LOC: ${tc(m.frame + off)} ${otioColor(m.color).padEnd(7)} ${m.name.replace(/[\r\n]/g, " ")}`);
  return { text: lines.join("\r\n").replace(/(\r\n)+$/, "") + "\r\n", warnings };
}

// ── import ───────────────────────────────────────────────────────────────────

const TC = "(\\d{1,2}[:;.]\\d{2}[:;.]\\d{2}[:;.,]\\d{2,3})";
const EVENT = new RegExp(`^(\\d{1,6})\\s+(\\S+)\\s+(\\S+)\\s+(C|D|W\\d{3}|K[BO]?|K)\\s+(?:(\\d{1,3})\\s+)?${TC}\\s+${TC}\\s+${TC}\\s+${TC}\\s*$`, "i");
const M2 = new RegExp(`^M2\\s+(\\S+)\\s+(-?\\d+(?:\\.\\d+)?)\\s+${TC}\\s*$`, "i");

interface EdlLine { reel: string; field: string; type: string; dur: number; sIn: number; sOut: number; rIn: number; rOut: number }
interface EdlEvent { n: string; lines: EdlLine[]; from?: string; to?: string; file?: string; speed?: number }

export interface EdlImportOptions { fps?: number; name?: string }

export function fromEdl(text: string, opts: EdlImportOptions = {}): IrDoc {
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const raw = text.replace(/^﻿/, "").split(/\r?\n/);
  let title = "", drop = false, fpsComment = 0, maxFF = 0;
  const events: EdlEvent[] = [];
  const locs: { tc: string; color: string; name: string }[] = [];
  let last: EdlEvent | null = null;
  const rawTcs: string[] = [];
  for (const l0 of raw) {
    const l = l0.trim();
    if (!l) continue;
    let m: RegExpExecArray | null;
    if ((m = /^TITLE:\s*(.*)$/i.exec(l))) { title = m[1].trim(); continue; }
    if ((m = /^FCM:\s*(.*)$/i.exec(l))) { drop = /drop/i.test(m[1]) && !/non/i.test(m[1]); continue; }
    if ((m = /^\*\s*TATVAM FPS:\s*([\d.]+)/i.exec(l))) { fpsComment = Number(m[1]); continue; }
    if ((m = /^\*\s*FROM CLIP NAME:\s*(.*)$/i.exec(l))) { if (last) last.from = m[1].trim(); continue; }
    if ((m = /^\*\s*TO CLIP NAME:\s*(.*)$/i.exec(l))) { if (last) last.to = m[1].trim(); continue; }
    if ((m = /^\*\s*SOURCE FILE:\s*(.*)$/i.exec(l))) { if (last) last.file = m[1].trim(); continue; }
    if ((m = new RegExp(`^\\*\\s*LOC:\\s*${TC}\\s+(\\w+)\\s*(.*)$`, "i").exec(l))) { locs.push({ tc: m[1], color: m[2], name: m[3].trim() }); rawTcs.push(m[1]); continue; }
    if (l.startsWith("*")) continue;
    if ((m = M2.exec(l))) { if (last) last.speed = Number(m[2]); continue; }
    if ((m = EVENT.exec(l))) {
      const tcs = [m[6], m[7], m[8], m[9]];
      rawTcs.push(...tcs);
      const ln = { reel: m[2], field: m[3].toUpperCase(), type: m[4].toUpperCase(), dur: m[5] ? Number(m[5]) : 0, tcs } as unknown as EdlLine & { tcs: string[] };
      if (last && last.n === m[1]) last.lines.push(ln);
      else { last = { n: m[1], lines: [ln] }; events.push(last); }
      continue;
    }
    if (/^(SPLIT|SWITCHED|AUD|NOTE|EFFECTS NAME|ASC_)/i.test(l)) continue;
    warn(`A line the EDL reader doesn't know was skipped: ${l.slice(0, 60)}`);
  }
  if (!events.length) throw new Error("This EDL has no events");
  for (const t of rawTcs) { const ff = Number(/(\d{2,3})$/.exec(t)?.[1] ?? 0); maxFF = Math.max(maxFF, ff); }
  if (rawTcs.some((t) => /;/.test(t))) drop = true;
  let fps: number;
  if (fpsComment > 0) fps = snapFps(fpsComment);
  else if (opts.fps) fps = opts.fps;
  else if (drop) fps = maxFF >= 30 ? 59.94 : 29.97;
  else {
    fps = maxFF >= 30 ? 60 : maxFF >= 25 ? 30 : maxFF === 24 ? 25 : 24;
    warn(`The EDL doesn't say its frame rate: read as ${fps} fps`);
  }
  fps = editorFps(fps).fps;
  const F = fpsExact(fps);
  const fr = (s: string) => parseTimecode(s, fps, drop) ?? 0;
  for (const e of events) for (const l of e.lines as (EdlLine & { tcs: string[] })[]) {
    [l.sIn, l.sOut, l.rIn, l.rOut] = l.tcs.map(fr);
  }
  // record timecode usually starts at 00:00:00:00 or 01:00:00:00: the sequence starts at the hour before the first event
  const minRec = Math.min(...events.flatMap((e) => e.lines.map((l) => l.rIn)));
  const hour = Math.round(F * 3600);
  const off = Math.floor(minRec / hour) * hour;

  const media: IrMedia[] = [];
  const mediaBy = new Map<string, IrMedia>();
  const mediaFor = (name: string | undefined, reel: string, file: string | undefined, kind: "video" | "audio"): IrMedia | null => {
    if (reel.toUpperCase() === "BL" || reel.toUpperCase() === "BLACK") return null;
    const key = (file || name || reel).toLowerCase();
    let m = mediaBy.get(key) ?? (name ? media.find((x) => x.name.toLowerCase() === name.toLowerCase()) : undefined);
    if (!m) {
      const nm = name || (file ? baseName(file) : reel);
      const ext = kindOfPath(file || nm);
      m = { key, name: nm, path: file ?? "", kind: kind === "video" ? (ext === "image" ? "image" : "video") : ext === "video" ? "video" : "audio", hasAudio: kind === "audio" };
      if (!file) warn(`"${nm}" has no file path in the EDL: it's offline until you relink it`);
      media.push(m);
    }
    if (file && !m.path) m.path = file;
    if (kind === "video" && m.kind === "audio") m.kind = kindOfPath(m.path || m.name) === "image" ? "image" : "video";
    if (kind === "audio") m.hasAudio = true;
    mediaBy.set(key, m);
    return m;
  };
  const tracksOf = (field: string): { kind: "video" | "audio"; index: number }[] => {
    const f = field.toUpperCase();
    const out: { kind: "video" | "audio"; index: number }[] = [];
    if (f.includes("V") || f === "B") out.push({ kind: "video", index: 0 });
    const a = f.replace(/\/?V$/, "");
    if (f === "B" || a === "A" || a === "A1" || a === "AA") out.push({ kind: "audio", index: 0 });
    else if (/^A[2-9]$/.test(a)) out.push({ kind: "audio", index: Number(a[1]) - 1 });
    else if (a === "NONE" || a === "") { /* video only */ }
    return out;
  };
  const ir: IrSequence = { key: "edl", name: title || opts.name || "EDL", fps, width: 1920, height: 1080, tracks: [], clips: [], transitions: [], markers: [] };
  let ref = 0;
  for (const e of events) {
    // M2 gives the source's frames per second with one decimal (2× at 29.97 = "059.9"): snap to a round speed
    const nice = (x: number) => { const c = Math.round(x * 100) / 100; return c > 0 && Math.abs(x - c) / c < 0.005 ? c : r6(x); };
    const speed = e.speed !== undefined && Number.isFinite(e.speed) && e.speed !== 0 ? nice(Math.abs(e.speed) / nominalFps(fps)) : undefined;
    const reverse = (e.speed ?? 0) < 0;
    const main = e.lines[e.lines.length - 1];
    const two = e.lines.length >= 2 ? e.lines[0] : null;
    for (const tr of tracksOf(main.field)) {
      const rIn = main.rIn - off, rOut = main.rOut - off;
      if (rOut <= rIn) continue;
      const sp = speed ?? (Math.abs((main.sOut - main.sIn) - (rOut - rIn)) > 1 ? Math.abs(main.sOut - main.sIn) / (rOut - rIn) : 1);
      const isDissolve = two && /^(D|W\d{3})$/.test(main.type);
      if (main.type.startsWith("W") || main.type.startsWith("K")) warn("Wipes and keys in the EDL are read as dissolves and cuts");
      const m = main.reel.toUpperCase() === "BL" ? null : mediaFor(isDissolve ? e.to ?? e.from : e.from, main.reel, e.file, tr.kind);
      const prev = ir.clips.filter((c) => c.kind === tr.kind && c.track === tr.index && Math.round(c.start + c.duration) === Math.round(rIn)).pop();
      if (!m) {
        // a fade to black: the clip before plays on under it
        if (isDissolve && prev && two && two.reel.toUpperCase() !== "BL") {
          prev.duration += rOut - rIn;
          ir.transitions.push({ kind: tr.kind, track: tr.index, at: Math.round(rOut), duration: Math.max(1, main.dur || rOut - rIn), alignment: "end", type: tr.kind === "audio" ? "audio:constant_power" : "fade", from: prev.ref });
        }
        continue;
      }
      const c: IrClip = { ref: `e${++ref}`, kind: tr.kind, track: tr.index, start: rIn, duration: rOut - rIn, name: (isDissolve ? e.to : e.from) || m.name,
        media: { key: m.key, in: Math.min(main.sIn, main.sOut) / F } };
      if (Math.abs(sp - 1) > 1e-6) c.speed = r6(sp);
      if (reverse) c.reverse = true;
      if (tracksOf(main.field).length > 1) c.link = `ev${e.n}`; // one "B" / "AA/V" event: its V and A are linked
      if (isDissolve) {
        const d = Math.max(1, main.dur || 1);
        const fromBlack = !two || two.reel.toUpperCase() === "BL";
        if (fromBlack || !prev) {
          ir.transitions.push({ kind: tr.kind, track: tr.index, at: Math.round(rIn), duration: d, alignment: "start", type: tr.kind === "audio" ? "audio:constant_power" : "fade", to: c.ref });
        } else {
          // centred on the cut, as the editor (and Premiere) make them
          const h = Math.floor(d / 2);
          prev.duration += h;
          c.start += h; c.duration -= h;
          if (c.media) c.media.in += reverse ? 0 : (h * (c.speed ?? 1)) / F;
          const x: IrTransition = { kind: tr.kind, track: tr.index, at: Math.round(c.start), duration: d, alignment: "center", type: tr.kind === "audio" ? "audio:constant_power" : "fade", from: prev.ref, to: c.ref };
          ir.transitions.push(x);
        }
      }
      if (c.duration >= 1) ir.clips.push(c);
    }
  }
  // separate V and A events of one source at one place (as most EDL writers make them) are one linked clip too
  const groups = new Map<string, IrClip[]>();
  for (const c of ir.clips) {
    const k = `${c.media?.key}|${Math.round(c.start)}|${Math.round(c.duration)}|${Math.round((c.media?.in ?? 0) * F)}|${c.speed ?? 1}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  for (const [k, cs] of groups) if (cs.length > 1 && new Set(cs.map((c) => c.kind)).size > 1 && cs.every((c) => !c.link || c.link === cs[0].link)) for (const c of cs) c.link = k;
  const byLink = new Map<string, IrClip[]>();
  for (const c of ir.clips) if (c.link) byLink.set(c.link, [...(byLink.get(c.link) ?? []), c]);
  for (const cs of byLink.values()) if (cs.length < 2) for (const c of cs) delete c.link;
  for (const l of locs) {
    const f = (parseTimecode(l.tc, fps, drop) ?? 0) - off;
    const mk: IrMarker = { at: Math.max(0, f), duration: 0, name: l.name, color: /^[A-Z]+$/i.test(l.color) ? otioColorHex(l.color) : MARKER_COLORS[0] };
    ir.markers.push(mk);
  }
  for (const m of media) if (!m.seconds) delete m.seconds;
  return { name: opts.name ?? ir.name, sequences: [ir], main: ir.key, media, warnings };
}
