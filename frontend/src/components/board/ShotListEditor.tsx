import { clsx } from "clsx";
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, Copy, Film, MapPin, Mic, Plus, Sparkles, Trash2, UserRound,
} from "lucide-react";
import { useState, type ReactElement } from "react";
import { useT } from "../../lib/i18n";
import type { BoardLine, BoardScene, BoardShot, Character, VideoEngines } from "../../lib/types";
import { Avatar, Badge, Button, Input, Segmented, Select, Textarea, Tooltip } from "../ui";
import { ShotRefs, UploadKeyframeButton } from "./ShotMedia";
import { CharacterPicker, FitNotes, ModelPicker, engineFor } from "./ShotPickers";

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

const EXTEND_OPTIONS = [0, 15, 22, 29];

function move<T>(list: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/**
 * The shot list, scene by scene. Controlled: it never saves by itself. Used by the manual shot builder and by the
 * script-import review step, so both look and behave the same.
 */
export function ShotListEditor({ scenes, onChange, cast, disabled, codes = true, onMediaChanged, pickers }: {
  scenes: BoardScene[]; onChange: (s: BoardScene[]) => void; cast: Character[]; disabled?: boolean; codes?: boolean;
  /** Saved shots get "Upload keyframe" and reference images; this refreshes after an upload. */
  onMediaChanged?: () => void;
  pickers?: ShotPickerProps;
}) {
  const t = useT();
  const setScene = (i: number, sc: BoardScene) => onChange(scenes.map((s, k) => (k === i ? sc : s)));
  let shotNo = 0;
  return (
    <div className="space-y-5">
      {scenes.map((sc, i) => {
        const first = shotNo;
        shotNo += sc.shots.length;
        return (
          <SceneBlock key={sc.key} n={i + 1} scene={sc} firstShot={first} cast={cast} disabled={disabled} codes={codes} onMediaChanged={onMediaChanged}
            pickers={pickers}
            onChange={(v) => setScene(i, v)}
            onMove={(d) => onChange(move(scenes, i, d))} canUp={i > 0} canDown={i < scenes.length - 1}
            onDelete={() => onChange(scenes.filter((_, k) => k !== i))} />
        );
      })}
      {!disabled && (
        <button type="button" onClick={() => onChange([...scenes, newScene(scenes.length + 1)])}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line py-4 text-sm font-medium text-mute transition-colors hover:border-accent/50 hover:bg-accent/5 hover:text-ink">
          <Plus className="size-4" />{t("Add scene")}
        </button>
      )}
    </div>
  );
}

function SceneBlock({ n, scene, firstShot, cast, disabled, codes, onChange, onMove, canUp, canDown, onDelete, onMediaChanged, pickers }: {
  n: number; scene: BoardScene; firstShot: number; cast: Character[]; disabled?: boolean; codes: boolean; onMediaChanged?: () => void;
  pickers?: ShotPickerProps;
  onChange: (s: BoardScene) => void; onMove: (d: number) => void; canUp: boolean; canDown: boolean; onDelete: () => void;
}) {
  const t = useT();
  const set = (k: keyof BoardScene, v: any) => onChange({ ...scene, [k]: v });
  const setShot = (i: number, sh: BoardShot) => set("shots", scene.shots.map((s, k) => (k === i ? sh : s)));
  const secs = scene.shots.reduce((a, s) => a + Math.max(s.extend_to || 0, s.duration_s), 0);
  const lines = scene.shots.reduce((a, s) => a + s.lines.length, 0);
  return (
    <section className="rounded-2xl border border-line bg-panel shadow-card" aria-label={t("Scene {n}", { n })}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        <span className="rounded-md bg-accent/12 px-1.5 py-0.5 font-mono text-2xs font-semibold text-accent-ink">SC{String(n).padStart(2, "0")}</span>
        <input value={scene.title} disabled={disabled} onChange={(e) => set("title", e.target.value)} aria-label={t("Scene title")}
          placeholder={t("Scene title")}
          className="min-w-[10rem] flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold outline-none hover:border-line focus:border-accent/60 focus:bg-raised" />
        <span className="hidden text-2xs tabular-nums text-dim sm:inline">
          {scene.shots.length === 1 ? t("1 shot · {s}s", { s: secs }) : t("{n} shots · {s}s", { n: scene.shots.length, s: secs })}
          {lines ? ` · ${lines === 1 ? t("1 line") : t("{n} lines", { n: lines })}` : ""}
        </span>
        {!disabled && (
          <div className="flex items-center">
            <IconBtn label={t("Move scene up")} disabled={!canUp} onClick={() => onMove(-1)}><ArrowUp /></IconBtn>
            <IconBtn label={t("Move scene down")} disabled={!canDown} onClick={() => onMove(1)}><ArrowDown /></IconBtn>
            <IconBtn label={t("Delete scene")} danger onClick={onDelete}><Trash2 /></IconBtn>
          </div>
        )}
      </header>
      <div className="grid gap-2 px-3 pt-3 sm:grid-cols-[1fr_10rem] sm:px-4">
        <label className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 px-2.5">
          <MapPin className="size-3.5 shrink-0 text-dim" />
          <input value={scene.location} disabled={disabled} onChange={(e) => set("location", e.target.value)} placeholder={t("Location (e.g. Temple courtyard)")}
            aria-label={t("Location")} list={pickers?.locations?.length ? `locs-${scene.key}` : undefined} className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none" />
          {!!pickers?.locations?.length && <datalist id={`locs-${scene.key}`}>{pickers.locations.map((l) => <option key={l} value={l} />)}</datalist>}
        </label>
        <Input value={scene.time_of_day} disabled={disabled} onChange={(e) => set("time_of_day", e.target.value)} placeholder={t("Time of day")}
          aria-label={t("Time of day")} className="!h-8 text-xs" />
      </div>
      <ol className="space-y-2.5 p-3 sm:p-4">
        {scene.shots.map((sh, i) => (
          <ShotRow key={sh.key} no={firstShot + i + 1} shot={sh} cast={cast} disabled={disabled} codes={codes} onMediaChanged={onMediaChanged}
            pickers={pickers} hasLocation={!!scene.location.trim()}
            onChange={(v) => setShot(i, v)}
            onMove={(d) => set("shots", move(scene.shots, i, d))} canUp={i > 0} canDown={i < scene.shots.length - 1}
            onDuplicate={() => set("shots", [...scene.shots.slice(0, i + 1), { ...sh, id: null, key: uid(), code: undefined, thumb_url: "", has_video: false, video_s: 0, status: undefined, lines: sh.lines.map((l) => ({ ...l })) }, ...scene.shots.slice(i + 1)])}
            onDelete={() => set("shots", scene.shots.filter((_, k) => k !== i))} />
        ))}
        {!scene.shots.length && <p className="px-1 text-xs text-dim">{t("No shots in this scene yet.")}</p>}
      </ol>
      {!disabled && (
        <div className="px-3 pb-3 sm:px-4 sm:pb-4">
          <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />}
            onClick={() => set("shots", [...scene.shots, newShot({ characters: scene.shots.at(-1)?.characters ?? [] })])}>
            {t("Add shot")}
          </Button>
        </div>
      )}
    </section>
  );
}

function ShotRow({ no, shot, cast, disabled, codes, onChange, onMove, canUp, canDown, onDuplicate, onDelete, onMediaChanged, pickers, hasLocation }: {
  no: number; shot: BoardShot; cast: Character[]; disabled?: boolean; codes: boolean; onChange: (s: BoardShot) => void; onMediaChanged?: () => void;
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

  return (
    <li className={clsx("rounded-xl border bg-raised/30 transition-colors", changed ? "border-warn/50" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line/70 px-2.5 py-2">
        <span className="font-mono text-2xs font-semibold text-mute">{label}</span>
        {shot.has_video ? <Badge tone="ok"><Film className="size-3" />{t("video {s}s", { s: shot.video_s ?? 0 })}</Badge>
          : shot.thumb_url ? <Badge tone="info">{shot.keyframe_uploaded ? t("your keyframe") : t("keyframe")}</Badge> : null}
        {shot.generating && <Badge tone="accent" className="pulse-ring">{t("generating")}</Badge>}
        <div className="flex-1" />
        <Segmented size="sm" aria-label={t("Length")} value={shot.duration_s} onChange={(v) => !disabled && set("duration_s", v)}
          options={[4, 6, 8].map((d) => ({ value: d, label: `${d}s` }))} />
        <Tooltip content={t("Make the clip longer with Veo extensions (about 7s each)")}>
          <Select value={shot.extend_to || 0} disabled={disabled} aria-label={t("Extend to")} className="!h-7 !w-[7.5rem] text-xs"
            onChange={(e) => set("extend_to", Number(e.target.value))}>
            {EXTEND_OPTIONS.filter((x) => x === 0 || x > shot.duration_s).map((x) => (
              <option key={x} value={x}>{x ? t("Extend to {s}s", { s: x }) : t("No extension")}</option>
            ))}
          </Select>
        </Tooltip>
        {!disabled && (
          <div className="flex items-center">
            <IconBtn label={t("Move shot up")} disabled={!canUp} onClick={() => onMove(-1)}><ArrowUp /></IconBtn>
            <IconBtn label={t("Move shot down")} disabled={!canDown} onClick={() => onMove(1)}><ArrowDown /></IconBtn>
            <IconBtn label={t("Duplicate shot")} onClick={onDuplicate}><Copy /></IconBtn>
            <IconBtn label={t("Delete shot")} danger onClick={onDelete}><Trash2 /></IconBtn>
          </div>
        )}
      </div>

      <div className="grid gap-3 p-2.5 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="min-w-0 space-y-2">
          <div className="flex gap-2">
            {shot.thumb_url && <img src={shot.thumb_url} alt="" className="h-[4.5rem] w-auto shrink-0 rounded-md border border-line object-cover" />}
            <Textarea rows={3} value={shot.prompt} disabled={disabled} onChange={(e) => set("prompt", e.target.value)} aria-label={t("Visual prompt")}
              placeholder={t("What we see: subject, action, setting, light… (e.g. Close-up of wrinkled hands opening a brass lamp)")}
              className="!min-h-[4.5rem] min-w-0 flex-1 text-sm" />
          </div>
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
                  className={clsx("flex items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-2xs transition-colors disabled:opacity-60",
                    on ? "border-accent/60 bg-accent/10 text-ink" : "border-line text-mute hover:border-dim/60 hover:text-ink")}>
                  <Avatar name={c.name} src={c.avatar_url} size={18} />{c.name}{on && <Check className="size-3 text-accent-ink" strokeWidth={3} />}
                </button>
              );
            })}
            {!cast.length && <span className="text-2xs text-dim">{t("No characters yet — add them on the Characters step or in the Bible.")}</span>}
          </div>
          )}
          {shot.id && onMediaChanged && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-raised/40 px-2 py-1.5">
              {!disabled && <UploadKeyframeButton shotId={shot.id} onDone={onMediaChanged} label={shot.keyframe_uploaded ? t("Replace your keyframe") : t("Upload keyframe")} />}
              <span className="text-2xs text-dim">{t("References:")}</span>
              <ShotRefs shotId={shot.id} refs={shot.ref_images ?? []} canEdit={!disabled} onChanged={onMediaChanged} compact />
            </div>
          )}
          <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more}
            className="flex items-center gap-1 text-2xs font-medium text-dim transition-colors hover:text-ink">
            <ChevronDown className={clsx("size-3 transition-transform", more && "rotate-180")} />{t("Camera & extension details")}
          </button>
          {more && (
            <div className="grid gap-2 @md:grid-cols-2">
              <Input value={shot.framing} disabled={disabled} onChange={(e) => set("framing", e.target.value)} placeholder={t("Framing (close-up, wide…)")} aria-label={t("Framing")} className="!h-8 text-xs" />
              <Input value={shot.camera} disabled={disabled} onChange={(e) => set("camera", e.target.value)} placeholder={t("Camera (slow push-in…)")} aria-label={t("Camera")} className="!h-8 text-xs" />
              {!!shot.extend_to && (
                <Input value={shot.extend_prompt} disabled={disabled} onChange={(e) => set("extend_prompt", e.target.value)} className="!h-8 text-xs @md:col-span-2"
                  placeholder={t("What happens in the extra seconds (optional — default: the action continues)")} aria-label={t("Extension prompt")} />
              )}
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-1.5">
          {speakers.size > 1 && (
            <p className="flex items-center gap-1.5 rounded-md bg-warn/10 px-2 py-1 text-2xs text-warn">
              <AlertTriangle className="size-3" />{t("Two people speak in this shot — one speaker per shot lip-syncs best")}
            </p>
          )}
          {shot.lines.map((l, i) => (
            <div key={i} className={clsx("rounded-lg border p-1.5", l.changed ? "border-warn/60 bg-warn/5" : "border-line bg-panel")}>
              <div className="flex items-center gap-1.5">
                <Select value={String(l.speaker)} disabled={disabled} aria-label={t("Speaker")} className="!h-7 !w-36 shrink-0 text-xs"
                  onChange={(e) => setLine(i, { ...l, speaker: e.target.value === "VO" ? "VO" : Number(e.target.value), changed: false })}>
                  <option value="VO">🎙 {t("Voice-over")}</option>
                  {cast.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
                <Input value={l.emotion} disabled={disabled} placeholder={t("delivery (soft, angry…)")} aria-label={t("Delivery")}
                  onChange={(e) => setLine(i, { ...l, emotion: e.target.value })} className="!h-7 min-w-0 flex-1 text-2xs" />
                {l.changed && (
                  <Tooltip content={t("These words differ from your script — check them")}>
                    <span className="grid size-7 shrink-0 place-items-center text-warn"><AlertTriangle className="size-3.5" /></span>
                  </Tooltip>
                )}
                {!disabled && (
                  <IconBtn label={t("Remove line")} danger onClick={() => set("lines", shot.lines.filter((_, k) => k !== i))}><Trash2 /></IconBtn>
                )}
              </div>
              <Textarea rows={1} value={l.text} disabled={disabled} aria-label={t("Line")} placeholder={t("What they say…")}
                onChange={(e) => setLine(i, { ...l, text: e.target.value, changed: false })} className="mt-1 !min-h-[2.25rem] text-sm [field-sizing:content]" />
            </div>
          ))}
          {!shot.lines.length && <p className="px-0.5 text-2xs text-dim">{t("No dialogue — a silent shot (music and sound only).")}</p>}
          {!disabled && (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="ghost" icon={<Mic className="size-3.5" />}
                onClick={() => set("lines", [...shot.lines, { speaker: shot.characters[0] ?? cast[0]?.id ?? "VO", text: "", emotion: "" }])}>
                {t("Add dialogue")}
              </Button>
              <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />}
                onClick={() => set("lines", [...shot.lines, { speaker: "VO", text: "", emotion: "" }])}>
                {t("Add voice-over")}
              </Button>
            </div>
          )}
          <p className="text-right text-2xs tabular-nums text-dim">{total > shot.duration_s ? t("{a}s → {b}s with extensions", { a: shot.duration_s, b: total }) : `${shot.duration_s}s`}</p>
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
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Characters in shot")}>
        <UserRound className="size-3.5 text-dim" aria-hidden />
        {inShot.map((c) => (
          <span key={c.id} className="flex items-center gap-1 rounded-full border border-accent/50 bg-accent/10 py-0.5 pl-0.5 pr-1 text-2xs">
            <Avatar name={c.name} src={c.avatar_url} size={18} />{c.name}
            {!disabled && (
              <button type="button" onClick={() => onToggle(c.id)} aria-label={t("Remove {name} from this shot", { name: c.name })}
                className="grid size-4 place-items-center rounded-full text-dim hover:bg-bad/15 hover:text-bad">×</button>
            )}
          </span>
        ))}
        {!inShot.length && <span className="text-2xs text-dim">{t("Nobody in this shot")}</span>}
        {!disabled && (
          <CharacterPicker selected={shot.characters} projectCast={pickers.projectCast} library={pickers.library}
            onToggle={onToggle} onCreate={pickers.onCreateCharacter} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ModelPicker value={engineId} data={pickers.engines} quality={pickers.quality} onChange={onEngine} disabled={disabled}
          needsCharacters={inShot.length > 0} />
      </div>
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
        className={clsx("grid size-7 place-items-center rounded-md text-dim transition-colors disabled:pointer-events-none disabled:opacity-30 [&>svg]:size-3.5",
          danger ? "hover:bg-bad/10 hover:text-bad" : "hover:bg-hover hover:text-ink")}>
        {children}
      </button>
    </Tooltip>
  );
}
