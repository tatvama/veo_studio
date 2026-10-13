import assert from "node:assert/strict";
import { test } from "node:test";
import { drawGraphic } from "../newsroom/render/index.ts";
import type { Ctx2D, GfxRenderInput } from "../newsroom/render/contract.ts";
import { BUILTIN_LOOKS, builtinLook } from "../newsroom/looks.ts";
import { BOARDS } from "../newsroom/templates/boards.ts";
import { STRAPS } from "../newsroom/templates/straps.ts";
import { defaults } from "../newsroom/templates/kit.ts";
import type { GfxRatio, GfxTemplate, GfxValue } from "../newsroom/types.ts";
import { parseDuration, timerLeft, timerParts } from "../newsroom/boards/math.ts";

/** A canvas stand-in for Node: records text, measures every character as 0.55 em, ignores the rest. */
function mockCtx(): { g: Ctx2D; texts: string[] } {
  const texts: string[] = [];
  const state: Record<string | symbol, unknown> = { font: "10px sans-serif", globalAlpha: 1, letterSpacing: "0px", textAlign: "left", textBaseline: "alphabetic" };
  const stack: Record<string | symbol, unknown>[] = [];
  const sizeOf = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10);
  const api: Record<string, unknown> = {
    save: () => { stack.push({ ...state }); },
    restore: () => { const s = stack.pop(); if (s) Object.assign(state, s); },
    measureText: (s: string) => { const z = sizeOf(); return { width: [...s].length * z * 0.55, actualBoundingBoxAscent: z * 0.72, fontBoundingBoxAscent: z * 0.9, fontBoundingBoxDescent: z * 0.25 }; },
    fillText: (s: string, x: number, y: number) => { assert.ok(Number.isFinite(x) && Number.isFinite(y), `text "${s}" at ${x},${y}`); texts.push(s); },
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  const g = new Proxy(state, {
    get: (_t, k) => (k in api ? api[k as string] : k in state ? state[k] : () => undefined),
    set: (_t, k, v) => { state[k] = v; return true; },
    has: (_t, k) => k in api || k in state || k === "letterSpacing" || k === "filter",
  }) as unknown as Ctx2D;
  return { g, texts };
}

const input = (t: GfxTemplate, ratio: GfxRatio, lookId = "look.classic_red", values: Record<string, GfxValue> = {}): GfxRenderInput =>
  ({ template: t, values: { ...defaults(t), ...values }, look: builtinLook(lookId)!, images: {}, seed: 7, fps: 25, ratio });
const sizeOf = (r: GfxRatio): [number, number] => (r === "16:9" ? [1920, 1080] : [1080, 1920]);

/** Fails the test when the renderer reports a layer that threw. */
function watchWarnings(): () => string[] {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { seen.push(a.map((x) => (x instanceof Error ? x.stack ?? x.message : String(x))).join(" ")); };
  return () => { console.warn = orig; return seen; };
}

test("every strap and board draws in both ratios, every look, through in, hold and out", () => {
  const stop = watchWarnings();
  let frames = 0;
  try {
    for (const t of [...STRAPS, ...BOARDS]) {
      const dur = t.seconds || 8;
      for (const r of ["16:9", "9:16"] as GfxRatio[]) {
        for (const look of BUILTIN_LOOKS) {
          for (const at of [0.05, 0.3, 0.8, 1.6, 3, dur * 0.6, dur - 0.25, dur - 0.05]) {
            const { g } = mockCtx();
            const [W, H] = sizeOf(r);
            drawGraphic(g, input(t, r, look.id), W, H, at, dur);
            frames++;
          }
        }
      }
    }
  } finally {
    const w = stop();
    assert.deepEqual(w, [], w.join("\n"));
  }
  assert.ok(frames > 2000);
});

test("the same frame draws the same text (deterministic)", () => {
  for (const t of [...STRAPS, ...BOARDS]) {
    for (const at of [0.6, 2.2, 5.5]) {
      const a = mockCtx(), b = mockCtx();
      drawGraphic(a.g, input(t, "16:9"), 1920, 1080, at, t.seconds || 8);
      drawGraphic(b.g, input(t, "16:9"), 1920, 1080, at, t.seconds || 8);
      assert.deepEqual(a.texts, b.texts, `${t.id} @${at}`);
    }
  }
});

test("the big number counts up to ₹1.95 lakh crore and stays there", () => {
  const t = BOARDS.find((x) => x.id === "nr.boards.big_number")!;
  const at = (s: number) => { const m = mockCtx(); drawGraphic(m.g, input(t, "16:9"), 1920, 1080, s, 9); return m.texts.join(""); };
  assert.ok(at(1.0).includes("₹"));
  assert.ok(!at(1.0).includes("1.95lakh crore"), "still counting early on");
  assert.ok(at(4).includes("₹1.95lakh crore"), at(4));
  assert.ok(at(7).includes("₹1.95lakh crore"));
  assert.ok(at(4).includes("+9.1%"));
});

test("lists build item by item; a countdown ticks; the stamp follows the verdict", () => {
  const kp = BOARDS.find((x) => x.id === "nr.boards.key_points")!;
  const seen = (s: number) => { const m = mockCtx(); drawGraphic(m.g, input(kp, "16:9"), 1920, 1080, s, 12); return m.texts.join("|"); };
  const items = ["Income up to", "Standard deduction", "₹11.2 lakh crore", "किसान", "Customs duty"];
  const count = (s: number) => items.filter((x) => seen(s).includes(x)).length;
  assert.ok(count(0.7) <= 1);
  assert.ok(count(2.5) > count(0.7) && count(2.5) < 5, `${count(2.5)}`);
  assert.equal(count(8), 5);
  const cd = BOARDS.find((x) => x.id === "nr.boards.countdown")!;
  const clock = (s: number) => { const m = mockCtx(); drawGraphic(m.g, input(cd, "16:9"), 1920, 1080, s, 10); return m.texts.join(""); };
  // the timer starts at its in delay (0.35 s) plus its own delay (0.6 s); between flips each tile shows one value
  const hms = (s: number) => timerParts(timerLeft(parseDuration("02:14:30"), s, 0.95), "hms").map((x) => String(x).padStart(2, "0"));
  for (const s of [3.5, 8.5]) {
    const [h, m, sec] = hms(s);
    assert.ok(clock(s).includes(`${h}HOURS${m}MINUTES${sec}SECONDS`), `${s}: ${clock(s)}`);
  }
  assert.notEqual(hms(3.5)[2], hms(8.5)[2]);
  const fc = BOARDS.find((x) => x.id === "nr.boards.fact_check")!;
  const stamp = (v: string) => { const m = mockCtx(); drawGraphic(m.g, input(fc, "16:9", "look.classic_red", { verdict: v }), 1920, 1080, 5, 11); return m.texts; };
  assert.ok(stamp("False").includes("FALSE"));
  assert.ok(stamp("भ्रामक").includes("भ्रामक"));
});

test("long names and Hindi text don't break straps", () => {
  const stop = watchWarnings();
  try {
    for (const t of STRAPS) {
      const long: Record<string, GfxValue> = {};
      for (const f of t.fields) if (f.type === "text" || f.type === "longtext") long[f.id] = f.id === "name" ? "डॉ. वेंकटराघवन सुब्रमण्यम कृष्णमूर्ति अय्यर" : "Additional Chief Secretary (Home), Government of Karnataka, Bengaluru";
      for (const r of ["16:9", "9:16"] as GfxRatio[]) {
        const { g } = mockCtx();
        const [W, H] = sizeOf(r);
        drawGraphic(g, input(t, r, "look.regional", long), W, H, 2.5, 6);
      }
    }
  } finally {
    const w = stop();
    assert.deepEqual(w, [], w.join("\n"));
  }
});
