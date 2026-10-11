import { clsx } from "clsx";
import { useSyncExternalStore } from "react";
import { Link, useMatch } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import { useUI } from "../../lib/store";
import { Kbd } from "../ui";
import { MOD } from "./keys";
import { useTicker } from "./telemetry";

function useOnline() {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; },
    () => navigator.onLine,
    () => true,
  );
}

/** The bottom instrument strip: connection, engine mode, a live job ticker, and shortcut hints. Desktop only. */
export function StatusBar() {
  const t = useT();
  const online = useOnline();
  const { data } = useSettings();
  const { first, running, waiting } = useTicker();
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen);
  const setTrayOpen = useUI((s) => s.setTrayOpen);
  const inProject = !!useMatch("/p/:pid/*"); // a project has a job tray to open (it hides itself while idle)
  const modes = (data?.providers ?? []).filter((p) => p.engine !== false); // the asset library key runs no engine
  const live = modes.some((p) => p.mode === "live");
  const allMock = modes.length > 0 && !live;
  return (
    <footer className="mono relative z-30 hidden h-[var(--statusbar-h)] shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-2xs text-dim md:flex">
      <span className="flex items-center gap-1.5">
        <span className={clsx("live-dot", !online && "is-bad")} />
        <span className={online ? "text-mute" : "text-bad"}>{online ? t("Online") : t("Offline")}</span>
      </span>
      <Link to="/settings" className={clsx("flex items-center gap-1.5 transition-colors hover:text-ink", allMock && "text-warn")}>
        <span aria-hidden>◆</span>{live ? t("Live engines") : allMock ? t("Placeholder mode") : t("Engines")}
      </Link>
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
        <button type="button" disabled={!inProject} onClick={() => setTrayOpen(true)} title={inProject ? t("Open the job tray") : undefined}
          className="flex min-w-0 items-center gap-2 truncate transition-colors enabled:hover:text-ink disabled:cursor-default">
          {first ? (
            <>
              <span className="eq shrink-0" aria-hidden><i /><i /><i /><i /></span>
              <span className="truncate text-mute">{first.label || first.type}</span>
              <span className="text-accent-ink">{Math.round((first.progress || 0) * 100)}%</span>
              {running + waiting > 1 && <span>+{running + waiting - 1}</span>}
            </>
          ) : <span>{t("All systems idle")}</span>}
        </button>
      </span>
      <button onClick={() => setShortcutsOpen(true)} className="hidden items-center gap-1.5 transition-colors hover:text-ink lg:flex">
        <Kbd>?</Kbd>{t("shortcuts")}
      </button>
      <span className="hidden items-center gap-1 lg:flex"><Kbd>{MOD}</Kbd><Kbd>K</Kbd>{t("command")}</span>
      <span className="hidden xl:inline">TATVAM · v3</span>
    </footer>
  );
}
