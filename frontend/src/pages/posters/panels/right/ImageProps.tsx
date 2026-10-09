/** Image layer properties: the picture and its frame, crop focus, mask, outline, filters and looks, and the AI take. */
import { useQuery } from "@tanstack/react-query";
import { ImageOff, ImageUp, RotateCcw, ScanFace, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { Badge, Button, Progress, Segmented } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { useT } from "../../../../lib/i18n";
import { useCharacters } from "../../../../lib/queries";
import { designsApi, runAi } from "../../api";
import { refitImage } from "../../doc";
import { useEditor } from "../../store";
import { templateOf } from "../../templates";
import type { AiKind, ImageFilters, ImageLayer } from "../../types";
import { ColorField, IconToggle, MiniSelect, NumberField, PropSection, Row, SliderRow, miniInput, usePointerPad } from "../controls";
import { CHECKER } from "./color";
import { useLayerPatch, usePalette } from "./shared";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** CSS approximation of the Konva filters, for the look previews in the panel. */
export function filterCss(f: ImageFilters | undefined, blurScale = 0.25): string {
  if (!f) return "none";
  const parts: string[] = [];
  if (f.brightness) parts.push(`brightness(${(1 + f.brightness).toFixed(2)})`);
  if (f.contrast) parts.push(`contrast(${(1 + f.contrast / 100).toFixed(2)})`);
  if (f.saturation) parts.push(`saturate(${Math.max(0, 1 + f.saturation).toFixed(2)})`);
  if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
  if (f.grayscale) parts.push("grayscale(1)");
  if (f.sepia) parts.push("sepia(1)");
  if (f.invert) parts.push("invert(1)");
  if (f.blur) parts.push(`blur(${(f.blur * blurScale).toFixed(1)}px)`);
  return parts.join(" ") || "none";
}

interface Look { key: string; label: string; f: ImageFilters }
function looks(t: (s: string) => string): Look[] {
  return [
    { key: "original", label: t("Original"), f: {} },
    { key: "noir", label: t("Noir"), f: { grayscale: true, contrast: 35, brightness: -0.05, noise: 0.08 } },
    { key: "warm", label: t("Warm film"), f: { hue: 8, saturation: 0.18, contrast: 10, brightness: 0.03, noise: 0.12 } },
    { key: "teal", label: t("Teal & orange"), f: { hue: -10, saturation: 0.4, contrast: 22 } },
    { key: "faded", label: t("Faded"), f: { contrast: -28, brightness: 0.08, saturation: -0.35 } },
    { key: "vivid", label: t("Vivid"), f: { saturation: 0.7, contrast: 18, brightness: 0.02 } },
    { key: "moody", label: t("Moody"), f: { brightness: -0.14, contrast: 26, saturation: -0.25 } },
    { key: "vintage", label: t("Vintage"), f: { sepia: true, contrast: -10, brightness: 0.04, noise: 0.18 } },
  ];
}
const FILTER_KEYS: (keyof ImageFilters)[] = ["brightness", "contrast", "saturation", "hue", "luminance", "blur", "grayscale", "sepia", "invert", "noise", "pixelate"];
const sameFilters = (a: ImageFilters = {}, b: ImageFilters = {}) => FILTER_KEYS.every((k) => (a[k] || 0) === (b[k] || 0));

const AI_KINDS: AiKind[] = ["background", "character", "element", "product"];
function aiKindLabel(t: (s: string) => string, k: AiKind): string {
  return { background: t("Background"), character: t("Character"), element: t("Element"), product: t("Product"), harmonize: t("Relight"), restyle: t("Restyle") }[k];
}

/** The frame, the picture, focus point, mask and the other takes. */
function FrameSection({ layer, designId }: { layer: ImageLayer; designId: number }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const pickAlternative = useEditor((s) => s.useAlternative);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const replace = async (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) { toast.error(t("That isn't an image.")); return; }
    setBusy(true);
    try {
      const up = await designsApi.upload(designId, f);
      const cur = useEditor.getState().doc.layers.find((l) => l.id === layer.id);
      if (!cur || cur.type !== "image") return;
      const keep = cur.src ? [...(cur.alternatives ?? []), { src: cur.src, asset: cur.asset, width: cur.naturalWidth ?? 0, height: cur.naturalHeight ?? 0 }] : (cur.alternatives ?? []);
      const next = refitImage({ ...cur, src: up.src, asset: up.asset, ai: null, pending: null, alternatives: keep.slice(-8) }, up.width, up.height);
      useEditor.getState().patchLayer(layer.id, next);
      toast.success(t("Image replaced"));
    } catch { /* toasted by the API client */ } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  const drop = (e: DragEvent) => {
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    void replace(f);
  };

  const nw = layer.naturalWidth || 0, nh = layer.naturalHeight || 0;
  const cover = layer.fit === "cover" && nw > 0 && nh > 0;
  // the visible part of the picture when cover-cropped, as fractions of the picture
  const sc = cover ? Math.max(layer.width / nw, layer.height / nh) : 1;
  const rw = cover ? Math.min(1, layer.width / sc / nw) : 1, rh = cover ? Math.min(1, layer.height / sc / nh) : 1;
  const fx = layer.focusX ?? 0.5, fy = layer.focusY ?? 0.5;
  const padK = nw && nh ? Math.min(272 / nw, 144 / nh) : 1;
  const pad = usePointerPad((px, py) => patch({
    focusX: rw < 1 ? round2(Math.min(1, Math.max(0, (px - rw / 2) / (1 - rw)))) : 0.5,
    focusY: rh < 1 ? round2(Math.min(1, Math.max(0, (py - rh / 2) / (1 - rh)))) : 0.5,
  }, "focus"));

  return (
    <PropSection id="image" title={t("Image")}>
      <div
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn("relative grid h-32 place-items-center overflow-hidden rounded-md ring-1 ring-inset ring-line", over && "ring-2 ring-accent")}
        style={CHECKER}
      >
        {layer.src ? (
          <img src={layer.src} alt="" draggable={false} className="max-h-full max-w-full object-contain" style={{ filter: filterCss(layer.filters) }} />
        ) : (
          <div className="flex flex-col items-center gap-1 px-4 text-center">
            <ImageOff className="size-5 text-dim" />
            <span className="text-2xs text-dim">{layer.pending ? t("AI is painting this frame…") : t("Empty frame: drop a picture here, upload one, or generate it with AI below.")}</span>
          </div>
        )}
        {layer.pending && <span aria-hidden className="skeleton absolute inset-0 rounded-none opacity-60" />}
      </div>
      <div className="flex items-center gap-1.5">
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => void replace(e.target.files?.[0])} />
        <Button size="sm" icon={<ImageUp className="size-3.5" />} loading={busy} onClick={() => file.current?.click()} className="flex-1">
          {layer.src ? t("Replace…") : t("Upload…")}
        </Button>
        {nw > 0 && <span className="mono shrink-0 text-2xs text-dim">{nw}×{nh}</span>}
      </div>
      {!!layer.alternatives?.length && (
        <div>
          <div className="eyebrow mb-1">{t("Other takes")} · {layer.alternatives.length}</div>
          <div className="flex gap-1 overflow-x-auto pb-1 no-scrollbar">
            {layer.alternatives.map((a, i) => (
              <button key={`${a.src}-${i}`} type="button" onClick={() => pickAlternative(layer.id, i)} title={t("Use this take")}
                className="relative size-12 shrink-0 overflow-hidden rounded-md ring-1 ring-inset ring-line outline-none transition-[box-shadow] hover:ring-2 hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent"
                style={CHECKER}>
                <img src={a.src} alt="" draggable={false} className="size-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}
      <Row label={t("Fit")}>
        <Segmented size="sm" value={layer.fit} onChange={(fit) => patch({ fit })} className="w-full [&>button]:flex-1" aria-label={t("Fit")}
          options={[{ value: "cover", label: t("Fill"), title: t("Cover the frame and crop") }, { value: "contain", label: t("Fit"), title: t("Show the whole picture") },
            { value: "fill", label: t("Stretch"), title: t("Stretch to the frame") }]} />
      </Row>
      {cover && layer.src && (rw < 0.995 || rh < 0.995) && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-2xs text-mute">{t("Crop focus")}</span>
            <button type="button" onClick={() => patch({ focusX: 0.5, focusY: 0.5 })} className="text-2xs text-dim hover:text-ink">{t("Centre")}</button>
          </div>
          <div className="flex justify-center">
            <div
              ref={pad.ref}
              {...pad.handlers}
              role="group"
              aria-label={t("Drag to choose which part of the picture stays in the frame")}
              className="relative max-w-full cursor-move touch-none overflow-hidden rounded-md ring-1 ring-inset ring-line"
              style={{ width: Math.round(nw * padK), height: Math.round(nh * padK) }}
            >
              <img src={layer.src} alt="" draggable={false} className="pointer-events-none size-full object-fill" />
              <span className="pointer-events-none absolute rounded-[3px] border-2 border-accent shadow-[0_0_0_999px_rgb(0_0_0/0.55)]"
                style={{ left: `${(1 - rw) * fx * 100}%`, top: `${(1 - rh) * fy * 100}%`, width: `${rw * 100}%`, height: `${rh * 100}%` }} />
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <MiniSelect aria-label={t("Mask")} value={layer.mask ?? "none"} onChange={(mask) => patch({ mask })}
          options={[{ value: "none", label: t("No mask") }, { value: "circle", label: t("Circle") }, { value: "fade-bottom", label: t("Fade bottom") }, { value: "fade-top", label: t("Fade top") }]} />
        <NumberField label={t("Round")} title={t("Corner radius")} value={layer.cornerRadius ?? 0} min={0} max={4000} disabled={layer.mask === "circle"}
          onChange={(cornerRadius) => patch({ cornerRadius }, "radius")} />
      </div>
    </PropSection>
  );
}

/** Outline around the frame. */
function OutlineSection({ layer }: { layer: ImageLayer }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const palette = usePalette();
  const s = layer.stroke;
  return (
    <PropSection id="image-stroke" title={t("Outline")}
      toggle={{ checked: !!s, onChange: (on) => patch({ stroke: on ? { color: "#ffffff", width: Math.max(2, Math.round(Math.min(layer.width, layer.height) * 0.01)) } : null }) }}>
      {s && (
        <div className="flex items-center gap-1.5">
          <ColorField value={s.color} onChange={(color) => patch({ stroke: { ...s, color } }, "stroke.color")} palette={palette} className="flex-1" />
          <NumberField label="W" title={t("Outline width")} value={s.width} min={0} max={400} className="w-[4.5rem]"
            onChange={(width) => patch({ stroke: { ...s, width } }, "stroke.width")} />
        </div>
      )}
    </PropSection>
  );
}

/** Filters, looks and the reset. */
function AdjustSection({ layer }: { layer: ImageLayer }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const f = layer.filters ?? {};
  const set = (p: Partial<ImageFilters>, key?: string) => patch({ filters: { ...f, ...p } }, key ? `filter.${key}` : undefined);
  const dirty = !sameFilters(f, {});
  return (
    <PropSection id="adjust" title={t("Adjust")}
      actions={dirty ? (
        <IconToggle title={t("Reset filters")} onClick={() => patch({ filters: {} })}><RotateCcw /></IconToggle>
      ) : undefined}>
      {layer.src && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 no-scrollbar">
          {looks(t).map((lk) => {
            const on = sameFilters(f, lk.f);
            return (
              <button key={lk.key} type="button" onClick={() => patch({ filters: { ...lk.f } })} aria-pressed={on}
                className="group w-14 shrink-0 text-center outline-none">
                <span className={cn("block size-14 overflow-hidden rounded-md ring-1 ring-inset transition-[box-shadow]",
                  on ? "ring-2 ring-accent" : "ring-line group-hover:ring-dim/60 group-focus-visible:ring-2 group-focus-visible:ring-accent")}>
                  <img src={layer.src} alt="" draggable={false} className="size-full object-cover" style={{ filter: filterCss(lk.f, 0.05) }} />
                </span>
                <span className={cn("mt-0.5 block truncate text-[10px] leading-4", on ? "text-accent-ink" : "text-mute")}>{lk.label}</span>
              </button>
            );
          })}
        </div>
      )}
      <SliderRow label={t("Brightness")} value={f.brightness ?? 0} min={-1} max={1} step={0.01} scale={100} origin={0} defaultValue={0}
        onChange={(brightness) => set({ brightness }, "brightness")} />
      <SliderRow label={t("Contrast")} value={f.contrast ?? 0} min={-100} max={100} step={1} origin={0} defaultValue={0}
        onChange={(contrast) => set({ contrast }, "contrast")} />
      <SliderRow label={t("Saturation")} value={f.saturation ?? 0} min={-2} max={2} step={0.02} scale={50} origin={0} defaultValue={0}
        onChange={(saturation) => set({ saturation }, "saturation")} />
      <SliderRow label={t("Hue")} value={f.hue ?? 0} min={-180} max={180} step={1} suffix="°" origin={0} defaultValue={0}
        onChange={(hue) => set({ hue }, "hue")} />
      <SliderRow label={t("Blur")} value={f.blur ?? 0} min={0} max={40} step={0.5} defaultValue={0} onChange={(blur) => set({ blur }, "blur")} />
      <SliderRow label={t("Grain")} value={f.noise ?? 0} min={0} max={1} step={0.01} scale={100} defaultValue={0} onChange={(noise) => set({ noise }, "noise")} />
      <div className="grid grid-cols-3 gap-1">
        {([["grayscale", t("Greyscale")], ["sepia", t("Sepia")], ["invert", t("Invert")]] as const).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={!!f[k]} onClick={() => set({ [k]: !f[k] })}
            className={cn("h-7 rounded-md border text-2xs font-medium transition-colors",
              f[k] ? "border-accent/40 bg-accent/12 text-accent-ink" : "border-line bg-raised text-mute hover:bg-hover hover:text-ink")}>
            {label}
          </button>
        ))}
      </div>
    </PropSection>
  );
}

function faceTone(v: number): "ok" | "warn" | "bad" {
  return v >= 0.6 ? "ok" : v >= 0.45 ? "warn" : "bad";
}

/** Prompt, regenerate, variations, face match and progress for AI frames (and empty frames waiting for one). */
function AiSection({ layer, designId }: { layer: ImageLayer; designId: number }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const design = useEditor((s) => s.design);
  const brief = useEditor((s) => s.doc.meta?.brief);
  const ai = layer.ai;
  const guessKind: AiKind = layer.role === "background" ? "background" : layer.role === "character" ? "character" : layer.role === "product" ? "product" : "element";
  const [kind, setKind] = useState<AiKind>(ai?.kind ?? guessKind);
  const suggested = kind === "background" ? (brief || templateOf(design?.template)?.backgroundPrompt || "") : "";
  const [prompt, setPrompt] = useState(ai?.prompt || suggested);
  const [count, setCount] = useState(1);
  const [characterId, setCharacterId] = useState<number | null>(ai?.characterId ?? null);
  const [busy, setBusy] = useState(false);
  const { data: cast } = useCharacters(design?.project_id ?? undefined);

  // follow the layer when its AI info changes elsewhere (a run from the left panel)
  useEffect(() => { if (ai?.prompt !== undefined) setPrompt(ai.prompt); if (ai?.kind) setKind(ai.kind); if (ai?.characterId !== undefined) setCharacterId(ai.characterId ?? null); },
    [ai?.prompt, ai?.kind, ai?.characterId]);

  const ids = layer.pending?.jobIds ?? [];
  const { data: status } = useQuery({
    queryKey: ["poster-job-progress", ids.join(",")],
    queryFn: () => designsApi.jobStatus(ids),
    enabled: ids.length > 0,
    refetchInterval: 2500,
  });
  const waiting = status?.some((j) => j.status === "awaiting_approval");
  const progress = status?.length ? status.reduce((a, j) => a + (j.status === "succeeded" ? 1 : j.progress || 0), 0) / status.length : 0;
  const needsSource = kind === "harmonize" || kind === "restyle";
  const blocked = (kind === "character" && !characterId && !prompt.trim()) || (needsSource && !layer.asset) || (kind !== "character" && !needsSource && !prompt.trim());

  const run = async () => {
    setBusy(true);
    try {
      // keep the current picture as a take so a regenerate never loses it
      if (layer.src && !(layer.alternatives ?? []).some((a) => a.src === layer.src)) {
        patch({ alternatives: [...(layer.alternatives ?? []), { src: layer.src, asset: layer.asset, width: layer.naturalWidth ?? 0, height: layer.naturalHeight ?? 0 }].slice(-8) });
      }
      const ok = await runAi(designId, {
        kind, prompt: prompt.trim(), style: ai?.style, character_id: kind === "character" ? characterId : null, outfit: ai?.outfit, pose: ai?.pose,
        cutout: kind === "character" || kind === "element" || kind === "product", count, layerId: layer.id,
        ...(needsSource && layer.asset ? { source_asset: layer.asset } : {}),
      });
      if (ok) toast.success(count > 1 ? t("{n} takes queued", { n: count }) : t("AI take queued"));
    } finally {
      setBusy(false);
    }
  };
  const fm = ai?.faceMatch;
  const lockedCast = (cast ?? []).filter((c) => c.locked);
  const castList = lockedCast.length ? lockedCast : cast ?? [];

  return (
    <PropSection id="ai" title={<span className="inline-flex items-center gap-1.5 text-ai"><Sparkles className="size-3" />{t("AI image")}</span>}>
      {(ai?.engine || fm != null) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {ai?.engine && <Badge tone="ai"><span className="mono">{ai.engine}</span></Badge>}
          {fm != null && (
            <Badge tone={faceTone(fm)} dot title={t("How closely the face matches the locked character")}>
              <ScanFace className="size-3" />{t("Face match")} <span className="mono">{Math.round(fm * 100)}%</span>
            </Badge>
          )}
        </div>
      )}
      {!ai && (
        <Row label={t("Make")}>
          <MiniSelect aria-label={t("What to generate")} value={kind} onChange={(k) => { setKind(k); if (!prompt && k === "background") setPrompt(brief || templateOf(design?.template)?.backgroundPrompt || ""); }}
            options={AI_KINDS.map((k) => ({ value: k, label: aiKindLabel(t, k) }))} />
        </Row>
      )}
      {ai && <Row label={t("Kind")}><span className="text-xs text-ink">{aiKindLabel(t, ai.kind)}</span></Row>}
      {kind === "character" && (
        <Row label={t("Character")}>
          <MiniSelect<number | 0> aria-label={t("Character")} value={characterId ?? 0} onChange={(v) => setCharacterId(v || null)}
            options={[{ value: 0, label: castList.length ? t("Describe a person instead") : t("No characters yet") },
              ...castList.map((c) => ({ value: c.id, label: c.locked ? c.name : `${c.name} (${t("not locked")})` }))]} />
        </Row>
      )}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={() => { if (ai && prompt !== ai.prompt) patch({ ai: { ...ai, prompt } }, "ai.prompt"); }}
        rows={3}
        maxLength={2000}
        placeholder={kind === "character" ? t("Outfit, pose, expression… (optional with a character)") : t("Describe what to paint")}
        aria-label={t("Prompt")}
        className={cn(miniInput, "h-auto resize-y py-1.5 leading-snug")}
      />
      {kind === "background" && suggested && prompt.trim() !== suggested.trim() && (
        <button type="button" onClick={() => setPrompt(suggested)} className="block text-left text-2xs text-accent-ink hover:underline">
          {brief ? t("Use the background from the brief") : t("Use the template's suggestion")}
        </button>
      )}
      <Row label={t("Takes")}>
        <Segmented size="sm" value={count} onChange={setCount} aria-label={t("Variations")} className="w-full [&>button]:flex-1"
          options={[1, 2, 3, 4].map((n) => ({ value: n, label: <span className="mono">{n}</span> }))} />
      </Row>
      {layer.pending ? (
        <div className="space-y-1.5 rounded-md border border-ai/25 bg-ai/8 p-2">
          <div className="flex items-center gap-2 text-2xs">
            <span className="eq" aria-hidden><i /><i /><i /><i /></span>
            <span className="min-w-0 flex-1 truncate text-ink">
              {waiting ? t("Waiting for a producer to approve the spend") : layer.pending.message || t("Painting {n} take(s)…", { n: ids.length || 1 })}
            </span>
            {!waiting && progress > 0 && <span className="mono text-dim">{Math.round(progress * 100)}%</span>}
          </div>
          <Progress value={progress} indeterminate={!progress} size="sm" />
        </div>
      ) : (
        <Button block size="sm" loading={busy} disabled={blocked} onClick={run} icon={<Sparkles className="size-3.5" />}
          className="border-ai/40 bg-ai/12 text-ai hover:border-ai/60 hover:bg-ai/20">
          {layer.src ? (count > 1 ? t("Regenerate {n} takes", { n: count }) : t("Regenerate")) : (count > 1 ? t("Generate {n} takes", { n: count }) : t("Generate"))}
        </Button>
      )}
      <p className="text-2xs leading-snug text-dim">{t("Runs as a job: budget limits and approvals apply. New takes appear under Other takes.")}</p>
    </PropSection>
  );
}

export function ImageProps({ layer, designId }: { layer: ImageLayer; designId: number }) {
  return (
    <>
      <FrameSection layer={layer} designId={designId} />
      {(layer.ai || !layer.src || layer.pending) && <AiSection layer={layer} designId={designId} />}
      <AdjustSection layer={layer} />
      <OutlineSection layer={layer} />
    </>
  );
}
