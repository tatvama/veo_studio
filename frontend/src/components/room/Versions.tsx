import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronDown, History, Pencil, RotateCcw, ScanFace, Snowflake, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ago } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { createVersion, deleteVersion, patchVersion, restoreVersion, useCharacterLook, useCharacterVersions, type CharacterV3, type CharacterVersion } from "../../lib/v3";
import { Alert, Badge, Button, IconButton, Input, Modal, Skeleton, Textarea, rise } from "../ui";
import { LoadError, RField, RoomEmpty, SectionCard } from "./kit";
import { episodeNumber, episodeRange } from "./look";
import { useCharScope } from "./scope";

interface FreezeForm { label: string; episode_from: string; episode_to: string; note: string; advanced: boolean; dna_text: string; voice_description: string }
interface EditForm { label: string; episode_from: string; episode_to: string; note: string }

/** Frozen looks of a character per episode range: freeze, edit the range, restore, delete. */
export function Versions({ character, editable, index }: { character: CharacterV3; editable: boolean; index?: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { canProduce, episodeNumber: curEp } = useCharScope();
  const cid = character.id;
  const { data: versions, isLoading, isError, refetch } = useCharacterVersions(cid);
  const { data: look } = useCharacterLook(cid, curEp);
  const [freeze, setFreeze] = useState<FreezeForm | null>(null);
  const [edit, setEdit] = useState<{ v: CharacterVersion; form: EditForm } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "restore" | "delete"; v: CharacterVersion } | null>(null);
  const [busy, setBusy] = useState("");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["character-versions", cid] });
    qc.invalidateQueries({ queryKey: ["character-look", cid] });
    qc.invalidateQueries({ queryKey: ["character-lock", cid] });
    qc.invalidateQueries({ queryKey: ["character", cid] });
    qc.invalidateQueries({ queryKey: ["characters"] });
  };
  const list = [...(versions ?? [])].sort((a, b) => b.version - a.version);
  const nextNo = (versions ?? []).reduce((m, v) => Math.max(m, v.version), 0) + 1;
  const applied = look?.version ?? null;

  const openFreeze = () => setFreeze({ label: `v${nextNo}`, episode_from: curEp?.toString() ?? "", episode_to: "", note: "", advanced: false,
    dna_text: character.dna_text ?? "", voice_description: character.voice_description ?? "" });

  const rangeBad = (from: string, to: string) => { const a = episodeNumber(from), b = episodeNumber(to); return a != null && b != null && b < a; };

  const doFreeze = async () => {
    if (!freeze || rangeBad(freeze.episode_from, freeze.episode_to)) return;
    setBusy("freeze");
    try {
      await createVersion(cid, {
        label: freeze.label.trim() || undefined, episode_from: episodeNumber(freeze.episode_from), episode_to: episodeNumber(freeze.episode_to), note: freeze.note.trim(),
        ...(freeze.advanced ? { dna_text: freeze.dna_text, voice_description: freeze.voice_description } : {}),
      });
      toast.success(tr("Look frozen as {label}", { label: freeze.label.trim() || `v${nextNo}` }));
      refresh();
      setFreeze(null);
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  const doEdit = async () => {
    if (!edit || rangeBad(edit.form.episode_from, edit.form.episode_to)) return;
    setBusy("edit");
    try {
      await patchVersion(edit.v.id, { label: edit.form.label.trim() || edit.v.label, episode_from: episodeNumber(edit.form.episode_from), episode_to: episodeNumber(edit.form.episode_to), note: edit.form.note.trim() });
      toast.success(tr("Version updated"));
      refresh();
      setEdit(null);
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  const doConfirm = async () => {
    if (!confirm) return;
    setBusy(confirm.kind);
    try {
      if (confirm.kind === "restore") { await restoreVersion(confirm.v.id); toast.success(tr("{name} restored to {label}", { name: character.name, label: confirm.v.label })); }
      else { await deleteVersion(confirm.v.id); toast.success(tr("Version deleted")); }
      refresh();
      setConfirm(null);
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  return (
    <SectionCard id="sec-versions" index={index} icon={<History />}
      title={<span className="flex flex-wrap items-center gap-2">{t("Versions")}{list.length > 0 && <Badge>{list.length}</Badge>}</span>}
      description={t("Freeze the look (DNA, voice, lock, approved references, trained identity) for a range of episodes, so {name} can age or change hairstyle later while earlier episodes keep the old look.", { name: character.name })}
      actions={editable && <Button size="sm" variant="primary" icon={<Snowflake className="size-3.5" />} onClick={openFreeze}>{t("Freeze current look")}</Button>}>
      <div className="space-y-4">
        {/* what applies now */}
        {curEp !== undefined && (
          <div className={clsx("flex flex-wrap items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm", applied ? "border-info/30 bg-info/5" : "border-line bg-bg/30")}>
            <History className={clsx("size-4 shrink-0", applied ? "text-info" : "text-dim")} />
            <span className="min-w-0 flex-1">
              {applied
                ? t("Episode {n} uses {label} (frozen {when}).", { n: curEp, label: applied.label, when: ago(applied.created_at) })
                : t("Episode {n} uses the live look — no frozen version covers it.", { n: curEp })}
            </span>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2" aria-busy="true"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
        ) : isError ? (
          <LoadError what={t("Couldn't load the versions")} onRetry={() => refetch()} />
        ) : !list.length ? (
          <RoomEmpty icon={<Snowflake />} title={t("No frozen versions")}
            sub={t("Once the look is approved, freeze it for the episodes it belongs to. Later changes won't touch those episodes, and you can always roll back.")}
            action={editable ? <Button size="sm" variant="outline" icon={<Snowflake className="size-3.5" />} onClick={openFreeze}>{t("Freeze current look")}</Button> : undefined} />
        ) : (
          <ol className="relative space-y-3 before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-line">
            {list.map((v, i) => {
              const r = rise(i);
              const current = applied?.id === v.id;
              const identityOk = v.identity?.status === "ready" || !!v.identity?.lora_url;
              return (
                <li key={v.id} {...r} className={clsx("relative pl-8", r.className)}>
                  <span aria-hidden className={clsx("absolute left-0 top-3.5 grid size-6 place-items-center rounded-full border text-2xs font-semibold tabular-nums",
                    current ? "border-info/60 bg-info/15 text-sky-300" : "border-line bg-raised text-mute")}>{v.version}</span>
                  <div className={clsx("rounded-xl border p-3", current ? "border-info/40 bg-info/5" : "border-line bg-bg/30")}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold" title={v.label}>{v.label}</span>
                          <Badge>{episodeRange(v.episode_from, v.episode_to)}</Badge>
                          {current && <Badge tone="info" dot>{curEp !== undefined ? t("Applies to Ep {n}", { n: curEp }) : t("Applies now")}</Badge>}
                        </p>
                        <p className="mt-0.5 text-2xs text-dim" title={new Date(v.created_at).toLocaleString()}>{t("Frozen {when}", { when: ago(v.created_at) })} · {t("{n} approved references", { n: v.asset_ids?.length ?? 0 })}</p>
                      </div>
                      {editable && (
                        <div className="flex shrink-0 items-center">
                          <IconButton title={t("Edit label, range, note")} className="!size-7" onClick={() => setEdit({ v, form: { label: v.label, episode_from: v.episode_from?.toString() ?? "", episode_to: v.episode_to?.toString() ?? "", note: v.note } })}><Pencil className="size-3.5" /></IconButton>
                          <IconButton title={t("Restore this version")} className="!size-7" onClick={() => setConfirm({ kind: "restore", v })}><RotateCcw className="size-3.5" /></IconButton>
                          {canProduce && <IconButton title={t("Delete version")} className="!size-7 hover:!bg-bad/10 hover:!text-bad" onClick={() => setConfirm({ kind: "delete", v })}><Trash2 className="size-3.5" /></IconButton>}
                        </div>
                      )}
                    </div>
                    {v.note && <p className="mt-2 text-xs leading-relaxed text-mute">{v.note}</p>}
                    <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-xs @lg:grid-cols-[1fr_1fr_auto]">
                      <div className="min-w-0"><dt className="text-2xs text-dim">{t("DNA")}</dt><dd className="line-clamp-2 text-mute" title={v.dna_text}>{v.dna_text || "—"}</dd></div>
                      <div className="min-w-0"><dt className="text-2xs text-dim">{t("Voice")}</dt><dd className="line-clamp-2 text-mute" title={v.voice_description}>{v.voice_description || "—"}</dd></div>
                      <div><dt className="sr-only">{t("Identity")}</dt><dd>
                        {identityOk ? <Badge tone="ok"><ScanFace className="size-3" />{t("Identity snapshot")}</Badge> : <Badge><ScanFace className="size-3" />{t("No identity snapshot")}</Badge>}
                      </dd></div>
                    </dl>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* freeze */}
      <Modal open={!!freeze} onClose={() => busy !== "freeze" && setFreeze(null)} title={t("Freeze the current look of {name}", { name: character.name })}
        footer={<>
          <Button variant="ghost" onClick={() => setFreeze(null)} disabled={busy === "freeze"}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy === "freeze"} disabled={!freeze || rangeBad(freeze.episode_from, freeze.episode_to)} onClick={doFreeze} icon={<Snowflake className="size-4" />}>{t("Freeze")}</Button>
        </>}>
        {freeze && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-mute">{t("Snapshots the DNA, voice description, Character Lock, the approved reference images and the trained identity as they are now.")}</p>
            <RField label={t("Label")} htmlFor="ver-label"><Input id="ver-label" data-autofocus value={freeze.label} placeholder={t("Season 1 look")} onChange={(e) => setFreeze({ ...freeze, label: e.target.value })} /></RField>
            <div className="grid grid-cols-2 gap-3">
              <RField label={t("From episode")} htmlFor="ver-from" hint={t("Blank = from the start")}>
                <Input id="ver-from" type="number" min={1} inputMode="numeric" value={freeze.episode_from} onChange={(e) => setFreeze({ ...freeze, episode_from: e.target.value })} />
              </RField>
              <RField label={t("To episode")} htmlFor="ver-to" hint={rangeBad(freeze.episode_from, freeze.episode_to) ? <span className="text-amber-300">{t("Must not be before the first episode")}</span> : t("Blank = open-ended")}>
                <Input id="ver-to" type="number" min={1} inputMode="numeric" value={freeze.episode_to} onChange={(e) => setFreeze({ ...freeze, episode_to: e.target.value })} />
              </RField>
            </div>
            <RField label={t("Note")} htmlFor="ver-note"><Input id="ver-note" value={freeze.note} placeholder={t("Before the time jump: short hair, no beard")} onChange={(e) => setFreeze({ ...freeze, note: e.target.value })} /></RField>
            <button type="button" aria-expanded={freeze.advanced} onClick={() => setFreeze({ ...freeze, advanced: !freeze.advanced })}
              className="inline-flex items-center gap-1 text-xs font-medium text-mute transition-colors hover:text-ink">
              <ChevronDown className={clsx("size-3.5 transition-transform duration-200", freeze.advanced && "rotate-180")} />{t("Advanced: change the DNA and voice for this version")}
            </button>
            {freeze.advanced && (
              <div className="space-y-3 rounded-xl border border-line bg-bg/40 p-3">
                <RField label={t("Character DNA for this version")} htmlFor="ver-dna"><Textarea id="ver-dna" rows={4} value={freeze.dna_text} onChange={(e) => setFreeze({ ...freeze, dna_text: e.target.value })} /></RField>
                <RField label={t("Voice description for this version")} htmlFor="ver-voice"><Input id="ver-voice" value={freeze.voice_description} onChange={(e) => setFreeze({ ...freeze, voice_description: e.target.value })} /></RField>
                <p className="text-2xs text-dim">{t("The live character is not changed — only the frozen version carries these values. Restore it to make them live.")}</p>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* edit */}
      <Modal open={!!edit} onClose={() => busy !== "edit" && setEdit(null)} title={t("Edit version {label}", { label: edit?.v.label ?? "" })}
        footer={<>
          <Button variant="ghost" onClick={() => setEdit(null)} disabled={busy === "edit"}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy === "edit"} disabled={!edit || rangeBad(edit.form.episode_from, edit.form.episode_to)} onClick={doEdit}>{t("Save")}</Button>
        </>}>
        {edit && (
          <div className="space-y-3">
            <RField label={t("Label")} htmlFor="vedit-label"><Input id="vedit-label" data-autofocus value={edit.form.label} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, label: e.target.value } })} /></RField>
            <div className="grid grid-cols-2 gap-3">
              <RField label={t("From episode")} htmlFor="vedit-from" hint={t("Blank = from the start")}>
                <Input id="vedit-from" type="number" min={1} inputMode="numeric" value={edit.form.episode_from} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, episode_from: e.target.value } })} />
              </RField>
              <RField label={t("To episode")} htmlFor="vedit-to" hint={rangeBad(edit.form.episode_from, edit.form.episode_to) ? <span className="text-amber-300">{t("Must not be before the first episode")}</span> : t("Blank = open-ended")}>
                <Input id="vedit-to" type="number" min={1} inputMode="numeric" value={edit.form.episode_to} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, episode_to: e.target.value } })} />
              </RField>
            </div>
            <RField label={t("Note")} htmlFor="vedit-note"><Input id="vedit-note" value={edit.form.note} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, note: e.target.value } })} /></RField>
          </div>
        )}
      </Modal>

      {/* restore / delete */}
      <Modal open={!!confirm} onClose={() => !busy && setConfirm(null)}
        title={confirm?.kind === "restore" ? t("Restore {label}?", { label: confirm.v.label }) : t("Delete version {label}?", { label: confirm?.v.label ?? "" })}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)} disabled={!!busy}>{t("Cancel")}</Button>
          {confirm?.kind === "restore"
            ? <Button variant="primary" loading={busy === "restore"} onClick={doConfirm} icon={<RotateCcw className="size-4" />}>{t("Restore")}</Button>
            : <Button variant="danger" loading={busy === "delete"} onClick={doConfirm} icon={<Trash2 className="size-4" />}>{t("Delete version")}</Button>}
        </>}>
        {confirm?.kind === "restore" ? (
          <div className="space-y-3 text-sm text-mute">
            <p>{t("Rolls {name} back to this version: the DNA, voice description, Character Lock and trained identity snapshot replace what is live now, and the character gets a new version number.", { name: character.name })}</p>
            <Alert tone="info">{t("Reference images are not changed, and takes already made keep their references. Frozen versions stay as they are.")}</Alert>
          </div>
        ) : (
          <p className="text-sm text-mute">{t("Episodes in its range fall back to the live look (or to another version that covers them). You can't undo this.")}</p>
        )}
      </Modal>
    </SectionCard>
  );
}
