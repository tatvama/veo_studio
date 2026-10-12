/**
 * Small icons drawn in code for the taskbar (overlay badge, thumbnail toolbar buttons) and the tray fallback, so the
 * app needs no icon files for them. Each returns a BGRA bitmap for nativeImage.createFromBitmap.
 */
export type Rgba = [number, number, number, number];

export function hexRgba(hex: string, a = 255): Rgba {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), a] : [34, 211, 238, a];
}

/** A size×size BGRA canvas with an anti-aliased painter (coverage by 4×4 supersampling). */
function canvas(size: number, inside: (x: number, y: number) => Rgba | null): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = inside((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size);
          if (!c) continue;
          const w = c[3] / 255;
          r += c[0] * w; g += c[1] * w; b += c[2] * w; a += w;
        }
      }
      const i = (y * size + x) * 4;
      const cov = a / (n * n);
      if (a > 0) {
        buf[i] = Math.round(b / a); buf[i + 1] = Math.round(g / a); buf[i + 2] = Math.round(r / a);
      }
      buf[i + 3] = Math.round(cov * 255);
    }
  }
  return buf;
}

/** A filled dot with a dark ring (the "job running" overlay badge). */
export function dotIcon(size: number, color: Rgba): Buffer {
  return canvas(size, (x, y) => {
    const d = Math.hypot(x - 0.5, y - 0.5);
    if (d <= 0.34) return color;
    if (d <= 0.47) return [10, 14, 21, 255];
    return null;
  });
}

/** A white ✕ (cancel). */
export function crossIcon(size: number, color: Rgba = [255, 255, 255, 255]): Buffer {
  return canvas(size, (x, y) => {
    if (x < 0.2 || x > 0.8 || y < 0.2 || y > 0.8) return null;
    const d1 = Math.abs(x - y) / Math.SQRT2, d2 = Math.abs(x + y - 1) / Math.SQRT2;
    return Math.min(d1, d2) < 0.07 ? color : null;
  });
}

/** Two bars (pause). */
export function pauseIcon(size: number, color: Rgba = [255, 255, 255, 255]): Buffer {
  return canvas(size, (x, y) => (y > 0.22 && y < 0.78 && ((x > 0.27 && x < 0.43) || (x > 0.57 && x < 0.73)) ? color : null));
}

/** A rounded square with a "T" cut out (tray fallback when the app icon can't be found). */
export function appIcon(size: number, color: Rgba): Buffer {
  return canvas(size, (x, y) => {
    const r = 0.2, inset = 0.06;
    const cx = Math.min(Math.max(x, inset + r), 1 - inset - r), cy = Math.min(Math.max(y, inset + r), 1 - inset - r);
    if (Math.hypot(x - cx, y - cy) > r) return null;
    const bar = y > 0.24 && y < 0.36 && x > 0.24 && x < 0.76;
    const stem = x > 0.44 && x < 0.56 && y >= 0.36 && y < 0.78;
    return bar || stem ? [5, 7, 11, 255] : color;
  });
}
