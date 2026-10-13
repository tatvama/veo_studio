/**
 * Where a clip's pictures come from. The renderer asks a source for the image at a source time and re-uploads it
 * only when `version` changes. Live sources follow the timeline as well as they can (preview); exact sources wait
 * for precisely that frame (export).
 */
export interface Frame {
  image: TexImageSource; width: number; height: number; version: number;
  /** Only this part (pixels x, y, w, h of the image) changed since the last version: the texture is updated there. */
  rect?: [number, number, number, number];
  /** Exact mode: the decoded planes, converted on the GPU (no 8-bit clamp, nearest chroma: a plain clip comes out
   *  with the very YUV it went in with). */
  yuv?: YuvPlanes;
}
export interface YuvPlanes {
  format: "NV12" | "I420"; data: Uint8Array; layout: { offset: number; stride: number }[];
  fullRange: boolean;
  /** FFmpeg would turn this YUV into RGB with BT.601 (untagged or tagged 601): its RGB filters see those values. */
  ffmpeg601: boolean;
}

export interface FrameSource {
  readonly kind: "video" | "image" | "canvas";
  /** Resolves once the size is known and a first picture can be drawn (rejects if the media can't load). */
  readonly ready: Promise<void>;
  /** Live: the picture to show for source time `t` now (null = nothing yet). `playing` lets a video run on its own. */
  live(t: number, playing: boolean, rate: number): Frame | null;
  /** Exact: waits for the frame at `t` (the one whose time is the closest at or before t + half a frame). */
  exact(t: number): Promise<Frame | null>;
  /** Off screen for now: stop decoding / playing. */
  idle(): void;
  dispose(): void;
}

/**
 * A picture the caller draws itself (the lab's procedural media, the editor's title templates): `draw(t)` returns the
 * image for time t. Two optional hooks keep a mostly empty, mostly static picture cheap:
 *   version(t)  the picture's version at t; draw() is called and the texture updated only when it changes (a title
 *               holding still isn't uploaded again). Without it, every new t is a new picture (unless `still`).
 *   bounds(t)   the box (pixels x, y, w, h) outside which the picture is transparent at t; only the union of it and the
 *               last upload's box is uploaded (null: nothing drawn). draw() must leave the rest transparent.
 */
export interface CustomSource {
  kind: "canvas"; width: number; height: number; draw(t: number): TexImageSource; still?: boolean;
  version?(t: number): number;
  bounds?(t: number): [number, number, number, number] | null;
}

export class CanvasSource implements FrameSource {
  readonly kind = "canvas" as const;
  readonly ready = Promise.resolve();
  private spec: CustomSource;
  private lastT = NaN;
  private version = 0;
  private userVersion: number | null = null;
  private last: Frame | null = null;
  private box: [number, number, number, number] | null = null;
  constructor(spec: CustomSource) { this.spec = spec; }
  private frame(t: number): Frame {
    const sp = this.spec;
    if (sp.version) {
      const v = sp.version(t);
      if (this.last && v === this.userVersion) return this.last;
      this.userVersion = v;
      this.version++;
    } else if (!(sp.still && this.version) && t !== this.lastT) { this.lastT = t; this.version++; }
    else if (this.last) return this.last;
    const image = sp.draw(t);
    let rect: [number, number, number, number] | undefined;
    if (sp.bounds && this.last) {
      const b = sp.bounds(t);
      const u = union(this.box, b, sp.width, sp.height);
      this.box = b ? clip(b, sp.width, sp.height) : null;
      rect = u ?? [0, 0, 0, 0];
    } else if (sp.bounds) { const b = sp.bounds(t); this.box = b ? clip(b, sp.width, sp.height) : null; }
    this.last = { image, width: sp.width, height: sp.height, version: this.version, ...(rect ? { rect } : {}) };
    return this.last;
  }
  live(t: number): Frame { return this.frame(t); }
  exact(t: number): Promise<Frame> { return Promise.resolve(this.frame(t)); }
  idle(): void {}
  dispose(): void {}
}

function clip(b: [number, number, number, number], w: number, h: number): [number, number, number, number] {
  const x0 = Math.max(0, Math.floor(b[0])), y0 = Math.max(0, Math.floor(b[1]));
  const x1 = Math.min(w, Math.ceil(b[0] + b[2])), y1 = Math.min(h, Math.ceil(b[1] + b[3]));
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}
/** The union of two boxes (either may be missing) clipped to the picture; null when both are empty. */
export function union(a: [number, number, number, number] | null, b: [number, number, number, number] | null, w: number, h: number): [number, number, number, number] | null {
  const boxes = [a, b].filter((x): x is [number, number, number, number] => !!x && x[2] > 0 && x[3] > 0).map((x) => clip(x, w, h));
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((x) => x[0])), y0 = Math.min(...boxes.map((x) => x[1]));
  const x1 = Math.max(...boxes.map((x) => x[0] + x[2])), y1 = Math.max(...boxes.map((x) => x[1] + x[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** A still image (decoded once with createImageBitmap, EXIF orientation applied, no colour conversion). */
export class ImageSource implements FrameSource {
  readonly kind = "image" as const;
  readonly ready: Promise<void>;
  private bmp: ImageBitmap | null = null;
  constructor(url: string) {
    this.ready = (async () => {
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const blob = await r.blob();
      this.bmp = await createImageBitmap(blob, { imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    })();
    this.ready.catch(() => undefined);
  }
  private frame(): Frame | null { return this.bmp ? { image: this.bmp, width: this.bmp.width, height: this.bmp.height, version: 1 } : null; }
  live(): Frame | null { return this.frame(); }
  async exact(): Promise<Frame | null> { await this.ready.catch(() => undefined); return this.frame(); }
  idle(): void {}
  dispose(): void { this.bmp?.close(); this.bmp = null; }
}
