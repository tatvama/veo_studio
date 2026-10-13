/**
 * The desktop shell's pure parts: shell.json (prefs, crash detection, "What's new"), window bounds per monitor
 * arrangement, the job queue's done / failed transitions, appearance (accent, overlay, Mica support), the CHANGELOG
 * section and the drawn icons.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_APPEARANCE, sanitizeAppearance } from "../src/main/config.ts";
import { accentHex, appearanceState, chromeCss, materialSupported, overlayFor, resolveAccent } from "../src/main/shell-appearance.ts";
import { crossIcon, dotIcon } from "../src/main/shell-icons.ts";
import { JobTracker } from "../src/main/shell-jobs.ts";
import { boundsVisible, changelogSection, DEFAULT_PREFS, displaySignature, sanitizePrefs, ShellStore } from "../src/main/shell-state.ts";
import type { RenderJob, SyncStatus, ToolStatus } from "../src/shared/types.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-shell-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("shell.json: prefs are sanitised; a run that never quit cleanly is a crash; a new version shows What's new", () => {
  assert.deepEqual(sanitizePrefs({ tray: "sometimes", keepRendering: "yes", notifications: { render: false, nope: true } }),
    { ...DEFAULT_PREFS, notifications: { ...DEFAULT_PREFS.notifications, render: false } });
  const f = path.join(tmp, "shell.json");
  writeFileSync(f, JSON.stringify({ running: true, lastVersion: "3.0.0", onboarded: true,
    session: { at: "2026-10-12T10:00:00Z", url: "/editor/edit?path=D%3A%5Cx.tatvamedit", panels: ["program", "bogus", 3], editPath: "D:\\x.tatvamedit" } }));
  const s = new ShellStore(f);
  const st = s.state("3.1.0");
  assert.equal(st.updatedFrom, "3.0.0");
  assert.equal(st.crashed?.url, "/editor/edit?path=D%3A%5Cx.tatvamedit");
  assert.deepEqual(st.crashed?.panels, ["program", "bogus"]);
  assert.equal(s.state("3.1.0", { crashDismissed: true }).crashed, undefined);
  s.set({ running: true, lastVersion: "3.1.0" });
  s.set({ running: false });
  const again = new ShellStore(f);
  assert.equal(again.state("3.1.0").crashed, undefined, "a clean quit is no crash");
  assert.equal(again.state("3.1.0").updatedFrom, undefined);
  assert.equal(again.state("3.1.0").onboarded, true);
});

test("window bounds per arrangement of monitors", () => {
  const laptop = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const docked = [{ id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } }, ...laptop];
  assert.notEqual(displaySignature(laptop), displaySignature(docked));
  assert.equal(displaySignature(docked), displaySignature([...docked].reverse()), "order doesn't matter");
  // a window on the second screen is not visible once it's gone
  const onSecond = { x: 2100, y: 100, width: 1400, height: 900 };
  assert.equal(boundsVisible(onSecond, docked.map((d) => d.bounds)), true);
  assert.equal(boundsVisible(onSecond, laptop.map((d) => d.bounds)), false);
  assert.equal(boundsVisible({ x: 1900, y: 10, width: 800, height: 600 }, laptop.map((d) => d.bounds)), false, "a 20 px sliver doesn't count");
  const s = new ShellStore(path.join(tmp, "b.json"));
  s.set({ bounds: { [displaySignature(docked)]: { main: { bounds: onSecond, displayId: 2, maximized: false } } } });
  assert.deepEqual(new ShellStore(path.join(tmp, "b.json")).get().bounds[displaySignature(docked)].main.bounds, onSecond);
});

const job = (over: Partial<RenderJob>): RenderJob => ({ id: "r1", pid: 1, eid: 3, lang: "kn", preset: "yt4k", status: "queued", progress: 0, step: "", warnings: [],
  createdAt: "2026-10-12T10:00:00Z", upload: { state: "idle" }, options: { effects: true, captions: true, music: true, upscaled: false, localUpscale: false, upload: false },
  ...over });

test("job queue: progress, and done / failed once per transition", () => {
  let now = 1000;
  const t = new JobTracker(() => now);
  assert.equal(t.render(job({ status: "queued" })), null);
  assert.equal(t.render(job({ status: "rendering", progress: 0.4 })), null);
  let sum = t.summary();
  assert.equal(sum.running, 1);
  assert.equal(Math.round((sum.progress ?? 0) * 100), 40);
  assert.equal(t.activeRenders().length, 1);
  const done = t.render(job({ status: "done", progress: 1 }));
  assert.equal(done?.type, "done");
  assert.equal(t.render(job({ status: "done", progress: 1 })), null, "not twice");
  assert.equal(t.summary().running, 0);
  assert.equal(t.summary().progress, null);
  // an upload after the render is "uploading" → "done" again: a second event (uploaded)
  assert.equal(t.render(job({ status: "uploading", progress: 0.5 })), null);
  assert.equal(t.render(job({ status: "done", uploaded: true, upload: { state: "done" } }))?.type, "done");
  const failed = t.render(job({ id: "r2", status: "failed", error: "disk full" }));
  assert.equal(failed?.type, "failed");
  assert.equal(t.summary().error, true, "red for a while after a failure");
  now += 60_000;
  assert.equal(t.summary().error, false);
  // a tool download finishing
  const tool = (o: Partial<ToolStatus>): ToolStatus => ({ id: "rife", label: "RIFE", installed: false, version: "1", sizeBytes: 1, installing: true, progress: 0.1,
    platformSupported: true, kind: "program", license: "MIT", note: "", ...o });
  assert.equal(t.tool(tool({})), null);
  assert.equal(t.tool(tool({ installing: false, installed: true, progress: 1 }))?.type, "done");
  // a sync that downloaded, then an error
  const sync = (o: Partial<SyncStatus>): SyncStatus => ({ pid: 4, phase: "downloading", total: 3, done: 1, bytes: 10, bytesTotal: 30, errors: [], ...o });
  assert.equal(t.sync(sync({})), null);
  assert.equal(t.sync(sync({ phase: "done", done: 3, bytes: 30 }))?.type, "done");
  assert.equal(t.sync(sync({ phase: "error", errors: ["x"] })), null, "only from an active phase");
});

test("appearance: accent, overlay colours, Mica only on Windows 11 22H2+", () => {
  assert.equal(accentHex("0078d4ff"), "#0078d4");
  assert.equal(accentHex("nope"), null);
  assert.equal(resolveAccent({ accent: "system" }, "#0078d4"), "#0078d4");
  assert.equal(resolveAccent({ accent: "system" }, null), "#22d3ee");
  assert.equal(resolveAccent({ accent: "#FF00aa" }, null), "#ff00aa");
  assert.equal(materialSupported("win32", "10.0.26200"), true);
  assert.equal(materialSupported("win32", "10.0.19045"), false);
  assert.equal(materialSupported("darwin", "24.0.0"), false);
  assert.equal(overlayFor(true, "mica").color, "#00000000");
  assert.equal(overlayFor(false, "none").color, "#ffffff");
  const st = appearanceState({ ...DEFAULT_APPEARANCE, highContrast: true }, { dark: true, systemAccent: null, platform: "win32", release: "10.0.26200" });
  assert.equal(st.materialInUse, "none", "high contrast is solid");
  assert.equal(appearanceState(DEFAULT_APPEARANCE, { dark: true, systemAccent: null, platform: "win32", release: "10.0.26200" }).materialInUse, "mica");
  assert.match(chromeCss({ materialInUse: "mica", titleBarHeight: 32 }), /background: transparent/);
  assert.deepEqual(sanitizeAppearance({ theme: "neon", scale: 300, accent: "red", density: "compact" }),
    { ...DEFAULT_APPEARANCE, scale: 150, density: "compact" });
});

test("the CHANGELOG section of the installed version", () => {
  const md = "# Changelog\n\nIntro\n\n## [3.1.0](https://x) (2026-10-12)\n\n### Features\n\n* new\n\n## [3.0.0](https://y) (2026-10-10)\n\n* first\n";
  assert.match(changelogSection(md, "3.0.0"), /^## \[3\.0\.0\][\s\S]*first$/);
  assert.match(changelogSection(md, "3.1.0"), /\* new$/);
  assert.match(changelogSection(md, "9.9.9"), /^## \[3\.1\.0\]/, "else the newest");
});

test("drawn icons are BGRA bitmaps of the right size", () => {
  assert.equal(dotIcon(32, [34, 211, 238, 255]).length, 32 * 32 * 4);
  const x = crossIcon(16);
  assert.equal(x.length, 16 * 16 * 4);
  assert.ok(x[(8 * 16 + 8) * 4 + 3] > 200, "the centre of the cross is drawn");
  assert.equal(x[3], 0, "the corner is transparent");
});
