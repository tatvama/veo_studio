/**
 * How the Designer's inspector reads a kind's number props (docs/EDITOR.md §16.8): a default of null means "automatic";
 * a default like −1 or 0 whose hint says it follows the look (or "as typed", "as many as fit") is a sentinel. Both show
 * as a choice ("Auto" / "Follow look" / "Set") instead of a raw number. Pure.
 */
import type { PropDef } from "../render/contract.ts";

export function sentinelOf(def: PropDef): { value: number | null; label: string } | null {
  if (def.default === null) return { value: null, label: "Auto" };
  if (typeof def.default !== "number" || !def.hint) return null;
  const m = /([−-]?\d+(?:\.\d+)?)\s*(?:=|follows|means)\s*([^,;.]+)/.exec(def.hint);
  if (!m) return null;
  const value = parseFloat(m[1].replace("−", "-"));
  const what = m[2].trim();
  if (value !== def.default || !/look|as typed|as many|auto|none|its own/i.test(what)) return null;
  return { value, label: /look/i.test(what) ? "Follow look" : what.charAt(0).toUpperCase() + what.slice(1) };
}

