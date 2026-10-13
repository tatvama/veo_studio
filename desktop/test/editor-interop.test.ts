/**
 * Interchange on the desktop (docs/EDITOR.md §12) without Electron, FFmpeg or Adobe: finding Premiere Pro and Audition
 * from mocked registry output and a fake Program Files, exports to the default and a chosen path (studio media made
 * local, generator clips and Audition stems through a fake FFmpeg), imports of XML / EDL / OTIO into a new edit with
 * probing (missing and network files stay offline), the markers CSV in UTF-16, openIn and the IPC origin check.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { appVersionScore, InteropManager, parseRegQuery, registerInteropIpc, type InteropDeps } from "../src/main/editor-interop.ts";
import { EditorManager, type MediaTools } from "../src/main/editor.ts";
import type { EditProject, MediaItem } from "../src/shared/types.ts";
import { Upstream } from "../src/main/upstream.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-interop-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const lib = path.join(tmp, "Tatvam Projects");
const userData = path.join(tmp, "userData");
const footage = path.join(tmp, "Footage");
mkdirSync(userData, { recursive: true });
mkdirSync(footage, { recursive: true });

/**
 * A local path as a file URL the way FCP 7 XML writes it: file://localhost/C:/Footage/Shot%201.mp4 on Windows,
 * file://localhost/tmp/Footage/Shot%201.mp4 elsewhere (one slash after the host, never two).
 */
const localUrl = (p: string) => `file://localhost/${p.replace(/\\/g, "/").replace(/^\/+/, "").split("/").map((seg) => encodeURIComponent(seg).replaceAll("%3A", ":")).join("/")}`;

const tools: MediaTools = {
  async probe(file) {
    const e = path.extname(file).toLowerCase();
    return e === ".wav"
      ? { kind: "audio", duration: 10, fps: 0, width: 0, height: 0, hasVideo: false, hasAudio: true, channels: 2, sampleRate: 44100, rotation: 0 }
      : { kind: "video", duration: 20, fps: 50, width: 1280, height: 720, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000, rotation: 0 };
  },
  async run(args) { writeFileSync(args[args.length - 1], "x"); },
  async lines() { /* none */ },
  async peaks() { return [0.2]; },
};
const ed = new EditorManager({
  libraryRoot: () => lib, userData, upstream: new Upstream({ serverUrl: () => "http://127.0.0.1:9", cookie: async () => undefined }), ff: () => null,
  probeHw: async () => ({}), tools, log: () => undefined, dialogs: { openFiles: async () => [] },
});

interface Harness { mgr: InteropManager; ff: string[][]; saves: string[]; opens: string[][]; launched: [string, string[]][]; revealed: string[]; answers: string[][] }
function harness(over: Partial<InteropDeps> = {}): Harness {
  const h: Harness = { mgr: null as never, ff: [], saves: [], opens: [], launched: [], revealed: [], answers: [] };
  const editor = Object.assign(Object.create(ed) as EditorManager, {
    // studio media "downloaded" into the edit's Media folder, then imported like any file
    importStudioAsset: async (file: string, key: string, name?: string) => {
      const dest = path.join(path.dirname(file), "Media", name ?? path.basename(key));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, "audio");
      const [it] = await ed.importMedia(file, [dest]);
      return { ...it, studioKey: key };
    },
  });
  h.mgr = new InteropManager({
    editor, ff: () => null, log: () => undefined, platform: "win32", reg: async () => "", env: { ProgramFiles: path.join(tmp, "no-programs") },
    runFfmpeg: async (args) => { h.ff.push(args); mkdirSync(path.dirname(args[args.length - 1]), { recursive: true }); writeFileSync(args[args.length - 1], "RIFF"); },
    dialogs: {
      openFiles: async (o) => { h.opens.push([o.title]); return h.answers.shift() ?? []; },
      saveFile: async (o) => { h.saves.push(o.defaultPath); return o.defaultPath.replace(/\.xml$/, "-picked.xml"); },
    },
    launch: (exe, args) => { h.launched.push([exe, args]); },
    reveal: (f) => { h.revealed.push(f); },
    ...over,
  });
  return h;
}

/** An edit with a clip on V1 / A1, studio-only voice-over on A2, a tone generator on A3 and a marker. */
async function makeEdit(name: string): Promise<{ file: string; project: EditProject }> {
  const made = await ed.create(name, { width: 1920, height: 1080, fps: 25 });
  const src = path.join(footage, "Shot 1.mp4");
  writeFileSync(src, "video");
  const [m] = await ed.importMedia(made.path, [src]);
  const p = made.project;
  const seq = p.sequences[0];
  const v1 = seq.tracks.find((t) => t.kind === "video" && t.index === 0)!, a = seq.tracks.filter((t) => t.kind === "audio").sort((x, y) => x.index - y.index);
  const motion = { position: { value: [960, 540] as [number, number] }, scale: { value: 100 }, rotation: { value: 0 }, anchor: { value: [640, 360] as [number, number] },
    opacity: { value: 100 }, blend: "normal" as const, uniformScale: true };
  const audio = { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 };
  const voice: MediaItem = { id: "vo", binId: null, name: "Voice.wav", kind: "audio", path: "studio:projects/1/edit_assets/vo.wav", duration: 480000, fps: 48000, width: 0, height: 0,
    hasAudio: true, markers: [], missing: true };
  p.media = [m, voice];
  seq.clips = [
    { id: "c1", trackId: v1.id, start: 0, duration: 100, source: { type: "media", mediaId: m.id, in: 0 }, speed: 1, reverse: false, enabled: true, name: "Shot 1", motion, effects: [], linkId: "l1" },
    { id: "c2", trackId: a[0].id, start: 0, duration: 100, source: { type: "media", mediaId: m.id, in: 0 }, speed: 1, reverse: false, enabled: true, name: "Shot 1", motion, effects: [], audio, linkId: "l1" },
    { id: "c3", trackId: a[1].id, start: 25, duration: 50, source: { type: "media", mediaId: "vo", in: 0 }, speed: 1, reverse: false, enabled: true, name: "Voice", motion, effects: [], audio },
    { id: "c4", trackId: a[2].id, start: 0, duration: 50, source: { type: "generate", generator: "tone", params: { frequency: { value: 440 } } }, speed: 1, reverse: false, enabled: true,
      name: "Tone", motion, effects: [], audio },
  ];
  seq.markers = [{ id: "mk", frame: 10, duration: 0, name: "Intro", color: "#fbbf24" }];
  await ed.save(made.path, p);
  return { file: made.path, project: p };
}

test("registry output is read into keys and values", () => {
  const out = [
    "", "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PPRO_25_0",
    "    DisplayName    REG_SZ    Adobe Premiere Pro 2025", "    DisplayVersion    REG_SZ    25.0.0", "    InstallLocation    REG_SZ    C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025",
    "", "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Adobe Audition.exe", "    (Default)    REG_SZ    C:\\x\\Adobe Audition.exe",
  ].join("\r\n");
  const r = parseRegQuery(out);
  assert.equal(r.length, 2);
  assert.equal(r[0].values.DisplayName, "Adobe Premiere Pro 2025");
  assert.equal(r[0].values.InstallLocation, "C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025");
  assert.equal(r[1].values["(Default)"], "C:\\x\\Adobe Audition.exe");
  assert.ok(appVersionScore("Adobe Premiere Pro 2025") > appVersionScore("Adobe Premiere Pro 2024"));
  assert.ok(appVersionScore("x", "25.0.1") > appVersionScore("Adobe Premiere Pro CC 2019"));
});

test("findApps: nothing installed → none; installed → the newest of each from App Paths, Uninstall and Program Files", async () => {
  assert.deepEqual(await harness().mgr.findApps(), []);
  assert.deepEqual(await harness({ platform: "linux" }).mgr.findApps(), []);
  const pf = path.join(tmp, "Program Files");
  const exe = (dir: string, name: string) => { const f = path.join(pf, "Adobe", dir, name); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, "MZ"); return f; };
  const p24 = exe("Adobe Premiere Pro 2024", "Adobe Premiere Pro.exe");
  const p25 = exe("Adobe Premiere Pro 2025", "Adobe Premiere Pro.exe");
  const au = exe("Adobe Audition 2024", "Adobe Audition.exe");
  const calls: string[][] = [];
  const reg = async (args: string[]) => {
    calls.push(args);
    if (args[1].endsWith("App Paths\\Adobe Premiere Pro.exe")) return `\r\nHKEY_LOCAL_MACHINE\\${args[1].slice(5)}\r\n    (Default)    REG_SZ    ${p24}\r\n`;
    if (args[1] === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall") {
      return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PPRO_25_0\r\n    DisplayName    REG_SZ    Adobe Premiere Pro 2025\r\n    DisplayVersion    REG_SZ    25.0\r\n    InstallLocation    REG_SZ    ${path.dirname(p25)}\r\n`
        + `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other\r\n    DisplayName    REG_SZ    Something else\r\n`;
    }
    return "";
  };
  const apps = await harness({ reg, env: { ProgramFiles: pf } }).mgr.findApps();
  assert.deepEqual(apps.map((a) => [a.id, a.path]), [["premiere", p25], ["audition", au]]);
  assert.equal(apps[0].source, "uninstall");
  assert.ok(calls.some((c) => c[1].includes("App Paths")));
});

test("exportFile: Premiere XML in Exports\\Interchange, studio media made local, the tone rendered, warnings", async () => {
  const h = harness();
  const { file, project } = await makeEdit("Interop Export");
  const r = (await h.mgr.exportFile(file, project.sequences[0].id, "premiere-xml"))!;
  assert.equal(r.path, path.join(path.dirname(file), "Exports", "Interchange", "Sequence 01.xml"));
  const xml = readFileSync(r.path, "utf8");
  assert.ok(xml.includes("<xmeml version=\"4\">"));
  assert.ok(xml.includes(localUrl(path.join(footage, "Shot 1.mp4"))), "the local path as a file URL");
  // the studio voice-over was pulled into Media\ and the XML points at it
  assert.equal(r.pulled.length, 1);
  assert.equal(r.pulled[0].mediaId, "vo");
  assert.ok(existsSync(r.pulled[0].item.path));
  assert.ok(xml.includes("Media/Voice.wav"));
  // the tone: rendered by FFmpeg next to the file
  assert.equal(h.ff.length, 1);
  assert.ok(h.ff[0].includes("lavfi") && h.ff[0].some((a) => a.startsWith("aevalsrc=")));
  assert.equal(r.files.length, 1);
  assert.ok(xml.includes("Tatvam: Tone"));
  // a path outside the edit's folder goes through the save dialog
  const out = path.join(tmp, "elsewhere", "cut.xml");
  const r2 = (await h.mgr.exportFile(file, project.sequences[0].id, "premiere-xml", out))!;
  assert.deepEqual(h.saves, [out]);
  assert.equal(r2.path, out.replace(/\.xml$/, "-picked.xml"));
  // EDL, OTIO, CSV (with a BOM) and chapters
  for (const f of ["edl", "otio", "markers-csv", "youtube-chapters"] as const) {
    const x = (await h.mgr.exportFile(file, project.sequences[0].id, f))!;
    assert.ok(existsSync(x.path), f);
  }
  const csv = readFileSync(path.join(path.dirname(file), "Exports", "Interchange", "Sequence 01 markers.csv"));
  assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  await assert.rejects(h.mgr.exportFile(file, "nope", "premiere-xml"), /isn't in the saved edit/);
  await assert.rejects(h.mgr.exportFile(path.join(tmp, "x.tatvamedit"), "s", "premiere-xml"), /wasn't opened/);
  await assert.rejects(h.mgr.exportFile(file, project.sequences[0].id, "word" as never), /Unknown interchange format/);
});

test("exportFile: Send to Audition renders one stem per audio track and an XML that places them", async () => {
  const h = harness();
  const { file, project } = await makeEdit("Interop Audition");
  const r = (await h.mgr.exportFile(file, project.sequences[0].id, "audition-stems"))!;
  assert.ok(r.path.endsWith("Sequence 01 Audition stems.xml"), "not the plain Audition XML's name");
  assert.equal(r.files.length, 3, "A1, A2, A3");
  for (const f of r.files) assert.ok(existsSync(f));
  assert.ok(h.ff.every((args) => args.includes("48000")), "48 kHz stems");
  const xml = readFileSync(r.path, "utf8");
  for (const f of r.files) assert.ok(xml.includes(encodeURIComponent(path.basename(f))), path.basename(f));
  assert.ok(!xml.includes("aevalsrc"));
});

test("importFile: an XML becomes a new edit; local files are probed and rebased, missing and network files stay offline", async () => {
  const h = harness();
  const clip = path.join(footage, "Take 7.mov");
  writeFileSync(clip, "video");
  const fileEl = (id: string, name: string, p: string) => `<file id="${id}"><name>${name}</name><pathurl>${p}</pathurl><rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate><duration>500</duration>`
    + "<media><video><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media></file>";
  const item = (id: string, start: number, end: number, inF: number, f: string) => `<clipitem id="${id}"><name>x</name><rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>`
    + `<start>${start}</start><end>${end}</end><in>${inF}</in><out>${inF + end - start}</out>${f}</clipitem>`;
  const xml = `<?xml version="1.0"?><xmeml version="4"><sequence id="s1"><name>From Premiere</name><rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate><media><video><track>`
    + item("c1", 0, 50, 50, fileEl("f1", "Take 7.mov", localUrl(clip)))
    + item("c2", 50, 100, 0, fileEl("f2", "Gone.mov", localUrl(path.join(footage, "Gone.mov"))))
    + item("c3", 100, 150, 0, fileEl("f3", "Server.mov", "file://nas/share/Server.mov"))
    + "</track></video></media></sequence></xmeml>";
  const src = path.join(tmp, "From Premiere.xml");
  writeFileSync(src, xml);
  h.answers.push([src]);
  const r = await h.mgr.importFile();
  assert.ok(r && r.kind === "edit");
  if (r?.kind !== "edit") return;
  assert.equal(r.missing, 2);
  assert.ok(r.warnings.some((w) => /2 files aren't on this PC/.test(w)));
  assert.ok(r.warnings.some((w) => /network share/.test(w)));
  const opened = (await ed.open(r.path))!;
  const p = opened.project;
  assert.equal(p.name, "From Premiere");
  const take = p.media.find((m) => m.name === "Take 7.mov")!;
  assert.equal(take.missing, false);
  assert.equal(take.fps, 50, "the probed rate");
  const c1 = p.sequences[0].clips.find((c) => c.start === 0)!;
  assert.equal(c1.source.type === "media" && c1.source.in, 100, "50 frames at 25 fps in the XML = 100 frames of the 50 fps file");
  const nas = p.media.find((m) => m.name === "Server.mov")!;
  assert.equal(nas.missing, true);
  assert.ok(!nas.path.startsWith("\\\\") && !!nas.comment?.includes("\\\\nas\\share\\Server.mov"), "a network path is noted for relinking, never opened");
  // the same file again: a second edit with a number
  const again = await h.mgr.importFile(src);
  assert.ok(again?.kind === "edit" && path.basename(again.path) === "From-Premiere-2.tatvamedit");
  await assert.rejects(h.mgr.importFile(path.join(tmp, "notes.txt")), /isn't an XML, EDL, OTIO or markers CSV/);
});

test("importFile: EDL and OTIO become edits; a UTF-16 markers CSV comes back as text", async () => {
  const h = harness();
  const edl = path.join(tmp, "cut.edl");
  writeFileSync(edl, "TITLE: Cut\r\nFCM: NON-DROP FRAME\r\n\r\n001  AX       V     C        00:00:01:00 00:00:03:00 01:00:00:00 01:00:02:00\r\n* FROM CLIP NAME: A.mov\r\n");
  const r1 = await h.mgr.importFile(edl);
  assert.ok(r1?.kind === "edit");
  const otio = path.join(tmp, "cut.otio");
  writeFileSync(otio, JSON.stringify({ OTIO_SCHEMA: "Timeline.1", name: "O", metadata: {}, global_start_time: null, tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", metadata: {}, source_range: null,
    effects: [], markers: [], enabled: true, children: [{ OTIO_SCHEMA: "Track.1", kind: "Video", name: "V1", metadata: {}, source_range: null, effects: [], markers: [], enabled: true, children: [
      { OTIO_SCHEMA: "Clip.2", name: "B", metadata: {}, effects: [], markers: [], enabled: true, source_range: { OTIO_SCHEMA: "TimeRange.1", start_time: { OTIO_SCHEMA: "RationalTime.1", rate: 24, value: 0 },
        duration: { OTIO_SCHEMA: "RationalTime.1", rate: 24, value: 48 } }, media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "MissingReference.1", name: "B", metadata: {}, available_range: null } },
        active_media_reference_key: "DEFAULT_MEDIA" }] }] } }));
  const r2 = await h.mgr.importFile(otio);
  assert.ok(r2?.kind === "edit");
  const csv = path.join(tmp, "markers.csv");
  writeFileSync(csv, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Marker Name\tDescription\tIn\tOut\tDuration\tMarker Type\r\nHi\t\t00:00:01:00\t00:00:01:00\t00:00:00:00\tComment\r\n", "utf16le")]));
  const r3 = await h.mgr.importFile(csv);
  assert.ok(r3?.kind === "markers" && r3.text.startsWith("Marker Name\tDescription"));
  assert.equal(InteropManager.decode(Buffer.from("abc", "utf8")), "abc");
});

test("openIn: only exported files; the app when installed, else Explorer", async () => {
  const h = harness();
  const { file, project } = await makeEdit("Interop Open");
  const r = (await h.mgr.exportFile(file, project.sequences[0].id, "premiere-xml"))!;
  const o1 = await h.mgr.openIn("premiere", r.path);
  assert.equal(o1.opened, "folder");
  assert.deepEqual(h.revealed, [r.path]);
  const stray = path.join(tmp, "stray.xml");
  writeFileSync(stray, "<xmeml/>");
  await assert.rejects(h.mgr.openIn("premiere", stray), /Only files exported/);
  await assert.rejects(h.mgr.openIn("photoshop" as never, r.path), /Premiere Pro or Audition/);
  // with Premiere "installed"
  const pf = path.join(tmp, "PF2");
  const exe = path.join(pf, "Adobe", "Adobe Premiere Pro 2026", "Adobe Premiere Pro.exe");
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, "MZ");
  const h2 = harness({ env: { ProgramFiles: pf } });
  const r2 = (await h2.mgr.exportFile(file, project.sequences[0].id, "premiere-xml"))!;
  const o2 = await h2.mgr.openIn("premiere", r2.path);
  assert.deepEqual([o2.opened, o2.app], ["app", "Adobe Premiere Pro 2026"]);
  assert.deepEqual(h2.launched, [[exe, [r2.path]]]);
});

test("IPC: the handlers answer gateway pages only", async () => {
  const handlers = new Map<string, (e: { senderFrame?: { url?: string } | null }, ...a: unknown[]) => unknown>();
  registerInteropIpc({ handle: (ch, fn) => { handlers.set(ch, fn); } }, (u) => u.startsWith("http://127.0.0.1:47800/"), harness().mgr,
    { export: "x", import: "i", findApps: "f", openIn: "o" });
  assert.equal(handlers.size, 4);
  await assert.rejects(Promise.resolve(handlers.get("f")!({ senderFrame: { url: "https://evil.example/" } })), /Not allowed/);
  assert.deepEqual(await handlers.get("f")!({ senderFrame: { url: "http://127.0.0.1:47800/editor" } }), []);
  await assert.rejects(Promise.resolve(handlers.get("x")!({ senderFrame: { url: "http://127.0.0.1:47800/" } }, 5, "s", "edl")), /path must be text/);
});
