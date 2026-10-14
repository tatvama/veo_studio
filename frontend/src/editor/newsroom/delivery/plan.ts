/**
 * The News delivery panel's exports as desktop options (docs/EDITOR.md §16.11, bridge `newsroom.exportGraphics`):
 * both ratios in one go, transparent graphics, language versions, TV delivery, and the formats with what they
 * need. One `NewsExportOptions` per output file; the panel queues them. Pure.
 */
import type { NewsExportOptions } from "../../../lib/desktop.ts";
import type { Sequence } from "../../model/types.ts";
import type { GfxRatio } from "../types.ts";
import { deliveryName } from "./names.ts";
import { seqRatio } from "./prepare.ts";

export type Codec = NewsExportOptions["codec"];
export const CODECS: { id: Codec; label: string; hint: string; alpha: boolean }[] = [
  { id: "prores4444", label: "ProRes 4444 (.mov)", hint: "Best for other editors and playout: keeps the transparency", alpha: true },
  { id: "webm_alpha", label: "WebM with transparency", hint: "Small files for web pages and OBS", alpha: true },
  { id: "png", label: "PNG pictures", hint: "One picture per frame in a folder", alpha: true },
  { id: "mp4", label: "MP4 video", hint: "An ordinary video (no transparency)", alpha: false },
];
export const isAlpha = (c: Codec) => CODECS.find((x) => x.id === c)?.alpha ?? false;

/** TV delivery: EBU R128 (−23 LUFS, −1 dBTP true peak) and a broadcast-safe picture (legal range 16–235). */
export const TV_OPTIONS = { preset: "broadcast1080", loudness: "ebu_r128", legal: true } as const;
export const LOUDNESS_CHOICES: { id: NonNullable<NewsExportOptions["loudness"]>; label: string }[] = [
  { id: "youtube", label: "Web −14 LUFS (YouTube, social)" },
  { id: "ebu_r128", label: "TV EBU R128 −23 LUFS, −1 dBTP" },
  { id: "ott", label: "OTT −24 LUFS" },
  { id: "off", label: "Leave as mixed" },
];

export interface Base { editPath: string; sequence: Pick<Sequence, "id" | "name" | "width" | "height" | "inPoint" | "outPoint">; name?: string }

/** Sequence frames [in, out) of the in / out marks (the out mark is the last frame shown), or undefined = all. */
export function markedRange(s: Base["sequence"]): { in: number; out: number } | undefined {
  if (s.inPoint === undefined && s.outPoint === undefined) return undefined;
  const a = Math.max(0, s.inPoint ?? 0);
  return s.outPoint !== undefined && s.outPoint + 1 > a ? { in: a, out: s.outPoint + 1 } : undefined;
}

type Extra = Partial<Pick<NewsExportOptions, "preset" | "loudness" | "legal" | "range" | "lang">>;

/** The sequence's own ratio and the other one (16:9 ↔ 9:16), as two mp4s named "<name>_16x9" and "<name>_9x16". */
export function bothRatios(b: Base, x: Extra = {}): NewsExportOptions[] {
  const own = seqRatio(b.sequence.width, b.sequence.height);
  const other: GfxRatio = own === "9:16" ? "16:9" : "9:16";
  const name = b.name ?? b.sequence.name;
  const mk = (ratio: GfxRatio, isOwn: boolean): NewsExportOptions => ({
    editPath: b.editPath, sequenceId: b.sequence.id, codec: "mp4", only: "all", ...x,
    ...(isOwn ? {} : { ratio }), name: deliveryName(name, { ratio, lang: x.lang }),
  });
  // the 16:9 first
  return own === "9:16" ? [mk(other, false), mk(own, true)] : [mk(own, true), mk(other, false)];
}

/** Graphics on transparency (all, some roles, or some clips), in one alpha format; optionally the other ratio. */
export function transparent(b: Base, codec: Exclude<Codec, "mp4">, o: { roles?: string[]; clipIds?: string[]; ratio?: GfxRatio; range?: { in: number; out: number }; suffix?: string } = {}): NewsExportOptions {
  return {
    editPath: b.editPath, sequenceId: b.sequence.id, codec, only: "graphics",
    ...(o.roles?.length ? { roles: o.roles } : {}), ...(o.clipIds?.length ? { clipIds: o.clipIds } : {}),
    ...(o.ratio ? { ratio: o.ratio } : {}), ...(o.range ? { range: o.range } : {}),
    name: deliveryName(b.name ?? b.sequence.name, { ratio: o.ratio, suffix: o.suffix ?? "graphics" }),
  };
}

/** One version per language (each graphic's `langs` values), in this ratio (or the sequence's own). */
export function languageVersions(b: Base, langs: string[], x: Extra & { ratio?: GfxRatio; codec?: Codec } = {}): NewsExportOptions[] {
  const { ratio, codec, ...rest } = x;
  return langs.map((lang) => ({
    editPath: b.editPath, sequenceId: b.sequence.id, codec: codec ?? "mp4", only: codec && isAlpha(codec) ? "graphics" : "all",
    ...rest, lang, ...(ratio ? { ratio } : {}), name: deliveryName(b.name ?? b.sequence.name, { ratio, lang }),
  }));
}

/** TV delivery of the sequence (and its other ratio when asked). */
export function tvDelivery(b: Base, o: { both?: boolean; range?: { in: number; out: number }; preset?: string } = {}): NewsExportOptions[] {
  const x = { ...TV_OPTIONS, ...(o.preset ? { preset: o.preset } : {}), ...(o.range ? { range: o.range } : {}) };
  if (o.both) return bothRatios({ ...b, name: `${b.name ?? b.sequence.name} TV` }, x);
  return [{ editPath: b.editPath, sequenceId: b.sequence.id, codec: "mp4", only: "all", ...x, name: deliveryName(`${b.name ?? b.sequence.name} TV`) }];
}

/** A generated sequence (a batch row, a short, the reel, a loop) exported on its own. */
export function generated(editPath: string, seq: Sequence, o: { codec: Codec; name: string; range?: { in: number; out: number }; extra?: Sequence[];
  templates?: Record<string, unknown>; preset?: string; loudness?: NewsExportOptions["loudness"]; legal?: boolean; background?: string }): NewsExportOptions {
  return {
    editPath, sequenceId: seq.id, codec: o.codec, only: isAlpha(o.codec) ? "graphics" : "all",
    sequences: [seq, ...(o.extra ?? [])], name: o.name,
    ...(o.range ? { range: o.range } : {}), ...(o.templates && Object.keys(o.templates).length ? { templates: o.templates } : {}),
    ...(o.preset ? { preset: o.preset } : {}), ...(o.loudness ? { loudness: o.loudness } : {}), ...(o.legal ? { legal: true } : {}),
    ...(o.background ? { background: o.background } : {}),
  };
}
