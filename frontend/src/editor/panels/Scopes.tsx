/**
 * Scopes (docs/EDITOR.md §10): waveform, RGB parade, vectorscope and histogram of the Program monitor's frame, about
 * ten times a second while the panel is on screen (paused when hidden) — the engine's GPU scopes when it has them,
 * else computed here from the monitor's read-back. The side bar holds the colour tools for the selected clip: camera
 * log input profile and output transform, auto white balance, shot match to another clip and a grade from a
 * reference picture. Each tool is one undoable command. `ScopesOverlay` is the small waveform the monitor can show.
 */
import { clsx } from "clsx";
import { Activity, ImagePlus, Loader2, Pipette, ScanEye, SplitSquareHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui";
import { videoEffects, type EffectDef } from "../effects";
import { useEditorHost } from "../host";
import { isMoodEffect } from "../moods/apply";
import { analyzeWb, lookCaps, matchLook, type LookCaps } from "../moods/engineLooks";
import { hasProgramScopes, readProgramFrame, readProgramScope } from "../moods/programTap";
import { scopeImage, type ScopeKind } from "../moods/scopes";
import { clipTime, useVisible } from "../moods/ui";
import { uid } from "../model/ids";
import { tracksOf } from "../model/ops";
import type { EditProject, EffectInstance, TimelineClip } from "../model/types";
import { program } from "../playback/transport";
import { setFocus, urlFor, useEditor, useProject, useSequence } from "../store";
import { keepMatchLut } from "../moods/matchLuts";

const KINDS: { id: ScopeKind; label: string }[] = [
  { id: "waveform", label: "Waveform" }, { id: "parade", label: "RGB parade" }, { id: "vectorscope", label: "Vectorscope" }, { id: "histogram", label: "Histogram" },
];
const LS = "tatvam-editor:scope";

function graticule(g: CanvasRenderingContext2D, kind: ScopeKind, W: number, H: number) {
  g.save();
  g.strokeStyle = "rgba(255,255,255,0.14)"; g.fillStyle = "rgba(255,255,255,0.4)"; g.lineWidth = 1;
  g.font = "9px ui-monospace, monospace";
  if (kind === "waveform" || kind === "parade") {
    for (const v of [0, 25, 50, 75, 100]) {
      const y = Math.round((1 - v / 100) * (H - 1)) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      g.fillText(String(v), 2, Math.max(9, y - 2));
    }
    if (kind === "parade") for (const k of [1, 2]) { const x = Math.round((W * k) / 3) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  } else if (kind === "vectorscope") {
    const R = Math.min(W, H) / 2 - 2, cx = W / 2, cy = H / 2;
    for (const k of [1, 0.75, 0.5]) { g.beginPath(); g.arc(cx, cy, R * k, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    // 75 % colour bar targets, and the skin tone line
    const targets: [string, number, number, number][] = [["R", 0.75, 0, 0], ["Yl", 0.75, 0.75, 0], ["G", 0, 0.75, 0], ["Cy", 0, 0.75, 0.75], ["B", 0, 0, 0.75], ["Mg", 0.75, 0, 0.75]];
    for (const [n, r, gg, b] of targets) {
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b, cb = (b - l) / 1.8556, cr = (r - l) / 1.5748;
      const x = cx + cb * 2 * R, y = cy - cr * 2 * R;
      g.strokeRect(x - 4, y - 4, 8, 8); g.fillText(n, x + 6, y + 3);
    }
    g.strokeStyle = "rgba(251,191,36,0.45)";
    const a = (123 * Math.PI) / 180;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R); g.stroke();
  } else {
    for (const v of [0.25, 0.5, 0.75]) { const x = Math.round(v * W) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  }
  g.restore();
}

/** Draws one scope of the program frame into a canvas; resolves false when there's no frame yet. The monitor's engine
 *  draws it on the GPU from the frame it holds (no read-back); without that, the frame is read back and the scope is
 *  computed here (moods/scopes.ts). */
async function paintScope(c: HTMLCanvasElement, kind: ScopeKind, caps: LookCaps | null): Promise<boolean> {
  const gpu = caps?.computeScopes && hasProgramScopes() ? await readProgramScope(kind) : null;
  const f = gpu ? null : readProgramFrame();
  if (!gpu && !f) return false;
  const W = c.width, H = c.height;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  if (gpu) { g.drawImage(gpu, 0, 0, W, H); gpu.close(); }
  else g.putImageData(new ImageData(scopeImage(kind, f!, W, H), W, H), 0, 0);
  graticule(g, kind, W, H);
  return true;
}

function useScopeLoop(canvas: React.RefObject<HTMLCanvasElement | null>, kind: ScopeKind, on: boolean, fps = 10) {
  const [caps, setCaps] = useState<LookCaps | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => { void lookCaps().then(setCaps); }, []);
  useEffect(() => {
    if (!on) return;
    let stop = false, busy = false, lastT = -1, lastPaint = 0;
    const id = window.setInterval(() => {
      const c = canvas.current;
      if (stop || busy || !c || document.visibilityState !== "visible") return;
      // paused on the same frame: a slower refresh (edits still change it)
      const same = program.time === lastT && !program.playing;
      if (same && performance.now() - lastPaint < 600) return;
      busy = true;
      void paintScope(c, kind, caps).then((ok) => { setLive(ok); lastT = program.time; lastPaint = performance.now(); }).finally(() => { busy = false; });
    }, 1000 / fps);
    return () => { stop = true; window.clearInterval(id); };
  }, [on, kind, caps, fps]);
  return live;
}

export default function ScopesPanel() {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const visible = useVisible(root);
  const [kind, setKind] = useState<ScopeKind>(() => { try { return (localStorage.getItem(LS) as ScopeKind) || "waveform"; } catch { return "waveform"; } });
  useEffect(() => { try { localStorage.setItem(LS, kind); } catch { /* blocked */ } }, [kind]);
  const [size, setSize] = useState({ w: 400, h: 220 });
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(120, el.clientWidth - 12), h: Math.max(80, el.clientHeight - 12) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = kind === "vectorscope" ? Math.min(size.w, size.h) : size.w, H = kind === "vectorscope" ? Math.min(size.w, size.h) : size.h;
  const live = useScopeLoop(cv, kind, visible, 10);
  return (
    <div ref={root} className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-2">
        <div className="ed-seg">{KINDS.map((k) => <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</button>)}</div>
        <span className={clsx("ml-auto flex items-center gap-1 text-2xs", live ? "text-ok" : "text-dim")}><Activity className="size-3" />{live ? (visible ? "Program · live" : "Paused") : "Open the Program monitor"}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={stage} className="grid min-w-0 flex-1 place-items-center bg-black/60 p-1.5">
          <canvas ref={cv} data-scope={kind} width={Math.round(W)} height={Math.round(H)} className="block" style={{ width: Math.round(W), height: Math.round(H) }} />
        </div>
        <ColourTools />
      </div>
    </div>
  );
}

/** The small waveform / vectorscope in the corner of the Program monitor (its scopes toggle). */
export function ScopesOverlay() {
  const cv = useRef<HTMLCanvasElement>(null);
  const [kind, setKind] = useState<ScopeKind>("waveform");
  useScopeLoop(cv, kind, true, 8);
  const W = kind === "vectorscope" ? 150 : 240, H = kind === "vectorscope" ? 150 : 130;
  return (
    <div className="mon-badge pointer-events-auto bottom-2 right-2 !p-1" title="Click to switch scope" onClick={() => setKind((k) => (k === "waveform" ? "parade" : k === "parade" ? "vectorscope" : "waveform"))}>
      <canvas ref={cv} width={W} height={H} style={{ width: W, height: H }} className="block cursor-pointer" />
    </div>
  );
}

// ── colour tools ─────────────────────────────────────────────────────────────

/** Sets (or adds) an effect of `type` on clips: the first one that isn't a mood's, else a new one at `at`. */
function upsertEffect(d: EditProject, ids: string[], type: string, params: Record<string, unknown>, at: "start" | "end" = "start") {
  const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
  for (const c of sq.clips) {
    if (!ids.includes(c.id)) continue;
    const own = c.effects.find((e) => e.type === type && !isMoodEffect(e));
    const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { value: v }]));
    if (own) own.params = { ...own.params, ...p };
    else { const e: EffectInstance = { id: uid("e"), type, enabled: true, params: p }; if (at === "start") c.effects.unshift(e); else c.effects.push(e); }
  }
}

function enumParam(d: EffectDef | undefined) { return d?.params.find((p) => p.type === "select"); }

function ColourTools() {
  const host = useEditorHost();
  const s = useSequence();
  const p = useProject();
  const sel = useEditor((x) => x.selection);
  const [defs, setDefs] = useState<EffectDef[]>([]);
  const [busy, setBusy] = useState("");
  const [ref, setRef] = useState("");
  useEffect(() => { void videoEffects().then(setDefs); }, []);
  const vids = new Set(tracksOf(s, "video").map((t) => t.id));
  const clips = s.clips.filter((c) => vids.has(c.trackId) && c.source.type === "media");
  const target = clips.filter((c) => sel.includes(c.id));
  const c0: TimelineClip | undefined = target[0];
  const mediaOf = (c: TimelineClip) => (c.source.type === "media" ? p.media.find((m) => m.id === (c.source as { mediaId: string }).mediaId) : undefined);
  const at = (c: TimelineClip) => { const m = mediaOf(c)!; return { url: urlFor(m) ?? "", t: clipTime(c, s, program.frame, m) }; };
  const ids = target.map((c) => c.id);
  const inDef = defs.find((d) => d.id === "input_profile"), outDef = defs.find((d) => d.id === "output_transform");
  const inP = enumParam(inDef), outP = enumParam(outDef);
  const current = (type: string, param?: string) => {
    const e = c0?.effects.find((x) => x.type === type && !isMoodEffect(x));
    return param && e ? String(e.params[param]?.value ?? "") : "";
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [refUrl, setRefUrl] = useState("");

  const wb = async () => {
    if (!c0) return;
    setBusy("wb");
    const r = await analyzeWb(at(c0).url, at(c0).t);
    setBusy("");
    if (!r) { toast.error("Couldn't read the clip's picture"); return; }
    host.apply("Auto white balance", (d) => upsertEffect(d, [c0.id], "adjust", { temperature: r.temperature, tint: r.tint }));
    toast.success(`White balance: temperature ${r.temperature > 0 ? "+" : ""}${r.temperature.toFixed(2)}, tint ${r.tint > 0 ? "+" : ""}${r.tint.toFixed(2)}${r.from === "cpu" ? " (grey world)" : ""}`);
  };
  const applyMatch = async (label: string, r: Awaited<ReturnType<typeof matchLook>>) => {
    if (!r) { toast.error("Couldn't read the pictures to compare"); return; }
    // with Tatvam Desktop the exact transfer (.cube) goes with the edit (a file in its LUTs\ folder, or a data: URL
    // on older builds), so every window, the export too, loads it through Composition.lutUrls; else wheels + adjust
    const kept = r.cube ? await keepMatchLut(label, r.cube).catch(() => null) : null;
    if (kept) {
      host.apply(label, (d) => {
        d.luts = [...(d.luts ?? []).filter((l) => l.id !== kept.id), kept];
        upsertEffect(d, ids, "look", { look: `lut:${kept.id}`, lut_strength: 1 }, "end");
      });
      toast.success(`${label} (the exact match LUT, kept with the edit)`);
      return;
    }
    host.apply(label, (d) => {
      if (r.wheels) upsertEffect(d, ids, "wheels", { lift: r.wheels.lift, gamma: r.wheels.gamma, gain: r.wheels.gain }, "end");
      if (r.adjust) upsertEffect(d, ids, "adjust", r.adjust);
    });
    toast.success(`${label}${r.from === "cpu" ? " (colour wheels from the mean and spread)" : ""}`);
    if (r.cube) toast.message("Matched with colour wheels: the exact match LUT needs an edit saved in Tatvam Desktop", { id: "match-lut" });
  };
  const match = async () => {
    const other = clips.find((c) => c.id === ref);
    if (!c0 || !other) return;
    setBusy("match");
    const r = await matchLook(at(c0), at(other));
    setBusy("");
    await applyMatch(`Match to ${other.name}`, r);
  };
  const fromImage = async (src: string) => {
    if (!c0 || !src) return;
    setBusy("ref");
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = src;
      await img.decode();
      const cv = document.createElement("canvas");
      const k = Math.min(1, 256 / img.naturalWidth);
      cv.width = Math.max(2, Math.round(img.naturalWidth * k)); cv.height = Math.max(2, Math.round(img.naturalHeight * k));
      cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
      await applyMatch("Grade from a reference", await matchLook(at(c0), { canvas: cv }));
    } catch { toast.error("That picture couldn't be read (a cross-site image needs CORS)"); }
    setBusy("");
  };
  const row = "flex flex-col gap-1.5 border-b border-line px-3 py-2.5";
  const nothing = !c0;
  return (
    <aside className="w-[236px] shrink-0 overflow-y-auto border-l border-line" data-colour-tools>
      <p className="px-3 pt-2 text-2xs font-semibold text-mute">Colour tools</p>
      <p className="px-3 pb-2 text-[10px] text-dim">{nothing ? "Select a video clip" : `${target.length} clip${target.length === 1 ? "" : "s"}: ${c0.name}`}</p>
      <div className={row}>
        <span className="text-2xs text-mute">Input profile (camera log)</span>
        {inP ? (
          <select className="ed-field" disabled={nothing} value={current("input_profile", inP.name)} onChange={(e) => host.apply("Input profile", (d) => upsertEffect(d, ids, "input_profile", { [inP.name]: inP.type === "select" && /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value }, "start"))}>
            <option value="">Choose…</option>
            {inP.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : <span className="text-[10px] text-dim">Comes with the engine's camera log support</span>}
        <span className="mt-1 text-2xs text-mute">Output transform</span>
        {outP ? (
          <select className="ed-field" disabled={nothing} value={current("output_transform", outP.name)} onChange={(e) => host.apply("Output transform", (d) => upsertEffect(d, ids, "output_transform", { [outP.name]: /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value }, "end"))}>
            <option value="">Choose…</option>
            {outP.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : <span className="text-[10px] text-dim">Rec.709 (the engine's output transforms come later)</span>}
      </div>
      <div className={row}>
        <Button size="sm" variant="secondary" disabled={nothing} loading={busy === "wb"} icon={<Pipette className="size-3.5" />} onClick={() => void wb()}>Auto white balance</Button>
        <span className="text-[10px] text-dim">Sets Adjust temperature and tint from the frame at the playhead.</span>
      </div>
      <div className={row}>
        <span className="text-2xs text-mute">Shot match</span>
        <select className="ed-field" value={ref} disabled={nothing} onChange={(e) => setRef(e.target.value)}>
          <option value="">Reference clip…</option>
          {clips.filter((c) => !ids.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <Button size="sm" variant="secondary" disabled={nothing || !ref} loading={busy === "match"} icon={<SplitSquareHorizontal className="size-3.5" />} onClick={() => void match()}>Match</Button>
      </div>
      <div className={row}>
        <span className="text-2xs text-mute">Grade from a reference picture</span>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromImage(URL.createObjectURL(f)); e.target.value = ""; }} />
        <Button size="sm" variant="secondary" disabled={nothing} loading={busy === "ref"} icon={<ImagePlus className="size-3.5" />} onClick={() => fileRef.current?.click()}>Choose a picture…</Button>
        <div className="flex gap-1">
          <input className="ed-field min-w-0 flex-1" placeholder="or an image URL" value={refUrl} onChange={(e) => setRefUrl(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void fromImage(refUrl.trim()); }} />
          <button type="button" className="ed-ibtn" title="Grade from this URL" disabled={nothing || !refUrl.trim()} onClick={() => void fromImage(refUrl.trim())}><ScanEye className="size-3.5" /></button>
        </div>
      </div>
      {busy && <div className="grid place-items-center p-2"><Loader2 className="size-4 animate-spin text-dim" /></div>}
    </aside>
  );
}

