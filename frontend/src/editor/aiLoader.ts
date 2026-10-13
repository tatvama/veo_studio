/**
 * The AI tools (docs/EDITOR.md §8) live in editor/ai/** (built separately). They load lazily, and only when that
 * module exists: import.meta.glob finds nothing otherwise, so the editor builds and runs without them.
 */
import type { ComponentType } from "react";
import type { EditorHost } from "./model/types";

export interface AiClipAction { id: string; label: string; group: string; run(): void; paid: boolean }
export interface AiModule {
  AiPanel: ComponentType<{ host: EditorHost }>;
  aiClipActions(host: EditorHost, clipIds: string[]): AiClipAction[];
}

const mods = import.meta.glob<AiModule>("./ai/index.ts");
let modP: Promise<AiModule | null> | null = null;

export const hasAi = () => Object.keys(mods).length > 0;

export function loadAi(): Promise<AiModule | null> {
  const f = mods["./ai/index.ts"];
  if (!f) return Promise.resolve(null);
  modP ??= f().catch((e) => { console.warn("[editor] AI tools didn't load", e); modP = null; return null; });
  return modP;
}
