import type { LucideIcon } from "lucide-react";
import { Bot, Clapperboard, Command, Film, Keyboard, LayoutGrid, MessageSquareText, PlayCircle, SearchX } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useT, useUiLanguage } from "../../lib/i18n";
import { useUI } from "../../lib/store";
import { Empty, Kbd, Modal, rise, SearchField } from "../ui";
import { isTypingTarget, MOD } from "./keys";

interface Item { keys: string[][]; label: string }
interface Group { id: string; title: string; icon: LucideIcon; items: Item[] }

/** Every keyboard shortcut in the app, grouped by where it works. Labels are literal t() calls for the i18n extractor. */
function useGroups(): Group[] {
  const t = useT();
  const lang = useUiLanguage();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo<Group[]>(() => [
    {
      id: "global", title: t("Everywhere"), icon: Command,
      items: [
        { keys: [[MOD, "K"]], label: t("Command palette — jump to any page, project or setting") },
        { keys: [[MOD, "J"]], label: t("Open the Director (inside a project)") },
        { keys: [["["]], label: t("Collapse or expand the pipeline rail") },
        { keys: [["?"]], label: t("Show keyboard shortcuts") },
        { keys: [["Esc"]], label: t("Close dialogs, drawers and menus") },
      ],
    },
    {
      id: "palette", title: t("Command palette"), icon: Keyboard,
      items: [
        { keys: [["↑"], ["↓"]], label: t("Move through the results") },
        { keys: [["Tab"], ["Shift", "Tab"]], label: t("Next / previous result") },
        { keys: [["↵"]], label: t("Run the selected result") },
      ],
    },
    {
      id: "director", title: t("Director"), icon: Bot,
      items: [
        { keys: [["Enter"]], label: t("Send a message to the Director") },
        { keys: [["Shift", "Enter"]], label: t("New line in the Director box") },
        { keys: [[MOD, "J"]], label: t("Jump to the Director box") },
      ],
    },
    {
      id: "storyboard", title: t("Storyboard"), icon: LayoutGrid,
      items: [
        { keys: [["←"], ["→"]], label: t("Previous / next shot (while a shot is open)") },
        { keys: [["A"]], label: t("Approve the open shot") },
        { keys: [["K"]], label: t("Generate a keyframe for the open shot") },
        { keys: [["V"]], label: t("Generate a video for the open shot") },
        { keys: [["Esc"]], label: t("Close the open shot") },
      ],
    },
    {
      id: "timeline", title: t("Timeline"), icon: Film,
      items: [
        { keys: [["Space"]], label: t("Play / pause") },
        { keys: [["J"], ["K"], ["L"]], label: t("Shuttle: reverse · pause · forward (press again to go faster)") },
        { keys: [["←"], ["→"]], label: t("Step one frame back / forward") },
        { keys: [["Shift", "←"], ["Shift", "→"]], label: t("Jump one second back / forward") },
        { keys: [["↑"], ["↓"]], label: t("Previous / next clip") },
        { keys: [["Home"], ["End"]], label: t("Go to the start / end") },
        { keys: [["+"], ["−"]], label: t("Zoom the timeline in / out") },
        { keys: [["\\"]], label: t("Fit the whole timeline in view") },
        { keys: [["S"]], label: t("Turn snapping on / off") },
      ],
    },
    {
      id: "player", title: t("Review player"), icon: PlayCircle,
      items: [
        { keys: [["Space"]], label: t("Play / pause") },
        { keys: [["J"], ["K"], ["L"]], label: t("Shuttle: reverse · pause · forward (press again to go faster)") },
        { keys: [["←"], ["→"]], label: t("Step one frame back / forward") },
        { keys: [["Shift", "←"], ["Shift", "→"]], label: t("Jump one second back / forward") },
        { keys: [["F"]], label: t("Full screen") },
        { keys: [["M"]], label: t("Mute / unmute") },
        { keys: [["Home"], ["End"]], label: t("Go to the start / end") },
      ],
    },
    {
      id: "review", title: t("Review & comments"), icon: MessageSquareText,
      items: [
        { keys: [["D"]], label: t("Draw on the current frame") },
        { keys: [["C"]], label: t("Write a comment") },
        { keys: [[MOD, "Z"]], label: t("Undo the last stroke") },
        { keys: [["Esc"]], label: t("Leave drawing mode") },
      ],
    },
    {
      id: "projects", title: t("Projects"), icon: Clapperboard,
      items: [
        { keys: [[MOD, "Enter"]], label: t("Start a new project from the concept box") },
      ],
    },
  ], [t, lang]);
}

function Keys({ combos }: { combos: string[][] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
      {combos.map((combo, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden className="text-2xs text-dim">/</span>}
          <span className="inline-flex items-center gap-0.5">
            {combo.map((k, j) => (
              <Fragment key={j}>
                {j > 0 && <span aria-hidden className="text-2xs text-dim">+</span>}
                <Kbd>{k}</Kbd>
              </Fragment>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** "?" sheet: every shortcut, grouped by area, with a filter. */
export function ShortcutsSheet() {
  const t = useT();
  const open = useUI((s) => s.shortcutsOpen);
  const setOpen = useUI((s) => s.setShortcutsOpen);
  const groups = useGroups();
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);

  // "/" jumps to the filter (like most keyboard-first apps)
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((it) => {
          const hay = `${g.title} ${it.label} ${it.keys.map((c) => c.join(" ")).join(" ")}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        }),
      }))
      .filter((g) => g.items.length);
  }, [groups, q]);

  return (
    <Modal open={open} onClose={() => { setOpen(false); setQ(""); }} title={t("Keyboard shortcuts")} size="lg">
      <div className="sticky -top-4 z-10 -mx-5 -mt-4 mb-4 bg-panel px-5 pb-3 pt-4">
        <SearchField
          ref={search}
          value={q}
          onChange={setQ}
          placeholder={t("Search shortcuts…")}
          aria-label={t("Search shortcuts…")}
          shortcut={<Kbd>/</Kbd>}
          data-autofocus
        />
      </div>

      {shown.length ? (
        <div className="columns-1 gap-x-10 md:columns-2">
          {shown.map((g, gi) => {
            const Icon = g.icon;
            return (
              <section key={g.id} className={`mb-6 break-inside-avoid ${rise(gi, "fade").className}`} style={rise(gi, "fade").style} aria-label={g.title}>
                <h4 className="mb-1 flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.12em] text-dim">
                  <span className="grid size-6 place-items-center rounded-md border border-line bg-raised text-mute"><Icon className="size-3.5" /></span>
                  {g.title}
                </h4>
                <ul className="divide-y divide-line/70">
                  {g.items.map((it) => (
                    <li key={it.label} className="flex items-start justify-between gap-4 py-2 text-sm">
                      <span className="min-w-0 text-mute">{it.label}</span>
                      <Keys combos={it.keys} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty icon={<SearchX className="size-6" />} title={t("No shortcut matches “{q}”", { q: q.trim() })} sub={t("Try a key (like J) or an action (like draw).")} />
      )}

      <p className="mt-2 flex items-start gap-2 border-t border-line pt-4 text-xs text-dim">
        <Keyboard className="mt-px size-3.5 shrink-0" />
        {t("Single-key shortcuts are ignored while you are typing in a text box.")}
      </p>
    </Modal>
  );
}
