/**
 * The keyboard shortcut cheat sheet (Shift+/ wherever the page doesn't use that key itself; Help → Keyboard shortcuts),
 * built from the command registry: the desktop's own keys, plus the editor's action registry while an edit is open.
 */
import { Keyboard } from "lucide-react";
import { useMemo, useState } from "react";
import { Modal, SearchField } from "../components/ui";
import { allCommands, GROUP_ORDER, useCommandsVersion } from "./commands";
import { Keys } from "./Palette";
import { setOverlay, useShellUi } from "./state";

const WINDOW_KEYS: [string, string][] = [
  ["Ctrl+Shift+P", "Command palette (anywhere)"], ["Ctrl+K", "Command palette (where the page doesn't use Ctrl+K)"], ["Shift+/", "This cheat sheet"],
  ["Ctrl+,", "Settings"], ["Ctrl+Shift+H", "Start"], ["Alt+F", "File menu (Alt+E, Alt+V, Alt+W, Alt+H for the others)"], ["Ctrl+0", "Actual size"],
  ["Ctrl+Plus", "Zoom in (UI scale)"], ["Ctrl+-", "Zoom out (UI scale)"], ["Ctrl+Shift+E", "Editor"], ["Ctrl+Shift+O", "Open the project folder"],
  ["Ctrl+Shift+S", "Sync now"], ["Ctrl+Shift+M", "Program monitor to the next display"], ["Ctrl+Q", "Quit"],
];

export function CheatSheet() {
  const { overlay } = useShellUi();
  const open = overlay === "shortcuts";
  const version = useCommandsVersion();
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    if (!open) return [];
    const m = new Map<string, [string, string][]>();
    m.set("Window", WINDOW_KEYS);
    for (const c of allCommands()) {
      if (!c.shortcut || c.group === "Recent") continue;
      const g = c.group === "Editor" ? `Editor · ${c.hint ?? "Actions"}` : c.group;
      const list = m.get(g) ?? [];
      if (!list.some(([k, l]) => k === c.shortcut && l === c.title)) list.push([c.shortcut, c.title]);
      m.set(g, list);
    }
    const needle = q.trim().toLowerCase();
    const order = (g: string) => { const i = GROUP_ORDER.indexOf(g.split(" · ")[0] as never); return g === "Window" ? -1 : i < 0 ? 99 : i; };
    return [...m.entries()]
      .map(([g, rows]) => [g, needle ? rows.filter(([k, l]) => l.toLowerCase().includes(needle) || k.toLowerCase().includes(needle)) : rows] as const)
      .filter(([, rows]) => rows.length)
      .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
  }, [open, version, q]);
  return (
    <Modal open={open} onClose={() => { setOverlay(null); setQ(""); }} title={<span className="flex items-center gap-2"><Keyboard className="size-4" />Keyboard shortcuts</span>} size="xl">
      <div className="desk-ui space-y-4">
        <SearchField value={q} onChange={setQ} placeholder="Find a shortcut" data-autofocus aria-label="Find a shortcut" />
        <div className="columns-1 gap-6 sm:columns-2 lg:columns-3">
          {groups.map(([g, rows]) => (
            <section key={g} className="mb-5 break-inside-avoid">
              <p className="eyebrow mb-2">{g}</p>
              <dl className="space-y-1">
                {rows.map(([k, l]) => (
                  <div key={`${k}|${l}`} className="flex items-center justify-between gap-3 text-xs">
                    <dt className="min-w-0 truncate text-mute">{l}</dt>
                    <dd><Keys binding={k} /></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {!groups.length && <p className="text-sm text-mute">No shortcut matches "{q}".</p>}
        </div>
      </div>
    </Modal>
  );
}
