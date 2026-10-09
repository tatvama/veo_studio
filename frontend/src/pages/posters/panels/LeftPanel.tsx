/**
 * Left side of the editor: a slim icon tab strip plus a collapsible ~20rem drawer with templates, AI, text, elements,
 * photos, cast and brand. Tabs mount the first time they are opened and then stay mounted (hidden), so their scroll
 * position and half-typed prompts survive switching. Everything in the drawer drags onto the canvas or adds by click.
 */
import { ChevronsLeft, ChevronsRight, Images, LayoutTemplate, Palette, Shapes, Sparkles, Type, Users, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconButton, Tooltip } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { useT } from "../../../lib/i18n";
import { useEditor, type LeftTab } from "../store";
import AiTab from "./left/AiTab";
import BrandTab from "./left/BrandTab";
import CastTab from "./left/CastTab";
import ElementsTab from "./left/ElementsTab";
import PhotosTab from "./left/PhotosTab";
import { useLeft } from "./left/state";
import TemplatesTab from "./left/TemplatesTab";
import TextTab from "./left/TextTab";
import { ConfirmHost } from "./left/ui";

const TABS: { key: LeftTab; label: string; hint: string; icon: LucideIcon; ai?: boolean }[] = [
  { key: "templates", label: "Templates", hint: "Start from a layout, or describe the poster", icon: LayoutTemplate },
  { key: "ai", label: "AI", hint: "Paint images and write copy", icon: Sparkles, ai: true },
  { key: "text", label: "Text", hint: "Styles, pairings and fonts", icon: Type },
  { key: "elements", label: "Elements", hint: "Shapes, badges, effects and gradients", icon: Shapes },
  { key: "photos", label: "Photos", hint: "Uploads, this design's images and stills", icon: Images },
  { key: "cast", label: "Cast", hint: "The film's characters, ready to drop in", icon: Users },
  { key: "brand", label: "Brand", hint: "Colours, fonts, logo and products", icon: Palette },
];

export default function LeftPanel({ designId, projectId }: { designId: number; projectId: number | null }) {
  const t = useT();
  const tab = useEditor((s) => s.leftTab);
  const setTab = useEditor((s) => s.setLeftTab);
  const collapsed = useLeft((s) => s.collapsed);
  const setCollapsed = useLeft((s) => s.setCollapsed);
  const [visited, setVisited] = useState<Set<LeftTab>>(() => new Set([tab]));
  const strip = useRef<HTMLDivElement>(null);
  const prevTab = useRef(tab);

  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)));
    // another part of the editor switched the tab (e.g. "Pose with AI"): make sure the drawer is open
    if (prevTab.current !== tab && useLeft.getState().collapsed) setCollapsed(false);
    prevTab.current = tab;
  }, [tab, setCollapsed]);

  const pick = (k: LeftTab) => {
    if (k === tab) { setCollapsed(!collapsed); return; }
    setTab(k);
    if (collapsed) setCollapsed(false);
  };

  const onStripKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = TABS.findIndex((x) => x.key === tab);
    const n = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[n].key);
    if (collapsed) setCollapsed(false);
    strip.current?.querySelector<HTMLButtonElement>(`[data-tab="${TABS[n].key}"]`)?.focus();
  };

  const active = TABS.find((x) => x.key === tab) ?? TABS[0];

  const body = (k: LeftTab): ReactNode => {
    switch (k) {
      case "templates": return <TemplatesTab designId={designId} projectId={projectId} />;
      case "ai": return <AiTab designId={designId} projectId={projectId} />;
      case "text": return <TextTab />;
      case "elements": return <ElementsTab />;
      case "photos": return <PhotosTab designId={designId} />;
      case "cast": return <CastTab projectId={projectId} />;
      case "brand": return <BrandTab designId={designId} projectId={projectId} />;
    }
  };

  return (
    <aside className="relative flex h-full min-h-0 shrink-0 border-r border-line bg-panel" aria-label={t("Design tools")}>
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-3 top-0 h-px" />

      {/* tab strip */}
      <div ref={strip} role="tablist" aria-orientation="vertical" aria-label={t("Design tools")} onKeyDown={onStripKey}
        className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line py-2">
        {TABS.map((x) => {
          const on = x.key === tab;
          const Icon = x.icon;
          return (
            <Tooltip key={x.key} content={t(x.label)} side="right" delay={250}>
              <button
                type="button"
                role="tab"
                data-tab={x.key}
                id={`poster-left-tab-${x.key}`}
                aria-label={t(x.label)}
                aria-selected={on}
                aria-controls={`poster-left-panel-${x.key}`}
                aria-expanded={on ? !collapsed : undefined}
                tabIndex={on ? 0 : -1}
                onClick={() => pick(x.key)}
                className={cn(
                  "relative grid size-10 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                  on ? (x.ai ? "bg-ai/12 text-ai" : "bg-hover text-ink") : "text-mute hover:bg-hover hover:text-ink",
                )}
              >
                {on && !collapsed && (
                  <motion.span layoutId={`poster-left-ind-${designId}`} transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
                    className={cn("absolute -left-2 inset-y-2 w-0.5 rounded-full", x.ai ? "bg-ai shadow-[0_0_10px_var(--color-ai)]" : "bg-accent shadow-[0_0_10px_var(--color-accent)]")} />
                )}
                <Icon className="size-[18px]" strokeWidth={on ? 2.2 : 1.8} />
              </button>
            </Tooltip>
          );
        })}
        <div className="mt-auto">
          <IconButton title={collapsed ? t("Open the panel") : t("Collapse the panel")} tipSide="right" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          </IconButton>
        </div>
      </div>

      {/* drawer */}
      <div className={cn("relative min-h-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none", collapsed ? "w-0" : "w-80")}
        aria-hidden={collapsed || undefined} inert={collapsed || undefined}>
        <div className="flex h-full w-80 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg border border-line bg-raised", active.ai ? "text-ai" : "text-accent-ink")}>
              <active.icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold leading-tight tracking-tight text-ink">{t(active.label)}</h2>
              <p className="truncate text-2xs leading-tight text-dim">{t(active.hint)}</p>
            </div>
          </header>
          {TABS.filter((x) => visited.has(x.key)).map((x) => (
            <div key={x.key} role="tabpanel" id={`poster-left-panel-${x.key}`} aria-labelledby={`poster-left-tab-${x.key}`}
              className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]", x.key !== tab && "hidden")}>
              {body(x.key)}
            </div>
          ))}
        </div>
      </div>

      <ConfirmHost />
    </aside>
  );
}
