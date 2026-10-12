/**
 * LUT files the user brings (docs/EDITOR.md §12, last paragraph): .cube (Adobe / Resolve 3D LUTs) as they are, and
 * .3dl (Autodesk Lustre / Flame) converted to .cube so the engine reads both the same way. Only files from folders the
 * user picks; nothing is scanned or shipped. Pure.
 */

export type LutFormat = "cube" | "3dl";
export const lutFormatOf = (name: string): LutFormat | null => (/\.cube$/i.test(name) ? "cube" : /\.3dl$/i.test(name) ? "3dl" : null);

/** A .cube 3D LUT's size and title, or why it can't be used (1D LUTs, no LUT_3D_SIZE, too few rows). */
export function cubeInfo(text: string): { ok: true; size: number; title: string } | { ok: false; error: string } {
  let size = 0, title = "", rows = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const key = line.split(/\s+/)[0].toUpperCase();
    if (key === "TITLE") { title = line.slice(5).trim().replace(/^"|"$/g, ""); continue; }
    if (key === "LUT_1D_SIZE") return { ok: false, error: "1D LUTs aren't supported (only 3D)" };
    if (key === "LUT_3D_SIZE") { size = Number(line.split(/\s+/)[1]); continue; }
    if (/^[-+.\d]/.test(line)) rows++;
  }
  if (!Number.isInteger(size) || size < 2 || size > 256) return { ok: false, error: "No LUT_3D_SIZE line" };
  if (rows < size * size * size) return { ok: false, error: `Expected ${size ** 3} rows, found ${rows}` };
  return { ok: true, size, title };
}

/**
 * A .3dl LUT as .cube text. The first numeric line is the input mesh (N breakpoints → an N³ LUT); then N³ rows of
 * integer RGB with blue changing fastest. Output depth is read from the largest value (10, 12 or 16 bit).
 */
export function threeDlToCube(text: string, title = "LUT"): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && /^[-+\d]/.test(l));
  if (!lines.length) throw new Error("Empty .3dl file");
  let rows = lines.map((l) => l.split(/\s+/).map(Number));
  let n = 0;
  if (rows[0].length > 3) { n = rows[0].length; rows = rows.slice(1); }
  else n = Math.round(Math.cbrt(rows.length));
  rows = rows.filter((r) => r.length >= 3 && r.slice(0, 3).every(Number.isFinite));
  if (n < 2 || rows.length < n * n * n) throw new Error(`A .3dl LUT needs ${n}³ rows (found ${rows.length})`);
  const max = Math.max(...rows.slice(0, n ** 3).flatMap((r) => r.slice(0, 3)));
  const depth = max > 4095 ? 65535 : max > 1023 ? 4095 : 1023;
  const out: string[] = [`TITLE "${title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${n}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  const f = (v: number) => (Math.max(0, Math.min(1, v / depth))).toFixed(6);
  // .cube: red fastest; .3dl: blue fastest (index = r·n² + g·n + b)
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const row = rows[r * n * n + g * n + b];
    out.push(`${f(row[0])} ${f(row[1])} ${f(row[2])}`);
  }
  return out.join("\n") + "\n";
}

/** Any supported LUT file as .cube text plus its size, or an error. */
export function toCube(name: string, text: string): { cube: string; size: number; title: string } | { error: string } {
  const fmt = lutFormatOf(name);
  const base = name.replace(/\.[^.]+$/, "");
  try {
    const cube = fmt === "3dl" ? threeDlToCube(text, base) : fmt === "cube" ? text : null;
    if (!cube) return { error: "Not a .cube or .3dl file" };
    const info = cubeInfo(cube);
    if (!info.ok) return { error: info.error };
    return { cube, size: info.size, title: info.title || base };
  } catch (e) { return { error: (e as Error).message }; }
}

/** A stable look id for a LUT file in a user folder (so a look survives reopening the folder): "fld_<hash>". */
export function folderLutId(folder: string, file: string): string {
  let h = 2166136261;
  for (const ch of `${folder.toLowerCase()}/${file.toLowerCase()}`) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619) >>> 0; }
  return `fld_${h.toString(36)}`;
}
