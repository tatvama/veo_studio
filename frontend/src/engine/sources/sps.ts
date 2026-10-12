/**
 * The colour description an H.264 stream carries in its SPS (VUI: video_full_range_flag, colour_primaries,
 * transfer_characteristics, matrix_coefficients), read from the avcC box. Browsers report BT.709 for untagged HD,
 * but FFmpeg treats untagged YUV as BT.601 when it converts to RGB, so the engine needs to know which one it is.
 * Pure (unit-tested).
 */
export interface VideoColour { tagged: boolean; matrix?: number; primaries?: number; transfer?: number; fullRange?: boolean }

class Bits {
  private b: Uint8Array; private p = 0;
  constructor(b: Uint8Array) { this.b = b; }
  bit(): number { const v = (this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v; }
  bits(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  ue(): number { let z = 0; while (this.bit() === 0 && z < 32) z++; return z ? (2 ** z - 1) + this.bits(z) : 0; }
  se(): number { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
  left(): number { return this.b.length * 8 - this.p; }
}

/** RBSP: the NAL payload without emulation-prevention bytes (00 00 03). */
export function rbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0 && out.length >= 2 && out[out.length - 1] === 0 && out[out.length - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

function skipScaling(r: Bits, n: number) {
  let last = 8, next = 8;
  for (let j = 0; j < n; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Parses an H.264 SPS NAL unit (with its 1-byte header). */
export function spsColour(nal: Uint8Array): VideoColour {
  const r = new Bits(rbsp(nal.subarray(1)));
  const profile = r.bits(8);
  r.bits(16);  // constraint flags, level
  r.ue();      // seq_parameter_set_id
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = r.ue();
    if (chroma === 3) r.bit();
    r.ue(); r.ue(); r.bit();  // bit depths, qpprime bypass
    if (r.bit()) for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (r.bit()) skipScaling(r, i < 6 ? 16 : 64);
  }
  r.ue();  // log2_max_frame_num
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) { r.bit(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  r.ue(); r.bit();  // max_num_ref_frames, gaps
  r.ue(); r.ue();   // width / height in MBs
  if (!r.bit()) r.bit();  // frame_mbs_only, else mb_adaptive
  r.bit();  // direct_8x8
  if (r.bit()) { r.ue(); r.ue(); r.ue(); r.ue(); }  // cropping
  if (r.left() < 1 || !r.bit()) return { tagged: false };  // no VUI
  if (r.bit()) { if (r.bits(8) === 255) r.bits(32); }  // aspect ratio (extended SAR)
  if (r.bit()) r.bit();  // overscan
  if (!r.bit()) return { tagged: false };  // no video_signal_type
  r.bits(3);
  const fullRange = !!r.bit();
  if (!r.bit()) return { tagged: false, fullRange };  // no colour description
  const primaries = r.bits(8), transfer = r.bits(8), matrix = r.bits(8);
  return { tagged: matrix !== 2, matrix, primaries, transfer, fullRange };
}

/** The SPS NAL units of an avcC (AVCDecoderConfigurationRecord) payload. */
export function avccSps(avcc: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (avcc.length < 7) return out;
  const n = avcc[5] & 0x1f;
  let p = 6;
  for (let i = 0; i < n && p + 2 <= avcc.length; i++) {
    const len = (avcc[p] << 8) | avcc[p + 1];
    out.push(avcc.subarray(p + 2, p + 2 + len));
    p += 2 + len;
  }
  return out;
}

/** ITU-T H.273 matrix_coefficients → the engine's matrix (null: unspecified / not one we convert). */
export function matrixName(m: number | undefined): "bt709" | "bt601" | "bt2020" | null {
  if (m === 1) return "bt709";
  if (m === 5 || m === 6) return "bt601";
  if (m === 9 || m === 10) return "bt2020";
  return null;
}
