import type { LucideIcon } from "lucide-react";
import {
  Activity, BookOpen, BookUser, Boxes, Clapperboard, Coins, FileText, Film, Home, LayoutGrid, ListVideo, MessageSquareText, Palette, PanelsTopLeft, ScrollText,
  Search, Settings, ShieldCheck, SquareKanban, Users,
} from "lucide-react";
import { ROLE_RANK, type Role } from "../../lib/types";

type T = (s: string) => string;

export type NavGroup = "create" | "library" | "team" | "system";
export interface NavEntry { to: string; label: string; icon: LucideIcon; tour?: string; keywords?: string; badge?: "approvals"; group: NavGroup }

/** Top-level pages (sidebar + command palette). Labels are literal t() calls for the i18n extractor. */
export function getNav(t: T, role: Role): NavEntry[] {
  const canApprove = ROLE_RANK[role] >= ROLE_RANK.producer;
  const isAdmin = role === "admin";
  const items: (NavEntry | false)[] = [
    { to: "/", group: "create", label: t("Projects"), icon: Home, tour: "nav-projects", keywords: "home dashboard start" },
    { to: "/search", group: "create", label: t("Search everything"), icon: Search, tour: "nav-search", keywords: "find" },
    { to: "/library", group: "library", label: t("Characters & places"), icon: BookUser, keywords: "characters locations cast library photos voice clone avatar" },
    { to: "/models", group: "library", label: t("Model Hub"), icon: Boxes, tour: "nav-models", keywords: "ai engines veo kling models" },
    { to: "/brand-kits", group: "library", label: t("Brand kits"), icon: Palette, keywords: "logo colours fonts brand" },
    canApprove && { to: "/approvals", group: "team", label: t("Approvals"), icon: ShieldCheck, badge: "approvals", keywords: "budget approve" },
    { to: "/costs", group: "team", label: t("Costs"), icon: Coins, keywords: "spend budget money usage" },
    isAdmin && { to: "/team", group: "team", label: t("Team"), icon: Users, keywords: "users members roles" },
    canApprove && { to: "/audit", group: "team", label: isAdmin ? t("Audit log") : t("Consent records"), icon: ScrollText, keywords: "history security" },
    { to: "/settings", group: "system", label: t("Settings"), icon: Settings, keywords: "keys providers preferences" },
  ];
  return items.filter((x): x is NavEntry => !!x);
}

export type ProjectPhase = "write" | "cast" | "shots" | "finish" | "log";
export interface ProjectTab { to: string; label: string; icon: LucideIcon; keywords?: string; phase: ProjectPhase }

/** The four phases of making a video, in order (tabs are grouped under them). */
export function getProjectPhases(t: T): { id: ProjectPhase; label: string }[] {
  return [
    { id: "write", label: t("Write") }, { id: "cast", label: t("Cast") }, { id: "shots", label: t("Shots") },
    { id: "finish", label: t("Finish") },
  ];
}

/** Project workspace tabs (ProjectLayout + command palette). */
export function getProjectTabs(t: T): ProjectTab[] {
  return [
    { to: "brief", phase: "write", label: t("Brief"), icon: FileText, keywords: "goal audience autopilot" },
    { to: "story", phase: "write", label: t("Story"), icon: BookOpen, keywords: "hooks script writers room" },
    { to: "scenes", phase: "write", label: t("Scenes"), icon: SquareKanban, keywords: "scene cards beats" },
    { to: "bible", phase: "cast", label: t("Bible"), icon: Users, keywords: "characters cast locations style voices photos" },
    { to: "studio", phase: "shots", label: t("Studio"), icon: PanelsTopLeft, keywords: "one screen workspace panels timeline viewer multi monitor drag drop" },
    { to: "shots", phase: "shots", label: t("Shot list"), icon: ListVideo, keywords: "import script word pdf manual builder dialogue voice-over produce" },
    { to: "storyboard", phase: "shots", label: t("Storyboard"), icon: LayoutGrid, keywords: "shots keyframes videos takes" },
    { to: "timeline", phase: "finish", label: t("Timeline"), icon: Film, keywords: "edit cut music audio" },
    { to: "export", phase: "finish", label: t("Export"), icon: Clapperboard, keywords: "render publish download" },
    { to: "review", phase: "finish", label: t("Review"), icon: MessageSquareText, keywords: "comments feedback client" },
    { to: "activity", phase: "log", label: t("Activity"), icon: Activity, keywords: "log history events" },
  ];
}
