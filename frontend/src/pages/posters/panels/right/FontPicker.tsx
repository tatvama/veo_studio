/** Font picker: every bundled family drawn in its own face, grouped by category, with script coverage flagged. */
import { Check, ChevronDown, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Popover, SearchField } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { useT } from "../../../../lib/i18n";
import { FONTS, FONT_CATEGORIES, SCRIPT_FALLBACK, familyStack, fontDef, scriptOf, type FontCategory, type FontDef, type Script } from "../../fonts";
import { Switch } from "../controls";

export function scriptName(t: (s: string) => string, s: Script): string {
  return { latin: t("Latin"), devanagari: t("Devanagari"), kannada: t("Kannada"), telugu: t("Telugu"), tamil: t("Tamil") }[s];
}

const sampleWeight = (f: FontDef) => (f.weights.includes(400) ? (f.category === "Display" || f.category === "Indian" ? Math.max(...f.weights.filter((w) => w <= 700)) : 400) : f.weights[0]);

export function FontPicker({ family, text, onPick }: { family: string; text: string; onPick: (family: string) => void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<FontCategory | "all">("all");
  const script = scriptOf(text);
  const [onlyFit, setOnlyFit] = useState(script !== "latin");
  const [cursor, setCursor] = useState(0);
  const def = fontDef(family);
  const fits = (f: FontDef) => f.scripts.includes(script);

  useEffect(() => { if (open) { setQ(""); setOnlyFit(script !== "latin"); } }, [open, script]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = FONTS.filter((f) => (cat === "all" || f.category === cat) && (!needle || `${f.label} ${f.category}`.toLowerCase().includes(needle))
      && (!onlyFit || fits(f)));
    return FONT_CATEGORIES.map((c) => ({ cat: c, fonts: shown.filter((f) => f.category === c) })).filter((g) => g.fonts.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, cat, onlyFit, script]);
  const flat = groups.flatMap((g) => g.fonts);

  // start on the current font
  useEffect(() => {
    if (!open) return;
    const i = flat.findIndex((f) => f.family === family);
    setCursor(i < 0 ? 0 : i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, cat, onlyFit]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pick = (f: FontDef) => { onPick(f.family); setOpen(false); };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setCursor((c) => Math.max(0, Math.min(flat.length - 1, c + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && flat[cursor]) {
      e.preventDefault();
      pick(flat[cursor]);
    }
  };
  const ok = !def || fits(def);
  const cats: { value: FontCategory | "all"; label: string }[] = [{ value: "all", label: t("All") }, ...FONT_CATEGORIES.map((c) => ({ value: c, label: t(c) }))];

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn("flex h-9 w-full min-w-0 items-center gap-2 rounded-md border bg-raised px-2.5 text-left outline-none transition-[border-color,box-shadow] hover:border-dim/40 focus-visible:border-accent/70 focus-visible:ring-[3px] focus-visible:ring-accent/15",
          open ? "border-accent/70" : "border-line")}
      >
        <span className="min-w-0 flex-1 truncate text-base leading-none text-ink" style={{ fontFamily: familyStack(family) }}>{def?.label ?? family}</span>
        {!ok && <TriangleAlert className="size-3.5 shrink-0 text-warn" aria-label={t("This font can't draw the text")} />}
        <span className="eyebrow shrink-0">{def ? t(def.category) : ""}</span>
        <ChevronDown className="size-3.5 shrink-0 text-dim" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="left-start" width={300}>
        <div className="flex max-h-[min(34rem,80vh)] flex-col" onKeyDown={key}>
          <div className="space-y-2 border-b border-line p-2">
            <SearchField value={q} onChange={setQ} placeholder={t("Search fonts")} autoFocus className="[&_input]:h-8 [&_input]:text-xs" />
            <div className="flex flex-wrap gap-1">
              {cats.map((c) => (
                <button key={c.value} type="button" onClick={() => setCat(c.value)} aria-pressed={cat === c.value}
                  className={cn("rounded-md border px-2 py-0.5 text-2xs font-medium transition-colors",
                    cat === c.value ? "border-accent/40 bg-accent/12 text-accent-ink" : "border-line text-mute hover:bg-hover hover:text-ink")}>
                  {c.label}
                </button>
              ))}
            </div>
            {script !== "latin" && (
              <label className="flex items-center gap-2 text-2xs text-mute">
                <Switch checked={onlyFit} onChange={setOnlyFit} aria-label={t("Only fonts that can draw this text")} />
                {t("Only fonts that can draw {script}", { script: scriptName(t, script) })}
              </label>
            )}
          </div>
          {!ok && (
            <div className="flex items-center gap-2 border-b border-line bg-warn/8 px-2.5 py-2 text-2xs text-mute">
              <TriangleAlert className="size-3.5 shrink-0 text-warn" />
              <span className="min-w-0 flex-1">{t("{font} can't draw {script}.", { font: def?.label ?? family, script: scriptName(t, script) })}</span>
              <button type="button" onClick={() => { onPick(SCRIPT_FALLBACK[script]); setOpen(false); }} className="shrink-0 font-medium text-accent-ink hover:underline">
                {t("Use {font}", { font: fontDef(SCRIPT_FALLBACK[script])?.label ?? SCRIPT_FALLBACK[script] })}
              </button>
            </div>
          )}
          <div ref={listRef} role="listbox" aria-label={t("Fonts")} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
            {!flat.length && <p className="px-3 py-6 text-center text-xs text-dim">{t("No fonts match.")}</p>}
            {groups.map((g) => (
              <div key={g.cat} className="pb-1">
                <div className="eyebrow sticky top-0 z-[1] bg-raised px-2 pb-1 pt-2">{t(g.cat)}</div>
                {g.fonts.map((f) => {
                  const i = flat.indexOf(f);
                  const cur = f.family === family;
                  const can = fits(f);
                  return (
                    <button
                      key={f.family}
                      type="button"
                      role="option"
                      aria-selected={cur}
                      data-i={i}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => pick(f)}
                      className={cn("flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors", i === cursor && "bg-hover")}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-2xs text-mute">
                          <span className="truncate">{f.label}</span>
                          {f.weights.length > 1 && <span className="mono text-dim">{f.weights.length}w</span>}
                          {!can && (
                            <span className="inline-flex items-center gap-0.5 rounded border border-warn/30 bg-warn/10 px-1 text-[10px] leading-4 text-amber-300">
                              <TriangleAlert className="size-2.5" />{t("No {script}", { script: scriptName(t, script) })}
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-lg leading-tight text-ink" style={{ fontFamily: familyStack(f.family), fontWeight: sampleWeight(f) }}>{f.sample}</span>
                      </span>
                      {cur && <Check className="size-4 shrink-0 text-accent-ink" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </Popover>
    </>
  );
}
