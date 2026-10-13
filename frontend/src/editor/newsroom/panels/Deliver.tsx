/**
 * News delivery (`nr-deliver`, docs/EDITOR.md §16.11): every way a news edit leaves the editor, in calm sections
 * with sensible defaults: both ratios in one go, transparent graphics (ProRes 4444, WebM, PNG), seamless loops,
 * language versions, TV delivery (EBU R128, legal range), batch from a spreadsheet, news shorts per rundown story
 * and the look preview reel; the exports started here are listed at the bottom with progress, "show in folder" and
 * errors in plain words. Exports run in Tatvam Desktop (the GPU render and FFmpeg); in the browser the panel says
 * so, and the reel can still be added to the project. Owner: nr-delivery.
 */
import { useMemo } from "react";
import { desktop } from "../../../lib/desktop";
import { setFocus, useProject, useSequence } from "../../store";
import { Batch, BothRatios, JobsList, Languages, Loop, Reel, Shorts, Transparent, Tv } from "../delivery/ui";
import { allTemplates, useLibraryTemplates } from "../room/hooks";

export default function Deliver() {
  const p = useProject();
  const s = useSequence();
  const lib = useLibraryTemplates();
  // built-ins, the edit's own and the library's
  const templates = useMemo(() => (p ? allTemplates(p, lib) : []), [p?.newsroom?.templates, lib]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p || !s) return <div className="pn"><div className="pn-empty">Open an edit to deliver it.</div></div>;
  return (
    <div className="pn" onPointerDown={() => setFocus("other")} data-nr-deliver-panel>
      {!desktop() && (
        <p className="border-b border-line px-3 py-2 text-2xs leading-snug text-amber-300">
          These exports render on this computer, so they need the Tatvam Desktop app. You can still set them up here.
        </p>
      )}
      <div className="pn-scroll">
        <BothRatios />
        <Transparent />
        <Loop templates={templates} />
        <Languages />
        <Tv />
        <Batch templates={templates} />
        <Shorts templates={templates} />
        <Reel templates={templates} />
      </div>
      <JobsList />
    </div>
  );
}
