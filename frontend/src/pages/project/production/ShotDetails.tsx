import { clsx } from "clsx";
import { Camera, Check, Clapperboard, Cpu, Lock, Plus, Settings2, Speech, Swords, Trash2, Volume2 } from "lucide-react";
import EnginePicker from "../../../components/hub/EnginePicker";
import { Avatar, Badge, Button, Field, Input, Segmented, Select, Textarea, Toggle, Tooltip } from "../../../components/ui";
import { LANG_NAMES, QUALITY_INFO, SHOT_MODES, VOICE_MODES } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useCharacters, useLocations } from "../../../lib/queries";
import type { DialogueLine, Shot } from "../../../lib/types";
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
  const set = (k: keyof Shot, v: any) => setForm({ ...form, [k]: v });
  const setLines = (ls: DialogueLine[]) => set("dialogue", { ...(form.dialogue || {}), [lang]: ls });
  const inShot = (cast ?? []).filter((c) => form.characters?.includes(c.id));
  const speakers = new Set(lines.map((l) => String(l.character_id)));
  const outfitsFor = (cid: number) => Array.from(new Set((cast?.find((c) => c.id === cid)?.assets ?? []).filter((a) => a.kind === "outfit").map((a) => a.outfit)));
  const langName = LANG_NAMES[lang] ?? lang;
  const narration = form.narration?.[lang] || "";

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
                    className={clsx("flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs transition-colors disabled:opacity-60",
                      on ? "border-accent/60 bg-accent/10 text-ink" : "border-line text-mute hover:border-dim/60 hover:text-ink")}>
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
          {inShot.some((c) => outfitsFor(c.id).length) && (
            <div className="grid gap-3 @md:grid-cols-2">
              {inShot.filter((c) => outfitsFor(c.id).length).map((c) => (
                <Field key={c.id} label={t("{name}'s outfit", { name: c.name })}>
                  <Select value={form.outfits?.[String(c.id)] || ""} disabled={disabled}
                    onChange={(e) => set("outfits", { ...(form.outfits || {}), [String(c.id)]: e.target.value })}>
                    <option value="">{t("Default (from DNA)")}</option>
                    {outfitsFor(c.id).map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
          )}
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
            <div key={i} className="space-y-1.5 rounded-lg border border-line bg-panel p-2">
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

      <Collapse memo="advanced" title={t("Advanced")} icon={<Settings2 />} defaultOpen={false} summary={t("Mode, quality, voice, trim, notes")}>
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

/** Engine choice for the shot, the lip-sync engine for the next run, and the shootout entry point. */
function EngineCard({ shot, canEdit, hasLines, lipEngine, setLipEngine, onShootout }: {
  shot: Shot; canEdit: boolean; hasLines: boolean; lipEngine: string; setLipEngine: (id: string) => void; onShootout: () => void;
}) {
  const t = useT();
  return (
    <section className="rounded-xl border border-line bg-raised/35">
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent/12 text-accent-ink"><Cpu className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold tracking-tight">{t("Engine")}</h4>
          <p className="truncate text-2xs text-dim">{t("The model that makes this shot. Auto follows your team's routing policy.")}</p>
        </div>
        {canEdit && (
          <Tooltip content={t("Generate this shot with 2–4 engines and pick the best")} side="left">
            <Button size="sm" variant="outline" icon={<Swords className="size-3.5" />} onClick={onShootout}>{t("Shootout")}</Button>
          </Tooltip>
        )}
      </header>
      <div className="space-y-2 border-t border-line/70 p-2.5">
        <EnginePicker key={shot.id} shot={shot} canEdit={canEdit} embedded />
        {canEdit && hasLines && (
          <EnginePicker key={`lip-${shot.id}`} shot={shot} purpose="lipsync" canEdit={canEdit} value={lipEngine} onChange={setLipEngine} label={t("Lip-sync engine")} embedded />
        )}
      </div>
    </section>
  );
}
