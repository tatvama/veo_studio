/**
 * The custom title bar (desktop shell): drawn into the strip the main process keeps above the page, next to the
 * system window buttons (Windows draws those, so snap layouts keep working). The app menus open the native menus;
 * the search box opens the command palette; a pill shows an update downloading, ready ("Restart to update to 3.2.0")
 * or failed (Retry).
 */
import { clsx } from "clsx";
import { ArrowUpCircle, CloudOff, Download, RotateCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Tooltip } from "../components/ui";
import { desktop } from "../lib/desktop";
import { useOfflineStatus, useUpdate } from "./bridge";
import { Keys } from "./Palette";
import { reloadGuardsThen } from "./ScreensToast";
import { setOverlay } from "./state";

const MENUS = ["File", "Edit", "View", "Window", "Help"];
/** A label baked into a test or preview build of the screens (VITE_TATVAM_BUILD_LABEL at build time), shown in the title bar. */
const BUILD_LABEL = String(import.meta.env.VITE_TATVAM_BUILD_LABEL ?? "");

/** Is this window drawn with the custom title bar (Window Controls Overlay)? */
export function useWindowControls(): { visible: boolean; rect: DOMRect | null } {
  const wco = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void } }).windowControlsOverlay;
  const read = () => ({ visible: Boolean(wco?.visible), rect: wco?.visible ? wco.getTitlebarAreaRect() : null });
  const [s, setS] = useState(read);
  useEffect(() => {
    if (!wco) return;
    const on = () => setS(read());
    wco.addEventListener("geometrychange", on);
    const t = window.setTimeout(on, 200); // after the first layout
    return () => { wco.removeEventListener("geometrychange", on); window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return s;
}

function useDocTitle(): string {
  const [t, setT] = useState(document.title);
  useEffect(() => {
    const el = document.querySelector("title");
    if (!el) return;
    const mo = new MutationObserver(() => setT(document.title));
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return t;
}

function useFocused(): boolean {
  const [f, setF] = useState(document.hasFocus());
  useEffect(() => {
    const on = () => setF(true), off = () => setF(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => { window.removeEventListener("focus", on); window.removeEventListener("blur", off); };
  }, []);
  return f;
}

function UpdatePill() {
  const u = useUpdate();
  const d = desktop();
  if (!u || !d) return null;
  if (u.state === "downloading" || u.state === "available") {
    return (
      <Tooltip content="The update downloads in the background" side="bottom">
        <span className="tb-pill border border-accent/30 bg-accent/10 text-accent-ink" role="status">
          <Download className="size-3.5" />Downloading {u.version ?? "update"}{u.progress ? ` · ${Math.round(u.progress * 100)}%` : ""}
        </span>
      </Tooltip>
    );
  }
  if (u.state === "ready") {
    return (
      <Tooltip content="Saves open edits, then restarts into the new version" side="bottom">
        <button type="button" className="tb-pill bg-accent text-black hover:brightness-110"
          onClick={() => void reloadGuardsThen(() => { void d.app.installUpdate?.(); })}>
          <ArrowUpCircle className="size-3.5" />Restart to update to {u.version}
        </button>
      </Tooltip>
    );
  }
  if (u.state === "error") {
    return (
      <Tooltip content={u.error ?? "The update failed"} side="bottom">
        <button type="button" className="tb-pill border border-bad/30 bg-bad/10 text-red-300"
          onClick={() => void d.app.checkForUpdates().then((s) => { if (s.state === "error") toast.error(`Update: ${s.error ?? "failed again"}`); })}>
          <RotateCw className="size-3.5" />Update failed · Retry
        </button>
      </Tooltip>
    );
  }
  return null;
}

export function TitleBar({ paletteKey = "Ctrl+K" }: { paletteKey?: string }) {
  const d = desktop();
  const title = useDocTitle();
  const focused = useFocused();
  const offline = useOfflineStatus();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const popup = (name: string) => {
    const el = refs.current[name];
    if (!el || !d?.shell) return;
    const r = el.getBoundingClientRect();
    setOpenMenu(name);
    void d.shell.popupMenu(name, r.left, r.bottom).finally(() => setOpenMenu(null));
  };
  // Alt+F, Alt+E … open the menus (the native menu bar is hidden with the custom title bar)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
      const m = MENUS.find((x) => e.code === `Key${x[0]}`);
      if (m && !e.defaultPrevented) { e.preventDefault(); popup(m); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const cleanTitle = title.replace(/\s*[—·-]\s*Tatvam (AI )?Studio$/i, "");
  return (
    <header className={clsx("desk-ui desk-titlebar", !focused && "blurred")} aria-label="Title bar">
      <span className="mr-1 grid size-5 shrink-0 place-items-center rounded-[5px] bg-gradient-to-br from-accent to-accent-2 text-[10px] font-black text-black" aria-hidden>T</span>
      <nav className="flex items-center" aria-label="Menus">
        {MENUS.map((m) => (
          <button key={m} type="button" ref={(el) => { refs.current[m] = el; }} className="tb-menu" aria-haspopup="menu" aria-expanded={openMenu === m}
            onClick={() => popup(m)} title={`${m} menu (Alt+${m[0]})`}>{m}</button>
        ))}
      </nav>
      <span className="tb-title" title={title}>{cleanTitle || "Tatvam Studio"}</span>
      {BUILD_LABEL && <span className="tb-pill border border-ai/30 bg-ai/10 text-ai" title="A labelled build of the screens (VITE_TATVAM_BUILD_LABEL)">{BUILD_LABEL}</span>}
      {offline && !offline.online && (
        <Tooltip content={offline.queued ? `${offline.queued} edit${offline.queued === 1 ? "" : "s"} wait to be sent` : "The studio server can't be reached"} side="bottom">
          <span className="tb-pill border border-warn/30 bg-warn/10 text-amber-300"><CloudOff className="size-3.5" />Offline{offline.queued ? ` · ${offline.queued}` : ""}</span>
        </Tooltip>
      )}
      <UpdatePill />
      <button type="button" className="tb-search ml-1" onClick={() => setOverlay("palette")} aria-label={`Search or run a command (${paletteKey})`}>
        <Search className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search or run a command</span>
        <Keys binding={paletteKey} className="opacity-80" />
      </button>
    </header>
  );
}
