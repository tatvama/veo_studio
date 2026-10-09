import { cn } from "../../lib/cn";
import { FileX2, UploadCloud } from "lucide-react";
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Spinner } from "../../components/ui";
import { useT } from "../../lib/i18n";
import "../../styles/brand.css";

const accepts = (accept: string[], type: string) => accept.some((a) => (a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a));

/**
 * Click-or-drop upload target. Validates type and size before handing files over and shows its state clearly:
 * idle (dashed), a file hovering over it (accent ring and corner brackets, "Drop to upload"), a file it will refuse (red),
 * and uploading (spinner and a sweeping bar).
 */
export function DropZone({ accept, maxMb = 15, multiple, busy, disabled, onFiles, title, hint, icon, className, children, compact }: {
  accept: string[]; maxMb?: number; multiple?: boolean; busy?: boolean; disabled?: boolean; onFiles: (files: File[]) => void;
  title: ReactNode; hint?: ReactNode; icon?: ReactNode; className?: string; children?: ReactNode; compact?: boolean;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [reject, setReject] = useState(false);
  const depth = useRef(0); // dragenter/leave fire for every child; count them so the highlight doesn't flicker

  const take = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const ok: File[] = [];
    for (const f of files) {
      const type = f.type || "";
      if (accept.length && !accepts(accept, type)) {
        toast.error(t("{name} is not a supported file type", { name: f.name }));
      } else if (f.size > maxMb * 1024 * 1024) {
        toast.error(t("{name} is too large (max {n} MB)", { name: f.name, n: maxMb }));
      } else ok.push(f);
    }
    if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
    if (input.current) input.current.value = "";
  };

  /** While dragging, the browser tells us each item's type (not its name or size): flag a file we would refuse. */
  const peek = (e: DragEvent) => {
    const items = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === "file");
    setReject(!!accept.length && items.length > 0 && items.every((i) => !!i.type && !accepts(accept, i.type)));
  };

  const block = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const open = () => { if (!disabled && !busy) input.current?.click(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  const state = busy ? "busy" : over ? (reject ? "reject" : "over") : "idle";

  return (
    <div
      role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} aria-busy={busy || undefined}
      aria-label={typeof title === "string" ? title : undefined}
      data-state={state}
      onClick={open} onKeyDown={key}
      onDragEnter={(e) => { block(e); if (disabled) return; depth.current += 1; setOver(true); peek(e); }}
      onDragOver={(e) => { block(e); if (!disabled) e.dataTransfer.dropEffect = reject ? "none" : "copy"; }}
      onDragLeave={(e) => { block(e); depth.current = Math.max(0, depth.current - 1); if (!depth.current) { setOver(false); setReject(false); } }}
      onDrop={(e) => { block(e); depth.current = 0; setOver(false); setReject(false); if (!disabled && !busy) take(e.dataTransfer.files); }}
      className={cn(
        "bk-drop hud group flex cursor-pointer select-none items-center justify-center gap-3 text-center",
        compact ? "px-4 py-4" : "flex-col px-4 py-6", className,
      )}
    >
      <input ref={input} type="file" hidden multiple={multiple} accept={accept.join(",")} disabled={disabled} onChange={(e) => take(e.target.files)} />
      {children}
      <span className={cn("bk-drop-icon grid shrink-0 place-items-center rounded-lg border", compact ? "size-9" : "size-11",
        state === "over" ? "border-accent/40 bg-accent/20 text-accent-ink"
          : state === "reject" ? "border-bad/40 bg-bad/15 text-bad"
          : cn("border-line bg-raised group-hover:text-ink", state === "busy" ? "text-accent-ink" : "text-mute"))}>
        {busy ? <Spinner className="size-5" /> : state === "reject" ? <FileX2 className="size-5" /> : icon ?? <UploadCloud className="size-5" />}
      </span>
      <span className={cn("min-w-0", compact && "text-left")}>
        <span className={cn("block text-sm font-medium", state === "reject" && "text-bad")}>
          {state === "over" ? t("Drop to upload") : state === "reject" ? t("This file type isn't supported") : state === "busy" ? t("Uploading…") : title}
        </span>
        {hint && state !== "reject" && state !== "over" && <span className="mt-0.5 block text-xs text-mute">{hint}</span>}
      </span>
      {busy && <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 overflow-hidden rounded-full bg-accent/20"><span className="sweep block size-full bg-accent/40" /></span>}
    </div>
  );
}
