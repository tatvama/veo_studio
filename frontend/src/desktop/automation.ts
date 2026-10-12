/**
 * desktop-mcp's screens (docs/EDITOR.md §13), feature-detected: frontend/src/automation/AutoEditDialog.tsx and
 * AssistantsSettings.tsx may not be in this build yet. import.meta.glob finds them at build time and is empty when
 * they're missing, so nothing breaks either way.
 */
import type { ComponentType } from "react";

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

const autoEdit = import.meta.glob("../automation/AutoEditDialog.tsx") as Record<string, Loader<AutoEditProps>>;
const assistants = import.meta.glob("../automation/AssistantsSettings.tsx") as Record<string, Loader<Record<string, never>>>;
const banner = import.meta.glob(["../automation/AssistantBanner.tsx", "../automation/ui/AssistantBanner.tsx"]) as Record<string, Loader<Record<string, never>>>;

export interface AutoEditProps { folder?: string; files?: string[]; onClose?: () => void; open?: boolean }

export const loadAutoEdit: Loader<AutoEditProps> | null = Object.values(autoEdit)[0] ?? null;
export const loadAssistantsSettings: Loader<Record<string, never>> | null = Object.values(assistants)[0] ?? null;
/** "<assistant> is editing" with Pause / Stop, and the folder prompt (so it isn't a native box in this window) */
export const loadAssistantBanner: Loader<Record<string, never>> | null = Object.values(banner)[0] ?? null;
