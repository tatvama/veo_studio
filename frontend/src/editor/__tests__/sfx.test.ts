/**
 * The SFX engine (docs/EDITOR.md §15.1): the catalogue (counts per category, params, tags), parameters at their
 * extremes, determinism (sample hashes), the loudness reading, the WAV writer, and the media helpers (render → save →
 * one bin, one undo step per placement on an SFX track). Every preset at its defaults is checked in sfx-render.test.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { EditorHost, EditProject, MediaItem } from "../model/types.ts";
import {
  addSfxMedia, decodeWav, encodeWav, placeSfx, prepareSfxMedia, renderSfx, resolveValues, SFX_CATEGORIES, SFX_PRESETS, SFX_TAGS, sfxFileName, sfxKey, sfxLoudness,
  sfxSeconds, sfxTruePeak,
} from "../sfx/index.ts";
import { project } from "./fixtures.ts";

const SR = 48000;
const COUNTS: Record<string, number> = {
  whoosh: 14, riser: 8, downlifter: 6, impact: 12, sub_drop: 5, braam: 5, hit: 10, pop: 8, ui: 12, typing: 5, camera: 4, bell: 6, glitch: 10, tape: 5,
  reverse: 4, tick: 6, cash: 3, heartbeat: 2, ambience: 8, crowd: 3,
};
const hashOf = (ch: Float32Array[]) => { const h = createHash("sha256"); for (const c of ch) h.update(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)); return h.digest("hex").slice(0, 16); };

// ── the catalogue ───────────────────────────────────────────────────────────────────────────────────────

test("catalogue: 20 categories with their counts, unique stable ids, 3–6 params with defaults in range", () => {
  assert.equal(SFX_CATEGORIES.length, 20);
  assert.deepEqual(SFX_CATEGORIES.map((c) => c.id).sort(), Object.keys(COUNTS).sort());
  for (const c of SFX_CATEGORIES) {
    assert.ok(c.label.length > 2);
    assert.equal(SFX_PRESETS.filter((p) => p.category === c.id).length, COUNTS[c.id], `${c.label} has ${COUNTS[c.id]} presets`);
  }
  assert.equal(SFX_PRESETS.length, Object.values(COUNTS).reduce((a, b) => a + b, 0));
  const ids = SFX_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  assert.equal(new Set(SFX_PRESETS.map((p) => p.name)).size, ids.length, "names are unique");
  for (const p of SFX_PRESETS) {
    assert.match(p.id, /^[a-z]+\.[a-z0-9_]+$/, p.id);
    assert.ok(p.params.length >= 3 && p.params.length <= 6, `${p.id}: ${p.params.length} params`);
    assert.equal(new Set(p.params.map((x) => x.name)).size, p.params.length, `${p.id}: param names unique`);
    for (const x of p.params) {
      assert.ok(x.min < x.max && x.default >= x.min && x.default <= x.max, `${p.id}.${x.name} default in range`);
      assert.ok(x.label.length > 0);
    }
    assert.ok(p.duration >= 0.5 || p.loop, `${p.id} lasts at least a loudness block`);
    assert.equal(p.duration, Math.round(sfxSeconds(p.id) * 1000) / 1000);
  }
});

test("tags: every tag is one auto SFX knows, no repeats, and every rule's tag has sounds", () => {
  const known = new Set<string>(SFX_TAGS);
  for (const p of SFX_PRESETS) {
    assert.equal(new Set(p.tags).size, p.tags.length, `${p.id}: no repeated tags`);
    for (const t of p.tags) assert.ok(known.has(t), `${p.id}: "${t}" is a known tag`);
  }
  for (const t of SFX_TAGS) assert.ok(SFX_PRESETS.some((p) => p.tags.includes(t)), `some preset is tagged ${t}`);
  // the obvious homes for the tags: every preset of these categories carries one of them
  const homes: Record<string, string[]> = {
    whoosh: ["whoosh", "swish"], riser: ["riser"], downlifter: ["downlifter"], impact: ["impact", "boom"], sub_drop: ["sub_drop"], braam: ["braam"], hit: ["hit"],
    pop: ["pop"], typing: ["typing"], bell: ["ding"], glitch: ["glitch", "static"], reverse: ["reverse"], tick: ["tick", "countdown"], cash: ["cash"], heartbeat: ["heartbeat"],
  };
  for (const [cat, any] of Object.entries(homes)) for (const p of SFX_PRESETS.filter((x) => x.category === cat)) assert.ok(any.some((t) => p.tags.includes(t)), `${p.id} is tagged ${any.join(" or ")}`);
});

test("parameters change the sound and stay in range; extremes render cleanly", () => {
  const ids = ["whoosh.fast", "impact.punch", "riser.short", "typing.burst", "amb.rain", "ui.click", "tick.tock_loop", "glitch.burst", "hit.clap"];
  for (const id of ids) {
    const p = SFX_PRESETS.find((x) => x.id === id)!;
    const base = hashOf(renderSfx(id, {}, 1));
    for (const x of p.params) {
      for (const val of [x.min, x.name === "length" ? Math.min(x.max, x.default * 2) : x.max]) {
        const v = { [x.name]: val };
        const ch = renderSfx(id, v, 1);
        for (const c of ch) for (let j = 0; j < c.length; j += 13) assert.ok(Number.isFinite(c[j]), `${id} ${x.name}=${val}`);
        assert.ok(sfxTruePeak(ch) <= -1, `${id} ${x.name}=${val} peak`);
        assert.equal(ch[0].length, Math.round(sfxSeconds(id, v) * SR), `${id} ${x.name}=${val} length`);
        if (val !== x.default) assert.notEqual(hashOf(ch), base, `${id}: ${x.name} = ${val} changes the sound`);
      }
    }
  }
  assert.deepEqual(resolveValues("whoosh.fast", { length: 99, pitch: -40, nope: 3 }), { length: 1.5, pitch: -12, brightness: 0.55, width: 0.7, tail: 0.15 });
  assert.throws(() => renderSfx("no.such"), /No sound effect/);
});

// ── determinism ─────────────────────────────────────────────────────────────────────────────────────────

/** Sample hashes of ten presets at their defaults, seed 1: the same everywhere (bump SFX_ENGINE_VERSION and these
 *  together when a change to the engine changes the sound on purpose). */
const GOLDEN: Record<string, string> = {
  "whoosh.air_soft": "236f56e5668d3598",
  "riser.shepard": "981c661d1c44aef1",
  "impact.cinematic": "f29f060879e65882",
  "subdrop.808": "ede6fb2a92ae544b",
  "braam.classic": "4fcb76c37e63842e",
  "ui.notification": "3459304f3ce4587e",
  "typing.burst": "d1ea4736faf71093",
  "glitch.burst": "879df51d0b3a64bd",
  "amb.rain": "d1497e2e24e24551",
  "crowd.applause": "1f08799239081c45",
};

test("determinism: the same preset, values and seed give the same samples; a new seed a new take", () => {
  for (const [id, want] of Object.entries(GOLDEN)) {
    const a = hashOf(renderSfx(id, {}, 1)), b = hashOf(renderSfx(id, {}, 1));
    assert.equal(a, b, `${id} renders the same twice`);
    if (want) assert.equal(a, want, `${id} renders the known samples`);
    assert.notEqual(hashOf(renderSfx(id, {}, 2)), a, `${id}: seed 2 is a different take`);
  }
  assert.equal(sfxKey("whoosh.fast", {}, 1), sfxKey("whoosh.fast", { length: 0.38 }, 1), "defaults key the same as explicit defaults");
  assert.notEqual(sfxKey("whoosh.fast", {}, 1), sfxKey("whoosh.fast", {}, 2));
  assert.notEqual(sfxKey("whoosh.fast", {}, 1), sfxKey("whoosh.fast", { pitch: 1 }, 1));
  assert.match(sfxKey("whoosh.fast"), /^[0-9a-f]{14}$/);
});

test("sfxLoudness: BS.1770 levels (a −23 dBFS 1 kHz stereo sine reads −23 LUFS; short sounds count as one block)", () => {
  const n = SR * 5, amp = Math.pow(10, -23 / 20);
  const s = Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 1000 * i) / SR));
  assert.ok(Math.abs(sfxLoudness([s, s], SR) + 23) < 0.05, `${sfxLoudness([s, s], SR)}`);
  // 0.1 s of it measures as 400 ms with 300 ms of silence: 10·log10(1/4) lower
  const short = s.slice(0, SR / 10);
  assert.ok(Math.abs(sfxLoudness([short, short], SR) - (-23 + 10 * Math.log10(0.25))) < 0.1);
  assert.equal(sfxLoudness([new Float32Array(SR)], SR), -Infinity);
});

// ── WAV ─────────────────────────────────────────────────────────────────────────────────────────────────

test("encodeWav: a 24-bit PCM header that's right, samples that read back, mono and stereo", () => {
  const L = Float32Array.from([0, 0.5, -0.5, 1, -1, 1.7, -3, 0.25, Number.NaN]), R = L.map((x) => -x);
  const b = encodeWav([L, R], 48000);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = (o: number) => String.fromCharCode(...b.slice(o, o + 4));
  const data = 9 * 2 * 3;
  assert.equal(tag(0), "RIFF"); assert.equal(v.getUint32(4, true), 36 + data); assert.equal(tag(8), "WAVE");
  assert.equal(tag(12), "fmt "); assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1, "PCM"); assert.equal(v.getUint16(22, true), 2, "stereo");
  assert.equal(v.getUint32(24, true), 48000); assert.equal(v.getUint32(28, true), 48000 * 6, "byte rate"); assert.equal(v.getUint16(32, true), 6, "block align");
  assert.equal(v.getUint16(34, true), 24, "24-bit"); assert.equal(tag(36), "data"); assert.equal(v.getUint32(40, true), data);
  assert.equal(b.length, 44 + data);
  const r = decodeWav(b);
  assert.deepEqual([r.format, r.channels, r.sampleRate, r.bits, r.frames], [1, 2, 48000, 24, 9]);
  const want = [0, 0.5, -0.5, 1, -1, 1, -1, 0.25, 0];
  want.forEach((x, i) => { assert.ok(Math.abs(r.data[0][i] - x) < 2e-7, `L[${i}]`); assert.ok(Math.abs(r.data[1][i] + x) < 2e-7, `R[${i}]`); });
  // mono, an odd data size gets its pad byte
  const m = encodeWav([Float32Array.from([0.1, 0.2, 0.3])], 44100);
  assert.equal(new DataView(m.buffer).getUint16(22, true), 1);
  assert.equal(new DataView(m.buffer).getUint32(40, true), 9);
  assert.equal(m.length, 44 + 9 + 1);
  assert.equal(decodeWav(m).frames, 3);
  assert.throws(() => encodeWav([L, R, L], 48000), /mono or stereo/);
  // a real sound
  const ch = renderSfx("ui.click", {}, 3), w = decodeWav(encodeWav(ch, SR));
  assert.equal(w.frames, ch[0].length);
  assert.ok(Math.abs(sfxLoudness(w.data, SR) + 16) < 0.5);
});

// ── media: render → save → the edit ─────────────────────────────────────────────────────────────────────

function fakeHost(p0: EditProject, path = "") {
  let p = p0;
  const labels: string[] = [];
  const host: EditorHost = {
    project: () => p, sequence: () => p.sequences.find((s) => s.id === p.activeSequenceId)!, selection: () => ({ clipIds: [], trackIds: [] }),
    playhead: () => 50, inOut: () => ({}),
    apply(label, mutate) { const d = structuredClone(p); mutate(d); p = d; labels.push(label); },
    addMedia() { throw new Error("not used"); }, placeClip() { throw new Error("not used"); }, addTitleTrack() { throw new Error("not used"); },
    path: () => path, studioProjectId: () => null, setStudioProjectId() {}, toast() {},
  };
  return { host, labels, get: () => p };
}

test("media in a browser: rendered once, an in-memory WAV, one 'Sound effects' bin, deduped", async () => {
  const f = fakeHost(project());
  const a = await addSfxMedia(f.host, "pop.bubble", {}, 1);
  assert.equal(a.kind, "audio");
  assert.match(a.path, /^memory:sfx\/[0-9a-f]{14}\/pop\.bubble_1\.wav$/);
  assert.ok(a.url?.startsWith("blob:"));
  assert.equal(a.fps, 48000);
  assert.equal(a.duration, Math.round(sfxSeconds("pop.bubble") * 48000));
  assert.equal(a.peaks?.length, 200);
  const again = await addSfxMedia(f.host, "pop.bubble", {}, 1);
  assert.equal(again.id, a.id, "the same sound is the same media");
  const other = await addSfxMedia(f.host, "pop.bubble", {}, 2);
  assert.notEqual(other.id, a.id);
  const p = f.get();
  const bins = p.bins.filter((b) => b.name === "Sound effects");
  assert.equal(bins.length, 1);
  assert.equal(p.media.filter((m) => m.binId === bins[0].id).length, 2);
  assert.deepEqual(f.labels, ["Add sound effect Bubble", "Add sound effect Bubble #2"]);
});

test("media on the desktop: writeGeneratedMedia gets <preset>_<seed>.wav as a 24-bit WAV, once per sound", async () => {
  const calls: { path: string; name: string; bytes: Uint8Array; kind: string }[] = [];
  const g = globalThis as { tatvamDesktop?: unknown };
  g.tatvamDesktop = {
    editor: {
      async writeGeneratedMedia(path: string, name: string, bytes: Uint8Array, kind: string): Promise<MediaItem> {
        calls.push({ path, name, bytes, kind });
        return { id: `m_${calls.length}`, binId: null, name, kind: "audio", path: `D:/Edits/E/Audio/SFX/${name}`, url: `/__media/x${calls.length}/${name}`, duration: 1, fps: 48000,
          width: 0, height: 0, hasAudio: true, markers: [] };
      },
    },
  };
  try {
    const f = fakeHost(project(), "D:/Edits/E/E.tatvamedit");
    const item = await addSfxMedia(f.host, "impact.thud", { pitch: -2 }, 7);
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].path, calls[0].name, calls[0].kind], ["D:/Edits/E/E.tatvamedit", sfxFileName("impact.thud", 7), "audio"]);
    assert.equal(calls[0].name, "impact.thud_7.wav");
    const w = decodeWav(calls[0].bytes);
    assert.deepEqual([w.format, w.bits, w.channels, w.sampleRate], [1, 24, 2, 48000]);
    assert.equal(item.name, "Thud #7 (custom)");
    assert.match(item.comment ?? "", /impact\.thud, seed 7/);
    await addSfxMedia(f.host, "impact.thud", { pitch: -2 }, 7);
    assert.equal(calls.length, 1, "made once");
    assert.equal(f.get().media.filter((m) => m.path.endsWith("impact.thud_7.wav")).length, 1);
  } finally { delete g.tatvamDesktop; }
});

test("placeSfx: one undo step adds the media, an SFX track (role sfx) and the clip; overlaps go to SFX 2", async () => {
  const f = fakeHost(project());
  const item = await prepareSfxMedia(f.host, "whoosh.fast", {}, 1);
  assert.equal(f.get().media.some((m) => m.path === item.path), false, "prepare doesn't touch the project");
  const id = placeSfx(f.host, item, { at: 50, name: "Fast whoosh" });
  assert.deepEqual(f.labels, ["Add sound effect Fast whoosh"]);
  let s = f.get().sequences[0];
  const sfx = s.tracks.filter((t) => t.role === "sfx");
  assert.equal(sfx.length, 1);
  assert.equal(sfx[0].name, "SFX");
  const c = s.clips.find((x) => x.id === id)!;
  assert.equal(c.trackId, sfx[0].id);
  assert.equal(c.start, 50);
  assert.equal(c.role, "sfx");
  assert.equal(c.duration, Math.round(sfxSeconds("whoosh.fast") * 25));
  assert.equal(f.get().bins.filter((b) => b.name === "Sound effects").length, 1);
  // the same moment again: a second SFX track; later: back on the first; a gain
  const id2 = placeSfx(f.host, item, { at: 55 });
  const id3 = placeSfx(f.host, item, { at: 400, gainDb: -6.04 });
  s = f.get().sequences[0];
  const tracks = s.tracks.filter((t) => t.role === "sfx");
  assert.deepEqual(tracks.map((t) => t.name).sort(), ["SFX", "SFX 2"]);
  assert.equal(s.clips.find((x) => x.id === id2)!.trackId, tracks.find((t) => t.name === "SFX 2")!.id);
  assert.equal(s.clips.find((x) => x.id === id3)!.trackId, sfx[0].id);
  assert.equal(s.clips.find((x) => x.id === id3)!.audio?.gain.value, -6);
  assert.equal(f.get().media.filter((m) => m.path === item.path).length, 1, "one media item for all three");
  assert.equal(f.labels.length, 3, "one undo step each");
});
