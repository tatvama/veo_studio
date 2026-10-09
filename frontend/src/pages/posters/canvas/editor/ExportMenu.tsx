/**
 * Toolbar "Export": PNG, JPG, WebP or PDF at 1× (design / print size) or 2×. The page is rendered in the browser,
 * downloaded straight away, and also kept on the server (PDF is made there) with a list of recent exports.
 */
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download, ExternalLink } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { Button, Popover, Segmented, Toggle } from "../../../../components/ui";
import { ago } from "../../../../lib/format";
import { useT } from "../../../../lib/i18n";
import { designsApi, useExports } from "../../api";
import { useEditor } from "../../store";
import { effectiveFormat } from "../commands";
import { getExporter } from "../exporter";

type Kind = "png" | "jpg" | "webp" | "pdf";
const MAX_SIDE = 8192;

function slug(s: string) {
  return (s || "design").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "design";
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const bytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function ExportMenu({ designId, canEdit }: { designId: number; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("png");
  const [scale, setScale] = useState<1 | 2>(1);
  const [transparent, setTransparent] = useState(false);
  const [busy, setBusy] = useState(false);
  const { W, H, title, format } = useEditor(useShallow((s) => ({ W: s.width, H: s.height, title: s.design?.title ?? "", format: s.design?.format ?? "" })));
  const exports = useExports(open ? designId : 0);
  const print = effectiveFormat(format, W, H).format?.group === "Print";
  const k = Math.min(scale, MAX_SIDE / Math.max(W, H));
  const outW = Math.round(W * k), outH = Math.round(H * k);
  const alpha = transparent && (kind === "png" || kind === "webp");

  const run = async () => {
    const ex = getExporter();
    if (!ex) { toast.error(t("The canvas isn't ready yet.")); return; }
    setBusy(true);
    const id = toast.loading(t("Rendering {w} × {h}…", { w: outW, h: outH }));
    try {
      const mime = kind === "jpg" ? "image/jpeg" : kind === "webp" ? "image/webp" : "image/png";
      const blob = await ex.render({ pixelRatio: scale, maxSide: MAX_SIDE, mime, quality: 0.93, background: !alpha });
      const name = `${slug(title)}_${outW}x${outH}.${kind}`;
      if (kind !== "pdf") downloadBlob(blob, name);
      toast.loading(kind === "pdf" ? t("Making the PDF…") : t("Saving a copy to the design…"), { id });
      const rec = canEdit ? await designsApi.exportFile(designId, blob, kind) : null;
      if (kind === "pdf" && rec) {
        const r = await fetch(rec.url, { credentials: "include" });
        if (!r.ok) throw new Error(t("The PDF couldn't be downloaded"));
        downloadBlob(await r.blob(), name);
      }
      void qc.invalidateQueries({ queryKey: ["design-exports", designId] });
      toast.success(t("Exported {kind}", { kind: kind.toUpperCase() }), { id, description: `${outW} × ${outH} px${rec ? ` · ${bytes(rec.bytes)}` : ""}` });
    } catch (e) {
      toast.error(t("Export failed"), { id, description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button ref={ref} size="sm" variant="primary" icon={<Download className="size-4" />} iconRight={<ChevronDown className="size-3.5 opacity-70" />}
        onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog">
        <span className="max-sm:hidden">{t("Export")}</span>
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-end" width={320} className="overflow-hidden p-0">
        <div className="space-y-3 px-3.5 py-3">
          <div>
            <span className="eyebrow block pb-1.5">{t("File type")}</span>
            <Segmented<Kind> size="sm" value={kind} onChange={setKind} className="w-full [&>button]:flex-1"
              options={[{ value: "png", label: "PNG" }, { value: "jpg", label: "JPG" }, { value: "webp", label: "WebP" }, { value: "pdf", label: "PDF" }]} />
          </div>
          <div>
            <span className="eyebrow block pb-1.5">{t("Size")}</span>
            <Segmented<1 | 2> size="sm" value={scale} onChange={setScale} className="w-full [&>button]:flex-1"
              options={[
                { value: 1, label: print ? t("Print size") : "1×", title: t("The design size") },
                { value: 2, label: "2×", title: t("Twice the design size") },
              ]} />
            <p className="mono mt-1.5 text-2xs text-dim">
              {outW} × {outH} px{kind === "pdf" || print ? ` · ${(outW / 300 * 2.54).toFixed(1)} × ${(outH / 300 * 2.54).toFixed(1)} cm @ 300 dpi` : ""}
            </p>
          </div>
          {(kind === "png" || kind === "webp") && (
            <Toggle checked={transparent} onChange={setTransparent} label={<span className="text-xs">{t("Transparent background")}</span>} />
          )}
          <Button variant="primary" block loading={busy} icon={<Download className="size-4" />} onClick={() => void run()}>
            {t("Download {kind}", { kind: kind.toUpperCase() })}
          </Button>
        </div>
        <div className="border-t border-line bg-raised/40 px-1.5 py-2">
          <span className="eyebrow block px-2 pb-1">{t("Recent exports")}</span>
          {!exports.data?.length ? (
            <p className="px-2 py-2 text-2xs text-dim">{exports.isLoading ? t("Loading…") : t("Nothing exported yet.")}</p>
          ) : (
            <ul className="max-h-44 overflow-y-auto">
              {exports.data.slice(0, 6).map((x) => (
                <li key={x.id}>
                  <a href={x.url} target="_blank" rel="noreferrer" download
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-mute transition-colors hover:bg-hover hover:text-ink">
                    <span className="mono w-10 shrink-0 rounded border border-line bg-panel px-1 text-center text-2xs uppercase text-ink">{x.kind}</span>
                    <span className="mono min-w-0 flex-1 truncate">{x.width}×{x.height} · {bytes(x.bytes)}</span>
                    <span className="shrink-0 text-2xs text-dim">{ago(x.created_at)}</span>
                    <ExternalLink className="size-3 shrink-0 text-dim" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Popover>
    </>
  );
}
