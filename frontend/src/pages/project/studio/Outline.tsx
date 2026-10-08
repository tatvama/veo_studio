import { useDraggable, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { clsx } from "clsx";
import { ChevronDown, Clapperboard, Film, GripVertical, ImageIcon, Loader2, MapPin, Plus, UserPlus } from "lucide-react";
import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { LockMark } from "../../../components/shell/PresenceBar";
import { useLockHolder } from "../../../lib/collab";
import type { Character, Episode, Scene, Shot } from "../../../lib/types";
import { Avatar, Badge, Button } from "../../../components/ui";

/** Drag payloads shared by the Studio panels. */
export type DragData = { type: "shot"; shotId: number; sceneId: number | null } | { type: "character"; characterId: number }
  | { type: "scene"; sceneId: number | null };

const STATUS_DOT: Record<string, string> = {
  draft: "bg-dim/60", keyframe_ready: "bg-info", video_ready: "bg-accent", approved: "bg-ok",
};

/** Scenes and their shots, top to bottom. Drag shots to reorder or move them to another scene; drop a character on a shot. */
/** Scenes in order, shots grouped under them (shots without a scene last): the order the outline shows. */
export function outlineGroups(episode: Episode): { scene: Scene | null; shots: Shot[] }[] {
  const shots = (episode.shots ?? []).filter((s) => s.include);
  const scenes = episode.scenes ?? [];
  const groups: { scene: Scene | null; shots: Shot[] }[] = scenes.map((sc) => ({ scene: sc, shots: shots.filter((s) => s.scene_id === sc.id) }));
  const loose = shots.filter((s) => !scenes.some((sc) => sc.id === s.scene_id));
  if (loose.length || !groups.length) groups.push({ scene: null, shots: loose });
  return groups;
}

export const outlineOrder = (episode: Episode): number[] => outlineGroups(episode).flatMap((g) => g.shots.map((s) => s.id));

export function Outline({ episode, cast, selected, onSelect, onAddShot, canEdit }: {
  episode: Episode; cast: Character[]; selected: number | null; onSelect: (id: number) => void;
  onAddShot: (sceneId: number | null) => void; canEdit: boolean;
}) {
  const t = useT();
  const scenes = episode.scenes ?? [];
  const groups = outlineGroups(episode);
  const shots = groups.flatMap((g) => g.shots);
  const byId = new Map(cast.map((c) => [c.id, c]));
  let n = 0;
  return (
    <div className="h-full overflow-y-auto p-2">
      <SortableContext items={shots.map((s) => `shot-${s.id}`)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {groups.map(({ scene, shots: list }) => {
            const first = n;
            n += list.length;
            return (
              <SceneGroup key={scene?.id ?? "loose"} scene={scene} index={scene ? scenes.indexOf(scene) + 1 : 0} count={list.length}
                secs={list.reduce((a, s) => a + Math.max(s.extend_to || 0, s.duration_s), 0)}
                onAdd={canEdit ? () => onAddShot(scene?.id ?? null) : undefined}>
                {list.map((s, i) => (
                  <ShotItem key={s.id} shot={s} no={first + i + 1} selected={selected === s.id} onSelect={() => onSelect(s.id)}
                    people={(s.characters ?? []).map((id) => byId.get(id)).filter((c): c is Character => !!c)} canEdit={canEdit} />
                ))}
                {!list.length && <p className="px-2 py-2 text-2xs text-dim">{t("Drop shots here")}</p>}
              </SceneGroup>
            );
          })}
        </div>
      </SortableContext>
    </div>
  );
}

function SceneGroup({ scene, index, count, secs, onAdd, children }: {
  scene: Scene | null; index: number; count: number; secs: number; onAdd?: () => void; children: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const { setNodeRef, isOver } = useDroppable({ id: `scene-${scene?.id ?? "none"}`, data: { type: "scene", sceneId: scene?.id ?? null } satisfies DragData });
  return (
    <section ref={setNodeRef} className={clsx("rounded-xl border transition-colors", isOver ? "border-accent/60 bg-accent/5" : "border-line bg-panel")}>
      <header className="flex items-center gap-1.5 px-2 py-1.5">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronDown className={clsx("size-3.5 shrink-0 text-dim transition-transform", !open && "-rotate-90")} />
          <span className="rounded bg-accent/12 px-1 font-mono text-2xs font-semibold text-accent-ink">{scene ? `SC${String(index).padStart(2, "0")}` : "—"}</span>
          <span className="min-w-0 truncate text-xs font-semibold">{scene?.title || t("Unsorted shots")}</span>
        </button>
        <span className="shrink-0 text-2xs tabular-nums text-dim">{count} · {secs}s</span>
        {onAdd && (
          <button type="button" onClick={onAdd} title={t("Add a shot to this scene")} aria-label={t("Add a shot to this scene")}
            className="grid size-6 shrink-0 place-items-center rounded-md text-dim hover:bg-hover hover:text-ink"><Plus className="size-3.5" /></button>
        )}
      </header>
      {open && <div className="space-y-1 px-1.5 pb-1.5">{children}</div>}
    </section>
  );
}

function ShotItem({ shot, no, selected, onSelect, people, canEdit }: {
  shot: Shot; no: number; selected: boolean; onSelect: () => void; people: Character[]; canEdit: boolean;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, active } = useSortable({
    id: `shot-${shot.id}`, data: { type: "shot", shotId: shot.id, sceneId: shot.scene_id } satisfies DragData, disabled: !canEdit,
  });
  const charOver = isOver && (active?.data.current as DragData | undefined)?.type === "character";
  const lock = useLockHolder(`shot:${shot.id}`);
  const thumb = shot.video?.thumb_url || shot.keyframe?.thumb_url || "";
  const len = Math.max(shot.extend_to || 0, shot.duration_s);
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}
      className={clsx("group flex items-center gap-1.5 rounded-lg border p-1 transition-colors", isDragging && "z-10 opacity-60 shadow-lift",
        charOver ? "border-ok/70 bg-ok/10" : selected ? "border-accent/60 bg-accent/10" : "border-transparent hover:bg-hover/60")}>
      {canEdit && (
        <span {...attributes} {...listeners} aria-label={t("Drag to move")} className="cursor-grab touch-none text-dim opacity-40 group-hover:opacity-100">
          <GripVertical className="size-3.5" />
        </span>
      )}
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className="relative grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-raised">
          {thumb ? <img src={thumb} alt="" className="size-full object-cover" /> : <ImageIcon className="size-3.5 text-dim" />}
          {shot.video && <Film className="absolute bottom-0.5 right-0.5 size-3 text-white drop-shadow" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={clsx("size-1.5 shrink-0 rounded-full", STATUS_DOT[shot.status] ?? "bg-dim/60")} title={shot.status.replace("_", " ")} />
            <span className="font-mono text-2xs font-semibold text-mute">{shot.code || `#${no}`}</span>
            <span className="text-2xs tabular-nums text-dim">{len}s</span>
            {shot.generating && <Loader2 className="size-3 animate-spin text-accent-ink" aria-label={t("generating")} />}
            {lock && <LockMark name={lock.name} />}
          </span>
          <span className="block truncate text-xs">{shot.action || <span className="text-dim">{t("No prompt yet")}</span>}</span>
        </span>
        {people.length > 0 && (
          <span className="flex shrink-0 -space-x-1.5">
            {people.slice(0, 3).map((c) => <Avatar key={c.id} name={c.name} src={c.avatar_url} size={18} className="ring-2 ring-panel" />)}
          </span>
        )}
      </button>
    </div>
  );
}

/** The cast, ready to drag onto a shot. */
export function CastPanel({ cast, onOpenCharacters, canEdit }: { cast: Character[]; onOpenCharacters: () => void; canEdit: boolean }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col">
      <p className="px-3 pt-2 text-2xs text-dim">{canEdit ? t("Drag a character onto a shot to put them in it.") : t("This project's cast.")}</p>
      <div className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2 overflow-y-auto p-2">
        {cast.map((c) => <CastChip key={c.id} c={c} canEdit={canEdit} />)}
        {!cast.length && <p className="col-span-full py-4 text-center text-xs text-dim">{t("No characters in this project yet.")}</p>}
      </div>
      <div className="border-t border-line p-2">
        <Button size="sm" variant="outline" className="w-full" icon={<UserPlus className="size-3.5" />} onClick={onOpenCharacters}>{t("Characters & photos")}</Button>
      </div>
    </div>
  );
}

function CastChip({ c, canEdit }: { c: Character; canEdit: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `char-${c.id}`, data: { type: "character", characterId: c.id } satisfies DragData, disabled: !canEdit,
  });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners}
      className={clsx("flex touch-none flex-col items-center gap-1 rounded-xl border border-line bg-panel p-2 text-center transition-shadow",
        canEdit && "cursor-grab hover:border-accent/50 hover:shadow-card", isDragging && "opacity-50")}>
      <Avatar name={c.name} src={c.avatar_url} size={44} />
      <span className="w-full truncate text-2xs font-medium">{c.name}</span>
      {!c.avatar_url && <Badge tone="warn">no photo</Badge>}
    </div>
  );
}

export function EmptyStudio({ onStart }: { onStart: () => void }) {
  const t = useT();
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-sm space-y-3">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent/12 text-accent-ink"><Clapperboard className="size-6" /></span>
        <p className="text-sm font-semibold">{t("No shots yet")}</p>
        <p className="text-xs text-mute">{t("Write your shots in the Shot list (or import a script), then come back here to make and cut them.")}</p>
        <Button variant="primary" size="sm" icon={<MapPin className="size-3.5" />} onClick={onStart}>{t("Open the Shot list")}</Button>
      </div>
    </div>
  );
}
