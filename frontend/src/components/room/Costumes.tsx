import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Shirt, Star, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import type { SubmitResult } from "../../lib/types";
import { createCostume, deleteCostume, patchCostume, useCostumes, type CharacterV3, type Costume } from "../../lib/v3";
import { useGenerate } from "../Generate";
import { Badge, Button, IconButton, Input, Meter, Modal, Skeleton, Textarea, Toggle, rise } from "../ui";
import { EpisodeAxis, JobStrip, RangeBar, episodeTotal, rangeCode, scaleMeter } from "./cast";
import { LoadError, RField, RoomEmpty } from "./kit";
import { Gallery, type GalleryItem } from "./Lightbox";
import { OUTFIT_VIEWS, VIEW_LABEL, coversEpisode, episodeNumber, episodeRange } from "./look";
import { useCharScope } from "./scope";
import { useActiveJobs } from "./util";
import { IdChip, WorkPanel, code } from "./workspace";

interface CostumeForm { name: string; description: string; episode_from: string; episode_to: string; is_default: boolean; generate: boolean }
const emptyForm = (): CostumeForm => ({ name: "", description: "", episode_from: "", episode_to: "", is_default: false, generate: true });
const fromCostume = (c: Costume): CostumeForm => ({
  name: c.name, description: c.description, episode_from: c.episode_from?.toString() ?? "", episode_to: c.episode_to?.toString() ?? "",
  is_default: c.is_default, generate: false,
});

/** Named outfits of a character: an episode-coverage strip on top, then one editable card per outfit with its 3-angle turnaround. */
export function Costumes({ character, editable, index, n }: { character: CharacterV3; editable: boolean; index?: number; n?: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { project, projectId, episodeNumber: curEp } = useCharScope();
  const { submit } = useGenerate();
  const cid = character.id;
  const { data: costumes, isLoading, isError, refetch } = useCostumes(cid);
  const jobs = useActiveJobs(projectId, (j) => j.type === "character_outfit" && Number(j.payload?.character_id) === cid);
  const [modal, setModal] = useState<{ costume?: Costume; form: CostumeForm } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Costume | null>(null);
  const [busy, setBusy] = useState("");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["costumes", cid] });
    qc.invalidateQueries({ queryKey: ["character", cid] });
    qc.invalidateQueries({ queryKey: ["characters"] });
  };
  const assetPatch = async (aid: number, body: Record<string, unknown>) => {
    try { await api.patch(`/api/character-assets/${aid}`, body); refresh(); } catch { /* api toasts */ }
  };
  const generateViews = (c: Costume) => submit(async () => {
    const r = await createCostume(cid, { name: c.name, description: c.description, episode_from: c.episode_from, episode_to: c.episode_to,
      is_default: c.is_default, generate: true, views: [...OUTFIT_VIEWS], project_id: projectId ?? null });
    return (r.jobs as SubmitResult | undefined) ?? { batch_id: "", status: "nothing_to_do", total_usd: 0, jobs: [] };
  }, tr("Outfit {outfit} for {name}", { outfit: c.name, name: character.name }));

  const f = modal?.form;
  const fromN = f ? episodeNumber(f.episode_from) : null;
  const toN = f ? episodeNumber(f.episode_to) : null;
  const rangeBad = fromN != null && toN != null && toN < fromN;
  const canSubmit = !!f && !!f.name.trim() && !rangeBad && (!!modal?.costume || !f.generate || !!f.description.trim());

  const submitForm = async () => {
    if (!modal || !f || !canSubmit) return;
    const body = { name: f.name.trim(), description: f.description.trim(), episode_from: fromN, episode_to: toN, is_default: f.is_default };
    setBusy("modal");
    try {
      if (modal.costume) {
        await patchCostume(modal.costume.id, body);
        toast.success(tr("Outfit updated"));
      } else if (f.generate) {
        // money: goes through submit() so the outcome (queued / approval / proposed) is announced the standard way
        const r = await submit(async () => {
          const res = await createCostume(cid, { ...body, generate: true, views: [...OUTFIT_VIEWS], project_id: projectId ?? null });
          return (res.jobs as SubmitResult | undefined) ?? { batch_id: "", status: "nothing_to_do", total_usd: 0, jobs: [] };
        }, tr("Outfit {outfit} for {name}", { outfit: body.name, name: character.name }));
        if (!r) return;
      } else {
        await createCostume(cid, { ...body, generate: false, project_id: projectId ?? null });
        toast.success(tr("Outfit saved — generate its views whenever you're ready"));
      }
      refresh();
      setModal(null);
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const remove = async () => {
    if (!confirmDel) return;
    setBusy("delete");
    try {
      await deleteCostume(confirmDel.id);
      toast.success(tr("Outfit removed"));
      refresh();
      setConfirmDel(null);
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const list = costumes ?? [];
  const orphanJobs = jobs.filter((j) => !list.some((c) => c.name === j.payload?.outfit));
  const total = episodeTotal(project, list.map((c) => ({ from: c.episode_from, to: c.episode_to })));
  const modalTotal = episodeTotal(project, [...list.map((c) => ({ from: c.episode_from, to: c.episode_to })), { from: fromN, to: toN }]);
  const newOutfit = (
    <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setModal({ form: emptyForm() })}>{t("New outfit")}</Button>
  );

  return (
    <WorkPanel id="sec-costumes" index={index} n={n} kicker={t("Wardrobe")} icon={<Shirt />} title={t("Outfits")}
      badge={list.length > 0 ? <span className="mono rounded bg-raised px-1.5 text-2xs font-medium text-dim">{list.length}</span> : undefined}
      description={t("Named outfits with a 3-angle turnaround each (front, three-quarter, full body), so the clothes are known from every side. Assign them per shot or per scene.")}
      actions={editable && newOutfit}>
      <div className="space-y-4">
        {jobs.length > 0 && (
          <JobStrip label={jobs[0].message || jobs[0].label} progress={jobs[0].progress || 0}
            right={jobs.length > 1 ? t("{n} outfits in progress", { n: jobs.length }) : `${Math.round((jobs[0].progress || 0) * 100)}%`} />
        )}
        {isLoading ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))]" aria-busy="true">
            {[0, 1].map((i) => <div key={i} className="space-y-3 rounded-xl border border-line p-3"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-48" /><Skeleton className="h-36" /></div>)}
          </div>
        ) : isError ? (
          <LoadError what={t("Couldn't load the outfits")} onRetry={() => refetch()} />
        ) : !list.length && !orphanJobs.length ? (
          <RoomEmpty icon={<Shirt />} title={t("No outfits yet")}
            sub={t("The default look comes from the DNA. Add an outfit for a wedding, a uniform or a different season, and it gets its own 3-view turnaround.")}
            action={editable ? newOutfit : undefined} />
        ) : (
          <>
            {/* episode coverage: which outfit is worn in which episodes */}
            {list.length > 0 && total >= 1 && (
              <div className="rounded-lg border border-line bg-bg/40 p-3 @md:p-3.5">
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="eyebrow">{t("Episode coverage")}</p>
                  {curEp !== undefined && <span className="mono text-2xs text-accent-ink">{t("now")} · E{String(curEp).padStart(2, "0")}</span>}
                </div>
                <EpisodeAxis total={total} current={curEp} label={t("Episode coverage of each outfit")}
                  rows={list.map((c) => ({
                    key: c.id, from: c.episode_from, to: c.episode_to, tone: c.is_default ? "accent" : "neutral",
                    label: <span className="flex min-w-0 items-center gap-1">{c.is_default && <Star aria-hidden className="size-3 shrink-0 fill-current text-accent-ink" />}<span className="truncate" title={c.name}>{c.name}</span></span>,
                    meta: <span className="mono shrink-0 text-2xs text-dim">{rangeCode(c.episode_from, c.episode_to)}</span>,
                    sr: `${c.name}: ${episodeRange(c.episode_from, c.episode_to)}`,
                  }))} />
              </div>
            )}
            <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))]">
              {list.map((c, i) => {
                const r = rise(i);
                const job = jobs.find((j) => j.payload?.outfit === c.name);
                const planned = (job?.payload?.views as string[] | undefined)?.length ?? OUTFIT_VIEWS.length;
                const pending = job ? Math.max(0, planned - Math.round((job.progress || 0) * planned)) : 0;
                const items: GalleryItem[] = c.images.map((im) => ({ id: im.id, url: im.url, label: t(VIEW_LABEL[im.view] ?? im.label ?? im.view), approved: im.approved }));
                const inUse = coversEpisode(c.episode_from, c.episode_to, curEp);
                const m = scaleMeter(c.images.length, planned, 6);
                return (
                  <li key={c.id} {...r} className={cn("hud relative flex flex-col gap-3 rounded-xl border bg-bg/30 p-3", c.is_default ? "border-accent/40" : "border-line", r.className)}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-1.5">
                          <IdChip>{code("OF", c.id)}</IdChip>
                          <span className="truncate text-sm font-semibold" title={c.name}>{c.name}</span>
                          {c.is_default && <Badge tone="accent"><Star className="size-3" />{t("Default")}</Badge>}
                          {curEp !== undefined && inUse && !c.is_default && <Badge tone="info">{t("Ep {n}", { n: curEp })}</Badge>}
                        </p>
                        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-dim">
                          <span>{episodeRange(c.episode_from, c.episode_to)}</span>
                          <span aria-hidden>·</span>
                          <span className="mono">{t("{n} of {m} views", { n: c.images.length, m: planned })}</span>
                          <Meter filled={m.filled} total={m.total} tone={c.images.length >= planned ? "ok" : "accent"} className="w-12" />
                        </p>
                      </div>
                      {editable && (
                        <div className="flex shrink-0 items-center">
                          <IconButton title={t("Edit outfit")} className="size-9 sm:size-7" onClick={() => setModal({ costume: c, form: fromCostume(c) })}><Pencil className="size-3.5" /></IconButton>
                          <IconButton title={t("Delete outfit")} className="size-9 hover:bg-bad/10! hover:text-bad! sm:size-7" onClick={() => setConfirmDel(c)}><Trash2 className="size-3.5" /></IconButton>
                        </div>
                      )}
                    </div>
                    {c.description ? <p className="line-clamp-2 text-xs leading-relaxed text-mute" title={c.description}>{c.description}</p>
                      : <p className="text-xs text-dim">{t("No description — add one so the turnaround knows what to draw.")}</p>}
                    {items.length || pending ? (
                      <Gallery items={items} canEdit={editable} aspect="3 / 4" minTile={5} pending={pending} className="gap-2"
                        onApprove={(it) => void assetPatch(it.id, { approved: !it.approved })} onRemove={(it) => void assetPatch(it.id, { archived: true })} />
                    ) : (
                      <div className="rm-scan flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-line px-3 py-2.5">
                        <span className="text-xs text-mute">{t("No images yet")}</span>
                        {editable && <Button size="sm" icon={<Wand2 className="size-3.5" />} disabled={!c.description} title={c.description ? undefined : t("Add a description first")}
                          onClick={() => void generateViews(c)}>{t("Generate 3 views")}</Button>}
                      </div>
                    )}
                    {editable && !c.is_default && (
                      <div className="mt-auto flex justify-end">
                        <Button size="sm" variant="ghost" icon={<Star className="size-3.5" />} loading={busy === `default-${c.id}`} onClick={async () => {
                          setBusy(`default-${c.id}`);
                          try { await patchCostume(c.id, { is_default: true }); refresh(); toast.success(tr("{name} is now the default outfit", { name: c.name })); } catch { /* api toasts */ } finally { setBusy(""); }
                        }}>{t("Set as default")}</Button>
                      </div>
                    )}
                  </li>
                );
              })}
              {orphanJobs.map((j, i) => {
                const r = rise(list.length + i);
                const planned = (j.payload?.views as string[] | undefined)?.length ?? OUTFIT_VIEWS.length;
                return (
                  <li key={`job-${j.id}`} {...r} className={cn("flex flex-col gap-3 rounded-xl border border-line bg-bg/30 p-3", r.className)}>
                    <p className="truncate text-sm font-semibold">{String(j.payload?.outfit ?? j.label)}</p>
                    <p className="flex items-center gap-1.5 text-2xs text-dim"><span aria-hidden className="eq"><i /><i /><i /><i /></span>{t("Generating…")}</p>
                    <Gallery items={[]} canEdit={false} aspect="3 / 4" minTile={5} pending={planned} className="gap-2" />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* new / edit */}
      <Modal open={!!modal} onClose={() => busy !== "modal" && setModal(null)}
        title={modal?.costume ? t("Edit outfit — {name}", { name: modal.costume.name }) : t("New outfit for {name}", { name: character.name })}
        footer={<>
          <Button variant="ghost" onClick={() => setModal(null)} disabled={busy === "modal"}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy === "modal"} disabled={!canSubmit} onClick={submitForm}
            icon={!modal?.costume && f?.generate ? <Wand2 className="size-4" /> : undefined}>
            {modal?.costume ? t("Save") : f?.generate ? t("Create & generate") : t("Create")}
          </Button>
        </>}>
        {f && (
          <div className="space-y-3">
            <RField label={t("Outfit name")} htmlFor="costume-name">
              <Input id="costume-name" data-autofocus value={f.name} placeholder={t("Wedding outfit")} onChange={(e) => setModal({ ...modal!, form: { ...f, name: e.target.value } })} />
            </RField>
            <RField label={t("Description")} htmlFor="costume-desc" hint={t("Assign it to shots in the Storyboard (or ask the Director: 'Ravi wears his wedding outfit in this episode')")}>
              <Textarea id="costume-desc" value={f.description} placeholder={t("Silk cream sherwani with gold embroidery, maroon stole, mojari shoes")}
                onChange={(e) => setModal({ ...modal!, form: { ...f, description: e.target.value } })} />
            </RField>
            <div className="grid grid-cols-2 gap-3">
              <RField label={t("From episode")} htmlFor="costume-from" hint={t("Blank = every episode")}>
                <Input id="costume-from" type="number" min={1} inputMode="numeric" value={f.episode_from} placeholder="1" className="mono" onChange={(e) => setModal({ ...modal!, form: { ...f, episode_from: e.target.value } })} />
              </RField>
              <RField label={t("To episode")} htmlFor="costume-to" hint={rangeBad ? <span className="text-amber-300">{t("Must not be before the first episode")}</span> : t("Blank = open-ended")}>
                <Input id="costume-to" type="number" min={1} inputMode="numeric" value={f.episode_to} placeholder="—" className="mono" onChange={(e) => setModal({ ...modal!, form: { ...f, episode_to: e.target.value } })} />
              </RField>
            </div>
            {modalTotal >= 1 && !rangeBad && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2"><span className="eyebrow">{t("Episode coverage")}</span><span className="mono text-2xs text-dim">{rangeCode(fromN, toN)}</span></div>
                <RangeBar total={modalTotal} from={fromN} to={toN} current={curEp} tone="accent" />
              </div>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
              <Toggle checked={f.is_default} onChange={(v) => setModal({ ...modal!, form: { ...f, is_default: v } })} label={<span className="text-xs">{t("Default outfit (worn when a shot sets none)")}</span>} />
              {!modal?.costume && (
                <Toggle checked={f.generate} onChange={(v) => setModal({ ...modal!, form: { ...f, generate: v } })} label={<span className="text-xs">{t("Generate 3-angle turnaround now")}</span>} />
              )}
            </div>
            {!modal?.costume && f.generate && !f.description.trim() && <p className="text-2xs text-amber-300">{t("A description is needed to generate the turnaround.")}</p>}
          </div>
        )}
      </Modal>

      {/* delete */}
      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title={t("Delete outfit {name}?", { name: confirmDel?.name ?? "" })}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmDel(null)}>{t("Cancel")}</Button>
          <Button variant="danger" loading={busy === "delete"} onClick={remove} icon={<Trash2 className="size-4" />}>{t("Delete outfit")}</Button>
        </>}>
        <p className="text-sm text-mute">{t("Its images stay in the reference pack; shots that already use this outfit keep its name. You can't undo this.")}</p>
      </Modal>
    </WorkPanel>
  );
}
