/**
 * The desktop's own commands for the palette and the cheat sheet: open files and folders, recent edits and studio
 * projects, pages, pop-out panels and workspaces, app actions, appearance and every settings section.
 */
import {
  AppWindow, ArrowUpCircle, Bell, Contrast, FileInput, FilePlus2, Film, FolderOpen, FolderTree, Gauge, Home, Keyboard, LayoutGrid, LibraryBig, ListChecks,
  MonitorCog, Moon, Palette, RefreshCw, Rows3, ScrollText, Server, Settings2, Sparkles, Sun, SunMoon, Wand2, ZoomIn, ZoomOut,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { desktop, PANEL_IDS, type AppearanceSettings, type EditListEntry, type UpdateState, type Workspace } from "../lib/desktop";
import { PANEL_META } from "../pages/desktop/meta";
import { newEditFromFolder, openEdit, type Nav } from "./actions";
import { ago, editUrl, errText } from "./bridge";
import { commandsChanged, registerCommands, type Command } from "./commands";
import { reloadGuardsThen } from "./ScreensToast";
import { SECTIONS } from "./settingsIndex";
import { setOverlay } from "./state";

const settings = (section?: string) => void desktop()?.shell?.open("settings", section ? { section } : undefined);

/** Recent edits, workspaces and projects, refreshed when the palette opens. */
const cache: { edits: EditListEntry[]; workspaces: Workspace[]; projects: { id: number; title: string; updated_at?: string }[]; update: UpdateState | null } = {
  edits: [], workspaces: [], projects: [], update: null,
};

export async function refreshCommandData(): Promise<void> {
  const d = desktop();
  if (!d) return;
  const [edits, ws, projects, update] = await Promise.all([
    d.editor?.list().catch(() => []) ?? Promise.resolve([]),
    d.windows.workspaces().catch(() => []),
    fetch("/api/projects?archived=false", { credentials: "include", headers: { "X-Requested-With": "veo-studio" } })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<{ id: number; title: string; updated_at?: string }[]>,
    d.app.updateState?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  cache.edits = edits;
  cache.workspaces = ws;
  cache.projects = Array.isArray(projects) ? projects : [];
  cache.update = update;
  commandsChanged();
}

async function setLook(patch: Partial<AppearanceSettings>) {
  try { await desktop()?.appearance?.set(patch); } catch (e) { toast.error(errText(e)); }
}

export function useBuiltinCommands(nav: Nav, pid: number | null): void {
  const navRef = useRef(nav);
  navRef.current = nav;
  const pidRef = useRef(pid);
  pidRef.current = pid;
  useEffect(() => registerCommands("desktop", () => {
    const d = desktop();
    if (!d) return [];
    const go: Nav = (to) => navRef.current(to);
    const p = pidRef.current;
    const out: Command[] = [];
    const add = (c: Command) => out.push(c);

    // files
    add({ id: "file.open-edit", group: "Files", title: "Open edit…", icon: <FolderOpen className="size-3.5" />, keywords: "open file tatvamedit", run: () => openEdit(go) });
    add({ id: "file.new-edit", group: "Files", title: "New edit", icon: <FilePlus2 className="size-3.5" />, keywords: "create editor", run: () => go("/editor") });
    add({ id: "file.new-from-folder", group: "Files", title: "New edit from folder…", icon: <FolderTree className="size-3.5" />, keywords: "open folder clips auto edit", run: () => newEditFromFolder() });
    add({ id: "file.import-timeline", group: "Files", title: "Import a timeline (XML, EDL, OTIO)…", icon: <FileInput className="size-3.5" />, keywords: "premiere resolve fcp open file",
      run: async () => {
        const i = d.editor?.interop;
        if (!i) { toast.message("Importing timelines needs a newer Tatvam Editor"); return; }
        const r = await i.importFile().catch((e) => { toast.error(errText(e)); return null; });
        if (r?.kind === "edit") go(editUrl(r.path));
      } });

    // recent edits
    for (const e of cache.edits.slice(0, 12)) {
      add({ id: `edit:${e.path}`, group: "Edits", title: e.name, hint: `${e.recent ? "Recent · " : ""}${ago(e.modified)} · ${e.path}`, icon: <Film className="size-3.5" />,
        keywords: "edit open recent", searchOnly: !e.recent, run: () => go(editUrl(e.path)) });
    }
    // studio projects
    for (const pr of cache.projects.slice(0, 40)) {
      add({ id: `project:${pr.id}`, group: "Projects", title: pr.title, hint: "Studio project", icon: <LibraryBig className="size-3.5" />, keywords: "project open studio",
        searchOnly: true, run: () => go(`/p/${pr.id}`) });
      add({ id: `project-finish:${pr.id}`, group: "Projects", title: `${pr.title}: Finishing room`, icon: <MonitorCog className="size-3.5" />, keywords: "finish render folder sync",
        searchOnly: true, run: () => go(`/p/${pr.id}/finish`) });
    }

    // pages
    add({ id: "nav.start", group: "Navigate", title: "Start", shortcut: "Ctrl+Shift+H", icon: <Home className="size-3.5" />, keywords: "home launcher recent", run: () => go("/desktop/panel/start") });
    add({ id: "nav.studio", group: "Navigate", title: "Studio projects", icon: <LayoutGrid className="size-3.5" />, keywords: "home dashboard", run: () => go("/") });
    add({ id: "nav.library", group: "Navigate", title: "Studio library", icon: <LibraryBig className="size-3.5" />, keywords: "assets", run: () => go("/library") });
    add({ id: "nav.editor", group: "Navigate", title: "Editor home", shortcut: "Ctrl+Shift+E", icon: <Film className="size-3.5" />, run: () => go("/editor") });
    add({ id: "nav.welcome", group: "Help", title: "Getting started (first-run steps)", icon: <Sparkles className="size-3.5" />, keywords: "onboarding welcome setup", run: () => go("/desktop/panel/welcome") });
    if (p) add({ id: "nav.finish", group: "Navigate", title: "Finishing room of this project", icon: <MonitorCog className="size-3.5" />, run: () => go(`/p/${p}/finish`) });

    // windows and panels
    for (const id of PANEL_IDS) {
      add({ id: `pop:${id}`, group: "Windows", title: `Pop out: ${PANEL_META[id].label}`, hint: PANEL_META[id].blurb, icon: <AppWindow className="size-3.5" />, keywords: "window panel second screen",
        run: () => void d.windows.popOut(id, p ? { pid: p } : undefined).catch((e) => toast.error(errText(e))) });
    }
    for (const w of cache.workspaces) {
      add({ id: `ws:${w.id}`, group: "Windows", title: `Workspace: ${w.name}`, icon: <Rows3 className="size-3.5" />, keywords: "layout screens",
        run: () => void d.windows.applyWorkspace(w.id).catch((e) => toast.error(errText(e))) });
    }
    add({ id: "win.settings", group: "Windows", title: "Settings", shortcut: "Ctrl+,", icon: <Settings2 className="size-3.5" />, keywords: "preferences options", run: () => settings() });

    // actions
    add({ id: "act.updates", group: "Actions", title: "Check for updates", icon: <ArrowUpCircle className="size-3.5" />,
      run: async () => {
        const u = await d.app.checkForUpdates().catch((e) => { toast.error(errText(e)); return null; });
        if (!u) return;
        if (u.state === "disabled") toast.message("Updates are off in a development build");
        else if (u.state === "error") toast.error(u.error ?? "Couldn't check for updates");
        else if (u.state === "none" || u.state === "idle") toast.success("Tatvam Desktop is up to date");
        else toast.message(u.state === "ready" ? `Update ${u.version} is ready` : `Update ${u.version ?? ""} is downloading`);
      } });
    if (cache.update?.state === "ready") {
      add({ id: "act.install-update", group: "Actions", title: `Restart to update to ${cache.update.version}`, icon: <ArrowUpCircle className="size-3.5" />,
        run: () => reloadGuardsThen(() => void d.app.installUpdate?.()) });
    }
    add({ id: "act.check-screens", group: "Actions", title: "Check for new screens", icon: <MonitorCog className="size-3.5" />, keywords: "ui build server offline copy",
      run: async () => {
        const s = await d.app.checkUi?.().catch((e) => { toast.error(errText(e)); return null; });
        if (s) toast.message(s.lastError ? `Screens: ${s.lastError}` : s.label);
      } });
    if (p) add({ id: "act.sync", group: "Actions", title: "Sync this project's folder now", shortcut: "Ctrl+Shift+S", icon: <RefreshCw className="size-3.5" />,
      run: () => void d.sync.start(p).then(() => toast.success("Sync started")).catch((e) => toast.error(errText(e))) });
    add({ id: "act.jobs", group: "Actions", title: "Show the job queue", icon: <ListChecks className="size-3.5" />, keywords: "renders progress", run: () => setOverlay("jobs") });
    add({ id: "act.notifications", group: "Actions", title: "Show notifications", icon: <Bell className="size-3.5" />, run: () => setOverlay("notifications") });
    add({ id: "act.proxy", group: "Actions", title: "Proxy mode on / off", icon: <Gauge className="size-3.5" />, keywords: "1080p proxies playback slow",
      run: async () => {
        const s = await d.settings.get();
        await d.media.proxyMode(!s.proxyMode);
        toast.message(`Proxy mode ${!s.proxyMode ? "on" : "off"}`);
      } });
    add({ id: "act.server", group: "Actions", title: "Studio server…", icon: <Server className="size-3.5" />, keywords: "connect address offline", run: () => void d.app.openConnection() });
    add({ id: "act.logs", group: "Actions", title: "Open the logs folder", icon: <ScrollText className="size-3.5" />, run: () => void d.app.revealLogs() });
    add({ id: "act.machine", group: "Actions", title: "Machine check", icon: <Gauge className="size-3.5" />, keywords: "gpu encoder nvenc baseline",
      run: () => go(p ? `/p/${p}/finish#machine` : "/desktop/panel/start#machine") });

    // help
    add({ id: "help.shortcuts", group: "Help", title: "Keyboard shortcuts", shortcut: "Shift+/", icon: <Keyboard className="size-3.5" />, keywords: "cheat sheet keys", run: () => setOverlay("shortcuts") });
    add({ id: "help.whatsnew", group: "Help", title: "What's new", icon: <Sparkles className="size-3.5" />, keywords: "release notes changelog", run: () => setOverlay("whatsnew") });
    add({ id: "help.auto-edit", group: "Help", title: "Auto edit a folder of clips…", icon: <Wand2 className="size-3.5" />, keywords: "assistant ai", searchOnly: true, run: () => newEditFromFolder() });

    // appearance
    add({ id: "look.dark", group: "Appearance", title: "Theme: dark", icon: <Moon className="size-3.5" />, searchOnly: true, run: () => setLook({ theme: "dark" }) });
    add({ id: "look.light", group: "Appearance", title: "Theme: light", icon: <Sun className="size-3.5" />, searchOnly: true, run: () => setLook({ theme: "light" }) });
    add({ id: "look.system", group: "Appearance", title: "Theme: same as Windows", icon: <SunMoon className="size-3.5" />, keywords: "system", searchOnly: true, run: () => setLook({ theme: "system" }) });
    add({ id: "look.bigger", group: "Appearance", title: "Bigger UI (zoom in)", shortcut: "Ctrl+Plus", icon: <ZoomIn className="size-3.5" />, keywords: "scale", searchOnly: true,
      run: async () => { const a = await d.appearance?.get(); if (a) await setLook({ scale: a.scale + 10 }); } });
    add({ id: "look.smaller", group: "Appearance", title: "Smaller UI (zoom out)", shortcut: "Ctrl+-", icon: <ZoomOut className="size-3.5" />, keywords: "scale", searchOnly: true,
      run: async () => { const a = await d.appearance?.get(); if (a) await setLook({ scale: a.scale - 10 }); } });
    add({ id: "look.actual", group: "Appearance", title: "Actual size (100 %)", shortcut: "Ctrl+0", icon: <ZoomIn className="size-3.5" />, keywords: "scale reset", searchOnly: true, run: () => setLook({ scale: 100 }) });
    add({ id: "look.compact", group: "Appearance", title: "Compact / comfortable density", icon: <Rows3 className="size-3.5" />, searchOnly: true,
      run: async () => { const a = await d.appearance?.get(); if (a) await setLook({ density: a.density === "compact" ? "comfortable" : "compact" }); } });
    add({ id: "look.motion", group: "Appearance", title: "Reduce motion on / off", icon: <Palette className="size-3.5" />, keywords: "animation", searchOnly: true,
      run: async () => { const a = await d.appearance?.get(); if (a) await setLook({ reduceMotion: !a.reduceMotion }); } });
    add({ id: "look.contrast", group: "Appearance", title: "High contrast on / off", icon: <Contrast className="size-3.5" />, keywords: "accessibility", searchOnly: true,
      run: async () => { const a = await d.appearance?.get(); if (a) await setLook({ highContrast: !a.highContrast }); } });

    // settings
    for (const s of SECTIONS) {
      add({ id: `settings:${s.id}`, group: "Settings", title: `Settings: ${s.title}`, hint: s.blurb, icon: <Settings2 className="size-3.5" />, searchOnly: s.id !== "appearance",
        run: () => settings(s.id) });
    }
    return out;
  }), []);
}
