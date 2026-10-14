/**
 * Auto SFX, applied (docs/EDITOR.md §15.2): each distinct sound of a plan is rendered and added to the edit once
 * (editor/sfx addSfxMedia; cached for the session and deduped by preset, values and seed), then the sounds go on the
 * SFX track in ONE undo command. While rendering, the host the SFX engine sees only stages what it adds (media, bins,
 * edits), so the media and the clips land together in that one command.
 */
import { addSfxMedia as realAddSfxMedia } from "../sfx/index.ts";
import { activeSequence, ctxOf, normalize } from "../model/ops.ts";
import type { Bin, EditorHost, EditProject, MediaItem } from "../model/types.ts";
import { buildAutoSfx, removeAutoSfx, sfxKey } from "./build.ts";
import { planAutoSfx } from "./planner.ts";
import type { AutoSfxOptions, AutoSfxPlan, FrameRange, SfxPlacement } from "./types.ts";

export type AddSfxMedia = (host: EditorHost, id: string, values?: Record<string, number>, seed?: number) => Promise<MediaItem>;

export interface ApplyOptions {
  /** Only these placement ids (the dialog's checkboxes). */
  only?: Iterable<string>;
  /** The History label (default "Auto SFX"; the assistant's is "Assistant: auto_sfx"). */
  label?: string;
  onProgress?(done: number, total: number): void;
  /** The sounds that went into the edit with the command (the editor resolves their preview URLs). */
  onMedia?(items: MediaItem[]): void;
  /** For tests: the SFX engine's addSfxMedia. */
  addSfxMedia?: AddSfxMedia;
}

export interface ApplyResult { placed: number; removed: number; rendered: number; failed: string[]; skipped: { id: string; reason: string }[] }

/** Rendered sounds this session: "<edit>|<preset|values|seed>" → its MediaItem. */
const cache = new Map<string, MediaItem>();
export const clearSfxCache = () => cache.clear();

interface Staged { bins: Bin[]; media: MediaItem[]; edits: ((draft: EditProject) => void)[] }

/** Applies what was staged onto a draft (media and bins it doesn't have yet, then the staged edits). */
function replay(draft: EditProject, st: Staged) {
  for (const e of st.edits) e(draft);
  const binIds = new Set(draft.bins.map((b) => b.id));
  for (const b of st.bins) if (!binIds.has(b.id)) draft.bins.push(b);
  const have = new Set(draft.media.map((m) => m.id)), paths = new Set(draft.media.map((m) => m.path.toLowerCase()));
  for (const m of st.media) if (!have.has(m.id) && !paths.has(m.path.toLowerCase())) { draft.media.push(m); have.add(m.id); paths.add(m.path.toLowerCase()); }
}

/** A host for the SFX engine that records what it adds instead of making undo steps of its own. */
function stagingHost(host: EditorHost, st: Staged): EditorHost {
  let memo: { base: EditProject; n: number; p: EditProject } | null = null;
  const view = (): EditProject => {
    const base = host.project();
    const n = st.bins.length + st.media.length + st.edits.length;
    if (memo && memo.base === base && memo.n === n) return memo.p;
    let p = base;
    if (n) { p = structuredClone(base); replay(p, st); }
    memo = { base, n, p };
    return p;
  };
  return {
    ...host,
    project: view,
    sequence: () => activeSequence(view()),
    apply(_label, mutate) { st.edits.push(mutate); },
    addMedia(items, binName) {
      let binId: string | null = null;
      if (binName) {
        const p = view();
        const b = p.bins.find((x) => x.name === binName && !x.parentId);
        binId = b?.id ?? `b_sfx_${Math.random().toString(36).slice(2, 10)}`;
        if (!b) st.bins.push({ id: binId, name: binName, parentId: null });
      }
      st.media.push(...items.map((m) => ({ ...m, binId: m.binId ?? binId })));
    },
    placeClip() { throw new Error("Auto SFX places its own clips"); },
    addTitleTrack() { throw new Error("Auto SFX adds no titles"); },
  };
}

/** Renders (or reuses) every distinct sound of the placements; the staged media and edits land with the clips. */
async function renderSounds(host: EditorHost, list: SfxPlacement[], st: Staged, o: ApplyOptions): Promise<{ byKey: Map<string, MediaItem>; rendered: number; failed: string[] }> {
  const add = o.addSfxMedia ?? (realAddSfxMedia as AddSfxMedia);
  const sh = stagingHost(host, st);
  const keys = [...new Set(list.map(sfxKey))];
  const byKey = new Map<string, MediaItem>();
  const failed: string[] = [];
  let rendered = 0, done = 0;
  const edit = host.path() || host.project().id;
  for (const key of keys) {
    const p = list.find((x) => sfxKey(x) === key)!;
    const ck = `${edit}|${key}`;
    const hit = cache.get(ck);
    const inEdit = hit && sh.project().media.find((m) => m.id === hit.id || m.path.toLowerCase() === hit.path.toLowerCase());
    if (inEdit) byKey.set(key, inEdit);
    else {
      // new, or made earlier but no longer in the edit (an undo): the engine adds it again (and reuses its file)
      try {
        const m = await add(sh, p.presetId, p.values, p.seed);
        cache.set(ck, m);
        byKey.set(key, m);
        if (!sh.project().media.some((x) => x.id === m.id)) st.media.push(m);
        if (!hit) rendered++;
      } catch (e) {
        failed.push(`${p.label}: ${(e as Error)?.message ?? e}`);
      }
    }
    o.onProgress?.(++done, keys.length);
  }
  return { byKey, rendered, failed };
}

/** Places a plan's sounds as ONE undo command (earlier auto SFX in its range are replaced). */
export async function applyAutoSfx(host: EditorHost, plan: AutoSfxPlan, o: ApplyOptions = {}): Promise<ApplyResult> {
  const want = o.only ? new Set(o.only) : null;
  const list = plan.placements.filter((p) => !want || want.has(p.id));
  const st: Staged = { bins: [], media: [], edits: [] };
  const { byKey, rendered, failed } = await renderSounds(host, list, st, o);
  let out: ApplyResult = { placed: 0, removed: 0, rendered, failed, skipped: [] };
  const hasAuto = host.project().sequences.find((s) => s.id === plan.sequenceId)?.clips.some((c) => c.autoSfx);
  if (!list.length && !hasAuto) return out;
  host.apply(o.label ?? "Auto SFX", (draft) => {
    replay(draft, st);
    const r = buildAutoSfx(draft, plan, (p) => byKey.get(sfxKey(p)), want ?? undefined);
    Object.assign(draft, r.project);
    out = { ...out, placed: r.placed, removed: r.removed, skipped: r.skipped };
  });
  if (st.media.length) o.onMedia?.(st.media);
  return out;
}

/** Removes the auto SFX clips (in a range, else all) of the active sequence as one undo command. */
export function removeAutoSfxCommand(host: EditorHost, range?: FrameRange, label = "Remove auto sound effects"): number {
  const sid = host.sequence().id;
  const n = removeAutoSfx(host.project(), sid, range).removed;
  if (!n) return 0;
  host.apply(label, (draft) => {
    const r = removeAutoSfx(draft, sid, range);
    Object.assign(draft, r.project);
  });
  return n;
}

/** Plans and applies in one go on the host's active sequence (menus, the auto edit option). */
export async function runAutoSfx(host: EditorHost, opts: AutoSfxOptions = {}, o: ApplyOptions = {}): Promise<{ plan: AutoSfxPlan; result: ApplyResult }> {
  const plan = planAutoSfx(host.sequence(), host.project(), opts);
  return { plan, result: await applyAutoSfx(host, plan, o) };
}

/**
 * An EditorHost over a plain project (no store, no undo): for building a new edit that isn't open yet (auto edit's
 * "Add sound effects" before the edit opens) and for tests. `current()` is the project with everything applied.
 */
export function projectHost(p0: EditProject, path: string, o: { sequenceId?: string } = {}): EditorHost & { current(): EditProject } {
  let p = o.sequenceId ? { ...p0, activeSequenceId: o.sequenceId } : p0;
  return {
    current: () => p,
    project: () => p,
    sequence: () => activeSequence(p),
    selection: () => ({ clipIds: [], trackIds: [] }),
    playhead: () => 0,
    inOut: () => { const s = activeSequence(p); return { in: s.inPoint, out: s.outPoint }; },
    apply(_label, mutate) {
      const d = structuredClone(p);
      mutate(d);
      const c = ctxOf(d);
      p = { ...d, sequences: d.sequences.map((s) => normalize(s, c)) };
    },
    addMedia(items) { const have = new Set(p.media.map((m) => m.path.toLowerCase())); p = { ...p, media: [...p.media, ...items.filter((m) => !have.has(m.path.toLowerCase()))] }; },
    placeClip() { throw new Error("Not available here"); },
    addTitleTrack() { throw new Error("Not available here"); },
    path: () => path,
    studioProjectId: () => p.studioProjectId ?? null,
    setStudioProjectId(id) { p = { ...p, studioProjectId: id }; },
    toast() { /* nothing to show */ },
  };
}
