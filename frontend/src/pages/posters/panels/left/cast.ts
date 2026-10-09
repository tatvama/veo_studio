/** The film's characters as the left panel uses them: approved reference images and outfits. */
import type { Character, CharacterAsset } from "../../../../lib/types";

/** The API also returns the storage path and the costumes (not in the shared types). */
export type CastAsset = CharacterAsset & { path?: string };
export interface Costume { id: number; name: string; description: string; is_default: boolean }
export type CastCharacter = Omit<Character, "assets"> & { assets?: CastAsset[]; costumes?: Costume[] };

const KIND_ORDER = ["source", "front", "three_quarter", "profile", "full_body", "back", "outfit", "expression"];

export const ASSET_KIND_LABEL: Record<string, string> = {
  source: "Photo", front: "Front", three_quarter: "Three-quarter", profile: "Profile", full_body: "Full body", back: "Back",
  outfit: "Outfit", expression: "Expression",
};

/** Approved, live images of a character, in a sensible order (photo and front first). */
export function approvedImages(c: CastCharacter): CastAsset[] {
  return (c.assets ?? [])
    .filter((a) => a.approved && !a.archived && !!a.url)
    .sort((a, b) => (KIND_ORDER.indexOf(a.kind) + 99) % 99 - (KIND_ORDER.indexOf(b.kind) + 99) % 99 || a.id - b.id);
}

export function assetLabel(a: CastAsset): string {
  const kind = ASSET_KIND_LABEL[a.kind] ?? a.kind.replace(/_/g, " ");
  const extra = a.kind === "outfit" ? a.outfit || a.label : a.kind === "expression" ? a.label : "";
  return extra && extra.toLowerCase() !== kind.toLowerCase() ? `${kind}: ${extra}` : kind;
}

/** Outfit names to offer for a character: its costumes plus any outfit reference images. */
export function outfitsOf(c: CastCharacter | undefined): string[] {
  if (!c) return [];
  const names = [
    ...(c.costumes ?? []).map((x) => x.name),
    ...(c.assets ?? []).filter((a) => a.kind === "outfit" && !a.archived).map((a) => a.outfit || a.label),
  ].map((s) => (s ?? "").trim()).filter(Boolean);
  return [...new Set(names)];
}
