/**
 * Where a clip's pictures come from. The renderer asks a source for the image at a source time and re-uploads it
 * only when `version` changes. Live sources follow the timeline as well as they can (preview); exact sources wait
 * for precisely that frame (export).
 */
export interface Frame {
  image: TexImageSource; width: number; height: number; version: number;
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

/** A picture the caller draws itself (the lab's procedural media): `draw(t)` returns the image for time t. */
export interface CustomSource { kind: "canvas"; width: number; height: number; draw(t: number): TexImageSource; still?: boolean }

export class CanvasSource implements FrameSource {
  readonly kind = "canvas" as const;
  readonly ready = Promise.resolve();
  private spec: CustomSource;
  private lastT = NaN;
  private version = 0;
  constructor(spec: CustomSource) { this.spec = spec; }
  private frame(t: number): Frame {
    if (!(this.spec.still && this.version) && t !== this.lastT) { this.lastT = t; this.version++; }
    return { image: this.spec.draw(t), width: this.spec.width, height: this.spec.height, version: this.version };
  }
  live(t: number): Frame { return this.frame(t); }
  exact(t: number): Promise<Frame> { return Promise.resolve(this.frame(t)); }
  idle(): void {}
  dispose(): void {}
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
