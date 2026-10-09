import type { LucideIcon } from "lucide-react";
import {
  Activity, BookOpen, BookUser, Boxes, Clapperboard, Coins, FileText, Film, Gauge, Globe, Home, LayoutGrid, LayoutTemplate, ListVideo, Megaphone,
  MessageSquareText, Palette, PanelsTopLeft, ScrollText, Search, Send, Settings, ShieldCheck, SquareKanban, Users,
} from "lucide-react";
import { ROLE_RANK, type Role } from "../../lib/types";

type T = (s: string) => string;

export type NavGroup = "create" | "library" | "team" | "system";
export interface NavEntry {
  to: string; label: string; icon: LucideIcon; tour?: string; keywords?: string; badge?: "approvals"; group: NavGroup;
  /** Rarely used: listed under the sidebar's "More" menu instead of as its own icon. */
  more?: boolean;
}

/** Top-level pages (sidebar + command palette). Labels are literal t() calls for the i18n extractor. */
export function getNav(t: T, role: Role): NavEntry[] {
  const canApprove = ROLE_RANK[role] >= ROLE_RANK.producer;
  const isAdmin = role === "admin";
  const items: (NavEntry | false)[] = [
    { to: "/", group: "create", label: t("Command center"), icon: Home, tour: "nav-projects", keywords: "home projects dashboard start overview" },
    { to: "/search", group: "create", label: t("Search everything"), icon: Search, tour: "nav-search", keywords: "find" },
    { to: "/library", group: "library", label: t("Characters & places"), icon: BookUser, keywords: "characters locations cast library photos voice clone avatar" },
    { to: "/posters", group: "library", label: t("Posters"), icon: LayoutTemplate, keywords: "poster studio design thumbnail youtube instagram story social post flyer banner festival greeting key art canva" },
    { to: "/models", group: "library", label: t("Model Hub"), icon: Boxes, tour: "nav-models", keywords: "ai engines veo kling models", more: true },
    { to: "/brand-kits", group: "library", label: t("Brand kits"), icon: Palette, keywords: "logo colours fonts brand", more: true },
    canApprove && { to: "/approvals", group: "team", label: t("Approvals"), icon: ShieldCheck, badge: "approvals", keywords: "budget approve" },
    { to: "/costs", group: "team", label: t("Costs"), icon: Coins, keywords: "spend budget money usage" },
    isAdmin && { to: "/team", group: "team", label: t("Team"), icon: Users, keywords: "users members roles", more: true },
    canApprove && { to: "/audit", group: "team", label: isAdmin ? t("Audit log") : t("Consent records"), icon: ScrollText, keywords: "history security", more: true },
    { to: "/settings", group: "system", label: t("Settings"), icon: Settings, keywords: "keys providers preferences" },
  ];
  return items.filter((x): x is NavEntry => !!x);
}

// ── project workspace ─────────────────────────────────────────────────────────

/** The five numbered steps of a project, in order. */
export type StepId = "story" | "cast" | "shots" | "edit" | "deliver";
/** Where a project page lives: one of the five steps, the project home (Overview), or the activity log. */
export type ProjectArea = StepId | "home" | "log";

export const STEP_IDS: readonly StepId[] = ["story", "cast", "shots", "edit", "deliver"];

export interface ProjectStep {
  id: StepId; n: number; label: string; icon: LucideIcon;
  /** One line under the step's title: what happens in this step. */
  blurb: string;
  /** The sub-pages follow on from each other (brief → script → scenes), rather than being views of the same work (the Shots views). */
  sequential: boolean;
}

/** The steps of the project rail, the step bar and the overview's flight path. */
export function getProjectSteps(t: T): ProjectStep[] {
  return [
    { id: "story", n: 1, label: t("Story"), icon: BookOpen, sequential: true, blurb: t("Set the brief, write the script, plan the scenes.") },
    { id: "cast", n: 2, label: t("Cast"), icon: Users, sequential: true, blurb: t("Lock the look of every character, place and prop.") },
    { id: "shots", n: 3, label: t("Shots"), icon: Clapperboard, sequential: false, blurb: t("Make keyframes and videos, and pick the best takes.") },
    { id: "edit", n: 4, label: t("Edit"), icon: Film, sequential: true, blurb: t("Cut it together with music, voice and titles.") },
    { id: "deliver", n: 5, label: t("Deliver"), icon: Send, sequential: true, blurb: t("Render, get feedback, make ads, reels and posters.") },
  ];
}

export interface ProjectTab {
  /** The page's path segment under /p/:pid/ (unchanged from the old tab names, so every existing link still lands). */
  to: string; label: string; icon: LucideIcon; keywords?: string; area: ProjectArea;
  /** Projects made from the user's own material hide this page until it has something in it (it is about writing from a concept). */
  ownHidden?: boolean;
}

/**
 * Every project page, in pipeline order: the sub-tabs of each step, plus the Overview and the activity log.
 * Keywords keep the old tab names (bible, world, shot list…) so the command palette still finds them.
 */
export function getProjectTabs(t: T): ProjectTab[] {
  return [
    { to: "dashboard", area: "home", label: t("Overview"), icon: Gauge, keywords: "home mission control dashboard progress cost per second spend stale impact seasons" },
    { to: "brief", area: "story", label: t("Brief"), icon: FileText, keywords: "story goal audience autopilot" },
    { to: "story", area: "story", label: t("Hooks & script"), icon: BookOpen, ownHidden: true, keywords: "story hooks script writers room" },
    { to: "scenes", area: "story", label: t("Scenes"), icon: SquareKanban, ownHidden: true, keywords: "story scene cards beats" },
    { to: "bible", area: "cast", label: t("Characters & places"), icon: Users, keywords: "cast bible characters locations style voices photos lock versions costumes" },
    { to: "world", area: "cast", label: t("Props & wardrobe"), icon: Globe, ownHidden: true, keywords: "cast world props costumes wardrobe continuity bible timeline end state" },
    { to: "storyboard", area: "shots", label: t("Storyboard"), icon: LayoutGrid, keywords: "shots keyframes videos takes" },
    { to: "shots", area: "shots", label: t("List"), icon: ListVideo, keywords: "shots shot list import script word pdf manual builder dialogue voice-over produce" },
    { to: "studio", area: "shots", label: t("Studio"), icon: PanelsTopLeft, keywords: "shots one screen workspace panels timeline viewer multi monitor drag drop film map" },
    { to: "timeline", area: "edit", label: t("Timeline"), icon: Film, keywords: "edit cut music audio sound titles" },
    { to: "export", area: "deliver", label: t("Export"), icon: Clapperboard, keywords: "deliver render publish download" },
    { to: "review", area: "deliver", label: t("Review"), icon: MessageSquareText, keywords: "deliver comments feedback client" },
    { to: "campaign", area: "deliver", label: t("Ads & Reels"), icon: Megaphone, keywords: "deliver advert campaign variants languages aspect reels shorts highlights" },
    { to: "posters", area: "deliver", label: t("Posters"), icon: LayoutTemplate, keywords: "deliver poster studio key art thumbnail social post design flyer banner festival greeting" },
    { to: "activity", area: "log", label: t("Activity log"), icon: Activity, keywords: "activity log history events" },
  ];
}

const AREA: Record<string, ProjectArea> = Object.fromEntries(getProjectTabs((s) => s).map((x) => [x.to, x.area]));

/** Which step (or the home / log) a project page belongs to. */
export function areaOf(tab: string): ProjectArea | undefined {
  return AREA[tab];
}

/** "Cast › Characters & places" for a step's sub-page; just the label for the Overview and the log. */
export function tabTitle(t: T, tab: ProjectTab, steps: ProjectStep[] = getProjectSteps(t)): string {
  const step = steps.find((s) => s.id === tab.area);
  return step ? `${step.label} › ${tab.label}` : tab.label;
}
