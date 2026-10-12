/**
 * Text panel (docs/EDITOR.md §3): the selected title clip's text, font, size, colour, outline, shadow, background
 * box, position on screen and in / out animation, with a live preview. "New title" adds one at the playhead (T).
 */
import { Type } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button, Textarea } from "../../components/ui";
import { FONTS } from "../../pages/posters/fonts";
import * as A from "../actions";
import { updateClips } from "../model/ops";
import type { TitleSpec } from "../model/types";
import { program, useFrame } from "../playback/transport";
import { drawTitle, ensureFont } from "../render/title";
import { seqExec, setFocus, useEditor, useSequence } from "../store";
import { ScrubNumber } from "../ui";

export default function TextPanel() {
  const s = useSequence();
  const sel = useEditor((x) => x.selection);
  const c = s.clips.find((x) => sel.includes(x.id) && x.source.type === "title");
  if (!c || c.source.type !== "title") {
    return (
      <div className="pn" onPointerDown={() => setFocus("text")}>
        <div className="pn-empty">
          <div className="space-y-3">
            <Type className="mx-auto size-7 text-dim" />
            <p>Select a title clip to edit it, or add a new one at the playhead.</p>
            <Button size="sm" variant="primary" onClick={() => A.newTitle()}>New title</Button>
          </div>
        </div>
      </div>
    );
  }
  const spec = c.source.text;
  const id = c.id;
  const set = (patch: Partial<TitleSpec>, key: string) => seqExec("Edit title", (sq, cx) => updateClips(sq, cx, [id], (x) => (x.source.type === "title" ? { ...x, source: { ...x.source, text: { ...x.source.text, ...patch } }, name: patch.text !== undefined ? patch.text.split("\n")[0].slice(0, 60) || "Title" : x.name } : x)), `title:${id}:${key}`);
  const row = (label: string, el: React.ReactNode) => <div className="flex min-h-7 items-center gap-2 px-3"><span className="w-20 shrink-0 text-2xs text-mute">{label}</span><div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{el}</div></div>;
  const color = (v: string, on: (x: string) => void) => <input type="color" className="h-5 w-9 cursor-pointer rounded border border-line bg-transparent" value={v.slice(0, 7)} onChange={(e) => on(e.target.value)} />;
  return (
    <div className="pn" onPointerDown={() => setFocus("text")}>
      <div className="ed-bar"><span className="flex-1 truncate text-xs font-medium">{c.name}</span><Button size="sm" variant="ghost" onClick={() => A.newTitle()}>New title</Button></div>
      <div className="pn-scroll space-y-1 pb-3">
        <Preview spec={spec} w={s.width} h={s.height} start={c.start} duration={c.duration} fps={s.fps} />
        <div className="px-3 pb-1"><Textarea value={spec.text} rows={3} onChange={(e) => set({ text: e.target.value }, "text")} onKeyDown={(e) => e.stopPropagation()} className="text-sm" /></div>
        {row("Font", <>
          <select className="ed-field min-w-0 flex-1" value={spec.font} onChange={(e) => set({ font: e.target.value }, "font")}>
            {FONTS.map((f) => <option key={f.family} value={f.family}>{f.label}</option>)}
          </select>
          <select className="ed-field" value={spec.weight} onChange={(e) => set({ weight: Number(e.target.value) }, "weight")}>
            {(FONTS.find((f) => f.family === spec.font)?.weights ?? [400, 700]).map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </>)}
        {row("Size", <><ScrubNumber value={spec.size} min={8} max={600} step={1} unit="px" onChange={(v) => set({ size: Math.round(v) }, "size")} />{color(spec.color, (v) => set({ color: v }, "color"))}</>)}
        {row("Align", <div className="ed-seg">{(["left", "center", "right"] as const).map((a) => <button key={a} type="button" aria-pressed={spec.align === a} onClick={() => set({ align: a }, "align")}>{a[0].toUpperCase() + a.slice(1)}</button>)}</div>)}
        {row("Outline", <>
          <input type="checkbox" checked={!!spec.outline} onChange={(e) => set({ outline: e.target.checked ? { color: "#000000", width: 4 } : undefined }, "outline")} />
          {spec.outline && <>{color(spec.outline.color, (v) => set({ outline: { ...spec.outline!, color: v } }, "oc"))}<ScrubNumber value={spec.outline.width} min={0} max={40} step={0.5} unit="px" onChange={(v) => set({ outline: { ...spec.outline!, width: v } }, "ow")} /></>}
        </>)}
        {row("Shadow", <>
          <input type="checkbox" checked={!!spec.shadow} onChange={(e) => set({ shadow: e.target.checked ? { color: "#000000aa", blur: 12, x: 0, y: 4 } : undefined }, "shadow")} />
          {spec.shadow && <>{color(spec.shadow.color, (v) => set({ shadow: { ...spec.shadow!, color: v } }, "sc"))}
            <span className="text-2xs text-dim">blur</span><ScrubNumber value={spec.shadow.blur} min={0} max={80} step={1} onChange={(v) => set({ shadow: { ...spec.shadow!, blur: v } }, "sb")} />
            <span className="text-2xs text-dim">x</span><ScrubNumber value={spec.shadow.x} step={1} onChange={(v) => set({ shadow: { ...spec.shadow!, x: v } }, "sx")} />
            <span className="text-2xs text-dim">y</span><ScrubNumber value={spec.shadow.y} step={1} onChange={(v) => set({ shadow: { ...spec.shadow!, y: v } }, "sy")} /></>}
        </>)}
        {row("Background", <>
          <input type="checkbox" checked={!!spec.background} onChange={(e) => set({ background: e.target.checked ? { color: "#000000b3", padding: 18, radius: 10 } : undefined }, "bg")} />
          {spec.background && <>{color(spec.background.color, (v) => set({ background: { ...spec.background!, color: v } }, "bgc"))}
            <span className="text-2xs text-dim">pad</span><ScrubNumber value={spec.background.padding} min={0} max={200} step={1} onChange={(v) => set({ background: { ...spec.background!, padding: v } }, "bgp")} />
            <span className="text-2xs text-dim">radius</span><ScrubNumber value={spec.background.radius} min={0} max={200} step={1} onChange={(v) => set({ background: { ...spec.background!, radius: v } }, "bgr")} /></>}
        </>)}
        {row("Box", <>
          {(["x", "y", "w", "h"] as const).map((k, i) => (
            <span key={k} className="flex items-center gap-0.5"><span className="text-2xs text-dim">{k}</span>
              <ScrubNumber value={spec.box[i] * 100} min={0} max={100} step={0.5} unit="%" onChange={(v) => set({ box: spec.box.map((b, j) => (j === i ? v / 100 : b)) as TitleSpec["box"] }, `box${k}`)} /></span>
          ))}
        </>)}
        {row("Animate", <>
          <span className="text-2xs text-dim">in</span>
          <select className="ed-field" value={spec.animIn ?? "none"} onChange={(e) => set({ animIn: e.target.value as TitleSpec["animIn"] }, "ai")}>
            {[["none", "None"], ["fade", "Fade"], ["slide_up", "Slide up"], ["typewriter", "Typewriter"], ["pop", "Pop"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span className="text-2xs text-dim">out</span>
          <select className="ed-field" value={spec.animOut ?? "none"} onChange={(e) => set({ animOut: e.target.value as TitleSpec["animOut"] }, "ao")}>
            {[["none", "None"], ["fade", "Fade"], ["slide_down", "Slide down"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </>)}
        <p className="px-3 pt-1 text-2xs text-dim">Indic scripts are shaped by the browser. Position, scale and opacity keyframes are in Effect Controls.</p>
      </div>
    </div>
  );
}

/** The title over a checkerboard at the playhead (or its middle when the playhead isn't on it). */
function Preview({ spec, w, h, start, duration, fps }: { spec: TitleSpec; w: number; h: number; start: number; duration: number; fps: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const f = useFrame(program);
  const local = f >= start && f < start + duration ? f - start : Math.floor(duration / 2);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const W = 480, H = Math.round((480 * h) / w);
    c.width = W; c.height = H;
    const g = c.getContext("2d")!;
    const paint = () => drawTitle(g, spec, W, H, local / fps, duration / fps, H / h);
    paint();
    void ensureFont(spec).then(paint);
  }, [spec, w, h, local, duration, fps]);
  return (
    <div className="flex justify-center px-3 pt-2">
      <canvas ref={cv} className="w-full max-w-[420px] rounded-md border border-line" style={{ aspectRatio: `${w} / ${h}`, background: "repeating-conic-gradient(var(--color-raised) 0% 25%, var(--color-panel) 0% 50%) 50% / 16px 16px" }} />
    </div>
  );
}
