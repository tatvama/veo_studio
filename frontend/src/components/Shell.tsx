import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useMatch } from "react-router-dom";
import { useT } from "../lib/i18n";
import { useMoneyShape, useRatesSync } from "../lib/currency";
import { useLiveEvents } from "../lib/live";
import { useUI } from "../lib/store";
import type { UserBrief } from "../lib/types";
import { CommandPalette } from "./shell/CommandPalette";
import { isTypingTarget } from "./shell/keys";
import { MobileNav } from "./shell/MobileNav";
import { getNav, type NavEntry } from "./shell/nav";
import { OfflineBanner } from "./shell/OfflineBanner";
import { Onboarding } from "./shell/Onboarding";
import { PrefsSync } from "./shell/prefs";
import { Rail } from "./shell/Rail";
import { ShortcutsSheet } from "./shell/ShortcutsSheet";
import { StatusBar } from "./shell/StatusBar";
import { TopBar } from "./shell/TopBar";
import { useDocumentTitle } from "./ui";

/** Thin cyan bar under the top edge while a page's first data is loading. */
function TopProgress() {
  const first = useIsFetching({ predicate: (q) => q.state.fetchStatus === "fetching" && q.state.data === undefined });
  const mutating = useIsMutating();
  const busy = first + mutating > 0;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!busy) { setShow(false); return; }
    const id = window.setTimeout(() => setShow(true), 180);
    return () => window.clearTimeout(id);
  }, [busy]);
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="top-progress"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.25 } }}
          className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden"
        >
          <div className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-gradient-to-r from-accent via-accent-2 to-accent shadow-[0_0_12px_var(--color-accent)]" style={{ animation: "bar-indeterminate 1.1s ease-in-out infinite" }} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Sets the tab title from the current top-level page (project pages set their own). */
function RouteTitle({ nav }: { nav: NavEntry[] }) {
  const { pathname } = useLocation();
  const current = nav.find((n) => (n.to === "/" ? pathname === "/" : pathname.startsWith(n.to)));
  useDocumentTitle(current && current.to !== "/" && current.label);
  return null;
}

/**
 * The cockpit: a top command bar, a slim rail (outside projects), the work area, a status strip, and (on phones) a bottom
 * tab bar. Nothing here scrolls: panels inside the work area do.
 */
export function Shell({ user, children }: { user: UserBrief; children: ReactNode }) {
  const t = useT();
  const pm = useMatch("/p/:pid/*");
  useLiveEvents(pm ? Number(pm.params.pid) : null);
  useRatesSync();
  const moneyShape = useMoneyShape(); // pages re-mount when the currency mode changes or the first rate arrives, so every figure re-renders
  const entries = useMemo(() => getNav(t, user.role), [t, user.role]);

  // Global shortcuts: Ctrl/⌘+K palette, "?" shortcuts sheet.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = useUI.getState();
        s.setPaletteOpen(!s.paletteOpen);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "?") {
        const s = useUI.getState();
        if (s.paletteOpen) return;
        e.preventDefault();
        s.setShortcutsOpen(!s.shortcutsOpen);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg">
      <a href="#main" className="sr-only z-[110] rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-black focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        {t("Skip to content")}
      </a>
      <TopProgress />
      <OfflineBanner />
      {!pm && <RouteTitle nav={entries} />}
      <TopBar user={user} />
      <div className="flex min-h-0 flex-1">
        {/* inside a project its own rail (or header) leads back out, so the global rail steps aside for the work */}
        {!pm && <Rail role={user.role} />}
        <main id="main" key={moneyShape} tabIndex={-1} className="min-h-0 min-w-0 flex-1 outline-none">{children}</main>
      </div>
      <StatusBar />
      <MobileNav user={user} />
      <PrefsSync />
      <CommandPalette user={user} />
      <ShortcutsSheet />
      <Onboarding />
    </div>
  );
}
