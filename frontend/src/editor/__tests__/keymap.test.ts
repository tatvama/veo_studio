import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_KEYS, exportKeys, findConflicts, importKeys, KEY_ACTIONS, KEY_PRESETS, keyIndex, normalizeKey, parseKeySettings, resetKeys, resolveBindings, setKeys,
} from "../model/keybindings.ts";

test("key names normalise to Ctrl, Alt, Shift order", () => {
  assert.equal(normalizeKey("shift+ctrl+k"), "Ctrl+Shift+K");
  assert.equal(normalizeKey("Cmd+Option+n"), "Ctrl+Alt+N");
  assert.equal(normalizeKey("space"), "Space");
  assert.equal(normalizeKey("Alt+left"), "Alt+ArrowLeft");
  assert.equal(normalizeKey(";"), ";");
  assert.equal(normalizeKey("Ctrl+\\"), "Ctrl+\\");
  assert.equal(normalizeKey(""), "");
});

test("every preset is free of conflicts and keeps the actions' ids", () => {
  for (const p of KEY_PRESETS) {
    const b = resolveBindings({ preset: p.id, custom: {} });
    assert.deepEqual(findConflicts(b), [], `${p.id} has conflicts`);
    assert.equal(Object.keys(b).length, KEY_ACTIONS.length);
  }
  const prem = resolveBindings(DEFAULT_KEYS), fcp = resolveBindings({ preset: "fcp", custom: {} }), dr = resolveBindings({ preset: "resolve", custom: {} });
  assert.deepEqual(prem["add.edit"], ["Ctrl+K"]);
  assert.deepEqual(fcp["add.edit"], ["Ctrl+B"]); assert.deepEqual(fcp["insert"], ["W"]); assert.deepEqual(fcp["tool.select"], ["A"]);
  assert.deepEqual(dr["insert"], ["F9"]); assert.deepEqual(dr["freeze"], ["Shift+R"]); assert.deepEqual(dr["snapping"], ["N"]);
});

test("conflicts are found, and taking a key moves it off the other action", () => {
  let st = setKeys(DEFAULT_KEYS, "freeze", ["Ctrl+K"]);
  const c = findConflicts(resolveBindings(st));
  assert.deepEqual(c, [{ key: "Ctrl+K", actions: ["add.edit", "freeze"] }]);
  // the first action in the list wins the key until the conflict is fixed
  assert.equal(keyIndex(resolveBindings(st)).get("Ctrl+K"), "add.edit");
  st = setKeys(DEFAULT_KEYS, "freeze", ["Ctrl+K"], { steal: true });
  const b = resolveBindings(st);
  assert.deepEqual(b["add.edit"], []); assert.deepEqual(b["freeze"], ["Ctrl+K"]);
  assert.deepEqual(findConflicts(b), []);
  assert.deepEqual(resolveBindings(resetKeys(st, "add.edit"))["add.edit"], ["Ctrl+K"]);
  // Escape can't be rebound
  assert.equal(setKeys(DEFAULT_KEYS, "escape", ["Q"]), DEFAULT_KEYS);
});

test("exported shortcuts import back; broken files and saved settings fall back safely", () => {
  const st = setKeys({ preset: "fcp", custom: {} }, "magnetic", ["Alt+M"]);
  const back = importKeys(exportKeys(st));
  assert.equal(back.preset, "fcp");
  assert.deepEqual(back.custom, { magnetic: ["Alt+M"] });
  assert.throws(() => importKeys("{}"), /isn't a Tatvam/);
  assert.throws(() => importKeys("nope"), /valid JSON/);
  assert.deepEqual(parseKeySettings("{bad"), DEFAULT_KEYS);
  assert.deepEqual(parseKeySettings(JSON.stringify({ preset: "resolve", custom: { "tool.razor": ["X"], nope: ["Y"] } })), { preset: "resolve", custom: { "tool.razor": ["X"] } });
});
