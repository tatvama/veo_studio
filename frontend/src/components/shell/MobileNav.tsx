import { clsx } from "clsx";
import { Ellipsis, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { useApprovals } from "../../lib/queries";
import { useUI } from "../../lib/store";
import type { UserBrief } from "../../lib/types";
import { Popover } from "../ui";
import { getNav } from "./nav";
import { UserMenu } from "./UserMenu";

/** Phone navigation: a bottom tab bar (thumb reach) with the main destinations, Search, "More" and the account. */
export function MobileNav({ user }: { user: UserBrief }) {
  const t = useT();
  const nav = useNavigate();
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const { data: approvals } = useApprovals();
  const pending = (approvals ?? []).filter((a) => a.can_decide).length;
  const entries = useMemo(() => getNav(t, user.role), [t, user.role]);
  // the same main destinations as the sidebar; the Model Hub and the other rarely used pages are under "More"
  const main = entries.filter((e) => ["/", "/library", "/posters"].includes(e.to));
  // short labels: five cells plus the account share a 375px bar
  const short: Record<string, string> = { "/": t("Home"), "/library": t("Library"), "/posters": t("Posters") };
  const more = entries.filter((e) => !main.includes(e) && e.to !== "/search");
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const cell = "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-2xs font-medium outline-none transition-colors";
  return (
    <nav aria-label={t("Main")} className="relative z-30 flex shrink-0 items-stretch border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-0 top-0 h-px opacity-60" />
      {main.map((e) => (
        <NavLink key={e.to} to={e.to} end={e.to === "/"} className={({ isActive }) => clsx(cell, isActive ? "text-accent-ink" : "text-mute")}>
          {({ isActive }) => (
            <>
              <e.icon className="size-5" />
              <span className="max-w-full truncate">{short[e.to] ?? e.label}</span>
              {isActive && <span aria-hidden className="absolute inset-x-5 top-0 h-0.5 rounded-b-full bg-accent shadow-[0_0_10px_var(--color-accent)]" />}
            </>
          )}
        </NavLink>
      ))}
      <button className={clsx(cell, "text-mute")} onClick={() => setPaletteOpen(true)}>
        <Search className="size-5" /><span>{t("Search")}</span>
      </button>
      <button ref={moreRef} className={clsx(cell, open ? "text-accent-ink" : "text-mute")} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="relative"><Ellipsis className="size-5" />{pending > 0 && <span className="absolute -right-1.5 -top-1 size-2 rounded-full bg-accent" />}</span>
        <span>{t("More")}</span>
      </button>
      <div className="flex flex-1 items-center justify-center"><UserMenu user={user} expanded={false} placement="top-end" dense /></div>
      <Popover open={open} onClose={() => setOpen(false)} anchor={moreRef} placement="top-end" width={240} className="p-1.5">
        {more.map((e) => (
          <button key={e.to} onClick={() => { setOpen(false); nav(e.to); }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-mute transition-colors hover:bg-hover hover:text-ink">
            <e.icon className="size-4" />{e.label}
            {e.badge === "approvals" && pending > 0 && <span className="mono ml-auto rounded-full bg-accent px-1.5 text-2xs font-bold text-black">{pending}</span>}
          </button>
        ))}
      </Popover>
    </nav>
  );
}
