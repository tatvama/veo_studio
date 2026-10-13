/**
 * The Tatvam Editor workspace (docs/EDITOR.md §3): a menu bar, the docked panels (dockview, Premiere's Editing
 * layout by default, saved per browser), the global keyboard, autosave and the unsaved-changes guard.
 */
import "dockview-react/dist/styles/dockview.css";
import "../pages/project/studio/studio.css";
import "./editor.css";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme, type IDockviewPanelProps } from "dockview-react";
import { clsx } from "clsx";
import { ArrowLeft, Circle, CloudOff, Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Modal } from "../components/ui";
import { editorBridge } from "../lib/desktop";
import * as A from "./actions";
import { hasAi, loadAi, type AiModule } from "./aiLoader";
import { Dialogs, openDialog } from "./dialogs";
import { EpisodePicker } from "./EpisodePicker";
import { useEditorHost } from "./host";
import { interopFileItems } from "./interop/menu";
import { handleKey, SHORTCUTS } from "./keymap";
import * as M from "./motionActions";
import { ShortcutEditor } from "./ShortcutEditor";
import { currentWorkspace, deleteWorkspace, listWorkspaces, rememberWorkspace, resetWorkspace, restoreWorkspace, saveWorkspaceAs, switchWorkspace } from "./workspaces";
import { seqEnd } from "./model/ops";
import { playProgram } from "./playback/control";
import { program } from "./playback/transport";
import { importEpisode, importFiles, importLut, save, saveAs, startAutosave } from "./session";
import { canRedoNow, canUndoNow, ed, isDirty, redo, setFocus, toggleLinked, toggleSnapping, undo, useDirty, useEditor, useProject, useSequence, type Focus } from "./store";
import { useShallow } from "zustand/react/shallow";
import { Fragment } from "react";
import { kbd, MenuHost, openMenu, type MenuItem } from "./ui";
import { DesktopEditorHooks, DesktopStatusSlot } from "../desktop/editorHooks"; // desktop shell: palette, guard, drops, status (additive)
import { AssistantBanner, AssistantExecutor, AutoEditDialog, openAutoEdit } from "../automation"; // desktop-mcp: AI assistants and auto edit (additive)
import { startLutMigration } from "./moods/matchLuts";
import { NewsroomOverlays } from "./newsroom/overlays"; // News Room full-window tools (docs/EDITOR.md §16)

const Timeline = lazy(() => import("./timeline/Timeline"));
const ProgramMonitor = lazy(() => import("./panels/ProgramMonitor"));
const SourceMonitor = lazy(() => import("./panels/SourceMonitor"));
const ProjectPanel = lazy(() => import("./panels/ProjectPanel"));
const EffectsPanel = lazy(() => import("./panels/EffectsPanel"));
const EffectControls = lazy(() => import("./panels/EffectControls"));
const AudioMixer = lazy(() => import("./panels/AudioMixer"));
const TextPanel = lazy(() => import("./panels/TextPanel"));
const MarkersPanel = lazy(() => import("./panels/small").then((m) => ({ default: m.MarkersPanel })));
const HistoryPanel = lazy(() => import("./panels/small").then((m) => ({ default: m.HistoryPanel })));
const InfoPanel = lazy(() => import("./panels/small").then((m) => ({ default: m.InfoPanel })));
// wave 3 (editor-motion)
const GraphEditor = lazy(() => import("./panels/GraphEditor"));
// wave 3 (editor-looks)
const MoodsPanel = lazy(() => import("./panels/Moods"));
const LutBrowser = lazy(() => import("./panels/LutBrowser"));
const ScopesPanel = lazy(() => import("./panels/Scopes"));
const TemplatesPanel = lazy(() => import("./panels/Templates"));
const TranscriptPanel = lazy(() => import("./panels/Transcript"));
const CommentsPanel = lazy(() => import("./panels/Comments"));
// News Room (docs/EDITOR.md §16)
const NrGraphics = lazy(() => import("./newsroom/panels/GraphicsLibrary"));
const NrFillIn = lazy(() => import("./newsroom/panels/FillIn"));
const NrRundown = lazy(() => import("./newsroom/panels/Rundown"));
const NrPeople = lazy(() => import("./newsroom/panels/People"));
const NrPlaylist = lazy(() => import("./newsroom/panels/Playlist"));
const NrCompanion = lazy(() => import("./newsroom/panels/CompanionMonitor"));
const NrLook = lazy(() => import("./newsroom/panels/LookPanel"));
const NrData = lazy(() => import("./newsroom/panels/DataPanel"));
const NrQc = lazy(() => import("./newsroom/panels/GraphicsQC"));
const NrDeliver = lazy(() => import("./newsroom/panels/Deliver"));
const VersionsPanel = lazy(() => import("./panels/Versions"));
const ExportFormatsDialog = lazy(() => import("./panels/ExportFormats").then((m) => ({ default: m.ExportFormatsDialog })));
// wave 3 (editor-audio)
const AudioEffectsPanel = lazy(() => import("./panels/AudioEffects"));
const EssentialSoundPanel = lazy(() => import("./panels/EssentialSound"));
const LoudnessPanel = lazy(() => import("./panels/LoudnessMeter"));
const SpectrumPanel = lazy(() => import("./panels/Spectrum"));

const THEME: DockviewTheme = { name: "veo", className: "dockview-theme-veo", gap: 5, dndOverlayMounting: "absolute" };
const LAYOUT_KEY = "tatvam-editor:layout:v1";

const PANELS: { id: string; title: string; focus: Focus; C: ComponentType }[] = [
  { id: "project", title: "Project", focus: "project", C: ProjectPanel },
  { id: "source", title: "Source", focus: "source", C: SourceMonitor },
  { id: "program", title: "Program", focus: "program", C: ProgramMonitor },
  { id: "timeline", title: "Timeline", focus: "timeline", C: Timeline },
  { id: "effects", title: "Effects", focus: "effects", C: EffectsPanel },
  { id: "controls", title: "Effect Controls", focus: "controls", C: EffectControls },
  { id: "mixer", title: "Audio Mixer", focus: "mixer", C: AudioMixer },
  { id: "text", title: "Text", focus: "text", C: TextPanel },
  { id: "markers", title: "Markers", focus: "other", C: MarkersPanel },
  { id: "history", title: "History", focus: "other", C: HistoryPanel },
  { id: "info", title: "Info", focus: "other", C: InfoPanel },
  { id: "ai", title: "AI", focus: "other", C: AiTab },
  { id: "graph", title: "Graph Editor", focus: "graph", C: GraphEditor },
  { id: "moods", title: "Moods", focus: "other", C: MoodsPanel },
  { id: "luts", title: "LUT Browser", focus: "other", C: LutBrowser },
  { id: "scopes", title: "Scopes", focus: "other", C: ScopesPanel },
  { id: "templates", title: "Templates", focus: "other", C: TemplatesPanel },
  { id: "transcript", title: "Transcript", focus: "other", C: TranscriptPanel },
  { id: "comments", title: "Comments", focus: "other", C: CommentsPanel },
  { id: "versions", title: "Versions", focus: "other", C: VersionsPanel },
  { id: "audiofx", title: "Audio Effects", focus: "other", C: AudioEffectsPanel },
  { id: "essential", title: "Essential Sound", focus: "other", C: EssentialSoundPanel },
  { id: "loudness", title: "Loudness", focus: "mixer", C: LoudnessPanel },
  { id: "spectrum", title: "Spectrum", focus: "mixer", C: SpectrumPanel },
  { id: "nr-graphics", title: "Graphics", focus: "other", C: NrGraphics },
  { id: "nr-fill", title: "Fill in", focus: "other", C: NrFillIn },
  { id: "nr-rundown", title: "Rundown", focus: "other", C: NrRundown },
  { id: "nr-people", title: "People", focus: "other", C: NrPeople },
  { id: "nr-playlist", title: "Playlist", focus: "other", C: NrPlaylist },
  { id: "nr-companion", title: "Other ratio", focus: "other", C: NrCompanion },
  { id: "nr-look", title: "Channel look", focus: "other", C: NrLook },
  { id: "nr-data", title: "Data", focus: "other", C: NrData },
  { id: "nr-qc", title: "Graphics check", focus: "other", C: NrQc },
  { id: "nr-deliver", title: "News delivery", focus: "other", C: NrDeliver },
];

/** The AI panel from editor/ai (lazily, only when that module exists). */
function AiTab() {
  const host = useEditorHost();
  const [mod, setMod] = useState<AiModule | null | undefined>(undefined);
  useEffect(() => { void loadAi().then(setMod); }, []);
  if (mod === undefined) return <div className="pn-empty"><Loader2 className="size-4 animate-spin" /></div>;
  if (!mod) return <div className="pn-empty">The AI tools aren't part of this build.</div>;
  const P = mod.AiPanel;
  return <div className="pn"><P host={host} /></div>;
}

const COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps>> = Object.fromEntries(PANELS.map((p) => [p.id, () => (
  <Suspense fallback={<div className="pn-empty"><Loader2 className="size-4 animate-spin" /></div>}><p.C /></Suspense>
)]));

function defaultLayout(api: DockviewApi) {
  api.clear();
  const P = (id: string) => PANELS.find((p) => p.id === id)!;
  api.addPanel({ id: "source", component: "source", title: P("source").title });
  api.addPanel({ id: "controls", component: "controls", title: P("controls").title, position: { referencePanel: "source", direction: "within" }, inactive: true });
  api.addPanel({ id: "mixer", component: "mixer", title: P("mixer").title, position: { referencePanel: "source", direction: "within" }, inactive: true });
  api.addPanel({ id: "text", component: "text", title: P("text").title, position: { referencePanel: "source", direction: "within" }, inactive: true });
  for (const id of ["moods", "templates", "luts", "scopes"]) api.addPanel({ id, component: id, title: P(id).title, position: { referencePanel: "source", direction: "within" }, inactive: true });
  api.addPanel({ id: "graph", component: "graph", title: P("graph").title, position: { referencePanel: "source", direction: "within" }, inactive: true });
  for (const id of ["audiofx", "essential", "loudness", "spectrum"]) api.addPanel({ id, component: id, title: P(id).title, position: { referencePanel: "source", direction: "within" }, inactive: true });
  api.addPanel({ id: "program", component: "program", title: P("program").title, position: { referencePanel: "source", direction: "right" } });
  api.addPanel({ id: "project", component: "project", title: P("project").title, position: { direction: "below" } });
  api.addPanel({ id: "timeline", component: "timeline", title: P("timeline").title, position: { referencePanel: "project", direction: "right" } });
  for (const id of ["effects", "markers", "history", "info", ...(hasAi() ? ["ai"] : []), "transcript", "comments", "versions"]) {
    api.addPanel({ id, component: id, title: P(id).title, position: { referencePanel: "project", direction: "within" }, inactive: true });
  }
  requestAnimationFrame(() => {
    const W = window.innerWidth, H = window.innerHeight;
    api.getPanel("project")?.group.api.setSize({ width: Math.round(W * 0.27) });
    api.getPanel("source")?.group.api.setSize({ width: Math.round(W * 0.42), height: Math.round(H * 0.5) });
    api.getPanel("project")?.api.setActive();
    api.getPanel("timeline")?.api.setActive();
  });
}

export default function EditorApp() {
  const nav = useNavigate();
  const p = useProject();
  const s = useSequence();
  const dirty = useDirty();
  const st = useEditor(useShallow((x) => ({ saving: x.saving, savedAt: x.savedAt, saveError: x.saveError, demo: x.demo, path: x.path })));
  const apiRef = useRef<DockviewApi | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [epOpen, setEpOpen] = useState(false);
  const [epBusy, setEpBusy] = useState(false);
  const bridge = editorBridge();

  useEffect(() => { document.title = `${dirty ? "● " : ""}${p.name} — Tatvam Editor`; }, [p.name, dirty]);
  useEffect(() => startAutosave(), []);
  // shot-match LUTs kept as data: URLs (older desktop builds) move into the edit's LUTs folder after a save
  useEffect(() => startLutMigration(), []);
  // automation (QA drivers over CDP): opt-in per browser profile
  useEffect(() => {
    let on = false;
    try { on = localStorage.getItem("tatvam-editor:debug") === "1"; } catch { /* blocked */ }
    if (!on) return;
    void Promise.all([import("./store"), import("./model/ops"), import("./session"), import("./dialogs"), import("./model/params"), import("./effects"), import("./engine")]).then(([store, ops, session, dialogs, params, effects, engine]) => {
      (window as unknown as Record<string, unknown>).__tatvamEditor = { store, ops, actions: A, motion: M, session, dialogs, params, effects, engine, program, showPanel: (id: string) => window.dispatchEvent(new CustomEvent("ed:panel", { detail: id })) };
    });
  }, []);
  // the playhead starts where the sequence was left
  useEffect(() => { program.configure(s.fps, seqEnd(s)); program.seek(s.playhead || 0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [p.id]);

  const guard = (then: () => void) => {
    if (!isDirty() || ed().demo) { then(); return; }
    openDialog({ kind: "unsaved", name: p.name, onSave: save, onDiscard: then });
  };
  const handlers = {
    save: () => void save(),
    saveAs: () => openDialog({ kind: "prompt", title: "Save as", label: "Name of the new edit", value: `${p.name} copy`, ok: "Save", onOk: (v) => void saveAs(v).then((path) => { if (path) nav(`/editor/edit?path=${encodeURIComponent(path)}`, { replace: true }); }) }),
    open: () => guard(async () => {
      const b = editorBridge();
      if (!b) { toast.message("Opening edits needs Tatvam Desktop"); return; }
      const r = await b.open().catch((e) => { toast.error(String((e as Error).message ?? e)); return null; });
      if (r) nav(`/editor/edit?path=${encodeURIComponent(r.path)}`);
    }),
    newEdit: () => guard(() => nav("/editor")),
    importMedia: () => void importFiles(),
    exportSeq: () => openDialog({ kind: "export" }),
    shortcuts: () => setShortcuts(true),
    shortcutEditor: () => setKeysOpen(true),
    laneWidth: () => Math.max(200, (document.querySelector(".tl-body")?.clientWidth ?? 900) - 196),
  };
  const hRef = useRef(handlers);
  hRef.current = handlers;

  useEffect(() => {
    const key = (e: KeyboardEvent) => { handleKey(e, hRef.current); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  // closing the window with unsaved changes: the browser asks; the desktop app saves (autosave covers the rest)
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      if (editorBridge() && ed().path) { void save(); return; }
      e.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);
  // the desktop menu's File → New edit / Open edit (components/shell/DesktopMenu.tsx): ask about unsaved changes first
  useEffect(() => {
    const menu = (e: Event) => {
      e.preventDefault();
      if ((e as CustomEvent<string>).detail === "open-edit") hRef.current.open(); else hRef.current.newEdit();
    };
    window.addEventListener("ed:desktop-menu", menu);
    return () => window.removeEventListener("ed:desktop-menu", menu);
  }, []);
  useEffect(() => {
    const open = () => setKeysOpen(true);
    window.addEventListener("ed:shortcut-editor", open);
    return () => window.removeEventListener("ed:shortcut-editor", open);
  }, []);
  useEffect(() => {
    const show = (e: Event) => {
      const id = (e as CustomEvent<string>).detail, api = apiRef.current;
      const have = api?.getPanel(id);
      if (have) { have.api.setActive(); return; }
      // a panel the saved layout doesn't have yet (added in a later version): open it beside the Source monitor
      const P = PANELS.find((x) => x.id === id);
      if (api && P) api.addPanel({ id, component: id, title: P.title, position: api.getPanel("source") ? { referencePanel: "source", direction: "within" } : undefined });
    };
    window.addEventListener("ed:panel", show);
    return () => window.removeEventListener("ed:panel", show);
  }, []);

  const onReady = (e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    // the current workspace as it was left (editor-motion: workspaces.ts); the pre-workspace layout counts as Editing
    let legacy: unknown;
    try { const saved = localStorage.getItem(LAYOUT_KEY); if (saved) legacy = JSON.parse(saved); } catch { legacy = undefined; }
    restoreWorkspace(e.api, PANELS, defaultLayout, legacy);
    if (hasAi() && !e.api.getPanel("ai") && e.api.getPanel("project")) e.api.addPanel({ id: "ai", component: "ai", title: "AI", position: { referencePanel: "project", direction: "within" }, inactive: true });
    e.api.onDidLayoutChange(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON())); } catch { /* blocked */ } rememberWorkspace(e.api); });
    e.api.onDidActivePanelChange((ev) => { const f = PANELS.find((x) => x.id === ev.panel?.id)?.focus; if (f) setFocus(f); });
  };
  const showPanel = (id: string) => {
    const api = apiRef.current;
    if (!api) return;
    const have = api.getPanel(id);
    if (have) { have.api.setActive(); return; }
    const P = PANELS.find((x) => x.id === id)!;
    api.addPanel({ id, component: id, title: P.title, position: api.getPanel("project") ? { referencePanel: "project", direction: "within" } : undefined });
  };

  // ── menus ────────────────────────────────────────────────────────────────
  const menus: { label: string; items: () => MenuItem[] }[] = [
    { label: "File", items: () => [
      { label: "New edit…", shortcut: kbd("Ctrl+Alt+N"), onClick: handlers.newEdit },
      { label: "Open edit…", shortcut: kbd("Ctrl+O"), disabled: !bridge, onClick: handlers.open },
      { label: "Save", shortcut: kbd("Ctrl+S"), separator: true, onClick: handlers.save },
      { label: "Save as…", shortcut: kbd("Ctrl+Shift+S"), disabled: !bridge, onClick: handlers.saveAs },
      { label: "Import media…", shortcut: kbd("Ctrl+I"), separator: true, disabled: !bridge, onClick: handlers.importMedia },
      { label: "Import studio episode…", disabled: !bridge, onClick: () => setEpOpen(true) },
      { label: "Import LUT…", disabled: !bridge, onClick: () => void importLut() },
      { label: "New sequence…", separator: true, onClick: () => openDialog({ kind: "newSequence" }) },
      { label: "Auto edit…", disabled: !bridge, onClick: () => openAutoEdit() },
      { label: "Export…", shortcut: kbd("Ctrl+M"), separator: true, onClick: handlers.exportSeq },
      { label: "Export multiple formats…", onClick: () => window.dispatchEvent(new CustomEvent("ed:export-formats")) },
      ...interopFileItems((path) => guard(() => nav(`/editor/edit?path=${encodeURIComponent(path)}`))),
      { label: "Rename edit…", separator: true, onClick: () => openDialog({ kind: "prompt", title: "Rename edit", label: "Name", value: p.name, ok: "Rename", onOk: A.renameProject }) },
      { label: "Project settings…", onClick: () => openDialog({ kind: "settings" }) },
      { label: "Close edit", onClick: () => guard(() => nav("/editor")) },
    ] },
    { label: "Edit", items: () => [
      { label: `Undo${ed().h.past.length ? ` ${ed().h.past[ed().h.past.length - 1].label}` : ""}`, shortcut: kbd("Ctrl+Z"), disabled: !canUndoNow(), onClick: undo },
      { label: `Redo${ed().h.future.length ? ` ${ed().h.future[0].label}` : ""}`, shortcut: kbd("Ctrl+Shift+Z"), disabled: !canRedoNow(), onClick: redo },
      { label: "Cut", shortcut: kbd("Ctrl+X"), separator: true, onClick: () => A.copy(true) },
      { label: "Copy", shortcut: kbd("Ctrl+C"), onClick: () => A.copy() },
      { label: "Paste", shortcut: kbd("Ctrl+V"), onClick: () => A.paste("overwrite") },
      { label: "Paste insert", shortcut: kbd("Ctrl+Shift+V"), onClick: () => A.paste("insert") },
      { label: "Paste attributes", shortcut: kbd("Ctrl+Alt+V"), onClick: A.pasteAttributes },
      { label: "Clear", shortcut: "Del", separator: true, onClick: () => A.deleteSelection(false) },
      { label: "Ripple delete", shortcut: "Shift+Del", onClick: () => A.deleteSelection(true) },
      { label: "Snapping", shortcut: "S", separator: true, checked: ed().snapping, onClick: toggleSnapping },
      { label: "Linked selection", checked: ed().linked, onClick: toggleLinked },
    ] },
    { label: "Clip", items: () => [
      { label: "Speed / Duration…", shortcut: kbd("Ctrl+R"), onClick: () => { const ids = ed().selection; if (ids.length) openDialog({ kind: "speed", ids }); else toast.message("Select clips first"); } },
      { label: "Enable", shortcut: "Shift+E", onClick: A.toggleEnabled },
      { label: "Link / unlink", shortcut: kbd("Ctrl+L"), onClick: A.linkSelection },
      { label: "Group", shortcut: kbd("Ctrl+G"), onClick: A.groupSelection },
      { label: "Swap two clips", onClick: A.swapSelection },
      { label: "Nest into a compound clip…", shortcut: kbd("Ctrl+Shift+N"), onClick: M.nestNamed },
      { label: "Un-nest (break apart)", onClick: () => M.unnest() },
      { label: "Insert frame hold at playhead", separator: true, onClick: () => M.insertFreezeAt() },
      { label: "Frame hold (whole clip)", onClick: M.holdFrameAt },
      { label: "Make multicam clip (sync by sound)", separator: true, onClick: () => void M.createMulticam("audio") },
      { label: "Flatten multicam", onClick: () => M.flattenMulticam() },
      { label: "Insert from Source", shortcut: ",", separator: true, onClick: () => A.sourceEdit("insert") },
      { label: "Overwrite from Source", shortcut: ".", onClick: () => A.sourceEdit("overwrite") },
      { label: "New title", shortcut: kbd("Ctrl+T"), separator: true, onClick: () => A.newTitle() },
      { label: "New colour matte", onClick: () => A.newMatte("color") },
      { label: "New adjustment layer", onClick: () => A.newMatte("adjustment") },
    ] },
    { label: "Sequence", items: () => [
      { label: "Add edit", shortcut: kbd("Ctrl+K"), onClick: () => A.addEdit(false) },
      { label: "Add edit to all tracks", shortcut: kbd("Ctrl+Shift+K"), onClick: () => A.addEdit(true) },
      { label: "Lift", shortcut: ";", separator: true, onClick: () => A.liftExtract("lift") },
      { label: "Extract", shortcut: "'", onClick: () => A.liftExtract("extract") },
      { label: "Ripple trim previous edit to playhead", shortcut: "Q", onClick: () => A.rippleTrimTo("prev") },
      { label: "Ripple trim next edit to playhead", shortcut: "W", onClick: () => A.rippleTrimTo("next") },
      { label: "Apply video transition", shortcut: kbd("Ctrl+D"), separator: true, onClick: () => A.defaultTransitions("video") },
      { label: "Apply audio crossfade", shortcut: kbd("Ctrl+Shift+D"), onClick: () => A.defaultTransitions("audio") },
      { label: "Magnetic timeline", separator: true, checked: !!s.magnetic, onClick: M.toggleMagnetic },
      { label: "Add video track", separator: true, onClick: () => A.addTrack("video") },
      { label: "Add audio track", onClick: () => A.addTrack("audio") },
      { label: "Zoom in", shortcut: "=", separator: true, onClick: () => A.zoomBy(1.5, program.frame, handlers.laneWidth()) },
      { label: "Zoom out", shortcut: "-", onClick: () => A.zoomBy(1 / 1.5, program.frame, handlers.laneWidth()) },
      { label: "Zoom to sequence", shortcut: "\\", onClick: () => A.zoomToFit(handlers.laneWidth()) },
      { label: "New sequence…", separator: true, onClick: () => openDialog({ kind: "newSequence" }) },
    ] },
    { label: "Marker", items: () => [
      { label: "Mark in", shortcut: "I", onClick: () => A.markIn() },
      { label: "Mark out", shortcut: "O", onClick: () => A.markOut() },
      { label: "Mark clip", shortcut: "X", onClick: A.markClip },
      { label: "Go to in", shortcut: "Shift+I", separator: true, onClick: () => A.gotoInOut("in") },
      { label: "Go to out", shortcut: "Shift+O", onClick: () => A.gotoInOut("out") },
      { label: "Clear in and out", shortcut: kbd("Ctrl+Shift+X"), onClick: () => A.clearInOut() },
      { label: "Add marker", shortcut: "M", separator: true, onClick: () => A.addSeqMarker() },
      { label: "Go to next marker", shortcut: "Shift+M", onClick: () => A.gotoMarker(1) },
      { label: "Go to previous marker", shortcut: kbd("Ctrl+Shift+M"), onClick: () => A.gotoMarker(-1) },
    ] },
    { label: "Window", items: () => [
      ...PANELS.filter((x) => x.id !== "ai" || hasAi()).map((x) => ({ label: x.title, checked: !!apiRef.current?.getPanel(x.id), onClick: () => showPanel(x.id) })),
      { label: "Workspaces", separator: true, items: [
        ...listWorkspaces().map((w) => ({ label: w.name, checked: currentWorkspace() === w.id, onClick: () => { if (apiRef.current) switchWorkspace(apiRef.current, w.id, PANELS, defaultLayout); } })),
        { label: "Save as new workspace…", separator: true, onClick: () => openDialog({ kind: "prompt", title: "Save workspace", label: "Name", value: "My workspace", ok: "Save", onOk: (v) => { if (apiRef.current) { saveWorkspaceAs(apiRef.current, v || "My workspace"); toast.success(`Workspace "${v}" saved`); } } }) },
        ...listWorkspaces().filter((w) => w.custom).map((w) => ({ label: `Delete "${w.name}"`, danger: true, onClick: () => { if (apiRef.current) deleteWorkspace(apiRef.current, w.id, PANELS, defaultLayout); } })),
      ] },
      { label: "Reset this workspace", onClick: () => { if (apiRef.current) resetWorkspace(apiRef.current, PANELS, defaultLayout); } },
    ] },
    { label: "Help", items: () => [
      { label: "Keyboard shortcuts", shortcut: "?", onClick: () => setShortcuts(true) },
      { label: "Keyboard shortcut editor…", shortcut: kbd("Ctrl+Alt+K"), onClick: () => setKeysOpen(true) },
      { label: "Back to the studio", separator: true, onClick: () => guard(() => nav("/")) },
    ] },
  ];

  return (
    <div className="ed-root fixed inset-0 flex flex-col bg-bg text-ink">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <button type="button" className="ed-ibtn" title="Editor home" onClick={() => guard(() => nav("/editor"))}><ArrowLeft className="size-4" /></button>
        <span className="mr-2 select-none font-semibold tracking-tight"><span className="text-gradient">TATVAM</span> <span className="text-2xs font-medium text-mute">EDITOR</span></span>
        {menus.map((m) => (
          <button key={m.label} type="button" className="ed-menubtn" onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), m.items())}>{m.label}</button>
        ))}
        <div className="mx-auto flex min-w-0 items-center gap-2 text-xs">
          <span className="truncate font-medium">{p.name}</span>
          <span className="text-dim">/</span>
          <span className="truncate text-mute">{s.name}</span>
          <SaveState dirty={dirty} saving={st.saving} savedAt={st.savedAt} error={st.saveError} demo={st.demo} />
        </div>
        <button type="button" className="ed-menubtn" onClick={() => playProgram()} title="Play / pause (Space)">Play</button>
      </header>
      <div className="min-h-0 flex-1 p-1.5">
        <DockviewReact className="h-full" theme={THEME} components={COMPONENTS} onReady={onReady} />
      </div>
      <StatusStrip />
      <MenuHost />
      <DesktopEditorHooks panels={PANELS} showPanel={showPanel} isDirty={isDirty} save={save} name={p.name} />
      <Dialogs />
      <ShortcutEditor open={keysOpen} onClose={() => setKeysOpen(false)} />
      <Suspense fallback={null}><ExportFormatsDialog /></Suspense>
      <AssistantExecutor />
      <AssistantBanner />
      <AutoEditDialog />
      <NewsroomOverlays />
      <EpisodePicker open={epOpen} busy={epBusy} onClose={() => setEpOpen(false)} onPick={async (pid, eid) => {
        setEpBusy(true);
        const ok = await importEpisode(pid, eid);
        setEpBusy(false);
        if (ok) setEpOpen(false);
      }} />
      <Modal open={shortcuts} onClose={() => setShortcuts(false)} title="Keyboard shortcuts" size="lg">
        <div className="grid gap-5 sm:grid-cols-2">
          {SHORTCUTS.map(([group, list]) => (
            <div key={group}>
              <p className="eyebrow mb-1.5">{group}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {list.map(([k, v]) => <Fragment key={k}><dt className="mono whitespace-nowrap text-accent-ink">{kbd(k)}</dt><dd className="text-mute">{v}</dd></Fragment>)}
              </dl>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

function SaveState({ dirty, saving, savedAt, error, demo }: { dirty: boolean; saving: boolean; savedAt: string | null; error: string | null; demo: boolean }) {
  if (demo) return <span className="rounded-md border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-2xs text-amber-300" title="This edit lives in memory only">Demo · not saved</span>;
  if (saving) return <span className="flex items-center gap-1 text-2xs text-dim"><Loader2 className="size-3 animate-spin" />Saving…</span>;
  if (error) return <span className="flex items-center gap-1 text-2xs text-red-300" title={error}><CloudOff className="size-3" />Not saved</span>;
  if (dirty) return <span className="flex items-center gap-1 text-2xs text-dim" title="Autosaves every few seconds"><Circle className="size-2 fill-current text-warn" />Edited</span>;
  return <span className="text-2xs text-dim">{savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Saved"}</span>;
}

function StatusStrip() {
  const { tool, snapping, selection, linked } = useEditor(useShallow((x) => ({ tool: x.tool, snapping: x.snapping, selection: x.selection.length, linked: x.linked })));
  const s = useSequence();
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-dim">
      <span>Tool: <span className="text-mute">{tool}</span></span>
      <span className={clsx(snapping ? "text-accent-ink" : "")}>Snapping {snapping ? "on" : "off"}</span>
      <span>Linked {linked ? "on" : "off"}</span>
      <span>{selection ? `${selection} selected` : "Nothing selected"}</span>
      <span className="ml-auto mono">{s.clips.length} clips · {s.tracks.length} tracks</span>
      <DesktopStatusSlot />
    </footer>
  );
}
