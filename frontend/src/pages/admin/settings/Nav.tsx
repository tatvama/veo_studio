import { clsx } from "clsx";
import {
  AudioLines, Bot, Boxes, Captions, Coins, Fingerprint, KeyRound, MessagesSquare, PenLine, Plug, ScanFace, SlidersHorizontal, Wrench, type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import "../../../styles/console.css";
import "../../../styles/settings.css";
import { Panel, ScrollStrip } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { StatusGlyph, type SectionStatus } from "./state";

export interface SectionDef { id: string; label: string; icon: LucideIcon }

/** Sections in page order, grouped for the section list. Labels are i18n keys. */
export const SETTINGS_GROUPS: { label: string; items: SectionDef[] }[] = [
  { label: "Team", items: [{ id: "budget", label: "Budget", icon: Coins }] },
  {
    label: "Studio defaults", items: [
      { id: "generation", label: "Generation", icon: SlidersHorizontal },
      { id: "quality", label: "Quality control", icon: ScanFace },
      { id: "dialogue", label: "Dialogue & dubbing", icon: MessagesSquare },
      { id: "delivery", label: "Captions & delivery", icon: Captions },
      { id: "room", label: "Writers' room", icon: PenLine },
    ],
  },
  {
    label: "Models and voices", items: [
      { id: "hub", label: "Model Hub", icon: Boxes },
      { id: "identity", label: "Identity training", icon: Fingerprint },
      { id: "voices", label: "Voices", icon: AudioLines },
    ],
  },
  {
    label: "Connections", items: [
      { id: "integrations", label: "Integrations", icon: Plug },
      { id: "mcp", label: "MCP access", icon: Bot },
      { id: "keys", label: "AI services", icon: KeyRound },
    ],
  },
  { label: "System", items: [{ id: "advanced", label: "Advanced", icon: Wrench }] },
];

export const SECTION_IDS = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id));
const ALL: SectionDef[] = SETTINGS_GROUPS.flatMap((g) => g.items);
/** Group label (an i18n key) for each section id, for the panel eyebrows. */
export const SECTION_GROUP: Record<string, string> = Object.fromEntries(SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => [i.id, g.label])));

/** Which section each saved setting lives in (to mark sections with unsaved edits). */
export const SETTING_SECTION: Record<string, string> = {
  team_monthly_cap_usd: "budget", alert_thresholds: "budget", creator_default_monthly_limit_usd: "budget",
  default_quality_mode: "generation", lipsync_model: "generation", google_first: "generation", cheapest_route: "generation",
  text_provider: "generation", openrouter_text_model: "generation", director_engine: "generation",
  writer_claude_model: "generation", writer_claude_effort: "generation", listen_checks_gemini: "generation",
  quota_fallback_routes: "generation", safety_fallback: "generation", fallback_extra_limit_usd: "generation",
  byteplus_auto_register: "generation",
  auto_retake: "quality", max_auto_retakes: "quality", qc_threshold: "quality", face_match_threshold: "quality", lipsync_qc: "quality", lipsync_qc_threshold: "quality",
  auto_scene_continuity: "quality", keyframe_qc: "quality", keyframe_auto_retake: "quality", keyframe_qc_threshold: "quality",
  dialogue_method: "dialogue", dub_method: "dialogue", native_dialogue_languages: "dialogue", dialogue_words_qc: "dialogue",
  dialogue_words_threshold: "dialogue", outfit_qc: "dialogue",
  caption_style: "delivery", auto_reframe: "delivery", sfx_auto: "delivery", ui_default_language: "delivery",
  critic_rounds: "room", critic_min_score: "room",
  hub_auto_sync: "hub", hub_sync_hours: "hub", hub_auto_enable: "hub",
  identity_trainer: "identity", tts_provider_by_language: "voices", make_webhook_url: "integrations",
  models: "advanced", prices: "advanced",
};

/**
 * Highlights the section that is under the reading line of the page scroller. Clicking an entry calls `select`,
 * which pins the highlight for a moment so it doesn't flicker while the smooth scroll passes other sections.
 */
export function useScrollSpy(ids: string[], ready = true): [string, (id: string) => void] {
  const [active, setActive] = useState(ids[0]);
  const lockUntil = useRef(0);
  const key = ids.join("|");

  useEffect(() => {
    if (!ready) return;
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    const root = els[0]?.closest<HTMLElement>("[data-page-scroller]");
    if (!root || !els.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      if (Date.now() < lockUntil.current) return;
      const first = ids.find((id) => seen.get(id));
      if (first) setActive(first);
    }, { root, rootMargin: "-14% 0px -70% 0px" });
    els.forEach((el) => io.observe(el));
    const onScroll = () => {
      if (Date.now() < lockUntil.current) return;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 6) setActive(ids[ids.length - 1]); // bottom of the page = last section
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { io.disconnect(); root.removeEventListener("scroll", onScroll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  const select = useCallback((id: string) => {
    setActive(id);
    lockUntil.current = Date.now() + 800;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    try { history.replaceState(null, "", `#${id}`); } catch { /* ignore */ }
  }, []);

  return [active, select];
}

const SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

/** Amber dot + count: this many unsaved changes live in the section. */
function Unsaved({ n, className }: { n: number; className?: string }) {
  const t = useT();
  if (n <= 0) return null;
  return (
    <span title={t("Unsaved changes")} className={clsx("st-unsaved mono text-amber-300", className)}>
      <i aria-hidden className="st-dot" />
      <span aria-hidden>{n}</span>
      <span className="sr-only">{t("Unsaved changes")}: {n}</span>
    </span>
  );
}

const IDLE: SectionStatus = { tone: "idle", label: "" };

/** ≥900px: the left pane of the console. A sticky list of sections in groups; the lit one has the accent edge, each carries its health glyph and unsaved count. */
export function SettingsNav({ active, onSelect, dirty, status }: {
  active: string; onSelect: (id: string) => void; dirty: Record<string, number>; status: Record<string, SectionStatus>;
}) {
  const t = useT();
  const uid = useId();
  const box = useRef<HTMLDivElement>(null);
  // the list scrolls on short screens: keep the highlighted entry in view
  useEffect(() => {
    const el = box.current;
    const item = el?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!el || !item) return;
    const top = item.offsetTop;
    if (top < el.scrollTop + 8) el.scrollTo({ top: Math.max(0, top - 24), behavior: "smooth" });
    else if (top + item.offsetHeight > el.scrollTop + el.clientHeight - 8) el.scrollTo({ top: top + item.offsetHeight - el.clientHeight + 24, behavior: "smooth" });
  }, [active]);
  return (
    <nav aria-label={t("Sections")}>
      <Panel flush>
        <div ref={box} className="relative max-h-[calc(100dvh-9rem)] overflow-y-auto p-2">
          {SETTINGS_GROUPS.map((g) => (
            <div key={g.label} className="[&:not(:first-child)]:mt-3">
              <p className="eyebrow px-2.5 pb-1.5 pt-1">{t(g.label)}</p>
              <ul className="space-y-0.5">
                {g.items.map(({ id, label, icon: Icon }) => {
                  const on = active === id;
                  const st = status[id] ?? IDLE;
                  return (
                    <li key={id}>
                      <a href={`#${id}`} aria-current={on ? "true" : undefined} onClick={(e) => { e.preventDefault(); onSelect(id); }} className="st-nav-item">
                        {on && (
                          <motion.span aria-hidden layoutId={`settings-nav-${uid}`} transition={SPRING} className="absolute inset-0 rounded-lg bg-accent/[0.09]">
                            <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
                          </motion.span>
                        )}
                        <Icon className="relative" />
                        <span className="relative min-w-0 flex-1 truncate">{t(label)}</span>
                        <Unsaved n={dirty[id] ?? 0} className="relative" />
                        {st.label && <StatusGlyph status={st} className="relative" />}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </Panel>
    </nav>
  );
}

/** <900px: the same list as a strip of chips that scrolls sideways and stays pinned at the top of the page. */
export function SettingsChips({ active, onSelect, dirty, status }: {
  active: string; onSelect: (id: string) => void; dirty: Record<string, number>; status: Record<string, SectionStatus>;
}) {
  const t = useT();
  return (
    <div className="sticky top-0 z-20 -mx-4 mb-4 border-y border-line bg-bg/85 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 min-[900px]:hidden">
      <ScrollStrip className="flex gap-1.5" aria-label={t("Sections")} role="navigation">
        {ALL.map(({ id, label, icon: Icon }) => {
          const on = active === id;
          const st = status[id];
          return (
            <a key={id} href={`#${id}`} data-active={on} aria-current={on ? "true" : undefined} onClick={(e) => { e.preventDefault(); onSelect(id); }}
              className={clsx("cx-chip max-sm:h-10", on && "is-on")}>
              <Icon />
              {t(label)}
              <Unsaved n={dirty[id] ?? 0} />
              {st && (st.tone === "bad" || st.tone === "warn") && <StatusGlyph status={st} />}
            </a>
          );
        })}
      </ScrollStrip>
    </div>
  );
}
