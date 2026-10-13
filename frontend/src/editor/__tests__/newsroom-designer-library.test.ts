/**
 * The look / template library (newsroom/designer/libraryCore.ts + validate.ts, docs/EDITOR.md §16.8–16.9): files are
 * checked with plain reasons, the browser backend keeps an index in storage, the desktop backend goes through the
 * bridge, only the user's ids are saved, imports get a fresh id when they would clash, listeners hear about changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeBackend, createLibrary, isMyLook, isMyTemplate, MY_TEMPLATE_ID, newLookId, newTemplateId, storageBackend, type LibKind, type StorageLike } from "../newsroom/designer/libraryCore.ts";
import { checkLook, checkTemplate, MAX_LOGO_BYTES } from "../newsroom/designer/validate.ts";
import { BUILTIN_LOOKS, copyLook } from "../newsroom/looks.ts";
import type { GfxTemplate } from "../newsroom/types.ts";

const base = BUILTIN_LOOKS[0];
const look = (id = newLookId(), name = "Morning") => copyLook(base, id, name);
const tpl = (id = newTemplateId(), name = "My strap"): GfxTemplate => ({
  id, name, category: "Straps", role: "strap", seconds: 6, timing: { in: 0.6, out: 0.4 },
  fields: [{ id: "name", label: "Name", type: "text", default: "Priya Rao" }],
  designs: { "16:9": { layers: [{ id: "plate", name: "Plate", kind: "rect", box: [120, 820, 760, 110], p: { fill: "@primary" } }] } },
  source: "mine", version: 1,
});

function memStorage(): StorageLike & { m: Map<string, string>; full: boolean } {
  const m = new Map<string, string>();
  const s = {
    m, full: false,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { if (s.full) { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; } m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
  return s;
}

test("ids", () => {
  assert.ok(isMyLook(newLookId()) && isMyTemplate(newTemplateId()));
  assert.ok(MY_TEMPLATE_ID.test("my.0b6c1f9e-1d2a-4c55-8a7e-3f0e5b8d9c11"));
  assert.equal(isMyLook("look.classic_red"), false);
  assert.equal(isMyTemplate("nr.straps.anchor"), false);
  assert.equal(isMyTemplate("my.../x"), false);
});

test("look checks: plain reasons, defaults filled, logo size", () => {
  assert.equal(checkLook(look(), base).ok, true);
  const r1 = checkLook({ ...look(), colors: { ...base.colors, accent: "gold" } }, base);
  assert.deepEqual(r1, { ok: false, reason: "Some colours are missing or not colours: accent." });
  assert.equal((checkLook({ id: "x" }, base) as { reason: string }).reason, "The look has no name.");
  assert.equal((checkLook([], base) as { reason: string }).reason, "It isn't a channel look.");
  const partial = { ...look() } as Record<string, unknown>;
  delete partial.clock; delete partial.separator; partial.builtIn = true;
  const r2 = checkLook(partial, base);
  assert.ok(r2.ok && r2.value.clock.zone === base.clock.zone && r2.value.separator === base.separator && r2.value.builtIn === undefined);
  const big = "data:image/png;base64," + "A".repeat(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 100);
  assert.match((checkLook({ ...look(), logo: { image: big } }, base) as { reason: string }).reason, /256 KB/);
  assert.match((checkLook({ ...look(), logo: { image: "javascript:alert(1)" } }, base) as { reason: string }).reason, /isn't an image/);
});

test("template checks", () => {
  assert.equal(checkTemplate(tpl()).ok, true);
  const bad = (patch: Record<string, unknown>) => (checkTemplate({ ...tpl(), ...patch }) as { reason?: string }).reason;
  assert.match(bad({ category: "Weather" })!, /category/);
  assert.match(bad({ designs: {} })!, /no designs/);
  assert.match(bad({ designs: { "3:2": { layers: [] } } })!, /Unknown design ratio/);
  assert.match(bad({ fields: [{ id: "a b", label: "x", type: "text", default: "" }] })!, /bad id/);
  assert.match(bad({ fields: [{ id: "a", label: "x", type: "text", default: "" }, { id: "a", label: "y", type: "text", default: "" }] })!, /share the id/);
  assert.match(bad({ designs: { "16:9": { layers: [{ id: "a", name: "a", kind: "rect", box: [0, 0, 1], p: {} }] } } })!, /position and size/);
  assert.match(bad({ version: 2 })!, /newer version/);
});

test("browser library: save, list (newest first, with categories), load, delete, notifications", async () => {
  const s = memStorage();
  const lib = createLibrary(() => storageBackend(s), () => base);
  let n = 0;
  const off = lib.onChange(() => { n++; });
  const a = look(undefined, "Alpha"), t = tpl(undefined, "Strap A");
  await lib.saveLook(a);
  await lib.saveTemplate(t);
  assert.equal(n, 2);
  assert.deepEqual((await lib.listLooks()).map((e) => e.name), ["Alpha"]);
  assert.deepEqual((await lib.listTemplates()).map((e) => [e.name, e.category]), [["Strap A", "Straps"]]);
  assert.equal((await lib.loadLook(a.id))!.name, "Alpha");
  assert.equal((await lib.loadTemplate(t.id))!.designs["16:9"]!.layers.length, 1);
  assert.equal(await lib.loadLook("look.my.nothere"), null);
  await assert.rejects(lib.saveLook(base), /Only your own looks/);
  await assert.rejects(lib.saveTemplate({ ...t, id: "nr.straps.anchor" }), /Only your own templates/);
  await assert.rejects(lib.saveTemplate({ ...t, category: "Nope" as never }), /category/);
  // a corrupt item reads as missing, a corrupt index as empty
  s.m.set(`tatvam.newsroom.library.look.${a.id}`, "{oops");
  assert.equal(await lib.loadLook(a.id), null);
  await lib.deleteLook(a.id);
  assert.deepEqual(await lib.listLooks(), []);
  s.m.set("tatvam.newsroom.library.templates", "[1]");
  assert.deepEqual(await lib.listTemplates(), []);
  s.full = true;
  await assert.rejects(lib.saveLook(look()), /storage is full/);
  off();
  s.full = false;
  await lib.saveLook(look());
  assert.equal(n, 3, "unsubscribed");
  assert.equal(lib.where(), "browser");
  const none = createLibrary(() => storageBackend(null), () => base);
  assert.deepEqual(await none.listLooks(), []);
  await assert.rejects(none.saveLook(look()), /can't keep a library/);
});

test("desktop library goes through the bridge; categories read once per version", async () => {
  const files = new Map<string, { json: string; modified: string }>();
  let reads = 0;
  const bridge = {
    libraryList: async (k: LibKind) => [...files.entries()].filter(([key]) => key.startsWith(k + ":")).map(([key, v]) => ({ id: key.slice(k.length + 1), name: JSON.parse(v.json).name, modified: v.modified })),
    libraryRead: async (k: LibKind, id: string) => { reads++; return files.get(`${k}:${id}`)?.json ?? null; },
    libraryWrite: async (k: LibKind, id: string, json: string) => { files.set(`${k}:${id}`, { json, modified: new Date(2026, 9, 14, 10, files.size).toISOString() }); return { path: `x/${id}` }; },
    libraryDelete: async (k: LibKind, id: string) => { files.delete(`${k}:${id}`); },
  };
  const lib = createLibrary(() => bridgeBackend(bridge), () => base);
  const t1 = tpl(undefined, "One"), t2 = { ...tpl(undefined, "Two"), category: "Boards" as const, role: "board" as const };
  await lib.saveTemplate(t1); await lib.saveTemplate(t2);
  files.set("template:nr.builtin.copy", { json: JSON.stringify(tpl("nr.builtin.copy")), modified: "2026-01-01T00:00:00.000Z" });
  const l1 = await lib.listTemplates();
  assert.deepEqual(l1.map((e) => [e.name, e.category]), [["Two", "Boards"], ["One", "Straps"]], "newest first; others' files skipped");
  const r0 = reads;
  await lib.listTemplates();
  assert.equal(reads, r0, "categories cached");
  assert.equal(lib.where(), "desktop");
});

test("imports: checked, fresh ids when they'd clash or aren't the user's", () => {
  const lib = createLibrary(() => storageBackend(memStorage()), () => base);
  const t = tpl("my.keep-this-id");
  const a = lib.parseTemplate(JSON.stringify(t), new Set());
  assert.ok(a.ok && a.value.id === "my.keep-this-id");
  const b = lib.parseTemplate(JSON.stringify(t), new Set(["my.keep-this-id"]));
  assert.ok(b.ok && b.value.id !== t.id && isMyTemplate(b.value.id));
  const c = lib.parseTemplate(JSON.stringify({ ...t, id: "nr.straps.anchor", source: "builtin" }), new Set());
  assert.ok(c.ok && isMyTemplate(c.value.id) && c.value.source === "imported");
  const d = lib.parseLook(JSON.stringify(base), new Set());
  assert.ok(d.ok && isMyLook(d.value.id) && d.value.builtIn === undefined);
  assert.deepEqual(lib.parseLook("<html>", new Set()), { ok: false, reason: "The file isn't readable (it isn't JSON)." });
  assert.equal(lib.parseTemplate(JSON.stringify({ hello: 1 }), new Set()).ok, false);
});
