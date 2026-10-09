/** Text tab: preset styles in their real fonts, font pairings, and the searchable font list. */
import { Baseline, Combine, Type } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SearchField } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { tr, useT } from "../../../../lib/i18n";
import { fixFontForText, newText, TEXT_PRESETS } from "../../doc";
import { FONT_CATEGORIES, FONTS, familyStack, fontDef, loadFont, type FontDef, type Script } from "../../fonts";
import { useEditor } from "../../store";
import type { Layer, TextLayer, TextPresetKey } from "../../types";
import { addPayload, applyFontToSelection, nearestWeight } from "./actions";
import { DragItem, Hint, Section } from "./ui";

const PREFERRED: TextPresetKey[] = ["title", "subtitle", "tagline", "body", "quote", "credits", "badge", "cta", "devanagari", "kannada", "telugu", "tamil"];
/** Every preset, in a sensible order (any preset added later shows up at the end). */
const PRESET_ORDER: TextPresetKey[] = [
  ...PREFERRED.filter((k) => k in TEXT_PRESETS),
  ...(Object.keys(TEXT_PRESETS) as TextPresetKey[]).filter((k) => !PREFERRED.includes(k)),
];

/** On-screen size of each preset's sample (the real sizes are relative to the design). */
const SAMPLE_PX: Partial<Record<TextPresetKey, number>> = {
  title: 30, subtitle: 13, tagline: 17, body: 13, quote: 18, credits: 10, badge: 13, cta: 13, devanagari: 24, kannada: 20, telugu: 20, tamil: 20,
};

const SCRIPT_SHORT: Record<Script, string> = { latin: "Latin", devanagari: "HI", kannada: "KN", telugu: "TE", tamil: "TA" };
const SCRIPT_WORDS: Record<Script, string> = { latin: "latin english", devanagari: "devanagari hindi marathi", kannada: "kannada", telugu: "telugu", tamil: "tamil" };

interface Pairing { label: string; a: string; b: string; title: string; sub: string; aw?: number; italic?: boolean }

const PAIRINGS: Pairing[] = [
  { label: "Anton + Montserrat", a: "Anton", b: "Montserrat Variable", title: "THE LAST LIGHT", sub: "A TATVAM ORIGINAL" },
  { label: "Cinzel + Inter", a: "Cinzel Variable", b: "Inter Variable", title: "KINGDOM OF ASH", sub: "An epic in five languages", aw: 700 },
  { label: "Playfair + Montserrat", a: "Playfair Display Variable", b: "Montserrat Variable", title: "A Monsoon Love Story", sub: "IN CINEMAS THIS DIWALI", aw: 700, italic: true },
  { label: "Bebas + Oswald", a: "Bebas Neue", b: "Oswald Variable", title: "NIGHT SHIFT", sub: "NEW EPISODES EVERY FRIDAY" },
  { label: "Yatra One + Anek Devanagari", a: "Yatra One", b: "Anek Devanagari Variable", title: "आख़िरी रोशनी", sub: "एक तत्वम् प्रस्तुति" },
  { label: "Abril Fatface + Poppins", a: "Abril Fatface", b: "Poppins", title: "Grand Premiere", sub: "RED CARPET · 14 NOV" },
  { label: "Bodoni + Inter", a: "Bodoni Moda Variable", b: "Inter Variable", title: "Couture", sub: "The festive collection", aw: 600 },
  { label: "Teko + Poppins", a: "Teko Variable", b: "Poppins", title: "GAME ON", sub: "Live from Bengaluru", aw: 600 },
  { label: "Great Vibes + Cinzel", a: "Great Vibes", b: "Cinzel Variable", title: "Happy Diwali", sub: "FROM ALL OF US" },
  { label: "Anek Kannada + Montserrat", a: "Anek Kannada Variable", b: "Montserrat Variable", title: "ಕೊನೆಯ ಬೆಳಕು", sub: "THE LAST LIGHT", aw: 800 },
];

/** A title + subtitle stack in two fonts, centred on the page. */
function pairingLayers(p: Pairing): Layer[] {
  const { width: W, height: H } = useEditor.getState();
  const da = fontDef(p.a), db = fontDef(p.b);
  const title = fixFontForText(newText("title", W, H, { text: p.title, fontFamily: p.a, uppercase: false, fontWeight: nearestWeight(da, p.aw ?? 400),
    fontStyle: p.italic ? "italic" : "normal", name: `Title · ${da?.label ?? p.a}` }));
  const sub = fixFontForText(newText("subtitle", W, H, { text: p.sub, fontFamily: p.b, uppercase: false, fontWeight: nearestWeight(db, 600),
    name: `Subtitle · ${db?.label ?? p.b}` }));
  const gap = Math.round(title.fontSize * 0.2);
  const top = Math.round((H - (title.height + gap + sub.height)) / 2);
  return [{ ...title, y: top }, { ...sub, y: top + title.height + gap }];
}

/** A text layer that shows off a font (its own sample text), sized like a subtitle or a title. */
function fontLayer(f: FontDef): TextLayer {
  const { width: W, height: H } = useEditor.getState();
  const big = f.category === "Display" || f.category === "Script" || f.category === "Indian";
  return fixFontForText(newText(big ? "title" : "subtitle", W, H, {
    text: f.sample, fontFamily: f.family, uppercase: false, fontWeight: nearestWeight(f, big ? 400 : 600), letterSpacing: 0, name: f.label,
    ...(big ? {} : { fontSize: Math.round(Math.min(W, H) * 0.06) }),
  }));
}

export default function TextTab() {
  const t = useT();
  const [q, setQ] = useState("");
  const current = useEditor((s) => {
    const l = s.doc.layers.find((x) => s.selection.includes(x.id) && x.type === "text");
    return l && l.type === "text" ? l.fontFamily : "";
  });

  useEffect(() => {
    for (const k of PRESET_ORDER) {
      const p = TEXT_PRESETS[k];
      void loadFont(p.family, p.weight, p.italic ? "italic" : "normal", p.text.slice(0, 30));
    }
  }, []);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (f: FontDef) => !needle || [f.label, f.category, f.sample, ...f.scripts.map((s) => SCRIPT_WORDS[s])].join(" ").toLowerCase().includes(needle);
    return FONT_CATEGORIES.map((c) => ({ c, fonts: FONTS.filter((f) => f.category === c && hit(f)) })).filter((g) => g.fonts.length);
  }, [q]);

  const pick = (f: FontDef) => {
    void loadFont(f.family, nearestWeight(f, 400), "normal", f.sample);
    const n = applyFontToSelection(f.family);
    if (n === null) addPayload({ kind: "layers", layers: [fontLayer(f)] });
    else if (n > 0) toast.success(tr("{font} applied to {n} text layer(s)", { font: f.label, n }));
  };

  return (
    <>
      <Section title={t("Text styles")} icon={<Type />}>
        <div className="space-y-1.5">
          {PRESET_ORDER.map((k) => {
            const p = TEXT_PRESETS[k];
            const pill = k === "badge" || k === "cta";
            return (
              <DragItem key={k} label={t("Add {name}", { name: t(p.name) })} payload={() => ({ kind: "text", preset: k })}
                className="group flex min-h-11 items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 transition-colors hover:border-accent/40 hover:bg-hover">
                <span className="min-w-0 flex-1">
                  <span
                    data-ghost
                    className={cn("max-w-full align-middle", k === "credits" ? "line-clamp-2" : "inline-block truncate", pill ? "rounded-md px-2 py-1" : "text-ink")}
                    style={{
                      fontFamily: familyStack(p.family), fontWeight: p.weight, fontStyle: p.italic ? "italic" : "normal", fontSize: SAMPLE_PX[k] ?? 15,
                      lineHeight: Math.max(1.05, p.lineHeight), letterSpacing: p.spacing ? `${Math.min(p.spacing, 4) * 0.5}px` : undefined,
                      textTransform: p.uppercase ? "uppercase" : undefined,
                      ...(k === "badge" ? { background: "#e11d48", color: "#ffffff" } : k === "cta" ? { background: "#22d3ee", color: "#05070b", borderRadius: 999 } : {}),
                    }}
                  >
                    {p.text}
                  </span>
                </span>
                <span className="eyebrow shrink-0 opacity-70 group-hover:opacity-100">{t(p.name)}</span>
              </DragItem>
            );
          })}
        </div>
        <Hint className="mt-2">{t("Click to add at the centre, or drag onto the canvas. Text in Hindi, Kannada, Telugu or Tamil switches to a font that can draw it.")}</Hint>
      </Section>

      <Section title={t("Font pairings")} icon={<Combine />}>
        <div className="grid grid-cols-2 gap-1.5">
          {PAIRINGS.map((p) => (
            <DragItem key={p.label} label={t("Add {name}", { name: p.label })} payload={() => ({ kind: "layers", layers: pairingLayers(p) })}
              tip={p.label} tipSide="top"
              className="flex h-[72px] flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-line bg-raised px-2 text-center transition-colors hover:border-accent/40 hover:bg-hover">
              <span data-ghost className="flex max-w-full flex-col items-center gap-0.5 text-ink">
                <span className="max-w-full truncate leading-tight" style={{ fontFamily: familyStack(p.a), fontWeight: p.aw ?? 400, fontStyle: p.italic ? "italic" : "normal", fontSize: 17 }}>
                  {p.title}
                </span>
                <span className="max-w-full truncate leading-tight text-mute" style={{ fontFamily: familyStack(p.b), fontWeight: 600, fontSize: 9.5, letterSpacing: "0.08em" }}>
                  {p.sub}
                </span>
              </span>
            </DragItem>
          ))}
        </div>
      </Section>

      <Section title={t("Fonts")} icon={<Baseline />} actions={<span className="mono text-2xs text-dim">{FONTS.length}</span>}>
        <SearchField value={q} onChange={setQ} placeholder={t("Search fonts or a script (Hindi, Tamil…)")} className="mb-2" />
        <Hint className="mb-2">{current ? t("Click a font to apply it to the selected text.") : t("Select text on the canvas to change its font, or click to add a sample.")}</Hint>
        {groups.map((g) => (
          <div key={g.c} className="mb-3 last:mb-0">
            <p className="eyebrow mb-1.5">{t(g.c)}</p>
            <div className="space-y-1">
              {g.fonts.map((f) => {
                const on = current === f.family;
                return (
                  <DragItem key={f.family} label={f.label} payload={() => ({ kind: "layers", layers: [fontLayer(f)] })} onAdd={() => pick(f)}
                    className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors",
                      on ? "border-accent/60 bg-accent/10" : "border-transparent hover:border-line hover:bg-hover")}>
                    <span className="min-w-0 flex-1">
                      <span data-ghost className="block truncate text-ink" style={{ fontFamily: familyStack(f.family), fontSize: 18, lineHeight: 1.35, fontWeight: nearestWeight(f, 400) }}>
                        {f.sample}
                      </span>
                      <span className="block truncate text-2xs text-dim">
                        {f.label} · <span className="mono">{f.weights.length > 1 ? `${f.weights[0]}–${f.weights[f.weights.length - 1]}` : f.weights[0]}</span>
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-0.5">
                      {f.scripts.filter((s) => s !== "latin").map((s) => (
                        <span key={s} className="mono rounded border border-line px-1 text-2xs leading-4 text-mute">{SCRIPT_SHORT[s]}</span>
                      ))}
                    </span>
                  </DragItem>
                );
              })}
            </div>
          </div>
        ))}
        {!groups.length && <Hint className="py-4 text-center">{t("No font matches “{q}”.", { q })}</Hint>}
      </Section>
    </>
  );
}
