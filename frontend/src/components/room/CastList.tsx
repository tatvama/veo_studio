import { History, ImageOff, Lock, MapPin, Plus, Sparkles, UserRound } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { Character, Location } from "../../lib/types";
import { Avatar, Button, Input, Skeleton } from "../ui";
import { voicedLanguages } from "./cast";
import { LoadError } from "./kit";

/** A row of the list on the left of the Cast: picture, name and two plain facts. 56 px tall (a comfortable tap on a phone). */
function Row({ selected, onClick, picture, name, children, label }: {
  selected: boolean; onClick: () => void; picture: ReactNode; name: ReactNode; children?: ReactNode; label: string;
}) {
  return (
    <li>
      <button type="button" onClick={onClick} aria-current={selected ? "true" : undefined} aria-label={label}
        className={cn("relative flex min-h-14 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60",
          selected ? "bg-accent/10 text-ink" : "text-ink hover:bg-hover/60")}>
        {selected && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-accent shadow-[0_0_8px_var(--color-accent)]" />}
        {picture}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">{name}</span>
          {children && <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs leading-4">{children}</span>}
        </span>
      </button>
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul className="space-y-1 p-2" aria-busy="true">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="flex items-center gap-3 px-2.5 py-2"><Skeleton className="size-11 !rounded-lg" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-3 w-16" /></div></li>
      ))}
    </ul>
  );
}

/** "+ New …" at the end of a list: type a name, press Add. */
function AddRow({ placeholder, onAdd, adding, label }: { placeholder: string; onAdd: (name: string) => void; adding?: boolean; label: string }) {
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (adding) return;
    onAdd(name.trim());
    setName("");
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-1.5 border-t border-line p-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="!h-9 min-w-0 flex-1 max-sm:!h-10" />
      <Button type="submit" size="sm" variant="secondary" loading={adding} icon={<Plus className="size-3.5" />} className="h-9 max-sm:h-10" aria-label={label}>{label}</Button>
    </form>
  );
}

/**
 * The Cast's list of faces: picture, name, whether they have a voice, and "look out of date" when shots still show their old
 * look. Selecting one opens it in the middle. `stale` = out-of-date shots per character id.
 */
export function FaceList({ chars, loading, error, onRetry, selected, onSelect, canEdit, languages, stale, onAdd, adding, onPropose, proposing, className }: {
  chars: Character[] | undefined; loading: boolean; error?: boolean; onRetry?: () => void; selected: number | null; onSelect: (id: number) => void;
  canEdit: boolean; languages: string[]; stale: Record<number, number>; onAdd: (name: string) => void; adding?: boolean;
  onPropose: () => void; proposing: boolean; className?: string;
}) {
  const t = useT();
  const list = chars ?? [];
  return (
    <nav aria-label={t("Cast")} className={cn("flex min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading && !chars ? <ListSkeleton /> : error && onRetry ? <div className="p-3"><LoadError what={t("Couldn't load the cast")} onRetry={onRetry} /></div> : (
          <>
            <p className="eyebrow flex items-center gap-1.5 px-4 pb-1 pt-3"><UserRound aria-hidden className="size-3.5" />{t("People")}<span className="mono text-dim">{list.length}</span></p>
            {!list.length ? (
              <div className="space-y-3 px-4 py-4 text-sm text-mute">
                <p>{t("No cast yet. Build it from your script, or add someone by name below.")}</p>
                {canEdit && <Button size="sm" variant="primary" loading={proposing} icon={<Sparkles className="size-3.5" />} className="max-sm:h-10" onClick={onPropose}>{t("Build from script")}</Button>}
              </div>
            ) : (
              <ul className="space-y-0.5 p-2 pt-1">
                {list.map((c) => {
                  const voiced = voicedLanguages(c.voices);
                  const n = languages.filter((l) => voiced.has(l)).length;
                  const out = stale[c.id] ?? 0;
                  return (
                    <Row key={c.id} selected={selected === c.id} onClick={() => onSelect(c.id)} label={`${c.name}${c.role ? `, ${c.role}` : ""}`}
                      picture={c.avatar_url
                        ? <img src={c.avatar_url} alt="" loading="lazy" className="size-11 shrink-0 rounded-lg border border-line object-cover" />
                        : <Avatar name={c.name} size={44} className="!rounded-lg" />}
                      name={<>
                        <span className="min-w-0 truncate text-sm font-medium" title={c.name}>{c.name}</span>
                        {c.locked && <Lock aria-label={t("Locked")} className="size-3 shrink-0 text-amber-300" />}
                      </>}>
                      {languages.length > 0 && (n === languages.length
                        ? <span className="text-ok">{t("voice ✓")}</span>
                        : n ? <span className="text-mute">{t("voice {a}/{n}", { a: n, n: languages.length })}</span> : <span className="text-dim">{t("no voice")}</span>)}
                      {!c.avatar_url && <span className="text-dim">{t("no picture")}</span>}
                      {out > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded border border-warn/35 bg-warn/12 px-1 font-medium text-warn" title={t("{n} shots still show the old look", { n: out })}>
                          <History aria-hidden className="size-3" />{t("look out of date")}
                        </span>
                      )}
                    </Row>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
      {canEdit && <AddRow placeholder={t("New character name")} onAdd={onAdd} adding={adding} label={t("Add")} />}
    </nav>
  );
}

const placeCover = (l: Location) => l.thumb_url || l.assets?.find((a) => a.approved)?.url || l.assets?.[0]?.url || "";

/** The places of the film as the same kind of list: picture, name, how many pictures and how many are approved. */
export function PlaceList({ places, loading, error, onRetry, selected, onSelect, canEdit, onAdd, adding, onPropose, proposing, className }: {
  places: Location[] | undefined; loading: boolean; error?: boolean; onRetry?: () => void; selected: number | null; onSelect: (id: number) => void;
  canEdit: boolean; onAdd: (name: string) => void; adding?: boolean; onPropose: () => void; proposing: boolean; className?: string;
}) {
  const t = useT();
  const list = places ?? [];
  return (
    <nav aria-label={t("Places")} className={cn("flex min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading && !places ? <ListSkeleton /> : error && onRetry ? <div className="p-3"><LoadError what={t("Couldn't load the locations")} onRetry={onRetry} /></div> : (
          <>
            <p className="eyebrow flex items-center gap-1.5 px-4 pb-1 pt-3"><MapPin aria-hidden className="size-3.5" />{t("Places")}<span className="mono text-dim">{list.length}</span></p>
            {!list.length ? (
              <div className="space-y-3 px-4 py-4 text-sm text-mute">
                <p>{t("No places yet. Build them from your script, or add one by name below.")}</p>
                {canEdit && <Button size="sm" variant="primary" loading={proposing} icon={<Sparkles className="size-3.5" />} className="max-sm:h-10" onClick={onPropose}>{t("Build from script")}</Button>}
              </div>
            ) : (
              <ul className="space-y-0.5 p-2 pt-1">
                {list.map((l) => {
                  const img = placeCover(l);
                  const n = l.assets?.length ?? 0;
                  const ok = l.assets?.filter((a) => a.approved).length ?? 0;
                  return (
                    <Row key={l.id} selected={selected === l.id} onClick={() => onSelect(l.id)} label={l.name}
                      picture={img ? <img src={img} alt="" loading="lazy" className="h-11 w-16 shrink-0 rounded-lg border border-line object-cover" />
                        : <span className="grid h-11 w-16 shrink-0 place-items-center rounded-lg border border-dashed border-line bg-raised text-dim"><ImageOff aria-hidden className="size-4" /></span>}
                      name={<>
                        <span className="min-w-0 truncate text-sm font-medium" title={l.name}>{l.name}</span>
                        {l.locked && <Lock aria-label={t("Locked")} className="size-3 shrink-0 text-amber-300" />}
                      </>}>
                      {n ? <span className={ok ? "text-ok" : "text-mute"}>{t("{n} pictures · {a} approved", { n, a: ok })}</span> : <span className="text-dim">{t("no pictures yet")}</span>}
                    </Row>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
      {canEdit && <AddRow placeholder={t("New place name")} onAdd={onAdd} adding={adding} label={t("Add")} />}
    </nav>
  );
}
