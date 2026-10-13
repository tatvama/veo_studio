/**
 * Interchange with Premiere Pro, Audition, Resolve and OTIO tools (docs/EDITOR.md §12), the main-process side:
 *  - exportFile: an edit's SAVED sequence → FCP 7 XML (Premiere / Audition), CMX 3600 EDL, OTIO, markers CSV or
 *    YouTube chapters, by default in `<edit folder>\Exports\Interchange\`. Studio-only media is made local first
 *    (EditorManager.importStudioAsset), generator clips (tone, noise, DTMF) are rendered to WAVs next to the file, and
 *    "audition-stems" renders every audio track to a 48 kHz WAV stem (editor-audio.ts stemJobs) that the XML places.
 *  - importFile: an XML / EDL / OTIO → a new edit (EditorManager.create), its files probed (importMedia) and the clips
 *    rebased onto what the files really are; files that aren't on this PC stay offline for relinking. A markers CSV
 *    comes back as text for the open edit.
 *  - findApps / openIn: Premiere Pro and Audition from the registry (App Paths, the Uninstall keys) and
 *    Program Files\Adobe; the file opens in the newest one, or Explorer shows it.
 * The converters are the editor's own (frontend/src/editor/interop, pure). Paths only come from the user's dialogs,
 * the edit itself, or files this module wrote: a timeline file's contents never choose what is written, run or
 * opened, and its network (UNC) paths aren't touched. Electron-free (deps carry the dialogs, the shell and spawn).
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import {
  detectImport, exportSequence, fromMarkersCsv, importTimeline, INTEROP_FORMATS, isInteropFormat, rebaseMedia, type InteropFormat,
} from "../../../frontend/src/editor/interop/index.ts";
import type { EditProject as FrontProject, MediaItem as FrontMedia } from "../../../frontend/src/editor/model/types.ts";
import type { EditProject, InteropApp, InteropAppId, InteropExportResult, InteropImportResult, MediaItem, Sequence } from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";
import { generatorSource, stemJobs } from "./editor-audio.ts";
import { audioFxId, FX_BY_ID } from "./editor-audiofx.ts";
import { EditorError, isInside, mediaKindOf } from "./editor-model.ts";
import type { EditorManager } from "./editor.ts";
import { runFfmpeg, type FfmpegInfo } from "./ffmpeg.ts";
import { pathKey, safeFileName } from "./naming.ts";

/** What this module needs of the editor manager (tests pass a fake). */
export type InteropEditor = Pick<EditorManager, "open" | "create" | "save" | "importMedia" | "importStudioAsset" | "editsRoot" | "ensureIrs">;

export interface InteropDeps {
  editor: InteropEditor;
  ff(): FfmpegInfo | null;
  dialogs: {
    openFiles(opts: { title: string; filters: { name: string; extensions: string[] }[]; multi?: boolean; defaultPath?: string }): Promise<string[]>;
    /** A native save dialog; null when cancelled. */
    saveFile(opts: { title: string; defaultPath: string; filters: { name: string; extensions: string[] }[] }): Promise<string | null>;
  };
  /** Starts a program with arguments, detached (default: child_process.spawn). */
  launch?(exe: string, args: string[]): void;
  /** Shows a file in Explorer. */
  reveal(file: string): void;
  /** `reg.exe` with these arguments → its stdout ("" when the key isn't there). */
  reg?(args: string[]): Promise<string>;
  /** Environment for the Program Files folders (default: process.env). */
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Runs FFmpeg (default: runFfmpeg with ff()). */
  runFfmpeg?(args: string[]): Promise<void>;
  log(msg: string): void;
}

const MAX_IMPORT = 64 * 1024 * 1024;
const IMPORT_EXTS = ["xml", "edl", "otio", "csv", "tsv"];
const APPS: Record<InteropAppId, { name: string; exes: string[]; folder: string; exe: string }> = {
  premiere: { name: "Adobe Premiere Pro", exes: ["Adobe Premiere Pro.exe"], folder: "Adobe Premiere Pro", exe: "Adobe Premiere Pro.exe" },
  audition: { name: "Adobe Audition", exes: ["Adobe Audition.exe", "Adobe Audition CC.exe"], folder: "Adobe Audition", exe: "Adobe Audition.exe" },
};

// ── finding Premiere Pro and Audition ────────────────────────────────────────

/** reg.exe query output → [{key, values: {name: data}}]. */
export function parseRegQuery(out: string): { key: string; values: Record<string, string> }[] {
  const blocks: { key: string; values: Record<string, string> }[] = [];
  let cur: { key: string; values: Record<string, string> } | null = null;
  for (const raw of out.split(/\r?\n/)) {
    if (/^HKEY_/i.test(raw)) { cur = { key: raw.trim(), values: {} }; blocks.push(cur); continue; }
    const m = /^\s+(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(raw) ?? /^\s+(.+?)\s+(REG_[A-Z_]+)\s*$/.exec(raw);
    if (m && cur) cur.values[m[1].trim()] = (m[3] ?? "").trim();
  }
  return blocks;
}

/** A version to compare: the year in the name (2025), else the major version mapped to Adobe's years. */
export function appVersionScore(name: string, version?: string): number {
  const y = /\b(20[1-4]\d)\b/.exec(name)?.[1] ?? (version ? /\b(20[1-4]\d)\b/.exec(version)?.[1] : undefined);
  if (y) return Number(y) * 1000 + Number(/\.(\d+)/.exec(version ?? "")?.[1] ?? 0);
  const major = Number(/^(\d+)/.exec(version ?? "")?.[1] ?? 0);
  const year = major >= 22 ? 2000 + major : major === 15 ? 2021 : major === 14 ? 2020 : major === 13 ? 2019 : major === 12 ? 2018 : major ? 2010 + major : 0;
  return year * 1000 + Number(/^\d+\.(\d+)/.exec(version ?? "")?.[1] ?? 0);
}

const execReg = (args: string[]): Promise<string> => new Promise((resolve) => {
  execFile("reg.exe", args, { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? String(stdout ?? "") : String(stdout)));
});

export class InteropManager {
  private deps: InteropDeps;
  /** Files this module wrote this session (openIn opens only these). */
  private written = new Set<string>();
  private apps: { at: number; list: InteropApp[] } | null = null;

  constructor(deps: InteropDeps) { this.deps = deps; }

  private exists = (f: string) => { try { return existsSync(f); } catch { return false; } };

  async findApps(force = false): Promise<InteropApp[]> {
    if (!force && this.apps && Date.now() - this.apps.at < 60_000) return this.apps.list;
    const platform = this.deps.platform ?? process.platform;
    if (platform !== "win32") { this.apps = { at: Date.now(), list: [] }; return []; }
    const reg = this.deps.reg ?? execReg;
    const env = this.deps.env ?? process.env;
    const found: (InteropApp & { score: number })[] = [];
    const add = (id: InteropAppId, exe: string, source: InteropApp["source"], version?: string, label?: string) => {
      if (!exe || !/\.exe$/i.test(exe) || !path.isAbsolute(exe) || !this.exists(exe)) return;
      if (found.some((f) => pathKey(f.path) === pathKey(exe))) return;
      const name = label || path.basename(path.dirname(exe));
      found.push({ id, name, path: exe, source, ...(version ? { version } : {}), score: appVersionScore(name, version) });
    };
    for (const [id, app] of Object.entries(APPS) as [InteropAppId, (typeof APPS)[InteropAppId]][]) {
      // 1. App Paths
      for (const hive of ["HKLM", "HKCU"]) {
        for (const exe of app.exes) {
          try {
            const out = await reg(["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"]);
            for (const b of parseRegQuery(out)) {
              const v = b.values["(Default)"] ?? b.values["(default)"] ?? Object.values(b.values)[0];
              if (v) add(id, v.replace(/^"|"$/g, ""), "registry");
            }
          } catch (e) { this.deps.log(`interop: reg App Paths ${exe}: ${(e as Error).message}`); }
        }
      }
    }
    // 2. Uninstall keys (one pass per hive)
    for (const root of ["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"]) {
      let out = "";
      try { out = await reg(["query", root, "/s"]); } catch (e) { this.deps.log(`interop: reg ${root}: ${(e as Error).message}`); }
      for (const b of parseRegQuery(out)) {
        const dn = b.values.DisplayName ?? "";
        for (const [id, app] of Object.entries(APPS) as [InteropAppId, (typeof APPS)[InteropAppId]][]) {
          if (!dn.toLowerCase().startsWith(app.name.toLowerCase())) continue;
          const loc = (b.values.InstallLocation ?? "").replace(/^"|"$/g, "");
          const icon = (b.values.DisplayIcon ?? "").replace(/^"|"$/g, "").replace(/,\s*-?\d+$/, "");
          if (loc) for (const exe of app.exes) add(id, path.join(loc, exe), "uninstall", b.values.DisplayVersion, dn);
          if (icon && app.exes.some((x) => path.basename(icon).toLowerCase() === x.toLowerCase())) add(id, icon, "uninstall", b.values.DisplayVersion, dn);
        }
      }
    }
    // 3. Program Files\Adobe\Adobe Premiere Pro *\Adobe Premiere Pro.exe, …\Adobe Audition *\Adobe Audition.exe
    const roots = [...new Set([env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"].filter((x): x is string => !!x))];
    for (const r of roots) {
      const adobe = path.join(r, "Adobe");
      let names: string[] = [];
      try { names = await fsp.readdir(adobe); } catch { continue; }
      for (const [id, app] of Object.entries(APPS) as [InteropAppId, (typeof APPS)[InteropAppId]][]) {
        for (const n of names.filter((x) => x.toLowerCase().startsWith(app.folder.toLowerCase()))) add(id, path.join(adobe, n, app.exe), "program-files", undefined, n);
      }
    }
    // the newest of each
    const list: InteropApp[] = [];
    for (const id of Object.keys(APPS) as InteropAppId[]) {
      const best = found.filter((f) => f.id === id).sort((a, b) => b.score - a.score)[0];
      if (best) { const { score, ...app } = best; void score; list.push(app); }
    }
    this.apps = { at: Date.now(), list };
    return list;
  }

  // ── export ────────────────────────────────────────────────────────────────

  private ffRun(args: string[]): Promise<void> {
    if (this.deps.runFfmpeg) return this.deps.runFfmpeg(args);
    const ff = this.deps.ff();
    if (!ff) throw new EditorError("FFmpeg wasn't found: set its path in File → Studio server…");
    return runFfmpeg(ff.path, args).then(() => undefined);
  }

  /** Where an export goes: the user's choice (outPath outside the edit's folder goes through a save dialog), else the default. */
  private async target(editFile: string, seq: Sequence, format: InteropFormat, outPath?: string): Promise<string | null> {
    const dir = path.dirname(editFile);
    const ext = INTEROP_FORMATS[format].ext;
    const base = safeFileName(seq.name || "Sequence", "Sequence").slice(0, 80) + (format === "audition-xml" ? " Audition" : format === "audition-stems" ? " Audition stems" : format === "youtube-chapters" ? " chapters" : format === "markers-csv" ? " markers" : "");
    const dflt = path.join(dir, "Exports", "Interchange", `${base}.${ext}`);
    if (outPath === undefined || outPath === null || outPath === "") return dflt;
    if (typeof outPath !== "string" || !path.isAbsolute(outPath)) throw new EditorError("An export path must be a full path");
    let out = path.resolve(outPath);
    if (path.extname(out).slice(1).toLowerCase() !== ext) out = `${out}.${ext}`;
    if (isInside(dir, out)) return out;
    const picked = await this.deps.dialogs.saveFile({ title: `Export ${INTEROP_FORMATS[format].label}`, defaultPath: out,
      filters: [{ name: INTEROP_FORMATS[format].label, extensions: [ext] }] });
    if (!picked) return null;
    return path.extname(picked).slice(1).toLowerCase() === ext ? picked : `${picked}.${ext}`;
  }

  async exportFile(file: string, sequenceId: string, format: InteropFormat, outPath?: string): Promise<InteropExportResult | null> {
    if (!isInteropFormat(format)) throw new EditorError(`Unknown interchange format ${String(format)}`);
    const opened = await this.deps.editor.open(file); // checks the edit is one this session may use
    if (!opened) throw new EditorError("That edit couldn't be opened");
    const editFile = opened.path;
    const project = opened.project;
    const seq = project.sequences.find((s) => s.id === sequenceId);
    if (!seq) throw new EditorError("That sequence isn't in the saved edit: save first");
    const out = await this.target(editFile, seq, format, outPath);
    if (!out) return null;
    const warnings: string[] = [];
    const extra: string[] = [];
    const pulled: { mediaId: string; item: MediaItem }[] = [];
    const timeline = !["markers-csv", "youtube-chapters"].includes(format);
    // the sequences this export reads (nested ones too) and their media
    const used: Sequence[] = [];
    const walk = (id: string) => {
      const s = project.sequences.find((x) => x.id === id);
      if (!s || used.includes(s)) return;
      used.push(s);
      for (const c of s.clips) if (c.source.type === "nested") walk(c.source.sequenceId);
    };
    walk(seq.id);
    const local = new Map<string, string>();
    if (timeline) {
      const ids = new Set(used.flatMap((s) => s.clips.map((c) => (c.source.type === "media" ? c.source.mediaId : "")).filter(Boolean)));
      for (const m of project.media.filter((x) => ids.has(x.id))) {
        const key = m.path.startsWith("studio:") ? m.path.slice(7) : m.missing && m.studioKey ? m.studioKey : null;
        if (!key) continue;
        const have = project.media.find((x) => x.studioKey === key && !x.path.startsWith("studio:") && this.exists(x.path));
        if (have) { local.set(m.id, have.path); continue; }
        try {
          const item = await this.deps.editor.importStudioAsset(editFile, key, m.name);
          local.set(m.id, item.path);
          pulled.push({ mediaId: m.id, item });
        } catch (e) {
          warnings.push(`"${m.name}" couldn't be made local (${(e as Error).message}): it's written without a file path`);
        }
      }
    }
    const pathFor = (m: FrontMedia) => local.get(m.id) ?? (m.path.startsWith("studio:") ? null : m.path);
    const outDir = path.dirname(out);
    const stem = path.basename(out, path.extname(out));
    await fsp.mkdir(outDir, { recursive: true });
    // generator clips (tone, noise, DTMF) as WAVs beside the file
    const generated: Record<string, { path: string; seconds: number }> = {};
    if (timeline && format !== "audition-stems") {
      for (const s of used) {
        for (const c of s.clips) {
          const src = c.source as unknown as { type: string; generator?: string; params?: Record<string, unknown> };
          if (src.type !== "generate" && src.type !== "generator") continue;
          const seconds = (c.duration * fpsDen(s.fps)) / fpsNum(s.fps);
          const wav = path.join(outDir, `${stem} media`, `${safeFileName(c.name || src.generator || "tone", "tone").slice(0, 40)} ${c.id.slice(-6)}.wav`);
          try {
            await fsp.mkdir(path.dirname(wav), { recursive: true });
            const lavfi = generatorSource({ generator: src.generator as "tone", params: (src.params ?? {}) as never }, seconds, (w) => warnings.push(w), s.fps);
            await this.ffRun(["-f", "lavfi", "-i", lavfi, "-t", String(Math.round(seconds * 1000) / 1000), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", wav]);
            generated[c.id] = { path: wav, seconds };
            extra.push(wav);
          } catch (e) {
            warnings.push(`"${c.name}" couldn't be rendered (${(e as Error).message})`);
          }
        }
      }
    }
    // Send to Audition: one stem per audio track with clips
    let stems: Record<string, { path: string; seconds: number; name: string }> | undefined;
    if (format === "audition-stems") {
      stems = {};
      const irDir = await this.deps.editor.ensureIrs().catch(() => "");
      const resolve = (m: MediaItem) => local.get(m.id) ?? (m.path.startsWith("studio:") || m.missing ? null : m.path);
      const end = seq.clips.reduce((mx, c) => (c.enabled === false ? mx : Math.max(mx, c.start + c.duration)), 0);
      const seconds = (end * fpsDen(seq.fps)) / fpsNum(seq.fps);
      for (const t of seq.tracks.filter((x) => x.kind === "audio").sort((a, b) => a.index - b.index)) {
        if (!seq.clips.some((c) => c.trackId === t.id && c.enabled !== false)) continue;
        const wav = path.join(outDir, `${stem} stems`, `${safeFileName(t.name || `A${t.index + 1}`, `A${t.index + 1}`).slice(0, 40)}.wav`);
        await fsp.mkdir(path.dirname(wav), { recursive: true });
        const jobs = stemJobs(project, seq, t.id, wav, { resolve, irFile: irDir ? (p) => path.join(irDir, `${p}.wav`) : undefined,
          part: (i) => path.join(path.dirname(wav), `.${path.basename(wav, ".wav")}_part${i}.wav`) });
        for (const args of jobs) await this.ffRun(args);
        for (let i = 0; i < jobs.length - 1; i++) await fsp.rm(path.join(path.dirname(wav), `.${path.basename(wav, ".wav")}_part${i}.wav`), { force: true }).catch(() => undefined);
        stems[t.id] = { path: wav, seconds, name: `${t.name} stem` };
        extra.push(wav);
      }
      if (!Object.keys(stems).length) throw new EditorError("The sequence has no sound to send to Audition");
    }
    const labelFor = (type: string) => (type.startsWith("audio:") ? FX_BY_ID.get(audioFxId(type))?.label : undefined);
    const r = exportSequence(project as unknown as FrontProject, seq.id, format, { pathFor, generated, stems, labelFor, title: seq.name });
    const text = format === "markers-csv" ? `\ufeff${r.text}` : r.text;
    writeFileAtomic(out, text);
    this.written.add(pathKey(out));
    return { path: out, format, warnings: [...warnings, ...r.warnings], files: extra, pulled };
  }

  // ── import ────────────────────────────────────────────────────────────────

  /** Reads a timeline file's text: UTF-8, or UTF-16 with a BOM (Premiere's marker CSV), or UTF-16 without one. */
  static decode(buf: Buffer): string {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
    if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString("utf16le"); }
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
    const sample = buf.subarray(0, 512);
    let zeros = 0;
    for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros++;
    if (sample.length > 8 && zeros > sample.length / 4) return buf.toString("utf16le");
    return buf.toString("utf8");
  }

  async importFile(src?: string): Promise<InteropImportResult | null> {
    let file = src;
    if (!file) {
      const picked = await this.deps.dialogs.openFiles({ title: "Import a timeline", filters: [
        { name: "Timelines (XML, EDL, OTIO)", extensions: ["xml", "edl", "otio"] }, { name: "Markers CSV", extensions: ["csv", "tsv"] }] });
      if (!picked[0]) return null;
      file = picked[0];
    }
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new EditorError("A timeline file is named by its full path");
    file = path.resolve(file);
    if (!IMPORT_EXTS.includes(path.extname(file).slice(1).toLowerCase())) throw new EditorError(`${path.basename(file)} isn't an XML, EDL, OTIO or markers CSV file`);
    // one handle for the checks and the read: the file checked is the file read
    const fh = await fsp.open(file, "r").catch(() => null);
    if (!fh) throw new EditorError(`${path.basename(file)} wasn't found`);
    let buf: Buffer;
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new EditorError(`${path.basename(file)} wasn't found`);
      if (st.size > MAX_IMPORT) throw new EditorError(`${path.basename(file)} is too large for a timeline file`);
      buf = await fh.readFile();
    } finally {
      await fh.close();
    }
    if (buf.length > MAX_IMPORT) throw new EditorError(`${path.basename(file)} is too large for a timeline file`);
    const text = InteropManager.decode(buf);
    const kind = detectImport(file, text);
    if (kind === "markers-csv") {
      fromMarkersCsv(text, 25); // throws nothing; checks it reads
      return { kind: "markers", name: path.basename(file), text };
    }
    let r;
    try { r = importTimeline(text, file); } catch (e) { throw new EditorError(`${path.basename(file)}: ${(e as Error).message}`); }
    const warnings = [...r.warnings];
    let project = r.project as unknown as EditProject;
    // a network (UNC) path from the file is never opened, not even to see if it's there (Windows would sign in to that
    // server): the item points inside the edit's folder, offline, with the path in its comment for relinking
    let unc = 0;
    project = { ...project, media: project.media.map((m) => {
      if (!m.path.startsWith("\\\\") && !m.path.startsWith("//")) return m;
      unc++;
      return { ...m, path: `Offline/${safeFileName(path.win32.basename(m.path), "media")}`, missing: true, offline: true,
        comment: `The imported file had it at ${m.path}: relink it to use it` };
    }) };
    if (unc) warnings.push(`${unc} file${unc === 1 ? " is" : "s are"} on a network share: relink ${unc === 1 ? "it" : "them"} to use ${unc === 1 ? "it" : "them"} (Tatvam doesn't open network paths from a timeline file)`);
    const main = project.sequences.find((s) => s.id === project.activeSequenceId) ?? project.sequences[0];
    // a new edit folder (the name gets a number when it's taken)
    let made: { path: string; project: EditProject } | null = null;
    const base = project.name || path.basename(file, path.extname(file));
    for (let n = 1; n <= 50 && !made; n++) {
      try { made = await this.deps.editor.create(n === 1 ? base : `${base} ${n}`, { width: main.width, height: main.height, fps: main.fps }); }
      catch (e) { if (!/already exists/i.test((e as Error).message) || n === 50) throw e; }
    }
    if (!made) throw new EditorError("The edit couldn't be created");
    // probe the files that are on this PC (local drives only: a network path from the file isn't touched)
    const local = project.media.filter((m) => m.path && path.isAbsolute(m.path) && mediaKindOf(m.path) && this.exists(m.path));
    const probed = new Map<string, MediaItem>();
    if (local.length) {
      try {
        for (const it of await this.deps.editor.importMedia(made.path, [...new Set(local.map((m) => m.path))])) probed.set(pathKey(it.path), it);
      } catch (e) { warnings.push(`The files couldn't be read: ${(e as Error).message}`); }
    }
    let missing = 0;
    for (const m of [...project.media]) {
      const it = m.path ? probed.get(pathKey(m.path)) : undefined;
      if (it) project = rebaseMedia(project as unknown as FrontProject, m.id, it as unknown as FrontMedia) as unknown as EditProject;
      else {
        missing++;
        project = { ...project, media: project.media.map((x) => (x.id === m.id ? { ...x, missing: true, offline: true } : x)) };
      }
    }
    if (missing) warnings.push(`${missing} file${missing === 1 ? " isn't" : "s aren't"} on this PC: relink ${missing === 1 ? "it" : "them"} in the Project panel`);
    const doc: EditProject = { ...project, id: made.project.id, name: made.project.name, created: made.project.created };
    await this.deps.editor.save(made.path, doc);
    return { kind: "edit", path: made.path, name: doc.name, warnings, missing, sequences: doc.sequences.length };
  }

  // ── open in Premiere / Audition ────────────────────────────────────────────

  async openIn(app: InteropAppId, file: string): Promise<{ opened: "app" | "folder"; app?: string; path: string }> {
    if (app !== "premiere" && app !== "audition") throw new EditorError("Open in: Premiere Pro or Audition");
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new EditorError("A file is named by its full path");
    const abs = path.resolve(file);
    const ok = this.written.has(pathKey(abs)) || (isInside(this.deps.editor.editsRoot(), abs) && /\.(xml|edl|otio)$/i.test(abs));
    if (!ok) throw new EditorError("Only files exported from this edit can be opened from here");
    if (!this.exists(abs)) throw new EditorError(`${path.basename(abs)} wasn't found`);
    const found = (await this.findApps()).find((a) => a.id === app);
    if (found) {
      try {
        (this.deps.launch ?? ((exe: string, args: string[]) => { spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false }).unref(); }))(found.path, [abs]);
        return { opened: "app", app: found.name, path: abs };
      } catch (e) {
        this.deps.log(`interop: couldn't start ${found.path}: ${(e as Error).message}`);
      }
    }
    this.deps.reveal(abs);
    return { opened: "folder", path: abs };
  }
}

const fpsNum = (fps: number) => (Math.abs(fps - 23.976) < 0.01 ? 24000 : Math.abs(fps - 29.97) < 0.01 ? 30000 : Math.abs(fps - 59.94) < 0.01 ? 60000 : Math.round(fps * 1000));
const fpsDen = (fps: number) => (Math.abs(fps - 23.976) < 0.01 || Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01 ? 1001 : 1000);

/** IPC channel names (shared/types.ts IPC has the same). */
export interface InteropIpc { handle(channel: string, listener: (event: { senderFrame?: { url?: string } | null }, ...args: unknown[]) => unknown): void }

/** Registers the editor.interop bridge: only pages on the gateway origin may call (like every editor handler). */
export function registerInteropIpc(ipc: InteropIpc, isAllowed: (url: string) => boolean, mgr: InteropManager,
  channels: { export: string; import: string; findApps: string; openIn: string }): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (e, ...args) => {
      if (!isAllowed(e.senderFrame?.url ?? "")) throw new Error("Not allowed from this page");
      return fn(...args);
    });
  };
  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string" || !v || v.length > 4096) throw new Error(`${name} must be text`);
    return v;
  };
  handle(channels.export, (file, sequenceId, format, outPath) => mgr.exportFile(str(file, "path"), str(sequenceId, "sequenceId"), str(format, "format") as InteropFormat,
    typeof outPath === "string" && outPath ? str(outPath, "outPath") : undefined));
  handle(channels.import, (file) => mgr.importFile(typeof file === "string" && file ? str(file, "path") : undefined));
  handle(channels.findApps, () => mgr.findApps(true));
  handle(channels.openIn, (app, file) => mgr.openIn(str(app, "app") as InteropAppId, str(file, "path")));
}
