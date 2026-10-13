/** Pictures the page draws itself and hands the engine as custom sources (the demo's procedural clips), by URL. */
import type { CustomSource } from "../engine";

let sources: Record<string, CustomSource> = {};
export const registerCustomSources = (m: Record<string, CustomSource>) => { sources = { ...sources, ...m }; };
export const demoCustomSources = () => sources;
export const customSource = (url: string | undefined): CustomSource | undefined => (url ? sources[url] : undefined);
