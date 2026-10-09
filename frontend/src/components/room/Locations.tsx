import { useQueryClient } from "@tanstack/react-query";
import { Clock, ImagePlus, Images, Lock, LockOpen, MapPin, PencilLine, Plus, Sparkles, Upload, Wand2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import { useLocations } from "../../lib/queries";
import type { Location, SubmitResult } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { useGenerate } from "../Generate";
import { Badge, Button, Input, Meter, Skeleton, Textarea, rise } from "../ui";
import { Portrait, scaleMeter, Vital } from "./cast";
import { DetailBar, LoadError, RField, RoomEmpty } from "./kit";
import { useActiveJobs } from "./util";
import { Gallery, type GalleryItem } from "./Lightbox";
import { IdChip, WorkPanel, code, pad, scrollToSection } from "./workspace";

const GRID = "grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr))]";
const cover = (l: Location) => l.thumb_url || l.assets?.find((a) => a.approved)?.url || l.assets?.[0]?.url || "";

/** Locations as ID cards; open one to edit its description and generate / upload place images. */
export function LocationsTab({ locId, onOpen, onBack, onPropose, proposing }: {
  locId: number | null; onOpen: (id: number) => void; onBack: () => void; onPropose: () => void; proposing: boolean;
}) {
  const t = useT();
  const { project, canEdit } = useProjectCtx();
  const qc = useQueryClient();
  const { data: locs, isLoading, isError, refetch } = useLocations(project.id);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    setAdding(true);
    try {
      const l = await api.post<Location>("/api/locations", { name: name.trim(), project_id: project.id });
      setName("");
      qc.invalidateQueries({ queryKey: ["locations"] });
      toast.success(tr("Location added"));
      if (l?.id) onOpen(l.id);
    } catch { /* api toasts */ } finally { setAdding(false); }
  };

  if (isError && !locs) return <LoadError what={t("Couldn't load the locations")} onRetry={() => refetch()} />;

  if (locId) {
    const loc = locs?.find((l) => l.id === locId);
    if (isLoading) {
      return (
        <div className="space-y-4" aria-busy="true">
          <DetailBar backLabel={t("Locations")} onBack={onBack} />
          <Skeleton className="h-44 !rounded-xl" /><Skeleton className="h-56 !rounded-xl" />
        </div>
      );
    }
    if (!loc) {
      return (
        <div className="space-y-4">
          <DetailBar backLabel={t("Locations")} onBack={onBack} />
          <RoomEmpty icon={<MapPin />} title={t("Location not found")} sub={t("It may have been removed.")} action={<Button onClick={onBack}>{t("Back to locations")}</Button>} />
        </div>
      );
    }
    const idx = locs!.findIndex((l) => l.id === locId);
    return (
      <LocationDetail key={loc.id} loc={loc} onBack={onBack}
        pos={locs!.length > 1 ? { index: idx, total: locs!.length, prevLabel: t("Previous location"), nextLabel: t("Next location"),
          onPrev: () => onOpen(locs![(idx - 1 + locs!.length) % locs!.length].id), onNext: () => onOpen(locs![(idx + 1) % locs!.length].id) } : undefined} />
    );
  }

  if (isLoading) {
    return (
      <div className={GRID} aria-busy="true" aria-label={t("Loading locations…")}>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="rounded-xl border border-line bg-panel p-3">
            <div className="flex items-center justify-between"><Skeleton className="h-4 w-14" /><Skeleton className="h-3 w-12" /></div>
            <Skeleton className="mt-2.5 aspect-[16/10]" />
            <div className="mt-3 space-y-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-2/3" /></div>
          </div>
        ))}
      </div>
    );
  }
  const list = locs ?? [];
  return (
    <div className="space-y-4">
      {!list.length && (
        <RoomEmpty icon={<MapPin />} title={t("No locations yet")} sub={t("Build the bible from the script, or add one here.")}
          action={canEdit ? <Button variant="primary" loading={proposing} icon={<Sparkles className="size-4" />} onClick={onPropose}>{t("Build from script")}</Button> : undefined} />
      )}
      {(list.length > 0 || canEdit) && (
        <section aria-label={t("Location roster")}>
          <div className="mb-3 flex items-center gap-3">
            <p className="eyebrow flex items-center gap-1.5"><MapPin aria-hidden className="size-3.5" />{t("Location roster")}<span className="mono text-mute">{pad(list.length)}</span></p>
            <span aria-hidden className="rm-rule h-px min-w-6 flex-1" />
          </div>
          <div className={GRID}>
            {list.map((l, i) => <LocationCard key={l.id} loc={l} index={i} onOpen={() => onOpen(l.id)} />)}
            {canEdit && (
              <form {...rise(list.length)} onSubmit={add}
                className={cn("hud rm-scan flex min-h-[13rem] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line p-4 text-center transition-colors focus-within:border-accent/50 hover:border-dim/60", rise(list.length).className)}>
                <span aria-hidden className="grid size-10 place-items-center rounded-lg border border-dashed border-dim/50 bg-raised text-mute"><Plus className="size-5" /></span>
                <div>
                  <p className="eyebrow !text-mute">{t("Empty slot")}</p>
                  <p className="mt-1.5 text-sm font-medium">{t("New location")}</p>
                </div>
                <Input placeholder={t("New location name")} aria-label={t("New location name")} value={name} onChange={(e) => setName(e.target.value)} className="text-center" />
                <Button type="submit" size="sm" disabled={!name.trim()} loading={adding} icon={<Plus className="size-3.5" />}>{t("Add")}</Button>
              </form>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function LocationCard({ loc, index, onOpen }: { loc: Location; index: number; onOpen: () => void }) {
  const t = useT();
  const r = rise(index);
  const img = cover(loc);
  const n = loc.assets?.length ?? 0;
  const approved = loc.assets?.filter((a) => a.approved).length ?? 0;
  const m = scaleMeter(approved, n, 6);
  return (
    <div {...r}>
      <button type="button" onClick={onOpen} aria-label={loc.name}
        className={cn("hud lift group relative flex h-full w-full flex-col rounded-xl border bg-panel text-left hover:border-accent/50", loc.locked ? "border-warn/35" : "border-line")}>
        <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <span aria-hidden className="cs-slot absolute left-1/2 top-1 -translate-x-1/2" />
        <span className="flex items-center justify-between gap-2 px-3 pt-3.5">
          <IdChip tone={loc.locked ? "accent" : "neutral"}>{code("LC", loc.id)}</IdChip>
          {loc.locked ? (
            <span className="mono inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-amber-300"><Lock aria-hidden className="size-3" />{t("Locked")}</span>
          ) : (
            <span className="mono inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-dim"><PencilLine aria-hidden className="size-3" />{t("Draft")}</span>
          )}
        </span>
        <span className="block px-3 pt-2.5">
          <Portrait src={img} name={loc.name} ratio="aspect-[16/10]" placeholder={<MapPin aria-hidden className="size-8 text-dim" />}
            imgClassName="transition-transform duration-500 ease-out group-hover:scale-[1.04]">
            <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/55 to-transparent" />
          </Portrait>
        </span>
        <span className="block px-3 pt-2.5">
          <span className="block truncate text-sm font-semibold leading-tight" title={loc.name}>{loc.name}</span>
          <span className="mt-1 line-clamp-2 block min-h-8 text-xs leading-relaxed text-mute">{loc.description_text || t("No description yet.")}</span>
        </span>
        <span className="mt-auto flex items-center gap-3 px-3 pb-3 pt-2.5">
          <span className="flex min-w-0 flex-1 items-center gap-2 border-t border-dashed border-line pt-2 text-2xs text-mute">
            <Images aria-hidden className="size-3 shrink-0 text-dim" />
            {n ? <span className="mono truncate">{t("{n} images · {a} approved", { n, a: approved })}</span> : <span className="truncate text-dim">{t("No images yet")}</span>}
            {n > 0 && <Meter filled={m.filled} total={m.total} tone={approved ? "ok" : "neutral"} className="ml-auto w-12 shrink-0" />}
          </span>
        </span>
      </button>
    </div>
  );
}

function LocationDetail({ loc, onBack, pos }: {
  loc: Location; onBack: () => void; pos?: { index: number; total: number; prevLabel: string; nextLabel: string; onPrev: () => void; onNext: () => void };
}) {
  const t = useT();
  const { project, canEdit, canProduce } = useProjectCtx();
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const [desc, setDesc] = useState(loc.description_text);
  const [locking, setLocking] = useState(false);
  const [tod, setTod] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setDesc(loc.description_text); }, [loc.id, loc.description_text]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["locations"] });
  const patchAsset = async (id: number, body: Record<string, any>) => {
    try { await api.patch(`/api/location-assets/${id}`, body); refresh(); } catch { /* api toasts */ }
  };
  const generate = (kinds: string[]) =>
    submit(() => api.post<SubmitResult>(`/api/locations/${loc.id}/images`, { kinds, time_of_day: tod || "", project_id: project.id }), tr("{name} images", { name: loc.name }));
  const editable = canEdit && (!loc.locked || canProduce);
  const toggleLock = async () => {
    setLocking(true);
    try {
      await api.patch(`/api/locations/${loc.id}`, { locked: !loc.locked });
      refresh();
      toast.success(loc.locked ? tr("Location unlocked") : tr("Location approved & locked"));
    } catch { /* api toasts */ } finally { setLocking(false); }
  };
  const img = cover(loc);
  const jobs = useActiveJobs(project.id, (j) => j.type === "location_images" && Number(j.payload?.location_id) === loc.id);
  const pendingTiles = jobs.reduce((n, j) => n + (Array.isArray(j.payload?.kinds) ? j.payload.kinds.length : 2), 0);
  const items: GalleryItem[] = (loc.assets ?? []).map((a) => ({ id: a.id, url: a.url, label: a.kind.replace(/_/g, " "), sub: a.time_of_day || undefined, approved: a.approved }));
  const approvedN = items.filter((i) => i.approved).length;
  const m = scaleMeter(approvedN, items.length, 8);
  const words = desc.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <DetailBar backLabel={t("Locations")} onBack={onBack} name={loc.name} pos={pos} />

      {/* the location's ID card */}
      <section aria-label={loc.name} className="hud relative rounded-xl border border-line bg-panel @container">
        <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-70" />
        <div className="flex flex-col gap-4 p-4 @2xl:flex-row @2xl:items-center @2xl:gap-5 @2xl:p-5">
          <Portrait src={img} name={loc.name} alt={loc.name} ratio="aspect-[16/10]" placeholder={<MapPin aria-hidden className="size-9 text-dim" />} className="w-full shrink-0 @2xl:w-60" />
          <div className="min-w-0 flex-1">
            <p className="eyebrow flex flex-wrap items-center gap-2"><MapPin aria-hidden className="size-3.5" />{t("Location file")}<IdChip>{code("LC", loc.id)}</IdChip></p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 max-w-full truncate text-xl font-semibold tracking-tight" title={loc.name}>{loc.name}</h1>
              {loc.locked ? <Badge tone="warn"><Lock className="size-3" />{t("Locked")}</Badge> : <Badge><LockOpen className="size-3" />{t("Unlocked")}</Badge>}
            </div>
            <p className="mono mt-1.5 text-xs text-mute">{items.length ? t("{n} images · {a} approved", { n: items.length, a: approvedN }) : t("No images yet")}</p>
          </div>
          {canProduce && (
            <div className="shrink-0">
              <Button variant={loc.locked ? "outline" : "secondary"} loading={locking} onClick={toggleLock} icon={loc.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}>
                {loc.locked ? t("Unlock") : t("Approve & lock")}
              </Button>
            </div>
          )}
        </div>
        <div className="overflow-hidden rounded-b-xl">
          <div className="-ml-px -mt-px flex flex-wrap">
            <div className="min-w-0 flex-1 basis-36 border-l border-t border-line">
              <Vital label={t("Images")} onClick={() => scrollToSection("sec-loc-images")}><span className="mono text-base font-medium">{items.length}</span></Vital>
            </div>
            <div className="min-w-0 flex-1 basis-36 border-l border-t border-line">
              <Vital label={t("Approved")} onClick={() => scrollToSection("sec-loc-images")}>
                <span className="mono text-base font-medium">{approvedN}<span className="text-dim"> / {items.length}</span></span>
                <Meter filled={m.filled} total={m.total} tone={approvedN ? "ok" : "neutral"} />
              </Vital>
            </div>
            <div className="min-w-0 flex-1 basis-36 border-l border-t border-line">
              <Vital label={t("Description")} onClick={() => scrollToSection("sec-loc-desc")}>
                <span className="mono text-base font-medium">{words}<span className="text-xs font-normal text-dim"> {t("words")}</span></span>
              </Vital>
            </div>
          </div>
        </div>
        {loc.locked && (
          <div className="flex items-start gap-2.5 border-t border-warn/25 bg-warn/6 px-4 py-2.5 text-xs text-amber-300 @2xl:px-5">
            <Lock className="mt-px size-3.5 shrink-0" />
            <p>{canProduce ? t("Locked and approved. Unlock it to change the description.") : t("Locked and approved by a producer. Ask a producer to unlock it before editing.")}</p>
          </div>
        )}
      </section>

      {/* images take the wide pane, the description sits in a sticky rail (and comes first when the page is narrow) */}
      <div className="@container">
        <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_20rem] @4xl:items-start">
          <div className="@container min-w-0 @4xl:col-start-2 @4xl:row-start-1 @4xl:sticky @4xl:top-4">
            <WorkPanel id="sec-loc-desc" n={1} kicker={t("Brief")} icon={<MapPin />} title={t("Description")} description={t("How the place looks. It is added to every prompt that happens here.")}>
              <RField label={t("Description")} htmlFor={`loc-desc-${loc.id}`}>
                <Textarea id={`loc-desc-${loc.id}`} rows={5} value={desc} disabled={!editable} onChange={(e) => setDesc(e.target.value)}
                  onBlur={async () => {
                    if (desc === loc.description_text) return;
                    try { await api.patch(`/api/locations/${loc.id}`, { description_text: desc }); refresh(); toast.success(tr("Description saved")); } catch { /* api toasts */ }
                  }} />
              </RField>
            </WorkPanel>
          </div>

          <div className="@container min-w-0 @4xl:col-start-1 @4xl:row-start-1">
            <WorkPanel id="sec-loc-images" n={2} kicker={t("Reference")} icon={<Images />} title={t("Images")}
              badge={items.length > 0 ? <span className="mono rounded bg-raised px-1.5 text-2xs font-medium text-dim">{items.length}</span> : undefined}
              description={t("Approved images become the look of this place in keyframes. Click an image to view it large.")}
              actions={canEdit && (
                <>
                  <div className="relative">
                    <Clock aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
                    <Input placeholder={t("time of day (optional)")} aria-label={t("time of day (optional)")} value={tod} onChange={(e) => setTod(e.target.value)} className="h-10! w-44! pl-8 text-xs! sm:h-8!" />
                  </div>
                  <Button size="sm" variant="primary" className="max-sm:h-10" icon={<Wand2 className="size-3.5" />} onClick={() => generate(["wide", "medium"])}>{t("Generate")}</Button>
                  <Button size="sm" className="max-sm:h-10" onClick={() => generate(["detail"])}>{t("Detail")}</Button>
                  <Button size="sm" className="max-sm:h-10" loading={uploading} icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>{t("Upload")}</Button>
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      setUploading(true);
                      try { await api.upload(`/api/locations/${loc.id}/upload`, f); refresh(); toast.success(tr("Photo added")); } catch { /* api toasts */ } finally { setUploading(false); }
                    }} />
                </>
              )}>
              {items.length || pendingTiles ? (
                <Gallery items={items} canEdit={canEdit} aspect="16 / 10" minTile={13} pending={pendingTiles}
                  onApprove={(it) => patchAsset(it.id, { approved: !it.approved })} onRemove={(it) => patchAsset(it.id, { archived: true })} />
              ) : (
                <RoomEmpty icon={<ImagePlus />} title={t("No images yet")} sub={t("Generate wide and medium views from the description, or upload a photo of the place.")} />
              )}
            </WorkPanel>
          </div>
        </div>
      </div>
    </div>
  );
}
