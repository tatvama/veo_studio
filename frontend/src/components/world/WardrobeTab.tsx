import { clsx } from "clsx";
import { AlertTriangle, ArrowRight, CheckCircle2, Shirt } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";
import type { Character } from "../../lib/types";
import { useWardrobe, type WardrobeRow } from "../../lib/v3";
import { LoadError, RoomEmpty } from "../room/kit";
import { Alert, Avatar, Badge, Skeleton, Tooltip } from "../ui";
import { SourceBadge } from "./badges";

/** Who wears what in every scene: rows = characters, columns = scenes. A break is an outfit change the script never asked for. */
export function WardrobeTab({ eid, pid, cast }: { eid: number; pid: number; cast: Character[] }) {
  const t = useT();
  const { data, isLoading, isError, refetch } = useWardrobe(eid);

  // the union of scenes, in order (a character may skip scenes)
  const scenes = useMemo(() => {
    const m = new Map<number, { scene_id: number; order: number; title: string }>();
    for (const c of data?.characters ?? []) for (const r of c.scenes) if (!m.has(r.scene_id)) m.set(r.scene_id, { scene_id: r.scene_id, order: r.order, title: r.title });
    return [...m.values()].sort((a, b) => a.order - b.order || a.scene_id - b.scene_id);
  }, [data]);

  if (isError && !data) return <LoadError what={t("Couldn't load the wardrobe timeline")} onRetry={() => refetch()} />;
  if (isLoading || !data) return <WardrobeSkeleton />;
  if (!data.characters.length || !scenes.length) {
    return (
      <RoomEmpty icon={<Shirt />} title={t("No wardrobe to show yet")}
        sub={t("The timeline reads outfits from the scene cards, the shots and the Continuity Bible. Plan scenes and set wardrobe on the cards first.")}
        action={<Link to={`/p/${pid}/scenes`} className="inline-flex items-center gap-1 text-sm font-medium text-accent-ink hover:underline">{t("Go to Scenes")}<ArrowRight className="size-4" /></Link>} />
    );
  }

  const breakList = data.characters.flatMap((c) => c.scenes.filter((r) => r.break).map((r) => ({ name: c.name, row: r })));

  return (
    <div className="space-y-4">
      {data.breaks > 0 ? (
        <Alert tone="warn" title={data.breaks === 1 ? t("1 wardrobe break") : t("{n} wardrobe breaks", { n: data.breaks })}>
          <span>{t("An outfit changed between scenes without the script saying so. Set the outfit on the scene card, or note the change in the card's continuity notes.")}</span>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {breakList.slice(0, 8).map(({ name, row }) => (
              <li key={`${name}-${row.scene_id}`} className="inline-flex items-center gap-1 text-amber-300">
                <AlertTriangle className="size-3" />{name} · {sceneCode(row.order)} {row.outfit ? `→ ${row.outfit}` : ""}
              </li>
            ))}
            {breakList.length > 8 && <li className="text-dim">+{breakList.length - 8}</li>}
          </ul>
        </Alert>
      ) : (
        <p className="flex items-center gap-2 text-sm text-green-300"><CheckCircle2 className="size-4" />{t("No wardrobe breaks: every outfit change is in the script.")}</p>
      )}

      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-raised text-2xs uppercase tracking-wide text-dim">
            <tr>
              <th scope="col" className="sticky left-0 z-[2] min-w-40 bg-raised px-3 py-2 text-left font-medium">{t("Character")}</th>
              {scenes.map((s) => (
                <th key={s.scene_id} scope="col" className="min-w-36 px-3 py-2 text-left font-medium">
                  <span className="font-mono">{sceneCode(s.order)}</span>
                  {s.title && <span className="ml-1.5 block max-w-40 truncate normal-case tracking-normal text-mute" title={s.title}>{s.title}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.characters.map((c) => {
              const person = cast.find((x) => x.id === c.character_id);
              const byScene = new Map(c.scenes.map((r) => [r.scene_id, r]));
              return (
                <tr key={c.character_id} className="border-t border-line/70 align-top">
                  <th scope="row" className="sticky left-0 z-[1] bg-panel px-3 py-2 text-left font-medium">
                    <span className="flex items-center gap-2"><Avatar name={c.name} src={person?.avatar_url || undefined} size={24} ring /><span className="truncate">{c.name}</span></span>
                  </th>
                  {scenes.map((s) => <Cell key={s.scene_id} row={byScene.get(s.scene_id)} />)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-2xs text-dim">{t("Source: where the outfit was read from. 'mixed' means the shots of that scene disagree with each other.")}</p>
    </div>
  );
}

const sceneCode = (order: number) => `SC${String(order + 1).padStart(2, "0")}`;

function Cell({ row }: { row: WardrobeRow | undefined }) {
  const t = useT();
  if (!row) return <td className="px-3 py-2 text-dim" aria-label={t("Not in this scene")}>—</td>;
  const body = (
    <div className={clsx("min-w-0 rounded-lg border px-2 py-1.5 transition-colors",
      row.break ? "border-warn/50 bg-warn/10" : row.change ? "border-info/30 bg-info/6" : "border-transparent")}>
      <p className={clsx("flex items-center gap-1 truncate text-xs", row.outfit ? "font-medium text-ink" : "text-dim")} title={row.outfit || undefined}>
        {row.break && <AlertTriangle className="size-3 shrink-0 text-warn" />}
        {row.outfit || t("default look")}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-1">
        <SourceBadge source={row.source} />
        {row.mixed && <Badge tone="warn" title={t("The shots of this scene give this character different outfits")}>{t("mixed")}</Badge>}
        {row.change && !row.break && <Badge tone="info" title={t("Outfit changed here, as the script says")}>{t("change")}</Badge>}
      </p>
    </div>
  );
  return (
    <td className="px-1.5 py-1.5">
      {row.break ? <Tooltip content={t("Changed without the script saying so")}><div tabIndex={0} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60">{body}</div></Tooltip> : body}
    </td>
  );
}

function WardrobeSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-10 w-full max-w-md" />
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex gap-3 bg-raised px-3 py-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-3 w-24" />)}</div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 border-t border-line/70 px-3 py-3">
            <Skeleton className="size-6 !rounded-full" /><Skeleton className="h-3 w-20" />
            {Array.from({ length: 4 }, (_, k) => <Skeleton key={k} className="h-8 w-28" />)}
          </div>
        ))}
      </div>
    </div>
  );
}
