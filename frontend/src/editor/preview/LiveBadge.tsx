/** The badge over the Program monitor while a card's live preview shows (preview-polish, live.ts). */
import "./preview.css";
import { useLiveLabel } from "./live";

export function LiveBadge() {
  const l = useLiveLabel();
  if (!l) return null;
  return <div className="pv-live" data-live-preview role="status"><span>Preview</span><b>{l.label}</b><i>· {l.hint} · not applied</i></div>;
}
