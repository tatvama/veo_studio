/**
 * Engine lab (/dev/engine): the GPU render engine on its own. Procedural test media by default (no server media),
 * every transition with its params, the effect registry (a browser and a chain with controls built from each effect's
 * declared params), the studio cut or the editor's multi-track scene (transition at a cut, nested composition, title,
 * adjustment clip), playback resolution, a context-loss button, play / scrub. `?eid=<id>` plays a real episode.
 * `?selftest=1` renders every transition and effect (window.__engineSelfTest + a contact sheet), `?yuvtest=1`
 * checks the YUV read-back (window.__engineYuvTest), `?bench=1` times 1080p / 4K frames (window.__engineBench);
 * window.__engineParity(ref) / __engineFxParity(ref) compare the xfade transitions / adjust effects with FFmpeg frames.
 * Not linked from the app.
 */
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Cpu, Pause, Play, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Field, Input, Page, PageHeader, SearchField, Section, Select, Toggle } from "../../components/ui";
import { api } from "../../lib/api";
import { ADJUST_INFO, MOVE_LABELS, type AdjustKey, type MoveKind } from "../../lib/fx";
import { useEpisode, useProject } from "../../lib/queries";
import { Rng } from "../project/production/instruments";
import type { LayersDoc } from "../project/production/timeline/Layers";
import type { Engine, EffectInfo, EffectParamDef, TransitionInfo } from "../../engine";
import type { Composition, ShotFx, BlendMode, Easing, Clip, EffectInstance } from "../../engine/types";
import type { Lut3D } from "../../engine/cube";

type EngineMod = typeof import("../../engine");
type LabMod = typeof import("../../engine/lab/selftest");
declare global {
  interface Window { __engineSelfTest?: unknown; __engineYuvTest?: unknown; __engineBench?: unknown; __engineParity?: (ref: unknown) => Promise<unknown>; __engineFxParity?: (ref: unknown) => Promise<unknown>; __engineMod?: EngineMod; __engineProbe?: (url: string, k: number, o?: { hardware?: boolean }) => Promise<unknown>; __engine?: Engine }
}

const q = new URLSearchParams(location.search);
const EID = Number(q.get("eid")) || 0;
const ADJ = Object.keys(ADJUST_INFO) as AdjustKey[];
const BLENDS: BlendMode[] = ["normal", "add", "multiply", "screen", "overlay", "lighten", "darken"];
const EASE: Easing[] = ["linear", "ease_in", "ease_out", "ease_in_out"];
const pts = (s: string): [number, number][] => s.trim().split(/\s+/).map((p) => p.split(",").map(Number) as [number, number]).filter((p) => p.length === 2 && p.every(Number.isFinite));

export default function EngineLab() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sheet = useRef<HTMLCanvasElement>(null);
  const [mod, setMod] = useState<EngineMod | null>(null);
  const [eng, setEng] = useState<Engine | null>(null);
  const [list, setList] = useState<TransitionInfo[]>([]);
  const [err, setErr] = useState("");
  const [tr, setTr] = useState("fade");
  const [dur, setDur] = useState(1);
  const [easing, setEasing] = useState<Easing>("linear");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [fx, setFx] = useState<ShotFx>({});
  const [layer, setLayer] = useState(true);
  const [blend, setBlend] = useState<BlendMode>("normal");
  const [lut, setLut] = useState<Lut3D | null>(null);
  const [search, setSearch] = useState("");
  const [t, setT] = useState(2.6);
  const [playing, setPlaying] = useState(false);
  const [stat, setStat] = useState({ ms: 0, passes: 0 });
  const [report, setReport] = useState("");
  const [scene, setScene] = useState<"studio" | "editor">("editor");
  const [chain, setChain] = useState<EffectInstance[]>([]);
  const [fxList, setFxList] = useState<EffectInfo[]>([]);
  const [fxSearch, setFxSearch] = useState("");
  const [res, setRes] = useState(1);
  const [demo, setDemo] = useState<typeof import("../../engine/lab/demo") | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  // real episode (optional)
  const { data: ep } = useEpisode(EID || undefined);
  const { data: project } = useProject(ep?.project_id ?? 0);
  const { data: layersDoc } = useQuery({ queryKey: ["layers", EID], queryFn: () => api.get<LayersDoc>(`/api/episodes/${EID}/layers`), enabled: !!EID });

  useEffect(() => {
    let dead = false, made: Engine | null = null;
    (async () => {
      try {
        const m = await import("../../engine");
        if (dead || !canvas.current) return;
        made = await m.createEngine({ canvas: canvas.current, width: 960, height: 540 });
        if (dead) { made.dispose(); return; }
        window.__engine = made;
        window.__engineMod = m;
        setMod(m); setEng(made); setList(await m.listTransitions()); setFxList(m.listEffects());
        setDemo(await import("../../engine/lab/demo"));
        const lab: LabMod = await import("../../engine/lab/selftest");
        window.__engineParity = (ref) => lab.runParity(ref as Parameters<LabMod["runParity"]>[0]);
        window.__engineFxParity = (ref) => lab.runFxParity(ref as Parameters<LabMod["runFxParity"]>[0]);
        window.__engineProbe = async (url: string, k: number, o?: { hardware?: boolean }) => (await import("../../engine/lab/probe")).probeDecode(url, k, o);
        if (q.get("selftest")) { setReport("Running the self-test…"); const r = await lab.runSelfTest(sheet.current ?? undefined); window.__engineSelfTest = r; setReport(JSON.stringify({ ...r, items: undefined }, null, 1)); }
        if (q.get("yuvtest")) { const r = await lab.runYuvTest(); window.__engineYuvTest = r; setReport((s) => s + "\n" + JSON.stringify(r, null, 1)); }
        if (q.get("bench")) { const r = await lab.runBench(); window.__engineBench = r; setReport((s) => s + "\n" + JSON.stringify(r, null, 1)); }
      } catch (e) { setErr((e as Error).message); }
    })();
    return () => { dead = true; made?.dispose(); };
  }, []);

  const sources = useRef<Record<string, import("../../engine").CustomSource> | null>(null);

  const comp: Composition | null = useMemo(() => {
    if (!mod) return null;
    if (EID) {
      if (!ep || !project) return null;
      return mod.fromEpisode(ep, layersDoc ?? null, { aspect: project.aspect, height: 540, pixelScale: 0.5 });
    }
    const clipFx: ShotFx = { ...fx, ...(lut ? { look: "lab:lut" } : {}) };
    if (scene === "editor") {
      if (!demo) return null;
      const c = demo.editorDemo({ transition: tr, duration: dur, chain });
      for (const cl of c.tracks[0].clips) cl.fx = clipFx;
      if (c.tracks[0].transitions?.[0]) Object.assign(c.tracks[0].transitions[0], { params, easing });
      return c;
    }
    const a: Clip = { id: "a", media: { url: "lab:a", kind: "video" }, start: 0, duration: 4, in: 0, speed: 1, fit: "cover", fx: clipFx, label: "A", effects: chain };
    const b: Clip = { id: "b", media: { url: "lab:b", kind: "video" }, start: 4 - dur, duration: 4, in: 0, speed: 1, fit: "cover", fx: clipFx, label: "B", effects: chain,
      transitionIn: { type: tr, duration: dur, params: params as Record<string, number>, easing } };
    const logo: Clip = { id: "logo", media: { url: "lab:logo", kind: "image" }, start: 0.5, duration: 6.5, in: 0, speed: 1, fit: "contain", fx: { fade_in: 0.5 },
      transform: { x: 0.5, y: 0.5, scale: 0.18, rotation: 0, opacity: 0.95, keyframes: [{ t: 0, x: 0.15, y: 0.2, rotation: -20 }, { t: 6.5, x: 0.85, y: 0.25, rotation: 25, easing: "ease_in_out" }] } };
    return { width: 1920, height: 1080, fps: 24, duration: 8 - dur,
      tracks: [{ id: "main", kind: "main", clips: [a, b] }, ...(layer ? [{ id: "l", kind: "layer" as const, blend, clips: [logo] }] : [])] };
  }, [mod, ep, project, layersDoc, fx, lut, tr, dur, params, easing, layer, blend, scene, chain, demo]);

  useEffect(() => {
    if (!eng || !comp) return;
    let dead = false;
    (async () => {
      if (!sources.current) {
        const m = await import("../../engine/lab/media");
        sources.current = { "lab:a": m.procedural("A"), "lab:b": m.procedural("B"), "lab:logo": m.badge(512) };
      }
      await eng.load(comp, { mode: "live", sources: sources.current, luts: lut ? { "lab:lut": lut } : undefined });
      if (!dead) eng.drawLive(tRef.current, { playing: false, resolution: res });
    })().catch((e) => setErr((e as Error).message));
    return () => { dead = true; };
  }, [eng, comp, lut]);

  useEffect(() => {
    if (!eng || !comp) return;
    if (!playing) { const p0 = eng.stats.passes; eng.drawLive(t, { playing: false, resolution: res }); setStat({ ms: eng.stats.lastMs, passes: eng.stats.passes - p0 }); return; }
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      const nt = (tRef.current + (now - last) / 1000) % Math.max(comp.duration, 0.1);
      last = now;
      tRef.current = nt;
      const p0 = eng.stats.passes;
      eng.drawLive(nt, { playing: true, resolution: res });
      setT(nt);
      setStat({ ms: eng.stats.lastMs, passes: eng.stats.passes - p0 });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, comp, playing, playing ? 0 : t, res]);

  const info = list.find((x) => x.id === tr);
  const groups = useMemo(() => {
    const s = search.trim().toLowerCase();
    const out = new Map<string, TransitionInfo[]>();
    for (const x of list) {
      if (s && !`${x.id} ${x.label} ${x.tags.join(" ")}`.toLowerCase().includes(s)) continue;
      const g = (x.kind === "gl" ? "GL · " : "") + x.group;
      out.set(g, [...(out.get(g) ?? []), x]);
    }
    return [...out.entries()];
  }, [list, search]);
  const fxGroups = useMemo(() => {
    const s = fxSearch.trim().toLowerCase();
    const out = new Map<string, EffectInfo[]>();
    for (const e of fxList) {
      if (s && !`${e.id} ${e.label} ${e.group} ${e.source ?? ""}`.toLowerCase().includes(s)) continue;
      out.set(e.group, [...(out.get(e.group) ?? []), e]);
    }
    return [...out.entries()];
  }, [fxList, fxSearch]);
  const addFx = (e: EffectInfo) => setChain((c) => [...c, { id: `${e.id}-${Date.now().toString(36)}`, type: e.id, enabled: true, params: {} }]);
  const editFx = (i: number, f: (x: EffectInstance) => EffectInstance | null) => setChain((c) => c.flatMap((x, k) => (k === i ? (f(x) ? [f(x)!] : []) : [x])));
  const loseContext = () => {
    const gl = eng?.renderer.b.gl, ext = gl?.getExtension("WEBGL_lose_context");
    if (!ext) return;
    ext.loseContext();
    setTimeout(() => { ext.restoreContext(); setTimeout(() => eng?.drawLive(tRef.current, { resolution: res }), 300); }, 1000);
  };
  const setAdj = (k: AdjustKey, v: number) => setFx((f) => ({ ...f, adjust: { ...(f.adjust ?? {}), [k]: v } }));
  const setPart = <K extends keyof ShotFx>(k: K, v: ShotFx[K]) => setFx((f) => ({ ...f, [k]: v }));

  const loadCube = async (file: File) => {
    try { const { parseCube } = await import("../../engine/cube"); setLut(parseCube(await file.text())); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <Page width="wide">
      <PageHeader title="Engine lab" subtitle="The GPU render engine: every transition and effect on procedural media, or a real episode with ?eid=" icon={<Cpu className="size-5" />}
        actions={eng && <Badge tone={eng.floatTargets ? "ok" : "warn"}>{eng.floatTargets ? "half-float targets" : "8-bit targets"}</Badge>} />
      {err && <p className="mb-3 rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{err}</p>}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,960px)_1fr]">
        <div className="space-y-3">
          <canvas ref={canvas} width={960} height={540} className="block aspect-video w-full rounded-lg border border-line bg-black" data-engine-canvas />
          <div className="flex items-center gap-3">
            <Button size="sm" variant="primary" icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</Button>
            <Rng min={0} max={Math.max(comp?.duration ?? 1, 0.1)} step={1 / 96} value={t} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Time" />
            <span className="w-40 shrink-0 font-mono text-xs text-mute tabular-nums">{t.toFixed(2)} s · {stat.ms.toFixed(1)} ms · {stat.passes} passes</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Select value={scene} onChange={(e) => setScene(e.target.value as "studio" | "editor")} aria-label="Scene" className="w-56">
              <option value="editor">Editor tracks (V1 cut, nested, title, adjustment)</option><option value="studio">Studio cut (main + layer)</option>
            </Select>
            <Select value={String(res)} onChange={(e) => setRes(Number(e.target.value))} aria-label="Playback resolution" className="w-32">
              <option value="1">Full</option><option value="0.5">½</option><option value="0.25">¼</option>
            </Select>
            <Button size="sm" onClick={loseContext}>Lose the GPU context</Button>
            {eng && <span className="text-xs text-mute">{eng.stats.restores} restores</span>}
          </div>
          {!!eng?.warnings.length && <ul className="space-y-1 text-xs text-warn">{eng.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          {report && <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-panel p-3 text-2xs" data-engine-report>{report}</pre>}
          <canvas ref={sheet} width={0} height={0} className="block max-w-full rounded-lg" data-engine-sheet />
        </div>
        <div className="space-y-4">
          <Section title={`Transition · ${info?.label ?? tr}`} description={info?.kind === "gl" ? `${info.author ?? ""} · ${info.license ?? ""} — ${info.description ?? ""}` : "FFmpeg xfade, drawn on the GPU"}>
            <SearchField value={search} onChange={setSearch} placeholder={`Search ${list.length} transitions`} />
            <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-line p-2">
              {groups.map(([g, items]) => (
                <div key={g} className="mb-2">
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-dim">{g}</p>
                  <div className="flex flex-wrap gap-1">
                    {items.map((x) => (
                      <button key={x.id} type="button" onClick={() => { setTr(x.id); setParams({}); setT(4 - dur / 2); setPlaying(false); }}
                        className={`rounded-md px-2 py-0.5 text-xs ${x.id === tr ? "bg-accent text-black" : "bg-raised text-ink hover:bg-hover"}`}>{x.label}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label={`Duration ${dur.toFixed(2)} s`}><Rng min={0.1} max={2.5} step={0.05} value={dur} onChange={(e) => setDur(Number(e.target.value))} /></Field>
              <Field label="Easing"><Select value={easing} onChange={(e) => setEasing(e.target.value as Easing)}>{EASE.map((x) => <option key={x}>{x}</option>)}</Select></Field>
            </div>
            {!!info?.params.length && (
              <div className="mt-3 space-y-2">
                {info.params.map((p) => {
                  const v = params[p.name] ?? p.default;
                  const set = (nv: unknown) => setParams((s) => ({ ...s, [p.name]: nv }));
                  if (p.type === "bool") return <Toggle key={p.name} checked={!!v} onChange={set} label={p.name} />;
                  if (Array.isArray(p.default)) return (
                    <Field key={p.name} label={`${p.name} (${p.type})`} hint={p.description}>
                      <div className="flex gap-1">{(v as number[]).map((x, i) => <Input key={i} type="number" step={0.05} value={x}
                        onChange={(e) => { const a = [...(v as number[])]; a[i] = Number(e.target.value); set(a); }} />)}</div>
                    </Field>
                  );
                  const d = Number(p.default) || 1, lo = p.min ?? Math.min(0, d * 2), hi = p.max ?? Math.max(1, d * 2);
                  return (
                    <Field key={p.name} label={`${p.name} = ${Number(v).toFixed(p.type === "int" ? 0 : 3)}`} hint={p.description}>
                      <Rng min={lo} max={hi} step={p.step ?? (p.type === "int" ? 1 : (hi - lo) / 200)} value={Number(v)} onChange={(e) => set(Number(e.target.value))} />
                    </Field>
                  );
                })}
              </div>
            )}
          </Section>
          <Section title={`Effects · ${fxList.length}`} description="The registry: click to add to both V1 clips' chain; controls come from each effect's params">
            <SearchField value={fxSearch} onChange={setFxSearch} placeholder={`Search ${fxList.length} effects`} />
            <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-line p-2">
              {fxGroups.map(([g, items]) => (
                <div key={g} className="mb-2">
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-dim">{g}</p>
                  <div className="flex flex-wrap gap-1">
                    {items.map((e) => (
                      <button key={e.id} type="button" title={`${e.description ?? ""}${e.source ? ` · ${e.source}` : ""}${e.license ? ` · ${e.license}` : ""}`} onClick={() => addFx(e)}
                        className="rounded-md bg-raised px-2 py-0.5 text-xs text-ink hover:bg-hover">{e.label}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-3">
              {chain.map((inst, i) => {
                const info = fxList.find((e) => e.id === inst.type);
                return (
                  <div key={inst.id} className="rounded-lg border border-line p-2">
                    <div className="mb-2 flex items-center gap-2">
                      <Toggle checked={inst.enabled !== false} onChange={(v) => editFx(i, (x) => ({ ...x, enabled: v }))} label={info?.label ?? inst.type} />
                      <span className="flex-1 truncate text-2xs text-dim">{info?.source ?? info?.author}</span>
                      {i > 0 && <button type="button" aria-label="Move up" onClick={() => setChain((c) => { const n = [...c]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}><ArrowUp className="size-4" /></button>}
                      <button type="button" aria-label="Remove" onClick={() => editFx(i, () => null)}><Trash2 className="size-4" /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                      {info?.params.map((p) => (
                        <ParamControl key={p.name} p={p} value={inst.params?.[p.name] ?? p.default}
                          onChange={(v) => editFx(i, (x) => ({ ...x, params: { ...(x.params ?? {}), [p.name]: v } }))} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
          <Section title="Adjust">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {ADJ.map((k) => (
                <Field key={k} label={`${ADJUST_INFO[k].label} ${(fx.adjust?.[k] ?? 0).toFixed(2)}`}>
                  <Rng min={ADJUST_INFO[k].min} max={1} step={0.01} value={fx.adjust?.[k] ?? 0} onChange={(e) => setAdj(k, Number(e.target.value))} />
                </Field>
              ))}
            </div>
          </Section>
          <Section title="Look">
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm"><Upload className="size-4" />{lut ? `LUT ${lut.size}³ ${lut.title}` : "Load a .cube LUT"}
                <input type="file" accept=".cube" className="hidden" onChange={(e) => e.target.files?.[0] && loadCube(e.target.files[0])} /></label>
              {lut && <Button size="sm" onClick={() => setLut(null)}>Remove</Button>}
              <Field label={`Strength ${(fx.lut_strength ?? 1).toFixed(2)}`} className="min-w-40 flex-1"><Rng min={0} max={1} step={0.01} value={fx.lut_strength ?? 1} onChange={(e) => setPart("lut_strength", Number(e.target.value))} /></Field>
            </div>
          </Section>
          <Section title="Colour wheels">
            {(["lift", "gamma", "gain"] as const).map((w) => (
              <div key={w} className="mb-2 grid grid-cols-[3.5rem_1fr_1fr_1fr] items-center gap-2 text-xs">
                <span className="text-mute">{w}</span>
                {[0, 1, 2].map((i) => {
                  const cur = fx.wheels?.[w] ?? [0, 0, 0];
                  return <Rng key={i} min={-1} max={1} step={0.01} value={cur[i]} aria-label={`${w} ${"rgb"[i]}`}
                    onChange={(e) => { const nv = [...cur] as [number, number, number]; nv[i] = Number(e.target.value); setPart("wheels", { ...(fx.wheels ?? {}), [w]: nv }); }} />;
                })}
              </div>
            ))}
          </Section>
          <Section title="Curves" description="Points as x,y pairs, e.g. 0,0 0.5,0.62 1,1">
            {(["master", "r", "g", "b"] as const).map((k) => (
              <Field key={k} label={k} className="mb-2">
                <Input defaultValue="" placeholder="0,0 1,1" onChange={(e) => { const p = pts(e.target.value); setPart("curves", { ...(fx.curves ?? {}), [k]: p.length >= 2 ? p : undefined }); }} />
              </Field>
            ))}
          </Section>
          <Section title="Chroma key">
            <div className="grid grid-cols-2 gap-3">
              <Toggle checked={!!fx.chroma} onChange={(on) => setPart("chroma", on ? { color: "#00C000", similarity: 0.15, smoothness: 0.08, spill: 0.1 } : undefined)} label="On" />
              {fx.chroma && <input type="color" value={fx.chroma.color} onChange={(e) => setPart("chroma", { ...fx.chroma!, color: e.target.value })} aria-label="Key colour" />}
              {fx.chroma && (["similarity", "smoothness", "spill"] as const).map((k) => (
                <Field key={k} label={`${k} ${fx.chroma![k].toFixed(2)}`}><Rng min={0} max={1} step={0.01} value={fx.chroma![k]} onChange={(e) => setPart("chroma", { ...fx.chroma!, [k]: Number(e.target.value) })} /></Field>
              ))}
            </div>
          </Section>
          <Section title="Mask">
            <div className="grid grid-cols-2 gap-3">
              <Toggle checked={!!fx.mask} onChange={(on) => setPart("mask", on ? { shape: "ellipse", x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, feather: 0.2, invert: false } : undefined)} label="On" />
              {fx.mask && <Select value={fx.mask.shape} onChange={(e) => setPart("mask", { ...fx.mask!, shape: e.target.value as "rect" | "ellipse" })}><option>rect</option><option>ellipse</option></Select>}
              {fx.mask && (["x", "y", "w", "h", "feather"] as const).map((k) => (
                <Field key={k} label={`${k} ${(fx.mask![k] ?? 0).toFixed(2)}`}><Rng min={0} max={1} step={0.01} value={fx.mask![k] ?? 0} onChange={(e) => setPart("mask", { ...fx.mask!, [k]: Number(e.target.value) })} /></Field>
              ))}
              {fx.mask && <Field label={`rotation ${fx.mask.rotation ?? 0}°`}><Rng min={-180} max={180} step={1} value={fx.mask.rotation ?? 0} onChange={(e) => setPart("mask", { ...fx.mask!, rotation: Number(e.target.value) })} /></Field>}
              {fx.mask && <Toggle checked={!!fx.mask.invert} onChange={(v) => setPart("mask", { ...fx.mask!, invert: v })} label="Invert" />}
            </div>
          </Section>
          <Section title="Glow">
            <div className="grid grid-cols-3 gap-3">
              {(["amount", "threshold", "radius"] as const).map((k) => (
                <Field key={k} label={`${k} ${(fx.glow?.[k] ?? 0).toFixed(2)}`}><Rng min={0} max={1} step={0.01} value={fx.glow?.[k] ?? (k === "threshold" ? 0.7 : k === "radius" ? 0.3 : 0)}
                  onChange={(e) => setPart("glow", { amount: 0, threshold: 0.7, radius: 0.3, ...(fx.glow ?? {}), [k]: Number(e.target.value) })} /></Field>
              ))}
            </div>
          </Section>
          <Section title="Clip">
            <div className="grid grid-cols-2 gap-3">
              <Toggle checked={!!fx.flip_h} onChange={(v) => setPart("flip_h", v)} label="Flip horizontally" />
              <Toggle checked={!!fx.flip_v} onChange={(v) => setPart("flip_v", v)} label="Flip vertically" />
              <Field label={`Fade in ${(fx.fade_in ?? 0).toFixed(1)} s`}><Rng min={0} max={3} step={0.1} value={fx.fade_in ?? 0} onChange={(e) => setPart("fade_in", Number(e.target.value) || undefined)} /></Field>
              <Field label={`Fade out ${(fx.fade_out ?? 0).toFixed(1)} s`}><Rng min={0} max={3} step={0.1} value={fx.fade_out ?? 0} onChange={(e) => setPart("fade_out", Number(e.target.value) || undefined)} /></Field>
              <Field label="Camera move"><Select value={fx.move?.kind ?? "none"} onChange={(e) => setPart("move", { kind: e.target.value as MoveKind, amount: fx.move?.amount ?? 0.15 })}>
                {(Object.keys(MOVE_LABELS) as MoveKind[]).map((k) => <option key={k} value={k}>{MOVE_LABELS[k]}</option>)}</Select></Field>
              <Field label={`Move amount ${(fx.move?.amount ?? 0.15).toFixed(2)}`}><Rng min={0.02} max={0.5} step={0.01} value={fx.move?.amount ?? 0.15} onChange={(e) => setPart("move", { kind: fx.move?.kind ?? "zoom_in", amount: Number(e.target.value) })} /></Field>
              <Toggle checked={layer} onChange={setLayer} label="Layer" />
              <Select value={blend} onChange={(e) => setBlend(e.target.value as BlendMode)} aria-label="Blend mode">{BLENDS.map((x) => <option key={x}>{x}</option>)}</Select>
            </div>
          </Section>
        </div>
      </div>
    </Page>
  );
}

/** A control for one declared effect parameter (EffectParamDef). */
function ParamControl({ p, value, onChange }: { p: EffectParamDef; value: unknown; onChange: (v: unknown) => void }) {
  const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const label = `${p.label}${p.unit ? ` (${p.unit})` : ""}`;
  switch (p.type) {
    case "float": case "int": case "angle": {
      const v = num(value, num(p.default)), lo = p.min ?? Math.min(0, v * 2), hi = p.max ?? Math.max(1, v * 2);
      return <Field label={`${label} ${v.toFixed(p.type === "int" ? 0 : 2)}`}><Rng min={lo} max={hi} step={p.step ?? (p.type === "int" ? 1 : (hi - lo) / 200)} value={v} onChange={(e) => onChange(Number(e.target.value))} /></Field>;
    }
    case "bool": return <Toggle checked={!!value} onChange={onChange} label={p.label} />;
    case "enum": return (
      <Field label={label}><Select value={String(value)} onChange={(e) => { const o = p.options?.find((x) => String(x.value) === e.target.value); onChange(o ? o.value : e.target.value); }}>
        {p.options?.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}</Select></Field>
    );
    case "color": case "rgba": return <Field label={label}><input type="color" value={typeof value === "string" ? value.slice(0, 7) : "#ffffff"} onChange={(e) => onChange(e.target.value)} aria-label={p.label} /></Field>;
    case "rgb": case "vec2": case "point": {
      const arr = Array.isArray(value) ? (value as number[]) : Array.isArray(p.default) ? (p.default as number[]) : [0, 0];
      return (
        <Field label={label}><div className="flex gap-1">{arr.map((x, k) => <Input key={k} type="number" step={p.step ?? 0.01} value={x}
          onChange={(e) => { const n = [...arr]; n[k] = Number(e.target.value); onChange(n); }} />)}</div></Field>
      );
    }
    case "curve": return <Field label={`${label} (x,y …)`}><Input defaultValue="" placeholder="0,0 1,1" onChange={(e) => { const q = pts(e.target.value); if (q.length >= 2) onChange(q); }} /></Field>;
    case "image": case "string": return <Field label={label}><Input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} /></Field>;
    default: return null;
  }
}
