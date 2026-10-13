/**
 * News Room: people and places (docs/EDITOR.md §16.8). Anchors, reporters, guests and experts with their role,
 * location, photo (from the bin), name in other languages and transcript speaker label; places with their names per
 * language. Fill in's pickers and the rundown use them, so a name is typed once and spelled the same in every strap.
 */
import { clsx } from "clsx";
import { ChevronRight, MapPin, Plus, Trash2, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button, SearchField, Segmented } from "../../../components/ui";
import { uid } from "../../model/ids";
import type { EditProject } from "../../model/types";
import { setFocus, urlFor, useProject } from "../../store";
import { ensureNewsroom } from "../commands";
import type { Person, Place } from "../types";
import { addTemplateAt, host } from "../room/actions";
import { updatePerson, updatePlace } from "../room/doc";
import { valuesFromPerson } from "../room/fields";
import { allTemplates, useNewsroomDoc } from "../room/hooks";
import { pickTemplate, WANT } from "../room/pick";
import { ImagePicker, LiveText, NoNewsroom } from "../room/pickers";
import { useNewsBoot } from "../room/NewNewsEdit";

const KINDS: { id: NonNullable<Person["kind"]>; label: string }[] = [
  { id: "anchor", label: "Anchor" }, { id: "reporter", label: "Reporter" }, { id: "guest", label: "Guest" }, { id: "expert", label: "Expert" }, { id: "other", label: "Other" },
];
const LANG_NAMES: Record<string, string> = { hi: "Hindi", kn: "Kannada", te: "Telugu", ta: "Tamil", ml: "Malayalam", mr: "Marathi", bn: "Bengali", gu: "Gujarati", pa: "Punjabi", or: "Odia", ur: "Urdu" };
const editNr = (label: string, fn: (d: EditProject) => void) => host().apply(label, (d) => { ensureNewsroom(d); fn(d); });
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase();

export default function People() {
  useNewsBoot();
  const nr = useNewsroomDoc();
  const [tab, setTab] = useState<"people" | "places">("people");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  if (!nr) return <div className="pn"><NoNewsroom what="Keep the names, roles and photos of anchors, reporters and guests here, typed once for every strap." /></div>;
  const ql = q.trim().toLowerCase();
  const people = nr.people.filter((x) => !ql || `${x.name} ${x.role} ${x.location ?? ""} ${Object.values(x.names ?? {}).join(" ")} ${x.speaker ?? ""}`.toLowerCase().includes(ql));
  const places = nr.places.filter((x) => !ql || `${x.name} ${Object.values(x.names ?? {}).join(" ")}`.toLowerCase().includes(ql));
  const add = () => {
    const id = uid(tab === "people" ? "pp" : "pl");
    if (tab === "people") editNr("Add person", (d) => { d.newsroom!.people.push({ id, name: "", role: "", kind: "guest" }); });
    else editNr("Add place", (d) => { d.newsroom!.places.push({ id, name: "" }); });
    setOpen(id); setQ("");
  };
  return (
    <div className="pn" data-nr-panel="people" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-1.5">
        <Segmented size="sm" value={tab} onChange={(v) => { setTab(v); setOpen(null); }} options={[{ value: "people", label: `People ${nr.people.length}` }, { value: "places", label: `Places ${nr.places.length}` }]} />
        <SearchField value={q} onChange={setQ} placeholder="Search" className="min-w-0 flex-1 [&_input]:h-6 [&_input]:text-xs" onKeyDown={(e) => e.stopPropagation()} />
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={add}>{tab === "people" ? "Person" : "Place"}</Button>
      </div>
      <div className="pn-scroll">
        {tab === "people" ? (
          !people.length ? <div className="pn-empty">{ql ? "Nobody matches." : "No people yet. Add the anchors, reporters and guests of this edit."}</div>
            : people.map((x) => <PersonRow key={x.id} x={x} open={open === x.id} toggle={() => setOpen(open === x.id ? null : x.id)} langs={nr.langs ?? []} />)
        ) : (
          !places.length ? <div className="pn-empty">{ql ? "No place matches." : "No places yet. Add the cities and venues this edit reports from."}</div>
            : places.map((x) => <PlaceRow key={x.id} x={x} open={open === x.id} toggle={() => setOpen(open === x.id ? null : x.id)} langs={nr.langs ?? []} />)
        )}
      </div>
    </div>
  );
}

function Avatar({ x }: { x: Person }) {
  const p = useProject();
  const m = x.photo?.mediaId ? p.media.find((y) => y.id === x.photo!.mediaId) : undefined;
  const src = m ? m.thumb ?? urlFor(m) : undefined;
  return src ? <img src={src} alt="" className="size-7 shrink-0 rounded-full border border-line object-cover" />
    : <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line bg-raised text-[10px] font-semibold text-mute">{initials(x.name) || <UserRound className="size-3.5" />}</span>;
}

/** Names in other languages: the edit's language versions, plus any the person already has. */
function NamesPerLanguage({ names, langs, keyBase, make }: { names: Record<string, string> | undefined; langs: string[]; keyBase: string; make: (b: EditProject, n: Record<string, string>) => EditProject }) {
  const [extra, setExtra] = useState<string[]>([]);
  const codes = [...new Set([...langs.filter((l) => l !== "en"), ...Object.keys(names ?? {}), ...extra])];
  return (
    <div className="grid gap-1">
      <span className="text-[10px] text-dim">Name in other languages</span>
      {codes.map((c) => (
        <label key={c} className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
          <span className="text-2xs text-mute">{LANG_NAMES[c] ?? c.toUpperCase()}</span>
          <LiveText value={names?.[c] ?? ""} liveKey={`${keyBase}:name:${c}`} label="Name in another language"
            make={(b, v) => { const n = { ...(names ?? {}) }; if (v.trim()) n[c] = v; else delete n[c]; return make(b, n); }} />
        </label>
      ))}
      <select className="ed-field w-40 text-2xs" value="" onChange={(e) => { if (e.target.value) setExtra([...extra, e.target.value]); }}>
        <option value="">+ Add a language…</option>
        {Object.entries(LANG_NAMES).filter(([c]) => !codes.includes(c)).map(([c, n]) => <option key={c} value={c}>{n}</option>)}
      </select>
    </div>
  );
}

function PersonRow({ x, open, toggle, langs }: { x: Person; open: boolean; toggle: () => void; langs: string[] }) {
  const p = useProject();
  const k = (f: string) => `person:${x.id}:${f}`;
  const T = (f: "name" | "role" | "location" | "speaker", label: string, placeholder?: string) => (
    <label className="grid gap-0.5">
      <span className="text-[10px] text-dim">{label}</span>
      <LiveText value={x[f] ?? ""} liveKey={k(f)} label={`Person ${label.toLowerCase()}`} placeholder={placeholder} make={(b, v) => updatePerson(b, x.id, { [f]: f === "location" || f === "speaker" ? v || undefined : v } as Partial<Person>)} />
    </label>
  );
  const set = (label: string, patch: Partial<Person>) => host().apply(label, (d) => { Object.assign(d, updatePerson(d, x.id, patch)); });
  const used = (p.newsroom?.rundown ?? []).filter((s) => s.reporter === x.id).length;
  const strap = () => {
    const t = pickTemplate(allTemplates(p), x.kind === "reporter" ? WANT.reporterStrap : WANT.nameStrap);
    if (!t) { toast.message("No name strap template yet"); return; }
    addTemplateAt(t, undefined, { values: valuesFromPerson(t, x), label: `Strap ${x.name}` });
  };
  return (
    <div className="border-b border-line">
      <div className={clsx("pn-row cursor-pointer gap-2 py-1", open && "sel")} onClick={toggle}>
        <ChevronRight className={clsx("size-3 shrink-0 text-dim transition-transform", open && "rotate-90")} />
        <Avatar x={x} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-xs">{x.name || <span className="text-dim">New person</span>}</span>
          <span className="block truncate text-[10px] text-dim">{[x.role, x.location].filter(Boolean).join(" · ") || "—"}</span>
        </span>
        {x.kind && <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] text-mute">{KINDS.find((y) => y.id === x.kind)?.label}</span>}
      </div>
      {open && (
        <div className="grid gap-2 bg-raised/30 px-3 pb-3 pt-1.5 text-xs" onKeyDown={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-2 gap-2">{T("name", "Name", "Priya Rao")}{T("role", "Role", "Senior correspondent")}</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-0.5">
              <span className="text-[10px] text-dim">Kind</span>
              <select className="ed-field w-full" value={x.kind ?? "other"} onChange={(e) => set("Person kind", { kind: e.target.value as Person["kind"] })}>
                {KINDS.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}
              </select>
            </label>
            {T("location", "Location", "Bengaluru")}
          </div>
          <div className="grid gap-0.5"><span className="text-[10px] text-dim">Photo</span><ImagePicker media={p.media} value={x.photo} onChange={(v) => set(v ? "Person photo" : "Remove photo", { photo: v ?? undefined })} /></div>
          <NamesPerLanguage names={x.names} langs={langs} keyBase={`person:${x.id}`} make={(b, n) => updatePerson(b, x.id, { names: Object.keys(n).length ? n : undefined })} />
          {T("speaker", "Transcript speaker", "Speaker 1")}
          <p className="-mt-1 text-[10px] text-dim">The speaker label in the Transcript panel: automatic straps put this person's strap where they speak.</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" disabled={!x.name.trim()} onClick={strap}>Add a strap at the playhead</Button>
            <div className="flex-1" />
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3" />} onClick={() => {
              if (used && !window.confirm(`${x.name || "This person"} reports ${used} rundown stor${used === 1 ? "y" : "ies"}. Delete anyway?`)) return;
              host().apply("Delete person", (d) => { const n = d.newsroom!; n.people = n.people.filter((y) => y.id !== x.id); n.rundown = n.rundown.map((s) => (s.reporter === x.id ? { ...s, reporter: undefined } : s)); });
            }}>Delete</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PlaceRow({ x, open, toggle, langs }: { x: Place; open: boolean; toggle: () => void; langs: string[] }) {
  return (
    <div className="border-b border-line">
      <div className={clsx("pn-row cursor-pointer gap-2 py-1", open && "sel")} onClick={toggle}>
        <ChevronRight className={clsx("size-3 shrink-0 text-dim transition-transform", open && "rotate-90")} />
        <MapPin className="size-3.5 shrink-0 text-accent-ink" />
        <span className="min-w-0 flex-1 truncate text-xs">{x.name || <span className="text-dim">New place</span>}</span>
        <span className="shrink-0 truncate text-[10px] text-dim">{Object.values(x.names ?? {}).slice(0, 2).join(" · ")}</span>
      </div>
      {open && (
        <div className="grid gap-2 bg-raised/30 px-3 pb-3 pt-1.5 text-xs" onKeyDown={(e) => e.stopPropagation()}>
          <label className="grid gap-0.5">
            <span className="text-[10px] text-dim">Name</span>
            <LiveText value={x.name} liveKey={`place:${x.id}:name`} label="Place name" placeholder="Mysuru" make={(b, v) => updatePlace(b, x.id, { name: v })} />
          </label>
          <NamesPerLanguage names={x.names} langs={langs} keyBase={`place:${x.id}`} make={(b, n) => updatePlace(b, x.id, { names: Object.keys(n).length ? n : undefined })} />
          <div className="flex justify-end">
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3" />} onClick={() => host().apply("Delete place", (d) => { d.newsroom!.places = d.newsroom!.places.filter((y) => y.id !== x.id); })}>Delete</Button>
          </div>
        </div>
      )}
    </div>
  );
}
