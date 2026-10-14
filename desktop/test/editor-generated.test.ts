/**
 * editor.writeGeneratedMedia (main/editor-generated.ts, docs/EDITOR.md §15.1): safe names, writes only under the edit
 * folder (Audio\SFX for sound), at most 50 MB, atomic (no .part left), the same content reused, the editor's import
 * path (a probed, registered MediaItem), the allow-list, and the IPC sender check. Portable paths (os.tmpdir).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { EditorManager, type MediaTools } from "../src/main/editor.ts";
import type { ProbeInfo } from "../src/main/editor-media.ts";
import {
  checkGeneratedName, editorGeneratedHost, GENERATED_MAX_BYTES, registerGeneratedIpc, writeGenerated, writeGeneratedMedia,
} from "../src/main/editor-generated.ts";
import { Upstream } from "../src/main/upstream.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-generated-"));
const lib = path.join(tmp, "Tatvam Projects");
const userData = path.join(tmp, "userData");
mkdirSync(userData, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

const probed: string[] = [];
const tools: MediaTools = {
  async probe(file) {
    probed.push(file);
    return { kind: "audio", duration: 1.25, fps: 0, width: 0, height: 0, hasVideo: false, hasAudio: true, channels: 2, sampleRate: 48000, rotation: 0 } as ProbeInfo;
  },
  async run() { /* no thumbnails for audio */ },
  async lines() { /* unused */ },
  async peaks() { return [0.2, 1, 0.4]; },
};
const ed = new EditorManager({
  libraryRoot: () => lib, userData, upstream: new Upstream({ serverUrl: () => "http://127.0.0.1:9", cookie: async () => "" }), ff: () => null, probeHw: async () => ({}),
  tools, log: () => undefined, dialogs: { openFiles: async () => [] },
});
const host = editorGeneratedHost(ed);

/** A tiny 24-bit stereo WAV with `n` frames of a value. */
function wav(n: number, v = 1000): Uint8Array {
  const data = n * 6, b = new Uint8Array(44 + data), dv = new DataView(b.buffer);
  b.set([...Buffer.from("RIFF")], 0); dv.setUint32(4, 36 + data, true); b.set([...Buffer.from("WAVEfmt ")], 8);
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 48000, true); dv.setUint32(28, 288000, true);
  dv.setUint16(32, 6, true); dv.setUint16(34, 24, true); b.set([...Buffer.from("data")], 36); dv.setUint32(40, data, true);
  for (let i = 44; i < b.length; i += 3) { b[i] = v & 0xff; b[i + 1] = (v >> 8) & 0xff; }
  return b;
}

test("safe names: plain names of the right kind only", () => {
  assert.equal(checkGeneratedName("whoosh.air_soft_1.wav", "audio"), "whoosh.air_soft_1.wav");
  assert.equal(checkGeneratedName("Hit (2).flac", "audio"), "Hit (2).flac");
  for (const bad of ["../x.wav", "..\\x.wav", "a/b.wav", "a\\b.wav", "C:\\x.wav", "x..wav", ".wav", "x.wav.", " x.wav", "CON.wav", "nul.wav", "com1.wav", "x.exe", "x", "x.wav\0",
    "a".repeat(130) + ".wav", "", "x.mp4"]) {
    assert.throws(() => checkGeneratedName(bad, "audio"), Error, JSON.stringify(bad));
  }
  assert.throws(() => checkGeneratedName("x.wav", "text"), /audio, video or an image/);
  assert.throws(() => checkGeneratedName("x.wav", "image"), /image file name/);
  assert.equal(checkGeneratedName("frame_1.png", "image"), "frame_1.png");
  assert.throws(() => checkGeneratedName(5, "audio"), /needs a name/);
});

test("writeGeneratedMedia: into <edit>\\Audio\\SFX, probed and registered like an import, the same content once", async () => {
  const { path: editPath } = await ed.create("Gen Edit", { width: 1920, height: 1080, fps: 25 });
  const dir = path.dirname(editPath), sfxDir = path.join(dir, "Audio", "SFX");
  const a = await writeGeneratedMedia(host, editPath, "whoosh.fast_1.wav", wav(4800), "audio");
  assert.equal(a.path, path.join(sfxDir, "whoosh.fast_1.wav"));
  assert.equal(a.kind, "audio");
  assert.equal(a.fps, 48000);
  assert.equal(a.duration, 60000);
  assert.deepEqual(a.peaks, [0.2, 1, 0.4]);
  assert.match(a.url ?? "", /^\/__media\/[0-9a-f]{32}\/whoosh\.fast_1\.wav$/);
  assert.equal(ed.resolve(/\/__media\/([0-9a-f]+)\//.exec(a.url!)![1]), a.path, "served by the gateway");
  assert.deepEqual(readFileSync(a.path), Buffer.from(wav(4800)));
  // the same bytes again: the same file, nothing new written
  const b = await writeGeneratedMedia(host, editPath, "whoosh.fast_1.wav", wav(4800), "audio");
  assert.equal(b.path, a.path);
  assert.deepEqual(readdirSync(sfxDir), ["whoosh.fast_1.wav"]);
  // other content under the same name: a sibling; then each is found again by its content
  const c = await writeGeneratedMedia(host, editPath, "whoosh.fast_1.wav", wav(4800, 2000), "audio");
  assert.equal(c.path, path.join(sfxDir, "whoosh.fast_1_2.wav"));
  assert.equal((await writeGeneratedMedia(host, editPath, "whoosh.fast_1.wav", wav(4800, 2000), "audio")).path, c.path);
  assert.equal((await writeGeneratedMedia(host, editPath, "whoosh.fast_1.wav", wav(4800), "audio")).path, a.path);
  assert.deepEqual(readdirSync(sfxDir).sort(), ["whoosh.fast_1.wav", "whoosh.fast_1_2.wav"], "no .part files left");
  // two at once with new content: both land, under different names
  const [x, y] = await Promise.all([writeGenerated(dir, "pop_1.wav", wav(10, 1), "audio"), writeGenerated(dir, "pop_1.wav", wav(10, 2), "audio")]);
  assert.notEqual(x.file, y.file);
  assert.equal(readdirSync(sfxDir).filter((n) => n.startsWith("pop_1")).length, 2);
  // images and video have their own folder
  const g = await writeGenerated(dir, "card_1.png", new Uint8Array([1, 2, 3]), "image");
  assert.equal(g.file, path.join(dir, "Generated", "Images", "card_1.png"));
  for (const f of [a.path, c.path, x.file, y.file, g.file]) assert.ok(f.startsWith(dir + path.sep), `${f} is inside the edit`);
});

test("refused: unsafe names, edits not opened in Tatvam, empty or over 50 MB, not bytes", async () => {
  const { path: editPath } = await ed.create("Gen Edit 2", { width: 1920, height: 1080, fps: 25 });
  const dir = path.dirname(editPath);
  await assert.rejects(writeGeneratedMedia(host, editPath, "../../escape.wav", wav(10), "audio"), /safe file name/);
  await assert.rejects(writeGeneratedMedia(host, editPath, "x.wav", wav(10), "video"), /video file name/);
  assert.ok(!existsSync(path.join(dir, "..", "escape.wav")));
  // an edit that wasn't created, opened or listed here
  const elsewhere = path.join(tmp, "elsewhere", "Other.tatvamedit");
  mkdirSync(path.dirname(elsewhere), { recursive: true });
  await assert.rejects(writeGeneratedMedia(host, elsewhere, "x.wav", wav(10), "audio"), /wasn't opened in Tatvam/);
  assert.ok(!existsSync(path.join(path.dirname(elsewhere), "Audio")));
  await assert.rejects(writeGeneratedMedia(host, "relative.tatvamedit", "x.wav", wav(10), "audio"), /full path/);
  await assert.rejects(writeGeneratedMedia(host, editPath, "x.wav", new Uint8Array(0), "audio"), /empty/);
  await assert.rejects(writeGeneratedMedia(host, editPath, "x.wav", "not bytes", "audio"), /must be bytes/);
  await assert.rejects(writeGeneratedMedia(host, editPath, "x.wav", new Uint8Array(GENERATED_MAX_BYTES + 1), "audio"), /at most 50 MB/);
  assert.ok(!existsSync(path.join(dir, "Audio", "SFX", "x.wav")));
});

test("IPC: only pages on the gateway origin may write", async () => {
  const handlers = new Map<string, (e: { senderFrame?: { url?: string } | null }, ...a: unknown[]) => unknown>();
  registerGeneratedIpc({ handle: (ch, fn) => { handlers.set(ch, fn); } }, (url) => url.startsWith("http://127.0.0.1:5555/"), host, "tatvam:editor.writeGeneratedMedia");
  const fn = handlers.get("tatvam:editor.writeGeneratedMedia")!;
  const { path: editPath } = await ed.create("Gen Edit 3", { width: 1280, height: 720, fps: 30 });
  await assert.rejects(Promise.resolve().then(() => fn({ senderFrame: { url: "https://evil.example/" } }, editPath, "a.wav", wav(5), "audio")), /Not allowed/);
  await assert.rejects(Promise.resolve().then(() => fn({ senderFrame: null }, editPath, "a.wav", wav(5), "audio")), /Not allowed/);
  await assert.rejects(Promise.resolve().then(() => fn({ senderFrame: { url: "http://127.0.0.1:5555/editor" } }, 42, "a.wav", wav(5), "audio")), /path must be text/);
  const item = (await fn({ senderFrame: { url: "http://127.0.0.1:5555/editor" } }, editPath, "a.wav", wav(5), "audio")) as { path: string };
  assert.equal(item.path, path.join(path.dirname(editPath), "Audio", "SFX", "a.wav"));
});
