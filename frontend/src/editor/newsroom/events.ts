/**
 * News Room window events (docs/EDITOR.md §16.8): open the full-window tools from anywhere. Owner: lead (stable API).
 */
import type { GfxTemplate } from "./types.ts";

export interface OpenDesigner {
  /** A template id (built-in, the edit's or the library's) or a template to edit. */
  template: string | GfxTemplate;
  /** Edit the graphic clip's own copy ("Change only this one") instead of the template. */
  clipId?: string;
  /** Called with the saved template (already copied into the edit). */
  onSaved?(t: GfxTemplate): void;
}
export const openDesigner = (o: OpenDesigner) => window.dispatchEvent(new CustomEvent<OpenDesigner>("nr:designer", { detail: o }));
export interface OpenWipeDesigner { /** Start from this stinger template. */ template?: string; onSaved?(t: GfxTemplate): void }
export const openWipeDesigner = (o: OpenWipeDesigner = {}) => window.dispatchEvent(new CustomEvent<OpenWipeDesigner>("nr:wipe-designer", { detail: o }));
/** Show a News Room panel (the editor's ed:panel event). */
export const showNewsPanel = (id: string) => window.dispatchEvent(new CustomEvent("ed:panel", { detail: id }));
