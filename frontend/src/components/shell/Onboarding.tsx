import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft, ArrowRight, BookOpen, Bot, Boxes, Check, Clapperboard, Command, Film, FolderOpen, LayoutGrid, PartyPopper, Search, UserRound, Users,
} from "lucide-react";
import { animate, AnimatePresence, motion, useMotionValue, useReducedMotionConfig, useTransform, type MotionValue } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT, useUiLanguage } from "../../lib/i18n";
import { useUI } from "../../lib/store";
import { Button, Kbd } from "../ui";
import { MOD } from "./keys";
import { getProjectSteps } from "./nav";
import { usePrefActions, usePrefsQuery } from "./prefs";

interface Step {
  /** `data-tour` value of the element to spotlight; no anchor = a centred card. */
  anchor?: string;
  /** Used when the anchor isn't on screen (on phones the sidebar is a menu). */
  fallback?: () => HTMLElement | null;
  title: string;
  body: string;
  icon: LucideIcon;
  projectOnly?: boolean;
  /** Label of the Next button on this step. */
  next?: string;
}

interface Box { top: number; left: number; width: number; height: number; rail: boolean; viaFallback: boolean }
type Side = "right" | "below" | "above";
interface Placement { left: number; top: number; side: Side | null; arrow: number }

const PAD = 6;
const CARD_W = 340;
const GAP = 18; // space between the spotlight and the card (the arrow lives here)
const MARGIN = 14;
const SPRING = { type: "spring", stiffness: 300, damping: 34, mass: 0.9 } as const;

function headerButton(label: string) {
  return () => [...document.querySelectorAll<HTMLElement>("header button[aria-label]")].find((b) => b.getAttribute("aria-label") === label) ?? null;
}

function useSteps(): Step[] {
  const t = useT();
  const lang = useUiLanguage();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildSteps(t), [t, lang]);
}

function buildSteps(t: (s: string, v?: Record<string, string | number>) => string): Step[] {
  const menu = headerButton(t("Menu"));
  return [
    { icon: Clapperboard, title: t("Welcome to Tatvam AI Studio"), next: t("Let's go"),
      body: t("Turn a concept into a finished video — hook, script, scenes, shots and video — in English, Hindi, Kannada, Telugu and Tamil. Here's a one-minute tour.") },
    { anchor: "nav-projects", fallback: menu, icon: FolderOpen, title: t("Command center"),
      body: t("Every video starts as a project. Describe a concept or start from a template; your team's projects, live queue and approvals are listed here.") },
    { anchor: "nav-search", fallback: menu, icon: Search, title: t("Search everything"),
      body: t("Find shots, takes, characters and renders by what's in them — in plain words.") },
    { anchor: "step-story", projectOnly: true, icon: BookOpen, title: `1 · ${t("Story")}`,
      body: t("Brief, hooks & script, and scenes. The Director turns your concept into a brief, writes and scores hooks and the script, then plans every scene.") },
    { anchor: "step-cast", projectOnly: true, icon: Users, title: `2 · ${t("Cast")}`,
      body: t("Characters, places, voices, props and wardrobe. Lock each look once it is approved, so every shot stays consistent.") },
    { anchor: "step-shots", projectOnly: true, icon: LayoutGrid, title: `3 · ${t("Shots")}`,
      body: t("Plan shots, generate keyframes and videos, and pick the best takes, as a storyboard, a list or the Studio. The cost is always shown before anything is generated.") },
    { anchor: "step-edit", projectOnly: true, icon: Film, title: `4 · ${t("Edit")}`,
      body: t("Arrange and trim clips, and add music, narration, sound effects and titles.") },
    { anchor: "step-deliver", projectOnly: true, icon: Clapperboard, title: `5 · ${t("Deliver")}`,
      body: t("Render for Shorts, Reels or YouTube in every language, share a review link so clients can comment on exact frames, and make ads, reels and posters.") },
    { anchor: "nav-more", fallback: menu, icon: Boxes, title: t("More"),
      body: t("The Model Hub, brand kits and admin pages. In the Model Hub you can browse the latest AI video, image and voice models, compare prices, and choose which engines your shots use.") },
    { anchor: "director", projectOnly: true, icon: Bot, title: `${t("Director")} (${MOD}+J)`,
      body: t("Your AI co-pilot inside every project. Ask it to write, plan, generate or dub — paid steps wait for your OK.") },
    { anchor: "user-menu", fallback: menu, icon: UserRound, title: t("Your account"),
      body: t("Switch theme and language, reduce motion, see every keyboard shortcut, or replay this tour any time.") },
    { anchor: "palette", fallback: headerButton(t("Command palette")), icon: Command, title: `${t("Command palette")} (${MOD}+K)`,
      body: t("Jump to any page, project or setting, or switch theme and language — without leaving the keyboard.") },
  ];
}

function visibleBox(el: HTMLElement | null, viaFallback: boolean): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null;
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2, rail: !!el.closest("[data-tour-rail]"), viaFallback };
}

function findBox(step: Step): Box | null {
  if (!step.anchor) return null;
  // the same anchor can sit in the project rail and in the narrow-screen strip; use whichever is on screen
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${step.anchor}"]`)) {
    const box = visibleBox(el, false);
    if (box) return box;
  }
  return step.fallback ? visibleBox(step.fallback(), true) : null;
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);

/** Where the card goes: beside sidebar anchors, below (else above) top-bar anchors, centred without an anchor. */
function place(box: Box | null, cw: number, ch: number, vw: number, vh: number): Placement {
  const clampX = (x: number) => Math.max(MARGIN, Math.min(vw - cw - MARGIN, x));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(vh - ch - MARGIN, y));
  if (!box) return { left: (vw - cw) / 2, top: Math.max(MARGIN, (vh - ch) / 2), side: null, arrow: 0 };
  const mx = box.left + box.width / 2;
  const my = box.top + box.height / 2;
  const fitsRight = box.left + box.width + GAP + cw <= vw - MARGIN;
  const fitsBelow = box.top + box.height + GAP + ch <= vh - MARGIN;
  const fitsAbove = box.top - GAP - ch >= MARGIN;
  const right: Placement = { left: box.left + box.width + GAP, top: clampY(my - ch / 2), side: "right", arrow: my };
  const below: Placement = { left: clampX(mx - cw / 2), top: box.top + box.height + GAP, side: "below", arrow: mx };
  const above: Placement = { left: clampX(mx - cw / 2), top: box.top - GAP - ch, side: "above", arrow: mx };
  const pick = box.rail && fitsRight ? right : fitsBelow ? below : fitsAbove ? above : fitsRight ? right : null;
  return pick ?? { left: clampX(mx - cw / 2), top: clampY(box.top + box.height + GAP), side: null, arrow: 0 };
}

const canClip = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("clip-path", 'path(evenodd, "M0 0H1V1Z")');

/** First-run spotlight tour. Auto-starts when prefs.onboarding_done is falsy; restart via useUI().startTour(). */
export function Onboarding() {
  const tourRun = useUI((s) => s.tourRun);
  const { data: prefs } = usePrefsQuery(true);
  const { setOnboardingDone } = usePrefActions(true);
  const [open, setOpen] = useState(false);
  const [autoDone, setAutoDone] = useState(false);
  const seenRun = useRef(tourRun);
  const prevFocus = useRef<HTMLElement | null>(null);

  const begin = useCallback(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);

  // First run: start once, shortly after the page has rendered (StrictMode-safe: the timer is re-armed).
  useEffect(() => {
    if (autoDone || !prefs) return;
    if (prefs.onboarding_done) { setAutoDone(true); return; }
    const id = setTimeout(() => { setAutoDone(true); begin(); }, 700);
    return () => clearTimeout(id);
  }, [prefs, autoDone, begin]);

  // Restart requests (palette / user menu) made while this shell is mounted.
  useEffect(() => {
    if (tourRun !== seenRun.current) { seenRun.current = tourRun; begin(); }
  }, [tourRun, begin]);

  const finish = useCallback(() => {
    setOpen(false);
    void setOnboardingDone(true);
    // hand the keyboard back to whatever had it before the tour (if it is still on the page)
    const el = prevFocus.current;
    if (el?.isConnected) setTimeout(() => el.focus?.({ preventScroll: true }), 0);
  }, [setOnboardingDone]);

  return createPortal(
    <AnimatePresence>{open && <Tour key={`tour-${tourRun}`} onDone={finish} />}</AnimatePresence>,
    document.body,
  );
}

/** Spring a motion value to a target; restarts only when the target really moved. */
function useMover() {
  const reduce = useReducedMotionConfig();
  const targets = useRef(new WeakMap<MotionValue<number>, number>());
  return useCallback((mv: MotionValue<number>, to: number, instant = false) => {
    if (targets.current.get(mv) === to) return;
    targets.current.set(mv, to);
    if (reduce || instant) mv.set(to);
    else animate(mv, to, SPRING);
  }, [reduce]);
}

/** Stand-in for the project's five steps, shown when the tour runs outside a project: highlights where this step lives. */
function MiniTabs({ active }: { active: string }) {
  const t = useT();
  const steps = getProjectSteps(t);
  return (
    <div aria-hidden className="mt-3 flex items-center gap-1 rounded-xl border border-line bg-raised p-1">
      {steps.map((s) => {
        const on = `step-${s.id}` === active;
        const Icon = s.icon;
        return (
          <span
            key={s.id}
            className={clsx(
              "flex h-7 min-w-0 items-center justify-center gap-1 rounded-lg px-1.5 text-2xs font-medium transition-[flex-grow,background-color,color] duration-300",
              on ? "flex-[2.4] bg-accent/15 text-accent-ink ring-1 ring-accent/40" : "flex-1 text-dim",
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {on && <span className="truncate">{s.label}</span>}
          </span>
        );
      })}
    </div>
  );
}

function Arrow({ side, offset }: { side: Side; offset: number }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "absolute size-3 rotate-45 bg-panel transition-[left,top] duration-200",
        side === "right" && "-left-1.5 border-b border-l border-line",
        side === "below" && "-top-1.5 border-l border-t border-line",
        side === "above" && "-bottom-1.5 border-b border-r border-line",
      )}
      style={side === "right" ? { top: offset - 6 } : { left: offset - 6 }}
    />
  );
}

function Tour({ onDone }: { onDone: () => void }) {
  const t = useT();
  const steps = useSteps();
  const move = useMover();
  const reduce = useReducedMotionConfig();
  const titleId = useId();
  const bodyId = useId();
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);
  const [box, setBox] = useState<Box | null>(null);
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [cardH, setCardH] = useState(250);
  const cardRef = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const step = steps[i];
  const last = i === steps.length - 1;
  const cardW = Math.min(CARD_W, vp.w - 2 * MARGIN);
  const phone = vp.w < 640;

  // Spotlight rectangle and card position are motion values, so every step glides instead of jumping.
  const hx = useMotionValue(vp.w / 2);
  const hy = useMotionValue(vp.h / 2);
  const hw = useMotionValue(0);
  const hh = useMotionValue(0);
  const vw = useMotionValue(vp.w);
  const vh = useMotionValue(vp.h);
  const cx = useMotionValue((vp.w - cardW) / 2);
  const cy = useMotionValue(vp.h / 2 - 120);
  const clip = useTransform([hx, hy, hw, hh, vw, vh], ([x, y, w, h, W, H]: number[]) => {
    const r = Math.max(0, Math.min(12, w / 2, h / 2));
    return `path(evenodd, "M0 0H${W}V${H}H0Z M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z")`;
  });

  // Track the anchor (it may appear late, move on resize/scroll/animation, or not exist at all).
  useEffect(() => {
    const el = step.anchor ? document.querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`) : null;
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const tick = () => {
      setVp((v) => (v.w === window.innerWidth && v.h === window.innerHeight ? v : { w: window.innerWidth, h: window.innerHeight }));
      setBox((prev) => { const next = findBox(step); return sameBox(prev, next) ? prev : next; });
    };
    tick();
    const id = setInterval(tick, 120);
    window.addEventListener("resize", tick);
    window.addEventListener("scroll", tick, true);
    return () => { clearInterval(id); window.removeEventListener("resize", tick); window.removeEventListener("scroll", tick, true); };
  }, [step]);

  // The card's real height decides where it can go.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => setCardH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pos = useMemo(() => place(box, cardW, cardH, vp.w, vp.h), [box, cardW, cardH, vp.w, vp.h]);

  useEffect(() => {
    vw.set(vp.w);
    vh.set(vp.h);
    if (box) { move(hx, box.left); move(hy, box.top); move(hw, box.width); move(hh, box.height); }
    else { move(hx, vp.w / 2); move(hy, vp.h / 2); move(hw, 0); move(hh, 0); }
    const first = !placed.current;
    placed.current = true;
    move(cx, pos.left, first);
    move(cy, pos.top, first);
  }, [box, pos, vp, move, hx, hy, hw, hh, vw, vh, cx, cy]);

  const go = useCallback((to: number) => {
    setI((cur) => {
      const next = Math.max(0, Math.min(steps.length - 1, to));
      if (next !== cur) setDir(next > cur ? 1 : -1);
      return next;
    });
  }, [steps.length]);
  const next = useCallback(() => (last ? onDone() : go(i + 1)), [last, onDone, go, i]);
  const back = useCallback(() => go(i - 1), [go, i]);

  // Keyboard: arrows / Enter move, Esc skips, Tab stays inside the card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(); return; }
      // the app's global shortcuts (palette, Director, sidebar, shortcuts sheet) stay quiet while the tour is on
      const lower = e.key.toLowerCase();
      if (((e.ctrlKey || e.metaKey) && (lower === "k" || lower === "j")) || e.key === "?" || e.key === "[") { e.preventDefault(); e.stopPropagation(); return; }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const onButton = (e.target as HTMLElement | null)?.closest?.("button, a, [role=button]");
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || (e.key === "Enter" && !onButton)) { e.preventDefault(); e.stopPropagation(); next(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); back(); }
      else if (e.key === "Tab") {
        const root = cardRef.current;
        if (!root) return;
        const items = [...root.querySelectorAll<HTMLElement>("button:not([disabled])")];
        if (!items.length) return;
        const first = items[0], lastEl = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!active || !root.contains(active)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && active === first) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && active === lastEl) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [next, back, onDone]);

  const Icon = last ? PartyPopper : step.icon;
  const arrowOffset = pos.side === "right" ? Math.max(22, Math.min(cardH - 22, pos.arrow - pos.top)) : Math.max(22, Math.min(cardW - 22, pos.arrow - pos.left));
  const variants = {
    enter: (d: number) => ({ opacity: 0, x: reduce ? 0 : d * 18 }),
    center: { opacity: 1, x: 0 },
    exit: (d: number) => ({ opacity: 0, x: reduce ? 0 : d * -18 }),
  };

  return (
    <motion.div
      className="fixed inset-0 z-[80]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      {/* click shield: nothing behind the tour can be clicked while it runs */}
      <div className="absolute inset-0" />

      {canClip ? (
        <>
          {/* dim + blur everywhere except the spotlight (clip-path hole follows the springs) */}
          <motion.div aria-hidden className="pointer-events-none absolute inset-0 backdrop-blur-[3px]" style={{ background: "var(--spotlight)", clipPath: clip }} />
          <motion.div
            aria-hidden
            className="pulse-ring pointer-events-none absolute left-0 top-0 rounded-xl border-2 border-accent"
            style={{ x: hx, y: hy, width: hw, height: hh, boxShadow: "0 0 28px 2px color-mix(in oklab, var(--color-accent) 30%, transparent)" }}
            initial={false}
            animate={{ opacity: box ? 1 : 0 }}
            transition={{ duration: 0.2 }}
          />
        </>
      ) : (
        <>
          {!box && <div aria-hidden className="absolute inset-0" style={{ background: "var(--spotlight)" }} />}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 rounded-xl border-2 border-accent"
            style={{ x: hx, y: hy, width: hw, height: hh, boxShadow: box ? "0 0 0 9999px var(--spotlight), 0 0 24px 4px color-mix(in oklab, var(--color-accent) 35%, transparent)" : "none" }}
          />
        </>
      )}

      <motion.div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="pointer-events-auto absolute left-0 top-0 rounded-2xl border border-line bg-panel shadow-modal"
        style={{ x: cx, y: cy, width: cardW }}
      >
        {pos.side && <Arrow side={pos.side} offset={arrowOffset} />}
        <div className="relative p-5">
          <div className="relative" aria-live="polite">
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.div key={i} custom={dir} variants={variants} initial="enter" animate="center" exit="exit" transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
                <div className="mb-3 flex items-center gap-3">
                  <div className="relative grid size-10 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent/15 text-accent-ink">
                    <motion.span key={`${i}-${last}`} initial={reduce ? false : { scale: 0.5, rotate: -20, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 480, damping: 24 }} className="grid place-items-center">
                      <Icon className="size-5" />
                    </motion.span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-dim">{t("Step {n} of {total}", { n: i + 1, total: steps.length })}</p>
                    <h3 id={titleId} className="mt-0.5 text-base font-semibold leading-snug tracking-tight">{step.title}</h3>
                  </div>
                </div>
                <p id={bodyId} className="text-sm leading-relaxed text-mute">{step.body}</p>
                {!box && step.projectOnly && step.anchor?.startsWith("step-") && <MiniTabs active={step.anchor} />}
                {!box && step.anchor && (
                  <p className="mt-3 rounded-lg border border-line bg-raised px-3 py-2 text-xs leading-relaxed text-mute">
                    {step.projectOnly ? t("Open any project to find this in its five steps.") : t("It lives in the menu (top left) on small screens.")}
                  </p>
                )}
                {box?.viaFallback && (
                  <p className="mt-3 rounded-lg border border-line bg-raised px-3 py-2 text-xs leading-relaxed text-mute">{t("On small screens, open the menu to find this.")}</p>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <nav aria-label={t("Tour progress")} className="mt-3 flex items-center">
            {steps.map((s, k) => (
              <button
                key={s.title + k}
                type="button"
                aria-label={t("Go to step {n}", { n: k + 1 })}
                aria-current={k === i ? "step" : undefined}
                onClick={() => go(k)}
                className="group grid h-7 min-w-0 flex-1 place-items-center outline-none focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-accent"
              >
                <span className={clsx("block h-1.5 rounded-full transition-[width,background-color] duration-300",
                  k === i ? "w-5 bg-accent" : k < i ? "w-1.5 bg-accent/45 group-hover:bg-accent/70" : "w-1.5 bg-line group-hover:bg-dim")} />
              </button>
            ))}
          </nav>

          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onDone}>{t("Skip tour")}</Button>
            <div className="flex-1" />
            {i > 0 && <Button size="sm" variant="outline" icon={<ArrowLeft className="size-3.5" />} onClick={back}>{t("Back")}</Button>}
            <Button
              size="sm"
              variant="primary"
              onClick={next}
              autoFocus
              icon={last ? <Check className="size-3.5" /> : undefined}
              iconRight={last ? undefined : <ArrowRight className="size-3.5" />}
            >
              {last ? t("Finish") : step.next ?? t("Next")}
            </Button>
          </div>
          {!phone && (
            <p className="mt-3 flex items-center gap-1.5 border-t border-line pt-2.5 text-2xs text-dim">
              <Kbd>←</Kbd><Kbd>→</Kbd> {t("navigate")}<span aria-hidden>·</span><Kbd>Esc</Kbd> {t("skip")}
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
