import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { DesktopShellHost } from "../../desktop";
import { useUiStatus } from "../../desktop/bridge";
import { desktop, useDesktopInfo } from "../../lib/desktop";
import { useT } from "../../lib/i18n";
import { Button, Modal } from "../ui";

/**
 * Tatvam Desktop's menu actions that need the page (File → Finishing room settings, Help → Machine check, Help → About):
 * they open the open project's Finishing room, or the About box when no project is open. It also mounts the desktop
 * shell (frontend/src/desktop: title bar, status bar, palette, notifications, drops) in every signed-in window.
 * Renders nothing in a plain browser.
 */
export function DesktopMenu() {
  const t = useT();
  const nav = useNavigate();
  const loc = useLocation();
  const [about, setAbout] = useState(false);
  const pid = /^\/p\/(\d+)/.exec(loc.pathname)?.[1] ?? new URLSearchParams(loc.search).get("pid");

  useEffect(() => {
    const d = desktop();
    if (!d) return;
    return d.app.onMenu((action) => {
      if (action === "about") setAbout(true);
      else if (action === "open-settings" || action === "machine-check") {
        if (pid) nav(`/p/${pid}/finish${action === "machine-check" ? "#machine" : ""}`);
        else if (action === "open-settings") { if (d.shell) void d.shell.open("settings"); else void d.app.openConnection(); }
        else if (d.shell) nav("/desktop/panel/start#machine");
        else setAbout(true);
      } else if (action === "sync-now") toast.message(t("Open a project to sync its folder"));
      else if (action === "open-editor" || action === "open-edit") {
        // an open editor handles these itself (it asks about unsaved changes first)
        const ev = new CustomEvent("ed:desktop-menu", { detail: action, cancelable: true });
        if (!window.dispatchEvent(ev)) return;
        if (action === "open-editor") nav("/editor");
        else void d.editor?.open().then((r) => { if (r) nav(`/editor/edit?path=${encodeURIComponent(r.path)}`); }).catch((e) => toast.error(String((e as Error)?.message ?? e)));
      }
    });
  }, [nav, pid, t]);

  if (!desktop()) return null;
  return (
    <>
      <DesktopShellHost />
      <AboutBox open={about} onClose={() => setAbout(false)} />
    </>
  );
}

function AboutBox({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { data: info } = useDesktopInfo();
  const ui = useUiStatus();
  const d = desktop();
  return (
    <Modal open={open} onClose={onClose} title={t("Tatvam Studio")} size="sm"
      footer={<>
        <Button variant="ghost" onClick={() => void d?.app.openConnection()}>{t("Studio server…")}</Button>
        <Button onClick={onClose}>{t("Close")}</Button>
      </>}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-dim">{t("Version")}</dt><dd className="mono">{info?.appVersion ?? d?.version}{info && !info.packaged ? ` · ${t("dev")}` : ""}</dd>
        <dt className="text-dim">{t("Studio server")}</dt><dd className="mono break-all">{info?.serverUrl ?? "—"}</dd>
        {ui && <><dt className="text-dim">Screens</dt><dd>{ui.label}{ui.lastError ? <span className="block text-2xs text-amber-300">{ui.lastError}</span> : null}</dd></>}
        <dt className="text-dim">{t("Library folder")}</dt><dd className="mono break-all">{info?.libraryRoot ?? "—"}</dd>
        <dt className="text-dim">{t("This computer")}</dt><dd>{info?.machine ?? "—"}</dd>
      </dl>
      <p className="mt-3 text-2xs leading-relaxed text-dim">
        {t("The desktop finishing room: 4K renders on this machine's graphics card, the project folder, and several windows across your screens. AI work still runs on the studio server.")}
      </p>
    </Modal>
  );
}
