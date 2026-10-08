import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronsUpDown, History, RotateCcw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useScriptVersions, useUsers } from "../../lib/queries";
import type { Script, ScriptVersion } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { Badge, Button, IconButton, Modal, Segmented, Skeleton } from "../ui";
import { diffLines, diffStats, foldUnchanged, markWords, type DiffRow } from "./diff";
import { Fact, RoomEmpty } from "./kit";
import { ScriptEditor } from "./ScriptEditor";
import { scoreTone, scriptToLines, TONE_TEXT_SM, useDialogFocus } from "./util";

const SOURCE: Record<string, { label: string; tone: "neutral" | "accent" | "ok" | "info" | "warn"; dot: string }> = {
  ai: { label: "AI draft", tone: "accent", dot: "bg-accent" },
  manual: { label: "Manual edit", tone: "neutral", dot: "bg-dim" },
  critic: { label: "Critic pass", tone: "info", dot: "bg-info" },
  restore: { label: "Restored", tone: "warn", dot: "bg-warn" },
};

type Mode = "current" | "previous" | "text";

/** Right-hand drawer: script history, line diff vs current/previous, restore. */
export function ScriptVersionsDrawer({ open, onClose, eid, current, canEdit, hasUnsaved }: {
  open: boolean; onClose: () => void; eid: number; current: Script | undefined; canEdit: boolean; hasUnsaved?: boolean;
}) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="veo-backdrop fixed inset-0 z-40 backdrop-blur-[2px]" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <Drawer key="drawer" eid={eid} current={current} canEdit={canEdit} onClose={onClose} hasUnsaved={hasUnsaved} />
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function Drawer({ eid, current, canEdit, onClose, hasUnsaved }: {
  eid: number; current: Script | undefined; canEdit: boolean; onClose: () => void; hasUnsaved?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  useDialogFocus(panel);
  return (
    <motion.aside ref={panel} role="dialog" aria-modal="true" aria-label={tr("Script versions")}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-5xl flex-col border-l border-line bg-panel shadow-modal"
      initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 380, damping: 40, mass: 0.9 }}>
      <DrawerBody eid={eid} current={current} canEdit={canEdit} onClose={onClose} hasUnsaved={hasUnsaved} />
    </motion.aside>
  );
}

function DrawerBody({ eid, current, canEdit, onClose, hasUnsaved }: {
  eid: number; current: Script | undefined; canEdit: boolean; onClose: () => void; hasUnsaved?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { project } = useProjectCtx();
  const { data: versions, isLoading } = useScriptVersions(eid);
  const { data: users } = useUsers();
  const [selId, setSelId] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("current");
  const [confirm, setConfirm] = useState<ScriptVersion | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !confirm) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [confirm, onClose]);

  useEffect(() => {
    if (versions?.length && !versions.some((v) => v.id === selId)) setSelId(versions[0].id);
  }, [versions, selId]);

  const sel = versions?.find((v) => v.id === selId) ?? null;
  const prev = sel && versions ? versions.find((v) => v.version < sel.version) ?? null : null;
  const author = (id: number | null) => (id ? users?.find((u) => u.id === id)?.name : null) || (id ? t("User #{id}", { id }) : t("System"));

  const restore = async (v: ScriptVersion) => {
    setBusy(true);
    try {
      await api.post(`/api/episodes/${eid}/script/versions/${v.id}/restore`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["episode", eid] }),
        qc.invalidateQueries({ queryKey: ["script-versions", eid] }),
      ]);
      toast.success(tr("Restored version {n}", { n: v.version }));
      setConfirm(null);
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <span className="grid size-8 place-items-center rounded-lg bg-accent/12 text-accent-ink"><History className="size-4" /></span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold leading-tight">{t("Script versions")}</h2>
          <p className="text-xs text-mute">{versions ? t("{n} saved", { n: versions.length }) : " "}</p>
        </div>
        <div className="flex-1" />
        <IconButton title={t("Close")} onClick={onClose} data-autofocus><X className="size-4" /></IconButton>
      </div>

      <div className="grid min-h-0 flex-1 md:grid-cols-[17rem_minmax(0,1fr)]">
        {/* version list: a timeline on wide screens, a pill strip on phones */}
        <div className="min-h-0 border-b border-line md:overflow-y-auto md:border-b-0 md:border-r">
          {isLoading ? (
            <div className="space-y-3 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : !versions?.length ? (
            <p className="p-5 text-sm text-mute">{t("No versions yet. A version is saved every time the script is written, edited, critiqued or restored.")}</p>
          ) : (
            <>
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto p-2.5 md:hidden">
                {versions.map((v) => (
                  <button key={v.id} type="button" onClick={() => setSelId(v.id)} aria-pressed={v.id === selId}
                    className={clsx("shrink-0 rounded-full border px-3 py-1 font-mono text-xs font-semibold transition-colors", v.id === selId ? "border-accent/60 bg-accent/12 text-accent-ink" : "border-line text-mute")}>
                    v{v.version}
                  </button>
                ))}
              </div>
              <ol className="relative hidden space-y-0.5 p-2 before:absolute before:bottom-6 before:left-[1.4rem] before:top-6 before:w-px before:bg-line md:block">
                {versions.map((v, i) => {
                  const src = SOURCE[v.source] ?? { label: v.source, tone: "neutral" as const, dot: "bg-dim" };
                  const score = v.critic?.overall;
                  const on = v.id === selId;
                  return (
                    <motion.li key={v.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.025 }}>
                      <button type="button" onClick={() => setSelId(v.id)} aria-current={on ? "true" : undefined}
                        className={clsx("relative flex w-full gap-3 rounded-lg px-2 py-2 text-left transition-colors", on ? "bg-accent/10 ring-1 ring-accent/40" : "hover:bg-hover")}>
                        <span className="relative z-[1] mt-1.5 grid size-3 shrink-0 place-items-center rounded-full bg-panel"><span className={clsx("size-2 rounded-full", src.dot)} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-xs font-semibold">v{v.version}</span>
                            <Badge tone={src.tone}>{t(src.label)}</Badge>
                            {i === 0 && <Badge tone="ok">{t("Latest")}</Badge>}
                            {typeof score === "number" && (
                              <span className={clsx("ml-auto text-xs font-semibold tabular-nums", TONE_TEXT_SM[scoreTone(score)])}>{score.toFixed(1)}</span>
                            )}
                          </span>
                          {v.note && <span className="mt-1 line-clamp-2 block text-xs text-mute">{v.note}</span>}
                          <span className="mt-1 block truncate text-2xs text-dim" title={new Date(v.created_at).toLocaleString()}>
                            {author(v.created_by)} · {ago(v.created_at)}
                          </span>
                        </span>
                      </button>
                    </motion.li>
                  );
                })}
              </ol>
            </>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-col">
          {!sel ? (
            <div className="p-6"><RoomEmpty icon={<History />} title={t("Select a version")} /></div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5 @md:px-5">
                <span className="font-mono text-sm font-semibold">v{sel.version}</span>
                <span className="text-xs text-mute">{new Date(sel.created_at).toLocaleString()}</span>
                <div className="flex-1" />
                <Segmented size="sm" value={mode} onChange={setMode} aria-label={t("Compare")} options={[
                  { value: "current", label: t("vs current") },
                  { value: "previous", label: t("vs previous"), title: prev ? `v${prev.version}` : t("No earlier version") },
                  { value: "text", label: t("Full text") },
                ]} />
                {canEdit && (
                  <Button size="sm" variant="primary" icon={<RotateCcw className="size-3.5" />} onClick={() => setConfirm(sel)}>{t("Restore")}</Button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {mode === "text" ? (
                  <div className="p-4 @md:p-5"><ScriptEditor script={sel.script} onChange={() => undefined} canEdit={false} pid={project.id} eid={eid} /></div>
                ) : mode === "previous" ? (
                  prev ? <DiffView from={prev.script} to={sel.script} fromLabel={`v${prev.version}`} toLabel={`v${sel.version}`} />
                    : <p className="p-6 text-sm text-mute">{t("This is the first saved version.")}</p>
                ) : (
                  <DiffView from={sel.script} to={current} fromLabel={`v${sel.version}`} toLabel={t("current")} />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={t("Restore version {n}?", { n: confirm?.version ?? "" })}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy} icon={<RotateCcw className="size-4" />} onClick={() => confirm && restore(confirm)}>{t("Restore")}</Button>
        </>}>
        <div className="space-y-2 text-sm text-mute">
          <p>{t("The episode script will be replaced by this version. The current script stays in the history, so you can switch back at any time.")}</p>
          {hasUnsaved && <p className="text-amber-300">{t("You have unsaved edits in the editor — they will be discarded.")}</p>}
          <p className="text-xs text-dim">{t("Shots are not changed. Re-plan shots afterwards if the scenes changed.")}</p>
        </div>
      </Modal>
    </>
  );
}

/** Line diff with word-level highlights on changed lines and long unchanged stretches folded away. */
export function DiffView({ from, to, fromLabel, toLabel }: { from: Script | undefined; to: Script | undefined; fromLabel: string; toLabel: string }) {
  const t = useT();
  const rows = useMemo(() => markWords(diffLines(scriptToLines(from), scriptToLines(to))), [from, to]);
  const stats = diffStats(rows);
  const items = useMemo(() => foldUnchanged(rows, 2), [rows]);
  const [openFolds, setOpenFolds] = useState<Set<number>>(new Set());

  return (
    <div>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel/95 px-4 py-2 text-xs backdrop-blur @md:px-5">
        <span className="font-mono text-mute">{fromLabel} → {toLabel}</span>
        {stats.added > 0 && <Fact tone="ok">+{stats.added}</Fact>}
        {stats.removed > 0 && <Fact tone="bad">−{stats.removed}</Fact>}
        {!stats.added && !stats.removed && <Badge tone="ok">{t("Identical")}</Badge>}
      </div>
      <div className="py-2 font-mono text-xs leading-relaxed">
        {items.map((it, i) => it.kind === "row" ? <Line key={i} row={it.row} /> : openFolds.has(i) ? (
          it.rows.map((r, k) => <Line key={`${i}-${k}`} row={r} />)
        ) : (
          <button key={i} type="button" onClick={() => setOpenFolds(new Set(openFolds).add(i))}
            className="flex w-full items-center gap-2 border-y border-line/50 bg-raised/50 px-5 py-1 text-left text-2xs text-dim transition-colors hover:bg-hover hover:text-mute">
            <ChevronsUpDown className="size-3" />{t("{n} unchanged lines", { n: it.rows.length })}
          </button>
        ))}
      </div>
    </div>
  );
}

function Line({ row }: { row: DiffRow }) {
  const mark = row.op === "add" ? "rounded-sm bg-ok/30 text-ink" : "rounded-sm bg-bad/30 text-ink";
  return (
    <div className={clsx("grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)] border-l-2 px-2",
      row.op === "add" && "border-ok bg-ok/8", row.op === "del" && "border-bad bg-bad/8", row.op === "same" && "border-transparent")}>
      <span className="select-none pr-2 text-right text-dim">{row.a ?? ""}</span>
      <span className="select-none pr-2 text-right text-dim">{row.b ?? ""}</span>
      <span className={clsx("select-none text-center", row.op === "add" ? "text-green-300" : row.op === "del" ? "text-red-300" : "text-dim")}>
        {row.op === "add" ? "+" : row.op === "del" ? "−" : ""}
      </span>
      <span className={clsx("whitespace-pre-wrap break-words pr-3", row.op === "del" ? "text-mute" : "text-ink")}>
        {row.segs ? row.segs.map((s, k) => (s.changed ? <mark key={k} className={clsx(mark, "px-px")}>{s.text}</mark> : <span key={k}>{s.text}</span>)) : row.text || " "}
      </span>
    </div>
  );
}
