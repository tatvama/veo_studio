import { clsx } from "clsx";
import { Images, Lock, LockKeyhole, Mic, PencilLine, Plus, ScanFace, ShieldCheck, Shirt, Sparkles, UserRound, Loader2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { LANG_SHORT } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Character, ConsentRow } from "../../lib/types";
import type { CharacterV3 } from "../../lib/v3";
import { Avatar, Button, Input, Skeleton, rise } from "../ui";
import { LoadError, RoomEmpty } from "./kit";
import { LOCKED_LOOK_AT } from "./look";

const GRID = "grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,10rem),1fr))]";

/** The cast as portrait cards. Click one to open its page. */
export function CastGrid({ chars, loading, error, onRetry, canEdit, languages, consents, onOpen, onAdd, adding, onPropose, proposing }: {
  chars: Character[] | undefined; loading: boolean; error?: boolean; onRetry?: () => void; canEdit: boolean; languages: string[]; consents: ConsentRow[] | undefined;
  onOpen: (id: number) => void; onAdd: (name: string) => void; adding: boolean; onPropose: () => void; proposing: boolean;
}) {
  const t = useT();
  if (loading) {
    return (
      <div className={GRID} aria-busy="true" aria-label={t("Loading cast…")}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border border-line bg-panel">
            <Skeleton className="aspect-[3/4] !rounded-none" />
            <div className="flex gap-2 px-3 py-2.5"><Skeleton className="h-3 w-16" /><Skeleton className="h-3 w-10" /></div>
          </div>
        ))}
      </div>
    );
  }
  if (error && onRetry) return <LoadError what={t("Couldn't load the cast")} onRetry={onRetry} />;
  const list = chars ?? [];
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      {!list.length && (
        <RoomEmpty icon={<UserRound />} title={t("No cast yet")}
          sub={t("Build the cast from your script, or add a character by name.")}
          action={canEdit ? <Button variant="primary" loading={proposing} icon={<Sparkles className="size-4" />} onClick={onPropose}>{t("Build from script")}</Button> : undefined} />
      )}
      {(list.length > 0 || canEdit) && (
        <div className={GRID}>
          {list.map((c, i) => (
            <CharacterCard key={c.id} c={c} index={i} languages={languages} onOpen={() => onOpen(c.id)}
              consent={consents?.some((r) => r.character_id === c.id && (!r.expires_on || r.expires_on >= today)) ? true : undefined} />
          ))}
          {canEdit && <AddTile index={list.length} adding={adding} onAdd={onAdd} />}
        </div>
      )}
    </div>
  );
}

function Chip({ icon, children, tone }: { icon: ReactNode; children: ReactNode; tone?: "ok" | "warn" | "info" | "bad" }) {
  const tones = { ok: "text-ok", warn: "text-warn", info: "text-info", bad: "text-bad" };
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-1 text-2xs font-medium leading-none text-white shadow-card backdrop-blur [&>svg]:size-3 [&>svg]:shrink-0">
      <span className={clsx("grid place-items-center", tone && tones[tone])}>{icon}</span>{children}
    </span>
  );
}

function CharacterCard({ c, index, languages, onOpen, consent }: { c: Character; index: number; languages: string[]; onOpen: () => void; consent?: boolean }) {
  const t = useT();
  const r = rise(index);
  const voiced = new Set(((c.voices ?? []) as any[]).map((v) => (typeof v === "string" ? v : v?.language)));
  const images = c.asset_count ?? c.assets?.length ?? 0;
  const st = c.identity?.status;
  const v3 = c as CharacterV3;
  const strictness = v3.lock_effective?.strictness ?? v3.lock?.strictness;
  const lockedLook = typeof strictness === "number" && strictness >= LOCKED_LOOK_AT;
  // the project cast payload carries costumes; the shared library list doesn't, so the count is hidden there
  const costumes = v3.costumes?.length;
  return (
    <div {...r}>
      <button type="button" onClick={onOpen} aria-label={`${c.name}${c.role ? `, ${c.role}` : ""}`}
        className={clsx("group lift flex h-full w-full flex-col overflow-hidden rounded-xl border bg-panel text-left hover:border-accent/50", c.locked ? "border-warn/35" : "border-line")}>
        <div className="relative aspect-[3/4] w-full overflow-hidden bg-raised">
          {c.avatar_url ? (
            <img src={c.avatar_url} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.05]" />
          ) : (
            <div className="grid size-full place-items-center bg-gradient-to-br from-accent/10 via-raised to-bg">
              <Avatar name={c.name} size={76} />
            </div>
          )}
          <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
          <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
            {c.locked ? <Chip icon={<Lock />} tone="warn">{t("Locked")}</Chip> : <Chip icon={<PencilLine />}>{t("Draft")}</Chip>}
            {lockedLook && <Chip icon={<LockKeyhole />} tone="ok">{t("Locked look")}</Chip>}
          </div>
          <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
            {st === "ready" && <Chip icon={<ScanFace />} tone="ok">ID</Chip>}
            {(st === "training" || st === "preparing") && <Chip icon={<Loader2 className="animate-spin" />} tone="info">ID</Chip>}
            {st === "failed" && <Chip icon={<ScanFace />} tone="bad">ID</Chip>}
            {consent && <Chip icon={<ShieldCheck />} tone="ok">{t("Consent")}</Chip>}
          </div>
          <div className="absolute inset-x-0 bottom-0 p-3 text-white">
            <p className="truncate text-base font-semibold leading-tight" title={c.name}>{c.name}</p>
            <p className="mt-0.5 truncate text-xs text-white/75">{c.role || "—"}</p>
          </div>
        </div>
        <div className="flex items-center gap-x-3 gap-y-1 px-3 py-2 text-2xs text-mute">
          <span className="flex items-center gap-1" title={t("Voices")}>
            <Mic className="size-3 shrink-0 text-dim" />
            {languages.map((l) => <span key={l} className={clsx("font-semibold", voiced.has(l) ? "text-ink" : "text-dim")}>{LANG_SHORT[l] ?? l.toUpperCase()}</span>)}
          </span>
          {costumes !== undefined && (
            <span className="ml-auto flex items-center gap-1 tabular-nums" title={t("Outfits")}><Shirt className="size-3 shrink-0 text-dim" />{costumes}</span>
          )}
          <span className={clsx("flex items-center gap-1 tabular-nums", costumes === undefined && "ml-auto")} title={t("Reference images")}><Images className="size-3 shrink-0 text-dim" />{images}</span>
        </div>
      </button>
    </div>
  );
}

function AddTile({ index, adding, onAdd }: { index: number; adding: boolean; onAdd: (name: string) => void }) {
  const t = useT();
  const r = rise(index);
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (adding) return;
    onAdd(name.trim());
    setName("");
  };
  return (
    <form {...r} onSubmit={submit} className={clsx("flex min-h-[15rem] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line p-4 text-center transition-colors focus-within:border-accent/50 hover:border-dim/60", r.className)}>
      <span className="grid size-10 place-items-center rounded-full border border-line bg-raised text-mute"><Plus className="size-5" /></span>
      <p className="text-sm font-medium">{t("New character")}</p>
      <Input placeholder={t("New character name")} aria-label={t("New character name")} value={name} onChange={(e) => setName(e.target.value)} className="text-center" />
      <Button type="submit" size="sm" loading={adding} icon={<Plus className="size-3.5" />}>{t("Add with photos…")}</Button>
    </form>
  );
}
