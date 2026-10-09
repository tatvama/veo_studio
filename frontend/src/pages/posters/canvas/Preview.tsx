/**
 * A read-only render of a document scaled to fit `maxSize` (gallery cards, template picker, version list).
 * Cheap enough to show dozens: it renders only once scrolled into view, with the same layer renderers as the editor
 * (no interaction, no transformer, no animation), then snapshots itself to an <img> and drops the Konva stage.
 */
import type Konva from "konva";
import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Layer, Stage } from "react-konva";
import { cn } from "../../../lib/cn";
import "../../../styles/posters.css";
import { displayText } from "../doc";
import { loadFontsFor } from "../fonts";
import type { DesignDoc, TextLayer } from "../types";
import { loadImage, nextFrame } from "./images";
import { BackgroundView, LayerView, quietSlots } from "./nodes";
import { cssPaint } from "./paint";

export function DocPreview({ doc, width, height, maxSize = 240, className }: {
  doc: DesignDoc; width: number; height: number; maxSize?: number; className?: string;
}) {
  const k = Math.min(maxSize / Math.max(1, width), maxSize / Math.max(1, height));
  const w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [snap, setSnap] = useState<{ key: string; url: string } | null>(null);
  const key = useMemo(() => `${w}x${h}|${width}x${height}|${JSON.stringify(doc)}`, [doc, width, height, w, h]);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  const g = doc.background?.gradient;
  const bg = g && g.stops?.length ? cssPaint(g) : doc.background?.color;
  return (
    <div ref={ref} className={cn("pst-preview", className)} style={{ width: w, height: h, background: bg }} aria-hidden>
      {snap && <img src={snap.url} alt="" draggable={false} className="absolute inset-0" />}
      {visible && snap?.key !== key && (
        <PreviewStage doc={doc} W={width} H={height} k={k} w={w} h={h} onReady={(url) => setSnap({ key, url })} />
      )}
    </div>
  );
}

function PreviewStage({ doc, W, H, k, w, h, onReady }: {
  doc: DesignDoc; W: number; H: number; k: number; w: number; h: number; onReady: (url: string) => void;
}) {
  const stage = useRef<Konva.Stage>(null);
  const [fontsVersion, setFontsVersion] = useState(0);
  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const quiet = useMemo(() => quietSlots(doc.layers), [doc.layers]);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    let alive = true;
    (async () => {
      const texts = doc.layers.filter((l): l is TextLayer => l.type === "text");
      await loadFontsFor(texts.map((l) => ({ fontFamily: l.fontFamily, fontWeight: l.fontWeight, fontStyle: l.fontStyle, text: displayText(l) })));
      await Promise.all(doc.layers.map((l) => (l.type === "image" && l.src ? loadImage(l.src) : null)));
      if (!alive) return;
      setFontsVersion((v) => v + 1);
      await nextFrame();
      await nextFrame();
      if (!alive || !stage.current) return;
      try {
        ready.current(stage.current.toDataURL({ pixelRatio: dpr, mimeType: "image/png" }));
      } catch { /* a cross-origin image tainted the canvas: keep showing the live stage */ }
    })();
    return () => { alive = false; };
  }, [doc, dpr]);

  return (
    <Stage ref={stage} width={w} height={h} listening={false} className="absolute inset-0">
      <Layer listening={false}>
        <Group scaleX={k} scaleY={k} listening={false}>
          <BackgroundView bg={doc.background} W={W} H={H} />
          {doc.layers.map((l) => (
            <LayerView key={l.id} layer={l} mode="preview" fontsVersion={fontsVersion} zoom={k} cacheScale={k * dpr} quiet={quiet.has(l.id)} />
          ))}
        </Group>
      </Layer>
    </Stage>
  );
}
