import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowLeft, ArrowRight, Check, ClipboardCopy, FileText, ImagePlus, Sparkles, UploadCloud, Users, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DropZone } from "../../pages/brand/DropZone";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import { useCharacters } from "../../lib/queries";
import type { Board, BoardScene, Character, ImportResult } from "../../lib/types";
import { Alert, Avatar, Badge, Button, Modal, Segmented, Select, Textarea } from "../ui";
import { ShotListEditor, uid, withKeys } from "./ShotListEditor";

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

type Step = "source" | "cast" | "review";
type Pick = { kind: "existing"; id: number } | { kind: "new" } | { kind: "vo" };

/** Import a prepared script: read it, map its names to characters, review scene by scene, save as the shot list. */
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
  const [method, setMethod] = useState<"auto" | "markers" | "ai">("auto");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [photos, setPhotos] = useState<Record<string, File>>({});
  const [scenes, setScenes] = useState<BoardScene[]>([]);
  const [made, setMade] = useState<Character[]>([]);
  const [mode, setMode] = useState<"replace" | "append">("replace");

  const pool = useMemo(() => {
    const m = new Map<number, Character>();
    [...(cast ?? []), ...(library ?? []), ...made].forEach((c) => m.set(c.id, c));
    return m;
  }, [cast, library, made]);

  const reset = () => {
    setStep("source"); setFile(null); setText(""); setRes(null); setPicks({}); setPhotos({}); setScenes([]); setMade([]);
  };
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
      const p: Record<string, Pick> = {};
      r.characters.forEach((c) => { p[c.name] = c.match ? { kind: "existing", id: c.match.id } : { kind: "new" }; });
      setPicks(p);
      setStep(r.characters.length ? "cast" : "review");
      if (!r.characters.length) setScenes(toBoard(r, {}));
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  const toBoard = (r: ImportResult, ids: Record<string, number | "VO">): BoardScene[] =>
    withKeys(r.draft.scenes.map((sc) => ({
      key: uid(), title: sc.title, location: sc.location, time_of_day: sc.time_of_day, summary: sc.summary,
      shots: sc.shots.map((sh) => ({
        key: uid(), prompt: sh.prompt, duration_s: [4, 6, 8].includes(sh.duration_s) ? sh.duration_s : 8, extend_to: 0, extend_prompt: "",
        framing: sh.framing || "", camera: sh.camera || "",
        characters: sh.characters.map((n) => ids[n]).filter((v): v is number => typeof v === "number"),
        lines: sh.lines.map((l) => ({ speaker: l.speaker === "VO" ? "VO" as const : (ids[l.speaker] ?? "VO"), text: l.text, emotion: l.emotion, changed: l.changed })),
      })),
    })));

  const confirmCast = async () => {
    if (!res) return;
    setBusy(true);
    try {
      const ids: Record<string, number | "VO"> = {};
      const next = { ...picks };
      const pending = { ...photos };
      try {
        for (const c of res.characters) {
          const p = next[c.name] ?? { kind: "new" };
          if (p.kind === "vo") ids[c.name] = "VO";
          else if (p.kind === "existing") ids[c.name] = p.id;
          else {
            const ch = await api.post<Character>("/api/characters", { name: c.name, project_id: projectId });
            ids[c.name] = ch.id;
            // from now on it is an existing character: going Back and Next again (or retrying) won't make a second one
            next[c.name] = { kind: "existing", id: ch.id };
            setMade((m) => [...m, ch]);
          }
          const photo = pending[c.name];
          const id = ids[c.name];
          if (photo && typeof id === "number") {
            await api.upload(`/api/characters/${id}/upload`, photo);
            delete pending[c.name];  // uploaded once
          }
        }
      } finally {
        setPicks(next);
        setPhotos(pending);
      }
      qc.invalidateQueries({ queryKey: ["characters"] });
      setScenes(toBoard(res, ids));
      setStep("review");
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      let all = scenes;
      let version: string | undefined;
      if (hasShots && mode === "append") {
        const cur = await api.get<Board>(`/api/episodes/${eid}/board`);
        all = [...cur.scenes, ...scenes];
        version = cur.version;
      }
      const strip = all.map(({ key: _k, ...sc }) => ({ ...sc, shots: sc.shots.map(({ key: _s, ...sh }) => ({ ...sh, lines: sh.lines.map(({ changed: _c, ...l }) => l) })) }));
      const b = await api.put<Board>(`/api/episodes/${eid}/board`, { scenes: strip, version });
      const n = b.scenes.reduce((a, s) => a + s.shots.length, 0);
      toast.success(tr("Script imported: {s} scenes, {n} shots", { s: b.scenes.length, n }));
      qc.invalidateQueries({ queryKey: ["episode"] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      onDone(b);
      reset();
      onClose();
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  const castList = useMemo(() => {
    const ids = new Set<number>();
    scenes.forEach((s) => s.shots.forEach((h) => { h.characters.forEach((c) => ids.add(c)); h.lines.forEach((l) => typeof l.speaker === "number" && ids.add(l.speaker)); }));
    (cast ?? []).forEach((c) => ids.add(c.id));
    return [...ids].map((id) => pool.get(id)).filter((c): c is Character => !!c);
  }, [scenes, cast, pool]);

  const steps: { id: Step; label: string }[] = [
    { id: "source", label: t("Script") }, { id: "cast", label: t("Characters") }, { id: "review", label: t("Review") },
  ];
  const stepIdx = steps.findIndex((s) => s.id === step);
  const totals = { scenes: scenes.length, shots: scenes.reduce((a, s) => a + s.shots.length, 0) };
  const changed = scenes.reduce((a, s) => a + s.shots.reduce((b, h) => b + h.lines.filter((l) => l.changed).length, 0), 0);

  const footer = (
    <>
      {step !== "source" && <Button variant="ghost" icon={<ArrowLeft className="size-4" />} disabled={busy} onClick={() => setStep(step === "review" && res?.characters.length ? "cast" : "source")}>{t("Back")}</Button>}
      <div className="flex-1" />
      {step === "source" && <Button variant="primary" loading={busy} icon={<Wand2 className="size-4" />} onClick={read}>{t("Read script")}</Button>}
      {step === "cast" && <Button variant="primary" loading={busy} iconRight={<ArrowRight className="size-4" />} onClick={confirmCast}>{t("Next: review scenes")}</Button>}
      {step === "review" && (
        <Button variant="primary" loading={busy} icon={<Check className="size-4" />} onClick={save} disabled={!totals.shots}>
          {t("Create {n} shots", { n: totals.shots })}
        </Button>
      )}
    </>
  );

  return (
    <Modal open={open} onClose={close} size="xl" footer={footer}
      title={<span className="flex items-center gap-2"><FileText className="size-4 text-accent-ink" />{t("Import your script")}</span>}>
      <ol className="mb-4 flex items-center gap-2 text-xs" aria-label={t("Steps")}>
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <span className={clsx("grid size-5 place-items-center rounded-full text-2xs font-semibold",
              i < stepIdx ? "bg-ok/20 text-ok" : i === stepIdx ? "bg-accent text-black" : "bg-raised text-dim")}>
              {i < stepIdx ? <Check className="size-3" strokeWidth={3} /> : i + 1}
            </span>
            <span className={clsx(i === stepIdx ? "font-semibold text-ink" : "text-mute")}>{s.label}</span>
            {i < steps.length - 1 && <span className="h-px w-6 bg-line" />}
          </li>
        ))}
      </ol>

      {step === "source" && (
        <div className="space-y-4">
          <DropZone accept={[]} maxMb={10} busy={busy}
            onFiles={(fs) => {
              const f = fs[0];
              if (!EXT.some((e) => f.name.toLowerCase().endsWith(e))) return toast.error(tr("Upload a Word (.docx), PDF or text file"));
              setFile(f); setText("");
            }}
            icon={<UploadCloud className="size-5" />}
            title={file ? file.name : t("Drop your script here, or click to choose")}
            hint={file ? t("{kb} KB · click to choose another", { kb: Math.max(1, Math.round(file.size / 1024)) }) : t("Word (.docx), PDF or text · up to 10 MB")} />
          <div className="flex items-center gap-3 text-2xs uppercase tracking-wide text-dim"><span className="h-px flex-1 bg-line" />{t("or paste it")}<span className="h-px flex-1 bg-line" /></div>
          <Textarea rows={7} value={text} onChange={(e) => { setText(e.target.value); if (e.target.value) setFile(null); }}
            placeholder={t("Paste your script here…")} aria-label={t("Script text")} className="font-mono text-xs" />
          <div className="grid gap-4 @2xl:grid-cols-[1fr_auto]">
            <details className="rounded-xl border border-line bg-raised/40 p-3 text-xs">
              <summary className="cursor-pointer font-medium">{t("Best results: this layout (any language)")}</summary>
              <p className="mt-2 text-mute">{t("SCENE / INT. / EXT. start a scene · SHOT starts a shot (add 4s, 6s or 8s) · VISUAL: is what we see · NAME: is dialogue (add an emotion in brackets) · VO: is voice-over. Scripts in other layouts are arranged by AI, keeping your words.")}</p>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-panel p-2 font-mono text-2xs leading-relaxed">{TEMPLATE}</pre>
              <Button size="sm" variant="ghost" className="mt-1" icon={<ClipboardCopy className="size-3.5" />}
                onClick={() => { void navigator.clipboard?.writeText(TEMPLATE); toast.success(tr("Template copied")); }}>{t("Copy template")}</Button>
            </details>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-mute">{t("How to read it")}</p>
              <Segmented size="sm" value={method} onChange={setMethod} aria-label={t("How to read it")}
                options={[{ value: "auto", label: t("Auto"), title: t("Template layout if found, otherwise AI arranges it") },
                  { value: "markers", label: t("Template only"), title: t("No AI: read the layout exactly") },
                  { value: "ai", label: t("AI arranges"), title: t("AI splits it into scenes and shots, keeping your words") }]} />
              <p className="max-w-[16rem] text-2xs text-dim">{t("AI only splits and tags speakers. Lines it changed are highlighted for you.")}</p>
            </div>
          </div>
        </div>
      )}

      {step === "cast" && res && (
        <div className="space-y-3">
          <Summary res={res} />
          <p className="text-sm text-mute">{t("Who is who? Match each name in your script to a character, create a new one (add a photo to set the look), or read it as voice-over.")}</p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {res.characters.map((c) => {
              const p = picks[c.name] ?? { kind: "new" };
              const value = p.kind === "existing" ? String(p.id) : p.kind;
              const chosen = p.kind === "existing" ? pool.get(p.id) : undefined;
              return (
                <li key={c.name} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <Avatar name={chosen?.name ?? c.name} src={chosen?.avatar_url || (photos[c.name] ? URL.createObjectURL(photos[c.name]) : "")} size={32} />
                  <div className="min-w-[8rem] flex-1">
                    <p className="text-sm font-semibold">{c.name}</p>
                    <p className="text-2xs text-dim">{c.lines === 1 ? t("1 line") : c.lines ? t("{n} lines", { n: c.lines }) : t("on screen, no lines")}{c.match ? ` · ${t("matched {name}", { name: c.match.name })}` : ""}</p>
                  </div>
                  <Select value={value} className="!h-8 !w-60 text-xs" aria-label={t("Character for {name}", { name: c.name })}
                    onChange={(e) => setPicks({ ...picks, [c.name]: e.target.value === "new" ? { kind: "new" } : e.target.value === "vo" ? { kind: "vo" } : { kind: "existing", id: Number(e.target.value) } })}>
                    <option value="new">＋ {t("Create new character")}</option>
                    <option value="vo">🎙 {t("Voice-over (narrator)")}</option>
                    {!!cast?.length && <optgroup label={t("In this project")}>{cast.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>}
                    {!!library?.length && (
                      <optgroup label={t("Character library")}>
                        {library.filter((x) => !cast?.some((y) => y.id === x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </optgroup>
                    )}
                  </Select>
                  {p.kind !== "vo" && (
                    <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-mute transition-colors hover:border-accent/50 hover:text-ink">
                      <ImagePlus className="size-3.5" />{photos[c.name] ? t("Photo added") : t("Add photo")}
                      <input type="file" hidden accept="image/png,image/jpeg,image/webp"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhotos({ ...photos, [c.name]: f }); }} />
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="flex items-center gap-1.5 text-2xs text-dim"><Users className="size-3" />{t("New characters are added to this project and the library. Uploaded photos are used as their look reference.")}</p>
        </div>
      )}

      {step === "review" && res && (
        <div className="space-y-3">
          <Summary res={res} />
          {res.warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2 text-xs">
            <span className="font-medium">{t("{s} scenes · {n} shots", { s: totals.scenes, n: totals.shots })}</span>
            {changed > 0 && <Badge tone="warn">{t("{n} lines to check", { n: changed })}</Badge>}
            <div className="flex-1" />
            {hasShots && (
              <Segmented size="sm" value={mode} onChange={setMode} aria-label={t("Existing shots")}
                options={[{ value: "replace", label: t("Replace current shot list") }, { value: "append", label: t("Add after it") }]} />
            )}
          </div>
          <div className="max-h-[55vh] overflow-y-auto pr-1 @container">
            <ShotListEditor scenes={scenes} onChange={setScenes} cast={castList} codes={false} />
          </div>
        </div>
      )}
    </Modal>
  );
}

function Summary({ res }: { res: ImportResult }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-mute">
      <Badge tone={res.method === "ai" ? "accent" : "ok"}>{res.method === "ai" ? <><Sparkles className="size-3" />{t("Arranged by AI")}</> : <><Check className="size-3" />{t("Read from your layout")}</>}</Badge>
      <span>{res.source}</span>·<span>{t("{s} scenes, {n} shots, {l} lines", { s: res.stats.scenes, n: res.stats.shots, l: res.stats.lines })}</span>
    </div>
  );
}
