import { createContext, useContext } from "react";
import type { Character, Episode } from "../../../lib/types";

/** Everything the Studio panels share (they render inside dockview, possibly in a popped-out window). */
export interface StudioState {
  episode?: Episode; cast: Character[]; selected: number | null; select: (id: number | null) => void;
  addShot: (sceneId: number | null) => void; canEdit: boolean; goCharacters: () => void; goShots: () => void;
  /** re-read the episode, board and shots after an edit */
  refresh: () => void;
  /** move a shot to `index` in the outline order, inside `sceneId` */
  moveShot: (shotId: number, sceneId: number | null, index: number) => Promise<void>;
  /** put a character in a shot (or take them out) */
  setCast: (shotId: number, characterId: number, on: boolean) => Promise<void>;
}

export const StudioCtx = createContext<StudioState | null>(null);
export const useStudio = () => useContext(StudioCtx)!;
