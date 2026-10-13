/**
 * Small pieces the room's panels share (docs/EDITOR.md §16.8): people / places / story pickers (menus), a picker for
 * the edit's bin images, a text field that types live and makes one undo step per focus, and the "no News Room yet"
 * starter.
 */
import { clsx } from "clsx";
import { ChevronDown, ImageOff, MapPin, Newspaper, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/ui";
import type { EditProject, MediaItem } from "../../model/types";
import { urlFor, useEditor } from "../../store";
import { openMenu, type MenuItem } from "../../ui";
import { showNewsPanel } from "../events";
import type { GfxImageRef, Person, Place, RundownStory } from "../types";
import { makeNewsEdit } from "./actions";
import { liveDone, liveEdit } from "./live";

/** A person's name in a language (when they have one). */
export const personName = (p: Person, lang?: string) => (lang && p.names?.[lang]) || p.name;

function PickButton({ icon, label, title, items, empty }: { icon: ReactNode; label: string; title: string; items: () => MenuItem[]; empty: MenuItem[] }) {
  return (
    <button type="button" title={title} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line px-1.5 text-2xs text-mute hover:bg-hover hover:text-ink"
      onClick={(e) => { const l = items(); openMenu(e.currentTarget.getBoundingClientRect(), l.length ? l : empty); }}>
      {icon}{label}<ChevronDown className="size-3" />
    </button>
  );
}

export function PersonPicker({ people, onPick, lang, label = "Person" }: { people: Person[]; onPick: (p: Person) => void; lang?: string; label?: string }) {
  return (
    <PickButton icon={<UserRound className="size-3" />} label={label} title="Fill in from the People list"
      items={() => [...people].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ label: personName(p, lang), hint: p.role, onClick: () => onPick(p) }))}
      empty={[{ label: "No people yet", disabled: true }, { label: "Open People…", onClick: () => showNewsPanel("nr-people") }]} />
  );
}

export function PlacePicker({ places, onPick, lang }: { places: Place[]; onPick: (p: Place) => void; lang?: string }) {
  return (
    <PickButton icon={<MapPin className="size-3" />} label="Place" title="Fill in from the Places list"
      items={() => [...places].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ label: (lang && p.names?.[lang]) || p.name, onClick: () => onPick(p) }))}
      empty={[{ label: "No places yet", disabled: true }, { label: "Open People and places…", onClick: () => showNewsPanel("nr-people") }]} />
  );
}

export function StoryPicker({ stories, onPick }: { stories: RundownStory[]; onPick: (s: RundownStory) => void }) {
  return (
    <PickButton icon={<Newspaper className="size-3" />} label="Story" title="Fill in from a rundown story"
      items={() => stories.map((s) => ({ label: s.headline || s.slug, hint: s.slug, onClick: () => onPick(s) }))}
      empty={[{ label: "The rundown is empty", disabled: true }, { label: "Open Rundown…", onClick: () => showNewsPanel("nr-rundown") }]} />
  );
}

const thumbOf = (m: MediaItem) => m.thumb ?? urlFor(m);

/** The edit's pictures (bin images), with "none". */
export function ImagePicker({ value, onChange, media }: { value: GfxImageRef | null | undefined; onChange: (v: GfxImageRef | null) => void; media: MediaItem[] }) {
  const [open, setOpen] = useState(false);
  const images = media.filter((m) => m.kind === "image");
  const cur = value?.mediaId ? media.find((m) => m.id === value.mediaId) : undefined;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen((v) => !v)} title="Choose a picture from the edit's media"
          className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-raised hover:border-accent/60">
          {cur && thumbOf(cur) ? <img src={thumbOf(cur)} alt="" className="size-full object-cover" /> : <ImageOff className="size-4 text-dim" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs">{cur ? cur.name : value?.mediaId ? "Missing picture" : "No picture"}</p>
          <div className="mt-0.5 flex gap-1">
            <button type="button" className="text-2xs text-accent-ink hover:underline" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Choose…"}</button>
            {value && <button type="button" className="text-2xs text-mute hover:underline" onClick={() => onChange(null)}>Remove</button>}
          </div>
        </div>
      </div>
      {open && (images.length ? (
        <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-line p-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(56px, 1fr))" }}>
          {images.map((m) => (
            <button key={m.id} type="button" title={m.name} onClick={() => { onChange({ mediaId: m.id }); setOpen(false); }}
              className={clsx("aspect-square overflow-hidden rounded border", value?.mediaId === m.id ? "border-accent" : "border-line hover:border-accent/60")}>
              {thumbOf(m) ? <img src={thumbOf(m)} alt="" className="size-full object-cover" /> : <span className="block truncate p-1 text-[10px] text-dim">{m.name}</span>}
            </button>
          ))}
        </div>
      ) : <p className="text-2xs text-dim">Import pictures into the edit (File → Import media), then choose one here.</p>)}
    </div>
  );
}

/**
 * A text field bound to the document: each key shows at once, one focus = one undo step. `make(base, value)` gives the
 * whole new project from the document as it was when typing began.
 */
export function LiveText({ value, liveKey, label, make, multiline, rows = 3, placeholder, className, onEnter }: {
  value: string; liveKey: string; label: string; make: (base: EditProject, v: string) => EditProject;
  multiline?: boolean; rows?: number; placeholder?: string; className?: string; onEnter?: () => void;
}) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value); }, [value]);
  useEffect(() => () => { if (focused.current) liveDone(liveKey); }, [liveKey]);
  const change = (x: string) => { setV(x); liveEdit(label, liveKey, (base) => make(base, x)); };
  const common = {
    value: v, placeholder, spellCheck: true,
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; liveDone(liveKey); },
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter" && !multiline) { liveDone(liveKey); onEnter?.(); }
      if (e.key === "Escape") (e.currentTarget as HTMLElement).blur();
    },
  };
  return multiline
    ? <textarea {...common} rows={rows} onChange={(e) => change(e.target.value)} className={clsx("ed-field w-full resize-y py-1 leading-snug", className)} style={{ height: "auto" }} />
    : <input {...common} onChange={(e) => change(e.target.value)} className={clsx("ed-field w-full", className)} />;
}

/** For panels of an edit that isn't a news edit yet. */
export function NoNewsroom({ what }: { what: string }) {
  const has = useEditor((s) => !!s.h.present.newsroom);
  if (has) return null;
  return (
    <div className="pn-empty">
      <div className="max-w-[260px] space-y-3">
        <p>{what}</p>
        <Button size="sm" variant="primary" onClick={() => makeNewsEdit()}>Make this a news edit</Button>
        <p className="text-2xs text-dim">Adds the News Room to this edit: rundown, people, playlist and the channel look. Nothing on the timeline changes.</p>
      </div>
    </div>
  );
}
