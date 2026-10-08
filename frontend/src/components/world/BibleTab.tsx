import { clsx } from "clsx";
import { ArrowRight, BookMarked, Package, Shirt } from "lucide-react";
import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";
import type { Character } from "../../lib/types";
import { useContinuityBible, useProps, type BibleScene } from "../../lib/v3";
import { LoadError, RoomEmpty } from "../room/kit";
import { Avatar, Skeleton, rise } from "../ui";
import { EndStateBlock, endStateEmpty } from "./EndState";

/** One card per scene: wardrobe, props and the state of the world at the end of the scene (AI-written or by hand). */
export function BibleTab({ eid, pid, cast, canEdit }: { eid: number; pid: number; cast: Character[]; canEdit: boolean }) {
  const t = useT();
  const { data, isLoading, isError, refetch } = useContinuityBible(eid);
  const { data: props } = useProps(pid);

  if (isError && !data) return <LoadError what={t("Couldn't load the Continuity Bible")} onRetry={() => refetch()} />;
  if (isLoading || !data) return <BibleSkeleton />;
  if (!data.scenes.length) {
    return (
      <RoomEmpty icon={<BookMarked />} title={t("No scenes yet")} sub={t("The Continuity Bible follows the scene cards. Plan scenes first.")}
        action={<Link to={`/p/${pid}/scenes`} className="inline-flex items-center gap-1 text-sm font-medium text-accent-ink hover:underline">{t("Go to Scenes")}<ArrowRight className="size-4" /></Link>} />
    );
  }
  const written = data.scenes.filter((s) => !endStateEmpty(s.end_state)).length;
  const scenes = data.scenes.slice().sort((a, b) => a.order - b.order || a.id - b.id);

  return (
    <div className="space-y-4">
      <p className="text-sm text-mute">
        {t("{a}/{n} scenes have an end state.", { a: written, n: scenes.length })}{" "}
        {t("Each one feeds the next scene's prompts, so a wet shirt stays wet and a lamp stays where it was put.")}
      </p>
      <ul className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,24rem),1fr))]">
        {scenes.map((s, i) => <SceneBibleCard key={s.id} s={s} index={i} eid={eid} pid={pid} cast={cast} canEdit={canEdit} propNames={props ?? []} />)}
      </ul>
    </div>
  );
}

function SceneBibleCard({ s, index, eid, pid, cast, canEdit, propNames }: {
  s: BibleScene; index: number; eid: number; pid: number; cast: Character[]; canEdit: boolean; propNames: { id: number; name: string }[];
}) {
  const t = useT();
  const r = rise(index);
  const wardrobe = Object.entries(s.wardrobe ?? {}).filter(([, v]) => !!v);
  const linked = (s.prop_ids ?? []).map((id) => propNames.find((p) => p.id === id)?.name).filter(Boolean) as string[];
  const allProps = [...linked, ...(s.props ?? []).filter((p) => !linked.includes(p))];
  return (
    <li {...r} className={clsx("@container rounded-xl border border-line bg-panel", r.className)}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 font-mono text-2xs font-semibold text-mute">SC{String(s.order + 1).padStart(2, "0")}</span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight" title={s.title}>{s.title || t("Untitled scene")}</h3>
        <Link to={`/p/${pid}/scenes#scene-${s.id}`} className="text-2xs font-medium text-accent-ink hover:underline">{t("Scene card")}</Link>
      </header>
      <div className="space-y-4 p-4">
        <section>
          <h4 className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-dim"><Shirt className="size-3.5" />{t("Wardrobe")}</h4>
          {wardrobe.length ? (
            <ul className="space-y-1">
              {wardrobe.map(([cid, outfit]) => {
                const person = cast.find((c) => String(c.id) === cid);
                return (
                  <li key={cid} className="flex items-center gap-2 text-xs">
                    <Avatar name={person?.name ?? cid} src={person?.avatar_url || undefined} size={20} />
                    <span className="font-medium">{person?.name ?? cid}</span><span className="truncate text-mute">· {outfit}</span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-xs text-dim">{t("No outfits set on the scene card.")}</p>}
        </section>
        <section>
          <h4 className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-dim"><Package className="size-3.5" />{t("Props")}</h4>
          {allProps.length ? (
            <div className="flex flex-wrap gap-1">
              {allProps.map((p) => <span key={p} className="rounded-md border border-line bg-raised px-1.5 py-0.5 text-2xs text-mute">{p}</span>)}
            </div>
          ) : <p className="text-xs text-dim">{t("No props in this scene.")}</p>}
        </section>
        <section className="border-t border-line pt-3">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-dim"><BookMarked className="size-3.5" />{t("End of scene")}</h4>
          <EndStateBlock sceneId={s.id} eid={eid} state={s.end_state} cast={cast} canEdit={canEdit} />
        </section>
      </div>
    </li>
  );
}

function BibleSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,24rem),1fr))]">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="rounded-xl border border-line bg-panel">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3"><Skeleton className="h-5 w-10" /><Skeleton className="h-4 w-40" /></div>
            <div className="space-y-3 p-4"><Skeleton className="h-3 w-24" /><Skeleton className="h-5 w-48" /><Skeleton className="h-3 w-20" /><Skeleton className="h-16 w-full" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
