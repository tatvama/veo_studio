import { ArrowRight, Grid3x3 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { useUI } from "../../lib/store";
import type { Episode, Shot } from "../../lib/types";
import { LoadError, RoomEmpty } from "../room/kit";
import { Button, Panel, Skeleton } from "../ui";
import { SHOT_STATES, shotState, STATE_STYLE, stateLabel, type ShotState } from "./shotState";

interface Group { key: string; title: string; shots: { shot: Shot; n: number; state: ShotState }[] }

/** Splits the (already ordered) shots into runs that share a scene, numbering them across the episode. */
function groupShots(shots: Shot[], episode: Episode): Group[] {
  const out: Group[] = [];
  shots.forEach((shot, i) => {
    const key = String(shot.scene_id ?? "none");
    const last = out[out.length - 1];
    const item = { shot, n: i + 1, state: shotState(shot) };
    if (last && last.key.split("#")[0] === key) { last.shots.push(item); return; }
    const sc = (episode.scenes ?? []).find((x) => x.id === shot.scene_id);
    out.push({ key: `${key}#${out.length}`, title: sc?.title ?? "", shots: [item] });
  });
  return out;
}

/** Every shot of the episode as a cell coloured by where it stands. Hover or focus for details, click to open it in the storyboard. */
export function ShotMap({ episode, loading, error, onRetry, pid, index, className }: {
  episode: Episode | undefined; loading: boolean; error: boolean; onRetry: () => void; pid: number; index?: number; className?: string;
}) {
  const t = useT();
  const nav = useNavigate();
  const setSelectedShot = useUI((u) => u.setSelectedShot);
  const [hot, setHot] = useState<number | null>(null);

  const shots = useMemo(() => (episode?.shots ?? []).filter((s) => s.include), [episode]);
  const groups = useMemo(() => (episode ? groupShots(shots, episode) : []), [shots, episode]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(SHOT_STATES.map((s) => [s, 0])) as Record<ShotState, number>;
    for (const g of groups) for (const x of g.shots) c[x.state]++;
    return c;
  }, [groups]);
  const active = useMemo(() => groups.flatMap((g) => g.shots).find((x) => x.shot.id === hot), [groups, hot]);
  const open = (id: number) => { setSelectedShot(id); nav(`/p/${pid}/storyboard`); };
  const eyebrow = t("Shot map");
  const link = <Link to={`/p/${pid}/storyboard`} className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">{t("Storyboard")}<ArrowRight className="size-3.5" /></Link>;

  if (error && !episode) return <Panel index={index} className={className} eyebrow={eyebrow} icon={<Grid3x3 />}><LoadError what={t("Couldn't load the shots")} onRetry={onRetry} /></Panel>;
  if (loading || !episode) {
    return (
      <Panel index={index} className={className} eyebrow={eyebrow} icon={<Grid3x3 />}>
        <div aria-busy="true"><Skeleton className="h-1.5 w-full" /><div className="mt-4 flex flex-wrap gap-1.5">{Array.from({ length: 24 }, (_, i) => <Skeleton key={i} className="size-9 !rounded-md" />)}</div></div>
      </Panel>
    );
  }
  if (!shots.length) {
    return (
      <Panel index={index} className={className} eyebrow={eyebrow} icon={<Grid3x3 />}>
        <RoomEmpty icon={<Grid3x3 />} title={t("No shots yet")} sub={t("Every shot of the episode will appear here as a cell, coloured by how far it has come.")}
          action={<Button size="sm" variant="primary" onClick={() => nav(`/p/${pid}/${episode.script?.scenes?.length ? "scenes" : "shots"}`)}>{episode.script?.scenes?.length ? t("Plan scenes") : t("Open shot list")}</Button>} />
      </Panel>
    );
  }

  const multi = groups.length > 1;
  return (
    <Panel index={index} className={className} eyebrow={eyebrow} icon={<Grid3x3 />} actions={link}>
      <div className="@container">
        <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-line" role="img"
          aria-label={SHOT_STATES.filter((s) => counts[s]).map((s) => `${stateLabel(t, s)} ${counts[s]}`).join(", ")}>
          {SHOT_STATES.map((s) => counts[s] > 0 && (
            <span key={s} style={{ flexGrow: counts[s] }} className={cn("min-w-[3px] basis-0", STATE_STYLE[s].bar, s === "generating" && "sweep")} />
          ))}
        </div>

        <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-3" aria-label={t("Shots")}>
          {groups.map((g, gi) => {
            const done = g.shots.filter((x) => x.state === "approved").length;
            return (
              <li key={g.key} className="min-w-0 max-w-full">
                {multi && (
                  <p className="mono mb-1.5 flex items-center gap-1.5 text-2xs text-dim" title={g.title}>
                    <span className="uppercase tracking-wider">{g.title ? `S${String(gi + 1).padStart(2, "0")}` : t("Loose")}</span>
                    <span aria-hidden className="h-px w-3 bg-line" />
                    <span className={done === g.shots.length ? "text-ok" : ""}>{done}/{g.shots.length}</span>
                  </p>
                )}
                <ul className="flex flex-wrap gap-1.5">
                  {g.shots.map(({ shot, n, state }) => {
                    const st = STATE_STYLE[state];
                    const Glyph = st.icon;
                    const label = `${shot.code} · ${stateLabel(t, state)} · ${shot.duration_s}s`;
                    return (
                      <li key={shot.id}>
                        <button type="button" onClick={() => open(shot.id)} onMouseEnter={() => setHot(shot.id)} onMouseLeave={() => setHot(null)}
                          onFocus={() => setHot(shot.id)} onBlur={() => setHot(null)} aria-label={label} title={label}
                          className={cn("relative grid size-10 place-items-center rounded-md border mono text-2xs font-medium outline-none transition-[transform,box-shadow] hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-accent/60 @xl:size-9",
                            st.cell, hot === shot.id && "shadow-[0_0_0_1px_var(--color-accent)]")}>
                          {String(n).padStart(2, "0")}
                          {state !== "draft" && state !== "keyframe" && state !== "video" && (
                            <Glyph aria-hidden className="absolute right-[2px] top-[2px] size-2.5" strokeWidth={3} />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex min-h-9 items-center gap-2 rounded-lg border border-line bg-raised/50 px-3 py-1.5 text-xs" aria-live="polite">
          {active ? (
            <>
              <span className="mono font-semibold text-ink">{active.shot.code}</span>
              <span className={cn("mono text-2xs uppercase tracking-wider", STATE_STYLE[active.state].cell.split(" ").find((c) => c.startsWith("text-")))}>{stateLabel(t, active.state)}</span>
              <span className="mono text-dim">{active.shot.duration_s}s</span>
              <span className="min-w-0 flex-1 truncate text-mute">{active.shot.action}</span>
            </>
          ) : <span className="text-dim">{t("Hover a shot for details. Click one to open it in the storyboard.")}</span>}
        </div>

        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label={t("Legend")}>
          {SHOT_STATES.map((s) => {
            const Glyph = STATE_STYLE[s].icon;
            return (
              <li key={s} className={cn("flex items-center gap-1.5 text-2xs", counts[s] ? "text-mute" : "text-dim/70")}>
                <span aria-hidden className={cn("grid size-4 place-items-center rounded-[3px] border", STATE_STYLE[s].cell.replace("gen-ring", ""))}><Glyph className="size-2.5" strokeWidth={3} /></span>
                {stateLabel(t, s)}<span className="mono text-ink">{counts[s]}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}
