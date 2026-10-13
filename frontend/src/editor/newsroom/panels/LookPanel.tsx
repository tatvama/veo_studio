/**
 * News Room: the edit's channel look (docs/EDITOR.md §16.2 / §16.8). Owner: nr-designer.
 * The look in use with a live preview, the ready looks and the user's own as cards (a strap and a ticker drawn in each
 * look), the look editor (every colour, fonts, logo, motion, plates, bug, numbers, clock), Make my look from a logo,
 * and import / export of .tatvamlook files. Using a look is one undo step and every graphic follows it.
 */
import { clsx } from "clsx";
import { Check, Download, Ellipsis, Palette, Pencil, Trash2, Upload, Wand2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Menu } from "../../../components/ui";
import { useEditorHost } from "../../host";
import { setFocus, useProject } from "../../store";
import { IBtn } from "../../ui";
import { applyLook, ensureNewsroom } from "../commands";
import { clone } from "../designer/doc";
import { LookEditor } from "../designer/LookEditor";
import { LookPreview } from "../designer/LookPreview";
import { MakeMyLook } from "../designer/MakeMyLook";
import { deleteLook, exportToFile, importFileChecked, isMyLook, listLooks, loadLook, newLookId, onLibraryChange, saveLook } from "../library";
import { BUILTIN_LOOKS, builtinLook, copyLook, resolveLook } from "../looks";
import type { ChannelLook } from "../types";

/** The user's library looks, loaded (refreshed when the library changes). */
function useMyLooks(): ChannelLook[] {
  const [looks, setLooks] = useState<ChannelLook[]>([]);
  const load = useCallback(async () => {
    try {
      const list = await listLooks();
      const out: ChannelLook[] = [];
      for (const e of list) { const l = await loadLook(e.id); if (l) out.push(l); }
      setLooks(out);
    } catch { setLooks([]); }
  }, []);
  useEffect(() => { void load(); return onLibraryChange(() => void load()); }, [load]);
  return looks;
}

export default function LookPanel() {
  const p = useProject();
  const host = useEditorHost();
  const current = resolveLook(p);
  const mine = useMyLooks();
  const [draft, setDraft] = useState<ChannelLook | null>(null);
  const [makeOpen, setMakeOpen] = useState(false);

  const use = (l: ChannelLook, label = `Use the ${l.name} look`) => {
    try {
      host.apply(label, (d) => {
        const nr = ensureNewsroom(d);
        if (!builtinLook(l.id) || nr.looks?.[l.id]) nr.looks = { ...(nr.looks ?? {}), [l.id]: clone(l) };
        applyLook(d, l.id);
      });
    } catch (e) { toast.error(`Couldn't change the look: ${(e as Error).message}`); }
  };
  const edit = (l: ChannelLook) => setDraft(builtinLook(l.id) ? copyLook(l, newLookId(), `${l.name} (mine)`) : clone(l));
  const saveDraft = async (andUse: boolean) => {
    if (!draft) return;
    const l = isMyLook(draft.id) ? draft : copyLook(draft, newLookId(), draft.name);
    try { await saveLook(l); } catch (e) { toast.error(`Couldn't save the look: ${(e as Error).message}`); return; }
    if (andUse) use(l, `Change the look (${l.name})`);
    toast.success(andUse ? `“${l.name}” saved and in use` : `“${l.name}” saved to your looks`);
    setDraft(null);
  };
  const exp = (l: ChannelLook) => void exportToFile("look", l).then((path) => { if (path) toast.success(`Exported ${path}`); }).catch((e) => toast.error((e as Error).message));
  const imp = async () => {
    const r = await importFileChecked("look", Object.keys(p.newsroom?.looks ?? {}));
    if (!r) return;
    if (!r.ok) { toast.error(`That file couldn't be imported. ${r.reason}`); return; }
    toast.success(`“${r.value.name}” added to your looks`);
  };
  const del = async (l: ChannelLook) => {
    if (!window.confirm(`Delete “${l.name}” from your looks? Edits that use it keep their own copy.`)) return;
    try { await deleteLook(l.id); } catch (e) { toast.error((e as Error).message); }
  };

  const shown = draft ?? current;
  const inEdit = Object.values(p.newsroom?.looks ?? {}).filter((l) => !builtinLook(l.id) && !mine.some((m) => m.id === l.id));

  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar">
        <Palette className="ml-1 size-3.5 text-mute" />
        <span className="flex-1 truncate text-xs font-medium">{draft ? `Editing “${draft.name}”` : "Channel look"}</span>
        {!draft && <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} onClick={() => setMakeOpen(true)}>Make my look</Button>}
        <Menu width={220} trigger={(pr) => <IBtn {...pr} title="More"><Ellipsis className="size-4" /></IBtn>}
          items={[
            { label: "Import a look file…", icon: <Upload className="size-3.5" />, onClick: () => void imp() },
            { label: "Export this look…", icon: <Download className="size-3.5" />, onClick: () => exp(shown) },
          ]} />
      </div>
      <div className="pn-scroll">
        <div className="space-y-2 p-3">
          <LookPreview look={shown} className="w-full shadow-[0_6px_24px_-12px_rgb(0_0_0/.7)]" />
          {!draft ? (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{current.name}</p>
                <p className="text-2xs text-dim">{p.newsroom ? "Every graphic in this edit uses it, unless it has its own." : "Graphics you add will use it."}</p>
              </div>
              <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => edit(current)}>Customise</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="primary" onClick={() => void saveDraft(true)} title="Save it to your looks and use it in this edit">Save and use</Button>
              <Button size="sm" onClick={() => { use(draft, `Change the look (${draft.name})`); }} title="Use it in this edit without saving it to your looks">Use here</Button>
              <Button size="sm" variant="ghost" onClick={() => void saveDraft(false)} title="Save it to your looks (for any edit)">Save</Button>
              <span className="flex-1" />
              <IBtn title="Close the look editor" onClick={() => setDraft(null)}><X className="size-4" /></IBtn>
            </div>
          )}
        </div>
        {draft ? (
          <LookEditor look={draft} onChange={setDraft} />
        ) : (<>
          <Cards title="Ready looks" looks={BUILTIN_LOOKS} current={current.id} onUse={use} onEdit={edit} />
          {mine.length > 0 && <Cards title="My looks" looks={mine} current={current.id} onUse={use} onEdit={edit} onExport={exp} onDelete={(l) => void del(l)} />}
          {inEdit.length > 0 && <Cards title="Only in this edit" looks={inEdit} current={current.id} onUse={use} onEdit={edit} onExport={exp} />}
          {mine.length === 0 && (
            <p className="px-3 pb-4 text-2xs leading-relaxed text-dim">Your own looks show here. Use <b>Make my look</b> to build one from your channel's logo, or <b>Customise</b> any look.</p>
          )}
        </>)}
      </div>
      <MakeMyLook open={makeOpen} onClose={() => setMakeOpen(false)} onUse={(l) => use(l, `Use the ${l.name} look`)}
        start={current.logo?.image ? { image: current.logo.image, mediaId: current.logo.mediaId } : undefined} />
    </div>
  );
}

function Cards({ title, looks, current, onUse, onEdit, onExport, onDelete }: {
  title: string; looks: ChannelLook[]; current: string; onUse: (l: ChannelLook) => void; onEdit: (l: ChannelLook) => void;
  onExport?: (l: ChannelLook) => void; onDelete?: (l: ChannelLook) => void;
}) {
  return (
    <div>
      <div className="pn-section cursor-default">{title}</div>
      <div className="grid gap-2 p-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {looks.map((l) => {
          const on = l.id === current;
          return (
            <div key={l.id} className={clsx("group rounded-lg border p-1.5 transition-colors", on ? "border-accent/70 bg-accent/8" : "border-line hover:border-dim/50")}>
              <button type="button" className="block w-full" title={on ? "In use" : `Use ${l.name}`} onClick={() => !on && onUse(l)}>
                <LookPreview look={l} crop />
              </button>
              <div className="mt-1 flex items-center gap-1 px-0.5">
                {on && <Check className="size-3 shrink-0 text-accent-ink" />}
                <span className="min-w-0 flex-1 truncate text-2xs" title={l.name}>{l.name}</span>
                {!on && <button type="button" className="rounded px-1.5 text-2xs text-accent-ink hover:bg-hover" onClick={() => onUse(l)}>Use</button>}
                <Menu width={170} trigger={(pr) => <button type="button" {...pr} className="tl-tbtn opacity-60 group-hover:opacity-100" aria-label="More"><Ellipsis className="size-3.5" /></button>}
                  items={[
                    { label: "Customise", icon: <Pencil className="size-3.5" />, onClick: () => onEdit(l) },
                    ...(onExport ? [{ label: "Export…", icon: <Download className="size-3.5" />, onClick: () => onExport(l) }] : []),
                    ...(onDelete ? [{ label: "Delete", icon: <Trash2 className="size-3.5" />, danger: true, separator: true, onClick: () => onDelete(l) }] : []),
                  ]} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
