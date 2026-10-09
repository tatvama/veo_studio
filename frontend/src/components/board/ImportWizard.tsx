import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, ClipboardCopy, FileText, ImagePlus, Mic, Sparkles, UploadCloud, Users, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DropZone } from "../../pages/brand/DropZone";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import { useCharacters } from "../../lib/queries";
import type { Board, Character, ImportResult } from "../../lib/types";
import { importApply } from "../../lib/v3";
import { radioKeys } from "../room/util";
import { pad } from "../room/workspace";
import { Avatar, Button, Modal, Select, Textarea } from "../ui";
import { ImportPreview, ImportSummary, NEW_PICK, type CastPick } from "./ImportPreview";
import "../../styles/board.css";

const EXT = [".docx", ".pdf", ".txt", ".md", ".fountain"];

export const TEMPLATE = `SCENE 1: INT. KITCHEN - MORNING
Grandmother's sunlit kitchen, brass vessels on the shelf.

SHOT 1 (6s)
VISUAL: Close-up of wrinkled hands twisting open a glass pickle jar.
AJJI (proud): This recipe is fifty years old.

SHOT 2
VISUAL: Wide shot of the kitchen, steam rising from the stove.
VO: Some flavours never leave you.

SCENE 2: EXT. GARDEN - DAY
VISUAL: Mango trees sway in the breeze.
RAVI (smiling): I can smell it from here!
MEERA: Then come inside.`;

type Step = "source" | "cast" | "preview";
type Method = "auto" | "markers" | "ai";

/** Columns of the cast table on wide dialogs: script name | lines | character | photo. */
const CAST_COLS = "@2xl:grid-cols-[minmax(0,1.15fr)_3.5rem_minmax(0,1.5fr)_8.5rem]";

/**
 * The draft and mapping that /import/apply receives. Voice-over picks leave the mapping (so no character is created),
 * their lines become VO and their names leave the on-screen lists.
 */
function prepare(res: ImportResult, picks: Record<string, CastPick>) {
  const vo = new Set<string>();
  const mapping: Record<string, number | "new"> = {};
  for (const c of res.characters) {
    const p = picks[c.name] ?? NEW_PICK;
    if (p.kind === "vo") vo.add(c.name);
    else mapping[c.name] = p.kind === "existing" ? p.id : "new";
  }
  const draft = {
    ...res.draft,
    scenes: res.draft.scenes.map((sc) => ({
      ...sc,
      shots: sc.shots.map((sh) => ({
        ...sh,
        characters: sh.characters.filter((n) => !vo.has(n)),
        lines: sh.lines.map(({ changed: _c, ...l }) => (vo.has(l.speaker) ? { ...l, speaker: "VO" } : l)),
      })),
    })),
  };
  return { draft, mapping };
}

/** Import a prepared script: read it, map its names to characters, preview every scene, then apply (shot list + Story script). */
export function ImportWizard({ open, onClose, eid, projectId, hasShots, onDone }: {
  open: boolean; onClose: () => void; eid: number; projectId: number; hasShots: boolean; onDone: (b: Board) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: cast } = useCharacters(projectId);
  const { data: library } = useCharacters();
  const [step, setStep] = useState<Step>("source");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [method, setMethod] = useState<Method>("auto");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [picks, setPicks] = useState<Record<string, CastPick>>({});
  const [photos, setPhotos] = useState<Record<string, File>>({});
  const [writeScript, setWriteScript] = useState(true);

  const pool = useMemo(() => {
    const m = new Map<number, Character>();
    [...(cast ?? []), ...(library ?? [])].forEach((c) => m.set(c.id, c));
    return m;
  }, [cast, library]);

  // one object URL per chosen photo (revoked when the choice changes), instead of a new one on every render
  const previews = useMemo(() => Object.fromEntries(Object.entries(photos).map(([name, f]) => [name, URL.createObjectURL(f)])) as Record<string, string>, [photos]);
  useEffect(() => () => { Object.values(previews).forEach((u) => URL.revokeObjectURL(u)); }, [previews]);

  const reset = () => { setStep("source"); setFile(null); setText(""); setRes(null); setPicks({}); setPhotos({}); setWriteScript(true); };
  const close = () => { if (!busy) { reset(); onClose(); } };

  const read = async () => {
    if (!file && !text.trim()) return toast.error(tr("Upload a file or paste your script"));
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append("file", file);
      else fd.append("text", text);
      fd.append("method", method);
      const r = await api.post<ImportResult>(`/api/episodes/${eid}/import/parse`, fd);
      setRes(r);
      const p: Record<string, CastPick> = {};
      r.characters.forEach((c) => { p[c.name] = c.match ? { kind: "existing", id: c.match.id } : NEW_PICK; });
      setPicks(p);
      setStep(r.characters.length ? "cast" : "preview");
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!res) return;
    setBusy(true);
    try {
      const { draft, mapping } = prepare(res, picks);
      const r = await importApply(eid, draft, mapping, true, writeScript);
      // Photos go to whichever character each name ended up as (matched or just created).
      for (const [name, photo] of Object.entries(photos)) {
        const id = r.characters?.[name];
        if (typeof id === "number") { try { await api.upload(`/api/characters/${id}/upload`, photo); } catch { /* api toasts */ } }
      }
      const shots = r.scenes.reduce((a, s) => a + (s.shots?.length ?? 0), 0);
      toast.success(tr("Script imported: {s} scenes, {n} shots", { s: r.scenes.length, n: shots }),
        r.created.length ? { description: tr("New characters: {names}", { names: r.created.map((c) => c.name).join(", ") }) } : undefined);
      for (const key of ["episode", "board", "project", "characters"]) qc.invalidateQueries({ queryKey: [key] });
      onDone(r as unknown as Board);
      reset();
      onClose();
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  const steps: { id: Step; label: string }[] = [
    { id: "source", label: t("Script") }, { id: "cast", label: t("Characters") }, { id: "preview", label: t("Preview") },
  ];
  const stepIdx = steps.findIndex((s) => s.id === step);
  const shots = res?.draft.scenes.reduce((a, s) => a + s.shots.length, 0) ?? 0;

  const footer = (
    <>
      {step !== "source" && (
        <Button variant="ghost" icon={<ArrowLeft className="size-4" />} disabled={busy} onClick={() => setStep(step === "preview" && res?.characters.length ? "cast" : "source")}>{t("Back")}</Button>
      )}
      <div className="flex-1" />
      {step === "source" && <Button variant="primary" loading={busy} icon={<Wand2 className="size-4" />} onClick={read}>{t("Read script")}</Button>}
      {step === "cast" && <Button variant="primary" iconRight={<ArrowRight className="size-4" />} onClick={() => setStep("preview")}>{t("Next: preview")}</Button>}
      {step === "preview" && (
        <Button variant="primary" loading={busy} icon={<Check className="size-4" />} onClick={apply} disabled={!shots}>
          {t("Import {n} shots", { n: shots })}
        </Button>
      )}
    </>
  );

  const methods: { value: Method; label: string; hint: string; icon?: boolean }[] = [
    { value: "auto", label: t("Auto"), hint: t("Template layout if found, otherwise AI arranges it") },
    { value: "markers", label: t("Template only"), hint: t("No AI: read the layout exactly") },
    { value: "ai", label: t("AI arranges"), hint: t("AI splits it into scenes and shots, keeping your words"), icon: true },
  ];

  return (
    <Modal open={open} onClose={close} size="xl" footer={footer}
      title={<span className="flex items-center gap-2"><FileText className="size-4 text-accent-ink" />{t("Import your script")}</span>}>
      {/* the dialog is not a size container itself: its content is, so the @2xl / @3xl layouts below apply */}
      <div className="@container">
        {/* stepper: mono numerals joined by a line that fills as you go */}
        <ol className="mb-5 flex items-center" aria-label={t("Steps")}>
          {steps.map((s, i) => {
            const done = i < stepIdx;
            const cur = i === stepIdx;
            return (
              <li key={s.id} aria-current={cur ? "step" : undefined} className={cn("flex min-w-0 items-center", i < steps.length - 1 && "flex-1")}>
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className={cn("mono grid size-7 shrink-0 place-items-center rounded-lg border text-xs font-semibold transition-colors",
                    done ? "border-ok/50 bg-ok/15 text-ok" : cur ? "border-accent bg-accent/15 text-accent-ink shadow-[0_0_12px_-3px_var(--color-accent)]" : "border-line bg-bg text-dim")}>
                    {done ? <Check className="size-3.5" strokeWidth={3} /> : pad(i + 1)}
                  </span>
                  <span className={cn("min-w-0 truncate text-sm", cur ? "font-semibold text-ink" : "hidden text-mute @md:block")}>{s.label}</span>
                </span>
                {i < steps.length - 1 && <span aria-hidden className={cn("mx-3 h-px min-w-4 flex-1", done ? "bg-ok/50" : cur ? "rm-rule" : "bg-line/60")} />}
              </li>
            );
          })}
        </ol>

        {step === "source" && (
          <div className="grid gap-5 @3xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-3">
              <p className="eyebrow flex items-center gap-1.5"><span className="mono">01</span><span aria-hidden className="opacity-50">/</span>{t("Script")}</p>
              <DropZone accept={[]} maxMb={10} busy={busy}
                onFiles={(fs) => {
                  const f = fs[0];
                  if (!EXT.some((e) => f.name.toLowerCase().endsWith(e))) return toast.error(tr("Upload a Word (.docx), PDF or text file"));
                  setFile(f); setText("");
                }}
                icon={<UploadCloud className="size-5" />}
                title={file ? file.name : t("Drop your script here, or click to choose")}
                hint={file ? t("{kb} KB · click to choose another", { kb: Math.max(1, Math.round(file.size / 1024)) }) : t("Word (.docx), PDF or text · up to 10 MB")} />
              <div className="eyebrow flex items-center gap-3"><span className="h-px flex-1 bg-line" />{t("or paste it")}<span className="h-px flex-1 bg-line" /></div>
              <Textarea rows={8} value={text} onChange={(e) => { setText(e.target.value); if (e.target.value) setFile(null); }}
                placeholder={t("Paste your script here…")} aria-label={t("Script text")} className="mono text-xs" />
            </div>

            <div className="min-w-0 space-y-4">
              <div className="space-y-2">
                <p className="eyebrow flex items-center gap-1.5"><span className="mono">02</span><span aria-hidden className="opacity-50">/</span>{t("How to read it")}</p>
                <div role="radiogroup" aria-label={t("How to read it")} onKeyDown={radioKeys} className="grid gap-2">
                  {methods.map((m) => {
                    const on = method === m.value;
                    return (
                      <button key={m.value} type="button" role="radio" aria-checked={on} onClick={() => setMethod(m.value)}
                        className={cn("flex items-start gap-3 rounded-lg border p-2.5 text-left transition-colors pointer-coarse:min-h-12",
                          on ? "border-accent/60 bg-accent/10" : "border-line hover:border-dim/60 hover:bg-hover/50")}>
                        <span aria-hidden className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", on ? "border-accent bg-accent/20" : "border-line")}>
                          {on && <span className="size-1.5 rounded-full bg-accent" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-sm font-medium">{m.label}{m.icon && <Sparkles aria-hidden className="size-3 text-ai" />}</span>
                          <span className="mt-0.5 block text-2xs leading-snug text-dim">{m.hint}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-2xs leading-snug text-dim">{t("AI only splits and tags speakers. Lines it changed are highlighted for you.")}</p>
              </div>

              <details className="group/tpl rounded-xl border border-line bg-raised/30 p-3 text-xs">
                <summary className="cursor-pointer font-medium">{t("Best results: this layout (any language)")}</summary>
                <p className="mt-2 text-mute">{t("SCENE / INT. / EXT. start a scene · SHOT starts a shot (add 4s, 6s or 8s) · VISUAL: is what we see · NAME: is dialogue (add an emotion in brackets) · VO: is voice-over. Scripts in other layouts are arranged by AI, keeping your words.")}</p>
                <pre className="mono mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-panel p-2 text-2xs leading-relaxed">{TEMPLATE}</pre>
                <Button size="sm" variant="ghost" className="mt-1" icon={<ClipboardCopy className="size-3.5" />}
                  onClick={() => { void navigator.clipboard?.writeText(TEMPLATE); toast.success(tr("Template copied")); }}>{t("Copy template")}</Button>
              </details>
            </div>
          </div>
        )}

        {step === "cast" && res && (
          <div className="space-y-3">
            <ImportSummary res={res} />
            <p className="text-sm text-mute">{t("Who is who? Match each name in your script to a character, create a new one (add a photo to set the look), or read it as voice-over. Nothing is saved until you import.")}</p>

            <div className="overflow-hidden rounded-xl border border-line">
              <div aria-hidden className={cn("eyebrow hidden gap-x-3 border-b border-line bg-raised/40 px-3 py-1.5 @2xl:grid", CAST_COLS)}>
                <span>{t("Script")}</span><span className="text-right">{t("Lines")}</span><span>{t("Character")}</span><span>{t("Photo")}</span>
              </div>
              <ul className="divide-y divide-line">
                {res.characters.map((c) => {
                  const p = picks[c.name] ?? NEW_PICK;
                  const value = p.kind === "existing" ? String(p.id) : p.kind;
                  const chosen = p.kind === "existing" ? pool.get(p.id) : undefined;
                  return (
                    <li key={c.name} className={cn("grid items-center gap-x-3 gap-y-2 px-3 py-2.5", CAST_COLS)}>
                      <div className="flex min-w-0 items-center gap-2.5">
                        {p.kind === "vo"
                          ? <span className="grid size-8 shrink-0 place-items-center rounded-full border border-line bg-raised text-mute"><Mic className="size-4" /></span>
                          : <Avatar name={chosen?.name ?? c.name} src={chosen?.avatar_url || previews[c.name] || ""} size={32} />}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold uppercase tracking-wide">{c.name}</p>
                          <p className="truncate text-2xs text-dim">
                            {!!c.lines && <span className="mono @2xl:hidden">{c.lines === 1 ? t("1 line") : t("{n} lines", { n: c.lines })}{c.match ? " · " : ""}</span>}
                            {[!c.lines ? t("on screen, no lines") : "", c.match ? t("matched {name}", { name: c.match.name }) : ""].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                      </div>
                      <span className="mono hidden text-right text-sm text-mute @2xl:block" aria-label={c.lines === 1 ? t("1 line") : t("{n} lines", { n: c.lines })}>{c.lines}</span>
                      <Select value={value} className="h-8 w-full text-xs pointer-coarse:h-10" aria-label={t("Character for {name}", { name: c.name })}
                        onChange={(e) => setPicks({ ...picks, [c.name]: e.target.value === "new" ? NEW_PICK : e.target.value === "vo" ? { kind: "vo" } : { kind: "existing", id: Number(e.target.value) } })}>
                        <option value="new">＋ {t("Create new character")}</option>
                        <option value="vo">🎙 {t("Voice-over (narrator)")}</option>
                        {!!cast?.length && <optgroup label={t("In this project")}>{cast.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>}
                        {!!library?.length && (
                          <optgroup label={t("Character library")}>
                            {library.filter((x) => !cast?.some((y) => y.id === x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </optgroup>
                        )}
                      </Select>
                      {p.kind !== "vo" ? (
                        <label className={cn("inline-flex h-8 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors pointer-coarse:h-10",
                          photos[c.name] ? "border-ok/40 bg-ok/10 text-green-300" : "border-line text-mute hover:border-accent/50 hover:text-ink")}>
                          {photos[c.name] ? <Check className="size-3.5 shrink-0" strokeWidth={3} /> : <ImagePlus className="size-3.5 shrink-0" />}
                          <span className="truncate">{photos[c.name] ? t("Photo added") : t("Add photo")}</span>
                          <input type="file" hidden accept="image/png,image/jpeg,image/webp"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhotos({ ...photos, [c.name]: f }); }} />
                        </label>
                      ) : <span aria-hidden className="hidden @2xl:block" />}
                    </li>
                  );
                })}
              </ul>
            </div>
            <p className="flex items-center gap-1.5 text-2xs text-dim"><Users className="size-3" />{t("New characters are added to this project and the library when you import. Uploaded photos become their look reference.")}</p>
          </div>
        )}

        {step === "preview" && res && (
          <ImportPreview res={res} picks={picks} pool={pool} hasShots={hasShots} writeScript={writeScript} onWriteScript={setWriteScript} />
        )}
      </div>
    </Modal>
  );
}
