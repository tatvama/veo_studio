/**
 * New news edit (docs/EDITOR.md §16.8): the Editor Home dialog — name, ratio (16:9, 9:16 or both), the channel look
 * (cards with a live strap and ticker in each look) and the frame rate (25 fps by default: Indian TV is PAL). On the
 * desktop it creates the edit, puts the starter set in (logo bug, LIVE bug with its clock, a crawl with sample lines)
 * and opens it in the News Room workspace. In a plain browser it opens the demo edit the same way (`?news=`), which
 * `useNewsBoot` (called by the room's panels) turns into a news edit once it's open.
 */
import { clsx } from "clsx";
import { Newspaper } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button, Field, Input, Modal, Segmented } from "../../../components/ui";
import { editorBridge } from "../../../lib/desktop";
import { ctxOf, normalize } from "../../model/ops";
import { forDisk, parseProject } from "../../model/serialize";
import { fpsLabel } from "../../model/time";
import type { EditProject } from "../../model/types";
import { project } from "../../store";
import { addGraphic, applyLook, ensureGfxTrack, ensureNewsroom } from "../commands";
import { listLooks, loadLook } from "../library";
import { BUILTIN_LOOKS } from "../looks";
import type { GfxRenderInput } from "../render/contract";
import { drawGraphic, ensureGraphicAssets } from "../render/index";
import { defaults } from "../templates/kit";
import { builtinTemplates } from "../templates/index";
import type { ChannelLook, NewsroomDoc } from "../types";
import { host } from "./actions";
import { airTimeOf } from "./doc";
import { allTemplates } from "./hooks";
import { pickTemplate, WANT } from "./pick";
import { applyStarterSet, type NewsEditSetup } from "./starter";
import { openNextInNewsWorkspace } from "./workspace";

const FPS = [25, 29.97, 30, 50, 60] as const;
type Ratio = NewsroomDoc["ratio"];
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");

/** Puts the starter set into a project (a draft) and normalises it; notes on anything left out. */
function starter(p: EditProject, o: NewsEditSetup, templates = builtinTemplates()): string[] {
  const r = applyStarterSet(p, p.activeSequenceId, o, { ensureNewsroom, addGraphic, applyLook, ensureGfxTrack, templates });
  const c = ctxOf(p);
  p.sequences = p.sequences.map((s) => normalize(s, c));
  return r.notes;
}

export function NewNewsEditDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const b = editorBridge();
  const [name, setName] = useState("");
  const [ratio, setRatio] = useState<Ratio>("both");
  const [look, setLook] = useState<string>(BUILTIN_LOOKS[0].id);
  const [fps, setFps] = useState<number>(25);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<ChannelLook[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listLooks().then(async (l) => {
      const out: ChannelLook[] = [];
      for (const e of l) { const x = await loadLook(e.id).catch(() => null); if (x) out.push(x); }
      if (alive) setMine(out);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [open]);
  const looks = [...BUILTIN_LOOKS, ...mine.filter((l) => !BUILTIN_LOOKS.some((x) => x.id === l.id))];

  const create = async () => {
    const nm = name.trim() || "News edit";
    const setup: NewsEditSetup = { ratio, look, airTime: airTimeOf() };
    if (!b) {
      // the browser: the demo edit, made a news edit once it's open
      openNextInNewsWorkspace();
      nav(`/editor/edit?demo=1&news=${encodeURIComponent(ratio)}&look=${encodeURIComponent(look)}&name=${encodeURIComponent(nm)}`);
      onClose();
      return;
    }
    setBusy(true);
    try {
      const size = ratio === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
      const made = await b.create(nm, { ...size, fps });
      try {
        const p = structuredClone(parseProject(made.project).project);
        const chosen = mine.find((l) => l.id === look);
        if (chosen) { const nr = ensureNewsroom(p); nr.looks = { ...nr.looks, [chosen.id]: structuredClone(chosen) }; }
        const notes = starter(p, setup);
        for (const n of notes.slice(0, 2)) toast.warning(n);
        await b.save(made.path, forDisk(p));
      } catch (e) { toast.warning(`The edit is made, but its starter graphics couldn't be added: ${msg(e)}`); }
      openNextInNewsWorkspace();
      onClose();
      nav(`/editor/edit?path=${encodeURIComponent(made.path)}`);
    } catch (e) { toast.error(`Couldn't create the edit: ${msg(e)}`); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New news edit" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} icon={<Newspaper className="size-4" />} onClick={() => void create()}>{b ? "Create news edit" : "Open in the demo"}</Button></>}>
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field label="Name"><Input data-autofocus value={name} placeholder="Evening bulletin, 14 Oct" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} /></Field>
          <Field label="Frame rate" hint="25 fps is Indian TV (PAL).">
            <Segmented size="sm" value={fps} onChange={setFps} options={FPS.map((f) => ({ value: f, label: fpsLabel(f).replace(" fps", "") }))} />
          </Field>
        </div>
        <Field label="Shape" hint={ratio === "both" ? "One timeline, two outputs: the 9:16 version is made on the fly and shown beside the program monitor." : ratio === "9:16" ? "Vertical, for Reels, Shorts and phone viewers." : "Widescreen, for TV and YouTube."}>
          <Segmented value={ratio} onChange={setRatio} options={[{ value: "16:9", label: "16:9 TV" }, { value: "9:16", label: "9:16 vertical" }, { value: "both", label: "Both" }]} />
        </Field>
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-mute">Channel look</span>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {looks.map((l) => (
              <button key={l.id} type="button" data-look={l.id} onClick={() => setLook(l.id)}
                className={clsx("rounded-lg border p-1.5 text-left transition-colors", look === l.id ? "border-accent ring-2 ring-accent/30" : "border-line hover:border-accent/50")}>
                <LookSample look={l} vertical={ratio === "9:16"} />
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs">{l.name}</span>
                  {(["primary", "secondary", "accent"] as const).map((k) => <span key={k} className="size-2.5 rounded-full border border-white/20" style={{ background: l.colors[k] }} />)}
                </div>
              </button>
            ))}
          </div>
          <p className="text-2xs text-dim">You can change the look, its colours, fonts and logo any time in the Channel look panel.</p>
        </div>
        <p className="text-2xs text-dim">Opens in the News Room with the channel logo, a LIVE bug with the clock and a ticker already on the timeline{b ? "" : " (the demo edit: nothing is saved)"}.</p>
      </div>
    </Modal>
  );
}

/** A name strap over a ticker in a look, drawn by the News Room renderer (plays on hover), zoomed on the lower left. */
function LookSample({ look, vertical }: { look: ChannelLook; vertical: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const inputs = useMemo(() => {
    const all = builtinTemplates();
    return [pickTemplate(all, WANT.nameStrap), pickTemplate(all, WANT.crawl)].filter(Boolean)
      .map((t): GfxRenderInput => ({ template: t!, values: defaults(t!), look, images: {}, seed: 3, fps: 25, ratio: vertical ? "9:16" : "16:9" }));
  }, [look, vertical]);
  useEffect(() => { void Promise.all(inputs.map((i) => ensureGraphicAssets(i).catch(() => undefined))).then(() => setEpoch((e) => e + 1)); }, [inputs]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const W = vertical ? 180 : 320, H = vertical ? 320 : 180;
    c.width = W * 2; c.height = H * 2;
    const show = c.getContext("2d")!;
    // each graphic draws a whole frame: drawn apart, laid over each other, then the lower left (strap and ticker) shown
    const full = document.createElement("canvas");
    full.width = c.width * 2; full.height = c.height * 2;
    const g = full.getContext("2d")!;
    const off = document.createElement("canvas");
    off.width = full.width; off.height = full.height;
    const og = off.getContext("2d")!;
    const k = vertical ? 0.62 : 0.58;
    const crop = () => { show.clearRect(0, 0, c.width, c.height); show.drawImage(full, 0, full.height * (1 - k), full.width * k, full.height * k, 0, 0, c.width, c.height); };
    const paint = (t: number) => {
      g.clearRect(0, 0, full.width, full.height);
      if (!inputs.length) {
        // no templates yet: the look's plates
        g.fillStyle = look.colors.primary; g.fillRect(full.width * 0.06, full.height * 0.66, full.width * 0.4, full.height * 0.1);
        g.fillStyle = look.colors.accent; g.fillRect(full.width * 0.06, full.height * 0.66, full.width * 0.015, full.height * 0.1);
        g.fillStyle = look.colors.secondary; g.fillRect(0, full.height * 0.88, full.width, full.height * 0.08);
      }
      for (const i of inputs) {
        og.clearRect(0, 0, off.width, off.height);
        try { drawGraphic(og, i, off.width, off.height, t, 8); g.drawImage(off, 0, 0); } catch { /* a template being built */ }
      }
      crop();
    };
    paint(2.2);
    if (!hover) return;
    let raf = 0, alive = true;
    const t0 = performance.now();
    const loop = () => { if (!alive) return; paint(((performance.now() - t0) / 1000) % 8); raf = requestAnimationFrame(loop); };
    loop();
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [inputs, hover, vertical, epoch, look]);
  return (
    <canvas ref={cv} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className={clsx("block w-full rounded-md", vertical && "mx-auto !w-1/2")}
      style={{ aspectRatio: vertical ? "9 / 16" : "16 / 9", background: `linear-gradient(135deg, ${look.colors.dark}, #0f172a 60%, ${look.colors.secondary})` }} />
  );
}

// ── the demo: made a news edit once it's open ────────────────────────────────

const booted = new Set<string>();
/**
 * Called by the room's panels: when the editor was opened with `?news=` (the browser's "New news edit"), the open edit
 * becomes a news edit with the starter set, once per edit. One undo step.
 */
export function useNewsBoot() {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ratio = q.get("news") as Ratio | null;
    if (!ratio || !["16:9", "9:16", "both"].includes(ratio)) return;
    const p = project();
    if (!p.id || booted.has(p.id) || p.newsroom) return;
    booted.add(p.id);
    const look = q.get("look") || BUILTIN_LOOKS[0].id;
    const name = q.get("name");
    // the demo's sequence is 16:9: a vertical choice shows its 9:16 version beside it
    const s = p.sequences.find((x) => x.id === p.activeSequenceId);
    const r: Ratio = ratio === "9:16" && s && s.width > s.height ? "both" : ratio;
    let notes: string[] = [];
    try {
      host().apply("New news edit", (d) => {
        if (name) d.name = name;
        notes = starter(d, { ratio: r, look, airTime: airTimeOf() }, allTemplates(d));
      });
    } catch (e) { toast.error(`Couldn't start the News Room: ${msg(e)}`); return; }
    for (const n of notes.slice(0, 2)) toast.warning(n);
    if (r !== ratio) toast.message("The demo edit is 16:9: its 9:16 version shows in the Other ratio monitor");
  }, []);
}
