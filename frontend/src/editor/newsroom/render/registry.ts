/**
 * Layer kinds by name (docs/EDITOR.md §16.3). Each kind module registers itself on import (render/kinds/index.ts
 * imports them all); the core renderer and the Designer read them from here. Pure.
 */
import type { LayerKindDef } from "./contract.ts";

const KINDS = new Map<string, LayerKindDef>();

/** Adds (or replaces) a layer kind. */
export function registerLayerKind(def: LayerKindDef): void { KINDS.set(def.kind, def); }
export const layerKind = (kind: string): LayerKindDef | undefined => KINDS.get(kind);
export const layerKinds = (): LayerKindDef[] => [...KINDS.values()];
/** A kind's default `p` (from its props). */
export function defaultProps(kind: string): Record<string, unknown> {
  const d = KINDS.get(kind);
  return d ? Object.fromEntries(d.props.map((p) => [p.key, p.default])) : {};
}
