import { clsx } from "clsx";
import {
  AudioLines, Check, ChevronDown, Clapperboard, ExternalLink, Image as ImageIcon, MapPin, MessageSquareText, Plus, SlidersHorizontal,
  StepForward, Trash2, UserPlus, X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { SaveStatus, type SaveState } from "../../../components/room/kit";
import { Avatar, Button, IconButton, Input, Menu, Segmented, Select, Textarea, Tooltip } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useEditLock, useLockHolder } from "../../../lib/collab";
import { SHOT_MODES, VOICE_MODES } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useVideoEngines } from "../../../lib/queries";
import type { Character, DialogueLine, Episode, Location, Shot } from "../../../lib/types";
import type { ShotV3Fields } from "../../../lib/v3";
import { outlineOrder } from "../studio/Outline";
import { useActions } from "./actions";
import type { SceneX } from "./data";
import { LINK_LABEL, LINK_MODES, lengthLabel, makeBody, shotDots, type LinkMode, type ShotInfo } from "./model";
import { ModeIcon } from "./nodes";
import { Faces, PriceButton, StepDots } from "./parts";

type ShotX = Shot & ShotV3Fields;

const FRAMINGS = ["extreme wide shot", "wide shot", "medium wide shot", "medium shot", "medium close-up", "close-up", "extreme close-up",
  "over-the-shoulder", "point of view", "two shot", "insert"];
const CAMERAS = ["static", "slow push in", "pull out", "pan left", "pan right", "tilt up", "tilt down", "tracking", "handheld", "crane up",
  "orbit", "dolly zoom"];
const TIMES = ["dawn", "morning", "day", "afternoon", "golden hour", "evening", "dusk", "night"];
const EXTEND_STEPS = [15, 22, 29];

/**
 * Edits that save themselves: `set` marks a field changed, and the changed fields go to `save` after a pause (or at once
 * when the panel closes). While there are unsaved edits, the server's copy doesn't overwrite the form.
 */
function useAutosave<T extends object>(server: T, resetKey: string | number, save: (changed: Partial<T>, all: T) => Promise<void>) {
  const [form, setForm] = useState<T>(server);
  const [state, setState] = useState<SaveState>("clean");
  const dirty = useRef(new Set<keyof T>());
  const formRef = useRef(form);
  formRef.current = form;
  const saveRef = useRef(save);
  saveRef.current = save;
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef(false);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!dirty.current.size || saving.current) return;
    const keys = [...dirty.current];
    dirty.current.clear();
    const all = formRef.current;
    const changed = Object.fromEntries(keys.map((k) => [k, all[k]])) as Partial<T>;
    saving.current = true;
    setState("saving");
    try {
      await saveRef.current(changed, all);
      setState(dirty.current.size ? "dirty" : "saved");
    } catch {
      keys.forEach((k) => dirty.current.add(k)); // try again with the next edit
      setState("dirty");
    } finally { saving.current = false; }
    if (dirty.current.size) timer.current = window.setTimeout(() => void flush(), 900);
  }, []);

  const set = useCallback(<K extends keyof T>(k: K, v: T[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    dirty.current.add(k);
    setState("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 900);
  }, [flush]);

  // the server's copy wins whenever nothing is waiting to be saved
  const serverKey = JSON.stringify(server);
  useEffect(() => {
    if (!dirty.current.size && !saving.current) setForm(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);
  // a different shot / scene: save what was typed for the one before
  useEffect(() => () => { void flush(); }, [resetKey, flush]);
  return { form, set, state, flush };
}

function Section({ icon, title, children, open: start = true }: { icon: ReactNode; title: string; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(start);
  const id = useId();
  return (
    <section className="border-b border-line">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center gap-2 px-3 text-left hover:bg-hover/50">
        <span className="text-dim [&>svg]:size-3.5">{icon}</span>
        <span className="eyebrow flex-1 !text-ink">{title}</span>
        <ChevronDown className={clsx("size-3.5 text-dim transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div id={id} className="space-y-3 px-3 pb-3.5">{children}</div>}
    </section>
  );
}

function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return <span className="mb-1 flex items-baseline justify-between gap-2 text-2xs font-medium text-mute">{children}{hint && <span className="text-dim">{hint}</span>}</span>;
}

// ── shot ─────────────────────────────────────────────────────────────────────

interface ShotForm {
  action: string; lines: DialogueLine[]; narration: string; framing: string; camera: string; location_id: number | null;
  outfits: Record<string, string>; sfx: string; engine: string; mode: string; voice_mode: string; duration_s: number; extend_to: number;
}

function shotForm(s: Shot, lang: string): ShotForm {
  return {
    action: s.action ?? "", lines: (s.dialogue?.[lang] ?? []).map((l) => ({ ...l })), narration: s.narration?.[lang] ?? "",
    framing: s.framing ?? "", camera: s.camera ?? "", location_id: s.location_id ?? null, outfits: { ...(s.outfits ?? {}) },
    sfx: s.sfx ?? "", engine: s.engine || "auto", mode: s.mode || "auto", voice_mode: s.voice_mode || "auto",
    duration_s: s.duration_s, extend_to: s.extend_to || 0,
  };
}

export function ShotInspector({ shot, episode, cast, places, info, lang, onClose }: {
  shot: ShotX; episode: Episode; cast: Character[]; places: Location[]; info?: ShotInfo; lang: string; onClose: () => void;
}) {
  const t = useT();
  const a = useActions();
  const save = async (c: Partial<ShotForm>) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      if (k === "lines") body.dialogue = { ...(shot.dialogue ?? {}), [lang]: (v as DialogueLine[]).filter((l) => l.line.trim()) };
      else if (k === "narration") body.narration = { ...(shot.narration ?? {}), [lang]: String(v).trim() };
      else body[k] = v;
    }
    await api.patch(`/api/shots/${shot.id}`, body);
    a.refresh();
  };
  const server = useMemo(() => shotForm(shot, lang), [shot, lang]);
  const { form, set, state } = useAutosave(server, shot.id, save);
  const editing = state === "dirty" || state === "saving";
  const lock = useEditLock(a.canEdit ? `shot:${shot.id}` : null, editing);
  const other = useLockHolder(`shot:${shot.id}`, `board:${shot.episode_id}`);
  const lockedBy = lock.held ? undefined : lock.holder?.name ?? other?.name;
  const ro = !a.canEdit || !!lockedBy;
  const { data: engines } = useVideoEngines();
  const people = shot.characters.map((id) => cast.find((c) => c.id === id)).filter((c): c is Character => !!c);
  const dots = useMemo(() => shotDots(shot, info), [shot, info]);
  const speakers = [...people, ...cast.filter((c) => !shot.characters.includes(c.id))];
  const order = useMemo(() => outlineOrder(episode), [episode]);
  const others = order.filter((id) => id !== shot.id).map((id) => episode.shots?.find((s) => s.id === id)).filter((s): s is Shot => !!s);
  const linkFrom = shot.continuity_from_shot_id ?? null;
  const linkMode = (shot.continuity_mode ?? "last_frame") as LinkMode;
  const poster = shot.video?.thumb_url || shot.keyframe?.thumb_url || "";
  const approved = shot.status === "approved";

  const setLine = (i: number, patch: Partial<DialogueLine>) => set("lines", form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="mono rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-2xs font-semibold text-accent-ink">{shot.code}</span>
        <span className="mono text-2xs tabular-nums text-dim">{lengthLabel(shot.duration_s, shot.extend_to)}</span>
        <span className="flex-1" />
        {state !== "clean" && <SaveStatus state={state} />}
        <IconButton title={t("Close")} onClick={onClose} className="size-7 pointer-coarse:size-10"><X className="size-4" /></IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-2.5 p-3">
          <div className="scr relative aspect-video">
            {shot.video?.url ? <video key={shot.video.url} src={shot.lipsync?.url || shot.video.url} poster={poster || undefined} controls playsInline className="size-full object-contain" />
              : poster ? <img src={poster} alt="" className="size-full object-contain" />
              : <div className="scr-empty grid size-full place-items-center text-white/35"><ImageIcon className="size-7" /></div>}
          </div>
          <StepDots dots={dots} size="lg" canEdit={a.canEdit} onRun={(s) => void a.runStep(shot.id, s)} className="justify-between" />
          {lockedBy && <p className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-2xs text-warn">{t("{name} is editing this shot: you can look, not change.", { name: lockedBy })}</p>}
        </div>

        <Section icon={<MessageSquareText />} title={t("Words")}>
          <label className="block">
            <Label>{t("What happens")}</Label>
            <Textarea value={form.action} disabled={ro} onChange={(e) => set("action", e.target.value)} rows={3}
              placeholder={t("Ravi opens the old pickle jar; sunlight on his hands")} className="min-h-[76px] text-xs" />
          </label>
          <div>
            <Label hint={t("one speaker per shot works best")}>{t("Lines")}</Label>
            <div className="space-y-1.5">
              {form.lines.map((l, i) => (
                <div key={i} className="rounded-lg border border-line bg-raised/40 p-1.5">
                  <div className="flex items-center gap-1.5">
                    <Select value={String(l.character_id)} disabled={ro} aria-label={t("Who says it")} className="h-8 pointer-coarse:h-10 flex-1 px-2 text-xs"
                      onChange={(e) => setLine(i, { character_id: Number(e.target.value) })}>
                      {speakers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      {!speakers.some((c) => String(c.id) === String(l.character_id)) && <option value={String(l.character_id)}>{t("Someone")}</option>}
                    </Select>
                    <Input value={l.emotion ?? ""} disabled={ro} placeholder={t("how")} aria-label={t("How it's said")} className="h-8 pointer-coarse:h-10 w-20 px-2 text-xs"
                      onChange={(e) => setLine(i, { emotion: e.target.value })} />
                    {!ro && <IconButton title={t("Remove the line")} className="size-8" onClick={() => set("lines", form.lines.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></IconButton>}
                  </div>
                  <Textarea value={l.line} disabled={ro} rows={2} aria-label={t("The line")} className="mt-1.5 min-h-[52px] text-xs"
                    onChange={(e) => setLine(i, { line: e.target.value })} />
                </div>
              ))}
              {!ro && speakers.length > 0 && (
                <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />}
                  onClick={() => set("lines", [...form.lines, { character_id: speakers[0].id, line: "", emotion: "" }])}>{t("Add a line")}</Button>
              )}
            </div>
          </div>
          <label className="block">
            <Label>{t("Voice-over")}</Label>
            <Textarea value={form.narration} disabled={ro} rows={2} onChange={(e) => set("narration", e.target.value)}
              placeholder={t("Read by the narrator over this shot")} className="min-h-[52px] text-xs" />
          </label>
        </Section>

        <Section icon={<ImageIcon />} title={t("Picture")}>
          <div>
            <Label>{t("Cast")}</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {people.map((c) => (
                <span key={c.id} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-raised/60 pl-1 pr-0.5 text-xs">
                  <Avatar name={c.name} src={c.avatar_url} size={22} />{c.name}
                  {!ro && <button type="button" aria-label={t("Take {name} out", { name: c.name })} onClick={() => void a.removeCharacter(shot.id, c.id)}
                    className="grid size-6 place-items-center rounded text-dim hover:bg-hover hover:text-ink"><X className="size-3" /></button>}
                </span>
              ))}
              {!ro && cast.some((c) => !shot.characters.includes(c.id)) && (
                <Menu placement="bottom-start" width={220} trigger={(p) => (
                  <button type="button" {...p} className="inline-flex h-8 items-center gap-1 rounded-lg border border-dashed border-line px-2 text-xs text-mute hover:text-ink">
                    <UserPlus className="size-3.5" />{t("Add")}
                  </button>
                )} items={cast.filter((c) => !shot.characters.includes(c.id)).map((c) => ({
                  label: c.name, icon: <Avatar name={c.name} src={c.avatar_url} size={18} />, onClick: () => void a.addCharacter([shot.id], c.id),
                }))} />
              )}
              {!people.length && ro && <Faces people={[]} />}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <Label>{t("Framing")}</Label>
              <Input list="canvas-framings" value={form.framing} disabled={ro} onChange={(e) => set("framing", e.target.value)} className="h-8 pointer-coarse:h-10 px-2 text-xs" />
            </label>
            <label className="block">
              <Label>{t("Camera")}</Label>
              <Input list="canvas-cameras" value={form.camera} disabled={ro} onChange={(e) => set("camera", e.target.value)} className="h-8 pointer-coarse:h-10 px-2 text-xs" />
            </label>
          </div>
          <datalist id="canvas-framings">{FRAMINGS.map((f) => <option key={f} value={f} />)}</datalist>
          <datalist id="canvas-cameras">{CAMERAS.map((f) => <option key={f} value={f} />)}</datalist>
          <label className="block">
            <Label>{t("Place")}</Label>
            <Select value={form.location_id ?? ""} disabled={ro} className="h-8 pointer-coarse:h-10 px-2 text-xs"
              onChange={(e) => set("location_id", e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t("No place")}</option>
              {places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </label>
          {people.length > 0 && (
            <div>
              <Label hint={t("empty: the scene's or their usual look")}>{t("Outfits")}</Label>
              <div className="space-y-1.5">
                {people.map((c) => (
                  <label key={c.id} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 truncate text-2xs text-mute">{c.name}</span>
                    <Input value={form.outfits[String(c.id)] ?? ""} disabled={ro} className="h-8 pointer-coarse:h-10 px-2 text-xs" placeholder={t("e.g. red saree")}
                      onChange={(e) => set("outfits", { ...form.outfits, [String(c.id)]: e.target.value })} />
                  </label>
                ))}
              </div>
            </div>
          )}
        </Section>

        <Section icon={<AudioLines />} title={t("Sound")}>
          <label className="block">
            <Label>{t("Sound effects")}</Label>
            <Textarea value={form.sfx} disabled={ro} rows={2} onChange={(e) => set("sfx", e.target.value)}
              placeholder={t("A jar lid pops; birds outside")} className="min-h-[52px] text-xs" />
          </label>
        </Section>

        <Section icon={<SlidersHorizontal />} title={t("Advanced")} open={false}>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>{t("Length")}</Label>
              <Segmented size="sm" aria-label={t("Length")} value={form.duration_s} onChange={(v) => !ro && set("duration_s", v)}
                options={[4, 6, 8].map((d) => ({ value: d, label: `${d}s` }))} />
            </div>
            <label className="block">
              <Label>{t("Extend to")}</Label>
              <Select value={form.extend_to} disabled={ro} className="h-8 pointer-coarse:h-10 w-28 px-2 text-xs" onChange={(e) => set("extend_to", Number(e.target.value))}>
                <option value={0}>{t("No")}</option>
                {EXTEND_STEPS.filter((s) => s > form.duration_s).map((s) => <option key={s} value={s}>{s}s</option>)}
              </Select>
            </label>
          </div>
          <label className="block">
            <Label>{t("Video engine")}</Label>
            <Select value={form.engine} disabled={ro} className="h-8 pointer-coarse:h-10 px-2 text-xs" onChange={(e) => set("engine", e.target.value)}>
              <option value="auto">{t("Auto (Google first)")}</option>
              {(engines?.engines ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              {form.engine !== "auto" && !(engines?.engines ?? []).some((m) => m.id === form.engine) && <option value={form.engine}>{form.engine}</option>}
            </Select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <Label>{t("How it's made")}</Label>
              <Select value={form.mode} disabled={ro} className="h-8 pointer-coarse:h-10 px-2 text-xs" onChange={(e) => set("mode", e.target.value)}>
                {Object.entries(SHOT_MODES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
              </Select>
            </label>
            <label className="block">
              <Label>{t("Voices")}</Label>
              <Select value={form.voice_mode} disabled={ro} className="h-8 pointer-coarse:h-10 px-2 text-xs" onChange={(e) => set("voice_mode", e.target.value)}>
                {Object.entries(VOICE_MODES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
              </Select>
            </label>
          </div>
          <div>
            <Label>{t("Continues from")}</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              <Select value={linkFrom ?? ""} disabled={ro} className="h-8 pointer-coarse:h-10 flex-1 px-2 text-xs"
                onChange={(e) => void a.link(shot.id, e.target.value ? Number(e.target.value) : null, linkMode)}>
                <option value="">{t("No other shot")}</option>
                {others.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.action.slice(0, 40)}</option>)}
              </Select>
              {linkFrom != null && (
                <Segmented size="sm" aria-label={t("How it continues")} value={linkMode} onChange={(m) => !ro && void a.setLinkMode(shot.id, m)}
                  options={LINK_MODES.map((m) => ({ value: m, label: <span className="inline-flex items-center gap-1"><ModeIcon mode={m} className="size-3" />{t(LINK_LABEL[m])}</span> }))} />
              )}
            </div>
          </div>
        </Section>
      </div>
      {a.canEdit && (
        <footer className="sticky bottom-0 space-y-2 border-t border-line bg-panel p-3">
          <PriceButton eid={a.eid} block size="md" body={makeBody([shot.id])} label={t("Make it")} doneLabel={t("Everything is made")}
            icon={<Clapperboard className="size-4" />} className="pointer-coarse:h-11" onRun={() => a.make([shot.id], t("Make {code}", { code: shot.code }))}
            title={t("Make what this shot still needs: picture, video, voice and sound (you see the price first)")} />
          <div className="flex gap-1.5">
            <Button size="sm" variant={approved ? "secondary" : "outline"} className="flex-1 pointer-coarse:h-10" icon={<Check className={clsx("size-3.5", approved && "text-ok")} />}
              disabled={!shot.video} onClick={() => void a.approve(shot.id, !approved)}>{approved ? t("Approved") : t("Approve")}</Button>
            <Tooltip content={t("Add the next shot: same cast and place, continuing from this one")}>
              <Button size="sm" variant="ghost" className="pointer-coarse:h-10" icon={<StepForward className="size-3.5" />} onClick={() => void a.nextShot(shot.id)}>{t("Next")}</Button>
            </Tooltip>
            <Tooltip content={t("Takes, prompt, effects and comments")}>
              <Button size="sm" variant="ghost" className="pointer-coarse:h-10" icon={<ExternalLink className="size-3.5" />} onClick={() => a.openShot(shot.id)}>{t("More")}</Button>
            </Tooltip>
          </div>
        </footer>
      )}
    </div>
  );
}

// ── scene ────────────────────────────────────────────────────────────────────

interface SceneForm { title: string; time_of_day: string; mood: string; look: string; sound: string; music: string }

export function SceneInspector({ scene, shotIds, places, onClose }: {
  scene: SceneX; shotIds: number[]; places: Location[]; onClose: () => void;
}) {
  const t = useT();
  const a = useActions();
  const server = useMemo<SceneForm>(() => ({
    title: scene.title ?? "", time_of_day: scene.time_of_day ?? "", mood: scene.emotion ?? "", look: scene.look ?? "",
    sound: scene.sound ?? "", music: scene.music ?? "",
  }), [scene]);
  const save = async (c: Partial<SceneForm>) => {
    const card: Record<string, unknown> = {};
    if (c.title !== undefined) card.title = c.title.trim() || scene.title;
    if (c.time_of_day !== undefined) card.time_of_day = c.time_of_day.trim();
    const notes = Object.fromEntries((["mood", "look", "sound", "music"] as const).filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
    if (Object.keys(card).length) await api.patch(`/api/scenes/${scene.id}`, card);
    if (Object.keys(notes).length) await api.patch(`/api/scenes/${scene.id}/notes`, notes);
    a.refresh();
  };
  const { form, set, state } = useAutosave(server, scene.id, save);
  const ro = !a.canEdit;
  const field = (k: keyof SceneForm, label: string, placeholder: string, rows = 2) => (
    <label className="block">
      <Label>{label}</Label>
      <Textarea value={form[k]} disabled={ro} rows={rows} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} className="min-h-[52px] text-xs" />
    </label>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="eyebrow !text-ink">{t("Scene")}</span>
        <span className="mono text-2xs text-dim">{t("{n} shots", { n: shotIds.length })}</span>
        <span className="flex-1" />
        {state !== "clean" && <SaveStatus state={state} />}
        <IconButton title={t("Close")} onClick={onClose} className="size-7 pointer-coarse:size-10"><X className="size-4" /></IconButton>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <label className="block">
          <Label>{t("Title")}</Label>
          <Input value={form.title} disabled={ro} onChange={(e) => set("title", e.target.value)} className="h-9 text-sm font-semibold" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <Label>{t("Place")}</Label>
            <Select value={scene.location_id ?? ""} disabled={ro} className="h-8 pointer-coarse:h-10 px-2 text-xs"
              onChange={(e) => void a.setScenePlace(scene.id, e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t("No place")}</option>
              {places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </label>
          <label className="block">
            <Label>{t("Time of day")}</Label>
            <Input list="canvas-times" value={form.time_of_day} disabled={ro} onChange={(e) => set("time_of_day", e.target.value)} className="h-8 pointer-coarse:h-10 px-2 text-xs" />
            <datalist id="canvas-times">{TIMES.map((x) => <option key={x} value={x} />)}</datalist>
          </label>
        </div>
        <label className="block">
          <Label>{t("Mood")}</Label>
          <Input value={form.mood} disabled={ro} onChange={(e) => set("mood", e.target.value)} placeholder={t("warm, nostalgic")} className="h-8 pointer-coarse:h-10 px-2 text-xs" />
        </label>
        {field("look", t("Look"), t("Golden morning light, soft haze, warm colours"))}
        {field("sound", t("Sound"), t("Kitchen ambience, a pressure cooker far away"))}
        {field("music", t("Music"), t("Gentle flute over strings"))}
        <p className="flex items-start gap-1.5 text-2xs leading-snug text-dim"><MapPin className="mt-px size-3 shrink-0" />{t("Every shot of the scene follows its place, look, sound and music.")}</p>
      </div>
      {a.canEdit && (
        <footer className="sticky bottom-0 flex gap-1.5 border-t border-line bg-panel p-3">
          {shotIds.length > 0 && (
            <PriceButton eid={a.eid} block size="md" body={makeBody(shotIds)} label={t("Make scene")} doneLabel={t("Scene made")}
              icon={<Clapperboard className="size-4" />} onRun={() => a.make(shotIds, t("Make {scene}", { scene: scene.title }))} />
          )}
          <Button variant="outline" icon={<Plus className="size-4" />} onClick={() => void a.addShot(scene.id)}>{t("Shot")}</Button>
        </footer>
      )}
    </div>
  );
}
