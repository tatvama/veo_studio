import { Lock } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useMyId, usePresence, viewLabel } from "../../lib/collab";
import { Avatar, Tooltip } from "../ui";

/** Teammates in this project right now, with where they are and what they're editing. */
export function PresenceBar({ projectId, shotCode }: { projectId: number; shotCode: (id: number) => string | undefined }) {
  const t = useT();
  const me = useMyId();
  const { projectId: pid, people, locks } = usePresence();
  if (pid !== projectId) return null;
  const others = people.filter((p) => p.user_id !== me);
  if (!others.length) return null;
  const what = (target: string) => {
    const [kind, id] = target.split(":");
    return kind === "shot" ? t("editing {code}", { code: shotCode(Number(id)) ?? t("a shot") }) : t("editing the shot list");
  };
  return (
    <div className="flex items-center -space-x-1.5" aria-label={t("Also here: {names}", { names: others.map((p) => p.name).join(", ") })}>
      {others.slice(0, 5).map((p) => {
        const theirs = locks.filter((l) => l.user_id === p.user_id);
        const tip = [p.name, p.views.map(viewLabel).join(" · "), ...theirs.map((l) => what(l.target))].filter(Boolean).join(" — ");
        return (
          <Tooltip key={p.user_id} content={tip} side="bottom">
            <span className="relative">
              <Avatar name={p.name} size={26} className="ring-2 ring-panel" />
              {theirs.length > 0 && (
                <span className="absolute -bottom-0.5 -right-0.5 grid size-3.5 place-items-center rounded-full bg-warn text-black ring-2 ring-panel">
                  <Lock className="size-2" strokeWidth={3} />
                </span>
              )}
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-ok ring-2 ring-panel" aria-hidden />
            </span>
          </Tooltip>
        );
      })}
      {others.length > 5 && <span className="grid size-[26px] place-items-center rounded-full bg-raised text-2xs font-semibold ring-2 ring-panel">+{others.length - 5}</span>}
    </div>
  );
}

/** Small "Ravi is editing" mark for a shot card. */
export function LockMark({ name, className }: { name: string; className?: string }) {
  const t = useT();
  return (
    <Tooltip content={t("{name} is editing this", { name })}>
      <span className={"inline-flex items-center gap-1 rounded-full bg-warn/90 px-1.5 py-0.5 text-2xs font-semibold text-black " + (className ?? "")}>
        <Lock className="size-2.5" strokeWidth={3} />{name.split(" ")[0]}
      </span>
    </Tooltip>
  );
}
