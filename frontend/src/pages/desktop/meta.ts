import type { LucideIcon } from "lucide-react";
import { Activity, BookUser, Film, FolderOpen, GalleryHorizontalEnd, MessageSquareText, MonitorPlay, Rocket, SlidersVertical } from "lucide-react";
import type { PanelId } from "../../lib/desktop";

/** The pop-out panels (docs/DESKTOP.md §5): their names, icons and what each shows. Labels are literal for the i18n extractor. */
export const PANEL_META: Record<PanelId, { label: string; icon: LucideIcon; blurb: string; feed?: boolean }> = {
  program: { label: "Program", icon: MonitorPlay, blurb: "The cut, for a second screen or a client monitor", feed: true },
  source: { label: "Source", icon: Film, blurb: "The selected shot's take, with in and out marks", feed: true },
  timeline: { label: "Timeline", icon: GalleryHorizontalEnd, blurb: "The full timeline in its own window" },
  scopes: { label: "Scopes", icon: Activity, blurb: "Waveform, RGB parade, vectorscope and histogram" },
  mixer: { label: "Mixer", icon: SlidersVertical, blurb: "Music level, ducking, layer gains and a level meter" },
  notes: { label: "Review notes", icon: MessageSquareText, blurb: "Notes on this episode's renders; click to jump" },
  media: { label: "Media", icon: FolderOpen, blurb: "The local folder and the episode's layer media" },
  renders: { label: "Renders", icon: Rocket, blurb: "Local render jobs and the Render Center's versions" },
  bible: { label: "Bible", icon: BookUser, blurb: "Approved stills of the cast and places, for reference" },
};
