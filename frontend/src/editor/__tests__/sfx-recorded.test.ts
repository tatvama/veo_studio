/**
 * The recorded sound effects (Kenney CC0, docs/EDITOR.md §15): the bundled files against the manifest (exists, SHA-256,
 * size, the 30 MB budget, nothing else in the folder), tags and categories (the procedural catalogue untouched), the
 * levelling gains, NOTICE.md, media (the file copied into the edit as it is, clip gain = gainDb), add_sfx and the auto
 * SFX source option. Portable paths (the repo's own folder, no fixed drive).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { addLibrarySfx, catalogRows, pickSfx } from "../../automation/bridge/catalog.ts";
import { buildAutoSfx } from "../autosfx/build.ts";
import { catalogFor, planAutoSfx, recordedCatalog } from "../autosfx/planner.ts";
import type { CatalogPreset } from "../autosfx/types.ts";
import type { EditorHost, EditProject, MediaItem } from "../model/types.ts";
import {
  isRecordedId, placeSfx, prepareSfxMedia, RECORDED_CATEGORIES, RECORDED_COLLECTIONS, RECORDED_MAX_FILE_BYTES, RECORDED_MAX_TOTAL_BYTES, RECORDED_MAX_TRUE_PEAK,
  RECORDED_PACKS, RECORDED_SFX, RECORDED_TARGET_LUFS, recordedFileName, recordedGain, recordedSfx, recordedUrl, SFX_CATEGORIES, sfxClipFrames, SFX_PRESETS,
  SFX_TAGS,
} from "../sfx/index.ts";
import { CATALOG, qaEdit } from "./autosfx-fixtures.ts";
import { project } from "./fixtures.ts";

const PUBLIC = path.resolve(import.meta.dirname, "..", "..", "..", "public");
const DIR = path.join(PUBLIC, "sfx", "recorded");
const fileOf = (r: { pack: string; file: string }) => path.join(DIR, r.pack, r.file);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ── the bundle ───────────────────────────────────────────────────────────────

test("every manifest file is bundled, matches its SHA-256 and size, and is under 1 MB", () => {
  assert.ok(RECORDED_SFX.length >= 300, `${RECORDED_SFX.length} recorded sounds`);
  for (const r of RECORDED_SFX) {
    const f = fileOf(r);
    assert.ok(existsSync(f), `${r.id}: ${f}`);
    const b = readFileSync(f);
    assert.equal(b.byteLength, r.bytes, `${r.id}: size`);
    assert.ok(b.byteLength <= RECORDED_MAX_FILE_BYTES, `${r.id}: ${b.byteLength} bytes`);
    assert.equal(sha(b), r.sha256, `${r.id}: SHA-256`);
    assert.equal(b.subarray(0, 4).toString("latin1"), "OggS", `${r.id}: an Ogg file`);
  }
});

test("ids, file names and packs: rec.<pack>.<file>, safe lower-case names, unique, counted per pack", () => {
  const ids = new Set<string>();
  for (const r of RECORDED_SFX) {
    assert.match(r.file, /^[a-z0-9][a-z0-9_.-]*\.(ogg|wav|mp3)$/, r.file);
    assert.equal(r.id, `rec.${r.pack}.${r.file.replace(/\.[a-z0-9]+$/, "")}`);
    assert.ok(isRecordedId(r.id) && !ids.has(r.id), r.id);
    ids.add(r.id);
    assert.equal(recordedSfx(r.id), r);
    assert.equal(recordedUrl(r), `/sfx/recorded/${r.pack}/${r.file}`);
    assert.match(recordedFileName(r), /^rec\.[a-z]+\.[a-z0-9_]+\.ogg$/);
    assert.ok(r.name.trim() && r.duration > 0 && r.duration < 30 && [1, 2].includes(r.channels) && r.sampleRate >= 8000, r.id);
  }
  assert.equal(new Set(RECORDED_SFX.map((r) => r.sha256)).size, RECORDED_SFX.length, "no two files are the same audio");
  for (const p of RECORDED_PACKS) assert.equal(RECORDED_SFX.filter((r) => r.pack === p.id).length, p.files, p.id);
  assert.ok(!SFX_PRESETS.some((p) => isRecordedId(p.id)), "no procedural id looks recorded");
});

test("tags come from SFX_TAGS; categories are the procedural ones or recorded-only collections; the procedural catalogue is unchanged", () => {
  const procedural = new Set<string>(SFX_CATEGORIES.map((c) => c.id));
  const collections = new Set<string>(RECORDED_COLLECTIONS.map((c) => c.id));
  for (const r of RECORDED_SFX) {
    for (const t of r.tags) assert.ok((SFX_TAGS as readonly string[]).includes(t), `${r.id}: tag ${t}`);
    assert.ok(procedural.has(r.category) || collections.has(r.category), `${r.id}: ${r.category}`);
  }
  for (const c of collections) assert.ok(!procedural.has(c), `${c} is recorded-only`);
  assert.equal(SFX_CATEGORIES.length, 20);
  assert.ok(SFX_PRESETS.every((p) => procedural.has(p.category)));
  assert.deepEqual(RECORDED_CATEGORIES.map((c) => c.id).filter((c) => !RECORDED_SFX.some((r) => r.category === c)), [], "only categories with sounds");
  // the auto SFX rules find recorded sounds for impacts, booms, pops, clicks, ticks, dings and glitches
  for (const t of ["impact", "hit", "boom", "pop", "click", "tick", "ding", "glitch"]) assert.ok(RECORDED_SFX.some((r) => (r.tags as string[]).includes(t)), `a recording tagged ${t}`);
});

test("levelling: gains within ±24 dB, never over −16 LUFS, and the projected true peak ≤ −1 dBTP", () => {
  for (const r of RECORDED_SFX) {
    assert.ok(Math.abs(r.gainDb) <= 24, `${r.id}: ${r.gainDb} dB`);
    assert.equal(Math.round(r.gainDb * 10) / 10, r.gainDb, `${r.id}: tenths of a dB`);
    assert.ok(r.truePeak + r.gainDb <= RECORDED_MAX_TRUE_PEAK + 1e-9, `${r.id}: ${r.truePeak} + ${r.gainDb} dBTP`);
    assert.ok(r.lufs + r.gainDb <= RECORDED_TARGET_LUFS + 1e-9, `${r.id}: ${r.lufs} + ${r.gainDb} LUFS`);
    // either it reaches −16 LUFS, or the true peak (or the ±24 dB cap) stopped it
    const reached = r.lufs + r.gainDb >= RECORDED_TARGET_LUFS - 0.11, peakCapped = r.truePeak + r.gainDb >= RECORDED_MAX_TRUE_PEAK - 0.11;
    assert.ok(reached || peakCapped || r.gainDb === 24, `${r.id}: ${r.lufs} LUFS, ${r.truePeak} dBTP, ${r.gainDb} dB`);
  }
  assert.equal(recordedGain({ gainDb: 2.5 }, -6), -3.5);
});

test("NOTICE.md lists every pack with its source, CC0 licence, ZIP SHA-256, size and file count, and credits Kenney", () => {
  const notice = readFileSync(path.join(DIR, "NOTICE.md"), "utf8");
  assert.match(notice, /CC0 1\.0/);
  assert.ok(notice.includes("https://creativecommons.org/publicdomain/zero/1.0/"), "links the CC0 deed");
  assert.match(notice, /Kenney/);
  for (const p of RECORDED_PACKS) {
    const at = notice.indexOf(`## ${p.label} (\`${p.id}/\`)`);
    assert.ok(at >= 0, `a section for ${p.label}`);
    const sec = notice.slice(at, notice.indexOf("\n## ", at + 1) < 0 ? undefined : notice.indexOf("\n## ", at + 1));
    for (const want of [p.url, p.zipSha256, `${p.zipBytes} bytes`, `Files bundled: ${p.files}`, "CC0 1.0", "Creative Commons Zero, CC0"]) assert.ok(sec.includes(want), `${p.id}: ${want}`);
    assert.equal(p.licence, "CC0-1.0");
  }
});

test("the folder: at most 30 MB, only the packs' audio and NOTICE.md", () => {
  let total = 0;
  const packs = new Set<string>(RECORDED_PACKS.map((p) => p.id));
  const listed = new Set(RECORDED_SFX.map((r) => `${r.pack}/${r.file}`));
  for (const e of readdirSync(DIR, { withFileTypes: true })) {
    if (e.isFile()) { assert.equal(e.name, "NOTICE.md"); total += statSync(path.join(DIR, e.name)).size; continue; }
    assert.ok(e.isDirectory() && packs.has(e.name), e.name);
    for (const f of readdirSync(path.join(DIR, e.name))) {
      assert.ok(listed.has(`${e.name}/${f}`), `${e.name}/${f} is in the manifest`);
      total += statSync(path.join(DIR, e.name, f)).size;
    }
  }
  assert.ok(total <= RECORDED_MAX_TOTAL_BYTES, `${(total / 1e6).toFixed(1)} MB`);
  assert.equal(RECORDED_MAX_TOTAL_BYTES, 30 * 1024 * 1024);
});

// ── media and add_sfx ────────────────────────────────────────────────────────

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

const SOFT = RECORDED_SFX.find((r) => r.id === "rec.impact.impactsoft_heavy_000") ?? RECORDED_SFX.find((r) => r.tags.length)!;

test("media in a browser: the bundled file's public URL as it is, its length and channels from the manifest", async () => {
  const f = fakeHost(project());
  const m = await prepareSfxMedia(f.host, SOFT.id);
  assert.equal(m.url, recordedUrl(SOFT));
  assert.equal(m.kind, "audio");
  assert.equal(m.fps, SOFT.sampleRate);
  assert.equal(m.duration, Math.round(SOFT.duration * SOFT.sampleRate));
  assert.equal(m.audioChannels, SOFT.channels);
  assert.match(m.comment ?? "", /Kenney.*CC0 1\.0/);
  assert.equal(await prepareSfxMedia(f.host, SOFT.id), m, "the same item again");
  await assert.rejects(prepareSfxMedia(f.host, "rec.impact.nope"), /No recorded sound effect/);
});

test("media on the desktop: the file copied into Audio\\SFX as <id>.ogg through writeGeneratedMedia, checked, and the clip gain = gainDb", async () => {
  const calls: { path: string; name: string; bytes: Uint8Array; kind: string }[] = [];
  const g = globalThis as { tatvamDesktop?: unknown; fetch: typeof fetch };
  const realFetch = g.fetch;
  g.tatvamDesktop = {
    editor: {
      async writeGeneratedMedia(p: string, name: string, bytes: Uint8Array, kind: string): Promise<MediaItem> {
        calls.push({ path: p, name, bytes, kind });
        return { id: `m_${calls.length}`, binId: null, name, kind: "audio", path: `D:/Edits/E/Audio/SFX/${name}`, url: `/__media/x/${name}`, duration: 1, fps: 44100,
          width: 0, height: 0, hasAudio: true, markers: [] };
      },
    },
  };
  // the default loader fetches the public URL: answered from the bundled folder
  const fetched: string[] = [];
  g.fetch = (async (u: string) => {
    fetched.push(u);
    const f = path.join(PUBLIC, ...u.split("/").filter(Boolean));
    return existsSync(f) ? new Response(readFileSync(f)) : new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    const f = fakeHost(project(), "D:/Edits/E/E.tatvamedit");
    const item = await prepareSfxMedia(f.host, SOFT.id);
    assert.deepEqual(fetched, [recordedUrl(SOFT)]);
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].path, calls[0].name, calls[0].kind], ["D:/Edits/E/E.tatvamedit", recordedFileName(SOFT), "audio"]);
    assert.equal(sha(calls[0].bytes), SOFT.sha256, "the file as it is");
    assert.equal(item.name, SOFT.name);
    const clip = placeSfx(f.host, item, { at: 25, gainDb: SOFT.gainDb, name: SOFT.name, whole: true });
    const c = f.get().sequences[0].clips.find((x) => x.id === clip)!;
    assert.equal(c.audio?.gain.value, SOFT.gainDb);
    // the whole recording: its length rounded UP to frames (44.1 kHz samples of the probed item)
    const m = { ...item, duration: Math.round(SOFT.duration * 44100), fps: 44100 };
    assert.equal(sfxClipFrames(m, 25, true), Math.ceil(SOFT.duration * 25 - 1e-6));
    assert.equal(sfxClipFrames(m, 25, false), Math.round(SOFT.duration * 25));
    await prepareSfxMedia(f.host, SOFT.id);
    assert.equal(calls.length, 1, "copied once");
    // a file that isn't the manifest's is refused
    const other = RECORDED_SFX.find((r) => r.id !== SOFT.id && r.pack === SOFT.pack)!;
    g.fetch = (async () => new Response(readFileSync(fileOf(SOFT)))) as unknown as typeof fetch;
    await assert.rejects(prepareSfxMedia(fakeHost(project(), "D:/Edits/F/F.tatvamedit").host, other.id), /bundled file/);
  } finally { delete g.tatvamDesktop; g.fetch = realFetch; }
});

test("add_sfx: a recorded id, or a tag from the recordings; the clip gain is gainDb plus gain_db", async () => {
  const p = pickSfx(SOFT.id);
  assert.deepEqual([p.preset.id, p.seed, p.among, p.recorded?.id], [SOFT.id, 1, 1, SOFT.id]);
  assert.throws(() => pickSfx("rec.impact.nope"), /No recorded sound effect/);
  const gen = pickSfx(undefined, "impact");
  assert.ok(!gen.recorded, "a tag picks a generated sound by default");
  const rec = pickSfx(undefined, "impact", 3, "recorded");
  assert.ok(rec.recorded && rec.preset.tags.includes("impact"));
  const tagged = RECORDED_SFX.filter((r) => (r.tags as string[]).includes("impact"));
  assert.equal(rec.among, tagged.length);
  assert.equal(rec.preset.id, tagged[3 % tagged.length].id);
  const both = pickSfx(undefined, "impact", undefined, "both");
  assert.equal(both.among, SFX_PRESETS.filter((x) => x.tags.includes("impact")).length + tagged.length);
  assert.throws(() => pickSfx(undefined, "whoosh", undefined, "recorded"), /No recorded sound has the tag whoosh/);
  // recorded rows in list_catalog, found by "recorded"
  const rows = catalogRows("sfx", "recorded");
  assert.equal(rows.length, RECORDED_SFX.length);
  assert.ok(rows.every((r) => r.id.startsWith("rec.") && /Kenney CC0/.test(r.group ?? "")));

  let pr: EditProject = project();
  const host = { ...fakeHost(pr).host, project: () => pr, sequence: () => pr.sequences[0],
    apply(_l: string, mutate: (d: EditProject) => void) { const d = structuredClone(pr); mutate(d); pr = d; } } as EditorHost;
  const r = await addLibrarySfx(host, { preset: SOFT.id, at: 40, gainDb: -6, label: "Assistant: add_sfx" });
  const c = pr.sequences[0].clips.find((x) => x.id === r.clipId)!;
  assert.equal(c.audio?.gain.value, Math.round((SOFT.gainDb - 6) * 10) / 10);
  assert.equal(r.gainDb, c.audio?.gain.value);
  assert.equal(c.role, "sfx");
});

// ── auto SFX: the sound source ───────────────────────────────────────────────

/** Recorded stand-ins: the same names and tags as fixture sounds (so they tie with them), each with its own level. */
const REC: CatalogPreset[] = [
  { id: "rec.t.impact", name: "Soft thud", tags: ["impact", "hit"], duration: 1.2, params: [], recorded: true, gainDb: -2 },
  { id: "rec.t.boom", name: "Deep boom", tags: ["impact", "boom"], duration: 2.5, params: [], recorded: true, gainDb: 1.5 },
  { id: "rec.t.pop", name: "Pop", tags: ["pop"], duration: 0.25, params: [], recorded: true, gainDb: 3 },
  { id: "rec.t.click", name: "Click", tags: ["click"], duration: 0.08, params: [], recorded: true, gainDb: 0.5 },
  { id: "rec.t.tick", name: "Tick", tags: ["tick"], duration: 0.1, params: [], recorded: true, gainDb: -1 },
];
const LIB = [...CATALOG, ...REC];
const recIn = (ids: string[]) => ids.filter((x) => x.startsWith("rec."));

test("auto SFX source: generated only, recorded only, or both (the default, recordings join the candidates)", () => {
  const f = qaEdit();
  const s = f.sequences[0];
  const gen = planAutoSfx(s, f, { catalog: LIB, source: "generated" });
  const rec = planAutoSfx(s, f, { catalog: LIB, source: "recorded" });
  const both = planAutoSfx(s, f, { catalog: LIB });
  assert.deepEqual([gen.source, rec.source, both.source], ["generated", "recorded", "both"]);
  assert.equal(recIn(gen.placements.map((p) => p.presetId)).length, 0);
  assert.ok(rec.placements.length > 0 && rec.placements.every((p) => p.presetId.startsWith("rec.")), "recorded only");
  // no recorded whoosh: those parts are left out, saying why
  assert.ok(rec.skipped.some((x) => /No recorded sound is tagged whoosh/.test(x.reason)), rec.skipped.map((x) => x.reason).join("; "));
  assert.ok(!gen.skipped.some((x) => /No (generated|recorded) sound/.test(x.reason)));
  // both: some of each, and only where a recording fits the part's tags
  const ids = both.placements.map((p) => p.presetId);
  assert.ok(recIn(ids).length > 0 && ids.some((x) => !x.startsWith("rec.")), ids.join(", "));
  assert.deepEqual(planAutoSfx(s, f, { catalog: LIB }), both, "deterministic");
  assert.deepEqual(planAutoSfx(s, f, { catalog: LIB, source: "both" }), both);
  // the library given as it is (no recordings in it): "both" plans exactly what "generated" does
  assert.deepEqual(planAutoSfx(s, f, { catalog: CATALOG }).placements, planAutoSfx(s, f, { catalog: CATALOG, source: "generated" }).placements);
});

test("auto SFX recorded: one take (seed 1), the clip gain raised or lowered by the recording's own gainDb", () => {
  const f = qaEdit();
  const s = f.sequences[0];
  const gen = planAutoSfx(s, f, { catalog: LIB, source: "generated" });
  const rec = planAutoSfx(s, f, { catalog: LIB, source: "recorded" });
  let compared = 0;
  for (const p of rec.placements) {
    assert.equal(p.seed, 1, p.id);
    const r = REC.find((x) => x.id === p.presetId)!;
    const g = gen.placements.find((x) => x.id === p.id);
    if (!g) continue;
    assert.equal(p.gainDb, Math.round(Math.max(-48, Math.min(6, g.gainDb + r.gainDb!)) * 10) / 10, `${p.id}: ${g.gainDb} + ${r.gainDb}`);
    compared++;
  }
  assert.ok(compared >= 3, `${compared} placements compared`);
  assert.deepEqual(catalogFor(LIB, "recorded").map((x) => x.id), REC.map((x) => x.id));
  assert.deepEqual(catalogFor(LIB, "generated"), CATALOG);
});

test("auto SFX recorded: a short recording plays to its end (its clip rounded up to whole frames)", () => {
  const f = qaEdit();
  const s = f.sequences[0];
  const plan = planAutoSfx(s, f, { catalog: LIB, source: "recorded" });
  const ticks = plan.placements.filter((p) => p.presetId === "rec.t.tick");
  assert.ok(ticks.length >= 2, `${ticks.length} ticks`);
  // a 55 ms tick at 44.1 kHz is 1.38 frames at 25 fps: 2 frames, not 1
  const media = (p: { presetId: string }): MediaItem => ({ id: `m_${p.presetId}`, binId: null, name: p.presetId, kind: "audio", path: `/e/Audio/SFX/${p.presetId}.ogg`,
    duration: p.presetId === "rec.t.tick" ? 2430 : 44100, fps: 44100, width: 0, height: 0, hasAudio: true, markers: [] });
  const proj: EditProject = { ...f, media: [...f.media, ...new Map(plan.placements.map((p) => [p.presetId, media(p)])).values()] };
  const r = buildAutoSfx(proj, plan, media);
  const out = r.project.sequences[0].clips.filter((c) => c.autoSfx && c.name.includes("Tick"));
  assert.equal(out.length, ticks.length);
  for (const c of out) assert.equal(c.duration, 2, c.name);
});

test("auto SFX on the real library: the recordings are in the default catalogue with their tags and gains", () => {
  const cat = recordedCatalog();
  assert.equal(cat.length, RECORDED_SFX.length);
  for (const c of cat) {
    const r = recordedSfx(c.id)!;
    assert.deepEqual([c.recorded, c.gainDb, c.duration, c.params.length], [true, r.gainDb, r.duration, 0]);
  }
  const f = qaEdit();
  const pl = planAutoSfx(f.sequences[0], f, { source: "recorded" });
  assert.ok(pl.placements.length >= 4, `${pl.placements.length} recorded sounds`);
  for (const p of pl.placements) {
    const r = recordedSfx(p.presetId);
    assert.ok(r, p.presetId);
    assert.ok(r.tags.length > 0, `${p.presetId} has tags`);
  }
});
