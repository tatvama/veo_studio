/**
 * Lab check of the whole path a graphic takes in the editor (`engine=1`): a throwaway edit in memory → addGraphic →
 * buildComposition (generated `gen:gfx:` sources) → the GPU engine's preview, drawn at time t. What shows here is what
 * the program monitor and the export draw.
 */
import { useEffect, useRef, useState } from "react";
import { buildComposition, createPreview } from "../../engine";
import { newProject } from "../../model/defaults";
import { addGraphic, applyLook } from "../commands";
import { ensureGraphicAssets } from "../render";
import type { GfxTemplate } from "../types";

export default function EngineCheck({ template, lookId, t, w, ratio }: { template: GfxTemplate; lookId: string; t: number; w: number; ratio: "16:9" | "9:16" }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [msg, setMsg] = useState("Loading the engine…");
  useEffect(() => {
    let off = false;
    let dispose: (() => void) | null = null;
    void (async () => {
      try {
        const size = ratio === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
        const p = newProject("Lab", { ...size, fps: 25 });
        applyLook(p, lookId);
        const len = template.seconds > 0 ? template.seconds : 10;
        addGraphic(p, template, { at: 0, duration: len * 25 });
        const r = buildComposition(p, p.activeSequenceId);
        const gen = Object.keys(r.generated).filter((k) => k.startsWith("gen:gfx:"));
        const eng = await createPreview(ref.current!, size.width, size.height);
        dispose = () => eng.dispose();
        if (off) return;
        for (const g of Object.values(r.generated)) if (g.kind === "graphic") await ensureGraphicAssets(g.input);
        await eng.load(r);
        eng.draw(t);
        // a second draw after the sources settle
        await new Promise((res) => setTimeout(res, 300));
        eng.draw(t);
        setMsg(`${gen.length} graphic source(s): ${gen.join(", ")} · warnings: ${[...r.warnings, ...eng.warnings()].join("; ") || "none"}`);
        document.title = "ready";
      } catch (e) { setMsg(`Failed: ${(e as Error).message}`); document.title = "ready"; }
    })();
    return () => { off = true; dispose?.(); };
  }, [template, lookId, t, ratio]);
  const h = Math.round(ratio === "9:16" ? w * 16 / 9 : w * 9 / 16);
  return (
    <div style={{ padding: 16 }}>
      <canvas ref={ref} style={{ width: w, height: h, display: "block", background: "#000" }} />
      <p style={{ color: "#9aa4b2", font: "12px ui-monospace, monospace" }}>{msg}</p>
    </div>
  );
}
