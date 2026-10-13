/**
 * News Room data: web addresses and local text files (docs/EDITOR.md §16.9). Owner: nr-data. PLACEHOLDER.
 */
import type { NewsFetchResult } from "../../shared/types.ts";
import type { NewsroomDeps } from "./ipc.ts";

export async function fetchText(url: string): Promise<NewsFetchResult> { return { ok: false, status: 0, type: "", text: "", finalUrl: url, error: "Not built yet" }; }
export async function readTextFile(_d: NewsroomDeps, _path?: string): Promise<{ path: string; name: string; text: string } | null> { return null; }
