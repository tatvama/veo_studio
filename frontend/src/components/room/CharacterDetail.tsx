import { useQueryClient } from "@tanstack/react-query";
import {
  Archive, ArchiveRestore, Ellipsis, Lock, LockOpen, Mic, Shirt, ShieldCheck, SlidersHorizontal, Smile, SunMedium, Upload, UserRound, Wand2,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { quote, useQuote, type QuoteAction } from "../../lib/estimates";
import { tr, useT } from "../../lib/i18n";
import { useCharacter } from "../../lib/queries";
import type { Character, SubmitResult } from "../../lib/types";
import { generateLighting, LIGHTING_VARIANTS, SHEET_VIEWS, type CharacterV3 } from "../../lib/v3";
import { ConfirmDialog } from "../../pages/admin/shared/ConfirmDialog";
import { useGenerate } from "../Generate";
import { PriceSuffix } from "../kit/Price";
import { Badge, Button, Input, Menu, Select, Skeleton, Textarea } from "../ui";
import { AiMadeCheck, UploadAttestations, uploadCharacterImage, uploadLabel } from "./AiMade";
import { GroupHead, JobStrip, LEVEL_TEXT, voicedLanguages } from "./cast";
import { CharacterLockPanel } from "./CharacterLock";
import { Costumes } from "./Costumes";
import { BytePlusPanel } from "./BytePlusPanel";
import { BoardSplitCard, OneCallBoardButton } from "./CharacterBoard";
import { ConsentPanel, IdentityBadge, IdentityPanel } from "./Identity";
import { DetailBar, FloatingSaveBar, RField, RoomEmpty, type SaveState } from "./kit";
import { Gallery, type GalleryItem } from "./Lightbox";
import { LEVEL_LABEL, LIGHT_LABEL, LIGHT_ORDER, VIEW_LABEL, strictnessLevel } from "./look";
import { PictureGrid, type PictureSlot } from "./Pictures";
import { RedoShotsBanner, refreshImpact } from "./redo";
import { useCharScope } from "./scope";
import { SeedanceBadge } from "./SeedanceBadge";
import { SideSection } from "./SidePanel";
import { useActiveJobs, useSaveShortcut } from "./util";
import { SheetEnginePicker } from "./SheetEngine";
import { Versions } from "./Versions";
import { VoiceQuick } from "./VoiceQuick";

type Asset = NonNullable<CharacterV3["assets"]>[number];
type Job = ReturnType<typeof useActiveJobs>[number];
const IMAGE_JOBS = ["character_sheet", "character_outfit", "character_expressions", "character_lighting", "sheet_board"];
const seed = (c: CharacterV3): Partial<CharacterV3> => ({
  name: c.name, role: c.role, gender: c.gender, age: c.age, dna_text: c.dna_text, personality: c.personality, voice_description: c.voice_description,
  name_pronunciation: c.name_pronunciation ?? "", performance_notes: c.performance_notes ?? "",
});
/** Images still to come from running jobs (progress ≈ images already made / planned). */
const pendingOf = (jobs: Job[], type: string, planned: (j: Job) => number) =>
  jobs.filter((j) => j.type === type).reduce((n, j) => n + Math.max(0, planned(j) - Math.round((j.progress || 0) * planned(j))), 0);

/**
 * One character, faces first. The centre shows the big reference pictures with Approve / Redo on each and "Make pictures"
 * with its price; when the look changed after shots were made, "Redo these shots" with its price. The details panel on the
 * right holds the voice (play the sample, design one), the look lock, outfits, who they are, and everything else under
 * Advanced (expressions, lighting, boards, identity training, Seedance, consent, versions).
 *
 * `columns`: the parent gives it a fixed height and the centre and the panel scroll on their own (the Cast workspace).
 * Otherwise it flows in the page: two columns once there is room, the panel under the pictures before that.
 */
export function CharacterDetail({ cid, chars, onBack, onOpen, backLabel, columns = false, showBack = true }: {
  cid: number; chars: Character[]; onBack: () => void; onOpen: (id: number) => void; backLabel?: string; columns?: boolean; showBack?: boolean;
}) {
  const t = useT();
  const scope = useCharScope();
  const { canEdit, canProduce, projectId } = scope;
  const back = backLabel ?? t("Cast");
  const qc = useQueryClient();
  const { priced } = useGenerate();
  const { data: raw, isLoading, isError } = useCharacter(cid);
  const c = raw as CharacterV3 | undefined;
  const [form, setForm] = useState<Partial<CharacterV3>>({});
  const [busy, setBusy] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const [aiMade, setAiMade] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageJobs = useActiveJobs(projectId, (j) => IMAGE_JOBS.includes(j.type) && Number(j.payload?.character_id) === cid);
  // prices on the buttons (the cost dialog shows them again before anything runs)
  const sheetEst = useQuote(canEdit ? { action: "sheet", character_id: cid, project_id: projectId ?? null } : null, [c?.sheet_engine]);
  const viewEst = useQuote(canEdit ? { action: "sheet", character_id: cid, project_id: projectId ?? null, kinds: ["front"] } : null, [c?.sheet_engine]);

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
  // an uploaded character board is listed under "Split a character board", not among the references
  const refsAll = assets.filter((a) => a.kind !== "identity_test" && a.kind !== "training" && a.origin !== "board");

  if (isError) {
    return (
      <div className={cn("@container space-y-4", columns && "h-full overflow-y-auto p-5")}>
        {showBack && <DetailBar backLabel={back} onBack={onBack} />}
        <RoomEmpty icon={<UserRound />} title={t("Character not found")} sub={t("It may have been removed.")} action={<Button onClick={onBack}>{t("Back")}</Button>} />
      </div>
    );
  }
  if (isLoading || !c) return <DetailSkeleton onBack={onBack} backLabel={back} columns={columns} showBack={showBack} />;

  const idx = chars.findIndex((x) => x.id === cid);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["character", cid] });
    qc.invalidateQueries({ queryKey: ["characters"] });
    qc.invalidateQueries({ queryKey: ["costumes", cid] });
    refreshImpact(qc); // approving or removing a picture can put shots out of date
  };
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try { await fn(); refresh(); if (ok) toast.success(ok); } catch { /* api toasts */ } finally { setBusy(""); }
  };
  /** A reference-pack job with its price first (it runs on the engine picked for this character). */
  const packJob = (action: QuoteAction, run: () => Promise<SubmitResult>, what: string, extra: Record<string, unknown> = {}) =>
    void priced({ quote: () => quote({ action, character_id: cid, project_id: projectId ?? null, ...extra }), run, what });
  const makeSheet = (kinds?: string[]) => packJob("sheet",
    () => api.post<SubmitResult>(`/api/characters/${cid}/sheet`, { project_id: projectId ?? null, ...(kinds ? { kinds } : {}) }),
    kinds?.length === 1 ? tr("{view} of {name}", { view: tr(VIEW_LABEL[kinds[0]] ?? kinds[0]), name: c.name }) : tr("Pictures of {name}", { name: c.name }),
    kinds ? { kinds } : {});
  const lock = () => act("lock", () => api.post(`/api/characters/${cid}/lock`, { locked: !c.locked }), c.locked ? tr("Unlocked — edits create a new version") : tr("Approved & locked"));
  const upload = (fs: File[]) => act("upload", async () => { for (const f of fs) await uploadCharacterImage(cid, f, aiMade); setAiMade(false); },
    fs.length === 1 ? tr("Image added — it's now the main look reference") : tr("{n} images added — they're now the main look reference", { n: fs.length }));
  const archive = async (to: boolean) => {
    setBusy("archive");
    try {
      const r = await api.patch<Character & { byteplus_removal?: { removed: number; error: string } }>(`/api/characters/${cid}`, { archived: to });
      refresh();
      setArchiving(false);
      if (!to) toast.success(tr("{name} is back in the library", { name: c.name }));
      else if (r.byteplus_removal?.error) {
        // stay here: the Seedance part of Advanced shows the error, and Remove from BytePlus tries again
        toast.error(tr("{name} archived, but removing it from BytePlus failed: {error}. Press Remove from BytePlus to try again.",
          { name: c.name, error: r.byteplus_removal.error }), { duration: 12000 });
      } else {
        toast.success(r.byteplus_removal ? tr("{name} archived and removed from BytePlus", { name: c.name }) : tr("{name} archived", { name: c.name }), {
          duration: 8000, action: { label: tr("Undo"), onClick: () => void api.patch(`/api/characters/${cid}`, { archived: false }).then(refresh).catch(() => undefined) },
        });
        onBack();
      }
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  const assetPatch = async (aid: number, body: Record<string, any>) => {
    try { await api.patch(`/api/character-assets/${aid}`, body); refresh(); } catch { /* api toasts */ }
  };

  // ── the big pictures: your photos first, then the five views (a dashed frame for a view not made yet) ──
  const fromBoard = (a: Asset) => ((a as { origin?: string }).origin ?? "").startsWith("board:") ? t("from your board") : undefined;
  const sources = refsAll.filter((a) => a.kind === "source").sort((a, b) => a.id - b.id);
  const pendViews = pendingOf(imageJobs, "character_sheet", (j) => (j.payload?.kinds as string[] | undefined)?.length ?? SHEET_VIEWS.length)
    + pendingOf(imageJobs, "sheet_board", (j) => (j.payload?.panels as string[] | undefined)?.length ?? 10);
  const viewSlots: PictureSlot[] = [];
  for (const a of sources) {
    viewSlots.push({ key: `src-${a.id}`, label: `★ ${uploadLabel(a)}`, asset: a,
      sub: a.ai_made ? (a.approved ? t("AI-made · used first") : t("AI-made · not used until approved")) : (a.approved ? t("your photo · used first") : t("your photo · not used until approved")) });
  }
  let toCome = pendViews;
  for (const k of SHEET_VIEWS) {
    const all = refsAll.filter((a) => a.kind === k);
    const best = all.find((a) => a.approved) ?? [...all].sort((a, b) => b.id - a.id)[0];
    const alts = all.filter((a) => a !== best).sort((a, b) => b.id - a.id);
    const pending = toCome > 0 && !best;
    if (pending) toCome -= 1;
    viewSlots.push({ key: `view-${k}`, label: t(VIEW_LABEL[k] ?? k), asset: best, sub: best ? fromBoard(best) : undefined, redo: true, pending });
    for (const o of alts) viewSlots.push({ key: `alt-${o.id}`, label: t(VIEW_LABEL[k] ?? k), sub: fromBoard(o) ?? t("another take"), asset: o, redo: false });
  }
  for (let i = 0; i < toCome; i++) viewSlots.push({ key: `pending-${i}`, label: t("Being made…"), pending: true });
  const viewsApproved = SHEET_VIEWS.filter((k) => refsAll.some((a) => a.kind === k && a.approved)).length + (sources.some((a) => a.approved) ? 1 : 0);
  const viewsMade = SHEET_VIEWS.filter((k) => refsAll.some((a) => a.kind === k)).length;
  // faces from keyframes the user picked or approved (newest first), and anything else
  const toItem = (a: Asset, label: string, sub?: string): GalleryItem => ({ id: a.id, url: a.url, label, sub, approved: a.approved });
  const stills = refsAll.filter((a) => a.kind === "approved_still").sort((a, b) => b.id - a.id);
  const known = new Set<string>(["source", ...SHEET_VIEWS, "expression", "outfit", "lighting", "approved_still"]);
  const others = refsAll.filter((a) => !known.has(a.kind));

  // ── the details panel's summaries ──
  const voiced = voicedLanguages(c.voices);
  const voiceN = scope.languages.filter((l) => voiced.has(l)).length;
  const strictness = c.lock_effective?.strictness ?? c.lock?.strictness;
  const strictLevel = strictnessLevel(strictness);
  const costumeCount = c.costumes?.length ?? 0;
  const state: SaveState = busy === "save" ? "saving" : dirty ? "dirty" : justSaved ? "saved" : "clean";
  const words = (form.dna_text || "").trim().split(/\s+/).filter(Boolean).length;
  const wordTone = words < 40 || words > 110 ? "warn" : "ok";
  const facts = [c.role, c.gender && t(c.gender), c.age && t("{n} years", { n: c.age })].filter(Boolean).join(" · ");

  const centre = (
    <div className="space-y-4">
      {showBack && (
        <DetailBar backLabel={back} onBack={onBack} name={c.name}
          pos={idx >= 0 && chars.length > 1 ? { index: idx, total: chars.length, prevLabel: t("Previous character"), nextLabel: t("Next character"),
            onPrev: () => onOpen(chars[(idx - 1 + chars.length) % chars.length].id), onNext: () => onOpen(chars[(idx + 1) % chars.length].id) } : undefined} />
      )}

      {/* who: the name, the facts, the lock */}
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 max-w-full truncate text-xl font-semibold tracking-tight" title={c.name}>{c.name}</h1>
            {c.locked ? <Badge tone="warn"><Lock className="size-3" />{t("Locked")}</Badge> : <Badge><LockOpen className="size-3" />{t("Unlocked")}</Badge>}
            <IdentityBadge identity={c.identity} />
            {c.seedance_ready && <SeedanceBadge />}
          </div>
          {facts && <p className="mt-1 text-sm text-mute">{facts}</p>}
        </div>
        {(canProduce || (editable && !c.archived)) && (
          <div className="flex shrink-0 items-center gap-1.5">
            {canProduce && (
              <Button variant={c.locked ? "outline" : "secondary"} loading={busy === "lock"} onClick={lock} className="max-sm:h-10"
                icon={c.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}>
                {c.locked ? t("Unlock (new version)") : t("Approve & lock")}
              </Button>
            )}
            {editable && !c.archived && (
              <Menu placement="bottom-end" width={200} items={[{ label: t("Archive {name}", { name: c.name }), icon: <Archive className="size-4" />, onClick: () => setArchiving(true) }]}
                trigger={(p) => (
                  <button type="button" {...p} aria-label={t("More")} title={t("More")} disabled={!!busy}
                    className="grid size-9 place-items-center rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink max-sm:size-10"><Ellipsis className="size-4" /></button>
                )} />
            )}
          </div>
        )}
      </header>

      {c.archived && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-raised/40 px-3 py-2 text-xs text-mute">
          <Archive className="size-3.5 shrink-0" />
          <p className="min-w-0 flex-1">{t("Archived: not in the character library or any project's cast.")}</p>
          {editable && <Button size="sm" variant="outline" loading={busy === "archive"} icon={<ArchiveRestore className="size-3.5" />} onClick={() => void archive(false)}>{t("Restore")}</Button>}
        </div>
      )}
      {c.locked && (
        <p className="flex items-start gap-2 rounded-lg border border-warn/25 bg-warn/6 px-3 py-2 text-xs text-amber-300">
          <Lock className="mt-px size-3.5 shrink-0" />
          {canProduce ? t("Locked and approved. Unlock it to make changes — edits then create a new version.") : t("Locked and approved by a producer. Ask a producer to unlock it before editing.")}
        </p>
      )}

      <RedoShotsBanner cid={cid} name={c.name} projectId={projectId} canEdit={canEdit} />

      {imageJobs.length > 0 && (
        <JobStrip label={imageJobs[0].message || imageJobs[0].label} progress={imageJobs[0].progress || 0}
          right={imageJobs.length > 1 ? t("{n} jobs", { n: imageJobs.length }) : `${Math.round((imageJobs[0].progress || 0) * 100)}%`} />
      )}

      {/* the pictures every shot copies the look from */}
      <section aria-labelledby={`pics-${cid}`} className="space-y-3">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-56">
            <h2 id={`pics-${cid}`} className="flex items-baseline gap-2 text-sm font-semibold tracking-tight">
              {t("Pictures")}<span className="mono text-2xs font-normal text-dim">{t("{a}/{n} approved", { a: viewsApproved, n: SHEET_VIEWS.length + (sources.length ? 1 : 0) })}</span>
            </h2>
            <p className="mt-0.5 text-xs text-mute">{t("Approve the good ones: every shot copies {name}'s look from the approved pictures.", { name: c.name })}</p>
          </div>
          {editable && (
            <Button variant={sources.length || viewsMade ? "secondary" : "outline"} className="max-sm:h-10" loading={busy === "upload"} icon={<Upload className="size-4" />}
              onClick={() => fileRef.current?.click()}>{t("Upload photos")}</Button>
          )}
          {canEdit && (
            <Button variant="primary" className="max-sm:h-10" icon={<Wand2 className="size-4" />} onClick={() => makeSheet()}>
              {sources.length ? t("Make pictures from my photo") : t("Make pictures")}<PriceSuffix usd={sheetEst.data?.total_usd} />
            </Button>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden multiple
            onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) upload(fs.slice(0, 8)); }} />
        </div>
        {editable && <AiMadeCheck checked={aiMade} onChange={setAiMade} disabled={busy === "upload"} compact />}
        <PictureGrid slots={viewSlots} canEdit={editable} minTile={columns ? 10.5 : 9.5}
          onApprove={(id, on) => void assetPatch(id, { approved: on })} onRemove={(id) => void assetPatch(id, { archived: true })}
          onRedo={(s) => makeSheet([s.key.replace("view-", "")])} redoPrice={<PriceSuffix usd={viewEst.data?.total_usd} />} />
      </section>

      {stills.length > 0 && (
        <section aria-label={t("From your shots")}>
          <GroupHead title={t("From your shots")} count={stills.length} hint={t("Faces from pictures you picked; new pictures use them right after the approved views.")} />
          <Gallery items={stills.map((a) => toItem(a, a.label || t("approved still"), a.outfit || undefined))} canEdit={editable} minTile={7}
            onApprove={(it) => void assetPatch(it.id, { approved: !it.approved })} onRemove={(it) => void assetPatch(it.id, { archived: true })} />
        </section>
      )}
      {others.length > 0 && (
        <section aria-label={t("Other pictures")}>
          <GroupHead title={t("Other pictures")} count={others.length} />
          <Gallery items={others.map((a) => toItem(a, a.label || a.kind.replace(/_/g, " "), a.outfit || undefined))} canEdit={editable} minTile={7}
            onApprove={(it) => void assetPatch(it.id, { approved: !it.approved })} onRemove={(it) => void assetPatch(it.id, { archived: true })} />
        </section>
      )}
    </div>
  );

  const panel = (
    <div className={cn(!columns && "overflow-hidden rounded-xl border border-line bg-panel")}>
      <SideSection icon={<Mic />} title={t("Voice")} defaultOpen
        summary={scope.languages.length ? (voiceN === scope.languages.length ? <span className="text-ok">✓ {t("voice set")}</span> : voiceN ? t("{a} of {n}", { a: voiceN, n: scope.languages.length }) : t("no voice yet")) : undefined}>
        <VoiceQuick character={c} />
      </SideSection>
      <SideSection icon={<ShieldCheck />} title={t("Look lock")}
        summary={typeof strictness === "number" ? <span className={LEVEL_TEXT[strictLevel]}>{t(LEVEL_LABEL[strictLevel])}</span> : undefined}>
        <CharacterLockPanel character={c} editable={editable} />
      </SideSection>
      <SideSection icon={<Shirt />} title={t("Outfits")} summary={costumeCount ? String(costumeCount) : t("none")}>
        <Costumes character={c} editable={editable} />
      </SideSection>
      <SideSection icon={<UserRound />} title={t("Who they are")} summary={c.role || undefined}>
        <div className="space-y-3.5">
          <RField label={t("Name")} htmlFor="ch-name"><Input id="ch-name" value={form.name || ""} disabled={!editable} onChange={(e) => setForm({ ...form, name: e.target.value })} /></RField>
          <RField label={t("Role")} htmlFor="ch-role"><Input id="ch-role" value={form.role || ""} disabled={!editable} onChange={(e) => setForm({ ...form, role: e.target.value })} /></RField>
          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
            <RField label={t("Gender")} htmlFor="ch-gender">
              <Select id="ch-gender" value={form.gender || ""} disabled={!editable} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                <option value="">—</option><option value="male">{t("male")}</option><option value="female">{t("female")}</option><option value="neutral">{t("neutral")}</option>
              </Select>
            </RField>
            <RField label={t("Age")} htmlFor="ch-age"><Input id="ch-age" className="mono" value={form.age || ""} disabled={!editable} onChange={(e) => setForm({ ...form, age: e.target.value })} /></RField>
          </div>
          <RField label={t("How they look (added to every picture)")} htmlFor="ch-dna"
            right={<span className={cn("mono text-2xs", wordTone === "ok" ? "text-green-300" : "text-amber-300")}>{words} / 60–80</span>}
            hint={t("Face, skin, hair, eyes, build, signature outfit, marks. Looks only.")}>
            <Textarea id="ch-dna" rows={5} value={form.dna_text || ""} disabled={!editable} onChange={(e) => setForm({ ...form, dna_text: e.target.value })} />
            <DnaGauge words={words} ok={wordTone === "ok"} />
          </RField>
          <RField label={t("Personality (for the writer)")} htmlFor="ch-pers"><Input id="ch-pers" value={form.personality || ""} disabled={!editable} onChange={(e) => setForm({ ...form, personality: e.target.value })} /></RField>
          <RField label={t("Voice description")} htmlFor="ch-vd"><Input id="ch-vd" value={form.voice_description || ""} disabled={!editable} onChange={(e) => setForm({ ...form, voice_description: e.target.value })} /></RField>
          <RField label={t("Name pronunciation")} htmlFor="ch-pron" hint={t("how voices say the name, e.g. RAH-vee")}>
            <Input id="ch-pron" value={form.name_pronunciation || ""} disabled={!editable} placeholder={t("RAH-vee")} onChange={(e) => setForm({ ...form, name_pronunciation: e.target.value })} />
          </RField>
          <RField label={t("Performance notes")} htmlFor="ch-perf" hint={t("Gestures, posture, speaking style — added to every prompt as 'performance: …'")}>
            <Textarea id="ch-perf" rows={2} value={form.performance_notes || ""} disabled={!editable} placeholder={t("Speaks slowly, hands folded; a half-smile before every reply")}
              onChange={(e) => setForm({ ...form, performance_notes: e.target.value })} />
          </RField>
        </div>
      </SideSection>
      <SideSection icon={<SlidersHorizontal />} title={t("Advanced")} summary={t("training, Seedance, more")} chrome="flat">
        <div className="space-y-5 [&>*+*]:border-t [&>*+*]:border-line [&>*+*]:pt-5">
          <MoreLooks c={c} refs={refsAll} jobs={imageJobs} editable={editable} canEdit={canEdit} projectId={projectId} packJob={packJob}
            onApprove={(id, on) => void assetPatch(id, { approved: on })} onRemove={(id) => void assetPatch(id, { archived: true })} />
          <UploadAttestations character={c} uploads={((c.assets ?? []) as Asset[]).filter((a) => a.kind === "source")} canAttest={editable} canUnattest={canEdit} />
          {canEdit && <SheetEnginePicker character={c} editable={editable} />}
          <BoardTools c={c} projectId={projectId} editable={editable} />
          <IdentityPanel character={c} />
          <BytePlusPanel character={c} />
          <ConsentPanel character={c} />
          <Versions character={c} editable={editable} />
          <TrainingSets assets={assets} />
          {editable && !c.archived && (
            <div><Button variant="ghost" className="max-sm:h-10" icon={<Archive className="size-4" />} disabled={!!busy} onClick={() => setArchiving(true)}>{t("Archive {name}", { name: c.name })}</Button></div>
          )}
        </div>
      </SideSection>
    </div>
  );

  return (
    <div className={cn("@container", columns && "h-full")}>
      {columns ? (
        <div className="grid h-full grid-cols-[minmax(0,1fr)_21.25rem]">
          <div className="h-full min-w-0 overflow-y-auto overscroll-contain px-5 pb-10 pt-4" data-page-scroller>{centre}</div>
          <aside aria-label={t("Details")} className="relative h-full min-w-0 overflow-y-auto overscroll-contain border-l border-line bg-panel/70">
            {panel}
            <FloatingSaveBar show={editable && (dirty || busy === "save")} state={state} saving={busy === "save"} onSave={save} onDiscard={() => setForm(seed(c))} />
          </aside>
        </div>
      ) : (
        <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_21.25rem] @4xl:items-start">
          <div className="min-w-0">{centre}</div>
          <aside aria-label={t("Details")} className="min-w-0 @4xl:sticky @4xl:top-4">{panel}</aside>
          <FloatingSaveBar show={editable && (dirty || busy === "save")} state={state} saving={busy === "save"} onSave={save} onDiscard={() => setForm(seed(c))} />
        </div>
      )}

      <ConfirmDialog open={archiving} onClose={() => setArchiving(false)} busy={busy === "archive"} title={t("Archive {name}?", { name: c.name })}
        confirmLabel={c.provider_assets?.byteplus ? t("Archive and remove from BytePlus") : t("Archive")} icon={<Archive className="size-4" />} onConfirm={() => archive(true)}>
        {t("{name} leaves the character library and the cast of every project. You can undo it right after.", { name: c.name })}
        {c.provider_assets?.byteplus && <> <span className="font-medium text-ink">{t("{name} is also removed from your BytePlus asset library, so Seedance no longer knows the character.", { name: c.name })}</span></>}
      </ConfirmDialog>
    </div>
  );
}

/** Advanced › expressions and lighting: the same face in five moods and three lights, each made with its price first. */
function MoreLooks({ c, refs, jobs, editable, canEdit, projectId, packJob, onApprove, onRemove }: {
  c: CharacterV3; refs: Asset[]; jobs: Job[]; editable: boolean; canEdit: boolean; projectId: number | undefined;
  packJob: (action: QuoteAction, run: () => Promise<SubmitResult>, what: string) => void;
  onApprove: (id: number, on: boolean) => void; onRemove: (id: number) => void;
}) {
  const t = useT();
  const exprEst = useQuote(canEdit ? { action: "expressions", character_id: c.id, project_id: projectId ?? null } : null, [c.sheet_engine]);
  const lightEst = useQuote(canEdit ? { action: "lighting", character_id: c.id, project_id: projectId ?? null } : null, [c.sheet_engine]);
  const expressions = refs.filter((a) => a.kind === "expression");
  const lighting = refs.filter((a) => a.kind === "lighting").sort((a, b) => LIGHT_ORDER.indexOf(a.lighting ?? "") - LIGHT_ORDER.indexOf(b.lighting ?? "") || a.id - b.id);
  const pendExpr = pendingOf(jobs, "character_expressions", () => 5);
  const pendLight = pendingOf(jobs, "character_lighting", (j) => (j.payload?.variants as string[] | undefined)?.length ?? LIGHTING_VARIANTS.length);
  const block = (title: string, hint: string, items: Asset[], pending: number, label: (a: Asset) => string, button: ReactNode) => (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <p className="text-xs text-mute">{hint}</p>
      </div>
      {(items.length > 0 || pending > 0) && (
        <PictureGrid slots={[...items.map((a) => ({ key: `a-${a.id}`, label: label(a), asset: a })), ...Array.from({ length: pending }, (_, i) => ({ key: `p-${i}`, label: t("Being made…"), pending: true }))]}
          canEdit={editable} minTile={6.5} onApprove={onApprove} onRemove={onRemove} />
      )}
      {button}
    </section>
  );
  return (
    <div className="space-y-5">
      {block(t("Expressions"), t("Happy, sad, angry, surprised and thinking: the same face in every mood."), expressions, pendExpr, (a) => a.label || t("expression"),
        canEdit && (
          <Button size="sm" className="w-full max-sm:h-10" icon={<Smile className="size-3.5" />}
            onClick={() => packJob("expressions", () => api.post<SubmitResult>(`/api/characters/${c.id}/expressions`, { project_id: projectId ?? null }), tr("Expressions for {name}", { name: c.name }))}>
            {expressions.length ? t("Make the expressions again") : t("Make expressions")}<PriceSuffix usd={exprEst.data?.total_usd} />
          </Button>
        ))}
      {block(t("Lighting"), t("The same face in day, dusk and night-interior light."), lighting, pendLight, (a) => t(LIGHT_LABEL[a.lighting ?? ""] ?? a.label),
        canEdit && (
          <Button size="sm" className="w-full max-sm:h-10" icon={<SunMedium className="size-3.5" />}
            onClick={() => packJob("lighting", () => generateLighting(c.id, projectId ?? null) as Promise<SubmitResult>, tr("Lighting variants for {name}", { name: c.name }))}>
            {lighting.length ? t("Make the lighting again") : t("Make lighting variants")}<PriceSuffix usd={lightEst.data?.total_usd} />
          </Button>
        ))}
    </div>
  );
}

/** Advanced › boards: a whole board in one request, or cut a board you already have into separate views. */
function BoardTools({ c, projectId, editable }: { c: CharacterV3; projectId: number | undefined; editable: boolean }) {
  const t = useT();
  if (!editable) return <BoardSplitCard character={c} projectId={projectId} editable={editable} />;
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{t("Character boards")}</h3>
        <p className="text-xs text-mute">{t("Make the whole board in one go, or cut a board you already have into separate views.")}</p>
      </div>
      <OneCallBoardButton character={c} projectId={projectId} editable={editable} />
      <BoardSplitCard character={c} projectId={projectId} editable={editable} />
    </section>
  );
}

/** Advanced › the face model's training set and identity tests, when there are any. */
function TrainingSets({ assets }: { assets: Asset[] }) {
  const t = useT();
  const training = assets.filter((a) => a.kind === "training");
  const tests = assets.filter((a) => a.kind === "identity_test");
  if (!training.length && !tests.length) return null;
  const items = (xs: Asset[]) => xs.map((a): GalleryItem => ({ id: a.id, url: a.url, label: a.label || a.kind.replace(/_/g, " "), approved: a.approved }));
  return (
    <section className="space-y-3">
      {training.length > 0 && <div><GroupHead title={t("Training set")} count={training.length} /><Gallery items={items(training)} canEdit={false} minTile={4.5} /></div>}
      {tests.length > 0 && <div><GroupHead title={t("Identity tests")} count={tests.length} /><Gallery items={items(tests)} canEdit={false} minTile={4.5} /></div>}
    </section>
  );
}

/** Word-count gauge of the look field: a track with the 60–80 sweet spot marked, the fill turns amber outside 40–110. */
function DnaGauge({ words, ok }: { words: number; ok: boolean }) {
  const at = (w: number) => `${(w / 110) * 100}%`;
  return (
    <div aria-hidden className="mt-2">
      <div className="cs-gauge-ticks relative h-2 overflow-hidden rounded-[3px] border border-line bg-bg/40">
        <span className="absolute inset-y-0 bg-ok/25" style={{ left: at(60), width: at(20) }} />
        <motion.span className={cn("absolute inset-y-0 left-0", ok ? "bg-ok" : "bg-warn")} animate={{ width: `${Math.min(100, (words / 110) * 100)}%` }}
          transition={{ type: "spring", stiffness: 200, damping: 28 }} />
      </div>
    </div>
  );
}

function DetailSkeleton({ onBack, backLabel, columns, showBack }: { onBack: () => void; backLabel: string; columns: boolean; showBack: boolean }) {
  const pics = (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,10rem),1fr))]">
      {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] !rounded-xl" />)}
    </div>
  );
  const side = <div className="space-y-2 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>;
  return (
    <div className={cn("@container", columns && "h-full")} aria-busy="true">
      {columns ? (
        <div className="grid h-full grid-cols-[minmax(0,1fr)_21.25rem]">
          <div className="space-y-4 px-5 pt-4"><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-64 max-w-full" />{pics}</div>
          <div className="border-l border-line bg-panel/70">{side}</div>
        </div>
      ) : (
        <div className="space-y-4">
          {showBack && <DetailBar backLabel={backLabel} onBack={onBack} />}
          <Skeleton className="h-6 w-48" />{pics}
          <div className="rounded-xl border border-line bg-panel">{side}</div>
        </div>
      )}
    </div>
  );
}
