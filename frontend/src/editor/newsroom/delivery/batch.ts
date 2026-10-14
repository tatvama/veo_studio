/**
 * Batch from a spreadsheet (docs/EDITOR.md §16.11): one template plus CSV rows gives one short video per row. Each
 * column is mapped to one of the template's fields (by name to start with); every row becomes a generated sequence:
 * the graphic over a colour, over a clip from the bin, or alone on transparency, as long as the row's length column
 * says (or a fixed length), named by a column. The panel queues one export per row. Pure.
 */
import { uid } from "../../model/ids.ts";
import { fpsExact, secondsToFrames } from "../../model/time.ts";
import type { MediaItem, Sequence } from "../../model/types.ts";
import type { GfxField, GfxListItem, GfxTemplate, GfxValue } from "../types.ts";
import { blankSequence, placeColor, placeGraphic, placeMedia } from "./build.ts";
import { safeName, uniqueNames } from "./names.ts";

/** Field id → column name ("" or missing = the field keeps its sample value). */
export type BatchMapping = Record<string, string>;

export type BatchBackground =
  | { kind: "transparent" }
  | { kind: "color"; color: string }
  | { kind: "media"; mediaId: string; /** source frame to start from */ in?: number };

export interface BatchOptions {
  template: GfxTemplate;
  columns: string[]; rows: Record<string, string>[];
  mapping: BatchMapping;
  /** The column that names each video; without it: "<base> 1", "<base> 2" … */
  nameColumn?: string; nameBase?: string;
  /** Seconds per video: the column's value when it has one, else `seconds`. */
  lengthColumn?: string; seconds: number;
  background: BatchBackground;
  width: number; height: number; fps: number;
  /** A look for the graphics (default: the edit's). */
  look?: string;
  /** The edit's media: image fields and the background clip are found here. */
  media?: MediaItem[];
}

export interface BatchRow {
  index: number; name: string; seconds: number; frames: number;
  values: Record<string, GfxValue>;
  sequence: Sequence;
  /** Things to know about this row in plain words (an unknown image, a too-short clip …). */
  problems: string[];
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9ऀ-෿]+/g, "");

/** Fields that can take a cell (tables can't). */
export const mappableFields = (t: GfxTemplate) => t.fields.filter((f) => f.type !== "table");

/** A first mapping: a column whose name matches the field's id, label or fill hint ("person.name" → "Name"). */
export function guessMapping(t: GfxTemplate, columns: string[]): BatchMapping {
  const byName = new Map(columns.map((c) => [norm(c), c]));
  const out: BatchMapping = {};
  for (const f of mappableFields(t)) {
    const keys = [f.id, f.label, f.fill?.split(".").pop() ?? ""].map(norm).filter(Boolean);
    const hit = keys.map((k) => byName.get(k)).find(Boolean);
    if (hit) out[f.id] = hit;
  }
  return out;
}

/** Seconds from "8", "8s", "8.5", "0:08", "1:02:03"; null when it isn't a length. */
export function parseSeconds(s: string): number | null {
  const v = s.trim().toLowerCase().replace(/\s*(s|sec|secs|seconds)$/, "");
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** "₹ 1,23,456.5" → 123456.5; null when there's no number. */
export function parseNumber(s: string): number | null {
  const v = s.replace(/[^\d.\-]/g, "");
  if (!v || !/\d/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const YES = new Set(["yes", "y", "true", "1", "on", "x", "✓", "✔", "haan", "हाँ"]);

/** A cell as a field's value; `problem` says why it couldn't be used (then the sample value stays). */
export function cellValue(f: GfxField, cell: string, media: MediaItem[] = []): { value?: GfxValue; problem?: string } {
  const c = cell.trim();
  if (!c) return {};
  switch (f.type) {
    case "number": {
      const n = parseNumber(c);
      return n === null ? { problem: `${f.label}: "${c}" isn't a number` } : { value: n };
    }
    case "toggle": return { value: YES.has(c.toLowerCase()) };
    case "list": {
      const parts = c.split(/\r?\n|\s*\|\s*|\s*;\s*/).map((x) => x.trim()).filter(Boolean);
      return { value: parts.map((text): GfxListItem => ({ text })) };
    }
    case "choice": {
      const o = f.options?.find((x) => norm(x.value) === norm(c) || norm(x.label) === norm(c));
      return o ? { value: o.value } : { problem: `${f.label}: "${c}" isn't one of ${(f.options ?? []).map((x) => x.label).join(", ")}` };
    }
    case "image": {
      const stem = (n: string) => norm(n.replace(/\.[a-z0-9]{2,5}$/i, ""));
      const m = media.find((x) => x.kind === "image" && (norm(x.name) === norm(c) || stem(x.name) === stem(c)))
        ?? media.find((x) => x.kind !== "audio" && stem(x.name) === stem(c));
      return m ? { value: { mediaId: m.id } } : { problem: `${f.label}: no picture called "${c}" in the bin` };
    }
    case "table": return {};
    default: return { value: c };
  }
}

/** One generated sequence per row (rows with nothing in any mapped column are skipped). */
export function planBatch(o: BatchOptions): BatchRow[] {
  const fields = mappableFields(o.template).filter((f) => o.mapping[f.id]);
  const f = fpsExact(o.fps);
  const bg = o.background.kind === "media" ? o.media?.find((m) => m.id === (o.background as { mediaId: string }).mediaId) : undefined;
  const used = o.rows.map((row, index) => ({ row, index })).filter(({ row }) => fields.some((x) => (row[o.mapping[x.id]] ?? "").trim()));
  const names = uniqueNames(used.map(({ row, index }) => safeName((o.nameColumn && row[o.nameColumn]) || `${o.nameBase || o.template.name} ${index + 1}`)));
  return used.map(({ row, index }, i) => {
    const problems: string[] = [];
    const values: Record<string, GfxValue> = {};
    for (const fl of fields) {
      const r = cellValue(fl, row[o.mapping[fl.id]] ?? "", o.media);
      if (r.problem) problems.push(r.problem);
      if (r.value !== undefined) values[fl.id] = r.value;
    }
    const own = o.lengthColumn ? parseSeconds(row[o.lengthColumn] ?? "") : null;
    if (o.lengthColumn && (row[o.lengthColumn] ?? "").trim() && own === null) problems.push(`Length "${row[o.lengthColumn]}" isn't a number of seconds: ${o.seconds} s used`);
    const seconds = Math.min(600, Math.max(1, own ?? o.seconds));
    const frames = Math.max(1, secondsToFrames(seconds, o.fps));
    let seq: Sequence = { ...blankSequence(names[i], o), id: uid("s") };
    const v1 = seq.tracks.find((t) => t.kind === "video")!;
    if (o.background.kind === "color") seq = placeColor(seq, v1.id, 0, frames, o.background.color, "Background");
    if (o.background.kind === "media") {
      if (!bg) problems.push("The background clip isn't in the bin any more");
      else {
        seq = placeMedia(seq, bg, 0, frames, o.background.in ?? 0);
        if (bg.kind === "video" && bg.duration > 0 && bg.fps > 0 && (bg.duration - (o.background.in ?? 0)) / bg.fps < seconds - 1 / f) {
          problems.push(`${bg.name} is shorter than ${seconds} s: its last frame holds`);
        }
      }
    }
    seq = placeGraphic(seq, o.template, 0, frames, { values, ...(o.look ? { look: o.look } : {}) }).seq;
    return { index, name: names[i], seconds, frames, values, sequence: seq, problems };
  });
}
