import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AudioLines, FileSignature, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DropZone } from "../../pages/brand/DropZone";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import type { Character } from "../../lib/types";
import { Alert, Button, Input, Modal, Toggle } from "../ui";

const AUDIO = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/webm", "audio/flac", "audio/x-flac"];

/**
 * Clone a real person's voice from short recordings (ElevenLabs instant clone) and make it this character's voice.
 * The speaker's permission is required and recorded as a consent (with the signed release, if attached).
 */
export function CloneVoiceModal({ open, onClose, character, languages }: {
  open: boolean; onClose: () => void; character: Character; languages: string[];
}) {
  const t = useT();
  const qc = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [subject, setSubject] = useState("");
  const [scope, setScope] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [release, setRelease] = useState<File | null>(null);
  const [langs, setLangs] = useState<string[]>(languages);
  const [denoise, setDenoise] = useState(true);
  const [busy, setBusy] = useState(false);
  // languages arrive with settings; start from the current list each time the dialog opens
  useEffect(() => { if (open) setLangs(languages); }, [open, languages.join(",")]);

  const totalMb = files.reduce((a, f) => a + f.size, 0) / 1024 / 1024;
  const ready = files.length > 0 && subject.trim() && confirmed && langs.length > 0;

  const go = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      fd.append("subject_name", subject.trim());
      fd.append("consent_confirmed", "true");
      fd.append("consent_scope", scope.trim());
      fd.append("languages", langs.join(","));
      fd.append("remove_noise", String(denoise));
      if (release) fd.append("release", release);
      await api.post(`/api/characters/${character.id}/voices/clone`, fd);
      qc.invalidateQueries({ queryKey: ["character", character.id] });
      qc.invalidateQueries({ queryKey: ["characters"] });
      qc.invalidateQueries({ queryKey: ["consents"] });
      toast.success(tr("{name} now speaks with the cloned voice", { name: character.name }));
      setFiles([]); setConfirmed(false); setRelease(null);
      onClose();
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={() => !busy && onClose()} size="lg"
      title={<span className="flex items-center gap-2"><AudioLines className="size-4 text-accent-ink" />{t("Clone a real voice for {name}", { name: character.name })}</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
        <Button variant="primary" loading={busy} disabled={!ready} icon={<ShieldCheck className="size-4" />} onClick={go}>{t("Clone voice")}</Button>
      </>}>
      <div className="space-y-4">
        <DropZone accept={AUDIO} maxMb={25} multiple busy={busy} onFiles={(fs) => setFiles([...files, ...fs].slice(0, 5))}
          icon={<AudioLines className="size-5" />} title={t("Drop 1–5 voice recordings")}
          hint={t("1–3 minutes in total of one person speaking clearly, no music or other voices. MP3, WAV, M4A, OGG.")} />
        {files.length > 0 && (
          <ul className="space-y-1">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs">
                <AudioLines className="size-3.5 text-dim" /><span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="tabular-nums text-dim">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                <button type="button" aria-label={t("Remove")} onClick={() => setFiles(files.filter((_, k) => k !== i))}
                  className="grid size-6 place-items-center rounded text-dim hover:bg-bad/10 hover:text-bad"><Trash2 className="size-3.5" /></button>
              </li>
            ))}
            {totalMb > 60 && <li className="text-2xs text-bad">{t("Too large in total (max 60 MB)")}</li>}
          </ul>
        )}

        <div className="rounded-xl border border-warn/40 bg-warn/5 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><ShieldCheck className="size-4 text-warn" />{t("Consent")}</p>
          <div className="grid gap-3 @lg:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-mute">{t("Whose voice is this? (full name)")}</span>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("e.g. Priya Sharma")} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-mute">{t("Allowed use (optional)")}</span>
              <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder={t("e.g. Mango pickle ad campaign, 2026")} />
            </label>
          </div>
          <label className="mt-3 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-xs text-mute transition-colors hover:border-accent/50 hover:text-ink">
            <FileSignature className="size-3.5" />{release ? release.name : t("Attach signed release (PDF or image, optional)")}
            <input type="file" hidden accept="application/pdf,image/png,image/jpeg" onChange={(e) => setRelease(e.target.files?.[0] ?? null)} />
          </label>
          <div className="mt-3">
            <Toggle checked={confirmed} onChange={setConfirmed}
              label={<span className="text-xs">{t("I have this person's permission to clone their voice and use it in our videos")}</span>} />
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-mute">{t("Use this voice for")}</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(LANG_NAMES).map((l) => {
              const on = langs.includes(l);
              return (
                <button key={l} type="button" aria-pressed={on} title={LANG_NAMES[l]}
                  onClick={() => setLangs(on ? langs.filter((x) => x !== l) : [...langs, l])}
                  className={clsx("h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors",
                    on ? "border-accent/60 bg-accent/10 text-ink" : "border-line text-mute hover:text-ink")}>{LANG_SHORT[l]}</button>
              );
            })}
          </div>
          <p className="text-2xs text-dim">{t("The same voice speaks every language you pick. Play a sample in each language afterwards to check the accent.")}</p>
        </div>
        <Toggle checked={denoise} onChange={setDenoise} label={<span className="text-xs">{t("Clean up background noise in the recordings")}</span>} />
        <Alert tone="info">{t("Uses one of your ElevenLabs custom voice slots. The recordings and consent are stored with the character and logged in the audit log.")}</Alert>
      </div>
    </Modal>
  );
}
