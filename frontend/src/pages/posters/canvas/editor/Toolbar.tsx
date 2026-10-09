/** The editor's top bar: back, title, save state, undo/redo, resize, status, versions and export. */
import { ArrowLeft, BadgeCheck, CloudCheck, CloudOff, LoaderCircle, Redo2, SlidersHorizontal, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { IconButton, Kbd, Tooltip } from "../../../../components/ui";
import { MOD } from "../../../../components/shell/keys";
import { cn } from "../../../../lib/cn";
import { useT } from "../../../../lib/i18n";
import { useEditor } from "../../store";
import type { DesignStatus } from "../../types";
import { ExportMenu } from "./ExportMenu";
import { ResizeMenu } from "./ResizeMenu";
import { VersionsMenu } from "./VersionsMenu";

function TitleField({ disabled }: { disabled: boolean }) {
  const t = useT();
  const title = useEditor((s) => s.design?.title ?? "");
  const [v, setV] = useState(title);
  useEffect(() => setV(title), [title]);
  const commit = () => {
    const next = v.trim();
    if (!next) { setV(title); return; }
    if (next !== title) useEditor.getState().setMeta({ title: next });
  };
  return (
    <input
      value={v} disabled={disabled} aria-label={t("Design title")} maxLength={200} spellCheck={false}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); else if (e.key === "Escape") { setV(title); (e.target as HTMLInputElement).blur(); } }}
      className="pst-title h-8 min-w-[6rem] max-w-[22rem] truncate px-2 text-sm font-semibold tracking-tight text-ink"
      style={{ width: `${Math.min(40, Math.max(10, v.length + 2))}ch` }}
    />
  );
}

function SaveChip({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  const { save, err } = useEditor(useShallow((s) => ({ save: s.save, err: s.saveError })));
  const map = {
    idle: { icon: <CloudCheck className="size-3.5" />, label: t("Saved"), cls: "text-dim" },
    saved: { icon: <CloudCheck className="size-3.5" />, label: t("Saved"), cls: "text-dim" },
    saving: { icon: <LoaderCircle className="size-3.5 animate-spin" />, label: t("Saving…"), cls: "text-mute" },
    dirty: { icon: <span className="size-1.5 rounded-full bg-warn" />, label: t("Unsaved changes"), cls: "text-mute" },
    error: { icon: <CloudOff className="size-3.5" />, label: t("Couldn't save"), cls: "text-bad" },
    conflict: { icon: <TriangleAlert className="size-3.5" />, label: t("Conflict"), cls: "text-warn" },
  }[save];
  const chip = (
    <button
      type="button" onClick={save === "error" ? onRetry : undefined} aria-live="polite"
      className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs", map.cls, save === "error" ? "hover:bg-bad/10" : "cursor-default")}
    >
      {map.icon}
      <span className="max-lg:hidden">{map.label}</span>
    </button>
  );
  const tip = save === "error" ? `${err || t("The server didn't accept the save.")} ${t("Click to retry.")}` : save === "conflict" ? err : map.label;
  return <Tooltip content={tip} side="bottom">{chip}</Tooltip>;
}

function StatusSwitch({ canApprove, disabled }: { canApprove: boolean; disabled: boolean }) {
  const t = useT();
  const status = useEditor((s) => s.design?.status ?? "draft");
  const set = (s: DesignStatus) => { if (s !== status) useEditor.getState().setMeta({ status: s }); };
  const btn = (s: DesignStatus, label: string, off: boolean) => (
    <button
      type="button" role="radio" aria-checked={status === s} disabled={off || disabled} onClick={() => set(s)}
      className={cn("inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed",
        status === s ? (s === "approved" ? "bg-ok/15 text-ok" : "bg-raised text-ink ring-1 ring-inset ring-line") : "text-mute hover:text-ink disabled:hover:text-mute",
        off && status !== s && "opacity-50")}
    >
      {s === "approved" && <BadgeCheck className="size-3.5" />}
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label={t("Status")} className="inline-flex shrink-0 rounded-lg border border-line bg-panel p-0.5">
      {btn("draft", t("Draft"), status === "approved" && !canApprove)}
      {canApprove ? btn("approved", t("Approved"), false) : (
        <Tooltip content={t("Only a producer can approve a design")} side="bottom">{btn("approved", t("Approved"), true)}</Tooltip>
      )}
    </div>
  );
}

export function Toolbar({ designId, backTo, saveNow, canEdit, canApprove, propsToggle }: {
  designId: number; backTo: string; saveNow: (force?: boolean) => Promise<boolean>; canEdit: boolean; canApprove: boolean;
  /** narrow layouts: a button that opens the properties drawer */
  propsToggle?: { open: boolean; toggle: () => void };
}) {
  const t = useT();
  const { canUndo, canRedo } = useEditor(useShallow((s) => ({ canUndo: s.past.length > 0, canRedo: s.future.length > 0 })));
  return (
    <header className="relative flex h-12 shrink-0 items-center gap-1.5 overflow-hidden border-b border-line bg-panel px-2">
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px" />
      <Tooltip content={t("Back to posters")} side="bottom">
        <Link
          to={backTo} aria-label={t("Back to posters")} className="inline-flex size-8 items-center justify-center rounded-lg text-mute hover:bg-hover hover:text-ink"
          onClick={(e) => {
            // other unsaved work is saved on the way out; a conflict can't be, so ask first
            if (useEditor.getState().save === "conflict" && !window.confirm(t("Someone else saved this design and your latest changes aren't saved. Leave anyway?"))) e.preventDefault();
          }}
        >
          <ArrowLeft className="size-4" />
        </Link>
      </Tooltip>
      <span className="eyebrow max-md:hidden">{t("Poster")}</span>
      <TitleField disabled={!canEdit} />
      <SaveChip onRetry={() => void saveNow()} />
      <div className="mx-1 h-5 w-px bg-line" />
      <IconButton title={t("Undo")} shortcut={<Kbd>{MOD}+Z</Kbd>} tipSide="bottom" disabled={!canUndo} onClick={() => useEditor.getState().undo()}>
        <Undo2 className="size-4" />
      </IconButton>
      <IconButton title={t("Redo")} shortcut={<Kbd>{MOD}+⇧+Z</Kbd>} tipSide="bottom" disabled={!canRedo} onClick={() => useEditor.getState().redo()}>
        <Redo2 className="size-4" />
      </IconButton>
      <div className="mx-1 h-5 w-px bg-line max-sm:hidden" />
      {canEdit && <ResizeMenu />}
      <div className="ml-auto flex items-center gap-1.5">
        <div className="max-md:hidden"><StatusSwitch canApprove={canApprove} disabled={!canEdit} /></div>
        <VersionsMenu designId={designId} saveNow={saveNow} canEdit={canEdit} />
        <ExportMenu designId={designId} canEdit={canEdit} />
        {propsToggle && (
          <IconButton title={propsToggle.open ? t("Hide properties") : t("Show properties")} tipSide="bottom" active={propsToggle.open}
            aria-pressed={propsToggle.open} onClick={propsToggle.toggle}>
            <SlidersHorizontal className="size-4" />
          </IconButton>
        )}
      </div>
    </header>
  );
}
