/**
 * Saved workspaces (editor-motion): named dockview layouts — Editing, Colour, Audio, Effects, Graphics, plus your own
 * ("Save as new workspace"). Like Premiere, a workspace remembers how you changed it until you reset it. Window →
 * Workspaces switches; saved in this browser.
 */
import type { DockviewApi } from "dockview-react";

export interface PanelInfo { id: string; title: string }
type Builder = (api: DockviewApi, add: (id: string, pos?: Parameters<DockviewApi["addPanel"]>[0]["position"], inactive?: boolean) => boolean) => void;

const KEY = "tatvam-editor:workspaces:v1";
interface Saved { current: string; layouts: Record<string, unknown>; custom: { id: string; name: string }[] }
const load = (): Saved => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null;
    if (v && typeof v.current === "string" && v.layouts && Array.isArray(v.custom)) return v;
  } catch { /* fall through */ }
  return { current: "editing", layouts: {}, custom: [] };
};
const store = (v: Saved) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* blocked */ } };

/** The built-in workspaces. "Editing" is built by the editor itself (its default layout). */
export const BUILT_IN: { id: string; name: string; build?: Builder }[] = [
  { id: "editing", name: "Editing" },
  { id: "colour", name: "Colour", build: (api, add) => {
    add("program");
    add("controls", { referencePanel: "program", direction: "left" });
    for (const id of ["luts", "moods", "graph"]) add(id, { referencePanel: "controls", direction: "within" }, true);
    add("scopes", { referencePanel: "program", direction: "right" });
    add("timeline", { direction: "below" });
    add("effects", { referencePanel: "timeline", direction: "left" });
    for (const id of ["project", "history"]) add(id, { referencePanel: "effects", direction: "within" }, true);
    requestAnimationFrame(() => {
      const W = window.innerWidth, H = window.innerHeight;
      api.getPanel("controls")?.group.api.setSize({ width: Math.round(W * 0.26) });
      api.getPanel("program")?.group.api.setSize({ height: Math.round(H * 0.56) });
      api.getPanel("effects")?.group.api.setSize({ width: Math.round(W * 0.26) });
      api.getPanel("controls")?.api.setActive(); api.getPanel("effects")?.api.setActive();
    });
  } },
  { id: "audio", name: "Audio", build: (api, add) => {
    add("mixer");
    add("program", { referencePanel: "mixer", direction: "right" });
    add("source", { referencePanel: "mixer", direction: "within" }, true);
    add("timeline", { direction: "below" });
    add("project", { referencePanel: "timeline", direction: "left" });
    for (const id of ["effects", "controls", "markers", "transcript"]) add(id, { referencePanel: "project", direction: "within" }, true);
    requestAnimationFrame(() => {
      const W = window.innerWidth, H = window.innerHeight;
      api.getPanel("mixer")?.group.api.setSize({ width: Math.round(W * 0.55), height: Math.round(H * 0.48) });
      api.getPanel("project")?.group.api.setSize({ width: Math.round(W * 0.25) });
      api.getPanel("mixer")?.api.setActive(); api.getPanel("project")?.api.setActive();
    });
  } },
  { id: "effects", name: "Effects", build: (api, add) => {
    add("effects");
    add("controls", { referencePanel: "effects", direction: "right" });
    add("graph", { referencePanel: "controls", direction: "within" }, true);
    add("program", { referencePanel: "controls", direction: "right" });
    add("timeline", { direction: "below" });
    add("project", { referencePanel: "timeline", direction: "left" });
    for (const id of ["history", "info"]) add(id, { referencePanel: "project", direction: "within" }, true);
    requestAnimationFrame(() => {
      const W = window.innerWidth, H = window.innerHeight;
      api.getPanel("effects")?.group.api.setSize({ width: Math.round(W * 0.22), height: Math.round(H * 0.55) });
      api.getPanel("controls")?.group.api.setSize({ width: Math.round(W * 0.34) });
      api.getPanel("project")?.group.api.setSize({ width: Math.round(W * 0.22) });
      api.getPanel("controls")?.api.setActive(); api.getPanel("project")?.api.setActive();
    });
  } },
  { id: "graphics", name: "Graphics", build: (api, add) => {
    add("text");
    for (const id of ["templates", "effects"]) add(id, { referencePanel: "text", direction: "within" }, true);
    add("program", { referencePanel: "text", direction: "right" });
    add("controls", { referencePanel: "program", direction: "right" });
    add("graph", { referencePanel: "controls", direction: "within" }, true);
    add("timeline", { direction: "below" });
    add("project", { referencePanel: "timeline", direction: "left" });
    requestAnimationFrame(() => {
      const W = window.innerWidth, H = window.innerHeight;
      api.getPanel("text")?.group.api.setSize({ width: Math.round(W * 0.26), height: Math.round(H * 0.55) });
      api.getPanel("controls")?.group.api.setSize({ width: Math.round(W * 0.26) });
      api.getPanel("project")?.group.api.setSize({ width: Math.round(W * 0.22) });
      api.getPanel("text")?.api.setActive(); api.getPanel("controls")?.api.setActive();
    });
  } },
  // News Room (docs/EDITOR.md §16): rundown and graphics on the left, the program monitor with the other ratio beside
  // it, the Fill in form on the right, the timeline with its graphics tracks below
  { id: "news", name: "News Room", build: (api, add) => {
    add("nr-rundown");
    for (const id of ["nr-graphics", "nr-playlist", "nr-people", "project"]) add(id, { referencePanel: "nr-rundown", direction: "within" }, true);
    add("program", { referencePanel: "nr-rundown", direction: "right" });
    add("nr-companion", { referencePanel: "program", direction: "right" });
    add("nr-fill", { referencePanel: "nr-companion", direction: "right" });
    for (const id of ["nr-look", "nr-data", "nr-qc", "nr-deliver", "controls"]) add(id, { referencePanel: "nr-fill", direction: "within" }, true);
    add("timeline", { direction: "below" });
    requestAnimationFrame(() => {
      const W = window.innerWidth, H = window.innerHeight;
      api.getPanel("nr-rundown")?.group.api.setSize({ width: Math.round(W * 0.22), height: Math.round(H * 0.6) });
      api.getPanel("nr-companion")?.group.api.setSize({ width: Math.round(W * 0.16) });
      api.getPanel("nr-fill")?.group.api.setSize({ width: Math.round(W * 0.22) });
      api.getPanel("nr-graphics")?.api.setActive(); api.getPanel("nr-fill")?.api.setActive();
    });
  } },
];

export function listWorkspaces(): { id: string; name: string; custom: boolean }[] {
  const s = load();
  return [...BUILT_IN.map((w) => ({ id: w.id, name: w.name, custom: false })), ...s.custom.map((c) => ({ ...c, custom: true }))];
}
export const currentWorkspace = () => load().current;

/** Lays a built-in workspace out from scratch (panels this build doesn't have are left out). */
function build(api: DockviewApi, id: string, panels: PanelInfo[], editing: (api: DockviewApi) => void) {
  const w = BUILT_IN.find((x) => x.id === id);
  if (!w?.build) { editing(api); return; }
  api.clear();
  const add = (pid: string, position?: Parameters<DockviewApi["addPanel"]>[0]["position"], inactive?: boolean) => {
    const p = panels.find((x) => x.id === pid);
    if (!p || api.getPanel(pid)) return false;
    const ref = position && "referencePanel" in position && position.referencePanel ? String(position.referencePanel) : null;
    api.addPanel({ id: pid, component: pid, title: p.title, position: ref && !api.getPanel(ref) ? undefined : position, inactive });
    return true;
  };
  w.build(api, add);
}

/** Restores the current workspace as you left it (or lays it out); `legacy` is a layout saved before workspaces. */
export function restoreWorkspace(api: DockviewApi, panels: PanelInfo[], editing: (api: DockviewApi) => void, legacy?: unknown): void {
  const s = load();
  const saved = s.layouts[s.current] ?? (s.current === "editing" ? legacy : undefined);
  if (saved) {
    try {
      api.fromJSON(saved as never);
      if (api.panels.length && api.getPanel("timeline") && api.getPanel("program")) return;
    } catch { /* lay it out again */ }
  }
  if (s.current.startsWith("custom:") && !s.layouts[s.current]) s.current = "editing";
  build(api, s.current, panels, editing);
  store(s);
}

/** Remembers the layout of the current workspace (dockview's layout change). */
export function rememberWorkspace(api: DockviewApi) {
  const s = load();
  s.layouts[s.current] = api.toJSON();
  store(s);
}

export function switchWorkspace(api: DockviewApi, id: string, panels: PanelInfo[], editing: (api: DockviewApi) => void) {
  const s = load();
  s.layouts[s.current] = api.toJSON();
  s.current = id;
  store(s);
  const saved = s.layouts[id];
  if (saved) { try { api.fromJSON(saved as never); if (api.getPanel("timeline")) return; } catch { /* rebuild */ } }
  build(api, id, panels, editing);
}

/** Back to the workspace as it ships (your own: as you saved it). */
export function resetWorkspace(api: DockviewApi, panels: PanelInfo[], editing: (api: DockviewApi) => void) {
  const s = load();
  if (s.current.startsWith("custom:")) { const saved = s.layouts[`${s.current}#saved`]; if (saved) { try { api.fromJSON(saved as never); } catch { /* keep */ } } return; }
  delete s.layouts[s.current];
  store(s);
  build(api, s.current, panels, editing);
}

/** Saves the layout on screen as a new workspace (and switches to it). */
export function saveWorkspaceAs(api: DockviewApi, name: string): string {
  const s = load();
  const id = `custom:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"}`;
  const json = api.toJSON();
  s.custom = [...s.custom.filter((c) => c.id !== id), { id, name }];
  s.layouts[id] = json; s.layouts[`${id}#saved`] = json;
  s.current = id;
  store(s);
  return id;
}

export function deleteWorkspace(api: DockviewApi, id: string, panels: PanelInfo[], editing: (api: DockviewApi) => void) {
  const s = load();
  s.custom = s.custom.filter((c) => c.id !== id);
  delete s.layouts[id]; delete s.layouts[`${id}#saved`];
  const was = s.current === id;
  if (was) s.current = "editing";
  store(s);
  if (was) switchWorkspace(api, "editing", panels, editing);
}
