/**
 * The Keyboard Shortcuts editor (editor-motion): every action with its keys, the Premiere / Resolve / Final Cut
 * presets, conflicts shown in place (and a one-click "move the key here"), search, per-action reset, and export /
 * import as JSON. Saved in this browser (keymap.ts).
 */
import { clsx } from "clsx";
import { AlertTriangle, Download, Keyboard, Plus, RotateCcw, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Modal } from "../components/ui";
import { keyName, setKeySettings, useKeySettings } from "./keymap";
import { actionById, exportKeys, findConflicts, importKeys, KEY_ACTIONS, KEY_PRESETS, resetKeys, resolveBindings, setKeys, type KeyPreset } from "./model/keybindings";
import { kbd } from "./ui";

export function ShortcutEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const st = useKeySettings();
  const [q, setQ] = useState("");
  const [rec, setRec] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: string; key: string; owner: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const bindings = useMemo(() => resolveBindings(st), [st]);
  const conflicts = useMemo(() => findConflicts(bindings), [bindings]);
  const clash = useMemo(() => new Set(conflicts.flatMap((c) => c.actions.map((a) => `${a}|${c.key}`))), [conflicts]);
  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const out = new Map<string, typeof KEY_ACTIONS>();
    for (const a of KEY_ACTIONS) {
      if (ql && !a.label.toLowerCase().includes(ql) && !(bindings[a.id] ?? []).some((k) => k.toLowerCase().includes(ql)) && !a.group.toLowerCase().includes(ql)) continue;
      out.set(a.group, [...(out.get(a.group) ?? []), a]);
    }
    return [...out.entries()];
  }, [q, bindings]);

  // recording a key: the next key press (Esc cancels; modifiers alone wait)
  useEffect(() => {
    if (!rec) return;
    const down = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") { setRec(null); return; }
      const k = keyName(e);
      const owner = Object.entries(bindings).find(([id, ks]) => id !== rec && ks.includes(k))?.[0];
      const mine = bindings[rec] ?? [];
      if (owner) setPending({ action: rec, key: k, owner });
      else setKeySettings(setKeys(st, rec, [...mine, k]));
      setRec(null);
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, [rec, bindings, st]);

  const removeKey = (id: string, k: string) => setKeySettings(setKeys(st, id, (bindings[id] ?? []).filter((x) => x !== k)));
  const download = () => {
    const blob = new Blob([exportKeys(st)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tatvam-shortcuts-${st.preset}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try { setKeySettings(importKeys(await f.text())); toast.success("Keyboard shortcuts imported"); } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <Modal open={open} onClose={() => { if (!rec) onClose(); }} title={<span className="flex items-center gap-2"><Keyboard className="size-4" />Keyboard shortcuts</span>} size="xl"
      footer={<div className="flex w-full items-center gap-2">
        <Button variant="ghost" size="sm" icon={<Download className="size-3.5" />} onClick={download}>Export JSON</Button>
        <Button variant="ghost" size="sm" icon={<Upload className="size-3.5" />} onClick={() => file.current?.click()}>Import JSON</Button>
        <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        <Button variant="ghost" size="sm" icon={<RotateCcw className="size-3.5" />} className="ml-auto" onClick={() => setKeySettings(resetKeys(st))}>Reset to the preset</Button>
        <Button variant="primary" size="sm" onClick={onClose}>Done</Button>
      </div>}>
      <div className="ed-keys flex flex-col gap-3 text-xs" data-testid="shortcut-editor">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-mute">Preset
            <select className="ed-field" value={st.preset} onChange={(e) => setKeySettings({ preset: e.target.value as KeyPreset, custom: {} })}>
              {KEY_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <input className="ed-field w-56" placeholder="Search actions or keys…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <span className="ml-auto text-2xs text-dim">{Object.keys(st.custom).length ? `${Object.keys(st.custom).length} changed from the preset` : "As the preset"}</span>
        </div>
        {conflicts.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-amber-200">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div>{conflicts.length} key{conflicts.length === 1 ? " is" : "s are"} on two actions — the first one listed wins until you fix it:{" "}
              {conflicts.map((c) => <span key={c.key} className="mr-2 whitespace-nowrap"><b className="mono">{kbd(c.key)}</b> ({c.actions.map((a) => actionById(a)?.label).join(" · ")})</span>)}
            </div>
          </div>
        )}
        {pending && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2">
            <span><b className="mono">{kbd(pending.key)}</b> is used by <b>{actionById(pending.owner)?.label}</b>.</span>
            <Button size="sm" variant="primary" onClick={() => { setKeySettings(setKeys(st, pending.action, [...(bindings[pending.action] ?? []), pending.key], { steal: true })); setPending(null); }}>Move it to {actionById(pending.action)?.label}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setKeySettings(setKeys(st, pending.action, [...(bindings[pending.action] ?? []), pending.key])); setPending(null); }}>Keep both (conflict)</Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
          </div>
        )}
        <div className="max-h-[56vh] overflow-auto rounded-lg border border-line">
          {groups.map(([g, list]) => (
            <div key={g}>
              <div className="sticky top-0 z-10 border-b border-line bg-raised px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-mute">{g}</div>
              {list.map((a) => {
                const ks = bindings[a.id] ?? [];
                const changed = a.id in st.custom;
                return (
                  <div key={a.id} className="flex min-h-8 items-center gap-2 border-b border-line/50 px-3 py-1 hover:bg-hover/40">
                    <span className={clsx("w-64 shrink-0 truncate", changed && "text-accent-ink")} title={a.id}>{a.label}</span>
                    <div className="flex flex-1 flex-wrap items-center gap-1">
                      {ks.map((k) => (
                        <span key={k} className={clsx("mono inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]", clash.has(`${a.id}|${k}`) ? "border-warn/60 bg-warn/15 text-amber-200" : "border-line bg-panel")}>
                          {kbd(k)}
                          {!a.fixed && <button type="button" className="text-dim hover:text-ink" title="Remove this key" onClick={() => removeKey(a.id, k)}><X className="size-3" /></button>}
                        </span>
                      ))}
                      {!ks.length && <span className="text-dim">—</span>}
                      {!a.fixed && (rec === a.id
                        ? <span className="animate-pulse rounded border border-accent px-1.5 py-0.5 text-[11px] text-accent-ink">Press a key… (Esc cancels)</span>
                        : <button type="button" className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-dim hover:bg-hover hover:text-ink" onClick={() => { setPending(null); setRec(a.id); }}><Plus className="size-3" />Key</button>)}
                    </div>
                    {changed && !a.fixed && <button type="button" className="text-dim hover:text-ink" title="Back to the preset's keys" onClick={() => setKeySettings(resetKeys(st, a.id))}><RotateCcw className="size-3" /></button>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
