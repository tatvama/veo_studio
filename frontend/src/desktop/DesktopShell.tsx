/**
 * The desktop shell in a window (mounted once by components/shell/DesktopMenu.tsx, which every signed-in window has):
 * the custom title bar, the status bar, the command palette, the shortcut cheat sheet, the notification centre and
 * job queue, "New screens are ready", drops from Explorer, the folder choice, What's new, and the live appearance.
 * Renders nothing in a plain browser, an older desktop build, or the clean full-screen feed.
 */
import "./desktop.css";
import { useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getThemePref, useThemePref } from "../components/shell/theme";
import { isTypingTarget } from "../components/shell/keys";
import { desktop } from "../lib/desktop";
import { applyAppearance, appliedTheme } from "./appearance";
import { refreshCommandData, useBuiltinCommands } from "./builtins";
import { CheatSheet } from "./CheatSheet";
import { isClaimed } from "./commands";
import { DropZone } from "./DropZone";
import { FolderEditChoice } from "./NewFromFolder";
import { NotificationPanel, NotificationToasts } from "./NotificationCenter";
import { DesktopPalette } from "./Palette";
import { ConfirmHost, ScreensWatcher } from "./ScreensToast";
import { setOverlay, toggleOverlay, useShellUi } from "./state";
import { DesktopStatusBar, JobsPanel } from "./StatusBar";
import { TitleBar, useWindowControls } from "./TitleBar";
import { WhatsNew } from "./WhatsNew";

const DESKTOP_PAGES = /^\/desktop\/panel\/(start|settings|welcome)(\/|$)/;

export function DesktopShellHost() {
  const d = desktop();
  if (!d?.shell || !d.appearance) return null;
  return <Host />;
}

function Host() {
  const d = desktop()!;
  const loc = useLocation();
  const nav = useNavigate();
  const { overlay } = useShellUi();
  const wco = useWindowControls();
  const search = new URLSearchParams(loc.search);
  const clean = search.get("clean") === "1";
  const editor = loc.pathname === "/editor/edit";
  const page = DESKTOP_PAGES.test(loc.pathname);
  const panel = loc.pathname.startsWith("/desktop/panel/") && !page;
  const pid = useMemo(() => Number(/^\/p\/(\d+)/.exec(loc.pathname)?.[1] ?? search.get("pid")) || null, [loc.pathname, loc.search]); // eslint-disable-line react-hooks/exhaustive-deps

  // appearance: once now, then on every change (one broadcast from the main process)
  useEffect(() => {
    let alive = true;
    void d.appearance!.get().then((s) => { if (alive) applyAppearance(s, { pinDark: panel }); }).catch(() => undefined);
    const off = d.appearance!.onChange((s) => applyAppearance(s, { pinDark: panel }));
    return () => { alive = false; off(); };
  }, [d, panel]);
  // the studio's own theme switch (top bar, palette) changes the desktop setting too, so every window follows
  const themePref = useThemePref();
  useEffect(() => {
    const last = appliedTheme();
    if (last && !panel && getThemePref() !== last) void d.appearance!.set({ theme: getThemePref() }).catch(() => undefined);
  }, [themePref, d, panel]);

  useBuiltinCommands(nav, pid);
  useEffect(() => { if (overlay === "palette") void refreshCommandData(); }, [overlay]);

  // menu actions and keys
  useEffect(() => {
    const off = d.app.onMenu((a) => {
      if (a === "command-palette") setOverlay("palette");
      else if (a === "notifications") toggleOverlay("notifications");
      else if (a === "shortcuts") setOverlay("shortcuts");
      else if (a === "whats-new") setOverlay("whatsnew");
    });
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyP") { e.preventDefault(); setOverlay("palette"); return; }
      // Ctrl+K and "?" only when the page doesn't use them itself (the studio's palette and sheet, the editor's Add edit)
      if (mod && !e.shiftKey && !e.altKey && e.code === "KeyK") {
        if (isClaimed("Ctrl+K")) return;
        setTimeout(() => { if (!e.defaultPrevented) setOverlay("palette"); }, 0);
        return;
      }
      if (!mod && !e.altKey && (e.key === "?" || (e.shiftKey && e.code === "Slash")) && !isTypingTarget(e.target)) {
        setTimeout(() => { if (!e.defaultPrevented && !document.querySelector('[role="dialog"][aria-modal="true"]')) setOverlay("shortcuts"); }, 0);
      }
    };
    window.addEventListener("keydown", key);
    return () => { off(); window.removeEventListener("keydown", key); };
  }, [d]);

  if (clean) return null;
  return (
    <>
      {wco.visible && <TitleBar paletteKey={editor ? "Ctrl+Shift+P" : "Ctrl+K"} />}
      {!editor && !panel && <DesktopStatusBar />}
      <DesktopPalette />
      <CheatSheet />
      <NotificationPanel />
      <JobsPanel />
      <NotificationToasts />
      <ScreensWatcher />
      <DropZone />
      <FolderEditChoice />
      <WhatsNew />
      <ConfirmHost />
    </>
  );
}
