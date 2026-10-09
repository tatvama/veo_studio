import { ArrowRight, ArrowUpRight, BookMarked, Package, Shirt } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { Character } from "../../lib/types";
import { useContinuityBible, useProps, type BibleScene } from "../../lib/v3";
import { LoadError, RoomEmpty } from "../room/kit";
import { IdChip, sceneCode } from "../room/workspace";
import { Avatar, Meter, Skeleton, Tag, rise } from "../ui";
import { EndStateBlock, endStateEmpty } from "./EndState";
import "../../styles/board.css";

/**
 * The Continuity Bible: one row-panel per scene on a vertical timeline. Each row reads left to right: which scene it is,
 * what is worn and in play, and the state of the world at the end of the scene (AI-written or by hand).
 */
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
  const cells = Math.max(1, Math.min(scenes.length, 24));
  const lit = written ? Math.max(1, Math.round((written / scenes.length) * cells)) : 0;

  return (
    <div className="space-y-4">
      <section className="hud relative flex flex-wrap items-center gap-x-6 gap-y-2.5 rounded-xl border border-line bg-panel px-4 py-3.5">
        <Meter className="w-36 shrink-0" filled={lit} total={cells} tone={written === scenes.length ? "ok" : "accent"} />
        <p className="min-w-0 flex-1 basis-72 text-sm text-mute">
          <span className="mono text-ink">{t("{a}/{n} scenes have an end state.", { a: written, n: scenes.length })}</span>{" "}
          {t("Each one feeds the next scene's prompts, so a wet shirt stays wet and a lamp stays where it was put.")}
        </p>
      </section>

      <ol className="relative" aria-label={t("Continuity Bible")}>
        {scenes.map((s, i) => (
          <SceneRow key={s.id} s={s} index={i} first={i === 0} last={i === scenes.length - 1} only={scenes.length === 1}
            eid={eid} pid={pid} cast={cast} canEdit={canEdit} propNames={props ?? []} />
        ))}
      </ol>
    </div>
  );
}

function SceneRow({ s, index, first, last, only, eid, pid, cast, canEdit, propNames }: {
  s: BibleScene; index: number; first: boolean; last: boolean; only: boolean; eid: number; pid: number; cast: Character[]; canEdit: boolean;
  propNames: { id: number; name: string }[];
}) {
  const t = useT();
  const r = rise(index);
  const wardrobe = Object.entries(s.wardrobe ?? {}).filter(([, v]) => !!v);
  const linked = (s.prop_ids ?? []).map((id) => propNames.find((p) => p.id === id)?.name).filter(Boolean) as string[];
  const allProps = [...linked, ...(s.props ?? []).filter((p) => !linked.includes(p))];
  const done = !endStateEmpty(s.end_state);
  return (
    <li {...r} className={cn("relative pb-4 pl-8 last:pb-0", r.className)}>
      {/* the timeline: a dashed rule down the gutter with a node at every scene (lit once the scene has an end state) */}
      {!only && <span aria-hidden className={cn("rm-rule-y absolute left-[0.7rem] w-px", first ? "top-[1.75rem]" : "top-0", last ? "h-[1.75rem]" : "bottom-0")} />}
      <span aria-hidden className={cn("bd-node absolute left-[0.45rem] top-[1.44rem] size-2.5 rounded-full border-2 transition-colors",
        done ? "border-accent bg-accent shadow-[0_0_8px_var(--color-accent)]" : "border-dim bg-bg")} />
      <span aria-hidden className="absolute left-[0.95rem] top-[1.75rem] h-px w-[0.8rem] bg-line" />

      <article className="@container hud group/scene relative min-w-0 rounded-xl border border-line bg-panel">
        <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-0 transition-opacity duration-300 group-hover/scene:opacity-100" />
        <div className="grid @3xl:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1.3fr)]">
          {/* scene: code, title, link */}
          <header className="flex min-w-0 flex-col items-start gap-2 p-4">
            <IdChip tone="accent" className="h-6 px-2 text-xs">{sceneCode(s.order)}</IdChip>
            <h3 className="text-sm font-semibold leading-snug tracking-tight" title={s.title}>{s.title || t("Untitled scene")}</h3>
            <div className="flex flex-wrap gap-1">
              <Tag k={t("Wardrobe")}>{wardrobe.length}</Tag>
              <Tag k={t("Props")}>{allProps.length}</Tag>
            </div>
            <Link to={`/p/${pid}/scenes#scene-${s.id}`}
              className="mt-auto inline-flex items-center gap-0.5 rounded text-2xs font-medium text-accent-ink hover:underline pointer-coarse:min-h-10 pointer-coarse:items-center">
              {t("Scene card")}<ArrowUpRight aria-hidden className="size-3" />
            </Link>
          </header>

          {/* what is worn and what is in play */}
          <div className="min-w-0 space-y-4 border-t border-line p-4 @3xl:border-l @3xl:border-t-0">
            <section>
              <h4 className="eyebrow mb-2 flex items-center gap-1.5"><Shirt className="size-3.5" />{t("Wardrobe")}</h4>
              {wardrobe.length ? (
                <ul className="space-y-1.5">
                  {wardrobe.map(([cid, outfit]) => {
                    const person = cast.find((c) => String(c.id) === cid);
                    return (
                      <li key={cid} className="flex items-center gap-2 text-xs">
                        <Avatar name={person?.name ?? cid} src={person?.avatar_url || undefined} size={20} />
                        <span className="shrink-0 font-medium">{person?.name ?? cid}</span><span className="min-w-0 truncate text-mute">· {outfit}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="text-xs text-dim">{t("No outfits set on the scene card.")}</p>}
            </section>
            <section>
              <h4 className="eyebrow mb-2 flex items-center gap-1.5"><Package className="size-3.5" />{t("Props")}</h4>
              {allProps.length ? (
                <div className="flex flex-wrap gap-1">
                  {allProps.map((p) => <span key={p} className="rounded-md border border-line bg-raised px-1.5 py-0.5 text-2xs text-mute">{p}</span>)}
                </div>
              ) : <p className="text-xs text-dim">{t("No props in this scene.")}</p>}
            </section>
          </div>

          {/* the state of the world at the end of the scene */}
          <section className="min-w-0 border-t border-line p-4 @3xl:border-l @3xl:border-t-0">
            <h4 className="eyebrow mb-2 flex items-center gap-1.5"><BookMarked className="size-3.5" />{t("End of scene")}</h4>
            <EndStateBlock sceneId={s.id} eid={eid} state={s.end_state} cast={cast} canEdit={canEdit} />
          </section>
        </div>
      </article>
    </li>
  );
}

function BibleSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-14 w-full" />
      <div className="space-y-4 pl-8">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="grid rounded-xl border border-line bg-panel @3xl:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1.3fr)]">
            <div className="space-y-2 p-4"><Skeleton className="h-5 w-12" /><Skeleton className="h-4 w-32" /></div>
            <div className="space-y-2 border-t border-line p-4 @3xl:border-l @3xl:border-t-0"><Skeleton className="h-3 w-20" /><Skeleton className="h-5 w-44" /><Skeleton className="h-3 w-16" /></div>
            <div className="space-y-2 border-t border-line p-4 @3xl:border-l @3xl:border-t-0"><Skeleton className="h-3 w-24" /><Skeleton className="h-16 w-full" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
