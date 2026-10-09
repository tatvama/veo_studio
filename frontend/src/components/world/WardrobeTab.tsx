import { AlertTriangle, ArrowRight, CheckCircle2, Shirt } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { Character } from "../../lib/types";
import { useWardrobe, type WardrobeRow } from "../../lib/v3";
import { LoadError, RoomEmpty } from "../room/kit";
import { TONE_TEXT_SM } from "../room/util";
import { WorkPanel, code, sceneCode } from "../room/workspace";
import { Alert, Avatar, Badge, Skeleton, Tag, Tooltip } from "../ui";
import { SourceBadge } from "./badges";
import "../../styles/board.css";

/**
 * Who wears what in every scene: rows = characters, columns = scenes. A break is an outfit change the script never asked for.
 * The matrix scrolls inside its own frame, so the header row and the character column both stay put.
 */
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
  const changes = data.characters.reduce((a, c) => a + c.scenes.filter((r) => r.change).length, 0);

  return (
    <WorkPanel flush icon={<Shirt />} kicker={t("Timeline")} title={t("Wardrobe")}
      description={t("Who wears what in every scene. Read from the scene cards, the shots and the Continuity Bible.")}>
      {/* the summary: how big the matrix is, how much changes, how much is wrong */}
      <div className="space-y-3 px-4 pb-4 pt-4 @md:px-5">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Wardrobe summary")}>
          <Tag k={t("Characters")}>{data.characters.length}</Tag>
          <Tag k={t("Scenes")}>{scenes.length}</Tag>
          <Tag k={t("Changes")} tone="info">{changes}</Tag>
          <Tag k={t("Breaks")} tone={data.breaks > 0 ? "warn" : "ok"}>{data.breaks}</Tag>
        </div>
        {data.breaks > 0 ? (
          <Alert tone="warn" title={data.breaks === 1 ? t("1 wardrobe break") : t("{n} wardrobe breaks", { n: data.breaks })}>
            <span>{t("An outfit changed between scenes without the script saying so. Set the outfit on the scene card, or note the change in the card's continuity notes.")}</span>
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {breakList.slice(0, 8).map(({ name, row }) => (
                <li key={`${name}-${row.scene_id}`} className={cn("inline-flex items-center gap-1", TONE_TEXT_SM.warn)}>
                  <AlertTriangle className="size-3" />{name} · <span className="mono">{sceneCode(row.order)}</span> {row.outfit ? `→ ${row.outfit}` : ""}
                </li>
              ))}
              {breakList.length > 8 && <li className="mono text-dim">+{breakList.length - 8}</li>}
            </ul>
          </Alert>
        ) : (
          <p className={cn("flex items-center gap-2 text-sm", TONE_TEXT_SM.ok)}><CheckCircle2 className="size-4" />{t("No wardrobe breaks: every outfit change is in the script.")}</p>
        )}
      </div>

      {/* the matrix: its own scroll frame so the sticky header and the sticky first column both work */}
      <div className="rm-matrix max-h-[70vh] overflow-auto border-t border-line" tabIndex={0} role="region" aria-label={t("Wardrobe timeline")}>
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th scope="col" className="min-w-44 border-b border-r bg-raised px-3 py-2 text-left font-normal"><span className="eyebrow">{t("Character")}</span></th>
              {scenes.map((s) => (
                <th key={s.scene_id} scope="col" className="min-w-40 border-b border-r bg-raised px-3 py-2 text-left font-normal">
                  <span className="mono text-2xs font-semibold tracking-wider text-accent-ink">{sceneCode(s.order)}</span>
                  {s.title && <span className="mt-1 block max-w-44 truncate font-medium normal-case text-mute" title={s.title}>{s.title}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.characters.map((c) => {
              const person = cast.find((x) => x.id === c.character_id);
              const byScene = new Map(c.scenes.map((r) => [r.scene_id, r]));
              return (
                <tr key={c.character_id} className="align-top">
                  <th scope="row" className="border-b border-r bg-panel px-3 py-2 text-left font-normal">
                    <span className="flex items-center gap-2">
                      <Avatar name={c.name} src={person?.avatar_url || undefined} size={28} ring />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        <span className="mono block text-2xs text-dim">{code("CH", c.character_id)}</span>
                      </span>
                    </span>
                  </th>
                  {scenes.map((s) => <Cell key={s.scene_id} row={byScene.get(s.scene_id)} />)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-4 py-3 text-2xs text-dim @md:px-5">{t("Source: where the outfit was read from. 'mixed' means the shots of that scene disagree with each other.")}</p>
    </WorkPanel>
  );
}

function Cell({ row }: { row: WardrobeRow | undefined }) {
  const t = useT();
  if (!row) return <td className="mono border-b border-r px-3 py-2 text-dim" aria-label={t("Not in this scene")}>—</td>;
  const body = (
    <div className={cn("min-w-0 rounded-lg border px-2 py-1.5 transition-colors",
      row.break ? "rm-break border-transparent bg-warn/10" : row.change ? "border-info/30 bg-info/6" : "border-transparent")}>
      <p className={cn("flex items-center gap-1 truncate text-xs", row.outfit ? "font-medium text-ink" : "text-dim")} title={row.outfit || undefined}>
        {row.break && <AlertTriangle aria-hidden className="size-3 shrink-0 text-warn" />}
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
    <td className="border-b border-r p-1.5">
      {row.break ? <Tooltip content={t("Changed without the script saying so")}><div tabIndex={0} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60">{body}</div></Tooltip> : body}
    </td>
  );
}

function WardrobeSkeleton() {
  return (
    <div className="hud relative rounded-xl border border-line bg-panel" aria-busy="true">
      <div className="space-y-2 p-5"><Skeleton className="h-3 w-24" /><Skeleton className="h-4 w-32" /><Skeleton className="mt-3 h-6 w-full max-w-md" /></div>
      <div className="border-t border-line">
        <div className="flex gap-3 bg-raised px-3 py-2.5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-3 w-24" />)}</div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 border-t border-line px-3 py-3">
            <Skeleton className="size-7 rounded-full!" /><Skeleton className="h-3 w-20" />
            {Array.from({ length: 4 }, (_, k) => <Skeleton key={k} className="h-9 w-28" />)}
          </div>
        ))}
      </div>
    </div>
  );
}
