import { AlertTriangle, AtSign, AudioLines, Check, Clock, Drama, MapPin, Mic, Music, Palette, Sparkles, UserPlus, Volume2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { Character, ImportResult } from "../../lib/types";
import { Fact } from "../room/kit";
import { NARRATOR_TONE, makeToneMap, type Tone } from "../room/util";
import { SpeakerChip, pad } from "../room/workspace";
import { Alert, Badge } from "../ui";

/** The notes the script gave a scene or a shot (mood, look, sound, music, sound effects), one per line. */
function Notes({ items }: { items: [string, ReactNode, string | undefined][] }) {
  const shown = items.filter(([, , text]) => text?.trim());
  if (!shown.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 text-2xs leading-snug text-mute">
      {shown.map(([label, icon, text]) => (
        <li key={label} className="flex items-start gap-1.5">
          <span aria-hidden className="mt-px shrink-0 text-dim [&>svg]:size-3">{icon}</span>
          <span className="min-w-0"><span className="font-medium text-ink/80">{label}:</span> {text}</span>
        </li>
      ))}
    </ul>
  );
}

export type CastPick = { kind: "existing"; id: number } | { kind: "new" } | { kind: "vo" };
export const NEW_PICK: CastPick = { kind: "new" };

/** What a script name becomes once the picks are applied. */
export function castOf(name: string, picks: Record<string, CastPick>, pool: Map<number, Character>): { label: string; vo: boolean; isNew: boolean } {
  const p = name === "VO" ? { kind: "vo" as const } : picks[name] ?? NEW_PICK;
  if (p.kind === "vo") return { label: "", vo: true, isNew: false };
  if (p.kind === "existing") return { label: pool.get(p.id)?.name ?? name, vo: false, isNew: false };
  return { label: name, vo: false, isNew: true };
}

/** A big mono number over a tiny label. */
function Figure({ n, label }: { n: number; label: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className="mono text-lg font-medium leading-none tracking-tight text-ink">{n}</span>
    </span>
  );
}

/** "Arranged by AI · 3 scenes, 7 shots, 12 lines": a hairline strip shown on the cast and preview steps. */
export function ImportSummary({ res }: { res: ImportResult }) {
  const t = useT();
  const ai = res.method === "ai";
  return (
    <div className="hud relative flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-line bg-raised/30 px-3.5 py-2.5"
      aria-label={t("{s} scenes, {n} shots, {l} lines", { s: res.stats.scenes, n: res.stats.shots, l: res.stats.lines })} role="group">
      <div className="flex min-w-0 flex-1 basis-48 flex-col items-start gap-1.5">
        <Badge tone={ai ? "ai" : "ok"}>{ai ? <><Sparkles className="size-3" />{t("Arranged by AI")}</> : <><Check className="size-3" />{t("Read from your layout")}</>}</Badge>
        <span className="mono max-w-full truncate text-2xs text-dim" title={res.source}>{res.source}</span>
      </div>
      <div className="flex items-end gap-6">
        <Figure n={res.stats.scenes} label={t("Scenes")} />
        <Figure n={res.stats.shots} label={t("Shots")} />
        <Figure n={res.stats.lines} label={t("Dialogue")} />
        <Figure n={res.characters.length} label={t("Characters")} />
      </div>
    </div>
  );
}

/**
 * Everything the import will do, before anything is saved: stats, parser warnings, who gets created, then the script as a
 * read-only screenplay: scene headings with a mono number in the margin, shots as sub-blocks with their VISUAL line, dialogue as
 * a speaker chip over the words (speakers shown as the cast member they map to, or Voice-over).
 */
/** The story at a glance before anything is saved: the counts, then everyone the script names (who they are, how they're read). */
function StoryCheck({ res, picks, pool, onPeople }: {
  res: ImportResult; picks: Record<string, CastPick>; pool: Map<number, Character>; onPeople?: () => void;
}) {
  const t = useT();
  const shots = res.draft.scenes.flatMap((s) => s.shots);
  const isVo = (speaker: string) => speaker === "VO" || (picks[speaker] ?? NEW_PICK).kind === "vo";
  const voLines = shots.reduce((a, h) => a + h.lines.filter((l) => isVo(l.speaker)).length, 0);
  const seconds = shots.reduce((a, h) => a + Math.max(h.extend_to || 0, h.duration_s || 0), 0);
  const people = res.characters.filter((c) => (picks[c.name] ?? NEW_PICK).kind !== "vo");
  const length = seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}` : `${Math.round(seconds)}s`;
  return (
    <div className="space-y-3">
      <div className="hud relative grid grid-cols-2 gap-x-5 gap-y-3 rounded-xl border border-line bg-raised/30 px-3.5 py-3 @md:grid-cols-5" role="group"
        aria-label={t("{s} scenes, {n} shots, {p} people, {v} voice-over lines, {l} long", { s: res.draft.scenes.length, n: shots.length, p: people.length, v: voLines, l: length })}>
        <Figure n={res.draft.scenes.length} label={t("Scenes")} />
        <Figure n={shots.length} label={t("Shots")} />
        <Figure n={people.length} label={t("People")} />
        <Figure n={voLines} label={t("Voice-over lines")} />
        <span className="flex flex-col gap-1">
          <span className="eyebrow">{t("Length")}</span>
          <span className="mono text-lg font-medium leading-none tracking-tight text-ink">{length}</span>
        </span>
      </div>
      {people.length > 0 && (
        <div className="rounded-xl border border-line">
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
            <span className="eyebrow flex-1">{t("People in your story")}</span>
            {onPeople && <button type="button" onClick={onPeople} className="text-2xs font-medium text-accent-ink hover:underline">{t("Change who is who")}</button>}
          </div>
          <ul className="grid divide-y divide-line @2xl:grid-cols-2 @2xl:divide-y-0">
            {people.map((c) => {
              const p = picks[c.name] ?? NEW_PICK;
              const matchedTo = p.kind === "existing" ? pool.get(p.id)?.name : undefined;
              const facts = [c.gender ? t(c.gender) : "", c.age ? t("age {age}", { age: c.age }) : "",
                c.lines ? (c.lines === 1 ? t("1 line") : t("{n} lines", { n: c.lines })) : t("on screen, no lines")].filter(Boolean).join(" · ");
              return (
                <li key={c.name} className="flex min-w-0 items-start gap-2.5 px-3.5 py-2 @2xl:border-b @2xl:border-line">
                  <span className="mono mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-line bg-raised text-2xs font-semibold text-mute">{c.name.charAt(0)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold uppercase tracking-wide">
                      {c.name}
                      {matchedTo ? <Badge tone="ok">{t("is {name}", { name: matchedTo })}</Badge> : <Badge tone="accent">{t("new")}</Badge>}
                    </span>
                    <span className="block text-2xs text-dim">{facts}</span>
                    {c.description && <span className="line-clamp-2 block text-2xs leading-snug text-mute" title={c.description}>{c.description}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ImportPreview({ res, picks, pool, hasShots, writeScript, onWriteScript, onPeople }: {
  res: ImportResult; picks: Record<string, CastPick>; pool: Map<number, Character>; hasShots: boolean; writeScript: boolean; onWriteScript: (v: boolean) => void;
  /** Opens the "who is who" step (match a name to someone in the cast, or read it as voice-over). */
  onPeople?: () => void;
}) {
  const t = useT();
  const creating = res.characters.filter((c) => (picks[c.name] ?? NEW_PICK).kind === "new").map((c) => c.name);
  const matched = res.characters.filter((c) => (picks[c.name] ?? NEW_PICK).kind === "existing").length;
  const vo = res.characters.filter((c) => (picks[c.name] ?? NEW_PICK).kind === "vo").length;
  const changed = res.draft.scenes.reduce((a, s) => a + s.shots.reduce((b, h) => b + h.lines.filter((l) => l.changed).length, 0), 0);
  const shots = res.draft.scenes.reduce((a, s) => a + s.shots.length, 0);
  // the cast keeps its colours (project cast first), names the import will create follow
  const toneOf = useMemo(() => makeToneMap([...pool.values()].map((c) => c.name).concat(res.characters.map((c) => castOf(c.name, picks, pool).label))), [pool, res, picks]);

  return (
    <div className="space-y-3">
      <StoryCheck res={res} picks={picks} pool={pool} onPeople={onPeople} />
      <p className="flex items-center gap-1.5 text-2xs text-dim">
        <Badge tone={res.method === "ai" ? "ai" : "ok"}>{res.method === "ai" ? <><Sparkles className="size-3" />{t("Arranged by AI")}</> : <><Check className="size-3" />{t("Read from your layout")}</>}</Badge>
        <span className="mono min-w-0 truncate" title={res.source}>{res.source}</span>
      </p>
      {res.warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
      {hasShots && <Alert tone="warn">{t("This replaces the current shot list. Shots with paid takes are kept out of the cut, not deleted.")}</Alert>}

      <div className="space-y-2 rounded-xl border border-line bg-raised/30 px-3.5 py-3 text-xs">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="mono font-medium">{t("{s} scenes · {n} shots", { s: res.draft.scenes.length, n: shots })}</span>
          {changed > 0 && <Badge tone="warn"><AlertTriangle className="size-3" />{t("{n} lines reworded by AI — check them", { n: changed })}</Badge>}
        </p>
        <p className="flex items-start gap-1.5 text-mute">
          <UserPlus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
          <span>
            {creating.length
              ? <>{creating.length === 1 ? t("Will create 1 character:") : t("Will create {n} characters:", { n: creating.length })} <span className="font-medium text-ink">{creating.join(", ")}</span></>
              : t("No new characters.")}
            {matched > 0 && <> · {matched === 1 ? t("1 name matched to the cast") : t("{n} names matched to the cast", { n: matched })}</>}
            {vo > 0 && <> · {vo === 1 ? t("1 read as voice-over") : t("{n} read as voice-over", { n: vo })}</>}
          </span>
        </p>
        <label className="flex cursor-pointer items-start gap-2.5 border-t border-line pt-2.5 pointer-coarse:min-h-10">
          <input type="checkbox" checked={writeScript} onChange={(e) => onWriteScript(e.target.checked)} className="mt-0.5 size-3.5" />
          <span>
            <span className="flex items-center gap-1 font-medium text-ink"><AtSign className="size-3" />{t("Write the Story script with @mentions")}</span>
            <span className="block text-2xs leading-snug text-dim">{t("Each scene's action becomes the VISUAL lines and every speaker is linked to a cast member. The current Story script is replaced.")}</span>
          </span>
        </label>
      </div>

      {/* the screenplay: a ledger rule at the margin, scene numbers in the gutter */}
      <div className="rm-page max-h-[44vh] overflow-y-auto rounded-xl border border-line bg-bg/40" role="region" aria-label={t("Preview")} tabIndex={0}>
        {res.draft.scenes.map((sc, i) => (
          <section key={i} className="border-b border-line/70 py-3 last:border-b-0">
            <div className="grid grid-cols-[var(--rm-gutter)_minmax(0,1fr)]">
              <div className="pr-2.5 pt-0.5 text-right"><span className="mono text-xs font-semibold text-accent-ink">{pad(i + 1)}</span></div>
              <div className="min-w-0 pl-3 pr-3">
                <h4 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold uppercase tracking-wide">
                  <span className="min-w-0">{sc.title || t("Scene {n}", { n: i + 1 })}</span>
                  {sc.location && <Fact icon={<MapPin />} className="normal-case tracking-normal">{sc.location}</Fact>}
                  {sc.time_of_day && <Fact icon={<Clock />} className="normal-case tracking-normal">{sc.time_of_day}</Fact>}
                </h4>
                {sc.summary && <p className="mt-1 text-xs italic leading-relaxed text-mute">{sc.summary}</p>}
                <Notes items={[[t("Mood"), <Drama />, sc.mood], [t("Look"), <Palette />, sc.look], [t("Sound"), <AudioLines />, sc.sound],
                  [t("Music"), <Music />, sc.music]]} />
              </div>
            </div>
            {sc.shots.map((sh, k) => {
              const onScreen = sh.characters.map((n) => castOf(n, picks, pool)).filter((c) => !c.vo);
              return (
                <div key={k} className="grid grid-cols-[var(--rm-gutter)_minmax(0,1fr)] pt-3">
                  <div className="pr-2.5 pt-0.5 text-right">
                    <span className="mono text-2xs text-dim" aria-hidden>{i + 1}.{k + 1}</span>
                    <span className="sr-only">{t("Shot {n}", { n: k + 1 })}</span>
                  </div>
                  <div className="min-w-0 space-y-2 pl-3 pr-3">
                    <p className="text-sm leading-relaxed">
                      <span className="eyebrow mr-1.5">{t("Visual")}</span>
                      {sh.prompt || <span className="text-dim">{t("No visual description")}</span>}
                      <span className="mono ml-2 whitespace-nowrap text-2xs text-dim">
                        {sh.extend_to ? t("{a}s → {b}s (voice-over)", { a: sh.duration_s, b: sh.extend_to }) : `${sh.duration_s}s`}
                      </span>
                    </p>
                    <Notes items={[[t("Sound effects"), <Volume2 />, sh.sfx]]} />
                    {onScreen.length > 0 && (
                      <p className="flex flex-wrap items-center gap-1 text-2xs text-dim">
                        {t("On screen:")}{onScreen.map((c, m) => <Speaker key={m} {...c} toneOf={toneOf} />)}
                      </p>
                    )}
                    {sh.lines.map((l, m) => {
                      const c = castOf(l.speaker, picks, pool);
                      return (
                        <div key={m} className="pl-2 @2xl:pl-8">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Speaker {...c} toneOf={toneOf} />
                            {l.emotion && <span className="text-2xs italic text-dim">({l.emotion})</span>}
                            {l.changed && <Badge tone="warn"><AlertTriangle className="size-3" />{t("Reworded")}</Badge>}
                          </div>
                          <p className={cn("mt-1 text-sm leading-relaxed", l.changed && "border-l-2 border-warn/60 pl-2")}>{l.text}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {!sc.shots.length && <p className="pl-[calc(var(--rm-gutter)+0.75rem)] pt-2 text-xs text-dim">{t("No shots in this scene.")}</p>}
          </section>
        ))}
        {!res.draft.scenes.length && <p className="px-4 py-6 text-center text-sm text-mute">{t("Nothing to import: no scenes were found.")}</p>}
      </div>
    </div>
  );
}

/** Who speaks: the mapped cast member in their colour (with a "new" mark when it will be created) or Voice-over. */
function Speaker({ label, vo, isNew, toneOf }: { label: string; vo: boolean; isNew: boolean; toneOf: (k: string) => Tone }) {
  const t = useT();
  return (
    <SpeakerChip tone={vo ? NARRATOR_TONE : toneOf(label)} icon={vo ? <Mic /> : undefined}
      title={vo ? t("Voice-over (narrator)") : isNew ? t("New character") : t("In the cast")}
      name={vo ? t("Voice-over") : (
        <>{label}{isNew && <span className="ml-1.5 rounded bg-accent/20 px-1 py-px normal-case tracking-normal text-accent-ink">{t("new")}</span>}</>
      )} />
  );
}
