/**
 * desktop-mcp's AssistantBanner (it hosts the folder prompt) in the desktop's own windows (Start, Settings), when this
 * build has it.
 */
import { lazy, Suspense } from "react";
import { loadAssistantBanner } from "./automation";

const Banner = loadAssistantBanner ? lazy(loadAssistantBanner) : null;

export function AssistantBannerSlot() {
  if (!Banner) return null;
  return <Suspense fallback={null}><Banner /></Suspense>;
}
