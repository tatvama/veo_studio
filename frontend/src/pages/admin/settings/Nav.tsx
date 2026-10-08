import { clsx } from "clsx";
import {
  AudioLines, Boxes, Captions, Coins, Fingerprint, KeyRound, MessagesSquare, PenLine, Plug, ScanFace, SlidersHorizontal, Wrench, type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ScrollStrip } from "../../../components/ui";
import { useT } from "../../../lib/i18n";

export interface SectionDef { id: string; label: string; icon: LucideIcon }

/** Sections in page order, grouped for the side navigation. Labels are i18n keys. */
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
      { id: "keys", label: "AI services", icon: KeyRound },
    ],
  },
  { label: "System", items: [{ id: "advanced", label: "Advanced", icon: Wrench }] },
];

export const SECTION_IDS = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id));
const ALL: SectionDef[] = SETTINGS_GROUPS.flatMap((g) => g.items);

/** Which section each saved setting lives in (to mark sections with unsaved edits). */
export const SETTING_SECTION: Record<string, string> = {
  team_monthly_cap_usd: "budget", alert_thresholds: "budget", creator_default_monthly_limit_usd: "budget",
  default_quality_mode: "generation", lipsync_model: "generation", google_first: "generation",
  auto_retake: "quality", max_auto_retakes: "quality", qc_threshold: "quality", face_match_threshold: "quality", lipsync_qc: "quality", lipsync_qc_threshold: "quality",
  dialogue_method: "dialogue", dub_method: "dialogue",
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

/** ≥1024px: sticky vertical list in groups. */
export function SettingsNav({ active, onSelect, dirty }: { active: string; onSelect: (id: string) => void; dirty: Set<string> }) {
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
    <nav aria-label={t("Sections")} className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
      <div ref={box} className="relative max-h-[calc(100vh-3rem)] space-y-5 overflow-y-auto pb-2 pr-1">
        {SETTINGS_GROUPS.map((g) => (
          <div key={g.label}>
            <p className="mb-1 px-2.5 text-2xs font-semibold uppercase tracking-wider text-dim">{t(g.label)}</p>
            <ul className="space-y-0.5">
              {g.items.map(({ id, label, icon: Icon }) => {
                const on = active === id;
                return (
                  <li key={id}>
                    <a href={`#${id}`} aria-current={on ? "true" : undefined} onClick={(e) => { e.preventDefault(); onSelect(id); }}
                      className={clsx("relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors", on ? "text-ink" : "text-mute hover:text-ink")}>
                      {on && <motion.span layoutId={`settings-nav-${uid}`} transition={SPRING} className="absolute inset-0 rounded-lg bg-accent/10 ring-1 ring-inset ring-accent/20" />}
                      {!on && <span aria-hidden className="absolute inset-0 rounded-lg opacity-0 transition-opacity hover:bg-hover/60 hover:opacity-100" />}
                      <Icon className={clsx("relative size-4 shrink-0", on && "text-accent-ink")} />
                      <span className="relative min-w-0 flex-1 truncate">{t(label)}</span>
                      {dirty.has(id) && <span title={t("Unsaved changes")} className="relative size-1.5 shrink-0 rounded-full bg-warn" />}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

/** <1024px: chips that scroll sideways and stay at the top of the page. */
export function SettingsChips({ active, onSelect, dirty }: { active: string; onSelect: (id: string) => void; dirty: Set<string> }) {
  const t = useT();
  return (
    <div className="sticky top-0 z-20 -mx-4 mb-4 border-b border-line bg-bg/85 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 lg:hidden">
      <ScrollStrip className="flex gap-1.5" aria-label={t("Sections")} role="navigation">
        {ALL.map(({ id, label, icon: Icon }) => {
          const on = active === id;
          return (
            <a key={id} href={`#${id}`} data-active={on} aria-current={on ? "true" : undefined} onClick={(e) => { e.preventDefault(); onSelect(id); }}
              className={clsx("inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm font-medium transition-colors",
                on ? "border-accent/45 bg-accent/12 text-ink" : "border-line text-mute hover:border-dim/50 hover:text-ink")}>
              <Icon className={clsx("size-3.5", on && "text-accent-ink")} />
              {t(label)}
              {dirty.has(id) && <span className="size-1.5 rounded-full bg-warn" />}
            </a>
          );
        })}
      </ScrollStrip>
    </div>
  );
}
