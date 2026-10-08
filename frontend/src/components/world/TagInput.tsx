import { clsx } from "clsx";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";

/** Free-text chips: type, Enter (or a comma) adds one; the × removes it. Same look as the scene card chip editor. */
export function TagInput({ value, onChange, disabled, placeholder, icon, label, compact }: {
  value: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string; icon?: ReactNode; label?: string; compact?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const add = () => {
    const v = text.trim().replace(/,$/, "").trim();
    setText("");
    if (v && !value.includes(v)) onChange([...value, v]);
  };
  return (
    <div className={clsx("flex flex-wrap items-center gap-1 rounded-lg border border-line bg-panel transition-[border-color,box-shadow]", compact ? "min-h-8 p-1" : "min-h-9 p-1.5",
      !disabled && "hover:border-dim/40 focus-within:border-accent/70 focus-within:ring-[3px] focus-within:ring-accent/15")}>
      {value.map((v, i) => (
        <span key={`${v}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-1.5 py-0.5 text-xs">
          {icon}<span className="truncate">{v}</span>
          {!disabled && (
            <button type="button" aria-label={`${t("Remove")}: ${v}`} className="rounded text-dim transition-colors hover:text-bad"
              onClick={() => onChange(value.filter((_, k) => k !== i))}><X className="size-3" /></button>
          )}
        </span>
      ))}
      {!disabled && (
        <input value={text} placeholder={value.length ? "" : placeholder} aria-label={label ?? placeholder} onChange={(e) => setText(e.target.value)} onBlur={add}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1)); }}
          className="min-w-[7rem] flex-1 bg-transparent px-1 text-xs text-ink placeholder:text-dim focus:outline-none" />
      )}
      {disabled && !value.length && <span className="px-1 text-xs text-dim">—</span>}
    </div>
  );
}
