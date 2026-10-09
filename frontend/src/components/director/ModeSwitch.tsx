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
 * A two-way segmented control; the lit segment is violet because the switch belongs to the Director.
 */
export function ModeSwitch({ mode, onChange, disabled }: { mode: AgentMode; onChange: (m: AgentMode) => void; disabled?: boolean }) {
  const t = useT();
  const id = useId();
  const options: { value: AgentMode; label: string; icon: typeof Handshake }[] = [
    { value: "copilot", label: t("Ask me first"), icon: Handshake },
    { value: "autopilot", label: t("Auto-approve"), icon: BadgeCheck },
  ];
  return (
    <div role="radiogroup" aria-label={t("Director chat approvals:")} className={clsx("grid grid-cols-2 gap-0.5 rounded-lg border border-line bg-bg/60 p-0.5", disabled && "opacity-60")}>
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
              "relative flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed max-sm:h-10",
              on ? "text-ai" : "text-mute hover:text-ink",
            )}
          >
            {on && (
              <motion.span layoutId={`mode-${id}`} transition={SPRING}
                className="absolute inset-0 rounded-md border border-ai/35 bg-ai/12 shadow-[0_0_14px_-6px_var(--color-ai)]" />
            )}
            <Icon className="relative size-3.5 shrink-0" />
            <span className="relative truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
