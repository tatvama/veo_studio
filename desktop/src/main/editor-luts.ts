/**
 * LUT folders for the editor's LUT browser (docs/EDITOR.md §10): folders the user adds (and only those) are listed for
 * .cube and .3dl files, and a picked file is copied into the edit's LUTs\ folder, a .3dl converted to .cube on the way.
 * `threeDlToCube` is pure (test/editor-wave3.test.ts); the scan reads the folder.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

export const LUT_EXTS = [".cube", ".3dl"];
const MAX_FILES = 2000;
const MAX_DEPTH = 3;

/** .cube / .3dl files under `dir` (3 levels deep, at most 2000, skipping hidden folders), sorted by relative path. */
export async function scanLutFolder(dir: string): Promise<{ name: string; relPath: string; size: number }[]> {
  const out: { name: string; relPath: string; size: number }[] = [];
  const walk = async (rel: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!e.name.startsWith(".")) await walk(r, depth + 1); continue; }
      if (!e.isFile() || !LUT_EXTS.includes(path.extname(e.name).toLowerCase())) continue;
      try { out.push({ name: e.name, relPath: r, size: (await fsp.stat(path.join(dir, r))).size }); } catch { /* vanished */ }
    }
  };
  await walk("", 0);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * An Autodesk / Lustre .3dl 3D LUT as .cube text. The .3dl has an input mesh line (N values: the cube size), then N³
 * lines of integer R G B with blue changing fastest; the output depth comes from a "Mesh <in> <out>" line, else from
 * the largest value (10, 12 or 16 bits). The .cube has red changing fastest and values 0..1.
 */
export function threeDlToCube(text: string, title = "Converted"): { cube: string; size: number } {
  let mesh: number[] | null = null;
  let outBits = 0;
  const rows: number[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^mesh\s+(\d+)\s+(\d+)/i.exec(line);
    if (m) { outBits = Number(m[2]); continue; }
    if (/^[a-z]/i.test(line)) continue; // LUT8, gamma … (Lustre keywords)
    const v = line.split(/\s+/).map(Number);
    if (v.some((x) => !Number.isFinite(x))) throw new Error(`Not a .3dl line: "${line.slice(0, 40)}"`);
    if (!mesh && !rows.length && v.length !== 3) { mesh = v; continue; } // the input mesh comes first
    if (v.length !== 3) throw new Error(`A .3dl row needs three numbers: "${line.slice(0, 40)}"`);
    rows.push(v);
  }
  const n = Math.round(Math.cbrt(rows.length));
  if (n < 2 || n ** 3 !== rows.length) throw new Error(`The .3dl has ${rows.length} rows, which isn't a cube`);
  if (mesh && mesh.length !== n) throw new Error(`The .3dl mesh has ${mesh.length} points but the data is ${n}³`);
  let top = 0;
  for (const row of rows) for (const x of row) if (x > top) top = x;
  const bits = outBits > 0 ? outBits : [8, 10, 12, 14, 16].find((b) => top <= 2 ** b - 1) ?? 16;
  const max = 2 ** bits - 1;
  const lines = [`TITLE "${title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${n}`, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const row = rows[b + g * n + r * n * n]; // .3dl: blue fastest
        lines.push(row.map((x) => (Math.min(max, Math.max(0, x)) / max).toFixed(6)).join(" "));
      }
    }
  }
  return { cube: `${lines.join("\n")}\n`, size: n };
}

/** A sidecar's name: letters, digits, _ . - (no path, no "..", at most 64). */
export function sidecarName(name: unknown): string {
  const s = String(name ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(s) || s.includes("..")) throw new Error("A sidecar name is letters, digits, _ . and - (at most 64)");
  return s.replace(/\.json$/i, "");
}
