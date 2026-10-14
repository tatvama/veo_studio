/**
 * The channel look editor (docs/EDITOR.md §16.2 / §16.8): every colour (with readability checks and a one-click fix),
 * the fonts (headline, body, numbers, and one per Indian script), the logo (a picture from the bin or a file, kept
 * inside the look, or a text logo), motion, plates, corners, capitals, the logo bug, numbers, clock and the ticker
 * separator. It edits a draft; the panel applies or saves it.
 */
import { clsx } from "clsx";
import { ImagePlus, Trash2, Wand2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Popover } from "../../../components/ui";
import { FONTS } from "../../../pages/posters/fonts";
import { useProject, urlFor } from "../../store";
import type { ChannelLook, FontRef, LookColor, ScriptId } from "../types";
import { COLOR_LABEL, ColorField, FontPicker, Num, Pick, Row, Sec, Seg, weightsOf } from "./controls";
import { fileToDataUrl, loadImg, logoDataUrl, pickImageFile } from "./logo";
import { contrastChecks, withContrast } from "./palette";
import { LOOK_COLORS } from "./validate";

const COLOR_HINT: Partial<Record<LookColor, string>> = {
  primary: "Main plates and tags", secondary: "Second plates and bands", accent: "Stripes, tags and highlights", dark: "Deep backgrounds",
  light: "Light boards", text: "Text on dark plates", textOnPrimary: "Text on the primary plates", breaking: "Breaking news", live: "The LIVE dot", up: "Rising numbers", down: "Falling numbers",
};
const SCRIPTS: { id: ScriptId; label: string; script: string }[] = [
  { id: "deva", label: "Hindi / Marathi", script: "devanagari" }, { id: "knda", label: "Kannada", script: "kannada" },
  { id: "telu", label: "Telugu", script: "telugu" }, { id: "taml", label: "Tamil", script: "tamil" },
];
const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Kathmandu", "Asia/Dhaka", "Europe/London", "America/New_York", "UTC"];

export function LookEditor({ look, onChange }: { look: ChannelLook; onChange: (l: ChannelLook, key?: string) => void }) {
  const set = (patch: Partial<ChannelLook>) => onChange({ ...look, ...patch });
  const setColor = (k: LookColor, v: string) => onChange({ ...look, colors: { ...look.colors, [k]: v } });
  const setFont = (k: "headline" | "body" | "numbers", f: Partial<FontRef>) => set({ fonts: { ...look.fonts, [k]: { ...look.fonts[k], ...f } } });
  const setScript = (s: ScriptId, f: FontRef | undefined) => {
    const scripts = { ...(look.fonts.scripts ?? {}) };
    if (f) scripts[s] = f; else delete scripts[s];
    set({ fonts: { ...look.fonts, scripts } });
  };
  const checks = contrastChecks(look.colors).filter((c) => c.ratio < 4.5);
  return (
    <div className="pb-4">
      <Row label="Name"><input className="ed-field min-w-0 flex-1" value={look.name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set({ name: e.target.value })} /></Row>
      <Sec title="Colours" id="look.colors">
        {LOOK_COLORS.map((k) => (
          <Row key={k} label={COLOR_LABEL[k]} hint={COLOR_HINT[k]}><ColorField value={look.colors[k]} onChange={(v) => setColor(k, v)} /><span className="truncate text-2xs text-dim">{COLOR_HINT[k]}</span></Row>
        ))}
        {checks.length > 0 && (
          <div className="mx-3 mt-1 space-y-1 rounded-md border border-warn/30 bg-warn/10 p-2">
            {checks.map((c) => (
              <div key={c.label} className="flex items-center gap-2 text-2xs">
                <span className="flex-1">{c.label} is hard to read ({c.ratio.toFixed(1)} : 1, aim for 4.5)</span>
                <button type="button" className="flex items-center gap-1 text-accent-ink hover:underline" onClick={() => {
                  const key = c.label === "Text on primary" ? "primary" : c.label === "Text on secondary" ? "secondary" : c.label === "Text on dark" ? "dark" : c.label === "Dark text on accent" ? "accent" : "breaking";
                  setColor(key as LookColor, withContrast(c.plate, c.text, 4.5));
                }}><Wand2 className="size-3" />Fix</button>
              </div>
            ))}
          </div>
        )}
      </Sec>
      <Sec title="Fonts" id="look.fonts">
        {(["headline", "body", "numbers"] as const).map((k) => (
          <Row key={k} label={k === "headline" ? "Headlines" : k === "body" ? "Body text" : "Numbers"}>
            <FontPicker value={look.fonts[k].family} tokens={false} onChange={(v) => setFont(k, { family: v, weight: nearestWeight(v, look.fonts[k].weight) })} />
            <Pick value={String(look.fonts[k].weight)} className="w-[64px]" options={weightsOf(look.fonts[k].family).map((w) => ({ value: String(w), label: String(w) }))} onChange={(v) => setFont(k, { weight: Number(v) })} />
          </Row>
        ))}
        <p className="px-3 pt-1 text-2xs text-dim">Indian scripts use their own font (letters join, so Latin fonts can't draw them):</p>
        {SCRIPTS.map((s) => {
          const f = look.fonts.scripts?.[s.id];
          const opts = FONTS.filter((x) => x.scripts.includes(s.script as never));
          return (
            <Row key={s.id} label={s.label}>
              <Pick value={f?.family ?? ""} className="min-w-0 flex-1" onChange={(v) => setScript(s.id, v ? { family: v, weight: f?.weight ?? 600 } : undefined)}
                options={[{ value: "", label: "Automatic" }, ...opts.map((o) => ({ value: o.family, label: o.label }))]} />
              {f && <Pick value={String(f.weight)} className="w-[64px]" options={weightsOf(f.family).map((w) => ({ value: String(w), label: String(w) }))} onChange={(v) => setScript(s.id, { ...f, weight: Number(v) })} />}
            </Row>
          );
        })}
      </Sec>
      <Sec title="Logo" id="look.logo"><LogoEditor look={look} onChange={(logo) => set({ logo })} /></Sec>
      <Sec title="Style" id="look.style">
        <Row label="Motion" hint="How graphics move"><Seg value={look.motion} onChange={(v) => set({ motion: v })} options={[{ value: "sharp", label: "Sharp" }, { value: "smooth", label: "Smooth" }, { value: "bouncy", label: "Bouncy" }]} /></Row>
        <Row label="Plates"><Seg value={look.plate} onChange={(v) => set({ plate: v })} options={[{ value: "flat", label: "Flat" }, { value: "glass", label: "Glass" }, { value: "angled", label: "Angled" }, { value: "rounded", label: "Rounded" }]} /></Row>
        <Row label="Corners" hint="Corner radius of rounded plates"><Num value={look.radius} min={0} max={60} unit="px" onChange={(v) => set({ radius: Math.round(v) })} /></Row>
        <Row label="Capitals" hint="Straps and tags in capitals"><input type="checkbox" checked={look.upper} onChange={(e) => set({ upper: e.target.checked })} /><span className="text-2xs text-dim">NAMES AND TAGS IN CAPITALS</span></Row>
        <Row label="Ticker separator"><Seg value={look.separator} onChange={(v) => set({ separator: v })}
          options={[{ value: "dot", label: "•" }, { value: "diamond", label: "◆" }, { value: "bar", label: "|" }, { value: "slash", label: "/" }, { value: "logo", label: "Logo" }]} /></Row>
      </Sec>
      <Sec title="Logo bug" id="look.bug" open={false}>
        <Row label="Corner"><Seg value={look.bug.corner} onChange={(v) => set({ bug: { ...look.bug, corner: v } })} options={[{ value: "tl", label: "↖" }, { value: "tr", label: "↗" }, { value: "bl", label: "↙" }, { value: "br", label: "↘" }]} /></Row>
        <Row label="Size"><Num value={Math.round(look.bug.scale * 100)} min={40} max={250} step={5} unit="%" onChange={(v) => set({ bug: { ...look.bug, scale: Math.round(v) / 100 } })} /></Row>
        <Row label="Opacity"><Num value={Math.round(look.bug.opacity * 100)} min={10} max={100} step={5} unit="%" onChange={(v) => set({ bug: { ...look.bug, opacity: Math.round(v) / 100 } })} /></Row>
      </Sec>
      <Sec title="Numbers, clock and date" id="look.numbers" open={false}>
        <Row label="Grouping" hint="Indian: 12,34,567 and lakh / crore. International: 1,234,567 and K / M"><Seg value={look.numbers.system} onChange={(v) => set({ numbers: { ...look.numbers, system: v } })} options={[{ value: "indian", label: "Indian" }, { value: "international", label: "International" }]} /></Row>
        <Row label="Digits"><Seg value={look.numbers.digits} onChange={(v) => set({ numbers: { ...look.numbers, digits: v } })} options={[{ value: "latin", label: "123" }, { value: "native", label: "१२३ (script's own)" }]} /></Row>
        <Row label="Currency"><Pick value={look.numbers.currency} className="w-[90px]" onChange={(v) => set({ numbers: { ...look.numbers, currency: v } })} options={["₹", "Rs ", "$", "€", "£", "AED "].map((c) => ({ value: c, label: c.trim() }))} /></Row>
        <Row label="Clock"><Seg value={String(look.clock.hours)} onChange={(v) => set({ clock: { ...look.clock, hours: Number(v) as 12 | 24 } })} options={[{ value: "24", label: "24 hours" }, { value: "12", label: "12 hours" }]} /></Row>
        <Row label="Time zone"><Pick value={look.clock.zone} className="min-w-0 flex-1" onChange={(v) => set({ clock: { ...look.clock, zone: v } })} options={ZONES.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))} /></Row>
        <Row label="Date"><Seg value={look.clock.date} onChange={(v) => set({ clock: { ...look.clock, date: v } })} options={[{ value: "dmy", label: "14/10/2026" }, { value: "mdy", label: "10/14/2026" }, { value: "long", label: "14 October" }]} /></Row>
      </Sec>
      <Sec title="Sound hints" id="look.sounds" open={false}>
        {(["in", "out", "stinger"] as const).map((k) => (
          <Row key={k} label={k === "in" ? "Coming in" : k === "out" ? "Going out" : "Stingers"}>
            <input className="ed-field min-w-0 flex-1" value={look.sounds?.[k] ?? ""} placeholder="none" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set({ sounds: { ...look.sounds, [k]: e.target.value || undefined } })} />
          </Row>
        ))}
      </Sec>
    </div>
  );
}

const nearestWeight = (family: string, w: number) => weightsOf(family).reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));

/** A picture from the bin, or from a file (kept inside the look), or a text logo. */
export function LogoEditor({ look, onChange }: { look: ChannelLook; onChange: (logo: ChannelLook["logo"]) => void }) {
  const [busy, setBusy] = useState(false);
  const has = !!look.logo?.image;
  const fromImg = async (src: string, mediaId?: string) => {
    setBusy(true);
    try {
      const img = await loadImg(src);
      onChange({ ...look.logo, image: logoDataUrl(img), ...(mediaId ? { mediaId } : { mediaId: undefined }) });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-1.5">
      <div className="mx-3 flex items-center gap-3 rounded-md border border-line p-2" style={{ background: look.colors.primary }}>
        {has ? <img src={look.logo!.image} alt="" className="h-10 max-w-[140px] object-contain" />
          : <span className="truncate text-sm font-bold" style={{ color: look.colors.textOnPrimary, fontFamily: `"${look.fonts.headline.family}"` }}>{look.logo?.text || "No logo"}</span>}
      </div>
      <Row label="Picture">
        <BinImagePicker onPick={(url, id) => void fromImg(url, id)} disabled={busy} />
        <button type="button" disabled={busy} className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
          onClick={async () => { const f = await pickImageFile(); if (f) void fromImg(await fileToDataUrl(f)); }}>From a file…</button>
        {has && <button type="button" className="tl-tbtn" title="Remove the picture" onClick={() => onChange({ ...look.logo, image: undefined, mediaId: undefined })}><Trash2 className="size-3.5" /></button>}
      </Row>
      <Row label="Text logo" hint="Drawn in the look's headline font when there's no picture">
        <input className="ed-field min-w-0 flex-1" value={look.logo?.text ?? ""} placeholder="TATVAM NEWS" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => onChange({ ...look.logo, text: e.target.value || undefined })} />
      </Row>
      <p className="px-3 text-2xs text-dim">Pictures are kept inside the look (up to 256 KB), so a look file works on any computer.</p>
    </div>
  );
}

/** The edit's pictures as a small grid. */
export function BinImagePicker({ onPick, disabled, label = "From the bin" }: { onPick: (url: string, mediaId: string) => void; disabled?: boolean; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const p = useProject();
  const pics = p.media.filter((m) => m.kind === "image");
  return (
    <>
      <button ref={ref} type="button" disabled={disabled} onClick={() => setOpen(!open)} className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover disabled:opacity-50">
        <ImagePlus className="size-3.5" />{label}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={300} className="p-2">
        {pics.length === 0 ? <p className="p-3 text-center text-xs text-dim">The bin has no pictures. Import your logo into the edit, or pick a file.</p> : (
          <div className="grid max-h-[300px] grid-cols-3 gap-1.5 overflow-auto">
            {pics.map((m) => {
              const u = urlFor(m) ?? m.thumb;
              return (
                <button key={m.id} type="button" title={m.name} disabled={!u} onClick={() => { if (u) { onPick(u, m.id); setOpen(false); } }}
                  className={clsx("aspect-square overflow-hidden rounded-md border border-line bg-raised hover:border-accent")}>
                  {u && <img src={m.thumb ?? u} alt={m.name} className="size-full object-contain" />}
                </button>
              );
            })}
          </div>
        )}
      </Popover>
    </>
  );
}
