import { clsx } from "clsx";
import { ChevronDown, ChevronRight, Clock, MapPin, Plus, Quote, Trash2, User, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useCharacters } from "../../lib/queries";
import type { Script, ScriptLine, ScriptScene } from "../../lib/types";
import { findMentions, plainText } from "../../lib/v3";
import { IconButton } from "../ui";
import { AutoInput } from "./kit";
import { CHARACTER_ONLY, MentionText, useMentionField } from "./MentionField";
import { spokenSeconds, useCastTones, type Tone } from "./util";

/** Borderless inline-edit look: quiet until hovered, accent ring on focus. */
const inline = "rounded-md bg-transparent transition-colors placeholder:text-dim hover:bg-hover/70 focus:bg-raised focus:outline-none focus:ring-1 focus:ring-accent/50 read-only:hover:bg-transparent read-only:focus:bg-transparent read-only:focus:ring-0";

const pad = (n: number) => String(n).padStart(2, "0");
const BLANK: ScriptLine = { character: "", line: "", emotion: "" };

/**
 * The script as a screenplay: scene headings, centred character names, indented dialogue. Everything is edited in place
 * (the parent owns the script and its dirty flag). With `canEdit` off it reads as a clean, selectable page.
 */
export function ScriptEditor({ script, onChange, canEdit, pid, eid }: {
  script: Script; onChange: (s: Script) => void; canEdit: boolean; pid: number; eid: number;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const { data: cast } = useCharacters(pid);
  const scenes = script.scenes ?? [];
  const names = useMemo(() => scenes.flatMap((s) => (s.lines ?? []).map((l) => plainText(l.character))), [script]);
  const toneOf = useCastTones(pid, names);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const listId = `cast-names-${eid}`;

  const patchScene = (i: number, patch: Partial<ScriptScene>) =>
    onChange({ ...script, scenes: scenes.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const patchLine = (i: number, j: number, patch: Partial<ScriptLine>) =>
    patchScene(i, { lines: (scenes[i].lines ?? []).map((l, k) => (k === j ? { ...l, ...patch } : l)) });
  const insertLine = (i: number, at: number) => {
    const lines = scenes[i].lines ?? [];
    patchScene(i, { lines: [...lines.slice(0, at), { ...BLANK }, ...lines.slice(at)] });
    pendingFocus.current = `${i}-${at}`;
    setJustAdded(`${i}-${at}`);
  };
  const removeLine = (i: number, j: number) => patchScene(i, { lines: (scenes[i].lines ?? []).filter((_, k) => k !== j) });

  // Put the caret in the name field of a line that was just inserted.
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    root.current?.querySelector<HTMLInputElement>(`[data-name="${key}"]`)?.focus();
  });
  useEffect(() => {
    if (!justAdded) return;
    const id = window.setTimeout(() => setJustAdded(null), 700);
    return () => window.clearTimeout(id);
  }, [justAdded]);

  const lineCount = scenes.reduce((n, s) => n + (s.lines?.length ?? 0), 0);
  const secs = spokenSeconds(script);
  const toggle = (i: number) => setCollapsed((c) => { const n = new Set(c); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const allCollapsed = scenes.length > 0 && collapsed.size === scenes.length;

  return (
    <div ref={root} className="space-y-4">
      {canEdit && <datalist id={listId}>{(cast ?? []).map((c) => <option key={c.id} value={c.name} />)}<option value="NARRATOR" /></datalist>}

      {script.logline !== undefined && (
        <div className="rounded-xl border border-line bg-bg/40 p-3.5 @md:p-4">
          <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-dim"><Quote className="size-3" />{t("Logline")}</div>
          <MentionText pid={pid} value={script.logline ?? ""} readOnly={!canEdit} aria-label={t("Logline")} placeholder={t("One sentence that sells the story")}
            onChange={(v) => onChange({ ...script, logline: v })} className={clsx(inline, "px-1.5 py-1 text-base font-medium leading-snug")} />
        </div>
      )}

      {!!script.beats?.length && (
        <ol className="flex flex-wrap items-center gap-y-1.5" aria-label={t("Story beats")}>
          {script.beats.map((b, i) => (
            <li key={i} className="flex items-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-raised py-0.5 pl-0.5 pr-2.5 text-xs">
                <span className="grid size-5 place-items-center rounded-full bg-accent/10 text-2xs font-semibold tabular-nums text-accent-ink">{i + 1}</span>{b}
              </span>
              {i < script.beats!.length - 1 && <ChevronRight aria-hidden className="mx-0.5 size-3.5 text-dim" />}
            </li>
          ))}
        </ol>
      )}

      {scenes.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-mute">
          <span className="tabular-nums">
            {t("{n} scenes", { n: scenes.length })} · {t("{n} lines", { n: lineCount })}{secs > 0 && <> · {t("≈ {n}s of dialogue", { n: secs })}</>}
          </span>
          {scenes.length > 1 && (
            <button type="button" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(scenes.map((_, i) => i)))}
              className="rounded-md px-1.5 py-1 font-medium transition-colors hover:bg-hover hover:text-ink">
              {allCollapsed ? t("Expand all") : t("Collapse all")}
            </button>
          )}
        </div>
      )}

      {scenes.map((sc, i) => {
        const closed = collapsed.has(i);
        const lines = sc.lines ?? [];
        return (
          <article key={i} data-scene={i} className="rounded-xl border border-line bg-bg/40">
            <header className="flex items-start gap-2.5 px-3 pt-3 @md:px-4">
              <button type="button" onClick={() => toggle(i)} aria-expanded={!closed} aria-label={closed ? t("Expand scene {n}", { n: i + 1 }) : t("Collapse scene {n}", { n: i + 1 })}
                className="mt-0.5 flex h-7 shrink-0 items-center gap-1 rounded-md bg-raised pl-1.5 pr-1 font-mono text-2xs font-semibold text-mute transition-colors hover:bg-hover hover:text-ink">
                {pad(i + 1)}
                <ChevronDown className={clsx("size-3.5 transition-transform duration-200", closed && "-rotate-90")} />
              </button>
              <div className="min-w-0 flex-1">
                <input value={sc.title} readOnly={!canEdit} aria-label={t("Scene title")} placeholder={t("Scene title")}
                  onChange={(e) => patchScene(i, { title: e.target.value })}
                  className={clsx(inline, "h-7 w-full px-1.5 text-sm font-semibold uppercase tracking-wide")} />
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <label className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-line bg-panel pl-1.5 text-xs text-mute focus-within:border-accent/50">
                    <MapPin aria-hidden className="size-3 shrink-0 text-dim" />
                    <AutoInput value={sc.location} readOnly={!canEdit} aria-label={t("Location")} placeholder={t("Location")} minCh={8}
                      onChange={(e) => patchScene(i, { location: e.target.value })} className={clsx(inline, "h-6 px-1 text-xs")} />
                  </label>
                  <label className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-line bg-panel pl-1.5 text-xs text-mute focus-within:border-accent/50">
                    <Clock aria-hidden className="size-3 shrink-0 text-dim" />
                    <AutoInput value={sc.time_of_day} readOnly={!canEdit} aria-label={t("Time")} placeholder={t("Time")} minCh={5}
                      onChange={(e) => patchScene(i, { time_of_day: e.target.value })} className={clsx(inline, "h-6 px-1 text-xs")} />
                  </label>
                  <span className="ml-auto text-2xs tabular-nums text-dim">{t("{n} lines", { n: lines.length })}</span>
                </div>
              </div>
            </header>

            <AnimatePresence initial={false}>
              {!closed && (
                <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                  <div className="space-y-3 px-3 pb-3 pt-3 @md:px-4 @md:pb-4">
                    {(sc.summary || canEdit) && (
                      <MentionText pid={pid} value={sc.summary ?? ""} readOnly={!canEdit} aria-label={t("Scene summary")} placeholder={t("What happens in this scene")}
                        onChange={(v) => patchScene(i, { summary: v })} chipsClassName="pl-3"
                        className={clsx(inline, "rounded-l-none border-l-2 border-line py-1 pl-3 pr-1.5 text-sm leading-relaxed text-mute")} />
                    )}
                    {(sc.action || canEdit) && (
                      <MentionText pid={pid} value={sc.action ?? ""} readOnly={!canEdit} aria-label={t("Action")} placeholder={t("Action: what we see on screen. Type @ to mention a character, location or prop")}
                        onChange={(v) => patchScene(i, { action: v })} className={clsx(inline, "px-1.5 py-1 text-sm leading-relaxed")} />
                    )}

                    <div className="pt-1">
                      {lines.map((l, j) => (
                        <Fragment key={j}>
                          <LineBlock i={i} j={j} line={l} tone={toneOf(plainText(l.character))} canEdit={canEdit} fresh={justAdded === `${i}-${j}`} listId={listId} pid={pid}
                            onChange={(patch) => patchLine(i, j, patch)} onRemove={() => removeLine(i, j)} />
                          {canEdit && j < lines.length - 1 && <InsertGap onClick={() => insertLine(i, j + 1)} />}
                        </Fragment>
                      ))}
                      {canEdit && (
                        <div className="mt-1 flex justify-center">
                          <button type="button" onClick={() => insertLine(i, lines.length)}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink">
                            <Plus className="size-3.5" />{t("Add line")}
                          </button>
                        </div>
                      )}
                      {!canEdit && !lines.length && <p className="text-center text-xs text-dim">{t("No dialogue in this scene.")}</p>}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </article>
        );
      })}
    </div>
  );
}

function LineBlock({ i, j, line, tone, canEdit, fresh, listId, pid, onChange, onRemove }: {
  i: number; j: number; line: ScriptLine; tone: Tone; canEdit: boolean; fresh: boolean; listId: string; pid: number;
  onChange: (patch: Partial<ScriptLine>) => void; onRemove: () => void;
}) {
  const t = useT();
  const showEmotion = canEdit || !!line.emotion;
  return (
    <div className={clsx("group/line relative mx-auto w-full max-w-[23rem] rounded-lg px-2 py-2 transition-colors", canEdit && "hover:bg-hover/40 focus-within:bg-hover/40", fresh && "anim-fade")}>
      <SpeakerField value={line.character} onChange={(v) => onChange({ character: v })} canEdit={canEdit} tone={tone} listId={listId} pid={pid} name={`${i}-${j}`} />
      {showEmotion && (
        <div className="flex items-center justify-center text-2xs text-dim">
          <span aria-hidden>(</span>
          <AutoInput value={line.emotion} readOnly={!canEdit} aria-label={t("Emotion")} placeholder={t("emotion")} minCh={6}
            onChange={(e) => onChange({ emotion: e.target.value })} className={clsx(inline, "h-7 px-0.5 text-center text-2xs")} />
          <span aria-hidden>)</span>
        </div>
      )}
      <MentionText pid={pid} value={line.line} readOnly={!canEdit} aria-label={t("Line")} placeholder={t("Dialogue…")} chipsClassName="justify-center"
        onChange={(v) => onChange({ line: v })} className={clsx(inline, "mt-0.5 px-1.5 py-1 text-center text-sm leading-relaxed")} />
      {canEdit && (
        <IconButton title={t("Remove line")} onClick={onRemove} tipSide="left"
          className="absolute -right-1 top-1 size-6 opacity-0 transition-opacity hover:text-bad focus-visible:opacity-100 group-focus-within/line:opacity-100 group-hover/line:opacity-100 [@media(hover:none)]:opacity-60">
          <Trash2 className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

/**
 * The centred CHARACTER name. A linked speaker (`@[Name](character:id)`) shows as a chip — the token stays in the data —
 * and its × turns it back into an editable plain name. Typing `@` in the plain input opens the cast list; the datalist
 * of cast names remains as the no-@ fallback.
 */
function SpeakerField({ value, onChange, canEdit, tone, listId, pid, name }: {
  value: string; onChange: (v: string) => void; canEdit: boolean; tone: Tone; listId: string; pid: number; name: string;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"chip" | "input" | null>(null);
  const mention = findMentions(value)[0];
  const m = useMentionField({
    pid, value, ref: input, enabled: canEdit, pad: false, kinds: CHARACTER_ONLY,
    onChange: (v) => { if (findMentions(v).length) focusNext.current = "chip"; onChange(v); },
  });
  // After a pick the input is replaced by the chip (and vice-versa on unlink): keep the keyboard on the field.
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    (want === "chip" ? chip.current : input.current)?.focus();
  }, [value]);

  if (mention) {
    return (
      <div className="flex h-7 items-center justify-center">
        <span className={clsx("inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-line bg-raised pl-2 text-xs font-semibold uppercase tracking-[0.14em]", canEdit ? "pr-0.5" : "pr-2", tone.className)}
          style={tone.style} title={t("Linked to the cast")}>
          <User aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{mention.name}</span>
          {canEdit && (
            <button ref={chip} type="button" data-name={name} aria-label={t("Unlink {name} (edit the name)", { name: mention.name })}
              onClick={() => { focusNext.current = "input"; onChange(plainText(value)); }}
              className="grid size-5 place-items-center rounded-full text-mute transition-colors hover:bg-hover hover:text-bad">
              <X className="size-3" />
            </button>
          )}
        </span>
      </div>
    );
  }
  return (
    <>
      <input ref={input} value={value} readOnly={!canEdit} list={canEdit ? listId : undefined} data-name={name} aria-label={t("Character")} placeholder={t("CHARACTER")}
        style={tone.style} {...m.fieldProps}
        className={clsx(inline, "block h-7 w-full px-1.5 text-center text-xs font-semibold uppercase tracking-[0.14em] [&::-webkit-calendar-picker-indicator]:hidden", tone.className)} />
      {m.popover}
    </>
  );
}

/** Thin hover target between two lines that inserts a new line there. */
function InsertGap({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <div className="relative mx-auto h-3 w-full max-w-[23rem]">
      <button type="button" onClick={onClick} aria-label={t("Insert a line here")}
        className="absolute inset-0 flex items-center gap-2 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-25">
        <span className="h-px flex-1 bg-accent/35" />
        <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-panel px-2 py-px text-2xs font-medium text-accent-ink"><Plus className="size-3" />{t("Add line")}</span>
        <span className="h-px flex-1 bg-accent/35" />
      </button>
    </div>
  );
}
