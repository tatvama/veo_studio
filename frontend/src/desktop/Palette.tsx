/**
 * The desktop command palette (Ctrl+K where the page doesn't use it, Ctrl+Shift+P everywhere): fuzzy search over every
 * registered command (navigation, recent edits and projects, windows and panels, the editor's actions with their keys,
 * settings, open file / folder), recently used ones first. Keyboard: ↑ ↓ Home End, Enter runs, Esc closes.
 */
import { clsx } from "clsx";
import { Command as CommandIcon, CornerDownLeft, Search, SearchX } from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "../components/ui";
import { allCommands, GROUP_ORDER, keyParts, pushRecent, rank, useCommandsVersion, type Command, type Ranked } from "./commands";
import { setOverlay, useShellUi } from "./state";

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const out: ReactNode[] = [];
  let run = "";
  let on = false;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on && run) { out.push(on ? <mark key={i}>{run}</mark> : <Fragment key={i}>{run}</Fragment>); run = ""; }
    on = hit;
    run += text[i];
  }
  if (run) out.push(on ? <mark key="end">{run}</mark> : <Fragment key="end">{run}</Fragment>);
  return <>{out}</>;
}

export function Keys({ binding, className }: { binding: string; className?: string }) {
  return (
    <span className={clsx("inline-flex shrink-0 items-center gap-0.5", className)}>
      {binding.split(" / ")[0].split(" ").map((chord, ci) => (
        <Fragment key={ci}>{keyParts(chord).map((k, i) => <Kbd key={`${ci}-${i}`}>{k}</Kbd>)}</Fragment>
      ))}
    </span>
  );
}

export function DesktopPalette() {
  const { overlay, paletteQuery } = useShellUi();
  const open = overlay === "palette";
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="desk-palette" className="desk-ui veo-backdrop fixed inset-0 z-[75] flex items-start justify-center px-4 pt-[12vh] backdrop-blur-[3px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}
          onMouseDown={() => setOverlay(null)}>
          <PaletteDialog initial={paletteQuery} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function PaletteDialog({ initial }: { initial: string }) {
  const reduce = useReducedMotionConfig();
  const version = useCommandsVersion();
  const [query, setQuery] = useState(initial);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cmds = useMemo(() => allCommands(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const ranked = useMemo(() => rank(cmds, query), [cmds, query]);

  // empty query: Recent first (up to 6), then each group's first few; typing: one flat ranked list, grouped in order
  const sections = useMemo(() => {
    const groups = new Map<string, Ranked[]>();
    if (!query.trim()) {
      const rec = ranked.filter((r) => r.recent).slice(0, 6);
      if (rec.length) groups.set("Recent", rec);
      const used = new Set(rec.map((r) => r.cmd.id));
      for (const g of GROUP_ORDER) {
        const rows = ranked.filter((r) => r.cmd.group === g && !used.has(r.cmd.id)).slice(0, g === "Editor" ? 6 : 5);
        if (rows.length) groups.set(g, rows);
      }
    } else {
      for (const r of ranked.slice(0, 60)) {
        const g = r.cmd.group;
        groups.set(g, [...(groups.get(g) ?? []), r]);
      }
      // keep the best section first
      return [...groups.entries()];
    }
    return [...groups.entries()];
  }, [ranked, query]);
  const flat = useMemo(() => sections.flatMap(([, rows]) => rows), [sections]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (c: Command) => {
    pushRecent(c.id);
    setOverlay(null);
    // after the palette has gone (its exit animation too: the editor ignores keys while a dialog is open), so editor
    // keys and dialogs land where they should
    let waited = 0;
    const go = () => {
      if (document.querySelector('[aria-label="Command palette"]') && waited < 1200) { waited += 40; setTimeout(go, 40); return; }
      void Promise.resolve(c.run()).catch(() => undefined);
    };
    setTimeout(go, 40);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "PageDown") { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 8)); }
    else if (e.key === "PageUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 8)); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setActive(flat.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); const c = flat[active]?.cmd; if (c) run(c); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOverlay(null); }
    else if (e.key === "Tab") e.preventDefault();
  };

  let idx = -1;
  return (
    <motion.div role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}
      initial={reduce ? false : { opacity: 0, y: -8, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.99 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      className="desk-palette w-full max-w-[640px] overflow-hidden rounded-2xl border border-line bg-panel shadow-modal">
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search className="size-4 shrink-0 text-dim" />
        <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
          role="combobox" aria-expanded="true" aria-controls="desk-palette-list" aria-activedescendant={flat[active] ? `desk-cmd-${active}` : undefined}
          placeholder="Search projects, edits, windows, editor actions and settings…" spellCheck={false}
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-dim focus-visible:!outline-none" />
        <Kbd>Esc</Kbd>
      </div>
      <div ref={list} id="desk-palette-list" role="listbox" aria-label="Commands" className="max-h-[min(60vh,520px)] overflow-y-auto overscroll-contain py-1.5">
        {flat.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-mute">
            <SearchX className="size-6 text-dim" />
            <p>Nothing matches "{query}".</p>
            <p className="text-2xs text-dim">Try a project, an edit, a panel name, or an editor action like "razor".</p>
          </div>
        ) : sections.map(([group, rows]) => (
          <div key={group} role="group" aria-label={group}>
            <p className="px-4 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wider text-dim">{group}</p>
            {rows.map((r) => {
              idx++;
              const i = idx;
              const c = r.cmd;
              return (
                <div key={c.id} id={`desk-cmd-${i}`} data-idx={i} role="option" aria-selected={i === active}
                  onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => run(c)}
                  className={clsx("mx-1.5 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm")}>
                  <span className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-raised text-mute">{c.icon ?? <CommandIcon className="size-3.5" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink"><Highlight text={c.title} indices={r.indices} /></span>
                    {c.hint && <span className="block truncate text-2xs text-dim">{c.hint}</span>}
                  </span>
                  {c.shortcut && <Keys binding={c.shortcut} />}
                  <CornerDownLeft className="row-enter size-3.5 shrink-0 text-dim" />
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-2xs text-dim">
        <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span className="flex items-center gap-1"><Kbd>Enter</Kbd> run</span>
        <span className="ml-auto flex items-center gap-1"><Keys binding="Ctrl+Shift+P" /> anywhere</span>
      </div>
    </motion.div>
  );
}
