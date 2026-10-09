/** AI tab: paint backgrounds, characters (from the film's locked cast), elements and products; relight; write copy. */
import { Check, Lock, PenLine, Sparkles, SunMedium, Type, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Avatar, Badge, Button, Input, Segmented, Select, Skeleton, Textarea, Toggle } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { usd } from "../../../../lib/format";
import { tr, useT } from "../../../../lib/i18n";
import { useCharacters } from "../../../../lib/queries";
import { designsApi, harmonize, runAi } from "../../api";
import { getExporter } from "../../canvas/exporter";
import { useEditor } from "../../store";
import { templateOf } from "../../templates";
import type { ImageLayer } from "../../types";
import { placeCopy, presetForCopy } from "./actions";
import { useBrand } from "./brand";
import { outfitsOf, type CastCharacter } from "./cast";
import { uploadsOf, useLeft, type AiMode } from "./state";
import { LANG_OPTIONS } from "./TemplatesTab";
import { Chip, DragItem, Hint, Section } from "./ui";

const COST_PER_IMAGE = 0.07;

const MODES: { value: AiMode; label: string }[] = [
  { value: "background", label: "Background" }, { value: "character", label: "Character" },
  { value: "element", label: "Element" }, { value: "product", label: "Product" },
];

export const STYLES = ["Cinematic", "Neon noir", "Vintage Bollywood", "Anime", "Watercolour", "Oil painting", "3D render", "Minimal flat",
  "Comic book", "Photoreal studio"];

const POSES = ["Hero stance", "Arms crossed", "Looking over the shoulder", "Walking towards camera", "Close-up portrait", "Holding the lamp",
  "Back to back"];

const PLACEHOLDER: Record<AiMode, string> = {
  background: "A flooded temple courtyard at night, oil lamps reflected in the water, drifting mist, teal and amber",
  character: "Optional: expression, clothing details, the light on them",
  element: "A brass oil lamp with a tall flame, isolated, soft rim light",
  product: "A glass jar of mango pickle on a wooden board with chillies and curry leaves",
};

const ROLE_FOR: Record<AiMode, ImageLayer["role"] | null> = { background: "background", character: "character", product: "product", element: null };

export default function AiTab({ designId, projectId }: { designId: number; projectId: number | null }) {
  const t = useT();
  const mode = useLeft((s) => s.aiMode);
  const setMode = useLeft((s) => s.setAiMode);
  const characterId = useLeft((s) => s.aiCharacterId);
  const setCharacter = useLeft((s) => s.setAiCharacter);
  const chars = useCharacters(projectId ?? undefined);
  const cast = (chars.data ?? []) as CastCharacter[];
  const character = cast.find((c) => c.id === characterId);

  const [prompts, setPrompts] = useState<Record<AiMode, string>>({ background: "", character: "", element: "", product: "" });
  const prompt = prompts[mode];
  const [style, setStyle] = useState("");
  const [count, setCount] = useState(1);
  const [cutout, setCutout] = useState<Record<AiMode, boolean>>({ background: false, character: true, element: true, product: true });
  const [outfit, setOutfit] = useState("");
  const [pose, setPose] = useState("");
  const [poseText, setPoseText] = useState("");
  const [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // what the button will paint into: the selected image layer, else an empty frame of the right kind, else a new layer
  const want = ROLE_FOR[mode];
  const selImage = useEditor((s) => {
    if (s.selection.length !== 1) return null;
    const l = s.doc.layers.find((x) => x.id === s.selection[0]);
    return l && l.type === "image" ? l.id : null;
  });
  const slotId = useEditor((s) => {
    if (s.selection.length || !want) return null;
    return s.doc.layers.find((x) => x.type === "image" && !x.src && !x.pending && x.role === want)?.id ?? null;
  });
  const targetId = selImage ?? slotId;
  const targetName = useEditor((s) => (targetId ? s.doc.layers.find((l) => l.id === targetId)?.name ?? "" : ""));
  const tplPrompt = useEditor((s) => templateOf(s.design?.template)?.backgroundPrompt ?? "");
  const finalPrompt = prompt.trim() || (mode === "background" ? tplPrompt : "");
  const canRun = !busy && (mode === "character" ? !!character || !!prompt.trim() : !!finalPrompt);

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    try {
      const poseAll = [pose, poseText.trim()].filter(Boolean).join(", ");
      const ok = await runAi(designId, {
        kind: mode, prompt: finalPrompt, style: style || undefined, count, cutout: mode !== "background" && cutout[mode],
        layerId: targetId ?? undefined,
        name: mode === "character" && character ? `${character.name} (AI)` : undefined,
        ...(mode === "character" ? { character_id: character?.id ?? null, outfit: outfit || undefined, pose: poseAll || undefined } : {}),
        ...(mode === "product" && refs.length ? { ref_assets: refs } : {}),
      });
      if (ok) toast.success(count > 1 ? tr("Painting {n} takes…", { n: count }) : tr("Painting…"),
        { description: count > 1 ? tr("The first take fills the layer; the others wait as alternatives in the layer's properties.") : undefined });
    } finally {
      setBusy(false);
    }
  };

  const buttonLabel = selImage ? t("Fill selected") : slotId ? t("Fill “{name}”", { name: targetName }) : t("Generate");

  return (
    <>
      <Section title={t("Generate an image")} icon={<Sparkles />} tone="ai">
        <BriefBackground designId={designId} style={style} />
        <Segmented<AiMode> size="sm" aria-label={t("What to paint")} className="flex w-full [&>button]:flex-1" value={mode}
          options={MODES.map((m) => ({ value: m.value, label: t(m.label) }))} onChange={setMode} />

        {mode === "character" && (
          <div className="mt-3">
            <p className="eyebrow mb-1.5">{t("Character")}</p>
            <CharacterPicker chars={cast} loading={chars.isLoading} value={characterId} onChange={(id) => { setCharacter(id); setOutfit(""); }}
              projectId={projectId} />
            {character && (
              <p className="mt-1.5 flex items-center gap-1.5 text-2xs text-mute">
                {character.locked
                  ? <Badge tone="ok"><Lock className="size-2.5" />{t("Character Lock")}</Badge>
                  : <Badge>{t("Not locked")}</Badge>}
                <span className="truncate">{character.locked ? t("The same face in every image") : t("Lock the look in the Bible for a steady face")}</span>
              </p>
            )}
          </div>
        )}

        <Textarea
          value={prompt}
          onChange={(e) => setPrompts({ ...prompts, [mode]: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(); } }}
          rows={3}
          maxLength={2000}
          placeholder={t(mode === "background" && tplPrompt ? tplPrompt : PLACEHOLDER[mode])}
          className="mt-3 min-h-[76px] text-sm"
          aria-label={t("Describe the image")}
        />

        <p className="eyebrow mb-1.5 mt-3">{t("Style")}</p>
        <div className="flex flex-wrap gap-1">
          {STYLES.map((s) => <Chip key={s} on={style === s} onClick={() => setStyle(style === s ? "" : s)}>{t(s)}</Chip>)}
        </div>

        {mode === "character" && (
          <>
            <p className="eyebrow mb-1.5 mt-3">{t("Outfit")}</p>
            <Select value={outfit} onChange={(e) => setOutfit(e.target.value)} disabled={!character} className="h-8 text-xs">
              <option value="">{character ? t("Their usual look") : t("Pick a character first")}</option>
              {outfitsOf(character).map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
            <p className="eyebrow mb-1.5 mt-3">{t("Pose")}</p>
            <div className="flex flex-wrap gap-1">
              {POSES.map((p) => <Chip key={p} on={pose === p} onClick={() => setPose(pose === p ? "" : p)}>{t(p)}</Chip>)}
            </div>
            <Input value={poseText} onChange={(e) => setPoseText(e.target.value)} placeholder={t("Or describe the pose")} className="mt-1.5 h-8 text-xs" />
          </>
        )}

        {mode === "product" && <ProductRefs designId={designId} value={refs} onChange={setRefs} />}

        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <p className="eyebrow mb-1">{t("Takes")}</p>
            <Segmented<number> size="sm" aria-label={t("How many takes")} value={count} onChange={setCount}
              options={[1, 2, 3, 4].map((n) => ({ value: n, label: <span className="mono">{n}</span> }))} />
          </div>
          {mode !== "background" && (
            <div className="text-right">
              <p className="eyebrow mb-1">{t("Cut-out")}</p>
              <Toggle checked={cutout[mode]} onChange={(v) => setCutout({ ...cutout, [mode]: v })} label={<span className="text-xs text-mute">{t("Transparent")}</span>} />
            </div>
          )}
        </div>

        <p className="mt-3 flex items-center gap-1.5 text-2xs text-mute">
          <span className={cn("size-1.5 shrink-0 rounded-full", targetId ? "bg-accent" : "bg-dim")} />
          <span className="truncate">
            {selImage ? t("Paints into the selected layer “{name}”", { name: targetName })
              : slotId ? t("Paints into the empty frame “{name}”", { name: targetName })
              : t("Adds a new layer")}
          </span>
        </p>
        <Button variant="primary" block className="mt-2" icon={<Wand2 className="size-4" />} loading={busy} disabled={!canRun} onClick={() => void run()}>
          <span className="min-w-0 truncate">{buttonLabel}</span>
        </Button>
        <div className="mt-2 rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 text-2xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-mute">{count > 1 ? t("{n} takes", { n: count }) : t("1 take")}</span>
            <span className="mono shrink-0 text-money">~{usd(COST_PER_IMAGE * count)}</span>
          </div>
          <p className="mt-0.5 leading-snug text-dim">
            {t("About {each} per image. Charged to the budget like any generation, and may wait for a producer's approval.", { each: usd(COST_PER_IMAGE) })}
          </p>
        </div>
      </Section>

      <RelightCard designId={designId} style={style} />
      <CopyWriter projectId={projectId} />
    </>
  );
}

// ── pieces ───────────────────────────────────────────────

function CharacterPicker({ chars, loading, value, onChange, projectId }: {
  chars: CastCharacter[]; loading: boolean; value: number | null; onChange: (id: number | null) => void; projectId: number | null;
}) {
  const t = useT();
  if (loading) return <div className="grid grid-cols-4 gap-1.5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>;
  if (!chars.length) {
    return (
      <Hint>
        {t("No characters yet.")}{" "}
        {projectId ? <Link to={`/p/${projectId}/bible`} className="font-medium text-accent-ink hover:underline">{t("Add them in the Bible")}</Link>
          : t("Describe the person in the prompt instead.")}
      </Hint>
    );
  }
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {chars.map((c) => {
        const on = c.id === value;
        return (
          <button key={c.id} type="button" aria-pressed={on} onClick={() => onChange(on ? null : c.id)} title={c.role ? `${c.name} · ${c.role}` : c.name}
            className={cn("relative flex min-w-0 flex-col items-center gap-1 rounded-lg border px-1 py-1.5 transition-colors",
              on ? "border-accent/60 bg-accent/10" : "border-line bg-raised hover:bg-hover")}>
            <span className="relative">
              <Avatar name={c.name} src={c.avatar_url || undefined} size={36} />
              {c.locked && (
                <span title={t("Character Lock: the face stays the same in every image")}
                  className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full border border-line bg-panel text-ok">
                  <Lock className="size-2.5" />
                </span>
              )}
              {on && <span className="absolute -left-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-accent text-black"><Check className="size-2.5" /></span>}
            </span>
            <span className={cn("w-full truncate text-center text-2xs", on ? "text-ink" : "text-mute")}>{c.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Reference photos for a product (brand kit products and this session's uploads), sent as `ref_assets`. */
function ProductRefs({ designId, value, onChange }: { designId: number; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  const { kit } = useBrand(designId);
  const uploads = useLeft(uploadsOf(designId));
  const options = useMemo(() => {
    const out: { asset: string; url: string; label: string }[] = [];
    for (const p of kit?.product_urls ?? []) if (p.path && p.url) out.push({ asset: p.path, url: p.url, label: p.label || "Product" });
    for (const u of uploads) out.push({ asset: u.asset, url: u.src, label: u.name });
    return out.filter((o, i) => out.findIndex((x) => x.asset === o.asset) === i).slice(0, 12);
  }, [kit, uploads]);
  if (!options.length) return <Hint className="mt-3">{t("Tip: upload a photo of the product (Photos tab) to use it as a reference.")}</Hint>;
  const toggle = (a: string) => onChange(value.includes(a) ? value.filter((x) => x !== a) : value.length >= 6 ? value : [...value, a]);
  return (
    <>
      <p className="eyebrow mb-1.5 mt-3">{t("Reference photos")} <span className="mono normal-case text-dim">{value.length}/6</span></p>
      <div className="grid grid-cols-6 gap-1">
        {options.map((o) => {
          const on = value.includes(o.asset);
          return (
            <button key={o.asset} type="button" aria-pressed={on} title={o.label} onClick={() => toggle(o.asset)}
              className={cn("relative aspect-square overflow-hidden rounded-md border bg-raised", on ? "border-accent ring-1 ring-accent" : "border-line hover:border-dim/50")}>
              <img src={o.url} alt="" loading="lazy" className="size-full object-cover" />
              {on && <span className="absolute right-0.5 top-0.5 grid size-3.5 place-items-center rounded-full bg-accent text-black"><Check className="size-2.5" /></span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** One click: paint the background the AI brief described. Shown when the design has a brief. */
function BriefBackground({ designId, style }: { designId: number; style: string }) {
  const t = useT();
  const brief = useEditor((s) => s.doc.meta?.brief ?? "");
  const plan = useLeft((s) => s.briefPlan[designId]);
  const [busy, setBusy] = useState(false);
  if (!brief) return null;
  const go = async () => {
    const st = useEditor.getState();
    const bg = st.doc.layers.find((l) => l.type === "image" && (l.slot === "background" || l.role === "background"));
    setBusy(true);
    try {
      await runAi(designId, { kind: "background", layerId: bg?.id, prompt: plan?.prompt || brief, style: plan?.style || style || undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-ai/30 bg-ai/8 p-2">
      <p className="min-w-0 flex-1 truncate text-2xs text-mute" title={brief}>“{brief}”</p>
      <Button size="sm" variant="outline" loading={busy} onClick={() => void go()} className="shrink-0">{t("Background from the brief")}</Button>
    </div>
  );
}

function RelightCard({ designId, style }: { designId: number; style: string }) {
  const t = useT();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const hasImages = useEditor((s) => s.doc.layers.some((l) => l.visible && l.type === "image" && !!l.src));
  const go = async () => {
    if (!getExporter()) { toast.error(tr("The canvas isn't ready to render yet. Try again in a moment.")); return; }
    setBusy(true);
    try {
      const ok = await harmonize(designId, prompt.trim(), style);
      if (ok) toast.success(tr("Relighting the poster…"), { description: tr("Text stays untouched. The original images are hidden, not deleted, so Undo works.") });
    } catch {
      toast.error(tr("Couldn't prepare the poster for relighting."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("Relight the whole poster")} icon={<SunMedium />} tone="ai">
      <p className="text-xs leading-relaxed text-mute">
        {t("Blends the lighting and colour across every image so the cut-outs sit in the scene. Your text is left exactly as it is.")}
      </p>
      <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("Optional: warm golden hour, rain-soaked neon…")}
        className="mt-2 h-8 text-xs" maxLength={2000} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-2xs text-dim">{style ? t("Style: {s}", { s: t(style) }) : t("Uses the style chosen above")}</span>
        <Button size="sm" variant="secondary" icon={<SunMedium className="size-3.5" />} loading={busy} disabled={!hasImages} onClick={() => void go()}>
          {t("Relight")}
        </Button>
      </div>
      {!hasImages && <Hint className="mt-1.5">{t("Add or generate an image first.")}</Hint>}
    </Section>
  );
}

// ── copy ─────────────────────────────────────────────────

const COPY_KINDS = [
  { value: "title", label: "Title" }, { value: "tagline", label: "Tagline" }, { value: "cta", label: "Call to action" },
  { value: "credits", label: "Credits" }, { value: "headline", label: "Headline" }, { value: "caption", label: "Caption" },
];
const TONES = ["Dramatic", "Mysterious", "Epic", "Heartfelt", "Playful", "Urgent", "Premium", "Devotional"];

function CopyWriter({ projectId }: { projectId: number | null }) {
  const t = useT();
  const [kind, setKind] = useState("tagline");
  const [lang, setLang] = useState("en");
  const [tone, setTone] = useState("");
  const [context, setContext] = useState("");
  const [ideas, setIdeas] = useState<{ kind: string; lang: string; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const brief = useEditor((s) => s.doc.meta?.brief ?? "");
  const hasText = useEditor((s) => s.selection.some((id) => s.doc.layers.find((l) => l.id === id)?.type === "text"));

  const write = async () => {
    setBusy(true);
    try {
      const st = useEditor.getState();
      const title = st.doc.layers.find((l) => l.type === "text" && l.role === "title");
      const ctx = [context.trim(), brief, title && title.type === "text" ? `Current title: ${title.text}` : ""].filter(Boolean).join(". ");
      const r = await designsApi.aiCopy({ kind, context: ctx, project_id: projectId, language: lang, tone: tone || undefined, n: 6 });
      setIdeas(r.suggestions.map((text) => ({ kind, lang, text })));
      if (!r.suggestions.length) toast.info(tr("No ideas came back. Add a little context and try again."));
    } catch {
      /* the API already said what went wrong */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("Write copy")} icon={<PenLine />} tone="ai">
      <div className="flex flex-wrap gap-1">
        {COPY_KINDS.map((k) => <Chip key={k.value} on={kind === k.value} onClick={() => setKind(k.value)}>{t(k.label)}</Chip>)}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Segmented size="sm" aria-label={t("Language")} value={lang} options={LANG_OPTIONS} onChange={setLang} />
        <Select value={tone} onChange={(e) => setTone(e.target.value)} className="h-8 min-w-0 flex-1 text-xs" aria-label={t("Tone")}>
          <option value="">{t("Any tone")}</option>
          {TONES.map((x) => <option key={x} value={x}>{t(x)}</option>)}
        </Select>
      </div>
      <Input value={context} onChange={(e) => setContext(e.target.value)} maxLength={1000} className="mt-2 h-8 text-xs"
        placeholder={projectId ? t("Optional: anything to add to the project's story") : t("What is it about? (a line is enough)")}
        onKeyDown={(e) => { if (e.key === "Enter") void write(); }} />
      <Button size="sm" variant="secondary" block className="mt-2" icon={<Sparkles className="size-3.5" />} loading={busy} onClick={() => void write()}>
        {ideas.length ? t("Write 6 more") : t("Write 6 ideas")}
      </Button>
      {ideas.length > 0 && (
        <>
          <Hint className="mb-1.5 mt-3">{hasText ? t("Click to put it in the selected text, or drag it onto the canvas.") : t("Click to add as text, or drag it onto the canvas.")}</Hint>
          <div className="space-y-1">
            {ideas.map((it, i) => {
              const preset = presetForCopy(it.kind, it.lang);
              return (
                <DragItem key={`${i}-${it.text}`} label={it.text} payload={() => ({ kind: "text", preset, text: it.text })}
                  onAdd={() => placeCopy(it.text, preset)}
                  className="group flex items-start gap-2 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs leading-snug text-ink hover:border-ai/40 hover:bg-hover">
                  <Type className="mt-0.5 size-3.5 shrink-0 text-dim group-hover:text-ai" />
                  <span data-ghost className="min-w-0 flex-1 break-words">{it.text}</span>
                  <Badge className="shrink-0">{t(COPY_KINDS.find((k) => k.value === it.kind)?.label ?? it.kind)}</Badge>
                </DragItem>
              );
            })}
          </div>
        </>
      )}
    </Section>
  );
}
