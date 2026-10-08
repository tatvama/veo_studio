import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Images, ImagePlus, Lock, LockOpen, Mic, ScanFace, Shirt, ShieldAlert, ShieldCheck, Smile, Upload, UserRound, Wand2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import { useCharacter } from "../../lib/queries";
import type { Character, SubmitResult } from "../../lib/types";
import { useGenerate } from "../Generate";
import { Avatar, Badge, Button, Input, Modal, Progress, Segmented, Select, Skeleton, Textarea } from "../ui";
import { ConsentPanel, IdentityBadge, IdentityPanel } from "./Identity";
import { DetailBar, FloatingSaveBar, RField, RoomEmpty, SectionCard, type SaveState } from "./kit";
import { Gallery, type GalleryItem } from "./Lightbox";
import { useCharScope } from "./scope";
import { consentNeeds, IDENTITY_STATUS, useActiveJobs, useConsentRows, useSaveShortcut } from "./util";
import { Voices } from "./Voices";

/** The big view of one character: profile, reference sheet, voices, identity and consent, with a status strip that jumps to each. */
export function CharacterDetail({ cid, chars, onBack, onOpen, backLabel }: {
  cid: number; chars: Character[]; onBack: () => void; onOpen: (id: number) => void; backLabel?: string;
}) {
  const t = useT();
  const scope = useCharScope();
  const { canEdit, canProduce, projectId } = scope;
  const back = backLabel ?? t("Cast");
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const { data: c, isLoading, isError } = useCharacter(cid);
  const { data: consents } = useConsentRows(canProduce);
  const [form, setForm] = useState<Partial<Character>>({});
  const [outfitOpen, setOutfitOpen] = useState(false);
  const [outfit, setOutfit] = useState({ name: "", description: "" });
  const [busy, setBusy] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const [view, setView] = useState<"refs" | "training" | "tests">("refs");
  const [outfitFilter, setOutfitFilter] = useState<string>("*");
  const fileRef = useRef<HTMLInputElement>(null);
  const imageJobs = useActiveJobs(projectId, (j) => ["character_sheet", "character_outfit", "character_expressions"].includes(j.type) && Number(j.payload?.character_id) === cid);

  useEffect(() => { if (c) setForm({ name: c.name, role: c.role, gender: c.gender, age: c.age, dna_text: c.dna_text, personality: c.personality, voice_description: c.voice_description }); }, [c?.id, c?.version, c?.dna_text]);
  useEffect(() => {
    if (!justSaved) return;
    const id = window.setTimeout(() => setJustSaved(false), 2200);
    return () => window.clearTimeout(id);
  }, [justSaved]);

  const dirty = !!c && Object.entries(form).some(([k, v]) => (c as any)[k] !== v);
  const editable = !!c && canEdit && (!c.locked || canProduce);
  const save = async () => {
    if (!c) return;
    setBusy("save");
    try {
      await api.patch(`/api/characters/${cid}`, form);
      qc.invalidateQueries({ queryKey: ["character", cid] });
      qc.invalidateQueries({ queryKey: ["characters"] });
      setJustSaved(true);
      toast.success(tr("Saved"));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  useSaveShortcut(dirty && editable && busy !== "save", save);

  const assets = useMemo(() => (c?.assets ?? []).filter((a) => !a.archived), [c?.assets]);
  const refsAll = assets.filter((a) => a.kind !== "identity_test" && a.kind !== "training");
  const training = assets.filter((a) => a.kind === "training");
  const tests = assets.filter((a) => a.kind === "identity_test");
  const outfits = useMemo(() => [...new Set(refsAll.map((a) => a.outfit).filter(Boolean))], [refsAll]);

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const idx = chars.findIndex((x) => x.id === cid);

  if (isError) {
    return (
      <div className="space-y-4">
        <DetailBar backLabel={back} onBack={onBack} />
        <RoomEmpty icon={<UserRound />} title={t("Character not found")} sub={t("It may have been removed.")} action={<Button onClick={onBack}>{t("Back")}</Button>} />
      </div>
    );
  }
  if (isLoading || !c) return <DetailSkeleton onBack={onBack} backLabel={back} />;

  const refresh = () => { qc.invalidateQueries({ queryKey: ["character", cid] }); qc.invalidateQueries({ queryKey: ["characters"] }); };
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

  const pendingTiles = imageJobs.reduce((n, j) => n + (j.type === "character_outfit" ? 1 : 4), 0);
  const shownAssets = view === "training" ? training : view === "tests" ? tests : refsAll.filter((a) => outfitFilter === "*" || (outfitFilter === "" ? !a.outfit : a.outfit === outfitFilter));
  const items: GalleryItem[] = shownAssets.map((a) => ({
    id: a.id, url: a.url, label: a.kind === "source" ? `★ ${a.label || t("your photo")}` : a.label || a.kind.replace(/_/g, " "),
    sub: a.kind === "source" ? (a.approved ? t("your photo · used first") : t("your photo · not used (unapproved)")) : a.outfit || undefined,
    approved: a.approved,
  }));
  const ownPhotos = refsAll.filter((a) => a.kind === "source");
  const approvedCount = refsAll.filter((a) => a.approved).length;
  const voices = ((c.voices ?? []) as any[]).filter((v) => typeof v === "object" && v.language);
  const voiceCount = scope.languages.filter((l) => voices.some((v) => v.language === l)).length;
  const needs = consentNeeds(c);
  const mineConsent = (consents ?? []).filter((r) => r.character_id === c.id && (!r.expires_on || r.expires_on >= new Date().toISOString().slice(0, 10)));
  const needKinds = [needs.photos.length ? "likeness" : "", needs.external.length ? "voice_replication" : ""].filter(Boolean);
  const consentOk = needKinds.every((k) => mineConsent.some((r) => r.kind === k));
  const portrait = c.avatar_url || refsAll.find((a) => a.approved)?.url || refsAll[0]?.url;
  const idStatus = c.identity?.status ?? "none";
  const state: SaveState = busy === "save" ? "saving" : dirty ? "dirty" : justSaved ? "saved" : "clean";
  const words = (form.dna_text || "").trim().split(/\s+/).filter(Boolean).length;
  const wordTone = words < 40 || words > 110 ? "warn" : "ok";
  const facts = [c.role, c.gender && t(c.gender), c.age && t("{n} years", { n: c.age })].filter(Boolean).join(" · ");

  return (
    <div className="space-y-5">
      <DetailBar backLabel={back} onBack={onBack} name={c.name}
        pos={idx >= 0 && chars.length > 1 ? { index: idx, total: chars.length, prevLabel: t("Previous character"), nextLabel: t("Next character"),
          onPrev: () => onOpen(chars[(idx - 1 + chars.length) % chars.length].id), onNext: () => onOpen(chars[(idx + 1) % chars.length].id) } : undefined} />

      {/* hero */}
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex flex-col gap-4 p-4 @2xl:flex-row @2xl:items-center @2xl:gap-5 @2xl:p-5">
          <div className="relative aspect-[3/4] w-24 shrink-0 overflow-hidden rounded-xl border border-line bg-raised @2xl:w-28">
            {portrait ? <img src={portrait} alt={c.name} className="size-full object-cover" /> : (
              <div className="grid size-full place-items-center bg-gradient-to-br from-accent/10 to-transparent"><Avatar name={c.name} size={56} /></div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 max-w-full truncate text-xl font-semibold tracking-tight" title={c.name}>{c.name}</h1>
              <Badge>v{c.version}</Badge>
              {c.locked ? <Badge tone="warn"><Lock className="size-3" />{t("Locked")}</Badge> : <Badge><LockOpen className="size-3" />{t("Unlocked")}</Badge>}
              <IdentityBadge identity={c.identity} />
            </div>
            {facts && <p className="mt-1 text-sm text-mute">{facts}</p>}
            {c.personality && <p className="mt-1.5 line-clamp-2 text-sm text-dim">{c.personality}</p>}
            <nav aria-label={t("Jump to a section")} className="mt-3 flex flex-wrap gap-1.5">
              <StatusChip icon={<Images />} tone={approvedCount ? "ok" : "neutral"} onClick={() => jump("sec-sheet")}>
                {refsAll.length ? t("{n} reference images", { n: refsAll.length }) : t("No reference images")}{approvedCount > 0 && ` · ${t("{n} approved", { n: approvedCount })}`}
              </StatusChip>
              <StatusChip icon={<Mic />} tone={voiceCount && voiceCount === scope.languages.length ? "ok" : "neutral"} onClick={() => jump("sec-voices")}>
                {t("{a}/{n} voices", { a: voiceCount, n: scope.languages.length })}
              </StatusChip>
              <StatusChip icon={<ScanFace />} tone={idStatus === "ready" ? "ok" : idStatus === "failed" ? "bad" : idStatus === "none" ? "neutral" : "info"} onClick={() => jump("sec-identity")}>
                {t(IDENTITY_STATUS[idStatus].label)}
              </StatusChip>
              {needs.any && (
                <StatusChip icon={consentOk ? <ShieldCheck /> : <ShieldAlert />} tone={consentOk ? "ok" : "warn"} onClick={() => jump("sec-consent")}>
                  {consentOk ? t("Consent on file") : t("Consent needed")}
                </StatusChip>
              )}
            </nav>
          </div>
          {canProduce && (
            <div className="shrink-0">
              <Button variant={c.locked ? "outline" : "secondary"} loading={busy === "lock"} onClick={lock} icon={c.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}>
                {c.locked ? t("Unlock (new version)") : t("Approve & lock")}
              </Button>
            </div>
          )}
        </div>
        {c.locked && (
          <div className="flex items-start gap-2.5 border-t border-warn/25 bg-warn/6 px-4 py-2.5 text-xs text-amber-300 @2xl:px-5">
            <Lock className="mt-px size-3.5 shrink-0" />
            <p>{canProduce ? t("Locked and approved. Unlock it to make changes — edits then create a new version.") : t("Locked and approved by a producer. Ask a producer to unlock it before editing.")}</p>
          </div>
        )}
      </div>

      {/* profile */}
      <SectionCard id="sec-profile" icon={<UserRound />} title={t("Profile")} description={t("Who they are, and the exact look the image models should reproduce.")}>
        <div className="space-y-4">
          <div className="grid gap-4 @lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_6rem]">
            <RField label={t("Name")} htmlFor="ch-name"><Input id="ch-name" value={form.name || ""} disabled={!editable} onChange={(e) => setForm({ ...form, name: e.target.value })} /></RField>
            <RField label={t("Role")} htmlFor="ch-role"><Input id="ch-role" value={form.role || ""} disabled={!editable} onChange={(e) => setForm({ ...form, role: e.target.value })} /></RField>
            <RField label={t("Gender")} htmlFor="ch-gender">
              <Select id="ch-gender" value={form.gender || ""} disabled={!editable} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                <option value="">—</option><option value="male">{t("male")}</option><option value="female">{t("female")}</option><option value="neutral">{t("neutral")}</option>
              </Select>
            </RField>
            <RField label={t("Age")} htmlFor="ch-age"><Input id="ch-age" value={form.age || ""} disabled={!editable} onChange={(e) => setForm({ ...form, age: e.target.value })} /></RField>
          </div>
          <RField label={t("Character DNA — pasted word-for-word into every prompt")} htmlFor="ch-dna"
            hint={<span className={clsx(wordTone === "ok" ? "text-green-300" : "text-amber-300")}>{t("{n} words · aim for 60–80: face, skin, hair, eyes, build, signature outfit, marks. Looks only.", { n: words })}</span>}>
            <Textarea id="ch-dna" rows={4} value={form.dna_text || ""} disabled={!editable} onChange={(e) => setForm({ ...form, dna_text: e.target.value })} />
            <div aria-hidden className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-line">
              <span className="absolute inset-y-0 bg-ok/25" style={{ left: `${(60 / 110) * 100}%`, width: `${(20 / 110) * 100}%` }} />
              <motion.span className={clsx("absolute inset-y-0 left-0 rounded-full", wordTone === "ok" ? "bg-ok" : "bg-warn")} animate={{ width: `${Math.min(100, (words / 110) * 100)}%` }} transition={{ type: "spring", stiffness: 200, damping: 28 }} />
            </div>
          </RField>
          <div className="grid gap-4 @lg:grid-cols-2">
            <RField label={t("Personality (for the writer)")} htmlFor="ch-pers"><Input id="ch-pers" value={form.personality || ""} disabled={!editable} onChange={(e) => setForm({ ...form, personality: e.target.value })} /></RField>
            <RField label={t("Voice description")} htmlFor="ch-vd"><Input id="ch-vd" value={form.voice_description || ""} disabled={!editable} onChange={(e) => setForm({ ...form, voice_description: e.target.value })} /></RField>
          </div>
        </div>
      </SectionCard>

      {/* reference sheet */}
      <SectionCard id="sec-sheet" icon={<Images />} title={t("Reference sheet")} description={t("Approved images become Veo references. Click an image to view it large.")}
        actions={canEdit && (
          <>
            <Button size="sm" variant={ownPhotos.length ? "secondary" : "primary"} icon={<Wand2 className="size-3.5" />}
              onClick={() => submit(() => api.post<SubmitResult>(`/api/characters/${cid}/sheet`, { project_id: projectId ?? null }), tr("Sheet for {name}", { name: c.name }))}>
              {ownPhotos.length ? t("Generate angles from photo") : t("Generate sheet")}
            </Button>
            <Button size="sm" icon={<Smile className="size-3.5" />}
              onClick={() => submit(() => api.post<SubmitResult>(`/api/characters/${cid}/expressions`, { project_id: projectId ?? null }), tr("Expressions"))}>{t("Expressions")}</Button>
            <Button size="sm" icon={<Shirt className="size-3.5" />} onClick={() => setOutfitOpen(true)}>{t("Outfit")}</Button>
          </>
        )}>
        {/* the user's own photos: always the first look reference */}
        {editable && (
          <div className={clsx("mb-4 flex flex-wrap items-center gap-3 rounded-xl border p-3", ownPhotos.length ? "border-ok/30 bg-ok/5" : "border-accent/40 bg-accent/5")}>
            <span className={clsx("grid size-9 shrink-0 place-items-center rounded-lg", ownPhotos.length ? "bg-ok/15 text-ok" : "bg-accent/15 text-accent-ink")}><ImagePlus className="size-4" /></span>
            <div className="min-w-0 flex-1 basis-60">
              <p className="text-sm font-medium">{ownPhotos.length ? t("Your photos ({n}) set the look", { n: ownPhotos.length }) : t("Use your own photos")}</p>
              <p className="text-xs text-mute">{t("Upload clear photos of the face (front, side) and full body. Your approved photos are used first for every keyframe and video; generated angles and outfits are made from them.")}</p>
            </div>
            <Button size="sm" variant={ownPhotos.length ? "secondary" : "primary"} loading={busy === "upload"} icon={<Upload className="size-3.5" />}
              onClick={() => fileRef.current?.click()}>{ownPhotos.length ? t("Add more photos") : t("Upload photos")}</Button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden multiple
              onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) upload(fs.slice(0, 8)); }} />
          </div>
        )}
        {imageJobs.length > 0 && (
          <div className="mb-4 rounded-lg border border-info/30 bg-info/10 p-3" role="status">
            <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-sky-300">{imageJobs[0].message || imageJobs[0].label}</span>
              <span className="shrink-0 tabular-nums text-mute">{Math.round((imageJobs[0].progress || 0) * 100)}%</span>
            </div>
            <Progress value={imageJobs[0].progress || 0} tone="info" />
          </div>
        )}
        {!assets.length && !pendingTiles ? (
          <RoomEmpty icon={<ImagePlus />} title={t("No reference images")} sub={t("Generate a sheet (front, ¾, profile, full body) or upload a photo. Approved images become Veo references.")} />
        ) : (
          <div className="space-y-4">
            {(training.length > 0 || tests.length > 0) && (
              <Segmented value={view} onChange={(v) => { setView(v); setOutfitFilter("*"); }} aria-label={t("Image set")}
                options={[
                  { value: "refs" as const, label: <span className="flex items-center gap-1.5">{t("References")}<span className="tabular-nums text-dim">{refsAll.length}</span></span> },
                  ...(training.length ? [{ value: "training" as const, label: <span className="flex items-center gap-1.5">{t("Training set")}<span className="tabular-nums text-dim">{training.length}</span></span> }] : []),
                  ...(tests.length ? [{ value: "tests" as const, label: <span className="flex items-center gap-1.5">{t("Identity tests")}<span className="tabular-nums text-dim">{tests.length}</span></span> }] : []),
                ]} />
            )}
            {view === "refs" && outfits.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Outfit")}>
                {[{ v: "*", l: t("All outfits") }, { v: "", l: t("Default") }, ...outfits.map((o) => ({ v: o, l: o }))].map((o) => (
                  <button key={o.v || "default"} type="button" aria-pressed={outfitFilter === o.v} onClick={() => setOutfitFilter(o.v)}
                    className={clsx("inline-flex h-7 max-w-full items-center rounded-full border px-3 text-xs font-medium transition-colors",
                      outfitFilter === o.v ? "border-accent/50 bg-accent/12 text-accent-ink" : "border-line text-mute hover:border-dim/60 hover:text-ink")}>
                    <span className="truncate">{o.l}</span>
                  </button>
                ))}
              </div>
            )}
            {items.length || pendingTiles ? (
              <Gallery items={items} canEdit={editable} aspect="3 / 4" minTile={view === "training" ? 6 : 8} pending={view === "refs" ? pendingTiles : 0}
                onApprove={view === "refs" ? (it) => assetPatch(it.id, { approved: !it.approved }) : undefined}
                onRemove={(it) => assetPatch(it.id, { archived: true })} />
            ) : <p className="py-6 text-center text-sm text-dim">{t("Nothing here yet.")}</p>}
          </div>
        )}
      </SectionCard>

      <Voices character={c} />
      <IdentityPanel character={c} />
      <ConsentPanel character={c} />

      <FloatingSaveBar show={editable && (dirty || busy === "save")} state={state} saving={busy === "save"} onSave={save}
        onDiscard={() => setForm({ name: c.name, role: c.role, gender: c.gender, age: c.age, dna_text: c.dna_text, personality: c.personality, voice_description: c.voice_description })} />

      <Modal open={outfitOpen} onClose={() => setOutfitOpen(false)} title={t("New outfit for {name}", { name: c.name })}
        footer={<><Button variant="ghost" onClick={() => setOutfitOpen(false)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy === "outfit"} disabled={!outfit.name || !outfit.description} onClick={async () => {
            setBusy("outfit");
            try {
              await submit(() => api.post<SubmitResult>(`/api/characters/${cid}/outfits`, { ...outfit, project_id: projectId ?? null, episode_scope: scope.episodeNumber ?? null }), tr("Outfit {name}", { name: outfit.name }));
              setOutfitOpen(false);
            } finally { setBusy(""); }
          }}>{t("Generate")}</Button></>}>
        <div className="space-y-3">
          <RField label={t("Outfit name")} htmlFor="outfit-name"><Input id="outfit-name" value={outfit.name} placeholder={t("Wedding outfit")} onChange={(e) => setOutfit({ ...outfit, name: e.target.value })} /></RField>
          <RField label={t("Description")} htmlFor="outfit-desc" hint={t("Assign it to shots in the Storyboard (or ask the Director: 'Ravi wears his wedding outfit in this episode')")}>
            <Textarea id="outfit-desc" value={outfit.description} placeholder={t("Silk cream sherwani with gold embroidery, maroon stole, mojari shoes")} onChange={(e) => setOutfit({ ...outfit, description: e.target.value })} />
          </RField>
        </div>
      </Modal>
    </div>
  );
}

function StatusChip({ icon, tone, onClick, children }: { icon: ReactNode; tone: "ok" | "warn" | "bad" | "info" | "neutral"; onClick: () => void; children: ReactNode }) {
  const tones = {
    ok: "border-ok/30 bg-ok/8 text-green-300 hover:bg-ok/15", warn: "border-warn/30 bg-warn/8 text-amber-300 hover:bg-warn/15",
    bad: "border-bad/30 bg-bad/8 text-red-300 hover:bg-bad/15", info: "border-info/30 bg-info/8 text-sky-300 hover:bg-info/15",
    neutral: "border-line bg-raised text-mute hover:bg-hover hover:text-ink",
  };
  return (
    <button type="button" onClick={onClick}
      className={clsx("inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors [&>svg]:size-3.5 [&>svg]:shrink-0", tones[tone])}>
      {icon}<span className="truncate">{children}</span>
    </button>
  );
}

function DetailSkeleton({ onBack, backLabel }: { onBack: () => void; backLabel: string }) {
  return (
    <div className="space-y-5" aria-busy="true">
      <DetailBar backLabel={backLabel} onBack={onBack} />
      <div className="flex gap-5 rounded-xl border border-line bg-panel p-5">
        <Skeleton className="aspect-[3/4] w-28 shrink-0 !rounded-xl" />
        <div className="min-w-0 flex-1 space-y-3"><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-64 max-w-full" /><Skeleton className="h-4 w-40" /><div className="flex gap-2 pt-1"><Skeleton className="h-7 w-32" /><Skeleton className="h-7 w-24" /><Skeleton className="h-7 w-24" /></div></div>
      </div>
      <div className="space-y-3 rounded-xl border border-line bg-panel p-5"><Skeleton className="h-4 w-32" /><Skeleton className="h-9" /><Skeleton className="h-24" /></div>
    </div>
  );
}
