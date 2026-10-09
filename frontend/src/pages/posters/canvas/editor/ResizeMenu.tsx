/** Toolbar "Resize": every format preset by group, a custom size, and a switch to re-lay the content (smart resize). */
import { Check, Link2, Link2Off, Scaling } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { Button, Popover, Toggle } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { useT } from "../../../../lib/i18n";
import { FORMAT_GROUPS, FORMATS, ratioLabel } from "../../formats";
import { effectiveFormat } from "../commands";
import { useEditor } from "../../store";

const MIN = 64, MAX = 8000;

export function ResizeMenu() {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { W, H, stored } = useEditor(useShallow((s) => ({ W: s.width, H: s.height, stored: s.design?.format ?? "" })));
  const { key: format, format: current } = effectiveFormat(stored, W, H);
  const [smart, setSmart] = useState(true);
  const [cw, setCw] = useState(String(W));
  const [ch, setCh] = useState(String(H));
  const [lock, setLock] = useState(false);

  useEffect(() => { if (open) { setCw(String(W)); setCh(String(H)); } }, [open, W, H]);

  const apply = (w: number, h: number, key: string, label: string) => {
    setOpen(false);
    if (w === W && h === H && key === format) return;
    useEditor.getState().resize(w, h, { smart, format: key });
    toast.success(t("Resized to {label}", { label }), { description: `${w} × ${h} px${smart ? ` · ${t("content re-laid")}` : ""}`, duration: 2200 });
  };

  const nw = Math.round(Number(cw)), nh = Math.round(Number(ch));
  const customOk = Number.isFinite(nw) && Number.isFinite(nh) && nw >= MIN && nh >= MIN && nw <= MAX && nh <= MAX;

  return (
    <>
      <Button ref={ref} size="sm" variant="ghost" icon={<Scaling className="size-4" />} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog">
        <span className="max-lg:hidden">{t("Resize")}</span>
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-start" width={348} className="overflow-hidden p-0">
        <div className="border-b border-line px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="eyebrow">{t("Page size")}</span>
            <span className="mono text-2xs text-dim">{W} × {H} · {ratioLabel(W, H)}</span>
          </div>
          <p className="mt-0.5 truncate text-sm font-medium">{current ? t(current.label) : t("Custom size")}</p>
          <div className="mt-2.5 flex items-start justify-between gap-3 rounded-lg border border-line bg-panel px-2.5 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">{t("Re-layout content")}</p>
              <p className="text-2xs leading-snug text-dim">{t("Keeps everything in proportion and stretches backgrounds to the new page.")}</p>
            </div>
            <Toggle checked={smart} onChange={setSmart} label={<span className="sr-only">{t("Re-layout content")}</span>} />
          </div>
        </div>
        <div className="max-h-[min(380px,50vh)] overflow-y-auto py-1.5">
          {FORMAT_GROUPS.map((g) => (
            <div key={g} className="px-1.5 pb-1">
              <p className="eyebrow px-2 pb-1 pt-2">{t(g)}</p>
              {FORMATS.filter((f) => f.group === g).map((f) => {
                const on = f.key === format;
                const k = Math.min(18 / f.width, 18 / f.height);
                return (
                  <button
                    key={f.key} type="button" onClick={() => apply(f.width, f.height, f.key, t(f.label))}
                    className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover", on && "bg-accent/10")}
                  >
                    <span className="grid size-6 shrink-0 place-items-center">
                      <span className={cn("block rounded-[2px] border", on ? "border-accent bg-accent/20" : "border-dim/60")} style={{ width: f.width * k, height: f.height * k }} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm", on ? "text-accent-ink" : "text-ink")}>{t(f.label)}</span>
                      <span className="block truncate text-2xs text-dim">{t(f.hint)}</span>
                    </span>
                    <span className="mono shrink-0 text-right text-2xs text-mute">{f.width}×{f.height}<br /><span className="text-dim">{ratioLabel(f.width, f.height)}</span></span>
                    {on && <Check className="size-3.5 shrink-0 text-accent-ink" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <form
          className="flex items-end gap-2 border-t border-line bg-raised/40 px-3.5 py-3"
          onSubmit={(e) => { e.preventDefault(); if (customOk) apply(nw, nh, "custom", t("Custom size")); }}
        >
          <label className="min-w-0 flex-1">
            <span className="eyebrow block pb-1">{t("Width")}</span>
            <input
              className="mono h-8 w-full rounded-lg border border-line bg-panel px-2 text-sm focus:border-accent/70 focus:outline-none" inputMode="numeric" value={cw}
              onChange={(e) => { setCw(e.target.value); if (lock && W) setCh(String(Math.round((Number(e.target.value) * H) / W) || "")); }}
            />
          </label>
          <button
            type="button" onClick={() => setLock((v) => !v)} aria-pressed={lock} title={t("Keep proportions")}
            className={cn("mb-0.5 grid size-7 place-items-center rounded-md text-xs", lock ? "bg-accent/15 text-accent-ink" : "text-dim hover:bg-hover hover:text-ink")}
          >{lock ? <Link2 className="size-3.5" /> : <Link2Off className="size-3.5" />}</button>
          <label className="min-w-0 flex-1">
            <span className="eyebrow block pb-1">{t("Height")}</span>
            <input
              className="mono h-8 w-full rounded-lg border border-line bg-panel px-2 text-sm focus:border-accent/70 focus:outline-none" inputMode="numeric" value={ch}
              onChange={(e) => { setCh(e.target.value); if (lock && H) setCw(String(Math.round((Number(e.target.value) * W) / H) || "")); }}
            />
          </label>
          <Button type="submit" size="sm" variant="primary" disabled={!customOk}>{t("Apply")}</Button>
        </form>
        {!customOk && (cw || ch) && <p className="px-3.5 pb-2.5 text-2xs text-dim">{t("Use whole pixels between {min} and {max}.", { min: MIN, max: MAX })}</p>}
      </Popover>
    </>
  );
}
