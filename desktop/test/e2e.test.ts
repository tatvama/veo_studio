/**
 * End to end against a running studio server (skipped unless TATVAM_E2E=1; needs FFmpeg, ideally a GPU):
 * sync the approved cut into a library folder, write the EDL / FCPXML, render it locally (TATVAM_E2E_PRESET, default
 * yt4k = 3840×2160 HEVC 10-bit), check the file, upload it to the Render Center and find the new Export.
 *
 *   TATVAM_E2E=1 TATVAM_E2E_SERVER=http://127.0.0.1:8199 TATVAM_E2E_EMAIL=… TATVAM_E2E_PASSWORD=… \
 *   TATVAM_E2E_PID=2 TATVAM_E2E_EID=2 [TATVAM_E2E_LIBRARY=C:\tmp\lib] node --test test/e2e.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Config } from "../src/main/config.ts";
import { writeEdits } from "../src/main/edits.ts";
import { locateFfmpeg, probeHardware, probeMedia } from "../src/main/ffmpeg.ts";
import { Library } from "../src/main/library.ts";
import { RenderManager } from "../src/main/render.ts";
import { SyncManager } from "../src/main/sync.ts";
import { Upstream } from "../src/main/upstream.ts";
import type { RenderJob, SyncStatus } from "../src/shared/types.ts";

const E = process.env;
const on = E.TATVAM_E2E === "1";

test("sync → EDL → local 4K render → upload", { skip: !on && "set TATVAM_E2E=1 (see the file header)", timeout: 30 * 60_000 }, async () => {
  const server = E.TATVAM_E2E_SERVER || "http://127.0.0.1:8199";
  const pid = Number(E.TATVAM_E2E_PID);
  const eid = Number(E.TATVAM_E2E_EID);
  const preset = E.TATVAM_E2E_PRESET || "yt4k";
  const login = await fetch(`${server}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "veo-studio" },
    body: JSON.stringify({ email: E.TATVAM_E2E_EMAIL, password: E.TATVAM_E2E_PASSWORD }) });
  assert.equal(login.status, 200, "sign in");
  const cookie = (login.headers.getSetCookie().find((c) => c.startsWith("veo_session=")) ?? "").split(";")[0];
  assert.ok(cookie);

  const userData = mkdtempSync(path.join(os.tmpdir(), "tatvam-e2e-ud-"));
  const libRoot = E.TATVAM_E2E_LIBRARY || mkdtempSync(path.join(os.tmpdir(), "tatvam-e2e-lib-"));
  const log = (m: string) => { if (E.TATVAM_E2E_VERBOSE) console.log(m); };
  const config = new Config(userData, userData, { TATVAM_SERVER: server });
  config.set({ libraryRoot: libRoot });
  const library = new Library(config, userData, log);
  const upstream = new Upstream({ serverUrl: () => server, cookie: async () => cookie, log });
  const ffi = locateFfmpeg({ appPath: path.resolve("."), packaged: false });
  assert.ok(ffi, "FFmpeg found");
  const t0 = Date.now();
  const probe = await probeHardware(ffi.path, path.join(userData, "hw.json"));
  const probeMs = Date.now() - t0;

  // 1. sync
  const statuses: SyncStatus[] = [];
  const sync = new SyncManager({ library, upstream, templates: () => config.get().naming, serverUrl: () => server, autoSync: () => false,
    broadcast: (s) => statuses.push(s), writeEdits: (p, e) => writeEdits({ library, upstream, ff: () => ffi, log }, p, e), log });
  const ts = Date.now();
  await sync.start(pid, { scope: "approved" });
  const syncMs = Date.now() - ts;
  const last = sync.status(pid);
  assert.equal(last.phase, "done", `sync errors: ${last.errors.join("; ")}`);
  await sync.stop(pid);
  const folder = library.folderFor(pid).path;
  const takes = readdirSync(path.join(folder, "Takes"));
  assert.equal(takes.length, 3);
  assert.ok(takes.every((n) => /^Kaali-E2E_S01E01_00\d_SC0\d_SH00\d_video_T01\.mp4$/.test(n)), takes.join(", "));
  assert.equal(readdirSync(path.join(folder, "Audio", "Music")).length, 1);
  const edits = readdirSync(path.join(folder, "Edits"));
  assert.ok(edits.some((n) => n.endsWith(".edl")) && edits.some((n) => n.endsWith(".fcpxml")), edits.join(", "));
  const edl = readFileSync(path.join(folder, "Edits", edits.find((n) => n.endsWith(".edl"))!), "utf8");
  assert.match(edl, /AA\/V {2}D {4}012/, "the 0.5 s fade became a 12-frame dissolve");
  assert.ok(existsSync(path.join(folder, "project.tatvam.json")));
  assert.ok(statuses.some((s) => s.phase === "downloading") && statuses.some((s) => s.phase === "renaming"));
  // the gateway would now serve /media/<key> from here
  const mirror = library.mirror(pid);
  const ready = mirror.files({ state: "ready" });
  assert.ok(ready.every((f) => existsSync(path.join(folder, f.local_path))));
  assert.ok(library.resolveKey(ready[0].key));

  // 2. render
  const jobs: RenderJob[] = [];
  const renders = new RenderManager({ upstream, library, ff: () => ffi, probe: async () => probe, settings: () => config.get(),
    jobsFile: path.join(userData, "renders.json"), broadcast: (j) => jobs.push(j), log });
  const tr = Date.now();
  const id = renders.start({ pid, eid, lang: "en", preset, upload: true, localUpscale: true });
  const finished = (j: RenderJob) => j.status === "failed" || j.status === "cancelled"
    || (j.status === "done" && (!j.options.upload || Boolean(j.uploaded) || j.upload.state === "failed"));
  let job = renders.get(id)!;
  while (!finished(job)) {
    await new Promise((r) => setTimeout(r, 500));
    job = renders.get(id)!;
  }
  const totalMs = Date.now() - tr;
  assert.equal(job.status, "done", job.error);
  assert.ok(job.output && existsSync(job.output), "the render is in Renders/");
  const info = await probeMedia(ffi.path, job.output);
  const head = (() => { try { execFileSync(ffi.path, ["-hide_banner", "-i", job.output!], { stdio: "pipe" }); return ""; } catch (e) { return String((e as { stderr?: Buffer }).stderr ?? ""); } })();
  assert.equal(`${info.width}x${info.height}`, preset.includes("1080") ? "1920x1080" : "3840x2160");
  assert.ok(info.hasAudio);
  if (preset === "yt4k") assert.match(head, /hevc.*yuv420p10le/s);
  assert.ok(job.uploaded, job.error);
  assert.ok(job.export_id);
  const ep = await upstream.json<{ exports: { id: number; version: number | null; preset: string }[] }>(`/api/episodes/${eid}`);
  const exp = ep.exports.find((x) => x.id === job.export_id);
  assert.ok(exp, "the upload is an Export in the Render Center");
  assert.equal(exp.version, job.version);
  const sizeMb = Math.round(Number(execFileSync(process.execPath, ["-e", `console.log(require('fs').statSync(process.argv[1]).size)`, job.output]).toString()) / 1e5) / 10;
  console.log(`E2E ${JSON.stringify({ preset, encoder: job.encoder, probeMs, syncMs, renderAndUploadMs: totalMs, renderS: job.elapsed_s, durationS: job.duration_s,
    size: `${info.width}x${info.height}`, mb: sizeMb, exportId: job.export_id, version: job.version, output: job.output, warnings: job.warnings,
    steps: [...new Set(jobs.map((j) => j.stepId))] })}`);
  library.closeAll();
  if (!E.TATVAM_E2E_KEEP) {
    rmSync(userData, { recursive: true, force: true, maxRetries: 3 });
    if (!E.TATVAM_E2E_LIBRARY) rmSync(libRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});
