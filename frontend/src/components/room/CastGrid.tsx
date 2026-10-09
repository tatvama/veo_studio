import { Images, Loader2, Lock, PencilLine, Plus, ScanFace, ShieldCheck, Shirt, Sparkles, UserRound, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { Character, ConsentRow } from "../../lib/types";
import type { CharacterV3 } from "../../lib/v3";
import { Button, Input, Skeleton, rise } from "../ui";
import { LEVEL_TEXT, LangChips, LockMeter, PackBar, Portrait, packDone, packOf, voicedLanguages } from "./cast";
import { LoadError, RoomEmpty } from "./kit";
import { LEVEL_LABEL, strictnessLevel } from "./look";
import { SeedanceBadge } from "./SeedanceBadge";
import { IDENTITY_STATUS } from "./util";
import { IdChip, code, pad } from "./workspace";

const GRID = "grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,12.5rem),1fr))]";

/** The cast as ID cards: portrait, lock level, voices per language, pack completeness. Click one to open its file. */
export function CastGrid({ chars, loading, error, onRetry, canEdit, languages, consents, onOpen, onAdd, adding, onPropose, proposing }: {
  chars: Character[] | undefined; loading: boolean; error?: boolean; onRetry?: () => void; canEdit: boolean; languages: string[]; consents: ConsentRow[] | undefined;
  onOpen: (id: number) => void; onAdd: (name: string) => void; adding: boolean; onPropose: () => void; proposing: boolean;
}) {
  const t = useT();
  if (loading) {
    return (
      <div className={GRID} aria-busy="true" aria-label={t("Loading cast…")}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-xl border border-line bg-panel p-3">
            <div className="flex items-center justify-between"><Skeleton className="h-4 w-14" /><Skeleton className="h-3 w-12" /></div>
            <Skeleton className="mt-2.5 aspect-[4/5]" />
            <Skeleton className="mt-3 h-4 w-24" /><Skeleton className="mt-1.5 h-3 w-16" />
            <div className="mt-4 space-y-2"><Skeleton className="h-3" /><Skeleton className="h-5 w-3/4" /></div>
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
        <section aria-label={t("Cast roster")}>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="eyebrow flex items-center gap-1.5"><UserRound aria-hidden className="size-3.5" />{t("Cast roster")}<span className="mono text-mute">{pad(list.length)}</span></p>
            <span aria-hidden className="rm-rule h-px min-w-6 flex-1" />
            <p className="flex items-center gap-2 text-2xs text-dim">
              <span aria-hidden className="mono inline-flex h-4 items-center rounded border border-dashed border-line px-1 font-semibold text-dim/80">KN</span>
              {t("A dashed language still needs a voice.")}
            </p>
          </div>
          <div className={GRID}>
            {list.map((c, i) => (
              <CharacterCard key={c.id} c={c} index={i} languages={languages} onOpen={() => onOpen(c.id)}
                consent={consents?.some((r) => r.character_id === c.id && (!r.expires_on || r.expires_on >= today)) ? true : undefined} />
            ))}
            {canEdit && <AddTile index={list.length} adding={adding} onAdd={onAdd} />}
          </div>
        </section>
      )}
    </div>
  );
}

/** Identity status on top of a portrait (a dark chip, so it reads on any photo in both themes). */
function IdOverlay({ status }: { status: Character["identity"]["status"] }) {
  const t = useT();
  if (!status || status === "cancelled" || !(status in IDENTITY_STATUS)) return null;
  const busy = status === "training" || status === "preparing";
  const tone = status === "ready" ? "text-ok" : status === "failed" ? "text-bad" : "text-info";
  return (
    <span className="mono absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-1 text-2xs font-medium leading-none text-white backdrop-blur [&>svg]:size-3 [&>svg]:shrink-0">
      <span className={cn("grid place-items-center", tone)}>{busy ? <Loader2 className="animate-spin" /> : status === "failed" ? <X strokeWidth={3} /> : <ScanFace />}</span>
      ID<span className="sr-only">: </span><span className="font-sans">{t(IDENTITY_STATUS[status].label)}</span>
    </span>
  );
}

function CharacterCard({ c, index, languages, onOpen, consent }: { c: Character; index: number; languages: string[]; onOpen: () => void; consent?: boolean }) {
  const t = useT();
  const r = rise(index);
  const voiced = voicedLanguages(c.voices);
  const voicedN = languages.filter((l) => voiced.has(l)).length;
  const images = c.asset_count ?? c.assets?.length ?? 0;
  const v3 = c as CharacterV3;
  const strictness = v3.lock_effective?.strictness ?? v3.lock?.strictness;
  const known = typeof strictness === "number";
  const level = strictnessLevel(strictness);
  // the project cast payload carries costumes (and assets); the shared library list doesn't, so those are hidden there
  const costumes = v3.costumes?.length;
  const pack = Array.isArray(c.assets) ? packOf(c.assets) : null;
  return (
    <div {...r}>
      <button type="button" onClick={onOpen} aria-label={`${c.name}${c.role ? `, ${c.role}` : ""}`}
        className={cn("hud lift group relative flex h-full w-full flex-col rounded-xl border bg-panel text-left hover:border-accent/50", c.locked ? "border-warn/35" : "border-line")}>
        <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <span aria-hidden className="cs-slot absolute left-1/2 top-1 -translate-x-1/2" />

        <span className="flex items-center justify-between gap-2 px-3 pt-3.5">
          <IdChip tone={c.locked ? "accent" : "neutral"}>{code("CH", c.id)}</IdChip>
          <span className="flex items-center gap-2">
            {consent && <span title={t("Consent on file")} className="inline-flex text-ok"><ShieldCheck aria-hidden className="size-3.5" /><span className="sr-only">{t("Consent on file")}</span></span>}
            {c.locked ? (
              <span className="mono inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-amber-300"><Lock aria-hidden className="size-3" />{t("Locked")}</span>
            ) : (
              <span className="mono inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-dim"><PencilLine aria-hidden className="size-3" />{t("Draft")}</span>
            )}
          </span>
        </span>

        <span className="block px-3 pt-2.5">
          <Portrait src={c.avatar_url} name={c.name} avatar={64} ratio="aspect-[4/5]" imgClassName="transition-transform duration-500 ease-out group-hover:scale-[1.04]">
            <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/60 to-transparent" />
            <IdOverlay status={c.identity?.status} />
            {c.seedance_ready && <SeedanceBadge overlay className="absolute right-1.5 top-1.5" />}
          </Portrait>
        </span>

        <span className="block px-3 pt-2.5">
          <span className="block truncate text-sm font-semibold leading-tight" title={c.name}>{c.name}</span>
          <span className="mt-0.5 block truncate text-xs text-mute" title={c.role || undefined}>{c.role || "—"}</span>
        </span>

        <span className="mt-auto block space-y-2.5 px-3 pb-3 pt-3">
          <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1" title={t("Lock strictness")}>
            <span className="eyebrow">{t("Lock")}</span>
            <span className="flex items-center gap-2">
              <LockMeter strictness={strictness} className="w-10" />
              <span className={cn("mono text-2xs", known ? LEVEL_TEXT[level] : "text-dim")}>{known ? t(LEVEL_LABEL[level]) : "—"}</span>
            </span>
          </span>
          <span className="block space-y-1.5">
            <span className="flex items-center justify-between gap-2">
              <span className="eyebrow">{t("Voice")}</span>
              <span className="mono text-2xs text-dim">{voicedN}/{languages.length}</span>
            </span>
            <LangChips languages={languages} voiced={voiced} />
          </span>
          <span className="flex items-center gap-3 border-t border-dashed border-line pt-2 text-2xs text-mute">
            <span className="mono flex items-center gap-1" title={t("Reference images")}><Images aria-hidden className="size-3 shrink-0 text-dim" />{images}<span className="sr-only"> {t("Reference images")}</span></span>
            {costumes !== undefined && (
              <span className="mono flex items-center gap-1" title={t("Outfits")}><Shirt aria-hidden className="size-3 shrink-0 text-dim" />{costumes}<span className="sr-only"> {t("Outfits")}</span></span>
            )}
            {pack && (
              <span className="ml-auto flex min-w-0 max-w-[5.5rem] flex-1 items-center gap-1.5" title={t("pack {a}/{n}", { a: packDone(pack), n: pack.length })}>
                <PackBar pack={pack} className="flex-1" />
                <span className="mono shrink-0 text-dim">{packDone(pack)}/{pack.length}</span>
              </span>
            )}
          </span>
        </span>
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
    <form {...r} onSubmit={submit}
      className={cn("hud rm-scan flex min-h-[15rem] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line p-4 text-center transition-colors focus-within:border-accent/50 hover:border-dim/60", r.className)}>
      <span aria-hidden className="grid size-10 place-items-center rounded-lg border border-dashed border-dim/50 bg-raised text-mute"><Plus className="size-5" /></span>
      <div>
        <p className="eyebrow !text-mute">{t("Empty slot")}</p>
        <p className="mt-1.5 text-sm font-medium">{t("New character")}</p>
      </div>
      <Input placeholder={t("New character name")} aria-label={t("New character name")} value={name} onChange={(e) => setName(e.target.value)} className="text-center" />
      <Button type="submit" size="sm" loading={adding} icon={<Plus className="size-3.5" />}>{t("Add with photos…")}</Button>
    </form>
  );
}
