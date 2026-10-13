/**
 * The assistant tools (docs/EDITOR.md §13.2): one zod schema each, short descriptions written for a model, results
 * summarised in text (times in seconds AND timecode) plus structured content. Main-process tools run here; timeline
 * tools go to the editor window that has the edit open (EditorLink), where they run as "Assistant: <tool>" commands
 * of the editor's store, so the user sees them and Ctrl+Z undoes them. Electron-free: everything comes in as McpDeps.
 */
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  AnalysisKindName, AnalyzeMediaRef, AssistantScope, EditListEntry, EditPreset, EditProject, MediaAnalysis, MediaItem, RenderJob, RenderPreset,
} from "../../shared/types.ts";
import { naturalCompare } from "../autoedit-analyze.ts";
import type { Analyzer } from "./analyze.ts";
import type { FolderGuard } from "./folders.ts";
import { at, failure, plural, result, round, timecode } from "./format.ts";
import type { McpJobs, McpJob } from "./jobs.ts";
import { isFinal } from "./jobs.ts";
import type { EditorLink } from "./link.ts";
import { EDITOR_MEDIA, exportDirAllowed, extOf, mediaKind, readableType, safeOutputName } from "./security.ts";
import { STYLE_INFO } from "./styles.ts";

// ── what the tools need ──────────────────────────────────────────────────────

export interface McpDeps {
  editor: {
    list(): Promise<EditListEntry[]>;
    create(name: string, preset: EditPreset): Promise<{ path: string; project: EditProject }>;
    save(file: string, project: EditProject): Promise<{ modified: string }>;
    importMedia(file: string, files?: string[]): Promise<MediaItem[]>;
    export(file: string, sequenceId: string, opts: { preset: string; range: "all" | "inout"; name?: string }): Promise<string>;
    allowEditFile(file: string): void;
    editsRoot(): string;
  };
  renders: { presets(): Promise<RenderPreset[]>; get(id: string): RenderJob | undefined; cancel(id: string): void };
  link: EditorLink;
  folders: FolderGuard;
  jobs: McpJobs;
  analyzer: Analyzer;
  libraryRoot(): string;
  /** Show the edit in an editor window (desktop-shell's openEditor) and resolve once its page has attached the edit. */
  showEdit(file: string): Promise<void>;
  /** The editor's window jobs: Whisper and the RIFE tool (cancel). */
  cancelEditorJob?(id: string): void;
  log(m: string): void;
}

/** Who calls, with what rights, for one tool call. */
export interface CallCtx {
  session: string; client: string; tokenName: string; scopes: AssistantScope[];
  signal: AbortSignal;
  /** MCP progress notifications, when the client asked for them (a progressToken) */
  progress?(progress: number, total: number | undefined, message: string): void;
  edit(): string | undefined;
  setEdit(file: string | undefined): void;
}

type Result = { content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Shape = Record<string, z.ZodType>;
export interface ToolDef<S extends Shape = Shape> {
  name: string;
  /** the scope a call needs (auto_edit with dry_run and run_ai_tool without approve need less: see `needs`) */
  scope: AssistantScope;
  needs?(args: z.infer<z.ZodObject<S>>): AssistantScope[];
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  run(args: z.infer<z.ZodObject<S>>, ctx: CallCtx, deps: McpDeps): Promise<Result>;
}

const def = <S extends Shape>(d: ToolDef<S>) => d as unknown as ToolDef;

/** What the editor window answers a tool call with. */
interface PageReply { text: string; data?: Record<string, unknown>; image?: { data: string; mimeType: string } }

// ── shared bits ──────────────────────────────────────────────────────────────

const seconds = (what: string) => z.number().min(0).max(24 * 3600).describe(what);
const ids = (what: string) => z.array(z.string().min(1).max(80)).min(1).max(500).describe(what);

/** The edit this call works on: the session's, else the only (or most recent) open editor window. */
function currentEdit(ctx: CallCtx, deps: McpDeps): string {
  const mine = ctx.edit();
  if (mine && deps.link.windowFor(mine)) return mine;
  const open = deps.link.list();
  if (!open.length) throw new Error(mine ? `${path.basename(mine)} isn't open any more: call open_edit` : "No edit is open: call list_edits and open_edit, or create_edit");
  ctx.setEdit(open[0].path);
  return open[0].path;
}

async function page(ctx: CallCtx, deps: McpDeps, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<PageReply> {
  const file = currentEdit(ctx, deps);
  return deps.link.call<PageReply>(file, tool, args, { client: ctx.client, scopes: ctx.scopes, timeoutMs });
}

const fromPage = (r: PageReply): Result => result(r.text, r.data, r.image ? [{ type: "image", data: r.image.data, mimeType: r.image.mimeType }] : []);

/** A path from an assistant: absolute, an allowed folder (or the user says yes), a type we read. */
async function allowPath(p: string, ctx: CallCtx, deps: McpDeps, why: string, o: { folder?: boolean } = {}): Promise<string> {
  if (typeof p !== "string" || !path.isAbsolute(p)) throw new Error(`Give a full path (e.g. D:\\Shoots\\Day1), not "${p}"`);
  const abs = path.resolve(p);
  if (!o.folder && !readableType(abs)) throw new Error(`${path.basename(abs)}: only media and interchange files (video, audio, pictures, .tatvamedit, XML, EDL, OTIO, captions, LUTs) can be read`);
  await deps.folders.check(abs, { session: ctx.session, client: ctx.client, why });
  return abs;
}

const KINDS = ["video", "audio", "image"] as const;

/** Media files of a folder in series order (natural name order, or by date), the editor's types only. */
export async function folderMedia(folder: string, o: { recursive?: boolean; types?: readonly string[]; order?: "name" | "date"; limit?: number } = {}):
  Promise<{ files: { path: string; name: string; size: number; kind: "video" | "audio" | "image"; mtime: string }[]; skipped: number; truncated: boolean }> {
  const want = new Set(o.types?.length ? o.types : KINDS);
  const limit = o.limit ?? 2000;
  const files: { path: string; name: string; size: number; kind: "video" | "audio" | "image"; mtime: string }[] = [];
  let skipped = 0;
  let truncated = false;
  const walk = async (dir: string, depth: number) => {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => naturalCompare(a.name, b.name))) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (o.recursive && depth < 6 && !/^(cache|proxies|renders)$/i.test(e.name)) await walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      const k = mediaKind(p);
      if (!k || !EDITOR_MEDIA.has(extOf(p)) || !want.has(k) || /\.(part|tmp)\./i.test(e.name)) { skipped++; continue; }
      if (files.length >= limit) { truncated = true; return; }
      try { const st = await fsp.stat(p); files.push({ path: p, name: e.name, size: st.size, kind: k, mtime: st.mtime.toISOString() }); } catch { skipped++; }
    }
  };
  await walk(path.resolve(folder), 0);
  if (o.order === "date") files.sort((a, b) => a.mtime.localeCompare(b.mtime) || naturalCompare(a.path, b.path));
  else files.sort((a, b) => naturalCompare(path.relative(folder, a.path), path.relative(folder, b.path)));
  return { files, skipped, truncated };
}

export const FORMATS: { id: string; label: string; width: number; height: number }[] = [
  { id: "1080p", label: "HD 1080p (16:9)", width: 1920, height: 1080 },
  { id: "4k", label: "UHD 4K (16:9)", width: 3840, height: 2160 },
  { id: "720p", label: "HD 720p (16:9)", width: 1280, height: 720 },
  { id: "vertical", label: "Vertical 9:16 (Shorts, Reels)", width: 1080, height: 1920 },
  { id: "square", label: "Square 1:1", width: 1080, height: 1080 },
];
const FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

const jobText = (j: McpJob) => `${j.label}: ${j.status}${j.status === "running" ? ` ${Math.round(j.progress * 100)}%` : ""}${j.message && j.message !== j.status ? ` · ${j.message}` : ""}${j.error ? ` · ${j.error}` : ""}`;
const jobData = (j: McpJob) => ({ job_id: j.id, kind: j.kind, status: j.status, progress: round(j.progress, 3), message: j.message, ...(j.error ? { error: j.error } : {}),
  ...(j.result !== undefined && isFinal(j.status) ? { result: j.result } : {}) });

function renderSummary(j: RenderJob): { text: string; data: Record<string, unknown> } {
  const fps = j.fps ?? 25;
  const pct = Math.round((j.progress ?? 0) * 100);
  const parts = [`Render ${j.id.slice(0, 8)} (${j.preset}${j.w ? `, ${j.w}×${j.h}` : ""}): ${j.status}`];
  if (!["done", "failed", "cancelled"].includes(j.status)) parts.push(`${pct}% · ${j.step}${j.eta_s ? ` · about ${Math.round(j.eta_s)} s left` : ""}`);
  if (j.status === "done" && j.output) parts.push(`${j.output}${j.duration_s ? ` · ${at(j.duration_s, fps)} long` : ""}${j.encoder ? ` · ${j.encoder}` : ""}`);
  if (j.error) parts.push(j.error.split("\n")[0].slice(0, 300));
  return { text: parts.join("\n"), data: { render_id: j.id, status: j.status, progress: round(j.progress ?? 0, 3), step: j.step, eta_s: j.eta_s ?? null,
    output: j.output ?? null, duration_s: j.duration_s ?? null, width: j.w ?? null, height: j.h ?? null, fps: j.fps ?? null, encoder: j.encoder ?? null,
    preset: j.preset, error: j.error ?? null, warnings: j.warnings?.slice(0, 10) ?? [] } };
}

/** Media of the current edit as the analysis needs them (from the editor window). */
async function mediaRefs(ctx: CallCtx, deps: McpDeps, idsWanted?: string[]): Promise<AnalyzeMediaRef[]> {
  const r = await page(ctx, deps, "__media", { ids: idsWanted ?? null });
  return (r.data?.media as AnalyzeMediaRef[]) ?? [];
}

const analysisText = (a: MediaAnalysis): string => {
  const bits: string[] = [`${a.name} (${a.mediaId}): ${round(a.duration, 2)} s`];
  if (a.silences) bits.push(`${plural(a.silences.length, "silence")} (${round(a.silences.reduce((s, x) => s + x.end - x.start, 0), 1)} s)`);
  if (a.scenes) bits.push(`${plural(a.scenes.length, "scene cut")}`);
  if (a.bpm) bits.push(`${a.bpm} BPM, ${plural(a.beats?.length ?? 0, "beat")}`);
  if (a.loudness?.lufs !== undefined && a.loudness?.lufs !== null) bits.push(`${a.loudness.lufs} LUFS`);
  for (const [k, label] of [["black", "black"], ["freeze", "frozen"], ["blur", "blurred"], ["clipped", "clipped sound"]] as const) {
    const list = a[k];
    if (list?.length) bits.push(`${label} ${list.map((r) => `${round(r.start, 1)}–${round(r.end, 1)} s`).join(", ")}`);
  }
  if (a.transcript) bits.push(`transcript ${plural(a.transcript.length, "line")}${a.language ? ` (${a.language})` : ""}`);
  if (a.warnings?.length) bits.push(`warnings: ${a.warnings.join("; ")}`);
  return bits.join(" · ");
};

// ── the tools ────────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  // ── project ──
  def({
    name: "status", scope: "read", readOnly: true, title: "Status",
    description: "Start here. What Tatvam has open (edits, unsaved changes), the edit this session works on, running renders and jobs, this token's scopes and the folders you may use.",
    input: {},
    async run(_a, ctx, deps) {
      const open = deps.link.list();
      const mine = ctx.edit();
      const jobs = deps.jobs.list().filter((j) => !isFinal(j.status)).slice(0, 10);
      const lines = [
        `Scopes: ${ctx.scopes.join(", ")}.`,
        open.length ? `Open edits: ${open.map((o) => `${o.name}${o.dirty ? " (unsaved changes)" : ""} — ${o.path}`).join("; ")}.` : "No edit is open in an editor window.",
        `This session works on: ${mine ?? (open[0] ? `${open[0].name} (the open one)` : "nothing yet")}.`,
        `Library: ${deps.libraryRoot()} (edits in ${deps.editor.editsRoot()}).`,
        `Folders you may use: the library${deps.folders.sessionFolders(ctx.session).length ? ` and ${deps.folders.sessionFolders(ctx.session).join(", ")}` : ""}, plus the ones the user listed; any other folder asks the user first.`,
        jobs.length ? `Running jobs: ${jobs.map(jobText).join("; ")}.` : "No jobs running.",
      ];
      return result(lines.join("\n"), { scopes: ctx.scopes, open_edits: open.map((o) => ({ path: o.path, name: o.name, unsaved: o.dirty })), current_edit: mine ?? open[0]?.path ?? null,
        library: deps.libraryRoot(), jobs: jobs.map(jobData) });
    },
  }),
  def({
    name: "list_edits", scope: "read", readOnly: true, title: "List edits",
    description: "The edits in the library and the recently opened ones, newest first: path, name and when they were changed. Open one with open_edit.",
    input: { limit: z.number().int().min(1).max(100).optional().describe("How many (default 30)") },
    async run(a, _ctx, deps) {
      const list = (await deps.editor.list()).slice(0, a.limit ?? 30);
      const text = list.length ? list.map((e) => `${e.name} — ${e.path} (changed ${e.modified.slice(0, 16).replace("T", " ")})`).join("\n") : "There are no edits yet: create_edit makes one.";
      return result(text, { edits: list.map((e) => ({ path: e.path, name: e.name, modified: e.modified, recent: Boolean(e.recent) })) });
    },
  }),
  def({
    name: "open_edit", scope: "read", readOnly: true, title: "Open an edit",
    description: "Opens an edit in an editor window (so you and the user see the same timeline) and makes it this session's edit. If another edit with unsaved changes is open there, it fails unless save_first is true.",
    input: { path: z.string().min(3).max(1000).describe("Full path of the .tatvamedit file (from list_edits)"),
      save_first: z.boolean().optional().describe("Save the edit that is open now before switching (default false)") },
    async run(a, ctx, deps) {
      const file = await allowPath(a.path, ctx, deps, "to open an edit");
      if (!file.toLowerCase().endsWith(".tatvamedit")) throw new Error("open_edit takes a .tatvamedit file");
      if (!existsSync(file)) throw new Error(`${file} wasn't found`);
      const have = deps.link.windowFor(file);
      if (!have) {
        const busy = deps.link.list().find((w) => w.dirty);
        if (busy && !a.save_first) throw new Error(`"${busy.name}" has unsaved changes in the editor window. Call open_edit again with save_first: true (it saves first), or ask the user.`);
        if (busy) await deps.link.call(busy.path, "save_edit", {}, { client: ctx.client, scopes: ctx.scopes, timeoutMs: 60_000 });
        deps.editor.allowEditFile(file);
        await deps.showEdit(file);
        if (!(await deps.link.waitFor(file, 5_000))) throw new Error("The editor window didn't open the edit");
      }
      ctx.setEdit(file);
      const r = await deps.link.call<PageReply>(file, "get_timeline", { brief: true }, { client: ctx.client, scopes: ctx.scopes });
      return result(`Opened ${path.basename(file)}.\n${r.text}`, { path: file, ...(r.data ?? {}) });
    },
  }),
  def({
    name: "create_edit", scope: "edit", title: "Create an edit",
    description: "Makes a new edit in the library and opens it. With from_folder it imports that folder's video, audio and pictures in series order (natural name order), ready for auto_edit.",
    input: {
      name: z.string().min(1).max(80).describe("The edit's name (also its folder name)"),
      format: z.enum(["1080p", "4k", "720p", "vertical", "square"]).optional().describe("Sequence size (default 1080p; see list_formats)"),
      fps: z.number().optional().describe("Frame rate: 23.976, 24, 25, 29.97, 30, 50, 59.94 or 60 (default 25)"),
      from_folder: z.string().max(1000).optional().describe("Full path of a folder whose media to import"),
      recursive: z.boolean().optional().describe("Also import from sub-folders (default false)"),
      order: z.enum(["name", "date"]).optional().describe("Import order: series order by name (default) or by file date"),
    },
    async run(a, ctx, deps) {
      const f = FORMATS.find((x) => x.id === (a.format ?? "1080p"))!;
      const fps = a.fps ?? 25;
      if (!FPS.includes(fps)) throw new Error(`fps must be one of ${FPS.join(", ")}`);
      let files: string[] = [];
      let folderName = "";
      if (a.from_folder) {
        const dir = await allowPath(a.from_folder, ctx, deps, "to import its media into a new edit", { folder: true });
        const list = await folderMedia(dir, { recursive: a.recursive, order: a.order });
        if (!list.files.length) throw new Error(`${dir} has no video, audio or picture files the editor imports`);
        files = list.files.map((x) => x.path);
        folderName = path.basename(dir);
      }
      const made = await deps.editor.create(a.name, { width: f.width, height: f.height, fps });
      let imported: MediaItem[] = [];
      if (files.length) {
        imported = await deps.editor.importMedia(made.path, files);
        const binId = `b_${Math.random().toString(36).slice(2, 10)}`;
        const project: EditProject = { ...made.project, bins: [{ id: binId, name: folderName || "Imported", parentId: null }],
          media: imported.map((m) => ({ ...m, binId })) };
        await deps.editor.save(made.path, project);
      }
      const busy = deps.link.list().find((w) => w.dirty);
      if (busy) await deps.link.call(busy.path, "save_edit", {}, { client: ctx.client, scopes: ctx.scopes, timeoutMs: 60_000 }).catch(() => undefined);
      await deps.showEdit(made.path).catch((e) => deps.log(`create_edit: ${(e as Error).message}`));
      const attached = deps.link.windowFor(made.path);
      ctx.setEdit(made.path);
      const lines = [`Created ${a.name} (${f.label}, ${fps} fps) at ${made.path}.`];
      if (imported.length) lines.push(`Imported ${plural(imported.length, "file")}: ${imported.slice(0, 12).map((m) => `${m.name} [${m.id}] ${round(m.seconds ?? 0, 2)} s`).join(", ")}${imported.length > 12 ? " …" : ""}.`);
      if (!attached) lines.push("The editor window is still opening; call status in a moment.");
      return result(lines.join("\n"), { path: made.path, width: f.width, height: f.height, fps,
        media: imported.map((m) => ({ id: m.id, name: m.name, kind: m.kind, seconds: m.seconds ?? 0, has_audio: m.hasAudio })) });
    },
  }),
  def({
    name: "save_edit", scope: "edit", title: "Save the edit",
    description: "Saves the current edit to disk now (it also autosaves every few seconds).",
    input: {},
    async run(_a, ctx, deps) { return fromPage(await page(ctx, deps, "save_edit", {})); },
  }),
  def({
    name: "list_formats", scope: "read", readOnly: true, title: "List formats",
    description: "Sequence formats for create_edit and auto_edit: sizes and frame rates.",
    input: {},
    async run() {
      return result(`${FORMATS.map((f) => `${f.id}: ${f.label}, ${f.width}×${f.height}`).join("\n")}\nFrame rates: ${FPS.join(", ")}.`, { formats: FORMATS, fps: FPS });
    },
  }),

  // ── media ──
  def({
    name: "import_media", scope: "edit", title: "Import media",
    description: "Imports video, audio and picture files into the current edit's project bin (probe, thumbnails, waveforms): a list of paths, or a folder (series order). Returns the media ids. One undo step.",
    input: {
      paths: z.array(z.string().max(1000)).max(500).optional().describe("Full paths of files"),
      folder: z.string().max(1000).optional().describe("Full path of a folder (instead of, or as well as, paths)"),
      recursive: z.boolean().optional().describe("Folder: include sub-folders"),
      types: z.array(z.enum(KINDS)).optional().describe("Folder: only these kinds (default all three)"),
      order: z.enum(["name", "date"]).optional().describe("Folder: series order by name (default) or by date"),
      bin: z.string().max(80).optional().describe("Put them in this bin (made when missing; default the folder's name)"),
    },
    async run(a, ctx, deps) {
      const file = currentEdit(ctx, deps);
      const files: string[] = [];
      for (const p of a.paths ?? []) {
        const abs = await allowPath(p, ctx, deps, "to import it into the edit");
        if (!mediaKind(abs) || !EDITOR_MEDIA.has(extOf(abs))) throw new Error(`${path.basename(abs)} isn't a video, audio or picture file the editor imports`);
        files.push(abs);
      }
      let bin = a.bin;
      if (a.folder) {
        const dir = await allowPath(a.folder, ctx, deps, "to import its media into the edit", { folder: true });
        const list = await folderMedia(dir, { recursive: a.recursive, types: a.types, order: a.order });
        files.push(...list.files.map((x) => x.path));
        bin ??= path.basename(dir);
      }
      if (!files.length) throw new Error("Nothing to import: give paths or a folder with media in it");
      const items = await deps.editor.importMedia(file, files);
      const r = await deps.link.call<PageReply>(file, "add_media", { items, bin: bin ?? null }, { client: ctx.client, scopes: ctx.scopes });
      return fromPage(r);
    },
  }),
  def({
    name: "list_media", scope: "read", readOnly: true, title: "List media",
    description: "The current edit's media: id, name, kind, length (seconds and timecode), size, frame rate, sound, bin, and how many timeline clips use it.",
    input: { kind: z.enum(KINDS).optional().describe("Only this kind"), search: z.string().max(80).optional().describe("Name contains") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "list_media", a)); },
  }),
  def({
    name: "analyze_media", scope: "read", readOnly: true, title: "Analyse media",
    description: "Free analysis on this PC: silence, scenes (cuts), beats (BPM), loudness (LUFS), quality (black, frozen, blurred, clipped sound, energy and motion per half second) and transcript (local Whisper, when installed). Returns the results if they finish within wait_seconds, else a job id for job_status.",
    input: {
      media_ids: z.array(z.string().max(80)).max(200).optional().describe("Which media (default all of the edit's video and audio)"),
      kinds: z.array(z.enum(["silence", "scenes", "beats", "loudness", "quality", "transcript"])).min(1).describe("What to find"),
      language: z.string().max(10).optional().describe("Transcript language code (hi, kn, te, ta, en …) or auto"),
      wait_seconds: z.number().min(0).max(120).optional().describe("Wait this long for the results (default 30)"),
    },
    async run(a, ctx, deps) {
      const file = currentEdit(ctx, deps);
      const refs = (await mediaRefs(ctx, deps, a.media_ids)).filter((m) => m.kind !== "image");
      if (!refs.length) throw new Error("No video or audio media to analyse");
      const job = deps.jobs.start({ kind: "analysis", label: `Analysis of ${plural(refs.length, "file")}`, session: ctx.session, edit: file }, ({ signal, update }) =>
        deps.analyzer.run(file, refs, a.kinds as AnalysisKindName[], { signal, language: a.language,
          onProgress: (d, t, cur) => update({ progress: d / t, message: `${d} of ${t} done (${cur})` }) }));
      const j = await deps.jobs.wait(job.id, a.wait_seconds ?? 30, (x) => ctx.progress?.(x.progress, 1, x.message));
      if (j && j.status === "done") {
        const list = j.result as MediaAnalysis[];
        return result(list.map(analysisText).join("\n"), { job_id: j.id, analysis: list });
      }
      if (j && j.status === "failed") throw new Error(j.error ?? "The analysis failed");
      return result(`Still running: ${j ? jobText(j) : job.id}. Follow it with job_status("${job.id}").`, j ? jobData(j) : { job_id: job.id });
    },
  }),

  // ── timeline ──
  def({
    name: "get_timeline", scope: "read", readOnly: true, title: "Get the timeline",
    description: "The current sequence, concise: tracks, clips (id, track, start/end in seconds and timecode, source in/out, name, speed, effects), transitions and markers, plus the other sequences. Use from/to to look at a part.",
    input: {
      sequence_id: z.string().max(80).optional().describe("Another sequence of the edit (default the active one)"),
      from: seconds("Only clips ending after this time").optional(), to: seconds("Only clips starting before this time").optional(),
      details: z.boolean().optional().describe("Include effect parameters and keyframes (default false)"),
    },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "get_timeline", a)); },
  }),
  def({
    name: "open_sequence", scope: "edit", title: "Open a sequence",
    description: "Makes another sequence of the edit the active one (timeline tools work on the active sequence).",
    input: { sequence_id: z.string().min(1).max(80) },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "open_sequence", a)); },
  }),
  def({
    name: "add_clip", scope: "edit", title: "Add a clip",
    description: "Puts a media item on the timeline (picture on a video track and its sound on an audio track, linked). Default: at the end of V1, the whole media. One undo step.",
    input: {
      media_id: z.string().min(1).max(80),
      at: seconds("Timeline start (default: the end of the sequence)").optional(),
      track: z.string().max(80).optional().describe("Video (or audio) track: V1, V2, A1 … or a track id (default V1 / A1)"),
      in: seconds("Source in point (default 0)").optional(), out: seconds("Source out point (default the end)").optional(),
      mode: z.enum(["overwrite", "insert"]).optional().describe("overwrite (default) or insert (pushes later clips)"),
      video: z.boolean().optional().describe("Include the picture (default true)"), audio: z.boolean().optional().describe("Include the sound (default true)"),
    },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "add_clip", a)); },
  }),
  def({
    name: "move_clip", scope: "edit", title: "Move a clip",
    description: "Moves a clip (and its linked half) to a new start time, optionally to another track. Overwrites what is there.",
    input: { clip_id: z.string().min(1).max(80), to: seconds("New start time"), track: z.string().max(80).optional().describe("Target track (V1, V2, A1 … or an id)") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "move_clip", a)); },
  }),
  def({
    name: "trim_clip", scope: "edit", title: "Trim a clip",
    description: "Moves a clip's start and/or end edge to a timeline time (the source moves with it, within the media). ripple closes or opens the gap after it.",
    input: { clip_id: z.string().min(1).max(80), start: seconds("New start edge").optional(), end: seconds("New end edge").optional(),
      ripple: z.boolean().optional().describe("Shift later clips by the change (default false)") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "trim_clip", a)); },
  }),
  def({
    name: "split_at", scope: "edit", title: "Split at a time",
    description: "Cuts clips in two at a time (the razor): every unlocked track, or only some tracks or clips.",
    input: { at: seconds("Where to cut"), tracks: z.array(z.string().max(80)).max(40).optional().describe("Only these tracks (V1, A1 … or ids)"),
      clip_ids: z.array(z.string().max(80)).max(200).optional().describe("Only these clips") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "split_at", a)); },
  }),
  def({
    name: "delete_clips", scope: "edit", destructive: true, title: "Delete clips",
    description: "Removes clips (their linked halves too). ripple closes the gaps they leave. Undo brings them back.",
    input: { clip_ids: ids("The clips"), ripple: z.boolean().optional().describe("Close the gaps (default false)") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "delete_clips", a)); },
  }),
  def({
    name: "set_speed", scope: "edit", title: "Set speed",
    description: "Changes clips' speed (0.25 to 4; 0.5 = slow motion at half speed), optionally reversed; the clip's length changes with it.",
    input: { clip_ids: ids("The clips"), speed: z.number().min(0.25).max(4), reverse: z.boolean().optional(),
      ripple: z.boolean().optional().describe("Shift later clips by the length change (default true)") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "set_speed", a)); },
  }),
  def({
    name: "add_transition", scope: "edit", title: "Add a transition",
    description: "A transition at a cut: give a clip (its start, end or both edges) or a time and track. Types from list_catalog (transitions), e.g. fade, wipeleft, dissolve, gl:Dreamy; audio cuts take audio:constant_power.",
    input: {
      clip_id: z.string().max(80).optional().describe("A clip whose edge(s) get it"),
      edge: z.enum(["in", "out", "both"]).optional().describe("Which edge of clip_id (default out)"),
      at: seconds("Or: the time of the cut").optional(), track: z.string().max(80).optional().describe("With at: the track (default V1)"),
      type: z.string().max(80).optional().describe("Transition id (default fade)"),
      duration: z.number().min(0.04).max(10).optional().describe("Seconds (default 1)"),
    },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "add_transition", a)); },
  }),
  def({
    name: "add_effect", scope: "edit", title: "Add an effect",
    description: "Adds a video effect (to video clips) or an audio effect (to audio clips) with its defaults or the params you give. Ids from list_catalog (effects, audio_effects), e.g. adjust, look, gaussian_blur, audio:compressor; on audio clips also a whole chain preset, preset:<id> from list_catalog(audio_presets), e.g. preset:youtube_voice. Returns the effect ids.",
    input: { clip_ids: ids("The clips"), effect: z.string().min(1).max(80).describe("Effect id, or preset:<id> (an audio chain preset)"),
      params: z.record(z.string(), z.unknown()).optional().describe("Parameter values by name (numbers, text, booleans, [r,g,b])") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "add_effect", a)); },
  }),
  def({
    name: "set_effect_param", scope: "edit", title: "Set an effect parameter",
    description: "Sets one parameter of an effect on a clip, or of the clip's motion (effect_id \"motion\": position, scale, rotation, opacity) — a value, or keyframes at timeline times.",
    input: {
      clip_id: z.string().min(1).max(80), effect_id: z.string().min(1).max(80).describe("The effect's id (from add_effect / get_timeline with details), or \"motion\" or \"audio\" (gain, pan)"),
      param: z.string().min(1).max(60), value: z.unknown().optional().describe("A constant value (removes keyframes)"),
      keyframes: z.array(z.object({ at: seconds("Timeline time"), value: z.unknown(), ease: z.enum(["linear", "ease_in", "ease_out", "ease_in_out", "hold"]).optional() }))
        .max(200).optional().describe("Keyframes instead of a value"),
    },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "set_effect_param", a)); },
  }),
  def({
    name: "apply_mood", scope: "edit", title: "Apply a mood",
    description: "A one-click look (colour, film texture, its transitions and title style) on clips or the whole sequence. Mood ids from list_catalog (moods), e.g. warm_nostalgia, noir; or a look-pack look from list_catalog(looks), e.g. cinematic.teal_orange (effects only).",
    input: { mood: z.string().min(1).max(60).describe("A mood id or a look-pack look id"), clip_ids: z.array(z.string().max(80)).max(500).optional().describe("Default: every video clip"),
      intensity: z.number().min(0).max(1.5).optional().describe("Default 1"), transitions: z.boolean().optional().describe("Also its transitions at the cuts"),
      titles: z.boolean().optional().describe("Also restyle the titles") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "apply_mood", a)); },
  }),
  def({
    name: "add_title", scope: "edit", title: "Add a title",
    description: "A text title on a free video track above the picture: lower third, centre, top or bottom; optional template from list_catalog (title_templates).",
    input: { text: z.string().min(1).max(500), at: seconds("Start"), duration: z.number().min(0.2).max(600).optional().describe("Seconds (default 4)"),
      position: z.enum(["top", "center", "lower_third", "bottom"]).optional(), size: z.number().min(8).max(400).optional().describe("Font size in pixels at 1080p"),
      color: z.string().max(20).optional().describe("#rrggbb"), template: z.string().max(60).optional(),
      subtitle: z.string().max(200).optional().describe("A second line, for templates that have one") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "add_title", a)); },
  }),
  def({
    name: "add_captions", scope: "edit", title: "Add captions",
    description: "Captions on a new caption track: from cues you give (times on the timeline), or transcribed free on this PC with local Whisper from the sound of clips (or the whole sequence). For paid captions from the studio use run_ai_tool(captions).",
    input: {
      cues: z.array(z.object({ start: seconds("Start"), end: seconds("End"), text: z.string().min(1).max(400) })).max(2000).optional(),
      clip_ids: z.array(z.string().max(80)).max(200).optional().describe("Transcribe these clips (default every clip with sound)"),
      language: z.string().max(10).optional().describe("Whisper language code or auto (default auto)"),
      style: z.enum(["lines", "phrases"]).optional().describe("Whole lines, or short phrases for Shorts"),
    },
    async run(a, ctx, deps) {
      if (a.cues?.length) return fromPage(await page(ctx, deps, "add_captions", { cues: a.cues, style: a.style }));
      const file = currentEdit(ctx, deps);
      const plan = await page(ctx, deps, "__caption_sources", { clip_ids: a.clip_ids ?? null });
      const parts = (plan.data?.parts as { mediaId: string; clipId: string }[]) ?? [];
      if (!parts.length) throw new Error("No clips with sound to transcribe");
      const refs = await mediaRefs(ctx, deps, [...new Set(parts.map((p) => p.mediaId))]);
      const job = deps.jobs.start({ kind: "transcript", label: `Captions from ${plural(refs.length, "file")}`, session: ctx.session, edit: file }, async ({ signal, update }) => {
        const an = await deps.analyzer.run(file, refs, ["transcript"], { signal, language: a.language,
          onProgress: (d, t) => update({ progress: (0.9 * d) / t, message: `Transcribed ${d} of ${t}` }) });
        const missing = an.filter((x) => !x.transcript).map((x) => x.warnings?.join("; ")).filter(Boolean);
        if (!an.some((x) => x.transcript)) throw new Error(missing[0] ?? "Nothing was transcribed");
        const r = await deps.link.call<PageReply>(file, "add_captions", { transcripts: an.map((x) => ({ mediaId: x.mediaId, segments: x.transcript ?? [] })),
          clip_ids: a.clip_ids ?? null, style: a.style }, { client: ctx.client, scopes: ctx.scopes });
        return { text: r.text, ...(r.data ?? {}) };
      });
      const j = await deps.jobs.wait(job.id, 50, (x) => ctx.progress?.(x.progress, 1, x.message));
      if (j?.status === "done") return result(String((j.result as { text?: string })?.text ?? "Captions added"), jobData(j));
      if (j?.status === "failed") throw new Error(j.error ?? "Transcription failed");
      return result(`Transcribing: ${j ? jobText(j) : job.id}. Follow it with job_status("${job.id}"); the captions go on when it ends.`, j ? jobData(j) : { job_id: job.id });
    },
  }),
  def({
    name: "add_marker", scope: "edit", title: "Add a marker",
    description: "A sequence marker at a time (a chapter, a note for the user, a beat).",
    input: { at: seconds("Time"), name: z.string().max(120).optional(), comment: z.string().max(500).optional(), color: z.string().max(20).optional(),
      duration: z.number().min(0).max(3600).optional().describe("Seconds (a range marker)") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "add_marker", a)); },
  }),
  def({
    name: "set_audio", scope: "edit", title: "Set audio",
    description: "Sound of clips or a track: gain (dB), pan (-1..1), fades (seconds), mute, and the role (dialogue, music, sfx, ambience) the export's auto-ducking uses: music and ambience duck under dialogue.",
    input: {
      clip_ids: z.array(z.string().max(80)).max(500).optional(), track: z.string().max(80).optional().describe("An audio track (A1 …) instead of clips"),
      gain_db: z.number().min(-60).max(24).optional(), pan: z.number().min(-1).max(1).optional(),
      fade_in: z.number().min(0).max(30).optional(), fade_out: z.number().min(0).max(30).optional(), mute: z.boolean().optional(),
      role: z.enum(["dialogue", "music", "sfx", "ambience"]).optional(),
    },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "set_audio", a)); },
  }),
  def({
    name: "undo", scope: "edit", title: "Undo",
    description: "Undoes the last assistant change(s) in the editor (like Ctrl+Z). It stops at a change the user made.",
    input: { steps: z.number().int().min(1).max(20).optional().describe("Default 1") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "undo", a)); },
  }),
  def({
    name: "redo", scope: "edit", title: "Redo",
    description: "Redoes what undo took back (like Ctrl+Shift+Z).",
    input: { steps: z.number().int().min(1).max(20).optional().describe("Default 1") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "redo", a)); },
  }),

  // ── see it ──
  def({
    name: "get_frame", scope: "read", readOnly: true, title: "See a frame",
    description: "The program monitor at a time as a PNG (the exact render: effects, titles, transitions), at most 1280 px wide.",
    input: { at: seconds("Timeline time"), width: z.number().int().min(160).max(1280).optional().describe("Default 960") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "get_frame", a, 45_000)); },
  }),
  def({
    name: "get_waveform_summary", scope: "read", readOnly: true, title: "Waveform summary",
    description: "The loudness shape of a clip or media item in a few buckets (0..1 peaks), with its quiet stretches: for finding where people speak or the music hits.",
    input: { clip_id: z.string().max(80).optional(), media_id: z.string().max(80).optional(), buckets: z.number().int().min(8).max(200).optional().describe("Default 40") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "get_waveform_summary", a)); },
  }),

  // ── auto edit ──
  def({
    name: "list_auto_edit_styles", scope: "read", readOnly: true, title: "Auto edit styles",
    description: "The auto edit styles: what each does, its defaults and what it suits.",
    input: {},
    async run() {
      return result(STYLE_INFO.map((s) => `${s.id} — ${s.name}: ${s.does} Defaults: ${s.defaults}. Best for ${s.bestFor}.`).join("\n"), { styles: STYLE_INFO });
    },
  }),
  def({
    name: "auto_edit", scope: "edit", needs: (a) => (a.dry_run ? ["read"] : ["edit"]), title: "Auto edit",
    description: "Cuts a new sequence \"Auto edit · <folder> · <style>\" from the edit's media (or a folder, imported first) in a style: talking_head, montage, documentary, highlights or slideshow. dry_run returns the plan (clips used, cuts, silence removed, length) without changing anything. Applied as ONE undo step. Nothing paid runs: AI music is proposed afterwards.",
    input: {
      style: z.enum(["talking_head", "montage", "documentary", "highlights", "slideshow"]),
      media_ids: z.array(z.string().max(80)).max(500).optional().describe("Which media (default all video, audio and pictures in the edit)"),
      folder: z.string().max(1000).optional().describe("Import this folder first and use its media"),
      target_seconds: z.number().min(3).max(4 * 3600).optional().describe("Target length (default per style)"),
      format: z.enum(["16:9", "9:16", "1:1"]).optional().describe("Default per style (highlights 9:16)"),
      music: z.string().max(1000).optional().describe("A media id, a full path of a music file, \"library\" (the first audio item), \"ai\" (proposed after) or \"none\""),
      captions: z.string().max(10).optional().describe("Language code for captions (local Whisper), or \"none\""),
      mood: z.string().max(60).optional().describe("A mood id (list_catalog moods) or \"none\""),
      transitions: z.enum(["none", "cuts", "soft", "style"]).optional().describe("cuts = hard cuts; soft = dissolves; style = the style's own (default)"),
      order: z.enum(["name", "date", "timecode", "content"]).optional().describe("Clip order (default name = series order)"),
      title: z.string().max(120).optional().describe("Hook / opening title text"),
      sfx: z.enum(["none", "subtle", "normal", "punchy"]).optional().describe("Add sound effects at this intensity (auto_sfx) in the same undo step (default none)"),
      dry_run: z.boolean().optional().describe("Only return the plan"),
    },
    async run(a, ctx, deps) {
      const file = currentEdit(ctx, deps);
      let mediaIds = a.media_ids;
      let folderName: string | undefined;
      if (a.folder) {
        const dir = await allowPath(a.folder, ctx, deps, `to auto edit its media (${a.style})`, { folder: true });
        folderName = path.basename(dir);
        const list = await folderMedia(dir, { order: a.order === "date" ? "date" : "name" });
        if (!list.files.length) throw new Error(`${dir} has no video, audio or picture files the editor imports`);
        if (a.dry_run) {
          // a plan needs the media in the edit; a dry run imports nothing, so it plans from what is already there
          const have = await mediaRefs(ctx, deps);
          const known = new Set(have.map((m) => path.resolve(m.path).toLowerCase()));
          const missing = list.files.filter((f) => !known.has(path.resolve(f.path).toLowerCase()));
          if (missing.length) throw new Error(`${plural(missing.length, "file")} of ${folderName} aren't in the edit yet: run auto_edit without dry_run (it imports them), or import_media first`);
          mediaIds = have.filter((m) => list.files.some((f) => path.resolve(f.path).toLowerCase() === path.resolve(m.path).toLowerCase())).map((m) => m.id);
        } else {
          const items = await deps.editor.importMedia(file, list.files.map((f) => f.path));
          await deps.link.call(file, "add_media", { items, bin: folderName }, { client: ctx.client, scopes: ctx.scopes });
          mediaIds = items.map((m) => m.id);
        }
      }
      let musicPath: string | undefined;
      if (a.music && path.isAbsolute(a.music)) {
        musicPath = await allowPath(a.music, ctx, deps, "to use it as the music");
        const items = await deps.editor.importMedia(file, [musicPath]);
        await deps.link.call(file, "add_media", { items, bin: "Music" }, { client: ctx.client, scopes: ctx.scopes });
        a.music = items[0]?.id ?? "none";
      }
      const refs = await mediaRefs(ctx, deps, mediaIds);
      const musicRef = a.music && !["none", "ai", "library"].includes(a.music) ? (await mediaRefs(ctx, deps, [a.music]))[0] : undefined;
      if (a.music && !["none", "ai", "library"].includes(a.music) && !musicRef) throw new Error(`No media ${a.music} in the edit`);
      const pics = refs.filter((m) => m.kind !== "audio" && m.id !== musicRef?.id);
      if (!pics.length) throw new Error("There is no video or picture to cut: import media first");
      const kinds: AnalysisKindName[] = ["silence", "scenes", "loudness", "quality"];
      if (a.captions && a.captions !== "none") kinds.push("transcript");
      const job = deps.jobs.start({ kind: "auto_edit", label: `Auto edit (${a.style})`, session: ctx.session, edit: file }, async ({ signal, update }) => {
        update({ message: "Analysing the clips", progress: 0.02 });
        const analysis = await deps.analyzer.run(file, refs.filter((m) => m.id !== musicRef?.id), kinds, { signal, language: a.captions,
          onProgress: (d, t, cur) => update({ progress: 0.05 + (0.8 * d) / t, message: `Analysed ${d} of ${t} (${cur})` }) });
        const libraryMusic = a.music === "library" ? refs.find((m) => m.kind === "audio") : undefined;
        const music = musicRef ?? libraryMusic;
        if (music) analysis.push(...await deps.analyzer.run(file, [music], ["beats", "loudness"], { signal }));
        update({ message: a.dry_run ? "Planning" : "Cutting the sequence", progress: 0.9 });
        const r = await deps.link.call<PageReply>(file, "auto_edit", { ...a, folder: folderName ?? null, music: music?.id ?? (a.music === "ai" ? "ai" : "none"),
          media_ids: refs.map((m) => m.id), analysis }, { client: ctx.client, scopes: ctx.scopes, timeoutMs: 120_000 });
        return r;
      });
      const j = await deps.jobs.wait(job.id, 110, (x) => ctx.progress?.(x.progress, 1, x.message));
      if (j?.status === "done") return fromPage(j.result as PageReply);
      if (j?.status === "failed") throw new Error(j.error ?? "Auto edit failed");
      return result(`Still working: ${j ? jobText(j) : job.id}. Follow it with job_status("${job.id}").`, j ? jobData(j) : { job_id: job.id });
    },
  }),
  // auto-sfx (docs/EDITOR.md §15.2, additive): the sounds are made in the editor window (the SFX engine), free
  def({
    name: "auto_sfx", scope: "edit", needs: (a) => (a.dry_run ? ["read"] : ["edit"]), title: "Auto sound effects",
    description: "Adds sound effects where the edit calls for them, made free on this PC: whooshes on transitions, whoosh + soft impact on wipes, pops and swishes on titles and stickers, typing, countdown ticks, punch-in swishes, slow-motion risers, freeze shutters, shake booms, glitches; beats opt-in. On an SFX track, 6 dB lower under speech; a re-run replaces earlier ones. dry_run lists them only. One undo step.",
    input: {
      intensity: z.enum(["subtle", "normal", "punchy"]).optional().describe("Levels −24 / −18 / −12 dB and the variants (default normal)"),
      rules: z.array(z.enum(["transitions", "stingers", "titles", "stickers", "countdowns", "punch_ins", "speed_ramps", "freeze_frames", "shake", "glitch", "beats"]))
        .max(11).optional().describe("Only these rules (default every rule but beats)"),
      range: z.union([z.enum(["all", "inout"]), z.object({ start: seconds("From"), end: seconds("To") })]).optional()
        .describe("all (default), the in/out marks, or { start, end } in seconds"),
      dry_run: z.boolean().optional().describe("Only return the plan (time, sound, why) without changing anything"),
    },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "auto_sfx", a, 180_000)); },
  }),
  // one sound effect from the library (docs/EDITOR.md §15.1), made in the editor window: free, on this PC
  def({
    name: "add_sfx", scope: "edit", title: "Add a sound effect",
    description: "Places one sound effect from the built-in library (made free on this PC) on the SFX track at a time: a preset id from list_catalog(sfx), or a tag (whoosh, impact, pop, riser, typing, ding …) and the seed picks among the matching sounds. One undo step.",
    input: {
      preset: z.string().min(1).max(80).optional().describe("A sound id from list_catalog(sfx), e.g. whoosh.air_soft"),
      tag: z.string().min(1).max(40).optional().describe("Or a tag: the first matching sound (another with seed)"),
      at: seconds("Where it starts on the timeline"),
      gain_db: z.number().min(-60).max(12).optional().describe("Clip gain in dB (default 0: the sound's own −16 LUFS)"),
      seed: z.number().int().min(0).max(2 ** 31 - 1).optional().describe("A variation of the sound (default 1)"),
    },
    async run(a, ctx, deps) {
      if (!a.preset && !a.tag) throw new Error("Give preset (a sound id from list_catalog(sfx)) or tag");
      return fromPage(await page(ctx, deps, "add_sfx", a, 90_000));
    },
  }),

  // ── catalogue ──
  def({
    name: "list_catalog", scope: "read", readOnly: true, title: "List the catalogue",
    description: "Ids for the other tools: transitions, effects (video), audio_effects, moods, looks (moods and the look-pack looks), audio_presets (audio chain presets for add_effect), sfx (sound effects with tags and categories, for add_sfx) or title_templates, with a search.",
    input: { kind: z.enum(["transitions", "effects", "audio_effects", "moods", "looks", "audio_presets", "sfx", "title_templates"]), search: z.string().max(60).optional(),
      limit: z.number().int().min(1).max(400).optional().describe("Default 80") },
    async run(a, ctx, deps) { return fromPage(await page(ctx, deps, "list_catalog", a)); },
  }),

  // ── export ──
  def({
    name: "list_presets", scope: "read", readOnly: true, title: "Export presets",
    description: "Export presets on this PC: id, size, codec and the encoder it will use.",
    input: {},
    async run(_a, _ctx, deps) {
      const list = await deps.renders.presets();
      return result(list.map((p) => `${p.id}: ${p.label} — ${p.w}×${p.h}${p.fps ? ` ${p.fps} fps` : ""}, ${p.codec}${p.encoder ? ` (${p.encoder})` : ""}`).join("\n"),
        { presets: list.map((p) => ({ id: p.id, label: p.label, width: p.w, height: p.h, fps: p.fps, codec: p.codec, container: p.container, encoder: p.encoder ?? null })) });
    },
  }),
  def({
    name: "export", scope: "export", title: "Export",
    description: "Saves the edit, then renders the active sequence (or in/out range) on this PC's GPU into the edit's Renders folder. Without a preset it makes a quick 720p draft (draft720). Returns a render id: follow it with render_status.",
    input: { preset: z.string().min(1).max(40).optional().describe("A preset id from list_presets (default draft720, a fast 720p H.264 draft)"), range: z.enum(["all", "inout"]).optional(),
      name: z.string().max(100).optional().describe("Output base name (default the sequence name); never a path"),
      sequence_id: z.string().max(80).optional() },
    async run(a, ctx, deps) {
      const file = currentEdit(ctx, deps);
      const conf = exportDirAllowed(file, deps.libraryRoot());
      if (!conf.ok) throw new Error(conf.reason);
      const name = safeOutputName(a.name);
      const presets = await deps.renders.presets();
      // a draft by default: draft720 where this build has it, else the fastest 1080p review
      const preset = a.preset ?? (presets.some((p) => p.id === "draft720") ? "draft720" : "review1080");
      if (!presets.some((p) => p.id === preset)) throw new Error(`Unknown preset ${preset}: ${presets.map((p) => p.id).join(", ")}`);
      const saved = await page(ctx, deps, "save_edit", {});
      const seqId = a.sequence_id ?? String(saved.data?.sequence_id ?? "");
      if (!seqId) throw new Error("No sequence to export");
      const id = await deps.editor.export(file, seqId, { preset, range: a.range ?? "all", ...(name ? { name } : {}) });
      return result(`Export started: render ${id} (${preset}) into ${conf.dir}. Follow it with render_status("${id}").`, { render_id: id, folder: conf.dir, preset });
    },
  }),
  def({
    name: "render_status", scope: "read", readOnly: true, title: "Render status",
    description: "A render's progress, time left and, when done, the output file and its length. wait_seconds waits (with progress notifications) until it ends or the time is up.",
    input: { render_id: z.string().min(6).max(64), wait_seconds: z.number().min(0).max(120).optional() },
    async run(a, ctx, deps) {
      let j = deps.renders.get(a.render_id);
      if (!j) throw new Error(`No render ${a.render_id}`);
      const until = Date.now() + (a.wait_seconds ?? 0) * 1000;
      while (j && !["done", "failed", "cancelled"].includes(j.status) && Date.now() < until && !ctx.signal.aborted) {
        ctx.progress?.(j.progress ?? 0, 1, `${j.step} (${Math.round((j.progress ?? 0) * 100)}%)`);
        await new Promise((r) => setTimeout(r, 1000));
        j = deps.renders.get(a.render_id);
      }
      const s = renderSummary(j!);
      return result(s.text, s.data);
    },
  }),
  def({
    name: "cancel_render", scope: "export", title: "Cancel a render",
    description: "Stops a queued or running render.",
    input: { render_id: z.string().min(6).max(64) },
    async run(a, _ctx, deps) {
      if (!deps.renders.get(a.render_id)) throw new Error(`No render ${a.render_id}`);
      deps.renders.cancel(a.render_id);
      return result(`Render ${a.render_id} cancelled.`, { render_id: a.render_id, cancelled: true });
    },
  }),
  def({
    name: "job_status", scope: "read", readOnly: true, title: "Job status",
    description: "A job's progress and, when done, its result (analysis, transcript, auto edit, AI tool). wait_seconds waits with progress notifications.",
    input: { job_id: z.string().min(3).max(40), wait_seconds: z.number().min(0).max(120).optional() },
    async run(a, ctx, deps) {
      const j0 = deps.jobs.get(a.job_id);
      if (!j0) throw new Error(`No job ${a.job_id}`);
      const j = (await deps.jobs.wait(a.job_id, a.wait_seconds ?? 0, (x) => ctx.progress?.(x.progress, 1, x.message))) ?? j0;
      const r = j.result as PageReply | MediaAnalysis[] | undefined;
      if (j.status === "done" && Array.isArray(r)) return result(r.map(analysisText).join("\n"), { ...jobData(j) });
      if (j.status === "done" && r && typeof (r as PageReply).text === "string") return result((r as PageReply).text, { ...jobData(j), ...((r as PageReply).data ?? {}) });
      return result(jobText(j), jobData(j));
    },
  }),
  def({
    name: "cancel_job", scope: "edit", title: "Cancel a job",
    description: "Stops a running job (analysis, transcript, auto edit, AI tool).",
    input: { job_id: z.string().min(3).max(40) },
    async run(a, _ctx, deps) {
      if (!deps.jobs.cancel(a.job_id)) throw new Error(`No running job ${a.job_id}`);
      return result(`Job ${a.job_id} cancelled.`, { job_id: a.job_id, cancelled: true });
    },
  }),

  // ── paid AI tools ──
  def({
    name: "ai_tools", scope: "read", readOnly: true, title: "AI tools",
    description: "The editor's AI tools (captions, translate captions, voice-over, music, sound effects, voice clean-up, dub) and whether they run live or in mock mode. They are priced first and paid through the studio's budgets.",
    input: {},
    async run(_a, ctx, deps) { return fromPage(await page(ctx, deps, "ai_tools", {})); },
  }),
  def({
    name: "run_ai_tool", scope: "edit", needs: (a) => (a.approve ? ["edit", "spend"] : ["edit"]), title: "Run an AI tool",
    description: "Runs one of the editor's paid AI tools: it is priced, then shown to the user in the app as a proposal to approve. With approve: true and a token with the spend scope, it is approved for you if every budget allows it. Returns a job id: job_status follows it; the result lands in the edit.",
    input: {
      tool: z.enum(["captions", "translate_captions", "voice_over", "music", "sound_effect", "clean_voice", "dub"]),
      args: z.object({
        clip_ids: z.array(z.string().max(80)).max(100).optional(), language: z.string().max(10).optional(), languages: z.array(z.string().max(10)).max(8).optional(),
        text: z.string().max(5000).optional(), prompt: z.string().max(1000).optional(), seconds: z.number().min(1).max(600).optional(),
        at: seconds("Timeline time").optional(), volume_db: z.number().min(-40).max(6).optional(), target: z.string().max(10).optional(),
      }).describe("captions: clip_ids?, language · translate_captions: languages · voice_over: text, language · music: prompt, seconds, at?, volume_db? · sound_effect: prompt, seconds · clean_voice: clip_ids · dub: clip_ids (one), target"),
      approve: z.boolean().optional().describe("Approve within budgets (needs the spend scope)"),
    },
    async run(a, ctx, deps) {
      const file = currentEdit(ctx, deps);
      const job = deps.jobs.create({ kind: "ai", label: `AI ${a.tool}`, session: ctx.session, edit: file });
      const r = await page(ctx, deps, "run_ai_tool", { ...a, job_id: job.id, approve: Boolean(a.approve) && ctx.scopes.includes("spend") });
      return result(`${r.text}\nFollow it with job_status("${job.id}").`, { job_id: job.id, ...(r.data ?? {}) });
    },
  }),
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** The scopes one call needs. */
export const scopesFor = (t: ToolDef, args: Record<string, unknown>): AssistantScope[] => (t.needs ? t.needs(args as never) : [t.scope]);

export { failure, timecode };
