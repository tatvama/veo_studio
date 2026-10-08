import { clsx } from "clsx";
import { AlertTriangle, AtSign, Check, Clock, MapPin, Mic, Sparkles, User, UserPlus } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { Character, ImportResult } from "../../lib/types";
import { Alert, Badge } from "../ui";
import { Fact } from "../room/kit";

export type CastPick = { kind: "existing"; id: number } | { kind: "new" } | { kind: "vo" };
export const NEW_PICK: CastPick = { kind: "new" };

/** What a script name becomes once the picks are applied. */
export function castOf(name: string, picks: Record<string, CastPick>, pool: Map<number, Character>): { label: string; vo: boolean; isNew: boolean } {
  const p = name === "VO" ? { kind: "vo" as const } : picks[name] ?? NEW_PICK;
  if (p.kind === "vo") return { label: "", vo: true, isNew: false };
  if (p.kind === "existing") return { label: pool.get(p.id)?.name ?? name, vo: false, isNew: false };
  return { label: name, vo: false, isNew: true };
}

/** "Arranged by AI · 3 scenes, 7 shots, 12 lines" — shown on the cast and preview steps. */
export function ImportSummary({ res }: { res: ImportResult }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-mute">
      <Badge tone={res.method === "ai" ? "accent" : "ok"}>{res.method === "ai" ? <><Sparkles className="size-3" />{t("Arranged by AI")}</> : <><Check className="size-3" />{t("Read from your layout")}</>}</Badge>
      <span>{res.source}</span>·<span>{t("{s} scenes, {n} shots, {l} lines", { s: res.stats.scenes, n: res.stats.shots, l: res.stats.lines })}</span>
    </div>
  );
}

/**
 * Everything the import will do, before anything is saved: stats, parser warnings, who gets created, then every scene with
 * its VISUAL text and dialogue (speakers shown as the cast member they map to, or Voice-over).
 */
export function ImportPreview({ res, picks, pool, hasShots, writeScript, onWriteScript }: {
  res: ImportResult; picks: Record<string, CastPick>; pool: Map<number, Character>; hasShots: boolean; writeScript: boolean; onWriteScript: (v: boolean) => void;
}) {
  const t = useT();
  const creating = res.characters.filter((c) => (picks[c.name] ?? NEW_PICK).kind === "new").map((c) => c.name);
  const matched = res.characters.filter((c) => (picks[c.name] ?? NEW_PICK).kind === "existing").length;
  const vo = res.characters.filter((c) => (picks[c.name] ?? NEW_PICK).kind === "vo").length;
  const changed = res.draft.scenes.reduce((a, s) => a + s.shots.reduce((b, h) => b + h.lines.filter((l) => l.changed).length, 0), 0);
  const shots = res.draft.scenes.reduce((a, s) => a + s.shots.length, 0);

  return (
    <div className="space-y-3">
      <ImportSummary res={res} />
      {res.warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
      {hasShots && <Alert tone="warn">{t("This replaces the current shot list. Shots with paid takes are kept out of the cut, not deleted.")}</Alert>}

      <div className="space-y-2 rounded-xl border border-line bg-raised/40 px-3 py-2.5 text-xs">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{t("{s} scenes · {n} shots", { s: res.draft.scenes.length, n: shots })}</span>
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
        <label className="flex cursor-pointer items-start gap-2 pt-1">
          <input type="checkbox" checked={writeScript} onChange={(e) => onWriteScript(e.target.checked)} className="mt-0.5 size-3.5" />
          <span>
            <span className="flex items-center gap-1 font-medium text-ink"><AtSign className="size-3" />{t("Write the Story script with @mentions")}</span>
            <span className="block text-2xs leading-snug text-dim">{t("Each scene's action becomes the VISUAL lines and every speaker is linked to a cast member. The current Story script is replaced.")}</span>
          </span>
        </label>
      </div>

      <div className="max-h-[48vh] space-y-3 overflow-y-auto pr-1">
        {res.draft.scenes.map((sc, i) => (
          <section key={i} className="rounded-xl border border-line bg-bg/40">
            <header className="flex flex-wrap items-center gap-2 px-3 pt-2.5">
              <span className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-2xs font-semibold text-mute">{String(i + 1).padStart(2, "0")}</span>
              <span className="min-w-0 truncate text-sm font-semibold uppercase tracking-wide">{sc.title || t("Scene {n}", { n: i + 1 })}</span>
              {sc.location && <Fact icon={<MapPin />}>{sc.location}</Fact>}
              {sc.time_of_day && <Fact icon={<Clock />}>{sc.time_of_day}</Fact>}
            </header>
            {sc.summary && <p className="px-3 pt-1 text-xs text-mute">{sc.summary}</p>}
            <div className="divide-y divide-line/60 px-3 pb-2">
              {sc.shots.map((sh, k) => {
                const onScreen = sh.characters.map((n) => castOf(n, picks, pool)).filter((c) => !c.vo);
                return (
                  <div key={k} className="space-y-1.5 py-2.5">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0 rounded-md border border-line px-1.5 py-px font-mono text-2xs font-semibold tabular-nums text-mute">{t("Shot {n}", { n: k + 1 })} · {sh.duration_s}s</span>
                      <p className="min-w-0 flex-1 text-sm leading-relaxed">
                        <span className="mr-1.5 text-2xs font-semibold uppercase tracking-wider text-dim">{t("Visual")}</span>
                        {sh.prompt || <span className="text-dim">{t("No visual description")}</span>}
                      </p>
                    </div>
                    {onScreen.length > 0 && (
                      <p className="flex flex-wrap items-center gap-1 pl-1 text-2xs text-dim">
                        {t("On screen:")}{onScreen.map((c, m) => <SpeakerChip key={m} {...c} small />)}
                      </p>
                    )}
                    {sh.lines.map((l, m) => {
                      const c = castOf(l.speaker, picks, pool);
                      return (
                        <div key={m} className="flex flex-wrap items-start gap-x-2 gap-y-1 pl-1">
                          <SpeakerChip {...c} />
                          <p className="min-w-0 flex-1 text-sm leading-relaxed">
                            {l.text}{l.emotion && <span className="ml-1.5 text-2xs text-dim">({l.emotion})</span>}
                          </p>
                          {l.changed && <Badge tone="warn"><AlertTriangle className="size-3" />{t("Reworded")}</Badge>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {!sc.shots.length && <p className="py-2 text-xs text-dim">{t("No shots in this scene.")}</p>}
            </div>
          </section>
        ))}
        {!res.draft.scenes.length && <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-mute">{t("Nothing to import: no scenes were found.")}</p>}
      </div>
    </div>
  );
}

/** Who speaks: the mapped cast member (with a "new" mark when it will be created) or Voice-over. */
function SpeakerChip({ label, vo, isNew, small }: { label: string; vo: boolean; isNew: boolean; small?: boolean }) {
  const t = useT();
  return (
    <span className={clsx("inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 font-semibold uppercase tracking-wider",
      small ? "h-5 text-2xs" : "h-6 text-2xs", vo ? "border-line bg-raised text-mute" : "border-accent/30 bg-accent/8 text-accent-ink")}
      title={vo ? t("Voice-over (narrator)") : isNew ? t("New character") : t("In the cast")}>
      {vo ? <Mic aria-hidden className="size-3 shrink-0" /> : <User aria-hidden className="size-3 shrink-0" />}
      <span className="truncate">{vo ? t("Voice-over") : label}</span>
      {isNew && !vo && <span className="rounded-full bg-accent/20 px-1 text-[length:inherit] normal-case tracking-normal">{t("new")}</span>}
    </span>
  );
}
