import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, Cloud, Clock, Loader2, Package, PenLine, Sparkles, StickyNote, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { tr, useT } from "../../lib/i18n";
import type { Character } from "../../lib/types";
import { aiEndState, editEndState, type EndState } from "../../lib/v3";
import { Avatar, Button, Input, Textarea } from "../ui";
import { StateSourceBadge } from "./badges";
import { TagInput } from "./TagInput";

type Chars = EndState["characters"];
const EMPTY: EndState = { characters: {}, props: [], time_of_day: "", weather: "", notes: "", source: "manual" };

/** True when nothing has been written yet (no characters, props, time, weather or notes). */
export function endStateEmpty(s: Partial<EndState> | null | undefined): boolean {
  if (!s) return true;
  return !Object.keys(s.characters ?? {}).length && !(s.props ?? []).length && !s.time_of_day && !s.weather && !s.notes;
}

/** One line: "Ravi: blue kurta, soaked · Meera: red saree · lamp, letter · dusk · rain". */
export function summarizeEndState(s: Partial<EndState> | null | undefined, max = 3): string {
  if (!s || endStateEmpty(s)) return "";
  const parts: string[] = [];
  const chars = Object.values(s.characters ?? {});
  chars.slice(0, max).forEach((c) => parts.push([c.name, [c.outfit, c.state].filter(Boolean).join(", ")].filter(Boolean).join(": ")));
  if (chars.length > max) parts.push(`+${chars.length - max}`);
  if (s.props?.length) parts.push(s.props.slice(0, 4).join(", ") + (s.props.length > 4 ? "…" : ""));
  if (s.time_of_day) parts.push(s.time_of_day);
  if (s.weather) parts.push(s.weather);
  return parts.join(" · ");
}

/** Save / AI-write actions for a scene's end state; both refresh the bible and the episode (scene cards carry end_state too). */
export function useEndStateActions(sceneId: number, eid: number | undefined) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"ai" | "save" | null>(null);
  const done = () => {
    qc.invalidateQueries({ queryKey: ["continuity-bible", eid] });
    qc.invalidateQueries({ queryKey: ["wardrobe", eid] });
    qc.invalidateQueries({ queryKey: ["episode", eid] });
  };
  /** Cheap LLM call (cents): the AI continuity supervisor writes the state from the script and the previous scene. */
  const writeAI = async (): Promise<EndState | undefined> => {
    setBusy("ai");
    try {
      const r = await aiEndState(sceneId);
      done();
      toast.success(tr("End of scene written by AI"));
      return r;
    } catch { return undefined; } finally { setBusy(null); }
  };
  const save = async (body: Partial<EndState>): Promise<EndState | undefined> => {
    setBusy("save");
    try {
      const r = await editEndState(sceneId, body);
      done();
      return r;
    } catch { return undefined; } finally { setBusy(null); }
  };
  return { busy, writeAI, save };
}

function Line({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="mt-0.5 shrink-0 text-dim [&>svg]:size-3.5" title={label}>{icon}</span>
      <div className="min-w-0 flex-1"><span className="mr-1.5 text-2xs font-semibold uppercase tracking-wide text-dim">{label}</span><span className="text-ink">{children}</span></div>
    </div>
  );
}

/** Read-only view of an end state. */
export function EndStateView({ state, cast, className }: { state: Partial<EndState>; cast?: Character[]; className?: string }) {
  const t = useT();
  const chars = Object.entries(state.characters ?? {});
  if (endStateEmpty(state)) return <p className={clsx("text-xs text-dim", className)}>{t("Nothing written yet.")}</p>;
  return (
    <div className={clsx("space-y-2", className)}>
      {chars.length > 0 && (
        <ul className="space-y-1.5">
          {chars.map(([id, c]) => {
            const person = cast?.find((x) => String(x.id) === id);
            return (
              <li key={id} className="flex items-start gap-2 text-xs">
                <Avatar name={c.name || person?.name || id} src={person?.avatar_url || undefined} size={22} />
                <div className="min-w-0 flex-1 leading-snug">
                  <span className="font-medium">{c.name || person?.name || id}</span>
                  {c.outfit && <span className="text-mute"> · {c.outfit}</span>}
                  {c.state && <span className="block text-mute">{c.state}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!!state.props?.length && <Line icon={<Package />} label={t("Props")}>{state.props.join(", ")}</Line>}
      {(state.time_of_day || state.weather) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {state.time_of_day && <Line icon={<Clock />} label={t("Time")}>{state.time_of_day}</Line>}
          {state.weather && <Line icon={<Cloud />} label={t("Weather")}>{state.weather}</Line>}
        </div>
      )}
      {state.notes && <Line icon={<StickyNote />} label={t("Notes")}>{state.notes}</Line>}
    </div>
  );
}

/** Inline form for every field of the end state. Saves as one PATCH (source becomes "manual"). */
export function EndStateForm({ state, cast, onSave, onCancel, saving }: {
  state: Partial<EndState>; cast?: Character[]; onSave: (body: Partial<EndState>) => Promise<unknown>; onCancel: () => void; saving: boolean;
}) {
  const t = useT();
  const [chars, setChars] = useState<Chars>(() => ({ ...(state.characters ?? {}) }));
  const [props, setProps] = useState<string[]>(() => [...(state.props ?? [])]);
  const [time, setTime] = useState(state.time_of_day ?? "");
  const [weather, setWeather] = useState(state.weather ?? "");
  const [notes, setNotes] = useState(state.notes ?? "");
  const [adding, setAdding] = useState("");

  const setChar = (id: string, patch: Partial<Chars[string]>) => setChars((c) => ({ ...c, [id]: { ...c[id], ...patch } }));
  const removeChar = (id: string) => setChars((c) => { const n = { ...c }; delete n[id]; return n; });
  const missing = (cast ?? []).filter((c) => !chars[String(c.id)]);
  const addChar = (id: string) => {
    if (!id) return;
    const person = cast?.find((c) => String(c.id) === id);
    setChars((c) => ({ ...c, [id]: { name: person?.name ?? id, outfit: "", state: "" } }));
    setAdding("");
  };

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void onSave({ characters: chars, props, time_of_day: time, weather, notes }); }}>
      <div className="space-y-2">
        <p className="text-2xs font-semibold uppercase tracking-wider text-dim">{t("Characters at the end of the scene")}</p>
        {Object.entries(chars).map(([id, c]) => {
          const person = cast?.find((x) => String(x.id) === id);
          return (
            <div key={id} className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
              <span className="flex items-center gap-1.5">
                <Avatar name={c.name || person?.name || id} src={person?.avatar_url || undefined} size={22} />
                <span className="hidden max-w-24 truncate text-xs font-medium @md:inline" title={c.name || person?.name}>{c.name || person?.name || id}</span>
              </span>
              <Input className="h-8! text-xs!" value={c.outfit ?? ""} placeholder={t("Outfit")} aria-label={`${c.name || id}: ${t("Outfit")}`} onChange={(e) => setChar(id, { outfit: e.target.value })} />
              <Input className="h-8! text-xs!" value={c.state ?? ""} placeholder={t("State (wet, wounded, carrying…)")} aria-label={`${c.name || id}: ${t("State")}`} onChange={(e) => setChar(id, { state: e.target.value })} />
              <button type="button" aria-label={`${t("Remove")}: ${c.name || id}`} onClick={() => removeChar(id)} className="grid size-7 place-items-center rounded-md text-dim hover:bg-hover hover:text-bad"><X className="size-3.5" /></button>
            </div>
          );
        })}
        {missing.length > 0 && (
          <select value={adding} onChange={(e) => addChar(e.target.value)} aria-label={t("Add a character")}
            className="h-8 rounded-lg border border-dashed border-line bg-panel px-2 text-xs text-mute hover:border-dim/40 focus:border-accent/70 focus:outline-none">
            <option value="">{t("+ Add a character…")}</option>
            {missing.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </select>
        )}
      </div>
      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-mute">{t("Props now in play")}</span>
        <TagInput value={props} onChange={setProps} placeholder={t("Add a prop and press Enter")} icon={<Package className="size-3 text-dim" />} compact />
      </div>
      <div className="grid gap-2 @md:grid-cols-2">
        <label className="block space-y-1"><span className="block text-xs font-medium text-mute">{t("Time of day")}</span>
          <Input className="h-8! text-xs!" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        <label className="block space-y-1"><span className="block text-xs font-medium text-mute">{t("Weather")}</span>
          <Input className="h-8! text-xs!" value={weather} onChange={(e) => setWeather(e.target.value)} /></label>
      </div>
      <label className="block space-y-1"><span className="block text-xs font-medium text-mute">{t("Notes for the next scene")}</span>
        <Textarea rows={2} className="text-xs" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>{t("Cancel")}</Button>
        <Button type="submit" size="sm" variant="primary" loading={saving} icon={<Check className="size-3.5" />}>{t("Save end state")}</Button>
      </div>
    </form>
  );
}

/**
 * The end-of-scene block: a source badge, the state (or "nothing yet"), "Write with AI" and inline manual editing.
 * Used by the Continuity Bible cards and, in compact form, by the scene cards.
 */
export function EndStateBlock({ sceneId, eid, state, cast, canEdit, compact, className }: {
  sceneId: number; eid: number | undefined; state: Partial<EndState> | null | undefined; cast?: Character[]; canEdit: boolean; compact?: boolean; className?: string;
}) {
  const t = useT();
  const { busy, writeAI, save } = useEndStateActions(sceneId, eid);
  const [editing, setEditing] = useState(false);
  const s = { ...EMPTY, ...(state ?? {}) } as Partial<EndState>;
  // A fresh AI result closes the editor so the new state shows.
  useEffect(() => { if (busy === "ai") setEditing(false); }, [busy]);

  return (
    <div className={clsx("@container", className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {!endStateEmpty(s) && <StateSourceBadge source={s.source} />}
        <span className="flex-1" />
        {canEdit && !editing && (
          <>
            <Button size="sm" variant="ghost" icon={<PenLine className="size-3.5" />} onClick={() => setEditing(true)} disabled={!!busy}>{t("Edit")}</Button>
            <Button size="sm" variant={endStateEmpty(s) ? "primary" : "secondary"} icon={busy === "ai" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              disabled={!!busy} onClick={() => void writeAI()} title={t("A small AI call (cents): reads the script and the previous scene's state")}>
              {endStateEmpty(s) ? t("Write with AI") : t("Rewrite with AI")}
            </Button>
          </>
        )}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.div key="form" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            <EndStateForm state={s} cast={cast} saving={busy === "save"} onCancel={() => setEditing(false)}
              onSave={async (body) => { const r = await save(body); if (r) { setEditing(false); toast.success(tr("End state saved")); } }} />
          </motion.div>
        ) : (
          <motion.div key="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} aria-busy={busy === "ai" || undefined}
            className={clsx(busy === "ai" && "opacity-60")}>
            {compact && !endStateEmpty(s) ? <p className="line-clamp-3 text-xs text-mute">{summarizeEndState(s, 4)}</p> : <EndStateView state={s} cast={cast} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
