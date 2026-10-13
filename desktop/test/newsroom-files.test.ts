/**
 * The News Room look / template library on disk (src/main/newsroom/files.ts, docs/EDITOR.md §16.9) in a temp library
 * root: ids are checked, writes are atomic and replace, lists read names from the files, bad JSON and huge files are
 * refused, and export / import go through the (fake) dialogs.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  exportFile, importFile, isLibraryId, libraryDelete, libraryDir, libraryList, libraryRead, libraryWrite, MAX_LIBRARY_BYTES, safeFileName,
  type FileDialogs,
} from "../src/main/newsroom/files.ts";
import type { NewsroomDeps } from "../src/main/newsroom/ipc.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tatvam-nr-lib-"));
after(() => fs.rm(root, { recursive: true, force: true }));
const logs: string[] = [];
const deps: NewsroomDeps = { libraryRoot: () => root, parent: () => null, log: (m) => { logs.push(m); } };
const look = (id: string, name: string) => JSON.stringify({ id, name, colors: {}, version: 1 });

test("ids: plain file names only", () => {
  for (const ok of ["my.0b6c1f9e-1d2a-4c55-8a7e-3f0e5b8d9c11", "look.my.abc", "a", "A_b-c.d9"]) assert.equal(isLibraryId(ok), true, ok);
  for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "C:x", ".hidden", "trail.", "a..b", "con", "NUL.txt", "a b", "x".repeat(161), 3, null]) {
    assert.equal(isLibraryId(bad), false, String(bad));
  }
});

test("write, read, list, replace and delete", async () => {
  const r = await libraryWrite(deps, "look", "look.my.one", look("look.my.one", "Morning red"));
  assert.equal(r.path, path.join(root, "News", "Looks", "look.my.one.tatvamlook"));
  assert.equal(JSON.parse((await libraryRead(deps, "look", "look.my.one"))!).name, "Morning red");
  await libraryWrite(deps, "look", "look.my.two", look("look.my.two", "Evening blue"));
  await libraryWrite(deps, "look", "look.my.one", look("look.my.one", "Morning red 2"));
  const list = await libraryList(deps, "look");
  assert.deepEqual(list.map((e) => e.name).sort(), ["Evening blue", "Morning red 2"]);
  const one = list.find((e) => e.id === "look.my.one")!;
  assert.ok(one.bytes > 10 && !Number.isNaN(Date.parse(one.modified)));
  assert.equal(one.path, r.path);
  const files = await fs.readdir(libraryDir(deps, "look"));
  assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0, "no temp files left behind");
  await libraryDelete(deps, "look", "look.my.one");
  await libraryDelete(deps, "look", "look.my.one");
  assert.equal(await libraryRead(deps, "look", "look.my.one"), null);
  assert.deepEqual((await libraryList(deps, "look")).map((e) => e.id), ["look.my.two"]);
  assert.deepEqual(await libraryList(deps, "template"), [], "no folder yet → empty");
});

test("templates live in their own folder; other files and unreadable JSON", async () => {
  await libraryWrite(deps, "template", "my.t1", JSON.stringify({ id: "my.t1", name: "Strap", version: 1 }));
  const dir = libraryDir(deps, "template");
  assert.equal(dir, path.join(root, "News", "Templates"));
  await fs.writeFile(path.join(dir, "notes.txt"), "hello");
  await fs.writeFile(path.join(dir, "my.broken.tatvamgfx"), "{ not json");
  const list = await libraryList(deps, "template");
  assert.deepEqual(list.map((e) => [e.id, e.name]).sort(), [["my.broken", "my.broken"], ["my.t1", "Strap"]]);
});

test("refused: bad ids, not JSON, not an object, the wrong id, too large", async () => {
  await assert.rejects(libraryWrite(deps, "look", "../evil", look("../evil", "x")), /can't be used/);
  await assert.rejects(libraryRead(deps, "look", "a/b"), /can't be used/);
  await assert.rejects(libraryDelete(deps, "template", "..\\x"), /can't be used/);
  await assert.rejects(libraryWrite(deps, "look", "look.my.x", "{"), /isn't readable JSON/);
  await assert.rejects(libraryWrite(deps, "look", "look.my.x", "[1,2]"), /isn't a Tatvam look/);
  await assert.rejects(libraryWrite(deps, "template", "my.x", JSON.stringify({ id: "my.y" })), /doesn't match/);
  const big = JSON.stringify({ id: "my.big", pad: "x".repeat(MAX_LIBRARY_BYTES) });
  await assert.rejects(libraryWrite(deps, "template", "my.big", big), /too large/);
  assert.equal(await libraryRead(deps, "template", "my.big"), null);
});

function fakeDialogs(savePath: string | null, openPath: string | null) {
  const calls: { kind: string; title?: string; defaultPath?: string }[] = [];
  const d: FileDialogs = {
    save: async (_p, o) => { calls.push({ kind: "save", title: o.title, defaultPath: o.defaultPath }); return savePath; },
    open: async (_p, o) => { calls.push({ kind: "open", title: o.title }); return openPath; },
  };
  return { d, calls };
}

test("export: the save dialog, the extension added, cancel", async () => {
  const out = path.join(root, "exports", "My strap");
  const { d, calls } = fakeDialogs(out, null);
  const json = JSON.stringify({ id: "my.t1", name: "Strap" });
  const p = await exportFile(deps, "template", json, "Strap: anchor / two-line?", d);
  assert.equal(p, out + ".tatvamgfx");
  assert.equal(await fs.readFile(p!, "utf8"), json);
  assert.equal(calls[0].defaultPath, "Strap anchor two-line.tatvamgfx");
  assert.equal(await exportFile(deps, "look", look("a", "b"), "Look", fakeDialogs(null, null).d), null, "cancelled");
  await assert.rejects(exportFile(deps, "look", "nope", "x", d), /readable JSON/);
});

test("import: the open dialog, name from the file, bad files refused", async () => {
  const src = path.join(root, "incoming", "Election night.tatvamlook");
  await fs.mkdir(path.dirname(src), { recursive: true });
  await fs.writeFile(src, look("look.my.e", "Election"));
  const r = await importFile(deps, "look", fakeDialogs(null, src).d);
  assert.deepEqual(r && { name: r.name, id: JSON.parse(r.json).id }, { name: "Election night", id: "look.my.e" });
  assert.equal(await importFile(deps, "look", fakeDialogs(null, null).d), null, "cancelled");
  const bad = path.join(root, "incoming", "bad.tatvamlook");
  await fs.writeFile(bad, "<html>");
  await assert.rejects(importFile(deps, "look", fakeDialogs(null, bad).d), /isn't a Tatvam look/);
});

test("safe file names", () => {
  assert.equal(safeFileName("  a:b*c  ", "x"), "a b c");
  assert.equal(safeFileName("...", "Graphic"), "Graphic");
  assert.equal(safeFileName("CON", "Graphic"), "Graphic");
  assert.equal(safeFileName("Name.", "x"), "Name");
});
