import { BookUser, MapPin, Package } from "lucide-react";
import { useState } from "react";
import { Panel, Segmented, Skeleton } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { useCharacters, useLocations } from "../../../lib/queries";
import { useProps } from "../../../lib/v3";
import { useProjectCtx } from "../../project/context";

type Tab = "cast" | "places" | "props";
interface Still { key: string; url: string; title: string; sub?: string }

/** Approved stills of the cast, places and props, for matching a shot by eye while finishing. */
export default function BiblePanel() {
  const t = useT();
  const { project } = useProjectCtx();
  const { data: chars, isLoading } = useCharacters(project.id);
  const { data: locs } = useLocations(project.id);
  const { data: props } = useProps(project.id);
  const [tab, setTab] = useState<Tab>("cast");
  const [open, setOpen] = useState<number | null>(null);

  const cast: Still[] = (chars ?? []).flatMap((c) => {
    const approved = (c.assets ?? []).filter((a) => a.approved && !a.archived && a.url);
    const list = approved.length ? approved : c.avatar_url ? [{ id: 0, url: c.avatar_url, label: "", outfit: "" }] : [];
    return list.map((a) => ({ key: `c${c.id}-${a.id}`, url: a.url, title: c.name, sub: [a.label, a.outfit].filter(Boolean).join(" · ") }));
  });
  const places: Still[] = (locs ?? []).flatMap((l) => {
    const approved = (l.assets ?? []).filter((a) => a.approved && a.url);
    const list = approved.length ? approved : l.thumb_url ? [{ id: 0, url: l.thumb_url, label: "", time_of_day: "" }] : [];
    return list.map((a) => ({ key: `l${l.id}-${a.id}`, url: a.url, title: l.name, sub: [a.label, a.time_of_day].filter(Boolean).join(" · ") }));
  });
  const things: Still[] = (props ?? []).filter((p) => p.url && !p.archived && p.in_project !== false).map((p) => ({ key: `p${p.id}`, url: p.url, title: p.name, sub: p.description }));
  const list = tab === "cast" ? cast : tab === "places" ? places : things;

  return (
    <div className="h-full overflow-y-auto p-3">
      <Panel eyebrow={t("Bible")} icon={tab === "cast" ? <BookUser /> : tab === "places" ? <MapPin /> : <Package />}
        actions={<Segmented size="sm" value={tab} onChange={(v) => { setTab(v); setOpen(null); }} aria-label={t("Show")}
          options={[{ value: "cast", label: `${t("Cast")} ${cast.length}` }, { value: "places", label: `${t("Places")} ${places.length}` }, { value: "props", label: `${t("Props")} ${things.length}` }]} />}>
        {isLoading ? <div className="grid grid-cols-3 gap-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-square" />)}</div> : list.length ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
            {list.map((s, i) => (
              <li key={s.key}>
                <button type="button" onClick={() => setOpen(i)} className="group block w-full overflow-hidden rounded-lg border border-line text-left hover:border-accent/40">
                  <img src={s.url} alt={s.title} loading="lazy" className="aspect-square w-full bg-black object-cover" />
                  <span className="block px-2 py-1">
                    <span className="block truncate text-xs font-medium">{s.title}</span>
                    {s.sub && <span className="block truncate text-2xs text-dim">{s.sub}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-dim">{t("No approved stills here yet.")}</p>}
      </Panel>
      {open !== null && list[open] && (
        <div role="dialog" aria-label={list[open].title} className="fixed inset-0 z-50 grid place-items-center bg-black/90 p-6" onClick={() => setOpen(null)}>
          <img src={list[open].url} alt={list[open].title} className="max-h-full max-w-full object-contain" />
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-1 text-xs text-white">{list[open].title}{list[open].sub ? ` · ${list[open].sub}` : ""}</p>
        </div>
      )}
    </div>
  );
}
