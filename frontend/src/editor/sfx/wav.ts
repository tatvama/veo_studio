/**
 * WAV files for the generated sounds (docs/EDITOR.md §15.1): 24-bit PCM, mono or stereo, any sample rate (the
 * engine renders 48 kHz), and a small reader for the tests and for checking what was written. Pure: no DOM.
 */

/** A 24-bit PCM WAV (format 1) of one or two channels; samples are clamped to −1..1 and rounded. */
export function encodeWav(ch: Float32Array[], sampleRate: number): Uint8Array {
  const nc = ch.length;
  if (nc < 1 || nc > 2) throw new Error("A WAV here is mono or stereo");
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new Error("Unsupported sample rate");
  const n = ch[0].length;
  if (ch.some((c) => c.length !== n)) throw new Error("Channels differ in length");
  const block = nc * 3, data = n * block, pad = data & 1;
  const buf = new ArrayBuffer(44 + data + pad), v = new DataView(buf), u8 = new Uint8Array(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data + pad, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * block, true); v.setUint16(32, block, true); v.setUint16(34, 24, true);
  str(36, "data"); v.setUint32(40, data, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const x = ch[c][i];
      let s = Math.round((x > 1 ? 1 : x < -1 ? -1 : x || 0) * 8388607);
      if (s < 0) s += 0x1000000;
      u8[o] = s & 0xff; u8[o + 1] = (s >> 8) & 0xff; u8[o + 2] = (s >> 16) & 0xff;
      o += 3;
    }
  }
  return u8;
}

export interface WavInfo { format: number; channels: number; sampleRate: number; bits: number; frames: number; data: Float32Array[] }

/** Reads a PCM (16 / 24 / 32-bit) or float WAV. */
export function decodeWav(bytes: Uint8Array): WavInfo {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let o = 12, fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (o + 8 <= bytes.length) {
    const id = tag(o), size = v.getUint32(o + 4, true), body = o + 8;
    if (id === "fmt ") fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    if (id === "data") {
      if (!fmt) throw new Error("WAV data before its format");
      const bps = fmt.bits / 8, frames = Math.floor(size / (bps * fmt.channels));
      const data = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) {
        const p = body + (i * fmt.channels + c) * bps;
        let x: number;
        if (fmt.format === 3) x = bps === 8 ? v.getFloat64(p, true) : v.getFloat32(p, true);
        else if (bps === 3) { let s = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16); if (s & 0x800000) s -= 0x1000000; x = s / 8388608; }
        else if (bps === 2) x = v.getInt16(p, true) / 32768;
        else x = v.getInt32(p, true) / 2147483648;
        data[c][i] = x;
      }
      return { ...fmt, frames, data };
    }
    o = body + size + (size & 1);
  }
  throw new Error("WAV without data");
}
