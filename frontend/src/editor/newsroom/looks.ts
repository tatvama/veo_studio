/**
 * Channel looks (docs/EDITOR.md §16.2). Owner: nr-core. PLACEHOLDER signatures; nr-core writes the 5 ready looks
 * (Classic red, Modern blue, Business, Sports, Regional Indic). Pure.
 */
import type { EditProject } from "../model/types.ts";
import type { ChannelLook } from "./types.ts";

export const DEFAULT_LOOK_ID = "look.classic_red";
export const BUILTIN_LOOKS: ChannelLook[] = [];
export const builtinLook = (id: string): ChannelLook | undefined => BUILTIN_LOOKS.find((l) => l.id === id);
/** The look for an id in this edit (its own copy first, then the built-ins), else the edit's look, else the default. */
export function resolveLook(_p: EditProject, _id?: string): ChannelLook { return BUILTIN_LOOKS[0]; }
