import { ChevronRight, Command, Search } from "lucide-react";
import { Fragment, useMemo } from "react";
import { Link, useLocation, useMatch } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { useProject } from "../../lib/queries";
import { useUI } from "../../lib/store";
import type { UserBrief } from "../../lib/types";
import { Kbd } from "../ui";
import { Brand } from "./Brand";
import { MOD } from "./keys";
import { getNav, getProjectSteps, getProjectTabs } from "./nav";
import { RateChip } from "./money";
import { JobsPill, NotificationsButton, ProviderDots, SpendPill } from "./telemetry";
import { ThemeButton } from "./ThemeButton";
import { UserMenu } from "./UserMenu";

interface Crumb { label: string; to?: string }

/** Where you are: Studio / Project / Step / Page. Collapses to the last two on small screens. */
function useCrumbs(role: UserBrief["role"]): Crumb[] {
  const t = useT();
  const { pathname } = useLocation();
  const pm = useMatch("/p/:pid/*");
  const pid = pm ? Number(pm.params.pid) : 0;
  const { data: project } = useProject(pid);
  return useMemo(() => {
    const home = { label: t("Command center"), to: "/" };
    if (pm) {
      const tab = getProjectTabs(t).find((x) => x.to === pathname.split("/")[3]);
      const step = tab && getProjectSteps(t).find((s) => s.id === tab.area);
      return [home, { label: project?.title || t("Project"), to: `/p/${pid}` }, ...(step ? [{ label: step.label }] : []), ...(tab ? [{ label: tab.label }] : [])];
    }
    const cur = getNav(t, role).find((n) => n.to !== "/" && pathname.startsWith(n.to));
    return cur ? [home, { label: cur.label }] : [{ label: t("Command center") }];
  }, [t, pathname, pm, pid, project?.title, role]);
}

export function TopBar({ user }: { user: UserBrief }) {
  const t = useT();
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const crumbs = useCrumbs(user.role);
  return (
    <header className="relative z-40 flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-line bg-panel/85 px-3 backdrop-blur-xl md:px-4">
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-60" />
      <Brand className="md:w-[9.5rem]" />

      <nav aria-label={t("Breadcrumb")} className="hidden min-w-0 items-center gap-1 text-sm lg:flex">
        {crumbs.map((c, i) => (
          <Fragment key={`${c.label}-${i}`}>
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-dim" aria-hidden />}
            {c.to && i < crumbs.length - 1
              ? <Link to={c.to} className="max-w-[14rem] truncate rounded px-1 text-mute transition-colors hover:text-ink">{c.label}</Link>
              : <span aria-current={i === crumbs.length - 1 ? "page" : undefined} className="max-w-[16rem] truncate px-1 font-medium text-ink">{c.label}</span>}
          </Fragment>
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 justify-center">
        <button
          data-tour="palette"
          onClick={() => setPaletteOpen(true)}
          className="group flex h-8 w-full max-w-md items-center gap-2 rounded-lg border border-line bg-raised/60 px-2.5 text-left text-sm text-dim outline-none transition-colors hover:border-accent/40 hover:bg-hover hover:text-mute focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Search className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("Search, jump to, or run a command…")}</span>
          <span className="hidden gap-0.5 sm:flex"><Kbd>{MOD}</Kbd><Kbd>K</Kbd></span>
          <Command className="size-4 shrink-0 sm:hidden" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden xl:block"><ProviderDots /></span>
        <JobsPill />
        <span className="hidden md:block"><SpendPill /></span>
        <span className="hidden sm:block"><RateChip /></span>
        <span className="hidden sm:block"><ThemeButton /></span>
        <NotificationsButton />
        <UserMenu user={user} expanded={false} placement="bottom-end" dense />
      </div>
    </header>
  );
}
