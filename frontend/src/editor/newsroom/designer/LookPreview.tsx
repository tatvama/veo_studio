/**
 * A look shown on a news picture (docs/EDITOR.md §16.8): a name strap (lifted above the ticker, as on air), a ticker
 * and the logo bug drawn live in that look over a calm studio-like backdrop. `crop` shows only the lower part of the
 * frame (where straps and tickers live), for small cards. Used by the look cards and Make my look.
 */
import { clsx } from "clsx";
import { useEffect, useMemo, useRef } from "react";
import { designFor, drawGraphic, ensureGraphicAssets } from "../render";
import { onAssets } from "../render/images";
import type { GfxRenderInput } from "../render/contract";
import { DESIGN, defaults } from "../templates/kit";
import type { ChannelLook, GfxRatio, GfxTemplate } from "../types";
import { previewTemplates } from "./sample";
import { useImages } from "./Stage";

const BACKDROP = "radial-gradient(120% 90% at 30% 20%, #3a4a63 0%, #1b2433 55%, #0c1018 100%)";
/** The part of the frame a cropped preview shows (from the bottom). */
const CROP = 0.42;

/** Where a template draws, as frame fractions (full-frame layers left out), for the strap to keep clear of. */
function boxOf(t: GfxTemplate, ratio: GfxRatio): [number, number, number, number] | null {
  const { w, h } = DESIGN[ratio];
  const ls = designFor(t, ratio).layers.filter((l) => !l.hidden && !(l.box[2] >= w * 0.9 && l.box[3] >= h * 0.9));
  if (!ls.length) return null;
  const x0 = Math.min(...ls.map((l) => l.box[0])), y0 = Math.min(...ls.map((l) => l.box[1]));
  const x1 = Math.max(...ls.map((l) => l.box[0] + l.box[2])), y1 = Math.max(...ls.map((l) => l.box[1] + l.box[3]));
  return [x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h];
}

export function LookPreview({ look, className, ratio = "16:9", t = 3, crop, bug = !crop }: { look: ChannelLook; className?: string; ratio?: GfxRatio; t?: number; crop?: boolean; bug?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const images = useImages();
  const tpls = useMemo(previewTemplates, []);
  const inputs = useMemo(() => {
    const tb = boxOf(tpls.ticker, ratio);
    const base = { look, images, seed: 3, fps: 25, ratio };
    const list: { input: GfxRenderInput; dur: number }[] = [
      { input: { ...base, template: tpls.ticker, values: defaults(tpls.ticker) }, dur: 12 },
      { input: { ...base, template: tpls.strap, values: defaults(tpls.strap), ...(tb ? { avoid: [{ role: "ticker", box: tb }] } : {}) }, dur: Math.max(6, tpls.strap.seconds || 6) },
    ];
    if (bug && tpls.bug) list.push({ input: { ...base, template: tpls.bug, values: defaults(tpls.bug) }, dur: 12 });
    return list;
  }, [tpls, look, images, ratio, bug]);
  useEffect(() => {
    let alive = true;
    const draw = () => {
      const el = wrap.current;
      if (!el || !alive) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const { w: dw, h: dh } = DESIGN[ratio];
      const W = Math.max(2, Math.round(el.clientWidth * dpr)), H = Math.max(2, Math.round((W * dh) / dw));
      inputs.forEach(({ input, dur }, i) => {
        const c = canvases.current[i];
        if (!c) return;
        if (c.width !== W) c.width = W;
        if (c.height !== H) c.height = H;
        const g = c.getContext("2d");
        if (g) try { drawGraphic(g, input, W, H, Math.min(t, dur / 2), dur); } catch { /* a template that can't draw stays empty */ }
      });
    };
    draw();
    void Promise.all(inputs.map((i) => ensureGraphicAssets(i.input).catch(() => undefined))).then(draw);
    const off = onAssets(draw);
    const ro = new ResizeObserver(draw);
    if (wrap.current) ro.observe(wrap.current);
    return () => { alive = false; off(); ro.disconnect(); };
  }, [inputs, ratio, t]);
  const { w: dw, h: dh } = DESIGN[ratio];
  return (
    <div ref={wrap} className={clsx("relative overflow-hidden rounded-md", className)}
      style={{ aspectRatio: crop ? `${dw} / ${dh * CROP}` : `${dw} / ${dh}`, background: BACKDROP }}>
      {inputs.map((_, i) => (
        <canvas key={i} ref={(c) => { canvases.current[i] = c; }} className="absolute inset-x-0 bottom-0 w-full" style={{ aspectRatio: `${dw} / ${dh}` }} />
      ))}
    </div>
  );
}
