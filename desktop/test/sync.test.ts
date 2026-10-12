import assert from "node:assert/strict";
import { test } from "node:test";
import { Mirror } from "../src/main/mirror.ts";
import { DEFAULT_TEMPLATES } from "../src/main/naming.ts";
import { desiredPaths, type Manifest, type ManifestItem } from "../src/main/sync.ts";

function take(id: number, over: Partial<ManifestItem> = {}): ManifestItem {
  return { key: `projects/1/shots/${id}/video/${id}abc.mp4`, url: `/media/projects/1/shots/${id}/video/${id}abc.mp4`, folder: "Takes", kind: "video", role: "take",
    episode_id: 3, shot_id: id, take_id: 70 + id, language: null, ext: "mp4", label: `Video take ${id}`, updated_at: "2026-10-10T12:00:00Z",
    series: { season: 1, episode: 2, scene: 1, shot: id, cut: id, take: 1, version: 1, code: `E02-SH0${id}` }, ...over };
}

const manifest: Manifest = {
  project: { id: 1, title: "Kaali: Return", aspect: "9:16", languages: ["kn", "en"], primary_language: "kn" },
  episodes: [{ id: 3, number: 2, season: 1, title: "Ep", shots: [] }],
  items: [
    take(2), take(1),
    take(1, { key: "projects/1/shots/1/lipsync/kn1.mp4", kind: "lipsync", language: "kn", take_id: 91 }),
    { ...take(1), key: "projects/1/shots/1/voice/v1.wav", folder: "Audio/Voice", kind: "voice", language: "en", ext: "wav" },
    { ...take(1), key: "projects/1/audio/m1.mp3", folder: "Audio/Music", kind: "music", role: "music", ext: "mp3", series: { season: 1, episode: 2 } },
    { ...take(1), key: "projects/1/audio/m2.mp3", folder: "Audio/Music", kind: "music", role: "music", ext: "mp3", series: { season: 1, episode: 2 } },
    { ...take(1), key: "projects/1/exports/e02.mp4", folder: "Renders", kind: "render", role: "render", language: "kn", preset: "shorts", series: { season: 1, episode: 2, version: 3 } },
    { ...take(1), key: "projects/1/chars/a.png", folder: "Bible/Characters", kind: "character", role: "bible", ext: "png", label: "Asha front", episode_id: null, series: { season: 0, episode: 0 } },
    { ...take(1), key: "projects/1/layers/x.png", folder: "Media", kind: "media", role: "media", ext: "png", label: "logo.png" },
    { ...take(1), key: "projects/1/layers/imp.png", folder: "Imports", kind: "media", role: "import", ext: "png", label: "IMP_0001_logo.png" },
  ],
};

test("desired series names for every folder", () => {
  const existing = new Map([["projects/1/layers/imp.png", "Imports/IMP_0001_logo.png"]]);
  const d = new Map(desiredPaths(manifest, { ...DEFAULT_TEMPLATES }, { folderAbs: "D:\\Lib\\Kaali (#1)", existing }).map((x) => [x.key, x.path]));
  assert.equal(d.get("projects/1/shots/1/video/1abc.mp4"), "Takes/Kaali-Return_S01E02_001_SC01_SH001_video_T01.mp4");
  assert.equal(d.get("projects/1/shots/2/video/2abc.mp4"), "Takes/Kaali-Return_S01E02_002_SC01_SH002_video_T01.mp4");
  assert.equal(d.get("projects/1/shots/1/lipsync/kn1.mp4"), "Takes/Kaali-Return_S01E02_001_SC01_SH001_lipsync_kn_T01.mp4");
  assert.equal(d.get("projects/1/shots/1/voice/v1.wav"), "Audio/Voice/Kaali-Return_S01E02_001_SH001_voice_en_T01.wav");
  assert.equal(d.get("projects/1/audio/m1.mp3"), "Audio/Music/Kaali-Return_S01E02_music_01.mp3");
  assert.equal(d.get("projects/1/audio/m2.mp3"), "Audio/Music/Kaali-Return_S01E02_music_02.mp3");
  assert.equal(d.get("projects/1/exports/e02.mp4"), "Renders/Kaali-Return_S01E02_kn_shorts_v003.mp4");
  assert.equal(d.get("projects/1/chars/a.png"), "Bible/Characters/Kaali-Return_character_Asha-front_01.png");
  assert.equal(d.get("projects/1/layers/x.png"), "Media/logo.png");
  assert.equal(d.get("projects/1/layers/imp.png"), "Imports/IMP_0001_logo.png", "ingested imports keep their name");
});

test("names follow the cut: a reorder swaps the cut numbers", () => {
  const swapped: Manifest = { ...manifest, items: [take(1, { series: { ...take(1).series, cut: 2 } }), take(2, { series: { ...take(2).series, cut: 1 } })] };
  const d = desiredPaths(swapped, { ...DEFAULT_TEMPLATES }, { folderAbs: "C:\\L" });
  assert.deepEqual(d.map((x) => x.path).sort(), ["Takes/Kaali-Return_S01E02_001_SC01_SH002_video_T01.mp4", "Takes/Kaali-Return_S01E02_002_SC01_SH001_video_T01.mp4"]);
});

test("same name twice gets _2", () => {
  const dup: Manifest = { ...manifest, items: [take(1), take(1, { key: "projects/1/shots/1/video/other.mp4" })] };
  const d = desiredPaths(dup, { Takes: "{code}" }, { folderAbs: "C:\\L" });
  assert.deepEqual(d.map((x) => x.path), ["Takes/E02-SH01.mp4", "Takes/E02-SH01_2.mp4"]);
});

test("mirror: files, queue order, cache, meta", () => {
  const m = new Mirror(":memory:");
  m.upsertFile({ key: "k1", project_id: 1, local_path: "Takes/a.mp4", state: "ready", size: 10 });
  m.setFile("k1", { proxy_path: "Proxies/a.mp4" });
  m.upsertFile({ key: "k1", etag: "e" });
  assert.equal(m.file("k1")?.proxy_path, "Proxies/a.mp4");
  assert.equal(m.file("k1")?.etag, "e");
  assert.equal(m.files({ state: "ready" }).length, 1);
  const a = m.enqueue({ method: "PATCH", path: "/api/shots/1", body: "{}", created_at: "2026-01-01T00:00:01Z" });
  m.enqueue({ method: "PUT", path: "/api/shots/1/fx", body: "{}", created_at: "2026-01-01T00:00:02Z" });
  assert.deepEqual(m.queued().map((q) => q.method), ["PATCH", "PUT"]);
  m.queueFailed(a, "boom");
  assert.equal(m.queued()[0].tries, 1);
  m.dequeue(a);
  assert.equal(m.queueCount(), 1);
  m.cachePut("/api/episodes/3?lang=kn", "{\"id\":3}");
  assert.equal(m.cacheEntries("/api/episodes/").length, 1);
  assert.equal(m.cacheGet("/api/episodes/3?lang=kn")?.body, "{\"id\":3}");
  m.setMeta("lastSync", "x");
  assert.equal(m.getMeta("lastSync"), "x");
  m.upsertEpisode(1, { id: 3, number: 2, season: 1, title: "E", shots: [{ id: 41, code: "E02-SH01", order: 1, include: true, cut_index: 1 }] });
  assert.deepEqual(m.episodes(1).map((e) => e.number), [2]);
  m.close();
});
