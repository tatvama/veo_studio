import { clsx } from "clsx";
import { Clapperboard, Download, Film, Image as ImageIcon, MapPin, Plus } from "lucide-react";
import { useMemo } from "react";
import { secs as fmtSecs } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { Character, Episode, Location, Shot } from "../../../lib/types";
import { outlineGroups } from "../studio/Outline";
import { useActions } from "./actions";
import type { SceneX } from "./data";
import { lengthLabel, shotDots, shotFlags, shotSeconds, type CanvasInfo } from "./model";
import { Faces, PriceButton, StepDots } from "./parts";

/** Everything Make all runs on a phone: what is still missing, through the music (the render is its own button). */
const MAKE_ALL = { action: "produce", steps: ["cast", "keyframes", "videos", "extend", "voices", "sound", "music"] };

/**
 * The canvas on a phone: no dragging, a list of scenes with their shot cards (the same five steps), a tap opens the shot
 * in a sheet, and one sticky "Make all".
 */
export function PhoneList({ episode, cast, places, info, onOpen, onOpenScene }: {
  episode: Episode; cast: Character[]; places: Location[]; info?: CanvasInfo; onOpen: (shotId: number) => void; onOpenScene: (sceneId: number) => void;
}) {
  const t = useT();
  const a = useActions();
  const groups = useMemo(() => outlineGroups(episode), [episode]);
  const byId = useMemo(() => new Map(cast.map((c) => [c.id, c])), [cast]);
  const shots = groups.flatMap((g) => g.shots);
  const total = shots.reduce((s, x) => s + shotSeconds(x.duration_s, x.extend_to), 0);
  const ready = (episode.exports ?? []).find((x) => x.kind !== "animatic" && x.status === "ready" && x.url) ?? null;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-24 pt-3">
        {groups.map((g, gi) => {
          const sc = g.scene as SceneX | null;
          const place = sc?.location_id ? places.find((l) => l.id === sc.location_id) : undefined;
          return (
            <section key={sc?.id ?? "none"} aria-label={sc?.title || t("Shots without a scene")}>
              <button type="button" disabled={!sc} onClick={() => sc && onOpenScene(sc.id)}
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left">
                <span className="mono rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-2xs font-semibold text-accent-ink">{sc ? `SC${String(gi + 1).padStart(2, "0")}` : "—"}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{sc?.title || t("Shots without a scene")}</span>
                {place && <span className="inline-flex max-w-[8rem] items-center gap-1 truncate text-2xs text-info"><MapPin className="size-3 shrink-0" />{place.name}</span>}
                {sc?.time_of_day && <span className="text-2xs text-dim">{sc.time_of_day}</span>}
              </button>
              <div className="mt-1.5 space-y-2">
                {g.shots.map((s) => <PhoneShot key={s.id} shot={s} people={s.characters.map((c) => byId.get(c)).filter((c): c is Character => !!c)}
                  info={info} onOpen={() => onOpen(s.id)} />)}
                {a.canEdit && (
                  <button type="button" onClick={() => void a.addShot(sc?.id ?? null)}
                    className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line text-xs font-medium text-mute">
                    <Plus className="size-4" />{t("Add a shot")}
                  </button>
                )}
              </div>
            </section>
          );
        })}
        <section className="hud relative rounded-xl border border-accent/40 bg-panel p-3">
          <p className="eyebrow">{t("The film")}</p>
          <p className="mono text-lg font-semibold tabular-nums">{fmtSecs(total)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {a.canEdit && <PriceButton eid={a.eid} size="md" body={{ action: "export" }} label={t("Render")} icon={<Film className="size-4" />} onRun={a.render}
              disabled={!shots.some((s) => s.video)} />}
            {ready && <a href={ready.url} download className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-raised px-3 text-sm"><Download className="size-4" />{t("Download")}</a>}
          </div>
        </section>
      </div>
      {a.canEdit && shots.length > 0 && (
        <div className="sticky bottom-0 border-t border-line bg-panel/95 p-3 backdrop-blur">
          <PriceButton eid={a.eid} block size="md" body={{ ...MAKE_ALL }} label={t("Make all")} doneLabel={t("Everything is made")}
            icon={<Clapperboard className="size-4" />} onRun={() => a.run({ ...MAKE_ALL }, t("Make all"))}
            className="h-11" />
        </div>
      )}
    </div>
  );
}

function PhoneShot({ shot, people, info, onOpen }: { shot: Shot; people: Character[]; info?: CanvasInfo; onOpen: () => void }) {
  const t = useT();
  const a = useActions();
  const dots = useMemo(() => shotDots(shot, info?.shots[String(shot.id)]), [shot, info]);
  const flags = shotFlags(dots);
  const poster = shot.video?.thumb_url || shot.keyframe?.thumb_url || "";
  return (
    <div className={clsx("rounded-xl border bg-panel p-2", flags.failed.length ? "border-bad/50" : "border-line")}>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-2.5 text-left">
        <span className="scr relative aspect-video w-28 shrink-0">
          {poster ? <img src={poster} alt="" loading="lazy" className="size-full object-cover" /> : <span className="scr-empty grid size-full place-items-center text-white/35"><ImageIcon className="size-5" /></span>}
          {(flags.running || shot.generating) && <span className="absolute right-1 top-1 rounded bg-black/65 px-1"><span className="eq"><i /><i /><i /><i /></span></span>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="mono text-2xs font-semibold text-mute">{shot.code}</span>
            <span className="mono text-2xs text-dim">{lengthLabel(shot.duration_s, shot.extend_to)}</span>
            {flags.stale.length > 0 && <span className="mono text-2xs font-semibold uppercase text-warn">{t("Out of date")}</span>}
            {flags.failed.length > 0 && <span className="mono text-2xs font-semibold uppercase text-bad">{t("Failed")}</span>}
          </span>
          <span className="mt-0.5 line-clamp-2 text-xs">{shot.action || <span className="text-dim">{t("No words yet")}</span>}</span>
          <span className="mt-1 block"><Faces people={people} size={20} /></span>
        </span>
      </button>
      <StepDots dots={dots} size="lg" canEdit={a.canEdit} onRun={(s) => void a.runStep(shot.id, s)} className="mt-2 justify-between" />
    </div>
  );
}
