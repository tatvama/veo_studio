/**
 * The playhead line, in its own layer: it follows the program transport through a ref (no React render per frame)
 * and pages the timeline along while playing.
 */
import { useEffect, useRef } from "react";
import { program } from "../playback/transport";
import { ed, setView } from "../store";

export function Playhead({ zoom, scroll, width }: { zoom: number; scroll: number; width: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const place = () => {
      const x = program.frame * zoom - scroll;
      const d = el.current;
      if (d) { d.style.transform = `translateX(${x}px)`; d.style.display = x < -8 || x > width + 8 ? "none" : ""; }
      // page along while playing (forwards and backwards)
      if (program.playing && !ed().h.gesture && width > 40) {
        if (x > width - 12) setView({ scroll: Math.max(0, program.frame * zoom - 24) });
        else if (x < 0 && program.rate < 0) setView({ scroll: Math.max(0, program.frame * zoom - width + 24) });
      }
    };
    place();
    return program.subscribe(place);
  }, [zoom, scroll, width]);
  return <div ref={el} className="tl-playhead" />;
}
