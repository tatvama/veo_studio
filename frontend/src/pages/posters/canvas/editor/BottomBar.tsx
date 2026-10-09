/** Slim bar under the canvas: zoom slider and presets, fit / 100 %, page size, snapping / safe area / grid toggles. */
import { Grid3x3, Magnet, Maximize, Minus, Plus, ScanLine } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { IconButton, Kbd, Menu } from "../../../../components/ui";
import { MOD } from "../../../../components/shell/keys";
import { cn } from "../../../../lib/cn";
import { useT } from "../../../../lib/i18n";
import { ratioLabel } from "../../formats";
import { useEditor } from "../../store";
import { canvasCommand, effectiveFormat, ZOOM_MAX, ZOOM_MIN } from "../commands";

const LMIN = Math.log2(ZOOM_MIN), LMAX = Math.log2(ZOOM_MAX);

export function BottomBar() {
  const t = useT();
  const { zoom, fit, W, H, format, snap, showSafe, showGrid, nSel } = useEditor(useShallow((s) => ({
    zoom: s.zoom, fit: s.fit, W: s.width, H: s.height, format: s.design?.format ?? "", snap: s.snap, showSafe: s.showSafe, showGrid: s.showGrid,
    nSel: s.selection.length,
  })));
  const fmt = effectiveFormat(format, W, H).format;
  const pos = (Math.log2(zoom) - LMIN) / (LMAX - LMIN);
  const toggle = (k: "snap" | "showSafe" | "showGrid") => useEditor.getState().toggle(k);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-t border-line bg-panel px-2 text-xs">
      <IconButton title={t("Zoom out")} shortcut={<Kbd>{MOD}+−</Kbd>} tipSide="top" className="size-7" onClick={() => canvasCommand({ type: "zoomBy", factor: 0.8 })}>
        <Minus className="size-3.5" />
      </IconButton>
      <input
        type="range" aria-label={t("Zoom")} className="pst-zoom-range w-28 max-sm:hidden" min={0} max={1000} step={1}
        value={Math.round(pos * 1000)} style={{ ["--pst-fill" as string]: `${pos * 100}%` }}
        onChange={(e) => canvasCommand({ type: "zoom", z: Math.pow(2, LMIN + (Number(e.target.value) / 1000) * (LMAX - LMIN)) })}
      />
      <IconButton title={t("Zoom in")} shortcut={<Kbd>{MOD}+=</Kbd>} tipSide="top" className="size-7" onClick={() => canvasCommand({ type: "zoomBy", factor: 1.25 })}>
        <Plus className="size-3.5" />
      </IconButton>
      <Menu
        placement="top-start" width={180}
        trigger={(p) => (
          <button {...p} type="button" className="mono h-7 min-w-[3.25rem] rounded-md px-1.5 text-center text-xs text-ink hover:bg-hover" aria-label={t("Zoom presets")}>
            {Math.round(zoom * 100)}%
          </button>
        )}
        items={[
          { label: t("Fit to screen"), shortcut: <Kbd>{MOD}+0</Kbd>, onClick: () => canvasCommand({ type: "fit" }), active: Math.abs(zoom - fit) < 1e-3 },
          ...[0.25, 0.5, 1, 2, 4].map((z, i) => ({
            label: `${z * 100}%`, separator: i === 0, active: Math.abs(zoom - z) < 1e-3, onClick: () => canvasCommand({ type: "zoom", z }),
            shortcut: z === 1 ? <Kbd>{MOD}+1</Kbd> : undefined,
          })),
        ]}
      />
      <IconButton title={t("Fit to screen")} shortcut={<Kbd>{MOD}+0</Kbd>} tipSide="top" className="size-7" active={Math.abs(zoom - fit) < 1e-3}
        onClick={() => canvasCommand({ type: "fit" })}>
        <Maximize className="size-3.5" />
      </IconButton>
      <button type="button" onClick={() => canvasCommand({ type: "zoom", z: 1 })}
        className={cn("mono h-7 rounded-md px-1.5 text-2xs hover:bg-hover hover:text-ink", Math.abs(zoom - 1) < 1e-3 ? "text-accent-ink" : "text-mute")}
        title={t("Actual size (100%)")}>1:1</button>

      <div className="mx-2 h-4 w-px bg-line max-md:hidden" />
      <div className="mono min-w-0 truncate text-2xs text-dim max-md:hidden">
        <span className="text-mute">{W} × {H}</span> px · {ratioLabel(W, H)}{fmt ? ` · ${t(fmt.label)}` : ""}
        {nSel > 0 && <span className="text-mute"> · {t("{n} selected", { n: nSel })}</span>}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <IconButton title={snap ? t("Smart guides on") : t("Smart guides off")} tipSide="top" className="size-7" active={snap} aria-pressed={snap} onClick={() => toggle("snap")}>
          <Magnet className={cn("size-3.5", snap && "text-accent-ink")} />
        </IconButton>
        <IconButton title={fmt?.safe ? (showSafe ? t("Hide safe areas") : t("Show safe areas")) : t("This format has no safe areas")} tipSide="top" className="size-7"
          active={showSafe && !!fmt?.safe} aria-pressed={showSafe} onClick={() => toggle("showSafe")}>
          <ScanLine className={cn("size-3.5", showSafe && fmt?.safe && "text-accent-ink")} />
        </IconButton>
        <IconButton title={showGrid ? t("Hide grid") : t("Show grid")} tipSide="top" className="size-7" active={showGrid} aria-pressed={showGrid} onClick={() => toggle("showGrid")}>
          <Grid3x3 className={cn("size-3.5", showGrid && "text-accent-ink")} />
        </IconButton>
      </div>
    </div>
  );
}
