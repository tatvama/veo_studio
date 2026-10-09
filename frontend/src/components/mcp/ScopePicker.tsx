/** What an MCP app may do in Tatvam: the three scopes, shared by Settings → MCP access and the OAuth consent page. */
import { clsx } from "clsx";
import { Check, Lock, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "../../lib/i18n";
import type { McpScope } from "../../lib/types";

export const MCP_SCOPES: { value: McpScope; label: string; desc: string }[] = [
  { value: "read", label: "Read", desc: "Look at projects, scripts, storyboards and jobs." },
  { value: "write", label: "Write", desc: "Change scripts, scenes and shots, run AI writing, and propose paid work (nothing is spent)." },
  { value: "spend", label: "Spend", desc: "Approve proposals and start paid work (budget limits still apply)." },
];

/** Keep a scope list consistent with the server: read is always in, spend brings write along, and the order is fixed. */
export function tidyScopes(picked: McpScope[], allowed: McpScope[]): McpScope[] {
  const s = new Set<McpScope>(picked.filter((x) => allowed.includes(x)));
  s.add("read");
  if (s.has("spend") && allowed.includes("write")) s.add("write");
  return MCP_SCOPES.map((o) => o.value).filter((v) => s.has(v));
}

/**
 * Tick boxes for the scopes in `options` (in the standard order). Read is always on; a scope outside `allowed` is shown
 * but can't be ticked. Ticking spend ticks write too, unticking write unticks spend. Ticking spend shows a warning.
 */
export function ScopePicker({ options, allowed, value, onChange, disabled, ariaLabel }: {
  options: McpScope[]; allowed: McpScope[]; value: McpScope[]; onChange: (v: McpScope[]) => void; disabled?: boolean; ariaLabel: string;
}) {
  const t = useT();
  const toggle = (s: McpScope) => {
    if (s === "read") return;
    if (value.includes(s)) onChange(tidyScopes(value.filter((x) => x !== s && !(s === "write" && x === "spend")), allowed));
    else onChange(tidyScopes([...value, s], allowed));
  };
  return (
    <div role="group" aria-label={ariaLabel} className="grid gap-2">
      {MCP_SCOPES.filter((o) => options.includes(o.value)).map((o) => {
        const can = allowed.includes(o.value);
        const locked = o.value === "read";
        const on = value.includes(o.value) && can;
        const off = disabled || !can || locked;
        return (
          <div key={o.value}>
            <button type="button" role="checkbox" aria-checked={on} aria-disabled={off || undefined} disabled={disabled || !can}
              onClick={() => !off && toggle(o.value)}
              className={clsx("relative flex w-full items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors duration-150",
                on ? "border-accent/50 bg-accent/[0.07]" : "border-line",
                !off && !on && "hover:border-dim/50 hover:bg-hover/50",
                locked && "cursor-default", (disabled || !can) && "cursor-not-allowed opacity-60")}>
              {on && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />}
              <span aria-hidden className={clsx("mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition-colors",
                on ? "border-accent bg-accent text-black" : "border-dim")}>
                {on && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {t(o.label)}
                  {o.value === "spend" && <span className="mono text-2xs font-normal text-money">$</span>}
                  {locked && <span className="mono inline-flex items-center gap-1 text-2xs font-normal text-dim"><Lock className="size-3" />{t("always on")}</span>}
                  {!can && <span className="text-2xs font-normal text-dim">{t("Your role can't allow this")}</span>}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-mute">{t(o.desc)}</span>
              </span>
            </button>
            <AnimatePresence initial={false}>
              {o.value === "spend" && on && (
                <motion.p key="spend-warning" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }} className="overflow-hidden">
                  <span className="mt-1.5 flex items-start gap-1.5 px-1 text-xs text-amber-300">
                    <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    {t("Lets the app start paid work without you approving each proposal in Tatvam. Budget limits still apply.")}
                  </span>
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
