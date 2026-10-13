/**
 * .cube 3D LUT parser (Adobe/Resolve format): LUT_3D_SIZE, DOMAIN_MIN / DOMAIN_MAX, TITLE, # comments, then N³ RGB
 * rows with red changing fastest, which is exactly the x-fastest layout of a TEXTURE_3D upload.
 */
export interface Lut3D { size: number; title: string; domainMin: [number, number, number]; domainMax: [number, number, number]; data: Float32Array }

export class CubeError extends Error {}

export function parseCube(text: string): Lut3D {
  let size = 0, title = "";
  let domainMin: [number, number, number] = [0, 0, 0], domainMax: [number, number, number] = [1, 1, 1];
  let data: Float32Array | null = null;
  let n = 0;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/#.*$/, "").trim();
    if (!line) continue;
    const c = line.charCodeAt(0);
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {  // a data row
      if (!data) throw new CubeError(`Line ${li + 1}: data before LUT_3D_SIZE`);
      const p = line.split(/\s+/);
      if (p.length < 3) throw new CubeError(`Line ${li + 1}: expected three numbers`);
      if (n >= size * size * size) throw new CubeError(`Line ${li + 1}: more than ${size}³ rows`);
      for (let k = 0; k < 3; k++) {
        const v = Number(p[k]);
        if (!Number.isFinite(v)) throw new CubeError(`Line ${li + 1}: "${p[k]}" isn't a number`);
        data[n * 3 + k] = v;
      }
      n++;
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    switch (key.toUpperCase()) {
      case "TITLE": title = line.slice(5).trim().replace(/^"|"$/g, ""); break;
      case "LUT_3D_SIZE": {
        size = Number(rest[0]);
        if (!Number.isInteger(size) || size < 2 || size > 256) throw new CubeError(`LUT_3D_SIZE ${rest[0]} is out of range (2..256)`);
        data = new Float32Array(size * size * size * 3);
        break;
      }
      case "LUT_1D_SIZE": throw new CubeError("1D LUTs aren't supported: export a 3D LUT (LUT_3D_SIZE)");
      case "DOMAIN_MIN": case "DOMAIN_MAX": {
        const v = rest.slice(0, 3).map(Number);
        if (v.length !== 3 || !v.every(Number.isFinite)) throw new CubeError(`${key} needs three numbers`);
        if (key.toUpperCase() === "DOMAIN_MIN") domainMin = v as [number, number, number]; else domainMax = v as [number, number, number];
        break;
      }
      case "LUT_3D_INPUT_RANGE": {  // Resolve's older spelling of the domain
        const v = rest.slice(0, 2).map(Number);
        if (v.length === 2 && v.every(Number.isFinite)) { domainMin = [v[0], v[0], v[0]]; domainMax = [v[1], v[1], v[1]]; }
        break;
      }
      default: break;  // unknown keywords are ignored, as grading apps do
    }
  }
  if (!size || !data) throw new CubeError("No LUT_3D_SIZE line: this isn't a 3D LUT");
  if (n !== size * size * size) throw new CubeError(`Expected ${size ** 3} rows, found ${n}`);
  for (let k = 0; k < 3; k++) if (!(domainMax[k] > domainMin[k])) throw new CubeError("DOMAIN_MAX must be above DOMAIN_MIN");
  return { size, title, domainMin, domainMax, data };
}

/** An identity LUT (tests and the lab's fallback). `f` maps each grid colour, e.g. to make a test grade. */
/** A LUT as .cube text (Adobe / Resolve: LUT_3D_SIZE, red fastest), e.g. to save next to an edit so any window can
 *  load it by URL. */
export function lutToCube(lut: Lut3D, title = lut.title): string {
  const out: string[] = [];
  if (title) out.push(`TITLE "${title.replace(/"/g, "'")}"`);
  out.push(`LUT_3D_SIZE ${lut.size}`);
  if (lut.domainMin.some((v) => v !== 0)) out.push(`DOMAIN_MIN ${lut.domainMin.join(" ")}`);
  if (lut.domainMax.some((v) => v !== 1)) out.push(`DOMAIN_MAX ${lut.domainMax.join(" ")}`);
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(6) : "0.000000");
  for (let i = 0; i < lut.data.length; i += 3) out.push(`${f(lut.data[i])} ${f(lut.data[i + 1])} ${f(lut.data[i + 2])}`);
  return out.join("\n") + "\n";
}

export function makeLut(size: number, f: (r: number, g: number, b: number) => [number, number, number] = (r, g, b) => [r, g, b]): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = f(r / (size - 1), g / (size - 1), b / (size - 1));
    data[i++] = o[0]; data[i++] = o[1]; data[i++] = o[2];
  }
  return { size, title: "", domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}

/** Trilinear lookup on the CPU (tests; matches the GPU's TEXTURE_3D sampling). */
export function lookup(lut: Lut3D, rgb: [number, number, number]): [number, number, number] {
  const s = lut.size;
  const p = rgb.map((v, k) => Math.min(1, Math.max(0, (v - lut.domainMin[k]) / (lut.domainMax[k] - lut.domainMin[k]))) * (s - 1));
  const i0 = p.map((v) => Math.min(Math.floor(v), s - 2)), f = p.map((v, k) => v - i0[k]);
  const at = (r: number, g: number, b: number, c: number) => lut.data[((b * s + g) * s + r) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
      acc += w * at(i0[0] + dx, i0[1] + dy, i0[2] + dz, c);
    }
    out[c] = acc;
  }
  return out;
}
