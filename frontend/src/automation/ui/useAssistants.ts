/** The assistants' state, live (assistants.state + onState), for the banner and Settings. */
import { useEffect, useState } from "react";
import type { AssistantsState } from "../../lib/desktop";
import { assistantsBridge } from "../api";

export function useAssistants(): [AssistantsState | null, (s: AssistantsState) => void] {
  const [st, setSt] = useState<AssistantsState | null>(null);
  useEffect(() => {
    const b = assistantsBridge();
    if (!b) return;
    let alive = true;
    void b.state().then((s) => { if (alive) setSt(s); }).catch(() => undefined);
    const off = b.onState((s) => setSt(s));
    return () => { alive = false; off(); };
  }, []);
  return [st, setSt];
}

/** "2 min ago", "just now" */
export function ago(iso?: string): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
