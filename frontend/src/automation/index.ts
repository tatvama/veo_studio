/**
 * AI assistants and auto edit in the app (docs/EDITOR.md §13). Mount points:
 *   - the editor: <AssistantExecutor /> (tool calls), <AssistantBanner /> (with the folder prompt), <AutoEditDialog />
 *   - Settings → AI assistants: <AssistantsSettings /> (default export, no props)
 *   - the Start window / a dropped folder: <AutoEditDialog /> and openAutoEdit({ folder })
 */
export { default as AssistantsSettings } from "./ui/AssistantsSettings";
export { default as AutoEditDialog } from "./ui/AutoEditDialog";
export { default as AssistantBanner } from "./ui/AssistantBanner";
export { default as FolderPrompt } from "./ui/FolderPrompt";
export { default as ActivityLog } from "./ui/ActivityLog";
export { default as AssistantExecutor } from "./bridge/AssistantExecutor";
export { openAutoEdit, AUTO_EDIT_EVENT, assistantsBridge, type OpenAutoEdit } from "./api";
