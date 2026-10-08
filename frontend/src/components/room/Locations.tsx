import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Clock, ImagePlus, Images, Lock, LockOpen, MapPin, PencilLine, Plus, Sparkles, Upload, Wand2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import { useLocations } from "../../lib/queries";
import type { Location, SubmitResult } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { useGenerate } from "../Generate";
import { Badge, Button, Input, Skeleton, Textarea, rise } from "../ui";
import { DetailBar, LoadError, RField, RoomEmpty, SectionCard } from "./kit";
import { useActiveJobs } from "./util";
import { Gallery, type GalleryItem } from "./Lightbox";

const GRID = "grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))]";
const cover = (l: Location) => l.thumb_url || l.assets?.find((a) => a.approved)?.url || l.assets?.[0]?.url || "";

/** Locations as cards; open one to edit its description and generate / upload place images. */
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
    if (isLoading) return <div className="space-y-5" aria-busy="true"><DetailBar backLabel={t("Locations")} onBack={onBack} /><Skeleton className="h-40 !rounded-xl" /><Skeleton className="h-56 !rounded-xl" /></div>;
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
          <div key={i} className="overflow-hidden rounded-xl border border-line bg-panel"><Skeleton className="aspect-[16/10] !rounded-none" /><div className="space-y-2 p-3"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-2/3" /></div></div>
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
        <div className={GRID}>
          {list.map((l, i) => <LocationCard key={l.id} loc={l} index={i} onOpen={() => onOpen(l.id)} />)}
          {canEdit && (
            <form {...rise(list.length)} onSubmit={add}
              className={clsx("flex min-h-[13rem] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line p-4 text-center transition-colors focus-within:border-accent/50 hover:border-dim/60", rise(list.length).className)}>
              <span className="grid size-10 place-items-center rounded-full border border-line bg-raised text-mute"><Plus className="size-5" /></span>
              <p className="text-sm font-medium">{t("New location")}</p>
              <Input placeholder={t("New location name")} aria-label={t("New location name")} value={name} onChange={(e) => setName(e.target.value)} className="text-center" />
              <Button type="submit" size="sm" disabled={!name.trim()} loading={adding} icon={<Plus className="size-3.5" />}>{t("Add")}</Button>
            </form>
          )}
        </div>
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
  return (
    <div {...r}>
      <button type="button" onClick={onOpen} aria-label={loc.name}
        className={clsx("group lift flex h-full w-full flex-col overflow-hidden rounded-xl border bg-panel text-left hover:border-accent/50", loc.locked ? "border-warn/35" : "border-line")}>
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-raised">
          {img ? <img src={img} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.05]" /> : (
            <div className="grid size-full place-items-center bg-gradient-to-br from-accent/10 via-raised to-bg text-dim"><MapPin className="size-9" /></div>
          )}
          <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-1 text-2xs font-medium leading-none text-white shadow-card backdrop-blur [&>svg]:size-3">
            {loc.locked ? <><Lock className="text-warn" />{t("Locked")}</> : <><PencilLine />{t("Draft")}</>}
          </span>
          <p className="absolute inset-x-0 bottom-0 truncate p-3 text-base font-semibold leading-tight text-white" title={loc.name}>{loc.name}</p>
        </div>
        <div className="flex flex-1 flex-col gap-2 px-3 py-2.5">
          <p className="line-clamp-2 min-h-8 text-xs leading-relaxed text-mute">{loc.description_text || t("No description yet.")}</p>
          <p className="flex items-center gap-1 text-2xs tabular-nums text-dim"><Images className="size-3" />{n ? t("{n} images · {a} approved", { n, a: approved }) : t("No images yet")}</p>
        </div>
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

  return (
    <div className="space-y-5">
      <DetailBar backLabel={t("Locations")} onBack={onBack} name={loc.name} pos={pos} />

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex flex-col gap-4 p-4 @2xl:flex-row @2xl:items-center @2xl:gap-5 @2xl:p-5">
          <div className="relative aspect-[16/10] w-full shrink-0 overflow-hidden rounded-xl border border-line bg-raised @2xl:w-56">
            {img ? <img src={img} alt={loc.name} className="size-full object-cover" /> : <div className="grid size-full place-items-center bg-gradient-to-br from-accent/10 via-raised to-bg text-dim"><MapPin className="size-9" /></div>}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 max-w-full truncate text-xl font-semibold tracking-tight" title={loc.name}>{loc.name}</h1>
              {loc.locked ? <Badge tone="warn"><Lock className="size-3" />{t("Locked")}</Badge> : <Badge><LockOpen className="size-3" />{t("Unlocked")}</Badge>}
            </div>
            <p className="mt-1 text-sm text-mute">{items.length ? t("{n} images · {a} approved", { n: items.length, a: items.filter((i) => i.approved).length }) : t("No images yet")}</p>
          </div>
          {canProduce && (
            <div className="shrink-0">
              <Button variant={loc.locked ? "outline" : "secondary"} loading={locking} onClick={toggleLock} icon={loc.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}>
                {loc.locked ? t("Unlock") : t("Approve & lock")}
              </Button>
            </div>
          )}
        </div>
        {loc.locked && (
          <div className="flex items-start gap-2.5 border-t border-warn/25 bg-warn/6 px-4 py-2.5 text-xs text-amber-300 @2xl:px-5">
            <Lock className="mt-px size-3.5 shrink-0" />
            <p>{canProduce ? t("Locked and approved. Unlock it to change the description.") : t("Locked and approved by a producer. Ask a producer to unlock it before editing.")}</p>
          </div>
        )}
      </div>

      <SectionCard icon={<MapPin />} title={t("Description")} description={t("How the place looks. It is added to every prompt that happens here.")}>
        <RField label={t("Description")} htmlFor={`loc-desc-${loc.id}`}>
          <Textarea id={`loc-desc-${loc.id}`} rows={3} value={desc} disabled={!editable} onChange={(e) => setDesc(e.target.value)}
            onBlur={async () => {
              if (desc === loc.description_text) return;
              try { await api.patch(`/api/locations/${loc.id}`, { description_text: desc }); refresh(); toast.success(tr("Description saved")); } catch { /* api toasts */ }
            }} />
        </RField>
      </SectionCard>

      <SectionCard icon={<Images />} title={t("Images")} description={t("Approved images become the look of this place in keyframes. Click an image to view it large.")}
        actions={canEdit && (
          <>
            <div className="relative">
              <Clock aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
              <Input placeholder={t("time of day (optional)")} aria-label={t("time of day (optional)")} value={tod} onChange={(e) => setTod(e.target.value)} className="h-8! w-44! pl-8 text-xs!" />
            </div>
            <Button size="sm" variant="primary" icon={<Wand2 className="size-3.5" />} onClick={() => generate(["wide", "medium"])}>{t("Generate")}</Button>
            <Button size="sm" onClick={() => generate(["detail"])}>{t("Detail")}</Button>
            <Button size="sm" loading={uploading} icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>{t("Upload")}</Button>
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
      </SectionCard>
    </div>
  );
}
