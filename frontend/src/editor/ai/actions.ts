/**
 * The AI submenu of a clip's context menu (docs/EDITOR.md §8): the tools that fit the selected clips. Paid ones show
 * their price before they run (the dialogs mount on their own, so the AI panel needn't be open).
 */
import { clipById, ctxOf, trackById } from "../model/ops";
import { shortDuration } from "../model/time";
import { canAnalyze } from "./bridge";
import { ensureDialogs } from "./dialogs";
import type { EditorHost } from "./host-types";
import { askChoice, askText } from "./store";
import {
  applyScenes, beatMarkers, captions, cleanVoice, cutSilences, dub, editWithWords, extendClip, findScenes, findSilences, measureLoudness,
  normaliseLoudness, upscale,
} from "./tools";

export interface AiAction { id: string; label: string; group: string; run(): void; paid: boolean }

export const DUB_LANGUAGES = [["hi", "Hindi"], ["kn", "Kannada"], ["te", "Telugu"], ["ta", "Tamil"], ["en", "English"]] as const;
export const SILENCE_DEFAULTS = { thresholdDb: -35, minMs: 500, padMs: 120 };

const fail = (host: EditorHost) => (e: unknown) => host.toast(e instanceof Error ? e.message : String(e), "error");

export async function reviewSilences(host: EditorHost, clipIds: string[]): Promise<void> {
  const ranges = await findSilences(host, clipIds, SILENCE_DEFAULTS);
  if (!ranges.length) { host.toast("No silences long enough to cut", "ok"); return; }
  const fps = host.sequence().fps;
  const ids = await askChoice({
    title: `Remove ${ranges.length} silence${ranges.length === 1 ? "" : "s"}`, multiple: true, confirmLabel: "Cut and close the gaps",
    note: "Pauses below −35 dB longer than half a second. Cutting closes the gaps on every unlocked track, so everything stays in sync.",
    items: ranges.map(([a, b], i) => ({ id: String(i), label: `Silence ${i + 1}`, detail: `${shortDuration(a, fps)} · ${shortDuration(b - a, fps)}`, checked: true })),
  });
  if (!ids?.length) return;
  if (cutSilences(host, ids.map((i) => ranges[Number(i)]))) host.toast(`${ids.length} silence${ids.length === 1 ? "" : "s"} cut`, "ok");
}

export function aiClipActions(host: EditorHost, clipIds: string[]): AiAction[] {
  ensureDialogs();
  const p = host.project(), seq = host.sequence(), ctx = ctxOf(p);
  const clips = clipIds.map((id) => clipById(seq, id)).filter((c): c is NonNullable<typeof c> => !!c);
  const mediaOf = (c: (typeof clips)[number]) => (c.source.type === "media" ? ctx.media(c.source.mediaId) : undefined);
  const sound = clips.filter((c) => { const m = mediaOf(c); return !!m && (m.kind === "audio" || m.hasAudio) && !c.reverse; });
  const video = clips.filter((c) => mediaOf(c)?.kind === "video" && trackById(seq, c.trackId)?.kind === "video" && !c.reverse);
  const music = clips.filter((c) => mediaOf(c)?.kind === "audio");
  const local = canAnalyze();
  const ids = clips.map((c) => c.id);
  const out: AiAction[] = [];
  const add = (id: string, label: string, group: string, paid: boolean, fn: () => Promise<unknown> | unknown) =>
    out.push({ id, label, group, paid, run: () => { Promise.resolve().then(fn).catch(fail(host)); } });

  if (sound.length) {
    add("captions", "Captions", "Captions", true, () => captions(host, { clipIds: ids, language: "auto", words: true }));
    add("clean_voice", "Clean up voice", "Sound", true, () => cleanVoice(host, ids));
    if (new Set(sound.map((c) => c.linkId ?? c.id)).size === 1) {  // one clip (both halves of a linked A/V pair count once)
      add("dub", "Dub…", "Voice", true, async () => {
        const pick = await askChoice({ title: "Dub into", multiple: false, confirmLabel: "See the price",
          items: DUB_LANGUAGES.map(([code, name], i) => ({ id: code, label: name, checked: i === 0 })) });
        if (pick?.[0]) await dub(host, sound[0].id, { target: pick[0] });
      });
    }
    if (local) {
      add("remove_silences", "Remove silences…", "Sound", false, () => reviewSilences(host, ids));
      add("loudness", "Normalise loudness (−14 LUFS)", "Sound", false, async () => {
        const rows = await measureLoudness(host, ids);
        const n = normaliseLoudness(host, rows, -14);
        host.toast(n ? `Loudness: ${rows.map((r) => `${r.name} ${r.value ? `${r.value.lufs.toFixed(1)} LUFS` : "?"}`).join(", ")} → −14 LUFS` : "Loudness: already at −14 LUFS", "ok");
      });
    }
  }
  if (music.length === 1 && local) {
    add("beats", "Beat markers", "Sound", false, async () => host.toast(`${await beatMarkers(host, music[0].id)} beat markers added`, "ok"));
  }
  if (video.length === 1) {
    const v = video[0];
    add("extend", "Extend by 6 seconds", "Picture", true, () => extendClip(host, v.id, { seconds: 6 }));
    add("edit_words", "Edit with words…", "Picture", true, async () => {
      const text = await askText({ title: "Edit with words", label: "What should change?", placeholder: "Make it night, remove the car …", confirmLabel: "See the price" });
      if (text) await editWithWords(host, v.id, text);
    });
    if (local) {
      add("scenes_split", "Split at scene cuts", "Picture", false, async () => {
        const frames = await findScenes(host, v.id);
        if (!frames.length) host.toast("No scene cuts found", "ok"); else if (applyScenes(host, v.id, frames, "split")) host.toast(`Split at ${frames.length} cuts`, "ok");
      });
      add("scenes_markers", "Markers at scene cuts", "Picture", false, async () => {
        const frames = await findScenes(host, v.id);
        if (!frames.length) host.toast("No scene cuts found", "ok"); else applyScenes(host, v.id, frames, "markers");
      });
    }
  }
  if (video.length) {
    const vids = video.map((c) => c.id);
    add("upscale_2k", "AI upscale to 2K", "Picture", true, () => upscale(host, vids, 1440));
    add("upscale_4k", "AI upscale to 4K", "Picture", true, () => upscale(host, vids, 2160));
  }
  return out;
}
