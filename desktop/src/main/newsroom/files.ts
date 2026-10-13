/**
 * The News Room look / template library on disk (docs/EDITOR.md §16.9). Owner: nr-designer. PLACEHOLDER.
 * <library>\News\Looks\<id>.tatvamlook and <library>\News\Templates\<id>.tatvamgfx (JSON).
 */
import type { NewsLibraryEntry, NewsLibraryKind } from "../../shared/types.ts";
import type { NewsroomDeps } from "./ipc.ts";

const todo = () => { throw new Error("The News Room library isn't built yet"); };
export async function libraryList(_d: NewsroomDeps, _k: NewsLibraryKind): Promise<NewsLibraryEntry[]> { return []; }
export async function libraryRead(_d: NewsroomDeps, _k: NewsLibraryKind, _id: string): Promise<string | null> { return null; }
export async function libraryWrite(_d: NewsroomDeps, _k: NewsLibraryKind, _id: string, _json: string): Promise<{ path: string }> { return todo(); }
export async function libraryDelete(_d: NewsroomDeps, _k: NewsLibraryKind, _id: string): Promise<void> { todo(); }
export async function exportFile(_d: NewsroomDeps, _k: NewsLibraryKind, _json: string, _name: string): Promise<string | null> { return todo(); }
export async function importFile(_d: NewsroomDeps, _k: NewsLibraryKind): Promise<{ name: string; json: string } | null> { return todo(); }
