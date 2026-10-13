/**
 * The News Room graphics lab (dev builds only, no sign-in): every built-in template drawn by the real renderer, in
 * 16:9, 9:16 or both, in any look, with editable values, play / pause / scrub / loop, and contact sheets per category.
 * Template builders check their work here by eye and with headless screenshots. When the canvases have drawn (fonts
 * and pictures loaded), `document.title` becomes "ready".
 *
 * URL patterns (all query params optional):
 *   /editor/gfx-lab?template=<id>&ratio=16:9|9:16|both&t=<seconds>&look=<look id>&values=<URL-encoded JSON>&w=<px>
 *   /editor/gfx-lab?grid=<Category>&t=<seconds>&ratio=16:9|9:16|both&look=<look id>&w=<cell px>
 *   (Category: Tickers, Bugs, Straps, Boards, Layouts, Stingers, Openers, Backgrounds, or Lab for the core's samples)
 *   extra: bg=studio|checker|black|grey (backdrop), avoid=1 (a ticker on screen: straps / boards lift), dur=<s>,
 *   engine=1 (with template=: the real path, a throwaway edit → buildComposition → the GPU engine preview at t)
 *   perf=1 (with template= or grid=: ms per 1920×1080 draw, avg and worst over 120 frames; budget 2 ms)
 *   `t` freezes the frame (no playback); without it the template plays and loops.
 * Examples:
 *   http://localhost:5190/editor/gfx-lab?template=nr.straps.anchor&ratio=both&t=2
 *   http://localhost:5190/editor/gfx-lab?grid=Straps&t=2.5&w=480
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "../../../pages/posters/fonts";
import { BUILTIN_LOOKS, builtinLook, DEFAULT_LOOK_ID } from "../looks";
import { drawGraphic, ensureGraphicAssets } from "../render";
import type { GfxRenderInput } from "../render/contract";
import { onAssets } from "../render/images";
import { builtinTemplate, builtinTemplates, GFX_CATEGORIES, templatesIn } from "../templates";
import { defaults } from "../templates/kit";
import type { ChannelLook, GfxRatio, GfxTemplate, GfxValue } from "../types";
import EngineCheck from "./EngineCheck";
import { LAB_SAMPLES, labSample } from "./samples";

const q = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const num = (k: string): number | null => { const v = q.get(k); const n = v === null || v === "" ? NaN : Number(v); return Number.isFinite(n) ? n : null; };

/** The length a template plays for in the lab. */
const lengthOf = (t: GfxTemplate) => num("dur") ?? (t.seconds > 0 ? t.seconds : t.loop ? 12 : 8);

function parseValues(s: string | null): Record<string, GfxValue> {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

const BACKDROPS: Record<string, string> = {
  studio: "radial-gradient(120% 90% at 30% 25%, #3a4a63 0%, #1d2638 45%, #0c111c 100%), linear-gradient(90deg,#0000,#0000)",
  checker: "repeating-conic-gradient(#2a2a2a 0% 25%, #3a3a3a 0% 50%) 50% / 24px 24px",
  black: "#000", grey: "#808080",
};

function inputFor(t: GfxTemplate, look: ChannelLook, values: Record<string, GfxValue>, ratio: GfxRatio, avoid: boolean): GfxRenderInput {
  return {
    template: t, values: { ...defaults(t), ...values }, look, images: {}, seed: 7, fps: 25, ratio,
    ...(avoid ? { avoid: [{ role: "ticker", box: ratio === "9:16" ? [0, 0.7, 1, 0.07] : [0, 0.86, 1, 0.09] }] } : {}),
  };
}

/** A canvas that draws one graphic at time t (css width w). Calls onDrawn after the first draw with assets in. */
function GfxCanvas({ input, ratio, w, t, dur, onDrawn, onMs }: { input: GfxRenderInput; ratio: GfxRatio; w: number; t: number; dur: number; onDrawn?: () => void; onMs?: (ms: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);
  const aspect = ratio === "9:16" ? 9 / 16 : ratio === "1:1" ? 1 : ratio === "4:5" ? 0.8 : 16 / 9;
  const h = Math.round(w / aspect);
  const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  useEffect(() => { let on = true; setReady(false); void ensureGraphicAssets(input).then(() => { if (on) setReady(true); }); return () => { on = false; }; }, [input]);
  useEffect(() => onAssets(() => setTick((x) => x + 1)), []);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const t0 = performance.now();
    drawGraphic(g, input, W, H, t, dur);
    onMs?.(performance.now() - t0);
    if (ready) onDrawn?.();
  }, [input, W, H, t, dur, ready, tick, onDrawn, onMs]);
  return <canvas ref={ref} width={W} height={H} style={{ width: w, height: h, display: "block", background: BACKDROPS[q.get("bg") ?? "studio"] ?? BACKDROPS.studio, borderRadius: 4 }} />;
}

/**
 * Speed check (`perf=1`): every template of the category (or the one chosen) drawn 1920×1080 at 120 times across its
 * length; average and worst ms per draw. The budget is 2 ms per graphic per frame.
 */
function Perf({ list, look }: { list: GfxTemplate[]; look: ChannelLook }) {
  const [rows, setRows] = useState<{ id: string; avg: number; max: number }[] | null>(null);
  useEffect(() => {
    void (async () => {
      const c = document.createElement("canvas");
      c.width = 1920; c.height = 1080;
      const g = c.getContext("2d")!;
      const out: { id: string; avg: number; max: number }[] = [];
      for (const tp of list) {
        const input = inputFor(tp, look, {}, "16:9", false);
        await ensureGraphicAssets(input);
        const len = lengthOf(tp);
        for (let i = 0; i < 10; i++) drawGraphic(g, input, 1920, 1080, (len * i) / 10, len);  // warm the caches
        let sum = 0, max = 0;
        for (let i = 0; i < 120; i++) {
          const t0 = performance.now();
          drawGraphic(g, input, 1920, 1080, (len * i) / 120, len);
          const ms = performance.now() - t0;
          sum += ms; max = Math.max(max, ms);
        }
        out.push({ id: tp.id, avg: sum / 120, max });
      }
      setRows(out);
      document.title = "ready";
    })();
  }, [list, look]);
  return (
    <pre style={{ color: "#d7dde6", font: "13px/1.5 ui-monospace, monospace", padding: 16 }}>
      {rows ? rows.map((r) => `${r.avg.toFixed(2).padStart(6)} ms avg ${r.max.toFixed(2).padStart(6)} ms max  ${r.avg > 2 ? "SLOW " : "     "}${r.id}`).join(String.fromCharCode(10)) : "Measuring…"}
    </pre>
  );
}

/** Contact sheet: every template of a category at time t, labelled with its id. */
function Grid({ category, look, ratio, t, w, avoid }: { category: string; look: ChannelLook; ratio: "16:9" | "9:16" | "both"; t: number; w: number; avoid: boolean }) {
  const list = category === "Lab" ? LAB_SAMPLES : templatesIn(category as GfxTemplate["category"]);
  const ratios: GfxRatio[] = ratio === "both" ? ["16:9", "9:16"] : [ratio];
  const total = list.length * ratios.length;
  const done = useRef(new Set<string>());
  const [, force] = useState(0);
  const inputs = useMemo(() => list.map((tp) => ratios.map((r) => inputFor(tp, look, {}, r, avoid))), [list, look, ratio, avoid]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!total) document.title = "ready"; }, [total]);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, padding: 12 }}>
      {list.map((tp, i) => (
        <figure key={tp.id} style={{ margin: 0 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
            {ratios.map((r, j) => (
              <GfxCanvas key={r} input={inputs[i][j]} ratio={r} w={r === "9:16" && ratios.length > 1 ? Math.round(w * 9 / 16 * 9 / 16) : r === "9:16" ? Math.round(w * 9 / 16) : w} t={Math.min(t, lengthOf(tp))} dur={lengthOf(tp)}
                onDrawn={() => { const k = `${tp.id}|${r}`; if (!done.current.has(k)) { done.current.add(k); if (done.current.size >= total) { document.title = "ready"; force((x) => x + 1); } } }} />
            ))}
          </div>
          <figcaption style={{ font: "11px/1.4 ui-monospace, monospace", color: "#9aa4b2", marginTop: 4 }}>{tp.id}</figcaption>
        </figure>
      ))}
      {!list.length && <p style={{ color: "#9aa4b2", font: "13px system-ui" }}>No templates in “{category}” yet.</p>}
    </div>
  );
}

export default function GfxLab() {
  const frozen = num("t");
  const [tplId, setTplId] = useState(q.get("template") ?? builtinTemplates()[0]?.id ?? LAB_SAMPLES[0].id);
  const [lookId, setLookId] = useState(q.get("look") ?? DEFAULT_LOOK_ID);
  const [ratio, setRatio] = useState<"16:9" | "9:16" | "both">((q.get("ratio") as "16:9" | "9:16" | "both") ?? "16:9");
  const [valuesText, setValuesText] = useState("");
  const [extra, setExtra] = useState<Record<string, GfxValue>>(() => parseValues(q.get("values")));
  const [t, setT] = useState(frozen ?? 0);
  const [playing, setPlaying] = useState(frozen === null);
  const [loop, setLoop] = useState(true);
  const [search, setSearch] = useState("");
  const [ms, setMs] = useState(0);
  const [avoid, setAvoid] = useState(q.get("avoid") === "1");
  const look = builtinLook(lookId) ?? BUILTIN_LOOKS[0];
  const tpl = builtinTemplate(tplId) ?? labSample(tplId);
  const dur = tpl ? lengthOf(tpl) : 8;
  const grid = q.get("grid");
  const w = num("w") ?? (ratio === "both" ? 880 : ratio === "9:16" ? 480 : 1100);

  useEffect(() => {
    document.title = "Graphics lab";
    // no sign-in here: the app's "Bad Gateway" toasts for its own API calls stay out of screenshots
    const st = document.createElement("style");
    st.textContent = "[data-sonner-toaster]{display:none!important}";
    document.head.appendChild(st);
    return () => st.remove();
  }, []);
  useEffect(() => { if (tpl) setValuesText(JSON.stringify({ ...defaults(tpl), ...extra }, null, 2)); }, [tplId]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setT((x) => { let n = x + dt; if (n > dur) n = loop ? 0 : dur; return n; });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, dur, loop]);

  const inputs = useMemo(() => {
    if (!tpl) return null;
    const rs: GfxRatio[] = ratio === "both" ? ["16:9", "9:16"] : [ratio];
    return rs.map((r) => ({ r, input: inputFor(tpl, look, extra, r, avoid) }));
  }, [tpl, look, extra, ratio, avoid]);

  const drawnRef = useRef(0);
  const onDrawn = useMemo(() => () => { drawnRef.current++; if (drawnRef.current >= (inputs?.length ?? 1)) document.title = "ready"; }, [inputs]);

  const S: Record<string, React.CSSProperties> = {
    root: { display: "flex", height: "100vh", background: "#0d1117", color: "#d7dde6", font: "12px/1.4 Inter Variable, system-ui, sans-serif" },
    side: { width: 260, borderRight: "1px solid #232a35", overflow: "auto", flexShrink: 0 },
    cat: { padding: "8px 10px 4px", fontSize: 11, fontWeight: 600, color: "#8a94a3", textTransform: "uppercase", letterSpacing: ".06em" },
    item: { display: "block", width: "100%", textAlign: "left", padding: "4px 10px", border: 0, background: "none", color: "inherit", cursor: "pointer" },
    bar: { display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #232a35", flexWrap: "wrap" },
    field: { background: "#161b22", color: "#d7dde6", border: "1px solid #2b3340", borderRadius: 6, height: 26, padding: "0 6px" },
  };

  if (q.get("engine") === "1" && tpl) {
    return <div style={{ minHeight: "100vh", background: "#0d1117" }}><EngineCheck template={tpl} lookId={lookId} t={frozen ?? 2} w={num("w") ?? 960} ratio={ratio === "9:16" ? "9:16" : "16:9"} /></div>;
  }
  if (q.get("perf") === "1") {
    const list = grid ? (grid === "Lab" ? LAB_SAMPLES : templatesIn(grid as GfxTemplate["category"])) : tpl ? [tpl] : [];
    return <div style={{ minHeight: "100vh", background: "#0d1117" }}><Perf list={list} look={look} /></div>;
  }
  if (grid) {
    return (
      <div style={{ minHeight: "100vh", background: "#0d1117" }}>
        <Grid category={grid} look={look} ratio={ratio} t={frozen ?? 2} w={num("w") ?? 480} avoid={avoid} />
      </div>
    );
  }

  const shown = builtinTemplates().filter((x) => !search || `${x.id} ${x.name}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div style={S.root}>
      <aside style={S.side}>
        <div style={{ padding: 8 }}><input style={{ ...S.field, width: "100%" }} placeholder="Find a template" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        {GFX_CATEGORIES.map((c) => {
          const items = shown.filter((x) => x.category === c);
          return (
            <div key={c}>
              <div style={S.cat}>{c} · {items.length}</div>
              {items.map((x) => (
                <button key={x.id} style={{ ...S.item, background: x.id === tplId ? "#1f2a3a" : "none" }} onClick={() => { setTplId(x.id); setExtra({}); drawnRef.current = 0; }} title={x.id}>
                  {x.name}<span style={{ color: "#6b7585", marginLeft: 6, fontSize: 10 }}>{x.id.split(".").slice(2).join(".")}</span>
                </button>
              ))}
            </div>
          );
        })}
        <div style={S.cat}>Lab samples</div>
        {LAB_SAMPLES.map((x) => (
          <button key={x.id} style={{ ...S.item, background: x.id === tplId ? "#1f2a3a" : "none" }} onClick={() => { setTplId(x.id); setExtra({}); drawnRef.current = 0; }}>{x.name}</button>
        ))}
      </aside>
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={S.bar}>
          <strong style={{ marginRight: 8 }}>{tpl?.name ?? "—"}</strong>
          <select style={S.field} value={ratio} onChange={(e) => setRatio(e.target.value as typeof ratio)}>
            <option value="16:9">16:9</option><option value="9:16">9:16</option><option value="both">Both</option>
          </select>
          <select style={S.field} value={lookId} onChange={(e) => setLookId(e.target.value)}>
            {BUILTIN_LOOKS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button style={S.field} onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
          <label><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop</label>
          <label><input type="checkbox" checked={avoid} onChange={(e) => setAvoid(e.target.checked)} /> Ticker on screen</label>
          <input type="range" min={0} max={dur} step={0.01} value={t} style={{ flex: 1, minWidth: 160 }} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} />
          <span style={{ fontVariantNumeric: "tabular-nums", width: 120 }}>{t.toFixed(2)} / {dur.toFixed(1)} s · {ms.toFixed(1)} ms</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16, padding: 16, overflow: "auto", alignItems: "flex-start" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            {inputs?.map(({ r, input }) => (
              <GfxCanvas key={r} input={input} ratio={r} w={r === "9:16" ? (ratio === "both" ? Math.round(w * 9 / 16 * 9 / 16) : w) : w} t={t} dur={dur} onDrawn={onDrawn} onMs={setMs} />
            ))}
            {!tpl && <p style={{ color: "#8a94a3" }}>Pick a template.</p>}
          </div>
          {tpl && frozen === null && (
            <div style={{ width: 300, flexShrink: 0 }}>
              <div style={S.cat}>Values</div>
              <textarea style={{ ...S.field, width: "100%", height: 420, padding: 6, fontFamily: "ui-monospace, monospace", fontSize: 11 }} value={valuesText}
                onChange={(e) => { setValuesText(e.target.value); try { setExtra(JSON.parse(e.target.value)); } catch { /* typing */ } }} />
              <p style={{ color: "#8a94a3" }}>{tpl.id} · {tpl.role} · {tpl.seconds ? `${tpl.seconds} s` : "fills"}{tpl.loop ? " · loops" : ""}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
