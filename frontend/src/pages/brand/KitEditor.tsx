import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, ChevronDown, Clapperboard, Eye, ImagePlus, Mic, Package, Palette as PaletteIcon, Save, Trash2, TriangleAlert, Type, UserRound, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import BrandPreview, { hex6 } from "../../components/growth/BrandPreview";
import { Button, Field, Input, Meter, Panel, Spinner, Textarea, Toggle } from "../../components/ui";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useProjects } from "../../lib/queries";
import type { BrandKit } from "../../lib/types";
import { ConfirmDialog } from "../admin/shared/ConfirmDialog";
import { UnsavedBar } from "../admin/shared/UnsavedBar";
import { useFlash } from "../admin/shared/useFlash";
import { useUnsavedGuard } from "../admin/shared/useUnsavedGuard";
import { ColorSwatches } from "./ColorSwatches";
import { DropZone } from "./DropZone";
import "../../styles/console.css";
import "../../styles/brand.css";

type Draft = Pick<BrandKit, "name" | "colors" | "fonts" | "tagline" | "cta" | "website" | "voice_tone" | "rules" | "end_card">;
const FIELDS = ["name", "colors", "fonts", "tagline", "cta", "website", "voice_tone", "rules", "end_card"] as const;

const FONT_SUGGESTIONS = [
  "Inter", "Poppins", "Montserrat", "Roboto", "Open Sans", "Lato", "Oswald", "Bebas Neue", "Playfair Display", "Merriweather",
  "Noto Sans", "Noto Sans Devanagari", "Noto Sans Kannada", "Noto Sans Telugu", "Noto Sans Tamil", "Mukta", "Hind", "Baloo 2",
  "Tiro Devanagari Hindi", "Nirmala UI",
];

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const LOGO_TYPES = [...IMAGE_TYPES, "image/svg+xml"];

export const toDraft = (k: BrandKit): Draft => ({
  name: k.name, colors: [...(k.colors ?? [])], fonts: { heading: "", body: "", ...(k.fonts ?? {}) }, tagline: k.tagline ?? "",
  cta: k.cta ?? "", website: k.website ?? "", voice_tone: k.voice_tone ?? "", rules: k.rules ?? "",
  end_card: { enabled: false, seconds: 3, text: "", ...(k.end_card ?? {}) },
});
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The console's left-hand list: which draft fields each section edits (for the "unsaved" dot). Logo and assets save as soon as you drop a file. */
type SectionId = "identity" | "logo" | "colours" | "type" | "voice" | "endcard" | "assets";
const SECTIONS: { id: SectionId; label: string; icon: ReactNode; fields: (typeof FIELDS)[number][] }[] = [
  { id: "identity", label: "Identity", icon: <UserRound />, fields: ["name", "website", "tagline", "cta"] },
  { id: "logo", label: "Logo", icon: <ImagePlus />, fields: [] },
  { id: "colours", label: "Colours", icon: <PaletteIcon />, fields: ["colors"] },
  { id: "type", label: "Typography", icon: <Type />, fields: ["fonts"] },
  { id: "voice", label: "Voice & tone", icon: <Mic />, fields: ["voice_tone", "rules"] },
  { id: "endcard", label: "End card", icon: <Clapperboard />, fields: ["end_card"] },
  { id: "assets", label: "Assets", icon: <Package />, fields: [] },
];

/** One section's panel: an eyebrow with the icon, an optional one-line hint, then the controls. */
function SectionPanel({ icon, label, hint, children }: { icon: ReactNode; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <Panel index={0} eyebrow={label} icon={icon} bodyClassName="space-y-4">
      {hint && <p className="max-w-2xl text-xs leading-relaxed text-mute">{hint}</p>}
      {children}
    </Panel>
  );
}

/** The kit's own logo on a dark, a light and a brand-coloured ground: does it hold up on each? */
function LogoGrounds({ logo, base }: { logo: string; base: string | null }) {
  const t = useT();
  const grounds = [
    { key: "dark", label: t("Dark"), cls: "bg-black", style: undefined },
    { key: "light", label: t("Light"), cls: "bg-white", style: undefined },
    // user data: the kit's first colour
    { key: "brand", label: t("Brand"), cls: "bg-raised", style: base ? { background: base } : undefined },
  ];
  return (
    <div>
      <p className="eyebrow mb-2">{t("On your backgrounds")}</p>
      <div className="grid grid-cols-3 gap-2">
        {grounds.map((g) => (
          <div key={g.key} className={clsx("relative grid h-16 place-items-center overflow-hidden rounded-lg border border-line", g.cls)} style={g.style}>
            <img src={logo} alt="" className="max-h-[68%] max-w-[68%] object-contain" />
            <span className="mono absolute bottom-1 left-1.5 text-2xs uppercase text-white mix-blend-difference">{g.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One brand kit as a two-pane console: a section list on the left, the section's panel in the middle and a live preview on the right. */
export function KitEditor({ kit, canEdit, canDelete, onDeleted }: { kit: BrandKit; canEdit: boolean; canDelete: boolean; onDeleted: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const uid = useId();
  const navRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SectionId>("identity");
  // on narrow screens the section list is a sideways strip: keep the selected section in view
  useEffect(() => {
    const nav = navRef.current;
    const el = nav?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!nav || !el || nav.scrollWidth <= nav.clientWidth + 2) return;
    const a = el.getBoundingClientRect(), b = nav.getBoundingClientRect();
    nav.scrollTo({ left: nav.scrollLeft + (a.left - b.left) - (b.width - a.width) / 2, behavior: "auto" });
  }, [section]);
  const [draft, setDraft] = useState<Draft>(() => toDraft(kit));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<"logo" | "product" | null>(null);
  const [productLabel, setProductLabel] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [savedFlash, flashSaved] = useFlash();
  const { data: projects } = useProjects();
  const usedBy = (projects ?? []).filter((p) => p.brand_kit_id === kit.id);
  const base = useMemo(() => toDraft(kit), [kit]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const changes = useMemo(() => {
    const out: Partial<Draft> = {};
    for (const k of FIELDS) if (!same(draft[k], base[k])) (out as Record<string, unknown>)[k] = draft[k];
    return out;
  }, [draft, base]);
  const n = Object.keys(changes).length;
  const badColor = draft.colors.some((c) => !hex6(c));
  const error = !draft.name.trim() ? t("Give the kit a name") : badColor ? t("Colours must be hex codes like #F97316") : null;

  const save = async () => {
    if (error) return void toast.error(error);
    setSaving(true);
    try {
      const body: Record<string, unknown> = { ...changes };
      if (body.colors) body.colors = draft.colors.map((c) => hex6(c) ?? c);
      if (body.name) body.name = draft.name.trim();
      const saved = await api.patch<BrandKit>(`/api/brand-kits/${kit.id}`, body);
      await qc.invalidateQueries({ queryKey: ["brand-kits"] });
      setDraft(toDraft(saved));
      flashSaved();
    } catch {
      /* toasted */
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setUploading("logo");
    try {
      await api.upload<BrandKit>(`/api/brand-kits/${kit.id}/logo`, file);
      await qc.invalidateQueries({ queryKey: ["brand-kits"] });
      toast.success(t("Logo uploaded"));
    } catch {
      /* toasted */
    } finally {
      setUploading(null);
    }
  };

  const uploadProducts = async (files: File[]) => {
    setUploading("product");
    let done = 0;
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        // a typed label applies to a single image; several dropped files are labelled by their names
        fd.append("label", (files.length === 1 ? productLabel.trim() : "") || file.name.replace(/\.[^.]+$/, "").slice(0, 60));
        await api.post<BrandKit>(`/api/brand-kits/${kit.id}/products`, fd);
        done += 1;
      }
      setProductLabel("");
    } catch {
      /* toasted */
    } finally {
      if (done) {
        await qc.invalidateQueries({ queryKey: ["brand-kits"] });
        toast.success(done === 1 ? t("Product image added") : t("{n} product images added", { n: done }));
      }
      setUploading(null);
    }
  };

  const removeProduct = async (path: string) => {
    setRemoving(path);
    try {
      await api.patch<BrandKit>(`/api/brand-kits/${kit.id}`, { product_assets: (kit.product_assets ?? []).filter((a) => a.path !== path) });
      await qc.invalidateQueries({ queryKey: ["brand-kits"] });
      toast.success(t("Product image removed"));
    } catch {
      /* toasted */
    } finally {
      setRemoving(null);
    }
  };

  const deleteKit = async () => {
    setDeleting(true);
    try {
      await api.del(`/api/brand-kits/${kit.id}`);
      await qc.invalidateQueries({ queryKey: ["brand-kits"] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(t("Brand kit deleted"));
      setConfirmDelete(false);
      onDeleted();
    } catch {
      /* toasted */
    } finally {
      setDeleting(false);
    }
  };

  useUnsavedGuard(canEdit && n > 0, () => { if (!saving && !error) void save(); });

  const ro = !canEdit;
  const ec = draft.end_card;
  const heading = draft.fonts.heading?.trim();
  const body = draft.fonts.body?.trim();
  const fam = (f?: string) => (f ? `"${f}", "Segoe UI", "Nirmala UI", system-ui, sans-serif` : undefined);
  const base0 = hex6(draft.colors[0]);

  // Per-section state for the list: a dot when its fields have unsaved edits, a warning when they are invalid.
  const dirtyIn = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.fields.some((f) => f in changes);
  const invalidIn = (id: SectionId) => (id === "identity" && !draft.name.trim()) || (id === "colours" && badColor);
  const products = kit.product_urls?.length ?? 0;
  const meta: Partial<Record<SectionId, string>> = { colours: String(draft.colors.length), assets: String(products) };
  const checks = [!!kit.logo_url, draft.colors.length >= 2, !!draft.fonts.heading?.trim(), !!draft.tagline.trim(), !!draft.voice_tone.trim(), products > 0];
  const filled = checks.filter(Boolean).length;

  const onNavKey = (e: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = SECTIONS.findIndex((s) => s.id === section);
    const next = e.key === "Home" ? 0 : e.key === "End" ? SECTIONS.length - 1
      : (i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + SECTIONS.length) % SECTIONS.length;
    setSection(SECTIONS[next].id);
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-section="${SECTIONS[next].id}"]`)?.focus());
  };

  const preview = <BrandPreview kit={{ ...draft, logo_url: kit.logo_url }} />;

  return (
    <>
      <div className="space-y-4">
        {/* console header: which kit, who uses it, and the save controls */}
        <Panel index={0}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-raised" style={{ background: base0 ?? undefined }}>
              {kit.logo_url ? <img src={kit.logo_url} alt="" className="max-h-[70%] max-w-[70%] object-contain" /> : <PaletteIcon className="size-5 text-white/70 mix-blend-difference" />}
            </span>
            <div className="min-w-0 flex-1 basis-60">
              <h2 className="truncate text-xl font-semibold tracking-tight">{draft.name || t("Untitled kit")}</h2>
              <p className="mt-0.5 text-sm text-mute">
                {usedBy.length
                  ? t("Used by {n} project(s): {list}", { n: usedBy.length, list: usedBy.slice(0, 3).map((p) => p.title).join(", ") })
                  : t("Not used by any project yet — pick it on a project's Export page.")}
              </p>
            </div>
            {canEdit && (
              <div className="flex items-center gap-2">
                {canDelete && <Button size="sm" variant="ghost" className="max-sm:h-10" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)}>{t("Delete")}</Button>}
                <Button size="sm" variant="outline" className="max-sm:h-10" icon={n ? <Save className="size-3.5" /> : <Check className="size-3.5 text-ok" />} loading={saving} disabled={!n || !!error} onClick={save}>
                  {n ? t("Save ({n})", { n }) : t("Saved")}
                </Button>
              </div>
            )}
          </div>
        </Panel>

        <div className="cx-split">
          {/* left: the section list and how complete the kit is */}
          <aside className="min-w-0">
            <div ref={navRef} role="tablist" aria-label={t("Kit sections")} className="bk-nav" onKeyDown={onNavKey}>
              {SECTIONS.map((s) => {
                const on = s.id === section, dirty = dirtyIn(s.id), bad = invalidIn(s.id);
                return (
                  <button key={s.id} type="button" role="tab" id={`${uid}-tab-${s.id}`} aria-selected={on} aria-controls={`${uid}-panel`} tabIndex={on ? 0 : -1}
                    data-section={s.id} onClick={() => setSection(s.id)}>
                    {s.icon}
                    <span className="min-w-0 flex-1 truncate">{t(s.label)}</span>
                    {bad ? <><TriangleAlert className="!size-3.5 !text-bad" aria-hidden /><span className="sr-only">{t("Needs attention")}</span></>
                      : dirty ? <><span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" /><span className="sr-only">{t("Unsaved changes")}</span></>
                      : meta[s.id] ? <span className="mono text-2xs text-dim">{meta[s.id]}</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="cx-block mt-3 hidden p-3 min-[900px]:block">
              <p className="eyebrow flex items-center justify-between gap-2"><span>{t("Completeness")}</span><span className="mono text-ink">{filled}/{checks.length}</span></p>
              <Meter className="mt-2.5" filled={filled} total={checks.length} tone={filled === checks.length ? "ok" : "accent"} />
              <p className="mt-2 text-2xs leading-snug text-dim">{t("Logo, two colours, a heading font, a tagline, a tone of voice and a product image.")}</p>
            </div>
          </aside>

          {/* middle: the section's panel; right: the live preview (docked on wide screens) */}
          <div className="@container min-w-0">
            <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_18.5rem]">
              <div className="min-w-0 space-y-4">
                {/* live preview on phones and tablets */}
                <div className="@4xl:hidden">
                  <button type="button" aria-expanded={previewOpen} onClick={() => setPreviewOpen((v) => !v)}
                    className="flex min-h-11 w-full items-center justify-between rounded-xl border border-line bg-panel px-4 py-3 text-sm font-medium transition-colors hover:border-dim/50">
                    <span className="flex items-center gap-2"><Eye className="size-4 text-mute" />{t("Live preview")}</span>
                    <ChevronDown className={clsx("size-4 text-dim transition-transform", previewOpen && "rotate-180")} />
                  </button>
                  <AnimatePresence initial={false}>
                    {previewOpen && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
                        <div className="pt-3">{preview}</div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${section}`} tabIndex={0} className="min-w-0 outline-none">
                  {section === "identity" && (
                    <SectionPanel icon={<UserRound />} label={t("Identity")}>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t("Kit name")}><Input value={draft.name} disabled={ro} onChange={(e) => set("name", e.target.value)} maxLength={160} /></Field>
                        <Field label={t("Website")}><Input value={draft.website} disabled={ro} onChange={(e) => set("website", e.target.value)} placeholder="example.com" /></Field>
                        <Field label={t("Tagline")} hint={t("Big line on the end card.")}><Input value={draft.tagline} disabled={ro} onChange={(e) => set("tagline", e.target.value)} /></Field>
                        <Field label={t("Call to action")} hint={t("e.g. Follow for part 2")}><Input value={draft.cta} disabled={ro} onChange={(e) => set("cta", e.target.value)} /></Field>
                      </div>
                    </SectionPanel>
                  )}

                  {section === "logo" && (
                    <SectionPanel icon={<ImagePlus />} label={t("Logo")} hint={t("PNG with a transparent background works best. PNG, JPG, WEBP or SVG.")}>
                      <div className="flex flex-wrap items-stretch gap-4">
                        <div className="grid h-28 w-full place-items-center overflow-hidden rounded-xl border border-line p-3 sm:w-44"
                          style={{ background: "repeating-conic-gradient(var(--color-raised) 0% 25%, var(--color-hover) 0% 50%) 0 0 / 16px 16px" }}>
                          {kit.logo_url ? <img src={kit.logo_url} alt={t("Logo")} className="max-h-full max-w-full object-contain" /> : <span className="rounded-md bg-panel/80 px-2 py-1 text-xs text-dim">{t("No logo")}</span>}
                        </div>
                        {canEdit ? (
                          <DropZone className="min-h-28 min-w-[220px] flex-1" accept={LOGO_TYPES} busy={uploading === "logo"} onFiles={uploadLogo}
                            title={kit.logo_url ? t("Drop a new logo to replace it") : t("Drop your logo here")} hint={t("or click to choose a file · up to 15 MB")} />
                        ) : null}
                      </div>
                      {kit.logo_url && <LogoGrounds logo={kit.logo_url} base={base0} />}
                    </SectionPanel>
                  )}

                  {section === "colours" && (
                    <SectionPanel icon={<PaletteIcon />} label={t("Colours")} hint={t("End cards use the first colour as the background and the second for the call to action. Click a swatch to pick a colour.")}>
                      <ColorSwatches colors={draft.colors} disabled={ro} onChange={(c) => set("colors", c)} />
                    </SectionPanel>
                  )}

                  {section === "type" && (
                    <SectionPanel icon={<Type />} label={t("Typography")} hint={t("Used by the preview and for your editors' reference. Pick fonts that support your languages' scripts.")}>
                      <datalist id="brand-fonts">{FONT_SUGGESTIONS.map((f) => <option key={f} value={f} />)}</datalist>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t("Heading font")}>
                          <Input list="brand-fonts" value={draft.fonts.heading ?? ""} disabled={ro} onChange={(e) => set("fonts", { ...draft.fonts, heading: e.target.value })}
                            style={{ fontFamily: fam(heading) }} placeholder="Poppins" />
                        </Field>
                        <Field label={t("Body / caption font")}>
                          <Input list="brand-fonts" value={draft.fonts.body ?? ""} disabled={ro} onChange={(e) => set("fonts", { ...draft.fonts, body: e.target.value })}
                            style={{ fontFamily: fam(body) }} placeholder="Inter" />
                        </Field>
                      </div>
                      <div className="cx-block p-4">
                        <p className="eyebrow mb-2">{t("Specimen")}</p>
                        <p className="text-xl font-bold leading-tight" style={{ fontFamily: fam(heading) }}>{draft.name || t("Brand name")}</p>
                        <p className="mt-1 text-sm text-mute" style={{ fontFamily: fam(body) }}>{t("Every great story starts with one brave step")} · नमस्ते · ನಮಸ್ಕಾರ</p>
                      </div>
                    </SectionPanel>
                  )}

                  {section === "voice" && (
                    <SectionPanel icon={<Mic />} label={t("Voice & guidelines")}>
                      <Field label={t("Tone of voice")} hint={t("How the brand speaks, e.g. warm, playful, never sarcastic.")}>
                        <Textarea value={draft.voice_tone} disabled={ro} onChange={(e) => set("voice_tone", e.target.value)} />
                      </Field>
                      <Field label={t("Words to use / avoid and other rules")} hint={t("One rule per line. e.g. Say “devotees”, never “customers”.")}>
                        <Textarea className="min-h-[96px]" value={draft.rules} disabled={ro} onChange={(e) => set("rules", e.target.value)} />
                      </Field>
                    </SectionPanel>
                  )}

                  {section === "endcard" && (
                    <SectionPanel icon={<Clapperboard />} label={t("End card")} hint={t("A branded closing frame added to final renders of projects using this kit.")}>
                      <Toggle checked={!!ec.enabled} disabled={ro} onChange={(v) => set("end_card", { ...ec, enabled: v })}
                        label={<span className="text-sm font-medium">{ec.enabled ? t("End card is on") : t("End card is off")}</span>} />
                      <div className={clsx("grid gap-4 transition-opacity sm:grid-cols-[auto_1fr]", !ec.enabled && "opacity-50")}>
                        <Field label={t("Seconds on screen")} hint={t("1 to 10")}>
                          <div className="relative w-28">
                            <Input type="number" min={1} max={10} step={0.5} value={ec.seconds ?? 3} disabled={ro || !ec.enabled} className="pr-7 font-mono tabular-nums"
                              onChange={(e) => set("end_card", { ...ec, seconds: Math.max(1, Math.min(10, Number(e.target.value) || 3)) })} />
                            <span aria-hidden className="mono pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-dim">s</span>
                          </div>
                        </Field>
                        <Field label={t("End card text")} hint={t("Leave blank to use the call to action.")}>
                          <Input value={ec.text ?? ""} disabled={ro || !ec.enabled} onChange={(e) => set("end_card", { ...ec, text: e.target.value })} placeholder={draft.cta} />
                        </Field>
                      </div>
                    </SectionPanel>
                  )}

                  {section === "assets" && (
                    <SectionPanel icon={<Package />} label={t("Product images")} hint={t("Packshots and product photos your team can reference in ads.")}>
                      {kit.product_urls?.length ? (
                        <ul className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
                          <AnimatePresence initial={false}>
                            {kit.product_urls.map((p, i) => (
                              <motion.li key={`${p.path}-${i}`} layout initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.88 }}
                                transition={{ duration: 0.2 }} className="group relative overflow-hidden rounded-xl border border-line bg-raised/40">
                                <a href={p.url} target="_blank" rel="noreferrer" title={p.label} className="block">
                                  <img src={p.url} alt={p.label} className="aspect-square w-full object-contain p-1.5 transition-transform duration-300 group-hover:scale-105" loading="lazy" />
                                  <p className="truncate border-t border-line bg-panel/70 px-2 py-1.5 text-2xs text-mute">{p.label || "—"}</p>
                                </a>
                                {canEdit && (
                                  <button type="button" aria-label={t("Remove image")} title={t("Remove image")} disabled={removing === p.path} onClick={() => removeProduct(p.path)}
                                    className="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-lg border border-line bg-panel/90 text-mute opacity-0 shadow-card backdrop-blur transition-opacity hover:text-bad focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-60 pointer-coarse:size-10 pointer-coarse:opacity-100">
                                    {removing === p.path ? <Spinner className="size-3" /> : <X className="size-3.5" />}
                                  </button>
                                )}
                              </motion.li>
                            ))}
                          </AnimatePresence>
                        </ul>
                      ) : (!canEdit && <p className="text-sm text-dim">{t("No product images yet.")}</p>)}
                      {canEdit && (
                        <div className="space-y-3">
                          <DropZone compact multiple accept={IMAGE_TYPES} busy={uploading === "product"} onFiles={uploadProducts}
                            title={kit.product_urls?.length ? t("Drop more product images") : t("Drop product images here")} hint={t("PNG, JPG or WEBP · several at once · up to 15 MB each")} />
                          <Field label={t("Label for the next image")} hint={t("Optional. Several images at once are labelled by their file names.")}>
                            <Input value={productLabel} onChange={(e) => setProductLabel(e.target.value)} placeholder={t("e.g. 500 ml bottle, front")} />
                          </Field>
                        </div>
                      )}
                    </SectionPanel>
                  )}
                </div>
              </div>

              <div className="hidden @4xl:block">
                <div className="sticky top-4"><Panel eyebrow={t("Live preview")} icon={<Eye />}>{preview}</Panel></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {canEdit && (
        <>
          <div className="h-20" aria-hidden />
          <UnsavedBar show={n > 0} saved={savedFlash && n === 0} saving={saving} error={error} onDiscard={() => setDraft(base)} onSave={save}
            savedLabel={t("Brand kit saved")} message={n === 1 ? t("1 unsaved change") : t("{n} unsaved changes", { n })} />
        </>
      )}

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} busy={deleting} title={t("Delete this brand kit?")}
        confirmLabel={t("Delete kit")} icon={<Trash2 className="size-4" />} onConfirm={deleteKit}>
        {usedBy.length > 0 && <p className="mb-2 font-medium text-warn">{t("{n} project(s) use this kit; they will render without an end card.", { n: usedBy.length })}</p>}
        {t("Delete the brand kit \"{name}\"? This can't be undone.", { name: kit.name })}
      </ConfirmDialog>
    </>
  );
}
