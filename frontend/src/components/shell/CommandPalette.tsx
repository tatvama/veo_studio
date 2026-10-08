import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Bot, Clapperboard, Compass, CornerDownLeft, FolderOpen, History, Keyboard, Languages, Layers, LayoutTemplate, LifeBuoy, LogOut, Monitor,
  Moon, PanelLeft, Plus, Search, SearchX, SlidersHorizontal, Sparkles, Sun, X, Zap, type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMatch, useNavigate } from "react-router-dom";
import { LANG_NAMES } from "../../lib/format";
import { UI_LANGUAGES, useT, useUiLanguage } from "../../lib/i18n";
import { useProjects } from "../../lib/queries";
import { useUI } from "../../lib/store";
import type { UserBrief } from "../../lib/types";
import { Kbd } from "../ui";
import { fuzzyScore } from "./fuzzy";
import { MOD, openDirector, sidebarExpanded, toggleSidebar, SIDEBAR_RAIL_MIN } from "./keys";
import { getNav, getProjectTabs } from "./nav";
import { usePrefActions } from "./prefs";
import { getTemplates } from "./templates";
import { nextTheme, useMotionPref, useResolvedTheme, useThemePref } from "./theme";
import { signOut } from "./UserMenu";

type GroupKey = "used" | "actions" | "project" | "recent" | "tabs" | "nav" | "templates" | "prefs" | "help" | "search";

interface Cmd {
  id: string;
  group: GroupKey;
  label: string;
  keywords?: string;
  icon: ReactNode;
  /** CSS background for a thumbnail tile (projects) instead of the icon. */
  swatch?: string;
  hint?: string;
  keys?: string[];
  run: () => void;
  /** Only listed when the user is typing (keeps the empty state short). */
  searchOnly?: boolean;
}

interface Row { cmd: Cmd; indices: number[]; score: number }
interface Section { key: GroupKey; label: string; icon: LucideIcon; rows: { row: Row; idx: number }[] }

const ORDER: GroupKey[] = ["actions", "project", "recent", "tabs", "nav", "templates", "prefs", "help"];
const EASE = [0.22, 1, 0.36, 1] as const;

// ── recently used commands (remembered per browser) ─────────────────────────
const RECENT_KEY = "veo-palette-recent";
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}
function pushRecent(id: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 8))); } catch { /* private mode */ }
}

function useIsPhone() {
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const h = () => setPhone(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return phone;
}

const projectHue = (id: number) => (id * 47) % 360;

export function CommandPalette({ user }: { user: UserBrief }) {
  const open = useUI((s) => s.paletteOpen);
  const setOpen = useUI((s) => s.setPaletteOpen);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="palette"
          className="veo-backdrop fixed inset-0 z-[70] flex items-start justify-center backdrop-blur-[3px] sm:px-4 sm:pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onMouseDown={() => setOpen(false)}
        >
          <PaletteDialog user={user} onClose={() => setOpen(false)} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function PaletteDialog({ user, onClose }: { user: UserBrief; onClose: () => void }) {
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const ui = useUI();
  const uiLang = useUiLanguage();
  const theme = useThemePref();
  const resolved = useResolvedTheme();
  const motionPref = useMotionPref();
  const prefs = usePrefActions(true);
  const reduce = useReducedMotionConfig();
  const phone = useIsPhone();
  const pm = useMatch("/p/:pid/*");
  const currentPid = pm ? Number(pm.params.pid) : null;
  const { data: projects } = useProjects();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recentIds] = useState(readRecent);
  const [listH, setListH] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the field now; give focus back to whatever had it when we close (unless a command moved it elsewhere).
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      const now = document.activeElement;
      if (!now || now === document.body || dialogRef.current?.contains(now)) previous?.focus?.({ preventScroll: true });
    };
  }, []);

  // Esc closes from anywhere inside the dialog, before other layers see it. Ctrl/⌘+J (the Director) also gets out of the way.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const groups = useMemo<Record<GroupKey, { label: string; icon: LucideIcon }>>(() => ({
    used: { label: t("Recently used"), icon: History },
    actions: { label: t("Actions"), icon: Zap },
    project: { label: t("This project"), icon: Clapperboard },
    recent: { label: t("Recent projects"), icon: FolderOpen },
    tabs: { label: t("Project pages"), icon: Layers },
    nav: { label: t("Go to"), icon: Compass },
    templates: { label: t("Templates"), icon: LayoutTemplate },
    prefs: { label: t("Preferences"), icon: SlidersHorizontal },
    help: { label: t("Help"), icon: LifeBuoy },
    search: { label: t("Search"), icon: Search },
  }), [t, uiLang]);

  const commands = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => nav(to);
    const out: Cmd[] = [];
    const tabs = getProjectTabs(t);
    const recent = (projects ?? []).slice(0, 12);
    const current = recent.find((p) => p.id === currentPid) ?? (projects ?? []).find((p) => p.id === currentPid);
    const swatch = (p: { id: number; thumb_url?: string }) => p.thumb_url
      ? `url(${p.thumb_url}) center / cover`
      : `linear-gradient(135deg, oklch(0.62 0.14 ${projectHue(p.id)}), oklch(0.46 0.12 ${(projectHue(p.id) + 40) % 360}))`;

    // Actions
    out.push({ id: "new", group: "actions", label: t("New project"), keywords: "create start concept", icon: <Plus className="size-4" />, run: go("/?new=1") });
    if (currentPid) {
      out.push({ id: "director", group: "actions", label: t("Open Director"), keywords: "agent ai chat assistant", icon: <Bot className="size-4" />,
        keys: [MOD, "J"], run: () => openDirector() });
    }
    if (window.innerWidth >= SIDEBAR_RAIL_MIN) {
      out.push({ id: "sidebar", group: "actions", label: sidebarExpanded() ? t("Collapse sidebar") : t("Expand sidebar"), keywords: "menu navigation rail panel",
        icon: <PanelLeft className="size-4" />, keys: ["["], run: () => { toggleSidebar(); } });
    }

    // This project
    if (current) {
      tabs.forEach((tab) => out.push({
        id: `cur-${tab.to}`, group: "project", label: tab.label, hint: current.title, keywords: tab.keywords,
        icon: <tab.icon className="size-4" />, run: go(`/p/${current.id}/${tab.to}`),
      }));
    }

    // Recent projects (+ their pages while searching)
    recent.forEach((p, i) => {
      out.push({
        id: `p-${p.id}`, group: "recent", label: p.title || t("Untitled"), hint: p.type, keywords: p.concept?.slice(0, 120),
        icon: <FolderOpen className="size-4" />, swatch: swatch(p), run: go(`/p/${p.id}/storyboard`), searchOnly: i >= 5,
      });
      tabs.forEach((tab) => out.push({
        id: `p-${p.id}-${tab.to}`, group: "tabs", label: `${p.title || t("Untitled")} › ${tab.label}`, keywords: tab.keywords,
        icon: <tab.icon className="size-4" />, run: go(`/p/${p.id}/${tab.to}`), searchOnly: true,
      }));
    });

    // Navigation
    getNav(t, user.role).forEach((n) => out.push({
      id: `nav-${n.to}`, group: "nav", label: n.label, keywords: n.keywords, icon: <n.icon className="size-4" />, run: go(n.to),
    }));

    // Templates
    getTemplates(t).forEach((tpl) => out.push({
      id: `tpl-${tpl.id}`, group: "templates", label: `${t("New from template")}: ${tpl.label}`, keywords: `template ${tpl.blurb}`,
      icon: <LayoutTemplate className="size-4" />, run: go(`/?template=${tpl.id}`), searchOnly: true,
    }));

    // Preferences
    const toLight = resolved === "dark";
    out.push({
      id: "theme-toggle", group: "prefs", label: toLight ? t("Switch to light theme") : t("Switch to dark theme"),
      keywords: "theme dark light mode appearance colour", icon: toLight ? <Sun className="size-4" /> : <Moon className="size-4" />,
      run: () => prefs.setTheme(toLight ? "light" : "dark"),
    });
    if (theme !== "system") {
      out.push({ id: "theme-system", group: "prefs", label: t("Use system theme"), keywords: "theme auto os appearance",
        icon: <Monitor className="size-4" />, run: () => prefs.setTheme("system"), searchOnly: true });
    } else {
      out.push({ id: "theme-cycle", group: "prefs", label: t("Stop following system theme"), keywords: "theme appearance",
        icon: <Moon className="size-4" />, run: () => prefs.setTheme(nextTheme("system")), searchOnly: true });
    }
    Object.entries(UI_LANGUAGES).forEach(([code, name]) => {
      if (code === uiLang) return;
      out.push({
        id: `lang-${code}`, group: "prefs", label: `${t("Interface language")}: ${name}`,
        keywords: `language ui ${LANG_NAMES[code] ?? ""} ${code}`, icon: <Languages className="size-4" />,
        run: () => prefs.setLanguage(code),
        // English stays visible as an escape hatch for anyone who can't read the current language
        searchOnly: !(code === "en" && uiLang !== "en"),
      });
    });
    out.push({
      id: "motion", group: "prefs", label: motionPref === "reduced" ? t("Turn animations back on") : t("Reduce motion"),
      keywords: "animation motion accessibility", icon: <Sparkles className="size-4" />,
      run: () => prefs.setMotion(motionPref === "reduced" ? "full" : "reduced"), searchOnly: true,
    });

    // Help
    out.push({ id: "tour", group: "help", label: t("Start the onboarding tour"), keywords: "help guide intro walkthrough tutorial",
      icon: <Compass className="size-4" />, run: () => ui.startTour() });
    out.push({ id: "shortcuts", group: "help", label: t("Keyboard shortcuts"), keywords: "keys hotkeys help", icon: <Keyboard className="size-4" />,
      keys: ["?"], run: () => ui.setShortcutsOpen(true) });
    out.push({ id: "signout", group: "help", label: t("Sign out"), keywords: "logout log out exit", icon: <LogOut className="size-4" />,
      run: () => { void signOut(qc); }, searchOnly: true });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, uiLang, projects, currentPid, user.role, resolved, theme, motionPref]);

  const q = query.trim();

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    let idx = 0;
    const push = (key: GroupKey, rows: Row[]) => {
      if (!rows.length) return;
      out.push({ key, label: groups[key].label, icon: groups[key].icon, rows: rows.map((row) => ({ row, idx: idx++ })) });
    };
    if (!q) {
      const used = recentIds.map((id) => commands.find((c) => c.id === id)).filter((c): c is Cmd => !!c).slice(0, 4);
      const usedIds = new Set(used.map((c) => c.id));
      push("used", used.map((cmd) => ({ cmd, indices: [], score: 0 })));
      for (const g of ORDER) {
        push(g, commands.filter((c) => c.group === g && !c.searchOnly && !usedIds.has(c.id)).map((cmd) => ({ cmd, indices: [], score: 0 })));
      }
      return out;
    }
    const byGroup = new Map<GroupKey, Row[]>();
    for (const cmd of commands) {
      const m = fuzzyScore(q, cmd.label, `${cmd.keywords ?? ""} ${cmd.hint ?? ""} ${groups[cmd.group].label}`);
      if (!m) continue;
      const boost = recentIds.indexOf(cmd.id);
      const row: Row = { cmd, indices: m.indices, score: m.score + (boost >= 0 ? 40 - boost * 5 : 0) };
      const list = byGroup.get(cmd.group) ?? [];
      list.push(row);
      byGroup.set(cmd.group, list);
    }
    // groups ordered by their best hit; noisy groups are capped; 40 rows at most
    const ranked = [...byGroup.entries()]
      .map(([key, rows]) => [key, rows.sort((a, b) => b.score - a.score).slice(0, 7)] as const)
      .sort((a, b) => b[1][0].score - a[1][0].score);
    let budget = 40;
    for (const [key, rows] of ranked) {
      const take = rows.slice(0, budget);
      budget -= take.length;
      push(key, take);
      if (budget <= 0) break;
    }
    return out;
  }, [q, commands, groups, recentIds]);

  const searchRow: Row | null = q ? {
    cmd: {
      id: "search-all", group: "search", label: t("Search everything for “{q}”", { q }), icon: <Search className="size-4" />,
      run: () => nav(`/search?q=${encodeURIComponent(q)}`),
    },
    indices: [], score: -1,
  } : null;

  const allSections = useMemo<Section[]>(() => {
    if (!searchRow) return sections;
    const idx = sections.reduce((n, s) => n + s.rows.length, 0);
    return [...sections, { key: "search", label: groups.search.label, icon: groups.search.icon, rows: [{ row: searchRow, idx }] }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, q, groups]);

  const flat = useMemo(() => allSections.flatMap((s) => s.rows.map((r) => r.row)), [allSections]);
  const noHits = !!q && sections.length === 0;
  const hitCount = sections.reduce((n, s) => n + s.rows.length, 0);
  const countLabel = hitCount === 1 ? t("1 result") : t("{n} results", { n: hitCount });

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { if (active >= flat.length) setActive(Math.max(0, flat.length - 1)); }, [flat.length, active]);

  // Keep the active row visible (the sticky group label needs room above it).
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    if (active === 0) { sc.scrollTop = 0; return; }
    sc.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, q]);

  // The list's height follows its content (springy) while the dialog stays anchored at the top.
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setListH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const run = (row: Row | undefined) => {
    if (!row) return;
    if (row.cmd.id !== "search-all") pushRecent(row.cmd.id);
    onClose();
    // let the palette start closing before navigating / opening other overlays
    setTimeout(() => row.cmd.run(), 10);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const n = flat.length;
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); if (n) setActive((a) => (a + 1) % n); }
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); if (n) setActive((a) => (a - 1 + n) % n); }
    else if (e.key === "PageDown") { e.preventDefault(); setActive((a) => Math.min(n - 1, a + 6)); }
    else if (e.key === "PageUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 6)); }
    else if (e.key === "Enter") { e.preventDefault(); run(flat[active]); }
  };

  const maxList = Math.round(Math.min(460, window.innerHeight * 0.6));
  const targetH = phone ? undefined : listH === null ? "auto" : Math.min(listH, maxList);

  return (
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("Command palette")}
      initial={{ opacity: 0, scale: phone ? 1 : 0.97, y: phone ? 28 : -10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: phone ? 1 : 0.98, y: phone ? 20 : -6 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="flex w-full max-w-[40rem] flex-col overflow-hidden border-line bg-panel shadow-modal max-sm:h-full max-sm:max-w-none sm:rounded-2xl sm:border"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 max-sm:pt-[max(env(safe-area-inset-top),0px)]">
        <Search className={clsx("size-5 shrink-0 transition-colors duration-150", q ? "text-accent-ink" : "text-dim")} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={t("Type a command, page or project…")}
          aria-label={t("Command palette")}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          className="h-14 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-dim"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="palette-list"
          aria-activedescendant={flat[active] ? `palette-${flat[active].cmd.id}` : undefined}
        />
        <AnimatePresence initial={false}>
          {query && (
            <motion.button
              key="clear"
              type="button"
              aria-label={t("Clear")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.12 }}
              className="grid size-7 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink"
            >
              <X className="size-4" />
            </motion.button>
          )}
        </AnimatePresence>
        <span className="hidden sm:block"><Kbd>Esc</Kbd></span>
        <button type="button" onClick={onClose} className="rounded-md px-1 py-2 text-sm font-medium text-accent-ink sm:hidden">{t("Cancel")}</button>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {noHits ? t("Nothing found.") : countLabel}
      </p>

      <motion.div
        initial={false}
        animate={targetH === undefined ? undefined : { height: targetH }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 44, mass: 0.7 }}
        className={clsx("min-h-0 overflow-hidden", phone && "flex-1")}
      >
        <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain scroll-pb-2 scroll-pt-9">
          <div ref={innerRef} className="px-2 pb-2">
            {noHits && (
              <div className="flex flex-col items-center px-6 pb-3 pt-9 text-center">
                <span className="mb-3 grid size-11 place-items-center rounded-2xl border border-line bg-raised text-dim"><SearchX className="size-5" /></span>
                <p className="text-sm font-medium text-ink">{t("Nothing found for “{q}”", { q })}</p>
                <p className="mt-1 text-xs text-mute">{t("Press Enter to search everything for it.")}</p>
              </div>
            )}
            <motion.div
              key={q ? "results" : "home"}
              id="palette-list"
              role="listbox"
              aria-label={t("Results")}
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.12 }}
            >
              {allSections.map((s) => {
                const GroupIcon = s.icon;
                return (
                  <section key={s.key} role="group" aria-label={s.label} className="pb-1">
                    <div aria-hidden className="sticky top-0 z-10 flex items-center gap-1.5 bg-panel px-2 pb-1.5 pt-3 text-2xs font-semibold uppercase tracking-[0.12em] text-dim">
                      <GroupIcon className="size-3.5" />
                      {s.label}
                    </div>
                    {s.rows.map(({ row, idx }) => {
                      const on = idx === active;
                      const c = row.cmd;
                      return (
                        <button
                          key={c.id}
                          id={`palette-${c.id}`}
                          data-idx={idx}
                          role="option"
                          aria-selected={on}
                          tabIndex={-1}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseMove={() => { if (!on) setActive(idx); }}
                          onClick={() => run(row)}
                          className={clsx("relative flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left text-sm transition-colors max-sm:py-2.5", on ? "text-ink" : "text-mute")}
                        >
                          {on && (
                            <motion.span layoutId="palette-active" transition={{ type: "spring", stiffness: 700, damping: 46 }}
                              className="absolute inset-0 rounded-xl bg-hover ring-1 ring-line" />
                          )}
                          <span
                            className={clsx("relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border transition-colors duration-150",
                              c.swatch ? "border-line" : on ? "border-accent/30 bg-accent/12 text-accent-ink" : "border-line bg-raised text-dim")}
                            style={c.swatch ? { background: c.swatch } : undefined}
                          >
                            {!c.swatch && c.icon}
                          </span>
                          <span className="relative min-w-0 flex-1 truncate"><Highlight text={c.label} indices={row.indices} /></span>
                          {c.hint && <span className="relative max-w-[40%] shrink-0 truncate text-xs capitalize text-dim">{c.hint}</span>}
                          {c.keys && <span className="relative flex shrink-0 gap-0.5">{c.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>}
                          {on && !c.keys && <CornerDownLeft className="relative size-3.5 shrink-0 text-dim" />}
                        </button>
                      );
                    })}
                  </section>
                );
              })}
            </motion.div>
          </div>
        </div>
      </motion.div>

      <div className="hidden shrink-0 items-center gap-4 border-t border-line bg-raised/40 px-4 py-2 text-2xs text-dim sm:flex">
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t("navigate")}</span>
        <span className="flex items-center gap-1.5"><Kbd>↵</Kbd>{t("open")}</span>
        <span className="flex items-center gap-1.5"><Kbd>Esc</Kbd>{t("close")}</span>
        <span className="ml-auto truncate tabular-nums">
          {q ? (noHits ? t("No matches") : countLabel) : t("Type to search projects, pages and settings")}
        </span>
      </div>
    </motion.div>
  );
}

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const parts: ReactNode[] = [];
  let buf = "";
  let mark = false;
  const flush = (k: number) => {
    if (!buf) return;
    parts.push(mark ? <mark key={k} className="bg-transparent font-semibold text-accent-ink">{buf}</mark> : <span key={k}>{buf}</span>);
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== mark) { flush(i); mark = m; }
    buf += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}
