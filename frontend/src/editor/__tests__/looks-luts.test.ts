import assert from "node:assert/strict";
import { test } from "node:test";
import { cubeInfo, folderLutId, lutFormatOf, threeDlToCube, toCube } from "../moods/lutFiles.ts";

test("user LUT files: .cube checked, .3dl converted to .cube (red fastest)", () => {
  assert.equal(lutFormatOf("Film.CUBE"), "cube");
  assert.equal(lutFormatOf("a/b/look.3dl"), "3dl");
  assert.equal(lutFormatOf("look.png"), null);
  const cube = "TITLE \"Teal\"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
  assert.deepEqual(cubeInfo(cube), { ok: true, size: 2, title: "Teal" });
  assert.equal(cubeInfo("LUT_1D_SIZE 1024\n").ok, false);
  assert.equal(cubeInfo("LUT_3D_SIZE 2\n0 0 0\n").ok, false);
  // a 2-point identity .3dl at 10 bits: rows run blue fastest
  const rows: string[] = ["0 1023"];
  for (let r = 0; r < 2; r++) for (let g = 0; g < 2; g++) for (let b = 0; b < 2; b++) rows.push(`${r * 1023} ${g * 1023} ${b * 1023}`);
  const out = threeDlToCube(rows.join("\n"), "Ident");
  const info = cubeInfo(out);
  assert.ok(info.ok && info.size === 2);
  const data = out.split("\n").filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l));
  assert.deepEqual(data.slice(0, 3), ["0.000000 0.000000 0.000000", "1.000000 0.000000 0.000000", "0.000000 1.000000 0.000000"]);
  assert.ok("error" in toCube("x.3dl", "nonsense"));
  assert.equal(folderLutId("D:/LUTs", "Film.cube"), folderLutId("d:/luts", "film.CUBE"));
  assert.notEqual(folderLutId("D:/LUTs", "A.cube"), folderLutId("D:/LUTs", "B.cube"));
});
