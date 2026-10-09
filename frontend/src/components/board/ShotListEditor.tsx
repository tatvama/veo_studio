import {
  AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, Clock, Copy, Film, ImageUp, MapPin, Mic, Plus, Sparkles, Trash2, UserRound, X,
} from "lucide-react";
import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { BoardLine, BoardScene, BoardShot, Character, VideoEngines } from "../../lib/types";
import { IdChip, SpeakerChip, sceneCode } from "../room/workspace";
import { NARRATOR_TONE, TONE_TEXT_SM, makeToneMap, type Tone } from "../room/util";
import { Avatar, Badge, Button, Input, Segmented, Select, Textarea, Tooltip } from "../ui";
import { ShotRefs, UploadKeyframeButton } from "./ShotMedia";
import { CharacterPicker, FitNotes, ModelPicker, engineFor } from "./ShotPickers";
import "../../styles/board.css";

/** Extras for the full shot builder: pick characters from the library or make new ones, and the video model per shot. */
export interface ShotPickerProps {
  projectCast: Character[]; library: Character[]; onCreateCharacter?: (name: string, photo: File | null) => Promise<Character | undefined>;
  engines?: VideoEngines; quality: string; locations?: string[];
}

let seq = 0;
export const uid = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;

export const newShot = (over: Partial<BoardShot> = {}): BoardShot => ({
  key: uid(), prompt: "", characters: [], lines: [], duration_s: 8, extend_to: 0, extend_prompt: "", framing: "", camera: "", engine: "auto", ...over,
});
export const newScene = (n: number, over: Partial<BoardScene> = {}): BoardScene => ({
  key: uid(), title: `Scene ${n}`, location: "", time_of_day: "", summary: "", shots: [newShot()], ...over,
});
/** Give every scene/shot a stable React key (rows from the server have ids, new rows get a client key). */
export const withKeys = (scenes: BoardScene[]): BoardScene[] =>
  scenes.map((s) => ({ ...s, key: s.key ?? (s.id ? `s${s.id}` : uid()), shots: s.shots.map((h) => ({ ...h, key: h.key ?? (h.id ? `h${h.id}` : uid()) })) }));

/** The element id of a scene section: the page's outline links to it. */
export const sceneAnchor = (s: BoardScene, i: number) => `sc-${s.key ?? i}`;

const EXTEND_OPTIONS = [0, 15, 22, 29];

/**
 * Column template of the shot table on wide panes: gutter | visual | cast + model | dialogue | length.
 * Below it the row folds into two columns (a gutter and a body) and, on narrow panes, into a stacked card.
 */
const COLS = "@5xl:grid-cols-[5.5rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_7rem]";

function move<T>(list: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

type ToneOf = (key: string | number | null | undefined) => Tone;

/**
 * The shot list, scene by scene. Controlled: it never saves by itself. Used by the manual shot builder and by the
 * script-import review step, so both look and behave the same.
 *
 * Layout: every scene is a section with a sticky header (scene code, title, location, time, totals, move/delete) and, on wide
 * panes, a column header; every shot is one hairline-separated row of the table below it.
 */
export function ShotListEditor({ scenes, onChange, cast, disabled, codes = true, onMediaChanged, pickers }: {
  scenes: BoardScene[]; onChange: (s: BoardScene[]) => void; cast: Character[]; disabled?: boolean; codes?: boolean;
  /** Saved shots get "Upload keyframe" and reference images; this refreshes after an upload. */
  onMediaChanged?: () => void;
  pickers?: ShotPickerProps;
}) {
  const t = useT();
  // the same colour per character as everywhere else (the cast order decides)
  const toneOf = useMemo(() => makeToneMap(cast.map((c) => c.name)), [cast]);
  const setScene = (i: number, sc: BoardScene) => onChange(scenes.map((s, k) => (k === i ? sc : s)));
  let shotNo = 0;
  return (
    <div className="@container space-y-4">
      {scenes.map((sc, i) => {
        const first = shotNo;
        shotNo += sc.shots.length;
        return (
          <SceneBlock key={sc.key} n={i + 1} anchor={sceneAnchor(sc, i)} scene={sc} firstShot={first} cast={cast} toneOf={toneOf} disabled={disabled} codes={codes}
            onMediaChanged={onMediaChanged} pickers={pickers}
            onChange={(v) => setScene(i, v)}
            onMove={(d) => onChange(move(scenes, i, d))} canUp={i > 0} canDown={i < scenes.length - 1}
            onDelete={() => onChange(scenes.filter((_, k) => k !== i))} />
        );
      })}
      {!disabled && (
        <button type="button" onClick={() => onChange([...scenes, newScene(scenes.length + 1)])}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line text-sm font-medium text-mute transition-colors hover:border-accent/50 hover:bg-accent/5 hover:text-ink">
          <Plus className="size-4" />{t("Add scene")}
        </button>
      )}
    </div>
  );
}

/** A bordered mini field with a leading icon (location, time of day). */
function HeadField({ icon, className, children }: { icon: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={cn("flex h-8 min-w-0 items-center gap-1.5 pointer-coarse:h-10 rounded-lg border border-line bg-raised/40 px-2 transition-[border-color,box-shadow] hover:border-dim/40 focus-within:border-accent/60 focus-within:ring-[3px] focus-within:ring-accent/15",
      className)}>
      <span aria-hidden className="shrink-0 text-dim [&>svg]:size-3.5">{icon}</span>
      {children}
    </label>
  );
}

function SceneBlock({ n, anchor, scene, firstShot, cast, toneOf, disabled, codes, onChange, onMove, canUp, canDown, onDelete, onMediaChanged, pickers }: {
  n: number; anchor: string; scene: BoardScene; firstShot: number; cast: Character[]; toneOf: ToneOf; disabled?: boolean; codes: boolean; onMediaChanged?: () => void;
  pickers?: ShotPickerProps;
  onChange: (s: BoardScene) => void; onMove: (d: number) => void; canUp: boolean; canDown: boolean; onDelete: () => void;
}) {
  const t = useT();
  const set = (k: keyof BoardScene, v: any) => onChange({ ...scene, [k]: v });
  const setShot = (i: number, sh: BoardShot) => set("shots", scene.shots.map((s, k) => (k === i ? sh : s)));
  const secs = scene.shots.reduce((a, s) => a + Math.max(s.extend_to || 0, s.duration_s), 0);
  const lines = scene.shots.reduce((a, s) => a + s.lines.length, 0);
  const locList = pickers?.locations ?? [];
  return (
    <section id={anchor} aria-label={t("Scene {n}", { n })} className="hud relative min-w-0 scroll-mt-4 rounded-xl border border-line bg-panel">
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-70" />

      {/* sticky: the scene header and, on wide panes, the column labels stay in view while you work through the shots */}
      <div className="z-10 rounded-t-xl bg-panel/95 backdrop-blur @3xl:sticky @3xl:top-0">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 @3xl:px-4">
          <IdChip tone="accent" className="h-6 px-2 text-xs">{sceneCode(n - 1)}</IdChip>
          <input value={scene.title} disabled={disabled} onChange={(e) => set("title", e.target.value)} aria-label={t("Scene title")}
            placeholder={t("Scene title")}
            className="h-8 min-w-0 flex-1 basis-44 pointer-coarse:h-10 rounded-lg border border-transparent bg-transparent px-2 text-sm font-semibold tracking-tight outline-none transition-[border-color,background-color] hover:border-line focus:border-accent/60 focus:bg-raised/60" />
          <HeadField icon={<MapPin />} className="flex-1 basis-40 @3xl:max-w-64">
            <input value={scene.location} disabled={disabled} onChange={(e) => set("location", e.target.value)} placeholder={t("Location (e.g. Temple courtyard)")}
              aria-label={t("Location")} list={locList.length ? `locs-${scene.key}` : undefined} className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-dim" />
            {!!locList.length && <datalist id={`locs-${scene.key}`}>{locList.map((l) => <option key={l} value={l} />)}</datalist>}
          </HeadField>
          <HeadField icon={<Clock />} className="basis-32 flex-1 @3xl:max-w-36 @3xl:flex-none">
            <input value={scene.time_of_day} disabled={disabled} onChange={(e) => set("time_of_day", e.target.value)} placeholder={t("Time of day")}
              aria-label={t("Time of day")} className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-dim" />
          </HeadField>
          <span className="mono ml-auto hidden text-2xs text-dim @xl:inline">
            {scene.shots.length === 1 ? t("1 shot · {s}s", { s: secs }) : t("{n} shots · {s}s", { n: scene.shots.length, s: secs })}
            {lines ? ` · ${lines === 1 ? t("1 line") : t("{n} lines", { n: lines })}` : ""}
          </span>
          {!disabled && (
            <div className="ml-auto flex items-center @xl:ml-0">
              <IconBtn label={t("Move scene up")} disabled={!canUp} onClick={() => onMove(-1)}><ArrowUp /></IconBtn>
              <IconBtn label={t("Move scene down")} disabled={!canDown} onClick={() => onMove(1)}><ArrowDown /></IconBtn>
              <IconBtn label={t("Delete scene")} danger onClick={onDelete}><Trash2 /></IconBtn>
            </div>
          )}
        </header>
        {!!scene.shots.length && (
          <div aria-hidden className={cn("eyebrow hidden gap-x-3 border-b border-line bg-raised/30 px-4 py-1.5 @5xl:grid", COLS)}>
            <span>{t("Shot")}</span><span>{t("Visual")}</span><span>{t("Cast")} · {t("Model")}</span><span>{t("Dialogue")}</span><span>{t("Length")}</span>
          </div>
        )}
      </div>

      {scene.shots.length ? (
        <ol className="divide-y divide-line">
          {scene.shots.map((sh, i) => (
            <ShotRow key={sh.key} no={firstShot + i + 1} shot={sh} cast={cast} toneOf={toneOf} disabled={disabled} codes={codes} onMediaChanged={onMediaChanged}
              pickers={pickers} hasLocation={!!scene.location.trim()}
              onChange={(v) => setShot(i, v)}
              onMove={(d) => set("shots", move(scene.shots, i, d))} canUp={i > 0} canDown={i < scene.shots.length - 1}
              onDuplicate={() => set("shots", [...scene.shots.slice(0, i + 1), { ...sh, id: null, key: uid(), code: undefined, thumb_url: "", has_video: false, video_s: 0, status: undefined, lines: sh.lines.map((l) => ({ ...l })) }, ...scene.shots.slice(i + 1)])}
              onDelete={() => set("shots", scene.shots.filter((_, k) => k !== i))} />
          ))}
        </ol>
      ) : (
        <p className="px-4 py-5 text-xs text-dim">{t("No shots in this scene yet.")}</p>
      )}

      {!disabled && (
        <footer className="flex items-center gap-2 border-t border-line px-3 py-2 @3xl:px-4">
          <Button size="sm" variant="outline" className="pointer-coarse:h-10" icon={<Plus className="size-3.5" />}
            onClick={() => set("shots", [...scene.shots, newShot({ characters: scene.shots.at(-1)?.characters ?? [] })])}>
            {t("Add shot")}
          </Button>
        </footer>
      )}
    </section>
  );
}

/** Small label over a cell. Hidden on wide panes, where the column header says it. */
function CellLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("eyebrow mb-1.5 @5xl:hidden", className)}>{children}</p>;
}

function ShotRow({ no, shot, cast, toneOf, disabled, codes, onChange, onMove, canUp, canDown, onDuplicate, onDelete, onMediaChanged, pickers, hasLocation }: {
  no: number; shot: BoardShot; cast: Character[]; toneOf: ToneOf; disabled?: boolean; codes: boolean; onChange: (s: BoardShot) => void; onMediaChanged?: () => void;
  pickers?: ShotPickerProps; hasLocation: boolean;
  onMove: (d: number) => void; canUp: boolean; canDown: boolean; onDuplicate: () => void; onDelete: () => void;
}) {
  const t = useT();
  const [more, setMore] = useState(!!(shot.framing || shot.camera || shot.extend_prompt));
  const set = (k: keyof BoardShot, v: any) => onChange({ ...shot, [k]: v });
  const setLine = (i: number, l: BoardLine) => {
    const lines = shot.lines.map((x, k) => (k === i ? l : x));
    // whoever speaks on screen is in the shot
    const chars = l.speaker !== "VO" && !shot.characters.includes(l.speaker) ? [...shot.characters, l.speaker] : shot.characters;
    onChange({ ...shot, lines, characters: chars });
  };
  const toggleChar = (id: number) => set("characters", shot.characters.includes(id) ? shot.characters.filter((c) => c !== id) : [...shot.characters, id]);
  const speakers = new Set(shot.lines.filter((l) => l.speaker !== "VO").map((l) => l.speaker));
  const total = Math.max(shot.extend_to || 0, shot.duration_s);
  const changed = shot.lines.some((l) => l.changed);
  const label = codes && shot.code ? shot.code : `#${no}`;
  const noPrompt = !shot.prompt.trim();
  const extended = total > shot.duration_s;
  const lenText = extended ? t("{a}s → {b}s with extensions", { a: shot.duration_s, b: total }) : `${shot.duration_s}s`;

  return (
    <li data-shot={label} data-changed={changed || undefined}
      className={cn("bd-row relative grid gap-x-3 gap-y-3 px-3 py-3 @3xl:grid-cols-[5.5rem_minmax(0,1fr)] @3xl:px-4", COLS)}>
      {/* ── gutter: the shot code, its status, and the row actions ─────────────────── */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 @3xl:flex-col @3xl:items-start">
        <span className="mono text-xs font-semibold tracking-wide text-ink">{label}</span>
        <span className="flex flex-wrap items-center gap-1 @3xl:flex-col @3xl:items-start">
          {shot.has_video ? <Badge tone="ok"><Film className="size-3" />{t("video {s}s", { s: shot.video_s ?? 0 })}</Badge>
            : shot.thumb_url ? <Badge tone="info"><ImageUp className="size-3" />{shot.keyframe_uploaded ? t("your keyframe") : t("keyframe")}</Badge> : null}
          {shot.generating && <Badge tone="accent"><span className="eq" aria-hidden><i /><i /><i /><i /></span>{t("generating")}</Badge>}
        </span>
        {!disabled && (
          <div className="bd-act ml-auto flex items-center @3xl:ml-0 @3xl:grid @3xl:grid-cols-2">
            <IconBtn label={t("Move shot up")} disabled={!canUp} onClick={() => onMove(-1)}><ArrowUp /></IconBtn>
            <IconBtn label={t("Move shot down")} disabled={!canDown} onClick={() => onMove(1)}><ArrowDown /></IconBtn>
            <IconBtn label={t("Duplicate shot")} onClick={onDuplicate}><Copy /></IconBtn>
            <IconBtn label={t("Delete shot")} danger onClick={onDelete}><Trash2 /></IconBtn>
          </div>
        )}
      </div>

      {/* ── body: two columns on medium panes, the table's four cells on wide ones ──── */}
      <div className="grid min-w-0 gap-3 @3xl:grid-cols-2 @3xl:gap-x-4 @5xl:contents">
        <div className="flex min-w-0 flex-col gap-3 @5xl:contents">
          {/* visual */}
          <div className="min-w-0">
            <CellLabel>{t("Visual")}</CellLabel>
            <div className="flex gap-2">
              {shot.thumb_url && (
                <span className={cn("relative shrink-0 self-start rounded-md", shot.generating && "gen-ring")}>
                  <img src={shot.thumb_url} alt="" className="h-[4.5rem] w-auto max-w-24 rounded-md border border-line object-cover" />
                </span>
              )}
              <Textarea rows={3} value={shot.prompt} disabled={disabled} onChange={(e) => set("prompt", e.target.value)} aria-label={t("Visual prompt")}
                placeholder={t("What we see: subject, action, setting, light… (e.g. Close-up of wrinkled hands opening a brass lamp)")}
                aria-invalid={noPrompt && !disabled ? true : undefined}
                className={cn("min-h-[4.5rem] min-w-0 flex-1 field-sizing-content max-h-56 text-sm", noPrompt && !disabled && "border-warn/45")} />
            </div>
            {shot.id && onMediaChanged && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line px-2 py-1.5">
                {!disabled && <UploadKeyframeButton shotId={shot.id} onDone={onMediaChanged} label={shot.keyframe_uploaded ? t("Replace your keyframe") : t("Upload keyframe")} />}
                <span className="text-2xs text-dim">{t("References:")}</span>
                <ShotRefs shotId={shot.id} refs={shot.ref_images ?? []} canEdit={!disabled} onChanged={onMediaChanged} compact />
              </div>
            )}
            <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more}
              className="mt-2 flex items-center gap-1 rounded text-2xs font-medium text-dim transition-colors hover:text-ink pointer-coarse:h-8">
              <ChevronDown className={cn("size-3 transition-transform", more && "rotate-180")} />{t("Camera & extension details")}
            </button>
            {more && (
              <div className="mt-1.5 grid gap-2 @md:grid-cols-2 @3xl:grid-cols-1">
                <Input value={shot.framing} disabled={disabled} onChange={(e) => set("framing", e.target.value)} placeholder={t("Framing (close-up, wide…)")} aria-label={t("Framing")} className="h-8 text-xs pointer-coarse:h-10" />
                <Input value={shot.camera} disabled={disabled} onChange={(e) => set("camera", e.target.value)} placeholder={t("Camera (slow push-in…)")} aria-label={t("Camera")} className="h-8 text-xs pointer-coarse:h-10" />
                {!!shot.extend_to && (
                  <Input value={shot.extend_prompt} disabled={disabled} onChange={(e) => set("extend_prompt", e.target.value)} className="h-8 text-xs pointer-coarse:h-10 @md:col-span-2 @3xl:col-span-1"
                    placeholder={t("What happens in the extra seconds (optional — default: the action continues)")} aria-label={t("Extension prompt")} />
                )}
              </div>
            )}
          </div>

          {/* cast + model */}
          <div className="min-w-0">
            <CellLabel>{t("Cast")} · {t("Model")}</CellLabel>
            {pickers ? (
              <ShotCast shot={shot} cast={cast} pickers={pickers} disabled={disabled} hasLocation={hasLocation}
                onToggle={toggleChar} onEngine={(id) => set("engine", id)} />
            ) : (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Characters in shot")}>
                <UserRound className="size-3.5 text-dim" aria-hidden />
                {cast.map((c) => {
                  const on = shot.characters.includes(c.id);
                  return (
                    <button key={c.id} type="button" disabled={disabled} aria-pressed={on} onClick={() => toggleChar(c.id)}
                      className={cn("flex h-6 items-center gap-1 rounded-md border pl-0.5 pr-1.5 text-2xs transition-colors disabled:opacity-60 pointer-coarse:h-8",
                        on ? "border-accent/50 bg-accent/10 text-ink" : "border-line text-mute hover:border-dim/60 hover:text-ink")}>
                      <Avatar name={c.name} src={c.avatar_url} size={18} />{c.name}{on && <Check className="size-3 text-accent-ink" strokeWidth={3} />}
                    </button>
                  );
                })}
                {!cast.length && <span className="text-2xs text-dim">{t("No characters yet — add them in Cast › Characters & places.")}</span>}
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3 @5xl:contents">
          {/* dialogue */}
          <div className="flex min-w-0 flex-col gap-1.5">
            <CellLabel className="mb-0">{t("Dialogue")}</CellLabel>
            {speakers.size > 1 && (
              <p className={cn("flex items-start gap-1.5 rounded-md bg-warn/10 px-2 py-1 text-2xs", TONE_TEXT_SM.warn)}>
                <AlertTriangle className="mt-px size-3 shrink-0" />{t("Two people speak in this shot — one speaker per shot lip-syncs best")}
              </p>
            )}
            {shot.lines.map((l, i) => {
              const vo = l.speaker === "VO";
              const person = vo ? undefined : cast.find((c) => c.id === l.speaker);
              const name = vo ? t("Voice-over") : person?.name ?? String(l.speaker);
              const tone = vo ? NARRATOR_TONE : toneOf(name);
              return (
                <div key={i} className={cn("relative rounded-lg border py-1.5 pl-3 pr-1.5", l.changed ? "border-warn/60 bg-warn/5" : "border-line bg-raised/30")}>
                  <span aria-hidden className={cn("absolute inset-y-1.5 left-1 w-0.5 rounded-full bg-current", tone.className)} style={tone.style} />
                  <div className="flex items-center gap-1.5">
                    <label className="relative inline-flex min-w-0 max-w-[55%] shrink-0 rounded-md focus-within:ring-2 focus-within:ring-accent/60">
                      <SpeakerChip name={name} tone={tone} icon={vo ? <Mic /> : undefined} className="h-7 pr-6 pointer-coarse:h-10" />
                      <ChevronDown aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-dim" />
                      <select value={String(l.speaker)} disabled={disabled} aria-label={t("Speaker")} className="absolute inset-0 size-full opacity-0"
                        onChange={(e) => setLine(i, { ...l, speaker: e.target.value === "VO" ? "VO" : Number(e.target.value), changed: false })}>
                        <option value="VO">🎙 {t("Voice-over")}</option>
                        {cast.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </label>
                    <Input value={l.emotion} disabled={disabled} placeholder={t("delivery (soft, angry…)")} aria-label={t("Delivery")}
                      onChange={(e) => setLine(i, { ...l, emotion: e.target.value })} className="h-7 min-w-0 flex-1 text-2xs pointer-coarse:h-10" />
                    {l.changed && (
                      <Tooltip content={t("These words differ from your script — check them")}>
                        <span role="img" aria-label={t("These words differ from your script — check them")} className={cn("grid size-7 shrink-0 place-items-center", TONE_TEXT_SM.warn)}><AlertTriangle className="size-3.5" /></span>
                      </Tooltip>
                    )}
                    {!disabled && (
                      <IconBtn label={t("Remove line")} danger onClick={() => set("lines", shot.lines.filter((_, k) => k !== i))}><Trash2 /></IconBtn>
                    )}
                  </div>
                  <Textarea rows={1} value={l.text} disabled={disabled} aria-label={t("Line")} placeholder={t("What they say…")}
                    onChange={(e) => setLine(i, { ...l, text: e.target.value, changed: false })} className="mt-1 min-h-9 field-sizing-content text-sm" />
                </div>
              );
            })}
            {!shot.lines.length && <p className="px-0.5 text-2xs text-dim">{t("No dialogue — a silent shot (music and sound only).")}</p>}
            {!disabled && (
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" className="pointer-coarse:h-10" icon={<Mic className="size-3.5" />}
                  onClick={() => set("lines", [...shot.lines, { speaker: shot.characters[0] ?? cast[0]?.id ?? "VO", text: "", emotion: "" }])}>
                  {t("Add dialogue")}
                </Button>
                <Button size="sm" variant="ghost" className="pointer-coarse:h-10" icon={<Sparkles className="size-3.5" />}
                  onClick={() => set("lines", [...shot.lines, { speaker: "VO", text: "", emotion: "" }])}>
                  {t("Add voice-over")}
                </Button>
              </div>
            )}
          </div>

          {/* length: duration, extension, total */}
          <div className="min-w-0">
            <CellLabel>{t("Length")}</CellLabel>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 @5xl:flex-col @5xl:items-stretch">
              <Segmented size="sm" aria-label={t("Length")} value={shot.duration_s} onChange={(v) => !disabled && set("duration_s", v)}
                className="mono pointer-coarse:[&_button]:h-9 @5xl:flex @5xl:[&>button]:flex-1" options={[4, 6, 8].map((d) => ({ value: d, label: `${d}s` }))} />
              <Tooltip content={t("Make the clip longer with Veo extensions (about 7s each)")}>
                <Select value={shot.extend_to || 0} disabled={disabled} aria-label={t("Extend to")} className="mono h-7 w-32 pl-2 pr-6! text-2xs pointer-coarse:h-10 @5xl:w-full"
                  onChange={(e) => set("extend_to", Number(e.target.value))}>
                  {EXTEND_OPTIONS.filter((x) => x === 0 || x > shot.duration_s).map((x) => (
                    <option key={x} value={x}>{x ? t("Extend to {s}s", { s: x }) : t("No extension")}</option>
                  ))}
                </Select>
              </Tooltip>
              <p className={cn("mono text-sm font-semibold @5xl:mt-0.5", extended ? "text-accent-ink" : "text-ink")} title={lenText}>
                <span className="sr-only">{lenText}</span>
                <span aria-hidden>{extended ? `${shot.duration_s}s → ${total}s` : `${total}s`}</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Who is in the shot (chips + "+ Character") and which video model makes it, with warnings when they don't fit. */
function ShotCast({ shot, cast, pickers, disabled, hasLocation, onToggle, onEngine }: {
  shot: BoardShot; cast: Character[]; pickers: ShotPickerProps; disabled?: boolean; hasLocation: boolean;
  onToggle: (id: number) => void; onEngine: (id: string) => void;
}) {
  const t = useT();
  const byId = new Map([...pickers.library, ...pickers.projectCast, ...cast].map((c) => [c.id, c]));
  const inShot = shot.characters.map((id) => byId.get(id)).filter((c): c is Character => !!c);
  const engineId = shot.engine || "auto";
  const engine = engineFor(engineId, pickers.engines, pickers.quality);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Characters in shot")}>
        <UserRound className="size-3.5 text-dim" aria-hidden />
        {inShot.map((c) => (
          <span key={c.id} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-accent/40 bg-accent/10 pl-0.5 pr-1 text-2xs pointer-coarse:h-8">
            <Avatar name={c.name} src={c.avatar_url} size={18} /><span className="truncate">{c.name}</span>
            {!disabled && (
              <button type="button" onClick={() => onToggle(c.id)} aria-label={t("Remove {name} from this shot", { name: c.name })}
                className="grid size-4 shrink-0 place-items-center rounded text-dim hover:bg-bad/15 hover:text-bad pointer-coarse:size-6"><X className="size-3" /></button>
            )}
          </span>
        ))}
        {!inShot.length && <span className="text-2xs text-dim">{t("Nobody in this shot")}</span>}
        {!disabled && (
          <CharacterPicker selected={shot.characters} projectCast={pickers.projectCast} library={pickers.library}
            onToggle={onToggle} onCreate={pickers.onCreateCharacter} />
        )}
      </div>
      <ModelPicker value={engineId} data={pickers.engines} quality={pickers.quality} onChange={onEngine} disabled={disabled}
        needsCharacters={inShot.length > 0} characters={inShot} />
      <FitNotes engine={engine} auto={engineId === "auto"} characters={inShot} hasLocation={hasLocation}
        refCount={shot.ref_images?.length ?? 0} hasLines={shot.lines.some((l) => l.text.trim())}
        alternatives={pickers.engines?.engines ?? []} onSwitch={onEngine} />
    </div>
  );
}

function IconBtn({ label, onClick, disabled, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactElement;
}) {
  return (
    <Tooltip content={label}>
      <button type="button" aria-label={label} disabled={disabled} onClick={onClick}
        className={cn("grid size-7 shrink-0 place-items-center rounded-md text-dim transition-colors disabled:pointer-events-none disabled:opacity-30 pointer-coarse:size-10 [&>svg]:size-3.5",
          danger ? "hover:bg-bad/10 hover:text-bad" : "hover:bg-hover hover:text-ink")}>
        {children}
      </button>
    </Tooltip>
  );
}
