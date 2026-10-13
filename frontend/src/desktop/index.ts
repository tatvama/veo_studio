/**
 * Tatvam Desktop's UX kit (the desktop shell in every window). The editor's additions live in ./editorHooks (imported
 * by the editor only, so this entry never pulls the editor's modules into the studio bundle).
 */
export { DesktopShellHost } from "./DesktopShell";
export { DesktopStatusBar, DesktopStatusSlot } from "./StatusBar";
export { registerCommands, useCommands, type Command } from "./commands";
export { registerGuard, registerDropTarget, setOverlay } from "./state";
export { useUiStatus, useAppearanceState, useJobs, useDisk, useNotifications, useShellState, useUpdate } from "./bridge";
