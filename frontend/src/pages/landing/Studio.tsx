import { Check } from "lucide-react";
import { motion, useInView, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";
import { AnimatedNumber, InView } from "../../components/ui";
import { getProjectSteps } from "../../components/shell/nav";
import { cn } from "../../lib/cn";
import { SLIDES } from "../login/showcase";
import { STATS, STEP_DETAIL } from "./content";
import { Section, SectionHead, Spot, rupees, useScroller, usePublicRates } from "./parts";

const STEPS = getProjectSteps((s) => s);

/** Status of each storyboard frame in the picture: the label and the colour of its dot. */
const FRAME_STATUS = [
  ["Approved", "bg-ok"], ["Needs approval", "bg-warn"], ["Rendering", "bg-accent"], ["Queued", "bg-dim"], ["Queued", "bg-dim"], ["Queued", "bg-dim"],
] as const;
/** The frame the side panel describes (Monsoon Rooftop), and three framings of it for the shootout. */
const OPEN = 1;
const TAKES = [{ pos: "12% 40%", zoom: 1.05 }, { pos: "78% 50%", zoom: 1.2 }, { pos: "45% 60%", zoom: 1.5 }];

/** Deterministic "audio" bars for the timeline picture. */
const WAVE = Array.from({ length: 72 }, (_, i) => 0.18 + 0.82 * Math.abs(Math.sin(i * 0.9) * 0.55 + Math.sin(i * 0.23 + 1) * 0.45));
const CLIPS = [3, 2, 4, 2, 3, 2];

/** The studio's Shots step, drawn with the showreel frames. It tilts flat as it scrolls into view. Decorative. */
function Window() {
  const scroller = useScroller();
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { tiers, inr } = usePublicRates();
  const tier = tiers.find((t) => t.id === "balanced") ?? tiers[0];
  const { scrollYProgress } = useScroll({ target: ref, container: scroller ?? undefined, offset: ["start end", "center center"] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [reduce ? 0 : 16, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [reduce ? 1 : 0.93, 1]);
  const opacity = useTransform(scrollYProgress, [0, 0.35], [reduce ? 1 : 0.15, 1]);

  return (
    <div style={{ perspective: 1600 }}>
      <motion.div ref={ref} aria-hidden style={{ rotateX, scale, opacity, transformOrigin: "50% 100%" }} className="ld-window">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <span className="flex gap-1.5"><i className="size-2.5 rounded-full bg-bad/70" /><i className="size-2.5 rounded-full bg-warn/70" /><i className="size-2.5 rounded-full bg-ok/70" /></span>
          <span className="mono mx-auto rounded-md bg-raised px-3 py-1 text-2xs text-dim">Monsoon Rooftop · 3 Shots</span>
          <span className="w-12" />
        </div>

        <div className="flex gap-1.5 overflow-hidden border-b border-line px-3 py-2 sm:gap-2 sm:px-4">
          {STEPS.map((s) => {
            const done = s.n < 3;
            const active = s.n === 3;
            return (
              <span key={s.id} className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs", active ? "bg-accent/15 text-accent-ink" : "text-dim")}>
                {done ? <Check className="size-3.5 text-ok" /> : <s.icon className="size-3.5" />}
                <span className="hidden sm:inline">{s.n} </span><span className={cn(!active && "hidden sm:inline")}>{s.label}</span>
              </span>
            );
          })}
        </div>

        <div className="grid gap-3 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {SLIDES.map((s, i) => (
              <div key={s.slug} className={cn("relative aspect-video overflow-hidden rounded-lg border border-line", i === OPEN && "ring-2 ring-accent/70")}>
                <img src={`/showcase/${s.slug}-sm.webp`} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-[0.625rem] text-white/90">
                  <span className="mono">SH {String(i + 1).padStart(2, "0")}</span>
                  <span className="flex items-center gap-1"><i className={cn("size-1.5 rounded-full", FRAME_STATUS[i][1])} /><span className="hidden sm:inline">{FRAME_STATUS[i][0]}</span></span>
                </span>
              </div>
            ))}
          </div>

          <div className="hidden rounded-lg border border-line bg-raised/60 p-3 lg:block">
            <p className="eyebrow">Shot 02</p>
            <p className="mt-2 text-sm font-medium">Rain on the rooftop, Asha looks up</p>
            <p className="mt-1 text-xs leading-relaxed text-mute">Slow push-in, warm lamp light, monsoon haze. Dialogue in Tamil.</p>
            <div className="mt-3 flex items-center justify-between rounded-md border border-line px-2.5 py-1.5 text-xs"><span className="text-mute">Engine</span><span>Veo 3.1 Fast</span></div>
            <div className="mt-2 flex items-center justify-between text-xs"><span className="text-mute">Estimate · 8 s</span><span className="font-semibold tabular-nums text-money">≈ {rupees(8 * tier.usd_per_second * inr)}</span></div>
            <div className="btn-primary mt-3 rounded-md py-1.5 text-center text-xs font-medium text-black">Approve and shoot</div>
            <div className="mt-3 flex gap-1.5">
              {TAKES.map((t, i) => (
                <span key={i} className={cn("block h-8 flex-1 overflow-hidden rounded", i === 1 ? "ring-2 ring-ok" : "opacity-60")}>
                  <img src="/showcase/monsoon-sm.webp" alt="" loading="lazy" style={{ objectPosition: t.pos, transform: `scale(${t.zoom})` }} className="size-full object-cover" />
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-2xs text-dim">Shootout · best take picked</p>
          </div>
        </div>

        <div className="border-t border-line p-3 sm:p-4">
          <div className="relative space-y-1.5">
            <div className="flex h-9 gap-1">
              {CLIPS.map((w, i) => (
                <div key={i} style={{ flex: w, backgroundImage: `url(/showcase/${SLIDES[i].slug}-sm.webp)` }} className="rounded-md bg-cover bg-center ring-1 ring-inset ring-white/10" />
              ))}
            </div>
            <div className="flex h-7 items-center gap-px">
              {WAVE.map((h, i) => <i key={i} style={{ height: `${h * 100}%` }} className="w-full rounded-full bg-accent/55" />)}
            </div>
            <div className="h-3 rounded-md bg-gradient-to-r from-ai/50 via-accent-2/40 to-ai/50" />
            <span className="absolute inset-y-0 left-[38%] w-px bg-accent shadow-[0_0_10px_var(--color-accent)]"><i className="absolute -left-1 -top-1 size-2.5 rounded-full bg-accent" /></span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export function Studio() {
  return (
    <Section className="!pt-6 sm:!pt-10">
      <SectionHead center eyebrow="See the studio" title="One studio, from the first idea to the final cut."
        lead="Story, Cast, Shots, Edit and Deliver live in one place, so nothing gets lost between tools." />
      <div className="mt-12 sm:mt-16">
        <Window />
        <p className="sr-only">An illustration of the Tatvam studio on its Shots step: a storyboard of six frames, a panel with the cost estimate for one shot, and the timeline below.</p>
      </div>
    </Section>
  );
}

function Stat({ value, suffix, label, glyph }: (typeof STATS)[number]) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  return (
    <div ref={ref} className="text-center sm:text-left">
      <p className="text-gradient text-5xl font-semibold tracking-tight sm:text-6xl">
        {glyph ?? <AnimatedNumber value={seen ? value : 0} duration={1.4} format={(n) => `${Math.round(n)}${suffix}`} />}
      </p>
      <p className="mt-2 max-w-[14rem] text-sm leading-snug text-mute">{label}</p>
    </div>
  );
}

export function Stats() {
  return (
    <Section className="!py-4 sm:!py-6">
      <div className="grid grid-cols-2 gap-x-6 gap-y-10 border-y border-line py-10 sm:grid-cols-4">
        {STATS.map((s) => <Stat key={s.label} {...s} />)}
      </div>
    </Section>
  );
}

export function Steps() {
  const scroller = useScroller();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, container: scroller ?? undefined, offset: ["start 75%", "end 60%"] });
  const scaleX = useTransform(scrollYProgress, [0, 1], [0, 1]);
  return (
    <Section id="how">
      <SectionHead center eyebrow="How it works" title="From a sentence to a finished film in five steps."
        lead="Each step has its own workspace, and every step hands its work to the next." />
      <div ref={ref} className="relative mt-14">
        <div aria-hidden className="absolute left-[10%] right-[10%] top-[1.375rem] hidden h-px bg-line lg:block">
          <motion.div className="h-full origin-left bg-gradient-to-r from-accent to-accent-2" style={{ scaleX }} />
        </div>
        <ol className="grid gap-4 lg:grid-cols-5">
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex flex-col">
              <InView delay={i * 0.06} className="flex w-full flex-1 flex-col">
                <span className="mx-auto mb-5 hidden size-11 place-items-center rounded-full border border-accent/40 bg-panel text-accent-ink shadow-glow lg:grid"><s.icon className="size-5" /></span>
                <Spot className="ld-card flex-1 p-5">
                  <div className="flex items-center gap-3 lg:block">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent-ink lg:hidden"><s.icon className="size-5" /></span>
                    <div>
                      <p className="mono text-2xs tracking-widest text-dim">STEP {s.n}</p>
                      <h3 className="mt-1 text-xl font-semibold tracking-tight">{s.label}</h3>
                    </div>
                  </div>
                  <p className="mt-3 text-sm font-medium leading-snug">{s.blurb}</p>
                  <p className="mt-2 text-sm leading-relaxed text-mute">{STEP_DETAIL[s.id]}</p>
                </Spot>
              </InView>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
