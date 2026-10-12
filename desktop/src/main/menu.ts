/**
 * The application menu and its shortcuts. Actions the UI handles are sent to the focused window as
 * `app.onMenu(action)` (e.g. "open-settings", "machine-check", "about", and "open-editor" / "open-edit" for the Tatvam
 * Editor: the page goes to /editor, and "open-edit" shows its Open dialog).
 */
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { PanelId } from "../shared/types.ts";

export interface MenuDeps {
  isPackaged: boolean;
  proxyMode(): boolean;
  setProxyMode(on: boolean): void;
  workspaces(): { id: string; name: string }[];
  applyWorkspace(id: string): void;
  popOut(panel: PanelId): void;
  programToNextDisplay(): void;
  closeAllPanels(): void;
  openProjectFolder(): void;
  chooseLibrary(): void;
  openConnection(): void;
  syncNow(): void;
  sendMenu(action: string): void;
  revealLogs(): void;
  checkForUpdates(): void;
}

const POP: [PanelId, string][] = [["program", "Program monitor"], ["source", "Source monitor"], ["timeline", "Timeline"], ["scopes", "Scopes"],
  ["mixer", "Mixer"], ["notes", "Review notes"], ["media", "Media"], ["renders", "Renders"]];

export function buildMenu(d: MenuDeps): void {
  const tpl: MenuItemConstructorOptions[] = [
    { label: "&File", submenu: [
      { label: "New edit…", click: () => d.sendMenu("open-editor") },
      { label: "Open edit…", click: () => d.sendMenu("open-edit") },
      { type: "separator" },
      { label: "Open project folder", accelerator: "CmdOrCtrl+Shift+O", click: () => d.openProjectFolder() },
      { label: "Choose library folder…", click: () => d.chooseLibrary() },
      { label: "Studio server…", click: () => d.openConnection() },
      { label: "Sync now", accelerator: "CmdOrCtrl+Shift+S", click: () => d.syncNow() },
      { type: "separator" },
      { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => d.sendMenu("open-settings") },
      { type: "separator" },
      { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
    ] },
    { label: "&Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" },
      { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" },
    ] },
    { label: "&View", submenu: [
      { role: "reload" }, { role: "togglefullscreen" },
      { label: "Proxy mode", type: "checkbox", checked: d.proxyMode(), click: (item) => d.setProxyMode(item.checked) },
      { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      ...(d.isPackaged ? [] : [{ type: "separator" } as MenuItemConstructorOptions, { role: "toggleDevTools" } as MenuItemConstructorOptions]),
    ] },
    { label: "&Window", submenu: [
      { label: "Editor", accelerator: "CmdOrCtrl+Shift+E", click: () => d.sendMenu("open-editor") },
      { type: "separator" },
      { label: "Pop out", submenu: POP.map(([panel, label], i) => ({ label, accelerator: `CmdOrCtrl+Shift+${i + 1}`, click: () => d.popOut(panel) })) },
      { label: "Send program monitor to next display", accelerator: "CmdOrCtrl+Shift+M", click: () => d.programToNextDisplay() },
      { label: "Workspaces", submenu: d.workspaces().map((w, i) => ({ label: w.name, ...(i < 5 ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}),
        click: () => d.applyWorkspace(w.id) })) },
      { label: "Close all panels", click: () => d.closeAllPanels() },
      { type: "separator" }, { role: "minimize" },
    ] },
    { label: "&Help", submenu: [
      { label: "Machine check", click: () => d.sendMenu("machine-check") },
      { label: "Open logs folder", click: () => d.revealLogs() },
      { label: "Check for updates", click: () => d.checkForUpdates() },
      { type: "separator" },
      { label: "About Tatvam Studio", click: () => d.sendMenu("about") },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}
