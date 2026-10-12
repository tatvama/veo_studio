/**
 * The Program monitor's Motion overlay (editor-motion, like Premiere's): for the selected picture clip under the
 * playhead, its bounding box on the picture — drag inside to move it, a corner to scale, the knob above to rotate
 * (Shift: 15° steps), the anchor cross-hair to move the anchor point (the picture stays put) — and, when its position
 * is keyframed, the motion path: a dot per frame (their spacing is the speed), the keyframes (drag to move) and their
 * bezier tangents (drag to curve the path; Alt breaks a smooth key). Every drag is one undo step; with the stopwatch
 * on, a change sets a keyframe at the playhead.
 */
import { useMemo, useRef, useSyncExternalStore } from "react";
import { clipEnd, ctxOf, kindOf, updateParam } from "../model/ops";
import { setParam, valueAt } from "../model/params";
import type { Keyframe, Param, Sequence, TimelineClip } from "../model/types";
import { program, usePlayState } from "../playback/transport";
import { gesture, useEditor, useProject } from "../store";

type P2 = [number, number];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const rot = (a: P2, deg: number): P2 => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [a[0] * c - a[1] * s, a[0] * s + a[1] * c]; };
const len = (a: P2) => Math.hypot(a[0], a[1]);

function useProgramFrame(): number {
  return useSyncExternalStore((cb) => program.subscribe(cb), () => program.frame, () => 0);
}

export function MotionOverlay({ seq: s, w, h }: { seq: Sequence; w: number; h: number }) {
  const p = useProject();
  const selection = useEditor((x) => x.selection);
  const frame = useProgramFrame();
  const { playing } = usePlayState(program);
  const svg = useRef<SVGSVGElement>(null);
  const ctx = useMemo(() => ctxOf(p), [p]);
  const c = s.clips.find((x) => x.id === selection[0]);
  const ok = !!c && selection.length >= 1 && kindOf(s, c) === "video" && c.source.type !== "adjustment" && frame >= c.start && frame < clipEnd(c) && w > 0 && !playing;
  const k = w / Math.max(1, s.width);
  // the clip's picture size and its fit inside the frame (Motion scale 100 % = fitted)
  const pic = useMemo((): P2 => {
    if (!c) return [s.width, s.height];
    if (c.source.type === "media") { const m = ctx.media(c.source.mediaId); if (m && m.width > 0 && m.height > 0) return [m.width, m.height]; }
    if (c.source.type === "nested") { const ns = ctx.sequence(c.source.sequenceId); if (ns) return [ns.width, ns.height]; }
    return [s.width, s.height];
  }, [c, ctx, s.width, s.height]);
  const pathPts = useMemo(() => {
    if (!c || (c.motion.position.keyframes?.length ?? 0) < 2) return null;
    const out: P2[] = [];
    const step = Math.max(1, Math.ceil(c.duration / 600));
    for (let f = 0; f < c.duration; f += step) out.push(valueAt(c.motion.position, f) as P2);
    return out;
  }, [c]);
  if (!ok || !c) return null;
  const local = frame - c.start;
  const m = c.motion;
  const pos = valueAt(m.position, local) as P2, sc = Number(valueAt(m.scale, local)), ro = Number(valueAt(m.rotation, local)), an = valueAt(m.anchor, local) as P2;
  const fit = Math.min(s.width / pic[0], s.height / pic[1]);
  const kk = (fit * sc) / 100;
  /** A point of the picture (its own pixels) on screen. */
  const onScreen = (q: P2): P2 => mul(add(pos, rot(mul(sub(q, an), kk), ro)), k);
  const corners = [[0, 0], [pic[0], 0], [pic[0], pic[1]], [0, pic[1]]].map((q) => onScreen(q as P2));
  const topMid = onScreen([pic[0] / 2, 0]);
  const up = rot([0, -1], ro);
  const knob = add(topMid, mul(up, 22));
  const anchorS = mul(pos, k);
  const toSeq = (e: { clientX: number; clientY: number }): P2 => { const r = svg.current!.getBoundingClientRect(); return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]; };
  const editParam = (path: string, fn: (q: Param<unknown>) => Param<unknown>) => gesture.previewSeq((sq, cx) => updateParam(sq, cx, c.id, path, fn));

  /** A drag: `move` gets the pointer in sequence pixels; one undo step named `label`. */
  const drag = (e: React.PointerEvent, label: string, move: (pt: P2, ev: PointerEvent) => void) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget as unknown as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
    gesture.begin(label);
    const mv = (ev: PointerEvent) => move(toSeq(ev), ev);
    const end = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", end); el.removeEventListener("pointercancel", end); gesture.commit(); };
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
  };
  const r2 = (v: P2): P2 => [Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10];

  const onBody = (e: React.PointerEvent) => {
    const p0 = toSeq(e), pos0 = pos;
    drag(e, "Move", (pt) => editParam("motion.position", (q) => setParam(q, r2(add(pos0, sub(pt, p0))) as never, local)));
  };
  const onCorner = (e: React.PointerEvent) => {
    const p0 = toSeq(e), d0 = Math.max(1, len(sub(p0, pos))), s0 = sc;
    drag(e, "Scale", (pt) => editParam("motion.scale", (q) => setParam(q, Math.round(Math.max(1, (s0 * len(sub(pt, pos))) / d0) * 10) / 10 as never, local)));
  };
  const onRotate = (e: React.PointerEvent) => {
    const a0 = Math.atan2(toSeq(e)[1] - pos[1], toSeq(e)[0] - pos[0]), r0 = ro;
    drag(e, "Rotate", (pt, ev) => {
      let r = r0 + ((Math.atan2(pt[1] - pos[1], pt[0] - pos[0]) - a0) * 180) / Math.PI;
      if (ev.shiftKey) r = Math.round(r / 15) * 15;
      editParam("motion.rotation", (q) => setParam(q, Math.round(r * 10) / 10 as never, local));
    });
  };
  const onAnchor = (e: React.PointerEvent) => {
    const p0 = toSeq(e), pos0 = pos, an0 = an;
    drag(e, "Anchor point", (pt) => {
      const d = sub(pt, p0);
      const da = mul(rot(d, -ro), 1 / Math.max(1e-6, kk));
      gesture.previewSeq((sq, cx) => updateParam(updateParam(sq, cx, c.id, "motion.anchor", (q) => setParam(q, r2(add(an0, da)) as never, local)), cx, c.id, "motion.position",
        (q) => setParam(q, r2(add(pos0, d)) as never, local)));
    });
  };
  // ── the motion path ────────────────────────────────────────────────────────
  const ks = (m.position.keyframes ?? []) as Keyframe<P2>[];
  const editKey = (f: number, fn: (k: Keyframe<P2>, i: number) => Keyframe<P2>) => editParam("motion.position", (q) => ({ ...q, keyframes: (q.keyframes as Keyframe<P2>[]).map((x, i) => (x.frame === f ? fn(x, i) : x)) }) as Param<unknown>);
  const onKey = (e: React.PointerEvent, kf: Keyframe<P2>) => {
    const p0 = toSeq(e), v0 = kf.value;
    drag(e, "Move keyframe", (pt) => editKey(kf.frame, (x) => ({ ...x, value: r2(add(v0, sub(pt, p0))) })));
  };
  const onTangent = (e: React.PointerEvent, i: number, side: "out" | "in") => {
    const kf = ks[i];
    drag(e, "Motion path", (pt, ev) => {
      const t = r2(sub(pt, kf.value));
      editKey(kf.frame, (x) => {
        const y: Keyframe<P2> = { ...x };
        const other = side === "out" ? "tangentIn" : "tangentOut";
        const hasOther = side === "out" ? i > 0 : i < ks.length - 1;
        if (side === "out") y.tangentOut = t; else y.tangentIn = t;
        if (!ev.altKey && hasOther) {
          // a smooth key: the other tangent turns the opposite way, keeping its length
          const cur = (x[other] as P2 | undefined) ?? mul(sub((side === "out" ? ks[i - 1] : ks[i + 1]).value, x.value), 1 / 3);
          const L = len(cur), T = len(t);
          y[other] = T > 1e-6 ? r2(mul(t, -L / T)) : cur;
        }
        return y;
      });
    });
  };
  const polyline = pathPts?.map((q) => `${q[0] * k},${q[1] * k}`).join(" ");
  return (
    <svg ref={svg} className="mo-overlay" width={w} height={h} data-motion-overlay={c.id}>
      {/* the box first: the motion path's keyframes and tangents sit on top of it and take the pointer */}
      <polygon points={corners.map((q) => q.join(",")).join(" ")} className="mo-box" onPointerDown={onBody}><title>Drag to move</title></polygon>
      {pathPts && (
        <g className="mo-path">
          <polyline points={polyline} />
          {pathPts.map((q, i) => (i % 2 ? null : <circle key={i} cx={q[0] * k} cy={q[1] * k} r={1.3} className="mo-tick" />))}
          {ks.map((kf, i) => {
            const at = mul(kf.value, k);
            const tOut = i < ks.length - 1 ? mul(add(kf.value, (kf.tangentOut as P2 | undefined) ?? mul(sub(ks[i + 1].value, kf.value), 1 / 3)), k) : null;
            const tIn = i > 0 ? mul(add(kf.value, (kf.tangentIn as P2 | undefined) ?? mul(sub(ks[i - 1].value, kf.value), 1 / 3)), k) : null;
            return (
              <g key={kf.frame}>
                {tOut && <><line x1={at[0]} y1={at[1]} x2={tOut[0]} y2={tOut[1]} className={kf.tangentOut ? "mo-tline" : "mo-tline ghost"} />
                  <circle cx={tOut[0]} cy={tOut[1]} r={4} className="mo-tknob" onPointerDown={(e) => onTangent(e, i, "out")}><title>Drag to curve the path (Alt: this side only)</title></circle></>}
                {tIn && <><line x1={at[0]} y1={at[1]} x2={tIn[0]} y2={tIn[1]} className={kf.tangentIn ? "mo-tline" : "mo-tline ghost"} />
                  <circle cx={tIn[0]} cy={tIn[1]} r={4} className="mo-tknob" onPointerDown={(e) => onTangent(e, i, "in")}><title>Drag to curve the path (Alt: this side only)</title></circle></>}
                <rect x={at[0] - 5} y={at[1] - 5} width={10} height={10} className={kf.frame === local ? "mo-key on" : "mo-key"} onPointerDown={(e) => onKey(e, kf)}>
                  <title>{`Position keyframe at frame ${kf.frame}: drag to move it`}</title>
                </rect>
              </g>
            );
          })}
        </g>
      )}
      <line x1={topMid[0]} y1={topMid[1]} x2={knob[0]} y2={knob[1]} className="mo-stem" />
      <circle cx={knob[0]} cy={knob[1]} r={5} className="mo-rot" onPointerDown={onRotate}><title>Drag to rotate (Shift: 15° steps)</title></circle>
      {corners.map((q, i) => <rect key={i} x={q[0] - 4.5} y={q[1] - 4.5} width={9} height={9} className="mo-corner" onPointerDown={onCorner}><title>Drag to scale</title></rect>)}
      <g className="mo-anchor" onPointerDown={onAnchor}>
        <circle cx={anchorS[0]} cy={anchorS[1]} r={7} />
        <line x1={anchorS[0] - 10} y1={anchorS[1]} x2={anchorS[0] + 10} y2={anchorS[1]} />
        <line x1={anchorS[0]} y1={anchorS[1] - 10} x2={anchorS[0]} y2={anchorS[1] + 10} />
        <title>Anchor point: drag to move it (the picture stays)</title>
      </g>
    </svg>
  );
}
