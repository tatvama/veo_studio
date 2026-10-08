import { FileCheck, FileText, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, Field, IconButton, Input, Modal, Select, Textarea } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { useCharacters, useProjects } from "../../../lib/queries";
import type { ConsentRow } from "../../../lib/types";
import { DropZone } from "../../brand/DropZone";
import { CONSENT_KINDS } from "./meta";

const FILE_TYPES = [
  "application/pdf", "image/*", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export function ConsentModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { data: projects } = useProjects();
  const [castFrom, setCastFrom] = useState<number | 0>(0);
  const { data: cast } = useCharacters(castFrom || undefined);
  const blank = { kind: "voice_replication", subject_name: "", character_id: "", scope: "", expires_on: "" };
  const [form, setForm] = useState(blank);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof blank, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const close = () => {
    setForm(blank);
    setFile(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.subject_name.trim()) return void toast.error(t("Enter who gave consent"));
    if (file && file.size > 25 * 1024 * 1024) return void toast.error(t("That file is too large (max 25 MB)"));
    const fd = new FormData();
    fd.append("kind", form.kind);
    fd.append("subject_name", form.subject_name.trim());
    fd.append("scope", form.scope.trim());
    fd.append("expires_on", form.expires_on);
    if (form.character_id) fd.append("character_id", form.character_id);
    if (file) fd.append("file", file);
    setBusy(true);
    try {
      await api.post<ConsentRow>("/api/consents", fd);
      onSaved();
      toast.success(t("Consent recorded for {name}", { name: form.subject_name.trim() }));
      close();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title={t("Record consent")} size="lg"
      footer={<>
        <Button variant="ghost" onClick={close}>{t("Cancel")}</Button>
        <Button variant="primary" type="submit" form="consent-form" loading={busy} icon={<FileCheck className="size-4" />}>{t("Save consent")}</Button>
      </>}>
      <form id="consent-form" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Type")}>
            <Select value={form.kind} onChange={(e) => set("kind", e.target.value)}>
              {Object.entries(CONSENT_KINDS).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            </Select>
          </Field>
          <Field label={t("Person or rights holder")}>
            <Input required data-autofocus value={form.subject_name} onChange={(e) => set("subject_name", e.target.value)} placeholder={t("Full name")} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Find character in")}>
            <Select value={castFrom} onChange={(e) => { setCastFrom(Number(e.target.value)); set("character_id", ""); }}>
              <option value={0}>{t("Shared library")}</option>
              {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </Select>
          </Field>
          <Field label={t("Character (optional)")} hint={t("Link the consent to the character whose voice or face it covers.")}>
            <Select value={form.character_id} onChange={(e) => set("character_id", e.target.value)}>
              <option value="">{t("None")}</option>
              {(cast ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label={t("Scope")} hint={t("What it covers: languages, platforms, territories, how long, any limits.")}>
          <Textarea value={form.scope} onChange={(e) => set("scope", e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <Field label={t("Expires on")} hint={t("Leave blank if it doesn't expire.")}>
            <Input type="date" value={form.expires_on} onChange={(e) => set("expires_on", e.target.value)} />
          </Field>
          <div>
            <p className="mb-1.5 text-xs font-medium text-mute">{t("Signed document")}</p>
            {file ? (
              <div className="flex h-[74px] items-center gap-3 rounded-xl border border-line bg-raised/40 px-3.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent-ink"><FileText className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{file.name}</span>
                  <span className="block text-2xs text-dim">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                </span>
                <IconButton title={t("Remove file")} onClick={() => setFile(null)}><X className="size-4" /></IconButton>
              </div>
            ) : (
              <DropZone compact accept={FILE_TYPES} maxMb={25} onFiles={(f) => setFile(f[0] ?? null)}
                title={t("Drop the signed release here")} hint={t("PDF, image or Word file · up to 25 MB")} />
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
