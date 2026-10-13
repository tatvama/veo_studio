/** Procedural test media for the engine lab: no server media needed. */
import type { CustomSource } from "../sources/source";

const PAL: Record<string, string[]> = {
  A: ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"],
  B: ["#ff7f50", "#ffd166", "#06d6a0", "#118ab2", "#073b4c", "#ef476f", "#8338ec"],
};

/** Colour bars, a grey ramp, a moving circle and a big label ("A", "B"); redrawn only when t changes. */
export function procedural(label: string, w = 1280, h = 720, still = false): CustomSource {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  let last = NaN;
  return {
    kind: "canvas", width: w, height: h, still,
    draw(t: number) {
      if (t === last) return c;
      last = t;
      const bars = PAL[label] ?? PAL.A;
      const bw = w / bars.length;
      bars.forEach((col, i) => { g.fillStyle = col; g.fillRect(Math.floor(i * bw), 0, Math.ceil(bw), h * 0.72); });
      const ramp = g.createLinearGradient(0, 0, w, 0);
      ramp.addColorStop(0, "#000"); ramp.addColorStop(1, "#fff");
      g.fillStyle = ramp; g.fillRect(0, h * 0.72, w, h * 0.14);
      for (let i = 0; i < 16; i++) { g.fillStyle = `hsl(${i * 22.5} 80% 50%)`; g.fillRect((i * w) / 16, h * 0.86, w / 16 + 1, h * 0.14); }
      const x = (0.5 + 0.38 * Math.sin(t * 1.7)) * w, y = (0.4 + 0.22 * Math.cos(t * 1.1)) * h;
      g.beginPath(); g.arc(x, y, h * 0.09, 0, Math.PI * 2);
      g.fillStyle = label === "A" ? "#ffffff" : "#111111"; g.fill();
      g.lineWidth = h * 0.012; g.strokeStyle = label === "A" ? "#d03030" : "#30d0ff"; g.stroke();
      g.font = `700 ${Math.round(h * 0.42)}px system-ui, sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.lineWidth = h * 0.02; g.strokeStyle = "#000"; g.strokeText(label, w / 2, h * 0.38);
      g.fillStyle = "#fff"; g.fillText(label, w / 2, h * 0.38);
      g.font = `600 ${Math.round(h * 0.05)}px ui-monospace, monospace`;
      g.textAlign = "left"; g.fillStyle = "#000";
      g.fillText(`${label}  t=${t.toFixed(2)}`, w * 0.02, h * 0.79);
      return c;
    },
  };
}

/** A round badge with transparency (layer tests). */
export function badge(size = 512, text = "L"): CustomSource {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size * 0.4, size * 0.35, size * 0.05, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "#fff7c2"); grad.addColorStop(1, "#f97316");
  g.beginPath(); g.arc(size / 2, size / 2, size * 0.47, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
  g.font = `800 ${size * 0.5}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#3b1a00";
  g.fillText(text, size / 2, size * 0.53);
  return { kind: "canvas", width: size, height: size, still: true, draw: () => c };
}

/** Random colours in 8×8 blocks (lossless through 4:2:0 subsampling): the YUV round-trip pattern. */
export function blocks(w: number, h: number, seed = 1): CustomSource {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) {
    g.fillStyle = `rgb(${Math.round(16 + rnd() * 223)},${Math.round(16 + rnd() * 223)},${Math.round(16 + rnd() * 223)})`;
    g.fillRect(x, y, 8, 8);
  }
  return { kind: "canvas", width: w, height: h, still: true, draw: () => c };
}

/** Raw RGB24 bytes → a canvas source (FFmpeg reference frames). */
export function rawRgb(rgb: Uint8Array, w: number, h: number): CustomSource {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { img.data[i * 4] = rgb[i * 3]; img.data[i * 4 + 1] = rgb[i * 3 + 1]; img.data[i * 4 + 2] = rgb[i * 3 + 2]; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  return { kind: "canvas", width: w, height: h, still: true, draw: () => c };
}

/** A colour-map strip (size² × size) that inverts colours, as a data URL (image parameters). */
export function invertStripUrl(size = 16): string {
  const c = document.createElement("canvas");
  c.width = size * size; c.height = size;
  const g = c.getContext("2d")!;
  const img = g.createImageData(size * size, size);
  for (let y = 0; y < size; y++) for (let b = 0; b < size; b++) for (let r = 0; r < size; r++) {
    const o = (y * size * size + b * size + r) * 4, k = 255 / (size - 1);
    img.data[o] = 255 - r * k; img.data[o + 1] = 255 - y * k; img.data[o + 2] = 255 - b * k; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/** A radial light (white centre, dark edges), as a data URL. */
export function lightUrl(size = 256): string {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size * 0.5, size * 0.45, size * 0.05, size * 0.5, size * 0.5, size * 0.6);
  grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, "#202020");
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  return c.toDataURL("image/png");
}
