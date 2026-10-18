import { useQueryClient } from "@tanstack/react-query";
import { Clock, FileText, Focus, Lock, LockOpen, MapPin, Upload, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { quote, useQuote } from "../../lib/estimates";
import { tr, useT } from "../../lib/i18n";
import { useLocations } from "../../lib/queries";
import type { Location, SubmitResult } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { useGenerate } from "../Generate";
import { PriceSuffix } from "../kit/Price";
import { Badge, Button, Input, Skeleton, Textarea } from "../ui";
import { JobStrip } from "./cast";
import { DetailBar, RField, RoomEmpty } from "./kit";
import { PictureGrid, type PictureSlot } from "./Pictures";
import { SideSection } from "./SidePanel";
import { useActiveJobs } from "./util";

const KIND_LABEL: Record<string, string> = { wide: "Wide", medium: "Medium", detail: "Close-up detail" };

/**
 * One place, pictures first (the same pattern as a character): the big pictures with Approve / Redo in the middle and
 * "Make pictures" with its price; the description, the time of day and a close-up detail in the panel on the right.
 * `columns`: a fixed-height parent, the two columns scroll on their own; otherwise the panel goes under the pictures.
 */
export function PlaceDetail({ locId, onBack, onOpen, columns = false, showBack = true }: {
  locId: number; onBack: () => void; onOpen: (id: number) => void; columns?: boolean; showBack?: boolean;
}) {
  const t = useT();
  const { project, canEdit, canProduce } = useProjectCtx();
  const qc = useQueryClient();
  const { priced } = useGenerate();
  const { data: locs, isLoading } = useLocations(project.id);
  const loc = locs?.find((l) => l.id === locId);
  const [desc, setDesc] = useState(loc?.description_text ?? "");
  const [locking, setLocking] = useState(false);
  const [tod, setTod] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const jobs = useActiveJobs(project.id, (j) => j.type === "location_images" && Number(j.payload?.location_id) === locId);
  const body = (kinds: string[]) => ({ kinds, time_of_day: tod || "", project_id: project.id });
  const mainEst = useQuote(canEdit && loc ? { action: "location_images", location_id: locId, ...body(["wide", "medium"]) } : null);
  const oneEst = useQuote(canEdit && loc ? { action: "location_images", location_id: locId, ...body(["detail"]) } : null);
  useEffect(() => { setDesc(loc?.description_text ?? ""); }, [loc?.id, loc?.description_text]);

  if (isLoading && !locs) {
    return <div className={cn("space-y-4", columns && "h-full p-5")} aria-busy="true"><Skeleton className="h-6 w-48" /><Skeleton className="h-56 !rounded-xl" /></div>;
  }
  if (!loc) {
    return (
      <div className={cn("space-y-4", columns && "h-full overflow-y-auto p-5")}>
        {showBack && <DetailBar backLabel={t("Places")} onBack={onBack} />}
        <RoomEmpty icon={<MapPin />} title={t("Location not found")} sub={t("It may have been removed.")} action={<Button onClick={onBack}>{t("Back to places")}</Button>} />
      </div>
    );
  }

  const refresh = () => qc.invalidateQueries({ queryKey: ["locations"] });
  const patchAsset = async (id: number, b: Record<string, any>) => {
    try { await api.patch(`/api/location-assets/${id}`, b); refresh(); } catch { /* api toasts */ }
  };
  const generate = (kinds: string[]) =>
    priced({ quote: () => quote({ action: "location_images", location_id: loc.id, ...body(kinds) }),
      run: () => api.post<SubmitResult>(`/api/locations/${loc.id}/images`, body(kinds)),
      what: tr("{name} images", { name: loc.name }) });
  const editable = canEdit && (!loc.locked || canProduce);
  const toggleLock = async () => {
    setLocking(true);
    try {
      await api.patch(`/api/locations/${loc.id}`, { locked: !loc.locked });
      refresh();
      toast.success(loc.locked ? tr("Location unlocked") : tr("Location approved & locked"));
    } catch { /* api toasts */ } finally { setLocking(false); }
  };
  const saveDesc = async () => {
    if (desc === loc.description_text) return;
    try { await api.patch(`/api/locations/${loc.id}`, { description_text: desc }); refresh(); toast.success(tr("Description saved")); } catch { /* api toasts */ }
  };
  const uploadFile = async (f: File) => {
    setUploading(true);
    try { await api.upload(`/api/locations/${loc.id}/upload`, f); refresh(); toast.success(tr("Photo added")); } catch { /* api toasts */ } finally { setUploading(false); }
  };

  const pending = jobs.reduce((n, j) => n + (Array.isArray(j.payload?.kinds) ? j.payload.kinds.length : 2), 0);
  const assets = loc.assets ?? [];
  const slots: PictureSlot[] = [
    ...assets.map((a) => ({ key: `a-${a.id}`, label: t(KIND_LABEL[a.kind] ?? a.kind.replace(/_/g, " ")), sub: a.time_of_day || undefined, asset: a,
      redo: ["wide", "medium", "detail"].includes(a.kind) })),
    ...Array.from({ length: pending }, (_, i) => ({ key: `p-${i}`, label: t("Being made…"), pending: true })),
  ];
  const approvedN = assets.filter((a) => a.approved).length;
  const idx = locs!.findIndex((l) => l.id === loc.id);

  const centre = (
    <div className="space-y-4">
      {showBack && (
        <DetailBar backLabel={t("Places")} onBack={onBack} name={loc.name}
          pos={locs!.length > 1 ? { index: idx, total: locs!.length, prevLabel: t("Previous location"), nextLabel: t("Next location"),
            onPrev: () => onOpen(locs![(idx - 1 + locs!.length) % locs!.length].id), onNext: () => onOpen(locs![(idx + 1) % locs!.length].id) } : undefined} />
      )}
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 max-w-full truncate text-xl font-semibold tracking-tight" title={loc.name}>{loc.name}</h1>
            {loc.locked ? <Badge tone="warn"><Lock className="size-3" />{t("Locked")}</Badge> : <Badge><LockOpen className="size-3" />{t("Unlocked")}</Badge>}
          </div>
          <p className="mono mt-1 text-xs text-mute">{assets.length ? t("{n} images · {a} approved", { n: assets.length, a: approvedN }) : t("No images yet")}</p>
        </div>
        {canProduce && (
          <Button variant={loc.locked ? "outline" : "secondary"} loading={locking} onClick={toggleLock} className="max-sm:h-10" icon={loc.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}>
            {loc.locked ? t("Unlock") : t("Approve & lock")}
          </Button>
        )}
      </header>
      {jobs.length > 0 && <JobStrip label={jobs[0].message || jobs[0].label} progress={jobs[0].progress || 0} right={`${Math.round((jobs[0].progress || 0) * 100)}%`} />}
      <section aria-labelledby={`loc-pics-${loc.id}`} className="space-y-3">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-56">
            <h2 id={`loc-pics-${loc.id}`} className="text-sm font-semibold tracking-tight">{t("Pictures")}</h2>
            <p className="mt-0.5 text-xs text-mute">{t("Approve the good ones: every shot here copies the place from the approved pictures.")}</p>
          </div>
          {canEdit && (
            <Button variant="primary" className="max-sm:h-10" icon={<Wand2 className="size-4" />} onClick={() => void generate(["wide", "medium"])}>
              {t("Make pictures")}<PriceSuffix usd={mainEst.data?.total_usd} />
            </Button>
          )}
        </div>
        {slots.length ? (
          <PictureGrid slots={slots} aspect="16 / 10" minTile={columns ? 14 : 12} canEdit={canEdit}
            onApprove={(id, on) => void patchAsset(id, { approved: on })} onRemove={(id) => void patchAsset(id, { archived: true })}
            onRedo={(s) => { const a = assets.find((x) => `a-${x.id}` === s.key); if (a) void generate([a.kind]); }}
            redoPrice={<PriceSuffix usd={oneEst.data?.total_usd} />} />
        ) : (
          <RoomEmpty icon={<MapPin />} title={t("No pictures yet")} sub={t("Make a wide and a medium view from the description, or upload a photo of the place.")} />
        )}
      </section>
    </div>
  );

  const panel = (
    <div className={cn(!columns && "overflow-hidden rounded-xl border border-line bg-panel")}>
      <SideSection icon={<FileText />} title={t("Description")} defaultOpen summary={t("{n} words", { n: desc.trim().split(/\s+/).filter(Boolean).length })}>
        <RField label={t("How the place looks (added to every picture here)")} htmlFor={`loc-desc-${loc.id}`}>
          <Textarea id={`loc-desc-${loc.id}`} rows={6} value={desc} disabled={!editable} onChange={(e) => setDesc(e.target.value)} onBlur={() => void saveDesc()} />
        </RField>
      </SideSection>
      {canEdit && (
        <SideSection icon={<Focus />} title={t("More pictures")} defaultOpen>
          <div className="space-y-3">
            <RField label={t("Time of day (optional)")} htmlFor={`loc-tod-${loc.id}`} hint={t("For the next pictures, e.g. dusk or night")}>
              <div className="relative">
                <Clock aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
                <Input id={`loc-tod-${loc.id}`} value={tod} onChange={(e) => setTod(e.target.value)} className="pl-8 max-sm:!h-10" placeholder={t("dusk")} />
              </div>
            </RField>
            <Button className="w-full max-sm:h-10" icon={<Focus className="size-4" />} onClick={() => void generate(["detail"])}>
              {t("Make a close-up detail")}<PriceSuffix usd={oneEst.data?.total_usd} />
            </Button>
            <Button variant="outline" className="w-full max-sm:h-10" loading={uploading} icon={<Upload className="size-4" />} onClick={() => fileRef.current?.click()}>{t("Upload a photo")}</Button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadFile(f); }} />
          </div>
        </SideSection>
      )}
      {loc.locked && (
        <p className="flex items-start gap-2 px-4 py-3 text-xs text-amber-300">
          <Lock className="mt-px size-3.5 shrink-0" />
          {canProduce ? t("Locked and approved. Unlock it to change the description.") : t("Locked and approved by a producer. Ask a producer to unlock it before editing.")}
        </p>
      )}
    </div>
  );

  return columns ? (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_21.25rem]">
      <div className="h-full min-w-0 overflow-y-auto overscroll-contain px-5 pb-10 pt-4">{centre}</div>
      <aside aria-label={t("Details")} className="h-full min-w-0 overflow-y-auto overscroll-contain border-l border-line bg-panel/70">{panel}</aside>
    </div>
  ) : (
    <div className="@container">
      <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_21.25rem] @4xl:items-start">
        <div className="min-w-0">{centre}</div>
        <aside aria-label={t("Details")} className="min-w-0 @4xl:sticky @4xl:top-4">{panel}</aside>
      </div>
    </div>
  );
}

/** Adds a place by name (the Cast's "+ Add" under the list), then opens it. */
export function useAddPlace(onAdded: (l: Location) => void) {
  const { project } = useProjectCtx();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const add = async (name: string) => {
    if (!name.trim()) return;
    setAdding(true);
    try {
      const l = await api.post<Location>("/api/locations", { name: name.trim(), project_id: project.id });
      qc.invalidateQueries({ queryKey: ["locations"] });
      toast.success(tr("Location added"));
      if (l?.id) onAdded(l);
    } catch { /* api toasts */ } finally { setAdding(false); }
  };
  return { add, adding };
}
