/**
 * Watch folders (src/main/autowatch.ts, docs/EDITOR.md §13.4) with fake timers and a fake file system: a file counts
 * once its size has held for 5 s, files copied together go in one batch, files already in the edit are left alone,
 * a batch the edit can't take now is tried again later, and the notification says what happened.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { mock, test } from "node:test";
import { AutoWatcher, isWatchMedia, RETRY_MS, StableTracker, type WatchFs } from "../src/main/autowatch.ts";
import type { WatchFolder } from "../src/shared/types.ts";

test("stability: the same non-zero size for 5 s", () => {
  const t = new StableTracker(5000);
  assert.equal(t.observe("a.mp4", 100, 0), false, "first sight");
  assert.equal(t.observe("a.mp4", 200, 1000), false, "still growing");
  assert.equal(t.observe("a.mp4", 200, 5999), false, "4.999 s steady");
  assert.equal(t.observe("a.mp4", 200, 6000), true, "5 s steady");
  assert.equal(t.observe("a.mp4", 200, 7000), false, "reported once");
  assert.equal(t.observe("z.mp4", 0, 0), false);
  assert.equal(t.observe("z.mp4", 0, 9000), false, "an empty file never counts");
  assert.equal(t.observe("g.mp4", 5, 0), false);
  assert.equal(t.observe("g.mp4", null, 1000), false, "gone");
  assert.deepEqual(t.pending().sort(), ["a.mp4", "z.mp4"]);
});

test("media only: partial downloads and other files are ignored", () => {
  assert.equal(isWatchMedia("D:\\W\\clip.mp4"), true);
  assert.equal(isWatchMedia("D:\\W\\clip.MOV"), true);
  assert.equal(isWatchMedia("D:\\W\\clip.mp4.part"), false);
  assert.equal(isWatchMedia("D:\\W\\clip.crdownload"), false);
  assert.equal(isWatchMedia("D:\\W\\notes.txt"), false);
  assert.equal(isWatchMedia("D:\\W\\.hidden.mp4"), false);
});

function fakeFs(): WatchFs & { files: Map<string, number> } {
  const files = new Map<string, number>();
  return {
    files,
    list: async (dir) => [...files.keys()].filter((f) => path.dirname(f) === dir),
    size: async (f) => (files.has(f) ? files.get(f)! : null),
  };
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test("watcher: a batch once every new file has settled; files in the edit are skipped; one notification", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const fs = fakeFs();
  const W = "D:\\Shoots\\Lighthouse";
  const watch: WatchFolder = { id: "w1test", folder: W, style: "talking_head", editPath: "D:\\Lib\\Edits\\Lighthouse\\Lighthouse.tatvamedit", mode: "append", on: true };
  const delivered: string[][] = [];
  const notes: { title: string; body: string }[] = [];
  const saved: Partial<WatchFolder>[] = [];
  const inEdit = new Set([path.resolve(W, "old.mp4").toLowerCase()]);
  const w = new AutoWatcher({
    watches: () => [watch], known: async () => inEdit, fs,
    deliver: async (_w, files) => { delivered.push(files); for (const f of files) inEdit.add(path.resolve(f).toLowerCase()); return { added: files.length, edit: watch.editPath }; },
    notify: (title, body) => notes.push({ title, body }), saveWatch: (_id, p) => saved.push(p), log: () => undefined,
  });
  fs.files.set(path.join(W, "old.mp4"), 500);
  fs.files.set(path.join(W, "b_002.mp4"), 10);
  fs.files.set(path.join(W, "a_001.mp4"), 10);
  w.sync();
  const step = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  await step(1000);
  fs.files.set(path.join(W, "b_002.mp4"), 900); // still copying
  for (let i = 0; i < 5; i++) await step(1000);
  assert.equal(delivered.length, 0, "b_002 is still settling, so nothing goes yet (a_001 waits for it)");
  for (let i = 0; i < 2; i++) await step(1000);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].map((f) => path.basename(f)), ["a_001.mp4", "b_002.mp4"], "one batch, series order, the old file left out");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "2 new clips added");
  assert.match(notes[0].body, /2 new clips added to Lighthouse auto edit/);
  assert.equal(saved[saved.length - 1].lastCount, 2);
  for (let i = 0; i < 8; i++) await step(1000);
  assert.equal(delivered.length, 1, "delivered once");
  w.stopAll();
});

test("watcher: an edit that can't take the clips now (unsaved work open) is tried again later", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 2_000_000 });
  const fs = fakeFs();
  const W = "E:\\Drop";
  const watch: WatchFolder = { id: "w2test", folder: W, style: "montage", editPath: "D:\\Lib\\Edits\\Reel\\Reel.tatvamedit", mode: "rebuild", on: true };
  let accept = false;
  const delivered: string[][] = [];
  const notes: string[] = [];
  const w = new AutoWatcher({
    watches: () => [watch], known: async () => new Set(), fs,
    deliver: async (_w, files) => { if (!accept) return { added: 0, deferred: true, edit: watch.editPath }; delivered.push(files); return { added: files.length, edit: watch.editPath }; },
    notify: (title) => notes.push(title), saveWatch: () => undefined, log: () => undefined,
  });
  fs.files.set(path.join(W, "x.mov"), 42);
  w.sync();
  for (let i = 0; i < 7; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.equal(delivered.length, 0);
  assert.equal(w.status()[0].deferred, 1);
  accept = true;
  for (let i = 0; i < Math.ceil(RETRY_MS / 1000) + 2; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.equal(delivered.length, 1);
  assert.deepEqual(notes, ["Reel: auto edit rebuilt"]);
  w.stopAll();
  mock.timers.reset();
});
