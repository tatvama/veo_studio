/** Photos tab: upload images, bring back any image this design has used, and the studio's stock stills. */
import { CloudUpload, Film, ImageIcon, Images, Wallpaper } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { Button, Progress, Tooltip } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { tr, useT } from "../../../../lib/i18n";
import { SLIDES } from "../../../login/showcase";
import { designsApi, type UploadResult } from "../../api";
import { useEditor } from "../../store";
import type { DropPayload, ImageLayer } from "../../types";
import { addImagesStaggered, emptySelectedSlot, fillImage, setAsBackground } from "./actions";
import { uploadsOf, useLeft } from "./state";
import { DragItem, Hint, recordSize, Section, sizeOf, useNaturalSize } from "./ui";

const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_MB = 25;

interface Pic { key: string; src: string; asset?: string; width: number; height: number; name: string; ai?: boolean }

export default function PhotosTab({ designId }: { designId: number }) {
  const t = useT();
  return (
    <>
      <UploadBox designId={designId} />
      <InThisDesign designId={designId} />
      <Section title={t("Stock stills")} icon={<Film />}>
        <div className="grid grid-cols-2 gap-1.5">
          {SLIDES.map((s) => <StillTile key={s.slug} slug={s.slug} title={s.title} />)}
        </div>
        <Hint className="mt-2">{t("Stills made with the studio's own engines. Drag one in as a photo, or set it as the background.")}</Hint>
      </Section>
    </>
  );
}

// ── upload ───────────────────────────────────────────────

function UploadBox({ designId }: { designId: number }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const rows = useLeft((s) => s.uploading);

  const send = async (files: File[]) => {
    const ok = files.filter((f) => ACCEPT.includes(f.type) && f.size <= MAX_MB * 1024 * 1024);
    const bad = files.length - ok.length;
    if (bad) toast.warning(tr("{n} file(s) skipped: use PNG, JPG, WebP or GIF up to {mb} MB.", { n: bad, mb: MAX_MB }));
    if (!ok.length) return;
    const left = useLeft.getState();
    const keyed = ok.map((f, i) => ({ f, key: `${Date.now()}_${i}_${f.name}` }));
    left.setUploading((r) => [...r, ...keyed.map(({ f, key }) => ({ key, name: f.name, progress: 0 }))]);
    const done: UploadResult[] = [];
    await Promise.all(keyed.map(async ({ f, key }) => {
      try {
        const res = await designsApi.uploadWithProgress(designId, f, (p) =>
          useLeft.getState().setUploading((r) => r.map((x) => (x.key === key ? { ...x, progress: p } : x))));
        done.push(res);
        useLeft.getState().addUpload(designId, res);
        useLeft.getState().setUploading((r) => r.filter((x) => x.key !== key));
      } catch (e) {
        const msg = e instanceof Error ? e.message : tr("Upload failed");
        useLeft.getState().setUploading((r) => r.map((x) => (x.key === key ? { ...x, error: msg } : x)));
        toast.error(tr("Couldn't upload {name}", { name: f.name }), { description: msg });
        window.setTimeout(() => useLeft.getState().setUploading((r) => r.filter((x) => x.key !== key)), 6000);
      }
    }));
    // keep the order the user picked them in
    const order = new Map(keyed.map(({ f }, i) => [f.name, i]));
    done.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
    // a single photo uploaded while an empty frame is selected goes into that frame
    const slot = done.length === 1 ? emptySelectedSlot() : null;
    if (slot) { fillImage(slot.id, done[0]); return; }
    addImagesStaggered(done.map((d) => ({ src: d.src, asset: d.asset, width: d.width, height: d.height, name: d.name.replace(/\.[a-z0-9]+$/i, "") })));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = [...e.dataTransfer.files];
    if (files.length) void send(files);
  };

  return (
    <Section title={t("Upload")} icon={<CloudUpload />}>
      <div
        onDragOver={(e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn("flex flex-col items-center gap-2 rounded-xl border border-dashed px-3 py-5 text-center transition-colors",
          over ? "border-accent bg-accent/8" : "border-line bg-raised/50")}
      >
        <CloudUpload className={cn("size-6", over ? "text-accent-ink" : "text-dim")} />
        <p className="text-xs text-mute">{t("Drop images here")}</p>
        <Button size="sm" variant="secondary" icon={<ImageIcon className="size-3.5" />} onClick={() => input.current?.click()}>{t("Upload images")}</Button>
        <p className="text-2xs text-dim">{t("PNG, JPG, WebP or GIF · up to {mb} MB each", { mb: MAX_MB })}</p>
        <input ref={input} type="file" accept={ACCEPT.join(",")} multiple hidden
          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) void send(files); }} />
      </div>
      {rows.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-live="polite">
          {rows.map((r) => (
            <li key={r.key} className="rounded-lg border border-line bg-raised px-2 py-1.5">
              <div className="mb-1 flex items-center justify-between gap-2 text-2xs">
                <span className="truncate text-mute">{r.name}</span>
                <span className={cn("mono shrink-0", r.error ? "text-bad" : "text-dim")}>{r.error ? t("Failed") : `${Math.round(r.progress * 100)}%`}</span>
              </div>
              <Progress size="sm" value={r.progress} tone={r.error ? "bad" : "accent"} indeterminate={!r.error && r.progress >= 1} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── in this design ───────────────────────────────────────

function InThisDesign({ designId }: { designId: number }) {
  const t = useT();
  const uploads = useLeft(uploadsOf(designId));
  // a cheap fingerprint of the images the layers reference, so this only recomputes when that set changes
  const key = useEditor((s) => s.doc.layers.map((l) => (l.type === "image" ? `${l.asset ?? l.src}|${(l.alternatives ?? []).map((a) => a.asset ?? a.src).join(",")}` : "")).join(";"));
  const pics = useMemo(() => {
    const out = new Map<string, Pic>();
    const add = (p: Pic) => { if (p.src && !out.has(p.key)) out.set(p.key, p); };
    for (const l of useEditor.getState().doc.layers) {
      if (l.type !== "image") continue;
      const img = l as ImageLayer;
      if (img.src) add({ key: img.asset ?? img.src, src: img.src, asset: img.asset, width: img.naturalWidth ?? img.width, height: img.naturalHeight ?? img.height,
        name: img.name, ai: !!img.ai });
      for (const a of img.alternatives ?? []) {
        if (a.src) add({ key: a.asset ?? a.src, src: a.src, asset: a.asset, width: a.width || 1024, height: a.height || 1024, name: `${img.name} (take)`, ai: true });
      }
    }
    for (const u of uploads) add({ key: u.asset, src: u.src, asset: u.asset, width: u.width, height: u.height, name: u.name.replace(/\.[a-z0-9]+$/i, "") });
    return [...out.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, uploads]);

  return (
    <Section title={t("In this design")} icon={<Images />} actions={<span className="mono text-2xs text-dim">{pics.length}</span>}>
      {pics.length ? (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            {pics.map((p) => <PicTile key={p.key} pic={p} />)}
          </div>
          <Hint className="mt-2">{t("Every upload and AI image used here, so a deleted one is easy to bring back.")}</Hint>
        </>
      ) : (
        <Hint>{t("Images you upload or generate show up here.")}</Hint>
      )}
    </Section>
  );
}

function PicTile({ pic }: { pic: Pic }) {
  const t = useT();
  const payload = (): DropPayload => ({ kind: "image", src: pic.src, asset: pic.asset, width: pic.width, height: pic.height, role: "photo", name: pic.name });
  return (
    <div className="group relative">
      <DragItem label={t("Add {name}", { name: pic.name })} payload={payload}
        className="block aspect-square overflow-hidden rounded-lg border border-line bg-[repeating-conic-gradient(var(--color-raised)_0_25%,var(--color-panel)_0_50%)] bg-[length:10px_10px] transition-colors hover:border-accent/40">
        <img data-ghost src={pic.src} alt={pic.name} loading="lazy" draggable={false} className="size-full object-contain" />
      </DragItem>
      {pic.ai && <span className="pointer-events-none absolute left-1 top-1 rounded bg-ai/85 px-1 text-2xs font-semibold text-white">AI</span>}
      <BgButton onClick={() => setAsBackground({ src: pic.src, asset: pic.asset, width: pic.width, height: pic.height, name: pic.name })} />
    </div>
  );
}

function BgButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" title={t("Set as background")} aria-label={t("Set as background")} onClick={onClick}
      className="absolute bottom-1 right-1 grid size-6 place-items-center rounded-md border border-line bg-panel/90 text-mute opacity-0 backdrop-blur transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100">
      <Wallpaper className="size-3.5" />
    </button>
  );
}

// ── stock stills ─────────────────────────────────────────

function StillTile({ slug, title }: { slug: string; title: string }) {
  const t = useT();
  const full = `/showcase/${slug}.webp`;
  const small = `/showcase/${slug}-sm.webp`;
  // the full still is only fetched once the pointer or focus comes near it (its natural size goes into the drop)
  const [near, setNear] = useState(false);
  const size = useNaturalSize(near ? full : null);
  const dims = () => {
    const known = size ?? sizeOf(full);
    if (known) return known;
    const sm = sizeOf(small);
    return sm ? { w: 1600, h: Math.round((1600 * sm.h) / sm.w) } : { w: 1600, h: 900 };
  };
  return (
    <div className="group relative overflow-hidden rounded-lg border border-line bg-raised" onPointerEnter={() => setNear(true)} onFocusCapture={() => setNear(true)}>
      <DragItem label={t("Add {name}", { name: title })}
        payload={() => { const d = dims(); return { kind: "image", src: full, width: d.w, height: d.h, role: "photo", name: title }; }}
        className="block">
        <img data-ghost src={small} alt={title} loading="lazy" draggable={false} onLoad={recordSize(small)}
          className="aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
      </DragItem>
      <div className="flex items-center justify-between gap-1 border-t border-line px-1.5 py-1">
        <span className="truncate text-2xs text-mute">{title}</span>
        <Tooltip content={t("Set as background")} side="top">
          <button type="button" aria-label={t("Set {name} as the background", { name: title })}
            onClick={() => { const d = dims(); setAsBackground({ src: full, width: d.w, height: d.h, name: title }); }}
            className="grid size-6 shrink-0 place-items-center rounded-md text-mute hover:bg-hover hover:text-accent-ink">
            <Wallpaper className="size-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
