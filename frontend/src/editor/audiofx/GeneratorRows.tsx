/**
 * The generator clips (tone, noise, DTMF) as a collapsible list for the Project panel: drag one onto an audio track
 * lane of the timeline (the same drop as from the Effects panel), or double-click to add it at the playhead.
 */
import { AudioWaveform, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { addGenerator, GEN_MIME, installGeneratorDrop } from "./actions";
import { GENERATORS, type GeneratorKind } from "./registry";

installGeneratorDrop();

export function GeneratorRows({ filter = "" }: { filter?: string }) {
  const [open, setOpen] = useState(true);
  const q = filter.trim().toLowerCase();
  const list = GENERATORS.filter((g) => !q || g.label.toLowerCase().includes(q) || g.kind.includes(q));
  if (!list.length) return null;
  return (
    <div>
      <div className="pn-section" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}Generators<span className="mono ml-auto text-dim">{list.length}</span>
      </div>
      {open && list.map((g) => (
        <div key={g.kind} className="pn-row cursor-grab pl-[10px]" draggable title="Drag onto an audio track, or double-click to add at the playhead"
          onDragStart={(e) => { e.dataTransfer.setData(GEN_MIME, g.kind); e.dataTransfer.setData("text/plain", g.label); e.dataTransfer.effectAllowed = "copy"; }}
          onDoubleClick={() => addGenerator(g.kind as GeneratorKind)}>
          <AudioWaveform className="size-3.5 shrink-0 text-ok" />
          <span className="min-w-0 flex-1 truncate">{g.label}</span>
          <span className="text-2xs text-dim">clip</span>
        </div>
      ))}
    </div>
  );
}
