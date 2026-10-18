/** Asks the open project for its import wizard (with a script to read, or none to paste or upload one): ProjectLayout opens it. */
export const IMPORT_EVENT = "veo:import-script";

export function openImport(text = "") {
  window.dispatchEvent(new CustomEvent(IMPORT_EVENT, { detail: { text } }));
}
