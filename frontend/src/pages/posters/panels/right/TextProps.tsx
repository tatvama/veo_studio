/** Text layer properties: copy, font, size and spacing, alignment, fill, outline, background pill, auto-fit. */
import {
  AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, CaseUpper, Italic, TextAlignCenter, TextAlignEnd, TextAlignStart,
  TriangleAlert,
} from "lucide-react";
import { Segmented } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { useT } from "../../../../lib/i18n";
import { fixFontForText } from "../../doc";
import { SCRIPT_FALLBACK, familyStack, fontDef, loadFont, scriptOf, supports } from "../../fonts";
import type { Paint, TextBackground, TextLayer } from "../../types";
import { ColorField, IconToggle, MiniSelect, NumberField, PaintField, PropSection, Row, ToggleRow, miniInput } from "../controls";
import { isTransparent, withAlpha } from "./color";
import { FontPicker, scriptName } from "./FontPicker";
import { WEIGHT_NAMES, useLayerPatch, usePalette } from "./shared";

/** The weight closest to `want` that the family really has. */
export function nearestWeight(family: string, want: number): number {
  const ws = fontDef(family)?.weights ?? [400, 700];
  return ws.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best), ws[0]);
}

export function TextProps({ layer }: { layer: TextLayer }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const palette = usePalette();
  const def = fontDef(layer.fontFamily);
  const weights = def?.weights ?? [400, 700];
  const script = scriptOf(layer.text);
  const fits = supports(layer.fontFamily, layer.text);
  const fallback = fontDef(SCRIPT_FALLBACK[script]);

  const setText = (text: string) => {
    const p: Partial<TextLayer> = { text };
    // typing in another script (Hindi into an Anton title): switch to a family that can draw it
    if (scriptOf(text) !== scriptOf(layer.text)) {
      const fixed = fixFontForText({ ...layer, text });
      if (fixed.fontFamily !== layer.fontFamily) {
        p.fontFamily = fixed.fontFamily;
        p.fontWeight = nearestWeight(fixed.fontFamily, layer.fontWeight);
        void loadFont(fixed.fontFamily, p.fontWeight, layer.fontStyle, text.slice(0, 40));
      }
    }
    patch(p, "text");
  };
  const setFont = (family: string) => {
    const fontWeight = nearestWeight(family, layer.fontWeight);
    void loadFont(family, fontWeight, layer.fontStyle, layer.text.slice(0, 40) || "Aa");
    patch({ fontFamily: family, fontWeight });
  };
  const fix = () => {
    const fixed = fixFontForText(layer);
    if (fixed.fontFamily !== layer.fontFamily) setFont(fixed.fontFamily);
  };
  const setFill = (p: Paint | null) => patch({ fill: p ?? withAlpha(typeof layer.fill === "string" ? layer.fill : "#ffffff", 0) }, "fill");
  const bg = layer.background;
  const setBg = (p: Partial<TextBackground>, key: string) => bg && patch({ background: { ...bg, ...p } }, `bg.${key}`);
  const fs = layer.fontSize;

  return (
    <>
      <PropSection id="text" title={t("Text")}>
        <textarea
          value={layer.text}
          onChange={(e) => setText(e.target.value)}
          rows={Math.min(6, Math.max(2, layer.text.split("\n").length))}
          dir="auto"
          spellCheck
          aria-label={t("Text")}
          className={cn(miniInput, "h-auto resize-y py-1.5 text-sm leading-snug")}
          style={{ fontFamily: familyStack(layer.fontFamily) }}
        />
        {!fits && (
          <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/8 px-2 py-1.5 text-2xs leading-snug text-mute">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" />
            <span className="min-w-0 flex-1">
              {t("{font} can't draw {script}: letters may show as boxes.", { font: def?.label ?? layer.fontFamily, script: scriptName(t, script) })}
            </span>
            <button type="button" onClick={fix} className="shrink-0 font-medium text-accent-ink hover:underline">
              {t("Use {font}", { font: fallback?.label ?? SCRIPT_FALLBACK[script] })}
            </button>
          </div>
        )}
      </PropSection>

      <PropSection id="type" title={t("Typography")}>
        <FontPicker family={layer.fontFamily} text={layer.text} onPick={setFont} />
        <div className="flex items-center gap-1">
          <MiniSelect aria-label={t("Weight")} value={weights.includes(layer.fontWeight) ? layer.fontWeight : nearestWeight(layer.fontFamily, layer.fontWeight)}
            onChange={(fontWeight) => { void loadFont(layer.fontFamily, fontWeight, layer.fontStyle, layer.text.slice(0, 40)); patch({ fontWeight }); }}
            options={weights.map((w) => ({ value: w, label: `${w} · ${t(WEIGHT_NAMES[w] ?? String(w))}` }))} className="flex-1" />
          <IconToggle title={t("Italic")} active={layer.fontStyle === "italic"} onClick={() => patch({ fontStyle: layer.fontStyle === "italic" ? "normal" : "italic" })}>
            <Italic />
          </IconToggle>
          <IconToggle title={t("Uppercase")} active={!!layer.uppercase} onClick={() => patch({ uppercase: !layer.uppercase })}><CaseUpper /></IconToggle>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <NumberField label={t("Size")} title={t("Font size")} value={fs} min={4} max={2000} step={1} onChange={(fontSize) => patch({ fontSize }, "fontSize")} />
          <NumberField label={t("Line")} title={t("Line height")} value={layer.lineHeight} min={0.5} max={4} step={0.05} precision={2}
            onChange={(lineHeight) => patch({ lineHeight }, "lineHeight")} />
          <NumberField label={t("Track")} title={t("Letter spacing")} value={layer.letterSpacing} min={-50} max={500} step={0.5}
            onChange={(letterSpacing) => patch({ letterSpacing }, "letterSpacing")} />
        </div>
        <div className="flex items-center gap-1.5">
          <Segmented size="sm" aria-label={t("Horizontal alignment")} value={layer.align} onChange={(align) => patch({ align })}
            options={[
              { value: "left", label: <TextAlignStart className="size-3.5" />, title: t("Align left") },
              { value: "center", label: <TextAlignCenter className="size-3.5" />, title: t("Align centre") },
              { value: "right", label: <TextAlignEnd className="size-3.5" />, title: t("Align right") },
            ]} />
          <Segmented size="sm" aria-label={t("Vertical alignment")} value={layer.verticalAlign} onChange={(verticalAlign) => patch({ verticalAlign })}
            options={[
              { value: "top", label: <AlignVerticalJustifyStart className="size-3.5" />, title: t("Top") },
              { value: "middle", label: <AlignVerticalJustifyCenter className="size-3.5" />, title: t("Middle") },
              { value: "bottom", label: <AlignVerticalJustifyEnd className="size-3.5" />, title: t("Bottom") },
            ]} />
        </div>
        <ToggleRow label={t("Auto-fit")} hint={t("Shrink the type so it always fits its box")} checked={!!layer.autoFit} onChange={(autoFit) => patch({ autoFit })} />
      </PropSection>

      <PropSection id="text-fill" title={t("Fill")}>
        <PaintField value={layer.fill} onChange={setFill} allowNone palette={palette} />
        {typeof layer.fill === "string" && isTransparent(layer.fill) && !layer.stroke && (
          <p className="text-2xs text-dim">{t("No fill and no outline: the text is invisible. Turn on Outline for hollow lettering.")}</p>
        )}
      </PropSection>

      <PropSection id="text-stroke" title={t("Outline")}
        toggle={{ checked: !!layer.stroke, onChange: (on) => patch({ stroke: on ? { color: "#000000", width: Math.max(1, Math.round(fs * 0.04)) } : null }) }}>
        {layer.stroke && (
          <div className="flex items-center gap-1.5">
            <ColorField value={layer.stroke.color} onChange={(color) => patch({ stroke: { ...layer.stroke!, color } }, "stroke.color")} palette={palette} className="flex-1" />
            <NumberField label="W" title={t("Outline width")} value={layer.stroke.width} min={0} max={200} step={0.5} className="w-[4.5rem]"
              onChange={(width) => patch({ stroke: { ...layer.stroke!, width } }, "stroke.width")} />
          </div>
        )}
      </PropSection>

      <PropSection id="text-bg" title={t("Background pill")}
        toggle={{ checked: !!bg, onChange: (on) => patch({ background: on ? { color: palette[1] ?? "#e11d48", padding: Math.round(fs * 0.4), radius: Math.round(fs * 0.2) } : null }) }}>
        {bg && (
          <>
            <ColorField value={bg.color} onChange={(color) => setBg({ color }, "color")} palette={palette} />
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField label={t("Pad")} title={t("Padding")} value={bg.padding} min={0} max={1000} onChange={(padding) => setBg({ padding }, "padding")} />
              <NumberField label={t("Round")} title={t("Corner radius")} value={bg.radius} min={0} max={1000} onChange={(radius) => setBg({ radius }, "radius")} />
            </div>
          </>
        )}
      </PropSection>

      {layer.slot && (
        <div className="border-b border-line px-3 py-2">
          <Row label={t("Template slot")}><span className="mono truncate text-2xs text-dim">{layer.slot}</span></Row>
        </div>
      )}
    </>
  );
}
