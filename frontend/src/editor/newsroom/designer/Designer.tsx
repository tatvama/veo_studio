/**
 * The Template Designer (docs/EDITOR.md §16.8), full window. Layers and fields on the left, the 16:9 and 9:16 designs
 * drawn live in the middle with a preview timeline, the inspector on the right; the top bar has undo / redo, the view,
 * Make vertical, the preview look and sample text, and saving. Built-in templates never change: saving one makes the
 * user's own copy (`my.<uuid>`, copied into the edit in one undo step and into the library). With a clip ("Change
 * only this one") edits become that clip's overrides instead.
 */
import { clsx } from "clsx";
import {
  Copy, Download, Ellipsis, Lock, LockOpen, Minus, Plus, RectangleHorizontal, RectangleVertical, Redo2, Smartphone, TextCursorInput, Undo2, Upload, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, Menu, Popover } from "../../../components/ui";
import { useEditorHost } from "../../host";
import type { EditProject, TimelineClip } from "../../model/types";
import { project, useProject } from "../../store";
import { IBtn, typing } from "../../ui";
import { ensureNewsroom, replaceGraphicTemplate, templateOf, useTemplate } from "../commands";
import type { OpenDesigner } from "../events";
import { exportToFile, importFileChecked, isMyTemplate, listLooks, loadLook, loadTemplate, newTemplateId, saveTemplate, type LibraryEntry } from "../library";
import { BUILTIN_LOOKS, resolveLook } from "../looks";
import { layerKind } from "../render/registry";
import { builtinTemplate } from "../templates/index";
import { defaults } from "../templates/kit";
import type { ChannelLook, GfxListItem, GfxRatio, GfxTemplate, GfxValue } from "../types";
import { clone, duplicateLayer, overridesBetween, ratiosOf, removeLayer, setBox, withOverrides } from "./doc";
import { nudge, roundBox } from "./geometry";
import { Inspector } from "./Inspector";
import { LayersPanel } from "./LayersPanel";
import { withVertical } from "./makeVertical";
import { blankTemplate, SAMPLE_BAND, SAMPLE_STRAP } from "./sample";
import { Stage } from "./Stage";
import { change, closeSession, ds, isDirty, isReadOnly, markSaved, openSession, redo, replaceWorking, select, undo, useDesigner } from "./state";
import { Timeline, togglePlay } from "./Timeline";

// ── opening ──────────────────────────────────────────────────────────────────

function findClip(p: EditProject, id: string): TimelineClip | undefined {
  for (const s of p.sequences) { const c = s.clips.find((x) => x.id === id); if (c) return c; }
  return undefined;
}
const safe = <T,>(f: () => T): T | undefined => { try { return f(); } catch { return undefined; } };

/** The template behind an id: the edit's copy, a built-in, the library's, or a sample. */
async function templateById(id: string): Promise<GfxTemplate | null> {
  const p = project();
  const fromEdit = safe(() => templateOf(p, id)) ?? p.newsroom?.templates?.[id];
  if (fromEdit) return fromEdit;
  const bi = safe(() => builtinTemplate(id));
  if (bi) return bi;
  if (id === "sample" || id === SAMPLE_STRAP.id) return SAMPLE_STRAP;
  if (id === SAMPLE_BAND.id) return SAMPLE_BAND;
  if (id === "new") return blankTemplate();
  return loadTemplate(id).catch(() => null);
}

async function openRequest(req: OpenDesigner): Promise<string | null> {
  const p = project();
  if (req.clipId) {
    const c = findClip(p, req.clipId);
    if (!c || c.source.type !== "graphic") return "That graphic isn't on the timeline any more.";
    const gfx = c.source.gfx;
    const base = (typeof req.template === "object" ? req.template : null) ?? safe(() => templateOf(p, c)) ?? await templateById(gfx.template);
    if (!base) return "This graphic's template couldn't be found.";
    openSession({ mode: "clip", clipId: c.id, base, working: withOverrides(clone(base), gfx.overrides), values: { ...defaults(base), ...gfx.values }, look: resolveLook(p, gfx.look), onSaved: req.onSaved });
    return null;
  }
  const base = typeof req.template === "object" ? req.template : await templateById(req.template);
  if (!base) return "That template couldn't be found.";
  openSession({ mode: "template", base, working: clone(base), values: defaults(base), look: resolveLook(p), onSaved: req.onSaved });
  return null;
}

// ── saving ───────────────────────────────────────────────────────────────────

/** Size keys for Make vertical: each kind's number props measured in px. */
const sizeKeys = (kind: string) => layerKind(kind)?.props.filter((p) => p.type === "number" && p.unit === "px").map((p) => p.key) ?? ["size", "radius"];

function useSaving() {
  const host = useEditorHost();
  const intoEdit = (t: GfxTemplate, label: string, also?: (d: EditProject) => void) => {
    host.apply(label, (d) => {
      useTemplate(d, t);
      const nr = ensureNewsroom(d);
      nr.templates[t.id] = clone(t);
      also?.(d);
    });
  };
  const toLibrary = async (t: GfxTemplate) => {
    try { await saveTemplate(t); return true; } catch (e) { toast.warning(`Saved in this edit, but not in your library: ${(e as Error).message}`); return false; }
  };
  const asNew = async (o: { switchClip?: boolean } = {}) => {
    const st = ds();
    const w = st.h.present;
    const fromOther = !isMyTemplate(st.base.id) && w.name === st.base.name;
    const t: GfxTemplate = { ...clone(w), id: newTemplateId(), name: fromOther ? `${w.name} (mine)` : w.name, source: "mine", modified: new Date().toISOString() };
    const clipId = o.switchClip ? st.clipId : undefined;
    try {
      intoEdit(t, "Save graphic template", clipId ? (d) => {
        replaceGraphicTemplate(d, clipId, t.id);
        const c = findClip(d, clipId);
        if (c?.source.type === "graphic") delete c.source.gfx.overrides;
      } : undefined);
    } catch (e) { toast.error(`Couldn't save: ${(e as Error).message}`); return; }
    const inLib = await toLibrary(t);
    if (clipId) useDesigner.setState({ mode: "template", clipId: undefined });
    markSaved(t, true);
    st.onSaved?.(t);
    toast.success(`Saved “${t.name}”${inLib ? " to this edit and your library" : ""}`);
  };
  const over = async () => {
    const st = ds();
    const t: GfxTemplate = { ...clone(st.h.present), source: st.h.present.source === "imported" ? "imported" : "mine", modified: new Date().toISOString() };
    if (!isMyTemplate(t.id)) return asNew();
    try { intoEdit(t, "Update graphic template"); } catch (e) { toast.error(`Couldn't save: ${(e as Error).message}`); return; }
    await toLibrary(t);
    markSaved(t, true);
    st.onSaved?.(t);
    toast.success(`Saved “${t.name}”`);
  };
  const clip = () => {
    const st = ds();
    const id = st.clipId;
    if (!id) return;
    const ov = overridesBetween(st.base, st.h.present);
    host.apply("Change this graphic", (d) => {
      const c = findClip(d, id);
      if (c?.source.type !== "graphic") return;
      if (Object.keys(ov).length) c.source.gfx.overrides = ov; else delete c.source.gfx.overrides;
    });
    markSaved(st.h.present);
    toast.success(Object.keys(ov).length ? "This graphic now has its own changes" : "This graphic follows its template again");
  };
  return { asNew, over, clip };
}

// ── the window ───────────────────────────────────────────────────────────────

interface Confirm { title: string; body: ReactNode; actions: { label: string; variant?: "primary" | "danger" | "ghost" | "secondary"; run: () => void }[] }

export default function Designer({ request, onClose }: { request: OpenDesigner; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    setReady(false); setErr(null);
    void openRequest(request).then((e) => { if (!alive) return; if (e) setErr(e); else setReady(true); }).catch((e) => alive && setErr(String((e as Error).message ?? e)));
    return () => { alive = false; closeSession(); };
  }, [request]);
  if (err) {
    return (
      <Shell>
        <div className="grid flex-1 place-items-center text-center">
          <div className="space-y-3"><p className="text-sm">{err}</p><Button onClick={onClose}>Close</Button></div>
        </div>
      </Shell>
    );
  }
  if (!ready) return <Shell><div className="grid flex-1 place-items-center text-xs text-dim">Opening the Designer…</div></Shell>;
  return <Window onClose={onClose} />;
}

function Shell({ children }: { children: ReactNode }) {
  return <div data-nr-designer className="ed-root fixed inset-0 z-[60] flex flex-col bg-bg text-ink">{children}</div>;
}

function Window({ onClose }: { onClose: () => void }) {
  const t = useDesigner((s) => s.h.present);
  const mode = useDesigner((s) => s.mode);
  const view = useDesigner((s) => s.view);
  const ratio = useDesigner((s) => s.ratio);
  const readOnly = useDesigner(isReadOnly);
  const dirty = useDesigner(isDirty);
  const canUndo = useDesigner((s) => s.h.past.length > 0);
  const canRedo = useDesigner((s) => s.h.future.length > 0);
  const base = useDesigner((s) => s.base);
  const saving = useSaving();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const rs = ratiosOf(t);
  const mine = isMyTemplate(base.id) && base.id === t.id;

  const requestClose = () => {
    if (!isDirty()) { onClose(); return; }
    setConfirm({
      title: "Keep your changes?", body: <>You changed “{ds().h.present.name}”. Closing now loses those changes.</>,
      actions: [
        { label: "Keep editing", variant: "ghost", run: () => setConfirm(null) },
        { label: "Discard changes", variant: "danger", run: () => { setConfirm(null); onClose(); } },
        { label: mode === "clip" ? "Apply and close" : mine ? "Save and close" : "Save as mine and close", variant: "primary", run: () => {
          setConfirm(null);
          const done = mode === "clip" ? Promise.resolve(saving.clip()) : mine ? saving.over() : saving.asNew();
          void done.then(() => { if (!isDirty()) onClose(); });
        } },
      ],
    });
  };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  // a locked template can still be saved (that's how the lock is kept); only editing it is blocked
  const save = () => { if (mode === "clip") saving.clip(); else if (mine) void saving.over(); else void saving.asNew(); };
  const saveRef = useRef(save);
  saveRef.current = save;

  // keys: the Designer's own; nothing reaches the editor's shortcuts while it's open
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const otherPopup = [...document.querySelectorAll("body > [role=dialog], [data-ctxmenu]")].some((el) => !el.hasAttribute("data-nr-designer"));
      if (e.key === "Escape") {
        if (otherPopup) return;
        e.stopPropagation();
        if (confirmRef.current) setConfirm(null); else closeRef.current();
        return;
      }
      e.stopPropagation();
      if (typing(e) || otherPopup || confirmRef.current) return;
      const st = ds();
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
      if (!st.sel) return;
      if ((e.key === "Delete" || e.key === "Backspace") && st.mode === "template") { e.preventDefault(); const id = st.sel; change((tt) => removeLayer(tt, id)); return; }
      if (mod && e.key.toLowerCase() === "d" && st.mode === "template") { e.preventDefault(); const r = duplicateLayer(st.h.present, st.sel); change(() => r.t); select(r.id); return; }
      const l = st.h.present.designs[st.ratio]?.layers.find((x) => x.id === st.sel);
      const nb = l ? nudge(l.box, e.key, e.shiftKey) : null;
      if (l && nb) { e.preventDefault(); const id = l.id, r = st.ratio; change((tt) => setBox(tt, r, id, roundBox(nb)), `nudge:${id}`); }
    };
    // Ctrl+S saves from anywhere, even a text box (which commits what's typed as it loses focus)
    const saveKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s" || confirmRef.current) return;
      e.preventDefault(); e.stopPropagation();
      (document.activeElement as HTMLElement | null)?.blur?.();
      setTimeout(() => saveRef.current(), 0);
    };
    document.addEventListener("keydown", key);
    window.addEventListener("keydown", saveKey, true);
    return () => { document.removeEventListener("keydown", key); window.removeEventListener("keydown", saveKey, true); };
  }, []);

  const makeVertical = () => {
    const has169 = !!t.designs["16:9"], has916 = !!t.designs["9:16"];
    const run = () => change((tt) => (has169 ? withVertical(tt, { sizeKeys }) : withVertical(tt, { from: "9:16", to: "16:9", scale: 1 / 1.15, sizeKeys })));
    if (!has169 && !has916) return;
    if (has169 && has916) {
      setConfirm({
        title: "Rebuild the vertical design?", body: <>The 9:16 design is made again from the 16:9 one: positions and sizes there are replaced. Layers that only exist in 9:16 stay, and so does what you hid there. You can undo this.</>,
        actions: [{ label: "Cancel", variant: "ghost", run: () => setConfirm(null) }, { label: "Rebuild 9:16", variant: "primary", run: () => { setConfirm(null); run(); useDesigner.setState({ view: "both" }); } }],
      });
    } else { run(); useDesigner.setState({ view: "both" }); toast.success(has169 ? "Made the 9:16 design: check it and adjust" : "Made the 16:9 design: check it and adjust"); }
  };

  return (
    <Shell>
      {/* top bar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <IBtn title="Close (Esc)" onClick={requestClose}><X className="size-4" /></IBtn>
        <div className="flex min-w-0 items-center gap-2 pr-2">
          <span className="min-w-0 truncate text-sm font-semibold">{t.name}</span>
          <StatusBadge mode={mode} base={base} readOnly={readOnly} />
          {dirty && <span className="shrink-0 text-2xs text-warn">Unsaved</span>}
        </div>
        <span className="mx-1 h-5 w-px bg-line" />
        <IBtn title="Undo" shortcut="Ctrl+Z" disabled={!canUndo} onClick={undo}><Undo2 className="size-4" /></IBtn>
        <IBtn title="Redo" shortcut="Ctrl+Shift+Z" disabled={!canRedo} onClick={redo}><Redo2 className="size-4" /></IBtn>
        <span className="mx-1 h-5 w-px bg-line" />
        <div className="ed-seg">
          {rs.length > 1 && <button type="button" aria-pressed={view === "both"} onClick={() => useDesigner.setState({ view: "both", zoom: 1 })}>Both</button>}
          {(["16:9", "9:16"] as GfxRatio[]).map((r) => (
            <button key={r} type="button" aria-pressed={view === "single" && ratio === r} onClick={() => useDesigner.setState({ view: "single", ratio: r })} className="flex items-center gap-1">
              {r === "16:9" ? <RectangleHorizontal className="size-3.5" /> : <RectangleVertical className="size-3.5" />}{r}
            </button>
          ))}
        </div>
        {view === "single" && <ZoomControls />}
        <BgToggle />
        {mode === "template" && !readOnly && (
          <Button size="sm" variant="ghost" icon={<Smartphone className="size-3.5" />} onClick={makeVertical}
            title="Build the 9:16 design from the 16:9 one, keeping clear of where Reels and Shorts put their buttons">
            {t.designs["16:9"] ? (t.designs["9:16"] ? "Rebuild vertical" : "Make vertical") : "Make 16:9"}
          </Button>
        )}
        <span className="flex-1" />
        <LookSwitcher />
        <SampleText />
        <MoreMenu setConfirm={setConfirm} />
        {mode === "clip" ? (<>
          <Button size="sm" variant="ghost" onClick={() => void saving.asNew({ switchClip: true })} title="Make a new template from this graphic and use it here">Save as new template</Button>
          <Button size="sm" variant="primary" onClick={() => saving.clip()} disabled={!dirty}>Apply to this graphic</Button>
        </>) : (<>
          {mine && <Button size="sm" variant="ghost" onClick={() => void saving.asNew()}>Save as new</Button>}
          <Button size="sm" variant="primary" onClick={save} disabled={mine && !dirty} title={mine ? "Save over this template (Ctrl+S)" : "Built-in templates never change: this saves your own copy (Ctrl+S)"}>
            {mine ? "Save" : "Save as mine"}
          </Button>
        </>)}
      </div>
      {readOnly && (
        <div className="flex items-center gap-3 border-b border-line bg-warn/10 px-4 py-1.5 text-xs">
          <Lock className="size-3.5 text-warn" /><span className="flex-1">This template is locked: graphics made from it can only be filled in.</span>
          <Button size="sm" variant="secondary" icon={<LockOpen className="size-3.5" />} onClick={() => change((tt) => ({ ...tt, locked: undefined }), undefined, true)}>Unlock to change it</Button>
        </div>
      )}
      {mode === "clip" && (
        <div className="border-b border-line bg-accent/8 px-4 py-1.5 text-xs text-mute">Changing only this graphic. Its template and every other graphic made from it stay as they are.</div>
      )}
      {/* body */}
      <div className="flex min-h-0 flex-1">
        <aside className="pn w-[268px] shrink-0 border-r border-line"><LayersPanel readOnly={readOnly} /></aside>
        <main className="flex min-w-0 flex-1 flex-col bg-[color-mix(in_srgb,var(--color-bg)_80%,black)]">
          <div className="flex min-h-0 flex-1" onPointerDown={(e) => { if (e.target === e.currentTarget) select(null); }}>
            {rs.length === 0 ? <div className="grid flex-1 place-items-center text-xs text-dim">This template has no design yet.</div>
              : view === "both" && rs.length > 1
                ? (["16:9", "9:16"] as GfxRatio[]).filter((r) => rs.includes(r)).map((r) => (
                  <div key={r} className="flex min-w-0" style={{ flex: r === "16:9" ? "1.9 1 0" : "0.62 1 0" }}><Stage ratio={r} readOnly={readOnly} compact /></div>
                ))
                : <Stage ratio={ratio} readOnly={readOnly} />}
          </div>
          <Timeline />
        </main>
        <aside className="pn w-[324px] shrink-0 border-l border-line"><Inspector /></aside>
      </div>
      {confirm && <ConfirmBox c={confirm} />}
    </Shell>
  );
}

function StatusBadge({ mode, base, readOnly }: { mode: string; base: GfxTemplate; readOnly: boolean }) {
  const [label, cls] = mode === "clip" ? ["This graphic only", "bg-accent/15 text-accent-ink"]
    : readOnly ? ["Locked", "bg-warn/15 text-warn"]
    : isMyTemplate(base.id) ? [base.source === "imported" ? "Imported" : "Mine", "bg-ok/15 text-ok"]
    : ["Built-in", "bg-hover text-mute"];
  return <span className={clsx("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", cls)}>{label}</span>;
}

function ZoomControls() {
  const zoom = useDesigner((s) => s.zoom);
  const set = (z: number) => useDesigner.setState({ zoom: Math.max(1, Math.min(4, Math.round(z * 100) / 100)) });
  return (
    <div className="flex items-center gap-0.5">
      <IBtn title="Zoom out" disabled={zoom <= 1} onClick={() => set(zoom / 1.25)}><Minus className="size-3.5" /></IBtn>
      <button type="button" className="ed-tc rounded px-1 text-2xs text-mute hover:bg-hover" title="Zoom to fit" onClick={() => set(1)}>{zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}</button>
      <IBtn title="Zoom in" disabled={zoom >= 4} onClick={() => set(zoom * 1.25)}><Plus className="size-3.5" /></IBtn>
    </div>
  );
}

function BgToggle() {
  const bg = useDesigner((s) => s.bg);
  const next = { dark: "checker", checker: "light", light: "dark" } as const;
  const label = { dark: "Dark backdrop", checker: "See-through backdrop", light: "Light backdrop" }[bg];
  return (
    <IBtn title={`${label} (click to change)`} onClick={() => useDesigner.setState({ bg: next[bg] })}>
      <span className="size-3.5 rounded-sm border border-line" style={{ background: bg === "dark" ? "#141924" : bg === "light" ? "#dfe5ee" : "repeating-conic-gradient(#888 0% 25%, #444 0% 50%) 50% / 6px 6px" }} />
    </IBtn>
  );
}

/** The look the preview is drawn in: the edit's, a ready look, or one from the library. */
function LookSwitcher() {
  const look = useDesigner((s) => s.look);
  const p = useProject();
  const [mine, setMine] = useState<LibraryEntry[]>([]);
  useEffect(() => { void listLooks().then(setMine).catch(() => undefined); }, []);
  const editLooks = useMemo(() => {
    const out: ChannelLook[] = [resolveLook(p)];
    for (const l of Object.values(p.newsroom?.looks ?? {})) if (!out.some((x) => x.id === l.id)) out.push(l);
    return out.filter((l) => !BUILTIN_LOOKS.some((b) => b.id === l.id) || l.id === resolveLook(p).id);
  }, [p]);
  const choose = async (id: string) => {
    const l = editLooks.find((x) => x.id === id) ?? BUILTIN_LOOKS.find((x) => x.id === id) ?? await loadLook(id);
    if (l) useDesigner.setState({ look: l });
  };
  return (
    <label className="flex items-center gap-1.5 text-2xs text-mute" title="Preview in another look (it doesn't change the template)">
      Look
      <select className="ed-field max-w-[150px]" value={look?.id} onChange={(e) => void choose(e.target.value)}>
        <optgroup label="This edit">{editLooks.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>
        <optgroup label="Ready looks">{BUILTIN_LOOKS.filter((b) => !editLooks.some((x) => x.id === b.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>
        {mine.length > 0 && <optgroup label="My looks">{mine.filter((m) => !editLooks.some((x) => x.id === m.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>}
      </select>
    </label>
  );
}

/** Sample text: what the preview shows in each field (never saved into the template). */
function SampleText() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const t = useDesigner((s) => s.h.present);
  const values = useDesigner((s) => s.values);
  const set = (id: string, v: GfxValue) => useDesigner.setState({ values: { ...ds().values, [id]: v } });
  return (
    <>
      <Button ref={ref} size="sm" variant="ghost" icon={<TextCursorInput className="size-3.5" />} onClick={() => setOpen(!open)} title="Try the graphic with other text">Sample text</Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-end" width={340} className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium">Sample text</p>
          <button type="button" className="text-2xs text-accent-ink hover:underline" onClick={() => useDesigner.setState({ values: defaults(t) })}>Back to the defaults</button>
        </div>
        <p className="mb-2 text-2xs text-dim">Only for this preview. Try a long name or a Hindi line to see how text fits.</p>
        <div className="max-h-[60vh] space-y-2 overflow-auto pr-1">
          {t.fields.length === 0 && <p className="text-xs text-dim">This template has no fields.</p>}
          {t.fields.map((f) => {
            const v = values[f.id] ?? f.default;
            return (
              <label key={f.id} className="block space-y-1">
                <span className="text-2xs text-mute">{f.label || f.id}</span>
                {f.type === "toggle" ? <input type="checkbox" className="block" checked={!!v} onChange={(e) => set(f.id, e.target.checked)} />
                  : f.type === "choice" ? <select className="ed-field w-full" value={String(v ?? "")} onChange={(e) => set(f.id, e.target.value)}>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                  : f.type === "number" ? <input type="number" className="ed-field w-full" value={Number(v ?? 0)} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set(f.id, Number(e.target.value))} />
                  : f.type === "list" ? <textarea className="ed-field h-20 w-full py-1" onKeyDown={(e) => e.stopPropagation()}
                    value={(Array.isArray(v) ? (v as GfxListItem[]) : []).map((x) => (typeof x === "string" ? x : x.text)).join("\n")}
                    onChange={(e) => set(f.id, e.target.value.split("\n").map((text) => ({ text })))} />
                  : f.type === "longtext" ? <textarea className="ed-field h-16 w-full py-1" value={String(v ?? "")} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set(f.id, e.target.value)} />
                  : f.type === "text" || f.type === "datetime" ? <input className="ed-field w-full" value={String(v ?? "")} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set(f.id, e.target.value)} />
                  : <span className="block text-2xs text-dim">Set in Fill in</span>}
              </label>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

function MoreMenu({ setConfirm }: { setConfirm: (c: Confirm | null) => void }) {
  const t = useDesigner((s) => s.h.present);
  const mode = useDesigner((s) => s.mode);
  const saving = useSaving();
  const host = useEditorHost();
  const dup = async () => {
    const st = ds();
    const copy: GfxTemplate = { ...clone(st.h.present), id: newTemplateId(), name: `${st.h.present.name} copy`, source: "mine", modified: new Date().toISOString() };
    delete copy.locked;
    try {
      host.apply("Duplicate graphic template", (d) => { useTemplate(d, copy); ensureNewsroom(d).templates[copy.id] = clone(copy); });
      await saveTemplate(copy);
    } catch (e) { toast.error(`Couldn't duplicate: ${(e as Error).message}`); return; }
    useDesigner.setState({ mode: "template", clipId: undefined });
    replaceWorking(copy);
    toast.success(`Now editing “${copy.name}”`);
  };
  const imp = async () => {
    const run = async () => {
      const r = await importFileChecked("template", Object.keys(project().newsroom?.templates ?? {}));
      if (!r) return;
      if (!r.ok) { toast.error(`That file couldn't be opened. ${r.reason}`); return; }
      useDesigner.setState({ mode: "template", clipId: undefined });
      replaceWorking(r.value);
      toast.success(`Imported “${r.value.name}” into your library`);
    };
    if (isDirty()) setConfirm({ title: "Open another template?", body: "Your unsaved changes here will be lost.", actions: [{ label: "Cancel", variant: "ghost", run: () => setConfirm(null) }, { label: "Discard and import", variant: "danger", run: () => { setConfirm(null); void run(); } }] });
    else await run();
  };
  return (
    <Menu width={230} trigger={(p) => <IBtn {...p} title="More"><Ellipsis className="size-4" /></IBtn>}
      items={[
        { label: "Duplicate as a new template", icon: <Copy className="size-3.5" />, onClick: () => void dup() },
        ...(mode === "template" ? [{ label: t.locked ? "Unlock (allow changes)" : "Lock (fill-in only)", icon: t.locked ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />,
          onClick: () => change((tt) => ({ ...tt, locked: tt.locked ? undefined : true }), undefined, true) }] : []),
        ...(mode === "clip" ? [{ label: "Undo all changes to this graphic", onClick: () => change(() => clone(ds().base)) }] : []),
        { label: "Export to a file…", icon: <Download className="size-3.5" />, separator: true, onClick: () => void exportToFile("template", { ...ds().h.present }).then((p) => { if (p) toast.success(`Exported ${p}`); }).catch((e) => toast.error(`Couldn't export: ${(e as Error).message}`)) },
        { label: "Import a file…", icon: <Upload className="size-3.5" />, onClick: () => void imp() },
        ...(mode === "template" && isMyTemplate(t.id) ? [] : [{ label: "Save as my template", separator: true, onClick: () => void saving.asNew() }]),
      ]} />
  );
}

function ConfirmBox({ c }: { c: Confirm }) {
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 backdrop-blur-[2px]" data-nr-designer>
      <div role="alertdialog" className="hud w-[420px] max-w-[92vw] rounded-xl border border-line bg-panel p-5 shadow-modal">
        <p className="text-sm font-semibold">{c.title}</p>
        <p className="mt-2 text-xs leading-relaxed text-mute">{c.body}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {c.actions.map((a, i) => <Button key={a.label} size="sm" variant={a.variant ?? "secondary"} autoFocus={i === c.actions.length - 1} onClick={a.run}>{a.label}</Button>)}
        </div>
      </div>
    </div>
  );
}
