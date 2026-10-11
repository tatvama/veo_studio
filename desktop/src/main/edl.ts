/**
 * The cut for Premiere and DaVinci (docs/DESKTOP.md §3): a CMX3600 EDL and a minimal FCPXML 1.10, both pointing at
 * the series-named local files. Pure writers (unit tests: test/edl.test.ts); sync.ts / ipc.ts write them to Edits/.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface EdlClip {
  /** File name shown in the EDL comments / FCPXML (usually the local file's base name). */
  name: string;
  /** Absolute local path (empty when the file isn't local yet). */
  path: string;
  /** Source in point, seconds. */
  srcIn: number;
  /** Length on the timeline, seconds (after speed). */
  duration: number;
  speed?: number;
  /** Comes in from the previous clip with a dissolve of this many seconds (it overlaps the previous clip). */
  transition?: [string, number] | null;
  /** Length of the whole media file, seconds (for FCPXML assets). */
  mediaDuration?: number;
  hasAudio?: boolean;
  still?: boolean;
}

export interface EdlOptions { title: string; fps?: number; width?: number; height?: number; reel?: "ax" | "basename"; startTc?: number }

const pad = (n: number, w = 2) => String(Math.max(0, Math.floor(n))).padStart(w, "0");

/** Seconds → non-drop timecode HH:MM:SS:FF at an integer frame rate. */
export function timecode(seconds: number, fps = 24): string {
  const total = Math.max(0, Math.round(seconds * fps));
  const ff = total % fps;
  const s = Math.floor(total / fps);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(ff)}`;
}

function reelName(c: EdlClip, mode: "ax" | "basename"): string {
  if (mode === "ax") return "AX";
  const base = path.parse(c.name || c.path).name.replace(/[^A-Za-z0-9_]/g, "").toUpperCase();
  return (base || "AX").slice(0, 8);
}

interface Placed { clip: EdlClip; start: number; end: number; visibleEnd: number; srcIn: number; srcOutVisible: number; d: number }

/** Where each clip sits on the record timeline: a transition starts the clip `d` seconds before the previous ends. */
export function place(clips: EdlClip[]): Placed[] {
  const out: Placed[] = [];
  let t = 0;
  clips.forEach((c, i) => {
    let d = 0;
    if (i > 0 && c.transition && c.transition[1] > 0) {
      d = Math.max(0.1, Math.min(c.transition[1], c.duration / 2, out[i - 1].clip.duration / 2));
      t -= d;
    }
    out.push({ clip: c, start: t, end: t + c.duration, visibleEnd: t + c.duration, srcIn: c.srcIn, srcOutVisible: 0, d });
    t += c.duration;
  });
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    out[i].visibleEnd = next && next.d > 0 ? next.start : out[i].end;
    out[i].srcOutVisible = out[i].srcIn + (out[i].visibleEnd - out[i].start) * (out[i].clip.speed ?? 1);
  }
  return out;
}

/** A CMX3600 EDL (video + both audio channels per event; dissolves as `D` events). */
export function writeEdl(clips: EdlClip[], opts: EdlOptions): string {
  const fps = opts.fps ?? 24;
  const mode = opts.reel ?? "ax";
  const off = opts.startTc ?? 0;
  const tc = (s: number) => timecode(s + 0, fps);
  const rtc = (s: number) => timecode(s + off, fps);
  const lines = [`TITLE: ${opts.title.replace(/[\r\n]/g, " ").slice(0, 70)}`, "FCM: NON-DROP FRAME", ""];
  const placed = place(clips);
  let ev = 0;
  const evLine = (n: number, reel: string, kind: string, dur: string, sIn: number, sOut: number, rIn: number, rOut: number) =>
    `${pad(n, 3)}  ${reel.padEnd(8)} AA/V  ${kind.padEnd(4)} ${dur.padStart(3)} ${tc(sIn)} ${tc(sOut)} ${rtc(rIn)} ${rtc(rOut)}`;
  placed.forEach((p, i) => {
    ev++;
    const reel = reelName(p.clip, mode);
    if (p.d > 0 && i > 0) {
      const prev = placed[i - 1];
      const prevReel = reelName(prev.clip, mode);
      const frames = String(Math.max(1, Math.round(p.d * fps))).padStart(3, "0");
      lines.push(evLine(ev, prevReel, "C", "", prev.srcOutVisible, prev.srcOutVisible, p.start, p.start));
      lines.push(evLine(ev, reel, "D", frames, p.srcIn, p.srcOutVisible, p.start, p.visibleEnd));
      lines.push(`* FROM CLIP NAME: ${prev.clip.name}`);
      lines.push(`* TO CLIP NAME: ${p.clip.name}`);
    } else {
      lines.push(evLine(ev, reel, "C", "", p.srcIn, p.srcOutVisible, p.start, p.visibleEnd));
      lines.push(`* FROM CLIP NAME: ${p.clip.name}`);
    }
    if (p.clip.path) lines.push(`* SOURCE FILE: ${p.clip.path}`);
    const sp = p.clip.speed ?? 1;
    if (Math.abs(sp - 1) > 1e-3) lines.push(`M2   ${reel.padEnd(8)}       ${(fps * sp).toFixed(1).padStart(5, "0")}    ${tc(p.srcIn)}`);
    lines.push("");
  });
  return lines.join("\r\n");
}

/** file:// URL of a local path; Windows drive paths come out the same on every OS (file:///D:/a%20b/c.mp4). */
export function fileUrl(p: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    return `file:///${p.replace(/\\/g, "/").split("/").map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join("/")}`;
  }
  return pathToFileURL(p).href;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rational seconds in frames, e.g. "123/24s" ("0s" for zero). */
export function rational(seconds: number, fps = 24): string {
  const f = Math.max(0, Math.round(seconds * fps));
  return f === 0 ? "0s" : `${f}/${fps}s`;
}

/** A minimal FCPXML 1.10: one asset per file (file:// URL), a sequence spine of asset-clips, cross dissolves. */
export function writeFcpxml(clips: EdlClip[], opts: EdlOptions): string {
  const fps = opts.fps ?? 24;
  const w = opts.width ?? 1920;
  const h = opts.height ?? 1080;
  const placed = place(clips);
  const assets = new Map<string, { id: string; clip: EdlClip; dur: number }>();
  let rid = 1;
  const fmtId = `r${rid++}`;
  for (const p of placed) {
    const k = p.clip.path || p.clip.name;
    const need = p.srcIn + (p.end - p.start) * (p.clip.speed ?? 1);
    const a = assets.get(k);
    if (a) a.dur = Math.max(a.dur, need, p.clip.mediaDuration ?? 0);
    else assets.set(k, { id: `r${rid++}`, clip: p.clip, dur: Math.max(need, p.clip.mediaDuration ?? 0) });
  }
  const total = placed.length ? placed[placed.length - 1].end : 0;
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE fcpxml>",
    '<fcpxml version="1.10">',
    "  <resources>",
    `    <format id="${fmtId}" name="FFVideoFormat${h}p${fps}" frameDuration="1/${fps}s" width="${w}" height="${h}"/>`,
  ];
  for (const a of assets.values()) {
    const src = a.clip.path ? fileUrl(a.clip.path) : "";
    out.push(`    <asset id="${a.id}" name="${xml(a.clip.name)}" start="0s" duration="${rational(a.dur, fps)}" hasVideo="1"`
      + ` hasAudio="${a.clip.hasAudio === false || a.clip.still ? 0 : 1}" format="${fmtId}"${a.clip.hasAudio === false || a.clip.still ? "" : ' audioSources="1" audioChannels="2" audioRate="48000"'}>`);
    out.push(`      <media-rep kind="original-media" src="${xml(src)}"/>`);
    out.push("    </asset>");
  }
  out.push("  </resources>", "  <library>", `    <event name="${xml(opts.title)}">`, `      <project name="${xml(opts.title)}">`,
    `        <sequence format="${fmtId}" duration="${rational(total, fps)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    "          <spine>");
  placed.forEach((p, i) => {
    if (p.d > 0 && i > 0) {
      out.push(`            <transition name="Cross Dissolve" offset="${rational(p.start, fps)}" duration="${rational(p.d, fps)}"/>`);
    }
    const a = assets.get(p.clip.path || p.clip.name)!;
    out.push(`            <asset-clip ref="${a.id}" name="${xml(p.clip.name)}" offset="${rational(p.start, fps)}" start="${rational(p.srcIn, fps)}"`
      + ` duration="${rational(p.visibleEnd - p.start, fps)}" format="${fmtId}" tcFormat="NDF"/>`);
  });
  out.push("          </spine>", "        </sequence>", "      </project>", "    </event>", "  </library>", "</fcpxml>", "");
  return out.join("\n");
}
