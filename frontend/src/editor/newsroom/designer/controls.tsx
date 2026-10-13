/**
 * Small controls of the Template Designer and the look editor (docs/EDITOR.md §16.8): sections and rows in the
 * editor's panel style, a paint picker (the look's colours with opacity, a custom colour, a gradient, or none), a font
 * picker (the look's fonts, then every bundled family), an icon picker and a colour field with a hex box.
 */
import { clsx } from "clsx";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "../../../components/ui";
import { FONT_CATEGORIES, FONTS } from "../../../pages/posters/fonts";
import { ScrubNumber } from "../../ui";
import { color as resolveColor } from "../render/paint";
import { drawIcon, iconList } from "../render/icons";
import type { ChannelLook, LookColor, Paint } from "../types";
import { LOOK_COLORS } from "./validate";

export const COLOR_LABEL: Record<LookColor, string> = {
  primary: "Primary", secondary: "Secondary", accent: "Accent", dark: "Dark", light: "Light", text: "Text", textOnPrimary: "Text on primary",
  breaking: "Breaking", live: "Live", up: "Up", down: "Down",
};

// ── layout ───────────────────────────────────────────────────────────────────

/** A collapsible section (the panel's section header). */
export function Sec({ title, children, open: initial = true, right, id }: { title: ReactNode; children: ReactNode; open?: boolean; right?: ReactNode; id?: string }) {
  const key = id ? `tatvam.nr.sec.${id}` : null;
  const [open, setOpen] = useState(() => {
    if (!key) return initial;
    try { const v = localStorage.getItem(key); return v === null ? initial : v === "1"; } catch { return initial; }
  });
  const toggle = () => { setOpen(!open); if (key) try { localStorage.setItem(key, open ? "0" : "1"); } catch { /* fine */ } };
  return (
    <div>
      <div className="pn-section" onClick={toggle} role="button" aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="flex-1 truncate">{title}</span>
        {right && <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">{right}</span>}
      </div>
      {open && <div className="space-y-1 py-2">{children}</div>}
    </div>
  );
}

/** A label and its control. */
export function Row({ label, hint, children, wide }: { label: ReactNode; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={clsx("flex min-h-7 gap-2 px-3", wide ? "flex-col items-stretch" : "items-center")} title={hint}>
      <span className={clsx("shrink-0 text-2xs text-mute", wide ? "" : "w-[92px] truncate")}>{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** A small segmented choice (editor style). */
export function Seg<T extends string | number>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className={clsx("ed-seg max-w-full flex-wrap", disabled && "pointer-events-none opacity-50")}>
      {options.map((o) => <button key={String(o.value)} type="button" title={o.title} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

/** A number with its unit you can drag or type. */
export function Num({ value, onChange, min, max, step = 1, unit, digits, disabled }: {
  value: number | undefined; onChange: (v: number, done: boolean) => void; min?: number; max?: number; step?: number; unit?: string; digits?: number; disabled?: boolean;
}) {
  return <ScrubNumber value={value ?? 0} min={min} max={max} step={step} unit={unit} digits={digits} disabled={disabled} onChange={onChange} />;
}

/** A plain select in the editor's field style. */
export function Pick<T extends string>({ value, options, onChange, className, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string; disabled?: boolean }) {
  return (
    <select className={clsx("ed-field min-w-0", className)} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {!options.some((o) => o.value === value) && <option value={value}>{value || "—"}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ── colours ──────────────────────────────────────────────────────────────────

const CHECKER = "repeating-conic-gradient(#8884 0% 25%, transparent 0% 50%) 50% / 8px 8px";

/** A paint as a CSS background for a swatch. */
export function paintCss(p: Paint | undefined, look: ChannelLook): string {
  if (p && typeof p === "object") return `linear-gradient(${90 + (p.angle ?? 0)}deg, ${resolveColor(p.gradient[0], look) || "transparent"}, ${resolveColor(p.gradient[1], look) || "transparent"})`;
  return resolveColor(p, look) || "transparent";
}
export function paintLabel(p: Paint | undefined): string {
  if (!p) return "None";
  if (typeof p === "object") return "Gradient";
  if (p[0] !== "@") return p.toUpperCase();
  const [name, pct] = p.slice(1).split("/");
  const l = COLOR_LABEL[name as LookColor] ?? name;
  return pct ? `${l} · ${pct} %` : l;
}

export function Swatch({ css, size = 18, className, title }: { css: string; size?: number; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx("relative inline-block shrink-0 overflow-hidden rounded border border-line", className)} style={{ width: size, height: size, background: CHECKER }}>
      <span className="absolute inset-0" style={{ background: css }} />
    </span>
  );
}

const hex6 = (c: string) => (/^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : /^#[0-9a-f]{3}$/i.test(c) ? "#" + c.slice(1).split("").map((x) => x + x).join("") : "#000000");
const alphaOf = (c: string) => (/^#[0-9a-f]{8}$/i.test(c) ? Math.round((parseInt(c.slice(7, 9), 16) / 255) * 100) : 100);
const withA = (c: string, a: number) => (a >= 100 ? hex6(c).toUpperCase() : hex6(c).toUpperCase() + Math.round((a / 100) * 255).toString(16).padStart(2, "0").toUpperCase());

/** A colour you type as hex or pick (the look editor's colours). */
export function ColorField({ value, onChange, alpha }: { value: string; onChange: (v: string, done: boolean) => void; alpha?: boolean }) {
  const [txt, setTxt] = useState(value);
  useEffect(() => setTxt(value), [value]);
  return (
    <span className="flex items-center gap-1.5">
      <label className="relative cursor-pointer">
        <Swatch css={value} size={22} />
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={hex6(value)} onChange={(e) => onChange(alpha ? withA(e.target.value, alphaOf(value)) : e.target.value.toUpperCase(), false)}
          onBlur={(e) => onChange(alpha ? withA(e.target.value, alphaOf(value)) : e.target.value.toUpperCase(), true)} />
      </label>
      <input className="ed-field ed-tc w-[84px] uppercase" value={txt} spellCheck={false}
        onChange={(e) => setTxt(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={() => { const v = txt.trim().startsWith("#") ? txt.trim() : `#${txt.trim()}`; if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) onChange(v.toUpperCase(), true); else setTxt(value); }} />
    </span>
  );
}

type PaintTab = "look" | "custom" | "gradient";
/** A paint: one of the look's colours (with opacity), a custom colour, a two-colour gradient, or none. */
export function PaintPicker({ value, look, onChange, allowNone = true, allowGradient = true, disabled }: {
  value: Paint | undefined; look: ChannelLook; onChange: (v: Paint | undefined) => void; allowNone?: boolean; allowGradient?: boolean; disabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const isGrad = !!value && typeof value === "object";
  const isToken = typeof value === "string" && value.startsWith("@");
  const [hov, setHov] = useState<LookColor | null>(null);
  const [tab, setTab] = useState<PaintTab>(isGrad ? "gradient" : isToken || !value ? "look" : "custom");
  useEffect(() => { if (open) setTab(isGrad ? "gradient" : isToken || !value ? "look" : "custom"); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [name, pct] = isToken ? (value as string).slice(1).split("/") : ["", ""];
  const tokenAlpha = pct ? Number(pct) : 100;
  const custom = typeof value === "string" && !isToken && value ? value : resolveColor(isToken ? `@${name}` : "@primary", look) || "#FFFFFF";
  return (
    <>
      <button ref={ref} type="button" disabled={disabled} onClick={() => setOpen(!open)}
        className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-line bg-panel px-1.5 text-xs text-ink hover:bg-hover disabled:opacity-50">
        <Swatch css={paintCss(value, look)} size={14} />
        <span className="truncate">{paintLabel(value)}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={252} className="p-2.5">
        <div className="mb-2 flex items-center gap-1">
          <Seg value={tab} onChange={setTab} options={[{ value: "look", label: "Look" }, { value: "custom", label: "Custom" }, ...(allowGradient ? [{ value: "gradient" as const, label: "Gradient" }] : [])]} />
          <span className="flex-1" />
          {allowNone && <button type="button" className="rounded px-1.5 py-0.5 text-2xs text-mute hover:bg-hover hover:text-ink" onClick={() => { onChange(undefined); setOpen(false); }}>None</button>}
        </div>
        {tab === "look" && (
          <div className="space-y-2">
            <div className="grid grid-cols-6 gap-1.5" onMouseLeave={() => setHov(null)}>
              {LOOK_COLORS.map((c) => (
                <button key={c} type="button" title={COLOR_LABEL[c]} onMouseEnter={() => setHov(c)} onClick={() => onChange(tokenAlpha < 100 ? `@${c}/${tokenAlpha}` : `@${c}`)}
                  className={clsx("rounded-md p-0.5", name === c && "ring-2 ring-accent")}>
                  <Swatch css={look.colors[c]} size={30} className="block" />
                </button>
              ))}
            </div>
            <p className="text-xs font-medium">{hov ? COLOR_LABEL[hov] : name ? COLOR_LABEL[name as LookColor] ?? name : "Pick a colour of the look"}</p>
            <p className="text-2xs text-dim">Follows the channel look: change the look and this colour changes with it.</p>
            <Row label="Opacity"><Num value={tokenAlpha} min={0} max={100} step={5} unit="%" onChange={(v) => onChange(`@${name || "primary"}${Math.round(v) < 100 ? `/${Math.round(v)}` : ""}`)} /></Row>
          </div>
        )}
        {tab === "custom" && (
          <div className="space-y-2">
            <ColorField value={custom} alpha onChange={(v) => onChange(v)} />
            <Row label="Opacity"><Num value={alphaOf(custom)} min={0} max={100} step={5} unit="%" onChange={(v) => onChange(withA(custom, Math.round(v)))} /></Row>
            <p className="text-2xs text-dim">A fixed colour: it stays the same in every look.</p>
          </div>
        )}
        {tab === "gradient" && allowGradient && (
          <GradientEditor value={isGrad ? value as { gradient: [string, string]; angle?: number } : { gradient: [isToken ? value as string : "@primary", "@secondary"], angle: 0 }} look={look} onChange={onChange} />
        )}
      </Popover>
    </>
  );
}

function GradientEditor({ value, look, onChange }: { value: { gradient: [string, string]; angle?: number }; look: ChannelLook; onChange: (v: Paint) => void }) {
  const stop = (i: 0 | 1) => {
    const v = value.gradient[i];
    const tok = v.startsWith("@") ? v.slice(1).split("/")[0] : "";
    const set = (nv: string) => { const g: [string, string] = [...value.gradient]; g[i] = nv; onChange({ gradient: g, angle: value.angle ?? 0 }); };
    return (
      <Row label={i === 0 ? "From" : "To"}>
        <Pick value={tok || "custom"} onChange={(x) => set(x === "custom" ? resolveColor(v, look) || "#FFFFFF" : `@${x}`)}
          options={[...LOOK_COLORS.map((c) => ({ value: c as string, label: COLOR_LABEL[c] })), { value: "custom", label: "Custom colour" }]} className="w-[118px]" />
        {!tok && <label className="relative cursor-pointer"><Swatch css={v} size={20} /><input type="color" className="absolute inset-0 opacity-0" value={hex6(v)} onChange={(e) => set(e.target.value.toUpperCase())} /></label>}
      </Row>
    );
  };
  return (
    <div className="space-y-1.5">
      <div className="mx-3 h-6 rounded border border-line" style={{ background: paintCss(value, look) }} />
      {stop(0)}{stop(1)}
      <Row label="Angle"><Num value={value.angle ?? 0} min={-180} max={180} step={5} unit="°" onChange={(a) => onChange({ gradient: value.gradient, angle: Math.round(a) })} /></Row>
    </div>
  );
}

// ── fonts ────────────────────────────────────────────────────────────────────

export const LOOK_FONTS = [{ value: "@headline", label: "Headline (look)" }, { value: "@body", label: "Body (look)" }, { value: "@numbers", label: "Numbers (look)" }];
/** A font: one of the look's (follows the look) or a bundled family. */
export function FontPicker({ value, onChange, tokens = true, className }: { value: string | undefined; onChange: (v: string) => void; tokens?: boolean; className?: string }) {
  const v = value ?? (tokens ? "@body" : FONTS[0].family);
  const known = (tokens ? LOOK_FONTS.some((f) => f.value === v) : false) || FONTS.some((f) => f.family === v);
  return (
    <select className={clsx("ed-field min-w-0 flex-1", className)} value={v} onChange={(e) => onChange(e.target.value)} style={{ fontFamily: v.startsWith("@") ? undefined : `"${v}"` }}>
      {!known && <option value={v}>{v}</option>}
      {tokens && <optgroup label="From the channel look">{LOOK_FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</optgroup>}
      {FONT_CATEGORIES.map((c) => (
        <optgroup key={c} label={c}>{FONTS.filter((f) => f.category === c).map((f) => <option key={f.family} value={f.family}>{f.label}</option>)}</optgroup>
      ))}
    </select>
  );
}
/** The weights a family has (variable fonts: their range). */
export const weightsOf = (family: string) => FONTS.find((f) => f.family === family)?.weights ?? [400, 500, 600, 700, 800];

// ── icons ────────────────────────────────────────────────────────────────────

function IconThumb({ name, size = 26, color = "#E8EAF0" }: { name: string; size?: number; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr; c.height = size * dpr;
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    try { drawIcon(g, name, 2 * dpr, 2 * dpr, (size - 4) * dpr, (size - 4) * dpr, color, "#FFC20E"); } catch { /* an icon that can't draw stays empty */ }
  }, [name, size, color]);
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

/** An icon from the built-in set (and any a kind registered). */
export function IconPicker({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = iconList();
  const label = list.find(([n]) => n === value)?.[1].label ?? value ?? "None";
  const shown = list.filter(([n, d]) => !q || n.includes(q.toLowerCase()) || d.label.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(shown.map(([, d]) => d.group ?? "Icons"))];
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen(!open)} className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel px-1.5 text-xs hover:bg-hover">
        {value && <IconThumb name={value} size={18} />}<span className="truncate">{label}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={300} className="p-2">
        <input autoFocus className="ed-field mb-2 w-full" placeholder="Find an icon" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <div className="max-h-[300px] space-y-2 overflow-auto">
          {groups.map((g) => (
            <div key={g}>
              {groups.length > 1 && <p className="mb-1 text-2xs font-medium text-dim">{g}</p>}
              <div className="grid grid-cols-7 gap-1">
                {shown.filter(([, d]) => (d.group ?? "Icons") === g).map(([n, d]) => (
                  <button key={n} type="button" title={d.label} onClick={() => { onChange(n); setOpen(false); }}
                    className={clsx("grid place-items-center rounded-md p-1 hover:bg-hover", n === value && "bg-accent/15 ring-1 ring-accent")}>
                    <IconThumb name={n} />
                  </button>
                ))}
              </div>
            </div>
          ))}
          {!shown.length && <p className="py-4 text-center text-xs text-dim">No icon matches.</p>}
        </div>
      </Popover>
    </>
  );
}
