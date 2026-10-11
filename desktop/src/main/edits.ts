/**
 * Writes an episode's cut into Edits/ as a CMX3600 EDL and an FCPXML (edl.ts), pointing at the local files. Uses the
 * server's render plan when it has one, else the cut order from the last manifest. Electron-free.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { writeEdl, writeFcpxml, type EdlClip } from "./edl.ts";
import { probeMedia, type FfmpegInfo } from "./ffmpeg.ts";
import type { Library } from "./library.ts";
import { renderTemplate } from "./naming.ts";
import type { RenderPlan } from "./render-args.ts";
import type { Manifest } from "./sync.ts";
import { UpstreamError, type Upstream } from "./upstream.ts";

export interface EditsDeps { library: Library; upstream: Upstream; ff(): FfmpegInfo | null; log(msg: string): void }

/** Project title for folder names (mirror → server → index). */
export async function projectTitle(d: EditsDeps, pid: number): Promise<{ id: number; title: string; aspect?: string }> {
  const m = d.library.existingMirror(pid)?.project(pid);
  if (m?.title) return { id: pid, title: m.title, aspect: m.aspect };
  try {
    const p = await d.upstream.json<{ id: number; title: string; aspect?: string }>(`/api/projects/${pid}`, { timeoutMs: 10_000 });
    return { id: pid, title: p.title, aspect: p.aspect };
  } catch {
    return { id: pid, title: d.library.title(pid) || "Project" };
  }
}

export async function writeEdits(d: EditsDeps, pid: number, eid: number, lang?: string): Promise<{ edl: string; fcpxml: string }> {
  const lib = d.library;
  const mirror = lib.mirror(pid);
  const project = await projectTitle(d, pid);
  const manifest = JSON.parse(mirror.getMeta("manifest") || "null") as Manifest | null;
  const episode = manifest?.episodes.find((e) => e.id === eid);
  const language = lang || manifest?.project.primary_language || "en";
  const ffi = d.ff();
  const clips: EdlClip[] = [];
  let fps = 24;
  let w = 1920;
  let h = 1080;
  let plan: RenderPlan | null = null;
  try {
    const q = new URLSearchParams({ lang: language, w: "1920", h: "1080", fps: "24", effects: "1", captions: "0", music: "0", upscaled: "1" });
    plan = await d.upstream.json<RenderPlan>(`/api/episodes/${eid}/render-plan?${q}`, { timeoutMs: 120_000 });
  } catch (e) {
    if (!(e instanceof UpstreamError && (e.status === 404 || e.status === 405))) d.log(`EDL plan for ${eid}: ${(e as Error).message}`);
  }
  if (plan?.segments?.length) {
    fps = plan.fps || 24;
    w = plan.w;
    h = plan.h;
    for (const s of plan.segments) {
      const p = lib.resolveKeyOriginal(s.source) ?? "";
      clips.push({ name: p ? path.basename(p) : path.basename(s.source), path: p, srcIn: s.trim_in, duration: s.seg_len, speed: s.speed,
        transition: s.transition, still: s.source_kind === "still", hasAudio: s.has_audio,
        mediaDuration: p && ffi ? (await probeMedia(ffi.path, p)).duration : undefined });
    }
  } else if (episode && manifest) {
    const shots = episode.shots.filter((s) => s.include).sort((a, b) => (a.cut_index ?? a.order) - (b.cut_index ?? b.order));
    for (const s of shots) {
      const item = manifest.items.find((i) => i.shot_id === s.id && i.folder === "Takes" && i.selected && ["video", "lipsync", "voicelock", "upscale"].includes(i.kind))
        ?? manifest.items.find((i) => i.shot_id === s.id && i.folder === "Takes" && i.kind === "video");
      if (!item) continue;
      const p = lib.resolveKeyOriginal(item.key) ?? "";
      clips.push({ name: p ? path.basename(p) : item.label || item.key, path: p, srcIn: 0, duration: Number(item.duration_s || s.duration_s || 0) });
    }
  }
  const season = episode?.season ?? 1;
  const number = episode?.number ?? 0;
  const base = renderTemplate("{project}_S{season:02}E{episode:02}{_lang}_cut", { project: project.title, season, episode: number, lang: language });
  const dir = path.join(lib.folderFor(pid).path, "Edits");
  await fsp.mkdir(dir, { recursive: true });
  const title = `${project.title} S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")} ${language}`;
  const edl = path.join(dir, `${base}.edl`);
  const fcpxml = path.join(dir, `${base}.fcpxml`);
  await fsp.writeFile(edl, writeEdl(clips, { title, fps }), "utf8");
  await fsp.writeFile(fcpxml, writeFcpxml(clips, { title, fps, width: w, height: h }), "utf8");
  return { edl, fcpxml };
}
