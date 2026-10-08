import { clsx } from "clsx";
import { UploadCloud } from "lucide-react";
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Spinner } from "../../components/ui";
import { useT } from "../../lib/i18n";

/**
 * Click-or-drop upload target. Validates type and size before handing files over, highlights while a file is dragged over it
 * and shows a spinner while the parent uploads.
 */
export function DropZone({ accept, maxMb = 15, multiple, busy, disabled, onFiles, title, hint, icon, className, children, compact }: {
  accept: string[]; maxMb?: number; multiple?: boolean; busy?: boolean; disabled?: boolean; onFiles: (files: File[]) => void;
  title: ReactNode; hint?: ReactNode; icon?: ReactNode; className?: string; children?: ReactNode; compact?: boolean;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0); // dragenter/leave fire for every child; count them so the highlight doesn't flicker

  const take = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const ok: File[] = [];
    for (const f of files) {
      const type = f.type || "";
      if (accept.length && !accept.some((a) => (a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a))) {
        toast.error(t("{name} is not a supported file type", { name: f.name }));
      } else if (f.size > maxMb * 1024 * 1024) {
        toast.error(t("{name} is too large (max {n} MB)", { name: f.name, n: maxMb }));
      } else ok.push(f);
    }
    if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
    if (input.current) input.current.value = "";
  };

  const block = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const open = () => { if (!disabled && !busy) input.current?.click(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };

  return (
    <div
      role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} aria-busy={busy || undefined}
      aria-label={typeof title === "string" ? title : undefined}
      onClick={open} onKeyDown={key}
      onDragEnter={(e) => { block(e); if (disabled) return; depth.current += 1; setOver(true); }}
      onDragOver={(e) => { block(e); if (!disabled) e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(e) => { block(e); depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDrop={(e) => { block(e); depth.current = 0; setOver(false); if (!disabled && !busy) take(e.dataTransfer.files); }}
      className={clsx(
        "group relative flex cursor-pointer select-none items-center justify-center gap-3 rounded-xl border border-dashed text-center transition-[border-color,background-color,transform,box-shadow] duration-200",
        compact ? "px-4 py-4" : "flex-col px-4 py-6",
        over ? "scale-[1.01] border-accent bg-accent/10 shadow-glow" : "border-line bg-raised/30 hover:border-dim/60 hover:bg-raised/60",
        (disabled || busy) && "cursor-not-allowed opacity-70", className,
      )}
    >
      <input ref={input} type="file" hidden multiple={multiple} accept={accept.join(",")} disabled={disabled} onChange={(e) => take(e.target.files)} />
      {children}
      <span className={clsx("grid shrink-0 place-items-center rounded-full bg-raised text-mute transition-colors group-hover:text-ink", compact ? "size-9" : "size-11", over && "bg-accent/20 text-accent-ink")}>
        {busy ? <Spinner className="size-5" /> : icon ?? <UploadCloud className="size-5" />}
      </span>
      <span className={clsx("min-w-0", compact && "text-left")}>
        <span className="block text-sm font-medium">{over ? t("Drop to upload") : title}</span>
        {hint && <span className="mt-0.5 block text-xs text-mute">{hint}</span>}
      </span>
    </div>
  );
}
