/**
 * File names for News Room deliveries (docs/EDITOR.md §16.11): safe on Windows, short, tagged with the ratio
 * ("_9x16"), the language ("_hi") or a row's name, and unique within a batch ("Row", "Row_2" …). The desktop makes
 * them unique against what's already in `Exports\News`. Pure.
 */

/** "9:16" → "9x16". */
export const ratioTag = (r: string) => r.replace(":", "x");

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * A name part safe for a file name and still readable: ":" becomes " - ", slashes "-", quotes "'", the other
 * characters Windows refuses go; single spaces, no dots or spaces at the ends, at most `max` characters.
 */
export function safeName(s: string, fallback = "News", max = 80): string {
  let v = String(s ?? "").normalize("NFC").replace(/\s*:\s*/g, " - ").replace(/[/\\|]/g, "-").replace(/"/g, "'")
    .replace(/[<>?*\u0000-\u001f]+/g, "").replace(/\s+/g, " ").replace(/-{2,}/g, "-").trim();
  v = v.slice(0, max).replace(/^[\s._]+|[\s._]+$/g, "");
  if (!v) v = fallback;
  return RESERVED.test(v) ? `_${v}` : v;
}

/** `<base>[_<ratio>][_<lang>][_<suffix>]`: "Evening bulletin_9x16_hi". */
export function deliveryName(base: string, tags: { ratio?: string | null; lang?: string | null; suffix?: string | null } = {}): string {
  const parts = [safeName(base)];
  if (tags.ratio) parts.push(ratioTag(tags.ratio));
  if (tags.lang) parts.push(safeName(tags.lang, "", 12));
  if (tags.suffix) parts.push(safeName(tags.suffix, "", 60));
  return parts.filter(Boolean).join("_");
}

/** The same list with repeats made unique, in order: "a", "a_2", "a_3" (case-insensitive). */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let v = n, i = 2;
    while (used.has(v.toLowerCase())) v = `${n}_${i++}`;
    used.add(v.toLowerCase());
    return v;
  });
}
