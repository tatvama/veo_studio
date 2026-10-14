/**
 * Make my look (docs/EDITOR.md §16.8): pick the channel's logo, its main colours are found (k-means on its pixels,
 * designer/palette.ts), choose one of the ready looks as the style, check the preview, name it and save (to the
 * library, and to this edit if wanted). The brand colours can be adjusted; text contrast is kept readable.
 */
import { clsx } from "clsx";
import { Check, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Modal } from "../../../components/ui";
import { newLookId, saveLook } from "../library";
import { BUILTIN_LOOKS } from "../looks";
import type { ChannelLook } from "../types";
import { ColorField, Swatch } from "./controls";
import { BinImagePicker } from "./LookEditor";
import { fileToDataUrl, loadImg, logoDataUrl, pickImageFile, pixelsOf } from "./logo";
import { LookPreview } from "./LookPreview";
import { brandColors, contrastChecks, logoPalette, lookColors, type BrandColors, type Swatch as Sw } from "./palette";

/** `start`: a logo to begin with (the current look's), as a data: URL or picture URL. */
export function MakeMyLook({ open, onClose, onUse, start }: { open: boolean; onClose: () => void; onUse: (l: ChannelLook) => void; start?: { image: string; mediaId?: string } }) {
  const [logo, setLogo] = useState<{ image: string; mediaId?: string } | null>(null);
  const [swatches, setSwatches] = useState<Sw[]>([]);
  const [brand, setBrand] = useState<BrandColors | null>(null);
  const [baseId, setBaseId] = useState(BUILTIN_LOOKS[0].id);
  const [name, setName] = useState("My channel");
  const [busy, setBusy] = useState(false);
  const id = useMemo(() => newLookId(), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromImg = async (src: string, mediaId?: string) => {
    setBusy(true);
    try {
      const img = await loadImg(src);
      const px = pixelsOf(img);
      const sw = logoPalette(px.data, px.w, px.h);
      if (!sw.length) throw new Error("No colours found in that picture.");
      setSwatches(sw);
      setBrand(brandColors(sw));
      setLogo({ image: logoDataUrl(img), ...(mediaId ? { mediaId } : {}) });
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (open && start?.image && !logo) void fromImg(start.image, start.mediaId);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const make = (base: ChannelLook): ChannelLook | null => {
    if (!brand) return null;
    const l = JSON.parse(JSON.stringify(base)) as ChannelLook;
    delete l.builtIn;
    l.id = id; l.name = name.trim() || "My channel";
    l.colors = lookColors(brand, base.colors);
    l.logo = { ...(logo ?? {}), text: base.logo?.text };
    return l;
  };
  const base = BUILTIN_LOOKS.find((b) => b.id === baseId)!;
  const result = make(base);
  const bad = result ? contrastChecks(result.colors).filter((c) => c.ratio < 4.5 && c.label !== "Text on breaking") : [];

  const save = async (use: boolean) => {
    if (!result) return;
    try { await saveLook(result); } catch (e) { toast.error(`Couldn't save the look: ${(e as Error).message}`); return; }
    if (use) onUse(result);
    toast.success(use ? `“${result.name}” saved and in use` : `“${result.name}” saved to your looks`);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} size="xl" title="Make my look"
      footer={<>
        <span className="mr-auto self-center text-2xs text-dim">{result ? "Saved looks are in the Channel look panel and work in every edit." : "Start with your logo."}</span>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!result} onClick={() => void save(false)}>Save to my looks</Button>
        <Button variant="primary" disabled={!result} onClick={() => void save(true)}>Save and use it here</Button>
      </>}>
      <div className="grid gap-5 md:grid-cols-[280px_1fr]">
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium">1 · Your logo</p>
            <div className="grid h-28 place-items-center rounded-lg border border-dashed border-line bg-raised/50 p-3">
              {logo ? <img src={logo.image} alt="Your logo" className="max-h-full max-w-full object-contain" /> : <span className="text-2xs text-dim">{busy ? "Reading the colours…" : "No logo yet"}</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <BinImagePicker onPick={(u, m) => void fromImg(u, m)} disabled={busy} />
              <button type="button" disabled={busy} className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
                onClick={async () => { const f = await pickImageFile(); if (f) void fromImg(await fileToDataUrl(f)); }}><Upload className="size-3.5" />From a file…</button>
            </div>
          </div>
          {swatches.length > 0 && brand && (
            <div>
              <p className="mb-1.5 text-xs font-medium">Colours found</p>
              <div className="mb-3 flex gap-1.5">{swatches.map((s) => <Swatch key={s.hex} css={s.hex} size={26} title={`${s.hex} · ${Math.round(s.share * 100)} %`} />)}</div>
              <div className="space-y-1.5">
                {(["primary", "secondary", "accent"] as const).map((k) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-20 text-2xs text-mute">{k === "primary" ? "Main colour" : k === "secondary" ? "Second colour" : "Highlight"}</span>
                    <ColorField value={brand[k]} onChange={(v) => setBrand({ ...brand, [k]: v })} />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-2xs leading-snug text-dim">Plates are darkened or lightened just enough that their text reads well.</p>
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-medium">Name</span>
            <input className="ed-field h-8 w-full" value={name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <div className="min-w-0 space-y-3">
          <p className="text-xs font-medium">2 · A style</p>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {BUILTIN_LOOKS.map((b) => {
              const l = make(b) ?? b;
              const on = b.id === baseId;
              return (
                <button key={b.id} type="button" onClick={() => setBaseId(b.id)}
                  className={clsx("rounded-lg border p-1.5 text-left transition-colors", on ? "border-accent bg-accent/10" : "border-line hover:border-dim/50")}>
                  <LookPreview look={l} crop />
                  <span className="mt-1 flex items-center gap-1 px-0.5 text-2xs">{on && <Check className="size-3 text-accent-ink" />}{b.name}<span className="text-dim">· {b.motion}, {b.plate}</span></span>
                </button>
              );
            })}
          </div>
          {result && (
            <div>
              <p className="mb-1.5 text-xs font-medium">3 · Your look</p>
              <LookPreview look={result} className="max-w-[560px]" />
              {bad.length > 0 && <p className="mt-1 text-2xs text-warn">Some text may be hard to read: {bad.map((b) => b.label.toLowerCase()).join(", ")}. You can fine-tune the colours later in the look editor.</p>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
