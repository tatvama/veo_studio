import { createContext, useContext } from "react";
import type { Character, Episode } from "../../../lib/types";
import type { NextShotIn } from "../../../lib/v3";
import type { LinkMode } from "./continuity";

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
  /** make `shotId` continue from `fromShotId` (null removes the link): its keyframe starts from that shot's last frame, or its video extends that clip */
  linkShot: (shotId: number, fromShotId: number | null, mode?: LinkMode) => Promise<void>;
  /** change how a linked shot continues from its source */
  setLinkMode: (shotId: number, mode: LinkMode) => Promise<void>;
  /** add the shot after `shotId` (same cast, outfits, place and props), linked to it; returns the new shot's id */
  addNextShot: (shotId: number, body: NextShotIn) => Promise<number | null>;
}

export const StudioCtx = createContext<StudioState | null>(null);
export const useStudio = () => useContext(StudioCtx)!;
