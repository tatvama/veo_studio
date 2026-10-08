import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BookMarked, Camera, Check, ChevronDown, Clock, Loader2, MapPin, Package, RefreshCw, Shirt, Swords, Target, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { Character, Location, SceneCard } from "../../lib/types";
import type { EndState } from "../../lib/v3";
import { Avatar as PersonAvatar, IconButton, Input, Select, Textarea } from "../ui";
import { EndStateBlock, endStateEmpty, summarizeEndState } from "../world/EndState";
import { PropPicker } from "../world/PropPicker";
import { WardrobeSelect } from "../world/WardrobeSelect";
import { RField } from "./kit";

/** v3 fields the scene payload carries on top of the SceneCard type: picked props and the Continuity Bible end state. */
export type SceneCardV3 = SceneCard & { prop_ids?: number[]; end_state?: Partial<EndState> };

type Editable = "title" | "summary" | "goal" | "conflict" | "turn" | "emotion" | "time_of_day" | "location_id" | "characters"
  | "props" | "prop_ids" | "wardrobe" | "continuity_notes" | "coverage" | "blocking" | "approved";
type Draft = Pick<SceneCard, Exclude<Editable, "prop_ids">> & { prop_ids: number[] };

const pick = (s: SceneCardV3): Draft => ({
  title: s.title ?? "", summary: s.summary ?? "", goal: s.goal ?? "", conflict: s.conflict ?? "", turn: s.turn ?? "",
  emotion: s.emotion ?? "", time_of_day: s.time_of_day ?? "", location_id: s.location_id ?? null, characters: s.characters ?? [],
  props: s.props ?? [], prop_ids: (s.prop_ids ?? []).map(Number), wardrobe: s.wardrobe ?? {}, continuity_notes: s.continuity_notes ?? "", coverage: s.coverage ?? [],
  blocking: s.blocking ?? "", approved: !!s.approved,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Round character avatar: the portrait when there is one, otherwise initials on a colour derived from the name. */
export function Avatar({ c, size = 28 }: { c: Pick<Character, "name" | "avatar_url">; size?: number }) {
  return <PersonAvatar name={c.name} src={c.avatar_url || undefined} size={size} ring />;
}

/** One scene card on the Scenes board. Text fields save on blur; chips, toggles and selects save immediately. */
export function SceneCardView({ scene, index, cast, locations, canEdit, expanded, onToggle, projectId }: {
  scene: SceneCardV3; index: number; cast: Character[]; locations: Location[]; canEdit: boolean; expanded: boolean; onToggle: () => void;
  /** Needed for the prop picker (project props) and the World links. */
  projectId: number;
}) {
  const t = useT();
  const qc = useQueryClient();
  const root = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<Draft>(() => pick(scene));
  const dirty = useRef(new Set<Editable>());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [endOpen, setEndOpen] = useState(false);

  // Server updates (ours or a teammate's) flow in, except for fields the user is still editing.
  const serverKey = JSON.stringify(pick(scene));
  useEffect(() => {
    const server = pick(scene);
    setDraft((prev) => {
      const next = { ...server } as Record<Editable, unknown>;
      dirty.current.forEach((k) => { next[k] = prev[k]; });
      return next as Draft;
    });
  }, [serverKey]);

  useEffect(() => {
    if (saveState !== "saved") return;
    const tm = setTimeout(() => setSaveState("idle"), 1600);
    return () => clearTimeout(tm);
  }, [saveState]);

  // Opening a card brings it into view once its row has made room.
  useEffect(() => {
    if (!expanded) return;
    const tm = window.setTimeout(() => root.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 260);
    return () => window.clearTimeout(tm);
  }, [expanded]);

  const save = async (patch: Partial<Draft>) => {
    setSaveState("saving");
    try {
      await api.patch(`/api/scenes/${scene.id}`, patch);
      // Only clear fields that haven't been edited again while the request was in flight.
      (Object.keys(patch) as Editable[]).forEach((k) => { if (same(draftRef.current[k], patch[k])) dirty.current.delete(k); });
      setSaveState("saved");
      qc.invalidateQueries({ queryKey: ["episode", scene.episode_id] });
    } catch {
      setSaveState("idle");
    }
  };
  const edit = <K extends Editable>(k: K, v: Draft[K]) => {
    dirty.current.add(k);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const commit = (k: Editable) => {
    if (!dirty.current.has(k)) return;
    if (same(draft[k], pick(scene)[k])) { dirty.current.delete(k); return; }
    save({ [k]: draft[k] } as Partial<Draft>);
  };
  const set = <K extends Editable>(k: K, v: Draft[K]) => {
    dirty.current.add(k);
    setDraft((d) => ({ ...d, [k]: v }));
    save({ [k]: v } as Partial<Draft>);
  };

  const inScene = draft.characters.map((id) => cast.find((c) => c.id === id)).filter(Boolean) as Character[];
  const loc = locations.find((l) => l.id === draft.location_id);
  const hasBeats = !!(draft.goal || draft.conflict || draft.turn);
  const propCount = draft.prop_ids.length + draft.props.length;
  const endSummary = summarizeEndState(scene.end_state);

  const text = (k: "goal" | "conflict" | "turn" | "summary" | "blocking" | "continuity_notes", label: ReactNode, rows = 2, placeholder?: string) => (
    <RField label={label}>
      <Textarea rows={rows} value={draft[k]} disabled={!canEdit} placeholder={placeholder} className="text-sm"
        onChange={(e) => edit(k, e.target.value)} onBlur={() => commit(k)} />
    </RField>
  );

  return (
    <motion.article
      ref={root}
      id={`scene-${scene.id}`}
      layout="position"
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      style={expanded ? { gridColumn: "1 / -1" } : undefined}
      className={clsx("group relative scroll-mt-20 overflow-hidden rounded-xl border bg-panel transition-[border-color,box-shadow] duration-200",
        draft.approved ? "border-ok/35" : "border-line", !expanded && "hover:border-dim/60 hover:shadow-lift", expanded && "shadow-lift")}
    >
      <span aria-hidden className={clsx("absolute inset-y-0 left-0 w-[3px] transition-colors", draft.approved ? "bg-ok" : "bg-transparent")} />

      {/* header */}
      <div className="flex items-center gap-2 pl-4 pr-3 pt-3">
        <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 font-mono text-2xs font-semibold text-mute">SC{String(index + 1).padStart(2, "0")}</span>
        <input value={draft.title} disabled={!canEdit} aria-label={t("Scene title")} placeholder={t("Untitled scene")}
          onChange={(e) => edit("title", e.target.value)} onBlur={() => commit("title")} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="h-7 min-w-0 flex-1 truncate rounded-md bg-transparent px-1.5 text-sm font-semibold text-ink transition-colors placeholder:text-dim hover:bg-hover focus:bg-raised focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:hover:bg-transparent" />
        <AnimatePresence mode="wait" initial={false}>
          {saveState !== "idle" && (
            <motion.span key={saveState} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
              className="flex shrink-0 items-center gap-1 text-2xs text-dim" role="status">
              {saveState === "saving" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 text-ok" strokeWidth={3} />}
              <span className="hidden @sm:inline">{saveState === "saving" ? t("Saving…") : t("Saved")}</span>
            </motion.span>
          )}
        </AnimatePresence>
        <button type="button" disabled={!canEdit} onClick={() => set("approved", !draft.approved)} aria-pressed={draft.approved}
          title={draft.approved ? t("Approved — click to unapprove") : t("Approve this scene card")}
          className={clsx("inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed",
            draft.approved ? "border-ok/40 bg-ok/8 text-green-300" : "border-line text-mute hover:border-ok/40 hover:text-green-300")}>
          <Check className="size-3.5" strokeWidth={draft.approved ? 3 : 2} />{draft.approved ? t("Approved") : t("Approve")}
        </button>
        <IconButton title={expanded ? t("Collapse") : t("Expand")} onClick={onToggle} aria-expanded={expanded}>
          <ChevronDown className={clsx("size-4 transition-transform duration-200", expanded && "rotate-180")} />
        </IconButton>
      </div>

      {/* meta row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 pr-3 pt-1.5 text-xs text-mute">
        <span className="flex min-w-0 items-center gap-1"><MapPin className="size-3 shrink-0 text-dim" /><span className="truncate">{loc?.name || t("No location")}</span></span>
        {draft.time_of_day && <span className="flex items-center gap-1"><Clock className="size-3 text-dim" />{draft.time_of_day}</span>}
        {draft.emotion && <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-2xs font-medium text-accent-ink">{draft.emotion}</span>}
      </div>

      <AnimatePresence initial={false} mode="wait">
        {!expanded ? (
          <motion.div key="summary" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <button type="button" onClick={onToggle} className="block w-full pb-3.5 pl-4 pr-3 pt-2.5 text-left transition-colors hover:bg-hover/30">
              {hasBeats ? (
                <dl className="space-y-1.5">
                  <Beat icon={<Target />} label={t("Goal")} value={draft.goal} />
                  <Beat icon={<Swords />} label={t("Conflict")} value={draft.conflict} />
                  <Beat icon={<RefreshCw />} label={t("Turn")} value={draft.turn} />
                </dl>
              ) : (
                <p className="line-clamp-3 text-sm text-mute">{draft.summary || t("No scene card yet — plan scenes or click to fill it in.")}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2">
                {inScene.length > 0 && (
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex shrink-0 -space-x-1.5">{inScene.slice(0, 5).map((c) => <Avatar key={c.id} c={c} />)}</div>
                    <span className="truncate text-xs text-mute">{inScene.map((c) => c.name).join(", ")}</span>
                  </div>
                )}
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  {draft.coverage.slice(0, 2).map((c) => <Chip key={c} icon={<Camera className="size-3" />}>{c}</Chip>)}
                  {draft.coverage.length > 2 && <Chip>+{draft.coverage.length - 2}</Chip>}
                  {propCount > 0 && <Chip icon={<Package className="size-3" />}>{propCount}</Chip>}
                  {!endStateEmpty(scene.end_state) && <Chip icon={<BookMarked className="size-3" />}>{t("end state")}</Chip>}
                </div>
              </div>
            </button>
          </motion.div>
        ) : (
          <motion.div key="editor" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }} className="@container overflow-hidden">
            <div className="space-y-5 pb-5 pl-4 pr-4 pt-4">
              <Block title={t("Story")}>
                {text("summary", t("Summary"), 2)}
                <div className="grid gap-3 @xl:grid-cols-3">
                  {text("goal", <Lbl icon={<Target />}>{t("Goal — what they want")}</Lbl>, 3)}
                  {text("conflict", <Lbl icon={<Swords />}>{t("Conflict — what's in the way")}</Lbl>, 3)}
                  {text("turn", <Lbl icon={<RefreshCw />}>{t("Turn — what changes")}</Lbl>, 3)}
                </div>
              </Block>

              <Block title={t("Setting & mood")}>
                <div className="grid gap-3 @xl:grid-cols-3">
                  <RField label={t("Emotion")}>
                    <Input value={draft.emotion} disabled={!canEdit} onChange={(e) => edit("emotion", e.target.value)} onBlur={() => commit("emotion")} />
                  </RField>
                  <RField label={t("Location")}>
                    <Select value={draft.location_id ?? ""} disabled={!canEdit} onChange={(e) => set("location_id", e.target.value ? Number(e.target.value) : null)}>
                      <option value="">{t("— none —")}</option>
                      {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </Select>
                  </RField>
                  <RField label={t("Time of day")}>
                    <Input value={draft.time_of_day} disabled={!canEdit} onChange={(e) => edit("time_of_day", e.target.value)} onBlur={() => commit("time_of_day")} />
                  </RField>
                </div>
              </Block>

              <Block title={t("Characters in scene")}>
                {!cast.length ? <p className="text-xs text-dim">{t("No cast yet — build the bible first.")}</p> : (
                  <div className="flex flex-wrap gap-1.5">
                    {cast.map((c) => {
                      const on = draft.characters.includes(c.id);
                      return (
                        <button key={c.id} type="button" disabled={!canEdit} aria-pressed={on}
                          onClick={() => set("characters", on ? draft.characters.filter((x) => x !== c.id) : [...draft.characters, c.id])}
                          className={clsx("inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-3 text-xs transition-colors disabled:cursor-not-allowed",
                            on ? "border-accent/50 bg-accent/10 text-ink" : "border-line text-mute hover:border-dim hover:text-ink")}>
                          <Avatar c={c} size={28} />{c.name}
                          {on && <Check className="size-3 text-accent-ink" strokeWidth={3} />}
                        </button>
                      );
                    })}
                  </div>
                )}
                {inScene.length > 0 && (
                  <div className="space-y-1.5 rounded-lg border border-line bg-bg/40 p-3">
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-medium text-mute">
                      <Shirt className="size-3.5 text-dim" />{t("Wardrobe — must stay consistent")}
                      <span className="ml-auto text-2xs font-normal text-dim">{t("Named costumes come from the Bible; pick Other… for free text.")}</span>
                    </p>
                    <div className="grid gap-2 @xl:grid-cols-2">
                      {inScene.map((c) => (
                        <div key={c.id} className="@container flex items-center gap-2">
                          <Avatar c={c} size={28} />
                          <span className="w-20 shrink-0 truncate text-xs font-medium" title={c.name}>{c.name}</span>
                          <WardrobeSelect characterId={c.id} characterName={c.name} disabled={!canEdit} value={draft.wardrobe[String(c.id)] ?? ""}
                            onPick={(v) => { const w = { ...draft.wardrobe }; if (v) w[String(c.id)] = v; else delete w[String(c.id)]; set("wardrobe", w); }}
                            onText={(v) => edit("wardrobe", { ...draft.wardrobe, [String(c.id)]: v })} onCommit={() => commit("wardrobe")} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {Object.keys(draft.wardrobe).length > 0 && !inScene.length && (
                  <p className="flex items-center gap-1.5 text-xs text-dim"><Shirt className="size-3" />{t("Wardrobe is set for characters not in this scene.")}</p>
                )}
              </Block>

              <Block title={t("Coverage & props")}>
                <div className="grid gap-3 @xl:grid-cols-2">
                  <Group label={t("Coverage — planned shots")}>
                    <ChipEditor value={draft.coverage} disabled={!canEdit} icon={<Camera className="size-3 text-dim" />}
                      placeholder={t("wide master, OTS, CU reaction…")} onChange={(v) => set("coverage", v)} />
                  </Group>
                  <div className="space-y-3">
                    <Group label={t("Props — from the project")}>
                      <PropPicker pid={projectId} value={draft.prop_ids} disabled={!canEdit} onChange={(ids) => set("prop_ids", ids)} />
                    </Group>
                    <Group label={t("Prop notes — free text")}>
                      <ChipEditor value={draft.props} disabled={!canEdit} icon={<Package className="size-3 text-dim" />}
                        placeholder={t("Add a note and press Enter")} onChange={(v) => set("props", v)} />
                    </Group>
                  </div>
                </div>
              </Block>

              <Block title={t("Blocking & notes")}>
                <div className="grid gap-3 @xl:grid-cols-2">
                  {text("blocking", t("Blocking — positions, entrances, eyelines"), 3)}
                  {text("continuity_notes", t("Continuity notes"), 3)}
                </div>
              </Block>

              <Block title={t("End of scene")}>
                <div className="rounded-lg border border-line bg-bg/40">
                  <button type="button" onClick={() => setEndOpen((o) => !o)} aria-expanded={endOpen}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-hover/40">
                    <BookMarked className="size-3.5 shrink-0 text-dim" />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {endSummary ? <span className="text-mute">{endSummary}</span> : <span className="text-dim">{t("Where everyone and everything is when the scene ends — not written yet.")}</span>}
                    </span>
                    <ChevronDown className={clsx("size-4 shrink-0 text-dim transition-transform duration-200", endOpen && "rotate-180")} />
                  </button>
                  <AnimatePresence initial={false}>
                    {endOpen && (
                      <motion.div key="end" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                        <div className="border-t border-line px-3 pb-3 pt-2.5">
                          <EndStateBlock sceneId={scene.id} eid={scene.episode_id} state={scene.end_state} cast={cast} canEdit={canEdit} />
                          <p className="mt-2 text-2xs text-dim">
                            <Link to={`/p/${projectId}/world?tab=bible`} className="font-medium text-accent-ink hover:underline">{t("Open the Continuity Bible")}</Link>
                            {" · "}{t("every scene's end state in one place, plus the wardrobe timeline.")}
                          </p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </Block>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-line pt-4 first:border-0 first:pt-0">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-dim">{title}</h4>
      {children}
    </section>
  );
}

function Lbl({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5"><span className="text-dim [&>svg]:size-3.5">{icon}</span>{children}</span>;
}

/** Label + content without a <label> element (a label would forward clicks to the first chip button). */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-mute">{label}</span>
      {children}
    </div>
  );
}

function Beat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 shrink-0 text-dim [&>svg]:size-3.5" title={label}>{icon}</span>
      <p className="line-clamp-2 min-w-0 leading-snug"><span className="mr-1.5 text-2xs font-semibold uppercase tracking-wide text-dim">{label}</span>{value}</p>
    </div>
  );
}

function Chip({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="inline-flex max-w-[9.5rem] items-center gap-1 rounded-md border border-line bg-raised px-1.5 py-0.5 text-2xs text-mute">
      {icon}<span className="truncate">{children}</span>
    </span>
  );
}

export function ChipEditor({ value, onChange, disabled, placeholder, icon }: {
  value: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string; icon?: ReactNode;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const add = () => {
    const v = text.trim().replace(/,$/, "").trim();
    setText("");
    if (v && !value.includes(v)) onChange([...value, v]);
  };
  return (
    <div className={clsx("flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-line bg-panel p-1.5 transition-[border-color,box-shadow]",
      !disabled && "hover:border-dim/40 focus-within:border-accent/70 focus-within:ring-[3px] focus-within:ring-accent/15")}>
      <AnimatePresence initial={false}>
        {value.map((v, i) => (
          <motion.span key={v} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.15 }}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-1.5 py-0.5 text-xs">
            {icon}{v}
            {!disabled && (
              <button type="button" title={t("Remove")} aria-label={`${t("Remove")}: ${v}`} className="rounded text-dim transition-colors hover:text-bad"
                onClick={() => onChange(value.filter((_, k) => k !== i))}><X className="size-3" /></button>
            )}
          </motion.span>
        ))}
      </AnimatePresence>
      {!disabled && (
        <input value={text} placeholder={value.length ? "" : placeholder} aria-label={placeholder} onChange={(e) => setText(e.target.value)} onBlur={add}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
          className="min-w-[8rem] flex-1 bg-transparent px-1 text-xs text-ink placeholder:text-dim focus:outline-none" />
      )}
      {disabled && !value.length && <span className="px-1 text-xs text-dim">—</span>}
    </div>
  );
}
