import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Camera, Check, Clapperboard, Cpu, Link2, Lock, Package, Plus, Settings2, Speech, Swords, Trash2, Volume2 } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import EnginePicker from "../../../components/hub/EnginePicker";
import { Avatar, Badge, Button, Field, Input, Segmented, Select, Skeleton, Textarea, Toggle, Tooltip } from "../../../components/ui";
import { api } from "../../../lib/api";
import { LANG_NAMES, QUALITY_INFO, SHOT_MODES, VOICE_MODES } from "../../../lib/format";
import { tr, useT } from "../../../lib/i18n";
import { useCharacters, useEpisode, useLocations } from "../../../lib/queries";
import type { Character, DialogueLine, Shot } from "../../../lib/types";
import { createProp, useCostumes, useProps, type ShotV3Fields } from "../../../lib/v3";
import { useProjectCtx } from "../context";
import { Collapse } from "./Collapse";

/** The Details tab: the shot as a set of folding sections (shot, engine, dialogue, sound, advanced). */
export function Details({ shot, form, setForm, lang, lines, disabled, hasLines, lipEngine, setLipEngine, onShootout }: {
  shot: Shot; form: Partial<Shot>; setForm: (f: Partial<Shot>) => void; lang: string; lines: DialogueLine[]; disabled: boolean;
  hasLines: boolean; lipEngine: string; setLipEngine: (id: string) => void; onShootout: () => void;
}) {
  const t = useT();
  const { project } = useProjectCtx();
  const { data: cast } = useCharacters(project.id);
  const { data: locs } = useLocations(project.id);
  const { data: ep } = useEpisode(shot.episode_id, lang);
  const set = (k: keyof Shot, v: any) => setForm({ ...form, [k]: v });
  const setLines = (ls: DialogueLine[]) => set("dialogue", { ...(form.dialogue || {}), [lang]: ls });
  const inShot = (cast ?? []).filter((c) => form.characters?.includes(c.id));
  const speakers = new Set(lines.map((l) => String(l.character_id)));
  const langName = LANG_NAMES[lang] ?? lang;
  const narration = form.narration?.[lang] || "";
  const v3 = useShotV3(shot, form, setForm);
  const propIds = v3.get("prop_ids") ?? [];
  const contFrom = v3.get("continuity_from_shot_id") ?? null;
  const contMode = v3.get("continuity_mode") ?? "last_frame";
  const otherShots = (ep?.shots ?? []).filter((s) => s.id !== shot.id);
  const contShot = otherShots.find((s) => s.id === contFrom);

  return (
    <div className="space-y-3">
      <Collapse memo="shot" title={t("Shot")} icon={<Clapperboard />} summary={`${form.duration_s ?? 8}s${form.action ? ` · ${form.action}` : ""}`}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <Field label={t("Length")}>
              <Segmented value={form.duration_s ?? 8} onChange={(v) => !disabled && set("duration_s", v)}
                options={[4, 6, 8].map((d) => ({ value: d, label: `${d}s` }))} />
            </Field>
            <Field label={t("Location")} className="min-w-[180px] flex-1">
              <Select value={form.location_id ?? ""} disabled={disabled} onChange={(e) => set("location_id", e.target.value ? Number(e.target.value) : null)}>
                <option value="">—</option>
                {locs?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label={t("Action")}><Textarea rows={3} value={form.action || ""} disabled={disabled} onChange={(e) => set("action", e.target.value)} /></Field>

          <Field label={t("Characters in shot")}>
            <div className="flex flex-wrap gap-1.5">
              {(cast ?? []).map((c) => {
                const on = !!form.characters?.includes(c.id);
                return (
                  <button key={c.id} type="button" disabled={disabled} aria-pressed={on}
                    onClick={() => set("characters", on ? form.characters!.filter((x) => x !== c.id) : [...(form.characters || []), c.id])}
                    className={clsx("flex items-center gap-1.5 rounded-lg border py-0.5 pl-0.5 pr-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60",
                      on ? "border-accent/50 bg-accent/10 text-ink shadow-[0_0_12px_-6px_var(--color-accent)]" : "border-line text-mute hover:border-dim/60 hover:text-ink")}>
                    <Avatar name={c.name} src={c.avatar_url} size={22} />
                    {c.name}
                    {c.locked && <Lock className="size-2.5 text-dim" aria-label={t("Locked")} />}
                    {on && <Check className="size-3 text-accent-ink" strokeWidth={3} />}
                  </button>
                );
              })}
              {!cast?.length && <p className="text-2xs text-dim">{t("No characters in the bible yet.")}</p>}
            </div>
          </Field>
          {inShot.length > 0 && (
            <div className="grid gap-3 empty:hidden @md:grid-cols-2">
              {inShot.map((c) => (
                <OutfitPicker key={c.id} c={c} value={form.outfits?.[String(c.id)] || ""} disabled={disabled}
                  onChange={(v) => set("outfits", { ...(form.outfits || {}), [String(c.id)]: v })} />
              ))}
            </div>
          )}

          <PropsPicker projectId={project.id} value={propIds} disabled={disabled} onChange={(ids) => void v3.set({ prop_ids: ids })} />
        </div>
      </Collapse>

      <Collapse memo="camera" title={t("Camera")} icon={<Camera />} summary={[form.framing, form.camera].filter(Boolean).join(" · ") || t("Framing and movement")}>
        <div className="grid gap-3 @md:grid-cols-2">
          <Field label={t("Framing")}><Input value={form.framing || ""} disabled={disabled} onChange={(e) => set("framing", e.target.value)} placeholder={t("medium close-up")} /></Field>
          <Field label={t("Camera")}><Input value={form.camera || ""} disabled={disabled} onChange={(e) => set("camera", e.target.value)} placeholder={t("slow push-in")} /></Field>
        </div>
      </Collapse>

      <EngineCard shot={shot} canEdit={!disabled} hasLines={hasLines} lipEngine={lipEngine} setLipEngine={setLipEngine} onShootout={onShootout} />

      <Collapse memo="dialogue" title={t("Dialogue")} icon={<Speech />}
        badge={lines.length ? <Badge tone="info">{lines.length}</Badge> : undefined}
        summary={lines.length ? `${langName} · ${lines[0].line}` : t("On-screen dialogue · {lang}", { lang: langName })}
        defaultOpen={hasLines || !disabled}>
        <div className="space-y-2">
          {speakers.size > 1 && (
            <p className="rounded-lg bg-warn/10 px-2.5 py-1.5 text-2xs leading-snug text-warn">{t("Tip: one speaker per shot lip-syncs best (use shot / reverse-shot)")}</p>
          )}
          {lines.map((l, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-line border-l-2 border-l-info/50 bg-panel p-2">
              <div className="flex items-center gap-1.5">
                <Select value={String(l.character_id)} disabled={disabled} className="!h-8 !w-40 shrink-0 text-xs" aria-label={t("Speaker")}
                  onChange={(e) => { const ls = [...lines]; ls[i] = { ...l, character_id: e.target.value === "NARRATOR" ? "NARRATOR" : Number(e.target.value) }; setLines(ls); }}>
                  {(cast ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  {l.character_id === "NARRATOR" && <option value="NARRATOR">{t("Narrator")}</option>}
                </Select>
                <Input value={l.emotion || ""} disabled={disabled} placeholder={t("emotion")} aria-label={t("Emotion")} className="!h-8 min-w-0 flex-1 text-xs"
                  onChange={(e) => { const ls = [...lines]; ls[i] = { ...l, emotion: e.target.value }; setLines(ls); }} />
                {!disabled && (
                  <Tooltip content={t("Remove line")}>
                    <button type="button" className="grid size-8 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-bad/10 hover:text-bad" aria-label={t("Remove line")}
                      onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 className="size-3.5" /></button>
                  </Tooltip>
                )}
              </div>
              <Textarea rows={2} value={l.line} disabled={disabled} aria-label={t("Line")} className="!min-h-[52px] text-sm"
                onChange={(e) => { const ls = [...lines]; ls[i] = { ...l, line: e.target.value }; setLines(ls); }} />
            </div>
          ))}
          {!lines.length && <p className="text-xs text-mute">{t("No spoken lines in this language.")}</p>}
          {!disabled && (
            <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />}
              onClick={() => setLines([...lines, { character_id: form.characters?.[0] ?? (cast?.[0]?.id ?? "NARRATOR"), line: "", emotion: "" }])}>
              {t("Add line")}
            </Button>
          )}
          {!lines.length && lang !== project.primary_language && (form.dialogue?.[project.primary_language]?.length ?? 0) > 0 && (
            <p className="text-2xs text-dim">{t("Not translated yet — run \"Dub\" on the Export page, or type the {lang} lines here.", { lang: langName })}</p>
          )}
        </div>
      </Collapse>

      <Collapse memo="sound" title={t("Narration & sound")} icon={<Volume2 />} defaultOpen={!!(shot.narration?.[lang] || shot.sfx || shot.music_cue)}
        summary={[narration && t("voice-over"), form.sfx && t("sound effects"), form.music_cue && t("music cue")].filter(Boolean).join(" · ") || t("Nothing written yet")}>
        <div className="space-y-3">
          <Field label={t("Narration / voice-over · {lang}", { lang: langName })}>
            <Textarea rows={2} value={narration} disabled={disabled} onChange={(e) => set("narration", { ...(form.narration || {}), [lang]: e.target.value })} />
          </Field>
          <div className="grid gap-3 @md:grid-cols-2">
            <Field label={t("Sound effects")}><Input value={form.sfx || ""} disabled={disabled} onChange={(e) => set("sfx", e.target.value)} /></Field>
            <Field label={t("Music cue")}><Input value={form.music_cue || ""} disabled={disabled} onChange={(e) => set("music_cue", e.target.value)} /></Field>
          </div>
        </div>
      </Collapse>

      <Collapse memo="advanced" title={t("Advanced")} icon={<Settings2 />} defaultOpen={false}
        summary={contShot ? t("Continues from {code} · mode, quality, voice, trim, notes", { code: contShot.code }) : t("Mode, quality, voice, trim, notes")}>
        <div className="space-y-3">
          <div className="grid gap-3 @md:grid-cols-3">
            <Field label={t("Generation mode")}>
              <Select value={form.mode || "auto"} disabled={disabled} onChange={(e) => set("mode", e.target.value)}>
                {Object.entries(SHOT_MODES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
              </Select>
            </Field>
            <Field label={t("Quality (this shot)")}>
              <Select value={form.quality_mode || ""} disabled={disabled} onChange={(e) => set("quality_mode", e.target.value || null)}>
                <option value="">{t("Project default")}</option>
                {Object.entries(QUALITY_INFO).map(([k, v]) => <option key={k} value={k}>{t(v.label)}</option>)}
              </Select>
            </Field>
            <Field label={t("Voice mode")}>
              <Select value={form.voice_mode || "auto"} disabled={disabled} onChange={(e) => set("voice_mode", e.target.value)}>
                {Object.entries(VOICE_MODES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
                {form.voice_mode && !VOICE_MODES[form.voice_mode] && <option value={form.voice_mode}>{t(form.voice_mode.replaceAll("_", " "))}</option>}
              </Select>
            </Field>
          </div>
          <div className="grid items-end gap-3 @md:grid-cols-3">
            <Field label={t("Trim start (s)")}><Input type="number" step="0.1" min={0} value={form.trim_in ?? 0} disabled={disabled} onChange={(e) => set("trim_in", Number(e.target.value))} /></Field>
            <Field label={t("Trim end (s)")}><Input type="number" step="0.1" min={0} value={form.trim_out ?? 0} disabled={disabled} onChange={(e) => set("trim_out", Number(e.target.value))} /></Field>
          </div>

          {/* continuity from a specific shot (v3) */}
          <div className="rounded-lg border border-line bg-raised/30 p-2.5">
            <div className="grid items-end gap-3 @md:grid-cols-[minmax(0,1fr)_auto]">
              <Field label={t("Continues from")} hint={t("Start this shot where another one ends: its last frame becomes the first frame, or its video is extended.")}>
                <Select value={contFrom ?? ""} disabled={disabled || !ep} aria-label={t("Continues from")}
                  onChange={(e) => { const id = e.target.value ? Number(e.target.value) : null; void v3.set({ continuity_from_shot_id: id, ...(id ? { continuity_mode: contMode } : {}) }); }}>
                  <option value="">{t("— fresh start")}</option>
                  {otherShots.map((s) => <option key={s.id} value={s.id}>{s.code}{s.action ? ` · ${s.action.slice(0, 48)}` : ""}</option>)}
                  {contFrom && !contShot && <option value={contFrom}>{t("Shot #{id}", { id: contFrom })}</option>}
                </Select>
              </Field>
              {contFrom && (
                <Field label={t("How")}>
                  <Segmented size="sm" value={contMode} aria-label={t("Continuity mode")}
                    onChange={(v) => !disabled && void v3.set({ continuity_mode: v })}
                    options={[
                      { value: "last_frame" as const, label: t("Last frame"), title: t("Its last frame becomes this shot's first frame") },
                      { value: "extend" as const, label: t("Extend"), title: t("Extend its video instead of starting a new one") },
                    ]} />
                </Field>
              )}
            </div>
            {!ep && <Skeleton className="mt-2 h-3 w-40" />}
            {!v3.managed && !disabled && <p className="mt-1.5 flex items-center gap-1 text-2xs text-dim"><Link2 className="size-3" />{t("Saved as soon as you change it.")}</p>}
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Toggle checked={!!form.continuity_from_prev} disabled={disabled} onChange={(v) => set("continuity_from_prev", v)} label={<span className="text-xs">{t("Continue from previous shot")}</span>} />
            <Toggle checked={form.include !== false} disabled={disabled} onChange={(v) => set("include", v)} label={<span className="text-xs">{t("Include in cut")}</span>} />
          </div>
          <Field label={t("Notes")}><Input value={form.notes || ""} disabled={disabled} onChange={(e) => set("notes", e.target.value)} /></Field>
        </div>
      </Collapse>
    </div>
  );
}

/**
 * The v3 shot fields (props, continuity source). The drawer seeds and saves its form from a fixed field list: when
 * these keys are in that form they ride along with the Save button; otherwise they are saved the moment they change.
 */
function useShotV3(shot: Shot, form: Partial<Shot>, setForm: (f: Partial<Shot>) => void) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<{ id: number; patch: ShotV3Fields }>({ id: shot.id, patch: {} });
  const base = shot as Shot & ShotV3Fields;
  const managed = "prop_ids" in form && "continuity_from_shot_id" in form;
  const get = <K extends keyof ShotV3Fields>(k: K): ShotV3Fields[K] => {
    if (k in form) return (form as Partial<Shot> & ShotV3Fields)[k];
    if (local.id === shot.id && k in local.patch) return local.patch[k];
    return base[k];
  };
  const set = async (patch: ShotV3Fields) => {
    const keys = Object.keys(patch) as (keyof ShotV3Fields)[];
    if (keys.every((k) => k in form)) { setForm({ ...form, ...patch }); return; }
    const before = local;
    setLocal((l) => ({ id: shot.id, patch: { ...(l.id === shot.id ? l.patch : {}), ...patch } }));
    try {
      await api.patch(`/api/shots/${shot.id}`, patch);
      qc.invalidateQueries({ queryKey: ["shot", shot.id] });
      qc.invalidateQueries({ queryKey: ["episode"] });
      toast.success(tr("Shot saved"), { id: "shot-v3-saved" });
    } catch { setLocal(before); }
  };
  return { get, set, managed };
}

/** One character's outfit for this shot: its named costumes, or (older characters) the outfit names found on its images. */
function OutfitPicker({ c, value, disabled, onChange }: { c: Character; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const t = useT();
  const { data: costumes } = useCostumes(c.id);
  const fromAssets = Array.from(new Set((c.assets ?? []).filter((a) => a.kind === "outfit").map((a) => a.outfit).filter(Boolean)));
  const names = costumes?.length ? costumes.map((x) => x.name) : fromAssets;
  if (!names.length && !value) return null;
  const def = costumes?.find((x) => x.is_default);
  return (
    <Field label={t("{name}'s outfit", { name: c.name })}>
      <Select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{def ? t("Default ({name})", { name: def.name }) : t("Default (from DNA)")}</option>
        {names.map((o) => <option key={o} value={o}>{o}</option>)}
        {value && !names.includes(value) && <option value={value}>{value}</option>}
      </Select>
    </Field>
  );
}

/** Props in the shot: chips from the project's prop library, with quick-add by typing a name. */
function PropsPicker({ projectId, value, disabled, onChange }: { projectId: number; value: number[]; disabled: boolean; onChange: (ids: number[]) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: props, isLoading } = useProps(projectId);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const list = (props ?? []).filter((p) => !p.archived);
  const query = q.trim().toLowerCase();
  const shown = list.filter((p) => !query || p.name.toLowerCase().includes(query) || value.includes(p.id));
  const exact = list.find((p) => p.name.toLowerCase() === query);
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  const add = async () => {
    const name = q.trim();
    if (!name || disabled) return;
    if (exact) { if (!value.includes(exact.id)) onChange([...value, exact.id]); setQ(""); return; }
    setAdding(true);
    try {
      const p = await createProp({ name, project_id: projectId });
      await qc.invalidateQueries({ queryKey: ["props", projectId] });
      onChange([...value, p.id]);
      setQ("");
      toast.success(tr("Prop added: {name}", { name: p.name }));
    } catch { /* api toasts */ } finally { setAdding(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") { e.preventDefault(); void add(); } };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-mute">{t("Props in shot")}</span>
        {value.length > 0 && <span className="mono text-2xs tabular-nums text-dim">{t("{n} selected", { n: value.length })}</span>}
      </div>
      {isLoading ? <div className="flex gap-1.5"><Skeleton className="h-7 w-20" /><Skeleton className="h-7 w-24" /></div> : (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Props in shot")}>
          {shown.map((p) => {
            const on = value.includes(p.id);
            return (
              <button key={p.id} type="button" disabled={disabled} aria-pressed={on} onClick={() => toggle(p.id)} title={p.description || undefined}
                className={clsx("inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border pl-1 pr-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60",
                  on ? "border-accent/50 bg-accent/10 text-ink shadow-[0_0_12px_-6px_var(--color-accent)]" : "border-line text-mute hover:border-dim/60 hover:text-ink")}>
                {p.url ? <img src={p.url} alt="" className="size-5 rounded-md object-cover" /> : <span className="grid size-5 place-items-center rounded-md bg-raised text-dim"><Package className="size-3" /></span>}
                <span className="truncate">{p.name}</span>
                {on && <Check className="size-3 text-accent-ink" strokeWidth={3} />}
              </button>
            );
          })}
          {!list.length && !query && <p className="text-2xs text-dim">{t("No props yet — type a name below to add one.")}</p>}
          {query && !shown.length && !exact && <p className="text-2xs text-dim">{t("No prop called “{q}” — press Enter to add it.", { q: q.trim() })}</p>}
        </div>
      )}
      {!disabled && (
        <div className="flex items-center gap-1.5">
          <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t("Find or add a prop (e.g. brass lamp)")} aria-label={t("Find or add a prop")} className="!h-8 text-xs" />
          <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} loading={adding} disabled={!q.trim()} onClick={add}>{exact ? t("Select") : t("Add")}</Button>
        </div>
      )}
    </div>
  );
}

/** Engine choice for the shot, the lip-sync engine for the next run, and the shootout entry point. */
function EngineCard({ shot, canEdit, hasLines, lipEngine, setLipEngine, onShootout }: {
  shot: Shot; canEdit: boolean; hasLines: boolean; lipEngine: string; setLipEngine: (id: string) => void; onShootout: () => void;
}) {
  const t = useT();
  return (
    <Collapse memo="engine" title={t("Engine")} icon={<Cpu />} summary={t("The model that makes this shot. Auto follows your team's routing policy.")}
      actions={canEdit ? (
        <Tooltip content={t("Generate this shot with 2–4 engines and pick the best")} side="left">
          <Button size="sm" variant="outline" icon={<Swords className="size-3.5" />} onClick={onShootout}>{t("Shootout")}</Button>
        </Tooltip>
      ) : undefined}>
      <div className="space-y-2">
        <EnginePicker key={shot.id} shot={shot} canEdit={canEdit} embedded />
        {canEdit && hasLines && (
          <EnginePicker key={`lip-${shot.id}`} shot={shot} purpose="lipsync" canEdit={canEdit} value={lipEngine} onChange={setLipEngine} label={t("Lip-sync engine")} embedded />
        )}
      </div>
    </Collapse>
  );
}
