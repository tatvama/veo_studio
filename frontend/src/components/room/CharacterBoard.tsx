import { useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Layers, Plus, RefreshCw, Save, ScanSearch, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import {
  BOARD_KINDS, BOARD_KIND_LABEL, OUTFIT_ANGLES, generateBoard, panelLabel, relabelBoard, saveBoardViews, uploadBoard, useBoardOptions,
  useImageEngines, type BoardPanel, type BoardState,
} from "../../lib/boards";
import { cn } from "../../lib/cn";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import type { Character, CharacterAsset, SubmitResult } from "../../lib/types";
import { announce, useGenerate } from "../Generate";
import { capturePointer, releasePointer } from "../hub/util";
import { Alert, Badge, Button, Input, Modal, Select } from "../ui";

type Board = CharacterAsset & { meta?: { board?: BoardState } };

const STATUS: Record<string, { tone: "ok" | "info" | "bad" | "neutral" | "warn"; label: string }> = {
  detected: { tone: "info", label: "Panels found" },
  labelling: { tone: "info", label: "Labelling…" },
  awaiting_approval: { tone: "warn", label: "Labelling waits for approval" },
  ready: { tone: "ok", label: "Ready to review" },
  failed: { tone: "bad", label: "Couldn't label" },
  saved: { tone: "neutral", label: "Views saved" },
};

/** The uploaded boards of a character (kept as its own pictures; never used whole as a look reference). */
export const boardsOf = (c: Character): Board[] =>
  ((c.assets ?? []) as Board[]).filter((a) => !a.archived && a.kind === "source" && a.origin === "board");

/** "Split a character board": upload one image with many views, then review the cut-out views before saving them. */
export function BoardSplitCard({ character: c, projectId, editable }: { character: Character; projectId?: number | null; editable: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<number | null>(null);
  const boards = boardsOf(c);
  const open = boards.find((b) => b.id === review) ?? null;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["character", c.id] }); qc.invalidateQueries({ queryKey: ["jobs"] }); };

  const upload = async (f: File) => {
    setBusy(true);
    try {
      const res = await uploadBoard(c.id, f, projectId);
      const n = res.board.panels?.length ?? 0;
      if (res.jobs.status === "failed") {
        toast.warning(tr("Board added. The AI labelling didn't start: {why}. Label the views yourself in the review.", { why: (res.jobs as { reason: string }).reason }));
      } else {
        announce(res.jobs as SubmitResult, n ? tr("Board: {n} panels found, labelling", { n }) : tr("Board: finding the panels"));
      }
      refresh();
      if (n) setReview(res.asset_id);
    } catch { /* api toasts */ } finally { setBusy(false); }
  };
  const remove = async (b: Board) => {
    try { await api.patch(`/api/character-assets/${b.id}`, { archived: true }); refresh(); toast.success(tr("Board removed (the views you saved stay)")); }
    catch { /* api toasts */ }
  };

  if (!editable && !boards.length) return null;
  return (
    <div className="rounded-lg border border-line bg-bg/40 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-mute"><LayoutGrid className="size-4" /></span>
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-sm font-medium">{t("Split a character board")}</p>
          <p className="text-xs text-mute">{t("One image with many views — a turnaround, expressions, outfits. It is cut into separate views, a small AI check labels each one, and you review them before anything is saved. The board itself stays as your own picture.")}</p>
        </div>
        {editable && (
          <Button size="sm" loading={busy} icon={<Upload className="size-3.5" />} className="max-sm:h-10" onClick={() => fileRef.current?.click()}>
            {t("Upload a board")}
          </Button>
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
      </div>
      {boards.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {boards.map((b) => {
            const s = b.meta?.board ?? {};
            const st = STATUS[s.status ?? "detected"] ?? STATUS.detected;
            const n = s.panels?.length ?? 0;
            return (
              <li key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <img src={b.url} alt="" className="h-12 w-16 shrink-0 rounded border border-line object-cover" />
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-sm font-medium" title={b.label}>{b.label || t("character board")}</p>
                  <p className="text-2xs text-dim">
                    {n ? t("{n} panels", { n }) : t("no panels yet")}
                    {s.method ? ` · ${s.method === "vision" ? t("found by AI") : t("found on the board's gutters")}` : ""}
                    {s.saved_asset_ids?.length ? ` · ${t("{n} views saved", { n: s.saved_asset_ids.length })}` : ""}
                  </p>
                  {s.error && s.status !== "saved" && <p className="text-2xs text-amber-300">{s.error}</p>}
                </div>
                <Badge tone={st.tone} dot>{t(st.label)}</Badge>
                {editable && n > 0 && (
                  <Button size="sm" variant={s.status === "ready" ? "primary" : "secondary"} icon={<ScanSearch className="size-3.5" />}
                    onClick={() => setReview(b.id)}>{s.status === "saved" ? t("Review again") : t("Review views")}</Button>
                )}
                {editable && (
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} title={t("Remove the board (saved views stay)")}
                    onClick={() => void remove(b)}><span className="sr-only">{t("Remove")}</span></Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && <BoardReview board={open} character={c} projectId={projectId} onClose={() => setReview(null)} onSaved={refresh} />}
    </div>
  );
}

// ── review: label, discard, adjust the boxes, save ──────────────────────────

type Edit = BoardPanel & { key: number };

function BoardReview({ board, character: c, projectId, onClose, onSaved }: {
  board: Board; character: Character; projectId?: number | null; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const s = board.meta?.board ?? {};
  const W = s.width ?? 1000;
  const H = s.height ?? 1000;
  const seq = useRef(0);
  const fromState = () => (s.panels ?? []).map((p) => ({ ...p, keep: p.keep ?? p.kind !== "other", name: p.name ?? "", key: ++seq.current }));
  const [panels, setPanels] = useState<Edit[]>(fromState);
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "label">("");
  const [dirty, setDirty] = useState(false);
  // new labels arrive (the labelling job finished) while nothing was changed here: take them
  const stamp = JSON.stringify(s.panels ?? []);
  useEffect(() => { if (!dirty) setPanels(fromState()); }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key: number, patch: Partial<BoardPanel>) => { setDirty(true); setPanels((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p))); };
  const kept = panels.filter((p) => p.keep);
  const payload = () => panels.map(({ key: _k, ...p }) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h) }));

  const save = async () => {
    setBusy("save");
    try {
      const res = await saveBoardViews(board.id, payload());
      toast.success(tr("{n} views saved to {name}'s reference pack", { n: res.saved.length, name: c.name }));
      onSaved();
      onClose();
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  const relabel = async () => {
    setBusy("label");
    try {
      const res = await relabelBoard(board.id, { panels: payload(), project_id: projectId ?? null });
      announce(res.jobs, tr("Labelling the views again"));
      setDirty(false);
      onSaved();
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  const add = () => {
    const key = ++seq.current;
    setDirty(true);
    setPanels((ps) => [...ps, { key, x: Math.round(W * 0.25), y: Math.round(H * 0.25), w: Math.round(W * 0.5), h: Math.round(H * 0.5), kind: "front", name: "", keep: true }]);
    setSel(key);
  };
  const labelling = s.status === "labelling" || s.status === "awaiting_approval";

  return (
    <Modal open onClose={onClose} size="xl" title={t("Review the board's views · {name}", { name: c.name })}
      footer={<>
        <Button variant="ghost" icon={<Plus className="size-3.5" />} onClick={add}>{t("Add a panel")}</Button>
        <Button variant="outline" loading={busy === "label"} disabled={!!busy || !panels.length} icon={<RefreshCw className="size-3.5" />}
          title={t("Ask the AI to label these boxes again (a small vision check)")} onClick={() => void relabel()}>{t("Label again with AI")}</Button>
        <Button variant="primary" loading={busy === "save"} disabled={!!busy || !kept.length} icon={<Save className="size-3.5" />}
          onClick={() => void save()}>{t("Save {n} views", { n: kept.length })}</Button>
      </>}>
      <div className="space-y-4">
        {labelling && <Alert tone="info">{t("The AI is still labelling these panels. You can wait, or label them yourself now.")}</Alert>}
        {s.status === "failed" && <Alert tone="warn">{s.error || t("The AI labelling failed: label the views yourself.")}</Alert>}
        <p className="text-xs text-mute">
          {t("Pick what each panel shows, untick the ones you don't want, and drag a box (or its corner) on the board to fix the crop. Saved views become approved references; they are your own pictures, so they're never sent to BytePlus as AI sheet views.")}
        </p>
        <BoardCanvas url={board.url} W={W} H={H} panels={panels} sel={sel} onSelect={setSel}
          onMove={(key, box) => set(key, box)} />
        <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))]">
          {panels.map((p, i) => (
            <li key={p.key} className={cn("rounded-lg border bg-panel p-2.5 transition-colors", sel === p.key ? "border-accent" : "border-line",
              !p.keep && "opacity-55")} onClick={() => setSel(p.key)}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="mono text-2xs text-dim">#{i + 1}</span>
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" className="size-3.5" checked={!!p.keep} onChange={(e) => set(p.key, { keep: e.target.checked })} />
                  {t("Keep")}
                </label>
              </div>
              <Crop url={board.url} W={W} H={H} box={p} />
              <div className="mt-2 space-y-1.5">
                <Select aria-label={t("What panel {n} shows", { n: i + 1 })} value={BOARD_KINDS.includes(p.kind as never) ? p.kind : "other"}
                  onChange={(e) => set(p.key, { kind: e.target.value, keep: e.target.value === "other" ? p.keep : true })}>
                  {BOARD_KINDS.map((k) => <option key={k} value={k}>{t(BOARD_KIND_LABEL[k])}</option>)}
                </Select>
                {(p.kind === "expression" || p.kind === "outfit") && (
                  <Input aria-label={p.kind === "expression" ? t("Expression") : t("Outfit name")} value={p.name ?? ""}
                    placeholder={p.kind === "expression" ? t("e.g. happy") : t("e.g. wedding saree")} onChange={(e) => set(p.key, { name: e.target.value })} />
                )}
                {p.kind === "outfit" && (
                  <Select aria-label={t("Outfit angle")} value={p.view || "full_body"} onChange={(e) => set(p.key, { view: e.target.value })}>
                    {OUTFIT_ANGLES.map((v) => <option key={v} value={v}>{t(BOARD_KIND_LABEL[v])}</option>)}
                  </Select>
                )}
                {p.description && <p className="line-clamp-2 text-2xs text-dim" title={p.description}>{p.description}</p>}
                <details className="text-2xs text-mute">
                  <summary className="cursor-pointer select-none">{t("Adjust box")}</summary>
                  <div className="mt-1.5 grid grid-cols-4 gap-1">
                    {(["x", "y", "w", "h"] as const).map((k) => (
                      <label key={k} className="block">
                        <span className="mono uppercase text-dim">{k}</span>
                        <Input type="number" className="mono h-7 px-1.5 text-2xs" value={Math.round(p[k])} min={k === "w" || k === "h" ? 16 : 0}
                          max={k === "x" || k === "w" ? W : H}
                          onChange={(e) => set(p.key, { [k]: Math.max(0, Number(e.target.value) || 0) } as Partial<BoardPanel>)} />
                      </label>
                    ))}
                  </div>
                </details>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

/** One panel cut out of the board, drawn with CSS (nothing is saved until "Save views"). */
function Crop({ url, W, H, box }: { url: string; W: number; H: number; box: BoardPanel }) {
  const w = Math.max(box.w, 1);
  const h = Math.max(box.h, 1);
  const portrait = w / h < 1.15;
  return (
    <div className="grid h-40 place-items-center overflow-hidden rounded-md border border-line bg-bg/60">
      <div className="relative overflow-hidden" style={{ aspectRatio: `${w} / ${h}`, height: portrait ? "100%" : "auto", width: portrait ? "auto" : "100%", maxWidth: "100%" }}>
        <img src={url} alt="" draggable={false} className="absolute max-w-none select-none"
          style={{ width: `${(W / w) * 100}%`, left: `${(-box.x / w) * 100}%`, top: `${(-box.y / h) * 100}%` }} />
      </div>
    </div>
  );
}

/** The whole board with every box drawn on it: click to select, drag a box to move it, drag its corner to resize. */
function BoardCanvas({ url, W, H, panels, sel, onSelect, onMove }: {
  url: string; W: number; H: number; panels: Edit[]; sel: number | null; onSelect: (key: number) => void;
  onMove: (key: number, box: Pick<BoardPanel, "x" | "y" | "w" | "h">) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ key: number; mode: "move" | "size"; sx: number; sy: number; box: BoardPanel } | null>(null);
  const at = (e: ReactPointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const start = (e: ReactPointerEvent<SVGElement>, p: Edit, mode: "move" | "size") => {
    e.stopPropagation();
    onSelect(p.key);
    const pt = at(e);
    drag.current = { key: p.key, mode, sx: pt.x, sy: pt.y, box: { ...p } };
    if (svg.current) capturePointer(svg.current, e.pointerId); // the svg keeps the pointer while the boxes re-render
  };
  const move = (e: ReactPointerEvent<SVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const pt = at(e);
    const dx = pt.x - d.sx;
    const dy = pt.y - d.sy;
    if (d.mode === "move") {
      onMove(d.key, { x: clamp(d.box.x + dx, 0, W - d.box.w), y: clamp(d.box.y + dy, 0, H - d.box.h), w: d.box.w, h: d.box.h });
    } else {
      onMove(d.key, { x: d.box.x, y: d.box.y, w: clamp(d.box.w + dx, 16, W - d.box.x), h: clamp(d.box.h + dy, 16, H - d.box.y) });
    }
  };
  const end = (e: ReactPointerEvent<SVGElement>) => { drag.current = null; if (svg.current) releasePointer(svg.current, e.pointerId); };
  const stroke = Math.max(W, H) / 300;
  const handle = Math.max(W, H) / 45;
  const on = panels.find((p) => p.key === sel);

  return (
    <div className="mx-auto max-h-[42vh] overflow-hidden rounded-lg border border-line bg-bg/60" style={{ aspectRatio: `${W} / ${H}`, maxWidth: `calc(42vh * ${W / H})` }}>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="block size-full touch-none select-none" role="img" aria-label={tr("The board with its panels")}
        onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <image href={url} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />
        {panels.map((p, i) => {
          const picked = p.key === sel;
          return (
            <g key={p.key} className="cursor-move" onPointerDown={(e) => start(e, p, "move")}>
              <rect x={p.x} y={p.y} width={p.w} height={p.h} fill={picked ? "rgb(255 170 60 / 0.12)" : "rgb(0 0 0 / 0.001)"}
                stroke={p.keep ? (picked ? "rgb(255 170 60)" : "rgb(56 189 248)") : "rgb(148 163 184)"} strokeWidth={stroke * (picked ? 2 : 1)}
                strokeDasharray={p.keep ? undefined : `${stroke * 4} ${stroke * 3}`} />
              <text x={p.x + stroke * 3} y={p.y + stroke * 14} fontSize={stroke * 12} fill="white" stroke="black" strokeWidth={stroke * 0.8}
                paintOrder="stroke" className="pointer-events-none font-mono">{i + 1}</text>
            </g>
          );
        })}
        {on && (
          <rect x={on.x + on.w - handle} y={on.y + on.h - handle} width={handle} height={handle} fill="rgb(255 170 60)" className="cursor-nwse-resize"
            aria-label={tr("Resize the selected panel")} onPointerDown={(e) => start(e, on, "size")} />
        )}
      </svg>
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// ── a whole board in one request (BytePlus Seedream group generation) ───────

const VIEW_PANELS = ["front", "three_quarter", "profile", "back", "full_body"];
const FACE_PANELS = ["expression:neutral", "expression:happy", "expression:angry", "expression:sad", "expression:surprised"];
const OUTFIT_PANELS = ["outfit:front", "outfit:three_quarter", "outfit:full_body"];

/** Shown when an engine here can make a whole board in one request (Seedream 5.0 Lite on BytePlus). */
export function OneCallBoardButton({ character: c, projectId, editable }: { character: Character; projectId?: number | null; editable: boolean }) {
  const t = useT();
  const { data } = useImageEngines(editable);
  const [open, setOpen] = useState(false);
  if (!editable || !(data?.engines ?? []).some((e) => e.group_max > 0)) return null;
  return (
    <>
      <Button size="sm" icon={<Layers className="size-3.5" />} className="max-sm:h-10" title={t("Turnaround, expressions and an outfit in one Seedream request on BytePlus")}
        onClick={() => setOpen(true)}>{t("Full board in one go")}</Button>
      {open && <OneCallBoard character={c} projectId={projectId} onClose={() => setOpen(false)} />}
    </>
  );
}

function OneCallBoard({ character: c, projectId, onClose }: { character: Character; projectId?: number | null; onClose: () => void }) {
  const t = useT();
  const { submit } = useGenerate();
  const { data: opts } = useBoardOptions(c.id, true);
  const [engine, setEngine] = useState<string>("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set([...VIEW_PANELS, ...FACE_PANELS]));
  const [outfit, setOutfit] = useState({ name: "", description: "" });
  const [busy, setBusy] = useState(false);
  const eng = opts?.engines.find((e) => e.id === (engine || opts?.default_engine)) ?? opts?.engines[0];
  const outfitOn = !!(outfit.name.trim() && outfit.description.trim());
  const panels = [...VIEW_PANELS, ...FACE_PANELS, ...OUTFIT_PANELS].filter((k) => picked.has(k) && (outfitOn || !k.startsWith("outfit:")));
  const max = eng?.max_images ?? 0;
  const over = panels.length > max;
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const go = async () => {
    if (!eng) return;
    setBusy(true);
    try {
      const r = await submit(() => generateBoard(c.id, { project_id: projectId ?? null, engine: eng.id, panels,
        outfit_name: outfitOn ? outfit.name.trim() : "", outfit_description: outfitOn ? outfit.description.trim() : "" }),
      tr("Full board for {name}", { name: c.name }));
      if (r) onClose();
    } finally { setBusy(false); }
  };

  const group = (title: string, keys: string[], disabled = false) => (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="eyebrow mb-1.5 !text-mute">{title}</legend>
      <div className="flex flex-wrap gap-1.5">
        {keys.map((k) => (
          <label key={k} className={cn("flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
            picked.has(k) && !disabled ? "border-accent/50 bg-accent/10" : "border-line", disabled && "cursor-not-allowed opacity-50")}>
            <input type="checkbox" className="size-3.5" checked={picked.has(k)} onChange={() => toggle(k)} />
            {t(panelLabel(k))}
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <Modal open onClose={onClose} size="lg" title={t("Full board in one go · {name}", { name: c.name })}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="primary" loading={busy} disabled={!eng || !panels.length || over} icon={<Layers className="size-3.5" />} onClick={() => void go()}>
          {t("Make {n} images", { n: panels.length })}{eng && eng.price_usd > 0 ? ` · ≈ ${usd(eng.price_usd * panels.length)}` : ""}
        </Button>
      </>}>
      {!opts ? <p className="text-sm text-mute">{t("Loading…")}</p> : !eng ? (
        <Alert tone="info">{t("No engine here makes a whole board in one request. Switch on Seedream 5.0 Lite (BytePlus) in the Model Hub and add the BytePlus API key.")}</Alert>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-mute">
            {t("One request to {engine} makes the whole set, from {ref}. BytePlus decides how many images come back and bills each one; any it doesn't return are made one by one on the same engine.",
              { engine: eng.display_name, ref: opts.references ? t("this character's reference image") : t("the character's description (no reference image yet)") })}
          </p>
          {opts.engines.length > 1 && (
            <Select aria-label={t("Engine")} value={eng.id} onChange={(e) => setEngine(e.target.value)}>
              {opts.engines.map((e) => <option key={e.id} value={e.id}>{e.display_name}{e.price_usd > 0 ? ` · ${usd(e.price_usd, 3)}/${t("image")}` : ""}</option>)}
            </Select>
          )}
          {group(t("Turnaround"), VIEW_PANELS)}
          {group(t("Expressions"), FACE_PANELS)}
          <div className="space-y-2">
            <div className="grid gap-2 @md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
              <Input aria-label={t("Outfit name")} placeholder={t("Outfit name (optional)")} value={outfit.name} onChange={(e) => setOutfit({ ...outfit, name: e.target.value })} />
              <Input aria-label={t("Outfit description")} placeholder={t("What they wear, e.g. red silk saree with gold border")} value={outfit.description}
                onChange={(e) => setOutfit({ ...outfit, description: e.target.value })} />
            </div>
            {group(t("Outfit"), OUTFIT_PANELS, !outfitOn)}
          </div>
          <p className={cn("mono text-xs", over ? "text-amber-300" : "text-dim")}>
            {t("{n} of at most {max} images in one request", { n: panels.length, max })}
            {opts.references ? ` · ${t("the reference image counts toward BytePlus's limit of 15")}` : ""}
          </p>
          <p className="text-2xs text-dim">{t("Seedream 5.0 Pro makes one image per request on BytePlus, so it can't make a board in one go: pick it as this character's image engine for view-by-view sheets.")}</p>
        </div>
      )}
    </Modal>
  );
}
