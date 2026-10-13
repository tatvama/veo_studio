/**
 * News Room graphics export: transparent ProRes 4444 / WebM / PNG, the other ratio, language versions
 * (docs/EDITOR.md §16.9). Owner: nr-delivery. PLACEHOLDER.
 */
import type { NewsExportOptions, NewsExportResult } from "../../shared/types.ts";

/** What the export needs from the app (nr-delivery adds fields here and passes them in main/index.ts). */
export interface NewsExportDeps { log(msg: string): void }

export async function exportGraphics(_d: NewsExportDeps, _o: NewsExportOptions): Promise<NewsExportResult | null> {
  throw new Error("News graphics export isn't built yet");
}
