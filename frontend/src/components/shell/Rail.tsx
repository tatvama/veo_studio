import { clsx } from "clsx";
import { Ellipsis } from "lucide-react";
import { motion } from "motion/react";
import { useMemo } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { useApprovals } from "../../lib/queries";
import type { Role } from "../../lib/types";
import { Menu, Tooltip } from "../ui";
import { getNav, type NavEntry } from "./nav";

const SPRING = { type: "spring", stiffness: 520, damping: 38 } as const;

function ActiveMark() {
  return (
    <motion.span layoutId="rail-active" transition={SPRING} className="absolute inset-0 rounded-lg border border-accent/25 bg-accent/10 shadow-[0_0_18px_-6px_var(--color-accent)]">
      <span className="absolute -left-[0.6875rem] top-2 bottom-2 w-[3px] rounded-r-full bg-accent shadow-[0_0_10px_var(--color-accent)]" />
    </motion.span>
  );
}

export function RailItem({ entry, badge, onNavigate }: { entry: NavEntry; badge?: number; onNavigate?: () => void }) {
  const Icon = entry.icon;
  return (
    <Tooltip content={entry.label} side="right" delay={150}>
      <NavLink
        to={entry.to}
        end={entry.to === "/"}
        aria-label={entry.label}
        data-tour={entry.tour}
        onClick={onNavigate}
        className={({ isActive }) => clsx(
          "group relative grid size-10 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
          isActive ? "text-accent-ink" : "text-mute hover:bg-hover hover:text-ink",
        )}
      >
        {({ isActive }) => (
          <>
            {isActive && <ActiveMark />}
            <Icon className="relative size-[18px] transition-transform duration-150 group-active:scale-90" />
            {!!badge && (
              <span className="mono absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[0.625rem] font-bold text-black ring-2 ring-panel">{badge}</span>
            )}
          </>
        )}
      </NavLink>
    </Tooltip>
  );
}

/**
 * The global rail: a slim column of destinations. Create/Library at the top, Team/System pinned to the bottom.
 * No expanded state: labels are tooltips, so the work area never shifts. Rarely used pages sit behind "More", which
 * lights up while one of them is open.
 */
export function Rail({ role }: { role: Role }) {
  const t = useT();
  const { data: approvals } = useApprovals();
  const pending = (approvals ?? []).filter((a) => a.can_decide).length;
  const entries = useMemo(() => getNav(t, role), [t, role]);
  const top = entries.filter((e) => !e.more && (e.group === "create" || e.group === "library"));
  const team = entries.filter((e) => !e.more && e.group === "team");
  const system = entries.filter((e) => !e.more && e.group === "system");
  const more = entries.filter((e) => e.more);
  const item = (e: NavEntry) => <RailItem key={e.to} entry={e} badge={e.badge === "approvals" ? pending : undefined} />;
  return (
    <aside data-tour-rail aria-label={t("Main")} className="relative z-30 hidden w-14 shrink-0 flex-col items-center border-r border-line bg-panel py-2.5 md:flex">
      <nav className="flex w-full flex-1 flex-col items-center gap-1">
        {top.map((e, i) => (
          <div key={e.to} className="flex flex-col items-center gap-1">
            {i > 0 && e.group !== top[i - 1].group && <span aria-hidden className="my-1.5 h-px w-6 bg-line" />}
            {item(e)}
          </div>
        ))}
      </nav>
      <nav className="flex flex-col items-center gap-1">
        {team.map(item)}
        <RailMore entries={more} />
        {system.map(item)}
      </nav>
    </aside>
  );
}

/** The rarely used pages (Model Hub, brand kits, team, audit log) behind one button, as a menu with their names spelled out. */
function RailMore({ entries }: { entries: NavEntry[] }) {
  const t = useT();
  const nav = useNavigate();
  const { pathname } = useLocation();
  if (!entries.length) return null;
  const on = entries.some((e) => pathname.startsWith(e.to));
  return (
    <Menu placement="right-end" width={220} items={entries.map((e) => ({
      label: e.label, icon: <e.icon className="size-4" />, active: pathname.startsWith(e.to), onClick: () => nav(e.to),
    }))} trigger={(p) => (
      <Tooltip content={`${t("More")}: ${entries.map((e) => e.label).join(", ")}`} side="right" delay={150}>
        <button type="button" {...p} aria-label={t("More")} data-tour="nav-more"
          className={clsx("group relative grid size-10 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
            on ? "text-accent-ink" : "text-mute hover:bg-hover hover:text-ink")}>
          {on && <ActiveMark />}
          <Ellipsis className="relative size-[18px] transition-transform duration-150 group-active:scale-90" />
        </button>
      </Tooltip>
    )} />
  );
}
