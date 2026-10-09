import { useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, Loader2, Minus, Package, PenLine, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import { addPropToProject, createProp, patchProp, removePropFromProject, uploadPropImage, useProps, type Prop } from "../../lib/v3";
import { LoadError, RoomEmpty } from "../room/kit";
import { IdChip, WorkPanel, code } from "../room/workspace";
import { Button, Field, IconButton, Input, Modal, SearchField, Segmented, Skeleton, StatusDot, Textarea, Toggle, rise } from "../ui";
import "../../styles/board.css";

type Filter = "project" | "library" | "all";

const GRID = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,13.5rem),1fr))]";

/** Props: a toolbar (filter, search, add) over a grid of tiles with a reference image, id, status and hover actions. */
export function PropsTab({ pid, canEdit }: { pid: number; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useProps(pid);
  const [filter, setFilter] = useState<Filter>("project");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Prop | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["props"] });

  if (isError && !data) return <LoadError what={t("Couldn't load the props")} onRetry={() => refetch()} />;
  if (isLoading || !data) return <PropsSkeleton />;

  const all = data;
  const inProject = all.filter((p) => p.in_project);
  const library = all.filter((p) => !p.in_project);
  const base = filter === "project" ? inProject : filter === "library" ? library : all;
  const needle = q.trim().toLowerCase();
  const list = needle ? base.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(needle)) : base;

  const toggleProject = async (p: Prop) => {
    setBusy(p.id);
    try {
      if (p.in_project) { await removePropFromProject(pid, p.id); toast.success(tr("{name} removed from the project", { name: p.name })); }
      else { await addPropToProject(pid, p.id); toast.success(tr("{name} added to the project", { name: p.name })); }
      await refresh();
    } catch { /* api toasts */ } finally { setBusy(null); }
  };
  const upload = async (p: Prop, file: File) => {
    setBusy(p.id);
    try { await uploadPropImage(p.id, file); await refresh(); toast.success(tr("Image uploaded")); } catch { /* api toasts */ } finally { setBusy(null); }
  };

  const count = (n: number) => <span className="mono ml-1 text-2xs text-dim">{n}</span>;

  return (
    <>
      <WorkPanel icon={<Package />} kicker={t("Reference objects")} title={t("Props")}
        badge={<span className="mono text-2xs font-normal text-dim">{inProject.length} / {all.length}</span>}
        description={t("Objects that must look the same in every shot: a lamp, a letter, a sword. Mention them in scripts with @.")}
        actions={canEdit && !!all.length && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t("Add prop")}</Button>}>
        <div className="space-y-4">
          {!!all.length && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line pb-4">
              <Segmented size="sm" value={filter} onChange={setFilter} aria-label={t("Which props")} options={[
                { value: "project", label: <>{t("In project")}{count(inProject.length)}</> },
                { value: "library", label: <>{t("Library")}{count(library.length)}</> },
                { value: "all", label: <>{t("All")}{count(all.length)}</> },
              ]} />
              <SearchField value={q} onChange={setQ} placeholder={t("Search props")} className="w-full @md:w-60" aria-label={t("Search props")} />
              <span className="flex-1" />
              <span className="mono text-2xs text-dim" aria-live="polite">{list.length} / {base.length}</span>
            </div>
          )}

          {!all.length ? (
            <RoomEmpty icon={<Package />} title={t("No props yet")}
              sub={t("Props are objects that must look the same in every shot: a lamp, a letter, a sword. Give each a reference image and mention it in scripts with @.")}
              action={canEdit ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t("Add the first prop")}</Button> : undefined} />
          ) : !list.length ? (
            <RoomEmpty icon={<Package />} title={needle ? t("No props match") : filter === "project" ? t("No props in this project") : t("Nothing in the library")}
              sub={filter === "project" && library.length ? t("Pick from the shared library or add a new prop.") : undefined}
              action={filter === "project" && library.length ? <Button size="sm" onClick={() => setFilter("library")}>{t("Browse the library")}</Button> : undefined} />
          ) : (
            <ul className={GRID}>
              {list.map((p, i) => (
                <PropTile key={p.id} p={p} index={i} canEdit={canEdit} busy={busy === p.id}
                  onEdit={() => setEditing(p)} onToggle={() => toggleProject(p)} onUpload={(f) => upload(p, f)} />
              ))}
            </ul>
          )}
        </div>
      </WorkPanel>

      <PropModal open={adding} pid={pid} onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />
      <PropModal open={!!editing} pid={pid} prop={editing ?? undefined} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); }} />
    </>
  );
}

/** One prop: reference image with its id and status over it, name and description under it, add-to-project below. */
function PropTile({ p, index, canEdit, busy, onEdit, onToggle, onUpload }: {
  p: Prop; index: number; canEdit: boolean; busy: boolean; onEdit: () => void; onToggle: () => void; onUpload: (f: File) => void;
}) {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const r = rise(index);
  const status = p.in_project ? { tone: "ok" as const, text: t("in project") } : p.shared ? { tone: "neutral" as const, text: t("library") } : null;
  return (
    <li {...r} className={cn("bd-tile hud group/tile relative flex min-w-0 flex-col rounded-xl border border-line bg-panel transition-colors hover:border-dim/60", r.className)}>
      <div className={cn("relative aspect-[4/3] rounded-t-[9px]", busy && "gen-ring")}>
        <div className="rm-scan absolute inset-0 overflow-hidden rounded-[inherit] bg-raised">
          {p.url ? <img src={p.url} alt="" loading="lazy" className="size-full object-cover" />
            : <div className="grid size-full place-items-center text-dim"><Package className="size-7" /></div>}
        </div>
        <IdChip className="absolute left-1.5 top-1.5 border-white/15 bg-black/60 text-white backdrop-blur-sm">{code("PR", p.id)}</IdChip>
        {status && (
          <span className="absolute right-1.5 top-1.5 inline-flex h-5 items-center gap-1.5 rounded-md bg-black/60 px-1.5 text-2xs font-medium text-white backdrop-blur-sm">
            <StatusDot tone={status.tone} />{status.text}
          </span>
        )}
        {canEdit && (
          <>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-hidden tabIndex={-1}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
            <div className="bd-act absolute bottom-1.5 right-1.5 flex gap-1">
              <IconButton title={p.url ? t("Replace image") : t("Upload image")} className="bg-black/55 text-white hover:bg-black/70 hover:text-white pointer-coarse:size-10" disabled={busy} onClick={() => file.current?.click()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              </IconButton>
              <IconButton title={t("Edit")} className="bg-black/55 text-white hover:bg-black/70 hover:text-white pointer-coarse:size-10" onClick={onEdit}><PenLine className="size-4" /></IconButton>
            </div>
          </>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="truncate text-sm font-medium" title={p.name}>{p.name}</p>
        <p className="line-clamp-2 min-h-8 text-xs leading-snug text-mute">{p.description || t("No description")}</p>
        {canEdit && (
          <div className="mt-2">
            <Button size="sm" variant={p.in_project ? "ghost" : "secondary"} block loading={busy} className="pointer-coarse:h-10"
              icon={p.in_project ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />} onClick={onToggle}>
              {p.in_project ? t("Remove from project") : t("Add to project")}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/** Create (no `prop`) or edit a prop: name, description, shared; a new prop can be added to the project straight away. */
function PropModal({ open, pid, prop, onClose, onDone }: { open: boolean; pid: number; prop?: Prop; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [shared, setShared] = useState(true);
  const [toProject, setToProject] = useState(true);
  const [saving, setSaving] = useState(false);
  // seed the form each time it opens (edit → the prop's values; new → blanks)
  useEffect(() => {
    if (!open) return;
    setName(prop?.name ?? ""); setDesc(prop?.description ?? ""); setShared(prop?.shared ?? true); setToProject(true);
  }, [open, prop?.id, prop?.name, prop?.description, prop?.shared]);

  const save = async () => {
    const n = name.trim();
    if (!n) return void toast.error(tr("Give the prop a name"));
    setSaving(true);
    try {
      if (prop) { await patchProp(prop.id, { name: n, description: desc, shared }); toast.success(tr("Prop saved")); }
      else { await createProp({ name: n, description: desc, shared, project_id: toProject ? pid : null }); toast.success(tr("{name} added", { name: n })); }
      onDone();
    } catch { /* api toasts */ } finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} size="sm"
      title={<span className="flex items-center gap-2">{prop ? t("Edit prop") : t("New prop")}{prop && <IdChip>{code("PR", prop.id)}</IdChip>}</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>{t("Cancel")}</Button>
        <Button variant="primary" loading={saving} icon={<Check className="size-4" />} onClick={save}>{prop ? t("Save") : t("Add prop")}</Button>
      </>}>
      <div className="space-y-4">
        <Field label={t("Name")}>
          <Input value={name} data-autofocus onChange={(e) => setName(e.target.value)} placeholder={t("e.g. brass lamp")} onKeyDown={(e) => e.key === "Enter" && save()} />
        </Field>
        <Field label={t("Description")} hint={t("What it looks like, so every keyframe draws the same object.")}>
          <Textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <div className="space-y-2.5 rounded-lg border border-line bg-raised/30 p-3">
          <Toggle checked={shared} onChange={setShared} label={<span className="text-sm">{t("Share in the library (other projects can use it)")}</span>} />
          {!prop && <Toggle checked={toProject} onChange={setToProject} label={<span className="text-sm">{t("Add to this project now")}</span>} />}
        </div>
        {prop && !prop.url && <p className="text-xs text-dim">{t("Upload a reference image from the card's hover actions.")}</p>}
      </div>
    </Modal>
  );
}

function PropsSkeleton() {
  return (
    <div className="hud relative rounded-xl border border-line bg-panel p-5" aria-busy="true">
      <Skeleton className="mb-1.5 h-3 w-24" /><Skeleton className="mb-5 h-4 w-32" />
      <div className="mb-4 flex gap-2 border-b border-line pb-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-9 w-56" /></div>
      <div className={GRID}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border border-line bg-panel">
            <Skeleton className="aspect-[4/3] rounded-none!" />
            <div className="space-y-2 p-3"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
