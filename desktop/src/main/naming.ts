/**
 * Series file naming (docs/DESKTOP.md §3.1): the template engine, Windows-safe names and the two-phase rename plan.
 * Pure functions only: no file system, no Electron. Unit tests: test/naming.test.ts.
 */
import path from "node:path";

export const DEFAULT_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  Takes: "{project}_S{season:02}E{episode:02}_{cut:03}_SC{scene:02}_SH{shot:03}_{kind}{_lang}_T{take:02}",
  Audio: "{project}_S{season:02}E{episode:02}_{cut:03}_SH{shot:03}_{kind}{_lang}_T{take:02}",
  Music: "{project}_S{season:02}E{episode:02}_music_{seq:02}",
  Renders: "{project}_S{season:02}E{episode:02}_{lang}_{preset}_v{version:03}",
  Captions: "{project}_S{season:02}E{episode:02}_{lang}_v{version:03}",
  Bible: "{project}_{kind}_{label}_{seq:02}",
  Imports: "IMP_{seq:04}_{label}",
  Media: "{label}",
});

export const TOKENS: ReadonlyArray<{ token: string; help: string }> = Object.freeze([
  { token: "{project}", help: "Project title, made safe for a file name" },
  { token: "{season}", help: "Season number" },
  { token: "{episode}", help: "Episode number" },
  { token: "{scene}", help: "Scene order (1-based)" },
  { token: "{shot}", help: "Shot order in the episode" },
  { token: "{cut}", help: "Position among the included shots, so the folder sorts in playback order" },
  { token: "{code}", help: "The shot code, e.g. E02-SH03" },
  { token: "{kind}", help: "video, keyframe, lipsync, voice, music, render …" },
  { token: "{lang}", help: "Language code, empty when there is none" },
  { token: "{take}", help: "Take number" },
  { token: "{version}", help: "Take number, or the render version" },
  { token: "{preset}", help: "The render preset" },
  { token: "{date}", help: "YYYYMMDD" },
  { token: "{seq}", help: "The running number inside its folder" },
  { token: "{id}", help: "The take, asset or export id" },
  { token: "{label}", help: "A short label" },
  { token: "{name:03}", help: "Any token with :NN zero-pads numbers to NN digits" },
  { token: "{_name}", help: "Any token with a leading _ adds an underscore before it, or nothing when it is empty" },
]);

export type TokenValues = Partial<Record<string, string | number | null | undefined>>;

export const MAX_PATH = 240;
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** One token value made safe: no illegal characters, whitespace becomes "-", no dots or dashes at the ends. */
export function safePart(value: string): string {
  return value
    .normalize("NFC")
    .replace(ILLEGAL, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** A whole file or folder name made safe for Windows (keeps spaces). */
export function safeFileName(name: string, fallback = "file"): string {
  let s = name.normalize("NFC").replace(ILLEGAL, "_").replace(/_{2,}/g, "_");
  s = s.replace(/^[_\s]+/, "").replace(/[_.\s]+$/, "");
  if (!s) s = fallback;
  const stem = s.split(".")[0];
  if (RESERVED.test(stem)) s = `_${s}`;
  return s;
}

/** The project folder name: `<Project title> (#<id>)`. */
export function projectFolderName(title: string | null | undefined, id: number): string {
  const t = safeFileName((title || "").replace(/\s+/g, " ").trim(), "Project").slice(0, 80).replace(/[.\s]+$/, "");
  return `${t || "Project"} (#${id})`;
}

/** Fill a template: `{name}`, `{name:03}` (zero-pad to 3 digits) and `{_name}` ("_" + value, or "" when empty). */
export function renderTemplate(template: string, values: TokenValues): string {
  const out = template.replace(/\{(_?)([a-zA-Z]+)(?::(\d+))?\}/g, (_m, under: string, name: string, pad?: string) => {
    const v = values[name];
    let s = v === null || v === undefined ? "" : String(v);
    if (pad && /^\d+$/.test(s)) s = s.padStart(Number.parseInt(pad, 10), "0");
    s = safePart(s);
    if (under) return s ? `_${s}` : "";
    return s;
  });
  return safeFileName(out);
}

function fullLength(dir: string, name: string, ext: string): number {
  return (dir ? dir.length + 1 : 0) + name.length + ext.length;
}

/**
 * Render a name that keeps the whole path within `maxPath` characters, shortening the label first, then the project
 * title, then (as a last resort) cutting the name itself. `ext` includes the dot.
 */
export function fitName(template: string, values: TokenValues, dir: string, ext: string, maxPath = MAX_PATH): string {
  let vals: TokenValues = { ...values };
  let name = renderTemplate(template, vals);
  for (const key of ["label", "project", "code"]) {
    let v = String(vals[key] ?? "");
    while (fullLength(dir, name, ext) > maxPath && v.length > 3) {
      v = v.slice(0, Math.max(3, Math.floor(v.length * 0.7)));
      vals = { ...vals, [key]: v };
      name = renderTemplate(template, vals);
    }
  }
  const room = maxPath - (dir ? dir.length + 1 : 0) - ext.length;
  if (name.length > room) name = safeFileName(name.slice(0, Math.max(room, 8)));
  return name;
}

/** Case-insensitive key for a path (Windows file systems ignore case). */
export function pathKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** `a.mp4`, `a_2.mp4`, `a_3.mp4` … the first name not in `taken` (compared case-insensitively). */
export function uniquePath(p: string, taken: Set<string>): string {
  if (!taken.has(pathKey(p))) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let n = 2; ; n++) {
    const cand = `${stem}_${n}${ext}`;
    if (!taken.has(pathKey(cand))) return cand;
  }
}

/** Give every entry a unique path, in order: later duplicates get _2, _3 … */
export function dedupe<T extends { path: string }>(items: T[], alsoTaken: Iterable<string> = []): T[] {
  const taken = new Set<string>([...alsoTaken].map(pathKey));
  return items.map((it) => {
    const p = uniquePath(it.path, taken);
    taken.add(pathKey(p));
    return p === it.path ? it : { ...it, path: p };
  });
}

export interface RenameStep { key: string; from: string; to: string; phase: 1 | 2 }
export interface RenamePlan {
  /** Execute in order. Phase 1 parks files that would collide on temporary names; phase 2 puts everything in place. */
  steps: RenameStep[];
  /** What the user sees in "Preview names": each file's current and final path. */
  moves: { key: string; from: string; to: string }[];
  /** Files that can't move because a file that stays put already has the target name. */
  blocked: { key: string; from: string; to: string }[];
}

/**
 * Two-phase rename plan from the files' current paths to their desired paths (matched by key). Never collides:
 * a file whose target is currently held by another moving file is parked under a temporary name first, so swaps
 * (A→B, B→A) and rotations work. Desired paths must already be unique (see `dedupe`). Paths are folder-relative with "/".
 */
export function planRenames(current: { key: string; path: string }[], desired: { key: string; path: string }[]): RenamePlan {
  const curByKey = new Map(current.map((c) => [c.key, c.path]));
  const holder = new Map<string, string>(); // path key → key of the file there now
  for (const c of current) holder.set(pathKey(c.path), c.key);
  const moves: { key: string; from: string; to: string }[] = [];
  for (const d of desired) {
    const from = curByKey.get(d.key);
    if (from === undefined || from === d.path) continue;
    moves.push({ key: d.key, from, to: d.path });
  }
  const moving = new Set(moves.map((m) => m.key));
  const blocked: RenamePlan["blocked"] = [];
  const parked: { key: string; tmp: string; to: string }[] = [];
  const direct: RenameStep[] = [];
  const phase1: RenameStep[] = [];
  let n = 0;
  for (const m of moves) {
    const at = holder.get(pathKey(m.to));
    if (at === undefined || at === m.key) {
      direct.push({ key: m.key, from: m.from, to: m.to, phase: 2 });
    } else if (moving.has(at)) {
      const from = m.from.replace(/\\/g, "/");
      const tmp = path.posix.join(path.posix.dirname(from), `.tatvam-rename-${++n}-${path.posix.basename(from)}`);
      phase1.push({ key: m.key, from: m.from, to: tmp, phase: 1 });
      parked.push({ key: m.key, tmp, to: m.to });
    } else {
      blocked.push(m);
    }
  }
  const blockedKeys = new Set(blocked.map((b) => b.key));
  return {
    steps: [...phase1, ...direct, ...parked.map((p) => ({ key: p.key, from: p.tmp, to: p.to, phase: 2 as const }))],
    moves: moves.filter((m) => !blockedKeys.has(m.key)),
    blocked,
  };
}

/** YYYYMMDD of an ISO date (today when missing or unreadable). */
export function dateToken(iso?: string | null, now = new Date()): string {
  const d = iso ? new Date(iso) : now;
  const x = Number.isNaN(d.getTime()) ? now : d;
  return `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, "0")}${String(x.getUTCDate()).padStart(2, "0")}`;
}

/** The template a manifest folder uses: Audio/Music → Music, Audio/* → Audio, Bible/* → Bible, … */
export function templateKeyForFolder(folder: string): string {
  if (folder === "Audio/Music") return "Music";
  const top = folder.split("/")[0];
  if (["Takes", "Audio", "Renders", "Captions", "Bible", "Imports", "Media"].includes(top)) return top;
  return "Media";
}
