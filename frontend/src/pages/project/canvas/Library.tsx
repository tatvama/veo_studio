import { clsx } from "clsx";
import { Box, MapPin, Music, PanelLeftClose, UserPlus, Users } from "lucide-react";
import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Avatar, Badge, IconButton, Segmented } from "../../../components/ui";
import { secs as fmtSecs } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { Character, Episode, Location } from "../../../lib/types";
import type { Prop } from "../../../lib/v3";
import { outlineGroups } from "../studio/Outline";
import { useActions } from "./actions";
import type { SceneMusic } from "./model";
import { PlayChip, PriceButton } from "./parts";
import { DRAG_MIME, useCanvasUI, type DragPayload } from "./store";

type Tab = "cast" | "places" | "props" | "music";

/** A library item you can drag onto the canvas. */
function DragItem({ payload, enabled, onClick, active, children, label }: {
  payload: DragPayload; enabled: boolean; onClick?: () => void; active?: boolean; children: ReactNode; label: string;
}) {
  const start = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.setData("text/plain", payload.name);
    e.dataTransfer.effectAllowed = "copy";
    useCanvasUI.getState().setDrag(payload);
  };
  return (
    // a div, not a button: Firefox doesn't start a drag from a button
    <div role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} draggable={enabled}
      onDragStart={enabled ? start : undefined} onDragEnd={() => useCanvasUI.getState().setDrag(null)}
      onClick={onClick} onKeyDown={(e) => { if (onClick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(); } }}
      aria-pressed={onClick ? active : undefined} aria-label={label}
      className={clsx("hud relative flex min-h-11 w-full select-none items-center gap-2 rounded-xl border px-2 py-1.5 text-left outline-none transition-[border-color,background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent/60",
        enabled && "cursor-grab active:cursor-grabbing", onClick && !enabled && "cursor-pointer",
        active ? "border-ok/70 bg-ok/10 shadow-[0_0_16px_-8px_var(--color-ok)]" : "border-line bg-panel hover:border-accent/45")}>
      {children}
    </div>
  );
}

/**
 * The library on the left of the canvas: the cast, the places, the props and the music. Drag a face onto a shot (or onto a
 * scene's header for every shot in it), a place onto a scene, a prop onto a shot. Click a face to see their shots.
 */
export function Library({ episode, cast, places, props, music, onClose, pid }: {
  episode: Episode; cast: Character[]; places: Location[]; props: Prop[]; music: Record<string, SceneMusic>; onClose: () => void; pid: number;
}) {
  const t = useT();
  const a = useActions();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("cast");
  const highlight = useCanvasUI((s) => s.highlight);
  const shots = useMemo(() => (episode.shots ?? []).filter((s) => s.include), [episode]);
  const inShots = useMemo(() => {
    const m = new Map<number, number>();
    shots.forEach((s) => s.characters.forEach((c) => m.set(c, (m.get(c) ?? 0) + 1)));
    return m;
  }, [shots]);
  const groups = useMemo(() => outlineGroups(episode).filter((g) => g.scene && g.shots.length), [episode]);
  const missingMusic = groups.filter((g) => !music[String(g.scene!.id)]).length;
  const hint = {
    cast: a.canEdit ? t("Drag a face onto a shot, or onto a scene's title for all its shots. Click a face to see their shots.") : t("Click a face to see their shots."),
    places: t("Drag a place onto a scene."),
    props: t("Drag a prop onto a shot."),
    music: t("One piece of music per scene."),
  }[tab];

  return (
    <aside aria-label={t("Library")} className="flex h-full w-[232px] shrink-0 flex-col border-r border-line bg-panel/80 backdrop-blur">
      <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2.5">
        <span className="eyebrow !text-ink">{t("Library")}</span>
        <span className="flex-1" />
        <IconButton title={t("Hide the library")} onClick={onClose} className="size-7"><PanelLeftClose className="size-4" /></IconButton>
      </div>
      <div className="px-2">
        <Segmented size="sm" aria-label={t("Library")} value={tab} onChange={setTab} className="w-full [&>button]:flex-1" options={[
          { value: "cast", label: <Users className="mx-auto size-3.5" />, title: t("Cast") },
          { value: "places", label: <MapPin className="mx-auto size-3.5" />, title: t("Places") },
          { value: "props", label: <Box className="mx-auto size-3.5" />, title: t("Props") },
          { value: "music", label: <Music className="mx-auto size-3.5" />, title: t("Music") },
        ]} />
        <p className="eyebrow mt-2">{t({ cast: "Cast", places: "Places", props: "Props", music: "Music" }[tab])}</p>
        <p className="mt-0.5 text-2xs leading-snug text-dim">{hint}</p>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {tab === "cast" && cast.map((c) => {
          const n = inShots.get(c.id) ?? 0;
          return (
            <DragItem key={c.id} enabled={a.canEdit} label={c.name} payload={{ kind: "character", id: c.id, name: c.name }} active={highlight === c.id}
              onClick={() => useCanvasUI.getState().setHighlight(highlight === c.id ? null : c.id)}>
              <Avatar name={c.name} src={c.avatar_url} size={34} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{c.name}</span>
                <span className="mono block truncate text-2xs text-dim">{n === 1 ? t("in 1 shot") : t("in {n} shots", { n })}</span>
              </span>
              {!c.avatar_url && <Badge tone="warn">{t("no photo")}</Badge>}
            </DragItem>
          );
        })}
        {tab === "places" && places.map((l) => (
          <DragItem key={l.id} enabled={a.canEdit} label={l.name} payload={{ kind: "place", id: l.id, name: l.name }}>
            <span className="grid size-[34px] shrink-0 place-items-center overflow-hidden rounded-lg bg-raised">
              {l.thumb_url ? <img src={l.thumb_url} alt="" draggable={false} className="size-full object-cover" /> : <MapPin className="size-4 text-info" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">{l.name}</span>
          </DragItem>
        ))}
        {tab === "props" && props.map((p) => (
          <DragItem key={p.id} enabled={a.canEdit} label={p.name} payload={{ kind: "prop", id: p.id, name: p.name }}>
            <span className="grid size-[34px] shrink-0 place-items-center overflow-hidden rounded-lg bg-raised">
              {p.url ? <img src={p.url} alt="" draggable={false} className="size-full object-cover" /> : <Box className="size-4 text-mute" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">{p.name}</span>
          </DragItem>
        ))}
        {tab === "music" && (
          <>
            {groups.map((g) => {
              const m = music[String(g.scene!.id)];
              return (
                <div key={g.scene!.id} className="flex min-h-11 items-center gap-2 rounded-xl border border-line bg-panel px-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">{g.scene!.title}</span>
                    <span className="mono block text-2xs text-dim">{m ? fmtSecs(m.duration_s) : t("no music yet")}</span>
                  </span>
                  {m && <PlayChip url={m.url} label={t("Play")} />}
                </div>
              );
            })}
            {!groups.length && <Empty>{t("Scenes with shots get their music here.")}</Empty>}
            {a.canEdit && missingMusic > 0 && (
              <PriceButton eid={a.eid} block variant="outline" lazy body={{ action: "produce", steps: ["music"], music_per_scene: true }}
                label={missingMusic === 1 ? t("Music for 1 scene") : t("Music for {n} scenes", { n: missingMusic })} onRun={a.addMusic} icon={<Music className="size-3.5" />} />
            )}
          </>
        )}
        {tab === "cast" && !cast.length && <Empty>{t("No cast yet.")}</Empty>}
        {tab === "places" && !places.length && <Empty>{t("No places yet.")}</Empty>}
        {tab === "props" && !props.length && <Empty>{t("No props yet.")}</Empty>}
      </div>
      {tab !== "music" && (
        <div className="border-t border-line p-2">
          <button type="button" onClick={() => nav(`/p/${pid}/${tab === "props" ? "world" : "bible"}`)}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-line text-xs font-medium text-mute hover:bg-hover hover:text-ink">
            <UserPlus className="size-3.5" />{tab === "props" ? t("Add props") : t("Add characters & places")}
          </button>
        </div>
      )}
    </aside>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-4 text-center text-2xs text-dim">{children}</p>;
}
