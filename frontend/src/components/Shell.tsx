import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Bell, Clapperboard, Command, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useMatch, useNavigate } from "react-router-dom";
import { ago } from "../lib/format";
import { useT } from "../lib/i18n";
import { useLiveEvents } from "../lib/live";
import { useApprovals, useNotifications, useProjects } from "../lib/queries";
import { useUI } from "../lib/store";
import type { UserBrief } from "../lib/types";
import { CommandPalette } from "./shell/CommandPalette";
import { isTypingTarget, MOD } from "./shell/keys";
import { getNav, type NavEntry, type NavGroup } from "./shell/nav";
import { OfflineBanner } from "./shell/OfflineBanner";
import { Onboarding } from "./shell/Onboarding";
import { PrefsSync } from "./shell/prefs";
import { ShortcutsSheet } from "./shell/ShortcutsSheet";
import { UserMenu } from "./shell/UserMenu";
import { IconButton, Kbd, Popover, Tooltip, useDocumentTitle } from "./ui";

const RAIL_W = 64;
const FULL_W = 248;
const SPRING = { type: "spring", stiffness: 420, damping: 38 } as const;

function useViewportWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    let raf = 0;
    const h = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setW(window.innerWidth)); };
    window.addEventListener("resize", h);
    return () => { window.removeEventListener("resize", h); cancelAnimationFrame(raf); };
  }, []);
  return w;
}

/** Thin accent bar under the top edge while a page's first data is loading. */
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
          <div className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-gradient-to-r from-accent via-accent-2 to-accent" style={{ animation: "bar-indeterminate 1.1s ease-in-out infinite" }} />
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

function NavItem({ entry, expanded, badge, onNavigate }: { entry: NavEntry; expanded: boolean; badge?: number; onNavigate?: () => void }) {
  const Icon = entry.icon;
  const link = (
    <NavLink
      to={entry.to}
      end={entry.to === "/"}
      aria-label={entry.label}
      data-tour={entry.tour}
      onClick={onNavigate}
      className={({ isActive }) => clsx(
        "group relative flex h-10 items-center rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
        expanded ? "gap-3 px-3" : "w-10 justify-center self-center",
        isActive ? "text-ink" : "text-mute hover:bg-hover hover:text-ink",
      )}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span layoutId="nav-active" transition={SPRING} className="absolute inset-0 rounded-xl bg-accent/12 ring-1 ring-inset ring-accent/20">
              <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-accent" />
            </motion.span>
          )}
          <Icon className={clsx("relative size-[18px] shrink-0 transition-transform duration-150 group-active:scale-90", isActive && "text-accent-ink")} />
          {expanded && <span className="relative min-w-0 flex-1 truncate text-sm font-medium">{entry.label}</span>}
          {!!badge && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className={clsx("flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-bold text-black",
                expanded ? "relative" : "absolute -right-0.5 -top-0.5")}
            >
              {badge}
            </motion.span>
          )}
        </>
      )}
    </NavLink>
  );
  return expanded ? link : <Tooltip content={entry.label} side="right">{link}</Tooltip>;
}

function projectHue(id: number) { return (id * 47) % 360; }

function RecentProjects({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const { data } = useProjects();
  const recent = (data ?? []).slice(0, 4);
  if (!recent.length) return null;
  return (
    <div className="mt-1 space-y-0.5">
      <p className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.12em] text-dim">{t("Recent")}</p>
      {recent.map((p) => (
        <NavLink
          key={p.id}
          to={`/p/${p.id}`}
          onClick={onNavigate}
          className={({ isActive }) => clsx("group flex h-8 items-center gap-2.5 rounded-lg px-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
            isActive ? "bg-hover text-ink" : "text-mute hover:bg-hover hover:text-ink")}
        >
          <span
            className="size-[18px] shrink-0 rounded-md bg-cover bg-center ring-1 ring-inset ring-white/10"
            style={{ backgroundImage: p.thumb_url ? `url(${p.thumb_url})` : `linear-gradient(135deg, oklch(0.62 0.14 ${projectHue(p.id)}), oklch(0.46 0.12 ${(projectHue(p.id) + 40) % 360}))` }}
          />
          <span className="min-w-0 flex-1 truncate text-[13px]">{p.title || t("Untitled")}</span>
        </NavLink>
      ))}
    </div>
  );
}

const GROUP_LABEL = (t: (s: string) => string): Record<NavGroup, string> => ({
  create: t("Create"), library: t("Library"), team: t("Team"), system: t("System"),
});

function Notifications({ expanded, placement }: { expanded: boolean; placement: "right-end" | "bottom-end" }) {
  const t = useT();
  const nav = useNavigate();
  const { data: notes } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const count = notes?.length ?? 0;
  const btn = (
    <button
      ref={ref}
      aria-label={t("Notifications")}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className={clsx(
        "group relative flex h-10 items-center rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
        expanded ? "w-full gap-3 px-3" : "w-10 justify-center self-center",
        open ? "bg-hover text-ink" : "text-mute hover:bg-hover hover:text-ink",
      )}
    >
      <Bell className={clsx("size-[18px] shrink-0", !!count && "origin-top group-hover:animate-[wiggle_0.5s_ease-in-out]")} />
      {expanded && <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{t("Notifications")}</span>}
      {!!count && (expanded
        ? <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-bold text-black">{count}</span>
        : <span className="absolute right-2 top-2 size-2 rounded-full bg-accent ring-2 ring-panel" />)}
    </button>
  );
  return (
    <>
      {expanded || open ? btn : <Tooltip content={t("Notifications")} side="right">{btn}</Tooltip>}
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement={placement} width={320} className="p-2">
        <p className="px-2 pb-2 pt-1 text-xs font-semibold text-mute">{t("Needs your attention")}</p>
        {!notes?.length && <p className="px-2 pb-3 text-sm text-dim">{t("All clear.")}</p>}
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {notes?.map((n) => (
            <button key={`${n.type}-${n.id}`} className="block w-full rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-hover"
              onClick={() => { setOpen(false); if (n.type === "approval") nav("/approvals"); else if (n.project_id) nav(`/p/${n.project_id}/storyboard`); }}>
              <span className="line-clamp-2">{n.text}</span>
              <span className="text-2xs text-dim">{n.type} · {ago(n.created_at)}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/** The navigation itself: used by the desktop rail (collapsed or expanded) and the mobile drawer. */
function SidebarBody({ user, expanded, onNavigate, onToggle, placement }: {
  user: UserBrief; expanded: boolean; onNavigate?: () => void; onToggle?: () => void; placement: "right-end" | "bottom-end";
}) {
  const t = useT();
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const { data: approvals } = useApprovals();
  const pendingCount = (approvals ?? []).filter((a) => a.can_decide).length;
  const entries = useMemo(() => getNav(t, user.role), [t, user.role]);
  const labels = GROUP_LABEL(t);
  const groups = (["create", "library", "team", "system"] as NavGroup[]).map((g) => ({ g, items: entries.filter((e) => e.group === g) })).filter((x) => x.items.length);

  const header = (
    <div className={clsx("flex items-center", expanded ? "gap-2.5 px-1" : "flex-col gap-2")}>
      <Link
        to="/"
        onClick={onNavigate}
        aria-label="VEO Studio"
        className="group relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-orange-400 to-orange-500 text-black shadow-md shadow-accent/25 outline-none transition-transform duration-200 hover:rotate-[-6deg] hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-95"
      >
        <Clapperboard className="size-5" />
      </Link>
      {expanded && (
        <>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[15px] font-semibold tracking-tight">VEO Studio</p>
            <p className="truncate text-2xs text-dim">{t("AI video studio")}</p>
          </div>
          {onToggle && <IconButton title={t("Collapse sidebar")} shortcut={<Kbd>[</Kbd>} tipSide="bottom" onClick={onToggle}><PanelLeftClose className="size-4" /></IconButton>}
        </>
      )}
    </div>
  );

  const palette = expanded ? (
    <button
      data-tour="palette"
      onClick={() => { onNavigate?.(); setPaletteOpen(true); }}
      className="group mt-3 flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-raised/60 px-2.5 text-left text-sm text-dim transition-colors hover:border-dim/40 hover:bg-hover hover:text-mute"
    >
      <Command className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t("Search or jump to…")}</span>
      <span className="flex gap-0.5"><Kbd>{MOD}</Kbd><Kbd>K</Kbd></span>
    </button>
  ) : (
    <Tooltip content={t("Command palette")} shortcut={<><Kbd>{MOD}</Kbd><Kbd>K</Kbd></>} side="right">
      <button
        data-tour="palette"
        aria-label={t("Command palette")}
        onClick={() => setPaletteOpen(true)}
        className="mt-3 flex size-10 items-center justify-center self-center rounded-xl text-mute outline-none transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <Command className="size-[18px]" />
      </button>
    </Tooltip>
  );

  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-3">
      {header}
      {palette}
      <nav aria-label={t("Main")} className="no-scrollbar mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        {groups.map(({ g, items }, gi) => (
          <div key={g} className="flex flex-col gap-0.5">
            {expanded
              ? <p className="px-3 pb-1 pt-4 text-2xs font-semibold uppercase tracking-[0.12em] text-dim">{labels[g]}</p>
              : gi > 0 && <div className="mx-auto my-2 h-px w-6 bg-line" />}
            {items.map((n) => (
              <NavItem key={n.to} entry={n} expanded={expanded} onNavigate={onNavigate} badge={n.badge === "approvals" ? pendingCount : undefined} />
            ))}
            {expanded && g === "create" && <RecentProjects onNavigate={onNavigate} />}
          </div>
        ))}
      </nav>
      <div className="mt-2 flex flex-col gap-0.5 border-t border-line pt-2">
        <Notifications expanded={expanded} placement={placement} />
        {!expanded && onToggle && (
          <Tooltip content={t("Expand sidebar")} shortcut={<Kbd>[</Kbd>} side="right">
            <button aria-label={t("Expand sidebar")} onClick={onToggle}
              className="flex size-10 items-center justify-center self-center rounded-xl text-mute outline-none transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50">
              <PanelLeftOpen className="size-[18px]" />
            </button>
          </Tooltip>
        )}
        <UserMenu user={user} expanded={expanded} placement={placement} />
      </div>
    </div>
  );
}

export function Shell({ user, children }: { user: UserBrief; children: ReactNode }) {
  const t = useT();
  const loc = useLocation();
  const pm = useMatch("/p/:pid/*");
  useLiveEvents(pm ? Number(pm.params.pid) : null);
  const width = useViewportWidth();
  const pref = useUI((s) => s.railExpanded);
  const setPref = useUI((s) => s.setRailExpanded);
  // Below ~1100px the sidebar stays a slim rail; "expand" then opens it as a slide-over instead of squeezing the page.
  const compact = width < 1100;
  const expanded = !compact && (pref ?? width >= 1440);
  const [drawer, setDrawer] = useState(false);
  const entries = useMemo(() => getNav(t, user.role), [t, user.role]);
  const toggle = () => (compact ? setDrawer(true) : setPref(!expanded));

  useEffect(() => setDrawer(false), [loc.pathname]);
  useEffect(() => { if (!compact && width >= 768) setDrawer(false); }, [compact, width]);

  // Global shortcuts: Ctrl/⌘+K palette, "?" shortcuts sheet, "[" sidebar.
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
      } else if (e.key === "[") {
        const s = useUI.getState();
        if (window.innerWidth < 1100) setDrawer(true);
        else s.setRailExpanded(!(s.railExpanded ?? window.innerWidth >= 1440));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div className="flex h-full flex-col md:flex-row">
      <a href="#main" className="sr-only z-[110] rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-black focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        {t("Skip to content")}
      </a>
      <TopProgress />
      <OfflineBanner />
      {!pm && <RouteTitle nav={entries} />}

      {/* Mobile top bar */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-panel px-2 md:hidden">
        <IconButton data-tour="menu" title={t("Menu")} onClick={() => setDrawer(true)}><MenuIcon className="size-5" /></IconButton>
        <Link to="/" className="flex items-center gap-2 px-1 text-[15px] font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-b from-orange-400 to-orange-500 text-black"><Clapperboard className="size-4" /></span>
          VEO Studio
        </Link>
        <div className="flex-1" />
        <IconButton data-tour="palette" title={t("Command palette")} onClick={() => useUI.getState().setPaletteOpen(true)}><Command className="size-[18px]" /></IconButton>
      </header>

      {/* Desktop sidebar */}
      <motion.aside
        data-tour-rail
        initial={false}
        animate={{ width: expanded ? FULL_W : RAIL_W }}
        transition={SPRING}
        className="relative z-30 hidden shrink-0 border-r border-line bg-panel md:block"
      >
        <SidebarBody user={user} expanded={expanded} onToggle={toggle} placement="right-end" />
      </motion.aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawer && (
          <motion.div key="drawer" className="fixed inset-0 z-[70]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <div className="veo-backdrop absolute inset-0 backdrop-blur-sm" onClick={() => setDrawer(false)} />
            <motion.div
              className="absolute inset-y-0 left-0 w-[284px] max-w-[86vw] border-r border-line bg-panel shadow-modal"
              initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }} transition={{ type: "spring", stiffness: 420, damping: 40 }}
            >
              <button aria-label={t("Close")} onClick={() => setDrawer(false)} className="absolute right-2 top-3 z-10 grid size-8 place-items-center rounded-lg text-mute hover:bg-hover hover:text-ink">
                <X className="size-4" />
              </button>
              <SidebarBody user={user} expanded onNavigate={() => setDrawer(false)} placement="bottom-end" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 outline-none">{children}</main>

      <PrefsSync />
      <CommandPalette user={user} />
      <ShortcutsSheet />
      <Onboarding />
    </div>
  );
}
