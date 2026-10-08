import { useQueryClient } from "@tanstack/react-query";
import { Clapperboard, ImagePlus, Lock, Palette, Plus, Type } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Notice } from "../components/growth/common";
import { Button, Empty, Field, Input, Modal, Page, PageHeader, Skeleton, rise } from "../components/ui";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useAuthStatus, useBrandKits, useProjects } from "../lib/queries";
import { ROLE_RANK, type BrandKit } from "../lib/types";
import { KitEditor } from "./brand/KitEditor";
import { KitList } from "./brand/KitList";

function NewKitModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (k: BrandKit) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setName(""); }, [open]);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const k = await api.post<BrandKit>("/api/brand-kits", {
        name: name.trim(), colors: ["#111111", "#F97316"], fonts: { heading: "Poppins", body: "Inter" },
        end_card: { enabled: true, seconds: 3, text: "" },
      });
      await qc.invalidateQueries({ queryKey: ["brand-kits"] });
      toast.success(t("Brand kit “{name}” created", { name: k.name }));
      onCreated(k);
      onClose();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("New brand kit")} size="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="primary" type="submit" form="new-kit" loading={busy} disabled={!name.trim()} icon={<Plus className="size-4" />}>{t("Create kit")}</Button>
      </>}>
      <form id="new-kit" onSubmit={create}>
        <Field label={t("Name")} hint={t("Usually the brand, client or channel name.")}>
          <Input autoFocus data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. Sai Studios")} maxLength={160} />
        </Field>
      </form>
    </Modal>
  );
}

/** First-run state: says what a kit is for and offers the one next step. */
function EmptyKits({ canEdit, onNew }: { canEdit: boolean; onNew: () => void }) {
  const t = useT();
  const perks = [
    { icon: <ImagePlus className="size-4" />, title: t("Logo and colours"), text: t("Drop in the logo and pick the brand palette once.") },
    { icon: <Type className="size-4" />, title: t("Fonts and voice"), text: t("Keep headings, captions and tone of voice consistent.") },
    { icon: <Clapperboard className="size-4" />, title: t("Branded end card"), text: t("Every final render closes with your logo and call to action.") },
  ];
  return (
    <div>
      <Empty icon={<Palette className="size-8" />} title={t("No brand kits yet")}
        sub={t("Create one per brand or client: logo, colours, fonts, tagline and call to action. Then pick it on a project's Export page.")}
        action={canEdit ? <Button variant="primary" size="lg" icon={<Plus className="size-4" />} onClick={onNew}>{t("Create your first kit")}</Button> : undefined} />
      <ul className="mt-5 grid gap-3 sm:grid-cols-3">
        {perks.map((p, i) => {
          const r = rise(i + 2);
          return (
            <li key={p.title} className={`rounded-xl border border-line bg-panel p-4 ${r.className}`} style={r.style}>
              <span className="grid size-8 place-items-center rounded-lg bg-accent/12 text-accent-ink">{p.icon}</span>
              <p className="mt-3 text-sm font-semibold">{p.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-mute">{p.text}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function BrandKitsPage() {
  const t = useT();
  const { data: auth } = useAuthStatus();
  const role = auth?.user?.role ?? "viewer";
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.creator;
  const canDelete = ROLE_RANK[role] >= ROLE_RANK.producer;
  const { data: kits, isLoading } = useBrandKits();
  const { data: projects } = useProjects();
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const list = kits ?? [];
  const kit = list.find((k) => k.id === selected) ?? list[0];

  return (
    <Page width="wide">
      <PageHeader
        icon={<Palette className="size-5" />}
        title={t("Brand kits")}
        subtitle={t("Logos, colours, fonts and voice for each brand or client. A project's kit adds a branded end card to its final renders.")}
        actions={canEdit && list.length > 0 ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t("New kit")}</Button> : undefined}
      />

      {!canEdit && (
        <Notice tone="info" icon={<Lock className="mt-0.5 size-4 shrink-0 text-info" />} className="mb-5">
          {t("You're viewing brand kits read-only. Creators and above can change them.")}
        </Notice>
      )}

      {isLoading ? (
        <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)] 2xl:grid-cols-[260px_minmax(0,1fr)]">
          <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[84px] rounded-xl" />)}</div>
          <div className="space-y-5"><Skeleton className="h-20 rounded-xl" /><Skeleton className="h-48 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>
        </div>
      ) : !list.length ? (
        <EmptyKits canEdit={canEdit} onNew={() => setCreating(true)} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)] 2xl:grid-cols-[260px_minmax(0,1fr)]">
          <KitList kits={list} selectedId={kit?.id} onSelect={setSelected} onNew={() => setCreating(true)} canEdit={canEdit} projects={projects} />
          <div className="min-w-0">
            <AnimatePresence mode="wait" initial={false}>
              {kit && (
                <motion.div key={kit.id} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}>
                  <KitEditor kit={kit} canEdit={canEdit} canDelete={canDelete} onDeleted={() => setSelected(null)} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}

      {canEdit && <NewKitModal open={creating} onClose={() => setCreating(false)} onCreated={(k) => setSelected(k.id)} />}
    </Page>
  );
}
