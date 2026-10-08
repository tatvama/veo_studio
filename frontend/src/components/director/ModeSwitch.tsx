import { clsx } from "clsx";
import { BadgeCheck, Handshake } from "lucide-react";
import { motion } from "motion/react";
import { useId } from "react";
import { useT } from "../../lib/i18n";

export type AgentMode = "copilot" | "autopilot";

const SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

/**
 * How the Director handles paid work you ask for in chat: "Ask me first" (shows the cost, waits for your OK) or
 * "Auto-approve" (starts within the budget). Not the same as an Autopilot run, which is started from the Brief.
 */
export function ModeSwitch({ mode, onChange, disabled }: { mode: AgentMode; onChange: (m: AgentMode) => void; disabled?: boolean }) {
  const t = useT();
  const id = useId();
  const options: { value: AgentMode; label: string; icon: typeof Handshake }[] = [
    { value: "copilot", label: t("Ask me first"), icon: Handshake },
    { value: "autopilot", label: t("Auto-approve"), icon: BadgeCheck },
  ];
  return (
    <div role="radiogroup" aria-label={t("Director chat approvals:")} className={clsx("flex rounded-lg border border-line bg-bg/60 p-0.5", disabled && "opacity-60")}>
      {options.map((o) => {
        const on = mode === o.value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => !on && onChange(o.value)}
            className={clsx(
              "relative flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors disabled:cursor-not-allowed",
              on ? "text-ink" : "text-mute hover:text-ink",
            )}
          >
            {on && <motion.span layoutId={`mode-${id}`} transition={SPRING} className="absolute inset-0 rounded-md bg-raised shadow-sm ring-1 ring-inset ring-line" />}
            <Icon className={clsx("relative size-3.5 transition-colors", on && "text-accent-ink")} />
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
