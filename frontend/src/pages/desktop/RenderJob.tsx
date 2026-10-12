import { useEffect, useRef, useState } from "react";
import { desktop } from "../../lib/desktop";

type PlanJob = { kind?: "plan"; plan: unknown; w: number; h: number; fps: number; frames: number; bits?: 8 | 10 };
type CompositionJob = { kind: "composition"; project: unknown; sequenceId: string; range?: { in: number; out: number };
  w: number; h: number; fps: number; frames: number; bits?: 8 | 10 };

const mediaUrl = (key: string) => `/media/${key.split("/").map(encodeURIComponent).join("/")}`;

/**
 * The hidden window of a desktop GPU render (docs/ENGINE.md §5). It asks the desktop for its job (a studio render plan, or
 * an editor sequence), builds the Composition, renders every frame exactly with the GPU engine and hands each one over as
 * I420. The desktop writes it to FFmpeg, so `frame()` resolving is the pace. Nobody sees this page.
 */
export default function RenderJob() {
  const [status, setStatus] = useState("Starting");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const id = new URLSearchParams(location.search).get("id") ?? "";
    const bridge = desktop()?.engine;
    if (!bridge || !id) {
      setStatus("This page only runs inside Tatvam Desktop's GPU render");
      return;
    }
    void (async () => {
      try {
        const job = (await bridge.job(id)) as PlanJob | CompositionJob;
        const eng = await import("../../engine");
        const engine = await eng.createEngine({ width: job.w, height: job.h });
        if (job.kind === "composition") {
          // the editor's own mapping: generic video tracks once this engine build draws them, else V1 + layers
          const [{ buildComposition, engineModule, generatedSources, registerDesktopShaders }, { ensureFont }] = await Promise.all([
            import("../../editor/engine"), import("../../editor/render/title"), import("../posters/fonts")]);
          await engineModule();
          await registerDesktopShaders(); // custom effects and transitions the edit may use
          const project = job.project as Parameters<typeof buildComposition>[0];
          // every title's font is in before the first frame (the preview may redraw later; an export can't)
          await Promise.all(project.sequences.flatMap((s) => s.clips).filter((c) => c.source.type === "title")
            .map((c) => ensureFont((c.source as { text: Parameters<typeof ensureFont>[0] }).text)));
          const r = buildComposition(project, job.sequenceId, job.range ? { range: [job.range.in, job.range.out] } : {});
          await engine.load(r.comp, { mode: "exact", sources: generatedSources(r.generated) });
        } else {
          await engine.load(eng.fromPlan(job.plan as Parameters<typeof eng.fromPlan>[0], mediaUrl), { mode: "exact" });
        }
        // 10-bit encoders (HEVC Main10, ProRes) get yuv420p10le; an engine without it sends 8-bit and the desktop warns
        const ten = job.bits === 10 && typeof engine.readYuv420p10 === "function";
        const t0 = performance.now();
        for (let i = 0; i < job.frames; i++) {
          await engine.renderExact(i / job.fps);
          // the IPC copies the bytes, so the engine may reuse its read-back buffer for the next frame
          await bridge.frame(id, i, ten ? engine.readYuv420p10() : engine.readYuv420());
          if (i % 24 === 0) setStatus(`Frame ${i + 1} of ${job.frames} · ${((i + 1) / ((performance.now() - t0) / 1000)).toFixed(1)} fps`);
        }
        engine.dispose();
        setStatus("Done");
        await bridge.done(id);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        setStatus(`Failed: ${msg}`);
        await bridge.fail(id, msg).catch(() => undefined);
      }
    })();
  }, []);

  return <p style={{ font: "12px system-ui", color: "#999", padding: 12 }}>GPU render · {status}</p>;
}
