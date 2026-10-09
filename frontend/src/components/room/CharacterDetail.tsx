import { useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Images, Lock, LockOpen, Mic, ScanFace, Shirt, ShieldAlert, ShieldCheck, Smile, SunMedium, Upload, UserRound, Wand2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import { useCharacter } from "../../lib/queries";
import type { Character, SubmitResult } from "../../lib/types";
import { generateLighting, LIGHTING_VARIANTS, SHEET_VIEWS, type CharacterV3 } from "../../lib/v3";
import { useGenerate } from "../Generate";
import { Badge, Button, Input, Select, Skeleton, Textarea } from "../ui";
import { GroupHead, IdMark, JobStrip, LangChips, LEVEL_TEXT, LockMeter, PackBar, PackStations, Portrait, Vital, packDone as countPack, packOf, voicedLanguages } from "./cast";
import { CharacterLockPanel } from "./CharacterLock";
import { Costumes } from "./Costumes";
import { BytePlusPanel } from "./BytePlusPanel";
import { ConsentPanel, IdentityBadge, IdentityPanel } from "./Identity";
import { DetailBar, FloatingSaveBar, RField, RoomEmpty, type SaveState } from "./kit";
import { Gallery, type GalleryItem } from "./Lightbox";
import { LEVEL_LABEL, LIGHT_LABEL, LIGHT_ORDER, VIEW_LABEL, VIEW_ORDER, strictnessLevel } from "./look";
import { useCharScope } from "./scope";
import { consentNeeds, useActiveJobs, useConsentRows, useSaveShortcut } from "./util";
import { Versions } from "./Versions";
import { Voices } from "./Voices";
import { IdChip, Outline, WorkPanel, Workspace, ViewSwitch, code, scrollToSection, type OutlineItem } from "./workspace";

type Asset = NonNullable<CharacterV3["assets"]>[number];
const IMAGE_JOBS = ["character_sheet", "character_outfit", "character_expressions", "character_lighting"];
const seed = (c: CharacterV3): Partial<CharacterV3> => ({
  name: c.name, role: c.role, gender: c.gender, age: c.age, dna_text: c.dna_text, personality: c.personality, voice_description: c.voice_description,
  name_pronunciation: c.name_pronunciation ?? "", performance_notes: c.performance_notes ?? "",
});

/** The big view of one character: an ID card with its vitals, then profile, lock, reference pack, outfits, versions, voices, identity and consent, with an outline that jumps to each. */
export function CharacterDetail({ cid, chars, onBack, onOpen, backLabel }: {
  cid: number; chars: Character[]; onBack: () => void; onOpen: (id: number) => void; backLabel?: string;
}) {
  const t = useT();
  const scope = useCharScope();
  const { canEdit, canProduce, projectId } = scope;
  const back = backLabel ?? t("Cast");
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const { data: raw, isLoading, isError } = useCharacter(cid);
  const c = raw as CharacterV3 | undefined;
  const { data: consents } = useConsentRows(canProduce);
  const [form, setForm] = useState<Partial<CharacterV3>>({});
  const [busy, setBusy] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const [view, setView] = useState<"refs" | "training" | "tests">("refs");
  const fileRef = useRef<HTMLInputElement>(null);
  const imageJobs = useActiveJobs(projectId, (j) => IMAGE_JOBS.includes(j.type) && Number(j.payload?.character_id) === cid);

  useEffect(() => { if (c) setForm(seed(c)); }, [c?.id, c?.version, c?.dna_text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!justSaved) return;
    const id = window.setTimeout(() => setJustSaved(false), 2200);
    return () => window.clearTimeout(id);
  }, [justSaved]);

  const dirty = !!c && Object.entries(form).some(([k, v]) => ((c as any)[k] ?? "") !== (v ?? ""));
  const editable = !!c && canEdit && (!c.locked || canProduce);
  const save = async () => {
    if (!c) return;
    setBusy("save");
    try {
      await api.patch(`/api/characters/${cid}`, form);
      qc.invalidateQueries({ queryKey: ["character", cid] });
      qc.invalidateQueries({ queryKey: ["characters"] });
      qc.invalidateQueries({ queryKey: ["character-lock", cid] }); // performance notes feed the lock's prompt sentence
      setJustSaved(true);
      toast.success(tr("Saved"));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  useSaveShortcut(dirty && editable && busy !== "save", save);

  const assets = useMemo(() => ((c?.assets ?? []) as Asset[]).filter((a) => !a.archived), [c?.assets]);
  const refsAll = assets.filter((a) => a.kind !== "identity_test" && a.kind !== "training");
  const training = assets.filter((a) => a.kind === "training");
  const tests = assets.filter((a) => a.kind === "identity_test");

  const idx = chars.findIndex((x) => x.id === cid);

  if (isError) {
    return (
      <div className="@container space-y-4">
        <DetailBar backLabel={back} onBack={onBack} />
        <RoomEmpty icon={<UserRound />} title={t("Character not found")} sub={t("It may have been removed.")} action={<Button onClick={onBack}>{t("Back")}</Button>} />
      </div>
    );
  }
  if (isLoading || !c) return <DetailSkeleton onBack={onBack} backLabel={back} />;

  const refresh = () => { qc.invalidateQueries({ queryKey: ["character", cid] }); qc.invalidateQueries({ queryKey: ["characters"] }); qc.invalidateQueries({ queryKey: ["costumes", cid] }); };
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try { await fn(); refresh(); if (ok) toast.success(ok); } catch { /* api toasts */ } finally { setBusy(""); }
  };
  const lock = () => act("lock", () => api.post(`/api/characters/${cid}/lock`, { locked: !c.locked }), c.locked ? tr("Unlocked — edits create a new version") : tr("Approved & locked"));
  const upload = (fs: File[]) => act("upload", async () => { for (const f of fs) await api.upload(`/api/characters/${cid}/upload`, f); },
    fs.length === 1 ? tr("Photo added — it's now the main look reference") : tr("{n} photos added — they're now the main look reference", { n: fs.length }));
  const assetPatch = async (aid: number, body: Record<string, any>) => {
    try { await api.patch(`/api/character-assets/${aid}`, body); refresh(); } catch { /* api toasts */ }
  };

  // ── the reference pack, grouped ──────────────────────────────────────────
  const toItem = (a: Asset, label: string, sub?: string): GalleryItem => ({ id: a.id, url: a.url, label, sub, approved: a.approved });
  const views = refsAll.filter((a) => VIEW_ORDER.includes(a.kind)).sort((a, b) => VIEW_ORDER.indexOf(a.kind) - VIEW_ORDER.indexOf(b.kind) || a.id - b.id);
  const expressions = refsAll.filter((a) => a.kind === "expression");
  const outfitAssets = refsAll.filter((a) => a.kind === "outfit");
  const outfitNames = [...new Set(outfitAssets.map((a) => a.outfit).filter(Boolean))];
  const lighting = refsAll.filter((a) => a.kind === "lighting").sort((a, b) => LIGHT_ORDER.indexOf(a.lighting ?? "") - LIGHT_ORDER.indexOf(b.lighting ?? "") || a.id - b.id);
  const others = refsAll.filter((a) => !VIEW_ORDER.includes(a.kind) && !["expression", "outfit", "lighting"].includes(a.kind));
  // skeleton tiles per group while a job runs (progress ≈ images already made / planned)
  const pendingFor = (type: string, planned: (j: (typeof imageJobs)[number]) => number) =>
    imageJobs.filter((j) => j.type === type).reduce((n, j) => n + Math.max(0, planned(j) - Math.round((j.progress || 0) * planned(j))), 0);
  const pendViews = pendingFor("character_sheet", (j) => (j.payload?.kinds as string[] | undefined)?.length ?? SHEET_VIEWS.length);
  const pendExpr = pendingFor("character_expressions", () => 5);
  const pendLight = pendingFor("character_lighting", (j) => (j.payload?.variants as string[] | undefined)?.length ?? LIGHTING_VARIANTS.length);
  const pendOutfitFor = (name: string) => pendingFor("character_outfit", (j) => (j.payload?.outfit === name ? ((j.payload?.views as string[] | undefined)?.length ?? 3) : 0));
  const newOutfitJobs = imageJobs.filter((j) => j.type === "character_outfit" && !outfitNames.includes(String(j.payload?.outfit ?? "")));
  const pendingTotal = pendViews + pendExpr + pendLight + outfitNames.reduce((n, o) => n + pendOutfitFor(o), 0) + newOutfitJobs.length;

  const groups: { key: string; title: string; hint?: string; items: GalleryItem[]; pending: number; minTile?: number }[] = view === "refs" ? [
    { key: "views", title: t("Views"), hint: t("Front, three-quarter, profile, back and full body"), pending: pendViews,
      items: views.map((a) => toItem(a, a.kind === "source" ? `★ ${a.label || t("your photo")}` : t(VIEW_LABEL[a.kind] ?? a.kind),
        a.kind === "source" ? (a.approved ? t("your photo · used first") : t("your photo · not used (unapproved)")) : undefined)) },
    { key: "expressions", title: t("Expressions"), pending: pendExpr, items: expressions.map((a) => toItem(a, a.label || t("expression"))) },
    ...outfitNames.map((o) => ({ key: `outfit-${o}`, title: t("Outfit: {name}", { name: o }), pending: pendOutfitFor(o),
      items: outfitAssets.filter((a) => a.outfit === o).map((a) => toItem(a, a.view ? t(VIEW_LABEL[a.view] ?? a.view) : a.label, o)) })),
    ...newOutfitJobs.map((j) => ({ key: `outfit-job-${j.id}`, title: t("Outfit: {name}", { name: String(j.payload?.outfit ?? "") }), pending: (j.payload?.views as string[] | undefined)?.length ?? 3, items: [] })),
    { key: "lighting", title: t("Lighting"), hint: t("The same face in day, dusk and night-interior light"), pending: pendLight,
      items: lighting.map((a) => toItem(a, t(LIGHT_LABEL[a.lighting ?? ""] ?? a.label))) },
    { key: "other", title: t("Other"), pending: 0, items: others.map((a) => toItem(a, a.label || a.kind.replace(/_/g, " "), a.outfit || undefined)) },
  ].filter((g) => g.items.length || g.pending) : [{
    key: view, title: view === "training" ? t("Training set") : t("Identity tests"), pending: 0, minTile: 6,
    items: (view === "training" ? training : tests).map((a) => toItem(a, a.label || a.kind.replace(/_/g, " "))),
  }];

  // ── pack completeness: "training in all directions" ────────────────────
  const pack = packOf(refsAll);
  const packN = countPack(pack);

  const ownPhotos = refsAll.filter((a) => a.kind === "source");
  const voices = ((c.voices ?? []) as any[]).filter((v) => typeof v === "object" && v.language);
  const voiceCount = scope.languages.filter((l) => voices.some((v) => v.language === l)).length;
  const voiced = voicedLanguages(voices);
  const needs = consentNeeds(c);
  const mineConsent = (consents ?? []).filter((r) => r.character_id === c.id && (!r.expires_on || r.expires_on >= new Date().toISOString().slice(0, 10)));
  const needKinds = [needs.photos.length ? "likeness" : "", needs.external.length ? "voice_replication" : ""].filter(Boolean);
  const consentOk = needKinds.every((k) => mineConsent.some((r) => r.character_id === c.id && r.kind === k));
  const showConsent = needs.any || (consents ?? []).some((r) => r.character_id === c.id); // the panel shows itself under the same rule
  const portrait = c.avatar_url || refsAll.find((a) => a.approved)?.url || refsAll[0]?.url;
  const idStatus = c.identity?.status ?? "none";
  const state: SaveState = busy === "save" ? "saving" : dirty ? "dirty" : justSaved ? "saved" : "clean";
  const words = (form.dna_text || "").trim().split(/\s+/).filter(Boolean).length;
  const wordTone = words < 40 || words > 110 ? "warn" : "ok";
  const facts = [c.role, c.gender && t(c.gender), c.age && t("{n} years", { n: c.age })].filter(Boolean).join(" · ");
  const strictness = c.lock_effective?.strictness ?? c.lock?.strictness;
  const strictKnown = typeof strictness === "number";
  const strictLevel = strictnessLevel(strictness);
  const costumeCount = c.costumes?.length ?? 0;
  const versionCount = c.versions?.length ?? 0;

  // ── the outline: one anchor per section, with a tick once that part of the file is in good shape ──
  const outline: OutlineItem[] = [
    { id: "sec-profile", label: t("Profile"), state: words === 0 ? "todo" : wordTone === "ok" ? "done" : "warn", meta: words ? words : undefined },
    { id: "sec-lock", label: t("Lock"), state: strictKnown && strictLevel !== "lenient" ? "done" : "todo", meta: strictKnown ? strictLevel.slice(0, 3).toUpperCase() : undefined },
    { id: "sec-sheet", label: t("Reference pack"), state: packN === pack.length ? "done" : refsAll.length ? "warn" : "todo", meta: `${packN}/${pack.length}` },
    { id: "sec-costumes", label: t("Outfits"), state: costumeCount > 0 ? "done" : "todo", meta: costumeCount || undefined },
    { id: "sec-versions", label: t("Versions"), state: "none", meta: versionCount || undefined },
    { id: "sec-voices", label: t("Voice"), state: scope.languages.length && voiceCount === scope.languages.length ? "done" : voiceCount ? "warn" : "todo", meta: `${voiceCount}/${scope.languages.length}` },
    { id: "sec-identity", label: t("Identity"), state: idStatus === "ready" ? "done" : idStatus === "failed" ? "warn" : idStatus === "training" || idStatus === "preparing" ? "none" : "todo",
      meta: idStatus === "training" || idStatus === "preparing" ? "RUN" : undefined },
    { id: "sec-byteplus", label: t("Seedance"), state: c.provider_assets?.byteplus?.status === "ready" ? "done" : "none" },
    ...(showConsent ? [{ id: "sec-consent", label: t("Consent"), state: (consentOk ? "done" : "warn") as OutlineItem["state"] }] : []),
  ];
  const outlineDone = outline.filter((i) => i.state === "done").length;
  const outlineTotal = outline.filter((i) => i.state && i.state !== "none").length;

  return (
    <div className="@container space-y-4">
      <DetailBar backLabel={back} onBack={onBack} name={c.name}
        pos={idx >= 0 && chars.length > 1 ? { index: idx, total: chars.length, prevLabel: t("Previous character"), nextLabel: t("Next character"),
          onPrev: () => onOpen(chars[(idx - 1 + chars.length) % chars.length].id), onNext: () => onOpen(chars[(idx + 1) % chars.length].id) } : undefined} />

      {/* the ID card: portrait, who they are, and the vitals of the file (each one jumps to its section) */}
      <section aria-label={c.name} className="hud relative rounded-xl border border-line bg-panel">
        <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-70" />
        <div className="flex flex-wrap items-start gap-4 p-4 @2xl:gap-5 @2xl:p-5">
          <Portrait src={portrait} name={c.name} alt={c.name} avatar={56} className="w-24 shrink-0 @2xl:w-32" />
          <div className="min-w-0 flex-1 basis-48">
            <p className="eyebrow flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <UserRound aria-hidden className="size-3.5" />{t("Character file")}
              <IdChip tone="accent">{code("CH", c.id)}</IdChip>
              <IdChip>v{c.version}</IdChip>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 max-w-full truncate text-xl font-semibold tracking-tight" title={c.name}>{c.name}</h1>
              {c.locked ? <Badge tone="warn"><Lock className="size-3" />{t("Locked")}</Badge> : <Badge><LockOpen className="size-3" />{t("Unlocked")}</Badge>}
              <IdentityBadge identity={c.identity} />
            </div>
            {facts && <p className="mt-1.5 text-sm text-mute">{facts}</p>}
            {c.personality && <p className="mt-1.5 line-clamp-2 text-sm text-dim">{c.personality}</p>}
          </div>
          {canProduce && (
            <div className="shrink-0">
              <Button variant={c.locked ? "outline" : "secondary"} loading={busy === "lock"} onClick={lock} icon={c.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}>
                {c.locked ? t("Unlock (new version)") : t("Approve & lock")}
              </Button>
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-b-xl">
          <ul aria-label={t("Jump to a section")} className="-ml-px -mt-px flex flex-wrap">
            <li className="min-w-0 flex-1 basis-36 border-l border-t border-line">
              <Vital label={t("Lock")} onClick={() => scrollToSection("sec-lock")} title={t("Lock: {level}", { level: t(LEVEL_LABEL[strictLevel]) })}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("mono text-sm font-medium", strictKnown ? LEVEL_TEXT[strictLevel] : "text-dim")}>{strictKnown ? t(LEVEL_LABEL[strictLevel]) : "—"}</span>
                  {strictKnown && <span className="mono text-2xs text-dim">{strictness.toFixed(2)}</span>}
                </span>
                <LockMeter strictness={strictness} />
              </Vital>
            </li>
            <li className="min-w-0 flex-1 basis-36 border-l border-t border-line">
              <Vital label={t("Pack")} onClick={() => scrollToSection("sec-sheet")}
                title={refsAll.length ? `${t("{n} reference images", { n: refsAll.length })} · ${t("pack {a}/{n}", { a: packN, n: pack.length })}` : t("No reference images")}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="mono text-sm font-medium">{packN}<span className="text-dim">/{pack.length}</span></span>
                  <span className="mono text-2xs text-dim">{refsAll.length} {t("img")}</span>
                </span>
                <PackBar pack={pack} />
              </Vital>
            </li>
            <li className="min-w-0 flex-1 basis-36 border-l border-t border-line">
              <Vital label={t("Voices")} onClick={() => scrollToSection("sec-voices")} title={t("{a}/{n} voices", { a: voiceCount, n: scope.languages.length })}>
                <span className="mono text-sm font-medium">{voiceCount}<span className="text-dim">/{scope.languages.length}</span></span>
                <LangChips languages={scope.languages} voiced={voiced} />
              </Vital>
            </li>
            <li className="min-w-0 flex-1 basis-36 border-l border-t border-line">
              <Vital label={t("Outfits")} onClick={() => scrollToSection("sec-costumes")} title={costumeCount ? t("{n} outfit(s)", { n: costumeCount }) : t("No outfits")}>
                <span className="flex items-center gap-1.5 text-sm font-medium"><Shirt aria-hidden className="size-3.5 text-dim" /><span className="mono">{costumeCount}</span></span>
              </Vital>
            </li>
            <li className="min-w-0 flex-1 basis-36 border-l border-t border-line">
              <Vital label={t("Identity")} onClick={() => scrollToSection("sec-identity")}>
                <IdMark status={idStatus} />
              </Vital>
            </li>
            {needs.any && (
              <li className="min-w-0 flex-1 basis-36 border-l border-t border-line">
                <Vital label={t("Consent")} onClick={() => scrollToSection("sec-consent")}>
                  <span className={cn("inline-flex items-center gap-1 text-xs font-medium [&>svg]:size-3.5", consentOk ? "text-green-300" : "text-amber-300")}>
                    {consentOk ? <ShieldCheck aria-hidden /> : <ShieldAlert aria-hidden />}{consentOk ? t("Consent on file") : t("Consent needed")}
                  </span>
                </Vital>
              </li>
            )}
          </ul>
        </div>

        {c.locked && (
          <div className="flex items-start gap-2.5 rounded-b-xl border-t border-warn/25 bg-warn/6 px-4 py-2.5 text-xs text-amber-300 @2xl:px-5">
            <Lock className="mt-px size-3.5 shrink-0" />
            <p>{canProduce ? t("Locked and approved. Unlock it to make changes — edits then create a new version.") : t("Locked and approved by a producer. Ask a producer to unlock it before editing.")}</p>
          </div>
        )}
      </section>

      <Workspace rail={<Outline title={t("Character file")} summary={`${outlineDone}/${outlineTotal}`} items={outline} />}>
        {/* profile */}
        <WorkPanel id="sec-profile" n={1} kicker={t("Dossier")} icon={<UserRound />} title={t("Profile")} description={t("Who they are, and the exact look the image models should reproduce.")}>
          <div className="space-y-4">
            <div className="grid gap-4 @lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_6rem]">
              <RField label={t("Name")} htmlFor="ch-name"><Input id="ch-name" value={form.name || ""} disabled={!editable} onChange={(e) => setForm({ ...form, name: e.target.value })} /></RField>
              <RField label={t("Role")} htmlFor="ch-role"><Input id="ch-role" value={form.role || ""} disabled={!editable} onChange={(e) => setForm({ ...form, role: e.target.value })} /></RField>
              <RField label={t("Gender")} htmlFor="ch-gender">
                <Select id="ch-gender" value={form.gender || ""} disabled={!editable} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                  <option value="">—</option><option value="male">{t("male")}</option><option value="female">{t("female")}</option><option value="neutral">{t("neutral")}</option>
                </Select>
              </RField>
              <RField label={t("Age")} htmlFor="ch-age"><Input id="ch-age" className="mono" value={form.age || ""} disabled={!editable} onChange={(e) => setForm({ ...form, age: e.target.value })} /></RField>
            </div>
            <RField label={t("Character DNA — pasted word-for-word into every prompt")} htmlFor="ch-dna"
              right={<span className={cn("mono text-2xs", wordTone === "ok" ? "text-green-300" : "text-amber-300")}>{words} / 60–80</span>}
              hint={<span className={cn(wordTone === "ok" ? "text-green-300" : "text-amber-300")}>{t("{n} words · aim for 60–80: face, skin, hair, eyes, build, signature outfit, marks. Looks only.", { n: words })}</span>}>
              <Textarea id="ch-dna" rows={4} value={form.dna_text || ""} disabled={!editable} onChange={(e) => setForm({ ...form, dna_text: e.target.value })} />
              <DnaGauge words={words} ok={wordTone === "ok"} />
            </RField>
            <div className="grid gap-4 @lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,12rem)]">
              <RField label={t("Personality (for the writer)")} htmlFor="ch-pers"><Input id="ch-pers" value={form.personality || ""} disabled={!editable} onChange={(e) => setForm({ ...form, personality: e.target.value })} /></RField>
              <RField label={t("Voice description")} htmlFor="ch-vd"><Input id="ch-vd" value={form.voice_description || ""} disabled={!editable} onChange={(e) => setForm({ ...form, voice_description: e.target.value })} /></RField>
              <RField label={t("Name pronunciation")} htmlFor="ch-pron" hint={t("how voices say the name, e.g. RAH-vee")}>
                <Input id="ch-pron" value={form.name_pronunciation || ""} disabled={!editable} placeholder={t("RAH-vee")} onChange={(e) => setForm({ ...form, name_pronunciation: e.target.value })} />
              </RField>
            </div>
            <RField label={t("Performance notes")} htmlFor="ch-perf" hint={t("Gestures, posture, speaking style — added to every prompt as 'performance: …'")}>
              <Textarea id="ch-perf" rows={2} value={form.performance_notes || ""} disabled={!editable} placeholder={t("Speaks slowly, hands folded; a half-smile before every reply")}
                onChange={(e) => setForm({ ...form, performance_notes: e.target.value })} />
            </RField>
          </div>
        </WorkPanel>

        <CharacterLockPanel character={c} editable={editable} n={2} />

        {/* reference pack */}
        <WorkPanel id="sec-sheet" n={3} kicker={t("References")} icon={<Images />} title={t("Reference pack")} description={t("Approved images become Veo references. Click an image to view it large.")}
          badge={refsAll.length > 0 ? <span className="mono rounded bg-raised px-1.5 text-2xs font-medium text-dim">{refsAll.length}</span> : undefined}
          actions={canEdit && (
            <>
              <Button size="sm" variant={ownPhotos.length ? "secondary" : "primary"} icon={<Wand2 className="size-3.5" />} className="max-sm:h-10"
                onClick={() => submit(() => api.post<SubmitResult>(`/api/characters/${cid}/sheet`, { project_id: projectId ?? null }), tr("Sheet for {name}", { name: c.name }))}>
                {ownPhotos.length ? t("Generate angles from photo") : t("Generate sheet")}
              </Button>
              <Button size="sm" icon={<Smile className="size-3.5" />} className="max-sm:h-10"
                onClick={() => submit(() => api.post<SubmitResult>(`/api/characters/${cid}/expressions`, { project_id: projectId ?? null }), tr("Expressions"))}>{t("Expressions")}</Button>
              <Button size="sm" icon={<SunMedium className="size-3.5" />} className="max-sm:h-10"
                onClick={() => submit(() => generateLighting(cid, projectId ?? null) as Promise<SubmitResult>, tr("Lighting variants for {name}", { name: c.name }))}>{t("Lighting variants")}</Button>
            </>
          )}>
          <div className="space-y-4">
            {/* the user's own photos: always the first look reference */}
            {editable && (
              <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border p-3", ownPhotos.length ? "border-ok/30 bg-ok/5" : "border-accent/40 bg-accent/5")}>
                <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg border", ownPhotos.length ? "border-ok/30 bg-ok/15 text-ok" : "border-accent/30 bg-accent/15 text-accent-ink")}><ImagePlus className="size-4" /></span>
                <div className="min-w-0 flex-1 basis-60">
                  <p className="text-sm font-medium">{ownPhotos.length ? t("Your photos ({n}) set the look", { n: ownPhotos.length }) : t("Use your own photos")}</p>
                  <p className="text-xs text-mute">{t("Upload clear photos of the face (front, side) and full body. Your approved photos are used first for every keyframe and video; generated angles and outfits are made from them.")}</p>
                </div>
                <Button size="sm" variant={ownPhotos.length ? "secondary" : "primary"} loading={busy === "upload"} icon={<Upload className="size-3.5" />} className="max-sm:h-10"
                  onClick={() => fileRef.current?.click()}>{ownPhotos.length ? t("Add more photos") : t("Upload photos")}</Button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden multiple
                  onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) upload(fs.slice(0, 8)); }} />
              </div>
            )}

            {/* pack completeness: seven stations of the look */}
            <div className="rounded-lg border border-line bg-bg/40 p-3.5">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="eyebrow">{t("Pack completeness")}</p>
                <span className={cn("mono text-xs font-medium", packN === pack.length ? "text-green-300" : "text-mute")}>{t("{a}/{n} approved", { a: packN, n: pack.length })}</span>
              </div>
              <PackStations pack={pack} />
              <p className="mt-3 text-2xs leading-snug text-dim">{t("Green = approved · amber = generated but not approved yet · dashed = not made yet. Approve one good image per view.")}</p>
            </div>

            {imageJobs.length > 0 && (
              <JobStrip label={imageJobs[0].message || imageJobs[0].label} progress={imageJobs[0].progress || 0}
                right={imageJobs.length > 1 ? t("{n} jobs", { n: imageJobs.length }) : `${Math.round((imageJobs[0].progress || 0) * 100)}%`} />
            )}
            {!assets.length && !pendingTotal ? (
              <RoomEmpty icon={<ImagePlus />} title={t("No reference images")} sub={t("Generate a sheet (front, ¾, profile, back, full body) or upload a photo. Approved images become Veo references.")} />
            ) : (
              <div className="space-y-5">
                {(training.length > 0 || tests.length > 0) && (
                  <ViewSwitch<"refs" | "training" | "tests"> size="sm" value={view} onChange={setView} label={t("Image set")}
                    items={[
                      { value: "refs", label: t("References"), count: refsAll.length },
                      ...(training.length ? [{ value: "training" as const, label: t("Training set"), count: training.length }] : []),
                      ...(tests.length ? [{ value: "tests" as const, label: t("Identity tests"), count: tests.length }] : []),
                    ]} />
                )}
                {groups.length ? groups.map((g) => (
                  <section key={g.key} aria-label={g.title}>
                    <GroupHead title={g.title} count={`${g.items.length}${g.pending ? ` + ${g.pending}` : ""}`} hint={g.hint} />
                    <Gallery items={g.items} canEdit={editable} aspect="3 / 4" minTile={g.minTile ?? 8} pending={g.pending}
                      onApprove={view === "refs" ? (it) => assetPatch(it.id, { approved: !it.approved }) : undefined}
                      onRemove={(it) => assetPatch(it.id, { archived: true })} />
                  </section>
                )) : <p className="py-6 text-center text-sm text-dim">{t("Nothing here yet.")}</p>}
              </div>
            )}
          </div>
        </WorkPanel>

        <Costumes character={c} editable={editable} n={4} />
        <Versions character={c} editable={editable} n={5} />
        <Voices character={c} n={6} />
        <IdentityPanel character={c} n={7} />
        <BytePlusPanel character={c} n={8} />
        <ConsentPanel character={c} n={9} />
      </Workspace>

      <FloatingSaveBar show={editable && (dirty || busy === "save")} state={state} saving={busy === "save"} onSave={save} onDiscard={() => setForm(seed(c))} />
    </div>
  );
}

/** Word-count gauge of the DNA field: a track with the 60–80 sweet spot marked, the fill turns amber outside 40–110. */
function DnaGauge({ words, ok }: { words: number; ok: boolean }) {
  const at = (w: number) => `${(w / 110) * 100}%`;
  return (
    <div aria-hidden className="mt-2">
      <div className="cs-gauge-ticks relative h-2 overflow-hidden rounded-[3px] border border-line bg-bg/40">
        <span className="absolute inset-y-0 bg-ok/25" style={{ left: at(60), width: at(20) }} />
        <motion.span className={cn("absolute inset-y-0 left-0", ok ? "bg-ok" : "bg-warn")} animate={{ width: `${Math.min(100, (words / 110) * 100)}%` }}
          transition={{ type: "spring", stiffness: 200, damping: 28 }} />
      </div>
      <div className="mono relative mt-1 h-3 text-2xs leading-3 text-dim">
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2" style={{ left: at(60) }}>60</span>
        <span className="absolute -translate-x-1/2" style={{ left: at(80) }}>80</span>
        <span className="absolute right-0">110</span>
      </div>
    </div>
  );
}

function DetailSkeleton({ onBack, backLabel }: { onBack: () => void; backLabel: string }) {
  return (
    <div className="@container space-y-4" aria-busy="true">
      <DetailBar backLabel={backLabel} onBack={onBack} />
      <div className="rounded-xl border border-line bg-panel">
        <div className="flex gap-4 p-4 @2xl:gap-5 @2xl:p-5">
          <Skeleton className="aspect-[3/4] w-24 shrink-0 !rounded-lg @2xl:w-32" />
          <div className="min-w-0 flex-1 space-y-3"><Skeleton className="h-3 w-40" /><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-64 max-w-full" /><Skeleton className="h-4 w-40" /></div>
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-line bg-line @2xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => <div key={i} className="space-y-2 bg-panel p-3"><Skeleton className="h-3 w-12" /><Skeleton className="h-4 w-16" /></div>)}
        </div>
      </div>
      <div className="space-y-3 rounded-xl border border-line bg-panel p-5"><Skeleton className="h-4 w-32" /><Skeleton className="h-9" /><Skeleton className="h-24" /></div>
    </div>
  );
}
