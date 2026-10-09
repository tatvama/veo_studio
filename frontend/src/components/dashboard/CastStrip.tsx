import { ArrowRight, Lock, LockOpen, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { Character } from "../../lib/types";
import { RoomEmpty } from "../room/kit";
import { Avatar, Meter, Panel } from "../ui";

const MAX = 14;

/** The project's cast as avatars. A lock means the face, body and voice are fixed so every shot keeps the same character. */
export function CastStrip({ pid, cast, index, className }: { pid: number; cast: Character[]; index?: number; className?: string }) {
  const t = useT();
  const locked = cast.filter((c) => c.locked).length;
  const shown = cast.slice(0, MAX);
  const link = <Link to={`/p/${pid}/bible`} className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">{t("Bible")}<ArrowRight className="size-3.5" /></Link>;

  return (
    <Panel index={index} className={className} eyebrow={t("Cast")} icon={<Users />} actions={link}>
      {!cast.length ? (
        <RoomEmpty icon={<Users />} title={t("No characters yet")} sub={t("Create the people of the story once; every shot keeps them looking the same.")}
          action={<Link to={`/p/${pid}/bible`} className="btn-primary inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-medium">{t("Open the bible")}</Link>} />
      ) : (
        <div className="@container"><div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-center">
          <div className="shrink-0 @2xl:w-44">
            <p className="mono flex items-baseline gap-1.5 text-[1.65rem] font-medium leading-none tracking-tight">
              {locked}<span className="text-sm font-normal text-dim">/ {cast.length} {t("locked")}</span>
            </p>
            <Meter className="mt-3" filled={locked} total={Math.min(cast.length, 12)} tone={locked === cast.length ? "ok" : "accent"} />
          </div>
          <ul className="flex min-w-0 flex-1 flex-wrap gap-2" aria-label={t("Cast")}>
            {shown.map((c) => (
              <li key={c.id}>
                <Link to={`/p/${pid}/bible`} title={`${c.name} · ${c.locked ? t("Locked") : t("Not locked yet")}`}
                  className="group/cast flex w-[4.75rem] flex-col items-center gap-1.5 rounded-lg border border-transparent p-1.5 text-center outline-none transition-colors hover:border-line hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-accent/50">
                  <span className="relative">
                    <Avatar name={c.name} src={c.avatar_url || undefined} size={40} className={cn("ring-1 ring-line", !c.locked && "opacity-80")} />
                    <span className={cn("absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full ring-2 ring-panel",
                      c.locked ? "bg-ok text-[var(--on-accent)]" : "bg-raised text-dim")}>
                      {c.locked ? <Lock className="size-2.5" strokeWidth={3} aria-label={t("Locked")} /> : <LockOpen className="size-2.5" strokeWidth={3} aria-label={t("Not locked yet")} />}
                    </span>
                  </span>
                  <span className="w-full min-w-0">
                    <span className="block truncate text-xs font-medium">{c.name}</span>
                    <span className="mono block truncate text-2xs uppercase tracking-wider text-dim">{c.role || (c.locked ? t("Locked") : t("Open"))}</span>
                  </span>
                </Link>
              </li>
            ))}
            {cast.length > MAX && (
              <li className="grid w-[4.75rem] place-items-center"><Link to={`/p/${pid}/bible`} className="mono text-2xs text-accent-ink hover:underline">+{cast.length - MAX}</Link></li>
            )}
          </ul>
        </div></div>
      )}
    </Panel>
  );
}
