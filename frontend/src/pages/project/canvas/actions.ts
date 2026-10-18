import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useGenerate } from "../../../components/Generate";
import { api } from "../../../lib/api";
import { tr } from "../../../lib/i18n";
import type { Character, Episode, Location, Shot } from "../../../lib/types";
import { nextShot as postNextShot, type Prop, type ShotV3Fields } from "../../../lib/v3";
import { outlineGroups } from "../studio/Outline";
import { boardBody, freshBoard, scenesInOrder } from "./data";
import {
  createUndoStack, LINK_LABEL, makeBody, orderAfterMove, STEP_LABEL, stepBody, whereIs, type GroupIds, type LinkMode, type StepId,
  type UndoEntry, type UndoStack,
} from "./model";

type ShotX = Shot & ShotV3Fields;

/** The node id of a scene row ("scene-12"; shots without a scene are "scene-none"). */
export const sceneKey = (id: number | null | undefined) => `scene-${id ?? "none"}`;
export const sceneIdOf = (key: string): number | null => (key === "scene-none" ? null : Number(key.slice(6)));

/** What the board hands the actions: selecting and focusing nodes, and opening the full shot. */
export interface CanvasUiHooks {
  /** Select this node as soon as it exists (a shot or scene just added). */
  selectWhenReady: (nodeId: string) => void;
  openShot: (shotId: number) => void;
}

/** Everything the nodes, the library, the inspector and the bars can do. Stable for the life of the canvas. */
export interface CanvasActions {
  canEdit: boolean;
  eid: number;
  pid: number;
  undoStack: UndoStack;
  refresh: () => void;
  /** One step of one shot, after its price (Generate's cost dialog). */
  runStep: (shotId: number, step: StepId) => Promise<void>;
  /** Everything still missing for these shots (cast looks, pictures, videos, extensions, voices, sound), after the price. */
  make: (shotIds: number[], title: string) => Promise<void>;
  /** Any paid batch (POST /generate body), after the price. */
  run: (body: Record<string, unknown>, title: string) => Promise<void>;
  /** The videos of these shots, made (again), after the price. */
  makeVideos: (shotIds: number[], title: string) => Promise<void>;
  render: () => Promise<void>;
  addMusic: () => Promise<void>;
  addCharacter: (shotIds: number[], characterId: number) => Promise<void>;
  removeCharacter: (shotId: number, characterId: number) => Promise<void>;
  addProp: (shotId: number, propId: number) => Promise<void>;
  setScenePlace: (sceneId: number, locationId: number | null) => Promise<void>;
  link: (targetId: number, sourceId: number | null, mode?: LinkMode) => Promise<void>;
  setLinkMode: (targetId: number, mode: LinkMode) => Promise<void>;
  moveShot: (shotId: number, toKey: string, slot: number) => Promise<void>;
  reorderScenes: (keys: string[]) => Promise<void>;
  addShot: (sceneId: number | null) => Promise<void>;
  addScene: () => Promise<void>;
  nextShot: (shotId: number) => Promise<void>;
  deleteShots: (ids: number[]) => Promise<void>;
  approve: (shotId: number, on: boolean) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  openShot: (shotId: number) => void;
}

export const CanvasActionsCtx = createContext<CanvasActions | null>(null);
export const useActions = () => useContext(CanvasActionsCtx)!;

/** The project's places (scene rows pick from them); changes rarely, so the rows can read it from context. */
export const PlacesCtx = createContext<Location[]>([]);
export const usePlaces = () => useContext(PlacesCtx);

function staleNote(ids?: number[]) {
  if (!ids?.length) return;
  toast.message(ids.length === 1 ? tr("1 earlier take is now out of date") : tr("{n} earlier takes are now out of date", { n: ids.length }));
}

/** The episode's shots put in `order` (the rest after them), with `moved` in scene `sceneId`: the canvas moves at once. */
function reorderEpisode(e: Episode, order: number[], moved: number, sceneId: number | null): Episode {
  const rank = new Map(order.map((id, i) => [id, i]));
  const shots = [...(e.shots ?? [])].map((s) => (s.id === moved ? { ...s, scene_id: sceneId } : s))
    .sort((a, b) => (rank.get(a.id) ?? 1e6 + a.order) - (rank.get(b.id) ?? 1e6 + b.order));
  return { ...e, shots };
}

/**
 * The canvas's actions. They read the latest film through refs, so the object never changes while the canvas is open
 * (the nodes that use it don't re-render when the film does). Every canvas edit pushes an undo entry that re-applies
 * what was there before.
 */
export function useCanvasActionsImpl(opts: {
  eid: number; pid: number; lang: string; canEdit: boolean; episode?: Episode; cast: Character[]; locations: Location[];
  props: Prop[]; ui: CanvasUiHooks;
}): CanvasActions {
  const qc = useQueryClient();
  const { generate } = useGenerate();
  const live = useRef(opts);
  live.current = opts;
  const genRef = useRef(generate);
  genRef.current = generate;
  const { eid, pid, lang, canEdit } = opts;

  return useMemo(() => {
    const undoStack = createUndoStack(60);
    const ep = () => live.current.episode;
    const shotOf = (id: number) => (ep()?.shots ?? []).find((s) => s.id === id) as ShotX | undefined;
    const codeOf = (id: number) => shotOf(id)?.code ?? `#${id}`;
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ["episode"] });
      qc.invalidateQueries({ queryKey: ["board"] });
      qc.invalidateQueries({ queryKey: ["shot"] });
    };
    const setEp = (fn: (e: Episode) => Episode) => qc.setQueryData<Episode>(["episode", eid, lang], (e) => (e ? fn(e) : e));
    const patch = (id: number, body: Record<string, unknown>) => api.patch<Shot & { stale_takes?: number[] }>(`/api/shots/${id}`, body);
    const record = (e: UndoEntry) => undoStack.push(e);
    let busy = false;
    const latch = async (fn: () => Promise<void>) => {
      if (busy) return;
      busy = true;
      try { await fn(); } catch { /* the api layer showed the error */ } finally { busy = false; }
    };
    const gen = async (body: Record<string, unknown>, title: string) => {
      try { await genRef.current(eid, body, title); } catch { /* the api layer showed the error */ }
    };

    // ── shots: cast, props, links ──
    const setChars = async (changes: { id: number; to: number[] }[]) => {
      await Promise.all(changes.map((c) => patch(c.id, { characters: c.to }).then((r) => staleNote(r.stale_takes))));
      refresh();
    };
    const addCharacter = async (shotIds: number[], cid: number) => {
      const who = live.current.cast.find((c) => c.id === cid)?.name ?? tr("Them");
      const todo = shotIds.map((id) => shotOf(id)).filter((s): s is ShotX => !!s && !s.characters.includes(cid));
      if (!todo.length) { toast.info(tr("{name} is already in {what}", { name: who, what: shotIds.length === 1 ? codeOf(shotIds[0]) : tr("every shot") })); return; }
      const before = todo.map((s) => ({ id: s.id, to: [...s.characters] }));
      const after = todo.map((s) => ({ id: s.id, to: [...s.characters, cid] }));
      try { await setChars(after); } catch { refresh(); return; }
      const what = todo.length === 1 ? todo[0].code : tr("{n} shots", { n: todo.length });
      toast.success(tr("{name} added to {what}", { name: who, what }));
      record({ label: tr("Add {name} to {what}", { name: who, what }), undo: () => setChars(before), redo: () => setChars(after) });
    };
    const removeCharacter = async (shotId: number, cid: number) => {
      const s = shotOf(shotId);
      if (!s || !s.characters.includes(cid)) return;
      const before = [{ id: s.id, to: [...s.characters] }];
      const after = [{ id: s.id, to: s.characters.filter((c) => c !== cid) }];
      try { await setChars(after); } catch { refresh(); return; }
      const who = live.current.cast.find((c) => c.id === cid)?.name ?? "";
      record({ label: tr("Take {name} out of {code}", { name: who, code: s.code }), undo: () => setChars(before), redo: () => setChars(after) });
    };
    const addProp = async (shotId: number, propId: number) => {
      const s = shotOf(shotId);
      if (!s) return;
      const had = [...(s.prop_ids ?? [])];
      const name = live.current.props.find((p) => p.id === propId)?.name ?? tr("The prop");
      if (had.includes(propId)) { toast.info(tr("{name} is already in {code}", { name, code: s.code })); return; }
      const set = async (to: number[]) => { await patch(shotId, { prop_ids: to }).then((r) => staleNote(r.stale_takes)); refresh(); };
      try { await set([...had, propId]); } catch { refresh(); return; }
      toast.success(tr("{name} added to {code}", { name, code: s.code }));
      record({ label: tr("Add {name} to {code}", { name, code: s.code }), undo: () => set(had), redo: () => set([...had, propId]) });
    };
    const putLink = async (target: number, from: number | null, mode: LinkMode) => {
      const r = await patch(target, from ? { continuity_from_shot_id: from, continuity_mode: mode } : { continuity_from_shot_id: null });
      staleNote(r.stale_takes);
      refresh();
    };
    const link = async (target: number, source: number | null, mode: LinkMode = "last_frame") => {
      const s = shotOf(target);
      if (!s || source === target) return;
      const prev = { from: s.continuity_from_shot_id ?? null, mode: (s.continuity_mode ?? "last_frame") as LinkMode };
      if (prev.from === source && (source === null || prev.mode === mode)) return;
      try { await putLink(target, source, mode); } catch { refresh(); return; }
      const label = source ? tr("{target} · {how} from {source}", { target: s.code, how: tr(LINK_LABEL[mode]), source: codeOf(source) })
        : tr("{code} no longer continues from another shot", { code: s.code });
      toast.success(label);
      record({ label: source ? tr("Link {target} to {source}", { target: s.code, source: codeOf(source) }) : tr("Remove the link of {code}", { code: s.code }),
        undo: () => putLink(target, prev.from, prev.mode), redo: () => putLink(target, source, mode) });
    };
    const setLinkMode = async (target: number, mode: LinkMode) => {
      const s = shotOf(target);
      const from = s?.continuity_from_shot_id;
      if (!s || !from) return;
      const prev = (s.continuity_mode ?? "last_frame") as LinkMode;
      if (prev === mode) return;
      const set = async (m: LinkMode) => {
        const r = await patch(target, { continuity_mode: m });
        staleNote(r.stale_takes);
        refresh();
      };
      try { await set(mode); } catch { refresh(); return; }
      toast.success(tr("{target} · {how} from {source}", { target: s.code, how: tr(LINK_LABEL[mode]), source: codeOf(from) }));
      record({ label: tr("Change the link of {code}", { code: s.code }), undo: () => set(prev), redo: () => set(mode) });
    };

    // ── places ──
    const setScenePlace = async (sceneId: number, locId: number | null) => {
      const e = ep();
      const scene = e?.scenes?.find((x) => x.id === sceneId);
      if (!e || !scene) return;
      const prevScene = scene.location_id ?? null;
      if (prevScene === locId) return;
      // the shots that follow the scene's place (not those set to a place of their own)
      const shots = (e.shots ?? []).filter((x) => x.include && x.scene_id === sceneId && (!x.location_id || x.location_id === prevScene));
      const prevShots = shots.map((x) => ({ id: x.id, loc: x.location_id ?? null }));
      const apply = async (sceneLoc: number | null, shotLocs: { id: number; loc: number | null }[]) => {
        await api.patch(`/api/scenes/${sceneId}`, { location_id: sceneLoc });
        await Promise.all(shotLocs.map((x) => patch(x.id, { location_id: x.loc })));
        refresh();
      };
      const next = shots.map((x) => ({ id: x.id, loc: locId }));
      try { await apply(locId, next); } catch { refresh(); return; }
      const place = live.current.locations.find((l) => l.id === locId)?.name;
      toast.success(place ? tr("{scene} now takes place at {place}", { scene: scene.title, place }) : tr("{scene} has no place now", { scene: scene.title }));
      record({ label: tr("Set the place of {scene}", { scene: scene.title }), undo: () => apply(prevScene, prevShots), redo: () => apply(locId, next) });
    };

    // ── order ──
    const groupsNow = (): GroupIds[] => {
      const e = ep();
      return e ? outlineGroups(e).map((g) => ({ key: sceneKey(g.scene?.id), ids: g.shots.map((s) => s.id) })) : [];
    };
    const applyOrder = async (shotId: number, order: number[], sceneId: number | null) => {
      if ((shotOf(shotId)?.scene_id ?? null) !== sceneId) await patch(shotId, { scene_id: sceneId });
      await api.post(`/api/episodes/${eid}/shots/reorder`, { shot_ids: order });
      refresh();
    };
    const moveShot = async (shotId: number, toKey: string, slot: number) => {
      const groups = groupsNow();
      const from = whereIs(groups, shotId);
      if (!from) return;
      const before = groups.flatMap((g) => g.ids);
      const after = orderAfterMove(groups, shotId, toKey, slot);
      const fromScene = sceneIdOf(from.key);
      const toScene = sceneIdOf(toKey);
      if (from.key === toKey && before.join() === after.join()) return;
      setEp((e) => reorderEpisode(e, after, shotId, toScene));
      try { await applyOrder(shotId, after, toScene); } catch { refresh(); return; }
      const code = codeOf(shotId);
      record({ label: tr("Move {code}", { code }),
        undo: async () => { setEp((e) => reorderEpisode(e, before, shotId, fromScene)); await applyOrder(shotId, before, fromScene); },
        redo: async () => { setEp((e) => reorderEpisode(e, after, shotId, toScene)); await applyOrder(shotId, after, toScene); } });
    };
    const applySceneOrder = async (keys: string[]) => {
      setEp((e) => {
        const rank = new Map(keys.map((k, i) => [k, i]));
        return { ...e, scenes: [...(e.scenes ?? [])].sort((a, b) => (rank.get(sceneKey(a.id)) ?? 1e6) - (rank.get(sceneKey(b.id)) ?? 1e6)) };
      });
      const b = await freshBoard(eid);
      await api.put(`/api/episodes/${eid}/board`, boardBody(scenesInOrder(b.scenes, keys), b.version));
      refresh();
    };
    const reorderScenes = async (keys: string[]) => {
      const before = (ep()?.scenes ?? []).map((s) => sceneKey(s.id));
      if (before.join() === keys.filter((k) => k !== "scene-none").join()) return;
      try { await applySceneOrder(keys); } catch { refresh(); return; }
      toast.success(tr("Scenes reordered"));
      record({ label: tr("Reorder the scenes"), undo: () => applySceneOrder(before), redo: () => applySceneOrder(keys) });
    };

    // ── adding and removing ──
    const addShot = async (sceneId: number | null) => {
      const e = ep();
      if (!e) return;
      const inScene = (e.shots ?? []).filter((s) => s.include && (s.scene_id ?? null) === sceneId);
      try {
        const s = await api.post<Shot>(`/api/episodes/${eid}/shots`, { scene_id: sceneId, after_shot_id: inScene.at(-1)?.id ?? null, duration_s: 8 });
        refresh();
        live.current.ui.selectWhenReady(`shot-${s.id}`);
        toast.success(tr("Shot added: describe it on the right"));
      } catch { /* api toasts */ }
    };
    const addScene = async () => {
      try {
        const b = await freshBoard(eid);
        const title = tr("Scene {n}", { n: b.scenes.filter((s) => s.id != null).length + 1 });
        const scenes = [...b.scenes, { title, location: "", time_of_day: "", summary: "", shots: [] }];
        const saved = await api.put<{ scenes: { id: number | null; title: string }[] }>(`/api/episodes/${eid}/board`, boardBody(scenes, b.version));
        refresh();
        const made = [...saved.scenes].reverse().find((s) => s.title === title && s.id != null);
        if (made) live.current.ui.selectWhenReady(sceneKey(made.id));
        toast.success(tr("{title} added: give it a place and its shots", { title }));
      } catch { /* api toasts */ }
    };
    const nextShot = async (shotId: number) => {
      try {
        const r = await postNextShot(shotId, { mode: "last_frame" });
        refresh();
        if (r.shot?.id) live.current.ui.selectWhenReady(`shot-${r.shot.id}`);
        toast.success(tr("{code} added after {src}: same cast and place, continuing from it", { code: r.shot?.code ?? "", src: codeOf(shotId) }));
      } catch { /* api toasts */ }
    };
    const deleteShots = async (ids: number[]) => {
      let n = 0;
      for (const id of ids) {
        try { await api.del(`/api/shots/${id}`); n++; } catch { /* api toasts */ }
      }
      refresh();
      if (n) toast.success(n === 1 ? tr("Shot removed from the film") : tr("{n} shots removed from the film", { n }));
    };
    const approve = async (shotId: number, on: boolean) => {
      try {
        await api.post(`/api/shots/${shotId}/approve`, { approved: on });
        refresh();
      } catch { /* api toasts */ }
    };

    return {
      canEdit, eid, pid, undoStack, refresh,
      runStep: (shotId, step) => gen(stepBody(step, shotId), tr("{step} · {code}", { step: tr(STEP_LABEL[step]), code: codeOf(shotId) })),
      run: gen,
      make: (ids, title) => gen(makeBody(ids), title),
      makeVideos: (ids, title) => gen({ action: "videos", shot_ids: ids }, title),
      render: () => gen({ action: "export" }, tr("Render the film")),
      addMusic: () => gen({ action: "produce", steps: ["music"], music_per_scene: true }, tr("Music for the scenes without")),
      addCharacter: (ids, cid) => latch(() => addCharacter(ids, cid)),
      removeCharacter: (id, cid) => latch(() => removeCharacter(id, cid)),
      addProp: (id, propId) => latch(() => addProp(id, propId)),
      setScenePlace: (id, loc) => latch(() => setScenePlace(id, loc)),
      link: (t, s, m) => latch(() => link(t, s, m)),
      setLinkMode: (t, m) => latch(() => setLinkMode(t, m)),
      moveShot: (id, k, slot) => latch(() => moveShot(id, k, slot)),
      reorderScenes: (keys) => latch(() => reorderScenes(keys)),
      addShot: (sceneId) => latch(() => addShot(sceneId)),
      addScene: () => latch(addScene),
      nextShot: (id) => latch(() => nextShot(id)),
      deleteShots: (ids) => latch(() => deleteShots(ids)),
      approve: (id, on) => latch(() => approve(id, on)),
      undo: () => latch(async () => {
        const e = undoStack.takeUndo();
        if (!e) { toast.info(tr("Nothing to undo")); return; }
        try { await e.undo(); toast.message(tr("Undone: {what}", { what: e.label })); } catch { refresh(); }
      }),
      redo: () => latch(async () => {
        const e = undoStack.takeRedo();
        if (!e?.redo) { toast.info(tr("Nothing to redo")); return; }
        try { await e.redo(); toast.message(tr("Redone: {what}", { what: e.label })); } catch { refresh(); }
      }),
      openShot: (id) => live.current.ui.openShot(id),
    } satisfies CanvasActions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eid, pid, lang, canEdit, qc]);
}
