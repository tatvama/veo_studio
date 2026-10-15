/**
 * Lab probe: decodes presented frame k of an MP4 with WebCodecs and reports its format and colour space, the raw
 * planes (VideoFrame.copyTo) and what texImage2D makes of it (RGBA8), so colour handling can be checked against
 * FFmpeg's decode of the same frame.
 */
import { acquireDemux, releaseDemux } from "../sources/exact";

const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(s); };

export async function probeDecode(url: string, k: number, opts: { hardware?: boolean } = {}) {
  const d = await acquireDemux(url);
  try { return await probeDemuxed(d, k, opts); } finally { releaseDemux(url); }
}

async function probeDemuxed(d: Awaited<ReturnType<typeof acquireDemux>>, k: number, opts: { hardware?: boolean }) {
  const frames: VideoFrame[] = [];
  let err = "", n = 0;
  // outputs come in presentation order: keep only frame k (holding many stalls a hardware decoder)
  const dec = new VideoDecoder({ output: (f) => { if (n++ === k) frames.push(f); else f.close(); }, error: (e) => { err = String(e); } });
  dec.configure({ codec: d.codec, codedWidth: d.width, codedHeight: d.height, description: d.description,
    hardwareAcceleration: opts.hardware === false ? "prefer-software" : "prefer-hardware" });
  for (const s of d.samples.slice(0, k + 20)) dec.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.ts, duration: s.dur, data: s.data }));
  await dec.flush();
  const f = frames[0];
  if (!f) throw new Error(err || "no frame");
  const info = { format: f.format, colorSpace: f.colorSpace.toJSON(), coded: [f.codedWidth, f.codedHeight], display: [f.displayWidth, f.displayHeight],
    visible: f.visibleRect ? [f.visibleRect.x, f.visibleRect.y, f.visibleRect.width, f.visibleRect.height] : null, timestamp: f.timestamp };
  const buf = new Uint8Array(f.allocationSize());
  const layout = await f.copyTo(buf);
  const w = f.displayWidth, h = f.displayHeight;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const gl = cv.getContext("webgl2")!;
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  for (const x of frames) x.close();
  dec.close();
  return { info, layout, planes: b64(buf), rgba: b64(px) };
}
