/**
 * What the Tatvam Editor adds to the desktop shell while an edit is open (additive mounts in editor/EditorApp.tsx):
 *  - its action registry in the command palette and the cheat sheet, with each action's current key (run by pressing
 *    that key, so the editor's own keymap does the work), plus its panels under Windows,
 *  - a guard, so "Reload" for new screens and "Restart to update" save the edit first,
 *  - a drop target, so media dropped on the window goes into the edit,
 *  - Ctrl+K stays the editor's "Add edit" when it's bound (the palette opens with Ctrl+Shift+P).
 * Imported only by the editor, so the studio's bundle doesn't carry the editor's modules.
 */
import { LayoutPanelTop, Zap } from "lucide-react";
import { useEffect, useRef } from "react";
import { importFiles } from "../editor/session";
import { currentBindings, useKeySettings } from "../editor/keymap";
import { KEY_ACTIONS } from "../editor/model/keybindings";
import { claimKeys, pressKeys, registerCommands, type Command } from "./commands";
import { registerDropTarget, registerGuard } from "./state";

export { DesktopStatusSlot } from "./StatusBar";

export function DesktopEditorHooks({ panels, showPanel, isDirty, save, name }: {
  panels: { id: string; title: string }[];
  showPanel(id: string): void;
  isDirty(): boolean;
  save(): Promise<boolean>;
  name?: string;
}) {
  const keys = useKeySettings();
  const live = useRef({ panels, showPanel, isDirty, save, name });
  live.current = { panels, showPanel, isDirty, save, name };
  useEffect(() => {
    const b = currentBindings();
    const claimed = Object.values(b).some((ks) => ks.includes("Ctrl+K")) ? ["Ctrl+K"] : [];
    const unclaim = claimKeys(claimed);
    const off = registerCommands("editor", () => {
      const bind = currentBindings();
      const out: Command[] = [];
      for (const a of KEY_ACTIONS) {
        const k = bind[a.id]?.[0];
        if (!k || a.id === "escape") continue;
        out.push({ id: `editor:${a.id}`, group: "Editor", title: a.label, hint: a.group, shortcut: bind[a.id].join(" / "), icon: <Zap className="size-3.5" />,
          keywords: `${a.group} ${a.id}`, searchOnly: true, run: () => pressKeys(k) });
      }
      for (const p of live.current.panels) {
        out.push({ id: `editor-panel:${p.id}`, group: "Windows", title: `Editor panel: ${p.title}`, icon: <LayoutPanelTop className="size-3.5" />, keywords: "show panel dock",
          searchOnly: true, run: () => live.current.showPanel(p.id) });
      }
      return out;
    });
    return () => { off(); unclaim(); };
  }, [keys]);
  useEffect(() => registerGuard({ get name() { return live.current.name ? `The edit "${live.current.name}"` : "The open edit"; },
    dirty: () => live.current.isDirty(), save: () => live.current.save() }), []);
  useEffect(() => registerDropTarget({ media: async (paths) => { await importFiles(paths); return true; } }), []);
  return null;
}
