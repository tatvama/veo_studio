import { useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Trash2, UserRoundPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DropZone } from "../../pages/brand/DropZone";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import type { Character } from "../../lib/types";
import { Button, Input, Modal, Select, Textarea } from "../ui";

const IMAGES = ["image/png", "image/jpeg", "image/webp"];

/**
 * Create a character from your own photos in one step: who they are, how they look, and the photos that set the look.
 * Voices (pick, design or clone) are added on the character's page right after.
 */
export function NewCharacterModal({ open, onClose, projectId, onCreated, initialName = "" }: {
  open: boolean; onClose: () => void; projectId?: number; onCreated: (c: Character) => void; initialName?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(initialName);
  const [role, setRole] = useState("");
  const [gender, setGender] = useState("");
  const [age, setAge] = useState("");
  const [look, setLook] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  useEffect(() => { if (open) setName(initialName); }, [open, initialName]);

  const reset = () => { setName(""); setRole(""); setGender(""); setAge(""); setLook(""); setPhotos([]); };

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const c = await api.post<Character>("/api/characters", {
        name: name.trim(), role, gender, age, project_id: projectId ?? null,
        dna_text: look.trim() ? `${name.trim()}: ${look.trim()}` : "",
      });
      for (const f of photos) await api.upload(`/api/characters/${c.id}/upload`, f);
      qc.invalidateQueries({ queryKey: ["characters"] });
      toast.success(photos.length ? tr("{name} created with {n} photo(s)", { name: c.name, n: photos.length }) : tr("{name} created", { name: c.name }));
      reset();
      onCreated(c);
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={() => !busy && onClose()} size="lg"
      title={<span className="flex items-center gap-2"><UserRoundPlus className="size-4 text-accent-ink" />{t("New character")}</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
        <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>
          {photos.length ? t("Create with {n} photo(s)", { n: photos.length }) : t("Create character")}
        </Button>
      </>}>
      <div className="grid gap-5 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-mute">{t("Name")}</span>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. Ajji")} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-mute">{t("Role")}</span>
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t("e.g. grandmother, brand ambassador")} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-mute">{t("Gender")}</span>
              <Select value={gender} onChange={(e) => setGender(e.target.value)}>
                <option value="">—</option><option value="male">{t("male")}</option><option value="female">{t("female")}</option><option value="neutral">{t("neutral")}</option>
              </Select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-mute">{t("Age")}</span>
              <Input value={age} onChange={(e) => setAge(e.target.value)} placeholder="65" />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-mute">{t("Look (optional)")}</span>
            <Textarea rows={4} value={look} onChange={(e) => setLook(e.target.value)}
              placeholder={t("Face, hair, build, signature outfit, marks — e.g. silver hair in a low bun, round gold-rim glasses, green cotton saree")} />
            <span className="text-2xs text-dim">{t("Your photos matter most; this text helps keep details consistent.")}</span>
          </label>
        </div>
        <div className="space-y-2">
          <DropZone accept={IMAGES} maxMb={15} multiple onFiles={(fs) => setPhotos([...photos, ...fs].slice(0, 8))}
            icon={<ImagePlus className="size-5" />} title={t("Add photos of this person")}
            hint={t("Clear face (front, ¾ side) and one full body. Up to 8. These become the look reference for every shot.")} />
          {photos.length > 0 && (
            <div className="grid grid-cols-4 gap-2">
              {previews.map((u, i) => (
                <div key={u} className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-line">
                  <img src={u} alt="" className="size-full object-cover" />
                  {i === 0 && <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-2xs text-white">{t("main")}</span>}
                  <button type="button" aria-label={t("Remove photo")} onClick={() => setPhotos(photos.filter((_, k) => k !== i))}
                    className="absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="text-2xs text-dim">{t("Using a real person's face? Record their consent on the character page (Consent section).")}</p>
        </div>
      </div>
    </Modal>
  );
}
