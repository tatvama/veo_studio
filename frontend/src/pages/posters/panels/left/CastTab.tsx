/** Cast tab: the film's characters and their approved reference images, ready to drop in; "Pose with AI" per character. */
import { BookUser, Lock, Users, Wand2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Avatar, Badge, Button, Skeleton } from "../../../../components/ui";
import { useT } from "../../../../lib/i18n";
import { useCharacters } from "../../../../lib/queries";
import { useEditor } from "../../store";
import { approvedImages, assetLabel, type CastAsset, type CastCharacter } from "./cast";
import { useLeft } from "./state";
import { DragItem, Hint, LazyMount, recordSize, Section, sizeOf } from "./ui";

export default function CastTab({ projectId }: { projectId: number | null }) {
  const t = useT();
  const chars = useCharacters(projectId ?? undefined);
  const cast = (projectId ? chars.data ?? [] : []) as CastCharacter[];

  if (!projectId) {
    return (
      <Section title={t("Cast")} icon={<Users />}>
        <EmptyCast title={t("This design isn't part of a project")}
          sub={t("Designs made inside a project can drop in that film's locked characters. You can still paint a person with the AI tab.")} />
      </Section>
    );
  }
  if (chars.isLoading) {
    return (
      <Section title={t("Cast")} icon={<Users />}>
        <div className="space-y-3">{[0, 1].map((i) => <div key={i} className="space-y-2"><Skeleton className="h-9" /><div className="grid grid-cols-3 gap-1.5">{[0, 1, 2].map((j) => <Skeleton key={j} className="aspect-[3/4]" />)}</div></div>)}</div>
      </Section>
    );
  }
  if (!cast.length) {
    return (
      <Section title={t("Cast")} icon={<Users />}>
        <EmptyCast title={t("No characters in this project yet")}
          sub={t("Create the cast in the project's Bible: once their looks are approved they show up here, ready to drag onto the poster.")}
          action={<Link to={`/p/${projectId}/bible`}><Button size="sm" variant="secondary" icon={<BookUser className="size-3.5" />}>{t("Open the Bible")}</Button></Link>} />
      </Section>
    );
  }
  return (
    <>
      {cast.map((c) => <CharacterBlock key={c.id} c={c} projectId={projectId} />)}
      <div className="p-3">
        <Hint>{t("Drag a look onto the canvas or onto an empty frame. Only approved images are listed; manage them in the")}{" "}
          <Link to={`/p/${projectId}/bible`} className="font-medium text-accent-ink hover:underline">{t("Bible")}</Link>.</Hint>
      </div>
    </>
  );
}

function CharacterBlock({ c, projectId }: { c: CastCharacter; projectId: number }) {
  const t = useT();
  const images = approvedImages(c);
  const pose = () => {
    const left = useLeft.getState();
    left.setAiMode("character");
    left.setAiCharacter(c.id);
    useEditor.getState().setLeftTab("ai");
  };
  return (
    <Section
      title={<span className="font-sans text-xs font-semibold normal-case tracking-normal text-ink">{c.name}</span>}
      icon={<Avatar name={c.name} src={c.avatar_url || undefined} size={18} />}
      actions={<>
        {c.locked && <Badge tone="ok" title={t("Character Lock: the face stays the same in every image")}><Lock className="size-2.5" />{t("Locked")}</Badge>}
        <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5 text-ai" />} onClick={pose} className="h-6 px-1.5 text-2xs">{t("Pose with AI")}</Button>
      </>}
    >
      {c.role && <p className="-mt-1 mb-2 truncate text-2xs text-dim">{c.role}</p>}
      {images.length ? (
        <div className="grid grid-cols-3 gap-1.5">
          {images.map((a) => <LookTile key={a.id} c={c} a={a} />)}
        </div>
      ) : (
        <Hint>
          {t("No approved looks yet.")}{" "}
          <Link to={`/p/${projectId}/bible`} className="font-medium text-accent-ink hover:underline">{t("Approve some in the Bible")}</Link>
          {t(", or pose them with AI.")}
        </Hint>
      )}
    </Section>
  );
}

function LookTile({ c, a }: { c: CastCharacter; a: CastAsset }) {
  const t = useT();
  const label = assetLabel(a);
  return (
    <DragItem
      label={t("Add {name}", { name: `${c.name} · ${label}` })}
      tip={label}
      tipSide="top"
      payload={() => {
        const d = sizeOf(a.url) ?? { w: 768, h: 1024 };
        return { kind: "image", src: a.url, asset: a.path, width: d.w, height: d.h, role: "character", name: `${c.name} · ${label}` };
      }}
      className="group relative block overflow-hidden rounded-lg border border-line bg-raised transition-colors hover:border-accent/40"
    >
      <LazyMount className="aspect-[3/4]" placeholder={<Skeleton className="size-full rounded-none" />}>
        <img data-ghost src={a.url} alt={label} loading="lazy" draggable={false} onLoad={recordSize(a.url)}
          className="size-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.04]" />
      </LazyMount>
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-panel/85 px-1 py-0.5 text-center text-2xs text-mute backdrop-blur">{label}</span>
    </DragItem>
  );
}

function EmptyCast({ title, sub, action }: { title: string; sub: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <span className="grid size-10 place-items-center rounded-xl border border-line bg-raised text-dim"><Users className="size-5" /></span>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="text-xs leading-relaxed text-mute">{sub}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
