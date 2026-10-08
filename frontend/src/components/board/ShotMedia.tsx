import { ImagePlus, ImageUp, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import type { ShotRef } from "../../lib/types";
import { Button, Tooltip } from "../ui";

const ACCEPT = "image/png,image/jpeg,image/webp";

/** Use your own image as the shot's keyframe; the video is then made from it. */
export function UploadKeyframeButton({ shotId, onDone, size = "sm", label }: {
  shotId: number; onDone: () => void; size?: "sm" | "md"; label?: string;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      await api.upload(`/api/shots/${shotId}/keyframe/upload`, f);
      toast.success(tr("Your keyframe is set — the video will start from it"));
      onDone();
    } catch { /* api toasts */ } finally { setBusy(false); }
  };
  return (
    <>
      <Tooltip content={t("Use your own image as this shot's keyframe; the video starts from it")}>
        <Button size={size} variant="outline" icon={<ImageUp className="size-3.5" />} loading={busy} onClick={() => input.current?.click()}>
          {label ?? t("Upload keyframe")}
        </Button>
      </Tooltip>
      <input ref={input} type="file" hidden accept={ACCEPT} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void pick(f); }} />
    </>
  );
}

/**
 * The shot's own references (a product, a prop, a look): up to 4 images the keyframe and video must follow,
 * on top of the characters' photos.
 */
export function ShotRefs({ shotId, refs, canEdit, onChanged, compact }: {
  shotId: number; refs: ShotRef[]; canEdit: boolean; onChanged: () => void; compact?: boolean;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const add = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      for (const f of files.slice(0, Math.max(0, 4 - refs.length))) {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("label", f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 60));
        await api.post(`/api/shots/${shotId}/refs`, fd);
      }
      toast.success(tr("Reference added — used for this shot's keyframe and video"));
      onChanged();
    } catch { /* api toasts */ } finally { setBusy(false); }
  };
  const remove = async (i: number) => {
    try { await api.del(`/api/shots/${shotId}/refs/${i}`); onChanged(); } catch { /* api toasts */ }
  };
  const size = compact ? "size-10" : "size-14";
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t("Shot references")}>
      {refs.map((r, i) => (
        <div key={`${r.url}-${i}`} className={`group relative ${size} overflow-hidden rounded-md border border-line`} title={r.label}>
          <img src={r.url} alt={r.label} className="size-full object-cover" />
          {canEdit && (
            <button type="button" aria-label={t("Remove reference {name}", { name: r.label })} onClick={() => void remove(i)}
              className="absolute inset-0 grid place-items-center bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100">
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      ))}
      {canEdit && refs.length < 4 && (
        <Tooltip content={t("Add a reference image for this shot: a product, a prop, a look (up to 4)")}>
          <button type="button" disabled={busy} onClick={() => input.current?.click()}
            className={`${size} grid place-items-center rounded-md border border-dashed border-line text-dim transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-50`}
            aria-label={t("Add reference image")}>
            <ImagePlus className="size-4" />
          </button>
        </Tooltip>
      )}
      <input ref={input} type="file" hidden multiple accept={ACCEPT}
        onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; void add(fs); }} />
    </div>
  );
}
