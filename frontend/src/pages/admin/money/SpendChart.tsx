import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { addDays, axisMoney, dayIndex, money, niceScale, type DayPoint } from "./data";

/** Width of an element, kept in sync with a ResizeObserver, so the chart is drawn in real pixels (the axis text never scales). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.round(el.getBoundingClientRect().width));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const dayFmt = (ms: number) => {
  try { return new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); } catch { return new Date(ms).toDateString(); }
};
const monthShort = (ms: number) => {
  try { return new Date(ms).toLocaleDateString(undefined, { month: "short" }); } catch { return ""; }
};

/**
 * Spend over the month as an inline-SVG area chart: daily spend, or the running total against the cap (with a dashed
 * month-end projection). Drawn in the money colour from theme tokens, mono axis labels, hover/touch readout.
 * `summary` is the text alternative (role="img" + caption).
 */
export function SpendChart({ days, monthStart, monthDays, mode, cap, base = 0, projected, summary, height = 232 }: {
  days: DayPoint[]; monthStart: number; monthDays: number; mode: "daily" | "cumulative"; cap?: number; base?: number; projected?: number;
  summary: string; height?: number;
}) {
  const t = useT();
  const gid = useId();
  const [box, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const values = useMemo(() => {
    let run = base;
    return days.map((d) => { run += d.usd; return mode === "daily" ? d.usd : run; });
  }, [days, mode, base]);

  const W = Math.max(w, 240);
  const pad = { l: W < 420 ? 38 : 46, r: 12, t: 14, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const span = Math.max(1, monthDays - 1);

  const maxVal = Math.max(0, ...values);
  const showCap = mode === "cumulative" && !!cap && cap > 0 && cap <= Math.max(maxVal, projected ?? 0) * 4 + 1;
  // the domain follows the data and the cap; a projection far above them is clipped at the top edge instead of squashing the data
  const reach = Math.max(maxVal, showCap ? (cap as number) : 0);
  const top = Math.max(reach, mode === "cumulative" ? Math.min(projected ?? 0, reach * 1.8) : 0);
  const { max: yMax, step } = niceScale(top * 1.04);
  const x = (i: number) => pad.l + (dayIndex(monthStart, days[i].day) / span) * iw;
  const y = (v: number) => pad.t + ih - (Math.min(v, yMax) / yMax) * ih;

  const ticks: number[] = [];
  for (let v = 0; v <= yMax + step / 100; v += step) ticks.push(+v.toFixed(6));

  const pts = values.map((v, i) => [x(i), y(v)] as const);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const first = pts[0];
  const area = pts.length ? `${line} L${last[0].toFixed(1)} ${(pad.t + ih).toFixed(1)} L${first[0].toFixed(1)} ${(pad.t + ih).toFixed(1)} Z` : "";
  const todayIdx = pts.length ? dayIndex(monthStart, days[days.length - 1].day) : 0;
  const hasFuture = todayIdx < monthDays - 1;
  const vLast = values[values.length - 1] ?? 0;
  const proj = mode === "cumulative" && projected && projected > vLast && hasFuture && pts.length
    ? [last, projected > yMax
      ? [last[0] + ((yMax - vLast) / (projected - vLast)) * (pad.l + iw - last[0]), y(yMax)] as const
      : [pad.l + iw, y(projected)] as const] : null;

  // x labels: day of the month, thinned to fit the width
  const maxLabels = Math.max(3, Math.floor(iw / 58));
  const every = [1, 2, 3, 5, 7, 10, 14].find((s) => Math.ceil(monthDays / s) <= maxLabels) ?? 14;
  const xLabels: { i: number; text: string }[] = [];
  for (let i = 0; i < monthDays; i += every) {
    const d = addDays(monthStart, i);
    xLabels.push({ i, text: i === 0 ? `${new Date(d).getDate()} ${monthShort(d)}` : String(new Date(d).getDate()) });
  }

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!pts.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left + pad.l;
    let best = 0, bd = Infinity;
    pts.forEach(([cx], i) => { const dd = Math.abs(cx - px); if (dd < bd) { bd = dd; best = i; } });
    setHover(best);
  };

  const shown = hover ?? (pts.length ? pts.length - 1 : null);
  const readout = shown !== null && days[shown]
    ? { day: dayFmt(days[shown].day), v: values[shown], daily: days[shown].usd, count: days[shown].count }
    : null;

  return (
    <figure className="m-0">
      <div className="mono mb-1 flex min-h-5 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-2xs text-dim" aria-hidden>
        <span>{readout ? readout.day : "—"}</span>
        {readout && (
          <span className="flex items-baseline gap-3">
            <span><span className="text-money">{money(readout.v)}</span> {mode === "daily" ? t("that day") : t("running total")}</span>
            {mode === "cumulative" && <span>{money(readout.daily)} {t("that day")}</span>}
            <span>{t("{n} charges", { n: readout.count })}</span>
          </span>
        )}
      </div>
      <div ref={box} className="w-full">
        <svg role="img" aria-label={summary} width={W} height={height} viewBox={`0 0 ${W} ${height}`} className="block max-w-full select-none overflow-visible">
          <defs>
            <linearGradient id={`${gid}-fill`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--color-money)" stopOpacity="0.30" />
              <stop offset="1" stopColor="var(--color-money)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* grid + y axis */}
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeWidth="1" />
              <text x={pad.l - 8} y={y(v) + 3.5} textAnchor="end" className="mono fill-dim text-2xs">{axisMoney(v)}</text>
            </g>
          ))}
          {/* x axis */}
          {xLabels.map(({ i, text }) => (
            <text key={i} x={pad.l + (i / span) * iw} y={height - 6} textAnchor={i === 0 ? "start" : "middle"} className="mono fill-dim text-2xs">{text}</text>
          ))}
          {hasFuture && pts.length > 0 && <line x1={last[0]} x2={last[0]} y1={pad.t} y2={pad.t + ih} stroke="var(--color-line)" strokeDasharray="2 3" />}
          {showCap && (
            <g>
              <line x1={pad.l} x2={pad.l + iw} y1={y(cap as number)} y2={y(cap as number)} stroke="var(--color-mute)" strokeWidth="1" strokeDasharray="5 4" />
              <text x={pad.l + iw} y={y(cap as number) - 5} textAnchor="end" className="mono fill-mute text-2xs">{t("Cap")} {axisMoney(cap as number)}</text>
            </g>
          )}
          {/* the data */}
          {pts.length > 0 && <path d={area} fill={`url(#${gid}-fill)`} />}
          {pts.length > 1 && <path d={line} fill="none" stroke="var(--color-money)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />}
          {proj && <line x1={proj[0][0]} y1={proj[0][1]} x2={proj[1][0]} y2={proj[1][1]} stroke="var(--color-money)" strokeOpacity="0.6" strokeWidth="1.5" strokeDasharray="4 4" />}
          {pts.length > 0 && <circle cx={last[0]} cy={last[1]} r="3.5" fill="var(--color-panel)" stroke="var(--color-money)" strokeWidth="2" />}
          {/* hover */}
          {hover !== null && pts[hover] && (
            <g>
              <line x1={pts[hover][0]} x2={pts[hover][0]} y1={pad.t} y2={pad.t + ih} stroke="var(--color-dim)" strokeWidth="1" />
              <circle cx={pts[hover][0]} cy={pts[hover][1]} r="4" fill="var(--color-money)" stroke="var(--color-panel)" strokeWidth="2" />
            </g>
          )}
          <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" className="touch-pan-y" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}
