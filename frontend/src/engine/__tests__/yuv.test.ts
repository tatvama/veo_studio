import assert from "node:assert/strict";
import { test } from "node:test";
import { packI420, repack, rgbToYuv, texelSource, yuvLayout, yuvToRgb } from "../yuv.ts";

test("layout: 4 Y per texel, two chroma rows per target row, one readPixels = I420", () => {
  const L = yuvLayout(1920, 1080);
  assert.equal(L.texW, 480); assert.equal(L.texH, 1080 + 540); assert.equal(L.cRows, 270); assert.ok(L.direct);
  assert.equal(L.texW * 4 * L.texH, L.bytes);
  assert.deepEqual(texelSource(L, 3, 10), { plane: "y", x: 12, y: 10 });
  assert.deepEqual(texelSource(L, 3, 1080), { plane: "u", x: 12, y: 0 });
  assert.deepEqual(texelSource(L, 240 + 3, 1080), { plane: "u", x: 12, y: 1 });
  assert.deepEqual(texelSource(L, 0, 1080 + 270 + 5), { plane: "v", x: 0, y: 10 });
  for (const [w, h] of [[3840, 2160], [1080, 1920], [720, 1280], [2160, 3840], [1280, 720]]) assert.ok(yuvLayout(w, h).direct, `${w}x${h}`);
  const odd = yuvLayout(1366, 770);  // padded width, an odd number of chroma rows
  assert.equal(odd.padW, 1368); assert.equal(odd.cRows, 193); assert.ok(!odd.direct);
  assert.throws(() => yuvLayout(101, 100));
});

test("BT.709 limited range: black 16/128/128, white 235, round trip", () => {
  assert.deepEqual(rgbToYuv(0, 0, 0), [16, 128, 128]);
  const w = rgbToYuv(1, 1, 1);
  assert.ok(Math.abs(w[0] - 235) < 1e-9 && Math.abs(w[1] - 128) < 1e-9 && Math.abs(w[2] - 128) < 1e-9);
  const r = rgbToYuv(1, 0, 0);
  assert.ok(Math.abs(r[0] - (16 + 219 * 0.2126)) < 1e-9 && Math.abs(r[2] - 240) < 1e-9);
  for (const c of [[0.2, 0.5, 0.9], [1, 0.5, 0], [0.33, 0.33, 0.33]] as [number, number, number][]) {
    const back = yuvToRgb(...rgbToYuv(...c));
    back.forEach((v, k) => assert.ok(Math.abs(v - c[k]) < 1e-9));
  }
});

test("repack: padded targets crop back to I420; the CPU packer matches the GPU layout", () => {
  for (const [w, h] of [[16, 8], [14, 6], [10, 4]]) {
    const L = yuvLayout(w, h);
    const rgba = new Uint8Array(w * h * 4).map((_, i) => (i * 37) % 251);
    const ref = packI420(rgba, w, h);
    // build what the GPU would read back from the layout description
    const buf = new Uint8Array(L.texW * 4 * L.texH);
    for (let r = 0; r < L.texH; r++) for (let i = 0; i < L.texW; i++) {
      const s = texelSource(L, i, r);
      for (let k = 0; k < 4; k++) {
        const x = s.x + k;
        let v = 0;
        if (s.plane === "y") v = ref[s.y * w + Math.min(x, w - 1)];
        else if (s.y < L.ch) v = ref[w * h + (s.plane === "v" ? L.cw * L.ch : 0) + s.y * L.cw + Math.min(x, L.cw - 1)];
        buf[(r * L.texW + i) * 4 + k] = v;
      }
    }
    assert.deepEqual(repack(L, buf), ref, `${w}x${h}`);
  }
});

test("colour bases: BT.709 ↔ BT.601 round trip, FFmpeg's untagged decode", async () => {
  const { basis, rgbToYuv } = await import("../yuv.ts");
  const ap = (m: number[], v: number[]) => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);
  // YUV (100, 90, 160) decoded as BT.709 then re-expressed as BT.601 = FFmpeg's own decode (149, 87, 21)
  const y = (100 - 16) / 219, pb = (90 - 128) / 224, pr = (160 - 128) / 224;
  const r709 = y + 1.5748 * pr, b709 = y + 1.8556 * pb, g709 = (y - 0.2126 * r709 - 0.0722 * b709) / 0.7152;
  const rgb601 = ap(basis("bt709", "bt601"), [r709, g709, b709]).map((v) => Math.round(v * 255));
  assert.deepEqual(rgb601, [149, 87, 21]);
  const back = ap(basis("bt601", "bt709"), ap(basis("bt709", "bt601"), [0.3, 0.6, 0.9]));
  back.forEach((v, i) => assert.ok(Math.abs(v - [0.3, 0.6, 0.9][i]) < 1e-12));
  assert.deepEqual(basis("bt709", "bt709"), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.ok(rgbToYuv(1, 1, 1)[0] > 234.9);
});

test("H.264 SPS colour description: untagged, BT.709, BT.601 full range", async () => {
  const { spsColour, matrixName } = await import("../sources/sps.ts");
  const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));
  assert.deepEqual(spsColour(hex("67640028acd940780227e5c044000003000400000300c03c60c658")), { tagged: false });
  const t = spsColour(hex("67640028acd940780227e5c05a810100a0000003002000000601e30632c0"));
  assert.equal(t.tagged, true); assert.equal(t.matrix, 1); assert.equal(t.fullRange, false); assert.equal(matrixName(t.matrix), "bt709");
  const sd = spsColour(hex("6742c01ed900a02ff97016e04040c80000030008000003018078b17240"));
  assert.equal(sd.matrix, 6); assert.equal(sd.fullRange, true); assert.equal(matrixName(sd.matrix), "bt601");
});
