/**
 * Frames ↔ seconds ↔ timecode. NTSC rates (23.976, 29.97, 59.94) are exact rationals (24000/1001 …); 29.97 and 59.94
 * show drop-frame timecode (HH:MM:SS;FF), every other rate non-drop (HH:MM:SS:FF). Pure.
 */

export const FPS_LIST = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;

/** [numerator, denominator] of a frame rate: 29.97 → [30000, 1001]. Any other rate is n/1 (or n·1000/1000). */
export function fpsRational(fps: number): [number, number] {
  if (Math.abs(fps - 23.976) < 0.01) return [24000, 1001];
  if (Math.abs(fps - 29.97) < 0.01) return [30000, 1001];
  if (Math.abs(fps - 59.94) < 0.01) return [60000, 1001];
  if (Math.abs(fps - 47.952) < 0.01) return [48000, 1001];
  if (Number.isInteger(fps) && fps > 0) return [fps, 1];
  const f = fps > 0 && Number.isFinite(fps) ? fps : 30;
  return [Math.round(f * 1000), 1000];
}

/** The exact rate as a number (29.97 → 29.97002997…). */
export const fpsExact = (fps: number) => { const [n, d] = fpsRational(fps); return n / d; };
/** Frames per timecode second: 29.97 → 30. */
export const nominalFps = (fps: number) => Math.round(fpsExact(fps));
/** Drop-frame timecode applies to 29.97 and 59.94. */
export const isDropFrame = (fps: number) => { const [n, d] = fpsRational(fps); return d === 1001 && (n === 30000 || n === 60000); };

export function framesToSeconds(frames: number, fps: number): number {
  const [n, d] = fpsRational(fps);
  return (frames * d) / n;
}
/** Nearest frame to a time in seconds. */
export function secondsToFrames(s: number, fps: number): number {
  const [n, d] = fpsRational(fps);
  return Math.round((s * n) / d + 1e-9);
}

/** Frames at one rate → frames at another (source ↔ timeline), not rounded. */
export const convertFrames = (frames: number, from: number, to: number) => (from === to ? frames : (frames * fpsExact(to)) / fpsExact(from));

const two = (v: number) => String(v).padStart(2, "0");

/** frame → "HH:MM:SS:FF" (drop-frame "HH:MM:SS;FF" at 29.97 / 59.94). Negative frames get a leading "-". */
export function toTimecode(frame: number, fps: number, opts: { dropFrame?: boolean } = {}): string {
  const neg = frame < 0;
  let f = Math.round(Math.abs(frame));
  const nom = nominalFps(fps);
  const df = opts.dropFrame ?? isDropFrame(fps);
  if (df) {
    const drop = Math.round(nom / 15);            // 2 at 29.97, 4 at 59.94
    const per10 = Math.round(fpsExact(fps) * 600); // 17982 / 35964 real frames in 10 minutes
    const perMin = nom * 60 - drop;                 // 1798 / 3596
    const d = Math.floor(f / per10);
    const m = f % per10;
    f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0);
  }
  const ff = f % nom;
  const totalS = Math.floor(f / nom);
  const s = totalS % 60, mm = Math.floor(totalS / 60) % 60, hh = Math.floor(totalS / 3600);
  return `${neg ? "-" : ""}${two(hh)}:${two(mm)}:${two(s)}${df ? ";" : ":"}${two(ff)}`;
}

/**
 * "HH:MM:SS:FF" (or ";FF"), "MM:SS:FF", "SS:FF", "1.05" (seconds.frames, like Premiere's typed timecode without
 * separators is too ambiguous) or a plain frame count → frames. Returns null when it can't be read.
 * A leading "+" / "-" makes it relative to `base`.
 */
export function parseTimecode(input: string, fps: number, base = 0): number | null {
  const raw = input.trim();
  if (!raw) return null;
  const rel = raw[0] === "+" || raw[0] === "-" ? raw[0] : "";
  const body = rel ? raw.slice(1).trim() : raw;
  let frames: number | null = null;
  if (/^\d+$/.test(body)) frames = parseInt(body, 10);
  else if (/^\d+([:;.]\d+){1,3}$/.test(body)) {
    const dropTyped = body.includes(";");
    const parts = body.split(/[:;.]/).map((p) => parseInt(p, 10));
    while (parts.length < 4) parts.unshift(0);
    const [h, m, s, f] = parts;
    const nom = nominalFps(fps);
    if (f >= nom || s >= 60 || m >= 60) {
      // tolerate overflow typed by hand ("90:00" seconds:frames) by carrying, non-drop
      frames = ((h * 60 + m) * 60 + s) * nom + f;
    } else if (isDropFrame(fps) || dropTyped) {
      const drop = Math.round(nom / 15);
      const totalMin = h * 60 + m;
      frames = ((h * 60 + m) * 60 + s) * nom + f - drop * (totalMin - Math.floor(totalMin / 10));
    } else frames = ((h * 60 + m) * 60 + s) * nom + f;
  }
  if (frames === null || !Number.isFinite(frames)) return null;
  if (rel === "+") return base + frames;
  if (rel === "-") return base - frames;
  return frames;
}

/** A short duration for labels: "4:12" (min:sec) under an hour, "1:02:05" above; frames when under a second. */
export function shortDuration(frames: number, fps: number): string {
  const nom = nominalFps(fps);
  if (Math.abs(frames) < nom) return `${Math.round(frames)}f`;
  const s = Math.floor(framesToSeconds(frames, fps));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** The fps label shown in menus: "29.97 fps". */
export const fpsLabel = (fps: number) => `${Number.isInteger(fps) ? fps : fps.toFixed(fps === 23.976 ? 3 : 2)} fps`;
