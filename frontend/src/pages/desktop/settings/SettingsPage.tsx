/**
 * The Settings window (one window, File → Settings…, Ctrl+,): every desktop preference in sections — server and
 * screens, library and naming, rendering, AI tools on this PC, AI assistants, storage, appearance, notifications,
 * shortcuts, updates, advanced — with a search across all of them. `#section` in the address opens a section.
 */
import { clsx } from "clsx";
import { Search, SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { fuzzyScore } from "../../../components/shell/fuzzy";
import { Kbd } from "../../../components/ui";
import { ITEMS, SECTIONS } from "../../../desktop/settingsIndex";
import { AssistantBannerSlot } from "../../../desktop/AssistantBannerSlot";
import { DesktopPage } from "../DesktopPage";
import {
  AdvancedSection, AiToolsSection, AppearanceSection, AssistantsSection, LibrarySection, NotificationsSection, RenderingSection, ServerSection,
  ShortcutsSection, StorageSection, UpdatesSection,
} from "./sections";

const VIEWS: Record<string, () => React.JSX.Element> = {
  server: ServerSection, library: LibrarySection, rendering: RenderingSection, "ai-tools": AiToolsSection, assistants: AssistantsSection,
  storage: StorageSection, appearance: AppearanceSection, notifications: NotificationsSection, shortcuts: ShortcutsSection, updates: UpdatesSection,
  advanced: AdvancedSection,
};

function flash(itemId: string) {
  const el = document.getElementById(`i-${itemId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: document.documentElement.dataset.motion === "reduced" ? "auto" : "smooth", block: "center" });
  el.setAttribute("data-hit", "true");
  window.setTimeout(() => el.removeAttribute("data-hit"), 1600);
  el.querySelector<HTMLElement>("button, input, select, [role='switch']")?.focus({ preventScroll: true });
}

export default function SettingsPage() {
  const loc = useLocation();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(SECTIONS[0].id);
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const needle = q.trim();
    if (!needle) return [];
    const all = ITEMS.map((it) => {
      const sec = SECTIONS.find((s) => s.id === it.section)!;
      const m = fuzzyScore(needle, it.label, `${sec.title} ${it.keywords ?? ""}`);
      return m ? { it, sec, score: m.score } : null;
    }).filter((x): x is NonNullable<typeof x> => Boolean(x)).sort((a, b) => b.score - a.score);
    // a word that's really there beats letters scattered through other labels
    const best = all[0]?.score ?? 0;
    return (best >= 500 ? all.filter((r) => r.score >= 400) : all).slice(0, 12);
  }, [q]);
  useEffect(() => setCursor(0), [q]);

  const go = (section: string) => {
    setActive(section);
    document.getElementById(`s-${section}`)?.scrollIntoView({ behavior: document.documentElement.dataset.motion === "reduced" ? "auto" : "smooth", block: "start" });
  };
  // #section from the address (and later changes of it: the shell sets it when the window is already open)
  useEffect(() => {
    const h = () => {
      const id = location.hash.replace(/^#/, "");
      if (id && SECTIONS.some((s) => s.id === id)) setTimeout(() => go(id), 60);
    };
    h();
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, [loc.hash]);
  // scroll spy
  useEffect(() => {
    const root = scroller.current?.closest(".overflow-y-auto") ?? null;
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const id = top?.target.getAttribute("data-section");
      if (id) setActive(id);
    }, { root, rootMargin: "0px 0px -65% 0px" });
    document.querySelectorAll("[data-section]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  // Ctrl+F (and /) focus the search
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.code === "KeyF") || (e.key === "/" && !(e.target as HTMLElement)?.closest?.("input, textarea, select"))) { e.preventDefault(); search.current?.focus(); search.current?.select(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const pick = (r: { it: { id: string; section: string } }) => { setQ(""); go(r.it.section); setTimeout(() => flash(r.it.id), 350); };

  return (
    <DesktopPage title="Settings" wide>
      <AssistantBannerSlot />
      <div ref={scroller} className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <h1 className="mb-3 text-xl font-semibold tracking-tight">Settings</h1>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dim" />
            <input ref={search} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" aria-label="Search settings"
              aria-controls="settings-results" spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(results.length - 1, c + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
                else if (e.key === "Enter" && results[cursor]) { e.preventDefault(); pick(results[cursor]); }
                else if (e.key === "Escape") setQ("");
              }}
              className="h-9 w-full rounded-lg border border-line bg-panel pl-9 pr-10 text-sm placeholder:text-dim focus:border-accent/70 focus:outline-none focus:ring-[3px] focus:ring-accent/15 [&::-webkit-search-cancel-button]:hidden" />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2"><Kbd>Ctrl F</Kbd></span>
          </div>
          {q.trim() ? (
            <ul id="settings-results" role="listbox" aria-label="Matching settings" className="mt-2 space-y-0.5">
              {results.length === 0 && <li className="flex items-center gap-2 px-2 py-3 text-xs text-dim"><SearchX className="size-4" />No setting matches "{q}"</li>}
              {results.map((r, i) => (
                <li key={r.it.id} role="option" aria-selected={i === cursor}>
                  <button type="button" onClick={() => pick(r)} onMouseMove={() => setCursor(i)}
                    className={clsx("w-full rounded-lg px-2.5 py-1.5 text-left", i === cursor ? "bg-hover" : "hover:bg-hover")}>
                    <span className="block truncate text-sm">{r.it.label}</span>
                    <span className="block text-2xs text-dim">{r.sec.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <nav aria-label="Sections" className="mt-3">
              <ul className="space-y-0.5">
                {SECTIONS.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => go(s.id)} aria-current={active === s.id ? "true" : undefined}
                      className={clsx("relative w-full rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                        active === s.id ? "bg-hover font-medium text-ink" : "text-mute hover:bg-hover hover:text-ink")}>
                      {active === s.id && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
                      {s.title}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </aside>
        <div className="min-w-0 space-y-5">
          {SECTIONS.map((s) => { const V = VIEWS[s.id]; return V ? <V key={s.id} /> : null; })}
        </div>
      </div>
    </DesktopPage>
  );
}
